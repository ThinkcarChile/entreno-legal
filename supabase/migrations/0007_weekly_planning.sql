-- Sprint 5 — Planificación semanal, eventos y porciones confirmadas.
--
-- Baseline: Sprint 0 §C-6 (weekly_plans + días + meal_assignments +
-- member_servings), §C-2 (nutrition_events), K-21 (versionado).
--
-- Nota de diseño: §C-6 define `member_servings` como tabla propia. El Sprint 4
-- ya creó `member_serving_projections` con exactamente esa forma (cantidades,
-- nutrición, razones, versiones de receta y perfil). En vez de duplicar una
-- tabla casi idéntica, esa misma gana el vínculo a la asignación y su estado:
-- una proyección atada a una asignación ES la porción confirmada. Ver ADR 0005.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.weekly_plan_status as enum
  ('DRAFT', 'VOTING', 'CONFIRMED', 'LOCKED', 'ARCHIVED');

-- Una comida planificada no siempre es una receta: a veces se come afuera, se
-- reaprovecha, hay un evento, o simplemente queda libre.
create type public.assignment_kind as enum
  ('RECIPE', 'EAT_OUT', 'LEFTOVER', 'EVENT', 'FREE');

create type public.assignment_status as enum ('PLANNED', 'CONFIRMED', 'SERVED', 'SKIPPED');

create type public.serving_status as enum ('PLANNED', 'SERVED', 'SKIPPED');

create type public.nutrition_event_type as enum
  ('BIRTHDAY', 'BARBECUE', 'TRAVEL', 'FREE_MEAL', 'HOLIDAY', 'ILLNESS', 'OTHER');

-- Margen razonable, nunca compensación extrema: un asado no "se paga" con un
-- día de ayuno.
create type public.event_strategy as enum ('AS_PLANNED', 'RELAXED', 'LIGHTER_AROUND', 'SKIP_TRACKING');

-- ---------------------------------------------------------------------------
-- La semana
-- ---------------------------------------------------------------------------

