\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Despliegue y operación: datos de referencia, search_path y restos de pruebas
-- =============================================================================
-- Prefijo M. Cada comprobación se afirma sola: imprime FALLO si no coincide.
--
-- Los defectos que cierra esta batería, reproducidos antes de corregirlos:
--
--   · Las migraciones no traían regiones ni comunas, y la documentación
--     prohibía aplicar la semilla en producción: nadie terminaba el registro
--     ni publicaba un trabajo (20260601001900).
--   · `app_private.job_is_approvable` no fijaba search_path: el advisor de
--     Supabase lo reporta y `verify:schema:hosted` falla (20260601001910).
--   · La limpieza de `e2e/marketplace.spec.ts` forzaba CANCELLED sobre un
--     trabajo pagado y rompía cuatro invariantes que, desde 20260601001520,
--     las tareas programadas avisan a cada administrador. La prueba usa ahora
--     `cancel_job` con la sesión del cliente; los restos antiguos se borran
--     con supabase/ops/reparar-restos-e2e-dev.sql, que aquí se ejecuta tal
--     cual.
--
-- M01 y M02 reciben de scripts/db-test.sh lo que había ANTES y DESPUÉS de la
-- semilla geográfica (`-v geo_migraciones=… -v geo_semilla=…`): a estas
-- alturas ya no se distingue quién cargó cada fila.
--
-- Ojo al escribir comprobaciones: una consulta ve los datos como estaban al
-- EMPEZAR la sentencia, y `set_config(..., true)` dura lo que dura la
-- sentencia. Cada acción va en su propia sentencia y la comprobación en la
-- siguiente.
-- =============================================================================

\if :{?geo_migraciones}
\else
\set geo_migraciones 'sin dato: este archivo se corre desde scripts/db-test.sh|'
\endif
\if :{?geo_semilla}
\else
\set geo_semilla 'sin dato|'
\endif

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

-- Trabajo con oferta aceptada y pago iniciado, como lo deja la aplicación. Con
-- `p_pagado`, el pago simulado se confirma: es el estado en que termina el
-- recorrido de `e2e/marketplace.spec.ts` (trabajo PAID, asignación CONFIRMED,
-- payout PENDING).
create function pg_temp.montar(
  p_titulo text,
  p_pagado boolean,
  p_proveedor text default 'mock',
  out job_id uuid,
  out assignment_id uuid,
  out payment_id uuid,
  out client_id uuid
)
language plpgsql
as $$
declare
  v_offer uuid;
  v_worker uuid;
  v_tag text := substr(md5(random()::text), 1, 10);
begin
  select w.user_id into v_worker from public.worker_profiles w
   where w.verification_status = 'VERIFIED' order by w.user_id limit 1;
  select u.id into client_id from auth.users u
   where u.id <> v_worker and exists (select 1 from public.profiles p where p.id = u.id)
   order by u.id limit 1;

  job_id := gen_random_uuid();
  insert into public.jobs (
    id, client_id, category_id, status, title, description, region_code, commune_code,
    place_name, starts_at, estimated_duration_minutes, objective_type, hourly_rate,
    published_at
  ) values (
    job_id, client_id, (select id from public.job_categories order by sort_order limit 1), 'PUBLISHED',
    p_titulo,
    'Montaje de la prueba de los restos que dejaba la limpieza de las pruebas e2e.',
    '13', '13-providencia', 'Tienda de prueba', now() + interval '3 days', 300, 'HOLD_PLACE', 10000,
    now()
  );
  insert into public.job_private_location (job_id, address_line, lat, lng)
  values (job_id, 'Av. Providencia 1234, local 5', -33.4265, -70.6153);

  insert into public.job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values (job_id, v_worker, 9000, 45000, 'Oferta de prueba ' || v_tag)
  returning id into v_offer;

  perform pg_temp.como(client_id);
  assignment_id := public.accept_job_offer(v_offer);
  payment_id := public.start_protected_payment(assignment_id);
  perform pg_temp.como(null);

  update public.payments
     set status = 'CREATED', provider = p_proveedor,
         environment = case when p_proveedor like 'transbank%' then 'integration' else environment end,
         provider_transaction_id = 'm-' || v_tag
   where id = payment_id;

  if p_pagado then
    perform public.confirm_payment_result(payment_id, p_proveedor, 'evt-m-' || v_tag, 'PAID', null, '{}');
  end if;
end;
$$;

-- Invariantes rotos que apuntan a un trabajo: a él, a sus asignaciones, a sus
-- cobros o a sus payouts. Las demás pruebas pueden dejar los suyos.
create function pg_temp.reglas_de(p_job uuid)
returns text language sql stable as $$
  select coalesce(string_agg(distinct v.rule, ', ' order by v.rule), 'ninguna')
    from (
      select rule, entity_id from app_private.payment_invariant_violations()
      union all
      select rule, entity_id from app_private.refund_invariant_violations()
    ) v
   where v.entity_id = p_job
      or v.entity_id in (select a.id from public.assignments a where a.job_id = p_job)
      or v.entity_id in (select p.id from public.payments p where p.job_id = p_job)
      or v.entity_id in (select po.id from public.payouts po
                           join public.assignments a on a.id = po.assignment_id
                          where a.job_id = p_job)
