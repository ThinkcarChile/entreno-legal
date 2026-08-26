-- 0039 — `can_edit_plan` y `can_cook` dejan de ser columnas decorativas.
--
-- Las dos columnas nacen en la 0001 (:45-49) y se siembran en :166, pero
-- NINGUNA política RLS y NINGÚN RPC las leyó jamás. La consecuencia real: un
-- hogar podía invitar gente como COOK, PLANNER, SHOPPER o MEMBER y sobre la
-- semana los cuatro tenían exactamente el mismo poder — crear, editar y borrar
-- asignaciones, crear y borrar eventos, y disparar el movimiento físico de la
-- despensa. Los únicos permisos vivos eran `is_admin` y `can_manage_shopping`.
--
-- ---------------------------------------------------------------------------
-- LA REGLA QUE MANDA ACÁ: si un cambio puede dejar a alguien fuera, el default
-- es PERMISIVO y el aprieto se hace explícito.
-- ---------------------------------------------------------------------------
--
-- Conectar un permiso muerto es apretar una puerta que llevaba años abierta, y
-- del otro lado hay familias que ya están adentro. Dos hechos del terreno lo
-- obligan a ser permisivo por defecto:
--
--  1. La semilla de la 0001 le da a MEMBER `can_edit_plan = false` y
--     `can_cook = false`. MEMBER es además el `role_code` POR OMISIÓN de las
--     invitaciones (0001:73): quien invitó sin pensar en roles —o sea, todo el
--     mundo, porque la interfaz nunca mostró estos permisos— repartió MEMBER.
--     Apretar de golpe deja a esas personas mirando su propio plan sin poder
--     tocarlo. Ese `false` nunca fue una decisión: era una columna muerta que
--     nadie pudo elegir, y una decisión que nadie tomó no se puede hacer valer
--     contra la gente. Por eso los roles QUE YA EXISTEN reciben abajo los dos
--     permisos: conservan exactamente el poder que tienen hoy, ni más ni menos.
--     A partir de ahora quien administra puede quitárselos, y ESO sí será una
--     decisión.
--
--  2. Hay integrantes SIN NINGÚN rol asignado. `create_household` sólo le pone
--     ADMIN a quien crea el hogar; toda ficha agregada después (el camino que
--     usa la app para la familia que no tiene cuenta) nace sin asignación
--     alguna. Un integrante sin rol no es un integrante sin permisos: es un
--     integrante sobre el que nadie declaró nada.
--
--     La primera versión de esta migración lo resolvía en el GUARDIÁN, tratando
--     "sin rol" como permisivo. Eso producía una inversión: quitarle todos los
--     roles a alguien lo dejaba más poderoso que dejarlo como MEMBER. Ahora se
--     resuelve en los DATOS (sección 2-bis): a cada uno se le escribe el rol que
--     refleja lo que ya podía hacer, y el guardián queda estricto.
--
-- Los hogares NUEVOS sí estrenan la matriz que la 0001 declaró: MEMBER mira,
-- PLANNER planifica, COOK cocina. No se toca `create_household` — su semilla
-- ES la intención del producto, y recién ahora empieza a significar algo.
--
-- Lo que este archivo NO aprieta, a propósito:
--
--  · `ensure_weekly_plan` sigue abierta a cualquier integrante. Parece un
--    escritor, pero está en el camino de LECTURA: `loadWeek` y
--    `loadShoppingContext` la llaman para poder MOSTRAR la semana. Pedirle
--    `can_edit_plan` haría reventar la pantalla del plan en la cara de quien
--    sólo quiere mirarla. Lo único que crea es el esqueleto vacío de la semana
--    (la fila y sus siete días); el contenido sí queda protegido por las
--    políticas de más abajo.
--  · `log_intake` y compañía: declarar lo que UNO comió es un acto personal,
--    no un acto de cocina.

-- ---------------------------------------------------------------------------
-- 1. Los dos guardianes
-- ---------------------------------------------------------------------------
--
-- Mismo molde que `app.can_manage_shopping` (0009:218), incluido el ancla que
-- allá se agregó a mano: el rol tiene que ser DE ESTE HOGAR. Un rol de otro
-- hogar no cuenta ni para dar permiso ni —y esto importa— para hacer creer que
-- a la persona ya se le declaró algo.

