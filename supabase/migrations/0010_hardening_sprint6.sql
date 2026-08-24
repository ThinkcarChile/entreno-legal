-- Hardening post-Sprint 6 — cuatro correcciones antes del Sprint 7.
--
--   1. Una porción confirmada NO convierte datos faltantes en 'G'/'RAW': sin
--      unidad o sin base de peso, la confirmación falla con mensaje claro.
--   2. ingredient_yields gana procedencia (fuente, estado de verificación) y
--      ámbito por hogar. La historia no cambia: cada revisión de lista ya
--      congela el factor usado en su payload.
--   3. Los RPC SECURITY DEFINER validan que todo UUID venido del cliente
--      pertenezca al hogar o sea un recurso global: un hogar no puede
--      referenciar perfiles, planes, recetas ni alimentos privados de otro.
--   4. Un alimento o producto usado por el historial no puede borrarse:
--      se archiva (is_active = false). El borrado silencioso vía cascadas
--      de `on delete set null` queda bloqueado por trigger.

-- ---------------------------------------------------------------------------
-- 2. Procedencia y ámbito de los rendimientos
-- ---------------------------------------------------------------------------

alter table public.ingredient_yields
  add column source              text not null default 'SEED_REFERENCE',
  add column verification_status text not null default 'UNVERIFIED'
    check (verification_status in ('UNVERIFIED', 'VERIFIED', 'HOUSEHOLD_MEASURED')),
  -- NULL = factor global curado; con valor = medido por un hogar (futuro).
  add column household_id        uuid references public.households (id) on delete cascade,
  add column updated_at          timestamptz not null default now();

comment on column public.ingredient_yields.source is
  'De dónde salió el factor: SEED_REFERENCE (tabla culinaria del seed), o la '
  'fuente que declare quien lo cure. Un factor sin fuente no es un dato.';

-- Los del seed quedan declarados como lo que son: referencia culinaria sin
-- verificación propia.
update public.ingredient_yields
set source = 'SEED_REFERENCE', verification_status = 'UNVERIFIED'
where household_id is null;

-- Unicidad por ámbito: el factor global y el del hogar conviven; el del hogar
-- podrá ganar cuando exista curado en la app.
drop index if exists ingredient_yields_specific_uniq;
drop index if exists ingredient_yields_generic_uniq;
create unique index ingredient_yields_global_specific_uniq
  on public.ingredient_yields (ingredient_id, cooking_method)
  where cooking_method is not null and household_id is null;
create unique index ingredient_yields_global_generic_uniq
  on public.ingredient_yields (ingredient_id)
  where cooking_method is null and household_id is null;
create unique index ingredient_yields_hh_specific_uniq
  on public.ingredient_yields (household_id, ingredient_id, cooking_method)
  where cooking_method is not null and household_id is not null;
create unique index ingredient_yields_hh_generic_uniq
  on public.ingredient_yields (household_id, ingredient_id)
  where cooking_method is null and household_id is not null;

