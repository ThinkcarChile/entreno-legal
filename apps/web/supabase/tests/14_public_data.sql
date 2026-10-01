\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Qué leen y qué escriben un visitante sin sesión y los demás usuarios
-- =============================================================================
-- Prefijo U. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Cinco defectos, reproducidos antes de corregirlos:
--   · las instrucciones de un trabajo («accesos») se leían sin sesión;
--   · la lista entera de perfiles, clientes y administración incluidos, se
--     pedía sin sesión;
--   · el nombre y la foto de perfil se escribían sin ninguna regla, y el
--     nombre entraba tal cual en el texto de los avisos;
--   · el total de una oferta —lo que termina cobrándose— lo fijaba quien la
--     enviaba;
--   · una verificación ya resuelta se podía resolver otra vez.
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

-- Una consulta escalar con un rol y una identidad. Devuelve el valor, o
-- DENEGADO si el privilegio no alcanza. Todo dentro de la misma transacción:
-- `set_config(..., true)` y `set local role` duran lo que ella.
create function pg_temp.leer(p_rol text, p_user uuid, p_sql text)
returns text language plpgsql as $$
declare
  v text;
begin
  perform pg_temp.como(p_user);
  execute format('set local role %I', p_rol);
  execute p_sql into v;
  reset role;
  perform pg_temp.como(null);
  return v;
exception
  when insufficient_privilege then
    reset role;
    perform pg_temp.como(null);
    return 'DENEGADO';
  when others then
    reset role;
    perform pg_temp.como(null);
    return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end $$;

