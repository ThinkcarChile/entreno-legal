-- Sprint 14 — CIMIENTO DE LAS FINANZAS DEL HOGAR: la escala del dinero.
--
-- EL PRINCIPIO CONTABLE DEL SPRINT ES «gasto de caja != consumo económico»,
-- pero ninguna de las dos cosas se puede medir si la unidad en que se miden
-- pierde plata. Esta migración pone la unidad, la aritmética exacta y las
-- guardas que hacen imposible —no desaconsejable: imposible— los cuatro
-- errores que la revisión adversarial encontró en el diseño:
--
--   [H13] value_to_minor() con trunc DESTRUÍA LA CONSERVACIÓN DEL SPLIT.
--         $17.000 partidos en 3 daban hijos de 5666,6667 en `numeric(12,4)`;
--         truncar cada hijo por separado da 5666 tres veces = $16.998 y nadie
--         puede explicar los $2. Acá el dinero del lote pasa a vivir en ENTERO
--         desde el origen (`inventory_lots.value_minor`) y `split_lot` reparte
--         con `app.apportion`: la suma de los hijos es EXACTAMENTE el valor del
--         padre, al peso, en la escala que la gente ve.
--
--   [H15] app.apportion() NO ESTABA DEFINIDA para totales negativos ni pesos
--         cero. Y esos son los casos NORMALES: los descuentos de orden son
--         montos negativos y una promo que imprime $0 es un peso 0. Acá se
--         reparte el valor absoluto y se repone el signo, los pesos 0 reciben
--         exactamente 0, y los casos imposibles (todos los pesos en 0, un peso
--         negativo) devuelven un BLOQUEO TIPADO, no un raise genérico que
--         botaría la confirmación completa de una boleta.
--
--   [H19] check (amount_minor between -1e15 and 1e15): `1e15` es un literal
--         `double precision`. La guarda escrita para impedir que el dinero pase
--         por coma flotante hacía, ella misma, una comparación en coma
--         flotante. Acá el rango vive en UNA función (`app.money_coherent`) y
--         se escribe con el entero completo.
--
--   [H57] Configuración mutable que reinterpreta historia cerrada: la moneda
--         del lote se congela EN EL LOTE (no se lee de `households.currency` en
--         tiempo de consulta) y `currency_units.minor_exponent` deja de ser
--         editable. Cambiar la moneda del hogar ya no reinterpreta el valor de
--         todos los lotes históricos.
--
-- Y el error que este repo ya conocía de otro sprint, resuelto ESTRUCTURALMENTE:
--   sum() EN POSTGRES IGNORA LOS NULL. `sum(amount_minor)` sobre una columna con
--   huecos devuelve un número que se lee como completo. Acá `app.sum_money`
--   devuelve un COMPUESTO que incluye `unknown_count`: para sacar un número de
--   ahí hay que pasar por `app.money_known()` —que devuelve NULL si faltó
--   algo— o mirar el conteo. No es disciplina, es la forma del dato.
--
-- ALCANCE: esta migración tiene DOS mitades. La primera es el CIMIENTO
-- MONETARIO (escala, aritmética exacta, valor del lote). La segunda —al final
-- del archivo, bajo «ETAPA 2»— son los PERMISOS FINANCIEROS: el enum
-- `public.finance_permission`, `household_finance_grants`, `app.finance_access`
-- y `app.finance_member_access`. Van en el mismo archivo porque las políticas de
-- la 0043 y la 0044 nombran ese helper y sin él no se pueden ni declarar.
--
-- El CIERRE DE LECTURA de las columnas de dinero de `inventory_lots` y la vista
-- `public.lot_valuations` NO están acá sino en la 0048, y por una razón concreta:
-- restringir columnas en Postgres exige `revoke select` sobre la TABLA y volver a
-- otorgar columna por columna, así que cualquier `alter table ... add column`
-- posterior nacería sin permiso. La 0043 le agrega `procurement_item_id` a
-- `inventory_lots`. Puesto acá, el cierre habría roto la despensa una migración
-- después. Va al final de la cadena del sprint, con una función re-ejecutable.

-- ---------------------------------------------------------------------------
-- 1. LA ESCALA: entero en unidad menor, por moneda
-- ---------------------------------------------------------------------------

create table public.currency_units (
  code                                    char(3) primary key,
  -- 0 a 4: el CLP no tiene unidad menor fraccionaria — el peso es el átomo.
  minor_exponent                          smallint not null check (minor_exponent between 0 and 4),
  -- Descuadre tolerado al conciliar una boleta completa y una línea suelta.
  reconciliation_tolerance_minor          bigint not null check (reconciliation_tolerance_minor >= 0),
  reconciliation_tolerance_per_line_minor bigint not null default 0
                                          check (reconciliation_tolerance_per_line_minor >= 0),
  tolerance_pct                           numeric(5, 4) not null default 0.005
                                          check (tolerance_pct >= 0 and tolerance_pct <= 1)
);

comment on table public.currency_units is
  'La escala de cada moneda. minor_exponent NO se edita: es la vara con que '
  'se midió todo el pasado (ver app.currency_units_append_only).';

insert into public.currency_units
  (code, minor_exponent, reconciliation_tolerance_minor, reconciliation_tolerance_per_line_minor)
values
  ('CLP', 0, 5, 1),   -- peso chileno: sin decimales; 5 pesos por boleta, 1 por línea
  ('USD', 2, 2, 1),
  ('EUR', 2, 2, 1);

/**
 * [H57] La vara con que se midió el pasado no se cambia.
 *
 * `app.value_to_minor` depende de `minor_exponent` para TODO el histórico: si
 * mañana alguien pone CLP en exponente 2, cada monto guardado pasa a valer cien
 * veces menos sin que ninguna fila cambie. Una moneda nueva se agrega; una
 * existente no se reinterpreta.
 */
create or replace function app.currency_units_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'una moneda no se borra: hay historia medida con ella'
      using errcode = 'check_violation';
  end if;
  if new.minor_exponent is distinct from old.minor_exponent then
    raise exception 'el exponente de % no se cambia: reinterpretaría todo el dinero ya guardado', old.code
      using errcode = 'check_violation';
  end if;
  if new.code is distinct from old.code then
    raise exception 'el código de una moneda no se cambia' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger currency_units_append_only
before update or delete on public.currency_units
for each row execute function app.currency_units_append_only();

alter table public.currency_units enable row level security;
create policy currency_units_select on public.currency_units
  for select to authenticated using (true);
revoke insert, update, delete on public.currency_units from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. DESCONOCIDO != CERO, y tampoco es NULL a secas
-- ---------------------------------------------------------------------------

create type public.money_status as enum ('KNOWN', 'UNKNOWN');

/**
 * El motivo es OBLIGATORIO cuando no se sabe.
 *
 * Es la diferencia entre un sistema honesto y un `null` suelto: la pantalla no
 * dice "—", dice «valor desconocido: este lote entró sin boleta». Corolario 4
 * de docs/unknown-nunca-es-normal.md, hecho columna.
 *
 * OJO con lo que NO está acá: no hay motivo «GRATIS». Algo regalado es KNOWN
 * con amount_minor = 0. "Costó $0" y "no sé cuánto costó" son dos hechos
 * distintos del mundo y el esquema los distingue.
 */
