-- =============================================================================
-- HagoTuFila · Semilla de demostración · Contenido
-- =============================================================================
-- SOLO PARA DESARROLLO. Requiere 002_demo_accounts.sql aplicado antes.
--
-- Trabajos repartidos por Chile (Santiago, Valparaíso, Viña del Mar, Concepción,
-- La Serena, Antofagasta, Temuco y Puerto Montt), con ofertas, un trabajo
-- asignado y pagado, conversación con mensajes y reseñas.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Perfiles: comuna, biografía y modos de cuenta.
-- ---------------------------------------------------------------------------
update public.profiles p set
  region_code = v.region_code,
  commune_code = v.commune_code,
  city = (select name from public.communes where code = v.commune_code),
  bio = v.bio,
  roles = v.roles,
  onboarding_completed_at = now() - (v.age_days || ' days')::interval,
  created_at = now() - (v.age_days || ' days')::interval
from (values
  ('d0000000-0000-4000-8000-000000000001'::uuid, '13', '13-providencia', null, array['CLIENT']::public.app_role[], 420),
  ('d0000000-0000-4000-8000-000000000002'::uuid, '02', '02-antofagasta', null, array['CLIENT']::public.app_role[], 260),
  ('d0000000-0000-4000-8000-000000000003'::uuid, '09', '09-temuco', null, array['CLIENT']::public.app_role[], 95),
  ('d0000000-0000-4000-8000-000000000004'::uuid, '04', '04-la-serena', null, array['CLIENT','WORKER']::public.app_role[], 180),
  ('d0000000-0000-4000-8000-000000000011'::uuid, '13', '13-santiago',
   'Hago filas de conciertos y lanzamientos desde 2024. Llego antes de la hora y mando fotos cada hora.',
   array['WORKER']::public.app_role[], 640),
  ('d0000000-0000-4000-8000-000000000012'::uuid, '05', '05-valparaiso',
   'Región de Valparaíso. Filas de eventos y retiro de pedidos. Coordino relevos si el trabajo es largo.',
   array['WORKER']::public.app_role[], 150),
  ('d0000000-0000-4000-8000-000000000013'::uuid, '08', '08-concepcion',
   'Gestiones presenciales en el Gran Concepción. Trabajo con checklist y comprobante de cada paso.',
   array['WORKER']::public.app_role[], 75),
  ('d0000000-0000-4000-8000-000000000014'::uuid, '10', '10-puerto-montt',
   'Filas overnight y trámites en Puerto Montt. Llevo equipo propio para turnos largos.',
   array['WORKER']::public.app_role[], 500),
  ('d0000000-0000-4000-8000-000000000015'::uuid, '05', '05-vina-del-mar',
   'Nueva en HagoTuFila. Verificación en revisión.', array['WORKER']::public.app_role[], 20),
  ('d0000000-0000-4000-8000-000000000016'::uuid, '13', '13-nunoa',
   'Recién creé mi cuenta.', array['WORKER']::public.app_role[], 3),
  ('d0000000-0000-4000-8000-0000000000ad'::uuid, '13', '13-santiago', null, array['CLIENT']::public.app_role[], 700)
) as v(id, region_code, commune_code, bio, roles, age_days)
where p.id = v.id;

update public.user_private_data d set
  phone = v.phone, phone_verified = true
from (values
  ('d0000000-0000-4000-8000-000000000001'::uuid, '+56911111101'),
  ('d0000000-0000-4000-8000-000000000002'::uuid, '+56911111102'),
  ('d0000000-0000-4000-8000-000000000003'::uuid, '+56911111103'),
  ('d0000000-0000-4000-8000-000000000004'::uuid, '+56911111104'),
  ('d0000000-0000-4000-8000-000000000011'::uuid, '+56922222211'),
  ('d0000000-0000-4000-8000-000000000012'::uuid, '+56922222212'),
  ('d0000000-0000-4000-8000-000000000013'::uuid, '+56922222213'),
  ('d0000000-0000-4000-8000-000000000014'::uuid, '+56922222214'),
  ('d0000000-0000-4000-8000-000000000015'::uuid, '+56922222215'),
  ('d0000000-0000-4000-8000-000000000016'::uuid, '+56922222216')
) as v(user_id, phone)
where d.user_id = v.user_id;

