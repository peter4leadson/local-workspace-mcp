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

### Added

- `tests/adversarial.test.ts`: 23-case adversarial suite covering
  containment, diff/search content leaks, execution boundaries, config
  fail-closed behavior, audit integrity, and stdio protocol purity.
- `SECURITY.md`, `CONTRIBUTING.md`, this changelog.
- Threat-model rows and findings ledger in `docs/THREAT-MODEL.md`.

## [0.1.0] — 2026-10-05

Initial private version: 14 read-oriented tools (bounded fs, git, and
allowlisted named-task execution) over operator-authorized roots; stdio
transport; metadata-only audit; deterministic `doctor` diagnostics.