create type public.money_unknown_reason as enum (
  'NO_PRICE_RECORDED',        -- nunca se registró precio
  'LOT_VALUE_UNKNOWN',        -- el lote entró sin boleta
  'MIXED_UNKNOWN_MERGE',      -- K-19: una parte de la fusión era desconocida
  'CONSUMPTION_WITHOUT_LOT',  -- consumo sin lote de origen
  'NOT_YET_RECOGNIZED',       -- la boleta llegará después
  'UNIT_NOT_NORMALIZABLE',    -- no se puede llevar a $/kg sin inventar un factor
  'POLICY_NOT_APPLICABLE',    -- la política de asignación no corre con estos datos
  -- El lote YA tiene precio, pero arrastra salidas costeadas como DESCONOCIDAS
  -- (se comió antes de que llegara la boleta) y todavía nadie emitió esas
  -- correcciones: hasta entonces no se sabe cuánto le queda, y toda salida
  -- nueva hereda ese desconocido en vez de repartirse un remanente inflado.
  'PENDING_LATE_CORRECTION'
);

/**
 * LA regla de coherencia del dinero, en UN solo lugar.
 *
 * Toda tabla con plata la usa así, y con eso hereda también el rango:
 *   constraint x_coherente check (app.money_coherent(x_status, x_minor, x_reason))
 *
 * [H19] El rango se escribe con el entero completo (1.000.000.000.000.000) y no
 * como `1e15`, que en Postgres es un literal `double precision` y obligaría a
 * comparar el bigint promovido a coma flotante. Escrito una vez acá, ninguna
 * columna futura puede copiar el error.
 */
create or replace function app.money_coherent(
  p_status public.money_status,
  p_minor  bigint,
  p_reason public.money_unknown_reason
) returns boolean language sql immutable as $$
  select case
    when p_status is null then false
    when p_status = 'KNOWN' then
      p_minor is not null
      and p_reason is null
      and p_minor >= -1000000000000000::bigint
      and p_minor <=  1000000000000000::bigint
    when p_status = 'UNKNOWN' then
      p_minor is null and p_reason is not null
    else false
  end;
$$;

/** El equivalente de app.assert_finite para dinero: un bigint desbordado es tan venenoso como un NaN. */
create or replace function app.assert_money(p_minor bigint, p_nombre text)
returns void language plpgsql immutable as $$
begin
  -- NULL no se valida acá: el desconocido lo vigila app.money_coherent, que
  -- además exige su motivo. Acá solo se mira el rango de lo que sí es número.
  if p_minor is null then return; end if;
  if p_minor < -1000000000000000::bigint or p_minor > 1000000000000000::bigint then
    raise exception '% se salió del rango de dinero representable (%)', p_nombre, p_minor
      using errcode = 'check_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. EL PUENTE CON numeric(12,4) — y por qué NO se cruza para sumar
-- ---------------------------------------------------------------------------

create or replace function app.minor_exponent(p_currency char(3))
returns smallint language plpgsql stable as $$
declare v_exp smallint;
begin
  select minor_exponent into v_exp from public.currency_units where code = p_currency;
  if v_exp is null then
    raise exception 'moneda desconocida: %', p_currency using errcode = 'check_violation';
  end if;
  return v_exp;
end;
$$;

/**
 * numeric → entero de unidades menores, EXACTO o nada.
 *
 * [H13] Esta función revienta si el valor no cabe exacto en la escala menor, y
 * eso es a propósito. `inventory_lots.acquisition_value` es `numeric(12,4)` y
 * K-19 reparte ahí adentro: un lote partido deja hijos de 5666,6667. Truncar o
 * redondear cada hijo POR SEPARADO pierde plata que nadie puede explicar
 * (5666 × 3 = 16.998 de un padre de 17.000).
 *
 * Por eso el dinero del lote NO se deriva de esta columna: vive en
 * `inventory_lots.value_minor`, entero, y se reparte con `app.apportion`. Esta
 * función existe para el otro sentido —recibir un monto de boleta, que siempre
 * es exacto— y para dejar que el intento de convertir un residuo interno falle
 * a gritos en vez de en silencio.
 */
create or replace function app.value_to_minor(p_value numeric, p_currency char(3))
returns bigint language plpgsql stable as $$
declare v_escalado numeric; v_minor bigint;
begin
  if p_value is null then return null; end if;
  perform app.assert_finite(p_value, 'el valor a convertir');
  v_escalado := p_value * power(10::numeric, app.minor_exponent(p_currency)::numeric);
  if v_escalado <> trunc(v_escalado) then
    raise exception
      'el valor % no cabe exacto en % (quedaría %): convertir residuos de a uno pierde plata; reparte con app.apportion',
      p_value, p_currency, v_escalado
      using errcode = 'check_violation';
  end if;
  v_minor := v_escalado::bigint;
  perform app.assert_money(v_minor, 'el valor convertido');
  return v_minor;
end;
$$;

create or replace function app.minor_to_value(p_minor bigint, p_currency char(3))
returns numeric language plpgsql stable as $$
begin
  if p_minor is null then return null; end if;
  return p_minor::numeric / power(10::numeric, app.minor_exponent(p_currency)::numeric);
end;
$$;

/**
 * ¿Este numeric cabe exacto en la escala menor? Sin reventar.
 * Lo usa el backfill: lo que no cabe se declara DESCONOCIDO, no se aproxima.
 */
create or replace function app.value_fits_minor(p_value numeric, p_currency char(3))
returns boolean language plpgsql stable as $$
declare v_escalado numeric;
begin
  if p_value is null then return false; end if;
  if p_value = 'NaN'::numeric then return false; end if;
  v_escalado := p_value * power(10::numeric, app.minor_exponent(p_currency)::numeric);
  return v_escalado = trunc(v_escalado)
     and v_escalado >= -1000000000000000::numeric
     and v_escalado <=  1000000000000000::numeric;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. ARITMÉTICA: un solo dueño del redondeo, un solo dueño del reparto
-- ---------------------------------------------------------------------------

/**
 * a * num / den con redondeo BANCARIO (half-even) y sin coma flotante.
 *
 * `numeric` en Postgres es decimal exacto, no float: los productos y las
 * divisiones enteras de acá no pierden nada. Half-even y no half-up porque el
 * half-up sesga cada mitad exacta hacia arriba, y en una despensa donde se
 * costean cientos de movimientos chicos ese sesgo se acumula para un solo lado.
 *
 * REGLA DE USO (hay dos repartidores y conviven con una regla escrita):
 *   - app.apportion  → repartir un total conocido DE UNA VEZ (cargos de boleta,
 *     partir un lote). Conserva por construcción.
 *   - app.mul_div_round → solo extracciones INCREMENTALES cuyo residuo sea
 *     recuperable (costear un consumo contra el remanente del lote), con la
 *     obligación de cerrar el lote con el residuo exacto cuando el lote se
 *     cierra por cualquier vía distinta de llegar a 0.
 */
create or replace function app.mul_div_round(p_a bigint, p_num bigint, p_den bigint)
returns bigint language plpgsql immutable as $$
declare v_prod numeric; v_den numeric; v_q numeric; v_r numeric; v_neg boolean;
begin
  if p_a is null or p_num is null or p_den is null then return null; end if;
  if p_den = 0 then
    raise exception 'no se divide dinero por cero' using errcode = 'division_by_zero';
  end if;
  v_neg := ((p_a::numeric * p_num::numeric) < 0) <> (p_den < 0);
  v_prod := abs(p_a::numeric * p_num::numeric);
  v_den := abs(p_den::numeric);
  v_q := trunc(v_prod / v_den);
  v_r := v_prod - v_q * v_den;
  if v_r * 2 > v_den then
    v_q := v_q + 1;
  elsif v_r * 2 = v_den and (v_q::bigint % 2) <> 0 then
    v_q := v_q + 1;
  end if;
  if v_neg then v_q := -v_q; end if;
  perform app.assert_money(v_q::bigint, 'el resultado del prorrateo');
  return v_q::bigint;
