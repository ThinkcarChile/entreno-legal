-- Hotfix final Sprint 7 — desajuste entre consumo declarado e inventario.
--
-- El consumo de una comida y el inventario físico son DOS fuentes distintas y
-- ninguna falsifica a la otra. Cuando la comida declara consumir X y FEFO solo
-- encuentra Y en los lotes:
--
--   * se consumen los Y que existen (el stock jamás baja de cero);
--   * el consumo declarado sigue siendo X — las porciones congeladas no se
--     tocan y el pronóstico leerá X, no Y;
--   * la diferencia queda PERSISTIDA como `shortfall = X − Y`, con alimento,
--     unidad, base, comida, porción y fecha;
--   * el desajuste se muestra y la persona decide: ajustar inventario o
--     aceptarlo como consumo no trazado.
--
-- Además, FEFO solo toca lotes de base física compatible. La única conversión
-- permitida es EXPLÍCITA: demanda cocida contra lotes crudos con rendimiento
-- conocido en `ingredient_yields`. Sin rendimiento no hay 1:1 inventado —
-- UNKNOWN nunca equivale a 1:1 (§47 del Sprint 6, ahora también al consumir).

-- ---------------------------------------------------------------------------
-- El desajuste como dato de primera clase
-- ---------------------------------------------------------------------------

create table public.consumption_shortfalls (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references public.households (id) on delete cascade,
  consumption_log_id uuid references public.consumption_logs (id) on delete set null,
  assignment_id      uuid references public.meal_assignments (id) on delete set null,
  projection_id      uuid references public.member_serving_projections (id) on delete set null,
  ingredient_id      uuid references public.ingredients (id) on delete set null,
  label              text not null,
  -- Cantidad FALTANTE, en la unidad y base de la DEMANDA (no del lote).
  quantity           numeric(12, 3) not null check (quantity > 0),
  unit               text not null check (unit in ('G', 'ML', 'UNIT')),
  weight_basis       public.weight_basis not null,
  serving_date       date,
  status             text not null default 'OPEN'
    check (status in ('OPEN', 'RESOLVED_ADJUSTMENT', 'ACCEPTED_UNTRACED')),
  resolved_by        uuid references public.household_members (id) on delete set null,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now()
);

create index shortfalls_open_idx
  on public.consumption_shortfalls (household_id) where status = 'OPEN';

comment on table public.consumption_shortfalls is
  'La comida declaró consumir X y la despensa solo tenía Y: acá vive X−Y, '
  'visible hasta que alguien lo resuelva. El consumo declarado (las porciones '
  'congeladas) NUNCA se reduce a Y: el pronóstico lee X.';

alter table public.consumption_shortfalls enable row level security;
create policy shortfalls_select on public.consumption_shortfalls
  for select to authenticated using (app.is_household_member(household_id));
-- Escritura solo vía RPC.

/** Resolver un desajuste: ajusté el inventario, o lo acepto como no trazado. */
create or replace function public.resolve_shortfall(
  p_shortfall_id uuid,
  p_resolution   text
) returns void language plpgsql security definer set search_path = public as $$
declare v_household uuid; v_status text;
begin
  select household_id, status into v_household, v_status
  from public.consumption_shortfalls where id = p_shortfall_id for update;

  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;
  if v_status <> 'OPEN' then
    raise exception 'este desajuste ya se resolvió (%)', v_status;
  end if;
  if p_resolution not in ('RESOLVED_ADJUSTMENT', 'ACCEPTED_UNTRACED') then
    raise exception 'resolución desconocida: ajuste de inventario o consumo no trazado';
  end if;

  update public.consumption_shortfalls
  set status = p_resolution,
      resolved_by = app.current_member_id(v_household),
      resolved_at = now()
  where id = p_shortfall_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- consume_planned_meal v2: bases compatibles, conversión explícita, shortfall
-- ---------------------------------------------------------------------------

-- Cambia el tipo de retorno (int → jsonb con el detalle del desajuste).
drop function if exists public.consume_planned_meal(uuid);

