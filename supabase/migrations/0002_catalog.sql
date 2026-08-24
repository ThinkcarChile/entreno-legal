-- Sprint 2 — Catálogo de alimentos y datos nutricionales.
-- ADR 0001 (Food Data Provenance): multi-fuente, base canónica por 100 g/ml,
-- UNKNOWN != ZERO (nutrientes desconocidos = NULL), procedencia inmutable.

create extension if not exists pg_trgm;

-- Los roles de API necesitan resolver las funciones de pertenencia usadas en RLS.
grant usage on schema app to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.measurement_type as enum ('MASS', 'VOLUME', 'UNIT');

create type public.weight_basis as enum
  ('RAW', 'COOKED', 'DRAINED', 'EDIBLE_PORTION', 'AS_PACKAGED');

create type public.nutrition_basis_unit as enum ('G', 'ML');

-- Jerarquía de confianza en ADR 0001 §1. DEV_SEED = datos de desarrollo,
-- explícitamente no oficiales, nunca verified.
create type public.nutrition_source_type as enum (
  'PACKAGE_LABEL_VERIFIED',
  'NATIONAL_FOOD_DATABASE',
  'USDA_FOODDATA_CENTRAL',
  'OTHER_VERIFIED_DATABASE',
  'USER_ENTERED_LABEL',
  'USER_ENTERED_GENERIC',
  'AI_ESTIMATE',
  'DEV_SEED'
);

-- ---------------------------------------------------------------------------
-- Categorías (globales, curadas)
-- ---------------------------------------------------------------------------

create table public.ingredient_categories (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  sort_order int not null default 100
);

insert into public.ingredient_categories (code, name, sort_order) values
  ('MEAT',       'Carnes',               10),
  ('POULTRY',    'Aves',                 20),
  ('FISH',       'Pescados y mariscos',  30),
  ('EGGS',       'Huevos',               40),
  ('DAIRY',      'Lácteos',              50),
  ('GRAINS',     'Cereales y granos',    60),
  ('BREAD',      'Panes y masas',        70),
  ('LEGUMES',    'Legumbres',            80),
  ('VEGETABLES', 'Verduras',             90),
  ('FRUITS',     'Frutas',              100),
  ('FATS_OILS',  'Aceites y grasas',    110),
  ('NUTS_SEEDS', 'Frutos secos y semillas', 120),
  ('BEVERAGES',  'Bebidas',             130),
  ('OTHER',      'Otros',               900);

-- ---------------------------------------------------------------------------
-- Ingredientes genéricos (sin marca)
-- ---------------------------------------------------------------------------

