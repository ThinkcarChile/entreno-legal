-- Sprint 6 — ShoppingEngine: listas de compras desde porciones confirmadas.
--
-- Además aplica las dos precisiones finales del Sprint 5:
--
--   §0A  Los parámetros de una estrategia de evento (+25% de margen, -10%
--        alrededor) dejan de ser constantes enterradas: cada porción confirmada
--        conserva la configuración EFECTIVA con la que se calculó, versionada.
--        Cambiar el default mañana no reescribe semanas históricas.
--   §0B  "Sin filas = todos" vale para una comida SIN confirmar. Al confirmar,
--        el conjunto de participantes se resuelve y se CONGELA en filas
--        explícitas: agregar un sexto integrante al hogar no lo mete
--        retroactivamente en una comida ya confirmada.
--
-- Y una corrección estructural que el ShoppingEngine necesita (§3): la
-- identidad del ALIMENTO REAL de cada componente servido se congela en la
-- propia fila. Hasta ahora había que reconstruirla cruzando la receta y las
-- sustituciones — dos joins con `on delete set null` en el camino, es decir,
-- dos maneras de que la lista de compras agrupe mal en silencio.

-- ---------------------------------------------------------------------------
-- §0A Configuración efectiva del evento en la porción confirmada
-- ---------------------------------------------------------------------------

alter table public.member_serving_projections
  add column event_effect jsonb;

comment on column public.member_serving_projections.event_effect is
  'Efecto de evento aplicado al calcular esta porción, con su versión y '
  'parámetros: {strategy_version, kind, event_id, event_title, params: '
  '{energy_ceiling_multiplier, around_target_multiplier, minimum_floor_policy}}. '
  'NULL = ningún evento afectó el cálculo. Congelado: cambiar los defaults no '
  'reescribe historia.';

-- ---------------------------------------------------------------------------
-- §3 Identidad real del alimento servido, congelada
-- ---------------------------------------------------------------------------

alter table public.member_serving_components
  add column ingredient_id uuid references public.ingredients (id) on delete set null,
  add column product_id    uuid references public.commercial_products (id) on delete set null;

comment on column public.member_serving_components.ingredient_id is
  'El alimento que ESTA persona come de verdad, ya con la sustitución aplicada. '
  'Es la identidad por la que agrupa el ShoppingEngine: si Sebastián reemplazó '
  'pollo por merluza, acá dice merluza.';

-- Backfill de lo ya confirmado: primero la identidad de la receta...
update public.member_serving_components c
set ingredient_id = mc.ingredient_id,
    product_id    = mc.product_id
from public.meal_slot_components mc
where mc.id = c.component_id and c.ingredient_id is null and c.product_id is null;

-- ...y encima la sustitución aceptada, que es lo que realmente se comió.
update public.member_serving_components c
set ingredient_id = s.to_ingredient_id
from public.member_serving_substitutions s
where s.projection_id = c.projection_id
  and s.component_id is not distinct from c.component_id
  and s.component_id is not null;

-- ---------------------------------------------------------------------------
-- Rendimientos crudo → cocido (§4, §6)
-- ---------------------------------------------------------------------------

create table public.ingredient_yields (
  id             uuid primary key default gen_random_uuid(),
  ingredient_id  uuid not null references public.ingredients (id) on delete cascade,
  -- NULL = vale para cualquier método; una fila con método le gana a la genérica.
  cooking_method public.cooking_method,
  -- peso cocido = peso crudo × yield_factor
  yield_factor   numeric(8, 4) not null check (yield_factor > 0),
  notes          text,
  created_at     timestamptz not null default now()
);

create unique index ingredient_yields_specific_uniq
  on public.ingredient_yields (ingredient_id, cooking_method)
  where cooking_method is not null;
create unique index ingredient_yields_generic_uniq
  on public.ingredient_yields (ingredient_id)
  where cooking_method is null;

comment on table public.ingredient_yields is
  'Rendimiento crudo→cocido por alimento (y opcionalmente por método). Si para '
  'una demanda cocida no hay factor, el ShoppingEngine marca la línea '
  'PURCHASE_QUANTITY_UNRESOLVED: nunca inventa 1.0 (§47).';

alter table public.ingredient_yields enable row level security;
create policy yields_select on public.ingredient_yields
  for select to authenticated using (true);
-- Curados por seed/admin de la app por ahora: sin política de escritura.

-- ---------------------------------------------------------------------------
-- Listas de compras (§15, §24)
-- ---------------------------------------------------------------------------

create type public.shopping_list_status as enum
  ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');

create type public.shopping_item_status as enum
  ('PENDING', 'PURCHASED', 'SKIPPED', 'HAVE_ENOUGH');

