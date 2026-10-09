import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { makeFixture, cleanup, makeLimits, type Fixture } from "./helpers.js";
import { DenyPolicy } from "../src/policy.js";
import { WorkspaceIndex } from "../src/paths.js";
import { FsOps } from "../src/fsOps.js";
import { GitOps } from "../src/git.js";
import { TaskRunner } from "../src/tasks.js";
import { AuditLog } from "../src/audit.js";
import { sanitizedEnv, gitEnv } from "../src/exec.js";
import { loadConfig } from "../src/config.js";

/**
 * Adversarial security regressions — every test here exists because it pins a
 * real boundary in the threat model or a reproduced escape. Fixtures are
 * synthetic, created fresh per suite; nothing touches the operator's home
 * directory or real repositories.
 */

let f: Fixture;
let ops: FsOps;
let gitOps: GitOps;

beforeAll(async () => {
  f = await makeFixture({ git: true });
  ops = new FsOps(f.index, f.policy, f.cfg.limits, gitEnv, 15_000);
  gitOps = new GitOps(15_000, 262_144, f.policy);
});
afterAll(() => cleanup(f));

describe("FS-CONTAIN: permission and special-file behavior", () => {
  it("unreadable file fails closed with a bounded error, not a stack", async () => {
    const p = path.join(f.wsDir, "no-read.txt");
    fs.writeFileSync(p, "hidden\n");
    fs.chmodSync(p, 0o000);
    try {
      const r = await ops.read("test", "no-read.txt").catch((e) => e);
      expect(r.code).toBeDefined();
      expect(String(r.message)).not.toContain("at ");
      expect(String(r.message)).not.toContain(f.wsDir);
    } finally {
      fs.chmodSync(p, 0o644);
    }
  });

  it("FIFO inside root is refused, never blocks the reader", async () => {
    const fifoPath = path.join(f.wsDir, "pipe.fifo");
    try {
      execFileSync("mkfifo", [fifoPath]);
    } catch {
      return; // platform without mkfifo — skip
    }
    const r = await Promise.race([
      ops.read("test", "pipe.fifo").then(() => "read").catch((e) => e.code ?? String(e)),
      new Promise<string>((res) => setTimeout(() => res("BLOCKED"), 3000)),
    ]);
    expect(r).not.toBe("BLOCKED");
    fs.rmSync(fifoPath);
  });

  it("symlink loop is refused", async () => {
    const loop = path.join(f.wsDir, "loop-link");
    fs.symlinkSync("loop-link", loop);
    await expect(f.index.resolve("test", "loop-link")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("NFD unicode name and NFC name resolve to the same canonical file", async () => {
    const nfd = path.join(f.wsDir, "e\u0301clair.txt");
    fs.writeFileSync(nfd, "eclair\n");
    const r = await f.index.resolve("test", "\u00e9clair.txt"); // NFC input
    expect(r.rel.normalize("NFC")).toBe("éclair.txt");
  });
});

describe("GIT-LEAK: denied content must not escape through diffs", () => {
  it("detected rename a/.env b/safe.ts is redacted (a-path checked)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-rename-"));
    try {
      const g = (a: string[]) => execFileSync("git", a, { cwd: tmp, stdio: "pipe" });
      g(["init", "-q", "-b", "main"]);
      g(["config", "user.email", "t@t"]);
      g(["config", "user.name", "T"]);
      fs.writeFileSync(path.join(tmp, ".env"), "SECRET=first-token-111\nL2=a\nL3=b\nL4=c\n");
      g(["add", ".env"]);
      g(["commit", "-qm", "env"]);
      g(["mv", ".env", "innocent.ts"]);
      fs.appendFileSync(path.join(tmp, "innocent.ts"), "TRIVIAL=1\n");
      g(["add", "-A"]);
      g(["commit", "-qm", "rename"]);

      const d = await gitOps.diff(tmp, { base: "HEAD~1", head: "HEAD" });
      expect(d.repo).toBe(true);
      // The rename is detected; the denied source name must suppress the body.
      expect(d.diff).toContain("denied-content");
      expect(d.diff).not.toContain("first-token-111");
      expect(d.diff).not.toContain("L2=a");

      const s = await gitOps.show(tmp, "HEAD");
      expect(JSON.stringify(s)).not.toContain("first-token-111");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("deleted denied file hunk stays suppressed", async () => {
    const d = await gitOps.diff(f.wsDir, { base: "HEAD", head: "HEAD" });
    expect(JSON.stringify(d)).not.toContain("supersecret");
  });

  it("git show of historical denied blob is denied by name", async () => {
    const s = await gitOps.show(f.wsDir, "HEAD:.env.tracked").catch((e) => e);
    expect(s.code === "ACCESS_DENIED" || s.repo === false).toBe(true);
  });

  it("policy normalizes '..' segments — 'a/../.env' is still denied", () => {
    expect(f.policy.check("a/../.env")).toBe("dotenv");
    expect(f.policy.check("sub/../.ssh/id_rsa")).toBe("ssh");
    expect(f.policy.check("../outside.txt")).toBeNull(); // containment's job, not policy's
  });

  it("git show '..' blob path cannot bypass the deny", async () => {
    const s = await gitOps.show(f.wsDir, "HEAD:a/../.env.tracked").catch((e) => e);
    expect(["ACCESS_DENIED", "INVALID_ARGUMENT"]).toContain(s.code);
    expect(JSON.stringify(s)).not.toContain("SECRET=one");
  });
});

describe("RG-PARSE: search output attribution cannot be spoofed", () => {
  it("denied file under a ':N:' directory does not leak via preview", async () => {
    const evilDir = path.join(f.wsDir, "x:1:y");
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, ".env"), "SECRET=rgleak-999\n");
    fs.writeFileSync(path.join(evilDir, "ok.txt"), "SECRET=visible-ok\n");
    const r = await ops.searchContent("test", "SECRET=");
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("rgleak-999");
    // The denied file itself must produce no match record, while the sibling
    // allowed file inside the same ':N:' directory is attributed correctly —
    // proving the path is parsed, not guessed.
    const deniedHit = r.matches.find((m) => m.path === "x:1:y/.env");
    expect(deniedHit).toBeUndefined();
    const okHit = r.matches.find((m) => m.path === "x:1:y/ok.txt");
    expect(okHit?.preview).toContain("visible-ok");
  });

  it("file with newline in its name is attributed correctly", async () => {
    const weird = path.join(f.wsDir, "odd\nname.txt");
    fs.writeFileSync(weird, "MARKER-nl-777\n");
    try {
      const r = await ops.searchContent("test", "MARKER-nl-777");
      expect(r.matches.length).toBe(1);
      expect(r.matches[0]!.path).toContain("odd");
      expect(r.matches[0]!.preview).toContain("MARKER-nl-777");
    } finally {
      fs.rmSync(weird, { force: true });
    }
  });

  it("rg error output never leaks the absolute workspace path", async () => {
    const r = await ops
      .searchContent("test", "([", { regex: true })
      .then((x) => JSON.stringify(x))
      .catch((e) => String(e.message ?? e));
    expect(r).not.toContain(f.wsDir);
    expect(r).not.toContain(f.tmp);
  });
});

describe("EXEC: task_runner boundaries", () => {
  it("task cwd cannot escape the workspace via config", async () => {
    const cfg = { ...f.cfg.tasks };
    cfg["evil-cwd"] = { command: ["/bin/echo", "hi"], cwd: "../outside", timeoutMs: 5000 };
    const t = new TaskRunner(f.index, cfg, f.cfg.limits);
    // enable it for the workspace by extending config
    const idx = new WorkspaceIndex(
      { test2: { path: f.wsDir, tasks: ["evil-cwd"] } },
      f.policy
    );
    await idx.init();
    const t2 = new TaskRunner(idx, cfg, f.cfg.limits);
    const r = await t2.run("test2", "evil-cwd").catch((e) => e);
    expect(r.code === "OUTSIDE_ROOT" || r.code === "ACCESS_DENIED").toBe(true);
  });

  it("timeout kills the whole process group — no orphaned writes", async () => {
    const marker = path.join(f.tmp, "survivor.marker");
    const defs = {
      "fork-bomb-lite": {
        command: ["/bin/sh", "-c", `( sleep 2 ; touch ${JSON.stringify(marker).slice(1, -1)} ) & wait`],
        timeoutMs: 1000,
      },
    };
    const idx = new WorkspaceIndex({ w: { path: f.wsDir, tasks: ["fork-bomb-lite"] } }, f.policy);
    await idx.init();
    const t = new TaskRunner(idx, defs, f.cfg.limits);
    const r = await t.run("w", "fork-bomb-lite");
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 3500));
    expect(fs.existsSync(marker)).toBe(false);
  }, 15_000);

  it("operator env extras cannot inject secret-named vars; ${PATH} expands", () => {
    const env = sanitizedEnv({
      AWS_SECRET_ACCESS_KEY: "x",
      NODE_OPTIONS: "--inspect",
      GIT_DIR: "/tmp/evil",
      EXTRA_PATH: "${PATH}:/opt/x",
      PLAIN: "ok",
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.PLAIN).toBe("ok");
    expect(env.EXTRA_PATH).toMatch(/:/);
  });
});

