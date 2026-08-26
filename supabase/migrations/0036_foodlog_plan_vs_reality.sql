-- Sprint 12 — FoodLog (parte 1): congelar el plan y dejar UN SOLO dueño del
-- efecto físico.
--
-- PRINCIPIO RECTOR: tres hechos distintos = tres tablas distintas = tres
-- dueños distintos.
--
--   · PLAN (mutable hasta que se sirve) — `member_serving_projections` +
--     `member_serving_components` (0005/0007). Esta migración NO les cambia
--     ni una columna: siguen siendo el plan, y el plan puede reescribirse.
--   · SERVIDO (físico, inmutable) — `meal_serving_records` +
--     `meal_serving_record_items`. Nacen acá. ÚNICO dueño del descuento. El
--     contexto CLÍNICO de lo servido no viaja con ellos: vive en
--     `meal_serving_clinical_context`, con la RLS médica y no la del hogar.
--   · REAL DECLARADO (nutricional, inmutable, sin efecto físico) —
--     `consumption_logs` (0011:179, reusada) + `intake_log_items`. Eso es
--     0034; acá no se toca.
--
-- Ninguna de las tres deriva de otra. Nunca se sobrescribe una con otra.
--
-- POR QUÉ ESTA MIGRACIÓN EXISTE (el problema concreto que cierra):
--
--  1. El plan de una comida NO se puede reescribir: reconfirmar BORRA todas
--     las proyecciones y las vuelve a insertar (0023:83, 0025:89), y
--     `unconfirm_meal_assignment` también las borra (0008:246). Mientras la
--     porción está PLANNED eso está bien — no ocurrió nada físico. Pero en el
--     momento en que sale comida de la despensa, `proposed_quantity` deja de
--     servir como registro de lo planificado: no es que se reescriba, es que
--     la fila DESAPARECE. Por eso el plan se CONGELA a nivel de porción y de
--     componente dentro del registro de servido.
--
--  2. Hoy existen DOS dueños silenciosos del descuento por comer:
--     `consume_planned_meal` (0023:307/344) y `use_lot` (0015:1040). Con un
--     FoodLog encima, un registro fuera de plan más un `use_lot` es un doble
--     descuento invisible. Después de esta migración el dueño es UNO.
--
--  3. La garantía anti-doble-descuento no puede ser un campo que el cliente
--     pueda omitir: es un TRIGGER sobre `inventory_movements`, con el mismo
--     peso que `app.apply_movement_to_lot` (0011:229) y
--     `app.ledger_is_append_only` (0011:277). Formulado para poder auditarlo:
--     descontar inventario por comer = escribir un renglón de servido. Si no
--     hay renglón, no hay descuento; si hay descuento, hay renglón.
--
--  4. Las guardas de historia enumeran estados ('SERVED','CONSUMED') en cinco
--     lugares distintos (0008:111, 0008:239, 0019:358, 0023:56, 0025:62) y
--     ninguna incluye CANCELLED. Con CANCELLED en uso eso pasaría a ser un
--     agujero real. Las guardas nuevas preguntan por la EXISTENCIA DEL
--     REGISTRO DE SERVIDO, no por el valor de un enum que mañana crece.
--
--  5. Los gramos que salieron de la despensa por un renglón servido vuelven
--     UNA sola vez. Corregir lo servido, devolverlo al refrigerador y
--     declararlo basura son tres caminos distintos para el MISMO saldo, y por
--     lo tanto tienen que gastarlo en común: si botar no descuenta
--     presupuesto, botar 200 y después devolver 200 saca la comida del
--     inventario una vez y la repone dos —la mitad de ella desde el basurero—.
--     El saldo se mide contra el LIBRO MAYOR (`app.movement_owner_guard`
--     puntos 5b y 8), no contra el espejo: un RPC futuro que se olvide de
--     mover la columna igual choca contra la pared.
--
-- No modifica ninguna migración congelada (última congelada: 0032).

-- ---------------------------------------------------------------------------
-- 0. Enums
-- ---------------------------------------------------------------------------
--
-- Nota de la trampa documentada en 0008:78: un valor de enum RECIÉN AGREGADO
-- con `alter type ... add value` no puede usarse como literal en la misma
-- transacción. Acá se usa `create type`, que no tiene esa restricción, pero
-- igual se mantiene la disciplina: estos valores solo aparecen como literales
-- dentro de CUERPOS de función (que se parsean al ejecutarse), nunca dentro de
-- un CHECK ni de un DEFAULT que el motor tenga que resolver ahora mismo.

/**
 * Todo lo que sale de la despensa para comerse es un ACTO DE SERVIR, tenga
 * plan detrás o no. Esa es la invariante que permite tener un solo dueño.
 */
create type public.serving_record_kind as enum ('FROM_PLAN', 'OFF_PLAN');

/**
 * De dónde viene la afirmación de que alguien comió. Lo ASUMIDO jamás se
 * confunde con lo DECLARADO, ni en la fila ni en el motor adaptativo.
 * (Se usa recién en 0034; se crea acá porque el enum es del sprint, no de la
 * tabla.)
 */
create type public.intake_source as enum
  ('DECLARED_SELF', 'DECLARED_CAREGIVER', 'ASSUMED_FROM_PLAN');

/**
 * Cuánto se comió, dicho como lo dice una persona. UNKNOWN ≠ NONE ≠ 0:
 * "no sé" no es "nada" y "nada" no es "cero gramos calculados".
 * La traducción extent → fracción vive en un motor versionado
 * (intake-extent/1.0.0), NUNCA en la base: cambiar la tabla mañana no puede
 * reescribir lo que se leyó ayer.
 */
create type public.intake_extent as enum
  ('EXACT', 'ALL', 'MOST', 'HALF', 'LITTLE', 'NONE', 'UNKNOWN');

/** Nada se borra: se supera (CORRECTED) o se anula (VOIDED). */
create type public.intake_log_status as enum ('ACTIVE', 'CORRECTED', 'VOIDED');

-- En `serving_status` NO se crea ningún valor nuevo: PLANNED/SERVED/SKIPPED
-- (0007:26) + CONSUMED/CANCELLED (0008:60-61) ya existen y alcanzan para el
-- eje completo. No hace falta ALTER TYPE.

-- ---------------------------------------------------------------------------
-- 1. `meal_serving_records` — "esto salió a la mesa"
-- ---------------------------------------------------------------------------
--
-- Es la única fila que AUTORIZA un descuento por consumo. Append-only: no se
-- edita ni se borra; anularla es un acto explícito y auditado.

create table public.meal_serving_records (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  member_id      uuid not null references public.household_members (id) on delete cascade,
  kind           public.serving_record_kind not null,

  -- NULL cuando es OFF_PLAN: no había plan detrás, y decirlo con un cero o un
  -- id inventado sería falsear el hecho.
  assignment_id  uuid references public.meal_assignments (id) on delete set null,
  projection_id  uuid references public.member_serving_projections (id) on delete set null,
  meal_type      public.meal_type,

  -- DATE-only en la zona horaria del HOGAR (`app.household_today`), jamás la
  -- del servidor ni la de la sesión.
  served_on      date not null,
  served_at      timestamptz not null default now(),
  served_by      uuid references public.household_members (id) on delete set null,

  -- PLAN CONGELADO A NIVEL DE PORCIÓN. Acá vive lo que el plan DECÍA en el
  -- instante en que la comida salió a la mesa. Después de esto, reconfirmar la
  -- comida borra las proyecciones y no se lleva nada: el planificado sobrevive.
  plan_frozen_at                timestamptz,
  plan_optimizer_version        text,
  plan_nutrition                jsonb not null default '{}'::jsonb,
  plan_completeness             jsonb not null default '{}'::jsonb,
  plan_event_effect             jsonb,
  plan_unverifiable_constraints jsonb not null default '[]'::jsonb,

  -- ACÁ NO HAY NINGÚN DATO CLÍNICO, NI SIQUIERA UN BOOLEANO.
  -- "A esta persona se le aplicó un techo clínico" YA ES un dato clínico:
  -- dice que existe una restricción confirmada y vigente. Esta tabla la lee
  -- cualquier integrante del hogar (`app.can_access_member`), mientras que la
  -- fuente `member_clinical_restrictions` exige `app.medical_access`
  -- (0027:266). Guardar el flag acá era darle el dato, sin permiso, a toda la
  -- casa. El hecho vive en `meal_serving_clinical_context` (más abajo).

  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'VOIDED')),
  void_reason text,
  voided_at   timestamptz,
  voided_by   uuid references public.household_members (id) on delete set null,
  notes       text,
  created_at  timestamptz not null default now(),

  -- Anular exige decir por qué: un VOIDED mudo es historia borrada con otro
  -- nombre.
  constraint serving_record_void_has_reason
    check ((status = 'VOIDED') = (voided_at is not null)),
  constraint serving_record_void_reason_text
    check (status <> 'VOIDED' or nullif(trim(coalesce(void_reason, '')), '') is not null)
);

-- Una porción se sirve UNA vez. El índice es PARCIAL sobre status='ACTIVE':
-- anular libera la porción, y volver a servir crea un registro NUEVO y limpio
-- en vez de resucitar el viejo.
create unique index serving_records_projection_uniq
  on public.meal_serving_records (projection_id)
  where projection_id is not null and status = 'ACTIVE';

create index serving_records_household_day_idx
  on public.meal_serving_records (household_id, served_on desc);
create index serving_records_member_day_idx
  on public.meal_serving_records (member_id, served_on desc);
create index serving_records_assignment_idx
  on public.meal_serving_records (assignment_id) where assignment_id is not null;

comment on table public.meal_serving_records is
  'Lo que salió a la mesa. Es el ÚNICO hecho que autoriza un descuento de '
  'inventario por comer, tenga plan detrás (FROM_PLAN) o no (OFF_PLAN). '
  'Append-only: se anula con void_serving_record, jamás se edita ni se borra.';
comment on column public.meal_serving_records.plan_nutrition is
  'Nutrición que el PLAN decía para esta porción, congelada al servir. '
  '{} significa "no se congeló", nunca "cero".';
comment on column public.meal_serving_records.plan_unverifiable_constraints is
  'SÓLO los límites sin verificar que son LOGÍSTICA (ENERGY_MAX, PROTEIN_MIN): '
  'faltó una ficha nutricional. Los que nombran una restricción clínica se '
  'congelan aparte, en meal_serving_clinical_context, porque esta tabla la lee '
  'todo el hogar y aquélla exige app.medical_access.';

-- ---------------------------------------------------------------------------
-- 1 bis. `meal_serving_clinical_context` — el hecho clínico, con RLS médica
-- ---------------------------------------------------------------------------
--
-- POR QUÉ UNA TABLA APARTE Y NO UNA COLUMNA
--
-- El booleano "esta porción se calculó con un techo clínico" no es metadato
-- de logística: es la sombra de un diagnóstico. Quien lo lee deduce que esa
-- persona tiene una restricción clínica CONFIRMADA vigente ese día — justo lo
-- que `member_clinical_restrictions` protege con
-- `app.medical_access(member_id, 'VIEW_CLINICAL_RESTRICTIONS')` (0027:266).
-- Como columna de `meal_serving_records`, que se lee con
-- `app.can_access_member`, quedaba con RLS MÁS DÉBIL QUE SU FUENTE: cualquier
-- integrante del hogar, sin ningún grant médico, podía deducir la
-- restricción. Eso es una degradación de privacidad dentro de la propia casa.
--
-- Las otras dos salidas se descartaron con motivo:
--   · RLS POR COLUMNA: PostgreSQL no la tiene. Lo más parecido es el GRANT por
--     columna, que es por ROL y no por fila: no sabe distinguir a quien tiene
--     el grant médico de quien no, porque los dos entran como `authenticated`.
--     Y revocar la columna hace fallar cualquier `select *` de PostgREST.
--     Protección que no se sostiene.
--   · UNA VISTA: la vista no tapa la tabla. Mientras la columna siga en
--     `meal_serving_records`, PostgREST puede pedirla directo. Una vista solo
--     sirve si el dato ya no está en la tabla ancha — o sea, esto mismo.
--
-- LA PANTALLA Y EL MOTOR NO NECESITAN LO MISMO
--
-- La necesidad de este dato la tiene el MOTOR: al re-optimizar una porción ya
-- servida tiene que saber que se calculó con techo, o la re-optimiza sin él.
-- El motor corre como SECURITY DEFINER y lo lee por
-- `app.serving_clinical_ceiling`, sin pasar por RLS. La PANTALLA no lo
-- necesita para funcionar, así que lo ve únicamente quien tiene el permiso
-- médico. Separadas las dos rutas, la privacidad no le cuesta nada al motor.

create table public.meal_serving_clinical_context (
  record_id uuid primary key
    references public.meal_serving_records (id) on delete cascade,

  -- Duplicado A PROPÓSITO desde el registro de servido: la policy tiene que
  -- poder decidir sin salir de esta tabla. Ir a buscarlo a
  -- `meal_serving_records` sería apoyar la RLS fuerte sobre la débil. Un
  -- trigger lo deriva del registro, así que no es un dato que el llamador
  -- elija.
  member_id uuid not null
    references public.household_members (id) on delete cascade,

  -- SÍ/NO había un techo clínico vigente al servir. Nada más: ni el
  -- biomarcador, ni el valor, ni la restricción.
  had_clinical_ceiling boolean not null,

  -- Los límites SIN VERIFICAR del plan que NOMBRAN un nutriente bajo
  -- restricción clínica (`CLINICAL:<nutriente>`, ver `app.split_*` más abajo).
  -- Viven acá y no en `meal_serving_records.plan_unverifiable_constraints`
  -- porque dicen MÁS que el booleano de arriba: "CLINICAL:phosphorus_mg" no
  -- sólo delata que hay una restricción confirmada, delata CUÁL. Es el mismo
  -- dato que `member_clinical_restrictions` protege con `app.medical_access`
  -- (0027:266), y por lo tanto tiene que llevar la misma llave.
  --
  -- `[]` significa "no había ninguno", nunca "no se congeló": esta fila se
  -- escribe SIEMPRE, con lista vacía y con lista llena, por la misma razón que
  -- `had_clinical_ceiling` se escribe con true y con false — si la fila
  -- existiera sólo cuando hay algo, su existencia sería el dato.
  plan_clinical_constraints jsonb not null default '[]'::jsonb,

  computed_at timestamptz not null default now()
);

create index serving_clinical_context_member_idx
  on public.meal_serving_clinical_context (member_id);

comment on table public.meal_serving_clinical_context is
  'Contexto clínico congelado de una porción servida: SÍ/NO había techo, y qué '
  'límites CLÍNICOS quedaron sin verificar. Vive '
  'separada de meal_serving_records porque ES dato médico y lleva la MISMA '
  'RLS que su fuente (app.medical_access), no la del hogar. Se escribe '
  'SIEMPRE, con true y con false: si la fila existiera solo cuando es true, '
  'su mera existencia delataría la restricción.';

alter table public.meal_serving_clinical_context enable row level security;

-- LA MISMA llave que la fuente (0027:266), jamás una más débil. Sin policies
-- de escritura: se escribe solo por SECURITY DEFINER, como todo el resto.
create policy serving_clinical_context_select
  on public.meal_serving_clinical_context
  for select to authenticated
  using (app.medical_access(member_id, 'VIEW_CLINICAL_RESTRICTIONS'));

-- Defensa en profundidad, en la misma línea que `audit_events` (0001:111): la
-- RLS ya bloquea la escritura porque no existe policy que la permita, pero el
-- privilegio tampoco tiene por qué estar. Así, si alguien apagara la RLS por
-- error, esta tabla — que es dato médico — no queda abierta de par en par.
-- Los RPC no se enteran: corren SECURITY DEFINER como dueño de la tabla.
revoke insert, update, delete on public.meal_serving_clinical_context
  from anon, authenticated;
revoke select on public.meal_serving_clinical_context from anon;

/**
 * Deriva `member_id` del registro de servido en vez de creerle al llamador:
 * si la fila pudiera declarar un member_id ajeno, la RLS de esta tabla
 * apuntaría a la persona equivocada y el dato quedaría del lado incorrecto de
 * la pared médica.
 */
create or replace function app.serving_clinical_context_member_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_member uuid;
begin
  select member_id into v_member
  from public.meal_serving_records where id = new.record_id;
  if v_member is null then
    raise exception 'no existe el registro de servido';
  end if;
  new.member_id := v_member;
  return new;
end;
$$;

create trigger serving_clinical_context_member
  before insert on public.meal_serving_clinical_context
  for each row execute function app.serving_clinical_context_member_guard();

/**
 * Append-only, igual que el registro que acompaña: el contexto clínico de un
 * hecho pasado no se corrige a mano. Se borra SOLO por cascada (se borró el
 * hogar), y por eso el escape `pg_trigger_depth() > 1`, el mismo de
 * `app.ledger_is_append_only` (0011:277) y de
 * `app.serving_record_is_append_only`.
 */
create or replace function app.serving_clinical_context_is_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'el contexto clínico de lo servido es historia: no se borra';
  end if;
  raise exception 'el contexto clínico de lo servido es historia: no se edita';
end;
$$;

create trigger serving_clinical_context_append_only
  before update or delete on public.meal_serving_clinical_context
  for each row execute function app.serving_clinical_context_is_append_only();

