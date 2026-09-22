-- =============================================================================
-- HagoTuFila · Bloque 5 · 200 · Devoluciones e invariantes del dinero
-- =============================================================================
-- Dos correcciones que encontró la batería de pruebas, no una revisión a ojo.
--
-- 1. `payout_without_paid_payment` exigía que el pago estuviera EXACTAMENTE en
--    PAID. En cuanto existió la primera devolución parcial, el pago pasó a
--    PARTIALLY_REFUNDED y el invariante empezó a señalar como rota una
--    situación perfectamente sana: se devolvió una parte al cliente y el
--    trabajador sigue cobrando el resto.
--
-- 2. Y al mirarlo apareció el hueco de verdad, que el invariante viejo no
--    cubría: **una devolución TOTAL dejaba el pago al trabajador intacto y
--    pagable**. El cliente recuperaba todo su dinero y el trabajador seguía en
--    la cola de transferencia. Nadie lo habría visto hasta pagar dos veces el
--    mismo trabajo, una a cada lado.
--
-- La devolución total ahora retiene el pago al trabajador. Se retiene y no se
-- cancela a propósito: cancelarlo es una decisión de negocio —puede que el
-- trabajador sí hiciera el trabajo y la devolución venga de otra cosa— y esa
-- decisión la toma una persona, con el motivo escrito.
--
-- Esta migración también vuelve a crear las dos funciones de devolución. La
-- versión anterior llamaba a `app_private.audit`, que no existe: en este
-- esquema la auditoría se escribe insertando en `audit_logs`. Los proyectos
-- que recibieron la migración 100 antes de esta corrección se ponen al día
-- aquí.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Retener el pago al trabajador cuando se devuelve todo
-- -----------------------------------------------------------------------------
create or replace function app_private.hold_payout_on_full_refund(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_payout public.payouts;
begin
  select * into v_payment from public.payments where id = p_payment_id;
  if v_payment.id is null or v_payment.refunded_amount < v_payment.amount then
    return;
  end if;

  select * into v_payout from public.payouts where payment_id = p_payment_id for update;
  if v_payout.id is null then
    return;
  end if;

  -- Un pago al trabajador ya transferido no se puede deshacer desde aquí: el
  -- dinero salió del banco. Queda para resolución manual, y el invariante lo
  -- señala para que nadie lo pase por alto.
  if v_payout.status in ('PAID', 'CANCELLED', 'HELD') then
    return;
  end if;

  update public.payouts
     set status = 'HELD',
         held_reason = 'El cliente recibió la devolución total de este trabajo',
         updated_at = now()
   where id = v_payout.id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (null, 'payout_held_after_full_refund', 'payouts', v_payout.id,
          jsonb_build_object('payment_id', p_payment_id,
                             'refunded_amount', v_payment.refunded_amount));
end;
$$;

revoke execute on function app_private.hold_payout_on_full_refund(uuid) from public;
revoke execute on function app_private.hold_payout_on_full_refund(uuid) from anon;
revoke execute on function app_private.hold_payout_on_full_refund(uuid) from authenticated;

comment on function app_private.hold_payout_on_full_refund is
  'Retiene el pago al trabajador cuando el cliente recibió la devolución total. No lo cancela: eso lo decide una persona.';


-- -----------------------------------------------------------------------------
-- 2. Cerrar la devolución, ahora con la auditoría correcta y la retención
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- 3. Pedir la devolución, con la auditoría correcta
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

  if v_payment.status not in ('PAID', 'UNDER_REVIEW', 'PARTIALLY_REFUNDED') then
    raise exception 'El pago está en % y no admite devolución', v_payment.status
      using errcode = 'check_violation';
  end if;

  if v_payment.provider_token is null then
    raise exception 'El pago no tiene token del proveedor: no se puede devolver'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_already
    from public.payment_refunds
   where payment_id = p_payment_id and status in ('REQUESTED', 'CONFIRMED');

  if v_already + p_amount > v_payment.amount then
    raise exception 'La devolución excede el saldo: cobrado %, comprometido %, pedido %',
      v_payment.amount, v_already, p_amount
      using errcode = 'check_violation';
  end if;

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


-- -----------------------------------------------------------------------------
-- 4. Los invariantes, al día con las devoluciones
-- -----------------------------------------------------------------------------
create or replace function app_private.payment_invariant_violations()
returns table (rule text, entity_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Payout sobre trabajo cancelado o en cancelación.
  select 'payout_on_cancelled_job', po.id
    from public.payouts po
    join public.assignments a on a.id = po.assignment_id
    join public.jobs j on j.id = a.job_id
   where j.status in ('CANCELLED', 'CANCELLATION_PENDING')

  union all
  select 'payout_on_cancelled_assignment', po.id
    from public.payouts po
    join public.assignments a on a.id = po.assignment_id
   where a.status in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER')

  union all
  -- Payout PAGABLE sin un pago detrás que de verdad se cobró.
  --
  -- Dos matices que el invariante original no tenía, y que hicieron falta en
  -- cuanto existieron las devoluciones:
  --
  -- · PARTIALLY_REFUNDED cuenta como pago detrás: se devolvió una parte al
  --   cliente y el resto sigue siendo del trabajador.
  -- · Un payout retenido o cancelado no va a mover dinero, así que no es una
  --   violación: es justo el estado en que queda tras una devolución total.
  --   El caso peligroso —devuelto todo y el payout aún en la cola— lo cubre
  --   la regla siguiente.
  select 'payout_without_paid_payment', po.id
    from public.payouts po
   where po.status not in ('HELD', 'CANCELLED')
     and not exists (
       select 1 from public.payments p
        where p.assignment_id = po.assignment_id and p.purpose = 'JOB'
          and p.status in ('PAID', 'PARTIALLY_REFUNDED')
     )

  union all
  -- Devolución total con el pago al trabajador todavía pagable.
  --
  -- Es el hueco que encontró la batería: el cliente recuperó todo su dinero y
  -- el trabajador seguía en la cola de transferencia.
  select 'payable_payout_on_refunded_payment', po.id
    from public.payouts po
    join public.payments p on p.id = po.payment_id
   where p.status = 'REFUNDED'
     and po.status in ('PENDING', 'APPROVED', 'PROCESSING')

  union all
  select 'paid_payment_on_cancelled_job', p.id
    from public.payments p
    join public.jobs j on j.id = p.job_id
   where p.status = 'PAID' and j.status = 'CANCELLED'

  union all
  select 'enabled_assignment_on_cancelled_job', a.id
    from public.assignments a
    join public.jobs j on j.id = a.job_id
   where j.status in ('CANCELLED', 'CANCELLATION_PENDING')
     and a.status not in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER', 'AWAITING_PAYMENT')

  union all
  select 'cancelled_job_with_live_assignment', a.id
    from public.assignments a
    join public.jobs j on j.id = a.job_id
   where j.status = 'CANCELLED'
     and a.status in ('CONFIRMED', 'ON_THE_WAY', 'CHECKED_IN', 'IN_PROGRESS', 'HANDOFF_COMPLETED');
$$;

revoke execute on function app_private.payment_invariant_violations() from public;
revoke execute on function app_private.payment_invariant_violations() from anon;
grant execute on function app_private.payment_invariant_violations() to authenticated;
