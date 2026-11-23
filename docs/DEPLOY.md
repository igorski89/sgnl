# Deploy order — Phase 1

Go in this order (for a rebuild, or a new instance); later steps assume
earlier ones exist. `SECURITY.md` explains why things
are set up the way they are.

What has been tested locally (2026-10-07): the Stalwart 0.16.25
bootstrap + `bin/stalwart-apply` flow, the relay/submission policy, the
auto-ban and how to undo it, the Lambda handler against Stalwart on 465.
Everything below has since run against the real host (live since
2026-10-08). The login service was Authelia + lldap until 2026-10-19 and
is Keycloak since (migration log: `../instance/docs/PLAN-keycloak.md`); this file
describes the Keycloak setup.

## 0. Prerequisites

Secrets: every `example-sgnl-*` value is a Login item in Vaultwarden
(the organisation's collection `SGNL`, §5; before the organisation
exists, the personal folder "SGNL infra"), read through
`bin/sgnl-secret`. Unlock once a day,
`bin/sgnl-unlock` (once a day; `bin/sgnl-lock` at the end, or it locks
itself after 12 h), and run Kamal as
`bin/sgnl-env kamal ...` (one lookup instead of 19).

**Restarting without a deploy** (`kamal app boot`, `kamal app
reboot`) uses the image tagged with the current commit. Right after a
fresh clone no such image exists yet: pass the running one, e.g. `kamal
app boot -c config/deploy.<name>.yml --version <tag>` (tag from `docker
ps` on the server: the part after the image's `:`). A normal `kamal
deploy` builds the current tag, after which plain boots work again.

**Deploying an app: `bin/sgnl-deploy <app>`** (or `--all`: the apps
Kamal builds, least critical first; accessory-only ones like Dashy go by
name). It refuses uncommitted changes (the image tag must be a real
commit), stops Forgejo and Stalwart first (they can't run two containers
on the same data; ~10 s and ~30 s down, incoming mail waits in SES/S3),
deploys through `bin/sgnl-env`, then checks the app's public health URL.
`--stop-first <app>` stops any other app first too (Keycloak version
bumps: a database migration). If a stop-first deploy fails before the
new version started (build, push, network), it boots the version that ran
before; if the new version had started, it may have migrated the data, so
it leaves the app stopped and says what to check (an older version on a
newer schema is no rollback; then restore, BACKUPS.md). Accessory-only apps: the new image is pulled
before the reboot, so a wrong tag changes nothing. Full Kamal output:
`~/.cache/sgnl/deploy/`; its end is printed on failure, with secret
values and AWS key ids masked. Plain `kamal
deploy` still works for anything special.

- [ ] AWS: scoped IAM user, not root — `../aws/bootstrap/README.md`. Use
      the current `terraform-policy.json` (it includes the DLQ/SQS
      permissions).
- [ ] SES SMTP credentials in **eu-central-1** (SES console → SMTP
      settings → Create SMTP credentials) → Vaultwarden
      `example-sgnl-ses-smtp-username` / `example-sgnl-ses-smtp-password`.
- [x] SES production access in eu-central-1 (granted before this
      project; 50k/day, checked 2026-10-08).
- [ ] Cloudflare API token per `DNS.md` → Vaultwarden `example-sgnl-cloudflare-api-token`.
- [ ] Create each secret once: the commented `bin/sgnl-secret --set`
      lines in `.kamal/secrets` (incl. the Keycloak loops: Postgres,
      bootstrap admin, client secrets). The file itself holds names only
      and is tracked.
- [ ] `stalwart-cli` ≥ 2.0 on your PATH (Stalwart 1.x)
      (`brew install stalwartlabs/tap/stalwart-cli`, or the release
      tarball from github.com/stalwartlabs/cli; check the `.sha256`).
- [ ] Cloudflare Email Routing: all rules are being retired (`DNS.md`,
      first section). Leave them on until step 3; don't touch MX before.
- [ ] Packet filter: these docs assume no cloud firewall in front of the
      server, so ufw plus `host/harden.sh` are the only filter (rollback
      commands in the script header). With a cloud firewall, open
      22/80/443/465/993 there too.
- [ ] Disk: check free space on `/` (`df -h`); files and mail live on it.
- [ ] Config/secret files reach the server via `.kamal/hooks/pre-app-boot`
      (Kamal 2 has no `files:` for app containers): it uploads them to
      `/opt/sgnl/<service>/` before every boot, and the deploy files
      bind-mount them read-only. After editing one of those files, run
      `kamal app boot -c config/deploy.<service>.yml` to pick it up.
- [ ] Registry tunnel running (same as `cotenant`):
      `ssh -N -R 5555:localhost:5555 root@203.0.113.10`
- [ ] `cd aws/lambda/forwarder && npm install`, then `cd aws && ./tf init
      && ./tf apply` (see `../aws/README.md`). Confirm the SNS
      subscription email that arrives afterwards.
- [ ] DNS: the **A records** from `DNS.md`. SES verification, DKIM and
      MAIL FROM already exist (2026-10-08). Not MX/SPF/DMARC yet.

## 1. Keycloak (login + users)

```bash
kamal accessory boot postgres -c config/deploy.keycloak.yml   # sgnl-keycloak-postgres
kamal setup -c config/deploy.keycloak.yml                     # first start creates the schema (~30 s; deploy_timeout 120)
bin/sgnl-keycloak-apply                                       # realm example from keycloak/realm.yaml
```

- The realm (settings, login flows, groups, all app clients, the
  `sgnl-agent` service account) lives only in `keycloak/realm.yaml`.
  `bin/sgnl-keycloak-apply` fills its `{{VARS}}` from `.kamal/secrets`
  and applies it with keycloak-config-cli; it **deletes** clients,
  groups and flows that aren't in the file. Re-run after every edit.
- The master realm's `admin` (bootstrap password, Vaultwarden
  `example-sgnl-keycloak-bootstrap-admin-password`) is break-glass
  only: `bin/sgnl-kcadm`. Day-to-day people/groups: `bin/sgnl-kc` (the
  `sgnl-agent` service account).
- Health check is `/realms/master` (`/health` is on management port 9000).
- First person: `bin/sgnl-kc add-user alice "Alice Admin"`, groups
  (`bin/sgnl-kc add-to-group alice sgnl_users admins developers
  forgejo_users`), then `bin/sgnl-kc setup-email alice 48`: set a password
  and register a passkey (required at every login, no TOTP). Everyone
  after that: `bin/sgnl-add-user` (`USERS.md`).
- In the backup via `pg_dump` (`BACKUPS.md`); drill:
  `bin/sgnl-backup-restore-test-keycloak`.

## 2. Stalwart

```bash
kamal setup -c config/deploy.stalwart.yml
bin/stalwart-apply --dry-run          # renders + validates, sends nothing
bin/stalwart-apply                    # listeners, ACME, SES route, accounts, hardening
kamal app logs -c config/deploy.stalwart.yml | grep -iE 'acme|listen-start'
```

Expect listeners on 465, 993 and 8080 only, then `ACME order started` →
a certificate for `mail.sgnl.example.com`. Issuance runs as a
background task after the apply; if nothing shows up within a few
minutes, check `stalwart-cli query Task` for a failed `AcmeRenewal`
(wrong token scope is the usual cause). The SES Lambda verifies this
certificate, so nothing relays until it exists.

Add your mailbox(es) to the Accounts section of `stalwart/plan.ndjson`
(the name must match the Keycloak username) and re-run
`bin/stalwart-apply`. The plan is idempotent: re-run it after every edit.

Then wire Stalwart to Keycloak (once Keycloak is healthy):

```bash
bin/stalwart-apply stalwart/plan-oidc.ndjson
ssh root@203.0.113.10 'docker restart $(docker ps -qf label=service=sgnl-stalwart)'
bin/stalwart-relay-app-password    # relay app password -> Vaultwarden + Secrets Manager
```

Restart with `docker restart`, never `kamal app boot`/`deploy` while it
runs. Kamal starts the new container before stopping the old one, and
both want host ports 465/993 and the same RocksDB volume. For an
upgrade: `kamal app stop`, then `kamal deploy`.

Log in at `https://mail.sgnl.example.com/account` → it should
send you through Keycloak. Create one app password per device there
for 465/993 (iOS/macOS Mail, Thunderbird). With Keycloak as the
directory, plain passwords never work for mail; app passwords do, even
while Keycloak is down (see `stalwart/plan-oidc.ndjson`). The directory
object keeps its description `authelia` (what the plan matches on and
`Authentication.directoryId` points to); only its `issuerUrl` changed.

Notes:
- If Stalwart starts while Keycloak is unreachable (e.g. host reboot
  with Keycloak coming up later), it gives up on OIDC after ~30 s. Mail
  and app passwords keep working, but web/Bulwark logins fall back to
  Stalwart's own login form until Stalwart is restarted once. To check:
  `curl -s https://mail.sgnl.example.com/api/discover/x@example.com`
  should show `"issuer":"https://id.sgnl.example.com/realms/example"`.
- **If you get auto-banned** (10 failed logins/hour → 24h, and the ban
  covers the admin API too; it also happens when webmail keeps retrying
  with a token from a previous IdP, as on 2026-10-19 — tell people to
  close old webmail tabs after an IdP change), undo it from an unbanned address, e.g.
  through the container's Docker network:
  ```bash
  IP=$(ssh root@203.0.113.10 "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \$(docker ps -qf label=service=sgnl-stalwart)")
  ssh -N -L 18080:$IP:8080 root@203.0.113.10 &
  export STALWART_URL=http://localhost:18080 STALWART_USER=admin STALWART_PASSWORD=...  # part after "admin:" in example-sgnl-stalwart-recovery-admin
  stalwart-cli query BlockedIp
  stalwart-cli delete BlockedIp --ids <id>
  stalwart-cli create Action --json '{"@type":"ReloadBlockedIps"}'
  ```

## 3. AWS side and the MX switch (done 2026-10-08)

1. Relay app password into Secrets Manager: `bin/stalwart-relay-app-password`
   (step 2) does it.
2. Outbound test: from Bulwark or a native client, send to an external
   address. Check the headers for SPF/DKIM/DMARC `pass` via amazonses.
3. **MX switch**: first disable Cloudflare Email Routing, which unlocks
   its MX/SPF records (`DNS.md`). Then replace the Cloudflare MX records with
   `./tf output mx_target`, the SPF record with
   `v=spf1 include:amazonses.com ~all`, and DMARC with the `p=none`
   value from `DNS.md`.
4. Inbound test from an external address. Look for `X-SES-*-Verdict`
   headers on the delivered message, and watch
   `./awscli logs tail /aws/lambda/example-sgnl-ses-forwarder --follow --region eu-central-1`.

## 4. Bulwark

```bash
kamal accessory boot web -c config/deploy.bulwark.yml   # an accessory: vendor image, no build
```

`https://inbox.sgnl.example.com` → "Sign in" → Keycloak → inbox.
Requires `stalwart/plan-oidc.ndjson` from step 2.

Bulwark hands Keycloak's access token to Stalwart's JMAP, and Stalwart
accepts it through its OIDC directory (same issuer for both). If the
Keycloak login succeeds but Bulwark then shows an auth error, look in
`kamal app logs -c config/deploy.stalwart.yml` for the rejected token.
Interim fallback: set `OAUTH_ONLY: "false"` in `deploy.bulwark.yml`,
redeploy, and log in with an app password from `/account`.

## 5. Vaultwarden

Accounts come from the first SSO login (`SSO_ONLY`, `SSO_SIGNUPS_ALLOWED`
in `config/deploy.vaultwarden.yml`); nobody signs up with a password.

```bash
kamal setup -c config/deploy.vaultwarden.yml
# https://vault.sgnl.example.com -> "Use single sign-on" -> Keycloak,
# then set your master password (Keycloak never sees it)
```

**The company organisation (once, by the first admin).** Personal
passwords stay in each person's own vault; company passwords live in one
organisation, sorted into collections that are shared with groups.
Creating the organisation can't be scripted (Bitwarden makes its key in
the owner's browser), everything after that is config:

1. Web vault → "New organisation", named exactly `SGNL_ORG_NAME` from
   `instance/sgnl.env`.
2. Admin Console → Settings → Organisation info → "View API key", then:
   ```bash
   bin/sgnl-secret --set vaultwarden-org-client-id       # hidden prompt: paste, Enter
   bin/sgnl-secret --set vaultwarden-org-client-secret
   ```
3. Apply `instance/vaultwarden/org.yaml` (from `instance.example/`: groups
   `everyone` = Keycloak `sgnl_users` and `admins` = `admins`; collections
   `<company name>` for everyone to view, `SGNL` for admins):
   ```bash
   bin/sgnl-vault-sync --dry-run && bin/sgnl-vault-sync
   ```
   From then on `bin/sgnl-kc` re-runs it after people changes; each new
   person accepts the invite email once. Details: `USERS.md` "Shared
   passwords".
4. New infrastructure secrets now go into the `SGNL` collection
   (`bin/sgnl-secret --set`); move any created before into it
   ("Assign to collections").

Accounts are linked by `"<issuer>/<sub>"` (table `sso_users`): changing
`SSO_AUTHORITY` needs the same change in that table (done for the
Keycloak switch, `../instance/docs/PLAN-keycloak.md`).

## 5a. listmonk (campaigns)

```bash
bin/sgnl-deploy listmonk                    # our fork's image (SQLite); first start creates the
                                            # schema and the super admin (SGNL_ADMIN_USER, break-glass)
bin/sgnl-keycloak-apply                     # client "listmonk"
bin/sgnl-listmonk-setup                     # root URL, Keycloak login, admin's email, SES, bounces
bin/sgnl-backup-install                     # nightly copy of the database + uploads volumes
```

listmonk runs our fork, github.com/igorski89/listmonk: upstream listmonk
plus an SQLite backend, because upstream needs Postgres and stopped taking
code contributions (`../instance/docs/PLAN-listmonk-sqlite.md`). Its CI
publishes each release as `ghcr.io/igorski89/listmonk:<tag>` (amd64 +
arm64) after an upgrade test from the previous release;
`docker/listmonk/Dockerfile` is a one-line `FROM` of a pinned tag (never
`latest`). To upgrade: bump the tag there, take a backup, then
`bin/sgnl-deploy listmonk` (stop-first: a few seconds down). The database is one SQLite file in the volume `sgnl_listmonk_data`.

DNS: `listmonk.sgnl` (DNS.md). Login: straight to Keycloak (our fork's
`auto_login`, set by bin/sgnl-listmonk-setup), matched by email to an
existing listmonk account (no auto-created accounts: add people in
listmonk → Users with their `<user>@<domain>` email). The break-glass
password form is at `/admin/login?password`; after a logout the form
shows for an hour instead of logging straight back in.

**Sending** (`aws/campaigns.tf`, then `bin/sgnl-listmonk-setup`): SES
SMTP with the header `X-SES-CONFIGURATION-SET: <prefix>-campaigns`; that
configuration set publishes bounces and complaints to the SNS topic
`<prefix>-campaigns-events`, whose HTTPS subscription
(`/webhooks/service/ses`) listmonk confirms itself. Hard bounces and
complaints blocklist the address (complaints need listmonk 7; 6.x
rejected configuration-set complaint events). Order on a fresh instance: `./tf apply
-target=aws_sesv2_configuration_set_event_destination.campaigns_bounces`,
then `bin/sgnl-listmonk-setup` (turns on the SES webhook), then `./tf
apply` (the subscription). Only campaign mail is affected; the domain
identity and all other company mail are not. Test with SES's simulator
addresses (`bounce@`, `complaint@simulator.amazonses.com`) as
subscribers of a test list. The webhook only accepts our topic
(`bounce.ses.topic_arns`, from the Terraform output). Use double opt-in
for public lists.

## 5b. Forgejo

```bash
kamal setup -c config/deploy.forgejo.yml
bin/sgnl-forgejo-setup auth    # login source "authelia" (the name is kept; it points at Keycloak)
docker restart <forgejo container>   # on the host; picks up the source
bin/sgnl-forgejo-setup org     # after alice's first login
```

Restart Forgejo with `docker restart`, never `kamal app boot`: two
Forgejo containers can't share the volume (queue lock), so the boot
fails its health check. New image or env: `kamal app stop`, then
`kamal deploy` (`config/deploy.forgejo.yml`).

## 6. OpenCloud + Collabora

```bash
# the four opencloud* clients are in keycloak/realm.yaml (bin/sgnl-keycloak-apply)
bin/sgnl-deploy collabora    # creates the WOPI proof key once, boots the accessory
kamal deploy -c config/deploy.opencloud.yml    # hook uploads opencloud/csp.yaml + proxy.yaml
bin/sgnl-backup-install --run
```

Gotchas found on 2026-10-11:
- The web UI takes its OIDC client from `WEB_OIDC_CLIENT_ID`/`WEB_OIDC_SCOPE`
  (`/config.json`); `WEBFINGER_*` only reaches the apps. Without both,
  web login asks the IdP for an unknown client `web`.
- `opencloud/csp.yaml` must allow the IdP (`id.sgnl`) in connect-src,
  frame-src and script-src.
- Startup logs a few errors (proxy routes, posixfs xattr check) before the
  internal services are up; harmless if `/status.php` answers.

Checks: login at `https://drive.sgnl.example.com` lands in Personal
files; an admin sees "Admin settings"; a `.docx` opens in Collabora.

## 6b. Monitoring (Grafana + VictoriaMetrics)

Whole host, both tenants. Design and conventions: `instance/docs/PLAN-monitoring.md`.

```bash
# DNS: A monitor.sgnl -> VPS (docs/DNS.md); client grafana in keycloak/realm.yaml
bin/sgnl-keycloak-apply
bin/stalwart-apply                                       # alerts@ group
kamal accessory boot all -c config/deploy.monitoring.yml # VM, vmagent, vmalert, Alertmanager, exporters
kamal deploy -c config/deploy.monitoring.yml             # Grafana (provisioning baked into the image)
bin/sgnl-grafana-setup                                   # org "Logs" (admins): datasources + dashboard
```

Logs (phase 2, `instance/docs/PLAN-monitoring.md` section 11): accessories
`victorialogs`, `vector`, `vmalert-logs`. Before changing
`monitoring/vector/vector.yaml`, run its tests:
`bin/sgnl-vector-test` (renders `vector.yaml.erb`, runs the generic tests and the instance's own).

Changing `monitoring/*` (scrape config, SGNL rules, Alertmanager):
`kamal accessory reboot <name> -c config/deploy.monitoring.yml` uploads
the file and restarts. Dashboards and datasources (`docker/grafana/`):
`kamal deploy`. cotenant's rules and dashboards live in
`/root/cotenant-monitoring/{rules,dashboards}` on the host, written from
cotenant's session; vmalert and Grafana re-read them by themselves.

A container is scraped when its deploy.yml has the label
`metrics.port: "<port>"` (optional `metrics.path`, `metrics.job`).

Checks: `https://monitor.sgnl.example.com` logs in via Keycloak
(admins = Grafana Admin, others Viewer); dashboard "Host & containers"
has data; every `up` is 1. Admins also see org "Logs" (org switcher):
dashboard "Logs" has lines; non-admins don't see that org. Break-glass admin:
`/login?disableAutoLogin=true`, user `admin`, Vaultwarden
`example-sgnl-grafana-admin-password`.

## 7. Sanity pass

- [ ] All subdomains show valid Let's Encrypt certs; `mail.sgnl`'s
      465/993 too: `openssl s_client -connect mail.sgnl.example.com:993`.
- [ ] From outside: only 22/80/443/465/993 answer (`nmap -Pn 203.0.113.10`).
- [ ] `docker stats`: nothing OOM-killed, nothing swapping. `cotenant`
      still healthy.
- [ ] Deliberately break the forwarder once (wrong relay app password in
      Secrets Manager), send a test mail, confirm the alarm fires, the
      message stays in S3 and lands in the DLQ, then fix and replay it
      (`../aws/README.md`, "Replaying failed messages").
- [ ] After ~2 weeks of clean DMARC reports: `_dmarc` → `p=quarantine`.
