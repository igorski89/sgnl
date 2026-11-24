# Backups

Nightly, encrypted, off-site. Live since 2026-10-08 (first snapshot
`38258b56`, restore drill passed).

| | |
|---|---|
| What | Stalwart volume (all mail), Forgejo, Vaultwarden, OpenCloud (config + data), listmonk (SQLite volume + uploads; `pg_dump` until 2026-11), Bulwark (admin config, per-user webmail settings), the login server (`sgnl_id_data`, one SQLite file: users, groups, passwords, passkeys, sessions, consents; since 2026-11-24), `/opt/sgnl/stalwart` (config). Keycloak (`pg_dump`, 2026-10-18 → 2026-11-24) and before it Authelia and lldap left the backup when they were replaced; older snapshots still contain them until retention drops them |
| When | 01:30 UTC (+ up to 10 min), systemd `sgnl-backup.timer`; cotenant's backup runs at 03:00 |
| Where | Cloudflare R2, bucket `example-sgnl-backups` (EU jurisdiction, same account as cotenant) |
| How | `host/backup/sgnl-backup.sh` on the host: rsync (`-aHAX`: keeps extended attributes, which OpenCloud needs) each volume to `/opt/sgnl/backup/staging`, `docker pause` the app for a second rsync (consistent copy, ~1–2 s), then restic (`restic/restic:0.19.1`). SQLite apps (Forgejo, listmonk, the login server) are copied paused like the rest, so the copy is what SQLite would find after a power cut |
| Encryption | restic, on the host, before upload. Password: Vaultwarden item `example-sgnl-restic-password` (`bin/sgnl-secret`) + a copy in Apple Passwords (`bin/sgnl-breakglass-export`; `bin/sgnl-breakglass-check` proves it opens the repo, passed 2026-11-17) |
| Retention | every snapshot of the last 35 days, then 13 weekly, 12 monthly. Nightly `forget`; `prune` (deletes data) only on the 15th of each month, so it never tries to delete packs younger than the 30-day lock. (`--keep-daily` + nightly prune did, and hung on the locked deletes, 2026-10-09.) A prune failure email mentioning "locked by the bucket policy" is harmless: leftovers from an interrupted run, deleted the next month |
| Delete protection | R2 bucket lock: `data/` objects can't be deleted for 30 days (tested: `ObjectLockedByBucketPolicy`) |
| Integrity | `restic check --read-data-subset=5%` every Sunday |
| Alerts | Any failure emails `owner@personal.example` via SES (tested). **A job that never runs sends nothing.** A healthchecks.io dead-man switch would cover that (TODO) |

## Bootstrap bundle (what's only on the laptop)

Since 2026-11-17, `bin/sgnl-bootstrap-push` puts the whole git repo
(`git bundle --all`), every live secret (CSV, as
`bin/sgnl-breakglass-export`) and `aws/terraform.tfstate` + `tfvars` into
the same restic repository as one tar (host `bootstrap`, tag `bootstrap`),
streamed from memory. It runs after every commit (`.githooks/post-commit`,
in the background; failure = macOS notification + `.git/sgnl-bootstrap-push.log`;
enable per clone with `git config core.hooksPath .githooks`), and by hand
after rotating a secret. Needs Vaultwarden unlocked (`BW_SESSION`):
if it's locked, the push fails and notifies (by choice). Own retention: last 30, daily 90, monthly 12.
The nightly server job emails if the newest bundle is older than 14 days.

    restic dump --host bootstrap latest /sgnl-bootstrap.tar | tar -x
    git clone sgnl-bootstrap/repo.bundle sgnl

Stopgap until the repo split: then the repo lives on GitHub (+ Forgejo
mirror, in the nightly backup) and only the secrets come from the laptop.

## Keys

| Vaultwarden (`example-sgnl-…`, via `bin/sgnl-secret`) | On the host |
|---|---|
| `restic-password`, `backup-s3-access-key-id`, `backup-s3-secret-access-key` | `/opt/sgnl/backup/restic.env` (root, 600) |
| `ses-smtp-username`, `ses-smtp-password` (shared) | `/opt/sgnl/backup/notify.env` (root, 600) |

