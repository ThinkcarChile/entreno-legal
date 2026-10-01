\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Devolver con el trabajador pagado, devolver un cobro duplicado, y la ventana
-- del proveedor contada desde el intento
-- =============================================================================
-- Prefijo J. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Los defectos que cierra esta batería, reproducidos antes de corregirlos:
--
--   · con el payout ya transferido, `request_payment_refund` aceptaba devolver
--     el cobro entero: cliente y trabajador pagados por el mismo trabajo
--     (20260601001400);
--   · una devolución parcial confirmada que dejaba las cifras sin cuadrar no
--     movía el payout: seguía APPROVED en la cola de transferencias (ídem);
--   · un cobro duplicado (DOUBLE_CHARGE) se veía en el panel pero no se podía
--     devolver desde ninguna parte (20260601001420);
--   · `expire_stale_payments` medía la ventana desde la creación del pago y
--     cerraba un intento recién abierto sobre un pago viejo; la cola de
--     conciliación, por la misma fecha, no lo preguntaba (20260601001410).
--
-- El orden de bloqueo de `register_payment_attempt` (también 1410) lo prueba
-- `17_race_attempt_lock.sh` con dos sesiones de verdad.
--
-- Cobro de $21.000 (servicio $18.000 + bono $3.000), comisión del 14 % sobre el
-- servicio ($2.520): al trabajador le corresponden $18.480.
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

-- Trabajos de esta batería: los invariantes del final miran solo estos.
create temp table j_asignaciones (a uuid primary key);

-- Quién trabaja y quién paga. El cliente no es administración: si lo fuera,
-- las comprobaciones de «solo administración» pasarían por el rol.
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
    'Prueba de seguimiento de pagos ' || p_tag,
    'Montaje de la prueba de devoluciones después del payout y de cobros duplicados.',
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

  insert into j_asignaciones values (assignment_id);
end $$;

