# SGNL: architecture and design decisions

The technical side: what runs, why it's built this way, and what was
left out. For what SGNL is and why it exists, see `../README.md`.

> **Examples.** Docs use example values: `example.com`, apps at
> `<app>.sgnl.example.com`, server `203.0.113.10`, people `alice`/`bob`,
> a co-tenant app `cotenant`. An instance's real values are in
> `instance/sgnl.env`; its own docs (plans, TODO, original vision) in
> `instance/docs/`. See "Your instance" below.

Personal productivity stack for `example.com`, deployed with Kamal 2
onto the **same Hetzner VPS as `cotenant`** (`203.0.113.10`), sharing the
`kamal-proxy` instance that already terminates TLS for `app.example.com`.

Deploy steps: `docs/DEPLOY.md`. An instance keeps its own plans and TODO
in `instance/docs/` (references to `instance/docs/...` in this repo point
there).

## Scope: what's in Phase 1

| Service | Image | Subdomain | Role |
| --- | --- | --- | --- |
| Keycloak | `quay.io/keycloak/keycloak:26.7.5` + `postgres:18.7-alpine` | `id.sgnl.example.com` | Login (OIDC; SAML for SaaS), user directory, passkeys, account page; realm as code in `keycloak/realm.yaml` |
| Stalwart | `stalwartlabs/stalwart:v0.16.25` | `mail.sgnl.example.com` | IMAP (993), JMAP, submission (465) — mail routing itself (both directions) is AWS SES, see below |
| Bulwark | `ghcr.io/bulwarkmail/webmail:1.12.0` | `inbox.sgnl.example.com` | JMAP webmail client |
| Forgejo | `codeberg.org/forgejo/forgejo:15.0.9-rootless` | `git.sgnl.example.com` | Git forge: repos, issues, PRs, LFS (local disk). HTTPS only |
| Vaultwarden | `vaultwarden/server:1.37.4` | `vault.sgnl.example.com` | Password manager (Bitwarden-compatible) |
| Dashy | `lissy93/dashy:4.7.0` | `home.sgnl.example.com` | Landing page after login: tiles by group, status lights |
| OpenCloud | `opencloudeu/opencloud:7.2.4` | `drive.sgnl.example.com` | Files: storage, sync apps, sharing (replaced the Nextcloud plan, 2026-10-11) |
| listmonk | `listmonk/listmonk:v7.0.0-beta.2` + `postgres:18.7-alpine` | `listmonk.sgnl.example.com` | Campaigns and mailing lists: lists, double opt-in, templates; sends through SES (sending not set up yet) |
| Collabora Online (CODE) | `collabora/code:26.04.4.2.1` | `office.sgnl.example.com` | Live co-editing of Word/Excel/PowerPoint files inside OpenCloud |

Security model, per-service threats and hardening: `docs/SECURITY.md`.
People (onboarding, offboarding, break-glass recovery): `docs/USERS.md`.

Deliberately **not** built yet: PrivateBin, chat, Headscale/Tailscale mesh,
CrowdSec, Vector + AI triage, Uptime Kuma/Beszel, dedicated backup accessory,
Cloudflare Tunnel. Add these later, on their own `config/deploy.*.yml`
files, once Phase 1 is stable — see "Deferred / not built" below for why
each was cut.

## Why self-host at all — the cost math

The alternative to this whole repo is buying each piece as SaaS: mail,
drive, office, password manager, identity provider. Individually each is
"5 CHF here, 5 CHF there" — but they compound per-user, and stacking them
(plus things like GitHub seats) rounds up to roughly CHF50/user/month
fast, for a solo consultancy where that's a meaningful, recurring line
item rather than a rounding error a larger org wouldn't notice. Running
it on a VPS you already pay for turns that into near-zero marginal cost.

That's the premise behind everything below: self-hosting is worth the
operational trade-offs (you're the on-call, you own patching, you own
mailbox durability) specifically *because* the cost delta compounds this
much at this scale — not because self-hosting is free of downsides. Where
a piece's downside outweighed the savings (see mail, below), the design
changed; where it didn't, it stayed self-hosted.