create or replace function app.can_edit_plan(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = hid and m.user_id = auth.uid() and m.is_active
      and (
        -- ADMIN puede todo, siempre. Y quien tenga el permiso, obvio.
        exists (
          select 1
          from public.member_role_assignments a
          join public.household_roles r on r.id = a.role_id
          where a.member_id = m.id and r.household_id = m.household_id
            and (r.is_admin or r.can_edit_plan)
        )
      )
  );
$$;

create or replace function app.can_cook(hid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = hid and m.user_id = auth.uid() and m.is_active
      and (
        exists (
          select 1
          from public.member_role_assignments a
          join public.household_roles r on r.id = a.role_id
          where a.member_id = m.id and r.household_id = m.household_id
            and (r.is_admin or r.can_cook)
        )
      )
  );
$$;

comment on function app.can_edit_plan(uuid) is
  'Puede escribir la semana: ADMIN o quien tenga can_edit_plan. Sin rol no hay '
  'permiso — la 2-bis se encarga de que nadie quede sin rol, para que quitar un '
  'rol signifique quitar un permiso y no lo contrario.';

comment on function app.can_cook(uuid) is
  'Puede sacar comida de la despensa: ADMIN o quien tenga can_cook. Sin rol no '
  'hay permiso; la 2-bis garantiza que nadie quede sin rol.';

-- ---------------------------------------------------------------------------
-- 2. Los hogares que ya existen no pierden nada
-- ---------------------------------------------------------------------------
--
-- Hasta esta línea, TODO rol de TODO hogar podía planificar y podía cocinar.
-- Eso no es una suposición: es lo que las políticas de la 0007 permitían. Se
-- escribe como dato para que siga siendo cierto después del cambio. En una
-- base recién creada esta sentencia toca cero filas y los hogares nuevos nacen
-- con la matriz de la 0001.

update public.household_roles
set can_edit_plan = true, can_cook = true
where not (can_edit_plan and can_cook);

-- ---------------------------------------------------------------------------
-- 2-bis. Nadie se queda sin rol, porque "sin rol" no puede significar "puede todo"
-- ---------------------------------------------------------------------------
--
-- La primera versión de este archivo resolvía al integrante SIN NINGÚN rol como
-- permisivo, razonando —con toda la razón— que nadie había declarado nada sobre
-- él y que UNKNOWN != ZERO. El problema es lo que eso produce del otro lado:
--
--     quitarle TODOS los roles a alguien lo dejaba MÁS poderoso que dejarlo
--     como MEMBER.
--
-- Es una inversión de permisos, y es exactamente el gesto que un administrador
-- va a hacer la primera vez que quiera restringir a alguien. La intención
-- "sacarle permisos" habría producido "dárselos todos", en silencio.
--
-- La salida no es elegir entre permisivo y restrictivo: es SACAR EL IMPLÍCITO
-- DEL MEDIO. Lo que hoy puede hacer cada integrante se escribe como dato —una
-- asignación de rol de verdad— y recién después los guardianes se ponen
-- estrictos. Nadie pierde nada, y a partir de acá quitar un rol significa
-- quitar un permiso, que es lo que cualquiera esperaría.

-- Un hogar sin rol MEMBER no debería existir (`create_household` lo siembra),
-- pero si alguno se armó por otro camino, primero se le da dónde aterrizar.
-- Nace con los dos permisos por la misma razón que la sección 2: hasta esta
-- línea, todo integrante de ese hogar podía planificar y cocinar.
insert into public.household_roles
  (household_id, code, name, is_admin, can_manage_members, can_edit_plan, can_manage_shopping, can_cook)
select h.id, 'MEMBER', 'Integrante', false, false, true, false, true
from public.households h
where not exists (
  select 1 from public.household_roles r
  where r.household_id = h.id and r.code = 'MEMBER'
);

