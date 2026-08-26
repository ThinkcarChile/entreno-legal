-- Sprint 12 — FoodLog (parte 2): el eje ACTUAL_CONSUMED, o sea "qué comió de
-- verdad esta persona".
--
-- POR QUÉ ESTA MIGRACIÓN NO ES OPCIONAL
--
-- La 0036 le sacó a `consume_planned_meal` el poder de fabricar realidad: dejó
-- de escribir `consumption_logs` y dejó de mover la porción a CONSUMED. Eso es
-- correcto —servir y comer son dos hechos distintos— pero deja el tercer eje
-- SIN ESCRITOR. Y un eje sin escritor no queda "pendiente": queda VACÍO, y sus
-- lectores leen el vacío como un cero. Un hogar que sirvió todos los días
-- pasaría a tener consumo cero, el pronóstico se apagaría solo y la lista de
-- compras diría que no hace falta nada. Por eso la 0036 no puede aplicarse
-- sola: esta migración es la otra mitad del mismo cambio.
--
-- LOS TRES HECHOS, OTRA VEZ, PARA QUE NADIE LOS COLAPSE
--
--   · PLANNED  — `member_serving_projections` + `member_serving_components`.
--                Mutable hasta que se sirve. No se toca acá.
--   · SERVIDO  — `meal_serving_records` + `meal_serving_record_items` (0036).
--                ÚNICO dueño del efecto físico sobre el inventario.
--   · REAL DECLARADO — `consumption_logs` (0011:179, reusada, con `kind` y
--                `affects_inventory` que hasta hoy nadie usaba) +
--                `intake_log_items`. Nace acá. Es NUTRICIONAL, es inmutable y
--                NO MUEVE UN SOLO GRAMO DE LA DESPENSA.
--
-- Ninguno se fabrica a partir de otro. Lo asumido nunca se confunde con lo
-- declarado. UNKNOWN != ZERO. NADA != CERO GRAMOS. ERROR != VACÍO.
--
-- LO QUE ESTA MIGRACIÓN SE PROHÍBE A SÍ MISMA
--
-- Declarar que alguien comió NO descuenta inventario. Nunca. Ni un caso
-- especial, ni un "salvo que". Y eso no se sostiene con disciplina: se sostiene
-- con un CONSTRAINT sobre `inventory_movements` (sección 3). Si mañana alguien
-- escribe un RPC que intente colgar un movimiento de una declaración de
-- consumo, choca contra la pared antes de tocar un lote.
--
-- No modifica ninguna migración congelada (última congelada: 0032). Los enums
-- (`intake_source`, `intake_extent`, `intake_log_status`) ya nacieron en 0036:
-- acá solo se usan, así que no hay ningún `alter type ... add value` y por lo
-- tanto ninguna trampa de literales dentro de la misma transacción (0008:78).

-- ---------------------------------------------------------------------------
-- 1. `consumption_logs` crece: "esta persona declaró que comió"
-- ---------------------------------------------------------------------------
--
-- Se REUSA la tabla del Sprint 7 en vez de crear una paralela. La tabla ya
-- tenía el hueco exacto de este sprint: `kind` ('PLANNED' | 'OFF_PLAN') y
-- `affects_inventory`, construidos en 0011 y jamás usados. Crear
-- `food_logs` al lado habría dejado dos tablas que dicen lo mismo, que es
-- exactamente cómo nace un dato con dos dueños.

alter table public.consumption_logs
  -- De qué acto de servir cuelga esta declaración. NULL a propósito cuando se
  -- comió algo que no salió de esta despensa (fuera de casa, o un regalo): no
  -- hay servido detrás y decirlo con un id inventado sería falsear el hecho.
  add column serving_record_id uuid
    references public.meal_serving_records (id) on delete set null,

  -- Historia: nada se borra. Se supera (CORRECTED) o se anula (VOIDED).
  add column status public.intake_log_status not null default 'ACTIVE',

  -- EL ORIGEN DEL DATO. La columna que impide que el motor adaptativo aprenda
  -- de algo que nadie dijo. El cliente NO la elige: la estampan los RPC.
  add column source public.intake_source not null default 'ASSUMED_FROM_PLAN',

  -- El día del HOGAR en que se comió (`app.household_today`), DATE-only, jamás
  -- el del servidor ni el de la sesión. Es la llave por la que el motor agrupa:
  -- si viviera solo en `logged_at`, declarar a las 00:30 la cena de anoche la
  -- movería de día.
  add column consumed_on date,

  add column meal_type public.meal_type,

  -- La corrección NO reescribe: nace una fila nueva que apunta a la que supera.
  add column supersedes_log_id uuid references public.consumption_logs (id) on delete set null,
  add column correction_reason text,
  add column corrected_at timestamptz,

  add column void_reason text,
  add column voided_at   timestamptz,
  add column voided_by   uuid references public.household_members (id) on delete set null,

  -- K-22 otra vez: un reintento jamás duplica una declaración.
  add column dedupe_key text;

-- `source` con default 'ASSUMED_FROM_PLAN' NO es una comodidad: es la etiqueta
-- HONESTA de las filas que ya existen. Todas las escribió el viejo
-- `consume_planned_meal`, que creaba un log por cada porción sin preguntarle a
-- nadie — o sea, asumiendo el plan. Ahora que la columna existe, esa historia
-- queda dicha por su nombre y el motor puede distinguirla. Se le saca el
-- default para que de acá en adelante NADIE inserte sin decir de dónde salió el
-- dato: los RPC lo derivan del actor, no lo reciben del cliente.
alter table public.consumption_logs alter column source drop default;

-- Relleno de `consumed_on` para la historia. Primero la fecha de la porción
-- planificada —que YA es DATE-only en el calendario del hogar y no hay que
-- adivinarle zona— y recién si no hay, el día del hogar del timestamp.
update public.consumption_logs l
set consumed_on = coalesce(
      (select p.serving_date from public.member_serving_projections p
       where p.id = l.projection_id),
      (l.logged_at at time zone coalesce(h.timezone, 'America/Santiago'))::date)
from public.households h
where h.id = l.household_id and l.consumed_on is null;

alter table public.consumption_logs alter column consumed_on set not null;

-- `kind` gana un tercer valor. Comer fuera de casa NO es "fuera de plan": es
-- otra cosa, porque no hay despensa detrás y por lo tanto no hay nada que
-- reponer. Meterlos en el mismo saco hacía que la lista de compras creyera que
-- el almuerzo del trabajo salió del refrigerador. El nombre del CHECK de 0011
-- es autogenerado, así que se busca por definición en vez de adivinarlo.
do $$
declare v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.consumption_logs'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%kind%';
  if v_name is not null then
    execute format('alter table public.consumption_logs drop constraint %I', v_name);
  end if;
end $$;

alter table public.consumption_logs
  add constraint consumption_logs_kind_check
  check (kind in ('PLANNED', 'OFF_PLAN', 'AWAY'));

-- Anular o corregir exigen decir por qué y cuándo: una anulación muda es
-- historia borrada con otro nombre. Las filas viejas están todas en ACTIVE, así
-- que estos tres CHECK se validan sin drama sobre lo que ya existe.
alter table public.consumption_logs
  add constraint intake_log_void_has_stamp
    check ((status = 'VOIDED') = (voided_at is not null)),
  add constraint intake_log_void_has_reason
    check (status <> 'VOIDED' or nullif(trim(coalesce(void_reason, '')), '') is not null),
  add constraint intake_log_corrected_has_stamp
    check ((status = 'CORRECTED') = (corrected_at is not null)),
  add constraint intake_log_not_self_superseding
    check (supersedes_log_id is null or supersedes_log_id <> id);

/**
 * `affects_inventory` deja de ser una columna decorativa y pasa a significar
 * UNA sola cosa: "esta comida salió de la despensa de este hogar". Y eso es
 * verdad exactamente cuando hay un acto de servir detrás — que es el único
 * dueño del efecto físico desde la 0036.
 *
 * NOT VALID a propósito: las filas del mundo viejo tienen `affects_inventory`
 * en true y ningún `serving_record_id`, porque en ese mundo el descuento lo
 * hacía el propio log. Esa historia es real y no se reescribe. Lo que sí se
 * cierra es la puerta hacia adelante.
 */
