-- Integration Gate 0→10 — tanda 5: la identidad por PRODUCTO llega al ledger.
--
--  [I-1] Un componente puede ser un producto comercial (meal_slot_components
--        obliga a exactamente un target; member_serving_components congela
--        ingredient_id O product_id). El ShoppingEngine lo respeta y
--        receive_purchase crea el lote con product_id e ingredient_id NULL.
--        Pero `consume_planned_meal` iteraba SOLO `ingredient_id is not null`:
--        la porción del producto se comía, el lote quedaba intacto y NO se
--        registraba ni movimiento ni faltante. Falsificación silenciosa de la
--        física — exactamente lo que el gate existe para impedir.
--
-- No modifica migraciones congeladas.

-- Linaje del faltante cuando la identidad es un producto (aditiva).
alter table public.consumption_shortfalls
  add column if not exists product_id uuid
    references public.commercial_products (id) on delete set null;

-- ---------------------------------------------------------------------------
-- consume_planned_meal v4: misma función que la v3 de 0013, con DOS cambios:
--  1. el loop de componentes toma también los de identidad producto;
--  2. el match de lotes usa LA identidad del componente (producto o alimento).
-- La conversión cocido→crudo sigue siendo solo para alimentos: los
-- rendimientos están anotados por ingrediente, y para un producto no hay
-- factor — sin factor no hay conversión, el faltante se declara.
-- ---------------------------------------------------------------------------

create or replace function public.consume_planned_meal(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_member uuid;
  v_today date;
  v_proj record;
  v_comp record;
  v_lot record;
  v_log uuid;
  v_pendiente numeric;
  v_toma numeric;
  v_factor numeric;
  v_count int := 0;
  v_shortfalls jsonb := '[]'::jsonb;
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
  -- El día del HOGAR, no el de la sesión: a las 22:30 de Santiago un lote
  -- que vence mañana todavía sirve.
  select (now() at time zone coalesce(h.timezone, 'America/Santiago'))::date
  into v_today
  from public.households h where h.id = v_household;

  for v_proj in
    select * from public.member_serving_projections
    where assignment_id = p_assignment_id and status = 'PLANNED'
  loop
    insert into public.consumption_logs
      (household_id, member_id, assignment_id, projection_id, kind, logged_by)
    values (v_household, v_proj.member_id, p_assignment_id, v_proj.id, 'PLANNED', v_member)
    on conflict (projection_id) where projection_id is not null do nothing
    returning id into v_log;

    if v_log is null then continue; end if;

    update public.member_serving_projections
    set status = 'CONSUMED' where id = v_proj.id;

    for v_comp in
      select * from public.member_serving_components
      where projection_id = v_proj.id
        -- Gate 0→10 [I-1]: antes solo `ingredient_id is not null`. Los
        -- componentes de producto comercial se saltaban en silencio.
        and (ingredient_id is not null or product_id is not null)
        and proposed_quantity > 0
    loop
      v_pendiente := v_comp.proposed_quantity;

      for v_lot in
        select l.* from public.inventory_lots l
        where l.household_id = v_household
          -- LA identidad del componente: producto contra producto, alimento
          -- contra alimento. Nunca la una a cuenta de la otra.
          and (case
                 when v_comp.product_id is not null
                   then l.product_id = v_comp.product_id
                 else l.ingredient_id = v_comp.ingredient_id
               end)
          and l.unit = v_comp.unit::text
          and l.weight_basis = v_comp.weight_basis
          and l.status = 'AVAILABLE' and l.quantity > 0
          -- vencido = no usable, igual que en Stock Intelligence
          and (coalesce(l.use_by, l.expiry_date) is null
               or coalesce(l.use_by, l.expiry_date) >= v_today)
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

      -- Conversión explícita cocido→crudo: SOLO con identidad de alimento
      -- (los rendimientos se anotan por ingrediente).
      if v_pendiente > 0 and v_comp.weight_basis = 'COOKED'
         and v_comp.ingredient_id is not null then
        select y.yield_factor into v_factor
        from public.ingredient_yields y
        where y.ingredient_id = v_comp.ingredient_id
          and (y.household_id is null or y.household_id = v_household)
          and (y.cooking_method is null or y.cooking_method = v_comp.cooking_method)
        order by (y.household_id is not null) desc, (y.cooking_method is not null) desc
        limit 1;

        if v_factor is not null and v_factor > 0 then
          for v_lot in
            select l.* from public.inventory_lots l
            where l.household_id = v_household
              and l.ingredient_id = v_comp.ingredient_id
              and l.unit = v_comp.unit::text
              and l.weight_basis = 'RAW'
              and l.status = 'AVAILABLE' and l.quantity > 0
              and (coalesce(l.use_by, l.expiry_date) is null
                   or coalesce(l.use_by, l.expiry_date) >= v_today)
            order by l.use_by asc nulls last, l.expiry_date asc nulls last, l.created_at asc
          loop
            exit when v_pendiente <= 0;
            v_toma := least(v_pendiente / v_factor, v_lot.quantity);
            insert into public.inventory_movements
              (household_id, lot_id, reason, delta, idempotency_key,
               consumption_log_id, actor_member_id, notes)
            values
              (v_household, v_lot.id, 'CONSUMED', -v_toma,
               'CONSUME:' || v_proj.id::text || ':' || v_comp.id::text || ':' || v_lot.id::text,
               v_log, v_member,
               'conversión explícita cocido→crudo ×' || v_factor::text);
            v_pendiente := v_pendiente - (v_toma * v_factor);
          end loop;
        end if;
      end if;

      if v_pendiente > 0.001 then
        insert into public.consumption_shortfalls
          (household_id, consumption_log_id, assignment_id, projection_id,
           ingredient_id, product_id, label, quantity, unit, weight_basis, serving_date)
        values
          (v_household, v_log, p_assignment_id, v_proj.id,
           v_comp.ingredient_id, v_comp.product_id, v_comp.label, round(v_pendiente, 3),
           v_comp.unit::text, v_comp.weight_basis, v_proj.serving_date);

        v_shortfalls := v_shortfalls || jsonb_build_object(
          'label', v_comp.label,
          'quantity', round(v_pendiente, 3),
          'unit', v_comp.unit::text,
          'weight_basis', v_comp.weight_basis::text
        );
      end if;
    end loop;

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    update public.meal_assignments set status = 'SERVED' where id = p_assignment_id;
  end if;

  return jsonb_build_object('servings', v_count, 'shortfalls', v_shortfalls);
end;
$$;
