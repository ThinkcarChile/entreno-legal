-- Sprint 14 — El puente entre el libro mayor y el dinero.
--
-- CASH SPEND != ECONOMIC CONSUMPTION. La 0043 CAPITALIZA: mete valor a la
-- despensa. Acá el valor SALE, y sale solo cuando alguien come, se echa a
-- perder, o se pierde en un ajuste. Comprar no es gastar; comer sí.
--
-- Seis lugares del repo nombran esta tabla como deuda: es donde por fin queda
-- escrito cuánto costó cada movimiento de salida, con qué base se calculó y en
-- qué período ocurrió (que no siempre es el período en que se supo).
--
-- LAS DOS DISTINCIONES QUE HACEN QUE ESTO NO MIENTA:
--
-- 1. SALIDA != TRANSFERENCIA. Partir un lote, fusionarlo, moverlo de repisa o
--    transformarlo en guiso NO es consumo económico: el valor sigue en la casa,
--    en otro envase. Anotar el domingo $30.000 de "consumo" porque se cocinó una
--    olla que está entera en el refrigerador es exactamente el error que este
--    sprint existe para evitar, un nivel más abajo. `allocate_movement_cost` se
--    NIEGA a costear esos movimientos; no queda a la disciplina del que llama.
--
-- 2. DESCONOCIDO != CERO. Un lote que entró sin boleta produce asignaciones
--    UNKNOWN con motivo. Jamás $0. Y una vista que suma valores desconocidos con
--    `sum()` los convierte en cero en silencio: acá no hay un solo `sum()`
--    desnudo sobre dinero.

do $$
begin
  if to_regclass('public.purchases') is null then
    raise exception
      'falta la migración 0043 (compras): la 0044 no se aplica sola. Aplica 0042 y 0043 primero.'
      using errcode = 'check_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Categorías de costo: el enum COMPLETO, sin agujeros
-- ---------------------------------------------------------------------------
--
-- TRANSFER_OUT/TRANSFER_IN existen porque un lote partido queda en cero sin
-- ninguna salida: sin ellos, el balance por lote lo reporta descuadrado PARA
-- SIEMPRE y el panel de integridad nace con ruido permanente, que es la forma
-- más rápida de que nadie lo mire. Y el que quisiera "arreglarlo" a mano solo
-- tendría ADJUSTMENT_LOSS: un traspaso de valor registrado como pérdida.
--
-- NON_CAPITALIZED_EXPENSE existe porque el despacho y la propina salieron del
-- bolsillo y no entraron a la despensa. Sin una fila propia, esos pesos se
-- presentan como "valor guardado" y la cifra estrella miente hacia arriba.

create type public.cost_category as enum (
  'CONSUMED',
  'WASTED_AVOIDABLE',
  'WASTED_EXPECTED',
  'WASTED_THIRD_PARTY',
  'ADJUSTMENT_LOSS',
  'CORRECTION',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'NON_CAPITALIZED_EXPENSE'
);

/** Las categorías que SACAN valor del hogar (las que suman al consumo económico). */
create or replace function app.cost_category_is_outflow(p_cat public.cost_category)
returns boolean language sql immutable as $$
  select p_cat in ('CONSUMED', 'WASTED_AVOIDABLE', 'WASTED_EXPECTED',
                   'WASTED_THIRD_PARTY', 'ADJUSTMENT_LOSS', 'NON_CAPITALIZED_EXPENSE');
$$;

/**
 * Las categorías que CARGAN contra el valor de un lote, con su signo.
 *
 * +1 saca valor del lote (consumo, merma, ajuste, corrección tardía, traspaso a
 * un hijo); -1 se lo trae (traspaso desde otro lote). El gasto no capitalizado
 * no toca ningún lote y por eso vale 0: si sumara, el despacho descontaría del
 * pollo, que es justo lo que EXPENSE_ONLY existe para impedir.
 */
create or replace function app.cost_category_lot_sign(p_cat public.cost_category)
returns int language sql immutable as $$
  select case
    when p_cat in ('CONSUMED', 'WASTED_AVOIDABLE', 'WASTED_EXPECTED', 'WASTED_THIRD_PARTY',
                   'ADJUSTMENT_LOSS', 'CORRECTION', 'TRANSFER_OUT') then 1
    when p_cat = 'TRANSFER_IN' then -1
    else 0
  end;
$$;

-- ---------------------------------------------------------------------------
-- public.cost_allocations
-- ---------------------------------------------------------------------------

