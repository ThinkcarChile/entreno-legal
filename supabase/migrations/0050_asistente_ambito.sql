-- 0050 — Sprint 15, Etapa 1: el ámbito y las capacidades, calculados POR LA BASE.
--
-- Esta migración abre la banda 0050..0058 del asistente. Va después de la banda
-- reservada a los Sprints 12/13/14 (0039..0048) a propósito: apoya sobre lo que
-- esos sprints dejan puesto y no compite por un número con ellos.
--
-- ---------------------------------------------------------------------------
-- LO QUE ESTA MIGRACIÓN **NO** HACE, Y POR QUÉ IMPORTA
-- ---------------------------------------------------------------------------
--
-- El diseño del Sprint 15 pedía acá un `create or replace` de `app.can_edit_plan`
-- y `app.can_cook`, y de paso reescribir las políticas de `weekly_plans`,
-- `weekly_plan_days` y `meal_assignments`.
--
-- NO SE HACE. Las dos funciones ya existen desde la 0039 y esa migración es su
-- dueña: además de crearlas, arrastró los datos (sección 2-bis: nadie queda sin
-- rol), puso el trigger que le da MEMBER a toda ficha nueva (2-ter) y —lo más
-- fácil de perder al recopiar— agregó `app.exigir_can_edit_plan()`, el trigger
-- que hace RUIDOSO el DELETE denegado. La versión del diseño no traía nada de
-- eso y volvía a poner el permiso en el `using`, que es exactamente lo que la
-- 0039 corrigió: con el permiso en el `using`, un borrado sin permiso toca cero
-- filas y vuelve como éxito.
--
-- Un solo dueño por regla. Acá se USAN, no se redefinen. Lo único que se agrega
-- es la comprobación de que estén: si esta migración se aplica sobre una base
-- sin la 0039, revienta con nombre y apellido en vez de construir un asistente
-- que pregunta "¿puedo?" a una función que no existe.

do $guardia0039$
declare v_cuantas int;
begin
  select count(distinct p.proname) into v_cuantas
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app' and p.proname in ('can_edit_plan', 'can_cook');

  if v_cuantas <> 2 then
    raise exception
      'falta la 0039: app.can_edit_plan y app.can_cook son su trabajo, no el de esta migración (encontradas: %)',
      v_cuantas;
  end if;
end;
$guardia0039$;

-- ---------------------------------------------------------------------------
-- 1. La tabla blanca: qué ids puede nombrar el asistente
-- ---------------------------------------------------------------------------
--
-- Todo uuid que sale de un modelo de lenguaje —o de un texto que el modelo
-- leyó— pasa por acá antes de tocar un RPC. La pregunta que contesta es la
-- única que importa: ¿de qué hogar es esta fila?
--
-- Es una lista CERRADA escrita a mano y no un `format('select household_id
-- from %I')`, porque un nombre de tabla que viene del mismo lado que el id no
-- es un nombre de tabla: es una entrada del atacante. Con la lista cerrada, el
-- peor caso de un `p_table` inventado es un error; con SQL dinámico sobre
-- nombre libre, el peor caso es leer cualquier tabla del esquema.

create or replace function app.tabla_de_ambito(p_table text)
returns boolean language sql immutable as $$
  select p_table in (
    'household_members', 'weekly_plans', 'weekly_plan_days', 'meal_assignments',
    'nutrition_events', 'shopping_lists', 'shopping_list_items',
    'procurement_orders', 'batch_prep_plans', 'meal_templates',
    'meal_template_versions', 'inventory_lots', 'stock_targets',
    'consumption_shortfalls', 'member_serving_projections',
    'member_clinical_restrictions', 'clinical_impact_reviews',
    'meal_clinical_assessments', 'lab_documents'
  );
$$;

comment on function app.tabla_de_ambito(text) is
  'La lista cerrada de tablas que el asistente puede nombrar. Cerrada a mano y '
  'no por SQL dinámico: el nombre de tabla viene del mismo lado que el id.';

