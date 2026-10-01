-- =============================================================================
-- HagoTuFila · Reparación única: restos de la limpieza antigua de las pruebas e2e
-- =============================================================================
-- NO es una migración. Se ejecuta UNA vez, a mano, en el SQL Editor del
-- proyecto de DESARROLLO (hagotufila-dev). Ver docs/DESPLIEGUE-SUPABASE.md §8.3.
--
-- Qué repara. Hasta esta versión, `e2e/marketplace.spec.ts` «retiraba» su
-- trabajo forzando `jobs.status = 'CANCELLED'` con la clave de servicio, cuando
-- el trabajo ya estaba pagado. Cada ejecución dejó un trabajo cancelado con un
-- cobro PAID, una asignación CONFIRMED y un payout PENDING: cuatro reglas de
-- `app_private.payment_invariant_violations()` rotas. Desde 20260601001520 las
-- tareas programadas corren esas reglas cada 10 minutos y avisan a cada
-- administrador (`INTEGRITY_ALERT`), así que esos restos serían una alarma
-- permanente.
--
-- Un trabajo CANCELLED no se puede reabrir (`guard_job_terminal`), y el cobro
-- es simulado: no hay dinero que devolver. Lo correcto es borrar esos restos,
-- en orden de dependencias.
--
-- Qué toca, y nada más:
--   · trabajos con el título que pone esa prueba
--     («Fila para lanzamiento de zapatillas e2e-<marca>»), en estado CANCELLED;
--   · solo si todos sus cobros son del proveedor simulado (`mock`,
--     `mock-delayed`) o nunca llegaron a uno (`pending`): un cobro de Webpay,
--     aunque sea de integración, no se borra;
--   · solo si no tienen disputa ni devolución registrada.
--
-- Sirve antes o después de `npm run db:push:hosted`: lo que no existe todavía
-- en el esquema antiguo (`payment_attempts`, `check_invariants`) se salta.
-- Ejecutarlo dos veces no hace nada la segunda. La consulta del final dice
-- si quedó algo.
-- =============================================================================

do $$
declare
  v_jobs uuid[];
begin
  select coalesce(array_agg(j.id), '{}')
    into v_jobs
    from public.jobs j
   where j.title like 'Fila para lanzamiento de zapatillas e2e-%'
     and j.status = 'CANCELLED'
     and not exists (
       select 1 from public.payments p
        where p.job_id = j.id
          and p.provider not in ('mock', 'mock-delayed', 'pending')
     )
     and not exists (
       select 1 from public.disputes d
         join public.assignments a on a.id = d.assignment_id
        where a.job_id = j.id
     );

  -- Las tablas de devoluciones no existen en el esquema antiguo.
  if to_regclass('public.payment_refunds') is not null then
    execute $q$
      select coalesce(array_agg(t.job_id), '{}') from unnest($1) as t(job_id)
       where not exists (
         select 1 from public.payment_refunds r
           join public.payments p on p.id = r.payment_id
          where p.job_id = t.job_id
       )
    $q$ into v_jobs using v_jobs;
  end if;
  if to_regclass('public.payment_attempt_refunds') is not null then
    execute $q$
      select coalesce(array_agg(t.job_id), '{}') from unnest($1) as t(job_id)
       where not exists (
         select 1 from public.payment_attempt_refunds r
           join public.payments p on p.id = r.payment_id
          where p.job_id = t.job_id
       )
    $q$ into v_jobs using v_jobs;
  end if;

  raise notice 'Restos de e2e a borrar: %', cardinality(v_jobs);
  if cardinality(v_jobs) = 0 then
    return;
  end if;

  -- Orden de dependencias: payout → intentos → cobro → trabajo. El trabajo
  -- arrastra en cascada asignación, ofertas, conversación y notificaciones.
  delete from public.payouts
   where assignment_id in (select a.id from public.assignments a where a.job_id = any (v_jobs));

  if to_regclass('public.payment_attempts') is not null then
    execute 'delete from public.payment_attempts
              where payment_id in (select p.id from public.payments p where p.job_id = any ($1))'
      using v_jobs;
  end if;

  delete from public.payments where job_id = any (v_jobs);
  delete from public.jobs where id = any (v_jobs);

  -- Que la alerta de integridad, si ya saltó, se dé por resuelta sin esperar
  -- a la próxima pasada de pg_cron.
  if to_regprocedure('app_private.check_invariants()') is not null then
    execute 'select app_private.check_invariants()';
  end if;
end;
$$;

-- Comprobación. `restos_e2e` debe ser 0. `invariantes_rotos` cuenta TODO el
-- proyecto: si no es 0, lo que queda no es de esta prueba y se mira con
-- `select * from app_private.payment_invariant_violations();`.
select
  (select count(*) from public.jobs j
    where j.title like 'Fila para lanzamiento de zapatillas e2e-%'
      and j.status = 'CANCELLED'
      and exists (select 1 from public.payments p
                   where p.job_id = j.id and p.status = 'PAID'))      as restos_e2e,
  (select count(*) from app_private.payment_invariant_violations())  as invariantes_rotos;