alter table public.consumption_logs
  add constraint intake_log_inventory_iff_served
  check ((serving_record_id is not null) = affects_inventory) not valid;

-- EL ÍNDICE DE 0011 SE CAE, Y ES EL PUNTO FINO DE ESTA MIGRACIÓN.
--
--   create unique index consumption_logs_projection_uniq
--     on public.consumption_logs (projection_id) where projection_id is not null;
--
-- "Una porción se registra como comida UNA vez" sigue siendo cierto — pero UNA
-- VEZ VIVA, no una vez en toda la historia. Con el índice total, corregir era
-- estructuralmente imposible: la corrección crea una fila nueva para la misma
-- porción y chocaba contra el índice, así que la única forma de corregir habría
-- sido un UPDATE encima, o sea borrar lo que la persona había dicho antes. Es
-- el mismo criterio del índice parcial de `meal_serving_records` (0036).
drop index if exists public.consumption_logs_projection_uniq;

create unique index intake_logs_projection_active_uniq
  on public.consumption_logs (projection_id)
  where projection_id is not null and status = 'ACTIVE';

create unique index intake_logs_serving_record_active_uniq
  on public.consumption_logs (serving_record_id)
  where serving_record_id is not null and status = 'ACTIVE';

-- LA CLAVE DE REINTENTO ES POR HOGAR Y SOLO SOBRE LO VIVO.
--
-- Global y sin mirar `status`, este índice era las dos fallas ALTAS a la vez:
--
--   · Sin `household_id`, la clave vivía en un espacio de nombres COMPARTIDO
--     entre casas. Un cliente que manda la clave de otro hogar se lleva por
--     delante una declaración que ni siquiera puede ver: o la función se la
--     devuelve, o —si igual intentara escribir— choca contra una fila ajena
--     con un error que nadie puede explicar.
--   · Sin `status`, anular y volver a declarar era estructuralmente imposible:
--     la fila VOIDED se queda con la clave para siempre y la declaración nueva
--     no cabe. Y "me equivoqué, lo anulo y lo digo de nuevo" es EXACTAMENTE lo
--     que hace la gente, así que el eje ACTUAL quedaba huérfano en el camino
--     principal, en silencio.
--
-- El invariante real es "una sola declaración VIVA por clave y por hogar", que
-- es el mismo criterio de los índices de porción y de servido de acá arriba:
-- la historia se acumula, lo vivo es único.
create unique index intake_logs_dedupe_active_uniq
  on public.consumption_logs (household_id, dedupe_key)
  where dedupe_key is not null and status = 'ACTIVE';

-- El índice del LECTOR del eje: por integrante y por día del hogar, solo lo
-- vivo. Es la consulta que hace el motor adaptativo todos los días.
create index intake_logs_member_day_idx
  on public.consumption_logs (member_id, consumed_on desc) where status = 'ACTIVE';
create index intake_logs_household_day_idx
  on public.consumption_logs (household_id, consumed_on desc) where status = 'ACTIVE';
create index intake_logs_supersedes_idx
  on public.consumption_logs (supersedes_log_id) where supersedes_log_id is not null;

comment on column public.consumption_logs.source is
  'De dónde viene la afirmación de que esta persona comió: lo declaró ella, lo '
  'declaró quien la cuida, o se ASUMIÓ del plan. Lo asumido no es una '
  'declaración y el motor adaptativo tiene que poder distinguirlo SIEMPRE.';
comment on column public.consumption_logs.affects_inventory is
  'Si esta comida salió de la despensa del hogar. Es verdad exactamente cuando '
  'hay un servido detrás: el consumo declarado NO descuenta nada por su cuenta.';
comment on column public.consumption_logs.consumed_on is
  'Día del HOGAR en que se comió, DATE-only. Declarar a las 00:30 la cena de '
  'anoche no puede cambiarla de día.';

-- ---------------------------------------------------------------------------
-- 2. `intake_log_items` — un renglón por cosa que se comió
-- ---------------------------------------------------------------------------
--
-- Acá vive el número. Y acá vive, sobre todo, el DERECHO A NO SABERLO: una
-- familia real no pesa el plato. Si el sistema exige un número, la gente
-- inventa uno, y un número inventado contamina el motor peor que un hueco
-- honesto. Por eso `quantity` es NULLABLE y NULL significa DESCONOCIDO — jamás
-- cero.

create table public.intake_log_items (
  id     uuid primary key default gen_random_uuid(),
  log_id uuid not null references public.consumption_logs (id) on delete cascade,

  -- De qué renglón SERVIDO se comió. `on delete set null`: lo servido puede
  -- desaparecer (se fue del hogar el integrante), lo declarado sobrevive.
  -- NULL = no salió de un servido de esta casa (comida de afuera, un regalo).
  serving_record_item_id uuid
    references public.meal_serving_record_items (id) on delete set null,

  -- La etiqueta se congela SIEMPRE, igual que en lo servido: si el catálogo
  -- archiva el alimento, el renglón sigue sabiendo qué era.
  label text not null check (char_length(label) between 1 and 200),

  -- Identidad DUAL, mismo criterio que 0022 y que 0036: producto contra
  -- producto, alimento contra alimento. `<= 1` y no `= 1` porque comer algo sin
  -- identidad de catálogo ("el pan de la esquina") es lo más normal del mundo y
  -- forzar una identidad sería inventarla.
  ingredient_id uuid references public.ingredients (id) on delete set null,
  product_id    uuid references public.commercial_products (id) on delete set null,
  constraint intake_item_identity_dual
    check (num_nonnulls(ingredient_id, product_id) <= 1),

  -- CUÁNTO COMIÓ, DICHO COMO LO DICE UNA PERSONA. Es el dato primario del
  -- renglón: siempre está, aunque no haya número.
  extent public.intake_extent not null,

  -- El número, cuando existe. NULL = DESCONOCIDO EXPLÍCITO.
  quantity      numeric(10, 3) check (quantity >= 0),
  unit          text check (unit in ('G', 'ML', 'UNIT')),
  weight_basis  public.weight_basis,

  -- ¿Ese número lo dijo una persona, o lo dedujo un motor a partir del
  -- `extent`? Explícito en un booleano, no deducido de un NULL. Mismo criterio
  -- que `served_quantity_is_declared` (0036).
  quantity_is_declared boolean not null,

  -- Qué motor tradujo `extent` → fracción. LA TRADUCCIÓN NO VIVE EN LA BASE, y
  -- esta columna es la razón: "la mitad" no significará lo mismo dentro de un
  -- año, y cambiar una función de la base reescribiría en silencio lo que se
  -- leyó ayer. Acá se guarda la VERSIÓN que produjo este número, y lo que se
  -- leyó ayer sigue queriendo decir lo que quería decir ayer.
  extent_engine_version text,

  -- NUTRICIÓN CONGELADA. `{}` significa "no se congeló", nunca "cero
  -- calorías". La completitud es POR NUTRIENTE ({"protein_g":"COMPLETE",
  -- "iron_mg":"UNKNOWN"}) porque una tabla nutricional real tiene huecos, y un
  -- hueco declarado vale más que un cero inventado.
  frozen_nutrition       jsonb not null default '{}'::jsonb,
  nutrition_completeness jsonb not null default '{}'::jsonb,

  sort_order int not null default 1,
  created_at timestamptz not null default now(),

  -- De un "no sé" no sale un número. Si alguien sabe los gramos, el extent es
  -- EXACT, no UNKNOWN.
  constraint intake_item_unknown_has_no_number
    check (extent <> 'UNKNOWN' or quantity is null),

  -- EXACT es una afirmación fuerte: "esto es lo que comió". Exige número y
  -- exige que lo haya dicho una persona.
  constraint intake_item_exact_is_declared
    check (extent <> 'EXACT' or (quantity is not null and quantity_is_declared)),

  -- Un número que no declaró nadie tiene que decir qué motor lo produjo.
  constraint intake_item_derived_names_engine
    check (quantity is null or quantity_is_declared or extent_engine_version is not null),

  -- Y un número que SÍ declaró una persona no se le atribuye a ningún motor.
  constraint intake_item_declared_has_no_engine
    check (not quantity_is_declared or extent_engine_version is null),

  -- Un número sin unidad ni base física no es un número: son 200 de algo.
  constraint intake_item_quantity_has_unit
    check ((quantity is null) = (unit is null)),
  constraint intake_item_quantity_has_basis
    check ((quantity is null) = (weight_basis is null)),

  constraint intake_item_nutrition_is_object
    check (jsonb_typeof(frozen_nutrition) = 'object'
       and jsonb_typeof(nutrition_completeness) = 'object')
);

