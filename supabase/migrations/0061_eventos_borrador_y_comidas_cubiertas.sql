-- 0061 — Cierre v1 · EVENTOS: el borrador que SÍ se puede borrar, y las
-- comidas que el evento cubre DICHAS, no adivinadas.
--
-- No es un sprint nuevo. Son dos defectos que quedaron vivos después de la 0041
-- y que se pagan en la casa, no en la consola.
--
-- ===========================================================================
-- LOS DOS DEFECTOS
-- ===========================================================================
--
--  [E1 · BLOQUEANTE] NINGÚN EVENTO SE PUEDE BORRAR NUNCA.
--      La 0041 escribió dos reglas correctas por separado que juntas cierran la
--      puerta:
--        · `nutrition_events.status` nace en 'PLANNED' (0041:150), porque las
--          filas históricas del calendario eran eso.
--        · `app.event_history_guard` sólo permite el DELETE físico en 'DRAFT'
--          (0041:551), porque un evento con compras hechas no puede evaporarse.
--      Ningún escritor de la aplicación mandaba `status` —`saveEvent` de
--      /plan sigue sin mandarlo (web/src/app/plan/actions.ts:640)—, así que todo
--      evento nacía PLANNED y el botón "borrar evento" de /plan contestaba
--      "este evento ya salió del borrador" para un evento que se acababa de
--      crear por error. El único evento de la base real de la familia está así
--      HOY: no se puede sacar de ninguna manera.
--      Y hay una segunda cara peor: el rollback de `saveEvent` (plan/actions.ts
--      :670) borra el evento cuando no pudo guardar a quiénes afecta. Ese
--      DELETE también rebotaba, y el mensaje que quedaba en pantalla era
--      "bórralo a mano desde el plan" — a mano tampoco se podía.
--      Se arregla acá: el default pasa a 'DRAFT' y el borrador se puede borrar
--      DE VERDAD, pero sólo mientras no haya dejado efectos. Sección 1 y 6.
--
--  [E2 · ALTO] EL ASADO DE NUEVE HORAS RELEVA UNA SOLA COMIDA.
--      `nutrition_events.meal_type` es UNA comida, y las tres funciones de
--      relevo (§20 de la 0041) preguntan por esa única. Un asado que empieza a
--      la una y termina de noche da almuerzo Y cena, pero el plan sólo suelta
--      el almuerzo: esa noche la familia compra —y cocina— una cena que nadie
--      va a comer. El caso [F] de sprint13-compra-doble-ataque.test.ts lo dejó
--      escrito y sin cerrar, con la pregunta de producto anotada al lado.
--      La respuesta NO es deducirlo de `duration_hours`. Una heurística de
--      duración inventa un hecho que nadie declaró, y de los dos errores
--      posibles el caro es el que deja a alguien sin comer: si el sistema
--      adivina "cubre la cena" y se equivoca, esa noche no hay comida y no hay
--      cómo deshacerlo a las nueve. Se PREGUNTA y se GUARDA. Secciones 3 a 5.
--
-- ===========================================================================
-- LO QUE ESTA MIGRACIÓN NO HACE, DECLARADO
-- ===========================================================================
--
--  (a) NO reescribe el estado de ningún evento existente. El default nuevo rige
--      para los que nazcan de acá en adelante. Los que ya están PLANNED se
--      quedan PLANNED: nadie los puso en borrador y ponerlos ahora sería
--      inventar que alguna vez lo fueron. El de producción sigue sin poder
--      borrarse, y eso es correcto — su salida es CANCELLED, que conserva todo.
--
--  (b) NO crea un segundo motor de eventos. `event_covered_meals` no compite
--      con `nutrition_events.meal_type`: lo REEMPLAZA como dueño y deja a
--      `meal_type` como espejo derivado. Sección 4 explica por qué el espejo se
--      queda en vez de borrarse.
--
--  (c) NO toca las porciones SERVED ni CONSUMED. Declarar que el asado también
--      cubría la cena cambia lo que falta comprar; no cambia lo que ya se comió.

