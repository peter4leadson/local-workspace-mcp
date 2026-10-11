import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import { WorkspaceIndex, ToolError, type ErrorCode } from "./paths.js";
import { DenyPolicy } from "./policy.js";
import { FsOps } from "./fsOps.js";
import { GitOps, splitRevPath } from "./git.js";
import { TaskRunner } from "./tasks.js";
import { AuditLog } from "./audit.js";
import {
  bufferHasKeyMaterial,
  detectKind,
  sniffImage,
  sha256Hex,
  readCapped,
  mediaLimits,
  withDeadline,
  Semaphore,
  NATIVE_IMAGE_KINDS,
  RASTER_MIMES,
} from "./media.js";
import { ImageOps } from "./imageOps.js";
import { ContactSheet } from "./sheet.js";
import { ZipOps, openZipBuffer } from "./zipOps.js";
import { PdfOps } from "./pdfOps.js";
import { OfficeOps, officeFormat } from "./office.js";
import type { LoadedConfig } from "./config.js";

export const SERVER_NAME = "local-workspace-mcp";
export const SERVER_VERSION = "0.2.0";

const workspaceId = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i)
  .describe("Workspace id from workspace_roots, e.g. 'myproj'.");
const wsPath = z
  .string()
  .max(4096)
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

interface ImageBlock {
  data: string;
  mimeType: string;
}

