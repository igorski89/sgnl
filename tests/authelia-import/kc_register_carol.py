import json, os, time
from playwright.sync_api import sync_playwright
S=os.path.dirname(os.path.abspath(__file__)); user,pw="carol-test","Throwaway-carol-test-pw1"
f=os.path.join(S,f"passkey-{user}.json")
with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    for attempt in ("register","login-again"):
        ctx=b.new_context(); page=ctx.new_page(); cdp=ctx.new_cdp_session(page); cdp.send("WebAuthn.enable")
        # Like a synced passkey (iCloud/Bitwarden): resident, backup eligible + backed up.
        a=cdp.send("WebAuthn.addVirtualAuthenticator",{"options":{"protocol":"ctap2","transport":"internal","hasResidentKey":True,"hasUserVerification":True,"isUserVerified":True,"automaticPresenceSimulation":True,"defaultBackupEligibility":True,"defaultBackupState":True}})["authenticatorId"]
        if os.path.exists(f):
            for cr in json.load(open(f)):
                cr["signCount"]=max(cr.get("signCount",0), int(time.time())-1_700_000_000)
                cdp.send("WebAuthn.addCredential",{"authenticatorId":a,"credential":cr})
        page.on("dialog", lambda d: d.accept("virtual-"+user))
        page.goto("http://localhost:8180/realms/test/account"); page.wait_for_selector("#username",timeout=30000)
        page.fill("#username",user); page.fill("#password",pw); page.click("#kc-login"); page.wait_for_timeout(2500)
        if page.locator("#registerWebAuthn").count(): page.click("#registerWebAuthn"); page.wait_for_timeout(4000)
        elif page.locator("#authenticateWebAuthnButton").count(): page.click("#authenticateWebAuthnButton"); page.wait_for_timeout(4000)
        ok="/account" in page.url and "login-actions" not in page.url
        creds=cdp.send("WebAuthn.getCredentials",{"authenticatorId":a})["credentials"]
        print(attempt, "OK" if ok else "FAIL "+page.url[:90], [(c.get("isResidentCredential"), c.get("backupEligibility"), c.get("backupState")) for c in creds], flush=True)
        if creds: json.dump(creds,open(f,"w")); os.chmod(f,0o600)
        ctx.close()
    b.close()
