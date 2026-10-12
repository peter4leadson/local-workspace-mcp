// Read-only probe of the npm trusted-publishing (OIDC) handshake.
//
// Adapted from trpc's diagnose-npm-oidc.mjs (github.com/trpc/trpc/pull/7625).
// Publishes nothing — the only write it performs is an EMPTY-body POST to the
// stage endpoint, which cannot create a stage but returns npm's real error
// body (npm-registry-fetch discards `{code,message}` payloads; curl/fetch does
// not). Tokens are registered as Actions masks and never printed.
//
// Must run inside a workflow the npm trusted-publisher config points at
// (publish.yml), under the registered environment (npm-release), or the
// exchange fails for reasons unrelated to what we're debugging.

const REGISTRY = 'https://registry.npmjs.org';
const PKG = process.argv[2] ?? 'local-workspace-mcp';
const ESCAPED = PKG.replace('/', '%2f');

const SAFE_CLAIMS = [
  'iss', 'aud', 'sub', 'repository', 'repository_owner',
  'repository_visibility', 'workflow', 'workflow_ref', 'job_workflow_ref',
  'ref', 'ref_type', 'environment', 'event_name', 'runner_environment',
];

const mask = (s) => { if (s) console.log(`::add-mask::${s}`); };
const section = (t) => console.log(`\n=== ${t} ===`);

const show = async (res) => {
  const text = await res.text();
  console.log(`status: ${res.status} ${res.statusText}`);
  try { return JSON.parse(text); }
  catch { console.log(`body (not json): ${text.slice(0, 400)}`); return null; }
};

