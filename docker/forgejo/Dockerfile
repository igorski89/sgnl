# Passthrough build so Kamal's SHA-tagged push/pull/proxy lifecycle works
# with an unmodified vendor image. No app code here. Exact patch tag,
# verified to exist on 2026-10-09 - bump deliberately, never `latest`.
# 15.x is the LTS line (16.x reaches end of support 2026-10-29). Rootless:
# runs as git (uid 1000), everything under /var/lib/gitea.
FROM codeberg.org/forgejo/forgejo:15.0.12-rootless
