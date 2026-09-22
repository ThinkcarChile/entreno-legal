\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Ejecución del trabajo: del pago confirmado a la aprobación del cliente
-- =============================================================================
-- Cada escenario monta su propio trabajo por el camino real —oferta, aceptación,
-- pago protegido, confirmación— y lo lleva hasta el punto que se quiere probar.
-- Lo que se comprueba no es solo que el camino feliz funcione, sino que lo
-- prohibido falle: que el cliente no avance el trabajo por el trabajador, que
-- el trabajador no se acepte su propia extensión, que un PIN usado no valga
-- otra vez, y que nadie escriba estas tablas a mano.
--
-- Las carreras reales (dos respuestas a una extensión a la vez, dos
-- validaciones del PIN a la vez, dos aprobaciones a la vez) están en
-- 08_race_execution.sh, porque necesitan dos sesiones de verdad.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Montaje: un trabajo pagado y listo para comenzar.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.montar_trabajo(
  p_tag text,
  p_pagado boolean default true,
  p_lat numeric default -33.4265,
  p_lng numeric default -70.6153,
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
  v_tag text;
begin
  -- Sufijo aleatorio: el identificador del proveedor es único en la base, y así
  -- la batería se puede repetir sobre la misma base mientras se depura.
  v_tag := p_tag || '-' || substr(md5(random()::text), 1, 6);

  select w.user_id into worker_id from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select u.id into client_id from auth.users u
   where u.id <> worker_id and exists (select 1 from public.profiles p where p.id = u.id)
   order by u.id limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (
    id, client_id, category_id, status, title, description, region_code, commune_code,
    place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at
  ) values (
    job_id, client_id, (select id from public.job_categories order by sort_order limit 1), 'PUBLISHED',
    'Prueba de ejecución ' || p_tag,
    'Montaje de la prueba de ejecución completa del trabajo asignado.',
    '13', '13-santiago', 'Lugar de prueba', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now()
  );

  -- La dirección exacta: es contra estas coordenadas que se mide el check-in.
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', p_lat, p_lng);

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, worker_id, 9000, 18000, 'Oferta de prueba ' || p_tag)
  returning id into v_offer;

  perform set_config('request.jwt.claim.sub', client_id::text, true);
  assignment_id := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(assignment_id);
  perform set_config('request.jwt.claim.sub', '', true);

  if p_pagado then
    update public.payments
       set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-' || v_tag
     where id = payment_id;
    perform public.confirm_payment_result(payment_id, 'mock', 'evt-' || v_tag, 'PAID', null, '{}');
  end if;
end;
$$;

-- Atajo: el recorrido del trabajador hasta el trabajo en curso.
create or replace function pg_temp.hasta_en_curso(p_a uuid, p_w uuid, p_lat numeric default -33.4265, p_lng numeric default -70.6153)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_w::text, true);
  perform public.mark_on_the_way(p_a);
  perform public.register_check_in(p_a, true, p_lat, p_lng, 20, 'device');
  perform public.start_job_work(p_a);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

\echo ''
\echo '--- Recorrido completo del trabajo'

-- E01 · Camino feliz entero, paso a paso.
do $$
declare
  m record; r jsonb; v_asg text; v_job text; v_eventos int; v_payout record; v_ext uuid; v_code text;
  v_ok boolean;
begin
  select * into m from pg_temp.montar_trabajo('e01');

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  r := public.mark_on_the_way(m.assignment_id);
  select status into v_asg from public.assignments where id = m.assignment_id;
  raise notice '%', 'E01a voy en camino: asignación ' || v_asg
    || case when v_asg = 'ON_THE_WAY' and (r ->> 'repeated') = 'false' then '' else ' FALLO' end;

  r := public.register_check_in(m.assignment_id, true, -33.4265, -70.6153, 15, 'device');
  select status into v_asg from public.assignments where id = m.assignment_id;
  raise notice '%', 'E01b check-in: ' || (r ->> 'result') || ', distancia ' || coalesce(r ->> 'distance_m', '-')
    || ' m, asignación ' || v_asg
    || case when (r ->> 'result') = 'VERIFIED' and v_asg = 'CHECKED_IN' and (r ->> 'can_start') = 'true'
            then '' else ' FALLO' end;

  r := public.start_job_work(m.assignment_id);
  select status into v_asg from public.assignments where id = m.assignment_id;
  select status into v_job from public.jobs where id = m.job_id;
  raise notice '%', 'E01c inicio: asignación ' || v_asg || ', trabajo ' || v_job
    || case when v_asg = 'IN_PROGRESS' and v_job = 'IN_PROGRESS' and (r ->> 'expected_end_at') is not null
            then '' else ' FALLO' end;

  perform public.add_job_evidence(m.assignment_id, 'QUEUE_STATUS', 'Voy avanzando',
                                  'Quedan pocas personas por delante.', null, null, null, 4);
  perform public.request_handoff_code(m.assignment_id);
  perform set_config('request.jwt.claim.sub', '', true);

  -- El cliente genera el código y lo comparte.
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  v_code := public.generate_handoff_code(m.assignment_id);
  perform set_config('request.jwt.claim.sub', '', true);

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  v_ok := public.verify_handoff_code(m.assignment_id, v_code);
  select status into v_asg from public.assignments where id = m.assignment_id;
  raise notice '%', 'E01d entrega con código: ' || v_ok::text || ', asignación ' || v_asg
    || case when v_ok and v_asg = 'HANDOFF_COMPLETED' then '' else ' FALLO' end;
  perform set_config('request.jwt.claim.sub', '', true);

  -- El cliente aprueba: aquí, y solo aquí, se libera el pago al trabajador.
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  r := public.approve_job_completion(m.assignment_id, true);
  perform set_config('request.jwt.claim.sub', '', true);

  select status into v_asg from public.assignments where id = m.assignment_id;
  select status into v_job from public.jobs where id = m.job_id;
  select * into v_payout from public.payouts where assignment_id = m.assignment_id;
  select count(*) into v_eventos from public.job_evidence where assignment_id = m.assignment_id;

  raise notice '%', 'E01e aprobación: asignación ' || v_asg || ', trabajo ' || v_job
    || ', payout ' || v_payout.status || ', neto ' || v_payout.net_amount
    || ', hitos en la línea de tiempo ' || v_eventos
    || case when v_asg = 'COMPLETED' and v_job = 'COMPLETED' and v_payout.status = 'APPROVED'
             and v_payout.net_amount = 18000 - round(18000 * 0.14) + 3000
             and v_eventos >= 6 then '' else ' FALLO' end;
