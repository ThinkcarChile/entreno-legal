-- Sprint 10 — corrección encontrada en la DEMO VIVA (2026-08-25).
--
-- Síntoma: el plan de preparación mandaba a CONGELAR lechuga, aceite de oliva,
-- limón y arroz. Causa: la regla sembrada "congelado a -18°C = seguro sin
-- fecha" es GENÉRICA y responde "¿es seguro lo que ya está congelado?" — una
-- pregunta de microbiología. El motor la estaba usando para responder otra
-- distinta: "¿le recomiendo a la familia congelar ESTO?", que además depende de
-- si el alimento sirve congelado (una lechuga congelada queda inservible).
--
-- Corrección en dos partes:
--  1. El motor (`storage-safety/1.0.0`) ya no acepta una regla genérica como
--     respaldo para RECOMENDAR congelar: exige regla del alimento, de su
--     categoría o del propio hogar.
--  2. Esta migración agrega las reglas por CATEGORÍA donde congelar sí es
--     práctica respaldada, citando la fuente. Lo que no está acá seguirá
--     saliendo como "revisar" — que es la respuesta honesta.
--
-- Migración de DATOS: idempotente, no toca schema, no modifica 0013/0014/0015.

insert into public.storage_safety_rules
  (household_id, ingredient_id, category_id, processing_state, temperature_state,
   rule_kind, max_days, use_soon_within_days, source)
select null, null, c.id, null, 'FROZEN', 'STORAGE_DAYS', null, 0,
       'USDA FSIS — Carnes, aves y pescados se mantienen seguros indefinidamente a -18°C'
from public.ingredient_categories c
where c.code in ('MEAT', 'POULTRY', 'FISH')
  and not exists (
    select 1 from public.storage_safety_rules r
    where r.category_id = c.id and r.rule_kind = 'STORAGE_DAYS'
      and r.temperature_state = 'FROZEN'
  );

-- Refrigerado de verduras y frutas: ventana conservadora con fuente, para que
-- el motor tenga con qué responder "refrigerar" en vez de caer a "revisar".
insert into public.storage_safety_rules
  (household_id, ingredient_id, category_id, processing_state, temperature_state,
   rule_kind, max_days, use_soon_within_days, source)
select null, null, c.id, null, 'CHILLED', 'STORAGE_DAYS', 5, 1,
       'FDA Food Keeper — Verduras y frutas frescas refrigeradas: usar dentro de la semana'
from public.ingredient_categories c
where c.code in ('VEGETABLES', 'FRUITS')
  and not exists (
    select 1 from public.storage_safety_rules r
    where r.category_id = c.id and r.rule_kind = 'STORAGE_DAYS'
      and r.temperature_state = 'CHILLED'
  );

-- Verduras y frutas PREPARADAS (lavadas/cortadas): ventana más corta.
insert into public.storage_safety_rules
  (household_id, ingredient_id, category_id, processing_state, temperature_state,
   rule_kind, max_days, use_soon_within_days, source)
select null, null, c.id, 'PREPPED', 'CHILLED', 'STORAGE_DAYS', 3, 1,
       'FDA Food Keeper — Verduras y frutas ya cortadas: 3 días refrigeradas'
from public.ingredient_categories c
where c.code in ('VEGETABLES', 'FRUITS')
  and not exists (
    select 1 from public.storage_safety_rules r
    where r.category_id = c.id and r.rule_kind = 'STORAGE_DAYS'
      and r.temperature_state = 'CHILLED' and r.processing_state = 'PREPPED'
  );
