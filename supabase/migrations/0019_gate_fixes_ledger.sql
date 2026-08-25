-- Integration Gate 0→10 — correcciones confirmadas por la auditoría de 13
-- lentes (docs/qa/integration-gate-0-10.md). Cada bloque cita el defecto.
--
-- Nada de esto modifica una migración congelada: todo son `create or replace`
-- de funciones y ajustes de policy/trigger.

-- ---------------------------------------------------------------------------
-- [C-1] move_lot: la temperatura la manda la UBICACIÓN DESTINO, no el estado
-- previo. Antes, sacar un paquete del congelador a la Despensa lo dejaba
-- CHILLED (el CASE miraba `temperature_state = FROZEN` antes que el tipo del
-- destino) y el SafetyEngine razonaba sobre un hecho falso.
-- ---------------------------------------------------------------------------

create or replace function public.move_lot(
  p_lot_id      uuid,
  p_location_id uuid
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_lot public.inventory_lots;
  v_kind public.storage_kind;
  v_nueva public.temperature_state;
  v_entra_frozen boolean;
  v_sale_frozen boolean;
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

  -- El estado térmico es un HECHO del lugar donde está la comida.
  v_nueva := case v_kind
    when 'FREEZER' then 'FROZEN'
    when 'FRIDGE'  then 'CHILLED'
    else 'AMBIENT'
  end::public.temperature_state;

  v_entra_frozen := (v_nueva = 'FROZEN' and v_lot.temperature_state <> 'FROZEN');
  v_sale_frozen  := (v_lot.temperature_state = 'FROZEN' and v_nueva <> 'FROZEN');

  update public.inventory_lots
  set location_id = p_location_id,
      temperature_state = v_nueva,
      -- K-18: salir del congelador SELLA la evidencia del descongelado, vaya
      -- al refrigerador o a la despensa.
      thawed_at = case when v_sale_frozen then now() else v_lot.thawed_at end,
      frozen_at = case when v_entra_frozen then now() else v_lot.frozen_at end,
      updated_at = now()
  where id = p_lot_id;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, actor_member_id, notes)
  values
    (v_lot.household_id, p_lot_id,
     case when v_sale_frozen then 'THAW' else 'MOVE' end::public.movement_reason,
     0, app.current_member_id(v_lot.household_id), null);

  if v_entra_frozen then
    perform app.emit_event(v_lot.household_id, 'LOT_FROZEN', 'inventory_lot',
      jsonb_build_object('lot_id', p_lot_id));
  elsif v_sale_frozen then
    perform app.emit_event(v_lot.household_id, 'LOT_THAWED', 'inventory_lot',
      jsonb_build_object('lot_id', p_lot_id));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- [C-2] add_manual_lot: el estado de preparación se DECLARA, no se adivina.
-- Antes se infería de si venía una comida de origen y, como la app manda
-- siempre null, ningún lote podía nacer COOKED: "la cazuela de ayer" entraba
-- mintiendo que era carne cruda. La temperatura sale de la ubicación.
-- ---------------------------------------------------------------------------

-- La firma vieja se retira ANTES: agregar un parámetro con default deja dos
-- sobrecargas y toda llamada con menos argumentos se vuelve ambigua.
drop function if exists public.add_manual_lot(uuid, text, numeric, text, uuid, uuid, date, uuid);

