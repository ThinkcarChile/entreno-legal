\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Cancelar con un pago en vuelo: cada orden de llegada, sin carreras
-- =============================================================================
-- Garantía bajo prueba: nunca coexisten trabajo cancelado, pago PAID,
-- asignación habilitada y payout. Cada escenario monta su propio trabajo por
-- el camino real (oferta → accept_job_offer → start_protected_payment), lo lleva
-- al punto de conflicto y comprueba el resultado y los invariantes.
--
-- Los dos escenarios de concurrencia real (dos confirmaciones a la vez, y una
-- confirmación contra una cancelación) están en 07_race_payment.sh, porque
-- necesitan dos sesiones de verdad.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Montaje: un trabajo con oferta aceptada y, si se pide, un pago en vuelo.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.montar_pago(
  p_tag text,
  p_pago text,                 -- 'ninguno' | 'sin_transaccion' | 'en_vuelo'
  out job_id uuid,
  out assignment_id uuid,
  out payment_id uuid,
  out client_id uuid,
  out worker_id uuid
)
language plpgsql
as $$
declare
  v_offer uuid;
begin
  -- Un cliente y un trabajador verificado de la semilla de demostración, y
  -- que no sean la misma persona.
  select w.user_id into worker_id from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select u.id into client_id from auth.users u
   where u.id <> worker_id and exists (select 1 from public.profiles p where p.id = u.id)
   order by u.id limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (
    id, client_id, category_id, status, title, description, region_code, commune_code,
    place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate, published_at
  ) values (
    job_id, client_id, (select id from public.job_categories order by sort_order limit 1), 'PUBLISHED',
    'Prueba de cancelación ' || p_tag, 'Montaje de la prueba de cancelación con pago en vuelo.',
    '13', '13-santiago', 'Lugar de prueba', now() + interval '2 days', 120, 'HOLD_PLACE', 9000, now()
  );

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, worker_id, 9000, 18000, 'Oferta de prueba ' || p_tag)
  returning id into v_offer;

  perform set_config('request.jwt.claim.sub', client_id::text, true);
  assignment_id := public.accept_job_offer(v_offer);

  if p_pago <> 'ninguno' then
    payment_id := public.start_protected_payment(assignment_id);
    if p_pago = 'en_vuelo' then
      -- Lo que hace startProtectedPaymentAction con la clave de servicio al
      -- volver del proveedor: la transacción existe y espera respuesta.
      update public.payments
         set status = 'CREATED', provider = 'mock-delayed',
             provider_transaction_id = 'mockd-' || p_tag, provider_token = 'mockd-' || p_tag
       where id = payment_id;
    end if;
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;

-- Lo que devuelve la función de invariantes, en una línea.
create or replace function pg_temp.violaciones() returns text
language sql as $$
  select coalesce(string_agg(rule || ':' || entity_id, ', '), 'ninguna')
    from app_private.payment_invariant_violations();
$$;

\echo ''
\echo '--- Política de cancelación, escenario por escenario'

-- P01 · Cancelar antes de iniciar el pago: inmediata.
do $$
declare m record; v_job text; v_asg text; v_ofertas int;
begin
  select * into m from pg_temp.montar_pago('p01', 'ninguno');
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.cancel_job(m.job_id, 'Ya no lo necesito');
  select status into v_job from public.jobs where id = m.job_id;
  select status into v_asg from public.assignments where id = m.assignment_id;
  select count(*) into v_ofertas from public.job_offers where job_id = m.job_id and status = 'PENDING';
  raise notice '%', 'P01 cancelar sin pago: trabajo ' || v_job || ', asignación ' || v_asg
    || case when v_job = 'CANCELLED' and v_asg = 'CANCELLED_BY_CLIENT' and v_ofertas = 0 then '' else ' FALLO' end;
end $$;

