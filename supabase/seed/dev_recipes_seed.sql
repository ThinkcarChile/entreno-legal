-- SEED DE DESARROLLO — Sprint 3 (NO aplicar en producción sin revisión)
-- 8 recetas de demostración en la biblioteca GLOBAL, más los pocos ingredientes
-- que faltaban para armarlas. Toda la nutrición es source_type='DEV_SEED':
-- valores plausibles SOLO para validar la arquitectura. No son datos oficiales,
-- no son asesoramiento nutricional y nunca se muestran como verificados.
-- Requiere: 0001, 0002, 0003 y dev_catalog_seed.sql aplicados.

-- ---------------------------------------------------------------------------
-- Ingredientes que faltaban (papa, fideos, cilantro, limón)
-- ---------------------------------------------------------------------------

do $$
declare
  v_ing uuid;
  cats jsonb := '{}'::jsonb;
  cat record;
  src constant text := 'Seed de desarrollo — valores no oficiales';
begin
  for cat in select id, code from public.ingredient_categories loop
    cats := cats || jsonb_build_object(cat.code, cat.id::text);
  end loop;

  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('papa', 'Papa', (cats->>'VEGETABLES')::uuid)
  on conflict do nothing returning id into v_ing;
  if v_ing is not null then
    insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
      energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sodium_mg, potassium_mg, phosphorus_mg,
      source_type, source_name, notes)
    values (v_ing, 'RAW', 'G', 77, 2.0, 17.0, 0.1, 2.2, 6, 425, 57, 'DEV_SEED', src, 'demo');
  end if;

  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('fideos', 'Fideos (pasta seca)', (cats->>'GRAINS')::uuid)
  on conflict do nothing returning id into v_ing;
  if v_ing is not null then
    insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
      energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sodium_mg,
      source_type, source_name, notes)
    values (v_ing, 'RAW', 'G', 359, 12.5, 71.0, 1.5, 3.0, 6, 'DEV_SEED', src,
            'demo — potasio y fósforo desconocidos a propósito (UNKNOWN != ZERO)');
  end if;

  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('cilantro', 'Cilantro', (cats->>'VEGETABLES')::uuid)
  on conflict do nothing returning id into v_ing;
  if v_ing is not null then
    insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
      energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sodium_mg, potassium_mg,
      source_type, source_name, notes)
    values (v_ing, 'RAW', 'G', 23, 2.1, 3.7, 0.5, 2.8, 46, 521, 'DEV_SEED', src, 'demo');
  end if;

  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('limon', 'Limón', (cats->>'FRUITS')::uuid)
  on conflict do nothing returning id into v_ing;
  if v_ing is not null then
    insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
      energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sodium_mg, potassium_mg,
      source_type, source_name, notes)
    values (v_ing, 'RAW', 'G', 29, 1.1, 9.3, 0.3, 2.8, 2, 138, 'DEV_SEED', src, 'demo');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Ayudantes de sesión (pg_temp: desaparecen al cerrar la conexión)
-- ---------------------------------------------------------------------------

create or replace function pg_temp.ing(p_name text)
returns uuid language sql stable as $$
  select id from public.ingredients
  where canonical_name = p_name and household_id is null limit 1;
$$;

create or replace function pg_temp.fact(p_name text, p_basis public.weight_basis)
returns uuid language sql stable as $$
  select f.id
  from public.nutrition_facts f
  join public.ingredients i on i.id = f.ingredient_id
  where i.canonical_name = p_name and i.household_id is null and f.weight_basis = p_basis
  limit 1;
$$;

/** Crea plantilla global + versión 1 en borrador. Devuelve el id de la versión. */
create or replace function pg_temp.recipe(
  p_name text, p_kind public.template_kind, p_types public.meal_type[],
  p_servings int, p_minutes int, p_description text default null
) returns uuid language plpgsql as $$
declare v_t uuid; v_v uuid;
begin
  insert into public.meal_templates (household_id, kind, name)
  values (null, p_kind, p_name) returning id into v_t;
  insert into public.meal_template_versions
    (template_id, version_number, status, name, description, meal_types, base_servings, base_time_minutes)
  values (v_t, 1, 'DRAFT', p_name, p_description, p_types, p_servings, p_minutes)
  returning id into v_v;
  return v_v;
end $$;

