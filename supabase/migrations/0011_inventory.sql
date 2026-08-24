-- Sprint 7 — Despensa e inventario: la casa sabe qué tiene.
--
-- K-11: el stock es UN libro mayor (`inventory_movements`) sobre lotes
-- (`inventory_lots`). No existe una segunda tabla de "pantry_items": las
-- sobras, los paquetes partidos y lo cocinado por adelantado SON lotes.
--
-- K-18: estados ortogonales — `processing_state` (RAW/PREPPED/COOKED) ×
-- `temperature_state` (AMBIENT/CHILLED/FROZEN) + `thawed_at` como evidencia.
--
-- K-19: el costo canónico del lote es `acquisition_value` (valor TOTAL);
-- cualquier precio unitario se deriva. Este sprint no maneja precios: la
-- columna existe y queda NULL hasta el sprint de recepción con boleta.
--
-- K-22: todo efecto escribible lleva clave de idempotencia única — recibir la
-- misma compra dos veces o registrar el mismo consumo dos veces es un no-op,
-- jamás un doble descuento.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.storage_kind as enum ('PANTRY', 'FRIDGE', 'FREEZER', 'OTHER');

create type public.processing_state as enum ('RAW', 'PREPPED', 'COOKED');

create type public.temperature_state as enum ('AMBIENT', 'CHILLED', 'FROZEN');

create type public.lot_status as enum ('AVAILABLE', 'RESERVED', 'CONSUMED', 'DISCARDED', 'SPLIT');

create type public.movement_reason as enum (
  'PURCHASE', 'CONSUMED', 'USED_IN_RECIPE',
  'SPOILED', 'EXPIRED', 'DAMAGED', 'DISCARDED_LEFTOVER', 'PURCHASE_PROBLEM',
  'ADJUSTMENT', 'SPLIT', 'MERGE', 'TRANSFORM', 'COOK', 'THAW', 'MOVE',
  'LABEL_WEIGHT_UPDATE', 'OTHER'
);

-- ---------------------------------------------------------------------------
-- Ubicaciones
-- ---------------------------------------------------------------------------

create table public.storage_locations (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  kind         public.storage_kind not null default 'PANTRY',
  sort_order   int not null default 100,
  created_at   timestamptz not null default now(),
  constraint storage_locations_name_uniq unique (household_id, name)
);

alter table public.storage_locations enable row level security;
create policy storage_locations_all on public.storage_locations
  for all to authenticated
  using (app.is_household_member(household_id))
  with check (app.is_household_member(household_id));

-- Una ubicación con lotes adentro no se borra: primero se mueven los lotes.
-- (Borrar con `on delete set null` los dejaría "sin ubicación" en silencio.)
create or replace function app.protect_location_with_lots()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.inventory_lots
             where location_id = old.id and status in ('AVAILABLE', 'RESERVED')) then
    raise exception 'la ubicación "%" tiene lotes adentro: muévelos antes de borrarla', old.name;
  end if;
  return old;
end;
$$;

create trigger locations_protect_lots
  before delete on public.storage_locations
  for each row execute function app.protect_location_with_lots();

