-- =============================================================================
-- HagoTuFila · 800 · Row Level Security
-- =============================================================================
-- Principio: cambiar un identificador en la API nunca debe dar acceso a datos
-- privados de otra persona. La autorización vive aquí, no en el cliente ni en
-- el proxy: son la última línea y la única que no se puede saltar.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Funciones de apoyo usadas dentro de las políticas.
-- Las expresiones de una política se evalúan con el rol que consulta, así que
-- ese rol necesita permiso de ejecución.
-- -----------------------------------------------------------------------------
create or replace function app_private.is_job_participant(p_job_id uuid, uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.jobs j
     where j.id = p_job_id and j.client_id = uid
  ) or exists (
    select 1 from public.assignments a
     where a.job_id = p_job_id and a.worker_id = uid
  );
$$;

create or replace function app_private.is_assignment_participant(
  p_assignment_id uuid, uid uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.assignments a
     where a.id = p_assignment_id and (a.client_id = uid or a.worker_id = uid)
  );
$$;

create or replace function app_private.is_verified_worker(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.worker_profiles w
     where w.user_id = uid and w.verification_status = 'VERIFIED'
  );
$$;

grant usage on schema app_private to anon, authenticated;
grant execute on function app_private.is_admin(uuid) to anon, authenticated;
grant execute on function app_private.is_job_participant(uuid, uuid) to anon, authenticated;
grant execute on function app_private.is_assignment_participant(uuid, uuid) to anon, authenticated;
grant execute on function app_private.is_verified_worker(uuid) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Activar RLS en todo. Sin excepciones.
-- -----------------------------------------------------------------------------
alter table public.profiles                enable row level security;
alter table public.user_private_data       enable row level security;
alter table public.worker_profiles         enable row level security;
alter table public.worker_verifications    enable row level security;
alter table public.worker_payout_accounts  enable row level security;
alter table public.worker_service_areas    enable row level security;
alter table public.worker_categories       enable row level security;
alter table public.jobs                    enable row level security;
alter table public.job_images              enable row level security;
alter table public.job_offers              enable row level security;
alter table public.assignments             enable row level security;
alter table public.job_extensions          enable row level security;
alter table public.handoff_codes           enable row level security;
alter table public.payments                enable row level security;
alter table public.payment_events          enable row level security;
alter table public.payouts                 enable row level security;
alter table public.job_evidence            enable row level security;
alter table public.conversations           enable row level security;
alter table public.messages                enable row level security;
alter table public.reviews                 enable row level security;
alter table public.disputes                enable row level security;
alter table public.dispute_evidence        enable row level security;
alter table public.loyalty_accounts        enable row level security;
alter table public.loyalty_transactions    enable row level security;
alter table public.notifications           enable row level security;
alter table public.audit_logs              enable row level security;

-- -----------------------------------------------------------------------------
-- Perfiles públicos
-- -----------------------------------------------------------------------------
create policy profiles_read_public on public.profiles
  for select using (true);

