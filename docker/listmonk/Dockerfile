# syntax=docker/dockerfile:1.7
#
# listmonk with SQLite support, built from the igorski89/listmonk fork
# (branch `sqlite`) at a pinned tag. Self-contained: no build context needed.
#
#   docker buildx build --platform linux/amd64 -t listmonk-sqlite .
#
# Build stages run natively on the build machine ($BUILDPLATFORM); only the
# Go binary is cross-compiled (CGO_ENABLED=0, pure-Go SQLite driver).

ARG LISTMONK_REF=v7.0.0-beta.2-sqlite.3
# The version the binary reports. It decides the migration behaviour: a
# "-beta"/"-rc" pre-release runs pending migrations on every boot without
# recording them (upstream's non-final build path). Keep it equal to the tag.
ARG LISTMONK_VERSION=${LISTMONK_REF}

# ---------------------------------------------------------------- source
FROM --platform=$BUILDPLATFORM alpine:3.22 AS src
ARG LISTMONK_REF
ADD --keep-git-dir=true https://github.com/igorski89/listmonk.git#${LISTMONK_REF} /src

# ---------------------------------------------------------------- frontend
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14-alpine AS frontend
COPY --from=src /src/static/admin /admin
WORKDIR /admin
# The icon sprite (assets/static/icons.svg) is committed; upstream's release
# build regenerates it only when icons.txt changes, from a download of the
# Feather icons master branch. Not regenerated here, so builds are repeatable.
RUN bun install --frozen-lockfile && bun run build

# ---------------------------------------------------------------- binary
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine AS build
ARG LISTMONK_VERSION
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN apk add --no-cache git && go install github.com/knadh/stuffbin/stuffbin@v1.3.0
COPY --from=src /src /src
COPY --from=frontend /admin/dist /src/static/admin/dist
WORKDIR /src
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod \
    COMMIT=$(git rev-parse --short HEAD) && \
    BUILDSTR="${LISTMONK_VERSION} (#${COMMIT} $(date -u +%Y-%m-%dT%H:%M:%S%z), ${TARGETOS}/${TARGETARCH})" && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -o listmonk \
      -ldflags="-s -w -X 'main.buildString=${BUILDSTR}' -X 'main.versionString=${LISTMONK_VERSION}'" ./cmd && \
    stuffbin -a stuff -in listmonk -out listmonk \
      config.toml.sample \
      schema.sql queries:/queries permissions.json \
      static/public:/public \
      static/admin/views:/admin/views \
      static/admin/partials:/admin/partials \
      static/admin/dist:/admin/static \
      static/admin/i18n.txt:/admin/i18n.txt \
      static/email-templates \
      i18n:/i18n

# ---------------------------------------------------------------- runtime
FROM alpine:3.22
# As upstream's image, plus the sqlite CLI for setup and restore scripts.
RUN apk --no-cache add ca-certificates tzdata shadow su-exec sqlite
WORKDIR /listmonk
COPY --from=build /src/listmonk .
COPY --from=build /src/config.toml.sample config.toml
COPY --from=build /src/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 9000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["./listmonk"]
