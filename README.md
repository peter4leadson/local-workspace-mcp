# local-workspace-mcp

Read-oriented, host-neutral [MCP](https://modelcontextprotocol.io) server that gives
authorized AI hosts — Claude Code, Claude Desktop, and ChatGPT via the official
OpenAI Secure MCP Tunnel — bounded access to Peter's **live local engineering
workspaces**, including uncommitted working-tree state, without GitHub sync and
without any inbound network listener.

V1 is read + bounded named-task execution only. There is no write/edit/delete
surface and no arbitrary-shell primitive.

## Architecture

Ports-and-adapters, one implementation, one transport:

```
AI host (Claude Code / Claude Desktop / ChatGPT)
        │  stdio JSON-RPC (spawned per host, no listener)
        ▼
workspace-mcp serve --stdio          ← adapter: @modelcontextprotocol/sdk v1
        │
        ├── config.ts   operator config (outside any watched repo)
        ├── paths.ts    containment: lexical → realpath → deny policy
        ├── policy.ts   sensitive-file denylist (.env, keys, creds, .git/**)
        ├── fsOps.ts    fs_* tools (rg-backed content search)
        ├── git.ts      git_* tools (argv spawn, --end-of-options, strict refs)
        ├── tasks.ts    task_list/task_run (allowlisted argv, sanitized env)
        ├── audit.ts    metadata-only JSONL audit
        └── doctor      deterministic diagnostics (no phone-home)
```

Filesystem/Git/domain behavior is the core; the MCP transport is the adapter.
Nothing in the core depends on a specific host or tunnel implementation.

## Install

```sh
pnpm install && pnpm build
install -m 755 dist/cli.js /usr/local/bin/workspace-mcp   # or a launcher shim
workspace-mcp init-config                                  # writes ~/.config/local-workspace-mcp/config.json
# edit config.json — add your workspace roots and permitted named tasks
workspace-mcp doctor                                       # must be ALL GREEN
```

The launcher used on this machine: `~/.local/bin/workspace-mcp` → absolute
`node` + `dist/cli.js`. No `npx` network resolution at runtime.

## Configuration

`~/.config/local-workspace-mcp/config.json` (mode 600, lives outside watched
repos — repository content cannot widen policy):

```jsonc
{
  "version": 1,
  "workspaces": {
    "onramp": {
      "path": "/abs/path",
      "description": "…",
      "tasks": ["typecheck"],
    },
  },
  "tasks": {
    // argv arrays only; the caller picks a task id, never command text.
    "typecheck": {
      "command": ["pnpm", "typecheck"],
      "timeoutMs": 180000,
      "env": { "PATH": "/opt/node24/bin:${PATH}" },
    },
  },
  "deny": ["**/extra-secret/**"], // appended to the built-in deny rules
  "limits": {}, // see src/config.ts for all knobs
}
```

`WORKSPACE_MCP_CONFIG` overrides the config path.

## Tool contract (14 tools)

| tool                | purpose                                                            | notes                                             |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `workspace_roots`   | list authorized workspace ids + availability                       | no host paths leaked                              |
| `fs_list`           | bounded non-recursive listing, paginated                           | denied entries flagged                            |
| `fs_stat`           | metadata                                                           | symlink resolution visible                        |
| `fs_read`           | line-range text read                                               | binary refused, bounded bytes/lines               |
| `fs_read_many`      | batch reads                                                        | per-file inline errors, total cap                 |
| `fs_search_files`   | filename glob search                                               | git file universe (honors .gitignore)             |
| `fs_search_content` | literal/regex content search                                       | ripgrep backend, time/count bounded               |
| `git_status`        | branch, HEAD, staged/modified/deleted/renamed/untracked/conflicted | the uncommitted-truth tool                        |
| `git_diff`          | worktree/staged/ref diff, stat mode                                | bounded output                                    |
| `git_log`           | bounded history (≤100)                                             |                                                   |
| `git_show`          | commit or `ref:path` object                                        | strict ref validation                             |
| `git_branches`      | branches, upstreams, worktrees                                     | worktree host paths redacted                      |
| `task_list`         | permitted named tasks per workspace                                |                                                   |
| `task_run`          | execute allowlisted argv task                                      | `shell:false`, sanitized env, timeout/output caps |

Errors are explicit `CODE: message` (`ACCESS_DENIED`, `OUTSIDE_ROOT`,
`NOT_FOUND`, `TASK_DENIED`, `RESOURCE_LIMIT`, `BINARY_FILE`, `TIMEOUT`,
`INVALID_ARGUMENT`, `WORKSPACE_UNAVAILABLE`, `UNKNOWN_WORKSPACE`).

## Claude Code

```sh
claude mcp add local-workspace --scope user -- ~/.local/bin/workspace-mcp serve --stdio
claude mcp list      # shows ✔ Connected
```

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "local-workspace": {
      "command": "/Users/…/.local/bin/workspace-mcp",
      "args": ["serve", "--stdio"]
    }
  }
}
```

Restart the app to pick it up.

## ChatGPT (OpenAI Secure MCP Tunnel)

The Mac never accepts inbound MCP connections. `tunnel-client` (official,
`github.com/openai/tunnel-client`) keeps an outbound-only HTTPS path to OpenAI
and forwards MCP requests to the local stdio command.

```sh
# 1. Create a tunnel + runtime API key in Platform org settings (human step):
#    https://platform.openai.com/settings/organization/tunnels  → tunnel_<id>
#    https://platform.openai.com/settings/organization/api-keys → Tunnels Read+Use
export CONTROL_PLANE_API_KEY=<runtime key>   # or use a file: ref
tunnel-client init --profile local-workspace --tunnel-id <id> \
  --mcp-command "$HOME/.local/bin/workspace-mcp serve --stdio"
