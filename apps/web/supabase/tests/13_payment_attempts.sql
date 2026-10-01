\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Historial de intentos de pago, cobros duplicados y retornos de otro intento
-- =============================================================================
-- Prefijo N. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Los defectos que cierra esta batería, reproducidos antes de corregirlos:
--
--   · el `commit` de un intento se cortaba en la red, el cliente reintentaba y
--     el token del cobro anterior se sobrescribía: nadie lo volvía a mirar;
--   · si ese cobro anterior aparecía autorizado sobre un pago ya pagado, se
--     registraba como un PAID más y el segundo cobro no quedaba en ninguna
--     parte;
--   · el abandono de una pestaña anterior cerraba el intento VIGENTE, y su
--     aprobación posterior caía en revisión;
--   · una autorización que no cuadraba pasaba por PAID antes de ir a revisión:
--     el trabajo se habilitaba y el trabajador recibía «Ya puedes comenzar».
--
-- Ojo al escribir comprobaciones: una consulta ve los datos como estaban al
-- EMPEZAR la sentencia. Lo que escribe una función dentro de la misma sentencia
-- no lo ve otra subconsulta de esa sentencia. Por eso cada acción va en su
-- propia sentencia (con \gset) y la comprobación en la siguiente.
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

-- Una orden de compra con el formato de la aplicación, nueva cada vez.
create function pg_temp.orden(p_payment uuid)
returns text language sql as $$
  select 'HTF-' || upper(substr(replace(p_payment::text, '-', ''), 1, 12)) || '-'
         || upper(substr(md5(random()::text), 1, 9))
$$;

-- Trabajo con oferta aceptada, pago iniciado y un primer intento en Webpay con
-- su token, tal como lo deja `startCheckout`.
create function pg_temp.montar(
  p_tag text,
  out job_id uuid,
  out assignment_id uuid,
  out payment_id uuid,
  out client_id uuid,
  out worker_id uuid,
  out orden text,
  out token text
)
language plpgsql
as $$
declare
  v_offer uuid;
begin
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
    'Prueba de intentos ' || p_tag,
    'Montaje de la prueba del historial de intentos de pago y de los cobros duplicados.',
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

  orden := pg_temp.orden(payment_id);
  token := 'tok-n-' || p_tag || '-' || substr(md5(random()::text), 1, 12);
  perform public.register_payment_attempt(
    payment_id, 'transbank_webpay_plus', 'integration', orden,
    'S-' || upper(replace(payment_id::text, '-', '')), 'https://hagotufila.cl/pagos/retorno');
  perform public.record_payment_attempt_token(
    payment_id, orden, token, 'https://webpay3gint.transbank.cl/webpayserver/initTransaction');
end;
$$;

-- El cliente vuelve a pagar: intento nuevo, con su orden y su token.
create function pg_temp.reintentar(p_payment uuid, p_tag text, out orden text, out token text)
language plpgsql
as $$
begin
  orden := pg_temp.orden(p_payment);
  token := 'tok-n-' || p_tag || '-' || substr(md5(random()::text), 1, 12);
  perform public.register_payment_attempt(
    p_payment, 'transbank_webpay_plus', 'integration', orden,
    (select session_id from public.payments where id = p_payment),
    'https://hagotufila.cl/pagos/retorno');
  perform public.record_payment_attempt_token(
    p_payment, orden, token, 'https://webpay3gint.transbank.cl/webpayserver/initTransaction');
end;
$$;

-- Lo que hace el retorno con un commit que contestó: la clave es la del token.
create function pg_temp.confirmar(
  p_payment uuid, p_token text, p_result text,
  p_review text default null, p_amount bigint default null
)
returns jsonb language sql as $$
  select public.confirm_payment_result(
    p_payment, 'transbank_webpay_plus', 'commit:' || p_token, p_result, p_amount,
    jsonb_build_object('authorization_code', '123456', 'card_last_digits', '6623'),
    p_token, p_review)
$$;

-- Intenta abrir un intento nuevo y dice qué pasó.
create function pg_temp.intentar_registro(p_payment uuid)
returns text language plpgsql as $$
begin
  perform public.register_payment_attempt(
    p_payment, 'transbank_webpay_plus', 'integration', pg_temp.orden(p_payment),
    (select session_id from public.payments where id = p_payment),
    'https://hagotufila.cl/pagos/retorno');
  return 'ACEPTADO';
