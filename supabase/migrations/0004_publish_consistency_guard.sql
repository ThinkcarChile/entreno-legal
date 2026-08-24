-- Sprint 3 (corrección) — No se publica una receta que no se puede calcular.
--
-- Descubierto al probar contra Supabase real: el aceite de oliva tiene su ficha
-- por 100 ML y el seed lo pedía en gramos. El motor se negaba a convertir (bien:
-- g y ml no se mezclan sin densidad), pero el problema solo aparecía al abrir la
-- receta. Publicar es el momento correcto para exigir coherencia, porque es
-- cuando la versión se vuelve inmutable: después ya no hay dónde arreglarla.

create or replace function public.publish_meal_template_version(p_version_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_template uuid;
  v_household uuid;
  v_components int;
  v_bad text;
begin
  if not app.can_write_version(p_version_id) then
    raise exception 'no autorizado o la versión no es un borrador';
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

  -- La cantidad tiene que estar en la MISMA representación que su ficha: misma
  -- unidad (g/ml) y misma base (crudo/cocido). Si no, el cálculo sería inventado.
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
      'La cantidad de % no coincide con la base de su ficha nutricional (unidad o estado). Corrígelo antes de publicar.',
      v_bad;
  end if;

  -- Congelar la ficha usada: una corrección posterior del catálogo no puede
  -- reescribir la nutrición de esta versión (ADR 0002 §3).
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
$$;
