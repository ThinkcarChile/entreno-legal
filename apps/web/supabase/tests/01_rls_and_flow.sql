\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- La semilla geográfica (supabase/seed/001_geo.sql) ya debe estar aplicada.
select 'T00 comunas cargadas = ' || count(*) from communes;

-- Alta de usuarios: el trigger debe crear perfil, datos privados y FilaPuntos.
insert into auth.users (id, email, raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111','cliente@test.cl','{"first_name":"Valentina","last_name":"Rojas","intent":"CLIENT"}'),
 ('22222222-2222-2222-2222-222222222222','worker@test.cl','{"first_name":"Camila","last_name":"Fernandez","intent":"WORKER"}'),
 ('33333333-3333-3333-3333-333333333333','otro@test.cl','{"first_name":"Intruso","last_name":"Lopez","intent":"CLIENT"}'),
 ('44444444-4444-4444-4444-444444444444','admin@test.cl','{"first_name":"Admin","last_name":"HTF","intent":"CLIENT"}');

update profiles set role = 'ADMIN' where id = '44444444-4444-4444-4444-444444444444';

select 'T01 perfiles creados por trigger = ' || count(*) from profiles;
select 'T02 apellido publico solo inicial = ' || coalesce(last_name_initial,'NULO')
  from profiles where id = '22222222-2222-2222-2222-222222222222';
select 'T03 cuentas FilaPuntos creadas = ' || count(*) from loyalty_accounts;

-- El trabajador parte sin verificar y sin poder aceptar trabajos.
select 'T04 estado verificacion inicial = ' || verification_status
  from worker_profiles where user_id = '22222222-2222-2222-2222-222222222222';

-- ---------------------------------------------------------------------------
-- RLS: un usuario no puede leer datos privados de otro cambiando el id.
-- ---------------------------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

select 'T05 datos privados ajenos visibles = ' || count(*)
  from user_private_data where user_id = '11111111-1111-1111-1111-111111111111';
select 'T06 datos privados propios visibles = ' || count(*)
  from user_private_data where user_id = '33333333-3333-3333-3333-333333333333';
select 'T07 perfil publico ajeno visible = ' || count(*)
  from profiles where id = '11111111-1111-1111-1111-111111111111';

reset role;
reset request.jwt.claim.sub;

-- ---------------------------------------------------------------------------
-- Publicación de un trabajo por su dueño.
-- ---------------------------------------------------------------------------
-- El montaje lo hace el sistema, no un usuario: desde la migración …000100
-- `authenticated` no inserta en `jobs` ni en `job_private_location`. En la
-- aplicación ese trabajo lo crea `publish_job`, que es SECURITY DEFINER y corre
-- como `postgres`. Aquí se reproduce esa misma posición. Las comprobaciones de
-- quién puede leerlo y modificarlo siguen ejecutándose como usuario.
reset role; reset request.jwt.claim.sub;

-- Desde la Etapa 2 la direccion exacta vive en job_private_location.
insert into jobs (
  id, client_id, category_id, status, title, description,
  region_code, commune_code, place_name, starts_at,
  estimated_duration_minutes, objective_type, objective_target_position,
  bonus_amount, bonus_conditions, hourly_rate, published_at
) values (
  '99999999-9999-9999-9999-999999999999',
  '11111111-1111-1111-1111-111111111111',
  (select id from job_categories where slug = 'filas-conciertos-eventos'),
  'PUBLISHED',
  'Fila para entradas de concierto en Costanera Center',
  'Necesito alguien que haga la fila el sabado desde las cinco de la manana hasta las diez.',
  '13','13-providencia','Costanera Center', now() + interval '3 days',
  300, 'WITHIN_FIRST_N', 10, 15000, 'Si queda entre los primeros 10', 10000, now()
);

insert into job_private_location (job_id, address_line, lat, lng)
values ('99999999-9999-9999-9999-999999999999', 'Av. Andres Bello 2447', -33.4173, -70.6065);

select 'T08 trabajo publicado = ' || count(*) from jobs;

-- Un tercero no puede editar el trabajo de otro.
reset role; reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
-- Desde la migración …000100 `authenticated` no tiene UPDATE sobre `jobs`:
-- esto falla por privilegio antes de que RLS llegue a opinar. Se acepta
-- cualquiera de las dos negativas y se informa cero filas modificadas.
do $$
declare
  v_filas integer := 0;
begin
  begin
    update jobs set title = 'Titulo secuestrado por un tercero'
     where id = '99999999-9999-9999-9999-999999999999';
    get diagnostics v_filas = row_count;
  exception when insufficient_privilege then
    v_filas := 0;
  end;
  raise notice 'T09 filas modificadas por un tercero = %', v_filas;
end $$;

-- ---------------------------------------------------------------------------
-- Ofertas: sin verificación no se puede ofertar.
-- ---------------------------------------------------------------------------
reset role; reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
begin
  insert into job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
  values ('99999999-9999-9999-9999-999999999999','22222222-2222-2222-2222-222222222222',
          8500, 42500, 'Puedo llegar a las 04:40');
  raise notice 'T10 FALLO: un trabajador sin verificar pudo ofertar';
exception when insufficient_privilege or others then
  raise notice 'T10 OK: oferta bloqueada sin verificacion';
end $$;

-- La administración verifica al trabajador desde el servidor (rol de servicio).
reset role; reset request.jwt.claim.sub;
set role service_role;
update worker_profiles
   set verification_status = 'VERIFIED', identity_verified = true,
       phone_verified = true, bank_account_verified = true, is_accepting_jobs = true
 where user_id = '22222222-2222-2222-2222-222222222222';
reset role; reset request.jwt.claim.sub;

select 'T10b verificacion aplicada por el servidor = ' || verification_status
  from worker_profiles where user_id = '22222222-2222-2222-2222-222222222222';

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
begin
  update public.worker_profiles set trust_index = 100, level = 'EXPERTO'
   where user_id = '22222222-2222-2222-2222-222222222222';
  raise notice 'T10c FALLO: el trabajador pudo editar su propia reputacion';
exception when insufficient_privilege then
  raise notice 'T10c OK: edicion de reputacion propia denegada';
end $$;
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into job_offers (job_id, worker_id, hourly_rate, estimated_total, message)
values ('99999999-9999-9999-9999-999999999999','22222222-2222-2222-2222-222222222222',
        8500, 42500, 'Puedo llegar a las 04:40');

reset role; reset request.jwt.claim.sub;
select 'T11 contador de ofertas del trabajo = ' || offer_count
  from jobs where id = '99999999-9999-9999-9999-999999999999';

-- Un tercero no ve ofertas de un trabajo que no es suyo.
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select 'T12 ofertas visibles para un tercero = ' || count(*) from job_offers;
reset role; reset request.jwt.claim.sub;

-- El cliente dueño sí las ve.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 'T13 ofertas visibles para el cliente = ' || count(*) from job_offers;
reset role; reset request.jwt.claim.sub;

-- ---------------------------------------------------------------------------
-- Asignación, pago y PIN de entrega.
-- ---------------------------------------------------------------------------
update job_offers set status = 'ACCEPTED', responded_at = now();

insert into assignments (
  id, job_id, offer_id, worker_id, client_id, status,
  agreed_hourly_rate, agreed_duration_minutes, agreed_total, bonus_amount
) values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '99999999-9999-9999-9999-999999999999',
  (select id from job_offers limit 1),
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'AWAITING_PAYMENT', 8500, 300, 42500, 15000
);
-- La asignación se insertó a mano; en la aplicación la crea accept_job_offer,
-- que deja el trabajo en OFFER_ACCEPTED. Desde la migración …000400 un pago
-- solo habilita un trabajo que de verdad esté esperando pago, así que el
-- montaje tiene que dejar el mismo estado que dejaría el camino real.
update jobs set status = 'OFFER_ACCEPTED' where id = '99999999-9999-9999-9999-999999999999';