create or replace function pg_temp.slot(
  p_version uuid, p_type public.meal_slot_type, p_order int,
  p_label text default null, p_required boolean default true
) returns uuid language plpgsql as $$
declare v_s uuid;
begin
  insert into public.meal_slots (version_id, slot_type, label, is_required, sort_order)
  values (p_version, p_type, p_label, p_required, p_order) returning id into v_s;
  return v_s;
end $$;

/**
 * Componente por nombre de ingrediente: resuelve su ficha para esa base.
 * La unidad SALE DE LA FICHA, no se asume gramos: el aceite se mide por 100 ml
 * y forzar 'G' haría que el motor se niegue a calcular (y con razón).
 */
create or replace function pg_temp.comp(
  p_slot uuid, p_ing text, p_basis public.weight_basis, p_qty numeric,
  p_method public.cooking_method default null, p_optional boolean default false,
  p_order int default 1, p_yield numeric default null
) returns void language plpgsql as $$
declare
  v_fact uuid;
  v_unit public.nutrition_basis_unit;
begin
  v_fact := pg_temp.fact(p_ing, p_basis);
  select basis_unit into v_unit from public.nutrition_facts where id = v_fact;

  insert into public.meal_slot_components
    (slot_id, ingredient_id, quantity, unit, weight_basis, nutrition_fact_id,
     cooking_method, is_optional, sort_order, yield_factor)
  values (p_slot, pg_temp.ing(p_ing), p_qty, coalesce(v_unit, 'G'), p_basis, v_fact,
          p_method, p_optional, p_order, p_yield);
end $$;

/** Componente que reutiliza otra receta (ensalada/postre) por VERSIÓN. */
create or replace function pg_temp.comp_nested(
  p_slot uuid, p_version uuid, p_qty numeric, p_order int default 1
) returns void language plpgsql as $$
begin
  insert into public.meal_slot_components
    (slot_id, nested_version_id, quantity, unit, weight_basis, sort_order)
  values (p_slot, p_version, p_qty, 'G', 'RAW', p_order);
end $$;

create or replace function pg_temp.alt(
  p_slot uuid, p_ing text, p_compat public.culinary_compatibility default 'GOOD',
  p_notes text default null
) returns void language plpgsql as $$
begin
  insert into public.meal_slot_alternatives (slot_id, ingredient_id, culinary_compatibility, notes)
  values (p_slot, pg_temp.ing(p_ing), p_compat, p_notes);
end $$;

create or replace function pg_temp.step(
  p_version uuid, p_n int, p_text text, p_min int default null, p_temp int default null,
  p_opt_cap text default null, p_manual text default null, p_parallel int default null
) returns void language plpgsql as $$
begin
  insert into public.recipe_steps
    (version_id, step_number, instruction, duration_minutes, temperature_c,
     optional_capability, manual_alternative, parallel_group)
  values (p_version, p_n, p_text, p_min, p_temp, p_opt_cap, p_manual, p_parallel);
end $$;

/**
 * Publica una versión global: congela la ficha usada por cada componente y
 * recién entonces marca PUBLISHED (después el trigger la vuelve inmutable).
 */
create or replace function pg_temp.publish(p_version uuid)
returns void language plpgsql as $$
begin
  update public.meal_slot_components c set
    frozen_nutrition = jsonb_build_object(
      'weight_basis', f.weight_basis,
      'basis_unit',   f.basis_unit,
      'values', jsonb_strip_nulls(jsonb_build_object(
        'energy_kcal', f.energy_kcal, 'protein_g', f.protein_g,
        'carbohydrates_g', f.carbohydrates_g, 'fat_g', f.fat_g,
        'fiber_g', f.fiber_g, 'sugars_g', f.sugars_g,
        'saturated_fat_g', f.saturated_fat_g, 'sodium_mg', f.sodium_mg,
        'potassium_mg', f.potassium_mg, 'phosphorus_mg', f.phosphorus_mg))),
    frozen_source = jsonb_build_object(
      'source_type', f.source_type, 'source_name', f.source_name,
      'verified', f.verified, 'nutrition_fact_id', f.id)
  from public.nutrition_facts f
  where f.id = c.nutrition_fact_id
    and c.slot_id in (select id from public.meal_slots where version_id = p_version);

  update public.meal_template_versions
  set status = 'PUBLISHED', published_at = now()
  where id = p_version;

  update public.meal_templates t
  set current_version_id = p_version
  where t.id = (select template_id from public.meal_template_versions where id = p_version);
end $$;

-- ---------------------------------------------------------------------------
-- Las recetas
-- ---------------------------------------------------------------------------