create table public.ingredients (
  id                       uuid primary key default gen_random_uuid(),
  household_id             uuid references public.households (id) on delete cascade,
  -- NULL = catálogo global curado (solo lectura para hogares)
  canonical_name           text not null,
  display_name             text not null,
  category_id              uuid not null references public.ingredient_categories (id),
  default_measurement_type public.measurement_type not null default 'MASS',
  edible_portion_factor    numeric(4, 3) check (edible_portion_factor > 0 and edible_portion_factor <= 1),
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create unique index ingredients_global_name_uniq
  on public.ingredients (canonical_name) where household_id is null;
create unique index ingredients_household_name_uniq
  on public.ingredients (household_id, canonical_name) where household_id is not null;
create index ingredients_name_trgm on public.ingredients using gin (display_name gin_trgm_ops);
create index ingredients_category_idx on public.ingredients (category_id);

-- ---------------------------------------------------------------------------
-- Productos comerciales (marca + barcode + envase), separados de Ingredient
-- ---------------------------------------------------------------------------

create table public.commercial_products (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid references public.households (id) on delete cascade,
  -- NULL = catálogo global curado; con valor = producto privado del hogar
  linked_ingredient_id uuid references public.ingredients (id) on delete set null,
  barcode              text check (barcode ~ '^[0-9]{8,14}$'),
  brand                text,
  name                 text not null check (char_length(name) between 1 and 200),
  package_quantity     numeric(10, 2) check (package_quantity > 0),
  package_unit         public.nutrition_basis_unit,
  serving_quantity     numeric(10, 2) check (serving_quantity > 0),
  serving_unit         public.nutrition_basis_unit,
  serving_name         text,          -- "rebanada", "unidad", etc. (opcional)
  source               public.nutrition_source_type not null default 'USER_ENTERED_LABEL',
  verified             boolean not null default false,
  is_active            boolean not null default true,
  created_by           uuid references public.household_members (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Barcode único por ámbito (ADR 0001 §5)
create unique index products_global_barcode_uniq
  on public.commercial_products (barcode) where household_id is null and barcode is not null;
create unique index products_household_barcode_uniq
  on public.commercial_products (household_id, barcode)
  where household_id is not null and barcode is not null;
create index products_name_trgm on public.commercial_products using gin ((coalesce(brand, '') || ' ' || name) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Datos nutricionales normalizados (por 100 g / 100 ml) con procedencia
-- Nutrientes ausentes = NULL (UNKNOWN != ZERO, ADR 0001 §4). Nunca 0 por defecto.
-- ---------------------------------------------------------------------------

create table public.nutrition_facts (
  id                        uuid primary key default gen_random_uuid(),
  ingredient_id             uuid references public.ingredients (id) on delete cascade,
  product_id                uuid references public.commercial_products (id) on delete cascade,
  household_id              uuid references public.households (id) on delete cascade,
  -- NULL = dato global; con valor = dato privado del hogar (p. ej. etiqueta tipeada)
  weight_basis              public.weight_basis not null default 'AS_PACKAGED',
  basis_unit                public.nutrition_basis_unit not null default 'G',

  -- Valores por 100 g / 100 ml. NULL = desconocido.
  energy_kcal               numeric(10, 3) check (energy_kcal >= 0),
  protein_g                 numeric(10, 3) check (protein_g >= 0),
  carbohydrates_g           numeric(10, 3) check (carbohydrates_g >= 0),
  fat_g                     numeric(10, 3) check (fat_g >= 0),
  fiber_g                   numeric(10, 3) check (fiber_g >= 0),
  sugars_g                  numeric(10, 3) check (sugars_g >= 0),
  saturated_fat_g           numeric(10, 3) check (saturated_fat_g >= 0),
  sodium_mg                 numeric(10, 3) check (sodium_mg >= 0),
  potassium_mg              numeric(10, 3) check (potassium_mg >= 0),
  phosphorus_mg             numeric(10, 3) check (phosphorus_mg >= 0),
  extended_nutrients        jsonb,   -- extensible: {code: {value, unit}} — sin columnas improvisadas

  -- Dato original de etiqueta cuando la base difiere (nunca perder el original)
  original_serving_quantity numeric(10, 2),
  original_serving_unit     public.nutrition_basis_unit,
  original_values           jsonb,   -- valores tal como aparecen en la etiqueta

  -- Procedencia (inmutable; no se sobrescribe al normalizar/copiar)
  source_type               public.nutrition_source_type not null,
  source_name               text not null,
  source_record_id          text,
  source_version            text,
  source_date               date,
  verified                  boolean not null default false,
  verified_at               timestamptz,
  verification_method       text,
  notes                     text,

  created_at                timestamptz not null default now(),

  constraint nutrition_subject_one check (num_nonnulls(ingredient_id, product_id) = 1),
  -- DEV_SEED y AI_ESTIMATE jamás se presentan como verificados (ADR 0001 §1)
  constraint nutrition_unverifiable_sources
    check (not (verified and source_type in ('AI_ESTIMATE', 'DEV_SEED')))
);

create index nutrition_by_ingredient on public.nutrition_facts (ingredient_id, weight_basis);
create index nutrition_by_product on public.nutrition_facts (product_id);

-- ---------------------------------------------------------------------------
-- Medidas domésticas por alimento/producto (nunca "una rebanada universal")
-- ---------------------------------------------------------------------------

create table public.household_measures (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid references public.households (id) on delete cascade,  -- NULL = global
  ingredient_id uuid references public.ingredients (id) on delete cascade,
  product_id    uuid references public.commercial_products (id) on delete cascade,
  measure_name  text not null,                    -- "rebanada", "taza", "cucharada", "unidad"
  quantity      numeric(10, 2) not null check (quantity > 0),
  unit          public.nutrition_basis_unit not null default 'G',
  constraint measure_subject_one check (num_nonnulls(ingredient_id, product_id) = 1)
);

create index measures_by_ingredient on public.household_measures (ingredient_id);
create index measures_by_product on public.household_measures (product_id);

-- ---------------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger ingredients_touch before update on public.ingredients
  for each row execute function public.touch_updated_at();
create trigger products_touch before update on public.commercial_products
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: global legible por autenticados; privado solo para el hogar;
-- los hogares no modifican datos globales (política Baseline / ADR 0001 §5).
-- ---------------------------------------------------------------------------

alter table public.ingredient_categories enable row level security;
alter table public.ingredients enable row level security;
alter table public.commercial_products enable row level security;
alter table public.nutrition_facts enable row level security;
alter table public.household_measures enable row level security;

create policy categories_read on public.ingredient_categories
  for select to authenticated using (true);

create policy ingredients_select on public.ingredients
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));
create policy ingredients_insert on public.ingredients
  for insert to authenticated
  with check (household_id is not null and app.is_household_member(household_id));
create policy ingredients_update on public.ingredients
  for update to authenticated
  using (household_id is not null and app.is_household_member(household_id))
  with check (household_id is not null and app.is_household_member(household_id));

create policy products_select on public.commercial_products
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));
create policy products_insert on public.commercial_products
  for insert to authenticated
  with check (household_id is not null and app.is_household_member(household_id));
create policy products_update on public.commercial_products
  for update to authenticated
  using (household_id is not null and app.is_household_member(household_id))
  with check (household_id is not null and app.is_household_member(household_id));

create policy nutrition_select on public.nutrition_facts
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));
create policy nutrition_insert on public.nutrition_facts
  for insert to authenticated
  with check (household_id is not null and app.is_household_member(household_id));

create policy measures_select on public.household_measures
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));
create policy measures_write on public.household_measures
  for all to authenticated
  using (household_id is not null and app.is_household_member(household_id))
  with check (household_id is not null and app.is_household_member(household_id));
