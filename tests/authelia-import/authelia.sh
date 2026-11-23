#!/usr/bin/env bash
# C8 rehearsal: run the fork's CLI against the rehearsal config + volume.
set -euo pipefail
R=$(cd "$(dirname "$0")" && pwd)
I=${AUTHELIA_IMAGE:-ghcr.io/igorski89/authelia:v4.40.0-sgnl.7}
exec docker run --rm -e X_AUTHELIA_CONFIG_FILTERS=template -v "$R":/cfg:ro -v c8-authelia-data:/data \
  -v "$HOME/.cache/sgnl/c8/keycloak-test-export.json":/import/export.json:ro --entrypoint authelia "$I" "$@"
