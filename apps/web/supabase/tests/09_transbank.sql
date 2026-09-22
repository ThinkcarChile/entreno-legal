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

-- W26 · Un pago cobrado no vuelve atrás, ni con la clave de servicio.
--
-- Lo encontró la prueba de navegador: sin esta guarda, un PAID podía volver a
-- CREATED y dejaba huérfano el pago al trabajador que ese PAID había creado.
do $$
declare m record; v_a boolean := false; v_b boolean := false; v_c boolean := false;
begin
  select * into m from pg_temp.montar_pago('w26', true);

  begin
    update public.payments set status = 'CREATED' where id = m.payment_id;
  exception when check_violation then v_a := true;
  end;

  begin
    update public.payments set status = 'PENDING' where id = m.payment_id;
  exception when check_violation then v_b := true;
  end;

  -- Y lo que sí se puede: dejarlo en revisión, que deja rastro.
  begin
    update public.payments set status = 'UNDER_REVIEW', review_reason = 'revisión manual'
     where id = m.payment_id;
    v_c := true;
  exception when others then v_c := false;
  end;

  raise notice '%', 'W26 sin retroceso: a CREATED ' || v_a || ', a PENDING ' || v_b ||
    ', a revisión permitido ' || v_c ||
    (case when v_a and v_b and v_c then '' else ' FALLO' end);
end $$;

-- W27 · Un pago devuelto tampoco retrocede.
do $$
declare m record; v_refund uuid; v_total bigint; v_ok boolean := false;
begin
  select * into m from pg_temp.montar_pago('w27', true);
  select amount into v_total from public.payments where id = m.payment_id;

  perform set_config('request.jwt.claim.sub', m.admin_id::text, true);
  v_refund := public.request_payment_refund(m.payment_id, v_total, 'Devolución total para la prueba', 'refund:w27');
  perform set_config('request.jwt.claim.sub', '', true);
  perform public.settle_payment_refund(v_refund, true, 'REVERSED', v_total, jsonb_build_object('response_code', 0));

  begin
    update public.payments set status = 'CREATED' where id = m.payment_id;
  exception when check_violation then v_ok := true;
  end;

  raise notice '%', 'W27 devuelto sin retroceso: rechazado ' || v_ok ||
    (case when v_ok then '' else ' FALLO' end);
end $$;

-- W28 · Poner un pago en revisión congela el pago al trabajador.
--
-- Tercera vez que aparece el mismo patrón: se duda del dinero que entró y se
-- seguía adelante con el dinero que sale.
do $$
declare m record; o_antes public.payouts; o_despues public.payouts;
begin
  select * into m from pg_temp.montar_pago('w28', true);
  select * into o_antes from public.payouts where payment_id = m.payment_id;

  update public.payments
     set status = 'UNDER_REVIEW', review_reason = 'importe que no cuadra'
   where id = m.payment_id;

  select * into o_despues from public.payouts where payment_id = m.payment_id;

  raise notice '%', 'W28 revisión congela el pago al trabajador: antes ' ||
    coalesce(o_antes.status::text, 'sin payout') || ', después ' ||
    coalesce(o_despues.status::text, 'sin payout') ||
    (case when o_antes.status = 'PENDING' and o_despues.status = 'HELD' then '' else ' FALLO' end);
end $$;

-- W29 · Y los invariantes, después de todo lo anterior.
do $$
declare v_pago int; v_ref int; v_detalle text;
begin
  select count(*) into v_pago from app_private.payment_invariant_violations();
  select count(*) into v_ref from app_private.refund_invariant_violations();
  select coalesce(string_agg(rule || ':' || entity_id, ', '), '') into v_detalle
    from app_private.payment_invariant_violations();
  raise notice '%', 'W29 invariantes tras revisión y devoluciones: pago ' || v_pago ||
    ', devolución ' || v_ref ||
    (case when v_detalle = '' then '' else ' [' || v_detalle || ']' end) ||
    (case when v_pago = 0 and v_ref = 0 then '' else ' FALLO' end);
end $$;

\echo ''
\echo '--- Ventana de conciliación y pagos rezagados'

-- W30 · La ventana es configuración, no una cifra escrita en una función.
do $$
declare v_dias int; v_col boolean;
begin
  select reconciliation_window_days into v_dias from public.platform_settings limit 1;
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'platform_settings'
       and column_name = 'reconciliation_window_days'
  ) into v_col;
  raise notice '%', 'W30 ventana configurable: columna ' || v_col || ', valor ' || v_dias ||
    (case when v_col and v_dias = 7 then '' else ' FALLO' end);
end $$;

