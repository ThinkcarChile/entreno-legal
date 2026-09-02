-- 0060 — Lo que el pre-vuelo encontró DESPUÉS de que las 19 llegaran a producción.
--
-- El 2026-09-02 se aplicaron la 0039→0058. Antes de hacerlo corrió un ensayo
-- sobre el estado real de producción (con datos) y un análisis adversarial de
-- 211 agentes: 64 riesgos propuestos, 42 refutados, 22 sobrevivientes. Uno era
-- el borrado en cascada (0059). Éstos son los otros que resultaron VIVOS al
-- verificarlos contra la base real, cada uno con su evidencia:
--
--   [16] `purge_assistant_conversations()` era ejecutable por cualquier usuario
--        autenticado. `has_function_privilege('authenticated', ...)` = TRUE en
--        producción. El revoke de la 0054 nombraba `anon, authenticated` y
--        omitía PUBLIC — y PostgreSQL le da EXECUTE a PUBLIC por defecto en toda
--        función nueva. Revocar a dos roles con nombre no toca ese grant.
--   [15] Tres políticas hijas dejaban que cualquier integrante escribiera el
--        perfil de cualquier otro: `pattern_slots_all`, `profiles_insert` y
--        `profiles_update` usaban `can_access_member` (= es del hogar) mientras
--        la 0050 cerró las tablas padre con `puede_editar_perfil` (= es el
--        propio o un admin). Verificado en pg_policies de producción.
--   [9]  `allocations_are_append_only` perdonaba sólo el DELETE en cascada. Pero
--        las FK de member_id / assignment_id / consumption_log_id son
--        `on delete set null`: un UPDATE en cascada. Borrar a un integrante con
--        un costo asignado moría con "las asignaciones de costo son append-only".
--   [20] `uso_no_se_edita` perdonaba el DELETE sólo si el HOGAR desapareció; la
--        FK cascadea desde el INTEGRANTE. Borrar a una persona con consumo del
--        asistente moría con "borrarlo es devolver plata".
--   [18] `assistant_inbox_items.resolved_by` era una FK sin acción (NO ACTION,
--        `confdeltype = 'a'` en producción): borrar al integrante que resolvió
--        un item de la bandeja fallaba. Las otras tres FK `resolved_by` del
--        repo ya eran SET NULL; ésta quedó distinta por omisión.
--   [3]  El rol MEMBER por defecto se ponía en INSERT y en el arrastre de
--        activos. Reactivar a alguien desactivado lo dejaba "sin ningún rol",
--        el estado que la 0039 existe para hacer inalcanzable. Producción tenía
--        0 casos; se cierra igual, porque la puerta estaba abierta.
--
-- Los tres de la clase cascada ([9], [20], [18]) usan la misma marca que la
-- 0059 y que el repo desde la 0011: `pg_trigger_depth() > 1` = "esto viene de
-- una acción referencial, no del cliente". Ver la cabecera de la 0059.

-- ---------------------------------------------------------------------------
-- [16] PUBLIC también, o el revoke no revoca nada.
-- ---------------------------------------------------------------------------
revoke execute on function public.purge_assistant_conversations() from public, anon, authenticated;

comment on function public.purge_assistant_conversations() is
  'Purga conversaciones vencidas. La ejecuta SOLO el dueno (postgres) o un job '
  'con service_role: la 0060 le quito el EXECUTE a PUBLIC, que PostgreSQL da por '
  'defecto y que el revoke de la 0054 —a anon y authenticated por nombre— no tocaba.';

-- ---------------------------------------------------------------------------
-- [15] Escribir un perfil exige poder EDITARLO, no sólo verlo.
-- ---------------------------------------------------------------------------
-- `can_access_member` responde "es de tu hogar"; `puede_editar_perfil` responde
-- "es el tuyo, o eres admin" (0050). Leer sigue siendo de todos; escribir no.

drop policy if exists pattern_slots_all on public.meal_pattern_slots;
create policy pattern_slots_select on public.meal_pattern_slots
  for select to authenticated
  using (exists (
    select 1 from public.meal_patterns p
    where p.id = meal_pattern_slots.pattern_id and app.can_access_member(p.member_id)));