tunnel-client doctor --profile local-workspace --explain      # must be PASS
tunnel-client runtimes connect …                              # supervised local runtime
# 2. ChatGPT → Settings → Connectors → attach tunnel (keep daemon running)
```

`doctor --explain` fails closed on exactly what is missing (`tunnel_id`,
runtime key). See `docs/OPERATIONS.md` for the recovery procedure.

## Security model (summary — full doc in docs/THREAT-MODEL.md)

- Every fs path: input hygiene → lexical containment → canonical realpath
  containment (ancestor-walk for missing leaves) → deny policy on both lexical
  and resolved relative paths. `~`, NUL/control chars, Windows drives rejected.
- Deny-by-default for `.env*` (except `*.example/.sample/.template`), private
  keys, `.pem/.key/.p12/.pfx/.jks/.kdbx`, `.ssh/.aws/.kube/.docker` credential
  trees, `.npmrc/.netrc/.pgpass`, `secrets.*`, `*credentials*.json`, `.git/**`.
- Content-level key detection: a file carrying `BEGIN ... PRIVATE KEY`
  material under a benign name is refused in `fs_read`, `git_show` blobs, and
  search previews — the name is not the only boundary.
- Git: argv-only spawns, `--end-of-options`, strict ref allowlist,
  `GIT_TERMINAL_PROMPT=0`, sanitized env, hostile `core.fsmonitor`/
  external-diff config neutralized. Diff redaction checks BOTH sides of a
  rename — `a/.env → b/innocent.ts` cannot launder denied content — and
  merge-conflict `diff --cc` blocks are policy-checked too. `git_show` only
  displays commit/tag objects by bare ref (no raw blob/tree by SHA).
- Tasks run under the same GIT\_\* hardening, so an allowlisted task invoking
  `git` cannot execute repo-local config hooks.
- Search: `rg --json` structured output, so crafted filenames (`:`- or
  newline-containing directories) cannot spoof match attribution; denied
  files produce no match records and no previews.
- Errors are bounded `CODE: message` results — raw errno paths, absolute host
  paths, and rg stderr are scrubbed before they can reach a tool response.
- Tasks: allowlisted argv per workspace, `shell:false`, env allowlist,
  per-task timeout ≤5min hard cap, output cap.
- Audit: JSONL metadata only (tool, workspace, rel target, code, ms); refuses
  to write through a symlinked log path. No contents, no abs paths, no env.
- Config is the trust root: `mode 0600`-class permission enforcement, and
  operator deny globs are validated at startup (a malformed rule that would
  silently never match fails the load instead).
- No write tools, no exec primitive, no inbound listener — ever, in V1.

## Verification

```sh
pnpm test                       # 169 vitest cases incl. 33-case adversarial suite
scripts/inspector-smoke.sh      # 17-check MCP Inspector CLI battery
workspace-mcp doctor            # deterministic diagnostics (config, roots, tools)
pnpm audit --prod               # zero known runtime vulnerabilities
```
