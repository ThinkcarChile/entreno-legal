-- =============================================================================
-- HagoTuFila · La evidencia se comprueba contra Storage, y Storage se cierra
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTOS, encontrados por la auditoría y reproducidos sobre la base:
--
--   1. `add_job_evidence` y `add_dispute_evidence` creían lo que el llamante
--      DECLARABA: tipo y tamaño llegaban como parámetros y no se contrastaban
--      con nada. Con la clave pública bastaba
--
--        rpc('add_job_evidence', { p_storage_path: '<yo>/x/y.jpg',
--                                  p_mime_type: 'image/jpeg', p_size_bytes: 1 })
--
--      para registrar en la línea de tiempo un «archivo» que no existía, o uno
--      de 50 MB declarado como de 1 byte. La ruta solo se miraba en su primera
--      carpeta: la segunda —el trabajo o la disputa— podía ser cualquiera.
--
--   2. `job-images` es público y su política de escritura solo exigía la
--      carpeta propia: cualquiera con sesión podía alojar imágenes servidas
--      desde nuestro dominio sin que existiera ningún trabajo detrás. Lo mismo,
--      en privado, para `evidence` y `dispute-files`.
--
--   3. No había ninguna política de DELETE en Storage. La limpieza que hace la
--      aplicación cuando la fila no se registra (`remove([ruta])`) fallaba en
--      silencio y dejaba el archivo huérfano, y al cambiar la foto de perfil la
--      anterior seguía pública para siempre.
--
-- Ahora:
--
--   · las dos RPC exigen que el objeto exista en `storage.objects` en la ruta
--     `<usuario>/<trabajo o disputa>/<archivo>`, y toman su tamaño y su tipo de
--     los metadatos que escribe Storage —el tamaño lo mide Storage, no quien
--     sube—; lo declarado tiene que coincidir y estar dentro de los límites;
--   · subir a `evidence`, `dispute-files` y `job-images` exige que la segunda
--     carpeta sea una asignación, una disputa o un trabajo propio;
--   · el dueño puede borrar sus avatares, y sus archivos de evidencia o de
--     disputa MIENTRAS no estén registrados. Una vez registrados, nadie con
--     sesión los borra: ni el autor, ni la contraparte, ni la administración.
--
-- La carrera entre registrar y borrar el mismo archivo la cierra un candado
-- consultivo por objeto, que toman las dos RPC y la política de borrado. Ver §3.
--
-- Lo que la base NO puede hacer: leer los bytes. El tipo que Storage anota es el
-- que declaró quien subió (y Storage lo contrasta con `allowed_mime_types` del
-- bucket); la firma real del archivo la comprueba la aplicación antes de subir
-- (src/lib/storage/evidence.ts). Quien sube directo con su sesión se salta esa
-- firma, no el tamaño, ni el tipo admitido, ni la ruta. Dicho así en
-- docs/EJECUCION.md §6.
--
-- Nota para proyectos alojados: lo mismo que en la migración …000900. Si el rol
-- que aplica las migraciones no puede crear políticas sobre `storage.objects`,
-- se crean desde el panel con estas mismas reglas.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Índices para encontrar un archivo registrado por su ruta
-- -----------------------------------------------------------------------------
-- Las políticas de lectura de Storage ya buscaban por `storage_path` sin
-- índice; ahora también lo hacen el borrado y las dos RPC.
create index if not exists job_evidence_storage_path_idx
  on public.job_evidence (storage_path) where storage_path is not null;
create index if not exists dispute_evidence_storage_path_idx
  on public.dispute_evidence (storage_path) where storage_path is not null;


-- -----------------------------------------------------------------------------
-- 2. ¿Puede esta persona subir a esta ruta?
-- -----------------------------------------------------------------------------
-- La ruta es siempre `<usuario>/<ámbito>/<archivo>`, y el ámbito depende del
-- bucket: la asignación (evidence), la disputa (dispute-files) o el trabajo
-- (job-images). SECURITY DEFINER para no depender de la RLS de esas tablas, que
-- es de otro dominio y puede cambiar.
create or replace function app_private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_parts text[];
  v_scope uuid;
begin
  if v_uid is null or p_name is null then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) <> 3
     or v_parts[1] <> v_uid::text
     or coalesce(v_parts[3], '') = ''
     or p_name like '%..%' then
    return false;
  end if;

  -- Se valida antes de convertir: un texto que no es UUID sería un error, y una
  -- política que revienta no es una política que niega.
  if v_parts[2] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_scope := v_parts[2]::uuid;

  if p_bucket = 'evidence' then
    return exists (
      select 1 from public.assignments a
       where a.id = v_scope and v_uid in (a.client_id, a.worker_id)
    );
  elsif p_bucket = 'dispute-files' then
    return exists (
      select 1 from public.disputes d
        join public.assignments a on a.id = d.assignment_id
       where d.id = v_scope
         and d.status <> 'RESOLVED'
         and (v_uid in (a.client_id, a.worker_id) or app_private.is_admin(v_uid))
    );
  elsif p_bucket = 'job-images' then
    -- Las fotos describen el aviso: se suben mientras el trabajo se edita o
    -- está publicado, y solo por su cliente.
    return exists (
      select 1 from public.jobs j
       where j.id = v_scope and j.client_id = v_uid and j.status in ('DRAFT', 'PUBLISHED')
    );
  end if;

  return false;
