-- Sprint 14 — LAS GUARDAS: el sistema se verifica solo y el desconocido no se
-- puede esconder.
--
-- Última migración del sprint. Tres trabajos, en este orden:
--
--   1. CERRAR LA LECTURA DEL DINERO DE LA DESPENSA. Va acá y no en la 0042 por
--      una razón mecánica: Postgres no deja revocar una columna suelta cuando el
--      rol tiene `select` sobre la TABLA. Hay que revocar la tabla y volver a
--      otorgar columna por columna, así que cualquier `alter table ... add
--      column` posterior nace SIN permiso. La 0043 le agrega
--      `procurement_item_id` a `inventory_lots`; puesto en la 0042, el cierre
--      habría roto la despensa una migración después. Va al final, y la
--      operación queda en `app.grant_lot_columns()`, RE-EJECUTABLE:
--
--        >>> TODA migración futura que agregue una columna a `inventory_lots`
--        >>> tiene que terminar con `select app.grant_lot_columns();`
--
--      Sin eso, el `select` de esa columna nueva falla con «permission denied».
--      Falla ruidoso, que es lo correcto, pero falla.
--
--   2. [H53] ESTRECHAR `cost_allocations` A NIVEL DE INTEGRANTE. La policy de la
--      0044 filtra sólo por `FINANCE_VIEW`, y con eso cualquiera con ese permiso
--      podía hacer `select member_id, sum(amount_minor) ... group by member_id
--      order by 2 desc` y sacar un ranking de cuánto cuesta cada persona de la
--      casa. Lo que ya era público en el hogar era QUÉ comió cada uno
--      (`consumption_logs`, 0011:203); ponerle PRECIO a una persona es una
--      capacidad nueva de este sprint y no puede nacer sin control.
--
--   3. LOS INFORMES QUE HACEN VISIBLE LO QUE NO SE PUDO COSTEAR. Un desconocido
--      escondido es peor que un descuadre a la vista.

-- ---------------------------------------------------------------------------
-- 1. El dinero de la despensa, sólo para quien tiene FINANCE_VIEW
-- ---------------------------------------------------------------------------

/**
 * RLS es por FILA; el valor del lote es una COLUMNA dentro de una tabla que
 * todo integrante necesita leer para ver la despensa (cantidades, vencimientos,
 * ubicación). El permiso a nivel de columna es la única herramienta que
 * distingue las dos cosas.
 *
 * Idempotente y re-ejecutable a propósito: es la forma de que una migración
 * futura que agregue una columna pueda arreglarse con una línea.
 */
create or replace function app.grant_lot_columns() returns void
language plpgsql security definer set search_path = public as $$
declare v_cols text;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
    into v_cols
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'inventory_lots'
     and c.column_name not in
         ('acquisition_value', 'value_minor', 'value_status', 'value_unknown_reason');
  if v_cols is null then
    raise exception 'no se pudo leer el esquema de inventory_lots';
  end if;
  execute 'revoke select on public.inventory_lots from anon, authenticated';
  execute format('grant select (%s) on public.inventory_lots to authenticated', v_cols);
end;
$$;

select app.grant_lot_columns();

/**
 * El puente: el valor del lote, ya con permiso.
 *
 * Vista con derechos del DUEÑO (no `security_invoker`) porque tiene que poder
 * leer las columnas que se acaban de cerrar. El alcance por hogar y el permiso
 * los pone el `where`, que es lo mismo que hacía la policy.
 */
create view public.lot_valuations as
select l.id            as lot_id,
       l.household_id,
       l.currency,
       l.value_minor,
       l.value_status,
       l.value_unknown_reason
  from public.inventory_lots l
 where app.finance_access(l.household_id, 'FINANCE_VIEW');

-- Una vista de UNA tabla con un `where` es AUTO-ACTUALIZABLE, y con derechos del
-- dueño un `update` acá escribiría `inventory_lots.value_minor` saltándose la
-- RLS y a `app.set_lot_value`. El dueño único del valor sigue siendo esa función.
revoke insert, update, delete on public.lot_valuations from anon, authenticated;
grant select on public.lot_valuations to authenticated;

comment on view public.lot_valuations is
  'La despensa sigue visible para todos (cantidades, vencimientos, ubicacion) y '
  'el DINERO solo para quien tiene FINANCE_VIEW.';

