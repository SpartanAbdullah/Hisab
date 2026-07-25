-- ═══════════════════════════════════════════════════════════
-- Connections, push delivery, and phone discovery
-- Run ONCE in the Supabase SQL Editor.
--
-- Three independent-but-related problems this fixes:
--
--  1. CONSENT ON CONNECT. Today notify_contact_linked (the reciprocal
--     migration) silently writes a contact into the code OWNER's ledger.
--     They never agreed to it, and in practice they often can't tell where
--     it came from. Now the owner gets an explicit ask — "Asif added you,
--     add them back?" — and the reciprocal contact is created only when
--     they say yes. Already-connected pairs are auto-accepted so nothing
--     that works today starts asking.
--
--  2. PUSH DELIVERY. In-app realtime is the only delivery channel, so a
--     backgrounded Android app learns about a request whenever the user
--     next opens it. device_push_tokens + a notifications-insert trigger
--     hand every new notification to an Edge Function that talks to FCM.
--     The trigger is a NO-OP until push config is installed (section 6),
--     so this half is safe to run before Firebase exists.
--
--  3. PHONE DISCOVERY. A contact you saved with a phone number might
--     already be on Hisaab, and there was no way to know. Opt-in only:
--     nothing is discoverable until the user turns it on for themselves.
--     Numbers are compared server-side and NEVER returned to a caller.
--
-- Idempotent. Safe to run more than once.
-- ═══════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════
-- SECTION 1. contact_link_requests — the "add them back?" ask
-- ═══════════════════════════════════════════════════════════

create table if not exists public.contact_link_requests (
  id            text primary key,
  -- The adder: they scanned/typed the code and are already linked.
  from_user_id  uuid not null references auth.users(id) on delete cascade,
  -- The code owner: they decide whether to add the adder back.
  to_user_id    uuid not null references auth.users(id) on delete cascade,
  -- Display-name snapshot of the adder. The owner cannot read the adder's
  -- profile row (RLS), so without this the card would have to say "someone".
  from_name     text not null default '',
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'declined')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  constraint clr_different_parties check (from_user_id <> to_user_id)
);

-- Older installs created this table without from_name.
alter table public.contact_link_requests
  add column if not exists from_name text not null default '';

-- One live row per direction. A re-link reuses the row (see section 2)
-- rather than stacking duplicate asks in the owner's inbox.
create unique index if not exists contact_link_requests_pair_uniq
  on public.contact_link_requests(from_user_id, to_user_id);
create index if not exists contact_link_requests_to_pending_idx
  on public.contact_link_requests(to_user_id, created_at desc)
  where status = 'pending';

alter table public.contact_link_requests enable row level security;

-- Participants can READ their own asks (the owner needs to render it; the
-- adder needs to show "waiting for them to add you back"). Nobody writes
-- directly — every mutation goes through a SECURITY DEFINER RPC below.
drop policy if exists clr_select_participant on public.contact_link_requests;
create policy clr_select_participant on public.contact_link_requests
  for select using (auth.uid() = from_user_id or auth.uid() = to_user_id);


-- ═══════════════════════════════════════════════════════════
-- SECTION 2. notify_contact_linked v3 — ask instead of auto-add
--
-- Supersedes the version in supabase-migration-contact-link-reciprocal.sql.
-- Same guard (you can only ping someone you actually linked), same
-- notification, but the reciprocal persons row is no longer written here.
-- ═══════════════════════════════════════════════════════════