-- P02 · Pago creado en la base pero que nunca llegó al proveedor: no hay dinero
-- en juego, se cancela en el acto y el pago queda FAILED.
do $$
declare m record; v_job text; v_pago text;
begin
  select * into m from pg_temp.montar_pago('p02', 'sin_transaccion');
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.cancel_job(m.job_id, null);
  select status into v_job from public.jobs where id = m.job_id;
  select status into v_pago from public.payments where id = m.payment_id;
  raise notice '%', 'P02 cancelar con pago sin transacción: trabajo ' || v_job || ', pago ' || v_pago
    || case when v_job = 'CANCELLED' and v_pago = 'FAILED' then '' else ' FALLO' end;
end $$;

-- P03 · Pago en vuelo: la cancelación queda en verificación, nada se cancela
-- todavía, y pedirla otra vez se rechaza.
do $$
declare m record; v_job text; v_asg text; v_pago text; v_segunda text := 'permitida';
begin
  select * into m from pg_temp.montar_pago('p03', 'en_vuelo');
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.cancel_job(m.job_id, 'Cambio de planes');
  select status into v_job from public.jobs where id = m.job_id;
  select status into v_asg from public.assignments where id = m.assignment_id;
  select status into v_pago from public.payments where id = m.payment_id;
  begin
    perform public.cancel_job(m.job_id, 'otra vez');
  exception when check_violation then v_segunda := 'rechazada';
  end;
  raise notice '%', 'P03 cancelar con pago en vuelo: trabajo ' || v_job || ', asignación ' || v_asg
    || ', pago ' || v_pago || ', segunda cancelación ' || v_segunda
    || case when v_job = 'CANCELLATION_PENDING' and v_asg = 'AWAITING_PAYMENT'
             and v_pago = 'CREATED' and v_segunda = 'rechazada' then '' else ' FALLO' end;
end $$;

-- P04 · Pago aprobado ANTES de cancelar: se habilita y hay payout; después,
-- cancelar ya no es una cancelación simple.
do $$
declare m record; r jsonb; v_job text; v_asg text; v_payouts int; v_cancel text := 'permitida';
begin
  select * into m from pg_temp.montar_pago('p04', 'en_vuelo');
  r := public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p04', 'PAID', 18000, '{"authorization_code":"A1"}');
  select status into v_job from public.jobs where id = m.job_id;
  select status into v_asg from public.assignments where id = m.assignment_id;
  select count(*) into v_payouts from public.payouts where assignment_id = m.assignment_id;
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  begin
    perform public.cancel_job(m.job_id, 'tarde');
  exception when check_violation then v_cancel := 'rechazada: reembolso o disputa';
  end;
  raise notice '%', 'P04 aprobado antes de cancelar: trabajo ' || v_job || ', asignación ' || v_asg
    || ', payouts ' || v_payouts || ', cancelación ' || v_cancel
    || case when v_job = 'PAID' and v_asg = 'CONFIRMED' and v_payouts = 1
             and (r ->> 'outcome') = 'applied' and v_cancel like 'rechazada%' then '' else ' FALLO' end;
end $$;

-- P05 · Cancelación solicitada, y DESPUÉS llega la confirmación aprobada: el
-- dinero se registra para devolución, el trabajo termina cancelado, sin payout.
do $$
declare m record; r jsonb; v_pago record; v_job text; v_asg text; v_payouts int; v_eventos int;
begin
  select * into m from pg_temp.montar_pago('p05', 'en_vuelo');
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.cancel_job(m.job_id, 'Me arrepentí');
  perform set_config('request.jwt.claim.sub', '', true);
  r := public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p05', 'PAID', 18000, '{"authorization_code":"A5","card_last_digits":"4242"}');
  select status, review_reason, captured_at, paid_at, authorization_code into v_pago from public.payments where id = m.payment_id;
  select status into v_job from public.jobs where id = m.job_id;
  select status into v_asg from public.assignments where id = m.assignment_id;
  select count(*) into v_payouts from public.payouts where assignment_id = m.assignment_id;
  select count(*) into v_eventos from public.payment_events where provider_event_id = 'evt-p05';
  raise notice '%', 'P05 aprobación tardía tras pedir cancelar: pago ' || v_pago.status || ' (' || coalesce(v_pago.review_reason, '-') || ')'
    || ', trabajo ' || v_job || ', asignación ' || v_asg || ', payouts ' || v_payouts || ', eventos ' || v_eventos
    || case when v_pago.status = 'UNDER_REVIEW' and v_pago.review_reason = 'late_confirmation_after_cancellation'
             and v_pago.captured_at is not null and v_pago.paid_at is null and v_pago.authorization_code = 'A5'
             and v_job = 'CANCELLED' and v_asg = 'CANCELLED_BY_CLIENT' and v_payouts = 0 and v_eventos = 1
             then '' else ' FALLO' end;
