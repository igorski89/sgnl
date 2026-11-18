# People: accounts, onboarding, recovery

One identity per person: **`alice@example.com` works everywhere.**

| Where | You type |
|---|---|
| SGNL login page (`id.sgnl.example.com`, "Secrétariat Général") | `alice@example.com` (or just `alice`) + password, then the **passkey** |
| Stalwart web UI, **first screen** ("Enter your account name") | `alice@example.com` (the full address; a bare `alice` lands on Stalwart's own password form, which never works) |
| Webmail (Bulwark), vault, files, git, start page | nothing: "Sign in" sends you to the SGNL login page |
| Mail apps (IMAP 993 / SMTP 465) | `alice@example.com` + an **app password** |
| Own account (password, passkeys, sessions) | `https://id.sgnl.example.com/realms/example/account` |

Since 2026-10-19 people live in **Keycloak**, realm `example`
(`config/deploy.keycloak.yml`; Authelia + lldap before that, see
`instance/docs/PLAN-keycloak.md`). Groups, roles, login flows and app clients are
code: `keycloak/realm.yaml`, applied with `bin/sgnl-keycloak-apply`.
People and group memberships are data, managed with `bin/sgnl-kc`.

| Group | Meaning |
|---|---|
| `sgnl_users` | May use the apps (role `sgnl_user`, checked by flow `sgnl-apps`). Without it every app answers "Access denied"; the account page still works |
| `forgejo_users` | May also log in to Forgejo (role `forgejo_user`, flow `sgnl-forgejo`) |
| `admins` | Our admin group (passed to apps in the `groups` claim: Forgejo site admin, OpenCloud admin, Dashy admin section) |
| `developers` | Team Developers in Forgejo's org `example` |
| `sgnl_invited` | Invited, not finished yet: account page only (see Onboarding) |

Each user has one `email`. It's the address apps see and where Keycloak
sends set-up and reset links. Extra addresses (postmaster@, contact@) are
Stalwart aliases/groups, not Keycloak.

Login rules (`keycloak/realm.yaml`):
- **Password + passkey, always.** Passwords: 12+ characters, not the
  username or email. The second factor is a passkey (WebAuthn), required;
  no TOTP, no SMS. Someone with only a password is sent to "register a
  passkey" and gets no further.
- **Brute force:** 3 failures within 2 min → 30 min lockout. The login
  page keeps saying "Invalid username or password" while locked. Lift it
  early: break-glass below.
- **Sessions:** 8 h idle, 7 days max; access tokens live 5 min, so
  disabling someone takes effect in apps within 5 min at most.
- No consent screens, no self-registration. "Forgot Password?" on the
  login page emails a reset link to the user's own (SGNL) address.

Accounts migrated from Authelia kept their Authelia id as Keycloak id
(alice), so apps that link by `sub` (Forgejo, Vaultwarden) found the same
account. Forgejo's login source is still named `authelia`, hence its
"Sign in with authelia" button.

### Managing people

`bin/sgnl-kc` does it from the laptop, as the agent's service account
`sgnl-agent` (rights: manage/view/query users, query groups, view events
and clients; not realm settings). Run it without arguments for usage:

| Command | Does |
|---|---|
| `list`, `show <user>` | people, groups, credentials, sessions |
| `add-user <user> "<First Last>" [email]` | plain user, no password (then `setup-email`) |
| `add-to-group` / `remove-from-group <user> <group>...` | memberships (groups themselves live in `realm.yaml`) |
| `setup-email <user> [hours]` | email: set own password + register a passkey (default 24 h) |
| `invite <user> "<First Last>" <personal-email> [hours]` | onboarding, below (default 72 h) |
| `finish-invite <user> <group>...` | ends onboarding, below |
| `disable` / `enable <user>` | disable also ends all their sessions |
| `logout <user>` | ends all their sessions, incl. offline tokens |
| `events [<user>] [max]` | recent logins and errors |

Changes apply at once, no redeploy. Two master-admin helpers exist for
what the service account can't do: `bin/sgnl-kcadm` (Keycloak's admin
CLI, e.g. realm settings, credentials, lockouts) and `bin/sgnl-kcimport`
(partial import, only to create a user with a *given* id). Both log in as
the master realm's `admin` (Vaultwarden
`example-sgnl-keycloak-bootstrap-admin-password`, password over
stdin). The admin console
(`https://id.sgnl.example.com/admin/master/console/#/example`)
is that same break-glass account; prefer the scripts.

## Onboarding

### Admin side (~5 min)

```bash
bin/sgnl-add-user anna "Anna Example" anna@personal.example
```

It adds the mailbox `anna@example.com` to `instance/stalwart/mailboxes.ndjson`
and applies the plan (mail to her arrives from day one), then runs
`bin/sgnl-kc invite`: Keycloak user `anna` with her **personal** address
as email, group `sgnl_invited` only, and a set-up email (valid 72 h) to
that address. Nothing secret is created or handed over.