create table public.weekly_plans (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- Siempre lunes: la semana se identifica por su primer día.
  week_start   date not null,
  status       public.weekly_plan_status not null default 'DRAFT',
  locked_at    timestamptz,
  locked_by    uuid references public.household_members (id) on delete set null,
  created_by   uuid references public.household_members (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (household_id, week_start),
  constraint plan_locked_has_date check ((status = 'LOCKED') = (locked_at is not null))
);

create index weekly_plans_household_idx on public.weekly_plans (household_id, week_start desc);

create table public.weekly_plan_days (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid not null references public.weekly_plans (id) on delete cascade,
  plan_date        date not null,
  day_template_id  uuid references public.day_templates (id) on delete set null,
  notes            text,
  unique (plan_id, plan_date)
);

create table public.meal_assignments (
  id           uuid primary key default gen_random_uuid(),
  day_id       uuid not null references public.weekly_plan_days (id) on delete cascade,
  meal_type    public.meal_type not null,
  kind         public.assignment_kind not null default 'RECIPE',
  template_id  uuid references public.meal_templates (id) on delete set null,
  -- La VERSIÓN exacta con la que se planificó. Si la receta cambia después, esta
  -- comida sigue apuntando a lo que se decidió (K-21).
  version_id   uuid references public.meal_template_versions (id) on delete restrict,
  status       public.assignment_status not null default 'PLANNED',
  confirmed_at timestamptz,
  confirmed_by uuid references public.household_members (id) on delete set null,
  sort_order   int not null default 1,
  notes        text,
  created_at   timestamptz not null default now(),
  unique (day_id, meal_type),
  -- Una asignación de receta necesita receta; las demás clases no.
  constraint assignment_recipe_needs_version
    check ((kind = 'RECIPE') = (version_id is not null)),
  constraint assignment_confirmed_has_date
    check ((status in ('CONFIRMED', 'SERVED')) = (confirmed_at is not null))
);

create index assignments_day_idx on public.meal_assignments (day_id, sort_order);
create index assignments_version_idx on public.meal_assignments (version_id);

-- ---------------------------------------------------------------------------
-- Eventos: cumpleaños, asado, viaje, comida libre
-- ---------------------------------------------------------------------------

create table public.nutrition_events (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  event_date   date not null,
  end_date     date,
  event_type   public.nutrition_event_type not null default 'OTHER',
  meal_type    public.meal_type,
  strategy     public.event_strategy not null default 'RELAXED',
  title        text not null,
  notes        text,
  created_at   timestamptz not null default now(),
  constraint event_range_ordered check (end_date is null or end_date >= event_date)
);

create index events_household_idx on public.nutrition_events (household_id, event_date);

-- Un evento puede ser de toda la familia (sin filas acá) o de algunas personas.
create table public.nutrition_event_members (
  event_id  uuid not null references public.nutrition_events (id) on delete cascade,
  member_id uuid not null references public.household_members (id) on delete cascade,
  primary key (event_id, member_id)
);

-- ---------------------------------------------------------------------------
-- Porciones confirmadas: la proyección del Sprint 4 gana asignación y estado
-- ---------------------------------------------------------------------------

alter table public.member_serving_projections
  add column assignment_id uuid references public.meal_assignments (id) on delete cascade,
  add column status public.serving_status not null default 'PLANNED';

create index servings_assignment_idx on public.member_serving_projections (assignment_id);

-- Una sola porción por persona y asignación: confirmar dos veces reemplaza, no
-- duplica.
create unique index servings_assignment_member_uniq
  on public.member_serving_projections (assignment_id, member_id)
  where assignment_id is not null;

comment on column public.member_serving_projections.assignment_id is
  'NULL = proyección efímera de "ver porciones" (no se guarda). Con valor = '
  'porción confirmada dentro de una semana, con todas sus versiones de entrada.';

-- Los reemplazos aceptados dejan de vivir en la URL (§5 del preflight).
create table public.member_serving_substitutions (
  id                 uuid primary key default gen_random_uuid(),
  projection_id      uuid not null references public.member_serving_projections (id) on delete cascade,
  component_id       uuid references public.meal_slot_components (id) on delete set null,
  from_ingredient_id uuid references public.ingredients (id) on delete set null,
  to_ingredient_id   uuid not null references public.ingredients (id) on delete restrict,
  reason_code        text not null default 'SOFT_PREFERENCE',
  accepted_by        uuid references public.household_members (id) on delete set null,
  accepted_at        timestamptz not null default now()
);

create index serving_substitutions_idx
  on public.member_serving_substitutions (projection_id);

-- ---------------------------------------------------------------------------
-- Confirmar una comida: persiste porciones, componentes y sustituciones
-- ---------------------------------------------------------------------------

create or replace function public.confirm_meal_assignment(
  p_assignment_id uuid,
  p_servings      jsonb
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_member uuid;
  v_serving jsonb;
  v_component jsonb;
  v_sub jsonb;
  v_projection uuid;
  v_count int := 0;
begin
  select h.id into v_household
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  join public.households h on h.id = p.household_id
  where a.id = p_assignment_id;

  if v_household is null then raise exception 'asignación inexistente'; end if;
  if not app.is_household_member(v_household) then raise exception 'no autorizado'; end if;

  v_member := app.current_member_id(v_household);

  -- Confirmar de nuevo reemplaza lo anterior: una comida tiene una sola verdad.
  delete from public.member_serving_projections where assignment_id = p_assignment_id;

  for v_serving in select * from jsonb_array_elements(coalesce(p_servings, '[]'::jsonb)) loop
    insert into public.member_serving_projections (
      member_id, version_id, profile_id, daily_plan_id, optimizer_version,
      meal_type, serving_date, fit, adaptation_level, score,
      nutrition, completeness, reasons, unmet_constraints,
      assignment_id, status
    ) values (
      (v_serving->>'member_id')::uuid,
      (v_serving->>'version_id')::uuid,
      (v_serving->>'profile_id')::uuid,
      nullif(v_serving->>'daily_plan_id', '')::uuid,
      v_serving->>'optimizer_version',
      (v_serving->>'meal_type')::public.meal_type,
      nullif(v_serving->>'serving_date', '')::date,
      (v_serving->>'fit')::public.personal_meal_fit,
      (v_serving->>'adaptation_level')::int,
      (v_serving->>'score')::numeric,
      coalesce(v_serving->'nutrition', '{}'::jsonb),
      coalesce(v_serving->'completeness', '{}'::jsonb),
      coalesce(v_serving->'reasons', '[]'::jsonb),
      coalesce(v_serving->'unmet_constraints', '[]'::jsonb),
      p_assignment_id,
      'PLANNED'
    ) returning id into v_projection;

    for v_component in select * from jsonb_array_elements(coalesce(v_serving->'components', '[]'::jsonb)) loop
      insert into public.member_serving_components (
        projection_id, component_id, label, base_quantity, proposed_quantity,
        unit, weight_basis, cooking_method, added_fat_g, substituted_for, sort_order
      ) values (
        v_projection,
        nullif(v_component->>'component_id', '')::uuid,
        v_component->>'label',
        (v_component->>'base_quantity')::numeric,
        (v_component->>'proposed_quantity')::numeric,
        coalesce((v_component->>'unit')::public.nutrition_basis_unit, 'G'),
        coalesce((v_component->>'weight_basis')::public.weight_basis, 'RAW'),
        (nullif(v_component->>'cooking_method', ''))::public.cooking_method,
        (v_component->>'added_fat_g')::numeric,
        nullif(v_component->>'substituted_for', '')::uuid,
        coalesce((v_component->>'sort_order')::int, 1)
      );
    end loop;

    for v_sub in select * from jsonb_array_elements(coalesce(v_serving->'substitutions', '[]'::jsonb)) loop
      insert into public.member_serving_substitutions (
        projection_id, component_id, from_ingredient_id, to_ingredient_id, reason_code, accepted_by
      ) values (
        v_projection,
        nullif(v_sub->>'component_id', '')::uuid,
        nullif(v_sub->>'from_ingredient_id', '')::uuid,
        (v_sub->>'to_ingredient_id')::uuid,
        coalesce(v_sub->>'reason_code', 'SOFT_PREFERENCE'),
        v_member
      );
    end loop;

    v_count := v_count + 1;
  end loop;

  update public.meal_assignments
  set status = 'CONFIRMED', confirmed_at = now(), confirmed_by = v_member
  where id = p_assignment_id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
  values (v_household, auth.uid(), 'MEAL_CONFIRMED', 'meal_assignment', p_assignment_id);

  insert into public.domain_events (household_id, event_type, aggregate, payload, scope, dedupe_key)
  values (
    v_household, 'MEAL_CONFIRMED', 'meal_assignment',
    jsonb_build_object('assignment_id', p_assignment_id, 'servings', v_count),
    jsonb_build_object('assignment_id', p_assignment_id),
    'MEAL_CONFIRMED:' || p_assignment_id::text || ':' || v_count::text)
  on conflict (dedupe_key) do nothing;

  return v_count;
end;
$$;

/** Deshacer la confirmación: la comida vuelve a planificada y se borran sus porciones. */
create or replace function public.unconfirm_meal_assignment(p_assignment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_household uuid;
begin
  select p.household_id into v_household
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  where a.id = p_assignment_id;

  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  delete from public.member_serving_projections where assignment_id = p_assignment_id;
  update public.meal_assignments
  set status = 'PLANNED', confirmed_at = null, confirmed_by = null
  where id = p_assignment_id;
end;
$$;

/** Crea (o devuelve) la semana de un hogar con sus siete días. */
create or replace function public.ensure_weekly_plan(p_household_id uuid, p_week_start date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_plan uuid;
  v_dia int;
begin
  if not app.is_household_member(p_household_id) then raise exception 'no autorizado'; end if;

  select id into v_plan from public.weekly_plans
  where household_id = p_household_id and week_start = p_week_start;

  if v_plan is null then
    insert into public.weekly_plans (household_id, week_start, created_by)
    values (p_household_id, p_week_start, app.current_member_id(p_household_id))
    returning id into v_plan;
  end if;

  for v_dia in 0..6 loop
    insert into public.weekly_plan_days (plan_id, plan_date)
    values (v_plan, p_week_start + v_dia)
    on conflict (plan_id, plan_date) do nothing;
  end loop;

  return v_plan;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.weekly_plans                 enable row level security;
alter table public.weekly_plan_days             enable row level security;
alter table public.meal_assignments             enable row level security;
alter table public.nutrition_events             enable row level security;
alter table public.nutrition_event_members      enable row level security;
alter table public.member_serving_substitutions enable row level security;

create or replace function app.plan_household(p_plan uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.weekly_plans where id = p_plan;
$$;

create or replace function app.day_household(p_day uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.household_id from public.weekly_plan_days d
  join public.weekly_plans p on p.id = d.plan_id where d.id = p_day;
$$;

create or replace function app.assignment_household(p_assignment uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.household_id
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  where a.id = p_assignment;
$$;

create policy weekly_plans_all on public.weekly_plans
  for all to authenticated
  using (app.is_household_member(household_id))
  with check (app.is_household_member(household_id));

create policy plan_days_all on public.weekly_plan_days
  for all to authenticated
  using (app.is_household_member(app.plan_household(plan_id)))
  with check (app.is_household_member(app.plan_household(plan_id)));

create policy assignments_all on public.meal_assignments
  for all to authenticated
  using (app.is_household_member(app.day_household(day_id)))
  with check (app.is_household_member(app.day_household(day_id)));

create policy events_all on public.nutrition_events
  for all to authenticated
  using (app.is_household_member(household_id))
  with check (app.is_household_member(household_id));

create policy event_members_all on public.nutrition_event_members
  for all to authenticated
  using (exists (select 1 from public.nutrition_events e
                 where e.id = event_id and app.is_household_member(e.household_id)))
  with check (exists (select 1 from public.nutrition_events e
                      where e.id = event_id and app.is_household_member(e.household_id)));

create policy serving_substitutions_all on public.member_serving_substitutions
  for all to authenticated
  using (exists (select 1 from public.member_serving_projections p
                 where p.id = projection_id and app.can_access_member(p.member_id)))
  with check (exists (select 1 from public.member_serving_projections p
                      where p.id = projection_id and app.can_access_member(p.member_id)));
