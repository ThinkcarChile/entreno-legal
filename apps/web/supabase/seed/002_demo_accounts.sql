-- =============================================================================
-- HagoTuFila · Semilla de demostración · Cuentas
-- =============================================================================
-- SOLO PARA DESARROLLO. No aplicar en producción.
--
-- Crea usuarios en auth.users con contraseña conocida para poder recorrer el
-- producto de punta a punta. El trigger `on_auth_user_created` genera el perfil
-- público, los datos privados y la cuenta de FilaPuntos.
--
-- Contraseña de todas las cuentas: hagotufila2026
--
-- Cuentas creadas:
--   cliente.santiago@demo.cl      cliente
--   cliente.antofagasta@demo.cl   cliente
--   cliente.temuco@demo.cl        cliente
--   cliente.laserena@demo.cl      cliente y trabajador
--   worker.santiago@demo.cl       trabajador verificado, reputación alta
--   worker.valparaiso@demo.cl     trabajador verificado, reputación media
--   worker.concepcion@demo.cl     trabajador verificado, recién llegado
--   worker.puertomontt@demo.cl    trabajador verificado
--   worker.vina@demo.cl           trabajador con verificación PENDIENTE
--   worker.nuevo@demo.cl          trabajador SIN verificar
--   admin@demo.cl                 administración
-- =============================================================================

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
values
  ('d0000000-0000-4000-8000-000000000001', 'cliente.santiago@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Valentina","last_name":"Rojas","intent":"CLIENT"}'),
  ('d0000000-0000-4000-8000-000000000002', 'cliente.antofagasta@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Ignacio","last_name":"Herrera","intent":"CLIENT"}'),
  ('d0000000-0000-4000-8000-000000000003', 'cliente.temuco@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Francisca","last_name":"Muñoz","intent":"CLIENT"}'),
  ('d0000000-0000-4000-8000-000000000004', 'cliente.laserena@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Matías","last_name":"Contreras","intent":"CLIENT"}'),
  ('d0000000-0000-4000-8000-000000000011', 'worker.santiago@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Camila","last_name":"Fernández","intent":"WORKER"}'),
  ('d0000000-0000-4000-8000-000000000012', 'worker.valparaiso@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Daniela","last_name":"Pizarro","intent":"WORKER"}'),
  ('d0000000-0000-4000-8000-000000000013', 'worker.concepcion@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Rodrigo","last_name":"Salazar","intent":"WORKER"}'),
  ('d0000000-0000-4000-8000-000000000014', 'worker.puertomontt@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Tomás","last_name":"Riquelme","intent":"WORKER"}'),
  ('d0000000-0000-4000-8000-000000000015', 'worker.vina@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Josefa","last_name":"Lagos","intent":"WORKER"}'),
  ('d0000000-0000-4000-8000-000000000016', 'worker.nuevo@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Sebastián","last_name":"Álvarez","intent":"WORKER"}'),
  ('d0000000-0000-4000-8000-0000000000ad', 'admin@demo.cl',
   extensions.crypt('hagotufila2026', extensions.gen_salt('bf')), now(),
   '{"first_name":"Soporte","last_name":"HagoTuFila","intent":"CLIENT"}')
on conflict (id) do nothing;

update public.profiles set role = 'ADMIN' where id = 'd0000000-0000-4000-8000-0000000000ad';
