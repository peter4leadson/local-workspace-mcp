import fs from "node:fs";
import path from "node:path";
import { loadConfig, defaultConfigPath } from "./config.js";
import { DenyPolicy } from "./policy.js";
import { runBounded, sanitizedEnv, gitEnv } from "./exec.js";
import { SERVER_NAME, SERVER_VERSION } from "./server.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

function which(bin: string): string | null {
  const pathEnv = sanitizedEnv().PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const cand = path.join(dir, bin);
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      const st = fs.statSync(cand);
      if (st.isFile()) return cand;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export async function runDoctor(configPath = defaultConfigPath()): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const push = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  push("build", true, `${SERVER_NAME} ${SERVER_VERSION} on node ${process.version}`);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  push("node.version", nodeMajor >= 20, `${process.version} (requires >=20)`);

  // config parse
  let cfg;
  try {
    const { checkConfigPermissions } = await import("./config.js");
    const perms = checkConfigPermissions(configPath);
    push("config.permissions", perms.ok, `mode ${perms.mode} (must not be group/world-writable)`);
  } catch (e) {
    push("config.permissions", false, String(e));
  }
  try {
    cfg = loadConfig(configPath);
    push("config.parse", true, `${configPath} — ${Object.keys(cfg.workspaces).length} workspace(s), ${Object.keys(cfg.tasks).length} task definition(s)`);
  } catch (e) {
    push("config.parse", false, String(e));
    return { ok: false, checks };
  }

  // roots
  for (const [id, ws] of Object.entries(cfg.workspaces)) {
    try {
      const real = fs.realpathSync(ws.path);
      const st = fs.statSync(real);
      push(`root.${id}`, st.isDirectory(), st.isDirectory() ? "exists and is a directory" : "exists but is not a directory");
    } catch (e) {
      push(`root.${id}`, false, `not accessible: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
  }

  // git
  try {
    const res = await runBounded("git", ["--version"], { cwd: "/", timeoutMs: 5000, maxOutputBytes: 4096, env: sanitizedEnv() });
    push("git.available", res.exitCode === 0, res.stdout.trim() || `exit ${res.exitCode}`);
  } catch {
    push("git.available", false, "git binary not found");
  }

  // rg
  const rg = which("rg");
  push("rg.available", rg !== null, rg ?? "ripgrep not found on sanitized PATH — fs_search_content will fail");

  // task executables
  for (const [taskId, def] of Object.entries(cfg.tasks)) {
    const bin = def.command[0]!;
    const found = bin.includes("/") ? fs.existsSync(bin) : which(bin) !== null;
    push(`task.${taskId}.executable`, found, found ? `${bin} resolvable` : `${bin} not found on sanitized PATH`);
    if (def.command.some((a) => a.length === 0 || a.length > 500)) {
      push(`task.${taskId}.argv`, false, "empty or overlong argument");
    }
  }

  // policy self-test
  const policy = new DenyPolicy(cfg.deny);
  const policyCases: [string, boolean][] = [
    [".env", true],
    ["pkg/.env.local", true],
    [".env.example", false],
    ["config/.env.staging.example", false],
    ["keys/id_rsa", true],
    ["cert.pem", true],
    ["src/index.ts", false],
    [".git/config", true],
    ["secrets.json", true],
  ];
  const policyBad = policyCases.filter(([p, denied]) => (policy.check(p) !== null) !== denied);
  push("policy.selftest", policyBad.length === 0, policyBad.length ? `misclassified: ${policyBad.map(([p]) => p).join(", ")}` : "9/9 cases correct");

  // MCP startup smoke: constructing the server proves tool registration works.
  try {
    const { createServer } = await import("./server.js");
    const { WorkspaceIndex } = await import("./paths.js");
    const { FsOps } = await import("./fsOps.js");
    const { GitOps } = await import("./git.js");
    const { TaskRunner } = await import("./tasks.js");
    const { AuditLog } = await import("./audit.js");
    const index = new WorkspaceIndex(cfg.workspaces, policy);
    const fsOps = new FsOps(index, policy, cfg.limits, gitEnv, cfg.limits.gitTimeoutMs);
    const gitOps = new GitOps(cfg.limits.gitTimeoutMs, cfg.limits.maxGitOutputBytes, policy);
    const tasks = new TaskRunner(index, cfg.tasks, cfg.limits);
    createServer({ cfg, index, policy, fsOps, gitOps, tasks, audit: new AuditLog(null) });
    push("mcp.startup", true, "tool registration ok");
  } catch (e) {
    push("mcp.startup", false, String(e));
  }

  // optional: tunnel-client presence
  const tc = which("tunnel-client");
  push("tunnel-client.present", true, tc ?? "not installed (only needed for the ChatGPT tunnel)");

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
