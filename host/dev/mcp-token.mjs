// Dev environments only (bin/sgnl-dev smoke tokens): an MCP gateway token for a seeded person, as an AI app gets one
// (OAuth code flow + PKCE, public client sgnl-mcp-claude-code, loopback redirect caught in the browser). Writes
// <token-dir>/<user>-token.json (600) with the refresh token, which the smoke runner (sgnl-mcp's cmd/sgnl-mcp-smoke)
// reads. Prints steps only, never a token.
//
//   node mcp-token.mjs <user> <apps-domain> <realm> <people-dir> <token-dir> [resource]
//
// resource (RFC 8707): a token for that endpoint only, e.g. the admin one (https://mcp.<apps>/admin/mcp); written
// as <user>-admin-token.json when it ends in /admin/mcp.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { browserFor } from './login.mjs';

const [USER, APPS, REALM, DIR, TOKENS, RESOURCE] = process.argv.slice(2);
if (!USER || !APPS?.endsWith('.test') || !REALM || !DIR || !TOKENS) {
  console.error('usage: node mcp-token.mjs <user> <apps-domain ending in .test> <realm> <people-dir> <token-dir>');
  process.exit(64);
}
const BASE = `https://id.${APPS}/realms/${REALM}`;
const CLIENT = 'sgnl-mcp-claude-code';
const REDIRECT = 'http://localhost:47621/callback';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), USER, ...a);

const verifier = crypto.randomBytes(48).toString('base64url');
const state = crypto.randomBytes(16).toString('base64url');
const authorize = BASE + '/api/oidc/authorization?' + new URLSearchParams({
  client_id: CLIENT, response_type: 'code', scope: 'openid profile email groups offline_access', redirect_uri: REDIRECT,
  code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state,
  ...(RESOURCE ? { resource: RESOURCE } : {}),
});

const { browser, page, loginStep } = await browserFor(USER, DIR);
let callback = null;
// Nothing listens on the loopback redirect: the browser catches it.
await page.route('http://localhost:47621/**', async (route) => {
  callback = route.request().url();
  await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
});

let ok = false;
try {
  await page.goto(authorize);
  for (let i = 0; i < 60 && !callback; i++) { await page.waitForTimeout(1000); if (!callback) await loginStep(); }
  if (!callback) throw new Error('login did not complete');
  const params = new URL(callback).searchParams;
  if (params.get('error')) throw new Error('authorization error: ' + params.get('error'));
  if (params.get('state') !== state || !params.get('code')) throw new Error('bad callback');
  const r = await fetch(BASE + '/api/oidc/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code'), redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier, ...(RESOURCE ? { resource: RESOURCE } : {}) }),
  });
  const body = await r.json();
  if (!r.ok || !body.refresh_token) throw new Error(`token endpoint ${r.status} ${body.error ?? ''}`);
  fs.mkdirSync(TOKENS, { recursive: true, mode: 0o700 });
  const file = path.join(TOKENS, `${USER}${RESOURCE?.endsWith('/admin/mcp') ? '-admin' : ''}-token.json`);
  fs.writeFileSync(file + '.tmp', JSON.stringify({ refresh_token: body.refresh_token, client_id: CLIENT, issuer: BASE, ...(RESOURCE ? { resource: RESOURCE } : {}) }), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  ok = true;
  log('token written');
} catch (e) {
  log('FAILED:', e.message.split('\n')[0]);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