/** Ubicaciones por defecto del hogar, creadas una sola vez. */
create or replace function public.ensure_storage_locations(p_household_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not app.is_household_member(p_household_id) then raise exception 'no autorizado'; end if;
  insert into public.storage_locations (household_id, name, kind, sort_order)
  values
    (p_household_id, 'Despensa', 'PANTRY', 10),
    (p_household_id, 'Refrigerador', 'FRIDGE', 20),
    (p_household_id, 'Congelador', 'FREEZER', 30)
  on conflict (household_id, name) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lotes: el objeto físico identificable
-- ---------------------------------------------------------------------------

create table public.inventory_lots (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references public.households (id) on delete cascade,

  -- Identidad del alimento. La etiqueta se congela SIEMPRE: si el catálogo
  -- archiva el alimento, el lote sigue sabiendo qué es.
  ingredient_id      uuid references public.ingredients (id) on delete set null,
  product_id         uuid references public.commercial_products (id) on delete set null,
  label              text not null check (char_length(label) between 1 and 200),

  -- Cantidad VIGENTE, cacheada desde los movimientos (el trigger la mantiene;
  -- editarla a mano está bloqueado).
  quantity           numeric(12, 3) not null default 0 check (quantity >= 0),
  unit               text not null check (unit in ('G', 'ML', 'UNIT')),
  weight_basis       public.weight_basis not null default 'RAW',

  processing_state   public.processing_state not null default 'RAW',
  temperature_state  public.temperature_state not null default 'AMBIENT',
  thawed_at          timestamptz,
  vacuum_sealed      boolean not null default false,

  location_id        uuid references public.storage_locations (id) on delete set null,

  -- K-19: valor total del lote. NULL hasta que exista recepción con precios.
  acquisition_value  numeric(12, 4) check (acquisition_value >= 0),

  expiry_date        date,
  use_by             date,

  -- Origen: compra, partición de otro lote, o sobra de una comida.
  shopping_item_id   uuid references public.shopping_list_items (id) on delete set null,
  parent_lot_id      uuid references public.inventory_lots (id) on delete set null,
  source_assignment_id uuid references public.meal_assignments (id) on delete set null,

  prep_metadata      jsonb,
  status             public.lot_status not null default 'AVAILABLE',
  created_by         uuid references public.household_members (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index inventory_lots_household_idx on public.inventory_lots (household_id, status);
create index inventory_lots_ingredient_idx on public.inventory_lots (ingredient_id)
  where ingredient_id is not null;

alter table public.inventory_lots enable row level security;
create policy inventory_lots_select on public.inventory_lots
  for select to authenticated using (app.is_household_member(household_id));
-- La cantidad y el estado los mantiene el libro mayor: no hay INSERT/UPDATE
-- directo desde el cliente; todo pasa por los RPC.

-- ---------------------------------------------------------------------------
-- Movimientos: el único mecanismo de variación
-- ---------------------------------------------------------------------------

create table public.inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households (id) on delete cascade,
  lot_id          uuid not null references public.inventory_lots (id) on delete cascade,
  reason          public.movement_reason not null,
  -- Cambio de cantidad en la unidad del lote. 0 es válido (MOVE, THAW).
  delta           numeric(12, 3) not null,
  -- Movimientos de una misma operación física comparten grupo (SPLIT, MERGE).
  group_id        uuid,
  -- K-22: un reintento jamás duplica un efecto.
  idempotency_key text,
  consumption_log_id uuid,
  actor_member_id uuid references public.household_members (id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now()
);

create unique index inventory_movements_idem_uniq
  on public.inventory_movements (idempotency_key) where idempotency_key is not null;
create index inventory_movements_lot_idx on public.inventory_movements (lot_id, created_at);
create index inventory_movements_group_idx on public.inventory_movements (group_id)
  where group_id is not null;

alter table public.inventory_movements enable row level security;
create policy inventory_movements_select on public.inventory_movements
  for select to authenticated using (app.is_household_member(household_id));
-- Igual que los lotes: se escribe solo vía RPC.

-- ---------------------------------------------------------------------------
-- Registro de consumo (base): "alguien comió"
-- ---------------------------------------------------------------------------

create table public.consumption_logs (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references public.households (id) on delete cascade,
  member_id         uuid not null references public.household_members (id) on delete cascade,
  assignment_id     uuid references public.meal_assignments (id) on delete set null,
  projection_id     uuid references public.member_serving_projections (id) on delete set null,
  kind              text not null default 'PLANNED' check (kind in ('PLANNED', 'OFF_PLAN')),
  affects_inventory boolean not null default true,
  logged_by         uuid references public.household_members (id) on delete set null,
  logged_at         timestamptz not null default now(),
  notes             text
);

-- Una porción se registra como comida UNA vez.
create unique index consumption_logs_projection_uniq
  on public.consumption_logs (projection_id) where projection_id is not null;

alter table public.inventory_movements
  add constraint movements_consumption_log_fk
  foreign key (consumption_log_id) references public.consumption_logs (id) on delete set null;
create index movements_consumption_log_idx
  on public.inventory_movements (consumption_log_id) where consumption_log_id is not null;

alter table public.consumption_logs enable row level security;
create policy consumption_logs_select on public.consumption_logs
  for select to authenticated using (app.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Guardas numéricas: NaN e Infinity son veneno para un libro mayor
-- ---------------------------------------------------------------------------
--
-- En PostgreSQL, 'NaN'::numeric es MAYOR que cualquier número: pasa un
-- `>= 0` sin inmutarse y desde ahí contamina cada suma. Un RPC expuesto por
-- PostgREST no puede confiar en que el cliente mande números de verdad.

create or replace function app.assert_finite(p_value numeric, p_nombre text)
returns void language plpgsql immutable as $$
begin
  if p_value is not null and (p_value = 'NaN'::numeric
     or p_value = 'Infinity'::numeric or p_value = '-Infinity'::numeric) then
    raise exception '% no es un número válido', p_nombre;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- El libro mayor manda: triggers de integridad
-- ---------------------------------------------------------------------------

/** Aplica cada movimiento a la cantidad cacheada del lote. */
create or replace function app.apply_movement_to_lot()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_qty numeric; v_label text; v_status public.lot_status; v_nuevo public.lot_status;
begin
  select quantity, label, status into v_qty, v_label, v_status
  from public.inventory_lots where id = new.lot_id for update;

  if v_qty is null then raise exception 'no autorizado'; end if;
  if v_qty + new.delta < 0 then
    raise exception 'el movimiento dejaría el lote "%" en negativo (%). El inventario no inventa stock.',
      v_label, v_qty + new.delta
      using errcode = 'check_violation';
  end if;

  -- Estado derivado que RESPETA la historia: un delta 0 (MOVE/THAW) no cambia
  -- nada; un lote cerrado no revive salvo entrada real; y el cierre dice POR
  -- QUÉ se cerró — merma ≠ partición ≠ consumo. Sin esto, mover un lote
  -- descartado lo convertía en "consumido" y las estadísticas mentían.
  if new.delta = 0 then
    v_nuevo := v_status;
  elsif v_qty + new.delta > 0 then
    v_nuevo := case when v_status in ('CONSUMED', 'DISCARDED', 'SPLIT')
                    then 'AVAILABLE'::public.lot_status
                    else v_status end;
  else
    v_nuevo := case
      when new.reason in ('SPOILED', 'EXPIRED', 'DAMAGED', 'DISCARDED_LEFTOVER', 'PURCHASE_PROBLEM')
        then 'DISCARDED'::public.lot_status
      when new.reason in ('SPLIT', 'MERGE') then 'SPLIT'::public.lot_status
      else 'CONSUMED'::public.lot_status
    end;
  end if;

  update public.inventory_lots
  set quantity = quantity + new.delta,
      status = v_nuevo,
      updated_at = now()
  where id = new.lot_id;

  return new;
end;
$$;

create trigger movements_apply
  after insert on public.inventory_movements
  for each row execute function app.apply_movement_to_lot();

/** El libro mayor es append-only: ni editar ni borrar movimientos. */
create or replace function app.ledger_is_append_only()
returns trigger language plpgsql as $$
begin
  -- Un DELETE que llega por cascada (se borra el hogar o el lote entero) viene
  -- de un trigger de integridad referencial: profundidad > 1. Ese sí pasa.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'el libro mayor de inventario es append-only: se corrige con un movimiento nuevo (ADJUSTMENT), no editando la historia';
end;
$$;

create trigger movements_append_only
  before update or delete on public.inventory_movements
  for each row execute function app.ledger_is_append_only();

/**
 * Invariante de grupo (K-11): en SPLIT y MERGE la cantidad se conserva —
 * Σ deltas del grupo = 0. Se verifica al cierre de la transacción, cuando el
 * grupo está completo.
 */
create or replace function app.check_group_invariant()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_sum numeric;
begin
  if new.group_id is null or new.reason not in ('SPLIT', 'MERGE') then
    return null;
  end if;
  select sum(delta) into v_sum
  from public.inventory_movements
  where group_id = new.group_id and reason in ('SPLIT', 'MERGE');
  if abs(coalesce(v_sum, 0)) > 0.001 then
    raise exception 'invariante de grupo violado: un % debe conservar la cantidad (suma de deltas = %, no 0)',
      new.reason, v_sum
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger movements_group_invariant
  after insert on public.inventory_movements
  deferrable initially deferred
  for each row execute function app.check_group_invariant();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

/**
 * Recibir la compra: los items COMPRADOS de una lista finalizada se vuelven
 * lotes. Idempotente por item (K-22): recibir dos veces no duplica nada.
 * Devuelve cuántos lotes nuevos se crearon.
 */
create or replace function public.receive_shopping_list(
  p_list_id     uuid,
  p_location_id uuid default null
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_status public.shopping_list_status;
  v_member uuid;
  v_item record;
  v_lot uuid;
  v_qty numeric;
  v_count int := 0;
begin
  select household_id, status into v_household, v_status
  from public.shopping_lists where id = p_list_id;

  if v_household is null or not app.can_manage_shopping(v_household) then
    raise exception 'no autorizado';
  end if;
  if v_status <> 'COMPLETED' then
    raise exception 'Primero finaliza la compra: se recibe lo comprado, no lo pendiente.'
      using errcode = 'check_violation';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.storage_locations
    where id = p_location_id and household_id = v_household
  ) then
    raise exception 'la ubicación no pertenece a este hogar';
  end if;

  v_member := app.current_member_id(v_household);
  perform public.ensure_storage_locations(v_household);

  for v_item in
    select i.* from public.shopping_list_items i
    where i.list_id = p_list_id and i.status = 'PURCHASED'
      and (i.ingredient_id is not null or i.product_id is not null)
  loop
    -- K-22: si este item ya se recibió, el índice único lo vuelve no-op.
    if exists (select 1 from public.inventory_movements
               where idempotency_key = 'RECEIVE:' || v_item.id::text) then
      continue;
    end if;

    v_qty := coalesce(v_item.planned_quantity, v_item.required_quantity, 0);
    if v_qty <= 0 then continue; end if;

    insert into public.inventory_lots (
      household_id, ingredient_id, product_id, label,
      quantity, unit, weight_basis,
      location_id, shopping_item_id, created_by
    ) values (
      v_household, v_item.ingredient_id, v_item.product_id, v_item.label,
      0, v_item.unit,
      case when v_item.purchase_basis = 'DRAINED' then 'DRAINED'::public.weight_basis
           else 'RAW'::public.weight_basis end,
      coalesce(p_location_id,
               (select id from public.storage_locations
                where household_id = v_household and kind = 'PANTRY'
                order by sort_order limit 1)),
      v_item.id, v_member
    ) returning id into v_lot;

    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, idempotency_key, actor_member_id)
    values
      (v_household, v_lot, 'PURCHASE', v_qty, 'RECEIVE:' || v_item.id::text, v_member);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

/**
 * "Comimos lo planificado": las porciones PLANNED de una comida confirmada
 * pasan a CONSUMED, cada una con su registro de consumo, y la despensa se
 * descuenta por FEFO — solo hasta donde HAY stock: el inventario nunca se
 * inventa ni queda negativo. Devuelve cuántas porciones se registraron.
 */
create or replace function public.consume_planned_meal(p_assignment_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_member uuid;
  v_proj record;
  v_comp record;
  v_lot record;
  v_log uuid;
  v_pendiente numeric;
  v_toma numeric;
  v_count int := 0;
begin
  select p.household_id into v_household
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  where a.id = p_assignment_id;

  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  v_member := app.current_member_id(v_household);

  for v_proj in
    select * from public.member_serving_projections
    where assignment_id = p_assignment_id and status = 'PLANNED'
  loop
    insert into public.consumption_logs
      (household_id, member_id, assignment_id, projection_id, kind, logged_by)
    values (v_household, v_proj.member_id, p_assignment_id, v_proj.id, 'PLANNED', v_member)
    on conflict (projection_id) where projection_id is not null do nothing
    returning id into v_log;

    if v_log is null then continue; end if; -- ya registrada: no-op (K-22)

    update public.member_serving_projections
    set status = 'CONSUMED' where id = v_proj.id;

    -- Descuento FEFO por componente, capado al stock real.
    for v_comp in
      select * from public.member_serving_components
      where projection_id = v_proj.id and ingredient_id is not null
        and proposed_quantity > 0
    loop
      v_pendiente := v_comp.proposed_quantity;
      for v_lot in
        select l.* from public.inventory_lots l
        where l.household_id = v_household
          and l.ingredient_id = v_comp.ingredient_id
          and l.unit = v_comp.unit::text
          -- misma representación: 300 g de arroz cocido no pagan 300 g crudos
          and l.weight_basis = v_comp.weight_basis
          and l.status = 'AVAILABLE' and l.quantity > 0
        order by l.use_by asc nulls last, l.expiry_date asc nulls last, l.created_at asc
      loop
        exit when v_pendiente <= 0;
        v_toma := least(v_pendiente, v_lot.quantity);
        insert into public.inventory_movements
          (household_id, lot_id, reason, delta, idempotency_key,
           consumption_log_id, actor_member_id)
        values
          (v_household, v_lot.id, 'CONSUMED', -v_toma,
           'CONSUME:' || v_proj.id::text || ':' || v_comp.id::text || ':' || v_lot.id::text,
           v_log, v_member);
        v_pendiente := v_pendiente - v_toma;
      end loop;
      -- Si no había stock suficiente, el resto simplemente no se descuenta:
      -- la despensa dice la verdad que conoce, no una negativa inventada.
    end loop;

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    update public.meal_assignments set status = 'SERVED' where id = p_assignment_id;
  end if;

  return v_count;
end;
$$;

/** Ajuste auditable: "en realidad quedan X". */
create or replace function public.adjust_lot(
  p_lot_id   uuid,
  p_quantity numeric,
  p_notes    text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots;
begin
  -- FOR UPDATE: el delta se calcula sobre la cantidad REAL en este instante.
  -- Sin el lock, dos ajustes simultáneos parten de la misma lectura y el
  -- resultado final es distinto de lo que cualquiera de los dos pidió.
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
end;
$$;

/** Merma: el lote se descarta entero, con su causa explícita. */
create or replace function public.discard_lot(
  p_lot_id uuid,
  p_reason public.movement_reason,
  p_notes  text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if p_reason not in ('SPOILED', 'EXPIRED', 'DAMAGED', 'DISCARDED_LEFTOVER', 'PURCHASE_PROBLEM') then
    raise exception 'un descarte necesita una causa de merma explícita';
  end if;
  if v_lot.quantity <= 0 then return; end if;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, actor_member_id, notes)
  values
    (v_lot.household_id, p_lot_id, p_reason, -v_lot.quantity,
     app.current_member_id(v_lot.household_id), nullif(trim(p_notes), ''));
end;
$$;

/** Alta manual de un lote (compra fuera de la app, sobra, regalo). */
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
declare v_lot uuid; v_member uuid;
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

  insert into public.inventory_lots (
    household_id, ingredient_id, label, quantity, unit,
    processing_state,
    location_id, expiry_date, source_assignment_id, created_by
  ) values (
    p_household_id, p_ingredient_id, trim(p_label), 0, p_unit,
    case when p_source_assignment_id is null then 'RAW'::public.processing_state
         else 'COOKED'::public.processing_state end,
    coalesce(p_location_id,
             (select id from public.storage_locations
              where household_id = p_household_id and kind = 'PANTRY'
              order by sort_order limit 1)),
    p_expiry_date, p_source_assignment_id, v_member
  ) returning id into v_lot;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, actor_member_id)
  values (p_household_id, v_lot, 'PURCHASE', p_quantity, v_member);

  return v_lot;
end;
$$;

/** Mover de ubicación (delta 0; congelar/descongelar actualiza el estado). */
create or replace function public.move_lot(
  p_lot_id      uuid,
  p_location_id uuid
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_lot public.inventory_lots;
  v_kind public.storage_kind;
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
      updated_at = now()
  where id = p_lot_id;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, actor_member_id,
     notes)
  values
    (v_lot.household_id, p_lot_id,
     case when v_lot.temperature_state = 'FROZEN' and v_kind <> 'FREEZER' then 'THAW'
          else 'MOVE' end::public.movement_reason,
     0, app.current_member_id(v_lot.household_id),
     null);
end;
$$;

/**
 * Partir un lote (4 kg de pollo → paquetes de 1 kg). El grupo conserva la
 * cantidad: Σ deltas = 0 verificado al cierre de la transacción. El valor
 * (K-19) se reparte proporcional a la cantidad.
 */
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
      -- split total: el último hijo cierra contra el valor completo
      v_valor_hijo := v_lot.acquisition_value - v_valor_repartido;
    else
      v_valor_hijo := round(v_lot.acquisition_value * v_q / v_lot.quantity, 4);
    end if;
    v_valor_repartido := v_valor_repartido + coalesce(v_valor_hijo, 0);

    insert into public.inventory_lots (
      household_id, ingredient_id, product_id, label, quantity, unit, weight_basis,
      processing_state, temperature_state, thawed_at, vacuum_sealed,
      location_id, expiry_date, use_by, parent_lot_id,
      acquisition_value, created_by
    ) values (
      v_lot.household_id, v_lot.ingredient_id, v_lot.product_id, v_lot.label,
      0, v_lot.unit, v_lot.weight_basis,
      v_lot.processing_state, v_lot.temperature_state, v_lot.thawed_at, v_lot.vacuum_sealed,
      v_lot.location_id, v_lot.expiry_date, v_lot.use_by, p_lot_id,
      v_valor_hijo,
      v_member
    ) returning id into v_hijo;

    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, group_id, actor_member_id)
    values (v_lot.household_id, v_hijo, 'SPLIT', v_q, v_group, v_member);

    v_hijos := v_hijos || v_hijo;
  end loop;

  -- El padre entrega el valor que se llevaron los hijos: la despensa completa
  -- sigue valiendo lo mismo antes y después de partir.
  if v_lot.acquisition_value is not null then
    update public.inventory_lots
    set acquisition_value = greatest(acquisition_value - v_valor_repartido, 0)
    where id = p_lot_id;
  end if;

  return v_hijos;
end;
$$;