end $$;

-- E02 · Los tiempos y el plazo de disputa los pone el servidor.
do $$
declare m record; v record; v_win int;
begin
  select * into m from pg_temp.montar_trabajo('e02');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.request_job_completion(m.assignment_id, 'Todo listo.');
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.approve_job_completion(m.assignment_id, true);
  perform set_config('request.jwt.claim.sub', '', true);

  select started_at, expected_end_at, completed_at, dispute_deadline_at, checked_in_at, on_the_way_at
    into v from public.assignments where id = m.assignment_id;
  select dispute_window_hours into v_win from public.platform_settings where id;

  raise notice '%', 'E02 marcas de tiempo del servidor: '
    || case when v.on_the_way_at is not null and v.checked_in_at is not null
             and v.started_at is not null and v.completed_at is not null
             and v.expected_end_at = v.started_at + interval '120 minutes'
             and v.dispute_deadline_at between v.completed_at + make_interval(hours => v_win) - interval '1 minute'
                                          and v.completed_at + make_interval(hours => v_win) + interval '1 minute'
            then 'todas correctas' else 'FALLO' end;
end $$;

\echo ''
\echo '--- Check-in: consentimiento, distancia y revisión'

-- E03 · Sin consentimiento no hay check-in.
do $$
declare m record; v text := 'permitido';
begin
  select * into m from pg_temp.montar_trabajo('e03');
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.mark_on_the_way(m.assignment_id);
  begin
    perform public.register_check_in(m.assignment_id, false, -33.4265, -70.6153, 10, 'device');
  exception when check_violation then v := 'rechazado';
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '%', 'E03 check-in sin consentimiento: ' || v
    || case when v = 'rechazado' then '' else ' FALLO' end;
end $$;

-- E04 · Lejos del lugar: se registra, no se da por bueno, y no deja comenzar.
do $$
declare m record; r jsonb; v_start text := 'permitido'; v_ci record;
begin
  select * into m from pg_temp.montar_trabajo('e04');
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.mark_on_the_way(m.assignment_id);
  -- Un kilómetro y medio al norte, muy por fuera del radio.
  r := public.register_check_in(m.assignment_id, true, -33.4130, -70.6153, 15, 'device');
  begin
    perform public.start_job_work(m.assignment_id);
  exception when check_violation then v_start := 'rechazado';
  end;
  perform set_config('request.jwt.claim.sub', '', true);

  select result, review_status, distance_m into v_ci
    from public.assignment_check_ins where assignment_id = m.assignment_id;

  raise notice '%', 'E04 check-in lejos: ' || v_ci.result || ' (' || v_ci.review_status
    || ', ' || v_ci.distance_m || ' m), comenzar ' || v_start
    || case when v_ci.result = 'OUT_OF_RANGE' and v_ci.review_status = 'PENDING'
             and v_ci.distance_m > 1000 and v_start = 'rechazado' then '' else ' FALLO' end;
end $$;