-- W31 · Un INITIALIZED no consume la clave commit:<token>.
--
-- Es el peor fallo posible de esta integración: si un resultado provisional
-- gastara la clave, la autorización real posterior se descartaría como
-- duplicada y el pago quedaría cobrado sin habilitar el trabajo.
--
-- Aquí se prueba desde la base: el evento de la autorización se registra y
-- aplica, porque nadie gastó la clave antes.
do $$
declare m record; v_tag text; r jsonb; v_eventos int;
begin
  select * into m from pg_temp.montar_pago('w31', false);
  select replace(provider_token, 'tok-', '') into v_tag from public.payments where id = m.payment_id;

  -- La aplicación NO asienta un INITIALIZED, así que la clave sigue libre.
  r := public.confirm_payment_result(m.payment_id, 'transbank_webpay_plus',
       'commit:tok-' || v_tag, 'PAID', null,
       jsonb_build_object('authorization_code', '123456'));

  select count(*) into v_eventos from public.payment_events
   where payment_id = m.payment_id and provider_event_id = 'commit:tok-' || v_tag;

  raise notice '%', 'W31 clave libre tras un provisional: ' || (r ->> 'outcome') ||
    ', pago ' || (r ->> 'payment_status') || ', eventos ' || v_eventos ||
    (case when (r ->> 'outcome') = 'applied' and (r ->> 'payment_status') = 'PAID'
               and v_eventos = 1
          then '' else ' FALLO' end);
end $$;

-- W32 · Y si la clave SÍ se gastara, el pago se perdería. Se demuestra.
--
-- Esta prueba documenta por qué existe `isSettleable`: reproduce a mano lo que
-- hacía el código antes del Bloque 5.1.
do $$
declare m record; v_tag text; r1 jsonb; r2 jsonb;
begin
  select * into m from pg_temp.montar_pago('w32', false);
  select replace(provider_token, 'tok-', '') into v_tag from public.payments where id = m.payment_id;

  -- Lo que hacía el código viejo: asentar FAILED con la clave del commit.
  r1 := public.confirm_payment_result(m.payment_id, 'transbank_webpay_plus',
        'commit:tok-' || v_tag, 'FAILED', null, '{}');
  -- Y después llega la autorización de verdad.
  r2 := public.confirm_payment_result(m.payment_id, 'transbank_webpay_plus',
        'commit:tok-' || v_tag, 'PAID', null, '{}');

  raise notice '%', 'W32 clave gastada (comportamiento antiguo): segunda llamada ' ||
    (r2 ->> 'outcome') || ', pago queda en ' || (r2 ->> 'payment_status') ||
    ' — por esto no se asienta un provisional' ||
    (case when (r2 ->> 'outcome') = 'duplicate' and (r2 ->> 'payment_status') = 'FAILED'
          then '' else ' FALLO' end);
end $$;

-- W33 · Un pago rezagado y sin cobro se cierra, y el cliente puede reintentar.
do $$
declare m record; v_res record; p public.payments;
begin
  select * into m from pg_temp.montar_pago('w33', false);
  update public.payments set created_at = now() - interval '30 days' where id = m.payment_id;

  select * into v_res from public.expire_stale_payments(100)
   where payment_id = m.payment_id;
  select * into p from public.payments where id = m.payment_id;

  raise notice '%', 'W33 rezagado sin cobro: ' || coalesce(v_res.was_status::text, '—') ||
    ' → ' || p.status || ', motivo ' || coalesce(p.failure_reason, '—') ||
    (case when p.status = 'FAILED' and p.failure_reason = 'reconciliation_window_expired'
          then '' else ' FALLO' end);
end $$;

-- W34 · Un pago rezagado AUTORIZADO pasa a revisión, no se cierra solo.
do $$
declare m record; p public.payments;
begin
  select * into m from pg_temp.montar_pago('w34', false);
  update public.payments
     set status = 'AUTHORIZED', created_at = now() - interval '30 days'
   where id = m.payment_id;

  perform public.expire_stale_payments(100);
  select * into p from public.payments where id = m.payment_id;

  raise notice '%', 'W34 rezagado autorizado: ' || p.status ||
    ', motivo ' || coalesce(p.review_reason, '—') ||
    ', capturado ' || (p.captured_at is not null) ||
    (case when p.status = 'UNDER_REVIEW'
               and p.review_reason = 'reconciliation_window_expired'
          then '' else ' FALLO' end);
end $$;

