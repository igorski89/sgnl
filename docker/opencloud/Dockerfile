# Passthrough build so Kamal's SHA-tagged push/pull/proxy lifecycle works
# with an unmodified vendor image. 9.1.x is OpenCloud's "Production" line
# (8.x and 9.0/9.2 are Rolling). On a version upgrade, existing configs
# need `opencloud init --diff --insecure no` + the patch applied (the
# ENTRYPOINT's init only writes a config on the first start).
# Reference config: github.com/opencloud-eu/opencloud-compose, branch stable-9.1.
FROM opencloudeu/opencloud:9.1.1
# Same start as the official compose: `init` writes /etc/opencloud/opencloud.yaml
# with random secrets on the first start and fails harmlessly afterwards.
ENTRYPOINT ["/bin/sh", "-c", "opencloud init || true; exec opencloud server"]