end $$;

-- P06 · Cancelación solicitada, y llega un RECHAZO: no hay dinero, se completa.
do $$
declare m record; r jsonb; v_pago text; v_job text; v_asg text; v_payouts int;
begin
  select * into m from pg_temp.montar_pago('p06', 'en_vuelo');
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.cancel_job(m.job_id, null);
  perform set_config('request.jwt.claim.sub', '', true);
  r := public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p06', 'FAILED', null, '{}');
  select status into v_pago from public.payments where id = m.payment_id;
  select status into v_job from public.jobs where id = m.job_id;
  select status into v_asg from public.assignments where id = m.assignment_id;
  select count(*) into v_payouts from public.payouts where assignment_id = m.assignment_id;
  raise notice '%', 'P06 rechazo tras pedir cancelar: pago ' || v_pago || ', trabajo ' || v_job
    || ', asignación ' || v_asg || ', payouts ' || v_payouts
    || case when v_pago = 'FAILED' and v_job = 'CANCELLED' and v_asg = 'CANCELLED_BY_CLIENT' and v_payouts = 0 then '' else ' FALLO' end;

  -- P07 · Y si después de eso el proveedor dice «aprobado» sobre el mismo pago
  -- (contradictorio: puede haber cobrado): revisión, y el trabajo sigue cancelado.
  r := public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p07', 'PAID', 18000, '{}');
  select status || ' (' || coalesce(review_reason, '-') || ')' into v_pago from public.payments where id = m.payment_id;
  select status into v_job from public.jobs where id = m.job_id;
  select count(*) into v_payouts from public.payouts where assignment_id = m.assignment_id;
  raise notice '%', 'P07 aprobación después de la cancelación completada: pago ' || v_pago
    || ', trabajo ' || v_job || ', payouts ' || v_payouts
    || case when v_pago = 'UNDER_REVIEW (approved_after_failed)' and v_job = 'CANCELLED' and v_payouts = 0 then '' else ' FALLO' end;
end $$;

-- P08 · La misma confirmación dos veces: la segunda es un duplicado, un solo
-- evento registrado, un solo payout, nada cambia.
do $$
declare m record; r1 jsonb; r2 jsonb; v_eventos int; v_payouts int; v_pago text;
begin
  select * into m from pg_temp.montar_pago('p08', 'en_vuelo');
  r1 := public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p08', 'PAID', 18000, '{}');
  r2 := public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p08', 'PAID', 18000, '{}');
  select count(*) into v_eventos from public.payment_events where provider_event_id = 'evt-p08';
  select count(*) into v_payouts from public.payouts where assignment_id = m.assignment_id;
  select status into v_pago from public.payments where id = m.payment_id;
  raise notice '%', 'P08 callback duplicado: primero ' || (r1 ->> 'outcome') || ', segundo ' || (r2 ->> 'outcome')
    || ', eventos ' || v_eventos || ', payouts ' || v_payouts || ', pago ' || v_pago
    || case when (r1 ->> 'outcome') = 'applied' and (r2 ->> 'outcome') = 'duplicate'
             and v_eventos = 1 and v_payouts = 1 and v_pago = 'PAID' then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Lo que nadie puede hacer a mano'

