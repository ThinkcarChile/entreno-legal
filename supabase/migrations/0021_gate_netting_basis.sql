-- Integration Gate 0→10 — tanda 4: el neteo lista↔proveedor respeta la base física.
--
--  [S-2] El índice único de sugerencias era (list_id, ingredient_id): una sola
--        sugerencia por alimento aunque el motor recomiende por
--        alimento::unidad::base. La sugerencia DRAINED pisaba a la RAW.
--  [P-1] `create_procurement_order` revalidaba solo la mitad del neteo (lo en
--        camino). La otra mitad —lo pendiente en la lista de compras— se
--        aceptaba tal como lo vio una pantalla posiblemente vieja: aprobar
--        desde una pestaña abierta ayer pedía al proveedor lo que la lista ya
--        pide en el súper.
--
-- No modifica migraciones congeladas.

-- ---------------------------------------------------------------------------
-- 1. [S-2] Una sugerencia por alimento::unidad::base, no por alimento
-- ---------------------------------------------------------------------------

-- Ensanchar la clave no puede chocar: la clave vieja era un subconjunto.
drop index if exists shopping_items_suggestion_uniq;
create unique index shopping_items_suggestion_uniq
  on public.shopping_list_items (list_id, ingredient_id, unit, purchase_basis)
  where source not in ('FOOD_PLAN', 'MANUAL') and ingredient_id is not null;

-- ---------------------------------------------------------------------------
-- 2. [P-1] create_procurement_order v2: revalida AMBOS ejes del neteo
-- ---------------------------------------------------------------------------
--
-- Idéntica a la de 0014 MÁS la guarda `known_pending_in_list`: si el item trae
-- lo que la pantalla vio pendiente en la lista, se compara contra lo VIVO. La
-- misma regla que ya existía para `known_incoming` — el hueco era la asimetría.

