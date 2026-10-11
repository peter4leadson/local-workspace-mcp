# Positioning — local-workspace-mcp (Panel B, Dunford method)

Compiled 2026-10-09. Method: competitive alternatives → differentiated
capabilities → differentiated value → target segment → category. Inputs:
`research/audience-corpus.md`.

## 1. Competitive alternatives (what a customer does instead)

- Host built-ins (Claude Code Read/Grep/Glob/Bash + permissions; Cursor;
  Codex) — zero install, permission model lives in the client.
- `@modelcontextprotocol/server-filesystem` — the default choice;
  read+write, no secrets denylist.
- Read-only filesystem servers (`@j0hanz/filesystem-mcp`,
  `project-files-readonly-mcp`, `sesopenko/mcp-filesystem-readonly`).
- Full-access workspace tools (Desktop Commander).
- `codemcp` — predeclared commands model, philosophical predecessor.
- Status quo: give the assistant unrestricted local access and rely on
  prompts/permissions.

## 2. Differentiated capabilities (what exists here that does not there)

- Read-only **by construction**: no write, edit, delete, move, or arbitrary
  shell tool exists in the process — an invariant, not a flag or a
  permission prompt.
- Bounded git **read** surface in the same server: status, diff, log, show,
  branches over authorized roots, including uncommitted working-tree state.
- Named-task allowlist: the operator declares argv arrays; the caller picks
  an id. Execution exists but invocation is enumerated.
- Default-deny secrets + content-level private-key detection (name is not
  the only boundary).
- Path containment enforced twice: lexical + canonical realpath, with
  symlink-escape regression tests in the shipped suite.
- Metadata-only audit log of every tool call.
- stdio only; no inbound listener; no runtime network resolution.

## 3. Differentiated value

For the primary audience, the alternative is a client-side permission model
that demonstrably collapses under fatigue (`--dangerously-skip-permissions`
discourse) or a server that ships write/exec "just in case". The value claim:
**the boundary survives the client.** Even a bypassed or compromised
prompt-loop cannot invoke a tool that does not exist, and cannot widen a
deny policy that lives outside the repository.

For the security-lead audience, the value is evaluability: the surface is
small enough to audit in one sitting, the threat model is published, and
the adversarial regression suite demonstrates the claims.

## 4. Target segment

Engineers and FDEs who run AI coding assistants against live repositories
and want a hard floor under assistant access — especially cross-root or
multi-host setups where per-client permission config does not travel.
Secondary: leads approving MCP servers for team use.

## 5. Market category

MCP workspace-context server, read-oriented. Category name to use plainly:
"a read-only MCP server for local workspaces" — the category is established
enough that inventing a label would cost clarity.

## 6. Proposition verdict

Tested: *"Your AI assistant needs context. It doesn't need unrestricted
access."*

- Accurate: mostly. `task_run` is code execution as the user; the
  proposition stands only if the task allowlist is disclosed immediately.
- Differentiated: weakly as phrased — competitors claim "secure" and even
  "read-only". What they do not claim is the invariant (write/exec tools
  absent, not gated) plus git plus named tasks in one bounded surface.
- Relevant: yes — maps to documented permission fatigue, context tax, and
  trust objections.
- Understandable cold: yes; "context" is slightly soft but acceptable.

**Adopted positioning** (leads with the invariant, discloses tasks):

> A read-only MCP server for local workspaces. Write, delete, and
> arbitrary-shell tools do not exist in it — not disabled, absent. Git read
> tools and named, operator-declared tasks provide bounded capability
> without a shell.

Working tagline: the proposition line stays as the hook; the second
sentence must immediately scope `task_run` honestly:

> "Tasks run real commands as your user — the allowlist bounds what can be
> invoked, not what invoked code can do."

## 7. Honest losses (documented, not hidden)

- Claude Code/Codex users with built-in file tools and `permissions.deny`
  get much of this for free; for them this server is redundancy plus a
  schema tax — unless they need one boundary across hosts or cross-root
  reads.
- Small tool list still costs context tokens (~14 tool schemas).
- "Bounded" is only as true as the containment code — which is why the
  adversarial suite and threat model ship in-repo.

---

## Delta — 0.2.0 multimodal round (2026-10-11)

Method: same Dunford chain; inputs now include
`research/audience-corpus.md` delta and the scoped competitor set below
(competitive-platform-analysis, pinned ECC v2.2.1 @ 5064474 — adapted to
infrastructure: "engagement format" → distribution, "portfolio" →
capability surface).

### Scoped competitor set (tiered)

| Candidate | Stance | Specialization | Reach | Offer overlap | Distinctiveness | Credibility | Craft proximity | Tier | Profile? |
|---|---|---|---|---|---|---|---|---|---|
| `@modelcontextprotocol/server-filesystem` | capability-led | generalist fs | reference impl, default | 5 | 2 (no policy; write surface) | 5 | 5 (`read_media_file` now exists) | Direct | ✓ must-profile |
| `ellmos-filecommander-mcp` | capability-led | broad fs+media+process | growing | 4 | 4 (metadata-first bounded previews, ZIP, OCR) | 3 | 4 | Direct (breadth) | ✓ must-profile |
| `j0hanz/filesystem-context-mcp-server` | security-led | read-only + deny defaults | small | 3 | 4 (deny-by-default, RE2, --read-only) | 2 | 4 | Direct (posture) | ✓ must-profile |
| `egyjs/expose-files-mcp` | security-led | read-only default + cmd allowlist | small | 3 | 4 | 2 | 3 | Direct (posture) | ✓ profile |
| Desktop Commander | capability-led | full-access workspace | large | 2 | 4 (traction, permissive pole) | 5 | 2 | Adjacent (substitute/cautionary) | ✓ cautionary |
| `lduda79/projects-mcp`, `sesopenko/mcp-filesystem-readonly`, `k-filesystem-mcp`, `aself101/mcp-secure-server` | mixed | minimal read-only / secure-fs cookbook | niche | 1–2 | 2–3 | 1–2 | 2–3 | Adjacent | ✗ landscape only |

White-space (the tension nobody else holds): **policy-bounded inspection
of compound content** — deny rules and content scans applied *inside*
archives, PDFs, OOXML, and image metadata, with disclosed transforms.
Breadth rivals have media without policy; posture rivals have policy
without media.

### 1→5 re-evaluated for 0.2.0

- Competitive alternatives (for the media job): ZIP-export-and-upload is
  the real status quo the acceptance test targets; official
  `read_media_file` (plain base64 pass-through, no bounds/policy);
  FileCommander previews; host built-in image read.
- Differentiated capabilities: media/document inspection *inside the same
  boundary* — member-level deny inside ZIPs, private-key scans inside
  extracted PDF/OOXML text and image bytes, pixel/page/member/ratio
  budgets, cumulative deadlines, transforms disclosed with
  source→returned SHA-256 provenance, WASM PDFium (no shell, no JS),
  macro/external-rel never executed, per-cell authorization on contact
  sheets, native `image` blocks *and* full text metadata every call.
- Differentiated value: "the boundary survives the client" now extends to
  **the boundary survives the file format** — an archive or document
  cannot smuggle denied material past the policy because inspection
  happens inside it, not around it.
- Positioning sentence (supersedes nothing, extends): "Images, archives,
  PDFs, and Office docs are inspected inside the same deny policy — the
  archive can't smuggle what the directory can't."
- Honest losses added: ChatGPT-class hosts do not render `ImageContent`
  today (industry-wide, not ours alone) — text metadata is the
  load-bearing path there; a wider surface is a wider audit surface;
  native decode carries a documented residual (in-process libvips).
