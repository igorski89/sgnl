"""Native-app logins against the test Authelia (OpenCloud desktop/iOS/Android:
public clients, PKCE, offline_access; their callbacks are a loopback port or an
app link, so no app copy is needed): authorize as the app would, log in with a
test user's password + passkey, catch the code at the callback, exchange it
with the PKCE verifier, check a refresh token is issued and works, and that
the access token is a JWT with the person's groups.

  bin/sgnl-authelia-matrix-test --native     (env as matrix_test.py)
"""
import base64, hashlib, json, os, random, re, sys, time, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matrix_test as m
from playwright.sync_api import sync_playwright

ISSUER = m.ISSUER
CASES = [  # client, redirect_uri (as the app sends it)
    # The desktop app sends exactly http://127.0.0.1:<port> (opencloud-eu/desktop
    # src/libsync/creds/oauth.cpp); Authelia allows any port for that form only.
    ("opencloud-desktop", f"http://127.0.0.1:{random.randint(20000, 60000)}"),
    ("opencloud-ios", "oc://ios.opencloud.eu"),
    ("opencloud-android", "oc://android.opencloud.eu"),
]


def post(url, form):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def claims(jwt):
    p = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


def run(user="matrix-user"):
    results = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=[f"--host-resolver-rules=MAP *.{m.APPS_DOMAIN} {os.environ['SGNL_HOST']}"])
        ctx = b.new_context(); page = ctx.new_page(); cdp = ctx.new_cdp_session(page); cdp.send("WebAuthn.enable")
        auth = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {"protocol": "ctap2", "transport": "internal",
                        "hasResidentKey": True, "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}})["authenticatorId"]
        cred_file = os.path.join(m.SHOTS, "..", f"passkey-{user}.json")
        for cr in json.load(open(cred_file)):
            cr["signCount"] = max(cr.get("signCount", 0), int(time.time()) - 1_700_000_000)
            cdp.send("WebAuthn.addCredential", {"authenticatorId": auth, "credential": cr})
        for client, redirect in CASES:
            got = {}
            scheme = redirect.split(":")[0] + ":"
            page.on("request", lambda r: got.setdefault("url", r.url) if r.url.startswith(redirect.rstrip("/")) else None)
            page.on("response", lambda r: got.setdefault("url", r.headers.get("location")) if (r.headers.get("location") or "").startswith(scheme) and not (r.headers.get("location") or "").startswith("https") else None)
            verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            q = urllib.parse.urlencode({"client_id": client, "response_type": "code", "redirect_uri": redirect,
                                        "scope": "openid profile email groups offline_access", "state": os.urandom(8).hex(),
                                        "code_challenge": challenge, "code_challenge_method": "S256"})
            try:
                page.goto(f"{ISSUER}/api/oidc/authorization?{q}", timeout=15000, wait_until="commit")
            except Exception:
                pass   # navigation to the callback itself fails (nothing listens): expected
            print(f"  .. {client}: at {page.url[:80]}", flush=True)
            consent = False
            for _ in range(20):
                if "url" in got:
                    break
                page.wait_for_timeout(800)
                if page.url.startswith(f"https://auth.{m.APPS_DOMAIN}"):
                    consent = consent or "/consent/" in page.url
                    try:
                        m.authelia_login(page, user)
                    except Exception as e:
                        page.screenshot(path=os.path.join(m.SHOTS, f"native-{client}.png"))
                        print(f"  .. login step: {type(e).__name__}: {str(e)[:120]}", flush=True)
                        break
            if "url" not in got:
                results.append((client, redirect, False, f"no code at the callback (page: {page.url[:70]})"))
                continue
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(got["url"]).query)
            if "code" not in qs:
                results.append((client, redirect, False, f"callback without code: {qs.get('error')}"))
                continue
            st, tok = post(f"{ISSUER}/api/oidc/token", {"grant_type": "authorization_code", "client_id": client, "code": qs["code"][0],
                                                       "redirect_uri": redirect, "code_verifier": verifier})
            if st != 200:
                results.append((client, redirect, False, f"token {st} {tok.get('error')}: {tok.get('error_description', '')[:80]}"))
                continue
            at = claims(tok["access_token"]) if tok.get("access_token", "").count(".") == 2 else {}
            st2, tok2 = post(f"{ISSUER}/api/oidc/token", {"grant_type": "refresh_token", "client_id": client, "refresh_token": tok.get("refresh_token", "")})
            ok = bool(tok.get("refresh_token")) and st2 == 200 and "sgnl_users" in (at.get("groups") or [])
            results.append((client, redirect, ok, f"refresh_token={'yes' if tok.get('refresh_token') else 'NO'} refresh_works={st2 == 200} "
                            f"jwt_access_token={'yes' if at else 'NO'} groups={at.get('groups')} consent_seen={consent}"))
        b.close()
    for c, r, ok, d in results:
        print(f"{'PASS' if ok else 'FAIL'}  {c:<18} {r:<32} {d}", flush=True)
    return all(x[2] for x in results)


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
