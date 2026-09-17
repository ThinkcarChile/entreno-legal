-- =============================================================================
-- HagoTuFila · Etapa 2 · 000 · Privacidad de la ubicación del trabajo
-- =============================================================================
-- Problema: `jobs` es de lectura pública mientras está publicado, y contenía la
-- dirección exacta. Cualquiera podía saber a qué domicilio irá una persona sola
-- de madrugada.
--
-- RLS es a nivel de fila, no de columna, así que no se puede "ocultar la
-- dirección a unos y mostrarla a otros" dentro de la misma tabla. Se aplica el
-- mismo patrón ya probado con los datos personales (ver ARQUITECTURA §3.3):
-- separar en otra tabla.
--
-- Decisión de producto, documentada:
--   * ANTES de la asignación: comuna, región, nombre del lugar y un punto
--     aproximado (redondeado a ~1 km). Suficiente para decidir si postular.
--   * DESPUÉS de la asignación: dirección exacta, referencias de acceso y
--     coordenadas precisas, solo para el cliente, el trabajador asignado y la
--     administración.
-- =============================================================================

create table public.job_private_location (
  job_id        uuid primary key references public.jobs (id) on delete cascade,
  address_line  text not null,
  address_notes text,
  lat           numeric(10,7) check (lat between -90 and 90),
  lng           numeric(10,7) check (lng between -180 and 180),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger job_private_location_touch
  before update on public.job_private_location
  for each row execute function app_private.touch_updated_at();

comment on table public.job_private_location is
  'Dirección exacta. Visible solo para el cliente, el trabajador asignado y administración.';

-- Traslada lo que exista y descarta las columnas sensibles de `jobs`.
insert into public.job_private_location (job_id, address_line, address_notes, lat, lng)
select id, address_line, address_notes, lat, lng from public.jobs
on conflict (job_id) do nothing;

alter table public.jobs
  add column approx_lat numeric(8,5) check (approx_lat between -90 and 90),
  add column approx_lng numeric(8,5) check (approx_lng between -180 and 180);

-- Redondeo a dos decimales: del orden de un kilómetro. Ubica el sector sin
-- ubicar la puerta.
update public.jobs
   set approx_lat = round(lat, 2),
       approx_lng = round(lng, 2)
 where lat is not null;

alter table public.jobs
  drop column address_line,
  drop column address_notes,
  drop column lat,
  drop column lng;

alter table public.job_private_location enable row level security;

create policy job_private_location_read on public.job_private_location
  for select using (
    exists (
      select 1 from public.jobs j
       where j.id = job_private_location.job_id and j.client_id = auth.uid()
    )
    or exists (
      select 1 from public.assignments a
       where a.job_id = job_private_location.job_id
         and a.worker_id = auth.uid()
         -- Solo cuando la asignación sigue viva: una cancelación retira el acceso.
         and a.status not in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER')
    )
    or app_private.is_admin()
  );

create policy job_private_location_write on public.job_private_location
  for all using (
    exists (
      select 1 from public.jobs j
       where j.id = job_private_location.job_id and j.client_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.jobs j
       where j.id = job_private_location.job_id and j.client_id = auth.uid()
    )
  );

create policy job_private_location_admin on public.job_private_location
  for all using (app_private.is_admin()) with check (app_private.is_admin());

grant select on public.job_private_location to anon, authenticated;
grant insert, update, delete on public.job_private_location to authenticated;
grant all on public.job_private_location to service_role;

-- Mantiene el punto aproximado sincronizado con el exacto sin que la aplicación
-- tenga que acordarse de calcularlo.
create or replace function app_private.sync_job_approx_location()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.jobs
     set approx_lat = round(new.lat, 2),
         approx_lng = round(new.lng, 2)
   where id = new.job_id;
  return new;
end;
$$;

create trigger job_private_location_sync_approx
  after insert or update of lat, lng on public.job_private_location
  for each row execute function app_private.sync_job_approx_location();
