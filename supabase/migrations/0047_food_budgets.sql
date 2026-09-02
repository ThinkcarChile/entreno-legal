-- Sprint 14 — PRESUPUESTO DEL HOGAR, con vigencia y con BASE declarada.
--
-- Dos cosas que esta migración no deja pasar:
--
--   [H2] UN PRESUPUESTO QUE NO DICE SOBRE QUÉ MIDE. La tabla del diseño tenía
--        `amount_minor`, `period_type` y `category`, y ninguna columna que
--        dijera si el presupuesto es de CAJA (lo que sale del bolsillo) o de
--        CONSUMO ECONÓMICO (lo que efectivamente se comió). Es la conflación
--        central del sprint sobreviviendo justo en el número de mayor tracción
--        de la app: el hogar que hace la compra grande del mes aparece OVER sin
--        haber consumido nada, y el que se está comiendo una despensa llena
--        aparece ON_TRACK gastando cero de caja mientras liquida $200.000 de
--        inventario. `basis` es NOT NULL y SIN default: hay que elegir.
--
--   [H65] `set_food_budget` SE CAÍA AL CAMBIAR EL PRESUPUESTO DOS VECES EL
--        MISMO DÍA. La regla era «cierro la vigencia actual con `valid_to =
--        ayer`»: si la fila vigente se creó HOY, eso viola el check
--        `valid_to >= valid_from` y el RPC revienta con un error de constraint
--        en vez de un mensaje humano. Y si se esquiva con `valid_to = hoy`,
--        quedan dos filas cubriendo hoy y «el presupuesto vigente en ese
--        período» se vuelve ambiguo. Acá la semántica está DEFINIDA: un
--        presupuesto rige desde el PRÓXIMO PERÍODO COMPLETO. Cambiarlo dos veces
--        el mismo día reemplaza la fila futura y no toca ningún período en curso
--        ni cerrado.
--
--   [H57] NO ESTABA DEFINIDO POR QUÉ FECHA CIERRAN LOS PERÍODOS. `occurred_on`
--        o `recognized_on` cambian la respuesta: por `occurred_on`, una
--        corrección insertada en septiembre con fecha de julio CAMBIA el informe
--        de julio la próxima vez que se abra — exactamente el «$48.320 que pasó
--        a ser $51.900» que el sprint promete que no va a ocurrir. La regla
--        queda escrita acá y en la vista: EL PERÍODO CONTABLE CIERRA POR
--        `recognized_on` (lo que se supo dentro del período), con `occurred_on`
--        como desglose informativo.
--
--   [H58] `households.timezone` y `week_start_dow` mueven los límites de
--        períodos ya cerrados y con eso mueven plata de un mes a otro. La
--        columna nace acá con default 1 (lunes) y su cambio queda registrado.

create type public.budget_period as enum ('WEEK', 'MONTH');

/**
 * [H2] Sobre qué mide el presupuesto. Sin default: el hogar tiene que elegir, y
 * la pantalla se lo explica con el ejemplo del pollo (compro 5 kg por $25.000 =
 * caja de hoy; me como 2 kg = consumo de la semana).
 */
create type public.budget_basis as enum ('CASH', 'ECONOMIC_CONSUMPTION');

-- El día en que empieza la semana del hogar. 1 = lunes (ISO), 7 = domingo.
alter table public.households
  add column week_start_dow smallint not null default 1
  check (week_start_dow between 1 and 7);

comment on column public.households.week_start_dow is
  'Cambiarlo mueve los limites de periodos ya cerrados y con eso mueve plata de '
  'un mes a otro: por eso los informes cerrados guardan sus propios limites.';

create table public.household_food_budgets (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  period_type  public.budget_period not null,
  basis        public.budget_basis not null,
  currency     char(3) not null references public.currency_units (code),

  -- Un presupuesto de cero NO es un presupuesto: es la ausencia de uno, y esa
  -- se representa SIN FILA, con estado NO_BUDGET.
  amount_minor bigint not null check (amount_minor > 0),
  category     text check (category is null or char_length(category) between 1 and 60),

  -- Vigencia: cambiar el presupuesto NO reescribe los períodos ya cerrados.
  valid_from   date not null,
  valid_to     date,
  note         text,
  created_by   uuid not null references public.household_members (id),
  created_at   timestamptz not null default now(),

  constraint budget_vigencia_coherente check (valid_to is null or valid_to >= valid_from)
);

