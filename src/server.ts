import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkspaceIndex, ToolError, type ErrorCode } from "./paths.js";
import { DenyPolicy } from "./policy.js";
import { FsOps } from "./fsOps.js";
import { GitOps, splitRevPath } from "./git.js";
import { TaskRunner } from "./tasks.js";
import { AuditLog } from "./audit.js";
import type { LoadedConfig } from "./config.js";

export const SERVER_NAME = "local-workspace-mcp";
export const SERVER_VERSION = "0.1.0";

const workspaceId = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i)
  .describe("Workspace id from workspace_roots, e.g. 'onramp'.");
const wsPath = z
  .string()
  .describe("Path relative to the workspace root, e.g. 'src/index.ts'. Use '.' or omit for the root. Absolute paths are only accepted if inside the workspace.");

interface Deps {
  cfg: LoadedConfig;
  index: WorkspaceIndex;
  policy: DenyPolicy;
  fsOps: FsOps;
  gitOps: GitOps;
  tasks: TaskRunner;
  audit: AuditLog;
}

function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }],
    structuredContent: payload,
  };
}

function err(code: ErrorCode, message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
    structuredContent: { error: code, message },
  };
}

export function createServer(deps: Deps): McpServer {
  const { index, fsOps, gitOps, tasks, audit, policy } = deps;

  const wrap = <A>(
    tool: string,
    targetOf: (a: A) => { workspace?: string; target?: string },
    fn: (a: A) => Promise<Record<string, unknown>>
  ) => {
    return async (args: A) => {
      const started = Date.now();
      const t = targetOf(args);
      try {
        const payload = await fn(args);
        audit.record({
          tool,
          ...(t.workspace ? { workspace: t.workspace } : {}),
          ...(t.target ? { target: t.target } : {}),
          ok: true,
          durationMs: Date.now() - started,
          ...(typeof payload.truncated === "boolean" ? { truncated: payload.truncated } : {}),
        });
        return ok(payload);
      } catch (e) {
        const te = e instanceof ToolError ? e : null;
        const code: ErrorCode = te ? te.code : "INTERNAL_ERROR";
        audit.record({
          tool,
          ...(t.workspace ? { workspace: t.workspace } : {}),
          ...(t.target ? { target: t.target } : {}),
          ok: false,
          code,
          durationMs: Date.now() - started,
        });
        return err(code, te ? te.message : "unexpected internal error");
      }
    };
  };

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const RO = { readOnlyHint: true, openWorldHint: false, idempotentHint: true } as const;

  /** Deny check for repo-relative paths used by git tools (pathspecs, blob
   *  paths). Pathspec magic `:(...)` / `:!` / `:/` and glob metacharacters
   *  are rejected outright — literal paths only (GIT_LITERAL_PATHSPECS also
   *  pins literal semantics at the git layer). */
  const denyRepoPath = (p: string) => {
    if (p.startsWith(":")) throw new ToolError("INVALID_ARGUMENT", "git pathspec magic is not accepted");
    const clean = p.replace(/^\.\//, "");
    const reason = policy.check(clean);
    if (reason) throw new ToolError("ACCESS_DENIED", `path denied by policy (${reason})`);
  };

  server.registerTool(
    "workspace_roots",
    {
      title: "List authorized workspaces",
      description:
        "List the local engineering workspaces this server is authorized to inspect. Returns workspace ids " +
        "for use with all other tools, plus availability and enabled task ids. This is a read-only, " +
        "offline view of Peter's live working trees — including uncommitted state.",
      inputSchema: {},
      annotations: RO,
    },
    wrap("workspace_roots", () => ({}), async () => ({
      workspaces: index.list(),
      note: "Use a workspace id + relative path with fs_* and git_* tools. Absolute host paths are not required.",
    }))
  );

  server.registerTool(
    "fs_list",
    {
      title: "List directory",
      description:
        "Bounded directory listing inside an authorized workspace. Non-recursive; paginate with offset. " +
        "Entries denied by the sensitive-file policy are flagged but their contents remain inaccessible.",
      inputSchema: {
        workspace: workspaceId,
        path: wsPath.optional(),
        limit: z.number().int().min(1).max(1000).optional().describe("Max entries to return (default 200)."),
        offset: z.number().int().min(0).optional().describe("Entry offset for pagination."),
      },
      annotations: RO,
    },
    wrap("fs_list", (a: { workspace: string; path?: string; limit?: number; offset?: number }) => ({ workspace: a.workspace, target: a.path }), (a) =>
      fsOps.list(a.workspace, a.path, a.limit, a.offset ?? 0)
    )
  );

  server.registerTool(
    "fs_stat",
    {
      title: "File/directory metadata",
      description: "Metadata (type, size, mtimes, permissions) for a path inside an authorized workspace.",
      inputSchema: { workspace: workspaceId, path: wsPath },
      annotations: RO,
    },
    wrap("fs_stat", (a: { workspace: string; path: string }) => ({ workspace: a.workspace, target: a.path }), (a) => fsOps.stat(a.workspace, a.path))
  );

  server.registerTool(
    "fs_read",
    {
      title: "Read text file",
      description:
        "Read a line range of a text file inside an authorized workspace. Returns bounded content with " +
        "truncation metadata; use startLine/nextStartLine to page. Binary files are refused. " +
        "Sensitive files (e.g. .env, private keys, credential stores) fail closed with ACCESS_DENIED.",
      inputSchema: {
        workspace: workspaceId,
        path: wsPath,
        startLine: z.number().int().min(1).optional().describe("1-based first line to return (default 1)."),
        maxLines: z.number().int().min(1).max(2000).optional().describe("Max lines (default 400, cap 2000)."),
        maxBytes: z.number().int().min(256).max(256000).optional().describe("Max returned bytes (default 64KiB)."),
      },
      annotations: RO,
    },
    wrap("fs_read", (a: { workspace: string; path: string; startLine?: number; maxLines?: number; maxBytes?: number }) => ({ workspace: a.workspace, target: a.path }), (a) =>
      fsOps.read(a.workspace, a.path, { startLine: a.startLine, maxLines: a.maxLines, maxBytes: a.maxBytes })
    )
  );

  server.registerTool(
    "fs_read_many",
    {
      title: "Read several files",
      description:
        "Read multiple bounded text files from one workspace in a single call. Per-file errors (denied, " +
        "missing, binary) are reported inline without aborting the batch. A total response cap applies.",
      inputSchema: {
        workspace: workspaceId,
        paths: z.array(z.string()).min(1).max(32).describe("Workspace-relative paths (max 32)."),
        maxBytesPerFile: z.number().int().min(256).max(256000).optional(),
      },
      annotations: RO,
    },
    wrap("fs_read_many", (a: { workspace: string; paths: string[]; maxBytesPerFile?: number }) => ({ workspace: a.workspace }), (a) =>
      fsOps.readMany(a.workspace, a.paths, { maxBytesPerFile: a.maxBytesPerFile })
    )
  );

  server.registerTool(
    "fs_search_files",
    {
      title: "Search file names",
      description:
        "Find files in a workspace by glob pattern (matched against workspace-relative paths, or basenames " +
        "when the pattern has no '/'). Uses the git file universe when available, so generated/ignored " +
        "content is skipped. Bounded results.",
      inputSchema: {
        workspace: workspaceId,
        pattern: z.string().min(1).max(300).describe("Glob, e.g. '*.ts', 'src/**/*.test.ts', 'README*'."),
        path: wsPath.optional().describe("Restrict to this subdirectory."),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: RO,
    },
    wrap("fs_search_files", (a: { workspace: string; pattern: string; path?: string; limit?: number }) => ({ workspace: a.workspace, target: a.pattern }), (a) =>
      fsOps.searchFiles(a.workspace, a.pattern, a.path, a.limit)
    )
  );

  server.registerTool(
    "fs_search_content",
    {
      title: "Search file contents",
      description:
        "Search file contents inside one authorized workspace using ripgrep (literal by default; set regex " +
        "for ripgrep-compatible regex). Honors .gitignore; time- and count-bounded. Denied paths are " +
        "filtered from results.",
      inputSchema: {
        workspace: workspaceId,
        query: z.string().min(1).max(500).describe("Literal string or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regex (default false = literal)."),
        caseInsensitive: z.boolean().optional(),
        glob: z.string().max(200).optional().describe("Restrict to files matching glob, e.g. '*.ts'."),
        path: wsPath.optional().describe("Restrict search to this subdirectory."),
        limit: z.number().int().min(1).max(500).optional().describe("Max matches (default 200)."),
      },
      annotations: RO,
    },
    wrap("fs_search_content", (a: { workspace: string; query: string; regex?: boolean; caseInsensitive?: boolean; glob?: string; path?: string; limit?: number }) => ({ workspace: a.workspace, target: a.path }), (a) =>
      fsOps.searchContent(a.workspace, a.query, {
        regex: a.regex,
        caseInsensitive: a.caseInsensitive,
        glob: a.glob,
        path: a.path,
        limit: a.limit,
      })
    )
  );

  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description:
        "Current branch/HEAD, ahead-behind, and categorized working-tree state (staged, modified, deleted, " +
        "renamed, untracked, conflicted) for a workspace repository. Reflects uncommitted local truth.",
      inputSchema: { workspace: workspaceId },
      annotations: RO,
    },
    wrap("git_status", (a: { workspace: string }) => ({ workspace: a.workspace }), async (a) => {
      const ws = index.get(a.workspace);
      const s = await gitOps.status(ws.realRoot);
      if (s.repo) {
        const listed = [
          ...s.staged,
          ...s.modified,
          ...s.deleted,
          ...s.untracked,
          ...s.conflicted,
          ...s.renamed.map((r) => r.to),
        ];
        const deniedPaths = [...new Set(listed.filter((p) => policy.check(p)))];
        if (deniedPaths.length) return { ...s, deniedPaths };
      }
      return s;
    })
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description:
        "Bounded diff of the working tree, staged changes, or between two refs. Supports stat-only mode " +
        "and path filtering. Output is capped; 'truncated' reports when the cap was hit.",
      inputSchema: {
        workspace: workspaceId,
        staged: z.boolean().optional().describe("Diff index vs HEAD (--cached)."),
        base: z.string().max(255).optional().describe("Base ref (branch/tag/SHA)."),
        head: z.string().max(255).optional().describe("Comparison ref; requires base."),
        paths: z.array(z.string().max(500)).max(100).optional().describe("Repo-relative path filters."),
        stat: z.boolean().optional().describe("Return only --stat summary."),
      },
      annotations: RO,
    },
    wrap("git_diff", (a: { workspace: string; staged?: boolean; base?: string; head?: string; paths?: string[]; stat?: boolean; maxBytes?: number }) => ({ workspace: a.workspace }), async (a) => {
      const ws = index.get(a.workspace);
      for (const p of a.paths ?? []) denyRepoPath(p);
      return gitOps.diff(ws.realRoot, a);
    })
  );

  server.registerTool(
    "git_log",
    {
      title: "Git log",
      description: "Bounded commit history for a ref (default HEAD): sha, author, date, subject. Max 100.",
      inputSchema: {
        workspace: workspaceId,
        ref: z.string().max(255).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: RO,
    },
    wrap("git_log", (a: { workspace: string; ref?: string; limit?: number }) => ({ workspace: a.workspace }), async (a) => {
      const ws = index.get(a.workspace);
      return gitOps.log(ws.realRoot, a);
    })
  );

  server.registerTool(
    "git_show",
    {
      title: "Git show",
      description:
        "Inspect one git object: a commit ref ('abc123', 'HEAD~2') returns metadata + bounded patch/stat; " +
        "'ref:path' returns a file's content at that revision. Refs are strictly validated.",
      inputSchema: {
        workspace: workspaceId,
        spec: z.string().min(1).max(400).describe("Ref like 'HEAD', 'main~3', or 'ref:path/to/file'."),
      },
      annotations: RO,
    },
    wrap("git_show", (a: { workspace: string; spec: string }) => ({ workspace: a.workspace, target: a.spec }), async (a) => {
      const ws = index.get(a.workspace);
      const { path: objPath } = splitRevPath(a.spec);
      if (objPath) denyRepoPath(objPath);
      return gitOps.show(ws.realRoot, a.spec);
    })
  );

  server.registerTool(
    "git_branches",
    {
      title: "Git branches & worktrees",
      description: "Current branch (or detached HEAD), local branches with upstreams, and worktree records.",
      inputSchema: { workspace: workspaceId },
      annotations: RO,
    },
    wrap("git_branches", (a: { workspace: string }) => ({ workspace: a.workspace }), async (a) => {
      const ws = index.get(a.workspace);
      return gitOps.branches(ws.realRoot);
    })
  );

  server.registerTool(
    "task_list",
    {
      title: "List permitted tasks",
      description:
        "List the named tasks an operator has explicitly enabled for a workspace (e.g. verify, lint, " +
        "typecheck). Only ids returned here can be executed via task_run.",
      inputSchema: { workspace: workspaceId },
      annotations: RO,
    },
    wrap("task_list", (a: { workspace: string }) => ({ workspace: a.workspace }), async (a) => ({
      workspace: a.workspace,
      tasks: tasks.listFor(a.workspace),
    }))
  );

  server.registerTool(
    "task_run",
    {
      title: "Run permitted task",
      description:
        "Execute an explicitly configured named task for a workspace (direct process spawn, argv array, " +
        "sanitized environment, bounded timeout and output). The task id must appear in task_list; " +
        "arbitrary commands are not supported.",
      inputSchema: {
        workspace: workspaceId,
        taskId: z.string().min(1).max(64).describe("Task id from task_list."),
        timeoutMs: z.number().int().min(1000).max(300000).optional().describe("Lower bound wins over the configured cap."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    },
    wrap("task_run", (a: { workspace: string; taskId: string; timeoutMs?: number }) => ({ workspace: a.workspace, target: a.taskId }), (a) =>
      tasks.run(a.workspace, a.taskId, a.timeoutMs)
    )
  );

  return server;
}
