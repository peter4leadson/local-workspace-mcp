# Audience corpus — local-workspace-mcp (GROUND phase artifact)

Provenance: compiled 2026-10-09 by a clean-context subagent executing the
pinned ECC `market-research` + `competitive-platform-analysis` skills
(v2.2.1 @ 5064474). All claims sourced; `[inference]`/`[unverified]` flags
preserved verbatim. Method note: web_search extracts only, no webfetch;
spot-verification items listed at the end.

## Audience 1 — PRIMARY: engineers using AI coding assistants on live workspaces

Role: individuals running Claude Code, Cursor, Windsurf, Claude Desktop,
Codex, Gemini CLI against real repos.

Vocabulary (sourced): "MCP server", "tool calls", "permission prompts",
`--dangerously-skip-permissions`, "allow rules", `settings.local.json`,
`additionalDirectories`, `acceptEdits`, `claude mcp add`, `/mcp`, "npx -y",
"context tax" / "eating your context window" / "tool definitions".

Documented pains:

- Permission fatigue is the loudest: "Constantly forced to click 'yes' on
  every single edit" (claude-code #36168); "approving 30-50+ individual
  commands... 2-4 hours of babysitting" (#32559); "It keeps prompting me...
  every 15 seconds" (#2560).
- Token tax: "Every MCP server you connect injects all of its tool schemas
  into every request... 41k tokens of pure schema" (dev.to/mcp-tax);
  Anthropic tool-search docs: ~55k tokens for a 5-server setup.
