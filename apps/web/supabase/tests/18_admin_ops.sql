\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Lo que el panel cuenta y lo que las tareas programadas vigilan
-- =============================================================================
-- Prefijo K. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Los defectos que cierra esta batería, reproducidos antes de corregirlos:
--
--   · `admin_pending_reviews().refunds` contaba dos veces un pago en revisión
--     con una devolución abierta, no contaba un pago con un cobro duplicado
--     (que sí listaba `/admin/pagos?filtro=review`) y contaba disputas que esa
--     lista no mostraba (20260601001510).
--   · Los invariantes del dinero solo los llamaban las pruebas: en producción,
--     una regla rota no la veía nadie (20260601001520).
--
-- Ojo al escribir comprobaciones: una consulta ve los datos como estaban al
-- EMPEZAR la sentencia, y `set_config(..., true)` dura lo que dura la
-- sentencia. Cada acción va en su propia sentencia (con \gset) y la
-- comprobación en la siguiente.
-- =============================================================================

create function pg_temp.expect(label text, actual text, expected text)
returns text language sql as $$
  select label || ' = ' || coalesce(actual, 'NULO') ||
         case when actual is not distinct from expected then ''
              else ' FALLO (esperado ' || coalesce(expected, 'NULO') || ')' end
$$;

create function pg_temp.como(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true)
$$;

create function pg_temp.admin_id()
returns uuid language sql stable as $$
  select id from public.profiles where role = 'ADMIN' order by id limit 1
$$;

create function pg_temp.usuario_id()
returns uuid language sql stable as $$
  select id from public.profiles where role <> 'ADMIN' order by id limit 1
$$;

create function pg_temp.admins()
returns integer language sql stable as $$
  select count(*)::integer from public.profiles where role = 'ADMIN'
$$;

-- Una orden de compra con el formato de la aplicación, nueva cada vez.
create function pg_temp.orden(p_payment uuid)
returns text language sql as $$
  select 'HTF-' || upper(substr(replace(p_payment::text, '-', ''), 1, 12)) || '-'
         || upper(substr(md5(random()::text), 1, 9))
$$;

-- Trabajo con oferta aceptada, pago iniciado y un primer intento en Webpay con
-- su token, como lo deja `startCheckout` (igual que en 13_payment_attempts).
create function pg_temp.montar(
  p_tag text,
  out job_id uuid,
  out assignment_id uuid,
  out payment_id uuid,
  out client_id uuid,
  out token text
)
language plpgsql
as $$
declare
  v_offer uuid;
  v_worker uuid;
  v_orden text;
begin
  select w.user_id into v_worker from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select u.id into client_id from auth.users u
   where u.id <> v_worker and exists (select 1 from public.profiles p where p.id = u.id)
   order by u.id limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (
    id, client_id, category_id, status, title, description, region_code, commune_code,
    place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at
  ) values (
    job_id, client_id, (select id from public.job_categories order by sort_order limit 1), 'PUBLISHED',
    'Prueba del panel ' || p_tag,
    'Montaje de la prueba de las colas del panel y de los invariantes programados.',
    '13', '13-santiago', 'Lugar de prueba', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now()
  );
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, v_worker, 9000, 18000, 'Oferta de prueba ' || p_tag)
  returning id into v_offer;

  perform pg_temp.como(client_id);
  assignment_id := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(assignment_id);
  perform pg_temp.como(null);

  v_orden := pg_temp.orden(payment_id);
  token := 'tok-k-' || p_tag || '-' || substr(md5(random()::text), 1, 12);
  perform public.register_payment_attempt(
    payment_id, 'transbank_webpay_plus', 'integration', v_orden,
    'S-' || upper(replace(payment_id::text, '-', '')), 'https://hagotufila.cl/pagos/retorno');
  perform public.record_payment_attempt_token(
    payment_id, v_orden, token, 'https://webpay3gint.transbank.cl/webpayserver/initTransaction');
end;
$$;

-- El cliente vuelve a pagar: intento nuevo, con su orden y su token.
create function pg_temp.reintentar(p_payment uuid, p_tag text, out token text)
language plpgsql
as $$
declare
  v_orden text := pg_temp.orden(p_payment);
