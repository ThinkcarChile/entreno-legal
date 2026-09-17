-- =============================================================================
-- HagoTuFila · 100 · Datos de referencia: países, regiones, comunas, categorías
-- =============================================================================
-- Se modelan como tablas y no como enums: agregar una comuna o un país no puede
-- exigir una migración de tipo. Además habilita páginas SEO por región.
-- =============================================================================

create table public.countries (
  code            char(2) primary key,
  name            text not null,
  currency        char(3) not null,
  default_timezone text not null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

create table public.regions (
  code          text primary key,
  country_code  char(2) not null references public.countries (code) on delete restrict,
  name          text not null,
  short_name    text not null,
  ordinal       text,
  -- Código oficial INE/SUBDERE, para integraciones futuras.
  official_code text,
  timezone      text not null default 'America/Santiago',
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);

create index regions_country_idx on public.regions (country_code);

create table public.communes (
  code          text primary key,
  region_code   text not null references public.regions (code) on delete restrict,
  name          text not null,
  official_code text,
  -- Solo cuando difiere de la zona horaria regional (por ejemplo, Isla de Pascua).
  timezone      text,
  created_at    timestamptz not null default now()
);

create index communes_region_idx on public.communes (region_code);
create index communes_name_idx on public.communes (name);

create table public.job_categories (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  category_group  public.category_group not null,
  name            text not null,
  description     text,
  icon            text,
  -- Rango base por hora en unidad mínima de la moneda.
  base_hourly_min bigint not null check (base_hourly_min >= 0),
  base_hourly_max bigint not null check (base_hourly_max >= base_hourly_min),
  currency        char(3) not null default 'CLP',
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger job_categories_touch
  before update on public.job_categories
  for each row execute function app_private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- RLS: los datos de referencia son de lectura pública y escritura administrativa.
-- -----------------------------------------------------------------------------
alter table public.countries enable row level security;
alter table public.regions enable row level security;
alter table public.communes enable row level security;
alter table public.job_categories enable row level security;

create policy countries_read on public.countries for select using (true);
create policy regions_read on public.regions for select using (true);
create policy communes_read on public.communes for select using (true);
create policy job_categories_read on public.job_categories
  for select using (is_active or app_private.is_admin());

create policy countries_admin on public.countries for all
  using (app_private.is_admin()) with check (app_private.is_admin());
create policy regions_admin on public.regions for all
  using (app_private.is_admin()) with check (app_private.is_admin());
create policy communes_admin on public.communes for all
  using (app_private.is_admin()) with check (app_private.is_admin());
create policy job_categories_admin on public.job_categories for all
  using (app_private.is_admin()) with check (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Semilla mínima: Chile y sus categorías iniciales.
-- Las 16 regiones y 346 comunas se cargan con `npm run seed:geo`, que usa como
-- fuente el mismo archivo que consume la aplicación (src/lib/geo/chile.ts).
-- -----------------------------------------------------------------------------
insert into public.countries (code, name, currency, default_timezone)
values ('CL', 'Chile', 'CLP', 'America/Santiago')
on conflict (code) do nothing;

insert into public.job_categories
  (slug, category_group, name, description, icon, base_hourly_min, base_hourly_max, sort_order)
values
  ('filas-conciertos-eventos', 'FILA', 'Conciertos y eventos',
   'Entradas, accesos, meet and greet y filas de espectáculos.', 'ticket', 8000, 10000, 1),
  ('filas-lanzamientos-tiendas', 'FILA', 'Lanzamientos y tiendas',
   'Estrenos de productos, aperturas y ofertas por tiempo limitado.', 'shopping-bag', 8000, 10500, 2),
  ('filas-restaurantes', 'FILA', 'Restaurantes',
   'Locales sin reserva y filas de mesa.', 'utensils', 8000, 10000, 3),
  ('filas-instituciones', 'FILA', 'Instituciones y servicios',
   'Filas de atención presencial en oficinas e instituciones.', 'building', 8500, 11000, 4),
  ('filas-madrugada-overnight', 'FILA', 'Madrugada y overnight',
   'Filas nocturnas y de larga duración, con relevos coordinados.', 'moon', 11500, 14500, 5),
  ('retiro-entrega-documentos', 'TRAMITE', 'Documentos',
   'Retiro y entrega de documentos cuando el trámite lo permite.', 'file-text', 9000, 12000, 6),
  ('retiro-pedidos', 'TRAMITE', 'Retiro de pedidos',
   'Retiro de compras, encomiendas y pedidos listos.', 'package', 9000, 11500, 7),
  ('espera-tecnico-atencion', 'TRAMITE', 'Esperar atención o técnico',
   'Acompañar una espera en domicilio u oficina.', 'clock', 9000, 12000, 8),
  ('otros-encargos', 'TRAMITE', 'Otros encargos',
   'Gestiones presenciales permitidas que no encajan en otra categoría.', 'list-checks', 9000, 12500, 9)
on conflict (slug) do nothing;
