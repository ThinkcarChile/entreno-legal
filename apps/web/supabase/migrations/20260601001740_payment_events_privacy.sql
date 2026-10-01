-- =============================================================================
-- HagoTuFila · La historia del pago no dice quién administra ni qué anotó
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría cruzada y comprobado sobre la base:
-- `resolve_unknown_refund` cierra a mano una devolución por confirmar y le pasa
-- a `settle_payment_refund` sus detalles —`source: manual`, `resolved_by` (el
-- UUID de quien administra) y `note` (lo que escribió sobre el portal de
-- Transbank)—. `settle_payment_refund` copiaba esos detalles tal cual en
-- `payment_events.payload`, y la política `payment_events_read` le entrega al
-- cliente que pagó todos los eventos de su pago. Por REST el cliente leía qué
-- administrador resolvió su devolución y su nota interna: justo lo que
-- 20260601001110 dejó de mostrar («sabía quién administra la plataforma»).
--
-- Ahora el evento lleva los detalles sin `resolved_by` ni `note`. La
-- devolución los conserva (`payment_refunds.resolved_by`, `resolution_note` y
-- `payload`, que solo lee administración) y `audit_logs` también. Los eventos
-- que ya se escribieron así se limpian.
--
-- `settle_attempt_refund` (la devolución de un cobro duplicado) no escribe en
-- `payment_events`: sus detalles van a `payment_attempt_refunds` y a la
-- auditoría, las dos solo de administración. No cambia.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Cerrar una devolución
-- -----------------------------------------------------------------------------
-- Idéntica a 20260601001400 salvo el evento del pago, marcado [Nuevo].
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
  v_payment_id uuid;
  v_job_id uuid;
  v_assignment_id uuid;
begin
  -- [Nuevo] Sin bloqueo: solo para saber qué bloquear, y en qué orden.
  select payment_id into v_payment_id from public.payment_refunds where id = p_refund_id;
  if v_payment_id is null then
    raise exception 'La devolución no existe' using errcode = 'no_data_found';
  end if;
  select job_id, assignment_id into v_job_id, v_assignment_id
    from public.payments where id = v_payment_id;

  -- [Nuevo] Orden canónico: trabajo → asignación → pagos de la asignación →
  -- la devolución. Es el de `request_payment_refund` y `mark_payout_paid`.
  perform 1 from public.jobs where id = v_job_id for update;
  if v_assignment_id is not null then
    perform 1 from public.assignments where id = v_assignment_id for update;
    perform 1 from public.payments where assignment_id = v_assignment_id order by id for update;
  end if;
  select * into v_payment from public.payments where id = v_payment_id for update;

  select * into v_refund from public.payment_refunds where id = p_refund_id for update;

  -- Idempotente: cerrar dos veces la misma devolución no suma dos veces.
  if v_refund.status not in ('REQUESTED', 'UNKNOWN') then
    return jsonb_build_object(
      'outcome', 'duplicate',
      'refund_status', v_refund.status,
      'payment_status', (select status from public.payments where id = v_refund.payment_id)
    );
  end if;

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

  -- [Nuevo] La historia del pago la lee el cliente que pagó: sin quién de
  -- administración la cerró ni su nota. Las dos quedan en la devolución
  -- (`resolved_by`, `resolution_note`, `payload`) y en `audit_logs`, que solo
  -- lee administración.
  insert into public.payment_events (payment_id, from_status, to_status, provider, provider_event_id, payload)
  values (
    v_refund.payment_id, v_payment.status, v_next, v_refund.provider,
    v_refund.provider_event_id,
    (coalesce(p_details, '{}'::jsonb) - 'resolved_by' - 'note') || jsonb_build_object(
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
  'Cierra una devolución pedida o por confirmar con la respuesta del proveedor. Idempotente. Lo devuelto no supera lo cobrado. Bloquea trabajo → asignación → pagos → devolución. Solo service_role.';


-- -----------------------------------------------------------------------------
-- 2. Los eventos que ya salieron con la nota
-- -----------------------------------------------------------------------------
-- `payment_events` es de solo inserción para los roles de la aplicación; la
-- migración corre como dueña de la tabla. Solo se quitan las dos claves: el
-- resto del evento (qué se devolvió, cuándo, de qué tipo) sigue igual.
update public.payment_events
   set payload = payload - 'resolved_by' - 'note'
 where payload ->> 'source' = 'manual'
   and (payload ? 'resolved_by' or payload ? 'note');
