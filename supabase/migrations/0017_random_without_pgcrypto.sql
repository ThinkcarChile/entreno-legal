-- Sprint 10 — corrección encontrada en la DEMO VIVA (2026-08-25).
--
-- Síntoma: porcionar el pollo en la app real fallaba con
--   "function gen_random_bytes(integer) does not exist".
--
-- Causa: `gen_random_bytes` pertenece a pgcrypto. En PGlite la cargamos
-- explícitamente (por eso los 518 tests pasaban), pero en Supabase pgcrypto
-- vive en el schema `extensions` y estas funciones son SECURITY DEFINER con
-- `set search_path = public`: no la alcanzan. Un caso de libro de "el entorno
-- de pruebas resuelve algo que el real no".
--
-- Corrección: eliminar la dependencia. `gen_random_uuid()` es NATIVA desde
-- PostgreSQL 13 y usa el CSPRNG del sistema; un UUIDv4 sin guiones da 32
-- caracteres hex con 122 bits de entropía — mismo formato y mismo largo que
-- el token anterior, sin extensión de por medio.
--
-- No modifica 0013/0014/0015/0016: reemplaza dos cuerpos de función.

/**
 * Token opaco del lote para el QR (§35-§37). Se genera una sola vez.
 * 32 hex de gen_random_uuid(): sin pgcrypto, sin secuencias, sin datos del hogar.
 */