end;
$$;

/** Por qué no se pudo repartir. Es un dato de la boleta, no un bug del programa. */
create type public.apportion_block as enum (
  'SIN_PARTES',        -- nadie a quien repartir
  'PESO_INVALIDO',     -- un peso nulo
  'PESO_NEGATIVO',     -- descuento de línea mayor que la línea
  'PESOS_SUMAN_CERO'   -- boleta de puras líneas en $0 más un despacho
);

create type public.apportion_result as (
  ok      boolean,
  parts   bigint[],
  blocked public.apportion_block
);

/**
 * Reparto por MAYOR RESTO (Hamilton). La única forma legítima de repartir plata.
 *
 * [H15] Definida para los casos que de verdad llegan:
 *   - TOTAL NEGATIVO: los descuentos de orden y los cupones son negativos y son
 *     el caso normal. Se reparte |total| y se repone el signo, así
 *     apportion(-t) es exactamente −apportion(t) y la postcondición Σ = total
 *     se cumple igual a los dos lados del cero. Truncar hacia cero y "sumar de
 *     a 1 al de mayor resto" reparte para el lado equivocado con negativos.
 *   - PESO 0: recibe exactamente 0. El sobrante a repartir siempre es menor que
 *     la cantidad de pesos con resto positivo, así que nunca alcanza a los ceros.
 *   - Σ PESOS = 0 o un peso negativo: NO se reparte y NO se lanza. Se devuelve
 *     el bloqueo tipado, porque reventar acá bota la confirmación completa de
 *     una boleta que el supermercado imprimió así.
 *
 * Los pesos son bigint, igual que en TypeScript (web/src/domain/finance/money.ts):
 * dos implementaciones del mismo reparto con firmas distintas divergen en los
 * empates. El test de paridad las corre lado a lado con la misma tabla de casos.
 */
create or replace function app.apportion_checked(p_total bigint, p_weights bigint[])
returns public.apportion_result language plpgsql immutable as $$
declare
  v_n int;
  v_i int;
  v_w bigint;
  v_suma_pesos numeric := 0;
  v_magnitud numeric;
  v_neg boolean;
  v_piso numeric;
  v_pisos numeric[] := '{}';
  v_restos numeric[] := '{}';
  v_repartido numeric := 0;
  v_sobrante numeric;
  v_partes bigint[] := '{}';
  v_control numeric := 0;
  v_orden int[];
begin
  v_n := coalesce(array_length(p_weights, 1), 0);
  if p_total is null then
    raise exception 'no se reparte un total desconocido: el desconocido no se reparte, se declara'
      using errcode = 'check_violation';
  end if;
  if v_n = 0 then
    return row(false, null, 'SIN_PARTES')::public.apportion_result;
  end if;

  for v_i in 1 .. v_n loop
    v_w := p_weights[v_i];
    if v_w is null then
      return row(false, null, 'PESO_INVALIDO')::public.apportion_result;
    end if;
    if v_w < 0 then
      return row(false, null, 'PESO_NEGATIVO')::public.apportion_result;
    end if;
    v_suma_pesos := v_suma_pesos + v_w;
  end loop;

  if v_suma_pesos = 0 then
    return row(false, null, 'PESOS_SUMAN_CERO')::public.apportion_result;
  end if;

  v_neg := p_total < 0;
  v_magnitud := abs(p_total::numeric);

  for v_i in 1 .. v_n loop
    v_piso := trunc(v_magnitud * p_weights[v_i]::numeric / v_suma_pesos);
    v_pisos := v_pisos || v_piso;
    v_restos := v_restos || (v_magnitud * p_weights[v_i]::numeric - v_piso * v_suma_pesos);
    v_repartido := v_repartido + v_piso;
  end loop;

  -- Desempate por índice ascendente: determinismo byte a byte entre corridas,
  -- entre motores y entre esta función y su gemela de TypeScript.
  v_sobrante := v_magnitud - v_repartido;
  select array_agg(i order by v_restos[i] desc, i asc) into v_orden
  from generate_series(1, v_n) as i;

  for v_i in 1 .. v_n loop
    exit when v_sobrante <= 0;
    v_pisos[v_orden[v_i]] := v_pisos[v_orden[v_i]] + 1;
    v_sobrante := v_sobrante - 1;
  end loop;

  for v_i in 1 .. v_n loop
    v_partes := v_partes || (case when v_neg then -v_pisos[v_i] else v_pisos[v_i] end)::bigint;
    v_control := v_control + (case when v_neg then -v_pisos[v_i] else v_pisos[v_i] end);
  end loop;

  -- Postcondición verificada ACÁ, no en un test: si el reparto no conserva, el
  -- resto del sprint suma plata que no existe.
  if v_control <> p_total::numeric then
    raise exception 'el reparto sumó % y el total era %', v_control, p_total;
  end if;

  return row(true, v_partes, null)::public.apportion_result;
end;
$$;

/**
 * `apportion_checked` para los repartos INTERNOS donde un bloqueo sería un bug
 * del programa y no un dato del mundo (partir un lote: las cantidades son > 0
 * por las guardas del ledger). Lanza con el motivo tipado adentro del mensaje.
 */
create or replace function app.apportion(p_total bigint, p_weights bigint[])
returns bigint[] language plpgsql immutable as $$
declare v_res public.apportion_result;
begin
  v_res := app.apportion_checked(p_total, p_weights);
  if not v_res.ok then
    raise exception 'no se pudo repartir el monto (%)', v_res.blocked
      using errcode = 'check_violation';
  end if;
  return v_res.parts;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. SUMAR DINERO SIN QUE LOS HUECOS DESAPAREZCAN
-- ---------------------------------------------------------------------------

/**
 * EL PEOR ERROR DE UNA PANTALLA DE DINERO, resuelto por la FORMA del dato.
 *
 * `sum()` en Postgres IGNORA los NULL: la suma de una columna con huecos
 * devuelve un número que se lee como completo. Diez lotes, cuatro sin precio, y
 * el panel muestra el total de los seis como si fuera el de los diez.
 *
 * `app.sum_money` no devuelve un número: devuelve este compuesto, que CUENTA
 * los desconocidos. Para sacar un monto de acá hay que llamar a
 * `app.money_known()` —que devuelve NULL en cuanto falta uno— o mirar
 * `unknown_count` a la cara. No hay forma de obtener "el total" sin decidir qué
 * hacer con lo que falta.
 */
create type public.money_total as (
  currency      char(3),
  known_minor   bigint,
  known_count   bigint,
  unknown_count bigint
);

create or replace function app.money_total_add(
  p_state    public.money_total,
  p_minor    bigint,
  p_currency char(3)
) returns public.money_total language plpgsql immutable as $$
declare v public.money_total;
begin
  v := coalesce(p_state, row(null, 0, 0, 0)::public.money_total);
  if p_currency is not null then
    if v.currency is null then
      v.currency := p_currency;
    elsif v.currency <> p_currency then
      raise exception 'no se suman monedas distintas (% y %)', v.currency, p_currency
        using errcode = 'check_violation';
    end if;
  end if;
  if p_minor is null then
    v.unknown_count := v.unknown_count + 1;
  else
    perform app.assert_money(p_minor, 'un monto de la suma');
    v.known_minor := v.known_minor + p_minor;
    v.known_count := v.known_count + 1;
  end if;
  return v;
