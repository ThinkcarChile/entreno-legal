-- Integration Gate 0→10 — FINAL CLOSURE §6: UNKNOWN NUNCA SIGNIFICA NORMAL.
--
--  [U-4 MEDIO] La porción confirmada congelaba `unmet_constraints` pero
--  DESCARTABA `unverifiable_constraints`: un techo de calorías que quedó SIN
--  VERIFICAR (ficha incompleta) se volvía estructuralmente indistinguible de
--  "todos los límites verificados". El desconocido debe congelarse COMO
--  desconocido — es la regla que Sprint 11 hereda.
--
--  [C-1 MEDIO] `create_procurement_order` con p_dedupe_key NULL no tenía
--  idempotencia ALGUNA (el índice único es parcial `where dedupe_key is not
--  null`): dos aprobaciones paralelas = dos órdenes vivas. La clave pasa a
--  ser obligatoria.
--
--  confirm v6 = v5 de 0023 + persistir unverifiable_constraints.
--  create_procurement_order v3 = v2 de 0021 + dedupe obligatorio.
--
-- No modifica migraciones congeladas.

alter table public.member_serving_projections
  add column if not exists unverifiable_constraints jsonb not null default '[]'::jsonb;

comment on column public.member_serving_projections.unverifiable_constraints is
  'Límites que NO se pudieron verificar por ficha incompleta (ENERGY_MAX, '
  'PROTEIN_MIN). Ni cumplidos ni incumplidos: desconocidos, y se congelan así.';

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
  v_intrusos text;
  v_servidas int;
  v_member_id uuid;
