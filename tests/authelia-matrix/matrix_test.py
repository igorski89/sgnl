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
USERS = {"matrix-user": os.environ["PW_MATRIX_USER"], "matrix-admin": os.environ["PW_MATRIX_ADMIN"]}
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
    return False, "unknown app"


def main(apps):
    results = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
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