exception when check_violation then
  return 'RECHAZADO: ' || sqlerrm;
end $$;

create function pg_temp.estado_intento(p_payment uuid, p_attempt integer)
returns text language sql stable as $$
  select status || coalesce(' · ' || coalesce(review_reason, failure_reason), '')
    from public.payment_attempts where payment_id = p_payment and attempt = p_attempt
$$;

\echo ''
\echo '--- El historial'

select * from pg_temp.montar('n01') \gset n1_

select pg_temp.expect('N01 registrar el intento lo deja en el historial',
  (select count(*) || ' · ' || min(attempt) || ' · ' || min(status)
     from payment_attempts where payment_id = :'n1_payment_id'), '1 · 1 · CREATED');

select pg_temp.expect('N02 el token queda en su intento y, por ser el vigente, en el pago',
  (select (a.provider_token = :'n1_token' and p.provider_token = :'n1_token')::text
     from payment_attempts a join payments p on p.id = a.payment_id
    where a.payment_id = :'n1_payment_id' and a.attempt = 1), 'true');

select * from pg_temp.reintentar(:'n1_payment_id', 'n01b') \gset n1b_

select pg_temp.expect('N03 un reintento no sobrescribe: el pago apunta al nuevo y el anterior conserva su token',
  (select (p.provider_token = :'n1b_token' and p.buy_order = :'n1b_orden' and p.attempt = 2
           and exists (select 1 from payment_attempts a
                        where a.payment_id = p.id and a.attempt = 1 and a.provider_token = :'n1_token'))::text
     from payments p where p.id = :'n1_payment_id'), 'true');

-- Doble clic: el token del intento 2 llega cuando ya se registró el 3.
select * from pg_temp.montar('n04') \gset n4_
select pg_temp.orden(:'n4_payment_id') as n4_orden2 \gset
select public.register_payment_attempt(:'n4_payment_id', 'transbank_webpay_plus', 'integration',
  :'n4_orden2', (select session_id from payments where id = :'n4_payment_id'),
  'https://hagotufila.cl/pagos/retorno') is null as _ \gset
select public.register_payment_attempt(:'n4_payment_id', 'transbank_webpay_plus', 'integration',
  pg_temp.orden(:'n4_payment_id'), (select session_id from payments where id = :'n4_payment_id'),
  'https://hagotufila.cl/pagos/retorno') is null as _ \gset
select public.record_payment_attempt_token(:'n4_payment_id', :'n4_orden2', 'tok-n-n04-tarde',
  'https://webpay3gint.transbank.cl/webpayserver/initTransaction')::text as n4_vigente \gset

select pg_temp.expect('N04 un token que llega tarde queda en su intento y no pisa el pago',
  :'n4_vigente' || ' · ' ||
  coalesce((select provider_token from payments where id = :'n4_payment_id'), 'sin token') || ' · ' ||
  (select provider_token from payment_attempts where buy_order = :'n4_orden2'),
  'false · sin token · tok-n-n04-tarde');

\echo ''
\echo '--- Las guardas del reintento'

-- El commit se pidió y la respuesta se perdió: la marca queda en el intento.
select * from pg_temp.montar('n05') \gset n5_
update payment_attempts set commit_requested_at = now() where provider_token = :'n5_token';

select pg_temp.expect('N05 con un commit pedido y sin resolver no se abre otro intento',
  (pg_temp.intentar_registro(:'n5_payment_id')
     like 'RECHAZADO: Tu pago anterior se está confirmando%')::text,
  'true');
select pg_temp.expect('N06 y el token del cobro posible sigue en el pago',
  (select provider_token from payments where id = :'n5_payment_id'), :'n5_token');

-- Un cobro adicional rechazado: `start_extension_payment` devuelve el pago a
-- PENDING para reintentar. Las marcas de commit del intento fallido no pueden
-- bloquear el reintento para siempre.
select * from pg_temp.montar('n07') \gset n7_
update payment_attempts set commit_requested_at = now(), committed_at = now() where provider_token = :'n7_token';
update payments set committed_at = now() where id = :'n7_payment_id';
select pg_temp.confirmar(:'n7_payment_id', :'n7_token', 'FAILED') is not null as _ \gset
update payments set status = 'PENDING' where id = :'n7_payment_id';
select pg_temp.intentar_registro(:'n7_payment_id') as n7_registro \gset

