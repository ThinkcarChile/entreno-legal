-- =============================================================================
-- HagoTuFila · 900 · Vistas, funciones de aplicación, almacenamiento y triggers
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Vista de reseñas públicas, ya unida al autor.
-- security_invoker = true: la vista NO elude las políticas del consultante.
-- -----------------------------------------------------------------------------
create view public.public_reviews
with (security_invoker = true)
as
  select r.id,
         r.assignment_id,
         r.author_id,
         r.subject_id,
         r.punctuality,
         r.communication,
         r.compliance,
         r.overall,
         r.comment,
         r.created_at,
         p.first_name        as author_first_name,
         p.last_name_initial as author_last_name_initial,
         p.avatar_url        as author_avatar_url
    from public.reviews r
    join public.profiles p on p.id = r.author_id
   where not r.is_hidden;

-- -----------------------------------------------------------------------------
-- KPIs del panel de administración.
-- Con security_invoker, quien no sea administrador simplemente no ve filas.
-- -----------------------------------------------------------------------------
create view public.admin_kpis
with (security_invoker = true)
as
  with window_bounds as (
    select now() - interval '30 days' as since
  ),
  paid as (
    select coalesce(sum(p.amount), 0)::bigint as gmv,
           count(*)::bigint as paid_count
      from public.payments p, window_bounds w
     where p.status = 'PAID' and p.paid_at >= w.since
  ),
  revenue as (
    select coalesce(sum(po.commission_amount - po.discount_amount), 0)::bigint as platform_revenue
      from public.payouts po, window_bounds w
     where po.created_at >= w.since
  ),
  jobs_agg as (
    select count(*) filter (where j.published_at >= w.since)::bigint as jobs_published,
           count(*) filter (where j.status in ('COMPLETED', 'CLOSED')
                              and j.updated_at >= w.since)::bigint as jobs_completed,
           count(*) filter (where j.status = 'CANCELLED'
                              and j.updated_at >= w.since)::bigint as cancellations
      from public.jobs j, window_bounds w
  ),
  users_agg as (
    select count(*) filter (where pr.created_at >= w.since)::bigint as new_users_30d
      from public.profiles pr, window_bounds w
  ),
  workers_agg as (
    select count(*)::bigint as active_workers
      from public.worker_profiles wp
     where wp.is_accepting_jobs
  ),
  disputes_agg as (
    select count(*) filter (where d.status in ('OPEN', 'UNDER_REVIEW'))::bigint as open_disputes
      from public.disputes d
  ),
  queues as (
    select (select count(*) from public.worker_verifications where status = 'PENDING')::bigint
             as pending_verifications,
           (select count(*) from public.payouts where status in ('PENDING', 'APPROVED'))::bigint
             as pending_payouts
  )
  select paid.gmv,
         revenue.platform_revenue,
         jobs_agg.jobs_published,
         jobs_agg.jobs_completed,
         case when paid.paid_count = 0 then 0
              else (paid.gmv / paid.paid_count)::bigint end as average_ticket,
         users_agg.new_users_30d,
         workers_agg.active_workers,
         jobs_agg.cancellations,
         disputes_agg.open_disputes,
         case when jobs_agg.jobs_published = 0 then 0
              else round(jobs_agg.jobs_completed::numeric
                         / jobs_agg.jobs_published, 3) end as success_rate,
         queues.pending_verifications,
         queues.pending_payouts
    from paid, revenue, jobs_agg, users_agg, workers_agg, disputes_agg, queues;

comment on view public.admin_kpis is
  'Indicadores de los últimos 30 días. Protegida por las políticas de las tablas base.';

-- -----------------------------------------------------------------------------
-- PIN de entrega
-- -----------------------------------------------------------------------------

-- El cliente genera (o recupera) el código al acercarse el término del servicio.
create or replace function public.generate_handoff_code(p_assignment_id uuid)
returns char(4)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid;
  v_code char(4);
begin
  select client_id into v_client from public.assignments where id = p_assignment_id;

  if v_client is null then
    raise exception 'La asignación no existe';
  end if;

  if v_client <> auth.uid() then
    raise exception 'Solo el cliente puede generar el código de entrega';
  end if;

  insert into public.handoff_codes (assignment_id, code, expires_at)
  values (
    p_assignment_id,
    lpad((floor(random() * 10000))::int::text, 4, '0'),
    now() + interval '12 hours'
  )
  on conflict (assignment_id) do update set code = public.handoff_codes.code
  returning code into v_code;

  return v_code;
