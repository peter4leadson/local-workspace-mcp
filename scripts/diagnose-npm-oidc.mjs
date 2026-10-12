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
}

main().catch((err) => console.log(`probe aborted: ${err.stack}`));
