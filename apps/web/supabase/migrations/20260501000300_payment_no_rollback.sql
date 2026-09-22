-- =============================================================================
-- HagoTuFila · Bloque 5 · 300 · Un pago cobrado no vuelve a estar «en vuelo»
-- =============================================================================
-- Lo encontró la prueba de navegador del pago, forzando el estado con la clave
-- de servicio: un pago en PAID volvía a CREATED sin que nada se quejara, y el
-- pago al trabajador que ese PAID había creado se quedaba huérfano —PENDING,
-- apuntando a un pago que ya no decía estar cobrado—.
--
-- `guard_payment_settlement` ya impedía PAID → FAILED y REFUNDED → cualquiera.
-- Faltaba el camino hacia atrás: PAID o AUTHORIZED de vuelta a PENDING o
-- CREATED. Era el único hueco por el que se podía llegar a un payout sin pago
-- detrás sin que ninguna guarda lo notara.
--
-- Va en un disparador propio y no dentro de la guarda existente a propósito:
-- es una regla de una línea, universal y sin excepciones, y meterla en una
-- función de cien líneas que decide sobre cancelaciones y extensiones la
-- haría más difícil de leer sin ganar nada.
--
-- Sin exención para nadie: tampoco para el rol de servicio. Ese es el punto.
-- Una guarda que el propio sistema puede saltarse no protege de un guion mal
-- escrito, que es justo de lo que hay que protegerse aquí.
-- =============================================================================

create or replace function app_private.guard_payment_no_rollback()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- De cobrado o autorizado no se vuelve «en vuelo». Si hay que deshacer un
  -- cobro, es una devolución (payment_refunds) o una revisión (UNDER_REVIEW),
  -- que dejan rastro. Volver a CREATED no deja ninguno.
  if old.status in ('PAID', 'AUTHORIZED')
     and new.status in ('PENDING', 'CREATED') then
    raise exception
      'Un pago en % no vuelve a %: usa una devolución o déjalo en revisión',
      old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Un pago devuelto tampoco retrocede. La guarda de liquidación ya lo dice
  -- para los estados que ella mira; aquí se cierra para todos.
  if old.status in ('REFUNDED', 'PARTIALLY_REFUNDED')
     and new.status in ('PENDING', 'CREATED', 'AUTHORIZED') then
    raise exception 'Un pago devuelto no vuelve a %', new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists payments_no_rollback on public.payments;

-- `a_` en el nombre para que corra ANTES que las demás guardas: PostgreSQL
-- dispara los BEFORE en orden alfabético, y esta comprobación es la más barata
-- y la que invalida el resto.
create trigger a_payments_no_rollback
  before update on public.payments
  for each row execute function app_private.guard_payment_no_rollback();

comment on function app_private.guard_payment_no_rollback is
  'Impide que un pago cobrado, autorizado o devuelto vuelva a un estado en vuelo. Sin exención para el rol de servicio.';
