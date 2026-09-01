-- Sprint 12 — Revisiones adaptativas: el motor PROPONE, una persona DECIDE.
--
-- PRINCIPIO RECTOR: una propuesta que se aplica sola no es una propuesta.
--
-- Esta migración le da al motor adaptativo dos cosas y le niega una tercera:
--
--   · Le da `adaptive_nutrition_reviews`: dónde dejar por escrito lo que
--     propone, congelado con qué reglas lo calculó (`params` +
--     `engine_version`) y con qué foto del plan (`plan_snapshot`) y del
--     consumo (`intake_snapshot`). Nace en PENDING y ahí se queda.
--   · Le da `member_temporary_targets`: un vehículo de ajuste que CADUCA por
--     construcción. `valid_from` y `valid_until` son NOT NULL y el rango tiene
--     un techo (`public.adaptive_max_validity_days`). Un ajuste sin fecha de
--     término no es un ajuste temporal: es un cambio de objetivo, y ese camino
--     pasa por `nutrition_goals` con decisión humana.
--   · Le niega la escritura. `create_adaptive_review` escribe la PROPUESTA;
--     el único camino de la propuesta al objetivo es `resolve_adaptive_review`,
--     que exige un integrante detrás de la sesión y estampa su id en
--     `approved_by` (NOT NULL).
--
-- LO QUE ESTA MIGRACIÓN NO HACE, Y POR QUÉ (hallazgos #8 y #71 del ataque
-- adversarial al diseño):
--
--   El diseño decía que `resolve_adaptive_review` escribe "SOLO en
--   member_temporary_targets (y opcionalmente en member_daily_nutrition_plans /
--   member_daily_plan_meals)". Ese "opcionalmente" contradice al "SOLO" y abre
--   justo la puerta que el resto cierra: `member_daily_plan_meals` es el
--   override DIARIO que una persona configuró a mano, y pisarlo reemplaza el
--   valor humano EN SU LUGAR, sin guardar el anterior. Peor: bajar
--   `daily_energy_target` puede dejar una comida con `enabled = true` reducida
--   a casi nada aguas abajo — la política anti-ayuno se cumpliría en la forma
--   del tipo y se perdería en el efecto que la persona vive.
--
--   Así que ese "opcionalmente" no existe acá. El RPC escribe en UNA tabla, la
--   que tiene vigencia y aprobador. Los objetivos del día se componen EN
--   LECTURA: permanente + override diario + evento + ajuste temporal vigente.
--   Tampoco se agregan columnas de carbohidrato/grasa/fibra al plan diario:
--   `member_temporary_targets.goal_type` ya cubre los cinco nutrientes de
--   `public.goal_type`, así que no hay ningún ajuste que el sistema no sepa
--   guardar.
--
-- LO CLÍNICO ES COTA, NO SUGERENCIA (hallazgos #34, #38 y #39):
--
--   El techo clínico NO viaja como parámetro de confianza. Se lee dentro de la
--   base, con SECURITY DEFINER, en `app.adaptive_clinical_context`. Ésa es la
--   corrección del hallazgo #34: todas las lecturas del proyecto pasan por la
--   sesión del usuario, y `member_clinical_restrictions` exige
--   `app.medical_access(member,'VIEW_CLINICAL_RESTRICTIONS')` (0027:266). Si el
--   motor leyera los techos con la sesión de quien dispara la revisión, un
--   caller SIN ese permiso recibiría cero filas y compondría "sin techo": la
--   ausencia por permiso es indistinguible de la ausencia por inexistencia, y
--   el "lo clínico siempre gana" se apagaría solo, en silencio, justo para el
--   caller que menos derecho tiene.
--
--   Y el canal es SIMÉTRICO (hallazgo #39): `NUTRIENT_MAX` compone con `least`
--   y `NUTRIENT_MIN` compone con `greatest`. Sin los pisos, un ajuste podría
--   dejar la proteína bajo un mínimo clínico confirmado y ninguna capa lo
--   notaría.
--
--   Y la cota se compone contra TODO EL RANGO en que el ajuste va a regir, no
--   contra el día en que se firma: un objetivo temporal dura hasta cuatro días
--   civiles y un techo que empieza mañana manda igual. Sobre eso hay dos
--   paredes más —una que impide que una fila NAZCA en contra de una cota, otra
--   que REVOCA las que quedaron en contra cuando la cota llega después—;
--   están explicadas en la sección "8 bis".
--
--   Jamás se usa `least()` contra un valor que pueda ser NULL (hallazgo #38):
--   `least(x, null)` devuelve `x` en PostgreSQL, así que una restricción
--   CONFIRMED sin cifra —que significa "hay un límite y no sabemos cuál"— se
--   convertiría en "sin límite" sin fallar. Una cota sin valor, o con una
--   unidad distinta a la canónica del nutriente, BLOQUEA el ajuste entero
--   sobre ese nutriente. Nunca se descarta la cota.
--
-- PRIVACIDAD (hallazgos #35, #49 y #58):
--
--   "Sodio máximo 1500 mg, severidad HARD, vigente" no es un dato no médico:
--   es el diagnóstico deducible. Por eso la fila se parte en dos.
--   `adaptive_nutrition_reviews` vive bajo `app.can_access_member` (cualquier
--   integrante del hogar) y sólo lleva un booleano `clinical_capped` — sin
--   nutriente, sin cifra, sin severidad, sin ids. El detalle vive en
--   `adaptive_review_clinical_context`, bajo `app.medical_access`, exactamente
--   como `clinical_impact_reviews` (0027:521). Es el mismo criterio con que la
--   0036 sacó el contexto clínico de `meal_serving_records`.
--
-- No modifica ninguna migración congelada (0001..0039 están congeladas).

-- ---------------------------------------------------------------------------
-- 0. Enums
-- ---------------------------------------------------------------------------

/**
 * Las tres ventanas del balance móvil.
 *
 * El enum se llama `adaptive_rolling_window` y la columna `rolling_window`, no
 * `window`: `window` es palabra reservada de PostgreSQL (cláusula WINDOW), así
 * que habría que citarla con comillas dobles en la definición, en cada
 * consulta, en cada vista y en el mapeo de PostgREST. Es más barato el nombre
 * largo ahora que el escape permanente después (hallazgo #67).
 */
create type public.adaptive_rolling_window as enum ('W24H', 'D3', 'D7');

/**
 * Enum PROPIO: no se reusa `public.clinical_assessment_status`. Mezclar
 * veredictos adaptativos con clínicos borraría la separación que la 0027
 * construyó a propósito, y su REVIEW_REQUIRED significa otra cosa (una porción
 * que un profesional tiene que mirar, no un ajuste que quedó sin aplicar).
 *
 * INSUFFICIENT_DATA no es NO_CHANGE: "no alcanzan los datos para opinar" no es
 * "miré y está bien". UNKNOWN nunca significa NORMAL.
 */
create type public.adaptive_verdict as enum
  ('INSUFFICIENT_DATA', 'NO_CHANGE', 'OPTIONAL_ADJUSTMENT',
   'RECOMMENDED_ADJUSTMENT', 'REVIEW_REQUIRED');

/** De dónde viene un objetivo temporal. La etiqueta es historia, no permiso. */
create type public.target_provenance as enum
  ('ADAPTIVE_ENGINE', 'HUMAN_OVERRIDE', 'CLINICAL_ADJUSTMENT');

/** Nada se borra: se supera, se vence o se revoca. */
create type public.temporary_target_status as enum
  ('ACTIVE', 'SUPERSEDED', 'EXPIRED', 'REVOKED');

-- El ciclo de vida de la propuesta REUSA `public.impact_review_status`
-- (PENDING/REVIEWED/APPLIED/DISMISSED, 0027:37): ese problema —"la información
-- nueva propone, un humano decide"— ya está resuelto y no necesita un enum
-- gemelo que se desincronice.

-- ---------------------------------------------------------------------------
-- 1. El tope de vigencia, en UN SOLO lugar
-- ---------------------------------------------------------------------------

/**
 * Cuántos días puede durar, como máximo, un ajuste temporal.
 *
 * Existe como función y no como número escrito a mano porque el diseño traía
 * DOS topes en dos lugares distintos: 14 días en el CHECK de la tabla y 3 días
 * en `DEFAULT_ADAPTIVE_PARAMS.maxValidityDays` del motor. Cuando hay dos topes,
 * manda el más laxo — y el más laxo estaba en la base, que es la última pared
 * (hallazgo #63). Acá hay uno solo, y el motor lo lee de acá.
 *
 * Es IMMUTABLE para poder usarla dentro de un CHECK. Cambiar su valor NO
 * revalida las filas viejas, y eso está bien: un ajuste aprobado bajo el tope
 * de ayer es historia y no se reescribe.
 */
create or replace function public.adaptive_max_validity_days()
returns int language sql immutable set search_path = pg_catalog as $$
  select 3;
$$;

-- ---------------------------------------------------------------------------
-- 2. `adaptive_nutrition_reviews` — la PROPUESTA (superficie no médica)
-- ---------------------------------------------------------------------------

create table public.adaptive_nutrition_reviews (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  member_id      uuid not null references public.household_members (id) on delete cascade,

  -- El día civil evaluado, en la zona horaria del HOGAR. DATE-only: todo el
  -- proyecto compara fechas lexicográficamente y un timestamptz acá abriría la
  -- puerta a que la revisión del martes caiga en el lunes de otro huso.
  review_date    date not null,
  rolling_window public.adaptive_rolling_window not null,

  -- CONGELADO. Una revisión que no sabe con qué reglas se calculó no se puede
  -- auditar: dentro de seis meses, "por qué propuso esto" tiene que
  -- responderse leyendo la fila, no reconstruyendo el motor de esa fecha.
  engine_version text not null,
  params         jsonb not null,

  verdict        public.adaptive_verdict not null,
  status         public.impact_review_status not null default 'PENDING',

  -- CONGELADOS. `plan_snapshot`: modo de seguimiento, objetivos permanentes,
  -- objetivos resueltos del día y patrón de comidas esperado.
  -- `intake_snapshot`: planificado / servido / real agregados de la ventana,
  -- más cobertura y completitud por nutriente. Si mañana cambia el perfil o
  -- llega un registro tardío, esta fila NO cambia.
  plan_snapshot   jsonb not null,
  intake_snapshot jsonb not null,

  adjustments  jsonb not null default '[]'::jsonb,
  reasons      jsonb not null default '[]'::jsonb,
  -- QUÉ faltó, estructurado. Un motor que no pudo mirar algo lo DECLARA acá;
  -- un arreglo vacío significa "no faltó nada", jamás "no miré".
  missing_data jsonb not null default '[]'::jsonb,

  -- ACÁ NO HAY NINGÚN DATO CLÍNICO, NI EL NUTRIENTE, NI LA CIFRA, NI UN
  -- CONTADOR. Sólo "algo de esto quedó acotado por una indicación de salud".
  -- El detalle vive en `adaptive_review_clinical_context`, con la RLS médica.
  -- Un contador sería la existencia del techo más su cardinalidad, con
  -- disfraz aritmético (mismo criterio que la 0036 con
  -- `plan_unverifiable_constraints`).
  clinical_capped boolean not null default false,

  -- Qué se aplicó y qué no, cuando alguien la resolvió. Los motivos clínicos
  -- llegan acá COLAPSADOS: ver `app.adaptive_public_discard_code`.
  resolution_summary jsonb,

  -- NOT NULL a propósito. La lección C-1 de la 0025: un dedupe NULL es cero
  -- idempotencia, porque en un índice único todos los NULL son distintos entre
  -- sí. El índice único de `procurement_orders` era parcial y por eso hubo que
  -- volver obligatoria la clave.
  dedupe_key text not null unique,

  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.household_members (id) on delete set null,

  constraint adaptive_engine_version_present
    check (length(btrim(engine_version)) > 0),
  constraint adaptive_snapshots_are_objects
    check (jsonb_typeof(plan_snapshot) = 'object'
       and jsonb_typeof(intake_snapshot) = 'object'
       and jsonb_typeof(params) = 'object'),
  constraint adaptive_lists_are_arrays
    check (jsonb_typeof(adjustments) = 'array'
       and jsonb_typeof(reasons) = 'array'
       and jsonb_typeof(missing_data) = 'array'),
  -- Una revisión resuelta tiene sello de cuándo, y una PENDING no lo tiene.
  -- `resolved_by` puede quedar en NULL si después se borra al integrante: el
  -- hecho de la resolución sobrevive a la persona (`on delete set null`).
  constraint adaptive_resolved_pair
    check ((status = 'PENDING') = (resolved_at is null))
);

create index adaptive_reviews_pending
  on public.adaptive_nutrition_reviews (member_id, status) where status = 'PENDING';
create index adaptive_reviews_by_day
  on public.adaptive_nutrition_reviews (member_id, review_date desc);

-- ---------------------------------------------------------------------------
-- 3. `adaptive_review_clinical_context` — la mitad que necesita permiso médico
-- ---------------------------------------------------------------------------
--
-- Tabla hermana, misma llave primaria que la revisión. Todo lo que permite
-- deducir una condición vive acá: ids de restricción, tipo, severidad, cotas
-- aplicadas y cuántas revisiones clínicas había pendientes.

create table public.adaptive_review_clinical_context (
  review_id  uuid primary key references public.adaptive_nutrition_reviews (id) on delete cascade,
  -- Denormalizado a propósito: la policy pregunta por el INTEGRANTE, y hacerlo
  -- con un `exists` contra la tabla padre metería la tabla no médica dentro de
  -- la evaluación de la médica.
  member_id  uuid not null references public.household_members (id) on delete cascade,

  -- Siempre true cuando lo escribe esta migración, porque
  -- `app.adaptive_clinical_context` es SECURITY DEFINER y no depende de los
  -- permisos del caller. Se persiste igual: si mañana alguien cambia ese
  -- camino, un `false` acá tiene que poder distinguirse de un `[]` honesto.
  -- ERROR != VACÍO.
  context_resolved   boolean not null,
  clinical_snapshot  jsonb not null,
  clinical_overrides jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),

  constraint arcc_shapes
    check (jsonb_typeof(clinical_snapshot) = 'object'
       and jsonb_typeof(clinical_overrides) = 'array')
);

-- ---------------------------------------------------------------------------
-- 4. `member_temporary_targets` — el ajuste que caduca por construcción
-- ---------------------------------------------------------------------------

create table public.member_temporary_targets (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  member_id    uuid not null references public.household_members (id) on delete cascade,

  goal_type public.goal_type not null,
  scope     public.goal_scope not null default 'DAILY',
  meal_type public.meal_type,

  -- LA MISMA ESCALA QUE `member_clinical_restrictions.value` (numeric(12,4),
  -- 0027:245), y no una más corta. Con numeric(10,3) el cast del INSERT
  -- redondeaba half-up en el último paso: un techo clínico de 100,0005 g
  -- recortaba la propuesta a 100,0005 y la columna la guardaba como 100,001,
  -- o sea POR ENCIMA del techo. El daño era de 0,0005 en la unidad del
  -- nutriente, pero "es imposible que la salida ensanche un límite clínico" no
  -- admite un "casi". Con la misma escala en las dos puntas el recorte se
  -- guarda exacto: redondear a cuatro decimales un número que ya es <= techo
  -- nunca lo pasa, porque el techo también tiene cuatro decimales.
  minimum   numeric(12, 4),
  preferred numeric(12, 4),
  maximum   numeric(12, 4),

  -- AMBOS NOT NULL. Es la invariante central de la tabla y por eso es
  -- estructural y no una validación de código: un ajuste sin fecha de término
  -- es un objetivo disfrazado.
  valid_from  date not null,
  valid_until date not null,

  provenance public.target_provenance not null,
  review_id  uuid references public.adaptive_nutrition_reviews (id) on delete set null,
  status     public.temporary_target_status not null default 'ACTIVE',

  -- NOT NULL: no existe un ajuste sin humano que lo aprobó.
  --
  -- SIN acción referencial (NO ACTION, no `cascade` ni `set null`) y es
  -- deliberado. `set null` es imposible con NOT NULL; `cascade` borraría el
  -- ajuste de UNA persona porque se fue OTRA (la mamá que aprobó el ajuste del
  -- hijo); `restrict` se verifica de inmediato y podría rebotar al borrar un
  -- hogar completo, según el orden en que el motor procese las cascadas.
  -- NO ACTION se verifica al final de la sentencia: cuando el hogar cae, estas
  -- filas ya cayeron con él y no hay nada que verificar; pero borrar a un
  -- integrante que aprobó el ajuste VIVO de otro sí rebota, que es justo la
  -- protección que se busca.
  approved_by uuid not null references public.household_members (id),
  approved_at timestamptz not null default now(),

  -- Los topes con los que se calculó la propuesta que originó este ajuste.
  -- Cambiar los defaults mañana no reescribe lo que se aprobó ayer.
  frozen_params jsonb not null,

  -- Cadena de renovaciones. Cinco ajustes seguidos de tres días son quince
  -- días de "temporal" sin pasar nunca por `nutrition_goals`, que es justo lo
  -- que esta migración existe para impedir (hallazgo #63).
  renewal_of    uuid references public.member_temporary_targets (id),
  renewal_index int not null default 1,

  -- Texto libre visible para TODO el hogar. Por eso no puede acompañar a un
  -- ajuste de procedencia clínica: "ajuste temporal — motivo: <texto>" en una
  -- pantalla de objetivos le cuenta a la familia entera que esa persona tiene
  -- una condición, sin que nadie haya otorgado un permiso (hallazgo #49).
  reason text,

  superseded_by uuid references public.member_temporary_targets (id),
  closed_at     timestamptz,
  closed_by     uuid references public.household_members (id) on delete set null,
  created_at    timestamptz not null default now(),

  constraint tt_range_ordered check (
    (minimum is null or preferred is null or minimum <= preferred)
    and (preferred is null or maximum is null or preferred <= maximum)
    and (minimum is null or maximum is null or minimum <= maximum)),
  -- Un ajuste que no dice ningún número no ajusta nada.
  constraint tt_has_a_number check (num_nonnulls(minimum, preferred, maximum) >= 1),
  constraint tt_meal_scope check ((scope = 'PER_MEAL') = (meal_type is not null)),
  constraint tt_dates_ordered check (valid_until >= valid_from),
  constraint tt_is_temporary
    check (valid_until - valid_from <= public.adaptive_max_validity_days()),
  constraint tt_renewal_limit check (renewal_index between 1 and 3),
  constraint tt_renewal_chain check ((renewal_index = 1) = (renewal_of is null)),
  constraint tt_frozen_params_object check (jsonb_typeof(frozen_params) = 'object'),
  constraint tt_clinical_reason_not_here
    check (provenance <> 'CLINICAL_ADJUSTMENT' or reason is null),
  constraint tt_superseded_pair
    check ((status = 'SUPERSEDED') = (superseded_by is not null)),
  constraint tt_closed_pair
    check ((status = 'ACTIVE') = (closed_at is null))
);

create index temporary_targets_window
  on public.member_temporary_targets (member_id, valid_from, valid_until)
  where status = 'ACTIVE';
create index temporary_targets_by_review
  on public.member_temporary_targets (review_id) where review_id is not null;

/**
 * DOS OBJETIVOS VIGENTES A LA VEZ NO SON UN OBJETIVO.
 *
 * El diseño traía un índice único parcial sobre
 * `(member, goal_type, scope, meal_type, valid_from)`. Con `valid_from` en la
 * llave, un ajuste de lunes a miércoles y otro de martes a jueves conviven
 * legalmente: el martes rigen dos metas distintas y ningún lector tiene regla
 * para elegir. Quedaría a merced del `order by` que alguien escriba —
 * probablemente el más nuevo, o el más ancho — y si uno de los dos venía
 * recortado por un techo clínico, el otro sería el que lo ensancha. Un
 * objetivo no determinista es lo contrario de un motor determinista
 * (hallazgo #45).
 *
 * Lo correcto sería una EXCLUSION CONSTRAINT con `btree_gist` sobre
 * `daterange(valid_from, valid_until, '[]') with &&`. Va como trigger y no
 * como constraint porque `btree_gist` es una extensión que hay que instalar, y
 * el arnés de pruebas corre PostgreSQL compilado a WASM donde esa extensión no
 * está cargada. Una garantía que sólo existe en producción no es una garantía:
 * es una que nadie prueba. El trigger corre igual en los dos lados.
 *
 * La carrera entre dos sesiones la cierra el candado consultivo por integrante
 * que toma `resolve_adaptive_review` antes de insertar.
 */
create or replace function app.temporary_target_no_overlap()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status <> 'ACTIVE' then return new; end if;

  if exists (
    select 1 from public.member_temporary_targets t
    where t.id <> new.id
      and t.member_id = new.member_id
      and t.goal_type = new.goal_type
      and t.scope     = new.scope
      and t.meal_type is not distinct from new.meal_type
      and t.status = 'ACTIVE'
      -- Rangos cerrados en los dos extremos: si comparten aunque sea un día,
      -- ese día tiene dos objetivos.
      and t.valid_from <= new.valid_until
      and new.valid_from <= t.valid_until
  ) then
    raise exception
      'ya hay un ajuste temporal vigente de % en ese rango de fechas: supéralo o revócalo antes de aplicar otro',
      new.goal_type using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$$;

create trigger temporary_targets_no_overlap
  before insert or update on public.member_temporary_targets
  for each row execute function app.temporary_target_no_overlap();

-- ---------------------------------------------------------------------------
-- 5. Historia inmutable: nada se borra, se supera o se anula
-- ---------------------------------------------------------------------------
--
-- Mismo espíritu y mismo escape `pg_trigger_depth() > 1` que
-- `app.ledger_is_append_only` (0011:277), `app.serving_record_is_append_only`
-- (0036) y `app.intake_log_is_append_only` (0038). El escape quirúrgico existe
-- porque las FK anulables se anulan con un UPDATE que dispara el MOTOR
-- (`on delete set null`), no una persona: sin él, borrar al integrante que
-- resolvió una revisión rebotaría contra esta guarda con un mensaje que además
-- mentiría sobre la causa.

create or replace function app.adaptive_review_is_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'una revisión adaptativa no se borra: se resuelve (REVIEWED / APPLIED / DISMISSED) y queda como historia';
  end if;

  -- Va ANTES del corte por estado terminal, por la misma razón que en la 0038:
  -- si fuera después, borrar al integrante que resolvió sería imposible para
  -- siempre, porque esa fila ya está resuelta.
  if pg_trigger_depth() > 1
     and app.is_fk_set_null_update(to_jsonb(old), to_jsonb(new), array['resolved_by'])
  then
    return new;
  end if;

  if old.status <> 'PENDING' then
    raise exception 'esta revisión ya está % : la historia no se reescribe',
      lower(old.status::text);
  end if;

  -- Lo único que puede cambiar es el bloque de cierre. Todo lo demás —qué se
  -- propuso, con qué reglas, sobre qué foto— es lo que hace auditable la
  -- propuesta, y por eso es intocable.
  if new.id              is distinct from old.id
     or new.household_id is distinct from old.household_id
     or new.member_id    is distinct from old.member_id
     or new.review_date  is distinct from old.review_date
     or new.rolling_window  is distinct from old.rolling_window
     or new.engine_version  is distinct from old.engine_version
     or new.params          is distinct from old.params
     or new.verdict         is distinct from old.verdict
     or new.plan_snapshot   is distinct from old.plan_snapshot
     or new.intake_snapshot is distinct from old.intake_snapshot
     or new.adjustments     is distinct from old.adjustments
     or new.reasons         is distinct from old.reasons
     or new.missing_data    is distinct from old.missing_data
     or new.clinical_capped is distinct from old.clinical_capped
     or new.dedupe_key      is distinct from old.dedupe_key
     or new.created_at      is distinct from old.created_at
  then
    raise exception 'una revisión adaptativa no se reescribe: lo propuesto y sus reglas son historia'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger adaptive_reviews_append_only
  before update or delete on public.adaptive_nutrition_reviews
  for each row execute function app.adaptive_review_is_append_only();

create or replace function app.temporary_target_is_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'un ajuste temporal no se borra: vence, se supera o se revoca';
  end if;

  if pg_trigger_depth() > 1
     and app.is_fk_set_null_update(to_jsonb(old), to_jsonb(new),
                                   array['review_id', 'closed_by'])
  then
    return new;
  end if;

  if old.status <> 'ACTIVE' then
    raise exception 'este ajuste temporal ya está % : la historia no se reescribe',
      lower(old.status::text);
  end if;

  -- El número aprobado, sus fechas, quién lo aprobó y con qué parámetros: nada
  -- de eso cambia. Cambiar el número de un ajuste ya aprobado sería aplicar un
  -- ajuste que ninguna persona aprobó.
  if new.id            is distinct from old.id
     or new.household_id  is distinct from old.household_id
     or new.member_id     is distinct from old.member_id
     or new.goal_type     is distinct from old.goal_type
     or new.scope         is distinct from old.scope
     or new.meal_type     is distinct from old.meal_type
     or new.minimum       is distinct from old.minimum
     or new.preferred     is distinct from old.preferred
     or new.maximum       is distinct from old.maximum
     or new.valid_from    is distinct from old.valid_from
     or new.valid_until   is distinct from old.valid_until
     or new.provenance    is distinct from old.provenance
     or new.approved_by   is distinct from old.approved_by
     or new.approved_at   is distinct from old.approved_at
     or new.frozen_params is distinct from old.frozen_params
     or new.renewal_of    is distinct from old.renewal_of
     or new.renewal_index is distinct from old.renewal_index
     or new.reason        is distinct from old.reason
     or new.created_at    is distinct from old.created_at
  then
    raise exception 'un ajuste temporal no se reescribe: se supera con otro o se revoca'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger temporary_targets_append_only
  before update or delete on public.member_temporary_targets
  for each row execute function app.temporary_target_is_append_only();

-- ---------------------------------------------------------------------------
-- 6. RLS al 100%: sólo lectura, y la escritura por RPC
-- ---------------------------------------------------------------------------

alter table public.adaptive_nutrition_reviews      enable row level security;
alter table public.adaptive_review_clinical_context enable row level security;
alter table public.member_temporary_targets        enable row level security;

-- Dato personal NO clínico: objetivos y consumo. Va por `can_access_member`,
-- igual que `nutrition_goals` (0005:406). Lo que sí es clínico se sacó de acá.
create policy adaptive_reviews_select on public.adaptive_nutrition_reviews
  for select to authenticated
  using (app.can_access_member(member_id));

-- La MISMA llave que `member_clinical_restrictions` (0027:266) y que
-- `clinical_impact_reviews` (0027:521): esta tabla es la fuente de la que sale
-- ese dato, y bajarle el permiso sería una fuga neta.
create policy adaptive_review_clinical_context_select
  on public.adaptive_review_clinical_context
  for select to authenticated
  using (app.medical_access(member_id, 'VIEW_CLINICAL_RESTRICTIONS'));

create policy temporary_targets_select on public.member_temporary_targets
  for select to authenticated
  using (app.can_access_member(member_id));

-- Defensa en profundidad, misma línea que `audit_events` (0001:111),
-- `meal_serving_clinical_context` (0036) e `intake_log_items` (0038): la RLS ya
-- bloquea la escritura porque no existe policy que la permita, pero el
-- privilegio tampoco tiene por qué estar. Los RPC no se enteran: corren
-- SECURITY DEFINER como dueño.
revoke insert, update, delete on public.adaptive_nutrition_reviews       from anon, authenticated;
revoke insert, update, delete on public.adaptive_review_clinical_context from anon, authenticated;
revoke insert, update, delete on public.member_temporary_targets         from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Endurecimiento de `nutrition_goals`
-- ---------------------------------------------------------------------------
--
-- `goal_ai_starts_proposed` (0005:135) sólo bloquea `AI_PROPOSAL`. Hoy
-- `source = 'SYSTEM'` con `status = 'ACTIVE'` está permitido, y ÉSA es la
-- puerta por la que un motor podría auto-aplicar un objetivo PERMANENTE.
--
-- HONESTIDAD SOBRE EL ALCANCE (hallazgo #64): este CHECK cierra la variante
-- honesta del ataque, no todas. `nutrition_goals` todavía tiene la policy
-- `goals_all for all to authenticated` (0005:406), o sea escritura DIRECTA por
-- PostgREST para cualquier integrante del hogar, y `source` la escribe el
-- propio cliente: basta poner `source = 'USER'` para escribir un objetivo
-- permanente ACTIVE desde donde sea. Cerrar esa policy a solo-SELECT y mover la
-- escritura a un RPC es lo correcto, pero rompería
-- `web/src/app/family/nutrition-actions.ts`, que hoy inserta ahí directo — no
-- es trabajo de esta migración y queda declarado, no escondido. Mientras eso no
-- ocurra, la invariante "un motor no puede escribir un objetivo permanente
-- activo" se sostiene para los caminos que declaran su procedencia.
--
-- Se agrega NOT VALID y se valida sólo si la tabla ya está limpia: puede haber
-- filas SYSTEM+ACTIVE en producción, y una migración que revienta al aplicarse
-- no protege nada. NOT VALID igual rige para todo INSERT y UPDATE nuevo.

alter table public.nutrition_goals
  add constraint goals_engine_never_active
  check (not (source in ('AI_PROPOSAL', 'SYSTEM') and status = 'ACTIVE')) not valid;

do $$
begin
  if not exists (
    select 1 from public.nutrition_goals
    where source in ('AI_PROPOSAL', 'SYSTEM') and status = 'ACTIVE'
  ) then
    alter table public.nutrition_goals validate constraint goals_engine_never_active;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. El canal clínico: cotas leídas DENTRO de la base
-- ---------------------------------------------------------------------------

/**
 * `public.goal_type` → clave de nutriente del catálogo.
 *
 * Los nombres NO coinciden: el objetivo se llama CARBOHYDRATE_G y el nutriente
 * `carbohydrates_g` (en plural). Traducir con `lower(...)` habría fallado
 * exactamente ahí, en silencio y sólo para carbohidratos, que es el peor lugar
 * posible para un error silencioso.
 */
create or replace function app.adaptive_nutrient_key(p_goal public.goal_type)
returns text language sql immutable set search_path = pg_catalog as $$
  select case p_goal
    when 'ENERGY_KCAL'     then 'energy_kcal'
    when 'PROTEIN_G'       then 'protein_g'
    when 'CARBOHYDRATE_G'  then 'carbohydrates_g'
    when 'FAT_G'           then 'fat_g'
    when 'FIBER_G'         then 'fiber_g'
  end;
$$;

/**
 * La unidad canónica de un nutriente, deducida del sufijo de su clave — la
 * misma regla que `unidadDeNutriente` en `web/src/domain/clinical/engine.ts`.
 * Si las dos se separan, la comparación de unidades de acá abajo deja de valer.
 */
create or replace function app.adaptive_nutrient_unit(p_key text)
returns text language sql immutable set search_path = pg_catalog as $$
  select case
    when p_key = 'energy_kcal' then 'kcal'
    when p_key like '%\_mg'    then 'mg'
    else 'g'
  end;
$$;

/**
 * Qué cotas clínicas había vigentes para esta persona en esta fecha.
 *
 * SECURITY DEFINER, y ésa es toda la razón por la que existe. Si el motor
 * leyera `member_clinical_restrictions` con la sesión del caller, quien no
 * tenga `VIEW_CLINICAL_RESTRICTIONS` recibiría cero filas y compondría
 * "sin techo". Ausencia por permiso ≠ ausencia por inexistencia (hallazgo #34).
 *
 * Vive en el esquema `app` y no en `public` a propósito: PostgREST no expone el
 * esquema `app`, así que nadie puede llamarla desde el cliente para leer las
 * cotas de otra persona sin permiso médico. Los RPC de esta migración la usan
 * por dentro; el detalle que sale queda guardado en
 * `adaptive_review_clinical_context`, con la RLS médica encima.
 *
 * `unusable` es la lista de cotas que NO se pueden aplicar y que por eso
 * BLOQUEAN: una restricción CONFIRMED sin cifra significa "hay un límite y no
 * sabemos cuál" —jamás "no hay límite"— y una unidad que no es la canónica del
 * nutriente significa que nadie convirtió 2 g de sodio a 2000 mg. En los dos
 * casos la cota se respeta negándose, nunca ignorándola.
 *
 * TOMA UN RANGO, NO UN DÍA, Y ÉSA ES LA CORRECCIÓN CENTRAL DE ESTA REVISIÓN.
 * Antes recibía `p_on date` y filtraba las restricciones vigentes ESE día. Pero
 * lo que se guarda con lo que sale de acá —`member_temporary_targets`— rige de
 * `valid_from` a `valid_until`, o sea hasta cuatro días civiles
 * (`tt_is_temporary`). Un NUTRIENT_MAX CONFIRMED que empieza MAÑANA no aparecía
 * en la foto de HOY, y el objetivo quedaba rigiendo por encima del techo
 * clínico los días 2, 3 y 4 sin que ninguna capa se enterara. "El techo se
 * consulta un solo día pero el objetivo rige hasta cuatro" no es un desfase de
 * borde: es lo adaptativo ensanchando un límite clínico.
 *
 * Acá se devuelve la UNIÓN de todo lo que rige en CUALQUIER día del rango
 * (solape, no contención). Quien compone toma después el MÍNIMO de los techos y
 * el MÁXIMO de los pisos, así que el rango entero queda acotado por el día más
 * estricto. Es deliberadamente conservador: un techo que rige un solo día del
 * rango acota los cuatro. Lo contrario —acotar día por día— exigiría un
 * objetivo distinto por día, que es justo lo que `temporary_target_no_overlap`
 * prohíbe.
 *
 * Un rango desconocido NO es un rango sin restricciones: sin persona o sin
 * fechas, esto revienta con nombre en vez de devolver "no hay techos".
 */
create or replace function app.adaptive_clinical_context(
  p_member uuid,
  p_from   date,
  p_until  date
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_desde date;
  v_hasta date;
  v_out   jsonb;
begin
  if p_member is null or p_from is null or p_until is null then
    raise exception 'no se puede leer el contexto clínico sin persona y sin rango de fechas: un rango desconocido no es un rango sin restricciones'
      using errcode = 'null_value_not_allowed';
  end if;
  v_desde := least(p_from, p_until);
  v_hasta := greatest(p_from, p_until);

  with vigentes as (
    select r.id, r.type, r.target, r.value, r.unit, r.severity
    from public.member_clinical_restrictions r
    where r.member_id = p_member
      and r.verification_status = 'CONFIRMED'
      and r.type in ('NUTRIENT_MAX', 'NUTRIENT_MIN')
      -- SOLAPE con el rango: basta que rija UN día para entrar a la unión.
      -- `valid_until is null` significa "sin término", no "vencida".
      and r.valid_from <= v_hasta
      and (r.valid_until is null or v_desde <= r.valid_until)
  ),
  clasificadas as (
    select v.*,
           (v.value is null
            or v.unit is distinct from app.adaptive_nutrient_unit(v.target)) as inservible
    from vigentes v
  )
  select jsonb_build_object(
    'resolved', true,
    -- El rango consultado viaja EN la foto: una revisión que no dice contra qué
    -- días se compuso no se puede auditar después.
    'from', v_desde::text,
    'until', v_hasta::text,
    'ceilings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'restriction_id', c.id, 'nutrient', c.target,
               'max', c.value, 'unit', c.unit, 'severity', c.severity)
             order by c.id)
      from clasificadas c where c.type = 'NUTRIENT_MAX' and not c.inservible), '[]'::jsonb),
    'floors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'restriction_id', c.id, 'nutrient', c.target,
               'min', c.value, 'unit', c.unit, 'severity', c.severity)
             order by c.id)
      from clasificadas c where c.type = 'NUTRIENT_MIN' and not c.inservible), '[]'::jsonb),
    'unusable', coalesce((
      select jsonb_agg(jsonb_build_object(
               'restriction_id', c.id, 'nutrient', c.target, 'type', c.type,
               'why', case when c.value is null then 'LIMIT_WITHOUT_VALUE'
                           else 'UNIT_MISMATCH' end,
               'unit', c.unit,
               'expected_unit', app.adaptive_nutrient_unit(c.target))
             order by c.id)
      from clasificadas c where c.inservible), '[]'::jsonb),
    'pending_clinical_reviews', (
      select count(*) from public.clinical_impact_reviews cir
      where cir.member_id = p_member and cir.status = 'PENDING')
  ) into v_out;

  return v_out;
