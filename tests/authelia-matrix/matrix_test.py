"""Login matrix, automated: headless Chromium with a virtual passkey
(CDP WebAuthn), against the test Authelia and the app copies.
Usage: python matrix_test.py <apps...>   (secrets via env: PW_MATRIX_USER, PW_MATRIX_ADMIN)
"""
import os, re, subprocess, sys, time, json
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

APPS_DOMAIN = os.environ["APPS"]
ISSUER = f"https://auth.{APPS_DOMAIN}/realms/{os.environ['REALM']}"
SSH = ["ssh", "root@" + os.environ["SGNL_HOST"]]
SHOTS = os.environ["SHOTS"]
USERS = {"matrix-user": os.environ["PW_MATRIX_USER"], "matrix-admin": os.environ["PW_MATRIX_ADMIN"],
         "matrix-outsider": os.environ["PW_MATRIX_OUTSIDER"]}   # in no group: every app must refuse

# Who must be refused (as Keycloak's login flows: sgnl_users for every
# app, forgejo_users too for Forgejo).
def must_refuse(app, user):
    return user == "matrix-outsider" or (app == "forgejo" and user == "matrix-user")


def start(app, page):
    """Begin an app's login, up to the point it sends the browser to Authelia."""
    if app == "grafana":
        page.goto(URL("monitor-next") + "/login/generic_oauth")
    elif app == "forgejo":
        page.goto(URL("git-next") + "/user/oauth2/authelia")
    elif app == "listmonk":
        page.goto(URL("listmonk-next") + "/admin/login")
    elif app in ("dashy", "opencloud"):
        page.goto(URL("home-next" if app == "dashy" else "drive-next") + "/")
    elif app == "vaultwarden":
        page.goto(URL("vault-next") + "/#/login")
        box = page.locator("input[type=email]:visible").first
        box.wait_for(timeout=30000)
        box.fill("x@" + os.environ["DOMAIN"])
        page.get_by_role("button", name=re.compile("single sign-on", re.I)).first.click()
    elif app == "bulwark":
        page.goto(URL("inbox-next") + "/")
        page.wait_for_timeout(2500)
        page.get_by_role("button", name=re.compile("sign in with sso", re.I)).first.click()


def expect_refused(app, page, user):
    """The login must end with Authelia's access_denied back at the app."""
    seen = []
    page.on("request", lambda r: seen.append(r.url) if "error=access_denied" in r.url else None)
    start(app, page)
    for _ in range(8):
        page.wait_for_timeout(1500)
        if seen:
            break
        if page.url.startswith(f"https://auth.{APPS_DOMAIN}"):
            authelia_login(page, user)
    return bool(seen), f"refused={'yes (access_denied)' if seen else 'NO'}"
URL = lambda label: f"https://{label}.{APPS_DOMAIN}"


def _notif():
    r = subprocess.run(SSH + ['c=$(docker ps -qf label=service=sgnl-authelia -f label=role=web|head -1); docker exec $c cat /data/notifications.txt 2>/dev/null'],
                       capture_output=True, text=True)
    return r.stdout


def notif_size():
    # The file notifier overwrites the file per message: remember its Date line.
    m = re.search(r"^Date: (.*)$", _notif(), re.M)
    return m.group(1) if m else ""


