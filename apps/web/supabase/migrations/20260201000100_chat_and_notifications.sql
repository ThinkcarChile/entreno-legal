-- =============================================================================
-- HagoTuFila · Etapa 2 · 100 · Chat y notificaciones
-- =============================================================================
-- Cambio respecto de la Etapa 1: la conversación ya no es una por trabajo, sino
-- una por (trabajo, trabajador). Un cliente necesita poder preguntar algo a
-- varios postulantes antes de elegir, y esas conversaciones no pueden mezclarse.
--
-- Al aceptar una oferta, la conversación de ese trabajador pasa a ser la
-- principal del trabajo.
-- =============================================================================

alter table public.conversations
  drop constraint conversations_job_id_key;

alter table public.conversations
  add column offer_id uuid references public.job_offers (id) on delete set null,
  add column is_primary boolean not null default false;

-- Una sola conversación por par trabajo/trabajador.
create unique index conversations_job_worker_idx
  on public.conversations (job_id, worker_id);

-- Y una sola conversación principal por trabajo.
create unique index conversations_primary_idx
  on public.conversations (job_id) where is_primary;

-- -----------------------------------------------------------------------------
-- Emisión de notificaciones.
--
-- SECURITY DEFINER: las notificaciones las escribe el sistema, no el usuario.
-- `notifications` no tiene política de INSERT para roles de aplicación.
-- -----------------------------------------------------------------------------
create or replace function app_private.notify_user(
  p_user_id uuid,
  p_type public.notification_type,
  p_title text,
  p_body text,
  p_href text default null,
  p_job_id uuid default null,
  p_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_user_id is null then
    return null;
  end if;

  insert into public.notifications (user_id, notification_type, title, body, href, job_id, data)
  values (p_user_id, p_type, p_title, p_body, p_href, p_job_id, coalesce(p_data, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Abrir (o recuperar) la conversación con un postulante.
--
-- Vía RPC y no por INSERT directo: así se verifica en un solo lugar que quien
-- abre el hilo es el cliente del trabajo o el trabajador que ofertó.
-- -----------------------------------------------------------------------------
create or replace function public.open_job_conversation(p_job_id uuid, p_worker_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_conversation_id uuid;
  v_offer_id uuid;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if v_job is null then
    raise exception 'El trabajo no existe' using errcode = 'no_data_found';
  end if;

  if auth.uid() <> v_job.client_id and auth.uid() <> p_worker_id then
    raise exception 'No participas en este trabajo' using errcode = 'insufficient_privilege';
  end if;

  -- Debe existir una relación real: una oferta o una asignación. Sin eso,
  -- cualquiera podría abrir un canal hacia el cliente.
  select id into v_offer_id
    from public.job_offers
   where job_id = p_job_id and worker_id = p_worker_id
   order by created_at desc
   limit 1;

  if v_offer_id is null
     and not exists (select 1 from public.assignments
                      where job_id = p_job_id and worker_id = p_worker_id) then
    raise exception 'Todavía no hay una oferta de este trabajador para este trabajo'
      using errcode = 'check_violation';
  end if;

  select id into v_conversation_id
    from public.conversations
   where job_id = p_job_id and worker_id = p_worker_id;

  if v_conversation_id is null then
    insert into public.conversations (job_id, client_id, worker_id, offer_id)
    values (p_job_id, v_job.client_id, p_worker_id, v_offer_id)
    returning id into v_conversation_id;
  end if;

  return v_conversation_id;
end;
$$;

grant execute on function public.open_job_conversation(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Marcar como leídos los mensajes de una conversación.
-- -----------------------------------------------------------------------------
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.conversations c
     where c.id = p_conversation_id
       and (c.client_id = auth.uid() or c.worker_id = auth.uid())
  ) then
    raise exception 'No participas en esta conversación' using errcode = 'insufficient_privilege';
  end if;

  update public.messages
     set read_at = now()
   where conversation_id = p_conversation_id
     and read_at is null
     and sender_id is distinct from auth.uid();
end;
$$;

grant execute on function public.mark_conversation_read(uuid) to authenticated;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.notifications
     set read_at = now()
   where user_id = auth.uid()
     and read_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- -----------------------------------------------------------------------------
-- Avisos automáticos
-- -----------------------------------------------------------------------------

-- Nueva oferta recibida.
create or replace function app_private.on_offer_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_name text;
begin
  select * into v_job from public.jobs where id = new.job_id;
  select coalesce(first_name, 'Un trabajador') || ' ' || coalesce(last_name_initial || '.', '')
    into v_name
    from public.profiles where id = new.worker_id;

  perform app_private.notify_user(
    v_job.client_id, 'NEW_OFFER',
    'Nueva oferta recibida',
    trim(v_name) || ' envió una oferta para "' || v_job.title || '".',
    '/mis-trabajos/publicados/' || v_job.id, v_job.id
  );

  return new;
end;
$$;

create trigger job_offers_notify
  after insert on public.job_offers
  for each row execute function app_private.on_offer_created();

-- Nuevo mensaje en una conversación.
create or replace function app_private.on_message_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conversation public.conversations;
  v_recipient uuid;
  v_name text;
begin
  if new.message_type = 'SYSTEM' or new.sender_id is null then
    return new;
  end if;

  select * into v_conversation from public.conversations where id = new.conversation_id;

  v_recipient := case
    when new.sender_id = v_conversation.client_id then v_conversation.worker_id
    else v_conversation.client_id
  end;

  select coalesce(first_name, 'Alguien') into v_name
    from public.profiles where id = new.sender_id;

  perform app_private.notify_user(
    v_recipient, 'NEW_MESSAGE',
    'Nuevo mensaje',
    v_name || ' te escribió sobre un trabajo.',
    '/mensajes/' || new.conversation_id, v_conversation.job_id
  );

  return new;
end;
$$;

create trigger messages_notify
  after insert on public.messages
  for each row execute function app_private.on_message_created();

-- Pago confirmado: habilita el trabajo y avisa a ambas partes.
create or replace function app_private.on_payment_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_assignment public.assignments;
  v_conversation_id uuid;
begin
  if new.status <> 'PAID' or old.status = 'PAID' or new.purpose <> 'JOB' then
    return new;
  end if;

  select * into v_job from public.jobs where id = new.job_id;
  select * into v_assignment from public.assignments where id = new.assignment_id;

  if v_assignment is null then
    return new;
  end if;

  update public.assignments
     set status = 'CONFIRMED', updated_at = now()
   where id = v_assignment.id and status = 'AWAITING_PAYMENT';

  update public.jobs
     set status = 'PAID', updated_at = now()
   where id = v_job.id and status in ('OFFER_ACCEPTED', 'PAYMENT_PENDING');

  select id into v_conversation_id
    from public.conversations
   where job_id = v_job.id and is_primary;

  if v_conversation_id is not null then
    insert into public.messages (conversation_id, sender_id, message_type, body)
    values (v_conversation_id, null, 'SYSTEM',
            'El trabajo fue pagado. El pago queda protegido hasta que el servicio se complete.');
  end if;

  perform app_private.notify_user(
    v_assignment.worker_id, 'JOB_PAID',
    'Pago confirmado',
    'El pago de "' || v_job.title || '" está confirmado. Ya puedes comenzar.',
    '/mis-trabajos/' || v_assignment.id, v_job.id
  );

  perform app_private.notify_user(
    v_assignment.client_id, 'JOB_PAID',
    'Pago confirmado',
    'Tu pago de "' || v_job.title || '" quedó protegido.',
    '/mis-trabajos/publicados/' || v_job.id, v_job.id
  );

  return new;
end;
$$;

create trigger payments_on_paid
  after update on public.payments
  for each row execute function app_private.on_payment_paid();

-- Realtime para el chat y las notificaciones ya está habilitado en la Etapa 1
-- (messages, job_evidence, notifications). Se suma conversations para que la
-- bandeja se reordene sola.
alter publication supabase_realtime add table public.conversations;