-- ---------------------------------------------------------------------------
-- Perfiles de trabajador con reputaciones distintas.
-- ---------------------------------------------------------------------------
insert into public.worker_profiles (user_id) values
  ('d0000000-0000-4000-8000-000000000004'),
  ('d0000000-0000-4000-8000-000000000011'),
  ('d0000000-0000-4000-8000-000000000012'),
  ('d0000000-0000-4000-8000-000000000013'),
  ('d0000000-0000-4000-8000-000000000014'),
  ('d0000000-0000-4000-8000-000000000015'),
  ('d0000000-0000-4000-8000-000000000016')
on conflict (user_id) do nothing;

update public.worker_profiles w set
  headline = v.headline,
  verification_status = v.status,
  level = v.level,
  trust_index = v.trust_index,
  base_hourly_rate = v.rate,
  availability_note = v.availability,
  accepts_overnight = v.overnight,
  is_accepting_jobs = (v.status = 'VERIFIED'),
  identity_verified = (v.status = 'VERIFIED'),
  phone_verified = true,
  bank_account_verified = v.bank,
  email_verified = true,
  average_rating = v.rating,
  review_count = v.reviews,
  completed_jobs = v.jobs,
  worked_minutes = v.minutes,
  punctuality_rate = v.punctuality,
  completion_rate = v.completion,
  communication_rate = v.communication,
  cancellation_count = v.cancellations
from (values
  ('d0000000-0000-4000-8000-000000000011'::uuid,
   'Filas de conciertos y lanzamientos en el centro de Santiago',
   'VERIFIED'::public.verification_status, 'EXPERTO'::public.worker_level, 93, 10000,
   'Lunes a domingo, incluidas madrugadas.', true, true, 4.90, 118, 134, 41400, 0.98, 0.99, 0.97, 1),
  ('d0000000-0000-4000-8000-000000000012'::uuid,
   'Filas y encargos en Valparaíso y Viña del Mar',
   'VERIFIED'::public.verification_status, 'PRO'::public.worker_level, 78, 8500,
   'Tardes y fines de semana.', true, false, 4.70, 22, 25, 6300, 0.92, 0.94, 0.93, 1),
  ('d0000000-0000-4000-8000-000000000013'::uuid,
   'Gestiones presenciales en el Gran Concepción',
   'VERIFIED'::public.verification_status, 'VERIFICADO'::public.worker_level, 66, 9000,
   'Mañanas de lunes a viernes.', false, true, 4.60, 7, 8, 1920, 0.88, 0.90, 0.90, 1),
  ('d0000000-0000-4000-8000-000000000014'::uuid,
   'Filas overnight y de larga duración en Los Lagos',
   'VERIFIED'::public.verification_status, 'EXPERTO'::public.worker_level, 91, 14000,
   'Turnos nocturnos y fines de semana.', true, true, 4.90, 64, 71, 34200, 0.97, 0.98, 0.96, 1),
  ('d0000000-0000-4000-8000-000000000004'::uuid,
   'Trámites y encargos en La Serena y Coquimbo',
   'VERIFIED'::public.verification_status, 'VERIFICADO'::public.worker_level, 62, 9500,
   'Tardes de lunes a sábado.', false, true, 4.50, 4, 5, 1200, 0.85, 0.88, 0.88, 0),
  ('d0000000-0000-4000-8000-000000000015'::uuid,
   'Disponible para filas y encargos en Viña del Mar',
   'PENDING'::public.verification_status, 'NUEVO'::public.worker_level, 22, 9500,
   'Disponible todo el día.', true, false, 0, 0, 0, 0, 0, 0, 0, 0),
  ('d0000000-0000-4000-8000-000000000016'::uuid,
   'Trámites y gestiones presenciales permitidas',
   'UNVERIFIED'::public.verification_status, 'NUEVO'::public.worker_level, 8, 12500,
   'Lunes a viernes de 08:00 a 18:00.', false, false, 0, 0, 0, 0, 0, 0, 0, 0)
) as v(user_id, headline, status, level, trust_index, rate, availability, overnight, bank,
       rating, reviews, jobs, minutes, punctuality, completion, communication, cancellations)
where w.user_id = v.user_id;

-- Una solicitud de verificación pendiente, para poder probar el panel.
insert into public.worker_verifications (user_id, status, provider, document_type)
values ('d0000000-0000-4000-8000-000000000015', 'PENDING', 'manual', 'CEDULA')
on conflict do nothing;