create or replace function app.row_scope(p_table text, p_id uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if p_id is null then return null; end if;
  if not app.tabla_de_ambito(p_table) then
    -- ERROR != VACÍO. Un `null` acá diría "esta fila no es de ningún hogar",
    -- que es una respuesta, y lo cierto es que no hubo pregunta válida.
    raise exception 'tabla fuera de la lista blanca del asistente: %', p_table
      using errcode = 'check_violation';
  end if;

  return case p_table
    when 'household_members'          then app.member_household(p_id)
    when 'weekly_plans'               then app.plan_household(p_id)
    when 'weekly_plan_days'           then app.day_household(p_id)
    when 'meal_assignments'           then app.assignment_household(p_id)
    when 'shopping_lists'             then app.shopping_household(p_id)
    when 'procurement_orders'         then app.procurement_household(p_id)
    when 'batch_prep_plans'           then app.prep_plan_household(p_id)
    when 'meal_templates'             then app.template_household(p_id)
    when 'meal_template_versions'     then app.version_household(p_id)
    when 'nutrition_events'           then (select household_id from public.nutrition_events where id = p_id)
    when 'inventory_lots'             then (select household_id from public.inventory_lots where id = p_id)
    when 'stock_targets'              then (select household_id from public.stock_targets where id = p_id)
    when 'consumption_shortfalls'     then (select household_id from public.consumption_shortfalls where id = p_id)
    when 'clinical_impact_reviews'    then (select household_id from public.clinical_impact_reviews where id = p_id)
    when 'shopping_list_items'        then app.shopping_household(
                                            (select list_id from public.shopping_list_items where id = p_id))
    when 'member_serving_projections' then app.member_household(
                                            (select member_id from public.member_serving_projections where id = p_id))
    when 'member_clinical_restrictions' then app.member_household(
                                            (select member_id from public.member_clinical_restrictions where id = p_id))
    when 'meal_clinical_assessments'  then app.member_household(
                                            (select member_id from public.meal_clinical_assessments where id = p_id))
    when 'lab_documents'              then app.member_household(
                                            (select member_id from public.lab_documents where id = p_id))
  end;
end;
$$;

comment on function app.row_scope(text, uuid) is
  'De qué hogar es esta fila. NULL sólo significa "no existe"; un nombre de '
  'tabla desconocido revienta, porque no tener pregunta no es tener respuesta.';

-- ---------------------------------------------------------------------------
-- 2. Ámbito NO alcanza cuando la fila es clínica
-- ---------------------------------------------------------------------------
--
-- El paso de ámbito responde "¿es de tu hogar?" y para casi todo eso basta.
-- Para lo clínico no: un uuid de `member_clinical_restrictions` SÍ es del
-- hogar, así que el ámbito lo deja pasar, y a partir de ahí la única barrera
-- que queda es que la herramienta destino haya declarado bien su capacidad
-- MEDICAL. Una barrera de una capa donde el diseño promete dos.
--
-- Ese uuid, además, no llega solo: hoy viaja adentro de `reasons` de las
-- proyecciones de porción, que las lee todo el hogar. O sea, es un id clínico
-- que cualquier integrante puede leer y el modelo puede reinyectar.
--
-- Acá se resuelve el dueño de la fila y se exige el permiso EN EL MISMO PASO.

create or replace function app.row_clinical_owner(p_table text, p_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select case p_table
    when 'member_clinical_restrictions' then (select member_id from public.member_clinical_restrictions where id = p_id)
    when 'meal_clinical_assessments'    then (select member_id from public.meal_clinical_assessments where id = p_id)
    when 'clinical_impact_reviews'      then (select member_id from public.clinical_impact_reviews where id = p_id)
    when 'lab_documents'                then (select member_id from public.lab_documents where id = p_id)
  end;
$$;

-- Las DOS llaves de lo clínico, y por qué son dos.
--
-- La primera es de quien LEE: `medical_access` contesta "¿te dejaron ver los
-- datos de esta persona?". La segunda es de quien es DUEÑO de los datos:
-- `assistant_clinical_consent_ok` contesta "¿esa persona dijo que sí a que el
-- asistente los use?". Son decisiones de distinta naturaleza y ninguna implica
-- la otra: tener el grant de lectura de Ana no la hace consentir que sus
-- exámenes salgan a un proveedor, y que Ana consienta no le abre su ficha a
-- toda la casa.
--
-- La dueña de la regla es la 0051, que es donde vive la tabla. Acá se declara
-- el DEFAULT y el default es NO: una base con la 0050 puesta y la 0051 sin
-- aplicar tiene que negar lo clínico, no dejarlo pasar mientras "todavía no
-- hay tabla de consentimientos". Un permiso que se abre porque falta su
-- registro es exactamente al revés de como se lee la palabra consentimiento.

create or replace function app.assistant_clinical_consent_ok(p_household uuid, p_member uuid)
returns boolean language sql stable as $$
  select false;
$$;

comment on function app.assistant_clinical_consent_ok(uuid, uuid) is
  'DEFAULT fail-closed. La 0051 —dueña de household_ai_consents— la reemplaza '
  'por la de verdad. Sin tabla de consentimientos no hay consentimiento.';

create or replace function app.row_reachable(p_table text, p_id uuid, p_household uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_scope uuid; v_owner uuid;
begin
  v_scope := app.row_scope(p_table, p_id);
  if v_scope is null or v_scope <> p_household then return false; end if;
  if not app.is_household_member(p_household) then return false; end if;

  v_owner := app.row_clinical_owner(p_table, p_id);
  if v_owner is null then return true; end if;
  return app.medical_access(v_owner, 'VIEW_CLINICAL_RESTRICTIONS')
     and app.assistant_clinical_consent_ok(p_household, v_owner);
end;
$$;

comment on function app.row_reachable(text, uuid, uuid) is
  'Ámbito, capacidad de quien lee y consentimiento de quien es dueño, en el '
  'mismo paso. Un id clínico es del hogar —el ámbito lo deja pasar— así que si '
  'el permiso se delega al paso siguiente, un olvido en requires() abre la '
  'puerta entera.';

-- ---------------------------------------------------------------------------
-- 3. Capacidades: el asistente no calcula si puede, PREGUNTA
-- ---------------------------------------------------------------------------
--
-- Dos razones para que esto viva en la base y no en TypeScript:
--
--  1. La respuesta tiene que ser la MISMA que va a aplicar la RLS un
--     milisegundo después. Dos implementaciones de la misma regla es tener dos
--     dueños del mismo dato, y la que se equivoca siempre es la de arriba.
--  2. Un `false` calculado arriba se puede saltar; un `false` calculado acá
--     también rige para la escritura.
--
-- Quien no es del hogar recibe `{"member": false}` y nada más: ni la zona
-- horaria, ni el día del hogar, ni la lista de integrantes.

create or replace function app.assistant_capabilities(
  p_household uuid,
  p_members   uuid[] default '{}'::uuid[]
) returns jsonb language sql stable security definer set search_path = public as $$
  select case when not app.is_household_member(p_household)
    then jsonb_build_object('member', false)
    else jsonb_build_object(
      'member',        true,
      'member_id',     app.current_member_id(p_household),
      'timezone',      (select timezone from public.households where id = p_household),
      'today',         app.household_today(p_household),
      'is_admin',      app.is_household_admin(p_household),
      'can_edit_plan', app.can_edit_plan(p_household),
      'can_shop',      app.can_manage_shopping(p_household),
      'can_cook',      app.can_cook(p_household),
      -- Las tres banderas clínicas responden lo único que el asistente puede
      -- preguntar: "¿puedo USAR los datos de esta persona en este turno?".
      -- Por eso llevan las dos llaves adentro —el grant de quien lee y el
      -- consentimiento de quien es dueño— y no una sola. Devolver el permiso
      -- pelado sería devolver una respuesta a otra pregunta, y quien la lee
      -- arriba no tiene cómo notar la diferencia.
      --
      -- `ai_consent` viaja aparte a propósito: con la bandera en false, "no
      -- tienes acceso" y "esta persona no ha consentido" se ven iguales, y no
      -- son lo mismo para quien lo lee en pantalla. UNKNOWN != ZERO también
      -- vale para los motivos.
      'medical',       (select coalesce(jsonb_object_agg(m::text, jsonb_build_object(
                          'read_labs',    app.medical_access(m, 'READ_LABS')
                                          and app.assistant_clinical_consent_ok(p_household, m),
                          'restrictions', app.medical_access(m, 'VIEW_CLINICAL_RESTRICTIONS')
                                          and app.assistant_clinical_consent_ok(p_household, m),
                          'confirm_labs', app.medical_access(m, 'CONFIRM_LABS')
                                          and app.assistant_clinical_consent_ok(p_household, m),
                          'ai_consent',   app.assistant_clinical_consent_ok(p_household, m))), '{}'::jsonb)
                        from unnest(coalesce(p_members, '{}'::uuid[])) m
                        where app.member_household(m) = p_household)
    ) end;
$$;

create or replace function public.assistant_capabilities(
  p_household uuid,
  p_members   uuid[] default '{}'::uuid[]
) returns jsonb language sql stable security definer set search_path = public as $$
  select app.assistant_capabilities(p_household, p_members);
$$;

comment on function public.assistant_capabilities(uuid, uuid[]) is
  'El capability set del actor, calculado por la misma base que después aplica '
  'la RLS. Quien no es del hogar recibe {"member": false} y nada más.';

-- ---------------------------------------------------------------------------
-- 4. Capacidades exigidas, evaluadas por la base
-- ---------------------------------------------------------------------------
--
-- Una propuesta y un aviso del inbox declaran QUÉ hace falta para verlos y para
-- aceptarlos, como una lista de capacidades. Esa lista tiene que evaluarse en la
-- política de RLS y no en TypeScript: la audiencia escrita en la app es una
-- sugerencia; la audiencia escrita en la política es el techo.
--
-- Forma: [{"k":"MEDICAL","owner":"<uuid>","permission":"READ_LABS"},
--         {"k":"PLAN"}, {"k":"COOK"}, {"k":"SHOP"}, {"k":"ADMIN"}]
--
-- Lista VACÍA significa "cualquier integrante del hogar". Es el default sano
-- para un aviso de despensa, y es explícito: no hay forma de escribir una
-- capacidad y que se ignore por venir mal escrita —una `k` desconocida NIEGA.

create or replace function app.capabilities_ok(p_household uuid, p_requires jsonb)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare c jsonb;
begin
  if not app.is_household_member(p_household) then return false; end if;
  if p_requires is null or jsonb_typeof(p_requires) <> 'array' then return true; end if;

  for c in select * from jsonb_array_elements(p_requires) loop
    case c->>'k'
      when 'PLAN'  then if not app.can_edit_plan(p_household) then return false; end if;
      when 'COOK'  then if not app.can_cook(p_household) then return false; end if;
      when 'SHOP'  then if not app.can_manage_shopping(p_household) then return false; end if;
      when 'ADMIN' then if not app.is_household_admin(p_household) then return false; end if;
      when 'MEDICAL' then
        if c->>'owner' is null or c->>'permission' is null then return false; end if;
        if app.member_household((c->>'owner')::uuid) is distinct from p_household then return false; end if;
        if not app.medical_access((c->>'owner')::uuid, (c->>'permission')::public.medical_permission) then
          return false;
        end if;
      else
        -- Una capacidad que no se entiende NIEGA. Al revés —ignorarla— haría
        -- que un error de tipeo en `requires` abriera la fila a todo el hogar,
        -- y ese es el peor default posible para una tarjeta clínica.
        return false;
    end case;
  end loop;
  return true;
end;
$$;

comment on function app.capabilities_ok(uuid, jsonb) is
  'Evalúa la lista de capacidades exigidas. Una `k` desconocida NIEGA: un error '
  'de tipeo no puede abrir una tarjeta clínica a todo el hogar.';

-- ---------------------------------------------------------------------------
-- 5. Mirar los objetivos de otro no es editárselos
-- ---------------------------------------------------------------------------
--
-- Las cinco tablas de perfil de la 0005 nacieron con una sola política
-- `for all using (app.can_access_member(member_id))`, y `can_access_member` es
-- "está en tu hogar". O sea: cualquier integrante puede REESCRIBIR los
-- objetivos de nutrición, las preferencias y el patrón de comidas de cualquier
-- otro, incluidos los de un adulto con su propia cuenta.
--
-- Mientras eso lo hacía una pantalla, era un permiso flojo. Con un asistente
-- que puede proponer `setTrackingMode` o `saveDailyOverride` sobre otro
-- integrante, es una escritura ajena a un toque de distancia.
--
-- Se parte en dos: LEER sigue siendo de todo el hogar (la familia planifica
-- junta y el optimizador necesita los objetivos de todos), ESCRIBIR es de uno
-- mismo, o de quien administra SOBRE UNA FICHA SIN CUENTA. Esa segunda rama no
-- es una concesión: es el caso real de la guagua y del abuelo, cuya ficha
-- alguien tiene que mantener porque ellos no entran a la app. En cuanto la
-- ficha tiene `user_id`, hay una persona que puede hablar por sí misma y nadie
-- más le escribe el perfil.
--
-- Las políticas viejas se borran POR SU NOMBRE REAL (`goals_all`,
-- `tracking_all`, `patterns_all`, `preferences_all`, `daily_plans_all`). No es
-- un detalle: las políticas de Postgres se suman con OR, así que dejar viva la
-- permisiva y agregar una estricta al lado no aprieta nada — deja todo igual y
-- con cara de arreglado.

create or replace function app.puede_editar_perfil(p_member uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select app.is_self_member(p_member)
     or (
       app.member_household(p_member) is not null
       and app.is_household_admin(app.member_household(p_member))
       and not exists (
         select 1 from public.household_members hm
         where hm.id = p_member and hm.user_id is not null
       )
     );
$$;

comment on function app.puede_editar_perfil(uuid) is
  'Uno mismo, o quien administra sobre una ficha SIN cuenta (la guagua, el '
  'abuelo). Con user_id hay alguien que puede hablar por sí mismo.';

do $perfiles$
declare
  v_par record;
begin
  for v_par in
    select * from (values
      ('member_tracking_settings',      'tracking_all'),
      ('nutrition_goals',               'goals_all'),
      ('meal_patterns',                 'patterns_all'),
      ('member_preferences',            'preferences_all'),
      ('member_daily_nutrition_plans',  'daily_plans_all')
    ) as t(tabla, politica)
  loop
    execute format('drop policy if exists %I on public.%I', v_par.politica, v_par.tabla);
    execute format('drop policy if exists %I on public.%I', v_par.tabla || '_select', v_par.tabla);
    execute format('drop policy if exists %I on public.%I', v_par.tabla || '_write', v_par.tabla);

    execute format(
      'create policy %I on public.%I for select to authenticated using (app.can_access_member(member_id))',
      v_par.tabla || '_select', v_par.tabla);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (app.puede_editar_perfil(member_id)) with check (app.puede_editar_perfil(member_id))',
      v_par.tabla || '_write', v_par.tabla);
  end loop;
end;
$perfiles$;
