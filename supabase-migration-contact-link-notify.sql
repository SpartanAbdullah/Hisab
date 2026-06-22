-- ═══════════════════════════════════════════════════════════
-- Notify a user when someone links them via their shared code
-- Run ONCE in the Supabase SQL Editor.
--
-- Linking a contact is consensual: you only become linkable by sharing your
-- in-app code with someone. But the link itself is a private, one-directional
-- write on the LINKER's own persons row — the code owner never finds out.
--
-- This adds a SECURITY DEFINER RPC the client calls right after a successful
-- code-link. It inserts a notification for the code owner (bypassing the
-- notifications INSERT RLS, the same pattern accept_linked_request and the
-- linked-activity triggers use). It is guarded so you can ONLY ping someone
-- you have actually linked — no arbitrary targeting.
--
-- Idempotent (create or replace). No data migration.
-- ═══════════════════════════════════════════════════════════

create or replace function public.notify_contact_linked(target_profile_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller_name text;
begin
  -- No-op for a missing target or self-link.
  if target_profile_id is null or target_profile_id = auth.uid() then
    return;
  end if;

  -- Anti-abuse: the caller must have a persons row pointing at the target
  -- (i.e. they really did link them). This is what makes the ping consensual
  -- and prevents an attacker spamming arbitrary users.
  if not exists (
    select 1 from public.persons p
     where p.user_id = auth.uid()
       and p.linked_profile_id = target_profile_id
  ) then
    raise exception 'notify_contact_linked: caller is not linked to target';
  end if;

  select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_caller_name
    from public.profiles p where p.id = auth.uid();

  insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
  values (
    gen_random_uuid()::text, target_profile_id, null, null, 'contact_linked',
    'New connection on Hisaab',
    v_caller_name || ' added you using your code — you''re now connected on Hisaab.',
    now()
  );
end $$;

revoke all on function public.notify_contact_linked(uuid) from public;
grant execute on function public.notify_contact_linked(uuid) to authenticated;
