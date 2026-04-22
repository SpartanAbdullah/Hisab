-- ═══════════════════════════════════════════════════════════
-- Phase 2B: linked_transaction_requests + state-machine RPCs
-- Trimmed: no 'disputed' state, no balance moves, no activities.
-- ═══════════════════════════════════════════════════════════

-- 1. Table
create table if not exists public.linked_transaction_requests (
  id                   text primary key,
  from_user_id         uuid not null references auth.users(id) on delete cascade,
  to_user_id           uuid not null references auth.users(id) on delete cascade,
  person_id            text references public.persons(id) on delete set null,
  kind                 text not null check (kind in ('lent','borrowed')),
  amount               numeric not null check (amount > 0),
  currency             text not null check (currency in ('AED','PKR')),
  note                 text not null default '',
  status               text not null default 'pending'
                         check (status in ('pending','accepted','rejected','cancelled')),
  rejection_reason     text,
  requester_loan_id    text,
  responder_loan_id    text,
  requester_txn_id     text,
  responder_txn_id     text,
  created_at           timestamptz not null default now(),
  responded_at         timestamptz,
  constraint ltr_different_parties check (from_user_id <> to_user_id)
);

create index if not exists idx_ltr_to_pending
  on public.linked_transaction_requests(to_user_id, created_at desc)
  where status = 'pending';
create index if not exists idx_ltr_from_pending
  on public.linked_transaction_requests(from_user_id, created_at desc)
  where status = 'pending';

alter table public.linked_transaction_requests enable row level security;

drop policy if exists ltr_select_participant on public.linked_transaction_requests;
create policy ltr_select_participant on public.linked_transaction_requests
  for select using (from_user_id = auth.uid() or to_user_id = auth.uid());

drop policy if exists ltr_insert_own on public.linked_transaction_requests;
create policy ltr_insert_own on public.linked_transaction_requests
  for insert with check (from_user_id = auth.uid());

-- No update / delete policies: state transitions only via SECURITY DEFINER RPCs.

-- 2. Insert trigger — validates invariants and forces clean initial state.
create or replace function public.tg_ltr_validate_insert() returns trigger
language plpgsql as $$
declare
  v_linked uuid;
begin
  if new.from_user_id <> auth.uid() then
    raise exception 'ltr: from_user_id must be caller';
  end if;
  if new.from_user_id = new.to_user_id then
    raise exception 'ltr: self-link not allowed';
  end if;
  select p.linked_profile_id into v_linked
    from public.persons p
   where p.id = new.person_id
     and p.user_id = new.from_user_id;
  if v_linked is null or v_linked <> new.to_user_id then
    raise exception 'ltr: person not linked to target user';
  end if;
  -- Force clean initial state even if the client tries to pre-set.
  new.status := 'pending';
  new.rejection_reason := null;
  new.responded_at := null;
  new.requester_loan_id := null;
  new.responder_loan_id := null;
  new.requester_txn_id := null;
  new.responder_txn_id := null;
  return new;
end $$;

drop trigger if exists ltr_validate_insert on public.linked_transaction_requests;
create trigger ltr_validate_insert before insert on public.linked_transaction_requests
for each row execute function public.tg_ltr_validate_insert();

-- 3. RPC: accept_linked_request(request_id)
--    Idempotent. On first call with status='pending' creates mirrored loans
--    and transactions on both sides with null account ids (balances untouched
--    per Phase 2B trim). Subsequent calls on terminal state return the row
--    unchanged.
create or replace function public.accept_linked_request(request_id text)
returns public.linked_transaction_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req       public.linked_transaction_requests;
  v_from_name text;
  v_to_name   text;
  v_sender_person_name   text;
  v_sender_person_id     text;
  v_receiver_person_id   text;
  v_requester_loan_id    text;
  v_responder_loan_id    text;
  v_requester_txn_id     text;
  v_responder_txn_id     text;
  v_requester_loan_type  text;
  v_responder_loan_type  text;
  v_requester_txn_type   text;
  v_responder_txn_type   text;
  v_now                  timestamptz := now();
