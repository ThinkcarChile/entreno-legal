-- =============================================================================
-- HagoTuFila · Etapa 2 · 300 · Cuentas, roles y verificación
-- =============================================================================
-- Una cuenta, dos modos. Nadie necesita registrarse dos veces para contratar y
-- para trabajar: se activa el modo trabajador sobre la misma cuenta.
--
-- `profiles.roles` no está entre las columnas que el usuario puede escribir
-- (ver migración 800 de la Etapa 1), así que cambiar de modo pasa por una RPC.
-- =============================================================================

alter table public.profiles
  add column commune_code text references public.communes (code) on delete set null,
  add column onboarding_completed_at timestamptz;

create index profiles_commune_idx on public.profiles (commune_code);

-- La comuna es pública: es la misma granularidad que ya se muestra en un trabajo.
grant update (first_name, last_name_initial, avatar_url, bio, city, region_code, commune_code)
  on public.profiles to authenticated;

-- -----------------------------------------------------------------------------
-- Completar el onboarding de la cuenta.
--
-- Escribe a la vez el perfil público y los datos privados, que viven en tablas
-- distintas justamente para que el teléfono no sea legible por cualquiera.
-- -----------------------------------------------------------------------------
create or replace function public.complete_onboarding(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_region_code text,
  p_commune_code text,
  p_avatar_url text default null,
  p_wants_client boolean default true,
  p_wants_worker boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_roles public.app_role[];
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  if coalesce(trim(p_first_name), '') = '' or coalesce(trim(p_last_name), '') = '' then
    raise exception 'El nombre y el apellido son obligatorios' using errcode = 'check_violation';
  end if;

  if not p_wants_client and not p_wants_worker then
    raise exception 'Elige al menos un modo de uso' using errcode = 'check_violation';
  end if;

  v_roles := array[]::public.app_role[];
  if p_wants_client then v_roles := v_roles || 'CLIENT'::public.app_role; end if;
  if p_wants_worker then v_roles := v_roles || 'WORKER'::public.app_role; end if;

  update public.profiles
     set first_name = trim(p_first_name),
         last_name_initial = upper(left(trim(p_last_name), 1)),
         region_code = p_region_code,
         commune_code = p_commune_code,
         city = (select name from public.communes where code = p_commune_code),
         avatar_url = coalesce(p_avatar_url, avatar_url),
         roles = v_roles,
         onboarding_completed_at = now(),
         updated_at = now()
   where id = v_uid;

  insert into public.user_private_data (user_id, legal_first_name, legal_last_name, phone)
  values (v_uid, trim(p_first_name), trim(p_last_name), nullif(trim(p_phone), ''))
  on conflict (user_id) do update
    set legal_first_name = excluded.legal_first_name,
        legal_last_name = excluded.legal_last_name,
        phone = coalesce(excluded.phone, public.user_private_data.phone),
        updated_at = now();

  if p_wants_worker then
    insert into public.worker_profiles (user_id) values (v_uid)
    on conflict (user_id) do nothing;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Activar o desactivar el modo trabajador sobre la misma cuenta.
-- -----------------------------------------------------------------------------
create or replace function public.set_account_modes(p_client boolean, p_worker boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_roles public.app_role[] := array[]::public.app_role[];
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  if not p_client and not p_worker then
    raise exception 'La cuenta debe tener al menos un modo activo' using errcode = 'check_violation';
  end if;

  if p_client then v_roles := v_roles || 'CLIENT'::public.app_role; end if;
  if p_worker then v_roles := v_roles || 'WORKER'::public.app_role; end if;

  update public.profiles set roles = v_roles, updated_at = now() where id = v_uid;

  if p_worker then
    insert into public.worker_profiles (user_id) values (v_uid) on conflict (user_id) do nothing;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Zonas de trabajo: se reemplazan en bloque para que la pantalla sea simple.
-- -----------------------------------------------------------------------------
create or replace function public.set_worker_service_areas(p_areas jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_area jsonb;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  if jsonb_array_length(coalesce(p_areas, '[]'::jsonb)) = 0 then
    raise exception 'Indica al menos una zona de trabajo' using errcode = 'check_violation';
  end if;

  delete from public.worker_service_areas where worker_id = v_uid;

  for v_area in select * from jsonb_array_elements(p_areas) loop
    insert into public.worker_service_areas (worker_id, region_code, commune_code, radius_km)
    values (
      v_uid,
      v_area ->> 'regionCode',
      nullif(v_area ->> 'communeCode', ''),
      nullif(v_area ->> 'radiusKm', '')::integer
    );
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Solicitar verificación de identidad.
--
-- El usuario no puede escribir `verification_status` (privilegio de columna
-- revocado), así que la solicitud pasa por aquí.
--
-- Etapa 2: la revisión es humana, desde el panel. No hay proveedor biométrico.
-- Las rutas apuntan al bucket privado `verification`.
-- -----------------------------------------------------------------------------
create or replace function public.request_worker_verification(
  p_document_type text default null,
  p_document_path text default null,
  p_selfie_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_current public.verification_status;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  insert into public.worker_profiles (user_id) values (v_uid) on conflict (user_id) do nothing;

  select verification_status into v_current from public.worker_profiles where user_id = v_uid;

  if v_current = 'VERIFIED' then
    raise exception 'Tu identidad ya está verificada' using errcode = 'check_violation';
  end if;

  if v_current = 'SUSPENDED' then
    raise exception 'Tu cuenta está suspendida. Escríbenos para revisarla.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_current = 'PENDING' then
    select id into v_id from public.worker_verifications
     where user_id = v_uid and status = 'PENDING'
     order by created_at desc limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  insert into public.worker_verifications (user_id, status, provider, document_type, document_path, selfie_path)
  values (v_uid, 'PENDING', 'manual', p_document_type, p_document_path, p_selfie_path)
  returning id into v_id;

  update public.worker_profiles
     set verification_status = 'PENDING', updated_at = now()
   where user_id = v_uid;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Resolución administrativa de una verificación.
--
-- Es la "simulación administrativa" pedida para poder probar el flujo completo
-- sin proveedor externo: una persona del equipo aprueba o rechaza. El día que
-- exista un proveedor biométrico, alimentará esta misma función.
-- -----------------------------------------------------------------------------
create or replace function public.review_worker_verification(
  p_verification_id uuid,
  p_status public.verification_status,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.worker_verifications;
begin
  if not app_private.is_admin() then
    raise exception 'Solo la administración puede resolver una verificación'
      using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('VERIFIED', 'REJECTED', 'SUSPENDED') then
    raise exception 'Resolución no válida' using errcode = 'check_violation';
  end if;

  select * into v_row from public.worker_verifications where id = p_verification_id;
  if v_row is null then
    raise exception 'La solicitud no existe' using errcode = 'no_data_found';
  end if;

  update public.worker_verifications
     set status = p_status,
         rejection_reason = case when p_status = 'VERIFIED' then null else p_reason end,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_verification_id;

  update public.worker_profiles
     set verification_status = p_status,
         identity_verified = (p_status = 'VERIFIED'),
         phone_verified = case when p_status = 'VERIFIED' then true else phone_verified end,
         level = case when p_status = 'VERIFIED' and level = 'NUEVO'
                      then 'VERIFICADO'::public.worker_level else level end,
         is_accepting_jobs = case when p_status = 'VERIFIED' then is_accepting_jobs else false end,
         updated_at = now()
   where user_id = v_row.user_id;

  perform app_private.notify_user(
    v_row.user_id, 'VERIFICATION_UPDATED',
    case p_status
      when 'VERIFIED' then 'Tu identidad fue verificada'
      when 'REJECTED' then 'Tu verificación fue rechazada'
      else 'Tu cuenta fue suspendida'
    end,
    case p_status
      when 'VERIFIED' then 'Ya puedes enviar ofertas y aceptar trabajos.'
      else coalesce(p_reason, 'Revisa los datos enviados y vuelve a intentarlo.')
    end,
    '/cuenta/trabajador'
  );
end;
$$;

grant execute on function public.complete_onboarding(text, text, text, text, text, text, boolean, boolean) to authenticated;
grant execute on function public.set_account_modes(boolean, boolean) to authenticated;
grant execute on function public.set_worker_service_areas(jsonb) to authenticated;
grant execute on function public.request_worker_verification(text, text, text) to authenticated;
grant execute on function public.review_worker_verification(uuid, public.verification_status, text) to authenticated;
