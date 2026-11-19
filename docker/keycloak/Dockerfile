# Keycloak 26.8.2 (CVE-2026-96457 fixed in 26.8.2).
# `kc.sh build` bakes the build-time options in, so the container starts
# with `start --optimized` (seconds, no re-augmentation on every boot).
FROM quay.io/keycloak/keycloak:26.8.2 AS builder
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=false
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.8.2
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]