select pg_temp.expect('N07 tras un intento rechazado se puede reintentar, y el nuevo empieza sin commit',
  :'n7_registro' || ' · ' ||
  (select coalesce(committed_at::text, 'sin commit') || ' · ' || attempt from payments where id = :'n7_payment_id'),
  'ACEPTADO · sin commit · 2');

\echo ''
\echo '--- Cobro duplicado'

-- Intento 1 se queda en una pestaña; el cliente paga con el intento 2; después
-- aparece autorizado también el 1.
select * from pg_temp.montar('n08') \gset n8_
select * from pg_temp.reintentar(:'n8_payment_id', 'n08b') \gset n8b_
select pg_temp.confirmar(:'n8_payment_id', :'n8b_token', 'PAID') ->> 'payment_status' as n8_pagado \gset
select pg_temp.confirmar(:'n8_payment_id', :'n8_token', 'PAID') ->> 'decision' as n8_decision \gset

select pg_temp.expect('N08 el cobro del intento anterior se reconoce como duplicado',
  :'n8_pagado' || ' · ' || :'n8_decision', 'PAID · DOUBLE_CHARGE');
select pg_temp.expect('N09 el trabajo se pagó una vez: pago PAID, un payout, sin retener',
  (select p.status || ' · ' || count(o.id) || ' · ' || min(o.status::text)
     from payments p left join payouts o on o.payment_id = p.id
    where p.id = :'n8_payment_id' group by p.status), 'PAID · 1 · PENDING');
select pg_temp.expect('N10 el intento queda en revisión con un motivo claro',
  pg_temp.estado_intento(:'n8_payment_id', 1), 'DOUBLE_CHARGE · double_charge');
select pg_temp.expect('N11 queda rastro: evento y auditoría',
  (select count(*) from payment_events where payment_id = :'n8_payment_id'
      and payload ->> 'operation' = 'double_charge') || ' · ' ||
  (select count(*) from audit_logs where entity_id = :'n8_payment_id' and action = 'payment_double_charge'),
  '1 · 1');
select pg_temp.expect('N12 se avisa a cada administrador',
  ((select count(*) from notifications
     where notification_type = 'PAYMENT_UNDER_REVIEW' and data ->> 'payment_id' = :'n8_payment_id')
   = (select count(*) from profiles where role = 'ADMIN'))::text, 'true');

select pg_temp.confirmar(:'n8_payment_id', :'n8_token', 'PAID') ->> 'outcome' as n8_repetido \gset
select public.confirm_payment_result(:'n8_payment_id', 'transbank_webpay_plus', 'evt-' || :'n8_token',
  'PAID', null, '{}', :'n8_token') ->> 'outcome' as n8_otra_via \gset

select pg_temp.expect('N13 repetirlo, con la misma clave o por otra vía, no duplica evento ni aviso',
  :'n8_repetido' || ' · ' || :'n8_otra_via' || ' · ' ||
  (select count(*) from payment_events where payment_id = :'n8_payment_id'
      and payload ->> 'operation' = 'double_charge') || ' · ' ||
  ((select count(*) from notifications
     where notification_type = 'PAYMENT_UNDER_REVIEW' and data ->> 'payment_id' = :'n8_payment_id')
   = (select count(*) from profiles where role = 'ADMIN'))::text,
  'duplicate · duplicate · 1 · true');

create function pg_temp.vista_admin(p_payment uuid, p_orden text)
returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.como(pg_temp.admin_id());
  set local role authenticated;
  select attempts_in_review || ' · ' || (coalesce(attempts_review_detail, '') like '%' || p_orden || '%')
    into r from public.admin_payments where payment_id = p_payment;
  reset role;
  perform pg_temp.como(null);
  return r;
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'FALLA: ' || sqlerrm;
end $$;

select pg_temp.expect('N14 administración lo ve en su vista, con la orden de compra que hay que devolver',
  pg_temp.vista_admin(:'n8_payment_id', :'n8_orden'), '1 · true');

\echo ''
\echo '--- El intento anterior que sí paga'

select * from pg_temp.montar('n15') \gset n15_
select * from pg_temp.reintentar(:'n15_payment_id', 'n15b') \gset n15b_
select pg_temp.confirmar(:'n15_payment_id', :'n15_token', 'PAID') is not null as _ \gset