## Two corrections vs. the original spec

**1. `kamal-proxy` cannot do forward-auth.** The original design assumed
the login service would sit in front of every subdomain the way Traefik/Caddy
forward-auth middleware does. `kamal-proxy` (the proxy Kamal 2 ships and
that `cotenant` already relies on) is a much simpler TLS/host router — it has
no pluggable auth middleware, and forward-auth would break every
non-browser client anyway (mail apps, Bitwarden apps, file sync apps).
So the identity provider (Authelia until 2026-10-19, now Keycloak) is a
**standalone OIDC provider + login portal**, and every app logs in
through it over OIDC: OpenCloud, Forgejo, Vaultwarden (SSO, 1.35+),
Bulwark, Dashy and Stalwart's web UI. All require a passkey as second
factor.
The exceptions are per-device app passwords for native mail/sync
clients, Vaultwarden's master password (end-to-end encryption, by
design), and machine credentials — see `docs/SECURITY.md` section 1.

**2. Stalwart's raw mail ports need their own TLS, independent of
`kamal-proxy`.** `kamal-proxy` only terminates HTTP(S) on 80/443. The
submission port (465, implicit TLS) and IMAPS (993) are published
straight to the host and need their own certificate via Stalwart's
built-in ACME (Cloudflare DNS-01, since port 80 is already owned by
`kamal-proxy`). Stalwart 0.16 no longer reads a config file for any of
this: `stalwart/config.json` only points at the datastore, and
everything else is applied from `stalwart/plan.ndjson` with
`bin/stalwart-apply`.

## Mail routing: AWS SES both directions

Neither inbound nor outbound mail touches this VPS's IP directly as an
MTA-to-MTA hop:

- **Outbound**: Stalwart relays through SES as a smart host on 587 (STARTTLS required; Hetzner blocks outgoing 465/25)
  (the `ses` MtaRoute in `stalwart/plan.ndjson`).
- **Inbound**: MX points at SES, not at this VPS. SES writes the raw
  message to S3 (durable, before anything else happens) and invokes a
  Lambda that relays it into Stalwart over authenticated SMTP submission,
  using a dedicated relay account. Full pipeline, Terraform, and the
  Lambda source are in `aws/` — see `aws/README.md`.

**Why**: it removes port 25 from the public listener list entirely (the
single most scanned/abused port there is), and it decouples "message
safely received" from "message delivered to your mailbox" — a VPS outage
no longer means a bounce to the sender, since the message is already
durably in S3 the instant SES accepts it, independent of whether Stalwart
is reachable at that moment. That gap — self-hosted inbound MX being a
single point of failure with no on-call but you — was the one risk in the
original self-hosted design that a bigger VPS or better DNS couldn't fix
on its own; this is what closes it, at near-zero added cost.

### Alternatives considered for mail, and why they lost