/**
 * EL FILTRO AL CONGELAR: qué parte de `unverifiable_constraints` es logística y
 * qué parte es clínica.
 *
 * `member_serving_projections.unverifiable_constraints` (0025:20) es una lista
 * de etiquetas de texto que el optimizador arma con TRES formas distintas:
 *
 *   · 'ENERGY_MAX'  — el techo de energía no se pudo verificar porque falta la
 *     ficha nutricional de algún componente.
 *   · 'PROTEIN_MIN' — lo mismo con el piso de proteína.
 *   · 'CLINICAL:<nutriente>' — un TECHO CLÍNICO CONFIRMADO sobre ese nutriente
 *     que tampoco se pudo verificar.
 *
 * Las dos primeras son logística pura: TODA persona con objetivos tiene un
 * techo de energía y un piso de proteína, así que verlas sólo dice "faltó un
 * dato nutricional". La tercera es la sombra de un diagnóstico y dice MÁS que
 * el booleano `had_clinical_ceiling`: no sólo delata que hay una restricción
 * clínica confirmada y vigente, delata sobre QUÉ nutriente. 'CLINICAL:
 * phosphorus_mg' se lee solo.
 *
 * POR QUÉ LISTA BLANCA Y NO LISTA NEGRA. Sería más corto filtrar "todo lo que
 * empiece con CLINICAL:". Sería también la versión que se rompe sola: la
 * etiqueta clínica que se invente mañana con otro prefijo —o un elemento que ni
 * siquiera sea texto— caería del lado no médico por omisión, y el olvido se
 * pagaría con privacidad. Acá el olvido cae del lado seguro: lo que no está
 * explícitamente reconocido como logística viaja a la tabla con
 * `app.medical_access`. Es el mismo criterio de `app.is_fk_set_null_update`
 * (bloque 4 bis), donde la columna nueva que nadie recuerda queda protegida.
 *
 * Y NO SE GUARDA UN CONTADOR de lo filtrado. "Esta porción tenía 2 límites
 * clínicos sin verificar" es exactamente el dato que estamos sacando de la
 * tabla no médica, con un disfraz aritmético: la existencia de un techo clínico
 * más su cardinalidad. Del lado del hogar no queda ni el rastro de que hubo
 * algo que filtrar.
 */