create index intake_log_items_log_idx
  on public.intake_log_items (log_id, sort_order);
create index intake_log_items_serving_item_idx
  on public.intake_log_items (serving_record_item_id)
  where serving_record_item_id is not null;
create index intake_log_items_ingredient_idx
  on public.intake_log_items (ingredient_id) where ingredient_id is not null;
create index intake_log_items_product_idx
  on public.intake_log_items (product_id) where product_id is not null;

comment on table public.intake_log_items is
  'El eje ACTUAL_CONSUMED: qué comió de verdad una persona, renglón por '
  'renglón. Es NUTRICIONAL: no mueve un gramo de la despensa. El único dueño '
  'del descuento son las tablas de servido de la 0036.';
comment on column public.intake_log_items.quantity is
  'Cuánto comió. NULL = DESCONOCIDO EXPLÍCITO, jamás 0. Una familia real no '
  'pesa el plato, y un número inventado contamina el motor peor que un hueco.';
comment on column public.intake_log_items.extent is
  'Cuánto comió dicho como lo dice una persona. UNKNOWN != NONE != 0 g: "no '
  'sé" no es "nada" y "nada" no es "cero gramos calculados".';
comment on column public.intake_log_items.extent_engine_version is
  'Versión del motor que tradujo extent → fracción. La traducción vive en el '
  'motor, NUNCA en la base: cambiarla mañana no puede reescribir lo de ayer.';

-- ---------------------------------------------------------------------------
-- 3. EL CONSTRAINT: el consumo declarado NO TIENE EFECTO FÍSICO
-- ---------------------------------------------------------------------------
--
-- Esto no es una nota en un documento ni una convención entre RPC: es la pared.
--
-- La puerta entre las dos capas existe y es concreta:
-- `inventory_movements.consumption_log_id` (0011:158). Por ahí el viejo
-- `consume_planned_meal` colgaba el descuento de la declaración. Mientras esa
-- columna acepte valores nuevos, cualquier RPC futuro puede volver a hacerlo —
-- y esta vez el doble descuento sería con el servido, que YA descontó.
--
-- Se cierra por CHECK y no por trigger a propósito: un CHECK no se puede
-- esquivar desde adentro de un SECURITY DEFINER, no depende del orden de los
-- triggers y se lee en `\d inventory_movements`.
--
-- NOT VALID: la historia del mundo viejo queda intacta —esos descuentos
-- ocurrieron de verdad y colgaban de verdad de un log—. Lo que se prohíbe es
-- que vuelva a ocurrir. Es exactamente el alcance correcto: no se reescribe el
-- pasado, se cierra el futuro.
alter table public.inventory_movements
  add constraint movements_intake_has_no_physical_effect
  check (consumption_log_id is null) not valid;

comment on constraint movements_intake_has_no_physical_effect on public.inventory_movements is
  'El consumo real es NUTRICIONAL: declarar que alguien comió no mueve un '
  'gramo. El único dueño del descuento es meal_serving_record_items (0036). '
  'NOT VALID porque la historia anterior a la 0036 sí colgaba de acá y esa '
  'historia no se reescribe.';

-- ---------------------------------------------------------------------------
-- 4. Append-only: la historia de lo que alguien dijo que comió
-- ---------------------------------------------------------------------------

/**
 * Un log de consumo no se edita. Solo puede pasar de ACTIVE a CORRECTED o a
 * VOIDED, con su sello y su motivo. Mismo espíritu y mismo escape
 * `pg_trigger_depth() > 1` que `app.ledger_is_append_only` (0011:277) y
 * `app.serving_record_is_append_only` (0036).
 *
 * El escape quirúrgico del bloque 4 bis de la 0036 se reusa tal cual: las seis
 * FK anulables de esta tabla se anulan con un UPDATE que dispara el MOTOR
 * (acción referencial `on delete set null`), no una persona. Sin él, borrar al
 * integrante que anotó la declaración, o el servido del que colgaba, rebotaría
 * contra esta misma guarda con un mensaje que además mentiría sobre la causa.
 */
create or replace function app.intake_log_is_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'una declaración de consumo no se borra: se corrige con correct_intake_log o se anula con void_intake_log';
  end if;

  -- Va ANTES del corte por estado terminal, por la misma razón que en 0036: si
  -- fuera después, borrar al integrante que anuló una declaración (`voided_by`)
  -- sería imposible para siempre, porque esa fila ya está en VOIDED.
  if pg_trigger_depth() > 1
     and app.is_fk_set_null_update(to_jsonb(old), to_jsonb(new), array[
           'assignment_id', 'projection_id', 'logged_by',
           'serving_record_id', 'supersedes_log_id', 'voided_by'
         ])
  then
    return new;
  end if;

  if old.status <> 'ACTIVE' then
    raise exception 'esta declaración ya está % : la historia no se reescribe',
      lower(old.status::text);
  end if;

  -- Lo único que puede cambiar es el bloque de cierre. Todo lo demás —quién,
  -- cuándo, de dónde salió el dato— es historia.
  if new.id                is distinct from old.id
     or new.household_id   is distinct from old.household_id
     or new.member_id      is distinct from old.member_id
     or new.assignment_id  is distinct from old.assignment_id
     or new.projection_id  is distinct from old.projection_id
     or new.serving_record_id is distinct from old.serving_record_id
     or new.kind           is distinct from old.kind
     or new.source         is distinct from old.source
     or new.affects_inventory is distinct from old.affects_inventory
     or new.consumed_on    is distinct from old.consumed_on
     or new.meal_type      is distinct from old.meal_type
     or new.logged_by      is distinct from old.logged_by
     or new.logged_at      is distinct from old.logged_at
     or new.supersedes_log_id is distinct from old.supersedes_log_id
     or new.dedupe_key     is distinct from old.dedupe_key then
    raise exception 'lo que una persona declaró es historia: no se edita, se supera o se anula';
  end if;
  return new;
end;
$$;

create trigger intake_logs_append_only
  before update or delete on public.consumption_logs
  for each row execute function app.intake_log_is_append_only();

/**
 * El renglón declarado es inmutable ENTERO: acá no hay columnas de acumulación
 * que mover, porque no hay efecto físico que acumular. Corregir un renglón es
 * corregir el log completo (`correct_intake_log`), que crea filas nuevas.
 */
create or replace function app.intake_item_is_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'un renglón declarado no se borra: se corrige el registro completo con correct_intake_log';
  end if;

  if pg_trigger_depth() > 1
     and app.is_fk_set_null_update(to_jsonb(old), to_jsonb(new), array[
           'serving_record_item_id', 'ingredient_id', 'product_id'
         ])
  then
    return new;
  end if;

  raise exception 'un renglón declarado no se edita: la corrección crea filas nuevas y deja la anterior a la vista';
end;
$$;

create trigger intake_log_items_append_only
  before update or delete on public.intake_log_items
  for each row execute function app.intake_item_is_append_only();

-- ---------------------------------------------------------------------------
-- 5. Guarda del renglón: coherencia con su log, y nada de oráculos
-- ---------------------------------------------------------------------------

