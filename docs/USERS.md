# People: accounts, onboarding, recovery

> **Every `bin/` command needs the instance:** `--instance <name>` as the
> first argument (e.g. `bin/sgnl-id --instance <name> show anna`). No tool
> falls back to one, and an environment variable doesn't choose one; the
> names are the `SGNL_ORG_SLUG` of `instance/` and `instance.*/`. Kamal runs
> through `bin/sgnl-env --instance <name> kamal ...` or `bin/sgnl-deploy`.
> Dev environments: `bin/sgnl-dev ...` (always `dev`).

One identity per person: **`alice@example.com` works everywhere.**

| Where | You type |
|---|---|
| SGNL login page (`id.sgnl.example.com`, "Secrétariat Général") | `alice@example.com` (or just `alice`) + password, then the **passkey** |
| Stalwart web UI, **first screen** ("Enter your account name") | `alice@example.com` (the full address; a bare `alice` lands on Stalwart's own password form, which never works) |
| Webmail (Bulwark), vault, files, git, start page | nothing: "Sign in" sends you to the SGNL login page |
| Mail apps (IMAP 993 / SMTP 465) | `alice@example.com` + an **app password** |
| Own account (password, passkeys) | `https://id.sgnl.example.com/realms/example/settings` (start page tile) |
| AI apps (Claude, Codex) | nothing: they open the SGNL login page (below, "Using SGNL from AI apps") |

Since 2026-11-24 people live in the **login server**, our Authelia fork
(service `sgnl-id`, `config/deploy.id.yml`; Keycloak from 2026-10-19,
Authelia + lldap before that). Settings, login rules and app clients are
code: `id/configuration.yml`, applied with `bin/sgnl-deploy id`. People,
groups and memberships are data (one SQLite file, volume
`sgnl_id_data`), managed with `bin/sgnl-id`.

| Group | Meaning |
|---|---|
| `sgnl_users` | May use the apps (authorization policy `sgnl_apps`; Stripe's SAML too). Without it every app refuses the login; the settings page still works |
| `forgejo_users` | May also log in to Forgejo (policy `sgnl_forgejo`, needs both groups) |
| `admins` | Our admin group (passed to apps in the `groups` claim: Forgejo site admin, OpenCloud admin, Dashy admin section) |
| `developers` | Team Developers in Forgejo's org `example` |
| `sgnl_invited` | Invited, not finished yet: settings page only (see Onboarding) |

Each user has one `email`. It's the address apps see and where the login
server sends set-up and reset links. Extra addresses (postmaster@,
contact@) are Stalwart aliases/groups, not login accounts.

Login rules (`id/configuration.yml`):
- **Password + passkey, always.** Passwords: 12+ characters
  (`password_policy`). The second factor is a passkey (WebAuthn),
  required; no TOTP, no SMS. Login by username or email.
- **Brute force** (`regulation`): 3 failures within 2 min → 30 min
  lockout. The login page shows the same error as for a wrong password
  while locked. Lift it early: break-glass below.
- **Sessions** (`session`): 8 h idle, 7 days max, no remember-me. Access
  tokens live 5 min (`lifespans.access_token`; the MCP logins 1 h). `disable`/`logout` make the login server refuse a person's
  sessions and tokens at once; only an app that checks a signed access
  token itself (OpenCloud's clients get JWTs) may accept one until it
  expires.
- No self-registration. Consent is implicit, except the Stalwart web UI
  and the OpenCloud desktop/mobile apps, which ask once (kept 1 year).
  "Reset password?" on the login page emails a reset link to the user's
  own (SGNL) address.

Accounts were imported from Keycloak on 2026-11-24 with their Keycloak
id as `sub`, passwords and passkeys, so apps that link by `sub`
(Forgejo, Vaultwarden) found the same accounts and nobody had to set up
again. Forgejo's login source is still named `authelia` (from before
Keycloak), hence its "Sign in with authelia" button.

### Managing people

`bin/sgnl-id` does it from the laptop, through the login server's admin
API as the agent's client `sgnl-agent` (client credentials; scopes
`authelia.admin.read` and `.write`, i.e. the whole admin API, not the
settings). Run it without arguments for usage:

| Command | Does |
|---|---|
| `list`, `show <user>` | people, groups, credentials, sessions |
| `add-user <user> "<First Last>" [email]` | plain user, no password (then `setup-email`) |
| `add-to-group` / `remove-from-group <user> <group>...` | memberships (the group must exist) |
| `setup-email <user> [hours]` | email: set own password + register a passkey (default 24 h) |
| `invite <user> "<First Last>" <personal-email> [hours]` | onboarding, below (default 72 h) |
| `finish-invite <user> <group>...` | ends onboarding, below |
| `disable` / `enable <user>` | disable also ends all their sessions and tokens |
| `logout <user>` | ends all their sessions and tokens |
| `events [<user>] [max]` | recent login attempts |
| `audit [<user>] [max]` | recent admin changes (who changed what) |

Changes apply at once, no redeploy. There is no admin console and no
master admin. What `bin/sgnl-id` can't do (create a group, lift a
lockout, remove a passkey or password, delete a user) is done with the
server's own CLI inside its container, over root SSH (break-glass below).

