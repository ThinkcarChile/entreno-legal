-- =============================================================================
-- HagoTuFila · Etapa 2.5 · 000 · Privilegios que solo se ven en un proyecto real
-- =============================================================================
-- Defectos encontrados al aplicar por primera vez el esquema contra
-- `hagotufila-dev`. Los tres son invisibles en un PostgreSQL a secas, y por eso
-- `npm run db:test` los daba por buenos: dependen de la configuración que trae
-- un proyecto Supabase recién creado.
--
-- 1. `anon` podía ESCRIBIR en las 37 tablas y vistas de `public`.
--
--    Un proyecto Supabase trae `alter default privileges in schema public grant
--    all on tables to anon, authenticated, service_role`. Es decir: cada tabla
--    que crea una migración nace con INSERT, UPDATE y DELETE para el rol
--    anónimo, el de la clave pública que viaja al navegador.
--
--    La migración `…000800_rls.sql` concede privilegios, pero nunca revoca, así
--    que esa concesión heredada seguía en pie. RLS lo tapaba —ninguna política
--    deja escribir a un visitante sin sesión—, pero eso es una sola línea de
--    defensa donde el diseño declara dos, y basta una política nueva mal escrita
--    para que se convierta en escritura real. El propio inventario del esquema
--    lo comprueba desde el principio: `verify:schema:hosted` falla si `anon`
--    tiene escritura en alguna tabla.
--
-- 2. Cualquiera podía EJECUTAR las 16 funciones RPC sin haber iniciado sesión.
--
--    PostgreSQL concede EXECUTE a PUBLIC en toda función nueva. Las 16 son
--    SECURITY DEFINER: se ejecutan con los privilegios de quien las creó. Todas
--    comprueban `auth.uid()` y fallan sin sesión, así que no había agujero, pero
--    la superficie expuesta a internet no tiene por qué incluirlas.
--
-- 3. Cuatro funciones de `app_private` no fijaban `search_path`.
--
--    `touch_updated_at`, `generate_reference`, `publish_realtime` y
--    `freeze_offer_terms`. Son SECURITY INVOKER, así que el riesgo es menor que
--    en una SECURITY DEFINER, pero corren dentro de disparadores y de valores
--    por defecto de columna: quien pueda crear objetos en un esquema que vaya
--    antes en el `search_path` de quien escribe decide qué función se resuelve.
--
-- Los tres los reportan los advisors del proyecto. Se arreglan aquí y no
-- editando las migraciones ya aplicadas: el historial describe lo que se aplicó.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. El rol anónimo solo lee
-- -----------------------------------------------------------------------------
-- Primero las tablas y vistas que ya existen. Se revoca todo y se devuelve solo
-- SELECT: `revoke insert, update, delete` no alcanzaría, porque no toca los
-- privilegios de columna, y aquí el objetivo es dejar el estado conocido.
revoke all privileges on all tables in schema public from anon;
grant select on all tables in schema public to anon;

-- Y ahora las que se creen en el futuro. Sin esto, la próxima migración que
-- cree una tabla vuelve a introducir el mismo problema en silencio.
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon;

-- No hay secuencias hoy (todas las claves son uuid), pero el valor por defecto
-- del proyecto también las regala. Una columna `serial` añadida más adelante no
-- debería traer consigo permiso de escritura para un visitante.
revoke all privileges on all sequences in schema public from anon;
alter default privileges in schema public revoke all on sequences from anon;


-- -----------------------------------------------------------------------------
-- 2. Las RPC se ejecutan con sesión iniciada
-- -----------------------------------------------------------------------------
-- `revoke ... from public` quita la concesión implícita de PostgreSQL; el
-- `revoke ... from anon` posterior es para el caso de que alguien la hubiera
-- concedido de forma explícita.
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke execute on functions from anon;

grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

-- `app_private` es interno y no está expuesto por PostgREST, pero las cuatro
-- funciones auxiliares de RLS las evalúa el propio usuario dentro de las
-- políticas, así que ahí EXECUTE sí hace falta y se mantiene como estaba.


-- -----------------------------------------------------------------------------
-- 3. `search_path` fijo en las cuatro funciones que faltaban
-- -----------------------------------------------------------------------------
-- El mismo valor que ya usan las SECURITY DEFINER del repositorio.
alter function app_private.touch_updated_at() set search_path = public, pg_temp;
alter function app_private.generate_reference(text) set search_path = public, pg_temp;
alter function app_private.publish_realtime(regclass) set search_path = public, pg_temp;
alter function app_private.freeze_offer_terms() set search_path = public, pg_temp;
