-- 0059 — Borrar un padre no puede morir por el guardián de sus hijos.
--
-- CINCO funciones aplicadas por la 0039 y la 0041 se disparan en DELETE y, para
-- decidir, miran al PADRE de la fila: `app.plan_household(plan_id)`,
-- `app.day_household(day_id)`, `app.event_household(event_id)`, un
-- `select * into v_evento from nutrition_events`, o un `exists` sobre la tabla
-- hermana. Y las FK de todas esas tablas son `on delete cascade`.
--
-- En una cascada Postgres borra PRIMERO al padre y recién después dispara el
-- DELETE de los hijos. Cuando el guardián del hijo corre, el padre ya no está:
-- la función devuelve NULL y el guardián —correctamente diseñado para NO abrir
-- la puerta ante la duda— aborta la transacción entera. Resultado, desde que las
-- 19 llegaron a producción el 2026-09-02:
--
--   · borrar un DÍA del plan con comidas adentro: imposible
--   · borrar una SEMANA: imposible
--   · borrar un HOGAR: imposible
--   · borrar un evento en BORRADOR con un solo invitado (`deleteEvent` en
--     web/src/app/plan/actions.ts): imposible
--
-- Para todo el mundo, incluido quien tiene todos los permisos. Sobre una base
-- vacía no se ve —sin un día con comidas el trigger nunca llega a dispararse—,
-- y por eso 2249 pruebas y dos ensayos de despliegue no lo vieron. Lo encontró
-- el pre-vuelo adversarial, y los tres escépticos lo reprodujeron.
--
-- EL ARREGLO ES EL QUE EL REPO YA USA. `pg_trigger_depth() > 1` es la marca de
-- "esto viene de una cascada, no del cliente": lo usan app.ledger_is_append_only
-- (0011:277), la 0036, la 0038, la 0040, la 0044 y la 0048, todas con el mismo
-- razonamiento. Un DELETE en cascada no lo inició nadie sobre el hijo: lo inició
-- alguien sobre el padre, y el padre tiene su propio guardián y su propia RLS.
-- Si esa puerta se abrió, la de abajo no tiene nada que volver a preguntar.
--
-- Lo que NO cambia: un DELETE directo (depth 1) sigue pasando por el guardián
-- entero. Quien no puede editar el plan sigue sin poder borrar una comida.
-- web/src/integration/borrado-en-cascada.test.ts afirma las dos cosas.
--
-- Cada función se copia ENTERA de su migración de origen y se le agrega UNA
-- línea después del `begin`. No se reescribe nada más a propósito: reescribir
-- es la oportunidad de perder una rama que nadie va a echar de menos hasta que
-- haga falta.

-- ---------------------------------------------------------------------------
-- app.exigir_can_edit_plan
-- Resuelve el hogar mirando HACIA ARRIBA (plan_household / day_household). En la cascada el padre ya no esta: NULL -> 'no se borra a ciegas'. Borrar un dia o una semana quedaba imposible.
-- ---------------------------------------------------------------------------

create or replace function app.exigir_can_edit_plan()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_fila jsonb := to_jsonb(old);
  v_hogar uuid;
begin
  -- CASCADA: el padre ya se borro y SU guardian ya autorizo. Ver la cabecera.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  -- SE LEE POR JSONB Y NO CON `old.household_id`, y no es preferencia de
  -- estilo: plpgsql prepara la expresión ENTERA antes de ejecutarla, así que
  -- una rama del CASE que nombra un campo inexistente revienta aunque no se
  -- tome. La primera versión de este trigger mataba TODO borrado con
  -- "record old has no field household_id", incluido el de quien sí tenía
  -- permiso. `to_jsonb` no tiene ese problema: el campo ausente es null.
  v_hogar := case tg_table_name
    when 'weekly_plans'     then (v_fila->>'household_id')::uuid
    when 'weekly_plan_days' then app.plan_household((v_fila->>'plan_id')::uuid)
    when 'meal_assignments' then app.day_household((v_fila->>'day_id')::uuid)
    when 'nutrition_events' then (v_fila->>'household_id')::uuid
  end;

  -- Si no se puede resolver el hogar, NO se deja pasar. Un guardián que ante la
  -- duda abre la puerta no es un guardián.
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

-- ---------------------------------------------------------------------------
-- app.exigir_can_edit_evento
-- Mismo molde sobre lo que cuelga de nutrition_events (event_household). Borrar un evento en borrador con un invitado quedaba imposible.
-- ---------------------------------------------------------------------------

create or replace function app.exigir_can_edit_evento()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_fila jsonb := to_jsonb(old);
  v_hogar uuid;
begin
  -- CASCADA: el padre ya se borro y SU guardian ya autorizo. Ver la cabecera.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
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

-- ---------------------------------------------------------------------------
-- app.event_children_history_guard
-- Hace `select * into v_evento` del padre; en la cascada no lo encuentra y levanta 'no se pudo determinar el evento'. Tercera puerta del mismo bug.
-- ---------------------------------------------------------------------------

create or replace function app.event_children_history_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event uuid;
  v_evento public.nutrition_events;
  v_cierre timestamptz;
  v_dentro boolean;
begin
  -- CASCADA: el padre ya se borro y SU guardian ya autorizo. Ver la cabecera.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
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

-- ---------------------------------------------------------------------------
-- app.event_roster_is_the_owner
-- En DELETE de nutrition_event_members comprueba que event_participants este vacio. Dentro de la cascada del evento el orden entre las dos tablas no esta garantizado, asi que a veces levanta 'agrega o saca a la persona ahi, no aca' sobre un evento que se esta destruyendo.
-- ---------------------------------------------------------------------------

create or replace function app.event_roster_is_the_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event uuid := coalesce(new.event_id, old.event_id);
begin
  -- CASCADA: el padre ya se borro y SU guardian ya autorizo. Ver la cabecera.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
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

-- ---------------------------------------------------------------------------
-- app.event_participants_sync_members
-- AFTER DELETE: re-sincroniza el roster y recalcula la cobertura de un evento que ya no existe. Trabajo inutil en el mejor caso; en el peor, escribe filas hijas de un padre muerto.
-- ---------------------------------------------------------------------------

create or replace function app.event_participants_sync_members()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event uuid := coalesce(new.event_id, old.event_id);
  v_household uuid;
begin
  -- CASCADA: el padre ya se borro y SU guardian ya autorizo. Ver la cabecera.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
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