begin
  token := 'tok-k-' || p_tag || '-' || substr(md5(random()::text), 1, 12);
  perform public.register_payment_attempt(
    p_payment, 'transbank_webpay_plus', 'integration', v_orden,
    (select session_id from public.payments where id = p_payment),
    'https://hagotufila.cl/pagos/retorno');
  perform public.record_payment_attempt_token(
    p_payment, v_orden, token, 'https://webpay3gint.transbank.cl/webpayserver/initTransaction');
end;
$$;

-- Lo que hace el retorno con un commit que contestó.
create function pg_temp.confirmar(p_payment uuid, p_token text, p_result text)
returns jsonb language sql as $$
  select public.confirm_payment_result(
    p_payment, 'transbank_webpay_plus', 'commit:' || p_token, p_result, null,
    jsonb_build_object('authorization_code', '123456', 'card_last_digits', '6623'),
    p_token, null)
$$;

-- Pedir una devolución como administración. Devuelve su id o el motivo.
create function pg_temp.pedir(p_payment uuid, p_amount bigint, p_key text, p_dispute uuid)
returns text language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.como(pg_temp.admin_id());
  v := public.request_payment_refund(p_payment, p_amount, 'Devolución de la batería K', p_key, p_dispute);
  perform pg_temp.como(null);
  return v::text;
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.reclamar(p_a uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  perform public.open_dispute(p_a, 'Trabajo no realizado',
    'El trabajador nunca llegó al lugar y la fila no se hizo.');
  perform pg_temp.como(null);
  return 'ABIERTA';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADA: ' || sqlerrm;
end $$;

create function pg_temp.resolver(p_a uuid, p_resolution public.dispute_resolution, p_amount bigint)
returns text language plpgsql as $$
begin
  perform pg_temp.como(pg_temp.admin_id());
  perform public.resolve_dispute(
    (select id from public.disputes where assignment_id = p_a and status in ('OPEN', 'UNDER_REVIEW')),
    p_resolution, 'Resolución de prueba con motivo suficiente.', p_amount);
  perform pg_temp.como(null);
  return 'RESUELTA';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADA: ' || sqlerrm;
end $$;

-- La cifra de la tarjeta «Devoluciones por procesar», como la lee el panel.
create function pg_temp.cifra()
returns integer language plpgsql as $$
declare v integer;
begin
  perform pg_temp.como(pg_temp.admin_id());
  v := (public.admin_pending_reviews() ->> 'refunds')::integer;
  perform pg_temp.como(null);
  return v;
end $$;

-- Lo que lista `/admin/pagos?filtro=review`: filas de la cola, y pagos distintos.
create function pg_temp.lista()
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.como(pg_temp.admin_id());
  select count(*) || ' filas · ' || count(distinct q.payment_id) || ' pagos' into v
    from public.admin_payment_review_queue() q;
  perform pg_temp.como(null);
  return v;
end $$;

-- La fila de un pago en esa lista, con sus motivos. Más de una fila sale
-- separada por « | »; ninguna, «FUERA».
create function pg_temp.fila(p_payment uuid)
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.como(pg_temp.admin_id());
  select string_agg(
           case when q.under_review then 'en revisión' else 'sin revisión' end || ' · ' ||
           case when q.open_refund then 'devolución abierta' else 'sin devolución abierta' end || ' · ' ||
           q.attempts_in_review || ' intentos · ' ||
           case when q.dispute_id is null then 'sin disputa'
                else 'disputa ' || q.dispute_refund_pending end,
           ' | ')
    into v
    from public.admin_payment_review_queue() q
   where q.payment_id = p_payment;
  perform pg_temp.como(null);
  return coalesce(v, 'FUERA');
end $$;

-- Ejecuta una sentencia con la identidad y el rol de un usuario con sesión.
create function pg_temp.como_usuario(p_user uuid, p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.como(p_user);
  set local role authenticated;
  execute p_sql into v;
  reset role;
  perform pg_temp.como(null);
  return coalesce(v, 'NULO');
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'RECHAZADO ' || sqlstate;
end $$;

-- Las reglas rotas que ve el panel, como las lee el resumen.
create function pg_temp.alerta(p_kind text)
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.como(pg_temp.admin_id());
  select string_agg(a.kind || ' · ' || case when a.unacknowledged then 'sin ver' else 'vista' end, ' | ')
    into v
    from public.admin_integrity_alerts() a
   where a.kind = p_kind;
  perform pg_temp.como(null);
  return coalesce(v, 'NINGUNA');
end $$;

create function pg_temp.marcar_vistas()
returns integer language plpgsql as $$
declare v integer;
begin
  perform pg_temp.como(pg_temp.admin_id());
  v := public.acknowledge_integrity_alerts();
  perform pg_temp.como(null);
  return v;
end $$;

-- Avisos INTEGRITY_ALERT de una regla: total y personas distintas.
create function pg_temp.avisos(p_kind text)
returns text language sql as $$
  select count(*) || ' avisos · ' || count(distinct user_id) || ' personas'
    from public.notifications
   where notification_type = 'INTEGRITY_ALERT' and data ->> 'kind' = p_kind
$$;


\echo ''
\echo '--- «Devoluciones por procesar» cuenta pagos, cada uno una vez'

-- Cada caso mide lo que él suma a la cifra: lo que dejaron las baterías
-- anteriores queda fuera de la resta.

-- k1: cobrado, puesto en revisión y con una devolución pedida.
select * from pg_temp.montar('k1') \gset k1_
select pg_temp.confirmar(:'k1_payment_id', :'k1_token', 'PAID') is not null as _ \gset
select pg_temp.cifra() as k1_antes \gset
-- Lo que hace «Poner en revisión» en /admin/pagos.
update payments set status = 'UNDER_REVIEW', review_reason = 'Importe distinto en el portal (K)'
 where id = :'k1_payment_id';
select pg_temp.pedir(:'k1_payment_id', 1000, 'refund:k01:' || :'k1_payment_id', null) as k1_refund \gset

-- El defecto: sumaba 2, uno por estar en revisión y otro por la devolución.
select pg_temp.expect('K01 un pago en revisión con una devolución abierta suma uno a la cifra',
  (pg_temp.cifra() - :k1_antes)::text, '1');
select pg_temp.expect('K02 y sale una sola vez en la lista, con sus dos motivos',
  pg_temp.fila(:'k1_payment_id'), 'en revisión · devolución abierta · 0 intentos · sin disputa');

-- k2: el intento 1 queda en otra pestaña, se paga con el 2 y después aparece
-- autorizado también el 1: cobro duplicado sobre un pago que está bien.
select * from pg_temp.montar('k2') \gset k2_
select * from pg_temp.reintentar(:'k2_payment_id', 'k2b') \gset k2b_
select pg_temp.confirmar(:'k2_payment_id', :'k2b_token', 'PAID') is not null as _ \gset
select pg_temp.cifra() as k2_antes \gset
select pg_temp.confirmar(:'k2_payment_id', :'k2_token', 'PAID') ->> 'decision' as k2_decision \gset

-- El defecto: la lista lo mostraba y la cifra no lo contaba.
select pg_temp.expect('K03 un cobro duplicado sobre un pago cobrado suma uno a la cifra',
  :'k2_decision' || ' · ' || (pg_temp.cifra() - :k2_antes)::text, 'DOUBLE_CHARGE · 1');
select pg_temp.expect('K04 y está en la lista por su intento',
  pg_temp.fila(:'k2_payment_id'), 'sin revisión · sin devolución abierta · 1 intentos · sin disputa');

-- k3: el cliente reclama y gana; la devolución queda por pedir.
select * from pg_temp.montar('k3') \gset k3_
select pg_temp.confirmar(:'k3_payment_id', :'k3_token', 'PAID') is not null as _ \gset
select pg_temp.reclamar(:'k3_assignment_id') as k3_reclamo \gset
select pg_temp.cifra() as k3_antes \gset
select pg_temp.resolver(:'k3_assignment_id', 'CLIENT_WINS', null) as k3_resuelta \gset
select amount as k3_total from payments where id = :'k3_payment_id' \gset
select id as k3_dispute from disputes where assignment_id = :'k3_assignment_id' \gset

-- Antes la cifra la contaba y la lista no la mostraba: ahora es una fila más,
-- la del pago del trabajo, que es a donde lleva el enlace de /admin/disputas.
select pg_temp.expect('K05 la disputa ganada con la devolución sin pedir suma uno, en la fila de su pago',
  :'k3_reclamo' || ' · ' || :'k3_resuelta' || ' · ' || (pg_temp.cifra() - :k3_antes)::text
  || ' · ' || pg_temp.fila(:'k3_payment_id'),
  'ABIERTA · RESUELTA · 1 · sin revisión · sin devolución abierta · 0 intentos · disputa ' || :'k3_total');

select pg_temp.pedir(:'k3_payment_id', :k3_total, 'refund:k03:' || :'k3_payment_id', :'k3_dispute') as k3_refund \gset
select pg_temp.expect('K06 pedida la devolución sigue contando una vez, ahora como devolución abierta',
  (pg_temp.cifra() - :k3_antes)::text || ' · ' || pg_temp.fila(:'k3_payment_id'),
  '1 · sin revisión · devolución abierta · 0 intentos · sin disputa');

select public.settle_payment_refund(:'k3_refund', true, 'NULLIFIED', :k3_total,
  '{"response_code":0}') is null as _ \gset
select pg_temp.expect('K07 confirmada por el banco, sale de la cifra y de la lista',
  (pg_temp.cifra() - :k3_antes)::text || ' · ' || pg_temp.fila(:'k3_payment_id'), '0 · FUERA');

select pg_temp.expect('K08 la cifra es el largo de la lista, y ningún pago se repite',
  pg_temp.cifra() || ' filas · ' || pg_temp.cifra() || ' pagos', pg_temp.lista());

\echo ''
\echo '--- La cola es solo de administración'

select pg_temp.expect('K09 un usuario sin el rol no lee la cola: excepción, no una lista vacía',
  pg_temp.como_usuario(pg_temp.usuario_id(), 'select count(*) from public.admin_payment_review_queue()'),
  'RECHAZADO 42501');
select pg_temp.expect('K10 anon no puede ejecutarla, y su definición interna no la ejecuta nadie con sesión',
  has_function_privilege('anon', 'public.admin_payment_review_queue()', 'execute') || ' · ' ||
  has_function_privilege('authenticated', 'app_private.payment_review_queue()', 'execute') || ' · ' ||
  has_function_privilege('anon', 'app_private.payment_review_queue()', 'execute'),
  'false · false · false');

\echo ''
\echo '--- Los invariantes corren con las tareas programadas'

-- Se parte de cero: las pasadas de la batería 10 pudieron dejar alertas y
-- avisos, y aquí se cuentan los de esta batería.
delete from app_private.integrity_alerts;
delete from notifications where notification_type = 'INTEGRITY_ALERT';

select app_private.run_scheduled_tasks() as k_r0 \gset
select pg_temp.expect('K11 la tarea conserva sus claves y suma «invariantes»',
  (select string_agg(k, ',' order by k) from jsonb_object_keys(:'k_r0'::jsonb) k),
  'aprobados_automaticamente,errores,invariantes,pagos_fuera_de_ventana,trabajos_vencidos');
-- Todas las del catálogo, sin lista fija: una función de invariantes nueva
-- entra sola (K25).
select pg_temp.expect('K12 corre todas las funciones de invariantes del esquema',
  ((:'k_r0'::jsonb -> 'invariantes' -> 'funciones') ? 'payment_invariant_violations'
   and (:'k_r0'::jsonb -> 'invariantes' -> 'funciones') ? 'refund_invariant_violations'
   and jsonb_array_length(:'k_r0'::jsonb -> 'invariantes' -> 'funciones') = (
     select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app_private' and p.proname like '%\_invariant\_violations'
        and p.pronargs = 0))::text, 'true');

-- k4: un cobro al que alguien le escribió lo devuelto a mano, sin devolución
-- confirmada detrás. Se escribe como postgres y sin disparadores: es justo lo
-- que las guardas no dejarían hacer, y lo que el invariante delata.
select * from pg_temp.montar('k4') \gset k4_
select pg_temp.confirmar(:'k4_payment_id', :'k4_token', 'PAID') is not null as _ \gset
set session_replication_role = replica;
update payments set refunded_amount = 1000 where id = :'k4_payment_id';
set session_replication_role = origin;

select app_private.run_scheduled_tasks() as k_r1 \gset
select pg_temp.expect('K13 la pasada encuentra la regla rota, con el pago de ejemplo, sin errores',
  (select count(*)::text
     from jsonb_array_elements(:'k_r1'::jsonb -> 'invariantes' -> 'detalle') d
    where d ->> 'funcion' = 'refund_invariant_violations'
      and d ->> 'regla' = 'refunded_amount_mismatch'
      and d -> 'ejemplos' ? :'k4_payment_id')
  || ' · ' || ((:'k_r1'::jsonb -> 'invariantes' ->> 'violaciones')::integer >= 1)::text
  || ' · ' || (:'k_r1'::jsonb -> 'errores')::text,
  '1 · true · []');
select pg_temp.expect('K14 a cada administrador le llega un aviso',
  pg_temp.avisos('refunded_amount_mismatch'),
  pg_temp.admins() || ' avisos · ' || pg_temp.admins() || ' personas');
select pg_temp.expect('K15 el aviso nombra la regla y lleva al panel',
  (select min(title) || ' · ' || min(href) from notifications
    where notification_type = 'INTEGRITY_ALERT' and data ->> 'kind' = 'refunded_amount_mismatch'),
  'Datos inconsistentes: refunded_amount_mismatch · /admin');

select app_private.run_scheduled_tasks() as k_r2 \gset
select pg_temp.expect('K16 la pasada siguiente, el mismo día, no repite el aviso',
  pg_temp.avisos('refunded_amount_mismatch') || ' · ' || (:'k_r2'::jsonb -> 'invariantes' ->> 'avisos'),
  pg_temp.admins() || ' avisos · ' || pg_temp.admins() || ' personas · 0');

-- Pasa un día con la regla todavía rota.
update app_private.integrity_alerts set last_notified_at = now() - interval '25 hours'
 where kind = 'refunded_amount_mismatch';
select app_private.run_scheduled_tasks() is not null as _ \gset
select pg_temp.expect('K17 al día siguiente, si sigue rota, un aviso más por persona',
  pg_temp.avisos('refunded_amount_mismatch'),
  (2 * pg_temp.admins()) || ' avisos · ' || pg_temp.admins() || ' personas');

\echo ''
\echo '--- La alerta del panel'

select pg_temp.expect('K18 el resumen la ve sin marcar',
  pg_temp.alerta('refunded_amount_mismatch'), 'refunded_amount_mismatch · sin ver');
select pg_temp.expect('K19 un usuario sin el rol no la lee ni la marca',
  pg_temp.como_usuario(pg_temp.usuario_id(), 'select count(*) from public.admin_integrity_alerts()') || ' · ' ||
  pg_temp.como_usuario(pg_temp.usuario_id(), 'select public.acknowledge_integrity_alerts()'),
  'RECHAZADO 42501 · RECHAZADO 42501');

select pg_temp.marcar_vistas() as k_vistas \gset
select pg_temp.expect('K20 marcada como vista: sale de la alerta roja y queda en la auditoría',
  (:k_vistas >= 1)::text || ' · ' || pg_temp.alerta('refunded_amount_mismatch') || ' · ' ||
  (select count(*) from audit_logs l join app_private.integrity_alerts a on a.id = l.entity_id
    where l.action = 'integrity_alert_acknowledged' and a.kind = 'refunded_amount_mismatch')::text,
  'true · refunded_amount_mismatch · vista · 1');

-- k5: otro pago rompe la misma regla.
select * from pg_temp.montar('k5') \gset k5_
select pg_temp.confirmar(:'k5_payment_id', :'k5_token', 'PAID') is not null as _ \gset
set session_replication_role = replica;
update payments set refunded_amount = 500 where id = :'k5_payment_id';
set session_replication_role = origin;
select app_private.run_scheduled_tasks() is not null as _ \gset
select pg_temp.expect('K21 con más casos de la misma regla vuelve a estar sin ver',
  pg_temp.alerta('refunded_amount_mismatch') || ' · ' ||
  (select violation_count from app_private.integrity_alerts where kind = 'refunded_amount_mismatch')::text,
  'refunded_amount_mismatch · sin ver · 2');

\echo ''
\echo '--- Una función de invariantes que falla no se lleva a las demás'

-- La que delata la regla rota falla en esta pasada. Dentro de una transacción
-- que se deshace: al terminar, la función vuelve a ser la de siempre.
begin;
create or replace function app_private.refund_invariant_violations()
returns table (rule text, entity_id uuid)
language plpgsql
as $$
begin
  raise exception 'caída a propósito (batería K)';
end $$;

select app_private.run_scheduled_tasks() as k_r5 \gset

select pg_temp.expect('K22 su error queda en «errores», y las tres tareas de antes corren igual',
  (select count(*)::text from jsonb_array_elements(:'k_r5'::jsonb -> 'errores') e
    where e ->> 'tarea' = 'invariantes:refund_invariant_violations'
      and e ->> 'error' like '%a propósito%')
  || ' · ' || jsonb_typeof(:'k_r5'::jsonb -> 'aprobados_automaticamente')
  || ' · ' || jsonb_typeof(:'k_r5'::jsonb -> 'trabajos_vencidos')
  || ' · ' || jsonb_typeof(:'k_r5'::jsonb -> 'pagos_fuera_de_ventana'),
  '1 · number · number · array');
select pg_temp.expect('K23 las demás funciones de invariantes corren igual',
  ((:'k_r5'::jsonb -> 'invariantes' -> 'funciones') ? 'payment_invariant_violations'
   and not (:'k_r5'::jsonb -> 'invariantes' -> 'funciones') ? 'refund_invariant_violations')::text,
  'true');
-- No se sabe si sigue rota: no se da por resuelta ni se pierde lo que se sabía.
select pg_temp.expect('K24 lo que delataba la que falló no se da por resuelto',
  (select (resolved_at is null)::text || ' · ' || violation_count
     from app_private.integrity_alerts where kind = 'refunded_amount_mismatch'),
  'true · 2');
rollback;

-- Una función de invariantes nueva entra sola, sin tocar la tarea.
begin;
create function app_private.zz_prueba_k_invariant_violations()
returns table (rule text, entity_id uuid)
language sql
as $$
  select 'k_regla_de_prueba'::text, 'b18a0000-0000-4000-8000-000000000001'::uuid
$$;

select app_private.run_scheduled_tasks() as k_r6 \gset

select pg_temp.expect('K25 una función de invariantes nueva corre sin tocar la tarea',
  ((:'k_r6'::jsonb -> 'invariantes' -> 'funciones') ? 'zz_prueba_k_invariant_violations')::text || ' · ' ||
  (select count(*) from jsonb_array_elements(:'k_r6'::jsonb -> 'invariantes' -> 'detalle') d
    where d ->> 'funcion' = 'zz_prueba_k_invariant_violations'
      and d ->> 'regla' = 'k_regla_de_prueba')::text,
  'true · 1');
rollback;

\echo ''
\echo '--- Corregido el dato, la regla se da por resuelta'

set session_replication_role = replica;
update payments set refunded_amount = 0 where id in (:'k4_payment_id', :'k5_payment_id');
set session_replication_role = origin;

select app_private.run_scheduled_tasks() as k_r7 \gset
select pg_temp.expect('K26 la pasada ya no la reporta y el panel ya no la muestra',
  (select count(*) from jsonb_array_elements(:'k_r7'::jsonb -> 'invariantes' -> 'detalle') d
    where d ->> 'regla' = 'refunded_amount_mismatch')::text || ' · ' ||
  pg_temp.alerta('refunded_amount_mismatch') || ' · ' ||
  (select (resolved_at is not null)::text from app_private.integrity_alerts
    where kind = 'refunded_amount_mismatch'),
  '0 · NINGUNA · true');

\echo ''
\echo '--- Nadie con sesión llega a los invariantes por otro camino'

select pg_temp.expect('K27 check_invariants y la tabla de alertas no son de nadie con sesión',
  has_function_privilege('authenticated', 'app_private.check_invariants()', 'execute') || ' · ' ||
  has_function_privilege('anon', 'app_private.check_invariants()', 'execute') || ' · ' ||
  has_table_privilege('authenticated', 'app_private.integrity_alerts', 'select') || ' · ' ||
  has_table_privilege('authenticated', 'app_private.integrity_alerts', 'update'),
  'false · false · false · false');
select pg_temp.expect('K28 anon no lee ni marca las alertas',
  has_function_privilege('anon', 'public.admin_integrity_alerts()', 'execute') || ' · ' ||
  has_function_privilege('anon', 'public.acknowledge_integrity_alerts()', 'execute'),
  'false · false');