-- E05 · La administración aprueba a mano y entonces sí se puede comenzar.
do $$
declare m record; v_admin uuid; v_ci uuid; v_start text := 'rechazado'; v_asg text;
begin
  select * into m from pg_temp.montar_trabajo('e05');
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.mark_on_the_way(m.assignment_id);
  perform public.register_check_in(m.assignment_id, true, -33.4130, -70.6153, 15, 'device');
  perform set_config('request.jwt.claim.sub', '', true);

  select id into v_ci from public.assignment_check_ins where assignment_id = m.assignment_id;
  select id into v_admin from public.profiles where role = 'ADMIN' limit 1;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform public.review_check_in(v_ci, true, 'Foto de la fila coherente con el lugar.');
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  begin
    perform public.start_job_work(m.assignment_id);
    v_start := 'permitido';
  exception when check_violation then v_start := 'rechazado';
  end;
  perform set_config('request.jwt.claim.sub', '', true);

  select status into v_asg from public.assignments where id = m.assignment_id;
  raise notice '%', 'E05 revisión manual: comenzar ' || v_start || ', asignación ' || v_asg
    || case when v_start = 'permitido' and v_asg = 'IN_PROGRESS' then '' else ' FALLO' end;
end $$;

-- E06 · Sin ubicación y con mala precisión: quedan en revisión, no se inventan.
do $$
declare m record; r1 jsonb; r2 jsonb;
begin
  select * into m from pg_temp.montar_trabajo('e06');
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.mark_on_the_way(m.assignment_id);
  r1 := public.register_check_in(m.assignment_id, true, null, null, null, 'manual');
  r2 := public.register_check_in(m.assignment_id, true, -33.4265, -70.6153, 900, 'device');
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '%', 'E06 sin ubicación / poca precisión: ' || (r1 ->> 'result') || ' y ' || (r2 ->> 'result')
    || case when (r1 ->> 'result') = 'NO_LOCATION' and (r2 ->> 'result') = 'LOW_ACCURACY'
             and (r1 ->> 'can_start') = 'false' and (r2 ->> 'can_start') = 'false'
            then '' else ' FALLO' end;
end $$;

-- E07 · Las coordenadas no salen a la línea de tiempo ni al cliente.
do $$
declare m record; v_coords int; v_tl text; v_lee int;
begin
  select * into m from pg_temp.montar_trabajo('e07');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);

  select count(*) into v_coords from public.job_evidence
   where assignment_id = m.assignment_id and (lat is not null or lng is not null);
  select body into v_tl from public.job_evidence
   where assignment_id = m.assignment_id and event_key = 'check_in';

  -- El cliente consulta la tabla privada de check-ins: no le corresponde.
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  execute 'set local role authenticated';
  select count(*) into v_lee from public.assignment_check_ins where assignment_id = m.assignment_id;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  raise notice '%', 'E07 privacidad de la ubicación: evidencias con coordenadas ' || v_coords
    || ', filas de check-in visibles para el cliente ' || v_lee
    || case when v_coords = 0 and v_lee = 0
             and v_tl not like '%-33%' and v_tl not like '%-70%' then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Quién puede hacer qué'

-- E08 · El cliente no avanza el trabajo por el trabajador, y al revés.
do $$
declare m record; a text := 'permitido'; b text := 'permitido'; c text := 'permitido'; d text := 'permitido';
begin
  select * into m from pg_temp.montar_trabajo('e08');

  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  begin perform public.mark_on_the_way(m.assignment_id);
  exception when insufficient_privilege then a := 'rechazado'; end;
  begin perform public.register_check_in(m.assignment_id, true, -33.4265, -70.6153, 10, 'device');
  exception when insufficient_privilege then b := 'rechazado'; end;

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.mark_on_the_way(m.assignment_id);
  perform public.register_check_in(m.assignment_id, true, -33.4265, -70.6153, 10, 'device');
  perform public.start_job_work(m.assignment_id);
  perform public.request_job_completion(m.assignment_id, null);
  -- El trabajador no se aprueba su propio trabajo.
  begin perform public.approve_job_completion(m.assignment_id, true);
  exception when insufficient_privilege then c := 'rechazado'; end;
  -- Ni genera el código de entrega.
  begin perform public.generate_handoff_code(m.assignment_id);
  exception when insufficient_privilege then d := 'rechazado'; end;
  perform set_config('request.jwt.claim.sub', '', true);

  raise notice '%', 'E08 papeles: cliente en camino ' || a || ', cliente check-in ' || b
    || ', trabajador aprueba ' || c || ', trabajador genera PIN ' || d
    || case when a = 'rechazado' and b = 'rechazado' and c = 'rechazado' and d = 'rechazado'
            then '' else ' FALLO' end;
end $$;