select pg_temp.expect('N15 un intento anterior autorizado paga el pago, y el pago pasa a apuntar a él',
  (select status || ' · ' || (provider_token = :'n15_token') || ' · ' || (buy_order = :'n15_orden')
     from payments where id = :'n15_payment_id'), 'PAID · true · true');

select pg_temp.confirmar(:'n15_payment_id', :'n15b_token', 'PAID') ->> 'decision' as n15_segundo \gset

select pg_temp.expect('N16 si después cobra también el que estaba en curso, ese es el duplicado',
  :'n15_segundo' || ' · ' ||
  pg_temp.estado_intento(:'n15_payment_id', 1) || ' · ' ||
  pg_temp.estado_intento(:'n15_payment_id', 2) || ' · ' ||
  (select count(*) from payouts where payment_id = :'n15_payment_id'),
  'DOUBLE_CHARGE · SETTLED · DOUBLE_CHARGE · double_charge · 1');

\echo ''
\echo '--- Un retorno sin cobro cierra solo su intento'

select * from pg_temp.montar('n17') \gset n17_
select * from pg_temp.reintentar(:'n17_payment_id', 'n17b') \gset n17b_
select public.record_payment_abandonment(:'n17_payment_id', 'transbank_webpay_plus', 'aborted_by_user',
  '{}', :'n17_token') ->> 'outcome' as n17_abandono \gset

select pg_temp.expect('N17 el abandono de la pestaña anterior cierra ese intento, no el pago',
  :'n17_abandono' || ' · ' ||
  (select status from payments where id = :'n17_payment_id') || ' · ' ||
  pg_temp.estado_intento(:'n17_payment_id', 1) || ' · ' ||
  pg_temp.estado_intento(:'n17_payment_id', 2),
  'attempt_only · CREATED · FAILED · aborted_by_user · CREATED');

select pg_temp.confirmar(:'n17_payment_id', :'n17b_token', 'PAID') ->> 'payment_status' as n17_pago \gset

select pg_temp.expect('N18 y el vigente, aprobado después, habilita el trabajo (antes caía en revisión)',
  :'n17_pago' || ' · ' || (select status from jobs where id = :'n17_job_id'),
  'PAID · PAID');

select * from pg_temp.montar('n19') \gset n19_
select * from pg_temp.reintentar(:'n19_payment_id', 'n19b') \gset n19b_
select public.record_payment_abandonment(:'n19_payment_id', 'transbank_webpay_plus', 'form_timeout',
  '{}', null, :'n19_orden') ->> 'outcome' as n19_tiempo \gset

select pg_temp.expect('N19 un tiempo agotado con la orden de compra de un intento anterior, igual',
  :'n19_tiempo' || ' · ' || (select status from payments where id = :'n19_payment_id') || ' · ' ||
  pg_temp.estado_intento(:'n19_payment_id', 1),
  'attempt_only · CREATED · FAILED · form_timeout');

select public.record_payment_abandonment(:'n19_payment_id', 'transbank_webpay_plus', 'aborted_by_user',
  '{}', :'n19b_token') ->> 'outcome' as n19_vigente \gset

select pg_temp.expect('N20 el abandono del intento vigente sigue cerrando el pago',
  :'n19_vigente' || ' · ' || (select status from payments where id = :'n19_payment_id') || ' · ' ||
  pg_temp.estado_intento(:'n19_payment_id', 2),
  'applied · FAILED · FAILED · aborted_by_user');

select * from pg_temp.montar('n21') \gset n21_
select * from pg_temp.reintentar(:'n21_payment_id', 'n21b') \gset n21b_
select public.record_payment_abandonment(:'n21_payment_id', 'transbank_webpay_plus', 'aborted_by_user')
  ->> 'outcome' as n21_legado \gset

select pg_temp.expect('N21 sin identidad (llamadas antiguas) se entiende el intento vigente',
  :'n21_legado' || ' · ' || (select status from payments where id = :'n21_payment_id') || ' · ' ||
  pg_temp.estado_intento(:'n21_payment_id', 2) || ' · ' || pg_temp.estado_intento(:'n21_payment_id', 1),
  'applied · FAILED · FAILED · aborted_by_user · CREATED');

