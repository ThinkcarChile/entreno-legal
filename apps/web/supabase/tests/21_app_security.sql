\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Lo que ven las pantallas y lo que se puede escribir en los avisos
-- =============================================================================
-- Prefijo G. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Los defectos que cierra esta batería, reproducidos antes de corregirlos:
--
--   · la página pública de un trabajo fallaba entera sin sesión: `anon` no
--     tenía SELECT sobre ninguna columna de `job_evidence` (20260601001800);
--   · el título del trabajo y el motivo de cancelación entraban sin regla en
--     los avisos de la contraparte, y una comilla cerraba la cita
--     (20260601001810);
--   · `add_job_evidence` mandaba como cuerpo del aviso el texto de la otra
--     parte, sin autor, y lo aceptaba antes del pago y con el trabajo cerrado
--     (20260601001820);
--   · `request_handoff_code` avisaba al cliente en cada llamada, sin tope
--     (20260601001830);
--   · cualquiera listaba `avatars` y `job-images` sin sesión, y subir no tenía
--     tope ni miraba si la asignación seguía viva (20260601001840).
--
-- Cuentas y trabajos propios de esta batería (prefijo c7b3…), o montados en el
-- momento: nada depende de lo que dejaron las anteriores.
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

-- Trabajo publicado, oferta aceptada y, si se pide, el pago confirmado con el
-- proveedor simulado. Todo como sistema: no gasta el cupo de nadie.
create function pg_temp.montar(
  p_tag text,
  p_pagar boolean,
  out job_id uuid,
  out assignment_id uuid,
  out client_id uuid,
  out worker_id uuid
)
language plpgsql
as $$
declare
  v_offer uuid;
  v_payment uuid;
  v_tag text := p_tag || '-' || substr(md5(random()::text), 1, 6);
begin
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
    'Fila de prueba de avisos ' || p_tag,
    'Montaje de la prueba de lo que ven las pantallas y lo que dicen los avisos.',
    '13', '13-santiago', 'Lugar de prueba', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000, now()
  );
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, worker_id, 9000, 18000, 'Oferta de prueba ' || p_tag)
  returning id into v_offer;

  perform pg_temp.como(client_id);
  assignment_id := public.accept_job_offer(v_offer);
  if p_pagar then
    v_payment := public.start_protected_payment(assignment_id);
  end if;
  perform pg_temp.como(null);

  if p_pagar then
    update public.payments
       set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-' || v_tag
     where id = v_payment;
    perform public.confirm_payment_result(v_payment, 'mock', 'evt-' || v_tag, 'PAID', null, '{}');
  end if;
end;
$$;

-- El trabajador avanza hasta el estado pedido; el cliente aprueba si se pide.
create function pg_temp.avanzar(p_a uuid, p_hasta text)
returns void language plpgsql as $$
declare v_w uuid; v_c uuid;
begin
  select worker_id, client_id into v_w, v_c from public.assignments where id = p_a;
  perform pg_temp.como(v_w);
  perform public.mark_on_the_way(p_a);
  perform public.register_check_in(p_a, true, -33.4265, -70.6153, 20, 'device');
  perform public.start_job_work(p_a);
  if p_hasta in ('HANDOFF_COMPLETED', 'COMPLETED') then
    perform public.request_job_completion(p_a, 'Listo.');
  end if;
  if p_hasta = 'COMPLETED' then
    perform pg_temp.como(v_c);
    perform public.approve_job_completion(p_a, true);
  end if;
  perform pg_temp.como(null);
end $$;

-- Una sentencia como `authenticated` con la identidad dada (o como `anon` sin
-- ella). Devuelve el primer valor o el error, sin abortar la batería.
create function pg_temp.leer(p_role text, p_user uuid, p_sql text)
returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.como(p_user);
  if p_role = 'anon' then set local role anon; else set local role authenticated; end if;
  execute p_sql into r;
  reset role;
  perform pg_temp.como(null);
  return coalesce(r, 'NULO');
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'ERROR ' || sqlstate;
end $$;

-- Lo mismo para escribir: devuelve las filas afectadas o el error.
create function pg_temp.escribir(p_user uuid, p_sql text)
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

