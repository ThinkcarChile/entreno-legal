-- Sprint 3 — Recetas modulares y versionadas.
-- ADR 0002 (Recipe Versioning & Nutrition Aggregation): las cantidades son del
-- TOTAL de la receta base (no por persona), las versiones publicadas son
-- inmutables y congelan la ficha nutricional usada, y la agregación distingue
-- COMPLETE / PARTIAL / UNKNOWN.
-- Baseline: docs/architecture/BASELINE.md (K-21), Sprint 0 §C-3.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.meal_type as enum
  ('BREAKFAST', 'LUNCH', 'TEA', 'DINNER', 'DESSERT', 'SNACK', 'OTHER');

-- Ensaladas y postres NO son un subsistema aparte: son plantillas de otra clase
-- dentro de la misma arquitectura modular, referenciables desde un slot.
create type public.template_kind as enum ('MEAL', 'SALAD', 'DESSERT');

create type public.template_status as enum ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- La lista crece sin lógica hardcodeada: nada en el dominio hace switch por slot.
create type public.meal_slot_type as enum (
  'PROTEIN', 'CARBOHYDRATE', 'VEGETABLE', 'SALAD', 'FAT', 'SAUCE', 'FRUIT',
  'BASE', 'TOPPING', 'SWEETENER', 'DESSERT_COMPONENT', 'OPTIONAL', 'OTHER'
);

create type public.cooking_method as enum (
  'RAW', 'BOILED', 'STEAMED', 'BAKED', 'GRILLED', 'PAN_SEARED', 'FRIED',
  'AIR_FRYER', 'STEWED', 'POACHED', 'OTHER'
);

-- Compatibilidad de COCINA. Deliberadamente sin equivalencia nutricional.
create type public.culinary_compatibility as enum ('EXCELLENT', 'GOOD', 'ACCEPTABLE');

-- ---------------------------------------------------------------------------
-- Capacidades de equipamiento (catálogo global). El método base manual siempre
-- debe existir: ninguna receta común depende de equipamiento especial (K-15).
-- ---------------------------------------------------------------------------

create table public.equipment_capabilities (
  code text primary key,
  name text not null
);

insert into public.equipment_capabilities (code, name) values
  ('STOVETOP',       'Cocina / fuego'),
  ('OVEN',           'Horno'),
  ('AIR_FRYER',      'Air fryer'),
  ('MICROWAVE',      'Microondas'),
  ('GRILL',          'Parrilla'),
  ('BLENDER',        'Licuadora'),
  ('FOOD_PROCESSOR', 'Procesadora'),
  ('POT',            'Olla'),
  ('PAN',            'Sartén'),
  ('KNIFE',          'Cuchillo y tabla');

-- ---------------------------------------------------------------------------
-- Plantilla de comida (identidad mutable). El contenido vive en las versiones.
-- ---------------------------------------------------------------------------

