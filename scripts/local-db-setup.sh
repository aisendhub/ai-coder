#!/usr/bin/env bash
# Create the local ai-coder database and apply the schema.
# Safe to re-run: migrations are not idempotent, so only run this once per DB.
# Requires DATABASE_URL in .env, e.g.
#   postgresql://gabe@127.0.0.1:5433/ai_coder
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${DATABASE_URL:?DATABASE_URL is not set}"

DB_NAME="${DATABASE_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"
BASE_URL="${DATABASE_URL%/*}/postgres"

echo "==> ensuring database $DB_NAME"
if ! psql "$BASE_URL" -qAtc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1; then
  psql "$BASE_URL" -v ON_ERROR_STOP=1 -c "create database \"$DB_NAME\""
fi

echo "==> auth compatibility (auth.users, auth.uid, roles, publication)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/local-auth-compat.sql

echo "==> migrations"
for f in supabase/migrations/*.sql; do
  echo "    $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> grants"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/local-grants.sql

echo "==> done"
