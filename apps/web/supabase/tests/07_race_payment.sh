#!/usr/bin/env bash
#
# Carreras reales sobre el pago: dos sesiones de PostgreSQL de verdad, lanzadas
# a la vez, repetidas varias veces. Sin `sleep`: lo que serializa es el bloqueo
# de fila que toman `confirm_payment_result` y `cancel_job` en el mismo orden.
#
#   R10  dos confirmaciones del MISMO evento al mismo tiempo
#        → una aplicada, una duplicada, un evento, un payout.
#   R11  una confirmación aprobada y una cancelación al mismo tiempo
#        → o bien pagó primero (trabajo PAID, payout, cancelación rechazada),
#          o bien canceló primero (pago en revisión, trabajo CANCELLED, sin
#          payout). Nunca las dos cosas. Nunca ninguna a medias.
#
# Cada repetición monta su propio trabajo. Al final, los invariantes tienen que
# seguir en cero.
#
set -uo pipefail

DB_NAME="${1:?falta el nombre de la base}"
REPETICIONES="${2:-5}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$(mktemp -d)"

fallos=0

# Monta un trabajo con pago en vuelo y deja los ids en test_race.
montar() {
  psql -v ON_ERROR_STOP=1 -tAq -d "$DB_NAME" <<SQL
set client_min_messages = warning;
create table if not exists test_race (key text primary key, value text);
create or replace function pg_temp.montar_pago(p_tag text,
  out job_id uuid, out assignment_id uuid, out payment_id uuid, out client_id uuid, out worker_id uuid)
language plpgsql as \$\$
declare v_offer uuid;
begin
  select w.user_id into worker_id from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select u.id into client_id from auth.users u
   where u.id <> worker_id and exists (select 1 from public.profiles p where p.id = u.id)
   order by u.id limit 1;
  job_id := gen_random_uuid();
  insert into public.jobs (id, client_id, category_id, status, title, description, region_code, commune_code,
    place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate, published_at)
  values (job_id, client_id, (select id from public.job_categories order by sort_order limit 1), 'PUBLISHED',
    'Carrera de pago ' || p_tag, 'Montaje de una carrera entre confirmación y cancelación.', '13', '13-santiago', 'Lugar', now() + interval '2 days',
    120, 'HOLD_PLACE', 9000, now());
  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, worker_id, 9000, 18000, 'oferta') returning id into v_offer;
  perform set_config('request.jwt.claim.sub', client_id::text, true);
  assignment_id := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(assignment_id);
  update public.payments set status = 'CREATED', provider = 'mock-delayed',
    provider_transaction_id = 'mockd-' || p_tag, provider_token = 'mockd-' || p_tag where id = payment_id;
  perform set_config('request.jwt.claim.sub', '', true);
end \$\$;
insert into test_race (key, value)
select 'pay_' || k, v from (
  select 'job' as k, job_id::text as v from pg_temp.montar_pago('$1')
) m
on conflict (key) do update set value = excluded.value;
-- El resto de ids se sacan de la base por el trabajo.
SQL
}

leer() { psql -tAq -d "$DB_NAME" -c "$1"; }

confirmar() {
  psql -tAq -d "$DB_NAME" -c \
    "select public.confirm_payment_result('$1'::uuid, 'mock-delayed', '$2', 'PAID', 18000, '{}'::jsonb) ->> 'outcome'" 2>&1
}

cancelar() {
  psql -tAq -d "$DB_NAME" <<SQL 2>&1
select set_config('request.jwt.claim.sub', '$2', false);
select public.cancel_job('$1'::uuid, 'carrera');
SQL
}

