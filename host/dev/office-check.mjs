// Dev environments only (bin/sgnl-dev office-check): proves the office works end to end. Signs in to the drive as a
// seeded person (password + passkey from bin/sgnl-dev seed), creates an empty document, opens it in Collabora the
// way the drive's web app does (/app/open), and waits for the editor. Collabora then fetches the file from the
// drive over HTTPS (WOPI), so this also proves that the two trust each other's dev certificate. Deletes the document.
//
//   node office-check.mjs <user> <apps-domain> <people-dir>
import { browserFor } from './login.mjs';

const [USER, APPS, DIR] = process.argv.slice(2);
if (!USER || !APPS?.endsWith('.test') || !DIR) {
  console.error('usage: node office-check.mjs <user> <apps-domain ending in .test> <people-dir>');
  process.exit(64);
}
const DRIVE = `https://drive.${APPS}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), USER, ...a);
const { browser, ctx, page, loginStep } = await browserFor(USER, DIR);

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
    await loginStep();
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
  const space = drives.value?.[0]?.id;
  const root = drives.value?.[0]?.root?.id ?? space;
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
    // The office locks an open document (WOPI): close the editor, then retry until it unlocks.
    for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
    let del;
    for (let i = 0; i < 20; i++) {
      del = await fetch(`${DRIVE}/dav/spaces/${encodeURIComponent(space)}/${name}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      if (del.status !== 423) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!del.ok) { log('could not delete', name, del.status); ok = false; }
    else log('deleted', name);
  }
} catch (e) {
  log('FAILED:', e.message.split('\n')[0]);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
