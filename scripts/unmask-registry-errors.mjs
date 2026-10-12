// Diagnostic-only: make npm-registry-fetch include the response body in its
// error message, so npm's real {code,message} for a 4xx reaches the log.
// Adapted from trpc/trpc#7625 (.github/scripts/unmask-registry-errors.mjs).
//
// npm-registry-fetch appends the body only when the JSON carries an `error`
// key; npm's stage/publish endpoints send `{code, message}` — the reason is
// discarded before the CLI ever sees it. Run against the npm install tree.
// Never run this in a real release job.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const FROM = "(body && body.error) ? ' - ' + body.error : ''";
const TO = "body ? ' - ' + JSON.stringify(body) : ''";

const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
const candidates = [
  join(npmRoot, 'npm/node_modules/npm-registry-fetch/lib/errors.js'),
  join(npmRoot, 'npm/node_modules/npm-registry-fetch/dist/errors.js'),
  join(prefix, 'lib/node_modules/npm/node_modules/npm-registry-fetch/lib/errors.js'),
];

let patched = 0;
for (const p of [...new Set(candidates)]) {
  if (!existsSync(p)) continue;
  const src = readFileSync(p, 'utf8');
  const out = src.split(FROM).join(TO);
  if (out === src) {
    console.log(`needle absent in ${p} — layout changed`);
    continue;
  }
  writeFileSync(p, out);
  patched++;
  console.log(`patched: ${p}`);
}
if (!patched) {
  console.log('no file patched; candidates checked:');
  candidates.forEach((c) => console.log(`  ${existsSync(c) ? 'found' : 'missing'} ${c}`));
  process.exit(1);
}
