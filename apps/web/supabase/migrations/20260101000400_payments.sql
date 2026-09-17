-- =============================================================================
-- HagoTuFila · 400 · Pagos, eventos de pago y payouts
-- =============================================================================
-- Reglas invariables:
--   * Nunca se almacenan datos de tarjeta. Solo identificadores del proveedor.
--   * El dinero del cliente entra a la cuenta comercial de HagoTuFila y queda
--     asociado a un trabajo específico. No existe billetera ni saldo retirable.
--   * payment_events es append-only: la historia de un pago no se reescribe.
-- =============================================================================

create table public.payments (
  id                      uuid primary key default gen_random_uuid(),
  job_id                  uuid not null references public.jobs (id) on delete restrict,
  assignment_id           uuid references public.assignments (id) on delete restrict,
  extension_id            uuid references public.job_extensions (id) on delete restrict,
  client_id               uuid not null references public.profiles (id) on delete restrict,
  purpose                 public.payment_purpose not null default 'JOB',
  status                  public.payment_status not null default 'PENDING',

  amount                  bigint not null check (amount > 0),
  currency                char(3) not null default 'CLP',

  provider                text not null,
  -- Identificador de la transacción en el proveedor. Jamás datos de tarjeta.
  provider_transaction_id text,
  provider_token          text,
  authorization_code      text,
  -- Últimos dígitos entregados por el proveedor, cuando los entrega.
  card_last_digits        char(4),
  payment_type_code       text,
  installments            smallint,

  authorized_at           timestamptz,
  paid_at                 timestamptz,
  failed_at               timestamptz,
  refunded_amount         bigint not null default 0 check (refunded_amount >= 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint payments_refund_within_amount check (refunded_amount <= amount)
);

create index payments_job_idx on public.payments (job_id);
create index payments_client_idx on public.payments (client_id, created_at desc);
create index payments_status_idx on public.payments (status);
create unique index payments_provider_tx_idx
  on public.payments (provider, provider_transaction_id)
  where provider_transaction_id is not null;

create trigger payments_touch
  before update on public.payments
  for each row execute function app_private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Historia del pago. Append-only.
-- -----------------------------------------------------------------------------
create table public.payment_events (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references public.payments (id) on delete cascade,
  from_status public.payment_status,
  to_status   public.payment_status not null,
  provider    text not null,
  -- Carga útil saneada del proveedor. Nunca PAN, CVV ni credenciales.
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index payment_events_payment_idx on public.payment_events (payment_id, created_at);

comment on table public.payment_events is
  'Append-only: sin políticas de UPDATE ni DELETE para roles de aplicación.';

-- Registra cada cambio de estado automáticamente.
create or replace function app_private.log_payment_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.payment_events (payment_id, from_status, to_status, provider)
    values (new.id, null, new.status, new.provider);
  elsif new.status is distinct from old.status then
    insert into public.payment_events (payment_id, from_status, to_status, provider)
    values (new.id, old.status, new.status, new.provider);
  end if;
  return new;
end;
$$;

create trigger payments_log_events
  after insert or update on public.payments
  for each row execute function app_private.log_payment_event();

-- -----------------------------------------------------------------------------
-- Payout al trabajador. En la primera versión la transferencia es manual.
-- -----------------------------------------------------------------------------
create table public.payouts (
  id                  uuid primary key default gen_random_uuid(),
  assignment_id       uuid not null unique references public.assignments (id) on delete restrict,
  worker_id           uuid not null references public.worker_profiles (user_id) on delete restrict,
  payout_account_id   uuid references public.worker_payout_accounts (id) on delete set null,
  status              public.payout_status not null default 'PENDING',

  gross_amount        bigint not null check (gross_amount >= 0),
  commission_amount   bigint not null default 0 check (commission_amount >= 0),
  discount_amount     bigint not null default 0 check (discount_amount >= 0),
  bonus_amount        bigint not null default 0 check (bonus_amount >= 0),
  tax_withheld_amount bigint not null default 0 check (tax_withheld_amount >= 0),
  net_amount          bigint not null check (net_amount >= 0),
  currency            char(3) not null default 'CLP',

  bank_reference      text,
  notes               text,
  approved_by         uuid references public.profiles (id) on delete set null,
  approved_at         timestamptz,
  paid_at             timestamptz,
  held_reason         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index payouts_worker_idx on public.payouts (worker_id, status);
create index payouts_status_idx on public.payouts (status, created_at);

create trigger payouts_touch
  before update on public.payouts
  for each row execute function app_private.touch_updated_at();

comment on table public.payouts is
  'Registro contable del pago al trabajador. La transferencia automática se integra después.';

-- La extensión referencia su pago una vez que la tabla payments existe.
alter table public.job_extensions
  add constraint job_extensions_payment_fk
  foreign key (payment_id) references public.payments (id) on delete set null;
