-- =============================================================================
-- HagoTuFila · La ventana de disputa retiene de verdad, y lo que nadie cerraba
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- 1. DEFECTO: se podía transferir al trabajador DURANTE la ventana de disputa.
--
--    `approve_job_completion` deja el payout en APPROVED en el mismo instante en
--    que abre la ventana (`dispute_deadline_at` = ahora + 12 h), y
--    `mark_payout_paid` no miraba esa fecha. Reproducido sobre la base:
--
--      a. el cliente aprueba; el payout queda APPROVED, ventana abierta;
--      b. administración registra la transferencia → PAID;
--      c. el cliente reporta un problema dentro de su plazo → la disputa se abre;
--      d. `hold_payout_on_dispute` solo retiene PENDING o APPROVED: el PAID
--         sigue PAID, y a las dos partes se les avisa «El pago queda retenido
--         mientras tanto», que es falso.
--
--    Si la disputa se resolvía a favor del cliente, la devolución salía del
--    bolsillo de la plataforma: el trabajador ya había cobrado.
--
--    Ahora una transferencia solo se registra cuando no hay disputa viva y,
--    o bien la ventana ya cerró sobre un trabajo COMPLETED, o bien una disputa
--    fue resuelta por la administración (su decisión es final). Y sobre un
--    trabajo ya resuelto no se abre otra disputa: no habría nada que retener.
--
-- 2. Si el cliente nunca aprobaba ni reclamaba, el payout quedaba en PENDING
--    para siempre (docs/EJECUCION.md §15). Ahora, pasadas
--    `auto_approve_after_hours` desde que el trabajador pidió el cierre, el
--    sistema aprueba con la MISMA regla que la aprobación manual —el bono se
--    otorga salvo que el cliente diga lo contrario— y la ventana de disputa
--    empieza a correr desde ahí. El cliente no pierde su derecho a reclamar:
--    lo conserva durante toda la ventana.
--
-- 3. Ningún proceso marcaba EXPIRED un trabajo publicado cuya hora de inicio
--    ya pasó sin trabajador. Seguía en el listado público aceptando ofertas
--    para un trámite que ya no podía hacerse.
--
-- 4. `app_private.run_scheduled_tasks()` agrupa las tareas que viven enteras en
--    la base (estas dos y `expire_stale_payments`). Si la extensión pg_cron
--    está disponible —lo está en Supabase alojado— se programa cada 10
--    minutos. Si no, no se finge: queda sin programar y la conciliación con el
--    proveedor sigue en `/admin/pagos` o en el cron del hosting.
-- =============================================================================

alter table public.platform_settings
  add column if not exists auto_approve_after_hours integer not null default 12,
  add column if not exists job_expiry_grace_hours integer not null default 2;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_auto_approve_range') then
    alter table public.platform_settings
      add constraint platform_settings_auto_approve_range
      check (auto_approve_after_hours between 1 and 336);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_job_expiry_range') then
    alter table public.platform_settings
      add constraint platform_settings_job_expiry_range
      check (job_expiry_grace_hours between 0 and 168);
  end if;
end $$;

comment on column public.platform_settings.auto_approve_after_hours is
  'Horas desde que el trabajador pide el cierre hasta que el sistema aprueba solo, si el cliente no aprobó ni reclamó.';
comment on column public.platform_settings.job_expiry_grace_hours is
  'Horas tras la hora de inicio para dar por vencido un trabajo publicado sin trabajador.';

-- -----------------------------------------------------------------------------
-- 1a. Transferencia: solo fuera de la ventana y sin disputa viva
-- -----------------------------------------------------------------------------

create or replace function app_private.payout_transfer_blocker(p_assignment_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
begin
  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    return 'Hay una disputa abierta sobre este trabajo: el pago queda retenido hasta resolverla';
  end if;

  -- Una disputa resuelta es la decisión final de la administración.
  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status = 'RESOLVED') then
    return null;
  end if;

  select * into v_a from public.assignments where id = p_assignment_id;

  if v_a.status <> 'COMPLETED' or v_a.dispute_deadline_at is null then
    return 'El trabajo todavía no está aprobado: no corre la ventana para reportar problemas';
  end if;

  if v_a.dispute_deadline_at > now() then
    return 'El plazo para reportar problemas vence el '
           || to_char(v_a.dispute_deadline_at at time zone 'America/Santiago', 'DD-MM-YYYY "a las" HH24:MI')
           || ' (hora de Chile). La transferencia se registra después';
  end if;

  return null;
end;
$$;

comment on function app_private.payout_transfer_blocker is
  'Motivo por el que todavía no se puede transferir el pago de una asignación, o NULL si se puede.';

