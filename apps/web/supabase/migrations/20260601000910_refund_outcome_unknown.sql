-- =============================================================================
-- HagoTuFila · Una devolución no se puede hacer dos veces
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTOS, encontrados por la auditoría y comprobados en el código:
--
-- 1. Una devolución que fallaba no se podía reintentar. La clave de
--    idempotencia salía de (pago, importe, disputa o «admin»): el reintento
--    llevaba la misma clave, `request_payment_refund` devolvía la fila FAILED
--    y la aplicación contestaba «devolución ya resuelta» sin llamar al banco.
--
-- 2. Dos devoluciones parciales legítimas del mismo importe chocaban: la
--    segunda llevaba la clave de la primera, recibía su fila CONFIRMED y el
--    panel decía «devolución confirmada» sin que saliera un peso.
--
-- 3. Si Transbank tardaba, la red se cortaba o la respuesta no se entendía, la
--    devolución se cerraba como FAILED. El banco pudo haberla hecho igual; con
--    la fila en FAILED el saldo volvía a quedar libre y el reintento devolvía
--    dos veces.
--
-- Qué cambia:
--
-- · La clave identifica una PETICIÓN de administración (un identificador que
--   nace con el formulario), no un importe. Repetir la misma petición devuelve
--   la misma fila, esté como esté; dos peticiones distintas son dos
--   devoluciones. Reusar una clave con otro pago u otro importe es un error.
-- · `UNKNOWN` (migración 900) es el resultado desconocido. No es final y, como
--   `REQUESTED`, compromete saldo.
-- · Una sola devolución abierta (REQUESTED o UNKNOWN) por pago, con índice
--   único: mientras no se sepa qué pasó con una, no se pide otra.
-- · FAILED solo cuando el banco dijo que no, o cuando la petición no llegó a
--   salir. No compromete saldo: se puede volver a pedir por lo que quede.
-- · Un disparador fija la máquina de estados para todos, también para la clave
--   de servicio: REQUESTED → UNKNOWN | CONFIRMED | FAILED | CANCELLED (esta,
--   solo si no se envió); UNKNOWN → CONFIRMED | FAILED; lo demás es final.
-- · `claim_payment_refund`: solo una llamada envía cada devolución al banco,
--   aunque la misma petición llegue dos veces a la vez.
-- · `mark_payment_refund_unknown`, `refunds_pending_reconciliation` y
--   `resolve_unknown_refund`: dejarla por confirmar, encontrarla para
--   conciliarla con la consulta de estado, y que administración la cierre con
--   lo que muestra el portal de Transbank cuando la consulta no alcanza.
-- · La cola del panel cuenta las devoluciones abiertas, `admin_payments`
--   muestra la de cada pago con su explicación, y el invariante nuevo
--   `refund_committed_over_amount` delata lo comprometido por encima de lo
--   cobrado.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Lo que hace falta para explicar una devolución por confirmar
-- -----------------------------------------------------------------------------
alter table public.payment_refunds
  add column if not exists dispatched_at      timestamptz,
  add column if not exists outcome_unknown_at timestamptz,
  add column if not exists unknown_reason     text,
  add column if not exists last_checked_at    timestamptz,
  add column if not exists last_check_result  text,
  add column if not exists resolved_by        uuid references public.profiles (id) on delete restrict,
  add column if not exists resolution_note    text;

comment on column public.payment_refunds.dispatched_at is
  'Cuándo se envió al banco. Lo marca claim_payment_refund, una sola vez: sin esta marca la petición no salió.';
comment on column public.payment_refunds.outcome_unknown_at is
  'Cuándo pasó a UNKNOWN: se envió y no se supo qué hizo el banco.';
comment on column public.payment_refunds.unknown_reason is
  'Por qué no se sabe: timeout, network, provider_http_5xx, unparsable_response, stale_request…';
comment on column public.payment_refunds.last_checked_at is
  'Última vez que la conciliación consultó el estado de la transacción sin poder decidir.';
comment on column public.payment_refunds.last_check_result is
  'Qué concluyó esa última consulta, para quien la resuelva a mano.';
comment on column public.payment_refunds.resolved_by is
  'Quién la cerró a mano contra el portal de Transbank, si fue así.';
comment on column public.payment_refunds.resolution_note is
  'Lo que mostraba el portal cuando se cerró a mano.';

