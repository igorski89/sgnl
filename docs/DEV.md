# Dev environments: the whole stack in a VM on a Mac

A throw-away copy of every app, for trying changes before they reach the
real server. It runs in a Lima VM (Ubuntu, like the server) on an Apple
silicon Mac and uses the normal Kamal configs plus a `-d dev` overlay per
app (`config/deploy.<app>.dev.yml`). Tool: `bin/sgnl-dev`.

## What makes it safe

- **Own instance:** `instance.dev/` (`SGNL_ENV=dev`), private names under
  `.test` (`*.sgnl.example.test`), its own realm and keys.
- **Own secrets:** generated into `~/.sgnl-dev/<name>/secrets.csv`
  (`bin/sgnl-dev-secrets`, mode 600). Dev tools get no vault session, so
  the real vault can't be read or written from them.
- **Own certificate authority**, limited to `.test` names (X.509 name
  constraints): trusted on the Mac, it can't vouch for any real site.
- **Never the real server or vault, by refusal:** `bin/sgnl-secret` refuses
  the vault for the dev instance and a dev secrets file for any other one;
  `bin/sgnl-dev` refuses any host but the VM's SSH alias (127.0.0.1);
  `bin/sgnl-deploy` refuses a dev instance and fake secrets.
- **No internet for the apps:** containers reach only the VM and each
  other (rejected and logged as `sgnl-dev-noout:`, `journalctl -k`). The VM
  itself still pulls images. To allow a destination: an address or network
  per line in `/etc/sgnl-dev/egress-allow` in the VM, then
  `systemctl restart sgnl-dev-egress`.
- **No mail leaves:** every app's mail goes to Mailpit
  (`https://mailpit.<apps domain>`), and the VM rejects outgoing SMTP
  (25/465/587/2525, IPv4 + IPv6) anyway.
- **Backups** go to Garage inside the VM, not to the real bucket.
- **Own image names** (`sgnl-<app>-dev`): a dev build never carries a tag
  the server uses.
- **No Mac folders** inside the VM.

Not isolated: the VM itself can reach the internet (image downloads), and
its web and mail ports
(80/443/465/993) are open to the local network. Other ports listen on the
Mac only.

## From nothing

Needs on the Mac: Lima (`brew install lima`), Docker Desktop, Kamal 2,
`stalwart-cli` 2.x, Node with `playwright-core` and Google Chrome (for
`seed` and `check`; `PLAYWRIGHT_CORE` points at playwright-core's
`index.mjs`), and the mail server's arm64 base image (below). Times are
with every image already downloaded.

    bin/sgnl-dev up          # VM, CA, secrets (about 1 min)
    bin/sgnl-dev hosts       # prints the /etc/hosts line: add it once (sudo)
    # once per Mac: trust the dev CA (sudo security add-trusted-cert -d
    #   -r trustRoot -k /Library/Keychains/System.keychain ~/.sgnl-dev/ca/rootCA.pem)
    bin/sgnl-dev bootstrap   # every app, configured (about 3 min; idempotent)
    bin/sgnl-dev seed        # alice (admin), bob, eve (no group), two smoke accounts; the git org;
                             # the vault's organisation, bob invited, accepted, confirmed
    bin/sgnl-dev check       # each app in a browser as admin, user and outsider; a document in the office

The mail server's arm64 base image (`STALWART_IMAGE` in
`config/deploy.stalwart.dev.yml`) is built once on the Mac from the
private Stalwart fork and kept in Kamal's local registry, which a
`destroy` doesn't touch. Fat LTO needs more memory than Docker Desktop
has, so a laptop build uses thin LTO (build args in the fork's
`sgnl/Dockerfile`; defaults = the release profile). 30-60 min:

    git -C ../stalwart worktree add /tmp/stalwart-build <tag prod runs>
    cp ../stalwart/sgnl/Dockerfile /tmp/stalwart-build/sgnl/Dockerfile   # if the tag predates the build args
    cd /tmp/stalwart-build && docker buildx build \
      --builder kamal-local-registry-docker-container -f sgnl/Dockerfile --target gnu \
      --platform linux/arm64 --build-arg TARGET=aarch64-unknown-linux-gnu \
      --build-arg RELEASE_LTO=thin --build-arg RELEASE_CODEGEN_UNITS=16 \
      -t localhost:5555/stalwart-sgnl:<tag>-arm64 --push .

(The builder exists once Kamal has built anything with its local registry.)

## Every day

Inside `bin/sgnl-dev` the instance is always `dev`. Any other tool takes
it as usual (`bin/sgnl-id --instance dev show alice`, `bin/sgnl-unlock
--instance dev`): for `dev` it gets the dev secrets file, CA bundle and the
dev vault's own bw data, never the real ones (`lib/instance.py`).


    bin/sgnl-dev kamal deploy -c config/deploy.<app>.yml   # Kamal, -d dev added
    bin/sgnl-dev run bin/<tool> ...                        # any repo tool against dev
    bin/sgnl-dev inbound <file.eml> <from> <rcpt>          # a mail "from outside"
    bin/sgnl-dev check                                     # browser checks, as above
    bin/sgnl-dev smoke tokens; bin/sgnl-dev smoke          # the MCP smoke test (runner from ~/Work/sgnl-mcp)
    bin/sgnl-dev stop | start                              # everything comes back
    bin/sgnl-dev destroy                                   # asks; keeps the CA

Backups run nightly to Garage like on the server; every restore drill
(`bin/sgnl-dev run bin/sgnl-backup-restore-test-all`) passes on dev.

People's passwords and passkeys are in `~/.sgnl-dev/<name>/people/`
(600), vault master passwords and alice's vault API keys in
`<person>.vault.json`. The bw CLI for the dev vault keeps its own data in
`~/.sgnl-dev/<name>/bw` (never the real vault's; `lib/bwsession.py`
refuses a mix). Its session lasts 12 h; `bin/sgnl-dev vault` unlocks it
again. A passkey there is imported with sign count = the current Unix time:
the login server marks a passkey that repeats a count as cloned, for good.

## Outside calls

At runtime the apps make none (beyond image downloads at deploy). An
egress log of a full rebuild plus tests (IPv4; the VM has no IPv6 route)
and a DNS query log found these, all turned off since (2026-11-27; after
that, zero outside lookups across a full restart and tests):

| App | Called | Turned off by |
|---|---|---|
| Mail server | GitHub: its web interface bundle; ~65 MB of ASN/country tables (start + daily) | bundle in the image (`docker/stalwart/Dockerfile`); `Asn` disabled (`stalwart/plan.ndjson`) |
| Login server | time.cloudflare.com (clock check) | `ntp.disable_startup_check` |
| Monitoring (Grafana) | Gravatar (a hash of each person's email); grafana.com plugin downloads | `GF_SECURITY_DISABLE_GRAVATAR`, `GF_PLUGINS_PREINSTALL_DISABLED`, `GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED` |
| Home page (Dashy) | raw.githubusercontent.com (update check) | an empty script mounted over it (`dashy/no-update-check.js`) |
| Office (Collabora) | collabora.co.uk (update check) | `fetch_update_check=0` |

To repeat the check: put `log-queries` into `/etc/dnsmasq.d/` in the VM,
restart dnsmasq and the containers, use the apps, then list the queries
from 172.17/172.18 addresses for names outside `.test`.
