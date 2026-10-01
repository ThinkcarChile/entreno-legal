\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- La ventana de disputa retiene el pago al trabajador, y las tareas programadas
-- =============================================================================
-- Prefijo V. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- El defecto que cierra esta batería, reproducido antes de corregirlo: con la
-- ventana abierta, administración registraba la transferencia; el cliente
-- reclamaba dentro de su plazo; el payout seguía PAID y a las dos partes se les
-- decía «el pago queda retenido».
-- =============================================================================

create function pg_temp.expect(label text, actual text, expected text)
returns text language sql as $$
  select label || ' = ' || coalesce(actual, 'NULO') ||
         case when actual is not distinct from expected then ''
              else ' FALLO (esperado ' || coalesce(expected, 'NULO') || ')' end
$$;

-- Mismo montaje que 08_job_execution.sql: trabajo publicado, oferta aceptada y,
-- si se pide, pago confirmado con el proveedor simulado.
create function pg_temp.montar_trabajo(
  p_tag text,
  p_pagado boolean default true,
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
    'Prueba de ventana ' || p_tag,
    'Montaje de la prueba de la ventana de disputa y del pago al trabajador.',
    '13', '13-santiago', 'Lugar de prueba', now() + interval '2 hours', 120, 'HOLD_PLACE', 9000,
    3000, 'Si el objetivo se cumple.', now()
  );

  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. de prueba 1234', -33.4265, -70.6153);

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

-- Del pago confirmado hasta que el trabajador pide el cierre.
create function pg_temp.hasta_cierre_pedido(p_a uuid, p_w uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_w::text, true);
  perform public.mark_on_the_way(p_a);
  perform public.register_check_in(p_a, true, -33.4265, -70.6153, 20, 'device');
  perform public.start_job_work(p_a);
  perform public.request_job_completion(p_a, 'Listo.');
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

create function pg_temp.como(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true)
$$;

create function pg_temp.admin_id()
returns uuid language sql stable as $$
  select id from public.profiles where role = 'ADMIN' order by id limit 1
$$;

-- Cada acción con su identidad dentro de la misma transacción: `set_config(...,
-- true)` es local a la transacción, y en psql cada sentencia es una.
create function pg_temp.aprobar(p_assignment uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select client_id from public.assignments where id = p_assignment));
  perform public.approve_job_completion(p_assignment, true);
  perform pg_temp.como(null);
end $$;

