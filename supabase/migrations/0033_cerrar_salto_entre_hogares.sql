-- 0033 — Cerrar el salto entre hogares (y la fuga médica que abría).
--
-- HALLAZGO (auditoría sobre código YA APLICADO EN PRODUCCIÓN). La política
-- `members_update` de 0001_family.sql:268 dejaba pasar CUALQUIER columna:
--
--   using      (user_id = auth.uid() or app.is_household_admin(household_id))
--   with check (user_id = auth.uid() or app.is_household_admin(household_id))
--
-- USING se evalúa sobre la fila VIEJA y WITH CHECK sobre la fila NUEVA. Si la
-- fila es la mía, las dos siguen siendo verdaderas pase lo que pase con el
-- resto de las columnas: la política autoriza la fila, nunca el cambio. No
-- congelaba ninguna columna y no había trigger ni revoke que la respaldara
-- (el único trigger de ese estilo en las 32 migraciones era
-- `profiles_immutable`, 0005:321, y el único revoke era sobre `audit_events`,
-- 0001:111). Tres ataques reales, todos por PostgREST y sin pasar por ningún
-- RPC:
--
--   (a) SALTO ENTRE HOGARES. Un integrante común hace PATCH sobre SU PROPIA
--       fila con {"household_id": "<hogar ajeno>"}. Pasa USING y pasa WITH
--       CHECK. Desde ahí `app.is_household_member(hogar ajeno)` da true y se
--       abre el otro hogar entero: plan, compras, inventario, salud. El
--       household_id no es un secreto — viaja en el HTML de /family.
--
--   (b) AUTO-REACTIVACIÓN. {"is_active": true} y quien fue dado de baja
--       vuelve solo. La baja de un integrante dejaba de ser una decisión de
--       quien administra el hogar.
--
--   (c) FUGA MÉDICA. Un ADMIN hace PATCH sobre la fila de OTRA persona con
--       {"user_id": null}. La tercera rama de `app.medical_access`
--       (0028:72-77) concede acceso cuando el integrante NO tiene cuenta
--       vinculada y quien pregunta es admin del hogar — la rama "tutor", que
--       existe para que alguien pueda subir los exámenes de un dependiente.
--       Desvinculando la cuenta a la fuerza, el admin se convertía en tutor de
--       un adulto con cuenta propia y ganaba lectura de `lab_documents`,
--       `lab_observations`, `member_conditions` y
--       `member_clinical_restrictions` SIN ningún grant. De paso, la persona
--       quedaba fuera de su propio hogar.
--
-- CIERRE EN CUATRO CAPAS INDEPENDIENTES. Una sola no basta: la política vieja
-- era exactamente eso, una capa sola, y bastó con que se le escapara el
-- concepto de "columna" para abrir tres puertas.
--
--   · PRIVILEGIOS (§3): `authenticated` deja de tener UPDATE sobre la tabla y
--     recibe solo la lista blanca de columnas que la app edita de verdad.
--   · POLÍTICAS (§4): se separa "yo edito mi ficha" de "quien administra edita
--     el hogar", y `is_active` queda del lado de admin.
--   · TRIGGER (§2): aunque mañana alguien devuelva el grant por descuido, la
--     identidad de la fila (hogar y cuenta) no se mueve desde un cliente.
--   · DATO (§1 y §5): la rama tutor deja de leerse del `user_id` de HOY — que
--     es justamente lo que el atacante manipulaba — y pasa a leerse de un sello
--     monótono que dice si esa ficha TUVO cuenta alguna vez.
--
-- Nada de esto toca `accept_invitation` (0001:191): es SECURITY DEFINER, corre
-- como dueña de la tabla, así que ni los privilegios de columna ni el trigger
-- de cliente la afectan. Sigue siendo el ÚNICO camino que vincula una cuenta a
-- una ficha, y ahora además es el único posible.
--
-- Migración idempotente y segura de re-aplicar.

-- ---------------------------------------------------------------------------
-- 1. El sello: ¿esta ficha tuvo cuenta alguna vez?
--
-- POR QUÉ UNA COLUMNA NUEVA Y NO UNA CONSULTA MÁS ASTUTA. La rama tutor
-- necesita responder "esta persona nunca tuvo cuenta propia, así que alguien
-- del hogar tiene que poder manejar sus exámenes". Hoy lo deduce de
-- `user_id is null`, que es un estado del PRESENTE y editable. Cualquier
-- verificación que dependa del presente se puede fabricar; hay que anclarla a
-- un hecho del PASADO, y el pasado no se edita.
--
-- POR QUÉ timestamptz Y NO UN BOOLEAN `nunca_tuvo_cuenta`. Tres razones:
--   · Es MONÓTONO por naturaleza: se estampa una vez y jamás vuelve a null.
--     Un boolean invita a que alguien lo "corrija" a mano; una fecha de
--     vinculación que retrocede se ve mal a simple vista.
--   · Cubre el caso de la cuenta BORRADA. `user_id` es
--     `references auth.users on delete set null` (0001:23): si mañana se borra
--     la cuenta de un adulto, su `user_id` vuelve a null solo. Con un boolean
--     mal pensado esa persona se convertiría en "dependiente" y su historia
--     clínica quedaría abierta para quien administra el hogar. Con el sello,
--     NO: tuvo cuenta, y sus datos siguen siendo suyos.
--   · Sirve de auditoría: deja registrado CUÁNDO se vinculó, que es
--     información que hoy no existe en ninguna parte.
--
-- La columna la escribe SOLO el trigger de más abajo. Ningún cliente la toca:
-- no está en la lista blanca de UPDATE y el trigger la reescribe en INSERT.
-- ---------------------------------------------------------------------------

