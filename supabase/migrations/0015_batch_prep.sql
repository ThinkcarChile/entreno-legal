-- Sprint 10 — Batch prep, conservación y etiquetas.
--
-- Principio: el plan de preparación es una SUGERENCIA; el ledger del Sprint 7
-- sigue siendo la única fuente física. Generar un plan no toca lotes; solo
-- confirmar una tarea física ("ya porcioné", "ya congelé") registra la
-- transformación — reutilizando split_lot / move_lot / el libro mayor, jamás
-- un segundo inventario. La cantidad REAL que declara la persona manda sobre
-- la planificada (§18).
--
-- Seguridad alimentaria: NUNCA inventada. FoodStorageSafetyEngine (TS,
-- determinista, versionado) solo lee `storage_safety_rules` validadas con
-- fuente explícita; sin regla → SAFETY_REVIEW_REQUIRED. UNKNOWN ≠ SAFE.

-- ---------------------------------------------------------------------------
-- Ledger: extensiones aditivas
-- ---------------------------------------------------------------------------

-- Merma de preparación (pelar/despuntar/cortar). La causa fina va en notes
-- ('PEEL' | 'TRIM' | 'PREP_LOSS').
alter type public.movement_reason add value if not exists 'PREP_LOSS';

alter table public.inventory_lots
  -- §24: historia térmica. thawed_at ya existía (K-18); frozen_at lo completa.
  add column frozen_at timestamptz,
  -- §26/§27: "usar el jueves" es PLANIFICACIÓN, no vencimiento (use_by sigue
  -- siendo la fecha de seguridad). Cambiar intended jamás toca use_by.
  add column intended_use_date date,
  add column intended_assignment_id uuid references public.meal_assignments (id) on delete set null,
  -- §41: identidad visible del paquete físico (el UUID sigue siendo la PK).
  add column package_code text,
  -- §35-37: identificador OPACO para el QR. Jamás secuencial, jamás revela hogar.
  add column qr_token text;

create unique index inventory_lots_qr_token_uniq
  on public.inventory_lots (qr_token) where qr_token is not null;

-- ---------------------------------------------------------------------------
-- Equipamiento del hogar (§10-§12): datos del hogar, jamás una enum global
-- ---------------------------------------------------------------------------

create table public.household_equipment (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 120),
  notes        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint household_equipment_name_uniq unique (household_id, name)
);

-- Una capability por CONFIGURACIÓN del equipo del hogar: la cortadora declara
-- sus cuchillas como FILAS con params (DICE {size_mm: 9}, SHRED {size_mm: 4}…).
-- Distinto del catálogo global `equipment_capabilities` (códigos para recetas,
-- Sprint 2): acá el código es libre — jamás una enum cerrada de máquinas (§10).
create table public.household_equipment_configs (
  id                 uuid primary key default gen_random_uuid(),
  equipment_id       uuid not null references public.household_equipment (id) on delete cascade,
  capability         text not null check (char_length(capability) between 1 and 60),
  params             jsonb not null default '{}'::jsonb,
  -- §53: capacidad por tanda, opcional (air fryer 800 g → 2 tandas para 1,5 kg).
  max_batch_quantity numeric(12, 3) check (max_batch_quantity > 0),
  max_batch_unit     text check (max_batch_unit in ('G', 'ML', 'UNIT')),
  is_active          boolean not null default true,
  created_at         timestamptz not null default now()
);
create index household_equipment_configs_equipment_idx on public.household_equipment_configs (equipment_id);

-- Preferencia de preparación declarada por el hogar ("zanahoria: rallado 4 mm"):
-- el motor JAMÁS inventa cortes — solo aplica lo que el hogar configuró.
create table public.prep_preferences (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  task_type     text not null check (task_type in
    ('WASH','PEEL','TRIM','CUT','SHRED','SLICE','DICE','PORTION','PACK','VACUUM_SEAL','OTHER')),
  params        jsonb not null default '{}'::jsonb,
  capability_id uuid references public.household_equipment_configs (id) on delete set null,
  -- §12: la alternativa manual SIEMPRE existe.
  manual_alternative text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint prep_preferences_uniq unique (household_id, ingredient_id, task_type)
);

alter table public.household_equipment    enable row level security;
alter table public.household_equipment_configs enable row level security;
alter table public.prep_preferences       enable row level security;

create policy household_equipment_all on public.household_equipment
  for all to authenticated
  using (app.is_household_member(household_id))
  with check (app.is_household_member(household_id));

create policy household_equipment_configs_all on public.household_equipment_configs
  for all to authenticated
  using (exists (select 1 from public.household_equipment e
                 where e.id = equipment_id and app.is_household_member(e.household_id)))
  with check (exists (select 1 from public.household_equipment e
                      where e.id = equipment_id and app.is_household_member(e.household_id)));

create policy prep_preferences_all on public.prep_preferences
  for all to authenticated
  using (app.is_household_member(household_id))
  with check (app.is_household_member(household_id));

create or replace function app.validate_prep_preference_scope()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not app.ingredient_in_scope(new.ingredient_id, new.household_id) then
    raise exception 'el alimento no pertenece a este hogar';
  end if;
  if new.capability_id is not null and not exists (
    select 1 from public.household_equipment_configs c
    join public.household_equipment e on e.id = c.equipment_id
    where c.id = new.capability_id and e.household_id = new.household_id
  ) then
    raise exception 'el equipamiento no pertenece a este hogar';
  end if;
  return new;
end;
$$;
create trigger prep_preferences_scope
  before insert or update on public.prep_preferences
  for each row execute function app.validate_prep_preference_scope();

-- ---------------------------------------------------------------------------
-- Reglas de conservación validadas (§20-§25): la ÚNICA fuente de seguridad
-- ---------------------------------------------------------------------------

create table public.storage_safety_rules (
  id                uuid primary key default gen_random_uuid(),
  -- NULL = regla global validada; con hogar = regla propia del hogar.
  household_id      uuid references public.households (id) on delete cascade,
  -- Ámbito del alimento: específico > categoría > genérico. Máximo uno.
  ingredient_id     uuid references public.ingredients (id) on delete cascade,
  category_id       uuid references public.ingredient_categories (id) on delete cascade,
  constraint storage_safety_scope check (ingredient_id is null or category_id is null),
  -- Condiciones (NULL = aplica a cualquiera).
  processing_state  public.processing_state,
  temperature_state public.temperature_state,
  vacuum_sealed     boolean,
  rule_kind         text not null check (rule_kind in ('STORAGE_DAYS', 'REFREEZE', 'THAW')),
  -- STORAGE_DAYS: máximo de días seguros desde el almacenamiento.
  -- NULL = seguro sin fecha (p. ej. congelado según USDA) — DISTINTO de "sin regla".
  max_days          int check (max_days > 0),
  use_soon_within_days int not null default 1 check (use_soon_within_days >= 0),
  -- REFREEZE: si se puede recongelar bajo las condiciones de la regla.
  refreeze_allowed  boolean,
  -- THAW: horas de descongelado en refrigerador (para programar el traslado).
  thaw_fridge_hours int check (thaw_fridge_hours > 0),
  -- La FUENTE es obligatoria: sin fuente validada no hay regla (§20).
  source            text not null check (char_length(source) between 3 and 300),
  is_active         boolean not null default true,
  created_by        uuid references public.household_members (id) on delete set null,
  created_at        timestamptz not null default now()
);

