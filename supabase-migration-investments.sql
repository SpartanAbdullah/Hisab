-- ═══════════════════════════════════════════════════════════════════════
-- INVESTMENT TRACKER (markets, trades, manual prices)
--
-- A RECORD-KEEPING tracker: users enter their own stock buys/sells/dividends
-- and manual prices. Hisaab never holds, trades, advises on, or fetches
-- market data for investments (same no-custody framing as committees).
-- Positions (qty / avg cost / P&L) are DERIVED client-side by replaying
-- trades (src/lib/investmentMath.ts) — there is no holdings table to drift.
--
-- Account-linked trades additionally write a `transactions` row (types
-- investment_buy / investment_sell / investment_dividend) via the client's
-- processTransaction; the link is transactions.related_investment_id below.
--
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

begin;

-- ── Tables ──────────────────────────────────────────────────────────────

-- User-defined market with a FIXED currency (DFM→AED, PSX→PKR, ...). The
-- client locks the currency once trades exist; currency values are validated
-- client-side against SUPPORTED_CURRENCIES (committees.currency precedent).
create table if not exists public.investment_markets (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  currency    text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz default null
);

-- The trade ledger — single source of truth for positions.
-- buy/sell: quantity > 0, amount = 0 (total derives from qty × price).
-- dividend: quantity = 0, gross cash in amount, withholding/charges in fees.
-- account_id null = "held outside Hisaab" (ledger-only, no balance touched).
create table if not exists public.investment_trades (
  id             text primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  market_id      text not null references public.investment_markets(id) on delete restrict,
  symbol         text not null,
  name           text not null default '',
  kind           text not null check (kind in ('buy', 'sell', 'dividend')),
  quantity       numeric not null default 0,
  price_per_unit numeric not null default 0,
  amount         numeric not null default 0,
  fees           numeric not null default 0 check (fees >= 0),
  account_id     text default null,
  transaction_id text default null,
  traded_at      timestamptz not null default now(),
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz default null,
  check (
    (kind in ('buy', 'sell') and quantity > 0 and price_per_unit >= 0 and amount = 0)
    or
    (kind = 'dividend' and quantity = 0 and price_per_unit = 0 and amount > 0)
  )
);

-- Manual "last price + as-of" per (user, market, symbol). Upsert-only; lives
-- apart from trades so it survives a fully-sold position.
create table if not exists public.investment_prices (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  market_id   text not null references public.investment_markets(id) on delete cascade,
  symbol      text not null,
  price       numeric not null check (price > 0),
  as_of       timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz default null,
  unique (user_id, market_id, symbol)
);

-- ── transactions link column ────────────────────────────────────────────
-- Mirrors related_goal_id: O(1) lookup from a money row back to its trade.
alter table public.transactions
  add column if not exists related_investment_id text default null;

create index if not exists idx_transactions_related_investment
  on public.transactions (related_investment_id)
  where related_investment_id is not null;

-- ── Indexes ─────────────────────────────────────────────────────────────
create index if not exists idx_investment_markets_user_created
  on public.investment_markets (user_id, created_at desc);
create unique index if not exists uq_investment_markets_user_name
  on public.investment_markets (user_id, lower(name))
  where deleted_at is null;

create index if not exists idx_investment_trades_market
  on public.investment_trades (market_id);
create index if not exists idx_investment_trades_user_symbol
  on public.investment_trades (user_id, market_id, symbol);
create index if not exists idx_investment_trades_user_created
  on public.investment_trades (user_id, created_at desc);

-- Incremental-sync + tombstone indexes (future-proofing: the client is
-- cloud-direct today, but these make a later offline-first flip a
-- client-only change — incremental-sync-core/tombstones conventions).
create index if not exists idx_investment_markets_user_updated
  on public.investment_markets (user_id, updated_at);
create index if not exists idx_investment_trades_user_updated
  on public.investment_trades (user_id, updated_at);
create index if not exists idx_investment_prices_user_updated
  on public.investment_prices (user_id, updated_at);
create index if not exists idx_investment_markets_user_deleted
  on public.investment_markets (user_id, deleted_at) where deleted_at is not null;
create index if not exists idx_investment_trades_user_deleted
  on public.investment_trades (user_id, deleted_at) where deleted_at is not null;
create index if not exists idx_investment_prices_user_deleted
  on public.investment_prices (user_id, deleted_at) where deleted_at is not null;

-- ── updated_at triggers ─────────────────────────────────────────────────
-- Reuses the shared touch function (defensively re-created — identical body
-- to supabase-migration-incremental-sync-core.sql).
create or replace function public.tg_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_investment_markets_touch on public.investment_markets;
create trigger trg_investment_markets_touch
  before update on public.investment_markets
  for each row execute function public.tg_touch_updated_at();

drop trigger if exists trg_investment_trades_touch on public.investment_trades;
create trigger trg_investment_trades_touch
  before update on public.investment_trades
  for each row execute function public.tg_touch_updated_at();

drop trigger if exists trg_investment_prices_touch on public.investment_prices;
create trigger trg_investment_prices_touch
  before update on public.investment_prices
  for each row execute function public.tg_touch_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────
alter table public.investment_markets enable row level security;
alter table public.investment_trades  enable row level security;
alter table public.investment_prices  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['investment_markets', 'investment_trades', 'investment_prices'] loop
    execute format('drop policy if exists %1$s_select_own on public.%1$s', t);
    execute format('create policy %1$s_select_own on public.%1$s for select using (user_id = auth.uid())', t);
    execute format('drop policy if exists %1$s_insert_own on public.%1$s', t);
    execute format('create policy %1$s_insert_own on public.%1$s for insert with check (user_id = auth.uid())', t);
    execute format('drop policy if exists %1$s_update_own on public.%1$s', t);
    execute format('create policy %1$s_update_own on public.%1$s for update using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('drop policy if exists %1$s_delete_own on public.%1$s', t);
    execute format('create policy %1$s_delete_own on public.%1$s for delete using (user_id = auth.uid())', t);
  end loop;
end $$;

commit;