alter table public.household_members
  add column if not exists account_linked_at timestamptz;

comment on column public.household_members.account_linked_at is
  'Cuándo se vinculó una cuenta de auth a esta ficha. NULL = NUNCA tuvo cuenta '
  '(dependiente: recién ahí aplica la rama tutor de app.medical_access). '
  'Monótono: una vez estampado no vuelve a NULL, ni siquiera si se borra la '
  'cuenta y user_id queda en NULL. Lo escribe solo app.stamp_member_account_link.';

-- Relleno de lo que ya existe. Para las fichas que HOY tienen cuenta el
-- instante exacto no lo sabemos: `updated_at` es la mejor aproximación (para
-- las creadas por `create_household` coincide con `created_at`; para las
-- vinculadas por `accept_invitation` es el momento del vínculo, salvo que se
-- hayan renombrado después). Lo que importa acá no es el reloj: es que quede
-- NO NULO, porque eso es lo que cierra la rama tutor.
update public.household_members
set account_linked_at = coalesce(updated_at, created_at, now())
where user_id is not null and account_linked_at is null;

-- ---------------------------------------------------------------------------
-- 2. Trigger: la identidad de una ficha no se mueve desde un cliente.
--
-- Defensa en profundidad, en el mismo espíritu de `app.protect_medical_restrictions`
-- (0006:173): si el candado vive solo en la política, el primer grant mal dado
-- lo salta. `current_user = 'authenticated'` es la misma prueba que usa esa
-- función: dentro de un SECURITY DEFINER el usuario actual es la dueña de la
-- tabla, así que `accept_invitation` y `create_household` pasan de largo, y un
-- PATCH de PostgREST no.
-- ---------------------------------------------------------------------------

create or replace function app.freeze_member_identity()
returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.household_id is distinct from old.household_id then
      raise exception 'Un integrante no cambia de hogar: se invita al hogar nuevo'
        using errcode = 'insufficient_privilege';
    end if;
    if new.user_id is distinct from old.user_id then
      raise exception 'La cuenta de un integrante solo se vincula aceptando una invitación'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists members_identity_frozen on public.household_members;
create trigger members_identity_frozen
  before update on public.household_members
  for each row execute function app.freeze_member_identity();

-- El sello lo pone la base, no quien escribe. Un solo dueño por dato: esta
-- función es la única que escribe `account_linked_at`, en cualquier camino
-- (RPC, service role o cliente).
create or replace function app.stamp_member_account_link()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.account_linked_at := case when new.user_id is not null then now() end;
    return new;
  end if;

  if old.account_linked_at is not null then
    -- Ya tuvo cuenta: el sello es historia y la historia no se reescribe.
    new.account_linked_at := old.account_linked_at;
  elsif new.user_id is not null then
    new.account_linked_at := now();
  else
    new.account_linked_at := null;
  end if;
  return new;
end;
$$;

-- Los triggers de la misma operación corren en orden alfabético:
-- `members_identity_frozen` < `members_stamp_account_link`, así que primero se
-- rechaza lo prohibido y recién después se estampa.
drop trigger if exists members_stamp_account_link on public.household_members;
create trigger members_stamp_account_link
  before insert or update on public.household_members
  for each row execute function app.stamp_member_account_link();

-- ---------------------------------------------------------------------------
-- 3. Privilegios de columna: lista blanca en vez de tabla completa.
--
-- Lo que pide la corrección es `revoke update (user_id, household_id)`. Escrito
-- solo, NO HACE NADA: PostgreSQL no puede revocar por columna un privilegio que
-- el rol tiene a nivel de TABLA (`alter default privileges ... grant update on
-- tables to authenticated`, que es lo que Supabase deja de fábrica). La forma
-- que sí funciona es quitar el privilegio de tabla y devolver SOLO las columnas
-- que la aplicación edita de verdad. El revoke explícito queda igual, más abajo,
-- como declaración de intención y como red por si alguien vuelve a otorgar la
-- tabla entera.
--
-- La lista blanca es exactamente lo que hoy escribe la app: `renameMember`
-- (web/src/app/family/nutrition-actions.ts:461) manda display_name y
-- updated_at; el resto son los campos de la ficha. `service_role` conserva sus
-- privilegios: corre fuera de RLS y es la vía de soporte.
-- ---------------------------------------------------------------------------

revoke update (user_id, household_id) on public.household_members from authenticated;
revoke update (user_id, household_id) on public.household_members from anon;

revoke update on public.household_members from authenticated;
revoke update on public.household_members from anon;