The R2 token is "Object Read & Write" on this bucket only. Rotating:
create a new token, update the Vaultwarden item, run `bin/sgnl-backup-install`,
delete the old token.

## Commands

```bash
bin/sgnl-backup-install            # install/update script, units, env files; enables the timer
bin/sgnl-backup-install --run      # ...and back up now
bin/sgnl-backup-restore-test       # restore drill (below)
bin/sgnl-backup-restore-test-all        # all of them, with a summary (monthly, after upgrades)
bin/sgnl-backup-restore-test-id         # login server: SQLite file -> throwaway login server
bin/sgnl-backup-restore-test-listmonk   # listmonk: SQLite volume + uploads -> throwaway listmonk

ssh root@203.0.113.10 journalctl -u sgnl-backup -n 100   # last runs
ssh root@203.0.113.10 systemctl list-timers sgnl-backup.timer
```

Listing snapshots on the host:
```bash
docker run --rm --env-file /opt/sgnl/backup/restic.env restic/restic:0.19.1 snapshots
```

## Restore drill

`bin/sgnl-backup-restore-test` restores the latest snapshot into a scratch
dir on the host, boots a throwaway Stalwart on it (internal Docker
network: no internet, no published ports), logs in as the recovery admin
and prints alice's mailboxes with message counts. Compare them with
webmail. It removes everything afterwards. Run it every few months and
after any Stalwart upgrade.

2026-10-08: Inbox 4, Sent Items 2, matching webmail.

## Restore drill: Forgejo

`bin/sgnl-backup-restore-test-forgejo [snapshot]` restores the Forgejo
volume into a scratch dir, boots a throwaway Forgejo on it (internal
network, no ports; app.ini and its secrets come from the backup itself),
and checks health (database opens), users vs live, `git fsck` per repo,
every LFS pointer in every repo's history against the restored LFS store
(present, right size), and `forgejo doctor`. Removes everything afterwards.

2026-10-10, snapshot `eb2ff4b6` (557 MB restored in 4 s): healthy; users
same as live (alice); lfs-test 2 commits / 1 LFS, cotenant-app 476 / 0,
cotenant-engine 33 / 121 LFS, all fsck ok, 0 missing. Doctor: only the
expected authorized_keys error (SSH disabled).

## Restore drill: Vaultwarden

`bin/sgnl-backup-restore-test-vaultwarden [snapshot]` restores the
Vaultwarden volume into a scratch dir and checks: `db.sqlite3` and
`rsa_key.pem` present, SQLite `integrity_check`, row counts (users, items,
folders, orgs, devices, sends, attachments) next to a read-only copy of
the live database, and a throwaway Vaultwarden (internal network, no
ports) that answers `/alive` and reuses the restored RSA key. sqlite3 runs
in a throwaway `alpine:3.20` (pulls the `sqlite` package, so it needs the
internet; the restored files are mounted read-only).

What it can't prove: vault items are end-to-end encrypted with each
person's master password, so decryption is only proven by a person
logging in to a restored copy.