end;
$$;

-- El trabajador envía el código: nunca puede leerlo desde la tabla.
create or replace function public.verify_handoff_code(p_assignment_id uuid, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
  c record;
begin
  select * into a from public.assignments where id = p_assignment_id;

  if a is null or a.worker_id <> auth.uid() then
    raise exception 'Solo el trabajador asignado puede validar el código';
  end if;

  select * into c from public.handoff_codes where assignment_id = p_assignment_id for update;

  if c is null then
    raise exception 'Todavía no existe un código de entrega para este trabajo';
  end if;

  if c.attempts >= 5 then
    raise exception 'Demasiados intentos. Contacta a soporte.';
  end if;

  if c.expires_at < now() then
    raise exception 'El código de entrega expiró';
  end if;

  if c.code <> p_code then
    update public.handoff_codes
       set attempts = attempts + 1
     where assignment_id = p_assignment_id;
    return false;
  end if;

  update public.handoff_codes
     set verified_at = now(), attempts = attempts + 1
   where assignment_id = p_assignment_id;

  update public.assignments
     set status = 'HANDOFF_COMPLETED', handoff_completed_at = now(), updated_at = now()
   where id = p_assignment_id;

  update public.jobs
     set status = 'HANDOFF_COMPLETED', updated_at = now()
   where id = a.job_id;

  -- La validación del PIN es evidencia de presencia simultánea.
  insert into public.job_evidence
    (job_id, assignment_id, author_id, author_name, evidence_type, title, body)
  values
    (a.job_id, p_assignment_id, auth.uid(), null, 'HANDOFF',
     'Entrega completada', 'Código de recepción validado por ambas partes');

  return true;
end;
$$;

grant execute on function public.generate_handoff_code(uuid) to authenticated;
grant execute on function public.verify_handoff_code(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Alta de usuario: perfil, datos privados y cuenta de FilaPuntos.
-- Se crea aquí porque depende de tablas de migraciones posteriores a la 200.
-- -----------------------------------------------------------------------------
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_private.handle_new_user();

-- -----------------------------------------------------------------------------
-- Almacenamiento
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values
  ('avatars', 'avatars', true),
  ('job-images', 'job-images', true),
  ('evidence', 'evidence', false),
  ('verification', 'verification', false),
  ('dispute-files', 'dispute-files', false)
on conflict (id) do nothing;

-- Las políticas de Storage se recrean: así la migración se puede repetir.
--
-- Nota para proyectos alojados: `storage.objects` pertenece a
-- `supabase_storage_admin`. Si el rol que aplica las migraciones no puede crear
-- políticas sobre esa tabla, el error aparecerá aquí y las políticas se crean
-- desde el panel (Storage → Policies) con estas mismas reglas.
drop policy if exists "avatars_public_read" on storage.objects;
drop policy if exists "avatars_own_write" on storage.objects;
drop policy if exists "avatars_own_update" on storage.objects;
drop policy if exists "job_images_public_read" on storage.objects;
drop policy if exists "job_images_own_write" on storage.objects;
drop policy if exists "verification_own_write" on storage.objects;
drop policy if exists "verification_own_read" on storage.objects;
drop policy if exists "evidence_own_write" on storage.objects;
drop policy if exists "evidence_read" on storage.objects;
drop policy if exists "dispute_files_own_write" on storage.objects;
drop policy if exists "dispute_files_read" on storage.objects;

-- Avatares: lectura pública, escritura en la carpeta propia del usuario.
create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "avatars_own_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_own_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Imágenes de trabajos: lectura pública, escritura del autor.
create policy "job_images_public_read" on storage.objects
  for select using (bucket_id = 'job-images');

create policy "job_images_own_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'job-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- Verificación de identidad: privada. Ni siquiera es legible por otros usuarios.
create policy "verification_own_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'verification' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "verification_own_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'verification'
    and ((storage.foldername(name))[1] = auth.uid()::text or app_private.is_admin())
  );

-- Evidencia y archivos de disputa: solo participantes y administración.
create policy "evidence_own_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "evidence_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'evidence'
    and ((storage.foldername(name))[1] = auth.uid()::text or app_private.is_admin())
  );

create policy "dispute_files_own_write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'dispute-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "dispute_files_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'dispute-files'
    and ((storage.foldername(name))[1] = auth.uid()::text or app_private.is_admin())
  );