end;
$$;

/**
 * Compone los ajustes propuestos CONTRA las cotas clínicas y devuelve
 * `{kept, discarded, capped, context}`.
 *
 * TOMA EL RANGO COMPLETO EN QUE EL AJUSTE VA A REGIR, no el día en que se
 * firma. El techo aplicado es el MÍNIMO de los techos vigentes en cualquier día
 * de `[p_from, p_until]` y el piso es el MÁXIMO de los pisos: así el ajuste
 * queda acotado por el día más estricto del rango y no hay un solo día de su
 * vigencia en que pueda quedar por sobre un techo clínico.
 *
 * Es la única implementación del recorte, y por eso la llaman los DOS caminos:
 * `create_adaptive_review` (para que la propuesta que se guarda ya sea la
 * honesta) y `resolve_adaptive_review` (para revalidar contra las
 * restricciones vigentes EL DÍA EN QUE SE APLICA, que pueden no ser las del día
 * en que se propuso). Doble candado: el motor de TypeScript ya compuso con
 * Math.min, la base lo vuelve a verificar, y un cliente que llame el RPC a mano
 * tampoco puede ensanchar una cota.
 *
 * Reglas, en este orden:
 *   1. Si el nutriente tiene una cota INSERVIBLE, se descarta el ajuste entero.
 *   2. El techo se compone SÓLO con `least` sobre valores garantizados no
 *      nulos, y el piso SÓLO con `greatest`. Es matemáticamente imposible que
 *      la salida ensanche un límite clínico.
 *   3. Se recorta el TRÍO completo, no sólo el máximo (hallazgo #46): si sólo
 *      se tocara `maximum`, el CHECK `tt_range_ordered` reventaría el INSERT y
 *      el caso "lo clínico ganó" se le mostraría a la persona como un error
 *      técnico opaco en vez de como una explicación.
 *   4. Si después de recortar el mínimo queda sobre el máximo, el ajuste se
 *      DESCARTA con su motivo. Aplicar 3 de 4 diciendo por qué falta el cuarto
 *      es correcto; fallar los 4 no.
 */
