-- =============================================================================
-- HagoTuFila · Una disputa ganada por el cliente deja su devolución pendiente
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado en el código:
-- `resolve_dispute` guarda `refund_amount` tal como llega, y el panel solo lo
-- envía en una resolución PARCIAL. Con CLIENT_WINS llegaba NULL: el payout del
-- trabajador se cancelaba, `refund_amount` quedaba nulo, y la cola de
-- devoluciones —que cuenta las disputas con importe mayor que cero— no lo
-- veía. El cliente ganaba la disputa y el dinero se quedaba en la plataforma
-- sin que ninguna pantalla lo mostrara.
--
-- Ahora, si la resolución es a favor del cliente y no se indica importe, se
-- registra el saldo devolvible del pago del trabajo (lo cobrado menos lo ya
-- devuelto). Se hace con un trigger sobre `disputes` para cubrir cualquier
-- camino que resuelva una disputa, no solo el panel. Un importe explícito se
-- respeta tal cual.
--
-- NO ejecuta la devolución: la deja pendiente en la cola, igual que una
-- resolución parcial. La ejecuta una persona desde /admin/pagos.
-- =============================================================================

create or replace function app_private.default_client_wins_refund()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_refundable bigint;
begin
  if new.status = 'RESOLVED'
     and new.resolution = 'CLIENT_WINS'
     and new.refund_amount is null
     and (old.status is distinct from 'RESOLVED') then
    select greatest(p.amount - p.refunded_amount, 0)
      into v_refundable
      from public.payments p
     where p.assignment_id = new.assignment_id
       and p.purpose = 'JOB'
       and p.status in ('PAID', 'PARTIALLY_REFUNDED')
     order by p.created_at desc
     limit 1;

    new.refund_amount := v_refundable;
  end if;
  return new;
end;
$$;

comment on function app_private.default_client_wins_refund is
  'Con CLIENT_WINS sin importe, la devolución pendiente es el saldo devolvible del pago del trabajo.';

drop trigger if exists disputes_default_client_wins_refund on public.disputes;
create trigger disputes_default_client_wins_refund
  before update on public.disputes
  for each row execute function app_private.default_client_wins_refund();

revoke all on function app_private.default_client_wins_refund() from public, anon, authenticated;