/**
 * Es trigger y no CHECK porque todo lo que hay que verificar vive en la tabla
 * padre o en otra tabla: el hogar, el estado del log, el servido del que dice
 * venir el renglón.
 *
 * Regla de oro de los mensajes: "no existe" y "es de otra casa" responden
 * EXACTAMENTE lo mismo. Un mensaje distinto convierte la función en un oráculo
 * de existencia de recursos ajenos.
 */
create or replace function app.intake_item_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_log public.consumption_logs;
begin
  select * into v_log from public.consumption_logs where id = new.log_id;
  if v_log.id is null then raise exception 'no autorizado'; end if;
  if v_log.status <> 'ACTIVE' then
    raise exception 'no se agregan renglones a una declaración ya cerrada'
      using errcode = 'check_violation';
  end if;

  if new.serving_record_item_id is not null then
    if v_log.serving_record_id is null then
      raise exception
        'este registro no cuelga de ningún servido: un renglón suyo no puede apuntar a uno'
        using errcode = 'check_violation';
    end if;
    -- El renglón servido tiene que ser DE ESE servido. Mismo mensaje para
    -- inexistente y para ajeno.
    if not exists (
      select 1 from public.meal_serving_record_items i
      where i.id = new.serving_record_item_id
        and i.record_id = v_log.serving_record_id
    ) then
      raise exception 'no autorizado';
    end if;
  end if;

  if not app.ingredient_in_scope(new.ingredient_id, v_log.household_id)
     or not app.product_in_scope(new.product_id, v_log.household_id) then
    raise exception 'no autorizado';
  end if;

  -- Lo ASUMIDO no puede disfrazarse de declarado ni renglón por renglón: si el
  -- registro entero dice "esto lo asumí del plan", ninguna de sus filas puede
  -- decir "este número lo dijo una persona".
  if v_log.source = 'ASSUMED_FROM_PLAN' and new.quantity_is_declared then
    raise exception
      'este registro se asumió del plan: ninguno de sus renglones puede declararse como dicho por una persona'
      using errcode = 'check_violation';
  end if;

  perform app.assert_finite(new.quantity, 'la cantidad comida');

  -- NADIE COME MÁS DE LO QUE SALIÓ EN ESA PORCIÓN.
  --
  -- Hallazgo B3 de los ataques del sprint: declarar que se comió 5.000 g de una
  -- porción de 200 g se aceptaba sin chistar, y ese número entraba al eje
  -- ACTUAL y de ahí a la nutrición real de una persona. Si de verdad repitió,
  -- eso es OTRA porción servida, no un número más grande sobre esta.
  --
  -- Solo se compara cuando la unidad y la base física CALZAN: un renglón
  -- declarado en unidades contra un servido en gramos no se convierte a la
  -- fuerza. Convertirlo con un factor inventado pondría un tope falso sobre una
  -- declaración legítima, que es peor que no tener tope.
  --
  -- Se suma lo ya insertado en ESTE mismo registro para el mismo renglón: el
  -- trigger corre fila por fila, y sin la suma bastaba partir los 5.000 g en
  -- veinticinco renglones de 200 para pasar igual.
  if new.serving_record_item_id is not null and new.quantity is not null then
    declare
      v_it public.meal_serving_record_items;
      v_tope numeric;
      v_ya numeric;
    begin
      select * into v_it from public.meal_serving_record_items
      where id = new.serving_record_item_id;
      if v_it.id is not null
         and new.unit = v_it.served_unit
         and new.weight_basis = v_it.served_weight_basis then
        select coalesce(sum(quantity), 0) into v_ya
        from public.intake_log_items
        where log_id = new.log_id
          and serving_record_item_id = new.serving_record_item_id
          and quantity is not null
          and unit = v_it.served_unit
          and weight_basis = v_it.served_weight_basis;
        v_tope := greatest(v_it.served_quantity - v_it.discarded_quantity, 0);
        if v_ya + new.quantity > v_tope + 0.001 then
          raise exception
            'no se puede declarar % % comidos de una porción que sirvió % (ya van % declarados). Si repitió, sirve otra porción: eso es un segundo servido, no un número más grande sobre este',
            new.quantity, new.unit, v_it.served_quantity, v_ya
            using errcode = 'check_violation';
        end if;
      end if;
    end;
  end if;

  return new;
end;
$$;

create trigger intake_log_items_guard
  before insert on public.intake_log_items
  for each row execute function app.intake_item_guard();

-- ---------------------------------------------------------------------------
-- 6. RLS: solo lectura, y la MISMA llave que el registro del que cuelga
-- ---------------------------------------------------------------------------
--
-- `consumption_logs` ya trae su policy de lectura desde 0011:203
-- (`app.is_household_member`) y no se toca: cambiarla acá le sacaría o le daría
-- visibilidad a pantallas que ya existen, en una migración que no habla de eso.
--
-- Los renglones llevan LA MISMA llave que su log, y eso es deliberado. La
-- tentación era ponerles `app.can_access_member`, más estricta. Sería un error
-- de este sprint en particular: un log VISIBLE cuyos renglones son INVISIBLES
-- se lee exactamente como "esta persona no comió nada" — el vacío leído como
-- cero, que es justo la mentira que esta migración existe para impedir. Si
-- mañana este dato tiene que ser más privado, se cierran los DOS juntos.

alter table public.intake_log_items enable row level security;

create policy intake_log_items_select on public.intake_log_items
  for select to authenticated
  using (exists (
    select 1 from public.consumption_logs l
    where l.id = log_id and app.is_household_member(l.household_id)
  ));

-- Defensa en profundidad, misma línea que `audit_events` (0001:111) y que
-- `meal_serving_clinical_context` (0036): la RLS ya bloquea la escritura porque
-- no existe policy que la permita, pero el privilegio tampoco tiene por qué
-- estar. Los RPC no se enteran: corren SECURITY DEFINER como dueño.
revoke insert, update, delete on public.intake_log_items from anon, authenticated;
revoke insert, update, delete on public.consumption_logs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Helpers internos (esquema `app`: PostgREST no los expone)
-- ---------------------------------------------------------------------------

/**
 * Quién está declarando, y por lo tanto de qué clase es el dato.
 *
 * El cliente NO elige el `source`: se deriva del actor. Si quien declara es la
 * misma persona que comió, es DECLARED_SELF; si es otra (la mamá anotando lo
 * del niño), es DECLARED_CAREGIVER. Así, "lo asumido nunca se confunde con lo
 * declarado" deja de depender de que el cliente mande bien un parámetro:
 * ASSUMED_FROM_PLAN solo lo puede estampar `assume_intake_from_plan`.
 */
create or replace function app.declared_intake_source(
  p_actor_member uuid,
  p_member_id    uuid
) returns public.intake_source language plpgsql immutable as $$
begin
  if p_actor_member is null then
    -- Una declaración necesita un declarante. Sin integrante detrás de la
    -- sesión no hay quién afirme nada, y afirmarlo igual sería fabricar el dato.
    raise exception 'no autorizado';
  end if;
  if p_actor_member = p_member_id then
    return 'DECLARED_SELF'::public.intake_source;
  end if;
  return 'DECLARED_CAREGIVER'::public.intake_source;
end;
$$;

/**
 * LA CLAVE DE IDEMPOTENCIA NO SE ACEPTA CRUDA: SE COMPONE ACÁ.
 *
 * Por qué no basta con filtrar por hogar al buscarla. Acotar la BÚSQUEDA cierra
 * el salto entre casas, pero deja abierta la otra mitad del mismo agujero: un
 * cliente que reusa la misma clave para dos actos DISTINTOS de su propia casa
 * pierde el segundo en silencio, porque la función cree que ya lo escribió. Y
 * el eje ACTUAL perdido en silencio es justo lo que esta migración existe para
 * impedir — un hueco que después se lee como un cero.
 *
 * Entonces la clave se arma así:
 *
 *     PREFIJO : hogar : ancla-del-acto [ : discriminador-del-cliente ]
 *
 * El hogar y el ancla los pone el SERVIDOR, que es el único que los sabe de
 * verdad: el ancla es el hecho del que la declaración cuelga (el servido, o
 * persona + día + comida cuando no hay servido detrás). El cliente controla
 * únicamente el discriminador, y un discriminador solo puede distinguir
 * INTENTOS DENTRO DE UN MISMO ANCLA — que es exactamente, y nada más que, lo
 * que un token de reintento necesita poder hacer.
 *
 * Y no se puede forjar el ancla desde el discriminador: todos los segmentos del
 * ancla son de largo fijo (uuid, fecha ISO, valor de enum), así que un sufijo
 * libre jamás produce la clave de otro ancla. Igual se le acota el largo y se
 * le prohíben los caracteres de control: lo que entra por PostgREST se valida.
 */
