#!/bin/bash
# Runs once, on first initialisation of the Postgres data volume.
#
# The entrypoint has already created $POSTGRES_DB (the Kept database). This
# adds the pgvector extension to it and creates a separate database for
# Langfuse on the same instance.
#
# To re-run this from scratch: `pnpm stack:reset` (drops the volumes).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE DATABASE "${LANGFUSE_DB}" OWNER "${POSTGRES_USER}";
EOSQL

echo "initdb: created database '${LANGFUSE_DB}' and enabled pgvector on '${POSTGRES_DB}'"
