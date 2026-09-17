#!/usr/bin/env bash
#
# Verifica el esquema contra un PostgreSQL real: aplica todas las migraciones,
# la semilla geográfica y la batería de pruebas de RLS y flujo.
#
# Requiere psql y un servidor accesible. Ejemplos:
#   PGHOST=/tmp PGPORT=55432 PGUSER=postgres ./scripts/db-test.sh
#   DATABASE_URL=postgres://... ./scripts/db-test.sh
#
set -euo pipefail

DB_NAME="${DB_NAME:-hagotufila_test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run() { psql -v ON_ERROR_STOP=1 -q "$@"; }

echo "→ Recreando base de pruebas $DB_NAME"
psql -q -c "drop database if exists ${DB_NAME};" -c "create database ${DB_NAME};" postgres

echo "→ Aplicando stub de Supabase (auth, storage, roles, realtime)"
run -d "$DB_NAME" -f "$ROOT/supabase/tests/00_supabase_stub.sql"

echo "→ Aplicando migraciones"
for file in "$ROOT"/supabase/migrations/*.sql; do
  echo "   · $(basename "$file")"
  run -d "$DB_NAME" -f "$file"
done

echo "→ Aplicando semilla geográfica"
run -d "$DB_NAME" -f "$ROOT/supabase/seed/001_geo.sql"

echo "→ Ejecutando pruebas de RLS y flujo"
psql -d "$DB_NAME" -f "$ROOT/supabase/tests/01_rls_and_flow.sql" 2>&1 \
  | grep -vE "^(SET|RESET|INSERT [0-9]|UPDATE [0-9]|DO|Output format)" \
  | sed 's/^NOTICE:  //'

echo "→ Listo"
