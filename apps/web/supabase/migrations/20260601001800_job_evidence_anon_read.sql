-- =============================================================================
-- HagoTuFila · La página pública de un trabajo abre sin sesión
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría cruzada y reproducido sobre la base: la
-- página pública /trabajos/[id] pide la línea de tiempo del trabajo
-- (`job_evidence`) para cualquier visitante. Desde 20260401000100 el rol `anon`
-- no tiene SELECT sobre ninguna columna de `job_evidence` —se le quitó junto
-- con las coordenadas heredadas y el permiso por columnas se devolvió solo a
-- `authenticated`—, así que PostgREST respondía 42501 «permission denied for
-- table job_evidence», el repositorio lanzaba y la página entera se cambiaba
-- por la de error. Le pasaba a cada enlace del sitemap, a cada enlace
-- compartido y a cada buscador: la puerta de entrada del sitio para quien no
-- tiene cuenta.
--
-- La corrección va en dos capas:
--
--   · aquí, `anon` recupera SELECT sobre las MISMAS columnas que
--     `authenticated` —ninguna coordenada: `lat`, `lng` y `accuracy_m` siguen
--     fuera para todos—. No cambia qué filas ve: la política
--     `job_evidence_read` exige ser parte del trabajo o administración, y un
--     visitante no es ninguna de las dos, así que recibe cero filas en vez de
--     un error;
--   · en la aplicación, la página solo pide la línea de tiempo con sesión
--     (src/app/(app)/trabajos/[id]/page.tsx).
-- =============================================================================

grant select (id, job_id, assignment_id, author_id, author_name, evidence_type,
              title, body, storage_path, image_url, queue_ahead, occurred_at,
              created_at, event_key, visibility, mime_type, size_bytes)
  on public.job_evidence to anon;
