-- 0041 — Sprint 13: el evento deja de ser una etiqueta del calendario y pasa a
-- ser un objeto operativo (asado con invitados, cantidades, compras y sobras).
--
-- ÚNICA migración del Sprint 13. No se toca ninguna de las 0001-0040: la 0040
-- todavía no está aplicada en el Supabase real, pero ya está escrita y probada,
-- y reescribirla ahora sería mover el piso bajo los tests de otro sprint.
--
-- ===========================================================================
-- LO QUE ESTE ARCHIVO VINO A ARREGLAR, ANTES DE AGREGAR NADA
-- ===========================================================================
--
-- Cinco defectos que la revisión adversarial encontró SOBRE EL DISEÑO, y que
-- se cierran acá adentro y no "después":
--
--  [H20 · BLOQUEANTE] El día del evento, el plan normal seguía comprando.
--      El diseño amarraba `meal_assignments.event_id` "para trazabilidad" y
--      nada más. Con eso, el sábado del asado la lista de compras pedía LAS
--      DOS cosas: los ingredientes del almuerzo confirmado y los kilos del
--      asado. La familia compra el doble y lo paga. Acá el evento RELEVA la
--      comida de verdad — y lo hace persona por persona, porque un asado al
--      que van tres de cinco no releva el almuerzo de los otros dos.
--      Sección 7.
--
--  [H23 · ALTO] El evento cancelado dejaba su demanda colgando en compras.
--      "CANCELLED no toca inventario" es correcto para los LOTES, pero las
--      líneas PENDING de la lista seguían ahí y `loadPendingListItems` las
--      lee sin mirar de dónde vienen. Un asado muerto seguía pidiendo 9 kg
--      de vacuno. Sección 8.
--
--  [H24 · ALTO] El evento de ayer se podía editar y reescribía la historia.
--      El guard propuesto sólo validaba transiciones de estado; nada impedía
--      cambiarle la fecha, el menú o los participantes a un evento COMPLETED,
--      y el aprendizaje y el resumen leen esas tablas VIVAS. Sección 6.
--
--  [H10 · ALTO] Dos rosters para el mismo hecho. `event_participants` (quién
--      se sienta a la mesa) y `nutrition_event_members` (a quién le relaja los
--      macros) podían decir cosas distintas, y `eventIncludes` lee "cero filas
--      = toda la familia": un evento creado por el builder nuevo le relajaba
--      los macros hasta al que dijo que NO iba. Sección 5.
--
--  [H26 · MEDIO] `flag_meals_on_event_change` (0008:258) sólo marcaba el
--      primer día del evento. Un viaje de tres días cancelado dejaba los días
--      2 y 3 confirmados y desalineados en silencio. Sección 9.
--
-- ===========================================================================
-- DOS DESVÍOS DEL DISEÑO, DECLARADOS
-- ===========================================================================
--
--  (a) `cut_definitions` NO tiene columna de rendimiento de cocción.
--      El diseño la pedía (`typical_cooking_yield`), y la lente de física de
--      cantidades encontró por qué no puede estar: `ingredient_yields` (0009)
--      YA es el dueño de "peso cocido = peso crudo × factor". Dos columnas
--      para el mismo factor terminan restando la merma dos veces (compra ~25%
--      inflada) o ninguna. La forma más barata de que dos dueños no discutan
--      es que el segundo no exista: acá se guardan SÓLO las etapas que la 0009
--      no cubre (hueso/desgrase y fracción servible), cada una con su etapa
--      origen→destino escrita.
--
--  (b) NO se seedea ni una fila de `cut_definitions`.
--      El §11 del contrato dice "solo usar factores explícitos validados" y el
--      §13 "sin factor: mostrar incertidumbre". No tengo fuente citable para
--      el rendimiento de una punta picana, y escribir un número plausible es
--      exactamente la falsa precisión que el sprint vino a prohibir. La tabla
--      nace vacía a propósito: UNKNOWN sigue UNKNOWN.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
--
-- Los `alter type ... add value` van PRIMERO y sus etiquetas nuevas no se usan
-- en ninguna otra línea de este archivo. No es estilo: PostgreSQL permite
-- agregar el valor dentro de una transacción, pero NO usarlo hasta que esa
-- transacción cierre, y el aplicador corre cada migración en una.

-- Los tipos que faltaban del §2. `BARBECUE` ya existe desde la 0007 y ya está
-- rotulado "Asado" en EVENT_LABELS: agregarle un alias `BBQ` daría dos verdades
-- para el mismo hecho, así que el tipo BBQ del contrato ES `BARBECUE`.
alter type public.nutrition_event_type add value if not exists 'RESTAURANT';
alter type public.nutrition_event_type add value if not exists 'WEDDING';
alter type public.nutrition_event_type add value if not exists 'FAMILY_GATHERING';
alter type public.nutrition_event_type add value if not exists 'PARTY';

-- Una línea de compra nacida de un evento no es ni FOOD_PLAN ni MANUAL: es su
-- propia procedencia, y la sección 8 necesita poder distinguirla.
alter type public.shopping_item_source add value if not exists 'EVENT';

