# local-workspace-mcp

Your AI assistant needs context. It does not need unrestricted access.

A read-oriented MCP server for local workspaces. Write, delete, and
arbitrary-shell tools do not exist in it. Not gated or disabled: absent. Every
filesystem path is checked against operator-authorized roots and a
default-deny list for secrets, `.env` files, private keys, and `.git`
internals. Git read tools and operator-declared named tasks provide
bounded capability without giving the model a shell.

- **14 tools** over stdio JSON-RPC: bounded filesystem reads/searches,
  read-only git (status/diff/log/show/branches), and `task_run` for
  explicitly allowlisted commands.
- **One transport:** each MCP host spawns `workspace-mcp serve --stdio`.
  No inbound listener, no daemon; the server itself makes no network calls
  (allowlisted tasks run as your user and are not network-restricted).
- **Honest scope:** `task_run` executes real commands as your user. The
  allowlist bounds _what can be invoked_, not what invoked code can do.
  It is not a sandbox.

Evaluating this for team use? Start at [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)
and [SECURITY.md](SECURITY.md).

## The problem

Hosts' built-in file tools are convenient but live in the client's
permission loop, the same loop users bypass out of fatigue
(`--dangerously-skip-permissions`, "yes to everything"). The official
`@modelcontextprotocol/server-filesystem` ships read **and** write tools
with no default secrets denylist, and has already overwritten a user's
`.env` ([upstream issue #1869](https://github.com/modelcontextprotocol/servers/issues/1869)). Generic filesystem MCPs give a model file
access; they do not give it _bounded_ access.

This server moves the boundary server-side: roots, deny rules, task
allowlists, and audit live in an operator config that repository content
cannot widen. A compromised or bypassed prompt loop cannot invoke a tool
that does not exist.

## Quick start

Requires Node ≥ 20, plus `git` for `git_*` tools and ripgrep (`rg`) for
content search. Building from a clone needs pnpm (`corepack enable`).

```sh
npm install -g local-workspace-mcp          # puts workspace-mcp on PATH

# or from a clone:
pnpm install && pnpm build && npm link

workspace-mcp init-config     # writes ~/.config/local-workspace-mcp/config.json (mode 600)
$EDITOR ~/.config/local-workspace-mcp/config.json   # replace the example workspace (below)
workspace-mcp doctor          # must print "doctor: ALL GREEN" (use --json for CI)
```

The generated config ships a placeholder workspace named `example` —
replace it with a real root or `doctor` will report `root.example` FAIL.
A healthy run ends:

```text
PASS policy.selftest — 9/9 cases correct
PASS mcp.startup — tool registration ok
doctor: ALL GREEN
```

Minimal working config (strict JSON — no comments or trailing commas):

```json
{
  "version": 1,
  "workspaces": {
    "myproj": { "path": "/absolute/path/to/repo", "tasks": [] }
  },
  "tasks": {},
  "deny": []
}
```

Then connect a host (below), confirm it registered (`claude mcp list`,
`/mcp`, or your host's equivalent), and ask: _"use workspace_roots, then
fs_list on myproj"_. First useful call sequence: `fs_list` → `git_status`
→ `git_diff` on uncommitted work, where a chat client otherwise
has no eyes.

## Usage examples

```text
# what the assistant can ask for
workspace_roots                        # authorized workspace ids, no host paths
fs_list   {workspace:"myproj"}
fs_read   {workspace:"myproj", path:"src/index.ts", startLine:1, maxLines:120}
fs_search_content {workspace:"myproj", query:"TODO"}        # literal; regex:true for rg syntax
git_status {workspace:"myproj"}        # branch, HEAD, uncommitted truth
git_diff  {workspace:"myproj"}         # worktree diff, bounded output
git_show  {workspace:"myproj", spec:"HEAD"}
task_list {workspace:"myproj"}
task_run  {workspace:"myproj", taskId:"typecheck"}
```

Denied behavior is explicit, never silent:

```text
fs_read {workspace:"myproj", path:".env"}              → ACCESS_DENIED  (or NOT_FOUND if absent)
fs_read {workspace:"myproj", path:"../../etc/passwd"}  → OUTSIDE_ROOT
task_run {workspace:"myproj", taskId:"nuke"}           → TASK_DENIED    (valid id, not enabled)
task_run {workspace:"myproj", taskId:"rm -rf /"}       → INVALID_ARGUMENT (malformed task id)
git_show {workspace:"myproj", spec:"--exec"}           → INVALID_ARGUMENT
```

Denial codes are the policy working as intended, not errors to report;
widening access happens only in the operator config. Task/search timeouts
and output limits return `timedOut:true`/`truncated:true` in a normal
result rather than an error. `INTERNAL_ERROR` covers spawn/tool failures and should not
appear in healthy use; `git_*` on a non-git root returns `{repo:false}`
gracefully.

## Tool surface

All 14 tools, annotated `readOnlyHint` where true (hosts can auto-approve
pure reads). `task_run` is the only tool with side effects.

| Tool                | Scope         | Notes                                                                                                                  |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `workspace_roots`   | reads config  | workspace ids + availability; never host paths                                                                         |
| `fs_list`           | one directory | bounded, paginated; denied entries flagged by class                                                                    |
| `fs_stat`           | one path      | metadata; symlink resolution disclosed                                                                                 |
| `fs_read`           | one file      | line-range, byte-capped; binary refused                                                                                |
| `fs_read_many`      | batch         | per-file inline errors, total cap                                                                                      |
| `fs_search_files`   | filenames     | glob; git file universe where a repo exists (honors .gitignore at the repo toplevel); bounded directory walk otherwise |
| `fs_search_content` | file contents | ripgrep `--json`; literal or `regex:true`; time/count bounded                                                          |
| `git_status`        | repo          | branch, HEAD, staged/modified/deleted/renamed/untracked                                                                |
| `git_diff`          | repo          | worktree/staged/ref diff; bounded; denied paths redacted                                                               |
| `git_log`           | repo          | ≤100 commits                                                                                                           |
| `git_show`          | repo          | commits/tags and `ref:path` blobs; strict ref validation                                                               |
| `git_branches`      | repo          | branches, upstreams, worktrees (host paths redacted)                                                                   |
| `task_list`         | config        | task ids enabled per workspace                                                                                         |
| `task_run`          | subprocess    | allowlisted argv only; `shell:false`; caps on time/output                                                              |

## Supported hosts

| Host                    | Mechanism                                                                                                    | Status     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| Claude Code             | `claude mcp add local-workspace --scope user -- workspace-mcp serve --stdio`; confirm with `claude mcp list` | verified   |
| Claude Desktop          | `mcpServers` entry in `claude_desktop_config.json`; restart app                                              | configured |
| Codex CLI               | `mcp_servers` stdio entry in `~/.codex/config.toml`                                                          | supported  |
| ChatGPT / Responses API | OpenAI Secure MCP Tunnel (`openai/tunnel-client`, outbound-only)                                             | verified   |
| MCP Inspector           | `scripts/inspector-smoke.sh` battery, 17 checks                                                              | verified   |

GUI hosts (Claude Desktop especially) spawn servers with a minimal PATH,
not your shell's. If a host reports ENOENT or stays disconnected while
`doctor` is green, the binary is not on the host's PATH. Use the absolute
path (`which workspace-mcp`) as the command and check the host's MCP log.

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS):

```json
{
  "mcpServers": {
    "local-workspace": {
      "command": "/absolute/path/to/workspace-mcp",
      "args": ["serve", "--stdio"]
    }
  }
}
```

Codex CLI (`~/.codex/config.toml`, or `codex mcp add`):

```toml
[mcp_servers.local-workspace]
command = "/absolute/path/to/workspace-mcp"
args = ["serve", "--stdio"]
```

For ChatGPT, `tunnel-client` polls an outbound HTTPS path and spawns the
stdio command locally; no inbound network listener opens. (tunnel-client
can optionally bind a loopback-only health endpoint — see OPERATIONS.)
Operator runbook: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Permission model

- **Roots are explicit.** Nothing outside `workspaces[].path` is reachable;
  `~`, control characters, Windows drive paths, and `..` traversal are
  rejected before any syscall, and again after `realpath`. Point roots at
  the projects you actually work on; never authorize `~/` or a parent
  directory that contains things the assistant should not read.
- **Denied by default,** including: `.env*`/`*.env` spellings (except
  `.env[.*].{example,sample,template}`), `.envrc`, private-key filenames,
  `.pem/.key/.p12/.pfx/.jks/.kdbx`, `.ssh`, `.aws`, `.azure`, `.gnupg`,
  `.kube`/`kubeconfig`, `.docker`, `.npmrc`, `.netrc`, `.pgpass`, `.pypirc`,
  `.git-credentials`/`.gitconfig`, shell histories, `*.tfvars`,
  `secrets.{json,yaml,yml,toml}`/`.secrets`/`secrets.d`,
  `credentials`/`service-account*.json`/`gha-creds-*.json`, and all `.git`
  internals. Representative list — the authoritative rules are
  `DEFAULT_DENY` in `src/policy.ts` (repository); denies are fail-closed.
- **Name is not the only boundary:** a file containing `BEGIN … PRIVATE KEY`
  armor under a benign name is refused in reads, `git_show` blobs, and
  search previews. The scan is heuristic defense-in-depth (encoding and
  size-budget limits documented in the threat model); name/policy denies
  are the primary boundary.
- **Git is read-only and hardened:** argv-only spawns, `--end-of-options`,
  strict ref validation, literal pathspecs, `GIT_TERMINAL_PROMPT=0`.
  Inside allowlisted tasks the headline repo-config exec keys are pinned
  via `GIT_CONFIG_*` overrides (`core.fsmonitor`, `core.sshCommand`,
  `diff.external`, `core.hooksPath`; per-driver
  `diff.<name>`/`filter.<name>` hooks are a documented residual). Rename
  diffs and merge-conflict `diff --cc` blocks are policy-checked on every
  path they name.
- **Tasks are declared, not typed:** argv arrays in config, `shell:false`,
  sanitized environment, per-task timeout and output caps. Operator env
  cannot inject `GIT_*`, loader, or interpreter hooks.
- **Errors are bounded:** every failure is `CODE: message`; absolute host
  paths are scrubbed from tool errors, except that a task-spawn failure
  reports the operator-configured argv itself. `task_run` returns subprocess
  stdout/stderr verbatim — that output belongs to commands the operator
  allowlisted.

Errors: `ACCESS_DENIED`, `OUTSIDE_ROOT`, `NOT_FOUND`, `BINARY_FILE`,
`RESOURCE_LIMIT`, `TASK_DENIED`, `UNKNOWN_WORKSPACE`,
`WORKSPACE_UNAVAILABLE`, `INVALID_ARGUMENT`, `INTERNAL_ERROR`, plus
`CONFIG_ERROR` at config load/startup. `task_run` and search timeouts
return `timedOut:true` in the result. Git-command failures surface as
`INVALID_ARGUMENT` (`git_diff`/`git_log`/`git_show` map non-zero exits,
including timeout kills) or `INTERNAL_ERROR` (`git_status`); a timeout on
repo detection reads as `repo:false`, and `git_branches` tolerates a
non-zero exit with an empty list.

## What it will not do

No writes, edits, deletes, renames, or file creation. No shell. No git
mutations (`commit`, `push`, `clean` …). No network listener. No
repo-controlled configuration. Tasks execute only what the operator
pre-declared, and even those run as your user with real side effects,
so keep the allowlist tight and prefer read-only commands.

## Security architecture

Ports-and-adapters, one implementation, one transport:

```text
AI host ── stdio JSON-RPC ──▶ workspace-mcp serve --stdio

  config.ts   trust root: operator config (keep it outside watched roots)
  paths.ts    lexical + realpath containment, bounded error mapping
  policy.ts   default-deny rules + validated operator globs
  fsOps.ts    bounded reads/searches (ripgrep --json, structured parsing)
  git.ts      read-only git, strict refs, diff redaction, object-type gates
  tasks.ts    allowlisted argv only, process-group timeouts
  exec.ts     sanitized + git-hardened subprocess environments
  audit.ts    metadata-only JSONL; refuses symlinked targets
```

The full boundary analysis, the 30-finding adversarial ledger, the 33-case
regression suite, and documented residual risks live in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). Disclosure
policy in [SECURITY.md](SECURITY.md).

## Configuration reference

`~/.config/local-workspace-mcp/config.json`; refused at load if the file or
its directory is group/world-writable, or the path is a symlink.

```jsonc
// annotated for reading — the parser is strict JSON;
// this block is documentation, not a template. Start from `init-config`
// output, or strip the // comments (the JSON itself is otherwise valid).
{
  "version": 1,
  "workspaces": {
    "myproj": {
      "path": "/abs/path", // required
      "description": "…",
      "tasks": ["typecheck"], // ids the caller may run here
    },
  },
  "tasks": {
    "typecheck": {
      "command": ["pnpm", "typecheck"], // argv only; never a command string
      "cwd": "subdir-inside-root", // optional; contained to the root
      "timeoutMs": 180000, // 1s..300s; 300s is a hard cap
      "env": { "PATH": "/opt/node/bin:${PATH}" }, // ${VAR} expands vs base env
    },
  },
  "deny": ["**/extra-secret/**"], // appended to built-in rules; evaluated
  // BEFORE the template allowlist, so an operator can re-deny
  // .env.example; malformed patterns fail config load, fail-closed
  "auditLog": "/abs/path.jsonl", // optional; defaults next to the config
  "limits": {}, // byte/line/count caps
}
```

Common `limits` keys (key: default): `maxReadFileBytes`: 5 MB file-size
ceiling for reads, `defaultReadBytes`: 64 KiB per read,
`maxSearchResults`: 200, `searchDeadlineMs`: 20 s, `gitTimeoutMs`: 15 s,
`maxTaskOutputBytes`: 64 KiB, `walkEntryCap`/`walkDepthCap`: 50k entries /
20 deep. Full schema with bounds: `src/config.ts` in the repository. Callers can pass
`timeoutMs` to `task_run` to shorten a task's timeout; it can never
exceed the configured value or the 300 s hard cap.

Overrides: `WORKSPACE_MCP_CONFIG` (config file), `WORKSPACE_MCP_CONFIG_DIR`
(config dir + audit log location), `workspace-mcp serve --config <path>`
(CLI flag). `init-config` refuses to overwrite an existing config; delete
the file first if you intend a reset.

## Troubleshooting

| Symptom                                      | Action                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm install -g` fails EACCES                | set a user prefix (`npm config set prefix ~/.local`, add `~/.local/bin` to PATH) or use an nvm-managed Node; never `sudo npm -g` |
| `command not found` after install            | binary lives in `$(npm prefix -g)/bin`; add it to PATH, or use the clone+`npm link` path                                         |
| Host shows disconnected                      | `workspace-mcp doctor`, fix first FAIL; if green, the host's spawn PATH differs — use the absolute binary path                   |
| `CONFIG_ERROR` on startup                    | permissions/JSON/symlink/unknown-task; the message names the cause                                                               |
| `init-config` exits 1                        | it refuses to overwrite; delete the existing config first                                                                        |
| `WORKSPACE_UNAVAILABLE`                      | root path moved/deleted; fix or remove the workspace entry                                                                       |
| `TASK_DENIED`                                | task id not enabled for that workspace; `task_list` shows the allowlist                                                          |
| Task executable missing                      | `doctor` flags `task.<id>.executable`; install it or fix task `env.PATH`                                                         |
| Search returns nothing                       | `rg` must be on the sanitized PATH; `doctor` checks it                                                                           |
| `ACCESS_DENIED`/`OUTSIDE_ROOT`/`BINARY_FILE` | policy working as intended; widen only in operator config                                                                        |
| Unexpected `INTERNAL_ERROR`                  | check the host's MCP stderr log; report per [SECURITY.md](SECURITY.md)                                                           |
| Tunnel (ChatGPT) down                        | `tunnel-client runtimes status`; recovery in [docs/OPERATIONS.md](docs/OPERATIONS.md)                                            |

`workspace-mcp doctor --json` gives machine-readable output for CI or
wrapper scripts. Full reset: delete the config and
`~/.config/local-workspace-mcp/audit.jsonl`, re-run `init-config`. To
uninstall entirely, also remove the host entry (`claude mcp remove`, the
`mcpServers`/`mcp_servers` block, or the tunnel profile) and `npm uninstall
-g local-workspace-mcp` (or `npm unlink` if linked from a clone).

## Compatibility

- Node ≥ 20 (uses `node:util` parseArgs; tested on Node 22).
- macOS/Linux. Windows is untested; path validation is POSIX-shaped.
- MCP SDK `@modelcontextprotocol/sdk` v1.x line (spec ≤ 2025-11-25);
  v2 API surface is deliberately not adopted yet (see [docs/RESEARCH.md](docs/RESEARCH.md)).
- ripgrep required for `fs_search_content`; git required for `git_*`.

## Verifying the build

```sh
pnpm install --frozen-lockfile
pnpm test                    # 169 vitest cases incl. 33-case adversarial suite
pnpm typecheck && pnpm build
workspace-mcp doctor         # deterministic diagnostics
scripts/inspector-smoke.sh <workspace-id>   # 17-check MCP Inspector battery
pnpm audit --prod            # dependency audit
```

## Contributing, security, license

- [CONTRIBUTING.md](CONTRIBUTING.md): RED-first tests, fail-closed rules, no new capability
  surface without design review.
- [SECURITY.md](SECURITY.md): vulnerability reporting and scope.
- [CHANGELOG.md](CHANGELOG.md): release notes by finding/version.
- License: [MIT](LICENSE).

## Release status

v0.1.0 is published on npm as `local-workspace-mcp` and listed on the
official MCP Registry as `io.github.peter4leadson/local-workspace-mcp`.
The evaluated release surface (this README,
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), the test suite, and the packaged tarball) is
described in [docs/RELEASE-PACKET.md](docs/RELEASE-PACKET.md).

---

Maintained by [Peter C. Bennett](https://petercbennett.com).