create or replace function public.mark_payout_paid(
  p_payout_id      uuid,
  p_bank_reference text,
  p_paid_at        timestamptz default null,
  p_notes          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p public.payouts;
  v_a public.assignments;
  v_when timestamptz;
  v_blocker text;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración registra una transferencia'
      using errcode = 'insufficient_privilege';
  end if;
  if char_length(coalesce(trim(p_bank_reference), '')) < 4 then
    raise exception 'Hace falta la referencia de la transferencia' using errcode = 'check_violation';
  end if;

  v_when := coalesce(p_paid_at, now());
  if v_when > now() + interval '1 day' then
    raise exception 'La fecha de la transferencia no puede estar en el futuro'
      using errcode = 'check_violation';
  end if;

  select * into v_p from public.payouts where id = p_payout_id for update;
  if v_p.id is null then
    raise exception 'El pago al trabajador no existe' using errcode = 'no_data_found';
  end if;
  if v_p.status = 'PAID' then
    -- Idempotente: registrar dos veces la misma transferencia no la duplica.
    return jsonb_build_object('payout_status', 'PAID', 'repeated', true);
  end if;
  if v_p.status <> 'APPROVED' then
    raise exception 'Un pago en estado % no se puede transferir todavía', v_p.status
      using errcode = 'check_violation';
  end if;

  -- Bajo el mismo cerrojo que `open_dispute` toma sobre la asignación: una
  -- disputa que se abre ahora mismo espera a esta transacción y la ve, o esta
  -- la ve a ella. No hay hueco entre comprobar y transferir.
  select * into v_a from public.assignments where id = v_p.assignment_id for update;

  v_blocker := app_private.payout_transfer_blocker(v_p.assignment_id);
  if v_blocker is not null then
    raise exception '%', v_blocker using errcode = 'check_violation';
  end if;

  -- APPROVED → PROCESSING → PAID: la máquina de estados no se salta ni aquí.
  update public.payouts set status = 'PROCESSING', updated_at = now() where id = p_payout_id;
  update public.payouts
     set status = 'PAID',
         bank_reference = trim(p_bank_reference),
         paid_at = v_when,
         notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes),
         updated_at = now()
   where id = p_payout_id;

  perform app_private.notify_user(
    v_p.worker_id, 'PAYOUT_PAID', 'Registramos tu transferencia',
    'Referencia: ' || trim(p_bank_reference),
    '/mis-trabajos/' || v_p.assignment_id, v_a.job_id);

  return jsonb_build_object('payout_status', 'PAID', 'repeated', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- 1b. Sobre un trabajo ya resuelto no se abre otra disputa
-- -----------------------------------------------------------------------------
-- Tras una resolución, el trabajo queda CLOSED y el payout puede transferirse.
-- Una disputa nueva avisaría «el pago queda retenido» sin poder retener nada:
-- el mismo engaño que arriba, por otra puerta.

create or replace function app_private.guard_dispute_after_resolution()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.disputes d
              where d.assignment_id = new.assignment_id and d.status = 'RESOLVED') then
    raise exception 'Este trabajo ya tuvo una disputa resuelta por la administración. Escríbenos a soporte'
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.payouts p
              where p.assignment_id = new.assignment_id and p.status = 'PAID') then
    raise exception 'El pago de este trabajo ya se transfirió. Escríbenos a soporte'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists disputes_guard_after_resolution on public.disputes;
create trigger disputes_guard_after_resolution
  before insert on public.disputes
  for each row execute function app_private.guard_dispute_after_resolution();

-- -----------------------------------------------------------------------------
-- 2. Aprobación: un solo núcleo para la manual y la automática
-- -----------------------------------------------------------------------------
-- Lo que hace aprobar vive en un solo sitio, para que la aprobación automática
-- no pueda divergir de la manual con el tiempo. La función pública conserva su
-- firma, sus comprobaciones y sus mensajes.

