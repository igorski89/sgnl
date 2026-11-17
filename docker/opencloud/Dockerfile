# Passthrough build so Kamal's SHA-tagged push/pull/proxy lifecycle works
# with an unmodified vendor image. Exact patch tag, verified 2026-10-11:
# 7.2.x is OpenCloud's "production" line (8.x are rolling releases).
# Reference config: github.com/opencloud-eu/opencloud-compose, branch stable-7.2.
FROM opencloudeu/opencloud:7.2.4
# Same start as the official compose: `init` writes /etc/opencloud/opencloud.yaml
# with random secrets on the first start and fails harmlessly afterwards.
ENTRYPOINT ["/bin/sh", "-c", "opencloud init || true; exec opencloud server"]
