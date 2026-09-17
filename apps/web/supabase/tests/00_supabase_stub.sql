-- Stub local que imita lo que Supabase provee (auth, storage, roles, realtime).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- En Supabase el rol de servicio omite RLS.
alter role service_role bypassrls;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;

create extension if not exists pgcrypto with schema extensions;

-- Columnas equivalentes a las que usa Supabase Auth, para que la semilla de
-- demostración se pueda aplicar y probar igual que en un proyecto real.
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid default '00000000-0000-0000-0000-000000000000',
  aud text default 'authenticated',
  role text default 'authenticated',
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb default '{"provider":"email","providers":["email"]}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- Un proyecto Supabase real concede esto, y el stub no lo imitaba. Mientras
-- todas las funciones que llamaban a auth.uid() desde una sesión de usuario eran
-- SECURITY DEFINER —es decir, corrían como postgres— la diferencia no se notaba.
-- Se notó al pasar `mark_conversation_read` a SECURITY INVOKER: ahí el llamante
-- es `authenticated` de verdad, y sin estos grants fallaba en local con
-- «permission denied for schema auth» mientras funcionaba contra Supabase. Un
-- stub que miente en un sentido u otro no sirve como red.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key, name text not null, public boolean default false
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$ select string_to_array(name, '/') $$;

create publication supabase_realtime;