-- E09 · Un tercero no toca nada.
do $$
declare m record; v_otro uuid; a text := 'permitido'; b text := 'permitido'; c text := 'permitido';
begin
  select * into m from pg_temp.montar_trabajo('e09');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);
  select id into v_otro from auth.users where id not in (m.client_id, m.worker_id)
    and exists (select 1 from public.profiles p where p.id = auth.users.id
                 and coalesce(p.role, 'CLIENT') <> 'ADMIN') limit 1;

  perform set_config('request.jwt.claim.sub', v_otro::text, true);
  begin perform public.add_job_evidence(m.assignment_id, 'NOTE', 'Intruso', 'Nada');
  exception when insufficient_privilege then a := 'rechazado'; end;
  begin perform public.get_handoff_code(m.assignment_id);
  exception when insufficient_privilege then b := 'rechazado'; end;
  begin perform public.open_dispute(m.assignment_id, 'Da igual', 'Descripción suficientemente larga para pasar.');
  exception when insufficient_privilege then c := 'rechazado'; end;
  perform set_config('request.jwt.claim.sub', '', true);

  raise notice '%', 'E09 tercero: evidencia ' || a || ', PIN ' || b || ', disputa ' || c
    || case when a = 'rechazado' and b = 'rechazado' and c = 'rechazado' then '' else ' FALLO' end;
end $$;

-- E10 · Las escrituras directas ya no existen para nadie con sesión.
do $$
declare
  m record; a text := 'permitido'; b text := 'permitido'; c text := 'permitido';
  d text := 'permitido'; e text := 'permitido';
begin
  select * into m from pg_temp.montar_trabajo('e10');
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  execute 'set local role authenticated';

  begin update public.assignments set status = 'ON_THE_WAY' where id = m.assignment_id;
  exception when insufficient_privilege then a := 'sin privilegio'; end;

  begin insert into public.job_evidence (job_id, assignment_id, author_id, evidence_type, title)
        values (m.job_id, m.assignment_id, m.worker_id, 'SYSTEM', 'Hito falso');
  exception when insufficient_privilege then b := 'sin privilegio'; end;

  begin insert into public.job_extensions (assignment_id, requested_by, additional_minutes,
          hourly_rate, additional_amount, expires_at)
        values (m.assignment_id, m.worker_id, 60, 9000, 9000, now() + interval '1 hour');
  exception when insufficient_privilege then c := 'sin privilegio'; end;

  begin insert into public.disputes (assignment_id, opened_by, reason, description)
        values (m.assignment_id, m.worker_id, 'x', 'Descripción larga para pasar el check.');
  exception when insufficient_privilege then d := 'sin privilegio'; end;

  begin select code into strict e from public.handoff_codes where assignment_id = m.assignment_id;
  exception when insufficient_privilege then e := 'sin privilegio';
            when no_data_found then e := 'sin privilegio';
  end;

  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  raise notice '%', 'E10 escrituras directas: asignación ' || a || ', evidencia ' || b
    || ', extensión ' || c || ', disputa ' || d
    || case when a = 'sin privilegio' and b = 'sin privilegio' and c = 'sin privilegio'
             and d = 'sin privilegio' then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Extensiones de tiempo'

-- E11 · Solicitar, aceptar, y que el importe lo calcule la base.
do $$
declare m record; v_ext uuid; r jsonb; v_e record; v_a record; v_pay record;
begin
  select * into m from pg_temp.montar_trabajo('e11');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  v_ext := public.request_job_extension(m.assignment_id, 60, 'La fila avanza más lento de lo previsto.');
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  r := public.answer_job_extension(v_ext, true);
  perform set_config('request.jwt.claim.sub', '', true);

  select * into v_e from public.job_extensions where id = v_ext;
  select agreed_duration_minutes, extension_minutes, expected_end_at into v_a
    from public.assignments where id = m.assignment_id;
  select * into v_pay from public.payments where id = (r ->> 'payment_id')::uuid;

  raise notice '%', 'E11 extensión aceptada: ' || v_e.additional_minutes || ' min, importe '
    || v_e.additional_amount || ', acuerdo original ' || v_a.agreed_duration_minutes
    || ', extensión acumulada ' || v_a.extension_minutes
    || ', pago adicional ' || v_pay.purpose || '/' || v_pay.status || ' ' || v_pay.amount
    || case when v_e.status = 'ACCEPTED' and v_e.additional_amount = 9000
             and v_a.agreed_duration_minutes = 120 and v_a.extension_minutes = 60
             and v_pay.purpose = 'EXTENSION' and v_pay.status = 'PENDING' and v_pay.amount = 9000
            then '' else ' FALLO' end;
end $$;

-- E12 · El trabajador no se acepta su propia extensión, ni la responde dos veces.
do $$
declare m record; v_ext uuid; a text := 'permitido'; b text := 'permitido'; c text := 'permitido';
begin
  select * into m from pg_temp.montar_trabajo('e12');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  v_ext := public.request_job_extension(m.assignment_id, 30, null);
  -- Dos solicitudes pendientes a la vez, no.
  begin perform public.request_job_extension(m.assignment_id, 45, null);
  exception when check_violation then b := 'rechazada'; end;
  -- Y el propio trabajador no responde.
  begin perform public.answer_job_extension(v_ext, true);
  exception when insufficient_privilege then a := 'rechazado'; end;

  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.answer_job_extension(v_ext, false);
  begin perform public.answer_job_extension(v_ext, true);
  exception when check_violation then c := 'rechazada'; end;
  perform set_config('request.jwt.claim.sub', '', true);

  raise notice '%', 'E12 extensión, lo prohibido: autoaceptación ' || a
    || ', segunda solicitud ' || b || ', segunda respuesta ' || c
    || case when a = 'rechazado' and b = 'rechazada' and c = 'rechazada' then '' else ' FALLO' end;
