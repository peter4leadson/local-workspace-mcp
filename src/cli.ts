#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, defaultConfigPath, defaultConfigDir, defaultAuditLogPath } from "./config.js";
import { DenyPolicy } from "./policy.js";
import { WorkspaceIndex } from "./paths.js";
import { FsOps } from "./fsOps.js";
import { GitOps } from "./git.js";
import { TaskRunner } from "./tasks.js";
import { AuditLog } from "./audit.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { gitEnv } from "./exec.js";
import { runDoctor } from "./doctor.js";
import fs from "node:fs";
import path from "node:path";

const USAGE = `local-workspace-mcp ${SERVER_VERSION}

Usage:
  workspace-mcp serve --stdio     Serve MCP over stdio (the only transport in v1)
  workspace-mcp doctor [--json]   Deterministic local diagnostics
  workspace-mcp init-config       Write a starter config to ${defaultConfigPath()}
  workspace-mcp version           Print version

Config: ${defaultConfigPath()}  (override: WORKSPACE_MCP_CONFIG)
`;

const CONFIG_TEMPLATE = {
  version: 1,
  workspaces: {
    example: { path: "/absolute/path/to/workspace", description: "example", tasks: [] },
  },
  tasks: {},
  deny: [],
  limits: {},
};

async function serve(configPath: string) {
  const cfg = loadConfig(configPath);
  const policy = new DenyPolicy(cfg.deny);
  const index = new WorkspaceIndex(cfg.workspaces, policy);
  await index.init();

  const auditPath = cfg.auditLog ?? defaultAuditLogPath();
  const audit = new AuditLog(auditPath);
  const fsOps = new FsOps(index, policy, cfg.limits, gitEnv, cfg.limits.gitTimeoutMs);
  const gitOps = new GitOps(cfg.limits.gitTimeoutMs, cfg.limits.maxGitOutputBytes, policy);
  const tasks = new TaskRunner(index, cfg.tasks, cfg.limits);
  const server = createServer({ cfg, index, policy, fsOps, gitOps, tasks, audit });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Operational logs go to stderr only — stdout is the protocol channel.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} serving stdio (${index.list().length} workspace(s), config ${cfg.configPath})`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(SERVER_VERSION);
    return;
  }
  if (cmd === "doctor") {
    const { values } = parseArgs({ args: args.slice(1), options: { json: { type: "boolean" }, config: { type: "string" } } });
    const res = await runDoctor(values.config ?? defaultConfigPath());
    if (values.json) {
      console.log(JSON.stringify(res, null, 1));
    } else {
      for (const c of res.checks) {
        console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      }
      console.log(res.ok ? "doctor: ALL GREEN" : "doctor: FAILURES PRESENT");
    }
    process.exit(res.ok ? 0 : 1);
  }
  if (cmd === "init-config") {
    const p = defaultConfigPath();
    if (fs.existsSync(p)) {
      console.error(`config already exists at ${p}`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.mkdirSync(defaultConfigDir(), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n", { mode: 0o600 });
    console.log(`wrote ${p} — edit workspaces/tasks before serving`);
    return;
  }
  if (cmd === "serve") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: { stdio: { type: "boolean" }, config: { type: "string" } },
      allowPositionals: true,
    });
    if (values.stdio === false) {
      console.error("only --stdio transport is supported");
      process.exit(2);
    }
    await serve(values.config ?? defaultConfigPath());
    return;
  }
  console.error(USAGE);
  process.exit(cmd === "help" || cmd === "--help" || cmd === undefined ? 0 : 2);
}

main().catch((e) => {
  console.error(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