2026-10-11 (snapshot taken right after alice's vault was created):
integrity ok; users 1 | 1, items 0 | 0 (vault still empty), devices 2 | 2;
throwaway instance alive with the restored key. Re-run once the vault has
items.

## Restore drill: OpenCloud

`bin/sgnl-backup-restore-test-opencloud [account] [snapshot]` restores
both OpenCloud volumes into a scratch dir and checks: `opencloud.yaml`
present; SHA-256 of every user file against the live volume (posix
storage = plain files); a throwaway OpenCloud (internal network, no
ports, `OC_URL` pointed at itself) answers `/status.php`; its Graph API
lists the same users as live; and for one account OpenCloud itself lists
the files over WebDAV and serves one whose SHA-256 matches the disk. It
authenticates with 5-minute app tokens created by the CLI inside the
throwaway instance.

**What it caught (2026-10-11):** the first run restored files with
identical contents that OpenCloud could not see. OpenCloud keeps file
metadata in extended attributes (`user.oc.*`) and the backup's
`rsync -a` dropped them. Fixed with `rsync -aHAX` in
`host/backup/sgnl-backup.sh`; **snapshots before `9971be3a` contain
OpenCloud files without their metadata** (contents are fine, but they
would have to be re-imported).

2026-10-11, snapshot `9971be3a`: 2 files, all checksums identical; users
[admin,alice] on both; restored OpenCloud lists alice's files and serves
one with a matching checksum.

## Restore drill: login server

`bin/sgnl-backup-restore-test-id [snapshot]` restores `sgnl_id_data`
(one SQLite file, `db.sqlite3`), runs SQLite's integrity check, prints
users/groups/passkeys counts next to live (live may be newer), then
starts a throwaway login server (live's image and config, internal
network: no internet, no ports) on the copy. It only starts healthy if
the storage encryption key (`id-storage-encryption-key`) opens the
file, so that key matters as much as the backup. Run it before every
upgrade of the fork.

## Restore drill: listmonk

`bin/sgnl-backup-restore-test-listmonk [snapshot]` restores the database
volume (`sgnl_listmonk_data`, one SQLite file: our fork,
config/deploy.listmonk.yml) and the uploads, starts a throwaway listmonk
(live's image) on the copy on an internal network (no internet: it can't
send anything), then checks: `/health`, SQLite's integrity check, counts
of lists/subscribers/campaigns/templates/users next to live, settings
(root URL, SSO login, SES webhook and topic) equal to live, and
uploads present. Run it before every listmonk upgrade. (On Postgres,
first run 2026-11-18: OK.)

The database is copied like Forgejo's: paused, the whole volume
(`listmonk.db` with its `-wal`/`-shm` files) at once, so the copy is what
SQLite would find after a power cut, which it recovers from. Copying
`listmonk.db` alone while listmonk runs would not be safe.

## Real restore (server or data lost)

1. Get a host with Docker. Deploy the login server and Stalwart as in
   `docs/DEPLOY.md` (the login server's data goes back in step 3), but **don't** start Stalwart on an empty volume and
   send mail into it.
2. Restore:
   ```bash
   docker run --rm --env-file restic.env -v /opt/sgnl/backup:/restore \
     restic/restic:0.19.1 restore latest --host sgnl --target /restore/r
   ```
   Pick an older snapshot with its ID instead of `latest`
   (`... snapshots` lists them).
3. Stop the app, replace the volume contents, fix ownership, start it:
   ```bash
   docker stop <stalwart container>
   rsync -a --delete /opt/sgnl/backup/r/staging/sgnl_stalwart_v1/ /var/lib/docker/volumes/sgnl_stalwart_v1/_data/
   chown -R 2000:2000 /var/lib/docker/volumes/sgnl_stalwart_v1/_data
   docker start <stalwart container>
   ```
   Same for the other volumes (login server `sgnl_id_data`, Forgejo,
   Vaultwarden, OpenCloud), each with its container's owner. The login
   server needs the same `id-storage-encryption-key` as before.
4. Inbound mail that arrived since the snapshot is still in S3 for 30
   days (`incoming/`). Re-run the forwarder for those messages.

## Adding an app

A database server (Postgres): dump it (`pg_dump`) rather than adding
its volume; none runs today. Anything else: add `"<kamal service> <volume>"` to `APPS` in `host/backup/sgnl-backup.sh`,
then `bin/sgnl-backup-install --run`.

## Not backed up

- Monitoring (`config/deploy.monitoring.yml`): metrics (VictoriaMetrics,
  90 days) are disposable; Grafana's dashboards, datasources and settings
  are in git (`docker/grafana/`), its volume only holds users and
  sessions, recreated at the next SSO login. Logs (VictoriaLogs,
  30 days) are disposable too; the Logs org in Grafana is recreated by
  `bin/sgnl-grafana-setup`.

## Limits

- The pause copy assumes the volume is on the same disk; at several GB
  the first rsync pass takes minutes, the paused pass stays short.
- OpenCloud has no database: its two volumes (config incl. generated
  secrets, and data) are the whole state.
