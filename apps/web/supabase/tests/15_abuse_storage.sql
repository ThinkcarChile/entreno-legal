\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Límites de abuso, archivos subidos y código de entrega
-- =============================================================================
-- Prefijo Q. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
--   · límites por usuario para publicar, ofertar y escribir (…001200);
--   · la evidencia se contrasta con lo que hay de verdad en Storage, y Storage
--     solo deja subir al ámbito propio y borrar lo propio sin registrar
--     (…001210);
--   · el código de entrega solo se usa con el trabajo en curso, y un intento
--     que no podía acertar no se gasta (…001220);
--   · un check-in sin precisión no se da por verificado (…001230).
--
-- Las cuentas de la primera parte son nuevas y propias de esta batería: los
-- límites cuentan lo que cada persona hizo en la última ventana, y las cuentas
-- de las baterías anteriores ya hicieron cosas.
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

-- Mismo montaje que 08 y 10: trabajo publicado, oferta aceptada y pago
-- confirmado con el proveedor simulado. Todo como sistema, sin sesión: no gasta
-- el cupo de nadie.
create function pg_temp.montar_trabajo(
  p_tag text,
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
    'Prueba de abuso y archivos ' || p_tag,
    'Montaje de la prueba de límites, archivos de evidencia y código de entrega.',
    '13', '13-santiago', 'Lugar de prueba', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now()
  );

  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, worker_id, 9000, 18000, 'Oferta de prueba ' || p_tag)
  returning id into v_offer;

  perform pg_temp.como(client_id);
  assignment_id := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(assignment_id);
  perform pg_temp.como(null);

  update public.payments
     set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-' || v_tag
   where id = payment_id;
  perform public.confirm_payment_result(payment_id, 'mock', 'evt-' || v_tag, 'PAID', null, '{}');
end;
$$;

-- El trabajador avanza hasta el estado pedido.
create function pg_temp.avanzar(p_a uuid, p_hasta text)
returns void language plpgsql as $$
declare v_w uuid;
begin
  select worker_id into v_w from public.assignments where id = p_a;
  perform pg_temp.como(v_w);
  perform public.mark_on_the_way(p_a);
  perform public.register_check_in(p_a, true, -33.4265, -70.6153, 20, 'device');
  if p_hasta in ('IN_PROGRESS', 'HANDOFF_COMPLETED') then
    perform public.start_job_work(p_a);
  end if;
  if p_hasta = 'HANDOFF_COMPLETED' then
    perform public.request_job_completion(p_a, 'Listo.');
  end if;
  perform pg_temp.como(null);
end $$;

-- Ejecuta una sentencia como `authenticated` con la identidad dada. Devuelve
-- las filas afectadas o el error, sin abortar la batería.
create function pg_temp.como_usuario(p_user uuid, p_sql text)
returns text language plpgsql as $$
declare n integer;
begin
  perform pg_temp.como(p_user);
  set local role authenticated;
  execute p_sql;
  get diagnostics n = row_count;
  reset role;
  perform pg_temp.como(null);
  return 'FILAS ' || n;
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'ERROR ' || sqlstate;
end $$;

-- Llama a una RPC con la identidad dada y devuelve su resultado o el error.
create function pg_temp.rpc(p_user uuid, p_sql text)
returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.como(p_user);
  execute p_sql into r;
  perform pg_temp.como(null);
  return coalesce(r, 'NULO');
exception when others then
  perform pg_temp.como(null);
  return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end $$;

-- Lo que hace Storage al terminar una subida: la fila con sus metadatos, con
-- la sesión de quien sube y bajo las políticas del bucket.
create function pg_temp.subir(p_user uuid, p_bucket text, p_name text, p_mime text, p_size bigint)
returns text language sql as $$
  select pg_temp.como_usuario(p_user, format(
    'insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L::jsonb)',
    p_bucket, p_name, p_user,
    jsonb_build_object('size', p_size, 'mimetype', p_mime, 'eTag', '"prueba"')::text))
$$;

-- `remove([ruta])` de Storage: un DELETE con la sesión de quien borra.
create function pg_temp.borrar(p_user uuid, p_bucket text, p_name text)
returns text language sql as $$
  select pg_temp.como_usuario(p_user, format(
    'delete from storage.objects where bucket_id = %L and name = %L', p_bucket, p_name))
$$;

create temp table q_ctx (k text primary key, v uuid);


-- =============================================================================
\echo ''
\echo '--- Límites por usuario: configuración'

select pg_temp.expect('Q01 límites por omisión (trabajos/día, ofertas/hora, mensajes/minuto)',
  (select rate_limit_jobs_per_day || '/' || rate_limit_offers_per_hour || '/' || rate_limit_messages_per_minute
     from platform_settings where id), '30/30/20');

create function pg_temp.limite_invalido()
returns text language plpgsql as $$
begin
  update public.platform_settings set rate_limit_messages_per_minute = 0 where id;
  return 'ACEPTADO';
exception when check_violation then
  return 'RECHAZADO';
end $$;
select pg_temp.expect('Q02 un límite en cero no se acepta', pg_temp.limite_invalido(), 'RECHAZADO');

select pg_temp.expect('Q03 nadie con sesión lee ni escribe las marcas de los límites',
  (has_table_privilege('authenticated', 'app_private.rate_limit_events', 'SELECT')
   or has_table_privilege('authenticated', 'app_private.rate_limit_events', 'INSERT')
   or has_table_privilege('authenticated', 'app_private.rate_limit_events', 'DELETE'))::text, 'false');