-- Pago confirmado con el proveedor simulado, en el ambiente que se pida.
create function pg_temp.montar_trabajo(
  p_tag text,
  p_ambiente text,
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
         provider_token = 'tok-' || v_tag, environment = p_ambiente
   where id = payment_id;
  perform public.confirm_payment_result(payment_id, 'mock', 'evt-' || v_tag, 'PAID', null, '{}');
end $$;

create function pg_temp.hasta_aprobado(p_a uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.como((select worker_id from public.assignments where id = p_a));
  perform public.mark_on_the_way(p_a);
  perform public.register_check_in(p_a, true, -33.4265, -70.6153, 20, 'device');
  perform public.start_job_work(p_a);
  perform public.request_job_completion(p_a, 'Listo.');
  perform pg_temp.como((select client_id from public.assignments where id = p_a));
  perform public.approve_job_completion(p_a, true);
  perform pg_temp.como(null);
  update public.assignments set dispute_deadline_at = now() - interval '1 minute' where id = p_a;
end $$;

-- Aprobado por el cliente y con la ventana vencida: el payout queda APPROVED.
create function pg_temp.listo_para_transferir(p_tag text, out assignment_id uuid, out payment_id uuid)
language plpgsql as $$
declare
  m record;
begin
  select * into m from pg_temp.montar_trabajo(p_tag, 'production');
  perform pg_temp.hasta_aprobado(m.assignment_id);
  assignment_id := m.assignment_id;
  payment_id := m.payment_id;
end $$;

-- Trabajo y tiempo adicional cobrados en producción: payout de 18.480 + 7.740.
create function pg_temp.con_tiempo_adicional(p_tag text)
returns uuid language plpgsql as $$
declare
  m record;
  v_ext uuid;
  v_pay uuid;
begin
  select * into m from pg_temp.montar_trabajo(p_tag, 'production');

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
         environment = 'production'
   where id = v_pay;
  perform public.confirm_payment_result(v_pay, 'mock',
    'evt-' || p_tag || '-ext-' || substr(md5(random()::text), 1, 6), 'PAID', 9000, '{}');

  perform pg_temp.como(m.worker_id);
  perform public.request_job_completion(m.assignment_id, 'Listo.');
  perform pg_temp.como(m.client_id);
  perform public.approve_job_completion(m.assignment_id, true);
  perform pg_temp.como(null);
  update public.assignments set dispute_deadline_at = now() - interval '1 minute'
   where id = m.assignment_id;
  return m.assignment_id;
end $$;

create function pg_temp.transferir(p_a uuid)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(pg_temp.admin_id());
  r := public.mark_payout_paid(
    (select id from public.payouts where assignment_id = p_a),
    'TRF-J-' || left(p_a::text, 8), null, null);
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
  v := public.request_payment_refund(p_payment, p_monto, 'Devolución de la batería J.',
    'refund-j-' || substr(md5(random()::text), 1, 12), p_disputa);
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

create function pg_temp.payout(p_a uuid)
returns text language sql stable as $$
  select status::text from public.payouts where assignment_id = p_a
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


\echo ''
\echo '--- Con el trabajador ya pagado, solo se devuelve lo que queda de la plataforma'

select * from pg_temp.listo_para_transferir('j-pagado') \gset a1_
select pg_temp.transferir(:'a1_assignment_id') as a1_transferido \gset
select pg_temp.pedir(:'a1_payment_id', 5000) as a1_r1 \gset

select pg_temp.expect_like('J01 transferido el payout, devolver $5.000 se niega con las cifras y lo que queda',
  :'a1_transferido' || ' / ' || :'a1_r1',
  'PAID / RECHAZADO: Al trabajador ya se le pagaron $18.480 por este trabajo y el cliente pagó $21.000. Solo se pueden devolver $2.520 más, lo que queda de la plataforma (pediste $5.000). Devolver más sería pagar dos veces el mismo trabajo%');
select pg_temp.expect('J02 y no queda ninguna devolución pedida',
  (select count(*)::text from payment_refunds where payment_id = :'a1_payment_id'), '0');

select pg_temp.pedir(:'a1_payment_id', 2520) as a1_r2 \gset
select pg_temp.confirmar_devolucion(:'a1_r2') as a1_r2_estado \gset
select pg_temp.expect('J03 hasta lo que queda de la plataforma, sí: $2.520 devueltos y el payout sigue transferido',
  :'a1_r2_estado' || ' / ' ||
  (select status || ' ' || refunded_amount from payments where id = :'a1_payment_id') || ' / ' ||
  pg_temp.payout(:'a1_assignment_id'),
  'CONFIRMED / PARTIALLY_REFUNDED 2520 / PAID');

select pg_temp.pedir(:'a1_payment_id', 1) as a1_r3 \gset
select pg_temp.expect_like('J04 después, ni un peso más',
  :'a1_r3',
  'RECHAZADO: Al trabajador ya se le pagaron $18.480 por este trabajo y el cliente pagó $21.000; ya se le devolvió o está en devolución $2.520. Ya no queda nada que se pueda devolver sin poner dinero de la plataforma (pediste $1).%');

-- Con tiempo adicional: entraron $30.000 y al trabajador se le pagaron
-- $26.220. Quedan $3.780, se devuelvan del cobro que se devuelvan.
select pg_temp.con_tiempo_adicional('j-ext-pagado') as a2 \gset
select pg_temp.transferir(:'a2') as a2_transferido \gset
select id as a2_ext from payments where assignment_id = :'a2' and purpose = 'EXTENSION' \gset
select id as a2_job from payments where assignment_id = :'a2' and purpose = 'JOB' \gset

select pg_temp.expect_like('J05 sobre el cobro del tiempo adicional cuenta todo lo que entró y salió',
  :'a2_transferido' || ' / ' || pg_temp.pedir(:'a2_ext', 4000),
  'PAID / RECHAZADO: Al trabajador ya se le pagaron $26.220 por este trabajo y el cliente pagó $30.000. Solo se pueden devolver $3.780 más%');

select pg_temp.pedir(:'a2_ext', 3000) as a2_r1 \gset
select pg_temp.expect_like('J06 lo pedido y sin respuesta en un cobro cuenta para el otro',
  pg_temp.pedir(:'a2_job', 1000),
  'RECHAZADO: Al trabajador ya se le pagaron $26.220 por este trabajo y el cliente pagó $30.000; ya se le devolvió o está en devolución $3.000. Solo se pueden devolver $780 más%');

-- Una disputa repartida: $5.000 para el cliente, el trabajador cobra $13.480.
select * from pg_temp.montar_trabajo('j-disputa', 'production') \gset a3_
select pg_temp.reclamar(:'a3_assignment_id') is null as _ \gset
select pg_temp.resolver(:'a3_assignment_id', 'PARTIAL', 5000) as a3_resuelta \gset
select pg_temp.transferir(:'a3_assignment_id') as a3_transferido \gset

select pg_temp.pedir(:'a3_payment_id', 6000) as a3_suelta \gset
select pg_temp.pedir(:'a3_payment_id', 5000,
  (select id from disputes where assignment_id = :'a3_assignment_id')) as a3_ligada \gset

select pg_temp.expect_like('J07 lo que debe la disputa ya cuenta: suelta se niega, ligada a la disputa se devuelve',
  :'a3_resuelta' || ' / ' || :'a3_transferido' || ' / '
    || (:'a3_ligada' not like 'RECHAZADO%')::text || ' / ' || :'a3_suelta',
  'APPROVED / PAID / true / RECHAZADO: Al trabajador ya se le pagaron $13.480 por este trabajo y el cliente pagó $21.000; se le deben $5.000 por una disputa resuelta. Solo se pueden devolver $2.520 más%');


\echo ''
\echo '--- Con el payout sin transferir, una devolución que descuadra lo retiene'

select * from pg_temp.listo_para_transferir('j-aprobado') \gset b1_
select pg_temp.pedir(:'b1_payment_id', 5000) as b1_r \gset

select pg_temp.payout(:'b1_assignment_id') as b1_antes \gset
select pg_temp.confirmar_devolucion(:'b1_r') is not null as _ \gset

select pg_temp.expect_like('J08 con el payout aprobado se acepta y pedirla no retiene; confirmada y sin cuadrar, pasa a HELD con un motivo que se entiende',
  (:'b1_r' not like 'RECHAZADO%')::text || ' / ' || :'b1_antes' || ' / ' ||
  (select status || ': ' || held_reason from payouts where assignment_id = :'b1_assignment_id'),
  'true / APPROVED / HELD: Se devolvieron $5.000 al cliente y las cifras de este trabajo ya no cuadran: el cliente pagó $21.000, se le devolvió $5.000 y al trabajador irían $18.480: suman $23.480, $2.480 más de lo que entró. No se transfiere así%');
select pg_temp.expect('J09 y queda en la auditoría',
  (select count(*)::text from audit_logs
    where action = 'payout_held_refund_overrun'
      and entity_id = (select id from payouts where assignment_id = :'b1_assignment_id')),
  '1');

select pg_temp.transferir(:'b1_assignment_id') as b1_t1 \gset
update payouts set status = 'APPROVED' where assignment_id = :'b1_assignment_id';
select pg_temp.transferir(:'b1_assignment_id') as b1_t2 \gset
update payouts set status = 'HELD' where assignment_id = :'b1_assignment_id';
select pg_temp.expect_like('J10 la transferencia se niega, y aunque llegue aprobado por otra vía, la barrera también',
  :'b1_t1' || ' / ' || :'b1_t2',
  'RECHAZADO: Un pago en estado HELD no se puede transferir todavía / RECHAZADO: Las cifras de este trabajo no cuadran%');

select pg_temp.con_tiempo_adicional('j-ext-retenido') as b2 \gset
select id as b2_ext from payments where assignment_id = :'b2' and purpose = 'EXTENSION' \gset
select pg_temp.pedir(:'b2_ext', 9000) as b2_r \gset
select pg_temp.confirmar_devolucion(:'b2_r') is not null as _ \gset

select pg_temp.expect_like('J11 devolver entero el tiempo adicional, que el payout incluye, también lo retiene',
  (select p.status || ' / ' || o.status || ': ' || o.held_reason
     from payments p join payouts o on o.assignment_id = p.assignment_id where p.id = :'b2_ext'),
  'REFUNDED / HELD: Se devolvieron $9.000 al cliente y las cifras de este trabajo ya no cuadran: el cliente pagó $30.000, se le devolvió $9.000 y al trabajador irían $26.220: suman $35.220, $5.220 más de lo que entró%');

-- Una devolución enviada cuyo resultado no se sabe (UNKNOWN, 20260601000910)
-- es dinero que pudo salir: la barrera de 20260601000800 la cuenta igual que
-- una pedida. Esta comprobación cruza las dos migraciones.
select * from pg_temp.listo_para_transferir('j-desconocida') \gset b3_
select pg_temp.pedir(:'b3_payment_id', 2000) as b3_r \gset
select pg_temp.valor(format('select public.claim_payment_refund(%L)', :'b3_r')) as _ \gset
select pg_temp.valor(format('select public.mark_payment_refund_unknown(%L, %L)', :'b3_r', 'timeout')) as _ \gset

select coalesce((select status::text from payment_refunds where id::text = :'b3_r'), 'sin devolución')
  as b3_estado \gset
select pg_temp.transferir(:'b3_assignment_id') as b3_t1 \gset

create function pg_temp.resolver_pago(p_refund text, p_ok boolean, p_note text)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(pg_temp.admin_id());
  r := public.resolve_unknown_refund(p_refund::uuid, p_ok, null, p_note);
  perform pg_temp.como(null);
  return r ->> 'refund_status';
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

select pg_temp.resolver_pago(:'b3_r', false, 'El portal no muestra ninguna anulación.') as b3_cerrada \gset

select pg_temp.expect_like('J12 una devolución con resultado desconocido frena la transferencia; cerrada como no hecha, se transfiere',
  :'b3_estado' || ' / ' || :'b3_t1' || ' / ' || :'b3_cerrada' || ' / ' || pg_temp.transferir(:'b3_assignment_id'),
  'UNKNOWN / RECHAZADO: Hay una devolución al cliente sin respuesta del banco ($2.000, pedida el % / FAILED / PAID');


\echo ''
\echo '--- La ventana del proveedor corre desde el intento vigente'

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
  token := 'tok-j-' || p_tag || '-' || substr(md5(random()::text), 1, 12);
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
  token := 'tok-j-' || p_tag || '-' || substr(md5(random()::text), 1, 12);
  perform public.register_payment_attempt(
    p_payment, 'transbank_webpay_plus', 'integration', orden,
    (select session_id from public.payments where id = p_payment),
    'https://hagotufila.cl/pagos/retorno');
  perform public.record_payment_attempt_token(
    p_payment, orden, token, 'https://webpay3gint.transbank.cl/webpayserver/initTransaction');
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

-- El pago se creó hace diez días; el cliente vuelve a pagar hace tres —un
-- cobro adicional reintentado, o un cliente que vuelve tarde—. Otro, con el
-- intento también de hace diez días, y uno que nunca tuvo intento (nunca salió
-- hacia el proveedor): esos dos se siguen cerrando como siempre.
select * from pg_temp.montar_intento('j-v1') \gset v1_
update payments set created_at = now() - interval '10 days' where id = :'v1_payment_id';
update payment_attempts set created_at = now() - interval '3 days', token_at = now() - interval '3 days'
 where payment_id = :'v1_payment_id';
select * from pg_temp.montar_intento('j-v2') \gset v2_
update payments set created_at = now() - interval '10 days' where id = :'v2_payment_id';
update payment_attempts set created_at = now() - interval '10 days', token_at = now() - interval '10 days'
 where payment_id = :'v2_payment_id';
select * from pg_temp.publicar('j-v3') \gset v3_
update payments set created_at = now() - interval '10 days' where id = :'v3_payment_id';

select count(*) >= 0 as _ from public.expire_stale_payments(500) \gset

select pg_temp.expect('J13 el intento de hace tres días no se cierra aunque el pago sea de hace diez; los viejos, sí',
  (select p.status || ' ' || a.status from payments p join payment_attempts a on a.buy_order = p.buy_order
    where p.id = :'v1_payment_id') || ' / ' ||
  (select status || ' ' || failure_reason from payments where id = :'v2_payment_id') || ' / ' ||
  (select status || ' ' || failure_reason from payments where id = :'v3_payment_id'),
  'CREATED CREATED / FAILED reconciliation_window_expired / FAILED reconciliation_window_expired');

-- Las otras dos caras de la misma fecha, sobre un pago que no pasó por el
-- cierre de arriba.
select * from pg_temp.montar_intento('j-v4') \gset v4_
update payments set created_at = now() - interval '10 days' where id = :'v4_payment_id';
update payment_attempts set created_at = now() - interval '3 days', token_at = now() - interval '3 days'
 where payment_id = :'v4_payment_id';

select pg_temp.expect('J14 la conciliación lo pregunta',
  (select count(*)::text from public.payments_pending_reconciliation(60, 200) q
    where q.payment_id = :'v4_payment_id'), '1');
select pg_temp.expect('J15 y el invariante de la ventana no lo señala',
  (select count(*)::text from app_private.refund_invariant_violations() v
    where v.rule = 'stale_payment_out_of_window' and v.entity_id = :'v4_payment_id'), '0');


\echo ''
\echo '--- Devolver un cobro duplicado'

create function pg_temp.intento_id(p_token text)
returns uuid language sql stable as $$
  select id from public.payment_attempts where provider_token = p_token
$$;

-- Pide la devolución del cobro de un intento con la identidad indicada.
create function pg_temp.pedir_intento(p_user uuid, p_attempt uuid, p_key text)
returns text language plpgsql as $$
declare
  v uuid;
begin
  perform pg_temp.como(p_user);
  v := public.request_attempt_refund(p_attempt, 'Cobro duplicado de la batería J.', p_key);
  perform pg_temp.como(null);
  return v::text;
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.resolver_intento(p_user uuid, p_refund text, p_ok boolean, p_kind text, p_note text)
returns text language plpgsql as $$
declare
  r jsonb;
begin
  perform pg_temp.como(p_user);
  r := public.resolve_unknown_attempt_refund(p_refund::uuid, p_ok, p_kind, p_note);
  perform pg_temp.como(null);
  return (r ->> 'outcome') || ':' || (r ->> 'refund_status');
exception when others then
  perform pg_temp.como(null);
  return 'RECHAZADO: ' || sqlerrm;
end $$;

-- Lo que ve administración en /admin/pagos, con su sesión.
create function pg_temp.vista_intentos(p_payment uuid)
returns text language plpgsql as $$
declare
  r text;
begin
  perform pg_temp.como(pg_temp.admin_id());
  set local role authenticated;
  select attempts_in_review || ' · ' || coalesce(attempts_review -> 0 ->> 'amount', '-') || ' · '
         || coalesce(attempts_review -> 0 -> 'refund' ->> 'status', 'sin devolución')
    into r from public.admin_payments where payment_id = p_payment;
  reset role;
  perform pg_temp.como(null);
  return r;
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'FALLA: ' || sqlerrm;
end $$;

create function pg_temp.forzar(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ACEPTADO';
exception when others then
  return 'RECHAZADO';
end $$;

-- El cliente paga con el intento 2 y después aparece autorizado el 1, por una
-- vía que no trae el importe.
select * from pg_temp.montar_intento('j-d1') \gset d1_
select * from pg_temp.reintentar(:'d1_payment_id', 'j-d1b') \gset d1b_
select pg_temp.confirmar(:'d1_payment_id', :'d1b_token', 'PAID') as _ \gset
select public.confirm_payment_result(:'d1_payment_id', 'transbank_webpay_plus', 'evt-' || :'d1_token',
  'PAID', null, '{}', :'d1_token') ->> 'decision' as d1_decision \gset
select pg_temp.intento_id(:'d1_token') as d1_intento \gset

select pg_temp.expect('J16 el cobro duplicado queda con su importe aunque la confirmación no lo trajera',
  :'d1_decision' || ' · ' ||
  (select coalesce(provider_amount::text, 'sin importe') from payment_attempts where id = :'d1_intento'),
  'DOUBLE_CHARGE · 21000');
select pg_temp.expect('J17 administración lo ve pendiente, con lo que hay que devolver',
  pg_temp.vista_intentos(:'d1_payment_id'), '1 · 21000 · sin devolución');

select pg_temp.expect_like('J18 alguien sin rol de administración no lo devuelve',
  pg_temp.pedir_intento(:'d1_client_id', :'d1_intento', 'attempt-refund:' || :'run' || ':j22'),
  'RECHAZADO: Solo la administración puede devolver un cobro duplicado%');

select pg_temp.pedir_intento(pg_temp.admin_id(), :'d1_intento', 'attempt-refund:' || :'run' || ':j23') as d1_r \gset
select pg_temp.expect('J19 administración lo pide: queda pedido por el cobro entero, con auditoría',
  (select status || ' · ' || amount || ' · ' || (requested_by = pg_temp.admin_id())
     from payment_attempt_refunds where id::text = :'d1_r') || ' · ' ||
  (select count(*) from audit_logs where action = 'payment_attempt_refund_requested'
      and entity_id = :'d1_payment_id'),
  'REQUESTED · 21000 · true · 1');

select pg_temp.expect('J20 la misma petición dos veces es una sola; otra, mientras sigue en curso, no',
  (pg_temp.pedir_intento(pg_temp.admin_id(), :'d1_intento', 'attempt-refund:' || :'run' || ':j23') = :'d1_r')::text || ' · ' ||
  (select count(*) from payment_attempt_refunds where attempt_id = :'d1_intento') || ' · ' ||
  pg_temp.pedir_intento(pg_temp.admin_id(), :'d1_intento', 'attempt-refund:' || :'run' || ':j24'),
  'true · 1 · RECHAZADO: Hay una devolución de este cobro en curso: espera su resultado antes de pedir otra');

select pg_temp.valor(format('select public.claim_attempt_refund(%L)', :'d1_r')) as d1_claim1 \gset
select pg_temp.valor(format('select public.claim_attempt_refund(%L)', :'d1_r')) as d1_claim2 \gset
select pg_temp.expect('J21 una sola llamada al banco: solo la primera reserva gana',
  :'d1_claim1' || ' · ' || :'d1_claim2', 'true · false');

select pg_temp.valor(format(
  'select public.settle_attempt_refund(%L, true, %L, 21000, %L) ->> %L',
  :'d1_r', 'REVERSED', '{"response_code":0}', 'refund_status')) as d1_cerrada \gset
select pg_temp.expect('J22 confirmada; el pago del trabajo y su payout no se tocan',
  :'d1_cerrada' || ' · ' ||
  (select status || ' ' || refunded_amount from payments where id = :'d1_payment_id') || ' · ' ||
  (select count(*) || ' ' || min(status::text) from payouts where payment_id = :'d1_payment_id') || ' · ' ||
  (select status from payment_attempts where id = :'d1_intento'),
  'CONFIRMED · PAID 0 · 1 PENDING · DOUBLE_CHARGE');
select pg_temp.expect('J23 y en el panel deja de estar pendiente, con la devolución a la vista',
  pg_temp.vista_intentos(:'d1_payment_id'), '0 · 21000 · CONFIRMED');

select pg_temp.expect_like('J24 devuelto, no se pide otra vez; cerrarlo de nuevo no cambia nada',
  pg_temp.pedir_intento(pg_temp.admin_id(), :'d1_intento', 'attempt-refund:' || :'run' || ':j28') || ' · ' ||
  pg_temp.valor(format('select public.settle_attempt_refund(%L, false) ->> %L', :'d1_r', 'outcome')),
  'RECHAZADO: Este cobro ya se devolvió ($21.000 el %): no hay nada más que devolver · duplicate');

select pg_temp.expect('J25 lo confirmado no cambia de estado ni de importe, ni con la clave de servicio',
  pg_temp.forzar(format('update public.payment_attempt_refunds set status = %L where id = %L', 'FAILED', :'d1_r'))
  || ' · ' ||
  pg_temp.forzar(format('update public.payment_attempt_refunds set amount = 1 where id = %L', :'d1_r'))
  || ' · ' ||
  pg_temp.forzar(format('update public.payment_attempt_refunds set attempt_id = %L where id = %L',
    pg_temp.intento_id(:'d1b_token'), :'d1_r')),
  'RECHAZADO · RECHAZADO · RECHAZADO');

-- Rechazada, por confirmar y cerrada a mano.
select * from pg_temp.montar_intento('j-d2') \gset d2_
select * from pg_temp.reintentar(:'d2_payment_id', 'j-d2b') \gset d2b_
select pg_temp.confirmar(:'d2_payment_id', :'d2b_token', 'PAID') as _ \gset
select pg_temp.confirmar(:'d2_payment_id', :'d2_token', 'PAID', 21000) as _ \gset
select pg_temp.intento_id(:'d2_token') as d2_intento \gset

select pg_temp.pedir_intento(pg_temp.admin_id(), :'d2_intento', 'attempt-refund:' || :'run' || ':j30a') as d2_r1 \gset
select pg_temp.valor(format('select public.claim_attempt_refund(%L)', :'d2_r1')) as _ \gset
select pg_temp.valor(format('select public.settle_attempt_refund(%L, false, null, null, %L)',
  :'d2_r1', '{"failure_reason":"provider_http_422"}')) as _ \gset
select pg_temp.pedir_intento(pg_temp.admin_id(), :'d2_intento', 'attempt-refund:' || :'run' || ':j30b') as d2_r2 \gset

select pg_temp.expect('J26 rechazada por el banco: FAILED con su motivo, y se puede volver a pedir',
  (select status || ' ' || failure_reason from payment_attempt_refunds where id = :'d2_r1') || ' · ' ||
  (select status from payment_attempt_refunds where id::text = :'d2_r2'),
  'FAILED provider_http_422 · REQUESTED');

select pg_temp.valor(format('select public.claim_attempt_refund(%L)', :'d2_r2')) as _ \gset
select pg_temp.valor(format('select public.mark_attempt_refund_unknown(%L, %L)', :'d2_r2', 'timeout')) as _ \gset
select pg_temp.expect_like('J27 sin respuesta en firme queda por confirmar y no deja pedir otra',
  (select status || ' ' || unknown_reason from payment_attempt_refunds where id::text = :'d2_r2') || ' · ' ||
  pg_temp.pedir_intento(pg_temp.admin_id(), :'d2_intento', 'attempt-refund:' || :'run' || ':j31'),
  'UNKNOWN timeout · RECHAZADO: Hay una devolución de este cobro con resultado por confirmar%');

select pg_temp.expect('J28 la conciliación la encuentra, con el cobro del intento',
  (select string_agg(q.refund_id::text || ' ' || q.transaction_amount || ' ' || q.refunded_amount, ',')
     from public.attempt_refunds_pending_reconciliation(0, 200, :'d2_payment_id') q),
  :'d2_r2' || ' 21000 0');

select pg_temp.expect_like('J29 cerrarla a mano es de administración y exige una nota',
  pg_temp.resolver_intento(:'d2_client_id', :'d2_r2', true, 'NULLIFIED',
    'El portal muestra la anulación completa.') || ' · ' ||
  pg_temp.resolver_intento(pg_temp.admin_id(), :'d2_r2', true, 'NULLIFIED', 'corta'),
  'RECHAZADO: Solo la administración resuelve una devolución por confirmar · RECHAZADO: Escribe lo que muestra el portal de Transbank%');

select pg_temp.resolver_intento(pg_temp.admin_id(), :'d2_r2', true, 'NULLIFIED',
  'El portal muestra la anulación completa del 01-10.') as d2_manual \gset
select pg_temp.expect('J30 con la nota, confirmada: quién, qué vio, y en la auditoría',
  :'d2_manual' || ' · ' ||
  (select (resolved_by = pg_temp.admin_id()) || ' ' || resolution_note
     from payment_attempt_refunds where id::text = :'d2_r2') || ' · ' ||
  (select count(*) from audit_logs where action = 'payment_attempt_refund_resolved_manually'
      and entity_id = :'d2_payment_id') || ' · ' ||
  pg_temp.vista_intentos(:'d2_payment_id'),
  'applied:CONFIRMED · true El portal muestra la anulación completa del 01-10. · 1 · 0 · 21000 · CONFIRMED');


\echo ''
\echo '--- Lo que no se devuelve por aquí'

select pg_temp.expect_like('J31 el intento que pagó el trabajo se devuelve por el pago, no por aquí',
  pg_temp.pedir_intento(pg_temp.admin_id(), pg_temp.intento_id(:'d2b_token'), 'attempt-refund:' || :'run' || ':j35'),
  'RECHAZADO: Este intento está en SETTLED: aquí solo se devuelve un cobro duplicado o un intento en revisión%');

-- El intento vigente de un pago AUTHORIZED que vence: pago e intento a
-- revisión. Ese cobro es el del pago, y el pago se puede devolver.
select * from pg_temp.montar_intento('j-d3') \gset d3_
update payments set status = 'AUTHORIZED' where id = :'d3_payment_id';
update payments set created_at = now() - interval '10 days' where id = :'d3_payment_id';
update payment_attempts set created_at = now() - interval '10 days', token_at = now() - interval '10 days'
 where payment_id = :'d3_payment_id';
select count(*) >= 0 as _ from public.expire_stale_payments(500) \gset

select pg_temp.expect_like('J32 tampoco el intento vigente de un pago en revisión: ese cobro es el del pago, y el panel lo sabe',
  (select p.status || ' ' || a.status from payments p join payment_attempts a on a.buy_order = p.buy_order
    where p.id = :'d3_payment_id') || ' · ' ||
  (select attempts_review -> 0 ->> 'backs_payment' from admin_payments where payment_id = :'d3_payment_id')
  || ' · ' ||
  pg_temp.pedir_intento(pg_temp.admin_id(), pg_temp.intento_id(:'d3_token'), 'attempt-refund:' || :'run' || ':j36'),
  'UNDER_REVIEW UNDER_REVIEW · true · RECHAZADO: Este intento es el que respalda el pago del trabajo%');

-- Un intento anterior que salió de la ventana con su commit pedido: a
-- revisión, con indicios de cobro, sin ser el del pago.
select * from pg_temp.montar_intento('j-d4') \gset d4_
select * from pg_temp.reintentar(:'d4_payment_id', 'j-d4b') \gset d4b_
update payment_attempts
   set created_at = now() - interval '30 days', commit_requested_at = now() - interval '30 days'
 where provider_token = :'d4_token';
select count(*) >= 0 as _ from public.expire_stale_payments(500) \gset
select pg_temp.pedir_intento(pg_temp.admin_id(), pg_temp.intento_id(:'d4_token'), 'attempt-refund:' || :'run' || ':j37') as d4_r \gset

select pg_temp.expect('J33 un intento anterior en revisión con indicios de cobro sí, por el importe del pago',
  (select a.status || ' · ' || r.status || ' · ' || r.amount
     from payment_attempt_refunds r join payment_attempts a on a.id = r.attempt_id
    where r.id::text = :'d4_r'),
  'UNDER_REVIEW · REQUESTED · 21000');

select pg_temp.confirmar(:'d4_payment_id', :'d4_token', 'PAID') as d4_tardio \gset
select pg_temp.expect_like('J34 y si su autorización llega tarde, no se asienta como pago de un cobro que se está devolviendo',
  (select status from payments where id = :'d4_payment_id') || ' · ' ||
  (select status from payment_attempts where provider_token = :'d4_token') || ' · ' || :'d4_tardio',
  'CREATED · UNDER_REVIEW · RECHAZADO: El cobro del intento 1 (orden %) ya se devolvió al cliente o se está devolviendo%');


\echo ''
\echo '--- Privilegios'

select pg_temp.expect('J35 reservar, cerrar, dejar por confirmar y la cola son solo del servicio',
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'ninguna')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('claim_attempt_refund', 'settle_attempt_refund',
                        'mark_attempt_refund_unknown', 'attempt_refunds_pending_reconciliation')
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute')
           or not has_function_privilege('service_role', p.oid, 'execute'))),
  'ninguna');