## Onboarding

### Admin side (~5 min)

```bash
bin/sgnl-add-user anna "Anna Example" anna@personal.example
```

It adds the mailbox `anna@example.com` to `instance/stalwart/mailboxes.ndjson`
and applies the plan (mail to her arrives from day one), then runs
`bin/sgnl-id invite`: login server user `anna` with her **personal** address
as email, group `sgnl_invited` only, and a set-up email (valid 72 h) to
that address. Nothing secret is created or handed over.

Why the personal address and `sgnl_invited`: she can't read
anna@example.com before she can log in, and while her email is the
personal one no app may create her account from it (Forgejo would name
her after it). So she only reaches her settings page until:

```bash
bin/sgnl-id finish-invite anna developers forgejo_users   # sgnl_users is always added
```

It refuses until she has both a password and a passkey; then it sets
her email to anna@example.com and swaps `sgnl_invited` for the
groups. Commit `stalwart/plan.ndjson`. Tell her on another channel
(WhatsApp, in person) to expect the email and to say when she's done.

`finish-invite` also adds her to the company's password vault
(`bin/sgnl-vault-sync`, see "Shared passwords"): Vaultwarden emails her
an invitation to anna@example.com, separate from the login one and
valid for 5 days. Tell her about it explicitly (it's the step people
miss). For a temporary test account, skip the vault with
`SGNL_NO_VAULT_SYNC=1 bin/sgnl-id finish-invite …`; a permanent one goes under
`exclude:` in `vaultwarden/org.yaml`. Once she has accepted it (step 7 of her side), run the sync once
more, which confirms her; until then she sees none of the company's
passwords:

```bash
bin/sgnl-vault-sync
```

It also gives her a newsletter (listmonk) account (`bin/sgnl-listmonk-sync`;
everyone in `sgnl_users`, role "Super Admin" for now), which the AI
gateway's newsletter tools act as. Disabling her login, or taking her out
of `sgnl_users`, disables it (never deleted); `bin/sgnl-id` runs it on
every group change, disable and enable. Skip with `SGNL_NO_LISTMONK_SYNC=1`.

**SaaS with SSO (Stripe):** if she needs one, invite her there with her
company address (anna@example.com) and pick her role in that service:
Stripe → Settings → Team and security → Team. Roles stay in Stripe;
she then signs in with "Sign in with SSO" (the login server over SAML,
service provider `https://dashboard.stripe.com/saml/metadata` in
`id/configuration.yml`), or from the landing page tile. Stripe's mobile app has no SSO.

### Personal guide (PDF)

