#!/usr/bin/env bash
#
# Poner un pago en revisión mientras otra sesión registra la transferencia del
# mismo trabajo.
#
# `mark_payout_paid` (y `confirm_payment_result`, `request_payment_refund`,
# `resolve_dispute`…) bloquean trabajo → asignación → pagos. El botón «Poner en
# revisión» de /admin/pagos hacía un UPDATE directo de `payments`: el UPDATE
# toma el pago y la guarda de liquidación, después, el trabajo. Pago → trabajo,
# el orden inverso, y PostgreSQL abortaba una de las dos sesiones por
# interbloqueo. Desde 20260601001720 lo hace `flag_payment_for_review`, que
# bloquea trabajo → asignación → pago → extensión → payout antes de tocar nada.
#
# Sin `sleep` y sin depender de quién llega antes, como 17_race_attempt_lock.sh:
#
#   H  hace lo que hace la transferencia: bloquea el trabajo, avisa con un
#      cerrojo consultivo, espera a ver a B BLOQUEADA y solo entonces pide el
#      pago.
#   B  se anuncia con otro cerrojo consultivo, espera el aviso de H y pone el
#      pago en revisión, como administración.
#
# Con el orden correcto, B se queda esperando el trabajo SIN tener el pago: H
# lo toma, termina, y B sigue. Con el UPDATE directo, B ya tiene el pago cuando
# se queda esperando el trabajo; H pide el pago y PostgreSQL detecta el
# interbloqueo sin falta.
#
# Las esperas activas tienen tope (20 s): si algo no llega a pasar, la prueba
# falla en vez de colgarse.
#
set -uo pipefail

DB_NAME="${1:?falta el nombre de la base}"
OUT="$(mktemp -d)"
KEY_H=1752001
KEY_B=1752002

IDS=$(psql -v ON_ERROR_STOP=1 -tAq -d "$DB_NAME" <<'SQL'
set client_min_messages = warning;
create function pg_temp.montar(out job_id uuid, out payment_id uuid, out admin_id uuid)
language plpgsql as $$
declare
  v_worker uuid;
  v_client uuid;
  v_offer uuid;
  v_assignment uuid;
  v_tag text := substr(md5(random()::text), 1, 10);
begin
  select w.user_id into v_worker from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select p.id into v_client from public.profiles p
   where p.id <> v_worker and p.role <> 'ADMIN'
     and exists (select 1 from auth.users u where u.id = p.id)
   order by p.id limit 1;
  select id into admin_id from public.profiles where role = 'ADMIN' order by id limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (id, client_id, category_id, status, title, description, region_code,
    commune_code, place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at)
  values (job_id, v_client, (select id from public.job_categories order by sort_order limit 1),
    'PUBLISHED', 'Carrera de cerrojos al poner un pago en revisión',
    'Montaje de la carrera entre poner un pago en revisión y registrar la transferencia.',
    '13', '13-santiago', 'Lugar', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now());
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);
  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, v_worker, 9000, 18000, 'Oferta de la carrera de la revisión')
  returning id into v_offer;

  perform set_config('request.jwt.claim.sub', v_client::text, true);
  v_assignment := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(v_assignment);
  perform set_config('request.jwt.claim.sub', '', true);

  update public.payments
     set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-c-race-' || v_tag,
         provider_token = 'tok-c-race-' || v_tag, environment = 'production'
   where id = payment_id;
  perform public.confirm_payment_result(payment_id, 'mock', 'evt-c-race-' || v_tag, 'PAID', null, '{}');
end $$;
select job_id || ' ' || payment_id || ' ' || admin_id from pg_temp.montar();
SQL
)
read -r JOB PAYMENT ADMIN <<< "$IDS"

if [ -z "${JOB:-}" ] || [ -z "${PAYMENT:-}" ] || [ -z "${ADMIN:-}" ]; then
  echo "C52 poner en revisión mientras se registra la transferencia = sin montaje FALLO"
  echo "$IDS"
  exit 0
fi

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
select set_config('request.jwt.claim.sub', '${ADMIN}', false);
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
select public.flag_payment_for_review('${PAYMENT}', 'Carrera de cerrojos de la batería C.') ->> 'outcome';
select pg_advisory_unlock(${KEY_B});
SQL
PID_B=$!

wait $PID_H
wait $PID_B

RESULT=$(psql -tAq -d "$DB_NAME" -c \
  "select p.status || ' ' || coalesce(p.review_reason, '') || ' · ' || coalesce(po.status::text, 'sin payout')
     from payments p left join payouts po on po.payment_id = p.id
    where p.id = '${PAYMENT}'")

if grep -qiE "deadlock|ERROR" "$OUT/h.txt" "$OUT/b.txt"; then
  echo "C52 poner en revisión mientras se registra la transferencia = $(grep -hiE 'deadlock|ERROR' "$OUT/h.txt" "$OUT/b.txt" | head -1) FALLO (esperado sin interbloqueo: UNDER_REVIEW manual_review · HELD)"
elif [ "$RESULT" = "UNDER_REVIEW manual_review · HELD" ]; then
  echo "C52 poner en revisión mientras se registra la transferencia: espera al trabajo sin tener el pago, sin interbloqueo = $RESULT"
else
  echo "C52 poner en revisión mientras se registra la transferencia = ${RESULT:-sin pago} FALLO (esperado UNDER_REVIEW manual_review · HELD)"
  echo "--- sesión H ---"; cat "$OUT/h.txt"
  echo "--- sesión B ---"; cat "$OUT/b.txt"
fi

rm -rf "$OUT"
