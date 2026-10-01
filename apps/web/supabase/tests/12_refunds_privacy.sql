\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Devoluciones que no se hacen dos veces, y pagos que el trabajador no lee
-- =============================================================================
-- Prefijo D. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Los defectos que cierra esta batería, reproducidos antes de corregirlos:
--
--   · una devolución fallida no se podía reintentar: la misma clave devolvía
--     la fila FAILED;
--   · una segunda devolución parcial del mismo importe «se confirmaba» con la
--     fila de la primera, sin salir dinero;
--   · un banco lento o una red caída dejaba la devolución en FAILED aunque el
--     banco pudo haberla hecho, y el reintento devolvía dos veces;
--   · el trabajador leía por REST la fila del pago del cliente: últimos cuatro
--     dígitos, código de autorización y el resto de lo que contestó Webpay.
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

-- Pagos de esta batería: los invariantes del final miran solo estos.
create temp table d_pagos (id uuid primary key);

-- Trabajo publicado, oferta aceptada e intento en Webpay con token; si se
-- pide, cobrado con los datos de tarjeta que devolvería el commit.
create function pg_temp.montar_cobro(
  p_tag text,
  p_pagado boolean default true,
  out job_id uuid,
  out assignment_id uuid,
  out payment_id uuid,
  out client_id uuid,
  out worker_id uuid,
  out total bigint
)
language plpgsql
as $$
declare
  v_offer uuid;
  v_tag text;
begin
  v_tag := p_tag || '-' || substr(md5(random()::text), 1, 8);

  select w.user_id into worker_id from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  -- Un cliente que no sea administración: si no, las pruebas de lectura
  -- verían todo por el rol y no por ser quien pagó.
  select p.id into client_id from public.profiles p
   where p.id <> worker_id and p.role <> 'ADMIN'
     and exists (select 1 from auth.users u where u.id = p.id)
   order by p.id limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (
    id, client_id, category_id, status, title, description, region_code, commune_code,
    place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at
  ) values (
    job_id, client_id, (select id from public.job_categories order by sort_order limit 1), 'PUBLISHED',
    'Prueba de devoluciones ' || p_tag,
    'Montaje de la prueba de devoluciones y de privacidad del pago.',
    '13', '13-santiago', 'Lugar de prueba', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now()
  );
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, worker_id, 9000, 18000, 'Oferta ' || p_tag)
  returning id into v_offer;

  perform pg_temp.como(client_id);
  assignment_id := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(assignment_id);
  perform pg_temp.como(null);

  perform public.register_payment_attempt(
    payment_id, 'transbank_webpay_plus', 'integration',
    'HTF-' || upper(substr(replace(payment_id::text, '-', ''), 1, 12)) || '-' || upper(substr(md5(v_tag), 1, 9)),
    'S-' || upper(replace(payment_id::text, '-', '')),
    'https://hagotufila.cl/pagos/retorno'
  );
  update public.payments
     set provider_token = 'tok-' || v_tag, provider_transaction_id = 'tok-' || v_tag
   where id = payment_id;

  if p_pagado then
    perform public.confirm_payment_result(
      payment_id, 'transbank_webpay_plus', 'commit:tok-' || v_tag, 'PAID', null,
      jsonb_build_object('authorization_code', '123456', 'card_last_digits', '6623')
    );
  end if;

  select p.amount into total from public.payments p where p.id = payment_id;
  insert into d_pagos values (payment_id);
end;
$$;

