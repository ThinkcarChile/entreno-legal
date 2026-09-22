#!/usr/bin/env bash
#
# Carreras reales sobre pagos y devoluciones: dos sesiones de PostgreSQL
# lanzadas a la vez, repetidas. Sin `sleep`: lo que serializa es el bloqueo de
# fila que toman las funciones, siempre en el orden jobs → assignments →
# payments.
#
#   X20  dos retornos del MISMO token a la vez (el cliente pulsa «atrás» y
#        recarga) → un solo evento, un solo payout, un solo pago confirmado.
#   X21  un retorno que confirma contra otro que registra abandono
#        → el cobro manda: no se pierde dinero cobrado.
#   X22  dos devoluciones simultáneas con la MISMA clave de idempotencia
#        → una sola fila, un solo importe devuelto.
#   X23  dos devoluciones simultáneas que juntas exceden el saldo
#        → una pasa, la otra se rechaza. Nunca se devuelve de más.
#   X24  una devolución contra la aprobación del pago al trabajador
#        → los invariantes aguantan en cualquier orden.
#
# Cada repetición monta su propio pago. Al final, los invariantes del dinero
# —los de pagos y los de devoluciones— tienen que seguir en cero.
#
set -uo pipefail

DB_NAME="${1:?falta el nombre de la base}"
REPETICIONES="${2:-5}"
OUT="$(mktemp -d)"

fallos=0

# Monta un pago con intento registrado y token, listo para confirmar.
montar() {
  psql -v ON_ERROR_STOP=1 -tAq -d "$DB_NAME" <<SQL
set client_min_messages = warning;
create table if not exists test_race_tbk (key text primary key, value text);

create or replace function pg_temp.montar_tbk(p_tag text, p_pagado boolean default false,
  out job_id uuid, out assignment_id uuid, out payment_id uuid,
  out client_id uuid, out worker_id uuid, out admin_id uuid, out token text)
language plpgsql as \$\$
declare v_offer uuid; v_tag text;
begin
  v_tag := p_tag || '-' || substr(md5(random()::text), 1, 8);
  token := 'tok-' || v_tag;

  select w.user_id into worker_id from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select u.id into client_id from auth.users u
   where u.id <> worker_id and exists (select 1 from public.profiles p where p.id = u.id)
   order by u.id limit 1;
  select p.id into admin_id from public.profiles p where p.role = 'ADMIN' limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (id, client_id, category_id, status, title, description, region_code,
    commune_code, place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at)
  values (job_id, client_id, (select id from public.job_categories order by sort_order limit 1),
    'PUBLISHED', 'Carrera Webpay ' || p_tag, 'Montaje de carrera sobre pagos y devoluciones.',
    '13', '13-santiago', 'Lugar', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now());
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, worker_id, 9000, 18000, 'Oferta ' || p_tag) returning id into v_offer;

  perform set_config('request.jwt.claim.sub', client_id::text, true);
  assignment_id := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(assignment_id);
  perform set_config('request.jwt.claim.sub', '', true);

  perform public.register_payment_attempt(payment_id, 'transbank_webpay_plus', 'integration',
    'HTF-' || upper(substr(replace(payment_id::text, '-', ''), 1, 12)) || '-' || upper(substr(md5(v_tag), 1, 9)),
    'S-' || upper(replace(payment_id::text, '-', '')), 'https://hagotufila.cl/pagos/retorno');
  update public.payments set provider_token = token, provider_transaction_id = token
   where id = payment_id;

  if p_pagado then
    perform public.confirm_payment_result(payment_id, 'transbank_webpay_plus',
      'commit:' || token, 'PAID', null, '{}');
  end if;
end \$\$;

delete from test_race_tbk;
insert into test_race_tbk (key, value)
select k, v from (
  select 'payment' as k, payment_id::text as v from pg_temp.montar_tbk('$1', $2)
) m;
SQL
}

leer() { psql -tAq -d "$DB_NAME" -c "$1"; }

como() {
  psql -tAq -d "$DB_NAME" <<SQL 2>&1
select set_config('request.jwt.claim.sub', '$1', false);
$2
SQL
}

sistema() { psql -tAq -d "$DB_NAME" <<SQL 2>&1
$1
SQL
}

