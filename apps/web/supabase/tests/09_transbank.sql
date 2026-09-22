\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Webpay Plus: intento, retorno sin cobro, devoluciones e idempotencia
-- =============================================================================
-- Lo que se prueba aquí es el lado de la BASE de la integración. Lo que
-- contesta Transbank se prueba contra su ambiente de integración con
-- `npm run verify:transbank`; lo que se prueba aquí es que, diga lo que diga
-- el proveedor, la base no pueda quedar en un estado imposible:
--
--   · que un retorno sin cobro no borre un cobro que sí ocurrió;
--   · que una devolución pedida no cuente como dinero devuelto;
--   · que dos devoluciones no sumen más de lo cobrado;
--   · que repetir cualquiera de las dos cosas no las duplique;
--   · que un usuario común no pueda tocar nada de esto.
-- =============================================================================

-- Reutiliza el montaje de la batería de ejecución.
create or replace function pg_temp.montar_pago(
  p_tag text,
  p_pagado boolean default true,
  out job_id uuid,
  out assignment_id uuid,
  out payment_id uuid,
  out client_id uuid,
  out worker_id uuid,
  out admin_id uuid
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
  select u.id into client_id from auth.users u
   where u.id <> worker_id and exists (select 1 from public.profiles p where p.id = u.id)
   order by u.id limit 1;
  select p.id into admin_id from public.profiles p where p.role = 'ADMIN' limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (
    id, client_id, category_id, status, title, description, region_code, commune_code,
    place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at
  ) values (
    job_id, client_id, (select id from public.job_categories order by sort_order limit 1), 'PUBLISHED',
    'Prueba Webpay ' || p_tag,
    'Montaje de la prueba de integración con la pasarela de pago.',
    '13', '13-santiago', 'Lugar de prueba', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now()
  );
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, worker_id, 9000, 18000, 'Oferta ' || p_tag)
  returning id into v_offer;

  perform set_config('request.jwt.claim.sub', client_id::text, true);
  assignment_id := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(assignment_id);
  perform set_config('request.jwt.claim.sub', '', true);

  -- El intento, tal como lo registraría la aplicación antes de salir a Webpay.
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
end;
$$;

\echo ''
\echo '--- El intento en el proveedor'

-- W01 · Registrar el intento deja el pago listo y con su orden de compra.
do $$
declare m record; p public.payments;
begin
  select * into m from pg_temp.montar_pago('w01', false);
  select * into p from public.payments where id = m.payment_id;
  raise notice '%', 'W01 intento: estado ' || p.status ||
    ', ambiente ' || p.environment ||
    ', orden ' || (case when p.buy_order is null then 'NULA' else 'presente (' || length(p.buy_order) || ')' end) ||
    ', intento ' || p.attempt ||
    (case when p.status = 'CREATED' and p.environment = 'integration'
               and length(p.buy_order) <= 26 and p.attempt = 1
          then '' else ' FALLO' end);
end $$;

-- W02 · Cada intento estrena orden de compra, y la anterior no se reutiliza.
do $$
declare m record; v_first text; v_second text;
begin
  select * into m from pg_temp.montar_pago('w02', false);
  select buy_order into v_first from public.payments where id = m.payment_id;

  perform public.register_payment_attempt(
    m.payment_id, 'transbank_webpay_plus', 'integration',
    'HTF-SEGUNDOINTENTO-XXXXXXXXX', 'S-IGUAL', 'https://hagotufila.cl/pagos/retorno'
  );
  select buy_order into v_second from public.payments where id = m.payment_id;

  raise notice '%', 'W02 reintento: orden cambió ' || (v_first <> v_second) ||
    ', intentos ' || (select attempt from public.payments where id = m.payment_id) ||
    (case when v_first <> v_second
               and (select attempt from public.payments where id = m.payment_id) = 2
          then '' else ' FALLO' end);
end $$;

-- W03 · La orden de compra es única en toda la base.
do $$
declare m1 record; m2 record; v_ok boolean := false;
begin
  select * into m1 from pg_temp.montar_pago('w03a', false);
  select * into m2 from pg_temp.montar_pago('w03b', false);
  begin
    update public.payments set buy_order = (select buy_order from public.payments where id = m1.payment_id)
     where id = m2.payment_id;
  exception when unique_violation then v_ok := true;
  end;
  raise notice '%', 'W03 orden de compra única: rechazado ' || v_ok ||
    (case when v_ok then '' else ' FALLO' end);