grant update (
  display_name,
  photo_url,
  birth_date,
  sex,
  height_cm,
  activity_level,
  is_active,
  updated_at
) on public.household_members to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Políticas: una para "mi ficha", otra para "quien administra el hogar".
--
-- La política vieja mezclaba los dos permisos en una sola expresión con OR, y
-- así perdía la diferencia entre ellos. Separadas:
--
--   · members_update_self — edito MI ficha, y solo mientras estoy activo.
--     `is_active` aparece en USING (fila vieja) y en WITH CHECK (fila nueva):
--     en USING impide que alguien dado de baja se toque su propia fila para
--     reactivarse (ataque (b)); en WITH CHECK impide que se dé de baja solo y
--     deje al hogar sin quien administre. Dar de baja y reactivar son
--     decisiones de administración, no de la persona.
--
--   · members_update_admin — quien administra el hogar edita las fichas del
--     hogar, incluida `is_active`. Como la condición se evalúa en USING (fila
--     vieja) y en WITH CHECK (fila nueva), mover una ficha a otro hogar exigiría
--     ser admin de los dos; igual está prohibido por el trigger (§2) y por los
--     privilegios de columna (§3).
--
-- Ambas van `to authenticated`: `anon` no tiene nada que hacer acá y ya no
-- tiene privilegio de UPDATE.
-- ---------------------------------------------------------------------------

drop policy if exists members_update on public.household_members;
drop policy if exists members_update_self on public.household_members;
drop policy if exists members_update_admin on public.household_members;

create policy members_update_self on public.household_members
  for update to authenticated
  using (user_id = auth.uid() and is_active)
  with check (user_id = auth.uid() and is_active);

create policy members_update_admin on public.household_members
  for update to authenticated
  using (app.is_household_admin(household_id))
  with check (app.is_household_admin(household_id));

-- El INSERT queda como estaba (`members_insert`, 0001:266: solo quien
-- administra el hogar). No hace falta prohibir que se cree una ficha con
-- `user_id`: crear una ficha ya vinculada no le entrega a nadie los datos de esa
-- cuenta, y desde este cambio esa ficha nace SELLADA — o sea, jamás va a poder
-- hacerse pasar por dependiente para caer en la rama tutor. Lo que sí quedó
-- cerrado es la mudanza posterior, que era el ataque real.

-- ---------------------------------------------------------------------------
-- 5. La rama tutor deja de depender del presente.
--
-- Un solo dueño para la regla: antes vivía copiada en tres lugares
-- (`app.medical_access`, `app.can_manage_medical_grants` y la política
-- `medical_grants_select`, 0026:157-166 / 0028:72-89). Tres copias de una regla
-- de privacidad son tres oportunidades de arreglar dos.
--
-- La condición nueva exige LAS DOS COSAS: no tener cuenta hoy Y no haberla
-- tenido nunca. La primera es la regla de producto (un dependiente); la segunda
-- es la que no se puede fabricar.
-- ---------------------------------------------------------------------------

/**
 * ¿Soy tutor de este integrante? Solo si esa ficha NUNCA tuvo cuenta propia
 * (account_linked_at is null) y yo administro su hogar. Los roles del hogar no
 * dan acceso médico a nadie más: esta es la única excepción, y existe porque
 * alguien tiene que poder subir y confirmar los exámenes de quien no tiene
 * cuenta (una guagua, un adulto mayor a cargo).
 */
create or replace function app.is_medical_tutor(p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members owner_m
    where owner_m.id = p_owner
      and owner_m.user_id is null
      and owner_m.account_linked_at is null
      and app.is_household_admin(owner_m.household_id)
  );
$$;

/**
 * Acceso médico efectivo (ADR 0012 §2). Los roles del hogar NO cuentan:
 *  1. self — mis propios datos;
 *  2. grant activo del dueño hacia un integrante vinculado a mi usuario;
 *  3. tutor: la ficha nunca tuvo cuenta y yo administro su hogar.
 */
create or replace function app.medical_access(p_owner uuid, p_permission public.medical_permission)
returns boolean language sql stable security definer set search_path = public as $$
  select app.is_self_member(p_owner)
    or exists (
      select 1
      from public.medical_data_grants g
      join public.household_members me on me.id = g.grantee_member_id
      where g.owner_member_id = p_owner
        and g.permission = p_permission
        and g.revoked_at is null
        and me.user_id = auth.uid()
    )
    or app.is_medical_tutor(p_owner);
$$;

/** ¿Puedo ADMINISTRAR los grants de este dueño? (self o tutor). */
create or replace function app.can_manage_medical_grants(p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select app.is_self_member(p_owner) or app.is_medical_tutor(p_owner);
$$;

-- Ver grants: el dueño, el receptor, o el tutor del dueño (misma regla, una
-- sola fuente).
drop policy if exists medical_grants_select on public.medical_data_grants;
create policy medical_grants_select on public.medical_data_grants
  for select to authenticated
  using (
    app.is_self_member(owner_member_id)
    or app.is_self_member(grantee_member_id)
    or app.is_medical_tutor(owner_member_id)
  );
