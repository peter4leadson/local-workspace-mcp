# Release decision record — local-workspace-mcp 0.2.0

Status: **RELEASE CANDIDATE — pending owner authorization** (2026-10-11).
Not published, not tagged, not merged. This record is repository-internal
and deliberately excluded from the npm tarball.

> Scope note: this is the 0.2.0 record. The frozen 0.1.0 packet lives in
> `docs/RELEASE-PACKET.md` and is not modified by this document.

## Candidate identity

| Item                 | Value                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Branch / PR          | `feat/multimodal-file-access` — PR #1                                                                                                     |
| Release-reviewed SHA | `ca500f4` (PR head; src code `891ec53` + test-only tmpdir fix — supersedes `5fda776`; see §Golden Chassis) |
| package.json version | `0.2.0`                                                                                                                                   |
| server.json version  | `0.2.0`                                                                                                                                   |
| MCP `initialize`     | `local-workspace-mcp 0.2.0`, protocol `2025-11-25`                                                                                        |
| Tool count           | 23 (14 baseline + 9 media/document tools)                                                                                                 |
| Prior release        | `0.1.0` — npm `latest`, SHA `8affca9`, tag `v0.1.0`                                                                                       |

## What's new (user-facing)

Nine read-only tools for visual and document artifacts: `fs_inspect`,
`fs_image` (native MCP `image` block), `fs_contact_sheet`,
`fs_archive_list`, `fs_archive_entry`, `fs_pdf_info`, `fs_pdf_page`,
`fs_pdf_text`, `fs_office_text`. All flow through the same
containment + deny-policy + content-class gates as the base tools, plus
media-specific resource bounds. Full design: `docs/MULTIMODAL-SPEC.md`;
threat-model ledger: `docs/THREAT-MODEL.md`.

## Gate evidence (exact-SHA bound)

| Gate                                 | Result | Evidence                                                                                                                                                                   |
| ------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests                                | PASS   | `pnpm test` — 276/276 (11 files) at `ca500f4`, CI green on exact SHA; includes audit-target regression from seat remediation                                                                      |
| Typecheck / build                    | PASS   | `tsc --noEmit`, `tsc -p tsconfig.json` clean                                                                                                                               |
| Dependency audit                     | PASS   | `pnpm audit --prod` — no known vulnerabilities                                                                                                                             |
| Independent review (rounds 1–3)      | PASS   | `2f192ff` R-1..R-11 remediated `a1cf413`; `7e98769` N-1..N-8 verified SHIP; V/F-rounds closed `b4cc053`                                                                    |
| Independent red team (round 4)       | PASS   | `b4cc053` → DO_NOT_SHIP (narrow): RT-1/RT-3 demonstrated defeats + RT-2/RT-4 — all fixed in `070e932`                                                                      |
| Independent re-review of remediation | PASS   | clean-context verify on `070e932` → SHIP; residuals closed at `08f326f`                                                                                                    |
| Final independent verification       | PASS   | clean-context verify on `08f326f` → REMEDIATE (narrow): tail-window eviction; fixed `5fda776`, focused re-verify → CLOSED (code-verified, repro pinned by regression test) |
| ATAM architecture review             | PASS   | adequate-for-release verdict, no blocking findings; 5 required mitigations all closed in `070e932`                                                                         |
| Packaged install                     | PASS   | `npm pack` tarball → isolated unprivileged prefix; `workspace-mcp doctor` green; 23 tools via stdio                                                                        |
| Node support                         | PASS   | verified 20.11 / 22.12 / 24.21 (declared `>=20`); `engines` + `os:[darwin,linux]` in package.json                                                                          |
| Native deps                          | PASS   | sharp prebuilds on macOS-arm64 + linux-x64 (container check); pdfium.wasm loads; no install scripts                                                                        |
| Rollback                             | PASS   | `npm i -g local-workspace-mcp@0.1.0` installs, initializes, serves 14 tools                                                                                                |
| Denials                              | PASS   | OUTSIDE_ROOT / ACCESS_DENIED / traversal / symlink / `.env`-class paths refused on the installed package                                                                   |
| Stray writes                         | PASS   | no filesystem writes outside the workspace-scoped call paths observed during install+smoke                                                                                 |

