-- Integration Gate 0→10 — corrección del CANARIO (§50).
--
-- Síntoma observado en la app real: Sebastián tiene un "no me gusta" del pollo,
-- la pantalla de porciones propone merluza, se toca "Aplicar", la porción se
-- recalcula a 360 g de merluza… y al confirmar la comida desde la semana queda
-- guardado POLLO (321 g). Cero rastro de la decisión.
--
-- Causa: la aceptación del reemplazo vivía SOLO en un query param de la vista
-- de porciones. `confirmMeal(assignmentId)` se llamaba sin ella desde la
-- semana, así que el motor recalculaba sin sustituciones. La decisión también
-- se perdía al recargar la página o si confirmaba otra persona de la casa.
--
-- Corrección: la aceptación es una DECISIÓN de la familia y se persiste como
-- tal, junto a la comida a la que pertenece. Confirmar la lee de la base.
--
-- No modifica migraciones congeladas: solo agrega una tabla y sus RPC.

create table public.meal_substitution_choices (
  id               uuid primary key default gen_random_uuid(),
  assignment_id    uuid not null references public.meal_assignments (id) on delete cascade,
  member_id        uuid not null references public.household_members (id) on delete cascade,
  -- El componente de la receta que se reemplaza (identidad de la plantilla).
  component_id     uuid not null references public.meal_slot_components (id) on delete cascade,
  to_ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  reason_code      text not null default 'SOFT_PREFERENCE',
  chosen_by        uuid references public.household_members (id) on delete set null,
  chosen_at        timestamptz not null default now(),
  constraint meal_substitution_choices_uniq unique (assignment_id, member_id, component_id)
);

create index meal_substitution_choices_assignment_idx
  on public.meal_substitution_choices (assignment_id);

alter table public.meal_substitution_choices enable row level security;

/** Hogar dueño de una comida planificada. */
create or replace function app.assignment_household(p_assignment uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select w.household_id
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans w on w.id = d.plan_id
  where a.id = p_assignment;
$$;

create policy meal_substitution_choices_select on public.meal_substitution_choices
  for select to authenticated
  using (app.is_household_member(app.assignment_household(assignment_id)));
-- Escritura solo por RPC: valida ámbito y estampa quién eligió.

/**
 * Aceptar un reemplazo para UNA persona en UNA comida. Idempotente: repetir la
 * misma elección no duplica ni cambia quién la tomó primero.
 *
 * Valida que la comida, el integrante, el componente y el alimento destino
 * pertenezcan al mismo hogar (o sean globales): un UUID del cliente jamás
 * entra sin revisar.
 */
create or replace function public.set_substitution_choice(
  p_assignment_id    uuid,
  p_member_id        uuid,
  p_component_id     uuid,
  p_to_ingredient_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_id uuid;
begin
  v_household := app.assignment_household(p_assignment_id);
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;
  if not exists (
    select 1 from public.household_members m
    where m.id = p_member_id and m.household_id = v_household
  ) then
    raise exception 'no autorizado';
  end if;
  if not app.ingredient_in_scope(p_to_ingredient_id, v_household) then
    raise exception 'el alimento no pertenece a este hogar';
  end if;
  -- El componente tiene que ser de la receta que esta comida tiene puesta.
  if not exists (
    select 1
    from public.meal_assignments a
    join public.meal_slots s on s.version_id = a.version_id
    join public.meal_slot_components c on c.slot_id = s.id
    where a.id = p_assignment_id and c.id = p_component_id
  ) then
    raise exception 'ese componente no pertenece a la receta de esta comida';
  end if;
  -- Una porción ya servida es historia: no se le cambia el alimento.
  if exists (
    select 1 from public.member_serving_projections
    where assignment_id = p_assignment_id and member_id = p_member_id
      and status in ('SERVED', 'CONSUMED')
  ) then
    raise exception 'esa porción ya se sirvió: su historia no se reescribe'
      using errcode = 'check_violation';
  end if;

  insert into public.meal_substitution_choices
    (assignment_id, member_id, component_id, to_ingredient_id, chosen_by)
  values
    (p_assignment_id, p_member_id, p_component_id, p_to_ingredient_id,
     app.current_member_id(v_household))
  on conflict (assignment_id, member_id, component_id)
  do update set to_ingredient_id = excluded.to_ingredient_id
  returning id into v_id;

  return v_id;
end;
$$;

/** Deshacer el reemplazo (volver al alimento de la receta). */
create or replace function public.clear_substitution_choice(
  p_assignment_id uuid,
  p_member_id     uuid,
  p_component_id  uuid
) returns void language plpgsql security definer set search_path = public as $$
declare v_household uuid;
begin
  v_household := app.assignment_household(p_assignment_id);
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;
  delete from public.meal_substitution_choices
  where assignment_id = p_assignment_id
    and member_id = p_member_id
    and component_id = p_component_id;
end;
$$;
