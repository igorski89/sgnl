# Security model — Phase 1

What runs, what each piece exposes, what protects it, and what's still
open, against the pinned upstream versions. Identity: Keycloak (it
replaced Authelia + lldap in 2026-10).

**Status legend:** ✅ implemented in this repo · 🧪 also tested locally ·
⏳ needs a step on the real host (see `DEPLOY.md`) · ❌ not done.

## Decisions (2026-10-07)

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | Rewrite Stalwart for 0.16 (`config.json` + apply plan) | ✅🧪 `stalwart/config.json`, `stalwart/plan.ndjson`, `stalwart/plan-oidc.ndjson`, `bin/stalwart-apply` |
| 2 | Submission port | **465** (implicit TLS) + 993. ✅🧪 Lambda switched to `secure: true` on 465 |
| 3 | Per-app OIDC everywhere supported, incl. Vaultwarden SSO | ✅ Keycloak clients (Authelia until 2026-10-19) for OpenCloud (4), Forgejo, Vaultwarden, Bulwark, Stalwart web UI, Dashy |
| 4 | Bump all image pins | ✅ exact tags, all verified to exist (README table) |
| 5 | File storage volume | On the root disk (OpenCloud); check free space before deploying, grow the disk when it fills |
| 6 | Host: SSH passwords off + `DOCKER-USER` rules | ✅ `host/harden.sh --apply`. Check afterwards: key SSH ok, password SSH refused, every site on the host ok on IPv4/IPv6, 465/993 ok; from outside only 22/80/443/465/993 answer (§2) |

## 1. "Shouldn't everything be behind the IdP?"

Yes for every browser login. No as a literal forward-auth proxy:

- `kamal-proxy` has no auth middleware. Getting it would mean inserting
  Caddy/Traefik in front of `cotenant` too.
- Forward-auth breaks every non-browser client: IMAP/SMTP clients,
  Bitwarden apps, file sync apps/WebDAV, Collabora ↔ OpenCloud (WOPI)
  callbacks. The bypass rules they need are exactly the high-value API
  paths.

What's built instead is **per-app OIDC against Keycloak, with two factors
enforced once in Keycloak** (password + passkey on every login, §7):

| App | Login | What stays outside the IdP, and why |
| --- | --- | --- |
| OpenCloud | Keycloak (built-in IdP off), roles from Keycloak groups | Mobile apps hold Keycloak offline tokens. Break-glass: local admin in OpenCloud's own store, CLI/API only |
| Forgejo | Keycloak, no local password form | git over HTTPS: personal access tokens |
| Vaultwarden | Keycloak SSO, `SSO_ONLY` | **Master password**, by design: it decrypts the vault on your device, and Keycloak never sees it |
| Bulwark | Keycloak, password form hidden (`OAUTH_ONLY`) | — |
| Stalwart web UI (`/account`, `/admin`) | Keycloak (public PKCE client) | Break-glass admin (`STALWART_RECOVERY_ADMIN`), used by `bin/stalwart-apply` |
| Dashy | Keycloak (public PKCE client) | — |
| Stalwart IMAP 993 / submission 465 | Per-device **app passwords** (created in `/account`) | Apple Mail, iOS Mail and Thunderbird can't do OAuth against a third-party IdP |
| SES relay account | Password (machine) | Scoped so it can only deliver to local mailboxes (§3) |
| Collabora | No user login; admin console disabled | Only OpenCloud's WOPI endpoint may load files (`aliasgroup1`); WOPI proof key per install |

**Stalwart and the IdP (tested on 0.16.25 with Authelia, 2026-10-08;
switched to Keycloak 2026-10-19).** Keycloak is Stalwart's directory for
the whole server (`stalwart/plan-oidc.ndjson`); accounts are matched by
`preferred_username`. Per-domain directories are an Enterprise feature;
the community edition ignores them. What this means:
- Plain account passwords never work for mail. Native clients and the
  SES relay use **app passwords**, which Stalwart checks in its own store
  first. They keep working while the IdP is down (tested, including a
  Stalwart restart with it stopped). Inbound mail doesn't depend on
  Keycloak.
- Web UI and Bulwark logins do. If Stalwart starts while Keycloak is
  unreachable, those logins stay on Stalwart's own form until Stalwart
  is restarted once (`DEPLOY.md` step 2 notes).
- The break-glass admin (`STALWART_RECOVERY_ADMIN`) is independent of
  Keycloak.

## 2. The host (shared with `cotenant`)

