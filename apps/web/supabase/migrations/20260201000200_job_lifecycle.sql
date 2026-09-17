-- =============================================================================
-- HagoTuFila · Etapa 2 · 100 · Ciclo de vida del trabajo
-- =============================================================================
-- Reglas que no pueden vivir solo en la interfaz:
--   * Aceptar una oferta es atómico. Dos clics simultáneos no pueden dejar dos
--     trabajadores asignados al mismo trabajo.
--   * El precio de una oferta no cambia después de aceptada.
--   * Los campos críticos de un trabajo se congelan cuando ya hay asignación.
--   * Nadie empieza a trabajar sin pago confirmado.
--
-- Nombres de estado: se reutiliza el enum existente. La equivalencia con el
-- vocabulario de producto es:
--   OPEN     → PUBLISHED
--   ASSIGNED → OFFER_ACCEPTED
--   READY    → PAID
-- =============================================================================

-- -----------------------------------------------------------------------------
-- El precio de una oferta se congela al dejar de estar pendiente.
-- -----------------------------------------------------------------------------
create or replace function app_private.freeze_offer_terms()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'PENDING' then
    if new.hourly_rate is distinct from old.hourly_rate
       or new.estimated_total is distinct from old.estimated_total
       or new.currency is distinct from old.currency then
      raise exception 'No se puede cambiar el precio de una oferta que ya no está pendiente'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger job_offers_freeze_terms
  before update on public.job_offers
  for each row execute function app_private.freeze_offer_terms();

-- -----------------------------------------------------------------------------
-- Campos críticos congelados una vez que hay asignación.
--
-- Cambiar la hora, el lugar o el precio con un trabajador ya comprometido es una
-- renegociación, no una edición. Esta etapa lo bloquea; la siguiente lo convierte
-- en una solicitud de modificación que el trabajador acepta o rechaza.
-- -----------------------------------------------------------------------------
create or replace function app_private.guard_job_edits()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_editable boolean;
begin
  -- La administración y el rol de servicio no pasan por esta guarda.
  if auth.uid() is null or app_private.is_admin() then
    return new;
  end if;

  v_editable := old.status in ('DRAFT', 'PUBLISHED');
  if v_editable then
    return new;
  end if;

  if new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.instructions is distinct from old.instructions
     or new.starts_at is distinct from old.starts_at
     or new.estimated_duration_minutes is distinct from old.estimated_duration_minutes
     or new.hourly_rate is distinct from old.hourly_rate
     or new.bonus_amount is distinct from old.bonus_amount
     or new.bonus_conditions is distinct from old.bonus_conditions
     or new.objective_type is distinct from old.objective_type
     or new.objective_target_position is distinct from old.objective_target_position
     or new.category_id is distinct from old.category_id
     or new.region_code is distinct from old.region_code
     or new.commune_code is distinct from old.commune_code then
    raise exception 'El trabajo ya tiene una oferta aceptada: estos datos no se pueden modificar'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger jobs_guard_edits
  before update on public.jobs
  for each row execute function app_private.guard_job_edits();

-- -----------------------------------------------------------------------------
-- Nadie empieza a trabajar sin pago confirmado.
-- -----------------------------------------------------------------------------
create or replace function app_private.require_payment_before_work()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('ON_THE_WAY', 'CHECKED_IN', 'IN_PROGRESS', 'HANDOFF_COMPLETED', 'COMPLETED')
     and old.status is distinct from new.status then
    if not exists (
      select 1 from public.payments p
       where p.assignment_id = new.id
         and p.purpose = 'JOB'
         and p.status = 'PAID'
    ) then
      raise exception 'El trabajo no puede avanzar sin un pago confirmado'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger assignments_require_payment
  before update on public.assignments
  for each row execute function app_private.require_payment_before_work();

-- -----------------------------------------------------------------------------
-- Elegibilidad del trabajador. Regla centralizada, usada por la RPC y por RLS.
-- -----------------------------------------------------------------------------
create or replace function app_private.worker_can_be_assigned(p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.worker_profiles w
      join public.profiles p on p.id = w.user_id
     where w.user_id = p_worker_id
       and w.verification_status = 'VERIFIED'
       and not p.is_suspended
  );
$$;