select pg_temp.expect('Q04 la espera se dice en palabras y redondea hacia arriba',
  app_private.rate_limit_wait_text(interval '1 second') || ' | '
  || app_private.rate_limit_wait_text(interval '39.2 seconds') || ' | '
  || app_private.rate_limit_wait_text(interval '61 seconds') || ' | '
  || app_private.rate_limit_wait_text(interval '3 hours 19 minutes 30 seconds') || ' | '
  || app_private.rate_limit_wait_text(interval '23 hours 59 minutes 30 seconds'),
  '1 segundo | 40 segundos | 2 minutos | 3 h 20 min | 24 h');

-- Cuentas nuevas: un cliente, un trabajador verificado y un tercero.
insert into auth.users (id, email, raw_user_meta_data) values
  ('c5000000-0000-4000-8000-000000000001', 'q-cliente@prueba.cl',
   '{"first_name": "Quintina", "last_name": "Cliente"}'),
  ('c5000000-0000-4000-8000-000000000002', 'q-trabajador@prueba.cl',
   '{"first_name": "Quinto", "last_name": "Trabajador", "intent": "WORKER"}'),
  ('c5000000-0000-4000-8000-000000000003', 'q-tercero@prueba.cl',
   '{"first_name": "Tercera", "last_name": "Persona"}');

update worker_profiles
   set verification_status = 'VERIFIED', identity_verified = true, phone_verified = true,
       bank_account_verified = true, is_accepting_jobs = true
 where user_id = 'c5000000-0000-4000-8000-000000000002';

-- Límites bajos para la prueba. Se restauran al final.
update platform_settings
   set rate_limit_jobs_per_day = 3, rate_limit_offers_per_hour = 2, rate_limit_messages_per_minute = 3
 where id;


-- =============================================================================
\echo ''
\echo '--- Publicar trabajos'

create function pg_temp.publicar(p_user uuid, p_tag text)
returns text language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.como(p_user);
  v := public.publish_job(jsonb_build_object(
    'categoryId', (select id from public.job_categories order by sort_order limit 1),
    'title', 'Trabajo para probar límites ' || p_tag,
    'description', 'Trabajo creado por la batería de límites por usuario, sin otro uso.',
    'regionCode', '13', 'communeCode', '13-santiago',
    'placeName', 'Lugar de prueba',
    'addressLine', 'Av. de prueba 1234',
    'lat', -33.4265, 'lng', -70.6153,
    'startsAt', (now() + interval '1 day')::text,
    'estimatedDurationMinutes', 60,
    'urgency', 'NORMAL',
    'objectiveType', 'HOLD_PLACE',
    'hourlyRate', '9000'));
  perform pg_temp.como(null);
  return 'PUBLICADO';
exception when others then
  perform pg_temp.como(null);
  return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end $$;

-- Las cuatro en la misma transacción: la hora de las tres primeras es la misma,
-- así que la espera es exacta.
create function pg_temp.publicar_cuatro(p_user uuid)
returns text language plpgsql as $$
begin
  return pg_temp.publicar(p_user, 'a') || ' | ' || pg_temp.publicar(p_user, 'b') || ' | '
      || pg_temp.publicar(p_user, 'c') || ' | ' || pg_temp.publicar(p_user, 'd');
end $$;

select pg_temp.expect('Q05 el cuarto trabajo en 24 horas se rechaza y dice cuándo volver',
  pg_temp.publicar_cuatro('c5000000-0000-4000-8000-000000000001'),
  'PUBLICADO | PUBLICADO | PUBLICADO | ERROR PT429: Alcanzaste el máximo de 3 trabajos publicados en 24 horas. Podrás publicar otro en 24 h.');

select pg_temp.expect('Q06 y no queda ningún trabajo a medias',
  (select count(*)::text from jobs where client_id = 'c5000000-0000-4000-8000-000000000001'), '3');

-- Lo que el sistema crea a nombre de esa persona no gasta su cupo ni lo bloquea.
insert into jobs (
  id, client_id, category_id, status, title, description, region_code, commune_code,
  place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate, published_at
) values (
  'c5100000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001',
  (select id from job_categories order by sort_order limit 1), 'PUBLISHED',
  'Trabajo creado por el sistema', 'Trabajo creado sin sesión, como lo haría el rol de servicio.',
  '13', '13-santiago', 'Lugar de prueba', now() + interval '1 day', 60, 'HOLD_PLACE', 9000, now()
);
select pg_temp.expect('Q07 lo que crea el sistema (sin sesión) no se limita ni deja marca',
  (select count(*)::text from jobs where id = 'c5100000-0000-4000-8000-000000000001') || ' trabajo, '
  || (select count(*)::text from app_private.rate_limit_events
       where user_id = 'c5000000-0000-4000-8000-000000000001' and action = 'job') || ' marcas',
  '1 trabajo, 3 marcas');

update platform_settings set rate_limit_jobs_per_day = 1 where id;
create function pg_temp.admin_publica_dos()
returns text language plpgsql as $$
begin
  return pg_temp.publicar(pg_temp.admin_id(), 'admin-1') || ' | ' || pg_temp.publicar(pg_temp.admin_id(), 'admin-2');
