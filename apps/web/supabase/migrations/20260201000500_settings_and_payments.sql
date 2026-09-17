-- =============================================================================
-- HagoTuFila · Etapa 2 · 500 · Configuración central y Pago Protegido
-- =============================================================================
-- La comisión se guarda en la base y no en el código, por dos motivos:
--   1. La calculan tanto la aplicación (para mostrarla) como la base (para el
--      payout). Dos fuentes distintas terminan divergiendo.
--   2. Cambiarla no puede exigir un despliegue.
--
-- `src/config/platform.ts` conserva los valores por defecto: son la semilla de
-- esta tabla y el respaldo del modo demostración.
-- =============================================================================

create table public.platform_settings (
  id                     boolean primary key default true check (id),
  commission_bps         integer not null default 1400 check (commission_bps between 0 and 5000),
  dispute_window_hours   integer not null default 12 check (dispute_window_hours between 1 and 720),
  min_duration_minutes   integer not null default 30 check (min_duration_minutes >= 15),
  loyalty_points_per_1000 integer not null default 10 check (loyalty_points_per_1000 >= 0),
  currency               char(3) not null default 'CLP',
  updated_at             timestamptz not null default now()
);

comment on table public.platform_settings is
  'Fila única. `id` siempre true: impide que existan dos configuraciones activas.';

create trigger platform_settings_touch
  before update on public.platform_settings
  for each row execute function app_private.touch_updated_at();

insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

alter table public.platform_settings enable row level security;

create policy platform_settings_read on public.platform_settings for select using (true);
create policy platform_settings_admin on public.platform_settings for all
  using (app_private.is_admin()) with check (app_private.is_admin());

grant select on public.platform_settings to anon, authenticated;
grant all on public.platform_settings to service_role;

create or replace function app_private.commission_bps()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select commission_bps from public.platform_settings where id;
$$;

-- -----------------------------------------------------------------------------
-- Iniciar el Pago Protegido de un trabajo.
--
-- Los montos se calculan aquí, desde la asignación. El cliente nunca envía el
-- total a cobrar: si lo hiciera, bastaría manipular la petición para pagar menos.
-- -----------------------------------------------------------------------------
create or replace function public.start_protected_payment(p_assignment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment public.assignments;
  v_existing public.payments;
  v_total bigint;
  v_payment_id uuid;
begin
  select * into v_assignment from public.assignments where id = p_assignment_id for update;

  if v_assignment is null then
    raise exception 'La asignación no existe' using errcode = 'no_data_found';
  end if;

  if v_assignment.client_id <> auth.uid() then
    raise exception 'Solo el cliente puede pagar este trabajo'
      using errcode = 'insufficient_privilege';
  end if;

  if v_assignment.status not in ('AWAITING_PAYMENT') then
    raise exception 'Este trabajo ya no está esperando pago' using errcode = 'check_violation';
  end if;

  -- Un pago ya confirmado no se vuelve a cobrar; uno en curso se reutiliza.
  select * into v_existing
    from public.payments
   where assignment_id = p_assignment_id and purpose = 'JOB'
     and status in ('PENDING', 'CREATED', 'AUTHORIZED', 'PAID')
   order by created_at desc
   limit 1;

  if v_existing is not null then
    return v_existing.id;
  end if;

  -- Pago por trabajo + bono comprometido. El bono se cobra por adelantado y solo
  -- se liquida al trabajador si el objetivo se cumple.
  v_total := v_assignment.agreed_total + coalesce(v_assignment.bonus_amount, 0);

  insert into public.payments (
    job_id, assignment_id, client_id, purpose, status, amount, currency, provider
  ) values (
    v_assignment.job_id, p_assignment_id, v_assignment.client_id, 'JOB', 'PENDING',
    v_total, v_assignment.currency,
    coalesce(current_setting('app.payment_provider', true), 'mock')
  )
  returning id into v_payment_id;

  update public.jobs
     set status = 'PAYMENT_PENDING', updated_at = now()
   where id = v_assignment.job_id and status = 'OFFER_ACCEPTED';

  return v_payment_id;
end;
$$;

grant execute on function public.start_protected_payment(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Payout: se crea en cuanto el pago se confirma, con el desglose ya calculado.
--
-- Queda en PENDING; la aprobación y la transferencia son manuales en esta etapa.
-- -----------------------------------------------------------------------------
create or replace function app_private.create_payout_for_assignment(p_assignment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment public.assignments;
  v_bps integer := app_private.commission_bps();
  v_commission bigint;
  v_net bigint;
  v_payout_id uuid;
begin
  select * into v_assignment from public.assignments where id = p_assignment_id;
  if v_assignment is null then
    return null;
  end if;

  if exists (select 1 from public.payouts where assignment_id = p_assignment_id) then
    return null;
  end if;

  -- La comisión se aplica sobre el servicio, nunca sobre el bono: el bono llega
  -- completo a quien cumplió el objetivo.
  v_commission := round(v_assignment.agreed_total::numeric * v_bps / 10000);
  v_net := v_assignment.agreed_total - v_commission + coalesce(v_assignment.bonus_amount, 0);

  insert into public.payouts (
    assignment_id, worker_id, status, gross_amount, commission_amount,
    bonus_amount, net_amount, currency
  ) values (
    p_assignment_id, v_assignment.worker_id, 'PENDING', v_assignment.agreed_total,
    v_commission, coalesce(v_assignment.bonus_amount, 0), v_net, v_assignment.currency
  )
  returning id into v_payout_id;

  return v_payout_id;
end;
$$;

create or replace function app_private.on_payment_paid_create_payout()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'PAID' and old.status is distinct from 'PAID'
     and new.purpose = 'JOB' and new.assignment_id is not null then
    perform app_private.create_payout_for_assignment(new.assignment_id);
  end if;
  return new;
end;
$$;

create trigger payments_create_payout
  after update on public.payments
  for each row execute function app_private.on_payment_paid_create_payout();

-- -----------------------------------------------------------------------------
-- Vista de resumen para la pantalla de Pago Protegido.
-- Evita que el desglose se recalcule a mano en la interfaz.
-- -----------------------------------------------------------------------------
create view public.assignment_payment_summary
with (security_invoker = true)
as
  select a.id                            as assignment_id,
         a.job_id,
         a.client_id,
         a.worker_id,
         a.status                        as assignment_status,
         a.agreed_total                  as service_amount,
         coalesce(a.bonus_amount, 0)     as bonus_amount,
         a.currency,
         s.commission_bps,
         round(a.agreed_total::numeric * s.commission_bps / 10000)::bigint as commission_amount,
         (a.agreed_total
            - round(a.agreed_total::numeric * s.commission_bps / 10000)::bigint
            + coalesce(a.bonus_amount, 0))::bigint                          as worker_receives,
         (a.agreed_total + coalesce(a.bonus_amount, 0))::bigint             as client_total,
         p.id                            as payment_id,
         p.status                        as payment_status
    from public.assignments a
    cross join public.platform_settings s
    left join lateral (
      select id, status from public.payments
       where assignment_id = a.id and purpose = 'JOB'
       order by created_at desc limit 1
    ) p on true;

grant select on public.assignment_payment_summary to authenticated;