-- W35 · Expirar deja constancia: evento y auditoría. Nada desaparece en silencio.
do $$
declare m record; v_eventos int; v_audit int;
begin
  select * into m from pg_temp.montar_pago('w35', false);
  update public.payments set created_at = now() - interval '30 days' where id = m.payment_id;
  perform public.expire_stale_payments(100);

  select count(*) into v_eventos from public.payment_events
   where payment_id = m.payment_id and payload ->> 'operation' = 'expire';
  select count(*) into v_audit from public.audit_logs
   where entity_id = m.payment_id and action = 'payment_expired_out_of_window';

  raise notice '%', 'W35 rastro al expirar: eventos ' || v_eventos || ', auditoría ' || v_audit ||
    (case when v_eventos = 1 and v_audit = 1 then '' else ' FALLO' end);
end $$;

-- W36 · Expirar dos veces no duplica nada.
do $$
declare m record; v_eventos int;
begin
  select * into m from pg_temp.montar_pago('w36', false);
  update public.payments set created_at = now() - interval '30 days' where id = m.payment_id;
  perform public.expire_stale_payments(100);
  perform public.expire_stale_payments(100);

  select count(*) into v_eventos from public.payment_events
   where payment_id = m.payment_id and payload ->> 'operation' = 'expire';

  raise notice '%', 'W36 expirar es idempotente: eventos ' || v_eventos ||
    (case when v_eventos = 1 then '' else ' FALLO' end);
end $$;

-- W37 · Un pago colgado fuera de ventana es una violación de invariante.
do $$
declare m record; v_antes int; v_despues int;
begin
  select * into m from pg_temp.montar_pago('w37', false);
  update public.payments set created_at = now() - interval '30 days' where id = m.payment_id;

  select count(*) into v_antes from app_private.refund_invariant_violations()
   where rule = 'stale_payment_out_of_window' and entity_id = m.payment_id;

  perform public.expire_stale_payments(100);

  select count(*) into v_despues from app_private.refund_invariant_violations()
   where rule = 'stale_payment_out_of_window' and entity_id = m.payment_id;

  raise notice '%', 'W37 el invariante ve los colgados: antes ' || v_antes ||
    ', después de expirar ' || v_despues ||
    (case when v_antes = 1 and v_despues = 0 then '' else ' FALLO' end);
end $$;

-- W38 · Un pago dentro de ventana NO se expira.
do $$
declare m record; p public.payments;
begin
  select * into m from pg_temp.montar_pago('w38', false);
  update public.payments set created_at = now() - interval '2 days' where id = m.payment_id;
  perform public.expire_stale_payments(100);
  select * into p from public.payments where id = m.payment_id;

  raise notice '%', 'W38 dentro de ventana intacto: ' || p.status ||
    (case when p.status = 'CREATED' then '' else ' FALLO' end);
end $$;

-- W39 · La cola respeta la ventana configurada, no una cifra fija.
do $$
declare m record; v_en_cola int; v_original int;
begin
  select reconciliation_window_days into v_original from public.platform_settings limit 1;
  select * into m from pg_temp.montar_pago('w39', false);
  update public.payments set created_at = now() - interval '5 days' where id = m.payment_id;

  -- Con la ventana por defecto (7 días) está en la cola.
  select count(*) into v_en_cola from public.payments_pending_reconciliation(0, 200)
   where payment_id = m.payment_id;

  -- Bajando la ventana a 3 días, ya no: quedó fuera.
  update public.platform_settings set reconciliation_window_days = 3;

  raise notice '%', 'W39 ventana configurable en la cola: con 7 días ' || v_en_cola ||
    ', con 3 días ' ||
    (select count(*) from public.payments_pending_reconciliation(0, 200)
      where payment_id = m.payment_id) ||
    (case when v_en_cola = 1
               and (select count(*) from public.payments_pending_reconciliation(0, 200)
                     where payment_id = m.payment_id) = 0
          then '' else ' FALLO' end);

  update public.platform_settings set reconciliation_window_days = v_original;
end $$;

-- W40 · Invariantes finales del Bloque 5.1.
do $$
declare v_pago int; v_ref int; v_detalle text;
begin
  -- Se limpia lo que dejaron las pruebas de esta sección.
  perform public.expire_stale_payments(500);

  select count(*) into v_pago from app_private.payment_invariant_violations();
  select count(*) into v_ref from app_private.refund_invariant_violations();
  select coalesce(string_agg(distinct rule, ', '), '') into v_detalle
    from app_private.refund_invariant_violations();

  raise notice '%', 'W40 invariantes del Bloque 5.1: pago ' || v_pago ||
    ', devolución ' || v_ref ||
    (case when v_detalle = '' then '' else ' [' || v_detalle || ']' end) ||
    (case when v_pago = 0 and v_ref = 0 then '' else ' FALLO' end);
end $$;