create or replace function app.intake_dedupe_key(
  p_prefijo       text,
  p_household     uuid,
  p_ancla         text,
  p_discriminador text
) returns text language plpgsql immutable as $$
declare v_disc text;
begin
  v_disc := nullif(trim(coalesce(p_discriminador, '')), '');
  if v_disc is not null then
    if char_length(v_disc) > 120 then
      raise exception 'la clave de reintento no puede pasar de 120 caracteres'
        using errcode = 'check_violation';
    end if;
    if v_disc ~ '[[:cntrl:]]' then
      raise exception 'la clave de reintento no puede traer caracteres de control'
        using errcode = 'check_violation';
    end if;
  end if;
  return p_prefijo || ':' || p_household::text || ':' || p_ancla
         || coalesce(':' || v_disc, '');
end;
$$;

/**
 * La declaración VIVA de este hogar con esta clave, si existe.
 *
 * Las dos condiciones son la corrección de las dos fallas, y ninguna se puede
 * soltar:
 *
 *   · `household_id`: la clave se busca SIEMPRE dentro de la casa. Ni siquiera
 *     con la clave ya compuesta se confía en que el prefijo alcance.
 *   · `status = 'ACTIVE'`: un ACTIVE con la misma clave es un reintento y se
 *     devuelve tal cual. Un CORRECTED o un VOIDED NO ES UN REINTENTO — es
 *     alguien que anuló o corrigió y está volviendo a declarar. Eso tiene que
 *     escribir una fila nueva, y el índice parcial de arriba deja que quepa.
 */
create or replace function app.live_intake_by_key(
  p_household uuid,
  p_key       text
) returns uuid language sql stable security definer set search_path = public as $$
  select id from public.consumption_logs
  where household_id = p_household
    and dedupe_key = p_key
    and status = 'ACTIVE'
  limit 1;
$$;

/**
 * Escribe los renglones de un log a partir del jsonb del cliente.
 *
 * Valida CADA campo, porque este jsonb entra por PostgREST: los uuid se
 * verifican contra el log (jamás se confía en que el cliente mande ids de su
 * propia casa), el `extent` se verifica contra el enum con un mensaje que se
 * entiende, y los números pasan por `app.assert_finite` — un 'NaN'::numeric
 * pasa cualquier `>= 0` sin inmutarse (0011:214).
 *
 * Forma de cada renglón:
 *   { serving_record_item_id?, label, ingredient_id?, product_id?,
 *     extent, quantity?, unit?, weight_basis?, quantity_is_declared?,
 *     extent_engine_version?, nutrition?, nutrition_completeness? }
 */
create or replace function app.write_intake_items(
  p_log_id uuid,
  p_items  jsonb
) returns int language plpgsql security definer set search_path = public as $$
declare
  v_x jsonb;
  v_n int := 0;
  v_extent text;
  v_cant numeric;
  v_declarada boolean;
begin
  for v_x in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_extent := upper(nullif(trim(coalesce(v_x->>'extent', '')), ''));
    if v_extent is null then
      raise exception 'cada renglón declarado tiene que decir cuánto se comió (extent)'
        using errcode = 'check_violation';
    end if;
    if v_extent not in ('EXACT','ALL','MOST','HALF','LITTLE','NONE','UNKNOWN') then
      raise exception 'no existe la extensión "%": son EXACT, ALL, MOST, HALF, LITTLE, NONE o UNKNOWN',
        v_extent using errcode = 'check_violation';
    end if;

    v_cant := nullif(v_x->>'quantity', '')::numeric;
    perform app.assert_finite(v_cant, 'la cantidad comida');

    -- Si no viene el booleano, el número NO se da por declarado. El default
    -- seguro es el que no le atribuye a una persona algo que no dijo.
    v_declarada := coalesce((nullif(v_x->>'quantity_is_declared', ''))::boolean, false);

    insert into public.intake_log_items (
      log_id, serving_record_item_id, label, ingredient_id, product_id,
      extent, quantity, unit, weight_basis,
      quantity_is_declared, extent_engine_version,
      frozen_nutrition, nutrition_completeness, sort_order
    ) values (
      p_log_id,
      nullif(v_x->>'serving_record_item_id', '')::uuid,
      coalesce(nullif(trim(coalesce(v_x->>'label', '')), ''), 'sin etiqueta'),
      nullif(v_x->>'ingredient_id', '')::uuid,
      nullif(v_x->>'product_id', '')::uuid,
      v_extent::public.intake_extent,
      v_cant,
      nullif(v_x->>'unit', ''),
      nullif(v_x->>'weight_basis', '')::public.weight_basis,
      v_declarada,
      nullif(trim(coalesce(v_x->>'extent_engine_version', '')), ''),
      -- '{}' = NO SE CONGELÓ. Nunca "cero calorías": el motor tiene que poder
      -- distinguir un plato sin datos de un plato sin calorías.
      coalesce(v_x->'nutrition', '{}'::jsonb),
      coalesce(v_x->'nutrition_completeness', '{}'::jsonb),
      coalesce(nullif(v_x->>'sort_order', '')::int, v_n + 1)
    );
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. RPC: declarar lo que se comió de una porción SERVIDA
-- ---------------------------------------------------------------------------

/**
 * "De lo que salió a la mesa, comió esto."
 *
 * Es el camino normal: primero `serve_meal_assignment` (0036) sacó la comida de
 * la despensa, y después una persona dice cuánto se comió. Este RPC NO TOCA
 * INVENTARIO — ni cuando la persona dice que no comió nada. Que la comida haya
 * salido del refrigerador ya ocurrió y ya está anotado; si sobró y volvió, eso
 * es `return_serving_to_inventory`, y si se botó, `discard_serving`. El sistema
 * no adivina cuál de las dos pasó a partir de un "comí la mitad".
 *
 * `p_items` NULL no es "no comió": es "declaró que comió, sin decir cuánto". Se
 * escribe un renglón por cada renglón servido con extent UNKNOWN y cantidad
 * NULL. Es la declaración más común de una familia real y tiene que ser barata.
 *
 * Idempotente por `dedupe_key`: reintentar devuelve el mismo id y no duplica
 * nada.
 */