select pg_temp.expect('J36 pedir y resolver a mano: con sesión (comprueban administración dentro), nunca anon',
  (has_function_privilege('authenticated', 'public.request_attempt_refund(uuid, text, text)', 'execute')
   and has_function_privilege('authenticated', 'public.resolve_unknown_attempt_refund(uuid, boolean, text, text)', 'execute')
   and not has_function_privilege('anon', 'public.request_attempt_refund(uuid, text, text)', 'execute')
   and not has_function_privilege('anon', 'public.resolve_unknown_attempt_refund(uuid, boolean, text, text)', 'execute'))::text,
  'true');
select pg_temp.expect('J37 nadie con sesión escribe las devoluciones de un intento; anon ni las lee',
  (has_table_privilege('authenticated', 'public.payment_attempt_refunds', 'INSERT')
   or has_table_privilege('authenticated', 'public.payment_attempt_refunds', 'UPDATE')
   or has_table_privilege('authenticated', 'public.payment_attempt_refunds', 'DELETE')
   or has_table_privilege('anon', 'public.payment_attempt_refunds', 'SELECT'))::text,
  'false');

create function pg_temp.filas_visibles(p_user uuid, p_payment uuid)
returns text language plpgsql as $$
declare n integer;
begin
  perform pg_temp.como(p_user);
  set local role authenticated;
  select count(*) into n from public.payment_attempt_refunds where payment_id = p_payment;
  reset role;
  perform pg_temp.como(null);
  return n::text;
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'FALLA: ' || sqlerrm;
end $$;