-- Zonas de trabajo.
insert into public.worker_service_areas (worker_id, region_code, commune_code, radius_km) values
  ('d0000000-0000-4000-8000-000000000011', '13', '13-santiago', 12),
  ('d0000000-0000-4000-8000-000000000011', '13', '13-providencia', 10),
  ('d0000000-0000-4000-8000-000000000011', '13', '13-las-condes', 12),
  ('d0000000-0000-4000-8000-000000000012', '05', '05-valparaiso', 15),
  ('d0000000-0000-4000-8000-000000000012', '05', '05-vina-del-mar', 15),
  ('d0000000-0000-4000-8000-000000000013', '08', '08-concepcion', 20),
  ('d0000000-0000-4000-8000-000000000014', '10', '10-puerto-montt', 25),
  ('d0000000-0000-4000-8000-000000000004', '04', '04-la-serena', 15),
  ('d0000000-0000-4000-8000-000000000004', '04', '04-coquimbo', 15),
  ('d0000000-0000-4000-8000-000000000015', '05', '05-vina-del-mar', 12),
  ('d0000000-0000-4000-8000-000000000016', '13', null, 25)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Trabajos publicados en distintas regiones.
-- ---------------------------------------------------------------------------
insert into public.jobs (
  id, reference, client_id, category_id, status, title, description, instructions,
  region_code, commune_code, place_name, timezone, starts_at, estimated_duration_minutes,
  urgency, objective_type, objective_target_position, objective_description,
  bonus_amount, bonus_conditions, hourly_rate, suggested_hourly_min, suggested_hourly_max,
  published_at, expires_at
) values
  ('e0000000-0000-4000-8000-000000000001', 'HTF-DEM001',
   'd0000000-0000-4000-8000-000000000001',
   (select id from public.job_categories where slug = 'filas-conciertos-eventos'),
   'PUBLISHED',
   'Fila para entradas de concierto en Costanera Center',
   'Necesito a alguien que haga la fila el sábado desde las 05:00 hasta aproximadamente las 10:00 en la boletería. La venta abre a las 10:00 y yo llego 09:30 para tomar el lugar.',
   'Acceso por Av. Andrés Bello. Avísame apenas llegues y mándame una foto de cuánta gente hay delante.',
   '13', '13-providencia', 'Costanera Center', 'America/Santiago',
   now() + interval '3 days', 300, 'NORMAL', 'WITHIN_FIRST_N', 10, null,
   15000, 'Si al momento de la entrega quedaste entre los primeros 10.',
   10000, 10500, 13000, now() - interval '6 hours', now() + interval '3 days'),

  ('e0000000-0000-4000-8000-000000000002', 'HTF-DEM002',
   'd0000000-0000-4000-8000-000000000002',
   (select id from public.job_categories where slug = 'espera-tecnico-atencion'),
   'PUBLISHED',
   'Esperar al técnico de internet en un departamento de Antofagasta',
   'La visita está agendada entre las 09:00 y las 13:00 y no puedo faltar al trabajo. Necesito que alguien espere, reciba al técnico y me mantenga informado por el chat.',
   'Dejo la llave con el conserje. No hay que firmar nada a mi nombre: si piden firma del titular, me llaman.',
   '02', '02-antofagasta', null, 'America/Santiago',
   now() + interval '4 days', 240, 'FLEXIBLE', 'COMPLETE_ERRAND', null,
   'Recibir al técnico y acompañar la visita.', null, null,
   9500, 9500, 12500, now() - interval '30 hours', now() + interval '4 days'),

  ('e0000000-0000-4000-8000-000000000003', 'HTF-DEM003',
   'd0000000-0000-4000-8000-000000000003',
   (select id from public.job_categories where slug = 'filas-instituciones'),
   'PUBLISHED',
   'Tomar número y esperar turno en oficina de Temuco',
   'Necesito que alguien tome número y espere el turno. Cuando falten pocos turnos me avisa y yo llego, porque el trámite requiere mi presencia como titular.',
   'Importante: el trámite lo hago yo. Solo necesito que alguien espere el turno y me avise con anticipación.',
   '09', '09-temuco', null, 'America/Santiago',
   now() + interval '2 days', 180, 'NORMAL', 'HOLD_PLACE', null, null, null, null,
   9000, 9000, 11500, now() - interval '11 hours', now() + interval '2 days'),

  ('e0000000-0000-4000-8000-000000000004', 'HTF-DEM004',
   'd0000000-0000-4000-8000-000000000004',
   (select id from public.job_categories where slug = 'retiro-pedidos'),
   'PUBLISHED',
   'Retirar un pedido en tienda del centro de La Serena',
   'Tengo un pedido listo para retiro y no alcanzo a llegar antes del cierre. Es una caja mediana de unos 6 kilos. Necesito que lo retiren y lo dejen en mi edificio.',
   'El retiro está a mi nombre y la tienda permite retiro por terceros con el código de la orden.',
   '04', '04-la-serena', null, 'America/Santiago',
   now() + interval '1 day', 90, 'URGENTE', 'COMPLETE_ERRAND', null,
   'Retirar el pedido y entregarlo en conserjería.', null, null,
   12000, 11500, 15000, now() - interval '2 hours', now() + interval '1 day'),

  ('e0000000-0000-4000-8000-000000000005', 'HTF-DEM005',
   'd0000000-0000-4000-8000-000000000001',
   (select id from public.job_categories where slug = 'filas-madrugada-overnight'),
   'PUBLISHED',
   'Fila overnight por lanzamiento de consola en Puerto Montt',
   'Lanzamiento con stock limitado. Necesito que alguien tome el lugar desde las 22:00 del viernes hasta las 10:00 del sábado. Son 12 horas continuas: busco a alguien con experiencia en filas nocturnas.',
   'Llevar silla plegable y abrigo. Mantener el lugar sin abandonarlo.',
   '10', '10-puerto-montt', 'Mall Paseo Costanera', 'America/Santiago',
   now() + interval '5 days', 720, 'NORMAL', 'AS_FRONT_AS_POSSIBLE', null, null,
   25000, 'Si quedas entre los primeros 20 al momento de la apertura.',
   14000, 14000, 17500, now() - interval '20 hours', now() + interval '5 days'),

  ('e0000000-0000-4000-8000-000000000006', 'HTF-DEM006',
   'd0000000-0000-4000-8000-000000000003',
   (select id from public.job_categories where slug = 'filas-restaurantes'),
   'PUBLISHED',
   'Fila de restaurante sin reserva en Barrio Italia',
   'El local no toma reservas y la fila empieza temprano. Necesito que alguien tome lugar desde las 12:00 y me avise cuando falten cerca de 15 minutos para entrar. Somos cuatro personas.',
   null,
   '13', '13-providencia', null, 'America/Santiago',
   now() + interval '6 days', 120, 'FLEXIBLE', 'HOLD_PLACE', null, null, null, null,
   8500, 8500, 10500, now() - interval '48 hours', now() + interval '6 days'),

  -- Trabajo ya asignado y pagado, para ver la pantalla del trabajo en curso.
  ('e0000000-0000-4000-8000-000000000007', 'HTF-DEM007',
   'd0000000-0000-4000-8000-000000000002',
   (select id from public.job_categories where slug = 'retiro-entrega-documentos'),
   'PAID',
   'Entregar documentos en una oficina de Concepción',
   'Entrega de una carpeta con documentos en recepción. Requiere comprobante de recepción timbrado y una foto del comprobante.',
   'La carpeta la dejo en conserjería a tu nombre. Necesito el comprobante timbrado el mismo día.',
   '08', '08-concepcion', null, 'America/Santiago',
   now() + interval '1 day', 120, 'NORMAL', 'COMPLETE_ERRAND', null,
   'Entregar la carpeta y traer el comprobante timbrado.', null, null,
   12000, 11000, 14000, now() - interval '72 hours', now() + interval '1 day')
  ,
  ('e0000000-0000-4000-8000-000000000008', 'HTF-DEM008',
   'd0000000-0000-4000-8000-000000000001',
   (select id from public.job_categories where slug = 'filas-lanzamientos-tiendas'),
   'COMPLETED',
   'Fila por lanzamiento de zapatillas en Parque Arauco',
   'Lanzamiento con stock limitado. Necesitaba que alguien tomara lugar desde temprano y me avisara cómo avanzaba la fila.',
   null,
   '13', '13-las-condes', 'Parque Arauco', 'America/Santiago',
   now() - interval '9 days', 300, 'NORMAL', 'AS_FRONT_AS_POSSIBLE', null, null,
   null, null, 10000, 10000, 12500, now() - interval '14 days', now() - interval '9 days')
