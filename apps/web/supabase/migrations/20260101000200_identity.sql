-- =============================================================================
-- HagoTuFila · 200 · Identidad: perfiles, datos privados y trabajadores
-- =============================================================================
-- Decisión central de seguridad:
--   RLS en PostgreSQL es a nivel de FILA, no de COLUMNA. Por eso los datos
--   sensibles viven en tablas separadas del perfil público. Así, cambiar un id
--   en la API jamás expone RUT, documento, teléfono ni cuenta bancaria.
--
-- No se crea public.users: la identidad la administra auth.users de Supabase.
-- public.profiles es su proyección pública, creada por trigger al registrarse.
-- =============================================================================

create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  role               public.app_role not null default 'CLIENT',
  -- Un mismo usuario puede operar como cliente y como trabajador.
  roles              public.app_role[] not null default array['CLIENT']::public.app_role[],
  first_name         text not null,
  -- Solo la inicial. El apellido completo vive en user_private_data.
  last_name_initial  char(1),
  avatar_url         text,
  bio                text check (char_length(bio) <= 1000),
  city               text,
  region_code        text references public.regions (code) on delete set null,
  country_code       char(2) not null default 'CL' references public.countries (code),
  is_suspended       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index profiles_region_idx on public.profiles (region_code);

create trigger profiles_touch
  before update on public.profiles
  for each row execute function app_private.touch_updated_at();

comment on table public.profiles is
  'Perfil PÚBLICO. Nunca debe contener RUT, documento, teléfono, correo ni cuenta bancaria.';

