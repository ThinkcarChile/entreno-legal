-- Sprint 4 — Perfiles nutricionales, objetivos y porciones personales.
-- "Si hoy la familia come pollo con arroz, ¿cuánto se sirve cada persona?"
--
-- Baseline: Sprint 0 §C-2 (nutrition_goals, member_nutrition_profiles,
-- meal_patterns, day_templates, member_daily_nutrition_plans), §C-4
-- (preferencias), §E-2 (PortionOptimizer), K-3 (perfil versionado), K-25
-- (tracking OFF/BASIC/FULL).

-- FRUIT como momento de comida propio (§7). Se agrega antes que nada y no se
-- usa en esta misma migración: un valor de enum recién creado no puede
-- utilizarse en la transacción que lo crea.
alter type public.meal_type add value if not exists 'FRUIT';

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- K-25: nivel, no booleano. OFF participa de todo salvo el conteo.
create type public.tracking_mode as enum ('OFF', 'BASIC', 'FULL');

create type public.goal_type as enum
  ('ENERGY_KCAL', 'PROTEIN_G', 'CARBOHYDRATE_G', 'FAT_G', 'FIBER_G');

create type public.goal_scope as enum ('DAILY', 'PER_MEAL');

create type public.goal_source as enum ('USER', 'CLINICIAN', 'SYSTEM', 'AI_PROPOSAL');

-- La tabla de objetivos ES el historial: nunca se actualiza en destructivo.
create type public.goal_status as enum ('ACTIVE', 'SUPERSEDED', 'PROPOSED', 'REJECTED');

create type public.meal_availability as enum ('ENABLED', 'DISABLED', 'OPTIONAL');

-- HARD vs SOFT (§12): las tres últimas son de seguridad y el optimizador
-- JAMÁS puede violarlas; las primeras penalizan y explican, no prohíben.
create type public.preference_type as enum
  ('FAVORITE', 'LIKE', 'NEUTRAL', 'DISLIKE', 'AVOID', 'INTOLERANCE', 'ALLERGY', 'MEDICAL_RESTRICTION');

create type public.preference_target_kind as enum
  ('INGREDIENT', 'CATEGORY', 'MEAL_TEMPLATE', 'PRODUCT');

create type public.cooking_stance as enum ('PREFERRED', 'ACCEPTED', 'AVOID');

create type public.added_fat_stance as enum ('AVOID', 'ALLOWED', 'PREFERRED');

create type public.salad_preference as enum ('PREFERRED', 'NEUTRAL', 'AVOID');

-- §28: no se ajusta la sal ni una salsa crítica solo para cuadrar calorías.
create type public.slot_adjustability as enum ('FIXED', 'ADJUSTABLE', 'OPTIONAL');

create type public.personal_meal_fit as enum (
  'COMPATIBLE',
  'COMPATIBLE_WITH_PORTION_CHANGE',
  'COMPATIBLE_WITH_COOKING_CHANGE',
  'COMPATIBLE_WITH_ONE_SUBSTITUTION',
  'TARGET_CONFLICT',
  'NOT_COMPATIBLE'
);

create type public.day_template_kind as enum
  ('NORMAL', 'TRAINING', 'REST', 'LARGE_LUNCH', 'SOCIAL', 'CUSTOM');

-- ---------------------------------------------------------------------------
-- Ajustabilidad de los componentes de una receta (§28, §29)
-- ---------------------------------------------------------------------------

alter table public.meal_slot_components
  add column adjustability public.slot_adjustability,
  add column min_quantity  numeric(10, 3) check (min_quantity >= 0),
  add column max_quantity  numeric(10, 3) check (max_quantity > 0);

-- Relleno de lo ya existente. Los triggers de inmutabilidad protegen ediciones
-- de contenido; esto es una migración de esquema sobre filas ya escritas, así
-- que se suspenden y se vuelven a activar en el mismo paso.
alter table public.meal_slot_components disable trigger components_immutable;
update public.meal_slot_components
set adjustability = (case when is_optional then 'OPTIONAL' else 'ADJUSTABLE' end)::public.slot_adjustability;
alter table public.meal_slot_components enable trigger components_immutable;

