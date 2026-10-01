-- =============================================================================
-- HagoTuFila · Una fila mala no detiene las tareas programadas
-- =============================================================================
-- Migración correctiva de 20260601000100. No la modifica.
--
-- DEFECTO, encontrado por la auditoría y reproducido sobre la base:
--
--   1. el trabajador pide el cierre (asignación HANDOFF_COMPLETED);
--   2. el cliente reclama en vez de aprobar (trabajo DISPUTED);
--   3. la administración resuelve: el trabajo queda CLOSED y la asignación,
--      sin tocar;
--   4. pasadas 12 h, la aprobación automática la toma como candidata y
--      `approve_completion_core` intenta poner el trabajo en COMPLETED;
--   5. `guard_job_terminal` lanza «Un trabajo cerrado no cambia de estado» y,
--      como nada aislaba esa fila, ABORTA LA PASADA ENTERA: desde ese momento
--      ni la aprobación automática ni la caducidad vuelven a ejecutarse, cada
--      10 minutos, para siempre.
--
-- Tres correcciones, cada una suficiente por sí sola para este caso y
-- necesarias juntas para los que no conocemos:
--
--   · Candidatas: solo asignaciones cuyo trabajo sigue en un estado aprobable
--     y sin ninguna disputa, abierta o resuelta. Una disputa resuelta es la
--     decisión final; no hay nada que aprobar encima.
--   · El núcleo de aprobación no fuerza el estado de un trabajo ya terminal.
--   · Cada fila y cada tarea corren aisladas: un error se registra como
--     WARNING y en el resultado, y el resto sigue.
-- =============================================================================

-- Estados del trabajo sobre los que una aprobación tiene sentido.
create or replace function app_private.job_is_approvable(p_status public.job_status)
returns boolean
language sql
immutable
as $$
  select p_status in ('PAID', 'IN_PROGRESS', 'HANDOFF_COMPLETED')
$$;

-- -----------------------------------------------------------------------------
-- Núcleo de aprobación: no fuerza un trabajo terminal
-- -----------------------------------------------------------------------------
-- Idéntico a 20260601000100 salvo la actualización del trabajo, que ahora solo
-- ocurre si el trabajo está en un estado aprobable.

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

  -- Un trabajo CLOSED, CANCELLED o EXPIRED es terminal: su estado manda.
  update public.jobs set status = 'COMPLETED', updated_at = now()
   where id = v_j.id and app_private.job_is_approvable(status);

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

-- -----------------------------------------------------------------------------
-- Aprobación automática: candidatas correctas y cada una aislada
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
  v_job_status public.job_status;
  v_done integer := 0;
begin
  select auto_approve_after_hours into v_hours from public.platform_settings where id;

  for v_candidate in
    select a.id, a.job_id
      from public.assignments a
      join public.jobs j on j.id = a.job_id
     where a.status = 'HANDOFF_COMPLETED'
       and a.handoff_completed_at <= now() - make_interval(hours => v_hours)
       and app_private.job_is_approvable(j.status)
       and not exists (select 1 from public.disputes d where d.assignment_id = a.id)
     order by a.handoff_completed_at
     limit greatest(p_limit, 0)
  loop
    begin
      -- Mismo orden de cerrojos que el resto del sistema, y todo se vuelve a
      -- mirar bajo cerrojo: el cliente pudo aprobar o reclamar entretanto.
      select status into v_job_status from public.jobs where id = v_candidate.job_id for update;
      select * into v_a from public.assignments where id = v_candidate.id for update;

      if v_a.status <> 'HANDOFF_COMPLETED'
         or v_a.handoff_completed_at > now() - make_interval(hours => v_hours)
         or not app_private.job_is_approvable(v_job_status)
         or exists (select 1 from public.disputes d where d.assignment_id = v_a.id) then
        continue;
      end if;

      perform app_private.approve_completion_core(v_a.id, true, true);
      v_done := v_done + 1;
    exception when others then
      -- Esta fila no se aprueba en esta pasada; las demás sí.
      raise warning 'auto_approve_completions: asignación % omitida: %', v_candidate.id, sqlerrm;
    end;
  end loop;

  return v_done;
end;
$$;

-- -----------------------------------------------------------------------------
-- Caducidad: cada trabajo aislado
-- -----------------------------------------------------------------------------

create or replace function app_private.expire_unassigned_jobs(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_grace integer;
  v_candidate record;
  v_job public.jobs;
  v_done integer := 0;
begin
  select job_expiry_grace_hours into v_grace from public.platform_settings where id;

  for v_candidate in
    select j.id
      from public.jobs j
     where j.status = 'PUBLISHED'
       and j.starts_at < now() - make_interval(hours => v_grace)
     order by j.starts_at
     limit greatest(p_limit, 0)
  loop
    begin
      select * into v_job from public.jobs where id = v_candidate.id for update skip locked;

      -- Bajo cerrojo puede haber cambiado: alguien aceptó una oferta justo ahora,
      -- o la fila la tiene otra transacción (skip locked) y se mira en la próxima.
      if v_job.id is null
         or v_job.status <> 'PUBLISHED'
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
    exception when others then
      raise warning 'expire_unassigned_jobs: trabajo % omitido: %', v_candidate.id, sqlerrm;
    end;
  end loop;

  return v_done;
end;
$$;

-- -----------------------------------------------------------------------------
-- Entrada única: cada tarea aislada, y los errores en el resultado
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
  v_errors jsonb := '[]'::jsonb;
begin
  begin
    v_approved := app_private.auto_approve_completions();
  exception when others then
    v_errors := v_errors || jsonb_build_object('tarea', 'auto_approve_completions', 'error', sqlerrm);
  end;

  begin
    v_expired := app_private.expire_unassigned_jobs();
  exception when others then
    v_errors := v_errors || jsonb_build_object('tarea', 'expire_unassigned_jobs', 'error', sqlerrm);
  end;

  begin
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      into v_payments
      from public.expire_stale_payments() x;
  exception when others then
    v_errors := v_errors || jsonb_build_object('tarea', 'expire_stale_payments', 'error', sqlerrm);
  end;

  if jsonb_array_length(v_errors) > 0 then
    raise warning 'run_scheduled_tasks: % tarea(s) con error: %', jsonb_array_length(v_errors), v_errors;
  end if;

  return jsonb_build_object(
    'aprobados_automaticamente', v_approved,
    'trabajos_vencidos', v_expired,
    'pagos_fuera_de_ventana', v_payments,
    'errores', v_errors
  );
end;
$$;

revoke all on function app_private.job_is_approvable(public.job_status) from public, anon;
revoke all on function app_private.approve_completion_core(uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function app_private.auto_approve_completions(integer) from public, anon, authenticated;
revoke all on function app_private.expire_unassigned_jobs(integer) from public, anon, authenticated;
revoke all on function app_private.run_scheduled_tasks() from public, anon, authenticated;
grant execute on function app_private.run_scheduled_tasks() to service_role;
