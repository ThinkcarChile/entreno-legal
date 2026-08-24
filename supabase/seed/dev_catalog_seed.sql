-- SEED DE DESARROLLO — Sprint 2 (NO aplicar en producción sin revisión)
-- Todos los datos nutricionales de este archivo son source_type='DEV_SEED':
-- valores plausibles SOLO para validar arquitectura. NO son datos oficiales
-- y nunca se muestran como verificados (constraint nutrition_unverifiable_sources).
-- Proceso futuro para datos con licencia: ADR 0001 §6.

do $$
declare
  cat record;
  v_ing uuid;
  v_prod uuid;
  cats jsonb := '{}'::jsonb;
  src constant text := 'Seed de desarrollo — valores no oficiales';
begin
  for cat in select id, code from public.ingredient_categories loop
    cats := cats || jsonb_build_object(cat.code, cat.id::text);
  end loop;

  -- ==== helper local: inserta ingrediente global + nutrición DEV_SEED ======
  -- (bloque plpgsql simple; los NULL en nutrientes significan DESCONOCIDO)

  -- Pollo, pechuga sin piel (RAW y COOKED para demostrar bases separadas)
  insert into public.ingredients (canonical_name, display_name, category_id, edible_portion_factor)
  values ('pechuga de pollo sin piel', 'Pechuga de pollo (sin piel)', (cats->>'POULTRY')::uuid, 1.0)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g, saturated_fat_g,
    sodium_mg, potassium_mg, phosphorus_mg, source_type, source_name, notes)
  values
    (v_ing, 'RAW',    'G', 110, 23.0, 0, 1.8, 0, 0, 0.5, 65, 330, 210, 'DEV_SEED', src, 'demo'),
    (v_ing, 'COOKED', 'G', 158, 31.0, 0, 3.2, 0, 0, 0.9, 74, 380, 240, 'DEV_SEED', src, 'demo');

  -- Vacuno, posta magra
  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('vacuno posta magra', 'Vacuno posta (magra)', (cats->>'MEAT')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, saturated_fat_g, sodium_mg,
    source_type, source_name, notes)
  values (v_ing, 'RAW', 'G', 134, 21.5, 0, 5.0, 2.0, 60, 'DEV_SEED', src,
          'demo — potasio/fósforo desconocidos a propósito (UNKNOWN != ZERO)');

  -- Merluza
  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('merluza', 'Merluza', (cats->>'FISH')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, saturated_fat_g, sodium_mg, potassium_mg,
    source_type, source_name, notes)
  values (v_ing, 'RAW', 'G', 82, 17.8, 0, 1.1, 0.3, 90, 300, 'DEV_SEED', src, 'demo');

  -- Salmón
  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('salmon', 'Salmón', (cats->>'FISH')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, saturated_fat_g, sodium_mg, potassium_mg,
    source_type, source_name, notes)
  values (v_ing, 'RAW', 'G', 205, 20.0, 0, 13.5, 3.0, 60, 360, 'DEV_SEED', src, 'demo');

  -- Huevo
  insert into public.ingredients (canonical_name, display_name, category_id, default_measurement_type, edible_portion_factor)
  values ('huevo de gallina', 'Huevo', (cats->>'EGGS')::uuid, 'UNIT', 0.88)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, saturated_fat_g, sodium_mg, potassium_mg, phosphorus_mg,
    source_type, source_name, notes)
  values (v_ing, 'EDIBLE_PORTION', 'G', 143, 12.6, 0.7, 9.5, 3.1, 140, 138, 198, 'DEV_SEED', src, 'demo');
  insert into public.household_measures (ingredient_id, measure_name, quantity, unit)
  values (v_ing, 'unidad', 55, 'G');

  -- Arroz blanco (RAW y COOKED: 100 g crudo != 100 g cocido)
  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('arroz blanco', 'Arroz blanco', (cats->>'GRAINS')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g, saturated_fat_g, sodium_mg,
    source_type, source_name, notes)
  values
    (v_ing, 'RAW',    'G', 360, 6.6, 79.0, 0.6, 1.4, 0.1, 0.2, 4, 'DEV_SEED', src, 'demo'),
    (v_ing, 'COOKED', 'G', 130, 2.4, 28.2, 0.2, 0.5, 0.0, 0.1, 1, 'DEV_SEED', src, 'demo');
  insert into public.household_measures (ingredient_id, measure_name, quantity, unit)
  values (v_ing, 'taza (crudo)', 195, 'G');

  -- Avena
  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('avena tradicional', 'Avena', (cats->>'GRAINS')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g, saturated_fat_g, sodium_mg,
    source_type, source_name, notes)
  values (v_ing, 'RAW', 'G', 379, 13.2, 67.7, 6.5, 10.1, 1.0, 1.2, 6, 'DEV_SEED', src, 'demo');
  insert into public.household_measures (ingredient_id, measure_name, quantity, unit)
  values (v_ing, 'cucharada', 10, 'G');

  -- Pan genérico (marraqueta)
  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('pan marraqueta', 'Pan marraqueta (genérico)', (cats->>'BREAD')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sodium_mg,
    source_type, source_name, notes)
  values (v_ing, 'EDIBLE_PORTION', 'G', 270, 8.5, 55.0, 1.5, 2.5, 500, 'DEV_SEED', src, 'demo');

  -- Lentejas
  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('lentejas', 'Lentejas', (cats->>'LEGUMES')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sodium_mg, potassium_mg,
    source_type, source_name, notes)
  values
    (v_ing, 'RAW',    'G', 336, 23.0, 56.0, 1.6, 11.0, 10, 730, 'DEV_SEED', src, 'demo'),
    (v_ing, 'COOKED', 'G', 116,  9.0, 20.0, 0.4,  7.9,  2, 370, 'DEV_SEED', src, 'demo');

  -- Verduras
  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('tomate', 'Tomate', (cats->>'VEGETABLES')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g, sodium_mg, potassium_mg,
    source_type, source_name, notes)
  values (v_ing, 'RAW', 'G', 18, 0.9, 3.9, 0.2, 1.2, 2.6, 5, 237, 'DEV_SEED', src, 'demo');

  insert into public.ingredients (canonical_name, display_name, category_id, edible_portion_factor)
  values ('cebolla', 'Cebolla', (cats->>'VEGETABLES')::uuid, 0.9)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g, sodium_mg,
    source_type, source_name, notes)
  values (v_ing, 'RAW', 'G', 40, 1.1, 9.3, 0.1, 1.7, 4.2, 4, 'DEV_SEED', src, 'demo');

  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('lechuga', 'Lechuga', (cats->>'VEGETABLES')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sodium_mg,
    source_type, source_name, notes)
  values (v_ing, 'RAW', 'G', 15, 1.4, 2.9, 0.2, 1.3, 28, 'DEV_SEED', src, 'demo');

  insert into public.ingredients (canonical_name, display_name, category_id, edible_portion_factor)
  values ('zanahoria', 'Zanahoria', (cats->>'VEGETABLES')::uuid, 0.89)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g, sodium_mg, potassium_mg,
    source_type, source_name, notes)
  values (v_ing, 'RAW', 'G', 41, 0.9, 9.6, 0.2, 2.8, 4.7, 69, 320, 'DEV_SEED', src, 'demo');

  insert into public.ingredients (canonical_name, display_name, category_id, edible_portion_factor)
  values ('palta', 'Palta', (cats->>'FRUITS')::uuid, 0.74)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, saturated_fat_g, sodium_mg, potassium_mg,
    source_type, source_name, notes)
  values (v_ing, 'EDIBLE_PORTION', 'G', 160, 2.0, 8.5, 14.7, 6.7, 2.1, 7, 485, 'DEV_SEED', src, 'demo');

  -- Frutas
  insert into public.ingredients (canonical_name, display_name, category_id, default_measurement_type, edible_portion_factor)
  values ('manzana', 'Manzana', (cats->>'FRUITS')::uuid, 'UNIT', 0.9)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g, sodium_mg, potassium_mg,
    source_type, source_name, notes)
  values (v_ing, 'EDIBLE_PORTION', 'G', 52, 0.3, 13.8, 0.2, 2.4, 10.4, 1, 107, 'DEV_SEED', src, 'demo');
  insert into public.household_measures (ingredient_id, measure_name, quantity, unit)
  values (v_ing, 'unidad', 150, 'G');

  insert into public.ingredients (canonical_name, display_name, category_id, default_measurement_type, edible_portion_factor)
  values ('platano', 'Plátano', (cats->>'FRUITS')::uuid, 'UNIT', 0.64)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g, sodium_mg, potassium_mg,
    source_type, source_name, notes)
  values (v_ing, 'EDIBLE_PORTION', 'G', 89, 1.1, 22.8, 0.3, 2.6, 12.2, 1, 358, 'DEV_SEED', src, 'demo');
  insert into public.household_measures (ingredient_id, measure_name, quantity, unit)
  values (v_ing, 'unidad', 120, 'G');

  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('arandanos', 'Arándanos', (cats->>'FRUITS')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugars_g,
    source_type, source_name, notes)
  values (v_ing, 'RAW', 'G', 57, 0.7, 14.5, 0.3, 2.4, 10.0, 'DEV_SEED', src,
          'demo — sodio/potasio/fósforo desconocidos a propósito');

  -- Lácteos y grasas
  insert into public.ingredients (canonical_name, display_name, category_id)
  values ('yogur natural', 'Yogur natural (genérico)', (cats->>'DAIRY')::uuid)
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, sugars_g, saturated_fat_g, sodium_mg, potassium_mg,
    source_type, source_name, notes)
  values (v_ing, 'AS_PACKAGED', 'G', 61, 3.5, 4.7, 3.3, 4.7, 2.1, 46, 155, 'DEV_SEED', src, 'demo');

  insert into public.ingredients (canonical_name, display_name, category_id, default_measurement_type)
  values ('aceite de oliva', 'Aceite de oliva', (cats->>'FATS_OILS')::uuid, 'VOLUME')
  returning id into v_ing;
  insert into public.nutrition_facts (ingredient_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, saturated_fat_g,
    source_type, source_name, notes)
  values (v_ing, 'AS_PACKAGED', 'ML', 824, 0, 0, 91.6, 12.7, 'DEV_SEED', src, 'demo — por 100 ml');
  insert into public.household_measures (ingredient_id, measure_name, quantity, unit)
  values (v_ing, 'cucharada', 15, 'ML'), (v_ing, 'cucharadita', 5, 'ML');

  -- ==== Productos comerciales de demostración (fixtures, no productos reales) ====
  -- Barcodes EAN-13 del rango interno GS1 (prefijo 200), con checksum válido.

  -- Producto 1: nutrición declarada POR PORCIÓN (48 g = 90 kcal) → demuestra normalización
  insert into public.commercial_products (barcode, brand, name, package_quantity, package_unit,
    serving_quantity, serving_unit, serving_name, source, verified)
  values ('2000000000015', 'Marca Demo', 'Pan de molde integral (demo)', 500, 'G', 48, 'G', 'rebanada (2)', 'DEV_SEED', false)
  returning id into v_prod;
  insert into public.nutrition_facts (product_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sodium_mg,
    original_serving_quantity, original_serving_unit, original_values,
    source_type, source_name, notes)
  values (v_prod, 'AS_PACKAGED', 'G',
    187.5, 13.125, 29.792, 1.667, 6.25, 458.333,
    48, 'G',
    '{"energy_kcal": 90, "protein_g": 6.3, "carbohydrates_g": 14.3, "fat_g": 0.8, "fiber_g": 3.0, "sodium_mg": 220}'::jsonb,
    'DEV_SEED', src, 'demo — normalizado desde etiqueta por porción de 48 g');
  insert into public.household_measures (product_id, measure_name, quantity, unit)
  values (v_prod, 'rebanada', 24, 'G');

  -- Producto 2: yogur proteico por envase
  insert into public.commercial_products (barcode, brand, name, package_quantity, package_unit,
    serving_quantity, serving_unit, serving_name, source, verified)
  values ('2000000000022', 'Marca Demo', 'Yogur proteína vainilla (demo)', 155, 'G', 155, 'G', 'envase', 'DEV_SEED', false)
  returning id into v_prod;
  insert into public.nutrition_facts (product_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, sugars_g,
    original_serving_quantity, original_serving_unit, original_values,
    source_type, source_name, notes)
  values (v_prod, 'AS_PACKAGED', 'G',
    58.065, 9.032, 4.516, 0.323, 3.871,
    155, 'G',
    '{"energy_kcal": 90, "protein_g": 14, "carbohydrates_g": 7, "fat_g": 0.5, "sugars_g": 6}'::jsonb,
    'DEV_SEED', src, 'demo — sin datos de sodio/potasio a propósito');

  -- Producto 3: bebida (por 100 ml)
  insert into public.commercial_products (barcode, brand, name, package_quantity, package_unit,
    serving_quantity, serving_unit, serving_name, source, verified)
  values ('2000000000039', 'Marca Demo', 'Leche descremada (demo)', 1000, 'ML', 200, 'ML', 'vaso', 'DEV_SEED', false)
  returning id into v_prod;
  insert into public.nutrition_facts (product_id, weight_basis, basis_unit,
    energy_kcal, protein_g, carbohydrates_g, fat_g, sugars_g, sodium_mg, potassium_mg, phosphorus_mg,
    source_type, source_name, notes)
  values (v_prod, 'AS_PACKAGED', 'ML', 35, 3.4, 4.9, 0.2, 4.9, 44, 150, 95, 'DEV_SEED', src, 'demo — por 100 ml');
end $$;