alter table public.meal_slot_components
  alter column adjustability set default 'ADJUSTABLE',
  alter column adjustability set not null,
  add constraint component_quantity_bounds
    check (min_quantity is null or max_quantity is null or min_quantity <= max_quantity),
  -- Si el componente es opcional, su ajustabilidad es OPTIONAL. Sin esto un
  -- aceite opcional podria quedar como ADJUSTABLE y el optimizador nunca podria
  -- sacarlo del plato de quien evita la grasa anadida.
  add constraint component_optional_is_optional
    check (not is_optional or adjustability = 'OPTIONAL');

-- ---------------------------------------------------------------------------
-- Tracking (K-25)
-- ---------------------------------------------------------------------------

create table public.member_tracking_settings (
  member_id  uuid primary key references public.household_members (id) on delete cascade,
  mode       public.tracking_mode not null default 'OFF',
  updated_at timestamptz not null default now()
);

comment on table public.member_tracking_settings is
  'OFF no significa excluido: la persona participa de recetas, porciones y '
  'planificación; simplemente no se le exige ni se le muestra conteo de kcal.';

-- ---------------------------------------------------------------------------
-- Objetivos con rango y vigencia (§4, §5, §6). La tabla es el historial.
-- ---------------------------------------------------------------------------

create table public.nutrition_goals (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references public.household_members (id) on delete cascade,
  goal_type  public.goal_type not null,
  scope      public.goal_scope not null default 'DAILY',
  meal_type  public.meal_type,
  -- Ninguno es obligatorio: "mínimo 120, ideal 130, sin máximo" es válido.
  minimum    numeric(10, 3) check (minimum >= 0),
  preferred  numeric(10, 3) check (preferred >= 0),
  maximum    numeric(10, 3) check (maximum >= 0),
  unit       text not null,
  priority   int not null default 100,
  start_date date not null default current_date,
  end_date   date,
  source     public.goal_source not null default 'USER',
  status     public.goal_status not null default 'ACTIVE',
  created_by uuid references public.household_members (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint goal_has_a_number check (num_nonnulls(minimum, preferred, maximum) >= 1),
  constraint goal_range_ordered check (
    (minimum is null or preferred is null or minimum <= preferred) and
    (preferred is null or maximum is null or preferred <= maximum) and
    (minimum is null or maximum is null or minimum <= maximum)
  ),
  constraint goal_meal_scope check ((scope = 'PER_MEAL') = (meal_type is not null)),
  -- Una propuesta de IA no entra en cálculo hasta que alguien la confirme.
  constraint goal_ai_starts_proposed
    check (not (source = 'AI_PROPOSAL' and status = 'ACTIVE'))
);

-- Un objetivo activo por tipo y ámbito. Dos índices parciales en vez de uno con
-- coalesce: convertir un enum a texto no es IMMUTABLE y no sirve en un índice.
create unique index goals_active_daily_uniq
  on public.nutrition_goals (member_id, goal_type)
  where status = 'ACTIVE' and scope = 'DAILY';
create unique index goals_active_meal_uniq
  on public.nutrition_goals (member_id, goal_type, meal_type)
  where status = 'ACTIVE' and scope = 'PER_MEAL';
create index goals_by_member on public.nutrition_goals (member_id, start_date desc);

-- ---------------------------------------------------------------------------
-- Patrón de comidas y ayuno (§7, §8)
-- ---------------------------------------------------------------------------

create table public.meal_patterns (
  id                   uuid primary key default gen_random_uuid(),
  member_id            uuid not null unique references public.household_members (id) on delete cascade,
  -- Ayuno intermitente = configuración elegida por la persona, NUNCA una
  -- recomendación médica del sistema.
  uses_fasting_pattern boolean not null default false,
  first_meal_type      public.meal_type,
  feeding_window_start time,
  feeding_window_end   time,
  updated_at           timestamptz not null default now()
);

create table public.meal_pattern_slots (
  id               uuid primary key default gen_random_uuid(),
  pattern_id       uuid not null references public.meal_patterns (id) on delete cascade,
  meal_type        public.meal_type not null,
  availability     public.meal_availability not null default 'ENABLED',
  is_first_meal    boolean not null default false,
  salad_preference public.salad_preference not null default 'NEUTRAL',
  priority         int not null default 100,
  sort_order       int not null default 1,
  unique (pattern_id, meal_type)
);

-- ---------------------------------------------------------------------------
-- Preferencias de alimentos (§12, §13) y de preparación (§14, §15)
-- ---------------------------------------------------------------------------

create table public.member_preferences (
  id              uuid primary key default gen_random_uuid(),
  member_id       uuid not null references public.household_members (id) on delete cascade,
  preference_type public.preference_type not null,
  target_kind     public.preference_target_kind not null default 'INGREDIENT',
  target_id       uuid not null,
  severity        int check (severity between 1 and 5),
  notes           text,
  created_at      timestamptz not null default now(),
  unique (member_id, target_kind, target_id)
);

create index preferences_by_member on public.member_preferences (member_id, preference_type);
create index preferences_by_target on public.member_preferences (target_kind, target_id);

comment on column public.member_preferences.preference_type is
  'DISLIKE/AVOID son SOFT: penalizan y explican. ALLERGY/INTOLERANCE/'
  'MEDICAL_RESTRICTION son HARD: el optimizador nunca las viola.';

create table public.member_cooking_preferences (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references public.household_members (id) on delete cascade,
  -- Prioridad de resolución (§14): ingrediente > categoría > global (ambos NULL).
  ingredient_id  uuid references public.ingredients (id) on delete cascade,
  category_id    uuid references public.ingredient_categories (id) on delete cascade,
  cooking_method public.cooking_method not null,
  stance         public.cooking_stance not null default 'PREFERRED',
  notes          text,
  constraint cooking_pref_one_target check (num_nonnulls(ingredient_id, category_id) <= 1),
  unique (member_id, ingredient_id, category_id, cooking_method)
);

create index cooking_prefs_by_member on public.member_cooking_preferences (member_id);

-- Grasa añadida como preferencia propia y explícita (§15): freír no cuesta lo
-- mismo que air fryer sin aceite, y eso pertenece a la porción de esa persona.
create table public.member_added_fat_preferences (
  member_id uuid primary key references public.household_members (id) on delete cascade,
  stance    public.added_fat_stance not null default 'ALLOWED',
  notes     text
);

-- ---------------------------------------------------------------------------
-- Plantillas de día y excepciones por fecha (§19, §20, §21)
-- ---------------------------------------------------------------------------

create table public.day_templates (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid references public.households (id) on delete cascade,
  member_id    uuid references public.household_members (id) on delete cascade,
  kind         public.day_template_kind not null default 'NORMAL',
  name         text not null,
  created_at   timestamptz not null default now(),
  constraint day_template_owner check (num_nonnulls(household_id, member_id) = 1)
);

create table public.day_template_meals (
  id                uuid primary key default gen_random_uuid(),
  template_id       uuid not null references public.day_templates (id) on delete cascade,
  meal_type         public.meal_type not null,
  enabled           boolean not null default true,
  energy_min        numeric(10, 3),
  energy_preferred  numeric(10, 3),
  energy_max        numeric(10, 3),
  protein_min       numeric(10, 3),
  protein_preferred numeric(10, 3),
  protein_max       numeric(10, 3),
  unique (template_id, meal_type)
);

-- La excepción por fecha NO modifica el patrón habitual (§19).
create table public.member_daily_nutrition_plans (
  id                    uuid primary key default gen_random_uuid(),
  member_id             uuid not null references public.household_members (id) on delete cascade,
  plan_date             date not null,
  template_id           uuid references public.day_templates (id) on delete set null,
  daily_energy_target   numeric(10, 3),
  daily_protein_target  numeric(10, 3),
  note                  text,
  created_at            timestamptz not null default now(),
  unique (member_id, plan_date)
);

create table public.member_daily_plan_meals (
  id                uuid primary key default gen_random_uuid(),
  plan_id           uuid not null references public.member_daily_nutrition_plans (id) on delete cascade,
  meal_type         public.meal_type not null,
  enabled           boolean not null default true,
  energy_min        numeric(10, 3),
  energy_preferred  numeric(10, 3),
  energy_max        numeric(10, 3),
  protein_min       numeric(10, 3),
  protein_preferred numeric(10, 3),
  protein_max       numeric(10, 3),
  unique (plan_id, meal_type)
);

-- ---------------------------------------------------------------------------
-- Snapshot versionado e inmutable del perfil (§16, K-3)
-- ---------------------------------------------------------------------------

create table public.member_nutrition_profiles (
  id              uuid primary key default gen_random_uuid(),
  member_id       uuid not null references public.household_members (id) on delete cascade,
  version         int not null check (version > 0),
  is_current      boolean not null default true,
  effective_from  timestamptz not null default now(),
  tracking_mode   public.tracking_mode not null,
  -- Entradas que produjeron el snapshot: ids y versiones, para poder explicar
  -- después "por qué calculamos esta porción".
  computed_inputs jsonb not null default '{}'::jsonb,
  input_signature text not null,
  daily_targets   jsonb not null default '{}'::jsonb,
  meal_targets    jsonb not null default '{}'::jsonb,
  preferences     jsonb not null default '{}'::jsonb,
  conflicts       jsonb not null default '[]'::jsonb,
  reason          text,
  created_at      timestamptz not null default now(),
  unique (member_id, version)
);

create unique index profiles_current_uniq
  on public.member_nutrition_profiles (member_id) where is_current;

-- Un snapshot no se reescribe: se crea el siguiente. Solo se permite dejar de
-- ser el vigente.
create or replace function app.block_profile_rewrite()
returns trigger language plpgsql as $$
begin
  if new.input_signature is distinct from old.input_signature
     or new.daily_targets is distinct from old.daily_targets
     or new.meal_targets is distinct from old.meal_targets
     or new.version is distinct from old.version then
    raise exception 'Un perfil nutricional es un snapshot inmutable: crea la versión siguiente'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger profiles_immutable before update on public.member_nutrition_profiles
  for each row execute function app.block_profile_rewrite();

-- ---------------------------------------------------------------------------
-- Porciones calculadas (§22, §46). Se guardan con TODAS sus versiones de
-- entrada: receta, perfil, override y versión del optimizador.
-- ---------------------------------------------------------------------------

create table public.member_serving_projections (
  id                   uuid primary key default gen_random_uuid(),
  member_id            uuid not null references public.household_members (id) on delete cascade,
  version_id           uuid not null references public.meal_template_versions (id) on delete cascade,
  profile_id           uuid not null references public.member_nutrition_profiles (id) on delete cascade,
  daily_plan_id        uuid references public.member_daily_nutrition_plans (id) on delete set null,
  optimizer_version    text not null,
  meal_type            public.meal_type not null,
  serving_date         date,
  fit                  public.personal_meal_fit not null,
  adaptation_level     int not null check (adaptation_level between 0 and 4),
  score                numeric(6, 3),
  nutrition            jsonb not null default '{}'::jsonb,
  completeness         jsonb not null default '{}'::jsonb,
  reasons              jsonb not null default '[]'::jsonb,
  unmet_constraints    jsonb not null default '[]'::jsonb,
  created_at           timestamptz not null default now()
);

create index servings_by_version on public.member_serving_projections (version_id, meal_type);
create index servings_by_member on public.member_serving_projections (member_id, created_at desc);

create table public.member_serving_components (
  id                uuid primary key default gen_random_uuid(),
  projection_id     uuid not null references public.member_serving_projections (id) on delete cascade,
  component_id      uuid references public.meal_slot_components (id) on delete set null,
  label             text not null,
  base_quantity     numeric(10, 3) not null,
  proposed_quantity numeric(10, 3) not null check (proposed_quantity >= 0),
  unit              public.nutrition_basis_unit not null,
  weight_basis      public.weight_basis not null,
  cooking_method    public.cooking_method,
  -- Grasa añadida por la preparación de ESTA persona (§35).
  added_fat_g       numeric(10, 3) check (added_fat_g >= 0),
  substituted_for   uuid references public.ingredients (id) on delete set null,
  sort_order        int not null default 1
);

create index serving_components_by_projection
  on public.member_serving_components (projection_id, sort_order);

-- ---------------------------------------------------------------------------
-- RLS: todo esto es dato personal. Aislamiento por hogar (§50, §51).
-- ---------------------------------------------------------------------------

create or replace function app.member_household(p_member uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.household_members where id = p_member;
$$;

create or replace function app.can_access_member(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members m
    where m.id = p_member and app.is_household_member(m.household_id)
  );
$$;

alter table public.member_tracking_settings      enable row level security;
alter table public.nutrition_goals               enable row level security;
alter table public.meal_patterns                 enable row level security;
alter table public.meal_pattern_slots            enable row level security;
alter table public.member_preferences            enable row level security;
alter table public.member_cooking_preferences    enable row level security;
alter table public.member_added_fat_preferences  enable row level security;
alter table public.day_templates                 enable row level security;
alter table public.day_template_meals            enable row level security;
alter table public.member_daily_nutrition_plans  enable row level security;
alter table public.member_daily_plan_meals       enable row level security;
alter table public.member_nutrition_profiles     enable row level security;
alter table public.member_serving_projections    enable row level security;
alter table public.member_serving_components     enable row level security;

create policy tracking_all on public.member_tracking_settings
  for all to authenticated
  using (app.can_access_member(member_id)) with check (app.can_access_member(member_id));

create policy goals_all on public.nutrition_goals
  for all to authenticated
  using (app.can_access_member(member_id)) with check (app.can_access_member(member_id));

create policy patterns_all on public.meal_patterns
  for all to authenticated
  using (app.can_access_member(member_id)) with check (app.can_access_member(member_id));

create policy pattern_slots_all on public.meal_pattern_slots
  for all to authenticated
  using (exists (select 1 from public.meal_patterns p
                 where p.id = pattern_id and app.can_access_member(p.member_id)))
  with check (exists (select 1 from public.meal_patterns p
                      where p.id = pattern_id and app.can_access_member(p.member_id)));

create policy preferences_all on public.member_preferences
  for all to authenticated
  using (app.can_access_member(member_id)) with check (app.can_access_member(member_id));

create policy cooking_prefs_all on public.member_cooking_preferences
  for all to authenticated
  using (app.can_access_member(member_id)) with check (app.can_access_member(member_id));

create policy fat_prefs_all on public.member_added_fat_preferences
  for all to authenticated
  using (app.can_access_member(member_id)) with check (app.can_access_member(member_id));

create policy day_templates_all on public.day_templates
  for all to authenticated
  using (case when member_id is not null then app.can_access_member(member_id)
              else app.is_household_member(household_id) end)
  with check (case when member_id is not null then app.can_access_member(member_id)
                   else app.is_household_member(household_id) end);

create policy day_template_meals_all on public.day_template_meals
  for all to authenticated
  using (exists (select 1 from public.day_templates t where t.id = template_id
                 and (case when t.member_id is not null then app.can_access_member(t.member_id)
                           else app.is_household_member(t.household_id) end)))
  with check (exists (select 1 from public.day_templates t where t.id = template_id
                      and (case when t.member_id is not null then app.can_access_member(t.member_id)
                                else app.is_household_member(t.household_id) end)));

create policy daily_plans_all on public.member_daily_nutrition_plans
  for all to authenticated
  using (app.can_access_member(member_id)) with check (app.can_access_member(member_id));

create policy daily_plan_meals_all on public.member_daily_plan_meals
  for all to authenticated
  using (exists (select 1 from public.member_daily_nutrition_plans p
                 where p.id = plan_id and app.can_access_member(p.member_id)))
  with check (exists (select 1 from public.member_daily_nutrition_plans p
                      where p.id = plan_id and app.can_access_member(p.member_id)));

create policy profiles_select on public.member_nutrition_profiles
  for select to authenticated using (app.can_access_member(member_id));
create policy profiles_insert on public.member_nutrition_profiles
  for insert to authenticated with check (app.can_access_member(member_id));
create policy profiles_update on public.member_nutrition_profiles
  for update to authenticated
  using (app.can_access_member(member_id)) with check (app.can_access_member(member_id));

create policy servings_all on public.member_serving_projections
  for all to authenticated
  using (app.can_access_member(member_id)) with check (app.can_access_member(member_id));

create policy serving_components_all on public.member_serving_components
  for all to authenticated
  using (exists (select 1 from public.member_serving_projections p
                 where p.id = projection_id and app.can_access_member(p.member_id)))
  with check (exists (select 1 from public.member_serving_projections p
                      where p.id = projection_id and app.can_access_member(p.member_id)));

-- ---------------------------------------------------------------------------
-- Recálculo selectivo (§17, §45): al cambiar algo de UNA persona se marca el
-- perfil de ESA persona, nunca el de toda la familia.
-- ---------------------------------------------------------------------------

create or replace function public.publish_nutrition_profile(
  p_member_id       uuid,
  p_tracking_mode   public.tracking_mode,
  p_input_signature text,
  p_computed_inputs jsonb,
  p_daily_targets   jsonb,
  p_meal_targets    jsonb,
  p_preferences     jsonb,
  p_reason          text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_current public.member_nutrition_profiles;
  v_new uuid;
begin
  if not app.can_access_member(p_member_id) then
    raise exception 'no autorizado';
  end if;
  v_household := app.member_household(p_member_id);

  select * into v_current from public.member_nutrition_profiles
  where member_id = p_member_id and is_current;

  -- Mismas entradas => mismo perfil: no se versiona por versionar.
  if found and v_current.input_signature = p_input_signature then
    return v_current.id;
  end if;

  update public.member_nutrition_profiles
  set is_current = false
  where member_id = p_member_id and is_current;

  insert into public.member_nutrition_profiles
    (member_id, version, is_current, tracking_mode, computed_inputs, input_signature,
     daily_targets, meal_targets, preferences, reason)
  values (
    p_member_id,
    coalesce((select max(version) from public.member_nutrition_profiles where member_id = p_member_id), 0) + 1,
    true, p_tracking_mode, p_computed_inputs, p_input_signature,
    p_daily_targets, p_meal_targets, p_preferences, p_reason)
  returning id into v_new;

  -- Outbox (H, K-22): dedupe_key hace el reintento idempotente.
  insert into public.domain_events (household_id, event_type, aggregate, payload, scope, dedupe_key)
  values (
    v_household, 'NUTRITION_PROFILE_CHANGED', 'member_nutrition_profile',
    jsonb_build_object('member_id', p_member_id, 'profile_id', v_new),
    jsonb_build_object('member_id', p_member_id),
    'NUTRITION_PROFILE_CHANGED:' || v_new::text)
  on conflict (dedupe_key) do nothing;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
  values (v_household, auth.uid(), 'NUTRITION_PROFILE_CHANGED', 'member_nutrition_profile', v_new);

  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Guardar un borrador ahora transporta la ajustabilidad y los límites de ajuste
-- de cada componente (§28, §29). Reemplaza la versión creada en 0003.
-- ---------------------------------------------------------------------------

create or replace function public.replace_draft_content(p_version_id uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_slot_json jsonb;
  v_comp_json jsonb;
  v_alt_json jsonb;
  v_step_json jsonb;
  v_slot uuid;
  v_optional boolean;
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
      v_optional := coalesce((v_comp_json->>'is_optional')::boolean, false);
      insert into public.meal_slot_components (
        slot_id, ingredient_id, product_id, nested_version_id,
        quantity, unit, weight_basis, measure_id, measure_count,
        nutrition_fact_id, cooking_method, yield_factor, is_optional, sort_order, notes,
        adjustability, min_quantity, max_quantity
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
        v_optional,
        coalesce((v_comp_json->>'sort_order')::int, 1),
        nullif(v_comp_json->>'notes', ''),
        -- Un componente opcional siempre es OPTIONAL; el resto puede declararse
        -- FIXED (sal, especias, una salsa crítica) para que nadie lo ajuste.
        case when v_optional then 'OPTIONAL'::public.slot_adjustability
             else coalesce((nullif(v_comp_json->>'adjustability', ''))::public.slot_adjustability,
                           'ADJUSTABLE'::public.slot_adjustability) end,
        (v_comp_json->>'min_quantity')::numeric,
        (v_comp_json->>'max_quantity')::numeric
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
