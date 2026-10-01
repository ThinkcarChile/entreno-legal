-- =============================================================================
-- HagoTuFila · El trabajador no lee el pago del cliente
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado sobre la base: la política
-- `payments_read` dejaba leer la fila del pago al cliente, a administración Y
-- al trabajador de la asignación. Por PostgREST el trabajador pedía los cuatro
-- últimos dígitos de la tarjeta del cliente, el código de autorización, la
-- orden de compra, el código de respuesta, las cuotas y el resto de lo que
-- contestó Webpay. La migración …000700 retiró el token, la URL y la sesión
-- por columna, y dejó escrito este riesgo como abierto.
--
-- Y una columna que …000700 no vio: `provider_transaction_id`. Con Webpay Plus
-- guarda el MISMO token que `provider_token` (`createPayment` devuelve el token
-- como identificador de la transacción), así que el token seguía saliendo por
-- REST a quien pudiera leer la fila.
--
-- Qué cambia:
--
-- · `payments_read`: el cliente que pagó y administración. El trabajador ya no
--   ve ninguna fila de `payments`, ni directa ni a través de las vistas con
--   `security_invoker` (`admin_payments`, `assignment_payment_summary`).
-- · `provider_transaction_id` sale de la concesión de columnas de
--   `authenticated`, como `provider_token`. Ninguna lectura con sesión la usa;
--   las que la necesitan van con la clave de servicio.
-- · `assignment_payment_states(asignaciones)`: lo que cualquiera de las dos
--   partes necesita saber de los pagos de su trabajo —de qué son, si están
--   pagados y cuándo— sin nada del proveedor ni de la tarjeta. Es lo que leen
--   ahora las pantallas del trabajo.
--
-- `assignment_payment_summary` no cambia: el trabajador sigue recibiendo el
-- desglose, ahora con `payment_id` y `payment_status` en nulo; la aplicación
-- no los lee de ahí.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La fila del pago: quien pagó y administración
-- -----------------------------------------------------------------------------
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments
  for select using (
    client_id = auth.uid()
    or app_private.is_admin()
  );


-- -----------------------------------------------------------------------------
-- 2. El identificador de la transacción es el token
-- -----------------------------------------------------------------------------
-- La concesión es por columna desde …000700, así que basta retirar esta.
revoke select (provider_transaction_id) on public.payments from authenticated;


-- -----------------------------------------------------------------------------
-- 3. Lo que las dos partes necesitan saber del pago de su trabajo
-- -----------------------------------------------------------------------------
-- Las pantallas del trabajo lo leían con la sesión, columna a columna desde
-- `payments`: el estado es lo que decide si el trabajador puede ponerse en
-- camino. Aquí sale solo eso y lo que lo acompaña, para el cliente y el
-- trabajador de cada asignación y para administración. Ni dígitos, ni código
-- de autorización, ni orden de compra, ni token.
create or replace function public.assignment_payment_states(p_assignment_ids uuid[])
returns table (
  id            uuid,
  job_id        uuid,
  assignment_id uuid,
  extension_id  uuid,
  client_id     uuid,
  purpose       public.payment_purpose,
  status        public.payment_status,
  amount        bigint,
  provider      text,
  authorized_at timestamptz,
  paid_at       timestamptz,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.job_id, p.assignment_id, p.extension_id, p.client_id, p.purpose,
         p.status, p.amount, p.provider, p.authorized_at, p.paid_at, p.created_at
    from public.payments p
    join public.assignments a on a.id = p.assignment_id
   where p.assignment_id = any (p_assignment_ids)
     and (a.client_id = auth.uid() or a.worker_id = auth.uid() or app_private.is_admin())
   order by p.created_at desc;
$$;

revoke execute on function public.assignment_payment_states(uuid[]) from public;
revoke execute on function public.assignment_payment_states(uuid[]) from anon;
grant execute on function public.assignment_payment_states(uuid[]) to authenticated;

comment on function public.assignment_payment_states is
  'Pagos de las asignaciones de quien llama (cliente o trabajador) o de cualquiera para administración: estado, propósito, importe y fechas. Nada del proveedor ni de la tarjeta.';

-- Las pantallas del trabajo buscan los pagos por asignación, y no había índice.
create index if not exists payments_assignment_idx
  on public.payments (assignment_id, created_at desc)
  where assignment_id is not null;
