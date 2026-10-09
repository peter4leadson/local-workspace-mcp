# Contributing

Prerequisites: Node ≥20, `git`, ripgrep (`rg`), and pnpm 10.18.x
(`corepack enable` provides it).

## Workflow

```sh
pnpm install          # pnpm 10.18.x (see packageManager field)
pnpm build            # tsc → dist/
pnpm test             # vitest — must be green before review
pnpm typecheck        # tsc --noEmit
node dist/cli.js doctor                     # diagnostics
```

The Inspector battery and `doctor` need a configured workspace first
(`node dist/cli.js init-config`, edit the config, `doctor` must be green):

```sh
scripts/inspector-smoke.sh <workspace-id>   # MCP protocol battery
```

While the repository is private, changes arrive as commits on the release
branch by the owner. Once public: conventional-commit PRs, green `pnpm test`

- `pnpm typecheck` required.

## Rules that are not negotiable

1. **RED first.** A security fix or boundary change starts with a failing
   test that demonstrates the escape. `tests/adversarial.test.ts` is the
   permanent regression suite — every confirmed finding gets a case there.
2. **Fail closed.** New error paths return bounded `CODE: message` results.
   Never surface raw errno messages, absolute host paths, file contents, or
   environment values to a caller.
3. **No new capability without a threat-model row.** A tool that writes,
   executes, or listens is a new trust boundary — add it to
   [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) first, with its controls and proofs.
4. **Repository content is adversarial data.** Nothing under a workspace
   root may widen roots, deny rules, task definitions, or execution policy.
   Those live in the operator config only.
5. **Shell-free subprocesses.** argv arrays, `shell:false`, `--end-of-options`
   for git revs, `--` before pathspecs, sanitized env.
6. **Dependency discipline.** Exact pinned versions; prefer releases >7 days
   old; `pnpm audit --prod` must be clean; no new runtime dependency without
   a documented gap.
7. **No comments narrating the change.** Code comments explain invariants
   and non-obvious security reasoning, not history.

## Tool additions checklist

- zod-validated input schema with explicit bounds (length, count, range);
- `readOnlyHint` annotation honest about mutation;
- deny-policy enforcement on every path the tool can reach;
- bounded output with `truncated` metadata;
- unit tests + adversarial cases;
- audit event that records metadata only.
