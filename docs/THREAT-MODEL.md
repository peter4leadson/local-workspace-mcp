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
5. Integrity of operator policy (config/policy live outside watched roots).

## Trust boundaries

- Host process ↔ server process: JSON-RPC over stdio; no other IPC.
- Server ↔ filesystem: only canonical paths proven inside canonical roots.
- Server ↔ subprocesses: `git`, `rg`, and configured task argv only.
- Server ↔ tunnel-client ↔ OpenAI control plane (when ChatGPT attached):
  outbound HTTPS only, credentials held by tunnel-client, not this server.

## Mitigations by threat class (OWASP MCP-informed)

| Threat                                                     | Control                                                                                                                                          | Proof                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Path traversal `../`                                       | lexical containment vs realRoot pre-realpath; absolute inputs must be in-root                                                                    | `paths.test.ts` traversal cases |
| Symlink escape                                             | `realpathWithinRoot` resolves target or deepest existing ancestor; containment re-verified on canonical path; ELOOP rejected                     | symlink fixture tests           |
| Mid-path symlink ancestor                                  | ancestor-walk resolves each component chain                                                                                                      | `link-out/pwned.txt` test       |
| Case tricks (APFS)                                         | `isInside` compares canonical realpaths case-insensitively; realpath returns on-disk case                                                        | case-variant test               |
| Encoded traversal `%2e%2e`                                 | treated as literal name → NOT_FOUND; never decoded into separators                                                                               | encoded test                    |
| `~` home expansion                                         | rejected outright (`ACCESS_DENIED`)                                                                                                              | test                            |
| NUL/control chars, Windows drives                          | input hygiene rejections                                                                                                                         | tests                           |
| Sensitive files                                            | deny policy on lexical + resolved rel path (covers in-root symlink → `.env`); default rules in `policy.ts`; explicit template allowlist          | policy tests (100+ cases)       |
| Sensitive file renamed to benign name                      | content sniff: `BEGIN … PRIVATE KEY` markers refused in fs_read/git_show blobs/search previews regardless of filename                            | adversarial CONTENT tests       |
| Rename-laundered diff (`a/.env` → `b/safe.ts`)             | `redactDiff` checks BOTH sides of every `diff --git` header candidate; unparseable headers redact (fail closed)                                  | adversarial rename test         |
| Search attribution spoofing (`x:1:y/` dirs, newline names) | `rg --json` structured output; no `path:line:text` parsing; denied files emit no records                                                         | adversarial RG-PARSE tests      |
| Absolute-path leak via errors                              | `mapFsError` converts errno failures to bounded rel-path `ToolError`s; rg/git stderr scrubbed of workspace root                                  | adversarial error tests         |
| Symlinked audit path → arbitrary append                    | `lstat` refuse-before-append on the audit file                                                                                                   | adversarial audit test          |
| Malformed operator deny glob silently dead                 | structural bracket-balance validation at `DenyPolicy` construction — load fails closed                                                           | adversarial config test         |
| Config trust-root tampering                                | group/world-writable config refused (`mode & 0o022`); missing config → actionable `CONFIG_ERROR`                                                 | adversarial config tests        |
| Private-key material in history                            | `git show rev:path` denies policy-matching blob paths AND refuses key-material blobs                                                             | adversarial show test           |
| `.git` internals                                           | `.git/**` denied — protects credentialed remote config & object store                                                                            | test + smoke                    |
| Option injection into git                                  | strict ref allowlist + `--end-of-options` + `--` path separator + argv spawn                                                                     | ref-validation tests            |
| Shell injection                                            | no shell anywhere (`spawn` argv, `shell:false`); task ids validated; task argv is operator-fixed                                                 | task tests                      |
| Confused deputy                                            | caller picks workspace id + task id only; command text never crosses the boundary                                                                | TASK_DENIED tests               |
| Env/secret leakage                                         | subprocess env = sanitized allowlist (PATH/HOME/…); `GIT_TERMINAL_PROMPT=0`; task `env` rejects key/secret/token-named vars                      | `env-dump` test                 |
| Resource exhaustion                                        | caps everywhere: read bytes/lines, list entries, search results+deadline (rg), readMany totals, git output, task output+timeout, file-size limit | limit tests                     |
| Large-output context flood                                 | structured `truncated`/`nextStartLine`/`nextOffset` metadata                                                                                     | tests                           |
| ReDoS                                                      | content search delegated to ripgrep (linear-time engine); pattern length cap                                                                     | —                               |
| Binary dump                                                | NUL-probe → BINARY_FILE refusal                                                                                                                  | test                            |
| Malicious repo content                                     | files are data; they cannot alter roots/deny/tasks — those live in operator config                                                               | INJECTION.txt test              |
| Tool-scope creep                                           | V1 has no write/edit/delete/exec tools; `task_run` marked non-readOnly                                                                           | annotation checks               |
| Secrets in logs                                            | audit = JSONL metadata only (no contents, no abs paths, no env)                                                                                  | code review + test              |
| Supply chain                                               | pinned exact versions + committed lockfile; 3 runtime deps                                                                                       | package.json/pnpm-lock          |
| Public exposure                                            | stdio only; no listener; tunnel client is outbound-only                                                                                          | architecture                    |

## Adversarial findings ledger (2026-10-09 round, all remediated + regressed)

RED-first adversarial suite (`tests/adversarial.test.ts`, 23 cases) reproduced
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
   and outside-root names are never exposed.
5. **Unicode NFC**: `realpath` returns canonical on-disk names; files whose
   names differ only by normalization resolve to the same canonical path —
   containment unaffected.
6. **Prompt injection via file content**: a README cannot widen policy, but a
   model may be told to read more files; the deny policy and root boundary
   remain the hard limit.

## Failure policy

Fail closed: every error path returns a bounded `CODE: message` result; the
server never emits file contents on an error path, never falls back to a
permissive mode, and `doctor` exits non-zero on any failed check.
