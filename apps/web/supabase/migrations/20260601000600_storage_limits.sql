-- =============================================================================
-- HagoTuFila · Cada bucket admite solo lo que la aplicación admite
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría: los cinco buckets se crearon sin
-- `file_size_limit` ni `allowed_mime_types`. La aplicación valida tipo, firma y
-- tamaño antes de subir (src/lib/storage/*.ts), pero quien tenga una sesión
-- puede subir directamente a Storage con la clave pública, sin pasar por esa
-- validación: un ejecutable de 2 GB en `avatars` —que es público— quedaba
-- servido desde nuestro dominio de Storage.
--
-- Ahora el propio Storage rechaza lo que la aplicación no aceptaría. Los
-- valores son los mismos que ya valida el código:
--
--   avatars                 4 MB  JPG, PNG, WebP          (avatars.ts)
--   evidence, dispute-files 8 MB  JPG, PNG, WebP, PDF     (evidence.ts)
--   job-images, verification 8 MB  los mismos              (sin carga en la app
--                                                           todavía: se cierran
--                                                           igual)
--
-- SVG queda fuera a propósito (docs/EJECUCION.md §6): es un documento que puede
-- llevar script.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit'
  ) then
    raise notice 'storage.buckets no tiene file_size_limit: límites no aplicados';
    return;
  end if;

  update storage.buckets
     set file_size_limit = 4 * 1024 * 1024,
         allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
   where id = 'avatars';

  update storage.buckets
     set file_size_limit = 8 * 1024 * 1024,
         allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
   where id in ('evidence', 'dispute-files', 'verification');

  update storage.buckets
     set file_size_limit = 8 * 1024 * 1024,
         allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
   where id = 'job-images';
end $$;
