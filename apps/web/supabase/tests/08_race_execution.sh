#!/usr/bin/env bash
#
# Carreras reales sobre la ejecución del trabajo: dos sesiones de PostgreSQL
# lanzadas a la vez, repetidas. Sin `sleep`: lo que serializa es el bloqueo de
# fila que toman las funciones, siempre en el orden jobs → assignments.
#
#   X10  el cliente acepta y rechaza la MISMA extensión a la vez
#        → una respuesta se aplica, la otra se rechaza. Nunca las dos.
#   X11  dos validaciones del MISMO código de entrega a la vez
#        → una entrega, la otra dice que el código ya se usó. Un solo hito.
#   X12  dos aprobaciones del mismo trabajo a la vez
#        → un solo payout aprobado, un solo hito, una sola fecha de cierre.
#
# Cada repetición monta su propio trabajo. Al final, los invariantes del dinero
# tienen que seguir en cero.
#
set -uo pipefail

DB_NAME="${1:?falta el nombre de la base}"
REPETICIONES="${2:-5}"
OUT="$(mktemp -d)"

fallos=0

# Monta un trabajo en curso y deja los identificadores en test_race.
montar() {
  psql -v ON_ERROR_STOP=1 -tAq -d "$DB_NAME" <<SQL
set client_min_messages = warning;
create table if not exists test_race (key text primary key, value text);

create or replace function pg_temp.montar_exec(p_tag text,
  out job_id uuid, out assignment_id uuid, out client_id uuid, out worker_id uuid)
language plpgsql as \$\$
declare v_offer uuid; v_pay uuid; v_tag text;
begin
  v_tag := p_tag || '-' || substr(md5(random()::text), 1, 6);

  select w.user_id into worker_id from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select u.id into client_id from auth.users u
   where u.id <> worker_id and exists (select 1 from public.profiles p where p.id = u.id)
   order by u.id limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (id, client_id, category_id, status, title, description, region_code,
    commune_code, place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    published_at)
  values (job_id, client_id, (select id from public.job_categories order by sort_order limit 1),
    'PUBLISHED', 'Carrera de ejecución ' || p_tag,
    'Montaje de una carrera entre dos acciones simultáneas del mismo trabajo.',
    '13', '13-santiago', 'Lugar', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000, now());

  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, worker_id, 9000, 18000, 'oferta') returning id into v_offer;

  perform set_config('request.jwt.claim.sub', client_id::text, true);
  assignment_id := public.accept_job_offer(v_offer);
  v_pay := public.start_protected_payment(assignment_id);
  perform set_config('request.jwt.claim.sub', '', true);

  update public.payments set status = 'CREATED', provider = 'mock',
         provider_transaction_id = 'mock-' || v_tag where id = v_pay;
  perform public.confirm_payment_result(v_pay, 'mock', 'evt-' || v_tag, 'PAID', null, '{}');

  perform set_config('request.jwt.claim.sub', worker_id::text, true);
  perform public.mark_on_the_way(assignment_id);
  perform public.register_check_in(assignment_id, true, -33.4265, -70.6153, 15, 'device');
  perform public.start_job_work(assignment_id);
  perform set_config('request.jwt.claim.sub', '', true);
end \$\$;

insert into test_race (key, value)
select k, v from (
  select 'exec_job' as k, job_id::text as v from pg_temp.montar_exec('$1')
) m
on conflict (key) do update set value = excluded.value;
SQL
}

leer() { psql -tAq -d "$DB_NAME" -c "$1"; }

# Ejecuta una llamada como un usuario concreto, en su propia sesión.
como() {
  psql -tAq -d "$DB_NAME" <<SQL 2>&1
select set_config('request.jwt.claim.sub', '$1', false);
$2
SQL
}

# ---------------------------------------------------------------------------
# X10 · aceptar y rechazar la misma extensión a la vez
# ---------------------------------------------------------------------------
ok10=0
gano_si=0
gano_no=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "x10-$i" >/dev/null
  JOB=$(leer "select value from test_race where key = 'exec_job'")
  ASG=$(leer "select id from assignments where job_id = '$JOB'")
  CLI=$(leer "select client_id from jobs where id = '$JOB'")
  WRK=$(leer "select worker_id from assignments where id = '$ASG'")

  EXT=$(como "$WRK" "select public.request_job_extension('$ASG'::uuid, 60, 'carrera');" | tail -1 | tr -d ' ')

  como "$CLI" "select public.answer_job_extension('$EXT'::uuid, true) ->> 'status';" > "$OUT/a" &
  pa=$!
  como "$CLI" "select public.answer_job_extension('$EXT'::uuid, false) ->> 'status';" > "$OUT/b" &
  pb=$!
  wait $pa $pb

  estado=$(leer "select status from job_extensions where id = '$EXT'")
  minutos=$(leer "select extension_minutes from assignments where id = '$ASG'")
  pagos=$(leer "select count(*) from payments where extension_id = '$EXT'")
  errores=$(cat "$OUT/a" "$OUT/b" | grep -c "ya fue respondida")

  esperado_min=0
  [ "$estado" = "ACCEPTED" ] && esperado_min=60

  if [ "$errores" = "1" ] && [ "$minutos" = "$esperado_min" ] \
     && { { [ "$estado" = "ACCEPTED" ] && [ "$pagos" = "1" ]; } || { [ "$estado" = "REJECTED" ] && [ "$pagos" = "0" ]; }; }; then
    ok10=$((ok10 + 1))
    [ "$estado" = "ACCEPTED" ] && gano_si=$((gano_si + 1)) || gano_no=$((gano_no + 1))
  else
    echo "X10 repetición $i FALLO: extensión=$estado minutos=$minutos pagos=$pagos errores=$errores"
    echo "--- A ---"; cat "$OUT/a"; echo "--- B ---"; cat "$OUT/b"
    fallos=$((fallos + 1))
  fi
