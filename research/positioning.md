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
