#!/usr/bin/env node
/**
 * Emit a minimal CycloneDX 1.5 SBOM for production dependencies.
 * Uses `pnpm ls --prod --json` so no extra dependency is needed.
 * Output: sbom.cdx.json on stdout.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ls = JSON.parse(
  execFileSync("pnpm", ["ls", "--prod", "--json", "--depth", "Infinity"], { encoding: "utf8" })
);

const components = [];
const seen = new Set();
function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const purl = `pkg:npm/${name.startsWith("@") ? encodeURIComponent(name) : name}@${info.version}`;
    if (seen.has(purl)) continue;
    seen.add(purl);
    components.push({
      type: "library",
      "bom-ref": purl,
      name,
      version: info.version,
      purl,
      scope: "required",
    });
    walk(info.dependencies);
  }
}
for (const project of ls) walk(project.dependencies);
components.sort((a, b) => a.purl.localeCompare(b.purl));

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${createHash("sha256").update(JSON.stringify(components)).digest("hex").slice(0, 32)}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      "bom-ref": `pkg:npm/${pkg.name}@${pkg.version}`,
      name: pkg.name,
      version: pkg.version,
      purl: `pkg:npm/${pkg.name}@${pkg.version}`,
    },
    tools: [{ vendor: "local-workspace-mcp", name: "scripts/sbom.mjs", version: "1.0.0" }],
  },
  components,
};

process.stdout.write(JSON.stringify(sbom, null, 2) + "\n");
