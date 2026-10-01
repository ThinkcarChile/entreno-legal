-- =============================================================================
-- HagoTuFila · Nombre y foto de perfil validados en la base
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado sobre la base: `authenticated`
-- tiene UPDATE sobre `profiles.first_name` y `profiles.avatar_url`, y ninguna
-- de las dos columnas tenía otra regla que `not null`. El nombre entra tal cual
-- en el texto de los avisos —«Camila F. envió una oferta para …»—, así que un
-- nombre como «HagoTuFila: tu pago fue rechazado, entra a pagos-htf.cl» se leía
-- como un aviso de la plataforma en la bandeja del cliente. Y `avatar_url`
-- admitía cualquier URL: una imagen servida desde un dominio ajeno que se carga
-- en el navegador de todo el que mira el perfil.
--
-- Qué cambia:
--
--   * `first_name`: sin espacios al borde ni dobles, de 1 a 60 caracteres, sin
--     saltos de línea ni caracteres de control o invisibles, sin direcciones
--     web ni correos, y sin «HagoTuFila». Restricción CHECK: vale para el
--     UPDATE directo, para las RPC y para la clave de servicio.
--   * `last_name_initial`: una sola letra.
--   * `avatar_url`: guarda la RUTA dentro del bucket `avatars`, y solo la de
--     la propia carpeta: `<id del perfil>/<nombre>.jpg|png|webp`. La URL
--     pública la arma la aplicación con la dirección de su propio proyecto
--     (src/lib/storage/avatars.ts), así que un perfil ya no puede apuntar a
--     otro dominio ni a la foto de otra persona. Los valores existentes que
--     eran la URL pública de la propia carpeta se convierten en ruta; el resto
--     se descarta.
--   * Los avisos citan el nombre entre comillas angulares —«Camila F.»— para
--     que se lea como un dato, no como parte del mensaje de la plataforma.
--   * El alta (`handle_new_user`) limpia el nombre en vez de fallar: un nombre
--     que no pasa la regla no puede bloquear un registro. Queda «Usuario», y
--     el onboarding lo pide de nuevo.
--   * `complete_onboarding` devuelve un motivo legible en vez del nombre de
--     la restricción.
--
-- Antes de crear las restricciones se normalizan los datos existentes, para
-- que la migración no falle sobre un proyecto ya en uso.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Las reglas, en un solo lugar
-- -----------------------------------------------------------------------------
-- Caracteres de control C0 y C1, espacios no separables y de ancho fijo,
-- guion suave, marcas de dirección (pueden invertir el texto en pantalla) y
-- caracteres de ancho cero.
create or replace function app_private.person_name_problem(p_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_name is null or char_length(p_name) = 0
      then 'Ingresa tu nombre.'
    when char_length(p_name) > 60
      then 'El nombre admite hasta 60 caracteres.'
    when p_name ~ '[\x01-\x1f\x7f-\x9f\u00a0\u00ad\u061c\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]'
      then 'El nombre no puede tener saltos de línea, tabulaciones ni caracteres invisibles.'
    when p_name <> btrim(p_name) or p_name like '%  %'
      then 'El nombre no puede empezar ni terminar con espacios, ni tener espacios dobles.'
    when p_name ~* '(://|www\.|@|[a-z0-9-]\.[a-z]{2,})'
      then 'El nombre no puede incluir direcciones web ni correos.'
    when lower(p_name) like '%hagotufila%'
      then 'El nombre no puede incluir «HagoTuFila».'
  end;
$$;

comment on function app_private.person_name_problem(text) is
  'NULL si el nombre es válido; si no, el motivo en palabras. Misma regla que src/lib/validation/profile.ts.';

-- Una letra de cualquier alfabeto: se descartan los rangos que no lo son
-- (ASCII no alfabético, controles, puntuación latina, puntuación general y
-- la de CJK) en vez de enumerar alfabetos.
create or replace function app_private.is_valid_initial(p_initial text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_initial is null
      or (char_length(p_initial) = 1
          and p_initial !~ '[\x01-\x40\x5b-\x60\x7b-\xbf\xd7\xf7\u2000-\u206f\u3000-\u303f\ufeff]');
$$;

create or replace function app_private.is_own_avatar_path(p_user_id uuid, p_path text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_path is null
      or p_path ~ ('^' || p_user_id::text || '/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$');
$$;

comment on function app_private.is_own_avatar_path(uuid, text) is
  'La foto de perfil es una ruta dentro de la carpeta del propio usuario en el bucket avatars.';

-- Lo que hace el alta con un nombre que no pasa la regla: lo limpia y, si aun
-- así no sirve, deja «Usuario».
create or replace function app_private.clean_person_name(p_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when app_private.person_name_problem(limpio) is null then limpio else 'Usuario' end
    from (
      select btrim(left(btrim(regexp_replace(
               regexp_replace(coalesce(p_name, ''),
                 '[\x01-\x1f\x7f-\x9f\u00a0\u00ad\u061c\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]',
                 ' ', 'g'),
               ' {2,}', ' ', 'g')), 60)) as limpio
    ) s;
$$;

-- Las tres primeras las evalúan las restricciones CHECK de abajo, y una CHECK
-- se evalúa con los privilegios de quien escribe la fila: el usuario que edita
-- su perfil y la clave de servicio necesitan EXECUTE. Son funciones puras que
-- no leen ninguna tabla.
revoke all on function app_private.person_name_problem(text) from public, anon;
revoke all on function app_private.is_valid_initial(text) from public, anon;
revoke all on function app_private.is_own_avatar_path(uuid, text) from public, anon;
grant execute on function app_private.person_name_problem(text) to authenticated, service_role;
grant execute on function app_private.is_valid_initial(text) to authenticated, service_role;
grant execute on function app_private.is_own_avatar_path(uuid, text) to authenticated, service_role;
revoke all on function app_private.clean_person_name(text) from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. Datos existentes
-- -----------------------------------------------------------------------------
update public.profiles
   set first_name = app_private.clean_person_name(first_name)
 where app_private.person_name_problem(first_name) is not null;

update public.profiles
   set last_name_initial = null
 where not app_private.is_valid_initial(last_name_initial::text);

-- La URL pública de la propia carpeta se convierte en ruta; cualquier otra cosa
-- —otro dominio, la carpeta de otra persona— se descarta.
update public.profiles
   set avatar_url = case
         when avatar_url ~ ('/storage/v1/object/public/avatars/' || id::text
                            || '/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$')
           then substring(avatar_url from '/storage/v1/object/public/avatars/(.+)$')
       end
 where not app_private.is_own_avatar_path(id, avatar_url);


-- -----------------------------------------------------------------------------
-- 3. Las restricciones
-- -----------------------------------------------------------------------------
alter table public.profiles
  add constraint profiles_first_name_valid
    check (app_private.person_name_problem(first_name) is null),
  add constraint profiles_last_name_initial_valid
    check (app_private.is_valid_initial(last_name_initial::text)),
  add constraint profiles_avatar_own_path
    check (app_private.is_own_avatar_path(id, avatar_url));

comment on column public.profiles.avatar_url is
  'Ruta en el bucket avatars, dentro de la carpeta del propio usuario. La URL pública la arma la aplicación.';


-- -----------------------------------------------------------------------------
-- 4. El alta limpia en vez de fallar
-- -----------------------------------------------------------------------------
-- Cuerpo idéntico al de …000200_identity.sql salvo el nombre público y la
-- inicial. Los datos privados guardan lo que la persona escribió.
create or replace function app_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_first text := coalesce(new.raw_user_meta_data ->> 'first_name', 'Usuario');
  v_last  text := coalesce(new.raw_user_meta_data ->> 'last_name', '');
  v_intent text := coalesce(new.raw_user_meta_data ->> 'intent', 'CLIENT');
  v_initial text := nullif(upper(left(btrim(v_last), 1)), '');
begin
  if not app_private.is_valid_initial(v_initial) then
    v_initial := null;
  end if;

  insert into public.profiles (id, first_name, last_name_initial, role, roles)
  values (
    new.id,
    app_private.clean_person_name(v_first),
    v_initial,
    'CLIENT',
    case when v_intent = 'WORKER'
      then array['CLIENT', 'WORKER']::public.app_role[]
      else array['CLIENT']::public.app_role[]
    end
  );

  insert into public.user_private_data (user_id, legal_first_name, legal_last_name, contact_email)
  values (new.id, v_first, v_last, new.email);

  insert into public.loyalty_accounts (user_id) values (new.id);

  if v_intent = 'WORKER' then
    insert into public.worker_profiles (user_id) values (new.id);
  end if;

  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- 5. El onboarding dice qué está mal
-- -----------------------------------------------------------------------------
-- Cuerpo idéntico al de …000300_accounts_and_verification.sql, más la
-- validación del nombre, la inicial y la foto antes de escribir. Los espacios
-- repetidos se colapsan: no es un error de la persona que valga la pena
-- devolverle.
create or replace function public.complete_onboarding(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_region_code text,
  p_commune_code text,
  p_avatar_url text default null,
  p_wants_client boolean default true,
  p_wants_worker boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_roles public.app_role[];
  v_first text := regexp_replace(btrim(coalesce(p_first_name, '')), ' {2,}', ' ', 'g');
  v_last text := regexp_replace(btrim(coalesce(p_last_name, '')), ' {2,}', ' ', 'g');
  v_problem text;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  if v_first = '' or v_last = '' then
    raise exception 'El nombre y el apellido son obligatorios' using errcode = 'check_violation';
  end if;

  v_problem := app_private.person_name_problem(v_first);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'check_violation';
  end if;

  if not app_private.is_valid_initial(upper(left(v_last, 1))) then
    raise exception 'El apellido debe comenzar con una letra.' using errcode = 'check_violation';
  end if;

  if not app_private.is_own_avatar_path(v_uid, p_avatar_url) then
    raise exception 'La foto de perfil tiene que ser una que subiste a tu cuenta.'
      using errcode = 'check_violation';
  end if;

  if not p_wants_client and not p_wants_worker then
    raise exception 'Elige al menos un modo de uso' using errcode = 'check_violation';
  end if;

  v_roles := array[]::public.app_role[];
  if p_wants_client then v_roles := v_roles || 'CLIENT'::public.app_role; end if;
  if p_wants_worker then v_roles := v_roles || 'WORKER'::public.app_role; end if;

  update public.profiles
     set first_name = v_first,
         last_name_initial = upper(left(v_last, 1)),
         region_code = p_region_code,
         commune_code = p_commune_code,
         city = (select name from public.communes where code = p_commune_code),
         avatar_url = coalesce(p_avatar_url, avatar_url),
         roles = v_roles,
         onboarding_completed_at = now(),
         updated_at = now()
   where id = v_uid;

  insert into public.user_private_data (user_id, legal_first_name, legal_last_name, phone)
  values (v_uid, v_first, v_last, nullif(trim(p_phone), ''))
  on conflict (user_id) do update
    set legal_first_name = excluded.legal_first_name,
        legal_last_name = excluded.legal_last_name,
        phone = coalesce(excluded.phone, public.user_private_data.phone),
        updated_at = now();

  if p_wants_worker then
    insert into public.worker_profiles (user_id) values (v_uid)
    on conflict (user_id) do nothing;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- 6. Los avisos citan el nombre
-- -----------------------------------------------------------------------------
-- «Camila F.» entre comillas angulares, o el genérico sin comillas si no hay
-- perfil. Cuerpos idénticos a los de …000100_chat_and_notifications.sql salvo
-- el texto del aviso.
create or replace function app_private.quoted_display_name(p_user_id uuid, p_fallback text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select '«' || p.first_name || coalesce(' ' || p.last_name_initial::text || '.', '') || '»'
       from public.profiles p
      where p.id = p_user_id),
    p_fallback);
$$;

revoke all on function app_private.quoted_display_name(uuid, text) from public, anon, authenticated;

create or replace function app_private.on_offer_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs;
begin
  select * into v_job from public.jobs where id = new.job_id;

  perform app_private.notify_user(
    v_job.client_id, 'NEW_OFFER',
    'Nueva oferta recibida',
    'Recibiste una oferta de ' || app_private.quoted_display_name(new.worker_id, 'un trabajador')
      || ' para "' || v_job.title || '".',
    '/mis-trabajos/publicados/' || v_job.id, v_job.id
  );

  return new;
end;
$$;

create or replace function app_private.on_message_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conversation public.conversations;
  v_recipient uuid;
begin
  if new.message_type = 'SYSTEM' or new.sender_id is null then
    return new;
  end if;

  select * into v_conversation from public.conversations where id = new.conversation_id;

  v_recipient := case
    when new.sender_id = v_conversation.client_id then v_conversation.worker_id
    else v_conversation.client_id
  end;

  perform app_private.notify_user(
    v_recipient, 'NEW_MESSAGE',
    'Nuevo mensaje',
    'Tienes un mensaje de ' || app_private.quoted_display_name(new.sender_id, 'alguien')
      || ' sobre un trabajo.',
    '/mensajes/' || new.conversation_id, v_conversation.job_id
  );

  return new;
end;
$$;
