#!/usr/bin/env node
// Release gate for .github/workflows/publish.yml.
//
// Derives the npm dist-tag from the validated version (stable → latest,
// prerelease → next), enforces package.json/tag/commit consistency, and
// refuses duplicate publication — failing closed on any registry,
// network, or auth failure that is not a clean 404.
//
// Manual dispatch contract: run the workflow on the ref that IS the
// release commit — the `v<version>` tag must exist and point at the
// checkout SHA, and `package.json` version must equal that tag's version.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** npm dist-tag for a semver version: any prerelease component → next. */
export function deriveDistTag(version) {
  const core = String(version).split("+", 1)[0]; // build metadata never affects the tag
  return core.includes("-") ? "next" : "latest";
}

/** Release tag wins over the dispatch input; both strip a leading `v`. */
export function resolveExpectedVersion({ releaseTag = "", dispatchVersion = "" } = {}) {
  const raw = releaseTag || dispatchVersion;
  if (!raw) throw new Error("no version resolved: neither release tag nor dispatch input provided one");
  return raw.startsWith("v") ? raw.slice(1) : raw;
}

/** The git ref that must point at the checkout commit. */
export function resolveTagRef({ releaseTag = "", version } = {}) {
  return releaseTag || `v${version}`;
}

/** Classify `npm view` output: "exists" | "absent"; throws (fail closed) otherwise. */
export function classifyNpmView({ code, output }) {
  if (code === 0) return "exists";
  if (/^npm error code E404/m.test(output) || /^npm error 404 Not Found/m.test(output)) return "absent";
  throw new Error(`npm view failed without a clean 404 — refusing to continue:\n${String(output).slice(0, 500)}`);
}

function fail(msg) {
  console.error(`release-check: ${msg}`);
  process.exit(1);
}

function main() {
  const env = process.env;
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  let expected;
  try {
    expected = resolveExpectedVersion({ releaseTag: env.RELEASE_TAG ?? "", dispatchVersion: env.DISPATCH_VERSION ?? "" });
  } catch (e) {
    fail(e.message);
  }
  if (pkg.version !== expected) fail(`package.json version ${pkg.version} != release version ${expected}`);

  const tag = resolveTagRef({ releaseTag: env.RELEASE_TAG ?? "", version: expected });
  let tagSha;
  try {
    tagSha = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
  } catch {
    fail(`tag ${tag} missing from checkout — dispatch must run on the tagged release commit`);
  }
  if (tagSha !== env.GITHUB_SHA) fail(`tag ${tag} points at ${tagSha}, not the checked-out ${env.GITHUB_SHA}`);

  let res;
  try {
    res = { code: 0, output: execFileSync("npm", ["view", `${pkg.name}@${expected}`, "version"], { encoding: "utf8" }) };
  } catch (e) {
    res = { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
  try {
    if (classifyNpmView(res) === "exists") fail(`${pkg.name}@${expected} already published — refusing duplicate`);
  } catch (e) {
    fail(e.message);
  }

  const distTag = deriveDistTag(expected);
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `DIST_TAG=${distTag}\n`);
  console.log(`version ${expected}: consistent, tagged, unpublished (dist-tag ${distTag})`);
}

// Run main only when executed directly — tolerant of spaces/percent-encoding
// and Windows paths in argv[1] (a naive file:// compare can silently skip).
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
