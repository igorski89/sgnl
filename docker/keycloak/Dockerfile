# Keycloak 26.7.5 (2026-09-30). 26.8.x exists (2026-10-10) but is a week
# old; move up once it has a few patch releases.
# `kc.sh build` bakes the build-time options in, so the container starts
# with `start --optimized` (seconds, no re-augmentation on every boot).
FROM quay.io/keycloak/keycloak:26.7.5 AS builder
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=false
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7.5
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]
