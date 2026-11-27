// Dev environments only (bin/sgnl-dev vault): a seeded person accepts the dev vault's invitation, as a new person
// does once (docs/USERS.md): the newest "Join" email from Mailpit, SSO sign-in, a master password. Writes
// <dir>/<user>.vault.json (600) with the master password. Then bin/sgnl-vault-sync confirms them (the owner hands
// over the organisation key). Prints steps only.
//
//   node vault-join.mjs <user> <apps-domain> <people-dir>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { browserFor } from './login.mjs';

const [USER, APPS, DIR] = process.argv.slice(2);
if (!USER || !APPS?.endsWith('.test') || !DIR) {
  console.error('usage: node vault-join.mjs <user> <apps-domain ending in .test> <people-dir>');
  process.exit(64);
}
const DOMAIN = APPS.split('.').slice(1).join('.');
const HOST = `vault.${APPS}`;
const MAILPIT = `https://mailpit.${APPS}`;
const FILE = path.join(DIR, `${USER}.vault.json`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), 'vault', USER, ...a);

const search = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${USER}@${DOMAIN} subject:Join`)}&limit=1`)).json();
if (!search.messages?.length) { log('no invitation email in Mailpit (run bin/sgnl-vault-sync first)'); process.exit(2); }
const msg = await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0].ID}`)).json();
const link = (msg.Text + ' ' + msg.HTML).match(/https:\/\/[^\s"'<>]+accept-organization[^\s"'<>]*/)?.[0]?.replace(/&amp;/g, '&');
if (!link || new URL(link).host !== HOST) { log('no invitation link for the dev vault in that email'); process.exit(2); }

const state = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
if (!state.master) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  state.master = Array.from(crypto.randomBytes(28), (b) => a[b % a.length]).join('') + '-9a';
  fs.writeFileSync(FILE, JSON.stringify(state), { mode: 0o600 });
}

const { browser, page, loginStep } = await browserFor(USER, DIR);
const onApp = () => { try { return new URL(page.url()).host === HOST; } catch { return false; } };
const where = () => { try { return new URL(page.url()).hash; } catch { return ''; } };
const click = async (re) => {
  const b = page.getByRole('button', { name: re }).or(page.getByRole('link', { name: re })).first();
  if (await b.count() && await b.isVisible()) { await b.click(); await page.waitForTimeout(1500); return true; }
  return false;
};
let ok = false;
try {
  await page.goto(link);
  for (let i = 0; i < 60 && !ok; i++) {
    await page.waitForTimeout(1000);
    if (!onApp()) { await loginStep(); continue; }
    const body = await page.innerText('body').catch(() => '');
    if (/invitation accepted|you have joined|joined the organi[sz]ation/i.test(body) || /^#\/(vault|setup-extension)/.test(where())) { ok = true; break; }
    if (where().startsWith('#/set-initial-password')) {
      await page.fill('#input-password-form_new-password', state.master);
      await page.fill('#input-password-form_new-password-confirm', state.master);
      const breach = page.locator('#input-password-form_check-for-breaches');
      if (await breach.isChecked().catch(() => false)) await breach.uncheck();   // no outside breach check
      await click(/create account|set master password|submit/i);
      await page.waitForTimeout(3000);
      continue;
    }
    const email = page.locator('input[formcontrolname=email]:visible').first();
    if (await email.isVisible().catch(() => false) && !(await email.inputValue())) await email.fill(`${USER}@${DOMAIN}`);
    if (await click(/single sign-on|enterprise|use sso/i)) continue;
    await click(/^(log in|accept invitation|accept|join)/i);
  }
  log('invitation accepted:', ok);
} catch (e) {
  log('FAILED:', e.message.split('\n')[0]);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
