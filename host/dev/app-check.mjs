// Dev environments only (bin/sgnl-dev app-check): signs in to an app through the dev login server as a seeded person
// and checks that the app then shows the person's data. Proves the app's OIDC client, its trust in the dev CA and
// its calls to the other apps.
//
//   node app-check.mjs <inbox|vault|git|listmonk|monitor> <user> <apps-domain> <people-dir>
import { browserFor } from './login.mjs';

const [APP, USER, APPS, DIR] = process.argv.slice(2);
const START = { inbox: '/', vault: '/', git: '/user/oauth2/authelia', listmonk: '/admin', monitor: '/' };
if (!(APP in START) || !USER || !APPS?.endsWith('.test') || !DIR) {
  console.error('usage: node app-check.mjs <' + Object.keys(START).join('|') + '> <user> <apps-domain ending in .test> <people-dir>');
  process.exit(64);
}
const HOST = `${APP}.${APPS}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), APP, USER, ...a);
const { browser, page, loginStep } = await browserFor(USER, DIR);
const onApp = () => { try { return new URL(page.url()).host === HOST; } catch { return false; } };
const click = async (re) => {
  const b = page.getByRole('button', { name: re }).or(page.getByRole('link', { name: re })).first();
  if (await b.count() && await b.isVisible()) { await b.click(); await page.waitForTimeout(2000); return true; }
  return false;
};

// What "signed in" looks like in each app.
const done = {
  inbox: async () => onApp() && await page.getByText(/^Inbox$/).first().isVisible().catch(() => false),
  // A new SSO person must first choose a master password (Vaultwarden encrypts with it): reaching that page, or the
  // vault itself, means the sign-in worked.
  vault: async () => onApp() && await page.getByText(/master password|My vault|Vaults/i).first().isVisible().catch(() => false)
    && !await page.locator('input[formcontrolname=email]:visible').first().isVisible().catch(() => false),
  // Signed in: the app's own page (not its login page) with the person's name on it.
  git: async () => onApp() && !page.url().includes('/user/login') && (await page.innerText('body').catch(() => '')).includes(USER),
  listmonk: async () => onApp() && new URL(page.url()).pathname.startsWith('/admin') && !page.url().includes('login')
    && await page.getByText(/Campaigns/).first().isVisible().catch(() => false),
  monitor: async () => onApp() && !page.url().includes('/login')
    && await page.getByText(/Dashboards|Welcome to Grafana/i).first().isVisible().catch(() => false),
};

let ok = false;
try {
  await page.goto(`https://${HOST}${START[APP]}`);
  for (let i = 0; i < 60 && !ok; i++) {
    await page.waitForTimeout(1000);
    if (await done[APP]()) { ok = true; break; }
    if (!onApp()) { await loginStep(); continue; }
    if (APP === 'inbox') { await click(/sign in|log ?in|continue with|single sign-on|sso/i); continue; }
    if (APP === 'vault') {
      const email = page.locator('input[formcontrolname=email]:visible').first();
      if (await email.isVisible().catch(() => false) && !(await email.inputValue())) { await email.fill(`${USER}@${APPS.split('.').slice(1).join('.')}`); }
      if (await click(/single sign-on|enterprise|use sso/i)) continue;
      const sso = page.locator('input[formcontrolname=identifier], input#identifier');
      if (await sso.isVisible().catch(() => false)) { await sso.fill(APPS.split('.').slice(1).join('.')); await click(/log in|continue/i); continue; }
      await click(/^continue$/i);
    }
    if (i % 10 === 9) log('waiting on', new URL(page.url()).pathname + new URL(page.url()).hash, JSON.stringify((await page.innerText('body').catch(() => '')).slice(0, 160)));
  }
  log('signed in:', ok);
  if (!ok) log('stuck on', page.url().split('?')[0], JSON.stringify((await page.innerText('body').catch(() => '')).slice(0, 300)));
} catch (e) {
  log('FAILED:', e.message.split('\n')[0]);
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
