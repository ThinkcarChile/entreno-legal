\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Etapa 2 · Recorrido completo cliente ↔ trabajador y pruebas de RLS
-- =============================================================================
-- Los bloques `do $$ ... $$` comprueban que una operación PROHIBIDA falla.
-- Cuando RLS simplemente no deja filas visibles no hay excepción, así que en
-- esos casos se revisa FOUND en vez de capturar el error.
-- =============================================================================

\set CLIENTE    '''b1111111-1111-4111-8111-111111111111'''
\set TRABAJADOR '''b2222222-2222-4222-8222-222222222222'''
\set INTRUSO    '''b3333333-3333-4333-8333-333333333333'''
\set ADMIN      '''b4444444-4444-4444-8444-444444444444'''

insert into auth.users (id, email, raw_user_meta_data) values
 (:CLIENTE::uuid,   'p.alvarado@test.cl', '{"first_name":"Paula","last_name":"Alvarado","intent":"CLIENT"}'),
 (:TRABAJADOR::uuid,'a.miranda@test.cl',  '{"first_name":"Andres","last_name":"Miranda","intent":"WORKER"}'),
 (:INTRUSO::uuid,   'curioso@test.cl',    '{"first_name":"Curioso","last_name":"Perez","intent":"CLIENT"}'),
 (:ADMIN::uuid,     'soporte@test.cl',    '{"first_name":"Soporte","last_name":"HTF","intent":"CLIENT"}');

update profiles set role = 'ADMIN' where id = :ADMIN::uuid;

\echo ''
\echo '--- Cuentas y onboarding'

set role authenticated;
set request.jwt.claim.sub = :CLIENTE;
select complete_onboarding('Paula','Alvarado','+56911111111','05','05-vina-del-mar',null,true,false);
reset role; reset request.jwt.claim.sub;

select 'E01 comuna pública del cliente = ' || coalesce(city,'NULO')
  from profiles where id = :CLIENTE::uuid;
select 'E02 teléfono guardado aparte del perfil = ' || coalesce(phone,'NULO')
  from user_private_data where user_id = :CLIENTE::uuid;

set role authenticated;
set request.jwt.claim.sub = :TRABAJADOR;
select complete_onboarding('Andrés','Miranda','+56922222222','08','08-concepcion',null,true,true);
select set_worker_service_areas('[{"regionCode":"08","communeCode":"08-concepcion","radiusKm":20}]'::jsonb);
update worker_profiles set headline = 'Trámites en el Gran Concepción', base_hourly_rate = 9000
 where user_id = :TRABAJADOR::uuid;
reset role; reset request.jwt.claim.sub;

select 'E03 modos activos de la cuenta = ' || array_to_string(roles, ',')
  from profiles where id = :TRABAJADOR::uuid;
select 'E04 zonas de trabajo guardadas = ' || count(*)
  from worker_service_areas where worker_id = :TRABAJADOR::uuid;

\echo ''
\echo '--- Privacidad de los datos personales'

set role authenticated;
set request.jwt.claim.sub = :INTRUSO;
do $$
begin
  update public.user_private_data set phone = '+56900000000'
   where user_id = 'b1111111-1111-4111-8111-111111111111';
  if found then raise notice 'E05 FALLO: se editaron datos privados ajenos';
  else raise notice 'E05 OK: no se pueden editar datos privados ajenos'; end if;
end $$;
select 'E06 datos privados ajenos legibles = ' || count(*)
  from user_private_data where user_id = :CLIENTE::uuid;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- Publicar un trabajo'

set role authenticated;
set request.jwt.claim.sub = :CLIENTE;
select publish_job(jsonb_build_object(
  'categoryId', (select id from job_categories where slug = 'retiro-pedidos'),
  'title', 'Retirar un pedido en tienda de Viña del Mar',
  'description', 'Necesito que retiren un pedido listo y lo dejen en la conserjería de mi edificio.',
  'instructions', 'El retiro está a mi nombre y la tienda permite retiro por terceros.',
  'regionCode', '05', 'communeCode', '05-vina-del-mar',
  'placeName', 'Tienda Libertad',
  'addressLine', 'Av. Libertad 1348, depto 902',
  'addressNotes', 'Conserjería recibe hasta las 22:00',
  'lat', -33.0245, 'lng', -71.5518,
  'startsAt', (now() + interval '2 days')::text,
  'estimatedDurationMinutes', 90,
  'urgency', 'NORMAL',
  'objectiveType', 'COMPLETE_ERRAND',
  'objectiveDescription', 'Retirar el pedido y dejarlo en conserjería.',
  'bonusAmount', '5000', 'bonusConditions', 'Si llega antes de las 18:00',
  'hourlyRate', '12000',
  'suggestedHourlyMin', '10000', 'suggestedHourlyMax', '13000'
)) as job_id \gset
reset role; reset request.jwt.claim.sub;