create or replace function app_private.approve_completion_core(
  p_assignment_id uuid,
  p_bonus_awarded boolean,
  p_automatic     boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_window integer;
  v_auto_hours integer;
  v_deadline timestamptz;
  v_payout public.payouts;
  v_bonus boolean;
begin
  -- Quien llama ya tomó los cerrojos (trabajo y asignación) y comprobó el estado.
  select * into v_a from public.assignments where id = p_assignment_id;
  select * into v_j from public.jobs where id = v_a.job_id;

  select dispute_window_hours, auto_approve_after_hours
    into v_window, v_auto_hours
    from public.platform_settings where id;
  v_deadline := now() + make_interval(hours => v_window);
  v_bonus := v_a.bonus_amount > 0 and coalesce(p_bonus_awarded, true);

  update public.assignments
     set status = 'COMPLETED',
         completed_at = now(),
         dispute_deadline_at = v_deadline,
         bonus_awarded = case when v_a.bonus_amount > 0 then v_bonus else null end,
         updated_at = now()
   where id = p_assignment_id;

  update public.jobs set status = 'COMPLETED', updated_at = now() where id = v_j.id;

  -- El payout pasa a APROBADO. Transferirlo sigue esperando a que cierre la
  -- ventana: lo exige `mark_payout_paid`.
  select * into v_payout from public.payouts where assignment_id = p_assignment_id for update;

  if v_payout.id is not null and v_payout.status = 'PENDING' then
    update public.payouts
       set status = 'APPROVED',
           approved_at = now(),
           bonus_amount = case when v_bonus then bonus_amount else 0 end,
           net_amount = case when v_bonus then net_amount else net_amount - v_payout.bonus_amount end,
           updated_at = now()
     where id = v_payout.id;
  end if;

  if p_automatic then
    perform app_private.timeline_event(
      v_j.id, p_assignment_id, null, 'SYSTEM',
      'Trabajo aprobado automáticamente',
      'El cliente no aprobó ni reportó un problema en ' || v_auto_hours
        || ' horas. El plazo para reportar uno sigue abierto ' || v_window || ' horas más.',
      'completion_auto_approved');

    perform app_private.notify_user(
      v_a.worker_id, 'JOB_APPROVED', 'Tu trabajo quedó aprobado',
      'Se aprobó automáticamente. El pago se transfiere cuando venza el plazo de reclamo.',
      '/mis-trabajos/' || p_assignment_id, v_j.id);

    perform app_private.notify_user(
      v_a.client_id, 'JOB_APPROVED', 'Aprobamos el trabajo por ti',
      'No recibimos tu respuesta en ' || v_auto_hours || ' horas. Si algo salió mal, tienes '
        || v_window || ' horas para reportarlo.',
      '/mis-trabajos/publicados/' || v_j.id, v_j.id);
  else
    perform app_private.timeline_event(
      v_j.id, p_assignment_id, v_a.client_id, 'SYSTEM',
      'Trabajo aprobado por el cliente',
      'El pago al trabajador quedó liberado para su transferencia.',
      'completion_approved');

    perform app_private.notify_user(
      v_a.worker_id, 'JOB_APPROVED', 'El cliente aprobó el trabajo',
      'Tu pago quedó aprobado. Ya puedes dejar tu reseña.',
      '/mis-trabajos/' || p_assignment_id, v_j.id);

    perform app_private.notify_user(
      v_a.client_id, 'NEW_REVIEW', 'Cuéntanos cómo te fue',
      'Tu reseña ayuda a quien contrate después.',
      '/mis-trabajos/' || p_assignment_id, v_j.id);
  end if;

  perform app_private.refresh_worker_stats(v_a.worker_id);

  return jsonb_build_object(
    'assignment_status', 'COMPLETED',
    'repeated', false,
    'dispute_deadline_at', v_deadline,
    'payout_status', case when v_payout.id is null then null else 'APPROVED' end
  );
end;
$$;

create or replace function public.approve_job_completion(
  p_assignment_id uuid,
  p_bonus_awarded boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'client');

  if v_a.status = 'COMPLETED' then
    return jsonb_build_object('assignment_status', 'COMPLETED', 'repeated', true);
  end if;

  if v_a.status not in ('HANDOFF_COMPLETED', 'IN_PROGRESS') then
    raise exception 'Todavía no corresponde aprobar este trabajo (está en %)', v_a.status
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.disputes d
              where d.assignment_id = p_assignment_id and d.status in ('OPEN', 'UNDER_REVIEW')) then
    raise exception 'Hay una disputa abierta: la resuelve la administración'
      using errcode = 'check_violation';
  end if;

  return app_private.approve_completion_core(p_assignment_id, p_bonus_awarded, false);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2b. Aprobación automática
-- -----------------------------------------------------------------------------