| Option | What it is | Why not chosen |
| --- | --- | --- |
| **Raw self-hosted MX** (original spec) | Stalwart listens on port 25 directly, is the real MX target | The one gap SES+Lambda closes: single point of failure, no durability buffer, brief outages could bounce mail to senders with zero alert to you |
| **Filtering gateway in front of Stalwart** (e.g. Cloudflare Email Routing/MailChannels as a spam-filtering relay) | A proxy absorbs the SMTP session, then relays to Stalwart | Extra vendor for what's mostly complexity without solving the durability problem — you're still on the hook for uptime, just with one more hop |
| **Managed mailbox** (Fastmail, Migadu, Proton) | Point MX at them entirely; Fastmail specifically is JMAP-native, so Bulwark could stay as the frontend, talking to their JMAP servers instead of self-hosted Stalwart | Directly works against the cost math above — CHF/user/month is exactly the recurring-cost problem this whole project exists to avoid. Would reconsider if the self-hosted maintenance burden turns out heavier than expected |
| **Hybrid by mailbox tier** (primary addresses managed, low-stakes aliases self-hosted) | Shrinks blast radius — worst case you lose a throwaway alias, not a client contract | Not pursued: running two mail systems is its own maintenance tax, and SES+Lambda closes the actual risk (durability) without needing the split |
| **ESP inbound-parse webhook** (Mailgun/Postmark/SendGrid POST parsed mail to a URL you host) | No mail server, self-hosted or otherwise, has a built-in receiver for this — Stalwart doesn't, and neither does anything else mainstream. It's always custom glue that reconstructs the message and re-injects it via SMTP or an import API | Would have meant swapping Stalwart for a Postfix-based stack (e.g. Mailcow) to get at the *only* well-trodden version of this glue (`sendmail`/`postdrop` piping — decades of prior art). Heavier footprint (7+ containers vs. Stalwart's one), and still weaker durability than SES's S3-write-before-anything-else guarantee — webhook delivery is retry-based, not "already permanently stored regardless of what happens downstream" |
| **Cloudflare Email Routing + Email Workers** | Cloudflare's inbound equivalent — MX to Cloudflare, a Worker processes the message | Worker-to-arbitrary-SMTP relay is possible via Cloudflare's newer TCP Sockets API but immature (no drop-in SMTP client library the way Lambda gets `nodemailer` for free); durability guarantee is less certain — Workers process more inline during the SMTP transaction than SES's S3-first model. Cloudflare Email Sending (beta in 2026, `smtp.mx.cloudflare.net:465`) does exist now, but caps messages at 5 MiB including attachments (SES: ~40 MB) and is aimed at transactional mail, so outbound would stay on SES anyway, meaning two mail vendors instead of one |

**Landed on SES + Lambda for both directions** because it has the
strongest durability guarantee of any option here, keeps everything on
one vendor already in use for outbound, costs cents/month at this volume,
and — since inbound processing already passes through a piece of code you
own (the Lambda) — gives a natural, already-there hook for the AI-ops
triage/classification work mentioned as a future direction, without a
separate log-tailing pipeline to build for it later.

## AWS account safety

Terraform in `aws/` never runs with root credentials. `aws/bootstrap/`
walks through the one-time handoff: lock down root (enable MFA, confirm
it holds no access keys), then use AWS CloudShell — authenticated by the
console session, so a root access key never has to exist — to create a
scoped IAM user (`example-sgnl-terraform`) with a least-privilege policy
(`aws/bootstrap/terraform-policy.json`) covering exactly the resources
`aws/*.tf` provisions, not `AdministratorAccess`. See
`aws/bootstrap/README.md` for the exact commands.

## Why a passthrough Dockerfile per service

Kamal's zero-downtime swap + `kamal-proxy` registration is tied to its
build → push → pull → boot lifecycle, which expects to own an
`image:`+SHA it built. Each `docker/<service>/Dockerfile` is a one-line
`FROM vendor/image:tag` so Kamal gets a SHA-tagged image to push through
that lifecycle, without forking the vendor image. Same registry as `cotenant`
(`localhost:5555`, SSH-tunneled) — you need the same tunnel running before
`kamal deploy`:

```bash
ssh -N -R 5555:localhost:5555 root@203.0.113.10
```

## Your instance

Everything specific to one company lives in `instance/`, its own private
git repo inside this folder (ignored by this repo): the values in
`instance/sgnl.env` (domain, server, Keycloak realm, name prefix,
backup bucket, ...), the landing page tiles, the mailboxes, optional
monitoring extras, and that company's own docs. Configs, deploy files
and scripts read it; nothing outside it names a real company.

```bash
git clone https://github.com/igorski89/sgnl && cd sgnl
cp -R instance.example instance && cd instance && git init   # then edit sgnl.env
```

`instance.example/` is a complete instance with example values: every
config renders with it (`SGNL_INSTANCE_DIR=instance.example
SGNL_SECRETS=csv:instance.example/dummy-secrets.csv bin/sgnl-config-dump
/tmp/out`). `bin/sgnl-split-check` lists anything outside `instance/`
that names your instance (run it before contributing back).

## Before you deploy anything

1. AWS credentials for the scoped IAM user (see "AWS account safety"
   above), then `cd aws && terraform apply` — see `aws/README.md`. This
   is now the source of several DNS values.
2. Read `docs/DNS.md` and create the records.
3. Read `docs/DEPLOY.md` in full — order matters (Keycloak's secrets and realm,
   the AWS pipeline, and Stalwart's ACME all need to exist before the
   services that depend on them boot cleanly).
4. Confirm the VPS actually has headroom, especially if a co-tenant app
   already runs on it — check `docker stats` / `free -h` before adding
   six more services, especially the office editor (Collabora), which
   is the heaviest item here.
5. Every vendor image in `docker/*/Dockerfile` is pinned to an exact
   tag that was verified to exist on 2026-10-07. Bump them deliberately
   (Stalwart and Bulwark move fast and have renamed images before).
   `bin/sgnl-image-updates` (monthly) lists newer versions of every
   pinned image: the newest in the current major (usually safe, often
   security fixes) and the newest major (read the notes first).

## Deferred / not built, and why

- **PrivateBin, chat** — low effort, no strong dependency on anything
  else; cut purely to keep this round reviewable, not because of risk.
- **Headscale/Tailscale full-tunnel exit node** — routes 100% of your
  laptop/mobile traffic through this VPS's IP; worth a deliberate yes/no
  given Hetzner's abuse-desk posture on exit-node traffic, not something
  to default into.
- **CrowdSec, Vector + Claude/Telegram AI triage** — real ongoing
  maintenance surface; also ships log content (auth logs, app logs) off
  this box to the Claude API and Telegram, which is a data-handling
  decision worth making explicitly, not bundling into infra plumbing.
- **Uptime Kuma/Beszel** — cheap to add later, sequenced after the rest is
  stable so there's something meaningful to monitor.
- **Backup accessory for this stack** — `cotenant` already has a
  Restic→R2 pattern to copy (see its `backup` accessory in
  `../cotenant/config/deploy.yml`); intentionally left out here until Phase 1
  is confirmed working, so we're not backing up config that's still
  changing.
- **Cloudflare Tunnel (`cloudflared`)** — considered, not built, scope
  still undecided. Mechanically simple (one Kamal accessory, one
  Cloudflare Tunnel with public-hostname routes for the web apps), but
  the actual security benefit depends on scope:
  - **`sgnl`-only**: DNS-level obscurity (the subdomains stop revealing
    the VPS IP via casual lookups) plus Cloudflare's WAF/DDoS absorption
    for traffic that goes through the tunnel. Does **not** give real
    firewall-level IP concealment — `kamal-proxy` is shared with `cotenant`,
    which stays directly internet-facing on 443 regardless, so an
    attacker who already has the IP can still reach any `sgnl` hostname
    directly via TLS SNI, bypassing Cloudflare entirely. Mail's raw
    SMTP/IMAP ports (465/993) are unaffected either way — Cloudflare
    can't tunnel those; SES already keeps port 25 out of the picture (see
    "Mail routing" above).
  - **`sgnl` + `cotenant`**: closes that gap for real — 80/443 can be
    firewalled shut entirely, since nothing needs inbound access once
    `cloudflared`'s outbound-only tunnel is the sole path in. Requires
    migrating `example.com`'s DNS to Cloudflare (not just
    delegating the `sgnl` subtree) and cutting `cotenant`'s live ingress over
    to the tunnel — a bigger, separate piece of work with its own
    sequencing (stand up and verify the tunnel path in parallel with the
    existing direct path, cut DNS over, tighten the firewall only after
    confirming traffic flows) and its own new risk: Cloudflare becomes a
    dependency in `cotenant`'s uptime chain, where today there isn't one.
  - Not scoped or sequenced yet — revisit as a deliberate piece of work
    when ready, not folded into a Phase 1 pass.

