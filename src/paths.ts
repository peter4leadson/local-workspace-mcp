import fs from "node:fs/promises";
import path from "node:path";
import { DenyPolicy } from "./policy.js";
import type { WorkspaceConfig } from "./config.js";

export type ErrorCode =
  | "ACCESS_DENIED"
  | "OUTSIDE_ROOT"
  | "NOT_FOUND"
  | "UNKNOWN_WORKSPACE"
  | "INVALID_ARGUMENT"
  | "RESOURCE_LIMIT"
  | "BINARY_FILE"
  | "WORKSPACE_UNAVAILABLE"
  | "TASK_DENIED"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

export class ToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ResolvedPath {
  /** Canonical absolute path on disk (realpath'd ancestors; may not exist). */
  canonical: string;
  /** Workspace-relative path ("/" separators); "." for the root itself. */
  rel: string;
  /** rel of the realpath'd target — differs from rel when symlinks resolve. */
  realRel: string;
  /** rel of the lexically-resolved input — differs from realRel via symlinks. */
  lexRel: string;
}

export interface WorkspaceEntry {
  id: string;
  config: WorkspaceConfig;
  configuredPath: string;
  realRoot: string;
  available: boolean;
}

const MAX_INPUT_PATH = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\0-\x1f\x7f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;

/** Lexical-stage gate: compared case-insensitively so wrong-case input paths
 *  on case-insensitive filesystems (default APFS) still reach the canonical
 *  stage. NOT authoritative for canonical paths — see isInsideCanonical. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Canonical-stage gate: strict case-sensitive containment of realpath'd
 *  paths. realpath returns the on-disk canonical name; a case-folded compare
 *  here would let a case-variant sibling escape on case-sensitive volumes. */