-- Pedir una devolución como administración. Devuelve su id o el motivo.
create function pg_temp.pedir(p_payment uuid, p_amount bigint, p_key text)
returns text language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.como(pg_temp.admin_id());
  v := public.request_payment_refund(p_payment, p_amount, 'Devolución de la batería D', p_key, null);
  perform pg_temp.como(null);
  return v::text;
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
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
  return v;
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Una escritura directa, como la haría un guion con la clave de servicio.
create function pg_temp.forzar(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ACEPTADO';
exception when others then
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.resolver_a_mano(p_user uuid, p_refund uuid, p_ok boolean, p_kind text, p_note text)
returns text language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.como(p_user);
  r := public.resolve_unknown_refund(p_refund, p_ok, p_kind, p_note);
  perform pg_temp.como(null);
  return (r ->> 'outcome') || ':' || (r ->> 'refund_status');
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.cola_devoluciones()
returns integer language plpgsql as $$
declare v integer;
begin
  perform pg_temp.como(pg_temp.admin_id());
  v := (public.admin_pending_reviews() ->> 'refunds')::integer;
  perform pg_temp.como(null);
  return v;
end $$;


\echo ''
\echo '--- Una clave por petición, no por importe'

select * from pg_temp.montar_cobro('d1') \gset d1_

select pg_temp.pedir(:'d1_payment_id', 5000, 'refund:d01') as d01_a \gset
select pg_temp.pedir(:'d1_payment_id', 5000, 'refund:d01') as d01_b \gset
select pg_temp.expect('D01 la misma petición dos veces es una sola devolución',
  ((select count(*) from payment_refunds where payment_id = :'d1_payment_id') = 1
   and :'d01_a' = :'d01_b')::text, 'true');

select public.settle_payment_refund(:'d01_a', true, 'NULLIFIED', 5000, '{"response_code":0}') is null as _ \gset

-- El defecto: la segunda, con la clave (pago, importe, disputa), recibía la
-- fila CONFIRMED de la primera.
select pg_temp.pedir(:'d1_payment_id', 5000, 'refund:d02') as d02 \gset
select pg_temp.expect('D02 una segunda devolución parcial del mismo importe es otra devolución',
  (select (r.id::text <> :'d01_a' and r.status = 'REQUESTED')::text
     from payment_refunds r where r.id::text = :'d02'), 'true');

select public.settle_payment_refund(:'d02', true, 'NULLIFIED', 5000, '{"response_code":0}') is null as _ \gset
select pg_temp.expect('D03 salen las dos: devuelto 10000 y pago devuelto en parte',
  (select refunded_amount || ' ' || status from payments where id = :'d1_payment_id'),
  '10000 PARTIALLY_REFUNDED');

select pg_temp.pedir(:'d1_payment_id', 2000, 'refund:d04') as d04 \gset
select pg_temp.expect('D04 reusar la clave de una petición con otro importe es un error',
  pg_temp.pedir(:'d1_payment_id', 3000, 'refund:d04'),
  'RECHAZADO: Esa clave de idempotencia ya se usó para otra devolución');
select pg_temp.expect('D05 la idempotencia va antes que las reglas: repetirla con su devolución en curso no choca',
  (pg_temp.pedir(:'d1_payment_id', 2000, 'refund:d04') = :'d04')::text, 'true');
select pg_temp.expect('D06 una petición distinta con una devolución en curso, rechazada',
  pg_temp.pedir(:'d1_payment_id', 1000, 'refund:d06'),
  'RECHAZADO: Hay una devolución de este pago en curso: espera su resultado antes de pedir otra');

\echo ''
\echo '--- Una devolución rechazada se puede reintentar'

select public.settle_payment_refund(:'d04', false, null, null,
  '{"failure_reason":"provider_http_422","response_code":-1}') is null as _ \gset

select pg_temp.pedir(:'d1_payment_id', :'d1_total'::bigint - 10000, 'refund:d07') as d07 \gset
select pg_temp.expect('D07 rechazada no compromete saldo: se pide otra por todo lo que queda',
  (select status::text from payment_refunds where id::text = :'d07'), 'REQUESTED');
select pg_temp.expect('D08 la rechazada no se reabre',
  (select status::text from payment_refunds where id = :'d04'), 'FAILED');
select pg_temp.expect('D09 repetir la petición rechazada devuelve la rechazada, no la repite',
  (pg_temp.pedir(:'d1_payment_id', 2000, 'refund:d04') = :'d04')::text, 'true');
select pg_temp.expect('D10 con todo comprometido, una más excede el saldo',
  (pg_temp.pedir(:'d1_payment_id', 1, 'refund:d10') like 'RECHAZADO: La devolución excede el saldo%')::text,
  'true');

select public.settle_payment_refund(:'d07', true, 'NULLIFIED', :'d1_total'::bigint - 10000,
  '{"response_code":0}') is null as _ \gset
select pg_temp.expect('D11 confirmada la última, el pago queda devuelto entero',
  (select status::text || ' ' || (refunded_amount = amount)::text from payments where id = :'d1_payment_id'),
  'REFUNDED true');
select pg_temp.expect('D12 y repetir una petición ya confirmada devuelve la misma fila, sin error',
  (pg_temp.pedir(:'d1_payment_id', 5000, 'refund:d01') = :'d01_a')::text, 'true');


\echo ''
\echo '--- El banco no contestó: por confirmar, no fallida'

select * from pg_temp.montar_cobro('d2') \gset d2_
select pg_temp.cola_devoluciones() as d2_cola_antes \gset

select pg_temp.pedir(:'d2_payment_id', 5000, 'refund:d13') as d13 \gset
select pg_temp.expect('D13 la primera llamada reserva el envío',
  public.claim_payment_refund(:'d13')::text, 'true');
select pg_temp.expect('D14 la segunda no: solo una llamada va al banco',
  public.claim_payment_refund(:'d13')::text, 'false');

select public.mark_payment_refund_unknown(:'d13', 'timeout', '{"error_category":"timeout"}') is null as _ \gset
select pg_temp.expect('D15 tiempo agotado: queda UNKNOWN, con motivo y fecha',
  (select status || ' ' || unknown_reason || ' ' || (outcome_unknown_at is not null)::text
     from payment_refunds where id = :'d13'), 'UNKNOWN timeout true');
select pg_temp.expect('D16 por confirmar no devuelve nada todavía',
  (select status || ' ' || refunded_amount from payments where id = :'d2_payment_id'), 'PAID 0');
select pg_temp.expect('D17 con una por confirmar no se pide otra, aunque haya saldo',
  pg_temp.pedir(:'d2_payment_id', 1000, 'refund:d17'),
  'RECHAZADO: Hay una devolución de este pago con resultado por confirmar: hasta saber si el banco la hizo no se puede pedir otra');
select pg_temp.expect('D18 la cola del panel la cuenta',
  (pg_temp.cola_devoluciones() - :'d2_cola_antes'::int)::text, '1');
select pg_temp.expect('D19 y administración la ve en su pago con el motivo',
  pg_temp.como_usuario(pg_temp.admin_id(), format(
    'select open_refund_status || '' '' || open_refund_unknown_reason from public.admin_payments where payment_id = %L',
    :'d2_payment_id')),
  'UNKNOWN timeout');

select pg_temp.expect('D20 recién marcada, la conciliación todavía no la toma',
  (select count(*)::text from public.refunds_pending_reconciliation(10, 200, :'d2_payment_id')), '0');
update payment_refunds
   set requested_at = now() - interval '2 hours', outcome_unknown_at = now() - interval '2 hours'
 where id = :'d13';
select pg_temp.expect('D21 pasado el margen, sí',
  (select count(*)::text from public.refunds_pending_reconciliation(10, 200, :'d2_payment_id')), '1');
-- En dos sentencias: dentro de una sola, la lectura no vería la escritura.
select public.mark_payment_refund_unknown(:'d13', 'too_recent_to_rule_out', '{}') ->> 'outcome' as d22_r \gset
select pg_temp.expect('D22 una consulta que no decide solo se anota',
  :'d22_r' || ' ' || (select status::text || ' ' || last_check_result from payment_refunds where id = :'d13'),
  'checked UNKNOWN too_recent_to_rule_out');
select pg_temp.expect('D23 y la siguiente pasada espera otro margen',
  (select count(*)::text from public.refunds_pending_reconciliation(10, 200, :'d2_payment_id')), '0');

select (public.settle_payment_refund(:'d13', true, 'NULLIFIED', 5000,
  '{"source":"reconcile","provider_status":"PARTIALLY_NULLIFIED"}') ->> 'refund_status') as d24_r \gset
select pg_temp.expect('D24 la conciliación la cierra confirmada desde UNKNOWN y baja el saldo',
  :'d24_r' || ' ' || (select status || ' ' || refunded_amount from payments where id = :'d2_payment_id'),
  'CONFIRMED PARTIALLY_REFUNDED 5000');
select public.mark_payment_refund_unknown(:'d13', 'network', '{}') ->> 'outcome' as d25_r \gset
select pg_temp.expect('D25 marcar por confirmar una ya cerrada no la toca',
  :'d25_r' || ' ' || (select status::text from payment_refunds where id = :'d13'),
  'duplicate CONFIRMED');

-- Otra por confirmar, que la conciliación da por no hecha.
select pg_temp.pedir(:'d2_payment_id', 4000, 'refund:d26') as d26 \gset
select public.claim_payment_refund(:'d26') is null as _ \gset
select public.mark_payment_refund_unknown(:'d26', 'provider_http_502', '{}') is null as _ \gset
select public.settle_payment_refund(:'d26', false, null, null,
  '{"failure_reason":"not_executed_per_status"}') is null as _ \gset
select pg_temp.expect('D26 no hecha según el estado: FAILED, sin tocar lo devuelto',
  (select r.status || ' ' || r.failure_reason || ' ' || p.refunded_amount
     from payment_refunds r join payments p on p.id = r.payment_id where r.id = :'d26'),
  'FAILED not_executed_per_status 5000');
select pg_temp.pedir(:'d2_payment_id', 4000, 'refund:d27') as d27 \gset
select pg_temp.expect('D27 y ya se puede pedir otra',
  (select status::text from payment_refunds where id::text = :'d27'), 'REQUESTED');


\echo ''
\echo '--- La máquina de estados, también para la clave de servicio'

select * from pg_temp.montar_cobro('d3') \gset d3_
select pg_temp.pedir(:'d3_payment_id', 3000, 'refund:d3a') as d3a \gset
select public.settle_payment_refund(:'d3a', false, null, null, '{"failure_reason":"provider_rejected"}') is null as _ \gset
select pg_temp.pedir(:'d3_payment_id', 3000, 'refund:d3b') as d3b \gset
select public.settle_payment_refund(:'d3b', true, 'NULLIFIED', 3000, '{"response_code":0}') is null as _ \gset
select pg_temp.pedir(:'d3_payment_id', 2000, 'refund:d3c') as d3c \gset
select public.mark_payment_refund_unknown(:'d3c', 'network', '{}') is null as _ \gset

select pg_temp.expect('D28 FAILED no vuelve a REQUESTED',
  left(pg_temp.forzar(format('update payment_refunds set status = ''REQUESTED'' where id = %L', :'d3a')), 9),
  'RECHAZADO');
select pg_temp.expect('D29 CONFIRMED no pasa a FAILED',
  left(pg_temp.forzar(format('update payment_refunds set status = ''FAILED'' where id = %L', :'d3b')), 9),
  'RECHAZADO');
select pg_temp.expect('D30 UNKNOWN no vuelve a REQUESTED',
  left(pg_temp.forzar(format('update payment_refunds set status = ''REQUESTED'' where id = %L', :'d3c')), 9),
  'RECHAZADO');
select pg_temp.expect('D31 UNKNOWN no se descarta como CANCELLED',
  left(pg_temp.forzar(format('update payment_refunds set status = ''CANCELLED'' where id = %L', :'d3c')), 9),
  'RECHAZADO');
select pg_temp.expect('D32 una confirmada no cambia de importe',
  left(pg_temp.forzar(format('update payment_refunds set amount = 1 where id = %L', :'d3b')), 9),
  'RECHAZADO');
select pg_temp.expect('D33 ni ninguna cambia de clave',
  left(pg_temp.forzar(format('update payment_refunds set provider_event_id = ''otra'' where id = %L', :'d3a')), 9),
  'RECHAZADO');
select pg_temp.expect('D34 dos abiertas sobre el mismo pago, ni a mano',
  left(pg_temp.forzar(format(
    'insert into payment_refunds (payment_id, amount, reason, provider, environment, provider_event_id, requested_by)
     values (%L, 1, ''Segunda abierta a la fuerza'', ''transbank_webpay_plus'', ''integration'', ''refund:d34'', %L)',
    :'d3_payment_id', pg_temp.admin_id())), 9),
  'RECHAZADO');


\echo ''
\echo '--- Lo devuelto nunca supera lo cobrado'

select * from pg_temp.montar_cobro('d4') \gset d4_
select pg_temp.pedir(:'d4_payment_id', :'d4_total'::bigint - 1000, 'refund:d4a') as d4a \gset
select public.settle_payment_refund(:'d4a', true, 'NULLIFIED', :'d4_total'::bigint - 1000,
  '{"response_code":0}') is null as _ \gset
select pg_temp.pedir(:'d4_payment_id', 1000, 'refund:d4b') as d4b \gset

select pg_temp.expect('D35 UNKNOWN sin motivo, ni a mano',
  left(pg_temp.forzar(format('update payment_refunds set status = ''UNKNOWN'' where id = %L', :'d4b')), 9),
  'RECHAZADO');
select pg_temp.expect('D36 confirmar por encima de lo cobrado se rechaza',
  (pg_temp.forzar(format(
    'select public.settle_payment_refund(%L, true, ''NULLIFIED'', 2000, ''{"response_code":0}'')', :'d4b'))
   like 'RECHAZADO: Confirmar esta devolución dejaría lo devuelto (%) por encima de lo cobrado (%)')::text,
  'true');
select pg_temp.expect('D37 y no toca nada: la devolución sigue pedida y lo devuelto igual',
  (select r.status || ' ' || (p.refunded_amount = p.amount - 1000)::text
     from payment_refunds r join payments p on p.id = r.payment_id where r.id = :'d4b'),
  'REQUESTED true');
select public.settle_payment_refund(:'d4b', true, 'NULLIFIED', 1000, '{"response_code":0}') is null as _ \gset
select pg_temp.expect('D38 la restricción del pago tampoco lo admite escrito a mano',
  left(pg_temp.forzar(format('update payments set refunded_amount = amount + 1 where id = %L', :'d4_payment_id')), 9),
  'RECHAZADO');

create function pg_temp.comprometido_de_mas(p_payment uuid)
returns integer language plpgsql as $$
declare v_n integer;
begin
  begin
    insert into public.payment_refunds (payment_id, amount, reason, provider, environment, provider_event_id, requested_by)
    select p.id, 1, 'Comprometida de más a propósito', p.provider, coalesce(p.environment, 'mock'),
           'refund:d39-' || p.id, pg_temp.admin_id()
      from public.payments p where p.id = p_payment;
    select count(*) into v_n from app_private.refund_invariant_violations()
     where rule = 'refund_committed_over_amount' and entity_id = p_payment;
    raise exception 'deshacer';
  exception when raise_exception then
    null;
  end;
  return v_n;
end $$;

select pg_temp.expect('D39 el invariante delata lo comprometido por encima de lo cobrado',
  pg_temp.comprometido_de_mas(:'d4_payment_id')::text, '1');


\echo ''
\echo '--- Resolverla a mano, con lo que muestra el portal'

select * from pg_temp.montar_cobro('d5') \gset d5_
select pg_temp.pedir(:'d5_payment_id', 4000, 'refund:d5a') as d5a \gset
select public.claim_payment_refund(:'d5a') is null as _ \gset
select public.mark_payment_refund_unknown(:'d5a', 'timeout', '{}') is null as _ \gset

select pg_temp.expect('D40 un usuario común no la resuelve',
  pg_temp.resolver_a_mano(:'d5_client_id', :'d5a', true, 'NULLIFIED', 'El portal muestra la anulación.'),
  'RECHAZADO: Solo la administración resuelve una devolución por confirmar');
select pg_temp.expect('D41 sin decir qué muestra el portal, no',
  left(pg_temp.resolver_a_mano(pg_temp.admin_id(), :'d5a', true, 'NULLIFIED', 'visto'), 9), 'RECHAZADO');
select pg_temp.expect('D42 una parcial no puede ser una reversa',
  (pg_temp.resolver_a_mano(pg_temp.admin_id(), :'d5a', true, 'REVERSED', 'El portal muestra una reversa.')
   like 'RECHAZADO: Una reversa es siempre por el total%')::text, 'true');
select pg_temp.expect('D43 administración la cierra hecha como anulación',
  pg_temp.resolver_a_mano(pg_temp.admin_id(), :'d5a', true, 'NULLIFIED', 'El portal muestra la anulación de 4000.'),
  'applied:CONFIRMED');
select pg_temp.expect('D44 queda quién y por qué, y baja el saldo',
  (select (r.resolved_by = pg_temp.admin_id())::text || ' ' || r.resolution_note || ' ' || p.refunded_amount
     from payment_refunds r join payments p on p.id = r.payment_id where r.id = :'d5a'),
  'true El portal muestra la anulación de 4000. 4000');
select pg_temp.expect('D45 y en la auditoría',
  (select count(*)::text from audit_logs
    where action = 'payment_refund_resolved_manually' and after ->> 'refund_id' = :'d5a'), '1');
select pg_temp.expect('D46 repetirla no es un error ni la cambia',
  pg_temp.resolver_a_mano(pg_temp.admin_id(), :'d5a', false, null, 'Doble clic sobre lo ya resuelto.'),
  'duplicate:CONFIRMED');

select pg_temp.pedir(:'d5_payment_id', 3000, 'refund:d5b') as d5b \gset
select pg_temp.expect('D47 una pedida y en curso no se resuelve a mano',
  pg_temp.resolver_a_mano(pg_temp.admin_id(), :'d5b', false, null, 'El portal no muestra nada aún.'),
  'RECHAZADO: Solo se resuelve a mano una devolución con resultado por confirmar');
select public.claim_payment_refund(:'d5b') is null as _ \gset
select public.mark_payment_refund_unknown(:'d5b', 'network', '{}') is null as _ \gset
select pg_temp.expect('D48 la cierra como no hecha',
  pg_temp.resolver_a_mano(pg_temp.admin_id(), :'d5b', false, null, 'El portal no muestra ninguna anulación de 3000.'),
  'applied:FAILED');
select pg_temp.expect('D49 con su motivo, y lo devuelto no cambia',
  (select r.failure_reason || ' ' || p.refunded_amount
     from payment_refunds r join payments p on p.id = r.payment_id where r.id = :'d5b'),
  'manual_not_executed 4000');


\echo ''
\echo '--- Quién puede llamar a qué'

select pg_temp.expect('D50 reservar, marcar, conciliar y cerrar: solo la clave de servicio',
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'ninguna')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('claim_payment_refund', 'mark_payment_refund_unknown',
                        'refunds_pending_reconciliation', 'settle_payment_refund')
      and (has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('anon', p.oid, 'execute')
        or not has_function_privilege('service_role', p.oid, 'execute'))),
  'ninguna');
