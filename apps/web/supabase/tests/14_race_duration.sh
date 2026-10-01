#!/usr/bin/env bash
#
# Carrera entre aceptar una oferta y cambiar la duración del trabajo.
#
# `accept_job_offer` lee la oferta antes de bloquear la fila del trabajo y toma
# la duración de la fila ya bloqueada. Si `update_open_job` tiene el bloqueo
# —el cliente cambia de 1 a 10 horas—, la aceptación espera con el total de una
# hora en la mano. Antes de …001130 la asignación quedaba con 600 minutos y un
# importe de 10.000: lo que se cobraba. Ahora el importe lo fija la base con la
# tarifa y la duración de la propia asignación.
#
# Sin barrera explícita: la sesión A retiene el bloqueo dos segundos y la B
# llega en medio.
#
set -uo pipefail

DB_NAME="${1:?falta el nombre de la base}"

CLIENT='14d00000-0000-4000-8000-000000000001'
WORKER='14d00000-0000-4000-8000-000000000002'
JOB='14d00000-0000-4000-8000-000000000003'
OFFER='14d00000-0000-4000-8000-000000000004'

psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" >/dev/null <<SQL
insert into auth.users (id, email, raw_user_meta_data) values
 ('${CLIENT}', 'u.carrera.cliente@test.cl', '{"first_name":"Rosa","last_name":"Cid","intent":"CLIENT"}'),
 ('${WORKER}', 'u.carrera.trab@test.cl', '{"first_name":"Raúl","last_name":"Díaz","intent":"WORKER"}');
update worker_profiles
   set verification_status = 'VERIFIED', identity_verified = true, is_accepting_jobs = true
 where user_id = '${WORKER}';
insert into jobs (
  id, client_id, category_id, status, title, description, region_code, commune_code,
  place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate, published_at
) values (
  '${JOB}', '${CLIENT}', (select id from job_categories order by sort_order limit 1), 'PUBLISHED',
  'Fila en el banco del centro de Santiago',
  'Necesito que alguien tome número en el banco y espere el turno hasta que yo llegue.',
  '13', '13-santiago', 'Banco', now() + interval '5 days', 60, 'HOLD_PLACE', 10000, now());
insert into job_private_location (job_id, address_line) values ('${JOB}', 'Bandera 100');
insert into job_offers (id, job_id, worker_id, hourly_rate) values ('${OFFER}', '${JOB}', '${WORKER}', 10000);
SQL

psql -tAq -d "$DB_NAME" > /dev/null 2>&1 <<SQL &
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '${CLIENT}', true);
select public.update_open_job('${JOB}', '{"estimatedDurationMinutes":"600"}'::jsonb);
select pg_sleep(2);
commit;
SQL
PID_A=$!

sleep 0.7
ACCEPT=$(psql -tAq -d "$DB_NAME" 2>&1 <<SQL
set role authenticated;
set request.jwt.claim.sub = '${CLIENT}';
select public.accept_job_offer('${OFFER}');
SQL
)
wait $PID_A

RESULT=$(psql -tAq -d "$DB_NAME" -c \
  "select a.agreed_duration_minutes || ' min · ' || a.agreed_total || ' · ' || s.client_total
     from assignments a join assignment_payment_summary s on s.assignment_id = a.id
    where a.job_id = '${JOB}'")

if [ "$RESULT" = "600 min · 100000 · 100000" ]; then
  echo "U68 aceptar mientras el cliente cambia la duración: se cobra tarifa × duración nueva = $RESULT"
else
  echo "U68 aceptar mientras el cliente cambia la duración = ${RESULT:-sin asignación} FALLO (esperado 600 min · 100000 · 100000)"
  echo "--- salida de la aceptación ---"; echo "$ACCEPT"
fi
