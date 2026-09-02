-- Sprint 14 — PRECIOS: hechos fechados que se niegan a inventar.
--
-- Una observación de precio NO es un atributo del producto: es un HECHO
-- FECHADO. Nunca se actualiza; se agrega una nueva. De ahí sale todo lo demás:
-- la estimación de la lista de compra, el «al menos $121.900» del panel y la
-- métrica congelada «planificado vs real».
--
-- LA REGLA QUE ESTA MIGRACIÓN NO NEGOCIA: `price_observations` JAMÁS toca
-- `inventory_lots.value_minor` ni `acquisition_value`. La despensa vale lo que
-- costó. El precio de mercado sirve para ESTIMAR UNA COMPRA FUTURA y para nada
-- más; revalorizar el inventario a precio de hoy convertiría la inflación de
-- alimentos en un «ahorro» del hogar que nunca existió.
--
-- Los defectos del diseño que se cierran acá:
--
--   [H29] `check (price_minor >= 0)` DEJABA PASAR EL CERO, que es el
--         desconocido disfrazado. La línea de promo que la boleta imprime en $0
--         —porque el valor está en otra línea— generaba una observación de cero
--         pesos, dedupeada e indistinguible de un precio real; después el motor
--         la tomaba como último precio válido y declaraba que el pollo cuesta $0
--         con confianza KNOWN. Acá el check es `> 0`.
--
--   [H31] LA NORMALIZACIÓN TRUNCABA SIN REGLA Y EL COMPARADOR NO TENÍA
--         DESEMPATE. Dos presentaciones que difieren en menos de un peso por
--         kilo empataban después del truncado y el orden quedaba a merced del
--         plan de ejecución: «el más barato» cambiaba entre renders sobre la
--         misma data. Acá el redondeo es `app.mul_div_round` (half-even, el
--         mismo del dinero y el mismo del gemelo en TypeScript) y el orden lleva
--         desempate declarado.
--
--   [H39] LOS DOS ÍNDICES ÚNICOS ERAN CONTRADICTORIOS. `price_obs_from_item`
--         exigía una observación POR LÍNEA de compra y `price_obs_identity`
--         prohibía dos filas con igual (hogar, producto, comercio, fecha,
--         precio, envase, fuente). Una boleta con dos líneas del mismo yogurt al
--         mismo precio —la caja registra dos veces en vez de poner cantidad 2,
--         cosa que pasa siempre— no podía satisfacer los dos, y la confirmación
--         reventaba a mitad de camino. Acá manda UN solo dueño de la identidad:
--         la observación es un HECHO DE PRECIO. `purchase_item_id` queda como
--         referencia informativa, sin unique.
--
--   [H48] `observed_on` SE FIJABA EN LA FECHA DE SUBIDA. Una boleta del 3 de
--         agosto subida el 25 generaba observaciones fechadas el 25: el motor
--         tomaba por fresco un precio de tres semanas, y la misma boleta cargada
--         en dos días distintos producía dos fechas, o sea la dedup no la
--         atrapaba. Acá la fecha entra como PARÁMETRO —quien confirma la boleta
--         pasa la fecha IMPRESA— y `observed_on_source` la deja auditable.
--
--   [H67] «LA ÚLTIMA OBSERVACIÓN VÁLIDA» NO ERA DETERMINISTA. `observed_on` es
--         DATE-only: dos observaciones del mismo producto el mismo día (se anotó
--         $50.000 por un tipeo y se corrigió a $5.000 minutos después) no tenían
--         criterio de desempate, así que el motor puro daba resultados distintos
--         según el plan de ejecución de la consulta que lo alimenta. Acá hay
--         `superseded_by`, un corrector que encadena, y un orden único.

-- ---------------------------------------------------------------------------
-- 1. Los tipos
-- ---------------------------------------------------------------------------

create type public.price_source as enum (
  'RECEIPT',           -- salió de una boleta confirmada
  'ORDER',             -- salió de una recepción de pedido a proveedor
  'SUPPLIER_CATALOG',  -- lista de precios del proveedor
  'MANUAL',            -- alguien la escribió a mano
  'SHELF_SIGHTING'     -- «vi el pollo a $4.990 en el súper de la esquina»
);

/**
 * POR QUÉ NO SE PUDO CALCULAR el precio por kilo. Es un dato de primera clase,
 * no una ausencia: la pantalla lo muestra, nunca lo omite. Los casos 3 y 4 son
 * los que muerden en Chile — el atún declara peso drenado y peso neto, y
 * comparar $/kg de uno contra el otro produce una diferencia del 30 % que no
 * existe.
 */