begin
  -- Gate final §2: candado sobre LA asignación antes de leer su estado
  -- físico. La guarda §13 era una lectura no serializada: dos confirmaciones
  -- simultáneas (o confirmar mientras se consume) podían ambas ver "0
  -- servidas", y la segunda borraba porciones que la primera ya había hecho
  -- historia. Con el lock, la segunda ESPERA y ve la verdad.
  select p.household_id into v_household
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  where a.id = p_assignment_id
  for update of a;

  if v_household is null then raise exception 'asignación inexistente'; end if;
  if not app.is_household_member(v_household) then raise exception 'no autorizado'; end if;

  v_member := app.current_member_id(v_household);

  -- §13: una porción ya servida o consumida es historia. Reconfirmar no la pisa.
  select count(*) into v_servidas
  from public.member_serving_projections
  where assignment_id = p_assignment_id and status in ('SERVED', 'CONSUMED');

  if v_servidas > 0 then
    raise exception
      'Esta comida ya se sirvió: sus porciones son historia y no se reescriben. Registra el consumo real en vez de reconfirmar.'
      using errcode = 'check_violation';
  end if;

  -- §2: solo se guardan porciones de quienes participan de esta comida.
  select string_agg(distinct s.value->>'member_id', ', ')
  into v_intrusos
  from jsonb_array_elements(coalesce(p_servings, '[]'::jsonb)) as s
  where (s.value->>'member_id')::uuid not in (
    select member_id from public.meal_participants(p_assignment_id)
  );

  if v_intrusos is not null then
    raise exception 'Hay porciones de personas que no participan de esta comida: %', v_intrusos
      using errcode = 'check_violation';
  end if;

  -- §0B: el conjunto de participantes se resuelve AHORA y se congela.
  insert into public.meal_assignment_participants (assignment_id, member_id)
  select p_assignment_id, mp.member_id
  from public.meal_participants(p_assignment_id) mp
  on conflict do nothing;

  delete from public.member_serving_projections where assignment_id = p_assignment_id;

  for v_serving in select * from jsonb_array_elements(coalesce(p_servings, '[]'::jsonb)) loop
    v_member_id := (v_serving->>'member_id')::uuid;

    -- Hardening 3: cada UUID del cliente pertenece al hogar o es global.
    if not app.version_in_scope((v_serving->>'version_id')::uuid, v_household) then
      raise exception 'la versión de receta no pertenece a este hogar';
    end if;
    if v_serving->>'profile_id' is not null and not exists (
      select 1 from public.member_nutrition_profiles np
      where np.id = (v_serving->>'profile_id')::uuid and np.member_id = v_member_id
    ) then
      raise exception 'el perfil nutricional no pertenece a este integrante';
    end if;
    if nullif(v_serving->>'daily_plan_id', '') is not null and not exists (
      select 1 from public.member_daily_nutrition_plans dp
      where dp.id = (v_serving->>'daily_plan_id')::uuid and dp.member_id = v_member_id
    ) then
      raise exception 'la excepción del día no pertenece a este integrante';
    end if;

    insert into public.member_serving_projections (
      member_id, version_id, profile_id, daily_plan_id, optimizer_version,
      meal_type, serving_date, fit, adaptation_level, score,
      nutrition, completeness, reasons, unmet_constraints, unverifiable_constraints,
      assignment_id, status, event_effect
    ) values (
      v_member_id,
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
      coalesce(v_serving->'unverifiable_constraints', '[]'::jsonb),
      p_assignment_id,
      'PLANNED',
      case when v_serving->'event_effect' = 'null'::jsonb then null
           else v_serving->'event_effect' end
    ) returning id into v_projection;

    for v_component in select * from jsonb_array_elements(coalesce(v_serving->'components', '[]'::jsonb)) loop
      -- Hardening 1: sin unidad o sin base de peso NO hay valor por defecto.
      -- Convertir "no sé" en 'G'/'RAW' es inventar un dato de compra.
      if nullif(v_component->>'unit', '') is null then
        raise exception 'componente "%" sin unidad: una porción confirmada no adivina', v_component->>'label';
      end if;
      if nullif(v_component->>'weight_basis', '') is null then
        raise exception 'componente "%" sin base de peso (crudo/cocido): una porción confirmada no adivina', v_component->>'label';
      end if;

      -- Hardening 3: identidad del alimento dentro del ámbito.
      if not app.ingredient_in_scope(nullif(v_component->>'ingredient_id', '')::uuid, v_household) then
        raise exception 'el alimento "%" no pertenece a este hogar', v_component->>'label';
      end if;
      if not app.product_in_scope(nullif(v_component->>'product_id', '')::uuid, v_household) then
        raise exception 'el producto "%" no pertenece a este hogar', v_component->>'label';
      end if;

      insert into public.member_serving_components (
        projection_id, component_id, label, base_quantity, proposed_quantity,
        unit, weight_basis, cooking_method, added_fat_g, substituted_for, sort_order,
        ingredient_id, product_id
      ) values (
        v_projection,
        nullif(v_component->>'component_id', '')::uuid,
        v_component->>'label',
        (v_component->>'base_quantity')::numeric,
        (v_component->>'proposed_quantity')::numeric,
        (v_component->>'unit')::public.nutrition_basis_unit,
        (v_component->>'weight_basis')::public.weight_basis,
        (nullif(v_component->>'cooking_method', ''))::public.cooking_method,
        (v_component->>'added_fat_g')::numeric,
        nullif(v_component->>'substituted_for', '')::uuid,
        coalesce((v_component->>'sort_order')::int, 1),
        nullif(v_component->>'ingredient_id', '')::uuid,
        nullif(v_component->>'product_id', '')::uuid
      );
    end loop;

    for v_sub in select * from jsonb_array_elements(coalesce(v_serving->'substitutions', '[]'::jsonb)) loop
      if not app.ingredient_in_scope((v_sub->>'to_ingredient_id')::uuid, v_household)
         or not app.ingredient_in_scope(nullif(v_sub->>'from_ingredient_id', '')::uuid, v_household) then
        raise exception 'un reemplazo referencia un alimento de otro hogar';
      end if;
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

  -- §12: queda registrado que hubo reconfirmación, y cuántas.
  update public.meal_assignments
  set status = 'CONFIRMED',
      confirmed_at = coalesce(confirmed_at, now()),
      last_confirmed_at = now(),
      confirm_count = confirm_count + 1,
      confirmed_by = v_member,
      needs_review = false,
      review_reason = null
  where id = p_assignment_id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_household, auth.uid(), 'MEAL_CONFIRMED', 'meal_assignment', p_assignment_id,
          jsonb_build_object('servings', v_count));

  insert into public.domain_events (household_id, event_type, aggregate, payload, scope, dedupe_key)
  select v_household, 'MEAL_CONFIRMED', 'meal_assignment',
         jsonb_build_object('assignment_id', p_assignment_id, 'servings', v_count,
                            'confirm_count', a.confirm_count),
         jsonb_build_object('assignment_id', p_assignment_id),
         'MEAL_CONFIRMED:' || p_assignment_id::text || ':' || a.confirm_count::text
  from public.meal_assignments a where a.id = p_assignment_id
  on conflict (dedupe_key) do nothing;

  return v_count;
end;
$$;

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
  -- Gate final §6/§15 [C-1]: sin clave de dedupe NO hay idempotencia — dos
  -- aprobaciones paralelas crearían dos órdenes vivas idénticas y el índice
  -- único parcial no las ve. La clave es obligatoria: quien llama la deriva
  -- de la sugerencia (la app ya lo hace); NULL era un agujero, no una opción.
  if p_dedupe_key is null or length(trim(p_dedupe_key)) = 0 then
    raise exception 'una orden necesita su clave de idempotencia (dedupe_key)';
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