-- P10 · Crear un payout a mano sobre una asignación cancelada, y sobre un pago
-- sin confirmar. La tabla lo rechaza aunque lo intente el sistema.
do $$
declare m record; v_a text := 'permitido'; v_b text := 'permitido'; v_c text := 'permitido';
begin
  select * into m from pg_temp.montar_pago('p10', 'en_vuelo');
  -- Sin pago confirmado.
  begin
    insert into public.payouts (assignment_id, worker_id, gross_amount, net_amount)
    values (m.assignment_id, m.worker_id, 18000, 15480);
  exception when check_violation then v_a := 'rechazado';
  end;
  -- Sobre asignación cancelada.
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.cancel_job(m.job_id, null);
  perform set_config('request.jwt.claim.sub', '', true);
  perform public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p10', 'FAILED', null, '{}');
  begin
    insert into public.payouts (assignment_id, worker_id, gross_amount, net_amount)
    values (m.assignment_id, m.worker_id, 18000, 15480);
  exception when check_violation then v_b := 'rechazado';
  end;
  -- Y un usuario con sesión ni siquiera tiene el privilegio.
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.payouts (assignment_id, worker_id, gross_amount, net_amount)
    values (m.assignment_id, m.worker_id, 18000, 15480);
  exception when insufficient_privilege then v_c := 'sin privilegio';
  end;
  execute 'reset role';
  raise notice '%', 'P10 payout a mano: sin pago ' || v_a || ', sobre cancelada ' || v_b || ', como usuario ' || v_c
    || case when v_a = 'rechazado' and v_b = 'rechazado' and v_c = 'sin privilegio' then '' else ' FALLO' end;
end $$;

-- P11 · Habilitar una asignación cancelada: ni el sistema puede.
do $$
declare m record; v_r text := 'permitido';
begin
  select * into m from pg_temp.montar_pago('p11', 'ninguno');
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.cancel_job(m.job_id, null);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    update public.assignments set status = 'CONFIRMED' where id = m.assignment_id;
  exception when check_violation then v_r := 'rechazado';
  end;
  raise notice '%', 'P11 habilitar asignación cancelada (sin sesión, como el sistema): ' || v_r
    || case when v_r = 'rechazado' then '' else ' FALLO' end;
end $$;

-- P12 · Un usuario ajeno no cancela.
do $$
declare m record; v_otro uuid; v_r text := 'permitido'; v_job text;
begin
  select * into m from pg_temp.montar_pago('p12', 'en_vuelo');
  select id into v_otro from auth.users where id not in (m.client_id, m.worker_id) order by id limit 1;
  perform set_config('request.jwt.claim.sub', v_otro::text, true);
  begin
    perform public.cancel_job(m.job_id, 'ajeno');
  exception when insufficient_privilege then v_r := 'rechazado';
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  select status into v_job from public.jobs where id = m.job_id;
  raise notice '%', 'P12 cancelación por un tercero: ' || v_r || ', trabajo ' || v_job
    || case when v_r = 'rechazado' and v_job = 'PAYMENT_PENDING' then '' else ' FALLO' end;
end $$;

-- P13 · Importes manipulados: el proveedor «confirma» otro importe, y el
-- cliente intenta reescribir el pago.
do $$
declare m record; r jsonb; v_pago text; v_job text; v_payouts int; v_cli text := 'permitido';
begin
  select * into m from pg_temp.montar_pago('p13', 'en_vuelo');
  r := public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p13', 'PAID', 1, '{}');
  select status || ' (' || coalesce(review_reason, '-') || ')' into v_pago from public.payments where id = m.payment_id;
  select status into v_job from public.jobs where id = m.job_id;
  select count(*) into v_payouts from public.payouts where assignment_id = m.assignment_id;
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  execute 'set local role authenticated';
  begin
    update public.payments set amount = 1, status = 'PAID' where id = m.payment_id;
  exception when insufficient_privilege then v_cli := 'sin privilegio';
  end;
  execute 'reset role';
  raise notice '%', 'P13 importe distinto al esperado: pago ' || v_pago || ', trabajo ' || v_job
    || ', payouts ' || v_payouts || ', reescritura del cliente ' || v_cli
    || case when v_pago = 'UNDER_REVIEW (amount_mismatch)' and v_job = 'PAYMENT_PENDING'
             and v_payouts = 0 and v_cli = 'sin privilegio' then '' else ' FALLO' end;
