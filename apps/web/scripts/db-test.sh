#!/usr/bin/env bash
#
# Verifica el esquema contra un PostgreSQL real: aplica todas las migraciones,
# la semilla geográfica y las baterías de pruebas de RLS y de flujo.
#
# Sale con código distinto de cero si alguna comprobación reporta FALLO, para
# que sirva en integración continua.
#
# Requiere psql y un servidor accesible. Ejemplos:
#   PGHOST=/tmp PGPORT=55432 PGUSER=postgres ./scripts/db-test.sh
#   DATABASE_URL=postgres://... ./scripts/db-test.sh
#
set -uo pipefail

DB_NAME="${DB_NAME:-hagotufila_test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="$(mktemp)"

# Ruido de psql que no aporta a la lectura del informe.
FILTER='^(SET|RESET|INSERT [0-9]|UPDATE [0-9]|DELETE [0-9]|DO|Output format|set_config|[0-9a-f]{8}-[0-9a-f]{4}-)'

run() { psql -v ON_ERROR_STOP=1 -q "$@"; }

fail() { echo "✗ $1"; exit 1; }

echo "→ Recreando base de pruebas $DB_NAME"
psql -q -c "drop database if exists ${DB_NAME};" -c "create database ${DB_NAME};" postgres \
  || fail "no se pudo crear la base de pruebas"

echo "→ Aplicando stub de Supabase (auth, storage, roles, realtime)"
run -d "$DB_NAME" -f "$ROOT/supabase/tests/00_supabase_stub.sql" > /dev/null \
  || fail "falló el stub de Supabase"

echo "→ Aplicando migraciones"
for file in "$ROOT"/supabase/migrations/*.sql; do
  echo "   · $(basename "$file")"
  run -d "$DB_NAME" -f "$file" > /dev/null || fail "falló la migración $(basename "$file")"
done

echo "→ Aplicando semilla geográfica"
run -d "$DB_NAME" -f "$ROOT/supabase/seed/001_geo.sql" > /dev/null \
  || fail "falló la semilla geográfica"

{
  echo ""
  echo "════ Inventario del esquema ════"
  psql -d "$DB_NAME" -f "$ROOT/supabase/tests/05_schema_inventory.sql" 2>&1 \
    | grep -vE "$FILTER" | sed -E 's/^psql:[^ ]+ //; s/^NOTICE:  //'

  echo ""
  echo "════ Etapa 1 · RLS y flujo base ════"
  psql -d "$DB_NAME" -f "$ROOT/supabase/tests/01_rls_and_flow.sql" 2>&1 \
    | grep -vE "$FILTER" | sed -E 's/^psql:[^ ]+ //; s/^NOTICE:  //'

  echo ""
  echo "════ Etapa 2 · Recorrido completo cliente ↔ trabajador ════"
  psql -d "$DB_NAME" -f "$ROOT/supabase/tests/02_stage2_flow.sql" 2>&1 \
    | grep -vE "$FILTER" | sed -E 's/^psql:[^ ]+ //; s/^NOTICE:  //'

  echo ""
  echo "════ Etapa 2 · Condición de carrera al aceptar una oferta ════"
  bash "$ROOT/supabase/tests/03_race_accept.sh" "$DB_NAME"

  echo ""
  echo "════ Semilla de demostración ════"
  # Se aplica después de las pruebas para no alterar sus recuentos.
  psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -f "$ROOT/supabase/seed/002_demo_accounts.sql" \
    > /dev/null 2>&1 || echo "FALLO: no se pudo aplicar 002_demo_accounts.sql"
  psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -f "$ROOT/supabase/seed/003_demo_content.sql" \
    2>&1 | grep -E "ERROR" | sed 's/^/FALLO: /'
  psql -d "$DB_NAME" -f "$ROOT/supabase/tests/04_demo_seed.sql" 2>&1 \
    | grep -vE "$FILTER" | sed -E 's/^psql:[^ ]+ //; s/^NOTICE:  //'

  echo ""
  echo "════ Etapa 2.5 · Las RPC no se pueden rodear ════"
  psql -d "$DB_NAME" -f "$ROOT/supabase/tests/06_rpc_hardening.sql" 2>&1 \
    | grep -vE "$FILTER" | sed -E 's/^psql:[^ ]+ //; s/^NOTICE:  //'

  echo ""
  echo "════ Contrato entre la aplicación y el esquema ════"
  DB_NAME="$DB_NAME" bash "$ROOT/scripts/check-db-contract.sh"
} | tee "$REPORT"

echo ""
if grep -q "FALLO" "$REPORT"; then
  echo "✗ Hay comprobaciones fallidas:"
  grep "FALLO" "$REPORT"
  rm -f "$REPORT"
  exit 1
fi

# El sed de arriba quita el prefijo `psql:…`, así que buscarlo aquí no encontraba
# nunca nada: un fichero de pruebas que reventaba a media ejecución salía en
# verde, solo que con menos comprobaciones de las que debía. Se busca la forma
# que queda DESPUÉS del filtro.
if grep -qE "^ERROR:" "$REPORT"; then
  echo "✗ Hubo errores de SQL inesperados:"
  grep -E "^ERROR:" "$REPORT"
  rm -f "$REPORT"
  exit 1
fi

TOTAL=$(grep -cE "^(T|E|R|S|I|H)[0-9]+" "$REPORT")
echo "✓ $TOTAL comprobaciones pasaron"
rm -f "$REPORT"
