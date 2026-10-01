-- =============================================================================
-- HagoTuFila · Un cobro de prueba no se paga con dinero real
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría:
--
--   Con NODE_ENV=production, PAYMENT_PROVIDER=transbank y TRANSBANK_ENVIRONMENT
--   sin definir, la aplicación tomaba el ambiente de integración por omisión,
--   sin decir nada. Webpay respondía de verdad —a tarjetas de prueba—, el pago
--   quedaba PAID con `environment = 'integration'`, el trabajo se habilitaba,
--   se creaba el payout y, vencida la ventana, administración lo registraba
--   transferido: dinero real a cambio de un cobro que nunca existió.
--
--   La aplicación ya no opera Webpay así: `src/lib/payments/transbank/config.ts`
--   exige el ambiente escrito cuando NODE_ENV=production. Esto es la segunda
--   línea, en la base: `mark_payout_paid` se niega a transferir sobre un pago
--   del trabajo cuyo `environment` no sea 'production'. Un pago sin
--   `environment` —los del proveedor simulado anteriores a Webpay— cuenta como
--   no productivo.
--
--   Las bases de desarrollo y de pruebas (staging) SÍ transfieren sobre pagos
--   simulados o de integración: es lo que recorren las pruebas. Para ellas está
--   `platform_settings.allow_non_production_payouts`, en FALSE por omisión.
--   Ponerla en TRUE es un acto explícito, en SQL, sobre una base que no es la
--   de producción. Desde una sesión de la aplicación —tampoco la de
--   administración, que sí puede escribir otras columnas de esa fila— no se
--   cambia.
--
-- Un pago de producción se transfiere como siempre: sujeto a que el cobro esté
-- sano (20260601000800) y a la ventana de disputa (20260601000100).
-- =============================================================================

alter table public.platform_settings
  add column if not exists allow_non_production_payouts boolean not null default false;

comment on column public.platform_settings.allow_non_production_payouts is
  'Solo bases de desarrollo o de pruebas (staging): en TRUE, mark_payout_paid transfiere sobre pagos simulados o del ambiente de integración de Webpay. En producción, FALSE siempre. Se cambia en SQL; nunca desde una sesión de la aplicación.';

-- Quién la cambia. `platform_settings` admite UPDATE de la administración por
-- RLS (`platform_settings_admin`), pensado para tolerancias como la comisión o
-- la ventana. Esta columna no es una tolerancia: abre la puerta a pagar con
-- dinero real un cobro de prueba. Una sesión robada de administración no puede
-- abrirla; el editor SQL y la clave de servicio, sí.
create or replace function app_private.guard_non_production_payouts_flag()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.allow_non_production_payouts is distinct from old.allow_non_production_payouts
     and auth.uid() is not null then
    raise exception 'allow_non_production_payouts no se cambia desde la aplicación: se decide en SQL sobre la base entera, y solo en una base de desarrollo o de pruebas'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function app_private.guard_non_production_payouts_flag is
  'Impide cambiar platform_settings.allow_non_production_payouts con una sesión de usuario, también de administración.';

drop trigger if exists platform_settings_guard_payout_flag on public.platform_settings;
create trigger platform_settings_guard_payout_flag
  before update on public.platform_settings
  for each row execute function app_private.guard_non_production_payouts_flag();

-- ¿El pago del trabajo es dinero de verdad?
create or replace function app_private.payout_environment_blocker(p_assignment_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
  v_allowed boolean;
begin
  v_payment := app_private.payout_job_payment(p_assignment_id);

  -- Sin pago lo dice `job_payment_blocker`, antes que esto.
  if v_payment.id is null or v_payment.environment = 'production' then
    return null;
  end if;

  select allow_non_production_payouts into v_allowed from public.platform_settings where id;
  if coalesce(v_allowed, false) then
    return null;
  end if;

  return 'El pago del cliente es del ambiente '
    || coalesce('«' || v_payment.environment || '»', 'simulado (sin ambiente registrado)')
    || ', no de producción: ese cobro no movió dinero real y no se transfiere dinero real por él. '
    || 'Si esta es una base de desarrollo o de pruebas, se habilita en SQL con '
    || 'platform_settings.allow_non_production_payouts; en producción, nunca';
end;
$$;

comment on function app_private.payout_environment_blocker is
  'Motivo si el pago del trabajo no es de producción y la base no admite transferir sobre pagos de prueba, o NULL.';

-- Idéntica a 20260601000800 más el ambiente, al final: si el cobro está
-- devuelto o en duda, ese motivo es más útil que el del ambiente.
create or replace function app_private.payout_money_blocker(p_assignment_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_blocker text;
begin
  v_blocker := app_private.job_payment_blocker(app_private.payout_job_payment(p_assignment_id));
  if v_blocker is not null then
    return v_blocker;
  end if;

  v_blocker := app_private.refund_in_flight_blocker(p_assignment_id);
  if v_blocker is not null then
    return v_blocker;
  end if;

  v_blocker := app_private.payout_overrun(p_assignment_id);
  if v_blocker is not null then
    return 'Las cifras de este trabajo no cuadran: ' || v_blocker
      || '. No se transfiere: deja el pago retenido y revisa el caso con soporte';
  end if;

  return app_private.payout_environment_blocker(p_assignment_id);
end;
$$;

revoke all on function app_private.guard_non_production_payouts_flag() from public, anon, authenticated;
revoke all on function app_private.payout_environment_blocker(uuid) from public, anon, authenticated;
revoke all on function app_private.payout_money_blocker(uuid) from public, anon, authenticated;
