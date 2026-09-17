#!/usr/bin/env bash
#
# Comprueba que lo que la aplicación le pide a la base exista de verdad.
#
# Sin un Supabase en marcha no se puede recorrer la aplicación de punta a punta,
# pero sí se puede verificar lo que más se rompe en una integración así: que el
# nombre de cada tabla, vista y función que usa el código coincida con el
# esquema. Un `rpc("acept_job_offer")` mal escrito no lo detecta TypeScript.
#
# Uso: DB_NAME=hagotufila_test ./scripts/check-db-contract.sh
#
set -uo pipefail

DB_NAME="${DB_NAME:-hagotufila_test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS=0

# Relaciones y funciones que existen en la base de pruebas.
psql -tAq -d "$DB_NAME" -c "
  select table_name from information_schema.tables where table_schema = 'public'
  union
  select table_name from information_schema.views where table_schema = 'public'
" | sort -u > /tmp/db_relations.txt

psql -tAq -d "$DB_NAME" -c "
  select routine_name from information_schema.routines where routine_schema = 'public'
" | sort -u > /tmp/db_functions.txt

# Nombres que usa el código.
grep -rhoE '\.from\("([a-z_]+)"\)' "$ROOT/src" \
  | sed -E 's/\.from\("(.*)"\)/\1/' | sort -u > /tmp/code_relations.txt

grep -rhoE '\.rpc\("([a-z_]+)"' "$ROOT/src" \
  | sed -E 's/\.rpc\("(.*)"/\1/' | sort -u > /tmp/code_functions.txt

echo "→ Relaciones que usa la aplicación: $(wc -l < /tmp/code_relations.txt)"
while read -r rel; do
  [ -z "$rel" ] && continue
  if ! grep -qx "$rel" /tmp/db_relations.txt; then
    echo "FALLO: la aplicación consulta \"$rel\" y no existe en el esquema"
    STATUS=1
  fi
done < /tmp/code_relations.txt

echo "→ Funciones que invoca la aplicación: $(wc -l < /tmp/code_functions.txt)"
while read -r fn; do
  [ -z "$fn" ] && continue
  if ! grep -qx "$fn" /tmp/db_functions.txt; then
    echo "FALLO: la aplicación llama a la función \"$fn\" y no existe en el esquema"
    STATUS=1
  fi
done < /tmp/code_functions.txt

# Columnas usadas en filtros y escrituras frecuentes, comprobadas una a una.
check_column() {
  local table="$1" column="$2"
  local found
  found=$(psql -tAq -d "$DB_NAME" -c \
    "select 1 from information_schema.columns
      where table_schema='public' and table_name='${table}' and column_name='${column}'")
  if [ "$found" != "1" ]; then
    echo "FALLO: la aplicación usa ${table}.${column} y esa columna no existe"
    STATUS=1
  fi
}

echo "→ Columnas críticas"
for pair in \
  "jobs:approx_lat" "jobs:approx_lng" "jobs:suggested_hourly_min" "jobs:offer_count" \
  "job_private_location:address_line" "profiles:onboarding_completed_at" \
  "profiles:commune_code" "profiles:roles" "worker_profiles:verification_status" \
  "worker_profiles:is_accepting_jobs" "job_offers:estimated_arrival_at" \
  "conversations:is_primary" "conversations:offer_id" "payments:provider_token" \
  "assignments:agreed_total" "notifications:read_at" "platform_settings:commission_bps" \
  "assignment_payment_summary:worker_receives" "assignment_payment_summary:commission_bps"
do
  check_column "${pair%%:*}" "${pair##*:}"
done

# La máquina de estados de la asignación vive en dos sitios a propósito: en
# TypeScript, para decidir qué ofrece la interfaz, y en un disparador de la base,
# porque el usuario tiene UPDATE sobre `status` y la interfaz no es una frontera
# de seguridad. Dos copias solo sirven si no se separan.
echo "→ Máquina de estados de la asignación"
CUERPO=$(psql -tAq -d "$DB_NAME" -c \
  "select prosrc from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname = 'guard_assignment_transitions'")
if [ -z "$CUERPO" ]; then
  echo "FALLO: no existe app_private.guard_assignment_transitions en el esquema"
  STATUS=1
elif ! node "$ROOT/scripts/compare-assignment-transitions.mjs" "$CUERPO"; then
  STATUS=1
fi

if [ "$STATUS" = "0" ]; then
  echo "✓ La aplicación y el esquema coinciden"
fi
exit $STATUS