## Host verification

| Host                    | Status      | Evidence / gap                                                                                                                      |
| ----------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| stdio MCP clients       | VERIFIED    | real wire-level smoke: 23 tools, byte-identical `image` block, correct `structuredContent`                                          |
| MCP Inspector           | VERIFIED    | 16/17 battery (1 env-specific `task_list` skip); `fs_image` image block rendered                                                    |
| Claude Code / Codex CLI | SUPPORTED   | stdio wiring per README; image consumption is host-model dependent (spec-native blocks)                                             |
| ChatGPT via tunnel      | VERIFIED    | Live ChatGPT 23/23-tool discovery and native `fs_image` synthetic canary visually interpreted (2026-10-11); PDF/Office individual samples not yet run in ChatGPT |
| Windows                 | UNSUPPORTED | `os` field + `doctor` platform check; POSIX kill/`/dev/null` semantics have no equivalent                                           |

### ChatGPT connector state — VERIFIED (2026-10-11)

The previously cached 14-tool snapshot was refreshed. In a live ChatGPT
conversation the connected tool registry exposed all 23 tools, including
`fs_image`, `fs_pdf_page`, and `fs_office_text`. A real `workspace_roots`
call succeeded. An `fs_image` call returned a native `image/png` MCP image
block and structured metadata from the synthetic
`auto-local-workspace-mcp-5ae5945/.tmp-e2e/canary-7f3.png` fixture:
512×512 pixels, 20,122 bytes, SHA-256
`c54e65d2c45e3954e3ae9f47d9299b2d52bbf338db3b468dec9bd93f71b6e458`.
The ChatGPT model independently identified the pixels: magenta field, cyan
ring, lime triangle, white “47” and black “QX”. Those visual elements were
not contained in file metadata. **ChatGPT native image delivery: PASS.**

The tool registry also exposes PDF and OOXML operations; individual
ChatGPT-side rendering/extraction samples remain **NOT TESTED**. Tool-catalog
refresh may still be required after future tool-schema changes.

## Supply chain

- 7 runtime deps, exact-pinned, committed lockfile, `minimum-release-age=10080`,
  `save-exact`, `packageManager` sha512 pin.
- Licenses: MIT/BSD/ISC/Apache-2.0/BlueOak-1.0.0 across the tree;
  `@img/sharp-libvips-*` binaries are LGPL-3.0-or-later (dynamically loaded
  prebuilt native libs — noted for the release notes).
- `@hyzyla/pdfium` is a community WASM repackage of Chromium PDFium —
  lockfile guarantees artifact integrity; publisher trust is a noted
  residual (documented in ATAM findings).
- SBOM: `node scripts/sbom.mjs` → CycloneDX 1.5, 130 components.
- Publication path: GitHub Actions `publish.yml` → OIDC trusted publishing
  (no long-lived npm token) + `scripts/release-check.js` fail-closed gate.

## Known residuals (all documented in docs/THREAT-MODEL.md)

In-process native raster decode (libvips memory-safety), SVG
scan-not-sandbox posture, content-marker scope (key armor only, not
general secrets), ~64-file search-scan budget, TOCTOU/hardlink
attacker-in-root exclusions, sync-WASM unpreemptibility inside one call.

## Golden Chassis EA pass (strict, 2026-10-11)

Real pinned skills invoked one at a time — ECC v2.2.1 `5064474`, ui-craft
1.0.0, standalone humanizer — on code SHA `5fda776` → remediated at
`098d6c4`/`891ec53`. Independent seats are fresh-context `codex exec`
processes (read-only repo, scratch-confined), not self-certification.

