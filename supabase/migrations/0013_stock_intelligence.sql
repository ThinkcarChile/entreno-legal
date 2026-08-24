-- Sprint 8 — Stock Intelligence: objetivos de stock, calidad de inventario y
-- soporte para recomendaciones de reposición.
--
-- El motor RECOMIENDA: no compra, no cambia porciones, no toca el ledger.
-- Stock actual y reservas son SIEMPRE derivados (del libro mayor y de las
-- porciones confirmadas): esta migración solo agrega la configuración que el
-- hogar declara y los metadatos de calidad que el cálculo necesita.

-- ---------------------------------------------------------------------------
-- Objetivos de stock por alimento (§8, §9, §10)
-- ---------------------------------------------------------------------------

create table public.stock_targets (
  id                     uuid primary key default gen_random_uuid(),
  household_id           uuid not null references public.households (id) on delete cascade,
  ingredient_id          uuid not null references public.ingredients (id) on delete cascade,
  -- Unidad en la que se expresan las cantidades del objetivo.
  unit                   text not null default 'G' check (unit in ('G', 'ML', 'UNIT')),

  -- Ninguno es obligatorio: cada hogar declara lo que le sirve.
  minimum_quantity       numeric(12, 3) check (minimum_quantity >= 0),
  target_quantity        numeric(12, 3) check (target_quantity >= 0),
  target_days_of_supply  int check (target_days_of_supply between 1 and 90),
  safety_stock           numeric(12, 3) check (safety_stock >= 0),

  review_cycle           text check (review_cycle in ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'MIN_STOCK', 'CUSTOM')),
  reorder_enabled        boolean not null default true,

  -- §9: un objetivo manual JAMÁS se sobreescribe en silencio. El sistema solo
  -- puede sugerir; cambiarlo es decisión de la persona.
  source                 text not null default 'USER_DEFINED'
    check (source in ('USER_DEFINED', 'SYSTEM_SUGGESTED')),

  created_by             uuid references public.household_members (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint stock_targets_one_per_food unique (household_id, ingredient_id)
);

alter table public.stock_targets enable row level security;
create policy stock_targets_select on public.stock_targets
  for select to authenticated using (app.is_household_member(household_id));
-- Escritura solo vía RPC: valida ámbito y estampa autor.

/** Crear o actualizar el objetivo de stock de un alimento. */
create or replace function public.set_stock_target(
  p_household_id          uuid,
  p_ingredient_id         uuid,
  p_unit                  text,
  p_minimum_quantity      numeric default null,
  p_target_quantity       numeric default null,
  p_target_days_of_supply int default null,
  p_safety_stock          numeric default null,
  p_review_cycle          text default null,
  p_reorder_enabled       boolean default true
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_member uuid;
begin
  if not app.is_household_member(p_household_id) then raise exception 'no autorizado'; end if;
  if not app.ingredient_in_scope(p_ingredient_id, p_household_id) then
    raise exception 'el alimento no pertenece a este hogar';
  end if;
  if p_unit not in ('G', 'ML', 'UNIT') then raise exception 'unidad desconocida'; end if;
  perform app.assert_finite(p_minimum_quantity, 'el mínimo');
  perform app.assert_finite(p_target_quantity, 'el objetivo');
  perform app.assert_finite(p_safety_stock, 'el stock de seguridad');
  if p_minimum_quantity is not null and p_minimum_quantity < 0 then
    raise exception 'el mínimo no puede ser negativo';
  end if;
  if p_target_quantity is not null and p_target_quantity < 0 then
    raise exception 'el objetivo no puede ser negativo';
  end if;
  if p_review_cycle is not null
     and p_review_cycle not in ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'MIN_STOCK', 'CUSTOM') then
    raise exception 'ciclo de revisión desconocido';
  end if;

  v_member := app.current_member_id(p_household_id);

  insert into public.stock_targets (
    household_id, ingredient_id, unit,
    minimum_quantity, target_quantity, target_days_of_supply, safety_stock,
    review_cycle, reorder_enabled, source, created_by
  ) values (
    p_household_id, p_ingredient_id, p_unit,
    p_minimum_quantity, p_target_quantity, p_target_days_of_supply, p_safety_stock,
    p_review_cycle, coalesce(p_reorder_enabled, true), 'USER_DEFINED', v_member
  )
  on conflict (household_id, ingredient_id) do update set
    unit = excluded.unit,
    minimum_quantity = excluded.minimum_quantity,
    target_quantity = excluded.target_quantity,
    target_days_of_supply = excluded.target_days_of_supply,
    -- NULL = "no lo toco": la UI actual no expone safety_stock y pisarlo con
    -- null cada guardado borraría en silencio lo configurado por otra vía.
    safety_stock = coalesce(excluded.safety_stock, public.stock_targets.safety_stock),
    review_cycle = excluded.review_cycle,
    reorder_enabled = excluded.reorder_enabled,
    source = 'USER_DEFINED',
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

