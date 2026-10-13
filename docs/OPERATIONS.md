# Operations — local-workspace-mcp

**Contents:** [Health & diagnostics](#health--diagnostics) ·
[Startup](#startup) · [Logs & audit](#logs--audit) ·
[Media tools](#media-tools-v020) · [Recovery](#recovery-boring-on-purpose) ·
[Upgrades / rebuilds](#upgrades--rebuilds) ·
[Tunnel (ChatGPT path)](#openai-secure-mcp-tunnel-chatgpt-path)

## Health & diagnostics

```sh
workspace-mcp doctor           # deterministic check battery; exit 0 = healthy
workspace-mcp doctor --json    # machine-readable
```

Checks: build identity → Node ≥20 → platform (POSIX only: darwin/linux) →
config file permissions (not
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
  `target` is the caller-supplied path scrubbed: absolute paths inside the
  workspace root are recorded root-relative; other absolute paths are
  masked to `<abs>/<basename>`. The server never writes file contents,
  env values, or server-resolved absolute paths. Best-effort: append
  failures are dropped rather than failing calls. Rotate by
  deleting/truncating the file; it is append-only metadata.

## Media tools (v0.2.0)

`fs_image`/`fs_contact_sheet`/`fs_archive_*`/`fs_pdf_*`/`fs_office_text`
are bounded by `limits.*` keys — every value is a hard ceiling and every
override is schema-checked:

| Key                    | Default | Schema cap | Governs                                              |
| ---------------------- | ------- | ---------- | ---------------------------------------------------- |
| `maxMediaFileBytes`    | 32 MB   | 128 MB     | any file opened by a media tool                      |
| `maxImagePixels`       | 40 MP   | 200 MP     | decoded image area (bomb guard; checked pre-decode)  |
| `maxImageOutputBytes`  | 3.5 MB  | 8 MB       | every returned image/pdf-render payload              |
| `mediaConcurrency`     | 2       | 4          | simultaneous decode/render operations                |
| `contactSheetMaxItems` | 24      | 48         | cells per contact sheet                              |
| `archiveMaxMembers`    | 5,000   | 50,000     | enumerated zip members                               |
| `archiveMaxEntryBytes` | 32 MB   | 64 MB      | decompressed member size (hard counter, not headers) |
| `archiveMaxRatio`      | 200     | 10,000     | compressed→uncompressed ratio refusal                |
| `pdfMaxPagesRender`    | 4       | 8          | pages per `fs_pdf_page` call                         |
| `pdfMaxPagesText`      | 50      | 200        | pages per `fs_pdf_text` call                         |
| `pdfMaxRenderPixels`   | 6.25 MP | 25 MP      | per-page render area                                 |
| `mediaTimeoutMs`       | 30 s    | 120 s      | wall-clock deadline per media op                     |

Multi-item calls also carry cumulative budgets: `fs_contact_sheet` spends
at most 3× `mediaTimeoutMs` across all cells (remaining cells degrade to
failed placeholders), and `fs_pdf_page` at most 2× across its page set.
`task_run` resolves on kill + `exit` — detached grandchildren cannot hold
a call open via inherited pipes.

Notes:

- Over-cap original images fail with `RESOURCE_LIMIT` and the agent must opt
  in to a disclosed re-encode (`fitMaxDim`) — evidence is never silently
  altered. Returned transforms are reported in
  `transform:{kind, sourceSha256, returnedSha256, detail}`.
- Image tools return text metadata + `structuredContent` alongside the
  image block, so hosts that drop `image` content (e.g. some ChatGPT
  connector paths) still get complete metadata. See RESEARCH.md.
- PDFium's WASM binary (~6 MB) is loaded lazily on first `fs_pdf_*` call.
- `deniedCount`/`unsafeCount` in archive listings reveal member-name
  existence (same class as `fs_list` denied flags) — contents never leak.

## Recovery (boring on purpose)

The canonical symptom → action table lives in [README.md §Troubleshooting](../README.md#troubleshooting)
(it also covers install and host-registration failures). The two rules that
resolve almost everything: `workspace-mcp doctor` names the first failing
check, and hosts spawn with a minimal PATH — use the absolute binary path.

The server itself keeps no state outside config + audit log — deleting both
and re-running `init-config` is a full reset of this component. Host
registrations, the npm-installed package files, and `tunnel-client` runtime
state live elsewhere and are unaffected.

## Upgrades / rebuilds

```sh
pnpm install && pnpm build && pnpm test && workspace-mcp doctor
```

For tarball installs, `npm install -g <new>.tgz` over the existing install
followed by `workspace-mcp doctor` is the equivalent upgrade.

The installed launcher path is `$(npm prefix -g)/bin/workspace-mcp`
(`which workspace-mcp` confirms it); it is stable across rebuilds and
hosts pick up the new build on next spawn. Server name/version come from MCP
`initialize` (`local-workspace-mcp <version>` — matches package.json;
SDK v1 line, spec ≤2025-11-25).
Breaking tool-catalog changes must bump the minor version — ChatGPT's
connector retains a frozen `tools/list` snapshot until refreshed. The
server advertises `notifications/tools/list_changed`, but the hosted
connector does not re-list on that signal today: **the likely recovery is a
ChatGPT-side connector re-save/reconnect** (Settings → Connectors → the
connector → edit/save, or toggle off/on), which should trigger backend
re-discovery (`tools/list` over the live tunnel). If the catalog is still
stale after that, delete and recreate the connector. Diagnosis: forwarded
`initialize`/`tools/call` succeed against the current child while
`tools/list` is never forwarded — so the stale snapshot sits in the
connector's retained catalog, not the local server; verify by re-checking
the exposed tool count after each step.

## OpenAI Secure MCP Tunnel (ChatGPT path)

Cold start: install `tunnel-client`
(`https://github.com/openai/tunnel-client`), create a tunnel profile
(`tunnel-client runtimes create`, which writes the YAML naming the stdio
command and `tunnel_id`), then register the connector in ChatGPT pointing
at that tunnel. The notes below assume `<alias>` names that profile.

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

### Persistence (macOS launchd)

`scripts/launchd/` keeps the managed runtime alive without manual steps:

```sh
scripts/launchd/install.sh        # install/refresh the LaunchAgent (idempotent)
scripts/launchd/health-check.sh   # deep verification; exit 0 = all green
scripts/launchd/uninstall.sh      # remove persistence only
scripts/launchd/uninstall.sh --stop-runtime   # …and stop the runtime too
```

- LaunchAgent `io.github.peter4leadson.local-workspace-mcp.tunnel`
  (`~/Library/LaunchAgents/`) runs `reconcile.sh` at login and every 60 s.
- Reconciliation: `runtimes status <alias> --json` must report
  `process_running` + `healthy` + `ready`. A dead runtime is reconnected
  immediately. A live-but-unhealthy runtime is tolerated for 4 consecutive
  checks (~4 min — tunnel-client's own backoff rides out transient
  network/platform outages) before a controlled stop→connect restart.
- Reconnects bind `--tunnel-id` resolved from the local alias record, so
  recovery needs no admin key and can never create a replacement tunnel.
  A second instance on the same tunnel ID is never started: a mkdir lock
  serializes manual runs against the agent, live status is read before
  every action, and a restart always stops the old runtime first.
- Credentials: the runtime API key lives in the login keychain
  (`tunnel-client-control-plane`). `install.sh` materializes it once into
  a 0600 file (`~/Library/Application Support/tunnel-client/secrets/`)
  and the profile references it via `file:` — re-asserted by
  `--runtime-api-key` on every connect so the ref cannot drift back to
  `env:`. No secret is placed in the plist, the agent environment, daemon
  argv, or the logs. `install.sh --refresh-secret` re-materializes after
  key rotation.
- The managed `tunnel-client run` process is parented to launchd (PPID 1),
  so Codex Desktop and ChatGPT restarts cannot affect it.
- Logs: `~/Library/Logs/local-workspace-mcp/reconcile{,.error}.log`;
  reconcile state: `~/Library/Application Support/local-workspace-mcp/`.
- Rollback: `uninstall.sh` boots out the agent and deletes the plist; the
  alias, tunnel, keychain item, and logs are untouched.

---

See also: [README](../README.md) · [SECURITY.md](../SECURITY.md) · [docs/THREAT-MODEL.md](THREAT-MODEL.md)
