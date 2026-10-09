# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased] — corporate-readiness candidate

### Security (adversarial review round 2026-10-09, `tests/adversarial.test.ts`)

- **Fixed HIGH** — `git_diff`/`git_show` leaked denied-file content through
  detected renames (`a/.env` → `b/safe.ts`): `redactDiff` now checks both
  sides of every `diff --git` header candidate and fails closed on
  unparseable headers.
- **Fixed HIGH** — `fs_search_content` parsed ripgrep's `path:line:text`
  output with a delimiter regex; a directory named `x:1:y` let denied-file
  matches leak under a misattributed path, and newline-containing filenames
  broke attribution entirely. Now uses `rg --json` structured output.
- **Fixed MED** — filesystem permission errors surfaced raw errno messages
  containing absolute host paths; all fs errors now map to bounded
  rel-path `ToolError`s, and rg/git stderr is scrubbed of the root path.
- **Fixed MED** — the audit log followed a symlinked log path (an
  attacker-in-root append primitive); now refuses to write through symlinks.
- **Fixed MED** — private-key material under a benign filename was readable;
  content-level `BEGIN … PRIVATE KEY` markers are now refused in `fs_read`,
  `git_show` blob output, and search previews, and redacted in diffs.
- **Fixed LOW** — missing config produced raw `ENOENT`; now an actionable
  `CONFIG_ERROR` pointing at `init-config`.
- **Fixed LOW** — `fs_stat`'s `viaSymlink` was always false (reported
  resolved path only); the lexical relative path is now preserved.
- **Fixed LOW** — `walkUniverse` descended denied directories; operator deny
  globs were never validated (a malformed glob silently never matched);
  both fixed.
- **Fixed** — `git_show` of a historical denied blob (`HEAD:.env.tracked`)
  is now denied at the `GitOps` layer too (defense in depth; the server
  layer already denied it).
- **Deps** — `minimatch` 10.0.3 → 10.2.6 (three HIGH ReDoS advisories,
  reachable via caller-supplied search globs); `vitest` 3.2.4 → 4.1.11
  (dev-only advisories). `pnpm audit` is clean.
- Git subprocess config now pins diff prefixes and disables `core.fsmonitor`,
  external diff drivers, and textconv against hostile repo config.

Independent clean-context review round 2 (all remediated + regressed):

- **Fixed HIGH** — `git_show` accepted a bare blob/tree SHA, bypassing every
  path-based deny (a hostile repo author knows blob SHAs offline). Bare specs
  are now type-gated via `git cat-file -t`: only commit/tag displayable.
- **Fixed MED** — merge-conflict `diff --cc`/`diff --combined` blocks evaded
  `redactDiff` (which only split on `diff --git`). All `diff --*` headers are
  now path-checked and unparseable forms fail closed.
- **Fixed MED** — the private-key sniff covered only a file's first 8 KiB;
  padded key files leaked. Now a whole-file streamed scan in `fs_read` and
  `fs_search_content`.
- **Fixed MED** — key-marker redaction masked only the `BEGIN` line while
  base64 body lines leaked; a marker anywhere in a diff part now suppresses
  the whole part.
- **Fixed MED** — `task_run` env lacked git hardening: an allowlisted task
  invoking `git` ran with live hostile `.git/config` (`core.fsmonitor` →
  exec). Tasks now inherit the full `GIT_*` isolation set and operator env
  extras can't set `GIT_*`/interpreter/shell-hook variables.
- **Fixed LOW** — config symlink and group/world-writable config directory
  refused; audit log refuses symlinked parent components; `wsPath` and
  `paths[]` bounded at the schema layer; glob validation catches unbalanced
  extglob parens and dangling escapes; stderr scrubbing is case-insensitive
  over configured+canonical roots; SSH2-format key markers detected.

Verification pass on the round-2 fixes (all remediated + regressed):

- **Fixed HIGH** — annotated tags pointing at blobs/trees peeled through the
  object-type gate (`git show <tag>` displays the target). The gate now
  checks the peeled type: `spec^{}` must resolve to `commit`.
- **Fixed MED** — task env git hardening was nominal only: no env var
  disables repo-local config, so `core.fsmonitor`-style exec keys in
  `.git/config` stayed live inside tasks. `GIT_CONFIG_{COUNT,KEY,VALUE}`
  command-scope overrides now pin the dangerous keys plus
  `core.hooksPath=/dev/null` (repo hooks inert inside tasks); dynamically
  proven — an fsmonitor hook in fixture `.git/config` does not fire under
  `task_run`.
- **Fixed MED** — the whole-file key scan in `fs_search_content` was
  unbounded (N large files → unbounded IO per call). Now capped per-file
  (maxReadFileBytes) and per-call (64 unique files).
- **Fixed LOW** — `otherDiffPaths` path-collection line cap removed (scan to
  first `@@`); config error message clarifies symlink/dir causes.

### Added

- `tests/adversarial.test.ts`: 33-case adversarial suite covering
  containment, diff/search content leaks, execution boundaries, config
  fail-closed behavior, audit integrity, and stdio protocol purity.
- `SECURITY.md`, `CONTRIBUTING.md`, this changelog.
- Threat-model rows and findings ledger in `docs/THREAT-MODEL.md`.

## [0.1.0] — 2026-10-05

Initial private version: 14 read-oriented tools (bounded fs, git, and
allowlisted named-task execution) over operator-authorized roots; stdio
transport; metadata-only audit; deterministic `doctor` diagnostics.
