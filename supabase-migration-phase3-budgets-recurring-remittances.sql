-- ═══════════════════════════════════════════════════════════
-- Phase 3: Budgets + Recurring Transactions + Remittances
--
-- Three independent feature tables landed together because they share
-- no foreign keys (only user_id) and the user-facing rollout is one
-- release. Each table is fully additive and idempotent; safe on prod.
--
-- Apply order:
--   1. budgets
--   2. recurring_transactions
--   3. remittances
-- ═══════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────
-- 1. budgets — monthly category cap per (category, currency)
-- ──────────────────────────────────────────────────────────

create table if not exists public.budgets (
  id              text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  category        text not null,
  monthly_amount  numeric not null check (monthly_amount >= 0),
  currency        text not null,
  warn_at_percent integer not null default 80 check (warn_at_percent between 1 and 100),
  created_at      timestamptz not null default now()
);

-- Enforced single-budget-per-(user, category, currency) so the UI
-- never has to disambiguate "which Groceries budget did you mean".
create unique index if not exists budgets_user_cat_currency_uidx
  on public.budgets(user_id, lower(category), currency);

create index if not exists budgets_user_id_idx on public.budgets(user_id);

alter table public.budgets enable row level security;

drop policy if exists budgets_select_own on public.budgets;
create policy budgets_select_own on public.budgets
  for select using (user_id = auth.uid());

drop policy if exists budgets_insert_own on public.budgets;
create policy budgets_insert_own on public.budgets
  for insert with check (user_id = auth.uid());

drop policy if exists budgets_update_own on public.budgets;
create policy budgets_update_own on public.budgets
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists budgets_delete_own on public.budgets;
create policy budgets_delete_own on public.budgets
  for delete using (user_id = auth.uid());


-- ──────────────────────────────────────────────────────────
-- 2. recurring_transactions — templates that materialise on schedule
-- ──────────────────────────────────────────────────────────

create table if not exists public.recurring_transactions (
  id                     text primary key,
  user_id                uuid not null references auth.users(id) on delete cascade,
  type                   text not null check (type in ('income', 'expense', 'transfer')),
  amount                 numeric not null check (amount > 0),
  currency               text not null,
  source_account_id      text,
  destination_account_id text,
  category               text not null default '',
  notes                  text not null default '',
  cadence                text not null check (cadence in ('daily', 'weekly', 'monthly', 'yearly')),
  next_due_date          date not null,
  active                 boolean not null default true,
  label                  text not null default '',
  created_at             timestamptz not null default now()
);

create index if not exists recurring_user_id_idx       on public.recurring_transactions(user_id);
create index if not exists recurring_due_date_idx      on public.recurring_transactions(user_id, next_due_date) where active = true;

alter table public.recurring_transactions enable row level security;

drop policy if exists recurring_select_own on public.recurring_transactions;
create policy recurring_select_own on public.recurring_transactions
  for select using (user_id = auth.uid());

drop policy if exists recurring_insert_own on public.recurring_transactions;
create policy recurring_insert_own on public.recurring_transactions
  for insert with check (user_id = auth.uid());

drop policy if exists recurring_update_own on public.recurring_transactions;
create policy recurring_update_own on public.recurring_transactions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists recurring_delete_own on public.recurring_transactions;
create policy recurring_delete_own on public.recurring_transactions
  for delete using (user_id = auth.uid());


-- ──────────────────────────────────────────────────────────
-- 3. remittances — money-home with cost-of-conversion context
-- ──────────────────────────────────────────────────────────

create table if not exists public.remittances (
  id                     text primary key,
  user_id                uuid not null references auth.users(id) on delete cascade,
  source_account_id      text not null,
  source_currency        text not null,
  source_amount          numeric not null check (source_amount > 0),
  destination_account_id text,
  destination_currency   text not null,
  destination_amount     numeric not null check (destination_amount > 0),
  channel                text not null check (channel in ('bank_transfer', 'wise', 'remitly', 'western_union', 'hundi', 'other')),
  fee_amount             numeric not null default 0 check (fee_amount >= 0),
  fee_currency           text not null,
  effective_rate         numeric not null check (effective_rate > 0),
  status                 text not null default 'pending' check (status in ('pending', 'received', 'failed')),
  recipient_name         text not null default '',
  notes                  text not null default '',
  source_txn_id          text,
  destination_txn_id     text,
  sent_at                timestamptz not null,
  received_at            timestamptz,
  created_at             timestamptz not null default now()
);

create index if not exists remittances_user_id_idx on public.remittances(user_id);
create index if not exists remittances_sent_at_idx on public.remittances(user_id, sent_at desc);

alter table public.remittances enable row level security;

drop policy if exists remittances_select_own on public.remittances;
create policy remittances_select_own on public.remittances
  for select using (user_id = auth.uid());

drop policy if exists remittances_insert_own on public.remittances;
create policy remittances_insert_own on public.remittances
  for insert with check (user_id = auth.uid());

drop policy if exists remittances_update_own on public.remittances;
create policy remittances_update_own on public.remittances
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists remittances_delete_own on public.remittances;
create policy remittances_delete_own on public.remittances
  for delete using (user_id = auth.uid());
