// Dev environments only: one MCP tool call through the gateway with a token file from mcp-token.mjs (refresh token
// -> access token, initialize, tools/call). Prints the tool's text answer only; the refresh token is rotated and
// written back (600).
//
//   [MCP_ISSUER=https://id.<apps>/realms/<realm>] node mcp-call.mjs <token-file> <mcp-url> <tool> '<json arguments>'
import fs from 'node:fs';

const [FILE, URL_, TOOL, ARGS = '{}'] = process.argv.slice(2);
if (!FILE || !URL_?.includes('.test/') || !TOOL) {
  console.error("usage: node mcp-call.mjs <token-file> <https://mcp.<apps>.test/...> <tool> '<json arguments>'");
  process.exit(64);
}
const t = JSON.parse(fs.readFileSync(FILE, 'utf8'));
// Token files of the smoke runner don't name the issuer or client: MCP_ISSUER / the gateway's public client.
t.issuer ??= process.env.MCP_ISSUER; t.client_id ??= 'sgnl-mcp-claude-code';
if (!t.issuer) { console.error('no issuer in the token file: set MCP_ISSUER'); process.exit(64); }
const r = await fetch(t.issuer + '/api/oidc/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id, ...(t.resource ? { resource: t.resource } : {}) }),
});
const tok = await r.json();
if (!r.ok || !tok.access_token) { console.error('token refresh failed:', r.status, tok.error ?? ''); process.exit(1); }
if (tok.refresh_token) {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify({ ...t, refresh_token: tok.refresh_token }), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}
let session;
const rpc = async (body) => {
  const res = await fetch(URL_, { method: 'POST', body: JSON.stringify(body), headers: {
    Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(session ? { 'Mcp-Session-Id': session } : {}) } });
  session ??= res.headers.get('mcp-session-id');
  const text = await res.text();
  if (!res.ok) throw new Error(`${body.method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const data = text.includes('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() : text;
  return data ? JSON.parse(data) : null;
};
await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sgnl-dev', version: '1' } } });
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
const out = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: TOOL, arguments: JSON.parse(ARGS) } });
if (out.error) { console.error('error:', out.error.message); process.exit(1); }
for (const c of out.result?.content ?? []) if (c.type === 'text') console.log(c.text);
process.exit(out.result?.isError ? 1 : 0);
