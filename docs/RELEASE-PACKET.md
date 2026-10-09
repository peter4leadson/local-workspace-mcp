# Release decision pack — local-workspace-mcp

Status: RELEASE-READY_PENDING_OWNER_ACTION — all technically provable gates
pass; remaining blockers are genuinely owner-controlled (license, repo
hosting, npm identity, registry submission, remote attach for CI proof).
Security disposition: SHIP, independently reviewed at `a3fe113` plus
verified deltas through `0c9450e`. Do not publish until the owner acts.

|                    |                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Canonical source   | `b87b0a3dc2d85a3e275978f72e34722f8fe4cd05` (`main`, clean, no remote)                    |
| Implementation SHA | `a3fe113e0f6c7983a7917ae8eae86cce8c19d01a` (security verdict bound here)                 |
| Candidate SHA      | `0c9450e40d225fdb5b9ea4f5c48a870db3bc2ad1` (implementation + docs + review remediations) |
| Release branch     | `release/mcp-corporate-readiness-2026-10-09`                                             |
| Release worktree   | `local-workspace-mcp-release/` (isolated; live hosts run their own install)              |
| Package            | `local-workspace-mcp@0.1.0` · `private: true` · license `UNLICENSED`                     |
| Runtime            | Node ≥20, pnpm 10.18.2 pinned by hash                                                    |

## 1. What this is

Read-oriented, host-neutral MCP server: 14 tools exposing bounded filesystem,
git, and allowlisted named-task capability over operator-authorized workspace
roots. One process per host session over stdio JSON-RPC. No write/edit/delete
tools, no arbitrary shell, no inbound listener, no runtime `npx`.

Architecture: `cli.ts → server.ts (MCP adapter) → {paths, policy, fsOps, git,
tasks, exec, audit, doctor}`. Config file is the trust root and lives outside
every watched root. Full boundary inventory in `docs/THREAT-MODEL.md`.

## 2. Gate ledger

| Gate                               | State           | Evidence                                                                                                                                                                                                                                                          |
| ---------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Source & history integrity      | PASS            | release worktree isolated from `main`; canonical `b87b0a3` → candidate `0c9450e`; all review evidence exact-SHA bound                                                                                                                                             |
| G2 Security assurance              | PASS            | 3-round bounded convergence: F1–F13 → `ddec5e3`; NF-1–NF-6 → `5bde47f`/`a3fe113`; **SHIP at `a3fe113`**; doc/string delta re-verified **SHIP at `0c9450e`**                                                                                                       |
| G3 Functional & negative testing   | PASS            | 169/169 vitest (33-case adversarial suite) at `0c9450e`; baseline 136/136 on `b87b0a3`                                                                                                                                                                            |
| G4 MCP protocol assurance          | PASS            | `scripts/inspector-smoke.sh` — 17/17 on the `0c9450e` build; 14/14 tools, annotations, stdio purity                                                                                                                                                               |
| G5 Supply-chain assurance          | PASS            | `pnpm audit` clean prod+dev; 95 prod components all permissive (83 MIT/7 ISC/2 BSD-3/1 BSD-2); CycloneDX SBOM via `scripts/sbom.mjs`; exact pins + lockfile + `minimum-release-age`                                                                               |
| G6 Developer onboarding            | PASS            | fresh-environment test in isolated synthetic workspace (`/tmp/mcp-onboard`): init-config → doctor → stdio initialize → roots/list/read → denials (`.env`, `.ssh`, traversal) → git_status/diff → task_run allow + TASK_DENIED → malformed/mode-666 config refused |
| G7 Experience assurance            | PASS            | full pipeline GROUND→LANGUAGE→STRUCTURE→STATES→INDEPENDENT SEATS→RENDERED VERIFICATION→VERDICT LEDGER; all Critical/High closed; see §3a                                                                                                                          |
| G8 Independent evaluation          | PASS            | security red team (separate context, exact-SHA): SHIP at `a3fe113`, delta SHIP at `0c9450e`; 4-seat fresh-context docs review (onboarding/security/maintainability/rendered); all findings remediated                                                             |
| G9 Release-package reproducibility | PASS            | `git archive 01d5f94` → frozen-lockfile install → build → typecheck → 169/169 in clean dir; `npm pack` = 22 files (dist+docs+scripts+top-level md); identical code at `0c9450e` (docs/string delta only)                                                          |
| G10 Publication preparation        | PASS            | SECURITY/CONTRIBUTING/CHANGELOG/CI workflow/SBOM/pack metadata prepared; `npm install -g <tarball>` proven; see §6 for held items                                                                                                                                 |
| Remote CI proof                    | NOT_PROVEN      | `.github/workflows/ci.yml` authored with SHA-pinned actions but no remote exists — cannot prove until a remote is attached (owner-controlled)                                                                                                                     |
| License selection                  | BLOCKED (owner) | `UNLICENSED` today; recommendation: MIT (see §6)                                                                                                                                                                                                                  |
| Publication (repo/npm/registry)    | BLOCKED (owner) | intentionally stopped before public visibility; MCP Registry requires a published npm package + `server.json` + `mcpName` — all gated on the license/hosting decision                                                                                             |

