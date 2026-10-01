-- =============================================================================
-- HagoTuFila · Las instrucciones de un trabajo no son públicas
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado sobre la base: `jobs` tenía
-- SELECT de tabla completa para `anon` y `authenticated`, y la política
-- `jobs_read` deja leer cualquier trabajo publicado. La columna `instructions`
-- —el formulario de publicación sugiere usarla para «accesos»: dónde queda la
-- llave, el código del portón, a nombre de quién está el retiro— se leía sin
-- sesión, salía en la página pública del trabajo y esa página está en el
-- sitemap. Mientras tanto, al publicar, a la persona se le decía que el
-- trabajo solo lo veían los trabajadores verificados.
--
-- RLS decide filas, no columnas: con la fila pública, la única forma de
-- esconder una columna es el privilegio. Se retira el SELECT de tabla y se
-- concede columna por columna todo lo demás, igual que con `payments` en
-- …000700. (Revocar solo `instructions` no tendría efecto: un privilegio de
-- tabla cubre todas las columnas.)
--
-- Las instrucciones se leen con `get_job_instructions`, que las entrega al
-- cliente del trabajo, al trabajador asignado —desde que se acepta su oferta y
-- mientras la asignación siga viva, la misma regla que la dirección exacta— y
-- a la administración. A cualquier otro le devuelve NULL, igual que si no
-- hubiera instrucciones: la respuesta no confirma ni desmiente que existan.
--
-- Consecuencia que hay que recordar: una columna que se agregue a `jobs` más
-- adelante NO queda legible con la clave pública ni con sesión hasta que se
-- conceda a mano. Es lo buscado —cerrado por defecto—, pero se nota.
-- =============================================================================

do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'jobs'
     and column_name <> 'instructions';

  revoke select on public.jobs from anon, authenticated;
  execute format('grant select (%s) on public.jobs to anon, authenticated', v_cols);
end $$;

comment on column public.jobs.instructions is
  'Instrucciones operativas. Sin privilegio de lectura para anon ni authenticated: se leen con get_job_instructions.';


create or replace function public.get_job_instructions(p_job_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_client uuid;
  v_instructions text;
begin
  if v_uid is null then
    raise exception 'Necesitas iniciar sesión' using errcode = 'insufficient_privilege';
  end if;

  select j.client_id, j.instructions
    into v_client, v_instructions
    from public.jobs j
   where j.id = p_job_id;

  if v_client = v_uid
     or app_private.is_admin(v_uid)
     or exists (
       select 1 from public.assignments a
        where a.job_id = p_job_id
          and a.worker_id = v_uid
          -- Una cancelación retira el acceso, igual que a la dirección exacta.
          and a.status not in ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER')
     ) then
    return v_instructions;
  end if;

  return null;
end;
$$;

comment on function public.get_job_instructions(uuid) is
  'Instrucciones del trabajo para el cliente, el trabajador asignado y la administración. A cualquier otro, NULL.';

revoke execute on function public.get_job_instructions(uuid) from public, anon;
grant execute on function public.get_job_instructions(uuid) to authenticated, service_role;
