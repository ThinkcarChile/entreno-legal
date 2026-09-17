-- =============================================================================
-- HagoTuFila · 700 · FilaPuntos, notificaciones y auditoría
-- =============================================================================

-- -----------------------------------------------------------------------------
-- FilaPuntos
--
-- El ledger es la fuente de verdad; loyalty_accounts es un saldo derivado que
-- mantiene un trigger. Los puntos NO son dinero y no son retirables: solo
-- descuentan comisión de HagoTuFila.
-- -----------------------------------------------------------------------------
create table public.loyalty_accounts (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  balance           integer not null default 0 check (balance >= 0),
  lifetime_earned   integer not null default 0 check (lifetime_earned >= 0),
  lifetime_redeemed integer not null default 0 check (lifetime_redeemed >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger loyalty_accounts_touch
  before update on public.loyalty_accounts
  for each row execute function app_private.touch_updated_at();

create table public.loyalty_transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  transaction_type public.loyalty_transaction_type not null,
  -- Positivo acredita, negativo debita. Nunca cero.
  points           integer not null check (points <> 0),
  balance_after    integer not null check (balance_after >= 0),
  job_id           uuid references public.jobs (id) on delete set null,
  payment_id       uuid references public.payments (id) on delete set null,
  description      text not null,
  created_at       timestamptz not null default now()
);

create index loyalty_transactions_user_idx on public.loyalty_transactions (user_id, created_at desc);

comment on table public.loyalty_transactions is
  'Ledger append-only de FilaPuntos. El saldo se deriva de aquí, no al revés.';

-- Aplica una transacción de puntos de forma atómica y consistente.
create or replace function app_private.apply_loyalty_transaction(
  p_user_id uuid,
  p_type public.loyalty_transaction_type,
  p_points integer,
  p_description text,
  p_job_id uuid default null,
  p_payment_id uuid default null
)
returns public.loyalty_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance integer;
  v_row public.loyalty_transactions;
begin
  insert into public.loyalty_accounts (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  -- Bloquea la cuenta para evitar condiciones de carrera al canjear.
  select balance into v_balance
    from public.loyalty_accounts
   where user_id = p_user_id
     for update;

  v_balance := v_balance + p_points;
  if v_balance < 0 then
    raise exception 'FilaPuntos insuficientes';
  end if;

  update public.loyalty_accounts
     set balance = v_balance,
         lifetime_earned = lifetime_earned + greatest(p_points, 0),
         lifetime_redeemed = lifetime_redeemed + greatest(-p_points, 0),
         updated_at = now()
   where user_id = p_user_id;

  insert into public.loyalty_transactions
    (user_id, transaction_type, points, balance_after, job_id, payment_id, description)
  values
    (p_user_id, p_type, p_points, v_balance, p_job_id, p_payment_id, p_description)
  returning * into v_row;

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- Notificaciones
--
-- La Etapa 1 solo entrega in-app. Las columnas de canal quedan listas para push,
-- email y SMS/WhatsApp sin migrar de nuevo.
-- -----------------------------------------------------------------------------
create table public.notifications (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  notification_type public.notification_type not null,
  title             text not null,
  body              text not null,
  href              text,
  job_id            uuid references public.jobs (id) on delete cascade,
  data              jsonb not null default '{}'::jsonb,
  read_at           timestamptz,
  -- Trazabilidad por canal, para cuando se habiliten.
  delivered_in_app_at timestamptz default now(),
  delivered_push_at   timestamptz,
  delivered_email_at  timestamptz,
  delivered_sms_at    timestamptz,
  created_at        timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

alter publication supabase_realtime add table public.notifications;

-- -----------------------------------------------------------------------------
-- Auditoría
--
-- Append-only. Es la base para resolver reclamos: precios, ofertas aceptadas,
-- pagos, check-ins, extensiones, disputas, payouts y acciones administrativas.
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles (id) on delete set null,
  actor_role  public.app_role,
  action      text not null,
  entity_type text not null,
  entity_id   uuid not null,
  before      jsonb,
  after       jsonb,
  ip_address  inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);

comment on table public.audit_logs is
  'Append-only. Ningún rol de aplicación tiene políticas de UPDATE ni DELETE.';

create or replace function app_private.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity uuid := coalesce(new.id, old.id);
begin
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_entity,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

-- Acciones críticas bajo auditoría.
create trigger jobs_audit
  after insert or update or delete on public.jobs
  for each row execute function app_private.write_audit_log();

create trigger job_offers_audit
  after update or delete on public.job_offers
  for each row execute function app_private.write_audit_log();

create trigger assignments_audit
  after insert or update or delete on public.assignments
  for each row execute function app_private.write_audit_log();

create trigger job_extensions_audit
  after insert or update on public.job_extensions
  for each row execute function app_private.write_audit_log();

create trigger payments_audit
  after insert or update on public.payments
  for each row execute function app_private.write_audit_log();

create trigger payouts_audit
  after insert or update on public.payouts
  for each row execute function app_private.write_audit_log();

create trigger disputes_audit
  after insert or update on public.disputes
  for each row execute function app_private.write_audit_log();

create trigger worker_verifications_audit
  after insert or update on public.worker_verifications
  for each row execute function app_private.write_audit_log();