Gate states used: PASS / FAILED / NOT_PROVEN / BLOCKED /
NOT_APPLICABLE_WITH_REASON. No gate was weakened to reach green.

## 3. Security audit result

Adversarial round (2026-10-09): **11 findings**, all confirmed by reproduction
then remediated with permanent regression tests. Ledger in
`docs/THREAT-MODEL.md`:

- HIGH ×3: rename-laundered diff leak (S-1), ripgrep output misattribution
  leak (S-2), minimatch ReDoS exposure (S-10).
- MED ×4: absolute-path leaks in errors (S-3, S-8 class), audit-symlink
  append primitive (S-4), name-evasion private-key read (S-5).
- LOW ×4: config ENOENT ergonomics (S-6), `viaSymlink` always-false (S-7),
  unvalidated operator globs + denied-dir descent (S-9), dev-chain
  advisories (S-11).

Independent review (separate execution, exact-SHA bound) ran two rounds:

- **Round 1** on `ec0f23f`: 13 findings (F1–F13) — 1 HIGH (`git show
<blob-sha>` bypassed all deny layers), 4 MED (combined-diff leak,
  head-only key sniff, marker-line-only redaction, task env lacking git
  hardening), 8 LOW/INFO. All remediated at `ddec5e3` with regression
  tests.
- **Verify pass** on `ddec5e3`: 6 findings (NF-1–NF-6) — 1 HIGH (annotated
  tag→blob peeled through the object-type gate), 2 MED (env couldn't
  neutralize repo-local git config → `GIT_CONFIG_*` injection; unbounded
  search key-scan → budgets), 3 LOW. Remediated at `5bde47f` + `a3fe113`
  (hooksPath pin).
- **Convergence + delta sign-off**: SHIP at `a3fe113` — no known
  demonstrable fail-open path to denied content or code execution.

Post-remediation critical/high blockers: **none known**.

## 3a. Experience assurance (Golden Chassis EA pipeline)

Executed per the accepted method; capabilities invoked: ECC
`market-research`/`competitive-platform-analysis` (pinned v2.2.1
`5064474`), ui-craft `clarify`/`heuristic`/`critique`/`unhappy`/`audit`/`harden`
(1.0.0), standalone `humanizer`, plus clean-context subagents as the
qualified substitute for capability execution.

| Phase                 | Result                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GROUND                | `research/audience-corpus.md` — 3 audiences (devs/FDEs, security-conscious leads, OSS maintainers), terminology, trust concerns, alternatives (official `server-filesystem`/`server-git`, Desktop Commander), sources cited                                                                                            |
| POSITIONING           | `research/positioning.md` — Dunford-style evaluation; tagline kept; `task_run` explicitly scoped as bounded real execution, not a sandbox                                                                                                                                                                              |
| LANGUAGE              | humanizer + clarify passes: em-dash tells removed, inflated claims cut, error-doctrine wording verified against implementation                                                                                                                                                                                         |
| STRUCTURE             | heuristic/critique: tool-table completeness, link integrity, `isRegex`→`regex` param fix, tarball provenance, "never authorize `~/`" guidance added                                                                                                                                                                    |
| STATES                | unhappy/audit/harden: host-spawn PATH footgun, strict-JSON examples, `INVALID_ARGUMENT` vs `TASK_DENIED`, timeout semantics (`timedOut:true` vs git `INTERNAL_ERROR`), `init-config` overwrite refusal, non-repo `{repo:false}` — all remediated                                                                       |
| INDEPENDENT SEATS     | 4 fresh-context seats (onboarding, security comprehension, maintainability, rendered readability): 2 High + 4 Med remediated — personal name in shipped `tools/list` description, "no exec tools" overclaim in SECURITY/THREAT-MODEL, missing pnpm prerequisite, asymmetric host configs, contact-less security policy |
| RENDERED VERIFICATION | fences balanced, tables well-formed, all internal links resolve, strict-JSON example parses, commands verified against implementation                                                                                                                                                                                  |
| VERDICT LEDGER        | every finding above closed with regression or doc fix; red-team R1–R7 (fabricated `git_search` message, stderr/timeout wording, stale counts) also closed                                                                                                                                                              |

## 4. Test totals & negative coverage

- 169 tests across 8 files (33 adversarial). Every remediated finding has a
  permanent case; the suite asserts absence of secrets in output, not merely
  error codes.
- Protocol: 14/14 tools advertised, annotations present, stdio purity
  verified (stdout is framed JSON-RPC only).