select pg_temp.expect('D51 resolver a mano y el estado del pago: con sesión, nunca anónimo',
  (select string_agg(p.proname || ':' || has_function_privilege('authenticated', p.oid, 'execute')
                     || '/' || has_function_privilege('anon', p.oid, 'execute'), ', ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('assignment_payment_states', 'resolve_unknown_refund')),
  'assignment_payment_states:true/false, resolve_unknown_refund:true/false');


\echo ''
\echo '--- El trabajador no lee el pago del cliente'

select * from pg_temp.montar_cobro('d6') \gset d6_
select p.id as d6_tercero from profiles p
 where p.id not in (:'d6_client_id', :'d6_worker_id') and p.role <> 'ADMIN'
   and exists (select 1 from auth.users u where u.id = p.id)
 order by p.id limit 1 \gset

select pg_temp.expect('D52 el trabajador no ve la fila del pago',
  pg_temp.como_usuario(:'d6_worker_id', format(
    'select count(*)::text from public.payments where id = %L', :'d6_payment_id')), '0');
select pg_temp.expect('D53 ni los dígitos de la tarjeta ni la autorización',
  pg_temp.como_usuario(:'d6_worker_id', format(
    'select coalesce((select card_last_digits || authorization_code from public.payments where id = %L), ''sin fila'')',
    :'d6_payment_id')), 'sin fila');
select pg_temp.expect('D54 ni a través de la vista de administración',
  pg_temp.como_usuario(:'d6_worker_id', format(
    'select count(*)::text from public.admin_payments where payment_id = %L', :'d6_payment_id')), '0');
select pg_temp.expect('D55 ni los eventos del pago',
  pg_temp.como_usuario(:'d6_worker_id', format(
    'select count(*)::text from public.payment_events where payment_id = %L', :'d6_payment_id')), '0');
select pg_temp.expect('D56 el desglose lo sigue viendo, sin el estado del pago',
  pg_temp.como_usuario(:'d6_worker_id', format(
    'select (worker_receives > 0)::text || '' '' || coalesce(payment_status::text, ''sin estado'')
       from public.assignment_payment_summary where assignment_id = %L', :'d6_assignment_id')),
  'true sin estado');
select pg_temp.expect('D57 y sabe si está pagado por la función, que es lo que necesita',
  pg_temp.como_usuario(:'d6_worker_id', format(
    'select string_agg(purpose || '':'' || status, '','') from public.assignment_payment_states(array[%L]::uuid[])',
    :'d6_assignment_id')), 'JOB:PAID');
select pg_temp.expect('D58 la función no trae nada del proveedor ni de la tarjeta',
  (select coalesce(string_agg(a, ', '), 'nada')
     from pg_proc p, unnest(p.proargnames) a
    where p.proname = 'assignment_payment_states'
      and a in ('card_last_digits', 'authorization_code', 'provider_transaction_id', 'provider_token',
                'buy_order', 'session_id', 'response_code', 'vci', 'installments', 'payment_type_code')),
  'nada');
select pg_temp.expect('D59 un tercero no obtiene nada de la función',
  pg_temp.como_usuario(:'d6_tercero', format(
    'select count(*)::text from public.assignment_payment_states(array[%L]::uuid[])', :'d6_assignment_id')), '0');

select pg_temp.expect('D60 el cliente sigue leyendo su comprobante',
  pg_temp.como_usuario(:'d6_client_id', format(
    'select card_last_digits || '' '' || authorization_code || '' '' || status from public.payments where id = %L',
    :'d6_payment_id')), '6623 123456 PAID');
select pg_temp.expect('D61 y su pago por la función',
  pg_temp.como_usuario(:'d6_client_id', format(
    'select string_agg(status::text, '','') from public.assignment_payment_states(array[%L]::uuid[])',
    :'d6_assignment_id')), 'PAID');
select pg_temp.expect('D62 pero no provider_transaction_id, que con Webpay es el token',
  (pg_temp.como_usuario(:'d6_client_id', format(
    'select provider_transaction_id from public.payments where id = %L', :'d6_payment_id'))
   like 'RECHAZADO: permission denied%')::text, 'true');
select pg_temp.expect('D63 ninguna sesión tiene esa columna',
  has_column_privilege('authenticated', 'public.payments', 'provider_transaction_id', 'SELECT')::text, 'false');
select pg_temp.expect('D64 administración sigue viendo el pago completo en su vista',
  pg_temp.como_usuario(pg_temp.admin_id(), format(
    'select card_last_digits || '' '' || authorization_code from public.admin_payments where payment_id = %L',
    :'d6_payment_id')), '6623 123456');
select pg_temp.expect('D65 y la fila del pago',
  pg_temp.como_usuario(pg_temp.admin_id(), format(
    'select count(*)::text from public.payments where id = %L', :'d6_payment_id')), '1');


\echo ''
\echo '--- Y los invariantes de esta batería, limpios'

select pg_temp.expect('D66 invariantes de devolución sobre estos pagos',
  (select count(*)::text from app_private.refund_invariant_violations() v
    where v.entity_id in (select id from d_pagos)
       or v.entity_id in (select r.id from payment_refunds r where r.payment_id in (select id from d_pagos))),
  '0');
select pg_temp.expect('D67 invariantes de pago sobre estos pagos',
  (select coalesce(string_agg(v.rule, ', '), 'ninguna') from app_private.payment_invariant_violations() v
    where v.entity_id in (select id from d_pagos)
       or v.entity_id in (select o.id from payouts o where o.payment_id in (select id from d_pagos))),
  'ninguna');