-- Lo que pidió la versión anterior y sigue sin cerrar se da por enviado: no
-- hay forma de saber que no salió hacia el banco. La conciliación lo pasará a
-- UNKNOWN y lo resolverá como cualquier otra.
update public.payment_refunds
   set dispatched_at = requested_at
 where status = 'REQUESTED' and dispatched_at is null;

alter table public.payment_refunds
  add constraint payment_refunds_unknown_explained
  check (status <> 'UNKNOWN' or (outcome_unknown_at is not null and unknown_reason is not null));

comment on type public.refund_status is
  'REQUESTED: pedida. UNKNOWN: enviada y sin saber qué hizo el banco. CONFIRMED: el banco la hizo. FAILED: el banco dijo que no, o no salió. CANCELLED: descartada antes de salir.';


-- -----------------------------------------------------------------------------
-- 2. La máquina de estados, para todos
-- -----------------------------------------------------------------------------
create or replace function app_private.guard_refund_transitions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.payment_id is distinct from old.payment_id
     or new.provider is distinct from old.provider
     or new.provider_event_id is distinct from old.provider_event_id
     or new.requested_by is distinct from old.requested_by then
    raise exception 'Una devolución no cambia de pago, de proveedor, de clave ni de quien la pidió'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status
     and not (
       (old.status = 'REQUESTED' and new.status in ('UNKNOWN', 'CONFIRMED', 'FAILED', 'CANCELLED'))
       or (old.status = 'UNKNOWN' and new.status in ('CONFIRMED', 'FAILED'))
     ) then
    raise exception 'Una devolución en % no puede pasar a %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- «Descartada antes de salir» solo vale si no salió: una enviada al banco
  -- pudo hacerse, y descartarla liberaría un saldo que quizá ya se devolvió.
  -- Su salida es la respuesta del banco, UNKNOWN o la conciliación.
  if new.status = 'CANCELLED' and old.status = 'REQUESTED' and old.dispatched_at is not null then
    raise exception 'Una devolución ya enviada al banco no se descarta: se cierra con su resultado o queda por confirmar'
      using errcode = 'check_violation';
  end if;

  -- Lo confirmado es un hecho contable: ni el importe ni el tipo se reescriben.
  if old.status = 'CONFIRMED'
     and (new.amount is distinct from old.amount or new.kind is distinct from old.kind) then
    raise exception 'Una devolución confirmada no cambia de importe ni de tipo'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function app_private.guard_refund_transitions() from public, anon, authenticated;

drop trigger if exists payment_refunds_guard_transitions on public.payment_refunds;
create trigger payment_refunds_guard_transitions
  before update on public.payment_refunds
  for each row execute function app_private.guard_refund_transitions();

comment on function app_private.guard_refund_transitions is
  'REQUESTED → UNKNOWN | CONFIRMED | FAILED | CANCELLED (esta, solo si no se envió); UNKNOWN → CONFIRMED | FAILED; el resto es final. Sin exención para el rol de servicio.';


-- -----------------------------------------------------------------------------
-- 3. Una sola devolución abierta por pago
-- -----------------------------------------------------------------------------
-- Si un proyecto ya tuviera dos pedidas a la vez sobre el mismo pago, no hay
-- forma de saber cuál salió hacia el banco: se detiene aquí para que lo mire
-- una persona en vez de elegir una al azar.
do $$
declare
  v_duplicados text;
begin
  select string_agg(payment_id::text, ', ')
    into v_duplicados
    from (select payment_id from public.payment_refunds
           where status = 'REQUESTED'
           group by payment_id having count(*) > 1) d;
  if v_duplicados is not null then
    raise exception 'Pagos con más de una devolución pendiente: %. Resuélvelas contra el portal de Transbank antes de aplicar esta migración.',
      v_duplicados;
  end if;
end $$;

create unique index if not exists payment_refunds_one_open_idx
  on public.payment_refunds (payment_id)
  where status in ('REQUESTED', 'UNKNOWN');