create or replace function public.create_procurement_order(
  p_household_id           uuid,
  p_supplier_id            uuid,
  p_order_date             date,
  p_expected_delivery_date date,
  p_dedupe_key             text,
  p_engine_version         text,
  p_items                  jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_order uuid;
  v_member uuid;
  v_item jsonb;
  v_sp public.supplier_products;
  v_sp_id uuid;
  v_supplier_name text;
  v_live_incoming numeric;
  v_known numeric;
  v_live_pending numeric;
begin
  if not app.can_manage_shopping(p_household_id) then raise exception 'no autorizado'; end if;
  if p_supplier_id is not null then
    select name into v_supplier_name from public.suppliers s
    where s.id = p_supplier_id and s.household_id = p_household_id;
    if v_supplier_name is null then
      raise exception 'el proveedor no pertenece a este hogar';
    end if;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'una orden necesita al menos un producto';
  end if;
  if p_order_date is not null and p_order_date < app.household_today(p_household_id) then
    raise exception 'La sugerencia quedó desactualizada (fecha de pedido pasada): recarga la página.';
  end if;

  -- Idempotencia (§22): mismo dedupe_key = misma orden VIVA de ESTE hogar.
  if p_dedupe_key is not null then
    select id into v_order from public.procurement_orders
    where dedupe_key = p_dedupe_key and household_id = p_household_id
      and status <> 'CANCELLED';
    if v_order is not null then return v_order; end if;
  end if;

  v_member := app.current_member_id(p_household_id);

  begin
    insert into public.procurement_orders
      (household_id, supplier_id, supplier_name, status, order_date,
       expected_delivery_date, dedupe_key, engine_version, created_by)
    values
      (p_household_id, p_supplier_id, v_supplier_name, 'PLANNED', p_order_date,
       p_expected_delivery_date, p_dedupe_key, p_engine_version, v_member)
    returning id into v_order;
  exception when unique_violation then
    select id into v_order from public.procurement_orders
    where dedupe_key = p_dedupe_key and household_id = p_household_id
      and status <> 'CANCELLED';
    if v_order is not null then return v_order; end if;
    raise exception 'no autorizado';
  end;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if not app.ingredient_in_scope((v_item->>'ingredient_id')::uuid, p_household_id) then
      raise exception 'el alimento "%" no pertenece a este hogar', v_item->>'label';
    end if;
    perform app.assert_finite((v_item->>'required_quantity')::numeric, 'la necesidad');
    perform app.assert_finite((v_item->>'suggested_quantity')::numeric, 'lo sugerido');

    v_sp := null;
    v_sp_id := nullif(v_item->>'supplier_product_id', '')::uuid;
    if v_sp_id is not null then
      select sp.* into v_sp
      from public.supplier_products sp
      join public.suppliers s on s.id = sp.supplier_id
      where sp.id = v_sp_id and s.household_id = p_household_id;
      if v_sp.id is null then
        raise exception 'no autorizado';
      end if;
      if p_supplier_id is not null and v_sp.supplier_id <> p_supplier_id then
        raise exception 'la presentación no es del proveedor de la orden';
      end if;
      if v_sp.ingredient_id <> (v_item->>'ingredient_id')::uuid
         or v_sp.unit <> (v_item->>'unit') then
        raise exception 'la presentación no corresponde al producto "%"', v_item->>'label';
      end if;
    end if;

    -- Anti-doble-aprobación, eje 1: lo VIVO en camino para este alimento(+base)
    -- debe calzar con lo que vio quien aprueba.
    if v_item ? 'known_incoming' then
      v_known := (v_item->>'known_incoming')::numeric;
      select coalesce(sum(i.suggested_quantity), 0) into v_live_incoming
      from public.procurement_order_items i
      join public.procurement_orders o on o.id = i.order_id
      where o.household_id = p_household_id
        and o.id <> v_order
        and o.status in ('PLANNED', 'ORDERED', 'READY', 'DELIVERING')
        and i.ingredient_id = (v_item->>'ingredient_id')::uuid
        and i.unit = (v_item->>'unit')
        and i.weight_basis = coalesce(v_item->>'weight_basis', 'RAW')::public.weight_basis;
      if abs(v_live_incoming - coalesce(v_known, 0)) > 0.001 then
        raise exception 'La página quedó desactualizada (hay otra orden en camino): recarga antes de aprobar.';
      end if;
    end if;

    -- Gate 0→10 [P-1], eje 2: lo PENDIENTE en la lista de compras también es
    -- parte del neteo que la pantalla mostró. Si cambió (alguien agregó o
    -- compró en el súper), la aprobación vieja pediría al proveedor una
    -- necesidad que ya está cubierta — o al revés.
    if v_item ? 'known_pending_in_list' then
      v_known := (v_item->>'known_pending_in_list')::numeric;
      select coalesce(sum(coalesce(li.planned_quantity, li.required_quantity, 0)), 0)
      into v_live_pending
      from public.shopping_list_items li
      join public.shopping_lists sl on sl.id = li.list_id
      where sl.household_id = p_household_id
        and sl.status in ('DRAFT', 'ACTIVE')
        and li.status = 'PENDING'
        and li.ingredient_id = (v_item->>'ingredient_id')::uuid
        and li.unit = (v_item->>'unit')
        and (case when li.purchase_basis = 'DRAINED' then 'DRAINED' else 'RAW' end)
            = coalesce(v_item->>'weight_basis', 'RAW');
      if abs(v_live_pending - coalesce(v_known, 0)) > 0.001 then
        raise exception 'La página quedó desactualizada (la lista de compras cambió): recarga antes de aprobar.';
      end if;
    end if;

    insert into public.procurement_order_items
      (order_id, ingredient_id, supplier_product_id, label, presentation,
       required_quantity, suggested_quantity, unit, weight_basis, package_count, provenance)
    values
      (v_order,
       (v_item->>'ingredient_id')::uuid,
       v_sp_id,
       v_item->>'label',
       v_sp.presentation,
       (v_item->>'required_quantity')::numeric,
       (v_item->>'suggested_quantity')::numeric,
       v_item->>'unit',
       coalesce(v_item->>'weight_basis', 'RAW')::public.weight_basis,
       nullif(v_item->>'package_count', '')::int,
       coalesce(v_item->'provenance', '[]'::jsonb));
  end loop;

  insert into public.procurement_order_events (order_id, from_status, to_status, actor_member_id)
  values (v_order, null, 'PLANNED', v_member);

  return v_order;
end;
$$;