create or replace function public.log_intake(
  p_serving_record_id uuid,
  p_items             jsonb default null,
  p_notes             text default null,
  p_dedupe_key        text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_rec public.meal_serving_records;
  v_actor uuid;
  v_source public.intake_source;
  v_key text;
  v_log uuid;
  v_vivo uuid;
  v_intrusos text;
  v_items jsonb;
begin
  select * into v_rec from public.meal_serving_records
  where id = p_serving_record_id for update;

  if v_rec.id is null or not app.is_household_member(v_rec.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_rec.status <> 'ACTIVE' then
    raise exception 'ese servido está anulado: no hay de qué declarar consumo'
      using errcode = 'check_violation';
  end if;

  v_actor  := app.current_member_id(v_rec.household_id);
  v_source := app.declared_intake_source(v_actor, v_rec.member_id);

  -- La clave no llega cruda del cliente: el servidor le antepone el hogar y el
  -- ancla (este servido), y del cliente solo se toma el discriminador. Ver la
  -- nota larga en `app.intake_dedupe_key`.
  v_key := app.intake_dedupe_key('INTAKE', v_rec.household_id,
                                 p_serving_record_id::text, p_dedupe_key);

  -- Se pregunta ANTES de escribir: chocar contra el índice único y traducir el
  -- error después es más frágil y da mensajes que nadie entiende. Y se pregunta
  -- SOLO POR LO VIVO: una fila anulada con esta clave no es un reintento.
  v_log := app.live_intake_by_key(v_rec.household_id, v_key);
  if v_log is not null then return v_log; end if;

  -- Si este servido YA tiene una declaración viva con OTRA clave (la corrección
  -- que superó a la primera, o una declaración hecha con otro discriminador),
  -- esto no es un reintento y tampoco cabe: el índice
  -- `intake_logs_serving_record_active_uniq` lo rebota igual, pero con un error
  -- de Postgres que no le dice nada a nadie. Se dice acá, con el nombre del
  -- camino que corresponde.
  select id into v_vivo from public.consumption_logs
  where serving_record_id = p_serving_record_id and status = 'ACTIVE';
  if v_vivo is not null then
    raise exception 'este servido ya tiene una declaración vigente: corrígela con correct_intake_log, o anúlala con void_intake_log antes de declarar de nuevo'
      using errcode = 'check_violation';
  end if;

  -- TODOS los uuid del cliente son de ESTE servido. Un id ajeno se rechaza sin
  -- decir si existe.
  select string_agg(distinct x.value->>'serving_record_item_id', ', ')
  into v_intrusos
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  where nullif(x.value->>'serving_record_item_id', '') is not null
    and not exists (
      select 1 from public.meal_serving_record_items i
      where i.id = (x.value->>'serving_record_item_id')::uuid
        and i.record_id = p_serving_record_id
    );
  if v_intrusos is not null then
    raise exception 'hay renglones declarados que no pertenecen a este servido: %', v_intrusos
      using errcode = 'check_violation';
  end if;

  insert into public.consumption_logs (
    household_id, member_id, assignment_id, projection_id, serving_record_id,
    kind, affects_inventory, source, status, consumed_on, meal_type,
    logged_by, notes, dedupe_key
  ) values (
    v_rec.household_id, v_rec.member_id, v_rec.assignment_id, v_rec.projection_id,
    p_serving_record_id,
    case when v_rec.kind = 'FROM_PLAN' then 'PLANNED' else 'OFF_PLAN' end,
    -- Hay servido detrás: esta comida SÍ salió de la despensa. El descuento lo
    -- hizo el servido, no este registro.
    true,
    v_source, 'ACTIVE'::public.intake_log_status,
    v_rec.served_on, v_rec.meal_type,
    v_actor, nullif(trim(coalesce(p_notes, '')), ''), v_key
  ) returning id into v_log;

  if p_items is null then
    -- "Comió, no dijo cuánto". UNKNOWN explícito por cada renglón servido: el
    -- hueco queda dicho y el motor sabe que no tiene número, en vez de creer
    -- que tiene un cero.
    select jsonb_agg(jsonb_build_object(
             'serving_record_item_id', i.id,
             'label', i.label,
             'ingredient_id', i.ingredient_id,
             'product_id', i.product_id,
             'extent', 'UNKNOWN',
             'sort_order', i.sort_order))
    into v_items
    from public.meal_serving_record_items i
    where i.record_id = p_serving_record_id;
    v_items := coalesce(v_items, '[]'::jsonb);
  else
    v_items := p_items;
  end if;

  perform app.write_intake_items(v_log, v_items);

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_rec.household_id, auth.uid(), 'INTAKE_LOGGED', 'consumption_log', v_log,
          jsonb_build_object('serving_record_id', p_serving_record_id,
                             'source', v_source::text));
  -- El outbox se dedupica por la FILA, jamás por la clave de reintento.
  -- `domain_events.dedupe_key` es único GLOBAL (0001:87) y desde hoy la misma
  -- clave puede volver después de una anulación: si el evento la reusara, la
  -- declaración nueva no emitiría NADA — el `on conflict do nothing` se la
  -- tragaría entera. El id del log es nuevo por fila, y el reintento legítimo
  -- ya salió por el `return` de arriba sin llegar acá.
  perform app.emit_event(v_rec.household_id, 'INTAKE_LOGGED', 'consumption_log',
    jsonb_build_object('log_id', v_log, 'member_id', v_rec.member_id,
                       'serving_record_id', p_serving_record_id),
    'INTAKE_LOGGED:' || v_log::text);

  return v_log;
end;
$$;

comment on function public.log_intake(uuid, jsonb, text, text) is
  'Declara lo que una persona comió de una porción SERVIDA. Nutricional: no '
  'mueve inventario. p_items NULL = "comió, no dijo cuánto" (UNKNOWN por '
  'renglón), que no es lo mismo que "no comió".';

-- ---------------------------------------------------------------------------
-- 9. RPC: asumir del plan — y que se vea que es un supuesto
-- ---------------------------------------------------------------------------

/**
 * "Nadie declaró nada; démoslo por comido."
 *
 * Existe porque el hogar real no anota todo, y un motor sin ninguna señal es
 * peor que un motor con una señal marcada como supuesto. Pero el supuesto queda
 * ETIQUETADO en tres lugares a la vez: `source = 'ASSUMED_FROM_PLAN'`,
 * `quantity_is_declared = false` en cada renglón, y la versión del motor que lo
 * produjo. Ninguna consulta lo puede confundir con una declaración, y el
 * trigger `app.intake_item_guard` impide que un renglón se declare a mano
 * adentro de un registro asumido.
 *
 * La cantidad que se asume es `deducted_quantity`, no `served_quantity`: lo que
 * REALMENTE salió de la despensa. Si hubo faltante, esos gramos nunca llegaron
 * al plato y suponer que se comieron sería inventar comida.
 *
 * Y si el renglón tiene merma declarada, esto NO se asume: alguien vio esa
 * comida en el plato y la botó, así que "se comió todo" es demostrablemente
 * falso. Se detiene y pide una declaración de verdad.
 */
create or replace function public.assume_intake_from_plan(
  p_serving_record_id uuid,
  p_engine_version    text default 'intake-extent/1.0.0',
  p_dedupe_key        text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_rec public.meal_serving_records;
  v_actor uuid;
  v_key text;
  v_log uuid;
  v_vivo uuid;
  v_botado text;
  v_items jsonb;
begin
  select * into v_rec from public.meal_serving_records
  where id = p_serving_record_id for update;

  if v_rec.id is null or not app.is_household_member(v_rec.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_rec.status <> 'ACTIVE' then
    raise exception 'ese servido está anulado: no hay de qué asumir consumo'
      using errcode = 'check_violation';
  end if;
  if nullif(trim(coalesce(p_engine_version, '')), '') is null then
    raise exception 'un supuesto tiene que decir qué motor lo produjo';
  end if;

  v_key := app.intake_dedupe_key('INTAKE-ASSUMED', v_rec.household_id,
                                 p_serving_record_id::text, p_dedupe_key);
  v_log := app.live_intake_by_key(v_rec.household_id, v_key);
  if v_log is not null then return v_log; end if;

  -- Mismo motivo que en `log_intake`: si ya hay una declaración viva de este
  -- servido, asumir encima no es un reintento. Y acá pesa el doble, porque un
  -- supuesto NO puede pisar algo que una persona declaró.
  select id into v_vivo from public.consumption_logs
  where serving_record_id = p_serving_record_id and status = 'ACTIVE';
  if v_vivo is not null then
    raise exception 'este servido ya tiene una declaración vigente: un supuesto no pisa lo que alguien declaró'
      using errcode = 'check_violation';
  end if;

  select string_agg(i.label, ', ') into v_botado
  from public.meal_serving_record_items i
  where i.record_id = p_serving_record_id and i.discarded_quantity > 0.001;

  if v_botado is not null then
    raise exception
      'este servido tiene merma declarada (%): alguien vio esa comida y la botó, así que no se puede asumir que se comió — usa log_intake y di cuánto',
      v_botado using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_rec.household_id);

  insert into public.consumption_logs (
    household_id, member_id, assignment_id, projection_id, serving_record_id,
    kind, affects_inventory, source, status, consumed_on, meal_type,
    logged_by, dedupe_key
  ) values (
    v_rec.household_id, v_rec.member_id, v_rec.assignment_id, v_rec.projection_id,
    p_serving_record_id,
    case when v_rec.kind = 'FROM_PLAN' then 'PLANNED' else 'OFF_PLAN' end,
    true,
    'ASSUMED_FROM_PLAN'::public.intake_source, 'ACTIVE'::public.intake_log_status,
    v_rec.served_on, v_rec.meal_type, v_actor, v_key
  ) returning id into v_log;

  select jsonb_agg(jsonb_build_object(
           'serving_record_item_id', i.id,
           'label', i.label,
           'ingredient_id', i.ingredient_id,
           'product_id', i.product_id,
           -- ALL = "se comió lo que había en el plato". Lo que había es lo que
           -- la despensa entregó (deducted), no lo que el plan pedía.
           'extent', 'ALL',
           'quantity', i.deducted_quantity,
           'unit', i.served_unit,
           'weight_basis', i.served_weight_basis,
           'quantity_is_declared', false,
           'extent_engine_version', trim(p_engine_version),
           'sort_order', i.sort_order))
  into v_items
  from public.meal_serving_record_items i
  where i.record_id = p_serving_record_id;

  perform app.write_intake_items(v_log, coalesce(v_items, '[]'::jsonb));

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_rec.household_id, auth.uid(), 'INTAKE_ASSUMED', 'consumption_log', v_log,
          jsonb_build_object('serving_record_id', p_serving_record_id,
                             'engine', trim(p_engine_version)));
  perform app.emit_event(v_rec.household_id, 'INTAKE_ASSUMED', 'consumption_log',
    jsonb_build_object('log_id', v_log, 'member_id', v_rec.member_id),
    'INTAKE_ASSUMED:' || v_log::text);

  return v_log;
end;
$$;

comment on function public.assume_intake_from_plan(uuid, text, text) is
  'Da por comido lo que salió a la mesa, marcándolo como SUPUESTO en tres '
  'lugares (source, quantity_is_declared y la versión del motor). Se niega a '
  'asumir cuando hay merma declarada: eso ya se sabe que no se comió.';

-- ---------------------------------------------------------------------------
-- 10. RPC: comí algo que no estaba en el plan / comí fuera de casa
-- ---------------------------------------------------------------------------
--
-- SON DOS CASOS DISTINTOS Y NO SE MEZCLAN:
--
--   · Comida no planificada que SÍ salió de esta despensa (me hice un sándwich)
--     ya tiene su camino físico: `serve_off_plan` (0036) descuenta, y después
--     `log_intake` sobre ESE registro declara cuánto se comió. Este RPC no es
--     para eso.
--   · `log_intake_off_plan` es para lo que se comió en casa SIN salir de la
--     despensa registrada: lo que trajo la vecina, la torta del cumpleaños.
--   · `log_intake_away` es comer fuera de casa. Nutricionalmente cuenta;
--     para la despensa NO EXISTE, y por eso nunca puede terminar sumando a la
--     lista de compras.
--
-- Los dos comparten que `affects_inventory = false` y `serving_record_id` NULL:
-- no hay nada que reponer porque nada salió de acá.

create or replace function app.create_unplanned_intake(
  p_member_id  uuid,
  p_kind       text,
  p_items      jsonb,
  p_consumed_on date,
  p_meal_type  public.meal_type,
  p_notes      text,
  p_dedupe_key text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_actor uuid;
  v_source public.intake_source;
  v_dia date;
  v_key text;
  v_log uuid;
  v_ajenos text;
begin
  v_household := app.member_household(p_member_id);
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'declarar comida fuera del plan exige decir QUÉ se comió'
      using errcode = 'check_violation';
  end if;

  -- Ningún renglón de acá puede colgar de un servido: si colgara, habría un
  -- efecto físico detrás y este no es el RPC para eso. El guard lo rebotaría
  -- igual; el mensaje acá dice qué hacer en vez de decir "no autorizado".
  select string_agg(distinct x.value->>'serving_record_item_id', ', ') into v_ajenos
  from jsonb_array_elements(p_items) x
  where nullif(x.value->>'serving_record_item_id', '') is not null;
  if v_ajenos is not null then
    raise exception
      'esta comida no salió de la despensa: si sí salió, sírvela con serve_off_plan y después declárala con log_intake'
      using errcode = 'check_violation';
  end if;

  v_actor  := app.current_member_id(v_household);
  v_source := app.declared_intake_source(v_actor, p_member_id);

  -- El día del HOGAR por omisión. Se acepta uno pasado (anotar la once de ayer
  -- es lo normal) pero no uno futuro: nadie declara lo que todavía no comió.
  v_dia := coalesce(p_consumed_on, app.household_today(v_household));
  if v_dia > app.household_today(v_household) then
    raise exception 'no se puede declarar comida de un día que todavía no llega'
      using errcode = 'check_violation';
  end if;

  -- Acá no hay servido detrás, así que el ancla del acto es la persona + el día
  -- del hogar + la comida. El discriminador por omisión es el md5 de lo que se
  -- declaró: dos onces distintas del mismo día son dos actos distintos y tienen
  -- que caber las dos. Si el cliente manda el suyo, reemplaza al md5 — pero
  -- NUNCA al ancla, así que reusar una clave jamás puede tapar otro acto.
  v_key := app.intake_dedupe_key(
             'INTAKE-' || p_kind, v_household,
             p_member_id::text || ':' || v_dia::text || ':' ||
               coalesce(p_meal_type::text, '-'),
             coalesce(nullif(trim(coalesce(p_dedupe_key, '')), ''), md5(p_items::text)));

  v_log := app.live_intake_by_key(v_household, v_key);
  if v_log is not null then return v_log; end if;

  insert into public.consumption_logs (
    household_id, member_id, kind, affects_inventory, source, status,
    consumed_on, meal_type, logged_by, notes, dedupe_key
  ) values (
    v_household, p_member_id, p_kind,
    -- NO salió de esta despensa: nada que descontar, nada que reponer.
    false,
    v_source, 'ACTIVE'::public.intake_log_status,
    v_dia, p_meal_type, v_actor,
    nullif(trim(coalesce(p_notes, '')), ''), v_key
  ) returning id into v_log;

  perform app.write_intake_items(v_log, p_items);

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_household, auth.uid(), 'INTAKE_LOGGED', 'consumption_log', v_log,
          jsonb_build_object('kind', p_kind, 'source', v_source::text));
  perform app.emit_event(v_household, 'INTAKE_LOGGED', 'consumption_log',
    jsonb_build_object('log_id', v_log, 'member_id', p_member_id, 'kind', p_kind),
    'INTAKE_LOGGED:' || v_log::text);

  return v_log;
end;
$$;

/** Comió en casa algo que no salió de la despensa registrada. */
create or replace function public.log_intake_off_plan(
  p_member_id   uuid,
  p_items       jsonb,
  p_consumed_on date default null,
  p_meal_type   public.meal_type default null,
  p_notes       text default null,
  p_dedupe_key  text default null
) returns uuid language plpgsql security definer set search_path = public as $$
begin
  return app.create_unplanned_intake(
    p_member_id, 'OFF_PLAN', p_items, p_consumed_on, p_meal_type, p_notes, p_dedupe_key);
end;
$$;

/** Comió fuera de casa. Cuenta para la nutrición; para la despensa no existe. */
create or replace function public.log_intake_away(
  p_member_id   uuid,
  p_items       jsonb,
  p_consumed_on date default null,
  p_meal_type   public.meal_type default null,
  p_notes       text default null,
  p_dedupe_key  text default null
) returns uuid language plpgsql security definer set search_path = public as $$
begin
  return app.create_unplanned_intake(
    p_member_id, 'AWAY', p_items, p_consumed_on, p_meal_type, p_notes, p_dedupe_key);
end;
$$;

comment on function public.log_intake_away(uuid, jsonb, date, public.meal_type, text, text) is
  'Comida fuera de casa: cuenta nutricionalmente y NO toca inventario. No es '
  'lo mismo que fuera de plan — acá no hay despensa detrás que reponer.';

-- ---------------------------------------------------------------------------
-- 11. RPC: corregir — que es SUPERAR, no reescribir
-- ---------------------------------------------------------------------------

/**
 * "Me equivoqué: en realidad comió otra cosa."
 *
 * La fila anterior NO se toca: pasa a CORRECTED y queda a la vista con todo lo
 * que decía. La versión nueva nace apuntándola con `supersedes_log_id`, así que
 * la cadena entera se puede recorrer y auditar. Nadie puede mirar el registro
 * de hoy y creer que es lo que siempre dijo.
 *
 * Y no mueve un gramo de inventario, tampoco al corregir a la baja: corregir
 * una DECLARACIÓN no cambia el hecho de que la comida salió de la despensa. Si
 * lo que hay que corregir es lo SERVIDO, eso es `correct_serving_item` (0036),
 * que es otro hecho, con otro dueño y otro RPC.
 *
 * `p_correction_id` permite reintentar la misma corrección sin duplicarla.
 */
create or replace function public.correct_intake_log(
  p_log_id        uuid,
  p_items         jsonb,
  p_reason        text,
  p_correction_id uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_old public.consumption_logs;
  v_actor uuid;
  v_source public.intake_source;
  v_corr uuid;
  v_key text;
  v_new uuid;
  v_intrusos text;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'corregir exige decir por qué: una corrección muda es historia borrada';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'corregir exige decir qué se comió en realidad'
      using errcode = 'check_violation';
  end if;

  select * into v_old from public.consumption_logs where id = p_log_id for update;
  if v_old.id is null or not app.is_household_member(v_old.household_id) then
    raise exception 'no autorizado';
  end if;
  -- `p_correction_id` lo elige el cliente, así que la clave se compone acá
  -- adentro, anclada al HOGAR y al log que se corrige: mandar el id de
  -- corrección de otra casa no puede devolver —ni tapar— absolutamente nada.
  v_corr := coalesce(p_correction_id, gen_random_uuid());
  v_key  := app.intake_dedupe_key('INTAKE-CORR', v_old.household_id,
                                  p_log_id::text, v_corr::text);

  -- Y se pregunta ANTES del chequeo de estado, no después. Al reintentar una
  -- corrección que sí había llegado, la fila vieja YA quedó en CORRECTED:
  -- preguntar después haría que el segundo clic reventara con "ya fue superada"
  -- en vez de devolver la corrección que la persona acaba de hacer.
  v_new := app.live_intake_by_key(v_old.household_id, v_key);
  if v_new is not null then return v_new; end if;

  if v_old.status <> 'ACTIVE' then
    raise exception 'esa declaración ya está % : corrige la versión vigente',
      lower(v_old.status::text) using errcode = 'check_violation';
  end if;

  -- Los renglones enlazados siguen teniendo que ser del MISMO servido: corregir
  -- no es cambiar de porción.
  if v_old.serving_record_id is not null then
    select string_agg(distinct x.value->>'serving_record_item_id', ', ')
    into v_intrusos
    from jsonb_array_elements(p_items) x
    where nullif(x.value->>'serving_record_item_id', '') is not null
      and not exists (
        select 1 from public.meal_serving_record_items i
        where i.id = (x.value->>'serving_record_item_id')::uuid
          and i.record_id = v_old.serving_record_id
      );
    if v_intrusos is not null then
      raise exception 'hay renglones que no pertenecen a este servido: %', v_intrusos
        using errcode = 'check_violation';
    end if;
  end if;

  v_actor  := app.current_member_id(v_old.household_id);
  -- La corrección la declara QUIEN CORRIGE, aunque lo que se corrige fuera un
  -- supuesto: una corrección siempre es alguien afirmando algo. Un registro
  -- corregido deja de ser ASSUMED_FROM_PLAN, y tiene que dejar de serlo — si no,
  -- el motor seguiría tratando como supuesto un dato que una persona revisó.
  v_source := app.declared_intake_source(v_actor, v_old.member_id);

  -- PRIMERO se cierra la vieja y DESPUÉS nace la nueva: los índices únicos
  -- parciales de porción y de servido son sobre status='ACTIVE', así que en el
  -- orden inverso la nueva chocaría con la que todavía está viva.
  update public.consumption_logs
  set status = 'CORRECTED'::public.intake_log_status, corrected_at = now()
  where id = p_log_id;

  insert into public.consumption_logs (
    household_id, member_id, assignment_id, projection_id, serving_record_id,
    kind, affects_inventory, source, status, consumed_on, meal_type,
    logged_by, notes, supersedes_log_id, correction_reason, dedupe_key
  ) values (
    v_old.household_id, v_old.member_id, v_old.assignment_id, v_old.projection_id,
    v_old.serving_record_id, v_old.kind, v_old.affects_inventory,
    v_source, 'ACTIVE'::public.intake_log_status,
    v_old.consumed_on, v_old.meal_type, v_actor, v_old.notes,
    p_log_id, trim(p_reason), v_key
  ) returning id into v_new;

  perform app.write_intake_items(v_new, p_items);

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_old.household_id, auth.uid(), 'INTAKE_CORRECTED', 'consumption_log', v_new,
          jsonb_build_object('supersedes', p_log_id, 'reason', trim(p_reason)));
  perform app.emit_event(v_old.household_id, 'INTAKE_CORRECTED', 'consumption_log',
    jsonb_build_object('log_id', v_new, 'supersedes', p_log_id,
                       'member_id', v_old.member_id),
    'INTAKE_CORRECTED:' || v_new::text);

  return v_new;
end;
$$;

comment on function public.correct_intake_log(uuid, jsonb, text, uuid) is
  'Corregir NO reescribe: la fila anterior queda CORRECTED y a la vista, y la '
  'nueva la supera apuntándola. Cero efecto sobre el inventario.';

-- ---------------------------------------------------------------------------
-- 12. RPC: anular — "esto nunca lo dijo nadie"
-- ---------------------------------------------------------------------------

/**
 * Anular una declaración es decir que la AFIRMACIÓN no debió existir (se anotó
 * en la persona equivocada, se anotó dos veces). NO es decir que no comió: para
 * eso hay un extent que se llama NONE, y son cosas distintas.
 *
 * Es lo que `void_serving_record` (0036) exige que se haga primero cuando se
 * quiere anular un servido que ya tiene consumo declarado encima.
 *
 * No toca inventario. La comida salió de la despensa igual, y borrar lo que
 * alguien dijo no la devuelve al refrigerador.
 */
create or replace function public.void_intake_log(
  p_log_id uuid,
  p_reason text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_log public.consumption_logs;
  v_actor uuid;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'anular una declaración exige decir por qué';
  end if;

  select * into v_log from public.consumption_logs where id = p_log_id for update;
  if v_log.id is null or not app.is_household_member(v_log.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_log.status = 'VOIDED' then return; end if;   -- idempotente
  if v_log.status = 'CORRECTED' then
    raise exception 'esa declaración ya fue superada por una corrección: anula la versión vigente'
      using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_log.household_id);

  update public.consumption_logs
  set status = 'VOIDED'::public.intake_log_status,
      void_reason = trim(p_reason), voided_at = now(), voided_by = v_actor
  where id = p_log_id;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_log.household_id, auth.uid(), 'INTAKE_VOIDED', 'consumption_log', p_log_id,
          jsonb_build_object('reason', trim(p_reason)));
  perform app.emit_event(v_log.household_id, 'INTAKE_VOIDED', 'consumption_log',
    jsonb_build_object('log_id', p_log_id, 'member_id', v_log.member_id),
    'INTAKE_VOIDED:' || p_log_id::text);
end;
$$;

comment on function public.void_intake_log(uuid, text) is
  'Anula la AFIRMACIÓN, no el hecho de comer: "esto no debió anotarse". Que '
  'alguien no comió se dice con extent NONE, que es otra cosa. Sin efecto '
  'físico: borrar lo dicho no devuelve la comida al refrigerador.';