-- Un hogar ve los globales y los suyos, nunca los de otro.
drop policy if exists yields_select on public.ingredient_yields;
create policy yields_select on public.ingredient_yields
  for select to authenticated
  using (household_id is null or app.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- 3a. Validadores de ámbito
-- ---------------------------------------------------------------------------

/** ¿Este alimento es global o del hogar? NULL de entrada = válido (opcional). */
create or replace function app.ingredient_in_scope(p_ingredient uuid, p_household uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_ingredient is null or exists (
    select 1 from public.ingredients i
    where i.id = p_ingredient
      and (i.household_id is null or i.household_id = p_household)
  );
$$;

create or replace function app.product_in_scope(p_product uuid, p_household uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_product is null or exists (
    select 1 from public.commercial_products p
    where p.id = p_product
      and (p.household_id is null or p.household_id = p_household)
  );
$$;

/** ¿La versión de receta es global o del hogar? */
create or replace function app.version_in_scope(p_version uuid, p_household uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_version is null or exists (
    select 1
    from public.meal_template_versions v
    join public.meal_templates t on t.id = v.template_id
    where v.id = p_version
      and (t.household_id is null or t.household_id = p_household)
  );
$$;

-- ---------------------------------------------------------------------------
-- 1 + 3b. confirm_meal_assignment v4: datos completos y UUIDs del ámbito
-- ---------------------------------------------------------------------------

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
  select p.household_id into v_household
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  where a.id = p_assignment_id;

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

-- ---------------------------------------------------------------------------
-- 3c. generate_shopping_revision v2: los items también respetan el ámbito
-- ---------------------------------------------------------------------------

create or replace function public.generate_shopping_revision(
  p_list_id   uuid,
  p_signature text,
  p_engine    text,
  p_reasons   jsonb,
  p_payload   jsonb,
  p_items     jsonb
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_status public.shopping_list_status;
  v_numero int;
  v_item jsonb;
  v_claves text[];
begin
  select household_id, status, current_revision
  into v_household, v_status, v_numero
  from public.shopping_lists where id = p_list_id
  for update;

  if v_household is null then raise exception 'lista inexistente'; end if;
  if not app.can_manage_shopping(v_household) then raise exception 'no autorizado'; end if;
  if v_status = 'COMPLETED' then
    raise exception 'Esta compra ya se finalizó: la lista quedó cerrada.'
      using errcode = 'check_violation';
  end if;

  -- §51: mismas entradas, misma lista. No se duplica nada.
  if exists (select 1 from public.shopping_list_revisions
             where list_id = p_list_id and revision_number = v_numero
               and input_signature = p_signature) then
    return v_numero;
  end if;

  -- Hardening 3: ningún item puede referenciar alimentos/productos privados
  -- de otro hogar.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if not app.ingredient_in_scope(nullif(v_item->>'ingredient_id', '')::uuid, v_household) then
      raise exception 'el alimento "%" no pertenece a este hogar', v_item->>'label';
    end if;
    if not app.product_in_scope(nullif(v_item->>'product_id', '')::uuid, v_household) then
      raise exception 'el producto "%" no pertenece a este hogar', v_item->>'label';
    end if;
  end loop;

  v_numero := v_numero + 1;

  insert into public.shopping_list_revisions
    (list_id, revision_number, input_signature, engine_version, reasons, payload, created_by)
  values (p_list_id, v_numero, p_signature, p_engine,
          coalesce(p_reasons, '[]'::jsonb), p_payload,
          app.current_member_id(v_household));

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.shopping_list_items (
      list_id, source, line_key, ingredient_id, product_id, label, unit,
      required_quantity, purchase_basis, cooked_quantity, yield_factor,
      unresolved, unresolved_reason, provenance
    ) values (
      p_list_id, 'FOOD_PLAN',
      v_item->>'line_key',
      nullif(v_item->>'ingredient_id', '')::uuid,
      nullif(v_item->>'product_id', '')::uuid,
      v_item->>'label',
      v_item->>'unit',
      (v_item->>'required_quantity')::numeric,
      (v_item->>'purchase_basis')::public.purchase_basis,
      nullif(v_item->>'cooked_quantity', '')::numeric,
      nullif(v_item->>'yield_factor', '')::numeric,
      coalesce((v_item->>'unresolved')::boolean, false),
      v_item->>'unresolved_reason',
      coalesce(v_item->'provenance', '[]'::jsonb)
    )
    on conflict (list_id, line_key) where line_key is not null
    do update set
      label = excluded.label,
      unit = excluded.unit,
      required_quantity = excluded.required_quantity,
      purchase_basis = excluded.purchase_basis,
      cooked_quantity = excluded.cooked_quantity,
      yield_factor = excluded.yield_factor,
      unresolved = excluded.unresolved,
      unresolved_reason = excluded.unresolved_reason,
      provenance = excluded.provenance,
      updated_at = now();
  end loop;

  select array_agg(x->>'line_key')
  into v_claves
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x;

  update public.shopping_list_items
  set required_quantity = 0, provenance = '[]'::jsonb,
      unresolved = false, unresolved_reason = null, updated_at = now()
  where list_id = p_list_id and source = 'FOOD_PLAN'
    and line_key is not null
    and (v_claves is null or not (line_key = any (v_claves)))
    and status = 'PURCHASED';

  delete from public.shopping_list_items
  where list_id = p_list_id and source = 'FOOD_PLAN'
    and line_key is not null
    and (v_claves is null or not (line_key = any (v_claves)))
    and status <> 'PURCHASED';

  update public.shopping_lists
  set current_revision = v_numero, status = 'ACTIVE'
  where id = p_list_id;

  return v_numero;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Política de borrado histórico: se archiva, no se borra
-- ---------------------------------------------------------------------------

create or replace function app.protect_historical_ingredient()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.member_serving_components c where c.ingredient_id = old.id)
     or exists (select 1 from public.shopping_list_items i where i.ingredient_id = old.id)
     or exists (select 1 from public.member_serving_substitutions s
                where s.to_ingredient_id = old.id or s.from_ingredient_id = old.id) then
    raise exception
      'El alimento "%" está en el historial (porciones o compras): archívalo con is_active = false en vez de borrarlo.',
      old.display_name
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

create trigger ingredients_protect_history
  before delete on public.ingredients
  for each row execute function app.protect_historical_ingredient();

create or replace function app.protect_historical_product()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.member_serving_components c where c.product_id = old.id)
     or exists (select 1 from public.shopping_list_items i where i.product_id = old.id) then
    raise exception
      'El producto "%" está en el historial (porciones o compras): archívalo con is_active = false en vez de borrarlo.',
      old.name
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

create trigger products_protect_history
  before delete on public.commercial_products
  for each row execute function app.protect_historical_product();
