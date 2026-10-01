\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- El ciclo de vida del pago: tiempo adicional tardío, devolución parcial a
-- mitad del trabajo, revisión manual, abandono con otro intento en curso,
-- tope de intentos y lo que no debe llegar a quien no corresponde
-- =============================================================================
-- Prefijo C. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Los defectos que cierra esta batería, reproducidos antes de corregirlos:
--
--   · el tiempo adicional pagado después de transferir (o cancelar) el payout
--     lo subía igual: un payout PAID de $18.480 pasaba a $26.220 con la misma
--     referencia bancaria (20260601001700);
--   · una devolución parcial antes de aprobar dejaba el trabajo sin poder
--     avanzar, entregarse ni aprobarse (20260601001710);
--   · «Poner en revisión» era un UPDATE directo, en el orden de cerrojos
--     inverso, sobre cualquier pago y sin vuelta atrás; y un pago en revisión
--     sin dinero detrás inflaba lo que se podía devolver (20260601001720);
--   · anular la pestaña vigente de Webpay tumbaba el pago mientras otra
--     pestaña se confirmaba; los intentos no tenían tope; el trabajador recibía
--     el identificador del pago del cliente (20260601001730);
--   · el cliente leía en la historia de su pago qué administrador resolvió su
--     devolución y su nota interna (20260601001740).
--
-- El orden de cerrojos de `flag_payment_for_review` lo prueba
-- `20_race_review_flag.sh` con dos sesiones de verdad.
--
-- Cobro de $21.000 (servicio $18.000 + bono $3.000), comisión del 14 % sobre el
-- servicio ($2.520): al trabajador le corresponden $18.480. Una hora más de
-- tiempo adicional son $9.000, de los que al trabajador le llegan $7.740.
-- =============================================================================

update public.platform_settings set allow_non_production_payouts = false where id;

-- Las claves de idempotencia llevan la marca de esta pasada: repetir la
-- batería sobre la misma base no choca con las claves de la anterior.
select substr(md5(random()::text), 1, 8) as run \gset

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
create temp table c_asignaciones (a uuid primary key);

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
    'Prueba del ciclo de vida del pago ' || p_tag,
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

  insert into c_asignaciones values (assignment_id);
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
    'TRF-C-' || left(p_a::text, 8), null, null);
  perform pg_temp.como(null);
  return r ->> 'payout_status';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Pide una devolución como administración. Devuelve su id o el motivo.
create function pg_temp.pedir(p_payment uuid, p_monto bigint, p_disputa uuid default null)
returns text language plpgsql as $$
declare
  v uuid;
begin
  perform pg_temp.como(pg_temp.admin_id());
  v := public.request_payment_refund(p_payment, p_monto, 'Devolución de la batería C.',
    'refund-c-' || substr(md5(random()::text), 1, 12), p_disputa);
  perform pg_temp.como(null);
  return v::text;
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.confirmar_devolucion(p_refund text)
returns text language plpgsql as $$
begin
  return public.settle_payment_refund(p_refund::uuid, true, 'NULLIFIED', null, '{"response_code":0}')
           ->> 'refund_status';
exception when others then
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Lecturas. VOLATILE a propósito: una función STABLE ve la foto del principio
-- de la sentencia, no lo que una llamada anterior de la misma sentencia
-- acaba de escribir.
--
-- Estado e importes del payout de una asignación: estado bruto/neto.
create function pg_temp.payout(p_a uuid)
returns text language sql volatile as $$
  select status::text || ' ' || gross_amount || '/' || net_amount
    from public.payouts where assignment_id = p_a
$$;

create function pg_temp.pago(p_payment uuid)
returns text language sql volatile as $$
  select status::text || coalesce(' ' || review_reason, '') from public.payments where id = p_payment
$$;

create function pg_temp.asignacion(p_a uuid)
returns text language sql volatile as $$
  select status::text from public.assignments where id = p_a
$$;