create or replace function public.add_manual_lot(
  p_household_id uuid,
  p_label        text,
  p_quantity     numeric,
  p_unit         text,
  p_ingredient_id uuid default null,
  p_location_id  uuid default null,
  p_expiry_date  date default null,
  p_source_assignment_id uuid default null,
  p_processing_state text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_lot uuid; v_member uuid; v_loc uuid;
  v_kind public.storage_kind; v_proc public.processing_state;
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
  if p_processing_state is not null
     and p_processing_state not in ('RAW', 'PREPPED', 'COOKED') then
    raise exception 'estado de preparación desconocido';
  end if;

  v_member := app.current_member_id(p_household_id);
  perform public.ensure_storage_locations(p_household_id);

  v_loc := coalesce(p_location_id,
             (select id from public.storage_locations
              where household_id = p_household_id and kind = 'PANTRY'
              order by sort_order limit 1));
  select kind into v_kind from public.storage_locations where id = v_loc;

  v_proc := coalesce(
    nullif(p_processing_state, '')::public.processing_state,
    case when p_source_assignment_id is null then 'RAW'
         else 'COOKED' end::public.processing_state);

  insert into public.inventory_lots (
    household_id, ingredient_id, label, quantity, unit,
    processing_state, temperature_state, frozen_at,
    location_id, expiry_date, source_assignment_id, created_by
  ) values (
    p_household_id, p_ingredient_id, trim(p_label), 0, p_unit,
    v_proc,
    case v_kind when 'FREEZER' then 'FROZEN' when 'FRIDGE' then 'CHILLED'
                else 'AMBIENT' end::public.temperature_state,
    case when v_kind = 'FREEZER' then now() else null end,
    v_loc, p_expiry_date, p_source_assignment_id, v_member
  ) returning id into v_lot;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, actor_member_id)
  values (p_household_id, v_lot, 'PURCHASE', p_quantity, v_member);

  return v_lot;
end;
$$;

-- ---------------------------------------------------------------------------
-- [C-3] receive_shopping_list: los lotes nacen con la temperatura de DONDE se
-- guardan (antes todo AMBIENT aunque se recibiera en el congelador).
-- [I-3] Además la lista se bloquea: dos recepciones simultáneas se serializan.
-- ---------------------------------------------------------------------------

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
  v_loc uuid;
  v_kind public.storage_kind;
begin
  select household_id, status into v_household, v_status
  from public.shopping_lists where id = p_list_id for update;

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
  v_loc := coalesce(p_location_id,
             (select id from public.storage_locations
              where household_id = v_household and kind = 'PANTRY'
              order by sort_order limit 1));
  select kind into v_kind from public.storage_locations where id = v_loc;

  for v_item in
    select i.* from public.shopping_list_items i
    where i.list_id = p_list_id and i.status = 'PURCHASED'
      and (i.ingredient_id is not null or i.product_id is not null)
  loop
    if exists (select 1 from public.inventory_movements
               where idempotency_key = 'RECEIVE:' || v_item.id::text) then
      continue;
    end if;

    v_qty := coalesce(v_item.planned_quantity, v_item.required_quantity, 0);
    if v_qty <= 0 then continue; end if;

    insert into public.inventory_lots (
      household_id, ingredient_id, product_id, label,
      quantity, unit, weight_basis,
      temperature_state, frozen_at,
      location_id, shopping_item_id, created_by
    ) values (
      v_household, v_item.ingredient_id, v_item.product_id, v_item.label,
      0, v_item.unit,
      case when v_item.purchase_basis = 'DRAINED' then 'DRAINED'::public.weight_basis
           else 'RAW'::public.weight_basis end,
      case v_kind when 'FREEZER' then 'FROZEN' when 'FRIDGE' then 'CHILLED'
                  else 'AMBIENT' end::public.temperature_state,
      case when v_kind = 'FREEZER' then now() else null end,
      v_loc, v_item.id, v_member
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

-- ---------------------------------------------------------------------------
-- [K-1] merge_lots: el valor de los lotes de origen se DEBITA. Antes los
-- padres conservaban su acquisition_value y el hijo sumaba el total: la
-- despensa valía el doble después de unir.
-- [A-5] product_id también define identidad.
-- [C-5] La historia térmica del resultado es la MÁS conservadora del grupo.
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
      if v_lot.household_id <> v_primero.household_id
         or v_lot.ingredient_id is distinct from v_primero.ingredient_id
         or v_lot.product_id is distinct from v_primero.product_id
         or v_lot.unit <> v_primero.unit
         or v_lot.weight_basis <> v_primero.weight_basis
         or v_lot.processing_state <> v_primero.processing_state
         or v_lot.temperature_state <> v_primero.temperature_state
         or v_lot.vacuum_sealed <> v_primero.vacuum_sealed then
        raise exception 'esos lotes no se pueden unir: estado, alimento o base incompatibles';
      end if;
    end if;
    v_total := v_total + v_lot.quantity;
    if v_lot.acquisition_value is null then
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
    (select max(l.thawed_at) from public.inventory_lots l where l.id = any(v_ids)),
    (select min(l.frozen_at) from public.inventory_lots l where l.id = any(v_ids)),
    v_primero.vacuum_sealed,
    v_primero.location_id,
    (select min(l.expiry_date) from public.inventory_lots l where l.id = any(v_ids)),
    (select min(l.use_by) from public.inventory_lots l where l.id = any(v_ids)),
    case when v_hay_valor and v_valor is not null then v_valor else null end, v_member
  ) returning id into v_nuevo;

  foreach v_id in array v_ids loop
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, group_id, actor_member_id)
    select v_primero.household_id, v_id, 'MERGE', -l.quantity, v_group, v_member
    from public.inventory_lots l where l.id = v_id;
    -- El valor viaja con la comida: el origen deja de valer lo que entregó.
    update public.inventory_lots set acquisition_value = null where id = v_id;
  end loop;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, group_id, actor_member_id)
  values (v_primero.household_id, v_nuevo, 'MERGE', v_total, v_group, v_member);

  return v_nuevo;
