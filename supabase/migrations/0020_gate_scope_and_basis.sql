-- Integration Gate 0→10 — tanda 3: ámbito de los UUID del cliente y base física.
--
-- Cuatro familias de defecto confirmadas por la auditoría de 13 lentes:
--
--  [G-1] `replace_draft_content` es SECURITY DEFINER y no validaba NINGUNO de
--        los cinco UUID que le manda el cliente. La propia cabecera de 0010
--        promete lo contrario.
--  [G-2] `publish_meal_template_version` congela la ficha nutricional leyendo
--        `nutrition_facts` por un id del cliente. Como corre como owner, se
--        salta la RLS y COPIA la ficha privada de otro hogar dentro de una
--        receta del atacante: exfiltración, no solo escritura sucia.
--  [B-1] Las bases EDIBLE_PORTION y AS_PACKAGED no podían EXISTIR en un lote:
--        toda recepción las aplastaba a RAW. Un componente en esas bases nunca
--        encontraba lote, así que la comida se servía y la despensa NO se
--        descontaba. Comida real que jamás salía del inventario.
--  [M-2] `member_cooking_preferences` tiene un único con NULLS DISTINCT, así
--        que el upsert de la app NUNCA actualizaba: cada cambio de opinión
--        insertaba una fila nueva y el motor leía la que la base quisiera.
--
-- No modifica ninguna migración congelada.

-- ---------------------------------------------------------------------------
-- 0. Validadores de ámbito que faltaban
-- ---------------------------------------------------------------------------

