-- ANDAMIO DE PRUEBA — NO ES UNA MIGRACIÓN. NO SE APLICA EN PRODUCCIÓN.
--
-- La 0043 y la 0044 expresan su RLS con `app.finance_access(hogar, permiso)` y
-- con el enum `public.finance_permission`, que son la Etapa 2 del sprint y las
-- escribe otro frente (van dentro de la 0042 o de una migración hermana). El
-- cimiento del dinero —`currency_units`, `money_status`, `app.apportion`,
-- `app.set_lot_value`— ya está en la 0042 y se usa el de verdad.
--
-- Entregar dos migraciones sin correrlas no es una alternativa, así que este
-- archivo levanta EXACTAMENTE el contrato de permisos que la 0043/0044
-- consumen, ni una columna más.
--
-- El test lo aplica SOLO si `app.finance_access` todavía no existe: el día que
-- la Etapa 2 esté en el árbol, este andamio deja de ejecutarse solo y las mismas
-- pruebas corren contra el helper de verdad. Si el contrato real difiere de
-- esto, las pruebas se ponen rojas — que es justo lo que tienen que hacer.

create type public.finance_permission as enum (
  'FINANCE_VIEW',
  'FINANCE_UPLOAD_RECEIPTS',
  'FINANCE_CONFIRM_RECEIPTS',
  'FINANCE_MANAGE_PRICES',
  'FINANCE_MANAGE_BUDGET'
);

create table if not exists public.household_finance_grants (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  member_id    uuid not null references public.household_members (id) on delete cascade,
  permission   public.finance_permission not null,
  granted_by   uuid not null references public.household_members (id),
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  revoked_by   uuid references public.household_members (id),
  reason       text
);

-- Un permiso VIVO por par: la revocación es una fila que se cierra, no un DELETE.
create unique index if not exists finance_grant_vivo on public.household_finance_grants
  (household_id, member_id, permission) where revoked_at is null;

alter table public.household_finance_grants enable row level security;

create or replace function app.finance_access(p_household uuid, p_permission public.finance_permission)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    -- vía 1: administrador del hogar tiene los cinco, por definición. El
    -- `r.household_id = m.household_id` es el anclaje de 0009:361: sin él, un
    -- rol de otro hogar cuenta.
    select 1 from public.household_members m
      join public.member_role_assignments a on a.member_id = m.id
      join public.household_roles r on r.id = a.role_id
                                   and r.household_id = m.household_id
     where m.household_id = p_household and m.user_id = auth.uid()
       and m.is_active and r.is_admin
    union all
    -- vía 2: grant vivo
    select 1 from public.household_finance_grants g
      join public.household_members m on m.id = g.member_id
     where g.household_id = p_household and m.user_id = auth.uid() and m.is_active
       and g.permission = p_permission and g.revoked_at is null
  );
$$;