create function pg_temp.reclamar(p_a uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  perform public.open_dispute(p_a, 'Trabajo no realizado',
    'El trabajador llegó tarde y la fila se hizo a medias.');
  perform pg_temp.como(null);
end $$;

create function pg_temp.resolver(p_a uuid, p_resolution public.dispute_resolution, p_amount bigint)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(pg_temp.admin_id());
  r := public.resolve_dispute(
    (select id from public.disputes where assignment_id = p_a and status in ('OPEN', 'UNDER_REVIEW')),
    p_resolution, 'Resolución de prueba con motivo suficiente.', p_amount);
  perform pg_temp.como(null);
  return r ->> 'payout_status';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Poner y quitar una revisión manual, como administración (o como quien se pida).
create function pg_temp.revisar(p_payment uuid, p_motivo text, p_user uuid default null)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(coalesce(p_user, pg_temp.admin_id()));
  r := public.flag_payment_for_review(p_payment, p_motivo);
  perform pg_temp.como(null);
  return (r ->> 'outcome') || coalesce(' · payout ' || (r ->> 'payout_status'), '');
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.liberar(p_payment uuid, p_nota text, p_user uuid default null)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(coalesce(p_user, pg_temp.admin_id()));
  r := public.release_payment_review(p_payment, p_nota);
  perform pg_temp.como(null);
  return (r ->> 'outcome') || coalesce(' · payout ' || (r ->> 'payout_status'), '');
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.avisos(p_user uuid, p_job uuid, p_title text)
returns text language sql volatile as $$
  select count(*)::text from public.notifications
   where user_id = p_user and job_id = p_job and title = p_title
$$;


\echo ''
\echo '--- El tiempo adicional pagado tarde no reescribe un payout transferido'

-- Cobrado, 60 minutos más aceptados y sin pagar, aprobado, ventana vencida y
-- transferido: payout PAID por $18.480.
select * from pg_temp.montar_trabajo('c-tarde') \gset a1_
select pg_temp.en_curso(:'a1_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'a1_assignment_id') \gset a1_
select pg_temp.aprobar(:'a1_assignment_id') is null as _ \gset
select pg_temp.transferir(:'a1_assignment_id') as a1_transferido \gset
select pg_temp.payout(:'a1_assignment_id') || ' ' || bank_reference as a1_payout_antes
  from payouts where assignment_id = :'a1_assignment_id' \gset

select pg_temp.expect_like('C01 transferido el payout, el cliente ya no puede abrir el cobro del tiempo adicional',
  :'a1_transferido' || ' / ' ||
  pg_temp.rpc(:'a1_client_id', format('select public.start_extension_payment(%L)::text', :'a1_ext_id')),
  'PAID / RECHAZADO: El pago de este trabajo ya se cerró: el tiempo adicional ya no se puede pagar desde aquí%');

-- El cobro ya estaba en Webpay cuando se registró la transferencia: llega
-- autorizado igual.
select pg_temp.cobrar(:'a1_ext_payment', 'c-tarde-ext', 9000) as a1_cobro \gset
select pg_temp.expect('C02 llega tarde: el dinero queda en revisión, por devolver, con su motivo',
  :'a1_cobro', 'UNDER_REVIEW payout_already_settled');
select pg_temp.expect('C03 y el payout transferido no cambia: ni importes ni referencia',
  (select pg_temp.payout(:'a1_assignment_id') || ' ' || bank_reference
     from payouts where assignment_id = :'a1_assignment_id'),
  :'a1_payout_antes');
select pg_temp.expect('C04 al trabajador no se le dice que se sumó, y el cobro sale en la cola de revisión',
  pg_temp.avisos(:'a1_worker_id', :'a1_job_id', 'El tiempo adicional quedó pagado') || ' · ' ||
  (select count(*)::text from app_private.payment_review_queue() q where q.payment_id = :'a1_ext_payment'),
  '0 · 1');

select pg_temp.pedir(:'a1_ext_payment', 9000) as a1_r \gset
select pg_temp.confirmar_devolucion(:'a1_r') as a1_r_estado \gset
select pg_temp.expect('C05 y se puede devolver entero: lo que entró y nadie recibió',
  :'a1_r_estado' || ' · ' || pg_temp.pago(:'a1_ext_payment') || ' · ' ||
  pg_temp.payout(:'a1_assignment_id'),
  'CONFIRMED · REFUNDED payout_already_settled · PAID 18000/18480');

-- Con la disputa ganada por el cliente: payout CANCELLED, trabajo cerrado.
select * from pg_temp.montar_trabajo('c-cliente') \gset a2_
select pg_temp.en_curso(:'a2_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'a2_assignment_id') \gset a2_
select pg_temp.reclamar(:'a2_assignment_id') is null as _ \gset
select pg_temp.resolver(:'a2_assignment_id', 'CLIENT_WINS', null) as a2_resuelta \gset

select pg_temp.expect_like('C06 con el payout cancelado por una disputa, tampoco se abre el cobro',
  :'a2_resuelta' || ' / ' ||
  pg_temp.rpc(:'a2_client_id', format('select public.start_extension_payment(%L)::text', :'a2_ext_id')),
  'CANCELLED / RECHAZADO: El pago de este trabajo ya se cerró%');
select pg_temp.cobrar(:'a2_ext_payment', 'c-cliente-ext', 9000) as a2_cobro \gset
select pg_temp.expect('C07 y si llega igual, a revisión; el payout cancelado sigue en cero',
  :'a2_cobro' || ' · ' || pg_temp.payout(:'a2_assignment_id'),
  'UNDER_REVIEW payout_already_settled · CANCELLED 18000/0');

-- Lo de siempre sigue igual: pagado con el trabajo en curso, o aprobado y
-- todavía sin transferir, suma al payout y se le avisa al trabajador una vez.
select * from pg_temp.montar_trabajo('c-a-tiempo') \gset a3_
select pg_temp.en_curso(:'a3_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'a3_assignment_id') \gset a3_
select pg_temp.rpc(:'a3_client_id', format('select public.start_extension_payment(%L)::text', :'a3_ext_id'))
  as a3_inicio \gset

select pg_temp.cobrar(:'a3_ext_payment', 'c-a-tiempo-ext', 9000) as a3_cobro \gset
select pg_temp.expect('C08 con el trabajo en curso: el cobro se abre, suma $7.740 al payout y avisa una vez',
  (:'a3_inicio' = :'a3_ext_payment')::text || ' · ' ||
  :'a3_cobro' || ' · ' ||
  pg_temp.payout(:'a3_assignment_id') || ' · ' ||
  pg_temp.avisos(:'a3_worker_id', :'a3_job_id', 'El tiempo adicional quedó pagado'),
  'true · PAID · PENDING 27000/26220 · 1');

select * from pg_temp.montar_trabajo('c-aprobado') \gset a4_
select pg_temp.en_curso(:'a4_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'a4_assignment_id') \gset a4_
select pg_temp.aprobar(:'a4_assignment_id') is null as _ \gset

select pg_temp.cobrar(:'a4_ext_payment', 'c-aprobado-ext', 9000) as a4_cobro \gset
select pg_temp.payout(:'a4_assignment_id') as a4_payout \gset
select pg_temp.expect('C09 aprobado y sin transferir, también: el payout APROBADO sube y se transfiere entero',
  :'a4_cobro' || ' · ' || :'a4_payout' || ' · ' || pg_temp.transferir(:'a4_assignment_id'),
  'PAID · APPROVED 27000/26220 · PAID');

-- La red de abajo: los importes de un payout transferido o cancelado no
-- cambian, ni con la clave de servicio. Lo demás (una nota) sí.
select pg_temp.expect_like('C10 los importes de un payout PAID o CANCELLED no cambian; una nota sí',
  pg_temp.valor(format('update public.payouts set net_amount = net_amount + 1 where assignment_id = %L returning net_amount::text',
                       :'a1_assignment_id')) || ' / ' ||
  pg_temp.valor(format('update public.payouts set gross_amount = gross_amount + 9000 where assignment_id = %L returning gross_amount::text',
                       :'a2_assignment_id')) || ' / ' ||
  pg_temp.valor(format('update public.payouts set notes = %L where assignment_id = %L returning status::text',
                       'Nota de la batería C.', :'a1_assignment_id')),
  'RECHAZADO: El pago al trabajador ya está transferido y sus importes no cambian% / RECHAZADO: El pago al trabajador ya está cancelado y sus importes no cambian% / PAID');

-- Y la segunda línea, sin la guarda: si un PAID tardío llegara por otro
-- camino, `on_extension_paid` no suma a un payout transferido ni avisa.
select * from pg_temp.montar_trabajo('c-sin-guarda') \gset a5_
select pg_temp.en_curso(:'a5_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'a5_assignment_id') \gset a5_
select pg_temp.aprobar(:'a5_assignment_id') is null as _ \gset
select pg_temp.transferir(:'a5_assignment_id') as a5_transferido \gset

begin;
alter table public.payments disable trigger payments_a_guard_settlement;
select pg_temp.valor(format(
  'update public.payments set status = %L, paid_at = now(), captured_at = now() where id = %L returning status::text',
  'PAID', :'a5_ext_payment')) as a5_forzado \gset
select pg_temp.expect('C11 sin la guarda, el cobro no se suma a un payout transferido ni se avisa; queda en la auditoría',
  :'a5_transferido' || ' · ' || :'a5_forzado' || ' · ' || pg_temp.payout(:'a5_assignment_id') || ' · ' ||
  pg_temp.avisos(:'a5_worker_id', :'a5_job_id', 'El tiempo adicional quedó pagado') || ' · ' ||
  (select count(*)::text from audit_logs
    where action = 'extension_paid_without_open_payout' and entity_id = :'a5_ext_payment'),
  'PAID · PAID · PAID 18000/18480 · 0 · 1');
rollback;


\echo ''
\echo '--- Una devolución parcial a mitad del trabajo no lo deja sin terminar'

-- $2.000 devueltos con el trabajo recién pagado: menos que la parte de la
-- plataforma ($2.520), así que el payout no se retiene.
select * from pg_temp.montar_trabajo('c-parcial') \gset b1_
select pg_temp.pedir(:'b1_payment_id', 2000) as b1_r \gset
select pg_temp.confirmar_devolucion(:'b1_r') as b1_r_estado \gset
select pg_temp.expect('C12 devolución parcial confirmada con el trabajo por empezar; el payout sigue pendiente',
  :'b1_r_estado' || ' · ' || pg_temp.pago(:'b1_payment_id') || ' · ' ||
  pg_temp.payout(:'b1_assignment_id'),
  'CONFIRMED · PARTIALLY_REFUNDED · PENDING 18000/18480');

select pg_temp.rpc(:'b1_worker_id', format('select public.mark_on_the_way(%L)::text', :'b1_assignment_id'))
  as b1_camino \gset
select pg_temp.rpc(:'b1_worker_id', format(
  'select public.register_check_in(%L, true, -33.4265, -70.6153, 20, %L)::text', :'b1_assignment_id', 'device'))
  as b1_llegada \gset
select pg_temp.rpc(:'b1_worker_id', format('select public.start_job_work(%L)::text', :'b1_assignment_id'))
  as b1_comienzo \gset
select pg_temp.expect('C13 el trabajador se pone en camino, llega y comienza',
  coalesce(:'b1_camino' like 'RECHAZADO%', false)::text || ' · ' ||
  coalesce(:'b1_llegada' like 'RECHAZADO%', false)::text || ' · ' ||
  coalesce(:'b1_comienzo' like 'RECHAZADO%', false)::text || ' · ' ||
  pg_temp.asignacion(:'b1_assignment_id'),
  'false · false · false · IN_PROGRESS');

select pg_temp.rpc(:'b1_client_id', format('select public.generate_handoff_code(%L)::text', :'b1_assignment_id'))
  as b1_codigo \gset
select pg_temp.rpc(:'b1_worker_id', format('select public.verify_handoff_code(%L, %L)::text',
                                           :'b1_assignment_id', :'b1_codigo')) as b1_entrega \gset
select pg_temp.expect('C14 el código de entrega correcto valida la entrega',
  :'b1_entrega' || ' · ' || pg_temp.asignacion(:'b1_assignment_id'),
  'true · HANDOFF_COMPLETED');

select pg_temp.rpc(:'b1_client_id', format('select public.approve_job_completion(%L, true)::text', :'b1_assignment_id'))
  as b1_aprobado \gset
update assignments set dispute_deadline_at = now() - interval '1 minute' where id = :'b1_assignment_id';
select pg_temp.asignacion(:'b1_assignment_id') || ' · ' || pg_temp.payout(:'b1_assignment_id') as b1_aprobado_estado \gset
select pg_temp.expect('C15 el cliente aprueba, el payout queda aprobado y, vencida la ventana, se transfiere',
  coalesce(:'b1_aprobado' like 'RECHAZADO%', false)::text || ' · ' || :'b1_aprobado_estado' || ' · ' ||
  pg_temp.transferir(:'b1_assignment_id'),
  'false · COMPLETED · APPROVED 18000/18480 · PAID');

-- La aprobación automática tampoco lo salta: entrega pedida, devolución
-- parcial y el plazo de respuesta del cliente vencido.
select * from pg_temp.montar_trabajo('c-parcial-auto') \gset b2_
select pg_temp.en_curso(:'b2_assignment_id') is null as _ \gset
select pg_temp.rpc(:'b2_worker_id', format('select public.request_job_completion(%L, %L)::text',
                                           :'b2_assignment_id', 'Listo.')) is not null as _ \gset
select pg_temp.confirmar_devolucion(pg_temp.pedir(:'b2_payment_id', 1000)) as b2_devuelta \gset
update assignments set handoff_completed_at = now() - interval '30 days' where id = :'b2_assignment_id';
select app_private.auto_approve_completions(500) is not null as _ \gset
select pg_temp.expect('C16 con una devolución parcial, la aprobación automática aprueba igual',
  :'b2_devuelta' || ' · ' || pg_temp.pago(:'b2_payment_id') || ' · ' || pg_temp.asignacion(:'b2_assignment_id'),
  'CONFIRMED · PARTIALLY_REFUNDED · COMPLETED');

-- Lo que sigue sin dejar avanzar: devuelto entero, o en revisión.
select * from pg_temp.montar_trabajo('c-devuelto') \gset b3_
select pg_temp.confirmar_devolucion(pg_temp.pedir(:'b3_payment_id', 21000)) as b3_devuelta \gset
select pg_temp.rpc(:'b3_worker_id', format('select public.mark_on_the_way(%L)::text', :'b3_assignment_id'))
  as b3_camino \gset
select pg_temp.expect('C17 devuelto entero, el trabajador no se pone en camino',
  :'b3_devuelta' || ' · ' || pg_temp.pago(:'b3_payment_id') || ' · ' || :'b3_camino',
  'CONFIRMED · REFUNDED · RECHAZADO: El trabajo no puede avanzar sin un pago confirmado');

select * from pg_temp.montar_trabajo('c-en-duda') \gset b4_
select pg_temp.en_curso(:'b4_assignment_id') is null as _ \gset
select pg_temp.rpc(:'b4_client_id', format('select public.generate_handoff_code(%L)::text', :'b4_assignment_id'))
  as b4_codigo \gset
select pg_temp.revisar(:'b4_payment_id', 'Revisión de la batería C a mitad del trabajo.') as b4_revision \gset
select pg_temp.rpc(:'b4_worker_id', format('select public.verify_handoff_code(%L, %L)::text',
                                           :'b4_assignment_id', :'b4_codigo')) as b4_entrega \gset
select pg_temp.expect('C18 en revisión, el código correcto no valida la entrega ni gasta un intento',
  :'b4_revision' || ' · ' || :'b4_entrega' || ' · ' ||
  (select attempts::text from handoff_codes where assignment_id = :'b4_assignment_id'),
  'applied · payout HELD · RECHAZADO: El pago de este trabajo no está confirmado: la entrega queda en pausa hasta que se resuelva · 0');


\echo ''
\echo '--- Poner un pago en revisión y quitarla, por la base y en el orden de todos'

select * from pg_temp.montar_trabajo('c-revision') \gset c1_

select pg_temp.expect('C21 solo administración pone un pago en revisión',
  pg_temp.revisar(:'c1_payment_id', 'Intento del cliente, que no administra.', :'c1_client_id') || ' / ' ||
  pg_temp.revisar(:'c1_payment_id', 'Intento del trabajador, que no administra.', :'c1_worker_id'),
  'RECHAZADO: Solo la administración pone un pago en revisión / RECHAZADO: Solo la administración pone un pago en revisión');
select pg_temp.expect('C22 con motivo: diez caracteres como mínimo',
  pg_temp.revisar(:'c1_payment_id', 'corto'),
  'RECHAZADO: Escribe el motivo de la revisión (al menos 10 caracteres)');

select pg_temp.revisar(:'c1_payment_id', 'Sospecha de contracargo: lo revisa soporte.') as c1_revision \gset
select pg_temp.expect('C23 sobre un pago cobrado: queda en revisión manual, con lo cobrado registrado, y el payout retenido',
  :'c1_revision' || ' · ' || pg_temp.pago(:'c1_payment_id') || ' · ' ||
  (select (captured_at is not null)::text from payments where id = :'c1_payment_id') || ' · ' ||
  (select status || ' ' || held_reason from payouts where assignment_id = :'c1_assignment_id'),
  'applied · payout HELD · UNDER_REVIEW manual_review · true · HELD El pago del cliente está en revisión por administración');
select pg_temp.expect('C24 el motivo va a la auditoría, a nombre de quien administra; ni al pago ni a su historia, que lee el cliente',
  (select (actor_id = pg_temp.admin_id())::text || ' ' || (after ->> 'reason')
     from audit_logs where action = 'payment_review_flagged' and entity_id = :'c1_payment_id') || ' · ' ||
  (select count(*)::text from payment_events
    where payment_id = :'c1_payment_id'
      and (payload::text like '%contracargo%' or payload::text like '%' || pg_temp.admin_id()::text || '%')) || ' · ' ||
  (select count(*)::text from payment_events
    where payment_id = :'c1_payment_id' and payload ->> 'operation' = 'manual_review'),
  'true Sospecha de contracargo: lo revisa soporte. · 0 · 1');
select pg_temp.rpc(:'c1_worker_id', format('select public.mark_on_the_way(%L)::text', :'c1_assignment_id'))
  as c1_camino \gset
select pg_temp.revisar(:'c1_payment_id', 'Doble clic de la batería C sobre el mismo pago.') as c1_otra \gset
select pg_temp.expect('C25 el trabajo queda en pausa, y repetir no hace nada pero lo dice',
  :'c1_camino' || ' / ' || :'c1_otra',
  'RECHAZADO: El trabajo no puede avanzar sin un pago confirmado / unchanged');

select pg_temp.expect('C26 quitarla: solo administración, y con nota',
  pg_temp.liberar(:'c1_payment_id', 'El cliente no es quien quita la revisión.', :'c1_client_id') || ' / ' ||
  pg_temp.liberar(:'c1_payment_id', 'corta'),
  'RECHAZADO: Solo la administración quita un pago de revisión / RECHAZADO: Escribe por qué se quita la revisión (al menos 10 caracteres)');
select pg_temp.liberar(:'c1_payment_id', 'Soporte confirmó con el banco que no hay contracargo.') as c1_liberado \gset
select pg_temp.expect('C27 al quitarla, el pago vuelve a confirmado y el payout a pendiente, sin motivo de retención',
  :'c1_liberado' || ' · ' || pg_temp.pago(:'c1_payment_id') || ' · ' ||
  (select status || ' ' || coalesce(held_reason, 'sin motivo') from payouts where assignment_id = :'c1_assignment_id'),
  'applied · payout PENDING · PAID · PENDING sin motivo');
select pg_temp.rpc(:'c1_worker_id', format('select public.mark_on_the_way(%L)::text', :'c1_assignment_id'))
  as c1_camino_2 \gset
select pg_temp.liberar(:'c1_payment_id', 'Segundo clic de la batería C al quitarla.') as c1_otra_2 \gset
select pg_temp.expect('C28 el trabajo sigue: el trabajador se pone en camino; repetir no hace nada',
  coalesce(:'c1_camino_2' like 'RECHAZADO%', false)::text || ' · ' || pg_temp.asignacion(:'c1_assignment_id') || ' / ' ||
  :'c1_otra_2',
  'false · ON_THE_WAY / unchanged');
select pg_temp.expect('C29 quitarla también queda en la auditoría, y la historia del pago no dice quién',
  (select (actor_id = pg_temp.admin_id())::text || ' ' || (after ->> 'note')
     from audit_logs where action = 'payment_review_released' and entity_id = :'c1_payment_id') || ' · ' ||
  (select count(*)::text from payment_events
    where payment_id = :'c1_payment_id' and payload ->> 'operation' = 'manual_review_released'
      and payload::text not like '%' || pg_temp.admin_id()::text || '%'),
  'true Soporte confirmó con el banco que no hay contracargo. · 1');

-- Un UPDATE directo a PAID (lo que habría hecho un guion) no la quita: la
-- guarda lo deja en revisión, ahora automática, y esa ya no se quita a mano.
select * from pg_temp.montar_trabajo('c-directo') \gset c2_
select pg_temp.revisar(:'c2_payment_id', 'Revisión que un guion intenta saltarse.') as c2_revision \gset
update payments set status = 'PAID' where id = :'c2_payment_id';
select pg_temp.pago(:'c2_payment_id') as c2_tras_update \gset
select pg_temp.expect_like('C30 un UPDATE directo a PAID no la quita, y una revisión automática no se quita a mano',
  :'c2_revision' || ' · ' || :'c2_tras_update' || ' · ' ||
  pg_temp.liberar(:'c2_payment_id', 'Intento de dar por buena una revisión automática.'),
  'applied · payout HELD · UNDER_REVIEW approved_after_under_review · RECHAZADO: Solo se quita de revisión un pago que se puso en revisión a mano. Este está en UNDER_REVIEW (motivo: approved_after_under_review)%');

-- Aprobado y con la ventana vencida: la revisión frena la transferencia, y al
-- quitarla el payout vuelve a APROBADO y se transfiere.
select * from pg_temp.montar_trabajo('c-revision-aprobado') \gset c3_
select pg_temp.en_curso(:'c3_assignment_id') is null as _ \gset
select pg_temp.aprobar(:'c3_assignment_id') is null as _ \gset
select pg_temp.revisar(:'c3_payment_id', 'Revisión con el trabajo ya aprobado.') as c3_revision \gset
select pg_temp.transferir(:'c3_assignment_id') as c3_t1 \gset
select pg_temp.liberar(:'c3_payment_id', 'Revisado: el cobro está en orden.') as c3_liberado \gset
select pg_temp.transferir(:'c3_assignment_id') as c3_t2 \gset
select pg_temp.expect_like('C31 aprobado: en revisión no se transfiere; quitada, vuelve a APROBADO y se transfiere',
  :'c3_revision' || ' / ' || :'c3_t1' || ' / ' || :'c3_liberado' || ' / ' || :'c3_t2',
  'applied · payout HELD / RECHAZADO: % / applied · payout APPROVED / PAID');

-- Sin dinero detrás no hay nada que revisar, y una cancelación en curso no se
-- cierra con «Recibimos un pago…».
select * from pg_temp.publicar('c-sin-dinero') \gset c4_
update payments set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-c4-' || :'run',
       provider_token = 'tok-c4-' || :'run', environment = 'production'
 where id = :'c4_payment_id';
select pg_temp.rpc(:'c4_client_id', format('select public.cancel_job(%L, %L)::text', :'c4_job_id', 'Ya no lo necesito.'))
  is not null as _ \gset
select pg_temp.revisar(:'c4_payment_id', 'Revisión sobre un pago que nunca cobró.') as c4_revision \gset
select pg_temp.expect('C32 un pago en curso no se pone en revisión, y la cancelación pendiente sigue esperando',
  :'c4_revision' || ' · ' ||
  pg_temp.pago(:'c4_payment_id') || ' · ' || (select status::text from jobs where id = :'c4_job_id') || ' · ' ||
  (select count(*)::text from notifications where job_id = :'c4_job_id' and body like 'Recibimos un pago%'),
  'RECHAZADO: Este pago todavía está en curso (CREATED): no hay dinero que revisar. Si el cliente dice que pagó, usa «Consultar al proveedor» · CREATED · CANCELLATION_PENDING · 0');
select pg_temp.expect('C33 un pago devuelto tampoco: se gestiona desde «Devolver»',
  pg_temp.revisar(:'b3_payment_id', 'Revisión sobre un pago ya devuelto.'),
  'RECHAZADO: Este pago ya tiene devoluciones (REFUNDED): se gestiona desde «Devolver», no con una revisión');

-- El cobro del tiempo adicional: ponerlo en revisión y quitarla no lo suma dos
-- veces al payout.
select * from pg_temp.montar_trabajo('c-revision-ext') \gset c5_
select pg_temp.en_curso(:'c5_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'c5_assignment_id') \gset c5_
select pg_temp.cobrar(:'c5_ext_payment', 'c-revision-ext', 9000) as c5_cobro \gset
select pg_temp.revisar(:'c5_ext_payment', 'Revisión del cobro del tiempo adicional.') as c5_revision \gset
select pg_temp.liberar(:'c5_ext_payment', 'Revisado: el tiempo adicional está bien cobrado.') as c5_liberado \gset
select pg_temp.expect('C34 revisar y liberar el cobro adicional deja el payout como estaba, sin un segundo aviso',
  :'c5_cobro' || ' · ' || :'c5_revision' || ' · ' || :'c5_liberado' || ' · ' ||
  pg_temp.pago(:'c5_ext_payment') || ' · ' || pg_temp.payout(:'c5_assignment_id') || ' · ' ||
  pg_temp.avisos(:'c5_worker_id', :'c5_job_id', 'El tiempo adicional quedó pagado'),
  'PAID · applied · payout PENDING · applied · payout PENDING · PAID · PENDING 27000/26220 · 1');

-- Con una devolución de ese pago sin resultado, no se quita.
select * from pg_temp.montar_trabajo('c-revision-devolucion') \gset c6_
select pg_temp.revisar(:'c6_payment_id', 'Revisión con una devolución por medio.') as c6_revision \gset
select pg_temp.pedir(:'c6_payment_id', 1000) as c6_r \gset
select pg_temp.liberar(:'c6_payment_id', 'Intento de quitarla con la devolución abierta.') as c6_liberar \gset
select pg_temp.expect('C35 con una devolución pedida y sin respuesta, la revisión no se quita',
  :'c6_revision' || ' · ' || :'c6_liberar',
  'applied · payout HELD · RECHAZADO: Hay una devolución de este pago sin resultado final: espera a que se resuelva antes de quitar la revisión');


\echo ''
\echo '--- Un pago en revisión sin dinero detrás no infla lo que se puede devolver'

-- Cobrado $21.000, tiempo adicional aceptado y nunca pagado, transferidos
-- $18.480: quedan $2.520 de la plataforma.
select * from pg_temp.montar_trabajo('c-fantasma') \gset d1_
select pg_temp.en_curso(:'d1_assignment_id') is null as _ \gset
select * from pg_temp.pedir_extension(:'d1_assignment_id') \gset d1_
select pg_temp.aprobar(:'d1_assignment_id') is null as _ \gset
select pg_temp.transferir(:'d1_assignment_id') as d1_transferido \gset

select pg_temp.expect('C36 el cobro adicional nunca pagado no se pone en revisión',
  :'d1_transferido' || ' · ' || pg_temp.revisar(:'d1_ext_payment', 'Revisión de un cobro que nunca se pagó.'),
  'PAID · RECHAZADO: Este pago todavía está en curso (PENDING): no hay dinero que revisar. Si el cliente dice que pagó, usa «Consultar al proveedor»');

-- Como lo dejaba el botón anterior: en revisión, sin `captured_at`.
update payments set status = 'UNDER_REVIEW', review_reason = 'Marcado manualmente desde administración'
 where id = :'d1_ext_payment';
select pg_temp.expect_like('C37 en revisión sin haberse cobrado, no cuenta como cobrado: siguen quedando $2.520',
  pg_temp.pedir(:'d1_payment_id', 11520),
  'RECHAZADO: Al trabajador ya se le pagaron $18.480 por este trabajo y el cliente pagó $21.000. Solo se pueden devolver $2.520 más%');

-- Un cobro tardío que sí se capturó cuenta: $2.520 + $9.000.
update payments set captured_at = now() where id = :'d1_ext_payment';
select pg_temp.expect('C38 en revisión y capturado, sí cuenta: se pueden devolver $11.520',
  coalesce(pg_temp.pedir(:'d1_payment_id', 11520) like 'RECHAZADO%', true)::text,
  'false');

-- Y con el trabajador ya pagado, una revisión no retiene nada: no se pone.
select pg_temp.expect('C39 con el payout transferido, el pago del trabajo no se pone en revisión',
  pg_temp.revisar(:'a1_payment_id', 'Revisión con el trabajador ya pagado.') || ' · ' || pg_temp.pago(:'a1_payment_id'),
  'RECHAZADO: El pago al trabajador de este trabajo ya se transfirió: una revisión ya no retiene nada. Si hay que devolverle algo al cliente, usa «Devolver» · PAID');


\echo ''
\echo '--- Anular la pestaña vigente no tumba el pago que otra pestaña está confirmando'

-- Pago con un intento en Webpay y su token, como lo deja `startCheckout`.
create function pg_temp.orden(p_payment uuid)
returns text language sql as $$
  select 'HTF-' || upper(substr(replace(p_payment::text, '-', ''), 1, 12)) || '-'
         || upper(substr(md5(random()::text), 1, 9))
$$;

create function pg_temp.montar_intento(
  p_tag text,
  out job_id uuid,
  out assignment_id uuid,
  out payment_id uuid,
  out client_id uuid,
  out worker_id uuid,
  out orden text,
  out token text
)
language plpgsql as $$
begin
  select * into job_id, assignment_id, payment_id, client_id, worker_id from pg_temp.publicar(p_tag);
  orden := pg_temp.orden(payment_id);
  token := 'tok-c-' || p_tag || '-' || substr(md5(random()::text), 1, 12);
  perform public.register_payment_attempt(
    payment_id, 'transbank_webpay_plus', 'integration', orden,
    'S-' || upper(replace(payment_id::text, '-', '')), 'https://hagotufila.cl/pagos/retorno');
  perform public.record_payment_attempt_token(
    payment_id, orden, token, 'https://webpay3gint.transbank.cl/webpayserver/initTransaction');
end $$;

create function pg_temp.reintentar(p_payment uuid, p_tag text, out orden text, out token text)
language plpgsql as $$
begin
  orden := pg_temp.orden(p_payment);
  token := 'tok-c-' || p_tag || '-' || substr(md5(random()::text), 1, 12);
  perform public.register_payment_attempt(
    p_payment, 'transbank_webpay_plus', 'integration', orden,
    (select session_id from public.payments where id = p_payment),
    'https://hagotufila.cl/pagos/retorno');
  perform public.record_payment_attempt_token(
    p_payment, orden, token, 'https://webpay3gint.transbank.cl/webpayserver/initTransaction');
exception when others then
  orden := 'RECHAZADO: ' || sqlerrm;
  token := null;
end $$;

create function pg_temp.confirmar(p_payment uuid, p_token text, p_result text, p_amount bigint default null)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  r := public.confirm_payment_result(
    p_payment, 'transbank_webpay_plus', 'commit:' || p_token, p_result, p_amount,
    jsonb_build_object('authorization_code', '123456', 'card_last_digits', '6623'),
    p_token, null);
  return coalesce(r ->> 'decision', r ->> 'outcome');
exception when others then
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.abandonar(p_payment uuid, p_token text, p_orden text)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  r := public.record_payment_abandonment(p_payment, 'transbank_webpay_plus', 'aborted_by_user',
    '{}'::jsonb, p_token, p_orden);
  return (r ->> 'outcome') || ' · ' || (r ->> 'payment_status');
exception when others then
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.intento(p_token text)
returns text language sql volatile as $$
  select status from public.payment_attempts where provider_token = p_token
$$;

-- Pestaña A (intento 1) y pestaña B (intento 2, la vigente). El cliente paga
-- en A —el retorno anota el commit y llama a Transbank— y anula B.
select * from pg_temp.montar_intento('c-tabs') \gset e1_
select * from pg_temp.reintentar(:'e1_payment_id', 'c-tabs-b') \gset e1b_
update payment_attempts set commit_requested_at = now() where provider_token = :'e1_token';

select pg_temp.abandonar(:'e1_payment_id', :'e1b_token', :'e1b_orden') as e1_abandono \gset
select pg_temp.expect('C40 el abandono de B, con A confirmándose, cierra solo B: el pago sigue en curso',
  :'e1_abandono' || ' · ' ||
  pg_temp.intento(:'e1b_token') || ' · ' || pg_temp.intento(:'e1_token'),
  'attempt_only · CREATED · FAILED · CREATED');
select pg_temp.confirmar(:'e1_payment_id', :'e1_token', 'PAID', 21000) as e1_a \gset
select pg_temp.expect('C41 y la autorización de A habilita el trabajo, sin pasar por revisión',
  :'e1_a' || ' · ' || pg_temp.pago(:'e1_payment_id') || ' · ' ||
  (select status::text from jobs where id = :'e1_job_id') || ' · ' || pg_temp.asignacion(:'e1_assignment_id'),
  'PAID · PAID · PAID · CONFIRMED');

-- Sin otro intento confirmándose, el abandono del vigente sigue cerrando el pago.
select * from pg_temp.montar_intento('c-solo') \gset e2_
select pg_temp.abandonar(:'e2_payment_id', :'e2_token', :'e2_orden') as e2_abandono \gset
select pg_temp.expect('C42 sin otro intento en curso, el abandono del vigente cierra el pago, como siempre',
  :'e2_abandono' || ' · ' || pg_temp.intento(:'e2_token'),
  'applied · FAILED · FAILED');

-- Con A ya resuelta (rechazada), anular B sí cierra el pago.
select * from pg_temp.montar_intento('c-tabs-2') \gset e3_
select * from pg_temp.reintentar(:'e3_payment_id', 'c-tabs-2b') \gset e3b_
update payment_attempts set commit_requested_at = now() where provider_token = :'e3_token';
select pg_temp.confirmar(:'e3_payment_id', :'e3_token', 'FAILED') as e3_a \gset
select pg_temp.expect('C43 si la otra pestaña ya se resolvió sin cobro, el abandono del vigente cierra el pago',
  :'e3_a' || ' · ' || pg_temp.abandonar(:'e3_payment_id', :'e3b_token', :'e3b_orden'),
  'ATTEMPT_FAILED · applied · FAILED');


\echo ''
\echo '--- Tope de intentos: cinco por pago en treinta minutos'

select * from pg_temp.montar_intento('c-tope') \gset f1_
-- Cuatro reintentos más, en una sola sentencia: cinco intentos en total.
select string_agg(left((select orden from pg_temp.reintentar(:'f1_payment_id', 'c-tope-' || n)), 9), ',')
         as f1_reintentos
  from generate_series(2, 5) n \gset
select orden as f1_sexto from pg_temp.reintentar(:'f1_payment_id', 'c-tope-6') \gset
select pg_temp.expect_like('C44 el sexto intento seguido se niega antes de crear nada en Transbank',
  (case when :'f1_reintentos' like '%RECHAZADO%' then 'cuatro reintentos: ' || :'f1_reintentos' || ' · ' else '' end) ||
  :'f1_sexto' || ' · ' ||
  (select count(*)::text from payment_attempts where payment_id = :'f1_payment_id') || ' · ' ||
  (select attempt::text from payments where id = :'f1_payment_id'),
  'RECHAZADO: Hiciste varios intentos de pago en poco tiempo. Espera unos minutos antes de volver a intentarlo · 5 · 5');

update payment_attempts set created_at = created_at - interval '31 minutes' where payment_id = :'f1_payment_id';
select orden as f1_septimo from pg_temp.reintentar(:'f1_payment_id', 'c-tope-7') \gset
select pg_temp.expect('C45 pasada la media hora, se puede volver a intentar',
  coalesce(:'f1_septimo' like 'RECHAZADO%', true)::text || ' · ' ||
  (select count(*)::text from payment_attempts where payment_id = :'f1_payment_id'),
  'false · 6');

select pg_temp.expect('C46 el tope es por pago: el de otro trabajo del mismo cliente no se ve afectado',
  coalesce((select token from pg_temp.montar_intento('c-tope-otro')) is null, true)::text,
  'false');


\echo ''
\echo '--- El trabajador no recibe el identificador del pago del cliente'

select pg_temp.expect('C47 assignment_payment_states: el id del pago, al cliente y a administración; al trabajador, nulo',
  pg_temp.rpc(:'a3_worker_id', format(
    'select string_agg(purpose || %L || coalesce(id::text, %L), %L order by purpose::text) from public.assignment_payment_states(array[%L]::uuid[])',
    ':', 'nulo', ',', :'a3_assignment_id')) || ' · ' ||
  pg_temp.rpc(:'a3_client_id', format(
    'select bool_and(id is not null)::text from public.assignment_payment_states(array[%L]::uuid[])',
    :'a3_assignment_id')) || ' · ' ||
  pg_temp.rpc(pg_temp.admin_id(), format(
    'select bool_and(id is not null)::text from public.assignment_payment_states(array[%L]::uuid[])',
    :'a3_assignment_id')),
  'EXTENSION:nulo,JOB:nulo · true · true');


\echo ''
\echo '--- La historia del pago no dice quién administra ni qué anotó'

select * from pg_temp.montar_trabajo('c-nota') \gset h1_
select pg_temp.pedir(:'h1_payment_id', 2000) as h1_r \gset
select pg_temp.valor(format('select public.claim_payment_refund(%L)::text', :'h1_r')) is not null as _ \gset
select pg_temp.valor(format('select public.mark_payment_refund_unknown(%L, %L)::text', :'h1_r', 'timeout'))
  is not null as _ \gset
select pg_temp.rpc(pg_temp.admin_id(), format(
  'select (public.resolve_unknown_refund(%L, true, %L, %L)) ->> %L',
  :'h1_r', 'NULLIFIED', 'El portal muestra la anulación de 2000.', 'refund_status')) as h1_cerrada \gset

create function pg_temp.eventos_del_cliente(p_user uuid, p_payment uuid)
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.como(p_user);
  set local role authenticated;
  select count(*) filter (where payload ->> 'operation' = 'refund')::text || ' · ' ||
         count(*) filter (where payload ? 'resolved_by' or payload ? 'note'
                             or payload::text like '%El portal muestra%')::text
    into v
    from public.payment_events where payment_id = p_payment;
  reset role;
  perform pg_temp.como(null);
  return v;
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'FALLA: ' || sqlerrm;
end $$;

select pg_temp.expect('C48 el cliente ve la devolución en la historia de su pago, sin quién la cerró ni la nota',
  :'h1_cerrada' || ' · ' || pg_temp.eventos_del_cliente(:'h1_client_id', :'h1_payment_id'),
  'CONFIRMED · 1 · 0');
select pg_temp.expect('C49 la nota y quién la cerró quedan donde solo lee administración',
  (select (resolved_by = pg_temp.admin_id())::text || ' ' || resolution_note from payment_refunds where id = :'h1_r') || ' · ' ||
  (select count(*)::text from audit_logs
    where action = 'payment_refund_resolved_manually' and entity_id = :'h1_payment_id'
      and after ->> 'note' = 'El portal muestra la anulación de 2000.'),
  'true El portal muestra la anulación de 2000. · 1');
-- Las baterías anteriores también cierran devoluciones a mano: ninguna dejó
-- datos de administración en un evento.
select pg_temp.expect('C50 ningún evento de pago, de ninguna batería, lleva quién administra ni su nota',
  (select count(*)::text from payment_events where payload ? 'resolved_by' or payload ? 'note'),
  '0');


\echo ''
\echo '--- Invariantes'

select pg_temp.expect('C51 ningún invariante del dinero roto en los trabajos de esta batería',
  (select coalesce(string_agg(v.rule || ':' || v.entity_id, ', '), 'ninguno')
     from (select * from app_private.payment_invariant_violations()
           union all
           select * from app_private.refund_invariant_violations()) v
    where v.entity_id in (
      select a from c_asignaciones
      union all select po.id from payouts po join c_asignaciones c on c.a = po.assignment_id
      union all select p.id from payments p join c_asignaciones c on c.a = p.assignment_id)),
  'ninguno');