select set_config('test.job_id', :'job_id', false);

select 'E07 estado del trabajo publicado = ' || status from jobs where id = :'job_id'::uuid;
select 'E08 referencia legible generada = ' || left(reference, 4) from jobs where id = :'job_id'::uuid;
select 'E09 punto aproximado guardado = ' || approx_lat::text || ', ' || approx_lng::text
  from jobs where id = :'job_id'::uuid;
select 'E10 zona horaria deducida de la comuna = ' || timezone from jobs where id = :'job_id'::uuid;

\echo ''
\echo '--- La dirección exacta no es pública'

set role authenticated;
set request.jwt.claim.sub = :INTRUSO;
select 'E11 dirección exacta visible para un extraño = ' || count(*)
  from job_private_location where job_id = :'job_id'::uuid;
select 'E12 el trabajo publicado sí es visible = ' || count(*)
  from jobs where id = :'job_id'::uuid;
-- Desde la migración …000100 esto ya ni siquiera llega a RLS: `authenticated`
-- no tiene UPDATE sobre `jobs`. Se acepta cualquiera de las dos formas de
-- negarlo —error de privilegio, o cero filas por política— y se rechaza que
-- la fila cambie.
do $$
begin
  begin
    update public.jobs set hourly_rate = 1 where id = current_setting('test.job_id')::uuid;
  exception when insufficient_privilege then
    raise notice 'E13 OK: un extraño no puede modificar el trabajo (sin privilegio)';
    return;
  end;
  if found then raise notice 'E13 FALLO: un extraño modificó el trabajo';
  else raise notice 'E13 OK: un extraño no puede modificar el trabajo'; end if;
end $$;
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = :CLIENTE;
select 'E14 dirección exacta visible para el cliente = ' || count(*)
  from job_private_location where job_id = :'job_id'::uuid;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- Sin verificación no se oferta'

set role authenticated;
set request.jwt.claim.sub = :TRABAJADOR;
do $$
begin
  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (current_setting('test.job_id')::uuid,
          'b2222222-2222-4222-8222-222222222222', 11000, 16500, 'Puedo hoy');
  raise notice 'E15 FALLO: un trabajador sin verificar pudo ofertar';
exception when others then
  raise notice 'E15 OK: oferta bloqueada mientras no esté verificado';
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- Verificación resuelta desde administración'

set role authenticated;
set request.jwt.claim.sub = :TRABAJADOR;
select request_worker_verification('CEDULA','verification/w/doc.jpg','verification/w/selfie.jpg')
  as verification_id \gset
reset role; reset request.jwt.claim.sub;

select set_config('test.verification_id', :'verification_id', false);
select 'E16 estado tras solicitar verificación = ' || verification_status
  from worker_profiles where user_id = :TRABAJADOR::uuid;

set role authenticated;
set request.jwt.claim.sub = :TRABAJADOR;
do $$
begin
  perform public.review_worker_verification(
    current_setting('test.verification_id')::uuid, 'VERIFIED'::public.verification_status, null);
  raise notice 'E17 FALLO: un trabajador se autoverificó';
exception when insufficient_privilege then
  raise notice 'E17 OK: solo la administración resuelve verificaciones';
end $$;
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = :ADMIN;
select review_worker_verification(:'verification_id'::uuid, 'VERIFIED', null);
reset role; reset request.jwt.claim.sub;

select 'E18 tras aprobación: estado y nivel = ' || verification_status || ' / ' || level
  from worker_profiles where user_id = :TRABAJADOR::uuid;

\echo ''
\echo '--- Ofertas'

set role authenticated;
set request.jwt.claim.sub = :TRABAJADOR;
insert into job_offers (job_id, worker_id, hourly_rate, estimated_total, message, estimated_arrival_at)
values (:'job_id'::uuid, :TRABAJADOR::uuid, 11000, 16500,
        'Vivo cerca, puedo pasar apenas abra la tienda.', now() + interval '2 days')
