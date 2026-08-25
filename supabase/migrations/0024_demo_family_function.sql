-- Integration Gate 0→10 — FINAL CLOSURE §3: la función demo es schema real.
--
--  [ALTO residual 2] `seed_demo_family_profiles` vivía en un archivo de SEED
--  que el arnés cargaba como si fuera parte del schema — pero la APLICACIÓN
--  la llama (`loadDemoFamily` → rpc), así que en Supabase existía solo porque
--  el seed se corrió a mano. Regla del director: schema de test == schema
--  producible mediante migraciones; un seed de demo no puede esconder una
--  dependencia de producción.
--
--  Cierre: la función pasa a migración (un solo dueño). El seed queda como
--  puntero, el arnés ya no lo carga, y una regresión de paridad levanta la
--  base SOLO con migraciones y exige que todo `.rpc()` y `.from()` de la app
--  exista. NO inserta datos: sigue siendo una función que la familia invoca
--  desde la app, con su hogar.
--
-- Idéntica línea a línea a la del seed (solo cambia el dueño del archivo).

create or replace function public.seed_demo_family_profiles(p_household_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_francisco uuid;
  v_paula uuid;
  v_sebastian uuid;
  v_constanza uuid;
  v_ricardo uuid;
  v_pollo uuid;
  v_merluza uuid;
  v_pattern uuid;
  v_created int := 0;
begin
  if not app.is_household_member(p_household_id) then
    raise exception 'no autorizado';
  end if;

  -- El integrante que ya existe (quien creó el hogar) hace de Francisco.
  select id into v_francisco from public.household_members
  where household_id = p_household_id and user_id = auth.uid() limit 1;
  if v_francisco is null then
    raise exception 'el hogar no tiene un integrante asociado a tu cuenta';
  end if;

  select id into v_paula from public.household_members
  where household_id = p_household_id and display_name = 'Paula';
  if v_paula is null then
    insert into public.household_members (household_id, display_name, sex)
    values (p_household_id, 'Paula', 'F') returning id into v_paula;
    v_created := v_created + 1;
  end if;

  select id into v_sebastian from public.household_members
  where household_id = p_household_id and display_name = 'Sebastián';
  if v_sebastian is null then
    insert into public.household_members (household_id, display_name, sex)
    values (p_household_id, 'Sebastián', 'M') returning id into v_sebastian;
    v_created := v_created + 1;
  end if;

  select id into v_constanza from public.household_members
  where household_id = p_household_id and display_name = 'Constanza';
  if v_constanza is null then
    insert into public.household_members (household_id, display_name, sex)
    values (p_household_id, 'Constanza', 'F') returning id into v_constanza;
    v_created := v_created + 1;
  end if;

  select id into v_ricardo from public.household_members
  where household_id = p_household_id and display_name = 'Ricardo';
  if v_ricardo is null then
    insert into public.household_members (household_id, display_name, sex)
    values (p_household_id, 'Ricardo', 'M') returning id into v_ricardo;
    v_created := v_created + 1;
  end if;

  select id into v_pollo from public.ingredients
  where canonical_name = 'pechuga de pollo sin piel' and household_id is null;
  select id into v_merluza from public.ingredients
  where canonical_name = 'merluza' and household_id is null;

  -- ==== Tracking =========================================================
  insert into public.member_tracking_settings (member_id, mode) values
    (v_francisco, 'FULL'),
    (v_paula,     'OFF'),
    (v_sebastian, 'BASIC'),
    (v_constanza, 'BASIC'),
    (v_ricardo,   'OFF')
  on conflict (member_id) do update set mode = excluded.mode, updated_at = now();

  -- ==== Francisco: objetivos, ayuno y preparación =========================
  delete from public.nutrition_goals where member_id = v_francisco;
  insert into public.nutrition_goals
    (member_id, goal_type, scope, meal_type, minimum, preferred, maximum, unit, priority)
  values
    (v_francisco, 'PROTEIN_G',   'DAILY',    null,    120, 130,  null, 'g',    10),
    (v_francisco, 'PROTEIN_G',   'PER_MEAL', 'LUNCH',  50,  65,    80, 'g',    10),
    (v_francisco, 'ENERGY_KCAL', 'PER_MEAL', 'LUNCH', null, null, 800, 'kcal', 20);

  delete from public.meal_patterns where member_id = v_francisco;
  insert into public.meal_patterns (member_id, uses_fasting_pattern, first_meal_type)
  values (v_francisco, true, 'LUNCH') returning id into v_pattern;
  insert into public.meal_pattern_slots
    (pattern_id, meal_type, availability, is_first_meal, salad_preference, sort_order)
  values
    (v_pattern, 'BREAKFAST', 'DISABLED', false, 'NEUTRAL',   1),
    (v_pattern, 'LUNCH',     'ENABLED',  true,  'PREFERRED', 2),
    (v_pattern, 'TEA',       'ENABLED',  false, 'NEUTRAL',   3),
    (v_pattern, 'DINNER',    'ENABLED',  false, 'NEUTRAL',   4);

  delete from public.member_cooking_preferences where member_id = v_francisco;
  if v_pollo is not null then
    insert into public.member_cooking_preferences (member_id, ingredient_id, cooking_method, stance)
    values (v_francisco, v_pollo, 'AIR_FRYER', 'PREFERRED');
  end if;
  if v_merluza is not null then
    insert into public.member_cooking_preferences (member_id, ingredient_id, cooking_method, stance)
    values (v_francisco, v_merluza, 'STEWED', 'PREFERRED');
  end if;
  insert into public.member_cooking_preferences (member_id, cooking_method, stance)
  values (v_francisco, 'FRIED', 'AVOID');

  insert into public.member_added_fat_preferences (member_id, stance)
  values (v_francisco, 'AVOID')
  on conflict (member_id) do update set stance = excluded.stance;

  -- ==== Paula: sin objetivos, y eso está bien (§10) =======================
  delete from public.nutrition_goals where member_id = v_paula;
  delete from public.meal_patterns where member_id = v_paula;
  insert into public.meal_patterns (member_id) values (v_paula) returning id into v_pattern;
  insert into public.meal_pattern_slots (pattern_id, meal_type, availability, sort_order) values
    (v_pattern, 'BREAKFAST', 'ENABLED', 1),
    (v_pattern, 'LUNCH',     'ENABLED', 2),
    (v_pattern, 'TEA',       'ENABLED', 3),
    (v_pattern, 'DINNER',    'ENABLED', 4);
  insert into public.member_added_fat_preferences (member_id, stance)
  values (v_paula, 'ALLOWED') on conflict (member_id) do nothing;

  -- ==== Sebastián: mismo plato, otra preparación =========================
  delete from public.nutrition_goals where member_id = v_sebastian;
  insert into public.nutrition_goals
    (member_id, goal_type, scope, meal_type, minimum, preferred, maximum, unit, priority)
  values (v_sebastian, 'PROTEIN_G', 'PER_MEAL', 'LUNCH', 45, 60, 90, 'g', 10);

  delete from public.meal_patterns where member_id = v_sebastian;
  insert into public.meal_patterns (member_id) values (v_sebastian) returning id into v_pattern;
  insert into public.meal_pattern_slots (pattern_id, meal_type, availability, sort_order) values
    (v_pattern, 'BREAKFAST', 'ENABLED', 1),
    (v_pattern, 'LUNCH',     'ENABLED', 2),
    (v_pattern, 'DINNER',    'ENABLED', 3);

  delete from public.member_cooking_preferences where member_id = v_sebastian;
  if v_pollo is not null then
    insert into public.member_cooking_preferences (member_id, ingredient_id, cooking_method, stance)
    values (v_sebastian, v_pollo, 'FRIED', 'PREFERRED');
  end if;
  if v_merluza is not null then
    insert into public.member_cooking_preferences (member_id, ingredient_id, cooking_method, stance)
    values (v_sebastian, v_merluza, 'FRIED', 'PREFERRED');
  end if;
  insert into public.member_added_fat_preferences (member_id, stance)
  values (v_sebastian, 'ALLOWED')
  on conflict (member_id) do update set stance = excluded.stance;

  -- ==== Constanza y Ricardo ==============================================
  delete from public.meal_patterns where member_id in (v_constanza, v_ricardo);
  insert into public.meal_patterns (member_id) values (v_constanza) returning id into v_pattern;
  insert into public.meal_pattern_slots (pattern_id, meal_type, availability, sort_order) values
    (v_pattern, 'BREAKFAST', 'ENABLED', 1), (v_pattern, 'LUNCH', 'ENABLED', 2),
    (v_pattern, 'TEA', 'ENABLED', 3), (v_pattern, 'DINNER', 'ENABLED', 4);
  insert into public.meal_patterns (member_id) values (v_ricardo) returning id into v_pattern;
  insert into public.meal_pattern_slots (pattern_id, meal_type, availability, sort_order) values
    (v_pattern, 'BREAKFAST', 'ENABLED', 1), (v_pattern, 'LUNCH', 'ENABLED', 2),
    (v_pattern, 'TEA', 'ENABLED', 3), (v_pattern, 'DINNER', 'ENABLED', 4);

  insert into public.member_added_fat_preferences (member_id, stance) values
    (v_constanza, 'ALLOWED'), (v_ricardo, 'ALLOWED')
  on conflict (member_id) do nothing;

  -- "No me gusta el cerdo" es SOFT: penaliza y explica, no prohíbe (§13).
  -- Se apunta a la categoría de carnes porque el catálogo de desarrollo aún no
  -- tiene un ingrediente cerdo; el tipo de preferencia es lo que importa acá.
  delete from public.member_preferences where member_id in (v_sebastian, v_constanza);

  -- ==== Excepción del día: sábado con más margen (§20) ====================
  delete from public.member_daily_nutrition_plans
  where member_id = v_francisco and plan_date = (current_date + ((6 - extract(dow from current_date)::int + 7) % 7));

  return jsonb_build_object(
    'household_id', p_household_id,
    'members_created', v_created,
    'francisco', v_francisco, 'paula', v_paula, 'sebastian', v_sebastian,
    'constanza', v_constanza, 'ricardo', v_ricardo);
end;
$$;

comment on function public.seed_demo_family_profiles(uuid) is
  'Carga la familia de demostración del Sprint 4 en un hogar existente. '
  'Datos de desarrollo, editables desde la aplicación; no son recomendaciones.';