Why the personal address and `sgnl_invited`: she can't read
anna@example.com before she can log in, and while her email is the
personal one no app may create her account from it (Forgejo would name
her after it). So she only reaches her account page until:

```bash
bin/sgnl-kc finish-invite anna developers forgejo_users   # sgnl_users is always added
```

It refuses until she has both a password and a passkey; then it sets
her email to anna@example.com and swaps `sgnl_invited` for the
groups. Commit `stalwart/plan.ndjson`. Tell her on another channel
(WhatsApp, in person) to expect the email and to say when she's done.

`finish-invite` also adds her to the company's password vault
(`bin/sgnl-vault-sync`, see "Shared passwords"): Vaultwarden emails her
an invitation to anna@example.com. Once she has accepted it (step 7 of
her side), run the sync once more, which confirms her; until then she
sees none of the company's passwords:

```bash
bin/sgnl-vault-sync
```

### Personal guide (PDF)

Each person gets a personalized guide: no secrets in it, written so it can
also be handed to their own AI assistant (it ends with a "For your AI
assistant" section: facts, known quirks, rules, when to escalate). Bob's
(updated 2026-10-19 for Keycloak) is the model:
`onboarding/bob-onboarding.md` (gitignored). Copy it, replace
name/rights/personal address, then render:

```bash
cd onboarding
pandoc <user>-onboarding.md --standalone --css ../docs/templates/onboarding-guide.css --metadata lang=en -o <user>.html
weasyprint <user>.html <user>-onboarding.pdf && rm <user>.html
```
(pandoc + WeasyPrint are installed on alice's Mac; recipe from cotenant-app-01.)

### The person's side (~30 min)

1. In the personal mailbox: email from **Secrétariat Général**
   (`auth@example.com`), subject **"Update Your Account"** (check
   spam). The link works once, within 72 h.
2. Set a password (12+ characters), register a **passkey**; they land on
   their account page. Apps say "Access denied" until `finish-invite`.
   They tell the admin "done".
3. After `finish-invite`: a **second passkey** on another device (account
   page → Account security → Signing in), since there's no fallback.
4. Webmail `https://inbox.sgnl.example.com`: shared mailboxes show
   up under "Shared".
5. `https://mail.sgnl.example.com/account` → Credentials → one
   **app password per device** for iOS/macOS Mail, Thunderbird.
6. `https://vault.sgnl.example.com` → email → "Use single sign-on"
   (any SSO identifier, e.g. `sgnl`) → set the **master password**, which
   only they know and nobody can recover. Then the official Bitwarden
   apps/extensions: "Self-hosted", server URL
   `https://vault.sgnl.example.com`, log in with single sign-on.
7. In the new mailbox: the email "Join <company>" from the password
   vault → accept (the link is valid 5 days), then tell the admin, who
   confirms it. The company's shared passwords then appear in the vault.

Pitfalls:
- **Password managers fill in an old password**; 3 wrong ones in 2 min
  lock the account for 30 min (lift: break-glass below).
- **Repeated failed webmail logins** get the person's IP banned by
  Stalwart for 24 h (10 per hour), which also blocks mail apps on that
  network: `DEPLOY.md`, "If you get auto-banned".

## Shared mailboxes (groups)

Shared addresses are Stalwart **Groups** (decided 2026-10-09; not mailing
lists): one mailbox, members open it next to their own. `admin@` is one,
and it's also the domain catch-all (`Domain.catchAllAddress`): mail to
any unknown @example.com address (typos, hello@, spam to made-up
names) lands there. Members: `"memberGroupIds":{"#admin-group":true}` on
the user's line in `stalwart/plan.ndjson`, then `bin/stalwart-apply`.
A new group: a `"@type":"Group"` Account line like `admin-group`.

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

Accounts are created at first login through Keycloak (no sign-up form, no
local passwords). Groups decide everything, re-applied at every login:

| Group | Forgejo |
|---|---|
| `forgejo_users` | may log in at all (Keycloak flow `sgnl-forgejo`, also needs `sgnl_users`) |
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
(login source, still named `authelia`, pointing at Keycloak) and
`bin/sgnl-forgejo-setup org` (org + team).

## Shared passwords (Vaultwarden organisation)

Personal passwords stay in each person's own vault. Company passwords
live in the organisation, sorted into **collections**, and collections
are shared with **groups**. Which groups exist, who is in them and which
collections they see is config, not clicks:
`instance/vaultwarden/org.yaml`, applied by `bin/sgnl-vault-sync`.

- Members and groups follow Keycloak (e.g. Vaultwarden `everyone` =
  Keycloak `sgnl_users`). `bin/sgnl-kc` runs the sync after
  finish-invite, group changes, disable and enable, so a new person is
  invited automatically; they accept the invite email once, and the next
  sync confirms them.
- When the sync runs: on every people change (through `bin/sgnl-kc`),
  plus once by hand after someone accepts their invite (Vaultwarden
  doesn't tell us). No timer: confirming needs an owner's unlocked vault,
  which no unattended job has. Changes clicked in Keycloak's admin
  console bypass `bin/sgnl-kc`: run `bin/sgnl-vault-sync` afterwards.
  An expired invite: Admin Console → Members → ⋮ → "Resend invitation". Disabled people are revoked; owners are never
  touched.
- Collections listed in `org.yaml` are created and their group access
  set (`view`, `view-hidden`, `edit`, `manage`); others are left alone.
- Moving an item into a collection: its menu, "Assign to collections"
  (one-way: it can't go back to a personal vault).
- `bin/sgnl-secret --set` puts new infrastructure secrets into the
  collection `SGNL`.

## Landing page (home.sgnl.example.com)

Dashy, configured only through `instance/dashy/conf.yml` in git (UI editing is
off), logging in through Keycloak (client `dashy`). Each tile/section has
`displayData.showForGroups: [<group>]`; a new app = a new item, then
`kamal deploy -c config/deploy.dashy.yml`.

- Tiles are hints: the logged-in user's browser receives the whole
  config and hides what their groups don't match. Access is enforced by
  Keycloak and each app, so admin links being in the config is harmless.
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
| Keycloak | account disabled, all sessions and refresh/offline tokens ended | every SSO login, at once; a token an app already holds lasts ≤ 5 min |
| Stalwart | `authenticate` permission disabled (Merge) | webmail/JMAP, IMAP, SMTP, **app passwords**; mail keeps arriving |
| Forgejo | prohibit login | web and **git tokens** |
| OpenCloud | account disabled (`accountEnabled=false`) | apps, **app tokens** (WebDAV); files and shares stay |

Groups, teams, mailbox, repos and passwords stay as they are, so resume
puts everything back. The Keycloak step was tested 2026-10-19 with a
throwaway user (1 session → 0, disabled; resume re-enabled it); the other
three steps were tested 2026-10-09/11.

- Only this person is logged out (with Authelia, ending sessions meant
  restarting it and logging everyone out). `--kill-sessions` is accepted
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
and passkeys in Keycloak and send a new `setup-email` (to a mailbox only
they control); they replace their mail app passwords and git tokens. The
script prints this list.

### Offboarding (manual until the script exists)

- **Login:** `bin/sgnl-kc disable anna` (ends their sessions too). Delete
  the Keycloak user only once their data is handled
  (`bin/sgnl-kcadm delete users/<id> -r example`).
- **Mail apps:** app passwords don't go through Keycloak. Delete them, or
  the account, in Stalwart (`stalwart-cli query AppPassword` while
  impersonating, or delete the account once its mail is exported).
- **Groups:** remove the `#…-group` entries from their `memberGroupIds`.
- **Forgejo:** git tokens don't go through Keycloak either. Disable the
  account: Forgejo → Site administration → User accounts → edit →
  "Disable sign-in" (and delete their tokens), or delete the user once
  their repos are moved.
- **Vaultwarden:** remove them from shared collections. Their own vault is
  encrypted with their master password.

## Break-glass (admin)

`bin/sgnl-kc` covers most of it; the rest needs the master admin
(`bin/sgnl-kcadm`). `<id>` is the `id` from `bin/sgnl-kc show <user>`.

| Situation | Fix |
|---|---|
| Lost passkey / phone | Remove the credential: admin console → Users → user → Credentials, or `bin/sgnl-kcadm get users/<id>/credentials -r example` then `bin/sgnl-kcadm delete users/<id>/credentials/<credential-id> -r example`. Then `bin/sgnl-kc setup-email <user>` (password + new passkey) |
| Forgot password | "Forgot Password?" on the login page (link to their SGNL mailbox). Locked out of everything: `bin/sgnl-kc setup-email <user>`; if their mailbox is out of reach, temporarily set a personal email (as in onboarding) |
| "Invalid username or password" although right (brute-force lockout: 3 failures / 2 min → 30 min) | `bin/sgnl-kcadm delete attack-detection/brute-force/users/<id> -r example` |
| Set-up/reset emails don't arrive | Keycloak sends via SES (`smtpServer` in `keycloak/realm.yaml`, from `auth@`); check `bin/sgnl-kc events <user>` and `kamal app logs -c config/deploy.keycloak.yml` |
| alice locked out (lost both passkeys) | The master admin isn't affected: `bin/sgnl-kcadm` (or the admin console) → remove alice's credentials → `bin/sgnl-kc setup-email alice` |
| Banned by **Stalwart** (10 failed mail/web logins per hour per IP) | `DEPLOY.md` step 2, "If you get auto-banned" |

The master realm's `admin` has its own brute-force lockout and can't log
in to the apps (it's not in realm `example`). Keycloak's database is
in the nightly backup; restore drill: `bin/sgnl-backup-restore-test-keycloak`.

The Stalwart recovery admin (`STALWART_RECOVERY_ADMIN` in Vaultwarden (`bin/sgnl-secret`))
works without Keycloak. It's the way into Stalwart if Keycloak is
broken; mail and app passwords keep working without Keycloak anyway.