alter table public.storage_safety_rules enable row level security;
create policy storage_safety_rules_select on public.storage_safety_rules
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));
create policy storage_safety_rules_write on public.storage_safety_rules
  for insert to authenticated
  with check (household_id is not null and app.is_household_member(household_id));
create policy storage_safety_rules_update on public.storage_safety_rules
  for update to authenticated
  using (household_id is not null and app.is_household_member(household_id))
  with check (household_id is not null and app.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Rendimientos OBSERVADOS del hogar (§45-§46): observación, jamás sobrescritura
-- ---------------------------------------------------------------------------

create table public.household_observed_yields (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households (id) on delete cascade,
  ingredient_id   uuid not null references public.ingredients (id) on delete cascade,
  cooking_method  text,
  input_quantity  numeric(12, 3) not null check (input_quantity > 0),
  output_quantity numeric(12, 3) not null check (output_quantity >= 0),
  unit            text not null check (unit in ('G', 'ML', 'UNIT')),
  -- El factor se deriva, no se digita: una fuente por dato.
  observed_factor numeric(8, 4) generated always as
    (round(output_quantity / input_quantity, 4)) stored,
  lot_id          uuid references public.inventory_lots (id) on delete set null,
  task_id         uuid,
  notes           text,
  created_by      uuid references public.household_members (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index household_observed_yields_idx on public.household_observed_yields (household_id, ingredient_id);

alter table public.household_observed_yields enable row level security;
create policy household_observed_yields_select on public.household_observed_yields
  for select to authenticated using (app.is_household_member(household_id));
create policy household_observed_yields_insert on public.household_observed_yields
  for insert to authenticated with check (app.is_household_member(household_id));
-- Sin update/delete: una observación es historia (K-11 en espíritu).

create or replace function app.stamp_observed_yield()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not app.ingredient_in_scope(new.ingredient_id, new.household_id) then
    raise exception 'el alimento no pertenece a este hogar';
  end if;
  -- §62: el actor lo estampa la base, jamás el cliente.
  new.created_by := app.current_member_id(new.household_id);
  return new;
end;
$$;
create trigger observed_yields_stamp
  before insert on public.household_observed_yields
  for each row execute function app.stamp_observed_yield();

-- ---------------------------------------------------------------------------
-- Outbox (§30, §61): se REUTILIZA `domain_events` del Sprint 1 (jamás un
-- segundo outbox). AT-LEAST-ONCE: dedupe_key único absorbe reemisiones de
-- efectos una-sola-vez; las ocurrencias repetibles (congelar, descongelar,
-- volver a congelar) llevan sufijo aleatorio porque SON eventos distintos.
-- ---------------------------------------------------------------------------

create or replace function app.emit_event(
  p_household uuid,
  p_type      text,
  p_aggregate text,
  p_payload   jsonb,
  p_dedupe    text default null
) returns void language sql security definer set search_path = public as $$
  insert into public.domain_events (household_id, event_type, aggregate, payload, dedupe_key)
  values (p_household, p_type, p_aggregate, coalesce(p_payload, '{}'::jsonb),
          coalesce(p_dedupe, p_type || ':' || gen_random_uuid()::text))
  on conflict (dedupe_key) do nothing;
$$;

-- ---------------------------------------------------------------------------
-- Plan de preparación (§6-§7): estructura, no texto
-- ---------------------------------------------------------------------------

create type public.prep_plan_status as enum
  ('DRAFT', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

create table public.batch_prep_plans (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references public.households (id) on delete cascade,
  plan_date            date not null,
  status               public.prep_plan_status not null default 'DRAFT',
  shopping_list_id     uuid references public.shopping_lists (id) on delete set null,
  procurement_order_id uuid references public.procurement_orders (id) on delete set null,
  weekly_plan_id       uuid references public.weekly_plans (id) on delete set null,
  engine_version       text,
  -- §55: métrica simple (tareas + cambios de herramienta + cortes + paquetes).
  complexity           int,
  summary              jsonb not null default '{}'::jsonb,
  dedupe_key           text,
  created_by           uuid references public.household_members (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index batch_prep_plans_dedupe_uniq
  on public.batch_prep_plans (dedupe_key)
  where dedupe_key is not null and status <> 'CANCELLED';
create index batch_prep_plans_household_idx on public.batch_prep_plans (household_id, plan_date desc);

create table public.batch_prep_tasks (
  id                 uuid primary key default gen_random_uuid(),
  plan_id            uuid not null references public.batch_prep_plans (id) on delete cascade,
  seq                int not null,
  -- Bloque humano: Lavar / Cortar / Porcionar / Guardar / Etiquetar (§15).
  block_label        text,
  task_type          text not null check (task_type in
    ('WASH','PEEL','TRIM','CUT','SHRED','SLICE','DICE','PORTION','PACK','VACUUM_SEAL',
     'REFRIGERATE','FREEZE','THAW_LATER','LEAVE_WHOLE','LABEL','OTHER')),
  lot_id             uuid references public.inventory_lots (id) on delete set null,
  ingredient_id      uuid references public.ingredients (id) on delete set null,
  label              text not null,
  planned_quantity   numeric(12, 3) check (planned_quantity > 0),
  unit               text check (unit in ('G', 'ML', 'UNIT')),
  -- Corte/equipo/paquetes sugeridos/razones/veredicto de seguridad snapshot.
  params             jsonb not null default '{}'::jsonb,
  depends_on         uuid references public.batch_prep_tasks (id) on delete set null,
  status             text not null default 'PENDING'
                     check (status in ('PENDING','DONE','SKIPPED','CANCELLED')),
  completed_quantity numeric(12, 3) check (completed_quantity >= 0),
  completed_by       uuid references public.household_members (id) on delete set null,
  completed_at       timestamptz,
  result             jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  constraint batch_prep_tasks_seq_uniq unique (plan_id, seq)
);
create index batch_prep_tasks_plan_idx on public.batch_prep_tasks (plan_id, seq);

alter table public.batch_prep_plans enable row level security;
alter table public.batch_prep_tasks enable row level security;

create or replace function app.prep_plan_household(p_plan uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.batch_prep_plans where id = p_plan;
$$;

create policy batch_prep_plans_select on public.batch_prep_plans
  for select to authenticated using (app.is_household_member(household_id));
create policy batch_prep_tasks_select on public.batch_prep_tasks
  for select to authenticated
  using (app.is_household_member(app.prep_plan_household(plan_id)));
-- Escritura solo vía RPC: crear el plan es atómico y completar tareas es la
-- ÚNICA puerta hacia el ledger.

-- ---------------------------------------------------------------------------
-- Etiquetas (§31-§40)
-- ---------------------------------------------------------------------------

create table public.label_templates (
  id           uuid primary key default gen_random_uuid(),
  -- NULL = plantilla global por defecto.
  household_id uuid references public.households (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  width_mm     numeric(6, 2) not null check (width_mm between 20 and 200),
  height_mm    numeric(6, 2) check (height_mm between 20 and 300),
  margin_mm    numeric(5, 2) not null default 2 check (margin_mm >= 0),
  -- Qué campos mostrar y en qué densidad (§33): configurable, no obligatorio.
  layout       jsonb not null default '{}'::jsonb,
  version      int not null default 1 check (version >= 1),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

alter table public.label_templates enable row level security;
create policy label_templates_select on public.label_templates
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));
create policy label_templates_write on public.label_templates
  for insert to authenticated
  with check (household_id is not null and app.is_household_member(household_id));
create policy label_templates_update on public.label_templates
  for update to authenticated
  using (household_id is not null and app.is_household_member(household_id))
  with check (household_id is not null and app.is_household_member(household_id));

-- Plantilla global por defecto: térmica monocroma 40 mm continua.
insert into public.label_templates (household_id, name, width_mm, height_mm, margin_mm, layout, version)
values (null, 'Térmica 40 mm', 40, 60, 2,
        '{"fields": ["use_day", "name", "quantity", "state", "prepared_at", "intended", "safe_use_by", "qr", "package_code"]}'::jsonb,
        1);

create table public.label_print_jobs (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references public.households (id) on delete cascade,
  lot_id           uuid not null references public.inventory_lots (id) on delete cascade,
  template_id      uuid references public.label_templates (id) on delete set null,
  template_version int not null default 1,
  -- §40: snapshot COMPLETO de lo impreso. La etiqueta histórica no cambia
  -- aunque mañana cambie el alimento, la ubicación o la receta.
  snapshot         jsonb not null,
  status           text not null default 'GENERATED'
                   check (status in ('PENDING','GENERATED','PRINTED','FAILED','CANCELLED')),
  generated_by     uuid references public.household_members (id) on delete set null,
  generated_at     timestamptz not null default now(),
  printed_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index label_print_jobs_lot_idx on public.label_print_jobs (lot_id, created_at desc);

alter table public.label_print_jobs enable row level security;
create policy label_print_jobs_select on public.label_print_jobs
  for select to authenticated using (app.is_household_member(household_id));
-- Escritura vía RPC (el snapshot se arma en la base, con datos reales).

-- ---------------------------------------------------------------------------
-- split_lot v2 y move_lot v2: historia térmica completa (frozen_at)
-- ---------------------------------------------------------------------------

create or replace function public.split_lot(
  p_lot_id     uuid,
  p_quantities numeric[]
) returns uuid[] language plpgsql security definer set search_path = public as $$
declare
  v_lot public.inventory_lots;
  v_member uuid;
  v_group uuid := gen_random_uuid();
  v_total numeric := 0;
  v_q numeric;
  v_hijo uuid;
  v_hijos uuid[] := '{}';
  v_valor_hijo numeric;
  v_valor_repartido numeric := 0;
  v_i int := 0;
  v_n int;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_lot.status <> 'AVAILABLE' then
    raise exception 'solo se parte un lote disponible (este está %)', v_lot.status;
  end if;

  v_n := coalesce(array_length(p_quantities, 1), 0);
  if v_n = 0 then raise exception 'partir requiere al menos una parte'; end if;

  foreach v_q in array p_quantities loop
    perform app.assert_finite(v_q, 'una parte');
    if v_q is null or v_q <= 0 then raise exception 'cada parte debe ser mayor que cero'; end if;
    v_total := v_total + v_q;
  end loop;
  if v_total > v_lot.quantity then
    raise exception 'las partes suman % pero el lote tiene %: partir no crea comida',
      v_total, v_lot.quantity;
  end if;

  v_member := app.current_member_id(v_lot.household_id);

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, group_id, actor_member_id)
  values (v_lot.household_id, p_lot_id, 'SPLIT', -v_total, v_group, v_member);

  foreach v_q in array p_quantities loop
    v_i := v_i + 1;

    -- K-19: se conserva el VALOR TOTAL. Cada hijo se lleva su proporción de la
    -- cantidad vigente; el último se lleva el residuo del redondeo para que la
    -- suma cierre exacta, y el padre queda DEBITADO por lo repartido.
    if v_lot.acquisition_value is null or v_lot.quantity = 0 then
      v_valor_hijo := null;
    elsif v_i = v_n and v_total = v_lot.quantity then
      v_valor_hijo := v_lot.acquisition_value - v_valor_repartido;
    else
      v_valor_hijo := round(v_lot.acquisition_value * v_q / v_lot.quantity, 4);
    end if;
    v_valor_repartido := v_valor_repartido + coalesce(v_valor_hijo, 0);

    insert into public.inventory_lots (
      household_id, ingredient_id, product_id, label, quantity, unit, weight_basis,
      processing_state, temperature_state, thawed_at, frozen_at, vacuum_sealed,
      location_id, expiry_date, use_by, parent_lot_id,
      acquisition_value, created_by
    ) values (
      v_lot.household_id, v_lot.ingredient_id, v_lot.product_id, v_lot.label,
      0, v_lot.unit, v_lot.weight_basis,
      v_lot.processing_state, v_lot.temperature_state, v_lot.thawed_at, v_lot.frozen_at,
      v_lot.vacuum_sealed,
      v_lot.location_id, v_lot.expiry_date, v_lot.use_by, p_lot_id,
      v_valor_hijo,
      v_member
    ) returning id into v_hijo;

    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, group_id, actor_member_id)
    values (v_lot.household_id, v_hijo, 'SPLIT', v_q, v_group, v_member);

    v_hijos := v_hijos || v_hijo;
  end loop;

  if v_lot.acquisition_value is not null then
    update public.inventory_lots
    set acquisition_value = greatest(acquisition_value - v_valor_repartido, 0)
    where id = p_lot_id;
  end if;

  return v_hijos;
end;
$$;

create or replace function public.move_lot(
  p_lot_id      uuid,
  p_location_id uuid
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_lot public.inventory_lots;
  v_kind public.storage_kind;
  v_entra_frozen boolean;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_lot.status in ('CONSUMED', 'DISCARDED', 'SPLIT') then
    raise exception 'el lote "%" ya está cerrado (%): la historia no se mueve de lugar',
      v_lot.label, v_lot.status;
  end if;

  select kind into v_kind from public.storage_locations
  where id = p_location_id and household_id = v_lot.household_id;
  if v_kind is null then raise exception 'la ubicación no pertenece a este hogar'; end if;

  v_entra_frozen := (v_kind = 'FREEZER' and v_lot.temperature_state <> 'FROZEN');

  update public.inventory_lots
  set location_id = p_location_id,
      -- K-18: THAW es evidencia, no prohibición. Congelador → FROZEN;
      -- salir del congelador → CHILLED + thawed_at sellado.
      temperature_state = case
        when v_kind = 'FREEZER' then 'FROZEN'::public.temperature_state
        when v_lot.temperature_state = 'FROZEN' then 'CHILLED'::public.temperature_state
        when v_kind = 'FRIDGE' then 'CHILLED'::public.temperature_state
        else 'AMBIENT'::public.temperature_state
      end,
      thawed_at = case
        when v_lot.temperature_state = 'FROZEN' and v_kind <> 'FREEZER' then now()
        else v_lot.thawed_at
      end,
      -- §24: historia térmica completa — cuándo entró al congelador.
      frozen_at = case when v_entra_frozen then now() else v_lot.frozen_at end,
      updated_at = now()
  where id = p_lot_id;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, actor_member_id, notes)
  values
    (v_lot.household_id, p_lot_id,
     case when v_lot.temperature_state = 'FROZEN' and v_kind <> 'FREEZER' then 'THAW'
          else 'MOVE' end::public.movement_reason,
     0, app.current_member_id(v_lot.household_id), null);

  if v_entra_frozen then
    perform app.emit_event(v_lot.household_id, 'LOT_FROZEN', 'inventory_lot',
      jsonb_build_object('lot_id', p_lot_id));
  elsif v_lot.temperature_state = 'FROZEN' and v_kind <> 'FREEZER' then
    perform app.emit_event(v_lot.household_id, 'LOT_THAWED', 'inventory_lot',
      jsonb_build_object('lot_id', p_lot_id));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- MERGE validado (§43): solo lotes física y semánticamente compatibles
-- ---------------------------------------------------------------------------

create or replace function public.merge_lots(
  p_lot_ids uuid[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
  v_primero public.inventory_lots;
  v_lot public.inventory_lots;
  v_id uuid;
  v_group uuid := gen_random_uuid();
  v_member uuid;
  v_total numeric := 0;
  v_valor numeric := 0;
  v_hay_valor boolean := false;
  v_nuevo uuid;
begin
  if coalesce(array_length(p_lot_ids, 1), 0) < 2 then
    raise exception 'unir requiere al menos dos lotes';
  end if;
  -- Orden estable para evitar deadlocks entre dos merges simultáneos.
  select array_agg(x order by x) into v_ids from unnest(p_lot_ids) as x;

  foreach v_id in array v_ids loop
    select * into v_lot from public.inventory_lots where id = v_id for update;
    if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
      raise exception 'no autorizado';
    end if;
    if v_lot.status <> 'AVAILABLE' or v_lot.quantity <= 0 then
      raise exception 'solo se unen lotes disponibles con cantidad';
    end if;
    if v_primero.id is null then
      v_primero := v_lot;
    else
      -- §43: jamás RAW+COOKED, FROZEN+CHILLED, alimentos o bases distintas.
      if v_lot.household_id <> v_primero.household_id
         or v_lot.ingredient_id is distinct from v_primero.ingredient_id
         or v_lot.unit <> v_primero.unit
         or v_lot.weight_basis <> v_primero.weight_basis
         or v_lot.processing_state <> v_primero.processing_state
         or v_lot.temperature_state <> v_primero.temperature_state then
        raise exception 'esos lotes no se pueden unir: estado, alimento o base incompatibles';
      end if;
    end if;
    v_total := v_total + v_lot.quantity;
    if v_lot.acquisition_value is null then
      -- K-19: si UNA parte tiene valor desconocido, el total es desconocido.
      -- Sumar solo lo conocido falsificaría el valor por gramo del lote nuevo.
      v_hay_valor := false;
      v_valor := null;
    elsif v_valor is not null then
      v_valor := v_valor + v_lot.acquisition_value;
      v_hay_valor := true;
    end if;
  end loop;

  v_member := app.current_member_id(v_primero.household_id);

  insert into public.inventory_lots (
    household_id, ingredient_id, product_id, label, quantity, unit, weight_basis,
    processing_state, temperature_state, thawed_at, frozen_at, vacuum_sealed,
    location_id, expiry_date, use_by,
    acquisition_value, created_by
  ) values (
    v_primero.household_id, v_primero.ingredient_id, v_primero.product_id, v_primero.label,
    0, v_primero.unit, v_primero.weight_basis,
    v_primero.processing_state, v_primero.temperature_state,
    v_primero.thawed_at, v_primero.frozen_at, v_primero.vacuum_sealed,
    v_primero.location_id,
    -- Conservador: el nuevo lote hereda la fecha MÁS RESTRICTIVA.
    (select min(l.expiry_date) from public.inventory_lots l where l.id = any(v_ids)),
    (select min(l.use_by) from public.inventory_lots l where l.id = any(v_ids)),
    case when v_hay_valor and v_valor is not null then v_valor else null end, v_member
  ) returning id into v_nuevo;

  foreach v_id in array v_ids loop
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, group_id, actor_member_id)
    select v_primero.household_id, v_id, 'MERGE', -l.quantity, v_group, v_member
    from public.inventory_lots l where l.id = v_id;
  end loop;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, group_id, actor_member_id)
  values (v_primero.household_id, v_nuevo, 'MERGE', v_total, v_group, v_member);

  return v_nuevo;
end;
$$;

-- ---------------------------------------------------------------------------
-- Crear plan de prep (atómico, idempotente; el ledger NO se toca — §17)
-- ---------------------------------------------------------------------------

create or replace function public.save_prep_plan(
  p_household_id uuid,
  p_plan_date    date,
  p_engine_version text,
  p_complexity   int,
  p_summary      jsonb,
  p_dedupe_key   text,
  p_tasks        jsonb,
  p_shopping_list_id uuid default null,
  p_procurement_order_id uuid default null,
  p_weekly_plan_id uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_plan uuid;
  v_member uuid;
  v_task jsonb;
  v_seq int := 0;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_dep int;
  v_lot uuid;
begin
  if not app.is_household_member(p_household_id) then raise exception 'no autorizado'; end if;
  if p_tasks is null or jsonb_array_length(p_tasks) = 0 then
    raise exception 'un plan necesita al menos una tarea';
  end if;
  if p_dedupe_key is not null then
    select id into v_plan from public.batch_prep_plans
    where dedupe_key = p_dedupe_key and household_id = p_household_id
      and status <> 'CANCELLED';
    if v_plan is not null then return v_plan; end if;
  end if;
  -- Fuentes del MISMO hogar (inyección de UUID).
  if p_shopping_list_id is not null and not exists (
    select 1 from public.shopping_lists where id = p_shopping_list_id and household_id = p_household_id
  ) then raise exception 'no autorizado'; end if;
  if p_procurement_order_id is not null and not exists (
    select 1 from public.procurement_orders where id = p_procurement_order_id and household_id = p_household_id
  ) then raise exception 'no autorizado'; end if;
  if p_weekly_plan_id is not null and not exists (
    select 1 from public.weekly_plans where id = p_weekly_plan_id and household_id = p_household_id
  ) then raise exception 'no autorizado'; end if;

  v_member := app.current_member_id(p_household_id);

  begin
    insert into public.batch_prep_plans
      (household_id, plan_date, status, engine_version, complexity, summary, dedupe_key,
       shopping_list_id, procurement_order_id, weekly_plan_id, created_by)
    values
      (p_household_id, p_plan_date, 'READY', p_engine_version, p_complexity,
       coalesce(p_summary, '{}'::jsonb), p_dedupe_key,
       p_shopping_list_id, p_procurement_order_id, p_weekly_plan_id, v_member)
    returning id into v_plan;
  exception when unique_violation then
    select id into v_plan from public.batch_prep_plans
    where dedupe_key = p_dedupe_key and household_id = p_household_id
      and status <> 'CANCELLED';
    if v_plan is not null then return v_plan; end if;
    raise exception 'no autorizado';
  end;

  -- §83: la sugerencia nueva reemplaza a las sugerencias VIEJAS del mismo día
  -- que nadie empezó (READY/DRAFT → CANCELLED, tareas pendientes incluidas).
  -- Un plan IN_PROGRESS sigue vivo: hay alguien cocinando con él.
  update public.batch_prep_tasks t
  set status = 'CANCELLED'
  from public.batch_prep_plans p
  where t.plan_id = p.id and p.household_id = p_household_id
    and p.plan_date = p_plan_date and p.id <> v_plan
    and p.status in ('READY', 'DRAFT') and t.status = 'PENDING';
  update public.batch_prep_plans p
  set status = 'CANCELLED', updated_at = now()
  where p.household_id = p_household_id and p.plan_date = p_plan_date
    and p.id <> v_plan and p.status in ('READY', 'DRAFT');

  for v_task in select * from jsonb_array_elements(p_tasks) loop
    v_seq := v_seq + 1;
    v_lot := nullif(v_task->>'lot_id', '')::uuid;
    if v_lot is not null and not exists (
      select 1 from public.inventory_lots where id = v_lot and household_id = p_household_id
    ) then raise exception 'no autorizado'; end if;
    if v_task->>'ingredient_id' is not null
       and not app.ingredient_in_scope((v_task->>'ingredient_id')::uuid, p_household_id) then
      raise exception 'el alimento no pertenece a este hogar';
    end if;

    insert into public.batch_prep_tasks
      (plan_id, seq, block_label, task_type, lot_id, ingredient_id, label,
       planned_quantity, unit, params, depends_on)
    values
      (v_plan, v_seq,
       nullif(v_task->>'block_label', ''),
       v_task->>'task_type',
       v_lot,
       nullif(v_task->>'ingredient_id', '')::uuid,
       v_task->>'label',
       nullif(v_task->>'planned_quantity', '')::numeric,
       nullif(v_task->>'unit', ''),
       coalesce(v_task->'params', '{}'::jsonb),
       -- depends_on llega como ÍNDICE (1-based) dentro del mismo plan.
       null)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;

  -- Segunda pasada: resolver dependencias por índice.
  v_seq := 0;
  for v_task in select * from jsonb_array_elements(p_tasks) loop
    v_seq := v_seq + 1;
    v_dep := nullif(v_task->>'depends_on_index', '')::int;
    if v_dep is not null then
      if v_dep < 1 or v_dep > array_length(v_ids, 1) or v_dep = v_seq then
        raise exception 'dependencia inválida en la tarea %', v_seq;
      end if;
      update public.batch_prep_tasks set depends_on = v_ids[v_dep] where id = v_ids[v_seq];
    end if;
  end loop;

  return v_plan;
end;
$$;

/** Cancelar plan: las tareas PENDIENTES se cancelan; lo YA ejecutado no se
    revierte mágicamente (§81) — el ledger es historia. */
create or replace function public.cancel_prep_plan(p_plan_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_household uuid;
begin
  select household_id into v_household from public.batch_prep_plans
  where id = p_plan_id for update;
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;
  if (select status from public.batch_prep_plans where id = p_plan_id) = 'COMPLETED' then
    raise exception 'un plan completado es historia: no se cancela retroactivamente';
  end if;
  update public.batch_prep_tasks set status = 'CANCELLED'
  where plan_id = p_plan_id and status = 'PENDING';
  update public.batch_prep_plans
  set status = 'CANCELLED', updated_at = now() where id = p_plan_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Completar tarea física (§17-§18, §60): la ÚNICA puerta del prep al ledger
-- ---------------------------------------------------------------------------

/**
 * Confirma que una tarea se hizo DE VERDAD y registra la transformación que
 * corresponde por tipo, con la cantidad REAL declarada (jamás la planificada
 * a la fuerza). Idempotente y a prueba de carrera: la tarea se bloquea
 * (for update) y solo transita PENDING→DONE una vez — el segundo clic de
 * otra persona recibe el resultado ya registrado, sin doble split (§60, §82).
 *
 * p_outputs por tipo:
 *  - transformación (PEEL/TRIM/CUT/SHRED/SLICE/DICE):
 *      {"output_quantity": n, "waste_quantity": n, "waste_cause": "PEEL|TRIM|PREP_LOSS"}
 *  - PORTION/PACK:
 *      {"packages": [{"quantity": n, "location_id": uuid?, "vacuum": bool?,
 *                     "intended_use_date": date?, "intended_assignment_id": uuid?}]}
 *  - REFRIGERATE/FREEZE: {"location_id": uuid?}  (default: primera FRIDGE/FREEZER)
 */
create or replace function public.complete_prep_task(
  p_task_id         uuid,
  p_actual_quantity numeric default null,
  p_outputs         jsonb default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_task public.batch_prep_tasks;
  v_household uuid;
  v_member uuid;
  v_lot public.inventory_lots;
  v_dep_status text;
  v_input numeric;
  v_output numeric;
  v_waste numeric;
  v_cause text;
  v_target uuid;
  v_pkg jsonb;
  v_cantidades numeric[] := '{}';
  v_hijos uuid[];
  v_hijo uuid;
  v_i int := 0;
  v_result jsonb;
  v_codes text[] := '{}';
  v_code text;
  v_loc uuid;
  v_kind public.storage_kind;
begin
  select t.* into v_task from public.batch_prep_tasks t where t.id = p_task_id for update;
  if v_task.id is null then raise exception 'no autorizado'; end if;
  v_household := app.prep_plan_household(v_task.plan_id);
  if not app.is_household_member(v_household) then raise exception 'no autorizado'; end if;

  -- Idempotencia: la segunda confirmación devuelve lo YA registrado.
  if v_task.status = 'DONE' then return v_task.result; end if;
  if v_task.status in ('SKIPPED', 'CANCELLED') then
    raise exception 'esta tarea está % — reábrela desde el plan si corresponde', v_task.status;
  end if;

  -- §14: no congelar un paquete que aún no existe.
  if v_task.depends_on is not null then
    select status into v_dep_status from public.batch_prep_tasks where id = v_task.depends_on;
    if v_dep_status is distinct from 'DONE' and v_dep_status is distinct from 'SKIPPED' then
      raise exception 'primero completa el paso del que depende esta tarea';
    end if;
  end if;

  v_member := app.current_member_id(v_household);
  v_result := jsonb_build_object();

  if v_task.lot_id is not null then
    select * into v_lot from public.inventory_lots where id = v_task.lot_id for update;
    if v_lot.household_id is distinct from v_household then raise exception 'no autorizado'; end if;
  end if;

  if v_task.task_type in ('PEEL','TRIM','CUT','SHRED','SLICE','DICE') then
    if v_lot.id is null then raise exception 'esta tarea necesita un lote de origen'; end if;
    -- §18: la cantidad REAL manda. Sin dato, se asume lo planificado.
    v_input := coalesce(p_actual_quantity, v_task.planned_quantity, v_lot.quantity);
    perform app.assert_finite(v_input, 'la cantidad preparada');
    if v_input <= 0 or v_input > v_lot.quantity then
      raise exception 'la cantidad preparada (%) no calza con el lote (%)', v_input, v_lot.quantity;
    end if;
    v_output := coalesce(nullif(p_outputs->>'output_quantity', '')::numeric, v_input);
    v_waste := coalesce(nullif(p_outputs->>'waste_quantity', '')::numeric, v_input - v_output);
    perform app.assert_finite(v_output, 'lo utilizable');
    if v_output < 0 then
      raise exception 'lo utilizable no puede ser negativo';
    end if;
    if v_waste < -0.001 or abs((v_output + v_waste) - v_input) > 0.001 then
      raise exception 'no cuadra: entrada % = utilizable % + merma % (§44)', v_input, v_output, v_waste;
    end if;
    v_cause := coalesce(nullif(p_outputs->>'waste_cause', ''), 'PREP_LOSS');
    if v_cause not in ('PEEL', 'TRIM', 'PREP_LOSS') then
      raise exception 'causa de merma desconocida: %', v_cause;
    end if;

    if abs(v_input - v_lot.quantity) <= 0.001 then
      v_target := v_lot.id;  -- se preparó el lote completo: en el mismo lote
    else
      v_hijos := public.split_lot(v_lot.id, array[v_input]);  -- §2: el resto queda SIN tocar
      v_target := v_hijos[1];
    end if;

    if v_waste > 0.001 then
      insert into public.inventory_movements
        (household_id, lot_id, reason, delta, actor_member_id, notes)
      values (v_household, v_target, 'PREP_LOSS', -v_waste, v_member, v_cause);
    end if;
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, actor_member_id, notes)
    values (v_household, v_target, 'TRANSFORM', 0, v_member, v_task.task_type);
    update public.inventory_lots
    set processing_state = 'PREPPED', updated_at = now() where id = v_target;

    v_result := jsonb_build_object('lot_id', v_target, 'output_quantity', v_output,
                                   'waste_quantity', v_waste, 'waste_cause', v_cause);
    perform app.emit_event(v_household, 'LOT_PREPPED', 'inventory_lot',
      jsonb_build_object('lot_id', v_target, 'task_id', v_task.id, 'task_type', v_task.task_type),
      'LOT_PREPPED:' || v_task.id::text);

  elsif v_task.task_type in ('PORTION', 'PACK') then
    if v_lot.id is null then raise exception 'esta tarea necesita un lote de origen'; end if;
    if p_outputs is null or jsonb_array_length(coalesce(p_outputs->'packages', '[]'::jsonb)) = 0 then
      raise exception 'porcionar necesita los paquetes reales (cantidad de cada uno)';
    end if;
    for v_pkg in select * from jsonb_array_elements(p_outputs->'packages') loop
      perform app.assert_finite((v_pkg->>'quantity')::numeric, 'un paquete');
      v_cantidades := v_cantidades || (v_pkg->>'quantity')::numeric;
      -- Inyección de UUID: la comida prevista debe ser de ESTE hogar.
      if nullif(v_pkg->>'intended_assignment_id', '') is not null and not exists (
        select 1 from public.meal_assignments a
        join public.weekly_plan_days d on d.id = a.day_id
        join public.weekly_plans w on w.id = d.plan_id
        where a.id = (v_pkg->>'intended_assignment_id')::uuid and w.household_id = v_household
      ) then raise exception 'no autorizado'; end if;
      if nullif(v_pkg->>'location_id', '') is not null and not exists (
        select 1 from public.storage_locations
        where id = (v_pkg->>'location_id')::uuid and household_id = v_household
      ) then raise exception 'la ubicación no pertenece a este hogar'; end if;
    end loop;

    v_hijos := public.split_lot(v_lot.id, v_cantidades);
    perform app.emit_event(v_household, 'LOT_SPLIT', 'inventory_lot',
      jsonb_build_object('parent_lot_id', v_lot.id, 'children', to_jsonb(v_hijos), 'task_id', v_task.id),
      'LOT_SPLIT:' || v_task.id::text);

    for v_pkg in select * from jsonb_array_elements(p_outputs->'packages') loop
      v_i := v_i + 1;
      v_hijo := v_hijos[v_i];
      v_code := 'PKG-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 8));
      update public.inventory_lots
      set package_code = v_code,
          intended_use_date = nullif(v_pkg->>'intended_use_date', '')::date,
          intended_assignment_id = nullif(v_pkg->>'intended_assignment_id', '')::uuid,
          updated_at = now()
      where id = v_hijo;
      v_codes := v_codes || v_code;

      if coalesce((v_pkg->>'vacuum')::boolean, false) then
        -- §74: el sellado es EMPAQUE — no toca temperatura ni vida útil.
        update public.inventory_lots set vacuum_sealed = true where id = v_hijo;
        insert into public.inventory_movements
          (household_id, lot_id, reason, delta, actor_member_id, notes)
        values (v_household, v_hijo, 'TRANSFORM', 0, v_member, 'VACUUM_SEAL');
      end if;
      if nullif(v_pkg->>'location_id', '') is not null then
        perform public.move_lot(v_hijo, (v_pkg->>'location_id')::uuid);
      end if;
    end loop;

    v_result := jsonb_build_object('child_lot_ids', to_jsonb(v_hijos),
                                   'package_codes', to_jsonb(v_codes));

  elsif v_task.task_type = 'VACUUM_SEAL' then
    if v_lot.id is null then raise exception 'esta tarea necesita un lote'; end if;
    update public.inventory_lots set vacuum_sealed = true, updated_at = now() where id = v_lot.id;
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, actor_member_id, notes)
    values (v_household, v_lot.id, 'TRANSFORM', 0, v_member, 'VACUUM_SEAL');
    v_result := jsonb_build_object('lot_id', v_lot.id);

  elsif v_task.task_type in ('REFRIGERATE', 'FREEZE') then
    if v_lot.id is null then raise exception 'esta tarea necesita un lote'; end if;
    v_loc := nullif(p_outputs->>'location_id', '')::uuid;
    if v_loc is null then
      v_kind := case when v_task.task_type = 'FREEZE' then 'FREEZER' else 'FRIDGE' end;
      select id into v_loc from public.storage_locations
      where household_id = v_household and kind = v_kind
      order by sort_order limit 1;
      if v_loc is null then raise exception 'este hogar no tiene una ubicación %', v_kind; end if;
    end if;
    perform public.move_lot(v_lot.id, v_loc);
    v_result := jsonb_build_object('lot_id', v_lot.id, 'location_id', v_loc);
    perform app.emit_event(v_household, 'LOT_MOVED', 'inventory_lot',
      jsonb_build_object('lot_id', v_lot.id, 'location_id', v_loc, 'task_id', v_task.id),
      'LOT_MOVED:' || v_task.id::text);

  else
    -- WASH / THAW_LATER / LEAVE_WHOLE / LABEL / OTHER: sin transformación de
    -- ledger (§7). Lavar no altera cantidad; dejar entero es NO tocar (§2).
    v_result := jsonb_build_object('lot_id', v_task.lot_id);
  end if;

  update public.batch_prep_tasks
  set status = 'DONE',
      completed_quantity = coalesce(p_actual_quantity, v_task.planned_quantity),
      completed_by = v_member,   -- §62: la base estampa el actor
      completed_at = now(),
      result = v_result
  where id = p_task_id;

  update public.batch_prep_plans p
  set status = case
        when not exists (select 1 from public.batch_prep_tasks t
                         where t.plan_id = p.id and t.status = 'PENDING')
        then 'COMPLETED'::public.prep_plan_status
        else 'IN_PROGRESS'::public.prep_plan_status
      end,
      updated_at = now()
  where p.id = v_task.plan_id and p.status in ('READY', 'IN_PROGRESS', 'DRAFT');

  return v_result;
end;
$$;

/** Saltar una tarea (no se hizo y no se hará): jamás toca el ledger. */
create or replace function public.skip_prep_task(p_task_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_task public.batch_prep_tasks; v_household uuid;
begin
  select * into v_task from public.batch_prep_tasks where id = p_task_id for update;
  if v_task.id is null then raise exception 'no autorizado'; end if;
  v_household := app.prep_plan_household(v_task.plan_id);
  if not app.is_household_member(v_household) then raise exception 'no autorizado'; end if;
  if v_task.status <> 'PENDING' then return; end if;
  update public.batch_prep_tasks set status = 'SKIPPED' where id = p_task_id;

  -- El plan cuya última tarea pendiente se saltó queda COMPLETADO, no colgado.
  update public.batch_prep_plans p
  set status = case
        when not exists (select 1 from public.batch_prep_tasks t
                         where t.plan_id = p.id and t.status = 'PENDING')
        then 'COMPLETED'::public.prep_plan_status
        else p.status
      end,
      updated_at = now()
  where p.id = v_task.plan_id and p.status in ('READY', 'IN_PROGRESS', 'DRAFT');
end;
$$;

-- ---------------------------------------------------------------------------
-- Uso rápido por QR (§36) y fecha de seguridad evaluada
-- ---------------------------------------------------------------------------

/** Consumo directo de un lote (fuera de una comida planificada): "me lo comí". */
create or replace function public.use_lot(
  p_lot_id   uuid,
  p_quantity numeric default null,
  p_notes    text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots; v_q numeric;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_lot.status <> 'AVAILABLE' then
    raise exception 'el lote ya está cerrado (%)', v_lot.status;
  end if;
  v_q := coalesce(p_quantity, v_lot.quantity);
  perform app.assert_finite(v_q, 'la cantidad usada');
  if v_q <= 0 or v_q > v_lot.quantity then
    raise exception 'la cantidad usada (%) no calza con el lote (%)', v_q, v_lot.quantity;
  end if;
  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, actor_member_id, notes)
  values (v_lot.household_id, p_lot_id, 'CONSUMED', -v_q,
          app.current_member_id(v_lot.household_id), nullif(trim(p_notes), ''));
end;
$$;

/**
 * Fecha de seguridad EVALUADA (§20-§26): la escribe la app SOLO cuando el
 * FoodStorageSafetyEngine encontró una regla validada, citándola. NULL borra
 * la evaluación (volver a "revisar"). Jamás toca intended_use_date.
 */
create or replace function public.set_lot_safety(
  p_lot_id  uuid,
  p_use_by  date,
  p_basis   text
) returns void language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if p_use_by is not null and (p_basis is null or char_length(trim(p_basis)) < 3) then
    raise exception 'una fecha de seguridad exige su regla fuente (§21: UNKNOWN no es SAFE)';
  end if;
  update public.inventory_lots set use_by = p_use_by, updated_at = now() where id = p_lot_id;
  perform app.emit_event(v_lot.household_id, 'SAFETY_ASSESSED', 'inventory_lot',
    jsonb_build_object('lot_id', p_lot_id, 'use_by', p_use_by, 'basis', p_basis));
end;
$$;

/** Cambiar el uso previsto (§28): planificación pura — use_by NO cambia. */
create or replace function public.set_intended_use(
  p_lot_id        uuid,
  p_use_date      date,
  p_assignment_id uuid default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if p_assignment_id is not null and not exists (
    select 1 from public.meal_assignments a
    join public.weekly_plan_days d on d.id = a.day_id
    join public.weekly_plans w on w.id = d.plan_id
    where a.id = p_assignment_id and w.household_id = v_lot.household_id
  ) then raise exception 'no autorizado'; end if;
  update public.inventory_lots
  set intended_use_date = p_use_date,
      intended_assignment_id = p_assignment_id,
      updated_at = now()
  where id = p_lot_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- QR opaco (§35-§37)
-- ---------------------------------------------------------------------------

/** Asegura un token opaco para el lote (se genera una sola vez). */
create or replace function public.ensure_lot_token(p_lot_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots; v_token text;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_lot.qr_token is not null then return v_lot.qr_token; end if;
  v_token := encode(gen_random_bytes(16), 'hex');
  update public.inventory_lots set qr_token = v_token where id = p_lot_id;
  return v_token;
end;
$$;

/**
 * Resuelve un token de QR → datos del lote, SOLO para integrantes del hogar
 * dueño. Token desconocido y token ajeno responden lo MISMO (sin oráculo).
 */
create or replace function public.resolve_lot_token(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots;
begin
  select * into v_lot from public.inventory_lots where qr_token = p_token;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  return jsonb_build_object(
    'lot_id', v_lot.id,
    'label', v_lot.label,
    'quantity', v_lot.quantity,
    'unit', v_lot.unit,
    'status', v_lot.status,
    'processing_state', v_lot.processing_state,
    'temperature_state', v_lot.temperature_state,
    'package_code', v_lot.package_code,
    'intended_use_date', v_lot.intended_use_date,
    'use_by', v_lot.use_by
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Etiquetas: el snapshot se arma EN la base con datos reales (§38-§40)
-- ---------------------------------------------------------------------------

create or replace function public.create_label_job(
  p_lot_id      uuid,
  p_template_id uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_lot public.inventory_lots;
  v_tpl public.label_templates;
  v_token text;
  v_job uuid;
  v_member uuid;
  v_hoy date;
  v_location text;
  v_meal text;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;

  if p_template_id is not null then
    select * into v_tpl from public.label_templates
    where id = p_template_id
      and (household_id is null or household_id = v_lot.household_id);
    if v_tpl.id is null then raise exception 'no autorizado'; end if;
  else
    select * into v_tpl from public.label_templates
    where household_id = v_lot.household_id and is_active
    order by created_at limit 1;
    if v_tpl.id is null then
      select * into v_tpl from public.label_templates
      where household_id is null and is_active order by created_at limit 1;
    end if;
  end if;

  v_token := public.ensure_lot_token(p_lot_id);
  v_member := app.current_member_id(v_lot.household_id);
  v_hoy := app.household_today(v_lot.household_id);
  select name into v_location from public.storage_locations where id = v_lot.location_id;
  select initcap(a.meal_type::text) into v_meal
  from public.meal_assignments a where a.id = v_lot.intended_assignment_id;

  -- §33-§35: lo IMPRESO queda congelado acá. Sin datos clínicos, sin
  -- objetivos nutricionales, sin identidad — solo el token opaco.
  insert into public.label_print_jobs
    (household_id, lot_id, template_id, template_version, snapshot, status, generated_by)
  values
    (v_lot.household_id, p_lot_id, v_tpl.id, v_tpl.version,
     jsonb_build_object(
       'label', v_lot.label,
       'quantity', v_lot.quantity,
       'unit', v_lot.unit,
       'processing_state', v_lot.processing_state,
       'temperature_state', v_lot.temperature_state,
       'vacuum_sealed', v_lot.vacuum_sealed,
       'prepared_on', v_hoy,
       'intended_use_date', v_lot.intended_use_date,
       'intended_meal', v_meal,
       'safe_use_by', v_lot.use_by,
       'location', v_location,
       'package_code', v_lot.package_code,
       'qr_token', v_token,
       'template', jsonb_build_object(
         'width_mm', v_tpl.width_mm, 'height_mm', v_tpl.height_mm,
         'margin_mm', v_tpl.margin_mm, 'layout', v_tpl.layout)
     ),
     'GENERATED', v_member)
  returning id into v_job;

  perform app.emit_event(v_lot.household_id, 'LABEL_GENERATED', 'label_print_job',
    jsonb_build_object('lot_id', p_lot_id, 'job_id', v_job),
    'LABEL_GENERATED:' || v_job::text);
  return v_job;
end;
$$;

/** Marcar impresa/fallida/cancelada (§38: manual al inicio). */
create or replace function public.mark_label_job(
  p_job_id uuid,
  p_status text
) returns void language plpgsql security definer set search_path = public as $$
declare v_job public.label_print_jobs;
begin
  select * into v_job from public.label_print_jobs where id = p_job_id for update;
  if v_job.id is null or not app.is_household_member(v_job.household_id) then
    raise exception 'no autorizado';
  end if;
  if p_status not in ('PRINTED', 'FAILED', 'CANCELLED') then
    raise exception 'estado de impresión desconocido';
  end if;
  update public.label_print_jobs
  set status = p_status,
      printed_at = case when p_status = 'PRINTED' then now() else printed_at end
  where id = p_job_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- add_manual_lot v2: la temperatura NACE de la ubicación (igual que move_lot).
-- Un lote creado en el congelador no puede quedar "AMBIENT" — eso falsificaba
-- el estado térmico desde el primer segundo (hallazgo del test §73).
-- ---------------------------------------------------------------------------

create or replace function public.add_manual_lot(
  p_household_id uuid,
  p_label        text,
  p_quantity     numeric,
  p_unit         text,
  p_ingredient_id uuid default null,
  p_location_id  uuid default null,
  p_expiry_date  date default null,
  p_source_assignment_id uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_lot uuid; v_member uuid; v_loc uuid; v_kind public.storage_kind;
begin
  if not app.is_household_member(p_household_id) then raise exception 'no autorizado'; end if;
  perform app.assert_finite(p_quantity, 'la cantidad');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'la cantidad tiene que ser mayor que cero';
  end if;
  if p_unit not in ('G', 'ML', 'UNIT') then raise exception 'unidad desconocida'; end if;
  if not app.ingredient_in_scope(p_ingredient_id, p_household_id) then
    raise exception 'el alimento no pertenece a este hogar';
  end if;
  if p_source_assignment_id is not null and not exists (
    select 1 from public.meal_assignments a
    join public.weekly_plan_days d on d.id = a.day_id
    join public.weekly_plans w on w.id = d.plan_id
    where a.id = p_source_assignment_id and w.household_id = p_household_id
  ) then
    raise exception 'la comida de origen no pertenece a este hogar';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.storage_locations
    where id = p_location_id and household_id = p_household_id
  ) then
    raise exception 'la ubicación no pertenece a este hogar';
  end if;

  v_member := app.current_member_id(p_household_id);
  perform public.ensure_storage_locations(p_household_id);

  v_loc := coalesce(p_location_id,
             (select id from public.storage_locations
              where household_id = p_household_id and kind = 'PANTRY'
              order by sort_order limit 1));
  select kind into v_kind from public.storage_locations where id = v_loc;

  insert into public.inventory_lots (
    household_id, ingredient_id, label, quantity, unit,
    processing_state, temperature_state, frozen_at,
    location_id, expiry_date, source_assignment_id, created_by
  ) values (
    p_household_id, p_ingredient_id, trim(p_label), 0, p_unit,
    case when p_source_assignment_id is null then 'RAW'::public.processing_state
         else 'COOKED'::public.processing_state end,
    case v_kind
      when 'FREEZER' then 'FROZEN'::public.temperature_state
      when 'FRIDGE' then 'CHILLED'::public.temperature_state
      else 'AMBIENT'::public.temperature_state
    end,
    case when v_kind = 'FREEZER' then now() else null end,
    v_loc, p_expiry_date, p_source_assignment_id, v_member
  ) returning id into v_lot;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, actor_member_id)
  values (p_household_id, v_lot, 'PURCHASE', p_quantity, v_member);

  return v_lot;
end;
$$;
