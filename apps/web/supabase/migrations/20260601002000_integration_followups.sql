-- =============================================================================
-- HagoTuFila · Lo que quedó entre dos grupos al integrar la tercera tanda
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- Dos defectos que ninguno de los grupos podía cerrar solo, porque cada uno
-- tocaba funciones que eran del otro:
--
-- 1. DEFECTO: transferir al trabajador con un cobro del tiempo adicional en
--    vuelo. El cliente abre Webpay para pagar la hora extra; mientras está en
--    el formulario, la administración ve el payout APPROVED y registra la
--    transferencia por el neto sin la hora extra. Cuando Webpay confirma,
--    `guard_payment_settlement` (20260601001700) ya no toca un payout PAID y
--    manda ese cobro a revisión (`payout_already_settled`): el dinero no se
--    pierde, pero al trabajador no le llega por esta vía y la única salida que
--    queda es devolvérselo al cliente. Ahora `mark_payout_paid` espera: no
--    transfiere mientras un cobro del tiempo adicional de esa asignación está
--    autorizado sin asentar, o creado hace menos de 30 minutos (el formulario
--    de Webpay vence antes). Un cobro creado y abandonado no frena la
--    transferencia más de eso.
--
-- 2. DEFECTO: el trabajador leía `held_reason` en sus ganancias. Ese texto lo
--    escribe la base para la administración y desde 20260601001400 trae las
--    cifras del cliente («el cliente pagó…, se le devolvió…») o códigos
--    internos de revisión. La pantalla ya mostraba una frase genérica, pero la
--    vista `worker_earnings` lo seguía entregando por la API. Ahora la vista
--    da el texto entero solo a la administración y, al trabajador, la misma
--    frase genérica que la pantalla.
--
--    Lo que esto NO cierra: `payouts` sigue legible por su trabajador con
--    `held_reason`, porque la administración lee esa columna con su sesión
--    desde la misma tabla. Separar el texto del trabajador del de la
--    administración exige otra columna; está anotado en PAGOS.md §9.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. No transferir con un cobro del tiempo adicional en vuelo
-- -----------------------------------------------------------------------------

create or replace function app_private.extension_charge_in_flight_blocker(p_assignment_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_total bigint;
begin
  select count(*), coalesce(sum(p.amount), 0)
    into v_count, v_total
    from public.payments p
   where p.assignment_id = p_assignment_id
     and p.purpose = 'EXTENSION'
     and (p.status = 'AUTHORIZED'
          or (p.status = 'CREATED'
              and app_private.payment_window_start(p.id, p.buy_order, p.created_at)
                    > now() - interval '30 minutes'));

  if v_count = 0 then
    return null;
  end if;

  return 'El cliente está pagando el tiempo adicional (' || app_private.format_clp(v_total)
    || '). Espera a que Webpay lo confirme o lo rechace —a lo más 30 minutos— y transfiere '
    || 'después: si lo confirma, se suma a este pago al trabajador';
end;
$$;

comment on function app_private.extension_charge_in_flight_blocker(uuid) is
  'Motivo para no transferir mientras un cobro del tiempo adicional está autorizado sin asentar o creado hace menos de 30 minutos. NULL si no hay ninguno.';

revoke all on function app_private.extension_charge_in_flight_blocker(uuid) from public, anon, authenticated;

-- Idéntica a 20260601001610 salvo lo marcado [Nuevo].
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

  -- [Nuevo]
  v_blocker := app_private.extension_charge_in_flight_blocker(p_assignment_id);
  if v_blocker is not null then
    return v_blocker;
  end if;

  v_blocker := app_private.payout_bonus_blocker(p_assignment_id);
  if v_blocker is not null then
    return v_blocker;
  end if;

  v_blocker := app_private.payout_overrun(p_assignment_id);
  if v_blocker is not null then
    return 'Las cifras de este trabajo no cuadran: ' || v_blocker
      || '. No se transfiere: deja el pago retenido y ajústalo con «Ajustar» en /admin/payouts '
      || '(lo que de verdad le corresponde al trabajador) o revisa el caso con soporte';
  end if;

  return app_private.payout_environment_blocker(p_assignment_id);
end;
$$;

revoke all on function app_private.payout_money_blocker(uuid) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. Las ganancias del trabajador sin el texto de la administración
-- -----------------------------------------------------------------------------
-- Mismas columnas, en el mismo orden, que en 20260401000200: solo cambia lo que
-- trae `held_reason` a quien no es administración.
create or replace view public.worker_earnings
with (security_invoker = true) as
  select p.id,
         p.worker_id,
         p.assignment_id,
         a.job_id,
         j.reference        as job_reference,
         j.title            as job_title,
         j.starts_at        as job_starts_at,
         a.status           as assignment_status,
         p.status,
         p.gross_amount,
         p.commission_amount,
         p.bonus_amount,
         p.net_amount,
         p.currency,
         p.bank_reference,
         case
           when app_private.is_admin() then p.held_reason
           when p.status = 'HELD' then 'Retenido mientras soporte revisa el caso'
           else null
         end                as held_reason,
         p.approved_at,
         p.paid_at,
         p.created_at
    from public.payouts p
    join public.assignments a on a.id = p.assignment_id
    join public.jobs j on j.id = a.job_id;

comment on view public.worker_earnings is
  'Lo que el trabajador ha ganado, por trabajo y estado. No afirma ninguna transferencia que no esté registrada con su referencia. El motivo de una retención, entero, solo para la administración.';

grant select on public.worker_earnings to authenticated;
