# Passthrough of our listmonk fork's published image (github.com/igorski89/
# listmonk, releases built and upgrade-tested by its CI, ghcr.io, public),
# so Kamal's SHA-tagged push/pull/proxy lifecycle works. Nothing is built
# here. Pinned release tag (vX.Y.Z-(beta|rc).N-sqlite.M), never `latest`;
# bump deliberately (docs/DEPLOY.md §5a). Same layout as upstream's image
# (WORKDIR /listmonk, port 9000) plus the sqlite3 CLI that
# bin/sgnl-listmonk-setup and the restore drill use.
FROM ghcr.io/igorski89/listmonk:v7.0.0-beta.2-sqlite.6