function ok(payload: Record<string, unknown>, images: ImageBlock[] = []) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 1) },
      ...images.map((i) => ({
        type: "image" as const,
        data: i.data,
        mimeType: i.mimeType,
        annotations: { audience: ["user" as const, "assistant" as const] },
      })),
    ],
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
  const { cfg, index, fsOps, gitOps, tasks, audit, policy } = deps;

  /** Scrub a caller-supplied audit target so the log never stores full host
   *  paths: absolute paths inside the workspace root are relativized; other
   *  absolute paths are masked to `<abs>/<basename>`. Relative targets
   *  (paths, refs, task ids) pass through unchanged. */
  const auditTarget = (workspace: string | undefined, target: string | undefined) => {
    if (!target || !path.isAbsolute(target)) return target;
    try {
      const ws = workspace ? index.get(workspace) : undefined;
      if (ws) {
        const rel = path.relative(ws.realRoot, path.resolve(target));
        if (rel === "") return ".";
        if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
      }
    } catch {
      // workspace unknown/unavailable — mask the absolute path anyway
    }
    return `<abs>/${path.basename(target)}`;
  };

  const wrap = <A>(
    tool: string,
    targetOf: (a: A) => { workspace?: string; target?: string },
    fn: (a: A) => Promise<Record<string, unknown>>
  ) => {
    return async (args: A) => {
      const started = Date.now();
      const t0 = targetOf(args);
      const t = { ...t0, target: auditTarget(t0.workspace, t0.target) };
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

  /** Same fail-closed audit/error discipline as wrap, but the handler
   *  returns a payload plus native image blocks. Image bytes never enter
   *  the audit log or structuredContent — only payload metadata does. */
  const wrapMedia = <A>(
    tool: string,
    targetOf: (a: A) => { workspace?: string; target?: string },
    fn: (a: A) => Promise<{ payload: Record<string, unknown>; images: ImageBlock[] }>
  ) => {
    return async (args: A) => {
      const started = Date.now();
      const t0 = targetOf(args);
      const t = { ...t0, target: auditTarget(t0.workspace, t0.target) };
      try {
        const { payload, images } = await fn(args);
        audit.record({
          tool,
          ...(t.workspace ? { workspace: t.workspace } : {}),
          ...(t.target ? { target: t.target } : {}),
          ok: true,
          durationMs: Date.now() - started,
          ...(typeof payload.truncated === "boolean" ? { truncated: payload.truncated } : {}),
        });
        return ok(payload, images);
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
        "offline view of the operator's authorized working trees — including uncommitted state.",
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
        paths: z.array(z.string().max(4096)).min(1).max(32).describe("Workspace-relative paths (max 32)."),
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

  // ---- Media tools (multimodal file access) ------------------------------

  const m = mediaLimits(cfg.limits);
  // One process-wide decode budget shared by every media tool class.
  const mediaSem = new Semaphore(m.mediaConcurrency);
  const imageOps = new ImageOps(index, policy, cfg.limits, mediaSem);
  const sheets = new ContactSheet(index, policy, cfg.limits, mediaSem);
  const zipOps = new ZipOps(index, policy, cfg.limits);
  const pdfOps = new PdfOps(index, policy, cfg.limits, mediaSem);
  const officeOps = new OfficeOps(index, policy, cfg.limits);

  const fitParam = z
    .number()
    .int()
    .min(32)
    .max(4096)
    .optional()
    .describe("Opt-in bounded re-encode: largest output dimension. Omit to receive original bytes (when within the output cap).");

  server.registerTool(
    "fs_inspect",
    {
      title: "Identify file type",
      description:
        "Classify a file inside an authorized workspace before committing to a viewer: detected kind " +
        "(image/zip/ooxml/pdf/text/binary), mime, size, sha256, image dimensions, archive member counts, " +
        "and which fs_* tool opens it. Contents stay inside the workspace; only bounded metadata returns.",
      inputSchema: { workspace: workspaceId, path: wsPath },
      annotations: RO,
    },
    wrap("fs_inspect", (a: { workspace: string; path: string }) => ({ workspace: a.workspace, target: a.path }), async (a) => {
      const r = await index.resolve(a.workspace, a.path);
      const buf = await readCapped(r.canonical, r.rel, m.maxMediaFileBytes);
      if (bufferHasKeyMaterial(buf)) {
        throw new ToolError("ACCESS_DENIED", `file contains private-key material (content-class refusal): ${r.rel}`);
      }
      const kind = detectKind(buf.subarray(0, Math.min(buf.length, 8192)));
      const payload: Record<string, unknown> = {
        workspace: a.workspace,
        path: r.rel,
        kind,
        sizeBytes: buf.length,
        sha256: sha256Hex(buf),
      };
      if (NATIVE_IMAGE_KINDS.has(kind) || kind === "bmp" || kind === "tiff" || kind === "svg") {
        try {
          const s = sniffImage(kind === "svg" ? buf.subarray(0, Math.min(buf.length, 8192)) : buf);
          payload.format = s.kind;
          payload.mimeType = kind === "svg" ? "image/svg+xml" : RASTER_MIMES[s.kind];
          payload.width = s.width;
          payload.height = s.height;
          payload.pixels = s.width * s.height;
        } catch {
          payload.note = "image header could not be parsed (possibly corrupt)";
        }
        payload.openWith = ["fs_image"];
        if (kind === "svg") payload.note = "svg is rasterized to png after an external-reference scan";
        if (kind === "bmp" || kind === "tiff") payload.note = `${kind} is transcoded to png on serve`;
      } else if (kind === "zip" || kind === "ooxml") {
        const arc = await withDeadline(openZipBuffer(buf, policy, m), m.mediaTimeoutMs, "zip enumeration");
        try {
          payload.memberCount = arc.entries.length;
          payload.fileCount = arc.entries.filter((e) => e.type === "file").length;
          payload.deniedCount = arc.entries.filter((e) => e.denied).length;
          payload.unsafeCount = arc.entries.filter((e) => e.unsafe).length;
          payload.encryptedCount = arc.entries.filter((e) => e.encrypted).length;
          payload.truncated = arc.truncated;
          const isOffice = arc.entries.some((e) => e.name === "[Content_Types].xml");
          if (isOffice) {
            payload.kind = "ooxml";
            payload.officeFormat = officeFormat(arc.entries.map((e) => e.name));
            payload.macrosPresent = arc.entries.some((e) => /vbaProject\.bin$/i.test(e.name));
            payload.embeddedMediaCount = arc.entries.filter((e) => /^(word|ppt|xl)\/media\//.test(e.name)).length;
            payload.openWith = ["fs_office_text", "fs_archive_list", "fs_archive_entry"];
          } else {
            payload.openWith = ["fs_archive_list", "fs_archive_entry"];
          }
        } finally {
          arc.close();
        }
      } else if (kind === "pdf") {
        payload.openWith = ["fs_pdf_info", "fs_pdf_page", "fs_pdf_text"];
      } else if (kind === "text") {
        payload.openWith = ["fs_read"];
      } else if (kind === "ole") {
        payload.note = "legacy OLE format (.doc/.xls/.ppt) is not supported; convert to OOXML";
      } else {
        payload.note = "binary file with no supported preview";
      }
      return payload;
    })
  );

  server.registerTool(
    "fs_image",
    {
      title: "View image",
      description:
        "Serve an image from an authorized workspace as a native MCP image block plus metadata " +
        "(sha256, dimensions, format, provenance). Original bytes are returned unless a transform is " +
        "explicitly requested (frame/fitMaxDim/format) or the format requires transcode (bmp/tiff/svg) — " +
        "transforms are always disclosed. Over-cap originals require an explicit fitMaxDim.",
      inputSchema: {
        workspace: workspaceId,
        path: wsPath,
        frame: z.number().int().min(0).max(10000).optional().describe("Frame index for animated images (default 0)."),
        fitMaxDim: fitParam,
        format: z.enum(["png", "jpeg", "webp"]).optional().describe("Explicit re-encode format (disclosed)."),
      },
      annotations: RO,
    },
    wrapMedia(
      "fs_image",
      (a: { workspace: string; path: string }) => ({ workspace: a.workspace, target: a.path }),
      async (a: { workspace: string; path: string; frame?: number; fitMaxDim?: number; format?: "png" | "jpeg" | "webp" }) => {
        const { r, prepared } = await imageOps.preview(a.workspace, a.path, {
          frame: a.frame,
          fitMaxDim: a.fitMaxDim,
          format: a.format,
        });
        const ws = index.get(a.workspace);
        const prov = await gitOps.headShaCached(ws.realRoot);
        const payload: Record<string, unknown> = {
          workspace: a.workspace,
          path: r.rel,
          sha256: sha256Hex(prepared.bytes),
          sizeBytes: prepared.meta.sizeBytes,
          servedBytes: prepared.bytes.length,
          format: prepared.meta.kind,
          mimeType: prepared.meta.mime,
          width: prepared.meta.width,
          height: prepared.meta.height,
          ...(prepared.meta.frames ? { frames: prepared.meta.frames, animated: prepared.meta.animated } : {}),
          ...(prov ? { provenance: { headSha: prov.head, dirty: prov.dirty } } : {}),
          ...(prepared.transform ? { transform: prepared.transform } : {}),
        };
        return { payload, images: [{ data: prepared.bytes.toString("base64"), mimeType: prepared.meta.mime }] };
      }
    )
  );

  server.registerTool(
    "fs_contact_sheet",
    {
      title: "Image contact sheet",
      description:
        "Montage up to N workspace images into one labeled sheet (paths[] or directory+glob selection). " +
        "Each item is authorized independently; failures appear as per-item statuses and placeholder cells. " +
        "One bounded image block is returned with a layout map (index → row/col → path).",
      inputSchema: {
        workspace: workspaceId,
        paths: z.array(z.string().max(4096)).min(1).max(48).optional().describe("Explicit workspace-relative image paths."),
        directory: wsPath.optional().describe("Directory to select images from (with glob)."),
        glob: z.string().max(200).optional().describe("Basename glob for directory selection (default common image types)."),
        cell: z.number().int().min(64).max(512).optional().describe("Cell size px (default 256)."),
        columns: z.number().int().min(1).max(8).optional().describe("Grid columns (default auto)."),
      },
      annotations: RO,
    },
    wrapMedia(
      "fs_contact_sheet",
      (a: { workspace: string }) => ({ workspace: a.workspace }),
      async (a: { workspace: string; paths?: string[]; directory?: string; glob?: string; cell?: number; columns?: number }) => {
        const res = await sheets.render(a.workspace, a);
        const { bytes, mime, ...payload } = res;
        return { payload, images: [{ data: bytes.toString("base64"), mimeType: mime }] };
      }
    )
  );

  server.registerTool(
    "fs_archive_list",
    {
      title: "List archive members",
      description:
        "Enumerate a ZIP inside an authorized workspace without extracting: name, type, compressed/" +
        "uncompressed sizes, ratio, encryption, and per-member deny/unsafe flags. Nothing is decompressed " +
        "for listing; members are paginated and capped.",
      inputSchema: {
        workspace: workspaceId,
        path: wsPath.describe("Workspace-relative path of the .zip file."),
        limit: z.number().int().min(1).max(5000).optional().describe("Members per call (default 500)."),
        offset: z.number().int().min(0).optional(),
      },
      annotations: RO,
    },
    wrap("fs_archive_list", (a: { workspace: string; path: string }) => ({ workspace: a.workspace, target: a.path }), (a: { workspace: string; path: string; limit?: number; offset?: number }) =>
      zipOps.list(a.workspace, a.path, { limit: a.limit, offset: a.offset })
    )
  );

  server.registerTool(
    "fs_archive_entry",
    {
      title: "Preview archive member",
      description:
        "Read one named member of a workspace ZIP through the normal file pipeline — image members return " +
        "native image blocks, text members return bounded text, other kinds return metadata with a refusal " +
        "note. Traversal, symlink, encrypted, nested-archive, and denied members fail closed.",
      inputSchema: {
        workspace: workspaceId,
        path: wsPath.describe("Workspace-relative path of the .zip file."),
        member: z.string().min(1).max(4096).describe("Exact member name from fs_archive_list."),
        fitMaxDim: fitParam,
      },
      annotations: RO,
    },
    wrapMedia(
      "fs_archive_entry",
      (a: { workspace: string; path: string; member: string }) => ({ workspace: a.workspace, target: `${a.path}::${a.member}` }),
      async (a: { workspace: string; path: string; member: string; fitMaxDim?: number }) => {
        const { rel, info, buf, kind } = await zipOps.entryBytes(a.workspace, a.path, a.member);
        const base: Record<string, unknown> = {
          workspace: a.workspace,
          archive: rel,
          member: info.name,
          kind,
          sizeBytes: buf.length,
          sha256: sha256Hex(buf),
          compressedBytes: info.compressedBytes,
          uncompressedBytes: info.uncompressedBytes,
        };
        if (NATIVE_IMAGE_KINDS.has(kind) || kind === "bmp" || kind === "tiff" || kind === "svg") {
          const prepared = await imageOps.previewResolved(`${rel}::${info.name}`, buf, { fitMaxDim: a.fitMaxDim });
          return {
            payload: {
              ...base,
              format: prepared.meta.kind,
              mimeType: prepared.meta.mime,
              width: prepared.meta.width,
              height: prepared.meta.height,
              ...(prepared.transform ? { transform: prepared.transform } : {}),
            },
            images: [{ data: prepared.bytes.toString("base64"), mimeType: prepared.meta.mime }],
          };
        }
        if (kind === "text") {
          const CAP = 65_536;
          const text = buf.toString("utf8");
          return {
            payload: {
              ...base,
              textChars: Math.min(text.length, CAP),
              truncated: text.length > CAP,
              text: text.length > CAP ? text.slice(0, CAP) : text,
            },
            images: [],
          };
        }
        return {
          payload: {
            ...base,
            previewable: false,
            note: `member kind '${kind}' has no inline preview (use fs_pdf_* after extracting to a workspace path for pdf)`,
          },
          images: [],
        };
      }
    )
  );

  server.registerTool(
    "fs_pdf_info",
    {
      title: "PDF document info",
      description: "Page count and text-layer presence for a PDF in an authorized workspace (PDFium/WASM).",
      inputSchema: { workspace: workspaceId, path: wsPath },
      annotations: RO,
    },
    wrap("fs_pdf_info", (a: { workspace: string; path: string }) => ({ workspace: a.workspace, target: a.path }), (a) =>
      pdfOps.info(a.workspace, a.path)
    )
  );

  server.registerTool(
    "fs_pdf_page",
    {
      title: "Render PDF pages",
      description:
        "Render up to 4 PDF pages per call as native PNG image blocks. Pages are 1-based; output scale is " +
        "bounded to the pixel budget. No JavaScript is executed and no external resources are fetched.",
      inputSchema: {
        workspace: workspaceId,
        path: wsPath,
        pages: z.array(z.number().int().min(1)).min(1).max(4).optional().describe("1-based pages to render (default [1])."),
      },
      annotations: RO,
    },
    wrapMedia(
      "fs_pdf_page",
      (a: { workspace: string; path: string }) => ({ workspace: a.workspace, target: a.path }),
      async (a: { workspace: string; path: string; pages?: number[] }) => {
        const res = await pdfOps.renderPages(a.workspace, a.path, a.pages);
        const ws = index.get(a.workspace);
        const prov = await gitOps.headShaCached(ws.realRoot);
        return {
          payload: {
            workspace: a.workspace,
            path: res.rel,
            sha256: res.sha256,
            pageCount: res.pageCount,
            renderedPages: res.pages,
            ...(prov ? { provenance: { headSha: prov.head, dirty: prov.dirty } } : {}),
          },
          images: res.images.map((i) => ({ data: i.bytes.toString("base64"), mimeType: i.mime })),
        };
      }
    )
  );

  server.registerTool(
    "fs_pdf_text",
    {
      title: "Extract PDF text",
      description:
        "Bounded text extraction over a page range (max 50 pages/call). Image-only pages contribute " +
        "nothing and 'textChars:0' is reported honestly; paginate via nextStartPage.",
      inputSchema: {
        workspace: workspaceId,
        path: wsPath,
        startPage: z.number().int().min(1).optional().describe("First page (1-based, default 1)."),
        endPage: z.number().int().min(1).optional().describe("Last page (1-based, default start+49)."),
      },
      annotations: RO,
    },
    wrap("fs_pdf_text", (a: { workspace: string; path: string }) => ({ workspace: a.workspace, target: a.path }), (a: { workspace: string; path: string; startPage?: number; endPage?: number }) =>
      pdfOps.text(a.workspace, a.path, { startPage: a.startPage, endPage: a.endPage })
    )
  );

  server.registerTool(
    "fs_office_text",
    {
      title: "Extract Office text",
      description:
        "Text extraction from OOXML documents (.docx paragraphs, .pptx slides, .xlsx cells) in an " +
        "authorized workspace. Macros are flagged and never executed; external relationships are never " +
        "followed. Legacy OLE formats (.doc/.xls/.ppt) are refused.",
      inputSchema: {
        workspace: workspaceId,
        path: wsPath,
        maxChars: z.number().int().min(1024).max(256000).optional().describe("Returned text cap (default 256000)."),
      },
      annotations: RO,
    },
    wrap("fs_office_text", (a: { workspace: string; path: string }) => ({ workspace: a.workspace, target: a.path }), (a: { workspace: string; path: string; maxChars?: number }) =>
      officeOps.text(a.workspace, a.path, { maxChars: a.maxChars })
    )
  );

  return server;
}
