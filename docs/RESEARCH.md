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