end $$;

-- W04 · Un pago de integración no admite un intento en producción.
do $$
declare m record; v_ok boolean := false;
begin
  select * into m from pg_temp.montar_pago('w04', false);
  begin
    perform public.register_payment_attempt(
      m.payment_id, 'transbank_webpay_plus', 'production',
      'HTF-PRODUCCION12-XXXXXXXXX', 'S-PROD', 'https://hagotufila.cl/pagos/retorno'
    );
  exception when check_violation then v_ok := true;
  end;
  raise notice '%', 'W04 no se mezclan ambientes: rechazado ' || v_ok ||
    (case when v_ok then '' else ' FALLO' end);
end $$;

\echo ''
\echo '--- Retorno sin cobro'

-- W05 · Abandono y tiempo agotado dejan el pago fallido y reintentable.
do $$
declare m record; r jsonb; p public.payments;
begin
  select * into m from pg_temp.montar_pago('w05', false);
  r := public.record_payment_abandonment(m.payment_id, 'transbank_webpay_plus', 'aborted_by_user', '{}');
  select * into p from public.payments where id = m.payment_id;
  raise notice '%', 'W05 abandono: ' || (r ->> 'outcome') || ', estado ' || p.status ||
    ', motivo ' || coalesce(p.failure_reason, 'NULO') ||
    (case when p.status = 'FAILED' and p.failure_reason = 'aborted_by_user' then '' else ' FALLO' end);
end $$;

-- W06 · Un retorno abortado NO borra un cobro que ya ocurrió.
--
-- Es el escenario que más daño haría: el cliente pagó, vuelve tarde por un
-- enlace antiguo con TBK_TOKEN, y el pago desaparece.
do $$
declare m record; r jsonb; p public.payments;
begin
  select * into m from pg_temp.montar_pago('w06', true);
  r := public.record_payment_abandonment(m.payment_id, 'transbank_webpay_plus', 'aborted_by_user', '{}');
  select * into p from public.payments where id = m.payment_id;
  raise notice '%', 'W06 abandono tardío sobre pago cobrado: ' || (r ->> 'outcome') ||
    ', sigue en ' || p.status ||
    (case when (r ->> 'outcome') = 'ignored' and p.status = 'PAID' then '' else ' FALLO' end);
end $$;

-- W07 · El mismo evento de confirmación repetido se registra una sola vez.
do $$
declare m record; v_tag text; r1 jsonb; r2 jsonb; v_eventos int; v_payouts int;
begin
  select * into m from pg_temp.montar_pago('w07', false);
  select replace(provider_token, 'tok-', '') into v_tag from public.payments where id = m.payment_id;

  r1 := public.confirm_payment_result(m.payment_id, 'transbank_webpay_plus',
        'commit:tok-' || v_tag, 'PAID', null, '{}');
  r2 := public.confirm_payment_result(m.payment_id, 'transbank_webpay_plus',
        'commit:tok-' || v_tag, 'PAID', null, '{}');

  select count(*) into v_eventos from public.payment_events
   where payment_id = m.payment_id and provider_event_id = 'commit:tok-' || v_tag;
  select count(*) into v_payouts from public.payouts where assignment_id = m.assignment_id;

  raise notice '%', 'W07 confirmación repetida: ' || (r1 ->> 'outcome') || ' y ' || (r2 ->> 'outcome') ||
    ', eventos ' || v_eventos || ', payouts ' || v_payouts ||
    (case when (r1 ->> 'outcome') = 'applied' and (r2 ->> 'outcome') = 'duplicate'
               and v_eventos = 1 and v_payouts = 1
          then '' else ' FALLO' end);
end $$;

\echo ''
\echo '--- Devoluciones'

-- W08 · Un usuario común no puede pedir una devolución.
do $$
declare m record; v_ok boolean := false;
begin
  select * into m from pg_temp.montar_pago('w08', true);
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  begin
    perform public.request_payment_refund(m.payment_id, 1000, 'Quiero mi dinero de vuelta', 'refund:w08');
  exception when insufficient_privilege then v_ok := true;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '%', 'W08 el cliente no devuelve: rechazado ' || v_ok ||
    (case when v_ok then '' else ' FALLO' end);
end $$;

