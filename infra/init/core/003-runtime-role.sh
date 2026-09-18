#!/bin/sh
# Creates the server's non-superuser login on a fresh cluster. Grants arrive with the repository migrations.
# Runs once by the postgres image entrypoint; BP_POSTGRES_PASSWORD comes from compose.
set -eu
: "${BP_POSTGRES_PASSWORD:?BP_POSTGRES_PASSWORD must be set and non-empty}"
psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
\getenv pw BP_POSTGRES_PASSWORD
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bp_server') THEN CREATE ROLE bp_server NOLOGIN; END IF;
END $$;
ALTER ROLE bp_server LOGIN PASSWORD :'pw';
SQL
