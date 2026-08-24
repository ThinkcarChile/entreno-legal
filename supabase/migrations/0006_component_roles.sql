-- QA Sprint 4 — El rol de un componente se declara, no se adivina.
--
-- Sprint 4 detectaba la grasa añadida con una heurística: "está en un slot FAT,
-- es opcional, y al menos el 70 % de su energía viene de la grasa". Al medirla
-- contra casos reales falla:
--
--   alimento           % energía de grasa   heurística        correcto
--   aceite de oliva          100,0 %        grasa añadida     grasa añadida
--   mantequilla              101,7 %        grasa añadida     grasa añadida
--   mayonesa                  99,3 %        grasa añadida     grasa añadida
--   palta                     82,7 %        grasa añadida     ALIMENTO      <- falso positivo
--   semillas de girasol       78,6 %        grasa añadida     ALIMENTO      <- falso positivo
--   queso gouda               69,3 %        alimento          ALIMENTO      <- se salva por 0,7 puntos
--   yogur natural             48,7 %        alimento          ALIMENTO
--   limón                      9,3 %        alimento          ALIMENTO
--
-- A quien evita la grasa añadida se le borraba la palta del plato. Un queso algo
-- más graso habría caído también. Ninguna cifra de corte arregla eso, porque el
-- problema no es el umbral: es que el rol culinario de un ingrediente no se
-- deduce de su composición. Se declara.

create type public.component_role as enum ('MAIN', 'ADDED_FAT', 'SEASONING');

comment on type public.component_role is
  'Rol culinario del componente. ADDED_FAT es la grasa que se agrega al preparar '
  '(aceite, mantequilla, mayonesa) y es lo único que el optimizador puede quitar '
  'por preferencia de grasa añadida. La palta y las semillas son MAIN aunque sean '
  'grasas: son comida, no aliño.';

alter table public.meal_slot_components
  add column role public.component_role not null default 'MAIN';

-- Relleno único por CATEGORÍA del ingrediente, que sí es un dato declarado, no
-- una inferencia nutricional: un componente opcional cuyo alimento vive en
-- "Aceites y grasas" es grasa añadida. La palta (Frutas), el queso (Lácteos) y
-- las semillas (Frutos secos y semillas) quedan correctamente como MAIN.
alter table public.meal_slot_components disable trigger components_immutable;

update public.meal_slot_components c
set role = 'ADDED_FAT'
from public.ingredients i
join public.ingredient_categories cat on cat.id = i.category_id
where i.id = c.ingredient_id
  and cat.code = 'FATS_OILS'
  and c.is_optional;

alter table public.meal_slot_components enable trigger components_immutable;

create index components_added_fat_idx
  on public.meal_slot_components (slot_id) where role = 'ADDED_FAT';

-- ---------------------------------------------------------------------------
-- El guardado de borradores transporta el rol.
-- ---------------------------------------------------------------------------

