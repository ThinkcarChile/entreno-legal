-- =============================================================================
-- HagoTuFila · Un cobro duplicado se devuelve desde el panel
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado al integrar las ramas de pagos: 20260601001010 detecta
-- el cobro duplicado —un intento autorizado cuando el pago ya tenía el dinero
-- de otro— y lo deja a la vista en /admin/pagos (DOUBLE_CHARGE), igual que el
-- intento que salió de la ventana con indicios de cobro (UNDER_REVIEW). Pero
-- nada lo podía devolver: las devoluciones son por PAGO (`payment_refunds`) y
-- van al token del pago, que es el del intento que SÍ pagó el trabajo.
-- Devolver el duplicado por ahí habría devuelto el cobro bueno y descuadrado
-- el pago del trabajo; el panel decía «devuélvelo desde el portal de
-- Transbank» y ahí acababa el rastro.
--
-- Ahora cada intento tiene su propia devolución, con el mismo rigor que la de
-- un pago (20260601000910):
--
--   · `payment_attempt_refunds`: una fila por petición. Misma máquina de
--     estados (el disparador `guard_refund_transitions` es el mismo), la misma
--     idempotencia por petición y una sola comprometida por intento: abierta
--     (REQUESTED, UNKNOWN) o hecha (CONFIRMED). El importe es siempre el cobro
--     entero del intento: no hay devolución parcial de un duplicado.
--   · `request_attempt_refund` (solo administración) → `claim_attempt_refund`
--     (un solo envío al banco) → `settle_attempt_refund` o
--     `mark_attempt_refund_unknown`, con el token del intento.
--   · `attempt_refunds_pending_reconciliation` y
--     `resolve_unknown_attempt_refund`: la conciliación las resuelve con la
--     consulta de estado cuando puede, y si no, una persona con lo que muestra
--     el portal de Transbank, con nota obligatoria y auditoría.
--   · El cobro del intento queda registrado en `provider_amount` cuando pasa a
--     DOUBLE_CHARGE, aunque la confirmación no trajera el importe.
--   · Un intento devuelto, o con su devolución en curso, no puede pasar
--     después a ser el dinero del pago: eso devolvería dos veces el mismo
--     cobro, una por aquí y otra con la devolución del pago.
--   · `admin_payments` deja de contar como pendiente un intento ya devuelto y
--     entrega el estado de cada uno para el panel.
--
-- Orden de bloqueo, el canónico: trabajo → asignación → pago → intento → su
-- devolución. Las funciones que solo tocan la fila de la devolución
-- (`claim_…`, `mark_…_unknown`) bloquean solo esa fila.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Las devoluciones de un intento
-- -----------------------------------------------------------------------------
create table if not exists public.payment_attempt_refunds (
  id                 uuid primary key default gen_random_uuid(),
  attempt_id         uuid not null references public.payment_attempts (id) on delete restrict,
  payment_id         uuid not null references public.payments (id) on delete restrict,

  amount             bigint not null check (amount > 0),
  currency           char(3) not null default 'CLP',
  reason             text not null check (length(btrim(reason)) between 10 and 1000),

  status             public.refund_status not null default 'REQUESTED',
  kind               public.refund_kind,

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
  dispatched_at      timestamptz,
  outcome_unknown_at timestamptz,
  unknown_reason     text,
  last_checked_at    timestamptz,
  last_check_result  text,
  settled_at         timestamptz,
  failure_reason     text,
  resolved_by        uuid references public.profiles (id) on delete restrict,
  resolution_note    text,

  constraint payment_attempt_refunds_settled_has_kind
    check (status <> 'CONFIRMED' or kind is not null),
  constraint payment_attempt_refunds_unknown_explained
    check (status <> 'UNKNOWN' or (outcome_unknown_at is not null and unknown_reason is not null))
);

comment on table public.payment_attempt_refunds is
  'Devoluciones del cobro de UN intento de pago (cobro duplicado, o intento en revisión con indicios de cobro), contra el token de ese intento. No tocan el pago del trabajo. Solo las escribe service_role por RPC.';
comment on column public.payment_attempt_refunds.amount is
  'Siempre el cobro entero del intento: su provider_amount o, si el proveedor no lo informó, el importe del pago con que se creó.';
comment on column public.payment_attempt_refunds.dispatched_at is
  'Cuándo se envió al banco. Lo marca claim_attempt_refund, una sola vez: sin esta marca la petición no salió.';