export function isInsideCanonical(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function toRel(root: string, canonical: string): string {
  const r = path.relative(root, canonical);
  return r === "" ? "." : r.split(path.sep).join("/");
}

export class WorkspaceIndex {
  private readonly workspaces = new Map<string, WorkspaceEntry>();

  constructor(
    wsConfigs: Record<string, WorkspaceConfig>,
    private readonly policy: DenyPolicy
  ) {
    for (const [id, config] of Object.entries(wsConfigs)) {
      this.workspaces.set(id, {
        id,
        config,
        configuredPath: path.resolve(config.path),
        realRoot: "",
        available: false,
      });
    }
  }

  /** Resolve canonical roots once at startup. Unavailable roots stay listed
   *  (marked unavailable) so callers can still discover the workspace id. */
  async init(): Promise<void> {
    await Promise.all(
      [...this.workspaces.values()].map(async (ws) => {
        try {
          const real = await fs.realpath(ws.configuredPath);
          const st = await fs.stat(real);
          ws.realRoot = real;
          ws.available = st.isDirectory();
        } catch {
          ws.realRoot = ws.configuredPath;
          ws.available = false;
        }
      })
    );
  }

  list(): { id: string; description?: string; available: boolean; tasks: string[] }[] {
    return [...this.workspaces.values()].map((w) => ({
      id: w.id,
      ...(w.config.description ? { description: w.config.description } : {}),
      available: w.available,
      tasks: w.config.tasks,
    }));
  }

  get(id: string): WorkspaceEntry {
    const ws = this.workspaces.get(id);
    if (!ws) throw new ToolError("UNKNOWN_WORKSPACE", `unknown workspace ${JSON.stringify(id)}`);
    if (!ws.available) {
      throw new ToolError("WORKSPACE_UNAVAILABLE", `workspace ${id} root is not accessible`);
    }
    return ws;
  }

  /**
   * Containment: caller input -> canonical path proven inside the workspace
   * root. Throws ToolError on traversal, escapes, bad input, missing roots.
   * Does NOT apply the deny policy (use `policy.check` / `resolve`).
   */
  async contain(id: string, inputPath: string | undefined): Promise<ResolvedPath & { ws: WorkspaceEntry }> {
    const ws = this.get(id);
    const input = (inputPath ?? ".").trim() === "" ? "." : (inputPath ?? ".");
    if (input.length > MAX_INPUT_PATH) {
      throw new ToolError("INVALID_ARGUMENT", "path exceeds maximum length");
    }
    if (CONTROL_CHARS.test(input)) {
      throw new ToolError("INVALID_ARGUMENT", "path contains control characters");
    }
    if (input.startsWith("~")) {
      throw new ToolError("ACCESS_DENIED", "home-directory expansion is not allowed; use workspace-relative paths");
    }
    if (WINDOWS_DRIVE.test(input)) {
      throw new ToolError("INVALID_ARGUMENT", "Windows-style paths are not accepted");
    }

    // Lexical stage: resolves `..` and catches absolute-path escapes cheaply.
    const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(ws.realRoot, input);
    if (!isInside(resolved, ws.realRoot) && !isInside(resolved, ws.configuredPath)) {
      throw new ToolError("OUTSIDE_ROOT", `path escapes workspace root: ${JSON.stringify(input)}`);
    }

    // Canonical stage: realpath the target or its deepest existing ancestor.
    const canonical = await this.realpathWithinRoot(ws, resolved);
    const lexRel = toRel(ws.realRoot, resolved);
    const realRel = toRel(ws.realRoot, canonical);
    return { canonical, rel: realRel === "." ? lexRel : realRel, realRel, lexRel, ws };
  }

  /** Containment + deny policy: the standard gate for all file access. */
  async resolve(id: string, inputPath: string | undefined): Promise<ResolvedPath & { ws: WorkspaceEntry }> {
    const r = await this.contain(id, inputPath);
    const denied = this.denyReason(r);
    if (denied) {
      throw new ToolError("ACCESS_DENIED", `path denied by policy (${denied})`);
    }
    return r;
  }

  denyReason(r: Pick<ResolvedPath, "rel" | "realRel">): string | null {
    for (const rel of new Set([r.rel, r.realRel])) {
      if (rel === ".") continue;
      const denied = this.policy.check(rel);
      if (denied) return denied;
    }
    return null;
  }

  /**
   * realpath `candidate`; when it does not exist, realpath the deepest existing
   * ancestor and append the non-existent tail. Containment of the canonical
   * ancestor is verified at the final hop.
   */
  private async realpathWithinRoot(ws: WorkspaceEntry, candidate: string): Promise<string> {
    let current = candidate;
    const tail: string[] = [];
    for (let depth = 0; depth <= 64; depth++) {
      try {
        const real = await fs.realpath(current);
        if (!isInsideCanonical(real, ws.realRoot)) {
          throw new ToolError(
            "ACCESS_DENIED",
            `resolved path escapes workspace root (symlink or alias): ${JSON.stringify(toRel(ws.realRoot, candidate))}`
          );
        }
        if (tail.length) {
          // Deepest existing ancestor is inside the root, but the requested
          // leaf does not exist.
          throw new ToolError("NOT_FOUND", `path does not exist: ${JSON.stringify(toRel(ws.realRoot, candidate))}`);
        }
        return real;
      } catch (err) {
        if (err instanceof ToolError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ELOOP") {
          throw new ToolError("ACCESS_DENIED", "symlink loop detected");
        }
        if (code === "ENOTDIR") {
          throw new ToolError("NOT_FOUND", `path does not exist (a component is not a directory): ${JSON.stringify(toRel(ws.realRoot, candidate))}`);
        }
        if (code === "EACCES" || code === "EPERM") {
          throw new ToolError("ACCESS_DENIED", `permission denied resolving: ${JSON.stringify(toRel(ws.realRoot, candidate))}`);
        }
        if (code !== "ENOENT") {
          throw new ToolError("INTERNAL_ERROR", `path resolution failed: ${code ?? "fs-error"}`);
        }
        const parent = path.dirname(current);
        if (parent === current || !isInside(current, ws.realRoot)) {
          throw new ToolError("NOT_FOUND", `path does not exist: ${JSON.stringify(toRel(ws.realRoot, candidate))}`);
        }
        tail.push(path.basename(current));
        current = parent;
      }
    }
    throw new ToolError("INTERNAL_ERROR", "path resolution exceeded depth limit");
  }
}
