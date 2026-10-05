import { runBounded, gitEnv } from "./exec.js";
import { ToolError } from "./paths.js";
import type { DenyPolicy } from "./policy.js";

/**
 * Git access rules:
 *  - argv arrays only; no shell interpolation anywhere;
 *  - user-supplied revs pass strict validation AND are placed after
 *    `--end-of-options` so they can never be parsed as git options;
 *  - user-supplied pathspecs go after `--`;
 *  - GIT_TERMINAL_PROMPT=0 + sanitized env; all ops are read-only plumbing.
 */

// Revs may contain ~ ^ / . @ - (needed for HEAD~2, feature/x, v1.2.3) but never
// start with '-', contain '..' ranges, reflog '@{' syntax, whitespace/control
// chars, or shell metacharacters. `--end-of-options` is the second layer.
const REF_OK = /^[A-Za-z0-9][A-Za-z0-9._/^~@-]{0,254}$/;
const REF_FORBIDDEN_SUBSTR = /\.\.|@\{|\.lock$|\/\/|\/$/;
const MAX_REF_LEN = 255;

export function assertRef(ref: string): string {
  if (!ref || ref.length > MAX_REF_LEN) throw new ToolError("INVALID_ARGUMENT", "ref missing or too long");
  if (!REF_OK.test(ref) || REF_FORBIDDEN_SUBSTR.test(ref)) {
    throw new ToolError("INVALID_ARGUMENT", `ref contains forbidden characters: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/** Split `rev:path` form; validates rev strictly and returns parts. */
export function splitRevPath(spec: string): { rev: string; path?: string } {
  const idx = spec.indexOf(":");
  if (idx === -1) return { rev: assertRef(spec) };
  const rev = spec.slice(0, idx);
  const p = spec.slice(idx + 1);
  assertRef(rev);
  if (p.includes("\0") || p.startsWith("/")) {
    throw new ToolError("INVALID_ARGUMENT", "invalid object path");
  }
  return { rev, path: p };
}

export interface GitRunOpts {
  timeoutMs: number;
  maxBytes: number;
}

export async function git(root: string, args: string[], opts: GitRunOpts) {
  return runBounded("git", args, {
    cwd: root,
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxBytes,
    env: gitEnv(),
  });
}

export async function isGitRepo(root: string, opts: GitRunOpts): Promise<boolean> {
  const res = await git(root, ["rev-parse", "--is-inside-work-tree"], opts);
  return res.exitCode === 0 && res.stdout.trim() === "true";
}

/** Files for the search universe: tracked + untracked-but-not-ignored. */
export async function gitFileUniverse(root: string, env: Record<string, string>, timeoutMs: number): Promise<string[]> {
  const res = await runBounded("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    timeoutMs,
    maxOutputBytes: 8_000_000,
    env,
  });
  if (res.exitCode !== 0) throw new Error("not a git repo");
  return res.stdout.split("\0").filter(Boolean);
}

const STAGED_KINDS = new Set(["M", "A", "D", "T", "R", "C"]);

/**
 * Redact patch hunks for policy-denied paths from diff-format output. A
 * tracked `.env` (or a `:(glob)` pathspec naming one) must not leak contents
 * through git_diff/git_show just because fs_read denies it. Header lines are
 * kept (filenames are visible, like fs_list flagging) but the body is
 * replaced with a bounded marker.
 */
export function redactDiff(diff: string, policy: DenyPolicy): string {
  return diff
    .split(/(?=^diff --git )/m)
    .map((part) => {
      if (!part.startsWith("diff --git ")) return part;
      const firstLine = part.split("\n", 1)[0]!;
      const m = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(firstLine);
      const bPath = m?.[2];
      const reason = bPath ? policy.check(bPath) : null;
      if (reason) {
        return `${firstLine}\n[denied-content: ${reason} — hunks suppressed by sensitive-file policy]\n`;
      }
      return part;
    })
    .join("");
}

export class GitOps {
  constructor(
    private readonly timeoutMs: number,
    private readonly maxBytes: number,
    private readonly policy?: DenyPolicy
  ) {}

  private opts(maxBytes?: number): GitRunOpts {
    return { timeoutMs: this.timeoutMs, maxBytes: maxBytes ?? this.maxBytes };
  }

  async status(root: string) {
    if (!(await isGitRepo(root, this.opts()))) {
      return { repo: false, note: "not a git repository" };
    }
    const res = await git(
      root,
      ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z", "--end-of-options"],
      this.opts()
    );
    if (res.exitCode !== 0) throw new ToolError("INTERNAL_ERROR", `git status failed: ${res.stderr.slice(0, 300)}`);

    let branch = "";
    let oid = "";
    let ahead = 0;
    let behind = 0;
    const staged: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const renamed: { from: string; to: string }[] = [];
    const untracked: string[] = [];
    const conflicted: string[] = [];

    const recs = res.stdout.split("\0");
    for (let i = 0; i < recs.length; i++) {
      const line = recs[i]!;
      if (line.startsWith("# branch.head ")) {
        branch = line.slice(14);
      } else if (line.startsWith("# branch.oid ")) {
        oid = line.slice(13);
      } else if (line.startsWith("# branch.ab ")) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      } else if (line.startsWith("1 ")) {
        const parts = line.split(" ");
        const xy = parts[1] ?? "";
        const p = parts.slice(8).join(" ");
        if (STAGED_KINDS.has(xy[0] ?? "")) staged.push(p);
        if (xy[1] === "M" || xy[1] === "T") modified.push(p);
        else if (xy[1] === "D") deleted.push(p);
      } else if (line.startsWith("2 ")) {
        // rename/copy: `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>`
        const parts = line.split(" ");
        const xy = parts[1] ?? "";
        const to = parts.slice(9).join(" ");
        const from = recs[++i] ?? "";
        renamed.push({ from, to });
        if (STAGED_KINDS.has(xy[0] ?? "")) staged.push(to);
        if (xy[1] === "M" || xy[1] === "T") modified.push(to);
        else if (xy[1] === "D") deleted.push(to);
      } else if (line.startsWith("u ")) {
        conflicted.push(line.split(" ").slice(10).join(" "));
      } else if (line.startsWith("? ")) {
        untracked.push(line.slice(2));
      }
    }

    const clean =
      staged.length + modified.length + deleted.length + renamed.length + untracked.length + conflicted.length === 0;
    return {
      repo: true,
      branch: branch === "(detached)" ? null : branch,
      detached: !branch || branch === "(detached)",
      head: oid === "(initial)" ? "(unborn)" : oid,
      ahead,
      behind,
      clean,
      staged,
      modified,
      deleted,
      renamed,
      untracked,
      conflicted,
      counts: {
        staged: staged.length,
        modified: modified.length,
        deleted: deleted.length,
        renamed: renamed.length,
        untracked: untracked.length,
        conflicted: conflicted.length,
      },
    };
  }

  async diff(
    root: string,
    opts: { staged?: boolean; base?: string; head?: string; paths?: string[]; stat?: boolean; maxBytes?: number }
  ) {
    const args = ["diff"];
    if (opts.stat) args.push("--stat");
    if (opts.staged) args.push("--cached");
    args.push("--end-of-options");
    if (opts.base) args.push(assertRef(opts.base));
    if (opts.head) {
      if (!opts.base) throw new ToolError("INVALID_ARGUMENT", "head requires base");
      args.push(assertRef(opts.head));
    }
    if (opts.paths?.length) {
      args.push("--", ...opts.paths.slice(0, 100));
    }
    const res = await git(root, args, this.opts(opts.maxBytes));
    if (res.exitCode !== 0) throw new ToolError("INVALID_ARGUMENT", `git diff failed: ${res.stderr.slice(0, 300)}`);
    const out = this.policy ? redactDiff(res.stdout, this.policy) : res.stdout;
    return { repo: true, diff: out, truncated: res.truncated, bytes: out.length };
  }

  async log(root: string, opts: { limit?: number; ref?: string }) {
    const n = Math.min(Math.max(1, opts.limit ?? 20), 100);
    const format = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";
    const args = ["log", `--format=${format}`, "-n", `${n}`, "--end-of-options"];
    if (opts.ref) args.push(assertRef(opts.ref));
    const res = await git(root, args, this.opts());
    if (res.exitCode !== 0) throw new ToolError("INVALID_ARGUMENT", `git log failed: ${res.stderr.slice(0, 300)}`);
    const commits = res.stdout
      .split("\x1e")
      .map((rec) => rec.trim())
      .filter(Boolean)
      .map((rec) => {
        const f = rec.split("\x1f");
        return { sha: f[0], short: f[1], author: f[2], email: f[3], date: f[4], subject: f[5] };
      });
    return { repo: true, commits, shown: commits.length, truncated: commits.length === n };
  }

  async show(root: string, spec: string, maxBytes?: number) {
    const { path: objPath } = splitRevPath(spec);
    const args = objPath
      ? ["show", "--end-of-options", spec]
      : ["show", "--format=commit:%H%nshort:%h%nauthor:%an <%ae>%ndate:%aI%nsubject:%s%n---", "--stat", "--end-of-options", spec];
    const res = await git(root, args, this.opts(maxBytes));
    if (res.exitCode !== 0) throw new ToolError("INVALID_ARGUMENT", `git show failed: ${res.stderr.slice(0, 300)}`);
    const out = this.policy ? redactDiff(res.stdout, this.policy) : res.stdout;
    return { repo: true, spec, output: out, truncated: res.truncated };
  }

  async branches(root: string) {
    const current = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], this.opts());
    const detached = current.stdout.trim() === "HEAD";
    const res = await git(
      root,
      ["branch", "--format=%(refname:short)\t%(objectname:short)\t%(upstream:short)\t%(HEAD)", "--list"],
      this.opts()
    );
    const branches = res.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, oid, upstream, head] = l.split("\t");
        return { name, head: oid, upstream: upstream || null, current: head === "*" };
      });
    const wt = await git(root, ["worktree", "list", "--porcelain"], this.opts());
    const worktrees = wt.stdout
      .split("\n\n")
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => {
        let branch = "";
        let head = "";
        let isDetached = false;
        for (const l of b.split("\n")) {
          if (l.startsWith("HEAD ")) head = l.slice(5);
          else if (l.startsWith("branch ")) branch = l.slice(7).replace(/^refs\/heads\//, "");
          else if (l === "detached") isDetached = true;
        }
        // Absolute worktree paths are host internals — report identity only.
        return { branch: branch || null, head, detached: isDetached };
      });
    return { repo: true, current: detached ? null : current.stdout.trim(), detached, branches, worktrees };
  }
}