do $$
declare
  v_ensalada uuid; v_verde uuid;
  v_pollo uuid; v_carne uuid; v_pescado uuid; v_lentejas uuid;
  v_pasta uuid; v_pan uuid; v_postre uuid;
  s uuid;
begin
  -- 8. Ensalada chilena (reutilizable: una receta puede referenciarla) --------
  v_ensalada := pg_temp.recipe('Ensalada chilena', 'SALAD', '{LUNCH,DINNER}', 4, 15,
    'Ensalada modular reutilizable. Los aderezos son ingredientes reales: el aceite aporta calorías.');
  s := pg_temp.slot(v_ensalada, 'VEGETABLE', 1, 'Verduras');
  perform pg_temp.comp(s, 'tomate',   'RAW', 400, 'RAW', false, 1);
  perform pg_temp.comp(s, 'cebolla',  'RAW', 150, 'RAW', false, 2);
  perform pg_temp.comp(s, 'cilantro', 'RAW',  20, 'RAW', false, 3);
  s := pg_temp.slot(v_ensalada, 'FAT', 2, 'Aliño', false);
  perform pg_temp.comp(s, 'aceite de oliva', 'AS_PACKAGED', 20, null, true, 1);
  perform pg_temp.comp(s, 'limon', 'RAW', 50, 'RAW', true, 2);
  perform pg_temp.step(v_ensalada, 1, 'Cortar el tomate en gajos y la cebolla en pluma.', 10,
    null, 'FOOD_PROCESSOR', 'A cuchillo sobre tabla, en pluma fina.', 1);
  perform pg_temp.step(v_ensalada, 2, 'Lavar la cebolla en agua fría para quitarle el picor.', 3);
  perform pg_temp.step(v_ensalada, 3, 'Aliñar con aceite, limón y cilantro picado.', 2);
  perform pg_temp.publish(v_ensalada);

  -- Ensalada verde (segunda ensalada reutilizable) ---------------------------
  v_verde := pg_temp.recipe('Ensalada verde', 'SALAD', '{LUNCH,DINNER}', 4, 10, null);
  s := pg_temp.slot(v_verde, 'VEGETABLE', 1, 'Verduras');
  perform pg_temp.comp(s, 'lechuga',   'RAW', 300, 'RAW', false, 1);
  perform pg_temp.comp(s, 'zanahoria', 'RAW', 120, 'RAW', false, 2);
  s := pg_temp.slot(v_verde, 'FAT', 2, 'Aliño', false);
  perform pg_temp.comp(s, 'aceite de oliva', 'AS_PACKAGED', 15, null, true, 1);
  perform pg_temp.step(v_verde, 1, 'Lavar y cortar la lechuga; rallar la zanahoria.', 8);
  perform pg_temp.publish(v_verde);

  -- 1. Pollo con arroz y ensalada chilena ------------------------------------
  v_pollo := pg_temp.recipe('Pollo con arroz y ensalada chilena', 'MEAL', '{LUNCH}', 5, 45,
    'El plato de referencia: proteína, carbohidrato y una ensalada reutilizable.');
  s := pg_temp.slot(v_pollo, 'PROTEIN', 1);
  perform pg_temp.comp(s, 'pechuga de pollo sin piel', 'RAW', 900, 'BAKED', false, 1, 0.72);
  perform pg_temp.alt(s, 'merluza', 'GOOD', 'Reemplazo válido en el plato; la cantidad la ajusta el optimizador, no es equivalencia nutricional.');
  perform pg_temp.alt(s, 'vacuno posta magra', 'ACCEPTABLE');
  s := pg_temp.slot(v_pollo, 'CARBOHYDRATE', 2);
  perform pg_temp.comp(s, 'arroz blanco', 'RAW', 375, 'BOILED', false, 1);
  perform pg_temp.alt(s, 'papa', 'GOOD');
  s := pg_temp.slot(v_pollo, 'SALAD', 3, 'Ensalada chilena');
  perform pg_temp.comp_nested(s, v_ensalada, 570);
  perform pg_temp.step(v_pollo, 1, 'Salpimentar el pollo y hornear 25 minutos a 200 °C.', 25, 200,
    'AIR_FRYER', 'En air fryer, 18 minutos a 180 °C dando vuelta a la mitad.', 1);
  perform pg_temp.step(v_pollo, 2, 'Cocer el arroz con el doble de agua, 15 minutos.', 15, null, null, null, 1);
  perform pg_temp.step(v_pollo, 3, 'Preparar la ensalada chilena mientras se cocina el resto.', 15, null, null, null, 1);
  perform pg_temp.step(v_pollo, 4, 'Servir el pollo cortado con el arroz y la ensalada al lado.', 5);
  perform pg_temp.publish(v_pollo);

  -- 2. Carne magra con papas y ensalada --------------------------------------
  v_carne := pg_temp.recipe('Carne magra con papas y ensalada', 'MEAL', '{LUNCH,DINNER}', 4, 50, null);
  s := pg_temp.slot(v_carne, 'PROTEIN', 1);
  perform pg_temp.comp(s, 'vacuno posta magra', 'RAW', 640, 'PAN_SEARED', false, 1, 0.7);
  s := pg_temp.slot(v_carne, 'CARBOHYDRATE', 2);
  perform pg_temp.comp(s, 'papa', 'RAW', 800, 'BOILED', false, 1);
  s := pg_temp.slot(v_carne, 'SALAD', 3, 'Ensalada verde');
  perform pg_temp.comp_nested(s, v_verde, 435);
  s := pg_temp.slot(v_carne, 'FAT', 4, 'Para cocinar', false);
  perform pg_temp.comp(s, 'aceite de oliva', 'AS_PACKAGED', 15, null, true, 1);
  perform pg_temp.step(v_carne, 1, 'Cocer las papas con cáscara 20 minutos.', 20, null, null, null, 1);
  perform pg_temp.step(v_carne, 2, 'Sellar la carne a fuego fuerte, 4 minutos por lado.', 8, null, null, null, 1);
  perform pg_temp.step(v_carne, 3, 'Dejar reposar la carne 5 minutos antes de cortar.', 5);
  perform pg_temp.publish(v_carne);

  -- 3. Merluza con arroz y ensalada verde ------------------------------------
  v_pescado := pg_temp.recipe('Merluza con arroz y ensalada verde', 'MEAL', '{LUNCH,DINNER}', 4, 35, null);
  s := pg_temp.slot(v_pescado, 'PROTEIN', 1);
  perform pg_temp.comp(s, 'merluza', 'RAW', 640, 'BAKED', false, 1);
  perform pg_temp.alt(s, 'salmon', 'EXCELLENT', 'Mismo tratamiento en el horno.');
  s := pg_temp.slot(v_pescado, 'CARBOHYDRATE', 2);
  perform pg_temp.comp(s, 'arroz blanco', 'RAW', 300, 'BOILED', false, 1);
  s := pg_temp.slot(v_pescado, 'SALAD', 3, 'Ensalada verde');
  perform pg_temp.comp_nested(s, v_verde, 435);
  s := pg_temp.slot(v_pescado, 'FAT', 4, 'Aliño', false);
  perform pg_temp.comp(s, 'limon', 'RAW', 60, 'RAW', true, 1);
  perform pg_temp.step(v_pescado, 1, 'Hornear la merluza 15 minutos a 190 °C con limón.', 15, 190,
    'AIR_FRYER', 'En air fryer, 12 minutos a 180 °C.', 1);
  perform pg_temp.step(v_pescado, 2, 'Cocer el arroz mientras se hornea el pescado.', 15, null, null, null, 1);
  perform pg_temp.publish(v_pescado);

  -- 4. Lentejas guisadas ------------------------------------------------------
  v_lentejas := pg_temp.recipe('Lentejas guisadas', 'MEAL', '{LUNCH}', 6, 60,
    'Legumbre como proteína principal: una receta no necesita carne.');
  s := pg_temp.slot(v_lentejas, 'PROTEIN', 1, 'Legumbre');
  perform pg_temp.comp(s, 'lentejas', 'RAW', 600, 'STEWED', false, 1);
  s := pg_temp.slot(v_lentejas, 'VEGETABLE', 2, 'Verduras del guiso');
  perform pg_temp.comp(s, 'cebolla',   'RAW', 200, 'STEWED', false, 1);
  perform pg_temp.comp(s, 'zanahoria', 'RAW', 250, 'STEWED', false, 2);
  perform pg_temp.comp(s, 'papa',      'RAW', 400, 'STEWED', false, 3);
  s := pg_temp.slot(v_lentejas, 'FAT', 3, 'Para el sofrito', false);
  perform pg_temp.comp(s, 'aceite de oliva', 'AS_PACKAGED', 30, null, true, 1);
  perform pg_temp.step(v_lentejas, 1, 'Sofreír cebolla y zanahoria hasta que estén blandas.', 10);
  perform pg_temp.step(v_lentejas, 2, 'Agregar las lentejas, la papa y agua; cocer 40 minutos.', 40);
  perform pg_temp.publish(v_lentejas);

  -- 5. Pasta con pollo --------------------------------------------------------
  v_pasta := pg_temp.recipe('Pasta con pollo', 'MEAL', '{LUNCH,DINNER}', 4, 30, null);
  s := pg_temp.slot(v_pasta, 'CARBOHYDRATE', 1);
  perform pg_temp.comp(s, 'fideos', 'RAW', 400, 'BOILED', false, 1);
  s := pg_temp.slot(v_pasta, 'PROTEIN', 2);
  perform pg_temp.comp(s, 'pechuga de pollo sin piel', 'RAW', 500, 'PAN_SEARED', false, 1, 0.72);
  perform pg_temp.alt(s, 'merluza', 'ACCEPTABLE');
  s := pg_temp.slot(v_pasta, 'SAUCE', 3, 'Salsa', false);
  perform pg_temp.comp(s, 'tomate', 'RAW', 400, 'STEWED', false, 1);
  perform pg_temp.comp(s, 'cebolla', 'RAW', 100, 'STEWED', false, 2);
  perform pg_temp.step(v_pasta, 1, 'Hervir los fideos según el envase.', 10, null, null, null, 1);
  perform pg_temp.step(v_pasta, 2, 'Saltear el pollo en cubos y agregar la salsa de tomate.', 15, null, null, null, 1);
  perform pg_temp.publish(v_pasta);

  -- 6. Pan con huevo y tomate (desayuno / once) -------------------------------
  v_pan := pg_temp.recipe('Pan con huevo y tomate', 'MEAL', '{BREAKFAST,TEA}', 2, 12,
    'Estructura simple: no toda receta tiene proteína animal en el centro ni tres tiempos.');
  s := pg_temp.slot(v_pan, 'CARBOHYDRATE', 1, 'Pan');
  perform pg_temp.comp(s, 'pan marraqueta', 'AS_PACKAGED', 200, null, false, 1);
  s := pg_temp.slot(v_pan, 'PROTEIN', 2);
  perform pg_temp.comp(s, 'huevo de gallina', 'EDIBLE_PORTION', 110, 'PAN_SEARED', false, 1);
  s := pg_temp.slot(v_pan, 'VEGETABLE', 3);
  perform pg_temp.comp(s, 'tomate', 'RAW', 150, 'RAW', false, 1);
  s := pg_temp.slot(v_pan, 'FAT', 4, 'Opcional', false);
  perform pg_temp.comp(s, 'palta', 'RAW', 80, 'RAW', true, 1);
  perform pg_temp.step(v_pan, 1, 'Tostar el pan.', 3, null, null, null, 1);
  perform pg_temp.step(v_pan, 2, 'Freír los huevos a fuego medio.', 5, null, null, null, 1);
  perform pg_temp.step(v_pan, 3, 'Armar con el tomate en rodajas.', 2);
  perform pg_temp.publish(v_pan);

  -- 7. Yogur con arándanos y plátano (postre) ---------------------------------
  v_postre := pg_temp.recipe('Yogur con arándanos y plátano', 'DESSERT', '{DESSERT,SNACK}', 2, 5,
    'Postre modular: base, fruta y topping. Más adelante cada integrante podrá tener su variante.');
  s := pg_temp.slot(v_postre, 'BASE', 1, 'Base');
  perform pg_temp.comp(s, 'yogur natural', 'AS_PACKAGED', 300, null, false, 1);
  s := pg_temp.slot(v_postre, 'FRUIT', 2, 'Fruta');
  perform pg_temp.comp(s, 'arandanos', 'RAW', 100, 'RAW', false, 1);
  perform pg_temp.comp(s, 'platano',   'RAW', 120, 'RAW', false, 2);
  perform pg_temp.alt(s, 'manzana', 'GOOD');
  s := pg_temp.slot(v_postre, 'TOPPING', 3, 'Topping', false);
  perform pg_temp.comp(s, 'avena tradicional', 'RAW', 30, null, true, 1);
  perform pg_temp.step(v_postre, 1, 'Servir el yogur y agregar la fruta encima.', 3);
  perform pg_temp.publish(v_postre);
end $$;

-- Dejar constancia de que estas recetas son de desarrollo, no verificadas.
update public.meal_templates
set is_verified = false
where household_id is null;
