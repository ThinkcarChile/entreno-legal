-- =============================================================================
-- HagoTuFila · Storage: nadie lista los buckets públicos, y subir tiene tope
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTOS, encontrados por la auditoría cruzada y reproducidos sobre la base:
--
--   1. `avatars_public_read` y `job_images_public_read` eran políticas de
--      SELECT para cualquier rol. En un bucket público no hacen falta para
--      servir los archivos —Storage entrega `/object/public/…` sin mirar
--      políticas—, y lo único que añadían era el listado: sin sesión, con la
--      clave pública, `select bucket_id, name from storage.objects` devolvía
--      la carpeta —el identificador— de cada persona con foto de perfil,
--      clientes incluidos, a los que 20260601001110 dejó fuera de los
--      perfiles visibles. Y las fotos de trabajos en borrador.
--   2. Subir no tenía tope, ni miraba si el ámbito seguía vivo: a `evidence`
--      se subía en cualquier asignación en la que se hubiera participado,
--      también COMPLETED; a `job-images`, sin límite por trabajo. Un trabajo
--      publicado bastaba para alojar imágenes de 8 MB sin fin en el dominio
--      público del proyecto. Las fotos de perfil, igual, en la carpeta propia.
--
-- Ahora:
--
--   · no hay SELECT sobre `job-images` para nadie con la clave pública ni con
--     sesión: la aplicación no lista ni descarga ese bucket, solo lo sirve por
--     su URL pública. En `avatars` cada persona ve SOLO su carpeta: es lo que
--     necesita `remove([ruta])` al reemplazar la foto (un DELETE … RETURNING,
--     que exige poder leer la fila). Nadie más la lista;
--   · subir a `evidence` exige que la asignación admita evidencia —la misma
--     pregunta que hace `add_job_evidence`, `app_private.job_evidence_open`
--     (20260601001820)—; a `dispute-files`, una disputa sin resolver, como ya
--     era; a `job-images`, un trabajo propio en DRAFT o PUBLISHED, como ya era;
--   · cada ámbito tiene tope de objetos por persona, contando también los que
--     no llegaron a registrarse:
--
--       evidence        evidence_max_per_assignment (40) por asignación
--       dispute-files   el mismo, por disputa (la administración no tiene tope,
--                       como en `add_dispute_evidence`)
--       job-images      6 por trabajo, lo que admite el formulario
--       avatars         5 en la carpeta propia, y con el nombre que acepta
--                       `profiles.avatar_url` (`is_own_avatar_path`); la
--                       aplicación retira la anterior al reemplazarla
--
--     El recuento se hace bajo un candado consultivo por ámbito: dos
--     inserciones simultáneas en `storage.objects` con la sesión de la misma
--     persona no pasan juntas el último cupo. Ojo con lo que eso NO cubre: el
--     servicio de Storage puede comprobar la política en una transacción de
--     prueba y guardar la fila final después, con su propio rol; entonces una
--     ráfaga de subidas simultáneas puede pasar el tope por unas pocas. El
--     tope sigue acotando el abuso —ya lleno, no entra nada más—, pero no es
--     exacto bajo concurrencia.
--
-- Lo que esto NO hace: limpiar los objetos subidos que nunca se registraron.
-- La aplicación los retira al fallar el registro; los que queden por un corte
-- de red cuentan contra el tope de su ámbito, que es lo que limita el abuso.
--
-- Nota para proyectos alojados: lo mismo que en …000900. Si el rol que aplica
-- las migraciones no puede crear políticas sobre `storage.objects`, se crean
-- desde el panel con estas mismas reglas.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. ¿Puede esta persona subir a esta ruta?
-- -----------------------------------------------------------------------------
-- Igual que en 20260601001210 salvo los avatares, el estado de la asignación y
-- los topes. VOLATILE porque toma un candado y cuenta después: cada consulta
-- mira con una instantánea nueva y ve lo que subió quien tenía el candado.
create or replace function app_private.storage_upload_allowed(p_bucket text, p_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_parts text[];
  v_scope uuid;
  v_cap   integer;
  v_count integer;
begin
  if v_uid is null or p_name is null then
    return false;
  end if;

  -- Avatares: `<usuario>/<nombre>.jpg|png|webp`, la misma forma que admite
  -- `profiles.avatar_url`. Una ruta que el perfil no podría usar no se sube.
  if p_bucket = 'avatars' then
    if not app_private.is_own_avatar_path(v_uid, p_name) then
      return false;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('storage_scope:avatars/' || v_uid::text, 0));
    select count(*) into v_count from storage.objects o
     where o.bucket_id = 'avatars' and o.name like v_uid::text || '/%';
    return v_count < 5;
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
    if not exists (
      select 1 from public.assignments a
       where a.id = v_scope and v_uid in (a.client_id, a.worker_id)
    ) or not app_private.job_evidence_open(v_scope) then
      return false;
    end if;
    select evidence_max_per_assignment into v_cap from public.platform_settings where id;
  elsif p_bucket = 'dispute-files' then
    if not exists (
      select 1 from public.disputes d
        join public.assignments a on a.id = d.assignment_id
       where d.id = v_scope
         and d.status <> 'RESOLVED'
         and (v_uid in (a.client_id, a.worker_id) or app_private.is_admin(v_uid))
    ) then
      return false;
    end if;
    if app_private.is_admin(v_uid) then
      return true;
    end if;
    select evidence_max_per_assignment into v_cap from public.platform_settings where id;
  elsif p_bucket = 'job-images' then
    -- Las fotos describen el aviso: se suben mientras el trabajo se edita o
    -- está publicado, y solo por su cliente.
    if not exists (
      select 1 from public.jobs j
       where j.id = v_scope and j.client_id = v_uid and j.status in ('DRAFT', 'PUBLISHED')
    ) then
      return false;
    end if;
    v_cap := 6;
  else
    return false;
  end if;

  -- El tope cuenta lo que esta persona tiene en este ámbito, registrado o no.
  perform pg_advisory_xact_lock(
    hashtextextended('storage_scope:' || p_bucket || '/' || v_uid::text || '/' || v_scope::text, 0));
  select count(*) into v_count from storage.objects o
   where o.bucket_id = p_bucket
     and o.name like v_uid::text || '/' || v_scope::text || '/%';

  return v_count < v_cap;
