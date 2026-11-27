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
- **No mail leaves:** every app's mail goes to Mailpit
  (`https://mailpit.<apps domain>`), and the VM rejects outgoing SMTP
  (25/465/587/2525, IPv4 + IPv6) anyway.
- **Backups** go to Garage inside the VM, not to the real bucket.
- **Own image names** (`sgnl-<app>-dev`): a dev build never carries a tag
  the server uses.
- **No Mac folders** inside the VM.

Not isolated: the VM can reach the internet (image downloads; a few apps
call out on their own, see "Outside calls"), and its web and mail ports
(80/443/465/993) are open to the local network. Other ports listen on the
Mac only.

## From nothing

    brew install lima
    bin/sgnl-dev up          # VM, CA, secrets (about 1 min)
    bin/sgnl-dev hosts       # prints the /etc/hosts line: add it once (sudo)
    # once per Mac: trust the dev CA (sudo security add-trusted-cert -d
    #   -r trustRoot -k /Library/Keychains/System.keychain ~/.sgnl-dev/ca/rootCA.pem)
    bin/sgnl-dev bootstrap   # every app, configured (about 3 min; idempotent)
    bin/sgnl-dev seed        # alice (admin), bob, two smoke accounts
    bin/sgnl-dev check       # sign in to each app in a browser, open a document

The mail server's arm64 base image is built once on the Mac and kept in
Kamal's local registry (`docker/stalwart/Dockerfile`, `STALWART_IMAGE` in
`config/deploy.stalwart.dev.yml`); a laptop build passes
`--build-arg RELEASE_LTO=thin --build-arg RELEASE_CODEGEN_UNITS=16`.

## Every day

    bin/sgnl-dev kamal deploy -c config/deploy.<app>.yml   # Kamal, -d dev added
    bin/sgnl-dev run bin/<tool> ...                        # any repo tool against dev
    bin/sgnl-dev inbound <file.eml> <from> <rcpt>          # a mail "from outside"
    bin/sgnl-dev stop | start
    bin/sgnl-dev destroy                                   # asks; keeps the CA

People's passwords and passkeys are in `~/.sgnl-dev/<name>/people/`
(600). A passkey there is imported with sign count = the current Unix time:
the login server marks a passkey that repeats a count as cloned, for good.

## Outside calls

Seen in an egress log of a full rebuild plus tests (no call is needed for
the apps to work):

| App | Calls | When |
|---|---|---|
| Mail server | github.com (release assets) | at start |
| Login server | time.cloudflare.com (clock check, warning only) | at start |
| Monitoring (Grafana) | grafana.com; Gravatar for avatars | at start; at sign-in |
| Home page (Dashy) | raw.githubusercontent.com | at start |
| Office (Collabora) | a collabora.co.uk server | now and then |
