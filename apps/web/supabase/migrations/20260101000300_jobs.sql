-- =============================================================================
-- HagoTuFila · 300 · Trabajos, ofertas, asignaciones y extensiones
-- =============================================================================

create table public.jobs (
  id                        uuid primary key default gen_random_uuid(),
  reference                 text not null unique default app_private.generate_reference('HTF'),
  client_id                 uuid not null references public.profiles (id) on delete cascade,
  category_id               uuid not null references public.job_categories (id) on delete restrict,
  status                    public.job_status not null default 'DRAFT',

  title                     text not null check (char_length(title) between 10 and 120),
  description               text not null check (char_length(description) between 30 and 2000),
  instructions              text check (char_length(instructions) <= 2000),

  -- Ubicación
  country_code              char(2) not null default 'CL' references public.countries (code),
  region_code               text not null references public.regions (code) on delete restrict,
  commune_code              text not null references public.communes (code) on delete restrict,
  address_line              text not null,
  address_notes             text,
  place_name                text,
  -- PostGIS se incorpora más adelante como columna generada + índice GIST.
  -- Hasta entonces, coordenadas simples: el filtrado principal es por comuna.
  lat                       numeric(10,7) check (lat between -90 and 90),
  lng                       numeric(10,7) check (lng between -180 and 180),
  timezone                  text not null default 'America/Santiago',

  -- Programación
  starts_at                 timestamptz not null,
  estimated_duration_minutes integer not null check (estimated_duration_minutes >= 30),
  urgency                   public.job_urgency not null default 'NORMAL',

  -- Objetivo y bono (conceptualmente separados del pago por trabajo)
  objective_type            public.job_objective_type not null default 'HOLD_PLACE',
  objective_target_position  integer check (objective_target_position is null
                                            or objective_target_position > 0),
  objective_description     text,
  bonus_amount              bigint check (bonus_amount is null or bonus_amount >= 0),
  bonus_conditions          text,

  -- Precio propuesto por el cliente (referencia, no precio final)
  hourly_rate               bigint not null check (hourly_rate > 0),
  currency                  char(3) not null default 'CLP',
  -- Rango sugerido vigente al publicar, guardado para auditoría de precios.
  suggested_hourly_min      bigint,
  suggested_hourly_max      bigint,

  offer_count               integer not null default 0 check (offer_count >= 0),
  view_count                integer not null default 0 check (view_count >= 0),

  published_at              timestamptz,
  expires_at                timestamptz,
  cancelled_at              timestamptz,
  cancellation_reason       text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint jobs_objective_position_required check (
    objective_type <> 'WITHIN_FIRST_N' or objective_target_position is not null
  ),
  constraint jobs_bonus_conditions_required check (
    coalesce(bonus_amount, 0) = 0 or bonus_conditions is not null
  )
);

create index jobs_status_published_idx on public.jobs (status, published_at desc);
create index jobs_region_commune_idx on public.jobs (region_code, commune_code);
create index jobs_category_idx on public.jobs (category_id);
create index jobs_client_idx on public.jobs (client_id);
create index jobs_starts_at_idx on public.jobs (starts_at);
create index jobs_open_idx on public.jobs (published_at desc) where status = 'PUBLISHED';

create trigger jobs_touch
  before update on public.jobs
  for each row execute function app_private.touch_updated_at();

comment on column public.jobs.hourly_rate is
  'Presupuesto propuesto por el cliente. El precio final lo fija la oferta aceptada.';

-- -----------------------------------------------------------------------------
create table public.job_images (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs (id) on delete cascade,
  storage_path  text not null,
  caption       text,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);

create index job_images_job_idx on public.job_images (job_id, sort_order);

-- -----------------------------------------------------------------------------
-- Ofertas: cada trabajador propone su propia tarifa.
-- -----------------------------------------------------------------------------
create table public.job_offers (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid not null references public.jobs (id) on delete cascade,
  worker_id            uuid not null references public.worker_profiles (user_id) on delete cascade,
  status               public.offer_status not null default 'PENDING',
  hourly_rate          bigint not null check (hourly_rate > 0),
  estimated_total      bigint not null check (estimated_total > 0),
  currency             char(3) not null default 'CLP',
  message              text check (char_length(message) <= 1000),
  estimated_arrival_at timestamptz,
  responded_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Un trabajador oferta una vez por trabajo; para cambiar su precio, edita la oferta.
  unique (job_id, worker_id)
);