describe("CONFIG: fail closed and friendly", () => {
  it("missing config gives actionable CONFIG_ERROR", async () => {
    const p = path.join(f.tmp, "no-such-config.json");
    const r = await Promise.resolve()
      .then(() => loadConfig(p))
      .catch((e) => e);
    expect(String(r.message)).toMatch(/CONFIG_ERROR/);
    expect(String(r.message)).toMatch(/init-config/);
  });

  it("group-writable config is refused", async () => {
    const p = path.join(f.tmp, "writable.json");
    fs.writeFileSync(p, JSON.stringify({ version: 1, workspaces: {} }));
    fs.chmodSync(p, 0o660);
    expect(() => loadConfig(p)).toThrow(/CONFIG_ERROR/);
  });

  it("zero workspaces = zero accessible roots", async () => {
    const idx = new WorkspaceIndex({}, new DenyPolicy([]));
    await idx.init();
    expect(idx.list()).toHaveLength(0);
    await expect(idx.resolve("anything", ".")).rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE" });
  });

  it("unknown task reference fails config load", async () => {
    const p = path.join(f.tmp, "badtask.json");
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 1, workspaces: { w: { path: f.wsDir, tasks: ["nope"] } }, tasks: {} }),
      { mode: 0o600 }
    );
    expect(() => loadConfig(p)).toThrow(/CONFIG_ERROR/);
  });

  it("malformed operator deny glob fails closed at startup, not per-request", () => {
    expect(() => new DenyPolicy(["[unclosed"])).toThrow();
  });
});