select * from pg_temp.montar('n22') \gset n22_
select public.record_payment_abandonment(:'n22_payment_id', 'transbank_webpay_plus', 'aborted_by_user',
  '{}', :'n8_token') ->> 'outcome' as n22_ajeno \gset

select pg_temp.expect('N22 un token de otro pago no cierra nada',
  :'n22_ajeno' || ' · ' || (select status from payments where id = :'n22_payment_id'),
  'ignored · CREATED');

select * from pg_temp.montar('n23') \gset n23_
select * from pg_temp.reintentar(:'n23_payment_id', 'n23b') \gset n23b_
select pg_temp.confirmar(:'n23_payment_id', :'n23_token', 'FAILED') ->> 'decision' as n23_rechazo \gset

select pg_temp.expect('N23 un intento anterior rechazado en el commit tampoco cierra el pago',
  :'n23_rechazo' || ' · ' || (select status from payments where id = :'n23_payment_id') || ' · ' ||
  pg_temp.estado_intento(:'n23_payment_id', 1),
  'ATTEMPT_FAILED · CREATED · FAILED · rejected_by_issuer');
select pg_temp.expect('N24 y el vigente se paga con normalidad',
  pg_temp.confirmar(:'n23_payment_id', :'n23b_token', 'PAID') ->> 'payment_status', 'PAID');

\echo ''
\echo '--- Autorizado pero no cuadra: revisión sin pasar por PAID'

select * from pg_temp.montar('n25') \gset n25_
select pg_temp.confirmar(:'n25_payment_id', :'n25_token', 'PAID', 'buy_order_mismatch') is not null as _ \gset

select pg_temp.expect('N25 el descuadre deja el pago en revisión con su motivo',
  (select status || ' · ' || review_reason from payments where id = :'n25_payment_id'),
  'UNDER_REVIEW · buy_order_mismatch');
select pg_temp.expect('N26 el trabajo NO se habilitó: trabajo, asignación y payout',
  (select j.status || ' · ' || a.status || ' · ' ||
          (select count(*) from payouts o where o.assignment_id = a.id)
     from assignments a join jobs j on j.id = a.job_id where a.id = :'n25_assignment_id'),
  'PAYMENT_PENDING · AWAITING_PAYMENT · 0');
select pg_temp.expect('N27 ni se le avisó al trabajador, ni el pago pasó nunca por PAID',
  (select count(*) from notifications where user_id = :'n25_worker_id' and job_id = :'n25_job_id'
      and notification_type = 'JOB_PAID') || ' · ' ||
  (select count(*) from payment_events where payment_id = :'n25_payment_id'
      and provider_event_id is null and to_status = 'PAID'),
  '0 · 0');

select * from pg_temp.montar('n28') \gset n28_
select pg_temp.confirmar(:'n28_payment_id', :'n28_token', 'PAID', null, 1) ->> 'review_reason' as n28_motivo \gset

select pg_temp.expect('N28 el descuadre de importe sigue yendo directo a revisión',
  :'n28_motivo' || ' · ' || (select status from jobs where id = :'n28_job_id'),
  'amount_mismatch · PAYMENT_PENDING');

\echo ''
\echo '--- La conciliación de los intentos anteriores'

select * from pg_temp.montar('n29') \gset n29_
select * from pg_temp.reintentar(:'n29_payment_id', 'n29b') \gset n29b_
update payment_attempts set token_at = now() - interval '1 hour', created_at = now() - interval '1 hour'
 where payment_id = :'n29_payment_id';

select pg_temp.expect('N29 la cola trae el intento anterior sin resolver, no el vigente',
  (select string_agg(attempt::text, ',')
     from public.payment_attempts_pending_reconciliation(15, 200, :'n29_payment_id')),
  '1');
select public.record_payment_abandonment(:'n29_payment_id', 'transbank_webpay_plus',
  'reconciled_not_authorized', '{}', :'n29_token') is not null as _ \gset
select pg_temp.expect('N30 resuelto, sale de la cola',
  (select count(*)::text from public.payment_attempts_pending_reconciliation(15, 200, :'n29_payment_id')),
  '0');

-- Un intento anterior que salió de la ventana con su commit pedido, y otro sin
-- ningún indicio de cobro.
select * from pg_temp.montar('n31') \gset n31_
select * from pg_temp.reintentar(:'n31_payment_id', 'n31b') \gset n31b_
update payment_attempts
   set created_at = now() - interval '30 days', commit_requested_at = now() - interval '30 days'
 where provider_token = :'n31_token';
