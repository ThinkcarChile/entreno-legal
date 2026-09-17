\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Las 16 RPC no se pueden rodear ni llamar sin sesión
-- =============================================================================
-- Cada comprobación de aquí falla si se quita la línea que la protege. No son
-- afirmaciones sobre el diseño: son los abusos que se encontraron al auditar las
-- funciones una por una, convertidos en prueba.
--
-- Esta batería vive en el PostgreSQL local y no en `verify:supabase` porque
-- necesita algo que por la API no se puede montar: una llamada con `auth.uid()`
-- nulo. Contra Supabase, cualquier sesión trae siempre el claim `sub`.
-- =============================================================================

\echo ''
\echo '--- Sin sesión, ninguna función hace nada'

-- Con auth.uid() nulo, una comparación `dueño <> auth.uid()` vale NULL y el IF
-- no entra en la rama: la comprobación de pertenencia se salta sola. Ocho de las
-- dieciséis estaban así. Se prueban las ocho.
do $$
declare
  v_job uuid;
  v_offer uuid;
  v_assignment uuid;
  v_worker uuid;
  v_conv uuid;
  v_ok integer := 0;
  v_total integer := 8;
begin
  select id into v_job from public.jobs where status = 'PUBLISHED' limit 1;
  select id, worker_id into v_offer, v_worker from public.job_offers where status = 'PENDING' limit 1;
  select id into v_assignment from public.assignments limit 1;
  select id into v_conv from public.conversations limit 1;

  begin perform public.accept_job_offer(v_offer);
  exception when insufficient_privilege then v_ok := v_ok + 1; end;

  begin perform public.cancel_job(v_job, 'sin sesión');
  exception when insufficient_privilege then v_ok := v_ok + 1; end;

  begin perform public.generate_handoff_code(v_assignment);
  exception when insufficient_privilege then v_ok := v_ok + 1; end;

  begin perform public.open_job_conversation(v_job, v_worker);
  exception when insufficient_privilege then v_ok := v_ok + 1; end;

  begin perform public.start_protected_payment(v_assignment);
  exception when insufficient_privilege then v_ok := v_ok + 1; end;

  begin perform public.update_open_job(v_job, '{"title":"sin sesión"}'::jsonb);
  exception when insufficient_privilege then v_ok := v_ok + 1; end;

  begin perform public.verify_handoff_code(v_assignment, '0000');
  exception when insufficient_privilege then v_ok := v_ok + 1; end;

  begin perform public.withdraw_job_offer(v_offer);
  exception when insufficient_privilege then v_ok := v_ok + 1; end;

  raise notice '%', 'H01 funciones que rechazan una llamada sin sesión = '
    || v_ok || '/' || v_total
    || case when v_ok = v_total then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Una oferta no se acepta a sí misma'

-- `job_offers_single_accepted_idx` solo admite una oferta ACCEPTED por trabajo.
-- Si el trabajador pudiera marcar la suya, bloquearía el trabajo de un tercero:
-- el cliente ya no podría aceptar ninguna.
do $$
declare
  v_offer uuid;
  v_worker uuid;
begin
  select id, worker_id into v_offer, v_worker
    from public.job_offers where status = 'PENDING' limit 1;
  perform set_config('request.jwt.claim.sub', v_worker::text, true);
  execute 'set local role authenticated';
  begin
    update public.job_offers set status = 'ACCEPTED' where id = v_offer;
    raise notice 'H02 FALLO: el trabajador aceptó su propia oferta';
  exception when insufficient_privilege then
    raise notice 'H02 OK: el trabajador no puede aceptar su propia oferta';
  end;
end $$;
reset role; reset request.jwt.claim.sub;

-- Pero sí puede editar lo que le corresponde mientras sigue pendiente.
do $$
declare
  v_offer uuid;
  v_worker uuid;
begin
  select id, worker_id into v_offer, v_worker
    from public.job_offers where status = 'PENDING' limit 1;
  perform set_config('request.jwt.claim.sub', v_worker::text, true);
  execute 'set local role authenticated';
  update public.job_offers set message = 'Puedo llegar antes' where id = v_offer;
  raise notice 'H03 OK: el trabajador sí puede editar el mensaje de su oferta';
exception when others then
  raise notice 'H03 FALLO: no pudo editar su propia oferta: %', sqlerrm;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- El chat es prueba: nadie reescribe lo que dijo el otro'

do $$
declare
  v_msg uuid;
  v_conv uuid;
  v_otro uuid;
  v_cuerpo text;
