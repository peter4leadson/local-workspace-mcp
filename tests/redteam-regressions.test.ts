import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeFixture, cleanup, makeLimits, type Fixture } from "./helpers.js";
import { DenyPolicy } from "../src/policy.js";
import { WorkspaceIndex } from "../src/paths.js";
import { FsOps } from "../src/fsOps.js";
import { GitOps, hasPrivateKeyMaterial } from "../src/git.js";
import { TaskRunner } from "../src/tasks.js";
import { runBounded, gitEnv } from "../src/exec.js";
import { bufferHasKeyMaterial } from "../src/media.js";

/**
 * Independent red-team regression suite (2026-10-11 round). Each test pins a
 * demonstrated bypass: mid-word armor splits, trailing-character deny
 * evasion, detached-grandchild task stalls, git_log record injection, and
 * prototype-key task ids. All fixtures are synthetic.
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

describe("RT-1: mid-word armor split defeats nothing (all scan surfaces)", () => {
  it("hasPrivateKeyMaterial catches `PRIVAT\\nE KEY` via zero-collapse", () => {
    expect(hasPrivateKeyMaterial("x -----BEGIN PRIVAT\nE KEY----- y")).toBe(true);
    expect(hasPrivateKeyMaterial("x -----BEGIN PRIVATE\nKEY----- y")).toBe(true);
    expect(hasPrivateKeyMaterial("-----BEGIN OPENSSH PRI\nVATE KEY-----")).toBe(true);
    expect(hasPrivateKeyMaterial("PuTTY-User-Key-\nFile-2:\nxyz")).toBe(true);
    expect(hasPrivateKeyMaterial("totally ordinary text")).toBe(false);
  });

  it("bufferHasKeyMaterial catches split armor in text-like payloads", () => {
    const split = Buffer.from("notes\n-----BEGIN PRIVAT\nE KEY-----\nbody\n", "latin1");
    expect(bufferHasKeyMaterial(split)).toBe(true);
    const contiguous = Buffer.from("-----BEGIN PRIVATE KEY-----\nbody\n", "latin1");
    expect(bufferHasKeyMaterial(contiguous)).toBe(true);
    const benign = Buffer.from("lorem ipsum PRIVATE KEY prose only\n", "latin1");
    expect(bufferHasKeyMaterial(benign)).toBe(false);
  });

  it("fs_read refuses a file whose armor is split mid-word", async () => {
    fs.writeFileSync(
      path.join(f.wsDir, "notes-split.txt"),
      "-----BEGIN PRIVAT\nE KEY-----\n" + "QUJD\n".repeat(30) + "-----END PRIVATE KEY-----\n"
    );
    await expect(ops.read("test", "notes-split.txt")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("git_show refuses a tracked blob whose armor is split mid-word", async () => {
    const p = path.join(f.wsDir, "splitkey.txt");
    fs.writeFileSync(p, "-----BEGIN PRIVAT\nE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n");
    const g = (a: string[]) => execFileSync("git", a, { cwd: f.wsDir, stdio: "pipe" });
    g(["add", "splitkey.txt"]);
    g(["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-qm", "add split key"]);
    await expect(gitOps.show(f.wsDir, "HEAD:splitkey.txt")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("git_diff suppresses a part whose hunk carries split armor", async () => {
    const p = path.join(f.wsDir, "plain.txt");
    fs.writeFileSync(p, "innocuous\n");
    const g = (a: string[]) => execFileSync("git", a, { cwd: f.wsDir, stdio: "pipe" });
    g(["add", "plain.txt"]);
    g(["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-qm", "baseline"]);
    fs.writeFileSync(p, "innocuous\n-----BEGIN PRIVAT\nE KEY-----\nQUJD\n");
    const d = await gitOps.diff(f.wsDir, {});
    expect(d.diff).not.toContain("E KEY-----");
    expect(d.diff).toContain("private-key");
  });
});

describe("RT-2: trailing-char deny evasion closed at the policy layer", () => {
  it("policy.check denies `.env ` and `.env\\t` spellings", () => {
    const policy = new DenyPolicy([]);
    expect(policy.check(".env ")).not.toBeNull();
    expect(policy.check(".env\t")).not.toBeNull();
    expect(policy.check(".env")).not.toBeNull();
    expect(policy.check(".env.example ")).not.toBeNull(); // trimmed spelling denies; only the literal spelling can allow
    expect(policy.check("src/hello.txt ")).toBeNull();
  });

  it("fs_read refuses `.env ` on disk", async () => {
    fs.writeFileSync(path.join(f.wsDir, ".env "), "AWS_SECRET_ACCESS_KEY=AKIAFAKE\n");
    await expect(ops.read("test", ".env ")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("git show refuses `HEAD:.env\\t` (object path fs tools can't spell)", async () => {
    const g = (a: string[]) => execFileSync("git", a, { cwd: f.wsDir, stdio: "pipe" });
    fs.writeFileSync(path.join(f.wsDir, ".env\t"), "TOKEN=x\n");
    g(["add", "-f", ".env\t"]);
    g(["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-qm", "add tab env"]);
    await expect(gitOps.show(f.wsDir, "HEAD:.env\t")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
});

describe("RT-3: detached grandchildren cannot stall runBounded", () => {
  it("task spawning a detached pipe-holder resolves near the timeout", async () => {
    const node = process.execPath;
    const started = Date.now();
    // sh exits at once; the detached node child inherits our stdio pipes,
    // survives the process-group kill, and would hold `close` open forever.
    const res = await runBounded("/bin/sh", [
      "-c",
      `${node} -e "require('child_process').spawn('sleep',['20'],{detached:true,stdio:'inherit'})" & exit 0`,
    ], {
      cwd: f.wsDir,
      timeoutMs: 1500,
      maxOutputBytes: 4096,
      env: { PATH: "/usr/bin:/bin" },
    });
    const elapsed = Date.now() - started;
    expect(res.timedOut).toBe(true);
    // Without the fix, `close` waits on the orphan's inherited pipes → ~20s.
    expect(elapsed).toBeLessThan(10_000);
  }, 25_000);
});

describe("RT-4: git_log record-separator injection is structurally impossible", () => {
  it("a subject containing \\x1e/\\x1f cannot forge a commit entry", async () => {
    const g = (a: string[]) => execFileSync("git", a, { cwd: f.wsDir, stdio: "pipe" });
    g(["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-qm", "inject", "--allow-empty"]);
    // Raw control chars in a commit message — git stores them verbatim.
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-qm", "real\x1eFAKESHA\x1ffake\x1fFAKE\x1ffake@x\x1f2020-01-01\x1finjected", "--allow-empty"],
      { cwd: f.wsDir, stdio: "pipe" }
    );
    const r = await gitOps.log(f.wsDir, { limit: 10 });
    expect(r.repo).toBe(true);
    const subs = r.commits.map((c) => c.subject ?? "");
    expect(subs.some((s) => s.includes("injected"))).toBe(true); // the real commit is listed
    // No forged record: every returned commit has a 40-hex sha.
    for (const c of r.commits) expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.commits.some((c) => c.author === "FAKE")).toBe(false);
  });
});

describe("INFO-7: prototype-key task ids fail closed", () => {
  it("task_run `constructor` is TASK_DENIED, not INTERNAL_ERROR", async () => {
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-proto-"));
    try {
      const policy = new DenyPolicy([]);
      const index = new WorkspaceIndex({ proto: { path: ws2, tasks: ["constructor"] } }, policy);
      await index.init();
      const runner = new TaskRunner(index, {}, makeLimits());
      await expect(runner.run("proto", "constructor")).rejects.toMatchObject({ code: "TASK_DENIED" });
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });
});

describe("INFO-5: task output root-path scrub", () => {
  it("task stdout has the workspace absolute path replaced by <root>", async () => {
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-scrub-"));
    try {
      const policy = new DenyPolicy([]);
      const index = new WorkspaceIndex({ scrub: { path: ws2, tasks: ["pwd"] } }, policy);
      await index.init();
      const runner = new TaskRunner(index, { pwd: { command: ["/bin/pwd"], timeoutMs: 5000 } }, makeLimits());
      const r = await runner.run("scrub", "pwd");
      expect(r.stdout).not.toContain(ws2);
      expect(r.stdout).toContain("<root>");
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });
});