create type public.event_status as enum
  ('DRAFT', 'PLANNED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

create type public.event_location_kind as enum ('HOME', 'AWAY');

-- §18. NULL = UNKNOWN. No hay valor "NORMAL" a propósito: un asado después de
-- un almuerzo completo no se estima igual que un almuerzo principal, y no saber
-- cuál de los dos es NO es lo mismo que saber que es el principal.
create type public.event_meal_context as enum
  ('FIRST_MAJOR_MEAL', 'AFTER_LUNCH', 'EVENING_WITH_SNACKS', 'FULL_DAY_EVENT', 'OTHER');

-- §19. NULL = UNKNOWN: no saber cuántos acompañamientos hay NO es "ninguno",
-- y leerlo como ninguno hace comprar carne de más.
create type public.event_sides_level as enum ('NONE', 'LIGHT', 'MEDIUM', 'ABUNDANT');

-- §25. El sobrante PLANIFICADO, que no es lo mismo que el margen de
-- incertidumbre del §26 (ese vive en safety_buffer_pct). Mezclarlos es sumar
-- dos veces el mismo colchón.
create type public.event_desired_leftover as enum
  ('NONE', 'SMALL_BUFFER', 'ONE_EXTRA_MEAL', 'CUSTOM');

create type public.event_participant_type as enum ('HOUSEHOLD_MEMBER', 'GUEST');

create type public.event_attendance_status as enum
  ('INVITED', 'CONFIRMED', 'MAYBE', 'DECLINED', 'ATTENDED', 'NO_SHOW');

-- §8. UNKNOWN es un valor de primera clase, no la ausencia de fila.
create type public.guest_age_group as enum
  ('CHILD_SMALL', 'CHILD', 'TEEN', 'ADULT', 'OLDER_ADULT', 'UNKNOWN');

create type public.guest_appetite as enum ('LOW', 'NORMAL', 'HIGH', 'VERY_HIGH', 'UNKNOWN');

-- §6. La lista COMPLETA de lo que la app puede saber de un invitado en materia
-- de comida. No hay diagnósticos acá y no los va a haber: un invitado no se
-- convierte en una ficha clínica por venir a un asado.
create type public.guest_dietary_flag as enum
  ('ALLERGY_REPORTED', 'VEGETARIAN', 'VEGAN', 'NO_PORK', 'NO_BEEF', 'NO_FISH', 'OTHER_DIETARY_NOTE');

create type public.bbq_menu_category as enum
  ('VACUNO', 'POLLO', 'CERDO', 'EMBUTIDOS', 'PESCADO', 'VEGETARIANO', 'OTRO');

create type public.event_menu_item_kind as enum ('MEAT', 'SIDE', 'BEVERAGE', 'NON_FOOD');

-- §12: las cuatro etapas del peso. Todo factor de rendimiento que se guarde de
-- acá en adelante dice de qué etapa a qué etapa va. Sin esto, "5 kg → 3,55 kg"
-- puede ser hueso, desgrase, cocción o las tres juntas, y componerlo con otro
-- factor descuenta la misma merma dos veces.
create type public.yield_stage as enum
  ('RAW_PURCHASE', 'EDIBLE_RAW', 'COOKED', 'SERVABLE');

-- ---------------------------------------------------------------------------
-- 2. El evento existente crece (§2: "ampliar el modelo existente")
-- ---------------------------------------------------------------------------
--
-- Se extiende `nutrition_events` y no se crea una tabla paralela: ya tiene
-- household_id, el rango de fechas, meal_type y strategy, y la leen
-- event-strategy/1.0.0, loadEventsForDate, el trigger de la 0008 y la RLS de la
-- 0039. Una tabla nueva partiría los lectores en dos.

alter table public.nutrition_events
  -- Las filas históricas quedan PLANNED: es lo que un evento del calendario
  -- significaba hasta hoy. Ni DRAFT (nunca fueron borradores) ni CONFIRMED
  -- (nadie confirmó nada).
  add column status            public.event_status not null default 'PLANNED',
  add column location_kind     public.event_location_kind not null default 'HOME',
  add column location_note     text,
  -- NULL = UNKNOWN, jamás 0. Un asado sin hora conocida no empieza a medianoche.
  add column serving_time      time,
  add column duration_hours    numeric(4, 1) check (duration_hours is null or duration_hours > 0),
  add column meal_context      public.event_meal_context,
  add column sides_level       public.event_sides_level,
  add column desired_leftover_kind public.event_desired_leftover,
  -- Sólo tiene sentido con desired_leftover_kind = 'CUSTOM' (§25). Se deja
  -- nullable en vez de forzarlo con un CHECK cruzado porque el armador guarda
  -- paso a paso y el orden en que la persona toca los campos es cosa suya.
  add column desired_leftover_g numeric(10, 2)
    check (desired_leftover_g is null or desired_leftover_g >= 0),
  add column safety_buffer_pct numeric(5, 2)
    check (safety_buffer_pct is null or (safety_buffer_pct >= 0 and safety_buffer_pct <= 50)),
  add column budget_clp        integer check (budget_clp is null or budget_clp >= 0),
  add column locked_at         timestamptz,
  add column locked_revision_id uuid,
  add column completed_at      timestamptz,
  add column cancelled_at      timestamptz,
  add column updated_at        timestamptz not null default now();

comment on column public.nutrition_events.status is
  'DRAFT/PLANNED/CONFIRMED/IN_PROGRESS/COMPLETED/CANCELLED. COMPLETED y '
  'CANCELLED son terminales: desde ahí el evento es historia y la sección 6 '
  'lo congela. Borrar de verdad sólo se puede en DRAFT.';

comment on column public.nutrition_events.meal_context is
  'NULL = UNKNOWN (§18). El estimador tiene que ensanchar el rango cuando no '
  'sabe en qué punto del día cae el evento; leerlo como "comida principal" '
  'sería UNKNOWN disfrazado de NORMAL.';

create trigger nutrition_events_touch
  before update on public.nutrition_events
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Invitados: gente de verdad, sin cuenta y sin ficha clínica (§5, §6)
-- ---------------------------------------------------------------------------

create table public.guest_profiles (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,

  -- Opcional a propósito: el §43 pide poder agregar "llegó otra persona" en un
  -- toque, y un formulario obligatorio en medio del asado no se llena nunca.
  name           text check (name is null or char_length(name) between 1 and 120),

  age_group      public.guest_age_group not null default 'UNKNOWN',
  sex            text check (sex is null or sex in ('F', 'M', 'OTHER')),

  -- §16/§78: peso y altura son señal OPCIONAL para estimar cuánta comida
  -- comprar. No son un dato clínico, no se usan para calcular IMC y no se le
  -- piden a nadie. Existen porque si el usuario los sabe, ayudan un poco.
  approx_weight_kg numeric(5, 1) check (approx_weight_kg is null or approx_weight_kg > 0),
  approx_height_cm numeric(5, 1) check (approx_height_cm is null or approx_height_cm > 0),

  appetite       public.guest_appetite not null default 'UNKNOWN',

  -- UNKNOWN != ZERO, escrito en la codificación misma:
  --   NULL         = nadie preguntó. El estimador baja la confianza.
  --   '{}' (vacío) = el invitado declaró que no tiene restricciones.
  -- Son hechos distintos y la UI los muestra distinto ("Sin información" vs
  -- "Sin restricciones"). Si esto fuera `not null default '{}'`, no preguntar
  -- se leería para siempre como "dijo que no tiene nada".
  dietary_flags  public.guest_dietary_flag[],

  -- Lo que el invitado REPORTÓ, en sus palabras. No es un diagnóstico y no
  -- se cruza con nada médico (§6, §23).
  allergy_note   text check (allergy_note is null or char_length(allergy_note) <= 500),

  notes          text,
  -- Un invitado con historia no se borra: se archiva. Ver el guard de más abajo.
  archived_at    timestamptz,
  created_by     uuid references public.household_members (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index guest_profiles_household_idx
  on public.guest_profiles (household_id) where archived_at is null;

comment on table public.guest_profiles is
  'Invitado sin cuenta, reutilizable entre eventos (§5). NUNCA se convierte en '
  'perfil clínico: sin diagnósticos, sin exámenes, sin FK a nada médico. '
  'historical_event_count NO se guarda acá — se deriva de event_participants, '
  'porque un contador guardado es un segundo escritor del mismo hecho.';

comment on column public.guest_profiles.dietary_flags is
  'NULL = sin información (UNKNOWN). Array vacío = el invitado declaró no tener '
  'restricciones. La diferencia es el sprint entero: sin ella, no preguntar se '
  'lee como "no tiene nada" y alguien come lo que no puede.';

create trigger guest_profiles_touch
  before update on public.guest_profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Participantes: quién se sienta a la mesa (§4)
-- ---------------------------------------------------------------------------

create table public.event_participants (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.nutrition_events (id) on delete cascade,
  participant_type  public.event_participant_type not null,
  member_id         uuid references public.household_members (id) on delete cascade,
  guest_id          uuid references public.guest_profiles (id) on delete cascade,
  attendance_status public.event_attendance_status not null default 'INVITED',

  -- §43: "+ llegó otra persona". Se marca para que el aprendizaje sepa que ese
  -- plato no estaba en el plan y no lo cuente como error de estimación.
  is_extra          boolean not null default false,

  -- §7: apetito SÓLO para este evento. El perfil del invitado no se toca — una
  -- comida jamás cambia un perfil.
  appetite_override public.guest_appetite,

  meal_participation text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- El XOR: o es de la casa, o es invitado. Nunca las dos ni ninguna.
  constraint event_participant_identity_xor check (
    (participant_type = 'HOUSEHOLD_MEMBER' and member_id is not null and guest_id is null)
    or
    (participant_type = 'GUEST' and guest_id is not null and member_id is null)
  )
);

-- Idempotencia y concurrencia (§92): dos planners agregando a la misma persona
-- al mismo evento producen UNA fila, no dos comensales inventados.
create unique index event_participants_member_uniq
  on public.event_participants (event_id, member_id) where member_id is not null;
create unique index event_participants_guest_uniq
  on public.event_participants (event_id, guest_id) where guest_id is not null;
create index event_participants_event_idx on public.event_participants (event_id);

create trigger event_participants_touch
  before update on public.event_participants
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. [H10] UN SOLO DUEÑO DEL ROSTER
-- ---------------------------------------------------------------------------
--
-- `nutrition_event_members` responde "¿a quién le relaja los macros este
-- evento?" y `eventIncludes` (web/src/domain/nutrition/events.ts:112) lee cero
-- filas como "a toda la familia". `event_participants` responde "¿quién viene?".
--
-- Mientras los dos se escribieran a mano, podían decir cosas distintas: el
-- builder nuevo llena participantes, nadie llena la otra tabla, y el evento
-- termina relajándole los objetivos hasta al que marcó DECLINED. Eso es
-- PLAN != REALITY al revés: la realidad ya dijo que no venía y el plan igual
-- le dio día libre.
--
-- La regla, escrita una sola vez y en la base:
--
--   Si el evento TIENE roster, `nutrition_event_members` es una PROYECCIÓN del
--   roster: exactamente los HOUSEHOLD_MEMBER cuya asistencia no sea DECLINED
--   ni NO_SHOW. Nadie más la escribe.
--
--   Si el evento NO tiene roster (todos los eventos anteriores a esta
--   migración), no se toca nada: sigue mandando lo que ya está escrito, con la
--   semántica legacy "vacío = todos".
--
-- Y no se reescribe la historia nutricional de un día que ya pasó: marcar
-- NO_SHOW el lunes siguiente corrige el roster, pero el sábado ya se comió.
--
-- ---------------------------------------------------------------------------
-- 5-bis. EL VACÍO DEJA DE SIGNIFICAR "TODA LA FAMILIA" POR OMISIÓN
-- ---------------------------------------------------------------------------
--
-- Lo de arriba cerraba el caso "el roster dice quién va". Quedaba abierto el
-- BORDE, que es donde vive el defecto de verdad: cero filas en
-- `nutrition_event_members` se seguía leyendo como "a toda la familia" en
-- web/src/app/plan/queries.ts y en domain/nutrition/events.ts. Dos situaciones
-- distintas terminaban en el mismo cero:
--
--   (a) un asado con once invitados y NINGÚN integrante del hogar;
--   (b) un asado donde todos los del hogar marcaron DECLINED.
--
-- En los dos casos la familia entera amanecía con el día RELAXED —incluidos los
-- que dijeron explícitamente que no iban— sin que nadie lo pidiera. Y no se
-- podía arreglar del lado del lector, porque el lector no tenía cómo distinguir
-- "nadie lo declaró todavía" de "se declaró y no quedó nadie".
--
-- Entonces el hecho se ESCRIBE, en vez de deducirse del largo de una lista:
--
--   LEGACY_EMPTY_MEANS_ALL — semántica 0007: vacío = toda la familia. Es el
--     valor por omisión, así que NINGÚN evento existente cambia de significado
--     y ningún escritor viejo (el formulario de /plan, los seeds, la demo)
--     necesita enterarse. Por eso tampoco hay backfill: el default YA es la
--     verdad de esas filas.
--   DECLARED_ROSTER — la lista manda, incluso vacía. Vacía = nadie del hogar.
--     Lo pone `app.sync_event_nutrition_members` en cuanto el evento tiene un
--     participante HOUSEHOLD_MEMBER, y no se saca nunca: volver a "todos" al
--     sacar a la última persona sería inventar de nuevo el efecto que este
--     bloque vino a matar.
--   UNDECLARED — nadie dijo a quién de la casa afecta. No es todos ni nadie: es
--     desconocido. No relaja los objetivos de nadie Y LA PANTALLA LO DICE. Lo
--     escribe el armador de /eventos al crear (web/src/app/eventos/actions.ts),
--     que es el único camino que hoy crea un evento sin preguntar por el hogar.
--
-- Un evento con roster de puros invitados se queda en UNDECLARED a propósito:
-- que la lista tenga gente no significa que alguien haya respondido la pregunta
-- "¿y quién de la casa come acá?".

create type public.event_member_scope as enum
  ('LEGACY_EMPTY_MEANS_ALL', 'DECLARED_ROSTER', 'UNDECLARED');

alter table public.nutrition_events
  add column member_scope public.event_member_scope
    not null default 'LEGACY_EMPTY_MEANS_ALL';

comment on column public.nutrition_events.member_scope is
  'Cómo se lee nutrition_event_members. LEGACY_EMPTY_MEANS_ALL: vacío = toda '
  'la familia (semántica 0007). DECLARED_ROSTER: la lista manda, vacía = nadie '
  'del hogar. UNDECLARED: nadie lo declaró — no afecta a nadie y se avisa. '
  'Todo lector del efecto de un evento tiene que mirar esta columna: sin ella '
  'cero filas es ambiguo, y la ambigüedad se resolvía siempre a favor de '
  'relajarle los macros a gente que no fue.';

create or replace function app.sync_event_nutrition_members(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_evento public.nutrition_events;
  v_hoy date;
  v_tiene_roster boolean;
begin
  select * into v_evento from public.nutrition_events where id = p_event;
  if v_evento.id is null then return; end if;

  v_tiene_roster := exists (
    select 1 from public.event_participants
    where event_id = p_event and participant_type = 'HOUSEHOLD_MEMBER'
  );

  -- Sin roster DEL HOGAR no hay proyección que hacer y tampoco hay declaración
  -- que registrar: una lista de puros invitados no responde "¿quién de la casa
  -- come acá?". Un evento legacy conserva sus filas tal como están: no saber
  -- quién viene NO autoriza a borrarlas.
  --
  -- La excepción es el evento que YA declaró su roster y se quedó sin nadie:
  -- ahí el vacío es una respuesta y hay que limpiar la proyección, o el último
  -- que se bajó del asado seguiría con su día RELAXED para siempre.
  if not v_tiene_roster and v_evento.member_scope is distinct from 'DECLARED_ROSTER' then
    return;
  end if;

  v_hoy := app.household_today(v_evento.household_id);

  -- El día ya pasó: el efecto nutricional de ese día es historia. Se corrige el
  -- roster (para el aprendizaje) pero no se reescribe lo que la familia ya vivió.
  if coalesce(v_evento.end_date, v_evento.event_date) < v_hoy then
    return;
  end if;

  -- Desde acá el roster del hogar MANDA, incluso cuando la proyección queda en
  -- cero filas porque todos marcaron DECLINED. Sin esta marca, ese cero volvía
  -- a leerse como "toda la familia" y el evento le relajaba los objetivos justo
  -- a quienes dijeron que no iban.
  if v_tiene_roster and v_evento.member_scope is distinct from 'DECLARED_ROSTER' then
    update public.nutrition_events
       set member_scope = 'DECLARED_ROSTER'
     where id = p_event;
  end if;

  -- La bandera le abre la puerta al ÚNICO escritor legítimo (ver el guard de
  -- más abajo). Sin ella, esta misma función chocaría contra su propia pared.
  perform set_config('app.event_roster_sync', p_event::text, true);

  delete from public.nutrition_event_members m
  where m.event_id = p_event
    and not exists (
      select 1 from public.event_participants p
      where p.event_id = p_event
        and p.member_id = m.member_id
        and p.attendance_status not in ('DECLINED', 'NO_SHOW')
    );

  insert into public.nutrition_event_members (event_id, member_id)
  select p.event_id, p.member_id
  from public.event_participants p
  where p.event_id = p_event
    and p.participant_type = 'HOUSEHOLD_MEMBER'
    and p.attendance_status not in ('DECLINED', 'NO_SHOW')
  on conflict do nothing;

  perform set_config('app.event_roster_sync', '', true);
end;
$$;

comment on function app.sync_event_nutrition_members(uuid) is
  'Proyecta el roster operativo sobre el efecto nutricional. Existe para que '
  'los dos no puedan discrepar: el que marcó DECLINED no recibe día RELAXED.';

create or replace function app.event_roster_is_the_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event uuid := coalesce(new.event_id, old.event_id);
begin
  -- La sincronización se identifica por el id del evento, no por un booleano:
  -- así una bandera olvidada por otra transacción no abre la puerta de este.
  if nullif(current_setting('app.event_roster_sync', true), '') = v_event::text then
    return coalesce(new, old);
  end if;

  if exists (
    select 1 from public.event_participants
    where event_id = v_event and participant_type = 'HOUSEHOLD_MEMBER'
  ) then
    raise exception
      'este evento tiene lista de participantes: agrega o saca a la persona ahí, no acá'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists event_members_roster_owner on public.nutrition_event_members;
create trigger event_members_roster_owner
  before insert or update or delete on public.nutrition_event_members
  for each row execute function app.event_roster_is_the_owner();

create or replace function app.event_participants_sync_members()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event uuid := coalesce(new.event_id, old.event_id);
  v_household uuid;
begin
  perform app.sync_event_nutrition_members(v_event);
  perform app.refresh_event_meal_coverage(v_event);

  select household_id into v_household from public.nutrition_events where id = v_event;
  if v_household is not null then
    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (
      v_household, auth.uid(), 'EVENT_PARTICIPANT_' || tg_op, 'nutrition_event', v_event,
      jsonb_build_object(
        'participant_id', coalesce(new.id, old.id),
        'attendance', coalesce(new.attendance_status, old.attendance_status)));

    insert into public.domain_events
      (household_id, event_type, aggregate, payload, scope, dedupe_key)
    values (
      v_household, 'EVENT_PARTICIPANT_CHANGED', 'nutrition_event',
      jsonb_build_object('event_id', v_event, 'op', tg_op),
      jsonb_build_object('event_id', v_event),
      'EVENT_PARTICIPANT_CHANGED:' || v_event::text || ':' ||
        coalesce(new.id, old.id)::text || ':' || tg_op || ':' ||
        coalesce(new.attendance_status, old.attendance_status)::text)
    on conflict (dedupe_key) do nothing;
  end if;

  return coalesce(new, old);
end;
$$;

create trigger event_participants_sync
  after insert or update or delete on public.event_participants
  for each row execute function app.event_participants_sync_members();

-- ---------------------------------------------------------------------------
-- 6. [H24] LA HISTORIA NO SE REESCRIBE
-- ---------------------------------------------------------------------------
--
-- El guard de transiciones por sí solo dejaba abierta la puerta grande: nada
-- impedía hacerle UPDATE de fecha, tipo o menú a un evento COMPLETED, ni
-- agregarle participantes tres días después. Y como bbq-learning y el resumen
-- del §56 leen esas tablas VIVAS (sólo la revisión del plan está congelada),
-- editar el asado de ayer cambiaba retroactivamente lo "real" que alimenta el
-- aprendizaje. El §95 dice "no alterar historia" y el §3 "no borrar historia de
-- eventos completados"; esto es lo que hace que sea cierto.
--
-- LA VENTANA DE CORRECCIÓN. Un asado se cierra y al rato alguien se acuerda de
-- que la tía nunca llegó, o de que quedaron 800 g. Eso es CORREGIR un dato
-- real, no reescribir el plan. Se permite durante 72 horas desde que el evento
-- entró en estado terminal, sólo sobre los campos de la realidad, y siempre
-- deja fila en audit_events. Fuera de la ventana, la corrección es una fila
-- nueva (patrón libro mayor), nunca un UPDATE.

create or replace function app.event_correction_window_hours()
returns int language sql immutable as $$ select 72 $$;

comment on function app.event_correction_window_hours() is
  'Horas después de cerrar un evento en las que todavía se puede corregir un '
  'dato REAL (asistencia, sobras). Vive en una función y no como número suelto '
  'para que el motor, la UI y este guard lean el mismo valor.';

create or replace function app.event_history_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cierre timestamptz;
begin
  if tg_op = 'DELETE' then
    -- Borrado físico SÓLO en borrador. Desde PLANNED la única salida es
    -- CANCELLED, que conserva la fila y todo lo que colgaba de ella.
    if old.status <> 'DRAFT' then
      raise exception
        'este evento ya salió del borrador: se cancela, no se borra (su historia queda)'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.status not in ('COMPLETED', 'CANCELLED') then
    return new;
  end if;

  v_cierre := coalesce(old.completed_at, old.cancelled_at, old.created_at);

  -- Campos de PLAN: congelados desde el instante en que el evento cerró. No hay
  -- ventana para estos, porque cambiar la fecha o el tipo de un asado que ya
  -- ocurrió no corrige nada: inventa otro asado encima del que pasó.
  if new.event_date  is distinct from old.event_date
     or new.end_date      is distinct from old.end_date
     or new.event_type    is distinct from old.event_type
     or new.meal_type     is distinct from old.meal_type
     or new.strategy      is distinct from old.strategy
     or new.household_id  is distinct from old.household_id
     or new.title         is distinct from old.title
     or new.serving_time  is distinct from old.serving_time
     or new.duration_hours is distinct from old.duration_hours
     or new.meal_context  is distinct from old.meal_context
     or new.budget_clp    is distinct from old.budget_clp
     or new.sides_level   is distinct from old.sides_level
     or new.desired_leftover_kind is distinct from old.desired_leftover_kind
     or new.desired_leftover_g    is distinct from old.desired_leftover_g
     or new.safety_buffer_pct     is distinct from old.safety_buffer_pct
     or new.location_kind is distinct from old.location_kind
     -- La marca de cierre también se congela: si se pudiera correr hacia
     -- adelante, la ventana de corrección se estiraría sola para siempre y
     -- dejaría de ser una ventana.
     or new.completed_at  is distinct from old.completed_at
     or new.cancelled_at  is distinct from old.cancelled_at then
    raise exception
      'este evento ya está cerrado: su plan es historia y no se reescribe'
      using errcode = 'check_violation';
  end if;

  -- Notas y observaciones sí, y sólo dentro de la ventana.
  if (new.notes is distinct from old.notes
      or new.location_note is distinct from old.location_note)
     and now() > v_cierre + make_interval(hours => app.event_correction_window_hours()) then
    raise exception
      'pasaron más de % horas desde que se cerró este evento: la corrección va como registro nuevo, no encima del anterior',
      app.event_correction_window_hours() using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger nutrition_events_history_guard
  before update or delete on public.nutrition_events
  for each row execute function app.event_history_guard();

/**
 * El mismo candado para lo que cuelga del evento.
 *
 * Se resuelve por `tg_table_name` y `to_jsonb` y no con `new.campo` a propósito:
 * plpgsql prepara la expresión entera antes de ejecutarla, así que una rama que
 * nombra un campo inexistente revienta aunque no se tome (mismo tropiezo que
 * documenta app.exigir_can_edit_plan en la 0039:352).
 */
create or replace function app.event_children_history_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event uuid;
  v_evento public.nutrition_events;
  v_cierre timestamptz;
  v_dentro boolean;
begin
  -- NO se usa `to_jsonb(new)` en el DECLARE: en un trigger de DELETE el
  -- registro `new` no está asignado y convertirlo revienta antes de llegar a
  -- la primera línea del cuerpo. Se pregunta por la operación primero.
  if tg_op = 'DELETE' then v_event := old.event_id; else v_event := new.event_id; end if;

  select * into v_evento from public.nutrition_events where id = v_event;

  -- Si no se puede resolver el evento, no se deja pasar: un guardián que ante
  -- la duda abre la puerta no es un guardián (0039:365).
  if v_evento.id is null then
    raise exception 'no se pudo determinar el evento de esta fila: no se escribe a ciegas'
      using errcode = 'check_violation';
  end if;

  if v_evento.status not in ('COMPLETED', 'CANCELLED') then
    return coalesce(new, old);
  end if;

  v_cierre := coalesce(v_evento.completed_at, v_evento.cancelled_at, v_evento.created_at);
  v_dentro := now() <= v_cierre + make_interval(hours => app.event_correction_window_hours());

  if tg_table_name = 'event_participants' then
    -- Sumar o sacar comensales de un asado que ya pasó cambia el denominador
    -- del aprendizaje entero. Eso no es corregir: es reescribir.
    if tg_op <> 'UPDATE' then
      raise exception
        'este evento ya está cerrado: no se agregan ni se quitan comensales (marca su asistencia real)'
        using errcode = 'check_violation';
    end if;
    -- Lo ÚNICO que se corrige tarde es la realidad: quién llegó y qué se anotó.
    if new.member_id is distinct from old.member_id
       or new.guest_id is distinct from old.guest_id
       or new.participant_type is distinct from old.participant_type
       or new.is_extra is distinct from old.is_extra
       or new.appetite_override is distinct from old.appetite_override then
      raise exception
        'este evento ya está cerrado: sólo se puede corregir la asistencia real y las notas'
        using errcode = 'check_violation';
    end if;
    if not v_dentro then
      raise exception
        'pasaron más de % horas desde que se cerró este evento: la asistencia queda como quedó',
        app.event_correction_window_hours() using errcode = 'check_violation';
    end if;
    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (
      v_evento.household_id, auth.uid(), 'EVENT_ATTENDANCE_CORRECTED',
      'nutrition_event', v_event,
      jsonb_build_object(
        'participant_id', new.id,
        'de', old.attendance_status,
        'a', new.attendance_status));
    return new;
  end if;

  -- El menú de un evento cerrado es historia pura: no se toca ni dentro de la
  -- ventana. Lo que se sirvió de verdad vive en los registros de servido.
  raise exception
    'este evento ya está cerrado: su menú es historia y no se reescribe'
    using errcode = 'check_violation';
end;
$$;

create trigger event_participants_history_guard
  before insert or update or delete on public.event_participants
  for each row execute function app.event_children_history_guard();

-- ---------------------------------------------------------------------------
-- 7. [H20 · BLOQUEANTE] EL EVENTO RELEVA LA COMIDA, PERSONA POR PERSONA
-- ---------------------------------------------------------------------------
--
-- El defecto se ve en la plata: el sábado del asado, `futureDemand`
-- (web/src/app/stock/queries.ts:190) proyecta los ingredientes del almuerzo
-- confirmado Y la lista del evento pide los kilos de carne. La familia compra
-- las dos cosas.
--
-- Arreglarlo cambiando `meal_assignments.kind` a 'EVENT' NO sirve, y vale la
-- pena decir por qué: el CHECK `assignment_recipe_needs_version` (0007:78)
-- obliga a `version_id is null` cuando kind deja de ser RECIPE. O sea que
-- "relevar" borraría la receta planificada, y cancelar el evento no tendría
-- desde dónde restaurarla. La comida no se borra: se RELEVA.
--
-- Y se releva POR PERSONA, porque el caso normal es el asado al que van tres de
-- cinco: a esos tres el asado les reemplaza el almuerzo, a los otros dos no, y
-- su comida —y su demanda— siguen en pie.

alter table public.member_serving_projections
  add column covered_by_event_id uuid references public.nutrition_events (id) on delete set null;

create index servings_covered_by_event_idx
  on public.member_serving_projections (covered_by_event_id)
  where covered_by_event_id is not null;

comment on column public.member_serving_projections.covered_by_event_id is
  'Con valor: esta porción planificada la cubre un evento, así que NO demanda '
  'ingredientes ni entra a la lista de compras. Es la única marca que releva '
  'una comida; todo lector de demanda futura tiene que filtrarla (o leer la '
  'vista public.open_serving_demand, que ya lo hace).';

-- Linaje del §96: qué slot del plan toca este evento.
alter table public.meal_assignments
  add column event_id uuid references public.nutrition_events (id) on delete set null;
create index assignments_event_idx on public.meal_assignments (event_id) where event_id is not null;

comment on column public.meal_assignments.event_id is
  'El evento que cae sobre este slot. Sirve para decirlo en pantalla '
  '("reemplaza: Almuerzo sábado"). Quién queda relevado de verdad se lee en '
  'member_serving_projections.covered_by_event_id, porque un evento puede '
  'cubrir a media familia.';

/**
 * LA PUERTA ÚNICA de la demanda futura.
 *
 * Existe para que relevar una comida no dependa de que cada lector se acuerde
 * de agregar un filtro. `security_invoker` deja que la RLS de la tabla base
 * siga mandando: la vista no le abre a nadie nada que no pudiera ver ya.
 */
create view public.open_serving_demand with (security_invoker = true) as
  select p.id as projection_id,
         p.member_id,
         p.assignment_id,
         p.serving_date,
         p.status
  from public.member_serving_projections p
  where p.status = 'PLANNED'
    and p.assignment_id is not null
    and p.covered_by_event_id is null;

comment on view public.open_serving_demand is
  'Porciones planificadas que TODAVÍA demandan comida: las que un evento ya '
  'relevó no están acá. Es la lista que tienen que leer el análisis de stock y '
  'el generador de la lista de compras.';

create or replace function app.apply_event_meal_coverage(p_event uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_evento public.nutrition_events;
  v_hasta date;
  v_slots int := 0;
  v_porciones int := 0;
  v_roster int;
begin
  select * into v_evento from public.nutrition_events where id = p_event;
  if v_evento.id is null then
    raise exception 'evento inexistente' using errcode = 'no_data_found';
  end if;

  -- SIN COMIDA DECLARADA NO SE RELEVA NADA. `meal_type` en NULL significa "no
  -- sabemos qué comida cubre", y eso NO es "las cubre todas": relevar de más
  -- deja a la familia sin comprar el almuerzo. UNKNOWN nunca es un permiso.
  if v_evento.meal_type is null then
    return jsonb_build_object(
      'slots', 0, 'servings', 0,
      'reason', 'EVENT_MEAL_TYPE_UNKNOWN');
  end if;

  select count(*) into v_roster
  from public.event_participants
  where event_id = p_event
    and participant_type = 'HOUSEHOLD_MEMBER'
    and attendance_status not in ('DECLINED', 'NO_SHOW');

  -- Sin roster no se sabe a QUIÉN releva. Relevar "a todos" por omisión sería
  -- exactamente el "vacío = todos" que la sección 5 vino a acotar, pero esta
  -- vez con la compra de por medio.
  if v_roster = 0 then
    return jsonb_build_object('slots', 0, 'servings', 0, 'reason', 'EVENT_NO_ROSTER');
  end if;

  v_hasta := coalesce(v_evento.end_date, v_evento.event_date);

  with slots as (
    select a.id
    from public.meal_assignments a
    join public.weekly_plan_days d on d.id = a.day_id
    join public.weekly_plans w on w.id = d.plan_id
    where w.household_id = v_evento.household_id
      and d.plan_date between v_evento.event_date and v_hasta
      and a.meal_type = v_evento.meal_type
  ), marcadas as (
    update public.meal_assignments a
    set event_id = p_event
    where a.id in (select id from slots)
    returning a.id
  )
  select count(*) into v_slots from marcadas;

  with cubiertos as (
    update public.member_serving_projections p
    set covered_by_event_id = p_event
    from public.meal_assignments a
    where p.assignment_id = a.id
      and a.event_id = p_event
      and p.status = 'PLANNED'
      and p.covered_by_event_id is null
      and exists (
        select 1 from public.event_participants ep
        where ep.event_id = p_event
          and ep.member_id = p.member_id
          and ep.attendance_status not in ('DECLINED', 'NO_SHOW')
      )
    returning p.id
  )
  select count(*) into v_porciones from cubiertos;

  return jsonb_build_object('slots', v_slots, 'servings', v_porciones, 'reason', 'OK');
end;
$$;

comment on function app.apply_event_meal_coverage(uuid) is
  'Releva del plan las porciones que el evento va a cubrir, sólo de la gente '
  'que efectivamente va. Sin meal_type o sin roster no releva nada y lo dice '
  'con un motivo: relevar de menos hace comprar de más, relevar de más deja a '
  'alguien sin almuerzo, y de los dos errores el segundo es el que no se puede '
  'deshacer el sábado a las dos de la tarde.';

/**
 * El roster cambió DESPUÉS de confirmar: alguien se bajó o alguien se sumó.
 *
 * Se recalcula sólo si el evento TODAVÍA NO PASÓ. El día del asado y después,
 * la compra ya está hecha y devolverle la comida al plan a quien avisó a última
 * hora sería reescribir una compra que ya ocurrió (§42, §43: "NO reescribir
 * compra ya realizada"). Ahí la marca de asistencia sirve para el resumen y el
 * aprendizaje, no para mover kilos.
 */
create or replace function app.refresh_event_meal_coverage(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_evento public.nutrition_events;
begin
  select * into v_evento from public.nutrition_events where id = p_event;
  if v_evento.id is null then return; end if;
  if v_evento.status not in ('CONFIRMED', 'IN_PROGRESS') then return; end if;
  if v_evento.event_date < app.household_today(v_evento.household_id) then return; end if;

  -- Quien se bajó recupera su comida...
  update public.member_serving_projections p
  set covered_by_event_id = null
  where p.covered_by_event_id = p_event
    and p.status = 'PLANNED'
    and not exists (
      select 1 from public.event_participants ep
      where ep.event_id = p_event
        and ep.member_id = p.member_id
        and ep.attendance_status not in ('DECLINED', 'NO_SHOW')
    );

  -- ...y quien se sumó deja de demandarla.
  perform app.apply_event_meal_coverage(p_event);
end;
$$;

create or replace function app.release_event_meal_coverage(p_event uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_liberadas int;
begin
  -- Sólo se suelta lo que todavía es plan. Una porción ya SERVED o CONSUMED
  -- ocurrió de verdad y su marca es historia.
  with sueltas as (
    update public.member_serving_projections p
    set covered_by_event_id = null
    where p.covered_by_event_id = p_event
      and p.status = 'PLANNED'
    returning p.id
  )
  select count(*) into v_liberadas from sueltas;

  update public.meal_assignments a
  set event_id = null
  where a.event_id = p_event
    and a.status <> 'SERVED';

  return v_liberadas;
end;
$$;

/**
 * LA OTRA MITAD DE LA PUERTA: lo que el evento SÍ relevó.
 *
 * `open_serving_demand` responde "qué falta comprar". Sola, deja el relevo
 * invisible: la lista se acorta y nadie sabe por qué. Esta vista responde la
 * pregunta gemela —"qué NO estoy comprando y por culpa de qué evento"— para
 * que la pantalla lo pueda decir con palabras: "el sábado no se compra el
 * almuerzo porque hay un asado". Una lista que encoge sin explicación se lee
 * como un error del sistema y termina con alguien comprando igual.
 */
create view public.event_covered_demand with (security_invoker = true) as
  select p.id           as projection_id,
         p.member_id,
         p.assignment_id,
         p.serving_date,
         p.meal_type,
         e.id           as event_id,
         e.title        as event_title,
         e.event_date   as event_date,
         e.event_type   as event_type,
         e.status       as event_status
  from public.member_serving_projections p
  join public.nutrition_events e on e.id = p.covered_by_event_id
  where p.status = 'PLANNED';

comment on view public.event_covered_demand is
  'Porciones planificadas que un evento releva, con el evento que las releva. '
  'Es el complemento de public.open_serving_demand: la primera dice qué '
  'comprar, ésta dice qué se dejó de comprar y por qué.';

/**
 * [H20 · el relevo sobrevive a reconfirmar la comida]
 *
 * `public.confirm_meal_assignment` (0025:89) BORRA todas las proyecciones del
 * slot y las vuelve a insertar. Con eso `covered_by_event_id` volvía a NULL en
 * silencio, y el propio evento empuja a reconfirmar: el trigger
 * `events_flag_meals` (0008) marca esa comida con needs_review "Cambió un
 * evento de ese día", que es exactamente la invitación a recalcularla. O sea
 * que el relevo se perdía justo por el camino que el evento provoca.
 *
 * No se arregla en la 0025 —congelada— ni pidiéndole a cada escritor que se
 * acuerde: se arregla en la TABLA. La marca no se "restaura": se DERIVA de un
 * hecho que la reconfirmación no toca, `meal_assignments.event_id`, y se
 * comprueba contra el evento vivo y contra el roster. Una porción que nace
 * dentro de un slot que un evento confirmado cubre, para alguien que va,
 * nace relevada.
 *
 * BEFORE y no AFTER a propósito: escribir la columna en el propio NEW evita
 * un UPDATE sobre la misma tabla desde su propio trigger (y la recursión que
 * viene con él).
 */
create or replace function app.projection_inherits_event_coverage()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event uuid;
begin
  -- Una marca que ya viene puesta no se pisa: quien la escribió sabía más.
  if new.covered_by_event_id is not null then return new; end if;
  if new.assignment_id is null or new.status <> 'PLANNED' then return new; end if;

  select a.event_id into v_event
  from public.meal_assignments a
  where a.id = new.assignment_id;

  if v_event is null then return new; end if;

  -- El relevo vale sólo si el evento SIGUE relevando (confirmado o en curso) y
  -- si esta persona sigue yendo. Heredarlo sin mirar el roster dejaría sin
  -- almuerzo a quien se bajó, que es el error que no se deshace el sábado a
  -- las dos de la tarde.
  if not exists (
    select 1
    from public.nutrition_events e
    join public.event_participants ep on ep.event_id = e.id
    where e.id = v_event
      and e.status in ('CONFIRMED', 'IN_PROGRESS')
      and ep.participant_type = 'HOUSEHOLD_MEMBER'
      and ep.member_id = new.member_id
      and ep.attendance_status not in ('DECLINED', 'NO_SHOW')
  ) then
    return new;
  end if;

  new.covered_by_event_id := v_event;
  return new;
end;
$$;

create trigger servings_inherit_event_coverage
  before insert on public.member_serving_projections
  for each row execute function app.projection_inherits_event_coverage();

comment on function app.projection_inherits_event_coverage() is
  'Hace que el relevo del evento sobreviva a un DELETE+INSERT de las '
  'proyecciones (confirm_meal_assignment, 0025). La marca se deriva de '
  'meal_assignments.event_id + el estado del evento + el roster, así que '
  'reconfirmar la comida no puede devolver la demanda a la lista en silencio.';

-- ---------------------------------------------------------------------------
-- 8. El estado del evento: guard de transiciones y sus efectos
-- ---------------------------------------------------------------------------
--
-- Los efectos viven en el TRIGGER y no en un RPC. Es deliberado: la RLS de la
-- 0039 deja que cualquiera con can_edit_plan haga UPDATE de nutrition_events
-- por PostgREST directo, así que un RPC "puerta única" tendría una puerta de
-- servicio al lado. Con el trigger, el efecto ocurre venga por donde venga.

create or replace function app.event_status_transition_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ok boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  v_ok := case old.status
    when 'DRAFT'       then new.status in ('PLANNED', 'CANCELLED')
    when 'PLANNED'     then new.status in ('DRAFT', 'CONFIRMED', 'CANCELLED')
    when 'CONFIRMED'   then new.status in ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
    when 'IN_PROGRESS' then new.status in ('COMPLETED', 'CANCELLED')
    -- COMPLETED y CANCELLED son terminales. Un evento que ocurrió no
    -- "vuelve" a planificarse: se duplica (§69), que es otro evento.
    else false
  end;

  if not v_ok then
    raise exception 'un evento % no puede pasar a %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if new.status = 'COMPLETED' then new.completed_at := coalesce(new.completed_at, now()); end if;
  if new.status = 'CANCELLED' then new.cancelled_at := coalesce(new.cancelled_at, now()); end if;

  return new;
end;
$$;

create trigger nutrition_events_status_guard
  before update on public.nutrition_events
  for each row execute function app.event_status_transition_guard();

/**
 * [H23] Lo que pasa DESPUÉS de cambiar el estado.
 *
 * El agujero que cierra: "CANCELLED no toca inventario" es correcto para los
 * LOTES —lo comprado está comprado (§83)— pero el diseño se callaba sobre las
 * líneas de compra PENDING nacidas del evento. `loadPendingListItems` las lee
 * todas sin mirar procedencia, así que un asado muerto seguía pidiendo 9 kg de
 * vacuno y el ProcurementEngine seguía neteándolo.
 *
 * Se marcan SKIPPED, no se borran: la lista es historia (demo M) y una línea
 * que desaparece sin dejar rastro es peor que una línea de más.
 */
create or replace function app.event_status_effects()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cobertura jsonb;
  v_liberadas int;
  v_lineas int := 0;
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status in ('CONFIRMED', 'IN_PROGRESS') then
    v_cobertura := app.apply_event_meal_coverage(new.id);
    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (new.household_id, auth.uid(), 'EVENT_MEAL_COVERAGE_APPLIED',
            'nutrition_event', new.id, v_cobertura);
  end if;

  -- Volver a PLANNED o a DRAFT deshace el relevo: si el evento dejó de estar
  -- confirmado, la comida de ese día vuelve a hacer falta. Sin esto, un asado
  -- devuelto al borrador dejaba a la familia sin almuerzo y sin aviso.
  if old.status in ('CONFIRMED', 'IN_PROGRESS') and new.status in ('PLANNED', 'DRAFT') then
    perform app.release_event_meal_coverage(new.id);
  end if;

  if new.status = 'CANCELLED' then
    v_liberadas := app.release_event_meal_coverage(new.id);

    -- Lo PENDING se retira; lo ya comprado no se toca (va al flujo de
    -- reasignación de lotes del §83).
    with cerradas as (
      update public.shopping_list_items i
      set status = 'SKIPPED',
          status_reason = 'Evento cancelado',
          updated_at = now()
      where i.event_id = new.id
        and i.status = 'PENDING'
      returning i.id
    )
    select count(*) into v_lineas from cerradas;

    -- Y la lista delta del evento ("FALTA ADQUIRIR"), si quedó abierta.
    update public.shopping_lists l
    set status = 'CANCELLED'
    where l.event_id = new.id
      and l.status in ('DRAFT', 'ACTIVE');

    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (new.household_id, auth.uid(), 'EVENT_CANCELLED', 'nutrition_event', new.id,
            jsonb_build_object('porciones_liberadas', v_liberadas,
                               'lineas_retiradas', v_lineas));
  end if;

  insert into public.domain_events
    (household_id, event_type, aggregate, payload, scope, dedupe_key)
  values (
    new.household_id,
    case new.status
      when 'IN_PROGRESS' then 'EVENT_STARTED'
      when 'COMPLETED'   then 'EVENT_COMPLETED'
      else 'EVENT_STATUS_CHANGED'
    end,
    'nutrition_event',
    jsonb_build_object('event_id', new.id, 'de', old.status, 'a', new.status),
    jsonb_build_object('event_id', new.id),
    'EVENT_STATUS:' || new.id::text || ':' || new.status::text)
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;

-- `zz_` en el nombre no es capricho: PostgreSQL dispara los triggers de la
-- misma etapa en orden alfabético, y este tiene que correr DESPUÉS de que
-- `events_flag_meals` (0008) haya marcado las comidas del día.
create trigger zz_nutrition_events_status_effects
  after update on public.nutrition_events
  for each row execute function app.event_status_effects();

/**
 * [H20 · el relevo se mueve con el evento]
 *
 * `event_status_effects` sale temprano cuando el estado no cambió, así que un
 * evento CONFIRMED que se corre de sábado a domingo —o que cambia de almuerzo
 * a cena— dejaba el día viejo relevado y el nuevo sin relevar. Los dos lados
 * duelen, y no igual: el día nuevo se compra dos veces (plata), pero el día
 * viejo NO SE COMPRA y ese sábado no se come. El segundo error es el que no se
 * deshace a las dos de la tarde.
 *
 * El history guard (sección 6) sólo congela las fechas de un evento TERMINAL,
 * o sea que mover un CONFIRMED es un camino legítimo y alcanzable desde el
 * armador (`guardarConfiguracion` escribe event_date sin mirar el estado).
 *
 * Se suelta TODO lo del evento y se vuelve a aplicar sobre las fechas nuevas:
 * recalcular es idempotente y barato, y un "mover sólo lo que cambió" tendría
 * que adivinar qué slots había antes.
 */
create or replace function app.event_plan_moved_effects()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cobertura jsonb;
  v_liberadas int;
begin
  -- El cambio de ESTADO tiene su propio trigger y ya recalcula. Acá sólo
  -- interesa el evento que se mueve sin cambiar de estado.
  if new.status is distinct from old.status then return new; end if;
  if new.status not in ('CONFIRMED', 'IN_PROGRESS') then return new; end if;

  if new.event_date is not distinct from old.event_date
     and new.end_date is not distinct from old.end_date
     and new.meal_type is not distinct from old.meal_type then
    return new;
  end if;

  v_liberadas := app.release_event_meal_coverage(new.id);
  v_cobertura := app.apply_event_meal_coverage(new.id);

  -- Queda escrito, y con el motivo: si el evento se movió a un día sin plan, o
  -- si le sacaron el meal_type, el relevo nuevo es CERO y eso NO es lo mismo
  -- que "no pasó nada". El registro dice cuál de las dos cosas ocurrió.
  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (new.household_id, auth.uid(), 'EVENT_MEAL_COVERAGE_MOVED',
          'nutrition_event', new.id,
          jsonb_build_object(
            'de', jsonb_build_object('event_date', old.event_date,
                                     'end_date', old.end_date,
                                     'meal_type', old.meal_type),
            'a',  jsonb_build_object('event_date', new.event_date,
                                     'end_date', new.end_date,
                                     'meal_type', new.meal_type),
            'porciones_liberadas', v_liberadas,
            'cobertura', v_cobertura));

  return new;
end;
$$;

-- Después de `events_flag_meals` (0008) por el mismo motivo que el de estado:
-- primero se marca la comida para revisión, después se mueve el relevo.
create trigger zz_nutrition_events_plan_moved
  after update on public.nutrition_events
  for each row execute function app.event_plan_moved_effects();

comment on function app.event_plan_moved_effects() is
  'Mueve el relevo cuando un evento CONFIRMED cambia de fecha o de comida. Sin '
  'esto el día viejo quedaba relevado sin evento (nadie compra ese almuerzo) y '
  'el día nuevo sin relevar (se compra dos veces).';

create or replace function app.event_created_effects()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.domain_events
    (household_id, event_type, aggregate, payload, scope, dedupe_key)
  values (
    new.household_id, 'EVENT_CREATED', 'nutrition_event',
    jsonb_build_object('event_id', new.id, 'event_type', new.event_type),
    jsonb_build_object('event_id', new.id),
    'EVENT_CREATED:' || new.id::text)
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

create trigger zz_nutrition_events_created
  after insert on public.nutrition_events
  for each row execute function app.event_created_effects();

/** Puerta cómoda para la app. El efecto vive en el trigger, no acá. */
create or replace function public.set_event_status(
  p_event_id uuid,
  p_status   public.event_status
) returns public.event_status language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
begin
  select household_id into v_household from public.nutrition_events where id = p_event_id;
  if v_household is null then
    raise exception 'evento inexistente' using errcode = 'no_data_found';
  end if;
  if not app.can_edit_plan(v_household) then
    raise exception 'no puedes editar el plan de este hogar: te falta el permiso para planificar'
      using errcode = 'insufficient_privilege';
  end if;

  update public.nutrition_events set status = p_status where id = p_event_id;
  return p_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. [H26] Un evento de tres días marca los tres días
-- ---------------------------------------------------------------------------
--
-- La versión de la 0008 (:258) marcaba sólo las comidas de `event_date`.
-- Cancelar o mover un viaje de tres días dejaba los días 2 y 3 confirmados,
-- sin bandera y desalineados del mundo real. Ahora se marca todo el rango, y
-- en un UPDATE los DOS rangos: el que dejó de estar cubierto y el que pasó a
-- estarlo.

create or replace function app.flag_meals_on_event_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_motivo text;
begin
  v_motivo := case tg_op
    when 'INSERT' then 'Se agregó un evento ese día'
    when 'UPDATE' then 'Cambió un evento de ese día'
    else 'Se canceló un evento de ese día'
  end;

  -- Las porciones confirmadas NO se tocan: se marca la comida para que una
  -- persona decida si vale la pena recalcular.
  update public.meal_assignments a
  set needs_review = true, review_reason = v_motivo
  from public.weekly_plan_days d
  join public.weekly_plans p on p.id = d.plan_id
  where a.day_id = d.id
    and a.status in ('CONFIRMED', 'SERVED')
    and (
      (new.household_id is not null
       and p.household_id = new.household_id
       and d.plan_date between new.event_date and coalesce(new.end_date, new.event_date))
      or
      (old.household_id is not null
       and p.household_id = old.household_id
       and d.plan_date between old.event_date and coalesce(old.end_date, old.event_date))
    );

  return coalesce(new, old);
end;
$$;

comment on function app.flag_meals_on_event_change() is
  'Marca para revisión TODO el rango del evento, no sólo su primer día, y en un '
  'UPDATE marca el rango viejo y el nuevo. Con un evento de tres días la '
  'versión anterior dejaba los días 2 y 3 desalineados sin decir nada.';

-- ---------------------------------------------------------------------------
-- 10. Menú del evento (§10, §21, §86)
-- ---------------------------------------------------------------------------

create table public.event_menu_items (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.nutrition_events (id) on delete cascade,
  kind          public.event_menu_item_kind not null,
  category      public.bbq_menu_category,
  ingredient_id uuid references public.ingredients (id) on delete set null,
  product_id    uuid references public.commercial_products (id) on delete set null,
  cut_definition_id uuid,
  display_name  text not null check (char_length(display_name) between 1 and 160),

  -- §21: porcentaje por corte. NULL en TODOS los MEAT = modo AUTO; con valores,
  -- la suma la valida el motor (no un CHECK de fila, que no ve a sus hermanas).
  distribution_pct numeric(5, 2) check (distribution_pct is null
                                        or (distribution_pct >= 0 and distribution_pct <= 100)),
  planned_quantity numeric(12, 3) check (planned_quantity is null or planned_quantity >= 0),
  planned_unit  text check (planned_unit is null or planned_unit in ('G', 'ML', 'UNIT')),
  sort_order    int not null default 1,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- §86: el carbón y los vasos se compran, pero no se comen. Un NON_FOOD con
  -- ingredient_id entraría a nutrición y a inventario comestible por la puerta
  -- de atrás.
  constraint event_menu_non_food_is_not_food
    check (kind <> 'NON_FOOD' or (ingredient_id is null and category is null))
);

create index event_menu_items_event_idx on public.event_menu_items (event_id, sort_order);

create trigger event_menu_items_touch
  before update on public.event_menu_items
  for each row execute function public.touch_updated_at();

create trigger event_menu_items_history_guard
  before insert or update or delete on public.event_menu_items
  for each row execute function app.event_children_history_guard();

-- ---------------------------------------------------------------------------
-- 10-bis. LO QUE LA CASA YA SABE QUE ALGUIEN NO PUEDE COMER
-- ---------------------------------------------------------------------------
--
-- El defecto que cierra: en el estimador, TODO integrante del hogar entraba con
-- `dietaryFlags: null`, y el motor lee null como "no hay restricción declarada"
-- ⇒ le repartía a cada uno el menú completo. O sea que la app le servía chorizo
-- al papá que tiene la alergia REGISTRADA en la misma aplicación, y encima la
-- pantalla lo contaba entre los que "comen de todo". Las banderas culinarias
-- (`guest_profiles.dietary_flags`) sólo existen para los INVITADOS; de la
-- familia la app sabe más y mejor, por ingrediente, y no lo estaba usando.
--
-- LO QUE SALE DE ACÁ ES "NO LE SIRVAS ESTE ITEM", NUNCA EL MOTIVO. La función
-- devuelve pares (participante, item del menú) y una marca de si el bloqueo
-- viene de una ALERGIA —lo único que el §23 necesita para exigir revisión
-- humana—. No devuelve el diagnóstico, ni la condición, ni el nombre del
-- ingrediente, ni la nota: nada de eso llega a la capa web y por lo tanto nada
-- de eso puede terminar dibujado en la pantalla del evento, donde hay invitados
-- mirando por encima del hombro.
--
-- POR QUÉ ES SECURITY DEFINER. Las restricciones clínicas confirmadas viven
-- detrás de `app.medical_access` (0027) y el anfitrión que arma el asado puede
-- perfectamente no tener ese permiso. Si la consulta pasara por su RLS, el
-- resultado sería "no hay restricciones" — un UNKNOWN leído como "puede comer
-- todo", que en un asado es el error que no se puede cometer. Se cruza la
-- pared, pero pasa lo mínimo: un booleano por par, sin el porqué.
--
-- DISLIKE y AVOID no bloquean: la 0005 los declara SOFT ("penalizan y
-- explican") y el optimizador tampoco los usa como pared. Bloquear un gusto
-- haría comprar de menos por algo que la persona igual se sirve.

create or replace function public.event_menu_blocks(p_event uuid)
returns table (participant_id uuid, menu_item_id uuid, from_allergy boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  v_evento public.nutrition_events;
begin
  select * into v_evento from public.nutrition_events where id = p_event;
  if v_evento.id is null then
    raise exception 'ese evento no existe' using errcode = 'no_data_found';
  end if;
  -- Ante la duda NO se abre la puerta, y tampoco se devuelve vacío: quien no
  -- puede preguntar tiene que ver un error, no una lista sin restricciones.
  if not app.is_household_member(v_evento.household_id) then
    raise exception 'este evento no es de tu hogar'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select p.id, mi.id, bool_or(bloqueo.es_alergia)
  from public.event_participants p
  join public.event_menu_items mi
    on mi.event_id = p_event
   and mi.ingredient_id is not null
  join lateral (
    -- Preferencias DURAS de la ficha familiar (0005): las mismas que el
    -- optimizador de porciones trata como pared, no como penalización.
    select true as es_alergia
      from public.member_preferences mp
     where mp.member_id = p.member_id
       and mp.target_kind = 'INGREDIENT'
       and mp.target_id = mi.ingredient_id
       and mp.preference_type = 'ALLERGY'
    union all
    select false
      from public.member_preferences mp
     where mp.member_id = p.member_id
       and mp.target_kind = 'INGREDIENT'
       and mp.target_id = mi.ingredient_id
       and mp.preference_type in ('INTOLERANCE', 'MEDICAL_RESTRICTION')
    union all
    -- Restricción clínica CONFIRMADA y vigente el día del evento. Las
    -- UNVERIFIED no bloquean (0027: no autorizan a inventar límites), y el
    -- target se castea sólo si de verdad es un uuid: en esa columna caben
    -- claves de nutriente y texto libre.
    select false
      from public.member_clinical_restrictions r
     where r.member_id = p.member_id
       and r.type = 'INGREDIENT_EXCLUDE'
       and r.verification_status = 'CONFIRMED'
       and r.valid_from <= v_evento.event_date
       and (r.valid_until is null or r.valid_until >= v_evento.event_date)
       and r.target ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and r.target::uuid = mi.ingredient_id
  ) bloqueo on true
  where p.event_id = p_event
    and p.participant_type = 'HOUSEHOLD_MEMBER'
    and p.member_id is not null
  group by p.id, mi.id;
end;
$$;

comment on function public.event_menu_blocks(uuid) is
  'Qué item del menú NO puede comer cada integrante del hogar, según la ficha '
  'familiar y las restricciones clínicas confirmadas. Devuelve el QUÉ y si '
  'viene de una alergia; jamás el motivo clínico. El motor lo usa para repartir '
  'la carne; la pantalla del evento sólo muestra conteos.';

-- ---------------------------------------------------------------------------
-- 11. Cortes: la metadata culinaria que la 0009 NO cubre (§11, §12, §13)
-- ---------------------------------------------------------------------------
--
-- Ver el desvío (a) de la cabecera: acá NO hay factor de cocción. Ese factor
-- tiene dueño desde la 0009 (`ingredient_yields`, etapa EDIBLE_RAW → COOKED) y
-- un segundo dueño no aclara nada, sólo permite descontar la merma dos veces.

create table public.cut_definitions (
  id            uuid primary key default gen_random_uuid(),
  ingredient_id uuid references public.ingredients (id) on delete cascade,
  product_id    uuid references public.commercial_products (id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 160),
  category      public.bbq_menu_category,

  -- NULL = UNKNOWN. No hay default `false`: "no sé si tiene hueso" y "no tiene
  -- hueso" son cosas distintas y la segunda hace comprar menos.
  bone_in       boolean,

  -- RAW_PURCHASE → EDIBLE_RAW: hueso y grasa que se descartan. Fracción de lo
  -- que SE PIERDE, 0 a 1. NULL = sin factor validado (§13: mostrar
  -- incertidumbre, jamás asumir 1:1).
  trim_loss_fraction numeric(5, 4)
    check (trim_loss_fraction is null or (trim_loss_fraction >= 0 and trim_loss_fraction < 1)),

  -- COOKED → SERVABLE: lo que llega al plato de lo que salió de la parrilla.
  servable_fraction numeric(5, 4)
    check (servable_fraction is null or (servable_fraction > 0 and servable_fraction <= 1)),

  -- OBLIGATORIA. Un factor sin fuente es un número inventado con más pasos.
  source        text not null check (char_length(source) between 3 and 300),
  source_url    text,
  confidence    text not null default 'LOW' check (confidence in ('HIGH', 'MEDIUM', 'LOW')),
  notes         text,
  created_at    timestamptz not null default now(),

  constraint cut_definition_identity_xor
    check ((ingredient_id is not null) <> (product_id is not null))
);

create unique index cut_definitions_ingredient_uniq
  on public.cut_definitions (ingredient_id) where ingredient_id is not null;
create unique index cut_definitions_product_uniq
  on public.cut_definitions (product_id) where product_id is not null;

comment on table public.cut_definitions is
  'Metadata culinaria del corte, curada (sin escritura de usuario, igual que '
  'ingredient_yields). NO guarda rendimiento de cocción: ese dato tiene dueño '
  'desde la 0009 y dos dueños del mismo factor descuentan la merma dos veces. '
  'Nace VACÍA a propósito: sin fuente citable no hay fila, y un factor '
  'plausible es exactamente la falsa precisión que el §13 prohíbe.';

alter table public.event_menu_items
  add constraint event_menu_items_cut_fk
  foreign key (cut_definition_id) references public.cut_definitions (id) on delete set null;

-- Las observaciones del hogar también declaran etapa (§14 + lente de física).
-- NULL en las filas viejas = no se sabe qué etapa midieron, que es la verdad:
-- la 0015 nunca lo preguntó. Una observación sin etapa NO puede mezclarse con
-- una referencia por etapa; sigue siendo historia, no señal.
alter table public.household_observed_yields
  add column basis_in  public.yield_stage,
  add column basis_out public.yield_stage;

comment on column public.household_observed_yields.basis_in is
  'Etapa del peso de ENTRADA (§12). NULL = desconocida: la fila queda fuera del '
  'estimador. "5.000 g crudo → 3.550 g cocido" mezcla hueso, desgrase y '
  'cocción en un solo número si el crudo era peso de compra.';

-- ---------------------------------------------------------------------------
-- 12. Revisiones congeladas del plan del evento (§93, §94, §95)
-- ---------------------------------------------------------------------------

create table public.event_plan_revisions (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.nutrition_events (id) on delete cascade,
  revision_number int not null check (revision_number > 0),

  -- Misma firma = misma revisión (§93). El índice único es la idempotencia:
  -- dos planners apretando "calcular" a la vez producen UNA revisión.
  input_signature text not null,
  engine_version  text not null,
  policy_version  text not null,

  -- Todo congelado: cambiar la policy mañana no altera lo que este evento
  -- estimó ayer (§95). Van en cinco columnas y no en un solo blob porque cada
  -- una tiene un dueño distinto río arriba, y cuando algo no cuadra hay que
  -- poder mirar UNA de ellas.
  plan_context          jsonb not null,
  participants_snapshot jsonb not null,
  menu                  jsonb not null,
  policy                jsonb not null,
  yield_inputs          jsonb not null,
  estimate_output       jsonb not null,

  -- §79/§80: "recomendado 8,4 kg / tu plan 9,4 kg" con su nota. El override no
  -- pisa la estimación: convive con ella, y por eso son dos columnas y no una.
  override_grams numeric(12, 3) check (override_grams is null or override_grams >= 0),
  override_note  text,

  created_by      uuid references public.household_members (id) on delete set null,
  created_at      timestamptz not null default now(),

  constraint event_revisions_numbered unique (event_id, revision_number),
  constraint event_revisions_signature_uniq unique (event_id, input_signature)
);

create index event_plan_revisions_event_idx
  on public.event_plan_revisions (event_id, revision_number desc);

alter table public.nutrition_events
  add constraint nutrition_events_locked_revision_fk
  foreign key (locked_revision_id) references public.event_plan_revisions (id) on delete set null;

/** Una revisión congelada que se puede editar no está congelada. */
create or replace function app.append_only_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'esta tabla es historia: se agregan filas, no se corrigen las que ya están'
    using errcode = 'check_violation';
end;
$$;

create trigger event_plan_revisions_append_only
  before update or delete on public.event_plan_revisions
  for each row execute function app.append_only_guard();

/**
 * Guardar una estimación (§93: idempotente por firma).
 *
 * La idempotencia NO se puede resolver leyendo antes de escribir: dos planners
 * apretando "calcular" al mismo tiempo leen los dos "no existe" y escriben los
 * dos. El único árbitro posible es el índice único `(event_id,
 * input_signature)`, y por eso el `on conflict` de acá abajo es el mecanismo y
 * no una red de seguridad.
 *
 * Misma entrada = misma revisión, y se devuelve la que YA estaba. Entrada
 * distinta = revisión nueva; la vieja no se toca (§95).
 */
create or replace function public.save_event_estimate_revision(
  p_event_id              uuid,
  p_input_signature       text,
  p_engine_version        text,
  p_policy_version        text,
  p_plan_context          jsonb,
  p_participants_snapshot jsonb,
  p_menu                  jsonb,
  p_policy                jsonb,
  p_yield_inputs          jsonb,
  p_estimate_output       jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_evento public.nutrition_events;
  v_id uuid;
  v_intento int := 0;
begin
  select * into v_evento from public.nutrition_events where id = p_event_id;
  if v_evento.id is null then
    raise exception 'evento inexistente' using errcode = 'no_data_found';
  end if;
  v_household := v_evento.household_id;

  if not app.can_edit_plan(v_household) then
    raise exception 'no puedes editar el plan de este hogar: te falta el permiso para planificar'
      using errcode = 'insufficient_privilege';
  end if;

  -- Un evento cerrado no vuelve a estimarse: eso reescribiría lo que se decidió.
  -- El "con el modelo de hoy habría sido X" del §95 es una lectura, no una fila.
  if v_evento.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'este evento ya está cerrado: su estimación es historia'
      using errcode = 'check_violation';
  end if;

  loop
    v_intento := v_intento + 1;

    select id into v_id from public.event_plan_revisions
    where event_id = p_event_id and input_signature = p_input_signature;
    if v_id is not null then
      return v_id;
    end if;

    begin
      insert into public.event_plan_revisions (
        event_id, revision_number, input_signature, engine_version, policy_version,
        plan_context, participants_snapshot, menu, policy, yield_inputs, estimate_output,
        created_by)
      select
        p_event_id,
        coalesce(max(revision_number), 0) + 1,
        p_input_signature, p_engine_version, p_policy_version,
        p_plan_context, p_participants_snapshot, p_menu, p_policy, p_yield_inputs,
        p_estimate_output,
        app.current_member_id(v_household)
      from public.event_plan_revisions
      where event_id = p_event_id
      returning id into v_id;
      exit;
    exception when unique_violation then
      -- Otro planner ganó la carrera. Si fue con la MISMA firma, la vuelta de
      -- arriba devuelve su revisión; si fue con otra, se recalcula el número.
      if v_intento >= 5 then raise; end if;
    end;
  end loop;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_household, auth.uid(), 'BBQ_ESTIMATE_GENERATED', 'nutrition_event', p_event_id,
          jsonb_build_object('revision_id', v_id, 'engine', p_engine_version));

  insert into public.domain_events
    (household_id, event_type, aggregate, payload, scope, dedupe_key)
  values (
    v_household, 'BBQ_ESTIMATE_GENERATED', 'nutrition_event',
    jsonb_build_object('event_id', p_event_id, 'revision_id', v_id),
    jsonb_build_object('event_id', p_event_id),
    'BBQ_ESTIMATE_GENERATED:' || p_event_id::text || ':' || p_input_signature)
  on conflict (dedupe_key) do nothing;

  return v_id;
end;
$$;

/**
 * Marcar quién llegó y quién no (§42).
 *
 * Pide `can_cook` O `can_edit_plan` a propósito: el día del asado la lista la
 * pasa quien está en la parrilla, que puede no tener permiso para planificar.
 * Y NO toca la compra: lo que se compró se compró (§42, demo H); la diferencia
 * la muestra el resumen.
 */
create or replace function public.record_event_attendance(
  p_participant_id    uuid,
  p_attendance_status public.event_attendance_status
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_household uuid;
  v_event uuid;
begin
  select e.household_id, e.id into v_household, v_event
  from public.event_participants p
  join public.nutrition_events e on e.id = p.event_id
  where p.id = p_participant_id;

  if v_household is null then
    raise exception 'participante inexistente' using errcode = 'no_data_found';
  end if;
  if not (app.can_cook(v_household) or app.can_edit_plan(v_household)) then
    raise exception 'no puedes marcar asistencia en este hogar: te falta el permiso'
      using errcode = 'insufficient_privilege';
  end if;

  update public.event_participants
  set attendance_status = p_attendance_status
  where id = p_participant_id;

  insert into public.domain_events
    (household_id, event_type, aggregate, payload, scope, dedupe_key)
  values (
    v_household, 'EVENT_ACTUAL_RECORDED', 'nutrition_event',
    jsonb_build_object('event_id', v_event, 'participant_id', p_participant_id,
                       'attendance', p_attendance_status),
    jsonb_build_object('event_id', v_event),
    'EVENT_ACTUAL_RECORDED:' || p_participant_id::text || ':' || p_attendance_status::text)
  on conflict (dedupe_key) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Lo que se sirvió de verdad y lo que quedó (§44, §45, §47, §48)
-- ---------------------------------------------------------------------------
--
-- El plato compartido es el caso NORMAL de un asado: nadie sabe quién se comió
-- cada corte (§48). Por eso esto es del HOGAR y no de una persona —
-- `meal_serving_records` (0036) exige `member_id not null` y meterle un
-- miembro inventado sería fabricar una distribución individual que nadie
-- observó.
--
-- El descuento físico sigue siendo del libro mayor: estas tablas guardan el
-- HECHO del servido, y el movimiento de inventario cuelga de su renglón.

create table public.event_serving_records (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.nutrition_events (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  -- DATE-only en la zona del HOGAR (`app.household_today`), jamás la del servidor.
  served_on    date not null,
  served_at    timestamptz not null default now(),
  served_by    uuid references public.household_members (id) on delete set null,
  batch_number int check (batch_number is null or batch_number > 0),
  status       text not null default 'ACTIVE' check (status in ('ACTIVE', 'VOIDED')),
  void_reason  text,
  voided_at    timestamptz,
  notes        text,
  created_at   timestamptz not null default now(),
  constraint event_serving_void_has_reason
    check ((status = 'VOIDED') = (void_reason is not null))
);

create index event_serving_records_event_idx on public.event_serving_records (event_id, served_on);

create table public.event_serving_items (
  id                 uuid primary key default gen_random_uuid(),
  record_id          uuid not null references public.event_serving_records (id) on delete cascade,
  menu_item_id       uuid references public.event_menu_items (id) on delete set null,
  ingredient_id      uuid references public.ingredients (id) on delete set null,
  product_id         uuid references public.commercial_products (id) on delete set null,
  label              text not null check (char_length(label) between 1 and 200),
  served_quantity    numeric(12, 3) not null check (served_quantity >= 0),
  served_unit        text not null check (served_unit in ('G', 'ML', 'UNIT')),
  served_weight_basis public.weight_basis not null default 'COOKED',

  -- Espejos de lo que el libro mayor terminó escribiendo, como en la 0036: no
  -- son la fuente, son el saldo cacheado para poder leerlo sin recorrer todo.
  deducted_quantity  numeric(12, 3) not null default 0 check (deducted_quantity >= 0),
  discarded_quantity numeric(12, 3) not null default 0 check (discarded_quantity >= 0),

  -- ANULAR UN RENGLÓN: el mismo derecho que la porción personal tiene desde la
  -- 0036 (`void_serving_record`). Sin esto, "18000" tecleado en vez de "1800"
  -- queda escrito para siempre Y además habilita devolver "sobras" hasta ese
  -- número inflado, porque el tope de conservación (E8) mide contra lo SERVIDO.
  -- El renglón anulado no se borra: se marca, y quien lee lo VIVO lo filtra.
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'VOIDED')),
  void_reason        text,
  voided_at          timestamptz,
  created_at         timestamptz not null default now(),

  constraint event_serving_item_void_has_reason
    check ((status = 'VOIDED') = (void_reason is not null))
);

create index event_serving_items_record_idx on public.event_serving_items (record_id);

-- El libro mayor gana su segundo dueño posible de renglón, y la tabla declara
-- que son EXCLUYENTES: un movimiento cuelga de una porción personal o de un
-- renglón de evento, nunca de los dos.
alter table public.inventory_movements
  add column event_serving_item_id uuid
    references public.event_serving_items (id) on delete set null;

alter table public.inventory_movements
  add constraint movements_one_owner_only
  check (serving_record_item_id is null or event_serving_item_id is null);

create index movements_event_serving_item_idx
  on public.inventory_movements (event_serving_item_id)
  where event_serving_item_id is not null;

comment on column public.inventory_movements.event_serving_item_id is
  'Renglón de servido de un evento del que cuelga este movimiento. NO abre una '
  'segunda vía al inventario: el libro mayor sigue siendo la única fuente '
  'física y app.movement_owner_guard sigue mandando sobre las reglas de cada '
  'movimiento.';

-- §45 + §55: el balance de masa por corte. TODO nullable porque UNKNOWN no se
-- rellena — que nadie haya pesado la merma no significa que la merma fue cero.
create table public.event_consumption_estimates (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.nutrition_events (id) on delete cascade,
  menu_item_id  uuid references public.event_menu_items (id) on delete set null,
  ingredient_id uuid references public.ingredients (id) on delete set null,
  product_id    uuid references public.commercial_products (id) on delete set null,
  label         text not null check (char_length(label) between 1 and 200),
  unit          text not null default 'G' check (unit in ('G', 'ML', 'UNIT')),

  raw_input_quantity  numeric(12, 3) check (raw_input_quantity is null or raw_input_quantity >= 0),
  served_quantity     numeric(12, 3) check (served_quantity is null or served_quantity >= 0),

  -- Una estimación es un RANGO con supuestos escritos (§27), jamás un número
  -- seco: nadie midió cuánto se comió cada uno de los quince.
  consumed_min_quantity numeric(12, 3) check (consumed_min_quantity is null or consumed_min_quantity >= 0),
  consumed_max_quantity numeric(12, 3) check (consumed_max_quantity is null or consumed_max_quantity >= 0),

  -- §55: los cinco destinos, separados. El hueso NO es sobra comestible (§54).
  edible_leftover_quantity numeric(12, 3) check (edible_leftover_quantity is null or edible_leftover_quantity >= 0),
  plate_waste_quantity     numeric(12, 3) check (plate_waste_quantity is null or plate_waste_quantity >= 0),
  trim_waste_quantity      numeric(12, 3) check (trim_waste_quantity is null or trim_waste_quantity >= 0),
  bone_discard_quantity    numeric(12, 3) check (bone_discard_quantity is null or bone_discard_quantity >= 0),
  spoiled_quantity         numeric(12, 3) check (spoiled_quantity is null or spoiled_quantity >= 0),

  confidence    text not null default 'LOW' check (confidence in ('HIGH', 'MEDIUM', 'LOW')),
  reasons       jsonb not null default '[]'::jsonb,
  created_by    uuid references public.household_members (id) on delete set null,
  created_at    timestamptz not null default now(),

  constraint event_consumption_range_ordered
    check (consumed_min_quantity is null or consumed_max_quantity is null
           or consumed_max_quantity >= consumed_min_quantity)
);

create index event_consumption_estimates_event_idx on public.event_consumption_estimates (event_id);

-- Linaje del §96: qué registro de servido personal ocurrió dentro de qué evento.
--
-- LA RESERVA DE LOTES PARA UN EVENTO NO EXISTE, Y SE DECLARA ACÁ.
--
-- Este archivo tenía una columna `inventory_lots.intended_event_id` ("aparté
-- estos 2 kg para el asado del sábado") y una lectura que la respetaba. Lo que
-- no tenía era UN SOLO ESCRITOR: ninguna pantalla, ningún RPC y ninguna compra
-- la escribía nunca. Con eso, la columna no apartaba nada — pero el código que
-- la leía afirmaba cumplir el §29 "en las dos direcciones", y esa afirmación
-- valía cero.
--
-- Y cerrar la mitad barata habría sido peor: aunque un escritor marcara el lote,
-- la otra dirección —que esos kilos dejen de contarse como disponibles para la
-- cena del martes— la decide `futureDemand` (web/src/app/stock/queries.ts), que
-- arma la demanda desde `member_serving_projections` y no mira los lotes. Media
-- reserva escrita es una reserva que la persona cree tener.
--
-- Entonces se saca la columna y queda dicho lo que hoy es verdad: DOS EVENTOS
-- DEL MISMO FIN DE SEMANA NETEAN LOS MISMOS KILOS, y la carne comprada para el
-- asado se puede consumir el jueves. Es un hueco conocido y con nombre, que es
-- distinto de un hueco tapado con una columna que no hace nada.

alter table public.meal_serving_records
  add column event_id uuid references public.nutrition_events (id) on delete set null;
create index meal_serving_records_event_idx
  on public.meal_serving_records (event_id) where event_id is not null;

-- ---------------------------------------------------------------------------
-- 14. Compras del evento (§31, §32) y la lista delta (§82)
-- ---------------------------------------------------------------------------
--
-- No hay lista paralela: se usan `shopping_lists` y `shopping_list_items`. Lo
-- único nuevo es de quién viene cada línea, para poder retirarla si el evento
-- se cancela (sección 8) y para que la lista delta "FALTA ADQUIRIR" pueda
-- existir junto a la semanal sin pelearse por el índice único.

alter table public.shopping_lists
  add column event_id uuid references public.nutrition_events (id) on delete cascade;

alter table public.shopping_lists drop constraint shopping_lists_one_per_plan;
create unique index shopping_lists_one_per_plan
  on public.shopping_lists (plan_id) where event_id is null;
create unique index shopping_lists_one_per_event
  on public.shopping_lists (event_id) where event_id is not null;

alter table public.shopping_list_items
  add column event_id uuid references public.nutrition_events (id) on delete cascade;
create index shopping_items_event_idx
  on public.shopping_list_items (event_id) where event_id is not null;

comment on column public.shopping_list_items.event_id is
  'El evento que pidió esta línea. Se guarda en columna y no sólo dentro de '
  'provenance porque cancelar el evento tiene que poder RETIRARLA, y buscar '
  'dentro de un jsonb para decidir eso es frágil.';

-- ---------------------------------------------------------------------------
-- 15. Plantillas y ajustes aprendidos (§69, §70, §51)
-- ---------------------------------------------------------------------------

create table public.event_templates (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 120),
  event_type   public.nutrition_event_type not null,
  -- Menú, acompañamientos, buffer y equipamiento. NO lleva asistencia real, ni
  -- compras, ni movimientos: duplicar un asado copia la INTENCIÓN, jamás los
  -- hechos del anterior (§69).
  payload      jsonb not null,
  created_by   uuid references public.household_members (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint event_templates_name_uniq unique (household_id, name)
);

create trigger event_templates_touch
  before update on public.event_templates
  for each row execute function public.touch_updated_at();

-- Molde de `storage_safety_rules`: un ajuste aprendido tiene fuente y vigencia.
-- El §51 manda: no aprender demasiado de un evento.
create table public.household_bbq_policy_overrides (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  policy_key    text not null check (char_length(policy_key) between 1 and 80),
  value         jsonb not null,
  source        text not null check (char_length(source) between 3 and 300),
  -- Sobre cuántos eventos CON DATOS se apoya. Sin esto, "aprendido" no se
  -- distingue de "alguien lo escribió una vez".
  sample_events int not null check (sample_events >= 0),
  effective_from date not null,
  effective_to   date,
  confirmed_by  uuid references public.household_members (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint bbq_override_range_ordered
    check (effective_to is null or effective_to >= effective_from)
);

create unique index bbq_policy_overrides_vigente_uniq
  on public.household_bbq_policy_overrides (household_id, policy_key)
  where effective_to is null;

-- ---------------------------------------------------------------------------
-- 16. RLS: patrón de la 0039 en todas las tablas nuevas
-- ---------------------------------------------------------------------------
--
--   SELECT     → app.is_household_member  (ver el evento es parte de estar en casa)
--   ESCRITURAS → app.can_edit_plan        (armarlo, no)
--
-- El permiso va en el `with check` y el `using` queda en "es de tu hogar": así
-- el rechazo llega como excepción y no como silencio (0039:330). El DELETE no
-- tiene `with check`, así que su guarda es un trigger.

create or replace function app.event_household(p_event uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.nutrition_events where id = p_event
$$;

create or replace function app.exigir_can_edit_evento()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_fila jsonb := to_jsonb(old);
  v_hogar uuid;
begin
  -- Se lee por jsonb y no con `old.household_id` por lo mismo que documenta
  -- app.exigir_can_edit_plan (0039:352): plpgsql prepara la expresión entera,
  -- así que nombrar un campo que esta tabla no tiene revienta aunque la rama
  -- no se tome. En jsonb, el campo ausente es null y no duele.
  v_hogar := coalesce(
    (v_fila->>'household_id')::uuid,
    app.event_household((v_fila->>'event_id')::uuid));

  if v_hogar is null then
    raise exception 'no se pudo determinar el hogar de esta fila: no se borra a ciegas'
      using errcode = 'check_violation';
  end if;

  if not app.can_edit_plan(v_hogar) then
    raise exception 'no puedes editar el plan de este hogar: te falta el permiso para planificar'
      using errcode = 'insufficient_privilege';
  end if;

  return old;
end;
$$;

do $$
declare
  t text;
  -- Tablas colgadas del hogar directo o del evento. Todas comparten el molde.
  tablas text[] := array[
    'guest_profiles', 'event_participants', 'event_menu_items',
    'event_plan_revisions', 'event_serving_records', 'event_consumption_estimates',
    'event_templates', 'household_bbq_policy_overrides'];
  ancla text;
begin
  foreach t in array tablas loop
    ancla := case
      when t in ('guest_profiles', 'event_serving_records', 'event_templates',
                 'household_bbq_policy_overrides')
        then 'household_id'
      else 'app.event_household(event_id)'
    end;

    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.is_household_member(%s))',
      t || '_select', t, ancla);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (app.can_edit_plan(%s))',
      t || '_insert', t, ancla);
    execute format(
      'create policy %I on public.%I for update to authenticated using (app.is_household_member(%s)) with check (app.can_edit_plan(%s))',
      t || '_update', t, ancla, ancla);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (app.is_household_member(%s))',
      t || '_delete', t, ancla);
    execute format(
      'create trigger %I before delete on public.%I for each row execute function app.exigir_can_edit_evento()',
      t || '_delete_guard', t);
  end loop;
end $$;

-- Los renglones de servido cuelgan del registro, no del evento.
alter table public.event_serving_items enable row level security;
create policy event_serving_items_select on public.event_serving_items
  for select to authenticated
  using (exists (select 1 from public.event_serving_records r
                 where r.id = record_id and app.is_household_member(r.household_id)));
create policy event_serving_items_insert on public.event_serving_items
  for insert to authenticated
  with check (exists (select 1 from public.event_serving_records r
                      where r.id = record_id and app.can_edit_plan(r.household_id)));
-- Sin update ni delete: un renglón servido es historia física.

-- El catálogo curado se lee y no se escribe, igual que `ingredient_yields`
-- (0009:88). Que no haya política de escritura ES la política.
alter table public.cut_definitions enable row level security;
create policy cut_definitions_select on public.cut_definitions
  for select to authenticated using (true);

-- Registros de servido: append-only también en la forma.
create trigger event_serving_items_append_only
  before update or delete on public.event_serving_items
  for each row execute function app.append_only_guard();

/** Un invitado que ya estuvo en un asado no se borra: se archiva. */
create or replace function app.guest_profile_delete_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.event_participants where guest_id = old.id) then
    raise exception
      'este invitado ya participó en un evento: archívalo en vez de borrarlo, o su historia se va con él'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create trigger guest_profiles_archive_guard
  before delete on public.guest_profiles
  for each row execute function app.guest_profile_delete_guard();

-- ---------------------------------------------------------------------------
-- 17. Índices de trabajo
-- ---------------------------------------------------------------------------

create index nutrition_events_status_idx
  on public.nutrition_events (household_id, status, event_date);

-- ===========================================================================
-- 18. EL DÍA DEL EVENTO Y LO QUE QUEDA DESPUÉS (etapas 6 y 7)
-- ===========================================================================
--
-- Hasta acá la 0041 construyó el PLAN. Estas secciones construyen los HECHOS:
-- lo que salió de la despensa a la mesa, quién llegó de verdad, qué volvió al
-- refrigerador y cuánto se estima que se comió.
--
-- EL PROBLEMA QUE HACE DISTINTO A UN EVENTO. Comieron once personas y cinco no
-- son de la casa. El eje del Sprint 12 —`consumption_logs` + `intake_log_items`—
-- es POR `member_id`: cada fila es "esta persona del hogar declaró que comió
-- esto". El consumo de un invitado NO es intake de ningún integrante y no se le
-- puede atribuir a uno; inventarle una ficha de persona para que calce con el
-- esquema sería fabricar un miembro que no existe.
--
-- La salida son TRES ejes que no se pisan:
--
--   1. HOGAR / FÍSICO — `event_serving_records` + `event_serving_items`, con su
--      descuento en el libro mayor. "Salieron 4,2 kg de vacuno a la mesa" es un
--      hecho del hogar, no de una persona (§48).
--   2. HOGAR / ESTIMADO — `event_consumption_estimates`: el balance de masa por
--      corte, agregado, con rango y supuestos. Nadie pesó el plato de nadie.
--   3. PERSONA / DECLARADO — dos caminos distintos según de quién se hable:
--      · integrante del hogar que quiere seguimiento completo: el eje del
--        Sprint 12 tal cual, `log_intake_off_plan` con extent y
--        `quantity_is_declared = false`. Es DECLARACIÓN, `affects_inventory`
--        falso, sin efecto físico: el descuento ya ocurrió UNA vez a nivel
--        evento y no se cobra dos veces (§46/§49).
--      · invitado: `event_participant_observations`, una observación ORDINAL
--        que el anfitrión escribe a mano. Nunca gramos repartidos, nunca una
--        ficha clínica, nunca una fila en `consumption_logs`.
--
-- Y la regla que ordena las tres: si no hay hecho, no hay aprendizaje. La
-- tendencia por invitado del §52 sale SOLO del eje 3; el total servido dividido
-- por la cantidad de asistentes está prohibido y no existe la columna que lo
-- guardaría.

-- ---------------------------------------------------------------------------
-- 18.1 Vocabulario nuevo
-- ---------------------------------------------------------------------------

-- POR QUÉ ESTE `alter type` NO ESTÁ ARRIBA CON LOS OTROS: la regla de la
-- cabecera es que la etiqueta nueva no se puede USAR en este archivo, no que la
-- sentencia tenga que ir primero. `LEFTOVER_RETURN` aparece sólo dentro de
-- cuerpos plpgsql, que PostgreSQL resuelve al EJECUTARLOS —después de que esta
-- migración cerró—, jamás en un CHECK ni en un default. Ponerla acá la deja al
-- lado de lo único que la usa.
--
-- Y POR QUÉ UNA RAZÓN PROPIA. La sobra del asado entra al refrigerador como un
-- lote COOKED nuevo. Escribir esa entrada como PURCHASE —que es lo que hace
-- `add_manual_lot` (0015:1313)— diría que la familia compró 800 g de carne
-- cocida el sábado a las cinco de la tarde: ensucia el gasto, ensucia el
-- historial de precios y hace irreconocible la sobra cuando el aprendizaje la
-- busca. TRANSFORM tampoco sirve: un TRANSFORM tiene dos patas y la carne que
-- volvió ya había salido del libro mayor al servirse.
alter type public.movement_reason add value if not exists 'LEFTOVER_RETURN';

-- La escala del §52, ORDINAL a propósito. El anfitrión estaba asando, no
-- pesando platos: "comió harto" es lo que efectivamente puede observar. Un
-- número de gramos acá sería la falsa precisión de siempre, y peor, una
-- atribución individual inventada.
create type public.guest_intake_extent as enum ('ATE_LITTLE', 'ATE_NORMAL', 'ATE_A_LOT');

comment on type public.guest_intake_extent is
  'Observación ORDINAL de cuánto comió un comensal, declarada a mano por quien '
  'organizó. No sale de dividir lo servido entre los asistentes (§48 lo '
  'prohíbe) y no es un dato clínico.';

-- ---------------------------------------------------------------------------
-- 18.2 Idempotencia de los hechos del día (§92)
-- ---------------------------------------------------------------------------
--
-- El día del asado se aprieta el botón dos veces: hay humo, hay ruido y la
-- pantalla tarda. Sin clave, "servir 1,2 kg" dos veces saca 2,4 kg de la
-- despensa y el resumen dice que se sirvió el doble. El árbitro es el índice
-- único, no un "leer antes de escribir" que dos cocineros simultáneos pasan los
-- dos (mismo argumento que `save_event_estimate_revision`, sección 12).
--
-- Y LA CLAVE SE COMPONE ACÁ, CON EL ANCLA DEL ACTO, igual que en el Sprint 12
-- (`app.intake_dedupe_key`, 0038:662). La primera versión de este archivo caía
-- a un HASH DEL CONTENIDO cuando el cliente no mandaba clave, y eso no es
-- idempotencia sino otra regla: "mismo corte + misma cantidad + mismo día = el
-- mismo servido". El sábado del asado esa regla se traga hechos REALES —la
-- segunda fuente de 800 g que sale a la mesa no descuenta nada, el segundo
-- táper de 800 g nunca entra al inventario— y le dice a la persona que los
-- guardó. Dos fuentes iguales son DOS actos; que se parezcan no las hace una.
--
-- Entonces: sin discriminador del cliente NO HAY CLAVE (`dedupe_key` queda en
-- NULL y el índice parcial lo deja pasar), y cada llamada es un acto nuevo. La
-- defensa contra el doble clic es que la pantalla mande su clave de intento —y
-- la manda: `PanelDeServicio` genera una por intento y la suelta recién cuando
-- el servidor confirmó. Un cliente que no la mande pierde la idempotencia, no
-- la realidad.

alter table public.event_serving_items add column dedupe_key text;

-- Sólo entre lo VIVO: un renglón anulado con esa clave NO es un reintento, es
-- alguien que anuló y vuelve a servir. Mismo criterio que
-- `intake_logs_serving_record_active_uniq` (0038).
create unique index event_serving_items_dedupe_uniq
  on public.event_serving_items (dedupe_key)
  where dedupe_key is not null and status = 'ACTIVE';

-- Un registro por evento, día y tanda: las tandas son el agrupador natural del
-- asado (§39), y sin esto cada renglón se llevaría su propio encabezado.
create unique index event_serving_records_tanda_uniq
  on public.event_serving_records (event_id, served_on, coalesce(batch_number, 0))
  where status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- 18.3 La puerta de los hechos del día: quién puede y hasta cuándo
-- ---------------------------------------------------------------------------
--
-- Dos preguntas distintas, un solo lugar donde se contestan:
--
--   ¿QUIÉN puede? El día del asado la lista la pasa y la carne la sirve quien
--   está en la parrilla, que puede tener `can_cook` y no `can_edit_plan`
--   (0039). Gatear esto con permiso de planificación dejaría el modo del día
--   inservible justo para su usuario principal. Editar el PLAN —menú,
--   distribución, estimación— sigue pidiendo `can_edit_plan`; anotar la
--   REALIDAD pide cocinar o planificar.
--
--   ¿CUÁNDO? Mientras el evento está en curso, y hasta que se cierre la ventana
--   de corrección (`app.event_correction_window_hours`, sección 6). Después, el
--   asado es historia: agregarle un servido tres semanas más tarde cambiaría
--   hacia atrás lo que el aprendizaje ya leyó.

create or replace function app.event_actual_gate(p_event_id uuid)
returns public.nutrition_events language plpgsql security definer set search_path = public as $$
declare
  v_evento public.nutrition_events;
  v_cierre timestamptz;
begin
  select * into v_evento from public.nutrition_events where id = p_event_id;
  if v_evento.id is null then
    raise exception 'evento inexistente' using errcode = 'no_data_found';
  end if;

  if not (app.can_cook(v_evento.household_id) or app.can_edit_plan(v_evento.household_id)) then
    raise exception
      'no puedes anotar lo que pasa en este evento: te falta el permiso para cocinar o para planificar'
      using errcode = 'insufficient_privilege';
  end if;

  if v_evento.status = 'CANCELLED' then
    raise exception 'este evento está cancelado: no se le anota comida servida'
      using errcode = 'check_violation';
  end if;

  if v_evento.status in ('DRAFT', 'PLANNED') then
    raise exception
      'este evento todavía no está confirmado: confírmalo antes de servir, o lo que salga de la despensa no va a tener a qué colgarse'
      using errcode = 'check_violation';
  end if;

  if v_evento.status = 'COMPLETED' then
    v_cierre := coalesce(v_evento.completed_at, v_evento.created_at);
    if now() > v_cierre + make_interval(hours => app.event_correction_window_hours()) then
      raise exception
        'pasaron más de % horas desde que se cerró este evento: lo que se anote ahora no es corregir, es reescribir',
        app.event_correction_window_hours() using errcode = 'check_violation';
    end if;
  end if;

  -- Servir la primera fuente ES empezar el asado. Se anota solo, porque la
  -- alternativa es rebotarle el botón a alguien que tiene las manos ocupadas
  -- por no haber tocado antes un botón de estado. `CONFIRMED -> IN_PROGRESS`
  -- es transición legal (sección 8) y su efecto —relevar la comida del día— ya
  -- había ocurrido al confirmar: no hay sorpresa escondida acá.
  if v_evento.status = 'CONFIRMED' then
    update public.nutrition_events set status = 'IN_PROGRESS' where id = p_event_id;
    select * into v_evento from public.nutrition_events where id = p_event_id;
  end if;

  return v_evento;
end;
$$;

comment on function app.event_actual_gate(uuid) is
  'Quién y cuándo puede anotar los HECHOS de un evento: cocinar o planificar, '
  'con el evento en curso o dentro de la ventana de corrección. Cierra el '
  'hallazgo de permisos del día del evento: quien sólo cocina quedaba fuera de '
  'su propia pantalla.';

-- ---------------------------------------------------------------------------
-- 18.4 EL CANDADO ESTRUCTURAL GANA UN SEGUNDO DUEÑO DE RENGLÓN
-- ---------------------------------------------------------------------------
--
-- `app.movement_owner_guard` (0036:688) es la pared que hace cierto el "no hay
-- descuento sin renglón de servido". Está escrita para UN dueño posible:
-- `serving_record_item_id`, la porción de UNA persona. Un asado no tiene eso:
-- el plato es compartido y el renglón es del hogar (§48).
--
-- Se reemplaza la función entera —no se agrega un segundo trigger— porque su
-- regla (1) rechaza cualquier CONSUMED sin porción personal detrás, y un
-- trigger nuevo no puede deshacer el veto de otro. La rama personal se
-- conserva EXACTAMENTE como estaba; los argumentos largos que la explican
-- viven en 0036 y no se copian, para que no queden dos versiones del mismo
-- razonamiento que puedan divergir.
--
-- LO QUE CAMBIA:
--
--   · El renglón puede ser de los dos tipos. El CHECK `movements_one_owner_only`
--     (sección 13) ya garantiza que nunca son los dos a la vez.
--   · En un renglón de EVENTO toda cobertura es NEGATIVA. No hay reversión:
--     revertir un CONSUMED significa "esos gramos nunca salieron del lote", y
--     eso deja de ser cierto en el instante en que la carne toca la parrilla.
--     Lo que vuelve del asado vuelve COCIDO, a un lote nuevo, y por eso tiene
--     su propia razón (`LEFTOVER_RETURN`) en vez de un ADJUSTMENT que
--     resucitaría el lote crudo del que salió.
--   · La conservación del §L (leftover conservation) es un tope explícito: lo
--     guardado más lo botado nunca puede pasar lo que ese renglón sirvió. Sin
--     ese tope, "guardé 800 g" repetido tres veces fabrica 2,4 kg de carne que
--     nadie cocinó, y el balance de masa del §45 cerraría mintiendo.

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
  v_guardado numeric;
  v_renglon uuid;
begin
  perform app.assert_finite(new.covers_quantity, 'la cobertura del movimiento');

  -- El renglón del que cuelga este movimiento, sea de quien sea. Los dos
  -- campos son excluyentes por CHECK, así que esto no puede tapar a ninguno.
  v_renglon := coalesce(new.serving_record_item_id, new.event_serving_item_id);

  -- (0) Renglón y cobertura nacen juntos (el porqué del bicondicional acá y no
  --     en un CHECK de tabla: 0036:706).
  if (v_renglon is null) <> (new.covers_quantity is null) then
    raise exception
      'un movimiento colgado de un renglón servido necesita su cobertura, y una cobertura sin renglón no cubre nada'
      using errcode = 'check_violation';
  end if;

  -- (1) Un descuento por comer SIEMPRE tiene un renglón detrás. Desde el
  --     Sprint 13 ese renglón puede ser la porción de una persona o la fuente
  --     que salió a la mesa de un evento; lo que no puede es no existir.
  if new.reason = 'CONSUMED' and v_renglon is null then
    raise exception
      'un descuento por consumo solo lo escribe un registro de servido: primero se sirve, después se descuenta'
      using errcode = 'check_violation';
  end if;

  -- (2) Comer saca comida de la despensa.
  if new.reason = 'CONSUMED' and new.delta >= 0 then
    raise exception 'un consumo tiene que sacar del lote (delta negativo), llegó %', new.delta
      using errcode = 'check_violation';
  end if;

  -- (2 bis) La sobra que vuelve al refrigerador SÓLO existe colgada del
  --     renglón del evento que la sirvió. Suelta, `LEFTOVER_RETURN` sería una
  --     entrada libre de comida a la despensa sin nada que la acote — la
  --     puerta que este candado existe para no tener.
  if new.reason = 'LEFTOVER_RETURN' and new.event_serving_item_id is null then
    raise exception
      'una sobra vuelve colgada del renglón que la sirvió: sin ese renglón no hay con qué medir que no vuelva más de lo que salió'
      using errcode = 'check_violation';
  end if;

  -- =========================================================================
  -- RAMA EVENTO: el plato compartido
  -- =========================================================================
  if new.event_serving_item_id is not null then
    -- (E1) Tres razones y ninguna más. ADJUSTMENT no está: ver (E2).
    if new.reason not in ('CONSUMED', 'DISCARDED_LEFTOVER', 'LEFTOVER_RETURN') then
      raise exception
        'un movimiento colgado de una fuente del evento solo puede ser CONSUMED, DISCARDED_LEFTOVER o LEFTOVER_RETURN (llegó %)',
        new.reason using errcode = 'check_violation';
    end if;

    -- (E2) NO SE REVIERTE UN SERVIDO DE EVENTO. Revertir significa "esos
    --      gramos nunca salieron del lote y vuelven a él". En un asado eso deja
    --      de ser verdad apenas la carne toca la parrilla: el lote de origen
    --      era crudo y lo que sobra está cocido. Si el número servido se anotó
    --      mal, el arreglo es un ajuste de despensa (`adjust_lot`), que deja
    --      escrito POR QUÉ cambió el saldo; y si lo que volvió es comida real,
    --      es `save_event_leftover` y entra como lote nuevo.
    if new.reverses_movement_id is not null then
      raise exception
        'lo que salió a la parrilla no vuelve al lote del que salió: corrige el saldo con un ajuste de despensa, o guarda la sobra como lote cocido'
        using errcode = 'check_violation';
    end if;

    -- (E3) Toda cobertura de evento es negativa: consume presupuesto del
    --      renglón. Una cobertura positiva sólo tendría sentido para devolver,
    --      y devolver acá no existe (E2).
    if new.covers_quantity >= 0 then
      raise exception
        'la cobertura de un movimiento de evento sale del renglón (negativa), llegó %', new.covers_quantity
        using errcode = 'check_violation';
    end if;

    -- (E4) Coherencia de hogar. Mismo mensaje para "no existe" y "es de otra
    --      casa": no se filtra por el error que un recurso ajeno exista.
    select r.household_id into v_item_household
    from public.event_serving_items i
    join public.event_serving_records r on r.id = i.record_id
    where i.id = new.event_serving_item_id;

    if v_item_household is null or v_item_household <> new.household_id then
      raise exception 'no autorizado';
    end if;

    -- El `for update` no es decorativo: dos descuentos simultáneos sobre la
    -- misma fuente leen el mismo libro mayor y los dos pasan el tope.
    select i.served_quantity into v_servido
    from public.event_serving_items i
    where i.id = new.event_serving_item_id
    for update;

    select
      coalesce(sum(-m.covers_quantity) filter (where m.reason = 'CONSUMED'), 0),
      coalesce(sum(-m.covers_quantity) filter (where m.reason = 'DISCARDED_LEFTOVER'), 0),
      coalesce(sum(-m.covers_quantity) filter (where m.reason = 'LEFTOVER_RETURN'), 0)
    into v_sacado, v_botado, v_guardado
    from public.inventory_movements m
    where m.event_serving_item_id = new.event_serving_item_id;

    if new.reason = 'CONSUMED' then
      -- (E5) TOPE DE DESCUENTO. La fuente sirvió S: el libro mayor no puede
      --      sacar más de S de la despensa por ella. Se mide en `covers` y no
      --      en `delta` porque el renglón habla en cocido y el lote en crudo
      --      (0036:786): comparar las dos lenguas rebota servidos legítimos.
      if v_sacado + abs(new.covers_quantity) > coalesce(v_servido, 0) + 0.001 then
        raise exception
          'esta fuente sirvió % y el libro mayor ya le sacó % a la despensa: descontar % más sería cobrar dos veces la misma comida',
          coalesce(v_servido, 0), v_sacado, abs(new.covers_quantity)
          using errcode = 'check_violation';
      end if;
    else
      -- (E6) LA MERMA Y LA SOBRA NO VUELVEN A DESCONTAR. Esos gramos ya
      --      salieron del lote al servirse. La basura se anota con delta 0; la
      --      sobra entra a un lote NUEVO con delta positivo, que es comida que
      --      físicamente está en el refrigerador.
      if new.reason = 'DISCARDED_LEFTOVER' and new.delta <> 0 then
        raise exception
          'la merma de lo servido no descuenta de nuevo: esos gramos ya salieron del lote al servir'
          using errcode = 'check_violation';
      end if;

      if new.reason = 'LEFTOVER_RETURN' then
        if new.delta <= 0 then
          raise exception
            'guardar una sobra suma comida al lote nuevo (delta positivo), llegó %', new.delta
            using errcode = 'check_violation';
        end if;
        -- (E7) La sobra entra a un lote NUEVO. Apuntarla al mismo lote del que
        --      salió sería la reversión que (E2) prohíbe, escrita con otro
        --      nombre: repondría carne cruda congelada con carne asada.
        if exists (
          select 1 from public.inventory_movements m
          where m.event_serving_item_id = new.event_serving_item_id
            and m.reason = 'CONSUMED'
            and m.lot_id = new.lot_id
        ) then
          raise exception
            'la sobra cocida no vuelve al lote del que salió la carne cruda: se guarda como lote nuevo'
            using errcode = 'check_violation';
        end if;
      end if;

      -- (E8) CONSERVACIÓN. Guardado + botado nunca pasa lo servido. Sin este
      --      tope, apretar "guardé 800 g" tres veces mete 2,4 kg de carne que
      --      nadie cocinó y el balance de masa del §45 cierra mintiendo.
      if v_botado + v_guardado + abs(new.covers_quantity)
         > coalesce(v_servido, 0) + 0.001 then
        raise exception
          'esta fuente sirvió % y ya tiene % guardados y % botados: no puede volver más comida de la que salió',
          coalesce(v_servido, 0), v_guardado, v_botado
          using errcode = 'check_violation';
      end if;
    end if;

    return new;
  end if;

  -- =========================================================================
  -- RAMA PERSONAL: la porción de UNA persona (0036, intacta)
  -- =========================================================================
  if new.serving_record_item_id is not null then
    -- (3) Solo tres razones pueden colgar de un renglón servido.
    if new.reason not in ('CONSUMED', 'ADJUSTMENT', 'DISCARDED_LEFTOVER') then
      raise exception
        'un movimiento colgado de un renglón servido solo puede ser CONSUMED, ADJUSTMENT o DISCARDED_LEFTOVER (llegó %)',
        new.reason using errcode = 'check_violation';
    end if;

    -- (3b) Sobre un renglón servido, ajustar ES revertir (0036:748).
    if new.reason = 'ADJUSTMENT' and new.reverses_movement_id is null then
      raise exception
        'un ajuste sobre un renglón servido es siempre la reversión de un descuento: sin el movimiento que deshace, repone comida que nadie sacó'
        using errcode = 'check_violation';
    end if;

    -- (4) Coherencia de hogar.
    select r.household_id into v_item_household
    from public.meal_serving_record_items i
    join public.meal_serving_records r on r.id = i.record_id
    where i.id = new.serving_record_item_id;

    if v_item_household is null or v_item_household <> new.household_id then
      raise exception 'no autorizado';
    end if;

    -- (4b) TOPE POR RENGLÓN, medido contra el LIBRO MAYOR y en `covers_quantity`
    --      (0036:775-796).
    if new.reason = 'CONSUMED' then
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

    -- (5) La merma de lo servido NO vuelve a descontar.
    if new.reason = 'DISCARDED_LEFTOVER' and new.delta <> 0 then
      raise exception
        'la merma de lo servido no descuenta de nuevo: esos gramos ya salieron del lote al servir'
        using errcode = 'check_violation';
    end if;

    -- (5b) TOPE DE MERMA, con sus dos paredes (0036:840).
    if new.reason = 'DISCARDED_LEFTOVER' then
      select i.served_quantity into v_servido
      from public.meal_serving_record_items i
      where i.id = new.serving_record_item_id;

      select coalesce(sum(-m.covers_quantity), 0) into v_botado
      from public.inventory_movements m
      where m.serving_record_item_id = new.serving_record_item_id
        and m.reason = 'DISCARDED_LEFTOVER';

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

    -- (6b) Lista BLANCA de lo reversible: sólo CONSUMED. El argumento razón por
    --      razón está en 0036:884-955 y no se copia acá para que no existan dos
    --      versiones de la misma lista que puedan quedar distintas. Lo único
    --      que se agrega es la razón nueva del Sprint 13: `LEFTOVER_RETURN`
    --      nace NO reversible, como nace cualquier razón nueva.
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

    -- (7) Jamás se devuelve más de lo que ese movimiento sacó.
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

    -- (8) TOPE DEL RENGLÓN, NETO DE BASURA, recalculado desde el libro mayor.
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

comment on function app.movement_owner_guard() is
  'El candado estructural del Sprint 12, con el segundo dueño de renglón del '
  'Sprint 13: descontar inventario por comer = escribir un renglón de servido, '
  'sea la porción de una persona o la fuente compartida de un evento. En la '
  'rama de evento no hay reversión —lo que se asó no vuelve al lote crudo— y la '
  'sobra que se guarda está topada por lo que esa fuente sirvió.';

-- ---------------------------------------------------------------------------
-- 18.5 SERVIR EN EL EVENTO (§44, §48, §90): el libro mayor, no una vía nueva
-- ---------------------------------------------------------------------------
--
-- "Salieron 4,2 kg de vacuno a la mesa." Eso es UN hecho del hogar y se anota
-- una sola vez, en el mismo libro mayor de siempre y con la misma mecánica FEFO
-- que usa la porción individual (0036:1571). El evento no abre una segunda vía
-- al inventario: usa la que hay, con un dueño de renglón más.
--
-- LA CONVERSIÓN COCIDO→CRUDO ES EL CASO NORMAL ACÁ, no un borde. Lo que sale a
-- la mesa está cocido; lo que hay en el congelador está crudo. Sin factor de
-- rendimiento validado NO se inventa 1:1: el faltante se declara y sube a la
-- pantalla. Un asado servido sin lote detrás no es un error del sistema —la
-- carne pudo comprarse y nunca registrarse—, y por eso `serve_event_item`
-- devuelve cuánto de lo servido el libro mayor pudo respaldar. Cero respaldo no
-- es cero comida: es "no sé de dónde salió", que es otra cosa.

create or replace function app.fefo_deduct_event_item(
  p_item_id  uuid,
  p_cantidad numeric,
  p_actor    uuid,
  p_sufijo   text
) returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_item public.event_serving_items;
  v_household uuid;
  v_today date;
  v_lot record;
  v_pendiente numeric;
  v_toma numeric;
  v_cubre numeric;
  v_factor numeric;
begin
  select * into v_item from public.event_serving_items where id = p_item_id;
  if v_item.id is null then raise exception 'no autorizado'; end if;

  select household_id into v_household
  from public.event_serving_records where id = v_item.record_id;

  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado';
  end if;

  perform app.assert_finite(p_cantidad, 'la cantidad a descontar');
  v_pendiente := coalesce(p_cantidad, 0);
  if v_pendiente <= 0 then return 0; end if;

  -- El día del HOGAR, no el del servidor (0036:1596): a las 22:30 de Santiago
  -- un lote que vence mañana todavía sirve.
  v_today := app.household_today(v_household);

  -- Primera vuelta: lotes que hablan la MISMA lengua que el renglón (misma
  -- unidad, misma base física). Sin identidad de catálogo no se toca nada: un
  -- renglón rotulado a mano no puede salir a buscar lotes "parecidos".
  if v_item.product_id is not null or v_item.ingredient_id is not null then
    for v_lot in
      select l.* from public.inventory_lots l
      where l.household_id = v_household
        and (case
               when v_item.product_id is not null then l.product_id = v_item.product_id
               else l.ingredient_id = v_item.ingredient_id
             end)
        and l.unit = v_item.served_unit
        and l.weight_basis = v_item.served_weight_basis
        and l.status = 'AVAILABLE' and l.quantity > 0
        and (coalesce(l.use_by, l.expiry_date) is null
             or coalesce(l.use_by, l.expiry_date) >= v_today)
      order by l.use_by asc nulls last, l.expiry_date asc nulls last, l.created_at asc, l.id asc
      for update of l
    loop
      -- El corte es 0,001 y no 0: `delta` es numeric(12,3), así que un resto de
      -- cuatro decimales se redondea a 0.000 y choca contra el candado ("un
      -- consumo tiene que sacar del lote"). Medio miligramo de carne no es un
      -- faltante, pero sí era una excepción en medio del asado.
      exit when v_pendiente <= 0.0005;
      v_toma := round(least(v_pendiente, v_lot.quantity), 3);
      exit when v_toma <= 0;
      insert into public.inventory_movements
        (household_id, lot_id, reason, delta, idempotency_key,
         event_serving_item_id, covers_quantity, actor_member_id)
      values
        (v_household, v_lot.id, 'CONSUMED', -v_toma,
         'EVENT-SERVE:' || p_item_id::text || ':' || v_lot.id::text || ':' || p_sufijo,
         p_item_id, -v_toma, p_actor);
      v_pendiente := v_pendiente - v_toma;
    end loop;
  end if;

  -- Segunda vuelta: la carne está CRUDA en el congelador y lo que se sirvió
  -- está COCIDO. Se convierte SOLO con factor validado y SOLO con identidad de
  -- alimento, porque los rendimientos se anotan por ingrediente. Sin factor no
  -- hay conversión inventada: el faltante se declara (§13, §107).
  if v_pendiente > 0 and v_item.served_weight_basis = 'COOKED'
     and v_item.ingredient_id is not null then
    select y.yield_factor into v_factor
    from public.ingredient_yields y
    where y.ingredient_id = v_item.ingredient_id
      and (y.household_id is null or y.household_id = v_household)
    -- El renglón del evento no declara método de cocción, así que se prefiere
    -- lo del hogar sobre lo global y lo genérico sobre lo específico —una regla
    -- de "a la parrilla" no se le aplica a un asado del que nadie dijo cómo se
    -- cocinó—. El `y.id` final hace la elección determinista: dos corridas con
    -- los mismos datos eligen el mismo factor.
    order by (y.household_id is not null) desc, (y.cooking_method is null) desc, y.id asc
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
        order by l.use_by asc nulls last, l.expiry_date asc nulls last, l.created_at asc, l.id asc
        for update of l
      loop
        exit when v_pendiente <= 0.0005;
        v_toma := round(least(v_pendiente / v_factor, v_lot.quantity), 3);
        -- Los DOS números se redondean antes de escribirse, y el pendiente baja
        -- por el que quedó anotado: si el libro mayor dice que cubrió 709,999,
        -- lo que falta se mide contra eso y no contra un decimal que nadie
        -- guardó.
        v_cubre := round(v_toma * v_factor, 3);
        exit when v_toma <= 0 or v_cubre <= 0;
        insert into public.inventory_movements
          (household_id, lot_id, reason, delta, idempotency_key,
           event_serving_item_id, covers_quantity, actor_member_id, notes)
        values
          (v_household, v_lot.id, 'CONSUMED', -v_toma,
           'EVENT-SERVE:' || p_item_id::text || ':' || v_lot.id::text || ':' || p_sufijo,
           p_item_id,
           -- delta en la unidad del LOTE (crudo); cobertura en la del RENGLÓN
           -- (cocido). El factor queda congelado en estos dos números.
           -v_cubre,
           p_actor,
           'conversión explícita cocido→crudo ×' || v_factor::text);
        v_pendiente := v_pendiente - v_cubre;
      end loop;
    end if;
  end if;

  return greatest(v_pendiente, 0);
end;
$$;

/**
 * Servir una fuente en el evento.
 *
 * Devuelve el renglón creado, cuánto respaldó el libro mayor y cuánto quedó sin
 * respaldo. El faltante NO es un error: es un dato que la pantalla muestra tal
 * cual ("2,4 kg de los 4,2 servidos no salieron de un lote registrado").
 *
 * Idempotente por `p_dedupe_key`: el botón apretado dos veces con la misma
 * clave devuelve el mismo renglón y no descuenta de nuevo. SIN clave no hay
 * idempotencia y cada llamada es un servido nuevo — que es lo correcto: dos
 * fuentes iguales son dos actos (18.2).
 */
create or replace function public.serve_event_item(
  p_event_id      uuid,
  p_label         text,
  p_quantity      numeric,
  p_unit          text default 'G',
  p_weight_basis  public.weight_basis default 'COOKED',
  p_menu_item_id  uuid default null,
  p_ingredient_id uuid default null,
  p_product_id    uuid default null,
  p_batch_number  int default null,
  p_dedupe_key    text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_evento public.nutrition_events;
  v_actor uuid;
  v_hoy date;
  v_record uuid;
  v_item uuid;
  v_key text;
  v_disc text;
  v_falta numeric;
  v_descontado numeric;
  v_existente public.event_serving_items;
begin
  v_evento := app.event_actual_gate(p_event_id);

  perform app.assert_finite(p_quantity, 'la cantidad servida');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'servir es sacar comida a la mesa: la cantidad tiene que ser mayor que cero'
      using errcode = 'check_violation';
  end if;
  if p_unit not in ('G', 'ML', 'UNIT') then raise exception 'unidad desconocida'; end if;
  if nullif(trim(coalesce(p_label, '')), '') is null then
    raise exception 'un renglón servido tiene que decir QUÉ se sirvió'
      using errcode = 'check_violation';
  end if;

  if p_menu_item_id is not null and not exists (
    select 1 from public.event_menu_items where id = p_menu_item_id and event_id = p_event_id
  ) then
    raise exception 'ese item de menú no es de este evento' using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_evento.household_id);
  v_hoy   := app.household_today(v_evento.household_id);

  -- La clave del reintento se compone ACÁ, con el ancla del acto (este evento) y
  -- el discriminador que aporta el cliente. Sin discriminador NO HAY CLAVE:
  -- servir dos fuentes iguales en el mismo asado son dos actos, y colapsarlos
  -- por parecido se traga comida que sí salió a la mesa (ver 18.2).
  v_disc := nullif(trim(coalesce(p_dedupe_key, '')), '');
  if v_disc is not null then
    v_key := app.intake_dedupe_key('EVENT-SERVE', v_evento.household_id,
                                   p_event_id::text, v_disc);
  else
    v_key := null;
  end if;

  -- Y se busca SOLO lo vivo y SOLO dentro de la casa: un renglón anulado con
  -- esta clave no es un reintento (0038:699).
  if v_key is not null then
    select i.* into v_existente
    from public.event_serving_items i
    join public.event_serving_records r on r.id = i.record_id
    where i.dedupe_key = v_key
      and i.status = 'ACTIVE'
      and r.household_id = v_evento.household_id;
  end if;
  if v_existente.id is not null then
    return jsonb_build_object(
      'record_id', v_existente.record_id,
      'item_id', v_existente.id,
      'served', v_existente.served_quantity,
      'deducted', v_existente.deducted_quantity,
      'shortfall', v_existente.served_quantity - v_existente.deducted_quantity,
      'repetido', true);
  end if;

  -- El encabezado de la tanda: uno por evento, día y número de tanda.
  insert into public.event_serving_records
    (event_id, household_id, served_on, served_by, batch_number)
  values (p_event_id, v_evento.household_id, v_hoy, v_actor, p_batch_number)
  on conflict (event_id, served_on, coalesce(batch_number, 0))
    where status = 'ACTIVE'
  do update set served_at = public.event_serving_records.served_at
  returning id into v_record;

  insert into public.event_serving_items
    (record_id, menu_item_id, ingredient_id, product_id, label,
     served_quantity, served_unit, served_weight_basis, dedupe_key)
  values (v_record, p_menu_item_id, p_ingredient_id, p_product_id,
          trim(p_label), p_quantity, p_unit, p_weight_basis, v_key)
  returning id into v_item;

  v_falta := round(app.fefo_deduct_event_item(v_item, p_quantity, v_actor, '0'), 3);

  -- El espejo se pide, no se dicta: el trigger `event_serving_items_is_history`
  -- lo recalcula desde el libro mayor y devuelve la verdad, no este número.
  update public.event_serving_items
  set deducted_quantity = greatest(p_quantity - v_falta, 0)
  where id = v_item;

  select deducted_quantity into v_descontado
  from public.event_serving_items where id = v_item;
  v_falta := round(greatest(p_quantity - v_descontado, 0), 3);

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_evento.household_id, auth.uid(), 'EVENT_SERVING_RECORDED',
          'nutrition_event', p_event_id,
          jsonb_build_object('item_id', v_item, 'label', trim(p_label),
                             'quantity', p_quantity, 'unit', p_unit,
                             'shortfall', v_falta));

  insert into public.domain_events
    (household_id, event_type, aggregate, payload, scope, dedupe_key)
  values (
    v_evento.household_id, 'EVENT_ACTUAL_RECORDED', 'nutrition_event',
    jsonb_build_object('event_id', p_event_id, 'serving_item_id', v_item),
    jsonb_build_object('event_id', p_event_id),
    'EVENT_SERVED:' || v_item::text)
  on conflict (dedupe_key) do nothing;

  return jsonb_build_object(
    'record_id', v_record,
    'item_id', v_item,
    'served', p_quantity,
    'deducted', v_descontado,
    'shortfall', v_falta,
    'repetido', false);
end;
$$;

comment on function public.serve_event_item(uuid, text, numeric, text, public.weight_basis, uuid, uuid, uuid, int, text) is
  'Anota una fuente servida en el evento y la descuenta por FEFO del mismo '
  'libro mayor de siempre. Devuelve el faltante sin respaldo en lotes, que no '
  'es un error ni un cero: es "esta comida no salió de un lote registrado".';

-- ---------------------------------------------------------------------------
-- 18.6 LA SOBRA VUELVE (§57, §91): lote COOKED, sin fecha inventada
-- ---------------------------------------------------------------------------
--
-- Quedaron 800 g de vacuno asado. Eso es comida que existe, está en el
-- refrigerador y tiene que poder usarse la semana que viene (§58) — pero es
-- comida NUEVA para el inventario: el lote crudo del que salió ya se descontó
-- al servir, y esos gramos ahora están cocidos. Por eso nace un lote propio y
-- no una reversión (ver E2 del candado).
--
-- LO QUE ESTA FUNCIÓN NO HACE, Y ES DELIBERADO:
--
--   · No inventa `use_by`. El veredicto de conservación lo da el motor
--     `storage-safety/1.0.0` con reglas que citan fuente, y si no hay regla que
--     calce la respuesta es "revisar", no una fecha plausible (§21, §57). La
--     función devuelve el lote; quien la llama corre el motor y, sólo si hay
--     veredicto, llama a `set_lot_safety` —que además exige la regla fuente.
--   · No marca nada como merma. La carne que quedó CRUDA y no se cocinó nunca
--     se descontó: sigue en su lote, disponible, y no aparece por acá (§91).
--
-- El linaje del §96 va en una columna propia: "de qué evento salió esta sobra"
-- es una pregunta de PROCEDENCIA, y se contesta con un puntero al renglón que
-- la sirvió. La pregunta contraria —"para qué evento aparté este lote"— no se
-- contesta en este esquema: no hay reserva (ver sección 13).

alter table public.inventory_lots
  add column source_event_serving_item_id uuid
    references public.event_serving_items (id) on delete set null;

create index inventory_lots_source_event_item_idx
  on public.inventory_lots (source_event_serving_item_id)
  where source_event_serving_item_id is not null;

comment on column public.inventory_lots.source_event_serving_item_id is
  'Renglón del evento del que volvió esta sobra. Es procedencia (§96) y nada '
  'más: este lote NO queda apartado para ese evento ni para ningún otro, '
  'porque la reserva por evento no existe en este esquema.';

create or replace function public.save_event_leftover(
  p_serving_item_id  uuid,
  p_quantity         numeric,
  p_location_id      uuid default null,
  p_label            text default null,
  p_intended_use_date date default null,
  p_dedupe_key       text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item public.event_serving_items;
  v_record public.event_serving_records;
  v_evento public.nutrition_events;
  v_actor uuid;
  v_loc uuid;
  v_kind public.storage_kind;
  v_lot uuid;
  v_key text;
  v_disc text;
  v_previo public.inventory_movements;
begin
  select * into v_item from public.event_serving_items where id = p_serving_item_id;
  if v_item.id is null then raise exception 'no autorizado'; end if;

  -- Un renglón anulado no recibe sobras: esos gramos ya volvieron al lote del
  -- que salieron y devolverlos otra vez sería fabricar comida.
  if v_item.status <> 'ACTIVE' then
    raise exception 'ese renglón servido está anulado: sírvelo de nuevo antes de guardarle una sobra'
      using errcode = 'check_violation';
  end if;

  select * into v_record from public.event_serving_records where id = v_item.record_id;
  if v_record.id is null then raise exception 'no autorizado'; end if;

  -- Mismo permiso y misma ventana que servir: guardar la sobra es parte del
  -- día del evento y la hace quien estaba ahí.
  v_evento := app.event_actual_gate(v_record.event_id);

  perform app.assert_finite(p_quantity, 'la cantidad guardada');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'guardar una sobra exige decir cuánto: cero no es una sobra'
      using errcode = 'check_violation';
  end if;

  -- MISMO CRITERIO QUE SERVIR (18.2): el ancla la pone el servidor —este
  -- renglón— y el discriminador lo aporta el cliente. La versión anterior caía
  -- a `p_quantity::text`, y con eso dos táperes de 800 g del mismo renglón eran
  -- una sola sobra: el segundo nunca entraba al refrigerador y la pantalla
  -- igual decía "guardada".
  v_disc := nullif(trim(coalesce(p_dedupe_key, '')), '');
  if v_disc is not null then
    v_key := app.intake_dedupe_key('EVENT-LEFTOVER', v_record.household_id,
                                   p_serving_item_id::text, v_disc);

    -- Reintento: devuelve lo que ya se guardó, sin sumar un gramo.
    select * into v_previo from public.inventory_movements
    where idempotency_key = v_key and household_id = v_record.household_id;
    if v_previo.id is not null then
      return jsonb_build_object('lot_id', v_previo.lot_id, 'quantity', v_previo.delta,
                                'repetido', true);
    end if;
  else
    v_key := null;
  end if;

  v_actor := app.current_member_id(v_record.household_id);
  perform public.ensure_storage_locations(v_record.household_id);

  if p_location_id is not null and not exists (
    select 1 from public.storage_locations
    where id = p_location_id and household_id = v_record.household_id
  ) then
    raise exception 'la ubicación no pertenece a este hogar';
  end if;

  -- Por omisión, el REFRIGERADOR. `add_manual_lot` (0015) cae a la despensa,
  -- que para carne cocida a las seis de la tarde es el peor lugar posible; y
  -- elegir el congelador por defecto le cambiaría el estado al alimento sin que
  -- nadie lo haya movido.
  v_loc := coalesce(p_location_id,
             (select id from public.storage_locations
              where household_id = v_record.household_id and kind = 'FRIDGE'
              order by sort_order limit 1),
             (select id from public.storage_locations
              where household_id = v_record.household_id
              order by sort_order limit 1));
  select kind into v_kind from public.storage_locations where id = v_loc;

  insert into public.inventory_lots (
    household_id, ingredient_id, product_id, label, quantity, unit, weight_basis,
    processing_state, temperature_state, frozen_at, location_id,
    source_event_serving_item_id, created_by
  ) values (
    v_record.household_id, v_item.ingredient_id, v_item.product_id,
    coalesce(nullif(trim(coalesce(p_label, '')), ''), 'Sobra de ' || v_item.label),
    0, v_item.served_unit,
    -- Lo que volvió está cocido. Anotarlo como RAW haría que el FEFO de la
    -- semana siguiente lo mezclara con carne cruda y que el rendimiento se
    -- descontara dos veces.
    'COOKED'::public.weight_basis,
    'COOKED'::public.processing_state,
    case v_kind
      when 'FREEZER' then 'FROZEN'::public.temperature_state
      when 'FRIDGE'  then 'CHILLED'::public.temperature_state
      else 'AMBIENT'::public.temperature_state
    end,
    case when v_kind = 'FREEZER' then now() else null end,
    v_loc, p_serving_item_id, v_actor
  ) returning id into v_lot;

  -- El tope de conservación lo pone el candado (E8): si esta sobra pasara lo
  -- que la fuente sirvió, revienta acá y la transacción entera se va, lote
  -- incluido.
  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, idempotency_key,
     event_serving_item_id, covers_quantity, actor_member_id, notes)
  values
    (v_record.household_id, v_lot, 'LEFTOVER_RETURN', p_quantity, v_key,
     p_serving_item_id, -p_quantity, v_actor,
     'sobra guardada del evento');

  if p_intended_use_date is not null then
    perform public.set_intended_use(v_lot, p_intended_use_date, null);
  end if;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_record.household_id, auth.uid(), 'EVENT_LEFTOVER_SAVED',
          'nutrition_event', v_record.event_id,
          jsonb_build_object('lot_id', v_lot, 'serving_item_id', p_serving_item_id,
                             'quantity', p_quantity, 'unit', v_item.served_unit));

  insert into public.domain_events
    (household_id, event_type, aggregate, payload, scope, dedupe_key)
  values (
    v_record.household_id, 'EVENT_LEFTOVERS_RECORDED', 'nutrition_event',
    jsonb_build_object('event_id', v_record.event_id, 'lot_id', v_lot),
    jsonb_build_object('event_id', v_record.event_id),
    'EVENT_LEFTOVER:' || v_lot::text)
  on conflict (dedupe_key) do nothing;

  -- `safety_pendiente` no es un adorno: dice que este lote NO tiene fecha de
  -- consumo y que nadie la va a inventar por él.
  return jsonb_build_object('lot_id', v_lot, 'quantity', p_quantity,
                            'unit', v_item.served_unit,
                            'safety_pendiente', true, 'repetido', false);
end;
$$;

comment on function public.save_event_leftover(uuid, numeric, uuid, text, date, text) is
  'La sobra del evento entra como lote COOKED nuevo, colgada del renglón que la '
  'sirvió y topada por lo que ese renglón sirvió. Sin fecha de consumo: esa la '
  'decide el motor de conservación con una regla que cite fuente, o queda en '
  'revisión.';

-- ---------------------------------------------------------------------------
-- 18.6 bis  LO QUE NO SE COMIÓ NI SE GUARDÓ, Y EL RENGLÓN MAL ANOTADO
-- ---------------------------------------------------------------------------
--
-- Faltaban los dos finales que la porción personal tiene desde el Sprint 12, y
-- sin ellos el asado quedaba con una física imposible:
--
--  · LA MERMA DEL ASADO ERA ESTRUCTURALMENTE CERO. El §55 nombra cinco
--    destinos, el candado admite `DISCARDED_LEFTOVER` colgado de una fuente de
--    evento y el espejo lo sabe recalcular — pero ningún RPC escribía ese
--    movimiento. `renglon.botado` valía 0 siempre, y la pantalla del día lo
--    usaba como dato duro para decidir cuánto más te deja guardar. Un cero que
--    nadie midió presentado como cero medido es la doctrina al revés.
--
--  · EL RENGLÓN MAL ANOTADO NO SE PODÍA DESHACER. Con "18000" en vez de "1800"
--    el evento afirmaba 18 kg para siempre y además habilitaba devolver
--    "sobras" hasta ese número, porque el tope (E8) mide contra lo SERVIDO.
--
-- Los dos escriben en el mismo libro mayor y ninguno abre una vía nueva.

/**
 * El factor congelado fuente→lote, leído del libro mayor.
 *
 * Gemelo de `app.serving_lot_factor` (0036:2715) para el dueño de renglón del
 * Sprint 13. NULL = no se sabe, y no se inventa 1:1: la fuente habla en cocido
 * y el lote en crudo, y suponer que pesan lo mismo es fabricar merma.
 */
create or replace function app.event_serving_lot_factor(p_item_id uuid, p_lot_id uuid)
returns numeric language sql stable set search_path = public as $$
  select sum(abs(m.delta)) / nullif(sum(abs(m.covers_quantity)), 0)
  from public.inventory_movements m
  where m.event_serving_item_id = p_item_id
    and m.lot_id = p_lot_id
    and m.reason = 'CONSUMED';
$$;

comment on function app.event_serving_lot_factor(uuid, uuid) is
  'Factor congelado fuente del evento→lote, leído del libro mayor. NULL = no se '
  'sabe, y no se inventa 1:1.';

/**
 * "De esa fuente se botaron 300 g."
 *
 * `delta` va en 0 —esos gramos ya salieron del lote al servirse (E6)— y la
 * cantidad viaja en `covers_quantity`, que es "cuánto de esta fuente cubre este
 * movimiento". El peso en lengua de LOTE va en `waste_lot_quantity` para que el
 * informe de desperdicio pueda sumar esta merma junto a la de la despensa sin
 * que el inventario la descuente dos veces.
 *
 * El tope es del candado (E8): guardado + botado nunca pasa lo servido. Y el
 * espejo `discarded_quantity` no se dicta: lo recalcula el trigger desde el
 * libro mayor.
 */
create or replace function public.discard_event_serving(
  p_serving_item_id uuid,
  p_quantity        numeric,
  p_reason          text default null,
  p_dedupe_key      text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item public.event_serving_items;
  v_record public.event_serving_records;
  v_actor uuid;
  v_lot uuid;
  v_factor numeric;
  v_key text;
  v_disc text;
  v_previo public.inventory_movements;
  v_botado numeric;
begin
  -- `for update` no es decorativo: serializa dos mermas simultáneas sobre la
  -- misma fuente. Sin el lock las dos leen el mismo libro mayor y las dos pasan.
  select * into v_item from public.event_serving_items
  where id = p_serving_item_id for update;
  if v_item.id is null then raise exception 'no autorizado'; end if;
  if v_item.status <> 'ACTIVE' then
    raise exception 'ese renglón servido está anulado: no tiene merma que declarar'
      using errcode = 'check_violation';
  end if;

  select * into v_record from public.event_serving_records where id = v_item.record_id;
  if v_record.id is null then raise exception 'no autorizado'; end if;

  -- Mismo permiso y misma ventana que servir: es parte del día del evento.
  perform app.event_actual_gate(v_record.event_id);

  perform app.assert_finite(p_quantity, 'la cantidad botada');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'botar exige decir cuánto: cero no es merma'
      using errcode = 'check_violation';
  end if;

  v_disc := nullif(trim(coalesce(p_dedupe_key, '')), '');
  if v_disc is not null then
    v_key := app.intake_dedupe_key('EVENT-DISCARD', v_record.household_id,
                                   p_serving_item_id::text, v_disc);
    select * into v_previo from public.inventory_movements
    where idempotency_key = v_key and household_id = v_record.household_id;
    if v_previo.id is not null then
      return jsonb_build_object('movimiento_id', v_previo.id,
                                'quantity', -v_previo.covers_quantity,
                                'repetido', true);
    end if;
  else
    v_key := null;
  end if;

  -- Contra el lote del que efectivamente salió (el último), igual que la merma
  -- personal (0036): así la basura queda trazable hasta su origen.
  select m.lot_id into v_lot from public.inventory_movements m
  where m.event_serving_item_id = p_serving_item_id and m.reason = 'CONSUMED'
  order by m.created_at desc, m.id desc limit 1;

  if v_lot is null then
    raise exception
      'esta fuente no salió de ningún lote registrado: no hay contra qué pesar su merma en la despensa'
      using errcode = 'check_violation';
  end if;

  v_factor := app.event_serving_lot_factor(p_serving_item_id, v_lot);
  if v_factor is null then
    raise exception
      'no se puede pesar esta merma: el libro mayor no dice cuánto sacó esta fuente de ese lote'
      using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_record.household_id);

  insert into public.inventory_movements
    (household_id, lot_id, reason, delta, idempotency_key,
     event_serving_item_id, covers_quantity, waste_lot_quantity, actor_member_id, notes)
  values
    (v_record.household_id, v_lot, 'DISCARDED_LEFTOVER', 0, v_key,
     p_serving_item_id, -p_quantity, -round(p_quantity * v_factor, 3), v_actor,
     coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'salió a la mesa y se botó'));

  -- El espejo se PIDE, no se dicta: el trigger lo recalcula desde el libro
  -- mayor e ignora el número que venga (sección 20).
  update public.event_serving_items set discarded_quantity = 0
  where id = p_serving_item_id;
  select discarded_quantity into v_botado
  from public.event_serving_items where id = p_serving_item_id;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_record.household_id, auth.uid(), 'EVENT_SERVING_DISCARDED',
          'nutrition_event', v_record.event_id,
          jsonb_build_object('serving_item_id', p_serving_item_id,
                             'quantity', p_quantity, 'unit', v_item.served_unit));

  return jsonb_build_object('botado_total', v_botado, 'quantity', p_quantity,
                            'unit', v_item.served_unit, 'repetido', false);
end;
$$;

comment on function public.discard_event_serving(uuid, numeric, text, text) is
  'Lo que salió a la mesa y terminó en la basura. No vuelve a descontar —el '
  'lote ya pagó al servir— pero SÍ gasta el saldo de esa fuente: lo que está '
  'en el basurero no puede volver también al refrigerador.';

/**
 * "Ese servido está mal: no fue así."
 *
 * NO ES UNA REVERSIÓN DEL MOVIMIENTO DEL EVENTO, y no puede serlo: (E2) prohíbe
 * devolver al lote crudo lo que ya se asó, con razón. Es la otra cosa: si el
 * número estaba mal —"18000" en vez de "1800"—, esos gramos NUNCA salieron del
 * congelador, y lo que corresponde es el AJUSTE DE DESPENSA que este mismo
 * archivo prescribe, con el motivo escrito al lado.
 *
 * POR QUÉ EL AJUSTE SE ESCRIBE ACÁ Y NO LLAMANDO A `public.adjust_lot` (0013):
 * esa función recibe la cantidad ABSOLUTA que debe quedar en el lote —leer y
 * después escribir, con la carrera adentro— y además reescribe
 * `is_approximate`, que no tiene nada que ver con esta corrección. Lo que hace
 * falta acá es exactamente un delta conocido, el que el libro mayor ya dice.
 *
 * LO QUE NO HACE: no borra nada. El descuento original sigue escrito y el
 * ajuste que lo devuelve queda al lado. `deducted_quantity` del renglón anulado
 * sigue diciendo lo que el libro mayor sacó ese día, porque eso pasó; lo que
 * cambia es que el renglón deja de estar VIVO y nadie lo vuelve a contar.
 */
create or replace function public.void_event_serving_item(
  p_serving_item_id uuid,
  p_reason          text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item public.event_serving_items;
  v_record public.event_serving_records;
  v_actor uuid;
  v_motivo text;
  v_guardado numeric;
  v_botado numeric;
  v_devuelto numeric := 0;
  v_lote record;
begin
  select * into v_item from public.event_serving_items
  where id = p_serving_item_id for update;
  if v_item.id is null then raise exception 'no autorizado'; end if;
  if v_item.status <> 'ACTIVE' then
    raise exception 'ese renglón servido ya está anulado' using errcode = 'check_violation';
  end if;

  select * into v_record from public.event_serving_records where id = v_item.record_id;
  if v_record.id is null then raise exception 'no autorizado'; end if;

  perform app.event_actual_gate(v_record.event_id);

  v_motivo := nullif(trim(coalesce(p_reason, '')), '');
  if v_motivo is null then
    raise exception
      'anular un servido exige decir por qué: sin motivo, mañana nadie sabe si esa comida no salió o si el número estaba mal'
      using errcode = 'check_violation';
  end if;

  -- LA SOBRA Y LA MERMA YA GASTARON DE ESTE RENGLÓN. Anularlo con comida ya
  -- devuelta al refrigerador dejaría esos gramos sin origen: el lote cocido
  -- existiría y el servido que lo justificaba, no. Se dice y no se rompe.
  select
    coalesce(sum(-m.covers_quantity) filter (where m.reason = 'LEFTOVER_RETURN'), 0),
    coalesce(sum(-m.covers_quantity) filter (where m.reason = 'DISCARDED_LEFTOVER'), 0)
  into v_guardado, v_botado
  from public.inventory_movements m
  where m.event_serving_item_id = p_serving_item_id;

  if v_guardado > 0.001 or v_botado > 0.001 then
    raise exception
      'esta fuente ya tiene % guardados de sobra y % botados: anularla dejaría esa comida sin de dónde salió. Sirve la diferencia como un renglón nuevo en vez de anular éste',
      v_guardado, v_botado
      using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_record.household_id);

  -- Los gramos vuelven al lote del que salieron, lote por lote y en la lengua
  -- del LOTE (`delta`), que es la que el libro mayor congeló al descontar.
  for v_lote in
    select m.lot_id as lot_id, sum(abs(m.delta)) as gramos
    from public.inventory_movements m
    where m.event_serving_item_id = p_serving_item_id and m.reason = 'CONSUMED'
    group by m.lot_id
  loop
    insert into public.inventory_movements
      (household_id, lot_id, reason, delta, actor_member_id, notes)
    values
      (v_record.household_id, v_lote.lot_id, 'ADJUSTMENT', v_lote.gramos, v_actor,
       'anulación de un servido del evento: ' || v_motivo);
    v_devuelto := v_devuelto + v_lote.gramos;
  end loop;

  update public.event_serving_items
  set status = 'VOIDED', void_reason = v_motivo, voided_at = now()
  where id = p_serving_item_id;

  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_record.household_id, auth.uid(), 'EVENT_SERVING_VOIDED',
          'nutrition_event', v_record.event_id,
          jsonb_build_object('serving_item_id', p_serving_item_id,
                             'served', v_item.served_quantity,
                             'devuelto_al_lote', v_devuelto,
                             'reason', v_motivo));

  return jsonb_build_object('serving_item_id', p_serving_item_id,
                            'devuelto_al_lote', v_devuelto);
end;
$$;

comment on function public.void_event_serving_item(uuid, text) is
  'Anula una fuente mal anotada y devuelve al lote, con un ajuste de despensa '
  'que dice por qué, los gramos que el libro mayor le había sacado. No revierte '
  'el movimiento del evento (E2): lo que se asó no vuelve al lote crudo.';

-- ---------------------------------------------------------------------------
-- 18.7 EL CONSUMO: tres ejes que no se pisan (§45, §47, §48, §52)
-- ---------------------------------------------------------------------------
--
-- (a) BALANCE DE MASA POR CORTE, agregado y del hogar. Se anota como fila
--     nueva, nunca encima de la anterior: corregir es superar (mismo patrón que
--     `correct_intake_log`, 0038). Quien lee toma la última por corte.
--
--     UNKNOWN NO SE RELLENA. Que nadie haya pesado la merma no significa que la
--     merma fue cero, y por eso todas las columnas admiten NULL y la función no
--     completa ninguna. Lo único que se valida es que lo declarado no se
--     contradiga: los destinos conocidos no pueden pasar lo servido conocido.

create or replace function public.record_event_consumption(
  p_event_id     uuid,
  p_label        text,
  p_menu_item_id uuid default null,
  p_ingredient_id uuid default null,
  p_product_id   uuid default null,
  p_unit         text default 'G',
  p_raw_input    numeric default null,
  p_served       numeric default null,
  p_consumed_min numeric default null,
  p_consumed_max numeric default null,
  p_edible_leftover numeric default null,
  p_plate_waste  numeric default null,
  p_trim_waste   numeric default null,
  p_bone_discard numeric default null,
  p_spoiled      numeric default null,
  p_confidence   text default 'LOW',
  p_reasons      jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_evento public.nutrition_events;
  v_actor uuid;
  v_destinos numeric;
  v_id uuid;
begin
  v_evento := app.event_actual_gate(p_event_id);

  if nullif(trim(coalesce(p_label, '')), '') is null then
    raise exception 'el balance de un corte tiene que decir de qué corte habla'
      using errcode = 'check_violation';
  end if;
  if p_unit not in ('G', 'ML', 'UNIT') then raise exception 'unidad desconocida'; end if;
  if p_confidence not in ('HIGH', 'MEDIUM', 'LOW') then
    raise exception 'la confianza es HIGH, MEDIUM o LOW' using errcode = 'check_violation';
  end if;
  if p_menu_item_id is not null and not exists (
    select 1 from public.event_menu_items where id = p_menu_item_id and event_id = p_event_id
  ) then
    raise exception 'ese item de menú no es de este evento' using errcode = 'check_violation';
  end if;

  perform app.assert_finite(p_served, 'lo servido');
  perform app.assert_finite(p_edible_leftover, 'la sobra comestible');
  perform app.assert_finite(p_plate_waste, 'lo que quedó en los platos');
  perform app.assert_finite(p_spoiled, 'lo que se echó a perder');

  -- Los destinos conocidos de lo SERVIDO no pueden pasar lo servido. Ojo con lo
  -- que NO entra en esta suma: el hueso y el desgrase salen del peso CRUDO, no
  -- de lo que llegó a la mesa (§54), y meterlos acá haría rebotar balances
  -- correctos. Si alguno es NULL no se valida nada contra él: UNKNOWN no suma
  -- cero, no suma nada.
  if p_served is not null then
    v_destinos := coalesce(p_edible_leftover, 0) + coalesce(p_plate_waste, 0)
                + coalesce(p_spoiled, 0);
    if v_destinos > p_served + 0.001 then
      raise exception
        'de esta fuente salieron % a la mesa y el detalle suma %: la masa no se conserva',
        p_served, v_destinos using errcode = 'check_violation';
    end if;
    if p_consumed_min is not null and p_consumed_min > p_served + 0.001 then
      raise exception 'nadie pudo comer más de lo que salió a la mesa (% de %)',
        p_consumed_min, p_served using errcode = 'check_violation';
    end if;
  end if;

  v_actor := app.current_member_id(v_evento.household_id);

  insert into public.event_consumption_estimates (
    event_id, menu_item_id, ingredient_id, product_id, label, unit,
    raw_input_quantity, served_quantity,
    consumed_min_quantity, consumed_max_quantity,
    edible_leftover_quantity, plate_waste_quantity, trim_waste_quantity,
    bone_discard_quantity, spoiled_quantity,
    confidence, reasons, created_by
  ) values (
    p_event_id, p_menu_item_id, p_ingredient_id, p_product_id, trim(p_label), p_unit,
    p_raw_input, p_served, p_consumed_min, p_consumed_max,
    p_edible_leftover, p_plate_waste, p_trim_waste, p_bone_discard, p_spoiled,
    p_confidence, coalesce(p_reasons, '[]'::jsonb), v_actor
  ) returning id into v_id;

  insert into public.domain_events
    (household_id, event_type, aggregate, payload, scope, dedupe_key)
  values (
    v_evento.household_id, 'EVENT_ACTUAL_RECORDED', 'nutrition_event',
    jsonb_build_object('event_id', p_event_id, 'consumption_id', v_id),
    jsonb_build_object('event_id', p_event_id),
    'EVENT_CONSUMPTION:' || v_id::text)
  on conflict (dedupe_key) do nothing;

  return v_id;
end;
$$;

-- (b) LA OBSERVACIÓN POR COMENSAL: el único hecho del que puede salir "Juan
--     come harto".
--
--     El §52 quiere sugerir Appetite HIGH para quien comió mucho en sus últimos
--     asados. Con lo agregado (a) eso es imposible de sostener: la única forma
--     de sacar el consumo de Juan del total del hogar es dividirlo entre los
--     asistentes, y eso es exactamente la distribución individual que el §48
--     prohíbe. Repartir 8,4 kg entre once y decir "Juan comió 764 g" es
--     inventar un dato y después aprender de él.
--
--     Así que el hecho se pide en vez de derivarse. Es ORDINAL —comió poco,
--     normal, harto—, es opcional, y lo escribe una persona que estuvo ahí. Si
--     nadie observó nada, la tarjeta del §52 simplemente no aparece: sin hecho
--     no hay aprendizaje, y una sugerencia sin hecho detrás es peor que ninguna
--     sugerencia.
--
--     Los gramos son opcionales y sólo valen si alguien los declaró (§47
--     permite "estimated/actual serving" del invitado). NULL es UNKNOWN, no
--     cero.

create table public.event_participant_observations (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.nutrition_events (id) on delete cascade,
  participant_id uuid not null references public.event_participants (id) on delete cascade,
  intake_extent  public.guest_intake_extent not null,
  -- Declarado a mano o nada. Jamás el total repartido entre los asistentes.
  estimated_serving_g numeric(12, 3)
    check (estimated_serving_g is null or estimated_serving_g >= 0),
  note           text check (note is null or char_length(note) <= 500),
  observed_by    uuid references public.household_members (id) on delete set null,
  -- Corregir es superar: la fila vieja queda y la nueva la apunta.
  supersedes_id  uuid references public.event_participant_observations (id) on delete set null,
  created_at     timestamptz not null default now()
);

create index event_participant_observations_event_idx
  on public.event_participant_observations (event_id);
create index event_participant_observations_participant_idx
  on public.event_participant_observations (participant_id, created_at desc);

comment on table public.event_participant_observations is
  'Observación ORDINAL y opcional de cuánto comió UN comensal, escrita a mano '
  'por quien organizó. Es el único hecho del que el aprendizaje puede sacar '
  'una tendencia por invitado (§52): el agregado del hogar dividido por el '
  'número de asistentes está prohibido (§48) y no existe la columna que lo '
  'guardaría.';

create trigger event_participant_observations_append_only
  before update or delete on public.event_participant_observations
  for each row execute function app.append_only_guard();

create or replace function public.record_event_guest_observation(
  p_participant_id uuid,
  p_intake_extent  public.guest_intake_extent,
  p_estimated_serving_g numeric default null,
  p_note           text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_evento public.nutrition_events;
  v_event_id uuid;
  v_actor uuid;
  v_previa uuid;
  v_id uuid;
begin
  select event_id into v_event_id from public.event_participants where id = p_participant_id;
  if v_event_id is null then
    raise exception 'participante inexistente' using errcode = 'no_data_found';
  end if;

  v_evento := app.event_actual_gate(v_event_id);

  perform app.assert_finite(p_estimated_serving_g, 'los gramos observados');
  if p_estimated_serving_g is not null and p_estimated_serving_g < 0 then
    raise exception 'una porción observada no puede ser negativa'
      using errcode = 'check_violation';
  end if;

  v_actor := app.current_member_id(v_evento.household_id);

  select id into v_previa from public.event_participant_observations
  where participant_id = p_participant_id
  order by created_at desc, id desc limit 1;

  insert into public.event_participant_observations
    (event_id, participant_id, intake_extent, estimated_serving_g, note,
     observed_by, supersedes_id)
  values (v_event_id, p_participant_id, p_intake_extent, p_estimated_serving_g,
          nullif(trim(coalesce(p_note, '')), ''), v_actor, v_previa)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_event_guest_observation(uuid, public.guest_intake_extent, numeric, text) is
  'Anota, a mano y en escala gruesa, cuánto comió un comensal. Sin esta fila el '
  'aprendizaje por invitado no existe — y es correcto que no exista.';

-- ---------------------------------------------------------------------------
-- 18.8 RLS: los HECHOS no se escriben por la puerta directa
-- ---------------------------------------------------------------------------
--
-- La sección 16 le puso a todas las tablas nuevas el molde del plan: leer es de
-- la casa, escribir pide `can_edit_plan`. Para el menú y las revisiones está
-- bien. Para los HECHOS del día está mal por dos motivos distintos:
--
--   1. Una fila de servido escrita por PostgREST directo NO descuenta nada. El
--      resumen diría "salieron 4,2 kg" y la despensa seguiría llena: el hecho
--      quedaría inventado y, peor, alimentaría el aprendizaje. `serve_event_item`
--      es la única puerta, igual que en el Sprint 12 —`meal_serving_records`
--      (0036:1504) tiene política de SELECT y nada más—.
--   2. `can_edit_plan` es el permiso equivocado para el día del asado: la carne
--      la sirve quien cocina. Los RPC piden `can_cook` O `can_edit_plan`
--      (`app.event_actual_gate`), y una política que pidiera sólo planificar
--      dejaría abierta una puerta más estrecha que la del RPC, que es la peor
--      combinación posible: confunde sin proteger.
--
-- Se quitan entonces las políticas de escritura y queda la de lectura. Que no
-- haya política de escritura ES la política.

drop policy event_serving_records_insert on public.event_serving_records;
drop policy event_serving_records_update on public.event_serving_records;
drop policy event_serving_records_delete on public.event_serving_records;
drop trigger event_serving_records_delete_guard on public.event_serving_records;

drop policy event_serving_items_insert on public.event_serving_items;

-- EL ESPEJO TIENE QUE PODER SEGUIR AL LIBRO MAYOR, Y NO PUEDE MENTIRLE.
--
-- La sección 16 dejó `event_serving_items` append-only entera, y eso incluía
-- las dos columnas que son ESPEJO del libro mayor (`deducted_quantity` y
-- `discarded_quantity`): con ese candado, `serve_event_item` no puede anotar
-- cuánto alcanzó a descontar y el renglón queda diciendo 0 para siempre — un
-- cero que significaría "no salió nada de la despensa" cuando sí salió. Es el
-- UNKNOWN-leído-como-cero de la doctrina, congelado en una columna.
--
-- La corrección no es abrir la tabla: es que el espejo NO SE ESCRIBA A MANO. El
-- trigger deja pasar el UPDATE únicamente si toca esas dos columnas, y les pone
-- el valor que el libro mayor tiene EN ESE INSTANTE, ignorando el número que
-- venga. Un RPC futuro que quiera inflar lo descontado escribe lo que quiera y
-- termina guardando la verdad.
create or replace function app.event_serving_item_is_history()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_sacado numeric;
  v_botado numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'esta tabla es historia: se agregan filas, no se corrigen las que ya están'
      using errcode = 'check_violation';
  end if;

  if new.record_id is distinct from old.record_id
     or new.menu_item_id is distinct from old.menu_item_id
     or new.ingredient_id is distinct from old.ingredient_id
     or new.product_id is distinct from old.product_id
     or new.label is distinct from old.label
     or new.served_quantity is distinct from old.served_quantity
     or new.served_unit is distinct from old.served_unit
     or new.served_weight_basis is distinct from old.served_weight_basis
     or new.dedupe_key is distinct from old.dedupe_key
     or new.created_at is distinct from old.created_at then
    raise exception
      'lo que salió a la mesa es historia: se corrige sirviendo de nuevo, no editando el renglón'
      using errcode = 'check_violation';
  end if;

  -- LO ANULADO NO REVIVE. Anular devolvió gramos al lote con un ajuste de
  -- despensa; volver a poner el renglón en ACTIVE los descontaría de nuevo sin
  -- que nadie sirviera nada. Si esa comida sí salió, se sirve otra vez.
  if old.status = 'VOIDED' and new.status <> 'VOIDED' then
    raise exception 'un servido anulado no vuelve a estar vigente: sírvelo de nuevo'
      using errcode = 'check_violation';
  end if;

  select
    coalesce(sum(-m.covers_quantity) filter (where m.reason = 'CONSUMED'), 0),
    coalesce(sum(-m.covers_quantity) filter (where m.reason = 'DISCARDED_LEFTOVER'), 0)
  into v_sacado, v_botado
  from public.inventory_movements m
  where m.event_serving_item_id = old.id;

  new.deducted_quantity := greatest(v_sacado, 0);
  new.discarded_quantity := greatest(v_botado, 0);
  return new;
end;
$$;

drop trigger event_serving_items_append_only on public.event_serving_items;
create trigger event_serving_items_is_history
  before update or delete on public.event_serving_items
  for each row execute function app.event_serving_item_is_history();

drop policy event_consumption_estimates_insert on public.event_consumption_estimates;
drop policy event_consumption_estimates_update on public.event_consumption_estimates;
drop policy event_consumption_estimates_delete on public.event_consumption_estimates;
drop trigger event_consumption_estimates_delete_guard on public.event_consumption_estimates;

-- El balance de masa también es historia: se supera con una fila nueva, no se
-- corrige encima. Quien lee toma la última por corte.
create trigger event_consumption_estimates_append_only
  before update or delete on public.event_consumption_estimates
  for each row execute function app.append_only_guard();

alter table public.event_participant_observations enable row level security;
create policy event_participant_observations_select on public.event_participant_observations
  for select to authenticated
  using (app.is_household_member(app.event_household(event_id)));
-- Sin políticas de escritura: la única puerta es `record_event_guest_observation`.

comment on table public.event_serving_records is
  'Lo que salió a la mesa en un evento, del HOGAR y no de una persona (§48). '
  'Se escribe SOLO por serve_event_item, que descuenta por el libro mayor: una '
  'fila acá sin movimiento detrás sería un servido inventado.';

-- ---------------------------------------------------------------------------
-- 20. EL RELEVO NO DEPENDE DEL ORDEN EN QUE PASARON LAS COSAS
-- ---------------------------------------------------------------------------
--
-- La sección 14 releva la comida del plan cuando el evento se confirma: recorre
-- los slots QUE EXISTEN EN ESE MOMENTO y los marca. Eso cubre el orden que uno
-- se imagina —el plan primero, el asado después— y ningún otro.
--
-- Los órdenes que una familia recorre de verdad son otros, y cada uno deja
-- abierta la puerta al mismo daño: se compra el almuerzo Y la carne.
--
--   [A] Se confirma el asado del sábado y RECIÉN DESPUÉS se escribe el almuerzo
--       de ese sábado. El slot nace sin `event_id`, la porción nace sin relevar,
--       y la lista del súper pide las dos cosas.
--   [C] Igual que [A], pero después de mover el evento al domingo.
--   [B] Dos eventos el mismo día y la misma comida: cancelar uno soltaba el
--       relevo del slot aunque el otro siguiera en pie, y el almuerzo volvía a
--       la lista con un asado todavía confirmado encima.
--
-- La raíz es una sola y es de DIRECCIÓN: se sabía ir del EVENTO a sus slots y
-- no del SLOT a su evento. Todo lo que naciera —o quedara— del lado del slot
-- después del recorrido se perdía.
--
-- Acá se declara la pregunta que faltaba, UNA SOLA VEZ, y las dos correcciones
-- la usan. Que sea la misma función es el punto: si mañana cambia qué evento
-- releva (otro estado, otra regla de asistencia), cambia en un lugar y las dos
-- puertas se mueven juntas. Dos copias de esta regla son exactamente cómo nace
-- el próximo "se compró dos veces".

/**
 * ¿Qué evento releva la comida de este slot? NULL si ninguno.
 *
 * Las condiciones son las mismas que aplica `apply_event_meal_coverage`, no una
 * lectura parecida: evento CONFIRMED o IN_PROGRESS, con la comida declarada, con
 * al menos una persona del hogar que no dijo que no, y cuyo rango de fechas
 * incluye el día.
 *
 * `p_excepto` existe para la cancelación: pregunta "sacando a éste, ¿queda
 * alguno?". Sin ese parámetro habría que consultar después de escribir, y entre
 * las dos cosas cabe justo el estado en que el almuerzo ya volvió a la lista.
 *
 * Si hubiera dos, gana el más antiguo (`created_at`, con el id de desempate):
 * es determinista y no depende del orden en que Postgres devuelva las filas. Cuál
 * gane da lo mismo mientras SEA UNO — lo que no puede pasar es que el slot quede
 * sin relevar teniendo dos eventos encima.
 */
create or replace function app.event_covering_slot(
  p_household uuid,
  p_fecha     date,
  p_comida    public.meal_type,
  p_excepto   uuid default null
) returns uuid language sql stable security definer set search_path = public as $cover$
  select e.id
    from public.nutrition_events e
   where e.household_id = p_household
     and e.meal_type    = p_comida
     and e.status in ('CONFIRMED', 'IN_PROGRESS')
     and (p_excepto is null or e.id <> p_excepto)
     and p_fecha between e.event_date and coalesce(e.end_date, e.event_date)
     and exists (
           select 1 from public.event_participants ep
            where ep.event_id = e.id
              and ep.participant_type = 'HOUSEHOLD_MEMBER'
              and ep.attendance_status not in ('DECLINED', 'NO_SHOW')
         )
   order by e.created_at, e.id
   limit 1
$cover$;

comment on function app.event_covering_slot(uuid, date, public.meal_type, uuid) is
  'El evento que releva la comida de un slot, o NULL. Dueno unico de esa '
  'pregunta: la usan el trigger que hereda el relevo en las comidas nuevas y la '
  'liberacion, para que nunca puedan discrepar sobre que releva y que no.';

/**
 * Una comida que nace dentro de un evento ya confirmado, nace relevada.
 *
 * Gemelo exacto de `servings_inherit_event_coverage` un piso más arriba. Aquél
 * hace que una PORCIÓN nueva herede el relevo de su slot; éste hace que un SLOT
 * nuevo herede el relevo de su día. Los dos juntos cierran [A] y [C]: el almuerzo
 * escrito después del asado nace con `event_id`, la porción que cuelga de él nace
 * con `covered_by_event_id`, y la lista del súper no lo pide.
 *
 * BEFORE INSERT para escribir en el propio NEW, sin un UPDATE de la tabla desde
 * su propio trigger.
 *
 * Un `event_id` que ya viene puesto NO se pisa: quien lo escribió sabía algo que
 * acá no se sabe.
 */
create or replace function app.meal_inherits_event_coverage()
returns trigger language plpgsql security definer set search_path = public as $heredar$
declare
  v_household uuid;
  v_fecha     date;
begin
  if new.event_id is not null then return new; end if;

  select w.household_id, d.plan_date into v_household, v_fecha
    from public.weekly_plan_days d
    join public.weekly_plans w on w.id = d.plan_id
   where d.id = new.day_id;

  -- ERROR != VACIO: si el slot no cuelga de ningun plan, no se inventa relevo.
  if v_household is null then return new; end if;

  new.event_id := app.event_covering_slot(v_household, v_fecha, new.meal_type);
  return new;
end;
$heredar$;

drop trigger if exists meals_inherit_event_coverage on public.meal_assignments;
create trigger meals_inherit_event_coverage
  before insert on public.meal_assignments
  for each row execute function app.meal_inherits_event_coverage();

comment on function app.meal_inherits_event_coverage() is
  'Una comida escrita DESPUES de que el asado se confirmo nace ya relevada. Sin '
  'esto, el relevo solo alcanzaba a los slots que existian en el momento de '
  'confirmar, y el orden en que la familia escribe las cosas decidia si se '
  'compraba dos veces.';

/**
 * Soltar el relevo de UN evento no puede soltar el del otro.
 *
 * La versión anterior ponía `null` y listo. Con dos asados el mismo sábado a la
 * misma hora —que pasa: se planean dos y se cae uno—, cancelar el primero
 * devolvía el almuerzo a la lista con el segundo todavía confirmado. La familia
 * compraba el almuerzo Y la carne: el mismo defecto que este sprint vino a
 * cerrar, entrando por otra puerta.
 *
 * Ahora la marca no se BORRA: se RECALCULA. Se le pregunta a
 * `app.event_covering_slot` quién releva ese slot sin contar al que se va, y se
 * escribe eso — que muchas veces es NULL, y ahí el comportamiento es idéntico al
 * de antes. La diferencia está justo en el caso que fallaba.
 *
 * Sigue soltándose sólo lo que todavía es plan: una porción SERVED o CONSUMED
 * ocurrió de verdad y su marca es historia.
 */
create or replace function app.release_event_meal_coverage(p_event uuid)
returns int language plpgsql security definer set search_path = public as $liberar$
declare
  v_liberadas int;
begin
  -- Primero los SLOTS: cada uno pasa al evento que quede, o a NULL si no queda
  -- ninguno. Va antes que las porciones porque de ahí las lee el paso siguiente.
  update public.meal_assignments a
     set event_id = app.event_covering_slot(w.household_id, d.plan_date, a.meal_type, p_event)
    from public.weekly_plan_days d
    join public.weekly_plans w on w.id = d.plan_id
   where a.day_id = d.id
     and a.event_id = p_event
     and a.status <> 'SERVED';

  -- Y las PORCIONES, cada una al evento que ahora releva su slot. Se lee de la
  -- asignación recién actualizada para que las dos capas no puedan discrepar.
  with sueltas as (
    update public.member_serving_projections p
       set covered_by_event_id = a.event_id
      from public.meal_assignments a
     where a.id = p.assignment_id
       and p.covered_by_event_id = p_event
       and p.status = 'PLANNED'
    returning p.id, a.event_id as quedo
  )
  select count(*) filter (where quedo is null) into v_liberadas from sueltas;

  -- Las porciones sin asignación (o cuyo slot ya se sirvió) se sueltan igual: su
  -- evento se fue y no hay slot del que puedan heredar otro.
  update public.member_serving_projections p
     set covered_by_event_id = null
   where p.covered_by_event_id = p_event
     and p.status = 'PLANNED';

  return v_liberadas;
end;
$liberar$;

comment on function app.release_event_meal_coverage(uuid) is
  'Suelta el relevo de UN evento RECALCULANDO, no borrando: si otro evento '
  'confirmado sigue cubriendo ese slot, el relevo pasa a el. Borrar a secas '
  'devolvia el almuerzo a la lista con un asado todavia en pie. Devuelve cuantas '
  'porciones quedaron de verdad sin relevo, no cuantas se tocaron.';