# ---------------------------------------------------------------------------
# X20 · dos retornos del mismo token a la vez
# ---------------------------------------------------------------------------
ok20=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "x20-$i" false >/dev/null
  PAY=$(leer "select value from test_race_tbk where key = 'payment'")
  TOK=$(leer "select provider_token from payments where id = '$PAY'")
  ASG=$(leer "select assignment_id from payments where id = '$PAY'")

  sistema "select public.confirm_payment_result('$PAY'::uuid, 'transbank_webpay_plus', 'commit:$TOK', 'PAID', null, '{}') ->> 'outcome';" > "$OUT/a" &
  pa=$!
  sistema "select public.confirm_payment_result('$PAY'::uuid, 'transbank_webpay_plus', 'commit:$TOK', 'PAID', null, '{}') ->> 'outcome';" > "$OUT/b" &
  pb=$!
  wait $pa $pb

  eventos=$(leer "select count(*) from payment_events where payment_id = '$PAY' and provider_event_id = 'commit:$TOK'")
  payouts=$(leer "select count(*) from payouts where assignment_id = '$ASG'")
  estado=$(leer "select status from payments where id = '$PAY'")
  aplicados=$(cat "$OUT/a" "$OUT/b" | grep -c "applied")
  duplicados=$(cat "$OUT/a" "$OUT/b" | grep -c "duplicate")

  if [ "$eventos" = "1" ] && [ "$payouts" = "1" ] && [ "$estado" = "PAID" ] \
     && [ "$aplicados" = "1" ] && [ "$duplicados" = "1" ]; then
    ok20=$((ok20 + 1))
  else
    echo "X20 repetición $i FALLO: eventos=$eventos payouts=$payouts estado=$estado aplicados=$aplicados duplicados=$duplicados"
    cat "$OUT/a" "$OUT/b"
    fallos=$((fallos + 1))
  fi
done
[ "$ok20" = "$REPETICIONES" ] \
  && echo "X20 OK: $REPETICIONES veces, dos retornos del mismo token dejaron un evento, un payout y un pago confirmado" \
  || echo "X20 FALLO"

# ---------------------------------------------------------------------------
# X21 · confirmación contra abandono
# ---------------------------------------------------------------------------
ok21=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "x21-$i" false >/dev/null
  PAY=$(leer "select value from test_race_tbk where key = 'payment'")
  TOK=$(leer "select provider_token from payments where id = '$PAY'")

  sistema "select public.confirm_payment_result('$PAY'::uuid, 'transbank_webpay_plus', 'commit:$TOK', 'PAID', null, '{}') ->> 'payment_status';" > "$OUT/a" &
  pa=$!
  sistema "select public.record_payment_abandonment('$PAY'::uuid, 'transbank_webpay_plus', 'aborted_by_user', '{}') ->> 'outcome';" > "$OUT/b" &
  pb=$!
  wait $pa $pb

  estado=$(leer "select status from payments where id = '$PAY'")
  motivo=$(leer "select coalesce(review_reason,'') from payments where id = '$PAY'")
  payouts=$(leer "select count(*) from payouts where payment_id = '$PAY'")

  # El dinero nunca se pierde. Dos desenlaces son correctos, según el orden:
  #
  #   PAID          la confirmación entró antes que el abandono, o el abandono
  #                 vio el pago ya cobrado y no lo tocó.
  #   UNDER_REVIEW  el abandono lo marcó fallido y la confirmación llegó
  #                 después. La guarda de a30f290 lo detecta como
  #                 «aprobado tras fallar» y lo manda a revisión en vez de
  #                 habilitar el trabajo. Es lo correcto: el cobro ocurrió y
  #                 alguien tiene que mirarlo.
  #
  # Lo que NO puede pasar: que quede FAILED con el cobro hecho, ni que un pago
  # en revisión haya creado pago al trabajador.
  if [ "$estado" = "PAID" ] && [ "$payouts" = "1" ]; then
    ok21=$((ok21 + 1))
  elif [ "$estado" = "UNDER_REVIEW" ] && [ "$payouts" = "0" ] && [ -n "$motivo" ]; then
    ok21=$((ok21 + 1))
  else
    echo "X21 repetición $i FALLO: estado=$estado motivo=$motivo payouts=$payouts"
    cat "$OUT/a" "$OUT/b"
    fallos=$((fallos + 1))
  fi
done
[ "$ok21" = "$REPETICIONES" ] \
  && echo "X21 OK: $REPETICIONES veces, un abandono simultáneo dejó el cobro en PAID o en revisión, nunca perdido" \
  || echo "X21 FALLO"

# ---------------------------------------------------------------------------
# X22 · dos devoluciones con la misma clave de idempotencia
# ---------------------------------------------------------------------------
ok22=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "x22-$i" true >/dev/null
  PAY=$(leer "select value from test_race_tbk where key = 'payment'")
  ADM=$(leer "select id from profiles where role = 'ADMIN' limit 1")

  como "$ADM" "select public.request_payment_refund('$PAY'::uuid, 5000, 'Devolución concurrente idéntica', 'refund:x22-$i');" > "$OUT/a" &
  pa=$!
  como "$ADM" "select public.request_payment_refund('$PAY'::uuid, 5000, 'Devolución concurrente idéntica', 'refund:x22-$i');" > "$OUT/b" &
  pb=$!
  wait $pa $pb

  filas=$(leer "select count(*) from payment_refunds where payment_id = '$PAY'")
  if [ "$filas" = "1" ]; then
    ok22=$((ok22 + 1))
  else
    echo "X22 repetición $i FALLO: $filas devoluciones para la misma clave"
    cat "$OUT/a" "$OUT/b"
    fallos=$((fallos + 1))
  fi