end;
$$;

create aggregate app.sum_money(bigint, char(3)) (
  sfunc    = app.money_total_add,
  stype    = public.money_total,
  initcond = '(,0,0,0)'
);

/** El total, o NULL si faltaba aunque fuera uno. NUNCA el pedazo conocido disfrazado de total. */
create or replace function app.money_known(p_total public.money_total)
returns bigint language sql immutable as $$
  select case when p_total.unknown_count = 0 then p_total.known_minor end;
$$;

create or replace function app.money_status_of(p_total public.money_total)
returns public.money_status language sql immutable as $$
  select case when p_total.unknown_count = 0 then 'KNOWN' else 'UNKNOWN' end::public.money_status;
$$;

/** El subtotal declarado como tal: «al menos $X, y faltan N». Nunca se pinta solo. */
create or replace function app.money_at_least(p_total public.money_total)
returns bigint language sql immutable as $$
  select p_total.known_minor;
$$;

-- ---------------------------------------------------------------------------
-- 6. EL VALOR DEL LOTE, EN ENTERO Y CON SU MONEDA CONGELADA
-- ---------------------------------------------------------------------------

alter table public.inventory_lots
  add column currency             char(3) references public.currency_units (code),
  add column value_minor          bigint,
  add column value_status         public.money_status not null default 'UNKNOWN',
  add column value_unknown_reason public.money_unknown_reason default 'LOT_VALUE_UNKNOWN';

comment on column public.inventory_lots.value_minor is
  'DUEÑO ÚNICO del valor del lote, en unidades menores enteras. '
  'acquisition_value (numeric(12,4)) queda declarado como PRECISIÓN INTERNA de '
  'reparto — K-19 congelado — y NO es la fuente de esta columna: derivarla lote '
  'por lote con trunc() perdía plata en cada partición.';

comment on column public.inventory_lots.currency is
  'Congelada en la recepción. Las vistas convierten con ESTA moneda y no con '
  'households.currency: cambiarle la moneda al hogar reinterpretaría el valor '
  'de todos los lotes históricos.';

alter table public.inventory_lots
  add constraint lot_value_coherente
  check (app.money_coherent(value_status, value_minor, value_unknown_reason));

/**
 * [H57] La moneda del lote se pone al nacer y no se toca más.
 *
 * Es un trigger y no un default porque el default tendría que ser una constante
 * ('CLP') y eso sería mentira para un hogar en otra moneda. Los caminos viejos
 * de inserción (add_manual_lot, receive_shopping_list, split_lot, prep) no
 * conocen esta columna: el trigger la completa desde el hogar EN EL MOMENTO de
 * la inserción, y la congela ahí.
 */
create or replace function app.freeze_lot_currency()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.currency is null then
      select h.currency into new.currency from public.households h where h.id = new.household_id;
    end if;
    return new;
  end if;
  -- COMPLETAR NO ES CAMBIAR. `old.currency is not null` no es una concesión al
  -- backfill: es la regla dicha bien. NULL no es una moneda, es la ausencia de
  -- una — llenarla no reinterpreta nada, porque no había nada que interpretar.
  -- Lo que esta guarda existe para impedir es pasar de una moneda A OTRA, que sí
  -- reescribe el significado de un número ya guardado.
  --
  -- Sin este matiz la migración se mataba a sí misma, y de la peor forma: el
  -- trigger se crea unas líneas más arriba y el backfill de acá abajo
  -- (`set currency = h.currency where currency is null`) es justamente un
  -- NULL → 'CLP'. Sobre una tabla vacía el update no toca ninguna fila, nadie se
  -- entera y todo pasa en verde; sobre una despensa con lotes de verdad, la
  -- migración aborta a la mitad. Lo encontró el ensayo de despliegue el día que
  -- dejó de correr sobre una base vacía.
  --
  -- Y después del `set not null` de más abajo, ninguna fila puede volver a tener
  -- la moneda en NULL, así que esta puerta queda cerrada igual: no se abre un
  -- camino, se describe uno que sólo existe mientras la columna se está
  -- llenando.
  if old.currency is not null and new.currency is distinct from old.currency then
    raise exception 'la moneda de un lote no se cambia: reinterpretaría lo que costó'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger lots_currency_frozen
before insert or update on public.inventory_lots
for each row execute function app.freeze_lot_currency();

update public.inventory_lots l
set currency = h.currency
from public.households h
where h.id = l.household_id and l.currency is null;

alter table public.inventory_lots alter column currency set not null;

/**
 * Backfill del valor: lo que NO cabe exacto en la escala menor queda DESCONOCIDO.
 *
 * En producción `acquisition_value` está en NULL en todas las filas (nunca tuvo
 * un escritor legítimo: hasta hoy solo lo escriben los tests con UPDATE crudo),
 * así que esto es un no-op real. Pero si alguna fila tiene un residuo de
 * partición —5666,6667— NO se aproxima: aproximar sería inventar los $2 que
 * este sprint existe para no perder. Se declara desconocido, con su motivo.
 */
update public.inventory_lots
set value_minor = app.value_to_minor(acquisition_value, currency),
    value_status = 'KNOWN',
    value_unknown_reason = null
where acquisition_value is not null
  and app.value_fits_minor(acquisition_value, currency);

/**
 * El escritor del valor de un lote recibido.
 *
 * Vive en el esquema `app` (no lo expone PostgREST): lo llama la recepción de
 * compras de 0043. Solo permite UNKNOWN → KNOWN, o reescribir el mismo monto:
 * una boleta que llega DESPUÉS completa lo que faltaba, pero NO reescribe lo
 * que ya costó algo. La historia es inmutable.
 *
 * Escribe también `acquisition_value` para que la maquinaria K-19 (split/merge
 * en numeric) siga viendo el mismo número: un solo punto de entrada, dos
 * representaciones, cero divergencia.
 */
