-- ═══════════════════════════════════════════════════════════
-- Make code-linking BIDIRECTIONAL (+ keep the notification)
-- Run ONCE in the Supabase SQL Editor.
--
-- Supersedes notify_contact_linked from supabase-migration-contact-link-notify.sql
-- (create or replace) and publishes `persons` for realtime.
--
-- Before: when B links A via A's code, only B was linked to A. A got a
-- "you're connected" notification but couldn't INITIATE anything back until A
-- manually linked B (or accepted something) — a confusing dead-end.
--
-- Now: the link is reciprocal. The code owner (A) is also linked back to the
-- adder (B): a persons row is created on A's side pointing at B (same
-- find-or-create pattern as accept_linked_request), so EITHER side can share
-- loans / settle immediately. A is still notified. `persons` is added to the
-- realtime publication so A's contacts list picks up the new linked contact
-- live (no reload).
--
-- Idempotent. RLS still applies to realtime delivery (own rows only).
-- ═══════════════════════════════════════════════════════════

create or replace function public.notify_contact_linked(target_profile_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller_name text;
  v_recip_id    text;
  v_now         timestamptz := now();
begin
  if target_profile_id is null or target_profile_id = auth.uid() then
    return;
  end if;

  -- Anti-abuse: the caller must actually have linked the target (a persons
  -- row of theirs points at it). You can only connect-back someone you added.
  if not exists (
    select 1 from public.persons p
     where p.user_id = auth.uid()
       and p.linked_profile_id = target_profile_id
  ) then
    raise exception 'notify_contact_linked: caller is not linked to target';
  end if;

  select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_caller_name
    from public.profiles p where p.id = auth.uid();

  -- Reciprocal link: ensure the TARGET (code owner) is linked back to the
  -- caller so either side can initiate. Find-or-create against the unique
  -- partial index persons(user_id, linked_profile_id) where not null.
  select p.id into v_recip_id
    from public.persons p
   where p.user_id = target_profile_id
     and p.linked_profile_id = auth.uid()
   limit 1;

  if v_recip_id is null then
    v_recip_id := gen_random_uuid()::text;
    begin
      insert into public.persons(id, user_id, name, phone, linked_profile_id, created_at, updated_at)
      values (v_recip_id, target_profile_id, v_caller_name, null, auth.uid(), v_now, v_now);
    exception when unique_violation then
      -- Raced with another path (e.g. an accept) that already created it.
      select p.id into v_recip_id
        from public.persons p
       where p.user_id = target_profile_id
         and p.linked_profile_id = auth.uid()
       limit 1;
    end;
  end if;

  insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
  values (
    gen_random_uuid()::text, target_profile_id, null, null, 'contact_linked',
    'New connection on Hisaab',
    v_caller_name || ' added you using your code — you''re now connected, and you can share loans or settle up either way.',
    v_now
  );
end $$;

revoke all on function public.notify_contact_linked(uuid) from public;
grant execute on function public.notify_contact_linked(uuid) to authenticated;

-- Publish persons so the code owner's contacts list picks up the reciprocal
-- linked contact live. RLS still applies — only the user's own rows deliver.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'persons'
  ) then
    alter publication supabase_realtime add table public.persons;
  end if;
end $$;
