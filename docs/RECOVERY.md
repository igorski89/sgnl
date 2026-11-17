# Recovery: rebuild SGNL from the backups

**Status: draft (2026-11-17), not yet run end to end.** The drill (F2 in
`../instance/docs/PLAN-recovery.md`) runs it on a throwaway server; fix this file with
whatever it finds.

Written for an agent (or a person) holding the recovery sheet
(a password-protected PDF, made by `bin/sgnl-recovery-sheet`):
repository, R2 key, restic password, and phase 1 ready to run. Do the phases in order. Each ends with a **Check**;
don't go on until it passes. Stop and ask the owner when a step says so.

SGNL shares its server with `cotenant` (a separate app with its own backups).
This file rebuilds SGNL only.

## 0. The owner provides (human steps)

1. **Server:** Hetzner Cloud → new server, Ubuntu 24.04, x86, at least
   16 vCPU / 32 GB RAM / 150 GB disk (current: same). Add the agent
   Mac's SSH public key for root.
2. **A Mac** for the agent (the scripts are written for macOS), with
   Docker Desktop running and Homebrew. Nothing from the old laptop.
3. From the recovery sheet: the R2 key and the restic password, plus
   the server IP.

## 1. Open the backups and fetch the bootstrap bundle

```bash
mkdir -m 700 ~/sgnl-recovery && cd ~/sgnl-recovery
export RESTIC_REPOSITORY="s3:https://<account-id>.eu.r2.cloudflarestorage.com/example-sgnl-backups"
export AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...   # R2 key from the sheet
read -rs RESTIC_PASSWORD; export RESTIC_PASSWORD           # restic password from the sheet
R() { docker run --rm -i -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
        -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY restic/restic:0.18.0 --no-lock "$@"; }
R snapshots --host bootstrap --latest 3
R snapshots --host sgnl --latest 3
R dump --host bootstrap latest /sgnl-bootstrap.tar | tar -x
cat sgnl-bootstrap/MANIFEST.txt
git clone sgnl-bootstrap/repo.bundle sgnl
```

**Check:** both snapshot lists are non-empty; `MANIFEST.txt` shows a
recent date. If the newest `sgnl` snapshot is old, ask the owner which
one to use.

## 2. Repo, secrets, Terraform state

The secrets normally come from Vaultwarden, which runs on the server
being rebuilt. Until it's back, every script reads them from the
bundle's copy instead:

```bash
cd ~/sgnl-recovery/sgnl
git checkout main     # the bundle checks out whatever branch was current
# The instance (this company's values, its own repo inside this one):
git clone ../sgnl-bootstrap/instance.bundle instance
git -C instance checkout main
export SGNL_SECRETS="csv:$HOME/sgnl-recovery/sgnl-bootstrap/secrets.csv"
bin/sgnl-secret --list | wc -l          # 26
cp ../sgnl-bootstrap/aws/terraform.tf* aws/
cp .kamal/secrets.example .kamal/secrets
git config core.hooksPath .githooks
git -C instance config core.hooksPath ../.githooks
```

Keep `SGNL_SECRETS` exported in every shell until phase 6.

Tools: Ruby + `gem install kamal -v 2.12.0`, `stalwart-cli` (`docs/DEPLOY.md` §0). Terraform runs in Docker (`aws/tf`).

**Check:** `bin/sgnl-secret --list` shows 26 names; `git log -1` and
`git -C instance log -1` match the manifest's two commits;
`instance/sgnl.env` exists.

## 3. Server and DNS

1. Set `SGNL_HOST` in `instance/sgnl.env` to the new IP, commit (in `instance/`).
2. Host hardening: `docs/SECURITY.md` §2, `host/harden.sh` (dry run,
   then `--apply`).
3. DNS: point every A record in `docs/DNS.md` ("Subdomains") at the new
   IP, in Cloudflare (owner's login, or the API token
   `example-sgnl-cloudflare-api-token`). **Don't touch MX, SPF,
   DKIM or DMARC.**
