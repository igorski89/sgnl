# Passthrough build so Kamal's SHA-tagged push/pull/proxy lifecycle works
# with an unmodified vendor image. No app code here. Exact patch tag,
# verified to exist on 2026-10-07 - bump deliberately, never `latest`.
# 0.16 renamed the image (mail-server -> stalwart) and dropped config.toml;
# see ../../stalwart/plan.ndjson.
FROM stalwartlabs/stalwart:v0.16.25