select * from pg_temp.montar('n32') \gset n32_
select * from pg_temp.reintentar(:'n32_payment_id', 'n32b') \gset n32b_
update payment_attempts set created_at = now() - interval '30 days' where provider_token = :'n32_token';

select count(*) >= 0 as _ from public.expire_stale_payments(500) \gset

select pg_temp.expect('N31 fuera de ventana con commit pedido: a revisión, no al olvido',
  pg_temp.estado_intento(:'n31_payment_id', 1) || ' · ' ||
  (select status from payments where id = :'n31_payment_id'),
  'UNDER_REVIEW · reconciliation_window_expired · CREATED');
select pg_temp.expect('N32 fuera de ventana sin indicio de cobro: fallido',
  pg_temp.estado_intento(:'n32_payment_id', 1), 'FAILED · reconciliation_window_expired');
select pg_temp.expect('N33 cada uno con su evento y su auditoría',
  (select count(*) from payment_events where payment_id in (:'n31_payment_id', :'n32_payment_id')
      and payload ->> 'operation' = 'expire_attempt') || ' · ' ||
  (select count(*) from audit_logs where entity_id in (:'n31_payment_id', :'n32_payment_id')
      and action = 'payment_attempt_expired_out_of_window'),
  '2 · 2');
select pg_temp.expect('N34 y el que puede tener dinero aparece en la vista de administración',
  pg_temp.vista_admin(:'n31_payment_id', :'n31_orden'), '1 · true');

-- El intento VIGENTE de un pago que vence: el pago se cierra como siempre (el
-- cliente queda libre para volver a pagar), pero si su commit se pidió y nunca
-- se resolvió, el intento no se da por fallido: va a revisión.
select * from pg_temp.montar('n45') \gset n45_
update payments set created_at = now() - interval '30 days' where id = :'n45_payment_id';
update payment_attempts
   set created_at = now() - interval '30 days', commit_requested_at = now() - interval '30 days'
 where provider_token = :'n45_token';
select * from pg_temp.montar('n46') \gset n46_
update payments set created_at = now() - interval '30 days' where id = :'n46_payment_id';
update payment_attempts set created_at = now() - interval '30 days' where provider_token = :'n46_token';

select count(*) >= 0 as _ from public.expire_stale_payments(500) \gset

select pg_temp.expect('N45 el intento vigente con commit pedido que vence va a revisión; el pago se cierra',
  (select status from payments where id = :'n45_payment_id') || ' · ' ||
  pg_temp.estado_intento(:'n45_payment_id', 1) || ' · ' ||
  pg_temp.vista_admin(:'n45_payment_id', :'n45_orden'),
  'FAILED · UNDER_REVIEW · reconciliation_window_expired · 1 · true');
select pg_temp.expect('N46 sin indicio de cobro, el intento vigente sigue la suerte del pago',
  (select status from payments where id = :'n46_payment_id') || ' · ' ||
  pg_temp.estado_intento(:'n46_payment_id', 1),
  'FAILED · FAILED · reconciliation_window_expired');

-- Si la autorización de ese intento en revisión aparece después, es la
-- respuesta que faltaba: se registra, no se descarta como duplicada.
select pg_temp.confirmar(:'n45_payment_id', :'n45_token', 'PAID') ->> 'outcome' as n47_tardio \gset

select pg_temp.expect('N47 la autorización tardía de un intento en revisión se registra y no habilita nada',
  :'n47_tardio' || ' · ' ||
  (select status || ' · ' || review_reason from payments where id = :'n45_payment_id') || ' · ' ||
  (select status from payment_attempts where provider_token = :'n45_token') || ' · ' ||
  (select status from jobs where id = :'n45_job_id') || ' · ' ||
  (select count(*) from payouts where assignment_id = :'n45_assignment_id'),
  'applied · UNDER_REVIEW · approved_after_failed · SETTLED · PAYMENT_PENDING · 0');

\echo ''
\echo '--- Privilegios'

