\set ON_ERROR_STOP on
-- =============================================================================
-- Preparación de la prueba de concurrencia.
--
-- Un trabajo con DOS ofertas pendientes de dos trabajadores verificados. El
-- script de shell lanza dos aceptaciones simultáneas: solo una puede ganar.
-- =============================================================================

create table if not exists public.test_race (key text primary key, value text);

insert into auth.users (id, email, raw_user_meta_data) values
 ('c1111111-1111-4111-8111-111111111111','race.cliente@test.cl','{"first_name":"Rocio","last_name":"Diaz","intent":"CLIENT"}'),
 ('c2222222-2222-4222-8222-222222222222','race.w1@test.cl','{"first_name":"Luis","last_name":"Soto","intent":"WORKER"}'),
 ('c3333333-3333-4333-8333-333333333333','race.w2@test.cl','{"first_name":"Ana","last_name":"Vera","intent":"WORKER"}');

-- Ambos trabajadores quedan verificados (equivale a la aprobación del panel).
update worker_profiles set verification_status = 'VERIFIED', identity_verified = true
 where user_id in ('c2222222-2222-4222-8222-222222222222','c3333333-3333-4333-8333-333333333333');

set role authenticated;
set request.jwt.claim.sub = 'c1111111-1111-4111-8111-111111111111';
select publish_job(jsonb_build_object(
  'categoryId', (select id from job_categories where slug = 'filas-conciertos-eventos'),
  'title', 'Fila para entradas de concierto en el Movistar Arena',
  'description', 'Necesito que alguien tome lugar en la fila desde temprano y me avise cómo avanza.',
  'regionCode', '13', 'communeCode', '13-santiago',
  'addressLine', 'Av. Beauchef 1204',
  'startsAt', (now() + interval '4 days')::text,
  'estimatedDurationMinutes', 240,
  'objectiveType', 'AS_FRONT_AS_POSSIBLE',
  'hourlyRate', '10000'
)) as race_job_id \gset
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = 'c2222222-2222-4222-8222-222222222222';
insert into job_offers (job_id, worker_id, hourly_rate, estimated_total)
values (:'race_job_id'::uuid, 'c2222222-2222-4222-8222-222222222222', 9000, 36000)
returning id as offer_a \gset
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = 'c3333333-3333-4333-8333-333333333333';
insert into job_offers (job_id, worker_id, hourly_rate, estimated_total)
values (:'race_job_id'::uuid, 'c3333333-3333-4333-8333-333333333333', 11000, 44000)
returning id as offer_b \gset
reset role; reset request.jwt.claim.sub;

insert into public.test_race (key, value) values
  ('job', :'race_job_id'), ('offer_a', :'offer_a'), ('offer_b', :'offer_b')
on conflict (key) do update set value = excluded.value;
