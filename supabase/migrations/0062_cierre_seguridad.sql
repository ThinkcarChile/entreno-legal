-- 0062 — CIERRE DE SEGURIDAD v1 (§48): la puerta de anon y el oráculo de existencia.
--
-- Dos cosas, medidas antes de escribirlas, no supuestas:
--
-- [A] SUPERFICIE ABIERTA A anon. La cadena del repo tiene 269 funciones
--     SECURITY DEFINER entre `public` y `app`, todas con `search_path` fijado
--     (eso ya estaba bien). De ésas, 133 de las 134 de `public` y 129 de las 135
--     de `app` eran EJECUTABLES POR anon — el rol de quien todavía no inició
--     sesión. No porque alguien las abriera: PostgreSQL le da EXECUTE a PUBLIC
--     por defecto a TODA función nueva, y PUBLIC incluye a anon. Es la misma
--     puerta que la 0060 cerró para `purge_assistant_conversations` de a una;
--     ésta la cierra para todas y de una vez.
--
--     ¿Rompe algo? La app NO llama ningún RPC sin sesión. Se verificó por el
--     fuente, no de memoria: las 47 rutas de `web/src/app` están gateadas con
--     `auth.getUser()` + `redirect("/login")` salvo `layout.tsx` y
--     `login/page.tsx`, que no llaman a ningún `.rpc(`; `/api/labels` responde
--     401 sin sesión; `/invite/[token]` y `/q/[token]` redirigen a /login antes
--     de tocar la base; y el login mismo pasa por GoTrue (`auth.signInWithPassword`),
--     que no es un RPC de `public`. Por eso la allowlist de abajo está VACÍA, y
--     eso es un hecho verificable, no una omisión — lo vuelve a comprobar
--     `web/src/integration/cierre-seguridad.test.ts` derivándolo del fuente.
--
--     Lo que NO hace esta migración: tocar `authenticated`. Cada función se
--     re-otorga exactamente al rol que la tenía HOY, así que una sesión de
--     verdad sigue pudiendo todo lo que podía. Cerrar `authenticated` en las
--     funciones de mantenimiento (los `expire_*`, `purge_*`, `*_sweep`) pide un
--     corredor con service_role que este repo todavía no tiene; queda anotado en
--     `docs/qa/security-definer-inventory.md` y no se inventa acá.
--
-- [B] ORÁCULO DE EXISTENCIA. Doce funciones contestaban una cosa cuando el id
--     no existe y otra distinta cuando el id existe pero es de otro hogar:
--
--       'evento inexistente' (no_data_found)   vs 'te falta el permiso' (insufficient_privilege)
--       'ese evento no existe'                 vs 'este evento no es de tu hogar'
--       'versión inexistente'                  vs 'no autorizado'
--       'lista inexistente'                    vs 'no autorizado'
--       'la compra no existe' (check_violation) vs 'no autorizado'
--       'esa presentacion no existe'           vs 'no autorizado'
--       'no hay reserva viva con esa traza'    vs 'no autorizado'
--
--     Comparar los dos mensajes es preguntarle a la base "¿existe este uuid?"
--     desde fuera de la casa. `gate-security.test.ts` ya vigilaba §38 —sin
--     oráculo— para `resolve_lot_token`, `use_lot` y `advance_procurement_order`;
--     estas doce se le escaparon porque nadie las había mirado con esa lupa.
--
--     El arreglo NO es borrar los mensajes útiles. Es preguntar primero
--     "¿pertenezco a este hogar?" —una sola respuesta para las dos formas de no
--     pertenecer— y recién después, ya adentro, decir con nombre y apellido qué
--     rol falta. Quien es de la casa sigue leyendo "te falta el permiso para
--     planificar"; quien no lo es lee 'no autorizado' y nada más.
--
--     Una de las doce no lanzaba ningún error: `apply_clinical_shopping_delta`
--     DEVOLVÍA el `status` de una revisión clínica ajena ya resuelta, sin pasar
--     por ninguna comprobación. Ésa no era un oráculo de existencia: era un dato
--     clínico de otra casa entregado a quien adivine un uuid.
--
--     Los cuerpos de esas doce funciones van copiados LITERALES de
--     `pg_get_functiondef` sobre la cadena aplicada, con el reemplazo hecho por
--     script y verificado (cada fragmento tenía que calzar una vez y solo una).
--     Reescribir de memoria un cuerpo de cien líneas para cambiarle tres es
--     exactamente cómo se pierde una línea sin que nadie lo note.
--
-- IDEMPOTENTE: el bloque [A] recalcula desde el catálogo y vuelve a dejar el
-- mismo estado; las doce funciones son `create or replace`.

