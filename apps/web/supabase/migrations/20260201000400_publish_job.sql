-- =============================================================================
-- HagoTuFila · Etapa 2 · 400 · Publicar y editar un trabajo
-- =============================================================================
-- El trabajo y su dirección viven en tablas distintas (ver migración 000 de esta
-- etapa). Publicar debe escribir ambas o ninguna, así que pasa por una función
-- en vez de por dos INSERT sueltos desde el cliente.
--
-- El rango sugerido se guarda tal como se mostró al publicar: sirve para auditar
-- después si un precio fue razonable en su momento, aunque el algoritmo cambie.
-- =============================================================================

create or replace function public.publish_job(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_job_id uuid;
  v_status public.job_status;
  v_starts_at timestamptz;
  v_duration integer;
  v_timezone text;
  v_commune_code text;
  v_region_code text;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  v_status := coalesce((p_payload ->> 'status')::public.job_status, 'PUBLISHED');
  if v_status not in ('DRAFT', 'PUBLISHED') then
    raise exception 'Un trabajo solo se crea como borrador o publicado'
      using errcode = 'check_violation';
  end if;

  v_starts_at := (p_payload ->> 'startsAt')::timestamptz;
  v_duration := (p_payload ->> 'estimatedDurationMinutes')::integer;
  v_region_code := p_payload ->> 'regionCode';
  v_commune_code := p_payload ->> 'communeCode';

  if v_starts_at is null or v_starts_at < now() - interval '1 hour' then
    raise exception 'La fecha de inicio debe estar en el futuro' using errcode = 'check_violation';
  end if;

  -- La zona horaria la decide la comuna, no el navegador de quien publica.
  select coalesce(c.timezone, r.timezone) into v_timezone
    from public.communes c
    join public.regions r on r.code = c.region_code
   where c.code = v_commune_code;

  if v_timezone is null then
    raise exception 'La comuna indicada no existe' using errcode = 'foreign_key_violation';
  end if;

  insert into public.jobs (
    client_id, category_id, status, title, description, instructions,
    country_code, region_code, commune_code, place_name, timezone,
    starts_at, estimated_duration_minutes, urgency,
    objective_type, objective_target_position, objective_description,
    bonus_amount, bonus_conditions,
    hourly_rate, currency, suggested_hourly_min, suggested_hourly_max,
    published_at, expires_at
  ) values (
    v_uid,
    (p_payload ->> 'categoryId')::uuid,
    v_status,
    p_payload ->> 'title',
    p_payload ->> 'description',
    nullif(p_payload ->> 'instructions', ''),
    coalesce(p_payload ->> 'countryCode', 'CL'),
    v_region_code,
    v_commune_code,
    nullif(p_payload ->> 'placeName', ''),
    v_timezone,
    v_starts_at,
    v_duration,
    coalesce((p_payload ->> 'urgency')::public.job_urgency, 'NORMAL'),
    coalesce((p_payload ->> 'objectiveType')::public.job_objective_type, 'HOLD_PLACE'),
    nullif(p_payload ->> 'targetPosition', '')::integer,
    nullif(p_payload ->> 'objectiveDescription', ''),
    nullif(p_payload ->> 'bonusAmount', '')::bigint,
    nullif(p_payload ->> 'bonusConditions', ''),
    (p_payload ->> 'hourlyRate')::bigint,
    coalesce(p_payload ->> 'currency', 'CLP'),
    nullif(p_payload ->> 'suggestedHourlyMin', '')::bigint,
    nullif(p_payload ->> 'suggestedHourlyMax', '')::bigint,
    case when v_status = 'PUBLISHED' then now() end,
    v_starts_at
  )
  returning id into v_job_id;

  insert into public.job_private_location (job_id, address_line, address_notes, lat, lng)
  values (
    v_job_id,
    p_payload ->> 'addressLine',
    nullif(p_payload ->> 'addressNotes', ''),
    nullif(p_payload ->> 'lat', '')::numeric,
    nullif(p_payload ->> 'lng', '')::numeric
  );

  return v_job_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Editar un trabajo mientras siga abierto.
--
-- La guarda de la migración 200 impide tocar los campos críticos una vez que hay
-- oferta aceptada; aquí se rechaza antes y con un mensaje entendible.
-- -----------------------------------------------------------------------------
create or replace function public.update_open_job(p_job_id uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
  v_starts_at timestamptz;
begin
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
$$;

grant execute on function public.publish_job(jsonb) to authenticated;
grant execute on function public.update_open_job(uuid, jsonb) to authenticated;