end $$;

-- E13 · El importe no se puede manipular, ni la solicitud reescribir.
do $$
declare m record; v_ext uuid; a text := 'permitido'; b text := 'permitido'; c text := 'permitido';
begin
  select * into m from pg_temp.montar_trabajo('e13');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  -- Bloques de 15 minutos, y dentro del máximo.
  begin perform public.request_job_extension(m.assignment_id, 17, null);
  exception when check_violation then a := 'rechazada'; end;
  begin perform public.request_job_extension(m.assignment_id, 5000, null);
  exception when check_violation then b := 'rechazada'; end;
  v_ext := public.request_job_extension(m.assignment_id, 60, null);

  execute 'set local role authenticated';
  begin update public.job_extensions set additional_amount = 1, status = 'ACCEPTED' where id = v_ext;
  exception when insufficient_privilege then c := 'sin privilegio'; end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);

  raise notice '%', 'E13 importes: 17 min ' || a || ', 5000 min ' || b || ', reescritura ' || c
    || case when a = 'rechazada' and b = 'rechazada' and c = 'sin privilegio' then '' else ' FALLO' end;
end $$;

-- E14 · El pago adicional confirmado suma al payout y no habilita nada nuevo.
do $$
declare m record; v_ext uuid; r jsonb; v_pay uuid; v_po record; v_antes bigint; v_job text;
begin
  select * into m from pg_temp.montar_trabajo('e14');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);
  select net_amount into v_antes from public.payouts where assignment_id = m.assignment_id;

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  v_ext := public.request_job_extension(m.assignment_id, 60, null);
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  r := public.answer_job_extension(v_ext, true);
  v_pay := public.start_extension_payment(v_ext);
  perform set_config('request.jwt.claim.sub', '', true);

  update public.payments set status = 'CREATED', provider = 'mock',
         provider_transaction_id = 'mock-e14-ext-' || substr(md5(random()::text), 1, 6)
   where id = v_pay;
  perform public.confirm_payment_result(v_pay, 'mock',
    'evt-e14-ext-' || substr(md5(random()::text), 1, 6), 'PAID', 9000, '{}');

  select * into v_po from public.payouts where assignment_id = m.assignment_id;
  select status into v_job from public.jobs where id = m.job_id;

  raise notice '%', 'E14 pago del tiempo adicional: payout neto ' || v_antes || ' → ' || v_po.net_amount
    || ', estado ' || v_po.status || ', trabajo ' || v_job
    || case when v_po.net_amount = v_antes + 9000 - round(9000 * 0.14)
             and v_po.status = 'PENDING' and v_job = 'IN_PROGRESS'
            then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Código de entrega'

-- E15 · Correcto, incorrecto, reutilizado y con intentos agotados.
do $$
declare
  m record; v_code text; v_ok boolean; v_mal boolean;
  a text := 'permitido'; b text := 'permitido'; v_intentos int;
begin
  select * into m from pg_temp.montar_trabajo('e15');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);

  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  v_code := public.generate_handoff_code(m.assignment_id);
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);

  v_mal := public.verify_handoff_code(m.assignment_id, case when v_code = '0000' then '1111' else '0000' end);
  v_ok := public.verify_handoff_code(m.assignment_id, v_code);
  -- Ya usado: no vale otra vez.
  begin perform public.verify_handoff_code(m.assignment_id, v_code);
  exception when check_violation then a := 'rechazado'; end;
  perform set_config('request.jwt.claim.sub', '', true);

  select attempts into v_intentos from public.handoff_codes where assignment_id = m.assignment_id;

  raise notice '%', 'E15 código: incorrecto ' || v_mal::text || ', correcto ' || v_ok::text
    || ', reutilizado ' || a || ', intentos ' || v_intentos
    || case when not v_mal and v_ok and a = 'rechazado' and v_intentos = 1 then '' else ' FALLO' end;
end $$;

-- E16 · Expirado, de otro trabajo, con intentos agotados y pedido por quien no es.
do $$
declare
  m record; m2 record; v_code text; a text := 'permitido'; b text := 'permitido';
  c text := 'permitido'; d text := 'permitido'; i int;
