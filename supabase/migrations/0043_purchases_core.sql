-- Sprint 14 — Compras: la convergencia (K-13) y el primer peso que entra a un lote.
--
-- POR QUÉ EXISTE ESTA MIGRACIÓN
--
-- `inventory_lots.acquisition_value` existe desde el Sprint 7 (0011:116) y hasta
-- hoy NINGÚN camino de recepción deposita un valor en ella: `receive_shopping_list`,
-- `receive_procurement_order` y `add_manual_lot` insertan el lote sin tocarla.
-- Los únicos que la escriben son `split_lot` y `merge_lots`, que REPARTEN un valor
-- que nunca entró. La despensa lleva siete sprints valiendo NULL y el sistema no
-- tiene forma de decir cuánto costó lo que se comió. Acá nace el escritor.
--
-- EL PRINCIPIO CONTABLE: caja != consumo. Esta migración solo CAPITALIZA — mete
-- valor a la despensa. Sacar valor (consumo, merma) es la 0044. Una compra de
-- $25.000 de pollo deja $25.000 guardados, no $25.000 gastados.
--
-- ADEMÁS unifica los DOS receptores que ya divergieron: la 0020 le enseñó a
-- `receive_shopping_list` a traducir la base física y la 0019 le enseñó a sellar
-- la temperatura de la ubicación ([C-3]); `receive_procurement_order` (0014:448)
-- nunca se enteró de ninguna de las dos y sigue metiendo lotes AMBIENT al
-- congelador. Un solo receptor, `app.receive_lot_from_purchase`, y los tres
-- caminos pasan por ahí.
--
-- DEPENDE DE LA 0042 (cimiento del dinero: currency_units, money_status,
-- app.apportion, app.finance_access). No se aplica sola y lo dice en voz alta.

do $$
begin
  if to_regclass('public.currency_units') is null
     or to_regtype('public.money_status') is null then
    raise exception
      'falta la migración 0042 (el cimiento del dinero): la 0043 no se aplica sola. Aplica 0042 primero.'
      using errcode = 'check_violation';
  end if;
  -- Los permisos financieros son la Etapa 2 del sprint. Sin el helper, la RLS de
  -- estas tablas no se puede ni declarar, y una tabla de dinero sin RLS es peor
  -- que no tenerla. Se falla acá, con nombre y apellido, y no con un
  -- «function app.finance_access does not exist» tres pantallas más abajo.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'finance_access'
  ) then
    raise exception
      'falta app.finance_access y el enum public.finance_permission (permisos financieros, Etapa 2 del Sprint 14): la 0043 declara su RLS con ellos y no se aplica sin eso.'
      using errcode = 'check_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.purchase_channel as enum
  ('SUPERMARKET', 'SUPPLIER_ORDER', 'MARKET', 'OTHER');

create type public.purchase_source as enum
  ('MANUAL', 'RECEIPT_IMPORT', 'ORDER_RECEIPT', 'LIST_RECEIPT');

create type public.reconciliation_status as enum
  ('NOT_APPLICABLE', 'BALANCED', 'WITHIN_TOLERANCE', 'OUT_OF_TOLERANCE', 'TOTAL_UNKNOWN');

create type public.purchase_charge_kind as enum
  ('LINE_DISCOUNT', 'ORDER_DISCOUNT', 'COUPON', 'DELIVERY', 'SERVICE_FEE', 'BAG', 'TIP',
   'DEPOSIT', 'TAX_ADJUSTMENT', 'ROUNDING');

create type public.charge_allocation_policy as enum
  ('DIRECT_LINE',      -- va entera a una línea nombrada
   'PRO_RATA_VALUE',   -- proporcional al valor de línea
   'PRO_RATA_WEIGHT',  -- proporcional a la masa comparable
   'EXPENSE_ONLY');    -- NO capitaliza: es gasto del hogar, no valor de despensa

create type public.line_match_method as enum
  ('BARCODE', 'EXACT_NAME', 'FUZZY_NAME', 'HISTORY', 'MANUAL', 'NONE');

create type public.receipt_total_source as enum ('PRINTED', 'SUMMED', 'UNKNOWN');

-- [H37] El precio impreso de un pesable chileno viene en $/kg y la cantidad del
-- lote va en gramos. Sin declarar la base del precio unitario no se puede ni
-- escribir el chequeo "precio × cantidad = subtotal", que es la única red que
-- atrapa un "10 kg" leído donde decía "1 kg".
create type public.unit_price_basis as enum ('PER_KG', 'PER_L', 'PER_UNIT', 'PER_100G');

-- ---------------------------------------------------------------------------
-- La versión de la política de asignación
-- ---------------------------------------------------------------------------
--
-- La política se CONGELA en cada compra (columna `allocation_policy_snapshot`).
-- Cambiar mañana el reparto por defecto del despacho no recalcula ni una compra
-- vieja: el motor solo lee el snapshot que la compra trae adentro.

create or replace function app.cost_allocation_engine_version()
returns text language sql immutable as $$ select 'cost-allocation/1.0.0'::text $$;

/**
 * La política ENTERA y RESUELTA para una moneda: defaults por tipo de cargo,
 * regla de redondeo, desempate y las tres tolerancias. Se guarda tal cual.
 */