end;
$$;

-- ---------------------------------------------------------------------------
-- [D-1] Una comida con porciones SERVIDAS o CONSUMIDAS no se borra: eso
-- arrastraba por cascada porciones, consumos y sustituciones ya ocurridas.
-- ---------------------------------------------------------------------------

create or replace function app.protect_served_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.member_serving_projections
    where assignment_id = old.id and status in ('SERVED', 'CONSUMED')
  ) then
    raise exception
      'Esta comida ya se sirvió: su historia no se borra.'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists meal_assignments_protect_served on public.meal_assignments;
create trigger meal_assignments_protect_served
  before delete on public.meal_assignments
  for each row execute function app.protect_served_assignment();

-- ---------------------------------------------------------------------------
-- [D-2 / I-2] Las porciones dejan de ser escribibles desde el cliente. Con la
-- policy FOR ALL, cualquier integrante podía reescribir por PostgREST el
-- ingrediente congelado, el estado o el event_effect de una porción — o
-- BORRAR la porción CONSUMED que ancla la idempotencia del consumo físico.
-- Lectura sí; escritura solo por los RPC que validan y estampan.
-- ---------------------------------------------------------------------------

drop policy if exists servings_all on public.member_serving_projections;
create policy servings_select on public.member_serving_projections
  for select to authenticated using (app.can_access_member(member_id));

drop policy if exists serving_components_all on public.member_serving_components;
create policy serving_components_select on public.member_serving_components
  for select to authenticated
  using (exists (select 1 from public.member_serving_projections p
                 where p.id = projection_id and app.can_access_member(p.member_id)));

-- ---------------------------------------------------------------------------
-- [G-3] meal_participants es SECURITY DEFINER y estaba expuesta como RPC sin
-- comprobación: cualquiera podía enumerar quién come en una comida ajena.
-- ---------------------------------------------------------------------------

create or replace function public.meal_participants(p_assignment_id uuid)
returns table (member_id uuid) language plpgsql stable security definer
set search_path = public as $$
declare v_household uuid;
begin
  v_household := app.assignment_household(p_assignment_id);
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  return query
  select coalesce(p.member_id, m.id) as member_id
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans w on w.id = d.plan_id
  left join public.meal_assignment_participants p on p.assignment_id = a.id
  left join public.household_members m
    on m.household_id = w.household_id and m.is_active
   and not exists (select 1 from public.meal_assignment_participants x
                   where x.assignment_id = a.id)
  where a.id = p_assignment_id
    and coalesce(p.member_id, m.id) is not null;
end;
$$;