returning id as offer_id \gset
reset role; reset request.jwt.claim.sub;

select set_config('test.offer_id', :'offer_id', false);

select 'E19 contador de ofertas del trabajo = ' || offer_count from jobs where id = :'job_id'::uuid;
select 'E20 aviso de nueva oferta al cliente = ' || count(*)
  from notifications where user_id = :CLIENTE::uuid and notification_type = 'NEW_OFFER';

set role authenticated;
set request.jwt.claim.sub = :TRABAJADOR;
do $$
begin
  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total)
  values (current_setting('test.job_id')::uuid,
          'b2222222-2222-4222-8222-222222222222', 9000, 13500);
  raise notice 'E21 FALLO: se permitió una segunda oferta al mismo trabajo';
exception when unique_violation then
  raise notice 'E21 OK: una sola oferta por trabajador y trabajo';
end $$;
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = :CLIENTE;
do $$
begin
  update public.job_offers set hourly_rate = 5000
   where id = current_setting('test.offer_id')::uuid;
  raise notice 'E22 FALLO: el cliente cambió el precio de una oferta';
exception when insufficient_privilege then
  raise notice 'E22 OK: el cliente no puede escribir el precio de una oferta';
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- Chat antes de la asignación'

set role authenticated;
set request.jwt.claim.sub = :CLIENTE;
select open_job_conversation(:'job_id'::uuid, :TRABAJADOR::uuid) as conversation_id \gset
insert into messages (conversation_id, sender_id, message_type, body)
values (:'conversation_id'::uuid, :CLIENTE::uuid, 'TEXT', '¿Puedes ir antes de las 18:00?');
reset role; reset request.jwt.claim.sub;

select set_config('test.conversation_id', :'conversation_id', false);
select 'E23 conversación abierta antes de asignar = ' || count(*) from conversations;

set role authenticated;
set request.jwt.claim.sub = :INTRUSO;
select 'E24 mensajes ajenos legibles por un extraño = ' || count(*) from messages;
do $$
begin
  insert into public.messages (conversation_id, sender_id, message_type, body)
  values (current_setting('test.conversation_id')::uuid,
          'b3333333-3333-4333-8333-333333333333', 'TEXT', 'Hola, soy un intruso');
  raise notice 'E25 FALLO: un extraño escribió en un chat ajeno';
exception when others then
  raise notice 'E25 OK: un extraño no puede escribir en un chat ajeno';
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- Aceptar la oferta'

set role authenticated;
set request.jwt.claim.sub = :TRABAJADOR;
do $$
begin
  perform public.accept_job_offer(current_setting('test.offer_id')::uuid);
  raise notice 'E26 FALLO: el trabajador aceptó su propia oferta';
exception when insufficient_privilege then
  raise notice 'E26 OK: solo el cliente acepta una oferta';
end $$;
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = :CLIENTE;
select accept_job_offer(:'offer_id'::uuid) as assignment_id \gset
reset role; reset request.jwt.claim.sub;

select set_config('test.assignment_id', :'assignment_id', false);
select set_config('test.trabajador', :TRABAJADOR, false);

select 'E27 estado del trabajo tras aceptar = ' || status from jobs where id = :'job_id'::uuid;
select 'E28 asignaciones del trabajo = ' || count(*) from assignments where job_id = :'job_id'::uuid;
select 'E29 estado de la oferta elegida = ' || status from job_offers where id = :'offer_id'::uuid;
select 'E30 mensajes automáticos del sistema = ' || count(*) from messages where message_type = 'SYSTEM';
select 'E31 aviso de aceptación al trabajador = ' || count(*)
  from notifications where user_id = :TRABAJADOR::uuid and notification_type = 'OFFER_ACCEPTED';

set role authenticated;
set request.jwt.claim.sub = :CLIENTE;
do $$
begin
  perform public.accept_job_offer(current_setting('test.offer_id')::uuid);
  raise notice 'E32 FALLO: se aceptó dos veces la misma oferta';
exception when others then
  raise notice 'E32 OK: no se puede aceptar dos veces';
end $$;
reset role; reset request.jwt.claim.sub;

do $$
begin
  update public.job_offers set hourly_rate = 1000
   where id = current_setting('test.offer_id')::uuid;
  raise notice 'E33 FALLO: cambió el precio de una oferta aceptada';