$$;

-- `cancel_job` con la sesión de quien llama; devuelve el error si lo hay.
create function pg_temp.cancelar_como(p_user uuid, p_job uuid)
returns text language plpgsql as $$
begin
  perform pg_temp.como(p_user);
  perform public.cancel_job(p_job, 'Limpieza de la prueba e2e');
  perform pg_temp.como(null);
  return 'cancelado';
exception when others then
  perform pg_temp.como(null);
  return 'rechazado';
end;
$$;


-- =============================================================================
-- 1. Regiones y comunas llegan con las migraciones (20260601001900)
-- =============================================================================

-- Sin la migración, las migraciones solas dejan 0 regiones y 0 comunas, y
-- scripts/db-test.sh se detiene antes de aplicar la semilla.
select pg_temp.expect('M01 regiones y comunas que dejan las migraciones, sin semilla',
  split_part(:'geo_migraciones', '|', 1), '16 regiones, 346 comunas');

-- La semilla es ahora una reaplicación inocua: no añade ni cambia nada. Si
-- alguien regenera la semilla con otra lista de comunas y no escribe la
-- migración que la acompaña, esto lo delata.
select pg_temp.expect('M02 la semilla 001_geo.sql no cambia nada de lo que traen las migraciones',
  case when :'geo_migraciones' = :'geo_semilla' then 'sí'
       else 'no: ' || split_part(:'geo_semilla', '|', 1) end,
  'sí');

-- Lo que sin ellas fallaba: el registro (claves foráneas de `profiles`) y la
-- comuna que exige `publish_job`.
select pg_temp.expect('M03 la comuna de Viña del Mar existe y es de Valparaíso',
  (select c.region_code from public.communes c where c.code = '05-vina-del-mar'), '05');

select pg_temp.expect('M04 la migración trae las filas de la semilla, comuna por comuna',
  (select count(*)::text from public.communes c
    where c.code in ('15-arica', '12-torres-del-paine', '13-providencia', '11-o-higgins')), '4');


-- =============================================================================
-- 2. `job_is_approvable` con search_path fijo (20260601001910)
-- =============================================================================

select pg_temp.expect('M05 job_is_approvable fija search_path',
  (select array_to_string(p.proconfig, ',') from pg_proc p
    where p.oid = 'app_private.job_is_approvable(public.job_status)'::regprocedure),
  'search_path=public, pg_temp');

select pg_temp.expect('M06 job_is_approvable sigue respondiendo lo mismo',
  (select string_agg(s::text || ':' || app_private.job_is_approvable(s)::text, ' ' order by s)
     from unnest(array['PUBLISHED', 'PAID', 'IN_PROGRESS', 'HANDOFF_COMPLETED', 'CANCELLED',
                       'CLOSED']::public.job_status[]) s),
  (select string_agg(s::text || ':' || (s::text in ('PAID', 'IN_PROGRESS', 'HANDOFF_COMPLETED'))::text,
                     ' ' order by s)
     from unnest(array['PUBLISHED', 'PAID', 'IN_PROGRESS', 'HANDOFF_COMPLETED', 'CANCELLED',
                       'CLOSED']::public.job_status[]) s));

-- Ni la volatilidad ni los privilegios cambian con `alter function`.
select pg_temp.expect('M07 job_is_approvable sigue inmutable y sin EXECUTE para anon',
  (select p.provolatile::text || ' ' ||
          has_function_privilege('anon', p.oid, 'execute')::text
     from pg_proc p
    where p.oid = 'app_private.job_is_approvable(public.job_status)'::regprocedure),
  'i false');


-- =============================================================================
-- 3. La limpieza nueva de la prueba e2e: `cancel_job` con la sesión del cliente
-- =============================================================================

-- El recorrido completo termina con el trabajo pagado. La base se niega a
-- cancelarlo y el trabajo queda como está: sin ningún invariante roto.
select job_id as m_pagado_job, client_id as m_pagado_cliente
  from pg_temp.montar('Fila para lanzamiento de zapatillas e2e-2200000000001', true) \gset

select pg_temp.expect('M08 limpieza nueva sobre un trabajo pagado: cancel_job se niega',
  pg_temp.cancelar_como(:'m_pagado_cliente', :'m_pagado_job'), 'rechazado');

select pg_temp.expect('M09 el trabajo pagado queda PAID, con asignación CONFIRMED y payout PENDING',
  (select j.status::text || ' ' || a.status::text || ' ' || po.status::text
     from public.jobs j
     join public.assignments a on a.job_id = j.id
     join public.payouts po on po.assignment_id = a.id
    where j.id = :'m_pagado_job'),
  'PAID CONFIRMED PENDING');