-- La misma petición repetida no crea otra fila.
create unique index if not exists payment_attempt_refunds_event_idx
  on public.payment_attempt_refunds (provider, provider_event_id);

-- Una sola comprometida por intento: abierta o ya hecha. Mientras no se sepa
-- qué pasó con una no se pide otra, y una hecha no se repite.
create unique index if not exists payment_attempt_refunds_one_committed_idx
  on public.payment_attempt_refunds (attempt_id)
  where status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED');

create index if not exists payment_attempt_refunds_payment_idx
  on public.payment_attempt_refunds (payment_id, requested_at desc);

-- La máquina de estados es la de las devoluciones de un pago: el mismo
-- disparador, sin exención para el rol de servicio.
drop trigger if exists payment_attempt_refunds_guard_transitions on public.payment_attempt_refunds;
create trigger payment_attempt_refunds_guard_transitions
  before update on public.payment_attempt_refunds
  for each row execute function app_private.guard_refund_transitions();

-- Y una devolución no cambia de intento.
create or replace function app_private.guard_attempt_refund_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.attempt_id is distinct from old.attempt_id then
    raise exception 'Una devolución no cambia de intento' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_attempt_refund_identity() from public, anon, authenticated;

drop trigger if exists payment_attempt_refunds_guard_identity on public.payment_attempt_refunds;
create trigger payment_attempt_refunds_guard_identity
  before update on public.payment_attempt_refunds
  for each row execute function app_private.guard_attempt_refund_identity();

-- Privilegios: los por omisión regalan escritura; se retiran. Administración
-- lee (RLS); nadie con sesión escribe.
alter table public.payment_attempt_refunds enable row level security;

drop policy if exists payment_attempt_refunds_admin_read on public.payment_attempt_refunds;
create policy payment_attempt_refunds_admin_read on public.payment_attempt_refunds
  for select using (app_private.is_admin());

revoke all on public.payment_attempt_refunds from anon, authenticated;
grant select on public.payment_attempt_refunds to authenticated;
grant select, insert, update on public.payment_attempt_refunds to service_role;