async function main() {
  section(`1. GitHub OIDC id token for ${PKG}`);
  const { ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN } = process.env;
  if (!ACTIONS_ID_TOKEN_REQUEST_URL || !ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    console.log('no id-token request vars — job is missing `id-token: write`');
    return;
  }

  const idUrl = new URL(ACTIONS_ID_TOKEN_REQUEST_URL);
  idUrl.searchParams.set('audience', `npm:${new URL(REGISTRY).hostname}`);
  const idRes = await fetch(idUrl, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  const idBody = await show(idRes);
  const idToken = idBody?.value;
  mask(idToken);
  if (!idToken) return;

  const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  console.log('claims npm matches a trusted publisher on:');
  for (const claim of SAFE_CLAIMS) {
    if (claim in claims) console.log(`  ${claim}: ${JSON.stringify(claims[claim])}`);
  }

  section('2. npm token exchange');
  const exchangeRes = await fetch(
    `${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${ESCAPED}`,
    { method: 'POST', headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' } },
  );
  const exchangeBody = await show(exchangeRes);
  const npmToken = exchangeBody?.token;
  mask(npmToken);
  if (exchangeBody) {
    const { token: _t, ...rest } = exchangeBody;
    console.log(`token granted: ${Boolean(npmToken)}`);
    console.log(`other response fields: ${JSON.stringify(rest, null, 2)}`);
  }
  if (!npmToken) { console.log('no token — the exchange is what is failing'); return; }

  const auth = { Authorization: `Bearer ${npmToken}`, Accept: 'application/json' };

  section('3. what the exchanged token can do (reads only)');
  for (const [label, path] of [
    ['whoami', '/-/whoami'],
    ['package visibility', `/-/package/${ESCAPED}/visibility`],
    ['collaborators', `/-/package/${ESCAPED}/collaborators`],
    ['staged versions', '/-/stage'],
  ]) {
    console.log(`\n-- ${label}: GET ${path}`);
    try {
      const body = await show(await fetch(`${REGISTRY}${path}`, { headers: auth }));
      if (body) console.log(JSON.stringify(body, null, 2).slice(0, 800));
    } catch (err) { console.log(`request failed: ${err.message}`); }
  }

  section('4. empty-body POST to the stage endpoint (reveals the real 403 reason)');
  try {
    const body = await show(await fetch(`${REGISTRY}/-/stage/package/${ESCAPED}`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
    }));
    if (body) console.log(`error body: ${JSON.stringify(body, null, 2).slice(0, 800)}`);
  } catch (err) { console.log(`request failed: ${err.message}`); }

  // The real publish 403s with a Cloudflare "Attention Required" HTML page —
  // i.e. npm's edge WAF, not the registry app (an app authz failure would be
  // JSON like the 400 above). Isolate whether the trigger is body SIZE or
  // body CONTENT by POSTing schema-invalid bodies of increasing size, first
  // with plain-text padding then with a base64-looking blob (tarball/_attachments
  // are base64 in the real payload). An invalid schema body can never create a
  // stage — worst case npm returns a 400/422, which is what we want to see.
  section('5. WAF isolation — stage POST body size vs content');
  const b64 = (n) => Buffer.alloc(n).toString('base64');
  for (const [label, padField] of [
    ['1KB text pad', { pad: 'x'.repeat(1024) }],
    ['64KB text pad', { pad: 'x'.repeat(64 * 1024) }],
    ['256KB text pad', { pad: 'x'.repeat(256 * 1024) }],
    ['64KB base64 blob', { pad: b64(48 * 1024) }],
    ['256KB base64 blob', { pad: b64(192 * 1024) }],
    ['attachments-shaped 256KB', { _attachments: { 'a.tgz': { data: b64(192 * 1024) } } }],
  ]) {
    const payload = JSON.stringify({ name: PKG, ...padField });
    console.log(`\n-- ${label} (${payload.length} bytes): POST /-/stage/package/${ESCAPED}`);
    try {
      const res = await fetch(`${REGISTRY}/-/stage/package/${ESCAPED}`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: payload,
      });
      const text = await res.text();
      const cf = /Attention Required|cloudflare|cf-ray|Just a moment/i.test(text);
      console.log(`status: ${res.status} ${res.statusText} | cloudflare-block-page: ${cf}`);
      if (!cf) console.log(`app body: ${text.slice(0, 300)}`);
      else console.log(`html head: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    } catch (err) { console.log(`request failed: ${err.message}`); }
  }

  // Synthetic bodies all pass — isolate the REAL bytes. --with-tarball=<path>
  // POSTs the actual packed tarball's base64 inside a schema-invalid envelope
  // (no `versions`), so it can never create a stage. If this 403s while the
  // synthetic blobs didn't, the trigger is byte-content, not shape or size.
  const tgzIdx = process.argv.indexOf('--with-tarball');
  if (tgzIdx > -1 && process.argv[tgzIdx + 1]) {
    section('6. real tarball bytes in a schema-invalid envelope');
    const { readFileSync } = await import('node:fs');
    const real = readFileSync(process.argv[tgzIdx + 1]).toString('base64');
    for (const [label, env] of [
      ['raw tarball base64', { pad: real }],
      ['attachments shape', { _attachments: { 'pkg.tgz': { data: real } } }],
      // full publish-shape body minus `versions` — still schema-invalid
      ['publish shape, no versions', {
        _id: `${PKG}@0.0.0-probe`, name: PKG, 'dist-tags': { latest: '0.0.0-probe' },
        access: 'public', _attachments: { 'p.tgz': { data: real, 'content-type': 'application/octet-stream', length: real.length } },
      }],
    ]) {
      const payload = JSON.stringify({ name: PKG, ...env });
      console.log(`\n-- ${label} (${payload.length} bytes)`);
      try {
        const res = await fetch(`${REGISTRY}/-/stage/package/${ESCAPED}`, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: payload,
        });
        const text = await res.text();
        const cf = /Attention Required|cloudflare|cf-ray|Just a moment/i.test(text);
        console.log(`status: ${res.status} | cloudflare-block-page: ${cf}`);
        console.log(cf ? `html head: ${text.slice(0, 120).replace(/\s+/g, ' ')}` : `app body: ${text.slice(0, 200)}`);
      } catch (err) { console.log(`request failed: ${err.message}`); }
    }
  }
}

main().catch((err) => console.log(`probe aborted: ${err.stack}`));
