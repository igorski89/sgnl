// Dev environments only: a headless Chrome signed in as a seeded person (bin/sgnl-dev seed: password + passkey
// files). Used by office-check.mjs and app-check.mjs.
import fs from 'node:fs';
import path from 'node:path';

export async function browserFor(user, dir) {
  const password = fs.readFileSync(path.join(dir, `${user}.password`), 'utf8').trim();
  const exported = JSON.parse(fs.readFileSync(path.join(dir, `${user}.passkey.json`), 'utf8'));
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
  // One step of the login server's pages, if one is showing; true when it acted.
  const loginStep = async () => {
    if (await page.locator('#username-textfield:not([disabled])').count() && await page.locator('#password-textfield').count()) {
      await page.fill('#username-textfield', user); await page.fill('#password-textfield', password);
      await page.click('#sign-in-button'); await page.waitForTimeout(3000); return true;
    }
    if (!await page.locator('#username-textfield').count() && await page.locator('#password-textfield:not([disabled])').count()) {
      await page.fill('#password-textfield', password); await page.click('#sign-in-button'); await page.waitForTimeout(3000); return true;
    }
    if (await page.locator('#openid-consent-accept:not([disabled])').count()) { await page.click('#openid-consent-accept'); return true; }
    const no = page.getByRole('button', { name: /^no$/i });
    if (await no.count()) { await no.click(); return true; }
    return false;
  };
  return { browser, ctx, page, loginStep };
}
