-- 0034 — El bucket médico era de escritura pura: se podía subir un examen y
--        después NADIE podía volver a verlo ni borrarlo.
--
-- HALLAZGO (auditoría posterior al Sprint 11.5, sobre código YA en producción):
-- la 0026 §8 dejó una sola política sobre `storage.objects`:
-- `medical_docs_upload ... for insert`. Ni SELECT ni DELETE.
--
-- El comentario de la 0026 decía "Leer: NADIE directo — solo URLs firmadas
-- emitidas por el servidor". Esa frase describe una intención correcta pero un
-- mecanismo que no existe: en Supabase real, `createSignedUrl()` y `.download()`
-- se resuelven con la sesión de quien pide, y storage-api exige SELECT sobre
-- `storage.objects` ANTES de firmar o de entregar el archivo. Sin política de
-- SELECT no hay firma posible. Consecuencias medidas:
--
--   a) `getExamSignedUrl` (web/src/app/health/actions.ts) falla SIEMPRE: la
--      persona sube su examen y jamás puede volver a abrirlo. El PDF queda del
--      otro lado del vidrio.
--   b) `runExtraction` nunca puede leer el archivo: `.download()` rebota, así
--      que la extracción no corre ni siquiera con consentimiento otorgado.
--   c) El rollback de `uploadExam` llama `.remove()` sin política de DELETE:
--      cuando el RPC `upload_lab_document` falla, el PDF médico queda huérfano
--      en el bucket, sin fila que lo referencie y sin ninguna vía de borrado
--      (`archive_lab_document` sólo cambia el estado de la fila, no toca el
--      objeto). Un dato de salud sin dueño registrado y sin forma de sacarlo.
--
-- Por qué los 748 tests estaban verdes: en PGlite no existe el esquema
-- `storage`, así que el bloque condicional entero se salta y ninguna política
-- de storage se ejerce nunca en el arnés. El agujero era invisible desde los
-- tests por construcción, no por falta de cobertura.
--
-- DECISIONES DE ESTA MIGRACIÓN
--
-- 1. NUNCA una política plana por `bucket_id`. Eso abriría los exámenes de todo
--    el hogar (y de cualquier hogar) a cualquier autenticado. El permiso se
--    ancla en el integrante que va en la ruta —`member/{member_id}/...`, el
--    mismo formato que escribe `uploadExam`— y se evalúa con
--    `app.medical_access(...)`, que es la ÚNICA autoridad de acceso médico del
--    sistema (ADR 0012 §2: los roles del hogar no cuentan; sólo self, grant
--    activo, o tutor de un integrante sin cuenta vinculada).
--
-- 2. Leer un examen = READ_LABS, exactamente el mismo permiso que gobierna
--    `lab_documents` y `lab_observations` en la 0026. El archivo y su ficha no
--    pueden tener puertas distintas: si la fila se ve, el PDF se ve; si no, no.
--
-- 3. Borrar un objeto REGISTRADO no se permite a nadie, ni con CONFIRM_LABS.
--    Un documento médico registrado se archiva (`archive_lab_document`), no se
--    destruye: la historia clínica es evidencia y se conserva. Por eso el
--    DELETE queda acotado a objetos HUÉRFANOS —los que no tienen ninguna fila
--    de `lab_documents` apuntándolos—, que es exactamente el caso del rollback
--    de `uploadExam` y de cualquier limpieza posterior de basura. Si mañana
--    hace falta un borrado real por derecho a supresión, entra por un RPC
--    auditado, no por una política de storage.
--
-- 4. El borrado necesita además VER el objeto: storage-api busca la fila antes
--    de eliminarla, así que `.remove()` sin SELECT también rebota. Se agrega
--    una rama acotada de lectura para huérfanos con UPLOAD_LABS, de modo que
--    quien acaba de subir pueda retirar SU archivo sin registrar aunque no
--    tenga READ_LABS (caso real: un cuidador con permiso sólo para subir). Esa
--    rama no abre ningún examen de verdad: todo lo registrado queda fuera.
--
-- 5. Todo va dentro del mismo bloque condicional `if exists (... nspname =
--    'storage')` con `exception when duplicate_object`, para que PGlite no
--    reviente y para que la migración sea idempotente en Supabase.
--
-- No se toca ninguna migración congelada (0001-0032): esto es aditivo.