create or replace function app.adaptive_bound_adjustments(
  p_member      uuid,
  p_from        date,
  p_until       date,
  p_adjustments jsonb
) returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_ctx     jsonb;
  v_a       jsonb;
  v_kept    jsonb := '[]'::jsonb;
  v_desc    jsonb := '[]'::jsonb;
  v_capped  boolean := false;
  v_goal    public.goal_type;
  v_key     text;
  v_min numeric; v_pref numeric; v_max numeric;
  v_min0 numeric; v_pref0 numeric; v_max0 numeric;
  v_techo numeric; v_piso numeric;
  v_ids jsonb;
begin
  v_ctx := app.adaptive_clinical_context(p_member, p_from, p_until);

  for v_a in
    select value from jsonb_array_elements(
      case when jsonb_typeof(p_adjustments) = 'array' then p_adjustments else '[]'::jsonb end)
  loop
    -- El cast a enum devuelve NULL sin quejarse cuando la entrada es NULL, así
    -- que el `nullif` va ANTES: un ajuste sin objetivo se descarta con nombre,
    -- no se cuela como una fila con `goal_type` en blanco.
    if nullif(v_a->>'goal_type', '') is null then
      v_desc := v_desc || jsonb_build_array(jsonb_build_object(
        'goal_type', null, 'code', 'UNKNOWN_GOAL_TYPE'));
      continue;
    end if;
    begin
      v_goal := (v_a->>'goal_type')::public.goal_type;
    exception when others then
      v_desc := v_desc || jsonb_build_array(jsonb_build_object(
        'goal_type', v_a->>'goal_type', 'code', 'UNKNOWN_GOAL_TYPE'));
      continue;
    end;

    v_key := app.adaptive_nutrient_key(v_goal);

    -- 1. Cota inservible sobre este nutriente: se bloquea el ajuste entero.
    if exists (
      select 1 from jsonb_array_elements(v_ctx->'unusable') u
      where u.value->>'nutrient' = v_key
    ) then
      v_desc := v_desc || jsonb_build_array(jsonb_build_object(
        'goal_type', v_goal::text, 'code', 'CLINICAL_LIMIT_UNUSABLE',
        'clinical', true,
        'detail', (select jsonb_agg(u.value)
                   from jsonb_array_elements(v_ctx->'unusable') u
                   where u.value->>'nutrient' = v_key)));
      continue;
    end if;

    v_min0  := nullif(v_a->>'minimum',   '')::numeric;
    v_pref0 := nullif(v_a->>'preferred', '')::numeric;
    v_max0  := nullif(v_a->>'maximum',   '')::numeric;
    v_min := v_min0; v_pref := v_pref0; v_max := v_max0;

    select min((c.value->>'max')::numeric) into v_techo
    from jsonb_array_elements(v_ctx->'ceilings') c
    where c.value->>'nutrient' = v_key;

    select max((f.value->>'min')::numeric) into v_piso
    from jsonb_array_elements(v_ctx->'floors') f
    where f.value->>'nutrient' = v_key;

    -- 2 y 3. El techo baja el trío; el piso sube el mínimo. Nunca al revés.
    if v_techo is not null then
      v_max  := case when v_max  is null then v_techo else least(v_max,  v_techo) end;
      v_pref := case when v_pref is null then null    else least(v_pref, v_techo) end;
      v_min  := case when v_min  is null then null    else least(v_min,  v_techo) end;
    end if;
    if v_piso is not null then
      v_min  := case when v_min  is null then v_piso else greatest(v_min,  v_piso) end;
      v_pref := case when v_pref is null then null   else greatest(v_pref, v_piso) end;
    end if;

    -- 4. ¿Quedó un rango posible?
    if v_min is not null and v_max is not null and v_min > v_max then
      v_ids := coalesce((
        select jsonb_agg(x.value->>'restriction_id')
        from (select value from jsonb_array_elements(v_ctx->'ceilings')
              union all
              select value from jsonb_array_elements(v_ctx->'floors')) x
        where x.value->>'nutrient' = v_key), '[]'::jsonb);
      v_desc := v_desc || jsonb_build_array(jsonb_build_object(
        'goal_type', v_goal::text,
        'code', case when v_piso is not null and v_piso > coalesce(v_max0, v_piso)
                     then 'CLINICAL_FLOOR_BLOCKS_PROPOSAL'
                     else 'CLINICAL_CEILING_BLOCKS_PROPOSAL' end,
        'clinical', true, 'restriction_ids', v_ids));
      continue;
    end if;

    -- El preferido tiene que seguir dentro del rango después de los recortes.
    if v_pref is not null and v_min is not null then v_pref := greatest(v_pref, v_min); end if;
    if v_pref is not null and v_max is not null then v_pref := least(v_pref, v_max); end if;

    if num_nonnulls(v_min, v_pref, v_max) = 0 then
      v_desc := v_desc || jsonb_build_array(jsonb_build_object(
        'goal_type', v_goal::text, 'code', 'ADJUSTMENT_WITHOUT_NUMBERS'));
      continue;
    end if;

    if v_min is distinct from v_min0
       or v_pref is distinct from v_pref0
       or v_max is distinct from v_max0 then
      v_capped := true;
    end if;

    v_kept := v_kept || jsonb_build_array(
      (v_a - 'minimum' - 'preferred' - 'maximum')
      || jsonb_build_object(
           'goal_type', v_goal::text,
           'minimum', to_jsonb(v_min),
           'preferred', to_jsonb(v_pref),
           'maximum', to_jsonb(v_max),
           'clinically_capped',
             to_jsonb(v_min is distinct from v_min0
                      or v_pref is distinct from v_pref0
                      or v_max is distinct from v_max0)));
  end loop;

  return jsonb_build_object(
    'kept', v_kept, 'discarded', v_desc, 'capped', v_capped, 'context', v_ctx);