create index job_offers_job_idx on public.job_offers (job_id, created_at desc);
create index job_offers_worker_idx on public.job_offers (worker_id, created_at desc);
-- Solo una oferta aceptada por trabajo.
create unique index job_offers_single_accepted_idx
  on public.job_offers (job_id) where status = 'ACCEPTED';

create trigger job_offers_touch
  before update on public.job_offers
  for each row execute function app_private.touch_updated_at();

-- Mantiene jobs.offer_count sin depender de la aplicación.
create or replace function app_private.sync_offer_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.jobs j
     set offer_count = (
       select count(*) from public.job_offers o
        where o.job_id = coalesce(new.job_id, old.job_id)
          and o.status in ('PENDING', 'ACCEPTED')
     )
   where j.id = coalesce(new.job_id, old.job_id);
  return coalesce(new, old);
end;
$$;

create trigger job_offers_count
  after insert or update or delete on public.job_offers
  for each row execute function app_private.sync_offer_count();

-- -----------------------------------------------------------------------------
-- Asignación: resultado de aceptar una oferta.
-- -----------------------------------------------------------------------------
create table public.assignments (
  id                      uuid primary key default gen_random_uuid(),
  job_id                  uuid not null unique references public.jobs (id) on delete cascade,
  offer_id                uuid not null unique references public.job_offers (id) on delete restrict,
  worker_id               uuid not null references public.worker_profiles (user_id) on delete restrict,
  client_id               uuid not null references public.profiles (id) on delete restrict,
  status                  public.assignment_status not null default 'AWAITING_PAYMENT',

  agreed_hourly_rate      bigint not null check (agreed_hourly_rate > 0),
  agreed_duration_minutes integer not null check (agreed_duration_minutes >= 30),
  agreed_total            bigint not null check (agreed_total > 0),
  bonus_amount            bigint not null default 0 check (bonus_amount >= 0),
  -- NULL = aún no se evalúa el objetivo.
  bonus_awarded           boolean,
  currency                char(3) not null default 'CLP',

  started_at              timestamptz,
  checked_in_at           timestamptz,
  handoff_completed_at    timestamptz,
  completed_at            timestamptz,
  -- Fin del plazo para abrir una disputa (DISPUTE_WINDOW_HOURS).
  dispute_deadline_at     timestamptz,
  cancelled_at            timestamptz,
  cancellation_reason     text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint assignments_worker_not_client check (worker_id <> client_id)
);

create index assignments_worker_idx on public.assignments (worker_id, status);
create index assignments_client_idx on public.assignments (client_id, status);
create index assignments_deadline_idx on public.assignments (dispute_deadline_at)
  where dispute_deadline_at is not null;

create trigger assignments_touch
  before update on public.assignments
  for each row execute function app_private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Extensiones: el trabajador SIEMPRE debe aceptarlas.
-- -----------------------------------------------------------------------------
create table public.job_extensions (
  id                 uuid primary key default gen_random_uuid(),
  assignment_id      uuid not null references public.assignments (id) on delete cascade,
  requested_by       uuid not null references public.profiles (id) on delete restrict,
  status             public.extension_status not null default 'PENDING',
  additional_minutes integer not null check (additional_minutes > 0),
  hourly_rate        bigint not null check (hourly_rate > 0),
  additional_amount  bigint not null check (additional_amount > 0),
  currency           char(3) not null default 'CLP',
  reason             text,
  -- El costo adicional debe estar pagado o autorizado antes de continuar.
  payment_id         uuid,
  responded_at       timestamptz,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index job_extensions_assignment_idx on public.job_extensions (assignment_id, created_at desc);

create trigger job_extensions_touch
  before update on public.job_extensions
  for each row execute function app_private.touch_updated_at();

comment on table public.job_extensions is
  'Nunca se asume que el trabajador continuará: una extensión solo aplica en estado ACCEPTED.';

-- -----------------------------------------------------------------------------
-- Código PIN de entrega.
--
-- Vive en su propia tabla porque el TRABAJADOR NO DEBE PODER LEERLO: lo recibe
-- verbalmente del cliente y lo envía a una función que compara en el servidor.
-- -----------------------------------------------------------------------------
create table public.handoff_codes (
  assignment_id uuid primary key references public.assignments (id) on delete cascade,
  code          char(4) not null,
  attempts      smallint not null default 0 check (attempts >= 0),
  verified_at   timestamptz,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

comment on table public.handoff_codes is
  'RLS permite lectura solo al cliente. El trabajador valida el código vía RPC.';