/**
 * `lot_cost_balance` (0044) es `security_invoker` y lee `l.value_minor`: con las
 * columnas cerradas, un integrante con FINANCE_VIEW recibiría «permission denied
 * for column value_minor» en vez de sus datos. Pasa a derechos del dueño, igual
 * que `lot_valuations`, y su `where app.finance_access(...)` sigue haciendo todo
 * el trabajo de alcance. Es el mismo cambio, en el mismo sitio: cambiar el
 * modelo de permisos obliga a arreglar a sus lectores acá y no después.
 */
alter view public.lot_cost_balance set (security_invoker = false);
revoke insert, update, delete on public.lot_cost_balance from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. [H53] El gasto POR PERSONA no es un agregado del hogar
-- ---------------------------------------------------------------------------

drop policy if exists cost_allocations_select on public.cost_allocations;

create policy cost_allocations_select on public.cost_allocations
  for select to authenticated
  using (
    app.finance_access(household_id, 'FINANCE_VIEW')
    -- Sin `member_id` es un agregado del hogar y basta FINANCE_VIEW. Con
    -- `member_id`, hace falta ser esa persona, ser admin, o tener un grant de
    -- FINANCE_VIEW_MEMBER sobre ella. En un hogar real, «la Sofía se come los
    -- $40.000 del mes» es munición, y hasta ahora no había forma de apagarlo.
    and (member_id is null or app.finance_member_access(household_id, member_id))
  );

comment on table public.cost_allocations is
  'El desglose por integrante exige FINANCE_VIEW_MEMBER sobre esa persona. '
  'Ninguna consulta ni componente del producto ordena, rankea o compara '
  'integrantes por monto: el costo por persona sirve para entender una comida, '
  'no para hacer un ranking.';

-- ---------------------------------------------------------------------------
-- 2.bis LA HISTORIA NO SE REINTERPRETA NI SE BORRA
-- ---------------------------------------------------------------------------

/**
 * [H57] `households.currency` SE CONGELA EN CUANTO HAY PLATA ESCRITA.
 *
 * La 0042 congeló la moneda EN EL LOTE y la 0047 cierra cada período por la
 * moneda de sus propias filas, así que ningún monto histórico cambia de
 * significado. Faltaba la puerta de arriba: nada impedía que un admin hiciera
 * `update public.households set currency = 'USD'` por PostgREST —la policy
 * `households_update` (0001) se lo permite— y a partir de ahí toda compra NUEVA
 * se registraba en una moneda que no es la del hogar, conviviendo con la vieja
 * en la misma pantalla.
 *
 * No se prohíbe para siempre: un hogar recién creado, sin una sola compra ni
 * asignación ni lote valorizado, puede elegir su moneda. Después no, porque
 * después ya no es una preferencia sino la vara con que se midió el pasado.
 * Cambiarla de verdad es una migración de datos con conversión explícita, no un
 * `update` de una fila.
 */
-- SECURITY DEFINER porque mira `inventory_lots.value_status`, y esta misma
-- migración acaba de cerrar por columna la lectura de esa tabla: con los
-- derechos del que invoca, cualquier update a la fila del hogar terminaría en
-- «permission denied for table inventory_lots». No filtra nada: no devuelve
-- montos, sólo decide si el update pasa.
create or replace function app.household_currency_is_frozen()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.currency is not distinct from old.currency then
    return new;
  end if;

  if exists (select 1 from public.purchases where household_id = old.id)
     or exists (select 1 from public.cost_allocations where household_id = old.id)
     or exists (select 1 from public.inventory_lots
                 where household_id = old.id and value_status = 'KNOWN') then
    raise exception
      'este hogar ya tiene plata registrada en %: la moneda no se cambia con un update, porque reinterpretaría todo lo anterior',
      old.currency using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

create trigger households_currency_frozen
  before update on public.households
  for each row execute function app.household_currency_is_frozen();