# ---------------------------------------------------------------------------
# R10 · dos confirmaciones del mismo evento a la vez
# ---------------------------------------------------------------------------
ok10=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "r10-$i" >/dev/null
  JOB=$(leer "select value from test_race where key = 'pay_job'")
  PAY=$(leer "select id from payments where job_id = '$JOB'")
  ASG=$(leer "select id from assignments where job_id = '$JOB'")

  confirmar "$PAY" "evt-r10-$i" > "$OUT/a" &
  pa=$!
  confirmar "$PAY" "evt-r10-$i" > "$OUT/b" &
  pb=$!
  wait $pa $pb

  aplicadas=$(cat "$OUT/a" "$OUT/b" | grep -c '^applied$')
  duplicadas=$(cat "$OUT/a" "$OUT/b" | grep -c '^duplicate$')
  eventos=$(leer "select count(*) from payment_events where provider_event_id = 'evt-r10-$i'")
  payouts=$(leer "select count(*) from payouts where assignment_id = '$ASG'")
  estado=$(leer "select status from payments where id = '$PAY'")

  if [ "$aplicadas" = "1" ] && [ "$duplicadas" = "1" ] && [ "$eventos" = "1" ] && [ "$payouts" = "1" ] && [ "$estado" = "PAID" ]; then
    ok10=$((ok10 + 1))
  else
    echo "R10 repetición $i FALLO: aplicadas=$aplicadas duplicadas=$duplicadas eventos=$eventos payouts=$payouts pago=$estado"
    echo "--- A ---"; cat "$OUT/a"; echo "--- B ---"; cat "$OUT/b"
    fallos=$((fallos + 1))
  fi
done
if [ "$ok10" = "$REPETICIONES" ]; then
  echo "R10 OK: $REPETICIONES veces, dos confirmaciones simultáneas del mismo evento dejaron 1 aplicada, 1 duplicada, 1 evento y 1 payout"
fi

# ---------------------------------------------------------------------------
# R11 · confirmación aprobada contra cancelación, a la vez
# ---------------------------------------------------------------------------
ok11=0
gano_pago=0
gano_cancel=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "r11-$i" >/dev/null
  JOB=$(leer "select value from test_race where key = 'pay_job'")
  PAY=$(leer "select id from payments where job_id = '$JOB'")
  ASG=$(leer "select id from assignments where job_id = '$JOB'")
  CLI=$(leer "select client_id from jobs where id = '$JOB'")

  confirmar "$PAY" "evt-r11-$i" > "$OUT/c" &
  pc=$!
  cancelar "$JOB" "$CLI" > "$OUT/d" &
  pd=$!
  wait $pc $pd

  job_st=$(leer "select status from jobs where id = '$JOB'")
  asg_st=$(leer "select status from assignments where id = '$ASG'")
  pay_st=$(leer "select status from payments where id = '$PAY'")
  payouts=$(leer "select count(*) from payouts where assignment_id = '$ASG'")

  if [ "$job_st" = "PAID" ] && [ "$asg_st" = "CONFIRMED" ] && [ "$pay_st" = "PAID" ] && [ "$payouts" = "1" ] && grep -q "reembolso o una disputa" "$OUT/d"; then
    ok11=$((ok11 + 1)); gano_pago=$((gano_pago + 1))
  elif [ "$job_st" = "CANCELLED" ] && [ "$asg_st" = "CANCELLED_BY_CLIENT" ] && [ "$pay_st" = "UNDER_REVIEW" ] && [ "$payouts" = "0" ]; then
    ok11=$((ok11 + 1)); gano_cancel=$((gano_cancel + 1))
  else
    echo "R11 repetición $i FALLO: trabajo=$job_st asignación=$asg_st pago=$pay_st payouts=$payouts"
    echo "--- confirmación ---"; cat "$OUT/c"; echo "--- cancelación ---"; cat "$OUT/d"
    fallos=$((fallos + 1))
  fi
done
if [ "$ok11" = "$REPETICIONES" ]; then
  echo "R11 OK: $REPETICIONES veces, confirmación y cancelación simultáneas terminaron en un estado consistente (ganó el pago $gano_pago, ganó la cancelación $gano_cancel; nunca las dos)"
fi

# ---------------------------------------------------------------------------
# Invariantes tras todas las carreras
# ---------------------------------------------------------------------------
viol=$(leer "select count(*) from app_private.payment_invariant_violations()")
if [ "$viol" = "0" ]; then
  echo "R12 OK: cero violaciones de invariantes tras $((REPETICIONES * 2)) carreras"
else
  echo "R12 FALLO: $viol violaciones de invariantes"
  leer "select rule || ' ' || entity_id from app_private.payment_invariant_violations()"
  fallos=$((fallos + 1))
fi

rm -rf "$OUT"
exit $fallos