on conflict (id) do nothing;

insert into public.job_private_location (job_id, address_line, address_notes, lat, lng) values
  ('e0000000-0000-4000-8000-000000000001', 'Av. Andrés Bello 2447, Providencia',
   'La fila se forma frente a la entrada norte.', -33.4173, -70.6065),
  ('e0000000-0000-4000-8000-000000000002', 'Av. Grecia 1250, depto 704, Antofagasta',
   'La llave queda con el conserje.', -23.6509, -70.3975),
  ('e0000000-0000-4000-8000-000000000003', 'Manuel Bulnes 590, Temuco', null, -38.7359, -72.5904),
  ('e0000000-0000-4000-8000-000000000004', 'Balmaceda 470, La Serena',
   'Conserjería recibe hasta las 22:00.', -29.9027, -71.2519),
  ('e0000000-0000-4000-8000-000000000005', 'Av. Costanera 1200, Puerto Montt', null, -41.4693, -72.9424),
  ('e0000000-0000-4000-8000-000000000006', 'Av. Italia 1456, Providencia', null, -33.4405, -70.6244),
  ('e0000000-0000-4000-8000-000000000007', 'O''Higgins 420, oficina 302, Concepción',
   'Recepción en el tercer piso.', -36.8269, -73.0498),
  ('e0000000-0000-4000-8000-000000000008', 'Av. Presidente Kennedy 5413, Las Condes',
   null, -33.4008, -70.5776)