create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy profiles_admin_all on public.profiles
  for all using (app_private.is_admin()) with check (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Datos privados del usuario: solo el titular y la administración.
-- -----------------------------------------------------------------------------
create policy user_private_data_own on public.user_private_data
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy user_private_data_admin on public.user_private_data
  for all using (app_private.is_admin()) with check (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Perfil de trabajador: lectura pública, escritura acotada.
-- -----------------------------------------------------------------------------
create policy worker_profiles_read on public.worker_profiles
  for select using (true);

create policy worker_profiles_insert_own on public.worker_profiles
  for insert with check (user_id = auth.uid());

create policy worker_profiles_update_own on public.worker_profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy worker_profiles_admin on public.worker_profiles
  for all using (app_private.is_admin()) with check (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Verificación y datos bancarios: nunca públicos.
-- -----------------------------------------------------------------------------
create policy worker_verifications_own on public.worker_verifications
  for select using (user_id = auth.uid());

create policy worker_verifications_insert_own on public.worker_verifications
  for insert with check (user_id = auth.uid());

create policy worker_verifications_admin on public.worker_verifications
  for all using (app_private.is_admin()) with check (app_private.is_admin());

create policy worker_payout_accounts_own on public.worker_payout_accounts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy worker_payout_accounts_admin on public.worker_payout_accounts
  for all using (app_private.is_admin()) with check (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Zonas y categorías del trabajador
-- -----------------------------------------------------------------------------
create policy worker_service_areas_read on public.worker_service_areas
  for select using (true);
create policy worker_service_areas_own on public.worker_service_areas
  for all using (worker_id = auth.uid()) with check (worker_id = auth.uid());

create policy worker_categories_read on public.worker_categories
  for select using (true);
create policy worker_categories_own on public.worker_categories
  for all using (worker_id = auth.uid()) with check (worker_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Trabajos
-- -----------------------------------------------------------------------------
create policy jobs_read on public.jobs
  for select using (
    status = 'PUBLISHED'
    or client_id = auth.uid()
    or exists (select 1 from public.assignments a
                where a.job_id = jobs.id and a.worker_id = auth.uid())
    or app_private.is_admin()
  );

create policy jobs_insert_own on public.jobs
  for insert with check (client_id = auth.uid());

create policy jobs_update_own on public.jobs
  for update using (client_id = auth.uid()) with check (client_id = auth.uid());

create policy jobs_admin on public.jobs
  for all using (app_private.is_admin()) with check (app_private.is_admin());

create policy job_images_read on public.job_images
  for select using (
    exists (select 1 from public.jobs j
             where j.id = job_images.job_id
               and (j.status = 'PUBLISHED' or j.client_id = auth.uid()))
    or app_private.is_admin()
  );

create policy job_images_write_own on public.job_images
  for all using (
    exists (select 1 from public.jobs j where j.id = job_images.job_id and j.client_id = auth.uid())
  ) with check (
    exists (select 1 from public.jobs j where j.id = job_images.job_id and j.client_id = auth.uid())
  );

-- -----------------------------------------------------------------------------
-- Ofertas: las ve el dueño del trabajo y quien la envió.
-- -----------------------------------------------------------------------------
create policy job_offers_read on public.job_offers
  for select using (
    worker_id = auth.uid()
    or exists (select 1 from public.jobs j
                where j.id = job_offers.job_id and j.client_id = auth.uid())
    or app_private.is_admin()
  );

-- Solo trabajadores verificados pueden ofertar, y nunca en su propio trabajo.
create policy job_offers_insert_verified on public.job_offers
  for insert with check (
    worker_id = auth.uid()
    and app_private.is_verified_worker()
    and exists (
      select 1 from public.jobs j
       where j.id = job_offers.job_id
         and j.status = 'PUBLISHED'
         and j.client_id <> auth.uid()
    )
  );

create policy job_offers_update_worker on public.job_offers
  for update using (worker_id = auth.uid()) with check (worker_id = auth.uid());

create policy job_offers_update_client on public.job_offers
  for update using (
    exists (select 1 from public.jobs j
             where j.id = job_offers.job_id and j.client_id = auth.uid())
  ) with check (
    exists (select 1 from public.jobs j
             where j.id = job_offers.job_id and j.client_id = auth.uid())
  );

create policy job_offers_admin on public.job_offers
  for all using (app_private.is_admin()) with check (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Asignaciones, extensiones y PIN de entrega
-- -----------------------------------------------------------------------------
create policy assignments_participants on public.assignments
  for select using (client_id = auth.uid() or worker_id = auth.uid() or app_private.is_admin());

create policy assignments_update_participants on public.assignments
  for update using (client_id = auth.uid() or worker_id = auth.uid())
  with check (client_id = auth.uid() or worker_id = auth.uid());

create policy assignments_admin on public.assignments
  for all using (app_private.is_admin()) with check (app_private.is_admin());

create policy job_extensions_participants on public.job_extensions
  for select using (
    app_private.is_assignment_participant(assignment_id) or app_private.is_admin()
  );

create policy job_extensions_insert on public.job_extensions
  for insert with check (
    requested_by = auth.uid() and app_private.is_assignment_participant(assignment_id)
  );

create policy job_extensions_update on public.job_extensions
  for update using (app_private.is_assignment_participant(assignment_id))
  with check (app_private.is_assignment_participant(assignment_id));

-- El PIN lo lee únicamente el cliente. El trabajador lo valida por RPC.
create policy handoff_codes_client_read on public.handoff_codes
  for select using (
    exists (select 1 from public.assignments a
             where a.id = handoff_codes.assignment_id and a.client_id = auth.uid())
    or app_private.is_admin()
  );

-- -----------------------------------------------------------------------------
-- Pagos
-- -----------------------------------------------------------------------------
create policy payments_read on public.payments
  for select using (
    client_id = auth.uid()
    or exists (select 1 from public.assignments a
                where a.id = payments.assignment_id and a.worker_id = auth.uid())
    or app_private.is_admin()
  );

create policy payments_admin on public.payments
  for all using (app_private.is_admin()) with check (app_private.is_admin());

-- payment_events es append-only: solo lectura para los involucrados.
create policy payment_events_read on public.payment_events
  for select using (
    exists (select 1 from public.payments p
             where p.id = payment_events.payment_id
               and (p.client_id = auth.uid() or app_private.is_admin()))
  );

create policy payouts_worker_read on public.payouts
  for select using (worker_id = auth.uid() or app_private.is_admin());

create policy payouts_admin on public.payouts
  for all using (app_private.is_admin()) with check (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Evidencia: la ven los participantes; se inserta y no se modifica.
-- -----------------------------------------------------------------------------
create policy job_evidence_read on public.job_evidence
  for select using (app_private.is_job_participant(job_id) or app_private.is_admin());

create policy job_evidence_insert on public.job_evidence
  for insert with check (
    author_id = auth.uid() and app_private.is_job_participant(job_id)
  );

-- Sin políticas de UPDATE ni DELETE: la evidencia no se reescribe ni se borra.

-- -----------------------------------------------------------------------------
-- Chat: solo cliente y trabajador asignado.
-- -----------------------------------------------------------------------------
create policy conversations_participants on public.conversations
  for select using (client_id = auth.uid() or worker_id = auth.uid() or app_private.is_admin());

create policy messages_read on public.messages
  for select using (
    exists (select 1 from public.conversations c
             where c.id = messages.conversation_id
               and (c.client_id = auth.uid() or c.worker_id = auth.uid()))
    or app_private.is_admin()
  );

create policy messages_insert on public.messages
  for insert with check (
    sender_id = auth.uid()
    and exists (select 1 from public.conversations c
                 where c.id = messages.conversation_id
                   and (c.client_id = auth.uid() or c.worker_id = auth.uid()))
  );

-- Marcar como leído es la única actualización permitida al destinatario.
create policy messages_mark_read on public.messages
  for update using (
    exists (select 1 from public.conversations c
             where c.id = messages.conversation_id
               and (c.client_id = auth.uid() or c.worker_id = auth.uid()))
      and sender_id is distinct from auth.uid()
  ) with check (true);

-- -----------------------------------------------------------------------------
-- Reseñas
-- -----------------------------------------------------------------------------
create policy reviews_read on public.reviews
  for select using (not is_hidden or author_id = auth.uid() or app_private.is_admin());

create policy reviews_insert_participant on public.reviews
  for insert with check (
    author_id = auth.uid() and app_private.is_assignment_participant(assignment_id)
  );

create policy reviews_admin on public.reviews
  for all using (app_private.is_admin()) with check (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Disputas
-- -----------------------------------------------------------------------------
create policy disputes_participants on public.disputes
  for select using (
    app_private.is_assignment_participant(assignment_id) or app_private.is_admin()
  );

create policy disputes_insert on public.disputes
  for insert with check (
    opened_by = auth.uid() and app_private.is_assignment_participant(assignment_id)
  );

create policy disputes_admin on public.disputes
  for all using (app_private.is_admin()) with check (app_private.is_admin());

create policy dispute_evidence_read on public.dispute_evidence
  for select using (
    exists (select 1 from public.disputes d
             where d.id = dispute_evidence.dispute_id
               and app_private.is_assignment_participant(d.assignment_id))
    or app_private.is_admin()
  );

create policy dispute_evidence_insert on public.dispute_evidence
  for insert with check (
    author_id = auth.uid()
    and exists (select 1 from public.disputes d
                 where d.id = dispute_evidence.dispute_id
                   and app_private.is_assignment_participant(d.assignment_id))
  );

-- -----------------------------------------------------------------------------
-- FilaPuntos: lectura propia. Las escrituras pasan por la función del servidor.
-- -----------------------------------------------------------------------------
create policy loyalty_accounts_own on public.loyalty_accounts
  for select using (user_id = auth.uid() or app_private.is_admin());

create policy loyalty_transactions_own on public.loyalty_transactions
  for select using (user_id = auth.uid() or app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Notificaciones
-- -----------------------------------------------------------------------------
create policy notifications_own_read on public.notifications
  for select using (user_id = auth.uid());

create policy notifications_own_update on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy notifications_admin on public.notifications
  for all using (app_private.is_admin()) with check (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Auditoría: solo lectura administrativa. Las escrituras las hacen triggers
-- SECURITY DEFINER, que no pasan por RLS.
-- -----------------------------------------------------------------------------
create policy audit_logs_admin_read on public.audit_logs
  for select using (app_private.is_admin());

-- -----------------------------------------------------------------------------
-- Privilegios de tabla y de columna.
--
-- RLS decide a qué FILAS se accede. Para restringir qué COLUMNAS puede escribir
-- un usuario final se usan privilegios de columna, que es el mecanismo nativo de
-- PostgreSQL para eso.
--
-- Se prefiere esto a un trigger que revierta columnas: un trigger también
-- revertiría las escrituras legítimas del propio sistema (por ejemplo, el
-- recálculo de reputación tras una reseña), que es justo lo que no se quiere.
--
-- Consecuencia de diseño, deliberada: las escrituras administrativas
-- (verificar identidad, suspender una cuenta, aprobar un payout) NO se hacen
-- desde el navegador. Van por código de servidor con la clave de servicio.
-- -----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on all tables in schema public to authenticated;

-- El rol de servicio opera del lado del servidor y no pasa por estas
-- restricciones de columna.
grant all on all tables in schema public to service_role;

-- Perfil público: el usuario solo edita su presentación.
revoke update on public.profiles from authenticated;
grant update (first_name, last_name_initial, avatar_url, bio, city, region_code)
  on public.profiles to authenticated;

-- Perfil de trabajador: nadie se autoverifica, se sube el nivel ni se edita su
-- propia reputación. `is_accepting_jobs` es editable, pero un CHECK impide
-- activarlo sin estar verificado.
revoke update on public.worker_profiles from authenticated;
grant update (headline, base_hourly_rate, availability_note, accepts_overnight, is_accepting_jobs)
  on public.worker_profiles to authenticated;

-- Las reseñas no se editan una vez publicadas; solo la administración puede
-- ocultarlas.
revoke update on public.reviews from authenticated;

alter default privileges in schema public
  grant select on tables to anon, authenticated;
alter default privileges in schema public
  grant insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