end;
$$;

comment on function app_private.storage_upload_allowed is
  'Políticas de INSERT de Storage: la ruta es <usuario>/<ámbito>/<archivo> y el ámbito es una asignación propia (evidence), una disputa viva propia (dispute-files) o un trabajo propio en DRAFT o PUBLISHED (job-images).';


-- -----------------------------------------------------------------------------
-- 3. ¿Puede esta persona borrar este objeto?
-- -----------------------------------------------------------------------------
-- Solo lo suyo y solo lo que todavía no se registró. La carrera que importa:
-- la RPC registra el archivo mientras el autor lo borra. El orden lo decide un
-- candado consultivo por objeto que toman los dos lados:
--
--   · si la RPC lo toma primero, el borrado espera a que confirme y entonces
--     ve la fila registrada (la función es VOLATILE: cada consulta suya mira
--     con una instantánea nueva) y no borra;
--   · si el borrado lo toma primero, la RPC espera, y al seguir ya no
--     encuentra el objeto y rechaza el registro.
create or replace function app_private.storage_lock_key(p_bucket text, p_name text)
returns bigint
language sql
immutable
set search_path = public, pg_temp
as $$
  select hashtextextended('storage_object:' || p_bucket || '/' || p_name, 0)
$$;

create or replace function app_private.storage_object_deletable(p_bucket text, p_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_name is null or split_part(p_name, '/', 1) <> v_uid::text then
    return false;
  end if;

  if p_bucket not in ('evidence', 'dispute-files') then
    return false;
  end if;

  perform pg_advisory_xact_lock(app_private.storage_lock_key(p_bucket, p_name));

  if p_bucket = 'evidence' then
    return not exists (select 1 from public.job_evidence e where e.storage_path = p_name);
  end if;
  return not exists (select 1 from public.dispute_evidence d where d.storage_path = p_name);
end;
$$;

comment on function app_private.storage_object_deletable is
  'Política de DELETE de evidence y dispute-files: el dueño borra un archivo suyo solo mientras ninguna fila lo registre. Toma el mismo candado por objeto que add_job_evidence y add_dispute_evidence.';


-- -----------------------------------------------------------------------------
-- 4. Políticas de Storage
-- -----------------------------------------------------------------------------
-- Escritura: las tres que admiten archivos de un ámbito pasan por la función.
drop policy if exists "job_images_own_write" on storage.objects;
create policy "job_images_own_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'job-images' and app_private.storage_upload_allowed(bucket_id, name));

drop policy if exists "evidence_own_write" on storage.objects;
create policy "evidence_own_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'evidence' and app_private.storage_upload_allowed(bucket_id, name));

drop policy if exists "dispute_files_own_write" on storage.objects;
create policy "dispute_files_own_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'dispute-files' and app_private.storage_upload_allowed(bucket_id, name));

-- Borrado. Avatares: el dueño, en su carpeta. Es lo que usa la aplicación al
-- reemplazar la foto y al deshacer una subida que no llegó a guardarse.
drop policy if exists "avatars_own_delete" on storage.objects;
create policy "avatars_own_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Evidencia y disputas: solo lo propio que no llegó a registrarse.
drop policy if exists "evidence_own_delete_unregistered" on storage.objects;
create policy "evidence_own_delete_unregistered" on storage.objects
  for delete to authenticated
  using (bucket_id = 'evidence' and app_private.storage_object_deletable(bucket_id, name));

drop policy if exists "dispute_files_own_delete_unregistered" on storage.objects;
create policy "dispute_files_own_delete_unregistered" on storage.objects
  for delete to authenticated
  using (bucket_id = 'dispute-files' and app_private.storage_object_deletable(bucket_id, name));


-- -----------------------------------------------------------------------------
-- 5. El archivo que se registra es el que está en Storage
-- -----------------------------------------------------------------------------
-- Común a las dos RPC. Devuelve el tipo y el tamaño que anotó Storage, que son
-- los que se guardan; lo declarado solo sirve para detectar una discrepancia.
create or replace function app_private.verified_upload(
  p_bucket     text,
  p_path       text,
  p_scope_id   uuid,
  p_mime_type  text,
  p_size_bytes bigint,
  out mime_type  text,
  out size_bytes bigint
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_parts text[] := string_to_array(p_path, '/');
  v_meta  jsonb;
  v_found boolean := false;
  v_max   bigint;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  if p_path like '%..%' or p_path like '/%' then
    raise exception 'Ruta de archivo no válida' using errcode = 'invalid_parameter_value';
  end if;

  -- La ruta la construye el servidor con el identificador de quien sube.
  if v_parts[1] is distinct from v_uid::text then
    raise exception 'La ruta del archivo no corresponde a tu carpeta'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(array_length(v_parts, 1), 0) <> 3
     or v_parts[2] is distinct from p_scope_id::text
     or coalesce(v_parts[3], '') = '' then
    raise exception 'La ruta del archivo no corresponde a este trabajo'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Mismo candado que la política de borrado: ver §3.
  perform pg_advisory_xact_lock(app_private.storage_lock_key(p_bucket, p_path));

  select o.metadata, true into v_meta, v_found
    from storage.objects o
   where o.bucket_id = p_bucket and o.name = p_path;

  if not coalesce(v_found, false) then
    raise exception 'No encontramos el archivo subido. Vuelve a adjuntarlo.'
      using errcode = 'no_data_found';
  end if;

  if (p_bucket = 'evidence'
      and exists (select 1 from public.job_evidence e where e.storage_path = p_path))
     or (p_bucket = 'dispute-files'
      and exists (select 1 from public.dispute_evidence d where d.storage_path = p_path)) then
    raise exception 'Ese archivo ya está adjunto' using errcode = 'check_violation';
  end if;

  mime_type := v_meta ->> 'mimetype';
  size_bytes := case when (v_meta ->> 'size') ~ '^[0-9]+$' then (v_meta ->> 'size')::bigint end;

  if mime_type is null
     or mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') then
    raise exception 'Formato de archivo no admitido' using errcode = 'invalid_parameter_value';
  end if;

  if p_mime_type is distinct from mime_type then
    raise exception 'El tipo del archivo no coincide con el que se subió'
      using errcode = 'check_violation';
  end if;

  select evidence_max_bytes into v_max from public.platform_settings where id;

  if size_bytes is null or size_bytes <= 0 or size_bytes > v_max then
    raise exception 'El archivo supera el tamaño permitido' using errcode = 'check_violation';
  end if;

  if p_size_bytes is distinct from size_bytes then
    raise exception 'El tamaño del archivo no coincide con el que se subió'
      using errcode = 'check_violation';
  end if;
end;
$$;

comment on function app_private.verified_upload is
  'Comprueba que el objeto exista en storage.objects en <usuario>/<ámbito>/<archivo>, que no esté ya registrado y que el tipo y el tamaño que anotó Storage estén admitidos y coincidan con lo declarado. Devuelve los de Storage.';


-- -----------------------------------------------------------------------------
-- 6. add_job_evidence: igual que antes, salvo el archivo
-- -----------------------------------------------------------------------------
create or replace function public.add_job_evidence(
  p_assignment_id uuid,
  p_evidence_type public.evidence_type,
  p_title         text,
  p_body          text default null,
  p_storage_path  text default null,
  p_mime_type     text default null,
  p_size_bytes    integer default null,
  p_queue_ahead   integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_a public.assignments;
  v_j public.jobs;
  v_uid uuid := auth.uid();
  v_settings record;
  v_count integer;
  v_id uuid;
  v_other uuid;
  v_mime text;
  v_size bigint;
begin
  v_a := app_private.lock_assignment_for(p_assignment_id, 'any');
  select * into v_j from public.jobs where id = v_a.job_id;

  if p_evidence_type not in ('NOTE', 'PHOTO', 'QUEUE_STATUS', 'LOCATION') then
    raise exception 'Ese tipo de evidencia lo escribe el sistema, no las personas'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'La actualización necesita un título' using errcode = 'check_violation';
  end if;

  if char_length(p_title) > 120 or char_length(coalesce(p_body, '')) > 2000 then
    raise exception 'La actualización es demasiado larga' using errcode = 'check_violation';
  end if;

  select evidence_max_bytes, evidence_max_per_assignment into v_settings
    from public.platform_settings where id;

  -- El archivo tiene que estar de verdad en `evidence/<yo>/<esta asignación>/…`,
  -- y lo que se guarda es lo que midió Storage.
  if p_storage_path is not null then
    select u.mime_type, u.size_bytes into v_mime, v_size
      from app_private.verified_upload('evidence', p_storage_path, p_assignment_id,
                                       p_mime_type, p_size_bytes) u;
  end if;

  select count(*) into v_count from public.job_evidence
   where assignment_id = p_assignment_id and author_id = v_uid and event_key is null;
  if v_count >= v_settings.evidence_max_per_assignment then
    raise exception 'Alcanzaste el máximo de actualizaciones para este trabajo'
      using errcode = 'check_violation';
  end if;

  v_id := app_private.timeline_event(
    v_j.id, p_assignment_id, v_uid, p_evidence_type, trim(p_title), p_body,
    null, p_storage_path, v_mime, v_size::integer, p_queue_ahead);

  v_other := case when v_uid = v_a.worker_id then v_a.client_id else v_a.worker_id end;

  perform app_private.notify_user(
    v_other,
    case when p_storage_path is null then 'JOB_UPDATE'::public.notification_type
         else 'NEW_EVIDENCE'::public.notification_type end,
    case when p_storage_path is null then 'Nueva actualización del trabajo'
         else 'Nueva evidencia del trabajo' end,
    trim(p_title),
    '/mis-trabajos/' || p_assignment_id, v_j.id);

  return v_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 7. add_dispute_evidence: el mismo control, y un máximo como la del trabajo
-- -----------------------------------------------------------------------------
-- docs/EJECUCION.md §10 prometía «las mismas validaciones que la evidencia del
-- trabajo», y la cantidad no tenía tope: se aplica el mismo
-- `evidence_max_per_assignment`, por persona y disputa. La administración no
-- tiene tope.
create or replace function public.add_dispute_evidence(
  p_dispute_id   uuid,
  p_body         text default null,
  p_storage_path text default null,
  p_mime_type    text default null,
  p_size_bytes   integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_d public.disputes;
  v_a public.assignments;
  v_role public.app_role;
  v_admin boolean;
  v_max_count integer;
  v_count integer;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  select * into v_d from public.disputes where id = p_dispute_id;
  if v_d.id is null then
    raise exception 'La disputa no existe' using errcode = 'no_data_found';
  end if;

  select * into v_a from public.assignments where id = v_d.assignment_id;
  v_admin := app_private.is_admin();

  if v_uid not in (v_a.client_id, v_a.worker_id) and not v_admin then
    raise exception 'No participas en esta disputa' using errcode = 'insufficient_privilege';
  end if;

  if v_d.status = 'RESOLVED' then
    raise exception 'Esta disputa ya está resuelta' using errcode = 'check_violation';
  end if;

  if coalesce(trim(coalesce(p_body, '')), '') = '' and p_storage_path is null then
    raise exception 'Escribe algo o adjunta un archivo' using errcode = 'check_violation';
  end if;

  if char_length(coalesce(p_body, '')) > 2000 then
    raise exception 'El texto es demasiado largo' using errcode = 'check_violation';
  end if;

  if not v_admin then
    select evidence_max_per_assignment into v_max_count from public.platform_settings where id;
    select count(*) into v_count from public.dispute_evidence
     where dispute_id = p_dispute_id and author_id = v_uid;
    if v_count >= v_max_count then
      raise exception 'Alcanzaste el máximo de pruebas para esta disputa'
        using errcode = 'check_violation';
    end if;
  end if;

  -- El archivo tiene que estar en `dispute-files/<yo>/<esta disputa>/…`.
  if p_storage_path is not null then
    perform 1
      from app_private.verified_upload('dispute-files', p_storage_path, p_dispute_id,
                                       p_mime_type, p_size_bytes);
  end if;

  v_role := case
    when v_admin then 'ADMIN'::public.app_role
    when v_uid = v_a.client_id then 'CLIENT'::public.app_role
    else 'WORKER'::public.app_role
  end;

  insert into public.dispute_evidence (dispute_id, author_id, author_role, body, storage_path)
  values (p_dispute_id, v_uid, v_role, nullif(trim(coalesce(p_body, '')), ''), p_storage_path)
  returning id into v_id;

  return v_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 8. Privilegios
-- -----------------------------------------------------------------------------
-- Las dos funciones de política las evalúa Storage con el rol `authenticated`.
revoke all on function app_private.storage_upload_allowed(text, text) from public, anon;
grant execute on function app_private.storage_upload_allowed(text, text) to authenticated;
revoke all on function app_private.storage_object_deletable(text, text) from public, anon;
grant execute on function app_private.storage_object_deletable(text, text) to authenticated;

-- Las otras dos solo las llaman funciones SECURITY DEFINER.
revoke all on function app_private.storage_lock_key(text, text) from public, anon, authenticated;
revoke all on function app_private.verified_upload(text, text, uuid, text, bigint)
  from public, anon, authenticated;

-- Las RPC conservan su firma; se repiten los privilegios por claridad.
grant execute on function public.add_job_evidence(uuid, public.evidence_type, text, text, text, text, integer, integer) to authenticated;
revoke execute on function public.add_job_evidence(uuid, public.evidence_type, text, text, text, text, integer, integer) from anon, public;
grant execute on function public.add_dispute_evidence(uuid, text, text, text, integer) to authenticated;
revoke execute on function public.add_dispute_evidence(uuid, text, text, text, integer) from anon, public;