select pg_temp.expect('N35 nadie con sesión lee el token, la URL ni la sesión de un intento',
  (has_column_privilege('authenticated', 'public.payment_attempts', 'provider_token', 'SELECT')
   or has_column_privilege('authenticated', 'public.payment_attempts', 'redirect_url', 'SELECT')
   or has_column_privilege('authenticated', 'public.payment_attempts', 'return_url', 'SELECT')
   or has_column_privilege('authenticated', 'public.payment_attempts', 'session_id', 'SELECT'))::text,
  'false');
select pg_temp.expect('N36 ni escribe en el historial; anon ni siquiera lo lee',
  (has_table_privilege('authenticated', 'public.payment_attempts', 'INSERT')
   or has_table_privilege('authenticated', 'public.payment_attempts', 'UPDATE')
   or has_table_privilege('authenticated', 'public.payment_attempts', 'DELETE')
   or has_table_privilege('anon', 'public.payment_attempts', 'SELECT')
   or has_any_column_privilege('anon', 'public.payment_attempts', 'SELECT'))::text,
  'false');

create function pg_temp.filas_visibles(p_user uuid, p_payment uuid)
returns text language plpgsql as $$
declare n integer;
begin
  perform pg_temp.como(p_user);
  set local role authenticated;
  select count(*) into n from public.payment_attempts where payment_id = p_payment;
  reset role;
  perform pg_temp.como(null);
  return n::text;
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'FALLA: ' || sqlerrm;
end $$;

select pg_temp.expect('N37 el cliente y el trabajador no ven filas del historial; administración sí',
  pg_temp.filas_visibles(:'n8_client_id', :'n8_payment_id') || ' · ' ||
  pg_temp.filas_visibles(:'n8_worker_id', :'n8_payment_id') || ' · ' ||
  pg_temp.filas_visibles(pg_temp.admin_id(), :'n8_payment_id'),
  '0 · 0 · 2');

select pg_temp.expect('N38 las funciones del historial son solo del servicio',
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), 'ninguna')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('register_payment_attempt', 'record_payment_attempt_token',
                        'payment_attempts_pending_reconciliation', 'confirm_payment_result',
                        'record_payment_abandonment', 'expire_stale_payments')
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))),
  'ninguna');
select pg_temp.expect('N39 no quedan versiones viejas de las funciones que cambiaron de firma',
  (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('confirm_payment_result', 'record_payment_abandonment')),
  '2');

\echo ''
\echo '--- Lo que la base no deja hacer'

create function pg_temp.rechazo(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ACEPTADO';
exception when check_violation then
  return 'RECHAZADO';
end $$;

select pg_temp.expect('N40 un intento en revisión sin motivo no existe',
  pg_temp.rechazo(format(
    'update public.payment_attempts set status = %L, review_reason = null where provider_token = %L',
    'DOUBLE_CHARGE', :'n32b_token')),
  'RECHAZADO');
select pg_temp.expect('N41 el token de otro pago no se asienta sobre este',
  pg_temp.rechazo(format(
    'select public.confirm_payment_result(%L::uuid, %L, %L, %L, null, %L::jsonb, %L)',
    :'n32_payment_id', 'transbank_webpay_plus', 'commit:' || :'n8_token', 'PAID', '{}', :'n8_token')),
  'RECHAZADO');
select pg_temp.expect('N42 ni se ata a un intento de otro pago',
  pg_temp.rechazo(format(
    'select public.record_payment_attempt_token(%L::uuid, %L, %L, %L)',
    :'n32_payment_id', :'n8_orden', 'tok-ajeno', 'https://webpay3gint.transbank.cl/x')),
  'RECHAZADO');

\echo ''
\echo '--- Invariantes'

select pg_temp.expect('N43 todo pago con orden de compra la tiene en su historial',
  (select count(*)::text from payments p join jobs j on j.id = p.job_id
    where j.title like 'Prueba de intentos %' and p.buy_order is not null
      and not exists (select 1 from payment_attempts a
                       where a.payment_id = p.id and a.buy_order = p.buy_order)),
  '0');
select pg_temp.expect('N44 invariantes del dinero en los pagos de esta batería',
  (select count(*)::text from app_private.payment_invariant_violations() v
    where v.entity_id in (select p.id from payments p join jobs j on j.id = p.job_id
                           where j.title like 'Prueba de intentos %')
       or v.entity_id in (select o.id from payouts o
                            join assignments a on a.id = o.assignment_id
                            join jobs j on j.id = a.job_id
                           where j.title like 'Prueba de intentos %')),
  '0');