-- ---------------------------------------------------------------------------
-- 1. [E1] EL EVENTO NACE EN BORRADOR
-- ---------------------------------------------------------------------------
--
-- Un solo ALTER, sin UPDATE detrás. El comentario de la 0041 sobre esta columna
-- decía "las filas históricas quedan PLANNED: es lo que un evento del
-- calendario significaba hasta hoy" — sigue siendo verdad para ESAS filas, y
-- por eso no se tocan. Lo que cambia es qué significa un evento RECIÉN CREADO:
-- desde acá es un borrador hasta que alguien diga lo contrario.

alter table public.nutrition_events alter column status set default 'DRAFT';

comment on column public.nutrition_events.status is
  'DRAFT/PLANNED/CONFIRMED/IN_PROGRESS/COMPLETED/CANCELLED. Nace en DRAFT '
  '(0061): antes nacía PLANNED y ningún evento se podía borrar jamás, ni '
  'siquiera el creado por error hace diez segundos. Los eventos anteriores a la '
  '0061 conservan el PLANNED con el que se escribieron — no se reescribe '
  'historia para arreglar un default. COMPLETED y CANCELLED son terminales.';

-- ---------------------------------------------------------------------------
-- 2. EL CICLO DE VIDA, VERIFICADO Y NO REESCRITO
-- ---------------------------------------------------------------------------
--
-- DRAFT → PLANNED → CONFIRMED → IN_PROGRESS → COMPLETED / CANCELLED.
--
-- `app.event_status_transition_guard` (0041:1012) YA tiene la tabla completa,
-- DRAFT→PLANNED incluido. No se vuelve a escribir: reemplazar una función que
-- funciona para "dejarla declarada acá" es la forma más común de perder una
-- rama sin que nadie lo note. Lo que sí se hace es dejar el ciclo escrito en el
-- comentario de la función —para que la próxima persona no tenga que
-- reconstruirlo leyendo un CASE— y probarlo por mutación en
-- web/src/integration/cierre-eventos.test.ts.

comment on function app.event_status_transition_guard() is
  'El ciclo de vida del evento, en un solo lugar: DRAFT→(PLANNED|CANCELLED); '
  'PLANNED→(DRAFT|CONFIRMED|CANCELLED); CONFIRMED→(PLANNED|IN_PROGRESS|'
  'COMPLETED|CANCELLED); IN_PROGRESS→(COMPLETED|CANCELLED). COMPLETED y '
  'CANCELLED no salen: un evento que ocurrió no vuelve a planificarse, se '
  'duplica. Verificado por la 0061, no reescrito.';

-- ---------------------------------------------------------------------------
-- 3. [E2] LAS COMIDAS QUE EL EVENTO CUBRE, ESCRITAS
-- ---------------------------------------------------------------------------
--
-- Una tabla y no un array en `nutrition_events` a propósito: la pregunta
-- "¿quién releva el almuerzo del sábado?" la hace `app.event_covering_slot` una
-- vez por slot, y con una tabla es un índice; con un array es un unnest por
-- fila. Además la PK compuesta hace la idempotencia gratis — dos clics en la
-- misma casilla dan UNA fila, no dos, sin que nadie tenga que acordarse.
--
-- No lleva `household_id`: el hogar se resuelve por `app.event_household`, que
-- es el mismo camino que usan las otras siete tablas colgadas del evento. Un
-- segundo household_id acá sería un segundo dueño del mismo hecho y podría
-- discrepar del del evento.

create table public.event_covered_meals (
  event_id   uuid not null references public.nutrition_events (id) on delete cascade,
  meal_type  public.meal_type not null,
  created_at timestamptz not null default now(),
  primary key (event_id, meal_type)
);

-- Para `app.event_covering_slot`, que entra por (comida, evento) y no por la PK.
create index event_covered_meals_meal_idx on public.event_covered_meals (meal_type, event_id);

comment on table public.event_covered_meals is
  'Qué comidas del plan cubre este evento. Es el DUEÑO del hecho: '
  'nutrition_events.meal_type quedó como espejo de la primera (ver sección 4). '
  'Sin heurística de duración: un asado cubre la cena porque alguien lo dijo, '
  'nunca porque duró nueve horas. Adivinarlo de menos hace comprar dos veces; '
  'adivinarlo de más deja a la familia sin cena, y eso no se deshace a las nueve.';