-- Un presupuesto VIVO por (hogar, período, base, categoría). La base entra a la
-- clave: un presupuesto de caja y uno de consumo conviven a propósito.
create unique index budget_vigente_unico on public.household_food_budgets
  (household_id, period_type, basis, coalesce(category, ''))
  where valid_to is null;

create index budget_periodo_idx on public.household_food_budgets
  (household_id, period_type, basis, valid_from desc);

alter table public.household_food_budgets enable row level security;
create policy household_food_budgets_select on public.household_food_budgets
  for select to authenticated
  using (app.finance_access(household_id, 'FINANCE_VIEW'));
revoke insert, update, delete on public.household_food_budgets from anon, authenticated;

/**
 * [H65] EL ÍNDICE ÚNICO PARCIAL SÓLO PROTEGE LA FILA VIVA.
 *
 * Nada impedía vigencias CERRADAS solapadas, y con dos filas cubriendo el mismo
 * julio, «el presupuesto vigente en julio» deja de tener respuesta. Un
 * `exclude using gist` sobre `daterange` sería lo natural, pero exige
 * `btree_gist`, una extensión que este proyecto no instala en ninguna parte y
 * que PGlite no trae. El trigger hace el mismo trabajo y explica el problema en
 * el mensaje.
 */
create or replace function app.budget_sin_solapes()
returns trigger language plpgsql as $$
declare v_otro date;
begin
  select b.valid_from into v_otro
    from public.household_food_budgets b
   where b.household_id = new.household_id
     and b.period_type = new.period_type
     and b.basis = new.basis
     and coalesce(b.category, '') = coalesce(new.category, '')
     and b.id <> new.id
     and daterange(b.valid_from, coalesce(b.valid_to, 'infinity'::date), '[]')
         && daterange(new.valid_from, coalesce(new.valid_to, 'infinity'::date), '[]')
   limit 1;
  if v_otro is not null then
    raise exception 'ya hay un presupuesto vigente desde % que se pisa con este', v_otro
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create constraint trigger budget_sin_solapes
  after insert or update on public.household_food_budgets
  deferrable initially deferred
  for each row execute function app.budget_sin_solapes();

-- ---------------------------------------------------------------------------
-- Los cortes de período, en la zona horaria DEL HOGAR
-- ---------------------------------------------------------------------------

/**
 * Nunca la zona del servidor: un cierre de mes calculado en UTC corre el día en
 * Chile y mueve plata de un mes al otro.
 *
 * La semana se ancla al día que el hogar declara (`week_start_dow`, lunes por
 * defecto). `extract(isodow)` da 1..7 con lunes = 1, así que el desplazamiento
 * al inicio de semana es `(isodow - week_start_dow + 7) % 7` días atrás.
 */
create or replace function app.budget_period_bounds(
  p_household uuid,
  p_type      public.budget_period,
  p_date      date default null,
  out starts_on date,
  out ends_on   date
) language plpgsql stable as $$
declare
  v_fecha date;
  v_dow   int;
  v_ancla int;
begin
  v_fecha := coalesce(p_date, app.household_today(p_household));
  if p_type = 'MONTH' then
    starts_on := date_trunc('month', v_fecha)::date;
    ends_on := (starts_on + interval '1 month - 1 day')::date;
  else
    select week_start_dow into v_ancla from public.households where id = p_household;
    v_ancla := coalesce(v_ancla, 1);
    v_dow := extract(isodow from v_fecha)::int;
    starts_on := v_fecha - (((v_dow - v_ancla) + 7) % 7);
    ends_on := starts_on + 6;
  end if;
end;
$$;