end $$;
select pg_temp.expect('Q08 la administración no tiene límite',
  pg_temp.admin_publica_dos(), 'PUBLICADO | PUBLICADO');
update platform_settings set rate_limit_jobs_per_day = 3 where id;

-- Otra persona no se ve afectada por el cupo agotado de la primera.
select pg_temp.expect('Q09 el límite es por persona',
  pg_temp.publicar('c5000000-0000-4000-8000-000000000003', 'tercero'), 'PUBLICADO');


-- =============================================================================
\echo ''
\echo '--- Ofertas'

-- Tres trabajos publicados de otra persona, creados por el sistema.
insert into jobs (
  id, client_id, category_id, status, title, description, region_code, commune_code,
  place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate, published_at
)
select x.id, 'c5000000-0000-4000-8000-000000000001',
       (select id from job_categories order by sort_order limit 1), 'PUBLISHED',
       'Trabajo para ofertar ' || x.n, 'Trabajo publicado para probar el límite de ofertas por hora.',
       '13', '13-santiago', 'Lugar de prueba', now() + interval '1 day', 60, 'HOLD_PLACE', 9000, now()
  from (values ('c5100000-0000-4000-8000-000000000011'::uuid, 1),
               ('c5100000-0000-4000-8000-000000000012'::uuid, 2),
               ('c5100000-0000-4000-8000-000000000013'::uuid, 3)) as x(id, n);

