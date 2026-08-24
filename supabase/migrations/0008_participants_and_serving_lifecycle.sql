-- QA Sprint 5 — Participantes por comida y ciclo de vida de una porción.
--
-- Tres huecos que encontró la revisión adversarial:
--
--   §2  Una comida familiar asumía que comen todos. El sábado que Francisco
--       tiene un cumpleaños afuera, el sistema le generaba porción igual y la
--       sumaba al total a cocinar. Eso llega tal cual al ShoppingEngine.
--   §13 Una porción solo podía estar PLANNED, SERVED o SKIPPED, y reconfirmar
--       borraba y reescribía sin mirar el estado: se podía pisar en silencio una
--       porción que ya se había comido.
--   §18 Cambiar o cancelar un evento no dejaba ninguna marca sobre las comidas
--       ya confirmadas de ese día.

-- ---------------------------------------------------------------------------
-- §2 Participantes de una comida
-- ---------------------------------------------------------------------------

create table public.meal_assignment_participants (
  assignment_id uuid not null references public.meal_assignments (id) on delete cascade,
  member_id     uuid not null references public.household_members (id) on delete cascade,
  primary key (assignment_id, member_id)
);

comment on table public.meal_assignment_participants is
  'Quiénes comen esta comida. SIN filas = comen todos los integrantes activos, '
  'que es el caso normal y evita escribir cinco filas por cada almuerzo. Con '
  'filas = solo esas personas.';

create index assignment_participants_member_idx
  on public.meal_assignment_participants (member_id);

alter table public.meal_assignment_participants enable row level security;

create policy assignment_participants_all on public.meal_assignment_participants
  for all to authenticated
  using (app.is_household_member(app.assignment_household(assignment_id)))
  with check (app.is_household_member(app.assignment_household(assignment_id)));

/** Quiénes participan de una comida, resolviendo el caso "sin filas = todos". */
create or replace function public.meal_participants(p_assignment_id uuid)
returns table (member_id uuid) language sql stable security definer set search_path = public as $$
  select p.member_id
  from public.meal_assignment_participants p
  where p.assignment_id = p_assignment_id
  union all
  select m.id
  from public.household_members m
  where m.household_id = app.assignment_household(p_assignment_id)
    and m.is_active
    and not exists (
      select 1 from public.meal_assignment_participants x where x.assignment_id = p_assignment_id
    );
$$;

-- ---------------------------------------------------------------------------
-- §13 Ciclo de vida de una porción
-- ---------------------------------------------------------------------------

-- Una porción ya servida o consumida es historia: no se reescribe.
alter type public.serving_status add value if not exists 'CONSUMED';
alter type public.serving_status add value if not exists 'CANCELLED';

-- §12 y §18: trazabilidad de reconfirmaciones y marca de revisión.
alter table public.meal_assignments
  add column confirm_count int not null default 0,
  add column last_confirmed_at timestamptz,
  add column needs_review boolean not null default false,
  add column review_reason text;

comment on column public.meal_assignments.needs_review is
  'Algo cambió alrededor de esta comida ya confirmada (por ejemplo un evento de '
  'ese día). No se reescriben sus porciones: se marca para que alguien decida.';

-- ---------------------------------------------------------------------------
-- Confirmar: solo participantes, y jamás sobre una porción ya servida
-- ---------------------------------------------------------------------------
--
-- Las comparaciones con los estados nuevos van por `::text` a propósito: un
-- valor de enum recién agregado no puede usarse como literal en la misma
-- transacción que lo creó, y esta migración crea CONSUMED y CANCELLED.

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
  where assignment_id = p_assignment_id and status::text in ('SERVED', 'CONSUMED');

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

  delete from public.member_serving_projections where assignment_id = p_assignment_id;

  for v_serving in select * from jsonb_array_elements(coalesce(p_servings, '[]'::jsonb)) loop
    insert into public.member_serving_projections (
      member_id, version_id, profile_id, daily_plan_id, optimizer_version,
      meal_type, serving_date, fit, adaptation_level, score,
      nutrition, completeness, reasons, unmet_constraints,
      assignment_id, status
    ) values (
      (v_serving->>'member_id')::uuid,
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
      'PLANNED'
    ) returning id into v_projection;

    for v_component in select * from jsonb_array_elements(coalesce(v_serving->'components', '[]'::jsonb)) loop
      insert into public.member_serving_components (
        projection_id, component_id, label, base_quantity, proposed_quantity,
        unit, weight_basis, cooking_method, added_fat_g, substituted_for, sort_order
      ) values (
        v_projection,
        nullif(v_component->>'component_id', '')::uuid,
        v_component->>'label',
        (v_component->>'base_quantity')::numeric,
        (v_component->>'proposed_quantity')::numeric,
        coalesce((v_component->>'unit')::public.nutrition_basis_unit, 'G'),
        coalesce((v_component->>'weight_basis')::public.weight_basis, 'RAW'),
        (nullif(v_component->>'cooking_method', ''))::public.cooking_method,
        (v_component->>'added_fat_g')::numeric,
        nullif(v_component->>'substituted_for', '')::uuid,
        coalesce((v_component->>'sort_order')::int, 1)
      );
    end loop;

    for v_sub in select * from jsonb_array_elements(coalesce(v_serving->'substitutions', '[]'::jsonb)) loop
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

-- Deshacer tampoco puede borrar historia.
create or replace function public.unconfirm_meal_assignment(p_assignment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_household uuid; v_servidas int;
begin
  select p.household_id into v_household
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  where a.id = p_assignment_id;

  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  select count(*) into v_servidas
  from public.member_serving_projections
  where assignment_id = p_assignment_id and status::text in ('SERVED', 'CONSUMED');

  if v_servidas > 0 then
    raise exception 'Esta comida ya se sirvió: no se puede deshacer'
      using errcode = 'check_violation';
  end if;

  delete from public.member_serving_projections where assignment_id = p_assignment_id;
  update public.meal_assignments
  set status = 'PLANNED', confirmed_at = null, confirmed_by = null,
      last_confirmed_at = null, needs_review = false, review_reason = null
  where id = p_assignment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- §18 Cambiar un evento marca para revisión, no reescribe
-- ---------------------------------------------------------------------------

create or replace function app.flag_meals_on_event_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_fecha date;
  v_motivo text;
begin
  v_household := coalesce(new.household_id, old.household_id);
  v_fecha := coalesce(new.event_date, old.event_date);
  v_motivo := case tg_op
    when 'INSERT' then 'Se agregó un evento ese día'
    when 'UPDATE' then 'Cambió un evento de ese día'
    else 'Se canceló un evento de ese día'
  end;

  -- Las porciones confirmadas NO se tocan: se marca la comida para que una
  -- persona decida si vale la pena recalcular.
  update public.meal_assignments a
  set needs_review = true, review_reason = v_motivo
  from public.weekly_plan_days d
  join public.weekly_plans p on p.id = d.plan_id
  where a.day_id = d.id
    and p.household_id = v_household
    and d.plan_date = v_fecha
    and a.status in ('CONFIRMED', 'SERVED');

  return coalesce(new, old);
end;
$$;

create trigger events_flag_meals
  after insert or update or delete on public.nutrition_events
  for each row execute function app.flag_meals_on_event_change();
