# Passthrough build so Kamal's SHA-tagged push/pull/proxy lifecycle works
# with an unmodified vendor image. No app code here. Exact patch tag,
# verified to exist on 2026-10-07 - bump deliberately, never `latest`.
# Image moved from ghcr.io/stalwartlabs/bulwark to bulwarkmail/webmail.
# 1.21.2 since 2026-11-18 (works with Stalwart 0.16 and 1.0, needed for
# the Stalwart 1.x migration; instance/docs/PLAN-upgrades.md).
FROM ghcr.io/bulwarkmail/webmail:1.21.2
