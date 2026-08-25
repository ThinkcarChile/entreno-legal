-- Sprint 9 — Procurement / Abastecimiento.
--
-- Stock Intelligence dice "vas a necesitar X"; Procurement responde "qué
-- conviene pedir, cuánto, cuándo y a quién". Separación estricta:
--
--   Stock Intelligence → recomienda necesidad.
--   ProcurementEngine  → planifica abastecimiento (este sprint).
--   Shopping           → lista concreta de compra semanal.
--   Inventory          → existencia física (ledger, Sprint 7).
--   Receiving          → crea los lotes reales (MISMO mecanismo del Sprint 7).
--
-- Procurement jamás altera porciones ni objetivos nutricionales, jamás compra
-- solo (SUGGESTED requiere aceptación humana), y un pedido EN CAMINO no es
-- stock físico: recién al recibirse se vuelve lote.

-- ---------------------------------------------------------------------------
-- Proveedores
-- ---------------------------------------------------------------------------

create table public.suppliers (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 120),
  contact      text,
  notes        text,
  is_active    boolean not null default true,
  created_by   uuid references public.household_members (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint suppliers_name_uniq unique (household_id, name)
);

alter table public.suppliers enable row level security;
create policy suppliers_all on public.suppliers
  for all to authenticated
  using (app.is_household_member(household_id))
  with check (app.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Presentaciones por proveedor
-- ---------------------------------------------------------------------------

create table public.supplier_products (
  id                     uuid primary key default gen_random_uuid(),
  supplier_id            uuid not null references public.suppliers (id) on delete cascade,
  ingredient_id          uuid not null references public.ingredients (id) on delete restrict,
  -- "caja 5 kg", "bandeja 30 huevos": la etiqueta humana de la presentación.
  presentation           text not null check (char_length(presentation) between 1 and 120),
  -- Cantidad de UNA presentación, en unidad base (g / ml / unidades).
  package_quantity       numeric(12, 3) not null check (package_quantity > 0),
  unit                   text not null check (unit in ('G', 'ML', 'UNIT')),
  -- Base física de lo que se compra: el atún ESCURRIDO no es el pollo crudo.
  weight_basis           public.weight_basis not null default 'RAW',
  -- Precio por presentación. Opcional por ahora: sin comparador de precios.
  price                  numeric(12, 2) check (price >= 0),
  -- Pedido mínimo y múltiplo, en unidad base. NULL = sin restricción.
  minimum_order_quantity numeric(12, 3) check (minimum_order_quantity > 0),
  purchase_multiple      numeric(12, 3) check (purchase_multiple > 0),
  lead_time_days         int not null default 0 check (lead_time_days between 0 and 60),
  -- Días de entrega ISO: 1 = lunes … 7 = domingo. NULL/vacío = cualquier día.
  delivery_days          int[] check (delivery_days is null or delivery_days <@ array[1,2,3,4,5,6,7]),
  -- Menor = preferido, para elegir entre proveedores del mismo alimento.
  priority               int not null default 100,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint supplier_products_uniq unique (supplier_id, ingredient_id)
);

create index supplier_products_ingredient_idx on public.supplier_products (ingredient_id);

alter table public.supplier_products enable row level security;
create policy supplier_products_all on public.supplier_products
  for all to authenticated
  using (exists (select 1 from public.suppliers s
                 where s.id = supplier_id and app.is_household_member(s.household_id)))
  with check (exists (select 1 from public.suppliers s
                      where s.id = supplier_id and app.is_household_member(s.household_id)));

-- El alimento debe ser del ámbito del hogar del proveedor (o global): un
-- ingrediente privado de otro hogar no entra ni por PostgREST directo.
create or replace function app.validate_supplier_product_scope()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_household uuid;
begin
  select household_id into v_household from public.suppliers where id = new.supplier_id;
  if not app.ingredient_in_scope(new.ingredient_id, v_household) then
    raise exception 'el alimento no pertenece a este hogar';
  end if;
  return new;
end;
$$;

create trigger supplier_products_scope
  before insert or update on public.supplier_products
  for each row execute function app.validate_supplier_product_scope();

-- ---------------------------------------------------------------------------
-- Política de compra por alimento
-- ---------------------------------------------------------------------------
--
-- UNA fuente por dato (regla del proyecto): las CANTIDADES y la cobertura
-- objetivo viven en `stock_targets` (Sprint 8). La política de compra agrega
-- lo que es propio del ABASTECIMIENTO: proveedor preferido y calendario.
-- "Compra semanal" vs "abastecimiento quincenal" emerge de estas políticas
-- por producto — nada se hardcodea por categoría.

create table public.purchase_policies (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null references public.households (id) on delete cascade,
  ingredient_id         uuid not null references public.ingredients (id) on delete cascade,
  preferred_supplier_id uuid references public.suppliers (id) on delete set null,
  -- Días permitidos para PEDIR y para RECIBIR (ISO 1-7). NULL = cualquiera.
  order_days            int[] check (order_days is null or order_days <@ array[1,2,3,4,5,6,7]),
  receive_days          int[] check (receive_days is null or receive_days <@ array[1,2,3,4,5,6,7]),
  notes                 text,
  created_by            uuid references public.household_members (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint purchase_policies_uniq unique (household_id, ingredient_id)
);

alter table public.purchase_policies enable row level security;
create policy purchase_policies_all on public.purchase_policies
  for all to authenticated
  using (app.is_household_member(household_id))
  with check (app.is_household_member(household_id));

create or replace function app.validate_purchase_policy_scope()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not app.ingredient_in_scope(new.ingredient_id, new.household_id) then
    raise exception 'el alimento no pertenece a este hogar';
  end if;
  if new.preferred_supplier_id is not null and not exists (
    select 1 from public.suppliers s
    where s.id = new.preferred_supplier_id and s.household_id = new.household_id
  ) then
    raise exception 'el proveedor no pertenece a este hogar';
  end if;
  return new;
end;
$$;

create trigger purchase_policies_scope
  before insert or update on public.purchase_policies
  for each row execute function app.validate_purchase_policy_scope();

-- ---------------------------------------------------------------------------
-- Órdenes de abastecimiento
-- ---------------------------------------------------------------------------

create type public.procurement_status as enum
  ('SUGGESTED', 'PLANNED', 'ORDERED', 'READY', 'DELIVERING', 'RECEIVED', 'STORED', 'CANCELLED');

create table public.procurement_orders (
  id                     uuid primary key default gen_random_uuid(),
  household_id           uuid not null references public.households (id) on delete cascade,
  supplier_id            uuid references public.suppliers (id) on delete set null,
  -- El nombre se CONGELA al crear: un pedido histórico no cambia si el
  -- proveedor se renombra o se borra (misma regla que la etiqueta del lote).
  supplier_name          text,
  status                 public.procurement_status not null default 'PLANNED',
  -- Fecha recomendada de pedido y de llegada (DATE-only, día del hogar).
  order_date             date,
  expected_delivery_date date,
  -- Idempotencia de la aceptación: dos clics en "Aprobar" = UNA orden.
  dedupe_key             text,
  engine_version         text,
  notes                  text,
  created_by             uuid references public.household_members (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  received_at            timestamptz,
  cancelled_at           timestamptz
);

-- La clave vive mientras la orden viva: cancelar la LIBERA para que la misma
-- sugerencia pueda re-aprobarse como una orden nueva (jamás revivir la muerta).
create unique index procurement_orders_dedupe_uniq
  on public.procurement_orders (dedupe_key)
  where dedupe_key is not null and status <> 'CANCELLED';
create index procurement_orders_active_idx
  on public.procurement_orders (household_id, status);

create table public.procurement_order_items (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.procurement_orders (id) on delete cascade,
  ingredient_id       uuid not null references public.ingredients (id) on delete restrict,
  supplier_product_id uuid references public.supplier_products (id) on delete set null,
  label               text not null,
  -- Presentación CONGELADA al crear (la de supplier_products puede cambiar).
  presentation        text,
  -- La NECESIDAD calculada nunca se pierde (neta de pedidos en camino)…
  required_quantity   numeric(12, 3) not null check (required_quantity >= 0),
  -- …y lo SUGERIDO tras mínimo/múltiplo/envase va aparte (§17).
  suggested_quantity  numeric(12, 3) not null check (suggested_quantity > 0),
  unit                text not null check (unit in ('G', 'ML', 'UNIT')),
  -- Base física de lo pedido: al recibir, el lote nace en ESTA base, no en
  -- 'RAW' a ciegas (el atún escurrido llena el balde escurrido).
  weight_basis        public.weight_basis not null default 'RAW',
  package_count       int check (package_count > 0),
  -- Por qué esta cantidad, este proveedor, estas fechas (§23).
  provenance          jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now(),
  constraint procurement_items_uniq unique (order_id, ingredient_id)
);

-- Auditoría de transiciones: QUIÉN movió la orden, DESDE dónde y CUÁNDO.
-- Append-only: se escribe solo desde los RPC.
create table public.procurement_order_events (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.procurement_orders (id) on delete cascade,
  from_status     public.procurement_status,
  to_status       public.procurement_status not null,
  actor_member_id uuid references public.household_members (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index procurement_order_events_order_idx on public.procurement_order_events (order_id, created_at);

alter table public.procurement_orders       enable row level security;
alter table public.procurement_order_items  enable row level security;
alter table public.procurement_order_events enable row level security;

create or replace function app.procurement_household(p_order uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.procurement_orders where id = p_order;
$$;

create policy procurement_orders_select on public.procurement_orders
  for select to authenticated using (app.is_household_member(household_id));
create policy procurement_items_select on public.procurement_order_items
  for select to authenticated
  using (app.is_household_member(app.procurement_household(order_id)));
create policy procurement_events_select on public.procurement_order_events
  for select to authenticated
  using (app.is_household_member(app.procurement_household(order_id)));
-- Escritura solo vía RPC: transiciones de estado validadas y auditables.

-- ---------------------------------------------------------------------------
-- Ciclo de vida: transiciones explícitas, jamás saltos silenciosos (§13, §20)
-- ---------------------------------------------------------------------------

/** El día de HOY medido en la zona horaria del hogar (jamás la del servidor). */
create or replace function app.household_today(p_household uuid)
returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce(h.timezone, 'America/Santiago'))::date
  from public.households h where h.id = p_household;
$$;

/**
 * Crea una orden PLANNED desde una sugerencia aceptada. Idempotente por
 * dedupe_key: el segundo clic devuelve la orden existente, no crea otra.
 * Una orden CANCELADA no revive: su clave queda libre y se crea una nueva.
 *
 * Guardas anti-desactualización: la fecha de pedido no puede estar en el
 * pasado del hogar, y si el item declara `known_incoming` (lo que la pantalla
 * creía en camino), se compara contra lo VIVO — una pestaña vieja no aprueba
 * una necesidad ya cubierta por otra orden.
 */
create or replace function public.create_procurement_order(
  p_household_id           uuid,
  p_supplier_id            uuid,
  p_order_date             date,
  p_expected_delivery_date date,
  p_dedupe_key             text,
  p_engine_version         text,
  p_items                  jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_order uuid;
  v_member uuid;
  v_item jsonb;
  v_sp public.supplier_products;
  v_sp_id uuid;
  v_supplier_name text;
  v_live_incoming numeric;
  v_known numeric;
begin
  if not app.can_manage_shopping(p_household_id) then raise exception 'no autorizado'; end if;
  if p_supplier_id is not null then
    select name into v_supplier_name from public.suppliers s
    where s.id = p_supplier_id and s.household_id = p_household_id;
    if v_supplier_name is null then
      raise exception 'el proveedor no pertenece a este hogar';
    end if;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'una orden necesita al menos un producto';
  end if;
  if p_order_date is not null and p_order_date < app.household_today(p_household_id) then
    raise exception 'La sugerencia quedó desactualizada (fecha de pedido pasada): recarga la página.';
  end if;

  -- Idempotencia (§22): mismo dedupe_key = misma orden VIVA de ESTE hogar.
  -- Sin filtro de hogar sería un oráculo entre hogares; sin filtro de estado,
  -- re-aprobar tras cancelar devolvería la orden muerta como si fuera un éxito.
  if p_dedupe_key is not null then
    select id into v_order from public.procurement_orders
    where dedupe_key = p_dedupe_key and household_id = p_household_id
      and status <> 'CANCELLED';
    if v_order is not null then return v_order; end if;
  end if;

  v_member := app.current_member_id(p_household_id);

  begin
    insert into public.procurement_orders
      (household_id, supplier_id, supplier_name, status, order_date,
       expected_delivery_date, dedupe_key, engine_version, created_by)
    values
      (p_household_id, p_supplier_id, v_supplier_name, 'PLANNED', p_order_date,
       p_expected_delivery_date, p_dedupe_key, p_engine_version, v_member)
    returning id into v_order;
  exception when unique_violation then
    -- Carrera entre dos aprobaciones simultáneas: la que perdió relee.
    select id into v_order from public.procurement_orders
    where dedupe_key = p_dedupe_key and household_id = p_household_id
      and status <> 'CANCELLED';
    if v_order is not null then return v_order; end if;
    -- La clave existe pero en OTRO hogar: mensaje unificado, sin oráculo.
    raise exception 'no autorizado';
  end;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if not app.ingredient_in_scope((v_item->>'ingredient_id')::uuid, p_household_id) then
      raise exception 'el alimento "%" no pertenece a este hogar', v_item->>'label';
    end if;
    perform app.assert_finite((v_item->>'required_quantity')::numeric, 'la necesidad');
    perform app.assert_finite((v_item->>'suggested_quantity')::numeric, 'lo sugerido');

    -- La presentación citada debe ser coherente: de un proveedor de ESTE
    -- hogar, del proveedor de la orden, del mismo alimento y la misma unidad.
    v_sp := null;
    v_sp_id := nullif(v_item->>'supplier_product_id', '')::uuid;
    if v_sp_id is not null then
      select sp.* into v_sp
      from public.supplier_products sp
      join public.suppliers s on s.id = sp.supplier_id
      where sp.id = v_sp_id and s.household_id = p_household_id;
      if v_sp.id is null then
        raise exception 'no autorizado';
      end if;
      if p_supplier_id is not null and v_sp.supplier_id <> p_supplier_id then
        raise exception 'la presentación no es del proveedor de la orden';
      end if;
      if v_sp.ingredient_id <> (v_item->>'ingredient_id')::uuid
         or v_sp.unit <> (v_item->>'unit') then
        raise exception 'la presentación no corresponde al producto "%"', v_item->>'label';
      end if;
    end if;

    -- Anti-doble-aprobación desde una pantalla desactualizada: lo VIVO en
    -- camino para este alimento(+base) debe calzar con lo que vio quien aprueba.
    if v_item ? 'known_incoming' then
      v_known := (v_item->>'known_incoming')::numeric;
      select coalesce(sum(i.suggested_quantity), 0) into v_live_incoming
      from public.procurement_order_items i
      join public.procurement_orders o on o.id = i.order_id
      where o.household_id = p_household_id
        and o.id <> v_order
        and o.status in ('PLANNED', 'ORDERED', 'READY', 'DELIVERING')
        and i.ingredient_id = (v_item->>'ingredient_id')::uuid
        and i.unit = (v_item->>'unit')
        and i.weight_basis = coalesce(v_item->>'weight_basis', 'RAW')::public.weight_basis;
      if abs(v_live_incoming - coalesce(v_known, 0)) > 0.001 then
        raise exception 'La página quedó desactualizada (hay otra orden en camino): recarga antes de aprobar.';
      end if;
    end if;

    insert into public.procurement_order_items
      (order_id, ingredient_id, supplier_product_id, label, presentation,
       required_quantity, suggested_quantity, unit, weight_basis, package_count, provenance)
    values
      (v_order,
       (v_item->>'ingredient_id')::uuid,
       v_sp_id,
       v_item->>'label',
       v_sp.presentation,
       (v_item->>'required_quantity')::numeric,
       (v_item->>'suggested_quantity')::numeric,
       v_item->>'unit',
       coalesce(v_item->>'weight_basis', 'RAW')::public.weight_basis,
       nullif(v_item->>'package_count', '')::int,
       coalesce(v_item->'provenance', '[]'::jsonb));
  end loop;

  insert into public.procurement_order_events (order_id, from_status, to_status, actor_member_id)
  values (v_order, null, 'PLANNED', v_member);

  return v_order;
end;
$$;

/** Avanza una orden por su ciclo de vida. Solo transiciones permitidas. */
create or replace function public.advance_procurement_order(
  p_order_id   uuid,
  p_new_status public.procurement_status
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_actual public.procurement_status;
  v_ok boolean := false;
begin
  select household_id, status into v_household, v_actual
  from public.procurement_orders where id = p_order_id for update;

  if v_household is null or not app.can_manage_shopping(v_household) then
    raise exception 'no autorizado';
  end if;

  -- Reintento idempotente: pedir el estado en el que ya está es un no-op.
  if v_actual = p_new_status then return; end if;

  -- Mapa de transiciones (§13): READY/DELIVERING son opcionales, pero nada
  -- salta a RECEIVED/STORED por acá — recibir pasa por receive_procurement_order.
  v_ok := case v_actual
    when 'SUGGESTED'  then p_new_status in ('PLANNED', 'CANCELLED')
    when 'PLANNED'    then p_new_status in ('ORDERED', 'CANCELLED')
    when 'ORDERED'    then p_new_status in ('READY', 'DELIVERING', 'CANCELLED')
    when 'READY'      then p_new_status in ('DELIVERING', 'CANCELLED')
    when 'DELIVERING' then p_new_status in ('CANCELLED')
    when 'RECEIVED'   then p_new_status in ('STORED')
    else false
  end;
  if not v_ok then
    raise exception 'una orden % no puede pasar a %', v_actual, p_new_status;
  end if;

  update public.procurement_orders
  set status = p_new_status,
      cancelled_at = case when p_new_status = 'CANCELLED' then now() else cancelled_at end,
      updated_at = now()
  where id = p_order_id;

  insert into public.procurement_order_events (order_id, from_status, to_status, actor_member_id)
  values (p_order_id, v_actual, p_new_status, app.current_member_id(v_household));
end;
$$;

/**
 * Recibir una orden: los items se vuelven LOTES con el MISMO mecanismo del
 * Sprint 7 (lote + movimiento PURCHASE con clave de idempotencia). No existe
 * un segundo sistema de recepción: es el mismo libro mayor. El lote nace en
 * la BASE FÍSICA pedida (RAW/DRAINED/…), jamás en 'RAW' a ciegas.
 * Reintento idempotente: recibir una orden ya recibida devuelve 0, sin error.
 */
create or replace function public.receive_procurement_order(
  p_order_id    uuid,
  p_location_id uuid default null
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_order public.procurement_orders;
  v_member uuid;
  v_item record;
  v_lot uuid;
  v_count int := 0;
begin
  select * into v_order from public.procurement_orders where id = p_order_id for update;
  if v_order.id is null or not app.can_manage_shopping(v_order.household_id) then
    raise exception 'no autorizado';
  end if;
  -- El reintento de un "recibir" que YA pasó no es un error: es un no-op.
  if v_order.status in ('RECEIVED', 'STORED') then return 0; end if;
  if v_order.status not in ('ORDERED', 'READY', 'DELIVERING') then
    raise exception 'solo se recibe una orden pedida (está %)', v_order.status;
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.storage_locations
    where id = p_location_id and household_id = v_order.household_id
  ) then
    raise exception 'la ubicación no pertenece a este hogar';
  end if;

  v_member := app.current_member_id(v_order.household_id);
  perform public.ensure_storage_locations(v_order.household_id);

  for v_item in
    select * from public.procurement_order_items where order_id = p_order_id
  loop
    -- K-22: recibir dos veces jamás duplica un lote.
    if exists (select 1 from public.inventory_movements
               where idempotency_key = 'RECEIVE-PO:' || v_item.id::text) then
      continue;
    end if;

    insert into public.inventory_lots (
      household_id, ingredient_id, label, quantity, unit, weight_basis,
      location_id, created_by
    ) values (
      v_order.household_id, v_item.ingredient_id, v_item.label,
      0, v_item.unit, v_item.weight_basis,
      coalesce(p_location_id,
               (select id from public.storage_locations
                where household_id = v_order.household_id and kind = 'PANTRY'
                order by sort_order limit 1)),
      v_member
    ) returning id into v_lot;

    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, idempotency_key, actor_member_id)
    values
      (v_order.household_id, v_lot, 'PURCHASE', v_item.suggested_quantity,
       'RECEIVE-PO:' || v_item.id::text, v_member);

    v_count := v_count + 1;
  end loop;

  update public.procurement_orders
  set status = 'RECEIVED', received_at = now(), updated_at = now()
  where id = p_order_id;

  insert into public.procurement_order_events (order_id, from_status, to_status, actor_member_id)
  values (p_order_id, v_order.status, 'RECEIVED', v_member);

  return v_count;
end;
$$;