-- W09 · El trabajador tampoco.
do $$
declare m record; v_ok boolean := false;
begin
  select * into m from pg_temp.montar_pago('w09', true);
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  begin
    perform public.request_payment_refund(m.payment_id, 1000, 'Devolución no autorizada', 'refund:w09');
  exception when insufficient_privilege then v_ok := true;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '%', 'W09 el trabajador no devuelve: rechazado ' || v_ok ||
    (case when v_ok then '' else ' FALLO' end);
end $$;

-- W10 · Pedir una devolución NO devuelve dinero.
do $$
declare m record; v_refund uuid; p public.payments; r public.payment_refunds;
begin
  select * into m from pg_temp.montar_pago('w10', true);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  v_refund := public.request_payment_refund(m.payment_id, 5000, 'Resolución parcial de la disputa', 'refund:w10');
  perform set_config('request.jwt.claim.sub', '', true);

  select * into p from public.payments where id = m.payment_id;
  select * into r from public.payment_refunds where id = v_refund;

  raise notice '%', 'W10 devolución pedida: estado ' || r.status ||
    ', devuelto en el pago ' || p.refunded_amount || ', pago en ' || p.status ||
    (case when r.status = 'REQUESTED' and p.refunded_amount = 0 and p.status = 'PAID'
          then '' else ' FALLO' end);
end $$;

-- W11 · Confirmada por el proveedor: ahí sí baja el saldo.
do $$
declare m record; v_refund uuid; r jsonb; p public.payments;
begin
  select * into m from pg_temp.montar_pago('w11', true);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  v_refund := public.request_payment_refund(m.payment_id, 5000, 'Resolución parcial de la disputa', 'refund:w11');
  perform set_config('request.jwt.claim.sub', '', true);

  r := public.settle_payment_refund(v_refund, true, 'NULLIFIED', 5000,
       jsonb_build_object('authorization_code', '999888', 'response_code', 0, 'balance', 16000));
  select * into p from public.payments where id = m.payment_id;

  raise notice '%', 'W11 devolución confirmada: ' || (r ->> 'refund_status') ||
    ', pago ' || p.status || ', devuelto ' || p.refunded_amount ||
    (case when p.status = 'PARTIALLY_REFUNDED' and p.refunded_amount = 5000 then '' else ' FALLO' end);
end $$;

-- W12 · Rechazada por el proveedor: no se devolvió nada.
do $$
declare m record; v_refund uuid; r jsonb; p public.payments;
begin
  select * into m from pg_temp.montar_pago('w12', true);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  v_refund := public.request_payment_refund(m.payment_id, 5000, 'Intento de devolución rechazado', 'refund:w12');
  perform set_config('request.jwt.claim.sub', '', true);

  r := public.settle_payment_refund(v_refund, false, null, null,
       jsonb_build_object('failure_reason', 'provider_rejected', 'response_code', -1));
  select * into p from public.payments where id = m.payment_id;

  raise notice '%', 'W12 devolución rechazada: ' || (r ->> 'refund_status') ||
    ', pago sigue ' || p.status || ', devuelto ' || p.refunded_amount ||
    (case when (r ->> 'refund_status') = 'FAILED' and p.status = 'PAID' and p.refunded_amount = 0
          then '' else ' FALLO' end);
end $$;

-- W13 · Cerrar dos veces la misma devolución no suma dos veces.
do $$
declare m record; v_refund uuid; r1 jsonb; r2 jsonb; p public.payments;
begin
  select * into m from pg_temp.montar_pago('w13', true);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  v_refund := public.request_payment_refund(m.payment_id, 5000, 'Devolución cerrada dos veces', 'refund:w13');
  perform set_config('request.jwt.claim.sub', '', true);

  r1 := public.settle_payment_refund(v_refund, true, 'NULLIFIED', 5000, jsonb_build_object('response_code', 0));
  r2 := public.settle_payment_refund(v_refund, true, 'NULLIFIED', 5000, jsonb_build_object('response_code', 0));
  select * into p from public.payments where id = m.payment_id;

  raise notice '%', 'W13 cierre repetido: ' || (r1 ->> 'outcome') || ' y ' || (r2 ->> 'outcome') ||
    ', devuelto ' || p.refunded_amount ||
    (case when (r2 ->> 'outcome') = 'duplicate' and p.refunded_amount = 5000 then '' else ' FALLO' end);
end $$;