end;
$$;

/**
 * El motivo de descarte, tal como puede verse SIN permiso médico.
 *
 * Todo código marcado `clinical` se colapsa a `NOT_APPLIED_HEALTH_GUIDANCE`
 * antes de guardarse en `resolution_summary` o de volver al caller: la
 * superficie no médica dice "este ajuste no se aplicó por una indicación de
 * salud" y no dice cuál, ni de cuánto, ni con qué severidad (hallazgos #35 y
 * #58). El motivo completo queda en `adaptive_review_clinical_context`.
 */
create or replace function app.adaptive_public_discard_code(p_item jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select case when coalesce((p_item->>'clinical')::boolean, false)
              then jsonb_build_object('goal_type', p_item->>'goal_type',
                                      'code', 'NOT_APPLIED_HEALTH_GUIDANCE')
              else jsonb_build_object('goal_type', p_item->>'goal_type',
                                      'code', p_item->>'code') end;
$$;

-- ---------------------------------------------------------------------------
-- 8 bis. LAS OTRAS DOS PAREDES: un objetivo vigente no puede contradecir una
--        cota clínica NI EL DÍA QUE SE FIRMA NI NINGUNO DE LOS QUE RIGE
-- ---------------------------------------------------------------------------
--
-- Componer contra el rango (arriba) cierra el caso "la restricción ya existía
-- cuando se aplicó el ajuste". No cierra el otro: el techo se confirma DESPUÉS,
-- con `valid_from` = hoy —la columna es `default current_date`— y el objetivo
-- temporal sigue vivo por encima de él hasta que vence solo.
-- `expire_temporary_targets` no lo ve porque sólo mira la fecha.
--
-- Así que la cota se sostiene en TRES lugares, y los tres tienen que ser
-- verdad a la vez:
--
--   1. AL COMPONER (`app.adaptive_bound_adjustments`, sobre el rango completo):
--      la propuesta que se guarda y la que se aplica ya vienen recortadas.
--   2. AL ESCRIBIR (`temporary_targets_clinical_bound`): ninguna fila ACTIVE
--      puede NACER contradiciendo una cota vigente en su rango, venga del RPC o
--      de un INSERT a mano. Es lo que vuelve la invariante estructural en vez
--      de procedimental: un objetivo que ensancha un techo clínico no es
--      representable en esta base.
--   3. AL CAMBIAR LO CLÍNICO (`clinical_restrictions_close_temporary_targets`):
--      confirmar o modificar una restricción REVOCA los objetivos temporales
--      ACTIVE que quedaron en contra. Sin esto, el caso "el techo llegó
--      después" queda abierto para siempre.
--
-- POR QUÉ NO HAY UNA CUARTA PARED EN LA LECTURA (re-componer al leer):
--   Con 2 y 3 puestas, una fila ACTIVE que contradiga una cota clínica no puede
--   existir: no puede nacer así y no puede quedarse así. Re-componer en cada
--   lector sería código que, si algún día se ejecutara de verdad, estaría
--   TAPANDO un bug de las paredes de escritura en vez de reportarlo —y un
--   lector que corrige en silencio es exactamente cómo un "no debería pasar" se
--   vuelve permanente—. Además hoy no hay ningún lector de
--   `member_temporary_targets` en `web/src`: la pared se pone donde el dato se
--   escribe, que es donde se puede negar. Lo que SÍ tiene que hacer el lector
--   que se escriba mañana es intersectar objetivo temporal con cota clínica al
--   componer el objetivo del día, porque ése es su trabajo (permanente +
--   override diario + evento + ajuste temporal), no reparar estas filas.
--
-- POR QUÉ SE REVOCA Y NO SE "SUPERSEDE":
--   `tt_superseded_pair` exige que SUPERSEDED venga con `superseded_by`, o sea
--   con OTRA fila de objetivo temporal que lo reemplace. Acá no hay
--   reemplazante: lo que apareció es una restricción clínica, que no es un
--   objetivo. Escribir SUPERSEDED con un `superseded_by` inventado, o aflojar
--   ese CHECK, sería mentir sobre qué pasó. El enum ya trae el verbo correcto
--   —"nada se borra: se supera, se vence o se REVOCA"— y REVOKED con
--   `closed_at` es exactamente eso.

/**
 * ¿Este objetivo temporal contradice alguna cota clínica en su rango?
 *
 * Devuelve NULL cuando no hay conflicto, o el objeto con el motivo cuando sí.
 * Es la MISMA lectura que usa `app.adaptive_bound_adjustments` —mínimo de los
 * techos, máximo de los pisos sobre `[p_from, p_until]`—, para que la pared que
 * escribe y la que revoca no puedan opinar distinto.
 *
 * UN OBJETIVO SIN TECHO BAJO UN TECHO CLÍNICO TAMBIÉN CONTRADICE. "No declaré
 * máximo" no es "el máximo clínico ya está aplicado": es un desconocido, y un
 * desconocido nunca significa que el límite se cumple. Lo mismo con el mínimo
 * ausente bajo un piso clínico. Es coherente con `adaptive_bound_adjustments`,
 * que cuando hay techo y el ajuste no trae máximo escribe el techo como máximo.
 */
create or replace function app.temporary_target_clinical_conflict(
  p_member uuid,
  p_goal   public.goal_type,
  p_min    numeric,
  p_pref   numeric,
  p_max    numeric,
  p_from   date,
  p_until  date
) returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_ctx   jsonb;
  v_key   text;
  v_techo numeric;
  v_piso  numeric;
  v_ids   jsonb;
begin
  v_key := app.adaptive_nutrient_key(p_goal);
  -- Un objetivo cuyo nutriente esta base no sabe nombrar no se puede comparar
  -- con nada. Hoy `adaptive_nutrient_key` cubre los cinco valores del enum, así
  -- que esto sólo se enciende si mañana alguien agrega un sexto sin traducirlo:
  -- se niega, no se deja pasar.
  if v_key is null then
    raise exception 'no hay clave de nutriente para el objetivo %: sin traducción no se puede componer contra una cota clínica', p_goal
      using errcode = 'check_violation';
  end if;

  v_ctx := app.adaptive_clinical_context(p_member, p_from, p_until);

  -- Una cota que no se puede aplicar BLOQUEA. "Hay un límite y no sabemos cuál"
  -- jamás es "no hay límite".
  if exists (
    select 1 from jsonb_array_elements(v_ctx->'unusable') u
    where u.value->>'nutrient' = v_key
  ) then
    return jsonb_build_object(
      'code', 'CLINICAL_LIMIT_UNUSABLE', 'nutrient', v_key,
      'detail', (select jsonb_agg(u.value)
                 from jsonb_array_elements(v_ctx->'unusable') u
                 where u.value->>'nutrient' = v_key));
  end if;

  select min((c.value->>'max')::numeric) into v_techo
  from jsonb_array_elements(v_ctx->'ceilings') c
  where c.value->>'nutrient' = v_key;

  select max((f.value->>'min')::numeric) into v_piso
  from jsonb_array_elements(v_ctx->'floors') f
  where f.value->>'nutrient' = v_key;

  v_ids := coalesce((
    select jsonb_agg(x.value->>'restriction_id')
    from (select value from jsonb_array_elements(v_ctx->'ceilings')
          union all
          select value from jsonb_array_elements(v_ctx->'floors')) x
    where x.value->>'nutrient' = v_key), '[]'::jsonb);

  if v_techo is not null
     and (p_max is null
          or p_max > v_techo
          or (p_pref is not null and p_pref > v_techo)
          or (p_min  is not null and p_min  > v_techo)) then
    return jsonb_build_object(
      'code', 'CLINICAL_CEILING_EXCEEDED', 'nutrient', v_key,
      'range', jsonb_build_object('from', p_from, 'until', p_until),
      'restriction_ids', v_ids);
  end if;

  if v_piso is not null
     and (p_min is null
          or p_min < v_piso
          or (p_pref is not null and p_pref < v_piso)
          or (p_max  is not null and p_max  < v_piso)) then
    return jsonb_build_object(
      'code', 'CLINICAL_FLOOR_BREACHED', 'nutrient', v_key,
      'range', jsonb_build_object('from', p_from, 'until', p_until),
      'restriction_ids', v_ids);
  end if;

  return null;
end;
$$;

/**
 * PARED 2 — ninguna fila ACTIVE nace contradiciendo una cota clínica.
 *
 * Corre sobre el INSERT y no sobre el UPDATE porque los números, las fechas y el
 * objetivo son inmutables después de escritos
 * (`temporary_target_is_append_only`): lo único que un UPDATE puede cambiar es
 * el bloque de cierre, y cerrar una fila nunca la pone en contra de una cota.
 *
 * NO se mete con `CLINICAL_ADJUSTMENT`: ése es el flujo clínico, con su propio
 * permiso y su propia revisión humana, y no es este motor quien lo audita.
 *
 * El mensaje NO dice el nutriente, ni la cifra, ni la severidad: rebota contra
 * un caller que puede no tener permiso médico (hallazgos #35 y #58).
 *
 * Desde `resolve_adaptive_review` esto es una ASERCIÓN y no un camino: ese RPC
 * ya compuso contra el mismo rango con la misma lectura, así que si acá rebota
 * es porque la pared 1 falló. Por eso NO se atrapa como "ajuste descartado" —eso
 * sería un catch que tapa un desconocido— y se lleva puesta la resolución
 * entera: con la composición clínica rota, los otros ajustes de esa misma
 * resolución tampoco son confiables.
 */
create or replace function app.temporary_target_respects_clinical_bounds()
returns trigger language plpgsql set search_path = public as $$
declare
  v_conf jsonb;
begin
  if new.status <> 'ACTIVE' then return new; end if;
  if new.provenance = 'CLINICAL_ADJUSTMENT' then return new; end if;
  -- Sin fechas no hay rango que consultar, y el NOT NULL de la tabla ya tiene
  -- ese reclamo con nombre. Hablar acá encima sería tapar el error real.
  if new.valid_from is null or new.valid_until is null then return new; end if;

  v_conf := app.temporary_target_clinical_conflict(
              new.member_id, new.goal_type,
              new.minimum, new.preferred, new.maximum,
              new.valid_from, new.valid_until);

  if v_conf is not null then
    raise exception 'una indicación de salud no deja pasar este ajuste en el rango de fechas pedido'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger temporary_targets_clinical_bound
  before insert on public.member_temporary_targets
  for each row execute function app.temporary_target_respects_clinical_bounds();

/**
 * PARED 3 — el techo que llega DESPUÉS cierra lo que quedó en contra.
 *
 * Revalida TODOS los objetivos temporales ACTIVE de la persona contra el
 * contexto clínico completo, no sólo contra la restricción que se acaba de
 * tocar: bajar el valor de una, extender su vigencia o confirmarla por primera
 * vez son el mismo hecho —"la cota de esta persona cambió"— y todos se cierran
 * con la misma revalidación.
 *
 * SECURITY DEFINER porque escribe en `member_temporary_targets`, cuya escritura
 * está revocada para `authenticated`, y el disparo puede venir de cualquier
 * camino que confirme una restricción.
 *
 * PRIVACIDAD: en la superficie del hogar (`member_temporary_targets` y
 * `audit_events`, que ve cualquier integrante / cualquier admin) el objetivo
 * sólo queda REVOKED con un código neutro. Decir "revocado por una indicación de
 * salud" ahí sería contarle a la familia entera que esa persona tiene una
 * condición, sin que nadie haya otorgado el permiso médico (hallazgo #49). El
 * motivo COMPLETO se apila en `adaptive_review_clinical_context`, que vive bajo
 * `app.medical_access`, igual que todo el resto del detalle clínico de esta
 * migración.
 */
create or replace function app.clinical_restriction_closes_temporary_targets()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t      public.member_temporary_targets;
  v_conf jsonb;
begin
  if new.type not in ('NUTRIENT_MAX', 'NUTRIENT_MIN')
     or new.verification_status <> 'CONFIRMED' then
    return null;
  end if;

  for t in
    select * from public.member_temporary_targets
    where member_id = new.member_id
      and status = 'ACTIVE'
      and provenance <> 'CLINICAL_ADJUSTMENT'
    order by id
  loop
    v_conf := app.temporary_target_clinical_conflict(
                t.member_id, t.goal_type, t.minimum, t.preferred, t.maximum,
                t.valid_from, t.valid_until);
    if v_conf is null then continue; end if;

    -- REVOKED, no SUPERSEDED: no hay otro objetivo que lo reemplace. Y sin
    -- `closed_by`: no lo cerró una persona, lo cerró la cota.
    update public.member_temporary_targets
    set status = 'REVOKED', closed_at = now()
    where id = t.id;

    if t.review_id is not null then
      update public.adaptive_review_clinical_context
      set clinical_overrides = clinical_overrides || jsonb_build_array(
            jsonb_build_object(
              'code', 'TEMPORARY_TARGET_REVOKED_BY_CLINICAL_BOUND',
              'target_id', t.id,
              'goal_type', t.goal_type::text,
              'valid_from', t.valid_from,
              'valid_until', t.valid_until,
              'restriction_id', new.id,
              'conflict', v_conf))
      where review_id = t.review_id;
    end if;

    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (t.household_id, auth.uid(), 'TEMPORARY_TARGET_REVOKED',
            'member_temporary_target', t.id,
            -- Código NEUTRO a propósito: ver el bloque de PRIVACIDAD de arriba.
            jsonb_build_object('goal_type', t.goal_type::text,
                               'code', 'REVALIDATION'));
  end loop;

  return null;
end;
$$;

create trigger clinical_restrictions_close_temporary_targets
  after insert or update on public.member_clinical_restrictions
  for each row execute function app.clinical_restriction_closes_temporary_targets();

-- ---------------------------------------------------------------------------
-- 9. RPC `create_adaptive_review` — persistir la PROPUESTA, en PENDING
-- ---------------------------------------------------------------------------

/**
 * El motor NO ESCRIBE: escribe esto, y esto nace PENDING.
 *
 * Idempotente por `dedupe_key = ADAPT:<persona>:<día>:<ventana>:<versión>`.
 * Reintentar devuelve el mismo id y no toca nada — mismo cuerpo que
 * `create_clinical_impact_review` (0027:526). La versión del motor va DENTRO de
 * la clave a propósito: una versión nueva sobre el mismo día es una propuesta
 * distinta, no un reintento de la anterior.
 *
 * Lo que se guarda NO es lo que el motor mandó, sino lo que el motor mandó ya
 * compuesto contra las cotas clínicas leídas acá adentro. Si algo quedó fuera,
 * el veredicto sube a REVIEW_REQUIRED: una propuesta a la que le faltan piezas
 * no puede parecer una propuesta completa.
 */
create or replace function public.create_adaptive_review(
  p_member_id      uuid,
  p_review_date    date,
  p_rolling_window public.adaptive_rolling_window,
  p_engine_version text,
  p_verdict        public.adaptive_verdict,
  p_payload        jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_hogar   uuid;
  v_hoy     date;
  v_id      uuid;
  v_key     text;
  v_adj     jsonb;
  v_bound   jsonb;
  v_verdict public.adaptive_verdict;
begin
  if not app.can_access_member(p_member_id) then
    raise exception 'no autorizado';
  end if;

  v_hogar := app.member_household(p_member_id);
  v_hoy   := app.household_today(v_hogar);

  if p_review_date is null or p_review_date > v_hoy then
    raise exception 'no se revisa un día que el hogar todavía no vive'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_engine_version, '')), '') is null then
    raise exception 'una revisión sin versión de motor no se puede auditar'
      using errcode = 'check_violation';
  end if;

  -- Los tres congelados son OBLIGATORIOS. Un `{}` por omisión sería una
  -- revisión que no sabe con qué reglas ni sobre qué datos se calculó, y eso no
  -- se puede auditar ni explicar después.
  if jsonb_typeof(p_payload->'plan_snapshot') <> 'object'
     or jsonb_typeof(p_payload->'intake_snapshot') <> 'object'
     or jsonb_typeof(p_payload->'params') <> 'object' then
    raise exception 'la propuesta necesita plan_snapshot, intake_snapshot y params: sin ellos no se puede auditar'
      using errcode = 'check_violation';
  end if;

  v_key := 'ADAPT:' || p_member_id::text || ':' || p_review_date::text || ':'
           || p_rolling_window::text || ':' || btrim(p_engine_version);

  select id into v_id from public.adaptive_nutrition_reviews where dedupe_key = v_key;
  if v_id is not null then return v_id; end if;

  v_adj := case when jsonb_typeof(p_payload->'adjustments') = 'array'
                then p_payload->'adjustments' else '[]'::jsonb end;

  -- Un veredicto que dice "ajusta" sin ningún ajuste no dice nada, y en la
  -- bandeja se leería como una propuesta vacía en vez de como un error.
  if p_verdict in ('OPTIONAL_ADJUSTMENT', 'RECOMMENDED_ADJUSTMENT')
     and jsonb_array_length(v_adj) = 0 then
    raise exception 'un veredicto que propone ajustar necesita al menos un ajuste: si no hay, el veredicto es NO_CHANGE o INSUFFICIENT_DATA'
      using errcode = 'check_violation';
  end if;

  -- CONTRA TODO EL HORIZONTE ALCANZABLE, no contra el día de la foto. Lo que
  -- se guarda acá es exactamente lo que `resolve_adaptive_review` le va a pasar
  -- al INSERT, y ese INSERT puede regir desde hoy hasta
  -- `adaptive_max_validity_days()` días más. Si la propuesta se compusiera sólo
  -- contra `p_review_date`, la bandeja le mostraría a la persona un número que
  -- después se achica solo al aplicarlo —o peor, uno que rige sobre un techo
  -- clínico que empieza mañana—. Recortar de más es seguro; recortar de menos
  -- es lo que esta migración existe para impedir.
  v_bound := app.adaptive_bound_adjustments(
               p_member_id, p_review_date,
               v_hoy + public.adaptive_max_validity_days(), v_adj);

  v_verdict := p_verdict;
  if jsonb_array_length(v_bound->'discarded') > 0 then
    -- Algo quedó fuera por una cota que no se pudo aplicar o que bloquea. Eso
    -- lo mira una persona; el sistema no lo resuelve solo.
    v_verdict := 'REVIEW_REQUIRED';
  end if;

  insert into public.adaptive_nutrition_reviews (
    household_id, member_id, review_date, rolling_window, engine_version, params,
    verdict, plan_snapshot, intake_snapshot, adjustments, reasons, missing_data,
    clinical_capped, dedupe_key
  ) values (
    v_hogar, p_member_id, p_review_date, p_rolling_window, btrim(p_engine_version),
    p_payload->'params', v_verdict,
    p_payload->'plan_snapshot', p_payload->'intake_snapshot',
    v_bound->'kept',
    case when jsonb_typeof(p_payload->'reasons') = 'array'
         then p_payload->'reasons' else '[]'::jsonb end,
    case when jsonb_typeof(p_payload->'missing_data') = 'array'
         then p_payload->'missing_data' else '[]'::jsonb end,
    coalesce((v_bound->>'capped')::boolean, false)
      or jsonb_array_length(v_bound->'discarded') > 0,
    v_key
  ) returning id into v_id;

  insert into public.adaptive_review_clinical_context (
    review_id, member_id, context_resolved, clinical_snapshot, clinical_overrides
  ) values (
    v_id, p_member_id,
    coalesce(((v_bound->'context')->>'resolved')::boolean, false),
    v_bound->'context',
    v_bound->'discarded'
  );

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_hogar, auth.uid(), 'ADAPTIVE_REVIEW_CREATED', 'adaptive_nutrition_review', v_id,
          jsonb_build_object('member_id', p_member_id, 'verdict', v_verdict::text,
                             'rolling_window', p_rolling_window::text));

  perform app.emit_event(v_hogar, 'ADAPTIVE_REVIEW_CREATED', 'adaptive_nutrition_review',
    jsonb_build_object('review_id', v_id, 'member_id', p_member_id,
                       'verdict', v_verdict::text),
    'ADAPTIVE_REVIEW_CREATED:' || v_key);

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. RPC `resolve_adaptive_review` — el único camino propuesta → objetivo
-- ---------------------------------------------------------------------------