-- ---------------------------------------------------------------------------
-- [A] anon y PUBLIC pierden el EXECUTE sobre toda SECURITY DEFINER.
-- ---------------------------------------------------------------------------
do $cerrojo$
declare
  r record;
  v_rol text;
  -- Roles cuyo EXECUTE se CONSERVA tal como está hoy. No se otorga nada nuevo:
  -- se mira quién lo tiene antes de revocar y se le devuelve después. Así la
  -- migración no puede abrir una puerta por accidente, y `purge_assistant_conversations`
  -- —que la 0060 le cerró a authenticated— sigue cerrada.
  v_conservan text[] := array[]::text[];
  -- Roles a los que se les quita. PUBLIC va aparte porque no es una fila de
  -- pg_roles: es el grant implícito que PostgreSQL pone en toda función nueva.
  v_revocar text[] := array[]::text[];
  v_mantener text[];
  -- ALLOWLIST-SIN-SESION: los RPC que la app llama SIN sesión y que por lo tanto
  -- anon tiene que poder ejecutar. Hoy no hay ninguno (ver [A] en la cabecera).
  -- Cada nombre que se agregue acá va con su razón escrita al lado, y
  -- cierre-seguridad.test.ts lo compara contra lo que el fuente realmente llama.
  v_permitidas text[] := array[]::text[];