create or replace function app.set_lot_value(
  p_lot_id uuid,
  p_minor  bigint,
  p_reason public.money_unknown_reason default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_lot public.inventory_lots;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null then
    raise exception 'lote inexistente' using errcode = 'check_violation';
  end if;

  if p_minor is null then
    if v_lot.value_status = 'KNOWN' then
      raise exception 'este lote ya tiene valor conocido: no se vuelve desconocido'
        using errcode = 'check_violation';
    end if;
    update public.inventory_lots
    set value_unknown_reason = coalesce(p_reason, value_unknown_reason)
    where id = p_lot_id;
    return;
  end if;

  perform app.assert_money(p_minor, 'el valor del lote');
  if v_lot.value_status = 'KNOWN' and v_lot.value_minor <> p_minor then
    raise exception
      'este lote ya costó % : una boleta que llega después completa lo que faltaba, no reescribe la historia',
      v_lot.value_minor using errcode = 'check_violation';
  end if;

  update public.inventory_lots
  set value_minor = p_minor,
      value_status = 'KNOWN',
      value_unknown_reason = null,
      acquisition_value = app.minor_to_value(p_minor, currency)
  where id = p_lot_id;
end;
$$;

/**
 * El valor de un lote en la escala entera, para quien tenga que costear.
 *
 * Devuelve NULL cuando el valor es DESCONOCIDO, y NULL acá significa
 * DESCONOCIDO — no cero: quien lo llame tiene que declarar el desconocido, no
 * sumarlo como si fuera nada.
 *
 * Esta es la puerta que deben usar 0043 y 0044 para leer cuánto costó un lote.
 * NO se lee `acquisition_value` con `app.value_to_minor`: esa columna es
 * precisión interna de reparto y, en un lote partido, no cabe exacta en pesos
 * (por eso `value_to_minor` revienta ahí en vez de perder la diferencia).
 */
create or replace function app.lot_value_minor(p_lot_id uuid)
returns bigint language sql stable set search_path = public as $$
  select case when l.value_status = 'KNOWN' then l.value_minor end
  from public.inventory_lots l where l.id = p_lot_id;
$$;

-- ---------------------------------------------------------------------------
-- 7. split_lot v4: la suma de los hijos ES el valor del padre, al peso
-- ---------------------------------------------------------------------------

/**
 * v4 = v3 (0015, con frozen_at) + DOS arreglos:
 *
 *   [H13] El valor entero (`value_minor`) se reparte con `app.apportion` entre
 *         los hijos Y EL PADRE, en una sola pasada: los pesos son las
 *         cantidades en milésimas más una parte final con lo que el padre
 *         conserva. Hamilton garantiza Σ hijos + padre = valor original, exacto,
 *         sin residuos flotantes ni en la partición total ni en la parcial.
 *
 *   [diseño §1.3] `greatest(acquisition_value - repartido, 0)` era una fuga
 *         MUDA: si el reparto excedía el valor del padre, el clamp se comía la
 *         diferencia y nadie se enteraba. Ahora el reparto en `numeric` se
 *         calcula contra un objetivo de grupo redondeado UNA vez —así el débito
 *         del padre no puede ser negativo por construcción— y si igual lo
 *         fuera, revienta en vez de aplanar.
 *
 * Los asserts congelados de K-19 (17003, 4500, 1700, 1500 y el NULL dominante)
 * no cambian: la partición total sigue dando exactamente los mismos números.
 */
create or replace function public.split_lot(
  p_lot_id     uuid,
  p_quantities numeric[]
) returns uuid[] language plpgsql security definer set search_path = public as $$
declare
  v_lot public.inventory_lots;
  v_member uuid;
  v_group uuid := gen_random_uuid();
  v_total numeric := 0;
  v_q numeric;
  v_hijo uuid;
  v_hijos uuid[] := '{}';
  v_valor_hijo numeric;
  v_valor_repartido numeric := 0;
  v_objetivo numeric;
  v_i int := 0;
  v_n int;
  v_pesos bigint[] := '{}';
  v_partes bigint[];
  v_valor_minor_hijo bigint;
  v_status public.money_status;
  v_reason public.money_unknown_reason;
begin
  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_lot.status <> 'AVAILABLE' then
    raise exception 'solo se parte un lote disponible (este está %)', v_lot.status;
  end if;

  v_n := coalesce(array_length(p_quantities, 1), 0);
  if v_n = 0 then raise exception 'partir requiere al menos una parte'; end if;

  foreach v_q in array p_quantities loop
    perform app.assert_finite(v_q, 'una parte');
    if v_q is null or v_q <= 0 then raise exception 'cada parte debe ser mayor que cero'; end if;
    v_total := v_total + v_q;
    -- Peso en MILÉSIMAS de la unidad: `quantity` es numeric(12,3), así que la
    -- cantidad que el lote va a guardar de verdad cabe exacta en un entero.
    -- Se redondea a 3 decimales ANTES de pesar para que el peso del reparto sea
    -- el de la cantidad guardada y no el del parámetro crudo: si el reparto
    -- pesara más decimales que el ledger, el dinero seguiría a una cantidad que
    -- no existe.
    v_pesos := v_pesos || (round(v_q, 3) * 1000)::bigint;
  end loop;
  if v_total > v_lot.quantity then
    raise exception 'las partes suman % pero el lote tiene %: partir no crea comida',
      v_total, v_lot.quantity;
  end if;

  -- La última parte del reparto es LO QUE EL PADRE CONSERVA. Si la partición es
  -- total, ese peso es 0 y Hamilton le entrega exactamente 0 (el sobrante nunca
  -- alcanza a los pesos cero). Con esto el mismo reparto sirve para la
  -- partición total y la parcial, sin dos ramas que puedan divergir.
  v_pesos := v_pesos || (round(v_lot.quantity - v_total, 3) * 1000)::bigint;

  if v_lot.value_status = 'KNOWN' then
    v_partes := app.apportion(v_lot.value_minor, v_pesos);
  end if;

  v_member := app.current_member_id(v_lot.household_id);

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, group_id, actor_member_id)
  values (v_lot.household_id, p_lot_id, 'SPLIT', -v_total, v_group, v_member);

  -- K-19 en numeric: el grupo se lleva un objetivo REDONDEADO UNA VEZ, y el
  -- último hijo absorbe el residuo. Antes cada hijo se redondeaba por su cuenta
  -- y la suma podía pasarse del valor del padre; ahí entraba el greatest(...,0).
  if v_lot.acquisition_value is not null and v_lot.quantity > 0 then
    v_objetivo := round(v_lot.acquisition_value * v_total / v_lot.quantity, 4);
  else
    v_objetivo := null;
  end if;

  foreach v_q in array p_quantities loop
    v_i := v_i + 1;

    if v_objetivo is null then
      v_valor_hijo := null;
    elsif v_i = v_n then
      v_valor_hijo := v_objetivo - v_valor_repartido;
    else
      v_valor_hijo := round(v_lot.acquisition_value * v_q / v_lot.quantity, 4);
    end if;
    v_valor_repartido := v_valor_repartido + coalesce(v_valor_hijo, 0);

    if v_lot.value_status = 'KNOWN' then
      v_valor_minor_hijo := v_partes[v_i];
      v_status := 'KNOWN';
      v_reason := null;
    else
      v_valor_minor_hijo := null;
      v_status := 'UNKNOWN';
      -- El hijo hereda el MOTIVO del padre: "no sé cuánto costó esto" tiene la
      -- misma causa que en el lote de origen, y perderla dejaría un desconocido
      -- sin explicación.
      v_reason := coalesce(v_lot.value_unknown_reason, 'LOT_VALUE_UNKNOWN');
    end if;

    insert into public.inventory_lots (
      household_id, ingredient_id, product_id, label, quantity, unit, weight_basis,
      processing_state, temperature_state, thawed_at, frozen_at, vacuum_sealed,
      location_id, expiry_date, use_by, parent_lot_id,
      acquisition_value, currency, value_minor, value_status, value_unknown_reason, created_by
    ) values (
      v_lot.household_id, v_lot.ingredient_id, v_lot.product_id, v_lot.label,
      0, v_lot.unit, v_lot.weight_basis,
      v_lot.processing_state, v_lot.temperature_state, v_lot.thawed_at, v_lot.frozen_at,
      v_lot.vacuum_sealed,
      v_lot.location_id, v_lot.expiry_date, v_lot.use_by, p_lot_id,
      v_valor_hijo, v_lot.currency, v_valor_minor_hijo, v_status, v_reason,
      v_member
    ) returning id into v_hijo;

    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, group_id, actor_member_id)
    values (v_lot.household_id, v_hijo, 'SPLIT', v_q, v_group, v_member);

    v_hijos := v_hijos || v_hijo;
  end loop;

  -- El padre entrega lo que se llevaron los hijos: la despensa completa sigue
  -- valiendo lo mismo antes y después de partir.
  if v_lot.acquisition_value is not null then
    if v_valor_repartido > v_lot.acquisition_value then
      raise exception
        'el reparto se llevó % de un lote que valía %: partir no crea dinero',
        v_valor_repartido, v_lot.acquisition_value
        using errcode = 'check_violation';
    end if;
    update public.inventory_lots
    set acquisition_value = acquisition_value - v_valor_repartido
    where id = p_lot_id;
  end if;

  if v_lot.value_status = 'KNOWN' then
    update public.inventory_lots
    set value_minor = v_partes[v_n + 1]
    where id = p_lot_id;
  end if;

  return v_hijos;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. merge_lots v4: si una parte es DESCONOCIDA, el resultado es DESCONOCIDO