/**
 * Con un humano detrás, y sólo con un humano detrás.
 *
 * `p_accepted` NO trae números. Trae qué ajuste de los PROPUESTOS se acepta
 * (`goal_type` + `scope` + `meal_type`) y desde cuándo hasta cuándo rige. Los
 * números salen de la propia revisión, ya recortados. Si el caller pudiera
 * mandar el número, "el motor propone y la base acota" se convertiría en "el
 * cliente escribe lo que quiera", y ninguna de las dos paredes serviría.
 *
 * Idempotente: si la revisión ya no está PENDING, retorna sin efecto.
 *
 * Escribe EN UNA SOLA TABLA: `member_temporary_targets`. Ni `nutrition_goals`,
 * ni `member_nutrition_profiles`, ni el plan diario, ni inventario, ni compras,
 * ni historia.
 *
 * Devuelve `{applied, discarded}` en vez de `void` (hallazgo #46): cuando lo
 * clínico gana, la persona tiene que ver "este ajuste no se aplicó y por qué",
 * no un error técnico que se llevó puestos los otros tres.
 */
create or replace function public.resolve_adaptive_review(
  p_review_id  uuid,
  p_resolution public.impact_review_status,
  p_accepted   jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_r        public.adaptive_nutrition_reviews;
  v_actor    uuid;
  v_hoy      date;
  v_a        jsonb;
  v_prop     jsonb;
  v_bound    jsonb;
  v_fin      jsonb;
  v_aplic    jsonb := '[]'::jsonb;
  v_desc     jsonb := '[]'::jsonb;
  v_clin     jsonb := '[]'::jsonb;
  v_from     date;
  v_until    date;
  v_scope    public.goal_scope;
  v_meal     public.meal_type;
  v_goal     public.goal_type;
  v_prev     public.member_temporary_targets;
  v_idx      int;
  v_new      uuid;
  v_capped   boolean := false;
begin
  select * into v_r from public.adaptive_nutrition_reviews
  where id = p_review_id for update;

  if v_r.id is null or not app.can_access_member(v_r.member_id) then
    raise exception 'no autorizado';
  end if;

  -- UNA PROPUESTA LA APRUEBA UNA PERSONA. `approved_by` es NOT NULL en la
  -- tabla, así que sin integrante detrás de la sesión esto no tendría con qué
  -- llenarse; se dice acá, con el motivo, y no se descubre después como una
  -- violación de NOT NULL que nadie sabe leer.
  v_actor := app.current_member_id(v_r.household_id);
  if v_actor is null then
    raise exception 'una propuesta la aprueba una persona: no hay integrante de este hogar detrás de la sesión';
  end if;

  if p_resolution not in ('REVIEWED', 'APPLIED', 'DISMISSED') then
    raise exception 'resolución inválida: PENDING no es una resolución'
      using errcode = 'check_violation';
  end if;

  if v_r.status <> 'PENDING' then
    -- Idempotente. El segundo clic no vuelve a aplicar nada: si lo hiciera,
    -- reintentar por una pantalla lenta duplicaría los ajustes.
    return jsonb_build_object(
      'review_id', p_review_id, 'status', v_r.status::text,
      'already_resolved', true, 'applied', '[]'::jsonb, 'discarded', '[]'::jsonb);
  end if;

  if p_resolution = 'APPLIED' then
    -- LO CLÍNICO VA PRIMERO. Con una revisión de salud sin resolver, el estado
    -- nutricional de esta persona está en disputa y ningún ajuste automático
    -- entra encima.
    if exists (
      select 1 from public.clinical_impact_reviews c
      where c.member_id = v_r.member_id and c.status = 'PENDING'
    ) then
      raise exception 'hay una revisión de salud pendiente para esta persona: eso se resuelve antes que cualquier ajuste adaptativo'
        using errcode = 'check_violation';
    end if;

    -- Serializa a todos los que apliquen ajustes de ESTA persona: el trigger de
    -- traslape mira filas ya escritas, y dos sesiones simultáneas podrían no
    -- verse. El candado muere con la transacción.
    perform pg_advisory_xact_lock(hashtext('adaptive_targets:' || v_r.member_id::text));

    v_hoy := app.household_today(v_r.household_id);

    for v_a in
      select value from jsonb_array_elements(
        case when jsonb_typeof(p_accepted) = 'array' then p_accepted else '[]'::jsonb end)
    loop
      v_scope := coalesce(nullif(v_a->>'scope', ''), 'DAILY')::public.goal_scope;
      v_meal  := nullif(v_a->>'meal_type', '')::public.meal_type;

      -- 1. Sólo se puede aceptar algo que la revisión PROPUSO. Sin esto, el
      --    RPC sería una puerta para escribir cualquier objetivo temporal.
      select x.value into v_prop
      from jsonb_array_elements(v_r.adjustments) x
      where x.value->>'goal_type' = v_a->>'goal_type'
        and coalesce(nullif(x.value->>'scope', ''), 'DAILY') = v_scope::text
        and coalesce(nullif(x.value->>'meal_type', ''), '-') = coalesce(v_meal::text, '-')
      limit 1;

      if v_prop is null then
        v_desc := v_desc || jsonb_build_array(jsonb_build_object(
          'goal_type', v_a->>'goal_type', 'code', 'NOT_IN_PROPOSAL'));
        continue;
      end if;
      v_goal := (v_prop->>'goal_type')::public.goal_type;

      -- 2. UN AJUSTE SIN TÉRMINO NO ES UN AJUSTE TEMPORAL. Se rechaza fuerte y
      --    con nombre: éste es el camino equivocado para lo que se pide.
      if nullif(v_a->>'valid_until', '') is null then
        raise exception 'un ajuste temporal sin fecha de término es un cambio de objetivo disfrazado: eso pasa por nutrition_goals con decisión humana'
          using errcode = 'check_violation';
      end if;

      v_from  := coalesce(nullif(v_a->>'valid_from', '')::date, v_hoy);
      v_until := (v_a->>'valid_until')::date;

      -- 3. HOY Y HACIA ADELANTE. Un día vivido no se reescribe: cambiarle el
      --    objetivo al martes pasado reinterpreta un consumo que ya ocurrió.
      if v_from < v_hoy then
        v_desc := v_desc || jsonb_build_array(jsonb_build_object(
          'goal_type', v_goal::text, 'code', 'VALID_FROM_IN_PAST'));
        continue;
      end if;
      if v_until < v_from then
        raise exception 'la fecha de término no puede ser anterior a la de inicio'
          using errcode = 'check_violation';
      end if;
      if v_until - v_from > public.adaptive_max_validity_days() then
        v_desc := v_desc || jsonb_build_array(jsonb_build_object(
          'goal_type', v_goal::text, 'code', 'EXCEEDS_MAX_VALIDITY_DAYS',
          'max_days', public.adaptive_max_validity_days()));
        continue;
      end if;

      -- 4. REVALIDACIÓN CLÍNICA CONTRA TODOS LOS DÍAS QUE VA A REGIR, no contra
      --    el día en que se propuso ni contra el día en que se firma: entre
      --    medio pudo confirmarse una restricción, y una que empieza mañana
      --    manda igual sobre un ajuste que dura hasta pasado mañana.
      v_bound := app.adaptive_bound_adjustments(v_r.member_id, v_from, v_until,
                                                jsonb_build_array(v_prop));
      if jsonb_array_length(v_bound->'discarded') > 0 then
        v_clin := v_clin || (v_bound->'discarded');
        v_desc := v_desc || jsonb_build_array(
          app.adaptive_public_discard_code((v_bound->'discarded')->0));
        continue;
      end if;
      v_fin := (v_bound->'kept')->0;
      if coalesce((v_fin->>'clinically_capped')::boolean, false) then
        v_capped := true;
        v_clin := v_clin || jsonb_build_array(jsonb_build_object(
          'goal_type', v_goal::text, 'code', 'CLINICAL_BOUNDS_APPLIED',
          'valid_from', v_from, 'valid_until', v_until, 'applied', v_fin));
      end if;

      -- 5. CADENA DE RENOVACIONES. Renovar tres días indefinidamente es un
      --    cambio de objetivo pagado en cuotas.
      select * into v_prev from public.member_temporary_targets t
      where t.member_id = v_r.member_id
        and t.goal_type = v_goal
        and t.scope = v_scope
        and t.meal_type is not distinct from v_meal
        and t.status in ('ACTIVE', 'EXPIRED', 'SUPERSEDED')
        and t.valid_until >= v_from - 1
      order by t.valid_until desc, t.created_at desc
      limit 1;

      v_idx := case when v_prev.id is null then 1 else v_prev.renewal_index + 1 end;
      if v_idx > 3 then
        v_desc := v_desc || jsonb_build_array(jsonb_build_object(
          'goal_type', v_goal::text, 'code', 'RENEWAL_LIMIT_REACHED',
          'hint', 'revisa el objetivo permanente con una persona'));
        continue;
      end if;

      -- 6. Y recién acá se escribe. El traslape lo rebota el trigger; se
      --    atrapa para que un choque no se lleve puestos los demás ajustes.
      begin
        insert into public.member_temporary_targets (
          household_id, member_id, goal_type, scope, meal_type,
          minimum, preferred, maximum, valid_from, valid_until,
          provenance, review_id, approved_by, frozen_params,
          renewal_of, renewal_index, reason
        ) values (
          v_r.household_id, v_r.member_id, v_goal, v_scope, v_meal,
          nullif(v_fin->>'minimum', '')::numeric,
          nullif(v_fin->>'preferred', '')::numeric,
          nullif(v_fin->>'maximum', '')::numeric,
          v_from, v_until,
          -- NUNCA 'CLINICAL_ADJUSTMENT': ése es el camino del flujo clínico,
          -- con su propio permiso, y no el de una propuesta adaptativa.
          'ADAPTIVE_ENGINE'::public.target_provenance,
          v_r.id, v_actor, v_r.params,
          case when v_idx = 1 then null else v_prev.id end, v_idx,
          nullif(btrim(coalesce(v_a->>'reason', '')), '')
        ) returning id into v_new;
      exception when exclusion_violation then
        v_desc := v_desc || jsonb_build_array(jsonb_build_object(
          'goal_type', v_goal::text, 'code', 'OVERLAPS_ACTIVE_TARGET'));
        continue;
      end;

      v_aplic := v_aplic || jsonb_build_array(jsonb_build_object(
        'target_id', v_new, 'goal_type', v_goal::text,
        'valid_from', v_from, 'valid_until', v_until));
    end loop;
  end if;

  update public.adaptive_nutrition_reviews
  set status = p_resolution,
      resolved_at = now(),
      resolved_by = v_actor,
      resolution_summary = jsonb_build_object(
        'resolution', p_resolution::text,
        'applied', v_aplic,
        'discarded', coalesce((select jsonb_agg(app.adaptive_public_discard_code(d.value))
                               from jsonb_array_elements(v_desc) d), '[]'::jsonb))
  where id = p_review_id;

  -- El detalle clínico se APILA en la tabla médica, no se pisa: lo que se
  -- guardó al proponer sigue ahí, y lo de la resolución se suma.
  if jsonb_array_length(v_clin) > 0 or v_capped then
    update public.adaptive_review_clinical_context
    set clinical_overrides = clinical_overrides || v_clin
    where review_id = p_review_id;
  end if;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_r.household_id, auth.uid(), 'ADAPTIVE_REVIEW_RESOLVED',
          'adaptive_nutrition_review', p_review_id,
          jsonb_build_object('resolution', p_resolution::text,
                             'applied', jsonb_array_length(v_aplic),
                             'discarded', jsonb_array_length(v_desc)));

  perform app.emit_event(v_r.household_id, 'ADAPTIVE_REVIEW_RESOLVED',
    'adaptive_nutrition_review',
    jsonb_build_object('review_id', p_review_id, 'resolution', p_resolution::text,
                       'applied', jsonb_array_length(v_aplic)),
    'ADAPTIVE_REVIEW_RESOLVED:' || p_review_id::text);

  return jsonb_build_object(
    'review_id', p_review_id, 'status', p_resolution::text,
    'already_resolved', false,
    'applied', v_aplic,
    'discarded', coalesce((select jsonb_agg(app.adaptive_public_discard_code(d.value))
                           from jsonb_array_elements(v_desc) d), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. RPC `expire_temporary_targets` — MANTENCIÓN, jamás camino de lectura
-- ---------------------------------------------------------------------------

/**
 * Marca EXPIRED los ajustes cuyo `valid_until` ya pasó, en el día del hogar.
 *
 * NO SE LLAMA AL LEER (hallazgo #75). Un RPC que hace UPDATE no se puede
 * invocar desde una vista ni desde una consulta de sólo lectura, y llamarlo en
 * cada carga de pantalla genera contención sobre las filas de la persona justo
 * cuando dos pestañas leen a la vez.
 *
 * Y NINGÚN LECTOR DEPENDE DE QUE ESTO HAYA CORRIDO: la única fuente de verdad
 * de la vigencia es el filtro por fecha
 * (`valid_from <= hoy and hoy <= valid_until`), que es DATE-only y lexicográfico
 * como todo el proyecto. Esto sólo ordena la casa para que la bandeja no
 * muestre como "vigente" algo que venció.
 */
create or replace function public.expire_temporary_targets(p_household uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_hoy date;
  v_n   int;
begin
  if not app.is_household_member(p_household) then
    raise exception 'no autorizado';
  end if;

  v_hoy := app.household_today(p_household);

  update public.member_temporary_targets
  set status = 'EXPIRED', closed_at = now()
  where household_id = p_household
    and status = 'ACTIVE'
    and valid_until < v_hoy;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