begin
  select * into m from pg_temp.montar_trabajo('e16');
  select * into m2 from pg_temp.montar_trabajo('e16b');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);
  perform pg_temp.hasta_en_curso(m2.assignment_id, m2.worker_id);

  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  v_code := public.generate_handoff_code(m.assignment_id);
  perform set_config('request.jwt.claim.sub', '', true);

  -- Cinco fallos agotan los intentos.
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  for i in 1..5 loop
    perform public.verify_handoff_code(m.assignment_id, case when v_code = '9999' then '1111' else '9999' end);
  end loop;
  begin perform public.verify_handoff_code(m.assignment_id, v_code);
  exception when check_violation then a := 'rechazado'; end;
  perform set_config('request.jwt.claim.sub', '', true);

  -- Expirado.
  perform set_config('request.jwt.claim.sub', m2.client_id::text, true);
  v_code := public.generate_handoff_code(m2.assignment_id);
  perform set_config('request.jwt.claim.sub', '', true);
  update public.handoff_codes set expires_at = now() - interval '1 minute'
   where assignment_id = m2.assignment_id;
  perform set_config('request.jwt.claim.sub', m2.worker_id::text, true);
  begin perform public.verify_handoff_code(m2.assignment_id, v_code);
  exception when check_violation then b := 'rechazado'; end;
  perform set_config('request.jwt.claim.sub', '', true);

  -- Y regenerar tras la expiración sí funciona (antes era imposible).
  perform set_config('request.jwt.claim.sub', m2.client_id::text, true);
  v_code := public.generate_handoff_code(m2.assignment_id);
  perform set_config('request.jwt.claim.sub', m2.worker_id::text, true);
  if public.verify_handoff_code(m2.assignment_id, v_code) then c := 'regenerado'; end if;
  perform set_config('request.jwt.claim.sub', '', true);

  -- El PIN no aparece en la bitácora ni en los avisos.
  select count(*) into i from public.notifications
   where body like '%' || v_code || '%' or title like '%' || v_code || '%';
  if i = 0 then d := 'no aparece'; end if;

  raise notice '%', 'E16 código: intentos agotados ' || a || ', expirado ' || b
    || ', regeneración ' || c || ', en avisos ' || d
    || case when a = 'rechazado' and b = 'rechazado' and c = 'regenerado' and d = 'no aparece'
            then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Finalización y aprobación'

-- E17 · El botón del trabajador no libera el pago.
do $$
declare m record; v_po text; v_asg text; v_po2 text;
begin
  select * into m from pg_temp.montar_trabajo('e17');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.request_job_completion(m.assignment_id, 'Terminé la fila.');
  perform set_config('request.jwt.claim.sub', '', true);

  select status into v_asg from public.assignments where id = m.assignment_id;
  select status into v_po from public.payouts where assignment_id = m.assignment_id;

  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.approve_job_completion(m.assignment_id, true);
  perform set_config('request.jwt.claim.sub', '', true);
  select status into v_po2 from public.payouts where assignment_id = m.assignment_id;

  raise notice '%', 'E17 finalización en dos pasos: tras pedirla asignación ' || v_asg
    || ' y payout ' || v_po || '; tras aprobarla payout ' || v_po2
    || case when v_asg = 'HANDOFF_COMPLETED' and v_po = 'PENDING' and v_po2 = 'APPROVED'
            then '' else ' FALLO' end;
end $$;

-- E18 · Aprobar dos veces no cambia nada; sin bono, el payout baja.
do $$
declare m record; r1 jsonb; r2 jsonb; v_po record;
begin
  select * into m from pg_temp.montar_trabajo('e18');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.request_job_completion(m.assignment_id, null);
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  r1 := public.approve_job_completion(m.assignment_id, false);
  r2 := public.approve_job_completion(m.assignment_id, false);
  perform set_config('request.jwt.claim.sub', '', true);

  select * into v_po from public.payouts where assignment_id = m.assignment_id;

  raise notice '%', 'E18 doble aprobación: primera ' || (r1 ->> 'repeated') || ', segunda '
    || (r2 ->> 'repeated') || ', bono en el payout ' || v_po.bonus_amount
    || ', neto ' || v_po.net_amount
    || case when (r1 ->> 'repeated') = 'false' and (r2 ->> 'repeated') = 'true'
             and v_po.bonus_amount = 0 and v_po.net_amount = 18000 - round(18000 * 0.14)
            then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Disputas'

-- E19 · Abrir retiene el payout y pasa el trabajo a disputa.
do $$
declare m record; v_d uuid; v_po text; v_job text; v_ev uuid;
begin
  select * into m from pg_temp.montar_trabajo('e19');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);

  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  v_d := public.open_dispute(m.assignment_id, 'Problema con la entrega',
                             'El trabajador no consiguió lo acordado y quiero revisarlo.');
  v_ev := public.add_dispute_evidence(v_d, 'Adjunto lo que me llegó.', null, null, null);
  perform set_config('request.jwt.claim.sub', '', true);

  select status into v_po from public.payouts where assignment_id = m.assignment_id;
  select status into v_job from public.jobs where id = m.job_id;

  raise notice '%', 'E19 disputa abierta: payout ' || v_po || ', trabajo ' || v_job
    || ', pruebas ' || case when v_ev is null then 'ninguna' else 'una' end
    || case when v_po = 'HELD' and v_job = 'DISPUTED' and v_ev is not null then '' else ' FALLO' end;
end $$;

-- E20 · Solo la administración resuelve, y la resolución tiene consecuencias.
do $$
declare
  m record; v_d uuid; v_admin uuid; a text := 'permitido'; r jsonb;
  v_po record; v_job text; v_pay text;