-- BACKFILL. Va ANTES de crear los triggers de esta sección a propósito: los
-- triggers sincronizan el espejo, y sobre las filas que el espejo YA describe
-- no tendrían nada que hacer más que trabajo redundante por cada evento de la
-- base. `meal_type is not null` es la traducción exacta de la semántica vieja:
-- NULL era "no se sabe qué comida cubre" y sigue siendo el conjunto vacío.
insert into public.event_covered_meals (event_id, meal_type)
select e.id, e.meal_type
  from public.nutrition_events e
 where e.meal_type is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3-bis. El candado de historia y de permisos, con el molde de la 0041
-- ---------------------------------------------------------------------------

alter table public.event_covered_meals enable row level security;

create policy event_covered_meals_select on public.event_covered_meals
  for select to authenticated
  using (app.is_household_member(app.event_household(event_id)));

create policy event_covered_meals_insert on public.event_covered_meals
  for insert to authenticated
  with check (app.can_edit_plan(app.event_household(event_id)));

create policy event_covered_meals_delete on public.event_covered_meals
  for delete to authenticated
  using (app.is_household_member(app.event_household(event_id)));

-- Sin política de UPDATE, y no es un olvido: la fila ENTERA es la clave. Cambiar
-- "cubre el almuerzo" por "cubre la cena" es sacar una comida y poner otra, dos
-- hechos distintos que el relevo tiene que ver por separado. Un UPDATE los
-- fundiría en uno y el trigger de abajo lo rechaza con esas palabras.

create trigger event_covered_meals_delete_guard
  before delete on public.event_covered_meals
  for each row execute function app.exigir_can_edit_evento();

create or replace function app.event_covered_meals_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event  uuid;
  v_estado public.event_status;
begin
  if tg_op = 'UPDATE' then
    raise exception
      'una comida cubierta no se edita: saca la que sobra y agrega la que falta'
      using errcode = 'check_violation';
  end if;

  -- CASCADA: el evento ya se está borrando y SU guardián ya autorizó. Sin este
  -- escape, borrar un borrador con comidas declaradas moría acá (mismo tropiezo
  -- que la 0059 arregló en app.exigir_can_edit_evento y en el dueño del roster).
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;

  -- Se pregunta por la operación antes de tocar el registro: en un trigger de
  -- DELETE `new` no está asignado (0041:625).
  if tg_op = 'DELETE' then v_event := old.event_id; else v_event := new.event_id; end if;

  select status into v_estado from public.nutrition_events where id = v_event;

  -- Un guardián que ante la duda abre la puerta no es un guardián (0039:365).
  if v_estado is null then
    raise exception
      'no se pudo determinar el evento de esta comida cubierta: no se escribe a ciegas'
      using errcode = 'check_violation';
  end if;

  if v_estado in ('COMPLETED', 'CANCELLED') then
    raise exception
      'este evento ya está cerrado: las comidas que cubrió son historia y no se reescriben'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger event_covered_meals_guard
  before insert or update or delete on public.event_covered_meals
  for each row execute function app.event_covered_meals_guard();

-- ---------------------------------------------------------------------------
-- 4. UN SOLO DUEÑO: el conjunto manda, `meal_type` es su espejo
-- ---------------------------------------------------------------------------
--
-- LA DECISIÓN, ESCRITA: `nutrition_events.meal_type` SE QUEDA, como PRIMERA
-- COMIDA CUBIERTA y DERIVADA. No se borra la columna y no se deja como segundo
-- dueño. Las tres razones:
--
--   1. La leen sitios que esta migración no puede tocar sin abrir el sprint
--      entero: `loadEventsForDate` y la semana de /plan la piden por nombre en
--      el select, `event_covered_demand` la expone, el armador la escribe.
--      Borrarla obligaría a tocar todos esos lectores en el mismo cambio.
--   2. Es la respuesta corta a "¿qué comida es este evento?", que es la que un
--      chip de pantalla necesita. Derivarla en cada lector sería repetir la
--      misma regla de orden en seis lugares.
--   3. Mientras exista y sea escribible, hay UN camino viejo que la escribe
--      (`guardarConfiguracion`, los seeds, los tests). Matar al escritor viejo
--      en el mismo cambio no significa prohibirle escribir: significa que su
--      escritura DEJE DE SER una segunda verdad. Acá se traduce — escribir
--      `meal_type` es DECLARAR el conjunto, y el conjunto contesta.
--
-- El orden "primera" es el del enum `public.meal_type`, que ya está en orden de
-- día (BREAKFAST, LUNCH, TEA, DINNER, DESSERT, SNACK, OTHER; 0003:12). No se
-- inventa una tabla de orden nueva.