- Redundancy skepticism: "Filesystem and Git — These are built into Claude
  Code. They handle 80% of my daily work" (BSWEN). Counter-case: filesystem
  MCP cited for cross-project reads ("look at how I solved this in another
  repo", TopInsight).

Install expectations: one-line `npx -y <pkg>` or `claude mcp add`; JSON block
in host config; full client restart; verify with `/mcp` / `claude mcp list`.
First smoke test: "list files in my vault" / list a directory, read a file,
`git status`, grep a symbol.

Adopt if: zero-friction install; removes fear rather than adding it; small
tool list (low context tax); `readOnlyHint` set so hosts can auto-approve
reads (Anthropic MCPB guidance).
Reject if: duplicates built-ins with no added boundary; another `npx -y`
package from an unknown maintainer; write tools "just in case"; vague
security claims.

## Audience 2 — SECONDARY: security-conscious engineering leads

Vocabulary (sourced): "confused deputy" (Willison), "lethal trifecta" —
private data + untrusted content + exfiltration vector (Willison Jun 2025),
"tool poisoning", "rug pull", "tool shadowing" (Invariant Labs), "toxic agent
flow", "line jumping", "TOFU pinning" (Trail of Bits), "blast radius",
"least privilege", "default-deny", `allowedMcpServers`/`managed-mcp.json`,
"vetting checklist", "supply chain dependency".

Evaluator stance (Cerbos): "treat each MCP server as a third-party supply
chain dependency with access to production... bound what any server can do
regardless of how much you trust it."

What they check (codebasing/Cerbos/Drel/Appsecco): provenance and pinned
versions (no floating `@latest`); scoped permissions justified; tool
descriptions audited as instruction content; static analysis for command
injection/path traversal/SSRF; dependency CVEs; audit trail; drift detection
via tool-description hashing; stdio processes run as non-root without ambient
credentials.

What kills adoption: `npx -y` unaudited package with no SECURITY.md; env
passthrough of `AWS_*`/`GITHUB_TOKEN`; HTTP transports without auth (Pluto:
147 unauthenticated MCPs found exposed); no documented threat model;
write/exec tools justified only by convenience.

What builds trust in THIS product: published threat model; SECURITY.md
disclosure policy; verifiable `tools/list` showing no write/exec surface;
realpath-containment path validation with symlink tests in CI; no inbound
listener; pinned releases; stderr/JSONL audit trail; explicit task-allowlist
scope statement.

## Audience 3 — TERTIARY: OSS maintainers / integrators

Checks (part inference): MIT/Apache-2.0 license expectation (official fs
server, mcp-server-git, Desktop Commander are MIT; cyanheads Apache-2.0);
maintenance status and bus factor (May 2025 archiving of 14 reference servers
into `servers-archived` is the canonical cautionary tale); protocol compat
friction (mcp-server-git pins `mcp>=1.29.0,<2` because "SDK 2.0 renamed
APIs"); registry presence (official MCP Registry preview launched
2025-09-08); Glama-style automated scoring checks credential-path access —
denylist defaults register as a positive signal there.

## Trust & rejection triggers (cross-audience)

Documented MCP concerns: prompt injection via tool output (Willison), tool
poisoning/rug pulls (Invariant PoCs), toxic-agent-flow exfiltration
(official GitHub MCP incident), supply-chain (`npx -y` install trust, CVE-
2025-6514 mcp-remote command injection), exfiltration risk, "MCP runs as
you" discourse, 147 unauthenticated public MCPs (Pluto).

## Competitive landscape (pruned, tiered)

| Alternative | Tier | Permission model | Notes |
|---|---|---|---|
| @modelcontextprotocol/server-filesystem | Direct | read+write; allowed dirs via argv/roots; **no default secrets denylist** | ~411-669k wk npm dl; .env overwrite incident #1869; fix PR #1901 closed unmerged |
| @j0hanz/filesystem-mcp | Direct — closest pitch | read+write with `--read-only` flag; `.env`/`*.pem`/`id_rsa` denylist + `--deny`/`--allow`; symlink-escape prevention; RE2 search | popularity unverified |
| project-files-readonly-mcp | Direct | structurally read-only; lexical+realpath double boundary; blocks `.git`/`.env`/keys | Windows-oriented, document focus |
| Desktop Commander | Direct capability, opposite posture | read+write+terminal exec; `allowedDirectories` + `blockedCommands`; self-documents "not a sandbox", symlink bypass (issue #420) | ~9.5k stars; 325k+ wk dl (self-claim) |
| codemcp | Adjacent — task-allowlist precedent | predeclared commands in `codemcp.toml`; own warning: "Anyone with access to this MCP can perform arbitrary code execution" | git-versions LLM edits |
| mcp-server-git (PyPI) | Adjacent | git read+manipulate incl. commit; source archived 2025-05 but still ships | ~774k dl/mo |
| cyanheads/git-mcp-server | Adjacent | full git incl. push/reset/clean; `GIT_BASE_DIR`; "no shell interpolation" | ~7.1k wk |
| Host built-ins (Claude Code permissions etc.) | **Substitute — the real rival** | permission modes, `permissions.allow/ask/deny` (documented `.env` Read deny), `additionalDirectories`, managed allowlists | zero install; boundary lives client-side and is routinely bypassed under fatigue |

Honest gap: nobody else combines bounded roots + default-deny secrets +
read-only git + allowlisted named tasks + metadata audit in one small stdio
server. "Read-only + denylist" alone is already occupied — differentiate on
the *invariant* (write/exec code does not exist in the process), the git read
surface, the task allowlist, and demonstrated adversarial testing.

## Language corpus

Terms of art to use correctly: stdio transport, Streamable HTTP, JSON-RPC,
`tools/list`/`tools/call`, MCP roots, tool annotations (`readOnlyHint`,
`destructiveHint`, `openWorldHint`), allowlist/denylist, default-deny,
fail-closed, least privilege, confused deputy, exfiltration vector, blast
radius, path traversal (CWE-22), realpath containment, TOFU pinning, rug
pull, tool poisoning, supply chain, provenance/Sigstore, SBOM, sandbox
(only if literally true).

Hallmark voice of credible security tools (emulate): limitation-forward
("Directory access controls exist but have known bypass vulnerabilities" —
DC FAQ; "This server has no authentication... Do not expose this server to
the internet" — sesopenko); mechanism claims not adjectives ("validated
against allowed roots", "realpath + lexical double boundary check", "no
shell interpolation", "linear-time matching"); imperative scoping advice
("never point it at ~/").

Banned: supercharge, seamless, unlock the power of, revolutionary,
enterprise-grade (unqualified), "secure by design" (claim the mechanism),
"your data stays safe", rocket emoji, "blazing fast" on a security tool —
and specifically: never claim "no code execution", "sandboxed", or
"air-gapped" while `task_run` exists.

## Spot-verification items (do before quoting publicly)

- Whether server-filesystem PR #1012 (default `.git`/`node_modules`
  exclusions) actually merged.
- Current npm stats for @j0hanz/filesystem-mcp and
  project-files-readonly-mcp.
- Maintenance state of mcp-server-git source post-archive.
- vulnerablemcp.info "~82% CWE-22" stat — secondhand; do not quote.

## Sources

Full URL list with relevance notes lives in the subagent report (session
evidence); primary anchors: github.com/modelcontextprotocol/servers{,-archived},
issues #1869 / PR #1901 / PR #1012; github.com/wonderwhy-er/DesktopCommanderMCP
(README/FAQ/#420); github.com/ezyang/codemcp; simonwillison.net lethal-trifecta;
invariantlabs.ai MCP posts; trailofbits.com MCP; code.claude.com managed-mcp
and permissions docs; anthropics/claude-code issues #36168/#32559/#2560;
glama.ai methodology; modelcontextprotocol.io registry docs.
