import { runBounded, sanitizedEnv } from "./exec.js";
import { ToolError, WorkspaceIndex } from "./paths.js";
import type { Limits, TaskDefinition } from "./config.js";

const HARD_TIMEOUT_CAP_MS = 300_000;

export class TaskRunner {
  constructor(
    private readonly index: WorkspaceIndex,
    private readonly defs: Record<string, TaskDefinition>,
    private readonly limits: Limits
  ) {}

  listFor(workspaceId: string) {
    const ws = this.index.get(workspaceId);
    return ws.config.tasks.map((taskId) => ({
      taskId,
      ...(this.defs[taskId]?.description ? { description: this.defs[taskId].description } : {}),
      timeoutMs: this.defs[taskId]?.timeoutMs ?? 60_000,
    }));
  }

  async run(workspaceId: string, taskId: string, requestedTimeoutMs?: number) {
    const ws = this.index.get(workspaceId);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(taskId)) {
      throw new ToolError("INVALID_ARGUMENT", "invalid task id");
    }
    if (!ws.config.tasks.includes(taskId)) {
      throw new ToolError(
        "TASK_DENIED",
        `task ${JSON.stringify(taskId)} is not enabled for workspace ${workspaceId}; call task_list`
      );
    }
    const def = this.defs[taskId]!;
    let cwd = ws.realRoot;
    if (def.cwd) {
      const r = await this.index.contain(workspaceId, def.cwd);
      cwd = r.canonical;
    }
    const timeoutMs = Math.min(
      requestedTimeoutMs ?? def.timeoutMs ?? 60_000,
      def.timeoutMs ?? 60_000,
      HARD_TIMEOUT_CAP_MS
    );
    const res = await runBounded(def.command[0]!, def.command.slice(1), {
      cwd,
      timeoutMs,
      maxOutputBytes: this.limits.maxTaskOutputBytes,
      env: sanitizedEnv(def.env),
    });
    return {
      workspace: workspaceId,
      taskId,
      exitCode: res.exitCode,
      signal: res.signal,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      truncated: res.truncated,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }
}
