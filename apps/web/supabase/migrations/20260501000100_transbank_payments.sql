-- =============================================================================
-- HagoTuFila · Bloque 5 · 100 · Webpay Plus: persistencia, retorno y devolución
-- =============================================================================
-- El asentamiento del dinero NO cambia. `confirm_payment_result` sigue siendo
-- la única vía por la que un resultado del proveedor llega a `payments`, sigue
-- siendo idempotente por (provider, provider_event_id) y sigue corriendo bajo
-- los tres bloqueos en el orden jobs → assignments → payments. Todo lo de
-- a30f290 queda intacto.
--
-- Lo que añade esta migración:
--
--   1. Las columnas que hacen falta para conciliar una transacción de Webpay:
--      ambiente, orden de compra, sesión, estado del proveedor, código de
--      respuesta, fechas contables y el motivo del fallo.
--   2. `buy_order` único: es el identificador que vuelve del navegador cuando
--      NO llega token, y con él se reencuentra el intento.
--   3. `payment_refunds`: las devoluciones, que hasta ahora no existían como
--      hecho propio.
--   4. Las RPC que registran intento, fallo de retorno y devolución.
--
-- Nada de esto puede escribirlo un usuario. Todas las funciones nuevas son
-- SECURITY DEFINER con `search_path` fijo, sin EXECUTE para public ni anon, y
-- con la comprobación de propiedad o de administración dentro.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Columnas del intento en el proveedor
-- -----------------------------------------------------------------------------
alter table public.payments
  add column if not exists environment         text,
  add column if not exists buy_order           text,
  add column if not exists session_id          text,
  add column if not exists return_url          text,
  add column if not exists redirect_url        text,
  add column if not exists provider_status     text,
  add column if not exists response_code       integer,
  add column if not exists vci                 text,
  add column if not exists transaction_date    timestamptz,
  add column if not exists accounting_date     text,
  add column if not exists installments_amount bigint,
  add column if not exists attempt             integer not null default 0,
  add column if not exists failure_reason      text,
  add column if not exists committed_at        timestamptz,
  add column if not exists reconciled_at       timestamptz;

comment on column public.payments.environment is
  'Ambiente del proveedor que originó el intento: integration o production. Un pago de integración no se concilia jamás contra producción.';
comment on column public.payments.buy_order is
  'Orden de compra enviada a Webpay. Vuelve como TBK_ORDEN_COMPRA cuando el retorno no trae token.';
comment on column public.payments.session_id is
  'Identificador interno del intento enviado como session_id. Vuelve como TBK_ID_SESION. Sin datos personales.';
comment on column public.payments.redirect_url is
  'URL del formulario de Webpay devuelta al crear la transacción, ya validada contra el dominio del ambiente. La usa la página de transición.';
comment on column public.payments.provider_status is
  'El campo status tal cual lo devolvió el proveedor (AUTHORIZED, FAILED, INITIALIZED…). No es el estado interno.';
comment on column public.payments.response_code is
  'response_code del proveedor. Solo 0 junto a status = AUTHORIZED significa autorizado.';
comment on column public.payments.vci is
  'Resultado de la autenticación 3-D Secure. Se guarda para auditoría; NUNCA decide una aprobación.';
comment on column public.payments.attempt is
  'Cuántas veces se ha creado una transacción en el proveedor para este pago. Cada intento lleva su propio buy_order.';
comment on column public.payments.failure_reason is
  'Por qué falló: aborted_by_user, form_timeout, rejected_by_issuer, return_conflict, provider_error…';
comment on column public.payments.committed_at is
  'Cuándo se ejecutó el commit contra el proveedor.';
comment on column public.payments.reconciled_at is
  'Última vez que este pago se contrastó con el proveedor mediante status().';

-- El buy_order identifica el intento y no se repite. Es lo que permite
-- resolver un retorno sin token, y lo que impide que dos pagos distintos
-- acaben apuntando a la misma transacción del banco.
create unique index if not exists payments_buy_order_idx
  on public.payments (buy_order)
  where buy_order is not null;