Each person gets a personalized guide: no secrets in it, written so it can
also be handed to their own AI assistant (it ends with a "For your AI
assistant" section: facts, known quirks, rules, when to escalate). Bob's
(written 2026-10-19 for Keycloak; its login screens and emails changed
on 2026-11-24) is the model:
`onboarding/bob-onboarding.md` (gitignored). Copy it, replace
name/rights/personal address, bring its steps in line with "The
person's side" below (the vault invitation, step 7, is the one people
miss), then render:

```bash
cd onboarding
pandoc <user>-onboarding.md --standalone --css ../docs/templates/onboarding-guide.css --metadata lang=en -o <user>.html
weasyprint <user>.html <user>-onboarding.pdf && rm <user>.html
```
(pandoc + WeasyPrint are installed on alice's Mac; recipe from cotenant-app-01.)

### The person's side (~30 min)

1. In the personal mailbox: the set-up email from `auth@example.com`
   (check spam). The link works once, within 72 h; it is used up when
   the page opens, so an abandoned set-up needs a new `setup-email`.
2. Set a password (12+ characters), register a **passkey**. Apps refuse
   them until `finish-invite`. They tell the admin "done".
3. After `finish-invite`: a **second passkey** on another device
   (settings page → Two-Factor Authentication), since there's no
   fallback.
4. Webmail `https://inbox.sgnl.example.com`: shared mailboxes show
   up under "Shared".
5. `https://mail.sgnl.example.com/account` → Credentials → one
   **app password per device** for iOS/macOS Mail, Thunderbird.
6. `https://vault.sgnl.example.com` → email → "Use single sign-on"
   (any SSO identifier, e.g. `sgnl`) → set the **master password**, which
   only they know and nobody can recover. Then the official Bitwarden
   apps/extensions: "Self-hosted", server URL
   `https://vault.sgnl.example.com`, log in with single sign-on.
7. **A second, separate invitation, for the company's shared
   passwords.** It's easy to miss: it comes from the password vault, not
   from the login system, and goes to the **new** company mailbox (not
   the personal one). After step 6, in the webmail: the email "Join
   <company>" → "Join Organization" → log in with single sign-on as in
   step 6. Then tell the admin "vault joined": they confirm it
   (`bin/sgnl-vault-sync`), and only then do the company's shared
   passwords appear (until then the vault shows only their own). The
   link expires after **5 days**; if it did (or the email never came),
   the admin resends it: Admin Console → Members → ⋮ → "Resend
   invitation". (Goal: no separate invitation, see the TODO; until then
   this step stays.)

Pitfalls:
- **Password managers fill in an old password**; 3 wrong ones in 2 min
  lock the account for 30 min (lift: break-glass below).
- **Repeated failed webmail logins** get the person's IP banned by
  Stalwart for 24 h (10 per hour), which also blocks mail apps on that
  network: `DEPLOY.md`, "If you get auto-banned".

### Using SGNL from AI apps

Everyone in `sgnl_users` can connect an AI app (Claude Code, claude.ai
with Claude Desktop and the phone apps, Codex) to their mail, calendar,
contacts and files through the MCP gateway; nothing to add per person
(`DEPLOY.md` §6c). Tell them the address
`https://mcp.sgnl.example.com/mcp` and the name `sgnl-<instance>`, and
point them to "Getting started" in the gateway's user guide
(github.com/igorski89/sgnl-mcp, `docs/user-guide.md`). The AI app sends
them to the SGNL login page (password + passkey); before it sends mail
or meeting invitations, shares a file with a colleague, changes one of
their files or saves into a shared space, it asks them to confirm. Codex in its
no-approval mode answers that question itself: tell them not to use that
mode with SGNL (`SECURITY.md` §6e). Disabling or
suspending the account cuts the AI apps off too.

## Colleagues' free/busy and the directory

