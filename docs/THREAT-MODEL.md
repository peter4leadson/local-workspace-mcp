# Threat model — local-workspace-mcp v1

**Contents:** [Assets](#assets) · [Trust boundaries](#trust-boundaries) ·
[Mitigations](#mitigations-by-threat-class-owasp-mcp-informed) ·
[Findings ledger](#adversarial-findings-ledger-2026-10-09-round-all-remediated--regressed) ·
[Residual risks](#residual-risks-accepted-documented) ·
[Failure policy](#failure-policy)

Frame: AI hosts (Claude Code/Desktop, ChatGPT via OpenAI Secure MCP Tunnel,
Codex) call this server over per-process stdio. Repositories under authorized
roots are **adversarial data**: contents may contain prompt injection and
deceptive filenames. The MCP client is semi-trusted; the operator-controlled
config is trusted; everything reachable under a root is untrusted data.

## Assets

1. Confidentiality of files outside authorized roots (`~/.ssh`, `~/.aws`,
   keychain, other repos, OS).
2. Confidentiality of sensitive files inside roots (`.env`, keys, creds).
3. Integrity of the host (no code execution beyond allowlisted argv tasks).
4. Availability of the machine (bounded CPU/IO/memory per call).
5. Integrity of operator policy (the operator keeps config/policy outside
   watched roots; the server does not verify the config's location).

## Trust boundaries

- Host process ↔ server process: JSON-RPC over stdio; no other IPC.
- Server ↔ filesystem: only canonical paths proven inside canonical roots.
- Server ↔ subprocesses: `git`, `rg`, and configured task argv only.
- Server ↔ tunnel-client ↔ OpenAI control plane (when ChatGPT attached):
  outbound HTTPS only, credentials held by tunnel-client, not this server.

## Mitigations by threat class (OWASP MCP-informed)

| Threat                                                      | Control                                                                                                                                                                                                                      | Proof                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Path traversal `../`                                        | lexical containment vs realRoot pre-realpath; absolute inputs must be in-root                                                                                                                                                | `paths.test.ts` traversal cases |
| Symlink escape                                              | `realpathWithinRoot` resolves target or deepest existing ancestor; containment re-verified on canonical path; ELOOP rejected                                                                                                 | symlink fixture tests           |
| Mid-path symlink ancestor                                   | ancestor-walk resolves each component chain                                                                                                                                                                                  | `link-out/pwned.txt` test       |
| Case tricks (APFS)                                          | two gates: `isInside` (lexical, case-insensitive) then `isInsideCanonical` (realpath, case-sensitive); realpath returns on-disk case                                                                                         | case-variant test               |
| Encoded traversal `%2e%2e`                                  | treated as literal name → NOT_FOUND; never decoded into separators                                                                                                                                                           | encoded test                    |
| `~` home expansion                                          | rejected outright (`ACCESS_DENIED`)                                                                                                                                                                                          | test                            |
| NUL/control chars, Windows drives                           | input hygiene rejections                                                                                                                                                                                                     | tests                           |
| Sensitive files                                             | deny policy on canonical relative path + basename, `..`-normalized (covers in-root symlink → `.env` and `a/../.env` spellings); explicit template allowlist                                                                  | `policy.test.ts`                |
| Sensitive file renamed to benign name                       | whole-file streamed scan for `BEGIN … PRIVATE KEY` markers — refused in fs_read/git_show blobs/search previews regardless of filename                                                                                        | adversarial CONTENT tests       |
| Rename-laundered diff (`a/.env` → `b/safe.ts`)              | `redactDiff` checks BOTH sides of every `diff --git` header candidate; unparseable headers redact (fail closed)                                                                                                              | adversarial rename test         |
| Merge-conflict combined diffs (`diff --cc`/`--combined`)    | non-`--git` diff headers path-checked via `---/+++` lines; unknown `diff --*` forms redact                                                                                                                                   | adversarial merge test          |
| Bare object-SHA read (`git show <blob-sha>`)                | `cat-file -t` type gate: bare specs must resolve to commit/tag; blob access only via policy-checked `rev:path`                                                                                                               | adversarial SHA test            |
| Hostile `.git/config` inside allowlisted tasks              | `GIT_CONFIG_{COUNT,KEY,VALUE}` command-scope pins override repo-local exec keys (env vars alone can't — see NF-2); operator env can't set `GIT_*`                                                                            | adversarial env test            |
| Search attribution spoofing (`x:1:y/` dirs, newline names)  | `rg --json` structured output; no `path:line:text` parsing; denied files emit no records                                                                                                                                     | adversarial RG-PARSE tests      |
| Absolute-path leak via errors                               | `mapFsError` converts errno failures to bounded rel-path `ToolError`s; rg/git stderr scrubbed of workspace roots (case-insensitive, configured+canonical)                                                                    | adversarial error tests         |
| Symlinked audit path → arbitrary append                     | `lstat` refuse-before-append on the audit file AND every parent directory component                                                                                                                                          | adversarial audit test          |
| Malformed operator deny glob silently dead                  | structural bracket-balance validation at `DenyPolicy` construction — load fails closed                                                                                                                                       | adversarial config test         |
| Config trust-root tampering                                 | group/world-writable config refused (`mode & 0o022`); missing config → actionable `CONFIG_ERROR`                                                                                                                             | adversarial config tests        |
| Private-key material in history                             | `git show rev:path` denies policy-matching blob paths AND refuses key-material blobs                                                                                                                                         | adversarial show test           |
| `.git` internals                                            | `.git/**` denied — protects credentialed remote config & object store                                                                                                                                                        | test + smoke                    |
| Option injection into git                                   | strict ref allowlist + `--end-of-options` + `--` path separator + argv spawn                                                                                                                                                 | ref-validation tests            |
| Shell injection                                             | no shell anywhere (`spawn` argv, `shell:false`); task ids validated; task argv is operator-fixed                                                                                                                             | task tests                      |
| Confused deputy                                             | caller picks workspace id + task id only; command text never crosses the boundary                                                                                                                                            | TASK_DENIED tests               |
| Env/secret leakage                                          | subprocess env = sanitized allowlist (PATH/HOME/…); `GIT_TERMINAL_PROMPT=0`; task `env` rejects key/secret/token-named vars                                                                                                  | `env-dump` test                 |
| Resource exhaustion                                         | caps everywhere: read bytes/lines, list entries, search results+deadline (rg), readMany totals, git output, task output+timeout, file-size limit                                                                             | limit tests                     |
| Large-output context flood                                  | structured `truncated`/`nextStartLine`/`nextOffset` metadata                                                                                                                                                                 | tests                           |
| ReDoS                                                       | content search delegated to ripgrep (linear-time engine); caller glob length caps (300 chars `fs_search_files`, 200 `fs_search_content`); minimatch ≥10.2.3 (CVE fix)                                                        | adversarial S-10 + dep pin      |
| Binary dump                                                 | NUL-probe → BINARY_FILE refusal                                                                                                                                                                                              | test                            |
| Malicious repo content                                      | files are data; they cannot alter roots/deny/tasks — those live in operator config                                                                                                                                           | INJECTION.txt test              |
| Tool-scope creep                                            | V1 has no write/edit/delete tools and no arbitrary-command exec; `task_run` (allowlisted argv only) is marked non-readOnly                                                                                                   | annotation checks               |
| Secrets in logs                                             | audit = JSONL metadata only (no contents, no env, no absolute host paths: caller-supplied absolute targets are relativized to the root or masked to `<abs>/<basename>`)                                                      | code review + test              |
| Image decompression bomb                                    | header dims checked before decode; `sharp` `limitInputPixels` cap; whole-file byte cap before decode; decode under a concurrency semaphore + wall-clock deadline                                                             | media N8/N28 tests              |
| SVG external-resource smuggling (`<image href=file://…>`)   | scan runs after XML-entity + full CSS-escape decode; refuses script/foreignObject/ENTITY/DOCTYPE/xml:base/xml-stylesheet/@import and any `href`/`url()`/`image()` that is not `#id` or a raster `data:` before rasterization | media N10 + review-2\* tests    |
| Zip Slip (`../`, absolute, backslash member names)          | member names normalized + traversal-segment refusal at our layer AND yauzl central-dir validation; unsafe members flagged and unreachable for preview                                                                        | media N13/N14 tests             |
| Zip bomb (ratio / huge expand)                              | declared ratio flag + refusal; streamed decompression under hard byte counter — declared sizes never trusted                                                                                                                 | media N18 test                  |
| Zip symlink/special/encrypted/nested members                | unix-mode type check refuses non-regular members; encrypted refused; nested archives refused at preview                                                                                                                      | media N15/N20 tests             |
| Sensitive file inside archive (`.env`, `*.pem`, armor body) | every member name checked through the same `DenyPolicy`; decompressed bytes re-scanned for key armor                                                                                                                         | media N16/N17 tests             |
| Hostile PDF (malformed/encrypted/JS)                        | PDFium (Chromium parser) compiled to WASM — memory-sandboxed, no JS execution, no remote fetch; encrypted and malformed docs → bounded errors                                                                                | media N25 test                  |
| Macro-bearing OOXML                                         | macros detected + flagged; only `<w:t>`/`<a:t>`/shared-string text extracted; external relationships never followed; legacy OLE refused                                                                                      | media office tests              |
| Silent image alteration                                     | original bytes served byte-identical when within caps; any resize/frame/format change reported as `transform:{kind,detail}`                                                                                                  | media P1/P9/P10 tests           |
| Image-content exfiltration via base64 inflation             | `maxImageOutputBytes` cap on every returned image; over-cap originals require explicit `fitMaxDim` opt-in                                                                                                                    | media N28 test                  |
| Supply chain                                                | pinned exact versions + committed lockfile; 3 runtime deps                                                                                                                                                                   | package.json/pnpm-lock          |
| Public exposure                                             | stdio only; no inbound network listener; tunnel client is outbound-only (optional loopback health listener only)                                                                                                             | architecture                    |

## Adversarial findings ledger (2026-10-09 round, all remediated + regressed)

RED-first adversarial suite (`tests/adversarial.test.ts`, 33 cases) reproduced
the following against `b87b0a3`; all closed in `d3e0db2` + `bdbdb28`:

| ID   | Sev            | Finding → Fix                                                                                                               |
| ---- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| S-1  | HIGH           | `redactDiff` checked only the `b/` path → detected rename leaked denied hunks. Now both sides + fail-closed headers.        |
| S-2  | HIGH           | `path:line:text` rg parse broke on `:N:` dir names → denied content leaked under wrong path. Now `--json` structured parse. |
| S-3  | MED            | fs EACCES surfaced raw absolute host paths → `mapFsError` bounded errors.                                                   |
| S-4  | MED            | `AuditLog` followed symlinked log path → lstat refuse-before-append.                                                        |
| S-5  | MED            | renamed private keys readable → content-level key-marker refusal.                                                           |
| S-6  | LOW            | missing config → raw ENOENT → actionable CONFIG_ERROR.                                                                      |
| S-7  | LOW            | `viaSymlink` always false → `lexRel` preserved through resolution.                                                          |
| S-8  | LOW            | rg stderr could carry abs paths → scrubbed.                                                                                 |
| S-9  | LOW            | `walkUniverse` descended denied dirs; deny globs unvalidated → pruned + startup validation.                                 |
| S-10 | HIGH (supply)  | minimatch@10.0.3 → 3 ReDoS CVEs reachable via caller-supplied globs → pinned 10.2.6.                                        |
| S-11 | MED (dev-only) | vitest@3.2.4 → 5 advisories (3 critical, dev-only) → pinned 4.1.11; `pnpm audit` clean.                                     |

Independent clean-context review (second round) added:

| ID   | Sev  | Finding → Fix                                                                                                                   |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| F-1  | HIGH | `git show <blob-sha>` bypassed name-based denies → `cat-file -t` type gate: bare specs must be commit/tag.                      |
| F-2  | MED  | merge-conflict `diff --cc`/`--combined` evaded `redactDiff` → all `diff --*` headers path-checked, fail-closed.                 |
| F-3  | MED  | key sniff covered only first 8 KiB → whole-file streamed scan.                                                                  |
| F-4  | MED  | marker line redacted but key body lines passed → whole-part suppression.                                                        |
| F-5  | MED  | `task_run` env lacked `GIT_*` hardening → hostile `.git/config` inert under tasks.                                              |
| F-6  | MED  | `rev:path` `//`/`/./`/`..` spellings → normalized in `policy.check` + tested.                                                   |
| F-7  | LOW  | config symlink/dir perms unchecked → lstat refuse + dir `0o022` mask.                                                           |
| F-8  | LOW  | audit leaf-symlink check missed parent components → per-component lstat.                                                        |
| F-9  | LOW  | `wsPath`/`paths[]` unbounded in schema → `.max(4096)`.                                                                          |
| F-10 | LOW  | glob validation missed unbalanced extglob parens/trailing escape → tracked.                                                     |
| F-11 | LOW  | stderr scrub exact-string only → case-insensitive; configured+canonical roots for `rg` stderr, canonical root for `git` stderr. |
| F-12 | LOW  | task env blocklist gaps → `^GIT*`/`^PYTHON`/`^PERL`/`^RUBY`/shell-hook vars blocked.                                            |
| F-13 | LOW  | SSH2-format key markers missed → flexible-dash regex.                                                                           |

A follow-up verification pass on the F-round fixes added:

| ID   | Sev  | Finding → Fix                                                                                                                                                    |
| ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NF-1 | HIGH | annotated tag→blob peeled through the `cat-file -t` gate → gate now checks the PEELED type (`spec^{}` must be `commit`).                                         |
| NF-2 | MED  | env vars alone can't neutralize repo-local `.git/config` exec keys inside tasks → `GIT_CONFIG_{COUNT,KEY,VALUE}` command-scope overrides injected into task env. |
| NF-3 | MED  | unbounded whole-file scans in search → per-file `maxReadFileBytes` cap + 64-file-per-call budget (head sniff beyond).                                            |
| NF-4 | LOW  | UTF-16/encoding laundering can hide a marker from the byte-level scan → documented; marker detection is a heuristic boundary, not absolute.                      |
| NF-5 | LOW  | `otherDiffPaths` line cap → scans until first `@@` hunk marker.                                                                                                  |
| NF-6 | LOW  | config-symlink refusal may surprise dotfiles setups; `/tmp` configs refused by dir-perm check — documented behavior.                                             |

Independent media-layer review (2026-10-11, commit `2f192ff`):

| ID   | Sev  | Finding → Fix                                                                                                                                                                                    |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R-1  | HIGH | `data:image/svg+xml` nested docs bypassed the SVG external-ref scan — inner `file://` hrefs rasterized out-of-root files into returned pixels → data URIs now allowlist raster image MIMEs only. |
| R-2  | HIGH | whitespace inside quoted `url("…")` and CSS-escaped `@impo\72t` evaded the scan → CSS-escape decode pass + trimmed-quote capture + at-rule broadening.                                           |
| R-3  | MED  | transform metadata lacked `sourceSha256`/`returnedSha256` — spec contract breach → both hashes emitted on every re-encode.                                                                       |
| R-4  | MED  | extracted office/pdf text skipped the armor scan → `hasPrivateKeyMaterial` on every section/page before emission.                                                                                |
| R-5  | MED  | duplicate member names desynced validation vs decompression → second dup flagged `unsafe:duplicate-name`, first wins deterministically.                                                          |
| R-6  | MED  | semaphore released on deadline while native decode continued (zombie decodes) → deadline races `sem.run`, slot held until work settles; one shared semaphore.                                    |
| R-7  | LOW  | trailing-space member names evaded the deny check → trimmed spelling also checked.                                                                                                               |
| R-8  | LOW  | `dir/` members misclassified `file` after normalization → type computed on the raw name.                                                                                                         |
| R-9  | LOW  | `format` ignored when serving originals → excluded from the serve-original fast path.                                                                                                            |
| R-10 | LOW  | `fs_inspect` zip enumeration lacked the wall-clock deadline → wrapped; dead helpers removed.                                                                                                     |
| R-11 | LOW  | `endPage<startPage` silently returned empty → INVALID_ARGUMENT; `textProbePages` disclosed on `fs_pdf_info`.                                                                                     |

Remediation-verify pass on `3a81d09` (same reviewer, second round) added:

| ID   | Sev  | Finding → Fix                                                                                                                                                                                                                                                                                              |
| ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N-1  | HIGH | scan decoded only hex CSS escapes: `\`+non-hex escapes (`@\import`, `u\rl(`), XML numeric refs in style contexts (`url&#40;file:///x&#41;`), `xml:base`, and external DOCTYPEs still bypassed → full CSS escape grammar + one-pass XML entity decode before scanning; `xml:base` and external DTD refused. |
| N-2  | MED  | PuTTY `.ppk` markers under benign member names evaded the size-gated text scan and the byte scan → `bufferHasKeyMaterial` covers the PuTTY marker; `hasPrivateKeyMaterial` applied to all served member text regardless of size.                                                                           |
| N-3  | LOW  | provenance `headSha` spawned 3 git processes per image/pdf call outside the media semaphore → 2s per-root `headShaCached`.                                                                                                                                                                                 |
| N-4  | LOW  | pdf `getText` loops had no wall-clock bound → per-page deadline check under the shared semaphore; over-time ranges degrade to resumable truncation.                                                                                                                                                        |
| N-5  | LOW  | SVG declared dims unchecked pre-raster → explicit `sniffImage` dims check against `maxImagePixels`.                                                                                                                                                                                                        |
| N-6  | LOW  | contact-sheet composite encode ran outside the semaphore → wrapped in `sem.run`.                                                                                                                                                                                                                           |
| N-7  | LOW  | control chars in filenames produced invalid XML label refs → stripped before escaping.                                                                                                                                                                                                                     |
| N-8  | LOW  | armor markers split across page/section boundaries evaded per-unit checks → whitespace-collapse pass in `hasPrivateKeyMaterial` + newline and zero-separator joined checks.                                                                                                                                |
| N-9  | INFO | `sendToolListChanged` fires once per process — cosmetic for single-shot stdio; accepted.                                                                                                                                                                                                                   |
| N-10 | INFO | derived previews (contact sheet, pdf page) carry per-item/source hashes but not the `transform` block — spec clarified.                                                                                                                                                                                    |

Verification residuals on `7e98769` (all LOW/INFO; empirically inert on the
bundled rasterizer — sharp 0.35.5 ships librsvg 2.63.2 which loads no
external resources at all, so the scan is pure defense-in-depth in this
build) closed in the same pass:

| ID  | Sev  | Finding → Fix                                                                                                                                                                                  |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-1 | LOW  | unterminated `url(`/`image(` evaded the scan (CSS auto-closes at end-of-value) → leftover function-token check after the terminated-call scan.                                                 |
| V-2 | LOW  | `\`+CRLF line continuation diverged from XML's CRLF→LF normalization → input CRLF-normalized before decode.                                                                                    |
| V-3 | LOW  | SMIL `<set>/<animate>` carry URLs in `to=`/`from=`/`by=`/`values=` → scheme-or-absolute values refused.                                                                                        |
| V-4 | INFO | bare-string CSS image functions (`image-set`/`src`/`cross-fade`) unscan­ned → added to the ref-function scan.                                                                                  |
| V-5 | INFO | namespace-prefixed `<x:script>`/`<x:foreignObject>` evaded element checks → prefix-tolerant patterns.                                                                                          |
| V-6 | LOW  | pre-existing: `fsOps` line-level armor scan can miss markers split across lines beyond the sniff head (`fs_read`/`fs_search_content` path — unaffected by this diff) → tracked as a follow-up. |

A focused verify pass on the V-round commit added (all LOW, same
inert-on-bundled-librsvg posture):

| ID  | Sev  | Finding → Fix                                                                                                                                            |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | LOW  | a `#`-leading arg inside a multi-arg CSS fn could swallow a nested `url(file:///…)` → `(` excluded from the function-arg capture.                        |
| F-2 | LOW  | SMIL check missed relative IRIs (`to="../x"` resolves off the file: base) → segments containing `..`, `/`, `\`, or a scheme refused.                     |
| F-3 | LOW  | entity-encoded `\&#13;&#10;` continuations survived CRLF normalization → CSS continuation rule consumes `[\n\r\f]+`.                                     |
| F-4 | INFO | `\\host` UNC over-decoded to `\h` before the SMIL check → covered by the `\\`/`/`/`..` segment refusal.                                                  |
| F-5 | INFO | fail-closed false-positive surface (benign `src(foo)` text, quoted `image-set("a.png" 1x)` args refused) — accepted posture for a defense-in-depth scan. |

Release-assurance red-team round on `b4cc053` (hostile synthetic fixtures,
verified over both the module API and real `serve --stdio` wire path) — all
findings remediated and pinned by `tests/redteam-regressions.test.ts`:

| ID     | Sev     | Finding → Fix                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RT-1   | MED     | mid-word armor split (`PRIVAT\nE KEY`) evaded every private-key scan surface → zero-collapse pass (`PRIVATEKEY`) added to `hasPrivateKeyMaterial`/`bufferHasKeyMaterial`, each streamed line scanned joined to a rolling 128-char non-whitespace tail (a suffix-window check alone evicted markers deep in long lines), and a `+`/`-`/space de-prefix pass inside diff parts. |
| RT-2   | LOW-MED | suffix-anchored deny globs evaded by trailing whitespace/control chars (`.env `, `HEAD:.env\t` — git object paths spell names fs paths can't) → `DenyPolicy.check` also tests the trimmed spelling for _deny only_; allowlist applies to the literal spelling only.                                                                                                           |
| RT-3   | MED     | `task_run` stall past timeout: `close` waits on all stdio writers, and a detached grandchild holding inherited pipes survives the group kill → after kill, the server destroys its pipe ends and settles on `exit` (+5 s fallback).                                                                                                                                           |
| RT-4   | LOW     | `\x1e`/`\x1f` in commit subjects forged phantom `git_log` records → NUL separators (unforgeable in commit content) + field sanitization.                                                                                                                                                                                                                                      |
| INFO-5 | LOW     | `task_run` returned raw output while rg/git scrub root paths → stdout/stderr now get the same `<root>` scrub.                                                                                                                                                                                                                                                                 |
| INFO-6 | LOW     | `fs_office_text` silently dropped unextractable sections → `sectionsFailed` counter surfaced.                                                                                                                                                                                                                                                                                 |
| INFO-7 | LOW     | prototype-key task ids (`tasks:["constructor"]`) passed config validation then threw `INTERNAL_ERROR` → `Object.hasOwn` checks → `TASK_DENIED`.                                                                                                                                                                                                                               |

ATAM-mandated robustness items closed in the same pass: platform declared
POSIX-only (`package.json` `os` field + `doctor` platform check — Windows
group-kill/`/dev/null` semantics were silently partial); cumulative call
deadlines for `fs_contact_sheet` (3× `mediaTimeoutMs` budget) and
`fs_pdf_page` renders (2×); `gitFileUniverse` falls back to the honest
directory walk when `ls-files` output is truncated instead of returning a
silently partial universe; a rejected PDFium init is no longer cached
forever (next call retries).

## Launchd persistence subsystem (2026-10-12 delta)

Scope: `scripts/launchd/{install,reconcile,health-check,uninstall}.sh` and the
LaunchAgent `io.github.peter4leadson.local-workspace-mcp.tunnel`. This layer
supervises OpenAI's `tunnel-client runtimes connect` managed runtime; it does
not run the MCP server itself and adds no network surface.

Additional assets it touches:

- The tunnel **Runtime API key** (keychain item
  `tunnel-client-control-plane`, materialized once to a 0600 file under
  `~/Library/Application Support/tunnel-client/secrets/`).
- Runtime availability (agent must not churn restarts or fork daemons).
- Host integrity under the user's own uid (the agent runs as the user in
  `gui/$UID`; nothing here crosses a privilege boundary).

Boundary statements:

- The key never appears in the plist, agent environment, daemon argv, or
  logs — the profile carries a `file:` ref and reconcile re-asserts it via
  `--runtime-api-key file:…` on every connect so `connect` cannot drift it
  back to `env:` (which would expose the key in daemon argv).
- Secret materialization writes a tempfile then `mv -f` — a pre-planted
  symlink at the secret-file path is replaced, never followed (verified
  against a planted-symlink canary).
- `runtimes status … --json` is parsed with jq field extraction only; no
  JSON is eval'd or interpolated into commands.
- The mkdir lock serializes manual and launchd reconcile runs; a restart
  always `runtimes stop`s first and force-kills (SIGCONT→SIGKILL) a
  suspended/wedged daemon before any reconnect — a second process on the
  same tunnel id is never started.
- jq absence fails closed with a legible error before any action.
- `pgrep -f` patterns are anchored on the literal profile dir + profile
  name; no untrusted input reaches a regex or a command line.

Findings this round (self-review + live tests):

| Id  | Sev | Finding                                                                                                                                                   | Disposition                                                      |
| --- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| P-1 | Med | `security … -w > $SECRET_FILE` followed a pre-planted symlink — key written to an attacker-chosen path (demonstrated; canary clobbered with key material) | Fixed: tempfile + `mv -f` replaces the link; retested            |
| P-2 | Low | Missing jq produced a misleading "status produced no JSON" log every 60 s                                                                                 | Fixed: explicit jq preflight in reconcile.sh and health-check.sh |
| P-3 | Low | `uninstall.sh --stop-runtime` printed "stopped" even if a wedged daemon survived                                                                          | Fixed: post-stop pgrep check warns honestly                      |

Independent fresh-context review (2026-10-12) on the same scripts:

| Id  | Sev      | Finding                                                                                                  | Disposition                                                                                                           |
| --- | -------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| I-1 | High     | Binaries hardcoded to `$HOME/.local/bin` — fails preflight (or churns connects) on other install layouts | Fixed: `command -v` resolution + env overrides; agent PATH built from resolved tool dirs                              |
| I-2 | High     | Plist PATH assumed the installer's toolchain — unresolvable `env node` = infinite restart churn          | Fixed: install computes the agent PATH from resolved node/git/rg/workspace-mcp dirs and preflights each tool under it |
| I-3 | Med-High | `pgrep -fl` prints comm not argv on macOS — the "no API key in daemon argv" check could never fail       | Fixed: argv inspected via `ps -o command=` per pid                                                                    |
| I-4 | Med      | `stop_runtime` ran before connect prerequisites — a missing key file converted a limping runtime to dead | Fixed: `preflight_connect` validates key file + tunnel id before any stop                                             |
| I-5 | Med      | `stat` failure on the live lock yielded `mtime=0` — a false-stale takeover could split-brain             | Fixed: indeterminate age is not stale                                                                                 |
| I-6 | Low-Med  | The stdio probe had no deadline — a hung server could hang health-check                                  | Fixed: `signal.alarm(90)` inside the probe                                                                            |
| I-7 | Low      | Stale comment, prose off-by-one (tolerated checks), unconditional "stopped", `null` tunnel_id in output  | Fixed: comment/prose corrected, post-stop pgrep, `// empty`                                                           |
| I-8 | Low      | `/usr/bin/python3` and `${USER}` assumptions                                                             | Fixed: `command -v python3` preflight; `${USER:-$(id -un)}`                                                           |

Verification round (ECC `security-reviewer` spec, fresh-context seat,
REMEDIATION_VERIFY on `9ddcb20`): all prior findings confirmed FIXED
except I-1 and I-8, each partially — plus the delta findings below, all
remediated on `main` after `9fc96fc`:

| ID  | Severity | Finding                                                                                                                                                      | Disposition                                                                                    |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------- |
| N-1 | Low-Med  | Interpolated paths (`$AGENT_PATH`, `$RECONCILE`, `$LOG_DIR`) were embedded raw in plist XML — `&`/`<` in a tool dir produced a malformed plist (fail-closed) | Fixed: install.sh rejects `&`/`<` in interpolated paths before writing                         |
| N-2 | Low-Med  | `stop_runtime`'s failure was ignored at both call sites — `connect` could proceed while an unreaped daemon held the runtime lock                             | Fixed: `stop_runtime                                                                           |     | return 1`; the no-second-runtime invariant is now enforced in reconcile |
| N-3 | Low      | Predictable tempfile name (`tmp.$$`) for the key materialization; partial file could linger on failure                                                       | Fixed: `mktemp` + `trap` cleanup                                                               |
| N-4 | Low      | `uninstall.sh` hardcoded `~/.local/bin/tunnel-client` — on other layouts `--stop-runtime` never attempted the stop but warned as if it had                   | Fixed: `command -v` + `TUNNEL_CLIENT` override; unexecutable binary now warns "not attempted"  |
| N-5 | Low      | `health-check.sh` invoked literal `/usr/bin/python3`, ignoring the computed PATH                                                                             | Fixed: `command -v python3` with a `FAIL` preflight line                                       |
| N-6 | Low      | Install-time `AGENT_PATH` goes stale on toolchain upgrades; resolution-only preflight could pass a broken shim dir                                           | Fixed: `node --version` exec preflight + OPERATIONS.md "re-run install.sh after upgrades" note |
| N-7 | Info     | Appended caller `$PATH` could host a trojaned tool on hostile-PATH manual runs; unguarded `$PATH` aborted under `env -i`                                     | Fixed: `${PATH:-}` guard; PATH-squatting residual already scoped to same-uid attackers         |
| N-8 | Info     | `cat > "$PLIST"` followed a pre-planted symlink at the plist path (same-uid scope)                                                                           | Fixed: plist written via `mktemp` + `mv -f`, same pattern as the secret file                   |
| N-9 | Info     | `pnpm` resolved into `AGENT_PATH` but was absent from the verify loop — install could succeed with `task_run` broken                                         | Fixed: pnpm now preflighted under the agent PATH (warns, does not block)                       |

Residual risks specific to this layer (accepted):

- **PATH squatting.** The agent's PATH leads with user-writable
  `$HOME/.asdf/shims` and `$HOME/.local/bin` because `workspace-mcp` is a
  `#!/usr/bin/env node` launcher and needs node/git/rg/pnpm resolution.
  Another process already running as the same user could shadow a binary —
  but a same-uid attacker can already read the 0600 secret file and signal
  the daemon; this is not a privilege boundary, only a robustness note.
- **Same-uid attacker scope.** Everything the agent protects (key file,
  profile, logs) is already readable by the user's own processes. The
  layer's security value is _not adding_ exposure (no argv/env/plist
  secrets), not defending against the user account itself.
- **Repo relocation.** The plist pins the absolute `reconcile.sh` path;
  moving the repo breaks the agent until `install.sh` re-runs. Documented,
  not self-healing.
- **Stale-lock takeover window** (180 s) could split-brain a manual run
  against a wedged agent run — bounded by the second mkdir check and by
  `runtimes connect`'s own runtime lock.
- **`runtimes list` dependency.** Tunnel-id resolution needs the local
  alias record; if the record is lost the agent logs an error and stops —
  it will never guess or create a tunnel.

## Residual risks (accepted, documented)

1. **Hardlinks**: a hardlink inside a root to a sensitive file outside is
   indistinguishable by path. Creating one requires local write access to the
   root already — attacker-in-root is out of scope. Mitigation if needed:
   deny `st_nlink > 1` regular files (config flag, off by default).
2. **TOCTOU**: path is re-resolved per call; a symlink swapped between
   realpath and open could race. Local attacker racing MCP calls on the same
   uid is out of scope (they already have file access).
3. **Git worktrees**: `.git` file (not dir) in linked worktrees is denied by
   name; worktree `HEAD` data remains accessible via git tools — intended.
4. **File metadata leakage**: directory listings reveal names of denied files
   (flagged, not hidden) — deliberate trade-off for debuggability; contents
   and outside-root names are never exposed. `fs_search_files` similarly
   reports a `deniedFiltered` count (an existence oracle, not a content one);
   `fs_search_content` suppresses denied matches entirely so previews can
   never become a content oracle. Git surfaces are the same class: `git_status`
   reports `deniedPaths` names, and `git diff --stat`/bare-spec `--stat`
   output can list denied filenames; contents remain refused.
5. **Unicode NFC**: `realpath` returns canonical on-disk names; files whose
   names differ only by normalization resolve to the same canonical path —
   containment unaffected.
6. **Prompt injection via file content**: a README cannot widen policy, but a
   model may be told to read more files; the deny policy and root boundary
   remain the hard limit.
7. **Content-marker heuristics**: private-key detection matches armor markers
   (`BEGIN … PRIVATE KEY`, PuTTY) across raw, space-collapsed, and
   zero-collapsed spellings. It is not a general secret scanner — renamed
   AWS/GitHub-style tokens without armor (and a UTF-16/otherwise-encoded
   key) pass it; the byte-level scan only guarantees refusal of key armor.
   Marker detection is defense in depth, not the primary boundary —
   name/policy denies are.
8. **Task-side git config**: `GIT_CONFIG_*` env overrides neutralize the
   headline repo-config exec keys (`core.fsmonitor`, `core.sshCommand`,
   `diff.external`, `core.hooksPath=/dev/null` disables repo hooks, …) but
   cannot enumerate per-driver `diff.<name>.command`/`textconv`/`filter.<name>`
   hooks, and repo `.gitattributes` still applies them. A task that runs
   `git diff`/`checkout` in a hostile repo with a configured driver could
   still exec it — constrain task argv and prefer read-only, non-diff git
   commands in allowlisted tasks on untrusted repos.
9. **Search-scan budget**: beyond 64 unique files (or `maxReadFileBytes`
   per file — 5 MB default, 50 MB schema cap) in one `fs_search_content`
   call, files get head-only sniff + per-preview marker checks — a key
   buried deep in a large file beyond the budget could leak base64 lines
   lacking the marker. Bounded 240-char previews limit blast.
10. **Native raster decoding runs in-process**: sharp/libvips (and bundled
    librsvg for SVG) decode attacker-controlled bytes inside the
    trust-boundary process. Caps, the shared semaphore, and deadlines bound
    resources but not memory safety — a libvips decoder CVE could
    compromise the process holding access to all authorized roots. The SVG
    external-reference scan (`svgExternalRefReason`) is additionally a
    _scan, not a sandbox_: librsvg still parses adversarial XML, and SVG
    should be treated as permanently watchlisted. Process-isolated decode
    workers are the planned pre-1.0 mitigation; operators who accept no
    raster-decode exposure can keep SVG/deny lists or workspace scoping
    accordingly.
11. **Encrypted archive members are refused, not decrypted**: any member
    with the encryption bit set fails closed. Encrypted archives therefore
    expose member _names_ only — the same existence-oracle class as denied
    file listings.
12. **ChatGPT connector caching**: the connector layer may retain a frozen
    `tools/list` snapshot and may drop `image` content blocks entirely —
    every image tool therefore also returns full metadata as text +
    `structuredContent`. Host-side visual delivery is verified separately
    per host, never assumed from Inspector behavior.
13. **POSIX-only**: process-group kill semantics and `/dev/null` env pins
    have no Windows equivalent — the package declares `os: [darwin, linux]`
    and `doctor` reports `platform` explicitly rather than degrading
    silently. Windows support would need per-platform task-kill and
    git-isolation equivalents.

## Failure policy

Fail closed: every error path returns a bounded `CODE: message` result; the
server never emits file contents on an error path, never falls back to a
permissive mode, and `doctor` exits non-zero on any failed check.

---

See also: [README](../README.md) · [SECURITY.md](../SECURITY.md) · [docs/OPERATIONS.md](OPERATIONS.md)