create type public.normalization_block as enum (
  'NO_PACKAGE_QUANTITY',  -- «Pollo entero $6.990» sin peso: no hay $/kg posible
  'UNIT_ONLY',            -- se vende por unidad y nadie declaró su peso
  'BASIS_MISMATCH',       -- el peso escurrido no es el comprado, y no hay factor
  'PROMO_CONDITIONAL',    -- 2x1 / 3ª unidad: la cantidad efectiva depende
  'MIXED_PACK',           -- surtido: distintos contenidos en un mismo precio
  'VARIABLE_WEIGHT'       -- pesable: el precio de la boleta ya es total
);

/** De dónde salió la FECHA de la observación. Hace auditable la antigüedad. */
create type public.observed_on_source as enum ('PRINTED', 'HUMAN', 'UPLOAD_DATE');

-- ---------------------------------------------------------------------------
-- 2. La tabla
-- ---------------------------------------------------------------------------

create table public.price_observations (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,

  -- QUÉ (al menos uno; el producto comercial es el ancla preferida)
  product_id    uuid references public.commercial_products (id) on delete set null,
  ingredient_id uuid references public.ingredients (id) on delete set null,
  barcode       text check (barcode is null or char_length(barcode) between 6 and 32),
  raw_label     text not null check (char_length(raw_label) between 1 and 300),

  -- DÓNDE
  supplier_id   uuid references public.suppliers (id) on delete set null,
  -- Normalizado: lower(unaccent(comercio)) o el uuid del proveedor en texto.
  merchant_key  text not null check (char_length(merchant_key) between 1 and 120),

  -- CUÁNDO. [H48] La fecha de la BOLETA, no la de la subida.
  observed_on        date not null,
  observed_on_source public.observed_on_source not null default 'HUMAN',

  -- CUÁNTO. [H29] `> 0`: una observación de cero pesos es el desconocido
  -- disfrazado de precio, y aguas abajo se convierte en «el pollo cuesta $0»
  -- con sello de conocido. Si no se leyó el precio, NO SE CREA LA FILA.
  currency      char(3) not null references public.currency_units (code),
  price_minor   bigint not null check (price_minor > 0),

  -- Un 2x1 no es una baja del precio unitario si se llevó una sola unidad. Se
  -- guarda la condición literal y el normalizador se niega a resolverla solo.
  is_promotional  boolean not null default false,
  promo_condition text check (promo_condition is null or char_length(promo_condition) <= 120),

  -- BASE FÍSICA DE LA PRESENTACIÓN
  package_quantity numeric(12, 3) check (package_quantity > 0),
  package_unit     text check (package_unit in ('G', 'ML', 'UNIT')),
  package_count    int check (package_count > 0),
  weight_basis     public.weight_basis not null default 'AS_PACKAGED',

  -- NORMALIZADO: derivado, NULLABLE, con motivo cuando no se puede.
  normalized_per_kg_minor      bigint check (normalized_per_kg_minor is null
                                             or normalized_per_kg_minor > 0),
  normalized_per_l_minor       bigint check (normalized_per_l_minor is null
                                             or normalized_per_l_minor > 0),
  normalized_per_unit_minor    bigint check (normalized_per_unit_minor is null
                                             or normalized_per_unit_minor > 0),
  normalization_blocked_reason public.normalization_block,

  source           public.price_source not null,
  -- [H39] Referencia INFORMATIVA a la línea que produjo la observación. Sin
  -- unique: dos líneas iguales de la misma boleta producen UNA observación.
  purchase_item_id uuid references public.purchase_items (id) on delete set null,
  purchase_id      uuid references public.purchases (id) on delete set null,

  -- [H67] La corrección ENCADENA en vez de dejar dos verdades simultáneas.
  superseded_by uuid references public.price_observations (id) on delete set null,
  superseded_reason text,

  observed_by uuid references public.household_members (id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint price_obs_identidad_minima check (
    product_id is not null or ingredient_id is not null or barcode is not null
  ),
  -- Una observación no se supersede a sí misma: eso deja un ciclo que ninguna
  -- consulta de «la última válida» puede resolver.
  constraint price_obs_no_se_supersede_a_si_misma check (superseded_by is distinct from id)
);

/**
 * [H39] EL ÚNICO DUEÑO DE LA IDENTIDAD.
 *
 * `purchase_id` entra a la clave para no colapsar dos boletas distintas del
 * mismo comercio el mismo día (la compra de la mañana y la de la tarde son dos
 * hechos de precio, no uno). Reprocesar LA MISMA boleta sigue sin duplicar,
 * porque el `purchase_id` es el mismo.
 */
create unique index price_obs_identity on public.price_observations (
  household_id,
  coalesce(product_id, ingredient_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(barcode, ''),
  merchant_key,
  observed_on,
  price_minor,
  coalesce(package_quantity, 0),
  source,
  coalesce(purchase_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

-- [H67] `created_at` e `id` entran al índice porque son el desempate de «la
-- última válida»: sin ellos, dos observaciones del mismo día devuelven
-- cualquiera de las dos según el plan de ejecución.
create index price_obs_ultima_idx on public.price_observations
  (household_id, coalesce(product_id, ingredient_id), merchant_key,
   observed_on desc, created_at desc, id desc)
  where superseded_by is null;

create index price_obs_item_idx on public.price_observations (purchase_item_id)
  where purchase_item_id is not null;

comment on table public.price_observations is
  'Hechos de precio fechados. NUNCA tocan inventory_lots: la despensa vale lo '
  'que costo y no se revaloriza a precio de mercado.';

alter table public.price_observations enable row level security;
create policy price_observations_select on public.price_observations
  for select to authenticated
  using (app.finance_access(household_id, 'FINANCE_VIEW'));
revoke insert, update, delete on public.price_observations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. La normalización, que se niega a inventar
-- ---------------------------------------------------------------------------

/**
 * Gemelo exacto de `normalizePrice()` en TypeScript: misma tabla de verdad,
 * mismo redondeo.
 *
 * Se calcula SÓLO si se cumple todo:
 *   1. `package_quantity > 0` y `package_unit` no nulo.
 *   2. La unidad es física (`G`/`ML`) para $/kg y $/L; `UNIT` sólo da $/unidad.
 *   3. No hay promoción condicional declarada.
 *
 * El redondeo es `app.mul_div_round` (half-even) y NO un truncado: truncar sin
 * regla dejaba empates artificiales entre presentaciones que difieren en menos
 * de un peso por kilo, y el orden del comparador quedaba indefinido ([H31]).
 *
 * `UNIT_ONLY` viene CON `per_unit_minor` calculado: el bloqueo dice «no hay
 * $/kg posible», no «no se pudo calcular nada». Son dos cosas distintas y la
 * pantalla necesita las dos.
 */
create or replace function app.normalize_price(
  p_price_minor      bigint,
  p_package_quantity numeric,
  p_package_unit     text,
  p_package_count    int,
  p_is_promotional   boolean,
  p_promo_condition  text,
  out per_kg_minor   bigint,
  out per_l_minor    bigint,
  out per_unit_minor bigint,
  out blocked_reason public.normalization_block
) language plpgsql immutable as $$
declare
  v_unidades_milli bigint;
begin
  per_kg_minor := null;
  per_l_minor := null;
  per_unit_minor := null;
  blocked_reason := null;

  if p_price_minor is null or p_price_minor <= 0 then
    blocked_reason := 'NO_PACKAGE_QUANTITY';
    return;
  end if;

  -- Un 2x1 sin cantidad efectiva declarada no se normaliza: la cantidad que
  -- se llevó decide el precio unitario, y eso el papel no lo dice.
  if p_is_promotional and p_promo_condition is not null then
    blocked_reason := 'PROMO_CONDITIONAL';
    return;
  end if;

  if p_package_quantity is null or p_package_quantity <= 0 or p_package_unit is null then
    blocked_reason := 'NO_PACKAGE_QUANTITY';
    return;
  end if;

  -- Milésimas: `numeric(12,3)` cabe exacto en un entero y de ahí en adelante
  -- no hay coma flotante en ninguna parte del cálculo.
  v_unidades_milli := (p_package_quantity * coalesce(p_package_count, 1) * 1000)::bigint;
  if v_unidades_milli <= 0 then
    blocked_reason := 'NO_PACKAGE_QUANTITY';
    return;
  end if;

  if p_package_unit = 'G' then
    -- Un kilo son 1.000.000 de milésimas de gramo.
    per_kg_minor := app.mul_div_round(p_price_minor, 1000000, v_unidades_milli);
  elsif p_package_unit = 'ML' then
    per_l_minor := app.mul_div_round(p_price_minor, 1000000, v_unidades_milli);
  else
    -- Se vende por unidad: hay $/unidad, y NO hay $/kg mientras nadie declare
    -- el peso. El bloqueo lo dice con nombre en vez de dejar tres NULL mudos.
    per_unit_minor := app.mul_div_round(p_price_minor, 1000, v_unidades_milli);
    blocked_reason := 'UNIT_ONLY';
  end if;
end;
$$;

/**
 * ¿Se pueden comparar estas dos observaciones?
 *
 * Sólo con la MISMA base normalizada disponible y la misma base física. Si una
 * de las dos está bloqueada, el comparador devuelve incomparable con el motivo:
 * no ordena por precio bruto ni «estima» el peso. Coherente con el gate [B-1]:
 * la base física jamás se convierte sin factor anotado.
 */
create or replace function app.prices_comparable(
  p_a public.price_observations,
  p_b public.price_observations
) returns boolean language sql stable as $$
  select p_a.weight_basis = p_b.weight_basis
     and (
       (p_a.normalized_per_kg_minor is not null and p_b.normalized_per_kg_minor is not null)
       or (p_a.normalized_per_l_minor is not null and p_b.normalized_per_l_minor is not null)
       or (p_a.normalized_per_unit_minor is not null and p_b.normalized_per_unit_minor is not null)
     );
$$;

-- ---------------------------------------------------------------------------
-- 4. Escribir observaciones
-- ---------------------------------------------------------------------------

/**
 * El insertador común. Lo usan el avistamiento manual, el catálogo del
 * proveedor y —cuando exista— la confirmación de boleta.
 *
 * `on conflict do nothing` explícito ([H39]): reprocesar la misma boleta no
 * duplica y TAMPOCO revienta la confirmación entera a mitad de camino. Devuelve
 * el id de la observación que quedó, sea nueva o la que ya estaba, para que el
 * llamador pueda contar cuántas creó de verdad.
 */
create or replace function app.record_price_observation(
  p_household     uuid,
  p_product       uuid,
  p_ingredient    uuid,
  p_barcode       text,
  p_raw_label     text,
  p_supplier      uuid,
  p_merchant_key  text,
  p_observed_on   date,
  p_observed_src  public.observed_on_source,
  p_currency      char(3),
  p_price_minor   bigint,
  p_is_promotional boolean,
  p_promo_condition text,
  p_package_quantity numeric,
  p_package_unit  text,
  p_package_count int,
  p_weight_basis  public.weight_basis,
  p_source        public.price_source,
  p_purchase      uuid,
  p_purchase_item uuid,
  p_actor         uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_n record;
  v_id uuid;
begin
  if p_price_minor is null or p_price_minor <= 0 then
    raise exception 'una observacion sin precio no es una observacion: no se crea la fila'
      using errcode = 'check_violation';
  end if;
  perform app.assert_money(p_price_minor, 'el precio observado');

  select * into v_n from app.normalize_price(
    p_price_minor, p_package_quantity, p_package_unit, p_package_count,
    coalesce(p_is_promotional, false), p_promo_condition
  );

  insert into public.price_observations (
    household_id, product_id, ingredient_id, barcode, raw_label,
    supplier_id, merchant_key, observed_on, observed_on_source,
    currency, price_minor, is_promotional, promo_condition,
    package_quantity, package_unit, package_count, weight_basis,
    normalized_per_kg_minor, normalized_per_l_minor, normalized_per_unit_minor,
    normalization_blocked_reason, source, purchase_id, purchase_item_id, observed_by
  ) values (
    p_household, p_product, p_ingredient, p_barcode, p_raw_label,
    p_supplier, lower(p_merchant_key), p_observed_on,
    coalesce(p_observed_src, 'HUMAN'),
    p_currency, p_price_minor, coalesce(p_is_promotional, false), p_promo_condition,
    p_package_quantity, p_package_unit, p_package_count,
    coalesce(p_weight_basis, 'AS_PACKAGED'),
    v_n.per_kg_minor, v_n.per_l_minor, v_n.per_unit_minor,
    v_n.blocked_reason, p_source, p_purchase, p_purchase_item, p_actor
  )
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.price_observations
     where household_id = p_household
       and coalesce(product_id, ingredient_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce(p_product, p_ingredient, '00000000-0000-0000-0000-000000000000'::uuid)
       and coalesce(barcode, '') = coalesce(p_barcode, '')
       and merchant_key = lower(p_merchant_key)
       and observed_on = p_observed_on
       and price_minor = p_price_minor
       and coalesce(package_quantity, 0) = coalesce(p_package_quantity, 0)
       and source = p_source
       and coalesce(purchase_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce(p_purchase, '00000000-0000-0000-0000-000000000000'::uuid);
  end if;

  return v_id;
end;
$$;

/**
 * EL PRODUCTOR QUE FALTABA: una compra confirmada deja su historia de precios.
 *
 * El §6.2 del contrato lo pide literal y no existía. El enum declaraba
 * 'RECEIPT', la dedup traía escrito «reprocesar la misma boleta no duplica», y
 * `app.record_price_observation` tenía tres llamadores: el avistamiento manual,
 * la corrección y el catálogo del proveedor. Ni la boleta ni la compra. La
 * historia de precios del hogar —de la que comen el costeo de recetas y el
 * pronóstico— se alimentaba sólo a mano.
 *
 * Este es el CUERPO de `app.emit_purchase_price_observations`, cuyo llamador
 * está en la 0045 (`confirm_receipt_extraction` y `attach_receipt_to_purchase`)
 * con un cuerpo que se niega a seguir. La firma es la MISMA a propósito: si
 * cambiara, esto sería una sobrecarga y el llamador seguiría apuntando al cuerpo
 * que no hace nada.
 *
 * Qué precio se anota, y por qué:
 *
 *   · el de la LÍNEA IMPRESA (`line_subtotal_minor` más su descuento de línea),
 *     NO `final_value_minor`: ese lleva prorrateado el despacho y es el costo
 *     puesto en la despensa, no lo que decía la góndola. Comparar precios de
 *     comercios con el despacho adentro compara despachos;
 *   · si el descuento de la línea es DESCONOCIDO, NO se anota nada. Tomar el
 *     subtotal como si el descuento fuera cero es «desconocido = $0» exacto;
 *   · sin precio (`> 0`) no hay hecho de precio: no se crea la fila [H29];
 *   · la fecha es la de la COMPRA con su procedencia [H48], y por eso esto se
 *     llama DESPUÉS de que la boleta fija `purchased_on_source`.
 *
 * Devuelve cuántas observaciones DISTINTAS quedaron: una boleta con dos líneas
 * idénticas produce dos `purchase_items` y UNA sola observación, porque las dos
 * caen en la misma identidad y `on conflict do nothing` [H39].
 */
create or replace function app.emit_purchase_price_observations(
  p_purchase uuid,
  p_source   text,
  p_actor    uuid
) returns int language plpgsql security definer set search_path = public as $fn$
declare
  v_p public.purchases;
  v_it record;
  v_precio bigint;
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  select * into v_p from public.purchases where id = p_purchase;
  if v_p.id is null then
    raise exception 'la compra no existe' using errcode = 'check_violation';
  end if;

  for v_it in
    select * from public.purchase_items
    where purchase_id = p_purchase and superseded_at is null
    order by line_ordinal asc
  loop
    -- Sin identidad no hay de qué es el precio.
    if v_it.ingredient_id is null and v_it.product_id is null then continue; end if;
    if v_it.line_subtotal_minor is null then continue; end if;
    -- Un descuento DESCONOCIDO deja desconocido lo que se pagó por la línea.
    if v_it.line_discount_status <> 'KNOWN' then continue; end if;
    -- `line_discount_status = 'KNOWN'` garantiza el monto por check de tabla:
    -- acá no hace falta —ni corresponde— un coalesce que taparía un NULL.
    v_precio := v_it.line_subtotal_minor + v_it.line_discount_minor;
    if v_precio <= 0 then continue; end if;

    v_id := app.record_price_observation(
      v_p.household_id, v_it.product_id, v_it.ingredient_id, null, v_it.raw_label,
      v_p.supplier_id, v_p.merchant_key, v_p.purchased_on,
      v_p.purchased_on_source::text::public.observed_on_source,
      v_p.currency, v_precio,
      v_it.line_discount_minor <> 0,
      -- Un descuento de línea NO es una promoción CONDICIONAL (2x1, 3ª unidad):
      -- esa condición el papel no la dice y el normalizador no la inventa. Sin
      -- `promo_condition`, el $/kg se calcula igual y con el precio pagado.
      null,
      v_it.quantity_canonical, v_it.unit, 1, v_it.weight_basis,
      p_source::public.price_source, p_purchase, v_it.id, p_actor);

    if v_id is not null and not (v_id = any(v_ids)) then
      v_ids := v_ids || v_id;
    end if;
  end loop;

  return cardinality(v_ids);
end;
$fn$;

comment on function app.emit_purchase_price_observations is
  'El productor de observaciones de precio de una compra confirmada (§6.2). '
  'Sus llamadores de produccion viven en la 0045: confirm_receipt_extraction y '
  'attach_receipt_to_purchase.';

/** «Vi el pollo a $4.990 en el súper de la esquina». */
create or replace function public.record_price_sighting(
  p_household        uuid,
  p_raw_label        text,
  p_merchant         text,
  p_price_minor      bigint,
  p_product          uuid default null,
  p_ingredient       uuid default null,
  p_barcode          text default null,
  p_package_quantity numeric default null,
  p_package_unit     text default null,
  p_package_count    int default null,
  p_weight_basis     public.weight_basis default 'AS_PACKAGED',
  p_is_promotional   boolean default false,
  p_promo_condition  text default null,
  p_observed_on      date default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_currency char(3);
  v_hoy date;
  v_id uuid;
begin
  if not app.finance_access(p_household, 'FINANCE_MANAGE_PRICES') then
    raise exception 'no autorizado';
  end if;
  select currency into v_currency from public.households where id = p_household;
  v_hoy := app.household_today(p_household);

  -- La fecha por defecto es HOY y eso acá es correcto: la persona está mirando
  -- la góndola ahora. La fecha de una BOLETA es otra cosa y entra por parámetro.
  v_id := app.record_price_observation(
    p_household, p_product, p_ingredient, p_barcode, p_raw_label,
    null, coalesce(nullif(p_merchant, ''), 'sin comercio'),
    coalesce(p_observed_on, v_hoy),
    case when p_observed_on is null then 'UPLOAD_DATE' else 'HUMAN' end::public.observed_on_source,
    v_currency, p_price_minor, p_is_promotional, p_promo_condition,
    p_package_quantity, p_package_unit, p_package_count, p_weight_basis,
    'SHELF_SIGHTING', null, null, app.current_member_id(p_household)
  );
  return v_id;
end;
$$;

/**
 * [H67] Corregir un precio ENCADENA: la vieja queda marcada como superada y la
 * nueva la reemplaza. Nunca dos verdades simultáneas del mismo hecho.
 *
 * El tipeo de $50.000 corregido a $5.000 minutos después dejaba dos filas del
 * mismo día sin criterio de desempate, y «la última observación válida» devolvía
 * cualquiera de las dos según el plan de ejecución. Un motor puro alimentado por
 * una consulta no determinista deja de ser determinista.
 */
create or replace function public.correct_price_observation(
  p_observation uuid,
  p_price_minor bigint,
  p_reason      text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_o public.price_observations;
  v_nueva uuid;
begin
  select * into v_o from public.price_observations where id = p_observation for update;
  if v_o.id is null or not app.finance_access(v_o.household_id, 'FINANCE_MANAGE_PRICES') then
    raise exception 'no autorizado';
  end if;
  if v_o.superseded_by is not null then
    raise exception 'esa observacion ya fue corregida';
  end if;
  if p_reason is null or char_length(trim(p_reason)) = 0 then
    raise exception 'una correccion de precio necesita motivo';
  end if;

  v_nueva := app.record_price_observation(
    v_o.household_id, v_o.product_id, v_o.ingredient_id, v_o.barcode, v_o.raw_label,
    v_o.supplier_id, v_o.merchant_key, v_o.observed_on, v_o.observed_on_source,
    v_o.currency, p_price_minor, v_o.is_promotional, v_o.promo_condition,
    v_o.package_quantity, v_o.package_unit, v_o.package_count, v_o.weight_basis,
    'MANUAL', v_o.purchase_id, v_o.purchase_item_id,
    app.current_member_id(v_o.household_id)
  );

  update public.price_observations
     set superseded_by = v_nueva, superseded_reason = p_reason
   where id = p_observation;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_o.household_id, auth.uid(), 'PRICE_OBSERVATION_CORRECTED',
          'price_observation', p_observation,
          jsonb_build_object('reemplazada_por', v_nueva));

  return v_nueva;
end;
$$;

/**
 * [H67] LA ÚLTIMA OBSERVACIÓN VÁLIDA, con desempate único y declarado.
 *
 * `order by observed_on desc, created_at desc, id desc` no es decoración: es lo
 * que hace que el motor puro que se alimenta de acá siga siendo determinista.
 */
create or replace function app.latest_price_observation(
  p_household  uuid,
  p_product    uuid,
  p_ingredient uuid,
  p_merchant   text default null
) returns public.price_observations language sql stable as $$
  select o.* from public.price_observations o
   where o.household_id = p_household
     and o.superseded_by is null
     and (
       (p_product is not null and o.product_id = p_product)
       or (p_product is null and p_ingredient is not null and o.ingredient_id = p_ingredient)
     )
     and (p_merchant is null or o.merchant_key = lower(p_merchant))
   order by o.observed_on desc, o.created_at desc, o.id desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 5. El precio del proveedor deja de ser editable por cualquier integrante
-- ---------------------------------------------------------------------------

/**
 * `supplier_products` tenía UNA policy `for all using is_household_member`
 * (0014:71-77): cualquier integrante leía Y escribía el precio. Se estrecha en
 * dos: la parte no monetaria sigue siendo del hogar (es logística: presentación,
 * lead time, múltiplo de compra), y el PRECIO pasa a `FINANCE_VIEW` para leer y
 * a un RPC con `FINANCE_MANAGE_PRICES` para escribir.
 *
 * La columna `price` no se puede cerrar por columna sin revocar el `select` de
 * toda la tabla y volver a otorgarlo columna por columna —lo que rompería
 * cualquier `alter table` posterior— así que se cierra donde sí se puede: la
 * ESCRITURA. La lectura del precio con permiso vive en la vista de abajo, que es
 * la que la aplicación consume.
 */
drop policy if exists supplier_products_all on public.supplier_products;

create policy supplier_products_select on public.supplier_products
  for select to authenticated
  using (exists (select 1 from public.suppliers s
                 where s.id = supplier_id and app.is_household_member(s.household_id)));

create policy supplier_products_write on public.supplier_products
  for insert to authenticated
  with check (exists (select 1 from public.suppliers s
                      where s.id = supplier_id and app.is_household_member(s.household_id)));

create policy supplier_products_update on public.supplier_products
  for update to authenticated
  using (exists (select 1 from public.suppliers s
                 where s.id = supplier_id and app.is_household_member(s.household_id)))
  with check (exists (select 1 from public.suppliers s
                      where s.id = supplier_id and app.is_household_member(s.household_id)));

create policy supplier_products_delete on public.supplier_products
  for delete to authenticated
  using (exists (select 1 from public.suppliers s
                 where s.id = supplier_id and app.is_household_member(s.household_id)));

/**
 * Un `update` de `price` por PostgREST queda bloqueado por este trigger, no por
 * disciplina: la policy no puede distinguir QUÉ columna cambió.
 */
create or replace function app.supplier_price_solo_por_rpc()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_household uuid;
begin
  if new.price is not distinct from old.price then
    return new;
  end if;
  select s.household_id into v_household from public.suppliers s where s.id = new.supplier_id;
  if not app.finance_access(v_household, 'FINANCE_MANAGE_PRICES') then
    raise exception 'para cambiar el precio del proveedor necesitas el permiso de precios';
  end if;
  return new;
end;
$$;

create trigger supplier_products_precio_con_permiso
  before update of price on public.supplier_products
  for each row execute function app.supplier_price_solo_por_rpc();

/** La lectura del precio, ya con permiso. Vista con derechos del dueño. */
create view public.supplier_product_prices as
select sp.id as supplier_product_id,
       s.household_id,
       sp.supplier_id,
       sp.ingredient_id,
       sp.presentation,
       sp.package_quantity,
       sp.unit,
       sp.weight_basis,
       h.currency,
       app.value_to_minor(sp.price, h.currency) as price_minor,
       case when sp.price is null then 'UNKNOWN' else 'KNOWN' end::public.money_status
         as price_status
  from public.supplier_products sp
  join public.suppliers s on s.id = sp.supplier_id
  join public.households h on h.id = s.household_id
 where app.finance_access(s.household_id, 'FINANCE_VIEW');

grant select on public.supplier_product_prices to authenticated;

create or replace function public.set_supplier_product_price(
  p_supplier_product uuid,
  p_price_minor      bigint
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_currency char(3);
  v_sp public.supplier_products;
begin
  select sp.* into v_sp from public.supplier_products sp where sp.id = p_supplier_product;
  if v_sp.id is null then
    raise exception 'esa presentacion no existe';
  end if;
  select s.household_id into v_household from public.suppliers s where s.id = v_sp.supplier_id;
  if not app.finance_access(v_household, 'FINANCE_MANAGE_PRICES') then
    raise exception 'no autorizado';
  end if;
  if p_price_minor is null or p_price_minor <= 0 then
    raise exception 'un precio de proveedor de cero no es un precio';
  end if;
  perform app.assert_money(p_price_minor, 'el precio del proveedor');
  select currency into v_currency from public.households where id = v_household;

  update public.supplier_products
     set price = app.minor_to_value(p_price_minor, v_currency), updated_at = now()
   where id = p_supplier_product;

  -- El catálogo del proveedor también es un hecho de precio fechado.
  perform app.record_price_observation(
    v_household, null, v_sp.ingredient_id, null, v_sp.presentation,
    v_sp.supplier_id, v_sp.supplier_id::text,
    app.household_today(v_household), 'HUMAN',
    v_currency, p_price_minor, false, null,
    v_sp.package_quantity, v_sp.unit, 1, v_sp.weight_basis,
    'SUPPLIER_CATALOG', null, null, app.current_member_id(v_household)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. La estimación en la lista de compra
-- ---------------------------------------------------------------------------

/**
 * `price_estimate_*` NO entra a `aggregateDemand`.
 *
 * `demandSignature()` cubre por diseño todo lo que lee el ShoppingEngine, y
 * meter precios ahí generaría una revisión de lista NUEVA por cada cambio de
 * precio, llenando la bitácora de ruido. El costeo estimado es una capa aparte
 * (`domain/finance`) que consume los `DemandLine[]` ya calculados.
 */
alter table public.shopping_list_items
  add column price_estimate_minor       bigint check (price_estimate_minor is null
                                                      or price_estimate_minor > 0),
  add column price_estimate_source      public.price_source,
  add column price_estimate_observed_on date,
  add column price_estimate_status      public.money_status not null default 'UNKNOWN';

alter table public.shopping_list_items
  add constraint shopping_price_estimate_coherente check (
    app.money_coherent(
      price_estimate_status,
      price_estimate_minor,
      case when price_estimate_status = 'UNKNOWN' then 'NO_PRICE_RECORDED' end::public.money_unknown_reason
    )
  );

comment on column public.shopping_list_items.price_estimate_status is
  'UNKNOWN por defecto y a proposito: una linea sin precio conocido no vale $0. '
  'El default del sprint es el desconocido, no el cero.';

/**
 * Rellena las estimaciones de una lista desde la última observación válida.
 *
 * Se llama a mano (o desde la pantalla), NUNCA desde un trigger sobre
 * `price_observations`: un trigger ahí volvería a meter el precio dentro del
 * ciclo de vida de la lista, que es justo lo que el §6.5 evita.
 */
create or replace function public.estimate_shopping_list_prices(p_list uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_item record;
  v_obs public.price_observations;
  v_cuantos int := 0;
  v_minor bigint;
begin
  select l.household_id into v_household from public.shopping_lists l where l.id = p_list;
  -- Escribe `shopping_list_items` (price_estimate_*): mutar con el permiso de
  -- SOLO LECTURA es el mismo defecto de clase que tenía `reconcile_purchase`.
  -- Quien anota precios es quien tiene FINANCE_MANAGE_PRICES.
  if v_household is null or not app.finance_access(v_household, 'FINANCE_MANAGE_PRICES') then
    raise exception 'no autorizado';
  end if;

  for v_item in
    select i.id, i.ingredient_id, i.product_id, i.unit,
           coalesce(i.planned_quantity, i.required_quantity) as cantidad
      from public.shopping_list_items i
     where i.list_id = p_list
  loop
    v_obs := app.latest_price_observation(
      v_household, v_item.product_id, v_item.ingredient_id, null);

    v_minor := null;
    if v_obs.id is not null and v_item.cantidad is not null and v_item.cantidad > 0 then
      -- Sólo con la base normalizada disponible para ESA unidad. Si el precio
      -- quedó bloqueado, la línea se queda en UNKNOWN con su motivo: estimar
      -- igual sería inventar el peso del envase.
      if v_item.unit = 'G' and v_obs.normalized_per_kg_minor is not null then
        v_minor := app.mul_div_round(v_obs.normalized_per_kg_minor,
                                     (v_item.cantidad * 1000)::bigint, 1000000);
      elsif v_item.unit = 'ML' and v_obs.normalized_per_l_minor is not null then
        v_minor := app.mul_div_round(v_obs.normalized_per_l_minor,
                                     (v_item.cantidad * 1000)::bigint, 1000000);
      elsif v_item.unit = 'UNIT' and v_obs.normalized_per_unit_minor is not null then
        v_minor := app.mul_div_round(v_obs.normalized_per_unit_minor,
                                     (v_item.cantidad * 1000)::bigint, 1000);
      end if;
    end if;

    -- Un estimado que da 0 no se guarda como 0: es una cantidad tan chica que
    -- el precio no alcanza a un peso, y eso no es «gratis».
    if v_minor is not null and v_minor > 0 then
      update public.shopping_list_items
         set price_estimate_minor = v_minor,
             price_estimate_source = v_obs.source,
             price_estimate_observed_on = v_obs.observed_on,
             price_estimate_status = 'KNOWN'
       where id = v_item.id;
      v_cuantos := v_cuantos + 1;
    else
      update public.shopping_list_items
         set price_estimate_minor = null,
             price_estimate_source = null,
             price_estimate_observed_on = null,
             price_estimate_status = 'UNKNOWN'
       where id = v_item.id;
    end if;
  end loop;

  return v_cuantos;
end;
$$;