select pg_temp.expect('J38 el cliente y el trabajador no ven las filas; administración sí',
  pg_temp.filas_visibles(:'d2_client_id', :'d2_payment_id') || ' · ' ||
  pg_temp.filas_visibles(:'d2_worker_id', :'d2_payment_id') || ' · ' ||
  pg_temp.filas_visibles(pg_temp.admin_id(), :'d2_payment_id'),
  '0 · 0 · 2');


\echo ''
\echo '--- Invariantes'

-- Una devolución de intento escrita a mano sobre el cobro que pagó el trabajo:
-- el invariante nuevo la señala.
insert into payment_attempt_refunds (attempt_id, payment_id, amount, reason, status, provider,
  environment, provider_event_id, requested_by)
values (pg_temp.intento_id(:'d1b_token'), :'d1_payment_id', 21000, 'Escrita a mano en la prueba J39.',
  'REQUESTED', 'transbank_webpay_plus', 'integration', 'attempt-refund:' || :'run' || ':j39', pg_temp.admin_id());
select pg_temp.expect('J39 una devolución de intento sobre el dinero del pago se señala',
  (select string_agg(v.rule, ', ') from app_private.refund_invariant_violations() v
    where v.entity_id = (select id from payment_attempt_refunds where provider_event_id = 'attempt-refund:' || :'run' || ':j39')),
  'attempt_refund_on_payment_money');
delete from payment_attempt_refunds where provider_event_id = 'attempt-refund:' || :'run' || ':j39';

select pg_temp.expect('J40 ningún invariante del dinero roto en los trabajos de esta batería',
  (select coalesce(string_agg(v.rule, ', '), 'ninguno')
     from (select * from app_private.payment_invariant_violations()
           union all
           select * from app_private.refund_invariant_violations()) v
    where v.entity_id in (
      select a from j_asignaciones
      union all select po.id from payouts po join j_asignaciones c on c.a = po.assignment_id
      union all select p.id from payments p join j_asignaciones c on c.a = p.assignment_id
      union all select r.id from payment_attempt_refunds r
                  join payments p on p.id = r.payment_id
                  join j_asignaciones c on c.a = p.assignment_id)),
  'ninguno');
