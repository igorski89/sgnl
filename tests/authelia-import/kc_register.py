import json, os, sys, re, time
from playwright.sync_api import sync_playwright
S=os.path.dirname(os.path.abspath(__file__))
users={"alice-test":"Throwaway-alice-test-pw1","bob-test":"Throwaway-bob-test-pw1"}
def new_ctx(b, user):
    ctx=b.new_context(); page=ctx.new_page(); cdp=ctx.new_cdp_session(page); cdp.send("WebAuthn.enable")
    a=cdp.send("WebAuthn.addVirtualAuthenticator",{"options":{"protocol":"ctap2","transport":"internal","hasResidentKey":True,"hasUserVerification":True,"isUserVerified":True,"automaticPresenceSimulation":True}})["authenticatorId"]
    f=os.path.join(S,f"passkey-{user}.json")
    if os.path.exists(f):
        for cr in json.load(open(f)):
            cr["signCount"]=max(cr.get("signCount",0), int(time.time())-1_700_000_000)
            cdp.send("WebAuthn.addCredential",{"authenticatorId":a,"credential":cr})
    page.on("dialog", lambda d: d.accept("virtual-"+user))
    return ctx,page,cdp,a,f
with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    for user,pw in users.items():
        for attempt in ("register","login-again"):
            ctx,page,cdp,a,f=new_ctx(b,user)
            page.goto("http://localhost:8180/realms/test/account")
            page.wait_for_selector("#username", timeout=30000)
            page.fill("#username",user); page.fill("#password",pw); page.click("#kc-login")
            page.wait_for_timeout(2500)
            if page.locator("#registerWebAuthn").count():
                page.click("#registerWebAuthn"); page.wait_for_timeout(4000)
            elif page.locator("#authenticateWebAuthnButton").count():
                page.click("#authenticateWebAuthnButton"); page.wait_for_timeout(4000)
            ok = "/account" in page.url and "login-actions" not in page.url
            print(user, attempt, "OK" if ok else "FAIL "+page.url[:100], flush=True)
            if not ok: page.screenshot(path=os.path.join(S,f"kc-{user}-{attempt}.png"))
            creds=cdp.send("WebAuthn.getCredentials",{"authenticatorId":a})["credentials"]
            if creds:
                json.dump(creds,open(f,"w")); os.chmod(f,0o600)
            ctx.close()
    b.close()
