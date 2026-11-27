// Dev environments only (bin/sgnl-dev office-check): proves the office works end to end. Signs in to the drive as a
// seeded person (password + passkey from bin/sgnl-dev seed), creates an empty document, opens it in Collabora the
// way the drive's web app does (/app/open), and waits for the editor. Collabora then fetches the file from the
// drive over HTTPS (WOPI), so this also proves that the two trust each other's dev certificate. Deletes the document.
//
//   node office-check.mjs <user> <apps-domain> <people-dir>
import fs from 'node:fs';
import path from 'node:path';

const [USER, APPS, DIR] = process.argv.slice(2);
if (!USER || !APPS?.endsWith('.test') || !DIR) {
  console.error('usage: node office-check.mjs <user> <apps-domain ending in .test> <people-dir>');
  process.exit(64);
}
const DRIVE = `https://drive.${APPS}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), USER, ...a);
const password = fs.readFileSync(path.join(DIR, `${USER}.password`), 'utf8').trim();
const exported = JSON.parse(fs.readFileSync(path.join(DIR, `${USER}.passkey.json`), 'utf8'));

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
// Sign count from the clock (the login server marks a repeated count as a cloned passkey, for good).
for (const c of exported) {
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { ...c, signCount: Math.max(c.signCount, Math.floor(Date.now() / 1000)) } });
}

let ok = false;
try {
  await page.goto(DRIVE);
  let token = null;
  for (let i = 0; i < 60 && !token; i++) {
    await page.waitForTimeout(1000);
    if (new URL(page.url()).host === `drive.${APPS}`) {
      // The web app keeps its OIDC session in browser storage: its access token is what /app/* accepts.
      token = await page.evaluate(() => {
        for (const s of [sessionStorage, localStorage]) for (let k = 0; k < s.length; k++) {
          const v = s.getItem(s.key(k));
          if (v?.includes('access_token')) { try { return JSON.parse(v).access_token; } catch {} }
        }
        return null;
      });
      continue;
    }
    if (await page.locator('#username-textfield:not([disabled])').count() && await page.locator('#password-textfield').count()) {
      await page.fill('#username-textfield', USER); await page.fill('#password-textfield', password);
      await page.click('#sign-in-button'); await page.waitForTimeout(3000); continue;
    }
    if (!await page.locator('#username-textfield').count() && await page.locator('#password-textfield:not([disabled])').count()) {
      await page.fill('#password-textfield', password); await page.click('#sign-in-button'); await page.waitForTimeout(3000); continue;
    }
    if (await page.locator('#openid-consent-accept:not([disabled])').count()) { await page.click('#openid-consent-accept'); continue; }
    const no = page.getByRole('button', { name: /^no$/i });
    if (await no.count()) { await no.click(); continue; }
  }
  if (!token) throw new Error('no drive session');
  log('signed in to the drive');

  const api = async (method, p) => {
    const r = await fetch(DRIVE + p, { method, headers: { Authorization: 'Bearer ' + token } });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p.split('?')[0]}: ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
  const drives = await api('GET', '/graph/v1.0/me/drives?$filter=driveType+eq+personal');
  const root = drives.value?.[0]?.root?.id ?? drives.value?.[0]?.id;
  const name = `office-check-${Date.now()}.odt`;
  const created = await api('POST', `/app/new?parent_container_id=${encodeURIComponent(root)}&filename=${name}`);
  const fileId = created.file_id;
  log('created', name);
  try {
    const open = await api('POST', `/app/open?file_id=${encodeURIComponent(fileId)}&app_name=CollaboraOnline`);
    // The drive's web app posts these form fields to Collabora in an iframe; a top-level page does the same.
    const fields = Object.entries(open.form_parameters ?? {}).map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('');
    const office = await ctx.newPage();
    const errors = [];
    office.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    await office.setContent(`<form id="f" method="${open.method ?? 'POST'}" action="${open.app_url}">${fields}</form>`);
    await Promise.all([office.waitForNavigation({ timeout: 30000 }), office.evaluate(() => document.getElementById('f').submit())]);
    // The editor draws the document on a canvas once Collabora has loaded it from the drive.
    await office.waitForSelector('canvas', { timeout: 45000 });
    await office.waitForTimeout(3000);
    const failed = await office.locator('text=/Failed to load|Unauthorized WOPI host|SSL|could not be loaded/i').count();
    ok = failed === 0;
    log('editor loaded:', ok, errors.length ? `console errors: ${JSON.stringify(errors.slice(0, 3))}` : '');
  } finally {
    await api('DELETE', `/dav/spaces/${encodeURIComponent(fileId)}`).catch(async () => {
      await fetch(`${DRIVE}/dav/spaces/${encodeURIComponent(root)}/${name}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    });
    log('deleted', name);
  }
} catch (e) {
  log('FAILED:', e.message.split('\n')[0]);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