-- Y ahora sí: cada integrante activo sin ninguna asignación de su hogar recibe
-- MEMBER explícitamente. En un hogar que ya existía, MEMBER acaba de quedar con
-- los dos permisos (sección 2), así que esta gente conserva EXACTAMENTE el poder
-- que tenía. La diferencia es que ahora está escrito.
insert into public.member_role_assignments (member_id, role_id)
select m.id, r.id
from public.household_members m
join public.household_roles r
  on r.household_id = m.household_id and r.code = 'MEMBER'
where m.is_active
  and not exists (
    select 1
    from public.member_role_assignments a
    join public.household_roles r2 on r2.id = a.role_id
    where a.member_id = m.id and r2.household_id = m.household_id
  )
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2-ter. Y el que llegue mañana tampoco nace sin rol
-- ---------------------------------------------------------------------------
--
-- El arrastre de la 2-bis arregla a los que YA están. Sin esto, la ficha que se
-- agregue pasado mañana volvería a nacer con cero roles — y con el guardián ya
-- estricto, eso ahora significa quedar FUERA del plan de su propia casa.
--
-- Es el mismo defecto de antes visto desde el otro lado: primero "sin rol"
-- quería decir "puede todo" y ahora querría decir "no puede nada". Ninguna de
-- las dos respuestas es buena, porque la pregunta está mal hecha. La salida es
-- que el estado "sin rol" DEJE DE EXISTIR.
--
-- Va como trigger y no dentro de los RPC a propósito: `household_members` se
-- escribe por PostgREST directo cuando se agrega a alguien de la familia que no
-- tiene cuenta, así que un chequeo dentro de una función no cubriría el camino
-- que más se usa.

create or replace function app.member_gets_default_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role uuid;
begin
  select id into v_role
  from public.household_roles
  where household_id = new.household_id and code = 'MEMBER';

  -- Si el hogar todavía no tiene roles, no hay nada que asignar y NO se
  -- inventa: es exactamente lo que pasa dentro de `create_household`, que
  -- inserta al fundador ANTES de sembrar la matriz de roles (0001:161-168) y
  -- acto seguido le pone ADMIN a mano. Ese camino ya se resuelve solo.
  if v_role is null then
    return new;
  end if;

  insert into public.member_role_assignments (member_id, role_id)
  values (new.id, v_role)
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists household_members_default_role on public.household_members;
create trigger household_members_default_role
  after insert on public.household_members
  for each row execute function app.member_gets_default_role();

comment on function app.member_gets_default_role() is
  'Toda ficha nueva nace con el rol MEMBER de su hogar. Los roles se suman, así '
  'que a quien se invita como PLANNER o COOK esto no le quita nada. Existe para '
  'que "sin ningún rol" no sea un estado alcanzable: mientras lo fuera, había '
  'que darle un significado, y los dos posibles estaban mal.';

-- ---------------------------------------------------------------------------
-- 3. RLS: mirar la semana es de todos; escribirla, no
-- ---------------------------------------------------------------------------
--
-- Las políticas de la 0007 (:344-359) eran `for all` con `is_household_member`
-- en las dos caras. Se parten en dos: SELECT para cualquier integrante (ver el
-- plan de la familia es parte de estar en la familia) y escritura para quien
-- puede editarlo. La app escribe estas tablas por PostgREST directo
-- (plan/actions.ts), así que la política ES el control, no un adorno.

drop policy if exists weekly_plans_all on public.weekly_plans;
drop policy if exists weekly_plans_select on public.weekly_plans;
create policy weekly_plans_select on public.weekly_plans
  for select to authenticated using (app.is_household_member(household_id));
drop policy if exists weekly_plans_insert on public.weekly_plans;
create policy weekly_plans_insert on public.weekly_plans
  for insert to authenticated with check (app.can_edit_plan(household_id));
drop policy if exists weekly_plans_update on public.weekly_plans;
create policy weekly_plans_update on public.weekly_plans
  for update to authenticated
  using (app.is_household_member(household_id))
  with check (app.can_edit_plan(household_id));
drop policy if exists weekly_plans_delete on public.weekly_plans;
create policy weekly_plans_delete on public.weekly_plans
  for delete to authenticated using (app.is_household_member(household_id));