-- La oferta entra como la escribe la aplicación: INSERT directo con la sesión.
create function pg_temp.ofertar(p_job uuid)
returns text language sql as $$
  select pg_temp.como_usuario('c5000000-0000-4000-8000-000000000002', format(
    'insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
     values (%L, %L, 9000, 9000, %L)', p_job, 'c5000000-0000-4000-8000-000000000002', 'Puedo ir'))
$$;

create function pg_temp.ofertar_tres()
returns text language plpgsql as $$
begin
  return pg_temp.ofertar('c5100000-0000-4000-8000-000000000011') || ' | '
      || pg_temp.ofertar('c5100000-0000-4000-8000-000000000012') || ' | '
      || pg_temp.ofertar('c5100000-0000-4000-8000-000000000013');
end $$;

select pg_temp.expect('Q10 la tercera oferta en una hora se rechaza con 429',
  pg_temp.ofertar_tres(), 'FILAS 1 | FILAS 1 | ERROR PT429');

create function pg_temp.mensaje_de_oferta()
returns text language plpgsql as $$
begin
  perform pg_temp.como('c5000000-0000-4000-8000-000000000002');
  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total)
  values ('c5100000-0000-4000-8000-000000000013', 'c5000000-0000-4000-8000-000000000002', 9000, 9000);
  perform pg_temp.como(null);
  return 'ACEPTADA';
exception when others then
  perform pg_temp.como(null);
  return sqlerrm;
end $$;
select pg_temp.expect('Q11 el mensaje dice cuándo se puede volver a ofertar',
  (select case when m like 'Alcanzaste el máximo de 2 ofertas en una hora. Podrás enviar otra en %'
               then 'dice la espera' else m end from pg_temp.mensaje_de_oferta() m),
  'dice la espera');

-- Retirar una oferta no devuelve el cupo: si no, retirar y volver a enviar
-- sería la forma de saltárselo.
create function pg_temp.retirar_y_volver()
returns text language plpgsql as $$
declare v_offer uuid;
begin
  select id into v_offer from public.job_offers
   where worker_id = 'c5000000-0000-4000-8000-000000000002'
     and job_id = 'c5100000-0000-4000-8000-000000000011';
  perform pg_temp.como('c5000000-0000-4000-8000-000000000002');
  perform public.withdraw_job_offer(v_offer);
  perform pg_temp.como(null);
  return pg_temp.ofertar('c5100000-0000-4000-8000-000000000013');
end $$;
select pg_temp.expect('Q12 retirar una oferta no devuelve el cupo', pg_temp.retirar_y_volver(), 'ERROR PT429');


-- =============================================================================
\echo ''
\echo '--- Mensajes'

-- Conversación entre el cliente y el trabajador nuevos, por la oferta del
-- trabajo …012.
create function pg_temp.abrir_conversacion()
returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.como('c5000000-0000-4000-8000-000000000001');
  v := public.open_job_conversation('c5100000-0000-4000-8000-000000000012', 'c5000000-0000-4000-8000-000000000002');
  perform pg_temp.como(null);
  return v;
end $$;
insert into q_ctx values ('conv', pg_temp.abrir_conversacion());

create function pg_temp.escribir(p_user uuid, p_body text)
returns text language sql as $$
  select pg_temp.como_usuario(p_user, format(
    'insert into public.messages (conversation_id, sender_id, message_type, body) values (%L, %L, %L, %L)',
    (select v from q_ctx where k = 'conv'), p_user, 'TEXT', p_body))
$$;

create function pg_temp.escribir_cuatro()
returns text language plpgsql as $$
declare c uuid := 'c5000000-0000-4000-8000-000000000001';
begin
  return pg_temp.escribir(c, 'Hola') || ' | ' || pg_temp.escribir(c, '¿Llegas?') || ' | '
      || pg_temp.escribir(c, '¿Me confirmas?') || ' | ' || pg_temp.escribir(c, '¿Hola?');
end $$;
select pg_temp.expect('Q13 el cuarto mensaje en un minuto se rechaza con 429',
  pg_temp.escribir_cuatro(), 'FILAS 1 | FILAS 1 | FILAS 1 | ERROR PT429');

create function pg_temp.mensaje_del_chat()
returns text language plpgsql as $$
begin
  perform pg_temp.como('c5000000-0000-4000-8000-000000000001');
  insert into public.messages (conversation_id, sender_id, message_type, body)
  values ((select v from q_ctx where k = 'conv'), 'c5000000-0000-4000-8000-000000000001', 'TEXT', 'Otro');
  perform pg_temp.como(null);
  return 'ACEPTADO';
exception when others then
  perform pg_temp.como(null);
  return sqlerrm;
end $$;
select pg_temp.expect('Q14 el mensaje dice cuándo se puede volver a escribir',
  (select case when m like 'Estás enviando mensajes muy seguido. Podrás escribir de nuevo en %segundo%'
                 or m like 'Estás enviando mensajes muy seguido. Podrás escribir de nuevo en 1 minuto.'
               then 'dice la espera' else m end from pg_temp.mensaje_del_chat() m),
  'dice la espera');

select pg_temp.expect('Q15 la contraparte sigue escribiendo en la misma conversación',
  pg_temp.escribir('c5000000-0000-4000-8000-000000000002', 'Voy llegando'), 'FILAS 1');

-- Un aviso automático firmado con la identidad de quien agotó su cupo (como
-- `mark_on_the_way` firma con el trabajador) no se limita: no lo escribió él.
create function pg_temp.aviso_del_sistema()
returns text language plpgsql as $$
begin
  perform pg_temp.como('c5000000-0000-4000-8000-000000000001');
  insert into public.messages (conversation_id, sender_id, message_type, body)
  values ((select v from q_ctx where k = 'conv'), 'c5000000-0000-4000-8000-000000000001', 'SYSTEM', 'Aviso automático');
  perform pg_temp.como(null);
  return 'ACEPTADO';
exception when others then
  perform pg_temp.como(null);
  return sqlstate || ': ' || sqlerrm;
end $$;
select pg_temp.expect('Q16 los avisos SYSTEM no gastan ni respetan el cupo del chat',
  pg_temp.aviso_del_sistema(), 'ACEPTADO');

update platform_settings
   set rate_limit_jobs_per_day = 30, rate_limit_offers_per_hour = 30, rate_limit_messages_per_minute = 20
 where id;


-- =============================================================================
\echo ''
\echo '--- Storage: subir solo al ámbito propio'

select * from pg_temp.montar_trabajo('q-ev1') \gset e1_
select pg_temp.avanzar(:'e1_assignment_id', 'IN_PROGRESS') is null as _ \gset
select * from pg_temp.montar_trabajo('q-ev2') \gset e2_

select pg_temp.expect('Q20 evidencia en carpeta y asignación propias',
  pg_temp.subir(:'e1_worker_id', 'evidence',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg',
    'image/jpeg', 120000), 'FILAS 1');

-- El tercero no participa de la asignación e1: su carpeta es suya, el ámbito no.
select pg_temp.expect('Q21 evidencia en carpeta propia pero de una asignación ajena',
  pg_temp.subir('c5000000-0000-4000-8000-000000000003', 'evidence',
    'c5000000-0000-4000-8000-000000000003/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000002.jpg',
    'image/jpeg', 1000), 'ERROR 42501');

select pg_temp.expect('Q22 evidencia sin ámbito o con un ámbito que no es un identificador',
  pg_temp.subir(:'e1_worker_id', 'evidence', :'e1_worker_id' || '/suelta.jpg', 'image/jpeg', 1000) || ' | '
  || pg_temp.subir(:'e1_worker_id', 'evidence', :'e1_worker_id' || '/no-es-uuid/x.jpg', 'image/jpeg', 1000),
  'ERROR 42501 | ERROR 42501');

select pg_temp.expect('Q23 evidencia en la carpeta de otra persona',
  pg_temp.subir(:'e1_worker_id', 'evidence',
    :'e1_client_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000003.jpg',
    'image/jpeg', 1000), 'ERROR 42501');

select pg_temp.expect('Q24 fotos de un trabajo publicado propio',
  pg_temp.subir('c5000000-0000-4000-8000-000000000001', 'job-images',
    'c5000000-0000-4000-8000-000000000001/c5100000-0000-4000-8000-000000000011/c5200000-0000-4000-8000-000000000004.jpg',
    'image/jpeg', 1000), 'FILAS 1');

select pg_temp.expect('Q25 job-images: trabajo ajeno, trabajo ya pagado, o sin trabajo',
  pg_temp.subir('c5000000-0000-4000-8000-000000000002', 'job-images',
    'c5000000-0000-4000-8000-000000000002/c5100000-0000-4000-8000-000000000011/c5200000-0000-4000-8000-000000000005.jpg',
    'image/jpeg', 1000) || ' | '
  || pg_temp.subir(:'e1_client_id', 'job-images',
    :'e1_client_id' || '/' || :'e1_job_id' || '/c5200000-0000-4000-8000-000000000006.jpg', 'image/jpeg', 1000) || ' | '
  || pg_temp.subir('c5000000-0000-4000-8000-000000000001', 'job-images',
    'c5000000-0000-4000-8000-000000000001/foto.jpg', 'image/jpeg', 1000),
  'ERROR 42501 | ERROR 42501 | ERROR 42501');

select pg_temp.expect('Q26 políticas de Storage, las mismas que exige verify:schema:hosted',
  (select count(*)::text from pg_policies where schemaname = 'storage'), '14');
select pg_temp.expect('Q27 políticas de borrado: avatares, y evidencia y disputas sin registrar',
  (select string_agg(policyname, ', ' order by policyname) from pg_policies
    where schemaname = 'storage' and cmd = 'DELETE'),
  'avatars_own_delete, dispute_files_own_delete_unregistered, evidence_own_delete_unregistered');


-- =============================================================================
\echo ''
\echo '--- add_job_evidence contrasta con Storage'

create function pg_temp.registrar(p_user uuid, p_a uuid, p_path text, p_mime text, p_size integer)
returns text language sql as $$
  select pg_temp.rpc(p_user, format(
    'select public.add_job_evidence(%L, %L, %L, null, %L, %L, %L)::text',
    p_a, 'PHOTO', 'Foto de la fila', p_path, p_mime, p_size))
$$;

select pg_temp.expect('Q30 un archivo que no está en Storage no se registra',
  pg_temp.registrar(:'e1_worker_id', :'e1_assignment_id',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-0000000000ff.jpg',
    'image/jpeg', 1000),
  'ERROR P0002: No encontramos el archivo subido. Vuelve a adjuntarlo.');

select pg_temp.expect('Q31 el tamaño declarado no coincide con el que midió Storage',
  pg_temp.registrar(:'e1_worker_id', :'e1_assignment_id',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg',
    'image/jpeg', 1),
  'ERROR 23514: El tamaño del archivo no coincide con el que se subió');

select pg_temp.expect('Q32 el tipo declarado no coincide con el que anotó Storage',
  pg_temp.registrar(:'e1_worker_id', :'e1_assignment_id',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg',
    'application/pdf', 120000),
  'ERROR 23514: El tipo del archivo no coincide con el que se subió');

-- Lo que ya está en Storage fuera de los límites —subido antes de que el bucket
-- los tuviera, o por el rol de servicio— tampoco entra, aunque se declare igual.
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('evidence', :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000007.jpg',
   :'e1_worker_id', '{"size": 52428800, "mimetype": "image/jpeg"}'),
  ('evidence', :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000008.svg',
   :'e1_worker_id', '{"size": 2000, "mimetype": "image/svg+xml"}');

select pg_temp.expect('Q33 un archivo de 50 MB declarado tal cual',
  pg_temp.registrar(:'e1_worker_id', :'e1_assignment_id',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000007.jpg',
    'image/jpeg', 52428800),
  'ERROR 23514: El archivo supera el tamaño permitido');

select pg_temp.expect('Q34 un SVG declarado tal cual',
  pg_temp.registrar(:'e1_worker_id', :'e1_assignment_id',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000008.svg',
    'image/svg+xml', 2000),
  'ERROR 22023: Formato de archivo no admitido');

-- El mismo trabajador tiene otra asignación (e2): su archivo vive en la carpeta
-- de esa otra, y no se puede colgar de e1.
select pg_temp.subir(:'e2_worker_id', 'evidence',
  :'e2_worker_id' || '/' || :'e2_assignment_id' || '/c5200000-0000-4000-8000-000000000009.jpg',
  'image/jpeg', 3000) as _ \gset
select pg_temp.expect('Q35 un archivo de otra asignación no se registra en esta',
  pg_temp.registrar(:'e1_worker_id', :'e1_assignment_id',
    :'e2_worker_id' || '/' || :'e2_assignment_id' || '/c5200000-0000-4000-8000-000000000009.jpg',
    'image/jpeg', 3000),
  'ERROR 22023: La ruta del archivo no corresponde a este trabajo');

select pg_temp.expect('Q36 una ruta en la carpeta de otra persona',
  pg_temp.registrar(:'e1_client_id', :'e1_assignment_id',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg',
    'image/jpeg', 120000),
  'ERROR 42501: La ruta del archivo no corresponde a tu carpeta');

select pg_temp.registrar(:'e1_worker_id', :'e1_assignment_id',
  :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg',
  'image/jpeg', 120000) as q37_id \gset
select pg_temp.expect('Q37 el archivo que sí está se registra con lo que midió Storage',
  (select mime_type || ' · ' || size_bytes from job_evidence where id::text = :'q37_id'),
  'image/jpeg · 120000');

select pg_temp.expect('Q38 el mismo archivo no se registra dos veces',
  pg_temp.registrar(:'e1_worker_id', :'e1_assignment_id',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg',
    'image/jpeg', 120000),
  'ERROR 23514: Ese archivo ya está adjunto');


-- =============================================================================
\echo ''
\echo '--- Storage: borrar solo lo propio que no se registró'

select pg_temp.expect('Q40 el autor no borra evidencia ya registrada',
  pg_temp.borrar(:'e1_worker_id', 'evidence',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg'), 'FILAS 0');

select pg_temp.expect('Q41 ni la contraparte, ni la administración',
  pg_temp.borrar(:'e1_client_id', 'evidence',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg') || ' | '
  || pg_temp.borrar(pg_temp.admin_id(), 'evidence',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg'),
  'FILAS 0 | FILAS 0');

select pg_temp.expect('Q42 el archivo registrado sigue en Storage',
  (select count(*)::text from storage.objects where bucket_id = 'evidence'
     and name = :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000001.jpg'), '1');

-- La limpieza tras un registro fallido: el archivo de 50 MB no se registró.
select pg_temp.expect('Q43 la contraparte no borra lo que no se registró',
  pg_temp.borrar(:'e1_client_id', 'evidence',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000007.jpg'), 'FILAS 0');
select pg_temp.expect('Q44 el autor sí, que es lo que hace la aplicación al fallar el registro',
  pg_temp.borrar(:'e1_worker_id', 'evidence',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000007.jpg'), 'FILAS 1');

select pg_temp.expect('Q45 un archivo borrado ya no se puede registrar',
  pg_temp.registrar(:'e1_worker_id', :'e1_assignment_id',
    :'e1_worker_id' || '/' || :'e1_assignment_id' || '/c5200000-0000-4000-8000-000000000007.jpg',
    'image/jpeg', 52428800),
  'ERROR P0002: No encontramos el archivo subido. Vuelve a adjuntarlo.');

-- Avatares: lo que usa la aplicación al reemplazar la foto.
select pg_temp.subir('c5000000-0000-4000-8000-000000000003', 'avatars',
  'c5000000-0000-4000-8000-000000000003/c5200000-0000-4000-8000-00000000000a.jpg', 'image/jpeg', 5000) as _ \gset
select pg_temp.expect('Q46 nadie más borra la foto de perfil de una persona',
  pg_temp.borrar('c5000000-0000-4000-8000-000000000001', 'avatars',
    'c5000000-0000-4000-8000-000000000003/c5200000-0000-4000-8000-00000000000a.jpg'), 'FILAS 0');
select pg_temp.expect('Q47 su dueña sí, al reemplazarla',
  pg_temp.borrar('c5000000-0000-4000-8000-000000000003', 'avatars',
    'c5000000-0000-4000-8000-000000000003/c5200000-0000-4000-8000-00000000000a.jpg'), 'FILAS 1');

select pg_temp.expect('Q48 en job-images nadie borra con su sesión, ni el dueño',
  pg_temp.borrar('c5000000-0000-4000-8000-000000000001', 'job-images',
    'c5000000-0000-4000-8000-000000000001/c5100000-0000-4000-8000-000000000011/c5200000-0000-4000-8000-000000000004.jpg'),
  'FILAS 0');


-- =============================================================================
\echo ''
\echo '--- add_dispute_evidence contrasta con Storage'

create function pg_temp.disputar(p_a uuid)
returns uuid language plpgsql as $$
declare v_c uuid; v uuid;
begin
  select client_id into v_c from public.assignments where id = p_a;
  perform pg_temp.como(v_c);
  v := public.open_dispute(p_a, 'Trabajo no realizado', 'El trabajador no llegó y la fila no se hizo.');
  perform pg_temp.como(null);
  return v;
end $$;

select pg_temp.avanzar(:'e2_assignment_id', 'IN_PROGRESS') is null as _ \gset
select pg_temp.disputar(:'e2_assignment_id') as d2 \gset

create function pg_temp.probar(p_user uuid, p_d uuid, p_body text, p_path text, p_mime text, p_size integer)
returns text language sql as $$
  select pg_temp.rpc(p_user, format(
    'select public.add_dispute_evidence(%L, %L, %L, %L, %L)::text', p_d, p_body, p_path, p_mime, p_size))
$$;

select pg_temp.expect('Q50 un tercero no sube archivos a una disputa ajena',
  pg_temp.subir('c5000000-0000-4000-8000-000000000003', 'dispute-files',
    'c5000000-0000-4000-8000-000000000003/' || :'d2' || '/c5200000-0000-4000-8000-00000000000b.pdf',
    'application/pdf', 4000), 'ERROR 42501');

select pg_temp.expect('Q51 un archivo de disputa que no está en Storage no se registra',
  pg_temp.probar(:'e2_client_id', :'d2', null,
    :'e2_client_id' || '/' || :'d2' || '/c5200000-0000-4000-8000-0000000000fe.pdf', 'application/pdf', 4000),
  'ERROR P0002: No encontramos el archivo subido. Vuelve a adjuntarlo.');

select pg_temp.subir(:'e2_client_id', 'dispute-files',
  :'e2_client_id' || '/' || :'d2' || '/c5200000-0000-4000-8000-00000000000c.pdf', 'application/pdf', 4000) as _ \gset
select pg_temp.expect('Q52 el tamaño declarado de una prueba tiene que coincidir',
  pg_temp.probar(:'e2_client_id', :'d2', null,
    :'e2_client_id' || '/' || :'d2' || '/c5200000-0000-4000-8000-00000000000c.pdf', 'application/pdf', 10),
  'ERROR 23514: El tamaño del archivo no coincide con el que se subió');

select pg_temp.probar(:'e2_client_id', :'d2', 'Adjunto el comprobante.',
  :'e2_client_id' || '/' || :'d2' || '/c5200000-0000-4000-8000-00000000000c.pdf', 'application/pdf', 4000) as q53 \gset
select pg_temp.expect('Q53 una prueba con su archivo en Storage se registra',
  (select count(*)::text from dispute_evidence where id::text = :'q53'), '1');

select pg_temp.expect('Q54 una prueba registrada no se borra, ni por su autor',
  pg_temp.borrar(:'e2_client_id', 'dispute-files',
    :'e2_client_id' || '/' || :'d2' || '/c5200000-0000-4000-8000-00000000000c.pdf'), 'FILAS 0');

update platform_settings set evidence_max_per_assignment = 2 where id;
create function pg_temp.dos_pruebas_mas(p_user uuid, p_d uuid)
returns text language plpgsql as $$
begin
  return pg_temp.probar(p_user, p_d, 'Otra prueba escrita.', null, null, null) ~ '^[0-9a-f-]{36}$' || ' | '
      || pg_temp.probar(p_user, p_d, 'Y una más.', null, null, null);
end $$;
select pg_temp.expect('Q55 las pruebas de una disputa tienen tope por persona, como la evidencia',
  pg_temp.dos_pruebas_mas(:'e2_client_id', :'d2'),
  'true | ERROR 23514: Alcanzaste el máximo de pruebas para esta disputa');
select pg_temp.expect('Q56 la administración no tiene ese tope',
  (pg_temp.probar(pg_temp.admin_id(), :'d2', 'Nota de la administración.', null, null, null)
     ~ '^[0-9a-f-]{36}$')::text, 'true');
update platform_settings set evidence_max_per_assignment = 40 where id;


-- =============================================================================
\echo ''
\echo '--- Código de entrega: solo con el trabajo en curso'

select * from pg_temp.montar_trabajo('q-pin1') \gset p1_
select pg_temp.avanzar(:'p1_assignment_id', 'CHECKED_IN') is null as _ \gset

select pg_temp.expect('Q60 con la llegada registrada, el cliente todavía no genera el código',
  pg_temp.rpc(:'p1_client_id', format('select public.generate_handoff_code(%L)::text', :'p1_assignment_id')),
  'ERROR 23514: El código de entrega se genera con el trabajo en curso');

select pg_temp.expect('Q61 ni el trabajador lo pide',
  pg_temp.rpc(:'p1_worker_id', format('select public.request_handoff_code(%L)::text', :'p1_assignment_id')),
  'ERROR 23514: El código de entrega se pide con el trabajo en curso');

-- Un código que quedó de antes de la corrección, generado en CHECKED_IN.
insert into handoff_codes (assignment_id, code, attempts, expires_at)
values (:'p1_assignment_id', '4321', 0, now() + interval '12 hours');

create function pg_temp.seis_fallos(p_a uuid, p_w uuid)
returns text language plpgsql as $$
declare i int; r text; v_ultimo text;
begin
  for i in 1..6 loop
    r := pg_temp.rpc(p_w, format('select public.verify_handoff_code(%L, %L)::text', p_a, '0000'));
    v_ultimo := r;
  end loop;
  return v_ultimo;
end $$;
select pg_temp.expect('Q62 validar en CHECKED_IN se rechaza con un motivo, seis veces',
  pg_temp.seis_fallos(:'p1_assignment_id', :'p1_worker_id'),
  'ERROR 23514: El código de entrega se valida con el trabajo en curso. Primero comienza el trabajo.');
select pg_temp.expect('Q63 y no gasta ningún intento',
  (select attempts::text from handoff_codes where assignment_id = :'p1_assignment_id'), '0');

-- Comienza el trabajo: el mismo código sirve, sin bloqueo de 12 horas.
create function pg_temp.comenzar(p_a uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  perform public.start_job_work(p_a);
  perform pg_temp.como(null);
end $$;
select pg_temp.comenzar(:'p1_assignment_id') is null as _ \gset

select pg_temp.rpc(:'p1_worker_id',
  format('select public.verify_handoff_code(%L, %L)::text', :'p1_assignment_id', '0000')) as q64 \gset
select pg_temp.expect('Q64 en curso, un código equivocado sí gasta un intento',
  :'q64' || ' · ' || (select attempts::text from handoff_codes where assignment_id = :'p1_assignment_id'),
  'false · 1');
select pg_temp.rpc(:'p1_worker_id',
  format('select public.verify_handoff_code(%L, %L)::text', :'p1_assignment_id', '4321')) as q65 \gset
select pg_temp.expect('Q65 y el correcto cierra la entrega',
  :'q65' || ' · ' || (select status::text from assignments where id = :'p1_assignment_id'),
  'true · HANDOFF_COMPLETED');

-- Con la entrega ya pedida por el botón de cierre, un código pendiente no gasta
-- intentos: ya no hay entrega que cerrar.
select * from pg_temp.montar_trabajo('q-pin2') \gset p2_
select pg_temp.avanzar(:'p2_assignment_id', 'IN_PROGRESS') is null as _ \gset
select pg_temp.rpc(:'p2_client_id', format('select public.generate_handoff_code(%L)::text', :'p2_assignment_id')) as _ \gset
create function pg_temp.pedir_cierre(p_a uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  perform public.request_job_completion(p_a, 'Listo sin código.');
  perform pg_temp.como(null);
end $$;
select pg_temp.pedir_cierre(:'p2_assignment_id') is null as _ \gset
select pg_temp.rpc(:'p2_worker_id',
  format('select public.verify_handoff_code(%L, %L)::text', :'p2_assignment_id', '0000')) as q66 \gset
select pg_temp.expect('Q66 con la entrega ya registrada, validar no gasta intento',
  :'q66' || ' · ' || (select attempts::text from handoff_codes where assignment_id = :'p2_assignment_id'),
  'ERROR 23514: La entrega de este trabajo ya quedó registrada · 0');

-- Con una disputa abierta el trabajo se congela, también para el código.
select * from pg_temp.montar_trabajo('q-pin3') \gset p3_
select pg_temp.avanzar(:'p3_assignment_id', 'IN_PROGRESS') is null as _ \gset
select pg_temp.rpc(:'p3_client_id', format('select public.generate_handoff_code(%L)::text', :'p3_assignment_id')) as p3_code \gset
select pg_temp.disputar(:'p3_assignment_id') is not null as _ \gset
select pg_temp.rpc(:'p3_worker_id',
  format('select public.verify_handoff_code(%L, %L)::text', :'p3_assignment_id', :'p3_code')) as q67 \gset
select pg_temp.expect('Q67 con una disputa abierta, ni el código correcto cierra la entrega ni gasta intento',
  :'q67'
  || ' · ' || (select attempts::text || ' · ' || (verified_at is null)::text from handoff_codes where assignment_id = :'p3_assignment_id')
  || ' · ' || (select status::text from assignments where id = :'p3_assignment_id'),
  'ERROR 23514: Hay una disputa abierta: la entrega queda en pausa hasta que la administración la resuelva · 0 · true · IN_PROGRESS');

-- Con el pago del trabajo de vuelta en revisión (PAID → UNDER_REVIEW, que la
-- base admite) `require_payment_before_work` no deja cerrar la entrega: ni el
-- código correcto ni uno equivocado gastan intento.
select * from pg_temp.montar_trabajo('q-pin4') \gset p4_
select pg_temp.avanzar(:'p4_assignment_id', 'IN_PROGRESS') is null as _ \gset
select pg_temp.rpc(:'p4_client_id', format('select public.generate_handoff_code(%L)::text', :'p4_assignment_id')) as p4_code \gset
update payments set status = 'UNDER_REVIEW', review_reason = 'Prueba Q68' where id = :'p4_payment_id';
create function pg_temp.validar_mal_y_bien(p_a uuid, p_w uuid, p_code text)
returns text language plpgsql as $$
begin
  return pg_temp.rpc(p_w, format('select public.verify_handoff_code(%L, %L)::text', p_a,
                                 case when p_code = '0000' then '1111' else '0000' end))
      || ' | '
      || pg_temp.rpc(p_w, format('select public.verify_handoff_code(%L, %L)::text', p_a, p_code));
end $$;
select pg_temp.validar_mal_y_bien(:'p4_assignment_id', :'p4_worker_id', :'p4_code') as q68 \gset
select pg_temp.expect('Q68 con el pago en revisión, validar no gasta intento ni cierra la entrega',
  :'q68'
  || ' · ' || (select attempts::text || ' · ' || (verified_at is null)::text from handoff_codes where assignment_id = :'p4_assignment_id')
  || ' · ' || (select status::text from assignments where id = :'p4_assignment_id'),
  'ERROR 23514: El pago de este trabajo no está confirmado: la entrega queda en pausa hasta que se resuelva'
  || ' | ERROR 23514: El pago de este trabajo no está confirmado: la entrega queda en pausa hasta que se resuelva'
  || ' · 0 · true · IN_PROGRESS');


-- =============================================================================
\echo ''
\echo '--- Check-in sin precisión'

select * from pg_temp.montar_trabajo('q-ci1') \gset c1_

create function pg_temp.check_in_sin_precision(p_a uuid)
returns text language plpgsql as $$
declare v_w uuid; r jsonb; v_inicio text;
begin
  select worker_id into v_w from public.assignments where id = p_a;
  perform pg_temp.como(v_w);
  perform public.mark_on_the_way(p_a);
  -- En el lugar exacto, pero sin decir con qué precisión.
  r := public.register_check_in(p_a, true, -33.4265, -70.6153, null, 'device');
  begin
    perform public.start_job_work(p_a);
    v_inicio := 'comenzó';
  exception when check_violation then
    v_inicio := 'no comienza';
  end;
  perform pg_temp.como(null);
  return (r ->> 'result') || ' · ' || (r ->> 'review_status') || ' · ' || (r ->> 'can_start') || ' · ' || v_inicio;
end $$;
select pg_temp.expect('Q70 coordenadas sin precisión: en revisión, y no deja comenzar',
  pg_temp.check_in_sin_precision(:'c1_assignment_id'), 'LOW_ACCURACY · PENDING · false · no comienza');

select pg_temp.expect('Q71 la línea de tiempo dice por qué',
  (select body from job_evidence where assignment_id = :'c1_assignment_id' and event_key = 'check_in'),
  'El teléfono no informó la precisión de la ubicación. Queda pendiente de revisión.');

create function pg_temp.check_in_con_precision(p_a uuid)
returns text language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  r := public.register_check_in(p_a, true, -33.4265, -70.6153, 20, 'device');
  perform pg_temp.como(null);
  return (r ->> 'result') || ' · ' || (r ->> 'can_start');
end $$;
select pg_temp.expect('Q72 el reintento con precisión sí se verifica',
  pg_temp.check_in_con_precision(:'c1_assignment_id'), 'VERIFIED · true');
