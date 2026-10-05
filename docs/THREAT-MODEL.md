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

| Threat | Control | Proof |
|---|---|---|
| Path traversal `../` | lexical containment vs realRoot pre-realpath; absolute inputs must be in-root | `paths.test.ts` traversal cases |
| Symlink escape | `realpathWithinRoot` resolves target or deepest existing ancestor; containment re-verified on canonical path; ELOOP rejected | symlink fixture tests |
| Mid-path symlink ancestor | ancestor-walk resolves each component chain | `link-out/pwned.txt` test |
| Case tricks (APFS) | `isInside` compares canonical realpaths case-insensitively; realpath returns on-disk case | case-variant test |
| Encoded traversal `%2e%2e` | treated as literal name → NOT_FOUND; never decoded into separators | encoded test |
| `~` home expansion | rejected outright (`ACCESS_DENIED`) | test |
| NUL/control chars, Windows drives | input hygiene rejections | tests |
| Sensitive files | deny policy on lexical + resolved rel path (covers in-root symlink → `.env`); default rules in `policy.ts`; explicit template allowlist | policy tests (100+ cases) |
| `.git` internals | `.git/**` denied — protects credentialed remote config & object store | test + smoke |
| Option injection into git | strict ref allowlist + `--end-of-options` + `--` path separator + argv spawn | ref-validation tests |
| Shell injection | no shell anywhere (`spawn` argv, `shell:false`); task ids validated; task argv is operator-fixed | task tests |
| Confused deputy | caller picks workspace id + task id only; command text never crosses the boundary | TASK_DENIED tests |
| Env/secret leakage | subprocess env = sanitized allowlist (PATH/HOME/…); `GIT_TERMINAL_PROMPT=0`; task `env` rejects key/secret/token-named vars | `env-dump` test |
| Resource exhaustion | caps everywhere: read bytes/lines, list entries, search results+deadline (rg), readMany totals, git output, task output+timeout, file-size limit | limit tests |
| Large-output context flood | structured `truncated`/`nextStartLine`/`nextOffset` metadata | tests |
| ReDoS | content search delegated to ripgrep (linear-time engine); pattern length cap | — |
| Binary dump | NUL-probe → BINARY_FILE refusal | test |
| Malicious repo content | files are data; they cannot alter roots/deny/tasks — those live in operator config | INJECTION.txt test |
| Tool-scope creep | V1 has no write/edit/delete/exec tools; `task_run` marked non-readOnly | annotation checks |
| Secrets in logs | audit = JSONL metadata only (no contents, no abs paths, no env) | code review + test |
| Supply chain | pinned exact versions + committed lockfile; 3 runtime deps | package.json/pnpm-lock |
| Public exposure | stdio only; no listener; tunnel client is outbound-only | architecture |

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
