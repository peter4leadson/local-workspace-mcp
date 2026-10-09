# Threat model — local-workspace-mcp v1

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

| Threat                                                     | Control                                                                                                                                                               | Proof                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Path traversal `../`                                       | lexical containment vs realRoot pre-realpath; absolute inputs must be in-root                                                                                         | `paths.test.ts` traversal cases |
| Symlink escape                                             | `realpathWithinRoot` resolves target or deepest existing ancestor; containment re-verified on canonical path; ELOOP rejected                                          | symlink fixture tests           |
| Mid-path symlink ancestor                                  | ancestor-walk resolves each component chain                                                                                                                           | `link-out/pwned.txt` test       |
| Case tricks (APFS)                                         | two gates: `isInside` (lexical, case-insensitive) then `isInsideCanonical` (realpath, case-sensitive); realpath returns on-disk case                                  | case-variant test               |
| Encoded traversal `%2e%2e`                                 | treated as literal name → NOT_FOUND; never decoded into separators                                                                                                    | encoded test                    |
| `~` home expansion                                         | rejected outright (`ACCESS_DENIED`)                                                                                                                                   | test                            |
| NUL/control chars, Windows drives                          | input hygiene rejections                                                                                                                                              | tests                           |
| Sensitive files                                            | deny policy on canonical relative path + basename, `..`-normalized (covers in-root symlink → `.env` and `a/../.env` spellings); explicit template allowlist           | `policy.test.ts`                |
| Sensitive file renamed to benign name                      | whole-file streamed scan for `BEGIN … PRIVATE KEY` markers — refused in fs_read/git_show blobs/search previews regardless of filename                                 | adversarial CONTENT tests       |
| Rename-laundered diff (`a/.env` → `b/safe.ts`)             | `redactDiff` checks BOTH sides of every `diff --git` header candidate; unparseable headers redact (fail closed)                                                       | adversarial rename test         |
| Merge-conflict combined diffs (`diff --cc`/`--combined`)   | non-`--git` diff headers path-checked via `---/+++` lines; unknown `diff --*` forms redact                                                                            | adversarial merge test          |
| Bare object-SHA read (`git show <blob-sha>`)               | `cat-file -t` type gate: bare specs must resolve to commit/tag; blob access only via policy-checked `rev:path`                                                        | adversarial SHA test            |
| Hostile `.git/config` inside allowlisted tasks             | `GIT_CONFIG_{COUNT,KEY,VALUE}` command-scope pins override repo-local exec keys (env vars alone can't — see NF-2); operator env can't set `GIT_*`                     | adversarial env test            |
| Search attribution spoofing (`x:1:y/` dirs, newline names) | `rg --json` structured output; no `path:line:text` parsing; denied files emit no records                                                                              | adversarial RG-PARSE tests      |
| Absolute-path leak via errors                              | `mapFsError` converts errno failures to bounded rel-path `ToolError`s; rg/git stderr scrubbed of workspace roots (case-insensitive, configured+canonical)             | adversarial error tests         |
| Symlinked audit path → arbitrary append                    | `lstat` refuse-before-append on the audit file AND every parent directory component                                                                                   | adversarial audit test          |
| Malformed operator deny glob silently dead                 | structural bracket-balance validation at `DenyPolicy` construction — load fails closed                                                                                | adversarial config test         |
| Config trust-root tampering                                | group/world-writable config refused (`mode & 0o022`); missing config → actionable `CONFIG_ERROR`                                                                      | adversarial config tests        |
| Private-key material in history                            | `git show rev:path` denies policy-matching blob paths AND refuses key-material blobs                                                                                  | adversarial show test           |
| `.git` internals                                           | `.git/**` denied — protects credentialed remote config & object store                                                                                                 | test + smoke                    |
| Option injection into git                                  | strict ref allowlist + `--end-of-options` + `--` path separator + argv spawn                                                                                          | ref-validation tests            |
| Shell injection                                            | no shell anywhere (`spawn` argv, `shell:false`); task ids validated; task argv is operator-fixed                                                                      | task tests                      |
| Confused deputy                                            | caller picks workspace id + task id only; command text never crosses the boundary                                                                                     | TASK_DENIED tests               |
| Env/secret leakage                                         | subprocess env = sanitized allowlist (PATH/HOME/…); `GIT_TERMINAL_PROMPT=0`; task `env` rejects key/secret/token-named vars                                           | `env-dump` test                 |
| Resource exhaustion                                        | caps everywhere: read bytes/lines, list entries, search results+deadline (rg), readMany totals, git output, task output+timeout, file-size limit                      | limit tests                     |
| Large-output context flood                                 | structured `truncated`/`nextStartLine`/`nextOffset` metadata                                                                                                          | tests                           |
| ReDoS                                                      | content search delegated to ripgrep (linear-time engine); caller glob length caps (300 chars `fs_search_files`, 200 `fs_search_content`); minimatch ≥10.2.3 (CVE fix) | adversarial S-10 + dep pin      |
| Binary dump                                                | NUL-probe → BINARY_FILE refusal                                                                                                                                       | test                            |
| Malicious repo content                                     | files are data; they cannot alter roots/deny/tasks — those live in operator config                                                                                    | INJECTION.txt test              |
| Tool-scope creep                                           | V1 has no write/edit/delete tools and no arbitrary-command exec; `task_run` (allowlisted argv only) is marked non-readOnly                                            | annotation checks               |
| Secrets in logs                                            | audit = JSONL metadata only (no contents, no env, no server-resolved absolute paths; `target` echoes caller-supplied input as given)                                  | code review + test              |
| Supply chain                                               | pinned exact versions + committed lockfile; 3 runtime deps                                                                                                            | package.json/pnpm-lock          |
| Public exposure                                            | stdio only; no inbound network listener; tunnel client is outbound-only (optional loopback health listener only)                                                      | architecture                    |

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
   (`BEGIN … PRIVATE KEY`, PuTTY). A UTF-16/otherwise-encoded key evades the
   byte-level scan (decodes with NULs, still catchable by the binary probe in
   the first 8 KiB only). Marker detection is defense in depth, not the
   primary boundary — name/policy denies are.
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

## Failure policy

Fail closed: every error path returns a bounded `CODE: message` result; the
server never emits file contents on an error path, never falls back to a
permissive mode, and `doctor` exits non-zero on any failed check.

---

See also: [README](../README.md) · [SECURITY.md](../SECURITY.md) · [docs/OPERATIONS.md](OPERATIONS.md)