/**
 * [H68] UN CARGO YA RECONOCIDO COMO GASTO NO SE EDITA NI SE BORRA.
 *
 * `cost_allocations.purchase_charge_id` es `on delete cascade`, y el trigger
 * append-only de la 0044 deja pasar el borrado en cascada a propósito
 * (`pg_trigger_depth() > 1`). Con eso, borrar el cargo ROUNDING —cosa que
 * `reconcile_purchase` hace en su rama de no-tolerancia— arrastraba su
 * asignación de devengo por la puerta de atrás; y el
 * `on conflict do update set amount_minor` de la misma función podía dejar el
 * cargo y su asignación diciendo montos distintos.
 *
 * La discriminación es por profundidad, igual que en la 0044: el `delete`
 * directo sobre el cargo es la operación que hay que atajar; la cascada de
 * borrar el hogar o la compra entera (profundidad > 1) sigue pasando, porque ahí
 * no queda historia que proteger.
 */
create or replace function app.purchase_charge_accrued_is_frozen()
returns trigger language plpgsql as $fn$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if not exists (select 1 from public.cost_allocations a where a.purchase_charge_id = old.id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception
      'el cargo "%" ya está reconocido como gasto del período: borrarlo borraría el devengo, y la historia se corrige con una fila nueva',
      old.label using errcode = 'check_violation';
  end if;
  if new.amount_minor is distinct from old.amount_minor then
    raise exception
      'el cargo "%" ya está reconocido como gasto por %: cambiarle el monto dejaría el devengo diciendo otra cosa',
      old.label, old.amount_minor using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

create trigger purchase_charges_accrued_frozen
  before update or delete on public.purchase_charges
  for each row execute function app.purchase_charge_accrued_is_frozen();

-- ---------------------------------------------------------------------------
-- 3. Los informes de integridad
-- ---------------------------------------------------------------------------

/**
 * DERECHOS DEL DUENO, no `security_invoker`, y esto es una decision de diseno.
 *
 * La 0048 cierra por COLUMNA la lectura de `inventory_lots.value_minor` y sus
 * hermanas: con `security_invoker` esta vista fallaria con «permission denied»
 * para el integrante que SI tiene FINANCE_VIEW, que es justo a quien esta
 * hecha. Y hay una segunda razon, mas de fondo: es un AGREGADO DEL HOGAR. Bajo
 * `security_invoker` heredaria tambien la RLS por integrante de
 * `cost_allocations` ([H53]) y devolveria un total al que le faltan las filas
 * de las personas sobre las que quien mira no tiene permiso — un numero mas
 * chico que la verdad, sin decirlo. Un subtotal disfrazado de total es
 * exactamente lo que este sprint existe para impedir.
 *
 * El alcance lo pone el `where app.finance_access(...)`, que es la misma
 * condicion que tendria la policy. El desglose POR PERSONA no sale de aca: sale
 * de `cost_allocations`, con su RLS y su FINANCE_VIEW_MEMBER.
 */

/**
 * Las cuatro cosas que NO pueden estar pasando. Los tipos 1 y 2 tienen que
 * volver siempre vacíos; los tipos 3 y 4 son estados que existen en la vida
 * real y se muestran, no se esconden.
 */
create view public.finance_integrity_report as
-- 1) Lotes donde adquirido <> consumido + botado + remanente.
select h.id as household_id,
       'LOTE_DESCUADRADO'::text as tipo,
       v.lot_id                 as subject_id,
       v.label                  as detalle,
       v.motivo,
       v.acquired_minor,
       v.asignado_minor
  from public.households h
  cross join lateral app.verify_lot_cost_invariant(h.id) v
 where v.motivo = 'DESCUADRE'
   and app.finance_access(h.id, 'FINANCE_VIEW')

union all

-- 2) Salidas del ledger SIN fila en `cost_allocations`: la ventana exacta en la
--    que el panel mostraría menos consumo del que hubo.
select m.household_id,
       'SALIDA_SIN_COSTEAR'::text,
       m.id,
       m.reason::text,
       'SIN_ASIGNACION'::text,
       null::bigint,
       null::bigint
  from public.inventory_movements m
 where m.delta < 0
   and m.reason not in ('SPLIT', 'MERGE', 'MOVE', 'TRANSFORM', 'COOK', 'THAW',
                        'LABEL_WEIGHT_UPDATE')
   and not exists (select 1 from public.cost_allocations c where c.movement_id = m.id)
   and app.finance_access(m.household_id, 'FINANCE_VIEW')

union all

