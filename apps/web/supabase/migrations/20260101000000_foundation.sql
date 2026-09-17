-- =============================================================================
-- HagoTuFila · 000 · Fundaciones: esquemas, extensiones, enums y utilidades
-- =============================================================================
-- Convenciones del proyecto:
--   * Claves primarias UUID (gen_random_uuid()).
--   * Fechas siempre timestamptz. Nunca timestamp sin zona.
--   * Dinero: bigint en unidad mínima + currency char(3). Nunca numeric ni float.
--   * created_at / updated_at en toda tabla mutable, con trigger de actualización.
--   * Las tablas de evidencia y auditoría son append-only: sin políticas de
--     UPDATE ni DELETE para roles de aplicación.
-- =============================================================================

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "citext" with schema extensions;

-- Esquema privado: funciones de apoyo que NO deben exponerse por la API REST.
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.app_role as enum ('CLIENT', 'WORKER', 'ADMIN');

create type public.verification_status as enum (
  'UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'
);

create type public.worker_level as enum ('NUEVO', 'VERIFICADO', 'PRO', 'EXPERTO');

create type public.category_group as enum ('FILA', 'TRAMITE');

create type public.job_status as enum (
  'DRAFT', 'PUBLISHED', 'OFFER_ACCEPTED', 'PAYMENT_PENDING', 'PAID',
  'IN_PROGRESS', 'HANDOFF_COMPLETED', 'COMPLETED', 'DISPUTED',
  'CANCELLED', 'EXPIRED', 'CLOSED'
);

create type public.job_urgency as enum ('FLEXIBLE', 'NORMAL', 'URGENTE');

create type public.job_objective_type as enum (
  'HOLD_PLACE', 'AS_FRONT_AS_POSSIBLE', 'WITHIN_FIRST_N', 'COMPLETE_ERRAND', 'CUSTOM'
);

create type public.offer_status as enum (
  'PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'
);

create type public.assignment_status as enum (
  'AWAITING_PAYMENT', 'CONFIRMED', 'ON_THE_WAY', 'CHECKED_IN', 'IN_PROGRESS',
  'HANDOFF_COMPLETED', 'COMPLETED', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_WORKER'
);

create type public.extension_status as enum (
  'PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'
);

create type public.payment_status as enum (
  'PENDING', 'CREATED', 'AUTHORIZED', 'PAID', 'FAILED',
  'REFUNDED', 'PARTIALLY_REFUNDED', 'UNDER_REVIEW'
);

create type public.payment_purpose as enum ('JOB', 'EXTENSION', 'BONUS');

create type public.payout_status as enum (
  'PENDING', 'APPROVED', 'PROCESSING', 'PAID', 'HELD', 'CANCELLED'
);

create type public.dispute_status as enum ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'WITHDRAWN');

create type public.dispute_resolution as enum ('WORKER_WINS', 'CLIENT_WINS', 'PARTIAL');

create type public.evidence_type as enum (
  'CHECK_IN', 'PHOTO', 'NOTE', 'LOCATION', 'QUEUE_STATUS', 'HANDOFF', 'SYSTEM'
);

create type public.message_type as enum ('TEXT', 'IMAGE', 'SYSTEM');

create type public.notification_type as enum (
  'NEW_OFFER', 'OFFER_ACCEPTED', 'JOB_PAID', 'WORKER_ON_THE_WAY', 'CHECK_IN',
  'NEW_MESSAGE', 'EXTENSION_REQUESTED', 'EXTENSION_ANSWERED', 'JOB_FINISHED',
  'DISPUTE_OPENED', 'PAYOUT_APPROVED', 'NEW_REVIEW', 'VERIFICATION_UPDATED'
);

create type public.loyalty_transaction_type as enum (
  'EARNED_JOB', 'EARNED_PROMO', 'EARNED_REFERRAL',
  'REDEEMED_COMMISSION_DISCOUNT', 'EXPIRED', 'ADJUSTMENT'
);

-- -----------------------------------------------------------------------------
-- Utilidades
-- -----------------------------------------------------------------------------

-- Mantiene updated_at sin depender de que la aplicación se acuerde.
create or replace function app_private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Referencia legible y estable para conciliación y soporte: HTF-XXXXXX.
--
-- Usa gen_random_uuid(), que es parte del núcleo de PostgreSQL, en vez de
-- funciones del esquema "extensions": el rol de la aplicación no tiene permiso
-- de uso sobre ese esquema y esta función se evalúa como DEFAULT de una columna,
-- es decir, con los privilegios de quien inserta.
create or replace function app_private.generate_reference(prefix text default 'HTF')
returns text
language sql
volatile
as $$
  select prefix || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
$$;

-- ¿El usuario actual es administrador?
--
-- SECURITY DEFINER a propósito: consultar public.profiles desde una política
-- sobre public.profiles provocaría recursión infinita en RLS.
-- Se declara en PL/pgSQL, no en SQL puro, a propósito: public.profiles todavía no
-- existe en esta migración y un cuerpo SQL se valida al crearse. Las políticas de
-- las tablas de referencia ya la necesitan, y para cuando alguien las consulte la
-- tabla ya existirá.
create or replace function app_private.is_admin(uid uuid default auth.uid())
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_admin boolean;
begin
  select exists (
    select 1 from public.profiles p
     where p.id = uid and p.role = 'ADMIN'
  ) into v_is_admin;
  return coalesce(v_is_admin, false);
end;
$$;

comment on function app_private.is_admin is
  'Evita recursión en RLS: las políticas sobre profiles no pueden consultar profiles.';

-- -----------------------------------------------------------------------------
-- Realtime
--
-- `alter publication ... add table` falla si la tabla ya está publicada, y en un
-- proyecto alojado `supabase_realtime` puede traer tablas de antes. Se hace
-- idempotente para que `supabase db push` se pueda repetir sin romperse.
-- -----------------------------------------------------------------------------
create or replace function app_private.publish_realtime(p_table regclass)
returns void
language plpgsql
as $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = split_part(p_table::text, '.', 1)
       and tablename = split_part(p_table::text, '.', 2)
  ) then
    execute format('alter publication supabase_realtime add table %s', p_table);
  end if;
exception
  when undefined_object then
    -- Sin la publicación (PostgreSQL a secas, sin Supabase) no hay nada que hacer.
    null;
end;
$$;
