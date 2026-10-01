#!/usr/bin/env bash
#
# Cerrar una devolución confirmada por el banco mientras otra sesión toma los
# cerrojos del trabajo en el orden canónico.
#
# `request_payment_refund` (desde 20260601001400), `mark_payout_paid`,
# `approve_payout` y `resolve_dispute` bloquean trabajo → asignación → pagos.
# Hasta la sección 4 de 20260601001400, `settle_payment_refund` bloqueaba la
# devolución y el pago, y al escribir el pago la guarda de liquidación pedía el
# trabajo: el orden inverso. Una devolución que el banco ya había hecho se
# quedaba sin registrar porque PostgreSQL abortaba su cierre por interbloqueo.
#
# Sin `sleep`, como 17_race_attempt_lock.sh:
#
#   H  hace lo que hace pedir una devolución sobre la asignación (o registrar
#      la transferencia): bloquea el trabajo, avisa con un cerrojo consultivo,
#      espera a ver a B BLOQUEADA y solo entonces pide el pago.
#   B  se anuncia con otro cerrojo consultivo, espera el aviso de H y cierra la
#      devolución como confirmada.
#
# Con el orden corregido, B espera el trabajo sin tener ni la devolución ni el
# pago: H termina y B registra la devolución. Con el orden viejo, B ya tiene el
# pago cuando pide el trabajo, H pide el pago y PostgreSQL aborta a B.
#
set -uo pipefail

DB_NAME="${1:?falta el nombre de la base}"
OUT="$(mktemp -d)"
KEY_H=1742001
KEY_B=1742002

IDS=$(psql -v ON_ERROR_STOP=1 -tAq -d "$DB_NAME" <<'SQL'
set client_min_messages = warning;
create function pg_temp.montar(out job_id uuid, out payment_id uuid, out refund_id uuid)
language plpgsql as $$
declare
  v_worker uuid;
  v_client uuid;
  v_admin uuid;
  v_offer uuid;
  v_assignment uuid;
  v_tag text;
begin
  select w.user_id into v_worker from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select u.id into v_client from auth.users u
   where u.id <> v_worker
     and exists (select 1 from public.profiles p where p.id = u.id and p.role <> 'ADMIN')
   order by u.id limit 1;
  select id into v_admin from public.profiles where role = 'ADMIN' order by id limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (id, client_id, category_id, status, title, description, region_code,
    commune_code, place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at)
  values (job_id, v_client, (select id from public.job_categories order by sort_order limit 1),
    'PUBLISHED', 'Carrera de cerrojos al cerrar una devolución',
    'Montaje de la carrera entre cerrar una devolución y pedir otra sobre el mismo trabajo.',
    '13', '13-santiago', 'Lugar', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now());
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);
  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, v_worker, 9000, 18000, 'Oferta de la carrera de devoluciones')
  returning id into v_offer;

  perform set_config('request.jwt.claim.sub', v_client::text, true);
  v_assignment := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(v_assignment);
  perform set_config('request.jwt.claim.sub', '', true);

  v_tag := substr(md5(random()::text), 1, 12);
  update public.payments
     set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-race-' || v_tag,
         provider_token = 'tok-race-' || v_tag, environment = 'production'
   where id = payment_id;
  perform public.confirm_payment_result(payment_id, 'mock', 'evt-race-' || v_tag, 'PAID', null, '{}');

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  refund_id := public.request_payment_refund(payment_id, 2000, 'Devolución de la carrera de cerrojos',
    'refund-race-' || v_tag);
  perform set_config('request.jwt.claim.sub', '', true);
  perform public.claim_payment_refund(refund_id);
end $$;
select job_id || ' ' || payment_id || ' ' || refund_id from pg_temp.montar();
SQL
)
read -r JOB PAYMENT REFUND <<< "$IDS"

if [ -z "${JOB:-}" ] || [ -z "${PAYMENT:-}" ] || [ -z "${REFUND:-}" ]; then
  echo "J42 cerrar una devolución mientras otra sesión toma el trabajo = sin montaje FALLO"
  echo "$IDS"
  exit 0
fi

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
select public.settle_payment_refund('${REFUND}', true, 'NULLIFIED', 2000, '{"response_code":0}');
select pg_advisory_unlock(${KEY_B});
SQL
PID_B=$!

wait $PID_H
wait $PID_B

RESULT=$(psql -tAq -d "$DB_NAME" -c \
  "select r.status || ' · ' || p.status || ' ' || p.refunded_amount
     from payment_refunds r join payments p on p.id = r.payment_id
    where r.id = '${REFUND}'")

if grep -qiE "deadlock|ERROR" "$OUT/h.txt" "$OUT/b.txt"; then
  echo "J42 cerrar una devolución mientras otra sesión toma el trabajo = $(grep -hiE 'deadlock|ERROR' "$OUT/h.txt" "$OUT/b.txt" | head -1) FALLO (esperado sin interbloqueo: CONFIRMED · PARTIALLY_REFUNDED 2000)"
elif [ "$RESULT" = "CONFIRMED · PARTIALLY_REFUNDED 2000" ]; then
  echo "J42 cerrar una devolución mientras otra sesión toma el trabajo: espera al trabajo sin tener el pago, sin interbloqueo = $RESULT"
else
  echo "J42 cerrar una devolución mientras otra sesión toma el trabajo = ${RESULT:-sin devolución} FALLO (esperado CONFIRMED · PARTIALLY_REFUNDED 2000)"
  echo "--- sesión H ---"; cat "$OUT/h.txt"
  echo "--- sesión B ---"; cat "$OUT/b.txt"
fi

rm -rf "$OUT"