end $$;

-- P14 · Evento desconocido, proveedor equivocado, resultado inválido.
do $$
declare m record; v_a text := 'aceptado'; v_b text := 'aceptado'; v_c text := 'aceptado'; v_d text := 'aceptado';
begin
  select * into m from pg_temp.montar_pago('p14', 'en_vuelo');
  begin
    perform public.confirm_payment_result(gen_random_uuid(), 'mock-delayed', 'evt-p14a', 'PAID', 18000, '{}');
  exception when no_data_found then v_a := 'rechazado';
  end;
  begin
    perform public.confirm_payment_result(m.payment_id, 'otro-proveedor', 'evt-p14b', 'PAID', 18000, '{}');
  exception when check_violation then v_b := 'rechazado';
  end;
  begin
    perform public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p14c', 'TAL_VEZ', 18000, '{}');
  exception when invalid_parameter_value then v_c := 'rechazado';
  end;
  begin
    perform public.confirm_payment_result(m.payment_id, 'mock-delayed', '', 'PAID', 18000, '{}');
  exception when invalid_parameter_value then v_d := 'rechazado';
  end;
  raise notice '%', 'P14 pago inexistente ' || v_a || ', proveedor ajeno ' || v_b || ', resultado inválido ' || v_c || ', sin id de evento ' || v_d
    || case when v_a = 'rechazado' and v_b = 'rechazado' and v_c = 'rechazado' and v_d = 'rechazado' then '' else ' FALLO' end;
end $$;

-- P15 · Un usuario con sesión no puede ejecutar la confirmación.
do $$
declare m record; v_r text := 'permitido';
begin
  select * into m from pg_temp.montar_pago('p15', 'en_vuelo');
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  execute 'set local role authenticated';
  begin
    perform public.confirm_payment_result(m.payment_id, 'mock-delayed', 'evt-p15', 'PAID', 18000, '{}');
  exception when insufficient_privilege then v_r := 'sin privilegio';
  end;
  execute 'reset role';
  raise notice '%', 'P15 confirmación por un usuario con sesión: ' || v_r
    || case when v_r = 'sin privilegio' then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Invariantes después de todos los escenarios'

select 'P16 violaciones de invariantes = ' || pg_temp.violaciones()
       || case when pg_temp.violaciones() = 'ninguna' then '' else ' FALLO' end;

-- Bitácora coherente: cada confirmación aplicada tiene su evento del proveedor
-- y su transición de estado, y payment_events sigue sin poder tocarse.
do $$
declare v_r text := 'permitido'; v_id uuid;
begin
  select id into v_id from public.payment_events where provider_event_id = 'evt-p05';
  perform set_config('request.jwt.claim.sub', (select client_id from public.payments p join public.payment_events e on e.payment_id = p.id where e.id = v_id)::text, true);
  execute 'set local role authenticated';
  begin
    update public.payment_events set payload = '{}'::jsonb where id = v_id;
  exception when insufficient_privilege then v_r := 'sin privilegio';
  end;
  begin
    delete from public.payment_events where id = v_id;
  exception when insufficient_privilege then v_r := v_r || ', borrado sin privilegio';
  end;
  execute 'reset role';
  raise notice '%', 'P17 payment_events append-only para un usuario: ' || v_r
    || case when v_r = 'sin privilegio, borrado sin privilegio' then '' else ' FALLO' end;
end $$;
