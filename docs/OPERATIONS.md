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

Notes:

- Over-cap original images fail with `RESOURCE_LIMIT` and the agent must opt
  in to a disclosed re-encode (`fitMaxDim`) — evidence is never silently
  altered. Returned transforms are reported in `transform:{kind,detail}`.
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
