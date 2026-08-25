-- Sprint 11 — Final Live Closure §3: el ajuste clínico llega a COMPRAS
-- sin filtrar una sola letra clínica.
--
-- Regla de divulgación (§44/§83): quien compra necesita la CANTIDAD y un
-- motivo neutro. Jamás el biomarcador, el resultado, el diagnóstico ni la
-- nota médica. El reason code es exactamente eso: `CLINICAL_ADJUSTMENT`.
--
-- Regla física (§38/§39): una revisión clínica NO mueve realidad. Este RPC
-- toca líneas de compra PENDIENTES y su bitácora de cambios; jamás lotes,
-- movimientos de inventario ni paquetes preparados.
--
-- No modifica migraciones congeladas.

/**
 * Aplica el delta de compra derivado de una revisión clínica.
 *
 * `p_deltas`: [{ ingredient_id, unit, delta_quantity }]. El signo manda:
 * negativo baja la línea, positivo la sube. Solo se tocan líneas PENDING de
 * listas vivas del hogar — lo ya comprado es historia (§38).
 *
 * Devuelve el resumen de lo aplicado para poder mostrarlo, con reason code
 * neutro y CERO datos clínicos.
 */
create or replace function public.apply_clinical_shopping_delta(
  p_review_id uuid,
  p_deltas    jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_r public.clinical_impact_reviews;
  v_d jsonb;
  v_item public.shopping_list_items;
  v_actor uuid;
  v_antes numeric;
  v_nueva numeric;
  v_aplicados jsonb := '[]'::jsonb;
  v_sin_linea jsonb := '[]'::jsonb;
begin
  select * into v_r from public.clinical_impact_reviews where id = p_review_id for update;
  if v_r.id is null or not app.medical_access(v_r.member_id, 'VIEW_CLINICAL_RESTRICTIONS') then
    raise exception 'no autorizado';
  end if;
  v_actor := app.current_member_id(v_r.household_id);

  for v_d in select * from jsonb_array_elements(coalesce(p_deltas, '[]'::jsonb)) loop
    -- La línea PENDIENTE de una lista viva de ESTE hogar, para ese alimento.
    select li.* into v_item
    from public.shopping_list_items li
    join public.shopping_lists sl on sl.id = li.list_id
    where sl.household_id = v_r.household_id
      and sl.status in ('DRAFT', 'ACTIVE')
      and li.status = 'PENDING'
      and li.ingredient_id = (v_d->>'ingredient_id')::uuid
      and li.unit = (v_d->>'unit')
    order by li.created_at desc
    limit 1
    for update;

    if v_item.id is null then
      -- No hay línea que ajustar: se DICE, no se inventa una compra.
      v_sin_linea := v_sin_linea || jsonb_build_object(
        'ingredient_id', v_d->>'ingredient_id',
        'delta', (v_d->>'delta_quantity')::numeric);
      continue;
    end if;

    v_antes := coalesce(v_item.planned_quantity, v_item.required_quantity, 0);
    v_nueva := greatest(0, v_antes + (v_d->>'delta_quantity')::numeric);

    update public.shopping_list_items
    set planned_quantity = v_nueva, updated_at = now()
    where id = v_item.id;

    -- Bitácora: motivo NEUTRO. Nada de biomarcadores ni diagnósticos.
    insert into public.shopping_item_overrides
      (item_id, original_quantity, new_quantity, changed_by, reason)
    values
      (v_item.id, v_antes, v_nueva, v_actor, 'CLINICAL_ADJUSTMENT');

    v_aplicados := v_aplicados || jsonb_build_object(
      'item_id', v_item.id,
      'label', v_item.label,
      'antes', v_antes,
      'ahora', v_nueva,
      'delta', v_nueva - v_antes,
      'unit', v_item.unit,
      'reason_code', 'CLINICAL_ADJUSTMENT');
  end loop;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_r.household_id, auth.uid(), 'CLINICAL_SHOPPING_ADJUSTED', 'clinical_impact_review', p_review_id,
          jsonb_build_object('lineas', jsonb_array_length(v_aplicados)));

  return jsonb_build_object(
    'applied', v_aplicados,
    'no_line_found', v_sin_linea,
    'reason_code', 'CLINICAL_ADJUSTMENT');
end;
$$;

comment on function public.apply_clinical_shopping_delta(uuid, jsonb) is
  'Ajusta cantidades de compra por decisión clínica. El motivo que ve quien '
  'compra es CLINICAL_ADJUSTMENT: sin biomarcador, sin valor, sin diagnóstico. '
  'No toca lotes ni movimientos de inventario.';