create type public.shopping_item_source as enum ('FOOD_PLAN', 'MANUAL');

create type public.purchase_basis as enum
  ('RAW', 'COMMERCIAL_PACKAGE', 'UNIT', 'DRAINED', 'OTHER');

-- La lista debe pertenecer al MISMO hogar que su semana: sin esto, un hogar
-- ajeno podría "ocupar" el plan de otro (unique plan_id) y bloquearle la lista.
alter table public.weekly_plans
  add constraint weekly_plans_id_household_uniq unique (id, household_id);

create table public.shopping_lists (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  plan_id      uuid not null,
  constraint shopping_lists_plan_same_household
    foreign key (plan_id, household_id)
    references public.weekly_plans (id, household_id) on delete cascade,
  status       public.shopping_list_status not null default 'ACTIVE',
  -- Revisión vigente. 0 = todavía sin generar.
  current_revision int not null default 0,
  created_by   uuid references public.household_members (id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  -- Una lista por semana: regenerar crea revisiones, no listas paralelas.
  constraint shopping_lists_one_per_plan unique (plan_id)
);

create table public.shopping_list_revisions (
  id              uuid primary key default gen_random_uuid(),
  list_id         uuid not null references public.shopping_lists (id) on delete cascade,
  revision_number int not null,
  -- FNV-1a de las entradas: mismas porciones confirmadas + mismos rendimientos
  -- = misma firma = no se genera una revisión duplicada (§51).
  input_signature text not null,
  engine_version  text not null,
  -- Qué cambió respecto de la revisión anterior, para poder auditarlo (§25).
  reasons         jsonb not null default '[]'::jsonb,
  -- La demanda calculada completa, congelada. La v1 sigue siendo auditable
  -- después de generar la v2 (§49).
  payload         jsonb not null,
  created_by      uuid references public.household_members (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint shopping_revisions_numbered unique (list_id, revision_number)
);

create table public.shopping_list_items (
  id                uuid primary key default gen_random_uuid(),
  list_id           uuid not null references public.shopping_lists (id) on delete cascade,
  source            public.shopping_item_source not null default 'FOOD_PLAN',

  -- Clave estable de la línea de demanda (identidad::unidad::base). Es lo que
  -- permite regenerar la lista SIN perder el estado del checklist: el mismo
  -- alimento conserva su "comprado" aunque cambie la cantidad. NULL en manuales.
  line_key          text,

  -- Identidad del alimento/producto real (§3). Un item MANUAL puede no tener
  -- ninguna de las dos (detergente).
  ingredient_id     uuid references public.ingredients (id) on delete set null,
  product_id        uuid references public.commercial_products (id) on delete set null,
  label             text not null check (char_length(label) between 1 and 200),
  unit              text not null check (unit in ('G', 'ML', 'UNIT')),

  -- §21: lo que el cálculo dice que se necesita NUNCA se pierde...
  required_quantity numeric(12, 3) check (required_quantity >= 0),
  -- ...y lo que el comprador decide comprar va aparte.
  planned_quantity  numeric(12, 3) check (planned_quantity >= 0),

  purchase_basis    public.purchase_basis not null default 'RAW',
  -- Necesidad culinaria cuando difiere de la de compra (§5): "750 g cocidos".
  cooked_quantity   numeric(12, 3) check (cooked_quantity >= 0),
  -- Factor usado en la conversión, congelado para poder explicarla (§6).
  yield_factor      numeric(8, 4) check (yield_factor > 0),
  unresolved        boolean not null default false,
  unresolved_reason text,

  -- De dónde sale cada gramo (§16): [{assignment_id, date, meal_type,
  -- quantity, members}]. Vacío para items manuales.
  provenance        jsonb not null default '[]'::jsonb,

  status            public.shopping_item_status not null default 'PENDING',
  status_reason     text,
  purchased_at      timestamptz,
  purchased_by      uuid references public.household_members (id) on delete set null,
  added_by          uuid references public.household_members (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index shopping_items_by_list on public.shopping_list_items (list_id);
create unique index shopping_items_line_uniq
  on public.shopping_list_items (list_id, line_key) where line_key is not null;

-- §22: toda edición manual de cantidad queda auditada.
create table public.shopping_item_overrides (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references public.shopping_list_items (id) on delete cascade,
  original_quantity numeric(12, 3),
  new_quantity      numeric(12, 3),
  changed_by        uuid references public.household_members (id) on delete set null,
  changed_at        timestamptz not null default now(),
  reason            text
);

create index shopping_overrides_by_item on public.shopping_item_overrides (item_id);

-- ---------------------------------------------------------------------------
-- RLS (§37, §50): ver = integrante del hogar; modificar = SHOPPER o ADMIN
-- ---------------------------------------------------------------------------

create or replace function app.shopping_household(p_list uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.shopping_lists where id = p_list;
$$;

create or replace function app.can_manage_shopping(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.household_members m
    join public.member_role_assignments a on a.member_id = m.id
    join public.household_roles r on r.id = a.role_id
    where m.household_id = hid and m.user_id = auth.uid() and m.is_active
      -- el rol tiene que ser DE ESTE hogar: un rol de otro hogar no cuenta
      and r.household_id = m.household_id
      and (r.is_admin or r.can_manage_shopping)
  );
$$;

-- Mismo anclaje para el chequeo de admin del Sprint 1, que tenía el mismo hueco.
create or replace function app.is_household_admin(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.household_members m
    join public.member_role_assignments a on a.member_id = m.id
    join public.household_roles r on r.id = a.role_id
    where m.household_id = hid and m.user_id = auth.uid() and m.is_active
      and r.household_id = m.household_id
      and r.is_admin
  );
$$;

alter table public.shopping_lists          enable row level security;
alter table public.shopping_list_revisions enable row level security;
alter table public.shopping_list_items     enable row level security;
alter table public.shopping_item_overrides enable row level security;

create policy shopping_lists_select on public.shopping_lists
  for select to authenticated using (app.is_household_member(household_id));
create policy shopping_lists_write on public.shopping_lists
  for all to authenticated
  using (app.can_manage_shopping(household_id))
  with check (app.can_manage_shopping(household_id));

create policy shopping_revisions_select on public.shopping_list_revisions
  for select to authenticated using (app.is_household_member(app.shopping_household(list_id)));
-- Solo INSERT: una revisión es historia y la historia no se edita ni se borra
-- (§49). Sin política de update/delete, RLS los deja en cero filas.
create policy shopping_revisions_insert on public.shopping_list_revisions
  for insert to authenticated
  with check (app.can_manage_shopping(app.shopping_household(list_id)));

create policy shopping_items_select on public.shopping_list_items
  for select to authenticated using (app.is_household_member(app.shopping_household(list_id)));
create policy shopping_items_write on public.shopping_list_items
  for all to authenticated
  using (app.can_manage_shopping(app.shopping_household(list_id)))
  with check (app.can_manage_shopping(app.shopping_household(list_id)));

create policy shopping_overrides_select on public.shopping_item_overrides
  for select to authenticated
  using (exists (select 1 from public.shopping_list_items i
                 where i.id = item_id
                   and app.is_household_member(app.shopping_household(i.list_id))));
create policy shopping_overrides_write on public.shopping_item_overrides
  for insert to authenticated
  with check (exists (select 1 from public.shopping_list_items i
                      where i.id = item_id
                        and app.can_manage_shopping(app.shopping_household(i.list_id))));

-- ---------------------------------------------------------------------------
-- Identidad de auditoría: la pone la base, no el cliente
-- ---------------------------------------------------------------------------
--
-- changed_by/purchased_by podrían falsificarse llamando a PostgREST directo
-- con el token propio y el member_id de otra persona. El sello lo estampa
-- SIEMPRE la base con quién está autenticado de verdad.

create or replace function app.stamp_shopping_override()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.changed_by := app.current_member_id(app.shopping_household(
    (select list_id from public.shopping_list_items where id = new.item_id)));
  new.changed_at := now();
  return new;
end;
$$;

create trigger shopping_override_stamp
  before insert on public.shopping_item_overrides
  for each row execute function app.stamp_shopping_override();

create or replace function app.stamp_shopping_item()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_member uuid;
begin
  v_member := app.current_member_id(app.shopping_household(new.list_id));
  if tg_op = 'INSERT' and new.source = 'MANUAL' then
    new.added_by := v_member;
  end if;
  if new.status = 'PURCHASED' and (tg_op = 'INSERT' or old.status is distinct from 'PURCHASED') then
    new.purchased_by := v_member;
    new.purchased_at := coalesce(new.purchased_at, now());
  end if;
  return new;
end;
$$;

create trigger shopping_item_stamp
  before insert or update on public.shopping_list_items
  for each row execute function app.stamp_shopping_item();

-- ---------------------------------------------------------------------------
-- Regenerar la lista en UNA transacción
-- ---------------------------------------------------------------------------
--
-- Si esto fuera una secuencia de escrituras desde la aplicación, un fallo a
-- mitad de camino dejaría la revisión N insertada con la cabecera apuntando a
-- N-1: el próximo intento chocaría con el unique y la lista quedaría muerta.
-- Acá o pasa todo o no pasa nada.

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

  v_numero := v_numero + 1;

  insert into public.shopping_list_revisions
    (list_id, revision_number, input_signature, engine_version, reasons, payload, created_by)
  values (p_list_id, v_numero, p_signature, p_engine,
          coalesce(p_reasons, '[]'::jsonb), p_payload,
          app.current_member_id(v_household));

  -- Upsert de cada línea por su clave estable: el checklist sobrevive.
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

  -- Lo que ya no tiene demanda se retira (§14)… salvo lo YA COMPRADO: la
  -- compra ocurrió y borrarla destruiría el registro y su auditoría
  -- (§22/§35). Queda con demanda 0, visible como comprado.
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

-- Editar la cantidad de compra con su auditoría, juntas o ninguna (§21, §22).
create or replace function public.set_planned_quantity(
  p_item_id  uuid,
  p_quantity numeric,
  p_reason   text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_status public.shopping_list_status;
  v_original numeric;
begin
  select app.shopping_household(i.list_id), l.status,
         coalesce(i.planned_quantity, i.required_quantity)
  into v_household, v_status, v_original
  from public.shopping_list_items i
  join public.shopping_lists l on l.id = i.list_id
  where i.id = p_item_id
  for update of i;

  if v_household is null then raise exception 'producto inexistente'; end if;
  if not app.can_manage_shopping(v_household) then raise exception 'no autorizado'; end if;
  if v_status = 'COMPLETED' then
    raise exception 'Esta compra ya se finalizó: la lista quedó cerrada.'
      using errcode = 'check_violation';
  end if;
  if p_quantity is not null and p_quantity < 0 then
    raise exception 'la cantidad no puede ser negativa';
  end if;

  update public.shopping_list_items
  set planned_quantity = p_quantity, updated_at = now()
  where id = p_item_id;

  insert into public.shopping_item_overrides (item_id, original_quantity, new_quantity, reason)
  values (p_item_id, v_original, p_quantity, nullif(trim(p_reason), ''));
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_meal_assignment v3: congela participantes (§0B), identidad de
-- alimento (§3) y configuración de evento (§0A)
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

  -- §0B: al confirmar, "todos" deja de ser implícito. El conjunto de
  -- participantes se resuelve AHORA y se congela en filas explícitas: un
  -- integrante que entre al hogar mañana no aparece en esta comida.
  insert into public.meal_assignment_participants (assignment_id, member_id)
  select p_assignment_id, mp.member_id
  from public.meal_participants(p_assignment_id) mp
  on conflict do nothing;

  delete from public.member_serving_projections where assignment_id = p_assignment_id;

  for v_serving in select * from jsonb_array_elements(coalesce(p_servings, '[]'::jsonb)) loop
    insert into public.member_serving_projections (
      member_id, version_id, profile_id, daily_plan_id, optimizer_version,
      meal_type, serving_date, fit, adaptation_level, score,
      nutrition, completeness, reasons, unmet_constraints,
      assignment_id, status, event_effect
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
      'PLANNED',
      case when v_serving->'event_effect' = 'null'::jsonb then null
           else v_serving->'event_effect' end
    ) returning id into v_projection;

    for v_component in select * from jsonb_array_elements(coalesce(v_serving->'components', '[]'::jsonb)) loop
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
        coalesce((v_component->>'unit')::public.nutrition_basis_unit, 'G'),
        coalesce((v_component->>'weight_basis')::public.weight_basis, 'RAW'),
        (nullif(v_component->>'cooking_method', ''))::public.cooking_method,
        (v_component->>'added_fat_g')::numeric,
        nullif(v_component->>'substituted_for', '')::uuid,
        coalesce((v_component->>'sort_order')::int, 1),
        nullif(v_component->>'ingredient_id', '')::uuid,
        nullif(v_component->>'product_id', '')::uuid
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

-- ---------------------------------------------------------------------------
-- Rendimientos de referencia para los alimentos del seed (valores aproximados
-- de tablas culinarias; el hogar podrá curarlos después). Solo los que se
-- conocen con confianza razonable: para el resto, el motor dice "no sé" (§47).
-- ---------------------------------------------------------------------------

insert into public.ingredient_yields (ingredient_id, cooking_method, yield_factor, notes)
select i.id, m.metodo::public.cooking_method, m.factor, m.nota
from public.ingredients i
join (values
  ('arroz blanco',   'BOILED', 2.8,  'arroz blanco hervido ~2,8x su peso crudo'),
  ('fideos',         'BOILED', 2.4,  'fideos hervidos ~2,4x su peso crudo'),
  ('lentejas',       'BOILED', 2.5,  'lentejas cocidas ~2,5x su peso seco')
) as m(nombre, metodo, factor, nota) on i.canonical_name = m.nombre
where i.household_id is null
on conflict do nothing;