-- -----------------------------------------------------------------------------
-- 4. Pedir la devolución
-- -----------------------------------------------------------------------------
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
  v_existing public.payment_refunds;
  v_open public.payment_refunds;
  v_committed bigint;
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
  if p_provider_event_id is null or length(btrim(p_provider_event_id)) = 0 then
    raise exception 'Falta la clave de idempotencia de la devolución'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'El pago no existe' using errcode = 'no_data_found';
  end if;

  -- Idempotencia, ANTES que cualquier otra regla: la misma petición repetida
  -- devuelve la misma fila, esté en curso, por confirmar, confirmada o
  -- fallida. Después (como estaba) un doble envío chocaba con su propia
  -- devolución en curso o con el saldo que ella misma había comprometido.
  select * into v_existing
    from public.payment_refunds
   where provider = v_payment.provider and provider_event_id = p_provider_event_id;
  if v_existing.id is not null then
    -- Una clave es de una petición, y una petición es de un pago y un importe.
    -- (Una confirmada puede llevar el importe que dijo el banco: ahí solo se
    -- compara el pago.)
    if v_existing.payment_id <> p_payment_id
       or (v_existing.status <> 'CONFIRMED' and v_existing.amount <> p_amount) then
      raise exception 'Esa clave de idempotencia ya se usó para otra devolución'
        using errcode = 'check_violation';
    end if;
    return v_existing.id;
  end if;

  -- Solo se devuelve dinero que se cobró. `UNDER_REVIEW` entra porque es
  -- justamente el estado de «se cobró y no debía».
  if v_payment.status not in ('PAID', 'UNDER_REVIEW', 'PARTIALLY_REFUNDED') then
    raise exception 'El pago está en % y no admite devolución', v_payment.status
      using errcode = 'check_violation';
  end if;

  if v_payment.provider_token is null then
    raise exception 'El pago no tiene token del proveedor: no se puede devolver'
      using errcode = 'check_violation';
  end if;

  select * into v_open
    from public.payment_refunds
   where payment_id = p_payment_id and status in ('REQUESTED', 'UNKNOWN')
   order by requested_at desc
   limit 1;

  -- Comprometido: lo confirmado, más lo que está en curso o por confirmar.
  -- FAILED no compromete nada: el banco dijo que no, y ese saldo se puede
  -- volver a pedir.
  select coalesce(sum(amount), 0) into v_committed
    from public.payment_refunds
   where payment_id = p_payment_id and status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED');

  if v_committed + p_amount > v_payment.amount then
    raise exception 'La devolución excede el saldo: cobrado %, comprometido %, pedido %',
      v_payment.amount, v_committed,
      p_amount::text || case when v_open.id is null then ''
                             else ' (hay una devolución sin resultado final sobre este pago)' end
      using errcode = 'check_violation';
  end if;

  -- Mientras no se sepa qué pasó con una, no se pide otra: si la primera salió
  -- de verdad, la segunda sería dinero devuelto dos veces.
  if v_open.id is not null then
    if v_open.status = 'UNKNOWN' then
      raise exception 'Hay una devolución de este pago con resultado por confirmar: hasta saber si el banco la hizo no se puede pedir otra'
        using errcode = 'check_violation';
    end if;
    raise exception 'Hay una devolución de este pago en curso: espera su resultado antes de pedir otra'
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
  'Deja pedida una devolución. Solo administración. Idempotente por petición; una sola abierta por pago. No devuelve dinero: eso lo hace el proveedor y lo cierra settle_payment_refund.';


