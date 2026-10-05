import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { minimatch } from "minimatch";
import { WorkspaceIndex, ToolError } from "./paths.js";
import { DenyPolicy } from "./policy.js";
import type { Limits } from "./config.js";
import { gitFileUniverse } from "./git.js";
import { runBounded, sanitizedEnv } from "./exec.js";

/** Directories skipped when walking non-git workspaces (git workspaces use
 *  `git ls-files`, which already honors .gitignore). */
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode-test",
]);

export interface ListEntry {
  name: string;
  relPath: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  mtime?: string;
  denied?: string;
}

export class FsOps {
  constructor(
    private readonly index: WorkspaceIndex,
    private readonly policy: DenyPolicy,
    private readonly limits: Limits,
    private readonly gitEnvFn: () => Record<string, string>,
    private readonly gitTimeoutMs: number
  ) {}

  async list(workspace: string, inputPath: string | undefined, limit?: number, offset = 0) {
    const r = await this.index.resolve(workspace, inputPath);
    const st = await fs.stat(r.canonical).catch(() => null);
    if (!st) throw new ToolError("NOT_FOUND", `path does not exist: ${r.rel}`);
    if (!st.isDirectory()) throw new ToolError("INVALID_ARGUMENT", `not a directory: ${r.rel}`);

    const cap = Math.min(limit ?? this.limits.maxListEntries, this.limits.maxListEntries);
    const dirents = await fs.readdir(r.canonical, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    const total = dirents.length;
    const slice = dirents.slice(offset, offset + cap);
    const entries: ListEntry[] = await Promise.all(
      slice.map(async (d) => {
        const rel = r.rel === "." ? d.name : `${r.rel}/${d.name}`;
        const entry: ListEntry = {
          name: d.name,
          relPath: rel,
          type: d.isDirectory() ? "directory" : d.isFile() ? "file" : d.isSymbolicLink() ? "symlink" : "other",
        };
        const denied = this.policy.check(rel);
        if (denied) entry.denied = denied;
        try {
          const s = await fs.lstat(path.join(r.canonical, d.name));
          entry.size = s.size;
          entry.mtime = s.mtime.toISOString();
        } catch {
          /* vanished between readdir and lstat */
        }
        return entry;
      })
    );

    const nextOffset = offset + slice.length;
    return {
      workspace,
      path: r.rel,
      entries,
      shown: slice.length,
      totalEntries: total,
      truncated: nextOffset < total,
      nextOffset: nextOffset < total ? nextOffset : null,
    };
  }

  async stat(workspace: string, inputPath: string) {
    const r = await this.index.resolve(workspace, inputPath);
    let st;
    try {
      st = await fs.stat(r.canonical);
    } catch {
      throw new ToolError("NOT_FOUND", `path does not exist: ${r.rel}`);
    }
    return {
      workspace,
      path: r.rel,
      type: st.isDirectory() ? "directory" : st.isFile() ? "file" : "other",
      sizeBytes: st.size,
      modified: st.mtime.toISOString(),
      created: st.birthtime.toISOString(),
      permissions: (st.mode & 0o777).toString(8),
      viaSymlink: r.realRel !== r.rel,
    };
  }

  private async isBinary(canonical: string): Promise<boolean> {
    const fh = await fs.open(canonical, "r");
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, 8192, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  }

  async read(
    workspace: string,
    inputPath: string,
    opts: { startLine?: number; maxLines?: number; maxBytes?: number } = {}
  ) {
    const r = await this.index.resolve(workspace, inputPath);
    let st;
    try {
      st = await fs.stat(r.canonical);
    } catch {
      throw new ToolError("NOT_FOUND", `path does not exist: ${r.rel}`);
    }
    if (!st.isFile()) throw new ToolError("INVALID_ARGUMENT", `not a file: ${r.rel}`);
    if (st.size > this.limits.maxReadFileBytes) {
      throw new ToolError(
        "RESOURCE_LIMIT",
        `file is ${st.size} bytes, over limit ${this.limits.maxReadFileBytes}; narrow with git_search or read a smaller file`
      );
    }
    if (await this.isBinary(r.canonical)) {
      throw new ToolError("BINARY_FILE", `binary file; refusing to emit content: ${r.rel} (${st.size} bytes)`);
    }

    const startLine = Math.max(1, opts.startLine ?? 1);
    const maxLines = Math.min(opts.maxLines ?? 400, 2000);
    const maxBytes = Math.min(opts.maxBytes ?? this.limits.defaultReadBytes, this.limits.maxReadBytes);
    const endLine = startLine + maxLines - 1;

    const lines: string[] = [];
    let bytes = 0;
    let truncated = false;
    let lastLine = 0;
    let totalLines = 0;
    const rl = readline.createInterface({
      input: createReadStream(r.canonical, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        totalLines++;
        if (totalLines < startLine) continue;
        if (totalLines > endLine) {
          truncated = true;
          break;
        }
        const projected = bytes + Buffer.byteLength(line) + 1;
        if (projected > maxBytes) {
          truncated = true;
          break;
        }
        lines.push(line);
        bytes = projected;
        lastLine = totalLines;
      }
      // If we never broke early, we scanned the whole file and know totalLines.
    } finally {
      rl.close();
    }

    return {
      workspace,
      path: r.rel,
      sizeBytes: st.size,
      startLine,
      endLine: lastLine,
      bytesReturned: bytes,
      truncated,
      ...(truncated ? {} : { totalLines }),
      nextStartLine: truncated ? lastLine + 1 : null,
      content: lines.join("\n"),
    };
  }

  async readMany(
    workspace: string,
    paths: string[],
    opts: { maxBytesPerFile?: number; maxTotalBytes?: number } = {}
  ) {
    if (paths.length === 0) throw new ToolError("INVALID_ARGUMENT", "paths must be non-empty");
    if (paths.length > this.limits.maxReadManyFiles) {
      throw new ToolError("RESOURCE_LIMIT", `too many paths (${paths.length} > ${this.limits.maxReadManyFiles})`);
    }
    const totalCap = Math.min(opts.maxTotalBytes ?? this.limits.maxReadManyTotalBytes, this.limits.maxReadManyTotalBytes);
    const perFile = Math.min(opts.maxBytesPerFile ?? this.limits.defaultReadBytes, this.limits.maxReadBytes);

    const files: unknown[] = [];
    let totalBytes = 0;
    let totalTruncated = false;
    for (const p of paths) {
      if (totalBytes >= totalCap) {
        totalTruncated = true;
        files.push({ path: p, error: "RESOURCE_LIMIT: total response cap reached" });
        continue;
      }
      try {
        const res = await this.read(workspace, p, { maxBytes: Math.min(perFile, totalCap - totalBytes) });
        const { content, ...meta } = res;
        totalBytes += meta.bytesReturned;
        files.push({ ...meta, content });
      } catch (err) {
        if (err instanceof ToolError) {
          files.push({ path: p, error: `${err.code}: ${err.message}` });
        } else {
          files.push({ path: p, error: "INTERNAL_ERROR" });
        }
      }
    }
    return { workspace, files, totalBytes, truncated: totalTruncated };
  }

  /** Enumerate candidate files for a workspace: git-aware when possible. */
  private async fileUniverse(ws: { id: string; realRoot: string }): Promise<{ files: string[]; viaGit: boolean }> {
    try {
      const files = await gitFileUniverse(ws.realRoot, this.gitEnvFn(), this.gitTimeoutMs);
      return { files, viaGit: true };
    } catch {
      return { files: await this.walkUniverse(ws.realRoot), viaGit: false };
    }
  }

  private async walkUniverse(root: string): Promise<string[]> {
    const out: string[] = [];
    const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop()!;
      if (out.length >= this.limits.walkEntryCap) break;
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (!DEFAULT_SKIP_DIRS.has(d.name) && depth < this.limits.walkDepthCap) {
            stack.push({ dir: full, depth: depth + 1 });
          }
        } else if (d.isFile()) {
          out.push(path.relative(root, full));
        }
      }
    }
    return out;
  }

  async searchFiles(workspace: string, pattern: string, inputPath?: string, limit?: number) {
    const r = await this.index.resolve(workspace, inputPath ?? ".");
    if (!pattern || pattern.length > 300) throw new ToolError("INVALID_ARGUMENT", "pattern missing or too long");
    const cap = Math.min(limit ?? this.limits.maxSearchResults, this.limits.maxSearchResults);

    const { files, viaGit } = await this.fileUniverse(r.ws);
    const scopePrefix = r.rel === "." ? "" : `${r.rel}/`;
    const basenameOnly = !pattern.includes("/");

    const matches: { path: string }[] = [];
    let deniedCount = 0;
    let totalMatched = 0;
    for (const rel of files) {
      const relPosix = rel.split(path.sep).join("/");
      if (scopePrefix && !relPosix.startsWith(scopePrefix)) continue;
      const target = basenameOnly ? relPosix.split("/").pop()! : relPosix;
      if (!minimatch(target, pattern, { dot: true, nocase: true })) {
        continue;
      }
      // Deny filter on result paths.
      if (this.policy.check(relPosix)) {
        deniedCount++;
        continue;
      }
      totalMatched++;
      if (matches.length < cap) matches.push({ path: relPosix });
    }

    return {
      workspace,
      path: r.rel,
      pattern,
      viaGit,
      matches,
      shown: matches.length,
      totalMatched,
      deniedFiltered: deniedCount,
      truncated: totalMatched > matches.length,
    };
  }

  async searchContent(
    workspace: string,
    query: string,
    opts: {
      regex?: boolean;
      caseInsensitive?: boolean;
      glob?: string;
      path?: string;
      limit?: number;
      maxMatchesPerFile?: number;
    } = {}
  ) {
    const r = await this.index.resolve(workspace, opts.path ?? ".");
    if (!query || query.length > 500) throw new ToolError("INVALID_ARGUMENT", "query missing or too long");
    const cap = Math.min(opts.limit ?? this.limits.maxSearchResults, this.limits.maxSearchResults);
    const perFile = Math.min(opts.maxMatchesPerFile ?? this.limits.maxSearchMatchesPerFile, this.limits.maxSearchMatchesPerFile);

    const args = [
      "--line-number",
      "--no-heading",
      "--color=never",
      "--hidden",
      `--max-count=${perFile}`,
      "--max-columns=400",
      "--glob=!.git",
      "--glob=!.git/**",
    ];
    if (opts.regex) {
      args.push("-e", query);
    } else {
      args.push("-F", "-e", query);
    }
    if (opts.caseInsensitive) args.push("-i");
    if (opts.glob) args.push(`--glob=${opts.glob}`);
    args.push("--", r.canonical);

    const result = await runBounded("rg", args, {
      cwd: r.ws.realRoot,
      timeoutMs: this.limits.searchDeadlineMs,
      maxOutputBytes: this.limits.maxGitOutputBytes,
      env: sanitizedEnv(),
    }).catch((err: unknown) => {
      if (err instanceof ToolError) throw err;
      throw new ToolError("INTERNAL_ERROR", "ripgrep execution failed");
    });

    // rg exits 1 for "no matches"; that is not an error.
    if (result.exitCode !== 0 && result.exitCode !== 1 && !result.timedOut) {
      throw new ToolError("INVALID_ARGUMENT", `search failed (rg exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
    }

    const matches: { path: string; line: number; preview: string }[] = [];
    let deniedCount = 0;
    let rawCount = 0;
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      rawCount++;
      // rg prints absolute paths because we pass an absolute search root.
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const rel = path.relative(r.ws.realRoot, m[1]!).split(path.sep).join("/");
      if (rel.startsWith("..") || this.policy.check(rel)) {
        deniedCount++;
        continue;
      }
      if (matches.length < cap) {
        matches.push({ path: rel, line: Number(m[2]), preview: (m[3] ?? "").slice(0, 240) });
      }
    }

    return {
      workspace,
      path: r.rel,
      query: opts.regex ? `regex:${query}` : `literal:${query}`,
      matches,
      shown: matches.length,
      rawMatches: rawCount,
      deniedFiltered: deniedCount,
      truncated: rawCount > matches.length || result.truncated || result.timedOut,
      timedOut: result.timedOut,
      backend: "rg",
    };
  }
}