/** ¿Esta ficha nutricional es global o de este hogar? NULL = válido. */
create or replace function app.nutrition_fact_in_scope(p_fact uuid, p_household uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_fact is null or exists (
    select 1 from public.nutrition_facts f
    where f.id = p_fact
      and (f.household_id is null or f.household_id = p_household)
  );
$$;

/** ¿Esta medida casera es global o de este hogar? NULL = válido. */
create or replace function app.measure_in_scope(p_measure uuid, p_household uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_measure is null or exists (
    select 1 from public.household_measures m
    where m.id = p_measure
      and (m.household_id is null or m.household_id = p_household)
  );
$$;

/** Hogar dueño de una versión de receta (NULL si es una receta global). */
create or replace function app.version_household(p_version uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select t.household_id
  from public.meal_template_versions v
  join public.meal_templates t on t.id = v.template_id
  where v.id = p_version;
$$;

-- ---------------------------------------------------------------------------
-- 1. [G-1] replace_draft_content v4: todo UUID del cliente se valida
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
  v_household uuid;
  v_ing uuid;
  v_prod uuid;
  v_nested uuid;
  v_measure uuid;
  v_fact uuid;
begin
  if not app.can_write_version(p_version_id) then
    raise exception 'no autorizado o la versión no es un borrador';
  end if;

  -- can_write_version ya garantizó que la receta es de un hogar mío.
  v_household := app.version_household(p_version_id);

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

      v_ing     := nullif(v_comp_json->>'ingredient_id', '')::uuid;
      v_prod    := nullif(v_comp_json->>'product_id', '')::uuid;
      v_nested  := nullif(v_comp_json->>'nested_version_id', '')::uuid;
      v_measure := nullif(v_comp_json->>'measure_id', '')::uuid;
      v_fact    := nullif(v_comp_json->>'nutrition_fact_id', '')::uuid;

      -- Gate 0→10 [G-1]: cinco UUID que venían del navegador entraban sin
      -- revisar. Un id de otro hogar quedaba pegado dentro de una receta mía.
      if not app.ingredient_in_scope(v_ing, v_household) then
        raise exception 'el alimento no pertenece a este hogar';
      end if;
      if not app.product_in_scope(v_prod, v_household) then
        raise exception 'el producto no pertenece a este hogar';
      end if;
      if not app.version_in_scope(v_nested, v_household) then
        raise exception 'la sub-receta no pertenece a este hogar';
      end if;
      if not app.measure_in_scope(v_measure, v_household) then
        raise exception 'la medida casera no pertenece a este hogar';
      end if;
      if not app.nutrition_fact_in_scope(v_fact, v_household) then
        raise exception 'la ficha nutricional no pertenece a este hogar';
      end if;

      insert into public.meal_slot_components (
        slot_id, ingredient_id, product_id, nested_version_id,
        quantity, unit, weight_basis, measure_id, measure_count,
        nutrition_fact_id, cooking_method, yield_factor, is_optional, sort_order, notes,
        adjustability, min_quantity, max_quantity, role
      ) values (
        v_slot, v_ing, v_prod, v_nested,
        (v_comp_json->>'quantity')::numeric,
        coalesce((v_comp_json->>'unit')::public.nutrition_basis_unit, 'G'),
        coalesce((v_comp_json->>'weight_basis')::public.weight_basis, 'RAW'),
        v_measure,
        (v_comp_json->>'measure_count')::numeric,
        v_fact,
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
      v_ing    := nullif(v_alt_json->>'ingredient_id', '')::uuid;
      v_prod   := nullif(v_alt_json->>'product_id', '')::uuid;
      v_nested := nullif(v_alt_json->>'nested_version_id', '')::uuid;

      if not app.ingredient_in_scope(v_ing, v_household) then
        raise exception 'el alimento alternativo no pertenece a este hogar';
      end if;
      if not app.product_in_scope(v_prod, v_household) then
        raise exception 'el producto alternativo no pertenece a este hogar';
      end if;
      if not app.version_in_scope(v_nested, v_household) then
        raise exception 'la sub-receta alternativa no pertenece a este hogar';
      end if;

      insert into public.meal_slot_alternatives (
        slot_id, ingredient_id, product_id, nested_version_id,
        culinary_compatibility, quantity_equivalence, notes
      ) values (
        v_slot, v_ing, v_prod, v_nested,
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
-- 2. [G-2] publish_meal_template_version: la ficha congelada tiene que ser
--    del hogar. Correr como owner + id del cliente = leer fichas ajenas.
-- ---------------------------------------------------------------------------
--
-- Identica a la v2 de 0004 (guardian de receta vacia, guardian unidad/base,
-- congelado, published_by, current_version_id y evento de auditoria intactos)
-- MAS un chequeo de ambito antes de copiar nada.

create or replace function public.publish_meal_template_version(p_version_id uuid)
returns uuid language plpgsql security definer set search_path = public as $FN$
declare
  v_template uuid;
  v_household uuid;
  v_components int;
  v_bad text;
  v_intrusa uuid;
begin
  if not app.can_write_version(p_version_id) then
    raise exception 'no autorizado o la version no es un borrador';
  end if;

  select template_id into v_template from public.meal_template_versions where id = p_version_id;
  v_household := app.template_household(v_template);

  select count(*) into v_components
  from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  where s.version_id = p_version_id;
  if v_components = 0 then
    raise exception 'una receta sin ingredientes no se publica';
  end if;

  -- Gate 0-10 [G-2]: antes de congelar NADA, revisar que cada ficha apuntada
  -- por un componente sea global o de este hogar. Esta funcion corre como
  -- owner y no hay FORCE RLS en ninguna tabla, asi que sin este chequeo
  -- publicar COPIABA la ficha privada de otra familia (energia, proteina,
  -- marca, fuente) dentro de `frozen_nutrition`, legible para siempre.
  select c.nutrition_fact_id into v_intrusa
  from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  where s.version_id = p_version_id
    and c.nutrition_fact_id is not null
    and not app.nutrition_fact_in_scope(c.nutrition_fact_id, v_household)
  limit 1;

  if v_intrusa is not null then
    raise exception 'una ficha nutricional de esta receta no pertenece a este hogar';
  end if;

  -- La cantidad tiene que estar en la MISMA representacion que su ficha: misma
  -- unidad (g/ml) y misma base (crudo/cocido). Si no, el calculo seria inventado.
  select string_agg(coalesce(i.display_name, p.name, 'ingrediente'), ', ')
  into v_bad
  from public.meal_slot_components c
  join public.meal_slots s on s.id = c.slot_id
  join public.nutrition_facts f on f.id = c.nutrition_fact_id
  left join public.ingredients i on i.id = c.ingredient_id
  left join public.commercial_products p on p.id = c.product_id
  where s.version_id = p_version_id
    and (c.unit <> f.basis_unit or c.weight_basis <> f.weight_basis);

  if v_bad is not null then
    raise exception
      'La cantidad de % no coincide con la base de su ficha nutricional (unidad o estado). Corrigelo antes de publicar.',
      v_bad;
  end if;

  -- Congelar la ficha usada: una correccion posterior del catalogo no puede
  -- reescribir la nutricion de esta version (ADR 0002 seccion 3).
  update public.meal_slot_components c set
    frozen_nutrition = jsonb_build_object(
      'weight_basis', f.weight_basis,
      'basis_unit',   f.basis_unit,
      'values', jsonb_strip_nulls(jsonb_build_object(
        'energy_kcal', f.energy_kcal, 'protein_g', f.protein_g,
        'carbohydrates_g', f.carbohydrates_g, 'fat_g', f.fat_g,
        'fiber_g', f.fiber_g, 'sugars_g', f.sugars_g,
        'saturated_fat_g', f.saturated_fat_g, 'sodium_mg', f.sodium_mg,
        'potassium_mg', f.potassium_mg, 'phosphorus_mg', f.phosphorus_mg))
    ),
    frozen_source = jsonb_build_object(
      'source_type', f.source_type, 'source_name', f.source_name,
      'source_version', f.source_version, 'verified', f.verified,
      'nutrition_fact_id', f.id
    )
  from public.nutrition_facts f
  where f.id = c.nutrition_fact_id
    and c.slot_id in (select id from public.meal_slots where version_id = p_version_id);

  update public.meal_template_versions
  set status = 'PUBLISHED',
      published_at = now(),
      published_by = app.current_member_id(v_household)
  where id = p_version_id;

  update public.meal_templates
  set current_version_id = p_version_id
  where id = v_template;

  if v_household is not null then
    insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
    values (v_household, auth.uid(), 'RECIPE_VERSION_PUBLISHED', 'meal_template_version', p_version_id);
  end if;

  return p_version_id;
end;
$FN$;

-- ---------------------------------------------------------------------------
-- 3. [B-1] La base física del lote sobrevive a la compra
-- ---------------------------------------------------------------------------
--
-- `receive_shopping_list` mapeaba TODO a RAW salvo DRAINED. Compraste atún en
-- lata declarado AS_PACKAGED y en la despensa aparecía como crudo; el
-- componente pedía AS_PACKAGED, no calzaba ningún lote, y el consumo real
-- dejaba la despensa intacta: la comida existía en el plato y no en el ledger.

create or replace function public.receive_shopping_list(
  p_list_id     uuid,
  p_location_id uuid default null
) returns int language plpgsql security definer set search_path = public as $FN$
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
    raise exception 'la ubicacion no pertenece a este hogar';
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
      -- Gate 0-10 [B-1]: la base declarada en la compra se TRADUCE a la base
      -- fisica del lote. Antes solo sobrevivia DRAINED y todo lo demas se
      -- aplastaba a RAW, asi que un componente en AS_PACKAGED no encontraba
      -- lote nunca: la comida se servia y la despensa quedaba intacta.
      -- Ojo: `purchase_basis` y `weight_basis` son enums DISTINTOS
      -- (RAW/COMMERCIAL_PACKAGE/UNIT/DRAINED/OTHER  vs
      --  RAW/COOKED/DRAINED/EDIBLE_PORTION/AS_PACKAGED). La traduccion es
      -- explicita, aqui, y no un cast silencioso.
      case v_item.purchase_basis
        when 'DRAINED'            then 'DRAINED'::public.weight_basis
        when 'COMMERCIAL_PACKAGE' then 'AS_PACKAGED'::public.weight_basis
        when 'UNIT'               then 'AS_PACKAGED'::public.weight_basis
        -- 'OTHER' no declara nada fisico: se queda en RAW, como hasta ahora.
        else 'RAW'::public.weight_basis
      end,
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
$FN$;

-- ---------------------------------------------------------------------------
-- 4. [B-1b] Conversiones entre bases físicas: explícitas o no existen
-- ---------------------------------------------------------------------------
--
-- El único puente que había era COOKED→RAW vía `ingredient_yields`. Para
-- EDIBLE_PORTION (plátano sin cáscara) y AS_PACKAGED (atún escurrido vs. lata)
-- no había ninguno, y una conversión 1:1 inventada está prohibida. Se crea el
-- lugar donde ANOTAR el factor real. Nace vacía a propósito: sin fila, no hay
-- conversión y el faltante se registra como faltante, no se disimula.

create table public.ingredient_basis_conversions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid references public.households (id) on delete cascade,  -- NULL = global
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  from_basis    public.weight_basis not null,
  to_basis      public.weight_basis not null,
  -- cantidad_en_to = cantidad_en_from × factor
  factor        numeric(8, 4) not null check (factor > 0),
  source_name   text,
  notes         text,
  created_at    timestamptz not null default now(),
  constraint basis_conversion_distinct check (from_basis <> to_basis)
);

create unique index ingredient_basis_conv_global_uniq
  on public.ingredient_basis_conversions (ingredient_id, from_basis, to_basis)
  where household_id is null;
create unique index ingredient_basis_conv_hh_uniq
  on public.ingredient_basis_conversions (household_id, ingredient_id, from_basis, to_basis)
  where household_id is not null;

alter table public.ingredient_basis_conversions enable row level security;

create policy basis_conv_select on public.ingredient_basis_conversions
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));

create policy basis_conv_write on public.ingredient_basis_conversions
  for all to authenticated
  using (household_id is not null and app.is_household_member(household_id))
  with check (household_id is not null and app.is_household_member(household_id));

comment on table public.ingredient_basis_conversions is
  'Factor EXPLÍCITO entre dos bases físicas del mismo alimento. Sin fila no hay '
  'conversión: el consumo deja faltante visible en vez de inventar un 1:1.';

/** Factor from→to para este hogar (el del hogar le gana al global). NULL = no se sabe. */
create or replace function app.basis_factor(
  p_ingredient uuid,
  p_from public.weight_basis,
  p_to public.weight_basis,
  p_household uuid
) returns numeric language sql stable security definer set search_path = public as $$
  select c.factor
  from public.ingredient_basis_conversions c
  where c.ingredient_id = p_ingredient
    and c.from_basis = p_from
    and c.to_basis = p_to
    and (c.household_id is null or c.household_id = p_household)
  order by (c.household_id is not null) desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 5. [M-2] Preferencia de cocción: un upsert que de verdad actualiza
-- ---------------------------------------------------------------------------
--
-- `unique (member_id, ingredient_id, category_id, cooking_method)` con NULLS
-- DISTINCT nunca choca, porque el CHECK obliga a que uno de los dos objetivos
-- sea NULL. Resultado: cambiar de opinión creaba una fila más y el motor leía
-- cualquiera de ellas. Se corrige con índices parciales + un RPC que compara
-- los NULL como iguales.

create unique index if not exists cooking_pref_ingredient_uniq
  on public.member_cooking_preferences (member_id, ingredient_id, cooking_method)
  where ingredient_id is not null;
create unique index if not exists cooking_pref_category_uniq
  on public.member_cooking_preferences (member_id, category_id, cooking_method)
  where category_id is not null;
create unique index if not exists cooking_pref_global_uniq
  on public.member_cooking_preferences (member_id, cooking_method)
  where ingredient_id is null and category_id is null;

-- Limpieza de los duplicados que el upsert roto pudo dejar: se conserva la
-- ÚLTIMA opinión de cada persona, que es la que ella cree que está guardada.
-- La tabla no tiene created_at y el upsert roto solo INSERTABA (nunca
-- actualizó), así que el orden físico ES el orden en que se opinó.
delete from public.member_cooking_preferences p
where exists (
  select 1 from public.member_cooking_preferences q
  where q.member_id = p.member_id
    and q.cooking_method = p.cooking_method
    and q.ingredient_id is not distinct from p.ingredient_id
    and q.category_id is not distinct from p.category_id
    and q.ctid > p.ctid
);

create or replace function public.set_cooking_preference(
  p_member_id      uuid,
  p_ingredient_id  uuid,
  p_category_id    uuid,
  p_cooking_method public.cooking_method,
  p_stance         public.cooking_stance
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_id uuid;
begin
  select household_id into v_household
  from public.household_members where id = p_member_id;
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;
  if p_ingredient_id is not null and p_category_id is not null then
    raise exception 'una preferencia apunta a un alimento o a una categoría, no a ambos';
  end if;
  if not app.ingredient_in_scope(p_ingredient_id, v_household) then
    raise exception 'el alimento no pertenece a este hogar';
  end if;

  update public.member_cooking_preferences
  set stance = p_stance
  where member_id = p_member_id
    and cooking_method = p_cooking_method
    and ingredient_id is not distinct from p_ingredient_id
    and category_id is not distinct from p_category_id
  returning id into v_id;

  if v_id is null then
    insert into public.member_cooking_preferences
      (member_id, ingredient_id, category_id, cooking_method, stance)
    values
      (p_member_id, p_ingredient_id, p_category_id, p_cooking_method, p_stance)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

