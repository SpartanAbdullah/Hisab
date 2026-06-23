-- Kameti / committee (ROSCA) — a NO-CUSTODY tracker. Hisaab never holds or
-- moves the pool; it records the committee (members/slots, who paid each round,
-- whose turn it is) and proves it. This sidesteps the money-custody regulation
-- and is the structural antidote to organizer-absconds scams (there is no pool
-- to steal). v1 is the organizer's tracker (single user); cross-user shared
-- member views are a later phase.
--
-- Three tables: committees, committee_members (one row per slot/share — a person
-- can hold more than one), committee_payments (one row per paid (member, round)).

create table if not exists public.committees (
  id                  text primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  name                text not null,
  currency            text not null,
  contribution_amount numeric not null,
  member_count        int not null,                 -- N slots
  cadence             text not null check (cadence in ('daily', 'weekly', 'monthly')),
  total_rounds        int not null,                 -- usually = member_count
  start_date          date not null,
  payout_method       text not null default 'fixed' check (payout_method in ('fixed', 'ballot')),
  status              text not null default 'active' check (status in ('active', 'completed')),
  notes               text not null default '',
  drawn_at            timestamptz,                  -- when the order/ballot was set
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.committee_members (
  id                 text primary key,
  committee_id       text not null references public.committees(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  name               text not null,
  phone              text,
  person_id          text,                          -- optional link to a Hisaab contact
  slot               int,                           -- payout round (1..N); null until assigned
  is_organizer       boolean not null default false,
  payout_received_at timestamptz,                   -- when this member received their pool
  exited_at          timestamptz,                   -- dropout / removed state
  created_at         timestamptz not null default now()
);
create index if not exists committee_members_committee_idx on public.committee_members (committee_id);

create table if not exists public.committee_payments (
  id           text primary key,
  committee_id text not null references public.committees(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  member_id    text not null references public.committee_members(id) on delete cascade,
  round        int not null,
  paid_at      timestamptz not null default now(),
  unique (member_id, round)
);
create index if not exists committee_payments_committee_idx on public.committee_payments (committee_id);

-- RLS: owner-only on all three.
alter table public.committees enable row level security;
alter table public.committee_members enable row level security;
alter table public.committee_payments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['committees', 'committee_members', 'committee_payments'] loop
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
