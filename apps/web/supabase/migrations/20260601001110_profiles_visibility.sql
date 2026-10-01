-- =============================================================================
-- HagoTuFila · Los perfiles no se listan sin sesión
-- =============================================================================
-- Migración correctiva. No modifica migraciones anteriores.
--
-- DEFECTO, encontrado por la auditoría y comprobado sobre la base:
-- `profiles_read_public` es `using (true)` y `profiles` tenía SELECT de tabla
-- completa para `anon`. Sin iniciar sesión, cualquiera pedía por REST la lista
-- entera de perfiles —clientes incluidos, con comuna y biografía— y, filtrando
-- por `role = 'ADMIN'`, sabía quién administra la plataforma. Con sesión, lo
-- mismo. Y `worker_profiles`, sus zonas y sus categorías daban la lista
-- completa de quien activó el modo trabajador, verificado o no.
--
-- Qué queda, y por qué:
--
--   * Filas (RLS), con una sola regla para las cuatro tablas,
--     `app_private.can_see_profile`. Un perfil lo ve su dueño, la
--     administración, cualquiera si es de un trabajador VERIFICADO —es la
--     vitrina de /trabajadores, y lo que ve el cliente al comparar ofertas— y
--     la contraparte real: quien ofertó en tu trabajo, el cliente del trabajo
--     en que ofertaste, y las dos partes de una conversación o de una
--     asignación. Un cliente sin relación contigo no aparece.
--
--   * Columnas (privilegio). Ni `anon` ni `authenticated` leen `role`,
--     `roles`, `is_suspended`, `onboarding_completed_at`, `commune_code`,
--     `country_code` ni `updated_at`, tampoco de una fila visible. La sesión
--     lee lo suyo con `get_my_account`.
--
--   * Reseñas. `public_reviews` unía `profiles` con los privilegios de quien
--     consulta: con la fila del cliente oculta, su reseña habría desaparecido
--     del perfil del trabajador. El autor se resuelve ahora con
--     `app_private.review_author_card`, que entrega nombre, inicial y foto de
--     quien escribió una reseña publicada, y nada más. Es lo que ya mostraba
--     la tarjeta de la reseña; lo que deja de verse es todo lo demás.
--
-- Igual que en `jobs` (…001100): una columna nueva de `profiles` no queda
-- legible para nadie con la clave pública hasta que se conceda a mano.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Quién ve el perfil de quién
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER a propósito: la usan las políticas de `profiles` y de
-- `worker_profiles`, y consultar esas tablas con los privilegios de quien
-- pregunta dentro de su propia política sería recursivo.
create or replace function app_private.can_see_profile(
  p_profile_id uuid,
  uid uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    p_profile_id = uid
    or app_private.is_admin(uid)
    or exists (
      select 1 from public.worker_profiles w
       where w.user_id = p_profile_id and w.verification_status = 'VERIFIED'
    )
    or exists (
      select 1 from public.job_offers o
        join public.jobs j on j.id = o.job_id
       where (j.client_id = uid and o.worker_id = p_profile_id)
          or (o.worker_id = uid and j.client_id = p_profile_id)
    )
    or exists (
      select 1 from public.conversations c
       where (c.client_id = uid and c.worker_id = p_profile_id)
          or (c.worker_id = uid and c.client_id = p_profile_id)
    )
    or exists (
      select 1 from public.assignments a
       where (a.client_id = uid and a.worker_id = p_profile_id)
          or (a.worker_id = uid and a.client_id = p_profile_id)
    ),
    false);
$$;

comment on function app_private.can_see_profile(uuid, uuid) is
  'Dueño, administración, trabajador verificado (público) o contraparte real por oferta, conversación o asignación.';

grant execute on function app_private.can_see_profile(uuid, uuid) to anon, authenticated;

drop policy if exists profiles_read_public on public.profiles;
drop policy if exists profiles_read_visible on public.profiles;
create policy profiles_read_visible on public.profiles
  for select using (app_private.can_see_profile(id));

alter policy worker_profiles_read on public.worker_profiles
  using (app_private.can_see_profile(user_id));

alter policy worker_service_areas_read on public.worker_service_areas
  using (app_private.can_see_profile(worker_id));

alter policy worker_categories_read on public.worker_categories
  using (app_private.can_see_profile(worker_id));


-- -----------------------------------------------------------------------------
-- 2. Qué columnas se leen
-- -----------------------------------------------------------------------------
-- Lo que muestran las páginas: nombre, inicial, foto, biografía, comuna (como
-- texto en `city`), región y antigüedad. Nada de rol, modos ni suspensión.
revoke select on public.profiles from anon, authenticated;
grant select (id, first_name, last_name_initial, avatar_url, bio, city, region_code, created_at)
  on public.profiles to anon, authenticated;


-- -----------------------------------------------------------------------------
-- 3. Lo propio, completo
-- -----------------------------------------------------------------------------
-- La sesión necesita saber si quien entra es administración, qué modos tiene
-- activos y si terminó el onboarding. Son datos de la propia fila que ningún
-- otro usuario debe leer, y el privilegio de columna no distingue filas: por
-- eso van por aquí y solo para `auth.uid()`.
create or replace function public.get_my_account()
returns table (
  id uuid,
  first_name text,
  last_name_initial text,
  avatar_url text,
  bio text,
  city text,
  region_code text,
  created_at timestamptz,
  role public.app_role,
  roles public.app_role[],
  is_suspended boolean,
  onboarding_completed_at timestamptz,
  commune_code text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.first_name, p.last_name_initial::text, p.avatar_url, p.bio, p.city,
         p.region_code, p.created_at, p.role, p.roles, p.is_suspended,
         p.onboarding_completed_at, p.commune_code
    from public.profiles p
   where p.id = auth.uid();
$$;

comment on function public.get_my_account() is
  'El perfil de quien llama, con rol, modos y estado de la cuenta. Sin sesión, ninguna fila.';

revoke execute on function public.get_my_account() from public, anon;
grant execute on function public.get_my_account() to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 4. El autor de una reseña publicada
-- -----------------------------------------------------------------------------
-- Recibe la reseña, no la persona: solo responde por quien escribió una reseña
-- visible, y solo con lo que la tarjeta de la reseña muestra.
create or replace function app_private.review_author_card(p_review_id uuid)
returns table (first_name text, last_name_initial text, avatar_url text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.first_name, p.last_name_initial::text, p.avatar_url
    from public.reviews r
    join public.profiles p on p.id = r.author_id
   where r.id = p_review_id
     and not r.is_hidden;
$$;

grant execute on function app_private.review_author_card(uuid) to anon, authenticated;

create or replace view public.public_reviews
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
         a.first_name                 as author_first_name,
         a.last_name_initial::char(1) as author_last_name_initial,
         a.avatar_url                 as author_avatar_url
    from public.reviews r
    left join lateral app_private.review_author_card(r.id) a on true
   where not r.is_hidden;