create or replace function app.allocation_policy_snapshot(p_currency char(3))
returns jsonb language plpgsql stable as $$
declare v_u public.currency_units;
begin
  select * into v_u from public.currency_units where code = p_currency;
  if v_u.code is null then
    raise exception 'la moneda % no está declarada en currency_units', p_currency
      using errcode = 'check_violation';
  end if;
  return jsonb_build_object(
    'version', app.cost_allocation_engine_version(),
    'currency', v_u.code,
    'roundingRule', 'LARGEST_REMAINDER',
    'tieBreak', 'line_ordinal_asc',
    'defaultChargePolicy', jsonb_build_object(
      'LINE_DISCOUNT',  'DIRECT_LINE',
      'ORDER_DISCOUNT', 'PRO_RATA_VALUE',
      'COUPON',         'PRO_RATA_VALUE',
      'DELIVERY',       'EXPENSE_ONLY',
      'SERVICE_FEE',    'EXPENSE_ONLY',
      'BAG',            'EXPENSE_ONLY',
      'TIP',            'EXPENSE_ONLY',
      'DEPOSIT',        'EXPENSE_ONLY',
      'TAX_ADJUSTMENT', 'PRO_RATA_VALUE',
      'ROUNDING',       'EXPENSE_ONLY'),
    'toleranceMinor', v_u.reconciliation_tolerance_minor,
    'tolerancePerLineMinor', v_u.reconciliation_tolerance_per_line_minor,
    'tolerancePct', v_u.tolerance_pct
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- public.purchases — la única puerta de entrada de una compra
-- ---------------------------------------------------------------------------
--
-- Supermercado, pedido a proveedor e importación de boleta llegan acá y aguas
-- abajo nadie distingue el canal.
--
-- [H46] NO existe `purchases.receipt_id`. El vínculo compra↔boleta tiene UN solo
-- dueño y es `purchase_receipts.purchase_id` (0045), con índice único. Dos
-- punteros a la misma relación se desincronizan y dejan dos compras cuadrando
-- contra el mismo total impreso: el gasto contado dos veces.

create table public.purchases (
  id                        uuid primary key default gen_random_uuid(),
  household_id              uuid not null references public.households (id) on delete cascade,
  channel                   public.purchase_channel not null,
  source                    public.purchase_source not null,
  supplier_id               uuid references public.suppliers (id) on delete set null,
  merchant_name             text check (char_length(merchant_name) between 1 and 160),
  -- Clave normalizada del comercio: sirve para proponer "¿esta boleta es de esta
  -- compra?" en vez de dejar que el humano cree la duplicada ([H36], deber de producto).
  merchant_key              text not null check (char_length(merchant_key) between 1 and 160),

  -- Día del hogar, jamás now() del servidor: la boleta del sábado a las 23:40 en
  -- Santiago no es del domingo porque el servidor esté en UTC.
  purchased_on              date not null,
  currency                  char(3) not null references public.currency_units (code),

  -- El total IMPRESO. NULL = no se conoce, y la columna hermana lo declara.
  declared_total_minor      bigint check (declared_total_minor between -1000000000000000 and 1000000000000000),
  total_status              public.money_status not null default 'UNKNOWN',
  -- El default NO es NULL: una fila recién nacida ya declara POR QUÉ no sabe.
  total_unknown_reason      public.money_unknown_reason default 'NO_PRICE_RECORDED',
  total_source              public.receipt_total_source not null default 'UNKNOWN',

  shopping_list_id          uuid references public.shopping_lists (id) on delete set null,
  procurement_order_id      uuid references public.procurement_orders (id) on delete set null,

  -- La política, congelada y entera.
  allocation_policy_version text not null,
  allocation_policy_snapshot jsonb not null,

  reconciliation            public.reconciliation_status not null default 'NOT_APPLICABLE',
  -- [H27] DOS deltas, no uno. El de antes del ajuste es el descuadre real de la
  -- boleta y se guarda SIEMPRE (un delta absorbido es una fuga muda); el de
  -- después tiene que quedar en 0 cuando se creó el cargo de redondeo, y correr
  -- la conciliación N veces da siempre lo mismo.
  reconciliation_delta_before_adjustment_minor bigint
    check (reconciliation_delta_before_adjustment_minor between -1000000000000000 and 1000000000000000),
  reconciliation_delta_after_minor bigint
    check (reconciliation_delta_after_minor between -1000000000000000 and 1000000000000000),
  reconciled_at             timestamptz,

  -- K-22: registrar la misma compra dos veces es un no-op, no una compra doble.
  idempotency_key           text,
  created_by                uuid references public.household_members (id) on delete set null,
  created_at                timestamptz not null default now(),

  constraint purchases_total_coherente check (
    (total_status = 'KNOWN'   and declared_total_minor is not null and total_unknown_reason is null) or
    (total_status = 'UNKNOWN' and declared_total_minor is null     and total_unknown_reason is not null)
  ),
  constraint purchases_comercio_declarado check (supplier_id is not null or merchant_name is not null)
);

create unique index purchases_idem_uniq on public.purchases (idempotency_key)
  where idempotency_key is not null;
create index purchases_household_idx on public.purchases (household_id, purchased_on desc);
-- [H63] Ancla para las FK compuestas: nada cuelga de una compra de otro hogar.
create unique index purchases_id_household_uniq on public.purchases (id, household_id);

comment on column public.purchases.declared_total_minor is
  'El total IMPRESO en la boleta. Jamás la suma de las líneas presentada como impresa: '
  'para eso está total_source = SUMMED.';

-- ---------------------------------------------------------------------------
-- public.purchase_items — con el TEXTO ORIGINAL preservado para siempre
-- ---------------------------------------------------------------------------

create table public.purchase_items (
  id                     uuid primary key default gen_random_uuid(),
  purchase_id            uuid not null references public.purchases (id) on delete cascade,
  household_id           uuid not null references public.households (id) on delete cascade,
  line_ordinal           int not null check (line_ordinal >= 1),

  -- EL TEXTO DE LA BOLETA, tal cual, para siempre. Un trigger impide sobreescribirlo:
  -- la corrección va en ingredient_id/product_id, jamás en el texto. Un año después
  -- uno tiene que poder leer qué decía el papel.
  raw_label              text not null check (char_length(raw_label) between 1 and 300),
  raw_quantity_text      text check (char_length(raw_quantity_text) <= 120),

  ingredient_id          uuid references public.ingredients (id) on delete set null,
  product_id             uuid references public.commercial_products (id) on delete set null,
  match_method           public.line_match_method not null default 'NONE',
  match_score            numeric(4, 3) check (match_score between 0 and 1),

  quantity_canonical     numeric(12, 3) check (quantity_canonical > 0),
  unit                   text check (unit in ('G', 'ML', 'UNIT')),
  weight_basis           public.weight_basis not null default 'RAW',

  unit_price_minor       bigint check (unit_price_minor between -1000000000000000 and 1000000000000000),
  -- [H37] En qué base viene el precio impreso. NULL = la boleta no lo dijo, y
  -- entonces el chequeo de coherencia NO corre (no se inventa una base).
  unit_price_basis       public.unit_price_basis,

  line_subtotal_minor    bigint check (line_subtotal_minor between -1000000000000000 and 1000000000000000),

  -- [H26] SIN `not null default 0`: eso es "desconocido = cero" escrito en el DDL.
  -- Un descuento impreso que el OCR no logró leer vale DESCONOCIDO, no cero, y
  -- lo declara su columna hermana.
  line_discount_minor    bigint check (line_discount_minor between -1000000000000000 and 1000000000000000),
  line_discount_status   public.money_status not null default 'UNKNOWN',
  line_discount_unknown_reason public.money_unknown_reason default 'NO_PRICE_RECORDED',

  allocated_charges_minor bigint check (allocated_charges_minor between -1000000000000000 and 1000000000000000),
  allocated_charges_status public.money_status not null default 'UNKNOWN',
  -- Recién insertada, la línea todavía no pasó por el reparto: eso es
  -- NOT_YET_RECOGNIZED, no cero.
  allocated_charges_unknown_reason public.money_unknown_reason default 'NOT_YET_RECOGNIZED',

  -- Valor capitalizable de la línea: subtotal + descuento + lo prorrateado.
  final_value_minor      bigint check (final_value_minor between -1000000000000000 and 1000000000000000),
  value_status           public.money_status not null default 'UNKNOWN',
  unknown_reason         public.money_unknown_reason default 'NOT_YET_RECOGNIZED',

  -- NULL = compra no planificada. Es una métrica, no un error.
  shopping_list_item_id  uuid references public.shopping_list_items (id) on delete set null,
  procurement_item_id    uuid references public.procurement_order_items (id) on delete set null,

  -- Corrección encadenada: nace fila nueva, la vieja se marca. Nunca un UPDATE del valor.
  corrected_from         uuid references public.purchase_items (id) on delete set null,
  superseded_at          timestamptz,
  created_at             timestamptz not null default now(),

  constraint purchase_items_valor_coherente check (
    (value_status = 'KNOWN'   and final_value_minor is not null and unknown_reason is null) or
    (value_status = 'UNKNOWN' and final_value_minor is null     and unknown_reason is not null)
  ),
  constraint purchase_items_descuento_coherente check (
    (line_discount_status = 'KNOWN'   and line_discount_minor is not null and line_discount_unknown_reason is null) or
    (line_discount_status = 'UNKNOWN' and line_discount_minor is null     and line_discount_unknown_reason is not null)
  ),
  constraint purchase_items_cargos_coherente check (
    (allocated_charges_status = 'KNOWN'   and allocated_charges_minor is not null and allocated_charges_unknown_reason is null) or
    (allocated_charges_status = 'UNKNOWN' and allocated_charges_minor is null     and allocated_charges_unknown_reason is not null)
  ),
  -- [H63] la línea vive en el mismo hogar que su compra, siempre.
  constraint purchase_items_hogar_fk foreign key (purchase_id, household_id)
    references public.purchases (id, household_id) on delete cascade
);

-- Una sola línea VIVA por posición de la boleta. La corregida queda con
-- `superseded_at` y conserva su ordinal: la historia no se renumera.
create unique index purchase_items_ordinal_vivo
  on public.purchase_items (purchase_id, line_ordinal) where superseded_at is null;
create index purchase_items_purchase_idx on public.purchase_items (purchase_id);
create unique index purchase_items_id_purchase_uniq on public.purchase_items (id, purchase_id);
create unique index purchase_items_id_household_uniq on public.purchase_items (id, household_id);

/** El texto de la boleta es historia: se lee, no se edita. */
create or replace function app.purchase_item_raw_is_frozen()
returns trigger language plpgsql as $$
begin
  if new.raw_label is distinct from old.raw_label
     or new.raw_quantity_text is distinct from old.raw_quantity_text then
    raise exception
      'el texto original de la boleta no se reescribe: corrige el alimento o el producto, no lo que decía el papel'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger purchase_items_raw_frozen
  before update on public.purchase_items
  for each row execute function app.purchase_item_raw_is_frozen();

/**
 * [H37] Descuadre entre el precio unitario impreso y el subtotal de la línea.
 *
 * Devuelve NULL —DESCONOCIDO, no cero— cuando falta cualquiera de los datos o
 * cuando la base del precio no es comparable con la unidad del lote. Los tres
 * números son datos LEÍDOS y el sistema no sabe cuál está malo: esta función
 * mide, jamás corrige. Quien decide es la persona.
 */
create or replace function app.line_price_mismatch_minor(
  p_unit_price_minor   bigint,
  p_unit_price_basis   public.unit_price_basis,
  p_quantity_canonical numeric,
  p_unit               text,
  p_line_subtotal_minor bigint
) returns bigint language plpgsql immutable as $$
declare v_esperado numeric;
begin
  if p_unit_price_minor is null or p_unit_price_basis is null
     or p_quantity_canonical is null or p_unit is null or p_line_subtotal_minor is null then
    return null;
  end if;
  -- quantity_canonical va en G / ML / UNIT. La base del precio tiene que hablar
  -- de la misma dimensión física o no hay chequeo posible.
  v_esperado := case
    when p_unit_price_basis = 'PER_KG'   and p_unit = 'G'    then p_unit_price_minor::numeric * p_quantity_canonical / 1000
    when p_unit_price_basis = 'PER_100G' and p_unit = 'G'    then p_unit_price_minor::numeric * p_quantity_canonical / 100
    when p_unit_price_basis = 'PER_L'    and p_unit = 'ML'   then p_unit_price_minor::numeric * p_quantity_canonical / 1000
    when p_unit_price_basis = 'PER_UNIT' and p_unit = 'UNIT' then p_unit_price_minor::numeric * p_quantity_canonical
    else null
  end;
  if v_esperado is null then return null; end if;
  return (p_line_subtotal_minor::numeric - v_esperado)::bigint;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.purchase_charges — los cargos son entidades, no ajustes escondidos
-- ---------------------------------------------------------------------------
--
-- Un descuento, el despacho, la bolsa o la propina son FILAS VISIBLES, con
-- nombre, monto y política. Nunca una resta metida dentro de una línea.

create table public.purchase_charges (
  id                     uuid primary key default gen_random_uuid(),
  purchase_id            uuid not null references public.purchases (id) on delete cascade,
  household_id           uuid not null references public.households (id) on delete cascade,
  kind                   public.purchase_charge_kind not null,
  label                  text not null check (char_length(label) between 1 and 160),
  -- CON SIGNO: negativo = rebaja. No hay columna "es descuento".
  amount_minor           bigint not null
    check (amount_minor between -1000000000000000 and 1000000000000000),
  policy                 public.charge_allocation_policy not null,
  target_item_id         uuid,
  applied_policy_version text not null,
  created_at             timestamptz not null default now(),

  constraint direct_necesita_destino check (policy <> 'DIRECT_LINE' or target_item_id is not null),
  constraint destino_solo_para_directo check (policy = 'DIRECT_LINE' or target_item_id is null),
  -- [H63] el destino de un cargo dirigido es una línea DE ESTA MISMA compra.
  constraint purchase_charges_destino_fk foreign key (target_item_id, purchase_id)
    references public.purchase_items (id, purchase_id) on delete restrict,
  constraint purchase_charges_hogar_fk foreign key (purchase_id, household_id)
    references public.purchases (id, household_id) on delete cascade
);

create index purchase_charges_purchase_idx on public.purchase_charges (purchase_id);
create unique index purchase_charges_id_household_uniq on public.purchase_charges (id, household_id);
-- [H27] UN solo cargo de redondeo por compra: sin esto, recorrer la conciliación
-- dos veces inventa plata acumulativa.
create unique index purchase_charges_un_rounding_por_compra
  on public.purchase_charges (purchase_id) where kind = 'ROUNDING';

comment on column public.purchase_charges.policy is
  'EXPENSE_ONLY no capitaliza: la propina y el despacho son caja, no valor almacenado. '
  'Capitalizarlos en el pollo deja el kilo de pollo caro para siempre.';

-- ---------------------------------------------------------------------------
-- public.purchase_item_lots — 1 línea → N lotes y N líneas → 1 lote
-- ---------------------------------------------------------------------------

create table public.purchase_item_lots (
  purchase_item_id uuid not null references public.purchase_items (id) on delete cascade,
  lot_id           uuid not null references public.inventory_lots (id) on delete cascade,
  household_id     uuid not null references public.households (id) on delete cascade,
  quantity         numeric(12, 3) not null check (quantity > 0),
  value_minor      bigint check (value_minor between -1000000000000000 and 1000000000000000),
  value_status     public.money_status not null default 'UNKNOWN',
  unknown_reason   public.money_unknown_reason default 'NO_PRICE_RECORDED',
  created_at       timestamptz not null default now(),
  primary key (purchase_item_id, lot_id),
  constraint purchase_item_lots_valor_coherente check (
    (value_status = 'KNOWN'   and value_minor is not null and unknown_reason is null) or
    (value_status = 'UNKNOWN' and value_minor is null     and unknown_reason is not null)
  ),
  constraint purchase_item_lots_item_fk foreign key (purchase_item_id, household_id)
    references public.purchase_items (id, household_id) on delete cascade
);

create index purchase_item_lots_lot_idx on public.purchase_item_lots (lot_id);

-- [H63] Anclas de hogar sobre las tablas viejas, para que las FK compuestas de
-- este sprint (y de la 0044) no puedan cruzar de hogar.
create unique index inventory_lots_id_household_uniq on public.inventory_lots (id, household_id);
create unique index inventory_movements_id_household_uniq on public.inventory_movements (id, household_id);

alter table public.purchase_item_lots
  add constraint purchase_item_lots_lote_fk foreign key (lot_id, household_id)
  references public.inventory_lots (id, household_id) on delete cascade;

-- El camino B (pedido a proveedor) no dejaba NINGÚN rastro en el lote: había
-- ingredient_id y nada más. Sin esto no se puede saber de qué pedido salió.
alter table public.inventory_lots
  add column procurement_item_id uuid references public.procurement_order_items (id) on delete set null;

-- ---------------------------------------------------------------------------
-- RLS: ver el dinero exige permiso; escribir, solo por RPC
-- ---------------------------------------------------------------------------

alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.purchase_charges enable row level security;
alter table public.purchase_item_lots enable row level security;

create policy purchases_select on public.purchases for select to authenticated
  using (app.finance_access(household_id, 'FINANCE_VIEW'));
create policy purchase_items_select on public.purchase_items for select to authenticated
  using (app.finance_access(household_id, 'FINANCE_VIEW'));
create policy purchase_charges_select on public.purchase_charges for select to authenticated
  using (app.finance_access(household_id, 'FINANCE_VIEW'));
create policy purchase_item_lots_select on public.purchase_item_lots for select to authenticated
  using (app.finance_access(household_id, 'FINANCE_VIEW'));

revoke insert, update, delete on public.purchases from anon, authenticated;
revoke insert, update, delete on public.purchase_items from anon, authenticated;
revoke insert, update, delete on public.purchase_charges from anon, authenticated;
revoke insert, update, delete on public.purchase_item_lots from anon, authenticated;

-- ---------------------------------------------------------------------------
-- EL RECEPTOR ÚNICO
-- ---------------------------------------------------------------------------

/**
 * La única forma de que algo entre a la despensa por una compra.
 *
 * Una sola traducción de base física, una sola regla de temperatura por
 * ubicación, un solo insert de movimiento PURCHASE con clave de idempotencia y
 * —por primera vez en el repo— el DEPÓSITO del valor en el lote.
 *
 * El valor entra en UNIDADES MENORES ENTERAS y lo escribe `app.set_lot_value`
 * (0042), que es el dueño único de `inventory_lots.value_minor` y de su espejo
 * en `acquisition_value`. Acá no se toca ninguna de las dos columnas a mano.
 *
 * K-22: si la clave ya se usó, devuelve el lote que se creó entonces. Recibir dos
 * veces no duplica stock ni duplica plata.
 */
create or replace function app.receive_lot_from_purchase(
  p_household           uuid,
  p_ingredient_id       uuid,
  p_product_id          uuid,
  p_label               text,
  p_quantity            numeric,
  p_unit                text,
  p_weight_basis        public.weight_basis,
  p_location_id         uuid,
  p_idempotency         text,
  p_value_minor         bigint,
  p_purchase_item_id    uuid,
  p_shopping_item_id    uuid,
  p_procurement_item_id uuid,
  p_actor               uuid,
  p_processing_state    public.processing_state default 'RAW',
  p_expiry_date         date default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_lot uuid;
  v_loc uuid;
  v_kind public.storage_kind;
begin
  if p_idempotency is null or char_length(p_idempotency) = 0 then
    raise exception 'toda recepción necesita su clave de idempotencia: sin ella un reintento duplica el stock'
      using errcode = 'check_violation';
  end if;

  -- K-22 primero: si ya se recibió, no se crea nada y se devuelve lo de entonces.
  select m.lot_id into v_lot from public.inventory_movements m
  where m.idempotency_key = p_idempotency;
  if v_lot is not null then return v_lot; end if;

  perform app.assert_finite(p_quantity, 'la cantidad recibida');
  perform app.assert_money(p_value_minor, 'el valor de la línea');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'no se recibe una cantidad de cero o menos' using errcode = 'check_violation';
  end if;
  if p_unit not in ('G', 'ML', 'UNIT') then
    raise exception 'unidad desconocida: %', p_unit using errcode = 'check_violation';
  end if;
  if p_value_minor is not null and p_value_minor < 0 then
    raise exception 'un lote no puede entrar a la despensa con valor negativo'
      using errcode = 'check_violation';
  end if;

  perform public.ensure_storage_locations(p_household);
  v_loc := coalesce(p_location_id,
             (select id from public.storage_locations
              where household_id = p_household and kind = 'PANTRY'
              order by sort_order limit 1));
  select kind into v_kind from public.storage_locations
  where id = v_loc and household_id = p_household;
  if v_kind is null then
    raise exception 'la ubicación no pertenece a este hogar' using errcode = 'check_violation';
  end if;

  insert into public.inventory_lots (
    household_id, ingredient_id, product_id, label,
    quantity, unit, weight_basis, processing_state,
    temperature_state, frozen_at,
    location_id, expiry_date,
    shopping_item_id, procurement_item_id, created_by
  ) values (
    p_household, p_ingredient_id, p_product_id, p_label,
    0, p_unit, p_weight_basis, p_processing_state,
    -- [C-3] la temperatura sale de DÓNDE se guarda, en los tres caminos.
    case v_kind when 'FREEZER' then 'FROZEN' when 'FRIDGE' then 'CHILLED'
                else 'AMBIENT' end::public.temperature_state,
    case when v_kind = 'FREEZER' then now() else null end,
    v_loc, p_expiry_date,
    p_shopping_item_id, p_procurement_item_id, p_actor
  ) returning id into v_lot;

  -- El valor NO se escribe a mano: `app.set_lot_value` (0042) es el dueño único
  -- de `value_minor` y de su espejo en `acquisition_value`. Escribir la columna
  -- vieja acá dejaría las dos representaciones divergiendo desde el día uno.
  perform app.set_lot_value(v_lot, p_value_minor,
    case when p_value_minor is null then 'NO_PRICE_RECORDED' end::public.money_unknown_reason);

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, idempotency_key, actor_member_id)
  values
    (p_household, v_lot, 'PURCHASE', p_quantity, p_idempotency, p_actor);

  if p_purchase_item_id is not null then
    insert into public.purchase_item_lots
      (purchase_item_id, lot_id, household_id, quantity, value_minor, value_status, unknown_reason)
    values (p_purchase_item_id, v_lot, p_household, p_quantity,
            p_value_minor,
            case when p_value_minor is null then 'UNKNOWN' else 'KNOWN' end::public.money_status,
            case when p_value_minor is null then 'NO_PRICE_RECORDED' else null end::public.money_unknown_reason);
  end if;

  return v_lot;
end;
$$;

/**
 * La boleta que llega DESPUÉS de que la mercadería ya entró a la despensa.
 *
 * Este es el caso que duplica lotes si se hace mal: el sábado se recibió por
 * `receive_shopping_list` y el domingo se sube la foto. Acá NO se crea lote, NO
 * se inserta movimiento y NO se toca la cantidad: solo se deposita el valor que
 * faltaba y se anota el vínculo línea↔lote.
 *
 * Reglas duras:
 *  - solo NULL → conocido. Si el lote YA tenía valor, esto no es adjuntar: es
 *    corregir, y la corrección va por su RPC con razón obligatoria.
 *  - [H5] si el lote ya se partió o fusionó, se NIEGA. Poner el valor de la
 *    compra entera en un padre que hoy tiene 0 kg lo cuenta dos veces (padre
 *    valorizado + hijos vivos). Repartir sobre el árbol es trabajo del RPC de
 *    adjuntar, con `app.apportion`, jamás a ojo.
 */
create or replace function app.value_lot_from_purchase_item(
  p_purchase_item_id uuid,
  p_lot_id           uuid,
  p_quantity         numeric,
  p_value_minor      bigint
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_lot public.inventory_lots;
  v_item public.purchase_items;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null then
    raise exception 'el lote no existe' using errcode = 'check_violation';
  end if;
  select * into v_item from public.purchase_items where id = p_purchase_item_id;
  if v_item.id is null then
    raise exception 'la línea de compra no existe' using errcode = 'check_violation';
  end if;
  if v_item.household_id <> v_lot.household_id then
    raise exception 'la línea de compra y el lote son de hogares distintos'
      using errcode = 'check_violation';
  end if;
  perform app.assert_money(p_value_minor, 'el valor de la línea');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'el vínculo línea-lote necesita una cantidad mayor que cero'
      using errcode = 'check_violation';
  end if;

  if v_lot.value_status = 'KNOWN' then
    raise exception
      'el lote "%" ya tiene valor: adjuntar una boleta solo pasa de DESCONOCIDO a conocido. La despensa no se revaloriza.',
      v_lot.label using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.inventory_lots where parent_lot_id = p_lot_id) then
    raise exception
      'el lote "%" ya se partió o fusionó: valorizar el padre contaría la misma plata dos veces. Reparte sobre los descendientes.',
      v_lot.label using errcode = 'check_violation';
  end if;

  perform app.set_lot_value(p_lot_id, p_value_minor, 'NO_PRICE_RECORDED');

  insert into public.purchase_item_lots
    (purchase_item_id, lot_id, household_id, quantity, value_minor, value_status, unknown_reason)
  values (p_purchase_item_id, p_lot_id, v_lot.household_id, p_quantity,
          p_value_minor,
          case when p_value_minor is null then 'UNKNOWN' else 'KNOWN' end::public.money_status,
          case when p_value_minor is null then 'NO_PRICE_RECORDED' else null end::public.money_unknown_reason)
  on conflict (purchase_item_id, lot_id) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Los tres receptores viejos, reapuntados al receptor único
-- ---------------------------------------------------------------------------
--
-- Regla "todo conectado": el escritor viejo se mata EN el mismo cambio. Ninguno
-- de los tres vuelve a insertar lotes ni movimientos por su cuenta.

create or replace function public.receive_shopping_list(
  p_list_id     uuid,
  p_location_id uuid default null
) returns int language plpgsql security definer set search_path = public as $FN$
declare
  v_household uuid;
  v_status public.shopping_list_status;
  v_member uuid;
  v_item record;
  v_qty numeric;
  v_count int := 0;
  v_lot uuid;
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

    -- El valor va en NULL a propósito: una lista de compras no tiene precios
    -- todavía, y una ESTIMACIÓN no se capitaliza. La despensa vale lo que costó,
    -- y lo que costó lo dice la boleta (que puede llegar después).
    v_lot := app.receive_lot_from_purchase(
      v_household, v_item.ingredient_id, v_item.product_id, v_item.label,
      v_qty, v_item.unit,
      -- Gate 0-10 [B-1]: la base declarada en la compra se TRADUCE a la base
      -- física del lote. `purchase_basis` y `weight_basis` son enums distintos.
      case v_item.purchase_basis
        when 'DRAINED'            then 'DRAINED'::public.weight_basis
        when 'COMMERCIAL_PACKAGE' then 'AS_PACKAGED'::public.weight_basis
        when 'UNIT'               then 'AS_PACKAGED'::public.weight_basis
        else 'RAW'::public.weight_basis
      end,
      p_location_id, 'RECEIVE:' || v_item.id::text, null,
      null, v_item.id, null, v_member);

    if v_lot is not null then v_count := v_count + 1; end if;
  end loop;

  return v_count;
end;
$FN$;

create or replace function public.receive_procurement_order(
  p_order_id    uuid,
  p_location_id uuid default null
) returns int language plpgsql security definer set search_path = public as $FN$
declare
  v_order public.procurement_orders;
  v_member uuid;
  v_item record;
  v_count int := 0;
  v_lot uuid;
begin
  select * into v_order from public.procurement_orders where id = p_order_id for update;
  if v_order.id is null or not app.can_manage_shopping(v_order.household_id) then
    raise exception 'no autorizado';
  end if;
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

  for v_item in
    select * from public.procurement_order_items where order_id = p_order_id
  loop
    if exists (select 1 from public.inventory_movements
               where idempotency_key = 'RECEIVE-PO:' || v_item.id::text) then
      continue;
    end if;

    -- [C-3] cerrado para el camino B: hasta hoy este receptor no sellaba la
    -- temperatura de la ubicación (un lote recibido en el congelador nacía
    -- AMBIENT) ni dejaba rastro del pedido en el lote.
    v_lot := app.receive_lot_from_purchase(
      v_order.household_id, v_item.ingredient_id, null, v_item.label,
      v_item.suggested_quantity, v_item.unit, v_item.weight_basis,
      p_location_id, 'RECEIVE-PO:' || v_item.id::text, null,
      null, null, v_item.id, v_member);

    if v_lot is not null then v_count := v_count + 1; end if;
  end loop;

  update public.procurement_orders
  set status = 'RECEIVED', received_at = now(), updated_at = now()
  where id = p_order_id;

  insert into public.procurement_order_events (order_id, from_status, to_status, actor_member_id)
  values (p_order_id, v_order.status, 'RECEIVED', v_member);

  return v_count;
end;
$FN$;

/**
 * `add_manual_lot` con clave de idempotencia: hasta hoy un doble submit del
 * formulario creaba DOS lotes con la misma comida adentro. La clave la elige
 * quien llama (el id del formulario); si no viene, se genera una y el
 * comportamiento es el de antes.
 */
-- La firma vieja se retira ANTES, igual que hizo la 0019 al agregarle
-- `p_processing_state`: agregar un parámetro con default NO reemplaza la
-- función, crea una SEGUNDA sobrecarga, y toda llamada con menos argumentos
-- —como la de pantry/actions.ts:182— se vuelve ambigua y revienta en runtime.
drop function if exists public.add_manual_lot(uuid, text, numeric, text, uuid, uuid, date, uuid, text);

create or replace function public.add_manual_lot(
  p_household_id uuid,
  p_label        text,
  p_quantity     numeric,
  p_unit         text,
  p_ingredient_id uuid default null,
  p_location_id  uuid default null,
  p_expiry_date  date default null,
  p_source_assignment_id uuid default null,
  p_processing_state text default null,
  p_idempotency  text default null
) returns uuid language plpgsql security definer set search_path = public as $FN$
declare
  v_lot uuid; v_member uuid; v_proc public.processing_state; v_clave text;
begin
  if not app.is_household_member(p_household_id) then raise exception 'no autorizado'; end if;
  perform app.assert_finite(p_quantity, 'la cantidad');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'la cantidad tiene que ser mayor que cero';
  end if;
  if p_unit not in ('G', 'ML', 'UNIT') then raise exception 'unidad desconocida'; end if;
  if not app.ingredient_in_scope(p_ingredient_id, p_household_id) then
    raise exception 'el alimento no pertenece a este hogar';
  end if;
  if p_source_assignment_id is not null and not exists (
    select 1 from public.meal_assignments a
    join public.weekly_plan_days d on d.id = a.day_id
    join public.weekly_plans w on w.id = d.plan_id
    where a.id = p_source_assignment_id and w.household_id = p_household_id
  ) then
    raise exception 'la comida de origen no pertenece a este hogar';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.storage_locations
    where id = p_location_id and household_id = p_household_id
  ) then
    raise exception 'la ubicación no pertenece a este hogar';
  end if;
  if p_processing_state is not null
     and p_processing_state not in ('RAW', 'PREPPED', 'COOKED') then
    raise exception 'estado de preparación desconocido';
  end if;

  v_member := app.current_member_id(p_household_id);
  v_proc := coalesce(
    nullif(p_processing_state, '')::public.processing_state,
    case when p_source_assignment_id is null then 'RAW'
         else 'COOKED' end::public.processing_state);
  v_clave := coalesce(nullif(p_idempotency, ''), 'MANUAL:' || gen_random_uuid()::text);

  v_lot := app.receive_lot_from_purchase(
    p_household_id, p_ingredient_id, null, trim(p_label),
    p_quantity, p_unit, 'RAW'::public.weight_basis,
    p_location_id, v_clave, null,
    null, null, null, v_member, v_proc, p_expiry_date);

  -- La comida de origen no la conoce el receptor común (es un dato del lote
  -- manual, no de una compra): se sella acá, sobre el lote recién nacido.
  if p_source_assignment_id is not null then
    update public.inventory_lots
    set source_assignment_id = p_source_assignment_id, updated_at = now()
    where id = v_lot and source_assignment_id is null;
  end if;

  return v_lot;