drop policy if exists plan_days_all on public.weekly_plan_days;
drop policy if exists plan_days_select on public.weekly_plan_days;
create policy plan_days_select on public.weekly_plan_days
  for select to authenticated using (app.is_household_member(app.plan_household(plan_id)));
drop policy if exists plan_days_insert on public.weekly_plan_days;
create policy plan_days_insert on public.weekly_plan_days
  for insert to authenticated with check (app.can_edit_plan(app.plan_household(plan_id)));
drop policy if exists plan_days_update on public.weekly_plan_days;
create policy plan_days_update on public.weekly_plan_days
  for update to authenticated
  using (app.is_household_member(app.plan_household(plan_id)))
  with check (app.can_edit_plan(app.plan_household(plan_id)));
drop policy if exists plan_days_delete on public.weekly_plan_days;
create policy plan_days_delete on public.weekly_plan_days
  for delete to authenticated using (app.is_household_member(app.plan_household(plan_id)));

drop policy if exists assignments_all on public.meal_assignments;
drop policy if exists assignments_select on public.meal_assignments;
create policy assignments_select on public.meal_assignments
  for select to authenticated using (app.is_household_member(app.day_household(day_id)));
drop policy if exists assignments_insert on public.meal_assignments;
create policy assignments_insert on public.meal_assignments
  for insert to authenticated with check (app.can_edit_plan(app.day_household(day_id)));
drop policy if exists assignments_update on public.meal_assignments;
create policy assignments_update on public.meal_assignments
  for update to authenticated
  using (app.is_household_member(app.day_household(day_id)))
  with check (app.can_edit_plan(app.day_household(day_id)));
drop policy if exists assignments_delete on public.meal_assignments;
create policy assignments_delete on public.meal_assignments
  for delete to authenticated using (app.is_household_member(app.day_household(day_id)));

drop policy if exists events_all on public.nutrition_events;
drop policy if exists events_select on public.nutrition_events;
create policy events_select on public.nutrition_events
  for select to authenticated using (app.is_household_member(household_id));
drop policy if exists events_insert on public.nutrition_events;
create policy events_insert on public.nutrition_events
  for insert to authenticated with check (app.can_edit_plan(household_id));
drop policy if exists events_update on public.nutrition_events;
create policy events_update on public.nutrition_events
  for update to authenticated
  using (app.is_household_member(household_id))
  with check (app.can_edit_plan(household_id));
drop policy if exists events_delete on public.nutrition_events;
create policy events_delete on public.nutrition_events
  for delete to authenticated using (app.is_household_member(household_id));

drop policy if exists event_members_all on public.nutrition_event_members;
drop policy if exists event_members_select on public.nutrition_event_members;
create policy event_members_select on public.nutrition_event_members
  for select to authenticated
  using (exists (select 1 from public.nutrition_events e
                 where e.id = event_id and app.is_household_member(e.household_id)));
drop policy if exists event_members_insert on public.nutrition_event_members;
create policy event_members_insert on public.nutrition_event_members
  for insert to authenticated
  with check (exists (select 1 from public.nutrition_events e
                      where e.id = event_id and app.can_edit_plan(e.household_id)));
drop policy if exists event_members_update on public.nutrition_event_members;
create policy event_members_update on public.nutrition_event_members
  for update to authenticated
  using (exists (select 1 from public.nutrition_events e
                 where e.id = event_id and app.can_edit_plan(e.household_id)))
  with check (exists (select 1 from public.nutrition_events e
                      where e.id = event_id and app.can_edit_plan(e.household_id)));
drop policy if exists event_members_delete on public.nutrition_event_members;
create policy event_members_delete on public.nutrition_event_members
  for delete to authenticated
  using (exists (select 1 from public.nutrition_events e
                 where e.id = event_id and app.can_edit_plan(e.household_id)));