exception when check_violation then
  raise notice 'E33 OK: el precio de una oferta aceptada es inmutable';
end $$;

set role authenticated;
set request.jwt.claim.sub = :CLIENTE;
-- Dos capas lo impiden y cualquiera de las dos vale: desde la migración
-- …000100 el cliente ni siquiera tiene UPDATE sobre `jobs`, y si lo tuviera,
-- `guard_job_edits` congela el horario una vez que hay asignación.
do $$
begin
  update public.jobs set starts_at = now() + interval '9 days'
   where id = current_setting('test.job_id')::uuid;
  raise notice 'E34 FALLO: se cambió el horario de un trabajo ya asignado';
exception
  when insufficient_privilege then
    raise notice 'E34 OK: los campos críticos quedan congelados tras asignar (sin privilegio)';
  when check_violation then
    raise notice 'E34 OK: los campos críticos quedan congelados tras asignar';
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- La dirección exacta se abre al trabajador asignado'

set role authenticated;
set request.jwt.claim.sub = :TRABAJADOR;
select 'E35 dirección exacta visible tras ser asignado = ' || count(*)
  from job_private_location where job_id = :'job_id'::uuid;
select 'E36 datos privados del cliente visibles para el trabajador = ' || count(*)
  from user_private_data where user_id = :CLIENTE::uuid;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- No se trabaja sin pago confirmado'

do $$
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.trabajador'), true);
  perform public.mark_on_the_way(current_setting('test.assignment_id')::uuid);
  raise notice 'E37 FALLO: el trabajo avanzó sin pago confirmado';
exception when check_violation then
  raise notice 'E37 OK: no se avanza sin pago confirmado';
end $$;
select set_config('request.jwt.claim.sub', '', false);

\echo ''
\echo '--- Pago Protegido'

set role authenticated;
set request.jwt.claim.sub = :CLIENTE;
select start_protected_payment(:'assignment_id'::uuid) as payment_id \gset
reset role; reset request.jwt.claim.sub;

select 'E38 monto cobrado al cliente = ' || amount from payments where id = :'payment_id'::uuid;
select 'E39 desglose (recibe / comisión / paga) = '
       || worker_receives || ' / ' || commission_amount || ' / ' || client_total
  from assignment_payment_summary where assignment_id = :'assignment_id'::uuid;

set role service_role;
update payments set status = 'PAID', paid_at = now() where id = :'payment_id'::uuid;
reset role;

select 'E40 estado del trabajo tras el pago = ' || status from jobs where id = :'job_id'::uuid;
select 'E41 estado de la asignación tras el pago = ' || status
  from assignments where id = :'assignment_id'::uuid;
select 'E42 payout creado (comisión / neto) = ' || commission_amount || ' / ' || net_amount
  from payouts where assignment_id = :'assignment_id'::uuid;
select 'E43 avisos de pago emitidos = ' || count(*)
  from notifications where notification_type = 'JOB_PAID';

set request.jwt.claim.sub = :TRABAJADOR;
select mark_on_the_way(:'assignment_id'::uuid);
reset request.jwt.claim.sub;
select 'E44 asignación en camino tras pagar = ' || status
  from assignments where id = :'assignment_id'::uuid;

\echo ''
\echo '--- Auditoría'

set role authenticated;
set request.jwt.claim.sub = :TRABAJADOR;
-- Desde el Bloque 3 no hay ni privilegio: antes la única barrera era que no
-- existiera política de RLS, y eso es una sola capa para una bitácora.
do $$
begin
  update public.audit_logs set action = 'manipulado';
  if found then raise notice 'E45 FALLO: se alteró la bitácora de auditoría';
  else raise notice 'E45 OK: la bitácora no se puede alterar'; end if;
exception when insufficient_privilege then
  raise notice 'E45 OK: sin privilegio para alterar la bitácora';
end $$;
do $$
begin
  delete from public.audit_logs;
  if found then raise notice 'E46 FALLO: se borró la bitácora de auditoría';
  else raise notice 'E46 OK: la bitácora no se puede borrar'; end if;
exception when insufficient_privilege then
  raise notice 'E46 OK: sin privilegio para borrar la bitácora';
end $$;
reset role; reset request.jwt.claim.sub;

select 'E47 aceptación registrada en auditoría = ' || count(*)
  from audit_logs where action = 'offer_accepted';