/** El inicio del período SIGUIENTE al que contiene esa fecha. */
create or replace function app.next_period_start(
  p_household uuid,
  p_type      public.budget_period,
  p_date      date default null
) returns date language plpgsql stable as $$
declare v_b record;
begin
  select * into v_b from app.budget_period_bounds(p_household, p_type, p_date);
  return v_b.ends_on + 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fijar el presupuesto
-- ---------------------------------------------------------------------------

/**
 * NO hace `update amount_minor`: cierra la vigencia actual e inserta fila nueva.
 * Un informe de julio consulta el presupuesto que estaba vigente en julio, no el
 * de hoy. Es el mismo patrón de `shopping_list_revisions` y de
 * `household_observed_yields`.
 *
 * [H65] La vigencia empieza en el PRÓXIMO PERÍODO COMPLETO. Con eso:
 *   - cambiar el presupuesto dos veces el mismo día reemplaza la fila futura,
 *     no genera un solape ni revienta contra el check de vigencia;
 *   - un período en curso nunca cambia de presupuesto a mitad de camino, así
 *     que «¿el mes usa el viejo, el nuevo, o prorratea?» deja de ser una
 *     pregunta abierta: usa el viejo, entero.
 */
create or replace function public.set_food_budget(
  p_household  uuid,
  p_type       public.budget_period,
  p_basis      public.budget_basis,
  p_amount_minor bigint,
  p_category   text default null,
  p_note       text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_currency char(3);
  v_desde date;
  v_actual public.household_food_budgets;
  v_id uuid;
begin
  if not app.finance_access(p_household, 'FINANCE_MANAGE_BUDGET') then
    raise exception 'no autorizado';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'un presupuesto de cero no es un presupuesto: para quitarlo, revocalo';
  end if;
  perform app.assert_money(p_amount_minor, 'el presupuesto');

  select currency into v_currency from public.households where id = p_household;
  v_desde := app.next_period_start(p_household, p_type, null);

  select * into v_actual from public.household_food_budgets
   where household_id = p_household and period_type = p_type and basis = p_basis
     and coalesce(category, '') = coalesce(p_category, '')
     and valid_to is null
   for update;

  if v_actual.id is not null then
    if v_actual.valid_from >= v_desde then
      -- La fila viva todavía NO gobernó ningún período: se reemplaza. No es
      -- historia todavía, así que borrarla no borra nada que haya pasado.
      delete from public.household_food_budgets where id = v_actual.id;
    else
      update public.household_food_budgets
         set valid_to = v_desde - 1
       where id = v_actual.id;
    end if;
  end if;

  insert into public.household_food_budgets
    (household_id, period_type, basis, currency, amount_minor, category,
     valid_from, note, created_by)
  values (p_household, p_type, p_basis, v_currency, p_amount_minor, p_category,
          v_desde, p_note, app.current_member_id(p_household))
  returning id into v_id;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (p_household, auth.uid(), 'FOOD_BUDGET_SET', 'food_budget', v_id,
          jsonb_build_object('period_type', p_type, 'basis', p_basis, 'valid_from', v_desde));

  return v_id;
end;
$$;

/** Quitar el presupuesto: cierra la vigencia. La ausencia se representa SIN FILA. */
create or replace function public.clear_food_budget(
  p_household uuid,
  p_type      public.budget_period,
  p_basis     public.budget_basis,
  p_category  text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_desde date;
begin
  if not app.finance_access(p_household, 'FINANCE_MANAGE_BUDGET') then
    raise exception 'no autorizado';
  end if;
  v_desde := app.next_period_start(p_household, p_type, null);
  update public.household_food_budgets
     set valid_to = least(valid_to, v_desde - 1)
   where household_id = p_household and period_type = p_type and basis = p_basis
     and coalesce(category, '') = coalesce(p_category, '')
     and valid_to is null
     and valid_from < v_desde;
  -- Una fila futura que nunca gobernó se borra entera.
  delete from public.household_food_budgets
   where household_id = p_household and period_type = p_type and basis = p_basis
     and coalesce(category, '') = coalesce(p_category, '')
     and valid_to is null and valid_from >= v_desde;
end;
$$;

/** El presupuesto que regía EN ESA FECHA, no el de hoy. */
create or replace function app.budget_in_force(
  p_household uuid,
  p_type      public.budget_period,
  p_basis     public.budget_basis,
  p_date      date
) returns public.household_food_budgets language sql stable as $$
  select b.* from public.household_food_budgets b
   where b.household_id = p_household and b.period_type = p_type and b.basis = p_basis
     and b.category is null
     and b.valid_from <= p_date
     and (b.valid_to is null or b.valid_to >= p_date)
   order by b.valid_from desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- [H7] EL SALDO de la despensa, que no existía en ninguna parte
-- ---------------------------------------------------------------------------

/**
 * El concepto que le da nombre al sprint —el valor que está GUARDADO en la
 * despensa— era lo único que la persona no podía ver: `lot_cost_balance`
 * calculaba el remanente lote por lote y nadie lo agregaba, y el panel mostraba
 * sólo la VARIACIÓN del período rotulada de una forma que se lee como saldo.
 *
 * Acá está el saldo, con su cobertura declarada: cuántos lotes no tienen precio
 * y qué fracción de la cantidad física representan. «Tu despensa vale $X (12
 * lotes sin precio)» es una frase honesta; «$X» a secas no lo es.
 */
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
 * EL REMANENTE, NO LO ADQUIRIDO, y esta es la correccion central de la vista.
 *
 * La primera version sumaba `l.value_minor` —lo que costo el lote ENTERO el dia
 * que entro— de todo lote vivo. Una despensa asi NO BAJA CUANDO SE COME: la casa
 * se almuerza el pollo, el panel sigue diciendo que el pollo esta guardado, y en
 * la misma pantalla ese mismo dinero aparece otra vez como consumido. $25.000 de
 * compra se presentaban como $35.000. Eso no es una despensa: es una lista de
 * compras vieja.
 *
 * El saldo de un lote es `adquirido − lo ya cargado contra el` (consumo, merma,
 * ajuste, correccion y traspasos), que es exactamente lo que calcula
 * `lot_cost_balance` (0044) y esta vista ignoraba. Se calcula aca en linea, con
 * su propio lateral, y no leyendo esa vista, por dos razones: `lot_cost_balance`
 * recien pasa a derechos del dueno en la 0048 —una vista que depende de una
 * migracion posterior para no filtrar por RLS es una trampa— y aca hace falta
 * filtrar por `status`/`quantity`, que la otra no filtra.
 *
 * Y el desconocido DOMINA: un lote sin precio, o con una salida que no se pudo
 * costear, no tiene remanente calculable. Ahi el saldo es NULL —no cero— y
 * `app.sum_money` lo cuenta como desconocido en vez de tragarselo.
 */
create view public.pantry_value as
with saldo as (
  select l.household_id,
         l.currency,
         l.quantity,
         case
           when l.value_status <> 'KNOWN' then null
           when coalesce(a.desconocidas, 0) > 0 then null
           else l.value_minor - coalesce(a.cargado_minor, 0)
         end as remaining_minor,
         (l.value_status <> 'KNOWN' or coalesce(a.desconocidas, 0) > 0) as sin_saldo_calculable
    from public.inventory_lots l
    left join lateral (
      -- `sum(bigint)` devuelve NUMERIC en Postgres y `app.sum_money` toma BIGINT:
      -- sin este cast la vista ni siquiera se crea ("function app.sum_money(numeric,
      -- character) does not exist"). La suma de unidades menores es exacta en
      -- entero: el cast no pierde nada y el dinero no pasa por coma flotante.
      select (sum(c.amount_minor * app.cost_category_lot_sign(c.category))
               filter (where app.cost_category_lot_sign(c.category) <> 0))::bigint
               as cargado_minor,
             count(*) filter (where c.value_status = 'UNKNOWN') as desconocidas
        from public.cost_allocations c where c.lot_id = l.id
    ) a on true
   where l.status = 'AVAILABLE' and l.quantity > 0
)
select s.household_id,
       s.currency,
       (app.sum_money(s.remaining_minor, s.currency)).known_minor as known_value_minor,
       count(*) filter (where s.sin_saldo_calculable) as unknown_lots,
       count(*) as total_lots,
       sum(s.quantity) filter (where s.sin_saldo_calculable) as unknown_quantity,
       sum(s.quantity) as total_quantity,
       -- El estado del TOTAL: un solo lote sin saldo calculable lo deja desconocido.
       case when count(*) filter (where s.sin_saldo_calculable) = 0
            then 'KNOWN' else 'UNKNOWN' end::public.money_status as value_status
  from saldo s
 where app.finance_access(s.household_id, 'FINANCE_VIEW')
 group by s.household_id, s.currency;

revoke insert, update, delete on public.pantry_value from anon, authenticated;
grant select on public.pantry_value to authenticated;

comment on view public.pantry_value is
  'El SALDO del valor guardado, distinto de la variacion del periodo. Trae la '
  'cobertura al lado: sin ella, un total con lotes sin precio se lee completo.';

-- ---------------------------------------------------------------------------
-- [H57] El resumen del período, que CIERRA POR `recognized_on`
-- ---------------------------------------------------------------------------

/**
 * La regla, escrita donde se aplica: el período contable cierra por
 * `recognized_on` —lo que se SUPO dentro del período—, con `occurred_on` como
 * desglose informativo («$3.200 corresponden a agosto»).
 *
 * Si cerrara por `occurred_on`, una corrección insertada en septiembre con
 * fecha de julio cambiaría el informe de julio la próxima vez que se abriera. Un
 * informe que cambia solo no es un informe.
 */
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
--
-- LA MONEDA SALE DE LAS FILAS, NO DE `households.currency` ([H57]).
--
-- Leer la moneda ACTUAL del hogar y pasársela a `app.sum_money` para todas las
-- filas hacía dos daños a la vez. Uno: un período CERRADO cambiaba de
-- significado cuando alguien tocaba la configuración —los mismos $10.003 pasaban
-- de CLP a USD, diez mil pesos convertidos en cien dólares sin que se moviera un
-- solo dato—. Dos: `app.money_total_add` sólo revienta cuando le llegan DOS
-- monedas distintas, así que pasarle una constante desarmaba la guarda
-- anti-mezcla justo donde debía trabajar.
--
-- Acá el período se parte POR MONEDA: cada fila agrupa sólo lo que se registró
-- en esa moneda, con la que quedó congelada en la compra y en la asignación. Un
-- hogar que cambió de moneda muestra dos filas para ese mes —que es la verdad—
-- en vez de una sola con la suma de peras y manzanas. El resto de las vistas
-- del sprint ya lo hacía así; ésta era la única que no.
create view public.budget_period_summary as
with periodos as (
  select distinct a.household_id, date_trunc('month', a.recognized_on)::date as starts_on,
         a.currency
    from public.cost_allocations a
  union
  select distinct p.household_id, date_trunc('month', p.purchased_on)::date, p.currency
    from public.purchases p
),
marco as (
  -- `p.currency`, NO `households.currency`: la moneda del marco es la que ya
  -- viene congelada en las filas del período (`purchases.currency`,
  -- `cost_allocations.currency`). Volver a joinear con `households` para sacarla
  -- de ahí es exactamente el defecto —el período cerrado cambiaría de moneda al
  -- cambiar la configuración— y además haría que los laterales de abajo
  -- (`and X.currency = m.currency`) dejaran de calzar con nada.
  select p.household_id, p.starts_on,
         (p.starts_on + interval '1 month - 1 day')::date as ends_on,
         p.currency
    from periodos p
)
select m.household_id,
       'MONTH'::public.budget_period as period_type,
       m.starts_on,
       m.ends_on,
       m.currency,
       caja.known_minor        as cash_known_minor,
       caja.unknown_count      as cash_unknown_count,
       caja.known_count        as cash_purchases,
       consumo.known_minor     as consumption_known_minor,
       consumo.unknown_count   as consumption_unknown_count,
       salidas.known_minor     as pantry_outflow_known_minor,
       salidas.unknown_count   as pantry_outflow_unknown_count,
       merma.known_minor       as waste_known_minor,
       merma.unknown_count     as waste_unknown_count,
       tardios.cuantos         as late_recognition_count,
       tardios.known_minor     as late_recognition_known_minor,
       presupuesto_caja.amount_minor    as cash_budget_minor,
       presupuesto_consumo.amount_minor as consumption_budget_minor
  from marco m
  -- CAJA: por la fecha de la COMPRA (que para una boleta importada es la fecha
  -- impresa, no la de subida).
  cross join lateral (
    select (app.sum_money(
              case when p.total_status = 'KNOWN' then p.declared_total_minor end, m.currency))
             .*
      from public.purchases p
     where p.household_id = m.household_id
       and p.currency = m.currency
       and p.purchased_on between m.starts_on and m.ends_on
  ) caja
  cross join lateral (
    select (app.sum_money(
              case when a.value_status = 'KNOWN' then a.amount_minor end, m.currency)).*
      from public.cost_allocations a
     where a.household_id = m.household_id
       and a.currency = m.currency
       and a.recognized_on between m.starts_on and m.ends_on
       and app.cost_category_is_outflow(a.category)
  ) consumo
  cross join lateral (
    select (app.sum_money(
              case when a.value_status = 'KNOWN' then a.amount_minor end, m.currency)).*
      from public.cost_allocations a
     where a.household_id = m.household_id
       and a.currency = m.currency
       and a.recognized_on between m.starts_on and m.ends_on
       and a.category in ('CONSUMED', 'WASTED_AVOIDABLE', 'WASTED_EXPECTED',
                          'WASTED_THIRD_PARTY', 'ADJUSTMENT_LOSS', 'CORRECTION')
  ) salidas
  cross join lateral (
    select (app.sum_money(
              case when a.value_status = 'KNOWN' then a.amount_minor end, m.currency)).*
      from public.cost_allocations a
     where a.household_id = m.household_id
       and a.currency = m.currency
       and a.recognized_on between m.starts_on and m.ends_on
       and a.category in ('WASTED_AVOIDABLE', 'WASTED_EXPECTED', 'WASTED_THIRD_PARTY')
  ) merma
  cross join lateral (
    select count(*) as cuantos,
           (app.sum_money(
              case when a.value_status = 'KNOWN' then a.amount_minor end, m.currency)).known_minor
             as known_minor
      from public.cost_allocations a
     where a.household_id = m.household_id
       and a.currency = m.currency
       and a.recognized_on between m.starts_on and m.ends_on
       and a.late_recognition
  ) tardios
  left join lateral (
    select b.amount_minor from public.household_food_budgets b
     where b.household_id = m.household_id and b.period_type = 'MONTH'
       and b.currency = m.currency
       and b.basis = 'CASH' and b.category is null
       and b.valid_from <= m.starts_on
       and (b.valid_to is null or b.valid_to >= m.starts_on)
     order by b.valid_from desc limit 1
  ) presupuesto_caja on true
  left join lateral (
    select b.amount_minor from public.household_food_budgets b
     where b.household_id = m.household_id and b.period_type = 'MONTH'
       and b.currency = m.currency
       and b.basis = 'ECONOMIC_CONSUMPTION' and b.category is null
       and b.valid_from <= m.starts_on
       and (b.valid_to is null or b.valid_to >= m.starts_on)
     order by b.valid_from desc limit 1
  ) presupuesto_consumo on true
 where app.finance_access(m.household_id, 'FINANCE_VIEW');

comment on view public.budget_period_summary is
  'El periodo contable CIERRA POR recognized_on. Toda vista que agrupe por '
  'occurred_on puede cambiar con reconocimientos tardios y JAMAS alimenta el '
  'semaforo del presupuesto. Y CIERRA POR MONEDA: la de cada fila, congelada '
  'cuando se registro, nunca la moneda actual del hogar.';

revoke insert, update, delete on public.budget_period_summary from anon, authenticated;
grant select on public.budget_period_summary to authenticated;
