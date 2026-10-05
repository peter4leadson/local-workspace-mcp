import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeFixture, cleanup, type Fixture } from "./helpers.js";
import { createServer } from "../src/server.js";
import { WorkspaceIndex } from "../src/paths.js";
import { FsOps } from "../src/fsOps.js";
import { GitOps } from "../src/git.js";
import { TaskRunner } from "../src/tasks.js";
import { AuditLog } from "../src/audit.js";
import { gitEnv } from "../src/exec.js";

let f: Fixture;
let client: Client;

beforeAll(async () => {
  f = await makeFixture({ git: true });
  const index = f.index;
  const fsOps = new FsOps(index, f.policy, f.cfg.limits, gitEnv, 15_000);
  const gitOps = new GitOps(15_000, 262_144, f.policy);
  const tasks = new TaskRunner(index, f.cfg.tasks, f.cfg.limits);
  const server = createServer({ cfg: f.cfg, index, policy: f.policy, fsOps, gitOps, tasks, audit: new AuditLog(null) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(ct);
});
afterAll(async () => {
  await client.close();
  cleanup(f);
});

const callText = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text?: string }[])[0]?.text ?? "";
  return { isError: res.isError === true, text, parsed: safeJson(text) };
};
const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

describe("protocol end-to-end", () => {
  it("discovers the full tool catalog", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "fs_list",
        "fs_read",
        "fs_read_many",
        "fs_search_content",
        "fs_search_files",
        "fs_stat",
        "git_branches",
        "git_diff",
        "git_log",
        "git_show",
        "git_status",
        "task_list",
        "task_run",
        "workspace_roots",
      ].sort()
    );
    const readTool = tools.find((t) => t.name === "fs_read");
    expect(readTool?.annotations?.readOnlyHint).toBe(true);
    const taskTool = tools.find((t) => t.name === "task_run");
    expect(taskTool?.annotations?.readOnlyHint).toBe(false);
  });

  it("workspace_roots returns ids without host paths", async () => {
    const r = await callText("workspace_roots", {});
    const ids = r.parsed.workspaces.map((w: { id: string }) => w.id);
    expect(ids).toContain("test");
    expect(JSON.stringify(r.parsed)).not.toContain(f.tmp);
  });

  it("fs_read returns content through the wire", async () => {
    const r = await callText("fs_read", { workspace: "test", path: "src/hello.txt" });
    expect(r.isError).toBe(false);
    expect(r.parsed.content).toContain("hello workspace world");
  });

  it("fs_read on .env returns bounded ACCESS_DENIED", async () => {
    const r = await callText("fs_read", { workspace: "test", path: ".env" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
    expect(r.text).not.toContain("supersecret");
  });

  it("traversal returns OUTSIDE_ROOT", async () => {
    const r = await callText("fs_read", { workspace: "test", path: "../outside/pwned.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^OUTSIDE_ROOT/);
    expect(r.text).not.toContain("outside-secret");
  });

  it("symlink escape returns ACCESS_DENIED", async () => {
    const r = await callText("fs_read", { workspace: "test", path: "link-out/pwned.txt" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^ACCESS_DENIED/);
  });

  it("git_status reports uncommitted truth", async () => {
    const r = await callText("git_status", { workspace: "test" });
    expect(r.parsed.branch).toBe("main");
    expect(r.parsed.untracked).toContain("uncommitted.txt");
  });

  it("task_run executes only allowlisted tasks", async () => {
    const okR = await callText("task_run", { workspace: "test", taskId: "echo-ok" });
    expect(okR.parsed.stdout).toContain("task-ok");
    const badR = await callText("task_run", { workspace: "test", taskId: "not-allowed" });
    expect(badR.isError).toBe(true);
    expect(badR.text).toMatch(/^TASK_DENIED/);
  });

  it("malformed arguments are handled safely", async () => {
    const r = await client
      .callTool({ name: "fs_read", arguments: { workspace: "test" } })
      .catch((e) => ({ isError: true, text: String(e) }));
    // SDK schema validation rejects before reaching the handler
    expect(JSON.stringify(r)).not.toContain("ENOENT");
    const r2 = await callText("git_log", { workspace: "test", ref: "--all" });
    expect(r2.isError).toBe(true);
  });

  it("injected prompt text in repo files does not widen policy", async () => {
    const r = await callText("fs_read", { workspace: "test", path: "INJECTION.txt" });
    expect(r.isError).toBe(false); // reading the file is fine
    const ssh = await callText("fs_read", { workspace: "test", path: "~/.ssh/id_rsa" });
    expect(ssh.isError).toBe(true);
  });
});
