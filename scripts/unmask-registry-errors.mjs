// Diagnostic-only: make npm-registry-fetch include the response body in its
// error message, so npm's real {code,message} for a 4xx reaches the log.
// Adapted from trpc/trpc#7625 (.github/scripts/unmask-registry-errors.mjs).
//
// npm-registry-fetch appends the body only when the JSON carries an `error`
// key; npm's stage/publish endpoints send `{code, message}` — the reason is
// discarded before the CLI ever sees it. Run against the npm install tree.
// Never run this in a real release job.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const NEEDLES = [
  ["(body && body.error) ? ' - ' + body.error : ''", "body ? ' - ' + JSON.stringify(body) : ''"],
  ['body && body.error ? ` - ${body.error}` : ""', 'body ? ` - ${JSON.stringify(body)}` : ""'],
];

const roots = [];
try {
  roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
} catch {}
roots.push('/usr/local/lib/node_modules', '/opt/hostedtoolcache');

let patched = 0;
const seen = new Set();
const walk = (dir, depth) => {
  if (depth > 7 || seen.has(dir)) return;
  seen.add(dir);
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (name === 'node_modules' || p.includes('npm-registry-fetch') || p.includes('/npm/')) walk(p, depth + 1);
    } else if (p.includes('npm-registry-fetch') && name.endsWith('.js')) {
      try {
        const src = readFileSync(p, 'utf8');
        let out = src;
        for (const [from, to] of NEEDLES) out = out.split(from).join(to);
        if (out !== src) { writeFileSync(p, out); patched++; console.log(`patched: ${p}`); }
      } catch {}
    }
  }
};
for (const r of roots) walk(r, 0);
console.log(patched ? `unmask applied to ${patched} file(s)` : 'no needle found — npm-registry-fetch layout changed; inspect lib/errors.js manually');