-- ---------------------------------------------------------------------------
-- 3-bis. Que te digan que no, en vez de que no pase nada
-- ---------------------------------------------------------------------------
--
-- ERROR != VACÍO, y las políticas de RLS por sí solas no lo cumplen.
--
-- Cuando `using` rechaza una fila, PostgreSQL no se queja: la fila simplemente
-- no entra al conjunto. Un DELETE denegado borra CERO filas y vuelve por
-- PostgREST como un éxito. La persona toca "quitar esta comida", no pasa
-- absolutamente nada, y la app no tiene cómo saber si es que no tenía permiso o
-- si la comida ya no estaba. Eso es el vacío leído como cero, con otra ropa.
--
-- El INSERT y el UPDATE sí gritan, porque `with check` levanta un error de
-- verdad ("new row violates row-level security policy"). Por eso arriba el
-- permiso quedó en el `with check` y el `using` volvió a ser "es de tu hogar":
-- así el rechazo llega como excepción y no como silencio.
--
-- El DELETE no tiene `with check` — no hay fila nueva que revisar — así que su
-- guarda tiene que ser un trigger. Es el único lugar donde se puede hablar.

create or replace function app.exigir_can_edit_plan()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_fila jsonb := to_jsonb(old);
  v_hogar uuid;
begin
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

drop trigger if exists weekly_plans_delete_guard on public.weekly_plans;
create trigger weekly_plans_delete_guard
  before delete on public.weekly_plans
  for each row execute function app.exigir_can_edit_plan();

drop trigger if exists plan_days_delete_guard on public.weekly_plan_days;
create trigger plan_days_delete_guard
  before delete on public.weekly_plan_days
  for each row execute function app.exigir_can_edit_plan();

drop trigger if exists assignments_delete_guard on public.meal_assignments;
create trigger assignments_delete_guard
  before delete on public.meal_assignments
  for each row execute function app.exigir_can_edit_plan();

-- Los eventos van por la misma puerta: borrar un asado del calendario cambia
-- los objetivos de toda la familia ese día, igual que borrar una comida.
drop trigger if exists events_delete_guard on public.nutrition_events;
create trigger events_delete_guard
  before delete on public.nutrition_events
  for each row execute function app.exigir_can_edit_plan();

comment on function app.exigir_can_edit_plan() is
  'Hace ruidoso el rechazo del DELETE. Sin esto, borrar sin permiso no falla: '
  'borra cero filas y vuelve como éxito, y quien lo intentó no se entera de que '
  'no pudo. El INSERT y el UPDATE ya gritan solos por el with check.';

-- ---------------------------------------------------------------------------
-- 4. Los RPC: la guarda va ENVOLVIENDO, no reescribiendo
-- ---------------------------------------------------------------------------
--
-- Los cuatro RPC de acá abajo son SECURITY DEFINER: corren como su dueña, así
-- que la RLS de la sección 3 no los toca. Necesitan su propio chequeo, igual
-- que el que la 0009 le puso a la compra.
--
-- Se hace moviendo la función viva al esquema `app` (que PostgREST no expone)
-- y dejando en `public` un envoltorio con el mismo nombre, la misma firma y
-- los mismos valores por omisión. POR QUÉ así y no copiando el cuerpo con la
-- línea nueva: `confirm_meal_assignment` va en su SEXTA versión (0007, 0008,
-- 0009, 0010, 0023 y 0025) y `consume_planned_meal` también. Copiar doscientas
-- líneas de candados FEFO para cambiar una sola es la forma más segura de
-- reintroducir a mano un bug que ya se arregló tres veces. El envoltorio
-- protege LO QUE HAYA, sea cual sea la versión que quedó arriba.
--
-- Si mañana alguien hace `create or replace function public.confirm_meal_...`,
-- pisa el envoltorio y se lleva la guarda puesta. Que quede dicho acá: quien
-- reescriba uno de estos cuatro nombres tiene que volver a poner el chequeo o
-- llamar a la versión de `app`.
--
-- El chequeo tampoco puede adelantarse al mensaje de la función envuelta: si
-- el id no existe, `assignment_household` devuelve NULL y quien contesta es la
-- de adentro, con su propio texto ('asignación inexistente'). ERROR != VACÍO,
-- y el contrato de errores no se cambia de contrabando en una migración de
-- permisos.

do $mover$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'confirm_meal_assignment'
  ) then
    alter function public.confirm_meal_assignment(uuid, jsonb) set schema app;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'unconfirm_meal_assignment'
  ) then
    alter function public.unconfirm_meal_assignment(uuid) set schema app;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'serve_meal_assignment'
  ) then
    alter function public.serve_meal_assignment(uuid, jsonb) set schema app;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'serve_off_plan'
  ) then
    alter function public.serve_off_plan(uuid, uuid, numeric, public.meal_type, text)
      set schema app;
  end if;