-- ---------------------------------------------------------------------------
-- 1. Helpers de la ruta del bucket (viven en `app`, se crean SIEMPRE)
--
--    Se crean fuera del bloque condicional a propósito: no dependen de storage,
--    así que quedan disponibles y testeables también en PGlite.
-- ---------------------------------------------------------------------------

/**
 * El integrante dueño del objeto, leído de la ruta `member/{member_id}/...`
 * que escribe `uploadExam`.
 *
 * Devuelve NULL —y NO revienta— ante cualquier ruta que no calce: un cast
 * `::uuid` crudo dentro de una política haría fallar la consulta entera al
 * toparse con un solo nombre malformado, y el acceso a un examen no puede
 * depender de la basura que haya en el bucket. NULL cae solo:
 * `app.medical_access(null, ...)` es false en sus tres ramas, así que una ruta
 * ilegible se comporta como "sin acceso", nunca como "acceso libre".
 * (UNKNOWN nunca significa NORMAL, y tampoco significa permitido.)
 */
create or replace function app.medical_path_member(p_name text)
returns uuid language sql immutable as $$
  select case
    when (string_to_array(p_name, '/'))[1] = 'member'
     and (string_to_array(p_name, '/'))[2] ~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then ((string_to_array(p_name, '/'))[2])::uuid
    else null
  end;
$$;

/**
 * ¿Este objeto está registrado como documento médico?
 *
 * SECURITY DEFINER con search_path fijo a propósito: la respuesta tiene que ser
 * la VERDAD del sistema, no lo que el usuario alcanza a ver por RLS. Si la
 * política consultara `lab_documents` directo, alguien sin permiso de lectura
 * sobre esa fila vería "no hay registro" y podría borrar el archivo de un
 * examen ajeno ya confirmado.
 *
 * No filtra nada hacia afuera: devuelve un booleano y punto —ni el hogar, ni el
 * dueño, ni el id del documento—, y sólo se llega a evaluarlo después de que
 * `app.medical_access` ya dio true sobre el integrante de la ruta.
 */
create or replace function app.lab_document_registrado(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.lab_documents d where d.storage_path = p_name
  );
$$;

-- La política pregunta por `storage_path` en cada objeto tocado; sin índice eso
-- es un seq scan por archivo.
create index if not exists lab_documents_by_storage_path
  on public.lab_documents (storage_path)
  where storage_path is not null;

-- ---------------------------------------------------------------------------
-- 2. Políticas de storage (sólo donde el esquema existe: Supabase sí, PGlite no)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then

    -- LEER: el mismo permiso que abre la ficha del examen (READ_LABS), anclado
    -- al integrante de la ruta. Segunda rama, acotada: quien puede SUBIR ve los
    -- objetos HUÉRFANOS de ese integrante, para poder retirar el archivo recién
    -- subido cuando el registro falló. Ningún examen registrado entra por ahí.
    begin
      execute $pol$
        create policy medical_docs_read on storage.objects
        for select to authenticated
        using (
          bucket_id = 'medical-documents'
          and (
            app.medical_access(app.medical_path_member(name), 'READ_LABS')
            or (
              app.medical_access(app.medical_path_member(name), 'UPLOAD_LABS')
              and not app.lab_document_registrado(name)
            )
          )
        )
      $pol$;
    exception when duplicate_object then null;
    end;

    -- BORRAR: sólo huérfanos, y sólo con UPLOAD_LABS —el permiso simétrico al
    -- que creó el objeto—. Lo registrado se archiva, no se borra.
    begin
      execute $pol$
        create policy medical_docs_delete on storage.objects
        for delete to authenticated
        using (
          bucket_id = 'medical-documents'
          and app.medical_access(app.medical_path_member(name), 'UPLOAD_LABS')
          and not app.lab_document_registrado(name)
        )
      $pol$;
    exception when duplicate_object then null;
    end;

    -- No se agrega política de UPDATE a propósito: mover o sobrescribir un
    -- objeto médico cambiaría la ruta que ancla TODO este permiso, y dejaría
    -- `lab_documents.storage_path` apuntando al vacío. Sin UPDATE, el objeto es
    -- inmutable una vez subido; corregir un examen es subir uno nuevo.

  end if;
end $$;