-- ---------------------------------------------------------------------------

/**
 * v4 = v3 (0019, K-1 + A-5 + C-5) + el valor entero.
 *
 * La regla de K-19 se mantiene y ahora se escribe en la escala que la gente ve:
 * si algún lote de origen tiene valor DESCONOCIDO, el resultado es DESCONOCIDO
 * con motivo MIXED_UNKNOWN_MERGE — no la suma de la parte conocida, que sería
 * un número que se lee como completo.
 *
 * Los orígenes quedan en KNOWN 0 y no en desconocido: entregaron todo lo que
 * tenían y quedaron en cero. Eso SE SABE. (`acquisition_value` de los orígenes
 * sigue yendo a NULL, como quedó congelado en 0019: esa columna es precisión
 * interna, no un estado monetario.)
 */
create or replace function public.merge_lots(
  p_lot_ids uuid[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
  v_primero public.inventory_lots;
  v_lot public.inventory_lots;
  v_id uuid;
  v_group uuid := gen_random_uuid();
  v_member uuid;
  v_total numeric := 0;
  v_valor numeric := 0;
  v_hay_valor boolean := false;
  v_minor bigint := 0;
  v_minor_desconocido boolean := false;
  v_nuevo uuid;
begin
  if coalesce(array_length(p_lot_ids, 1), 0) < 2 then
    raise exception 'unir requiere al menos dos lotes';
  end if;
  select array_agg(x order by x) into v_ids from unnest(p_lot_ids) as x;

  foreach v_id in array v_ids loop
    select * into v_lot from public.inventory_lots where id = v_id for update;
    if v_lot.id is null or not app.is_household_member(v_lot.household_id) then
      raise exception 'no autorizado';
    end if;
    if v_lot.status <> 'AVAILABLE' or v_lot.quantity <= 0 then
      raise exception 'solo se unen lotes disponibles con cantidad';
    end if;
    if v_primero.id is null then
      v_primero := v_lot;
    else
      if v_lot.household_id <> v_primero.household_id
         or v_lot.ingredient_id is distinct from v_primero.ingredient_id
         or v_lot.product_id is distinct from v_primero.product_id
         or v_lot.unit <> v_primero.unit
         or v_lot.weight_basis <> v_primero.weight_basis
         or v_lot.processing_state <> v_primero.processing_state
         or v_lot.temperature_state <> v_primero.temperature_state
         or v_lot.vacuum_sealed <> v_primero.vacuum_sealed then
        raise exception 'esos lotes no se pueden unir: estado, alimento o base incompatibles';
      end if;
      if v_lot.currency is distinct from v_primero.currency then
        raise exception 'esos lotes están en monedas distintas (% y %)',
          v_primero.currency, v_lot.currency using errcode = 'check_violation';
      end if;
    end if;
    v_total := v_total + v_lot.quantity;
    if v_lot.acquisition_value is null then
      v_hay_valor := false;
      v_valor := null;
    elsif v_valor is not null then
      v_valor := v_valor + v_lot.acquisition_value;
      v_hay_valor := true;
    end if;
    -- El desconocido DOMINA: una sola parte sin valor deja al resultado sin valor.
    if v_lot.value_status = 'UNKNOWN' then
      v_minor_desconocido := true;
    elsif not v_minor_desconocido then
      v_minor := v_minor + v_lot.value_minor;
    end if;
  end loop;

  v_member := app.current_member_id(v_primero.household_id);

  insert into public.inventory_lots (
    household_id, ingredient_id, product_id, label, quantity, unit, weight_basis,
    processing_state, temperature_state, thawed_at, frozen_at, vacuum_sealed,
    location_id, expiry_date, use_by,
    acquisition_value, currency, value_minor, value_status, value_unknown_reason, created_by
  ) values (
    v_primero.household_id, v_primero.ingredient_id, v_primero.product_id, v_primero.label,
    0, v_primero.unit, v_primero.weight_basis,
    v_primero.processing_state, v_primero.temperature_state,
    (select max(l.thawed_at) from public.inventory_lots l where l.id = any(v_ids)),
    (select min(l.frozen_at) from public.inventory_lots l where l.id = any(v_ids)),
    v_primero.vacuum_sealed,
    v_primero.location_id,
    (select min(l.expiry_date) from public.inventory_lots l where l.id = any(v_ids)),
    (select min(l.use_by) from public.inventory_lots l where l.id = any(v_ids)),
    case when v_hay_valor and v_valor is not null then v_valor else null end,
    v_primero.currency,
    case when v_minor_desconocido then null else v_minor end,
    case when v_minor_desconocido then 'UNKNOWN' else 'KNOWN' end::public.money_status,
    case when v_minor_desconocido then 'MIXED_UNKNOWN_MERGE' end::public.money_unknown_reason,
    v_member
  ) returning id into v_nuevo;

  foreach v_id in array v_ids loop
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, group_id, actor_member_id)
    select v_primero.household_id, v_id, 'MERGE', -l.quantity, v_group, v_member
    from public.inventory_lots l where l.id = v_id;
    -- El valor viaja con la comida: el origen entregó todo y queda en CERO
    -- CONOCIDO. Cero conocido, no desconocido: sabemos perfectamente que ya no
    -- vale nada porque ya no tiene nada.
    update public.inventory_lots
    set acquisition_value = null,
        value_minor = 0,
        value_status = 'KNOWN',
        value_unknown_reason = null
    where id = v_id;
  end loop;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, group_id, actor_member_id)
  values (v_primero.household_id, v_nuevo, 'MERGE', v_total, v_group, v_member);

  return v_nuevo;
end;
$$;