on conflict (job_id) do nothing;

-- ---------------------------------------------------------------------------
-- Ofertas
-- ---------------------------------------------------------------------------
insert into public.job_offers (id, job_id, worker_id, status, hourly_rate, estimated_total,
                               message, estimated_arrival_at, created_at) values
  ('f0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000011', 'PENDING', 8500, 42500,
   'Hola Valentina. Vivo a diez minutos de Costanera y hago filas de conciertos todas las semanas. Llego 04:40 y te mando foto cada hora.',
   now() + interval '3 days' - interval '20 minutes', now() - interval '5 hours'),

  ('f0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000016', 'WITHDRAWN', 12500, 62500,
   'Tengo disponibilidad ese día.', now() + interval '3 days', now() - interval '4 hours'),

  ('f0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003',
   'd0000000-0000-4000-8000-000000000013', 'PENDING', 9000, 27000,
   'Puedo llegar antes de que abran para tomar número temprano. Te aviso apenas queden cinco turnos.',
   now() + interval '2 days' - interval '30 minutes', now() - interval '9 hours'),

  ('f0000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000004',
   'd0000000-0000-4000-8000-000000000004', 'PENDING', 11000, 16500,
   'Estoy en La Serena y puedo pasar hoy antes del cierre. Te envío foto al retirar y al entregar.',
   now() + interval '1 day' - interval '15 minutes', now() - interval '1 hour'),

  ('f0000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000005',
   'd0000000-0000-4000-8000-000000000014', 'PENDING', 14000, 168000,
   'Hago filas overnight seguido. Llevo abrigo y batería externa, y te aviso el estado cada dos horas.',
   now() + interval '5 days' - interval '30 minutes', now() - interval '18 hours'),

  ('f0000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000006',
   'd0000000-0000-4000-8000-000000000011', 'PENDING', 9000, 18000,
   'Conozco el local, la fila se forma sobre Av. Italia. Te aviso cuando falten 15 minutos.',
   now() + interval '6 days' - interval '15 minutes', now() - interval '40 hours'),

  ('f0000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000007',
   'd0000000-0000-4000-8000-000000000013', 'ACCEPTED', 12000, 24000,
   'Puedo hacer la entrega y traer el comprobante timbrado el mismo día.',
   now() + interval '1 day' - interval '20 minutes', now() - interval '70 hours'),

  ('f0000000-0000-4000-8000-000000000008', 'e0000000-0000-4000-8000-000000000008',
   'd0000000-0000-4000-8000-000000000011', 'ACCEPTED', 10000, 50000,
   'Hago este tipo de filas seguido. Llego temprano y te mantengo al tanto.',
   now() - interval '9 days', now() - interval '13 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Trabajo asignado, pagado y con conversación.
-- ---------------------------------------------------------------------------
insert into public.assignments (
  id, job_id, offer_id, worker_id, client_id, status,
  agreed_hourly_rate, agreed_duration_minutes, agreed_total, bonus_amount, created_at
) values (
  'a0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000007',
  'f0000000-0000-4000-8000-000000000007',
  'd0000000-0000-4000-8000-000000000013',
  'd0000000-0000-4000-8000-000000000002',
  'CONFIRMED', 12000, 120, 24000, 0, now() - interval '68 hours'
) on conflict (id) do nothing;

insert into public.payments (
  id, job_id, assignment_id, client_id, purpose, status, amount, provider, paid_at, created_at
) values (
  'b0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000007',
  'a0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000002',
  'JOB', 'PAID', 24000, 'mock', now() - interval '67 hours', now() - interval '67 hours'
) on conflict (id) do nothing;

select app_private.create_payout_for_assignment('a0000000-0000-4000-8000-000000000001');

insert into public.conversations (id, job_id, assignment_id, client_id, worker_id, offer_id, is_primary)
values (
  'c0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000007',
  'a0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000013',
  'f0000000-0000-4000-8000-000000000007',
  true
) on conflict (id) do nothing;

insert into public.messages (conversation_id, sender_id, message_type, body, created_at) values
  ('c0000000-0000-4000-8000-000000000001', null, 'SYSTEM',
   'El cliente aceptó la oferta. Falta confirmar el pago para comenzar.', now() - interval '68 hours'),
  ('c0000000-0000-4000-8000-000000000001', null, 'SYSTEM',
   'El trabajo fue pagado. El pago queda protegido hasta que el servicio se complete.',
   now() - interval '67 hours'),
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'TEXT',
   'Hola Rodrigo. La carpeta queda en conserjería a tu nombre desde mañana a las 09:00.',
   now() - interval '60 hours'),
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000013', 'TEXT',
   'Perfecto. Paso a primera hora y te mando foto del comprobante apenas lo timbren.',
   now() - interval '59 hours');