insert into payments (job_id, assignment_id, client_id, amount, provider, status)
values ('99999999-9999-9999-9999-999999999999','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '11111111-1111-1111-1111-111111111111', 57500, 'transbank_webpay_plus', 'PENDING');

update payments set status = 'PAID', paid_at = now();

select 'T14 eventos de pago registrados = ' || count(*) from payment_events;

-- El trabajador recorre el estado hasta el punto en que se entrega el trabajo.
-- Antes esta prueba llamaba a `verify_handoff_code` con la asignación todavía en
-- CONFIRMED, es decir sin que el trabajador hubiera llegado siquiera al lugar.
-- Pasaba porque nada lo impedía: `verify_handoff_code` no mira el estado de
-- partida. Desde la migración …000100 lo impide el disparador de transiciones,
-- así que aquí se recorre el camino real.
-- Desde el Bloque 3 el avance pasa por funciones del servidor: el privilegio de
-- escribir `assignments.status` ya no existe para nadie con sesión.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select mark_on_the_way('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') ->> 'assignment_status' as paso1 \gset
select register_check_in('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true, -33.4173, -70.6065, 12, 'device') ->> 'result' as paso2 \gset
select start_job_work('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') ->> 'assignment_status' as paso3 \gset
reset request.jwt.claim.sub;

select 'T14a recorrido del trabajador = ' || :'paso1' || ' → ' || :'paso2' || ' → ' || :'paso3'
  || case when :'paso1' = 'ON_THE_WAY' and :'paso2' = 'VERIFIED' and :'paso3' = 'IN_PROGRESS'
          then '' else ' FALLO' end;

-- Y el estado no se escribe a mano: ni para retroceder ni para nada.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
begin
  update assignments set status = 'CONFIRMED' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  raise notice 'T14b FALLO: se pudo escribir el estado de la asignación a mano';
exception
  when insufficient_privilege then raise notice 'T14b OK: sin privilegio para escribir el estado a mano';
  when check_violation then raise notice 'T14b OK: la asignación no retrocede de estado';
end $$;
reset role; reset request.jwt.claim.sub;

-- El cliente genera el PIN.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 'T15 PIN generado con largo = ' || length(generate_handoff_code('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
reset role; reset request.jwt.claim.sub;

-- El trabajador NO puede leer el PIN.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select 'T16 PIN legible por el trabajador = ' || count(*) from handoff_codes;

-- Pero sí puede validarlo por RPC.
reset role; reset request.jwt.claim.sub;
\gset
select code as pin from handoff_codes \gset
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select 'T17 validacion de PIN correcto = ' || verify_handoff_code('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', :'pin');
reset role; reset request.jwt.claim.sub;

select 'T18 estado del trabajo tras la entrega = ' || status
  from jobs where id = '99999999-9999-9999-9999-999999999999';
select 'T19 evidencia de entrega registrada = ' || count(*)
  from job_evidence where evidence_type = 'HANDOFF';

-- ---------------------------------------------------------------------------
-- Reseñas, disputas, FilaPuntos y auditoría.
-- ---------------------------------------------------------------------------
-- El cliente aprueba, y con eso se libera el pago al trabajador.
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select approve_job_completion('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true) ->> 'payout_status' as po \gset
select submit_review('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 5, 5, 5, 5,
                     'Impecable, llego antes de la hora.') as review_id \gset
reset request.jwt.claim.sub;

select 'T19b pago liberado al aprobar el cliente = ' || :'po'
  || case when :'po' = 'APPROVED' then '' else ' FALLO' end;

select 'T20 calificacion promedio recalculada = ' || average_rating
  from worker_profiles where user_id = '22222222-2222-2222-2222-222222222222';

-- Un usuario que no participó no puede reseñar.
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
begin
  insert into reviews (assignment_id, author_id, subject_id, punctuality, communication, compliance, overall)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','33333333-3333-3333-3333-333333333333',
          '22222222-2222-2222-2222-222222222222',1,1,1,1);
  raise notice 'T21 FALLO: un extrano pudo resenar';
exception when others then
  raise notice 'T21 OK: resena de un no participante bloqueada';
end $$;
reset role; reset request.jwt.claim.sub;

-- El payout lo crea automaticamente el pago confirmado (Etapa 2).
select 'T21b payout creado automaticamente al pagar = ' || count(*) from payouts;

-- Una disputa se abre por función desde el Bloque 3: la escritura directa ya no
-- existe, y así el importe, el estado y la resolución no los pone quien reclama.
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select open_dispute('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                    'No cumplio el objetivo',
                    'El trabajador no alcanzo la posicion acordada en la fila.') as dispute_id \gset
reset request.jwt.claim.sub;

select 'T22 estado del payout tras la disputa = ' || status from payouts;
select 'T23 estado del trabajo tras la disputa = ' || status
  from jobs where id = '99999999-9999-9999-9999-999999999999';

-- FilaPuntos
select 'T24 saldo tras acreditar puntos = ' || (
  select balance_after from app_private.apply_loyalty_transaction(
    '11111111-1111-1111-1111-111111111111','EARNED_JOB', 575, 'Trabajo completado')
);

do $$
begin
  perform app_private.apply_loyalty_transaction(
    '11111111-1111-1111-1111-111111111111','REDEEMED_COMMISSION_DISCOUNT', -10000, 'Canje excesivo');
  raise notice 'T25 FALLO: se permitio canjear mas puntos de los que hay';
exception when others then
  raise notice 'T25 OK: canje sin saldo suficiente bloqueado';
end $$;

-- Auditoría
select 'T26 acciones auditadas = ' || count(*) from audit_logs;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select 'T27 auditoria visible para un no admin = ' || count(*) from audit_logs;
reset role; reset request.jwt.claim.sub;

-- KPIs del panel
select 'T28 KPIs: gmv=' || gmv || ' publicados=' || jobs_published || ' disputas=' || open_disputes
  from admin_kpis;

-- Vistas de compatibilidad
select 'T29 vista job_updates accesible = ' || count(*) from job_updates;
select 'T30 vista public_reviews accesible = ' || count(*) from public_reviews;
