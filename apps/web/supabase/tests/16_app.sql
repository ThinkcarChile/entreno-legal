\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Lo que la aplicación da por hecho de la base: páginas públicas y panel
-- =============================================================================
-- Prefijo Z. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Esta batería no prueba una migración: prueba los permisos de los que ahora
-- depende el código.
--
--   · `/precios`, `/pago-protegido` y `/como-funciona` publican la comisión y
--     el plazo para reportar un problema leyendo `platform_settings` con la
--     clave pública, sin sesión (`lib/data/public-terms-reader.ts`). Antes
--     leían variables de entorno, y la página podía prometer una comisión
--     distinta de la que cobraba la base. Si `anon` pierde la lectura, la
--     página cae en silencio a los valores por defecto.
--   · `/admin/payouts` y `/admin/disputas` separan lo pendiente del historial
--     por estado (`lib/data/admin-queues.ts`) y cruzan las disputas con las
--     devoluciones confirmadas de `payment_refunds`.
-- =============================================================================

create function pg_temp.expect(label text, actual text, expected text)
returns text language sql as $$
  select label || ' = ' || coalesce(actual, 'NULO') ||
         case when actual is not distinct from expected then ''
              else ' FALLO (esperado ' || coalesce(expected, 'NULO') || ')' end
$$;

create function pg_temp.como(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true)
$$;

create function pg_temp.admin_id()
returns uuid language sql stable as $$
  select id from public.profiles where role = 'ADMIN' order by id limit 1
$$;

create function pg_temp.usuario_id()
returns uuid language sql stable as $$
  select id from public.profiles where role <> 'ADMIN' order by id limit 1
$$;

\echo ''
\echo '--- Las páginas públicas leen la comisión y el plazo sin sesión'

-- Lo que lee `public-terms-reader.ts`, con el rol con que lo lee.
create function pg_temp.terminos_como_anon()
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.como(null);
  set local role anon;
  select commission_bps || '/' || dispute_window_hours into v
    from public.platform_settings;
  reset role;
  return coalesce(v, 'SIN FILA');
exception when others then
  reset role;
  return 'FALLA: ' || sqlerrm;
end $$;

select pg_temp.expect('Z01 anon lee comisión y plazo, y son los de la base',
  pg_temp.terminos_como_anon(),
  (select commission_bps || '/' || dispute_window_hours from public.platform_settings));

select pg_temp.expect('Z02 hay una sola fila de configuración',
  (select count(*)::text from public.platform_settings), '1');

-- Leer no es escribir: que la página pueda leerla no abre la tabla.
create function pg_temp.cambiar_comision_como(p_rol text, p_user uuid)
returns text language plpgsql as $$
declare n integer;
begin
  perform pg_temp.como(p_user);
  execute format('set local role %I', p_rol);
  update public.platform_settings set commission_bps = 0;
  get diagnostics n = row_count;
  reset role;
  perform pg_temp.como(null);
  -- Sin privilegio de UPDATE falla; con él, RLS deja la fila fuera.
  return case when n = 0 then 'RECHAZADO' else 'ACEPTADO' end;
exception
  when insufficient_privilege then
    reset role;
    perform pg_temp.como(null);
    return 'RECHAZADO';
  when others then
    reset role;
    perform pg_temp.como(null);
    return 'FALLA: ' || sqlerrm;
end $$;

select pg_temp.expect('Z03 anon no cambia la comisión',
  pg_temp.cambiar_comision_como('anon', null), 'RECHAZADO');
select pg_temp.expect('Z04 un usuario sin rol de administración tampoco',
  pg_temp.cambiar_comision_como('authenticated', pg_temp.usuario_id()), 'RECHAZADO');
select pg_temp.expect('Z05 la comisión sigue intacta',
  (select (commission_bps > 0)::text from public.platform_settings), 'true');

\echo ''
\echo '--- El panel separa lo pendiente del historial por estado'

-- `admin-queues.ts` enumera los estados cerrados y trata todo lo demás como
-- pendiente. Si uno de esos nombres deja de existir, el historial quedaría
-- vacío y la cuenta de pendientes, inflada.
select pg_temp.expect('Z06 PAID y CANCELLED existen en payout_status',
  (select count(*)::text from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'payout_status' and e.enumlabel in ('PAID', 'CANCELLED')), '2');
select pg_temp.expect('Z07 RESOLVED y WITHDRAWN existen en dispute_status',
  (select count(*)::text from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'dispute_status' and e.enumlabel in ('RESOLVED', 'WITHDRAWN')), '2');

-- Cuántas filas ve cada quien, con su sesión y su rol: lo que harían las
-- consultas del panel a través de PostgREST.
create function pg_temp.contar_como(p_user uuid, p_sql text)
returns text language plpgsql as $$
declare n bigint;
begin
  perform pg_temp.como(p_user);
  set local role authenticated;
  execute p_sql into n;
  reset role;
  perform pg_temp.como(null);
  return n::text;
exception when others then
  reset role;
  perform pg_temp.como(null);
  return 'FALLA: ' || sqlerrm;
end $$;

select pg_temp.expect('Z08 administración ve todos los payouts, de cualquier antigüedad y estado',
  pg_temp.contar_como(pg_temp.admin_id(), 'select count(*) from public.payouts'),
  (select count(*)::text from public.payouts));
select pg_temp.expect('Z09 administración ve todas las disputas',
  pg_temp.contar_como(pg_temp.admin_id(), 'select count(*) from public.disputes'),
  (select count(*)::text from public.disputes));
select pg_temp.expect('Z10 administración lee las devoluciones con su disputa, importe y estado',
  pg_temp.contar_como(pg_temp.admin_id(),
    'select count(*) from (select dispute_id, amount, status from public.payment_refunds) r'),
  (select count(*)::text from public.payment_refunds));
select pg_temp.expect('Z11 un usuario sin rol de administración no ve ninguna devolución',
  pg_temp.contar_como(pg_temp.usuario_id(), 'select count(*) from public.payment_refunds'), '0');
