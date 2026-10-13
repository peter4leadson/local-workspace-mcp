# Persistence verification — local-workspace tunnel (2026-10-12)

Exact-SHA evidence for the launchd persistence + self-healing setup that
keeps the ChatGPT-facing Local Workspace MCP tunnel alive with no manual
commands.

## Identity

| Item                  | Value                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation commit | `8bdadc6` on `feat/launchd-persistence` / PR #15 (adds wedged-daemon force-kill on top of `6a5fe2f`)                                                                                                                               |
| LaunchAgent label     | `io.github.peter4leadson.local-workspace-mcp.tunnel`                                                                                                                                                                               |
| Plist                 | `~/Library/LaunchAgents/io.github.peter4leadson.local-workspace-mcp.tunnel.plist`                                                                                                                                                  |
| LaunchAgent state     | bootstrapped in `gui/501`, `enabled`, `RunAtLoad`, `StartInterval=60`                                                                                                                                                              |
| Tunnel alias          | `local-workspace` (existing; **not** recreated)                                                                                                                                                                                    |
| Tunnel ID             | `tunnel_6ac415e931a081918d481e7acb053a91` (unchanged; alias record `Peter Local Workspace`)                                                                                                                                        |
| tunnel-client         | `0.0.15+a390c168` at `~/.local/bin/tunnel-client`                                                                                                                                                                                  |
| workspace-mcp         | `0.2.0` at `~/.local/bin/workspace-mcp`                                                                                                                                                                                            |
| Runtime command       | `tunnel-client run --profile-dir ~/.config/tunnel-client --profile local-workspace` (managed, PPID 1)                                                                                                                              |
| Credential            | runtime API key referenced as `file:` (0600, `~/Library/Application Support/tunnel-client/secrets/control-plane-api-key`); source of truth is keychain item `tunnel-client-control-plane` — no secret in env, argv, plist, or logs |

## Health at verification time

`tunnel-client runtimes status local-workspace --json`:
`process_running=true, healthy=true, ready=true`,
`health_url=http://127.0.0.1:55029/healthz` (loopback, ephemeral port).
`/healthz` → `live`, `/readyz` → `ready`.

`scripts/launchd/health-check.sh` → **ALL GREEN**:
agent registered · runtime triple-true · exactly one `tunnel-client run`
process · credential posture (secret file 0600, profile `file:` ref, no
key in daemon argv) · `workspace-mcp doctor` green · MCP stdio probe:
`initialize → local-workspace-mcp 0.2.0`, `tools/list → 23 tools`,
`fs_image` / `fs_pdf_page` / `fs_office_text` advertised,
`workspace_roots` (137 roots), `fs_list` + `git_status` succeed on the
`agent-tools` workspace.

## Recovery test matrix

| #   | Scenario                       | Method                                                                                                          | Result                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Clean launch at login          | `runtimes stop` + `launchctl bootout`, then `bootstrap` (simulates reboot+login)                                | **PASS** — RunAtLoad pass at 20:54:49, runtime ready 20:54:55 (~6 s end-to-end)                                                                                                                                                                                                                                                                                  |
| B   | Codex Desktop restart          | structural                                                                                                      | **PASS** — managed `tunnel-client run` has PPID 1 (launchd); no app process tree can kill it                                                                                                                                                                                                                                                                     |
| C   | ChatGPT app/platform restart   | structural                                                                                                      | **PASS** — same; connector lives control-plane-side, tunnel polls `api.openai.com` continuously                                                                                                                                                                                                                                                                  |
| D   | tunnel process termination     | `kill 14207`, then `kill` again after the `file:`-ref credential model landed                                   | **PASS ×2** — reconcile restarted at 20:50:43 (env-based path, ready in 5 s, new PID 14491) and again at 20:57:24 under the final `file:`-ref connect path (ready in ~6 s). Same tunnel ID both times                                                                                                                                                            |
| E   | Network interruption           | evidence + design                                                                                               | **Documented** — tunnel-client's own backoff already self-heals real outages (log 19:40:35 `poll timed out; backing off` → 19:41:06 `poller recovered; polling operational`). Reconcile tolerates 4 consecutive unhealthy checks before a controlled restart, so transient outages never churn the runtime                                                       |
| F   | Mac sleep/wake                 | evidence + design                                                                                               | **Documented** — same log shows a real suspend gap followed by in-process recovery; if the process dies during sleep (as it did between 19:41 and 20:46), the 60 s interval restarts it on wake — the exact path proven in row D. A live `pmset sleepnow` test was not run: scheduled RTC wake requires root and a stranded sleep state would block this session |
| G   | Repeated setup execution       | `install.sh` run 3×                                                                                             | **PASS** — plist rewritten deterministically, single agent reloaded, no duplicates                                                                                                                                                                                                                                                                               |
| H   | No duplicate processes/tunnels | `ps`, `launchctl print`, `runtimes list`                                                                        | **PASS** — exactly 1 `tunnel-client run` process, 1 LaunchAgent, 1 plist, 1 alias, 1 tunnel ID                                                                                                                                                                                                                                                                   |
| I   | Wedged-but-alive daemon        | `kill -STOP` (process exists, health endpoints refuse), reconcile with `LOCAL_WORKSPACE_MAX_TRANSIENT_CHECKS=1` | **PASS** — `runtimes stop` could not reap the suspended daemon; `stop_runtime` resumed + SIGKILLed it (21:04:51), `connect` succeeded, ready in ~5 s, exactly one replacement process. This path failed before `8bdadc6` (connect exited 2 on the held lock)                                                                                                     |
| J   | SIGKILL recovery via agent     | `kill -9` daemon at 20:58:59, no manual action                                                                  | **PASS** — next 60 s reconcile tick (20:59:05) restarted the runtime; ready at 20:59:11 (~12 s total, zero-touch)                                                                                                                                                                                                                                                |

## How recovery works (deterministic)

`reconcile.sh` every 60 s reads `runtimes status <alias> --json`:

- `process_running + healthy + ready` → no-op (~0.3 s, verified).
- `process_running=false` → immediate `runtimes connect` with
  `--tunnel-id` resolved from the alias record and
  `--runtime-api-key file:…` (no admin CRUD required; a replacement
  tunnel can never be created). Polls until ready or 60 s.
- alive but not healthy/ready → transient counter; restart only after 4
  consecutive failures, always `stop` before `connect` — never a second
  instance on the same tunnel ID. `stop` resumes + SIGKILLs any daemon
  that survives `runtimes stop` (suspended/wedged processes hold the
  runtime lock and otherwise make the next `connect` fail).
- a mkdir lock serializes each pass so a manual run can never race the
  agent.

## Rollback

```sh
scripts/launchd/uninstall.sh                  # remove persistence; runtime keeps running
scripts/launchd/uninstall.sh --stop-runtime   # also stop the managed runtime
```

Removes the plist and boots out the agent. Alias, remote tunnel, keychain
item, and logs are untouched — the machine returns to the previous
manual `runtimes connect` state.

## Security notes

- No secrets in the plist, scripts, daemon argv, or logs; the
  control-plane key exists only in the keychain and the 0600 secret file
  (`file:` ref verified in the credential-posture check).
- `workspace-mcp` security controls unchanged: authorized roots only,
  deny policy intact (`policy.selftest` 9/9 inside `doctor`), no
  unrestricted shell (`task_run` allowlist only), audit log untouched.
- Health listener bound to `127.0.0.1` on an ephemeral port.
