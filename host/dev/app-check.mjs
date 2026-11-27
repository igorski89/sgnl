// Dev environments only (bin/sgnl-dev check): signs in to an app through the dev login server as a seeded person and
// checks the outcome the person should get:
//   admin    signed in, with the app's admin rights (where the app has them: git, monitor, drive)
//   user     signed in, without admin rights
//   refused  never signed in, and the refusal is visible (the login server's access_denied, or the app's error)
// Proves each app's OIDC client and group rules, its trust in the dev CA and its calls to the other apps.
//
//   node app-check.mjs <inbox|vault|git|listmonk|monitor|drive> <user> <apps-domain> <people-dir> [admin|user|refused]
import { browserFor } from './login.mjs';

const [APP, USER, APPS, DIR, EXPECT = 'user'] = process.argv.slice(2);
const START = { inbox: '/', vault: '/', git: '/user/oauth2/authelia', listmonk: '/admin', monitor: '/', drive: '/' };
if (!(APP in START) || !USER || !APPS?.endsWith('.test') || !DIR || !['admin', 'user', 'refused'].includes(EXPECT)) {
  console.error('usage: node app-check.mjs <' + Object.keys(START).join('|') + '> <user> <apps-domain ending in .test> <people-dir> [admin|user|refused]');
  process.exit(64);
}
const HOST = `${APP}.${APPS}`;
const DOMAIN = APPS.split('.').slice(1).join('.');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), APP, USER, ...a);
const { browser, page, loginStep } = await browserFor(USER, DIR);
const onApp = () => { try { return new URL(page.url()).host === HOST; } catch { return false; } };
const body = async () => (await page.innerText('body').catch(() => '')).slice(0, 2000);
const click = async (re) => {
  const b = page.getByRole('button', { name: re }).or(page.getByRole('link', { name: re })).first();
  if (await b.count() && await b.isVisible()) { await b.click(); await page.waitForTimeout(2000); return true; }
  return false;
};
// The drive's web app keeps its OIDC session in browser storage.
const driveToken = () => page.evaluate(() => {
  for (const s of [sessionStorage, localStorage]) for (let k = 0; k < s.length; k++) {
    const v = s.getItem(s.key(k));
    if (v?.includes('access_token')) { try { return JSON.parse(v).access_token; } catch {} }
  }
  return null;
}).catch(() => null);

// A refusal: the login server sent access_denied back to the app, or the app says so.
let denied = false;
page.on('request', (r) => { if (/[?&#]error=access_denied/.test(r.url())) denied = true; });
// (listmonk: "User not found" for a person without a listmonk account; accounts aren't created at first login.)
const REFUSAL = /not allowed|denied|Login failed|invalid_grant|error exchanging token|not authori[sz]ed|forbidden|User not found/i;

// What "signed in" looks like in each app.
const done = {
  inbox: async () => onApp() && await page.getByText(/^Inbox$/).first().isVisible().catch(() => false),
  // A new SSO person must first choose a master password (Vaultwarden encrypts with it): reaching that page, or the
  // vault itself, means the sign-in worked.
  vault: async () => onApp() && await page.getByText(/master password|My vault|Vaults/i).first().isVisible().catch(() => false)
    && !await page.locator('input[formcontrolname=email]:visible').first().isVisible().catch(() => false),
  // The app's own page (not its login page) with the person's name on it.
  git: async () => onApp() && !page.url().includes('/user/login') && (await body()).includes(USER),
  listmonk: async () => onApp() && new URL(page.url()).pathname.startsWith('/admin') && !page.url().includes('login')
    && await page.getByText(/Campaigns/).first().isVisible().catch(() => false),
  monitor: async () => onApp() && !page.url().includes('/login')
    && await page.getByText(/Dashboards|Welcome to Grafana/i).first().isVisible().catch(() => false),
  drive: async () => onApp() && !!(await driveToken()),
};

// Admin rights, for the apps that have them (null: the app has no admin role for people).
const isAdmin = {
  git: async () => (await page.evaluate(async () => [(await fetch('/-/admin')).status, (await fetch('/admin')).status])).includes(200),
  monitor: async () => (await page.evaluate(async () => (await fetch('/api/user/orgs')).json()))
    .some((o) => o.orgId === 1 && o.role === 'Admin'),
  drive: async () => {
    const t = await driveToken();
    const r = await fetch(`https://${HOST}/graph/v1.0/me?$expand=appRoleAssignments`, { headers: { Authorization: 'Bearer ' + t } });
    // OpenCloud's built-in Admin role.
    return ((await r.json()).appRoleAssignments ?? []).some((a) => a.appRoleId === '71881883-1768-46bd-a24d-a356a2afdf7f');
  },
};

let signedIn = false, refusedSeen = false;
try {
  await page.goto(`https://${HOST}${START[APP]}`);
  for (let i = 0; i < 60 && !signedIn; i++) {
    await page.waitForTimeout(1000);
    if (await done[APP]()) { signedIn = true; break; }
    if (onApp() && (denied || REFUSAL.test(await body()))) { refusedSeen = true; break; }
    if (!onApp()) { await loginStep(); continue; }
    if (APP === 'inbox') { await click(/sign in|log ?in|continue with|single sign-on|sso/i); continue; }
    if (APP === 'vault') {
      const email = page.locator('input[formcontrolname=email]:visible').first();
      if (await email.isVisible().catch(() => false) && !(await email.inputValue())) await email.fill(`${USER}@${DOMAIN}`);
      if (await click(/single sign-on|enterprise|use sso/i)) continue;
      const sso = page.locator('input[formcontrolname=identifier], input#identifier');
      if (await sso.isVisible().catch(() => false)) { await sso.fill(DOMAIN); await click(/log in|continue/i); continue; }
      await click(/^continue$/i);
    }
  }
  let got = 'stuck';
  if (signedIn) got = APP in isAdmin ? ((await isAdmin[APP]()) ? 'admin' : 'user') : 'user';
  else if (refusedSeen) got = 'refused';
  // Apps without an admin role: an admin is an ordinary user there.
  const want = EXPECT === 'admin' && !(APP in isAdmin) ? 'user' : EXPECT;
  const ok = got === want;
  log(`${got}${ok ? '' : ` (expected ${want})`}`);
  if (got === 'stuck') log('stuck on', page.url().split('?')[0], JSON.stringify((await body()).slice(0, 300)));
  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (e) {
  log('FAILED:', e.message.split('\n')[0]);
  await browser.close();
  process.exit(1);
}
