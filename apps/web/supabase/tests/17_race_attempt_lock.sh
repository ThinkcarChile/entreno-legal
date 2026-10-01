#!/usr/bin/env bash
#
# Registrar un intento de pago mientras otra sesión confirma el mismo pago.
#
# `confirm_payment_result` (y `record_payment_abandonment`, y la conciliación)
# bloquean trabajo → asignación → pago. Antes de 20260601001410,
# `register_payment_attempt` bloqueaba el pago primero y el trabajo después, a
# través de la guarda de liquidación que corre al pasar el pago a CREATED: el
# orden inverso. Un cliente que reintenta mientras la conciliación confirma el
# intento anterior dejaba a las dos sesiones esperándose una a otra hasta que
# PostgreSQL abortaba una por interbloqueo.
#
# Sin `sleep` y sin depender de quién llega antes. Dos sesiones se coordinan
# con cerrojos consultivos y con lo que muestra `pg_locks`:
#
#   H  hace lo que hace la confirmación: bloquea el trabajo, avisa con un
#      cerrojo consultivo, espera a ver a B BLOQUEADA y solo entonces pide el
#      pago.
#   B  se anuncia con otro cerrojo consultivo, espera el aviso de H y registra
#      un intento sobre el mismo pago.
#
# Con el orden corregido, B se queda esperando el trabajo SIN tener el pago: H
# lo toma, termina, y B sigue. Con el orden viejo, B ya tiene el pago cuando se
# queda esperando el trabajo; H pide el pago y PostgreSQL detecta el
# interbloqueo («deadlock detected») sin falta.
#
# Las esperas activas tienen tope (20 s): si algo no llega a pasar, la prueba
# falla en vez de colgarse.
#
set -uo pipefail

DB_NAME="${1:?falta el nombre de la base}"
OUT="$(mktemp -d)"
KEY_H=1741001
KEY_B=1741002

IDS=$(psql -v ON_ERROR_STOP=1 -tAq -d "$DB_NAME" <<'SQL'
set client_min_messages = warning;
create function pg_temp.montar(out job_id uuid, out payment_id uuid)
language plpgsql as $$
declare
  v_worker uuid;
  v_client uuid;
  v_offer uuid;
  v_assignment uuid;
begin
  select w.user_id into v_worker from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select u.id into v_client from auth.users u
   where u.id <> v_worker and exists (select 1 from public.profiles p where p.id = u.id)
   order by u.id limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (id, client_id, category_id, status, title, description, region_code,
    commune_code, place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at)
  values (job_id, v_client, (select id from public.job_categories order by sort_order limit 1),
    'PUBLISHED', 'Carrera de cerrojos al registrar un intento',
    'Montaje de la carrera entre registrar un intento de pago y confirmar el pago.',
    '13', '13-santiago', 'Lugar', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now());
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);
  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, v_worker, 9000, 18000, 'Oferta de la carrera de cerrojos')
  returning id into v_offer;

  perform set_config('request.jwt.claim.sub', v_client::text, true);
  v_assignment := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(v_assignment);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
select job_id || ' ' || payment_id from pg_temp.montar();
SQL
)
JOB="${IDS%% *}"
PAYMENT="${IDS##* }"

if [ -z "$JOB" ] || [ -z "$PAYMENT" ] || [ "$JOB" = "$PAYMENT" ]; then
  echo "J41 registrar un intento mientras se confirma el mismo pago = sin montaje FALLO"
  echo "$IDS"
  exit 0
fi

ORDER="HTF-$(echo "${PAYMENT//-/}" | cut -c1-12 | tr 'a-f' 'A-F')-RACE00001"
SESSION="S-$(echo "${PAYMENT//-/}" | tr 'a-f' 'A-F')"

# Un cerrojo consultivo de ESTA base. Otras bases del mismo servidor pueden
# estar corriendo la misma prueba con las mismas claves.
CERROJO="locktype = 'advisory' and granted
         and database = (select oid from pg_database where datname = current_database())"

psql -tAq -d "$DB_NAME" > "$OUT/h.txt" 2>&1 <<SQL &
begin;
select 1 from public.jobs where id = '${JOB}' for update;
select pg_advisory_xact_lock(${KEY_H});
do \$\$
declare
  v_b integer;
  v_t0 timestamptz := clock_timestamp();
begin
  loop
    select pid into v_b from pg_locks where ${CERROJO} and objid = ${KEY_B} limit 1;
    exit when v_b is not null
          and exists (select 1 from pg_locks where pid = v_b and not granted);
    if clock_timestamp() - v_t0 > interval '20 seconds' then
      raise exception 'B nunca quedó esperando un cerrojo';
    end if;
  end loop;
end \$\$;
select 1 from public.payments where id = '${PAYMENT}' for update;
commit;
SQL
PID_H=$!

psql -tAq -d "$DB_NAME" > "$OUT/b.txt" 2>&1 <<SQL &
select pg_advisory_lock(${KEY_B});
do \$\$
declare
  v_t0 timestamptz := clock_timestamp();
begin
  loop
    exit when exists (select 1 from pg_locks where ${CERROJO} and objid = ${KEY_H});
    if clock_timestamp() - v_t0 > interval '20 seconds' then
      raise exception 'H nunca tomó el trabajo';
    end if;
  end loop;
end \$\$;
select public.register_payment_attempt('${PAYMENT}', 'transbank_webpay_plus', 'integration',
  '${ORDER}', '${SESSION}', 'https://hagotufila.cl/pagos/retorno');
select pg_advisory_unlock(${KEY_B});
SQL
PID_B=$!

wait $PID_H
wait $PID_B

RESULT=$(psql -tAq -d "$DB_NAME" -c \
  "select p.status || ' · ' || count(a.id)
     from payments p left join payment_attempts a on a.payment_id = p.id
    where p.id = '${PAYMENT}' group by p.status")

if grep -qiE "deadlock|ERROR" "$OUT/h.txt" "$OUT/b.txt"; then
  echo "J41 registrar un intento mientras se confirma el mismo pago = $(grep -hiE 'deadlock|ERROR' "$OUT/h.txt" "$OUT/b.txt" | head -1) FALLO (esperado sin interbloqueo: CREATED · 1)"
elif [ "$RESULT" = "CREATED · 1" ]; then
  echo "J41 registrar un intento mientras se confirma el mismo pago: espera al trabajo sin tener el pago, sin interbloqueo = $RESULT"
else
  echo "J41 registrar un intento mientras se confirma el mismo pago = ${RESULT:-sin pago} FALLO (esperado CREATED · 1)"
  echo "--- sesión H ---"; cat "$OUT/h.txt"
  echo "--- sesión B ---"; cat "$OUT/b.txt"
fi

rm -rf "$OUT"
