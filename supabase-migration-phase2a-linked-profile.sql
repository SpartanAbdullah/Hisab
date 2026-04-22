-- ═══════════════════════════════════════════════════════════
-- Phase 2A: Link a Person to another Hisaab user (identity only).
-- Additive; no collaborative side effects on other tables.
-- ═══════════════════════════════════════════════════════════

-- 1. Column
alter table public.persons
  add column if not exists linked_profile_id uuid;

alter table public.persons
  drop constraint if exists persons_linked_profile_id_fkey;
alter table public.persons
  add constraint persons_linked_profile_id_fkey
  foreign key (linked_profile_id) references public.profiles(id)
  on delete set null;

-- 2. Uniqueness: a user can link each other-user to at most one of their own
-- contacts (prevents the same Amar from appearing as two linked contacts).
create unique index if not exists persons_user_profile_uniq
  on public.persons(user_id, linked_profile_id)
  where linked_profile_id is not null;

-- 3. RPC: read-only, SECURITY DEFINER, returns only what's needed to confirm
-- a link. The client passes the already-normalised code (same rule as
-- normalizePublicCode in src/lib/collaboration.ts): strip prefix/@/hyphens,
-- uppercase. RPC performs one exact compare against public_code_normalized
-- and excludes the caller's own row.
create or replace function public.lookup_profile_by_code(code text)
returns table(profile_id uuid, display_name text)
language sql
security definer
set search_path = public
as $$
  select p.id as profile_id,
         coalesce(nullif(trim(p.name), ''), 'Hisaab user') as display_name
  from public.profiles p
  where p.public_code_normalized = coalesce(code, '')
    and p.id <> auth.uid()
  limit 1;
$$;

revoke all on function public.lookup_profile_by_code(text) from public;
grant execute on function public.lookup_profile_by_code(text) to authenticated;
