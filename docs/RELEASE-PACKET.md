# Release decision pack — local-workspace-mcp

Status: HOLD — pending independent-review incorporation and owner decisions.

| | |
|---|---|
| Canonical source | `b87b0a3dc2d85a3e275978f72e34722f8fe4cd05` (`main`, clean, no remote) |
| Candidate SHA | `ec0f23fcd65071a83fbed37a74850d46f7248336` |
| Release branch | `release/mcp-corporate-readiness-2026-10-09` |
| Release worktree | `local-workspace-mcp-release/` (isolated; live hosts still run source dist) |
| Package | `local-workspace-mcp@0.1.0` · `private: true` · license `UNLICENSED` |
| Runtime | Node ≥20, pnpm 10.18.2 pinned by hash |

## 1. What this is

Read-oriented, host-neutral MCP server: 14 tools exposing bounded filesystem,
git, and allowlisted named-task capability over operator-authorized workspace
roots. One process per host session over stdio JSON-RPC. No write/edit/delete
tools, no arbitrary shell, no inbound listener, no runtime `npx`.

Architecture: `cli.ts → server.ts (MCP adapter) → {paths, policy, fsOps, git,
tasks, exec, audit, doctor}`. Config file is the trust root and lives outside
every watched root. Full boundary inventory in `docs/THREAT-MODEL.md`.

## 2. Gate ledger

| Gate | State | Evidence |
|---|---|---|
| Baseline reproduction | PASS | 159/159 vitest on candidate; baseline 136/136 on `b87b0a3` |
| RED-before-fix adversarial suite | PASS | `tests/adversarial.test.ts` — 23 cases, 11 reproduced real defects pre-fix |
| Defect remediation | PASS | all 9 code findings closed (`d3e0db2`); regression tests permanent |
| Supply-chain audit | PASS | `pnpm audit` clean prod+dev; minimatch→10.2.6, vitest→4.1.11 (`bdbdb28`) |
| License audit (deps) | PASS | 95 prod components: 83 MIT / 7 ISC / 2 BSD-3 / 1 BSD-2; zero copyleft |
| Pack contents | PASS | 13 files: `dist/*.js` + README + package.json — no src/tests/secrets |
| MCP protocol (Inspector) | PASS | `scripts/inspector-smoke.sh` — 17/17 on candidate build |
| Doctor diagnostics | PASS | ALL GREEN (roots, git/rg, tasks, policy selftest, registration) |
| Fresh-install acceptance | PASS | `git archive` → frozen-lockfile install → build → 159/159 |
| SBOM | PASS | `scripts/sbom.mjs` → CycloneDX 1.5, 95 components |
| CI remote proof | NOT_PROVEN | workflow authored (`.github/workflows/ci.yml`) but no remote exists — cannot execute until a remote is attached |
| Independent review | IN PROGRESS | clean-context review of `ec0f23f` running; findings pending |
| License selection | BLOCKED (owner) | `UNLICENSED` today; recommendation: MIT (see §6) |
| Publication | BLOCKED (owner) | intentionally stopped before public visibility |

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

Post-remediation critical/high blockers: **none known**. Independent review
may add findings — this pack must be updated with its verdict before any
release claim.

## 4. Test totals & negative coverage

- 159 tests across 8 files (23 adversarial). Every remediated finding has a
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

| Host | Path | Status |
|---|---|---|
| Claude Code | `claude mcp add` → user scope, direct stdio | WORKING (registered; SDK v1 line confirmed connected earlier) |
| Claude Desktop | `claude_desktop_config.json` mcpServers → same command | CONFIGURED (restart required to reload) |
| ChatGPT | `tunnel-client run --profile local-workspace` → outbound HTTPS → stdio spawn | RUNNING (PID 5249, foreground mode; see §7 note) |
| Codex | no direct `mcp_servers` entry | NOT CONFIGURED — reachable only if a Codex tunnel plugin is used; document as unsupported-by-default |
| MCP Inspector | `--cli` battery | PASS 17/17 |

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
- `package.json` — private, exact pins, pinned packageManager hash.
- README rewritten for accuracy post-remediation.

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
  symlink TOCTOU, git worktree metadata, denied-file *names* visible in
  listings, prompt injection can steer reads within policy (deny is the
  boundary).
- **Ops nuance**: the running tunnel uses `tunnel-client run --profile`
  (foreground), not the supervised `runtimes connect` path OPERATIONS.md
  recommends — survivable but not crash-persistent.
- **Not proven**: remote CI (no remote configured), marketplace/host
  certification, legal/license approval.
- **Limitations**: read-only V1 by design; no Windows host testing (POSIX
  path semantics + mkfifo tests are macOS/Linux-shaped); `task_run`
  executes only operator-defined argv — never free text.

## 8. Remaining owner decisions

1. Public visibility & repository host.
2. License (recommended: MIT).
3. npm publish identity + scope.
4. MCP registry / marketplace submission.
5. Whether the tunnel should move to supervised `runtimes connect`.
6. Any commercial use authorization.

## 9. Recommended next action

Incorporate the independent-review findings (running against `ec0f23f`);
if clean, mark that gate PASS and hand the owner this pack for the six
decisions above. Do not push or publish until the owner acts.