-- ===========================================================================
-- ETAPA 2 — PERMISOS FINANCIEROS FINOS Y EL CIERRE DE LA COLUMNA DE VALOR
--
-- Este bloque es la segunda mitad del cimiento y va en el MISMO archivo porque
-- las políticas de la 0043 y la 0044 nombran `app.finance_access(...)`: sin el
-- helper puesto acá, esas migraciones ni siquiera se pueden declarar.
--
-- POR QUÉ NO SON FLAGS EN `household_roles`. Esa tabla ya tiene cinco flags y
-- TRES ESTÁN MUERTOS (`can_edit_plan`, `can_cook`, `can_manage_members` no
-- aparecen en ninguna policy hasta la 0039). Agregar cinco más al mismo lugar es
-- agregar cinco decoraciones. Se clona en cambio el patrón que sí se aplicó:
-- `medical_permission` + `medical_data_grants` + `app.medical_access` (0026),
-- pero SIN tocar el enum clínico: agregarle valores financieros rompería la
-- separación que vigila `salud-privacidad.test.ts`, y una boleta del súper no es
-- un dato médico.
--
-- Los cuatro defectos que la revisión adversarial encontró en esta sección
-- quedan cerrados ACÁ, no después:
--
--   [H53] EL CLON PERDIÓ LA DIMENSIÓN DE DUEÑO. `medical_data_grants` tiene
--         `owner_member_id` + `grantee_member_id`: el permiso siempre es «sobre
--         los datos de ALGUIEN». La versión del diseño sólo tenía
--         `(household_id, member_id, permission)`. Combinado con
--         `cost_allocations.member_id`, cualquiera con FINANCE_VIEW podía sacar
--         un ranking de cuánto cuesta cada integrante: «la Sofía se come los
--         $40.000 del mes». Lo que ya era público en el hogar era QUÉ comió cada
--         uno; ponerle PRECIO a cada persona es una capacidad nueva de este
--         sprint y nace con permiso propio: `FINANCE_VIEW_MEMBER`, con dueño.
--
--   [H54] `app.finance_access` OMITÍA `m.is_active`. `app.is_household_admin`
--         (0001:125) sí lo exige. Sin eso, el integrante desactivado —la forma
--         normal de «esta persona ya no vive acá»— conservaba para siempre el
--         permiso de ver las boletas del hogar (con RUT, dirección, comercio y
--         patrón de compra) y de confirmarlas, o sea de mover inventario y
--         dinero. Acá va en las dos vías, y además un trigger CIERRA los grants
--         vivos cuando alguien se desactiva: nadie se va a acordar de revocarlos
--         a mano.
--
--   [H55] LA TABLA DE OTORGAMIENTOS ERA LA ÚNICA SIN RLS DECLARADA. La
--         enumeración de policies del diseño nombraba ocho tablas y se saltaba
--         justo la que decide los permisos. Sin `enable row level security`
--         queda escribible por PostgREST: cualquier usuario se auto-inserta
--         `(hogar ajeno, su member_id, 'FINANCE_VIEW')` y a partir de ahí el
--         helper le responde true. Escalada total entre hogares.
--
--   [H-ID] `invitations.role_code` es `text` libre sin CHECK ni FK, y
--         `accept_invitation` hace `if v_role is not null` — o sea, un código
--         que no existe produce EN SILENCIO un integrante con cero permisos. La
--         FK lo vuelve imposible de insertar.
-- ===========================================================================

create type public.finance_permission as enum (
  -- Agregados del hogar: caja, consumo, merma, valor de despensa, presupuesto.
  'FINANCE_VIEW',
  -- El desglose POR PERSONA. Separado a propósito ([H53]): es la capacidad de
  -- ponerle precio a un integrante, y en un hogar real eso es munición.
  'FINANCE_VIEW_MEMBER',
  'FINANCE_UPLOAD_RECEIPTS',
  'FINANCE_CONFIRM_RECEIPTS',
  'FINANCE_MANAGE_PRICES',
  'FINANCE_MANAGE_BUDGET'
);

comment on type public.finance_permission is
  'La separacion importa en la vida real: el adolescente sube la foto de la '
  'boleta sin poder confirmarla (confirmar mueve inventario y dinero); la '
  'abuela ve cuanto se gasto sin poder cambiar el presupuesto; quien anota '
  'precios en la feria no necesita ver el presupuesto familiar.';

create table public.household_finance_grants (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households (id) on delete cascade,
  -- A QUIÉN se le da (grantee).
  member_id       uuid not null references public.household_members (id) on delete cascade,
  -- SOBRE QUIÉN. NULL = el permiso es sobre los agregados del hogar, que no
  -- tienen dueño. Con valor = sobre el gasto de ESA persona ([H53]).
  owner_member_id uuid references public.household_members (id) on delete cascade,
  permission      public.finance_permission not null,
  granted_by      uuid not null references public.household_members (id),
  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_by      uuid references public.household_members (id),
  reason          text,

  -- Sólo el permiso por persona lleva dueño; los agregados no tienen sobre
  -- quién. Un grant de FINANCE_VIEW con dueño sería una regla que nadie evalúa.
  constraint finance_grant_dueno_coherente check (
    permission = 'FINANCE_VIEW_MEMBER' or owner_member_id is null
  )
);

