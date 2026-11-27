#!/usr/bin/env bash
# Dev environments only (bin/sgnl-dev bootstrap): the dev mail server's
# certificate for 465/993 = the dev wildcard certificate (prod's comes from
# ACME). Creates it, then deletes the earlier Certificate objects; the key goes to
# stalwart-cli on stdin, never on a command line. Restart Stalwart after.
#   usage (via bin/sgnl-dev run): host/dev/stalwart-cert.sh <tls.crt> <tls.key> <ca.pem>
set -euo pipefail
cd "$(dirname "$0")/../.."
source lib/instance.sh
[[ ${SGNL_ENV:-} == dev ]] || { echo "stalwart-cert.sh: dev instances only" >&2; exit 1; }
r=$(bin/sgnl-secret stalwart-recovery-admin)
export STALWART_URL="https://mail.$SGNL_APPS_DOMAIN" STALWART_USER="${r%%:*}" STALWART_PASSWORD="${r#*:}"
unset r
old=$(stalwart-cli query Certificate --json </dev/null | python3 -c 'import json,sys; print(",".join(json.loads(l)["id"] for l in sys.stdin if l.strip().startswith("{")))')
python3 - "$@" <<'PY' | stalwart-cli apply --stdin --quiet
import json, sys
crt, key, ca = sys.argv[1:]
print(json.dumps({"@type": "create", "object": "Certificate", "value": {"dev": {
    "certificate": {"@type": "Text", "value": open(crt).read() + open(ca).read()},
    "privateKey": {"@type": "Text", "secret": open(key).read()}}}}))
PY
[[ -z $old ]] || stalwart-cli delete Certificate --ids "$old" </dev/null >/dev/null
echo "certificate replaced"