done
if [ "$ok10" = "$REPETICIONES" ]; then
  echo "X10 OK: $REPETICIONES veces, aceptar y rechazar a la vez dejaron una sola respuesta (ganó aceptar $gano_si, rechazar $gano_no; nunca las dos)"
fi

# ---------------------------------------------------------------------------
# X11 · dos validaciones del mismo código de entrega a la vez
# ---------------------------------------------------------------------------
ok11=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "x11-$i" >/dev/null
  JOB=$(leer "select value from test_race where key = 'exec_job'")
  ASG=$(leer "select id from assignments where job_id = '$JOB'")
  CLI=$(leer "select client_id from jobs where id = '$JOB'")
  WRK=$(leer "select worker_id from assignments where id = '$ASG'")

  CODE=$(como "$CLI" "select public.generate_handoff_code('$ASG'::uuid);" | tail -1 | tr -d ' ')

  como "$WRK" "select public.verify_handoff_code('$ASG'::uuid, '$CODE');" > "$OUT/c" &
  pc=$!
  como "$WRK" "select public.verify_handoff_code('$ASG'::uuid, '$CODE');" > "$OUT/d" &
  pd=$!
  wait $pc $pd

  entregas=$(cat "$OUT/c" "$OUT/d" | grep -c '^t$')
  usados=$(cat "$OUT/c" "$OUT/d" | grep -c "ya se usó")
  hitos=$(leer "select count(*) from job_evidence where assignment_id = '$ASG' and event_key = 'handoff_verified'")
  estado=$(leer "select status from assignments where id = '$ASG'")
  intentos=$(leer "select attempts from handoff_codes where assignment_id = '$ASG'")

  if [ "$entregas" = "1" ] && [ "$usados" = "1" ] && [ "$hitos" = "1" ] \
     && [ "$estado" = "HANDOFF_COMPLETED" ] && [ "$intentos" = "0" ]; then
    ok11=$((ok11 + 1))
  else
    echo "X11 repetición $i FALLO: entregas=$entregas usados=$usados hitos=$hitos estado=$estado intentos=$intentos"
    echo "--- C ---"; cat "$OUT/c"; echo "--- D ---"; cat "$OUT/d"
    fallos=$((fallos + 1))
  fi
done
if [ "$ok11" = "$REPETICIONES" ]; then
  echo "X11 OK: $REPETICIONES veces, dos validaciones simultáneas del mismo código dejaron una entrega, un hito y cero intentos gastados"
fi

# ---------------------------------------------------------------------------
# X12 · dos aprobaciones del mismo trabajo a la vez
# ---------------------------------------------------------------------------
ok12=0
for i in $(seq 1 "$REPETICIONES"); do
  montar "x12-$i" >/dev/null
  JOB=$(leer "select value from test_race where key = 'exec_job'")
  ASG=$(leer "select id from assignments where job_id = '$JOB'")
  CLI=$(leer "select client_id from jobs where id = '$JOB'")
  WRK=$(leer "select worker_id from assignments where id = '$ASG'")

  como "$WRK" "select public.request_job_completion('$ASG'::uuid, null);" >/dev/null

  como "$CLI" "select public.approve_job_completion('$ASG'::uuid, true) ->> 'repeated';" > "$OUT/e" &
  pe=$!
  como "$CLI" "select public.approve_job_completion('$ASG'::uuid, true) ->> 'repeated';" > "$OUT/f" &
  pf=$!
  wait $pe $pf

  primeras=$(cat "$OUT/e" "$OUT/f" | grep -cx "false")
  repetidas=$(cat "$OUT/e" "$OUT/f" | grep -cx "true")
  payouts=$(leer "select count(*) from payouts where assignment_id = '$ASG' and status = 'APPROVED'")
  hitos=$(leer "select count(*) from job_evidence where assignment_id = '$ASG' and event_key = 'completion_approved'")
  estado=$(leer "select status from assignments where id = '$ASG'")

  if [ "$primeras" = "1" ] && [ "$repetidas" = "1" ] && [ "$payouts" = "1" ] \
     && [ "$hitos" = "1" ] && [ "$estado" = "COMPLETED" ]; then
    ok12=$((ok12 + 1))
  else
    echo "X12 repetición $i FALLO: primeras=$primeras repetidas=$repetidas payouts=$payouts hitos=$hitos estado=$estado"
    echo "--- E ---"; cat "$OUT/e"; echo "--- F ---"; cat "$OUT/f"
    fallos=$((fallos + 1))
  fi
done
if [ "$ok12" = "$REPETICIONES" ]; then
  echo "X12 OK: $REPETICIONES veces, dos aprobaciones simultáneas dejaron un payout aprobado y un solo hito"
fi

# ---------------------------------------------------------------------------
# Invariantes tras todas las carreras
# ---------------------------------------------------------------------------
viol=$(leer "select count(*) from app_private.payment_invariant_violations()")
if [ "$viol" = "0" ]; then
  echo "X13 OK: cero violaciones de invariantes tras $((REPETICIONES * 3)) carreras"
else
  echo "X13 FALLO: $viol violaciones de invariantes"
  leer "select rule || ' ' || entity_id from app_private.payment_invariant_violations()"
  fallos=$((fallos + 1))
fi

rm -rf "$OUT"
exit $fallos