-- -----------------------------------------------------------------------------
-- 2. El cobro del intento, y un intento devuelto que no vuelve a cobrar
-- -----------------------------------------------------------------------------
-- · DOUBLE_CHARGE sin importe: la confirmación llegó sin él (una llamada sin
--   `p_amount`). Webpay Plus autoriza el importe con que se creó la
--   transacción, que es el del pago; se registra para saber cuánto devolver.
-- · Un intento con su devolución pedida, por confirmar o hecha no pasa a
--   SETTLED: sería asentar como dinero del trabajo un cobro que ya se le
--   devolvió (o se le está devolviendo) al cliente. Pasa con la autorización
--   tardía de un intento en revisión (20260601001010). Se niega en voz alta y
--   no se aplica nada.
create or replace function app_private.guard_attempt_money()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'DOUBLE_CHARGE' and new.provider_amount is null then
    select amount into new.provider_amount from public.payments where id = new.payment_id;
  end if;

  if new.status = 'SETTLED' and old.status is distinct from 'SETTLED'
     and exists (select 1 from public.payment_attempt_refunds r
                  where r.attempt_id = new.id
                    and r.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED')) then
    raise exception 'El cobro del intento % (orden %) ya se devolvió al cliente o se está devolviendo: no puede pasar a ser el pago del trabajo. Revísalo en /admin/pagos',
      new.attempt, new.buy_order
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function app_private.guard_attempt_money() from public, anon, authenticated;

drop trigger if exists payment_attempts_guard_money on public.payment_attempts;
create trigger payment_attempts_guard_money
  before update on public.payment_attempts
  for each row execute function app_private.guard_attempt_money();

comment on function app_private.guard_attempt_money is
  'DOUBLE_CHARGE sin importe toma el del pago; un intento con devolución comprometida no pasa a SETTLED.';

-- Los duplicados que ya existían sin importe.
update public.payment_attempts a
   set provider_amount = p.amount
  from public.payments p
 where p.id = a.payment_id
   and a.status = 'DOUBLE_CHARGE'
   and a.provider_amount is null;


-- -----------------------------------------------------------------------------
-- 3. Pedir la devolución de un intento
-- -----------------------------------------------------------------------------
create or replace function public.request_attempt_refund(
  p_attempt_id        uuid,
  p_reason            text,
  p_provider_event_id text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id uuid;
  v_job_id uuid;
  v_assignment_id uuid;
  v_payment public.payments;
  v_attempt public.payment_attempts;
  v_existing public.payment_attempt_refunds;
  v_committed public.payment_attempt_refunds;
  v_amount bigint;
  v_refund_id uuid;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración puede devolver un cobro duplicado'
      using errcode = 'insufficient_privilege';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'Escribe el motivo de la devolución (al menos 10 caracteres)'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_provider_event_id is null or length(btrim(p_provider_event_id)) = 0 then
    raise exception 'Falta la clave de idempotencia de la devolución'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Sin bloqueo: solo para saber qué bloquear, y en qué orden.
  select payment_id into v_payment_id from public.payment_attempts where id = p_attempt_id;
  if v_payment_id is null then
    raise exception 'El intento de pago no existe' using errcode = 'no_data_found';
  end if;
  select job_id, assignment_id into v_job_id, v_assignment_id
    from public.payments where id = v_payment_id;

  perform 1 from public.jobs where id = v_job_id for update;
  if v_assignment_id is not null then
    perform 1 from public.assignments where id = v_assignment_id for update;
  end if;
  select * into v_payment from public.payments where id = v_payment_id for update;
  select * into v_attempt from public.payment_attempts where id = p_attempt_id for update;

  -- Idempotencia, antes que cualquier otra regla: la misma petición repetida
  -- devuelve la misma fila, esté como esté.
  select * into v_existing
    from public.payment_attempt_refunds
   where provider = v_attempt.provider and provider_event_id = p_provider_event_id;
  if v_existing.id is not null then
    if v_existing.attempt_id <> p_attempt_id then
      raise exception 'Esa clave de idempotencia ya se usó para otra devolución'
        using errcode = 'check_violation';
    end if;
    return v_existing.id;
  end if;

  if v_attempt.status not in ('DOUBLE_CHARGE', 'UNDER_REVIEW') then
    raise exception 'Este intento está en %: aquí solo se devuelve un cobro duplicado o un intento en revisión. El cobro que pagó el trabajo se devuelve con «Devolver», sobre el pago',
      v_attempt.status
      using errcode = 'check_violation';
  end if;

  -- El intento que respalda el dinero del pago se devuelve por el pago. Por
  -- los dos lados, el mismo cobro se devolvería dos veces.
  if (v_attempt.buy_order = v_payment.buy_order
      or v_attempt.provider_token is not distinct from v_payment.provider_token)
     and v_payment.status in ('AUTHORIZED', 'PAID', 'UNDER_REVIEW', 'PARTIALLY_REFUNDED', 'REFUNDED') then
    raise exception 'Este intento es el que respalda el pago del trabajo: su dinero se devuelve con «Devolver», sobre el pago. Devolverlo también aquí sería devolverlo dos veces'
      using errcode = 'check_violation';
  end if;

  if v_attempt.provider_token is null then
    raise exception 'Este intento no tiene token del proveedor: no se puede devolver desde aquí. Búscalo por su orden de compra (%) en el portal de Transbank',
      v_attempt.buy_order
      using errcode = 'check_violation';
  end if;

  select * into v_committed
    from public.payment_attempt_refunds
   where attempt_id = p_attempt_id and status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED')
   limit 1;
  if v_committed.id is not null then
    if v_committed.status = 'CONFIRMED' then
      raise exception 'Este cobro ya se devolvió (% el %): no hay nada más que devolver',
        app_private.format_clp(v_committed.amount),
        to_char(v_committed.settled_at at time zone 'America/Santiago', 'DD-MM-YYYY')
        using errcode = 'check_violation';
    end if;
    if v_committed.status = 'UNKNOWN' then
      raise exception 'Hay una devolución de este cobro con resultado por confirmar: hasta saber si el banco la hizo no se puede pedir otra'
        using errcode = 'check_violation';
    end if;
    raise exception 'Hay una devolución de este cobro en curso: espera su resultado antes de pedir otra'
      using errcode = 'check_violation';
  end if;

  -- El cobro entero del intento. `provider_amount` es lo que autorizó el
  -- proveedor; sin él, el importe con que se creó la transacción.
  v_amount := coalesce(v_attempt.provider_amount, v_payment.amount);

  insert into public.payment_attempt_refunds (
    attempt_id, payment_id, amount, currency, reason, status,
    provider, environment, provider_event_id, requested_by
  ) values (
    p_attempt_id, v_payment_id, v_amount, v_payment.currency, btrim(p_reason), 'REQUESTED',
    v_attempt.provider, v_attempt.environment, p_provider_event_id, auth.uid()
  )
  returning id into v_refund_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (auth.uid(), 'payment_attempt_refund_requested', 'payments', v_payment_id,
          jsonb_build_object('refund_id', v_refund_id, 'attempt', v_attempt.attempt,
                             'buy_order', v_attempt.buy_order, 'attempt_status', v_attempt.status,
                             'amount', v_amount, 'reason', btrim(p_reason)));

  return v_refund_id;
end;
$$;

revoke execute on function public.request_attempt_refund(uuid, text, text) from public;
revoke execute on function public.request_attempt_refund(uuid, text, text) from anon;
grant execute on function public.request_attempt_refund(uuid, text, text) to authenticated;

comment on function public.request_attempt_refund is
  'Deja pedida la devolución del cobro entero de un intento DOUBLE_CHARGE o UNDER_REVIEW que no respalda el pago. Solo administración. Idempotente por petición; una sola comprometida por intento. No devuelve dinero: eso lo hace el proveedor y lo cierra settle_attempt_refund.';


-- -----------------------------------------------------------------------------
-- 4. Reservar el envío: una sola llamada al banco por devolución
-- -----------------------------------------------------------------------------
create or replace function public.claim_attempt_refund(p_refund_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payment_attempt_refunds
     set dispatched_at = now()
   where id = p_refund_id
     and status = 'REQUESTED'
     and dispatched_at is null;
  return found;
end;
$$;

revoke execute on function public.claim_attempt_refund(uuid) from public;
revoke execute on function public.claim_attempt_refund(uuid) from anon;
revoke execute on function public.claim_attempt_refund(uuid) from authenticated;
grant execute on function public.claim_attempt_refund(uuid) to service_role;

comment on function public.claim_attempt_refund is
  'Marca la devolución del intento como enviada al banco. Devuelve true solo a la primera llamada. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 5. Cerrarla con lo que dijo el banco
-- -----------------------------------------------------------------------------
-- Como `settle_payment_refund`, salvo que no toca el pago: el dinero del
-- duplicado nunca fue parte de él. Bloquea el intento y después la devolución.
create or replace function public.settle_attempt_refund(
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
  v_attempt_id uuid;
  v_attempt public.payment_attempts;
  v_refund public.payment_attempt_refunds;
  v_amount bigint;
begin
  select attempt_id into v_attempt_id from public.payment_attempt_refunds where id = p_refund_id;
  if v_attempt_id is null then
    raise exception 'La devolución no existe' using errcode = 'no_data_found';
  end if;
  select * into v_attempt from public.payment_attempts where id = v_attempt_id for update;
  select * into v_refund from public.payment_attempt_refunds where id = p_refund_id for update;

  -- Idempotente: cerrar dos veces la misma devolución no la cambia.
  if v_refund.status not in ('REQUESTED', 'UNKNOWN') then
    return jsonb_build_object(
      'outcome', 'duplicate',
      'refund_status', v_refund.status,
      'attempt_status', v_attempt.status,
      'payment_status', (select status from public.payments where id = v_refund.payment_id)
    );
  end if;

  if not p_confirmed then
    update public.payment_attempt_refunds
       set status         = 'FAILED',
           settled_at     = now(),
           failure_reason = coalesce(p_details ->> 'failure_reason', 'provider_rejected'),
           response_code  = (p_details ->> 'response_code')::integer,
           payload        = coalesce(p_details, '{}'::jsonb)
     where id = p_refund_id;

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
    values (v_refund.requested_by, 'payment_attempt_refund_failed', 'payments', v_refund.payment_id,
            jsonb_build_object('refund_id', p_refund_id, 'attempt', v_attempt.attempt,
                               'from', v_refund.status,
                               'failure_reason', coalesce(p_details ->> 'failure_reason', 'provider_rejected')));

    return jsonb_build_object(
      'outcome', 'applied',
      'refund_status', 'FAILED',
      'attempt_status', v_attempt.status,
      'payment_status', (select status from public.payments where id = v_refund.payment_id)
    );
  end if;

  if p_kind is null or p_kind not in ('REVERSED', 'NULLIFIED') then
    raise exception 'Una devolución confirmada tiene que decir si fue reversa o anulación'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Lo devuelto no supera lo cobrado en el intento, que es lo que se pidió.
  v_amount := coalesce(p_refunded, v_refund.amount);
  if v_amount <= 0 or v_amount > v_refund.amount then
    raise exception 'Confirmar esta devolución por % no cuadra con el cobro del intento (%)',
      v_amount, v_refund.amount
      using errcode = 'check_violation';
  end if;

  update public.payment_attempt_refunds
     set status             = 'CONFIRMED',
         kind               = p_kind::public.refund_kind,
         settled_at         = now(),
         authorization_code = p_details ->> 'authorization_code',
         authorization_date = (p_details ->> 'authorization_date')::timestamptz,
         nullified_amount   = (p_details ->> 'nullified_amount')::bigint,
         balance            = (p_details ->> 'balance')::bigint,
         response_code      = (p_details ->> 'response_code')::integer,
         amount             = v_amount,
         payload            = coalesce(p_details, '{}'::jsonb)
   where id = p_refund_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (v_refund.requested_by, 'payment_attempt_refund_confirmed', 'payments', v_refund.payment_id,
          jsonb_build_object('refund_id', p_refund_id, 'attempt', v_attempt.attempt,
                             'buy_order', v_attempt.buy_order, 'kind', p_kind,
                             'from', v_refund.status, 'amount', v_amount));

  return jsonb_build_object(
    'outcome', 'applied',
    'refund_status', 'CONFIRMED',
    'attempt_status', v_attempt.status,
    'payment_status', (select status from public.payments where id = v_refund.payment_id),
    'refunded_total', v_amount
  );
end;
$$;

revoke execute on function public.settle_attempt_refund(uuid, boolean, text, bigint, jsonb) from public;
revoke execute on function public.settle_attempt_refund(uuid, boolean, text, bigint, jsonb) from anon;
revoke execute on function public.settle_attempt_refund(uuid, boolean, text, bigint, jsonb) from authenticated;
grant execute on function public.settle_attempt_refund(uuid, boolean, text, bigint, jsonb) to service_role;

comment on function public.settle_attempt_refund is
  'Cierra la devolución de un intento, pedida o por confirmar, con la respuesta del proveedor. Idempotente. No toca el pago. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 6. Dejarla por confirmar
-- -----------------------------------------------------------------------------
create or replace function public.mark_attempt_refund_unknown(
  p_refund_id uuid,
  p_reason    text,
  p_details   jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund public.payment_attempt_refunds;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'Falta el motivo por el que no se sabe el resultado'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_refund from public.payment_attempt_refunds where id = p_refund_id for update;
  if v_refund.id is null then
    raise exception 'La devolución no existe' using errcode = 'no_data_found';
  end if;

  if v_refund.status = 'REQUESTED' then
    update public.payment_attempt_refunds
       set status             = 'UNKNOWN',
           outcome_unknown_at = now(),
           unknown_reason     = btrim(p_reason),
           dispatched_at      = coalesce(dispatched_at, now()),
           payload            = payload || coalesce(p_details, '{}'::jsonb)
     where id = p_refund_id;

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
    values (v_refund.requested_by, 'payment_attempt_refund_outcome_unknown', 'payments', v_refund.payment_id,
            jsonb_build_object('refund_id', p_refund_id, 'reason', btrim(p_reason)));

    return jsonb_build_object('outcome', 'applied', 'refund_status', 'UNKNOWN');
  end if;

  if v_refund.status = 'UNKNOWN' then
    update public.payment_attempt_refunds
       set last_checked_at   = now(),
           last_check_result = btrim(p_reason),
           payload           = payload || jsonb_build_object('last_check', coalesce(p_details, '{}'::jsonb))
     where id = p_refund_id;
    return jsonb_build_object('outcome', 'checked', 'refund_status', 'UNKNOWN');
  end if;

  return jsonb_build_object('outcome', 'duplicate', 'refund_status', v_refund.status);
end;
$$;

revoke execute on function public.mark_attempt_refund_unknown(uuid, text, jsonb) from public;
revoke execute on function public.mark_attempt_refund_unknown(uuid, text, jsonb) from anon;
revoke execute on function public.mark_attempt_refund_unknown(uuid, text, jsonb) from authenticated;
grant execute on function public.mark_attempt_refund_unknown(uuid, text, jsonb) to service_role;

comment on function public.mark_attempt_refund_unknown is
  'Pasa la devolución de un intento a UNKNOWN con su motivo; sobre una UNKNOWN solo anota la última consulta. Nunca toca una final. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 7. La cola por conciliar
-- -----------------------------------------------------------------------------
-- Como `refunds_pending_reconciliation`. `transaction_amount` es el cobro del
-- intento (la transacción que se consulta), y `refunded_amount` lo ya devuelto
-- y confirmado de ese intento sin contar esta: con una sola comprometida por
-- intento, cero.
create or replace function public.attempt_refunds_pending_reconciliation(
  p_min_age_minutes integer default 10,
  p_limit           integer default 50,
  p_payment_id      uuid default null
)
returns table (
  refund_id          uuid,
  attempt_id         uuid,
  payment_id         uuid,
  status             public.refund_status,
  amount             bigint,
  requested_at       timestamptz,
  dispatched_at      timestamptz,
  outcome_unknown_at timestamptz,
  last_checked_at    timestamptz,
  provider           text,
  environment        text,
  transaction_amount bigint,
  refunded_amount    bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.attempt_id, r.payment_id, r.status, r.amount, r.requested_at, r.dispatched_at,
         r.outcome_unknown_at, r.last_checked_at, r.provider, r.environment,
         coalesce(a.provider_amount, p.amount),
         coalesce((select sum(o.amount) from public.payment_attempt_refunds o
                    where o.attempt_id = r.attempt_id and o.id <> r.id
                      and o.status = 'CONFIRMED'), 0)
    from public.payment_attempt_refunds r
    join public.payment_attempts a on a.id = r.attempt_id
    join public.payments p on p.id = r.payment_id
   where r.status in ('REQUESTED', 'UNKNOWN')
     and (p_payment_id is null or r.payment_id = p_payment_id)
     and coalesce(r.last_checked_at, r.outcome_unknown_at, r.requested_at)
           <= now() - make_interval(mins => greatest(p_min_age_minutes, 0))
   order by r.requested_at
   limit least(greatest(p_limit, 1), 200);
$$;

revoke execute on function public.attempt_refunds_pending_reconciliation(integer, integer, uuid) from public;
revoke execute on function public.attempt_refunds_pending_reconciliation(integer, integer, uuid) from anon;
revoke execute on function public.attempt_refunds_pending_reconciliation(integer, integer, uuid) from authenticated;
grant execute on function public.attempt_refunds_pending_reconciliation(integer, integer, uuid) to service_role;

comment on function public.attempt_refunds_pending_reconciliation is
  'Devoluciones de intentos REQUESTED o UNKNOWN sin movimiento reciente, con el cobro del intento. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 8. Cerrarla a mano, con lo que muestra el portal de Transbank
-- -----------------------------------------------------------------------------
create or replace function public.resolve_unknown_attempt_refund(
  p_refund_id uuid,
  p_succeeded boolean,
  p_kind      text default null,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt_id uuid;
  v_attempt public.payment_attempts;
  v_refund public.payment_attempt_refunds;
  v_result jsonb;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración resuelve una devolución por confirmar'
      using errcode = 'insufficient_privilege';
  end if;

  if p_succeeded is null then
    raise exception 'Indica si el banco hizo o no la devolución'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_note is null or length(btrim(p_note)) < 10 then
    raise exception 'Escribe lo que muestra el portal de Transbank (al menos 10 caracteres)'
      using errcode = 'invalid_parameter_value';
  end if;

  select attempt_id into v_attempt_id from public.payment_attempt_refunds where id = p_refund_id;
  if v_attempt_id is null then
    raise exception 'La devolución no existe' using errcode = 'no_data_found';
  end if;
  select * into v_attempt from public.payment_attempts where id = v_attempt_id for update;
  select * into v_refund from public.payment_attempt_refunds where id = p_refund_id for update;

  if v_refund.status in ('CONFIRMED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object('outcome', 'duplicate', 'refund_status', v_refund.status);
  end if;
  if v_refund.status <> 'UNKNOWN' then
    raise exception 'Solo se resuelve a mano una devolución con resultado por confirmar'
      using errcode = 'check_violation';
  end if;

  if p_succeeded and (p_kind is null or p_kind not in ('REVERSED', 'NULLIFIED')) then
    raise exception 'Indica si el portal la muestra como reversa o como anulación'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.payment_attempt_refunds
     set resolved_by     = auth.uid(),
         resolution_note = btrim(p_note)
   where id = p_refund_id;

  if p_succeeded then
    v_result := public.settle_attempt_refund(
      p_refund_id, true, p_kind, v_refund.amount,
      jsonb_build_object('source', 'manual', 'resolved_by', auth.uid(), 'note', btrim(p_note))
    );
  else
    v_result := public.settle_attempt_refund(
      p_refund_id, false, null, null,
      jsonb_build_object('source', 'manual', 'resolved_by', auth.uid(), 'note', btrim(p_note),
                         'failure_reason', 'manual_not_executed')
    );
  end if;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (auth.uid(), 'payment_attempt_refund_resolved_manually', 'payments', v_refund.payment_id,
          jsonb_build_object('refund_id', p_refund_id, 'attempt', v_attempt.attempt,
                             'buy_order', v_attempt.buy_order, 'succeeded', p_succeeded,
                             'kind', p_kind, 'note', btrim(p_note)));

  return v_result;
end;
$$;

revoke execute on function public.resolve_unknown_attempt_refund(uuid, boolean, text, text) from public;
revoke execute on function public.resolve_unknown_attempt_refund(uuid, boolean, text, text) from anon;
grant execute on function public.resolve_unknown_attempt_refund(uuid, boolean, text, text) to authenticated;

comment on function public.resolve_unknown_attempt_refund is
  'Solo administración: cierra la devolución UNKNOWN de un intento como hecha (reversa o anulación) o no hecha, con lo que muestra el portal de Transbank y una nota que queda en audit_logs. Cierra por settle_attempt_refund.';


-- -----------------------------------------------------------------------------
-- 9. Lo que ve administración de cada pago
-- -----------------------------------------------------------------------------
-- Igual que en 20260601001000, con dos cambios:
--
--   · `attempts_in_review` y `attempts_review_detail` dejan fuera el intento
--     cuyo cobro ya se devolvió: deja de estar pendiente y el pago sale del
--     filtro «En revisión» si no queda nada más;
--   · `attempts_review`, al final, trae cada intento en revisión —también los
--     ya devueltos— con su cobro, si es el que respalda el pago (ese se
--     devuelve por el pago) y su última devolución, para el panel.
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
         (select o.id from public.payouts o where o.payment_id = p.id limit 1)    as payout_id,
         abierta.id                 as open_refund_id,
         abierta.status             as open_refund_status,
         abierta.amount             as open_refund_amount,
         abierta.requested_at       as open_refund_requested_at,
         abierta.unknown_reason     as open_refund_unknown_reason,
         abierta.last_checked_at    as open_refund_last_checked_at,
         abierta.last_check_result  as open_refund_last_check_result,
         (select count(*) from public.payment_attempts a
           where a.payment_id = p.id
             and a.status in ('DOUBLE_CHARGE', 'UNDER_REVIEW')
             and not exists (select 1 from public.payment_attempt_refunds ar
                              where ar.attempt_id = a.id and ar.status = 'CONFIRMED'))
                                                                                   as attempts_in_review,
         (select string_agg('intento ' || a.attempt || ' · ' || a.buy_order || ' · ' || a.review_reason,
                            '; ' order by a.attempt)
            from public.payment_attempts a
           where a.payment_id = p.id
             and a.status in ('DOUBLE_CHARGE', 'UNDER_REVIEW')
             and not exists (select 1 from public.payment_attempt_refunds ar
                              where ar.attempt_id = a.id and ar.status = 'CONFIRMED'))
                                                                                   as attempts_review_detail,
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'attempt_id', a.id,
                   'attempt', a.attempt,
                   'buy_order', a.buy_order,
                   'status', a.status,
                   'review_reason', a.review_reason,
                   'amount', coalesce(a.provider_amount, p.amount),
                   -- El intento cuyo dinero es el del pago: se devuelve con la
                   -- devolución del pago, no con la suya.
                   'backs_payment', (a.buy_order = p.buy_order
                                     and p.status in ('AUTHORIZED', 'PAID', 'UNDER_REVIEW',
                                                      'PARTIALLY_REFUNDED', 'REFUNDED')),
                   'refund', (select jsonb_build_object(
                                       'refund_id', ar.id,
                                       'status', ar.status,
                                       'kind', ar.kind,
                                       'amount', ar.amount,
                                       'requested_at', ar.requested_at,
                                       'settled_at', ar.settled_at,
                                       'failure_reason', ar.failure_reason,
                                       'unknown_reason', ar.unknown_reason,
                                       'last_checked_at', ar.last_checked_at,
                                       'last_check_result', ar.last_check_result)
                                from public.payment_attempt_refunds ar
                               where ar.attempt_id = a.id
                               order by ar.requested_at desc
                               limit 1))
                   order by a.attempt), '[]'::jsonb)
            from public.payment_attempts a
           where a.payment_id = p.id
             and a.status in ('DOUBLE_CHARGE', 'UNDER_REVIEW'))                   as attempts_review
    from public.payments p
    join public.jobs j on j.id = p.job_id
    left join lateral (
      select r.id, r.status, r.amount, r.requested_at, r.unknown_reason,
             r.last_checked_at, r.last_check_result
        from public.payment_refunds r
       where r.payment_id = p.id and r.status in ('REQUESTED', 'UNKNOWN')
       order by r.requested_at desc
       limit 1
    ) abierta on true;

comment on view public.admin_payments is
  'Pagos para el panel de administración, con la devolución abierta de cada uno, los intentos que esperan a una persona y la devolución de cada intento. Sin token: el token autoriza operaciones y no sale de la base.';

grant select on public.admin_payments to authenticated;


-- -----------------------------------------------------------------------------
-- 10. Invariantes: una devolución de intento nunca toca el dinero del pago
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001410 más dos reglas:
--
--   · `attempt_refund_on_payment_money`: una devolución comprometida sobre el
--     intento cuyo dinero es el del pago (SETTLED, o el vigente de un pago con
--     dinero). Ese cobro se devuelve por el pago; por los dos lados, dos veces.
--   · `attempt_refund_over_charge`: lo confirmado supera el cobro del intento.
create or replace function app_private.refund_invariant_violations()
returns table (rule text, entity_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 'refunded_over_amount', p.id
    from public.payments p
   where p.refunded_amount > p.amount

  union all
  select 'refunded_without_confirmation', p.id
    from public.payments p
   where p.status in ('REFUNDED', 'PARTIALLY_REFUNDED')
     and not exists (
       select 1 from public.payment_refunds r
        where r.payment_id = p.id and r.status = 'CONFIRMED'
     )

  union all
  select 'refunded_amount_mismatch', p.id
    from public.payments p
   where p.refunded_amount <> coalesce((
           select sum(r.amount) from public.payment_refunds r
            where r.payment_id = p.id and r.status = 'CONFIRMED'
         ), 0)

  union all
  select 'confirmed_refund_without_kind', r.id
    from public.payment_refunds r
   where r.status = 'CONFIRMED' and r.kind is null

  union all
  select 'environment_mixed', p.id
    from public.payments p
    join public.payment_refunds r on r.payment_id = p.id
   where p.environment is not null and r.environment <> p.environment

  union all
  select 'stale_payment_out_of_window', p.id
    from public.payments p
   where p.status in ('PENDING', 'CREATED', 'AUTHORIZED')
     and app_private.payment_window_start(p.id, p.buy_order, p.created_at)
           <= now() - make_interval(days => app_private.reconciliation_window_days() + 1)

  union all
  select 'refund_committed_over_amount', p.id
    from public.payments p
   where (select coalesce(sum(r.amount), 0) from public.payment_refunds r
           where r.payment_id = p.id and r.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED'))
         > p.amount

  union all
  select 'attempt_refund_on_payment_money', ar.id
    from public.payment_attempt_refunds ar
    join public.payment_attempts a on a.id = ar.attempt_id
    join public.payments p on p.id = ar.payment_id
   where ar.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED')
     and (a.status = 'SETTLED'
          or (a.buy_order = p.buy_order
              and p.status in ('AUTHORIZED', 'PAID', 'UNDER_REVIEW', 'PARTIALLY_REFUNDED', 'REFUNDED')))

  union all
  select 'attempt_refund_over_charge', ar.id
    from public.payment_attempt_refunds ar
    join public.payment_attempts a on a.id = ar.attempt_id
    join public.payments p on p.id = ar.payment_id
   where ar.status = 'CONFIRMED'
     and ar.amount > coalesce(a.provider_amount, p.amount);
$$;

revoke execute on function app_private.refund_invariant_violations() from public;
revoke execute on function app_private.refund_invariant_violations() from anon;
grant execute on function app_private.refund_invariant_violations() to authenticated;
