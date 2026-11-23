"""C8 rehearsal: log in to the imported Authelia with the Keycloak passwords and
the same virtual passkeys; check the ID token's sub == Keycloak user id, and groups."""
import base64, http.client, json, os, re, ssl, time, urllib.parse
from playwright.sync_api import sync_playwright
C8 = os.path.expanduser("~/.cache/sgnl/c8"); R = os.path.join(C8, "rehearsal")
exp = json.load(open(os.path.join(C8, "keycloak-test-export.json")))
users = {u["username"]: u for u in exp["users"]}
pw = {"alice-test": "Throwaway-alice-test-pw1", "bob-test": "Throwaway-bob-test-pw1", "carol-test": "Throwaway-carol-test-pw1"}
spki = open(os.path.join(R, "spki.txt")).read().strip()
BASE = "https://id.example.com:8443/realms/test"

def token(code):
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    c = http.client.HTTPSConnection("127.0.0.1", 8443, context=ctx)
    body = urllib.parse.urlencode({"grant_type": "authorization_code", "code": code, "redirect_uri": "https://app.example.com/cb"})
    auth = base64.b64encode(b"rehearsal:rehearsal-client-secret").decode()
    c.request("POST", "/realms/test/api/oidc/token", body, {"Host": "id.example.com:8443", "Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded"})
    r = c.getresponse(); return r.status, json.loads(r.read() or b"{}")

def claims(jwt):
    p = jwt.split(".")[1]; return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))

ok_all = True
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--host-resolver-rules=MAP id.example.com 127.0.0.1", f"--ignore-certificate-errors-spki-list={spki}"])
    for name in ["alice-test", "bob-test", "carol-test", "carol-test"]:   # carol twice: BE/BS adopted once
        ctx = b.new_context(); page = ctx.new_page(); cdp = ctx.new_cdp_session(page); cdp.send("WebAuthn.enable")
        resident = name == "carol-test"
        a = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {"protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
             "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True,
             "defaultBackupEligibility": resident, "defaultBackupState": resident}})["authenticatorId"]
        for cr in json.load(open(os.path.join(C8, f"passkey-{name}.json"))):
            cr["rpId"] = "id.example.com"                       # same key pair + credential id, new RP ID (as the import was told)
            cr["signCount"] = int(time.time()) - 1_700_000_000   # above the imported counter
            cdp.send("WebAuthn.addCredential", {"authenticatorId": a, "credential": cr})
        got = {}
        # The authorization response is a redirect to the (non-existent) app:
        # record the request (route() doesn't apply to redirect targets).
        page.on("request", lambda req: got.setdefault("url", req.url) if req.url.startswith("https://app.example.com/cb") else None)
        q = urllib.parse.urlencode({"client_id": "rehearsal", "response_type": "code", "redirect_uri": "https://app.example.com/cb",
                                    "scope": "openid profile email groups", "state": os.urandom(12).hex(), "nonce": os.urandom(12).hex()})
        page.goto(f"{BASE}/api/oidc/authorization?{q}")
        for _ in range(40):
            if "url" in got: break
            page.wait_for_timeout(500)
            u = page.locator("#username-textfield")
            if u.count() and u.is_visible():
                if u.is_enabled(): u.fill(name)
                page.fill("#password-textfield", pw[name]); page.click("#sign-in-button"); page.wait_for_timeout(1500)
        if "url" not in got:
            page.screenshot(path=os.path.join(R, f"fail-{name}.png")); print(f"FAIL {name}: no code (at {page.url[:80]})"); ok_all = False; ctx.close(); continue
        code = urllib.parse.parse_qs(urllib.parse.urlparse(got["url"]).query).get("code", [""])[0]
        st, tk = token(code)
        if st != 200:
            print(f"FAIL {name}: token {st} {tk.get('error')}"); ok_all = False; ctx.close(); continue
        c = claims(tk["id_token"]); kc = users[name]
        want_groups = sorted(g.lstrip("/") for g in kc.get("groups", []))
        checks = {"sub==KC id": c.get("sub") == kc["id"], "username": c.get("preferred_username") == name,
                  "email": c.get("email") == kc["email"], "groups": sorted(c.get("groups", [])) == want_groups}
        ok = all(checks.values()); ok_all &= ok
        print(f"{'PASS' if ok else 'FAIL'} {name}: password + same passkey -> code -> ID token; " + ", ".join(f"{k}={'ok' if v else 'NO'}" for k, v in checks.items()))
        ctx.close()
    b.close()
print("ALL PASS" if ok_all else "SOME FAILED")