create or replace function app.event_first_covered_meal(p_event uuid)
returns public.meal_type language sql stable security definer set search_path = public as $$
  select meal_type
    from public.event_covered_meals
   where event_id = p_event
   order by meal_type
   limit 1
$$;

comment on function app.event_first_covered_meal(uuid) is
  'La primera comida del día que el evento cubre, o NULL si no cubre ninguna. '
  'Ordena por el enum meal_type, que ya está en orden de día. Es la fuente del '
  'espejo nutrition_events.meal_type: si esta función y la columna discrepan, '
  'la función tiene razón.';

/**
 * El espejo se pone al día, y el relevo se recalcula.
 *
 * La bandera se identifica por el ID DEL EVENTO y no por un booleano, igual que
 * `app.event_roster_sync` (0041:421): una bandera olvidada por otra transacción
 * no puede abrirle la puerta a ésta.
 *
 * El recálculo va SIEMPRE, incluso cuando el espejo no cambió, y ese es el
 * punto entero de esta función. Pasar de {ALMUERZO} a {ALMUERZO, CENA} deja
 * `meal_type` en 'LUNCH': el trigger `zz_nutrition_events_plan_moved` (0041)
 * no ve ningún cambio y no mueve nada, y la cena se seguiría comprando con el
 * asado encima. El relevo tiene que colgar del CONJUNTO, no del espejo.
 */
