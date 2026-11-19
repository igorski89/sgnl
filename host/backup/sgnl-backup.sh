#!/usr/bin/env bash
# Nightly encrypted backup of the sgnl apps to Cloudflare R2 (restic).
# Runs on the host as root from sgnl-backup.timer; installed by
# bin/sgnl-backup-install. See docs/BACKUPS.md.
#
#   1. Copy each app's Docker volume into /opt/sgnl/backup/staging:
#      a bulk rsync while the app runs, then `docker pause` + a second
#      rsync for the files that changed meanwhile, then unpause. The
#      pause is what makes the copy consistent (RocksDB and SQLite are
#      crash-safe, so a frozen copy restores like after a power cut),
#      and the bulk pass keeps it to a second or two as data grows.
#      Keycloak's and listmonk's Postgres are dumped (pg_dump) into staging.
#   2. restic (official image) backs up staging + /opt/sgnl config,
#      encrypted on this host, then applies retention.
#   3. Any failure emails ALERT_TO through SES.
#
# Runs on the host rather than in a container because pausing apps
# needs the Docker socket, which is root on the host anyway.
set -euo pipefail

BASE=/opt/sgnl/backup
STAGING=$BASE/staging
RESTIC_IMAGE=restic/restic:0.19.1

# shellcheck source=/dev/null
. "$BASE/notify.env" # ALERT_TO, SES_SMTP_USERNAME, SES_SMTP_PASSWORD

# Kamal service label -> Docker volume (Forgejo: repos + LFS + SQLite).
# One line per volume; a service with two volumes is paused once per volume.
# Collabora has no state worth keeping (its WOPI proof key is regenerated).
APPS=(
  "sgnl-stalwart sgnl_stalwart_v1"
  "sgnl-forgejo sgnl_forgejo_data"
  "sgnl-vaultwarden sgnl_vaultwarden_data"
  "sgnl-opencloud sgnl_opencloud_config"
  "sgnl-opencloud sgnl_opencloud_data"
  "sgnl-listmonk sgnl_listmonk_uploads"
)

notify_failure() {
  local why=$1
  echo "backup failed: $why" >&2
  printf 'From: SGNL backup <backup@{{SGNL_DOMAIN}}>\r\nTo: %s\r\nSubject: [sgnl] backup FAILED on %s\r\n\r\n%s\r\n\r\nLogs: ssh root@%s journalctl -u sgnl-backup -n 200\r\n' \
    "$ALERT_TO" "$(hostname)" "$why" "$(hostname -I | awk '{print $1}')" |
    curl -sS -m 30 --ssl-reqd --url smtp://{{SGNL_SMTP_HOST}}:587 \
      --mail-from backup@{{SGNL_DOMAIN}} --mail-rcpt "$ALERT_TO" \
      --user "$SES_SMTP_USERNAME:$SES_SMTP_PASSWORD" -T - ||
    echo "also failed to send the alert email" >&2
}
trap 'notify_failure "unexpected error at line $LINENO (exit $?)"' ERR

restic() { # time-limited, so a stuck restic fails (and emails) instead of hanging
  timeout "${RESTIC_TIMEOUT:-2h}" docker run --rm --env-file "$BASE/restic.env" \
    -v "$STAGING:/staging:ro" \
    -v /opt/sgnl/stalwart:/config/stalwart:ro \
    -v "$BASE/cache:/root/.cache/restic" \
    "$RESTIC_IMAGE" "$@"
}

# rsync -aHAX, not just -a: OpenCloud keeps file metadata (space, ids,
# shares) in extended attributes (user.oc.*). Without -X the restored
# files were intact but invisible to OpenCloud (caught by the restore
# drill, 2026-10-11). restic itself stores and restores xattrs.
snapshot_volume() {
  local service=$1 volume=$2 container src dest rc=0
  src=/var/lib/docker/volumes/$volume/_data/
  dest=$STAGING/$volume/
  mkdir -p "$dest"
  rsync -aHAX --delete "$src" "$dest"
  container=$(docker ps -qf "label=service=$service" | head -1)
  if [[ -z $container ]]; then
    notify_failure "$service is not running; backing up its last on-disk state"
    rsync -aHAX --delete "$src" "$dest"
    return
  fi
  docker pause "$container" >/dev/null
  rsync -aHAX --delete "$src" "$dest" || rc=$?
  docker unpause "$container" >/dev/null
  echo "$volume: copied (rsync exit $rc)"
  return $rc
}