begin
  select * into v_req
    from public.linked_transaction_requests
   where id = request_id
   for update;
  if not found then
    raise exception 'ltr: request not found';
  end if;
  if v_req.status <> 'pending' then
    return v_req;
  end if;
  if v_req.to_user_id <> auth.uid() then
    raise exception 'ltr: only the target user can accept';
  end if;

  -- Direction from sender kind.
  if v_req.kind = 'lent' then
    v_requester_loan_type := 'given';
    v_responder_loan_type := 'taken';
    v_requester_txn_type  := 'loan_given';
    v_responder_txn_type  := 'loan_taken';
  else
    v_requester_loan_type := 'taken';
    v_responder_loan_type := 'given';
    v_requester_txn_type  := 'loan_taken';
    v_responder_txn_type  := 'loan_given';
  end if;

  -- Sender-side person name cache (for the receiver's display).
  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_from_name
    from public.profiles p where p.id = v_req.from_user_id;
  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_to_name
    from public.profiles p where p.id = v_req.to_user_id;

  -- Sender's person row (may be null if unlinked after creation).
  select p.id, coalesce(nullif(trim(p.name), ''), v_to_name)
    into v_sender_person_id, v_sender_person_name
    from public.persons p
   where p.id = v_req.person_id
     and p.user_id = v_req.from_user_id;

  -- Receiver's person row: find-or-create against the Phase 2A unique
  -- partial index on (user_id, linked_profile_id) where not null.
  select p.id into v_receiver_person_id
    from public.persons p
   where p.user_id = v_req.to_user_id
     and p.linked_profile_id = v_req.from_user_id
   limit 1;

  if v_receiver_person_id is null then
    v_receiver_person_id := gen_random_uuid()::text;
    begin
      insert into public.persons(id, user_id, name, phone, linked_profile_id, created_at, updated_at)
      values (v_receiver_person_id, v_req.to_user_id, v_from_name, null, v_req.from_user_id, v_now, v_now);
    exception when unique_violation then
      select p.id into v_receiver_person_id
        from public.persons p
       where p.user_id = v_req.to_user_id
         and p.linked_profile_id = v_req.from_user_id
       limit 1;
    end;
  end if;

  -- Generate ids up-front so we can link the request row at the end.
  v_requester_loan_id := gen_random_uuid()::text;
  v_responder_loan_id := gen_random_uuid()::text;
  v_requester_txn_id  := gen_random_uuid()::text;
  v_responder_txn_id  := gen_random_uuid()::text;

  -- Sender-side mirrored loan.
  insert into public.loans(
    id, user_id, person_name, person_id, type,
    total_amount, remaining_amount, currency, status, notes, created_at
  ) values (
    v_requester_loan_id, v_req.from_user_id,
    coalesce(v_sender_person_name, v_to_name), v_sender_person_id, v_requester_loan_type,
    v_req.amount, v_req.amount, v_req.currency, 'active', v_req.note, v_now
  );

  -- Receiver-side mirrored loan.
  insert into public.loans(
    id, user_id, person_name, person_id, type,
    total_amount, remaining_amount, currency, status, notes, created_at
  ) values (
    v_responder_loan_id, v_req.to_user_id,
    v_from_name, v_receiver_person_id, v_responder_loan_type,
    v_req.amount, v_req.amount, v_req.currency, 'active', v_req.note, v_now
  );

  -- Sender-side mirrored transaction. Account ids are null by design: 2B
  -- records the obligation without moving balances.
  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_requester_txn_id, v_req.from_user_id, v_requester_txn_type, v_req.amount, v_req.currency,
    null, null,
    coalesce(v_sender_person_name, v_to_name), v_sender_person_id, v_requester_loan_id, null,
    null, '', v_req.note, v_now
  );

  -- Receiver-side mirrored transaction.
  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_responder_txn_id, v_req.to_user_id, v_responder_txn_type, v_req.amount, v_req.currency,
    null, null,
    v_from_name, v_receiver_person_id, v_responder_loan_id, null,
    null, '', v_req.note, v_now
  );

  update public.linked_transaction_requests
     set status = 'accepted',
         responded_at = v_now,
         requester_loan_id = v_requester_loan_id,
         responder_loan_id = v_responder_loan_id,
         requester_txn_id  = v_requester_txn_id,
         responder_txn_id  = v_responder_txn_id
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

-- 4. RPC: reject_linked_request(request_id, reason?)
create or replace function public.reject_linked_request(request_id text, reason text default null)
returns public.linked_transaction_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req public.linked_transaction_requests;
begin
  select * into v_req
    from public.linked_transaction_requests
   where id = request_id
   for update;
  if not found then raise exception 'ltr: request not found'; end if;
  if v_req.status <> 'pending' then return v_req; end if;
  if v_req.to_user_id <> auth.uid() then
    raise exception 'ltr: only the target user can reject';
  end if;

  update public.linked_transaction_requests
     set status = 'rejected',
         rejection_reason = reason,
         responded_at = now()
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

-- 5. RPC: cancel_linked_request(request_id)
create or replace function public.cancel_linked_request(request_id text)
returns public.linked_transaction_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req public.linked_transaction_requests;
begin
  select * into v_req
    from public.linked_transaction_requests
   where id = request_id
   for update;
  if not found then raise exception 'ltr: request not found'; end if;
  if v_req.status <> 'pending' then return v_req; end if;
  if v_req.from_user_id <> auth.uid() then
    raise exception 'ltr: only the sender can cancel';
  end if;

  update public.linked_transaction_requests
     set status = 'cancelled',
         responded_at = now()
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

revoke all on function public.accept_linked_request(text)  from public;
revoke all on function public.reject_linked_request(text, text) from public;
revoke all on function public.cancel_linked_request(text)  from public;
grant execute on function public.accept_linked_request(text)  to authenticated;
grant execute on function public.reject_linked_request(text, text) to authenticated;
grant execute on function public.cancel_linked_request(text)  to authenticated;