end;
$FN$;

-- ---------------------------------------------------------------------------
-- EL MOTOR DE ASIGNACIÓN, versionado y congelado en la compra
-- ---------------------------------------------------------------------------

/**
 * Reparte los cargos de una compra entre sus líneas VIVAS, según la política
 * CONGELADA en la compra (jamás la de hoy).
 *
 * Devuelve un veredicto tipado, nunca un fallback silencioso:
 *   {"ok": true,  "allocated": {item_id: monto}, "version": ...}
 *   {"ok": false, "code": "UNKNOWN_LINE_VALUE" | "NO_COMPARABLE_MASS"
 *                       | "BASIS_CONVERSION_MISSING" | "DISCOUNT_EXCEEDS_LINES"
 *                       | "POLICY_NOT_APPLICABLE", "itemIds": [...]}
 *
 * Orden fijo (el orden es parte de la versión): DIRECT_LINE, PRO_RATA_VALUE,
 * PRO_RATA_WEIGHT, y EXPENSE_ONLY que no entra al reparto.
 */
create or replace function app.allocate_purchase_charges(p_purchase uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_p public.purchases;
  v_ids uuid[] := '{}';
  v_ordinales int[] := '{}';
  v_base bigint[] := '{}';        -- subtotal + descuento de línea, por línea
  v_acum bigint[] := '{}';        -- lo prorrateado hasta ahora, por línea
  v_pesos bigint[] := '{}';
  v_n int;
  v_i int;
  v_r record;
  v_cargo record;
  v_repartos public.apportion_result;
  v_sin_valor uuid[] := '{}';
  v_sin_masa uuid[] := '{}';
  v_unidad text;
  v_basis public.weight_basis;
  v_suma numeric;
  v_disponible bigint;
  v_pendiente bigint;
  v_asignado bigint;
  v_json jsonb := '{}'::jsonb;
begin
  select * into v_p from public.purchases where id = p_purchase for update;
  if v_p.id is null then
    raise exception 'la compra no existe' using errcode = 'check_violation';
  end if;

  for v_r in
    select id, line_ordinal, line_subtotal_minor, line_discount_minor, line_discount_status
    from public.purchase_items
    where purchase_id = p_purchase and superseded_at is null
    order by line_ordinal asc
  loop
    v_ids := v_ids || v_r.id;
    v_ordinales := v_ordinales || v_r.line_ordinal;
    if v_r.line_subtotal_minor is null or v_r.line_discount_status <> 'KNOWN' then
      v_base := v_base || null::bigint;
      v_sin_valor := v_sin_valor || v_r.id;
    else
      v_base := v_base || (v_r.line_subtotal_minor + v_r.line_discount_minor);
    end if;
    v_acum := v_acum || 0::bigint;
  end loop;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception 'una compra sin líneas no tiene entre qué repartir' using errcode = 'check_violation';
  end if;

  for v_cargo in
    select * from public.purchase_charges
    where purchase_id = p_purchase
    order by case policy when 'DIRECT_LINE' then 1 when 'PRO_RATA_VALUE' then 2
                         when 'PRO_RATA_WEIGHT' then 3 else 4 end,
             kind::text, id
  loop
    perform app.assert_money(v_cargo.amount_minor, 'el cargo "' || v_cargo.label || '"');

    if v_cargo.policy = 'EXPENSE_ONLY' then
      continue;  -- no capitaliza: es gasto del hogar, lo devenga la 0044

    elsif v_cargo.policy = 'DIRECT_LINE' then
      v_i := array_position(v_ids, v_cargo.target_item_id);
      if v_i is null then
        return jsonb_build_object('ok', false, 'code', 'POLICY_NOT_APPLICABLE',
          'itemIds', to_jsonb(array[v_cargo.target_item_id]),
          'detalle', 'el cargo "' || v_cargo.label || '" apunta a una línea que ya no está viva');
      end if;
      v_acum[v_i] := v_acum[v_i] + v_cargo.amount_minor;

    elsif v_cargo.policy in ('PRO_RATA_VALUE', 'PRO_RATA_WEIGHT') then
      -- Pesos de la política. Si no se pueden construir, NO se reparte "entre las
      -- que sí se puede": eso le regalaría el despacho de un producto sin precio
      -- a los demás y produciría un costo por kilo falso.
      v_pesos := '{}';
      if v_cargo.policy = 'PRO_RATA_VALUE' then
        if array_length(v_sin_valor, 1) > 0 then
          return jsonb_build_object('ok', false, 'code', 'UNKNOWN_LINE_VALUE',
            'policy', 'PRO_RATA_VALUE', 'itemIds', to_jsonb(v_sin_valor));
        end if;
        for v_i in 1 .. v_n loop
          v_pesos := v_pesos || greatest(v_base[v_i], 0);
        end loop;
      else
        v_unidad := null; v_basis := null; v_sin_masa := '{}';
        for v_r in
          select id, quantity_canonical, unit, weight_basis
          from public.purchase_items
          where purchase_id = p_purchase and superseded_at is null
          order by line_ordinal asc
        loop
          if v_r.quantity_canonical is null or v_r.unit is null or v_r.unit = 'UNIT' then
            v_sin_masa := v_sin_masa || v_r.id;
          end if;
          if v_unidad is null then v_unidad := v_r.unit; v_basis := v_r.weight_basis; end if;
          if v_r.unit is distinct from v_unidad then
            v_sin_masa := v_sin_masa || v_r.id;
          end if;
          -- Milésimas de gramo: los pesos de app.apportion son enteros, y una
          -- cantidad con tres decimales cabe exacta multiplicada por mil.
          v_pesos := v_pesos || coalesce((v_r.quantity_canonical * 1000)::bigint, 0);
        end loop;
        if array_length(v_sin_masa, 1) > 0 then
          return jsonb_build_object('ok', false, 'code', 'NO_COMPARABLE_MASS',
            'policy', 'PRO_RATA_WEIGHT', 'itemIds', to_jsonb(v_sin_masa));
        end if;
        -- Prohibido el 1:1 implícito entre bases físicas (gate 0-10 [B-1]): dos
        -- líneas en bases distintas necesitan un factor ANOTADO, o no hay reparto.
        for v_r in
          select id, ingredient_id, weight_basis
          from public.purchase_items
          where purchase_id = p_purchase and superseded_at is null
            and weight_basis <> v_basis
          loop
          if v_r.ingredient_id is null
             or app.basis_factor(v_r.ingredient_id, v_r.weight_basis, v_basis, v_p.household_id) is null then
            v_sin_masa := v_sin_masa || v_r.id;
          end if;
        end loop;
        if array_length(v_sin_masa, 1) > 0 then
          return jsonb_build_object('ok', false, 'code', 'BASIS_CONVERSION_MISSING',
            'policy', 'PRO_RATA_WEIGHT', 'itemIds', to_jsonb(v_sin_masa));
        end if;
      end if;

      v_suma := 0;
      for v_i in 1 .. v_n loop v_suma := v_suma + v_pesos[v_i]; end loop;
      if v_suma <= 0 then
        return jsonb_build_object('ok', false, 'code', 'POLICY_NOT_APPLICABLE',
          'policy', v_cargo.policy::text, 'itemIds', to_jsonb(v_ids),
          'detalle', 'los pesos del reparto suman cero: no hay sobre qué prorratear');
      end if;

      if v_cargo.amount_minor >= 0 then
        -- `apportion_checked` y no `apportion`: un bloqueo acá es un dato de la
        -- boleta (el supermercado la imprimió así), no un bug, y botar la
        -- confirmación entera con un raise sería castigar al que compró.
        v_repartos := app.apportion_checked(v_cargo.amount_minor, v_pesos);
        if not v_repartos.ok then
          return jsonb_build_object('ok', false, 'code', 'POLICY_NOT_APPLICABLE',
            'policy', v_cargo.policy::text, 'itemIds', to_jsonb(v_ids),
            'detalle', 'el reparto se bloqueó: ' || v_repartos.blocked::text);
        end if;
        for v_i in 1 .. v_n loop v_acum[v_i] := v_acum[v_i] + v_repartos.parts[v_i]; end loop;
      else
        -- [H26] Descuento: cascada con tope. A ninguna línea se le quita más de
        -- lo que tiene; lo que sobra se re-reparte entre las que aún tienen saldo.
        -- Si no alcanza, se bloquea con código propio: jamás un greatest(...,0).
        v_pendiente := -v_cargo.amount_minor;   -- positivo: lo que hay que rebajar
        loop
          v_repartos := app.apportion_checked(v_pendiente, v_pesos);
          if not v_repartos.ok then
            return jsonb_build_object('ok', false, 'code', 'POLICY_NOT_APPLICABLE',
              'policy', v_cargo.policy::text, 'itemIds', to_jsonb(v_ids),
              'detalle', 'el reparto se bloqueó: ' || v_repartos.blocked::text);
          end if;
          v_asignado := 0;
          for v_i in 1 .. v_n loop
            v_disponible := greatest(coalesce(v_base[v_i], 0) + v_acum[v_i], 0);
            if v_repartos.parts[v_i] > v_disponible then
              v_acum[v_i] := v_acum[v_i] - v_disponible;
              v_asignado := v_asignado + v_disponible;
              v_pesos[v_i] := 0;
            else
              v_acum[v_i] := v_acum[v_i] - v_repartos.parts[v_i];
              v_asignado := v_asignado + v_repartos.parts[v_i];
            end if;
          end loop;
          v_pendiente := v_pendiente - v_asignado;
          exit when v_pendiente <= 0;
          v_suma := 0;
          for v_i in 1 .. v_n loop v_suma := v_suma + v_pesos[v_i]; end loop;
          if v_suma <= 0 then
            return jsonb_build_object('ok', false, 'code', 'DISCOUNT_EXCEEDS_LINES',
              'policy', v_cargo.policy::text, 'itemIds', to_jsonb(v_ids),
              'faltanteMinor', v_pendiente);
          end if;
        end loop;
      end if;
    end if;
  end loop;

  -- Recién acá se escribe. Si algo bloqueó, no se tocó una sola línea.
  for v_i in 1 .. v_n loop
    update public.purchase_items
    set allocated_charges_minor = v_acum[v_i],
        allocated_charges_status = 'KNOWN',
        allocated_charges_unknown_reason = null,
        final_value_minor = case when v_base[v_i] is null then null else v_base[v_i] + v_acum[v_i] end,
        value_status = case when v_base[v_i] is null then 'UNKNOWN' else 'KNOWN' end::public.money_status,
        unknown_reason = case when v_base[v_i] is null
                              then 'NO_PRICE_RECORDED' else null end::public.money_unknown_reason
    where id = v_ids[v_i];
    v_json := v_json || jsonb_build_object(v_ids[v_i]::text, v_acum[v_i]);
  end loop;

  return jsonb_build_object('ok', true, 'version', v_p.allocation_policy_version,
                            'allocated', v_json);
end;
$$;

-- ---------------------------------------------------------------------------
-- CONCILIACIÓN: la tolerancia es un dato, y nunca se inventa una línea
-- ---------------------------------------------------------------------------

/**
 * Tolerancia efectiva de una boleta, en unidades menores.
 *
 * Base por moneda + una parte por línea (el IVA chileno se redondea línea a
 * línea, así que el descuadre legítimo crece con la cantidad de líneas), con
 * techo porcentual para que una boleta de 60 líneas no "tolere" $60 de
 * descuadre real. El piso es la base: una boleta chica no queda con tolerancia
 * cero por culpa del techo.
 */
create or replace function app.reconciliation_tolerance_minor(
  p_base_minor     bigint,
  p_per_line_minor bigint,
  p_pct            numeric,
  p_lineas         int,
  p_declarado_minor bigint
) returns bigint language plpgsql immutable as $$
declare v_lineal bigint; v_techo bigint;
begin
  if p_base_minor is null or p_per_line_minor is null or p_pct is null then
    raise exception 'la tolerancia de conciliación no está declarada: sin ella no se cuadra nada'
      using errcode = 'check_violation';
  end if;
  v_lineal := p_base_minor + p_per_line_minor * greatest(p_lineas, 0);
  v_techo := floor(p_pct * abs(coalesce(p_declarado_minor, 0)))::bigint;
  return greatest(p_base_minor, least(v_lineal, v_techo));
end;
$$;

comment on function app.reconciliation_tolerance_minor is
  'Los tres números salen del SNAPSHOT congelado en la compra, no de currency_units de hoy: '
  'volver a conciliar una boleta de julio tiene que dar el mismo veredicto que dio en julio.';

/**
 * Concilia la suma de las líneas contra el total IMPRESO de la boleta.
 *
 * Cinco desenlaces, todos explícitos, y ninguno inventa una línea "otros":
 *   NOT_APPLICABLE   el total no es impreso: no hay contra qué cuadrar.
 *   TOTAL_UNKNOWN    el total no se conoce, O alguna línea vale DESCONOCIDO.
 *   BALANCED         delta = 0.
 *   WITHIN_TOLERANCE se crea UN cargo real, visible, kind='ROUNDING',
 *                    policy='EXPENSE_ONLY', con nombre y monto. No es una línea
 *                    fantasma: es un cargo que se ve en pantalla.
 *   OUT_OF_TOLERANCE bloquea, guarda el delta y espera a que un humano agregue
 *                    la línea o el cargo que faltó, o declare el total desconocido.
 *
 * [H12] Nada de `sum()` desnudo sobre columnas de dinero: sum() se salta los
 * NULL y convertiría un valor DESCONOCIDO en $0, que después se absorbe como
 * "redondeo" con nombre falso. Si hay un desconocido, el desconocido BLOQUEA el
 * cuadre, no lo tolera.
 */
create or replace function public.reconcile_purchase(p_purchase uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_p public.purchases;
  v_lineas int;
  v_desconocidas int;
  v_suma_lineas bigint;
  v_suma_cargos bigint;
  v_calculado bigint;
  v_delta bigint;
  v_tol bigint;
  v_estado public.reconciliation_status;
  v_after bigint;
begin
  select * into v_p from public.purchases where id = p_purchase for update;
  if v_p.id is null then
    raise exception 'la compra no existe' using errcode = 'check_violation';
  end if;
  -- ESTA FUNCIÓN ESCRIBE: mueve `purchases.reconciliation`, los tres campos del
  -- descuadre y el cargo ROUNDING. Estuvo gateada con FINANCE_VIEW —el permiso
  -- que el enum describe como «la abuela ve cuánto se gastó»— y era el único RPC
  -- mutante del sprint con el permiso de SOLO LECTURA: quien sólo podía mirar
  -- reescribía en silencio el cierre de una compra ya conciliada, saltándose el
  -- `revoke insert, update, delete` que existe justamente para eso. Pide el
  -- mismo permiso que `record_purchase`, que es quien la llama.
  if not app.finance_access(v_p.household_id, 'FINANCE_CONFIRM_RECEIPTS') then
    raise exception 'no autorizado';
  end if;

  select count(*)::int,
         count(*) filter (where value_status = 'UNKNOWN')::int,
         case when bool_or(line_subtotal_minor is null or line_discount_minor is null)
              then null else sum(line_subtotal_minor + line_discount_minor) end
    into v_lineas, v_desconocidas, v_suma_lineas
  from public.purchase_items
  where purchase_id = p_purchase and superseded_at is null;

  -- Los cargos ROUNDING quedan FUERA del cálculo del delta ([H27]): si entraran,
  -- recorrer la conciliación dos veces daría deltas distintos y se inventaría un
  -- segundo ajuste encima del primero.
  select case when bool_or(amount_minor is null) then null else coalesce(sum(amount_minor), 0) end
    into v_suma_cargos
  from public.purchase_charges
  where purchase_id = p_purchase and kind <> 'ROUNDING';
  v_suma_cargos := coalesce(v_suma_cargos, 0);

  if v_suma_lineas is null then
    v_calculado := null;
  else
    v_calculado := v_suma_lineas + v_suma_cargos;
  end if;

  if v_p.total_source <> 'PRINTED' then
    v_estado := 'NOT_APPLICABLE';
    v_delta := null;
  elsif v_p.declared_total_minor is null or v_calculado is null or v_desconocidas > 0 then
    v_estado := 'TOTAL_UNKNOWN';
    v_delta := null;
  else
    v_delta := v_p.declared_total_minor - v_calculado;
    v_tol := app.reconciliation_tolerance_minor(
      (v_p.allocation_policy_snapshot ->> 'toleranceMinor')::bigint,
      (v_p.allocation_policy_snapshot ->> 'tolerancePerLineMinor')::bigint,
      (v_p.allocation_policy_snapshot ->> 'tolerancePct')::numeric,
      v_lineas, v_p.declared_total_minor);
    if v_delta = 0 then
      v_estado := 'BALANCED';
    elsif abs(v_delta) <= v_tol then
      v_estado := 'WITHIN_TOLERANCE';
    else
      v_estado := 'OUT_OF_TOLERANCE';
    end if;
  end if;

  -- El cargo de redondeo: uno solo por compra, con nombre, monto y política.
  if v_estado = 'WITHIN_TOLERANCE' then
    insert into public.purchase_charges
      (purchase_id, household_id, kind, label, amount_minor, policy, applied_policy_version)
    values (p_purchase, v_p.household_id, 'ROUNDING',
            'Diferencia de redondeo de la boleta', v_delta, 'EXPENSE_ONLY',
            v_p.allocation_policy_version)
    on conflict (purchase_id) where kind = 'ROUNDING'
    do update set amount_minor = excluded.amount_minor, label = excluded.label;
    v_after := 0;
  else
    delete from public.purchase_charges where purchase_id = p_purchase and kind = 'ROUNDING';
    v_after := v_delta;
  end if;

  update public.purchases
  set reconciliation = v_estado,
      reconciliation_delta_before_adjustment_minor = v_delta,
      reconciliation_delta_after_minor = v_after,
      reconciled_at = now()
  where id = p_purchase;

  -- Reconciliar una compra CERRADA otra vez es un hecho que alguien tiene que
  -- poder ver después; sin esto, el cierre se reescribía sin dejar rastro. Sólo
  -- cuando el estado CAMBIA: repetir el cuadre y que dé lo mismo no es un hecho.
  -- Sin montos, que van a finance_audit_log y no acá ([H68], 0045).
  if v_p.reconciliation is distinct from v_estado then
    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (v_p.household_id, auth.uid(), 'PURCHASE_RECONCILED', 'purchase', p_purchase,
            jsonb_build_object('reconciliation', v_estado::text,
                               'previous', v_p.reconciliation::text,
                               'lines', v_lineas,
                               'unknownLines', v_desconocidas));
  end if;

  return jsonb_build_object(
    'reconciliation', v_estado::text,
    'deltaBeforeAdjustmentMinor', v_delta,
    'deltaAfterMinor', v_after,
    'toleranceMinor', v_tol,
    'lines', v_lineas,
    'unknownLines', v_desconocidas);
end;
$$;

-- ---------------------------------------------------------------------------
-- La compra manual: misma convergencia, sin boleta de por medio
-- ---------------------------------------------------------------------------

/**
 * Registra una compra completa y la recibe: compra + líneas + cargos + reparto +
 * conciliación + lotes, todo en una transacción y por el ledger de siempre.
 *
 * `p_lineas`  = [{raw_label, ingredient_id, product_id, quantity, unit, weight_basis,
 *                 unit_price_minor, unit_price_basis, line_subtotal_minor,
 *                 line_discount_minor, shopping_list_item_id, receive}]
 * `p_cargos`  = [{kind, label, amount_minor, policy, target_line_ordinal}]
 *
 * Devuelve el id de la compra. K-22: la misma `p_idempotency` devuelve la misma
 * compra sin crear nada.
 */
create or replace function public.record_purchase(
  p_household           uuid,
  p_channel             public.purchase_channel,
  p_merchant_name       text,
  p_supplier_id         uuid,
  p_purchased_on        date,
  p_declared_total_minor bigint,
  p_total_source        public.receipt_total_source,
  p_lineas              jsonb,
  p_cargos              jsonb default '[]'::jsonb,
  p_location_id         uuid default null,
  p_idempotency         text default null,
  p_source              public.purchase_source default 'MANUAL'
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_purchase uuid;
  v_member uuid;
  v_currency char(3);
  v_dia date;
  v_l jsonb;
  v_c jsonb;
  v_ordinal int := 0;
  v_item uuid;
  v_veredicto jsonb;
  v_recon jsonb;
  v_total_status public.money_status;
  v_it record;
  v_lotes int := 0;
  v_sin_lote int := 0;
  v_sin_lote_minor bigint := 0;
  v_sin_lote_desconocidas int := 0;
begin
  if not app.finance_access(p_household, 'FINANCE_CONFIRM_RECEIPTS') then
    raise exception 'no autorizado';
  end if;
  if p_idempotency is not null then
    select id into v_purchase from public.purchases where idempotency_key = p_idempotency;
    if v_purchase is not null then return v_purchase; end if;
  end if;
  if jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'una compra sin líneas no es una compra' using errcode = 'check_violation';
  end if;

  select currency into v_currency from public.households where id = p_household;
  v_dia := coalesce(p_purchased_on, app.household_today(p_household));
  v_member := app.current_member_id(p_household);
  perform app.assert_money(p_declared_total_minor, 'el total de la boleta');

  v_total_status := case when p_declared_total_minor is null then 'UNKNOWN' else 'KNOWN' end;

  insert into public.purchases (
    household_id, channel, source, supplier_id, merchant_name, merchant_key,
    purchased_on, currency, declared_total_minor, total_status, total_unknown_reason,
    total_source, allocation_policy_version, allocation_policy_snapshot,
    idempotency_key, created_by
  ) values (
    p_household, p_channel, p_source, p_supplier_id, p_merchant_name,
    lower(trim(coalesce(p_merchant_name,
      (select name from public.suppliers where id = p_supplier_id), 'sin comercio'))),
    v_dia, v_currency, p_declared_total_minor, v_total_status,
    case when p_declared_total_minor is null then 'NO_PRICE_RECORDED' else null end::public.money_unknown_reason,
    coalesce(p_total_source, 'UNKNOWN'),
    app.cost_allocation_engine_version(), app.allocation_policy_snapshot(v_currency),
    p_idempotency, v_member
  ) returning id into v_purchase;

  for v_l in select * from jsonb_array_elements(p_lineas) loop
    v_ordinal := v_ordinal + 1;
    insert into public.purchase_items (
      purchase_id, household_id, line_ordinal, raw_label, raw_quantity_text,
      ingredient_id, product_id, match_method, match_score,
      quantity_canonical, unit, weight_basis,
      unit_price_minor, unit_price_basis, line_subtotal_minor,
      line_discount_minor, line_discount_status, line_discount_unknown_reason,
      shopping_list_item_id, procurement_item_id
    ) values (
      v_purchase, p_household, v_ordinal,
      v_l ->> 'raw_label', v_l ->> 'raw_quantity_text',
      nullif(v_l ->> 'ingredient_id', '')::uuid, nullif(v_l ->> 'product_id', '')::uuid,
      coalesce(nullif(v_l ->> 'match_method', ''), 'MANUAL')::public.line_match_method,
      nullif(v_l ->> 'match_score', '')::numeric,
      nullif(v_l ->> 'quantity', '')::numeric, nullif(v_l ->> 'unit', ''),
      coalesce(nullif(v_l ->> 'weight_basis', ''), 'RAW')::public.weight_basis,
      nullif(v_l ->> 'unit_price_minor', '')::bigint,
      nullif(v_l ->> 'unit_price_basis', '')::public.unit_price_basis,
      nullif(v_l ->> 'line_subtotal_minor', '')::bigint,
      -- En una compra MANUAL la persona escribe las líneas: que no venga el
      -- descuento significa que no hubo. Un `null` EXPLÍCITO es otra cosa —
      -- "había un descuento y no sé cuánto"— y viaja como DESCONOCIDO con su
      -- motivo. Esa distinción es la que después le permite al humano decir
      -- "este precio es desconocido" sin que colapse a cero.
      case when v_l ? 'line_discount_minor' then (v_l ->> 'line_discount_minor')::bigint else 0 end,
      case when v_l ? 'line_discount_minor' and (v_l ->> 'line_discount_minor') is null
           then 'UNKNOWN' else 'KNOWN' end::public.money_status,
      case when v_l ? 'line_discount_minor' and (v_l ->> 'line_discount_minor') is null
           then 'NO_PRICE_RECORDED' else null end::public.money_unknown_reason,
      nullif(v_l ->> 'shopping_list_item_id', '')::uuid,
      nullif(v_l ->> 'procurement_item_id', '')::uuid
    );
  end loop;

  for v_c in select * from jsonb_array_elements(coalesce(p_cargos, '[]'::jsonb)) loop
    insert into public.purchase_charges (
      purchase_id, household_id, kind, label, amount_minor, policy,
      target_item_id, applied_policy_version
    ) values (
      v_purchase, p_household,
      (v_c ->> 'kind')::public.purchase_charge_kind,
      v_c ->> 'label', (v_c ->> 'amount_minor')::bigint,
      (v_c ->> 'policy')::public.charge_allocation_policy,
      case when (v_c ->> 'policy') = 'DIRECT_LINE'
           then (select id from public.purchase_items
                 where purchase_id = v_purchase
                   and line_ordinal = (v_c ->> 'target_line_ordinal')::int)
           else null end,
      app.cost_allocation_engine_version()
    );
  end loop;

  v_veredicto := app.allocate_purchase_charges(v_purchase);
  if (v_veredicto ->> 'ok')::boolean is not true then
    raise exception 'no se pudo repartir los cargos de la compra: % (%)',
      v_veredicto ->> 'code', coalesce(v_veredicto ->> 'detalle', 'revisa las líneas señaladas')
      using errcode = 'check_violation';
  end if;

  v_recon := public.reconcile_purchase(v_purchase);
  if (v_recon ->> 'reconciliation') = 'OUT_OF_TOLERANCE' then
    raise exception
      'la suma de las líneas no cuadra con el total impreso (diferencia de %): agrega la línea o el cargo que falta, o declara el total como desconocido. No se inventa una línea de ajuste.',
      v_recon ->> 'deltaBeforeAdjustmentMinor'
      using errcode = 'check_violation';
  end if;

  -- Recepción: una llamada por línea al MISMO receptor que usa todo lo demás.
  for v_it in
    select * from public.purchase_items
    where purchase_id = v_purchase and superseded_at is null
    order by line_ordinal asc
  loop
    -- O ENTRA, O SE DECLARA QUE NO ENTRO.
    --
    -- Aca habia dos `continue` mudos: una linea sin cantidad canonica ("POLLO
    -- ENTERO $6.990", sin peso) o sin alimento identificado no creaba lote, no
    -- avisaba y no dejaba rastro — y sin embargo su plata seguia contandose como
    -- «quedo en la despensa». Ese dinero se evaporaba entre las dos columnas:
    -- no esta en ningun lote, no se va a consumir nunca y no es merma.
    --
    -- El salto se mantiene (obligar a la persona a inventar un peso seria peor:
    -- inventaria uno), pero deja de ser silencioso. Queda contado aca, escrito
    -- en la auditoria y en el evento, y visible en `finance_integrity_report`
    -- (tipo LINEA_SIN_LOTE) mientras nadie lo resuelva.
    if v_it.quantity_canonical is null or v_it.unit is null
       or (v_it.ingredient_id is null and v_it.product_id is null) then
      v_sin_lote := v_sin_lote + 1;
      if v_it.value_status = 'KNOWN' then
        v_sin_lote_minor := v_sin_lote_minor + v_it.final_value_minor;
      else
        v_sin_lote_desconocidas := v_sin_lote_desconocidas + 1;
      end if;
      continue;
    end if;
    perform app.receive_lot_from_purchase(
      p_household, v_it.ingredient_id, v_it.product_id, v_it.raw_label,
      v_it.quantity_canonical, v_it.unit, v_it.weight_basis,
      p_location_id, 'PURCHASE-ITEM:' || v_it.id::text,
      v_it.final_value_minor, v_it.id, v_it.shopping_list_item_id,
      v_it.procurement_item_id, v_member);
    v_lotes := v_lotes + 1;
  end loop;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (p_household, auth.uid(), 'PURCHASE_RECORDED', 'purchase', v_purchase,
          jsonb_build_object('lineas', v_ordinal, 'lotes', v_lotes,
                             'lineas_sin_lote', v_sin_lote,
                             'declarado_sin_lote_minor', v_sin_lote_minor,
                             'lineas_sin_lote_sin_precio', v_sin_lote_desconocidas,
                             'reconciliation', v_recon ->> 'reconciliation'));

  perform app.emit_event(p_household, 'PURCHASE_RECORDED', 'purchase',
    jsonb_build_object('purchase_id', v_purchase,
                       'lineas_sin_lote', v_sin_lote,
                       'declarado_sin_lote_minor', v_sin_lote_minor),
    'PURCHASE_RECORDED:' || v_purchase::text);

  return v_purchase;
end;
$$;

comment on function public.record_purchase is
  'La compra manual, por la MISMA puerta que la boleta y el pedido a proveedor. '
  'Capitaliza: deja valor en la despensa, no gasto consumido.';
