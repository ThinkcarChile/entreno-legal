#!/usr/bin/env node
/**
 * INVENTARIO VIVO DE PRIVILEGIOS EN PRODUCCIÓN. Sólo lectura.
 *
 * Pregunta por PRIVILEGIO EFECTIVO, y "efectivo" es más estrecho que
 * `has_function_privilege`: para llegar a una función hay que poder entrar al
 * esquema. Después de la 0062, `anon` conserva el EXECUTE sobre decenas de
 * funciones del esquema `app` y no puede tocar ninguna, porque perdió el USAGE.
 * Contar sólo el privilegio de función exagera el número abierto; contar sólo el
 * esquema lo esconde. Van los dos, y separados.
 *
 * Tampoco lee el ACL como texto. Un `proacl` vacío significa "los permisos por
 * omisión", que para una función son EXECUTE para PUBLIC — lo contrario de lo
 * que parece. Leer el texto en vez de preguntarle a la base es cómo se declara
 * cerrado algo que está abierto.
 *
 * No escribe: ni DDL, ni DML, ni grant, ni revoke.
 */
import { credenciales, ejecutorSupabase, redactar } from "./respaldo-lib.mjs";

const CONSULTAS = {
  resumen: `
    select
      count(*) filter (where p.prosecdef)::int as secdef_total,
      count(*) filter (where p.prosecdef and has_function_privilege('anon', p.oid, 'execute'))::int as anon_secdef_acl,
      count(*)::int as funciones_totales
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')`,

  esquemas: `
    select
      has_schema_privilege('anon', 'app', 'usage') as anon_app,
      has_schema_privilege('authenticated', 'app', 'usage') as auth_app,
      has_schema_privilege('anon', 'public', 'usage') as anon_public`,

  efectivo_por_esquema: `
    select n.nspname as esquema,
           count(*)::int as total,
           count(*) filter (where has_function_privilege('anon', p.oid, 'execute'))::int as anon_acl,
           count(*) filter (where has_function_privilege('anon', p.oid, 'execute')
                              and has_schema_privilege('anon', n.nspname, 'usage'))::int as anon_efectivo,
           count(*) filter (where has_function_privilege('anon', p.oid, 'execute')
                              and has_schema_privilege('anon', n.nspname, 'usage')
                              and p.prosecdef)::int as anon_efectivo_secdef,
           count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')
                              and has_schema_privilege('authenticated', n.nspname, 'usage'))::int as auth_efectivo
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app')
    group by 1 order by 1`,

  anon_alcanzables_en_public: `
    select p.proname as fn, p.prosecdef as secdef, p.provolatile as volatilidad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anon', p.oid, 'execute')
    order by 1`,

  tablas_alcanzables_por_anon: `
    select count(distinct table_name)::int as tablas,
           count(*) filter (where privilege_type = 'SELECT')::int as con_select,
           count(*) filter (where privilege_type in ('INSERT','UPDATE','DELETE'))::int as con_escritura
    from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'`,

  politicas_que_evalua_anon: `
    -- Una política SIN cláusula TO nace TO PUBLIC, y PUBLIC incluye a anon.
    -- Ésta es la consulta que faltaba: cuenta las que anon SÍ evalúa.
    select tablename, policyname, cmd, qual
    from pg_policies where schemaname = 'public' and 'public' = any(roles)
    order by 1, 2`,
};

const main = async () => {
  const { token, ref } = credenciales();
  const ejecutor = ejecutorSupabase({ token, ref });
  const salida = { proyecto: ref };
  for (const [nombre, sql] of Object.entries(CONSULTAS)) {
    try {
      salida[nombre] = await ejecutor.ejecutar(sql);
    } catch (e) {
      salida[nombre] = { error: redactar(e.message ?? String(e)) };
    }
  }
  console.log(JSON.stringify(salida, null, 2));
};

main().catch((e) => {
  console.error(redactar(e.message ?? String(e)));
  process.exit(1);
});