describe("AUDIT: metadata-only, no write primitive", () => {
  it("does not write through a symlinked audit path", async () => {
    const victim = path.join(f.tmp, "victim.txt");
    fs.writeFileSync(victim, "ORIGINAL\n");
    const link = path.join(f.tmp, "audit-link.jsonl");
    fs.symlinkSync(victim, link);
    const log = new AuditLog(link);
    log.record({ tool: "fs_read", ok: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.readFileSync(victim, "utf8")).toBe("ORIGINAL\n");
  });
});

describe("META: fs_stat reports traversal honestly", () => {
  it("viaSymlink is true for a symlinked path", async () => {
    const s = await ops.stat("test", "link-src/hello.txt");
    expect(s.viaSymlink).toBe(true);
  });
  it("viaSymlink is false for a plain path", async () => {
    const s = await ops.stat("test", "src/hello.txt");
    expect(s.viaSymlink).toBe(false);
  });
});

describe("CONTENT: name-independent secret material", () => {
  it("private key material under a benign name is refused", async () => {
    fs.writeFileSync(
      path.join(f.wsDir, "notes.txt"),
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"
    );
    await expect(ops.read("test", "notes.txt")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    fs.rmSync(path.join(f.wsDir, "notes.txt"));
  });
});

describe("PROTOCOL: stdio purity", () => {
  it("serve emits only framed JSON-RPC on stdout; logs go to stderr", async () => {
    const cfgPath = path.join(f.tmp, "proto-config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, workspaces: { test: { path: f.wsDir, tasks: [] } }, tasks: {} }),
      { mode: 0o600 }
    );
    const distCli = path.resolve(__dirname, "../dist/cli.js");
    const child = spawn(process.execPath, [distCli, "serve", "--stdio", "--config", cfgPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    await new Promise((r) => setTimeout(r, 800));
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "probe", version: "0" },
      },
    }) + "\n";
    child.stdin.write(init);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"
    );
    await new Promise((r) => setTimeout(r, 1500));
    child.kill("SIGKILL");
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      const msg = JSON.parse(l); // throws if any non-JSON leaked to stdout
      expect(msg.jsonrpc).toBe("2.0");
    }
    expect(stdout).toContain('"tools"');
    expect(stderr).toContain("serving stdio");
  }, 20_000);
});
