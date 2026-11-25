# Security model — Phase 1

What runs, what each piece exposes, what protects it, and what's still
open, against the pinned upstream versions. Identity: our Authelia fork,
the "login server" (since 2026-11-24; Keycloak from 2026-10-19,
Authelia + lldap before that).

**Status legend:** ✅ implemented in this repo · 🧪 also tested locally ·
⏳ needs a step on the real host (see `DEPLOY.md`) · ❌ not done.

## Decisions (2026-10-07)

| # | Decision | Outcome |
| --- | --- | --- |
| 1 | Rewrite Stalwart for 0.16 (`config.json` + apply plan) | ✅🧪 `stalwart/config.json`, `stalwart/plan.ndjson`, `stalwart/plan-oidc.ndjson`, `bin/stalwart-apply` |
| 2 | Submission port | **465** (implicit TLS) + 993. ✅🧪 Lambda switched to `secure: true` on 465 |
| 3 | Per-app OIDC everywhere supported, incl. Vaultwarden SSO | ✅ Login server clients (`id/configuration.yml`) for OpenCloud (4), Forgejo, Vaultwarden, Bulwark, Stalwart web UI, Dashy |
| 4 | Bump all image pins | ✅ exact tags, all verified to exist (table in `ARCHITECTURE.md`) |
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

What's built instead is **per-app OIDC against the login server, with two
factors enforced once in the login server** (password + passkey on every login, §7):

| App | Login | What stays outside the IdP, and why |
| --- | --- | --- |
| OpenCloud | Login server (built-in IdP off), roles from its groups | Mobile apps hold offline (refresh) tokens. Break-glass: local admin in OpenCloud's own store, CLI/API only |
| Forgejo | Login server, no local password form | git over HTTPS: personal access tokens |
| Vaultwarden | Login server SSO, `SSO_ONLY` | **Master password**, by design: it decrypts the vault on your device, and the login server never sees it |
| Bulwark | Login server, password form hidden (`OAUTH_ONLY`) | — |
| Stalwart web UI (`/account`, `/admin`) | Login server (public PKCE client) | Break-glass admin (`STALWART_RECOVERY_ADMIN`), used by `bin/stalwart-apply` |
| Dashy | Login server (public PKCE client) | — |
| MCP gateway (AI apps) | Login server (public PKCE client per AI app), §6e | — |
| Stalwart IMAP 993 / submission 465 | Per-device **app passwords** (created in `/account`) | Apple Mail, iOS Mail and Thunderbird can't do OAuth against a third-party IdP |
| SES relay account | Password (machine) | Scoped so it can only deliver to local mailboxes (§3) |
| Collabora | No user login; admin console disabled | Only OpenCloud's WOPI endpoint may load files (`aliasgroup1`); WOPI proof key per install |

**Stalwart and the IdP (tested on 0.16.25 with Authelia, 2026-10-08;
switched to Keycloak 2026-10-19, to the login server 2026-11-24, same
issuer).** The login server is Stalwart's directory for
the whole server (`stalwart/plan-oidc.ndjson`); accounts are matched by
`preferred_username`. Per-domain directories are an Enterprise feature;
the community edition ignores them. What this means:
- Plain account passwords never work for mail. Native clients and the
  SES relay use **app passwords**, which Stalwart checks in its own store
  first. They keep working while the IdP is down (tested, including a
  Stalwart restart with it stopped). Inbound mail doesn't depend on
  the IdP.
- Web UI and Bulwark logins do. If Stalwart starts while the IdP is
  unreachable, those logins stay on Stalwart's own form until Stalwart
  is restarted once (`DEPLOY.md` step 2 notes).