create unique index if not exists payments_session_idx
  on public.payments (session_id)
  where session_id is not null;

create index if not exists payments_reconcile_idx
  on public.payments (status, created_at)
  where status in ('PENDING', 'CREATED', 'AUTHORIZED', 'UNDER_REVIEW');


-- -----------------------------------------------------------------------------
-- 2. Devoluciones
-- -----------------------------------------------------------------------------
create table if not exists public.payment_refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references public.payments (id) on delete restrict,
  dispute_id         uuid references public.disputes (id) on delete restrict,

  amount             bigint not null check (amount > 0),
  currency           char(3) not null default 'CLP',
  reason             text not null check (length(btrim(reason)) between 10 and 1000),

  status             public.refund_status not null default 'REQUESTED',
  kind               public.refund_kind,

  -- Respuesta del proveedor. `authorization_code` y `authorization_date` solo
  -- existen en una anulación; una reversa no genera autorización nueva.
  provider           text not null,
  environment        text not null,
  provider_event_id  text not null,
  authorization_code text,
  authorization_date timestamptz,
  nullified_amount   bigint,
  balance            bigint,
  response_code      integer,
  payload            jsonb not null default '{}'::jsonb,

  requested_by       uuid not null references public.profiles (id) on delete restrict,
  requested_at       timestamptz not null default now(),
  settled_at         timestamptz,
  failure_reason     text,

  constraint payment_refunds_settled_has_kind
    check (status <> 'CONFIRMED' or kind is not null)
);

comment on table public.payment_refunds is
  'Devoluciones pedidas al proveedor. Una fila por intento. CONFIRMED solo con respuesta exitosa; pedirla no devuelve nada.';

-- Idempotencia: el mismo intento de devolución repetido no crea una segunda.
create unique index if not exists payment_refunds_event_idx
  on public.payment_refunds (provider, provider_event_id);

create index if not exists payment_refunds_payment_idx
  on public.payment_refunds (payment_id, requested_at desc);

alter table public.payment_refunds enable row level security;

-- Solo administración lee las devoluciones. El cliente ve el efecto en su pago
-- —cuánto se le devolvió— no el detalle de la operación con el banco.
drop policy if exists payment_refunds_admin_read on public.payment_refunds;
create policy payment_refunds_admin_read on public.payment_refunds
  for select using (app_private.is_admin());

-- Ningún usuario escribe aquí, ni siquiera administración: se escribe por RPC
-- con la clave de servicio.
revoke insert, update, delete, truncate on public.payment_refunds from authenticated;
revoke all on public.payment_refunds from anon;
grant select on public.payment_refunds to authenticated;


