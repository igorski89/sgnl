#!/usr/bin/env bash
# Runs ON a dev VM as root (bin/sgnl-dev garage): Garage (S3-compatible,
# AGPL-3.0, single node) as the backup target instead of Cloudflare R2.
# Listens on the Docker bridge only (172.17.0.1:3900), where the restic
# container of the nightly backup reaches it; plain HTTP inside the VM.
# Idempotent. Prints "<key id> <secret>" of the backup key on stdout the
# first time (bin/sgnl-dev stores them in the dev secrets file).
#   usage: garage.sh <bucket>
set -euo pipefail
bucket=$1
IMAGE=dxflrs/garage:v2.1.0
D=/opt/sgnl/garage
install -d -m 700 $D $D/meta $D/data
if [[ ! -s $D/garage.toml ]]; then
  umask 077
  cat > $D/garage.toml <<EOF
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "$(openssl rand -hex 32)"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
[admin]
api_bind_addr = "[::]:3903"
admin_token = "$(openssl rand -base64 32)"
EOF
fi
if ! docker ps -q -f name='^sgnl-garage$' | grep -q .; then
  docker rm -f sgnl-garage >/dev/null 2>&1 || true
  docker run -d --name sgnl-garage --restart unless-stopped --memory 256m \
    -p 172.17.0.1:3900:3900 \
    -v $D/garage.toml:/etc/garage.toml:ro -v $D/meta:/var/lib/garage/meta -v $D/data:/var/lib/garage/data \
    $IMAGE >/dev/null
  sleep 3
fi
g() { docker exec sgnl-garage /garage "$@"; }
node=$(g status 2>/dev/null | awk '/^[0-9a-f]{16}/{print $1; exit}')
if g layout show 2>/dev/null | grep -q "No nodes currently have a role"; then
  g layout assign -z dc1 -c 10G "$node" >/dev/null
  g layout apply --version 1 >/dev/null
fi
g bucket info "$bucket" >/dev/null 2>&1 || g bucket create "$bucket" >/dev/null
if ! g key info backup >/dev/null 2>&1; then
  out=$(g key create backup)
  g bucket allow --read --write --owner "$bucket" --key backup >/dev/null
  id=$(awk '/Key ID/{print $NF}' <<<"$out"); secret=$(awk '/Secret key/{print $NF}' <<<"$out")
  echo "$id $secret"
fi