grant execute on function app_private.worker_can_be_assigned(uuid) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Aceptar una oferta. Atómico.
--
-- El bloqueo sobre la fila del trabajo serializa dos aceptaciones simultáneas.
-- Además, `assignments.job_id` es UNIQUE y existe un índice único parcial que
-- permite una sola oferta ACCEPTED por trabajo: aunque el bloqueo fallara, la
-- base seguiría rechazando el segundo intento.
-- -----------------------------------------------------------------------------
create or replace function public.accept_job_offer(p_offer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_offer   public.job_offers;
  v_job     public.jobs;
  v_assignment_id uuid;
  v_conversation_id uuid;
begin
  select * into v_offer from public.job_offers where id = p_offer_id;
  if v_offer is null then
    raise exception 'La oferta no existe' using errcode = 'no_data_found';
  end if;

  -- Serializa: cualquier otra aceptación sobre este trabajo espera aquí.
  select * into v_job from public.jobs where id = v_offer.job_id for update;
  if v_job is null then
    raise exception 'El trabajo no existe' using errcode = 'no_data_found';
  end if;

  if v_job.client_id <> auth.uid() then
    raise exception 'Solo el cliente que publicó el trabajo puede aceptar una oferta'
      using errcode = 'insufficient_privilege';
  end if;

  if v_job.status <> 'PUBLISHED' then
    raise exception 'El trabajo ya no está recibiendo ofertas'
      using errcode = 'check_violation';
  end if;

  if v_offer.status <> 'PENDING' then
    raise exception 'La oferta ya no está pendiente' using errcode = 'check_violation';
  end if;

  if not app_private.worker_can_be_assigned(v_offer.worker_id) then
    raise exception 'El trabajador no está verificado o su cuenta está suspendida'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.assignments where job_id = v_job.id) then
    raise exception 'El trabajo ya tiene un trabajador asignado' using errcode = 'unique_violation';
  end if;

  insert into public.assignments (
    job_id, offer_id, worker_id, client_id, status,
    agreed_hourly_rate, agreed_duration_minutes, agreed_total, bonus_amount, currency
  ) values (
    v_job.id, v_offer.id, v_offer.worker_id, v_job.client_id, 'AWAITING_PAYMENT',
    v_offer.hourly_rate, v_job.estimated_duration_minutes, v_offer.estimated_total,
    coalesce(v_job.bonus_amount, 0), v_offer.currency
  )
  returning id into v_assignment_id;

  update public.job_offers
     set status = 'ACCEPTED', responded_at = now()
   where id = v_offer.id;

  update public.job_offers
     set status = 'REJECTED', responded_at = now()
   where job_id = v_job.id and id <> v_offer.id and status = 'PENDING';

  update public.jobs
     set status = 'OFFER_ACCEPTED', updated_at = now()
   where id = v_job.id;

  -- La conversación del trabajo pasa a ser la del trabajador elegido.
  select id into v_conversation_id
    from public.conversations
   where job_id = v_job.id and worker_id = v_offer.worker_id;

  if v_conversation_id is null then
    insert into public.conversations (job_id, assignment_id, client_id, worker_id, offer_id, is_primary)
    values (v_job.id, v_assignment_id, v_job.client_id, v_offer.worker_id, v_offer.id, true)
    returning id into v_conversation_id;
  else
    update public.conversations
       set assignment_id = v_assignment_id, is_primary = true
     where id = v_conversation_id;
  end if;

  update public.conversations
     set is_primary = false
   where job_id = v_job.id and id <> v_conversation_id;

  insert into public.messages (conversation_id, sender_id, message_type, body)
  values (v_conversation_id, null, 'SYSTEM', 'El cliente aceptó la oferta. Falta confirmar el pago para comenzar.');

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (auth.uid(), 'offer_accepted', 'job_offers', v_offer.id,
          jsonb_build_object('assignment_id', v_assignment_id, 'job_id', v_job.id,
                             'worker_id', v_offer.worker_id, 'hourly_rate', v_offer.hourly_rate));

  perform app_private.notify_user(
    v_offer.worker_id, 'OFFER_ACCEPTED',
    'Tu oferta fue aceptada',
    'Te seleccionaron para "' || v_job.title || '". Falta confirmar el pago para comenzar.',
    '/mis-trabajos/' || v_assignment_id, v_job.id
  );

  return v_assignment_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Retirar una oferta.
-- -----------------------------------------------------------------------------
create or replace function public.withdraw_job_offer(p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_offer public.job_offers;
  v_job   public.jobs;
begin
  select * into v_offer from public.job_offers where id = p_offer_id;
  if v_offer is null then
    raise exception 'La oferta no existe' using errcode = 'no_data_found';
  end if;

  if v_offer.worker_id <> auth.uid() then
    raise exception 'Solo quien envió la oferta puede retirarla'
      using errcode = 'insufficient_privilege';
  end if;

  if v_offer.status <> 'PENDING' then
    raise exception 'Solo se puede retirar una oferta pendiente' using errcode = 'check_violation';
  end if;

  update public.job_offers set status = 'WITHDRAWN', responded_at = now() where id = p_offer_id;

  select * into v_job from public.jobs where id = v_offer.job_id;

  perform app_private.notify_user(
    v_job.client_id, 'OFFER_WITHDRAWN',
    'Una oferta fue retirada',
    'Un trabajador retiró su oferta para "' || v_job.title || '".',
    '/mis-trabajos/publicados/' || v_job.id, v_job.id
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Cancelar un trabajo antes de que empiece.
-- -----------------------------------------------------------------------------
create or replace function public.cancel_job(p_job_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
begin
  select * into v_job from public.jobs where id = p_job_id for update;

  if v_job is null then
    raise exception 'El trabajo no existe' using errcode = 'no_data_found';
  end if;

  if v_job.client_id <> auth.uid() and not app_private.is_admin() then
    raise exception 'Solo el cliente puede cancelar su trabajo'
      using errcode = 'insufficient_privilege';
  end if;

  if v_job.status not in ('DRAFT', 'PUBLISHED', 'OFFER_ACCEPTED', 'PAYMENT_PENDING') then
    raise exception 'Este trabajo ya no se puede cancelar' using errcode = 'check_violation';
  end if;

  update public.jobs
     set status = 'CANCELLED', cancelled_at = now(), cancellation_reason = p_reason
   where id = p_job_id;

  update public.job_offers
     set status = 'REJECTED', responded_at = now()
   where job_id = p_job_id and status = 'PENDING';

  update public.assignments
     set status = 'CANCELLED_BY_CLIENT', cancelled_at = now(), cancellation_reason = p_reason
   where job_id = p_job_id and status = 'AWAITING_PAYMENT';
end;
$$;

grant execute on function public.accept_job_offer(uuid) to authenticated;
grant execute on function public.withdraw_job_offer(uuid) to authenticated;
grant execute on function public.cancel_job(uuid, text) to authenticated;
