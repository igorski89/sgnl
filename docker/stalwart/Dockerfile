# Passthrough build so Kamal's SHA-tagged push/pull/proxy lifecycle works.
# No app code here.
#
# Since 2026-11-26 the base is OUR Stalwart fork (github.com/igorski89/stalwart,
# tag v1.1.1-sgnl.2 = upstream v1.1.1 + two changes: (1) a machine account with
# sysAccountUpdate may change a person's group memberships and quotas, or a
# group's quotas, without holding all of that account's permissions; every
# other change keeps upstream's full check; (2) such an account may create a PLAIN group (no permissions, roles, aliases); see FORK.md there). It is built
# from the fork's sgnl/Dockerfile with upstream's features (incl. the
# enterprise code, whose licence forbids distributing modified builds), so
# the image is PRIVATE: it lives only in Kamal's local registry
# (localhost:5555), pushed there from the operator's machine:
#   docker tag stalwart-sgnl:v1.1.1-sgnl.2 localhost:5555/stalwart-sgnl:v1.1.1-sgnl.2
#   docker push localhost:5555/stalwart-sgnl:v1.1.1-sgnl.2
# Back to upstream: FROM stalwartlabs/stalwart:v1.1.1 (same data, no migration).
# Dev VMs on the Mac (config/deploy.stalwart.dev.yml) pass the arm64 build.
ARG STALWART_IMAGE=localhost:5555/stalwart-sgnl:v1.1.1-sgnl.2
FROM ${STALWART_IMAGE}
# The web interface (/admin, /account) comes from the image, not from GitHub
# at every start (stalwart/plan.ndjson: Application resourceUrl file://).
# Upstream's "v2" release file, pinned by checksum: a new upstream build
# fails this build until the checksum here is updated (a deliberate update).
# Into an existing dir: --chmod would also give a new parent dir mode 644
# (not enterable).
ADD --chmod=644 --checksum=sha256:2c650f9c155bdb7b4087c0a55dd94f4a211dc0b160f49611cb5ad80383d1b1b7 \
  https://github.com/stalwartlabs/webui/releases/download/v2/webui.zip /usr/local/share/stalwart-webui.zip
