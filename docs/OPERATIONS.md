# Operations — local-workspace-mcp

## Health & diagnostics

```sh
workspace-mcp doctor           # deterministic check battery; exit 0 = healthy
workspace-mcp doctor --json    # machine-readable
```

Checks: build identity → config parse → each root exists+is-dir → `git` and
`rg` on sanitized PATH → every configured task executable resolvable → deny
policy self-test → MCP tool-registration smoke → `tunnel-client` presence.

## Startup

Deterministic: the server loads config, resolves canonical roots, and exits
non-zero on config errors. Hosts spawn one process per session (`serve --stdio`);
there is no daemon and no port. If a workspace root is missing at startup the
server still starts — that workspace reports `WORKSPACE_UNAVAILABLE`.

## Logs & audit

- Operational: single line to **stderr** on startup (stdout is the protocol).
- Audit: `~/.config/local-workspace-mcp/audit.jsonl` — one JSON object per
  call: `ts, tool, workspace, target(rel), ok, code, durationMs, truncated`.
  No contents, no absolute paths, no env. Rotate by deleting/truncating the
  file; it is append-only metadata.

## Recovery (boring on purpose)

| Symptom                          | Action                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Claude shows server disconnected | `workspace-mcp doctor` — fix first FAIL. Then `claude mcp list` re-check.               |
| `WORKSPACE_UNAVAILABLE`          | root moved/deleted — fix path in config or remove workspace entry.                      |
| `TASK_DENIED`                    | `task_list` — task not enabled for that workspace; edit config tasks.                   |
| Task executable missing          | `doctor` flags `task.<id>.executable` — install tool or fix PATH env in task def.       |
| Search returns nothing           | ensure `rg` is on the launching PATH (`doctor` checks sanitized PATH).                  |
| Config broken                    | `doctor` reports `config.parse` FAIL — invalid JSON or a schema error naming the field. |

No state exists outside config + audit log — deleting both and re-running
`init-config` is a full reset.

## Upgrades / rebuilds

```sh
pnpm install && pnpm build && pnpm test && workspace-mcp doctor
```

The installed launcher path is `$(npm prefix -g)/bin/workspace-mcp`
(`which workspace-mcp` confirms it); it is stable across rebuilds and
hosts pick up the new build on next spawn. Server name/version come from MCP
`initialize` (`local-workspace-mcp 0.1.0`, SDK v1 line, spec ≤2025-11-25).
Breaking tool-schema changes must bump the minor version — ChatGPT can retain
a frozen tool snapshot until refreshed.

## OpenAI Secure MCP Tunnel (ChatGPT path)

- Supervision: `tunnel-client runtimes connect` (native managed runtime —
  per OpenAI guidance, do not supervise with nohup/disown). Status:
  `tunnel-client runtimes status <alias> --json` (expect
  `process_running/healthy/ready`).
- Health surfaces: `/healthz` `/readyz` `/metrics` `/ui` on the health
  listener (`--health.listen-addr 127.0.0.1:<port>`; loopback only).
- Credentials: `CONTROL_PLANE_API_KEY` via env or `file:` ref — never in the
  profile YAML, never committed. `tunnel_id` in the profile is not a secret.
- Recovery: if the daemon dies, `runtimes status` shows unhealthy →
  `runtimes connect` again; the MCP server itself needs no restart (it is
  spawned per request-path by tunnel-client).
- Keep the daemon running for connector discovery and every ChatGPT call.