| Stage       | Skill                             | Result                                                                                                                                                                                                                                                                                                                                                |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GROUND      | market-research                   | 0.2.0 multimodal competitive delta appended to `research/audience-corpus.md` (official `read_media_file`, read-only fs servers, FileCommander, host image matrix)                                                                                                                                                                                     |
| GROUND      | competitive-platform-analysis     | tiered competitor set + scoring matrix appended (superseding, not rewriting, the frozen 0.1.0 analysis)                                                                                                                                                                                                                                               |
| POSITIONING | Dunford-style eval                | `research/positioning.md` 0.2.0 section — bounded-media differentiation, task disclosure preserved                                                                                                                                                                                                                                                    |
| PATTERNS    | mcp-server-patterns               | all 23 `registerTool` + zod schemas + transport separation + `CODE: message` + honest annotations + SDK pin — **no findings**                                                                                                                                                                                                                         |
| LANGUAGE    | humanizer                         | full tell-scan over shipped docs — no rewrite targets; em-dashes are functional separators (0.1.0 precedent)                                                                                                                                                                                                                                          |
| LANGUAGE    | ui-craft `clarify`                | 1 fix: `init-config` refusal now names recovery (`098d6c4`); errors/verbs/confirmations otherwise clean                                                                                                                                                                                                                                               |
| STRUCTURE   | ui-craft `heuristic`              | scorecard: Nielsen mean 4.1, UsabilityScore 73/C → **Miller's Law FAIL** (14-section README, no TOC) → fixed; recomputed 78                                                                                                                                                                                                                           |
| STRUCTURE   | ui-craft `critique`               | 2 findings closed: ~90-word ChatGPT table cell slimmed (claims moved to prose), mini-TOCs added to OPERATIONS + THREAT-MODEL                                                                                                                                                                                                                          |
| STATES      | ui-craft `unhappy`                | 1 finding closed: media `TIMEOUT` code was live but undocumented — added to error enumeration + troubleshooting row                                                                                                                                                                                                                                   |
| STATES      | ui-craft `audit`                  | a11y/perf/responsive clean at 320/375/768/1440 light+dark; 0px page overflow; tables scroll internally (correct GFM)                                                                                                                                                                                                                                  |
| STATES      | ui-craft `harden`                 | 9-item matrix + docs-page archetype coverage — all present/not-needed; no fixes                                                                                                                                                                                                                                                                       |
| SECURITY    | security-review + G5 supply-chain | secrets sweep clean on committed+working diffs; `pnpm audit` (prod+dev) clean; 106 licenses (1 LGPL libvips, documented); CycloneDX SBOM 130 components; exact pins + committed lockfile + `minimum-release-age=10080`                                                                                                                                |
| SEATS       | 4 fresh-context codex exec        | A onboarding **FAIL** → 3 fixed; B security-comprehension **FAIL** → 2 MAJOR + 1 MINOR fixed (incl. `auditTarget()` code fix + regression); C maintainability **PASS** (2 MINOR fixed); D rendered **FAIL** → both findings verified as artifact false-positives (API fragment lacks heading ids by design; `text` fences render classless by design) |
| RENDERED    | mechanical checks                 | 26/26 TOC anchors valid under github-slugger; all internal links resolve; fences balanced+tagged; strict-JSON parses; 16 PNGs in `research/rendered/0.2.0/`; 0px overflow probes                                                                                                                                                                      |
| RE-VERIFY   | focused codex exec                | **CLOSED** — all 8 closure items confirmed on `891ec53` with file:line evidence; no new claim contradictions                                                                                                                                                                                                                                          |

**Code-level changes from this pass** (beyond docs): `src/server.ts`
`auditTarget()` — audit `target` no longer stores caller-supplied absolute
host paths (in-root → relativized, other → `<abs>/<basename>`), regression
tested; `src/cli.ts` — `init-config` refusal names the recovery action.
275→276 tests.

## Decision

**OWNER AUTHORIZATION (2026-10-11):** The owner requested the 0.2.0
publication update following creation of a new ChatGPT plugin icon. The
release is approved to proceed through controlled merge, exact-main-SHA CI,
verified `v0.2.0` tag and npm OIDC staged publication. The staged npm version
still requires the owner's account-side 2FA approval; no tool or agent may
bypass that gate. A public ChatGPT plugin-directory submission is a separate
process and is not authorized by this npm/MCP Registry release decision.

Rollback plan if 0.2.0 must be withdrawn after publish: `npm deprecate`
the version with a pointer, `dist-tag latest → 0.1.0`, registry entry
remains versioned (0.1.0 stays `isLatest` until a republish marks 0.2.0).