-- W14 · La misma clave de idempotencia devuelve la MISMA devolución.
do $$
declare m record; a uuid; b uuid; v_total int;
begin
  select * into m from pg_temp.montar_pago('w14', true);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  a := public.request_payment_refund(m.payment_id, 5000, 'Devolución idempotente', 'refund:w14');
  b := public.request_payment_refund(m.payment_id, 5000, 'Devolución idempotente', 'refund:w14');
  perform set_config('request.jwt.claim.sub', '', true);

  select count(*) into v_total from public.payment_refunds where payment_id = m.payment_id;
  raise notice '%', 'W14 clave repetida: misma fila ' || (a = b) || ', filas ' || v_total ||
    (case when a = b and v_total = 1 then '' else ' FALLO' end);
end $$;

-- W15 · No se puede devolver más de lo cobrado, ni sumando varias.
do $$
declare m record; v_ok boolean := false;
begin
  select * into m from pg_temp.montar_pago('w15', true);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  perform public.request_payment_refund(m.payment_id, 18000, 'Primera devolución del total', 'refund:w15a');
  begin
    perform public.request_payment_refund(m.payment_id, 5000, 'Segunda devolución que excede', 'refund:w15b');
  exception when check_violation then v_ok := true;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '%', 'W15 excede el saldo: rechazado ' || v_ok ||
    (case when v_ok then '' else ' FALLO' end);
end $$;

-- W16 · Un pago que no se cobró no se devuelve.
do $$
declare m record; v_ok boolean := false;
begin
  select * into m from pg_temp.montar_pago('w16', false);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  begin
    perform public.request_payment_refund(m.payment_id, 1000, 'Devolución sobre pago no cobrado', 'refund:w16');
  exception when check_violation then v_ok := true;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '%', 'W16 pago sin cobrar: rechazado ' || v_ok ||
    (case when v_ok then '' else ' FALLO' end);
end $$;

-- W17 · Con una disputa abierta no se devuelve: primero se resuelve.
do $$
declare m record; v_dispute uuid; v_ok boolean := false;
begin
  select * into m from pg_temp.montar_pago('w17', true);

  insert into public.disputes (assignment_id, opened_by, status, reason, description)
  values (m.assignment_id, m.client_id, 'OPEN', 'OTHER',
          'Descripción suficientemente larga para pasar la comprobación.')
  returning id into v_dispute;

  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  begin
    perform public.request_payment_refund(m.payment_id, 5000, 'Devolución con disputa abierta', 'refund:w17', v_dispute);
  exception when check_violation then v_ok := true;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '%', 'W17 disputa sin resolver: rechazado ' || v_ok ||
    (case when v_ok then '' else ' FALLO' end);
end $$;

-- W18 · Una devolución confirmada tiene que decir cómo la resolvió el banco.
do $$
declare m record; v_refund uuid; v_ok boolean := false;
begin
  select * into m from pg_temp.montar_pago('w18', true);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  v_refund := public.request_payment_refund(m.payment_id, 5000, 'Devolución sin tipo declarado', 'refund:w18');
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.settle_payment_refund(v_refund, true, null, 5000, '{}');
  exception when invalid_parameter_value then v_ok := true;
  end;
  raise notice '%', 'W18 confirmada sin reversa ni anulación: rechazado ' || v_ok ||
    (case when v_ok then '' else ' FALLO' end);
end $$;

\echo ''
\echo '--- Privilegios'

-- W19 · Ningún usuario escribe en las tablas del dinero.
do $$
declare m record; v_refund int := 0; v_payment int := 0;
begin
  select * into m from pg_temp.montar_pago('w19', true);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  perform set_config('role', 'authenticated', true);

  begin
    insert into public.payment_refunds (payment_id, amount, reason, provider, environment, provider_event_id, requested_by)
    values (m.payment_id, 1, 'Escritura directa prohibida', 'x', 'integration', 'x', m.admin_id);
  exception when insufficient_privilege or sqlstate '42501' then v_refund := 1;
  end;

  begin
    update public.payments set status = 'PAID' where id = m.payment_id;
  exception when insufficient_privilege or sqlstate '42501' then v_payment := 1;
  end;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);

  raise notice '%', 'W19 escritura directa: devoluciones bloqueadas ' || (v_refund = 1) ||
    ', pagos bloqueados ' || (v_payment = 1) ||
    (case when v_refund = 1 and v_payment = 1 then '' else ' FALLO' end);
end $$;

