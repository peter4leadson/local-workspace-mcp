# Research record — 2026-10-05

Primary sources consulted before implementation. Dispositions recorded with
evidence; URLs preserved.

## MCP specification & SDKs

- MCP TypeScript SDK v1 (maintenance line): `@modelcontextprotocol/sdk@1.32.1`
  — implements spec ≤ 2025-11-25; ~76M weekly downloads.
  https://www.npmjs.com/package/@modelcontextprotocol/sdk
- MCP TypeScript SDK v2 (current stable, split packages):
  `@modelcontextprotocol/server@2.3.1` — implements spec 2026-07-28.
  https://www.npmjs.com/package/@modelcontextprotocol/server
  https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/
- **Decision: SDK v1 pinned at 1.32.1.** Rationale: the most-deployed line —
  every reference server and host targets it; spec 2025-11-25 covers tool
  annotations, structuredContent, and everything V1 needs; lowest interop
  risk across Claude Code 2.1.x, Claude Desktop, Inspector, and tunnel-client.
  v2 is the newer line but adopting a months-young API for a security boundary
  trades reliability for recency without a feature need.
- MCP Inspector: `@modelcontextprotocol/inspector@2.9.0` (`--cli` mode used
  for the reproducible smoke battery). https://www.npmjs.com/package/@modelcontextprotocol/inspector

## Reuse evaluation → `CUSTOM_REQUIRED`

Evaluated `@modelcontextprotocol/server-filesystem@2026.7.10` (official
reference server, `github.com/modelcontextprotocol/servers`):
https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/filesystem/index.ts
https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/filesystem/lib.ts

Gaps vs required contract:

- write/edit/move/create tools enabled unconditionally — violates "V1
  read-oriented, no mutation surface"; cannot be disabled by config;
- no sensitive-file denylist (`.env`, keys, creds readable);
- no git tools, no named-task execution — the tools that motivate this server;
- flat allowed-dirs, no workspace-id namespacing/metadata contract;
- no bounded structured responses with truncation metadata.
  Wrapping it would hide rather than remove the write surface — effectively a
  fork, which the brief disallows. **Adopted** its containment technique instead:
  realpath allowed roots at startup (both configured + resolved forms), resolve
  then realpath the target, re-verify containment; Unicode-NFC equivalence on
  path components; Windows-drive rejection on POSIX.

## OpenAI Secure MCP Tunnel — exists, official path used

- Guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- Repo + onboarding: https://github.com/openai/tunnel-client ,
  `docs/onboarding.md`, `docs/architecture.md`, `docs/end-user-guide.md`
- Release used: v0.0.15 (2026-09-25), `tunnel-client-v0.0.15-darwin-arm64.zip`,
  SHA256 verified against published `SHA256SUMS.txt`
  (b2cae3aa9df45b4c2fe9b1d700ebacce39f9feb6a6b46b86e6499f9a51bf72ff).
- Facts established: `--mcp-command` targets a stdio server command;
  `init` writes named profiles; `doctor --explain` gives structured missing-
  item diagnostics; health surfaces `/healthz` `/readyz` `/metrics` `/ui` on
  loopback; `runtimes connect` is the supported supervised local runtime
  (explicitly preferred over nohup/disown); runtime is cloudflared-backed but
  all tunnel traffic is outbound-only; no inbound listener anywhere.
- Prerequisites that are owner-controlled: `tunnel_id` (Platform →
  settings/organization/tunnels) and a runtime API key with Tunnels Read+Use.
- Optional Codex plugin installed: `tunnel-client codex plugin install`.

## Anthropic / Claude

- `claude mcp add <name> --scope user -- <cmd> serve --stdio` — verified live
  on Claude Code 2.1.280; `claude mcp list` shows `✔ Connected`.
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
  `mcpServers` map; same stdio command (no second implementation).

## OWASP

- MCP Security Cheat Sheet:
  https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html
- OWASP MCP Top 10 (MCP01 token/secret exposure → MCP10 context injection):
  https://owasp.org/www-project-mcp-top-10/
- Applied: least privilege (read-only + allowlist tasks), fail closed
  (explicit error classes), audit metadata only, no tool-poisoning surface in
  V1 (descriptions are static, no dynamic content injection into tool defs).

## Multimodal round — 2026-10-11

Decoder/parser selection (all adopted after API spikes against synthetic
fixtures):

- `image-size@2.0.4` — magic-byte type+dimension sniffing; pure JS, zero
  deps, MIT. Chosen over hand-rolled JPEG SOF walking.
- `sharp@0.35.5` — libvips decode/encode/resize/composite; `limitInputPixels`
  bomb guard; Apache-2.0. Prebuilt optional deps — no build-script approval
  needed. Verified: SVG rasterizes; libvips refuses `file://` image refs at
  the raster layer too (defense in depth behind our own scan).
- `yauzl@3.4.0` — reference lazy random-access ZIP reader (central directory
  only, one member streamed at a time). Its own filename validation
  (`invalid relative path`) fires at enumeration when `decodeStrings:true`;
  we run `decodeStrings:false` so hostile names are _flagged_ in listings
  rather than aborting enumeration, and gated independently at preview.
- `@hyzyla/pdfium@2.1.13` — PDFium (Chromium's PDF engine) compiled to WASM:
  page render → BGRA bitmap → PNG via sharp; text extraction via `getText()`.
  Memory sandbox, no JS execution, no remote fetch, no native dep.
  `@hyzyla/pdfium@3.0.0` (published 2026-10-10) was refused by
  `minimum-release-age=10080`; 2.1.13 pinned instead.
- `yazl@3.3.1` (dev) — synthetic ZIP fixtures; refuses hostile member names
  at write time, so traversal fixtures are produced by byte-patching
  same-length member names post-build.

Native-block + host-boundary findings:

- MCP `ImageContent` (`{type:"image", data:b64, mimeType}`) is spec-native;
  verified byte-identical over real stdio JSON-RPC and InMemoryTransport.
- `tunnel-client` (v0.0.15) forwards tool responses verbatim —
  `payload.JSONResponse = rawResponse` in the `/v1/tunnels/{id}/response`
  path; no client-side content filtering. The 100 KiB
  `DefaultHarpoonMaxResponseBytes` cap applies only to tunnel-client's
  built-in harpoon HTTP-fetch tool, NOT MCP responses.
- Community reports (modelcontextprotocol discussion + openai/codex#5600
  thread): ChatGPT's connector layer has historically dropped `image`
  blocks — returning `{}` or text-serialized base64 where MCP Inspector
  renders the same call correctly. Codex CLI ≥0.157 merged explicit MCP
  image→model support. **Conclusion:** server emits spec-native image blocks
  AND complete text/structured metadata on every image tool; ChatGPT
  visual delivery is a separate acceptance checkpoint (see spec §Host
  boundary honesty) and must never be claimed from Inspector alone.
