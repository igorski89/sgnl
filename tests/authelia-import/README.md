# Keycloak -> Authelia import rehearsal (C8)

Synthetic only (realm "test", users alice/bob/carol @example.com, throwaway
passwords and keys); everything runs on the laptop. Proves that passwords,
passkeys and user ids survive the import.

1. Throwaway Keycloak 26.8.2: `docker run -d --name c8-kc -p 127.0.0.1:8180:8080
   -v c8-kc-data:/opt/keycloak/data -e KC_BOOTSTRAP_ADMIN_USERNAME=admin
   -e KC_BOOTSTRAP_ADMIN_PASSWORD=... quay.io/keycloak/keycloak:26.8.2 start-dev`;
   create the realm from `realm.json` (kcadm), set the users' passwords.
2. `kc_register.py`, `kc_register_carol.py` (Playwright): each user registers a
   virtual passkey in Keycloak (carol: resident, backup eligible/state = synced
   like iCloud/Bitwarden) and logs in again; credentials saved to
   ~/.cache/sgnl/c8/passkey-*.json.
3. Export (server stopped): `kc.sh export --realm test --users same_file --file ...`.
4. Authelia (our fork, sgnl.7+), rehearsal config `configuration.yml` (test
   values only; TLS key/cert, JWKS key generated locally into
   ~/.cache/sgnl/c8/rehearsal): `authelia.sh storage migrate up`, then
   `authelia.sh users import keycloak /import/export.json --webauthn-rpid
   id.example.com` (dry run), then with `--apply`; run it on :8443.
5. `rehearse.py`: headless Chrome maps id.example.com to 127.0.0.1 (trusts the
   self-signed cert by SPKI), loads each user's same passkey with rpId
   id.example.com, logs in (Keycloak password + passkey) through an OIDC client,
   exchanges the code and checks: ID token `sub` == Keycloak user id,
   username, email, groups.

Result 2026-11-23 (sgnl.7): dry run = apply = 3 users, 4 groups, 5
memberships, 3 subjects, 3 argon2id passwords, 3 passkeys; all 3 users log
in; carol's backup flags adopted once.