-- W20 · Las funciones de sistema no son ejecutables por un usuario.
do $$
declare v_expuestas text;
begin
  select string_agg(p.proname, ', ') into v_expuestas
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'register_payment_attempt', 'record_provider_snapshot',
       'record_payment_abandonment', 'settle_payment_refund',
       'payments_pending_reconciliation', 'confirm_payment_result'
     )
     and (has_function_privilege('authenticated', p.oid, 'execute')
       or has_function_privilege('anon', p.oid, 'execute'));

  raise notice '%', 'W20 funciones de sistema reservadas: expuestas ' ||
    coalesce(v_expuestas, 'ninguna') ||
    (case when v_expuestas is null then '' else ' FALLO' end);
end $$;

-- W21 · Los invariantes del dinero devuelto, limpios.
do $$
declare v_rows int;
begin
  select count(*) into v_rows from app_private.refund_invariant_violations();
  raise notice '%', 'W21 invariantes de devolución: violaciones ' || v_rows ||
    (case when v_rows = 0 then '' else ' FALLO' end);
end $$;

-- W22 · Y los del dinero en general siguen limpios tras las devoluciones
-- parciales de arriba. Un pago PARTIALLY_REFUNDED con su payout intacto es
-- sano: se devolvió una parte y el resto sigue siendo del trabajador.
do $$
declare v_rows int; v_detalle text;
begin
  select count(*) into v_rows from app_private.payment_invariant_violations();
  select coalesce(string_agg(rule, ', '), '') into v_detalle
    from app_private.payment_invariant_violations();
  raise notice '%', 'W22 invariantes de pago: violaciones ' || v_rows ||
    (case when v_detalle = '' then '' else ' [' || v_detalle || ']' end) ||
    (case when v_rows = 0 then '' else ' FALLO' end);
end $$;

-- W23 · Una devolución TOTAL retiene el pago al trabajador.
--
-- Es el hueco que encontró la batería: sin esto, el cliente recuperaba todo su
-- dinero y el trabajador seguía en la cola de transferencia.
do $$
declare m record; v_refund uuid; v_total bigint; p public.payments; o public.payouts;
begin
  select * into m from pg_temp.montar_pago('w23', true);
  select amount into v_total from public.payments where id = m.payment_id;

  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  v_refund := public.request_payment_refund(m.payment_id, v_total, 'Devolución total por resolución', 'refund:w23');
  perform set_config('request.jwt.claim.sub', '', true);

  perform public.settle_payment_refund(v_refund, true, 'REVERSED', v_total, jsonb_build_object('response_code', 0));

  select * into p from public.payments where id = m.payment_id;
  select * into o from public.payouts where payment_id = m.payment_id;

  raise notice '%', 'W23 devolución total: pago ' || p.status ||
    ', payout ' || coalesce(o.status::text, 'sin payout') ||
    ', motivo ' || coalesce(o.held_reason, '—') ||
    (case when p.status = 'REFUNDED' and o.status = 'HELD' then '' else ' FALLO' end);
end $$;

-- W24 · Una devolución PARCIAL no toca el pago al trabajador.
do $$
declare m record; v_refund uuid; p public.payments; o public.payouts;
begin
  select * into m from pg_temp.montar_pago('w24', true);
  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  v_refund := public.request_payment_refund(m.payment_id, 3000, 'Devolución parcial acordada', 'refund:w24');
  perform set_config('request.jwt.claim.sub', '', true);
  perform public.settle_payment_refund(v_refund, true, 'NULLIFIED', 3000, jsonb_build_object('response_code', 0));

  select * into p from public.payments where id = m.payment_id;
  select * into o from public.payouts where payment_id = m.payment_id;

  raise notice '%', 'W24 devolución parcial: pago ' || p.status ||
    ', payout ' || coalesce(o.status::text, 'sin payout') ||
    (case when p.status = 'PARTIALLY_REFUNDED' and o.status = 'PENDING' then '' else ' FALLO' end);
end $$;

-- W25 · Los invariantes, después de todo lo anterior.
do $$
declare v_pago int; v_ref int; v_detalle text;
begin
  select count(*) into v_pago from app_private.payment_invariant_violations();
  select count(*) into v_ref from app_private.refund_invariant_violations();
  select coalesce(string_agg(rule, ', '), '') into v_detalle
    from app_private.payment_invariant_violations();
  raise notice '%', 'W25 invariantes finales: pago ' || v_pago || ', devolución ' || v_ref ||
    (case when v_detalle = '' then '' else ' [' || v_detalle || ']' end) ||
    (case when v_pago = 0 and v_ref = 0 then '' else ' FALLO' end);
end $$;
