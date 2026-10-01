-- =============================================================================
-- HagoTuFila · `job_is_approvable` con search_path fijo
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría al emular el lint
-- `function_search_path_mutable` del advisor de seguridad de Supabase sobre el
-- esquema completo: `app_private.job_is_approvable(public.job_status)`
-- (20260601000200) era la única función de `public` y `app_private` sin
-- `search_path` fijo. El advisor revisa TODAS las funciones, también las
-- SECURITY INVOKER, y `npm run verify:schema:hosted` trata cualquier aviso de
-- seguridad no revisado como fallo: la verificación posterior al despliegue
-- quedaba en rojo. Es lo mismo que 20260301000000 corrigió en otras cuatro.
--
-- El riesgo era bajo —quienes la llaman son SECURITY DEFINER con la ruta fija
-- y nadie más puede ejecutarla—, pero el arreglo es el mismo de siempre y no
-- cambia lo que la función devuelve. Se usa `alter function` y no se vuelve a
-- crear: el cuerpo, la volatilidad y los privilegios quedan como estaban.
--
-- La comprobación local I14 (05_schema_inventory.sql) y su equivalente en
-- verify:schema:hosted miraban solo las SECURITY DEFINER; ahora miran todas
-- las funciones de `public` y `app_private`, para que la próxima no llegue
-- hasta el advisor.
-- =============================================================================

alter function app_private.job_is_approvable(public.job_status)
  set search_path = public, pg_temp;