done
[ "$ok22" = "$REPETICIONES" ] \
  && echo "X22 OK: $REPETICIONES veces, la misma clave de idempotencia dejó una sola devolución" \
  || echo "X22 FALLO"

# ---------------------------------------------------------------------------
# X23 · dos devoluciones que juntas exceden el saldo
# ---------------------------------------------------------------------------
ok23=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "x23-$i" true >/dev/null
  PAY=$(leer "select value from test_race_tbk where key = 'payment'")
  ADM=$(leer "select id from profiles where role = 'ADMIN' limit 1")
  TOTAL=$(leer "select amount from payments where id = '$PAY'")

  # Cada una pide el total: juntas son el doble de lo cobrado.
  como "$ADM" "select public.request_payment_refund('$PAY'::uuid, $TOTAL, 'Devolución total simultánea A', 'refund:x23a-$i');" > "$OUT/a" &
  pa=$!
  como "$ADM" "select public.request_payment_refund('$PAY'::uuid, $TOTAL, 'Devolución total simultánea B', 'refund:x23b-$i');" > "$OUT/b" &
  pb=$!
  wait $pa $pb

  filas=$(leer "select count(*) from payment_refunds where payment_id = '$PAY' and status in ('REQUESTED','CONFIRMED')")
  comprometido=$(leer "select coalesce(sum(amount),0) from payment_refunds where payment_id = '$PAY' and status in ('REQUESTED','CONFIRMED')")
  rechazos=$(cat "$OUT/a" "$OUT/b" | grep -c "excede el saldo")

  if [ "$filas" = "1" ] && [ "$comprometido" = "$TOTAL" ] && [ "$rechazos" = "1" ]; then
    ok23=$((ok23 + 1))
  else
    echo "X23 repetición $i FALLO: filas=$filas comprometido=$comprometido total=$TOTAL rechazos=$rechazos"
    cat "$OUT/a" "$OUT/b"
    fallos=$((fallos + 1))
  fi
done
[ "$ok23" = "$REPETICIONES" ] \
  && echo "X23 OK: $REPETICIONES veces, dos devoluciones simultáneas no devolvieron más de lo cobrado" \
  || echo "X23 FALLO"

# ---------------------------------------------------------------------------
# X24 · devolución contra aprobación del pago al trabajador
# ---------------------------------------------------------------------------
ok24=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "x24-$i" true >/dev/null
  PAY=$(leer "select value from test_race_tbk where key = 'payment'")
  ADM=$(leer "select id from profiles where role = 'ADMIN' limit 1")
  POUT=$(leer "select id from payouts where payment_id = '$PAY'")

  como "$ADM" "select public.request_payment_refund('$PAY'::uuid, 5000, 'Devolución contra aprobación', 'refund:x24-$i');" > "$OUT/a" &
  pa=$!
  como "$ADM" "select public.hold_payout('$POUT'::uuid, 'Retenido mientras se devuelve');" > "$OUT/b" &
  pb=$!
  wait $pa $pb

  violaciones=$(leer "select count(*) from app_private.payment_invariant_violations()")
  violaciones_ref=$(leer "select count(*) from app_private.refund_invariant_violations()")

  if [ "$violaciones" = "0" ] && [ "$violaciones_ref" = "0" ]; then
    ok24=$((ok24 + 1))
  else
    echo "X24 repetición $i FALLO: invariantes pago=$violaciones devolución=$violaciones_ref"
    cat "$OUT/a" "$OUT/b"
    fallos=$((fallos + 1))
  fi
done
[ "$ok24" = "$REPETICIONES" ] \
  && echo "X24 OK: $REPETICIONES veces, devolver y retener a la vez dejó los invariantes limpios" \
  || echo "X24 FALLO"

# ---------------------------------------------------------------------------
# X25 · invariantes finales
# ---------------------------------------------------------------------------
v_pago=$(leer "select count(*) from app_private.payment_invariant_violations()")
v_ref=$(leer "select count(*) from app_private.refund_invariant_violations()")
if [ "$v_pago" = "0" ] && [ "$v_ref" = "0" ]; then
  total=$((REPETICIONES * 5))
  echo "X25 OK: cero violaciones de invariantes tras $total carreras"
else
  echo "X25 FALLO: invariantes de pago=$v_pago, de devolución=$v_ref"
  leer "select * from app_private.payment_invariant_violations()"
  leer "select * from app_private.refund_invariant_violations()"
  fallos=$((fallos + 1))
fi

rm -rf "$OUT"
[ "$fallos" = "0" ] || exit 1