create table public.cost_allocations (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references public.households (id) on delete cascade,

  -- Las categorías de inventario cuelgan de un movimiento del ledger; el gasto
  -- no capitalizado cuelga de un cargo de la compra. Nunca de los dos, nunca de
  -- ninguno: el check lo obliga.
  movement_id          uuid references public.inventory_movements (id) on delete cascade,
  lot_id               uuid references public.inventory_lots (id) on delete cascade,
  purchase_charge_id   uuid references public.purchase_charges (id) on delete cascade,

  category             public.cost_category not null,
  currency             char(3) not null references public.currency_units (code),

  amount_minor         bigint check (amount_minor between -1000000000000000 and 1000000000000000),
  value_status         public.money_status not null default 'UNKNOWN',
  unknown_reason       public.money_unknown_reason default 'NOT_YET_RECOGNIZED',

  -- Cantidad física a la que corresponde el monto (0 en el gasto no capitalizado).
  quantity             numeric(12, 3) not null check (quantity >= 0),

  -- CÓMO se calculó: cantidad antes, valor del lote, remanente. Guardado, no
  -- re-derivable: mañana el lote es otro y la historia tiene que seguir siendo legible.
  cost_basis_snapshot  jsonb not null,
  engine_version       text not null,

  -- CUÁNDO pasó y CUÁNDO se supo. No son lo mismo, y de esa diferencia sale
  -- "de lo que aparece en septiembre, $3.200 ocurrió en agosto".
  occurred_on          date not null,
  recognized_on        date not null,
  late_recognition     boolean generated always as (recognized_on > occurred_on) stored,

  member_id            uuid references public.household_members (id) on delete set null,
  assignment_id        uuid references public.meal_assignments (id) on delete set null,
  consumption_log_id   uuid references public.consumption_logs (id) on delete set null,
  corrected_from       uuid references public.cost_allocations (id) on delete set null,
  created_at           timestamptz not null default now(),

  constraint cost_allocations_valor_coherente check (
    (value_status = 'KNOWN'   and amount_minor is not null and unknown_reason is null) or
    (value_status = 'UNKNOWN' and amount_minor is null     and unknown_reason is not null)
  ),
  constraint cost_allocations_ancla check (
    (category = 'NON_CAPITALIZED_EXPENSE'
       and purchase_charge_id is not null and movement_id is null and lot_id is null) or
    (category <> 'NON_CAPITALIZED_EXPENSE'
       and purchase_charge_id is null and movement_id is not null and lot_id is not null)
  ),
  -- [H63] nada cuelga de un movimiento, un lote o un cargo de otro hogar.
  constraint cost_allocations_movimiento_fk foreign key (movement_id, household_id)
    references public.inventory_movements (id, household_id) on delete cascade,
  constraint cost_allocations_lote_fk foreign key (lot_id, household_id)
    references public.inventory_lots (id, household_id) on delete cascade,
  constraint cost_allocations_cargo_fk foreign key (purchase_charge_id, household_id)
    references public.purchase_charges (id, household_id) on delete cascade
);

-- K-22 llevado al dinero: un movimiento se costea UNA vez. El índice es parcial
-- porque el gasto no capitalizado no tiene movimiento, y un `unique` a secas
-- sobre una columna nullable no habría dejado más de una fila sin movimiento.
create unique index cost_allocations_movimiento_uniq
  on public.cost_allocations (movement_id) where movement_id is not null;
create unique index cost_allocations_cargo_uniq
  on public.cost_allocations (purchase_charge_id) where purchase_charge_id is not null;
create index cost_allocations_lote_idx on public.cost_allocations (lot_id) where lot_id is not null;
create index cost_allocations_periodo_idx on public.cost_allocations (household_id, occurred_on);

/** El devengo también es historia: se corrige con una fila nueva, no editando. */
create or replace function app.allocations_are_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception
    'las asignaciones de costo son append-only: una corrección es una fila nueva (CORRECTION), no una edición de la historia';
end;
$$;

create trigger cost_allocations_append_only
  before update or delete on public.cost_allocations
  for each row execute function app.allocations_are_append_only();

/**
 * QUIÉN COMIÓ, resuelto desde el movimiento. Un solo lugar, dos épocas.
 *
 * Desde la 0036 el dueño del efecto físico del consumo es el RENGLÓN SERVIDO
 * (`meal_serving_record_items` → `meal_serving_records.member_id`), y la 0038
 * cerró con un CHECK la puerta vieja: ningún movimiento nuevo puede colgar de
 * un `consumption_log_id`. Por eso el orden es ése y no el inverso. La segunda
 * rama no es decorativa: la historia anterior a la 0038 SÍ cuelga de ahí, y
 * costear un movimiento viejo tiene que atribuirlo igual de bien.
 *
 * NULL no es un hueco: es la respuesta correcta cuando la salida no tiene
 * comensal —la merma del refrigerador, un ajuste de inventario—. Esa plata es
 * del hogar y atribuírsela a alguien sería fabricar un dato.
 */
create or replace function app.movement_eater_member(p_movement uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select r.member_id
       from public.inventory_movements m
       join public.meal_serving_record_items i on i.id = m.serving_record_item_id
       join public.meal_serving_records r on r.id = i.record_id
      where m.id = p_movement),
    (select cl.member_id
       from public.inventory_movements m
       join public.consumption_logs cl on cl.id = m.consumption_log_id
      where m.id = p_movement));
$$;

/**
 * [H53] `member_id` ES QUIEN COMIÓ. Nunca quien apretó el botón.
 *
 * `inventory_movements.actor_member_id` es el REGISTRADOR: en un hogar real, la
 * que cocina marca las comidas de toda la familia y la que limpia el
 * refrigerador bota lo de todos. Escribir ese id acá convierte el "gasto por
 * integrante" en "gasto por quien registró", y como esta tabla es append-only,
 * cada fila mal atribuida es permanente. Encima deja a la persona que sí comió
 * SIN poder ver su propio gasto: `app.finance_member_access` la reconoce por
 * `app.is_self_member(owner)` y no existiría ninguna fila con su id.
 *
 * El comensal está a un join de distancia —`consumption_logs.member_id`, que la
 * 0011 escribe con `v_proj.member_id` mientras manda al registrador a
 * `logged_by`— así que la guarda es exigible en la base y va acá, no en la
 * disciplina de cada llamador. Sin renglón de consumo NO hay comensal: la merma
 * es del hogar y `member_id` va en NULL a propósito (0048 la muestra así).
 *
 * Un permiso de privacidad sobre un número mal atribuido no es privacidad: es
 * teatro, y con sello de autoridad.
 */