create or replace function public.ensure_lot_token(p_lot_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots; v_token text;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_lot.qr_token is not null then return v_lot.qr_token; end if;
  v_token := replace(gen_random_uuid()::text, '-', '');
  update public.inventory_lots set qr_token = v_token where id = p_lot_id;
  return v_token;
end;
$$;

/**
 * complete_prep_task sin pgcrypto: el código visible del paquete (§41) sale
 * de los primeros 8 hex de un UUID aleatorio. Todo lo demás queda idéntico.
 */
create or replace function public.complete_prep_task(
  p_task_id         uuid,
  p_actual_quantity numeric default null,
  p_outputs         jsonb default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_task public.batch_prep_tasks;
  v_household uuid;
  v_member uuid;
  v_lot public.inventory_lots;
  v_dep_status text;
  v_input numeric;
  v_output numeric;
  v_waste numeric;
  v_cause text;
  v_target uuid;
  v_pkg jsonb;
  v_cantidades numeric[] := '{}';
  v_hijos uuid[];
  v_hijo uuid;
  v_i int := 0;
  v_result jsonb;
  v_codes text[] := '{}';
  v_code text;
  v_loc uuid;
  v_kind public.storage_kind;
begin
  select t.* into v_task from public.batch_prep_tasks t where t.id = p_task_id for update;
  if v_task.id is null then raise exception 'no autorizado'; end if;
  v_household := app.prep_plan_household(v_task.plan_id);
  if not app.is_household_member(v_household) then raise exception 'no autorizado'; end if;

  -- Idempotencia: la segunda confirmación devuelve lo YA registrado.
  if v_task.status = 'DONE' then return v_task.result; end if;
  if v_task.status in ('SKIPPED', 'CANCELLED') then
    raise exception 'esta tarea está % — reábrela desde el plan si corresponde', v_task.status;
  end if;

  -- §14: no congelar un paquete que aún no existe.
  if v_task.depends_on is not null then
    select status into v_dep_status from public.batch_prep_tasks where id = v_task.depends_on;
    if v_dep_status is distinct from 'DONE' and v_dep_status is distinct from 'SKIPPED' then
      raise exception 'primero completa el paso del que depende esta tarea';
    end if;
  end if;

  v_member := app.current_member_id(v_household);
  v_result := jsonb_build_object();

  if v_task.lot_id is not null then
    select * into v_lot from public.inventory_lots where id = v_task.lot_id for update;
    if v_lot.household_id is distinct from v_household then raise exception 'no autorizado'; end if;
  end if;

  if v_task.task_type in ('PEEL','TRIM','CUT','SHRED','SLICE','DICE') then
    if v_lot.id is null then raise exception 'esta tarea necesita un lote de origen'; end if;
    v_input := coalesce(p_actual_quantity, v_task.planned_quantity, v_lot.quantity);
    perform app.assert_finite(v_input, 'la cantidad preparada');
    if v_input <= 0 or v_input > v_lot.quantity then
      raise exception 'la cantidad preparada (%) no calza con el lote (%)', v_input, v_lot.quantity;
    end if;
    v_output := coalesce(nullif(p_outputs->>'output_quantity', '')::numeric, v_input);
    v_waste := coalesce(nullif(p_outputs->>'waste_quantity', '')::numeric, v_input - v_output);
    perform app.assert_finite(v_output, 'lo utilizable');
    if v_output < 0 then
      raise exception 'lo utilizable no puede ser negativo';
    end if;
    if v_waste < -0.001 or abs((v_output + v_waste) - v_input) > 0.001 then
      raise exception 'no cuadra: entrada % = utilizable % + merma % (§44)', v_input, v_output, v_waste;
    end if;
    v_cause := coalesce(nullif(p_outputs->>'waste_cause', ''), 'PREP_LOSS');
    if v_cause not in ('PEEL', 'TRIM', 'PREP_LOSS') then
      raise exception 'causa de merma desconocida: %', v_cause;
    end if;

    if abs(v_input - v_lot.quantity) <= 0.001 then
      v_target := v_lot.id;
    else
      v_hijos := public.split_lot(v_lot.id, array[v_input]);
      v_target := v_hijos[1];
    end if;

    if v_waste > 0.001 then
      insert into public.inventory_movements
        (household_id, lot_id, reason, delta, actor_member_id, notes)
      values (v_household, v_target, 'PREP_LOSS', -v_waste, v_member, v_cause);
    end if;
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, actor_member_id, notes)
    values (v_household, v_target, 'TRANSFORM', 0, v_member, v_task.task_type);
    update public.inventory_lots
    set processing_state = 'PREPPED', updated_at = now() where id = v_target;

    v_result := jsonb_build_object('lot_id', v_target, 'output_quantity', v_output,
                                   'waste_quantity', v_waste, 'waste_cause', v_cause);
    perform app.emit_event(v_household, 'LOT_PREPPED', 'inventory_lot',
      jsonb_build_object('lot_id', v_target, 'task_id', v_task.id, 'task_type', v_task.task_type),
      'LOT_PREPPED:' || v_task.id::text);

  elsif v_task.task_type in ('PORTION', 'PACK') then
    if v_lot.id is null then raise exception 'esta tarea necesita un lote de origen'; end if;
    if p_outputs is null or jsonb_array_length(coalesce(p_outputs->'packages', '[]'::jsonb)) = 0 then
      raise exception 'porcionar necesita los paquetes reales (cantidad de cada uno)';
    end if;
    for v_pkg in select * from jsonb_array_elements(p_outputs->'packages') loop
      perform app.assert_finite((v_pkg->>'quantity')::numeric, 'un paquete');
      v_cantidades := v_cantidades || (v_pkg->>'quantity')::numeric;
      if nullif(v_pkg->>'intended_assignment_id', '') is not null and not exists (
        select 1 from public.meal_assignments a
        join public.weekly_plan_days d on d.id = a.day_id
        join public.weekly_plans w on w.id = d.plan_id
        where a.id = (v_pkg->>'intended_assignment_id')::uuid and w.household_id = v_household
      ) then raise exception 'no autorizado'; end if;
      if nullif(v_pkg->>'location_id', '') is not null and not exists (
        select 1 from public.storage_locations
        where id = (v_pkg->>'location_id')::uuid and household_id = v_household
      ) then raise exception 'la ubicación no pertenece a este hogar'; end if;
    end loop;

    v_hijos := public.split_lot(v_lot.id, v_cantidades);
    perform app.emit_event(v_household, 'LOT_SPLIT', 'inventory_lot',
      jsonb_build_object('parent_lot_id', v_lot.id, 'children', to_jsonb(v_hijos), 'task_id', v_task.id),
      'LOT_SPLIT:' || v_task.id::text);

    for v_pkg in select * from jsonb_array_elements(p_outputs->'packages') loop
      v_i := v_i + 1;
      v_hijo := v_hijos[v_i];
      -- Sin pgcrypto: 8 hex de un UUID aleatorio.
      v_code := 'PKG-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      update public.inventory_lots
      set package_code = v_code,
          intended_use_date = nullif(v_pkg->>'intended_use_date', '')::date,
          intended_assignment_id = nullif(v_pkg->>'intended_assignment_id', '')::uuid,
          updated_at = now()
      where id = v_hijo;
      v_codes := v_codes || v_code;

      if coalesce((v_pkg->>'vacuum')::boolean, false) then
        update public.inventory_lots set vacuum_sealed = true where id = v_hijo;
        insert into public.inventory_movements
          (household_id, lot_id, reason, delta, actor_member_id, notes)
        values (v_household, v_hijo, 'TRANSFORM', 0, v_member, 'VACUUM_SEAL');
      end if;
      if nullif(v_pkg->>'location_id', '') is not null then
        perform public.move_lot(v_hijo, (v_pkg->>'location_id')::uuid);
      end if;
    end loop;

    v_result := jsonb_build_object('child_lot_ids', to_jsonb(v_hijos),
                                   'package_codes', to_jsonb(v_codes));

  elsif v_task.task_type = 'VACUUM_SEAL' then
    if v_lot.id is null then raise exception 'esta tarea necesita un lote'; end if;
    update public.inventory_lots set vacuum_sealed = true, updated_at = now() where id = v_lot.id;
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, actor_member_id, notes)
    values (v_household, v_lot.id, 'TRANSFORM', 0, v_member, 'VACUUM_SEAL');
    v_result := jsonb_build_object('lot_id', v_lot.id);

  elsif v_task.task_type in ('REFRIGERATE', 'FREEZE') then
    if v_lot.id is null then raise exception 'esta tarea necesita un lote'; end if;
    v_loc := nullif(p_outputs->>'location_id', '')::uuid;
    if v_loc is null then
      v_kind := case when v_task.task_type = 'FREEZE' then 'FREEZER' else 'FRIDGE' end;
      select id into v_loc from public.storage_locations
      where household_id = v_household and kind = v_kind
      order by sort_order limit 1;
      if v_loc is null then raise exception 'este hogar no tiene una ubicación %', v_kind; end if;
    end if;
    perform public.move_lot(v_lot.id, v_loc);
    v_result := jsonb_build_object('lot_id', v_lot.id, 'location_id', v_loc);
    perform app.emit_event(v_household, 'LOT_MOVED', 'inventory_lot',
      jsonb_build_object('lot_id', v_lot.id, 'location_id', v_loc, 'task_id', v_task.id),
      'LOT_MOVED:' || v_task.id::text);

  else
    v_result := jsonb_build_object('lot_id', v_task.lot_id);
  end if;

  update public.batch_prep_tasks
  set status = 'DONE',
      completed_quantity = coalesce(p_actual_quantity, v_task.planned_quantity),
      completed_by = v_member,
      completed_at = now(),
      result = v_result
  where id = p_task_id;

  update public.batch_prep_plans p
  set status = case
        when not exists (select 1 from public.batch_prep_tasks t
                         where t.plan_id = p.id and t.status = 'PENDING')
        then 'COMPLETED'::public.prep_plan_status
        else 'IN_PROGRESS'::public.prep_plan_status
      end,
      updated_at = now()
  where p.id = v_task.plan_id and p.status in ('READY', 'IN_PROGRESS', 'DRAFT');

  return v_result;
end;
$$;
