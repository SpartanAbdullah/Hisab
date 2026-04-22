-- ═══════════════════════════════════════════════════════════
-- Phase 1 (reduced): Persons — minimal columns, additive only
-- No linked_profile_id yet. No legacy columns removed.
-- Safe to run on production; all statements are idempotent.
-- ═══════════════════════════════════════════════════════════

-- 1. persons table (minimal)
create table if not exists public.persons (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists persons_user_id_idx         on public.persons(user_id);
create index if not exists persons_user_name_lower_idx on public.persons(user_id, lower(name));

alter table public.persons enable row level security;

drop policy if exists persons_select_own on public.persons;
create policy persons_select_own on public.persons
  for select using (user_id = auth.uid());

drop policy if exists persons_insert_own on public.persons;
create policy persons_insert_own on public.persons
  for insert with check (user_id = auth.uid());

drop policy if exists persons_update_own on public.persons;
create policy persons_update_own on public.persons
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists persons_delete_own on public.persons;
create policy persons_delete_own on public.persons
  for delete using (user_id = auth.uid());

-- updated_at trigger
create or replace function public.tg_persons_touch() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists persons_touch on public.persons;
create trigger persons_touch before update on public.persons
for each row execute function public.tg_persons_touch();

-- 2. FK columns on loans + transactions (nullable, soft FK)
alter table public.loans        add column if not exists person_id text;
alter table public.transactions add column if not exists person_id text;

alter table public.loans
  drop constraint if exists loans_person_id_fkey;
alter table public.loans
  add constraint loans_person_id_fkey
  foreign key (person_id) references public.persons(id) on delete set null;

alter table public.transactions
  drop constraint if exists transactions_person_id_fkey;
alter table public.transactions
  add constraint transactions_person_id_fkey
  foreign key (person_id) references public.persons(id) on delete set null;

create index if not exists loans_person_id_idx        on public.loans(person_id);
create index if not exists transactions_person_id_idx on public.transactions(person_id);