What this section assumes about the host (check yours, read-only):
Ubuntu 24.04 with Docker; `ufw` allows 22/80/443; only `kamal-proxy`
publishes ports; `DOCKER-USER` is empty (v4 and v6);
`unattended-upgrades` is active; no fail2ban/CrowdSec; anything else
on the host listens on 127.0.0.1 only. `sshd`: root key-only, but on a
stock image **password login is on for every other account** (no
explicit setting, so the default `yes` applies). Mind the free disk
space too.

### 2a. SSH: password login off

**What:** a drop-in `/etc/ssh/sshd_config.d/00-sgnl-hardening.conf` with
`PasswordAuthentication no`, `KbdInteractiveAuthentication no` and
`PermitRootLogin prohibit-password` (what root effectively has today).

**Why:** root already can't log in with a password, but any other
account with a password (one created later by a package or by hand) could
be brute-forced over SSH. Key-only login makes SSH brute-force pointless,
which is also why fail2ban for sshd isn't worth adding.

**Risk:** zero for you, as long as you log in with a key (you do: that's
how these checks ran). The `00-` prefix matters: `sshd_config.d` is
first-match-wins, so it beats a later cloud-init drop-in. The script
runs `sshd -t` before reloading, and the reload doesn't drop open
sessions.

### 2b. Docker-published ports: default-deny

**The problem:** `ufw` looks like it limits the box to 22/80/443, but
Docker rewrites (DNATs) traffic for published container ports in the
`nat` table *before* `ufw`'s filter rules ever see it. Any port a
container publishes is open to the internet regardless of `ufw`. Today
only kamal-proxy publishes, so nothing leaks. But Stalwart will add
465/993, and one careless `publish:` or `port:` (e.g. a Postgres
accessory with `port: 5432`) would be silently internet-facing.

**What:** the `DOCKER-USER` chain is Docker's documented hook for this.
Docker evaluates it before its own rules and never flushes it. The rules
(IPv4 and IPv6, since containers publish on `[::]` too):

