\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Al trabajador no se le paga sobre un cobro devuelto, en duda o de prueba
-- =============================================================================
-- Prefijo L. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Los dos defectos que cierra esta batería:
--
--   · `resolve_dispute`, `approve_payout` y `mark_payout_paid` liberaban el pago
--     al trabajador aunque el cliente ya tuviera su dinero de vuelta o el cobro
--     estuviera en revisión (20260601000800).
--   · Un cobro de integración o del proveedor simulado se podía pagar al
--     trabajador con dinero real (20260601000810).
--
-- Casi todo se monta con pagos del ambiente 'production' y la bandera
-- `allow_non_production_payouts` en FALSE: así se ve que un cobro de producción
-- se transfiere, y que ser de producción no exime de que el cobro esté sano.
-- =============================================================================

-- Se parte del valor por omisión, pase lo que pase en los archivos anteriores.
update public.platform_settings set allow_non_production_payouts = false where id;

create function pg_temp.expect(label text, actual text, expected text)
returns text language sql as $$
  select label || ' = ' || coalesce(actual, 'NULO') ||
         case when actual is not distinct from expected then ''
              else ' FALLO (esperado ' || coalesce(expected, 'NULO') || ')' end
$$;

-- Igual que `expect`, pero contra un patrón LIKE: los mensajes llevan fechas y
-- cifras que no conviene copiar enteras.
create function pg_temp.expect_like(label text, actual text, pattern text)
returns text language sql as $$
  select label || ' = ' || coalesce(actual, 'NULO') ||
         case when coalesce(actual, '') like pattern then ''
              else ' FALLO (esperado algo como ' || pattern || ')' end
$$;

