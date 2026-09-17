-- =============================================================================
-- HagoTuFila · Etapa 2.5 · 200 · Endurecimiento de las 16 RPC
-- =============================================================================
-- Resultado de auditar una por una las 16 funciones `SECURITY DEFINER` que
-- señala el advisor. Tres cosas, ninguna hipotética:
--
-- 1. OCHO de las dieciséis NO fallaban sin sesión. Se apoyaban en una
--    comparación de la forma `if fila.dueño <> auth.uid() then raise`. Con
--    `auth.uid()` nulo esa expresión no vale FALSE: vale NULL, y en PL/pgSQL un
--    IF sobre NULL no entra en la rama. La única comprobación de autorización de
--    la función se saltaba sola y la ejecución continuaba.
--
--    Comprobado contra el esquema real: llamando a `cancel_job` sin sesión se
--    canceló el trabajo de otro cliente. Hoy no es alcanzable desde internet
--    —`anon` no tiene EXECUTE desde la migración …000000, y un JWT de usuario
--    siempre trae `sub`—, pero deja la autorización dependiendo de una sola
--    línea de defensa donde el repositorio declara dos, y bastaría un `grant
--    execute … to anon` para convertirlo en remoto. `publish_job` ya lo hacía
--    bien; las demás no.
--
-- 2. DOS no necesitan `SECURITY DEFINER` en absoluto. `mark_conversation_read`
--    y `mark_notifications_read` solo escriben `read_at` en filas que las
--    políticas RLS ya autorizan al propio llamante. Pasan a SECURITY INVOKER:
--    así vuelve a aplicarse RLS, y si mañana alguien endurece esas políticas,
--    la RPC hereda el cambio en vez de seguir aplicando la regla antigua.
--
-- 3. TRES tablas tenían UPDATE abierto a todas sus columnas donde la aplicación
--    solo escribe una o dos. Es la misma clase de defecto que la migración
--    …000100 corrigió para INSERT, por el otro lado:
--
--    · `job_offers` incluía `status` y `responded_at` en el grant de columna.
--      Un trabajador podía poner su propia oferta en ACCEPTED sin pasar por
--      `accept_job_offer`, y como `job_offers_single_accepted_idx` solo admite
--      una oferta aceptada por trabajo, el cliente ya no podía aceptar ninguna:
--      el trabajo quedaba bloqueado por un tercero.
--    · `messages` permitía a un participante escribir CUALQUIER columna de los
--      mensajes del otro, porque `messages_mark_read` termina en
--      `with check (true)`. Es decir, reescribir el `body` de lo que dijo la
--      contraparte. El chat es prueba en una disputa.
--    · `notifications` permitía al destinatario reescribir el contenido de sus
--      propios avisos.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Sin sesión, ninguna de las dieciséis hace nada
-- -----------------------------------------------------------------------------
-- Se reemplazan las ocho funciones afectadas con el cuerpo idéntico al aplicado,
-- más la guarda al principio. Las otras ocho ya fallaban bien: o tienen la
-- guarda explícita (`publish_job`), o filtran por igualdad —`where id =
-- auth.uid()`, que con NULL no encuentra fila—, o se apoyan en
-- `app_private.is_admin()`, que devuelve false sin sesión.