begin
  foreach v_rol in array array['authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_rol) then
      v_conservan := v_conservan || v_rol;
    end if;
  end loop;
  foreach v_rol in array array['anon'] loop
    if exists (select 1 from pg_roles where rolname = v_rol) then
      v_revocar := v_revocar || v_rol;
    end if;
  end loop;

  for r in
    -- `oid::regprocedure` y no format('%I.%I(%s)'): el texto de regprocedure
    -- califica el esquema exactamente cuando hace falta para volver a resolver
    -- a ESTA función. Escribir la firma a mano rompe con `use_lot`, que existe
    -- en los dos esquemas, y con los tipos propios (`event_attendance_status`)
    -- si el search_path del despliegue no trae public.
    select p.oid as oid, p.proname as nombre, n.nspname as esquema,
           p.oid::regprocedure::text as firma
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef
       and n.nspname in ('public', 'app')
     order by n.nspname, p.proname
  loop
    if r.esquema = 'public' and r.nombre = any (v_permitidas) then
      continue;
    end if;

    v_mantener := array[]::text[];
    foreach v_rol in array v_conservan loop
      if has_function_privilege(v_rol, r.oid, 'EXECUTE') then
        v_mantener := v_mantener || v_rol;
      end if;
    end loop;

    execute format('revoke execute on function %s from public', r.firma);
    foreach v_rol in array v_revocar loop
      execute format('revoke execute on function %s from %I', r.firma, v_rol);
    end loop;
    foreach v_rol in array v_mantener loop
      execute format('grant execute on function %s to %I', r.firma, v_rol);
    end loop;
  end loop;
end;
$cerrojo$;

-- El esquema `app` es interior: sus funciones las llaman las SECURITY DEFINER de
-- `public` (que corren como el dueño, no como quien llama) y las políticas de
-- RLS de `authenticated`. anon no evalúa ninguna política —no hay ni una sola
-- `to anon` en las 59 migraciones— así que no necesita ni entrar.
--
-- Va además del revoke de arriba a propósito: el revoke cierra las funciones que
-- HOY existen; esto cierra las que se escriban mañana, que volverían a nacer con
-- EXECUTE para PUBLIC.
do $puerta$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke usage on schema app from anon;
  end if;
end;
$puerta$;

-- ---------------------------------------------------------------------------
-- [B] Un solo error: "no existe" y "no es tuyo" se contestan igual.
-- ---------------------------------------------------------------------------

-- ##### app.event_actual_gate
CREATE OR REPLACE FUNCTION app.event_actual_gate(p_event_id uuid)
 RETURNS nutrition_events
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_evento public.nutrition_events;
  v_cierre timestamptz;
begin
  select * into v_evento from public.nutrition_events where id = p_event_id;
  -- 0062 §48 — SIN ORACULO. Antes un id inventado contestaba 'evento
  -- inexistente' (no_data_found) y un id real de OTRO hogar contestaba 'te
  -- falta el permiso' (insufficient_privilege): con esas dos respuestas
  -- distintas, cualquiera con sesion podia preguntarle a la base si un evento
  -- existe, sin ser de la casa. La pregunta "¿pertenezco a este hogar?" se
  -- contesta ANTES que ninguna otra, y las dos formas de no pertenecer
  -- —no existe y no es tuyo— se responden con la misma linea.
  if v_evento.id is null or not app.is_household_member(v_evento.household_id) then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
  end if;

  -- Pasado ese punto quien llama SI es de la casa, asi que el mensaje puede ser
  -- especifico: le habla a alguien de adentro al que le falta un rol, no a un
  -- desconocido que esta tanteando ids.
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
$function$
;

-- ##### public.event_menu_blocks
CREATE OR REPLACE FUNCTION public.event_menu_blocks(p_event uuid)
 RETURNS TABLE(participant_id uuid, menu_item_id uuid, from_allergy boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_evento public.nutrition_events;
begin
  select * into v_evento from public.nutrition_events where id = p_event;
  -- Ante la duda NO se abre la puerta, y tampoco se devuelve vacío: quien no
  -- puede preguntar tiene que ver un error, no una lista sin restricciones.
  --
  -- 0062 §48: y ese error es UNO SOLO. 'ese evento no existe' contra 'este
  -- evento no es de tu hogar' era un oraculo de existencia servido a cualquiera.
  if v_evento.id is null or not app.is_household_member(v_evento.household_id) then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
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
$function$
;

-- ##### public.set_event_status
CREATE OR REPLACE FUNCTION public.set_event_status(p_event_id uuid, p_status event_status)
 RETURNS event_status
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_household uuid;
begin
  select household_id into v_household from public.nutrition_events where id = p_event_id;
  -- 0062 §48: existir y ser ajeno se contestan igual (ver cabecera de la 0062).
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
  end if;
  if not app.can_edit_plan(v_household) then
    raise exception 'no puedes editar el plan de este hogar: te falta el permiso para planificar'
      using errcode = 'insufficient_privilege';
  end if;

  update public.nutrition_events set status = p_status where id = p_event_id;
  return p_status;
end;
$function$
;

-- ##### public.save_event_estimate_revision
CREATE OR REPLACE FUNCTION public.save_event_estimate_revision(p_event_id uuid, p_input_signature text, p_engine_version text, p_policy_version text, p_plan_context jsonb, p_participants_snapshot jsonb, p_menu jsonb, p_policy jsonb, p_yield_inputs jsonb, p_estimate_output jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_household uuid;
  v_evento public.nutrition_events;
  v_id uuid;
  v_intento int := 0;
begin
  select * into v_evento from public.nutrition_events where id = p_event_id;
  -- 0062 §48: existir y ser ajeno se contestan igual (ver cabecera de la 0062).
  if v_evento.id is null or not app.is_household_member(v_evento.household_id) then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
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
$function$
;

-- ##### public.record_event_attendance
CREATE OR REPLACE FUNCTION public.record_event_attendance(p_participant_id uuid, p_attendance_status event_attendance_status)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_household uuid;
  v_event uuid;
begin
  select e.household_id, e.id into v_household, v_event
  from public.event_participants p
  join public.nutrition_events e on e.id = p.event_id
  where p.id = p_participant_id;

  -- 0062 §48: un participante inventado y uno de otro hogar se contestan igual.
  if v_household is null or not app.is_household_member(v_household) then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
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
$function$
;

-- ##### public.record_event_guest_observation
CREATE OR REPLACE FUNCTION public.record_event_guest_observation(p_participant_id uuid, p_intake_extent guest_intake_extent, p_estimated_serving_g numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_evento public.nutrition_events;
  v_event_id uuid;
  v_actor uuid;
  v_previa uuid;
  v_id uuid;
begin
  select event_id into v_event_id from public.event_participants where id = p_participant_id;
  -- 0062 §48: un participante inventado se contesta igual que uno de otro
  -- hogar. El caso "de otro hogar" lo cierra app.event_actual_gate tres lineas
  -- mas abajo, y desde la 0062 con este mismo mensaje y este mismo errcode.
  if v_event_id is null then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
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
$function$
;

-- ##### public.create_draft_from_version
CREATE OR REPLACE FUNCTION public.create_draft_from_version(p_version_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_src public.meal_template_versions;
  v_new uuid;
  v_slot record;
  v_new_slot uuid;
begin
  select * into v_src from public.meal_template_versions where id = p_version_id;
  -- 0062 §48: 'versión inexistente' contra 'no autorizado' le decia a cualquiera
  -- si un id de receta existe. Una sola respuesta para las dos formas de no
  -- poder. Se usa v_src.id (y no FOUND) porque la condicion tiene dos ramas y
  -- el OR de SQL no garantiza corto circuito.
  if v_src.id is null or not app.can_write_template(v_src.template_id) then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.meal_template_versions
             where template_id = v_src.template_id and status = 'DRAFT') then
    raise exception 'ya existe un borrador para esta receta';
  end if;

  insert into public.meal_template_versions
    (template_id, version_number, status, name, description, meal_types,
     base_time_minutes, base_servings, total_yield_factor)
  select v_src.template_id,
         coalesce(max(version_number), 0) + 1,
         'DRAFT', v_src.name, v_src.description, v_src.meal_types,
         v_src.base_time_minutes, v_src.base_servings, v_src.total_yield_factor
  from public.meal_template_versions where template_id = v_src.template_id
  returning id into v_new;

  for v_slot in select * from public.meal_slots where version_id = p_version_id order by sort_order loop
    insert into public.meal_slots (version_id, slot_type, label, is_required, sort_order, notes)
    values (v_new, v_slot.slot_type, v_slot.label, v_slot.is_required, v_slot.sort_order, v_slot.notes)
    returning id into v_new_slot;

    insert into public.meal_slot_components (
      slot_id, ingredient_id, product_id, nested_version_id, quantity, unit, weight_basis,
      measure_id, measure_count, nutrition_fact_id, cooking_method, yield_factor,
      is_optional, sort_order, notes)
    select v_new_slot, ingredient_id, product_id, nested_version_id, quantity, unit, weight_basis,
           measure_id, measure_count, nutrition_fact_id, cooking_method, yield_factor,
           is_optional, sort_order, notes
    from public.meal_slot_components where slot_id = v_slot.id;

    insert into public.meal_slot_alternatives (
      slot_id, ingredient_id, product_id, nested_version_id,
      culinary_compatibility, quantity_equivalence, notes)
    select v_new_slot, ingredient_id, product_id, nested_version_id,
           culinary_compatibility, quantity_equivalence, notes
    from public.meal_slot_alternatives where slot_id = v_slot.id;
  end loop;

  insert into public.recipe_steps (
    version_id, step_number, instruction, duration_minutes, temperature_c,
    required_capability, optional_capability, manual_alternative, parallel_group, notes)
  select v_new, step_number, instruction, duration_minutes, temperature_c,
         required_capability, optional_capability, manual_alternative, parallel_group, notes
  from public.recipe_steps where version_id = p_version_id;

  return v_new;
end;
$function$
;

-- ##### public.generate_shopping_revision
CREATE OR REPLACE FUNCTION public.generate_shopping_revision(p_list_id uuid, p_signature text, p_engine text, p_reasons jsonb, p_payload jsonb, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_household uuid;
  v_status public.shopping_list_status;
  v_numero int;
  v_item jsonb;
  v_claves text[];
begin
  select household_id, status, current_revision
  into v_household, v_status, v_numero
  from public.shopping_lists where id = p_list_id
  for update;

  -- 0062 §48: 'lista inexistente' contra 'no autorizado' delataba que la lista
  -- de otra casa existe. Una sola respuesta.
  if v_household is null or not app.can_manage_shopping(v_household) then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
  end if;
  if v_status = 'COMPLETED' then
    raise exception 'Esta compra ya se finalizó: la lista quedó cerrada.'
      using errcode = 'check_violation';
  end if;

  -- §51: mismas entradas, misma lista. No se duplica nada.
  if exists (select 1 from public.shopping_list_revisions
             where list_id = p_list_id and revision_number = v_numero
               and input_signature = p_signature) then
    return v_numero;
  end if;

  -- Hardening 3: ningún item puede referenciar alimentos/productos privados
  -- de otro hogar.
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if (v_item->>'required_quantity')::numeric = 'NaN'::numeric
       or (v_item->>'required_quantity')::numeric = 'Infinity'::numeric then
      raise exception 'la cantidad de "%" no es un número válido', v_item->>'label';
    end if;
    if not app.ingredient_in_scope(nullif(v_item->>'ingredient_id', '')::uuid, v_household) then
      raise exception 'el alimento "%" no pertenece a este hogar', v_item->>'label';
    end if;
    if not app.product_in_scope(nullif(v_item->>'product_id', '')::uuid, v_household) then
      raise exception 'el producto "%" no pertenece a este hogar', v_item->>'label';
    end if;
  end loop;

  v_numero := v_numero + 1;

  insert into public.shopping_list_revisions
    (list_id, revision_number, input_signature, engine_version, reasons, payload, created_by)
  values (p_list_id, v_numero, p_signature, p_engine,
          coalesce(p_reasons, '[]'::jsonb), p_payload,
          app.current_member_id(v_household));

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into public.shopping_list_items (
      list_id, source, line_key, ingredient_id, product_id, label, unit,
      required_quantity, purchase_basis, cooked_quantity, yield_factor,
      unresolved, unresolved_reason, provenance
    ) values (
      p_list_id, 'FOOD_PLAN',
      v_item->>'line_key',
      nullif(v_item->>'ingredient_id', '')::uuid,
      nullif(v_item->>'product_id', '')::uuid,
      v_item->>'label',
      v_item->>'unit',
      (v_item->>'required_quantity')::numeric,
      (v_item->>'purchase_basis')::public.purchase_basis,
      nullif(v_item->>'cooked_quantity', '')::numeric,
      nullif(v_item->>'yield_factor', '')::numeric,
      coalesce((v_item->>'unresolved')::boolean, false),
      v_item->>'unresolved_reason',
      coalesce(v_item->'provenance', '[]'::jsonb)
    )
    on conflict (list_id, line_key) where line_key is not null
    do update set
      label = excluded.label,
      unit = excluded.unit,
      required_quantity = excluded.required_quantity,
      purchase_basis = excluded.purchase_basis,
      cooked_quantity = excluded.cooked_quantity,
      yield_factor = excluded.yield_factor,
      unresolved = excluded.unresolved,
      unresolved_reason = excluded.unresolved_reason,
      provenance = excluded.provenance,
      updated_at = now();
  end loop;

  select array_agg(x->>'line_key')
  into v_claves
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x;

  update public.shopping_list_items
  set required_quantity = 0, provenance = '[]'::jsonb,
      unresolved = false, unresolved_reason = null, updated_at = now()
  where list_id = p_list_id and source = 'FOOD_PLAN'
    and line_key is not null
    and (v_claves is null or not (line_key = any (v_claves)))
    and status = 'PURCHASED';

  delete from public.shopping_list_items
  where list_id = p_list_id and source = 'FOOD_PLAN'
    and line_key is not null
    and (v_claves is null or not (line_key = any (v_claves)))
    and status <> 'PURCHASED';

  update public.shopping_lists
  set current_revision = v_numero, status = 'ACTIVE'
  where id = p_list_id;

  return v_numero;
end;
$function$
;

-- ##### public.reconcile_purchase
CREATE OR REPLACE FUNCTION public.reconcile_purchase(p_purchase uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_p public.purchases;
  v_lineas int;
  v_desconocidas int;
  v_suma_lineas bigint;
  v_suma_cargos bigint;
  v_calculado bigint;
  v_delta bigint;
  v_tol bigint;
  v_estado public.reconciliation_status;
  v_after bigint;
begin
  select * into v_p from public.purchases where id = p_purchase for update;
  -- ESTA FUNCIÓN ESCRIBE: mueve `purchases.reconciliation`, los tres campos del
  -- descuadre y el cargo ROUNDING. Estuvo gateada con FINANCE_VIEW —el permiso
  -- que el enum describe como «la abuela ve cuánto se gastó»— y era el único RPC
  -- mutante del sprint con el permiso de SOLO LECTURA: quien sólo podía mirar
  -- reescribía en silencio el cierre de una compra ya conciliada, saltándose el
  -- `revoke insert, update, delete` que existe justamente para eso. Pide el
  -- mismo permiso que `record_purchase`, que es quien la llama.
  --
  -- 0062 §48: y ese permiso se pregunta EN LA MISMA LINEA que la existencia.
  -- Antes 'la compra no existe' (check_violation) llegaba antes que
  -- 'no autorizado', asi que bastaba mirar cual de los dos errores volvia para
  -- saber si una compra de otra casa existe. Con la compra ausente
  -- household_id queda null y app.finance_access(null, ...) es false: las dos
  -- formas de no poder salen por la misma linea.
  if v_p.id is null
     or not app.finance_access(v_p.household_id, 'FINANCE_CONFIRM_RECEIPTS') then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
  end if;

  select count(*)::int,
         count(*) filter (where value_status = 'UNKNOWN')::int,
         case when bool_or(line_subtotal_minor is null or line_discount_minor is null)
              then null else sum(line_subtotal_minor + line_discount_minor) end
    into v_lineas, v_desconocidas, v_suma_lineas
  from public.purchase_items
  where purchase_id = p_purchase and superseded_at is null;

  -- Los cargos ROUNDING quedan FUERA del cálculo del delta ([H27]): si entraran,
  -- recorrer la conciliación dos veces daría deltas distintos y se inventaría un
  -- segundo ajuste encima del primero.
  select case when bool_or(amount_minor is null) then null else coalesce(sum(amount_minor), 0) end
    into v_suma_cargos
  from public.purchase_charges
  where purchase_id = p_purchase and kind <> 'ROUNDING';
  v_suma_cargos := coalesce(v_suma_cargos, 0);

  if v_suma_lineas is null then
    v_calculado := null;
  else
    v_calculado := v_suma_lineas + v_suma_cargos;
  end if;

  if v_p.total_source <> 'PRINTED' then
    v_estado := 'NOT_APPLICABLE';
    v_delta := null;
  elsif v_p.declared_total_minor is null or v_calculado is null or v_desconocidas > 0 then
    v_estado := 'TOTAL_UNKNOWN';
    v_delta := null;
  else
    v_delta := v_p.declared_total_minor - v_calculado;
    v_tol := app.reconciliation_tolerance_minor(
      (v_p.allocation_policy_snapshot ->> 'toleranceMinor')::bigint,
      (v_p.allocation_policy_snapshot ->> 'tolerancePerLineMinor')::bigint,
      (v_p.allocation_policy_snapshot ->> 'tolerancePct')::numeric,
      v_lineas, v_p.declared_total_minor);
    if v_delta = 0 then
      v_estado := 'BALANCED';
    elsif abs(v_delta) <= v_tol then
      v_estado := 'WITHIN_TOLERANCE';
    else
      v_estado := 'OUT_OF_TOLERANCE';
    end if;
  end if;

  -- El cargo de redondeo: uno solo por compra, con nombre, monto y política.
  if v_estado = 'WITHIN_TOLERANCE' then
    insert into public.purchase_charges
      (purchase_id, household_id, kind, label, amount_minor, policy, applied_policy_version)
    values (p_purchase, v_p.household_id, 'ROUNDING',
            'Diferencia de redondeo de la boleta', v_delta, 'EXPENSE_ONLY',
            v_p.allocation_policy_version)
    on conflict (purchase_id) where kind = 'ROUNDING'
    do update set amount_minor = excluded.amount_minor, label = excluded.label;
    v_after := 0;
  else
    delete from public.purchase_charges where purchase_id = p_purchase and kind = 'ROUNDING';
    v_after := v_delta;
  end if;

  update public.purchases
  set reconciliation = v_estado,
      reconciliation_delta_before_adjustment_minor = v_delta,
      reconciliation_delta_after_minor = v_after,
      reconciled_at = now()
  where id = p_purchase;

  -- Reconciliar una compra CERRADA otra vez es un hecho que alguien tiene que
  -- poder ver después; sin esto, el cierre se reescribía sin dejar rastro. Sólo
  -- cuando el estado CAMBIA: repetir el cuadre y que dé lo mismo no es un hecho.
  -- Sin montos, que van a finance_audit_log y no acá ([H68], 0045).
  if v_p.reconciliation is distinct from v_estado then
    insert into public.audit_events
      (household_id, actor_user_id, action, subject_kind, subject_id, metadata)
    values (v_p.household_id, auth.uid(), 'PURCHASE_RECONCILED', 'purchase', p_purchase,
            jsonb_build_object('reconciliation', v_estado::text,
                               'previous', v_p.reconciliation::text,
                               'lines', v_lineas,
                               'unknownLines', v_desconocidas));
  end if;

  return jsonb_build_object(
    'reconciliation', v_estado::text,
    'deltaBeforeAdjustmentMinor', v_delta,
    'deltaAfterMinor', v_after,
    'toleranceMinor', v_tol,
    'lines', v_lineas,
    'unknownLines', v_desconocidas);
end;
$function$
;

-- ##### public.set_supplier_product_price
CREATE OR REPLACE FUNCTION public.set_supplier_product_price(p_supplier_product uuid, p_price_minor bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_household uuid;
  v_currency char(3);
  v_sp public.supplier_products;
begin
  select sp.* into v_sp from public.supplier_products sp where sp.id = p_supplier_product;
  select s.household_id into v_household from public.suppliers s where s.id = v_sp.supplier_id;
  -- 0062 §48: 'esa presentacion no existe' contra 'no autorizado' delataba el
  -- catalogo de proveedores de otro hogar. Con la presentacion ausente
  -- v_household queda null y finance_access(null, ...) es false: una respuesta
  -- para las dos formas de no poder.
  if v_sp.id is null or not app.finance_access(v_household, 'FINANCE_MANAGE_PRICES') then
    raise exception 'no autorizado' using errcode = 'insufficient_privilege';
  end if;
  if p_price_minor is null or p_price_minor <= 0 then
    raise exception 'un precio de proveedor de cero no es un precio';
  end if;
  perform app.assert_money(p_price_minor, 'el precio del proveedor');
  select currency into v_currency from public.households where id = v_household;

  update public.supplier_products
     set price = app.minor_to_value(p_price_minor, v_currency), updated_at = now()
   where id = p_supplier_product;

  -- El catálogo del proveedor también es un hecho de precio fechado.
  perform app.record_price_observation(
    v_household, null, v_sp.ingredient_id, null, v_sp.presentation,
    v_sp.supplier_id, v_sp.supplier_id::text,
    app.household_today(v_household), 'HUMAN',
    v_currency, p_price_minor, false, null,
    v_sp.package_quantity, v_sp.unit, 1, v_sp.weight_basis,
    'SUPPLIER_CATALOG', null, null, app.current_member_id(v_household)
  );
end;
$function$
;

-- ##### public.assistant_usage_settle
CREATE OR REPLACE FUNCTION public.assistant_usage_settle(p_trace text, p_tokens_in integer, p_tokens_out integer, p_tool_calls integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.assistant_usage;
begin
  select * into v_row from public.assistant_usage where trace_id = p_trace for update;
  -- 0062 §48: una traza ajena y una traza inventada son, PARA QUIEN LLAMA, la
  -- misma cosa: no tiene ninguna reserva viva con esa traza. Antes se
  -- distinguian ('no autorizado' contra este mensaje) y eso dejaba preguntarle
  -- a la base si la traza de otra casa existe. Se conserva el mensaje largo
  -- porque es el que necesita quien liquida sin haber reservado, que es el
  -- defecto real que esta linea existe para nombrar.
  if v_row.id is null or not app.is_self_member(v_row.member_id) then
    raise exception 'no hay reserva viva con esa traza: no existe camino que llame al proveedor sin reservar antes';
  end if;
  if v_row.liquidada_at is not null then return; end if;   -- idempotente

  update public.assistant_usage
     set tokens_in = greatest(coalesce(p_tokens_in, 0), 0),
         tokens_out = greatest(coalesce(p_tokens_out, 0), 0),
         tool_calls = greatest(coalesce(p_tool_calls, tool_calls), 0),
         liquidada_at = now()
   where trace_id = p_trace;
end;
$function$
;

-- ##### public.apply_clinical_shopping_delta
CREATE OR REPLACE FUNCTION public.apply_clinical_shopping_delta(p_review_id uuid, p_deltas jsonb, p_dedupe_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_r public.clinical_impact_reviews; v_household uuid; v_claim record;
begin
  select * into v_r from public.clinical_impact_reviews where id = p_review_id for update;
  -- El mensaje de "no existe" lo sigue dando la función de adentro: el contrato
  -- de errores no se cambia de contrabando en una migración de idempotencia.
  --
  -- 0062 §48: y la de PERMISO tambien. Con `if not found` a secas, una revision
  -- clinica de OTRO hogar que ya estuviera resuelta se escapaba por el return
  -- de mas abajo con su `status` adentro, sin pasar por ninguna comprobacion:
  -- un dato clinico de otra casa entregado a quien adivine un uuid. Ahora la
  -- pregunta de permiso se hace ANTES de mirar el estado, y la respuesta la
  -- sigue dando la funcion de adentro: un solo 'no autorizado' para "no existe"
  -- y para "no es tuya".
  if v_r.id is null or not app.medical_access(v_r.member_id, 'VIEW_CLINICAL_RESTRICTIONS') then
    return app.apply_clinical_shopping_delta(p_review_id, p_deltas);
  end if;

  -- Una revisión ya resuelta no se vuelve a aplicar. Antes de esta línea, el
  -- ajuste de una revisión DISMISSED se aplicaba igual.
  if v_r.status <> 'PENDING' then
    return jsonb_build_object(
      'applied', '[]'::jsonb, 'no_line_found', '[]'::jsonb,
      'reason_code', 'CLINICAL_ADJUSTMENT',
      'skipped', 'REVISION_YA_RESUELTA', 'status', v_r.status);
  end if;

  v_household := app.member_household(v_r.member_id);

  if p_dedupe_key is not null then
    select * into v_claim from app.claim_dedupe(v_household, p_dedupe_key, 'apply_clinical_shopping_delta');
    if not v_claim.tomada then
      return jsonb_build_object(
        'applied', '[]'::jsonb, 'no_line_found', '[]'::jsonb,
        'reason_code', 'CLINICAL_ADJUSTMENT', 'skipped', 'YA_APLICADO');
    end if;
  end if;

  declare v_out jsonb;
  begin
    v_out := app.apply_clinical_shopping_delta(p_review_id, p_deltas);
    if p_dedupe_key is not null then
      perform app.settle_dedupe(v_household, p_dedupe_key, p_review_id);
    end if;
    return v_out;
  end;
end;
$function$
;