create function pg_temp.aprobar_payout(p_assignment uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como(pg_temp.admin_id());
  perform public.approve_payout(
    (select id from public.payouts where assignment_id = p_assignment), 'Aprobado por administración');
  perform pg_temp.como(null);
end $$;

create function pg_temp.resolver_a_favor_del_trabajador(p_assignment uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como(pg_temp.admin_id());
  perform public.resolve_dispute(
    (select id from public.disputes where assignment_id = p_assignment and status in ('OPEN', 'UNDER_REVIEW')),
    'WORKER_WINS', 'El trabajador acreditó el check-in y la evidencia.', null);
  perform pg_temp.como(null);
end $$;

-- Intenta registrar la transferencia y devuelve el resultado o el motivo.
create function pg_temp.transferir(p_assignment uuid)
returns text language plpgsql as $$
declare
  v_payout uuid;
  r jsonb;
begin
  select id into v_payout from public.payouts where assignment_id = p_assignment;
  perform pg_temp.como(pg_temp.admin_id());
  r := public.mark_payout_paid(v_payout, 'TRF-PRUEBA-' || left(p_assignment::text, 8), null, null);
  perform pg_temp.como(null);
  return r ->> 'payout_status';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.reclamar(p_assignment uuid)
returns text language plpgsql as $$
declare
  v_client uuid;
begin
  select client_id into v_client from public.assignments where id = p_assignment;
  perform pg_temp.como(v_client);
  perform public.open_dispute(p_assignment, 'Trabajo no realizado',
    'El trabajador nunca llegó al lugar y la fila no se hizo.');
  perform pg_temp.como(null);
  return 'ABIERTA';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADA: ' || sqlerrm;
end $$;

create temp table v_ctx (k text primary key, v uuid);

\echo ''
\echo '--- La transferencia espera a que cierre la ventana'

select * from pg_temp.montar_trabajo('v1') \gset v1_
select pg_temp.hasta_cierre_pedido(:'v1_assignment_id', :'v1_worker_id') is null as _ \gset

-- Administración aprueba el payout por su cuenta, sin que el cliente apruebe.
select pg_temp.aprobar_payout(:'v1_assignment_id') is null as _ \gset

select pg_temp.expect('V01 transferir antes de que el cliente apruebe',
  left(pg_temp.transferir(:'v1_assignment_id'), 9), 'RECHAZADO');

select pg_temp.aprobar(:'v1_assignment_id') is null as _ \gset

select pg_temp.expect('V02 transferir con la ventana abierta',
  case when pg_temp.transferir(:'v1_assignment_id') like 'RECHAZADO: El plazo para reportar problemas vence el%'
       then 'rechazado con la fecha' else 'otro' end,
  'rechazado con la fecha');

select pg_temp.expect('V03 el cliente reclama dentro de su plazo', pg_temp.reclamar(:'v1_assignment_id'), 'ABIERTA');

select pg_temp.expect('V04 el payout queda retenido de verdad',
  (select status::text from payouts where assignment_id = :'v1_assignment_id'), 'HELD');

select pg_temp.expect('V05 transferir con la disputa abierta',
  left(pg_temp.transferir(:'v1_assignment_id'), 9), 'RECHAZADO');

-- La administración resuelve a favor del trabajador.
select pg_temp.resolver_a_favor_del_trabajador(:'v1_assignment_id') is null as _ \gset

select pg_temp.expect('V06 resuelta la disputa, se puede transferir aunque la ventana siga abierta',
  pg_temp.transferir(:'v1_assignment_id'), 'PAID');

select pg_temp.expect('V07 una segunda disputa sobre un trabajo ya resuelto',
  case when pg_temp.reclamar(:'v1_assignment_id') like 'RECHAZADA: Este trabajo ya tuvo una disputa resuelta%'
       then 'rechazada' else 'otra' end,
  'rechazada');

select pg_temp.expect('V08 transferir dos veces no duplica',
  pg_temp.transferir(:'v1_assignment_id'), 'PAID');

\echo ''
\echo '--- Ventana cerrada sin reclamo'

select * from pg_temp.montar_trabajo('v2') \gset v2_
select pg_temp.hasta_cierre_pedido(:'v2_assignment_id', :'v2_worker_id') is null as _ \gset
select pg_temp.aprobar(:'v2_assignment_id') is null as _ \gset

-- La ventana vence: se adelanta el reloj de esta asignación.
update assignments set dispute_deadline_at = now() - interval '1 minute' where id = :'v2_assignment_id';

select pg_temp.expect('V09 con la ventana cerrada se transfiere', pg_temp.transferir(:'v2_assignment_id'), 'PAID');
select pg_temp.expect('V10 y ya no se puede reclamar',
  left(pg_temp.reclamar(:'v2_assignment_id'), 9), 'RECHAZADA');

\echo ''
\echo '--- Aprobación automática'

select * from pg_temp.montar_trabajo('v3') \gset v3_
select pg_temp.hasta_cierre_pedido(:'v3_assignment_id', :'v3_worker_id') is null as _ \gset
select * from pg_temp.montar_trabajo('v4') \gset v4_
select pg_temp.hasta_cierre_pedido(:'v4_assignment_id', :'v4_worker_id') is null as _ \gset
select * from pg_temp.montar_trabajo('v5') \gset v5_
select pg_temp.hasta_cierre_pedido(:'v5_assignment_id', :'v5_worker_id') is null as _ \gset

-- v3 y v4 pidieron el cierre hace 13 horas; v5, recién.
update assignments set handoff_completed_at = now() - interval '13 hours'
 where id in (:'v3_assignment_id', :'v4_assignment_id');
-- v4 tiene una disputa abierta: no se aprueba sola.
select pg_temp.reclamar(:'v4_assignment_id') is not null as _ \gset

select app_private.auto_approve_completions() as v11_n \gset
select pg_temp.expect('V11 la pasada aprobó al menos el vencido sin disputa',
  (:'v11_n'::int >= 1)::text, 'true');
select pg_temp.expect('V12 v3 completado', (select status::text from assignments where id = :'v3_assignment_id'), 'COMPLETED');
select pg_temp.expect('V13 v3 payout aprobado', (select status::text from payouts where assignment_id = :'v3_assignment_id'), 'APPROVED');
select pg_temp.expect('V14 v3 bono otorgado, igual que la aprobación manual por omisión',
  (select bonus_awarded::text from assignments where id = :'v3_assignment_id'), 'true');
select pg_temp.expect('V15 v3 ventana de disputa abierta desde la aprobación',
  (select (dispute_deadline_at > now() + interval '11 hours')::text from assignments where id = :'v3_assignment_id'), 'true');
select pg_temp.expect('V16 v3 queda en la línea de tiempo como automática',
  (select count(*)::text from job_evidence where assignment_id = :'v3_assignment_id' and event_key = 'completion_auto_approved'), '1');
select pg_temp.expect('V17 el cliente recibe el aviso',
  (select count(*)::text from notifications where user_id = :'v3_client_id' and notification_type = 'JOB_APPROVED'
     and job_id = :'v3_job_id'), '1');
select pg_temp.expect('V18 v4, con disputa abierta, no se aprueba',
  (select status::text from assignments where id = :'v4_assignment_id'), 'HANDOFF_COMPLETED');
select pg_temp.expect('V19 v5, recién pedido, no se aprueba',
  (select status::text from assignments where id = :'v5_assignment_id'), 'HANDOFF_COMPLETED');
select pg_temp.expect('V20 una segunda pasada no aprueba nada más',
  (select app_private.auto_approve_completions()::text), '0');
select pg_temp.expect('V21 el cliente conserva su derecho a reclamar tras la aprobación automática',
  pg_temp.reclamar(:'v3_assignment_id'), 'ABIERTA');

\echo ''
\echo '--- Caducidad de trabajos publicados sin trabajador'

insert into jobs (
  id, client_id, category_id, status, title, description, region_code, commune_code,
  place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate, published_at
)
select x.id, (select id from profiles where role <> 'ADMIN' order by id limit 1),
       (select id from job_categories order by sort_order limit 1), 'PUBLISHED',
       'Trabajo de prueba de caducidad ' || x.n,
       'Trabajo publicado para probar la caducidad automática sin asignación.',
       '13', '13-santiago', 'Lugar de prueba', x.starts_at, 60, 'HOLD_PLACE', 9000, now() - interval '1 day'
  from (values ('a7000000-0000-4000-8000-000000000001'::uuid, 1, now() - interval '3 hours'),
               ('a7000000-0000-4000-8000-000000000002'::uuid, 2, now() - interval '1 hour')) as x(id, n, starts_at);

insert into job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
select 'a7000000-0000-4000-8000-000000000001', user_id, 9000, 9000, 'Oferta que nunca se aceptó'
  from worker_profiles where verification_status = 'VERIFIED'
   and user_id <> (select client_id from jobs where id = 'a7000000-0000-4000-8000-000000000001')
 order by user_id limit 1;

select app_private.expire_unassigned_jobs() is not null as _ \gset

select pg_temp.expect('V22 vencido 3 h después de su inicio',
  (select status::text from jobs where id = 'a7000000-0000-4000-8000-000000000001'), 'EXPIRED');
select pg_temp.expect('V23 su oferta pendiente también vence',
  (select string_agg(status::text, ',') from job_offers where job_id = 'a7000000-0000-4000-8000-000000000001'), 'EXPIRED');
select pg_temp.expect('V24 el cliente recibe el aviso de vencimiento',
  (select count(*)::text from notifications where job_id = 'a7000000-0000-4000-8000-000000000001'
     and notification_type = 'JOB_EXPIRED'), '1');
select pg_temp.expect('V25 dentro del margen de 2 h no vence',
  (select status::text from jobs where id = 'a7000000-0000-4000-8000-000000000002'), 'PUBLISHED');

\echo ''
\echo '--- Entrada única y permisos'

select pg_temp.expect('V26 run_scheduled_tasks informa las tres tareas',
  (select (r ? 'aprobados_automaticamente' and r ? 'trabajos_vencidos' and r ? 'pagos_fuera_de_ventana')::text
     from (select app_private.run_scheduled_tasks() as r) x), 'true');

set role authenticated;
do $$
begin
  perform app_private.run_scheduled_tasks();
  raise notice 'V27 FALLO: un usuario pudo ejecutar las tareas programadas';
exception when insufficient_privilege then
  raise notice 'V27 OK: las tareas programadas no las ejecuta un usuario';
end $$;
do $$
begin
  perform app_private.auto_approve_completions();
  raise notice 'V28 FALLO: un usuario pudo forzar aprobaciones automáticas';
exception when insufficient_privilege then
  raise notice 'V28 OK: nadie fuerza aprobaciones automáticas desde la aplicación';
end $$;
reset role;

\echo ''
\echo '--- Una fila mala no detiene la pasada'

-- v6: el cliente reclama en vez de aprobar y la administración resuelve. El
-- trabajo queda CLOSED y la asignación en HANDOFF_COMPLETED. Antes de la
-- corrección, la aprobación automática lo tomaba, chocaba con la guarda de
-- estados terminales y abortaba la pasada entera.
select * from pg_temp.montar_trabajo('v6') \gset v6_
select pg_temp.hasta_cierre_pedido(:'v6_assignment_id', :'v6_worker_id') is null as _ \gset
select pg_temp.reclamar(:'v6_assignment_id') is not null as _ \gset
select pg_temp.resolver_a_favor_del_trabajador(:'v6_assignment_id') is null as _ \gset

-- v7: un caso sano que debe aprobarse en la MISMA pasada.
select * from pg_temp.montar_trabajo('v7') \gset v7_
select pg_temp.hasta_cierre_pedido(:'v7_assignment_id', :'v7_worker_id') is null as _ \gset

update assignments set handoff_completed_at = now() - interval '13 hours'
 where id in (:'v6_assignment_id', :'v7_assignment_id');

select app_private.run_scheduled_tasks() as v29_r \gset

select pg_temp.expect('V29 la pasada termina sin errores',
  (:'v29_r'::jsonb -> 'errores')::text, '[]');
select pg_temp.expect('V30 el caso sano se aprueba en la misma pasada',
  (select status::text from assignments where id = :'v7_assignment_id'), 'COMPLETED');
select pg_temp.expect('V31 el resuelto no se toca: trabajo y asignación como los dejó la resolución',
  (select j.status::text || ' / ' || a.status::text from assignments a join jobs j on j.id = a.job_id
    where a.id = :'v6_assignment_id'), 'CLOSED / HANDOFF_COMPLETED');

\echo ''
\echo '--- Una disputa ganada por el cliente deja su devolución pendiente'

create function pg_temp.resolver(p_assignment uuid, p_resolution public.dispute_resolution, p_amount bigint)
returns void language plpgsql as $$
begin
  perform pg_temp.como(pg_temp.admin_id());
  perform public.resolve_dispute(
    (select id from public.disputes where assignment_id = p_assignment and status in ('OPEN', 'UNDER_REVIEW')),
    p_resolution, 'Resolución de prueba con motivo suficiente.', p_amount);
  perform pg_temp.como(null);
end $$;

-- v8: el trabajador no llegó; el cliente reclama y gana, sin indicar importe
-- (es lo que envía el panel para CLIENT_WINS).
select * from pg_temp.montar_trabajo('v8') \gset v8_
select pg_temp.reclamar(:'v8_assignment_id') is not null as _ \gset
select pg_temp.resolver(:'v8_assignment_id', 'CLIENT_WINS', null) is null as _ \gset

select pg_temp.expect('V32 a favor del cliente sin importe: se registra todo lo cobrado',
  (select (d.refund_amount = p.amount)::text from disputes d join payments p on p.assignment_id = d.assignment_id
    where d.assignment_id = :'v8_assignment_id' and p.purpose = 'JOB'), 'true');
select pg_temp.expect('V33 y el payout del trabajador queda cancelado',
  (select status::text from payouts where assignment_id = :'v8_assignment_id'), 'CANCELLED');

-- v9: a favor del cliente con un importe explícito: se respeta.
select * from pg_temp.montar_trabajo('v9') \gset v9_
select pg_temp.reclamar(:'v9_assignment_id') is not null as _ \gset
select pg_temp.resolver(:'v9_assignment_id', 'CLIENT_WINS', 7000) is null as _ \gset
select pg_temp.expect('V34 un importe explícito se respeta',
  (select refund_amount::text from disputes where assignment_id = :'v9_assignment_id'), '7000');

\echo ''
\echo '--- Un reintento no borra el rastro de un cobro posible'

-- v10: pago creado en el proveedor, sin commit todavía: reintentar se permite.
select * from pg_temp.montar_trabajo('v10', false) \gset v10_
select public.register_payment_attempt(:'v10_payment_id', 'mock', 'mock', 'HV10A' || substr(md5(random()::text), 1, 8),
  'sesion-v10', 'http://localhost:3000/pagos/retorno') is null as _ \gset
select pg_temp.expect('V35 sin commit previo, un reintento se acepta',
  (select (status = 'CREATED' and attempt >= 1)::text from payments where id = :'v10_payment_id'), 'true');

-- El commit contestó AUTHORIZED y el asiento falló después: el pago sigue CREATED.
update payments set committed_at = now(), provider_status = 'AUTHORIZED' where id = :'v10_payment_id';
do $$
declare v_payment uuid := (select id from public.payments where buy_order like 'HV10A%' limit 1);
        v_token_antes text;
begin
  update public.payments set provider_token = 'token-del-cobro-posible' where id = v_payment;
  begin
    perform public.register_payment_attempt(v_payment, 'mock', 'mock', 'HV10B' || substr(md5(random()::text), 1, 8),
      'sesion-v10', 'http://localhost:3000/pagos/retorno');
    raise notice 'V36 FALLO: se abrió un intento nuevo encima de un cobro posible';
  exception when check_violation then
    raise notice 'V36 OK: con un commit previo no se abre otro intento';
  end;
  select provider_token into v_token_antes from public.payments where id = v_payment;
  raise notice '%', 'V37 el token del cobro posible se conserva = ' || v_token_antes
    || case when v_token_antes = 'token-del-cobro-posible' then '' else ' FALLO' end;
end $$;

\echo ''
\echo '--- Nadie publica avisos del sistema desde su sesión'

select c.id as v38_conv, a.worker_id as v38_w
  from conversations c join assignments a on a.job_id = c.job_id limit 1 \gset

create function pg_temp.escribir_como(p_user uuid, p_conv uuid, p_type public.message_type, p_body text)
returns text language plpgsql as $$
begin
  perform pg_temp.como(p_user);
  set local role authenticated;
  insert into public.messages (conversation_id, sender_id, message_type, body)
  values (p_conv, p_user, p_type, p_body);
  reset role;
  perform pg_temp.como(null);
  return 'ACEPTADO';
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'RECHAZADO';
end $$;

select pg_temp.expect('V38 un participante no puede publicar un aviso del sistema',
  pg_temp.escribir_como(:'v38_w', :'v38_conv', 'SYSTEM',
    'HagoTuFila: el pago quedó retenido. Para liberarlo transfiere a la cuenta 123.'),
  'RECHAZADO');
select pg_temp.expect('V39 y sí puede escribir un mensaje de texto',
  pg_temp.escribir_como(:'v38_w', :'v38_conv', 'TEXT', 'Hola, voy llegando.'), 'ACEPTADO');

\echo ''
\echo '--- Cada bucket admite solo lo que la aplicación admite'

select pg_temp.expect('V40 buckets sin límite de tamaño o de tipo',
  (select coalesce(string_agg(id, ', ' order by id), 'ninguno') from storage.buckets
    where file_size_limit is null or allowed_mime_types is null), 'ninguno');
select pg_temp.expect('V41 fotos de perfil: 4 MB y solo imágenes',
  (select file_size_limit || ' · ' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'avatars'),
  '4194304 · image/jpeg,image/png,image/webp');
select pg_temp.expect('V42 ningún bucket admite SVG',
  (select count(*)::text from storage.buckets where 'image/svg+xml' = any(allowed_mime_types)), '0');

\echo ''
\echo '--- El token de Webpay no se lee con una sesión de usuario'

select pg_temp.expect('V43 authenticated puede leer provider_token',
  has_column_privilege('authenticated', 'public.payments', 'provider_token', 'SELECT')::text, 'false');
select pg_temp.expect('V44 ni redirect_url, session_id ni return_url',
  (has_column_privilege('authenticated', 'public.payments', 'redirect_url', 'SELECT')
   or has_column_privilege('authenticated', 'public.payments', 'session_id', 'SELECT')
   or has_column_privilege('authenticated', 'public.payments', 'return_url', 'SELECT'))::text, 'false');
select pg_temp.expect('V45 sí el estado y el importe, que usa la página del trabajo',
  (has_column_privilege('authenticated', 'public.payments', 'status', 'SELECT')
   and has_column_privilege('authenticated', 'public.payments', 'amount', 'SELECT'))::text, 'true');

create function pg_temp.leer_vista_admin()
returns text language plpgsql as $$
declare n integer;
begin
  perform pg_temp.como(pg_temp.admin_id());
  set local role authenticated;
  select count(*) into n from public.admin_payments;
  reset role;
  perform pg_temp.como(null);
  return 'LEE';
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'FALLA: ' || sqlerrm;
end $$;
select pg_temp.expect('V46 la vista de administración sigue funcionando', pg_temp.leer_vista_admin(), 'LEE');
