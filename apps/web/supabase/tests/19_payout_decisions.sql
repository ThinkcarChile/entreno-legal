\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Lo que se decide sobre el pago al trabajador, y lo que se le debe al cliente
-- por una disputa
-- =============================================================================
-- Prefijo B. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Los defectos que cierra esta batería (20260601001610), reproducidos antes de
-- corregirlos:
--
--   · una disputa ganada por el cliente sobre un trabajo con tiempo adicional
--     dejaba anotado solo el cobro del trabajo: los $9.000 del tiempo
--     adicional se quedaban en la plataforma sin que nada lo mostrara;
--   · cualquier devolución se podía ligar a cualquier disputa resuelta, y
--     devolver el tiempo adicional ligado a ella bajaba lo que la cola pedía
--     sobre el pago del trabajo;
--   · el saldo por omisión de CLIENT_WINS no descontaba una devolución en
--     vuelo, y la cola quedaba con una deuda que ningún cobro podía pagar;
--   · un bono negado se transfería igual si el payout no estaba en PENDING al
--     aprobar el trabajo;
--   · un payout retenido porque las cifras no cuadraban no tenía salida, y
--     `approve_payout` lo volvía a aprobar sin mirarlas.
--
-- Cobro del trabajo de $21.000 (servicio $18.000 + bono $3.000), comisión del
-- 14 % sobre el servicio ($2.520): al trabajador le corresponden $18.480. Con
-- una hora de tiempo adicional ($9.000, comisión $1.260) entran $30.000 y el
-- payout es de $26.220.
--
-- Ojo al escribir comprobaciones: una consulta ve los datos como estaban al
-- EMPEZAR la sentencia. Cada acción va en su propia sentencia (con \gset) y la
-- comprobación en la siguiente.
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

-- Trabajos de esta batería: los invariantes del final miran solo estos.
create temp table b_asignaciones (a uuid primary key);

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

