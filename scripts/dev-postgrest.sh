#!/usr/bin/env bash
# Start PostgREST against the local Postgres database.
# Requires DATABASE_URL and POSTGREST_JWT_SECRET in .env.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${POSTGREST_JWT_SECRET:?POSTGREST_JWT_SECRET is not set}"

export PGRST_DB_URI="$DATABASE_URL"
export PGRST_JWT_SECRET="$POSTGREST_JWT_SECRET"
export PGRST_DB_SCHEMAS=public
export PGRST_DB_ANON_ROLE=anon
export PGRST_SERVER_HOST="${POSTGREST_HOST:-127.0.0.1}"
export PGRST_SERVER_PORT="${POSTGREST_PORT:-5434}"
export PGRST_LOG_LEVEL="${PGRST_LOG_LEVEL:-info}"

exec postgrest