-- UN permiso VIVO por par (calcado de medical_data_grants). El dueño entra a la
-- clave: ver el gasto de la Sofía y el del Beto son dos filas distintas.
create unique index finance_grant_vivo on public.household_finance_grants
  (household_id, member_id, permission,
   coalesce(owner_member_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;

create index finance_grants_member_idx
  on public.household_finance_grants (household_id, member_id);

comment on table public.household_finance_grants is
  'La revocacion es una fila que SE CIERRA, no un DELETE: queda la historia de '
  'quien dio que a quien y cuando, igual que en los grants medicos.';

-- [H55] La tabla que decide los permisos es la que más RLS necesita.
alter table public.household_finance_grants enable row level security;
revoke insert, update, delete on public.household_finance_grants from anon, authenticated;

/**
 * Quién puede VER los otorgamientos: el propio integrante los suyos, y el
 * administrador todos los del hogar. Nadie más, y nadie escribe por PostgREST:
 * la escritura pasa por los dos RPC de más abajo.
 */
create policy finance_grants_select on public.household_finance_grants
  for select to authenticated
  using (
    app.is_household_admin(household_id)
    or exists (
      select 1 from public.household_members m
      where m.id = household_finance_grants.member_id
        and m.user_id = auth.uid() and m.is_active
    )
  );

-- ---------------------------------------------------------------------------
-- Los helpers
-- ---------------------------------------------------------------------------

/** ¿Este integrante soy yo? El dueño de un dato siempre puede verlo. */
create or replace function app.is_self_member(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members m
    where m.id = p_member and m.user_id = auth.uid() and m.is_active
  );
$$;

/**
 * El permiso sobre los AGREGADOS del hogar.
 *
 * `m.is_active` en las DOS vías ([H54]). El `r.household_id = m.household_id` es
 * el anclaje que se corrigió en `0009_shopping.sql:361`: sin él, un rol de otro
 * hogar cuenta.
 */
create or replace function app.finance_access(
  p_household  uuid,
  p_permission public.finance_permission
) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    -- vía 1: administrador del hogar, por definición
    select 1 from public.household_members m
      join public.member_role_assignments a on a.member_id = m.id
      join public.household_roles r on r.id = a.role_id
                                   and r.household_id = m.household_id
     where m.household_id = p_household and m.user_id = auth.uid()
       and m.is_active and r.is_admin
    union all
    -- vía 2: grant vivo
    select 1 from public.household_finance_grants g
      join public.household_members m on m.id = g.member_id
     where g.household_id = p_household and m.user_id = auth.uid() and m.is_active
       and g.permission = p_permission and g.revoked_at is null
  );
$$;

/**
 * El permiso sobre el gasto de UNA PERSONA ([H53]).
 *
 * Tres vías y ninguna más: soy yo, tengo un grant de FINANCE_VIEW_MEMBER sobre
 * esa persona, o soy admin. El admin la tiene porque en este producto el admin
 * es quien responde por el hogar; lo que cambia es que ahora es una decisión
 * escrita y auditable, no un efecto colateral de no haber pensado el caso.
 */
create or replace function app.finance_member_access(
  p_household uuid,
  p_owner     uuid
) returns boolean language sql stable security definer set search_path = public as $$
  select p_owner is null
      or app.is_self_member(p_owner)
      or app.is_household_admin(p_household)
      or exists (
        select 1 from public.household_finance_grants g
          join public.household_members m on m.id = g.member_id
         where g.household_id = p_household and m.user_id = auth.uid() and m.is_active
           and g.permission = 'FINANCE_VIEW_MEMBER'
           and g.owner_member_id = p_owner
           and g.revoked_at is null
      );
$$;

-- ---------------------------------------------------------------------------
-- Otorgar y revocar
-- ---------------------------------------------------------------------------

create or replace function public.grant_finance_access(
  p_household  uuid,
  p_member     uuid,
  p_permission public.finance_permission,
  p_owner      uuid default null,
  p_reason     text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid;
  v_id    uuid;
begin
  if not app.is_household_admin(p_household) then
    raise exception 'no autorizado';
  end if;
  v_actor := app.current_member_id(p_household);

  -- El integrante y el dueño tienen que ser de ESTE hogar. Sin esto, un admin
  -- podría darle permiso a alguien de otra casa sobre el gasto de la suya.
  if not exists (select 1 from public.household_members m
                 where m.id = p_member and m.household_id = p_household and m.is_active) then
    raise exception 'ese integrante no es de este hogar';
  end if;
  if p_owner is not null and not exists (
       select 1 from public.household_members m
       where m.id = p_owner and m.household_id = p_household) then
    raise exception 'esa persona no es de este hogar';
  end if;
  if p_permission <> 'FINANCE_VIEW_MEMBER' and p_owner is not null then
    raise exception 'solo el permiso por integrante lleva dueno';
  end if;

  insert into public.household_finance_grants
    (household_id, member_id, owner_member_id, permission, granted_by, reason)
  values (p_household, p_member, p_owner, p_permission, v_actor, p_reason)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    -- Ya lo tenía vivo: devolver el que existe es idempotente y no miente.
    select id into v_id from public.household_finance_grants
     where household_id = p_household and member_id = p_member
       and permission = p_permission
       and owner_member_id is not distinct from p_owner
       and revoked_at is null;
  else
    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (p_household, auth.uid(), 'FINANCE_ACCESS_GRANTED', 'finance_grant', v_id,
            jsonb_build_object('permission', p_permission, 'member_id', p_member));
  end if;

  return v_id;
end;
$$;

create or replace function public.revoke_finance_access(
  p_grant  uuid,
  p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_g public.household_finance_grants;
begin
  select * into v_g from public.household_finance_grants where id = p_grant for update;
  if v_g.id is null or not app.is_household_admin(v_g.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_g.revoked_at is not null then
    return;  -- revocar dos veces no es un error: ya no está.
  end if;

  update public.household_finance_grants
     set revoked_at = now(),
         revoked_by = app.current_member_id(v_g.household_id),
         reason = coalesce(p_reason, reason)
   where id = p_grant;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_g.household_id, auth.uid(), 'FINANCE_ACCESS_REVOKED', 'finance_grant', p_grant,
          jsonb_build_object('permission', v_g.permission, 'member_id', v_g.member_id));
end;
$$;

/**
 * [H54] Desactivar a un integrante CIERRA sus permisos financieros.
 *
 * `m.is_active` en el helper ya lo deja afuera, pero un grant vivo colgando de
 * alguien desactivado es una bomba de tiempo: el día que a esa persona la
 * reactivan por cualquier motivo, recupera de golpe el acceso a las boletas sin
 * que nadie lo haya decidido. Se cierra la fila, con motivo, y queda en el libro.
 */
create or replace function app.cerrar_grants_al_desactivar()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cuantos int;
begin
  if new.is_active or not old.is_active then
    return new;
  end if;
  update public.household_finance_grants
     set revoked_at = now(), reason = 'MIEMBRO_DESACTIVADO'
   where member_id = new.id and revoked_at is null;
  get diagnostics v_cuantos = row_count;
  if v_cuantos > 0 then
    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (new.household_id, auth.uid(), 'FINANCE_ACCESS_REVOKED', 'household_member', new.id,
            jsonb_build_object('motivo', 'MIEMBRO_DESACTIVADO', 'grants', v_cuantos));
  end if;
  return new;
end;
$$;

create trigger finance_grants_al_desactivar
  after update of is_active on public.household_members
  for each row execute function app.cerrar_grants_al_desactivar();

-- ---------------------------------------------------------------------------
-- Siembra y backfill: NADIE PIERDE ACCESO al aplicar el sprint
-- ---------------------------------------------------------------------------

/**
 * Los admin ya tienen los permisos por la vía 1 del helper. El backfill escribe
 * igual la fila: el objetivo del sprint no es sólo que el acceso exista, es que
 * DEJE DE SER IMPLÍCITO y pase a ser una fila auditable que se puede revocar.
 */
insert into public.household_finance_grants
  (household_id, member_id, permission, granted_by, reason)
select m.household_id, m.id, p.permission, m.id, 'BACKFILL_SPRINT_14'
  from public.household_members m
  join public.member_role_assignments a on a.member_id = m.id
  join public.household_roles r on r.id = a.role_id and r.household_id = m.household_id
  cross join unnest(enum_range(null::public.finance_permission)) as p(permission)
 where r.is_admin and m.is_active
   -- FINANCE_VIEW_MEMBER lleva dueño y no se puede sembrar «sobre todos»: el
   -- admin lo tiene por la vía declarada de `app.finance_member_access`.
   and p.permission <> 'FINANCE_VIEW_MEMBER'
on conflict do nothing;

/**
 * `create_household` siembra los grants al creador.
 *
 * Se reescribe entera porque no hay forma de «agregarle» un paso a una función
 * en Postgres. Es la misma de 0001 con el bloque financiero al final: si alguien
 * compara, la diferencia es exactamente ésa.
 */
create or replace function public.create_household(p_name text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_member uuid;
  v_admin_role uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  insert into public.households (name) values (p_name) returning id into v_household;

  insert into public.household_members (household_id, user_id, display_name)
  values (v_household, auth.uid(), p_display_name)
  returning id into v_member;

  insert into public.household_roles (household_id, code, name, is_admin, can_manage_members, can_edit_plan, can_manage_shopping, can_cook)
  values
    (v_household, 'ADMIN',   'Administrador familiar', true,  true,  true,  true,  true),
    (v_household, 'MEMBER',  'Integrante',             false, false, false, false, false),
    (v_household, 'PLANNER', 'Planificador',           false, false, true,  false, false),
    (v_household, 'SHOPPER', 'Comprador',              false, false, false, true,  false),
    (v_household, 'COOK',    'Cocinero',               false, false, false, false, true);

  select id into v_admin_role from public.household_roles
  where household_id = v_household and code = 'ADMIN';

  insert into public.member_role_assignments (member_id, role_id, granted_by)
  values (v_member, v_admin_role, v_member);

  -- Sprint 14: el creador nace con los permisos financieros del hogar como
  -- FILAS, no como un efecto colateral de ser admin.
  insert into public.household_finance_grants
    (household_id, member_id, permission, granted_by, reason)
  select v_household, v_member, p.permission, v_member, 'CREADOR_DEL_HOGAR'
    from unnest(enum_range(null::public.finance_permission)) as p(permission)
   where p.permission <> 'FINANCE_VIEW_MEMBER';

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
  values (v_household, auth.uid(), 'HOUSEHOLD_CREATED', 'household', v_household);

  return v_household;
end;
$$;

-- ---------------------------------------------------------------------------
-- [H-ID] La invitación con un rol que no existe deja de ser posible
-- ---------------------------------------------------------------------------

/**
 * `accept_invitation` (0037:97) hace `if v_role is not null then ... end if`: un
 * `role_code` que no existe en ese hogar produce en silencio un integrante SIN
 * ningún rol, o sea sin permisos y sin explicación. La FK lo vuelve imposible de
 * insertar, que es mejor que fallar al aceptar: el problema se ve al invitar,
 * cuando todavía hay alguien mirando la pantalla.
 */
alter table public.invitations
  add constraint invitations_role_fk
  foreign key (household_id, role_code)
  references public.household_roles (household_id, code)
  on update cascade;