-- Una escritura con un rol y una identidad. ACEPTADO, o RECHAZADO con el
-- código de error, o DENEGADO si es por privilegio.
create function pg_temp.escribir(p_rol text, p_user uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform pg_temp.como(p_user);
  execute format('set local role %I', p_rol);
  execute p_sql;
  reset role;
  perform pg_temp.como(null);
  return 'ACEPTADO';
exception
  when insufficient_privilege then
    reset role;
    perform pg_temp.como(null);
    return 'DENEGADO';
  when others then
    reset role;
    perform pg_temp.como(null);
    return 'RECHAZADO ' || sqlstate;
end $$;

-- El mensaje de error de una llamada, o OK.
create function pg_temp.motivo(p_rol text, p_user uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform pg_temp.como(p_user);
  execute format('set local role %I', p_rol);
  execute p_sql;
  reset role;
  perform pg_temp.como(null);
  return 'OK';
exception when others then
  reset role;
  perform pg_temp.como(null);
  return sqlerrm;
end $$;

\set CLIENTE  '''14a00000-0000-4000-8000-000000000001'''
\set TRAB     '''14a00000-0000-4000-8000-000000000002'''
\set OTRO     '''14a00000-0000-4000-8000-000000000003'''
\set EXTRANO  '''14a00000-0000-4000-8000-000000000004'''
\set NUEVO    '''14a00000-0000-4000-8000-000000000005'''
\set ADMIN    '''14a00000-0000-4000-8000-000000000006'''
\set RECHAZO  '''14a00000-0000-4000-8000-000000000007'''
\set J1       '''14b00000-0000-4000-8000-000000000001'''
\set J2       '''14b00000-0000-4000-8000-000000000002'''

insert into auth.users (id, email, raw_user_meta_data) values
 (:CLIENTE::uuid, 'u.cliente@test.cl', '{"first_name":"Teresa","last_name":"Vidal","intent":"CLIENT"}'),
 (:TRAB::uuid,    'u.trab@test.cl',    '{"first_name":"Tomás","last_name":"Ibáñez","intent":"WORKER"}'),
 (:OTRO::uuid,    'u.otro@test.cl',    '{"first_name":"Olga","last_name":"Reyes","intent":"WORKER"}'),
 (:EXTRANO::uuid, 'u.extrano@test.cl', '{"first_name":"Ernesto","last_name":"Paz","intent":"CLIENT"}'),
 (:NUEVO::uuid,   'u.nuevo@test.cl',   '{"first_name":"Nora","last_name":"Lillo","intent":"WORKER"}'),
 (:ADMIN::uuid,   'u.admin@test.cl',   '{"first_name":"Alba","last_name":"Soto","intent":"CLIENT"}'),
 (:RECHAZO::uuid, 'u.rechazo@test.cl', '{"first_name":"Rita","last_name":"Mena","intent":"WORKER"}');

update profiles set role = 'ADMIN' where id = :ADMIN::uuid;
update worker_profiles
   set verification_status = 'VERIFIED', identity_verified = true, is_accepting_jobs = true
 where user_id in (:TRAB::uuid, :OTRO::uuid);
insert into worker_service_areas (worker_id, region_code, commune_code, radius_km) values
  (:TRAB::uuid, '13', '13-santiago', 10),
  (:NUEVO::uuid, '13', '13-nunoa', 10);

insert into jobs (
  id, client_id, category_id, status, title, description, instructions, region_code, commune_code,
  place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate, published_at
) values
  (:J1::uuid, :CLIENTE::uuid, (select id from job_categories order by sort_order limit 1), 'PUBLISHED',
   'Fila en notaría del centro de Santiago',
   'Necesito que alguien tome número y espere el turno en la notaría hasta que yo llegue.',
   'La llave está con el conserje, código del portón 4321.',
   '13', '13-santiago', 'Notaría', now() + interval '2 days', 120, 'HOLD_PLACE', 9000, now()),
  (:J2::uuid, :CLIENTE::uuid, (select id from job_categories order by sort_order limit 1), 'PUBLISHED',
   'Retirar un sobre en una oficina de Santiago',
   'Retirar un sobre en recepción y dejarlo en la conserjería de mi edificio el mismo día.',
   null,
   '13', '13-santiago', 'Oficina', now() + interval '3 days', 30, 'HOLD_PLACE', 6000, now());

insert into job_private_location (job_id, address_line, lat, lng) values
  (:J1::uuid, 'Huérfanos 1234', -33.4378, -70.6505),
  (:J2::uuid, 'Agustinas 999', -33.4410, -70.6530);

\echo ''
\echo '--- El total de una oferta lo calcula la base'

-- 9.000 por hora durante 120 minutos son 18.000, diga lo que diga la oferta.
-- La escritura y la lectura van en sentencias separadas: una subconsulta de la
-- misma sentencia lee la foto de antes de la escritura.
select pg_temp.expect('U01 el trabajador envía su oferta con total 1',
  pg_temp.escribir('authenticated', :TRAB::uuid, format(
    'insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
     values (%L, %L, 9000, 1, %L)', :J1, :TRAB, 'Llego temprano.')), 'ACEPTADO');
select pg_temp.expect('U02 total guardado de la oferta de 9.000 × 2 h',
  (select estimated_total::text from job_offers where job_id = :J1::uuid and worker_id = :TRAB::uuid), '18000');
select pg_temp.escribir('authenticated', :OTRO::uuid, format(
  'insert into public.job_offers (job_id, worker_id, hourly_rate) values (%L, %L, 10000)', :J1, :OTRO))
  as u03_escritura \gset
select pg_temp.expect('U03 sin enviar el total, también se calcula',
  :'u03_escritura' || ' · ' || coalesce((select estimated_total::text from job_offers
                                         where job_id = :J1::uuid and worker_id = :OTRO::uuid), 'sin oferta'),
  'ACEPTADO · 20000');
-- Medio peso se redondea hacia arriba, igual que Math.round en proratePerHour.
select pg_temp.escribir('authenticated', :OTRO::uuid, format(
  'insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total) values (%L, %L, 3001, 999999)',
  :J2, :OTRO)) as _ \gset
select pg_temp.expect('U04 3.001 por hora × 30 min (1.500,5) redondea como la aplicación',
  (select estimated_total::text from job_offers where job_id = :J2::uuid and worker_id = :OTRO::uuid), '1501');

select pg_temp.expect('U05 el trabajador no puede reescribir el total de su oferta',
  pg_temp.escribir('authenticated', :TRAB::uuid, format(
    'update public.job_offers set estimated_total = 1 where job_id = %L and worker_id = %L', :J1, :TRAB)),
  'DENEGADO');

-- Ni siquiera una escritura del propio sistema, sin sesión y sin restricciones
-- de privilegio (aquí, como postgres), deja un total que no salga de la tarifa.
update job_offers set estimated_total = 5 where job_id = :J1::uuid and worker_id = :TRAB::uuid;
select pg_temp.expect('U06 una escritura directa del sistema sobre una oferta pendiente se recalcula',
  (select estimated_total::text from job_offers where job_id = :J1::uuid and worker_id = :TRAB::uuid), '18000');

-- El cliente alarga el trabajo a tres horas: las pendientes siguen a la duración.
select pg_temp.expect('U07 el cliente cambia la duración del trabajo',
  pg_temp.motivo('authenticated', :CLIENTE::uuid, format(
    'select public.update_open_job(%L, %L::jsonb)', :J1, '{"estimatedDurationMinutes":"180"}')), 'OK');
select pg_temp.expect('U08 ofertas pendientes recalculadas con su propia tarifa',
  (select string_agg(estimated_total::text, ' · ' order by hourly_rate)
     from job_offers where job_id = :J1::uuid), '27000 · 30000');

\echo ''
\echo '--- Las instrucciones no son públicas'

select pg_temp.expect('U09 anon tiene SELECT sobre jobs.instructions',
  has_column_privilege('anon', 'public.jobs', 'instructions', 'SELECT')::text, 'false');
select pg_temp.expect('U10 authenticated tiene SELECT sobre jobs.instructions',
  has_column_privilege('authenticated', 'public.jobs', 'instructions', 'SELECT')::text, 'false');
select pg_temp.expect('U11 sin sesión, pedir las instrucciones de un trabajo publicado',
  pg_temp.leer('anon', null, format('select instructions from public.jobs where id = %L', :J1)), 'DENEGADO');
select pg_temp.expect('U12 sin sesión, el resto del trabajo publicado sí se lee',
  pg_temp.leer('anon', null, format('select title from public.jobs where id = %L', :J1)),
  'Fila en notaría del centro de Santiago');
select pg_temp.expect('U13 sin sesión, la función de las instrucciones no se ejecuta',
  pg_temp.leer('anon', null, format('select public.get_job_instructions(%L)', :J1)), 'DENEGADO');
select pg_temp.expect('U14 un usuario cualquiera con sesión',
  pg_temp.leer('authenticated', :EXTRANO::uuid, format('select public.get_job_instructions(%L)', :J1)), null);
select pg_temp.expect('U15 un trabajador que ofertó pero no fue elegido todavía',
  pg_temp.leer('authenticated', :TRAB::uuid, format('select public.get_job_instructions(%L)', :J1)), null);
select pg_temp.expect('U16 el cliente del trabajo',
  pg_temp.leer('authenticated', :CLIENTE::uuid, format('select public.get_job_instructions(%L)', :J1)),
  'La llave está con el conserje, código del portón 4321.');
select pg_temp.expect('U17 la administración',
  pg_temp.leer('authenticated', :ADMIN::uuid, format('select public.get_job_instructions(%L)', :J1)),
  'La llave está con el conserje, código del portón 4321.');

\echo ''
\echo '--- Los perfiles no se listan sin sesión'

select pg_temp.expect('U18 anon o authenticated leen profiles.role, roles o is_suspended',
  (has_column_privilege('anon', 'public.profiles', 'role', 'SELECT')
   or has_column_privilege('anon', 'public.profiles', 'roles', 'SELECT')
   or has_column_privilege('anon', 'public.profiles', 'is_suspended', 'SELECT')
   or has_column_privilege('authenticated', 'public.profiles', 'role', 'SELECT')
   or has_column_privilege('authenticated', 'public.profiles', 'roles', 'SELECT')
   or has_column_privilege('authenticated', 'public.profiles', 'is_suspended', 'SELECT'))::text, 'false');
select pg_temp.expect('U19 sin sesión, buscar quién administra',
  pg_temp.leer('anon', null, 'select count(*)::text from public.profiles where role = ''ADMIN'''), 'DENEGADO');
select pg_temp.expect('U20 sin sesión, perfiles visibles que no son de un trabajador verificado',
  pg_temp.leer('anon', null,
    'select count(*)::text from public.profiles p
      where not exists (select 1 from public.worker_profiles w
                         where w.user_id = p.id and w.verification_status = ''VERIFIED'')'), '0');
select pg_temp.expect('U21 sin sesión, el perfil de un cliente',
  pg_temp.leer('anon', null, format('select count(*)::text from public.profiles where id = %L', :CLIENTE)), '0');
select pg_temp.expect('U22 sin sesión, el perfil público de un trabajador verificado',
  pg_temp.leer('anon', null, format('select first_name from public.profiles where id = %L', :TRAB)), 'Tomás');
select pg_temp.expect('U23 sin sesión, el perfil y las zonas de un trabajador sin verificar',
  pg_temp.leer('anon', null, format(
    'select (select count(*) from public.profiles where id = %1$L) || '' · ''
         || (select count(*) from public.worker_profiles where user_id = %1$L) || '' · ''
         || (select count(*) from public.worker_service_areas where worker_id = %1$L)', :NUEVO)), '0 · 0 · 0');
select pg_temp.expect('U24 sin sesión, las zonas de un trabajador verificado',
  pg_temp.leer('anon', null, format(
    'select count(*)::text from public.worker_service_areas where worker_id = %L', :TRAB)), '1');
select pg_temp.expect('U25 con sesión y sin relación, el perfil de un cliente',
  pg_temp.leer('authenticated', :EXTRANO::uuid, format(
    'select count(*)::text from public.profiles where id = %L', :CLIENTE)), '0');
select pg_temp.expect('U26 con sesión, perfiles ajenos visibles que no son de un trabajador verificado',
  pg_temp.leer('authenticated', :EXTRANO::uuid, format(
    'select count(*)::text from public.profiles p
      where p.id <> %L
        and not exists (select 1 from public.worker_profiles w
                         where w.user_id = p.id and w.verification_status = ''VERIFIED'')', :EXTRANO)), '0');
select pg_temp.expect('U27 el trabajador que ofertó ve al cliente del trabajo',
  pg_temp.leer('authenticated', :TRAB::uuid, format(
    'select first_name from public.profiles where id = %L', :CLIENTE)), 'Teresa');

-- Una trabajadora con la verificación suspendida deja de ser pública, pero el
-- cliente que tiene su oferta la sigue viendo.
update worker_profiles set verification_status = 'SUSPENDED', is_accepting_jobs = false
 where user_id = :OTRO::uuid;
select pg_temp.expect('U28 suspendida: sin sesión ya no se ve',
  pg_temp.leer('anon', null, format('select count(*)::text from public.profiles where id = %L', :OTRO)), '0');
select pg_temp.expect('U29 suspendida: el cliente con su oferta sí la ve',
  pg_temp.leer('authenticated', :CLIENTE::uuid, format(
    'select first_name from public.profiles where id = %L', :OTRO)), 'Olga');
select pg_temp.expect('U30 suspendida: un tercero no',
  pg_temp.leer('authenticated', :EXTRANO::uuid, format(
    'select count(*)::text from public.profiles where id = %L', :OTRO)), '0');

select pg_temp.expect('U31 la propia cuenta, con su rol, por la vía propia',
  pg_temp.leer('authenticated', :ADMIN::uuid, 'select role::text from public.get_my_account()')
  || ' · ' || pg_temp.leer('authenticated', :CLIENTE::uuid,
       'select role::text || '' '' || array_to_string(roles, '','') from public.get_my_account()'),
  'ADMIN · CLIENT CLIENT');
select pg_temp.expect('U32 sin sesión, la vía propia no se ejecuta',
  pg_temp.leer('anon', null, 'select count(*)::text from public.get_my_account()'), 'DENEGADO');
select pg_temp.expect('U33 la administración ve todos los perfiles',
  pg_temp.leer('authenticated', :ADMIN::uuid, 'select count(*)::text from public.profiles'),
  (select count(*)::text from profiles));
select pg_temp.expect('U34 sin sesión, toda reseña publicada conserva el nombre de quien la escribió',
  pg_temp.leer('anon', null,
    'select (count(*) > 0 and count(*) = count(author_first_name))::text from public.public_reviews'), 'true');

\echo ''
\echo '--- Al aceptar, el trabajador elegido recibe las instrucciones y el total no cambia'

select pg_temp.expect('U35 el cliente acepta la oferta',
  pg_temp.motivo('authenticated', :CLIENTE::uuid, format(
    'select public.accept_job_offer(%L)',
    (select id from job_offers where job_id = :J1::uuid and worker_id = :TRAB::uuid))), 'OK');
select pg_temp.expect('U36 importe acordado y total a pagar = tarifa × duración',
  (select a.agreed_total || ' · ' || s.client_total
     from assignments a join assignment_payment_summary s on s.assignment_id = a.id
    where a.job_id = :J1::uuid), '27000 · 27000');
select pg_temp.expect('U37 el trabajador asignado',
  pg_temp.leer('authenticated', :TRAB::uuid, format('select public.get_job_instructions(%L)', :J1)),
  'La llave está con el conserje, código del portón 4321.');
select pg_temp.expect('U38 la trabajadora cuya oferta se descartó',
  pg_temp.leer('authenticated', :OTRO::uuid, format('select public.get_job_instructions(%L)', :J1)), null);
select pg_temp.expect('U39 la oferta aceptada ya no se recalcula: sigue congelada',
  pg_temp.motivo('postgres', null, format(
    'update public.job_offers set estimated_total = 1 where job_id = %L and worker_id = %L', :J1, :TRAB)),
  'No se puede cambiar el precio de una oferta que ya no está pendiente');

\echo ''
\echo '--- Los avisos citan el nombre, no lo mezclan con el mensaje'

select pg_temp.expect('U40 aviso de oferta nueva',
  (select body from notifications
    where user_id = :CLIENTE::uuid and notification_type = 'NEW_OFFER' and job_id = :J1::uuid
    order by created_at limit 1),
  'Recibiste una oferta de «Tomás I.» para "Fila en notaría del centro de Santiago".');
select pg_temp.escribir('authenticated', :TRAB::uuid, format(
  'insert into public.messages (conversation_id, sender_id, message_type, body) values (%L, %L, %L, %L)',
  (select id from conversations where job_id = :J1::uuid and worker_id = :TRAB::uuid), :TRAB, 'TEXT',
  'Voy llegando.')) as _ \gset
select pg_temp.expect('U41 aviso de mensaje nuevo',
  (select body from notifications
    where user_id = :CLIENTE::uuid and notification_type = 'NEW_MESSAGE' and job_id = :J1::uuid
    order by created_at desc limit 1),
  'Tienes un mensaje de «Tomás I.» sobre un trabajo.');

-- Cancelado el trabajo, el trabajador ya no tiene las instrucciones.
select pg_temp.motivo('authenticated', :CLIENTE::uuid, format('select public.cancel_job(%L, %L)', :J1, 'Ya no lo necesito'))
  as _ \gset
select pg_temp.expect('U42 tras la cancelación, el trabajador ya no las recibe',
  pg_temp.leer('authenticated', :TRAB::uuid, format('select public.get_job_instructions(%L)', :J1)), null);

\echo ''
\echo '--- Nombre y foto de perfil validados en la base'

create function pg_temp.mi_perfil(p_user uuid, p_set text)
returns text language sql as $$
  select pg_temp.escribir('authenticated', p_user,
    'update public.profiles set ' || p_set || ' where id = auth.uid()')
$$;

select pg_temp.expect('U43 un nombre con salto de línea',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('first_name = %L', E'Ernesto\nTu pago fue rechazado')), 'RECHAZADO 23514');
select pg_temp.expect('U44 un nombre con una dirección web',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('first_name = %L', 'Ernesto pagos-htf.cl')), 'RECHAZADO 23514');
select pg_temp.expect('U45 un nombre que se hace pasar por la plataforma',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('first_name = %L', 'HagoTuFila: tu pago fue rechazado')), 'RECHAZADO 23514');
select pg_temp.expect('U46 un nombre con espacios al borde',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('first_name = %L', ' Ernesto')), 'RECHAZADO 23514');
select pg_temp.expect('U47 un nombre de 61 caracteres',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('first_name = %L', repeat('a', 61))), 'RECHAZADO 23514');
select pg_temp.expect('U48 un nombre con caracteres invisibles de dirección',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('first_name = %L', E'Ernesto\u202Eotsenre')), 'RECHAZADO 23514');
select pg_temp.expect('U49 un nombre válido, con tildes y dos palabras',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('first_name = %L', 'José Ñandú')), 'ACEPTADO');
select pg_temp.expect('U50 una inicial que no es una letra',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('last_name_initial = %L', '1')), 'RECHAZADO 23514');
select pg_temp.expect('U51 una foto servida desde otro dominio',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('avatar_url = %L',
    'https://otro.example/storage/v1/object/public/avatars/' || :EXTRANO || '/foto.jpg')), 'RECHAZADO 23514');
select pg_temp.expect('U52 la foto de la carpeta de otra persona',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('avatar_url = %L', :CLIENTE || '/foto.jpg')), 'RECHAZADO 23514');
select pg_temp.expect('U53 una foto en la propia carpeta',
  pg_temp.mi_perfil(:EXTRANO::uuid, format('avatar_url = %L',
    :EXTRANO || '/0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b.webp')), 'ACEPTADO');
-- La regla vale también para la clave de servicio, y no le cuesta un error de
-- privilegio: la restricción se evalúa con el rol que escribe.
select pg_temp.expect('U54 la clave de servicio: un nombre con dirección web, y uno válido',
  pg_temp.escribir('service_role', null, format(
    'update public.profiles set first_name = %L where id = %L', 'Ana pagos-htf.cl', :EXTRANO))
  || ' · ' || pg_temp.escribir('service_role', null, format(
    'update public.profiles set first_name = %L where id = %L', 'Ernesto', :EXTRANO)),
  'RECHAZADO 23514 · ACEPTADO');
select pg_temp.expect('U55 el onboarding explica el motivo',
  pg_temp.motivo('authenticated', :EXTRANO::uuid,
    'select public.complete_onboarding(''Ana www.pagos.cl'', ''Paz'', ''+56900000000'', ''13'', ''13-santiago'')'),
  'El nombre no puede incluir direcciones web ni correos.');

-- Un nombre que no pasa la regla no bloquea el registro: queda «Usuario».
insert into auth.users (id, email, raw_user_meta_data) values
 ('14a00000-0000-4000-8000-000000000008', 'u.alta1@test.cl',
  '{"first_name":"Pago rechazado\nentra a pagos-htf.cl","last_name":"1Perez","intent":"CLIENT"}'),
 ('14a00000-0000-4000-8000-000000000009', 'u.alta2@test.cl',
  '{"first_name":"  Ana   María ","last_name":"Ñúñez","intent":"CLIENT"}');
select pg_temp.expect('U56 el alta limpia el nombre y la inicial en vez de fallar',
  (select string_agg(first_name || ' ' || coalesce(last_name_initial::text, '∅'), ' · ' order by id)
     from profiles where id in ('14a00000-0000-4000-8000-000000000008', '14a00000-0000-4000-8000-000000000009')),
  'Usuario ∅ · Ana María Ñ');
select pg_temp.expect('U57 las tres reglas están validadas sobre todos los perfiles, semilla incluida',
  (select count(*)::text from pg_constraint
    where conrelid = 'public.profiles'::regclass and convalidated
      and conname in ('profiles_first_name_valid', 'profiles_last_name_initial_valid', 'profiles_avatar_own_path')),
  '3');

\echo ''
\echo '--- Solo se revisa una verificación pendiente'

select pg_temp.leer('authenticated', :NUEVO::uuid,
  'select public.request_worker_verification(''CEDULA'', null, null)::text') as u_v1 \gset
select pg_temp.expect('U58 la administración aprueba una solicitud pendiente',
  pg_temp.motivo('authenticated', :ADMIN::uuid,
    format('select public.review_worker_verification(%L, %L, null)', :'u_v1', 'VERIFIED')), 'OK');
select pg_temp.expect('U59 aprobarla otra vez falla y dice por qué',
  pg_temp.motivo('authenticated', :ADMIN::uuid,
    format('select public.review_worker_verification(%L, %L, null)', :'u_v1', 'VERIFIED')),
  'Esta solicitud ya no está pendiente: quedó aprobada. Solo se revisa una solicitud pendiente.');
select pg_temp.expect('U60 y no reenvía el aviso de verificación',
  (select count(*)::text from notifications
    where user_id = :NUEVO::uuid and notification_type = 'VERIFICATION_UPDATED'), '1');

select pg_temp.leer('authenticated', :RECHAZO::uuid,
  'select public.request_worker_verification(''CEDULA'', null, null)::text') as u_v2 \gset
select pg_temp.motivo('authenticated', :ADMIN::uuid,
  format('select public.review_worker_verification(%L, %L, %L)', :'u_v2', 'REJECTED', 'La foto del documento no se lee.'))
  as _ \gset
select pg_temp.expect('U61 una solicitud rechazada no se aprueba después',
  pg_temp.motivo('authenticated', :ADMIN::uuid,
    format('select public.review_worker_verification(%L, %L, null)', :'u_v2', 'VERIFIED')),
  'Esta solicitud ya no está pendiente: quedó rechazada. Solo se revisa una solicitud pendiente.');
select pg_temp.expect('U62 y el perfil sigue rechazado',
  (select verification_status::text from worker_profiles where user_id = :RECHAZO::uuid), 'REJECTED');
select pg_temp.leer('authenticated', :RECHAZO::uuid,
  'select public.request_worker_verification(''CEDULA'', null, null)::text') as u_v3 \gset
select pg_temp.motivo('authenticated', :ADMIN::uuid,
  format('select public.review_worker_verification(%L, %L, null)', :'u_v3', 'VERIFIED')) as u62_motivo \gset
select pg_temp.expect('U63 una solicitud nueva sí se puede aprobar',
  :'u62_motivo' || ' · ' || (select verification_status::text from worker_profiles where user_id = :RECHAZO::uuid),
  'OK · VERIFIED');