end;
$mover$;

-- Nadie entra por la puerta de atrás: al esquema `app` sólo se llega desde el
-- envoltorio, que es definer y corre como la dueña.
revoke all on function app.confirm_meal_assignment(uuid, jsonb) from public, anon, authenticated;
revoke all on function app.unconfirm_meal_assignment(uuid) from public, anon, authenticated;
revoke all on function app.serve_meal_assignment(uuid, jsonb) from public, anon, authenticated;
revoke all on function app.serve_off_plan(uuid, uuid, numeric, public.meal_type, text)
  from public, anon, authenticated;

-- Confirmar y desconfirmar congelan (o sueltan) las porciones planificadas: no
-- mueven un gramo todavía. Es trabajo de plan Y es trabajo de cocina, y quien
-- cocina llega muchas veces a cerrar la comida que después va a servir. Piden
-- CUALQUIERA de los dos permisos: exigir los dos dejaría a la cocinera sin
-- poder confirmar lo que tiene que servir.

create or replace function public.confirm_meal_assignment(
  p_assignment_id uuid,
  p_servings      jsonb
) returns int language plpgsql security definer set search_path = public as $$
declare v_household uuid;
begin
  v_household := app.assignment_household(p_assignment_id);
  if v_household is not null
     and not (app.can_edit_plan(v_household) or app.can_cook(v_household)) then
    raise exception 'no autorizado';
  end if;
  return app.confirm_meal_assignment(p_assignment_id, p_servings);
end;
$$;

create or replace function public.unconfirm_meal_assignment(p_assignment_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_household uuid;
begin
  v_household := app.assignment_household(p_assignment_id);
  if v_household is not null
     and not (app.can_edit_plan(v_household) or app.can_cook(v_household)) then
    raise exception 'no autorizado';
  end if;
  perform app.unconfirm_meal_assignment(p_assignment_id);
end;
$$;

-- Servir sí es física: la comida sale de la despensa y el libro mayor se
-- mueve. Acá manda `can_cook` y nada más.

create or replace function public.serve_meal_assignment(
  p_assignment_id uuid,
  p_items         jsonb default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_household uuid;
begin
  v_household := app.assignment_household(p_assignment_id);
  if v_household is not null and not app.can_cook(v_household) then
    raise exception 'no autorizado';
  end if;
  return app.serve_meal_assignment(p_assignment_id, p_items);
end;
$$;

-- `serve_off_plan` es el mismo acto sin plan detrás (0036: "sigue siendo un
-- acto de SERVIR"), y `use_lot` entra por ahí, así que queda cubierta sola.
-- Igual `consume_planned_meal`, que desde la 0036 sólo llama a
-- `serve_meal_assignment`.

create or replace function public.serve_off_plan(
  p_member_id uuid,
  p_lot_id    uuid,
  p_quantity  numeric default null,
  p_meal_type public.meal_type default null,
  p_notes     text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_household uuid;
begin
  v_household := app.member_household(p_member_id);
  if v_household is not null and not app.can_cook(v_household) then
    raise exception 'no autorizado';
  end if;
  return app.serve_off_plan(p_member_id, p_lot_id, p_quantity, p_meal_type, p_notes);
end;
$$;

comment on function public.confirm_meal_assignment(uuid, jsonb) is
  'Envoltorio de permisos (0039): pide can_edit_plan o can_cook y delega en '
  'app.confirm_meal_assignment, que es la función real.';
comment on function public.unconfirm_meal_assignment(uuid) is
  'Envoltorio de permisos (0039): pide can_edit_plan o can_cook.';
comment on function public.serve_meal_assignment(uuid, jsonb) is
  'Envoltorio de permisos (0039): mover la despensa pide can_cook.';
comment on function public.serve_off_plan(uuid, uuid, numeric, public.meal_type, text) is
  'Envoltorio de permisos (0039): mover la despensa pide can_cook.';
