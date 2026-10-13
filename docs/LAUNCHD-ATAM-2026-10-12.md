# ATAM review — launchd persistence subsystem (2026-10-12)

Architecture under review: `scripts/launchd/` + the LaunchAgent
`io.github.peter4leadson.local-workspace-mcp.tunnel`, which supervises
OpenAI's `tunnel-client runtimes connect` managed runtime for the
`local-workspace` alias. Method: ATAM-style (business drivers →
utility-tree scenarios → sensitivity/tradeoff points → risks), plus the
multi-domain panel below. Reviewed at branch `feat/launchd-persistence`.

## Thought-leader panel (governing constraints applied)

| Seat                         | Source                              | Constraint this design took                                                                                                                                                                |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI tunnel-client authors | `docs/end-user-guide.md`, README    | `runtimes connect` is the blessed supervision path; nohup/disown prohibited; tunnel_id, runtime key, and admin key are three different things and docs must not blur them                  |
| launchd semantics            | Apple `launchd.plist` / `launchctl` | Per-user `gui/$UID` domain, RunAtLoad + StartInterval is the correct "keep alive across login" primitive; launchd never overlaps runs of one job                                           |
| Nancy Leveson / STAMP        | independent review                  | The self-healer must be verified by a different mechanism than the one doing the healing — `health-check.sh` probes the stdio server directly rather than trusting `runtimes status` alone |
| Atul Gawande                 | checklist discipline                | The six-phase recovery matrix (login / app restart / process death / network drop / sleep-wake / repeated install) is enumerated and tested, not implied                                   |
| Michael Nygard / Release It! | stability patterns                  | Transient tolerance counter (4 checks) is a circuit-level distinction between "network blip" and "dead daemon" — restart is the expensive last resort, not the default reaction            |
| Simon Willison               | confused-deputy / secret hygiene    | Credentials must not ride in argv/env/plist — `file:` ref re-asserted on every connect because `connect` itself will drift the profile back to `env:`                                      |

## Business drivers

1. After reboot/login, ChatGPT must find Local Workspace MCP available with
   zero manual terminal work.
2. The existing tunnel id must be reused; a replacement tunnel invalidates
   connector state and is an admin-visible change.
3. The supervision layer must not weaken the package's security posture —
   no new listeners, no new secret exposure, no privilege change.
4. Public-package requirement: instructions must run on another operator's
   machine, not just this one.

## Utility tree (quality-attribute scenarios)

| Attribute       | Scenario                                          | Response measure                                                       |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| Availability    | Login after reboot; runtime previously dead       | RunAtLoad reconcile connects; ready in ≤ ~15 s observed                |
| Availability    | Daemon SIGKILLed                                  | Next 60 s tick reconnects; ~12 s observed                              |
| Robustness      | Daemon SIGSTOP-wedged, `runtimes stop` can't reap | SIGCONT+SIGKILL fallback clears it; reconnect succeeds                 |
| Correctness     | Two reconcile invocations race                    | mkdir lock defers the loser in <1 s; one daemon survives               |
| Correctness     | Transient outage, runtime alive but unhealthy     | 4 tolerated checks (~4 min) before restart — no churn on blips         |
| Confidentiality | Any script runs                                   | No key material in plist/env/argv/logs; profile stays `file:`          |
| Idempotence     | `install.sh` re-run N times                       | One plist (byte-identical), one agent, one daemon, one alias           |
| Recoverability  | Operator wants persistence gone                   | `uninstall.sh` removes agent+plist; `--stop-runtime` verified truthful |
| Portability     | Another user's machine                            | `$HOME`/`${USER}`/`command -v jq` — no machine-specific literals       |

## Sensitivity points

- **`runtimes status` JSON contract.** Every decision keys off
  `process_running`/`healthy`/`ready`. If OpenAI renames fields, jq
  `// false` makes everything fail closed (logged errors, no restarts) —
  safe but the runtime would stay down. Accepted: the pinned
  tunnel-client version owns the contract.
- **Stale-lock takeover (180 s).** Too short risks double-reconcile; too
  long delays recovery. 3× the interval is the chosen trade.
- **Transient threshold (4 × 60 s).** Too low churns restarts on brief
  network drops (each restart interrupts any in-flight MCP work); too high
  leaves a wedged daemon up for minutes. Tunable via
  `LOCAL_WORKSPACE_MAX_TRANSIENT_CHECKS`.
- **`runtimes list` for tunnel-id resolution.** Depends on the local alias
  record surviving; losing it logs an error and stops — by design it can
  never invent a tunnel.

## Tradeoff points

- **Polling vs launchd keepalive.** `KeepAlive` was rejected: the managed
  runtime is not a launchd-managed process (it is spawned by
  `runtimes connect`), so launchd cannot supervise it directly — periodic
  reconciliation is the correct granularity and adds the transient-tolerance
  layer KeepAlive cannot express.
- **Health-check depth vs cost.** The 60 s reconcile trusts
  `runtimes status`; the deep stdio probe runs only on demand
  (`health-check.sh`) because spawning a second MCP server every minute
  would duplicate audit entries and cost more than it detects.
- **Keychain vs secret file.** Reading keychain directly in the launchd
  context triggers ACL prompt fragility; the 0600 file is the stable
  substrate, materialized once at install, refreshed explicitly.

## Risks

- **R1:** tunnel-client behavior drift across upgrades (profile rewrite to
  `env:`, flag changes). Mitigation: reconcile re-asserts the `file:` ref;
  health-check verifies credential posture including daemon argv.
- **R2:** PATH resolution under launchd (node via `env`). Mitigation:
  explicit minimal PATH in both plist and scripts; verified end-to-end.
- **R3:** A future second alias sharing `local-workspace` in another
  profile-dir — pgrep patterns are anchored on this profile dir + profile,
  so a foreign daemon is ignored rather than killed. Accepted.

## Non-risks (verified this round)

- Secret in daemon argv (the pre-launchd `env:`-ref posture) — eliminated;
  the health-check inspects real argv per pid via `ps -o command=` (BSD
  `pgrep -l` prints comm only — a hollow check was caught and fixed).
- Wedged-daemon lock starvation — reproduced with SIGSTOP, fixed with the
  force-kill fallback, re-verified.
- Double-start under concurrent reconcile — mkdir lock verified live.
- Planted-symlink secret clobber — demonstrated then fixed (tempfile +
  `mv -f`); retested clean.
- Portability — the review caught author-specific binary paths and an
  installer-toolchain PATH; both now resolve from the caller's PATH at
  install, and the plist carries the computed agent PATH.