/** Quitar el objetivo (vuelve al comportamiento por defecto). */
create or replace function public.delete_stock_target(
  p_household_id  uuid,
  p_ingredient_id uuid
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not app.is_household_member(p_household_id) then raise exception 'no autorizado'; end if;
  delete from public.stock_targets
  where household_id = p_household_id and ingredient_id = p_ingredient_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Calidad del stock: exacto vs aproximado (§23)
-- ---------------------------------------------------------------------------

alter table public.inventory_lots
  add column is_approximate boolean not null default false;

comment on column public.inventory_lots.is_approximate is
  '"Debe quedar como medio kilo": la cantidad es una estimación de la persona, '
  'no una pesada. Se muestra con ~ y reduce la confianza del pronóstico. La '
  'semántica de aproximación NUNCA se convierte en verdad exacta en silencio.';

-- adjust_lot v3: puede declarar que la cantidad nueva es aproximada.
-- (Firma nueva: se elimina la anterior para no dejar una sobrecarga ambigua.)
drop function if exists public.adjust_lot(uuid, numeric, text);

create or replace function public.adjust_lot(
  p_lot_id      uuid,
  p_quantity    numeric,
  p_notes       text default null,
  p_approximate boolean default false
) returns void language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_lot.status in ('CONSUMED', 'DISCARDED', 'SPLIT') then
    raise exception 'el lote "%" ya está cerrado (%): se corrige con un lote nuevo, no reviviendo la historia',
      v_lot.label, v_lot.status;
  end if;
  perform app.assert_finite(p_quantity, 'la cantidad');
  if p_quantity is null or p_quantity < 0 then
    raise exception 'la cantidad ajustada no puede ser negativa';
  end if;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, actor_member_id, notes)
  values
    (v_lot.household_id, p_lot_id, 'ADJUSTMENT', p_quantity - v_lot.quantity,
     app.current_member_id(v_lot.household_id), nullif(trim(p_notes), ''));

  update public.inventory_lots
  set is_approximate = coalesce(p_approximate, false)
  where id = p_lot_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Capacidad de almacenamiento, opcional y jamás inventada (§27)
-- ---------------------------------------------------------------------------

alter table public.storage_locations
  add column capacity_quantity numeric(12, 3) check (capacity_quantity > 0),
  add column capacity_unit     text check (capacity_unit in ('G', 'ML', 'UNIT'));

comment on column public.storage_locations.capacity_quantity is
  'Capacidad declarada por el hogar, o NULL = desconocida. Solo se compara '
  'cuando las unidades calzan; sin capacidad no se inventa un tope.';

-- ---------------------------------------------------------------------------
-- Sugerencias de reposición hacia la lista (§33, §34)
-- ---------------------------------------------------------------------------

-- Un item sugerido por Stock Intelligence llega a la lista como sugerencia con
-- procedencia propia: no es demanda del plan (FOOD_PLAN) ni un manual a secas.
alter type public.shopping_item_source add value if not exists 'STOCK_INTELLIGENCE';

-- Una sola sugerencia de Stock Intelligence por alimento y lista: la carrera
-- de dos clics simultáneos choca acá en vez de duplicar la línea.
-- (El predicado evita el literal nuevo del enum: un valor agregado en esta
-- misma transacción no puede usarse todavía. "Ni plan ni manual" = sugerencia.)
create unique index if not exists shopping_items_suggestion_uniq
  on public.shopping_list_items (list_id, ingredient_id)
  where source not in ('FOOD_PLAN', 'MANUAL') and ingredient_id is not null;

-- ensure_weekly_plan v2: la carrera crear-crear ya no explota en la cara del
-- usuario — el perdedor del unique relee y sigue.
create or replace function public.ensure_weekly_plan(p_household_id uuid, p_week_start date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_plan uuid;
  v_dia int;
begin
  if not app.is_household_member(p_household_id) then raise exception 'no autorizado'; end if;

  insert into public.weekly_plans (household_id, week_start, created_by)
  values (p_household_id, p_week_start, app.current_member_id(p_household_id))
  on conflict (household_id, week_start) do nothing;

  select id into v_plan from public.weekly_plans
  where household_id = p_household_id and week_start = p_week_start;

  for v_dia in 0..6 loop
    insert into public.weekly_plan_days (plan_id, plan_date)
    values (v_plan, p_week_start + v_dia)
    on conflict (plan_id, plan_date) do nothing;
  end loop;

  return v_plan;
end;
$$;

-- ---------------------------------------------------------------------------
-- Índices para que 500 lotes sigan siendo razonables (§55)
-- ---------------------------------------------------------------------------

create index if not exists projections_consumed_by_date_idx
  on public.member_serving_projections (serving_date)
  where status = 'CONSUMED';

create index if not exists projections_planned_by_date_idx
  on public.member_serving_projections (serving_date)
  where status = 'PLANNED';

create index if not exists movements_household_reason_idx
  on public.inventory_movements (household_id, reason, created_at);

create index if not exists shortfalls_household_date_idx
  on public.consumption_shortfalls (household_id, serving_date);

-- ---------------------------------------------------------------------------
-- Merma con costo estimado (§25, §26): proporción del valor del lote
-- ---------------------------------------------------------------------------
--
-- security_invoker: la vista corre con los permisos de quien consulta, así que
-- la RLS de movimientos y lotes sigue mandando.

create view public.waste_movements
with (security_invoker = true) as
select
  m.id,
  m.household_id,
  l.ingredient_id,
  l.unit,
  -m.delta as quantity,
  m.reason,
  m.created_at,
  case
    when l.acquisition_value is not null and entradas.total > 0
    then round(l.acquisition_value * (-m.delta) / entradas.total, 4)
  end as estimated_cost
from public.inventory_movements m
join public.inventory_lots l on l.id = m.lot_id
left join lateral (
  select sum(e.delta) as total
  from public.inventory_movements e
  where e.lot_id = m.lot_id and e.delta > 0
) entradas on true
where m.reason in ('SPOILED', 'EXPIRED', 'DAMAGED', 'DISCARDED_LEFTOVER', 'PURCHASE_PROBLEM')
  and m.delta < 0;

-- Compras recibidas por identidad, para la señal de sobrecompra (§43).
create view public.purchase_movements
with (security_invoker = true) as
select
  m.id,
  m.household_id,
  l.ingredient_id,
  l.unit,
  m.delta as quantity,
  m.created_at
from public.inventory_movements m
join public.inventory_lots l on l.id = m.lot_id
where m.reason = 'PURCHASE' and m.delta > 0 and l.ingredient_id is not null;
