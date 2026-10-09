# Security policy

## Scope

`local-workspace-mcp` is a security boundary: it decides what an AI host may
read from explicitly authorized local workspace roots. Bugs in that boundary —
path escapes, denied-file content leaks, policy widening from repository
content, execution beyond allowlisted tasks — are security issues.

Out of scope: a local attacker who already has the operator's uid and write
access to a workspace root (hardlink planting, symlink TOCTOU races). Those
are documented as residual risks in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Reporting

This project is currently a private release candidate. Report suspected
vulnerabilities privately to the repository owner through an existing direct
channel — do not file public issues or post reproductions containing real
file paths, hostnames, or contents. Once the repository is public, use
GitHub's private vulnerability reporting (Security Advisories).

Include:

- the exact commit SHA you tested (`git rev-parse HEAD`);
- a minimal reproduction (synthetic fixtures only — no real secrets);
- the tool call sequence and the unexpected output;
- which boundary you believe was crossed (containment, deny policy,
  execution, audit, tunnel).

## What a good report looks like

The bar is a demonstrated invariant failure, not a plausible-sounding concern:

- file content outside an authorized root, or denied-by-policy content,
  appearing in any tool response, diff, search preview, error, or log line;
- a repository-controlled artifact (config file, `.git/config`, filename,
  symlink) widening roots, deny rules, or task definitions;
- code execution beyond operator-allowlisted task argv;
- absolute host paths or environment values surfaced to a caller.

## Hardening posture (what is already enforced)

- Read-oriented tool surface — no write/edit/delete tools and no arbitrary
  command execution exist in V1. The only executable surface is `task_run`,
  which runs operator-allowlisted argv (`shell:false`) with real side
  effects — bounded invocation, not a sandbox.
- Lexical + canonical (realpath) containment with ancestor walking.
- Deny policy on relative paths and basenames, evaluated on both the lexical
  and resolved path; deny rules and workspace roots live only in the
  operator-owned config file.
- Content-level private-key marker refusal (name-independent, whole-file).
- `rg --json` parsing — crafted filenames cannot spoof match attribution.
- Diff redaction across both sides of renames; fail-closed on unparseable
  headers; historical blob access denied by path and by key material.
- `spawn` argv only, `shell:false`, `--end-of-options`, strict ref grammar,
  sanitized subprocess env, `GIT_TERMINAL_PROMPT=0`.
- Bounded everything: bytes, lines, entries, matches, time, output.
- Metadata-only audit log that refuses to write through a symlinked file or
  any symlinked parent component.
- Config permission enforcement (refuses group/world-writable trust root).
- `pnpm audit --prod` must report zero known vulnerabilities at release.

## Supported versions

| Version                 | Status                           |
| ----------------------- | -------------------------------- |
| 0.1.0 release candidate | Under corporate-readiness review |

Pre-1.0: only the latest commit on the release branch is supported.
