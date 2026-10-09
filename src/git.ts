import fs from "node:fs/promises";
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

// Repo-local .git/config is attacker-controlled content inside a workspace:
// `core.fsmonitor` runs a hook command on `git status`, and include/includeIf
// can chain further config. Aliases cannot shadow builtins (git ignores such
// aliases), so plumbing is safe by name. `-c` overrides neutralize
// command-execution keys where a boolean/constant value works; external diff
// drivers (`diff.external`, `diff.<drv>.command`) and textconv filters are
// disabled with `--no-ext-diff` / `--no-textconv` on diff-producing commands
// because an empty `-c` override still makes git try to exec "".
const GIT_SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.sshCommand=true",
  "-c",
  "core.gitProxy=true",
  "-c",
  "core.pager=cat",
  "-c",
  "color.ui=false",
  // Pin diff header prefixes so a hostile repo config cannot reshape
  // `diff --git` headers past the redaction parser.
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
  "-c",
  "diff.mnemonicPrefix=false",
];
const GIT_NO_EXT_DIFF = ["--no-ext-diff", "--no-textconv"];

export async function git(root: string, args: string[], opts: GitRunOpts) {
  return runBounded("git", [...GIT_SAFE_CONFIG, ...args], {
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

/**
 * Require `root` to BE the git toplevel. If a workspace is a subdirectory of
 * a larger repo, git would otherwise operate on the parent repo — exposing
 * files outside the authorized root through diffs, blobs and ls-files.
 */
export async function isRepoToplevel(root: string, opts: GitRunOpts): Promise<boolean> {
  const res = await git(root, ["rev-parse", "--show-toplevel"], opts);
  if (res.exitCode !== 0) return false;
  const toplevel = res.stdout.trim();
  if (!toplevel) return false;
  try {
    const realTop = await fs.realpath(toplevel);
    const realRoot = await fs.realpath(root);
    return realTop === realRoot;
  } catch {
    return false;
  }
}

/** Files for the search universe: tracked + untracked-but-not-ignored.
 *  Throws when root isn't a repo toplevel so callers fall back to walking. */
export async function gitFileUniverse(root: string, env: Record<string, string>, timeoutMs: number): Promise<string[]> {
  const opts: GitRunOpts = { timeoutMs, maxBytes: 8_000_000 };
  if (!(await isRepoToplevel(root, opts))) throw new Error("not a git repo toplevel");
  const res = await runBounded("git", [...GIT_SAFE_CONFIG, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    timeoutMs,
    maxOutputBytes: 8_000_000,
    env,
  });
  if (res.exitCode !== 0) throw new Error("not a git repo");
  return res.stdout.split("\0").filter(Boolean);
}

/** Strip absolute root paths from subprocess stderr before surfacing it. */
function cleanErr(root: string, s: string): string {
  return s.split(root).join("<root>").slice(0, 300);
}

const STAGED_KINDS = new Set(["M", "A", "D", "T", "R", "C"]);

/** `repo:false` = root is not a git toplevel (non-repo, or nested inside a
 *  parent repo). `clean` is null when the listing was truncated. */
export type GitStatusResult =
  | { repo: false; note: string }
  | {
      repo: true;
      complete: boolean;
      truncated: boolean;
      branch: string | null;
      detached: boolean;
      head: string;
      ahead: number;
      behind: number;
      clean: boolean | null;
      staged: string[];
      modified: string[];
      deleted: string[];
      renamed: { from: string; to: string }[];
      untracked: string[];
      conflicted: string[];
      counts: {
        staged: number;
        modified: number;
        deleted: number;
        renamed: number;
        untracked: number;
        conflicted: number;
      };
    };

/** Decode a C-quoted git path token (`"a/we\nird"` → `a/we<LF>ird`). */
function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const inner = s.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== "\\" || i + 1 >= inner.length) {
      out += c;
      continue;
    }
    const n = inner[++i]!;
    if (n >= "0" && n <= "7") {
      let oct = n;
      while (i + 1 < inner.length && oct.length < 3 && inner[i + 1]! >= "0" && inner[i + 1]! <= "7") {
        oct += inner[++i]!;
      }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else {
      const map: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        a: "\x07",
        b: "\b",
        f: "\f",
        v: "\v",
        "\\": "\\",
        '"': '"',
        "'": "'",
      };
      out += map[n] ?? n;
    }
  }
  return out;
}

/** Parse a quoted git token at the start of `s`; returns decoded value + rest. */
function parseQuotedToken(s: string): { value: string; rest: string } | null {
  if (!s.startsWith('"')) return null;
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"') {
      return { value: unquoteGitPath(s.slice(0, i + 1)), rest: s.slice(i + 1) };
    }
  }
  return null;
}

/**
 * Extract every plausible (a-path, b-path) pair from a `diff --git` header.
 * Unquoted headers are ambiguous when filenames contain ` b/` or ` "b/`
 * (git does not quote spaces); trying every candidate boundary is the
 * fail-safe direction — worst case is an over-redacted single file part.
 */
function diffHeaderCandidates(firstLine: string): { a: string; b: string }[] {
  const rest = firstLine.slice("diff --git ".length);
  const out: { a: string; b: string }[] = [];
  const pushB = (aPath: string, tail: string) => {
    let bTok = tail;
    if (tail.startsWith('"')) {
      const q = parseQuotedToken(tail);
      if (!q || q.rest.trim() !== "") return;
      bTok = q.value;
    }
    if (bTok.startsWith("b/")) out.push({ a: aPath, b: bTok.slice(2) });
  };
  if (rest.startsWith('"')) {
    const q = parseQuotedToken(rest);
    if (q && q.rest.startsWith(" ")) pushB(q.value.startsWith("a/") ? q.value.slice(2) : q.value, q.rest.slice(1));
    return out;
  }
  if (!rest.startsWith("a/")) return out;
  for (let i = 2; i < rest.length; i++) {
    if (rest[i] !== " ") continue;
    const tail = rest.slice(i + 1);
    if (tail.startsWith("b/") || tail.startsWith('"')) pushB(rest.slice(2, i), tail);
  }
  return out;
}

