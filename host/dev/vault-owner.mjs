// Dev environments only (bin/sgnl-dev vault): makes a seeded admin the owner of the dev vault's organisation, as an
// operator does once by hand on a real instance (docs/DEPLOY.md §5): SSO sign-in, a master password, the
// organisation (SGNL_ORG_NAME), and the two API keys the tools use: the organisation's (bin/sgnl-vault-sync) and
// the owner's own (the bw CLI's login). Writes <dir>/<user>.vault.json (600): master password + both keys.
// Idempotent: steps already done are skipped. Prints steps only.
//
//   node vault-owner.mjs <user> <apps-domain> <org-name> <people-dir>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { browserFor } from './login.mjs';

const [USER, APPS, ORG, DIR] = process.argv.slice(2);
if (!USER || !APPS?.endsWith('.test') || !ORG || !DIR) {
  console.error('usage: node vault-owner.mjs <user> <apps-domain ending in .test> <org-name> <people-dir>');
  process.exit(64);
}
const DOMAIN = APPS.split('.').slice(1).join('.');
const HOST = `vault.${APPS}`;
const FILE = path.join(DIR, `${USER}.vault.json`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), 'vault', USER, ...a);
const state = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const save = () => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(state), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); };
if (!state.master) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  state.master = Array.from(crypto.randomBytes(28), (b) => a[b % a.length]).join('') + '-9a';
  save();
}

if (state.orgId && state.org && state.user) { log('already set up'); process.exit(0); }
const { browser, page, loginStep } = await browserFor(USER, DIR);
const onApp = () => { try { return new URL(page.url()).host === HOST; } catch { return false; } };
const click = async (re, scope = page) => {
  const b = scope.getByRole('button', { name: re }).or(scope.getByRole('link', { name: re })).first();
  if (await b.count() && await b.isVisible()) { await b.click(); await page.waitForTimeout(1500); return true; }
  return false;
};
const where = () => { try { return new URL(page.url()).hash; } catch { return ''; } };
const visible = (sel) => page.locator(sel).first().isVisible().catch(() => false);

// First-run popups (browser extension, welcome tour) cover the page.
const dismiss = async () => { for (const re of [/skip to web app/i, /^skip$/i, /add it later/i]) await click(re); };
const unlockIfLocked = async () => {
  if (!where().startsWith('#/lock')) return;
  await page.fill('input[type=password]', state.master); await click(/unlock/i); await page.waitForTimeout(3000);
};

async function signIn() {
  await page.goto(`https://${HOST}/`);
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    if (onApp() && /^#\/(set-initial-password|vault|lock)/.test(where())) return;
    if (!onApp()) { await loginStep(); continue; }
    const email = page.locator('input[formcontrolname=email]:visible').first();
    if (await email.isVisible().catch(() => false) && !(await email.inputValue())) await email.fill(`${USER}@${DOMAIN}`);
    await click(/single sign-on|enterprise|use sso/i);
  }
  throw new Error('no vault session: ' + page.url());
}

let ok = false;
try {
  await signIn();
  if (where().startsWith('#/set-initial-password')) {
    await page.fill('#input-password-form_new-password', state.master);
    await page.fill('#input-password-form_new-password-confirm', state.master);
    // No breach check: it would send a hash prefix of the password to an outside service.
    const breach = page.locator('#input-password-form_check-for-breaches');
    if (await breach.isChecked().catch(() => false)) await breach.uncheck();
    await click(/create account|set master password|save|submit/i);
    await page.waitForTimeout(4000);
    log('master password set');
  }
  if (where().startsWith('#/lock')) {
    await page.fill('input[type=password]', state.master);
    await click(/unlock/i);
    await page.waitForTimeout(3000);
  }
  await click(/add it later/i);
  await dismiss();
  // The organisation, once.
  await page.goto(`https://${HOST}/#/vault`); await page.waitForTimeout(3000); await unlockIfLocked(); await dismiss();
  if (!state.orgId) {
    await page.goto(`https://${HOST}/#/create-organization`); await page.waitForTimeout(3000); await dismiss();
    await dismiss();
    await page.fill('input[formcontrolname=name]', ORG);
    await page.fill('input[formcontrolname=billingEmail]', `${USER}@${DOMAIN}`);
    await click(/^submit$/i);
    await page.waitForTimeout(5000);
    const m = page.url().match(/organizations\/([0-9a-f-]{36})/);
    if (!m) throw new Error('organisation not created: ' + where());
    state.orgId = m[1]; save();
    log('organisation created:', ORG);
  }
  await page.goto(`https://${HOST}/#/organizations/${state.orgId}/settings/account`); await page.waitForTimeout(4000); await unlockIfLocked(); await dismiss();
  // An API key behind "View API key": the master password, then client_id/client_secret in the dialog.
  const apiKey = async () => {
    if (!await click(/view api key/i)) throw new Error('no "View API key" on ' + where());
    const dialog = page.getByRole('dialog').last();
    await dialog.locator('input[type=password]').first().fill(state.master);
    await click(/view api key|continue|submit|confirm/i, dialog);
    await page.waitForTimeout(2500);
    const text = await page.getByRole('dialog').last().innerText();
    const id = text.match(/client_id:\s*(\S+)/)?.[1], secret = text.match(/client_secret:\s*(\S+)/)?.[1];
    if (!id || !secret) throw new Error('could not read the API key from the dialog');
    await click(/close|cancel/i, page.getByRole('dialog').last());
    return { client_id: id, client_secret: secret };
  };
  if (!state.org) { state.org = await apiKey(); save(); log('organisation API key saved'); }
  if (!state.user) {
    await page.goto(`https://${HOST}/#/settings/security/security-keys`); await page.waitForTimeout(4000); await unlockIfLocked(); await dismiss();
    state.user = await apiKey(); save(); log('owner API key saved');
  }
  ok = true;
} catch (e) {
  log('FAILED:', e.message.split('\n')[0]);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