select pg_temp.expect('M10 y sin ningún invariante roto',
  pg_temp.reglas_de(:'m_pagado_job'), 'ninguna');

-- Si el recorrido se cortó antes del pago, se cancela de verdad. Con un pago
-- que llegó al proveedor (el simulado le pone identificador), la cancelación
-- queda en verificación hasta saber qué pasó con él.
select job_id as m_sin_pago_job, client_id as m_sin_pago_cliente
  from pg_temp.montar('Fila para lanzamiento de zapatillas e2e-2200000000002', false) \gset

select pg_temp.expect('M11 limpieza nueva antes del pago: cancel_job cancela',
  pg_temp.cancelar_como(:'m_sin_pago_cliente', :'m_sin_pago_job'), 'cancelado');

select pg_temp.expect('M12 el trabajo sin pagar queda en cancelación y sin invariantes rotos',
  (select status::text from public.jobs where id = :'m_sin_pago_job')
    || ' · ' || pg_temp.reglas_de(:'m_sin_pago_job'),
  'CANCELLATION_PENDING · ninguna');


-- =============================================================================
-- 4. Los restos de la limpieza antigua, y su reparación
-- =============================================================================
-- Todo esto va en una transacción que se deshace al final: los casos que la
-- reparación NO debe tocar quedan con invariantes rotos a propósito.

begin;

-- La limpieza antigua: la clave de servicio fuerza CANCELLED sobre el trabajo
-- pagado. Es lo que ya hay en hagotufila-dev.
select job_id as m_resto_job, assignment_id as m_resto_asig, payment_id as m_resto_pago
  from pg_temp.montar('Fila para lanzamiento de zapatillas e2e-2200000000003', true) \gset

set local role service_role;
update public.jobs set status = 'CANCELLED' where id = :'m_resto_job';
reset role;

select pg_temp.expect('M13 la limpieza antigua rompe cuatro invariantes',
  pg_temp.reglas_de(:'m_resto_job'),
  'cancelled_job_with_live_assignment, enabled_assignment_on_cancelled_job, '
  || 'paid_payment_on_cancelled_job, payout_on_cancelled_job');

-- Dos casos que la reparación NO debe borrar: un trabajo pagado que no es de
-- la prueba, con el mismo estado roto, y uno con el título de la prueba cuyo
-- cobro pasó por Webpay (aquí, sin confirmar).
select job_id as m_ajeno_job
  from pg_temp.montar('Fila de un cliente de verdad', true) \gset
select job_id as m_webpay_job
  from pg_temp.montar('Fila para lanzamiento de zapatillas e2e-2200000000004', false,
                      'transbank_webpay_plus') \gset

set local role service_role;
update public.jobs set status = 'CANCELLED' where id in (:'m_ajeno_job', :'m_webpay_job');
reset role;

-- La reparación documentada, tal cual (en el SQL Editor se pega su contenido).
set local client_min_messages = warning;
\o /dev/null
\ir ../ops/reparar-restos-e2e-dev.sql
\o
reset client_min_messages;

select pg_temp.expect('M14 la reparación borra el resto: trabajo, asignación, cobro y payout',
  (select count(*) from public.jobs where id = :'m_resto_job') || ' ' ||
  (select count(*) from public.assignments where id = :'m_resto_asig') || ' ' ||
  (select count(*) from public.payments where id = :'m_resto_pago') || ' ' ||
  (select count(*) from public.payouts where assignment_id = :'m_resto_asig'),
  '0 0 0 0');

select pg_temp.expect('M15 y con él desaparecen sus cuatro reglas',
  (select count(*)::text from app_private.payment_invariant_violations() v
    where v.entity_id in (:'m_resto_asig', :'m_resto_pago')), '0');

select pg_temp.expect('M16 la reparación no toca un trabajo que no es de la prueba',
  (select status::text from public.jobs where id = :'m_ajeno_job'), 'CANCELLED');

select pg_temp.expect('M17 ni uno de la prueba con un cobro de Webpay',
  (select status::text from public.jobs where id = :'m_webpay_job'), 'CANCELLED');

-- La reparación termina pasando los invariantes: la alerta de la regla ya
-- cuenta solo el caso ajeno, sin esperar a la próxima pasada de pg_cron.
select pg_temp.expect('M18 al terminar corre los invariantes: la alerta ya cuenta solo el caso ajeno',
  (select violation_count::text from app_private.integrity_alerts
    where kind = 'paid_payment_on_cancelled_job' and resolved_at is null), '1');

rollback;

-- Fuera de la transacción, sobre una base sin restos: no borra nada.
select count(*) as m_trabajos_antes from public.jobs \gset
set client_min_messages = warning;
\o /dev/null
\ir ../ops/reparar-restos-e2e-dev.sql
\o
reset client_min_messages;

select pg_temp.expect('M19 sin restos, la reparación no borra nada (se puede repetir)',
  (select count(*)::text from public.jobs), :'m_trabajos_antes');
