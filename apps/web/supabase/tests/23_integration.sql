\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Lo que quedó entre dos grupos al integrar la tercera tanda
-- =============================================================================
-- Prefijo Y. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
--   · Y01–Y05: no se transfiere al trabajador mientras un cobro del tiempo
--     adicional está autorizado sin asentar o recién creado; uno creado y
--     abandonado hace más de 30 minutos no frena (20260601002000 §1).
--   · Y06–Y08: el trabajador no lee el motivo interno de una retención en
--     `worker_earnings`; la administración sí (20260601002000 §2).
--
-- Los ayudantes son los de 20_payment_lifecycle.sql.
-- =============================================================================

update public.platform_settings set allow_non_production_payouts = false where id;

create function pg_temp.expect(label text, actual text, expected text)
returns text language sql as $$
  select label || ' = ' || coalesce(actual, 'NULO') ||
         case when actual is not distinct from expected then ''
              else ' FALLO (esperado ' || coalesce(expected, 'NULO') || ')' end
$$;

create function pg_temp.expect_like(label text, actual text, pattern text)
returns text language sql as $$
  select label || ' = ' || coalesce(actual, 'NULO') ||
         case when coalesce(actual, '') like pattern then ''
              else ' FALLO (esperado algo como ' || pattern || ')' end
$$;

create function pg_temp.como(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true)
$$;

create function pg_temp.admin_id()
returns uuid language sql stable as $$
  select id from public.profiles where role = 'ADMIN' order by id limit 1
$$;