-- -----------------------------------------------------------------------------
-- 5. Reservar el envío: una sola llamada al banco por devolución
-- -----------------------------------------------------------------------------
-- Dos envíos simultáneos de la MISMA petición reciben la misma fila. Sin esto
-- los dos la veían en REQUESTED y los dos llamaban al banco: la idempotencia de
-- la base no alcanza a la llamada que viene después.
create or replace function public.claim_payment_refund(p_refund_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payment_refunds
     set dispatched_at = now()
   where id = p_refund_id
     and status = 'REQUESTED'
     and dispatched_at is null;
  return found;
end;
$$;

revoke execute on function public.claim_payment_refund(uuid) from public;
revoke execute on function public.claim_payment_refund(uuid) from anon;
revoke execute on function public.claim_payment_refund(uuid) from authenticated;
grant execute on function public.claim_payment_refund(uuid) to service_role;

comment on function public.claim_payment_refund is
  'Marca la devolución como enviada al banco. Devuelve true solo a la primera llamada: las demás no deben llamar al banco. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 6. Cerrar la devolución con lo que dijo el banco
-- -----------------------------------------------------------------------------
-- Igual que antes, con dos cambios: se cierra también desde UNKNOWN (es lo que
-- hace la conciliación cuando la consulta de estado decide), y lo devuelto no
-- puede pasar de lo cobrado.
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
  v_amount bigint;
  v_next public.payment_status;
begin
  select * into v_refund from public.payment_refunds where id = p_refund_id for update;
  if v_refund.id is null then
    raise exception 'La devolución no existe' using errcode = 'no_data_found';
  end if;

  -- Idempotente: cerrar dos veces la misma devolución no suma dos veces.
  if v_refund.status not in ('REQUESTED', 'UNKNOWN') then
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
            jsonb_build_object('refund_id', p_refund_id, 'from', v_refund.status,
                               'failure_reason', coalesce(p_details ->> 'failure_reason', 'provider_rejected')));

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

  v_amount := coalesce(p_refunded, v_refund.amount);

  -- Lo devuelto nunca supera lo cobrado. La restricción de `payments` ya lo
  -- impide; esto lo dice antes, sin tocar nada, y con un mensaje legible.
  select coalesce(sum(amount), 0) into v_confirmed
    from public.payment_refunds
   where payment_id = v_refund.payment_id and status = 'CONFIRMED';

  if v_confirmed + v_amount > v_payment.amount then
    raise exception 'Confirmar esta devolución dejaría lo devuelto (%) por encima de lo cobrado (%)',
      v_confirmed + v_amount, v_payment.amount
      using errcode = 'check_violation';
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
         amount             = v_amount,
         payload            = coalesce(p_details, '{}'::jsonb)
   where id = p_refund_id;

  -- Lo devuelto en el pago es la suma de lo CONFIRMADO. Nunca lo solicitado.
  v_confirmed := v_confirmed + v_amount;

  v_next := case
    when v_confirmed >= v_payment.amount then 'REFUNDED'::public.payment_status
    else 'PARTIALLY_REFUNDED'::public.payment_status
  end;

  update public.payments
     set refunded_amount = v_confirmed,
         status          = v_next,
         updated_at      = now()
   where id = v_refund.payment_id;

  -- Devolución total: el pago al trabajador no puede seguir en la cola.
  if v_next = 'REFUNDED' then
    perform app_private.hold_payout_on_full_refund(v_refund.payment_id);
  end if;

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
          jsonb_build_object('refund_id', p_refund_id, 'kind', p_kind, 'from', v_refund.status,
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
  'Cierra una devolución pedida o por confirmar con la respuesta del proveedor. Idempotente. Lo devuelto no supera lo cobrado. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 7. Dejarla por confirmar
-- -----------------------------------------------------------------------------
-- La llama la aplicación cuando el banco no dio una respuesta en firme, y la
-- conciliación cada vez que consulta y no puede decidir: la primera vez la
-- pasa a UNKNOWN con su motivo; las siguientes solo anotan la consulta.
create or replace function public.mark_payment_refund_unknown(
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
  v_refund public.payment_refunds;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'Falta el motivo por el que no se sabe el resultado'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_refund from public.payment_refunds where id = p_refund_id for update;
  if v_refund.id is null then
    raise exception 'La devolución no existe' using errcode = 'no_data_found';
  end if;

  if v_refund.status = 'REQUESTED' then
    update public.payment_refunds
       set status             = 'UNKNOWN',
           outcome_unknown_at = now(),
           unknown_reason     = btrim(p_reason),
           dispatched_at      = coalesce(dispatched_at, now()),
           payload            = payload || coalesce(p_details, '{}'::jsonb)
     where id = p_refund_id;

    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
    values (v_refund.requested_by, 'payment_refund_outcome_unknown', 'payments', v_refund.payment_id,
            jsonb_build_object('refund_id', p_refund_id, 'reason', btrim(p_reason)));

    return jsonb_build_object('outcome', 'applied', 'refund_status', 'UNKNOWN');
  end if;

  if v_refund.status = 'UNKNOWN' then
    update public.payment_refunds
       set last_checked_at   = now(),
           last_check_result = btrim(p_reason),
           payload           = payload || jsonb_build_object('last_check', coalesce(p_details, '{}'::jsonb))
     where id = p_refund_id;
    return jsonb_build_object('outcome', 'checked', 'refund_status', 'UNKNOWN');
  end if;

  -- Ya tiene resultado final: no se toca.
  return jsonb_build_object('outcome', 'duplicate', 'refund_status', v_refund.status);
end;
$$;

revoke execute on function public.mark_payment_refund_unknown(uuid, text, jsonb) from public;
revoke execute on function public.mark_payment_refund_unknown(uuid, text, jsonb) from anon;
revoke execute on function public.mark_payment_refund_unknown(uuid, text, jsonb) from authenticated;
grant execute on function public.mark_payment_refund_unknown(uuid, text, jsonb) to service_role;

comment on function public.mark_payment_refund_unknown is
  'Pasa una devolución pedida a UNKNOWN con su motivo; sobre una UNKNOWN solo anota la última consulta. Nunca toca una final. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 8. La cola de devoluciones por conciliar
-- -----------------------------------------------------------------------------
-- Las abiertas sin movimiento desde hace `p_min_age_minutes`: las que siguen
-- pedidas (la aplicación decide si ya es tarde para que estén en vuelo) y las
-- que están por confirmar. Con lo que hace falta para decidir sin leer nada
-- más que el token.
create or replace function public.refunds_pending_reconciliation(
  p_min_age_minutes integer default 10,
  p_limit           integer default 50,
  p_payment_id      uuid default null
)
returns table (
  refund_id          uuid,
  payment_id         uuid,
  status             public.refund_status,
  amount             bigint,
  requested_at       timestamptz,
  dispatched_at      timestamptz,
  outcome_unknown_at timestamptz,
  last_checked_at    timestamptz,
  provider           text,
  environment        text,
  payment_amount     bigint,
  refunded_amount    bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.payment_id, r.status, r.amount, r.requested_at, r.dispatched_at,
         r.outcome_unknown_at, r.last_checked_at, r.provider, r.environment,
         p.amount, p.refunded_amount
    from public.payment_refunds r
    join public.payments p on p.id = r.payment_id
   where r.status in ('REQUESTED', 'UNKNOWN')
     and (p_payment_id is null or r.payment_id = p_payment_id)
     and coalesce(r.last_checked_at, r.outcome_unknown_at, r.requested_at)
           <= now() - make_interval(mins => greatest(p_min_age_minutes, 0))
   order by r.requested_at
   limit least(greatest(p_limit, 1), 200);
$$;

revoke execute on function public.refunds_pending_reconciliation(integer, integer, uuid) from public;
revoke execute on function public.refunds_pending_reconciliation(integer, integer, uuid) from anon;
revoke execute on function public.refunds_pending_reconciliation(integer, integer, uuid) from authenticated;
grant execute on function public.refunds_pending_reconciliation(integer, integer, uuid) to service_role;

comment on function public.refunds_pending_reconciliation is
  'Devoluciones REQUESTED o UNKNOWN sin movimiento reciente, con el importe del pago y lo ya devuelto. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 9. Cerrarla a mano, con lo que muestra el portal de Transbank
-- -----------------------------------------------------------------------------
-- Para cuando la consulta de estado no alcanza: fuera de la ventana en que
-- Webpay responde, o con un estado que no cuadra con lo registrado. Cierra por
-- la MISMA vía que el banco (`settle_payment_refund`), con quién y por qué.
create or replace function public.resolve_unknown_refund(
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
  v_refund public.payment_refunds;
  v_payment public.payments;
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

  select * into v_refund from public.payment_refunds where id = p_refund_id for update;
  if v_refund.id is null then
    raise exception 'La devolución no existe' using errcode = 'no_data_found';
  end if;

  -- Un doble clic sobre algo ya resuelto no es un error: devuelve lo que hay.
  if v_refund.status in ('CONFIRMED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object('outcome', 'duplicate', 'refund_status', v_refund.status);
  end if;
  -- Una pedida sigue en manos de la aplicación (o de la conciliación, que la
  -- pasa a UNKNOWN si se quedó colgada): no se decide por encima de ella.
  if v_refund.status <> 'UNKNOWN' then
    raise exception 'Solo se resuelve a mano una devolución con resultado por confirmar'
      using errcode = 'check_violation';
  end if;

  if p_succeeded then
    if p_kind is null or p_kind not in ('REVERSED', 'NULLIFIED') then
      raise exception 'Indica si el portal la muestra como reversa o como anulación'
        using errcode = 'invalid_parameter_value';
    end if;
    -- La reversa deshace la transacción entera: solo puede ser por el total y
    -- sin nada devuelto antes.
    if p_kind = 'REVERSED' then
      select * into v_payment from public.payments where id = v_refund.payment_id;
      if v_payment.refunded_amount <> 0 or v_refund.amount <> v_payment.amount then
        raise exception 'Una reversa es siempre por el total y sin devoluciones anteriores: esta tiene que ser una anulación'
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  update public.payment_refunds
     set resolved_by     = auth.uid(),
         resolution_note = btrim(p_note)
   where id = p_refund_id;

  if p_succeeded then
    v_result := public.settle_payment_refund(
      p_refund_id, true, p_kind, v_refund.amount,
      jsonb_build_object('source', 'manual', 'resolved_by', auth.uid(), 'note', btrim(p_note))
    );
  else
    v_result := public.settle_payment_refund(
      p_refund_id, false, null, null,
      jsonb_build_object('source', 'manual', 'resolved_by', auth.uid(), 'note', btrim(p_note),
                         'failure_reason', 'manual_not_executed')
    );
  end if;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (auth.uid(), 'payment_refund_resolved_manually', 'payments', v_refund.payment_id,
          jsonb_build_object('refund_id', p_refund_id, 'succeeded', p_succeeded,
                             'kind', p_kind, 'note', btrim(p_note)));

  return v_result;
end;
$$;

revoke execute on function public.resolve_unknown_refund(uuid, boolean, text, text) from public;
revoke execute on function public.resolve_unknown_refund(uuid, boolean, text, text) from anon;
grant execute on function public.resolve_unknown_refund(uuid, boolean, text, text) to authenticated;

comment on function public.resolve_unknown_refund is
  'Solo administración: cierra una devolución UNKNOWN como hecha (reversa o anulación) o no hecha, con lo que muestra el portal de Transbank. Cierra por settle_payment_refund.';


-- -----------------------------------------------------------------------------
-- 10. Lo que ve administración de cada pago
-- -----------------------------------------------------------------------------
-- Las columnas de siempre, en el mismo orden, y al final la devolución abierta
-- del pago, si la hay, con lo que explica por qué sigue abierta.
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
         abierta.last_check_result  as open_refund_last_check_result
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
  'Pagos para el panel de administración, con la devolución abierta de cada uno. Sin token: el token autoriza operaciones y no sale de la base.';


-- -----------------------------------------------------------------------------
-- 11. La cola «Devoluciones por procesar»
-- -----------------------------------------------------------------------------
-- Suma las devoluciones abiertas (en curso o por confirmar). Y una disputa
-- resuelta con importe a favor del cliente deja de contar cuando ese importe ya
-- está devuelto o en camino: antes seguía en la cola para siempre.
create or replace function public.admin_pending_reviews()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check_ins integer;
  v_disputes integer;
  v_payouts integer;
  v_refunds integer;
  v_extensions integer;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_check_ins from public.assignment_check_ins where review_status = 'PENDING';
  select count(*) into v_disputes from public.disputes where status in ('OPEN', 'UNDER_REVIEW');
  select count(*) into v_payouts from public.payouts where status in ('PENDING', 'APPROVED', 'HELD');
  -- Tres fuentes de dinero por devolver: un cobro que llegó cuando el trabajo
  -- ya no lo esperaba, una disputa resuelta a favor del cliente cuyo importe
  -- no se ha devuelto, y una devolución abierta (en curso o por confirmar).
  select (select count(*) from public.payments where status = 'UNDER_REVIEW')
       + (select count(*) from public.disputes d
           where d.status = 'RESOLVED'
             and coalesce(d.refund_amount, 0) > (
               select coalesce(sum(r.amount), 0) from public.payment_refunds r
                where r.dispute_id = d.id and r.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED')))
       + (select count(*) from public.payment_refunds where status in ('REQUESTED', 'UNKNOWN'))
    into v_refunds;
  select count(*) into v_extensions from public.job_extensions where status = 'PENDING' and expires_at > now();

  return jsonb_build_object(
    'check_ins', v_check_ins,
    'disputes', v_disputes,
    'payouts', v_payouts,
    'refunds', v_refunds,
    'extensions', v_extensions
  );
end;
$$;

revoke execute on function public.admin_pending_reviews() from public, anon;
grant execute on function public.admin_pending_reviews() to authenticated;


-- -----------------------------------------------------------------------------
-- 12. Invariantes: lo comprometido tampoco supera lo cobrado
-- -----------------------------------------------------------------------------
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
     and p.created_at <= now() - make_interval(
           days => app_private.reconciliation_window_days() + 1
         )

  union all
  -- Lo confirmado más lo que está en curso o por confirmar no puede pasar de
  -- lo cobrado: si pasa, una de las abiertas devolvería dinero que no entró.
  select 'refund_committed_over_amount', p.id
    from public.payments p
   where (select coalesce(sum(r.amount), 0) from public.payment_refunds r
           where r.payment_id = p.id and r.status in ('REQUESTED', 'UNKNOWN', 'CONFIRMED'))
         > p.amount;
$$;

revoke execute on function app_private.refund_invariant_violations() from public;
revoke execute on function app_private.refund_invariant_violations() from anon;
grant execute on function app_private.refund_invariant_violations() to authenticated;
