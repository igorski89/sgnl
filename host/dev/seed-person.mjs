// Dev environments only (bin/sgnl-dev seed): finishes a person's set-up in the DEV login server without a human.
// Reads the newest set-up email to <user>@<domain> from Mailpit, opens its link in headless Chrome with a CDP virtual
// authenticator, sets a random password and registers a passkey. Writes <dir>/<user>.password and
// <user>.passkey.json (600); prints only steps. Refuses any host outside the dev apps domain.
//
//   node seed-person.mjs <user> <domain> <apps-domain> <dir>
//
// Logging in later with the passkey: import it with signCount = max(exported, unix seconds) (the login server marks a
// passkey that repeats a count as cloned, for good; instance/docs/PLAN-mcp-smoke.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [USER, DOMAIN, APPS, DIR] = process.argv.slice(2);
if (!USER || !DOMAIN || !APPS || !DIR || !APPS.endsWith('.test')) {
  console.error('usage: node seed-person.mjs <user> <domain> <apps-domain ending in .test> <dir>');
  process.exit(64);
}
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), USER, ...a);
const MAILPIT = `https://mailpit.${APPS}`;
const pwFile = path.join(DIR, `${USER}.password`);
const pkFile = path.join(DIR, `${USER}.passkey.json`);
if (fs.existsSync(pkFile)) { log('already set up (passkey file exists)'); process.exit(0); }

// The newest set-up mail for this person.
const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${USER}@${DOMAIN} subject:"Set up"`)}&limit=1`)).json();
if (!search.messages?.length) { log('no set-up email in Mailpit (run bin/sgnl-id setup-email first)'); process.exit(2); }
const msg = await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0].ID}`)).json();
const link = (msg.Text + ' ' + msg.HTML).match(/https:\/\/[^\s"'<>]+account-setup[^\s"'<>]*/)?.[0]?.replace(/&amp;/g, '&');
if (!link || new URL(link).host !== `id.${APPS}`) { log('no set-up link for the dev login server in that email'); process.exit(2); }
const base = link.slice(0, link.indexOf('/account-setup'));

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!';
let password = '';
while (!(/[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[-_.!]/.test(password))) {
  password = Array.from(crypto.randomBytes(32), (b) => alphabet[b % alphabet.length]).join('');
}
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(pwFile, password + '\n', { mode: 0o600 });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

let ok = false;
try {
  await page.goto(link);
  await page.waitForSelector('#password1-textfield:not([disabled])', { timeout: 20000 });
  await page.fill('#password1-textfield', password);
  await page.fill('#password2-textfield', password);
  await page.click('#reset-button');
  await page.waitForURL(/settings\/two-factor-authentication/, { timeout: 20000 });
  log('password set');
  await page.click('#webauthn-credential-add', { timeout: 20000 });
  await page.waitForSelector('#webauthn-credential-description', { timeout: 10000 });
  await page.fill('#webauthn-credential-description', 'dev passkey (virtual)');
  await page.click('#dialog-next');
  await page.waitForTimeout(4000);
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  if (credentials.length !== 1) throw new Error('expected one credential, got ' + credentials.length);
  fs.writeFileSync(pkFile, JSON.stringify(credentials), { mode: 0o600 });
  const info = await page.evaluate(async (b) => (await fetch(b + '/api/user/info')).json(), base).catch(() => ({}));
  ok = info?.data?.has_webauthn === true;
  log('passkey registered:', ok);
} catch (e) {
  log('FAILED:', e.message.split('\n')[0]);
  const alerts = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
  log('page alerts:', JSON.stringify(alerts));
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