-- -----------------------------------------------------------------------------
-- 3. Registrar el intento en el proveedor
-- -----------------------------------------------------------------------------
-- Se llama JUSTO ANTES de salir hacia Webpay, con el buy_order y el session_id
-- ya construidos. Que queden persistidos antes de la redirección no es un
-- detalle: si la respuesta de Transbank se pierde por la red, la transacción
-- puede existir igual en su lado, y esto es lo único que permite encontrarla.
create or replace function public.register_payment_attempt(
  p_payment_id  uuid,
  p_provider    text,
  p_environment text,
  p_buy_order   text,
  p_session_id  text,
  p_return_url  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  if v_payment.status not in ('PENDING', 'CREATED') then
    raise exception 'El pago está en % y no admite un intento nuevo', v_payment.status
      using errcode = 'check_violation';
  end if;

  if p_environment not in ('integration', 'production', 'mock') then
    raise exception 'Ambiente de proveedor no reconocido: %', p_environment
      using errcode = 'invalid_parameter_value';
  end if;

  -- Un pago de integración y uno de producción no se mezclan nunca. Si el
  -- ambiente cambió a mitad de un intento vivo, eso es un error de
  -- configuración y no se resuelve en silencio.
  if v_payment.environment is not null and v_payment.environment <> p_environment then
    raise exception 'El pago se creó en el ambiente % y ahora se intenta en %',
      v_payment.environment, p_environment
      using errcode = 'check_violation';
  end if;

  update public.payments
     set provider      = p_provider,
         environment   = p_environment,
         buy_order     = p_buy_order,
         session_id    = coalesce(session_id, p_session_id),
         return_url    = p_return_url,
         attempt       = attempt + 1,
         status        = 'CREATED',
         updated_at    = now()
   where id = p_payment_id;

  insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
  values (
    p_payment_id, v_payment.status, 'CREATED', p_provider,
    jsonb_build_object(
      'operation', 'create',
      'environment', p_environment,
      'buy_order', p_buy_order,
      'attempt', v_payment.attempt + 1
    )
  );
end;
$$;

revoke execute on function public.register_payment_attempt(uuid, text, text, text, text, text) from public;
revoke execute on function public.register_payment_attempt(uuid, text, text, text, text, text) from anon;
revoke execute on function public.register_payment_attempt(uuid, text, text, text, text, text) from authenticated;
grant execute on function public.register_payment_attempt(uuid, text, text, text, text, text) to service_role;

comment on function public.register_payment_attempt is
  'Deja constancia del intento antes de redirigir a Webpay. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 4. Guardar la foto del proveedor sin decidir nada
-- -----------------------------------------------------------------------------
-- Separada de `confirm_payment_result` a propósito: esto solo anota qué dijo
-- el proveedor —estado, código, fechas, cuotas—. Quién habilita el trabajo o
-- quién crea el pago al trabajador lo sigue decidiendo la otra, bajo bloqueos.
create or replace function public.record_provider_snapshot(
  p_payment_id uuid,
  p_provider   text,
  p_snapshot   jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payments
     set provider_status     = coalesce(p_snapshot ->> 'provider_status', provider_status),
         response_code       = coalesce((p_snapshot ->> 'response_code')::integer, response_code),
         vci                 = coalesce(p_snapshot ->> 'vci', vci),
         accounting_date     = coalesce(p_snapshot ->> 'accounting_date', accounting_date),
         transaction_date    = coalesce(
                                 (p_snapshot ->> 'transaction_date')::timestamptz,
                                 transaction_date
                               ),
         installments        = coalesce((p_snapshot ->> 'installments_number')::smallint, installments),
         installments_amount = coalesce((p_snapshot ->> 'installments_amount')::bigint, installments_amount),
         card_last_digits    = coalesce(p_snapshot ->> 'card_last_digits', card_last_digits),
         payment_type_code   = coalesce(p_snapshot ->> 'payment_type_code', payment_type_code),
         authorization_code  = coalesce(p_snapshot ->> 'authorization_code', authorization_code),
         reconciled_at       = now(),
         updated_at          = now()
   where id = p_payment_id and provider = p_provider;
end;
$$;

revoke execute on function public.record_provider_snapshot(uuid, text, jsonb) from public;
revoke execute on function public.record_provider_snapshot(uuid, text, jsonb) from anon;
revoke execute on function public.record_provider_snapshot(uuid, text, jsonb) from authenticated;
grant execute on function public.record_provider_snapshot(uuid, text, jsonb) to service_role;


-- -----------------------------------------------------------------------------
-- 5. Retorno sin cobro: abandono, tiempo agotado, conflicto
-- -----------------------------------------------------------------------------
-- Tres de los cuatro flujos de retorno terminan sin dinero. Esta función los
-- registra SIN tocar el trabajo ni crear nada, y deja el pago listo para
-- reintentar: el cliente vuelve a la pantalla de pago y puede pagar otra vez.
--
-- Deliberadamente NO marca FAILED un pago que el proveedor podría haber
-- autorizado: si el pago ya estaba AUTHORIZED o PAID, esto no lo toca. Un
-- retorno abortado que llega tarde sobre un pago ya cobrado no borra el cobro.
create or replace function public.record_payment_abandonment(
  p_payment_id     uuid,
  p_provider       text,
  p_failure_reason text,
  p_details        jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
  v_assignment_id uuid;
  v_payment public.payments;
begin
  select job_id, assignment_id into v_job_id, v_assignment_id
    from public.payments where id = p_payment_id;
  if v_job_id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  perform 1 from public.jobs where id = v_job_id for update;
  if v_assignment_id is not null then
    perform 1 from public.assignments where id = v_assignment_id for update;
  end if;
  select * into v_payment from public.payments where id = p_payment_id for update;

  -- Un pago que ya se resolvió con dinero de por medio no se «abandona».
  if v_payment.status in ('PAID', 'AUTHORIZED', 'UNDER_REVIEW', 'REFUNDED', 'PARTIALLY_REFUNDED') then
    return jsonb_build_object(
      'outcome', 'ignored',
      'payment_status', v_payment.status,
      'reason', 'el pago ya tiene un resultado financiero'
    );
  end if;

  update public.payments
     set status         = 'FAILED',
         failure_reason = p_failure_reason,
         failed_at      = coalesce(failed_at, now()),
         updated_at     = now()
   where id = p_payment_id;

  insert into public.payment_events (payment_id, from_status, to_status, provider, payload)
  values (
    p_payment_id, v_payment.status, 'FAILED', p_provider,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
      'operation', 'return',
      'failure_reason', p_failure_reason
    )
  );

  return jsonb_build_object(
    'outcome', 'applied',
    'payment_status', 'FAILED',
    'failure_reason', p_failure_reason
  );
end;
$$;

revoke execute on function public.record_payment_abandonment(uuid, text, text, jsonb) from public;
revoke execute on function public.record_payment_abandonment(uuid, text, text, jsonb) from anon;
revoke execute on function public.record_payment_abandonment(uuid, text, text, jsonb) from authenticated;
grant execute on function public.record_payment_abandonment(uuid, text, text, jsonb) to service_role;

comment on function public.record_payment_abandonment is
  'Registra un retorno sin cobro (abandono, timeout, conflicto). Nunca toca un pago que ya tiene resultado financiero.';


-- -----------------------------------------------------------------------------
-- 6. Devolución: pedirla y confirmarla, en dos pasos
-- -----------------------------------------------------------------------------
-- Son dos funciones y no una porque entre ellas hay una llamada a un banco que
-- puede tardar, fallar o no contestar. Si fueran una sola, la transacción de
-- base se quedaría abierta durante esa llamada, bloqueando el pago.
--
-- El contrato entre las dos: `request_payment_refund` deja una fila REQUESTED
-- con su clave de idempotencia; `settle_payment_refund` la cierra con lo que
-- dijo el proveedor. Si nadie la cierra, queda pedida y sin efecto contable,
-- que es exactamente lo que debe ocurrir cuando no se sabe qué pasó.
create or replace function public.request_payment_refund(
  p_payment_id       uuid,
  p_amount           bigint,
  p_reason           text,
  p_provider_event_id text,
  p_dispute_id       uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_dispute public.disputes;
  v_already bigint;
  v_refund_id uuid;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración puede iniciar una devolución'
      using errcode = 'insufficient_privilege';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El importe a devolver debe ser positivo'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'Escribe el motivo de la devolución (al menos 10 caracteres)'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  -- Solo se devuelve dinero que se cobró. `UNDER_REVIEW` entra porque es
  -- justamente el estado de «se cobró y no debía»: una confirmación tardía
  -- sobre un trabajo cancelado.
  if v_payment.status not in ('PAID', 'UNDER_REVIEW', 'PARTIALLY_REFUNDED') then
    raise exception 'El pago está en % y no admite devolución', v_payment.status
      using errcode = 'check_violation';
  end if;

  if v_payment.provider_token is null then
    raise exception 'El pago no tiene token del proveedor: no se puede devolver'
      using errcode = 'check_violation';
  end if;

  -- Lo ya devuelto y confirmado, más lo pedido y todavía sin respuesta: no se
  -- puede comprometer más dinero del que entró.
  select coalesce(sum(amount), 0) into v_already
    from public.payment_refunds
   where payment_id = p_payment_id and status in ('REQUESTED', 'CONFIRMED');

  if v_already + p_amount > v_payment.amount then
    raise exception 'La devolución excede el saldo: cobrado %, comprometido %, pedido %',
      v_payment.amount, v_already, p_amount
      using errcode = 'check_violation';
  end if;

  -- Cuando la devolución nace de una disputa, la disputa tiene que estar
  -- resuelta: no se devuelve dinero mientras se está decidiendo.
  if p_dispute_id is not null then
    select * into v_dispute from public.disputes where id = p_dispute_id;
    if v_dispute.id is null then
      raise exception 'La disputa no existe' using errcode = 'no_data_found';
    end if;
    if v_dispute.status <> 'RESOLVED' then
      raise exception 'La disputa está en % y no permite devolver todavía', v_dispute.status
        using errcode = 'check_violation';
    end if;
  end if;

  -- Idempotencia: el mismo intento repetido devuelve la misma fila.
  select id into v_refund_id
    from public.payment_refunds
   where provider = v_payment.provider and provider_event_id = p_provider_event_id;
  if v_refund_id is not null then
    return v_refund_id;
  end if;

  insert into public.payment_refunds (
    payment_id, dispute_id, amount, currency, reason, status,
    provider, environment, provider_event_id, requested_by
  ) values (
    p_payment_id, p_dispute_id, p_amount, v_payment.currency, btrim(p_reason), 'REQUESTED',
    v_payment.provider, coalesce(v_payment.environment, 'mock'), p_provider_event_id, auth.uid()
  )
  returning id into v_refund_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (auth.uid(), 'payment_refund_requested', 'payments', p_payment_id,
          jsonb_build_object('refund_id', v_refund_id, 'amount', p_amount,
                             'dispute_id', p_dispute_id, 'reason', btrim(p_reason)));

  return v_refund_id;
end;
$$;

revoke execute on function public.request_payment_refund(uuid, bigint, text, text, uuid) from public;
revoke execute on function public.request_payment_refund(uuid, bigint, text, text, uuid) from anon;
grant execute on function public.request_payment_refund(uuid, bigint, text, text, uuid) to authenticated;

comment on function public.request_payment_refund is
  'Deja pedida una devolución. Solo administración. No devuelve dinero: eso lo hace el proveedor y lo cierra settle_payment_refund.';


-- Cierra la devolución con lo que contestó el proveedor.
create or replace function public.settle_payment_refund(
  p_refund_id uuid,
  p_confirmed boolean,
  p_kind      text default null,
  p_refunded  bigint default null,
  p_details   jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund public.payment_refunds;
  v_payment public.payments;
  v_confirmed bigint;
  v_next public.payment_status;
begin
  select * into v_refund from public.payment_refunds where id = p_refund_id for update;
  if v_refund.id is null then
    raise exception 'La devolución no existe' using errcode = 'no_data_found';
  end if;

  -- Idempotente: cerrar dos veces la misma devolución no suma dos veces.
  if v_refund.status <> 'REQUESTED' then
    return jsonb_build_object(
      'outcome', 'duplicate',
      'refund_status', v_refund.status,
      'payment_status', (select status from public.payments where id = v_refund.payment_id)
    );
  end if;

  select * into v_payment from public.payments where id = v_refund.payment_id for update;

  if not p_confirmed then
    update public.payment_refunds
       set status         = 'FAILED',
           settled_at     = now(),
           failure_reason = coalesce(p_details ->> 'failure_reason', 'provider_rejected'),
           response_code  = (p_details ->> 'response_code')::integer,
           payload        = coalesce(p_details, '{}'::jsonb)
     where id = p_refund_id;

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
    values (v_refund.requested_by, 'payment_refund_failed', 'payments', v_refund.payment_id,
            jsonb_build_object('refund_id', p_refund_id));

    return jsonb_build_object(
      'outcome', 'applied',
      'refund_status', 'FAILED',
      'payment_status', v_payment.status
    );
  end if;

  if p_kind is null or p_kind not in ('REVERSED', 'NULLIFIED') then
    raise exception 'Una devolución confirmada tiene que decir si fue reversa o anulación'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.payment_refunds
     set status             = 'CONFIRMED',
         kind               = p_kind::public.refund_kind,
         settled_at         = now(),
         authorization_code = p_details ->> 'authorization_code',
         authorization_date = (p_details ->> 'authorization_date')::timestamptz,
         nullified_amount   = (p_details ->> 'nullified_amount')::bigint,
         balance            = (p_details ->> 'balance')::bigint,
         response_code      = (p_details ->> 'response_code')::integer,
         amount             = coalesce(p_refunded, amount),
         payload            = coalesce(p_details, '{}'::jsonb)
   where id = p_refund_id;

  -- Lo devuelto en el pago es la suma de lo CONFIRMADO. Nunca lo solicitado.
  select coalesce(sum(amount), 0) into v_confirmed
    from public.payment_refunds
   where payment_id = v_refund.payment_id and status = 'CONFIRMED';

  v_next := case
    when v_confirmed >= v_payment.amount then 'REFUNDED'::public.payment_status
    else 'PARTIALLY_REFUNDED'::public.payment_status
  end;

  update public.payments
     set refunded_amount = v_confirmed,
         status          = v_next,
         updated_at      = now()
   where id = v_refund.payment_id;

  insert into public.payment_events (payment_id, from_status, to_status, provider, provider_event_id, payload)
  values (
    v_refund.payment_id, v_payment.status, v_next, v_refund.provider,
    v_refund.provider_event_id,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
      'operation', 'refund',
      'kind', p_kind,
      'refunded_total', v_confirmed
    )
  );

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (v_refund.requested_by, 'payment_refund_confirmed', 'payments', v_refund.payment_id,
          jsonb_build_object('refund_id', p_refund_id, 'kind', p_kind,
                             'refunded_total', v_confirmed));

  return jsonb_build_object(
    'outcome', 'applied',
    'refund_status', 'CONFIRMED',
    'payment_status', v_next,
    'refunded_total', v_confirmed
  );
end;
$$;

revoke execute on function public.settle_payment_refund(uuid, boolean, text, bigint, jsonb) from public;
revoke execute on function public.settle_payment_refund(uuid, boolean, text, bigint, jsonb) from anon;
revoke execute on function public.settle_payment_refund(uuid, boolean, text, bigint, jsonb) from authenticated;
grant execute on function public.settle_payment_refund(uuid, boolean, text, bigint, jsonb) to service_role;

comment on function public.settle_payment_refund is
  'Cierra una devolución con la respuesta del proveedor. Idempotente. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 7. La cola de conciliación
-- -----------------------------------------------------------------------------
-- Pagos que se quedaron sin estado final. No depende de que nadie mantenga una
-- pestaña abierta: si el navegador del cliente murió a mitad del retorno, el
-- pago sigue aquí hasta que se resuelva contra el proveedor.
create or replace function public.payments_pending_reconciliation(
  p_older_than_minutes integer default 5,
  p_limit integer default 50
)
returns table (
  payment_id     uuid,
  job_id         uuid,
  assignment_id  uuid,
  reference      text,
  status         public.payment_status,
  provider       text,
  environment    text,
  buy_order      text,
  session_id     text,
  amount         bigint,
  attempt        integer,
  created_at     timestamptz,
  reconciled_at  timestamptz,
  review_reason  text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.job_id, p.assignment_id, j.reference, p.status, p.provider,
         p.environment, p.buy_order, p.session_id, p.amount, p.attempt,
         p.created_at, p.reconciled_at, p.review_reason
    from public.payments p
    join public.jobs j on j.id = p.job_id
   where p.status in ('PENDING', 'CREATED', 'AUTHORIZED', 'UNDER_REVIEW')
     and p.provider_token is not null
     and p.created_at < now() - make_interval(mins => greatest(p_older_than_minutes, 0))
     -- Webpay solo responde por una transacción durante 7 días.
     and p.created_at > now() - interval '7 days'
   order by p.created_at
   limit least(greatest(p_limit, 1), 200);
$$;

revoke execute on function public.payments_pending_reconciliation(integer, integer) from public;
revoke execute on function public.payments_pending_reconciliation(integer, integer) from anon;
revoke execute on function public.payments_pending_reconciliation(integer, integer) from authenticated;
grant execute on function public.payments_pending_reconciliation(integer, integer) to service_role;

comment on function public.payments_pending_reconciliation is
  'Pagos sin estado final y con token, dentro de la ventana de 7 días en que Webpay responde. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 8. Vista de administración de pagos
-- -----------------------------------------------------------------------------
-- Lo que necesita ver quien atiende un caso, sin exponer el token ni nada que
-- no deba salir de la base. `provider_token` NO está aquí a propósito.
create or replace view public.admin_payments
with (security_invoker = true)
as
  select p.id                       as payment_id,
         p.job_id,
         p.assignment_id,
         j.reference                as job_reference,
         j.title                    as job_title,
         p.client_id,
         p.purpose,
         p.status,
         p.provider,
         p.environment,
         p.buy_order,
         p.amount,
         p.currency,
         p.refunded_amount,
         p.amount - p.refunded_amount as refundable_amount,
         p.provider_status,
         p.response_code,
         p.authorization_code,
         p.card_last_digits,
         p.payment_type_code,
         p.installments,
         p.vci,
         p.attempt,
         p.failure_reason,
         p.review_reason,
         p.created_at,
         p.paid_at,
         p.captured_at,
         p.committed_at,
         p.reconciled_at,
         p.failed_at,
         (select count(*) from public.payment_events e where e.payment_id = p.id) as event_count,
         (select count(*) from public.payment_refunds r
           where r.payment_id = p.id and r.status = 'CONFIRMED')                  as refund_count,
         (select d.id from public.disputes d
           where d.assignment_id = p.assignment_id limit 1)                      as dispute_id,
         (select o.id from public.payouts o where o.payment_id = p.id limit 1)    as payout_id
    from public.payments p
    join public.jobs j on j.id = p.job_id;

comment on view public.admin_payments is
  'Pagos para el panel de administración. Sin token: el token autoriza operaciones y no sale de la base.';

grant select on public.admin_payments to authenticated;


-- -----------------------------------------------------------------------------
-- 9. Invariantes nuevos del dinero devuelto
-- -----------------------------------------------------------------------------
-- Se añaden a los que ya comprueba `app_private.payment_invariant_violations`:
-- cero filas sigue siendo el estado sano.
create or replace function app_private.refund_invariant_violations()
returns table (rule text, entity_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Devuelto más de lo cobrado.
  select 'refunded_over_amount', p.id
    from public.payments p
   where p.refunded_amount > p.amount

  union all
  -- El pago dice devuelto pero no hay ninguna devolución confirmada.
  select 'refunded_without_confirmation', p.id
    from public.payments p
   where p.status in ('REFUNDED', 'PARTIALLY_REFUNDED')
     and not exists (
       select 1 from public.payment_refunds r
        where r.payment_id = p.id and r.status = 'CONFIRMED'
     )

  union all
  -- Lo devuelto en el pago no cuadra con la suma de lo confirmado.
  select 'refunded_amount_mismatch', p.id
    from public.payments p
   where p.refunded_amount <> coalesce((
           select sum(r.amount) from public.payment_refunds r
            where r.payment_id = p.id and r.status = 'CONFIRMED'
         ), 0)

  union all
  -- Una devolución confirmada sin decir cómo la resolvió el banco.
  select 'confirmed_refund_without_kind', r.id
    from public.payment_refunds r
   where r.status = 'CONFIRMED' and r.kind is null

  union all
  -- Un pago de integración asentado en producción, o al revés.
  select 'environment_mixed', p.id
    from public.payments p
    join public.payment_refunds r on r.payment_id = p.id
   where p.environment is not null and r.environment <> p.environment;
$$;

revoke execute on function app_private.refund_invariant_violations() from public;
revoke execute on function app_private.refund_invariant_violations() from anon;
grant execute on function app_private.refund_invariant_violations() to authenticated;


-- -----------------------------------------------------------------------------
-- 10. Nada de esto se borra
-- -----------------------------------------------------------------------------
revoke delete, truncate on public.payment_refunds from authenticated;
revoke delete, truncate on public.payment_refunds from anon;
