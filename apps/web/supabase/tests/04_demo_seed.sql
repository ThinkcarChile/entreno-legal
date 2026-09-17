\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- =============================================================================
-- Comprobaciones sobre la semilla de demostración
-- =============================================================================
-- La semilla se prueba igual que el esquema: si se rompe, el equipo pierde el
-- entorno con el que revisa el producto.
-- =============================================================================

select 'S01 cuentas de demostración creadas = ' || count(*)
  from auth.users where email like '%@demo.cl';
select 'S02 perfiles con onboarding completo = ' || count(*)
  from profiles where onboarding_completed_at is not null and id::text like 'd0000000%';
select 'S03 regiones distintas con trabajos = ' || count(distinct region_code)
  from jobs where id::text like 'e0000000%';
select 'S04 trabajos abiertos de demostración = ' || count(*)
  from jobs where id::text like 'e0000000%' and status = 'PUBLISHED';
select 'S05 trabajadores verificados = ' || count(*)
  from worker_profiles where verification_status = 'VERIFIED';
select 'S06 verificación pendiente para el panel = ' || count(*)
  from worker_verifications where status = 'PENDING';
select 'S07 ofertas sembradas = ' || count(*)
  from job_offers where id::text like 'f0000000%';
select 'S08 trabajo asignado y pagado = ' || count(*)
  from assignments a join payments p on p.assignment_id = a.id
 where a.id::text like 'a0000000%' and p.status = 'PAID';
select 'S09 mensajes en conversaciones = ' || count(*) from messages
 where conversation_id::text like 'c0000000%';
select 'S10 payouts generados por el pago = ' || count(*)
  from payouts where assignment_id::text like 'a0000000%';
select 'S11 reseña verificada del trabajo completado = ' || count(*)
  from reviews r join assignments a on a.id = r.assignment_id
 where a.status = 'COMPLETED';
select 'S12 direcciones exactas guardadas aparte = ' || count(*)
  from job_private_location where job_id::text like 'e0000000%';

-- Cada trabajo abierto debe ser visible para cualquiera, y su dirección no.
set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-4000-8000-000000000016';
select 'S13 trabajos abiertos visibles para un tercero = ' || count(*)
  from jobs where status = 'PUBLISHED' and id::text like 'e0000000%';
select 'S14 direcciones exactas visibles para un tercero = ' || count(*)
  from job_private_location where job_id::text like 'e0000000%';
reset role; reset request.jwt.claim.sub;

-- El trabajador asignado sí ve la dirección de SU trabajo, y solo de ese.
set role authenticated;
set request.jwt.claim.sub = 'd0000000-0000-4000-8000-000000000013';
select 'S15 direcciones visibles para el trabajador asignado = ' || count(*)
  from job_private_location where job_id::text like 'e0000000%';
reset role; reset request.jwt.claim.sub;
