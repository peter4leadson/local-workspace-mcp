# Operations — local-workspace-mcp

## Health & diagnostics

```sh
workspace-mcp doctor           # deterministic check battery; exit 0 = healthy
workspace-mcp doctor --json    # machine-readable
```

Checks: build identity → Node ≥20 → config file permissions (not
group/world-writable, not a symlink) → config parse → each root
exists+is-dir → `git` and `rg` on sanitized PATH → every configured task
executable resolvable → deny policy self-test → MCP tool-registration
smoke → `tunnel-client` presence.

## Startup

Deterministic: the server loads config, resolves canonical roots, and exits
non-zero on config errors. Hosts spawn one process per session (`serve --stdio`);
there is no daemon and no port. If a workspace root is missing at startup the
server still starts — that workspace reports `WORKSPACE_UNAVAILABLE`.

## Logs & audit

- Operational: single line to **stderr** on startup (stdout is the protocol).
- Audit: `~/.config/local-workspace-mcp/audit.jsonl` — one JSON object per
  call: `ts, tool, workspace, target, ok, code, durationMs, truncated`.
  `target` echoes the caller-supplied path as given (an in-root absolute
  path argument is logged verbatim); the server never writes file contents,
  env values, or server-resolved absolute paths. Best-effort: append
  failures are dropped rather than failing calls. Rotate by
  deleting/truncating the file; it is append-only metadata.

## Recovery (boring on purpose)

The canonical symptom → action table lives in [README.md §Troubleshooting](../README.md#troubleshooting)
(it also covers install and host-registration failures). The two rules that
resolve almost everything: `workspace-mcp doctor` names the first failing
check, and hosts spawn with a minimal PATH — use the absolute binary path.

No state exists outside config + audit log — deleting both and re-running
`init-config` is a full reset.

## Upgrades / rebuilds

```sh
pnpm install && pnpm build && pnpm test && workspace-mcp doctor
```

For tarball installs, `npm install -g <new>.tgz` over the existing install
followed by `workspace-mcp doctor` is the equivalent upgrade.

The installed launcher path is `$(npm prefix -g)/bin/workspace-mcp`
(`which workspace-mcp` confirms it); it is stable across rebuilds and
hosts pick up the new build on next spawn. Server name/version come from MCP
`initialize` (`local-workspace-mcp 0.1.0`, SDK v1 line, spec ≤2025-11-25).
Breaking tool-schema changes must bump the minor version — ChatGPT can retain
a frozen tool snapshot until refreshed.

## OpenAI Secure MCP Tunnel (ChatGPT path)

- Supervision: `tunnel-client runtimes connect <alias>` (native managed
  runtime — per OpenAI guidance, do not supervise with nohup/disown;
  `<alias>` names the configured tunnel profile). Status:
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

---

See also: [README](../README.md) · [SECURITY.md](../SECURITY.md) · [docs/THREAT-MODEL.md](THREAT-MODEL.md)