create or replace function app_private.auto_approve_completions(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hours integer;
  v_candidate record;
  v_a public.assignments;
  v_done integer := 0;
begin
  select auto_approve_after_hours into v_hours from public.platform_settings where id;

  for v_candidate in
    select a.id, a.job_id
      from public.assignments a
     where a.status = 'HANDOFF_COMPLETED'
       and a.handoff_completed_at <= now() - make_interval(hours => v_hours)
     order by a.handoff_completed_at
     limit greatest(p_limit, 0)
  loop
    -- Mismo orden de cerrojos que el resto del sistema: trabajo, luego
    -- asignación. Y se vuelve a mirar todo bajo cerrojo: el cliente pudo
    -- aprobar o reclamar entre la consulta de arriba y ahora.
    perform 1 from public.jobs where id = v_candidate.job_id for update;
    select * into v_a from public.assignments where id = v_candidate.id for update;

    if v_a.status <> 'HANDOFF_COMPLETED'
       or v_a.handoff_completed_at > now() - make_interval(hours => v_hours) then
      continue;
    end if;

    if exists (select 1 from public.disputes d
                where d.assignment_id = v_a.id and d.status in ('OPEN', 'UNDER_REVIEW')) then
      continue;
    end if;

    perform app_private.approve_completion_core(v_a.id, true, true);
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

comment on function app_private.auto_approve_completions is
  'Aprueba los trabajos cuyo cierre pidió el trabajador hace más de auto_approve_after_hours, sin respuesta ni disputa del cliente.';

-- -----------------------------------------------------------------------------
-- 3. Caducidad de trabajos publicados sin trabajador
-- -----------------------------------------------------------------------------

create or replace function app_private.expire_unassigned_jobs(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_grace integer;
  v_job public.jobs;
  v_done integer := 0;
begin
  select job_expiry_grace_hours into v_grace from public.platform_settings where id;

  for v_job in
    select j.*
      from public.jobs j
     where j.status = 'PUBLISHED'
       and j.starts_at < now() - make_interval(hours => v_grace)
     order by j.starts_at
     limit greatest(p_limit, 0)
     for update skip locked
  loop
    -- Bajo cerrojo puede haber cambiado: alguien aceptó una oferta justo ahora.
    if v_job.status <> 'PUBLISHED'
       or exists (select 1 from public.assignments a where a.job_id = v_job.id) then
      continue;
    end if;

    update public.jobs set status = 'EXPIRED', updated_at = now() where id = v_job.id;

    update public.job_offers
       set status = 'EXPIRED', updated_at = now()
     where job_id = v_job.id and status = 'PENDING';

    perform app_private.notify_user(
      v_job.client_id, 'JOB_EXPIRED', 'Tu trabajo venció sin trabajador',
      '"' || v_job.title || '" pasó su hora de inicio sin una oferta aceptada. Puedes publicarlo otra vez.',
      '/mis-trabajos/publicados/' || v_job.id, v_job.id);

    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

comment on function app_private.expire_unassigned_jobs is
  'Marca EXPIRED los trabajos publicados cuya hora de inicio pasó (más job_expiry_grace_hours) sin asignación.';

-- -----------------------------------------------------------------------------
-- 4. Una sola entrada para las tareas programadas de la base
-- -----------------------------------------------------------------------------

create or replace function app_private.run_scheduled_tasks()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_approved integer;
  v_expired integer;
  v_payments jsonb;
begin
  v_approved := app_private.auto_approve_completions();
  v_expired := app_private.expire_unassigned_jobs();
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    into v_payments
    from public.expire_stale_payments() x;

  return jsonb_build_object(
    'aprobados_automaticamente', v_approved,
    'trabajos_vencidos', v_expired,
    'pagos_fuera_de_ventana', v_payments
  );
end;
$$;

comment on function app_private.run_scheduled_tasks is
  'Tareas periódicas que viven enteras en la base. La conciliación con el proveedor de pago NO está aquí: necesita hablar con Transbank y corre en la aplicación.';

revoke all on function app_private.approve_completion_core(uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function app_private.auto_approve_completions(integer) from public, anon, authenticated;
revoke all on function app_private.expire_unassigned_jobs(integer) from public, anon, authenticated;
revoke all on function app_private.run_scheduled_tasks() from public, anon, authenticated;
revoke all on function app_private.payout_transfer_blocker(uuid) from public, anon, authenticated;
grant execute on function app_private.payout_transfer_blocker(uuid) to service_role;
grant execute on function app_private.run_scheduled_tasks() to service_role;

-- Programación con pg_cron, solo si existe. Supabase alojado la trae; un
-- PostgreSQL local normalmente no. No se instala a ciegas ni se falla por ella.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    if exists (select 1 from cron.job where jobname = 'hagotufila-tareas-programadas') then
      perform cron.unschedule('hagotufila-tareas-programadas');
    end if;
    perform cron.schedule(
      'hagotufila-tareas-programadas',
      '*/10 * * * *',
      'select app_private.run_scheduled_tasks()'
    );
  else
    raise notice 'pg_cron no está disponible: las tareas programadas quedan sin programar';
  end if;
end $$;