create or replace function public.consume_planned_meal(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_member uuid;
  v_proj record;
  v_comp record;
  v_lot record;
  v_log uuid;
  v_pendiente numeric;   -- lo que falta cubrir, en la base de la DEMANDA
  v_toma numeric;        -- cuánto se saca del lote, en la base del LOTE
  v_factor numeric;
  v_count int := 0;
  v_shortfalls jsonb := '[]'::jsonb;
begin
  select p.household_id into v_household
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  where a.id = p_assignment_id;

  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  v_member := app.current_member_id(v_household);

  for v_proj in
    select * from public.member_serving_projections
    where assignment_id = p_assignment_id and status = 'PLANNED'
  loop
    insert into public.consumption_logs
      (household_id, member_id, assignment_id, projection_id, kind, logged_by)
    values (v_household, v_proj.member_id, p_assignment_id, v_proj.id, 'PLANNED', v_member)
    on conflict (projection_id) where projection_id is not null do nothing
    returning id into v_log;

    if v_log is null then continue; end if; -- ya registrada: no-op (K-22)

    update public.member_serving_projections
    set status = 'CONSUMED' where id = v_proj.id;

    for v_comp in
      select * from public.member_serving_components
      where projection_id = v_proj.id and ingredient_id is not null
        and proposed_quantity > 0
    loop
      v_pendiente := v_comp.proposed_quantity;

      -- Pasada 1: lotes de EXACTAMENTE la misma representación
      -- (unidad + base física). FEFO del baseline.
      for v_lot in
        select l.* from public.inventory_lots l
        where l.household_id = v_household
          and l.ingredient_id = v_comp.ingredient_id
          and l.unit = v_comp.unit::text
          and l.weight_basis = v_comp.weight_basis
          and l.status = 'AVAILABLE' and l.quantity > 0
        order by l.use_by asc nulls last, l.expiry_date asc nulls last, l.created_at asc
      loop
        exit when v_pendiente <= 0;
        v_toma := least(v_pendiente, v_lot.quantity);
        insert into public.inventory_movements
          (household_id, lot_id, reason, delta, idempotency_key,
           consumption_log_id, actor_member_id)
        values
          (v_household, v_lot.id, 'CONSUMED', -v_toma,
           'CONSUME:' || v_proj.id::text || ':' || v_comp.id::text || ':' || v_lot.id::text,
           v_log, v_member);
        v_pendiente := v_pendiente - v_toma;
      end loop;

      -- Pasada 2: conversión EXPLÍCITA cocido→crudo, solo con rendimiento
      -- conocido (el del hogar le gana al global; el del método al genérico).
      -- Sin rendimiento no se toca ningún lote crudo: UNKNOWN nunca es 1:1.
      if v_pendiente > 0 and v_comp.weight_basis = 'COOKED' then
        select y.yield_factor into v_factor
        from public.ingredient_yields y
        where y.ingredient_id = v_comp.ingredient_id
          and (y.household_id is null or y.household_id = v_household)
          and (y.cooking_method is null or y.cooking_method = v_comp.cooking_method)
        order by (y.household_id is not null) desc, (y.cooking_method is not null) desc
        limit 1;

        if v_factor is not null and v_factor > 0 then
          for v_lot in
            select l.* from public.inventory_lots l
            where l.household_id = v_household
              and l.ingredient_id = v_comp.ingredient_id
              and l.unit = v_comp.unit::text
              and l.weight_basis = 'RAW'
              and l.status = 'AVAILABLE' and l.quantity > 0
            order by l.use_by asc nulls last, l.expiry_date asc nulls last, l.created_at asc
          loop
            exit when v_pendiente <= 0;
            -- crudo necesario para cubrir lo cocido pendiente
            v_toma := least(v_pendiente / v_factor, v_lot.quantity);
            insert into public.inventory_movements
              (household_id, lot_id, reason, delta, idempotency_key,
               consumption_log_id, actor_member_id, notes)
            values
              (v_household, v_lot.id, 'CONSUMED', -v_toma,
               'CONSUME:' || v_proj.id::text || ':' || v_comp.id::text || ':' || v_lot.id::text,
               v_log, v_member,
               'conversión explícita cocido→crudo ×' || v_factor::text);
            v_pendiente := v_pendiente - (v_toma * v_factor);
          end loop;
        end if;
      end if;

      -- El faltante NO se calla ni reduce el consumo declarado: se persiste.
      -- (Tolerancia de 1 miligramo para el ruido de la aritmética.)
      if v_pendiente > 0.001 then
        insert into public.consumption_shortfalls
          (household_id, consumption_log_id, assignment_id, projection_id,
           ingredient_id, label, quantity, unit, weight_basis, serving_date)
        values
          (v_household, v_log, p_assignment_id, v_proj.id,
           v_comp.ingredient_id, v_comp.label, round(v_pendiente, 3),
           v_comp.unit::text, v_comp.weight_basis, v_proj.serving_date);

        v_shortfalls := v_shortfalls || jsonb_build_object(
          'label', v_comp.label,
          'quantity', round(v_pendiente, 3),
          'unit', v_comp.unit::text,
          'weight_basis', v_comp.weight_basis::text
        );
      end if;
    end loop;

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    update public.meal_assignments set status = 'SERVED' where id = p_assignment_id;
  end if;

  return jsonb_build_object('servings', v_count, 'shortfalls', v_shortfalls);
end;
$$;
