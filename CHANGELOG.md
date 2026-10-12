# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-10-11

### Added — multimodal file access (9 new tools, 23 total)

Design + acceptance matrix: `docs/MULTIMODAL-SPEC.md`. All new tools are
read-only, workspace-contained, deny-policy-enforced, and byte-capped.

- `fs_inspect` — magic-byte kind detection (image/zip/ooxml/pdf/text/binary),
  mime, size, sha256, image dims, archive member counts, `openWith` hints.
- `fs_image` — native MCP `image` block; original bytes served
  byte-identical when within caps; `frame` (animated), `fitMaxDim`,
  `format` transforms are explicit and disclosed via `transform:{…}`;
  git `headSha` provenance when the workspace is a repo toplevel.
  SVG rasterized only after a strict external-reference scan.
- `fs_contact_sheet` — labeled montage of ≤`contactSheetMaxItems` images
  (explicit `paths` or `directory`+`glob`), per-item authorization and
  per-item failure cells, one bounded PNG/JPEG block + layout map.
- `fs_archive_list` / `fs_archive_entry` — ZIP member enumeration (sizes,
  ratio, encrypted, denied/unsafe flags) and single-member preview through
  the same image/text pipeline. Traversal, symlink, encrypted, nested-archive
  members fail closed; streamed decompression under a hard byte counter.
- `fs_pdf_info` / `fs_pdf_page` / `fs_pdf_text` — PDF via PDFium compiled to
  WASM (memory-sandboxed, no JS execution, no remote fetch): page count and
  text-layer presence, ≤`pdfMaxPagesRender` rendered page images/call,
  ≤`pdfMaxPagesText` pages of bounded text/call.
- `fs_office_text` — OOXML text extraction (docx paragraphs, pptx slides,
  xlsx cells incl. shared-strings) through the ZIP layer; macros flagged,
  never executed; external relationships never followed; legacy OLE refused.
- New `limits.*` config keys (all schema-bounded): `maxMediaFileBytes`,
  `maxImagePixels`, `maxImageOutputBytes`, `mediaConcurrency`,
  `contactSheetMaxItems`, `archiveMaxMembers`, `archiveMaxEntryBytes`,
  `archiveMaxRatio`, `pdfMaxPagesRender`, `pdfMaxPagesText`,
  `pdfMaxRenderPixels`, `mediaTimeoutMs`.
- Error code `UNSUPPORTED_FORMAT` for kind-mismatch routing.
- Deps: `sharp@0.35.5`, `image-size@2.0.4`, `yauzl@3.4.0`,
  `@hyzyla/pdfium@2.1.13` (3.0.0 refused by minimum-release-age);
  dev: `yazl`, `@types/yauzl`, `@types/yazl`.
- `tests/media.test.ts` — 71-case acceptance suite (P1–P31 matrix incl.
  traversal/bomb/armor/denied-member negatives and 27 independent-review
  regression cases).
- `capabilities.tools.listChanged` advertised and
  `notifications/tools/list_changed` emitted once after initialization.
- Host-compatibility note: `image` blocks are spec-native; MCP Inspector
  and stdio clients render them — every image tool also returns text +
  `structuredContent` metadata so no information is silently lost if a
  host drops image blocks. **ChatGPT status: verified (2026-10-11)** —
  live connector exposed all 23 tools after a connector re-save and the
  model visually interpreted the synthetic `fs_image` canary.
- Brand assets: `assets/local-workspace-mcp-icon-{512,128}.png` (approved
  dark-navy icon); `server.json` carries registry `icons` metadata.

### Security — independent review rounds (see `docs/THREAT-MODEL.md` ledger)

Three clean-context review rounds on exact SHAs; every demonstrated finding
fixed with a permanent regression test:

- **HIGH** — nested `data:image/svg+xml` payloads bypassed the SVG
  external-reference scan (inner doc could carry `file://` hrefs); raster-only
  data-URI allowlist.
- **HIGH** — quoted-whitespace and CSS-escaped `url()`/`@import` spellings
  evaded the same scan; extended again in rounds 2–3 to the full CSS escape
  grammar, XML-entity decode, `xml:base`, external DOCTYPEs, SMIL value
  attributes, unterminated tokens, and multi-arg function nesting.
- **MED** — transform outputs lacked `sourceSha256`/`returnedSha256`;
  extracted PDF/Office text skipped the armor scan; duplicate ZIP member
  names desynced validation vs decompression; a timeout could release a
  decode slot while native work continued (shared media semaphore now held
  until work settles); PuTTY-format keys evaded size-gated armor checks.
- **LOW** — trailing-space member deny bypass, `dir/` misclassification,
  forced-format fast path, missing enumeration deadline, invalid page
  ranges, provenance git fan-out outside the semaphore, PDF text loop
  deadlines, SVG declared dims, sheet-encode budget, hostile-filename labels,
  and cross-boundary armor-marker splits.
- Whole-file key armor now also matches PuTTY `.ppk` markers and
  whitespace-collapsed spellings across line/page/section boundaries.
- **MED** — a mid-word armor split (`PRIVAT\nE KEY`) evaded every
  private-key scan surface (release-assurance red team) → zero-collapse
  (`PRIVATEKEY`) pass everywhere, a rolling scan window in the streaming
  reader, and a diff hunk de-prefix pass.
- **MED** — `task_run` could stall past its timeout when a detached
  grandchild held the stdio pipes open → pipe ends destroyed on kill and
  the call settles on `exit`.
- **LOW-MED** — suffix-anchored deny rules evaded by trailing whitespace/
  control chars (`.env `, `HEAD:.env\t` — git object paths can spell names
  fs paths can't) → trimmed-spelling deny check in `DenyPolicy`.
- **LOW** — `\x1e`/`\x1f` in commit subjects could forge `git_log` records
  → NUL separators + field sanitization; `task_run` output now gets the
  same `<root>` path scrub as git/rg; `fs_office_text` reports
  `sectionsFailed`; prototype-key task ids (`constructor`) fail closed as
  `TASK_DENIED`.
- Robustness: cumulative call deadlines for `fs_contact_sheet` (3×
  `mediaTimeoutMs`) and `fs_pdf_page` (2×); `gitFileUniverse` falls back to
  the honest directory walk on truncated `ls-files`; a failed PDFium init
  no longer bricks subsequent calls; platform declared POSIX-only
  (`os` field + `doctor` platform check).

## [0.1.0] — 2026-10-09

First public release, under MIT. The entries below are the cumulative
corporate-readiness remediations shipped in 0.1.0 over the private
baseline recorded at the bottom of this file.

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

### Private baseline — 2026-10-05

Initial private version: 14 read-oriented tools (bounded fs, git, and
allowlisted named-task execution) over operator-authorized roots; stdio
transport; metadata-only audit; deterministic `doctor` diagnostics.