create policy pattern_slots_write on public.meal_pattern_slots
  for all to authenticated
  using (exists (
    select 1 from public.meal_patterns p
    where p.id = meal_pattern_slots.pattern_id and app.puede_editar_perfil(p.member_id)))
  with check (exists (
    select 1 from public.meal_patterns p
    where p.id = meal_pattern_slots.pattern_id and app.puede_editar_perfil(p.member_id)));

drop policy if exists profiles_insert on public.member_nutrition_profiles;
create policy profiles_insert on public.member_nutrition_profiles
  for insert to authenticated
  with check (app.puede_editar_perfil(member_id));

drop policy if exists profiles_update on public.member_nutrition_profiles;
create policy profiles_update on public.member_nutrition_profiles
  for update to authenticated
  using (app.puede_editar_perfil(member_id))
  with check (app.puede_editar_perfil(member_id));

-- ---------------------------------------------------------------------------
-- [18] La bandeja no impide borrar a quien resolvió un item.
-- ---------------------------------------------------------------------------
-- El nombre de la FK lo puso Postgres (la 0056 la declaró inline), así que se
-- busca en el catálogo en vez de adivinarlo.
do $fk$
declare v_nombre text;
begin
  select c.conname into v_nombre
    from pg_constraint c
   where c.contype = 'f'
     and c.conrelid = 'public.assistant_inbox_items'::regclass
     and exists (
       select 1 from pg_attribute a
        where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
          and a.attname = 'resolved_by');
  if v_nombre is not null then
    execute format('alter table public.assistant_inbox_items drop constraint %I', v_nombre);
  end if;
  alter table public.assistant_inbox_items
    add constraint assistant_inbox_items_resolved_by_fkey
    foreign key (resolved_by) references public.household_members (id) on delete set null;
end;
$fk$;

-- ---------------------------------------------------------------------------
-- [9] Append-only también tiene que perdonar el SET NULL de una cascada.
-- ---------------------------------------------------------------------------
create or replace function app.allocations_are_append_only()
returns trigger language plpgsql as $$
begin
  -- Una accion referencial (cascada, SET NULL) no es una edicion de la historia:
  -- es la historia soltando una referencia a algo que ya no existe. El monto,
  -- la categoria y la fecha quedan intactos; solo se anula el puntero.
  if pg_trigger_depth() > 1 then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  raise exception
    'las asignaciones de costo son append-only: una corrección es una fila nueva (CORRECTION), no una edición de la historia';
end;
$$;

-- ---------------------------------------------------------------------------
-- [20] El consumo del asistente se va con la persona, no sólo con el hogar.
-- ---------------------------------------------------------------------------
create or replace function app.uso_no_se_edita()
returns trigger language plpgsql set search_path = public as $$
begin
  -- CASCADA (desde households O desde household_members): ver cabecera de la 0059.
  if pg_trigger_depth() > 1 then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  if not exists (select 1 from public.households where id = old.household_id) then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'el consumo del asistente no se borra: borrarlo es devolver plata que ya se gastó'
      using errcode = 'check_violation';
  end if;
  if old.liquidada_at is not null then
    raise exception 'esta reserva ya está liquidada' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- [3] Reactivar a alguien también le da su rol.
-- ---------------------------------------------------------------------------
-- La misma función de la 0039: inserta MEMBER con `on conflict do nothing`, así
-- que dispararla de nuevo sobre quien ya lo tiene no hace nada.
drop trigger if exists household_members_role_on_reactivate on public.household_members;
create trigger household_members_role_on_reactivate
  after update of is_active on public.household_members
  for each row
  when (new.is_active and not old.is_active)
  execute function app.member_gets_default_role();

-- Y el arrastre, esta vez sin filtrar por activos: un rol no es un privilegio
-- que se pierda por estar de viaje.
insert into public.member_role_assignments (member_id, role_id)
select m.id, r.id
  from public.household_members m
  join public.household_roles r on r.household_id = m.household_id and r.code = 'MEMBER'
 where not exists (select 1 from public.member_role_assignments a where a.member_id = m.id)
on conflict do nothing;
