-- =============================================================================
-- HagoTuFila · Bloque 5 · 400 · Un pago en revisión congela el pago al trabajador
-- =============================================================================
-- Tercera aparición de la misma familia de defectos, y la que cierra el patrón.
--
--   · Devolución total  → el payout seguía pagable   (migración 200)
--   · Retroceso de PAID → el payout quedaba huérfano (migración 300)
--   · Pago a revisión   → el payout seguía pagable   (esta)
--
-- El caso concreto: administración marca un pago como UNDER_REVIEW desde
-- `/admin/pagos` —porque el importe no cuadra, porque llegó tras una
-- cancelación, porque hay algo raro— y el pago al trabajador se queda en
-- PENDING, listo para aprobarse y transferirse. Es decir: se duda del dinero
-- que entró y se sigue adelante con el dinero que sale.
--
-- La regla, ahora en un solo sitio y para cualquier vía: si el pago del
-- cliente deja de estar sano, el pago al trabajador se retiene. Retener y no
-- cancelar, como en la devolución total: puede que el trabajador sí hiciera el
-- trabajo, y decidir eso es de una persona.
--
-- Se aplica también a FAILED, por el mismo motivo: un pago que acabó fallando
-- no puede dejar atrás un payout pagable.
-- =============================================================================

create or replace function app_private.hold_payout_on_unhealthy_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status not in ('UNDER_REVIEW', 'FAILED', 'REFUNDED') then
    return new;
  end if;

  v_reason := case new.status
    when 'UNDER_REVIEW' then
      'El pago del cliente está en revisión' ||
      coalesce(': ' || nullif(new.review_reason, ''), '')
    when 'FAILED' then 'El pago del cliente no se completó'
    else 'El cliente recibió la devolución total de este trabajo'
  end;

  -- Solo los pagables. Uno ya transferido no se deshace desde aquí —el dinero
  -- salió del banco— y uno retenido o cancelado ya está donde debe.
  update public.payouts
     set status      = 'HELD',
         held_reason = v_reason,
         updated_at  = now()
   where payment_id = new.id
     and status in ('PENDING', 'APPROVED', 'PROCESSING');

  if found then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
    select null, 'payout_held_unhealthy_payment', 'payouts', po.id,
           jsonb_build_object('payment_id', new.id, 'payment_status', new.status,
                              'reason', v_reason)
      from public.payouts po
     where po.payment_id = new.id and po.status = 'HELD';
  end if;

  return new;
end;
$$;

drop trigger if exists payments_hold_payout_on_review on public.payments;

-- Después de que la fila quede escrita: aquí ya se sabe en qué estado acabó,
-- incluida la corrección que hubiera hecho la guarda de liquidación.
create trigger payments_hold_payout_on_review
  after update on public.payments
  for each row execute function app_private.hold_payout_on_unhealthy_payment();

comment on function app_private.hold_payout_on_unhealthy_payment is
  'Retiene el pago al trabajador cuando el pago del cliente pasa a revisión, falla o se devuelve entero. No lo cancela.';