create table public.meal_templates (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid references public.households (id) on delete cascade,
  -- NULL = biblioteca global (solo lectura para hogares)
  kind               public.template_kind not null default 'MEAL',
  name               text not null check (char_length(name) between 1 and 160),
  photo_url          text,
  is_verified        boolean not null default false,
  is_active          boolean not null default true,
  -- Última versión PUBLICADA; NULL mientras solo existan borradores.
  current_version_id uuid,
  copied_from_id     uuid references public.meal_templates (id) on delete set null,
  created_by         uuid references public.household_members (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index meal_templates_household_idx on public.meal_templates (household_id);
create index meal_templates_kind_idx on public.meal_templates (kind) where is_active;
create index meal_templates_name_trgm on public.meal_templates using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Versión inmutable (K-21). Publicar congela; editar crea la siguiente.
-- ---------------------------------------------------------------------------

create table public.meal_template_versions (
  id                 uuid primary key default gen_random_uuid(),
  template_id        uuid not null references public.meal_templates (id) on delete cascade,
  version_number     int not null check (version_number > 0),
  status             public.template_status not null default 'DRAFT',

  -- Metadata copiada en la versión: una versión publicada se explica sola.
  name               text not null check (char_length(name) between 1 and 160),
  description        text,
  meal_types         public.meal_type[] not null default '{}',
  base_time_minutes  int check (base_time_minutes > 0),

  -- Las cantidades de los componentes son de la receta TOTAL para estas
  -- porciones, nunca "por persona" (ADR 0002 §1).
  base_servings      int not null check (base_servings > 0),

  -- Rendimiento global crudo -> servible. NULL = DESCONOCIDO. Jamás se asume 1.
  total_yield_factor numeric(5, 4) check (total_yield_factor > 0 and total_yield_factor <= 2),

  published_at       timestamptz,
  published_by       uuid references public.household_members (id) on delete set null,
  created_at         timestamptz not null default now(),

  unique (template_id, version_number),
  constraint version_published_has_date
    check ((status = 'PUBLISHED') = (published_at is not null))
);

create index versions_template_idx on public.meal_template_versions (template_id, version_number desc);

alter table public.meal_templates
  add constraint meal_templates_current_version_fk
  foreign key (current_version_id) references public.meal_template_versions (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Slots de una versión. Un slot NO es un ingrediente: agrupa componentes.
-- ---------------------------------------------------------------------------

create table public.meal_slots (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references public.meal_template_versions (id) on delete cascade,
  slot_type   public.meal_slot_type not null,
  label       text check (char_length(label) between 1 and 120),
  is_required boolean not null default true,
  sort_order  int not null default 1,
  notes       text
);

create index slots_version_idx on public.meal_slots (version_id, sort_order);

-- ---------------------------------------------------------------------------
-- Componentes: un slot puede tener varios (ensalada = tomate + cebolla + ...).
-- Cada uno congela SU ficha nutricional al publicar (ADR 0002 §3).
-- ---------------------------------------------------------------------------

create table public.meal_slot_components (
  id                 uuid primary key default gen_random_uuid(),
  slot_id            uuid not null references public.meal_slots (id) on delete cascade,

  -- Exactamente uno de los tres: alimento genérico, producto comercial, o una
  -- ensalada/postre reutilizable (referenciada por VERSIÓN, no por plantilla:
  -- "Pollo + arroz + Ensalada Chilena v2").
  ingredient_id      uuid references public.ingredients (id) on delete restrict,
  product_id         uuid references public.commercial_products (id) on delete restrict,
  nested_version_id  uuid references public.meal_template_versions (id) on delete restrict,

  quantity           numeric(10, 3) not null check (quantity > 0),
  unit               public.nutrition_basis_unit not null default 'G',
  weight_basis       public.weight_basis not null default 'RAW',

  -- Medida doméstica con la que se expresó originalmente ("2 rebanadas"):
  -- se conserva el dato original además de la cantidad normalizada.
  measure_id         uuid references public.household_measures (id) on delete set null,
  measure_count      numeric(10, 2) check (measure_count > 0),

  -- Ficha usada. La referencia se conserva; el snapshot es lo que manda al
  -- calcular una versión publicada (una corrección posterior no reescribe historia).
  nutrition_fact_id  uuid references public.nutrition_facts (id) on delete set null,
  frozen_nutrition   jsonb,
  frozen_source      jsonb,

  cooking_method     public.cooking_method,
  -- Crudo -> cocido de ESTE componente. NULL = DESCONOCIDO, nunca 1 por defecto.
  yield_factor       numeric(5, 4) check (yield_factor > 0 and yield_factor <= 2),
  is_optional        boolean not null default false,
  sort_order         int not null default 1,
  notes              text,

  constraint component_target_one
    check (num_nonnulls(ingredient_id, product_id, nested_version_id) = 1)
);

create index components_slot_idx on public.meal_slot_components (slot_id, sort_order);
create index components_ingredient_idx on public.meal_slot_components (ingredient_id);

-- ---------------------------------------------------------------------------
-- Alternativas de slot: SOLO compatibilidad culinaria (ADR 0002 §4).
-- ---------------------------------------------------------------------------

create table public.meal_slot_alternatives (
  id                     uuid primary key default gen_random_uuid(),
  slot_id                uuid not null references public.meal_slots (id) on delete cascade,
  ingredient_id          uuid references public.ingredients (id) on delete cascade,
  product_id             uuid references public.commercial_products (id) on delete cascade,
  nested_version_id      uuid references public.meal_template_versions (id) on delete cascade,
  culinary_compatibility public.culinary_compatibility not null default 'GOOD',
  -- Ajuste de CANTIDAD sugerido por la cocina. NO es equivalencia nutricional:
  -- 200 g de pollo no son 200 g de pescado y esta tabla no permite afirmarlo.
  quantity_equivalence   numeric(5, 3) check (quantity_equivalence > 0),
  notes                  text,
  constraint alternative_target_one
    check (num_nonnulls(ingredient_id, product_id, nested_version_id) = 1)
);

create index alternatives_slot_idx on public.meal_slot_alternatives (slot_id);

comment on table public.meal_slot_alternatives is
  'Compatibilidad CULINARIA de reemplazos. No expresa equivalencia nutricional: '
  'las cantidades finales las calculará el PortionOptimizer (sprint posterior).';

-- ---------------------------------------------------------------------------
-- Pasos, con equipamiento opcional y alternativa manual obligatoria (K-15).
-- ---------------------------------------------------------------------------

create table public.recipe_steps (
  id                  uuid primary key default gen_random_uuid(),
  version_id          uuid not null references public.meal_template_versions (id) on delete cascade,
  step_number         int not null check (step_number > 0),
  instruction         text not null check (char_length(instruction) between 1 and 2000),
  duration_minutes    int check (duration_minutes > 0),
  temperature_c       int check (temperature_c between -30 and 400),
  required_capability text references public.equipment_capabilities (code),
  optional_capability text references public.equipment_capabilities (code),
  -- Si el paso mejora con equipamiento opcional, DEBE existir el camino manual.
  manual_alternative  text,
  parallel_group      int check (parallel_group > 0),
  notes               text,
  unique (version_id, step_number),
  constraint step_optional_needs_manual
    check (optional_capability is null or manual_alternative is not null)
);

create index steps_version_idx on public.recipe_steps (version_id, step_number);

-- ---------------------------------------------------------------------------
-- Cache de nutrición por versión (C-3 `recipe_nutrition`). Recalculable: la
-- fuente de verdad es el motor de dominio sobre las fichas congeladas.
-- ---------------------------------------------------------------------------

create table public.recipe_nutrition (
  version_id      uuid primary key references public.meal_template_versions (id) on delete cascade,
  energy_kcal     numeric(12, 3),
  protein_g       numeric(12, 3),
  carbohydrates_g numeric(12, 3),
  fat_g           numeric(12, 3),
  fiber_g         numeric(12, 3),
  sugars_g        numeric(12, 3),
  saturated_fat_g numeric(12, 3),
  sodium_mg       numeric(12, 3),
  potassium_mg    numeric(12, 3),
  phosphorus_mg   numeric(12, 3),
  -- {nutriente: COMPLETE|PARTIAL|UNKNOWN} — un total PARCIAL nunca se muestra
  -- como si fuera completo.
  completeness    jsonb not null default '{}'::jsonb,
  computed_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Favoritos: tabla lista, UI en sprint posterior (§25). No bloquea Sprint 3.
-- ---------------------------------------------------------------------------

create table public.member_favorites (
  member_id   uuid not null references public.household_members (id) on delete cascade,
  template_id uuid not null references public.meal_templates (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (member_id, template_id)
);

create trigger meal_templates_touch before update on public.meal_templates
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Ámbito y pertenencia
-- ---------------------------------------------------------------------------

create or replace function app.template_household(p_template uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.meal_templates where id = p_template;
$$;

create or replace function app.version_household(p_version uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select t.household_id
  from public.meal_template_versions v
  join public.meal_templates t on t.id = v.template_id
  where v.id = p_version;
$$;

create or replace function app.slot_version(p_slot uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select version_id from public.meal_slots where id = p_slot;
$$;

create or replace function app.slot_template(p_slot uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select v.template_id
  from public.meal_slots s
  join public.meal_template_versions v on v.id = s.version_id
  where s.id = p_slot;
$$;

/** Lectura: global o del hogar propio. */
create or replace function app.can_read_template(p_template uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.meal_templates t
    where t.id = p_template
      and (t.household_id is null or app.is_household_member(t.household_id))
  );
$$;

/** Escritura: SOLO recetas del propio hogar. Las globales son intocables. */
create or replace function app.can_write_template(p_template uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.meal_templates t
    where t.id = p_template
      and t.household_id is not null
      and app.is_household_member(t.household_id)
  );
$$;

create or replace function app.can_write_version(p_version uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.meal_template_versions v
    join public.meal_templates t on t.id = v.template_id
    where v.id = p_version
      and t.household_id is not null
      and app.is_household_member(t.household_id)
      and v.status = 'DRAFT'      -- publicado = historia, no se edita
  );
$$;

-- ---------------------------------------------------------------------------
-- Inmutabilidad de lo publicado (K-21), reforzada en la base y no solo en la UI
-- ---------------------------------------------------------------------------

create or replace function app.block_published_version_update()
returns trigger language plpgsql as $$
begin
  if old.status = 'PUBLISHED' then
    -- Lo único permitido sobre una versión publicada es archivarla.
    if new.status = 'ARCHIVED'
       and new.name is not distinct from old.name
       and new.base_servings is not distinct from old.base_servings
       and new.meal_types is not distinct from old.meal_types
       and new.total_yield_factor is not distinct from old.total_yield_factor then
      return new;
    end if;
    raise exception 'La versión % está publicada: edítala creando una versión nueva', old.version_number
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger versions_immutable before update on public.meal_template_versions
  for each row execute function app.block_published_version_update();

create or replace function app.block_published_content_change()
returns trigger language plpgsql as $$
declare
  v_version uuid;
  v_status public.template_status;
begin
  -- if/elsif y no un CASE: una expresión CASE se planifica entera y fallaría al
  -- referenciar new.slot_id en una tabla que no tiene esa columna.
  if tg_table_name in ('meal_slots', 'recipe_steps') then
    if tg_op = 'DELETE' then v_version := old.version_id;
    else v_version := new.version_id;
    end if;
  else
    if tg_op = 'DELETE' then v_version := app.slot_version(old.slot_id);
    else v_version := app.slot_version(new.slot_id);
    end if;
  end if;

  select status into v_status from public.meal_template_versions where id = v_version;
  if v_status = 'PUBLISHED' then
    raise exception 'El contenido de una versión publicada es inmutable'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger slots_immutable before insert or update or delete on public.meal_slots
  for each row execute function app.block_published_content_change();
create trigger components_immutable before insert or update or delete on public.meal_slot_components
  for each row execute function app.block_published_content_change();
create trigger alternatives_immutable before insert or update or delete on public.meal_slot_alternatives
  for each row execute function app.block_published_content_change();
create trigger steps_immutable before insert or update or delete on public.recipe_steps
  for each row execute function app.block_published_content_change();

-- ---------------------------------------------------------------------------
-- RPC: crear plantilla + versión 1 en borrador
-- ---------------------------------------------------------------------------

create or replace function public.create_meal_template(
  p_household_id  uuid,
  p_name          text,
  p_kind          public.template_kind,
  p_meal_types    public.meal_type[],
  p_base_servings int
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_template uuid;
  v_version uuid;
  v_member uuid;
begin
  if not app.is_household_member(p_household_id) then
    raise exception 'no autorizado';
  end if;
  v_member := app.current_member_id(p_household_id);

  insert into public.meal_templates (household_id, kind, name, created_by)
  values (p_household_id, coalesce(p_kind, 'MEAL'), p_name, v_member)
  returning id into v_template;

  insert into public.meal_template_versions
    (template_id, version_number, status, name, meal_types, base_servings)
  values (v_template, 1, 'DRAFT', p_name, coalesce(p_meal_types, '{}'), p_base_servings)
  returning id into v_version;

  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: reemplazar el contenido de un BORRADOR de forma atómica
-- ---------------------------------------------------------------------------

create or replace function public.replace_draft_content(p_version_id uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_slot_json jsonb;
  v_comp_json jsonb;
  v_alt_json jsonb;
  v_step_json jsonb;
  v_slot uuid;
begin
  if not app.can_write_version(p_version_id) then
    raise exception 'no autorizado o la versión no es un borrador';
  end if;

  update public.meal_template_versions set
    name              = coalesce(p_payload->>'name', name),
    description       = p_payload->>'description',
    base_servings     = coalesce((p_payload->>'base_servings')::int, base_servings),
    base_time_minutes = (p_payload->>'base_time_minutes')::int,
    total_yield_factor= (p_payload->>'total_yield_factor')::numeric,
    meal_types        = coalesce(
      (select array_agg(value::text::public.meal_type)
         from jsonb_array_elements_text(p_payload->'meal_types') as value),
      meal_types)
  where id = p_version_id;

  delete from public.meal_slots where version_id = p_version_id;
  delete from public.recipe_steps where version_id = p_version_id;

  for v_slot_json in select * from jsonb_array_elements(coalesce(p_payload->'slots', '[]'::jsonb)) loop
    insert into public.meal_slots (version_id, slot_type, label, is_required, sort_order, notes)
    values (
      p_version_id,
      (v_slot_json->>'slot_type')::public.meal_slot_type,
      nullif(v_slot_json->>'label', ''),
      coalesce((v_slot_json->>'is_required')::boolean, true),
      coalesce((v_slot_json->>'sort_order')::int, 1),
      nullif(v_slot_json->>'notes', '')
    ) returning id into v_slot;

    for v_comp_json in select * from jsonb_array_elements(coalesce(v_slot_json->'components', '[]'::jsonb)) loop
      insert into public.meal_slot_components (
        slot_id, ingredient_id, product_id, nested_version_id,
        quantity, unit, weight_basis, measure_id, measure_count,
        nutrition_fact_id, cooking_method, yield_factor, is_optional, sort_order, notes
      ) values (
        v_slot,
        nullif(v_comp_json->>'ingredient_id', '')::uuid,
        nullif(v_comp_json->>'product_id', '')::uuid,
        nullif(v_comp_json->>'nested_version_id', '')::uuid,
        (v_comp_json->>'quantity')::numeric,
        coalesce((v_comp_json->>'unit')::public.nutrition_basis_unit, 'G'),
        coalesce((v_comp_json->>'weight_basis')::public.weight_basis, 'RAW'),
        nullif(v_comp_json->>'measure_id', '')::uuid,
        (v_comp_json->>'measure_count')::numeric,
        nullif(v_comp_json->>'nutrition_fact_id', '')::uuid,
        (nullif(v_comp_json->>'cooking_method', ''))::public.cooking_method,
        (v_comp_json->>'yield_factor')::numeric,
        coalesce((v_comp_json->>'is_optional')::boolean, false),
        coalesce((v_comp_json->>'sort_order')::int, 1),
        nullif(v_comp_json->>'notes', '')
      );
    end loop;

    for v_alt_json in select * from jsonb_array_elements(coalesce(v_slot_json->'alternatives', '[]'::jsonb)) loop
      insert into public.meal_slot_alternatives (
        slot_id, ingredient_id, product_id, nested_version_id,
        culinary_compatibility, quantity_equivalence, notes
      ) values (
        v_slot,
        nullif(v_alt_json->>'ingredient_id', '')::uuid,
        nullif(v_alt_json->>'product_id', '')::uuid,
        nullif(v_alt_json->>'nested_version_id', '')::uuid,
        coalesce((v_alt_json->>'culinary_compatibility')::public.culinary_compatibility, 'GOOD'),
        (v_alt_json->>'quantity_equivalence')::numeric,
        nullif(v_alt_json->>'notes', '')
      );
    end loop;
  end loop;

  for v_step_json in select * from jsonb_array_elements(coalesce(p_payload->'steps', '[]'::jsonb)) loop
    insert into public.recipe_steps (
      version_id, step_number, instruction, duration_minutes, temperature_c,
      required_capability, optional_capability, manual_alternative, parallel_group, notes
    ) values (
      p_version_id,
      (v_step_json->>'step_number')::int,
      v_step_json->>'instruction',
      (v_step_json->>'duration_minutes')::int,
      (v_step_json->>'temperature_c')::int,
      nullif(v_step_json->>'required_capability', ''),
      nullif(v_step_json->>'optional_capability', ''),
      nullif(v_step_json->>'manual_alternative', ''),
      (v_step_json->>'parallel_group')::int,
      nullif(v_step_json->>'notes', '')
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: publicar. Congela la ficha nutricional de cada componente ANTES de
-- marcar la versión como publicada (después ya sería inmutable).
-- ---------------------------------------------------------------------------

create or replace function public.publish_meal_template_version(p_version_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_template uuid;
  v_household uuid;
  v_components int;
begin
  if not app.can_write_version(p_version_id) then
    raise exception 'no autorizado o la versión no es un borrador';
  end if;

  select template_id into v_template from public.meal_template_versions where id = p_version_id;
  v_household := app.template_household(v_template);

  select count(*) into v_components
  from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  where s.version_id = p_version_id;
  if v_components = 0 then
    raise exception 'una receta sin ingredientes no se publica';
  end if;

  -- Congelar la ficha usada: una corrección posterior del catálogo no puede
  -- reescribir la nutrición de esta versión (ADR 0002 §3).
  update public.meal_slot_components c set
    frozen_nutrition = jsonb_build_object(
      'weight_basis', f.weight_basis,
      'basis_unit',   f.basis_unit,
      'values', jsonb_strip_nulls(jsonb_build_object(
        'energy_kcal', f.energy_kcal, 'protein_g', f.protein_g,
        'carbohydrates_g', f.carbohydrates_g, 'fat_g', f.fat_g,
        'fiber_g', f.fiber_g, 'sugars_g', f.sugars_g,
        'saturated_fat_g', f.saturated_fat_g, 'sodium_mg', f.sodium_mg,
        'potassium_mg', f.potassium_mg, 'phosphorus_mg', f.phosphorus_mg))
    ),
    frozen_source = jsonb_build_object(
      'source_type', f.source_type, 'source_name', f.source_name,
      'source_version', f.source_version, 'verified', f.verified,
      'nutrition_fact_id', f.id
    )
  from public.nutrition_facts f
  where f.id = c.nutrition_fact_id
    and c.slot_id in (select id from public.meal_slots where version_id = p_version_id);

  update public.meal_template_versions
  set status = 'PUBLISHED',
      published_at = now(),
      published_by = app.current_member_id(v_household)
  where id = p_version_id;

  update public.meal_templates
  set current_version_id = p_version_id
  where id = v_template;

  if v_household is not null then
    insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
    values (v_household, auth.uid(), 'RECIPE_VERSION_PUBLISHED', 'meal_template_version', p_version_id);
  end if;

  return p_version_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: editar una versión publicada = crear la siguiente en borrador
-- ---------------------------------------------------------------------------

create or replace function public.create_draft_from_version(p_version_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_src public.meal_template_versions;
  v_new uuid;
  v_slot record;
  v_new_slot uuid;
begin
  select * into v_src from public.meal_template_versions where id = p_version_id;
  if not found then raise exception 'versión inexistente'; end if;
  if not app.can_write_template(v_src.template_id) then raise exception 'no autorizado'; end if;

  if exists (select 1 from public.meal_template_versions
             where template_id = v_src.template_id and status = 'DRAFT') then
    raise exception 'ya existe un borrador para esta receta';
  end if;

  insert into public.meal_template_versions
    (template_id, version_number, status, name, description, meal_types,
     base_time_minutes, base_servings, total_yield_factor)
  select v_src.template_id,
         coalesce(max(version_number), 0) + 1,
         'DRAFT', v_src.name, v_src.description, v_src.meal_types,
         v_src.base_time_minutes, v_src.base_servings, v_src.total_yield_factor
  from public.meal_template_versions where template_id = v_src.template_id
  returning id into v_new;

  for v_slot in select * from public.meal_slots where version_id = p_version_id order by sort_order loop
    insert into public.meal_slots (version_id, slot_type, label, is_required, sort_order, notes)
    values (v_new, v_slot.slot_type, v_slot.label, v_slot.is_required, v_slot.sort_order, v_slot.notes)
    returning id into v_new_slot;

    insert into public.meal_slot_components (
      slot_id, ingredient_id, product_id, nested_version_id, quantity, unit, weight_basis,
      measure_id, measure_count, nutrition_fact_id, cooking_method, yield_factor,
      is_optional, sort_order, notes)
    select v_new_slot, ingredient_id, product_id, nested_version_id, quantity, unit, weight_basis,
           measure_id, measure_count, nutrition_fact_id, cooking_method, yield_factor,
           is_optional, sort_order, notes
    from public.meal_slot_components where slot_id = v_slot.id;

    insert into public.meal_slot_alternatives (
      slot_id, ingredient_id, product_id, nested_version_id,
      culinary_compatibility, quantity_equivalence, notes)
    select v_new_slot, ingredient_id, product_id, nested_version_id,
           culinary_compatibility, quantity_equivalence, notes
    from public.meal_slot_alternatives where slot_id = v_slot.id;
  end loop;

  insert into public.recipe_steps (
    version_id, step_number, instruction, duration_minutes, temperature_c,
    required_capability, optional_capability, manual_alternative, parallel_group, notes)
  select v_new, step_number, instruction, duration_minutes, temperature_c,
         required_capability, optional_capability, manual_alternative, parallel_group, notes
  from public.recipe_steps where version_id = p_version_id;

  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: duplicar / "copiar a mis recetas". Sirve para experimentar sin destruir
-- la original y para llevarse una receta global al hogar (§27, §28).
-- ---------------------------------------------------------------------------

create or replace function public.duplicate_meal_template(
  p_template_id  uuid,
  p_household_id uuid,
  p_name         text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_src public.meal_templates;
  v_src_version uuid;
  v_new_template uuid;
  v_new_version uuid;
  v_slot record;
  v_new_slot uuid;
begin
  if not app.is_household_member(p_household_id) then raise exception 'no autorizado'; end if;
  if not app.can_read_template(p_template_id) then raise exception 'receta no visible'; end if;

  select * into v_src from public.meal_templates where id = p_template_id;

  v_src_version := coalesce(
    v_src.current_version_id,
    (select id from public.meal_template_versions
     where template_id = p_template_id order by version_number desc limit 1));
  if v_src_version is null then raise exception 'la receta no tiene contenido que copiar'; end if;

  insert into public.meal_templates (household_id, kind, name, photo_url, copied_from_id, created_by)
  values (p_household_id, v_src.kind, coalesce(p_name, v_src.name || ' (copia)'),
          v_src.photo_url, v_src.id, app.current_member_id(p_household_id))
  returning id into v_new_template;

  insert into public.meal_template_versions
    (template_id, version_number, status, name, description, meal_types,
     base_time_minutes, base_servings, total_yield_factor)
  select v_new_template, 1, 'DRAFT', coalesce(p_name, v.name || ' (copia)'), v.description,
         v.meal_types, v.base_time_minutes, v.base_servings, v.total_yield_factor
  from public.meal_template_versions v where v.id = v_src_version
  returning id into v_new_version;

  for v_slot in select * from public.meal_slots where version_id = v_src_version order by sort_order loop
    insert into public.meal_slots (version_id, slot_type, label, is_required, sort_order, notes)
    values (v_new_version, v_slot.slot_type, v_slot.label, v_slot.is_required, v_slot.sort_order, v_slot.notes)
    returning id into v_new_slot;

    insert into public.meal_slot_components (
      slot_id, ingredient_id, product_id, nested_version_id, quantity, unit, weight_basis,
      measure_id, measure_count, nutrition_fact_id, cooking_method, yield_factor,
      is_optional, sort_order, notes)
    select v_new_slot, ingredient_id, product_id, nested_version_id, quantity, unit, weight_basis,
           measure_id, measure_count, nutrition_fact_id, cooking_method, yield_factor,
           is_optional, sort_order, notes
    from public.meal_slot_components where slot_id = v_slot.id;

    insert into public.meal_slot_alternatives (
      slot_id, ingredient_id, product_id, nested_version_id,
      culinary_compatibility, quantity_equivalence, notes)
    select v_new_slot, ingredient_id, product_id, nested_version_id,
           culinary_compatibility, quantity_equivalence, notes
    from public.meal_slot_alternatives where slot_id = v_slot.id;
  end loop;

  insert into public.recipe_steps (
    version_id, step_number, instruction, duration_minutes, temperature_c,
    required_capability, optional_capability, manual_alternative, parallel_group, notes)
  select v_new_version, step_number, instruction, duration_minutes, temperature_c,
         required_capability, optional_capability, manual_alternative, parallel_group, notes
  from public.recipe_steps where version_id = v_src_version;

  return v_new_template;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.equipment_capabilities enable row level security;
alter table public.meal_templates enable row level security;
alter table public.meal_template_versions enable row level security;
alter table public.meal_slots enable row level security;
alter table public.meal_slot_components enable row level security;
alter table public.meal_slot_alternatives enable row level security;
alter table public.recipe_steps enable row level security;
alter table public.recipe_nutrition enable row level security;
alter table public.member_favorites enable row level security;

create policy capabilities_read on public.equipment_capabilities
  for select to authenticated using (true);

-- Plantillas: se ven las globales y las del hogar; se escriben SOLO las del hogar.
create policy templates_select on public.meal_templates
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));
create policy templates_insert on public.meal_templates
  for insert to authenticated
  with check (household_id is not null and app.is_household_member(household_id));
create policy templates_update on public.meal_templates
  for update to authenticated
  using (household_id is not null and app.is_household_member(household_id))
  with check (household_id is not null and app.is_household_member(household_id));
create policy templates_delete on public.meal_templates
  for delete to authenticated
  using (household_id is not null and app.is_household_member(household_id));

create policy versions_select on public.meal_template_versions
  for select to authenticated using (app.can_read_template(template_id));
create policy versions_insert on public.meal_template_versions
  for insert to authenticated with check (app.can_write_template(template_id));
create policy versions_update on public.meal_template_versions
  for update to authenticated
  using (app.can_write_template(template_id))
  with check (app.can_write_template(template_id));

create policy slots_select on public.meal_slots
  for select to authenticated
  using (app.can_read_template((select template_id from public.meal_template_versions where id = version_id)));
create policy slots_write on public.meal_slots
  for all to authenticated
  using (app.can_write_version(version_id))
  with check (app.can_write_version(version_id));

create policy components_select on public.meal_slot_components
  for select to authenticated
  using (app.can_read_template(app.slot_template(slot_id)));
create policy components_write on public.meal_slot_components
  for all to authenticated
  using (app.can_write_version(app.slot_version(slot_id)))
  with check (app.can_write_version(app.slot_version(slot_id)));

create policy alternatives_select on public.meal_slot_alternatives
  for select to authenticated
  using (app.can_read_template(app.slot_template(slot_id)));
create policy alternatives_write on public.meal_slot_alternatives
  for all to authenticated
  using (app.can_write_version(app.slot_version(slot_id)))
  with check (app.can_write_version(app.slot_version(slot_id)));

create policy steps_select on public.recipe_steps
  for select to authenticated
  using (app.can_read_template((select template_id from public.meal_template_versions where id = version_id)));
create policy steps_write on public.recipe_steps
  for all to authenticated
  using (app.can_write_version(version_id))
  with check (app.can_write_version(version_id));

create policy recipe_nutrition_select on public.recipe_nutrition
  for select to authenticated
  using (app.can_read_template((select template_id from public.meal_template_versions where id = version_id)));
create policy recipe_nutrition_write on public.recipe_nutrition
  for all to authenticated
  using (app.can_write_template((select template_id from public.meal_template_versions where id = version_id)))
  with check (app.can_write_template((select template_id from public.meal_template_versions where id = version_id)));

create policy favorites_all on public.member_favorites
  for all to authenticated
  using (exists (select 1 from public.household_members m
                 where m.id = member_id and app.is_household_member(m.household_id)))
  with check (exists (select 1 from public.household_members m
                      where m.id = member_id and app.is_household_member(m.household_id)));
