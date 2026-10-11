# Release decision record — local-workspace-mcp 0.2.0

Status: **RELEASE CANDIDATE — pending owner authorization** (2026-10-11).
Not published, not tagged, not merged. This record is repository-internal
and deliberately excluded from the npm tarball.

> Scope note: this is the 0.2.0 record. The frozen 0.1.0 packet lives in
> `docs/RELEASE-PACKET.md` and is not modified by this document.

## Candidate identity

| Item                 | Value                                                         |
| -------------------- | ------------------------------------------------------------- |
| Branch / PR          | `feat/multimodal-file-access` — PR #1                         |
| Release-reviewed SHA | `5fda776` (code; HEAD adds docs-only commits — see §Security) |
| package.json version | `0.2.0`                                                       |
| server.json version  | `0.2.0`                                                       |
| MCP `initialize`     | `local-workspace-mcp 0.2.0`, protocol `2025-11-25`            |
| Tool count           | 23 (14 baseline + 9 media/document tools)                     |
| Prior release        | `0.1.0` — npm `latest`, SHA `8affca9`, tag `v0.1.0`           |

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
| Tests                                | PASS   | `pnpm test` — 275/275 (11 files) at `5fda776`; 71 media + 14 red-team + 33 adversarial cases                                                                               |
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
| ChatGPT via tunnel      | PENDING     | datapath verified (`initialize` 0.2.0 + `tools/call` forwarded, HTTP 200); connector catalog retains a 14-tool snapshot — see below |
| Windows                 | UNSUPPORTED | `os` field + `doctor` platform check; POSIX kill/`/dev/null` semantics have no equivalent                                           |

### ChatGPT connector state — PENDING_CONNECTOR_REFRESH

The OpenAI connector backend retains a stale 14-tool catalog. Local
evidence: `tools/list` is never forwarded to the child in this flow; the
daemon skips stdio startup probing; `notifications/tools/list_changed`
(emitted since `3a81d09`) is not acted on by the backend. The tunnel
datapath itself is verified healthy (0.2.0 child, forwarded calls succeed).

User-facing recovery: ChatGPT → Settings → Connectors → "Local Workspace"
→ edit/re-save (or toggle off/on); if the catalog remains stale, remove
and re-create the connector. **No ChatGPT multimodal acceptance is claimed
until 23 tools are exposed and a synthetic `fs_image` canary is consumed
as actual visual input.**

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

## Decision

**HOLD pending one item:** owner authorization to tag/publish. ChatGPT E2E
is **not** a ship-blocker — it is a documented host-compat limitation,
not a server defect.

Rollback plan if 0.2.0 must be withdrawn after publish: `npm deprecate`
the version with a pointer, `dist-tag latest → 0.1.0`, registry entry
remains versioned (0.1.0 stays `isLatest` until a republish marks 0.2.0).
