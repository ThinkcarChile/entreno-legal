-- 0037 — La invitación era la ventana abierta del salto entre hogares.
--
-- HALLAZGO (lente de ataque, tras aplicar la 0033):
--
-- La 0033 cerró el salto entre hogares por la puerta: quitó el privilegio de
-- UPDATE sobre `user_id` y `household_id`, partió la política en dos y puso un
-- trigger que rechaza el cambio de identidad. Los tres ataques por PATCH
-- directo rebotan.
--
-- Pero `public.accept_invitation` (0001:191) es SECURITY DEFINER: corre como
-- dueña de la tabla, así que ni el revoke de columnas ni el trigger la alcanzan
-- — y por diseño, porque es la ÚNICA vía legítima para vincular una cuenta.
--
-- El problema es que nunca verificó que el integrante invitado sea del hogar
-- que invita:
--
--   update public.household_members
--   set user_id = auth.uid()
--   where id = v_inv.invited_member_id and user_id is null;
--
-- Y la política `invitations_admin` (0001:294) valida `household_id` pero deja
-- `invited_member_id` libre. La cadena completa:
--
--   1. El admin del hogar A crea una invitación con household_id = A
--      (permitido) e invited_member_id = una ficha SIN CUENTA del hogar B.
--   2. Quien acepta esa invitación queda vinculado a la ficha de B.
--   3. Desde ahí `app.is_household_member(B)` da verdadero y el hogar B queda
--      abierto entero.
--
-- Las fichas sin cuenta no son un caso raro: son un requisito del producto —
-- un integrante puede existir sin cuenta propia y vinculársela después. O sea
-- el blanco del ataque siempre está disponible.
--
-- CORRECCIÓN, en dos capas:
--
--   a) `accept_invitation` exige que el integrante invitado pertenezca al hogar
--      de la invitación. Es la que muerde.
--   b) Un trigger sobre `invitations` rechaza crear o mover una invitación que
--      apunte fuera de su propio hogar. Ataja el ataque un paso antes, cuando
--      todavía es una fila y no un vínculo.
--
-- El mensaje de error no distingue "el integrante no existe" de "es de otro
-- hogar": las dos cosas responden igual, para no confirmarle a nadie que una
-- ficha ajena existe.

-- ---------------------------------------------------------------------------
-- a) La invitación no puede vincular una ficha de otro hogar
-- ---------------------------------------------------------------------------

create or replace function public.accept_invitation(p_token_hash text, p_display_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_inv public.invitations;
  v_member uuid;
  v_role uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_inv from public.invitations
  where token_hash = p_token_hash
    and accepted_at is null and revoked_at is null and expires_at > now()
  for update;

  if not found then
    raise exception 'invitation invalid or expired';
  end if;

  if v_inv.invited_member_id is not null then
    -- LA GUARDA NUEVA. `and household_id = v_inv.household_id` es todo el
    -- arreglo: sin esa condición, una invitación del hogar A podía vincular
    -- una cuenta a una ficha del hogar B y abrirlo entero.
    --
    -- Va dentro del mismo UPDATE y no en un `select` previo a propósito: la
    -- fila ya quedó bloqueada por el `for update` de la invitación, y
    -- resolverlo en una sola sentencia evita la ventana entre comprobar y
    -- escribir.
    update public.household_members
    set user_id = auth.uid(), updated_at = now()
    where id = v_inv.invited_member_id
      and household_id = v_inv.household_id
      and user_id is null
    returning id into v_member;

    if v_member is null then
      -- Un solo mensaje para los tres casos posibles (no existe, es de otro
      -- hogar, ya tiene cuenta). Distinguirlos le confirmaría a quien ataca
      -- que la ficha ajena existe.
      raise exception 'invitation invalid or expired';
    end if;
  else
    insert into public.household_members (household_id, user_id, display_name)
    values (v_inv.household_id, auth.uid(), coalesce(nullif(p_display_name, ''), 'Integrante'))
    returning id into v_member;
  end if;

  select id into v_role from public.household_roles
  where household_id = v_inv.household_id and code = v_inv.role_code;
  if v_role is not null then
    insert into public.member_role_assignments (member_id, role_id, granted_by)
    values (v_member, v_role, v_inv.created_by)
    on conflict do nothing;
  end if;

  update public.invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = v_inv.id;

  insert into public.audit_events (household_id, actor_user_id, action, subject_kind, subject_id)
  values (v_inv.household_id, auth.uid(), 'INVITATION_ACCEPTED', 'invitation', v_inv.id);

  return v_inv.household_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- b) Y tampoco se puede CREAR una invitación que apunte fuera de su hogar
-- ---------------------------------------------------------------------------

/**
 * Defensa en profundidad: ataja el ataque cuando todavía es una fila, no un
 * vínculo ya hecho.
 *
 * La política `invitations_admin` valida `household_id` pero no puede validar
 * la coherencia entre dos columnas de tablas distintas — para eso hace falta un
 * trigger.
 */
create or replace function app.invitation_member_same_household()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.invited_member_id is not null
     and not exists (
       select 1 from public.household_members m
       where m.id = new.invited_member_id
         and m.household_id = new.household_id
     ) then
    raise exception 'invitation invalid or expired'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists invitations_member_same_household on public.invitations;
create trigger invitations_member_same_household
  before insert or update on public.invitations
  for each row execute function app.invitation_member_same_household();

comment on function public.accept_invitation(text, text) is
  'Vincula una cuenta a una ficha de integrante. Desde la 0037 exige que la '
  'ficha invitada pertenezca al hogar de la invitación: sin esa condición, un '
  'admin podía crear una invitación en su hogar apuntando a una ficha sin '
  'cuenta de OTRO hogar y abrirlo entero.';