CREATE OR REPLACE FUNCTION public.accept_job_offer(p_offer_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_offer   public.job_offers;
  v_job     public.jobs;
  v_assignment_id uuid;
  v_conversation_id uuid;
begin
  -- Sin sesión no se sigue. Antes esta función se apoyaba en una comparación
  -- `<> auth.uid()`, y con `auth.uid()` nulo esa comparación vale NULL: el IF
  -- no entra en la rama y la comprobación de pertenencia se saltaba sola.
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

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
$function$;


CREATE OR REPLACE FUNCTION public.cancel_job(p_job_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_job public.jobs;
begin
  -- Sin sesión no se sigue. Antes esta función se apoyaba en una comparación
  -- `<> auth.uid()`, y con `auth.uid()` nulo esa comparación vale NULL: el IF
  -- no entra en la rama y la comprobación de pertenencia se saltaba sola.
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

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
$function$;


CREATE OR REPLACE FUNCTION public.generate_handoff_code(p_assignment_id uuid)
 RETURNS character
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_client uuid;
  v_code char(4);
begin
  -- Sin sesión no se sigue. Antes esta función se apoyaba en una comparación
  -- `<> auth.uid()`, y con `auth.uid()` nulo esa comparación vale NULL: el IF
  -- no entra en la rama y la comprobación de pertenencia se saltaba sola.
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  select client_id into v_client from public.assignments where id = p_assignment_id;

  if v_client is null then
    raise exception 'La asignación no existe';
  end if;

  if v_client <> auth.uid() then
    raise exception 'Solo el cliente puede generar el código de entrega';
  end if;

  insert into public.handoff_codes (assignment_id, code, expires_at)
  values (
    p_assignment_id,
    lpad((floor(random() * 10000))::int::text, 4, '0'),
    now() + interval '12 hours'
  )
  on conflict (assignment_id) do update set code = public.handoff_codes.code
  returning code into v_code;

  return v_code;
end;
$function$;


CREATE OR REPLACE FUNCTION public.open_job_conversation(p_job_id uuid, p_worker_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_job public.jobs;
  v_conversation_id uuid;
  v_offer_id uuid;
begin
  -- Sin sesión no se sigue. Antes esta función se apoyaba en una comparación
  -- `<> auth.uid()`, y con `auth.uid()` nulo esa comparación vale NULL: el IF
  -- no entra en la rama y la comprobación de pertenencia se saltaba sola.
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

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
$function$;


CREATE OR REPLACE FUNCTION public.start_protected_payment(p_assignment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_assignment public.assignments;
  v_existing public.payments;
  v_total bigint;
  v_payment_id uuid;
begin
  -- Sin sesión no se sigue. Antes esta función se apoyaba en una comparación
  -- `<> auth.uid()`, y con `auth.uid()` nulo esa comparación vale NULL: el IF
  -- no entra en la rama y la comprobación de pertenencia se saltaba sola.
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

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
$function$;


CREATE OR REPLACE FUNCTION public.update_open_job(p_job_id uuid, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_job public.jobs;
  v_starts_at timestamptz;
begin
  -- Sin sesión no se sigue. Antes esta función se apoyaba en una comparación
  -- `<> auth.uid()`, y con `auth.uid()` nulo esa comparación vale NULL: el IF
  -- no entra en la rama y la comprobación de pertenencia se saltaba sola.
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  select * into v_job from public.jobs where id = p_job_id for update;

  if v_job is null then
    raise exception 'El trabajo no existe' using errcode = 'no_data_found';
  end if;

  if v_job.client_id <> auth.uid() then
    raise exception 'Solo el cliente que publicó el trabajo puede editarlo'
      using errcode = 'insufficient_privilege';
  end if;

  if v_job.status not in ('DRAFT', 'PUBLISHED') then
    raise exception 'El trabajo ya tiene una oferta aceptada y no se puede editar'
      using errcode = 'check_violation';
  end if;

  v_starts_at := coalesce((p_payload ->> 'startsAt')::timestamptz, v_job.starts_at);

  update public.jobs
     set title = coalesce(p_payload ->> 'title', title),
         description = coalesce(p_payload ->> 'description', description),
         instructions = coalesce(nullif(p_payload ->> 'instructions', ''), instructions),
         place_name = coalesce(nullif(p_payload ->> 'placeName', ''), place_name),
         starts_at = v_starts_at,
         expires_at = v_starts_at,
         estimated_duration_minutes = coalesce(
           nullif(p_payload ->> 'estimatedDurationMinutes', '')::integer,
           estimated_duration_minutes),
         urgency = coalesce((p_payload ->> 'urgency')::public.job_urgency, urgency),
         objective_type = coalesce((p_payload ->> 'objectiveType')::public.job_objective_type,
                                   objective_type),
         objective_target_position = nullif(p_payload ->> 'targetPosition', '')::integer,
         objective_description = nullif(p_payload ->> 'objectiveDescription', ''),
         bonus_amount = nullif(p_payload ->> 'bonusAmount', '')::bigint,
         bonus_conditions = nullif(p_payload ->> 'bonusConditions', ''),
         hourly_rate = coalesce(nullif(p_payload ->> 'hourlyRate', '')::bigint, hourly_rate),
         suggested_hourly_min = coalesce(
           nullif(p_payload ->> 'suggestedHourlyMin', '')::bigint, suggested_hourly_min),
         suggested_hourly_max = coalesce(
           nullif(p_payload ->> 'suggestedHourlyMax', '')::bigint, suggested_hourly_max),
         updated_at = now()
   where id = p_job_id;

  if p_payload ? 'addressLine' then
    update public.job_private_location
       set address_line = coalesce(nullif(p_payload ->> 'addressLine', ''), address_line),
           address_notes = nullif(p_payload ->> 'addressNotes', ''),
           lat = coalesce(nullif(p_payload ->> 'lat', '')::numeric, lat),
           lng = coalesce(nullif(p_payload ->> 'lng', '')::numeric, lng)
     where job_id = p_job_id;
  end if;

  -- Quien ya ofertó merece enterarse de que cambiaron las condiciones.
  perform app_private.notify_user(
    o.worker_id, 'JOB_UPDATED',
    'Cambió un trabajo al que ofertaste',
    'El cliente actualizó "' || v_job.title || '". Revisa si tu oferta sigue vigente.',
    '/trabajos/' || p_job_id, p_job_id
  )
  from public.job_offers o
  where o.job_id = p_job_id and o.status = 'PENDING';
end;
$function$;


CREATE OR REPLACE FUNCTION public.verify_handoff_code(p_assignment_id uuid, p_code text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  a record;
  c record;
begin
  -- Sin sesión no se sigue. Antes esta función se apoyaba en una comparación
  -- `<> auth.uid()`, y con `auth.uid()` nulo esa comparación vale NULL: el IF
  -- no entra en la rama y la comprobación de pertenencia se saltaba sola.
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  select * into a from public.assignments where id = p_assignment_id;

  if a is null or a.worker_id <> auth.uid() then
    raise exception 'Solo el trabajador asignado puede validar el código';
  end if;

  select * into c from public.handoff_codes where assignment_id = p_assignment_id for update;

  if c is null then
    raise exception 'Todavía no existe un código de entrega para este trabajo';
  end if;

  if c.attempts >= 5 then
    raise exception 'Demasiados intentos. Contacta a soporte.';
  end if;

  if c.expires_at < now() then
    raise exception 'El código de entrega expiró';
  end if;

  if c.code <> p_code then
    update public.handoff_codes
       set attempts = attempts + 1
     where assignment_id = p_assignment_id;
    return false;
  end if;

  update public.handoff_codes
     set verified_at = now(), attempts = attempts + 1
   where assignment_id = p_assignment_id;

  update public.assignments
     set status = 'HANDOFF_COMPLETED', handoff_completed_at = now(), updated_at = now()
   where id = p_assignment_id;

  update public.jobs
     set status = 'HANDOFF_COMPLETED', updated_at = now()
   where id = a.job_id;

  -- La validación del PIN es evidencia de presencia simultánea.
  insert into public.job_evidence
    (job_id, assignment_id, author_id, author_name, evidence_type, title, body)
  values
    (a.job_id, p_assignment_id, auth.uid(), null, 'HANDOFF',
     'Entrega completada', 'Código de recepción validado por ambas partes');

  return true;
end;
$function$;


CREATE OR REPLACE FUNCTION public.withdraw_job_offer(p_offer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_offer public.job_offers;
  v_job   public.jobs;
begin
  -- Sin sesión no se sigue. Antes esta función se apoyaba en una comparación
  -- `<> auth.uid()`, y con `auth.uid()` nulo esa comparación vale NULL: el IF
  -- no entra en la rama y la comprobación de pertenencia se saltaba sola.
  if auth.uid() is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

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
$function$;



-- -----------------------------------------------------------------------------
-- 2. Las dos que no necesitaban SECURITY DEFINER
-- -----------------------------------------------------------------------------
-- `mark_conversation_read`: lee `conversations` (la política
-- `conversations_participants` ya deja al participante verla) y escribe
-- `messages.read_at` sobre las filas que `messages_mark_read` autoriza. Como
-- INVOKER necesita el privilegio de columna que se concede más abajo.
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security invoker
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

comment on function public.mark_conversation_read is
  'SECURITY INVOKER: RLS ya autoriza exactamente esta escritura al participante.';

-- `mark_notifications_read`: escribe `notifications.read_at` de sus propias
-- filas, que es justo lo que permite `notifications_own_update`.
create or replace function public.mark_notifications_read(p_ids uuid[] default null::uuid[])
returns integer
language plpgsql
security invoker
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

comment on function public.mark_notifications_read is
  'SECURITY INVOKER: RLS ya autoriza exactamente esta escritura al destinatario.';


-- -----------------------------------------------------------------------------
-- 3. UPDATE por columna en las tres tablas que quedaban abiertas
-- -----------------------------------------------------------------------------
-- Una oferta la edita su autor mientras sigue PENDING, y solo en lo que la
-- aplicación edita: el mensaje y la hora estimada de llegada
-- (`src/lib/actions/offers.ts`). `status` y `responded_at` los mueven
-- `accept_job_offer` y `withdraw_job_offer`, que comprueban quién llama.
revoke update on public.job_offers from authenticated;
grant update (message, estimated_arrival_at) on public.job_offers to authenticated;

-- De un mensaje ajeno solo se marca la lectura. El contenido de lo que dijo
-- otra persona no se toca: es prueba en una disputa.
revoke update on public.messages from authenticated;
grant update (read_at) on public.messages to authenticated;

-- Y la política que lo autoriza deja de aceptar cualquier contenido: el
-- `with check` pasa a exigir lo mismo que el `using`, para que la fila no pueda
-- salir de la conversación ni cambiar de remitente.
alter policy messages_mark_read on public.messages
  using (
    exists (
      select 1 from public.conversations c
       where c.id = messages.conversation_id
         and (c.client_id = auth.uid() or c.worker_id = auth.uid())
    )
    and sender_id is distinct from auth.uid()
  )
  with check (
    exists (
      select 1 from public.conversations c
       where c.id = messages.conversation_id
         and (c.client_id = auth.uid() or c.worker_id = auth.uid())
    )
    and sender_id is distinct from auth.uid()
  );

-- Un aviso se marca como leído; su contenido lo escribe `app_private.notify_user`.
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;