begin
  select * into m from pg_temp.montar_trabajo('e20');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);
  select id into v_admin from public.profiles where role = 'ADMIN' limit 1;

  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  v_d := public.open_dispute(m.assignment_id, 'No cumplió',
                             'El trabajo no se realizó como habíamos acordado por chat.');
  -- El cliente intenta resolverla a su favor.
  begin perform public.resolve_dispute(v_d, 'CLIENT_WINS', 'Me la resuelvo yo mismo.', null);
  exception when insufficient_privilege then a := 'rechazado'; end;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  r := public.resolve_dispute(v_d, 'PARTIAL', 'Se hizo parte del trabajo: se devuelve la mitad.', 9000);
  perform set_config('request.jwt.claim.sub', '', true);

  select * into v_po from public.payouts where assignment_id = m.assignment_id;
  select status into v_job from public.jobs where id = m.job_id;
  select status || '/' || coalesce(review_reason, '-') into v_pay from public.payments
   where assignment_id = m.assignment_id and purpose = 'JOB';

  raise notice '%', 'E20 resolución: cliente resuelve ' || a || ', resultado ' || (r ->> 'resolution')
    || ', payout ' || v_po.status || ' neto ' || v_po.net_amount
    || ', trabajo ' || v_job || ', pago ' || v_pay || ', a devolver ' || (r ->> 'refund_registered')
    || case when a = 'rechazado' and (r ->> 'resolution') = 'PARTIAL'
             and v_po.status = 'APPROVED' and v_job = 'CLOSED'
             and v_pay = 'PAID/-' then '' else ' FALLO' end;
end $$;

-- E21 · A favor del cliente, el trabajador no cobra.
do $$
declare m record; v_d uuid; v_admin uuid; v_po record; a text := 'permitido';
begin
  select * into m from pg_temp.montar_trabajo('e21');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);
  select id into v_admin from public.profiles where role = 'ADMIN' limit 1;

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  v_d := public.open_dispute(m.assignment_id, 'El cliente no apareció',
                             'Esperé el tiempo acordado y nadie vino a recibir el encargo.');
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform public.resolve_dispute(v_d, 'CLIENT_WINS', 'La evidencia no respalda el trabajo.', null);
  -- Y un pago cancelado no se puede registrar como transferido.
  begin perform public.mark_payout_paid(
    (select id from public.payouts where assignment_id = m.assignment_id), 'TRX-123', null, null);
  exception when check_violation then a := 'rechazado'; end;
  perform set_config('request.jwt.claim.sub', '', true);

  select * into v_po from public.payouts where assignment_id = m.assignment_id;
  raise notice '%', 'E21 a favor del cliente: payout ' || v_po.status || ' neto ' || v_po.net_amount
    || ', transferir ' || a
    || case when v_po.status = 'CANCELLED' and v_po.net_amount = 0 and a = 'rechazado'
            then '' else ' FALLO' end;
end $$;

-- E22 · Con disputa abierta, el cliente no puede aprobar el trabajo.
do $$
declare m record; v_d uuid; a text := 'permitido';
begin
  select * into m from pg_temp.montar_trabajo('e22');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  v_d := public.open_dispute(m.assignment_id, 'Llegó tarde',
                             'Quiero revisar el cobro antes de aprobar este trabajo.');
  begin perform public.approve_job_completion(m.assignment_id, true);
  exception when check_violation then a := 'rechazado'; end;
  perform set_config('request.jwt.claim.sub', '', true);
  raise notice '%', 'E22 aprobar con disputa abierta: ' || a
    || case when a = 'rechazado' then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Pago al trabajador y reseñas'

-- E23 · Aprobar, transferir con referencia, y que sea idempotente.
do $$
declare m record; v_admin uuid; v_po uuid; r1 jsonb; r2 jsonb; v record; a text := 'permitido';
begin
  select * into m from pg_temp.montar_trabajo('e23');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.request_job_completion(m.assignment_id, null);
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.approve_job_completion(m.assignment_id, true);
  perform set_config('request.jwt.claim.sub', '', true);

  select id into v_po from public.payouts where assignment_id = m.assignment_id;
  select id into v_admin from public.profiles where role = 'ADMIN' limit 1;

  -- Sin referencia bancaria no se registra nada.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  begin perform public.mark_payout_paid(v_po, 'x', null, null);
  exception when check_violation then a := 'rechazado'; end;

  r1 := public.mark_payout_paid(v_po, 'TRX-2026-0001', now(), 'Transferencia manual');
  r2 := public.mark_payout_paid(v_po, 'TRX-2026-0001', now(), null);
  perform set_config('request.jwt.claim.sub', '', true);

  select status, bank_reference, paid_at into v from public.payouts where id = v_po;
  raise notice '%', 'E23 transferencia: referencia corta ' || a || ', estado ' || v.status
    || ', referencia ' || v.bank_reference || ', repetida ' || (r2 ->> 'repeated')
    || case when a = 'rechazado' and v.status = 'PAID' and v.bank_reference = 'TRX-2026-0001'
             and v.paid_at is not null and (r2 ->> 'repeated') = 'true' then '' else ' FALLO' end;