1. Allow replies to connections containers opened (`ESTABLISHED,RELATED`).
2. From the public interface (`eth0`), allow *new* connections only to
   original destination ports 80, 443, 465, 993 (matched with
   `--ctorigdstport`, i.e. before Docker's port rewrite).
3. Drop every other new connection arriving on `eth0` for a container.

Container egress (`cotenant` calling APIs, Stalwart → SES) and
container-to-container traffic never enter on `eth0`, so they're
untouched. Persisted in `/etc/ufw/after.rules` / `after6.rules` (the
`ufw-docker` pattern), so it survives reboots and `ufw reload`.

**Risk:** this touches `cotenant`'s ingress. A mistake would block
`app.example.com`. Mitigations: the rules were validated with
`iptables-restore --test` on Ubuntu 24.04 🧪, the script keeps backups
(`*.pre-sgnl`), the rollback is three commands (in the script header),
and the allow-list includes 80/443 explicitly. Run it at a quiet time
with a second SSH session open, then check from outside with `nmap` and
load `app.example.com`.

**How:** `ssh root@203.0.113.10 'bash -s' < host/harden.sh` shows exactly
what it would do; add `-- --apply` to do it. ⏳ Not run. Your go.

### 2c. Other host items
- **Hetzner Cloud Firewall:** check the console. If one exists, it needs
  465/993. If none, consider adding one as a second layer (SSH from known
  IPs only, if your IPs are stable enough).
- **Deploys run as root over SSH.** Acceptable for one operator. A
  non-root `deploy` user in the `docker` group is root-equivalent anyway,
  so it would mostly add audit separation.
- **Shared `kamal-proxy`:** a bad `sgnl` deploy can in theory disturb
  `cotenant`'s routing. Distinct `*.sgnl` hosts, and the proxy's own config
  is never touched.

## 3. Mail: Stalwart (+ Bulwark)

**Exposed:** 465 (submission), 993 (IMAPS), and `mail.sgnl` on 443 via
kamal-proxy (JMAP, `/account`, `/admin`). Nothing else listens:
0.16's defaults also open 25, 443, 995 and 4190, and the plan removes
those listeners 🧪.

| Control | Status |
| --- | --- |
| Login required on submission. Sender must match the logged-in account | ✅🧪 normal user spoofing a sender → `501` |
| No credentials, no mail: an unauthenticated client can't even issue `MAIL FROM` | ✅🧪 `503 You must authenticate first` |
| SES relay account may keep the external sender, but **can only deliver to local mailboxes**, so a leaked relay app password can't send mail out through SES | ✅🧪 external→external → `550 Relay not allowed`. Mixed recipients: only local accepted |
| SES relay account can **only submit**: permissions replaced with `authenticate` + `emailSend` | ✅🧪 IMAP login refused, JMAP mail calls `forbidden` |
| Spam filter also runs on relayed inbound mail (off by default for authenticated sessions) | ✅🧪 `X-Spam-Status` on delivered mail |
| No delivery receipts back to external senders (backscatter) | 🧪 none queued |
| Auto-ban: 10 failed logins/hour → 24h ban (default was 100/day) | ✅🧪 |
| Outbound only via SES on 587, STARTTLS required (Hetzner blocks outgoing 465/25) | ✅ live 2026-10-08: delivered via `email-smtp.eu-central-1.amazonaws.com:587`, TLS 1.3, no invalid-cert fallback |
| TLS cert via Let's Encrypt DNS-01, scoped so Stalwart can't touch apex MX/SPF/DMARC | ✅🧪 order issued for `mail.sgnl` only; ⏳ real issuance |
| Web UI bundle pinned (v1.0.11) instead of "latest from GitHub" | ✅🧪 |
| HTTP behind kamal-proxy: real client IPs (`X-Forwarded-For`), HSTS | ✅ · ⏳ verify bans hit client IPs, not 172.19.0.3 |
| Logs to stdout (`kamal app logs`) | ✅🧪 |

Operational gotchas found while testing (also in `DEPLOY.md`):
- A ban covers *everything* from that IP, admin API included, and
  survives restarts. The unban procedure (via the container's Docker
  network) is in `DEPLOY.md` step 2 🧪.
- App passwords don't touch Keycloak, so an IdP outage doesn't make mail
  clients or the SES relay fail logins (and collect auto-ban strikes).
- `ReloadSettings` fails while the IdP is unreachable; a restart works.
- **Changing the IdP collects strikes.** On the switch to Keycloak
  (2026-10-19) a still-open webmail session kept sending its old Authelia
  token: 10 failures → alice's IP banned, twice, which also blocked his
  mail apps. Before an IdP change, close webmail tabs; afterwards watch
  for `security.authentication-ban` and unban (`DEPLOY.md`).

**Bulwark:** stateless Next.js. Main risk is XSS in rendered mail. Keep it
patched. Admin functions towards Stalwart are disabled
(`STALWART_ADMIN_ACCESS=off`); telemetry and update checks are off.

## 4. Vaultwarden

Highest-value target. Vault contents are end-to-end encrypted, so a
server compromise yields ciphertext. But an attacker who can modify the
served web vault JS could capture master passwords typed into the
browser.

| Control | Status |
| --- | --- |
| `/admin` disabled (no `ADMIN_TOKEN`); temporary re-enable procedure in the deploy file | ✅ |
| Signups and invitations off, password hints hidden | ✅ |
| Login through Keycloak (password + passkey), `SSO_ONLY=true`. Linked by `<issuer>/<sub>` (`sso_users`): an issuer change needs that table updated, or logins are refused | ✅ 2026-10-19 |
| 1.37.4, obsolete `WEBSOCKET_ENABLED` removed | ✅ |
| Prefer the browser extension / mobile apps over the web vault for unlocking (they don't load JS from the server) | habit |
| Encrypted backups of `/data` | ✅ nightly (`BACKUPS.md`), restore drill 2026-10-11 |

## 5. AWS mail pipeline and machine credentials

| Credential | Lives in | Blast radius if leaked | Hardening |
| --- | --- | --- | --- |
| SES relay app password | Stalwart (`bin/stalwart-relay-app-password`) → Vaultwarden + Secrets Manager (Lambda) | Deliver mail into local mailboxes, nothing else | ✅🧪 scoped (§3); ~48 random chars |
| SES SMTP credentials (IAM user `ses-smtp-example-user.20260302-163030`, shared with Gmail "send mail as") | Vaultwarden (`bin/sgnl-secret`) → Stalwart datastore, Keycloak realm (via `bin/sgnl-keycloak-apply`), Vaultwarden/Forgejo/OpenCloud env, backup alerts | Send from your domain via SES | ❌ separate SMTP user per app + IAM `ses:FromAddress` condition, so one leak is revocable alone |
| Cloudflare token | Vaultwarden (`bin/sgnl-secret`) → Stalwart datastore (no longer a container env var) | Rewrite any DNS record of all five account zones (example.com, getmimiai.com, …), from any IP | ⚠️ **accepted risk** (2026-10-08): all zones, no IP filter, no expiry. Tightening is optional, see `DNS.md` |
| Stalwart break-glass admin | Vaultwarden (`bin/sgnl-secret`) → container env | Full mail admin | ✅ ~48 random chars, auto-ban applies, independent of Keycloak |
| `example-sgnl-terraform` IAM key | Vaultwarden (`bin/sgnl-secret`) → env of the `./tf`/`./awscli` containers (no file anywhere) | Create/delete the SES/S3/Lambda/SQS resources | ✅ least-privilege; never on the server |
| OIDC client secrets (bulwark, vaultwarden, forgejo) | Vaultwarden (`bin/sgnl-secret`) → Keycloak (rendered into the realm import over SSH stdin) + the app's env / Forgejo DB | Impersonate that app towards Keycloak | ✅ per-client; public clients use PKCE and have no secret |
| Keycloak master admin (`admin`, bootstrap) | Vaultwarden (`bin/sgnl-secret`) → container env (`KC_BOOTSTRAP_ADMIN_PASSWORD`) | Everything in Keycloak, i.e. every login | ✅ 32 random chars, master-realm lockout; used only by `bin/sgnl-kcadm`/`sgnl-kcimport`/`sgnl-keycloak-apply`, password over stdin |
| `sgnl-agent` client secret (service account) | Vaultwarden (`bin/sgnl-secret`) → `bin/sgnl-kc` (POST body, not argv) | Create/disable users, change group membership, read events and clients; **not** realm settings, flows or clients | ✅ least privilege (§7) |
| Keycloak Postgres password | Vaultwarden (`bin/sgnl-secret`) → env of Keycloak + its accessory | The identity database (no published port: reachable only on the kamal network) | ✅ |

The inbound pipeline's durability (S3-first, Lambda retries, DLQ, alarms)
is in `../aws/README.md`.

## 6. OpenCloud + Collabora (files, office editing)

Replaced the Nextcloud + ONLYOFFICE plan on 2026-10-11: one Go service
(no PHP app store, no Postgres/Redis) plus the editor.

| Control | Status |
| --- | --- |
| OpenCloud 7.2.x "production" line pinned (8.x are rolling releases) | ✅ 7.2.4 |
| Login only via Keycloak (Authelia until 2026-10-19): built-in IdP excluded (`OC_EXCLUDE_RUN_SERVICES=idp`), basic auth off, demo users off. Accounts found by `preferred_username` | ✅🧪 |
| Roles from Keycloak groups at every login (`opencloud/proxy.yaml`): `admins` → admin, `sgnl_users` → user, anyone else refused | ✅🧪 alice is admin |
| Web client without `offline_access` (no long-lived token in the browser) | ✅ |
| Public share links need a password, writable ones too | ✅ |
| CSP limited to our hosts (`opencloud/csp.yaml`, IdP = `id.sgnl`) | ✅ |
| Collabora: admin console off; only drive.sgnl may be a WOPI host / frame it | ✅ |
| Collabora **without** `SYS_ADMIN`, `seccomp=unconfined`, `apparmor=unconfined` (the official example uses all three). Cost: its audit shows "Slow Kit jail setup with copying, cannot bind-mount" (documents open in ~0.5 s); all security checks in that audit are green. Decided to keep, 2026-10-11 | ✅🧪 |
| Nightly backup of both volumes incl. extended attributes (`BACKUPS.md`) | ✅🧪 restore drill 2026-10-11 |
| Suspend: OpenCloud account disabled by `bin/sgnl-user-suspend`; Keycloak disable ends refresh/offline tokens | ✅🧪 |
| App tokens (auth-app, for the suspend script and WebDAV tools) bypass Keycloak; blocked by the account disable | ✅🧪 |
| Server-side encryption | Not worth it (keys on the same box). Encrypted backups cover the real risk |

## 6b. Forgejo

| Control | Status |
| --- | --- |
| Login only via Keycloak OIDC (two factors), restricted to group `forgejo_users` (Keycloak flow `sgnl-forgejo`); no sign-up, no local password form (`ENABLE_INTERNAL_SIGNIN=false`). Auth source still named `authelia` (accounts linked by source id + `sub`) | ✅ |
| Everything requires sign-in (`REQUIRE_SIGNIN_VIEW`); new repos private | ✅ |
| No SSH (port 22 is the host's sshd); HTTPS + personal access tokens | ✅ |
| Admin flag and team membership from the groups claim, re-applied at login (`--group-team-map-removal`) | ✅ |
| Tokens survive removal from groups: `bin/sgnl-user-suspend` sets prohibit login (blocks tokens too) | ✅🧪 2026-10-09 |
| Actions/CI off (a runner would execute code on the shared host) | ✅ |
| Nightly backup of repos + LFS + SQLite (`BACKUPS.md`) | ✅ |

## 6c. Suspending a person

`bin/sgnl-user-suspend` (`USERS.md`) blocks SSO (Keycloak: account
disabled and **all its sessions ended at once**, incl. refresh/offline
tokens; nobody else is affected), mail incl. app passwords (Stalwart
permission), git tokens (Forgejo) and files (OpenCloud account). Tested
both ways (Keycloak step 2026-10-19: 1 session → 0).
Residual: an access token already issued to an app stays valid until it
expires (≤ 5 min). The Authelia-era gap (open sessions up to 1 h, restart
to end them) is gone.

## 6d. Dashy (home.sgnl)

| Control | Status |
| --- | --- |
| Login via Keycloak (public PKCE client, flow `sgnl-apps`: needs `sgnl_users`) | ✅🧪 2026-10-19 |
| Server refuses config and status checks without a valid id_token; anonymous gets only the login bootstrap | ✅🧪 |
| Config editing in the UI disabled; config read-only mount from git | ✅ |
| Group filtering is client-side only (tiles are hints; apps enforce access) | ℹ️ by design |
| Pinned 4.7.0 (4.8.x churned four patch releases in a week); Dashy's server still logs an update check at start | ✅ · ℹ️ |

## 7. Keycloak (identity)

The front door for everything in §1, so compromising it means
compromising everything. Keycloak 26.7.5 at `id.sgnl`, Postgres 17
accessory (no published port, kamal network only), since 2026-10-19
(Authelia + lldap stopped that day; `../instance/docs/PLAN-keycloak.md`).

| Control | Status |
| --- | --- |
| Realm as code: `keycloak/realm.yaml` applied with keycloak-config-cli (`bin/sgnl-keycloak-apply`); clients, groups and flows are fully managed (`IMPORT_MANAGED_*=full`: anything not in the file is deleted), so UI drift doesn't survive the next apply | ✅ |
| Secrets never on argv or on disk unencrypted: rendered locally, sent over SSH stdin into a tmpfs (`--tmpfs /config`) of a throwaway container | ✅ |
| Every login: password (`length(12) and notUsername and notEmail`) **and a passkey (WebAuthn, required)**; no TOTP, no SMS. Required actions (set password, register passkey) run after the flow's group checks | ✅🧪 |
| Per-client access via flow overrides: `sgnl-apps` denies anyone without `sgnl_users`, `sgnl-forgejo` also needs `forgejo_users` ("Access denied") | ✅🧪 tested with a throwaway user |
| PKCE S256 on every client, consent off, no self-registration, no direct (password) grants | ✅ |
| Brute force: 3 failures / 120 s → 30 min lockout (message unchanged, no oracle); master realm: lockout after 5 failures | ✅ |
| Sessions 8 h idle / 7 days max; access tokens 5 min; offline tokens only for clients that ask (`offline_access` optional) | ✅ |
| **Admin console is public** at `id.sgnl/admin` (kamal-proxy can't block one path): master admin with a 32-char password + lockout, used only by scripts. Accepted risk; closes with a private network (§8) | ⚠️ accepted |
| Agent access through service account `sgnl-agent` (client credentials, secret in Vaultwarden) with only `manage-users`, `view-users`, `query-users`, `query-groups`, `view-events`, `view-clients`: it can manage people, not realm settings, flows or clients | ✅ |
| Invites without secrets: set-up link to a personal address, user only in `sgnl_invited` (no app) until `bin/sgnl-kc finish-invite` | ✅ 2026-10-19 |
| Audit: login events kept 90 days, admin events (with details) on; `bin/sgnl-kc events` | ✅ |
| Nightly `pg_dump` into restic + restore drill that boots a throwaway Keycloak and compares users/groups/clients/signing keys with live (`bin/sgnl-backup-restore-test-keycloak`) | ✅🧪 2026-10-18 |

## 8. Not covered yet

- **Backups**: done 2026-10-08, see `docs/BACKUPS.md` (Restic → Cloudflare R2). Encrypted
  backups are the real control for disk loss, ransomware and a bad
  upgrade.
- **Per-app SES SMTP users** (§5).
- **Monitoring/alerting** beyond the SES forwarder alarms.
- **Headscale/Tailscale:** moving 993 and the admin UIs onto a private
  network is the next big reduction in exposure.
- **Let's Encrypt DNS-PERSIST-01** (a static TXT record instead of an
  API token on the server). Stalwart supports it, but Let's Encrypt
  production support wasn't confirmed as of mid-2026. Revisit; it would
  remove the Cloudflare token from the server entirely.