-- Ejecuta una sentencia y devuelve su valor, o el motivo si la base la negó.
-- Así una comprobación que falla imprime FALLO en vez de cortar la batería.
create function pg_temp.valor(p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return v;
exception when others then
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Lo mismo, con la sesión de una persona.
create function pg_temp.rpc(p_user uuid, p_sql text)
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.como(p_user);
  execute p_sql into v;
  perform pg_temp.como(null);
  return v;
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Trabajos de esta batería: los invariantes del final miran solo estos.
create temp table y_asignaciones (a uuid primary key);

-- Quién trabaja y quién paga. El cliente no es administración.
create function pg_temp.partes(out worker_id uuid, out client_id uuid)
language plpgsql as $$
begin
  select w.user_id into worker_id from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select p.id into client_id from public.profiles p
   where p.id <> worker_id and p.role <> 'ADMIN'
     and exists (select 1 from auth.users u where u.id = p.id)
   order by p.id limit 1;
end $$;

-- Trabajo publicado y oferta aceptada, con el pago del trabajo iniciado.
create function pg_temp.publicar(
  p_tag text,
  out job_id uuid,
  out assignment_id uuid,
  out payment_id uuid,
  out client_id uuid,
  out worker_id uuid
)
language plpgsql as $$
declare
  v_offer uuid;
begin
  select * into worker_id, client_id from pg_temp.partes();

  job_id := gen_random_uuid();
  insert into public.jobs (
    id, client_id, category_id, status, title, description, region_code, commune_code,
    place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at
  ) values (
    job_id, client_id, (select id from public.job_categories order by sort_order limit 1), 'PUBLISHED',
    'Prueba de la integración ' || p_tag,
    'Montaje de la prueba del tiempo adicional, la revisión manual y los intentos de pago.',
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

  insert into y_asignaciones values (assignment_id);
end $$;

-- Pago del trabajo confirmado con el proveedor simulado, en producción.
create function pg_temp.montar_trabajo(
  p_tag text,
  out job_id uuid,
  out assignment_id uuid,
  out payment_id uuid,
  out client_id uuid,
  out worker_id uuid
)
language plpgsql as $$
declare
  v_tag text;
begin
  select * into job_id, assignment_id, payment_id, client_id, worker_id from pg_temp.publicar(p_tag);
  v_tag := p_tag || '-' || substr(md5(random()::text), 1, 8);
  update public.payments
     set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-' || v_tag,
         provider_token = 'tok-' || v_tag, environment = 'production'
   where id = payment_id;
  perform public.confirm_payment_result(payment_id, 'mock', 'evt-' || v_tag, 'PAID', null, '{}');
end $$;

-- El trabajador va, llega y comienza.
create function pg_temp.en_curso(p_a uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  perform public.mark_on_the_way(p_a);
  perform public.register_check_in(p_a, true, -33.4265, -70.6153, 20, 'device');
  perform public.start_job_work(p_a);
  perform pg_temp.como(null);
end $$;

-- 60 minutos más, pedidos por el trabajador y aceptados por el cliente. El
-- cobro queda creado (PENDING) y sin pagar.
create function pg_temp.pedir_extension(p_a uuid, out ext_id uuid, out ext_payment uuid)
language plpgsql as $$
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  ext_id := public.request_job_extension(p_a, 60, null);
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  perform public.answer_job_extension(ext_id, true);
  perform pg_temp.como(null);
  select payment_id into ext_payment from public.job_extensions where id = ext_id;
end $$;

-- El cobro pasa por Webpay y vuelve autorizado. Devuelve cómo quedó el pago.
create function pg_temp.cobrar(p_payment uuid, p_tag text, p_amount bigint)
returns text language plpgsql as $$
declare
  v_tag text := p_tag || '-' || substr(md5(random()::text), 1, 8);
begin
  update public.payments
     set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-' || v_tag,
         provider_token = 'tok-' || v_tag, environment = 'production'
   where id = p_payment;
  perform public.confirm_payment_result(p_payment, 'mock', 'evt-' || v_tag, 'PAID', p_amount, '{}');
  return (select status || coalesce(' ' || review_reason, '') from public.payments where id = p_payment);
exception when others then
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Entrega pedida, aprobada por el cliente y con la ventana de reclamo vencida.
create function pg_temp.aprobar(p_a uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  perform public.request_job_completion(p_a, 'Listo.');
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  perform public.approve_job_completion(p_a, true);
  perform pg_temp.como(null);
  update public.assignments set dispute_deadline_at = now() - interval '1 minute' where id = p_a;
end $$;

create function pg_temp.transferir(p_a uuid)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(pg_temp.admin_id());
  r := public.mark_payout_paid(
    (select id from public.payouts where assignment_id = p_a),
    'TRF-Y-' || left(p_a::text, 8), null, null);
  perform pg_temp.como(null);
  return r ->> 'payout_status';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Pide una devolución como administración. Devuelve su id o el motivo.

create function pg_temp.payout_status(p_a uuid)
returns text language sql volatile as $$
  select status::text from public.payouts where assignment_id = p_a
$$;

-- ---------------------------------------------------------------------------
-- 1. Un cobro del tiempo adicional en vuelo frena la transferencia
-- ---------------------------------------------------------------------------

select * from pg_temp.montar_trabajo('y-vuelo') \gset y1_
select pg_temp.en_curso(:'y1_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'y1_assignment_id') \gset y1_
select pg_temp.aprobar(:'y1_assignment_id') is null as _ \gset

-- El cliente abrió Webpay para pagar la hora extra: el cobro está creado.
update public.payments set status = 'CREATED', provider = 'mock',
       provider_token = 'tok-y1-' || left(:'y1_ext_payment', 8), environment = 'production'
 where id = :'y1_ext_payment';

select pg_temp.expect_like('Y01 con el cobro del tiempo adicional recién creado, no se transfiere',
  pg_temp.transferir(:'y1_assignment_id'), 'RECHAZADO: El cliente está pagando el tiempo adicional%');
select pg_temp.expect('Y02 el payout sigue sin transferir', pg_temp.payout_status(:'y1_assignment_id'), 'APPROVED');

-- Creado y abandonado hace más de 30 minutos (sin intento registrado, cuenta
-- desde la creación del pago): ya no frena.
update public.payments set created_at = now() - interval '2 hours' where id = :'y1_ext_payment';
delete from public.payment_attempts where payment_id = :'y1_ext_payment';
select pg_temp.expect('Y04 un cobro abandonado hace más de 30 minutos no frena la transferencia',
  pg_temp.transferir(:'y1_assignment_id'), 'PAID');

-- Autorizado y sin asentar, aunque sea viejo: frena.
select * from pg_temp.montar_trabajo('y-autorizado') \gset y3_
select pg_temp.en_curso(:'y3_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'y3_assignment_id') \gset y3_
select pg_temp.aprobar(:'y3_assignment_id') is null as _ \gset
update public.payments set status = 'AUTHORIZED', provider = 'mock', environment = 'production',
       created_at = now() - interval '2 hours'
 where id = :'y3_ext_payment';
select pg_temp.expect_like('Y03 con el cobro autorizado sin asentar, tampoco',
  pg_temp.transferir(:'y3_assignment_id'), 'RECHAZADO: El cliente está pagando el tiempo adicional%');

-- Un intento recién registrado sobre un pago viejo vuelve a frenar: la ventana
-- corre desde el intento vigente, no desde la creación del pago.
select * from pg_temp.montar_trabajo('y-intento') \gset y2_
select pg_temp.en_curso(:'y2_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'y2_assignment_id') \gset y2_
select pg_temp.aprobar(:'y2_assignment_id') is null as _ \gset
update public.payments set status = 'CREATED', provider = 'mock', environment = 'production',
       buy_order = 'O-Y2-' || left(:'y2_ext_payment', 8), created_at = now() - interval '2 hours'
 where id = :'y2_ext_payment';
insert into public.payment_attempts (payment_id, attempt, provider, environment, buy_order, session_id, status, created_at)
select id, 1, 'mock', 'production', buy_order, 'S-Y2-' || left(id::text, 8), 'CREATED', now() - interval '3 minutes'
  from public.payments where id = :'y2_ext_payment';
select pg_temp.expect_like('Y05 con un intento recién registrado sobre un pago viejo, sí frena',
  pg_temp.transferir(:'y2_assignment_id'), 'RECHAZADO: El cliente está pagando el tiempo adicional%');

-- ---------------------------------------------------------------------------
-- 2. El motivo interno de una retención, solo para la administración
-- ---------------------------------------------------------------------------

update public.payouts set status = 'HELD',
       held_reason = 'Se devolvieron $3.000 al cliente y las cifras no cuadran: el cliente pagó $21.000'
 where assignment_id = :'y2_assignment_id';

select pg_temp.expect('Y06 el trabajador lee la frase genérica, no las cifras del cliente',
  pg_temp.rpc(:'y2_worker_id',
    format('select held_reason from public.worker_earnings where assignment_id = %L', :'y2_assignment_id')),
  'Retenido mientras soporte revisa el caso');
select pg_temp.expect_like('Y07 la administración lee el motivo entero',
  pg_temp.rpc(pg_temp.admin_id(),
    format('select held_reason from public.worker_earnings where assignment_id = %L', :'y2_assignment_id')),
  'Se devolvieron $3.000 al cliente%');
select pg_temp.expect('Y08 sin retención, el trabajador no recibe ningún motivo',
  pg_temp.rpc(:'y1_worker_id',
    format('select coalesce(held_reason, ''(sin motivo)'') from public.worker_earnings where assignment_id = %L', :'y1_assignment_id')),
  '(sin motivo)');

-- Deja la base como la encontró para las baterías que siguen.
update public.payouts set status = 'APPROVED', held_reason = null where assignment_id = :'y2_assignment_id';
update public.payments set status = 'FAILED', failure_reason = 'prueba Y' where id = :'y2_ext_payment';
update public.payments set status = 'UNDER_REVIEW', review_reason = 'prueba Y', captured_at = now() where id = :'y3_ext_payment';
