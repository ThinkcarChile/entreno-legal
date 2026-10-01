-- =============================================================================
-- HagoTuFila · El total de una oferta lo calcula la base
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado sobre la base: el
-- trabajador inserta su oferta con `estimated_total`, la concesión de INSERT
-- incluye esa columna, y nada lo relacionaba con la tarifa por hora ni con la
-- duración del trabajo. `accept_job_offer` copia ese número a
-- `assignments.agreed_total`, y de ahí sale lo que se le cobra al cliente.
-- Por la API, una oferta de 9.000 por hora para dos horas podía decir que el
-- total era 900.000: el listado y la comparación de ofertas muestran la tarifa
-- por hora, y lo que se cobraba no tenía por qué salir de ella.
--
-- Ahora el total lo calcula un disparador BEFORE INSERT OR UPDATE con la misma
-- fórmula que la aplicación (`proratePerHour`, src/lib/utils/money.ts):
--
--     round(hourly_rate × estimated_duration_minutes / 60)
--
-- sobre la duración del propio trabajo. Lo que llegue en la columna se ignora
-- y se reescribe. El privilegio de INSERT sobre la columna se mantiene para no
-- romper a quien todavía la envía; su valor ya no decide nada.
--
-- Mientras la oferta está pendiente, el total sigue a la duración: si el
-- cliente edita el trabajo (`update_open_job`) y cambia las horas, las ofertas
-- pendientes se recalculan con la tarifa que cada trabajador propuso. El
-- disparador lee la duración con la fila del trabajo bloqueada: una oferta
-- que llega mientras el cliente la cambia espera y usa la nueva. Cuando la
-- oferta deja de estar pendiente su precio queda congelado
-- (`freeze_offer_terms`, …000200 de la Etapa 2), y este disparador no lo toca:
-- cualquier intento de cambiarlo sigue chocando con esa guarda.
--
-- Lo mismo vale para lo que se cobra. `accept_job_offer` lee la oferta ANTES
-- de bloquear la fila del trabajo, y toma la duración de la fila ya bloqueada.
-- Si el cliente edita la duración (`update_open_job`) y acepta a la vez, la
-- aceptación espera el bloqueo con el total viejo en la mano y lo copia junto
-- a la duración nueva: comprobado sobre la base, una asignación de 600
-- minutos a 10.000 por hora quedaba con `agreed_total` = 10.000, y eso era lo
-- que se cobraba. Por eso un segundo disparador, BEFORE INSERT en
-- `assignments`, fija `agreed_total` con la misma fórmula sobre la tarifa y la
-- duración que la propia asignación registra. Solo al insertar: después nadie
-- con sesión puede escribir esas columnas, y el pago y la transferencia salen
-- de ese número.
--
-- Las ofertas pendientes que ya existan se recalculan aquí mismo. Una oferta
-- aceptada antes de esta migración conserva su importe: está congelada y su
-- asignación ya lo copió. Si alguna difiere de la fórmula, lo muestra la
-- consulta de docs/BASE-DE-DATOS.md, § «Total de una oferta».
-- =============================================================================

create or replace function app_private.offer_total(p_hourly_rate bigint, p_minutes integer)
returns bigint
language sql
immutable
set search_path = public, pg_temp
as $$
  select round(p_hourly_rate::numeric * p_minutes / 60)::bigint;
$$;

comment on function app_private.offer_total(bigint, integer) is
  'Total de una oferta: tarifa por hora × minutos / 60, redondeado al peso. Igual que proratePerHour.';

create or replace function app_private.compute_offer_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_minutes integer;
begin
  -- Precio congelado: lo decide freeze_offer_terms, no este disparador.
  if tg_op = 'UPDATE' and old.status <> 'PENDING' then
    return new;
  end if;

  -- Con la fila del trabajo bloqueada: si el cliente está cambiando la
  -- duración (`update_open_job` tiene el bloqueo), la oferta espera y se
  -- calcula con la duración nueva. Sin el bloqueo se calculaba con la vieja y
  -- quedaba así, porque `sync_pending_offer_totals` todavía no la veía. No
  -- agrega un bloqueo nuevo, lo adelanta: `job_offers_count` toma esta misma
  -- fila al final de cada escritura en `job_offers`. NO KEY UPDATE, como ese
  -- UPDATE, para no chocar con el FOR KEY SHARE de las claves foráneas.
  select j.estimated_duration_minutes into v_minutes
    from public.jobs j
   where j.id = new.job_id
     for no key update;

  if v_minutes is null then
    raise exception 'El trabajo no existe' using errcode = 'foreign_key_violation';
  end if;

  new.estimated_total := app_private.offer_total(new.hourly_rate, v_minutes);
  return new;
end;
$$;

comment on function app_private.compute_offer_total() is
  'El total de una oferta pendiente se calcula desde su tarifa y la duración del trabajo; lo enviado se ignora.';

-- El nombre importa: los disparadores BEFORE de una misma tabla corren en orden
-- alfabético, y este tiene que ir antes que `job_offers_freeze_terms`.
drop trigger if exists job_offers_compute_total on public.job_offers;
create trigger job_offers_compute_total
  before insert or update on public.job_offers
  for each row execute function app_private.compute_offer_total();

-- Si el cliente cambia la duración mientras el trabajo recibe ofertas, el
-- total de cada oferta pendiente se recalcula con la tarifa de esa oferta.
create or replace function app_private.sync_pending_offer_totals()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.estimated_duration_minutes is distinct from old.estimated_duration_minutes then
    update public.job_offers
       set estimated_total = app_private.offer_total(hourly_rate, new.estimated_duration_minutes)
     where job_id = new.id
       and status = 'PENDING';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_sync_offer_totals on public.jobs;
create trigger jobs_sync_offer_totals
  after update of estimated_duration_minutes on public.jobs
  for each row execute function app_private.sync_pending_offer_totals();

-- Lo que se cobra: el importe acordado sale de la tarifa y la duración que la
-- asignación registra, no de un total leído antes de bloquear el trabajo.
-- SECURITY DEFINER para que la clave de servicio, que también inserta
-- asignaciones (pruebas de navegador), no necesite EXECUTE sobre offer_total.
create or replace function app_private.compute_agreed_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.agreed_total := app_private.offer_total(new.agreed_hourly_rate, new.agreed_duration_minutes);
  return new;
end;
$$;

comment on function app_private.compute_agreed_total() is
  'El importe acordado de una asignación nueva es tarifa × duración / 60 de la propia asignación; lo enviado se ignora.';

drop trigger if exists assignments_agreed_total on public.assignments;
create trigger assignments_agreed_total
  before insert on public.assignments
  for each row execute function app_private.compute_agreed_total();

revoke all on function app_private.offer_total(bigint, integer) from public, anon, authenticated;
revoke all on function app_private.compute_offer_total() from public, anon, authenticated;
revoke all on function app_private.sync_pending_offer_totals() from public, anon, authenticated;
revoke all on function app_private.compute_agreed_total() from public, anon, authenticated;

-- Las pendientes que ya existan.
update public.job_offers o
   set estimated_total = app_private.offer_total(o.hourly_rate, j.estimated_duration_minutes)
  from public.jobs j
 where j.id = o.job_id
   and o.status = 'PENDING'
   and o.estimated_total <> app_private.offer_total(o.hourly_rate, j.estimated_duration_minutes);