-- Trabajo publicado, oferta aceptada y cobro del trabajo confirmado en
-- producción con el proveedor simulado.
create function pg_temp.montar(
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
  v_tag text := p_tag || '-' || substr(md5(random()::text), 1, 8);
begin
  select * into worker_id, client_id from pg_temp.partes();

  job_id := gen_random_uuid();
  insert into public.jobs (
    id, client_id, category_id, status, title, description, region_code, commune_code,
    place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    bonus_amount, bonus_conditions, published_at
  ) values (
    job_id, client_id, (select id from public.job_categories order by sort_order limit 1), 'PUBLISHED',
    'Prueba de decisiones sobre el pago ' || p_tag,
    'Montaje de la prueba de disputas, bonos y ajustes del pago al trabajador.',
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
     set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-' || v_tag,
         provider_token = 'tok-' || v_tag, environment = 'production'
   where id = payment_id;
  perform public.confirm_payment_result(payment_id, 'mock', 'evt-' || v_tag, 'PAID', null, '{}');

  insert into b_asignaciones values (assignment_id);
end $$;

-- El trabajador llega y empieza: asignación IN_PROGRESS.
create function pg_temp.en_curso(p_a uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  perform public.mark_on_the_way(p_a);
  perform public.register_check_in(p_a, true, -33.4265, -70.6153, 20, 'device');
  perform public.start_job_work(p_a);
  perform pg_temp.como(null);
end $$;

-- El trabajador pide el cierre y el cliente aprueba, otorgando o no el bono.
-- Devuelve el resultado entero de la aprobación.
create function pg_temp.aprobar_trabajo(p_a uuid, p_bono boolean)
returns jsonb language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  perform public.request_job_completion(p_a, 'Listo.');
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  r := public.approve_job_completion(p_a, p_bono);
  perform pg_temp.como(null);
  return r;
end $$;

-- Aprobado por el cliente con el bono y la ventana vencida: payout APPROVED.
create function pg_temp.listo(p_tag text, out assignment_id uuid, out payment_id uuid)
language plpgsql as $$
declare
  m record;
begin
  select * into m from pg_temp.montar(p_tag);
  perform pg_temp.en_curso(m.assignment_id);
  perform pg_temp.aprobar_trabajo(m.assignment_id, true);
  update public.assignments set dispute_deadline_at = now() - interval '1 minute'
   where id = m.assignment_id;
  assignment_id := m.assignment_id;
  payment_id := m.payment_id;
end $$;

-- Trabajo y una hora de tiempo adicional cobrados en producción, aprobado por
-- el cliente y con la ventana TODAVÍA abierta (para poder reclamar). Con
-- `p_aprobar` falso, queda en curso.
create function pg_temp.con_tiempo_adicional(p_tag text, p_aprobar boolean default true)
returns uuid language plpgsql as $$
declare
  m record;
  v_ext uuid;
  v_pay uuid;
  v_tag text := p_tag || '-ext-' || substr(md5(random()::text), 1, 6);
begin
  select * into m from pg_temp.montar(p_tag);
  perform pg_temp.en_curso(m.assignment_id);

  perform pg_temp.como(m.worker_id);
  v_ext := public.request_job_extension(m.assignment_id, 60, null);
  perform pg_temp.como(m.client_id);
  perform public.answer_job_extension(v_ext, true);
  v_pay := public.start_extension_payment(v_ext);
  perform pg_temp.como(null);

  update public.payments
     set status = 'CREATED', provider = 'mock', provider_transaction_id = 'mock-' || v_tag,
         provider_token = 'tok-' || v_tag, environment = 'production'
   where id = v_pay;
  perform public.confirm_payment_result(v_pay, 'mock', 'evt-' || v_tag, 'PAID', 9000, '{}');

  if p_aprobar then
    perform pg_temp.aprobar_trabajo(m.assignment_id, true);
  end if;
  return m.assignment_id;
end $$;

create function pg_temp.pago(p_a uuid, p_purpose text)
returns uuid language sql stable as $$
  select id from public.payments where assignment_id = p_a and purpose::text = p_purpose
   order by created_at desc limit 1
$$;

create function pg_temp.disputa(p_a uuid)
returns uuid language sql stable as $$
  select id from public.disputes where assignment_id = p_a order by created_at desc limit 1
$$;

create function pg_temp.reclamar(p_a uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  perform public.open_dispute(p_a, 'Trabajo no realizado',
    'El trabajador llegó tarde y la fila se hizo a medias.');
  perform pg_temp.como(null);
  return 'ABIERTA';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADA: ' || sqlerrm;
end $$;

-- Resuelve como administración. Devuelve el estado del payout y lo anotado.
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
  return coalesce(r ->> 'payout_status', 'sin payout') || ' · '
    || coalesce(r ->> 'refund_registered', 'sin dato');
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
  v := public.request_payment_refund(p_payment, p_monto, 'Devolución de la batería B.',
    'refund-b-' || substr(md5(random()::text), 1, 12), p_disputa);
  perform pg_temp.como(null);
  return v::text;
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.confirmar(p_refund text)
returns text language plpgsql as $$
begin
  return public.settle_payment_refund(p_refund::uuid, true, 'NULLIFIED', null, '{"response_code":0}')
           ->> 'refund_status';
exception when others then
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Pedir y confirmar de una vez: devuelve CONFIRMED o el motivo de la negativa.
create function pg_temp.devolver(p_payment uuid, p_monto bigint, p_disputa uuid default null)
returns text language plpgsql as $$
declare
  v text := pg_temp.pedir(p_payment, p_monto, p_disputa);
begin
  if v like 'RECHAZADO%' then
    return v;
  end if;
  return pg_temp.confirmar(v);
end $$;

-- La parte de la disputa de cada cobro de la asignación en la cola de
-- /admin/pagos, como «JOB 21000 · EXTENSION 9000»; «nada» si no hay.
create function pg_temp.cola(p_a uuid)
returns text language sql stable as $$
  select coalesce(string_agg(p.purpose || ' ' || q.dispute_refund_pending
                             || case when q.dispute_id = d.id then '' else ' (otra disputa)' end,
                             ' · ' order by (p.purpose = 'JOB') desc, p.created_at), 'nada')
    from app_private.payment_review_queue() q
    join public.payments p on p.id = q.payment_id
    left join public.disputes d on d.assignment_id = p.assignment_id
   where p.assignment_id = p_a and q.dispute_refund_pending > 0
$$;

create function pg_temp.payout(p_a uuid)
returns text language sql stable as $$
  select status || ' ' || net_amount from public.payouts where assignment_id = p_a
$$;

create function pg_temp.cobros(p_a uuid)
returns text language sql stable as $$
  select 'cobrado ' || sum(amount) || ' · devuelto ' || sum(refunded_amount)
    from public.payments where assignment_id = p_a
$$;

create function pg_temp.transferir(p_a uuid)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(pg_temp.admin_id());
  r := public.mark_payout_paid(
    (select id from public.payouts where assignment_id = p_a),
    'TRF-B-' || left(p_a::text, 8), null, null);
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
  r := public.approve_payout((select id from public.payouts where assignment_id = p_a), null);
  perform pg_temp.como(null);
  return coalesce(r ->> 'payout_status', 'sin estado') || ' · bono descontado '
    || coalesce(r ->> 'bonus_removed', 'sin dato');
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.retener(p_a uuid)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(pg_temp.admin_id());
  r := public.hold_payout((select id from public.payouts where assignment_id = p_a),
                          'Retenido por la batería B');
  perform pg_temp.como(null);
  return r ->> 'payout_status';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.ajustar(p_a uuid, p_neto bigint, p_motivo text, p_quien uuid default null)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(coalesce(p_quien, pg_temp.admin_id()));
  r := public.adjust_payout((select id from public.payouts where assignment_id = p_a), p_neto, p_motivo);
  perform pg_temp.como(null);
  return coalesce(r ->> 'payout_status', 'sin estado') || ' ' || coalesce(r ->> 'net_amount', 'sin dato')
    || case when (r ->> 'repeated')::boolean then ' · repetido' else '' end
    || coalesce(' · no cuadra: ' || (r ->> 'overrun'), '');
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;


\echo ''
\echo '--- Una disputa ganada por el cliente cubre también el tiempo adicional'

select pg_temp.con_tiempo_adicional('b-cw') as a1 \gset
select pg_temp.payout(:'a1') as a1_payout_antes \gset
select pg_temp.reclamar(:'a1') as a1_reclamo \gset
select pg_temp.resolver(:'a1', 'CLIENT_WINS', null) as a1_r \gset

select pg_temp.expect('B01 el payout de $26.220 incluía el tiempo adicional; a favor del cliente se cancela y se anota todo lo cobrado',
  :'a1_payout_antes' || ' / ' || :'a1_reclamo' || ' / ' || :'a1_r' || ' / '
    || (select refund_amount::text from disputes where assignment_id = :'a1'),
  'APPROVED 26220 / ABIERTA / CANCELLED · 30000 / 30000');
select pg_temp.expect('B02 la cola muestra cada cobro con su parte de la disputa',
  pg_temp.cola(:'a1'), 'JOB 21000 · EXTENSION 9000');

-- Lo que hace «Devolver» en la tarjeta del tiempo adicional: ligada a la
-- disputa, porque la cola la reparte también ahí. Antes, esto bajaba lo que se
-- pedía sobre el cobro del trabajo a $12.000 y el cliente terminaba con $9.000
-- menos.
select pg_temp.devolver(pg_temp.pago(:'a1', 'EXTENSION'), 9000, pg_temp.disputa(:'a1')) as a1_ext \gset
select pg_temp.expect('B03 devolver el tiempo adicional ligado a la disputa no toca lo que se pide sobre el trabajo',
  :'a1_ext' || ' / ' || pg_temp.cola(:'a1'), 'CONFIRMED / JOB 21000');

select pg_temp.devolver(pg_temp.pago(:'a1', 'JOB'), 21000, pg_temp.disputa(:'a1')) as a1_job \gset
select pg_temp.expect('B04 devuelto también el trabajo, el cliente recupera todo y la cola queda vacía',
  :'a1_job' || ' / ' || pg_temp.cobros(:'a1') || ' / ' || pg_temp.cola(:'a1'),
  'CONFIRMED / cobrado 30000 · devuelto 30000 / nada');

-- En el otro orden la cola va pasando de un cobro al siguiente.
select pg_temp.con_tiempo_adicional('b-cw-orden') as a2 \gset
select pg_temp.reclamar(:'a2') is not null as _ \gset
select pg_temp.resolver(:'a2', 'CLIENT_WINS', null) is not null as _ \gset
select pg_temp.devolver(pg_temp.pago(:'a2', 'JOB'), 21000, pg_temp.disputa(:'a2')) as a2_job \gset
select pg_temp.expect('B05 devuelto el trabajo, queda pendiente el tiempo adicional',
  :'a2_job' || ' / ' || pg_temp.cola(:'a2'), 'CONFIRMED / EXTENSION 9000');

\echo ''
\echo '--- Un importe explícito se mide contra todo lo cobrado'

select pg_temp.con_tiempo_adicional('b-explicito') as a3 \gset
select pg_temp.reclamar(:'a3') is not null as _ \gset
select pg_temp.expect_like('B06 más de lo cobrado en la asignación, no',
  pg_temp.resolver(:'a3', 'CLIENT_WINS', 30001),
  'RECHAZADO: El monto a devolver supera lo cobrado en este trabajo ($30.000, contando el tiempo adicional)%');
select pg_temp.resolver(:'a3', 'CLIENT_WINS', 30000) as a3_r \gset
select pg_temp.expect('B07 lo cobrado entero, trabajo más tiempo adicional, sí',
  :'a3_r' || ' / ' || pg_temp.cola(:'a3'), 'CANCELLED · 30000 / JOB 21000 · EXTENSION 9000');

-- Repartida por más que el cobro del trabajo: antes «supera lo cobrado».
select pg_temp.con_tiempo_adicional('b-parcial') as a4 \gset
select pg_temp.reclamar(:'a4') is not null as _ \gset
select pg_temp.resolver(:'a4', 'PARTIAL', 25000) as a4_r \gset
select pg_temp.expect('B08 repartida por $25.000: el trabajador queda con $1.220 y la deuda se reparte entre los dos cobros',
  :'a4_r' || ' / ' || pg_temp.payout(:'a4') || ' / ' || pg_temp.cola(:'a4'),
  'APPROVED · 25000 / APPROVED 1220 / JOB 21000 · EXTENSION 4000');

\echo ''
\echo '--- Una devolución solo se liga a la disputa que la debe, y solo en su parte'

-- Repartida: $5.000 para el cliente, que salen del cobro del trabajo.
select pg_temp.con_tiempo_adicional('b-liga') as c1 \gset
select pg_temp.reclamar(:'c1') is not null as _ \gset

-- Con la disputa abierta, la cola no liga ningún cobro a ella: el panel ya no
-- manda su id, y una devolución sin ligar se acepta.
select pg_temp.pedir(pg_temp.pago(:'c1', 'EXTENSION'), 1000, pg_temp.disputa(:'c1')) as c1_abierta_ligada \gset
select pg_temp.pedir(pg_temp.pago(:'c1', 'EXTENSION'), 1000) as c1_abierta_suelta \gset
select pg_temp.expect_like('B09 con la disputa abierta la cola no la liga a ningún cobro, y sin ligar se devuelve',
  pg_temp.cola(:'c1') || ' / ' || (:'c1_abierta_suelta' not like 'RECHAZADO%')::text || ' / ' || :'c1_abierta_ligada',
  'nada / true / RECHAZADO: La disputa está en OPEN y no permite devolver todavía');
select pg_temp.confirmar(:'c1_abierta_suelta') is not null as _ \gset

select pg_temp.resolver(:'c1', 'PARTIAL', 5000) as c1_r \gset
select pg_temp.expect('B10 resuelta repartida, la deuda va sobre el cobro del trabajo',
  :'c1_r' || ' / ' || pg_temp.cola(:'c1'), 'APPROVED · 5000 / JOB 5000');

select pg_temp.expect_like('B11 ligada a la disputa sobre un cobro que no tiene parte de ella, no',
  pg_temp.pedir(pg_temp.pago(:'c1', 'EXTENSION'), 5000, pg_temp.disputa(:'c1')),
  'RECHAZADO: La devolución de esta disputa ($5.000) no va sobre este pago%');
select pg_temp.expect_like('B12 ligada y por más de lo que la disputa debe en ese cobro, no',
  pg_temp.pedir(pg_temp.pago(:'c1', 'JOB'), 6000, pg_temp.disputa(:'c1')),
  'RECHAZADO: De este pago, la disputa debe $5.000 (pediste $6.000)%');
select pg_temp.expect_like('B13 sin ligar no se come lo reservado para la disputa',
  pg_temp.pedir(pg_temp.pago(:'c1', 'JOB'), 16001),
  'RECHAZADO: De este pago, $5.000 son la devolución de una disputa resuelta%Sin ligar se pueden devolver a lo sumo $16.000 (pediste $16.001)');

-- La disputa de otro trabajo.
select pg_temp.expect_like('B14 una disputa de otro trabajo, no',
  pg_temp.pedir(pg_temp.pago(:'c1', 'JOB'), 1000, pg_temp.disputa(:'a4')),
  'RECHAZADO: Esa disputa es de otro trabajo%');

select pg_temp.pedir(pg_temp.pago(:'c1', 'JOB'), 5000, pg_temp.disputa(:'c1')) as c1_ligada \gset
select pg_temp.expect('B15 por su parte y sobre su cobro, sí; pedida, sale de la cola como deuda',
  (:'c1_ligada' not like 'RECHAZADO%')::text || ' / ' || pg_temp.cola(:'c1'), 'true / nada');
select pg_temp.expect_like('B16 una vez pedida, la disputa ya no debe nada que ligar',
  pg_temp.pedir(pg_temp.pago(:'c1', 'EXTENSION'), 1000, pg_temp.disputa(:'c1')),
  'RECHAZADO: La disputa no tiene ninguna devolución por pedir%');

\echo ''
\echo '--- Una devolución en vuelo al resolver no deja una deuda fantasma'

select * from pg_temp.montar('b-vuelo') \gset d1_
select pg_temp.en_curso(:'d1_assignment_id') is null as _ \gset
select pg_temp.reclamar(:'d1_assignment_id') is not null as _ \gset
select pg_temp.pedir(:'d1_payment_id', 5000) as d1_suelta \gset
select pg_temp.resolver(:'d1_assignment_id', 'CLIENT_WINS', null) as d1_r \gset
select pg_temp.expect('B17 a favor del cliente con $5.000 en devolución: se anotan los $16.000 que faltan',
  :'d1_r' || ' / ' || pg_temp.cola(:'d1_assignment_id'), 'CANCELLED · 16000 / JOB 16000');

select pg_temp.confirmar(:'d1_suelta') is not null as _ \gset
select pg_temp.devolver(:'d1_payment_id', 16000, pg_temp.disputa(:'d1_assignment_id')) as d1_ligada \gset
select pg_temp.expect('B18 confirmadas las dos, el cobro está devuelto entero y la cola vacía',
  :'d1_ligada' || ' / ' || (select status || ' ' || refunded_amount from payments where id = :'d1_payment_id')
    || ' / ' || pg_temp.cola(:'d1_assignment_id'),
  'CONFIRMED / REFUNDED 21000 / nada');

-- Una deuda anotada a mano por encima de lo que queda en el cobro (lo que
-- dejaba la versión anterior): la cola muestra solo lo que se puede devolver.
select * from pg_temp.montar('b-tope') \gset d2_
select pg_temp.en_curso(:'d2_assignment_id') is null as _ \gset
select pg_temp.reclamar(:'d2_assignment_id') is not null as _ \gset
select pg_temp.resolver(:'d2_assignment_id', 'CLIENT_WINS', null) is not null as _ \gset
update disputes set refund_amount = 25000 where assignment_id = :'d2_assignment_id';
select pg_temp.devolver(:'d2_payment_id', 21000, pg_temp.disputa(:'d2_assignment_id')) as d2_ligada \gset
select pg_temp.expect('B19 la cola nunca pide más de lo que el cobro puede devolver',
  :'d2_ligada' || ' / ' || pg_temp.cola(:'d2_assignment_id'), 'CONFIRMED / nada');

\echo ''
\echo '--- Un bono negado no se paga, esté como esté el payout'

-- Retenido por administración con el trabajo en curso.
select * from pg_temp.montar('b-bono-retenido') \gset e1_
select pg_temp.en_curso(:'e1_assignment_id') is null as _ \gset
select pg_temp.retener(:'e1_assignment_id') as e1_retenido \gset
select pg_temp.aprobar_trabajo(:'e1_assignment_id', false) ->> 'payout_status' as e1_aprobado \gset
select pg_temp.expect('B20 retenido, el cliente niega el bono: la aprobación dice HELD y el bono sale del neto',
  :'e1_retenido' || ' / ' || :'e1_aprobado' || ' / '
    || (select status || ' bono ' || bonus_amount || ' neto ' || net_amount from payouts
         where assignment_id = :'e1_assignment_id'),
  'HELD / HELD / HELD bono 0 neto 15480');
select pg_temp.expect('B21 y el aviso al trabajador no dice que su pago quedó aprobado',
  (select body from notifications
    where user_id = (select worker_id from assignments where id = :'e1_assignment_id')
      and notification_type = 'JOB_APPROVED'
      and href = '/mis-trabajos/' || :'e1_assignment_id'
    order by created_at desc limit 1),
  'Tu pago sigue retenido mientras administración revisa el caso: te avisaremos. Ya puedes dejar tu reseña.');

update assignments set dispute_deadline_at = now() - interval '1 minute' where id = :'e1_assignment_id';
select pg_temp.aprobar_payout(:'e1_assignment_id') as e1_ok \gset
select pg_temp.transferir(:'e1_assignment_id') as e1_t \gset
select pg_temp.expect('B22 liberado y transferido, sin el bono',
  :'e1_ok' || ' / ' || :'e1_t' || ' / ' || pg_temp.payout(:'e1_assignment_id'),
  'APPROVED · bono descontado 0 / PAID / PAID 15480');

-- Aprobado por administración antes de que el cliente apruebe el trabajo.
select * from pg_temp.montar('b-bono-aprobado') \gset e2_
select pg_temp.en_curso(:'e2_assignment_id') is null as _ \gset
select pg_temp.aprobar_payout(:'e2_assignment_id') as e2_antes \gset
select pg_temp.aprobar_trabajo(:'e2_assignment_id', false) ->> 'payout_status' as e2_aprobado \gset
select pg_temp.expect('B23 aprobado antes de tiempo, el bono negado también sale',
  :'e2_antes' || ' / ' || :'e2_aprobado' || ' / '
    || (select status || ' bono ' || bonus_amount || ' neto ' || net_amount from payouts
         where assignment_id = :'e2_assignment_id'),
  'APPROVED · bono descontado 0 / APPROVED / APPROVED bono 0 neto 15480');

-- Un payout que, por la vía que sea, todavía lleva un bono negado.
update payouts set bonus_amount = 3000, net_amount = 18480 where assignment_id = :'e2_assignment_id';
update assignments set dispute_deadline_at = now() - interval '1 minute' where id = :'e2_assignment_id';
select pg_temp.expect_like('B24 la transferencia se niega a pagar un bono que el cliente negó',
  pg_temp.transferir(:'e2_assignment_id'),
  'RECHAZADO: El cliente no otorgó el bono de este trabajo, pero el pago al trabajador todavía lo incluye ($3.000)%');
select pg_temp.retener(:'e2_assignment_id') is not null as _ \gset
select pg_temp.aprobar_payout(:'e2_assignment_id') as e2_ok \gset
select pg_temp.transferir(:'e2_assignment_id') as e2_t \gset
select pg_temp.expect('B25 al volver a aprobarlo se descuenta, queda en la auditoría y se transfiere sin él',
  :'e2_ok' || ' / '
    || (select count(*)::text from audit_logs where action = 'payout_bonus_removed'
         and entity_id = (select id from payouts where assignment_id = :'e2_assignment_id'))
    || ' / ' || :'e2_t' || ' / ' || pg_temp.payout(:'e2_assignment_id'),
  'APPROVED · bono descontado 3000 / 1 / PAID / PAID 15480');

-- Retenido solo porque una devolución a mitad del trabajo descuadró las
-- cifras: el tiempo adicional devuelto entero ($9.000) más el payout de
-- $26.220 superan los $30.000 cobrados.
select pg_temp.con_tiempo_adicional('b-bono-devolucion', false) as e3 \gset
select pg_temp.devolver(pg_temp.pago(:'e3', 'EXTENSION'), 9000) as e3_dev \gset
select pg_temp.payout(:'e3') as e3_antes \gset
select pg_temp.aprobar_trabajo(:'e3', false) ->> 'payout_status' as e3_aprobado \gset
select pg_temp.expect('B26 retenido por una devolución, el bono negado también sale',
  :'e3_dev' || ' / ' || :'e3_antes' || ' / ' || :'e3_aprobado' || ' / '
    || (select status || ' bono ' || bonus_amount || ' neto ' || net_amount from payouts
         where assignment_id = :'e3'),
  'CONFIRMED / HELD 26220 / HELD / HELD bono 0 neto 23220');

\echo ''
\echo '--- Un payout que no cuadra se ajusta, y solo entonces se aprueba'

select * from pg_temp.listo('b-ajuste') \gset f1_
select pg_temp.devolver(:'f1_payment_id', 5000) as f1_dev \gset
select pg_temp.expect_like('B27 una devolución de $5.000 descuadra y retiene el payout; el motivo dice qué hacer',
  :'f1_dev' || ' / ' || (select status || ': ' || held_reason from payouts where assignment_id = :'f1_assignment_id'),
  'CONFIRMED / HELD: Se devolvieron $5.000 al cliente y las cifras de este trabajo ya no cuadran:%con «Ajustar» en /admin/payouts%');
select pg_temp.expect_like('B28 aprobarlo así, no: antes volvía a APPROVED sin mirar las cifras',
  pg_temp.aprobar_payout(:'f1_assignment_id') || ' / ' || pg_temp.payout(:'f1_assignment_id'),
  'RECHAZADO: Las cifras de este trabajo no cuadran: el cliente pagó $21.000, se le devolvió $5.000 y al trabajador irían $18.480%«Ajustar»% / HELD 18480');

select pg_temp.expect_like('B29 un ajuste solo baja el neto',
  pg_temp.ajustar(:'f1_assignment_id', 19000, 'Subirlo para probar que no se puede.'),
  'RECHAZADO: Un ajuste solo baja el neto: hoy es $18.480 y pediste $19.000%');
select pg_temp.expect_like('B30 necesita un motivo escrito',
  pg_temp.ajustar(:'f1_assignment_id', 16000, 'corto'),
  'RECHAZADO: El ajuste necesita un motivo escrito%');
select pg_temp.expect_like('B31 y solo lo hace la administración',
  pg_temp.ajustar(:'f1_assignment_id', 16000, 'Sin el rol de administración.',
    (select worker_id from assignments where id = :'f1_assignment_id')),
  'RECHAZADO: Solo la administración ajusta un pago al trabajador');

select pg_temp.ajustar(:'f1_assignment_id', 16000,
  'Se le devolvieron $5.000 al cliente por una parte no hecha.') as f1_ajuste \gset
select pg_temp.ajustar(:'f1_assignment_id', 16000,
  'Se le devolvieron $5.000 al cliente por una parte no hecha.') as f1_ajuste2 \gset
select pg_temp.expect('B32 a $16.000 cuadra; sigue retenido; repetirlo no hace nada',
  :'f1_ajuste' || ' / ' || :'f1_ajuste2' || ' / '
    || (select app_private.payout_overrun(:'f1_assignment_id') is null)::text,
  'HELD 16000 / HELD 16000 · repetido / true');
select pg_temp.expect('B33 queda en la auditoría, en la línea de tiempo solo para administración y en un aviso al trabajador',
  (select count(*)::text from audit_logs where action = 'payout_adjusted'
     and entity_id = (select id from payouts where assignment_id = :'f1_assignment_id')
     and (before ->> 'net_amount') = '18480' and (after ->> 'net_amount') = '16000')
  || ' / ' ||
  (select count(*) || ' ' || min(visibility::text) from job_evidence
    where assignment_id = :'f1_assignment_id' and event_key like 'payout_adjusted_%')
  || ' / ' ||
  (select count(*) || ' ' || min(body) from notifications
    where notification_type = 'PAYOUT_ADJUSTED' and href = '/mis-trabajos/' || :'f1_assignment_id'),
  '1 / 1 ADMIN_ONLY / 1 Administración ajustó tu pago de $18.480 a $16.000. Motivo: Se le devolvieron $5.000 al cliente por una parte no hecha.');

select pg_temp.aprobar_payout(:'f1_assignment_id') as f1_ok \gset
select pg_temp.transferir(:'f1_assignment_id') as f1_t \gset
select pg_temp.expect('B34 ajustado, se aprueba y se transfiere',
  :'f1_ok' || ' / ' || :'f1_t' || ' / ' || pg_temp.payout(:'f1_assignment_id'),
  'APPROVED · bono descontado 0 / PAID / PAID 16000');
select pg_temp.expect_like('B35 un payout transferido ya no se ajusta',
  pg_temp.ajustar(:'f1_assignment_id', 1000, 'Después de transferido no se toca.'),
  'RECHAZADO: Un pago al trabajador en estado PAID ya no se ajusta%');

-- El tiempo adicional devuelto entero: al trabajador le queda lo del trabajo.
select pg_temp.con_tiempo_adicional('b-ajuste-ext') as f2 \gset
select pg_temp.devolver(pg_temp.pago(:'f2', 'EXTENSION'), 9000) as f2_dev \gset
select pg_temp.ajustar(:'f2', 18480, 'Se devolvió entero el tiempo adicional no trabajado.') as f2_ajuste \gset
update assignments set dispute_deadline_at = now() - interval '1 minute' where id = :'f2';
select pg_temp.expect('B36 devuelto el tiempo adicional, se ajusta a lo del trabajo y se transfiere',
  :'f2_dev' || ' / ' || :'f2_ajuste' || ' / ' || pg_temp.aprobar_payout(:'f2') || ' / ' || pg_temp.transferir(:'f2'),
  'CONFIRMED / HELD 18480 / APPROVED · bono descontado 0 / PAID');

-- Devolución total fuera de una disputa: se cancela con $0.
select * from pg_temp.listo('b-cancelar') \gset f3_
select pg_temp.devolver(:'f3_payment_id', 21000) as f3_dev \gset
select pg_temp.expect_like('B37 tras una devolución total el motivo dice cómo cancelarlo',
  :'f3_dev' || ' / ' || (select status || ': ' || held_reason from payouts where assignment_id = :'f3_assignment_id'),
  'CONFIRMED / HELD: El cliente recibió la devolución total de este trabajo. Si al trabajador no le corresponde nada, cancela el pago con «Ajustar» en $0%');
select pg_temp.ajustar(:'f3_assignment_id', 0, 'El cliente recibió todo de vuelta: no hubo trabajo.') as f3_ajuste \gset
select pg_temp.expect('B38 con $0 queda cancelado',
  :'f3_ajuste' || ' / ' || pg_temp.payout(:'f3_assignment_id'), 'CANCELLED 0 / CANCELLED 0');

-- Una devolución sin respuesta del banco: no se aprueba hasta saberla.
select * from pg_temp.listo('b-en-vuelo') \gset f4_
select pg_temp.retener(:'f4_assignment_id') is not null as _ \gset
select pg_temp.pedir(:'f4_payment_id', 1000) as f4_r \gset
select pg_temp.expect_like('B39 con una devolución sin respuesta, aprobar se niega',
  pg_temp.aprobar_payout(:'f4_assignment_id'),
  'RECHAZADO: Hay una devolución al cliente sin respuesta del banco%');

-- Con una disputa abierta, que el trabajador no reciba nada lo decide su
-- resolución: cancelar con $0 no.
select * from pg_temp.montar('b-ajuste-disputa') \gset f5_
select pg_temp.reclamar(:'f5_assignment_id') is not null as _ \gset
select pg_temp.expect_like('B40 con una disputa abierta no se cancela con $0',
  pg_temp.ajustar(:'f5_assignment_id', 0, 'Durante la disputa no corresponde.')
    || ' / ' || pg_temp.payout(:'f5_assignment_id'),
  'RECHAZADO: Hay una disputa abierta sobre este trabajo: para que el trabajador no reciba nada, resuélvela a favor del cliente% / HELD 18480');

select pg_temp.expect('B41 ajustar: con sesión (comprueba administración dentro), nunca anon',
  (has_function_privilege('authenticated', 'public.adjust_payout(uuid, bigint, text)', 'execute')
   and not has_function_privilege('anon', 'public.adjust_payout(uuid, bigint, text)', 'execute')
   and not has_function_privilege('authenticated', 'app_private.dispute_refund_allocation(uuid)', 'execute'))::text,
  'true');

-- Dentro de la ventana: una devolución de $3.000 descuadra (excede en $480) y
-- después el cliente reclama. Ninguna resolución que le pague algo al
-- trabajador cuadra —la parcial resta del neto lo mismo que anota como deuda—,
-- así que sin bajar antes el neto la única salida era darle todo al cliente y
-- dejar al trabajador sin sus $18.000.
select * from pg_temp.montar('b-ajuste-en-ventana') \gset f6_
select pg_temp.en_curso(:'f6_assignment_id') is null as _ \gset
select pg_temp.aprobar_trabajo(:'f6_assignment_id', true) is not null as _ \gset
select pg_temp.devolver(:'f6_payment_id', 3000) as f6_dev \gset
select pg_temp.reclamar(:'f6_assignment_id') as f6_reclamo \gset
select pg_temp.resolver(:'f6_assignment_id', 'WORKER_WINS', null) as f6_sin_ajuste \gset
select pg_temp.ajustar(:'f6_assignment_id', 18000,
  'Se le devolvieron $3.000 al cliente; el trabajador recibe lo que queda.') as f6_ajuste \gset
select pg_temp.resolver(:'f6_assignment_id', 'WORKER_WINS', null) as f6_r \gset
select pg_temp.transferir(:'f6_assignment_id') as f6_t \gset
select pg_temp.expect_like('B43 con la disputa abierta se baja el neto, y entonces se resuelve a favor del trabajador y se transfiere',
  :'f6_dev' || ' / ' || :'f6_reclamo' || ' / ' || :'f6_sin_ajuste' || ' / ' || :'f6_ajuste'
    || ' / ' || :'f6_r' || ' / ' || :'f6_t' || ' / ' || pg_temp.payout(:'f6_assignment_id'),
  'CONFIRMED / ABIERTA / RECHAZADO: Esta resolución no cuadra:%baja primero el neto del trabajador con «Ajustar»% / HELD 18000 / APPROVED · 0 / PAID / PAID 18000');

-- Cancelado con el trabajo en curso: al aprobarlo, ni la respuesta ni el aviso
-- dicen que el pago quedó aprobado.
select * from pg_temp.montar('b-cancelado-en-curso') \gset f7_
select pg_temp.en_curso(:'f7_assignment_id') is null as _ \gset
select pg_temp.ajustar(:'f7_assignment_id', 0, 'El cliente pidió terminar antes: no corresponde pago.') as f7_ajuste \gset
select pg_temp.aprobar_trabajo(:'f7_assignment_id', true) ->> 'payout_status' as f7_aprobado \gset
select pg_temp.expect('B44 aprobado con el pago cancelado, la respuesta y el aviso lo dicen',
  :'f7_ajuste' || ' / ' || :'f7_aprobado' || ' / '
    || (select body from notifications
         where user_id = (select worker_id from assignments where id = :'f7_assignment_id')
           and notification_type = 'JOB_APPROVED'
           and href = '/mis-trabajos/' || :'f7_assignment_id'
         order by created_at desc limit 1),
  'CANCELLED 0 / CANCELLED / Este trabajo no tiene pago: administración lo canceló y te avisó el motivo. Ya puedes dejar tu reseña.');

\echo ''
\echo '--- Invariantes'

select pg_temp.expect('B42 ningún invariante del dinero roto en los trabajos de esta batería',
  (select coalesce(string_agg(v.rule, ', '), 'ninguno')
     from (select * from app_private.payment_invariant_violations()
           union all
           select * from app_private.refund_invariant_violations()) v
    where v.entity_id in (
      select a from b_asignaciones
      union all select po.id from payouts po join b_asignaciones c on c.a = po.assignment_id
      union all select p.id from payments p join b_asignaciones c on c.a = p.assignment_id
      union all select r.id from payment_refunds r
                  join payments p on p.id = r.payment_id
                  join b_asignaciones c on c.a = p.assignment_id)),
  'ninguno');