- The break-glass admin (`STALWART_RECOVERY_ADMIN`) is independent of
  the IdP.

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
- **Databases: apps are not superusers** (2026-11-21). The Postgres image
  makes its first user (`POSTGRES_USER`) the bootstrap superuser, which
  Postgres won't demote. So that user is `dbadmin` (no password; the
  image trusts only connections from inside the container, so it is
  reachable only as `docker exec <container> psql -U dbadmin`), and each
  app has a normal user owning its database (`keycloak` and `listmonk`,
  both gone: listmonk moved to SQLite, Keycloak was removed 2026-11-24,
  so no SGNL app uses Postgres today). Why: listmonk's SQL segmentation (permission
  `subscribers:sql_query`) runs typed-in SQL; as a superuser that could
  call functions like `pg_read_file`. On SQLite (our fork, since 2026-11)
  that SQL runs in a read-only sandbox (allowed tables and functions only;
  no `users`, no second statement). Fresh databases get this from
  `postgres/initdb-app-user.sh`; the live ones were switched by renaming
  the old superuser to `dbadmin` and handing every object to a new app
  user with the same password hash. An app upgrade that wants an extension
  only a superuser may create will fail with a clear error: create it
  once as `dbadmin`.
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
| Signed (JWT) access tokens only with audience `stalwart-webui` (`acceptedAudiences` in `stalwart/plan-oidc.ndjson`), so a login token for another app (the MCP gateway's) is refused here. Opaque tokens (webmail, web UI) are checked through userinfo, without an audience check (§6e) | ✅ 2026-11-24 |

Operational gotchas found while testing (also in `DEPLOY.md`):
- A ban covers *everything* from that IP, admin API included, and
  survives restarts. The unban procedure (via the container's Docker
  network) is in `DEPLOY.md` step 2 🧪.
- App passwords don't touch the IdP, so an IdP outage doesn't make mail
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
| Login through the login server (password + passkey), `SSO_ONLY=true`. Linked by `<issuer>/<sub>` (`sso_users`): an issuer change needs that table updated, or logins are refused | ✅ 2026-10-19 |
| 1.37.4, obsolete `WEBSOCKET_ENABLED` removed | ✅ |
| Prefer the browser extension / mobile apps over the web vault for unlocking (they don't load JS from the server) | habit |
| Encrypted backups of `/data` | ✅ nightly (`BACKUPS.md`), restore drill 2026-10-11 |

## 5. AWS mail pipeline and machine credentials

| Credential | Lives in | Blast radius if leaked | Hardening |
| --- | --- | --- | --- |
| SES relay app password | Stalwart (`bin/stalwart-relay-app-password`) → Vaultwarden + Secrets Manager (Lambda) | Deliver mail into local mailboxes, nothing else | ✅🧪 scoped (§3); ~48 random chars |
| SES SMTP credentials (IAM user `ses-smtp-example-user.20260302-163030`, shared with Gmail "send mail as") | Vaultwarden (`bin/sgnl-secret`) → Stalwart datastore, login server env, Vaultwarden/Forgejo/OpenCloud env, backup alerts | Send from your domain via SES | ❌ separate SMTP user per app + IAM `ses:FromAddress` condition, so one leak is revocable alone |
| Cloudflare token | Vaultwarden (`bin/sgnl-secret`) → Stalwart datastore (no longer a container env var) | Rewrite any DNS record of all five account zones (example.com, …), from any IP | ⚠️ **accepted risk** (2026-10-08): all zones, no IP filter, no expiry. Tightening is optional, see `DNS.md` |
| Stalwart break-glass admin | Vaultwarden (`bin/sgnl-secret`) → container env | Full mail admin | ✅ ~48 random chars, auto-ban applies, independent of the login server |
| `example-sgnl-terraform` IAM key | Vaultwarden (`bin/sgnl-secret`) → env of the `./tf`/`./awscli` containers (no file anywhere) | Create/delete the SES/S3/Lambda/SQS resources | ✅ least-privilege; never on the server |
| OIDC client secrets (bulwark, vaultwarden, forgejo, grafana, listmonk) | Vaultwarden (`bin/sgnl-secret`, names still `keycloak-<app>-client-secret`) → the app's env / Forgejo DB; the login server gets only a PBKDF2 hash (`bin/sgnl-client-secret-hash`) | Impersonate that app towards the login server | ✅ per-client; public clients use PKCE and have no secret |
| `sgnl-agent` client secret (`id-agent-client-secret`) | Vaultwarden (`bin/sgnl-secret`) → `bin/sgnl-id` (HTTP Basic header, not argv); the login server gets only its hash | The whole admin API: create, change, disable and delete users, passwords, groups; read events and audit. **Not** settings or clients (those are `id/configuration.yml`) | ✅ client credentials only, two scopes, fixed audience |
| Login server keys (`id-storage-encryption-key`, `id-session-secret`, `id-reset-password-jwt-secret`, `id-oidc-hmac-secret`, `id-oidc-jwk-b64`, `id-saml-key-b64`) | Vaultwarden (`bin/sgnl-secret`) → container env | Storage key: read the encrypted parts of the database and its backups. Signing keys: forge tokens (OIDC) or Stripe logins (SAML) | ✅ random; storage key also in the break-glass export (needed to restore) |

The inbound pipeline's durability (S3-first, Lambda retries, DLQ, alarms)
is in `../aws/README.md`.

## 6. OpenCloud + Collabora (files, office editing)

Replaced the Nextcloud + ONLYOFFICE plan on 2026-10-11: one Go service
(no PHP app store, no Postgres/Redis) plus the editor.

| Control | Status |
| --- | --- |
| OpenCloud 7.2.x "production" line pinned (8.x are rolling releases) | ✅ 7.2.4 |
| Login only via the login server: built-in IdP excluded (`OC_EXCLUDE_RUN_SERVICES=idp`), basic auth off, demo users off. Accounts found by `preferred_username` | ✅🧪 |
| Roles from the login server's groups at every login (`opencloud/proxy.yaml`): `admins` → admin, `sgnl_users` → user, anyone else refused | ✅🧪 alice is admin |
| Web client without `offline_access` (no long-lived token in the browser) | ✅ |
| Public share links need a password, writable ones too | ✅ |
| CSP limited to our hosts (`opencloud/csp.yaml`, IdP = `id.sgnl`) | ✅ |
| Collabora: admin console off; only drive.sgnl may be a WOPI host / frame it | ✅ |
| Collabora **without** `SYS_ADMIN`, `seccomp=unconfined`, `apparmor=unconfined` (the official example uses all three). Cost: its audit shows "Slow Kit jail setup with copying, cannot bind-mount" (documents open in ~0.5 s); all security checks in that audit are green. Decided to keep, 2026-10-11 | ✅🧪 |
| Nightly backup of both volumes incl. extended attributes (`BACKUPS.md`) | ✅🧪 restore drill 2026-10-11 |
| Suspend: OpenCloud account disabled by `bin/sgnl-user-suspend`; the login server's disable ends refresh/offline tokens | ✅🧪 |
| App tokens (auth-app, for the suspend script and WebDAV tools) bypass the login server; blocked by the account disable | ✅🧪 |
| Server-side encryption | Not worth it (keys on the same box). Encrypted backups cover the real risk |
| Only tokens issued for OpenCloud (`PROXY_OIDC_AUDIENCES=opencloud`, `config/deploy.opencloud.yml`), so a login token for another app (the MCP gateway's) is refused here | ✅ 2026-11-24 |

## 6b. Forgejo

| Control | Status |
| --- | --- |
| Login only via the login server's OIDC (two factors), restricted to group `forgejo_users` (policy `sgnl_forgejo`); no sign-up, no local password form (`ENABLE_INTERNAL_SIGNIN=false`). Auth source still named `authelia` (accounts linked by source id + `sub`) | ✅ |
| Everything requires sign-in (`REQUIRE_SIGNIN_VIEW`); new repos private | ✅ |
| No SSH (port 22 is the host's sshd); HTTPS + personal access tokens | ✅ |
| Admin flag and team membership from the groups claim, re-applied at login (`--group-team-map-removal`) | ✅ |
| Tokens survive removal from groups: `bin/sgnl-user-suspend` sets prohibit login (blocks tokens too) | ✅🧪 2026-10-09 |
| Actions/CI off (a runner would execute code on the shared host) | ✅ |
| Nightly backup of repos + LFS + SQLite (`BACKUPS.md`) | ✅ |

## 6c. Suspending a person

`bin/sgnl-user-suspend` (`USERS.md`) blocks SSO (login server: account
disabled and **all its sessions and tokens ended at once**, incl.
refresh/offline tokens; nobody else is affected), mail incl. app
passwords (Stalwart permission), git tokens (Forgejo) and files
(OpenCloud account). Tested both ways on Keycloak (2026-10-19); the
login server step is `bin/sgnl-id disable`/`enable`.
Residual: the login server refuses a disabled person's tokens at once
(token, introspection and userinfo endpoints), but an app that checks a
signed access token itself (OpenCloud's clients get JWTs) may accept
one until it expires (≤ 5 min, `lifespans.access_token`; the MCP
login's 1 h tokens are refused by the apps, which check the audience).

## 6d. Dashy (home.sgnl)

| Control | Status |
| --- | --- |
| Login via the login server (public PKCE client, policy `sgnl_apps`: needs `sgnl_users`) | ✅🧪 2026-10-19 (on Keycloak) |
| Server refuses config and status checks without a valid id_token; anonymous gets only the login bootstrap | ✅🧪 |
| Config editing in the UI disabled; config read-only mount from git | ✅ |
| Group filtering is client-side only (tiles are hints; apps enforce access) | ℹ️ by design |
| Pinned 4.7.0 (4.8.x churned four patch releases in a week); Dashy's server still logs an update check at start | ✅ · ℹ️ |

## 6e. MCP gateway (AI apps)

`sgnl-mcp` at `mcp.sgnl` (`config/deploy.mcp.yml`; `ARCHITECTURE.md`,
"AI apps"): one MCP endpoint through which AI apps (Claude Code,
claude.ai, Codex) read and write a person's mail, calendar, contacts
and files. It acts as that person, so the main threats are a stolen
token and an AI app doing something the person didn't want, e.g.
because a mail it read told it to (prompt injection).

| Control | Status |
| --- | --- |
| Login only through the login server (password + passkey), one public PKCE client per AI app (`sgnl-mcp-claude-code`, `sgnl-mcp-claude-ai`, `sgnl-mcp-codex`), policy `sgnl_apps`. Login tokens carry audience `sgnl-mcp`: good at the gateway only | ✅ |
| Who: `SGNL_MCP_ALLOW_GROUPS=sgnl_users`, checked against the login server's current view on every login token (not only the token's claims), so disabling an account (`bin/sgnl-id disable`, `bin/sgnl-user-suspend`) cuts the AI apps off at once | ✅ |
| The login token is never forwarded. The gateway exchanges it (RFC 8693, its own confidential client `sgnl-mcp`, may only exchange) for a 5-minute token for one app: audience `stalwart-webui` for mail, `opencloud` for files. The exchange also applies that app's policy | ✅ |
| The apps refuse tokens not issued for them: OpenCloud (§6) and Stalwart's JWTs (§3). So a token leaked from one app, or a login token copied from an AI app, works nowhere else | ✅ 2026-11-24 |
| Login lifetimes (lifespan `mcp_login`): access token 1 h, refresh 14 days idle, 30 days at most, then password + passkey again. 1 h only because of the audience checks above | ✅ |
| **Prompt injection**: sending mail and saving into shared spaces need the person's yes in a confirmation dialog shown by the AI app (MCP elicitation: Accept/Decline, waits up to 10 min). Declined: nothing happens | ✅ |
| Meeting invitations (`event_invite`): only after a confirmation whose first line names every attendee and the time, and marks those OUTSIDE the company; the mail server sends the invitations. Changing or cancelling an invitation isn't offered. The tool fails if the server scheduled nothing | ✅🧪 2026-11-25 |
| Editing (`file_edit`): text files in the person's own space only; exact replacements or an append, only after a confirmation listing the changes. The confirmation is bound to the file's version: if it changed meanwhile, nothing is written ("ask again", tested live with a concurrent change). The write itself is conditional (If-Match). OpenCloud keeps the previous version | ✅🧪 2026-11-25 |
| Calendar changes: moving or cancelling a meeting the person organises notifies attendees only after a confirmation naming the change and who's told (OUTSIDE marked); private entries change without asking, deleting one asks. Meetings that are over and repeating meetings are refused | ✅🧪 2026-11-26 |
| Mail to Trash (`mail_trash`): at most 25, confirmation; restorable for the server's Trash retention (30 days) | ✅🧪 2026-11-26 |
| Out-of-office (`out_of_office_set`): switching on needs a confirmation naming the dates (or "NO end date") and that outside senders get it, text shown in full; switching off asks nothing | ✅🧪 2026-11-26 |
| Shared mailboxes: only those the mail server lists for the person; sending AS a shared address needs a confirmation whose first line names that address, and an identity the server grants | ✅🧪 2026-11-26 |
| Sharing (`file_share`): one file or folder from the person's own space, with one colleague (a person in the company), view by default or edit; only after a confirmation naming the item, the person and the access. No public links, no project spaces | ✅🧪 2026-11-25 |
| Only the AI apps listed in `SGNL_MCP_CONFIRM_CLIENTS` may do those actions: Claude Code, claude.ai and Codex; any other client is refused | ✅🧪 |
| **Residual risk, accepted 2026-11-25**: in its no-approval mode Codex answers the dialog itself (tested 2026-11-25), so the person isn't really asked. That mode is the person's own choice in their client, and SGNL can't tell it apart. Users are told not to use it with SGNL (`USERS.md`) | ⚠️ accepted |
| Bcc: allowed; verified that outside recipients' copies carry no Bcc header (2026-11-25) | ✅🧪 |
| **Admin tools** at `/admin/mcp` (read-only: users, groups, events, audit): person tokens must carry the admin URL as audience (a `/mcp` token is refused there); only the group `admins` (current view); the gateway calls the admin API with its own client `sgnl-mcp-admin`, scope `authelia.admin.read` only (write refused, tested). Every admin call is logged with the person | ✅ |
| No state on disk; secrets only in the container env (`SGNL_MCP_CLIENT_SECRET`, `SGNL_MCP_ADMIN_CLIENT_SECRET`); the login server holds just their hashes. The admin client is the gateway's only credential not tied to a person: read-only | ✅ |
| Monitoring: alert `McpGatewayDown` (container missing 5 min); `/health` is liveness only | ✅ |

Residual:
- **Opaque tokens have no audience check.** Webmail and Stalwart's web
  UI get opaque tokens, which Stalwart checks through the login
  server's userinfo endpoint, without an audience check (Stalwart's
  design). Only JWTs are bound to `stalwart-webui`.
- claude.ai keeps its users' tokens on Anthropic's servers; anyone who
  connects it trusts that.
- Reading is not confirmed: an AI app the person connected can read
  all their mail and files. A confirmation only guards sending, invitations,
  sharing and shared spaces.

## 7. Login server (identity)

The front door for everything in §1, so compromising it means
compromising everything. Our Authelia fork (tag pinned in
`docker/id/Dockerfile`), service `sgnl-id` at `id.sgnl`, since
2026-11-24 (Keycloak 2026-10-19 → 2026-11-24, Authelia + lldap before;
Keycloak and its Postgres are deleted). One container; all data in one
SQLite file (volume `sgnl_id_data`). The issuer URL, the passkeys' RP ID
and every app's settings stayed the same.

| Control | Status |
| --- | --- |
| Config as code: `id/configuration.yml` (settings, clients, policies, Stripe's SAML), deployed with `bin/sgnl-deploy id`. No admin UI: people and groups only through the admin API (`bin/sgnl-id`) or the CLI in the container | ✅ |
| Serves only the issuer path (path-only route); `/` of `id.sgnl` is a busybox placeholder that answers 404 (`bin/sgnl-root-placeholder`), so there is no second login page or issuer | ✅ |
| `forward_headers: false` on the route: kamal-proxy sets `X-Forwarded-For` itself, so a client can't pick the IP that rate limits and lockout see | ✅ |
| Secrets only in the container env (from `.kamal/secrets`), never in the config file; app client secrets reach it only as PBKDF2 hashes | ✅ |
| Every login: password (12+ characters) **and a passkey (WebAuthn, required)**; no TOTP, no SMS | ✅🧪 |
| Per-client access via authorization policies: `sgnl_apps` denies anyone without `sgnl_users`, `sgnl_forgejo` also needs `forgejo_users`; Stripe (SAML) also needs `sgnl_users` | ✅ |
| PKCE S256 required on every client except Forgejo and listmonk (confidential, PKCE optional); consent implicit except the Stalwart web UI and the OpenCloud desktop/mobile apps (asked once, kept 1 year); no self-registration, no password grant | ✅ |
| Brute force (`regulation`): 3 failures / 2 min → 30 min lockout, same error as a wrong password (no oracle) | ✅ |
| Sessions 8 h idle / 7 days max, no remember-me; access tokens 5 min (MCP logins 1 h, apps refuse them); refresh tokens 8 h idle, 30 days for the OpenCloud apps and webmail; offline tokens only for clients that ask (`offline_access`) | ✅ |
| Stripe sends signed SAML requests but publishes no certificate: their signatures are ignored for Stripe only (as Keycloak did); this also ignores `ForceAuthn` for Stripe. Read buffer 16 KB (Stripe's URL + cookies exceed 4 KB) | ℹ️ by design |
| Agent access through client `sgnl-agent` (client credentials, secret in Vaultwarden, hash on the server) with scopes `authelia.admin.read`/`.write` and the admin API as audience: it can manage people and groups, not settings or clients. The admin API is on the public issuer path; it refuses anything but such a token | ✅ |
| Invites without secrets: set-up link to a personal address, user only in `sgnl_invited` (no app) until `bin/sgnl-id finish-invite` | ✅ |
| Audit: login attempts (`bin/sgnl-id events`) and every admin change with its actor (`bin/sgnl-id audit`) | ✅ |
| Nightly paused copy of the volume into restic + restore drill that checks SQLite's integrity, compares users/groups/passkeys counts with live and starts a throwaway login server on it, which proves the storage key opens it (`bin/sgnl-backup-restore-test-id`) | ✅🧪 2026-11-24 |
| Monitoring: metrics on :9959, alert `LoginServerDown` (critical) | ✅ |

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