Everyone sees every colleague's **free/busy** (busy times only, never
titles or details), and can look colleagues up in the company directory
(Stalwart `Sharing.allowDirectoryQueries`, in `stalwart/plan.ndjson`).
Stalwart has no server default for free/busy, so `bin/sgnl-freebusy-sync`
shares each person's calendars with each colleague with only
`mayReadFreeBusy` (idempotent; never lowers an existing share).
`bin/sgnl-id finish-invite` runs it; a new person whose mailbox doesn't
exist yet (no first login) is picked up the next time it runs, so run it
once more after their first login.

## Shared mailboxes (groups)

Shared addresses are Stalwart **Groups** (decided 2026-10-09; not mailing
lists): one mailbox, members open it next to their own. `admin@` is one,
and it's also the domain catch-all (`Domain.catchAllAddress`): mail to
any unknown @example.com address (typos, hello@, spam to made-up
names) lands there.

**Members and aliases live on the mail server, not in git** (since
2026-11-26): the plan only creates accounts and groups, so
`bin/stalwart-apply` never reverts a membership. Change them by asking an
AI app on the admin connection ("add anna to contact@", "give anna the
address sales@", each confirmed; `docs/admin-guide.md`), or with
`stalwart-cli update Account <id> --json '{"memberGroupIds":{…}}'`
(the whole map: it replaces the old value).
A new group: ask an AI app on the admin connection ("create sales@ with anna", confirmed; it then lives only on the server, not in the plan), or a `"@type":"Group"` Account line like `admin-group`. Deleting or renaming one stays a terminal step (deleting deletes its mail).
Its `description` is the **sender name** people see on mail sent as the
group (e.g. "Example Ltd"), so keep it presentable. Stalwart copies it
into the group's sending identity the first time someone sends, and
doesn't follow later changes: after renaming, update that identity too
(webmail: the shared account's identity settings; or JMAP `Identity/set`
logged in as a member with the recovery admin's impersonation
`member@domain%admin`).

Groups today: **admin@** (catch-all) and **contact@** (website enquiries
from the example.com contact form, created 2026-10-16; the site's
own IAM user `example-site-ses` may only send to this address).

In webmail it appears as a second account ("Shared with me" in
Settings); Settings → Unified Mailbox → "Include group inboxes" merges
it into one inbox view. In Mail.app/iOS the group's folders show up
under the person's own account via IMAP (to verify).

Members can **send as the group address** (tested 2026-10-09; Stalwart's
"sender must match" rule counts group membership, and refuses addresses
you don't own). Webmail: Settings → Identities → add the group address,
then pick it in From. Mail.app: Settings → Accounts → the account →
Email Address → "Edit Email Addresses…" → add it.

## Forgejo (git.sgnl.example.com)

Accounts are created at first login through the login server (no sign-up form, no
local passwords). Groups decide everything, re-applied at every login:

| Group | Forgejo |
|---|---|
| `forgejo_users` | may log in at all (login server policy `sgnl_forgejo`, also needs `sgnl_users`) |
| `admins` | site admin |
| `developers` | team **Developers** (write on all repos) in org `example` |

Fine-grained rights (other teams, per-repo access, branch protection) are
set in Forgejo itself. A person has to log in once before they can be
added to anything, because their account doesn't exist before that.

git over HTTPS only: Forgejo → Settings → Applications → **Generate
token** (scope: repository read/write), then use it as the password:
`git clone https://git.sgnl.example.com/example/<repo>.git`
(username = your login, password = the token; the macOS keychain
remembers it). LFS works over the same URL.

Setup that lives in Forgejo's database: `bin/sgnl-forgejo-setup auth`
(login source, named `authelia`, pointing at the login server) and
`bin/sgnl-forgejo-setup org` (org + team).

## Shared passwords (Vaultwarden organisation)

Personal passwords stay in each person's own vault. Company passwords
live in the organisation, sorted into **collections**, and collections
are shared with **groups**. Which groups exist, who is in them and which
collections they see is config, not clicks:
`instance/vaultwarden/org.yaml`, applied by `bin/sgnl-vault-sync`.

- Members and groups follow the login server (e.g. Vaultwarden
  `everyone` = login server `sgnl_users`). `bin/sgnl-id` runs the sync after
  finish-invite, group changes, disable and enable, so a new person is
  invited automatically; they accept the invite email once, and the next
  sync confirms them.
- When the sync runs: on every people change (through `bin/sgnl-id`),
  plus once by hand after someone accepts their invite (Vaultwarden
  doesn't tell us). No timer: confirming needs an owner's unlocked vault,
  which no unattended job has. Changes made with the server's own CLI
  bypass `bin/sgnl-id`: run `bin/sgnl-vault-sync` afterwards.
  An expired invite: Admin Console → Members → ⋮ → "Resend invitation". Disabled people are revoked; owners are never
  touched.
- Collections listed in `org.yaml` are created and their group access
  set (`view`, `view-hidden`, `edit`, `manage`); others are left alone.
- Moving an item into a collection: its menu, "Assign to collections"
  (one-way: it can't go back to a personal vault).
- `bin/sgnl-secret --set` puts new infrastructure secrets into the
  collection `SGNL`.

## Landing page (home.sgnl.example.com)

Dashy, configured only through git (UI editing is off): SGNL's tiles in
`dashy/conf.yml`, the instance's own tiles in
`instance/dashy/extra-apps.yml` (added to "Apps", e.g. Stripe) and
`instance/dashy/extra-sections.yml` (own sections), logging in through
the login server (client `dashy`). Each tile/section has
`displayData.showForGroups: [<group>]`; a new app = a new item, then
`bin/sgnl-deploy dashy`.

- Tiles are hints: the logged-in user's browser receives the whole
  config and hides what their groups don't match. Access is enforced by
  the login server and each app, so admin links being in the config is harmless.
- Status lights: Dashy's server checks each `statusCheckUrl` every 5 min
  (only for logged-in users).

## Suspend / offboard / delete

Three levels, each building on the one before:

| | Suspend | Offboard | Delete |
|---|---|---|---|
| For | sabbatical, suspected compromise, investigation | the person leaves, their work stays | final removal after a retention period |
| Reversible | fully (`--resume`) | partly | no |
| Script | `bin/sgnl-user-suspend` | (to build, see TODO; manual steps below) | (to build) |

### Suspend (`bin/sgnl-user-suspend`)

```bash
bin/sgnl-user-suspend anna            # cut off access, keep everything
bin/sgnl-user-suspend --status anna
bin/sgnl-user-suspend --resume anna
```

It blocks every way in, because several bypass the SSO login:

| Where | Suspend does | Blocks |
|---|---|---|
| Login server | account disabled, all sessions and tokens (incl. refresh/offline) ended (`bin/sgnl-id disable`) | every SSO login, at once; a signed access token an app checks itself lasts ≤ 5 min |
| Stalwart | `authenticate` permission disabled (Merge) | webmail/JMAP, IMAP, SMTP, **app passwords**; mail keeps arriving |
| Forgejo | prohibit login | web and **git tokens** |
| OpenCloud | account disabled (`accountEnabled=false`) | apps, **app tokens** (WebDAV); files and shares stay |

Groups, teams, mailbox, repos and passwords stay as they are, so resume
puts everything back. The other three steps were tested 2026-10-09/11;
the login server step uses `bin/sgnl-id disable`/`enable` (tested on
Keycloak 2026-10-19, not yet with a throwaway user on the new server).

- Only this person is logged out (with stock Authelia before
  2026-10-19, ending sessions meant restarting it and logging everyone
  out). `--kill-sessions` is accepted
  but no longer needed.
- The OpenCloud step makes a 5-minute admin app token on the server with
  the CLI (`opencloud auth-app create`); nothing is stored.
- Mail apps already connected stay connected until they reconnect.
  `docker restart` of Stalwart cuts them at once, for everyone.
- Only accounts on default Stalwart permissions are touched (custom ones
  are reported, not changed), so resume restores them exactly.
- alice is refused unless `SGNL_ALLOW_SELF=1` (only admin).
- The Forgejo step uses Vaultwarden (`bin/sgnl-secret`) token
  `example-sgnl-forgejo-admin-token` (alice's, scope write:admin;
  the Forgejo CLI has no "prohibit login").

After a suspected compromise, before `--resume`: remove their password
and passkeys (break-glass below) and send a new `setup-email` (to a mailbox only
they control); they replace their mail app passwords and git tokens. The
script prints this list.

### Offboarding (manual until the script exists)

- **Login:** `bin/sgnl-id disable anna` (ends their sessions too).
  Delete the user only once their data is handled; `bin/sgnl-id` has no
  delete: the server's CLI, `authelia users delete anna` (break-glass
  below). A deleted username can never be used again.
- **Mail apps:** app passwords don't go through the login server. Delete
  them, or the account, in Stalwart (`stalwart-cli query AppPassword` while
  impersonating, or delete the account once its mail is exported).
- **Groups:** remove them from the shared mailboxes (AI admin tools, or `stalwart-cli`; members aren't in the plan).
- **Forgejo:** git tokens don't go through the login server either. Disable the
  account: Forgejo → Site administration → User accounts → edit →
  "Disable sign-in" (and delete their tokens), or delete the user once
  their repos are moved.
- **Vaultwarden:** remove them from shared collections. Their own vault is
  encrypted with their master password.
- **Stripe (and other SAML SaaS):** the login server doesn't tell Stripe, and a
  Stripe session lasts up to 12 h after the last SSO login. Remove them
  in Stripe → Settings → Team and security → Team, the same day.

## Break-glass (admin)

`bin/sgnl-id` covers most of it. The rest has no script: it is the
login server's own CLI inside its container, on the host over root SSH
(`docker exec <sgnl-id container> authelia ...`; the container has the
config and the storage key). There is no master admin or admin console;
root SSH to the host is the break-glass. These CLI commands haven't
been run on production yet.

| Situation | Fix |
|---|---|
| Lost passkey / phone | Remove their passkeys: `authelia storage user webauthn list <user>`, then `authelia storage user webauthn delete <user> --description <name>` (or `--all`). Then `bin/sgnl-id setup-email <user>` (password + new passkey) |
| Forgot password | "Reset password?" on the login page (link to their SGNL mailbox). Locked out of everything: `bin/sgnl-id setup-email <user>`; if their mailbox is out of reach, temporarily set a personal email (`authelia users update <user> --email <personal>`; `bin/sgnl-id` has no command for it), and set it back afterwards |
| Login fails although the password is right (lockout: 3 failures / 2 min → 30 min) | `authelia storage bans user list`, then `authelia storage bans user revoke <user>` |
| Set-up/reset emails don't arrive | The login server sends via SES (`notifier` in `id/configuration.yml`, from `auth@`); check `bin/sgnl-id events <user>` and `kamal app logs -c config/deploy.id.yml` |
| alice locked out (lost both passkeys) | Same as a lost passkey, over root SSH: remove alice's passkeys, then `bin/sgnl-id setup-email alice` (the agent's client doesn't need alice's login) |
| Banned by **Stalwart** (10 failed mail/web logins per hour per IP) | `DEPLOY.md` step 2, "If you get auto-banned" |

The login server's database is in the nightly backup; restore drill:
`bin/sgnl-backup-restore-test-id`.

The Stalwart recovery admin (`STALWART_RECOVERY_ADMIN` in Vaultwarden (`bin/sgnl-secret`))
works without the login server. It's the way into Stalwart if the login
server is broken; mail and app passwords keep working without it anyway.