create or replace function app.allocation_member_is_the_eater()
returns trigger language plpgsql as $$
declare v_comensal uuid;
begin
  if new.movement_id is null then
    -- Gasto no capitalizado: el despacho y la propina son de la compra, no de
    -- una persona.
    if new.member_id is not null then
      raise exception
        'una asignación sin movimiento no tiene comensal: member_id va en NULL'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  v_comensal := app.movement_eater_member(new.movement_id);

  if new.member_id is distinct from v_comensal then
    raise exception
      'member_id de una asignación es QUIEN COMIÓ (el renglón servido dice %), no quien registró el movimiento (llegó %)',
      v_comensal, new.member_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger cost_allocations_member_is_the_eater
  before insert on public.cost_allocations
  for each row execute function app.allocation_member_is_the_eater();

comment on column public.cost_allocations.member_id is
  'QUIEN COMIÓ (consumption_logs.member_id), jamás quien registró el movimiento. '
  'NULL cuando no hay renglón de consumo: la merma y el gasto de la compra son '
  'del hogar. Lo vigila app.allocation_member_is_the_eater().';

alter table public.cost_allocations enable row level security;
create policy cost_allocations_select on public.cost_allocations for select to authenticated
  using (app.finance_access(household_id, 'FINANCE_VIEW'));
revoke insert, update, delete on public.cost_allocations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Clasificación de la merma
-- ---------------------------------------------------------------------------

/**
 * LAS TRES LISTAS DEL LEDGER, escritas UNA vez.
 *
 * `movement_reason` no es un enum cerrado: la 0015 le agregó PREP_LOSS y la 0041
 * LEFTOVER_RETURN, cada una en su sprint. Mientras nadie costeaba, agregar una
 * razón era gratis. Con el ledger costeando en cada movimiento, una razón que
 * nadie clasificó DETIENE LA COCINA: pelar papas empezaba a fallar con «no sé en
 * qué categoría de costo va un movimiento PREP_LOSS», y el hallazgo no aparecía
 * en ningún test porque ninguno aplicaba la 0044 sobre un camino de preparación.
 *
 * Por eso las listas son funciones y no literales repetidos: la partición del
 * enum en TRANSFERENCIA / ENTRADA / SALIDA CLASIFICADA es verificable desde la
 * base (`pg_enum`), y la próxima razón que alguien agregue se pone roja en CI en
 * vez de reventarle el almuerzo a una casa.
 */

/** La comida sigue en la casa, en otro envase: no es consumo económico. */
create or replace function app.movement_is_value_transfer(p_reason public.movement_reason)
returns boolean language sql immutable as $$
  select p_reason in ('SPLIT', 'MERGE', 'MOVE', 'TRANSFORM', 'COOK', 'THAW',
                      'LABEL_WEIGHT_UPDATE');
$$;

/**
 * Razones que SOLO entran. Una de éstas con delta negativo no es un caso a
 * costear: es un bug del llamador, y `allocate_movement_cost` lo dice.
 */
create or replace function app.movement_is_inflow_only(p_reason public.movement_reason)
returns boolean language sql immutable as $$
  select p_reason in ('PURCHASE', 'LEFTOVER_RETURN');
$$;

/**
 * Qué clase de pérdida es un movimiento de salida.
 *
 * La distinción no es cosmética: la cáscara de la papa es merma ESPERADA (no se
 * puede evitar y no sirve de reproche), el pan que se enmoheció es EVITABLE, y
 * el pollo que llegó malo del supermercado es DE TERCEROS. Meterlas en la misma
 * bolsa produce un número grande que nadie puede accionar.
 *
 * Los movimientos de TRANSFERENCIA y los de ENTRADA devuelven NULL: pedirle a
 * esta función que clasifique un SPLIT ya es el error.
 */
create or replace function app.classify_waste(
  p_reason public.movement_reason,
  p_notes  text default null
) returns public.cost_category language plpgsql immutable as $$
begin
  if app.movement_is_value_transfer(p_reason) or app.movement_is_inflow_only(p_reason) then
    return null;
  end if;
  return case p_reason
    when 'CONSUMED'           then 'CONSUMED'
    when 'USED_IN_RECIPE'     then 'CONSUMED'
    when 'SPOILED'            then 'WASTED_AVOIDABLE'
    when 'EXPIRED'            then 'WASTED_AVOIDABLE'
    when 'DISCARDED_LEFTOVER' then 'WASTED_AVOIDABLE'
    when 'DAMAGED'            then 'WASTED_THIRD_PARTY'
    when 'PURCHASE_PROBLEM'   then 'WASTED_THIRD_PARTY'
    when 'ADJUSTMENT'         then 'ADJUSTMENT_LOSS'
    -- Pelar, despuntar, recortar: la cáscara NO es reproche. Es la merma que
    -- ya venía adentro del kilo comprado, y por eso es ESPERADA. La causa fina
    -- (PEEL / TRIM / PREP_LOSS) viaja en `notes` del movimiento.
    when 'PREP_LOSS'          then 'WASTED_EXPECTED'
    -- La salida cuya causa nadie declaró. No tiene categoría propia y no se
    -- puede inventar una: lo único cierto es que el valor salió de la despensa
    -- sin explicación, que es exactamente lo que ADJUSTMENT_LOSS nombra. Lo que
    -- NO puede pasar es que se caiga el registro del movimiento.
    when 'OTHER'              then 'ADJUSTMENT_LOSS'
    else null
  end::public.cost_category;
end;
$$;

comment on function app.classify_waste is
  'Total sobre movement_reason: cada valor del enum es transferencia, entrada, o '
  'tiene categoría. La guarda de sprint14-costeo-enganchado.test.ts lo verifica '
  'contra pg_enum, así la razón que agregue el próximo sprint falla en CI.';

-- ---------------------------------------------------------------------------
-- El costeo de un movimiento de salida
-- ---------------------------------------------------------------------------