-- Trabajo publicado, oferta aceptada y pago confirmado con el proveedor
-- simulado. El ambiente del pago se fija antes de confirmar, como lo deja
-- `register_payment_attempt`; NULL es un pago simulado sin ambiente.
create function pg_temp.montar_trabajo(
  p_tag text,
  p_ambiente text default null,
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
  v_tag := p_tag || '-' || substr(md5(random()::text), 1, 8);

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
    'Prueba de salud del pago ' || p_tag,
    'Montaje de la prueba de la salud del pago antes de pagar al trabajador.',
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

  update public.payments
     set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-' || v_tag,
         provider_token = 'tok-' || v_tag, environment = p_ambiente
   where id = payment_id;
  perform public.confirm_payment_result(payment_id, 'mock', 'evt-' || v_tag, 'PAID', null, '{}');
end;
$$;

create function pg_temp.como(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true)
$$;

create function pg_temp.admin_id()
returns uuid language sql stable as $$
  select id from public.profiles where role = 'ADMIN' order by id limit 1
$$;

-- Del pago confirmado hasta que el trabajador pide el cierre.
create function pg_temp.hasta_cierre_pedido(p_a uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  perform public.mark_on_the_way(p_a);
  perform public.register_check_in(p_a, true, -33.4265, -70.6153, 20, 'device');
  perform public.start_job_work(p_a);
  perform public.request_job_completion(p_a, 'Listo.');
  perform pg_temp.como(null);
end $$;

create function pg_temp.aprobar(p_a uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  perform public.approve_job_completion(p_a, true);
  perform pg_temp.como(null);
end $$;

-- Un trabajo terminado, aprobado por el cliente y con la ventana ya vencida:
-- lo único que puede frenar la transferencia es el dinero.
create function pg_temp.listo_para_transferir(
  p_tag text,
  p_ambiente text,
  out assignment_id uuid,
  out payment_id uuid
)
language plpgsql as $$
declare
  m record;
begin
  select * into m from pg_temp.montar_trabajo(p_tag, p_ambiente);
  perform pg_temp.hasta_cierre_pedido(m.assignment_id);
  perform pg_temp.aprobar(m.assignment_id);
  update public.assignments set dispute_deadline_at = now() - interval '1 minute'
   where id = m.assignment_id;
  assignment_id := m.assignment_id;
  payment_id := m.payment_id;
end $$;

create function pg_temp.transferir(p_a uuid)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(pg_temp.admin_id());
  r := public.mark_payout_paid(
    (select id from public.payouts where assignment_id = p_a),
    'TRF-SALUD-' || left(p_a::text, 8), null, null);
  perform pg_temp.como(null);
  return r ->> 'payout_status';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.aprobar_payout(p_a uuid)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(pg_temp.admin_id());
  r := public.approve_payout((select id from public.payouts where assignment_id = p_a), 'Aprobado en la prueba');
  perform pg_temp.como(null);
  return r ->> 'payout_status';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.reclamar(p_a uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  perform public.open_dispute(p_a, 'Trabajo no realizado',
    'El trabajador nunca llegó al lugar y la fila no se hizo.');
  perform pg_temp.como(null);
  return 'ABIERTA';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADA: ' || sqlerrm;
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

-- Devolución por el camino real: la pide administración y la cierra el
-- servidor con lo que contestó el banco. `p_confirmar` NULL la deja pedida y
-- sin respuesta; FALSE, rechazada; TRUE, confirmada.
create function pg_temp.devolver(p_a uuid, p_monto bigint, p_confirmar boolean, p_disputa uuid default null)
returns uuid language plpgsql as $$
declare
  v_refund uuid;
begin
  perform pg_temp.como(pg_temp.admin_id());
  v_refund := public.request_payment_refund(
    (select payment_id from public.payouts where assignment_id = p_a),
    p_monto, 'Devolución de la prueba de salud del pago.',
    'refund-' || substr(md5(random()::text), 1, 12), p_disputa);
  perform pg_temp.como(null);

  if p_confirmar is not null then
    perform public.settle_payment_refund(v_refund, p_confirmar,
      case when p_confirmar then 'NULLIFIED' end, null, '{}'::jsonb);
  end if;
  return v_refund;
end $$;

-- Lo que hacía la vía anterior a esta corrección —o cualquier otra que se abra
-- mañana—: un payout que llega a APPROVED sobre un cobro en duda.
create function pg_temp.forzar_aprobado(p_a uuid)
returns void language sql as $$
  update public.payouts set status = 'APPROVED', held_reason = null where assignment_id = p_a
$$;

create function pg_temp.devolver_a_retenido(p_a uuid)
returns void language sql as $$
  update public.payouts set status = 'HELD', held_reason = 'Retenido al cerrar la prueba'
   where assignment_id = p_a and status = 'APPROVED'
$$;

create function pg_temp.payout(p_a uuid)
returns text language sql stable as $$
  select status::text from public.payouts where assignment_id = p_a
$$;

-- Escribe en `platform_settings` con la sesión de administración, como lo haría
-- el panel o una petición REST con su token.
create function pg_temp.ajustar_como_admin(p_sql text)
returns text language plpgsql as $$
begin
  perform pg_temp.como(pg_temp.admin_id());
  set local role authenticated;
  execute p_sql;
  reset role;
  perform pg_temp.como(null);
  return 'ACEPTADO';
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'RECHAZADO';
end $$;

create temp table l_ctx (k text primary key, a uuid);


\echo ''
\echo '--- La bandera de pagos de prueba'

select pg_temp.expect('L01 allow_non_production_payouts existe y por omisión es FALSE',
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'platform_settings'
      and column_name = 'allow_non_production_payouts'), 'false');

select pg_temp.expect('L02 una sesión de administración no puede encenderla',
  pg_temp.ajustar_como_admin('update public.platform_settings set allow_non_production_payouts = true where id'),
  'RECHAZADO');

select pg_temp.expect('L03 esa misma sesión sí ajusta las demás tolerancias',
  pg_temp.ajustar_como_admin('update public.platform_settings set job_expiry_grace_hours = job_expiry_grace_hours where id'),
  'ACEPTADO');

select pg_temp.expect('L04 tras el intento sigue en FALSE',
  (select allow_non_production_payouts::text from public.platform_settings), 'false');


\echo ''
\echo '--- El ambiente del cobro decide si se transfiere'

select * from pg_temp.listo_para_transferir('l-mock', null) \gset k1_
select * from pg_temp.listo_para_transferir('l-int', 'integration') \gset k2_
select * from pg_temp.listo_para_transferir('l-prod', 'production') \gset k3_
insert into l_ctx values ('k1', :'k1_assignment_id'), ('k2', :'k2_assignment_id'), ('k3', :'k3_assignment_id');

select pg_temp.expect_like('L05 con la bandera en FALSE, un pago simulado no se transfiere',
  pg_temp.transferir(:'k1_assignment_id'),
  'RECHAZADO: El pago del cliente es del ambiente simulado (sin ambiente registrado), no de producción%');

select pg_temp.expect_like('L06 ni uno del ambiente de integración',
  pg_temp.transferir(:'k2_assignment_id'),
  'RECHAZADO: El pago del cliente es del ambiente «integration», no de producción%');

select pg_temp.expect('L07 los dos siguen aprobados, sin transferir',
  pg_temp.payout(:'k1_assignment_id') || ' / ' || pg_temp.payout(:'k2_assignment_id'), 'APPROVED / APPROVED');

select pg_temp.expect('L08 un pago de producción se transfiere con la bandera en FALSE',
  pg_temp.transferir(:'k3_assignment_id'), 'PAID');

-- Una base de desarrollo o de pruebas la enciende en SQL.
update public.platform_settings set allow_non_production_payouts = true where id;

select pg_temp.expect('L09 con la bandera en TRUE, el pago simulado se transfiere',
  pg_temp.transferir(:'k1_assignment_id'), 'PAID');
select pg_temp.expect('L10 y el de integración también',
  pg_temp.transferir(:'k2_assignment_id'), 'PAID');

update public.platform_settings set allow_non_production_payouts = false where id;

-- Producción no se salta la ventana: k4 está aprobado y con el plazo abierto.
select * from pg_temp.montar_trabajo('l-ventana', 'production') \gset k4_
select pg_temp.hasta_cierre_pedido(:'k4_assignment_id') is null as _ \gset
select pg_temp.aprobar(:'k4_assignment_id') is null as _ \gset
insert into l_ctx values ('k4', :'k4_assignment_id');

select pg_temp.expect_like('L11 un pago de producción sigue esperando la ventana',
  pg_temp.transferir(:'k4_assignment_id'), 'RECHAZADO: El plazo para reportar problemas vence el%');


\echo ''
\echo '--- Un cobro devuelto entero no paga al trabajador'

select * from pg_temp.listo_para_transferir('l-total', 'production') \gset h1_
insert into l_ctx values ('h1', :'h1_assignment_id');
select pg_temp.devolver(:'h1_assignment_id', 21000, true) is not null as _ \gset

select pg_temp.expect('L12 la devolución total deja el pago devuelto y el payout retenido',
  (select status::text from payments where id = :'h1_payment_id') || ' / ' || pg_temp.payout(:'h1_assignment_id'),
  'REFUNDED / HELD');

select pg_temp.expect_like('L13 administración no puede aprobarlo',
  pg_temp.aprobar_payout(:'h1_assignment_id'),
  'RECHAZADO: El cliente recibió la devolución total de este trabajo ($21.000)%');

select pg_temp.expect('L14 y sigue retenido', pg_temp.payout(:'h1_assignment_id'), 'HELD');

select pg_temp.forzar_aprobado(:'h1_assignment_id') is null as _ \gset
select pg_temp.expect_like('L15 aunque llegue aprobado por otra vía, la transferencia lo frena',
  pg_temp.transferir(:'h1_assignment_id'),
  'RECHAZADO: El cliente recibió la devolución total de este trabajo%');
select pg_temp.devolver_a_retenido(:'h1_assignment_id') is null as _ \gset


\echo ''
\echo '--- Un cobro en revisión no paga al trabajador'

select * from pg_temp.listo_para_transferir('l-revision', 'production') \gset h2_
insert into l_ctx values ('h2', :'h2_assignment_id');

-- Lo que hace «Poner en revisión» en /admin/pagos.
update payments set status = 'UNDER_REVIEW', review_reason = 'Importe distinto en el portal'
 where id = :'h2_payment_id';

select pg_temp.expect('L16 el payout queda retenido', pg_temp.payout(:'h2_assignment_id'), 'HELD');

select pg_temp.expect_like('L17 administración no puede aprobarlo mientras siga en revisión',
  pg_temp.aprobar_payout(:'h2_assignment_id'),
  'RECHAZADO: El pago del cliente está en revisión (Importe distinto en el portal)%');

select pg_temp.forzar_aprobado(:'h2_assignment_id') is null as _ \gset
select pg_temp.expect_like('L18 y la transferencia tampoco pasa',
  pg_temp.transferir(:'h2_assignment_id'), 'RECHAZADO: El pago del cliente está en revisión%');
select pg_temp.devolver_a_retenido(:'h2_assignment_id') is null as _ \gset


\echo ''
\echo '--- Una devolución sin respuesta del banco frena la transferencia'

select * from pg_temp.listo_para_transferir('l-vuelo', 'production') \gset h3_
insert into l_ctx values ('h3', :'h3_assignment_id');
select pg_temp.devolver(:'h3_assignment_id', 2000, null) as h3_refund \gset

select pg_temp.expect('L19 pedirla no retiene nada: el pago sigue cobrado y el payout aprobado',
  (select status::text from payments where id = :'h3_payment_id') || ' / ' || pg_temp.payout(:'h3_assignment_id'),
  'PAID / APPROVED');

select pg_temp.expect_like('L20 pero hasta saber si se devolvió no se transfiere',
  pg_temp.transferir(:'h3_assignment_id'),
  'RECHAZADO: Hay una devolución al cliente sin respuesta del banco ($2.000, pedida el %');

select public.settle_payment_refund(:'h3_refund', false, null, null, '{}'::jsonb) is not null as _ \gset

select pg_temp.expect('L21 si el banco la rechaza, el cobro vuelve a estar sano y se transfiere',
  pg_temp.transferir(:'h3_assignment_id'), 'PAID');


\echo ''
\echo '--- Las cifras tienen que cuadrar'

-- Cobro de $21.000 (servicio $18.000 + bono $3.000), comisión del 14 % sobre
-- el servicio ($2.520): al trabajador le corresponden $18.480.
select * from pg_temp.listo_para_transferir('l-cifras', 'production') \gset h4_
insert into l_ctx values ('h4', :'h4_assignment_id');
select pg_temp.devolver(:'h4_assignment_id', 5000, true) is not null as _ \gset

select pg_temp.expect('L22 una devolución parcial no retiene el payout',
  (select status::text from payments where id = :'h4_payment_id') || ' / ' || pg_temp.payout(:'h4_assignment_id'),
  'PARTIALLY_REFUNDED / APPROVED');

select pg_temp.expect_like('L23 pero $5.000 devueltos más $18.480 al trabajador superan los $21.000 cobrados',
  pg_temp.transferir(:'h4_assignment_id'),
  'RECHAZADO: Las cifras de este trabajo no cuadran: el cliente pagó $21.000, se le devolvió $5.000 y al trabajador irían $18.480: suman $23.480, $2.480 más de lo que entró%');

-- Una devolución que cabe en la comisión no le quita nada al trabajador.
select * from pg_temp.listo_para_transferir('l-cuadra', 'production') \gset h5_
insert into l_ctx values ('h5', :'h5_assignment_id');
select pg_temp.devolver(:'h5_assignment_id', 2000, true) is not null as _ \gset

select pg_temp.expect('L24 con $2.000 devueltos las cifras cuadran y se transfiere',
  pg_temp.transferir(:'h5_assignment_id'), 'PAID');


\echo ''
\echo '--- Una disputa no se resuelve contra una devolución'

-- d1: el cliente reclama y, con la disputa abierta, recibe la devolución total.
select * from pg_temp.montar_trabajo('l-d1', 'production') \gset d1_
insert into l_ctx values ('d1', :'d1_assignment_id');
select pg_temp.reclamar(:'d1_assignment_id') is not null as _ \gset
select pg_temp.devolver(:'d1_assignment_id', 21000, true) is not null as _ \gset

select pg_temp.expect_like('L25 a favor del trabajador, sobre un cobro devuelto entero, no',
  pg_temp.resolver(:'d1_assignment_id', 'WORKER_WINS', null),
  'RECHAZADO: El cliente ya recibió la devolución total de este trabajo ($21.000)%');
select pg_temp.expect_like('L26 ni repartida',
  pg_temp.resolver(:'d1_assignment_id', 'PARTIAL', 5000),
  'RECHAZADO: El cliente ya recibió la devolución total%');
select pg_temp.expect('L27 el intento no deja nada a medias: disputa abierta y payout retenido',
  (select status::text from disputes where assignment_id = :'d1_assignment_id') || ' / ' || pg_temp.payout(:'d1_assignment_id'),
  'OPEN / HELD');
-- La resolución va en su propia sentencia: una consulta en la misma sentencia
-- leería la foto de antes de resolver.
select pg_temp.resolver(:'d1_assignment_id', 'CLIENT_WINS', null) as d1_r \gset
select pg_temp.expect('L28 a favor del cliente sí: payout cancelado y nada más que devolver',
  :'d1_r' || ' / ' || (select coalesce(refund_amount, 0)::text || ' ' || status::text
                         from disputes where assignment_id = :'d1_assignment_id'),
  'CANCELLED / 0 RESOLVED');

-- d2: a favor del trabajador, pero con un importe a devolver que no cabe.
select * from pg_temp.montar_trabajo('l-d2', 'production') \gset d2_
insert into l_ctx values ('d2', :'d2_assignment_id');
select pg_temp.reclamar(:'d2_assignment_id') is not null as _ \gset

select pg_temp.expect_like('L29 pagar entero al trabajador y además devolver $5.000 no cuadra',
  pg_temp.resolver(:'d2_assignment_id', 'WORKER_WINS', 5000),
  'RECHAZADO: Esta resolución no cuadra: el cliente pagó $21.000, se le devolvió $0, se le deben $5.000 por una disputa y al trabajador irían $18.480%');
select pg_temp.expect('L30 y la disputa sigue abierta',
  (select status::text from disputes where assignment_id = :'d2_assignment_id'), 'OPEN');
select pg_temp.resolver(:'d2_assignment_id', 'PARTIAL', 5000) as d2_r \gset
select pg_temp.expect('L31 repartida, lo devuelto sale del trabajador y cuadra',
  :'d2_r' || ' / ' || (select net_amount::text from payouts where assignment_id = :'d2_assignment_id'),
  'APPROVED / 13480');

-- Se ejecuta la devolución de la disputa, ligada a ella: ya no se debe nada.
select pg_temp.devolver(:'d2_assignment_id', 5000, true,
  (select id from disputes where assignment_id = :'d2_assignment_id')) is not null as _ \gset
select pg_temp.expect('L32 con la devolución de la disputa hecha, se transfiere lo que queda',
  pg_temp.transferir(:'d2_assignment_id'), 'PAID');

-- d3: a favor del trabajador con el cobro en revisión.
select * from pg_temp.montar_trabajo('l-d3', 'production') \gset d3_
insert into l_ctx values ('d3', :'d3_assignment_id');
select pg_temp.reclamar(:'d3_assignment_id') is not null as _ \gset
update payments set status = 'UNDER_REVIEW', review_reason = 'Contracargo informado por el banco'
 where id = :'d3_payment_id';

select pg_temp.resolver(:'d3_assignment_id', 'WORKER_WINS', null) as d3_r \gset
select pg_temp.expect('L33 la decisión se registra, pero el payout queda retenido',
  :'d3_r' || ' / '
    || (select status::text from disputes where assignment_id = :'d3_assignment_id') || ' / '
    || (select status::text || ': ' || held_reason from payouts where assignment_id = :'d3_assignment_id'),
  'HELD / RESOLVED / HELD: Disputa resuelta; el pago del cliente está en revisión');
select pg_temp.expect_like('L34 y no se aprueba hasta que el cobro vuelva a estar sano',
  pg_temp.aprobar_payout(:'d3_assignment_id'), 'RECHAZADO: El pago del cliente está en revisión%');

-- d4: el caso sano de siempre. Resuelta a favor del trabajador, se transfiere
-- aunque la ventana no haya corrido: la resolución es final.
select * from pg_temp.montar_trabajo('l-d4', 'production') \gset d4_
insert into l_ctx values ('d4', :'d4_assignment_id');
select pg_temp.reclamar(:'d4_assignment_id') is not null as _ \gset
select pg_temp.expect('L35 a favor del trabajador con el cobro sano: aprobado',
  pg_temp.resolver(:'d4_assignment_id', 'WORKER_WINS', null), 'APPROVED');
select pg_temp.expect('L36 y se transfiere sin esperar la ventana, como antes',
  pg_temp.transferir(:'d4_assignment_id'), 'PAID');


\echo ''
\echo '--- Cada cobro que sube el payout, no solo el del trabajo'

-- Un trabajo pagado con `p_ambiente_trabajo` al que, ya en curso, se le paga
-- tiempo adicional con `p_ambiente_extra`. Ese cobro sube el neto del payout
-- (`on_extension_paid`). Termina aprobado y con la ventana vencida.
create function pg_temp.con_tiempo_adicional(p_tag text, p_ambiente_trabajo text, p_ambiente_extra text)
returns uuid language plpgsql as $$
declare
  m record;
  v_ext uuid;
  v_pay uuid;
begin
  select * into m from pg_temp.montar_trabajo(p_tag, p_ambiente_trabajo);

  perform pg_temp.como(m.worker_id);
  perform public.mark_on_the_way(m.assignment_id);
  perform public.register_check_in(m.assignment_id, true, -33.4265, -70.6153, 20, 'device');
  perform public.start_job_work(m.assignment_id);
  v_ext := public.request_job_extension(m.assignment_id, 60, null);

  perform pg_temp.como(m.client_id);
  perform public.answer_job_extension(v_ext, true);
  v_pay := public.start_extension_payment(v_ext);
  perform pg_temp.como(null);

  update public.payments
     set status = 'CREATED', provider = 'mock',
         provider_transaction_id = 'mock-' || p_tag || '-ext-' || substr(md5(random()::text), 1, 6),
         provider_token = 'tok-' || p_tag || '-ext-' || substr(md5(random()::text), 1, 6),
         environment = p_ambiente_extra
   where id = v_pay;
  perform public.confirm_payment_result(v_pay, 'mock',
    'evt-' || p_tag || '-ext-' || substr(md5(random()::text), 1, 6), 'PAID', 9000, '{}');

  perform pg_temp.como(m.worker_id);
  perform public.request_job_completion(m.assignment_id, 'Listo.');
  perform pg_temp.como(null);
  perform pg_temp.aprobar(m.assignment_id);
  update public.assignments set dispute_deadline_at = now() - interval '1 minute'
   where id = m.assignment_id;
  return m.assignment_id;
end $$;

-- El valor que de verdad escribe la aplicación con el proveedor simulado.
select * from pg_temp.listo_para_transferir('l-mockenv', 'mock') \gset k5_
insert into l_ctx values ('k5', :'k5_assignment_id');

select pg_temp.expect_like('L40 un pago del ambiente «mock» tampoco se transfiere con la bandera en FALSE',
  pg_temp.transferir(:'k5_assignment_id'),
  'RECHAZADO: El pago del cliente es del ambiente «mock», no de producción%');

-- Trabajo cobrado en producción; el tiempo adicional, en integración.
select pg_temp.con_tiempo_adicional('l-ext-int', 'production', 'integration') as k6 \gset
insert into l_ctx values ('k6', :'k6');

select pg_temp.expect('L41 el cobro del tiempo adicional sí subió el payout (18.480 + 7.740)',
  (select net_amount::text from payouts where assignment_id = :'k6'), '26220');

select pg_temp.expect_like('L42 con ese cobro de integración dentro, no se transfiere aunque el del trabajo sea de producción',
  pg_temp.transferir(:'k6'),
  'RECHAZADO: Un cobro del tiempo adicional de este trabajo ($9.000) es del ambiente «integration», no de producción%');

-- Los dos en producción: se transfiere como siempre.
select pg_temp.con_tiempo_adicional('l-ext-prod', 'production', 'production') as k7 \gset
insert into l_ctx values ('k7', :'k7');

select pg_temp.expect('L43 con el trabajo y el tiempo adicional cobrados en producción, se transfiere',
  pg_temp.transferir(:'k7'), 'PAID');

update public.platform_settings set allow_non_production_payouts = true where id;
select pg_temp.expect('L44 en una base de pruebas con la bandera encendida, el de integración también',
  pg_temp.transferir(:'k6'), 'PAID');
update public.platform_settings set allow_non_production_payouts = false where id;


\echo ''
\echo '--- Lo que queda en la base'

select pg_temp.expect('L37 ningún invariante del dinero roto en estos trabajos',
  (select coalesce(string_agg(v.rule, ', '), 'ninguno')
     from (select * from app_private.payment_invariant_violations()
           union all
           select * from app_private.refund_invariant_violations()) v
    where v.entity_id in (
      select a from l_ctx
      union all select po.id from payouts po join l_ctx c on c.a = po.assignment_id
      union all select p.id from payments p join l_ctx c on c.a = p.assignment_id)),
  'ninguno');

select pg_temp.expect('L38 las piezas nuevas no las ejecuta un usuario con sesión',
  (has_function_privilege('authenticated', 'app_private.payout_money_blocker(uuid)', 'execute')
   or has_function_privilege('authenticated', 'app_private.payout_environment_blocker(uuid)', 'execute')
   or has_function_privilege('authenticated', 'app_private.payout_overrun(uuid)', 'execute')
   or has_function_privilege('authenticated', 'app_private.payout_transfer_blocker(uuid)', 'execute'))::text,
  'false');

select pg_temp.expect('L39 la bandera termina en FALSE',
  (select allow_non_production_payouts::text from public.platform_settings), 'false');
