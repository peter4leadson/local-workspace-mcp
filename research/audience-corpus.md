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

| Alternative                                   | Tier                                | Permission model                                                                                                                 | Notes                                                                            |
| --------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| @modelcontextprotocol/server-filesystem       | Direct                              | read+write; allowed dirs via argv/roots; **no default secrets denylist**                                                         | ~411-669k wk npm dl; .env overwrite incident #1869; fix PR #1901 closed unmerged |
| @j0hanz/filesystem-mcp                        | Direct — closest pitch              | read+write with `--read-only` flag; `.env`/`*.pem`/`id_rsa` denylist + `--deny`/`--allow`; symlink-escape prevention; RE2 search | popularity unverified                                                            |
| project-files-readonly-mcp                    | Direct                              | structurally read-only; lexical+realpath double boundary; blocks `.git`/`.env`/keys                                              | Windows-oriented, document focus                                                 |
| Desktop Commander                             | Direct capability, opposite posture | read+write+terminal exec; `allowedDirectories` + `blockedCommands`; self-documents "not a sandbox", symlink bypass (issue #420)  | ~9.5k stars; 325k+ wk dl (self-claim)                                            |
| codemcp                                       | Adjacent — task-allowlist precedent | predeclared commands in `codemcp.toml`; own warning: "Anyone with access to this MCP can perform arbitrary code execution"       | git-versions LLM edits                                                           |
| mcp-server-git (PyPI)                         | Adjacent                            | git read+manipulate incl. commit; source archived 2025-05 but still ships                                                        | ~774k dl/mo                                                                      |
| cyanheads/git-mcp-server                      | Adjacent                            | full git incl. push/reset/clean; `GIT_BASE_DIR`; "no shell interpolation"                                                        | ~7.1k wk                                                                         |
| Host built-ins (Claude Code permissions etc.) | **Substitute — the real rival**     | permission modes, `permissions.allow/ask/deny` (documented `.env` Read deny), `additionalDirectories`, managed allowlists        | zero install; boundary lives client-side and is routinely bypassed under fatigue |

Honest gap: nobody else combines bounded roots + default-deny secrets +
read-only git + allowlisted named tasks + metadata audit in one small stdio
server. "Read-only + denylist" alone is already occupied — differentiate on
the _invariant_ (write/exec code does not exist in the process), the git read
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

---

## Delta — 0.2.0 multimodal round (2026-10-11)

Provenance: compiled per the same pinned ECC `market-research` method
(v2.2.1 @ 5064474) against the 0.2.0 scope — bounded multimodal inspection
(images, contact sheets, ZIP, PDF, OOXML) inside the existing security
boundary. Sources listed per-claim.

### Market movement since the 0.1.0 corpus

- **The official reference server now ships media.** `read_media_file`
  streams any file and returns image/audio as native `image`/`audio`
  content blocks (embedded `resource` otherwise)
  [github.com/modelcontextprotocol/servers — filesystem README].
  The 0.1.0 "no media tool" gap is closed upstream. Still absent there:
  deny policy, git tools, workspace namespacing, named tasks — the 0.1.0
  reuse verdict (`CUSTOM_REQUIRED`) stands.
- **Closest breadth competitor: `ellmos-filecommander-mcp`** (50 tools):
  metadata-first `fc_preview_file` (1 MiB inline ceiling), images via
  `image` blocks, PDFs as bounded embedded `resource`, ZIP engine,
  optional OCR — plus writes, process management, interactive REPLs
  [github.com/ellmos-ai/ellmos-filecommander-mcp]. The preview contract
  (metadata-then-explicit-content) mirrors our `fs_inspect` → `fs_image`
  shape; its write/process surface carries no deny-policy layer and no
  workspace-id namespacing.
- **Security-posture neighbors** (the niche is no longer empty):
  `j0hanz/filesystem-context-mcp-server` (`.env`/`*.pem`/`*id_rsa*` denied
  by default, `--read-only`, RE2), `egyjs/expose-files-mcp` (read-only
  default, sensitive-pattern deny, command allowlist), `lduda79/projects-mcp`
  (read-only + exclusions). None offers git tools, tasks, or document
  inspection.
- **Host image-rendering reality** [pvliesdonk.github.io/image-generation-mcp
  client-compatibility; chatforest.com MCP multimodal patterns]:
  - Claude Desktop / claude.ai: reliably render `ImageContent` inline —
    the only major hosts that do.
  - Claude Code: partial→full depending on version; Cursor/Windsurf:
    partial; Gemini CLI, Cline/Roo: no.
  - **ChatGPT dev-mode connectors: do not render `ImageContent`** — the
    documented pattern there is download links or rich text; this makes
    our per-tool text+`structuredContent` fallback the load-bearing path
    for that host, not a nice-to-have.
  - MCP Inspector: renders.
- **Mitigation our design already implements** (industry-recommended):
  always pair `image` blocks with text metadata; use `audience`
  annotations; document supported content types per host
  [chatforest.com guide]. Our `audience:["user","assistant"]` + full
  `structuredContent` on every media tool matches this guidance exactly.

### What the delta means for the audience sections above

- Audience 1 (engineers): the "screenshot/PDF in workspace → model sees it"
  workflow is now expected of any serious workspace MCP — the official
  server and FileCommander both ship a form of it. Our differentiation is
  _bounded, policy-enforced, disclosure-first_ inspection (deny rules and
  armor scans applied inside archives/documents too, transforms disclosed
  with SHA-256 provenance), not the presence of media tools per se.
- Audience 2 (security-conscious leads): a media tool widens the emission
  surface; the corpus's trust question ("what exactly can it read?") now
  extends to "what can it read inside my zip/pdf/docx?" — answered by
  member-level denies + byte/ratio/page caps + no macro/external-rel
  execution, all documented in THREAT-MODEL.
- Audience 3 (OSS maintainers): WASM PDFium parsing (no shell, no JS exec)
  and librsvg-mediated SVG rasterization with external-reference refusal
  are reviewable mechanism claims — keep them mechanism-first, matching
  the "claims not adjectives" ban above.

### Spot-verification items for the delta

- Whether ChatGPT's _non-dev_ connector path treats `ImageContent`
  differently (our canary is the real test).
- FileCommander's actual weekly downloads/traction — not probed.
- `read_media_file` availability vs the version of the reference server
  users actually have installed (npx latest vs pinned).

### Sources (delta)

github.com/modelcontextprotocol/servers (filesystem README, read_media_file);
github.com/ellmos-ai/ellmos-filecommander-mcp (README + npm page);
github.com/j0hanz/filesystem-context-mcp-server; github.com/egyjs/expose-files-mcp;
github.com/lduda79/projects-mcp; pvliesdonk.github.io/image-generation-mcp
(client-compatibility matrix); chatforest.com/guides/mcp-multimodal-patterns;
docs.mcpjam.com/inspector/host-compat.

---

## Delta — 0.2.1 tunnel-persistence round (2026-10-12)

Provenance: compiled for the launchd-persistence release. Research question:
who operates a local MCP server _through_ the OpenAI Secure MCP Tunnel, and
what language do they use? Sources listed per-claim.

### New audience surfaced: ChatGPT workspace operators

The tunnel path adds an audience the 0.1.0 corpus did not model: operators
on **ChatGPT Business / Enterprise / Edu** plans, where developer mode and
custom MCP apps are admin-gated
[help.openai.com 12584461; developers.openai.com custom-mcp-server]. Their
reality differs from Audience 1:

- Setup is **admin-mediated**: an admin/owner enables developer mode and
  publishes the connector; the person running `tunnel-client` locally may
  not control the ChatGPT side. Docs must name the handoff ("a tunnel in
  Platform does not automatically appear in ChatGPT" —
  tunnel-client `docs/end-user-guide.md` calls this out directly).
- Their vocabulary is OpenAI-console vocabulary: "Secure MCP Tunnel",
  `tunnel_id`, "Runtime API key" vs "Admin API key", "connector",
  "developer mode". The end-user guide's central confusion warning —
  `tunnel_id` is not the runtime API key — is the exact failure our docs
  must prevent by keeping the three values visually separate.
- Persistence is a named operator problem: tunnel-client's own docs warn
  against `nohup`/`disown` and bless `runtimes connect` as the supervised
  path [github.com/openai/tunnel-client README]. Our launchd layer is
  supervision _of that managed runtime_, and should be described that way —
  not as running the server ourselves.

### Competitive movement on this surface

`YoshiaKefasu/mcp-local-files` [glama.ai listing] — a minimal Windows
tunnel-based server exposing one folder to ChatGPT/Codex, with a guided
`setup` that walks operators through tunnel id + runtime key + profile.
It is the closest _distribution-shape_ precedent for our tunnel docs: the
gap it leaves (read+edit scope, one folder, no deny policy, no git) is the
same gap we hold elsewhere. Its existence confirms the audience: people
already wire private folders to ChatGPT through this tunnel and will copy
whatever setup pattern ships first.

### What this changes

- README tunnel section must keep "Runtime API key", "tunnel id", and
  "Admin key" as three visibly distinct values (matches OpenAI's own
  doc structure) and must not promise ChatGPT visibility from the CLI alone.
- The persistence story is legitimate audience vocabulary, not ops trivia:
  "stays up across reboots without nohup" answers a documented operator
  pain tunnel-client itself names.
- Register stays mechanism-first: "LaunchAgent re-checks the managed
  runtime every 60 s" not "always-on".

### Spot-verification items (delta)

- Whether ChatGPT free/Plus/Pro (non-Business) can attach tunnel-backed
  connectors — OpenAI docs name Business/Enterprise/Edu for developer mode;
  do not claim wider availability.
- `mcp-local-files` traction — single niche listing; landscape only.