/**
 * Costea UN movimiento de salida contra el valor de su lote.
 *
 * CONTRATO DEL LLAMADOR, y no es negociable:
 *   1. toma `select ... from inventory_lots where id = ... for update` ANTES de
 *      insertar el movimiento,
 *   2. guarda la cantidad que el lote tenía BAJO ESE LOCK,
 *   3. inserta el movimiento,
 *   4. llama a esta función pasándole esa cantidad.
 *
 * Por qué así: si la función reconstruyera la cantidad previa sumando el delta
 * ("el trigger ya lo aplicó"), dos consumos simultáneos del mismo lote en READ
 * COMMITTED se pisarían —la segunda transacción tomaría el lock cuando la
 * primera ya bajó la cantidad— y la base de costo saldría mal sin que nada
 * hiciera `raise`. Es el mismo bug que la 0023 tuvo que arreglar para el consumo.
 * Además `abs(delta)` es sencillamente incorrecto para una entrada.
 *
 * Devuelve el id de la asignación creada, o el de la que ya existía (K-22).
 */
create or replace function app.allocate_movement_cost(
  p_movement_id     uuid,
  p_quantity_before numeric,
  p_category        public.cost_category default null,
  p_occurred_on     date default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_mov public.inventory_movements;
  v_lot public.inventory_lots;
  v_cat public.cost_category;
  v_adquirido bigint;
  v_ya bigint;
  v_restante bigint;
  v_salida numeric;
  v_monto bigint;
  v_id uuid;
  v_dia date;
  v_comensal uuid;
begin
  select id into v_id from public.cost_allocations where movement_id = p_movement_id;
  if v_id is not null then return v_id; end if;   -- costear dos veces es un no-op

  select * into v_mov from public.inventory_movements where id = p_movement_id;
  if v_mov.id is null then
    raise exception 'el movimiento no existe' using errcode = 'check_violation';
  end if;

  -- [H0] La guarda dura: una transferencia NO es consumo económico.
  if app.movement_is_value_transfer(v_mov.reason) then
    raise exception
      'el movimiento % es una transferencia de valor (%), no consumo económico: la comida sigue en la casa',
      p_movement_id, v_mov.reason using errcode = 'check_violation';
  end if;
  if app.movement_is_inflow_only(v_mov.reason) then
    raise exception
      'el movimiento % es una entrada (%): capitaliza, no gasta',
      p_movement_id, v_mov.reason using errcode = 'check_violation';
  end if;
  if v_mov.delta >= 0 then
    raise exception
      'solo se costea una SALIDA: el movimiento % tiene delta % (una entrada capitaliza, no gasta)',
      p_movement_id, v_mov.delta using errcode = 'check_violation';
  end if;
  if p_quantity_before is null or p_quantity_before <= 0 then
    raise exception
      'costear necesita la cantidad que el lote tenía ANTES del movimiento, tomada bajo el mismo lock'
      using errcode = 'check_violation';
  end if;

  v_cat := coalesce(p_category, app.classify_waste(v_mov.reason, v_mov.notes));
  if v_cat is null then
    raise exception 'no sé en qué categoría de costo va un movimiento %', v_mov.reason
      using errcode = 'check_violation';
  end if;

  select * into v_lot from public.inventory_lots where id = v_mov.lot_id for update;
  v_dia := coalesce(p_occurred_on, app.household_today(v_mov.household_id));
  v_salida := abs(v_mov.delta);

  -- [H53] El comensal, NO el actor. `actor_member_id` es quien apretó el botón;
  -- el que comió vive en el renglón servido. Sin renglón no hay comensal y la
  -- fila queda sin persona, que es lo correcto para la merma del hogar.
  v_comensal := app.movement_eater_member(p_movement_id);

  -- Lote sin valor: la salida vale DESCONOCIDO, con su motivo. Nunca $0.
  -- La moneda sale del LOTE, congelada al recibirlo, no de households.currency:
  -- cambiarle la moneda al hogar reinterpretaría lo que costó lo de antes.
  if v_lot.value_status <> 'KNOWN' then
    insert into public.cost_allocations (
      household_id, movement_id, lot_id, category, currency,
      amount_minor, value_status, unknown_reason, quantity,
      cost_basis_snapshot, engine_version, occurred_on, recognized_on,
      consumption_log_id, member_id
    ) values (
      v_mov.household_id, p_movement_id, v_mov.lot_id, v_cat, v_lot.currency,
      null, 'UNKNOWN', 'LOT_VALUE_UNKNOWN', v_salida,
      jsonb_build_object('lot_quantity_before', p_quantity_before,
                         'lot_value_minor', null,
                         'reason', v_mov.reason::text),
      app.cost_allocation_engine_version(), v_dia, app.household_today(v_mov.household_id),
      v_mov.consumption_log_id, v_comensal
    ) returning id into v_id;
    return v_id;
  end if;

  v_adquirido := v_lot.value_minor;

  -- [H14][H55] Lo YA comprometido incluye las CORRECTION: son justamente la
  -- valorización tardía de las salidas viejas. Excluirlas hace que la plata de
  -- lo ya consumido se traspase a lo que queda —el kilo restante "costaría"
  -- $8.333 en vez de $5.000— y después el tope revienta para siempre.
  --
  -- Y ACÁ NO SE PUEDE HACER `raise`. Esta función ya no la llama un test: la
  -- llama el ledger en cada bocado (`app.apply_movement_to_lot`). Reventar acá
  -- sería impedirle a la casa registrar que comió porque a la contabilidad le
  -- falta un papel — el sistema dejaría de funcionar por un problema del
  -- sistema. Lo que corresponde es lo de siempre: la salida se registra, y su
  -- costo se declara DESCONOCIDO con su motivo. Nunca $0, nunca un remanente
  -- inflado repartido como si fuera exacto, y nunca un plato que no se puede
  -- servir. El hecho queda a la vista en `unknown_value_inventory` y en
  -- `verify_lot_cost_invariant` (motivo ASIGNACIONES_DESCONOCIDAS).
  if exists (select 1 from public.cost_allocations
             where lot_id = v_mov.lot_id and value_status = 'UNKNOWN') then
    insert into public.cost_allocations (
      household_id, movement_id, lot_id, category, currency,
      amount_minor, value_status, unknown_reason, quantity,
      cost_basis_snapshot, engine_version, occurred_on, recognized_on,
      consumption_log_id, member_id
    ) values (
      v_mov.household_id, p_movement_id, v_mov.lot_id, v_cat, v_lot.currency,
      null, 'UNKNOWN', 'PENDING_LATE_CORRECTION', v_salida,
      jsonb_build_object('lot_quantity_before', p_quantity_before,
                         'lot_value_minor', v_lot.value_minor,
                         'reason', v_mov.reason::text,
                         'nota', 'el lote arrastra salidas desconocidas sin corregir'),
      app.cost_allocation_engine_version(), v_dia, app.household_today(v_mov.household_id),
      v_mov.consumption_log_id, v_comensal
    ) returning id into v_id;
    return v_id;
  end if;

  select coalesce(sum(amount_minor * app.cost_category_lot_sign(category)), 0)
    into v_ya
  from public.cost_allocations
  where lot_id = v_mov.lot_id and app.cost_category_lot_sign(category) <> 0;

  v_restante := v_adquirido - v_ya;
  if v_restante < 0 then
    raise exception 'el lote "%" ya tiene más costo asignado que valor adquirido: esto es un error de programa',
      v_lot.label using errcode = 'check_violation';
  end if;

  if v_salida >= p_quantity_before then
    -- El lote se cierra: la última salida se lleva EXACTAMENTE el remanente,
    -- igual que el último hijo de un split. Sin esto queda un residuo flotando.
    v_monto := v_restante;
  else
    v_monto := app.mul_div_round(v_restante, (v_salida * 1000)::bigint,
                                 (p_quantity_before * 1000)::bigint);
  end if;

  if v_monto > v_restante then
    raise exception 'el costo asignado (%) excede lo que le queda al lote (%)', v_monto, v_restante
      using errcode = 'check_violation';
  end if;

  insert into public.cost_allocations (
    household_id, movement_id, lot_id, category, currency,
    amount_minor, value_status, unknown_reason, quantity,
    cost_basis_snapshot, engine_version, occurred_on, recognized_on,
    consumption_log_id, member_id
  ) values (
    v_mov.household_id, p_movement_id, v_mov.lot_id, v_cat, v_lot.currency,
    v_monto, 'KNOWN', null, v_salida,
    jsonb_build_object('lot_quantity_before', p_quantity_before,
                       'lot_value_minor', v_adquirido,
                       'already_allocated_minor', v_ya,
                       'remaining_minor', v_restante,
                       'reason', v_mov.reason::text),
    app.cost_allocation_engine_version(), v_dia, app.household_today(v_mov.household_id),
    v_mov.consumption_log_id, v_comensal
  ) returning id into v_id;

  return v_id;
end;
$$;

/**
 * El gasto que NO queda en la despensa: despacho, propina, bolsa, comisión y la
 * diferencia de redondeo de la boleta.
 *
 * Va al consumo económico del período de la COMPRA (`purchased_on`), porque ahí
 * sí la regla del sprint aplica al revés: ese peso se consumió al instante. Si
 * viviera solo como "caja", la línea "valor guardado en la despensa" quedaría
 * inflada por exactamente ese monto.
 */
create or replace function app.allocate_purchase_expense(p_purchase uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_p public.purchases;
  v_c record;
  v_n int := 0;
begin
  select * into v_p from public.purchases where id = p_purchase;
  if v_p.id is null then
    raise exception 'la compra no existe' using errcode = 'check_violation';
  end if;

  for v_c in
    select * from public.purchase_charges
    where purchase_id = p_purchase and policy = 'EXPENSE_ONLY'
      and not exists (select 1 from public.cost_allocations a where a.purchase_charge_id = purchase_charges.id)
    order by id
  loop
    insert into public.cost_allocations (
      household_id, purchase_charge_id, category, currency,
      amount_minor, value_status, unknown_reason, quantity,
      cost_basis_snapshot, engine_version, occurred_on, recognized_on
    ) values (
      v_p.household_id, v_c.id, 'NON_CAPITALIZED_EXPENSE', v_p.currency,
      v_c.amount_minor, 'KNOWN', null, 0,
      jsonb_build_object('charge_kind', v_c.kind::text, 'label', v_c.label,
                         'policy', v_c.policy::text),
      v_p.allocation_policy_version, v_p.purchased_on,
      app.household_today(v_p.household_id)
    );
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- El balance por lote: adquirido = consumido + merma + traspasos + remanente
-- ---------------------------------------------------------------------------
--
-- [H25] Ni un `sum()` desnudo: si alguna asignación del lote es DESCONOCIDA, el
-- remanente NO es un número — es NULL, y la columna `has_unknown_allocations` lo
-- dice con todas sus letras. Un lote de valor mixto con `sum()` a secas
-- subdeclara el consumo y sobredeclara lo que queda en la despensa.
--
-- Y el enum se cubre ENTERO: CORRECTION y ADJUSTMENT_LOSS tienen su columna. Un
-- `filter` suelto que deja categorías afuera descuadra todo lote corregido.

create view public.lot_cost_balance with (security_invoker = true) as
select
  l.id as lot_id,
  l.household_id,
  l.label,
  l.quantity as quantity_remaining,
  l.value_minor as acquired_minor,
  (l.value_status <> 'KNOWN') as acquired_unknown,
  -- Estos `coalesce(..., 0)` NO son "desconocido = cero": la subconsulta devuelve
  -- NULL cuando el lote no tiene NINGUNA asignación de esa categoría, y eso sí es
  -- cero de verdad. El desconocido de verdad viaja por `unknown_allocations` y
  -- deja `remaining_minor` en NULL unas líneas más abajo.
  coalesce(a.consumed_minor, 0)   as consumed_minor,
  coalesce(a.wasted_minor, 0)     as wasted_minor,
  coalesce(a.adjustment_minor, 0) as adjustment_minor,
  coalesce(a.correction_minor, 0) as correction_minor,
  coalesce(a.transfer_minor, 0)   as transfer_minor,
  coalesce(a.unknown_count, 0)    as unknown_allocations,
  coalesce(a.unknown_count, 0) > 0 as has_unknown_allocations,
  case
    when l.value_status <> 'KNOWN' then null
    when coalesce(a.unknown_count, 0) > 0 then null
    else l.value_minor
         - coalesce(a.consumed_minor, 0) - coalesce(a.wasted_minor, 0)
         - coalesce(a.adjustment_minor, 0) - coalesce(a.correction_minor, 0)
         - coalesce(a.transfer_minor, 0)
  end as remaining_minor
from public.inventory_lots l
left join lateral (
  select
    sum(amount_minor) filter (where category = 'CONSUMED')        as consumed_minor,
    sum(amount_minor) filter (where category in ('WASTED_AVOIDABLE', 'WASTED_EXPECTED',
                                                 'WASTED_THIRD_PARTY')) as wasted_minor,
    sum(amount_minor) filter (where category = 'ADJUSTMENT_LOSS')  as adjustment_minor,
    sum(amount_minor) filter (where category = 'CORRECTION')       as correction_minor,
    sum(amount_minor * app.cost_category_lot_sign(category))
      filter (where category in ('TRANSFER_OUT', 'TRANSFER_IN')) as transfer_minor,
    count(*) filter (where value_status = 'UNKNOWN')               as unknown_count
  from public.cost_allocations c where c.lot_id = l.id
) a on true
where app.finance_access(l.household_id, 'FINANCE_VIEW');

comment on view public.lot_cost_balance is
  'remaining_minor es NULL —no cero— cuando el lote entró sin valor o cuando alguna de sus '
  'asignaciones es desconocida. Un número ahí sería una mentira con cara de dato.';

/**
 * Los lotes en los que el balance NO cuadra. Debería devolver siempre vacío.
 *
 * Los lotes con desconocidos se reportan APARTE (`motivo = 'DESCONOCIDO'`), no
 * se ignoran en silencio: K-19 hace dominar el desconocido, y un desconocido
 * escondido es peor que un descuadre a la vista.
 */
create or replace function app.verify_lot_cost_invariant(p_household uuid)
returns table (lot_id uuid, label text, motivo text, acquired_minor bigint, asignado_minor bigint)
language sql stable security definer set search_path = public as $$
  select b.lot_id, b.label,
         case when b.acquired_unknown then 'VALOR_DE_ORIGEN_DESCONOCIDO'
              when b.has_unknown_allocations then 'ASIGNACIONES_DESCONOCIDAS'
              else 'DESCUADRE' end as motivo,
         b.acquired_minor,
         b.consumed_minor + b.wasted_minor + b.adjustment_minor
           + b.correction_minor + b.transfer_minor as asignado_minor
  from public.lot_cost_balance b
  where b.household_id = p_household
    and (b.acquired_unknown
         or b.has_unknown_allocations
         -- Un lote cerrado (cantidad 0) tiene que tener TODO su valor asignado.
         or (b.quantity_remaining = 0 and b.remaining_minor is not null
             and b.remaining_minor <> 0)
         -- Y uno abierto no puede tener más asignado que adquirido.
         or (b.remaining_minor is not null and b.remaining_minor < 0));
$$;

-- ===========================================================================
-- EL ENGANCHE: quien mueve el ledger COSTEA, en el mismo paso
-- ===========================================================================
--
-- Lo que faltaba, y era todo: `app.allocate_movement_cost` no tenia UN SOLO
-- llamador de produccion. Estaba escrita, no construida. Comer, botar y ajustar
-- no dejaban ni una fila de `cost_allocations`, y el panel presentaba ese vacio
-- como «Total consumido: $0» —un CERO CONOCIDO—, que es exactamente la mentira
-- que este sprint existe para impedir.
--
-- POR QUE ACA Y NO EN CADA RPC. Los caminos que sacan comida de la despensa son
-- once y viven repartidos en las migraciones 0011, 0012, 0013, 0015, 0017, 0019,
-- 0022, 0023, 0036 y 0041 (consumo planificado, servido, servido fuera de plan,
-- descarte de servido, descarte de lote, ajuste, tareas de preparacion, uso
-- directo, servido de evento, sobras de evento...). Reescribir once funciones
-- deja once oportunidades de olvidarse, y la doceava —la que escriba el proximo
-- sprint— nace sin costear y nadie se entera hasta que el panel miente otra vez.
-- El ledger, en cambio, es UNO: `public.inventory_movements`. Se engancha ahi.
--
-- Y SE ENGANCHA DENTRO DE `app.apply_movement_to_lot`, no en un trigger aparte,
-- por una razon que no es de estilo. El contrato del costeador exige la cantidad
-- que el lote tenia ANTES del movimiento, leida BAJO EL MISMO LOCK. Esta funcion
-- ya hace exactamente eso (`select ... for update` antes de aplicar el delta).
-- Un segundo trigger tendria que adivinar si el primero ya corrio, y el orden de
-- ejecucion de dos triggers `after insert` en Postgres lo decide el ORDEN
-- ALFABETICO DEL NOMBRE: renombrar un trigger cambiaria, en silencio, la base de
-- costo de toda la casa. Una funcion, un lock, una verdad.
--
-- QUE NO SE COSTEA ACA: las entradas (capitalizan, no gastan) y las
-- transferencias (la comida sigue en la casa). La lista de transferencias NO se
-- repite aca: es `app.movement_is_value_transfer`, la misma que usan el costeador
-- y `app.classify_waste`. Tres copias del mismo literal es como PREP_LOSS pudo
-- quedar afuera de una sola de ellas.

create or replace function app.apply_movement_to_lot()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_qty numeric; v_label text; v_status public.lot_status; v_nuevo public.lot_status;
begin
  select quantity, label, status into v_qty, v_label, v_status
  from public.inventory_lots where id = new.lot_id for update;

  if v_qty is null then raise exception 'no autorizado'; end if;
  if v_qty + new.delta < 0 then
    raise exception 'el movimiento dejaría el lote "%" en negativo (%). El inventario no inventa stock.',
      v_label, v_qty + new.delta
      using errcode = 'check_violation';
  end if;

  -- Estado derivado que RESPETA la historia: un delta 0 (MOVE/THAW) no cambia
  -- nada; un lote cerrado no revive salvo entrada real; y el cierre dice POR
  -- QUE se cerro — merma != particion != consumo.
  if new.delta = 0 then
    v_nuevo := v_status;
  elsif v_qty + new.delta > 0 then
    v_nuevo := case when v_status in ('CONSUMED', 'DISCARDED', 'SPLIT')
                    then 'AVAILABLE'::public.lot_status
                    else v_status end;
  else
    v_nuevo := case
      when new.reason in ('SPOILED', 'EXPIRED', 'DAMAGED', 'DISCARDED_LEFTOVER', 'PURCHASE_PROBLEM')
        then 'DISCARDED'::public.lot_status
      when new.reason in ('SPLIT', 'MERGE') then 'SPLIT'::public.lot_status
      else 'CONSUMED'::public.lot_status
    end;
  end if;

  update public.inventory_lots
  set quantity = quantity + new.delta,
      status = v_nuevo,
      updated_at = now()
  where id = new.lot_id;

  -- Y ACA, con `v_qty` —la cantidad de ANTES, tomada bajo este mismo lock—, el
  -- movimiento se costea. Misma transaccion, mismo lock, mismo instante: si el
  -- costeo falla, el movimiento tampoco ocurrio.
  if new.delta < 0 and not app.movement_is_value_transfer(new.reason) then
    perform app.allocate_movement_cost(new.id, v_qty);
  end if;

  return new;
end;
$$;

comment on function app.apply_movement_to_lot is
  'Aplica el movimiento al lote Y lo costea en el mismo paso. Las dos cosas van '
  'juntas a proposito: la base de costo es la cantidad previa bajo ESTE lock.';

-- ===========================================================================
-- SPLIT y MERGE v5: el valor que se mueve es el REMANENTE, no el adquirido
-- ===========================================================================
--
-- Las v4 (0042) reparten `value_minor`, que es lo que costo el lote ENTERO el
-- dia que entro. Con el costeador enganchado eso ya no es una imprecision: es
-- plata inventada. Un lote de $5.000 con $2.000 ya consumidos vale $3.000; si al
-- partirlo los hijos se reparten $5.000, «tu despensa vale hoy» sube por
-- exactamente lo que la casa ya se comio, y el costo por kilo de cada hijo sale
-- inflado para siempre.
--
-- Se redefinen ACA y no en la 0042 porque `public.cost_allocations` —la tabla
-- que dice cuanto se cargo ya contra el lote— nace en esta migracion: en la 0042
-- estas funciones no tienen como saberlo, y una migracion no puede consultar una
-- tabla del futuro.
--
-- LA REGLA, una sola para los dos: cuando la comida se va a otro lote, el valor
-- ADQUIRIDO del origen baja EXACTAMENTE en lo que se llevo. Asi el remanente
-- (adquirido − cargado) sigue cuadrando en los dos extremos y `lot_cost_balance`
-- no reporta descuadres eternos.

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
  v_ya bigint;
  v_desconocidas bigint;
  v_restante bigint;
  v_repartido_minor bigint := 0;
  v_costeable boolean;
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
    v_pesos := v_pesos || (round(v_q, 3) * 1000)::bigint;
  end loop;
  if v_total > v_lot.quantity then
    raise exception 'las partes suman % pero el lote tiene %: partir no crea comida',
      v_total, v_lot.quantity;
  end if;

  -- La ultima parte del reparto es LO QUE EL PADRE CONSERVA.
  v_pesos := v_pesos || (round(v_lot.quantity - v_total, 3) * 1000)::bigint;

  -- LO YA CARGADO contra este lote. El `count` de desconocidas va aparte: si
  -- alguna asignacion es DESCONOCIDA, el remanente NO es un numero —es NULL— y
  -- un `sum()` desnudo lo convertiria en cero en silencio, que es repartirles a
  -- los hijos plata que la casa ya se comio.
  select coalesce(sum(c.amount_minor * app.cost_category_lot_sign(c.category))
                    filter (where app.cost_category_lot_sign(c.category) <> 0), 0),
         count(*) filter (where c.value_status = 'UNKNOWN')
    into v_ya, v_desconocidas
    from public.cost_allocations c where c.lot_id = p_lot_id;

  v_costeable := (v_lot.value_status = 'KNOWN' and v_desconocidas = 0);

  if v_costeable then
    v_restante := v_lot.value_minor - v_ya;
    if v_restante < 0 then
      raise exception
        'el lote "%" tiene mas costo asignado (%) que valor adquirido (%): esto es un error de programa',
        v_lot.label, v_ya, v_lot.value_minor using errcode = 'check_violation';
    end if;
    -- Se reparte EL REMANENTE, no el adquirido.
    v_partes := app.apportion(v_restante, v_pesos);
  end if;

  v_member := app.current_member_id(v_lot.household_id);

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, group_id, actor_member_id)
  values (v_lot.household_id, p_lot_id, 'SPLIT', -v_total, v_group, v_member);

  if v_lot.acquisition_value is not null and v_lot.quantity > 0 then
    v_objetivo := round(v_lot.acquisition_value * v_total / v_lot.quantity, 4);
  else
    v_objetivo := null;
  end if;

  foreach v_q in array p_quantities loop
    v_i := v_i + 1;

    if v_costeable then
      v_valor_minor_hijo := v_partes[v_i];
      v_status := 'KNOWN';
      v_reason := null;
      -- El espejo en `numeric` SIGUE al entero cuando el valor se conoce: son
      -- dos representaciones del mismo hecho y no pueden divergir.
      v_valor_hijo := app.minor_to_value(v_partes[v_i], v_lot.currency);
      v_repartido_minor := v_repartido_minor + v_partes[v_i];
    else
      v_valor_minor_hijo := null;
      v_status := 'UNKNOWN';
      -- El hijo hereda el MOTIVO: "no se cuanto costo esto" tiene la misma causa
      -- que en el lote de origen. Y si la causa es que el padre arrastra salidas
      -- sin corregir, eso se dice con todas sus letras en vez de repartir un
      -- remanente que todavia nadie puede calcular.
      v_reason := case
        when v_lot.value_status <> 'KNOWN'
          then coalesce(v_lot.value_unknown_reason, 'LOT_VALUE_UNKNOWN')
        else 'PENDING_LATE_CORRECTION' end::public.money_unknown_reason;
      if v_objetivo is null then
        v_valor_hijo := null;
      elsif v_i = v_n then
        v_valor_hijo := v_objetivo - v_valor_repartido;
      else
        v_valor_hijo := round(v_lot.acquisition_value * v_q / v_lot.quantity, 4);
      end if;
    end if;
    v_valor_repartido := v_valor_repartido + coalesce(v_valor_hijo, 0);

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

  -- El padre entrega SOLO lo que se llevaron los hijos. Lo ya cargado contra el
  -- (`v_ya`) se queda donde estaba: su remanente pasa a ser la ultima parte del
  -- reparto, exacta, y el balance del lote sigue cuadrando.
  if v_costeable then
    update public.inventory_lots
    set value_minor = v_lot.value_minor - v_repartido_minor
    where id = p_lot_id;
  end if;

  return v_hijos;
end;
$$;

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
  v_ya bigint;
  v_desconocidas bigint;
  v_entregado bigint;
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

    select coalesce(sum(c.amount_minor * app.cost_category_lot_sign(c.category))
                      filter (where app.cost_category_lot_sign(c.category) <> 0), 0),
           count(*) filter (where c.value_status = 'UNKNOWN')
      into v_ya, v_desconocidas
      from public.cost_allocations c where c.lot_id = v_id;

    -- El desconocido DOMINA, y ahora tambien lo domina un lote que ya entrego
    -- una parte que nadie pudo costear: no se sabe cuanto queda para entregar.
    if v_lot.value_status = 'UNKNOWN' or v_desconocidas > 0 then
      v_minor_desconocido := true;
    elsif not v_minor_desconocido then
      -- Entrega su REMANENTE (adquirido − cargado), no lo que costo entero.
      v_entregado := v_lot.value_minor - v_ya;
      if v_entregado < 0 then
        raise exception
          'el lote "%" tiene mas costo asignado (%) que valor adquirido (%): esto es un error de programa',
          v_lot.label, v_ya, v_lot.value_minor using errcode = 'check_violation';
      end if;
      v_minor := v_minor + v_entregado;
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
    case when v_minor_desconocido
         then case when v_hay_valor and v_valor is not null then v_valor else null end
         -- Con valor conocido el espejo `numeric` SIGUE al entero: lo que entra
         -- es la suma de los REMANENTES, no la de los precios de compra.
         else app.minor_to_value(v_minor, v_primero.currency) end,
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

    select * into v_lot from public.inventory_lots where id = v_id;
    select coalesce(sum(c.amount_minor * app.cost_category_lot_sign(c.category))
                      filter (where app.cost_category_lot_sign(c.category) <> 0), 0)
      into v_ya
      from public.cost_allocations c where c.lot_id = v_id;

    if v_lot.value_status = 'KNOWN' then
      -- Entrego su remanente y le queda EXACTAMENTE lo que ya se cargo contra
      -- el: remanente cero, sin descuadre. Pisar esto con 0 —como hacia la v4—
      -- dejaba `remaining_minor` en negativo para siempre y reventaba
      -- `assert_finance_integrity` para ese hogar de ahi en adelante.
      update public.inventory_lots
      set acquisition_value = null,
          value_minor = v_ya,
          value_status = 'KNOWN',
          value_unknown_reason = null
      where id = v_id;
    else
      -- Nunca se supo cuanto costo: entrego todo lo que tenia y queda en CERO
      -- CONOCIDO (ya no tiene nada, y eso SI se sabe).
      update public.inventory_lots
      set acquisition_value = null,
          value_minor = 0,
          value_status = 'KNOWN',
          value_unknown_reason = null
      where id = v_id;
    end if;
  end loop;

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, group_id, actor_member_id)
  values (v_primero.household_id, v_nuevo, 'MERGE', v_total, v_group, v_member);

  return v_nuevo;
end;
$$;
