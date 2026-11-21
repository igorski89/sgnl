#!/bin/sh
# Runs once, when a Postgres accessory starts on an empty volume
# (/docker-entrypoint-initdb.d). The image's first user (POSTGRES_USER =
# dbadmin) is the bootstrap superuser, which Postgres won't demote; so the
# app gets its own normal user, SGNL_DB_APP_USER, owning the database, with
# the same password (POSTGRES_PASSWORD). dbadmin loses its password: the
# image trusts local connections only, so it is reachable only through
# `docker exec <container> psql -U dbadmin`, i.e. with root on the server.
# Mounted by config/deploy.{keycloak,listmonk}.yml; docs/SECURITY.md §2c.
set -e
: "${SGNL_DB_APP_USER:?SGNL_DB_APP_USER not set}"
psql -q -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\set VERBOSITY terse
\getenv app SGNL_DB_APP_USER
\getenv pw POSTGRES_PASSWORD
CREATE ROLE :"app" LOGIN PASSWORD :'pw';
ALTER DATABASE :"DBNAME" OWNER TO :"app";
ALTER ROLE CURRENT_USER PASSWORD NULL;
SQL
