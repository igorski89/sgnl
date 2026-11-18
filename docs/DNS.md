# DNS records — Phase 1

`example.com` is on **Cloudflare** (nameservers
`ram`/`raphaela.ns.cloudflare.com`, checked 2026-10-07).

`<VPS_IP>` = `203.0.113.10` (same host as `app.example.com`).

## MX switch: done 2026-10-08

Cloudflare Email Routing was disabled in the dashboard. That **deleted**
its MX and SPF records rather than unlocking them, so there was a
minute with no MX. The API token has no Email Routing permission. Then
the records below were set via the API.

Verified on the same day:
- outbound: Stalwart → SES 587 → Gmail; DKIM, SPF and DMARC pass;
- inbound: external → SES MX → S3 → Lambda → Stalwart inbox; all
  `X-SES-*-Verdict: PASS`.

## Subdomains (one A record each)

All of these must be **DNS only (grey cloud)**, not proxied:
kamal-proxy gets its own Let's Encrypt certificates, Stalwart's raw ports
(465/993) can't go through Cloudflare's HTTP proxy, and the SES Lambda
connects to `mail.sgnl` directly.

| Type | Host | Value | Notes |
| --- | --- | --- | --- |
| A | `mail.sgnl` | `<VPS_IP>` | Stalwart: JMAP/web UI on 443 via kamal-proxy, plus submission (465) and IMAPS (993) direct. Not the MX target |
| A | `inbox.sgnl` | `<VPS_IP>` | Bulwark webmail |
| A | `vault.sgnl` | `<VPS_IP>` | Vaultwarden |
| A | `git.sgnl` | `<VPS_IP>` | Forgejo (created 2026-10-09, DNS only) |
| A | `home.sgnl` | `<VPS_IP>` | Dashy landing page (created 2026-10-15) |
| A | `drive.sgnl` | `<VPS_IP>` | OpenCloud (files) |
| A | `office.sgnl` | `<VPS_IP>` | Collabora Online (office editor for OpenCloud) |
| A | `id.sgnl` | `<VPS_IP>` | Keycloak: login for every app (created 2026-10-18). `auth.sgnl` (Authelia) was deleted 2026-10-19 |
| A | `monitor.sgnl` | `<VPS_IP>` | Grafana (monitoring, `config/deploy.monitoring.yml`; created 2026-10-24, DNS only) |
| A | `listmonk.sgnl` | `<VPS_IP>` | listmonk (campaigns, `config/deploy.listmonk.yml`; created 2026-11-18 via the Cloudflare API, DNS only) |

Stalwart also writes, by itself, `_acme-challenge.mail.sgnl` (temporary,
during certificate issuance) and `_smtp._tls.sgnl` (TLS-RPT) using the
Cloudflare token. It never touches the apex records below (see
`stalwart/plan.ndjson`, "TLS").

## Apex-level records (mail identity)

Inbound and outbound both go through AWS SES in eu-central-1.
`mx_target` is a Terraform output from `../aws/` (`./tf output`).

| Type | Host | Value | Purpose |
| --- | --- | --- | --- |
| MX | `@` | `./tf output mx_target` (priority `10`), an `inbound-smtp.<region>.amazonaws.com` hostname | Inbound mail to SES, which relays into Stalwart via Lambda. **Replaces** the three Cloudflare MX records |
| TXT | `@` | `v=spf1 include:amazonses.com ~all` | Authorizes SES as the outbound sender. **Replaces** the Cloudflare SPF record (only one SPF record is allowed) |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com` | `p=quarantine` since 2026-10-09 (forgeries go to spam). Started at `p=none` on 2026-10-08; tightened early after checking that every sender is SES with DKIM: Stalwart, Authelia (auth@), backups (backup@), Gmail send-as. cotenant sends no mail. Undo: back to `p=none` |
| CNAME ×3 | `<token>._domainkey` | `<token>.dkim.amazonses.com` | Easy DKIM, also verifies the domain. **Already exists**, don't touch |
| MX | `mail` | `10 feedback-smtp.eu-central-1.amazonses.com` | Custom MAIL FROM (bounces/complaints). **Already exists**, don't touch |
| TXT | `mail` | `v=spf1 include:amazonses.com ~all` | SPF for the MAIL FROM domain; this is what DMARC's SPF alignment checks. **Already exists**, don't touch |

The DKIM and MAIL FROM records predate this project (the SES identity
also backs Gmail's "send mail as"). `mail.example.com` is the SES
MAIL FROM domain and has nothing to do with `mail.sgnl.example.com`
(Stalwart).

`mail.sgnl` is not the MX target. Its A record only serves Stalwart's
own HTTPS/submission/IMAPS endpoints.

## Cloudflare API token (Stalwart's certificate)

Stalwart needs its own certificate for 465/993, which bypass kamal-proxy.
Port 80 is kamal-proxy's, so it uses DNS-01. The token as created
(2026-10-08):

- Token name: `example-sgnl-stalwart-dns01` (an Account API token)
- Permissions: `Zone` → `DNS` → `Edit`
- Zone resources: **all zones in the Example Co account** (five
  domains: getmimiai.com, cotenant-insight.com, mimiinsight.com,
  example.com, mimiinsights.com)
- Client IP Address Filtering: **none**
- No expiry

Both broad settings were a deliberate choice (accepted risk, see
`SECURITY.md` §5). The tighter version, if wanted later: `Specific zone`
→ `example.com`, and IP filter `203.0.113.10` +
`2a01:4f8:c0c:da2f::/64`. Include the IPv6 range: the host prefers IPv6
for outgoing connections, and with the IPv4 address alone calls made
from the host fail with error 9109.

Store it as `example-sgnl-cloudflare-api-token` in Vaultwarden (`bin/sgnl-secret`) (see
`.kamal/secrets`). `bin/stalwart-apply` sends it into Stalwart's
datastore; it isn't deployed as a container env var.

Whoever holds this token can rewrite any DNS record of all five
domains, from anywhere. That includes `app.` (`cotenant`), the MX and SPF
records, and the website records. It lives in Vaultwarden (`bin/sgnl-secret`) and inside
Stalwart's datastore. If either leaks, roll the token in Cloudflare
(Account API tokens → Roll) and re-run `bin/stalwart-apply`.

## SPF alignment fix (2026-10-09)

SES has an extra *email address* identity `alice@example.com` (from
the Gmail send-as setup) next to the domain identity. SES uses the most
specific identity, and that one had no custom MAIL FROM, so mail from
alice@ went out with an `amazonses.com` Return-Path: SPF passed, but not
aligned (DMARC still passed via DKIM). Fixed by setting
`mail.example.com` as MAIL FROM on that identity too
(`sesv2 put-email-identity-mail-from-attributes`); verified: Return-Path
`@mail.example.com`, SPF/DKIM/DMARC PASS. Any new email-address
identity in SES needs the same, or just don't create them: the domain
identity covers every address.