4. AWS needs no change: the SES forwarder relays to the hostname
   `mail.sgnl.example.com` (`aws/variables.tf`), which follows DNS.

**Check:** `dig +short id.sgnl.example.com` returns the new IP;
`ssh root@<ip> true` works.

## 4. Restore the data onto the server

Before any app starts on an empty volume (Stalwart especially: it must
not accept mail into an empty store).

```bash
bin/sgnl-backup-install           # restic.env + notify.env on the host (timer: disable until 6)
ssh root@<ip> 'systemctl disable --now sgnl-backup.timer'
ssh root@<ip> 'docker run --rm --env-file /opt/sgnl/backup/restic.env \
  -v /opt/sgnl/backup:/restore restic/restic:0.18.0 \
  restore latest --host sgnl --target /restore/r'
```

Then, per volume in `APPS` of `host/backup/sgnl-backup.sh`
(`sgnl_stalwart_data`, `sgnl_forgejo_data`, `sgnl_vaultwarden_data`,
`sgnl_opencloud_config`, `sgnl_opencloud_data`):

```bash
ssh root@<ip> 'docker volume create <vol> && \
  rsync -aHAX --delete /opt/sgnl/backup/r/staging/<vol>/ /var/lib/docker/volumes/<vol>/_data/'
```

Ownership is kept by rsync (`-a`, numeric ids from the backup). Stalwart's
config: `rsync -a /opt/sgnl/backup/r/config/stalwart/ /opt/sgnl/stalwart/`.

**Check:** each volume's size is close to its staging copy
(`du -sh`).

## 5. Deploy, in the order of docs/DEPLOY.md

Follow `docs/DEPLOY.md` §1–6b with these differences:

- **Keycloak first:** boot only its Postgres
  (`kamal accessory boot postgres -c config/deploy.keycloak.yml`), restore
  the dump (`docs/BACKUPS.md`, "Restore drill: Keycloak", real restore),
  then deploy Keycloak. Users, passkeys and clients come back from the
  dump; don't re-run the first-login or invite steps.
- **Skip every "first time" step** (creating admins, Vaultwarden signups,
  Forgejo setup, Stalwart bootstrap): the restored data already has them.
- `bin/sgnl-keycloak-apply` is safe to run (realm config as code).

**Check:** `docs/DEPLOY.md` §7 sanity pass; log in at
`https://id.sgnl.example.com`, `https://drive.sgnl.example.com`,
`https://mail.sgnl.example.com`; the owner sees their mail, files
and vault.

## 6. Back to normal

0. Secrets from Vaultwarden again: `bw config server https://vault.sgnl.example.com`,
   `bw login --apikey` (the owner's API key), `export BW_SESSION=$(bw unlock --raw)`,
   `unset SGNL_SECRETS`, then `bin/sgnl-secret --list` shows 26.
1. `bin/sgnl-backup-install` (timer back on), then
   `bin/sgnl-backup-install --run`.
2. `bin/sgnl-backup-restore-test` and `bin/sgnl-backup-restore-test-keycloak`.
3. Inbound mail since the snapshot is in S3 for 30 days (`incoming/`):
   replay it (`aws/README.md`).
4. If the sheet was handed around: change the restic password
   (`restic key add`, then `restic key remove` the old one; update the
   Vaultwarden item `example-sgnl-restic-password`, Apple Passwords,
   then `bin/sgnl-backup-install`) and the R2 key (new token in
   Cloudflare, same update path); make a new sheet with
   `bin/sgnl-recovery-sheet`.
5. Move the repo out of `~/sgnl-recovery` (e.g. to `~/Work/sgnl`), then
   delete `~/sgnl-recovery/sgnl-bootstrap`: it holds `secrets.csv`.

## Known gaps (fix after the drill)

- Tooling is written for macOS (BSD tar flags, `security` for the
  optional Keychain store); untested on Linux.
- Phases 4–5 are assembled from per-service restore drills that passed,
  not from a full rebuild.