create or replace function public.replace_draft_content(p_version_id uuid, p_payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_slot_json jsonb;
  v_comp_json jsonb;
  v_alt_json jsonb;
  v_step_json jsonb;
  v_slot uuid;
  v_optional boolean;
begin
  if not app.can_write_version(p_version_id) then
    raise exception 'no autorizado o la versión no es un borrador';
  end if;

  update public.meal_template_versions set
    name              = coalesce(p_payload->>'name', name),
    description       = p_payload->>'description',
    base_servings     = coalesce((p_payload->>'base_servings')::int, base_servings),
    base_time_minutes = (p_payload->>'base_time_minutes')::int,
    total_yield_factor= (p_payload->>'total_yield_factor')::numeric,
    meal_types        = coalesce(
      (select array_agg(value::text::public.meal_type)
         from jsonb_array_elements_text(p_payload->'meal_types') as value),
      meal_types)
  where id = p_version_id;

  delete from public.meal_slots where version_id = p_version_id;
  delete from public.recipe_steps where version_id = p_version_id;

  for v_slot_json in select * from jsonb_array_elements(coalesce(p_payload->'slots', '[]'::jsonb)) loop
    insert into public.meal_slots (version_id, slot_type, label, is_required, sort_order, notes)
    values (
      p_version_id,
      (v_slot_json->>'slot_type')::public.meal_slot_type,
      nullif(v_slot_json->>'label', ''),
      coalesce((v_slot_json->>'is_required')::boolean, true),
      coalesce((v_slot_json->>'sort_order')::int, 1),
      nullif(v_slot_json->>'notes', '')
    ) returning id into v_slot;

    for v_comp_json in select * from jsonb_array_elements(coalesce(v_slot_json->'components', '[]'::jsonb)) loop
      v_optional := coalesce((v_comp_json->>'is_optional')::boolean, false);
      insert into public.meal_slot_components (
        slot_id, ingredient_id, product_id, nested_version_id,
        quantity, unit, weight_basis, measure_id, measure_count,
        nutrition_fact_id, cooking_method, yield_factor, is_optional, sort_order, notes,
        adjustability, min_quantity, max_quantity, role
      ) values (
        v_slot,
        nullif(v_comp_json->>'ingredient_id', '')::uuid,
        nullif(v_comp_json->>'product_id', '')::uuid,
        nullif(v_comp_json->>'nested_version_id', '')::uuid,
        (v_comp_json->>'quantity')::numeric,
        coalesce((v_comp_json->>'unit')::public.nutrition_basis_unit, 'G'),
        coalesce((v_comp_json->>'weight_basis')::public.weight_basis, 'RAW'),
        nullif(v_comp_json->>'measure_id', '')::uuid,
        (v_comp_json->>'measure_count')::numeric,
        nullif(v_comp_json->>'nutrition_fact_id', '')::uuid,
        (nullif(v_comp_json->>'cooking_method', ''))::public.cooking_method,
        (v_comp_json->>'yield_factor')::numeric,
        v_optional,
        coalesce((v_comp_json->>'sort_order')::int, 1),
        nullif(v_comp_json->>'notes', ''),
        case when v_optional then 'OPTIONAL'::public.slot_adjustability
             else coalesce((nullif(v_comp_json->>'adjustability', ''))::public.slot_adjustability,
                           'ADJUSTABLE'::public.slot_adjustability) end,
        (v_comp_json->>'min_quantity')::numeric,
        (v_comp_json->>'max_quantity')::numeric,
        coalesce((nullif(v_comp_json->>'role', ''))::public.component_role, 'MAIN')
      );
    end loop;

    for v_alt_json in select * from jsonb_array_elements(coalesce(v_slot_json->'alternatives', '[]'::jsonb)) loop
      insert into public.meal_slot_alternatives (
        slot_id, ingredient_id, product_id, nested_version_id,
        culinary_compatibility, quantity_equivalence, notes
      ) values (
        v_slot,
        nullif(v_alt_json->>'ingredient_id', '')::uuid,
        nullif(v_alt_json->>'product_id', '')::uuid,
        nullif(v_alt_json->>'nested_version_id', '')::uuid,
        coalesce((v_alt_json->>'culinary_compatibility')::public.culinary_compatibility, 'GOOD'),
        (v_alt_json->>'quantity_equivalence')::numeric,
        nullif(v_alt_json->>'notes', '')
      );
    end loop;
  end loop;

  for v_step_json in select * from jsonb_array_elements(coalesce(p_payload->'steps', '[]'::jsonb)) loop
    insert into public.recipe_steps (
      version_id, step_number, instruction, duration_minutes, temperature_c,
      required_capability, optional_capability, manual_alternative, parallel_group, notes
    ) values (
      p_version_id,
      (v_step_json->>'step_number')::int,
      v_step_json->>'instruction',
      (v_step_json->>'duration_minutes')::int,
      (v_step_json->>'temperature_c')::int,
      nullif(v_step_json->>'required_capability', ''),
      nullif(v_step_json->>'optional_capability', ''),
      nullif(v_step_json->>'manual_alternative', ''),
      (v_step_json->>'parallel_group')::int,
      nullif(v_step_json->>'notes', '')
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- QA §27 — Una restricción médica no se convierte en "no me gusta".
--
-- La UI deja a cada persona declarar sus gustos e incluso sus alergias, pero
-- MEDICAL_RESTRICTION nace del pipeline clínico (sprint posterior) y nadie puede
-- degradarla a SOFT desde la aplicación. Si el candado vive solo en la UI, el
-- primer script que escriba directo lo salta.
-- ---------------------------------------------------------------------------

create or replace function app.protect_medical_restrictions()
returns trigger language plpgsql as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'UPDATE' and old.preference_type = 'MEDICAL_RESTRICTION'
       and new.preference_type <> 'MEDICAL_RESTRICTION' then
      raise exception 'Una restricción médica no se cambia desde la aplicación'
        using errcode = 'insufficient_privilege';
    end if;
    if tg_op = 'DELETE' and old.preference_type = 'MEDICAL_RESTRICTION' then
      raise exception 'Una restricción médica no se elimina desde la aplicación'
        using errcode = 'insufficient_privilege';
    end if;
    if tg_op = 'INSERT' and new.preference_type = 'MEDICAL_RESTRICTION' then
      raise exception 'Una restricción médica la crea el pipeline clínico, no el usuario'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger preferences_protect_medical
  before insert or update or delete on public.member_preferences
  for each row execute function app.protect_medical_restrictions();