-- Una RPC con la identidad dada: «OK» o el error con su mensaje.
create function pg_temp.hacer(p_user uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform pg_temp.como(p_user);
  execute p_sql;
  perform pg_temp.como(null);
  return 'OK';
exception when others then
  perform pg_temp.como(null);
  return 'ERROR ' || sqlstate || ': ' || sqlerrm;
end $$;

-- Lo que hace Storage al terminar una subida: la fila con sus metadatos, con
-- la sesión de quien sube y bajo las políticas del bucket.
create function pg_temp.subir(p_user uuid, p_bucket text, p_name text)
returns text language sql as $$
  select pg_temp.escribir(p_user, format(
    'insert into storage.objects (bucket_id, name, owner, metadata) values (%L, %L, %L, %L::jsonb)',
    p_bucket, p_name, p_user, '{"size": 1000, "mimetype": "image/jpeg"}'))
$$;

create function pg_temp.evidencia(p_user uuid, p_a uuid, p_title text)
returns text language sql as $$
  select pg_temp.hacer(p_user, format(
    'select public.add_job_evidence(%L, %L, %L)', p_a, 'NOTE', p_title))
$$;


-- =============================================================================
\echo ''
\echo '--- La página pública de un trabajo, sin sesión'

select * from pg_temp.montar('g-pub', true) \gset g1_
select pg_temp.avanzar(:'g1_assignment_id', 'IN_PROGRESS') is null as _ \gset

-- Exactamente las columnas que pide la página (EVIDENCE_COLUMNS en
-- src/lib/data/supabase/shared.ts).
\set evidencia_cols 'id,job_id,assignment_id,author_id,author_name,evidence_type,title,body,storage_path,image_url,queue_ahead,occurred_at,created_at,event_key,visibility,mime_type,size_bytes'

select pg_temp.expect('G01 un visitante lee la línea de tiempo sin error, y vacía',
  pg_temp.leer('anon', null, format(
    'select count(*)::text from (select %s from public.job_evidence where job_id = %L) s',
    :'evidencia_cols', :'g1_job_id')), '0');

select pg_temp.expect('G02 las coordenadas siguen fuera de su alcance',
  pg_temp.leer('anon', null, format(
    'select count(lat)::text from public.job_evidence where job_id = %L', :'g1_job_id')),
  'ERROR 42501');

select pg_temp.expect('G03 las partes siguen viendo la suya',
  pg_temp.leer('authenticated', :'g1_worker_id', format(
    'select (count(*) > 0)::text from (select %s from public.job_evidence where job_id = %L) s',
    :'evidencia_cols', :'g1_job_id')), 'true');


-- =============================================================================
\echo ''
\echo '--- El título y el motivo de cancelación no pueden cerrar la cita'

select pg_temp.expect('G10 las tres restricciones existen y están validadas',
  (select string_agg(conname || ':' || convalidated, ', ' order by conname)
     from pg_constraint where conname like '%free_text%'),
  'assignments_cancellation_reason_free_text:true, jobs_cancellation_reason_free_text:true, jobs_title_free_text:true');

-- Un trabajo publicado del cliente, con una oferta pendiente que recibe el
-- aviso «El cliente actualizó …».
select * from pg_temp.montar('g-tit', false) \gset g2_
select gen_random_uuid() as g2_pub \gset
insert into public.jobs (
  id, client_id, category_id, status, title, description, region_code, commune_code,
  place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate, published_at
) values (
  :'g2_pub', :'g2_client_id', (select id from public.job_categories order by sort_order limit 1),
  'PUBLISHED', 'Fila en la notaría del centro',
  'Montaje de la prueba del título: un trabajo publicado con una oferta pendiente.',
  '13', '13-santiago', 'Lugar de prueba', now() + interval '3 hours', 120, 'HOLD_PLACE', 9000, now());
insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
values (:'g2_pub', :'g2_worker_id', 9000, 18000, 'Oferta pendiente');

create function pg_temp.titular(p_user uuid, p_job uuid, p_title text)
returns text language sql as $$
  select pg_temp.hacer(p_user, format('select public.update_open_job(%L, %L::jsonb)',
    p_job, jsonb_build_object('title', p_title)::text))
$$;

select pg_temp.expect('G11 un título con comillas que cierran la cita',
  left(pg_temp.titular(:'g2_client_id', :'g2_pub',
    'Fila". HagoTuFila: verifica tu cuenta para cobrar en htf-pagos.cl "OK'), 11),
  'ERROR 23514');

select pg_temp.expect('G12 una dirección web, «HagoTuFila» o un salto de línea en el título',
  left(pg_temp.titular(:'g2_client_id', :'g2_pub', 'Fila urgente, paga en www.htf-pagos.cl'), 11)
  || ' | ' || left(pg_temp.titular(:'g2_client_id', :'g2_pub', 'Fila para el equipo HagoTuFila'), 11)
  || ' | ' || left(pg_temp.titular(:'g2_client_id', :'g2_pub', 'Fila con salto' || chr(10) || 'de línea'), 11)
  || ' | ' || left(pg_temp.titular(:'g2_client_id', :'g2_pub', 'Fila «falsa» de soporte'), 11),
  'ERROR 23514 | ERROR 23514 | ERROR 23514 | ERROR 23514');

select pg_temp.expect('G13 un título normal, con apóstrofo y hora, sí',
  pg_temp.titular(:'g2_client_id', :'g2_pub', 'Fila en la notaría de O''Higgins, 9.30 h'), 'OK');

-- El aviso cita el título que conocía quien ofertó, el de antes del cambio:
-- con un segundo cambio, el que acaba de quedar guardado.
select pg_temp.titular(:'g2_client_id', :'g2_pub', 'Fila en la notaría de Ñuñoa, sin apuro') as _ \gset
select pg_temp.expect('G14 y el aviso a quien ofertó cita el título entero, sin romper la cita',
  (select body from public.notifications
    where user_id = :'g2_worker_id' and notification_type = 'JOB_UPDATED'
      and job_id = :'g2_pub'
    order by created_at desc limit 1),
  'El cliente actualizó "Fila en la notaría de O''Higgins, 9.30 h". Revisa si tu oferta sigue vigente.');

create function pg_temp.insertar_titulo(p_client uuid, p_title text)
returns text language plpgsql as $$
begin
  insert into public.jobs (
    client_id, category_id, status, title, description, region_code, commune_code,
    starts_at, estimated_duration_minutes, objective_type, hourly_rate
  ) values (
    p_client, (select id from public.job_categories order by sort_order limit 1), 'DRAFT', p_title,
    'Un borrador escrito directo en la tabla, sin pasar por ninguna función.',
    '13', '13-santiago', now() + interval '3 hours', 120, 'HOLD_PLACE', 9000);
  return 'ACEPTADO';
exception when others then
  return 'ERROR ' || sqlstate;
end $$;
select pg_temp.expect('G15 la regla vale también para la clave de servicio, sin RPC',
  pg_temp.insertar_titulo(:'g2_client_id', 'Paga tu fila en https://htf-pagos.cl'), 'ERROR 23514');

-- Cancelar con motivo: el cliente de g2, con la oferta aceptada y sin pagar.
create function pg_temp.cancelar(p_user uuid, p_job uuid, p_reason text)
returns text language sql as $$
  select pg_temp.hacer(p_user, format('select public.cancel_job(%L, %L)', p_job, p_reason))
$$;

select pg_temp.expect('G16 un motivo con dirección web, «HagoTuFila», salto de línea o de más de 300',
  left(pg_temp.cancelar(:'g2_client_id', :'g2_job_id', 'Reactiva tu cuenta en https://htf-soporte.cl'), 11)
  || ' | ' || left(pg_temp.cancelar(:'g2_client_id', :'g2_job_id', 'Equipo HagoTuFila: cuenta suspendida'), 11)
  || ' | ' || left(pg_temp.cancelar(:'g2_client_id', :'g2_job_id', 'Cambié' || chr(10) || 'de planes'), 11)
  || ' | ' || left(pg_temp.cancelar(:'g2_client_id', :'g2_job_id', repeat('.', 301)), 11),
  'ERROR 23514 | ERROR 23514 | ERROR 23514 | ERROR 23514');

select pg_temp.expect('G17 un motivo normal cancela',
  pg_temp.cancelar(:'g2_client_id', :'g2_job_id', 'Cambié de planes, perdón por el aviso tardío.'), 'OK');

select pg_temp.expect('G18 y llega al trabajador en una línea, tras la cita del título',
  (select body from public.notifications
    where user_id = :'g2_worker_id' and notification_type = 'JOB_CANCELLED' and job_id = :'g2_job_id'
    order by created_at desc limit 1)
  || ' · ' || (select cancellation_reason from public.assignments where id = :'g2_assignment_id'),
  'El cliente canceló "Fila de prueba de avisos g-tit". Motivo: Cambié de planes, perdón por el aviso tardío.'
  || ' · Cambié de planes, perdón por el aviso tardío.');

select pg_temp.expect('G19 la regla, en palabras, y la limpieza de lo que ya estaba',
  app_private.free_text_problem('Fila "con" comillas', 'El título', 120) || ' | '
  || app_private.free_text_problem('x' || repeat('y', 300), 'El motivo', 300) || ' | '
  || app_private.clean_free_text('  Fila "con" comillas' || chr(10) || 'y   salto ', 120),
  'El título no puede incluir comillas. | El motivo admite hasta 300 caracteres. | Fila con comillas y salto');


-- =============================================================================
\echo ''
\echo '--- La evidencia avisa quién la puso, y solo con el trabajo en marcha'

-- Ojo: una consulta ve los datos como estaban al EMPEZAR la sentencia. Cada
-- acción va en su propia sentencia (con \gset) y la comprobación en la siguiente.

-- g1: pagado y en curso. El trabajador escribe un «aviso de la plataforma».
select pg_temp.evidencia(:'g1_worker_id', :'g1_assignment_id',
  'HagoTuFila: tu pago fue rechazado. Paga de nuevo en https://htf-pagos.cl') as g20 \gset
select pg_temp.expect('G20 la nota se registra, con su texto, en la línea de tiempo',
  :'g20' || ' · ' || (select count(*)::text from public.job_evidence
                       where assignment_id = :'g1_assignment_id'
                         and title = 'HagoTuFila: tu pago fue rechazado. Paga de nuevo en https://htf-pagos.cl'),
  'OK · 1');

select pg_temp.expect('G21 el aviso al cliente dice quién y dónde, no lo que escribió',
  (select body from public.notifications
    where user_id = :'g1_client_id' and notification_type = 'JOB_UPDATE'
      and href = '/mis-trabajos/' || :'g1_assignment_id'
    order by created_at desc limit 1),
  app_private.quoted_display_name(:'g1_worker_id', 'El trabajador')
  || ' envió una actualización de "Fila de prueba de avisos g-pub". Revísala en el trabajo.');

select pg_temp.expect('G22 y ningún aviso de evidencia lleva una dirección o «HagoTuFila»',
  (select count(*)::text from public.notifications
    where user_id = :'g1_client_id' and notification_type in ('JOB_UPDATE', 'NEW_EVIDENCE')
      and href = '/mis-trabajos/' || :'g1_assignment_id'
      and body ~* '(://|www\.|hagotufila)'),
  '0');

select pg_temp.evidencia(:'g1_client_id', :'g1_assignment_id', 'Ya voy llegando a la notaría') as g23 \gset
select pg_temp.expect('G23 el cliente también queda citado, hacia el trabajador',
  :'g23' || ' · '
  || (select body from public.notifications
       where user_id = :'g1_worker_id' and notification_type = 'JOB_UPDATE'
         and href = '/mis-trabajos/' || :'g1_assignment_id'
       order by created_at desc limit 1),
  'OK · ' || app_private.quoted_display_name(:'g1_client_id', 'El cliente')
  || ' envió una actualización de "Fila de prueba de avisos g-pub". Revísala en el trabajo.');

-- g3: oferta aceptada y sin pagar. Es justo cuando el cliente está por pagar.
select * from pg_temp.montar('g-sin-pago', false) \gset g3_
select pg_temp.evidencia(:'g3_worker_id', :'g3_assignment_id',
  'El pago con Webpay falló. Transfiere a la cuenta 123') as g24 \gset
select pg_temp.expect('G24 antes del pago no hay evidencia, ni su aviso',
  :'g24' || ' · ' || (select count(*)::text from public.notifications
                where user_id = :'g3_client_id' and href = '/mis-trabajos/' || :'g3_assignment_id'
                  and notification_type = 'JOB_UPDATE'),
  'ERROR 23514: Las actualizaciones se envían con el pago confirmado y el trabajo en marcha · 0');

-- g4: aprobado (COMPLETED).
select * from pg_temp.montar('g-aprobado', true) \gset g4_
select pg_temp.avanzar(:'g4_assignment_id', 'COMPLETED') is null as _ \gset
select pg_temp.expect('G25 con el trabajo aprobado tampoco',
  pg_temp.evidencia(:'g4_worker_id', :'g4_assignment_id', 'Una nota después de aprobado'),
  'ERROR 23514: Las actualizaciones se envían con el pago confirmado y el trabajo en marcha');

-- g5: disputa resuelta con el trabajo en curso: trabajo CLOSED, asignación
-- IN_PROGRESS, pago PAID (a favor del trabajador).
select * from pg_temp.montar('g-cerrado', true) \gset g5_
select pg_temp.avanzar(:'g5_assignment_id', 'IN_PROGRESS') is null as _ \gset
create function pg_temp.disputar_y_resolver(p_a uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  perform public.open_dispute(p_a, 'Trabajo no realizado', 'El trabajador no hizo la fila completa.');
  perform pg_temp.como(pg_temp.admin_id());
  perform public.resolve_dispute(
    (select id from public.disputes where assignment_id = p_a and status in ('OPEN', 'UNDER_REVIEW')),
    'WORKER_WINS', 'El trabajador acreditó la fila con su evidencia.', null);
  perform pg_temp.como(null);
  return (select j.status || '/' || a.status from public.assignments a
            join public.jobs j on j.id = a.job_id where a.id = p_a);
end $$;
select pg_temp.expect('G26 cerrado por la administración, tampoco',
  pg_temp.disputar_y_resolver(:'g5_assignment_id') || ' · '
  || pg_temp.evidencia(:'g5_client_id', :'g5_assignment_id', 'Otra nota tras la resolución'),
  'CLOSED/IN_PROGRESS · ERROR 23514: Las actualizaciones se envían con el pago confirmado y el trabajo en marcha');

-- Una devolución parcial no deja el trabajo sin pagar. Se simula el estado del
-- pago sin pasar por las guardas de liquidación, y se deshace al terminar.
create function pg_temp.con_pago_parcial(p_a uuid, p_w uuid)
returns text language plpgsql as $$
declare r text;
begin
  begin
    set local session_replication_role = replica;
    update public.payments set status = 'PARTIALLY_REFUNDED', refunded_amount = 1000
     where assignment_id = p_a and purpose = 'JOB';
    set local session_replication_role = origin;
    r := pg_temp.evidencia(p_w, p_a, 'Sigo en la fila, ya voy en el número 12');
    raise exception 'deshacer';
  exception when others then
    if sqlerrm <> 'deshacer' then r := 'ERROR ' || sqlerrm; end if;
  end;
  return r;
end $$;
select pg_temp.expect('G27 con el pago parcialmente devuelto, la evidencia sigue',
  pg_temp.con_pago_parcial(:'g1_assignment_id', :'g1_worker_id'), 'OK');


-- =============================================================================
\echo ''
\echo '--- Pedir el código de entrega avisa una vez cada pocos minutos'

select * from pg_temp.montar('g-pin', true) \gset g6_
select pg_temp.avanzar(:'g6_assignment_id', 'IN_PROGRESS') is null as _ \gset

create function pg_temp.pedir_codigo(p_a uuid)
returns text language sql as $$
  select pg_temp.hacer((select worker_id from public.assignments where id = p_a),
    format('select public.request_handoff_code(%L)', p_a))
$$;
create function pg_temp.avisos_de_codigo(p_a uuid)
returns text language sql as $$
  select count(*)::text from public.notifications
   where notification_type = 'HANDOFF_REQUESTED' and href = '/mis-trabajos/' || p_a
$$;
create function pg_temp.pedir_veinte_veces(p_a uuid)
returns text language plpgsql as $$
declare i int; r text;
begin
  for i in 1..20 loop
    r := pg_temp.pedir_codigo(p_a);
  end loop;
  return r;
end $$;

select pg_temp.expect('G30 la primera vez avisa',
  pg_temp.pedir_codigo(:'g6_assignment_id') || ' · ' || pg_temp.avisos_de_codigo(:'g6_assignment_id'),
  'OK · 1');

select pg_temp.expect('G31 veinte veces seguidas no dejan veinte avisos, y dice cuándo volver',
  pg_temp.pedir_veinte_veces(:'g6_assignment_id') || ' · ' || pg_temp.avisos_de_codigo(:'g6_assignment_id'),
  'ERROR PT429: Ya le avisamos al cliente hace un momento. Podrás volver a avisarle en 5 minutos. · 1');

update public.notifications set created_at = created_at - interval '6 minutes'
 where notification_type = 'HANDOFF_REQUESTED' and href = '/mis-trabajos/' || :'g6_assignment_id';
select pg_temp.expect('G32 pasado el plazo, se puede volver a avisar',
  pg_temp.pedir_codigo(:'g6_assignment_id') || ' · ' || pg_temp.avisos_de_codigo(:'g6_assignment_id'),
  'OK · 2');

select pg_temp.expect('G33 el plazo es por asignación: otra del mismo cliente avisa enseguida',
  pg_temp.pedir_codigo(:'g1_assignment_id') || ' · ' || pg_temp.avisos_de_codigo(:'g1_assignment_id'),
  'OK · 1');


-- =============================================================================
\echo ''
\echo '--- Storage: nadie lista los buckets públicos, y subir tiene tope'

insert into auth.users (id, email, raw_user_meta_data) values
  ('c7b30000-0000-4000-8000-000000000001', 'g-avatar@example.cl',
   '{"first_name": "Gabriela", "last_name": "Soto"}'),
  ('c7b30000-0000-4000-8000-000000000002', 'g-otro@example.cl',
   '{"first_name": "Gonzalo", "last_name": "Pérez"}');

-- Una foto de perfil ya subida, y una foto de un trabajo publicado.
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('avatars', 'c7b30000-0000-4000-8000-000000000001/c7b30000-0000-4000-8000-0000000000a0.jpg',
   'c7b30000-0000-4000-8000-000000000001', '{"size": 1000, "mimetype": "image/jpeg"}'),
  ('job-images', :'g2_client_id' || '/' || :'g2_pub' || '/c7b30000-0000-4000-8000-0000000000b0.jpg',
   :'g2_client_id', '{"size": 1000, "mimetype": "image/jpeg"}');

select pg_temp.expect('G40 sin sesión no se lista ningún archivo de avatars ni de job-images',
  pg_temp.leer('anon', null,
    'select count(*)::text from storage.objects where bucket_id in (''avatars'', ''job-images'')'),
  '0');

select pg_temp.expect('G41 con sesión, solo la carpeta propia de avatars, y nada de job-images',
  pg_temp.leer('authenticated', 'c7b30000-0000-4000-8000-000000000002',
    'select count(*)::text from storage.objects where bucket_id in (''avatars'', ''job-images'')')
  || ' | ' || pg_temp.leer('authenticated', 'c7b30000-0000-4000-8000-000000000001',
    'select count(*)::text from storage.objects where bucket_id = ''avatars''')
  || ' | ' || pg_temp.leer('authenticated', :'g2_client_id',
    'select count(*)::text from storage.objects where bucket_id = ''job-images'''),
  '0 | 1 | 0');

select pg_temp.expect('G42 lecturas de Storage que quedan',
  (select string_agg(policyname, ', ' order by policyname) from pg_policies
    where schemaname = 'storage' and cmd = 'SELECT'),
  'avatars_own_read, dispute_files_read, evidence_read, verification_own_read');

select pg_temp.expect('G43 la dueña sigue retirando su foto al reemplazarla',
  pg_temp.escribir('c7b30000-0000-4000-8000-000000000001',
    'delete from storage.objects where bucket_id = ''avatars'' and name = '
    || '''c7b30000-0000-4000-8000-000000000001/c7b30000-0000-4000-8000-0000000000a0.jpg'''),
  'FILAS 1');

create function pg_temp.subir_varias(p_user uuid, p_bucket text, p_prefix text, p_ext text, p_n int)
returns text language plpgsql as $$
declare i int; r text; v text := '';
begin
  for i in 1..p_n loop
    r := pg_temp.subir(p_user, p_bucket, p_prefix || 'c7b30000-0000-4000-8000-' || lpad(i::text, 12, '0') || p_ext);
    v := v || case when r = 'FILAS 1' then '+' else 'x' end;
  end loop;
  return v;
end $$;

select pg_temp.expect('G44 fotos de perfil: cinco en la carpeta propia, la sexta no',
  pg_temp.subir_varias('c7b30000-0000-4000-8000-000000000001', 'avatars',
    'c7b30000-0000-4000-8000-000000000001/', '.jpg', 6),
  '+++++x');

select pg_temp.expect('G45 una foto de perfil con un nombre que el perfil no admitiría',
  pg_temp.subir('c7b30000-0000-4000-8000-000000000002', 'avatars',
    'c7b30000-0000-4000-8000-000000000002/foto.gif') || ' | '
  || pg_temp.subir('c7b30000-0000-4000-8000-000000000002', 'avatars',
    'c7b30000-0000-4000-8000-000000000002/sub/foto.jpg'),
  'ERROR 42501 | ERROR 42501');

select pg_temp.expect('G46 fotos de un trabajo publicado: seis, la séptima no',
  pg_temp.subir_varias(:'g2_client_id', 'job-images', :'g2_client_id' || '/' || :'g2_pub' || '/', '.jpg', 7),
  -- La foto que ya estaba cuenta: cinco más entran.
  '+++++xx');

update platform_settings set evidence_max_per_assignment = 2 where id;
select pg_temp.expect('G47 evidencia: el tope por asignación cuenta los archivos, registrados o no',
  pg_temp.subir_varias(:'g1_worker_id', 'evidence',
    :'g1_worker_id' || '/' || :'g1_assignment_id' || '/', '.jpg', 3),
  '++x');
update platform_settings set evidence_max_per_assignment = 40 where id;

select pg_temp.expect('G48 a una asignación sin pagar, aprobada o cerrada no se sube evidencia',
  pg_temp.subir(:'g3_worker_id', 'evidence',
    :'g3_worker_id' || '/' || :'g3_assignment_id' || '/c7b30000-0000-4000-8000-0000000000c1.jpg')
  || ' | ' || pg_temp.subir(:'g4_worker_id', 'evidence',
    :'g4_worker_id' || '/' || :'g4_assignment_id' || '/c7b30000-0000-4000-8000-0000000000c2.jpg')
  || ' | ' || pg_temp.subir(:'g5_worker_id', 'evidence',
    :'g5_worker_id' || '/' || :'g5_assignment_id' || '/c7b30000-0000-4000-8000-0000000000c3.jpg'),
  'ERROR 42501 | ERROR 42501 | ERROR 42501');

-- Disputa abierta sobre g4 (aprobado, dentro del plazo): tope por persona, y la
-- administración sin tope, como en `add_dispute_evidence`.
select pg_temp.hacer(:'g4_client_id', format(
  'select public.open_dispute(%L, %L, %L)', :'g4_assignment_id', 'Trabajo incompleto',
  'La fila se abandonó antes de llegar al mesón.')) as _ \gset
select id as g4_dispute from public.disputes where assignment_id = :'g4_assignment_id' \gset
update platform_settings set evidence_max_per_assignment = 1 where id;
select pg_temp.expect('G49 archivos de disputa: tope por persona, la administración sin tope',
  pg_temp.subir_varias(:'g4_client_id', 'dispute-files', :'g4_client_id' || '/' || :'g4_dispute' || '/', '.pdf', 2)
  || ' | ' || pg_temp.subir_varias(pg_temp.admin_id(), 'dispute-files',
    pg_temp.admin_id() || '/' || :'g4_dispute' || '/', '.pdf', 2),
  '+x | ++');
update platform_settings set evidence_max_per_assignment = 40 where id;