- Negative coverage: traversal, symlink escape/loop, case/NFC tricks,
  denied paths (`.env`, `.git/config`, `.ssh`), ref option injection,
  metachar injection, unlisted task execution, hostile config modes,
  malformed deny globs, FIFO/large/binary inputs, newline filenames,
  `:N:` directory spoofing, audit symlink writes, process-group timeout.

## 5. Host compatibility matrix

| Host           | Path                                                                         | Status                                                                                                                |
| -------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | `claude mcp add` → user scope, direct stdio                                  | WORKING (registered; SDK v1 line confirmed connected)                                                                 |
| Claude Desktop | `claude_desktop_config.json` mcpServers → same command                       | CONFIGURED (restart required to reload)                                                                               |
| ChatGPT        | `tunnel-client run --profile local-workspace` → outbound HTTPS → stdio spawn | RUNNING (foreground mode; see §7 note)                                                                                |
| Codex CLI      | `[mcp_servers.local-workspace]` in `~/.codex/config.toml` or `codex mcp add` | SUPPORTED natively (stdio; verified against current Codex docs + a live `mcp_servers` entry); not yet registered here |
| MCP Inspector  | `--cli` battery                                                              | PASS 17/17                                                                                                            |

Notes: SDK `@modelcontextprotocol/sdk@1.32.1` (spec ≤ 2025-11-25) chosen for
host interop breadth; v2 line exists but is deliberately not adopted (see
`docs/RESEARCH.md`).

## 6. Distribution artifacts prepared (not published)

- `SECURITY.md` — reporting policy, scope, enforced posture.
- `CONTRIBUTING.md` — RED-first/fail-closed/no-new-capability rules.
- `CHANGELOG.md` — remediation round documented by finding id.
- `.github/workflows/ci.yml` — frozen-lockfile verify pipeline; actions
  pinned by SHA; empty `permissions:`.
- `scripts/sbom.mjs` — reproducible CycloneDX SBOM.
- `.npmrc` — `minimum-release-age=10080` (7-day publication cooldown) +
  `save-exact`.
- `package.json` — private, exact pins, pinned packageManager hash;
  `files` ships `dist`, `docs`, `scripts`, and top-level docs so README
  links resolve inside the tarball (22 files, ~51 kB).
- `research/audience-corpus.md` + `research/positioning.md` — EA GROUND
  evidence artifacts.
- README rewritten for accuracy post-remediation; verified claim-by-claim
  against source by independent review.

**License recommendation (owner decision): MIT.** Rationale: maximal
compatibility for a security tool meant to be adopted in corporate
environments; the dependency tree is uniformly permissive; Apache-2.0 is the
alternative if patent-grant language matters to the owner. `UNLICENSED` +
`private:true` is correct until the owner decides otherwise.

**npm publication identity**: undecided (owner). Recommended first channel:
private GitHub repo + direct `npm install <git-sha>` or scoped private
registry; public npm + MCP registry listing only after owner sign-off.

## 7. Costs, residual risks, limitations

- **Residual risks** (documented in THREAT-MODEL): hardlinks, same-uid
  symlink TOCTOU, git worktree metadata, denied-file _names_ visible in
  listings, prompt injection can steer reads within policy (deny is the
  boundary), per-driver git `diff.<name>.command`/`filter.<name>` hooks
  inside allowlisted tasks on hostile repos (env-unclosable — hooks are
  pinned off; constrain task argv), UTF-16 key-marker laundering
  (heuristic boundary), search-scan budget head-only sniff beyond
  64-file cap.
- **Ops nuance**: the running tunnel uses `tunnel-client run --profile`
  (foreground), not the supervised `runtimes connect` path OPERATIONS.md
  recommends — survivable but not crash-persistent.
- **Not proven**: remote CI (no remote configured), marketplace/host
  certification, legal/license approval.
- **Limitations**: read-only V1 by design; no Windows host testing (POSIX
  path semantics + mkfifo tests are macOS/Linux-shaped); `task_run`
  executes only operator-defined argv — never free text.

## 8. Remaining owner decisions

1. Public visibility & repository host (attaching a remote also unlocks
   remote CI proof — currently NOT_PROVEN).
2. License (recommended: MIT).
3. npm publish identity + scope (`private:true` held until decided; publish
   adds `repository`/`author` fields and a license line).
4. MCP Registry / marketplace submission (requires a published npm package
   first, plus `server.json` + `mcpName` — none created yet, by design).
5. Whether the tunnel should move to supervised `runtimes connect`.
6. Any commercial use authorization.

## 9. Costs

Local work only: agent compute for implementation, three independent
security review rounds, four EA review seats, and one final red-team pass.
No external paid services; no spend beyond model/tooling time.

## 10. Recommended next action

Owner decision meeting on the six items in §8 — the single blocking step
is attaching a remote (repo hosting decision), which also makes remote CI
proof possible. Do not push or publish until the owner acts.