const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d:/;

/** True when a buffer's early bytes carry private-key material — the
 *  name-independent deny layer (a key file renamed `notes.txt` must not
 *  become readable just because its name evades the policy). */
export function hasPrivateKeyMaterial(text: string): boolean {
  return PRIVATE_KEY_MARKER.test(text);
}

/** Redact any lines carrying private-key markers — defense in depth for
 *  diff/show/search output where a denied-name file's content can appear
 *  under a benign filename. */
export function redactSecretMarkers(text: string): string {
  return text
    .split("\n")
    .map((l) => (PRIVATE_KEY_MARKER.test(l) ? "[redacted: private-key marker]" : l))
    .join("\n");
}

/**
 * Redact patch hunks for policy-denied paths from diff-format output. A
 * tracked `.env` (or a `:(glob)` pathspec naming one) must not leak contents
 * through git_diff/git_show just because fs_read denies it. BOTH sides of the
 * `diff --git` pair are checked: a detected rename `a/.env b/safe.txt` would
 * otherwise emit the denied file's hunks under the benign destination name.
 * An unparseable header is redacted (fail closed).
 */
export function redactDiff(diff: string, policy: DenyPolicy): string {
  return diff
    .split(/(?=^diff --git )/m)
    .map((part) => {
      if (!part.startsWith("diff --git ")) return part;
      const firstLine = part.split("\n", 1)[0]!;
      const candidates = diffHeaderCandidates(firstLine);
      let reason: string | null = null;
      if (candidates.length === 0) {
        reason = "unparseable-diff-header";
      } else {
        for (const c of candidates) {
          reason = policy.check(c.a) ?? policy.check(c.b);
          if (reason) break;
        }
      }
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

  private async repoOrNull(root: string): Promise<boolean> {
    return isRepoToplevel(root, this.opts());
  }

  async status(root: string): Promise<GitStatusResult> {
    if (!(await this.repoOrNull(root))) {
      return { repo: false, note: "not a git repository toplevel" };
    }
    const res = await git(
      root,
      ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z", "--end-of-options"],
      this.opts()
    );
    if (res.exitCode !== 0) throw new ToolError("INTERNAL_ERROR", `git status failed: ${cleanErr(root, res.stderr)}`);

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
      complete: !res.truncated,
      truncated: res.truncated,
      branch: branch === "(detached)" ? null : branch,
      detached: !branch || branch === "(detached)",
      head: oid === "(initial)" ? "(unborn)" : oid,
      ahead,
      behind,
      clean: res.truncated ? null : clean,
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
    if (!(await this.repoOrNull(root))) return { repo: false, note: "not a git repository toplevel" };
    const args = ["diff", ...GIT_NO_EXT_DIFF];
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
    if (res.exitCode !== 0) throw new ToolError("INVALID_ARGUMENT", `git diff failed: ${cleanErr(root, res.stderr)}`);
    let out = this.policy ? redactDiff(res.stdout, this.policy) : res.stdout;
    out = redactSecretMarkers(out);
    return { repo: true, diff: out, truncated: res.truncated, bytes: out.length };
  }

  async log(root: string, opts: { limit?: number; ref?: string }) {
    if (!(await this.repoOrNull(root))) return { repo: false, note: "not a git repository toplevel" };
    const n = Math.min(Math.max(1, opts.limit ?? 20), 100);
    const format = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";
    const args = ["log", `--format=${format}`, "-n", `${n}`, "--end-of-options"];
    if (opts.ref) args.push(assertRef(opts.ref));
    const res = await git(root, args, this.opts());
    if (res.exitCode !== 0) throw new ToolError("INVALID_ARGUMENT", `git log failed: ${cleanErr(root, res.stderr)}`);
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
    if (!(await this.repoOrNull(root))) return { repo: false, note: "not a git repository toplevel" };
    const { path: objPath } = splitRevPath(spec);
    // Defense in depth: the server layer denies objPath too, but a historical
    // blob of a denied file must be refused here as well.
    if (objPath && this.policy) {
      const reason = this.policy.check(objPath);
      if (reason) throw new ToolError("ACCESS_DENIED", `path denied by policy (${reason})`);
    }
    const args = objPath
      ? ["show", ...GIT_NO_EXT_DIFF, "--end-of-options", spec]
      : [
          "show",
          ...GIT_NO_EXT_DIFF,
          "--format=commit:%H%nshort:%h%nauthor:%an <%ae>%ndate:%aI%nsubject:%s%n---",
          "--stat",
          "--end-of-options",
          spec,
        ];
    const res = await git(root, args, this.opts(maxBytes));
    if (res.exitCode !== 0) throw new ToolError("INVALID_ARGUMENT", `git show failed: ${cleanErr(root, res.stderr)}`);
    let out = this.policy ? redactDiff(res.stdout, this.policy) : res.stdout;
    if (objPath && hasPrivateKeyMaterial(out)) {
      throw new ToolError("ACCESS_DENIED", "blob contains private-key material (content-class refusal)");
    }
    out = redactSecretMarkers(out);
    return { repo: true, spec, output: out, truncated: res.truncated };
  }

  async branches(root: string) {
    if (!(await this.repoOrNull(root))) return { repo: false, note: "not a git repository toplevel" };
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