create or replace function app.sync_event_meal_mirror(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_evento    public.nutrition_events;
  v_primera   public.meal_type;
  v_cobertura jsonb;
  v_liberadas int;
begin
  select * into v_evento from public.nutrition_events where id = p_event;
  -- El evento se está borrando y sus comidas cayeron con él: no hay espejo que
  -- poner al día ni relevo que recalcular. ERROR != VACÍO — acá no hay error.
  if v_evento.id is null then return; end if;

  v_primera := app.event_first_covered_meal(p_event);

  if v_evento.meal_type is distinct from v_primera then
    perform set_config('app.event_meals_sync', p_event::text, true);
    update public.nutrition_events set meal_type = v_primera where id = p_event;
    perform set_config('app.event_meals_sync', '', true);
  end if;

  -- Antes de CONFIRMED el evento no releva nada (0041, sección 8) y declarar
  -- una comida más no puede empezar a relevar por su cuenta: hasta que se
  -- confirme, esa comida SIGUE en la lista de compras, que es lo correcto
  -- porque el asado todavía puede no ocurrir.
  if v_evento.status not in ('CONFIRMED', 'IN_PROGRESS') then return; end if;

  v_liberadas := app.release_event_meal_coverage(p_event);
  v_cobertura := app.apply_event_meal_coverage(p_event);

  -- Queda escrito CON EL MOTIVO: si el conjunto quedó vacío, el relevo nuevo es
  -- cero y eso NO es lo mismo que "no pasó nada". La diferencia es la que
  -- decide si alguien vuelve a comprar ese almuerzo.
  insert into public.audit_events
    (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
  values (v_evento.household_id, auth.uid(), 'EVENT_COVERED_MEALS_CHANGED',
          'nutrition_event', p_event,
          jsonb_build_object(
            'comidas', coalesce(
              (select jsonb_agg(m.meal_type order by m.meal_type)
                 from public.event_covered_meals m where m.event_id = p_event),
              '[]'::jsonb),
            'porciones_liberadas', v_liberadas,
            'cobertura', v_cobertura));
end;
$$;

comment on function app.sync_event_meal_mirror(uuid) is
  'Pone al día el espejo nutrition_events.meal_type y RECALCULA el relevo. El '
  'recálculo va aunque el espejo no cambie: agregar la cena a un asado que ya '
  'cubría el almuerzo deja el espejo igual, y sin esto esa cena se seguía '
  'comprando.';

create or replace function app.event_covered_meals_effects()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event uuid;
begin
  if tg_op = 'DELETE' then v_event := old.event_id; else v_event := new.event_id; end if;

  -- El espejo está escribiendo: ya sabe lo que hizo y volver a sincronizar
  -- desde acá sería la recursión.
  if nullif(current_setting('app.event_meals_sync', true), '') = v_event::text then
    return coalesce(new, old);
  end if;

  -- CASCADA: el evento ya no está. Ver el escape gemelo del guardián.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;

  perform app.sync_event_meal_mirror(v_event);
  return coalesce(new, old);
end;
$$;

create trigger zz_event_covered_meals_effects
  after insert or delete on public.event_covered_meals
  for each row execute function app.event_covered_meals_effects();

/**
 * EL ESCRITOR VIEJO, TRADUCIDO.
 *
 * `guardarConfiguracion`, `crearEvento`, `saveEvent`, los seeds y una decena de
 * tests escriben `nutrition_events.meal_type`. Prohibírselo rompería todo eso
 * de golpe; dejarlo como estaba dejaría dos verdades sobre el mismo hecho. La
 * salida es la tercera: su escritura se acepta como una DECLARACIÓN sobre el
 * conjunto, y el conjunto es el que después contesta.
 *
 * Las tres reglas, y por qué:
 *
 *   meal_type := NULL  →  el conjunto se vacía. Es la semántica de siempre:
 *     "no sabemos qué comida cubre" nunca fue "las cubre todas", y el test de
 *     la 0041 que retira la llave y espera que el almuerzo vuelva a la lista
 *     mide exactamente esto.
 *
 *   meal_type := X, con X YA en el conjunto  →  no pasa nada. El escritor sólo
 *     está repitiendo el espejo (es lo que hace la propia sincronización, y lo
 *     que hace un formulario que reenvía el valor que ya tenía).
 *
 *   meal_type := X, con X FUERA del conjunto  →  el conjunto pasa a ser {X}, a
 *     secas. Un escritor que sólo conoce UNA comida no puede estar diciendo
 *     "agrega ésta a las que ya había": no sabe que había otras. Dice "la
 *     comida de este evento es X". Se le cree, y la pantalla de comidas
 *     cubiertas —que sí conoce el conjunto— escribe la tabla directamente.
 */
create or replace function app.event_meal_type_declares_coverage()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if nullif(current_setting('app.event_meals_sync', true), '') = new.id::text then
    return null;
  end if;

  if tg_op = 'UPDATE' and new.meal_type is not distinct from old.meal_type then
    return null;
  end if;

  perform set_config('app.event_meals_sync', new.id::text, true);

  if new.meal_type is null then
    delete from public.event_covered_meals where event_id = new.id;
  elsif not exists (
    select 1 from public.event_covered_meals
     where event_id = new.id and meal_type = new.meal_type
  ) then
    delete from public.event_covered_meals where event_id = new.id;
    insert into public.event_covered_meals (event_id, meal_type) values (new.id, new.meal_type);
  end if;

  perform set_config('app.event_meals_sync', '', true);

  -- Y el relevo se recalcula ACÁ, aunque `zz_nutrition_events_plan_moved` haga
  -- lo mismo cuando el espejo cambia. No es duplicación por descuido: los
  -- triggers AFTER de una misma tabla corren en orden alfabético, y si el de la
  -- 0041 corriera ANTES que éste leería el conjunto todavía sin actualizar y
  -- soltaría un relevo que corresponde. Este trigger se llama `zzz_` para
  -- correr último, y además recalcula: así el estado final es el correcto venga
  -- el orden como venga. Recalcular es idempotente y barato.
  if new.status in ('CONFIRMED', 'IN_PROGRESS') then
    perform app.release_event_meal_coverage(new.id);
    perform app.apply_event_meal_coverage(new.id);
  end if;

  return null;
end;
$$;

create trigger zzz_event_meal_type_declares_coverage
  after insert or update of meal_type on public.nutrition_events
  for each row execute function app.event_meal_type_declares_coverage();

comment on function app.event_meal_type_declares_coverage() is
  'Traduce al escritor viejo: quien escribe nutrition_events.meal_type está '
  'declarando el conjunto de comidas cubiertas, no guardando una segunda '
  'verdad. NULL vacía el conjunto; una comida nueva lo reemplaza entero.';

comment on column public.nutrition_events.meal_type is
  'ESPEJO DERIVADO de public.event_covered_meals: la PRIMERA comida cubierta, en '
  'orden de día. Escribirla se acepta y significa "el conjunto es exactamente '
  'esta comida" (NULL: ninguna). Quién releva qué se pregunta SIEMPRE al '
  'conjunto — un evento puede cubrir el almuerzo y la cena, y esta columna sola '
  'sólo sabría del almuerzo.';

-- ---------------------------------------------------------------------------
-- 5. LAS FUNCIONES DE RELEVO ITERAN EL CONJUNTO
-- ---------------------------------------------------------------------------
--
-- Son las mismas tres de la sección 20 de la 0041 y siguen siendo las únicas:
--
--   · `app.apply_event_meal_coverage`  — releva las porciones del evento.
--   · `app.event_covering_slot`        — quién releva ESTE slot (dueño único
--                                        de esa pregunta; lo usan la herencia
--                                        del relevo y la liberación).
--   · `app.release_event_meal_coverage` — suelta el relevo RECALCULANDO.
--
-- La tercera NO se toca y hay que decir por qué: ya trabajaba desde el lado del
-- SLOT (`a.meal_type`, no `e.meal_type`), así que soltar N comidas le sale
-- gratis. Reescribirla "para que quede igual que las otras dos" sería arriesgar
-- el arreglo de los dos asados el mismo día por nada.

create or replace function app.apply_event_meal_coverage(p_event uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_evento    public.nutrition_events;
  v_hasta     date;
  v_slots     int := 0;
  v_porciones int := 0;
  v_roster    int;
  v_comidas   int;
begin
  select * into v_evento from public.nutrition_events where id = p_event;
  if v_evento.id is null then
    raise exception 'evento inexistente' using errcode = 'no_data_found';
  end if;

  select count(*) into v_comidas
    from public.event_covered_meals where event_id = p_event;

  -- SIN COMIDA DECLARADA NO SE RELEVA NADA. Antes se miraba `meal_type`; ahora
  -- se mira el conjunto, que es su dueño. El motivo conserva su nombre
  -- (EVENT_MEAL_TYPE_UNKNOWN) a propósito: es el que quedó escrito en la
  -- auditoría de la base real y en las pruebas del sprint 13, y renombrarlo
  -- partiría en dos la serie histórica sin arreglar nada.
  -- Conjunto vacío = "no sabemos qué comidas cubre", y eso NO es "las cubre
  -- todas": relevar de más deja a la familia sin comprar. UNKNOWN nunca es un
  -- permiso.
  if v_comidas = 0 then
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
  -- el "vacío = todos" que la sección 5 de la 0041 vino a acotar, esta vez con
  -- la compra de por medio.
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
      -- LA LÍNEA DEL SPRINT: era `a.meal_type = v_evento.meal_type`. Un asado de
      -- nueve horas que declara almuerzo Y cena ahora suelta las dos.
      and exists (
        select 1 from public.event_covered_meals m
         where m.event_id = p_event and m.meal_type = a.meal_type
      )
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
  'Releva del plan las porciones que el evento va a cubrir —TODAS las comidas '
  'declaradas en event_covered_meals, no una— y sólo de la gente que va. Sin '
  'comidas declaradas o sin roster no releva nada y lo dice con un motivo: '
  'relevar de menos hace comprar de más, relevar de más deja a alguien sin '
  'comer, y de los dos el segundo no se deshace el sábado a las dos de la tarde.';

create or replace function app.event_covering_slot(
  p_household uuid,
  p_fecha     date,
  p_comida    public.meal_type,
  p_excepto   uuid default null
) returns uuid language sql stable security definer set search_path = public as $cover$
  select e.id
    from public.nutrition_events e
   where e.household_id = p_household
     -- Era `e.meal_type = p_comida`. Ahora se le pregunta al conjunto, que es
     -- el dueño: el asado que declaró almuerzo y cena releva las dos.
     and exists (
           select 1 from public.event_covered_meals m
            where m.event_id = e.id and m.meal_type = p_comida
         )
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
  'liberacion, para que nunca puedan discrepar. Desde la 0061 lee '
  'event_covered_meals y no la columna espejo.';

-- ---------------------------------------------------------------------------
-- 6. [E1] BORRAR EL BORRADOR: sí, mientras no haya dejado nada atrás
-- ---------------------------------------------------------------------------
--
-- "DRAFT se puede borrar" a secas sería cambiar un candado que sobra por un
-- agujero que falta. Un borrador puede haber dejado efectos: se puede confirmar
-- un evento, generar su lista de compras, servir, y devolverlo a DRAFT
-- (CONFIRMED→PLANNED→DRAFT es una transición legal, 0041:1023). Ese borrador ya
-- no es un papel en blanco.
--
-- QUÉ SE MIRÓ PARA DECIDIR "EFECTOS". Todo lo que apunta a nutrition_events,
-- una por una, y qué se decidió de cada una:
--
--   EFECTO — borrar destruiría un hecho del mundo:
--     · shopping_list_items.event_id          (cascade) — se pidió comida.
--     · shopping_lists.event_id               (cascade) — la lista delta del evento.
--     · event_serving_records                 (cascade) — salió comida a la mesa.
--     · event_consumption_estimates           (cascade) — se midió el balance.
--     · event_participant_observations        (cascade) — se observó a alguien.
--     · meal_serving_records.event_id         (set null) — el FoodLog personal
--         que ocurrió dentro del evento. `set null` es peor que cascade acá: el
--         borrado no falla, el registro sobrevive y pierde en silencio de qué
--         evento venía.
--     · member_serving_projections.covered_by_event_id (set null) — sólo
--         cuenta si la porción NO es PLANNED: una SERVED o CONSUMED relevada
--         por este evento es historia, y `set null` la dejaría diciendo que
--         nadie la relevó.
--     · meal_assignments.event_id (set null) — sólo si el slot está SERVED, por
--         lo mismo.
--     · cost_allocations — NO tiene FK al evento. Se llega por
--         inventory_movements.event_serving_item_id → event_serving_items →
--         event_serving_records. Se comprueba por ese camino y no por el conteo
--         de registros de servido: un renglón anulado sin plata asignada no
--         debería trabar un borrado, y una asignación de costos sin registro
--         legible sí. Se preguntan las dos cosas.
--
--   NO ES EFECTO — es intención, y la intención se va con el borrador:
--     · event_participants / guest_profiles — la lista de invitados. Los
--         invitados NO se borran: viven en el hogar (guest_profiles) y sólo cae
--         su participación en este evento.
--     · nutrition_event_members — proyección del roster (0041, sección 5).
--     · event_menu_items — el menú planeado.
--     · event_plan_revisions — las estimaciones congeladas. Son un cálculo
--         SOBRE UN PLAN, no un hecho del mundo: si el plan desaparece sin haber
--         ocurrido, su estimación no describe nada. Congelar existe para que
--         nadie reescriba el número de un evento QUE PASÓ, y este no pasó.
--     · inventory_lots.intended_event_id — NO EXISTE. La 0041 (línea 1837) la
--         sacó y dejó escrito por qué: nadie la escribía nunca. Se nombra acá
--         para que la próxima persona no la busque.
--
-- El error dice CUÁL efecto trabó el borrado, no "no se puede". Un "no se
-- puede" sin sujeto manda a adivinar, y adivinando se termina cancelando un
-- evento que sí se podía borrar, o peor, borrando a mano por SQL.

create or replace function app.event_effects_found(p_event uuid)
returns text[] language sql stable security definer set search_path = public as $efectos$
  select coalesce(array_agg(x.motivo order by x.orden), array[]::text[])
    from (
      select 1 as orden, 'tiene líneas en la lista de compras' as motivo
       where exists (select 1 from public.shopping_list_items i where i.event_id = p_event)
      union all
      select 2, 'tiene su propia lista de compras'
       where exists (select 1 from public.shopping_lists l where l.event_id = p_event)
      union all
      select 3, 'ya sirvió comida'
       where exists (select 1 from public.event_serving_records r where r.event_id = p_event)
      union all
      select 4, 'tiene plata asignada por lo que se sirvió'
       where exists (
         select 1
           from public.cost_allocations c
           join public.inventory_movements mv on mv.id = c.movement_id
           join public.event_serving_items si on si.id = mv.event_serving_item_id
           join public.event_serving_records r on r.id = si.record_id
          where r.event_id = p_event)
      union all
      select 5, 'tiene estimaciones de lo que se consumió'
       where exists (select 1 from public.event_consumption_estimates e where e.event_id = p_event)
      union all
      select 6, 'tiene observaciones anotadas de sus comensales'
       where exists (select 1 from public.event_participant_observations o where o.event_id = p_event)
      union all
      select 7, 'tiene porciones registradas de lo que alguien comió'
       where exists (select 1 from public.meal_serving_records m where m.event_id = p_event)
      union all
      select 8, 'relevó comidas que ya se sirvieron'
       where exists (
         select 1 from public.member_serving_projections p
          where p.covered_by_event_id = p_event and p.status <> 'PLANNED')
      union all
      select 9, 'está pegado a una comida del plan que ya se sirvió'
       where exists (
         select 1 from public.meal_assignments a
          where a.event_id = p_event and a.status = 'SERVED')
    ) x
$efectos$;

comment on function app.event_effects_found(uuid) is
  'Los efectos que este evento dejó en el mundo, en palabras. Vacío = todavía no '
  'dejó ninguno y se puede borrar de verdad. Es la lista que mira el guardián de '
  'historia y la misma que la pantalla puede mostrar antes de ofrecer el botón: '
  'dos lecturas distintas de "sin efectos" serían dos verdades.';

create or replace function app.event_history_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cierre  timestamptz;
  v_efectos text[];
begin
  if tg_op = 'DELETE' then
    -- Borrado físico SÓLO en borrador. Desde PLANNED la única salida es
    -- CANCELLED, que conserva la fila y todo lo que colgaba de ella.
    if old.status <> 'DRAFT' then
      raise exception
        'este evento ya salió del borrador: se cancela, no se borra (su historia queda)'
        using errcode = 'check_violation';
    end if;

    -- Y un borrador tampoco se borra si ya dejó rastro. Esto no estaba: hasta
    -- la 0061 el DELETE en DRAFT era libre, y como ningún evento nacía en DRAFT
    -- eso no se notaba. Con el default nuevo sí se nota, y un borrador que pasó
    -- por CONFIRMED —compró, sirvió— y volvió a DRAFT se llevaba por delante
    -- líneas de compra y registros de servido por FK cascade, en silencio.
    v_efectos := app.event_effects_found(old.id);
    if array_length(v_efectos, 1) is not null then
      raise exception
        'este evento ya dejó rastro (%): cancélalo, no lo borres — borrarlo se llevaría eso también',
        array_to_string(v_efectos, '; ')
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

comment on function app.event_history_guard() is
  'El candado del evento. DELETE sólo en DRAFT Y sin efectos (compras, servidos, '
  'plata asignada, FoodLog, relevos ya servidos): un borrador que pasó por '
  'CONFIRMED y volvió no es un papel en blanco, y borrarlo arrastraba esas filas '
  'por FK cascade sin avisar. Fuera del borrador la salida es CANCELLED. Un '
  'evento cerrado conserva su plan congelado y sólo admite corregir notas dentro '
  'de la ventana.';
