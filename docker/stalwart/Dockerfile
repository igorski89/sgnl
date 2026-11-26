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
FROM localhost:5555/stalwart-sgnl:v1.1.1-sgnl.2