-- Conversación abierta antes de asignar, para ver el caso "cliente pregunta a
-- un postulante".
insert into public.conversations (id, job_id, client_id, worker_id, offer_id)
values (
  'c0000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000011',
  'f0000000-0000-4000-8000-000000000001'
) on conflict (id) do nothing;

insert into public.messages (conversation_id, sender_id, message_type, body, created_at) values
  ('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'TEXT',
   '¿Podrías llegar antes de las 05:00? La fila del año pasado empezó a las 04:30.',
   now() - interval '4 hours'),
  ('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000011', 'TEXT',
   'Sí, sin problema. Llego 04:30 y te confirmo con una foto.', now() - interval '3 hours');

-- ---------------------------------------------------------------------------
-- Reseñas de trabajos anteriores.
-- ---------------------------------------------------------------------------
-- Trabajo ya terminado: da historial, reseña verificada y reputación real.
insert into public.assignments (
  id, job_id, offer_id, worker_id, client_id, status,
  agreed_hourly_rate, agreed_duration_minutes, agreed_total, bonus_amount,
  checked_in_at, started_at, completed_at, dispute_deadline_at, created_at
) values (
  'a0000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000008',
  'f0000000-0000-4000-8000-000000000008',
  'd0000000-0000-4000-8000-000000000011',
  'd0000000-0000-4000-8000-000000000001',
  'COMPLETED', 10000, 300, 50000, 0,
  now() - interval '9 days', now() - interval '9 days',
  now() - interval '9 days' + interval '5 hours',
  now() - interval '9 days' + interval '17 hours',
  now() - interval '13 days'
) on conflict (id) do nothing;

insert into public.payments (
  id, job_id, assignment_id, client_id, purpose, status, amount, provider, paid_at, created_at
) values (
  'b0000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000008',
  'a0000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000001',
  'JOB', 'PAID', 50000, 'mock', now() - interval '13 days', now() - interval '13 days'
) on conflict (id) do nothing;

select app_private.create_payout_for_assignment('a0000000-0000-4000-8000-000000000002');

insert into public.reviews (assignment_id, author_id, subject_id, punctuality, communication,
                            compliance, overall, comment, created_at)
values (
  'a0000000-0000-4000-8000-000000000002',
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000011',
  5, 5, 5, 5,
  'Llegó antes de la hora acordada y me fue avisando cómo avanzaba la fila con fotos. Quedé segunda. Impecable.',
  now() - interval '8 days'
) on conflict do nothing;

-- La reseña recalcula la reputación; se restituyen las cifras de demostración
-- para que los perfiles sigan mostrando un historial creíble.
update public.worker_profiles
   set average_rating = 4.90, review_count = 118
 where user_id = 'd0000000-0000-4000-8000-000000000011';