-- -----------------------------------------------------------------------------
-- Datos personales sensibles. Solo el titular y la administración.
-- -----------------------------------------------------------------------------
create table public.user_private_data (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  legal_first_name text not null,
  legal_last_name  text not null,
  rut              text,
  phone            text,
  phone_verified   boolean not null default false,
  contact_email    text,
  birth_date       date,
  address_line     text,
  commune_code     text references public.communes (code) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index user_private_data_rut_idx
  on public.user_private_data (rut) where rut is not null;

create trigger user_private_data_touch
  before update on public.user_private_data
  for each row execute function app_private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Perfil de trabajador. Campos públicos y reputación calculada.
-- -----------------------------------------------------------------------------
create table public.worker_profiles (
  user_id                 uuid primary key references public.profiles (id) on delete cascade,
  headline                text check (char_length(headline) <= 160),
  verification_status     public.verification_status not null default 'UNVERIFIED',
  level                   public.worker_level not null default 'NUEVO',
  -- Índice de Confianza HagoTuFila, 0..100. Se recalcula con la misma fórmula
  -- que usa la aplicación (src/lib/reputation).
  trust_index             smallint not null default 0 check (trust_index between 0 and 100),
  base_hourly_rate        bigint not null default 0 check (base_hourly_rate >= 0),
  currency                char(3) not null default 'CLP',
  availability_note       text,
  accepts_overnight       boolean not null default false,
  is_accepting_jobs       boolean not null default false,

  -- Señales de confianza (booleanas y públicas; el dato subyacente es privado).
  identity_verified       boolean not null default false,
  phone_verified          boolean not null default false,
  bank_account_verified   boolean not null default false,
  email_verified          boolean not null default false,

  -- Instantánea de reputación, mantenida por procesos de agregación.
  average_rating          numeric(3,2) not null default 0 check (average_rating between 0 and 5),
  review_count            integer not null default 0 check (review_count >= 0),
  completed_jobs          integer not null default 0 check (completed_jobs >= 0),
  worked_minutes          integer not null default 0 check (worked_minutes >= 0),
  punctuality_rate        numeric(4,3) not null default 0 check (punctuality_rate between 0 and 1),
  completion_rate         numeric(4,3) not null default 0 check (completion_rate between 0 and 1),
  communication_rate      numeric(4,3) not null default 0 check (communication_rate between 0 and 1),
  cancellation_count      integer not null default 0 check (cancellation_count >= 0),
  response_minutes_median integer,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index worker_profiles_trust_idx on public.worker_profiles (trust_index desc);
create index worker_profiles_available_idx
  on public.worker_profiles (is_accepting_jobs) where is_accepting_jobs;

create trigger worker_profiles_touch
  before update on public.worker_profiles
  for each row execute function app_private.touch_updated_at();

-- Regla dura: sin verificación no se aceptan trabajos.
alter table public.worker_profiles add constraint worker_profiles_verified_to_accept
  check (not is_accepting_jobs or verification_status = 'VERIFIED');

-- -----------------------------------------------------------------------------
-- Verificación de identidad. Contenido estrictamente privado.
-- -----------------------------------------------------------------------------
create table public.worker_verifications (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  status              public.verification_status not null default 'PENDING',
  -- Proveedor externo cuando se integre. 'manual' mientras la revisión sea humana.
  provider            text not null default 'manual',
  provider_session_id text,
  -- Rutas en Supabase Storage (bucket privado). Nunca URLs públicas.
  document_path       text,
  selfie_path         text,
  document_type       text,
  rejection_reason    text,
  -- Señales del proveedor, ya saneadas. Nunca la imagen cruda.
  provider_signals    jsonb not null default '{}'::jsonb,
  reviewed_by         uuid references public.profiles (id) on delete set null,
  reviewed_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index worker_verifications_user_idx on public.worker_verifications (user_id);
create index worker_verifications_status_idx on public.worker_verifications (status);

create trigger worker_verifications_touch
  before update on public.worker_verifications
  for each row execute function app_private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Cuenta bancaria del trabajador. Privada.
-- -----------------------------------------------------------------------------
create table public.worker_payout_accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  bank_code      text not null,
  account_type   text not null,
  account_number text not null,
  holder_name    text not null,
  holder_rut     text not null,
  is_verified    boolean not null default false,
  is_default     boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index worker_payout_accounts_default_idx
  on public.worker_payout_accounts (user_id) where is_default;

create trigger worker_payout_accounts_touch
  before update on public.worker_payout_accounts
  for each row execute function app_private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Zonas de trabajo.
-- -----------------------------------------------------------------------------
create table public.worker_service_areas (
  id           uuid primary key default gen_random_uuid(),
  worker_id    uuid not null references public.worker_profiles (user_id) on delete cascade,
  region_code  text not null references public.regions (code) on delete cascade,
  -- NULL = toda la región.
  commune_code text references public.communes (code) on delete cascade,
  radius_km    integer check (radius_km is null or radius_km between 1 and 200),
  created_at   timestamptz not null default now()
);

create index worker_service_areas_worker_idx on public.worker_service_areas (worker_id);
create index worker_service_areas_region_idx on public.worker_service_areas (region_code, commune_code);

-- -----------------------------------------------------------------------------
-- Categorías que atiende cada trabajador.
-- -----------------------------------------------------------------------------
create table public.worker_categories (
  worker_id   uuid not null references public.worker_profiles (user_id) on delete cascade,
  category_id uuid not null references public.job_categories (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (worker_id, category_id)
);

-- -----------------------------------------------------------------------------
-- Alta automática al registrarse.
-- -----------------------------------------------------------------------------
create or replace function app_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_first text := coalesce(new.raw_user_meta_data ->> 'first_name', 'Usuario');
  v_last  text := coalesce(new.raw_user_meta_data ->> 'last_name', '');
  v_intent text := coalesce(new.raw_user_meta_data ->> 'intent', 'CLIENT');
begin
  insert into public.profiles (id, first_name, last_name_initial, role, roles)
  values (
    new.id,
    v_first,
    nullif(upper(left(v_last, 1)), ''),
    'CLIENT',
    case when v_intent = 'WORKER'
      then array['CLIENT', 'WORKER']::public.app_role[]
      else array['CLIENT']::public.app_role[]
    end
  );

  insert into public.user_private_data (user_id, legal_first_name, legal_last_name, contact_email)
  values (new.id, v_first, v_last, new.email);

  insert into public.loyalty_accounts (user_id) values (new.id);

  if v_intent = 'WORKER' then
    insert into public.worker_profiles (user_id) values (new.id);
  end if;

  return new;
end;
$$;

comment on function app_private.handle_new_user is
  'Crea perfil público, datos privados y cuenta de FilaPuntos al registrarse un usuario.';