echo "==> copying app data"
for app in "${APPS[@]}"; do
  # shellcheck disable=SC2086
  snapshot_volume $app
done

# Postgres databases (Keycloak, listmonk): a dump, not a file copy (a copy
# of a running Postgres is only crash-consistent). pg_dump takes one
# consistent snapshot without blocking the app, and runs inside the
# server's own container, so client and server versions always match.
dump_pg() { # <name> <container> <db user = db name>
  echo "==> dumping $1's database"
  if docker ps -q --filter name="^$2\$" | grep -q .; then
    mkdir -p "$STAGING/$1"
    docker exec "$2" pg_dump -U "$3" -Fc "$3" > "$STAGING/$1/$1.dump.tmp"
    mv "$STAGING/$1/$1.dump.tmp" "$STAGING/$1/$1.dump"
    echo "$1.dump: $(du -h "$STAGING/$1/$1.dump" | cut -f1)"
  else
    notify_failure "$2 is not running; $1's last dump is kept as is"
  fi
}
dump_pg keycloak sgnl-keycloak-postgres keycloak
dump_pg listmonk sgnl-listmonk-postgres listmonk

# Staging holds exactly the volumes in APPS plus the database dumps above.
# Anything else (a retired app, a migrated volume) is removed, so it leaves
# the next snapshot instead of being backed up again every night.
keep=" keycloak listmonk "
for entry in "${APPS[@]}"; do keep+="${entry#* } "; done
for dir in "$STAGING"/*/; do
  name=$(basename "$dir")
  [[ $keep == *" $name "* ]] && continue
  echo "staging: removing $name (no longer backed up; older snapshots keep it)"
  rm -rf "${STAGING:?}/$name"
done

echo "==> restic backup"
restic cat config >/dev/null 2>&1 || restic init
restic backup /staging /config --host sgnl --tag daily

echo "==> retention"
# R2 refuses deletes under data/ for 30 days (bucket lock), so pack files
# may only be deleted once they're older than that.
# - Nightly: forget only (drops snapshot files, which aren't locked).
#   --keep-within 35d keeps *every* snapshot of the last 35 days, so no
#   pack younger than the lock ever becomes unused. (--keep-daily dropped
#   same-day extras from manual runs, and prune then retried the locked
#   deletes forever; seen 2026-10-09.)
# - Monthly, on the 15th: prune. Packs orphaned by an interrupted run are
#   then >30 days old in all but rare cases; if one isn't, prune fails
#   after its timeout and emails, which is harmless (next month works).
#   --max-unused unlimited: never repack (rewrite + delete) young packs.
RESTIC_TIMEOUT=15m restic forget --host sgnl --keep-within 35d --keep-weekly 13 --keep-monthly 12
if [[ $(date +%d) == 15 ]]; then
  echo "==> monthly prune"
  RESTIC_TIMEOUT=30m restic prune --max-unused unlimited
fi

if [[ $(date +%u) == 7 ]]; then
  echo "==> weekly integrity check (5% of data re-downloaded)"
  restic check --read-data-subset=5%
fi

# The bootstrap bundle (repo + secrets + Terraform state) is pushed from
# alice's laptop after each commit (bin/sgnl-bootstrap-push), not from
# here. Warn when it's gone stale, so a broken hook doesn't go unnoticed.
echo "==> bootstrap bundle age"
age=$(restic snapshots --host bootstrap --latest 1 --json | python3 -c '
import json, sys, datetime
s = json.load(sys.stdin)
if not s: print(9999); sys.exit()
t = datetime.datetime.fromisoformat(s[-1]["time"][:19])
print((datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) - t).days)')
echo "latest bootstrap bundle: $age days old"
if (( age > ${BOOTSTRAP_MAX_AGE_DAYS:-14} )); then
  notify_failure "the bootstrap bundle (repo + secrets) in the backups is $age days old: run bin/sgnl-bootstrap-push on the laptop and check .git/sgnl-bootstrap-push.log"
fi

echo "==> backup complete"