create or replace function public.notify_contact_linked(target_profile_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller_name  text;
  v_existing_id  text;
  v_req_id       text;
  v_req_status   text;
  v_now          timestamptz := now();
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

  -- Already mutual? (Either they added the caller independently, or an
  -- earlier accept / the old auto-reciprocal migration already wrote the
  -- row.) Record it as accepted and stay silent about adding back — there
  -- is nothing to decide.
  select p.id into v_existing_id
    from public.persons p
   where p.user_id = target_profile_id
     and p.linked_profile_id = auth.uid()
   limit 1;

  select r.id, r.status into v_req_id, v_req_status
    from public.contact_link_requests r
   where r.from_user_id = auth.uid()
     and r.to_user_id = target_profile_id
   limit 1;

  if v_existing_id is not null then
    if v_req_id is null then
      insert into public.contact_link_requests(id, from_user_id, to_user_id, from_name, status, created_at, responded_at)
      values (gen_random_uuid()::text, auth.uid(), target_profile_id, v_caller_name, 'accepted', v_now, v_now)
      on conflict (from_user_id, to_user_id) do nothing;
    elsif v_req_status <> 'accepted' then
      update public.contact_link_requests
         set status = 'accepted', responded_at = v_now, from_name = v_caller_name
       where id = v_req_id;
    end if;

    insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
    values (
      gen_random_uuid()::text, target_profile_id, null, null, 'contact_linked',
      'New connection on Hisaab',
      v_caller_name || ' added you using your code — you''re now connected, and you can share loans or settle up either way.',
      v_now
    );
    return;
  end if;

  -- Not mutual yet → open (or re-open) the ask. A previously declined ask
  -- re-opens only because the caller deliberately linked again, which means
  -- unlinking and re-entering the code — not something that happens by
  -- accident, and not something the caller can repeat without the owner's
  -- code in hand.
  if v_req_id is null then
    v_req_id := gen_random_uuid()::text;
    begin
      insert into public.contact_link_requests(id, from_user_id, to_user_id, from_name, status, created_at)
      values (v_req_id, auth.uid(), target_profile_id, v_caller_name, 'pending', v_now);
    exception when unique_violation then
      select r.id, r.status into v_req_id, v_req_status
        from public.contact_link_requests r
       where r.from_user_id = auth.uid()
         and r.to_user_id = target_profile_id
       limit 1;
    end;
  elsif v_req_status = 'declined' then
    update public.contact_link_requests
       set status = 'pending', created_at = v_now, responded_at = null, from_name = v_caller_name
     where id = v_req_id;
  else
    -- Already pending — the owner has an un-actioned ask sitting there.
    -- Don't stack a second notification on top of it.
    return;
  end if;

  insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
  values (
    gen_random_uuid()::text, target_profile_id, null, null, 'contact_linked',
    'New connection on Hisaab',
    v_caller_name || ' added you using your Hisaab code. Add them to your contacts so you can share loans and settle up both ways.',
    v_now
  );
end $$;

revoke all on function public.notify_contact_linked(uuid) from public;
grant execute on function public.notify_contact_linked(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════
-- SECTION 3. respond_contact_link — the owner's Add / Not now
--
-- Accept  → find-or-create (and un-archive) the owner's contact pointing at
--           the adder, then tell the adder it went both ways.
-- Decline → terminal for this ask; nothing is written to the ledger.
-- Idempotent: replaying a terminal state returns the same answer.
-- ═══════════════════════════════════════════════════════════

create or replace function public.respond_contact_link(
  p_request_id text,
  p_accept     boolean
)
returns table(success boolean, reason_code text, person_id text)
language plpgsql security definer set search_path = public as $$
declare
  v_req        public.contact_link_requests%rowtype;
  v_person_id  text;
  v_from_name  text;
  v_my_name    text;
  v_now        timestamptz := now();
begin
  select * into v_req from public.contact_link_requests where id = p_request_id;
  if not found then
    return query select false, 'NOT_FOUND'::text, null::text; return;
  end if;
  if v_req.to_user_id <> auth.uid() then
    return query select false, 'NOT_YOURS'::text, null::text; return;
  end if;

  -- Terminal replay: report the existing outcome rather than flipping it.
  if v_req.status = 'declined' then
    return query select p_accept = false, 'ALREADY_DECLINED'::text, null::text; return;
  end if;

  if v_req.status = 'accepted' then
    select p.id into v_person_id
      from public.persons p
     where p.user_id = auth.uid() and p.linked_profile_id = v_req.from_user_id
     limit 1;
    return query select true, 'ALREADY_ACCEPTED'::text, v_person_id; return;
  end if;

  if not p_accept then
    update public.contact_link_requests
       set status = 'declined', responded_at = v_now
     where id = p_request_id;
    return query select true, 'DECLINED'::text, null::text; return;
  end if;

  select coalesce(nullif(trim(p.name), ''), nullif(trim(v_req.from_name), ''), 'A Hisaab user')
    into v_from_name
    from public.profiles p where p.id = v_req.from_user_id;
  v_from_name := coalesce(nullif(trim(v_from_name), ''), nullif(trim(v_req.from_name), ''), 'A Hisaab user');
  select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_my_name
    from public.profiles p where p.id = auth.uid();

  -- Find-or-create against the Phase 2A unique partial index on
  -- (user_id, linked_profile_id) where not null — same shape as
  -- accept_linked_request so the two paths can never diverge.
  select p.id into v_person_id
    from public.persons p
   where p.user_id = auth.uid()
     and p.linked_profile_id = v_req.from_user_id
   limit 1;

  if v_person_id is null then
    v_person_id := gen_random_uuid()::text;
    begin
      insert into public.persons(id, user_id, name, phone, linked_profile_id, created_at, updated_at)
      values (v_person_id, auth.uid(), v_from_name, null, v_req.from_user_id, v_now, v_now);
    exception when unique_violation then
      select p.id into v_person_id
        from public.persons p
       where p.user_id = auth.uid()
         and p.linked_profile_id = v_req.from_user_id
       limit 1;
    end;
  end if;

  -- A contact the owner archived earlier must come back — otherwise the
  -- accept "succeeds" and the contact stays invisible.
  if v_person_id is not null then
    update public.persons
       set archived_at = null, updated_at = v_now
     where id = v_person_id
       and user_id = auth.uid()
       and archived_at is not null;
  end if;

  update public.contact_link_requests
     set status = 'accepted', responded_at = v_now
   where id = p_request_id;

  -- Close the loop for the adder: they asked, they get told.
  insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
  values (
    gen_random_uuid()::text, v_req.from_user_id, null, null, 'contact_linked',
    'Connected on Hisaab',
    v_my_name || ' added you back — you''re connected both ways and can share loans or settle up.',
    v_now
  );

  return query select true, 'ACCEPTED'::text, v_person_id;
end $$;

revoke all on function public.respond_contact_link(text, boolean) from public;
grant execute on function public.respond_contact_link(text, boolean) to authenticated;


-- ═══════════════════════════════════════════════════════════
-- SECTION 4. Phone discovery — "this contact is on Hisaab"
--
-- Storage is opt-in and reversible; matching happens server-side and the
-- RPC never echoes a number back. Callers can only ask about numbers they
-- already have (their own saved contacts), and only 60 at a time.
-- ═══════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists phone_e164 text,
  add column if not exists phone_discoverable boolean not null default false;

-- Non-unique on purpose: a shared household number is legitimate.
create index if not exists profiles_phone_discovery_idx
  on public.profiles(phone_e164)
  where phone_e164 is not null and phone_discoverable;

-- Per-user throttle on discovery lookups. Reuses the join_code_attempts
-- shape from the prelaunch hardening migration.
create table if not exists public.phone_lookup_attempts (
  user_id     uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists phone_lookup_attempts_user_idx
  on public.phone_lookup_attempts(user_id, attempted_at desc);
alter table public.phone_lookup_attempts enable row level security;
-- No policies: the table is only ever touched by the SECURITY DEFINER RPC.

create or replace function public.lookup_hisaab_users_by_phone(p_numbers text[])
returns table(phone_e164 text, profile_id uuid, display_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_recent int;
begin
  if auth.uid() is null then
    raise exception 'lookup_hisaab_users_by_phone: not authenticated';
  end if;
  if p_numbers is null or array_length(p_numbers, 1) is null then
    return;
  end if;
  if array_length(p_numbers, 1) > 60 then
    raise exception 'lookup_hisaab_users_by_phone: too many numbers (max 60)';
  end if;

  -- 20 calls per rolling hour. Enough for normal contact-list refreshes,
  -- far too slow to enumerate a number range.
  delete from public.phone_lookup_attempts
   where attempted_at < now() - interval '1 hour';
  select count(*) into v_recent
    from public.phone_lookup_attempts a
   where a.user_id = auth.uid()
     and a.attempted_at > now() - interval '1 hour';
  if v_recent >= 20 then
    raise exception 'lookup_hisaab_users_by_phone: rate limit exceeded';
  end if;
  insert into public.phone_lookup_attempts(user_id) values (auth.uid());

  return query
    select p.phone_e164,
           p.id,
           coalesce(nullif(trim(p.name), ''), 'Hisaab user')
      from public.profiles p
     where p.phone_discoverable
       and p.phone_e164 is not null
       and p.phone_e164 = any(p_numbers)
       and p.id <> auth.uid();
end $$;

revoke all on function public.lookup_hisaab_users_by_phone(text[]) from public;
grant execute on function public.lookup_hisaab_users_by_phone(text[]) to authenticated;

-- The profiles protect-security-fields trigger (p0-launch-blockers) guards
-- id/public_code columns. phone_e164 / phone_discoverable are ordinary
-- self-service columns — the existing "update own profile" policy covers
-- them, and nothing else may read them (no SELECT policy change here).


-- ═══════════════════════════════════════════════════════════
-- SECTION 5. device_push_tokens — where to deliver a push
-- ═══════════════════════════════════════════════════════════

create table if not exists public.device_push_tokens (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  token       text not null,
  platform    text not null default 'android' check (platform in ('android', 'ios', 'web')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One row per device token. A token that moves to another account (shared
-- phone, re-login) is re-pointed by the upsert, never duplicated.
create unique index if not exists device_push_tokens_token_uniq
  on public.device_push_tokens(token);
create index if not exists device_push_tokens_user_idx
  on public.device_push_tokens(user_id);

alter table public.device_push_tokens enable row level security;

drop policy if exists dpt_select_own on public.device_push_tokens;
create policy dpt_select_own on public.device_push_tokens
  for select using (user_id = auth.uid());

drop policy if exists dpt_insert_own on public.device_push_tokens;
create policy dpt_insert_own on public.device_push_tokens
  for insert with check (user_id = auth.uid());

drop policy if exists dpt_update_own on public.device_push_tokens;
create policy dpt_update_own on public.device_push_tokens
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists dpt_delete_own on public.device_push_tokens;
create policy dpt_delete_own on public.device_push_tokens
  for delete using (user_id = auth.uid());

-- Claim a token for the current user. An upsert on the unique token index
-- so signing in on a phone someone else used re-points the row instead of
-- failing — otherwise the previous owner keeps getting this device's push.
create or replace function public.register_push_token(p_token text, p_platform text default 'android')
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(trim(p_token), '') = '' then
    return;
  end if;
  insert into public.device_push_tokens(id, user_id, token, platform, created_at, updated_at)
  values (gen_random_uuid()::text, auth.uid(), trim(p_token),
          coalesce(nullif(p_platform, ''), 'android'), now(), now())
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        updated_at = now();
end $$;

revoke all on function public.register_push_token(text, text) from public;
grant execute on function public.register_push_token(text, text) to authenticated;


-- ═══════════════════════════════════════════════════════════
-- SECTION 6. Push dispatch — notifications insert → Edge Function
--
-- Config lives in a locked-down table rather than ALTER DATABASE SET so it
-- can be installed from the SQL editor. Until BOTH rows exist the trigger
-- is a silent no-op, which is what makes this migration safe to run before
-- Firebase is set up. See docs/push-notifications-setup.md.
-- ═══════════════════════════════════════════════════════════

create table if not exists public.app_push_config (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);
alter table public.app_push_config enable row level security;
-- Deliberately no policies: only SECURITY DEFINER functions read this.

create or replace function public.tg_notifications_push() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from public.app_push_config where key = 'edge_url';
  select value into v_secret from public.app_push_config where key = 'edge_secret';
  -- Not configured yet → in-app delivery only. No error, no noise.
  if v_url is null or v_secret is null then
    return null;
  end if;

  -- pg_net is fire-and-forget: the insert never waits on FCM, and a push
  -- failure can never roll back the notification the app depends on.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-hisaab-push-secret', v_secret
    ),
    body    := jsonb_build_object(
      'user_id', new.user_id,
      'title',   new.title,
      'body',    new.body,
      'type',    new.type,
      'notification_id', new.id
    )
  );
  return null;
exception when others then
  -- A broken push pipeline must never break the write that triggered it.
  return null;
end $$;

drop trigger if exists notifications_push on public.notifications;
create trigger notifications_push
  after insert on public.notifications
  for each row execute function public.tg_notifications_push();


-- ═══════════════════════════════════════════════════════════
-- SECTION 7. Realtime publication
-- The owner's "add them back?" ask must appear without a reload, and the
-- adder's "waiting for them" state must flip the moment it's answered.
-- ═══════════════════════════════════════════════════════════

do $$
declare
  t text;
begin
  foreach t in array array['contact_link_requests'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- ═══════════════════════════════════════════════════════════
-- SECTION 8. Backfill — don't ask about pairs that are already mutual
-- Every existing two-way link becomes an accepted row, so nobody who is
-- already connected gets a surprise "add them back?" card.
-- ═══════════════════════════════════════════════════════════

insert into public.contact_link_requests(id, from_user_id, to_user_id, from_name, status, created_at, responded_at)
select gen_random_uuid()::text, a.user_id, a.linked_profile_id,
       coalesce(nullif(trim(b.name), ''), 'A Hisaab user'), 'accepted', now(), now()
  from public.persons a
  join public.persons b
    on b.user_id = a.linked_profile_id
   and b.linked_profile_id = a.user_id
 where a.linked_profile_id is not null
   and a.user_id <> a.linked_profile_id
on conflict (from_user_id, to_user_id) do nothing;
