-- ═══════════════════════════════════════════════════════════
-- Linked-user notifications + realtime delivery
-- Run ONCE in the Supabase SQL Editor.
--
-- Fixes the "silent linked activity" flaw. When two linked users share a
-- loan or a repayment, the client writes a linked_transaction_requests /
-- linked_settlement_requests row that the counterparty must Accept. But:
--   • the counterparty got NO notification (notifications were only ever
--     created for group fan-out), and
--   • the request tables were NOT in the realtime publication (only
--     notifications + group_members were), so a freshly-created request
--     only surfaced after a cold app reload.
-- Net effect: the receiver never knew, and the ONLY thing that made
-- records appear on both sides was the manual "Sync past transactions"
-- flow followed by a reload + Accept.
--
-- This migration:
--   1. Emits an in-app notification to the counterparty whenever a linked
--      request / settlement is created, accepted, or rejected. The trigger
--      functions are SECURITY DEFINER so they bypass the notifications
--      INSERT RLS (which only allows self / fellow-group-member) — the same
--      pattern accept_linked_request already uses to write mirrored
--      loans/transactions for the other user.
--   2. Adds the linked request tables — plus the money tables the client
--      already subscribes to in realtime.ts (loans/transactions/accounts) —
--      to the supabase_realtime publication, so every change pushes live.
--
-- Idempotent. Safe to run more than once. No data migration.
-- ═══════════════════════════════════════════════════════════

-- 1. linked_transaction_requests → notify the counterparty.
--    INSERT  → tell the receiver a shared loan is waiting.
--    pending→accepted/rejected → tell the sender the outcome.
create or replace function public.tg_ltr_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name   text;
  v_amount text;
begin
  v_amount := new.currency || ' ' || trim(to_char(new.amount, 'FM999999999990.00'));

  if tg_op = 'INSERT' then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.from_user_id;
    insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
    values (
      gen_random_uuid()::text, new.to_user_id, null, null, 'linked_request',
      'New shared loan to review',
      v_name || ' wants to record ' || v_amount || ' with you. Open Inbox to confirm.',
      now()
    );
  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status in ('accepted', 'rejected') then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.to_user_id;
    insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
    values (
      gen_random_uuid()::text, new.from_user_id, null, null, 'linked_request',
      case when new.status = 'accepted' then 'Shared loan confirmed' else 'Shared loan declined' end,
      v_name || case when new.status = 'accepted'
                     then ' confirmed the shared loan of ' || v_amount || '.'
                     else ' declined the shared loan of ' || v_amount || '.' end,
      now()
    );
  end if;
  return null;  -- AFTER trigger: return value ignored.
end $$;

drop trigger if exists ltr_notify on public.linked_transaction_requests;
create trigger ltr_notify
  after insert or update on public.linked_transaction_requests
  for each row execute function public.tg_ltr_notify();

-- 2. linked_settlement_requests → notify the counterparty.
--    INSERT  → tell the creditor a repayment is waiting to confirm.
--    pending→accepted/rejected → tell the debtor (sender) the outcome.
create or replace function public.tg_lsr_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name   text;
  v_amount text;
begin
  v_amount := new.currency || ' ' || trim(to_char(new.amount, 'FM999999999990.00'));

  if tg_op = 'INSERT' then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.from_user_id;
    insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
    values (
      gen_random_uuid()::text, new.to_user_id, null, null, 'linked_settlement',
      'Repayment to confirm',
      v_name || ' recorded a repayment of ' || v_amount || '. Open Inbox to confirm.',
      now()
    );
  elsif tg_op = 'UPDATE'
        and old.status = 'pending'
        and new.status in ('accepted', 'rejected') then
    select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_name
      from public.profiles p where p.id = new.to_user_id;
    insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
    values (
      gen_random_uuid()::text, new.from_user_id, null, null, 'linked_settlement',
      case when new.status = 'accepted' then 'Repayment confirmed' else 'Repayment declined' end,
      v_name || case when new.status = 'accepted'
                     then ' confirmed the repayment of ' || v_amount || '.'
                     else ' declined the repayment of ' || v_amount || '.' end,
      now()
    );
  end if;
  return null;
end $$;

drop trigger if exists lsr_notify on public.linked_settlement_requests;
create trigger lsr_notify
  after insert or update on public.linked_settlement_requests
  for each row execute function public.tg_lsr_notify();

-- 3. Realtime publication. Add the linked request tables (so a new/updated
--    request pushes live to BOTH participants → Inbox + bell badge update
--    without a reload) and the money tables the client already subscribes to
--    in realtime.ts (loans/transactions/accounts) — previously unpublished,
--    so cross-device sync and post-accept mirrors only appeared after a
--    manual reload. RLS still applies; the server only delivers rows a user
--    is allowed to see.
do $$
declare
  t text;
begin
  foreach t in array array[
    'linked_transaction_requests',
    'linked_settlement_requests',
    'loans',
    'transactions',
    'accounts'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