def otp_after(before, timeout=60):
    for _ in range(timeout // 2):
        t = _notif()
        m = re.search(r"^Date: (.*)$", t, re.M)
        codes = re.findall(r"^\s*([A-Z0-9]{8})\s*$", t, re.M)
        if m and m.group(1) != before and codes:
            return codes[-1]
        time.sleep(2)
    raise RuntimeError("no one-time code")


def shot(page, name):
    p = os.path.join(SHOTS, name + ".png")
    try:
        page.screenshot(path=p, full_page=True)
    except Exception:
        pass
    return p


def authelia_login(page, user):
    """On Authelia's portal: password (if asked), then passkey (register once)."""
    page.wait_for_load_state("load")
    if "/consent/" in page.url:
        page.wait_for_timeout(1000)
        rem = page.get_by_role("checkbox")
        if rem.count() and not rem.first.is_checked():
            rem.first.check()
        page.get_by_role("button", name=re.compile("accept", re.I)).click()
        page.wait_for_timeout(3000)
        return "ok"
    u = page.locator("#username-textfield")
    if u.count() and u.is_visible():
        if u.is_enabled():
            u.fill(user)
        page.fill("#password-textfield", USERS[user])
        page.click("#sign-in-button")
    # Wait for the second-factor page (or leaving Authelia: passkey used automatically).
    for _ in range(30):
        page.wait_for_timeout(500)
        if not page.url.startswith(f"https://auth.{APPS_DOMAIN}"):
            return "ok"
        if page.get_by_text("Register device").count() and page.get_by_text("Register device").is_visible():
            break
    # Second factor: register a passkey the first time, else it's used automatically.
    if page.get_by_text("Register device").count() and page.get_by_text("Register device").is_visible():
        n0 = notif_size()
        page.get_by_text("Register device").click()
        page.wait_for_load_state("load")
        if not page.get_by_role("button", name=re.compile("add", re.I)).count():
            time.sleep(2)
        page.get_by_role("button", name=re.compile("^add$", re.I)).click()
        # Either a one-time code is asked first (identity check), or the
        # session is already verified and the description step shows.
        desc = page.locator("[role=dialog] input")
        for _ in range(40):
            page.wait_for_timeout(500)
            if page.get_by_text("One-Time Code").count() and page.get_by_text("One-Time Code").first.is_visible():
                code = otp_after(n0)
                page.locator("[role=dialog] input").first.fill(code)
                page.get_by_role("button", name=re.compile("verify", re.I)).click()
                page.wait_for_timeout(1500)
                break
            if page.get_by_text("Enter a description").count():
                break
        page.get_by_text("Enter a description").wait_for(timeout=20000)
        page.locator("[role=dialog] input").first.fill("virtual")
        page.get_by_role("button", name=re.compile("^next$", re.I)).click()
        page.wait_for_timeout(5000)
        return "registered"
    return "ok"


def login_via(page, start, user, done_re, max_steps=4):
    """Open the app's login start URL; drive Authelia until we're back on the app."""
    page.goto(start)
    for _ in range(max_steps):
        page.wait_for_load_state("load")
        if page.url.startswith(f"https://auth.{APPS_DOMAIN}"):
            r = authelia_login(page, user)
            if r == "registered":
                page.goto(start)   # registration ends on settings; start again
            continue
        if re.search(done_re, page.url):
            return True
        time.sleep(1)
    return bool(re.search(done_re, page.url))


def check(app, page, user):
    if must_refuse(app, user):
        return expect_refused(app, page, user)
    admin = user == "matrix-admin"
    req = page.context.request
    if app == "grafana":
        ok = login_via(page, URL("monitor-next") + "/login/generic_oauth", user, r"monitor-next[^/]*/($|\?|d/|home)")
        u = req.get(URL("monitor-next") + "/api/user").json()
        orgs = req.get(URL("monitor-next") + "/api/user/orgs").json()
        role = orgs[0]["role"] if orgs else None
        return ok and u.get("login") == user and role == ("Admin" if admin else "Viewer"), f"login={u.get('login')} role={role}"
    if app == "forgejo":
        ok = login_via(page, URL("git-next") + "/user/oauth2/authelia", user, r"git-next[^/]*/($|\?|explore|" + user + ")")
        name_ok = user in req.get(URL("git-next") + "/user/settings").text()
        adm = req.get(URL("git-next") + "/admin", max_redirects=0).status
        want = 200 if admin else 403
        return ok and name_ok and adm == want, f"settings_has_user={name_ok} admin_page={adm} (want {want})"
    if app == "listmonk":
        ok = login_via(page, URL("listmonk-next") + "/admin/login", user, r"listmonk-next[^/]*/admin")
        r = req.get(URL("listmonk-next") + "/api/profile")
        body = r.text()[:200]
        if admin:
            return ok and r.status == 200 and "matrix-admin" in body, f"profile={r.status}"
        # matrix-user has no listmonk account (auto_create_users off, as live): must be refused.
        return r.status != 200, f"profile={r.status} (refused, as live: no account)"
    if app == "vaultwarden":
        page.goto(URL("vault-next") + "/#/login")
        page.wait_for_load_state("load")
        box = page.locator("input[type=email]:visible").first
        box.wait_for(timeout=30000)
        box.fill(f"{user}@{os.environ['DOMAIN']}")
        page.get_by_role("button", name=re.compile("single sign-on", re.I)).first.click()
        page.wait_for_timeout(3000)
        for _ in range(4):
            page.wait_for_load_state("load")
            if page.url.startswith(f"https://auth.{APPS_DOMAIN}"):
                if authelia_login(page, user) == "registered":
                    return False, "passkey registered mid-flow; rerun"
            else:
                break
        page.wait_for_timeout(4000)
        txt = page.inner_text("body")[:2000]
        ok = page.url.startswith(URL("vault-next")) and re.search(r"master password", txt, re.I) is not None
        return ok, f"url={page.url.split('#')[1][:40] if '#' in page.url else page.url[:60]} set-master-password={'yes' if ok else 'no'}"
    if app == "dashy":
        logs = []
        page.on("console", lambda m: logs.append(m.text[:200]) if m.type in ("error", "warning") else None)
        page.goto(URL("home-next") + "/")
        for _ in range(4):
            page.wait_for_load_state("load")
            if page.url.startswith(f"https://auth.{APPS_DOMAIN}"):
                if authelia_login(page, user) == "registered":
                    page.goto(URL("home-next") + "/")
            else:
                break
        page.wait_for_timeout(3000)
        info = page.evaluate("() => JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k]) => /user|oidc|auth|token/i.test(k)).map(([k,v]) => [k, v.length > 300 ? v.slice(0,300) : v])))")
        txt = page.inner_text("body")[:500]
        ok = page.url.startswith(URL("home-next")) and "Authelia" in txt
        isadm = None
        try:
            d = json.loads(info)
            blob = " ".join(d.values())
            isadm = '"isAdmin":true' in blob.replace(" ", "") or "admins" in blob
        except Exception:
            pass
        return ok, f"page_ok={ok} admin_seen={isadm} console={logs[-3:] if not ok else ''}"
    if app == "opencloud":
        page.goto(URL("drive-next") + "/")
        for _ in range(5):
            page.wait_for_load_state("load")
            if page.url.startswith(f"https://auth.{APPS_DOMAIN}"):
                if authelia_login(page, user) == "registered":
                    page.goto(URL("drive-next") + "/")
            else:
                page.wait_for_timeout(3000)
                if not page.url.startswith(f"https://auth.{APPS_DOMAIN}"):
                    break
        page.wait_for_timeout(5000)
        # The web app keeps its OIDC user (access token) in session/local storage.
        res = page.evaluate("""async () => {
          const all = {...sessionStorage, ...localStorage};
          const k = Object.keys(all).find(k => k.includes('oidc.user') || k.includes('oAuth.user'));
          if (!k) return {err: 'no token in storage', keys: Object.keys(all).slice(0, 10)};
          const tok = JSON.parse(all[k]).access_token;
          const r = await fetch('/graph/v1.0/me?$expand=appRoleAssignments', {headers: {Authorization: 'Bearer ' + tok}});
          const j = await r.json().catch(() => ({}));
          return {status: r.status, name: j.onPremisesSamAccountName, roles: (j.appRoleAssignments || []).map(a => a.appRoleId)};
        }""")
        ADMIN_ROLE, USER_ROLE = "71881883-1768-46bd-a24d-a356a2afdf7f", "d7beeea8-8ff4-406b-8fb6-ab2dd81e6b11"
        want = ADMIN_ROLE if admin else USER_ROLE
        ok = res.get("status") == 200 and res.get("name") == user and want in (res.get("roles") or [])
        role = {ADMIN_ROLE: "Admin", USER_ROLE: "User"}
        return ok, f"graph={res.get('status')} name={res.get('name')} roles={[role.get(r, r[:8]) for r in res.get('roles') or []]} {res.get('err', '')}{res.get('keys', '')}"
    if app == "bulwark":
        page.goto(URL("inbox-next") + "/")
        clicked = False
        for _ in range(8):
            page.wait_for_load_state("load")
            page.wait_for_timeout(1500)
            if page.url.startswith(f"https://auth.{APPS_DOMAIN}"):
                if authelia_login(page, user) == "registered":
                    page.goto(URL("inbox-next") + "/")
                    clicked = False
                continue
            btn = page.get_by_role("button", name=re.compile("sign in with sso", re.I))
            # Click once: a second click starts a second login whose state
            # doesn't match the first one's callback.
            if "/login" in page.url and btn.count() and not clicked:
                btn.first.click()
                clicked = True
                page.wait_for_timeout(3000)
                continue
            break
        try:
            page.wait_for_url(re.compile(r"/mail/"), timeout=30000)
        except PWTimeout:
            pass
        page.wait_for_timeout(2000)
        txt = page.inner_text("body")[:3000]
        # The mailbox opened = Bulwark's JMAP session with Stalwart works,
        # i.e. Stalwart accepted Authelia's access token (via userinfo).
        ok = page.url.startswith(URL("inbox-next")) and re.search(r"\bInbox\b", txt) is not None
        return ok, f"url={page.url.split(APPS_DOMAIN)[-1][:50]} inbox_shown={ok} {'' if ok else txt[:150]!r}"
    return False, "unknown app"


def main(apps):
    results = []
    with sync_playwright() as p:
        # Test hosts resolve straight to the server: a lookup made before a
        # new record spread is cached as "no such name" for 30 minutes.
        b = p.chromium.launch(headless=True, args=[f"--host-resolver-rules=MAP *.{APPS_DOMAIN} {os.environ['SGNL_HOST']}"])
        for user in USERS:
            ctx = b.new_context(ignore_https_errors=False)
            page = ctx.new_page()
            cdp = ctx.new_cdp_session(page)
            cdp.send("WebAuthn.enable")
            auth = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {
                "protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
                "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}})["authenticatorId"]
            # The test user's passkey survives runs (test-only keys, kept in the scratchpad).
            cred_file = os.path.join(SHOTS, "..", f"passkey-{user}.json")
            if os.path.exists(cred_file):
                for cr in json.load(open(cred_file)):
                    # Authelia rejects a sign counter that went backwards
                    # (cloned-key check); runs that didn't save leave it stale.
                    cr["signCount"] = max(cr.get("signCount", 0), int(time.time()) - 1_700_000_000)
                    cdp.send("WebAuthn.addCredential", {"authenticatorId": auth, "credential": cr})
            for app in apps:
                try:
                    ok, detail = check(app, page, user)
                except (PWTimeout, Exception) as e:
                    ok, detail = False, f"{type(e).__name__}: {str(e)[:200]}"
                s = shot(page, f"{app}-{user}")
                results.append((app, user, ok, detail))
                print(f"{'PASS' if ok else 'FAIL'}  {app:<12} {user:<13} {detail}", flush=True)
            creds = cdp.send("WebAuthn.getCredentials", {"authenticatorId": auth})["credentials"]
            if creds:
                with open(cred_file, "w") as f:
                    json.dump(creds, f)
                os.chmod(cred_file, 0o600)
            ctx.close()
        b.close()
    return results


if __name__ == "__main__":
    r = main(sys.argv[1:])
    sys.exit(0 if all(x[2] for x in r) else 1)