-- 3) Compras con descuadre fuera de tolerancia sin resolver.
select p.household_id,
       'COMPRA_DESCUADRADA'::text,
       p.id,
       coalesce(p.merchant_name, 'sin comercio'),
       p.reconciliation::text,
       p.declared_total_minor,
       p.reconciliation_delta_after_minor
  from public.purchases p
 where p.reconciliation = 'OUT_OF_TOLERANCE'
   and app.finance_access(p.household_id, 'FINANCE_VIEW')

union all

-- 4) Grupos SPLIT/MERGE donde el invariante de valor no se pudo VERIFICAR
--    porque alguna parte era desconocida. K-19 hace dominar el desconocido; lo
--    que no se puede hacer es dejarlo sin registrar.
select m.household_id,
       'INVARIANTE_NO_VERIFICABLE'::text,
       m.group_id,
       m.reason::text,
       'VALOR_DESCONOCIDO_EN_EL_GRUPO'::text,
       null::bigint,
       null::bigint
  from public.inventory_movements m
  join public.inventory_lots l on l.id = m.lot_id
 where m.group_id is not null
   and m.reason in ('SPLIT', 'MERGE', 'TRANSFORM')
   and l.value_status = 'UNKNOWN'
   and app.finance_access(m.household_id, 'FINANCE_VIEW')
 group by m.household_id, m.group_id, m.reason

union all