end $$;

-- E24 · Reseñas: solo tras la aprobación, una por parte, y sin autorreseña.
do $$
declare
  m record; a text := 'permitido'; b text := 'permitido'; v1 uuid; v2 uuid;
  v_rep record;
begin
  select * into m from pg_temp.montar_trabajo('e24');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);

  -- Antes de aprobar, no.
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  begin perform public.submit_review(m.assignment_id, 5, 5, 5, 5, 'Excelente');
  exception when check_violation then a := 'rechazada'; end;

  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.request_job_completion(m.assignment_id, null);
  perform set_config('request.jwt.claim.sub', m.client_id::text, true);
  perform public.approve_job_completion(m.assignment_id, true);

  v1 := public.submit_review(m.assignment_id, 5, 5, 4, 5, 'Puntual y claro.');
  begin perform public.submit_review(m.assignment_id, 1, 1, 1, 1, 'Me arrepentí');
  exception when unique_violation then b := 'rechazada'; end;
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  v2 := public.submit_review(m.assignment_id, 5, 5, 5, 5, 'Cliente claro con las instrucciones.');
  perform set_config('request.jwt.claim.sub', '', true);

  select average_rating, review_count, completed_jobs, worked_minutes, completion_rate
    into v_rep from public.worker_profiles where user_id = m.worker_id;

  raise notice '%', 'E24 reseñas: antes de aprobar ' || a || ', segunda del mismo ' || b
    || ', nota media ' || v_rep.average_rating || ', trabajos completados ' || v_rep.completed_jobs
    || ', minutos ' || v_rep.worked_minutes
    || case when a = 'rechazada' and b = 'rechazada' and v1 is not null and v2 is not null
             and v_rep.review_count >= 1 and v_rep.completed_jobs >= 1
             and v_rep.worked_minutes >= 120 then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Línea de tiempo e invariantes'

-- E25 · Repetir una acción no duplica la línea de tiempo.
do $$
declare m record; v_antes int; v_despues int; r jsonb;
begin
  select * into m from pg_temp.montar_trabajo('e25');
  perform set_config('request.jwt.claim.sub', m.worker_id::text, true);
  perform public.mark_on_the_way(m.assignment_id);
  select count(*) into v_antes from public.job_evidence where assignment_id = m.assignment_id;
  r := public.mark_on_the_way(m.assignment_id);
  perform public.register_check_in(m.assignment_id, true, -33.4265, -70.6153, 10, 'device');
  perform public.register_check_in(m.assignment_id, true, -33.4265, -70.6153, 10, 'device');
  select count(*) into v_despues from public.job_evidence
   where assignment_id = m.assignment_id and event_key is not null;
  perform set_config('request.jwt.claim.sub', '', true);

  raise notice '%', 'E25 hitos idempotentes: repetido ' || (r ->> 'repeated')
    || ', hitos distintos ' || v_despues
    || case when (r ->> 'repeated') = 'true' and v_despues = 2 then '' else ' FALLO' end;
end $$;

-- E26 · La bitácora de auditoría registra lo que importa.
do $$
declare m record; v_acciones int;
begin
  select * into m from pg_temp.montar_trabajo('e26');
  perform pg_temp.hasta_en_curso(m.assignment_id, m.worker_id);
  select count(*) into v_acciones from public.audit_logs
   where entity_id = m.assignment_id and entity_type = 'assignments';
  raise notice '%', 'E26 auditoría de la asignación: ' || v_acciones || ' entradas'
    || case when v_acciones >= 3 then '' else ' FALLO' end;
end $$;

-- E27 · Los invariantes del dinero siguen en cero tras todo el recorrido.
do $$
declare v text;
begin
  select coalesce(string_agg(rule || ':' || entity_id, ', '), 'ninguna') into v
    from app_private.payment_invariant_violations();
  raise notice '%', 'E27 violaciones de invariantes = ' || v
    || case when v = 'ninguna' then '' else ' FALLO' end;
end $$;

-- E28 · Ningún payout sobre un trabajo cancelado o en disputa sin resolver.
do $$
declare v int;
begin
  select count(*) into v
    from public.payouts p
    join public.assignments a on a.id = p.assignment_id
    join public.jobs j on j.id = a.job_id
   where p.status in ('APPROVED', 'PROCESSING', 'PAID')
     and (j.status in ('CANCELLED', 'CANCELLATION_PENDING', 'EXPIRED')
          or exists (select 1 from public.disputes d
                      where d.assignment_id = a.id and d.status in ('OPEN', 'UNDER_REVIEW')));
  raise notice '%', 'E28 pagos liberados sobre trabajo cancelado o en disputa = ' || v
    || case when v = 0 then '' else ' FALLO' end;
end $$;
