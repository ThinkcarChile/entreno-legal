#!/usr/bin/env bash
#
# Condición de carrera: dos aceptaciones simultáneas sobre el mismo trabajo.
# Debe ganar exactamente una. La otra debe fallar de forma limpia.
#
set -uo pipefail

DB_NAME="${1:?falta el nombre de la base}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -f "$ROOT/supabase/tests/03_race_setup.sql" >/dev/null

CLIENT_ID=$(psql -tAq -d "$DB_NAME" -c "select value from test_race where key = 'job'" >/dev/null; \
            psql -tAq -d "$DB_NAME" -c "select client_id from jobs where id = (select value from test_race where key='job')::uuid")
OFFER_A=$(psql -tAq -d "$DB_NAME" -c "select value from test_race where key = 'offer_a'")
OFFER_B=$(psql -tAq -d "$DB_NAME" -c "select value from test_race where key = 'offer_b'")

accept() {
  psql -tAq -d "$DB_NAME" <<SQL 2>&1
set role authenticated;
set request.jwt.claim.sub = '${CLIENT_ID}';
select accept_job_offer('${1}'::uuid);
SQL
}

# Se lanzan en paralelo, sin barrera explícita: el bloqueo FOR UPDATE sobre la
# fila del trabajo es el que debe serializar.
accept "$OFFER_A" > /tmp/race_a.out &
PID_A=$!
accept "$OFFER_B" > /tmp/race_b.out &
PID_B=$!
wait $PID_A $PID_B

OK_COUNT=$(grep -cE '^[0-9a-f]{8}-' /tmp/race_a.out /tmp/race_b.out 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
ASSIGNMENTS=$(psql -tAq -d "$DB_NAME" -c \
  "select count(*) from assignments where job_id = (select value from test_race where key='job')::uuid")
ACCEPTED=$(psql -tAq -d "$DB_NAME" -c \
  "select count(*) from job_offers where job_id = (select value from test_race where key='job')::uuid and status = 'ACCEPTED'")

if [ "$OK_COUNT" = "1" ] && [ "$ASSIGNMENTS" = "1" ] && [ "$ACCEPTED" = "1" ]; then
  echo "R01 OK: dos aceptaciones simultáneas dejaron 1 asignación y 1 oferta aceptada"
else
  echo "R01 FALLO: aceptaciones exitosas=$OK_COUNT asignaciones=$ASSIGNMENTS aceptadas=$ACCEPTED"
  echo "--- salida A ---"; cat /tmp/race_a.out
  echo "--- salida B ---"; cat /tmp/race_b.out
  exit 1
fi

REJECTED=$(psql -tAq -d "$DB_NAME" -c \
  "select count(*) from job_offers where job_id = (select value from test_race where key='job')::uuid and status = 'REJECTED'")
echo "R02 OK: la oferta no elegida quedó en REJECTED (=$REJECTED)"
