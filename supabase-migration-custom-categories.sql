-- Custom categories: user-defined expense/income categories that extend the
-- built-in lists (EXPENSE_CATEGORIES / INCOME_CATEGORIES in src/lib/constants.ts).
--
-- Design notes:
--  * Categories are stored as plain strings on transactions/budgets/recurring
--    already, so this table is ONLY the source of the user's custom NAMES — the
--    app merges built-in + custom at read time. Deleting a custom category here
--    never rewrites historical rows; past transactions keep their string value.
--  * HARD delete (no deleted_at): categories change rarely and the unique index
--    on (user_id, type, lower(name)) means a soft-deleted row would block the
--    user re-adding the same name. A plain delete keeps re-adding clean.
--  * The unique index is case-insensitive so "Pets" and "pets" can't both exist.

create table if not exists public.custom_categories (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  type        text not null check (type in ('expense', 'income')),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists custom_categories_user_type_name_uidx
  on public.custom_categories (user_id, type, lower(name));
create index if not exists custom_categories_user_id_idx
  on public.custom_categories (user_id);

alter table public.custom_categories enable row level security;

drop policy if exists custom_categories_select_own on public.custom_categories;
create policy custom_categories_select_own on public.custom_categories
  for select using (user_id = auth.uid());

drop policy if exists custom_categories_insert_own on public.custom_categories;
create policy custom_categories_insert_own on public.custom_categories
  for insert with check (user_id = auth.uid());

drop policy if exists custom_categories_update_own on public.custom_categories;
create policy custom_categories_update_own on public.custom_categories
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists custom_categories_delete_own on public.custom_categories;
create policy custom_categories_delete_own on public.custom_categories
  for delete using (user_id = auth.uid());