-- 5) Plata declarada en una linea de compra que NUNCA entro a ningun lote.
--    `record_purchase` no puede recibir una linea sin cantidad canonica ("POLLO
--    ENTERO $6.990", sin peso) ni una sin alimento identificado, y obligar a
--    teclear un peso inventado seria peor. Lo que no puede pasar es que ese
--    dinero se cuente como «quedo en la despensa»: no esta en ningun lote, no se
--    va a consumir nunca y no es merma. Aparece aca hasta que alguien complete
--    la linea, y desaparece solo cuando la linea produce su lote.
select i.household_id,
       'LINEA_SIN_LOTE'::text,
       i.id,
       i.raw_label,
       case when i.quantity_canonical is null or i.unit is null
            then 'SIN_CANTIDAD_CANONICA'
            else 'SIN_ALIMENTO_IDENTIFICADO' end::text,
       case when i.value_status = 'KNOWN' then i.final_value_minor end,
       null::bigint
  from public.purchase_items i
 where i.superseded_at is null
   and not exists (select 1 from public.purchase_item_lots pil
                    where pil.purchase_item_id = i.id)
   and app.finance_access(i.household_id, 'FINANCE_VIEW');

comment on view public.finance_integrity_report is
  'Los tipos LOTE_DESCUADRADO y SALIDA_SIN_COSTEAR deberian estar SIEMPRE '
  'vacios. Los otros tres son estados reales que se declaran en vez de omitirse.';

/**
 * LO QUE NO SE PUDO COSTEAR, por motivo y con su cantidad física.
 *
 * Es la fuente de la frase «faltan precios en 6 de 19 productos». Sin esta
 * vista, ese 6 no existe en ninguna parte y la pantalla tendría que elegir entre
 * callarse o inventar.
 */
create view public.unknown_value_inventory as
select l.household_id,
       'LOTE'::text                as origen,
       l.value_unknown_reason::text as motivo,
       count(*)                     as cuantos,
       sum(l.quantity)              as cantidad,
       l.unit
  from public.inventory_lots l
 where l.status = 'AVAILABLE' and l.quantity > 0 and l.value_status = 'UNKNOWN'
   and app.finance_access(l.household_id, 'FINANCE_VIEW')
 group by l.household_id, l.value_unknown_reason, l.unit

union all

select a.household_id,
       'ASIGNACION'::text,
       a.unknown_reason::text,
       count(*),
       sum(a.quantity),
       'G'::text
  from public.cost_allocations a
 where a.value_status = 'UNKNOWN'
   and app.finance_access(a.household_id, 'FINANCE_VIEW')
 group by a.household_id, a.unknown_reason;

/**
 * «De lo que aparece en septiembre, $3.200 ocurrió en agosto».
 *
 * Agrupado por los DOS períodos —el de ocurrencia y el de reconocimiento—
 * porque la diferencia entre ambos es justamente lo que hay que poder explicar.
 */
create view public.late_recognition_report as
select a.household_id,
       date_trunc('month', a.recognized_on)::date as recognized_period,
       date_trunc('month', a.occurred_on)::date   as occurred_period,
       a.currency,
       count(*) as cuantos,
       (app.sum_money(
          case when a.value_status = 'KNOWN' then a.amount_minor end, a.currency)).known_minor
         as known_minor,
       count(*) filter (where a.value_status = 'UNKNOWN') as unknown_count
  from public.cost_allocations a
 where a.late_recognition
   and app.finance_access(a.household_id, 'FINANCE_VIEW')
 group by a.household_id, date_trunc('month', a.recognized_on),
          date_trunc('month', a.occurred_on), a.currency;

/**
 * El agregado de merma A NIVEL HOGAR, que el §40 necesitaba y no existía: el
 * motor de stock agrega por ALIMENTO, y «cuánto botamos este mes» no se puede
 * armar sumando eso.
 *
 * Sin `member_id` en ninguna parte: la merma es del hogar. Atribuirle a una
 * persona lo que se echó a perder en el refrigerador es exactamente la clase de
 * dato que este sprint decidió no fabricar.
 */
create view public.household_waste_summary as
select a.household_id,
       date_trunc('month', a.recognized_on)::date as period_starts_on,
       a.category,
       a.currency,
       count(*) as movimientos,
       sum(a.quantity) as cantidad,
       (app.sum_money(
          case when a.value_status = 'KNOWN' then a.amount_minor end, a.currency)).known_minor
         as known_minor,
       count(*) filter (where a.value_status = 'UNKNOWN') as unknown_count
  from public.cost_allocations a
 where a.category in ('WASTED_AVOIDABLE', 'WASTED_EXPECTED', 'WASTED_THIRD_PARTY')
   and app.finance_access(a.household_id, 'FINANCE_VIEW')
 group by a.household_id, date_trunc('month', a.recognized_on), a.category, a.currency;

comment on view public.household_waste_summary is
  'La merma se muestra como HECHO CONSUMADO, nunca como llamado a la accion: '
  'poner "$5.900 evitable" al lado de un lote por vencer es un empujon a comerse '
  'algo que el motor clinico ya condeno. El dinero jamas pasa por encima de la '
  'seguridad alimentaria.';

/**
 * La aserción que corre al final de cada test de integración del sprint y desde
 * el panel de integridad. Revienta con los tipos 1 y 2, que son los que no
 * pueden estar pasando nunca.
 */
create or replace function app.assert_finance_integrity(p_household uuid)
returns void language plpgsql stable security definer set search_path = public as $$
declare
  v_descuadres int;
  v_sin_costear int;
  v_detalle text;
begin
  select count(*) filter (where r.tipo = 'LOTE_DESCUADRADO'),
         count(*) filter (where r.tipo = 'SALIDA_SIN_COSTEAR'),
         string_agg(distinct r.tipo || ':' || coalesce(r.detalle, '?'), ', ')
    into v_descuadres, v_sin_costear, v_detalle
    from public.finance_integrity_report r
   where r.household_id = p_household
     and r.tipo in ('LOTE_DESCUADRADO', 'SALIDA_SIN_COSTEAR');

  if coalesce(v_descuadres, 0) > 0 or coalesce(v_sin_costear, 0) > 0 then
    raise exception 'integridad financiera rota: % lotes descuadrados y % salidas sin costear (%)',
      v_descuadres, v_sin_costear, v_detalle
      using errcode = 'check_violation';
  end if;
end;
$$;

-- Los cuatro informes son AGREGADOS del hogar y ninguno expone `member_id`: se
-- leen con derechos del dueno y su alcance lo pone `app.finance_access` en el
-- `where`. Lo que no pueden hacer es escribir.
revoke insert, update, delete on public.finance_integrity_report from anon, authenticated;
revoke insert, update, delete on public.unknown_value_inventory from anon, authenticated;
revoke insert, update, delete on public.late_recognition_report from anon, authenticated;
revoke insert, update, delete on public.household_waste_summary from anon, authenticated;
grant select on public.finance_integrity_report to authenticated;
grant select on public.unknown_value_inventory to authenticated;
grant select on public.late_recognition_report to authenticated;
grant select on public.household_waste_summary to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Lo que la pantalla necesita para no mentir
-- ---------------------------------------------------------------------------

/**
 * QUÉ PUEDO VER YO.
 *
 * `app.finance_access` vive en el esquema `app`, que PostgREST no expone: sin
 * este envoltorio, la aplicación no tiene forma de PREGUNTAR por el permiso y
 * sólo puede deducirlo del silencio de la RLS — que es exactamente el error
 * [H17], porque «no tienes permiso» y «no gastaste nada» se ven idénticos
 * cuando lo único que llega es una lista vacía.
 *
 * Con esto, el loader resuelve el permiso ANTES de consultar y la pantalla
 * puede decir «no tienes permiso para ver montos» en vez de pintar $0.
 */
create or replace function public.finance_permissions(p_household uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_object_agg(p.permission::text, app.finance_access(p_household, p.permission))
    from unnest(enum_range(null::public.finance_permission)) as p(permission)
   where app.is_household_member(p_household);
$$;

/**
 * Las asignaciones del período, por CATEGORÍA, con su desconocido al lado.
 *
 * Es lo que alimenta `FinanceForecastEngine`: una cubeta por categoría, con el
 * subtotal conocido Y el conteo de lo que no se pudo costear. Sin ese conteo el
 * motor recibiría un número que se lee como completo, que es la forma más cara
 * de mentir en una pantalla de plata.
 *
 * Agrupa por `recognized_on` ([H57]): el período contable cierra por lo que se
 * SUPO dentro de él. `member_id` no aparece: es un agregado del hogar.
 */
create view public.finance_period_accruals as
select a.household_id,
       date_trunc('month', a.recognized_on)::date as period_starts_on,
       a.category,
       a.currency,
       count(*) as movimientos,
       sum(a.quantity) as cantidad,
       (app.sum_money(
          case when a.value_status = 'KNOWN' then a.amount_minor end, a.currency)).known_minor
         as known_minor,
       count(*) filter (where a.value_status = 'UNKNOWN') as unknown_count
  from public.cost_allocations a
 where app.finance_access(a.household_id, 'FINANCE_VIEW')
 group by a.household_id, date_trunc('month', a.recognized_on), a.category, a.currency;

/**
 * La CAJA de cada compra, partida en lo que capitalizó y lo que no.
 *
 * [H12] Sin esta partición, el panel calcula el valor guardado como
 * `caja − consumo` y queda inflado todos los meses por el despacho, la propina
 * y el cargo de redondeo, que salieron del bolsillo y nunca entraron a la
 * despensa.
 */
create view public.purchase_cash_summary as
select p.id as purchase_id,
       p.household_id,
       p.purchased_on,
       p.currency,
       coalesce(p.merchant_name, 'Compra') as label,
       p.declared_total_minor,
       p.total_status,
       cap.known_minor    as capitalized_known_minor,
       cap.unknown_count  as capitalized_unknown_count,
       gasto.known_minor  as expensed_only_known_minor,
       gasto.unknown_count as expensed_only_unknown_count
  from public.purchases p
  -- CAPITALIZADO = lo que de verdad quedo en un lote. Una linea que nunca
  -- produjo lote (sin peso, sin alimento identificado) NO es valor guardado:
  -- contarla aca inflaba «de eso, quedo en la despensa» mes a mes con plata que
  -- no esta en ninguna parte. Y tampoco es cero: entra como DESCONOCIDA, que es
  -- el hecho —«hay $6.990 de esta compra que no se donde quedaron»— y no un
  -- numero que se lee como completo. El detalle, en `finance_integrity_report`
  -- (tipo LINEA_SIN_LOTE).
  cross join lateral (
    select (app.sum_money(
              case when i.value_status = 'KNOWN'
                    and exists (select 1 from public.purchase_item_lots pil
                                 where pil.purchase_item_id = i.id)
                   then i.final_value_minor end, p.currency)).*
      from public.purchase_items i
     where i.purchase_id = p.id and i.superseded_at is null
  ) cap
  cross join lateral (
    select (app.sum_money(
              case when a.value_status = 'KNOWN' then a.amount_minor end, p.currency)).*
      from public.cost_allocations a
      join public.purchase_charges c on c.id = a.purchase_charge_id
     where c.purchase_id = p.id and a.category = 'NON_CAPITALIZED_EXPENSE'
  ) gasto
 where app.finance_access(p.household_id, 'FINANCE_VIEW');

revoke insert, update, delete on public.finance_period_accruals from anon, authenticated;
revoke insert, update, delete on public.purchase_cash_summary from anon, authenticated;
grant select on public.finance_period_accruals to authenticated;
grant select on public.purchase_cash_summary to authenticated;

-- ---------------------------------------------------------------------------
-- 5. SE MATA AL ESCRITOR VIEJO DE LA MERMA EN PLATA
-- ---------------------------------------------------------------------------

/**
 * `public.waste_movements.estimated_cost` deja de ESTIMAR y pasa a LEER el
 * devengo. Dos razones, y la segunda es urgente.
 *
 * 1. DOS DUEÑOS DEL MISMO NÚMERO. La versión de la 0036 costeaba con
 *    `acquisition_value × cantidad / entradas`, un modelo contable distinto del
 *    de `cost_allocations` (proporción sobre las entradas de compra contra
 *    remanente sobre lo que le queda al lote). Hasta este sprint daba NULL en
 *    producción porque `acquisition_value` no tenía escritor legítimo —lo dice
 *    la propia 0042—; `app.set_lot_value` la EMPIEZA a escribir, así que la
 *    vista vieja despertaba y producía un segundo "cuánto botamos en plata" que
 *    diverge del panel. Su propio comentario ya declaraba el plan: «ahí va NULL
 *    hasta que exista cost_allocations».
 *
 * 2. SIN ESTO, LA DESPENSA SE CAE PARA TODOS. La vista es
 *    `security_invoker = true` y leía `l.acquisition_value`, columna que esta
 *    misma migración acaba de revocar unas líneas más arriba: cualquier
 *    integrante que abriera /stock recibiría «permission denied for column
 *    acquisition_value». Cambiar el modelo de permisos obliga a arreglar a sus
 *    lectores acá, no después.
 *
 * DESCONOCIDO != $0, también acá: una salida sin asignación (o con asignación
 * UNKNOWN) da NULL, y `analyzeStock` ya sabe convertir un solo NULL en un total
 * desconocido en vez de sumar la parte conocida como si fuera el todo. La merma
 * del PLATO (`waste_lot_quantity`, delta 0) no la costea nadie todavía: da NULL,
 * que es la verdad, no cero.
 *
 * Y el dinero llega por `cost_allocations`, con su RLS: quien no tiene
 * FINANCE_VIEW ve la merma en CANTIDAD y el costo en NULL —desconocido— en vez
 * de un número que no le corresponde.
 */
create or replace view public.waste_movements
with (security_invoker = true) as
select
  m.id,
  m.household_id,
  l.ingredient_id,
  l.unit,
  l.weight_basis,
  q.cantidad as quantity,
  m.reason,
  m.created_at,
  case when a.value_status = 'KNOWN'
       then app.minor_to_value(a.amount_minor, a.currency)
  end as estimated_cost,
  case when m.waste_lot_quantity is not null then 'SERVING' else 'INVENTORY' end
    as waste_kind
from public.inventory_movements m
join public.inventory_lots l on l.id = m.lot_id
cross join lateral (
  select case
           when m.waste_lot_quantity is not null then -m.waste_lot_quantity
           else -m.delta
         end as cantidad
) q
-- El costo de ESE movimiento, si alguien lo costeó. Uno por movimiento: lo
-- garantiza `cost_allocations_movimiento_uniq` (0044).
left join public.cost_allocations a on a.movement_id = m.id
where m.reason in ('SPOILED', 'EXPIRED', 'DAMAGED', 'DISCARDED_LEFTOVER', 'PURCHASE_PROBLEM')
  and (m.delta < 0 or m.waste_lot_quantity is not null);

comment on view public.waste_movements is
  'quantity = cuanto se perdio (positivo). estimated_cost YA NO ES UNA '
  'ESTIMACION: es el devengo de cost_allocations, o NULL cuando esa salida '
  'todavia no se costeo o quien mira no tiene FINANCE_VIEW. NULL = DESCONOCIDO, '
  'jamas $0. Dueno unico del costo de la merma: app.allocate_movement_cost.';