begin
  -- Un mensaje de una conversación, y el participante que NO lo escribió.
  select m.id, m.conversation_id, m.body,
         case when c.client_id = m.sender_id then c.worker_id else c.client_id end
    into v_msg, v_conv, v_cuerpo, v_otro
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
   where m.sender_id is not null
   limit 1;
  if v_msg is null then
    raise notice 'H04 sin mensajes para probar';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_otro::text, true);
  execute 'set local role authenticated';
  begin
    update public.messages set body = 'Texto puesto por la contraparte' where id = v_msg;
    raise notice 'H04 FALLO: la contraparte reescribió el mensaje';
  exception when insufficient_privilege then
    raise notice 'H04 OK: la contraparte no puede reescribir el mensaje';
  end;

  -- Marcarlo como leído sí es suyo.
  begin
    update public.messages set read_at = now() where id = v_msg;
    raise notice 'H05 OK: la contraparte sí puede marcarlo como leído';
  exception when others then
    raise notice 'H05 FALLO: no pudo marcar como leído: %', sqlerrm;
  end;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- Un aviso se marca como leído, no se reescribe'

do $$
declare
  v_id uuid;
  v_user uuid;
begin
  select id, user_id into v_id, v_user from public.notifications limit 1;
  if v_id is null then
    raise notice 'H06 sin notificaciones para probar';
    return;
  end if;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  execute 'set local role authenticated';
  begin
    update public.notifications set title = 'Aviso reescrito', href = '/otro' where id = v_id;
    raise notice 'H06 FALLO: el destinatario reescribió el contenido del aviso';
  exception when insufficient_privilege then
    raise notice 'H06 OK: el destinatario no reescribe el contenido del aviso';
  end;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- Las dos funciones que pasaron a SECURITY INVOKER siguen funcionando'

-- Si el cambio a INVOKER se hubiera hecho sin el privilegio de columna o sin la
-- política, estas dos fallarían. Es la prueba de que RLS autoriza lo que la
-- función necesita, que es justamente el motivo por el que ya no hace falta
-- SECURITY DEFINER.
do $$
declare
  v_conv uuid;
  v_quien uuid;
  v_sin_leer_antes integer;
  v_sin_leer_despues integer;
begin
  select c.id, c.client_id into v_conv, v_quien
    from public.conversations c
    join public.messages m on m.conversation_id = c.id
   where m.sender_id is distinct from c.client_id and m.read_at is null
   limit 1;
  if v_conv is null then
    raise notice 'H07 sin conversación con mensajes sin leer';
    return;
  end if;

  select count(*) into v_sin_leer_antes from public.messages
   where conversation_id = v_conv and read_at is null and sender_id is distinct from v_quien;

  perform set_config('request.jwt.claim.sub', v_quien::text, true);
  execute 'set local role authenticated';
  perform public.mark_conversation_read(v_conv);
  execute 'reset role';

  select count(*) into v_sin_leer_despues from public.messages
   where conversation_id = v_conv and read_at is null and sender_id is distinct from v_quien;

  raise notice '%', 'H07 mensajes sin leer, antes ' || v_sin_leer_antes
    || ' y después = ' || v_sin_leer_despues
    || case when v_sin_leer_antes > 0 and v_sin_leer_despues = 0 then '' else ' FALLO' end;
end $$;
reset role; reset request.jwt.claim.sub;

do $$
declare
  v_user uuid;
  v_marcadas integer;
begin
  select user_id into v_user from public.notifications where read_at is null limit 1;
  if v_user is null then
    raise notice 'H08 sin notificaciones sin leer';
    return;
  end if;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  execute 'set local role authenticated';
  select public.mark_notifications_read(null) into v_marcadas;
  raise notice '%', 'H08 avisos marcados como leídos = ' || v_marcadas
    || case when v_marcadas > 0 then '' else ' FALLO' end;
end $$;
reset role; reset request.jwt.claim.sub;

-- Y un tercero sigue sin poder marcar una conversación ajena.
do $$
declare
  v_conv uuid;
  v_extrano uuid;
begin
  select c.id into v_conv from public.conversations c limit 1;
  select u.id into v_extrano from auth.users u
    join public.conversations c on c.id = v_conv
   where u.id <> c.client_id and u.id <> c.worker_id
   limit 1;
  if v_conv is null or v_extrano is null then
    raise notice 'H09 sin datos para probar';
    return;
  end if;
  perform set_config('request.jwt.claim.sub', v_extrano::text, true);
  execute 'set local role authenticated';
  begin
    perform public.mark_conversation_read(v_conv);
    raise notice 'H09 FALLO: un tercero marcó como leída una conversación ajena';
  exception when insufficient_privilege then
    raise notice 'H09 OK: un tercero no marca conversaciones ajenas';
  end;
end $$;
reset role; reset request.jwt.claim.sub;