end;
$$;

comment on function app_private.storage_upload_allowed is
  'Políticas de INSERT de Storage. avatars: <usuario>/<nombre>.jpg|png|webp, hasta 5. El resto: <usuario>/<ámbito>/<archivo>, con el ámbito vivo —asignación que admite evidencia, disputa sin resolver, trabajo propio en DRAFT o PUBLISHED— y un tope de objetos por persona y ámbito.';

revoke all on function app_private.storage_upload_allowed(text, text) from public, anon;
grant execute on function app_private.storage_upload_allowed(text, text) to authenticated;


-- -----------------------------------------------------------------------------
-- 2. Lectura: nadie lista los buckets públicos
-- -----------------------------------------------------------------------------
drop policy if exists "avatars_public_read" on storage.objects;
drop policy if exists "job_images_public_read" on storage.objects;

-- La carpeta propia, y solo con sesión: es lo que necesita `remove()`.
drop policy if exists "avatars_own_read" on storage.objects;
create policy "avatars_own_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);


-- -----------------------------------------------------------------------------
-- 3. Escritura de avatares por la misma función que el resto
-- -----------------------------------------------------------------------------
-- Las de evidence, dispute-files y job-images ya llaman a la función
-- (20260601001210) y toman la versión nueva sin recrearse.
drop policy if exists "avatars_own_write" on storage.objects;
create policy "avatars_own_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and app_private.storage_upload_allowed(bucket_id, name));
