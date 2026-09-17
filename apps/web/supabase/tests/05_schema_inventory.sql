\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Inventario del esquema
-- =============================================================================
-- Cuenta los objetos que debe tener un proyecto con todas las migraciones
-- aplicadas. Sirve para dos cosas:
--
--   1. Detectar una migración que no se aplicó: en un proyecto Supabase real se
--      corre la misma consulta (ver docs/DESPLIEGUE-SUPABASE.md) y las cifras
--      tienen que coincidir.
--   2. Avisar si alguien borra sin querer una política o una función.
--
-- Cuando el esquema crezca a propósito, se actualizan estos números Y la tabla
-- de la guía de despliegue. Que haya que tocar los dos sitios es intencional:
-- es lo que mantiene la documentación sincronizada.
-- =============================================================================

with inventario as (
  select
    (select count(*) from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name <> 'test_race')                                  as tablas,
    (select count(*) from information_schema.views
      where table_schema = 'public')                                    as vistas,
    (select count(*) from information_schema.routines
      where routine_schema = 'public')                                  as funciones_rpc,
    (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype = 'e')                   as enums,
    (select count(*) from pg_policies where schemaname = 'public')      as politicas_rls,
    (select count(*) from storage.buckets)                              as buckets,
    (select count(*) from public.communes)                              as comunas,
    (select count(*) from public.regions)                               as regiones,
    (select count(*) from public.job_categories)                        as categorias,
    (select commission_bps from public.platform_settings)               as comision_pb
),
esperado as (
  select 32 as tablas, 5 as vistas, 16 as funciones_rpc, 19 as enums,
         73 as politicas_rls, 5 as buckets, 346 as comunas, 16 as regiones,
         9 as categorias, 1400 as comision_pb
)
select 'I' || lpad((row_number() over ())::text, 2, '0') || ' ' || nombre || ' = ' || actual ||
       case when actual = esperado then '' else ' FALLO (esperado ' || esperado || ')' end
  from (
    select 'tablas' as nombre, i.tablas as actual, e.tablas as esperado from inventario i, esperado e
    union all select 'vistas', i.vistas, e.vistas from inventario i, esperado e
    union all select 'funciones RPC', i.funciones_rpc, e.funciones_rpc from inventario i, esperado e
    union all select 'enums', i.enums, e.enums from inventario i, esperado e
    union all select 'políticas RLS', i.politicas_rls, e.politicas_rls from inventario i, esperado e
    union all select 'buckets de Storage', i.buckets, e.buckets from inventario i, esperado e
    union all select 'comunas', i.comunas, e.comunas from inventario i, esperado e
    union all select 'regiones', i.regiones, e.regiones from inventario i, esperado e
    union all select 'categorías', i.categorias, e.categorias from inventario i, esperado e
    union all select 'comisión (pb)', i.comision_pb, e.comision_pb from inventario i, esperado e
  ) filas;

-- Toda tabla de `public` debe tener RLS activo. Sin excepciones.
select 'I11 tablas sin RLS = ' || coalesce(string_agg(c.relname, ', '), 'ninguna')
       || case when count(*) > 0 then ' FALLO' else '' end
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'r'
   and c.relname not in ('test_race')
   and not c.relrowsecurity;

-- Las vistas deben respetar las políticas de quien consulta.
select 'I12 vistas sin security_invoker = ' ||
       coalesce(string_agg(c.relname, ', '), 'ninguna')
       || case when count(*) > 0 then ' FALLO' else '' end
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind = 'v'
   and not coalesce((
     select option_value::boolean
       from pg_options_to_table(c.reloptions)
      where option_name = 'security_invoker'
   ), false);