create or replace function app.logistic_unverifiable_constraints(p_lista jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select coalesce(
    (select jsonb_agg(x.value order by x.ord)
     from jsonb_array_elements(
            case when jsonb_typeof(p_lista) = 'array' then p_lista else '[]'::jsonb end
          ) with ordinality as x(value, ord)
     where jsonb_typeof(x.value) = 'string'
       and (x.value #>> '{}') in ('ENERGY_MAX', 'PROTEIN_MIN')),
    '[]'::jsonb);
$$;

/**
 * El complemento exacto de la anterior: todo lo que NO quedó reconocido como
 * logística. Junto con `app.logistic_unverifiable_constraints` parte la lista
 * en dos sin perder ni duplicar un elemento — el congelado tiene que poder
 * reconstruirse, sólo que ahora hace falta el permiso médico para ver la mitad
 * que lo merece.
 */
create or replace function app.clinical_unverifiable_constraints(p_lista jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select coalesce(
    (select jsonb_agg(x.value order by x.ord)
     from jsonb_array_elements(
            case when jsonb_typeof(p_lista) = 'array' then p_lista else '[]'::jsonb end
          ) with ordinality as x(value, ord)
     where jsonb_typeof(x.value) <> 'string'
        or (x.value #>> '{}') not in ('ENERGY_MAX', 'PROTEIN_MIN')),
    '[]'::jsonb);
$$;

comment on function app.logistic_unverifiable_constraints(jsonb) is
  'La mitad LOGÍSTICA de unverifiable_constraints: sólo las etiquetas que toda '
  'persona puede tener (ENERGY_MAX, PROTEIN_MIN). Lista blanca a propósito: lo '
  'desconocido cae del lado médico, no del lado cómodo.';
comment on function app.clinical_unverifiable_constraints(jsonb) is
  'La mitad que NOMBRA una restricción clínica (CLINICAL:<nutriente>) más todo '
  'lo que no se reconoce. Va a meal_serving_clinical_context, con medical_access.';

/**
 * Congela el hecho clínico de una porción recién servida.
 *
 * Recibe el booleano YA calculado (`app.had_clinical_ceiling`) en vez de
 * calcularlo acá: así no depende de la capa clínica y puede vivir junto a su
 * tabla. Idempotente: si la fila ya está, no la reescribe (y no podría, por
 * el trigger append-only). No acepta NULL: "no se sabe" no se guarda como
 * false.
 *
 * `p_constraints` son los límites sin verificar que nombran una restricción
 * clínica. Tiene default `[]` porque servir FUERA DE PLAN no congela ningún
 * plan, y ahí la lista vacía es la verdad —no había plan que tuviera límites—,
 * no un valor de relleno.
 */
create or replace function app.freeze_clinical_ceiling(
  p_record_id   uuid,
  p_had         boolean,
  p_constraints jsonb default '[]'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_record_id is null then
    raise exception 'falta el registro de servido';
  end if;
  if p_had is null then
    raise exception 'el techo clínico se congela como true o false, nunca nulo';
  end if;
  -- `member_id` va NULL a propósito: lo estampa el trigger desde el registro.
  -- Pasarlo desde acá sería darle a alguien la chance de apuntar la RLS a
  -- otra persona.
  insert into public.meal_serving_clinical_context
    (record_id, member_id, had_clinical_ceiling, plan_clinical_constraints)
  values (
    p_record_id, null, p_had,
    case when jsonb_typeof(p_constraints) = 'array' then p_constraints
         else '[]'::jsonb end)
  on conflict (record_id) do nothing;
end;
$$;

/**
 * Lector DEL MOTOR, no de la pantalla: ¿esta porción se sirvió con techo
 * clínico? Es SECURITY DEFINER a propósito — el optimizador necesita el dato
 * para no re-optimizar sin el techo con que se calculó la porción, y nunca
 * devuelve nada del detalle clínico. Vive en el esquema `app`, que PostgREST
 * no expone: no es una puerta de atrás a la RLS de arriba.
 *
 * NULL = DESCONOCIDO (no se congeló el contexto), que NO es false. Quien
 * llame decide qué hacer con la duda; acá no se inventa un "no había techo"
 * que nadie verificó.
 */
create or replace function app.serving_clinical_ceiling(p_record_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select had_clinical_ceiling
  from public.meal_serving_clinical_context
  where record_id = p_record_id;
$$;

/**
 * Mismo lector, misma justificación, para los límites clínicos que el plan no
 * pudo verificar. El motor los necesita por la misma razón que necesita el
 * techo: re-optimizar una porción servida sin saber que su límite de fósforo
 * quedó SIN VERIFICAR es re-optimizarla como si estuviera verificado, y eso es
 * UNKNOWN convertido en NORMAL.
 *
 * NULL = DESCONOCIDO (no se congeló el contexto). `[]` = se congeló y no había
 * ninguno. Las dos cosas son distintas y el lector no las mezcla.
 */
create or replace function app.serving_clinical_constraints(p_record_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select plan_clinical_constraints
  from public.meal_serving_clinical_context
  where record_id = p_record_id;
$$;

-- ---------------------------------------------------------------------------
-- 2. `meal_serving_record_items` — un renglón por componente servido
-- ---------------------------------------------------------------------------

create table public.meal_serving_record_items (
  id         uuid primary key default gen_random_uuid(),
  record_id  uuid not null references public.meal_serving_records (id) on delete cascade,

  -- De dónde salió el renglón. `on delete set null` a propósito: el plan puede
  -- desaparecer (reconfirmación), lo servido no.
  serving_component_id uuid references public.member_serving_components (id) on delete set null,
  component_id         uuid references public.meal_slot_components (id) on delete set null,

  -- La etiqueta se congela SIEMPRE, igual que `inventory_lots.label` (0011):
  -- si el catálogo archiva el alimento, el renglón sigue sabiendo qué era.
  label text not null check (char_length(label) between 1 and 200),

  -- Identidad DUAL, mismo criterio que 0022: producto contra producto,
  -- alimento contra alimento, jamás la una a cuenta de la otra. `<= 1` y no
  -- `= 1` porque un lote de alta manual puede no tener identidad de catálogo
  -- (`add_manual_lot` con ingrediente NULL) y forzar una sería inventarla.
  ingredient_id uuid references public.ingredients (id) on delete set null,
  product_id    uuid references public.commercial_products (id) on delete set null,
  constraint serving_item_identity_dual
    check (num_nonnulls(ingredient_id, product_id) <= 1),

  -- PLAN CONGELADO A NIVEL DE COMPONENTE. Todo el bloque es NULL cuando el
  -- registro es OFF_PLAN: no había plan, y escribir 0 diría "el plan pedía
  -- cero", que es distinto de "no había plan". UNKNOWN ≠ ZERO también acá.
  -- La coherencia bloque↔kind la impone `app.serving_item_guard()`.
  planned_quantity       numeric(10, 3) check (planned_quantity >= 0),
  planned_unit           public.nutrition_basis_unit,
  planned_weight_basis   public.weight_basis,
  planned_cooking_method public.cooking_method,
  planned_added_fat_g    numeric(10, 3) check (planned_added_fat_g >= 0),
  planned_nutrition      jsonb not null default '{}'::jsonb,

  -- SERVIDO. `served_unit` es text con el dominio del LOTE ('G','ML','UNIT') y
  -- no `nutrition_basis_unit`: el plan vive en el dominio nutricional (G/ML),
  -- pero lo servido es físico y tiene que poder hablar la lengua de la
  -- despensa. Sin UNIT, un `use_lot` sobre un lote medido en unidades no
  -- tendría dónde escribirse y volvería a existir un segundo dueño.
  served_quantity     numeric(10, 3) not null check (served_quantity >= 0),
  served_unit         text not null check (served_unit in ('G', 'ML', 'UNIT')),
  served_weight_basis public.weight_basis not null,

  -- false = la cantidad se copió del plan congelado de ESTE mismo renglón.
  -- "De dónde salió ese número" queda en un booleano explícito en vez de
  -- deducirse de un NULL.
  served_quantity_is_declared boolean not null,

  -- DESCONTADO: espejo del libro mayor, en la unidad del renglón.
  -- Los mueve SOLO los RPC de esta migración.
  deducted_quantity  numeric(12, 3) not null default 0 check (deducted_quantity >= 0),
  shortfall_quantity numeric(12, 3) not null default 0 check (shortfall_quantity >= 0),
  reversed_quantity  numeric(12, 3) not null default 0 check (reversed_quantity >= 0),
  -- BOTADO: cuánto de lo que salió a la mesa se declaró basura. NO es una
  -- cuarta forma de descontar —el lote ya pagó al servir, ver `discard_serving`—
  -- sino el registro de que esos gramos YA NO PUEDEN VOLVER. Sin esta columna,
  -- botar 200 y después devolver 200 sacaba la comida del inventario UNA vez y
  -- la reponía DOS: el mismo alimento en el basurero y en la despensa al mismo
  -- tiempo.
  discarded_quantity numeric(12, 3) not null default 0 check (discarded_quantity >= 0),

  sort_order int not null default 1,
  created_at timestamptz not null default now(),

  -- No se puede botar más de lo que salió a la mesa. La tolerancia es la misma
  -- 0.001 con la que trabaja todo el espejo: una corrección a la baja puede
  -- dejar `served_quantity` a lo más un milésimo por debajo de lo ya botado.
  constraint serving_item_discard_within_served
    check (discarded_quantity <= served_quantity + 0.001)
);

create index serving_record_items_record_idx
  on public.meal_serving_record_items (record_id, sort_order);
create index serving_record_items_component_idx
  on public.meal_serving_record_items (serving_component_id)
  where serving_component_id is not null;
create index serving_record_items_ingredient_idx
  on public.meal_serving_record_items (ingredient_id) where ingredient_id is not null;
create index serving_record_items_product_idx
  on public.meal_serving_record_items (product_id) where product_id is not null;

comment on table public.meal_serving_record_items is
  'Un renglón por componente que salió a la mesa. EL dueño del efecto físico: '
  'todo movimiento CONSUMED del libro mayor cuelga de un renglón de acá.';
comment on column public.meal_serving_record_items.planned_quantity is
  'Lo que el plan pedía, congelado. NULL = no había plan (OFF_PLAN), nunca 0.';
comment on column public.meal_serving_record_items.deducted_quantity is
  'Lo que el libro mayor efectivamente sacó de la despensa por este renglón, '
  'ya neto de reversiones, en la unidad del renglón.';
comment on column public.meal_serving_record_items.discarded_quantity is
  'Lo que salió a la mesa y se declaró basura. Gasta el mismo saldo que las '
  'devoluciones: lo botado no puede volver de la basura al inventario.';

-- ---------------------------------------------------------------------------
-- 3. El enlace en el libro mayor (aditivo sobre 0011)
-- ---------------------------------------------------------------------------

alter table public.inventory_movements
  add column serving_record_item_id uuid
    references public.meal_serving_record_items (id) on delete set null,
  -- Cuánto del renglón SERVIDO cubre este movimiento, EN LA UNIDAD DEL
  -- RENGLÓN. Existe porque `delta` va en unidad del LOTE y el renglón puede ir
  -- en COOKED: en la conversión explícita cocido→crudo (0023:340) el delta es
  -- crudo y la cobertura es cruda × yield_factor. Sin esta columna, compensar
  -- una corrección obliga a recalcular el factor de ayer — y el factor cambia
  -- (`ingredient_yields` admite override por hogar y por método). Recalcularlo
  -- es exactamente "compensar una cantidad que el sistema no sabe", con mejor
  -- disfraz. Se guarda congelado al momento del descuento.
  add column covers_quantity numeric(12, 3),
  add column reverses_movement_id uuid
    references public.inventory_movements (id) on delete set null;

-- La cobertura y el renglón nacen JUNTOS: eso lo exige `app.movement_owner_guard`
-- en el INSERT, que es el único momento en que alguien escribe acá. El CHECK de
-- tabla es a propósito más débil en un sentido, y la razón es la misma que
-- explica el bloque 4 bis: cuando el renglón servido desaparece (se va del hogar
-- el integrante que comió), la acción referencial anula `serving_record_item_id`
-- y NO tiene forma de anular `covers_quantity` en el mismo UPDATE. Con el
-- bicondicional acá, ese borrado sería estructuralmente imposible. Con esta
-- versión, la cobertura sobrevive como historia huérfana — que es exactamente lo
-- que es: cuánto cubría ese movimiento de un renglón que ya no está.
alter table public.inventory_movements
  add constraint movements_covers_needs_item
  check (serving_record_item_id is null or covers_quantity is not null);

create index movements_serving_item_idx
  on public.inventory_movements (serving_record_item_id, created_at)
  where serving_record_item_id is not null;
create index movements_reverses_idx
  on public.inventory_movements (reverses_movement_id)
  where reverses_movement_id is not null;

comment on column public.inventory_movements.covers_quantity is
  'Cobertura del renglón servido, en la unidad del RENGLÓN (delta va en la '
  'unidad del LOTE). Mismo signo que delta: negativo saca de la despensa, '
  'positivo devuelve.';

-- CUÁNTO PESA LA MERMA DE LO SERVIDO, EN LA UNIDAD DEL LOTE.
--
-- La merma del plato se anota con `delta` 0 a propósito —esa comida ya salió
-- de la despensa cuando se sirvió, y restarla de nuevo sería el doble descuento
-- que esta migración existe para impedir (bloque 5 del candado)—. El costo de
-- esa decisión correcta era que el informe de desperdicio, que suma por
-- `delta`, no la veía: se botaba comida y el número decía cero. Justo la merma
-- más frecuente de una casa, la del plato, era la invisible.
--
-- Esta columna es ese peso escrito aparte: el informe lo suma, el inventario no
-- lo resta. No es `covers_quantity` con otro nombre — la cobertura va en la
-- unidad del RENGLÓN, que puede ser COOKED, y sumarla junto a la merma de la
-- despensa, que va en la del LOTE y puede ser RAW, sería sumar gramos cocidos
-- con gramos crudos. El factor se congela acá al botar, con el mismo criterio
-- que la cobertura: nadie tendrá que recalcular el rendimiento de ayer para
-- leer el informe de hoy.
--
-- Mismo signo que la cobertura: negativo bota, positivo anula una merma mal
-- declarada. El neto firmado es "cuánto de este renglón está en la basura",
-- medido en la lengua de la despensa.
alter table public.inventory_movements
  add column waste_lot_quantity numeric(12, 3);

comment on column public.inventory_movements.waste_lot_quantity is
  'Peso de la merma de lo SERVIDO en la unidad del LOTE, para que el informe de '
  'desperdicio la sume sin que el inventario la descuente dos veces (delta va '
  'en 0). NULL en todo movimiento que no sea merma de un renglón servido.';

-- EL DISCRIMINADOR ES LA COBERTURA, NO EL PUNTERO AL RENGLÓN, por la misma
-- razón que el CHECK de arriba: cuando el integrante que comió se va del hogar,
-- la acción referencial anula `serving_record_item_id` con un UPDATE y este
-- CHECK se revalida EN ESE UPDATE. Con el puntero adentro, borrar a un
-- integrante sería estructuralmente imposible; con la cobertura, la merma
-- huérfana sigue siendo merma y sigue pesando lo mismo.
--
-- El cero es un valor legítimo, no un desconocido: una merma que en unidad de
-- lote redondea a cero pesa cero en el informe. Lo que no puede pasar es que
-- FALTE. Sin esta pared, un escritor futuro que se olvide de la columna vuelve
-- a dejar la merma del plato invisible — que es exactamente el defecto que la
-- columna cierra, y se cierra con un CHECK y no con confianza.
alter table public.inventory_movements
  add constraint movements_waste_lot_qty_shape
  check (
    case
      when reason = 'DISCARDED_LEFTOVER' and covers_quantity is not null
        then waste_lot_quantity is not null
             and (waste_lot_quantity = 0
                  or sign(waste_lot_quantity) = sign(covers_quantity))
      else waste_lot_quantity is null
    end
  );

-- ---------------------------------------------------------------------------
-- 4. EL CANDADO ESTRUCTURAL: `app.movement_owner_guard()`
-- ---------------------------------------------------------------------------
--
-- Esta es la capa que DECIDE. No es una policy de RLS ni una validación de
-- aplicación: es un trigger sobre la tabla. Un RPC futuro escrito por alguien
-- que no leyó este documento choca contra él. Un cliente que omita un campo
-- choca contra él. PostgREST choca contra él.
--
-- Verificación del diseño: hoy los escritores de movimientos CONSUMED por
-- comer son exactamente dos (`consume_planned_meal` 0023:307/344 y `use_lot`
-- 0015:1040); después de esta migración es UNO. Los demás escritores
-- (`receive_shopping_list`, `adjust_lot`, `discard_lot`, split/merge/move,
-- `complete_prep_task`) no usan CONSUMED — prep usa TRANSFORM/PREP_LOSS/SPLIT
-- (0017:127-198) — y la guarda no los toca.

create or replace function app.movement_owner_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_item_household uuid;
  v_orig public.inventory_movements;
  v_revertido numeric;
  v_saldo numeric;
  v_servido numeric;
  v_botado numeric;
  v_sacado numeric;
  v_devuelto numeric;
begin
  perform app.assert_finite(new.covers_quantity, 'la cobertura del movimiento');

  -- (0) Renglón y cobertura nacen juntos. El bicondicional vive ACÁ y no en el
  --     CHECK de tabla (ver bloque 3): un CHECK de tabla también tendría que
  --     seguir siendo cierto DESPUÉS de que la acción referencial `set null`
  --     anule el renglón, y en ese instante la cobertura no se puede anular
  --     junto con él. En el INSERT no hay ese problema: acá se exige entero.
  if (new.serving_record_item_id is null) <> (new.covers_quantity is null) then
    raise exception
      'un movimiento colgado de un renglón servido necesita su cobertura, y una cobertura sin renglón no cubre nada'
      using errcode = 'check_violation';
  end if;

  -- (1) Un descuento por comer SIEMPRE tiene un renglón de servido detrás.
  if new.reason = 'CONSUMED' and new.serving_record_item_id is null then
    raise exception
      'un descuento por consumo solo lo escribe un registro de servido: primero se sirve, después se descuenta'
      using errcode = 'check_violation';
  end if;

  -- (2) Comer saca comida de la despensa. Un CONSUMED que suma es un error de
  --     signo disfrazado de reposición.
  if new.reason = 'CONSUMED' and new.delta >= 0 then
    raise exception 'un consumo tiene que sacar del lote (delta negativo), llegó %', new.delta
      using errcode = 'check_violation';
  end if;

  if new.serving_record_item_id is not null then
    -- (3) Solo tres razones pueden colgar de un renglón servido: el descuento,
    --     su corrección/reversión, y la merma de lo que salió y no se comió.
    if new.reason not in ('CONSUMED', 'ADJUSTMENT', 'DISCARDED_LEFTOVER') then
      raise exception
        'un movimiento colgado de un renglón servido solo puede ser CONSUMED, ADJUSTMENT o DISCARDED_LEFTOVER (llegó %)',
        new.reason using errcode = 'check_violation';
    end if;

    -- (3b) UN AJUSTE COLGADO DE UN RENGLÓN SERVIDO SOLO EXISTE PARA DESHACER.
    --      El bloque (6) corre el bicondicional en UN SOLO sentido: si viene
    --      `reverses_movement_id`, la razón tiene que ser ADJUSTMENT. El otro
    --      sentido quedaba abierto, y por ahí se colaba una reposición libre: un
    --      ADJUSTMENT POSITIVO sin enlace de reversión, colgado de un renglón
    --      servido, esquivaba los DOS topes de reposición —el (7), que mide
    --      contra el movimiento que deshace, y el (8), que mide contra el
    --      renglón entero— porque ambos viven adentro del `if` de la reversión.
    --      Sin pasar por ninguno, ese ajuste inflaba el lote en la cantidad que
    --      se le pidiera: comida fabricada de la nada.
    --
    --      Acá se cierra el bicondicional. Sobre un renglón servido, ajustar ES
    --      revertir: el único ADJUSTMENT legítimo lo escribe
    --      `app.reverse_serving_item`, y ese SIEMPRE dice qué movimiento
    --      deshace. Un ajuste de despensa que no tiene nada que ver con lo
    --      servido (`adjust_lot`) no cuelga de ningún renglón y ni se entera de
    --      esta pared.
    if new.reason = 'ADJUSTMENT' and new.reverses_movement_id is null then
      raise exception
        'un ajuste sobre un renglón servido es siempre la reversión de un descuento: sin el movimiento que deshace, repone comida que nadie sacó'
        using errcode = 'check_violation';
    end if;

    -- (4) Coherencia de hogar: el renglón y el movimiento son del mismo hogar.
    --     Si no existe o es ajeno, el mensaje es el mismo — no se filtra por
    --     el error que un recurso de otra casa exista.
    select r.household_id into v_item_household
    from public.meal_serving_record_items i
    join public.meal_serving_records r on r.id = i.record_id
    where i.id = new.serving_record_item_id;

    if v_item_household is null or v_item_household <> new.household_id then
      raise exception 'no autorizado';
    end if;

    -- (4b) TOPE POR RENGLÓN. El bloque (1) exige que HAYA un renglón detrás de
    --      cada descuento, pero no dice CUÁNTO puede sacar ese renglón. Sin este
    --      tope, un SEGUNDO movimiento CONSUMED sobre el MISMO renglón pasaba el
    --      candado entero y volvía a descontar el mismo alimento: el renglón
    --      sirvió 200, el libro mayor sacó 400 y la despensa perdió 200 gramos
    --      que nadie se comió. "Si hay descuento, hay renglón" era necesario y no
    --      suficiente; el renglón además ACOTA.
    --
    --      SE MIDE CONTRA EL LIBRO MAYOR, NO CONTRA EL ESPEJO. `deducted_quantity`
    --      lo mueven los RPC con un UPDATE aparte: un escritor futuro que se
    --      olvide de moverlo dejaría el tope ciego justo cuando más se necesita.
    --      El movimiento, en cambio, no se puede olvidar de escribir: es el
    --      hecho mismo.
    --
    --      Y SE MIDE EN `covers_quantity`, NO EN `delta`. `delta` habla la lengua
    --      del LOTE y `served_quantity` la del RENGLÓN, que puede ir en COOKED:
    --      en la conversión explícita cocido→crudo (bloque 9) los dos números
    --      difieren por el factor de rendimiento. Comparar gramos crudos contra
    --      gramos cocidos rebotaría servidos legítimos con factor < 1 y dejaría
    --      pasar el doble descuento con factor > 1. La cobertura existe
    --      exactamente para esto.
    --
    --      EL NETO DESCUENTA LAS REVERSIONES: corregir al alza (200 → 300)
    --      escribe un CONSUMED nuevo sobre un renglón que ya tenía uno, y eso es
    --      legítimo mientras la suma no pase lo servido. Solo cuentan como
    --      devolución los ADJUSTMENT con `reverses_movement_id`, que después de
    --      (3b) son los únicos que existen sobre un renglón.
    if new.reason = 'CONSUMED' then
      -- `for update` no es decorativo, igual que en `discard_serving`: dos
      -- descuentos simultáneos sobre el mismo renglón leen el mismo libro mayor
      -- y los dos pasan el tope. Todos los escritores legítimos ya toman este
      -- mismo lock ANTES de escribir el movimiento, así que el orden siempre es
      -- renglón → movimiento y no hay abrazo mortal. Va DESPUÉS del chequeo de
      -- hogar (4): un renglón ajeno ya rebotó con 'no autorizado' y nunca llega
      -- a este mensaje, que cita gramos.
      select i.served_quantity into v_servido
      from public.meal_serving_record_items i
      where i.id = new.serving_record_item_id
      for update;

      select
        coalesce(sum(abs(m.covers_quantity))
                 filter (where m.reason = 'CONSUMED'), 0),
        coalesce(sum(abs(m.covers_quantity))
                 filter (where m.reason = 'ADJUSTMENT'
                           and m.reverses_movement_id is not null), 0)
      into v_sacado, v_devuelto
      from public.inventory_movements m
      where m.serving_record_item_id = new.serving_record_item_id;

      if (v_sacado - v_devuelto) + abs(new.covers_quantity)
         > coalesce(v_servido, 0) + 0.001 then
        raise exception
          'este renglón sirvió % y el libro mayor ya le sacó % a la despensa: descontar % más sería cobrar dos veces la misma comida',
          coalesce(v_servido, 0), greatest(v_sacado - v_devuelto, 0),
          abs(new.covers_quantity)
          using errcode = 'check_violation';
      end if;
    end if;

    -- (5) La merma de lo servido NO vuelve a descontar: los gramos ya salieron
    --     del lote al servir. Un segundo delta negativo sería exactamente el
    --     doble descuento que esta migración existe para impedir. Se anota con
    --     delta 0 y la cantidad viaja en covers_quantity.
    if new.reason = 'DISCARDED_LEFTOVER' and new.delta <> 0 then
      raise exception
        'la merma de lo servido no descuenta de nuevo: esos gramos ya salieron del lote al servir'
        using errcode = 'check_violation';
    end if;

    -- (5b) TOPE DE MERMA. `covers_quantity` firmado ES el libro de la basura de
    --      este renglón: negativo lo bota, positivo anula una merma mal
    --      declarada (`undo_discard_serving`). El neto tiene dos paredes.
    --
    --      Sin la pared de arriba, dos llamadas a `discard_serving` por 200
    --      dejaban 400 gramos de basura declarada sobre un renglón que sirvió
    --      200 — y cada uno de esos gramos gasta presupuesto de devolución.
    --      Sin la de abajo, "desbotar" fabricaría saldo devolvible de la nada.
    if new.reason = 'DISCARDED_LEFTOVER' then
      select i.served_quantity into v_servido
      from public.meal_serving_record_items i
      where i.id = new.serving_record_item_id;

      select coalesce(sum(-m.covers_quantity), 0) into v_botado
      from public.inventory_movements m
      where m.serving_record_item_id = new.serving_record_item_id
        and m.reason = 'DISCARDED_LEFTOVER';

      -- Neto DESPUÉS de esta fila: la cobertura negativa suma basura.
      v_botado := v_botado - coalesce(new.covers_quantity, 0);

      if v_botado < -0.001 then
        raise exception
          'no se puede anular más merma de la que este renglón tiene declarada'
          using errcode = 'check_violation';
      end if;
      if v_botado > coalesce(v_servido, 0) + 0.001 then
        raise exception
          'el renglón sirvió % y esa merma dejaría % declarados basura: no se bota lo que nunca salió a la mesa',
          coalesce(v_servido, 0), v_botado
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  -- (6) Revertir es DESHACER, no elegir de nuevo.
  if new.reverses_movement_id is not null then
    if new.reason <> 'ADJUSTMENT' then
      raise exception 'una reversión se escribe como ADJUSTMENT, no como %', new.reason
        using errcode = 'check_violation';
    end if;

    select * into v_orig from public.inventory_movements
    where id = new.reverses_movement_id for update;

    if v_orig.id is null or v_orig.household_id <> new.household_id then
      raise exception 'no autorizado';
    end if;

    -- (6b) QUÉ SE PUEDE REVERTIR. Hasta acá, el candado exigía que la reversión
    --      fuera un ADJUSTMENT, del mismo hogar, del mismo lote y de signo
    --      contrario — pero jamás preguntaba QUÉ estaba deshaciendo. Con eso,
    --      apuntar `reverses_movement_id` a un DISCARDED_LEFTOVER pasaba entero:
    --      la merma tiene cobertura negativa, así que una cobertura positiva es
    --      "de signo contrario", y el resultado era un delta positivo sobre el
    --      lote. La despensa recuperaba gramos que están físicamente en la
    --      basura. El inventario mentía, y mentía hacia arriba: el peor sentido,
    --      porque lo que sobra en la planilla es lo que falta en la olla.
    --
    --      LA REGLA: se revierte UN SOLO tipo de movimiento, CONSUMED.
    --
    --      POR QUÉ solo ese. Revertir acá significa una cosa muy concreta y muy
    --      física: "esos gramos NO salieron, vuelven al lote". Eso es cierto
    --      exactamente cuando la comida seguía existiendo y seguía siendo de la
    --      despensa — que es el caso del descuento por servir, y de ninguna otra
    --      razón del enum:
    --
    --      · CONSUMED — SÍ. Se sirvió de más y se devolvió lo que no se sirvió.
    --        La comida existe, es la misma, y vuelve al lote del que salió. Es
    --        el único caso, y el único que escribe `app.reverse_serving_item`.
    --
    --      · SPOILED, EXPIRED, DAMAGED, DISCARDED_LEFTOVER, PURCHASE_PROBLEM,
    --        PREP_LOSS — NO. La comida está en la basura. Reponer stock no la
    --        saca de ahí: solo fabrica un número. Que un descarte se pueda haber
    --        marcado MAL es cierto y tiene su propio camino —
    --        `undo_discard_serving` para la merma de lo servido, que corrige el
    --        saldo del renglón con delta 0 y NO devuelve un gramo al lote, y
    --        `receive_shopping_list`/`adjust_lot` para el resto. Deshacer un
    --        error de dedo nunca puede ser lo mismo que resucitar comida.
    --
    --      · USED_IN_RECIPE, TRANSFORM, COOK, THAW — NO. El alimento cambió de
    --        estado o de identidad; el lote de origen ya no lo contiene. Volver
    --        a sumarlo ahí duplicaría el mismo alimento en dos lotes.
    --
    --      · SPLIT, MERGE, MOVE — NO. Son operaciones de VARIAS patas que
    --        comparten `group_id` y cuya suma tiene que dar cero (0011:302).
    --        Revertir una pata suelta rompe esa suma y deja el grupo mintiendo.
    --        Se deshacen con la operación inversa completa, no de a pedazos.
    --
    --      · PURCHASE — NO. Devolver una compra es un hecho de la despensa, no
    --        del plato: lo escribe `discard_lot` con PURCHASE_PROBLEM o un
    --        `adjust_lot`, que dejan rastro de POR QUÉ salió.
    --
    --      · ADJUSTMENT — NO, y este es el que más engaña. Revertir una
    --        reversión vuelve a descontar por la puerta de atrás, esquivando el
    --        tope (4b), que solo cuenta CONSUMED; y encadenar reversiones de
    --        reversiones haría que el saldo del bloque (7) —que mira UN nivel—
    --        contara dos veces el mismo gramo. Corregir de nuevo a la baja se
    --        hace con un CONSUMED nuevo, que sí pasa por el tope del renglón.
    --
    --      · LABEL_WEIGHT_UPDATE, OTHER — NO. La primera es una corrección de la
    --        etiqueta, no un movimiento de comida; la segunda es literalmente
    --        "no sabemos qué fue", y UNKNOWN != ZERO: lo que no se sabe qué
    --        sacó, no se sabe cómo devolver.
    --
    --      La lista es blanca a propósito. Si mañana entra una razón nueva al
    --      enum, nace NO reversible y alguien tiene que venir acá a justificarla
    --      — que es exactamente al revés de como se abrió este agujero.
    if v_orig.reason <> 'CONSUMED' then
      if v_orig.reason in ('SPOILED', 'EXPIRED', 'DAMAGED', 'DISCARDED_LEFTOVER',
                           'PURCHASE_PROBLEM', 'PREP_LOSS') then
        raise exception
          'eso está en la basura, no en la despensa: una merma (%) no se deshace reponiendo stock que ya no existe',
          v_orig.reason
          using errcode = 'check_violation';
      end if;
      raise exception
        'solo se revierte un descuento por comer (CONSUMED): un % se deshace por su propio camino, no devolviendo gramos al lote',
        v_orig.reason
        using errcode = 'check_violation';
    end if;

    if v_orig.lot_id <> new.lot_id then
      raise exception 'una reversión vuelve AL MISMO LOTE del que salió: el destino lo dicta el movimiento original'
        using errcode = 'check_violation';
    end if;
    if new.covers_quantity is null or v_orig.covers_quantity is null then
      raise exception 'una reversión necesita su cobertura para saber cuánto del renglón devuelve'
        using errcode = 'check_violation';
    end if;
    if new.delta = 0 or sign(new.delta) = sign(v_orig.delta) then
      raise exception 'una reversión va en sentido contrario al movimiento que deshace'
        using errcode = 'check_violation';
    end if;
    if new.covers_quantity = 0 or sign(new.covers_quantity) = sign(v_orig.covers_quantity) then
      raise exception 'la cobertura de una reversión va en sentido contrario a la del movimiento original'
        using errcode = 'check_violation';
    end if;

    -- (7) TOPE: jamás se devuelve más de lo que ese movimiento sacó. El check
    --     (quantity >= 0) de `inventory_lots` (0011:104) protege el lado
    --     negativo; este tope protege el positivo. Ni un reintento raro ni un
    --     cálculo malo pueden inflar la despensa.
    select coalesce(sum(abs(m.covers_quantity)), 0) into v_revertido
    from public.inventory_movements m
    where m.reverses_movement_id = v_orig.id;

    v_saldo := abs(v_orig.covers_quantity) - v_revertido;
    if abs(new.covers_quantity) > v_saldo + 0.001 then
      raise exception
        'esa reversión devolvería % cuando al movimiento original solo le quedan % por revertir',
        abs(new.covers_quantity), greatest(v_saldo, 0)
        using errcode = 'check_violation';
    end if;

    -- (8) TOPE DEL RENGLÓN, NETO DE BASURA. El tope (7) mira UN movimiento;
    --     este mira el renglón entero, porque la merma no cuelga de un
    --     movimiento en particular: lo que salió del lote termina en UN solo
    --     lugar —de vuelta en la despensa o en el basurero— y nunca en los dos.
    --
    --     Acá el candado no confía en el espejo (`deducted_quantity`): lo
    --     recalcula desde el libro mayor. Un RPC futuro que se olvide de mover
    --     la columna igual choca contra esta pared.
    if new.serving_record_item_id is not null then
      select
        coalesce(sum(abs(m.covers_quantity))
                 filter (where m.reason = 'CONSUMED'), 0),
        coalesce(sum(abs(m.covers_quantity))
                 filter (where m.reason = 'ADJUSTMENT'
                           and m.reverses_movement_id is not null), 0),
        coalesce(sum(-m.covers_quantity)
                 filter (where m.reason = 'DISCARDED_LEFTOVER'), 0)
      into v_sacado, v_devuelto, v_botado
      from public.inventory_movements m
      where m.serving_record_item_id = new.serving_record_item_id;

      if v_devuelto + v_botado + abs(new.covers_quantity) > v_sacado + 0.001 then
        raise exception
          'este renglón sacó % de la despensa y ya tiene % devueltos y % botados: devolver % más sería reponer comida que está en la basura',
          v_sacado, v_devuelto, v_botado, abs(new.covers_quantity)
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- BEFORE INSERT y no AFTER: se rechaza antes de que el movimiento exista, así
-- `app.apply_movement_to_lot` (AFTER INSERT) ni siquiera llega a mover el lote.
create trigger movements_owner_guard
  before insert on public.inventory_movements
  for each row execute function app.movement_owner_guard();

comment on function app.movement_owner_guard() is
  'El candado estructural del Sprint 12: descontar inventario por comer = '
  'escribir un renglón de servido. Si no hay renglón, no hay descuento.';

-- ---------------------------------------------------------------------------
-- 4 bis. `on delete set null` es un UPDATE: el escape quirúrgico del append-only
-- ---------------------------------------------------------------------------
--
-- EL PROBLEMA. Una FK declarada `on delete set null` no se resuelve por arte de
-- magia: cuando la fila referenciada muere, PostgreSQL dispara un UPDATE REAL
-- sobre la tabla que la referenciaba. Ese UPDATE despierta a
-- `app.ledger_is_append_only` (0011:277), que solo sabe perdonar DELETE:
--
--     if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
--     raise exception 'el libro mayor de inventario es append-only...';
--
-- No hay rama para UPDATE, así que el borrado revienta SIEMPRE. Y no es un
-- defecto que traiga el Sprint 12: `inventory_movements` ya tenía dos FK
-- `on delete set null` desde el Sprint 7 — `actor_member_id` (0011:161) y
-- `consumption_log_id` (0011:196). Borrar hoy al integrante que anotó un
-- movimiento, o el consumption_log del que colgaba, ya choca contra el mensaje
-- "el libro mayor es append-only", que además miente sobre la causa. Esta
-- migración agrega dos FK más del mismo tipo (`serving_record_item_id` y el
-- auto-referencial `reverses_movement_id`) y con eso el defecto deja de ser
-- latente: el registro de servido muere por cascada cada vez que se borra un
-- integrante del hogar, y con él el renglón que el libro mayor referencia.
--
-- POR QUÉ NO SE CAMBIAN LAS FK A `no action` / `restrict` (el otro camino).
-- Porque el diseño DEPENDE de que el `set null` funcione, en tres puntos:
--
--   · `meal_serving_record_items.serving_component_id` y `component_id` son
--     `set null` a propósito (bloque 2): el PLAN puede desaparecer —
--     reconfirmar una comida borra y reinserta las proyecciones (0023:83,
--     0025:89) — y lo SERVIDO tiene que sobrevivir a eso. Con `restrict`, la
--     existencia de un renglón servido volvería la comida imposible de
--     reconfirmar para siempre: exactamente el bug que este sprint cierra, con
--     el signo cambiado.
--   · `app.protect_served_projection` declara por escrito que un registro
--     anulado "sobrevive igual como historia (con projection_id en NULL)". Sin
--     `set null` esa frase es falsa y la proyección queda inmortal.
--   · `meal_serving_records.member_id` es `on delete cascade`: sacar a un
--     integrante del hogar borra sus registros de servido, pero NO borra los
--     movimientos del libro mayor (esos cuelgan de los lotes, que son del
--     hogar y siguen vivos). Con `no action`/`restrict` sobre
--     `serving_record_item_id`, sacar a un integrante que alguna vez comió
--     pasaría a ser imposible. Es un cambio de semántica de una operación que
--     ya existe, y en una tabla congelada: mucho más invasivo que el escape.
--
-- QUÉ TAN QUIRÚRGICO ES EL ESCAPE. Un UPDATE se perdona solo si se cumplen las
-- TRES condiciones a la vez:
--
--   1. `pg_trigger_depth() > 1`. La sentencia no viene del cliente. Una acción
--      referencial suma SIEMPRE al menos dos niveles: el trigger AFTER DELETE
--      de integridad corre en profundidad >= 1 y el UPDATE que emite despierta
--      a nuestro BEFORE UPDATE en profundidad >= 2. Un UPDATE tecleado por un
--      cliente (PostgREST, psql, un RPC) despierta al trigger en profundidad 1
--      y no alcanza el escape ni por casualidad.
--   2. Las ÚNICAS columnas que cambian están en la lista blanca de FK anulables
--      de esa tabla. Se compara la fila COMPLETA con `to_jsonb`, no una lista
--      de columnas escrita a mano: si mañana alguien agrega una columna y no se
--      acuerda de este bloque, la columna nueva queda protegida por omisión —
--      que es el sentido correcto del olvido.
--   3. El cambio va sólo en el sentido valor → NULL. Ni NULL → valor, ni valor
--      → otro valor. Un `set null` no puede hacer otra cosa; cualquier otra
--      cosa no es un `set null`.
--
-- Lo que el escape NO abre: no se puede editar `delta`, ni `reason`, ni
-- `lot_id`, ni `covers_quantity`, ni `created_at`, ni desde el cliente ni desde
-- adentro de un trigger. La conservación de valor (K-19) sigue apoyada donde
-- estaba: los deltas del libro mayor son inmutables. Lo único que el escape
-- deja perder es un PUNTERO a una fila que ya no existe, y sólo el motor puede
-- perderlo.

create or replace function app.is_fk_set_null_update(
  p_old jsonb, p_new jsonb, p_fk_cols text[]
) returns boolean
language plpgsql
immutable
set search_path = pg_catalog as $$
declare
  v_col text;
  v_anulo boolean := false;
begin
  if p_old is null or p_new is null then return false; end if;

  -- Se van sacando de la comparación SOLO las columnas de la lista blanca que
  -- pasaron de tener valor a NULL. Lo que quede tiene que ser idéntico.
  foreach v_col in array p_fk_cols loop
    if (p_old ->> v_col) is not null and (p_new -> v_col) = 'null'::jsonb then
      v_anulo := true;
      p_old := p_old - v_col;
      p_new := p_new - v_col;
    end if;
  end loop;

  -- `v_anulo` exige que haya pasado algo: un UPDATE que no anula ninguna FK no
  -- es una acción referencial y no tiene por qué colarse.
  return v_anulo and p_old = p_new;
end;
$$;

comment on function app.is_fk_set_null_update(jsonb, jsonb, text[]) is
  'Responde si un UPDATE es EXACTAMENTE lo que hace una acción referencial '
  '`on delete set null`: una o más columnas de la lista blanca pasando de '
  'valor a NULL, y absolutamente nada más cambiado en la fila.';

-- `create or replace` de una función de 0011 desde una migración nueva: no se
-- edita la migración congelada, se le agrega la rama que le faltaba. El mensaje
-- de error se conserva palabra por palabra a propósito.
create or replace function app.ledger_is_append_only()
returns trigger language plpgsql
set search_path = pg_catalog as $$
begin
  -- Un DELETE que llega por cascada (se borra el hogar o el lote entero) viene
  -- de un trigger de integridad referencial: profundidad > 1. Ese sí pasa.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  -- Y un UPDATE que llega por una acción referencial `set null` también viene
  -- de un trigger de integridad: mismo origen, mismo derecho. Las cuatro
  -- columnas de la lista son las únicas FK anulables del libro mayor
  -- (`actor_member_id` y `consumption_log_id` desde 0011; las otras dos desde
  -- esta migración). Ninguna de ellas participa de la conservación de valor.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1
     and app.is_fk_set_null_update(to_jsonb(old), to_jsonb(new), array[
           'actor_member_id',
           'consumption_log_id',
           'serving_record_item_id',
           'reverses_movement_id'
         ])
  then
    return new;
  end if;

  raise exception 'el libro mayor de inventario es append-only: se corrige con un movimiento nuevo (ADJUSTMENT), no editando la historia';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Append-only e invariante dura de los registros de servido
-- ---------------------------------------------------------------------------

/**
 * Un registro de servido no se edita: solo puede pasar de ACTIVE a VOIDED, y
 * el borrado únicamente llega por cascada (se borra el hogar). Mismo espíritu
 * y mismo escape `pg_trigger_depth() > 1` que `app.ledger_is_append_only`
 * (0011:277).
 */
create or replace function app.serving_record_is_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'un registro de servido no se borra: se anula con void_serving_record';
  end if;

  -- El mismo escape quirúrgico del bloque 4 bis, por la misma razón: las cuatro
  -- FK anulables de esta tabla se anulan con un UPDATE que dispara el motor, no
  -- una persona. Va ANTES del corte por VOIDED a propósito: si fuera después,
  -- borrar al integrante que anuló un registro (`voided_by`) sería imposible
  -- para siempre, porque ese registro ya está en VOIDED y la guarda lo rebota.
  if pg_trigger_depth() > 1
     and app.is_fk_set_null_update(to_jsonb(old), to_jsonb(new), array[
           'assignment_id', 'projection_id', 'served_by', 'voided_by'
         ])
  then
    return new;
  end if;

  if old.status = 'VOIDED' then
    raise exception 'este registro de servido ya está anulado: la historia no se reescribe';
  end if;

  -- Solo el bloque de anulación puede cambiar. Todo lo demás es historia.
  if new.id                  is distinct from old.id
     or new.household_id     is distinct from old.household_id
     or new.member_id        is distinct from old.member_id
     or new.kind             is distinct from old.kind
     or new.assignment_id    is distinct from old.assignment_id
     or new.projection_id    is distinct from old.projection_id
     or new.meal_type        is distinct from old.meal_type
     or new.served_on        is distinct from old.served_on
     or new.served_at        is distinct from old.served_at
     or new.served_by        is distinct from old.served_by
     or new.plan_frozen_at   is distinct from old.plan_frozen_at
     or new.plan_optimizer_version is distinct from old.plan_optimizer_version
     or new.plan_nutrition   is distinct from old.plan_nutrition
     or new.plan_completeness is distinct from old.plan_completeness
     or new.plan_event_effect is distinct from old.plan_event_effect
     or new.plan_unverifiable_constraints is distinct from old.plan_unverifiable_constraints
     or new.created_at       is distinct from old.created_at then
    raise exception 'el plan congelado y el acto de servir son historia: no se editan';
  end if;
  return new;
end;
$$;

create trigger serving_records_append_only
  before update or delete on public.meal_serving_records
  for each row execute function app.serving_record_is_append_only();

/**
 * El renglón servido es append-only salvo las columnas de acumulación (y la
 * cantidad servida, que solo mueve `correct_serving_item` y siempre en la
 * misma transacción que su reversión física).
 */
create or replace function app.serving_item_is_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'un renglón servido no se borra: se corrige con correct_serving_item';
  end if;

  -- Escape quirúrgico del bloque 4 bis. Acá es donde MÁS se usa: las cuatro FK
  -- son `on delete set null` a propósito para que el plan pueda desaparecer
  -- (reconfirmar la comida borra las proyecciones y sus componentes) y el
  -- catálogo pueda archivar un alimento, sin que lo servido se lleve por
  -- delante. Sin este escape, esa promesa del bloque 2 era falsa: el borrado
  -- rebotaba contra la propia guarda append-only, que lista las cuatro columnas
  -- como historia inmutable.
  if pg_trigger_depth() > 1
     and app.is_fk_set_null_update(to_jsonb(old), to_jsonb(new), array[
           'serving_component_id', 'component_id', 'ingredient_id', 'product_id'
         ])
  then
    return new;
  end if;

  if new.id                   is distinct from old.id
     or new.record_id         is distinct from old.record_id
     or new.serving_component_id is distinct from old.serving_component_id
     or new.component_id      is distinct from old.component_id
     or new.label             is distinct from old.label
     or new.ingredient_id     is distinct from old.ingredient_id
     or new.product_id        is distinct from old.product_id
     or new.planned_quantity  is distinct from old.planned_quantity
     or new.planned_unit      is distinct from old.planned_unit
     or new.planned_weight_basis is distinct from old.planned_weight_basis
     or new.planned_cooking_method is distinct from old.planned_cooking_method
     or new.planned_added_fat_g is distinct from old.planned_added_fat_g
     or new.planned_nutrition is distinct from old.planned_nutrition
     or new.served_unit       is distinct from old.served_unit
     or new.served_weight_basis is distinct from old.served_weight_basis
     or new.created_at        is distinct from old.created_at then
    raise exception 'el plan congelado y la identidad del renglón servido son historia: no se editan';
  end if;
  return new;
end;
$$;

create trigger serving_record_items_append_only
  before update or delete on public.meal_serving_record_items
  for each row execute function app.serving_item_is_append_only();

/**
 * Coherencia bloque-de-plan ↔ clase del registro, y del hogar de las
 * referencias que vienen del plan. Es un trigger y no un CHECK porque el
 * `kind` vive en la tabla padre.
 */
create or replace function app.serving_item_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_rec public.meal_serving_records;
  v_tiene_plan boolean;
begin
  select * into v_rec from public.meal_serving_records where id = new.record_id;
  if v_rec.id is null then raise exception 'no autorizado'; end if;
  if v_rec.status <> 'ACTIVE' then
    raise exception 'no se agregan renglones a un registro de servido anulado'
      using errcode = 'check_violation';
  end if;

  v_tiene_plan := (v_rec.kind = 'FROM_PLAN');

  if v_tiene_plan then
    if new.planned_quantity is null or new.planned_unit is null
       or new.planned_weight_basis is null then
      raise exception
        'un renglón servido desde el plan tiene que congelar el plan: cantidad, unidad y base de peso'
        using errcode = 'check_violation';
    end if;
  else
    if new.planned_quantity is not null or new.planned_unit is not null
       or new.planned_weight_basis is not null or new.planned_cooking_method is not null
       or new.planned_added_fat_g is not null then
      raise exception
        'un renglón fuera de plan no tiene plan que congelar: escribir ceros diría "el plan pedía cero"'
        using errcode = 'check_violation';
    end if;
  end if;

  -- El componente del que dice venir tiene que ser del MISMO hogar. Mensaje
  -- único: nunca se distingue "no existe" de "es de otra casa".
  if new.serving_component_id is not null and not exists (
    select 1
    from public.member_serving_components c
    join public.member_serving_projections p on p.id = c.projection_id
    join public.household_members m on m.id = p.member_id
    where c.id = new.serving_component_id and m.household_id = v_rec.household_id
  ) then
    raise exception 'no autorizado';
  end if;

  if not app.ingredient_in_scope(new.ingredient_id, v_rec.household_id)
     or not app.product_in_scope(new.product_id, v_rec.household_id) then
    raise exception 'no autorizado';
  end if;

  perform app.assert_finite(new.served_quantity, 'la cantidad servida');
  perform app.assert_finite(new.planned_quantity, 'la cantidad planificada');
  return new;
end;
$$;

create trigger serving_record_items_guard
  before insert on public.meal_serving_record_items
  for each row execute function app.serving_item_guard();

/**
 * INVARIANTE DURA: lo servido y lo descontado no pueden divergir en silencio.
 *
 *     deducted_quantity + shortfall_quantity = served_quantity  (±0.001)
 *
 * Se verifica con un CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED —mismo
 * patrón que `movements_group_invariant` (0011:317)— porque al insertar el
 * renglón todavía no se descontó nada: la verdad recién existe al cierre de la
 * transacción. Si divergen, la transacción NO CIERRA. Un faltante silencioso
 * deja de ser posible.
 */
create or replace function app.check_serving_item_balance()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_i public.meal_serving_record_items;
begin
  -- Se relee la fila en su estado FINAL: el chequeo corre al commit, no en el
  -- instante del insert.
  select * into v_i from public.meal_serving_record_items where id = new.id;
  if v_i.id is null then return null; end if;   -- se borró por cascada: nada que validar

  if abs((v_i.deducted_quantity + v_i.shortfall_quantity) - v_i.served_quantity) > 0.001 then
    raise exception
      'el renglón "%" sirvió % y solo tiene % descontados + % faltantes: lo servido y lo descontado no pueden divergir',
      v_i.label, v_i.served_quantity, v_i.deducted_quantity, v_i.shortfall_quantity
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger serving_item_balance_invariant
  after insert or update on public.meal_serving_record_items
  deferrable initially deferred
  for each row execute function app.check_serving_item_balance();

-- ---------------------------------------------------------------------------
-- 6. Guardas de historia ancladas en el HECHO, no en un enum
-- ---------------------------------------------------------------------------
--
-- Las guardas viejas enumeran estados en cinco lugares y ninguna incluye
-- CANCELLED. Estas preguntan por la existencia del registro de servido: no
-- dependen de que alguien se acuerde de actualizar cinco listas cuando el enum
-- crezca. Se conserva además la pregunta por el estado, porque las porciones
-- CONSUMED escritas por el mundo viejo (`consume_planned_meal` anterior a esta
-- migración) son historia real y NO tienen registro detrás.

/**
 * Una proyección con un acto de servido VIVO detrás no se borra. Cierra de una
 * vez el agujero que dejan los cinco lugares donde hoy se borran proyecciones:
 * `confirm_meal_assignment` (0023:83 y 0025:89) y `unconfirm_meal_assignment`
 * (0008:246).
 *
 * Se mira solo el registro ACTIVE a propósito: un registro VOIDED ya declara
 * "esto nunca se sirvió" y devolvió cada gramo a su lote. Bloquear por él
 * dejaría la comida imposible de reconfirmar para siempre por un error que ya
 * se corrigió. El registro anulado sobrevive igual como historia (con
 * projection_id en NULL), con su miembro, su plan congelado y su motivo.
 */
create or replace function app.protect_served_projection()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return old; end if;   -- cascada del hogar

  if exists (
    select 1 from public.meal_serving_records r
    where r.projection_id = old.id and r.status = 'ACTIVE'
  ) then
    raise exception
      'Esta porción ya salió a la mesa: su historia física no se borra. Corrige lo servido o anúlalo primero.'
      using errcode = 'check_violation';
  end if;

  -- Historia del mundo anterior a 0033: consumo registrado sin registro de
  -- servido. Sigue siendo historia.
  if old.status::text in ('CONSUMED', 'CANCELLED') then
    raise exception
      'Esta porción ya tiene consumo registrado: su historia no se borra.'
      using errcode = 'check_violation';
  end if;

  return old;
end;
$$;

drop trigger if exists servings_protect_served on public.member_serving_projections;
create trigger servings_protect_served
  before delete on public.member_serving_projections
  for each row execute function app.protect_served_projection();

/**
 * `app.protect_served_assignment` (0019:353) redefinida: la historia física
 * deja de estar anclada en un enum que mañana crece.
 */
create or replace function app.protect_served_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.meal_serving_records r
    where r.assignment_id = old.id and r.status = 'ACTIVE'
  ) then
    raise exception
      'Esta comida ya se sirvió: su historia no se borra.'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.member_serving_projections p
    where p.assignment_id = old.id
      and p.status::text in ('SERVED', 'CONSUMED', 'CANCELLED')
  ) then
    raise exception
      'Esta comida ya se sirvió: su historia no se borra.'
      using errcode = 'check_violation';
  end if;

  return old;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. El desajuste cuelga del acto físico
-- ---------------------------------------------------------------------------
--
-- `consumption_shortfalls.consumption_log_id` es nullable desde 0012:27, así
-- que esto no rompe nada. Desde acá el faltante cuelga del renglón SERVIDO y
-- no de un `consumption_log` que ya no se crea al servir.

alter table public.consumption_shortfalls
  add column serving_record_item_id uuid
    references public.meal_serving_record_items (id) on delete set null;

create index shortfalls_serving_item_idx
  on public.consumption_shortfalls (serving_record_item_id)
  where serving_record_item_id is not null;

comment on column public.consumption_shortfalls.serving_record_item_id is
  'Renglón servido que quedó corto. Desde el Sprint 12 el faltante cuelga del '
  'acto físico; consumption_log_id queda para la historia anterior.';

-- ---------------------------------------------------------------------------
-- 8. RLS: SOLO lectura. Cero policies de escritura.
-- ---------------------------------------------------------------------------
--
-- Es la lección de 0019:374 aplicada de entrada y no como parche: con una
-- policy FOR ALL, cualquier integrante podía reescribir por PostgREST lo que
-- los RPC validan y estampan. Acá no hay puerta trasera: la escritura pasa
-- únicamente por funciones SECURITY DEFINER.

alter table public.meal_serving_records enable row level security;
create policy serving_records_select on public.meal_serving_records
  for select to authenticated using (app.can_access_member(member_id));

-- `meal_serving_clinical_context` NO se lista acá: su policy vive pegada a su
-- tabla (sección 1 bis) para que nadie la lea sin ver, en la misma pantalla,
-- que la llave es `app.medical_access` y no `app.can_access_member`.

alter table public.meal_serving_record_items enable row level security;
create policy serving_record_items_select on public.meal_serving_record_items
  for select to authenticated
  using (exists (
    select 1 from public.meal_serving_records r
    where r.id = record_id and app.can_access_member(r.member_id)
  ));

-- ---------------------------------------------------------------------------
-- 9. Helpers internos (esquema `app`: no los expone PostgREST)
-- ---------------------------------------------------------------------------

/**
 * ¿Hay una declaración de consumo VIVA colgando de este registro de servido?
 *
 * El enlace `consumption_logs.serving_record_id` nace en 0034. Hasta que
 * exista, no hay declaración posible y la respuesta es `false` sin mentir. Se
 * resuelve en tiempo de ejecución para que 0034 no tenga que redefinir esta
 * función ni `void_serving_record`.
 */
create or replace function app.serving_record_has_active_intake(p_record_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_hay boolean := false;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'consumption_logs'
      and column_name = 'serving_record_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'consumption_logs'
      and column_name = 'status'
  ) then
    return false;
  end if;

  execute
    'select exists (select 1 from public.consumption_logs
                    where serving_record_id = $1 and status::text = ''ACTIVE'')'
    into v_hay using p_record_id;

  return coalesce(v_hay, false);
end;
$$;

/**
 * Descuento FEFO de un renglón servido. Devuelve lo que NO se pudo descontar
 * (el faltante), en la unidad del renglón.
 *
 * Es el ÚNICO lugar del sistema que escribe movimientos CONSUMED, y siempre
 * con `serving_record_item_id` y `covers_quantity`. Lo llaman solo RPC que ya
 * autorizaron; igual revalida la pertenencia al hogar, porque una función
 * SECURITY DEFINER que confía en su llamador es una función que no valida.
 *
 * `p_sufijo` distingue el descuento inicial ('0') de cada corrección: la clave
 * de idempotencia de los movimientos es red de seguridad INTRA-transacción, NO
 * el mecanismo anti-doble-descuento — no puede serlo, porque el lote lo elige
 * FEFO y FEFO no es estable en el tiempo.
 */
create or replace function app.fefo_deduct_serving_item(
  p_item_id  uuid,
  p_cantidad numeric,
  p_actor    uuid,
  p_sufijo   text
) returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_item public.meal_serving_record_items;
  v_household uuid;
  v_today date;
  v_lot record;
  v_pendiente numeric;
  v_toma numeric;
  v_factor numeric;
begin
  select * into v_item from public.meal_serving_record_items where id = p_item_id;
  if v_item.id is null then raise exception 'no autorizado'; end if;

  select household_id into v_household
  from public.meal_serving_records where id = v_item.record_id;

  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  perform app.assert_finite(p_cantidad, 'la cantidad a descontar');
  v_pendiente := coalesce(p_cantidad, 0);
  if v_pendiente <= 0 then return 0; end if;

  -- El día del HOGAR, no el del servidor: a las 22:30 de Santiago un lote que
  -- vence mañana todavía sirve.
  v_today := app.household_today(v_household);

  for v_lot in
    select l.* from public.inventory_lots l
    where l.household_id = v_household
      -- LA identidad del renglón: producto contra producto, alimento contra
      -- alimento (0022). Sin identidad de catálogo (lote de alta manual) solo
      -- califican los lotes de los que ESTE renglón ya salió: se repone donde
      -- se sacó, no donde convenga hoy.
      and (case
             when v_item.product_id is not null then l.product_id = v_item.product_id
             when v_item.ingredient_id is not null then l.ingredient_id = v_item.ingredient_id
             else l.id in (select m.lot_id from public.inventory_movements m
                           where m.serving_record_item_id = v_item.id)
           end)
      and l.unit = v_item.served_unit
      -- misma representación: 300 g de arroz cocido no pagan 300 g crudos
      and l.weight_basis = v_item.served_weight_basis
      and l.status = 'AVAILABLE' and l.quantity > 0
      and (coalesce(l.use_by, l.expiry_date) is null
           or coalesce(l.use_by, l.expiry_date) >= v_today)
    order by l.use_by asc nulls last, l.expiry_date asc nulls last, l.created_at asc
    -- Dos servidos distintos compiten por el mismo lote: sin lock ambos leen
    -- la misma cantidad y el lote queda sobregirado (0023:243).
    for update of l
  loop
    exit when v_pendiente <= 0;
    v_toma := least(v_pendiente, v_lot.quantity);
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, idempotency_key,
       serving_record_item_id, covers_quantity, actor_member_id)
    values
      (v_household, v_lot.id, 'CONSUMED', -v_toma,
       'SERVE:' || p_item_id::text || ':' || v_lot.id::text || ':' || p_sufijo,
       p_item_id, -v_toma, p_actor);
    v_pendiente := v_pendiente - v_toma;
  end loop;

  -- Conversión explícita cocido→crudo (0023:340): SOLO con identidad de
  -- alimento, porque los rendimientos se anotan por ingrediente. Sin factor no
  -- hay conversión inventada: el faltante se declara. UNKNOWN nunca es 1:1.
  if v_pendiente > 0 and v_item.served_weight_basis = 'COOKED'
     and v_item.ingredient_id is not null then
    select y.yield_factor into v_factor
    from public.ingredient_yields y
    where y.ingredient_id = v_item.ingredient_id
      and (y.household_id is null or y.household_id = v_household)
      and (y.cooking_method is null or y.cooking_method = v_item.planned_cooking_method)
    order by (y.household_id is not null) desc, (y.cooking_method is not null) desc
    limit 1;

    if v_factor is not null and v_factor > 0 then
      for v_lot in
        select l.* from public.inventory_lots l
        where l.household_id = v_household
          and l.ingredient_id = v_item.ingredient_id
          and l.unit = v_item.served_unit
          and l.weight_basis = 'RAW'
          and l.status = 'AVAILABLE' and l.quantity > 0
          and (coalesce(l.use_by, l.expiry_date) is null
               or coalesce(l.use_by, l.expiry_date) >= v_today)
        order by l.use_by asc nulls last, l.expiry_date asc nulls last, l.created_at asc
        for update of l
      loop
        exit when v_pendiente <= 0;
        v_toma := least(v_pendiente / v_factor, v_lot.quantity);
        insert into public.inventory_movements
          (household_id, lot_id, reason, delta, idempotency_key,
           serving_record_item_id, covers_quantity, actor_member_id, notes)
        values
          (v_household, v_lot.id, 'CONSUMED', -v_toma,
           'SERVE:' || p_item_id::text || ':' || v_lot.id::text || ':' || p_sufijo,
           p_item_id,
           -- delta va en unidad del LOTE (crudo); la cobertura en la del
           -- RENGLÓN (cocido). El factor queda congelado en este número: nadie
           -- tendrá que recalcular el rendimiento de ayer para revertirlo.
           -(v_toma * v_factor),
           p_actor,
           'conversión explícita cocido→crudo ×' || v_factor::text);
        v_pendiente := v_pendiente - (v_toma * v_factor);
      end loop;
    end if;
  end if;

  return greatest(v_pendiente, 0);
end;
$$;

/**
 * Reversión LIFO contra los movimientos reales del renglón. Devuelve cuánto
 * alcanzó a devolver, en la unidad del renglón.
 *
 * POR QUÉ LIFO CONTRA EL MOVIMIENTO Y NO FEFO OTRA VEZ: devolver es deshacer,
 * no elegir. Si la reversión volviera a consultar FEFO, elegiría el lote que
 * conviene HOY y no el que efectivamente entregó los gramos ayer — el mismo
 * error de raíz que hace inservible una idempotencia por clave FEFO. El
 * destino de cada gramo devuelto lo dicta el movimiento que lo sacó.
 *
 * La idempotencia acá SÍ es de clave y sí es estable, porque la clave se
 * deriva del id de un movimiento que YA EXISTE. Usa tal cual el índice único
 * parcial `inventory_movements_idem_uniq` (0011:164).
 *
 * El lote revive solo: `app.apply_movement_to_lot` (0011:249) ya devuelve un
 * lote CONSUMED a AVAILABLE cuando entra un delta positivo. No hay que tocar
 * nada de 0011.
 */
create or replace function app.reverse_serving_item(
  p_item_id       uuid,
  p_cantidad      numeric,
  p_actor         uuid,
  p_correction_id uuid,
  p_notes         text
) returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_mov record;
  v_pendiente numeric;
  v_saldo numeric;
  v_toma numeric;
  v_factor numeric;
begin
  select r.household_id into v_household
  from public.meal_serving_record_items i
  join public.meal_serving_records r on r.id = i.record_id
  where i.id = p_item_id;

  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  perform app.assert_finite(p_cantidad, 'la cantidad a devolver');
  v_pendiente := coalesce(p_cantidad, 0);
  if v_pendiente <= 0 then return 0; end if;

  for v_mov in
    select m.* from public.inventory_movements m
    where m.serving_record_item_id = p_item_id
      and m.reason = 'CONSUMED'
    order by m.created_at desc, m.id desc
    for update of m
  loop
    exit when v_pendiente <= 0;

    select abs(v_mov.covers_quantity) - coalesce(sum(abs(x.covers_quantity)), 0)
    into v_saldo
    from public.inventory_movements x
    where x.reverses_movement_id = v_mov.id;

    v_saldo := coalesce(v_saldo, abs(v_mov.covers_quantity));
    if v_saldo <= 0.001 then continue; end if;

    v_toma := least(v_pendiente, v_saldo);

    -- Factor congelado del movimiento original: cobertura ÷ delta. Así se
    -- devuelve en unidad del LOTE exactamente lo que salió, sin volver a mirar
    -- `ingredient_yields` (que pudo cambiar).
    v_factor := abs(v_mov.covers_quantity) / nullif(abs(v_mov.delta), 0);
    if v_factor is null or v_factor <= 0 then v_factor := 1; end if;

    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, idempotency_key,
       serving_record_item_id, covers_quantity, reverses_movement_id,
       actor_member_id, notes)
    values
      (v_household, v_mov.lot_id, 'ADJUSTMENT', v_toma / v_factor,
       'REVERSE:' || v_mov.id::text || ':' || p_correction_id::text,
       p_item_id, v_toma, v_mov.id, p_actor, p_notes);

    v_pendiente := v_pendiente - v_toma;
  end loop;

  return coalesce(p_cantidad, 0) - greatest(v_pendiente, 0);
end;
$$;

/**
 * ¿Había un techo clínico vigente para esta persona ese día?
 *
 * Devuelve UN BOOLEANO y nada más. Existe para que
 * `meal_serving_clinical_context.had_clinical_ceiling` se pueda congelar sin
 * que un solo valor clínico cruce a la capa no médica: ni el biomarcador, ni
 * el límite, ni la restricción. El detalle sigue viviendo en
 * `member_clinical_restrictions` con su RLS `medical_access` (0027:266), y el
 * booleano queda en una tabla con ESA MISMA RLS, nunca una más floja.
 */
create or replace function app.had_clinical_ceiling(p_member_id uuid, p_date date)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.member_clinical_restrictions r
    where r.member_id = p_member_id
      and r.verification_status = 'CONFIRMED'
      and r.type in ('NUTRIENT_MAX', 'PORTION_MAX')
      and r.valid_from <= p_date
      and (r.valid_until is null or r.valid_until >= p_date)
  );
$$;

-- ---------------------------------------------------------------------------
-- 10. RPC: servir desde el plan
-- ---------------------------------------------------------------------------

/**
 * PLANNED → SERVED. El único borde del sistema donde se mueve inventario por
 * comer.
 *
 * En UNA transacción: (a) candado `for update of a` sobre `meal_assignments`
 * (0023:243); (b) se gana la porción con un UPDATE condicionado por estado;
 * (c) recién con la fila ganada se congela el plan; (d) se descuenta FEFO;
 * (e) la comida queda SERVED.
 *
 * LA IDEMPOTENCIA ES DE ESTADO, NO DE CLAVE. Quien pierde la carrera obtiene
 * ROW_COUNT = 0 y no descuenta nada. La `idempotency_key` de los movimientos
 * es red de seguridad intra-transacción y NO el mecanismo anti-doble-descuento:
 * no puede serlo, porque el lote lo elige FEFO y FEFO no es estable en el
 * tiempo.
 *
 * `p_items` es opcional: [{ serving_component_id, served_quantity }]. Lo que no
 * venga declarado se copia del plan CONGELADO del mismo renglón, con
 * `served_quantity_is_declared = false`. El libro mayor lee siempre una sola
 * columna (`served_quantity`), sin ramas.
 */
create or replace function public.serve_meal_assignment(
  p_assignment_id uuid,
  p_items         jsonb default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_actor uuid;
  v_today date;
  v_intrusos text;
  v_proj record;
  v_comp record;
  v_record uuid;
  v_item uuid;
  v_decl jsonb;
  v_servida numeric;
  v_declarada boolean;
  v_falta numeric;
  v_n int;
  v_count int := 0;
  v_records jsonb := '[]'::jsonb;
  v_shortfalls jsonb := '[]'::jsonb;
begin
  -- Mismo candado que confirm/consume (0023): los RPC serializan sobre LA
  -- MISMA fila, así que servir mientras se confirma ya no corre en paralelo.
  select p.household_id into v_household
  from public.meal_assignments a
  join public.weekly_plan_days d on d.id = a.day_id
  join public.weekly_plans p on p.id = d.plan_id
  where a.id = p_assignment_id
  for update of a;

  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  v_actor := app.current_member_id(v_household);
  v_today := app.household_today(v_household);

  -- TODOS los uuid que vienen del cliente son de esta comida (y por lo tanto
  -- de este hogar). Un id ajeno se rechaza sin decir si existe.
  select string_agg(distinct coalesce(x.value->>'serving_component_id', '(sin id)'), ', ')
  into v_intrusos
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  where nullif(x.value->>'serving_component_id', '') is null
     or not exists (
    select 1
    from public.member_serving_components c
    join public.member_serving_projections p on p.id = c.projection_id
    where c.id = nullif(x.value->>'serving_component_id', '')::uuid
      and p.assignment_id = p_assignment_id
  );
  if v_intrusos is not null then
    raise exception 'hay renglones servidos que no pertenecen a esta comida: %', v_intrusos
      using errcode = 'check_violation';
  end if;

  for v_proj in
    select * from public.member_serving_projections
    where assignment_id = p_assignment_id and status = 'PLANNED'
  loop
    -- IDEMPOTENCIA DE ESTADO: gana la porción quien mueve la fila. El que
    -- llega segundo obtiene 0 y NO descuenta nada.
    update public.member_serving_projections
    set status = 'SERVED'
    where id = v_proj.id and status = 'PLANNED';
    get diagnostics v_n = row_count;
    if v_n = 0 then continue; end if;

    insert into public.meal_serving_records (
      household_id, member_id, kind, assignment_id, projection_id, meal_type,
      served_on, served_by,
      plan_frozen_at, plan_optimizer_version, plan_nutrition, plan_completeness,
      plan_event_effect, plan_unverifiable_constraints
    ) values (
      v_household, v_proj.member_id, 'FROM_PLAN'::public.serving_record_kind,
      p_assignment_id, v_proj.id, v_proj.meal_type,
      v_today, v_actor,
      now(), v_proj.optimizer_version,
      coalesce(v_proj.nutrition, '{}'::jsonb),
      coalesce(v_proj.completeness, '{}'::jsonb),
      v_proj.event_effect,
      -- SÓLO LA MITAD LOGÍSTICA. Copiar la lista tal cual metía
      -- 'CLINICAL:<nutriente>' en una tabla que lee todo el hogar con
      -- `app.can_access_member`, mientras su origen exige `app.medical_access`
      -- (0027:266): la misma degradación de privacidad que esta migración ya
      -- cierra para el booleano, en otra columna y con MÁS detalle — el
      -- booleano decía "hay un techo", la etiqueta dice sobre qué nutriente.
      -- Lo clínico viaja unas líneas más abajo, a la tabla con llave médica.
      app.logistic_unverifiable_constraints(v_proj.unverifiable_constraints)
    ) returning id into v_record;

    -- El hecho clínico se congela en su propia tabla, con RLS médica: el
    -- registro de servido no lo guarda y por lo tanto no lo puede filtrar.
    -- Va el booleano Y el detalle: los dos son dato médico y los dos quedan
    -- detrás de la MISMA llave que su fuente.
    perform app.freeze_clinical_ceiling(
      v_record,
      app.had_clinical_ceiling(v_proj.member_id, v_today),
      app.clinical_unverifiable_constraints(v_proj.unverifiable_constraints));

    for v_comp in
      select * from public.member_serving_components
      where projection_id = v_proj.id
        and (ingredient_id is not null or product_id is not null)
        and proposed_quantity > 0
      order by sort_order, id
    loop
      v_decl := (
        select x.value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
        where nullif(x.value->>'serving_component_id', '')::uuid = v_comp.id
        limit 1
      );

      v_declarada := (v_decl is not null and nullif(v_decl->>'served_quantity', '') is not null);
      v_servida := case when v_declarada
                        then (v_decl->>'served_quantity')::numeric
                        else v_comp.proposed_quantity end;
      perform app.assert_finite(v_servida, 'la cantidad servida');
      if v_servida < 0 then
        raise exception 'no se puede servir una cantidad negativa de "%"', v_comp.label
          using errcode = 'check_violation';
      end if;
      -- Se redondea ACÁ, antes de descontar: la columna es numeric(10,3) y si
      -- el espejo se calculara con más decimales que los guardados, deducted +
      -- shortfall = served fallaría por polvo de redondeo.
      v_servida := round(v_servida, 3);

      insert into public.meal_serving_record_items (
        record_id, serving_component_id, component_id, label,
        ingredient_id, product_id,
        planned_quantity, planned_unit, planned_weight_basis,
        planned_cooking_method, planned_added_fat_g,
        served_quantity, served_unit, served_weight_basis,
        served_quantity_is_declared, sort_order
      ) values (
        v_record, v_comp.id, v_comp.component_id, v_comp.label,
        v_comp.ingredient_id, v_comp.product_id,
        v_comp.proposed_quantity, v_comp.unit, v_comp.weight_basis,
        v_comp.cooking_method, v_comp.added_fat_g,
        v_servida, v_comp.unit::text, v_comp.weight_basis,
        v_declarada, coalesce(v_comp.sort_order, 1)
      ) returning id into v_item;

      -- Descuento físico. '0' = descuento inicial de este renglón.
      v_falta := round(app.fefo_deduct_serving_item(v_item, v_servida, v_actor, '0'), 3);
      if v_falta <= 0.001 then v_falta := 0; end if;

      update public.meal_serving_record_items
      set deducted_quantity = v_servida - v_falta,
          shortfall_quantity = v_falta
      where id = v_item;

      if v_falta > 0 then
        -- El desajuste es dato de primera clase (0012): lo servido sigue
        -- diciendo la verdad, y la diferencia queda visible hasta que alguien
        -- la resuelva.
        insert into public.consumption_shortfalls
          (household_id, serving_record_item_id, assignment_id, projection_id,
           ingredient_id, product_id, label, quantity, unit, weight_basis, serving_date)
        values
          (v_household, v_item, p_assignment_id, v_proj.id,
           v_comp.ingredient_id, v_comp.product_id, v_comp.label,
           round(v_falta, 3), v_comp.unit::text, v_comp.weight_basis, v_proj.serving_date);

        v_shortfalls := v_shortfalls || jsonb_build_object(
          'label', v_comp.label,
          'quantity', round(v_falta, 3),
          'unit', v_comp.unit::text,
          'weight_basis', v_comp.weight_basis::text);
      end if;
    end loop;

    v_records := v_records || jsonb_build_object(
      'record_id', v_record, 'member_id', v_proj.member_id);
    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    update public.meal_assignments set status = 'SERVED' where id = p_assignment_id;

    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (v_household, auth.uid(), 'MEAL_SERVED', 'meal_assignment', p_assignment_id,
            jsonb_build_object('servings', v_count));
    perform app.emit_event(v_household, 'MEAL_SERVED', 'meal_assignment',
      jsonb_build_object('assignment_id', p_assignment_id, 'servings', v_count),
      'MEAL_SERVED:' || p_assignment_id::text || ':' || v_today::text);
  end if;

  return jsonb_build_object(
    'servings', v_count, 'records', v_records, 'shortfalls', v_shortfalls);
end;
$$;

comment on function public.serve_meal_assignment(uuid, jsonb) is
  'PLANNED → SERVED. Congela el plan, escribe el registro de servido y '
  'descuenta FEFO. Idempotencia DE ESTADO: el segundo en llegar no descuenta.';

-- ---------------------------------------------------------------------------
-- 11. RPC: servir fuera del plan
-- ---------------------------------------------------------------------------

/**
 * Salió comida de la despensa sin plan detrás: se picoteó un lote, se sirvió
 * algo que no estaba planificado. Sigue siendo un acto de SERVIR y por eso
 * pasa por el mismo dueño.
 *
 * `p_quantity` NULL = el lote completo (compatibilidad con `use_lot`).
 */
create or replace function public.serve_off_plan(
  p_member_id uuid,
  p_lot_id    uuid,
  p_quantity  numeric default null,
  p_meal_type public.meal_type default null,
  p_notes     text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_lot public.inventory_lots;
  v_actor uuid;
  v_today date;
  v_q numeric;
  v_record uuid;
  v_item uuid;
begin
  -- El integrante manda el hogar; el lote tiene que ser del MISMO. Un id ajeno
  -- responde igual que uno inexistente.
  v_household := app.member_household(p_member_id);
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  select * into v_lot from public.inventory_lots where id = p_lot_id for update;
  if v_lot.id is null or v_lot.household_id <> v_household then
    raise exception 'no autorizado';
  end if;
  if v_lot.status <> 'AVAILABLE' then
    raise exception 'el lote ya está cerrado (%)', v_lot.status;
  end if;

  v_q := coalesce(p_quantity, v_lot.quantity);
  perform app.assert_finite(v_q, 'la cantidad usada');
  if v_q <= 0 or v_q > v_lot.quantity then
    raise exception 'la cantidad usada (%) no calza con el lote (%)', v_q, v_lot.quantity;
  end if;
  -- 3 decimales, los mismos que guarda la columna: el espejo del ledger no
  -- puede calcularse con más precisión de la que se persiste.
  v_q := round(v_q, 3);

  v_actor := app.current_member_id(v_household);
  v_today := app.household_today(v_household);

  insert into public.meal_serving_records (
    household_id, member_id, kind, meal_type, served_on, served_by, notes
  ) values (
    v_household, p_member_id, 'OFF_PLAN'::public.serving_record_kind,
    p_meal_type, v_today, v_actor,
    nullif(trim(coalesce(p_notes, '')), '')
  ) returning id into v_record;

  -- Mismo criterio que al servir desde el plan: el hecho clínico va a su
  -- tabla con RLS médica, nunca al registro que lee todo el hogar.
  perform app.freeze_clinical_ceiling(
    v_record, app.had_clinical_ceiling(p_member_id, v_today));

  -- Sin plan detrás: TODO el bloque planificado queda NULL. Escribir cero diría
  -- "el plan pedía cero", que es otra cosa.
  insert into public.meal_serving_record_items (
    record_id, label, ingredient_id, product_id,
    served_quantity, served_unit, served_weight_basis,
    served_quantity_is_declared, sort_order
  ) values (
    v_record, v_lot.label, v_lot.ingredient_id, v_lot.product_id,
    v_q, v_lot.unit, v_lot.weight_basis, true, 1
  ) returning id into v_item;

  -- Fuera de plan el lote NO lo elige FEFO: lo eligió la persona. El
  -- movimiento va contra ESE lote, con su renglón detrás como todos.
  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, idempotency_key,
     serving_record_item_id, covers_quantity, actor_member_id, notes)
  values
    (v_household, p_lot_id, 'CONSUMED', -v_q,
     'SERVE:' || v_item::text || ':' || p_lot_id::text || ':0',
     v_item, -v_q, v_actor, nullif(trim(coalesce(p_notes, '')), ''));

  -- Fuera de plan no hay faltante posible: el descuento se hizo contra el lote
  -- elegido y ya se validó que alcanzaba.
  update public.meal_serving_record_items
  set deducted_quantity = v_q, shortfall_quantity = 0
  where id = v_item;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_household, auth.uid(), 'OFF_PLAN_SERVED', 'meal_serving_record', v_record,
          jsonb_build_object('lot_id', p_lot_id, 'quantity', v_q, 'unit', v_lot.unit));
  perform app.emit_event(v_household, 'OFF_PLAN_SERVED', 'meal_serving_record',
    jsonb_build_object('record_id', v_record, 'member_id', p_member_id, 'lot_id', p_lot_id),
    'OFF_PLAN_SERVED:' || v_record::text);

  return v_record;
end;
$$;

comment on function public.serve_off_plan(uuid, uuid, numeric, public.meal_type, text) is
  'Sacar comida de la despensa sin plan detrás sigue siendo SERVIR: crea un '
  'registro OFF_PLAN con su renglón, que es lo que autoriza el descuento.';

-- ---------------------------------------------------------------------------
-- 12. `use_lot` deja de ser un segundo dueño
-- ---------------------------------------------------------------------------

/**
 * `use_lot` v2 (redefine 0015:1019).
 *
 * La v1 escribía un movimiento CONSUMED sin registro, sin integrante y sin
 * porción: era un segundo dueño silencioso del efecto físico que ningún
 * documento había nombrado. Con FoodLog encima, un registro fuera de plan más
 * un `use_lot` de la v1 era un doble descuento invisible.
 *
 * La firma no cambia (el QR de la despensa sigue llamando igual): lo que
 * cambia es que ahora pasa por `serve_off_plan`, o sea por EL dueño. Quien usa
 * el lote queda como el integrante que lo sirvió; si fue para otra persona, se
 * llama `serve_off_plan` directo.
 */
create or replace function public.use_lot(
  p_lot_id   uuid,
  p_quantity numeric default null,
  p_notes    text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_household uuid; v_member uuid;
begin
  select household_id into v_household from public.inventory_lots where id = p_lot_id;
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  v_member := app.current_member_id(v_household);
  if v_member is null then raise exception 'no autorizado'; end if;

  -- p_quantity NULL viaja tal cual: serve_off_plan resuelve "el lote completo"
  -- YA con el candado tomado, así que no hay carrera entre leer y descontar.
  perform public.serve_off_plan(v_member, p_lot_id, p_quantity, null, p_notes);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. `consume_planned_meal` deja de fabricar realidad
-- ---------------------------------------------------------------------------

/**
 * `consume_planned_meal` v6 (redefine 0023:230): envoltorio de compatibilidad
 * que SOLO SIRVE.
 *
 * Deja de escribir `consumption_logs` (eso ahora lo declara un humano en
 * 0034), deja de escribir el estado CONSUMED y deja de saltar PLANNED →
 * CONSUMED de una. Servir no es comer: son dos hechos y ahora tienen dos
 * dueños. Se mantiene el nombre y la forma del resultado para no romper a
 * quien ya lo llama.
 */
create or replace function public.consume_planned_meal(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_r jsonb;
begin
  v_r := public.serve_meal_assignment(p_assignment_id, null);
  return jsonb_build_object(
    'servings',   v_r->'servings',
    'shortfalls', v_r->'shortfalls',
    'records',    v_r->'records',
    'note',       'servido, no consumido: la declaración de consumo la hace una persona con log_intake');
end;
$$;

comment on function public.consume_planned_meal(uuid) is
  'Compatibilidad: SOLO sirve. No escribe consumption_logs ni el estado '
  'CONSUMED. PLAN != REALIDAD, y el sistema dejó de inventar la segunda.';

-- ---------------------------------------------------------------------------
-- 14. Corregir lo servido
-- ---------------------------------------------------------------------------

/**
 * "En realidad sirvió otra cantidad". Acá SÍ hay física, y se resuelve leyendo
 * el libro mayor, no estimando:
 *
 *  · Si la cantidad nueva es MENOR: primero se borra el faltante (esos gramos
 *    nunca salieron de la despensa) y recién después se devuelve en LIFO al
 *    MISMO LOTE del que salió cada gramo.
 *  · Si es MAYOR: se descuenta la diferencia por FEFO con el MISMO renglón; lo
 *    que no alcance se declara como faltante (0012).
 *
 * `p_correction_id` permite reintentar la misma corrección sin duplicar nada
 * (las claves de reversión se derivan de él). Si no viene, se genera: el tope
 * del trigger sobre el saldo no revertido igual impide devolver de más.
 */
create or replace function public.correct_serving_item(
  p_item_id             uuid,
  p_new_served_quantity numeric,
  p_reason              text,
  p_correction_id       uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item public.meal_serving_record_items;
  v_rec public.meal_serving_records;
  v_household uuid;
  v_actor uuid;
  v_corr uuid;
  v_nueva numeric;
  v_delta numeric;
  v_reduccion numeric;
  v_de_falta numeric;
  v_de_deducido numeric;
  v_saldo_devolvible numeric;
  v_devuelto numeric := 0;
  v_falta_extra numeric := 0;
  v_sf record;
  v_resta numeric;
  v_toma numeric;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'corregir lo servido exige decir por qué: una corrección muda es historia borrada';
  end if;

  select * into v_item from public.meal_serving_record_items
  where id = p_item_id for update;
  if v_item.id is null then raise exception 'no autorizado'; end if;

  select * into v_rec from public.meal_serving_records
  where id = v_item.record_id for update;
  if v_rec.id is null or not app.is_household_member(v_rec.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_rec.status <> 'ACTIVE' then
    raise exception 'ese registro de servido está anulado: no hay nada que corregir'
      using errcode = 'check_violation';
  end if;

  v_household := v_rec.household_id;
  v_actor := app.current_member_id(v_household);
  v_corr := coalesce(p_correction_id, gen_random_uuid());

  perform app.assert_finite(p_new_served_quantity, 'la cantidad servida');
  if p_new_served_quantity is null or p_new_served_quantity < 0 then
    raise exception 'la cantidad servida corregida no puede ser negativa';
  end if;

  -- Mismo motivo que al servir: el espejo se calcula con los 3 decimales que
  -- efectivamente se guardan, no con los que trajo el cliente.
  v_nueva := round(p_new_served_quantity, 3);
  v_delta := v_nueva - v_item.served_quantity;
  if abs(v_delta) <= 0.001 then
    return jsonb_build_object('changed', false, 'item_id', p_item_id);   -- idempotente
  end if;

  if v_delta < 0 then
    v_reduccion := -v_delta;

    -- Primero se descuenta del FALTANTE: esos gramos jamás salieron del lote,
    -- así que corregir a la baja no tiene por qué devolver nada por ellos.
    v_de_falta := least(v_reduccion, v_item.shortfall_quantity);
    v_de_deducido := v_reduccion - v_de_falta;

    -- PRESUPUESTO FÍSICO, GASTADO UNA SOLA VEZ. De los gramos que este renglón
    -- sacó de verdad de la despensa, los que ya se declararon basura NO pueden
    -- volver. Corregir a la baja, devolver al refrigerador y botar comen del
    -- MISMO saldo: `deducted_quantity` − `discarded_quantity`.
    --
    -- La basura se imputa contra los gramos CON respaldo en el libro mayor y no
    -- contra el faltante, a propósito: cuando el sistema no puede saber si lo
    -- botado eran gramos reales o gramos que nunca alcanzaron a salir, elige la
    -- lectura que jamás infla la despensa. El supuesto contrario sería fabricar
    -- inventario por el lado cómodo de la duda.
    --
    -- Y antes que el saldo, la coherencia gruesa: nadie pudo botar más de lo
    -- que sirvió. Si el servido corregido queda por debajo de la basura ya
    -- declarada, la corrección y la merma se contradicen —y el sistema no
    -- elige cuál de las dos es verdad: se detiene. (El CHECK
    -- `serving_item_discard_within_served` es la misma pared en la tabla; acá
    -- el mensaje explica qué pasó en vez de escupir un nombre de constraint.)
    if v_nueva < v_item.discarded_quantity - 0.001 then
      raise exception
        'el renglón "%" ya tiene % declarados basura: corregir lo servido a % diría que se botó comida que nunca salió a la mesa',
        v_item.label, v_item.discarded_quantity, v_nueva
        using errcode = 'check_violation';
    end if;

    v_saldo_devolvible := greatest(
      v_item.deducted_quantity - v_item.discarded_quantity, 0);
    if v_de_deducido > v_saldo_devolvible + 0.001 then
      raise exception
        'el renglón "%" sacó % de la despensa y ya declaró % basura: solo quedan % por devolver y esta corrección pide %',
        v_item.label, v_item.deducted_quantity, v_item.discarded_quantity,
        v_saldo_devolvible, v_de_deducido
        using errcode = 'check_violation';
    end if;

    -- Los desajustes abiertos de este renglón se achican en el mismo acto: un
    -- faltante que ya no existe no puede seguir pidiendo compra.
    v_resta := v_de_falta;
    for v_sf in
      select * from public.consumption_shortfalls
      where serving_record_item_id = p_item_id and status = 'OPEN'
      order by created_at desc
      for update
    loop
      exit when v_resta <= 0;
      v_toma := least(v_resta, v_sf.quantity);
      if v_sf.quantity - v_toma <= 0.0005 then
        update public.consumption_shortfalls
        set status = 'RESOLVED_ADJUSTMENT',
            resolved_by = v_actor, resolved_at = now()
        where id = v_sf.id;
      else
        update public.consumption_shortfalls
        set quantity = round(v_sf.quantity - v_toma, 3)
        where id = v_sf.id;
      end if;
      v_resta := v_resta - v_toma;
    end loop;

    if v_de_deducido > 0 then
      v_devuelto := round(app.reverse_serving_item(
        p_item_id, v_de_deducido, v_actor, v_corr,
        'corrección de lo servido: ' || trim(p_reason)), 3);
    end if;

    -- `deducted_quantity` ES, por construcción, la suma de las coberturas no
    -- revertidas: siempre alcanza para devolver lo que se pide. Si algún día
    -- no alcanza, el espejo y el libro mayor se separaron y eso NO se arregla
    -- en silencio — se detiene la transacción y queda a la vista.
    if v_de_deducido - v_devuelto > 0.001 then
      raise exception
        'el libro mayor solo pudo devolver % de los % descontados del renglón "%": espejo y ledger divergen',
        v_devuelto, v_de_deducido, v_item.label
        using errcode = 'check_violation';
    end if;

    update public.meal_serving_record_items
    set served_quantity    = v_nueva,
        deducted_quantity  = deducted_quantity - v_devuelto,
        shortfall_quantity = shortfall_quantity - v_de_falta,
        reversed_quantity  = reversed_quantity + v_devuelto,
        served_quantity_is_declared = true
    where id = p_item_id;

  else
    -- Corrección al alza: se descuenta la diferencia igual que al servir, con
    -- el MISMO renglón. El sufijo separa esta corrección del descuento inicial.
    --
    -- LA CANTIDAD NUEVA SE ESCRIBE ANTES DE DESCONTAR, y no es cosmético: el
    -- tope por renglón del candado (bloque 4, (4b)) mide cada CONSUMED contra
    -- `served_quantity`. Si el renglón todavía dijera 200 mientras entra el
    -- movimiento que lo lleva a 300, la corrección se rechazaría sola. La
    -- invariante deducted + shortfall = served aguanta el paso intermedio
    -- porque `serving_item_balance_invariant` es DEFERRABLE: se verifica al
    -- cierre de la transacción, cuando las tres columnas ya cuadran.
    update public.meal_serving_record_items
    set served_quantity = v_nueva,
        served_quantity_is_declared = true
    where id = p_item_id;

    v_falta_extra := round(app.fefo_deduct_serving_item(
      p_item_id, v_delta, v_actor, 'C' || replace(v_corr::text, '-', '')), 3);
    if v_falta_extra <= 0.001 then v_falta_extra := 0; end if;

    update public.meal_serving_record_items
    set deducted_quantity  = deducted_quantity + (v_delta - v_falta_extra),
        shortfall_quantity = shortfall_quantity + v_falta_extra
    where id = p_item_id;

    if v_falta_extra > 0 then
      insert into public.consumption_shortfalls
        (household_id, serving_record_item_id, assignment_id, projection_id,
         ingredient_id, product_id, label, quantity, unit, weight_basis, serving_date)
      values
        (v_household, p_item_id, v_rec.assignment_id, v_rec.projection_id,
         v_item.ingredient_id, v_item.product_id, v_item.label,
         round(v_falta_extra, 3), v_item.served_unit, v_item.served_weight_basis,
         v_rec.served_on);
    end if;
  end if;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_household, auth.uid(), 'SERVING_ITEM_CORRECTED', 'meal_serving_record_item', p_item_id,
          jsonb_build_object('antes', v_item.served_quantity,
                             'ahora', v_nueva,
                             'devuelto', v_devuelto,
                             'faltante_nuevo', v_falta_extra,
                             'reason', trim(p_reason)));
  perform app.emit_event(v_household, 'SERVING_ITEM_CORRECTED', 'meal_serving_record_item',
    jsonb_build_object('item_id', p_item_id, 'record_id', v_item.record_id,
                       'antes', v_item.served_quantity, 'ahora', v_nueva),
    'SERVING_ITEM_CORRECTED:' || p_item_id::text || ':' || v_corr::text);

  return jsonb_build_object(
    'changed', true,
    'item_id', p_item_id,
    'antes', v_item.served_quantity,
    'ahora', v_nueva,
    'devuelto_al_inventario', v_devuelto,
    'faltante_nuevo', v_falta_extra,
    'correction_id', v_corr);
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. Anular el servido completo — SERVED → PLANNED
-- ---------------------------------------------------------------------------

/**
 * "Esto nunca se sirvió, me equivoqué".
 *
 * Revierte TODO el efecto físico por el mismo camino LIFO, marca el registro
 * VOIDED y devuelve la porción a PLANNED. Como el índice único de
 * `meal_serving_records` es parcial sobre status='ACTIVE', volver a servir
 * después crea un registro nuevo y limpio.
 *
 * Prohibido si hay una declaración de consumo VIVA: primero se anula la
 * declaración (`void_intake_log`, 0034) y después el servido. El orden importa
 * porque la declaración se apoya en renglones que acá desaparecen del mapa.
 *
 * OJO con lo que esto NO es: anular es "no ocurrió". Si la comida SÍ salió y
 * simplemente no se comió, eso es otra cosa — `return_serving_to_inventory` si
 * volvió al refrigerador, `discard_serving` si se botó. El sistema jamás decide
 * solo cuál de las dos pasó.
 */
create or replace function public.void_serving_record(
  p_record_id     uuid,
  p_reason        text,
  p_correction_id uuid default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_rec public.meal_serving_records;
  v_actor uuid;
  v_corr uuid;
  v_item record;
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'anular un servido exige decir por qué';
  end if;

  select * into v_rec from public.meal_serving_records where id = p_record_id for update;
  if v_rec.id is null or not app.is_household_member(v_rec.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_rec.status = 'VOIDED' then return; end if;   -- idempotente

  if app.serving_record_has_active_intake(p_record_id) then
    raise exception
      'esta porción tiene una declaración de consumo viva: anula primero la declaración'
      using errcode = 'check_violation';
  end if;

  -- Anular es "esto nunca se sirvió". Una merma declarada dice exactamente lo
  -- contrario: alguien vio esa comida en el plato y la botó. Las dos historias
  -- no pueden ser verdad, y el sistema no elige por su cuenta cuál lo es: se
  -- detiene y pide que primero se corrija la merma (`undo_discard_serving`).
  -- Sin esta guarda, la anulación moría igual —contra el presupuesto físico de
  -- `correct_serving_item`— pero con un mensaje que hablaba de saldos y no de
  -- lo que realmente pasó.
  if exists (
    select 1 from public.meal_serving_record_items
    where record_id = p_record_id and discarded_quantity > 0.001
  ) then
    raise exception
      'este servido tiene merma declarada: si de verdad nunca se sirvió, esa merma tampoco existió — anúlala con undo_discard_serving antes de anular el servido'
      using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_rec.household_id);
  v_corr := coalesce(p_correction_id, gen_random_uuid());

  for v_item in
    select id from public.meal_serving_record_items
    where record_id = p_record_id order by sort_order, id
  loop
    perform public.correct_serving_item(v_item.id, 0, 'anulación: ' || trim(p_reason), v_corr);
  end loop;

  update public.meal_serving_records
  set status = 'VOIDED', void_reason = trim(p_reason),
      voided_at = now(), voided_by = v_actor
  where id = p_record_id;

  -- La porción vuelve a estar disponible para servirse de verdad.
  if v_rec.projection_id is not null then
    update public.member_serving_projections
    set status = 'PLANNED'
    where id = v_rec.projection_id and status = 'SERVED';
  end if;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_rec.household_id, auth.uid(), 'SERVING_RECORD_VOIDED', 'meal_serving_record',
          p_record_id, jsonb_build_object('reason', trim(p_reason)));
  perform app.emit_event(v_rec.household_id, 'SERVING_RECORD_VOIDED', 'meal_serving_record',
    jsonb_build_object('record_id', p_record_id, 'member_id', v_rec.member_id),
    'SERVING_RECORD_VOIDED:' || p_record_id::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. Se sirvió y no se comió: dos caminos, jamás inferidos
-- ---------------------------------------------------------------------------
--
-- El inventario NO se devuelve solo. La comida ya salió de la despensa y el
-- sistema no tiene cómo saber si volvió al refrigerador o al basurero.
-- Inventar la devolución sería fabricar realidad por el otro lado.

/**
 * Cuánto de un renglón servido está comprometido por declaraciones de consumo
 * VIVAS — o sea, cuántos de esos gramos alguien ya dijo que se comió.
 *
 * HALLAZGO que la trajo, corriendo los ataques del sprint contra estas dos
 * migraciones ANTES de aplicarlas:
 *
 *   B1 · servir 200 g, declarar que se comieron los 200, y devolver 200 g al
 *        refrigerador. La devolución PASABA: el lote volvía a su saldo
 *        original, como si nada hubiera salido, y la declaración seguía viva
 *        diciendo que esa persona comió 200 g. La misma comida en dos lugares.
 *   B2 · lo mismo contra la basura: comido Y botado, los dos verdaderos.
 *
 * La causa está a la vista en el comentario de `void_serving_record`, que sí
 * trae su guarda: "si la comida SÍ salió y simplemente no se comió, eso es otra
 * cosa — `return_serving_to_inventory` o `discard_serving`". El razonamiento es
 * correcto y está incompleto: contempla que la comida no se haya comido, no que
 * ALGUIEN YA HAYA DICHO QUE SÍ. La guarda se puso en una puerta y quedaron dos
 * abiertas.
 *
 * La regla es la conservación de esta misma migración extendida al eje nuevo:
 * los gramos que salieron se gastan UNA vez, y ahora hay TRES formas de
 * gastarlos —comerlos, devolverlos, botarlos— que comen del mismo saldo:
 *
 *     servido − botado − declarado comido = lo que todavía puede volver
 *
 * La devolución parcial legítima no se toca, que es lo que importa: se sirven
 * 200, se declaran 120 comidos, vuelven 80. Eso pasa todos los días.
 *
 * SE RESUELVE EN TIEMPO DE EJECUCIÓN, igual que
 * `app.serving_record_has_active_intake`: `intake_log_items` nace en la 0038 y
 * esta migración va antes. Mientras no exista, no hay nada declarado y la
 * respuesta es 0 sin mentir.
 *
 * `extent = 'ALL'` compromete TODO lo que quedaba aunque no traiga número: "me
 * lo comí entero" es una afirmación sobre la porción completa, y tratarla como
 * cero por no venir con gramos sería exactamente el vacío leído como cero que
 * este sprint existe para impedir.
 *
 * Solo suman los renglones cuya unidad y base física CALZAN con las del
 * servido. Un renglón declarado en unidades contra un servido en gramos no se
 * convierte a la fuerza: se ignora, porque un factor inventado acá le pondría
 * un tope falso a una devolución legítima.
 */
create or replace function app.declared_from_serving_item(p_item_id uuid)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  v_item public.meal_serving_record_items;
  v_todo boolean;
  v_suma numeric;
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'intake_log_items'
  ) then
    return 0;
  end if;

  select * into v_item from public.meal_serving_record_items where id = p_item_id;
  if v_item.id is null then return 0; end if;

  execute
    'select bool_or(x.extent::text = ''ALL''),
            coalesce(sum(x.quantity) filter (
              where x.quantity is not null
                and x.unit = $2
                and x.weight_basis = $3
            ), 0)
     from public.intake_log_items x
     join public.consumption_logs l on l.id = x.log_id
     where x.serving_record_item_id = $1
       and l.status::text = ''ACTIVE'''
  into v_todo, v_suma
  using p_item_id, v_item.served_unit, v_item.served_weight_basis;

  if coalesce(v_todo, false) then
    return greatest(v_item.served_quantity - v_item.discarded_quantity, 0);
  end if;
  return coalesce(v_suma, 0);
end;
$$;

comment on function app.declared_from_serving_item(uuid) is
  'Gramos de un renglón servido ya comprometidos por declaraciones de consumo '
  'vivas. `extent ALL` compromete el resto entero: sin número no significa cero. '
  'Devuelve 0 mientras `intake_log_items` no exista (la crea la 0038).';

/**
 * Volvió al MISMO LOTE del que salió. Es, exactamente, una corrección de lo
 * servido: "sirvió 200, volvieron 80, entonces realmente sirvió 120". Por eso
 * reutiliza `correct_serving_item` — y por eso la invariante
 * deducted + shortfall = served sobrevive sin columnas nuevas.
 */
create or replace function public.return_serving_to_inventory(
  p_item_id  uuid,
  p_quantity numeric,
  p_reason   text default 'volvió al refrigerador'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item public.meal_serving_record_items;
  v_household uuid;
  v_declarado numeric;
  v_libre numeric;
begin
  -- EL HOGAR SE VALIDA ANTES QUE CUALQUIER MENSAJE QUE NOMBRE GRAMOS.
  --
  -- Los dos errores de más abajo citan `served_quantity` y `discarded_quantity`:
  -- gramos reales de una porción real. La autorización de verdad la hacía
  -- `correct_serving_item`, o sea DESPUÉS — y eso convertía esta función en un
  -- oráculo que contesta en gramos: bastaba pedir la devolución de una cantidad
  -- absurda sobre el id de un renglón de OTRA casa para que el texto del error
  -- dijera cuánto se sirvió ahí y cuánto se botó. Ni siquiera hacía falta
  -- adivinar el número: el mensaje lo regala.
  --
  -- La regla del sprint es que un recurso ajeno y uno inexistente contesten lo
  -- MISMO ('no autorizado'), y para que eso sea cierto el chequeo tiene que ir
  -- PRIMERO. `correct_serving_item` lo vuelve a hacer igual: una función
  -- SECURITY DEFINER que confía en su llamador es una función que no valida.
  select * into v_item from public.meal_serving_record_items where id = p_item_id;
  if v_item.id is null then raise exception 'no autorizado'; end if;

  select household_id into v_household
  from public.meal_serving_records where id = v_item.record_id;
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  perform app.assert_finite(p_quantity, 'la cantidad devuelta');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'devolver exige una cantidad positiva';
  end if;
  if p_quantity > v_item.served_quantity + 0.001 then
    raise exception 'no se puede devolver más de lo que salió (% de %)',
      p_quantity, v_item.served_quantity using errcode = 'check_violation';
  end if;
  -- Lo que ya se declaró basura no está en la mesa esperando volver: está en el
  -- basurero. `correct_serving_item` vuelve a medir el saldo contra el libro
  -- mayor —y el candado del trigger otra vez encima— pero el error tiene que
  -- hablar en la lengua de quien está devolviendo, no en la de los espejos.
  if p_quantity > v_item.served_quantity - v_item.discarded_quantity + 0.001 then
    raise exception
      'de los % servidos ya se declararon % botados: solo quedan % que puedan volver al inventario',
      v_item.served_quantity, v_item.discarded_quantity,
      greatest(v_item.served_quantity - v_item.discarded_quantity, 0)
      using errcode = 'check_violation';
  end if;

  -- LA TERCERA FORMA DE GASTAR LA PORCIÓN. Los dos topes de arriba miran lo
  -- servido y lo botado; faltaba lo que alguien ya declaró que se comió. Sin
  -- esto, declarar que se comió todo y después devolverlo al refrigerador
  -- pasaba, y la misma comida quedaba en el plato de una persona y adentro del
  -- refrigerador a la vez.
  v_declarado := app.declared_from_serving_item(p_item_id);
  v_libre := greatest(v_item.served_quantity - v_item.discarded_quantity - v_declarado, 0);
  if v_declarado > 0.001 and p_quantity > v_libre + 0.001 then
    raise exception
      'de los % servidos hay % declarados comidos: al refrigerador solo pueden volver %. Si la declaración está mal, corrígela o anúlala primero — el sistema no elige por su cuenta si esa comida se comió o volvió',
      v_item.served_quantity, v_declarado, v_libre
      using errcode = 'check_violation';
  end if;

  return public.correct_serving_item(
    p_item_id, v_item.served_quantity - p_quantity, trim(coalesce(p_reason, 'devolución')), null);
end;
$$;

/**
 * Cuánto pesa, EN LA UNIDAD DEL LOTE, una unidad del renglón servido.
 *
 * No calcula nada: LEE. Cada CONSUMED de este renglón contra este lote congeló
 * las dos lenguas a la vez —`delta` en la del lote y `covers_quantity` en la
 * del renglón— así que el factor de ayer ya está escrito. Reconstruirlo desde
 * `ingredient_yields` sería inventar el rendimiento de ayer con los datos de
 * hoy: esa tabla admite override por hogar y por método, y cambia.
 *
 * Se acota AL LOTE porque la merma se anota contra UN lote: un renglón servido
 * mitad de un lote COOKED y mitad de uno RAW tiene dos factores, y el promedio
 * de los dos no habla ninguna de las dos lenguas.
 *
 * Devuelve NULL cuando no hay de dónde leerlo. NULL es "no sé" y quien llama
 * tiene que tratarlo como tal: acá no hay 1:1 por defecto.
 */
create or replace function app.serving_lot_factor(p_item_id uuid, p_lot_id uuid)
returns numeric language sql stable set search_path = public as $$
  select sum(abs(m.delta)) / nullif(sum(abs(m.covers_quantity)), 0)
  from public.inventory_movements m
  where m.serving_record_item_id = p_item_id
    and m.lot_id = p_lot_id
    and m.reason = 'CONSUMED';
$$;

comment on function app.serving_lot_factor(uuid, uuid) is
  'Factor congelado renglón→lote, leído del libro mayor. NULL = no se sabe, y '
  'no se inventa 1:1.';

/**
 * Se botó. Los gramos se perdieron DE VERDAD, así que acá no se revierte nada:
 * el lote ya pagó al servir. El movimiento se escribe con delta 0 —volver a
 * restar sería el doble descuento que toda esta migración existe para
 * impedir— y la cantidad viaja en `covers_quantity`, que es justamente "cuánto
 * del renglón servido cubre este movimiento".
 *
 * PERO botar SÍ gasta presupuesto, y por eso esta función escribe también en el
 * espejo. Un renglón que sirvió 200 sacó 200 gramos reales de la despensa, y
 * esos 200 gramos vuelven UNA sola vez: o corrigiendo lo servido, o
 * devolviéndolos al refrigerador, o —esta función— declarándolos basura. Los
 * tres caminos comen del mismo saldo.
 *
 * La versión anterior anotaba la merma y no tocaba `deducted_quantity`, así que
 * botar 200 y después devolver 200 era perfectamente legal: la misma comida
 * salía del inventario una vez y volvía dos, con la mitad de ella en el
 * basurero. El descuadre no era del espejo: era comida que la despensa creía
 * tener y no existía.
 *
 * `p_discard_id` permite reintentar la misma merma sin declararla dos veces
 * (una merma declarada dos veces gasta el doble de presupuesto). Si no viene se
 * genera uno: el tope acumulado del trigger igual impide botar más de lo
 * servido.
 */
create or replace function public.discard_serving(
  p_item_id    uuid,
  p_quantity   numeric,
  p_reason     text default null,
  p_discard_id uuid default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item public.meal_serving_record_items;
  v_rec public.meal_serving_records;
  v_lot uuid;
  v_actor uuid;
  v_disc uuid;
  v_key text;
  v_saldo numeric;
  v_factor numeric;
  v_declarado numeric;
begin
  -- `for update` no es decorativo: serializa dos mermas simultáneas sobre el
  -- mismo renglón. Sin el lock, las dos leen `discarded_quantity` = 0 y las dos
  -- pasan el tope acumulado.
  select * into v_item from public.meal_serving_record_items where id = p_item_id for update;
  if v_item.id is null then raise exception 'no autorizado'; end if;

  select * into v_rec from public.meal_serving_records where id = v_item.record_id;
  if v_rec.id is null or not app.is_household_member(v_rec.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_rec.status <> 'ACTIVE' then
    raise exception 'ese registro de servido está anulado' using errcode = 'check_violation';
  end if;

  perform app.assert_finite(p_quantity, 'la cantidad botada');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'botar exige una cantidad positiva' using errcode = 'check_violation';
  end if;

  v_disc := coalesce(p_discard_id, gen_random_uuid());
  v_key  := 'DISCARD:' || p_item_id::text || ':' || v_disc::text;

  -- Idempotencia: el mismo id de merma no se declara dos veces. Se pregunta
  -- antes de gastar saldo, no después de chocar contra el índice único.
  if exists (select 1 from public.inventory_movements where idempotency_key = v_key) then
    return;
  end if;

  -- TOPE ACUMULADO. No es "esta merma cabe en lo servido" sino "la suma de las
  -- mermas cabe en lo servido": botar 200 dos veces sobre un renglón de 200
  -- dejaba 400 gramos de basura declarada, y por lo tanto un presupuesto de
  -- devolución en negativo.
  v_saldo := v_item.served_quantity - v_item.discarded_quantity;
  if p_quantity > v_saldo + 0.001 then
    raise exception
      'la merma (%) no calza: el renglón sirvió % y ya tiene % declarados basura, quedan %',
      p_quantity, v_item.served_quantity, v_item.discarded_quantity, greatest(v_saldo, 0)
      using errcode = 'check_violation';
  end if;

  -- Y lo declarado comido gasta el mismo saldo que la basura. Declarar que se
  -- comió todo y después botar esos mismos gramos era legal: la comida quedaba
  -- comida Y en el basurero, y el informe de desperdicio sumaba una merma que
  -- nunca existió.
  v_declarado := app.declared_from_serving_item(p_item_id);
  if v_declarado > 0.001 and p_quantity > greatest(v_saldo - v_declarado, 0) + 0.001 then
    raise exception
      'de los % servidos hay % declarados comidos: a la basura solo pueden ir %. Lo que alguien dijo que se comió no está en el basurero',
      v_item.served_quantity, v_declarado, greatest(v_saldo - v_declarado, 0)
      using errcode = 'check_violation';
  end if;

  -- Se anota contra el lote del que efectivamente salió (el último), para que
  -- la merma quede trazable hasta su origen.
  select m.lot_id into v_lot from public.inventory_movements m
  where m.serving_record_item_id = p_item_id and m.reason = 'CONSUMED'
  order by m.created_at desc, m.id desc limit 1;

  if v_lot is null then
    raise exception 'este renglón nunca salió de un lote: no hay merma que anotar'
      using errcode = 'check_violation';
  end if;

  -- CUÁNTO PESA ESTO EN LA DESPENSA. El `delta` va en 0 —el lote ya pagó al
  -- servir— pero el informe de desperdicio tiene que poder sumar esta merma
  -- junto a la de la despensa, y para eso las dos tienen que hablar la lengua
  -- del LOTE. El factor se lee del CONSUMED que sacó estos gramos, donde quedó
  -- congelado; sin factor no hay conversión inventada, porque suponer 1:1 es
  -- "compensar una cantidad que el sistema no sabe" con mejor disfraz.
  v_factor := app.serving_lot_factor(p_item_id, v_lot);
  if v_factor is null then
    raise exception
      'no se puede pesar esta merma: el libro mayor no dice cuánto sacó este renglón de ese lote'
      using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_rec.household_id);

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, idempotency_key,
     serving_record_item_id, covers_quantity, waste_lot_quantity, actor_member_id, notes)
  values
    (v_rec.household_id, v_lot, 'DISCARDED_LEFTOVER', 0, v_key,
     p_item_id, -p_quantity, -round(p_quantity * v_factor, 3), v_actor,
     coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'se sirvió y se botó'));

  -- El espejo del basurero. `deducted_quantity` NO se toca: los gramos siguen
  -- estando fuera de la despensa, que es justamente lo que dice. Lo que cambia
  -- es que ya no pueden volver, y eso lo dice esta columna.
  update public.meal_serving_record_items
  set discarded_quantity = round(discarded_quantity + p_quantity, 3)
  where id = p_item_id;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_rec.household_id, auth.uid(), 'SERVING_DISCARDED', 'meal_serving_record_item',
          p_item_id, jsonb_build_object('quantity', p_quantity, 'unit', v_item.served_unit,
                                        'discard_id', v_disc));
  perform app.emit_event(v_rec.household_id, 'SERVING_DISCARDED', 'meal_serving_record_item',
    jsonb_build_object('item_id', p_item_id, 'quantity', p_quantity),
    'SERVING_DISCARDED:' || p_item_id::text || ':' || v_disc::text);
end;
$$;

comment on function public.discard_serving(uuid, numeric, text, uuid) is
  'Se sirvió y se botó: merma declarada, sin devolución. NO vuelve a descontar '
  'porque el lote ya pagó al servir, pero SÍ gasta el saldo devolvible: lo que '
  'está en la basura no vuelve al inventario por ningún otro camino. Y SÍ pesa '
  'en el informe de desperdicio, vía waste_lot_quantity.';

/**
 * "Me equivoqué: eso no se botó".
 *
 * Existe porque la merma pasó a gastar presupuesto, y un saldo que solo se
 * puede gastar es una trampa: un dedo mal puesto congelaba el renglón para
 * siempre (no se podía devolver, no se podía corregir a la baja, no se podía
 * anular el servido). Anular la merma NO mueve un gramo de inventario —la
 * comida nunca volvió al lote, el delta sigue siendo 0— sino que devuelve al
 * renglón el derecho a decidir qué pasó con esos gramos.
 *
 * La historia no se borra: la merma original queda en el libro mayor y la
 * anulación se escribe como una fila más, con `covers_quantity` POSITIVO. El
 * neto firmado de las filas DISCARDED_LEFTOVER es "cuánto de este renglón está
 * en la basura", y el candado del trigger lo mide ahí, no en el espejo.
 */
create or replace function public.undo_discard_serving(
  p_item_id  uuid,
  p_quantity numeric,
  p_reason   text default null,
  p_undo_id  uuid default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item public.meal_serving_record_items;
  v_rec public.meal_serving_records;
  v_lot uuid;
  v_actor uuid;
  v_undo uuid;
  v_key text;
  v_peso numeric;
  v_cobertura numeric;
  v_factor numeric;
begin
  select * into v_item from public.meal_serving_record_items where id = p_item_id for update;
  if v_item.id is null then raise exception 'no autorizado'; end if;

  select * into v_rec from public.meal_serving_records where id = v_item.record_id;
  if v_rec.id is null or not app.is_household_member(v_rec.household_id) then
    raise exception 'no autorizado';
  end if;
  if v_rec.status <> 'ACTIVE' then
    raise exception 'ese registro de servido está anulado' using errcode = 'check_violation';
  end if;

  perform app.assert_finite(p_quantity, 'la cantidad de merma anulada');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'anular una merma exige una cantidad positiva'
      using errcode = 'check_violation';
  end if;
  if p_quantity > v_item.discarded_quantity + 0.001 then
    raise exception
      'este renglón tiene % declarados basura: no se pueden anular %',
      v_item.discarded_quantity, p_quantity
      using errcode = 'check_violation';
  end if;

  v_undo := coalesce(p_undo_id, gen_random_uuid());
  v_key  := 'UNDISCARD:' || p_item_id::text || ':' || v_undo::text;
  if exists (select 1 from public.inventory_movements where idempotency_key = v_key) then
    return;
  end if;

  -- Se anota contra el mismo lote donde quedó la merma que anula.
  select m.lot_id into v_lot from public.inventory_movements m
  where m.serving_record_item_id = p_item_id
    and m.reason = 'DISCARDED_LEFTOVER'
    and m.covers_quantity < 0
  order by m.created_at desc, m.id desc limit 1;

  if v_lot is null then
    raise exception 'este renglón no tiene merma declarada que anular'
      using errcode = 'check_violation';
  end if;

  -- SE ANULA CON EL MISMO PESO CON QUE SE BOTÓ. La proporción sale de la basura
  -- viva de este renglón en este lote —cuánto pesa en unidad de lote contra
  -- cuánto pesa en unidad de renglón— y no del factor de hoy: anular TODO tiene
  -- que dejar el neto del informe en cero exacto, aunque entremedio se haya
  -- escrito una corrección con otro rendimiento. Si no quedara basura viva de
  -- dónde leer la proporción —el tope del candado lo hace casi imposible— se
  -- cae al factor congelado del descuento. Nunca a 1:1.
  select coalesce(sum(m.waste_lot_quantity), 0), coalesce(sum(m.covers_quantity), 0)
  into v_peso, v_cobertura
  from public.inventory_movements m
  where m.serving_record_item_id = p_item_id
    and m.reason = 'DISCARDED_LEFTOVER'
    and m.lot_id = v_lot;

  v_factor := coalesce(v_peso / nullif(v_cobertura, 0),
                       app.serving_lot_factor(p_item_id, v_lot));
  if v_factor is null then
    raise exception
      'no se puede pesar la anulación: el libro mayor no dice cuánto pesaba esa merma'
      using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_rec.household_id);

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, idempotency_key,
     serving_record_item_id, covers_quantity, waste_lot_quantity, actor_member_id, notes)
  values
    (v_rec.household_id, v_lot, 'DISCARDED_LEFTOVER', 0, v_key,
     p_item_id, p_quantity, round(p_quantity * v_factor, 3), v_actor,
     coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'la merma estaba mal declarada'));

  update public.meal_serving_record_items
  set discarded_quantity = round(discarded_quantity - p_quantity, 3)
  where id = p_item_id;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_rec.household_id, auth.uid(), 'SERVING_DISCARD_UNDONE', 'meal_serving_record_item',
          p_item_id, jsonb_build_object('quantity', p_quantity, 'unit', v_item.served_unit,
                                        'undo_id', v_undo));
  perform app.emit_event(v_rec.household_id, 'SERVING_DISCARD_UNDONE', 'meal_serving_record_item',
    jsonb_build_object('item_id', p_item_id, 'quantity', p_quantity),
    'SERVING_DISCARD_UNDONE:' || p_item_id::text || ':' || v_undo::text);
end;
$$;

comment on function public.undo_discard_serving(uuid, numeric, text, uuid) is
  'Anula una merma mal declarada. No mueve inventario (la comida nunca volvió '
  'al lote): devuelve el saldo devolvible que la merma había gastado y le resta '
  'al informe de desperdicio el mismo peso que la merma le había sumado.';

-- ---------------------------------------------------------------------------
-- 17. El informe de desperdicio ve LAS DOS mermas
-- ---------------------------------------------------------------------------
--
-- EL DEFECTO. `waste_movements` (0013:249) suma por `delta`, y la merma de lo
-- servido se anota con `delta` 0 a propósito: esa comida ya salió de la
-- despensa al servir, y restarla otra vez sería el doble descuento. Las dos
-- decisiones eran correctas por separado y juntas producían una mentira: se
-- botaba comida al basurero y el informe de desperdicio decía cero.
--
-- LA CORRECCIÓN. La vista deja de leer una sola columna. Si el movimiento trae
-- `waste_lot_quantity` —merma de un renglón servido— la cantidad sale de ahí;
-- si no, sale de `delta` como siempre. Las dos ya vienen en la unidad del LOTE,
-- así que se suman de verdad: el desperdicio de un alimento es el de la despensa
-- MÁS el del plato, y el inventario no se descuenta dos veces por ninguno.
--
-- `waste_kind` no es decorativo y a propósito no se deduce de `delta = 0`: "se
-- pudrió en el refrigerador" y "se sirvió y se botó" son dos hechos distintos
-- con dos remedios distintos —comprar menos contra servir menos— y quien lea el
-- informe tiene que poder separarlos sin adivinar. Va AL FINAL de la lista: los
-- lectores de hoy (el motor de stock, `wasteCost30`) piden columnas por nombre
-- y no ven ninguna diferencia.
--
-- LA ANULACIÓN VIAJA EN LA MISMA COLUMNA, con el signo al revés: anular una
-- merma mal declarada escribe una fila más —la historia no se borra— y el neto
-- de la ventana la descuenta solo. Es la única merma que se puede deshacer: la
-- de la despensa no, porque revertir un descarte repondría stock que está en el
-- basurero.
--
-- EL COSTO SIGUE SIENDO DESCONOCIDO CUANDO ES DESCONOCIDO. La merma del plato se
-- costea con la MISMA regla del lote limpio (§26): si el lote fue partido o
-- ajustado al alza, el valor es NULL y el motor devuelve NULL para el total.
-- Sumar solo la parte conocida al lado de la cantidad completa sería un número
-- que miente.

create or replace view public.waste_movements
with (security_invoker = true) as
select
  m.id,
  m.household_id,
  l.ingredient_id,
  l.unit,
  l.weight_basis,
  -- Positivo = se perdió comida. La anulación de una merma del plato entra
  -- negativa y el neto de la ventana la borra sola.
  q.cantidad as quantity,
  m.reason,
  m.created_at,
  -- El costo se estima SOLO para lotes "limpios" (sin split ni ajustes
  -- positivos): en esos, valor × proporción de las entradas de compra es
  -- exacto. Un lote partido o corregido mezclaría modelos contables y el
  -- número mentiría — ahí va NULL hasta que exista cost_allocations.
  case
    when l.acquisition_value is not null
     and entradas.total > 0
     and not exists (
       -- "sucio" = el lote FUE partido (salida SPLIT/MERGE: su valor quedó
       -- debitado y el denominador ya no calza) o recibió un ajuste al alza
       -- (entrada sin valor que diluiría el costo para siempre). La ENTRADA
       -- por split de un hijo es exacta: su valor se asignó en ese momento.
       select 1 from public.inventory_movements x
       where x.lot_id = m.lot_id
         and ((x.reason in ('SPLIT', 'MERGE') and x.delta < 0)
              or (x.reason = 'ADJUSTMENT' and x.delta > 0))
     )
    then round(l.acquisition_value * q.cantidad / entradas.total, 4)
  end as estimated_cost,
  case when m.waste_lot_quantity is not null then 'SERVING' else 'INVENTORY' end
    as waste_kind
from public.inventory_movements m
join public.inventory_lots l on l.id = m.lot_id
-- Una sola definición de "cuánto se perdió", usada por la cantidad y por el
-- costo: si se escribieran dos veces, un día dirían cosas distintas.
cross join lateral (
  select case
           when m.waste_lot_quantity is not null then -m.waste_lot_quantity
           else -m.delta
         end as cantidad
) q
left join lateral (
  select sum(e.delta) as total
  from public.inventory_movements e
  where e.lot_id = m.lot_id and e.delta > 0
    and e.reason in ('PURCHASE', 'SPLIT', 'MERGE')
) entradas on true
where m.reason in ('SPOILED', 'EXPIRED', 'DAMAGED', 'DISCARDED_LEFTOVER', 'PURCHASE_PROBLEM')
  and (m.delta < 0 or m.waste_lot_quantity is not null);

comment on view public.waste_movements is
  'Merma con costo estimado, en la unidad del LOTE: la de la despensa (viaja en '
  'delta) y la del plato (delta 0, peso en waste_lot_quantity) se suman en la '
  'misma columna. waste_kind dice cuál es cuál.';
