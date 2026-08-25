-- Integration Gate 0→10 — FINAL CLOSURE §2: la guarda de historia se serializa.
--
--  [ALTO residual 1] `confirm_meal_assignment` leía "¿hay porciones
--  SERVED/CONSUMED?" sin candado: dos confirmaciones simultáneas podían ambas
--  ver cero, y la segunda borraba y reescribía porciones que la primera (o un
--  consumo en paralelo) ya había convertido en historia. Lo mismo al revés:
--  consumir mientras otro confirmaba.
--
--  Cierre: ambos RPC toman `for update` sobre LA MISMA fila de
--  `meal_assignments` ANTES de leer o tocar el estado físico. El segundo en
--  llegar espera y decide con la verdad. Además, los dos recorridos FEFO de
--  lotes del consumo toman `for update of l`: dos consumos de comidas
--  DISTINTAS ya no pueden sobregirar el mismo lote (MEDIO de la lente I).
--
--  confirm v5 = v4 de 0010 + candado (ninguna otra línea cambia).
--  consume v5 = v4 de 0022 + candados (ninguna otra línea cambia).
--
-- No modifica migraciones congeladas.

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
      nutrition, completeness, reasons, unmet_constraints,
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
  -- Gate final §2/§15: mismo candado que confirm_meal_assignment v5 — los
  -- dos RPC serializan sobre LA MISMA fila, así que consumir mientras se
  -- confirma (o dos consumos a la vez) ya no corre en paralelo.
  select p.household_id into v_household
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  where a.id = p_assignment_id
  for update of a;

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
        -- Dos consumos de comidas DISTINTAS compiten por el mismo lote: sin
        -- lock ambos leen la misma cantidad y el lote queda sobregirado.
        for update of l
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
            for update of l
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
