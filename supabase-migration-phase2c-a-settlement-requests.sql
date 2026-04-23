-- ═══════════════════════════════════════════════════════════
-- Phase 2C-A: linked_settlement_requests (ledger-only).
-- No account balance movement. No account columns. No currency
-- validation against accounts.
-- ═══════════════════════════════════════════════════════════

-- 1. Add loan_pair_id to linked_transaction_requests.
alter table public.linked_transaction_requests
  add column if not exists loan_pair_id text;

-- One-shot backfill: for already-accepted 2B rows, the pair key is the
-- request id itself. Idempotent (only touches rows that still need it).
update public.linked_transaction_requests
   set loan_pair_id = id
 where status = 'accepted'
   and loan_pair_id is null;

-- Patch accept_linked_request so all new acceptances also set loan_pair_id.
-- Body is otherwise byte-for-byte identical to Phase 2B's definition.
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

  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_from_name
    from public.profiles p where p.id = v_req.from_user_id;
  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_to_name
    from public.profiles p where p.id = v_req.to_user_id;

  select p.id, coalesce(nullif(trim(p.name), ''), v_to_name)
    into v_sender_person_id, v_sender_person_name
    from public.persons p
   where p.id = v_req.person_id
     and p.user_id = v_req.from_user_id;

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

  v_requester_loan_id := gen_random_uuid()::text;
  v_responder_loan_id := gen_random_uuid()::text;
  v_requester_txn_id  := gen_random_uuid()::text;
  v_responder_txn_id  := gen_random_uuid()::text;

  insert into public.loans(
    id, user_id, person_name, person_id, type,
    total_amount, remaining_amount, currency, status, notes, created_at
  ) values (
    v_requester_loan_id, v_req.from_user_id,
    coalesce(v_sender_person_name, v_to_name), v_sender_person_id, v_requester_loan_type,
    v_req.amount, v_req.amount, v_req.currency, 'active', v_req.note, v_now
  );

  insert into public.loans(
    id, user_id, person_name, person_id, type,
    total_amount, remaining_amount, currency, status, notes, created_at
  ) values (
    v_responder_loan_id, v_req.to_user_id,
    v_from_name, v_receiver_person_id, v_responder_loan_type,
    v_req.amount, v_req.amount, v_req.currency, 'active', v_req.note, v_now
  );

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
         loan_pair_id = request_id,
         requester_loan_id = v_requester_loan_id,
         responder_loan_id = v_responder_loan_id,
         requester_txn_id  = v_requester_txn_id,
         responder_txn_id  = v_responder_txn_id
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

-- 2. New table: linked_settlement_requests.
create table if not exists public.linked_settlement_requests (
  id                   text primary key,
  loan_pair_id         text not null,
  requester_loan_id    text not null references public.loans(id) on delete cascade,
  responder_loan_id    text not null references public.loans(id) on delete cascade,
  from_user_id         uuid not null references auth.users(id) on delete cascade,
  to_user_id           uuid not null references auth.users(id) on delete cascade,
  amount               numeric not null check (amount > 0),
  currency             text not null check (currency in ('AED','PKR')),
  note                 text not null default '',
  status               text not null default 'pending'
                         check (status in ('pending','accepted','rejected','cancelled')),
  rejection_reason     text,
  requester_txn_id     text,
  responder_txn_id     text,
  created_at           timestamptz not null default now(),
  responded_at         timestamptz,
  constraint lsr_different_parties check (from_user_id <> to_user_id)
);

create index if not exists idx_lsr_to_pending
  on public.linked_settlement_requests(to_user_id, created_at desc)
  where status = 'pending';
create index if not exists idx_lsr_from_pending
  on public.linked_settlement_requests(from_user_id, created_at desc)
  where status = 'pending';
create index if not exists idx_lsr_pair
  on public.linked_settlement_requests(loan_pair_id);

alter table public.linked_settlement_requests enable row level security;

drop policy if exists lsr_select_participant on public.linked_settlement_requests;
create policy lsr_select_participant on public.linked_settlement_requests
  for select using (from_user_id = auth.uid() or to_user_id = auth.uid());

drop policy if exists lsr_insert_own on public.linked_settlement_requests;
create policy lsr_insert_own on public.linked_settlement_requests
  for insert with check (from_user_id = auth.uid());

-- 3. Insert-time invariants.
--    - caller is sender
--    - sender != receiver
--    - both loan ids exist, share the same loan_pair_id, belong to the
--      stated users (one to sender, one to receiver)
--    - both loans are active
--    - both currencies match; request currency == loans' currency
--    - amount > 0 and <= sender-side remaining at this moment
--    - direction: only the debtor can initiate. Sender's local loan must
--      have type='taken' (they owe and are repaying).
--    - force clean initial state
create or replace function public.tg_lsr_validate_insert() returns trigger
language plpgsql as $$
declare
  v_r_loan public.loans;
  v_p_loan public.loans;
  v_r_pair text;
  v_p_pair text;
begin
  if new.from_user_id <> auth.uid() then
    raise exception 'lsr: from_user_id must be caller';
  end if;
  if new.from_user_id = new.to_user_id then
    raise exception 'lsr: self-settlement not allowed';
  end if;

  select * into v_r_loan from public.loans where id = new.requester_loan_id;
  if not found then
    raise exception 'lsr: requester loan not found';
  end if;
  if v_r_loan.user_id <> new.from_user_id then
    raise exception 'lsr: requester loan does not belong to sender';
  end if;

  select * into v_p_loan from public.loans where id = new.responder_loan_id;
  if not found then
    raise exception 'lsr: responder loan not found';
  end if;
  if v_p_loan.user_id <> new.to_user_id then
    raise exception 'lsr: responder loan does not belong to receiver';
  end if;

  -- Both loans must be derived from the same accepted linked_transaction_request.
  select ltr.id into v_r_pair
    from public.linked_transaction_requests ltr
   where ltr.status = 'accepted'
     and (ltr.requester_loan_id = v_r_loan.id or ltr.responder_loan_id = v_r_loan.id);
  select ltr.id into v_p_pair
    from public.linked_transaction_requests ltr
   where ltr.status = 'accepted'
     and (ltr.requester_loan_id = v_p_loan.id or ltr.responder_loan_id = v_p_loan.id);
  if v_r_pair is null or v_p_pair is null or v_r_pair <> v_p_pair then
    raise exception 'lsr: loans do not share the same linked pair';
  end if;
  if new.loan_pair_id <> v_r_pair then
    raise exception 'lsr: loan_pair_id does not match the loans';
  end if;

  if v_r_loan.status <> 'active' or v_p_loan.status <> 'active' then
    raise exception 'lsr: both loans must be active';
  end if;
  if v_r_loan.currency <> v_p_loan.currency or new.currency <> v_r_loan.currency then
    raise exception 'lsr: currency mismatch';
  end if;
  if new.amount > v_r_loan.remaining_amount then
    raise exception 'lsr: amount exceeds remaining';
  end if;

  -- Direction: only the debtor (type='taken') may initiate a settlement.
  if v_r_loan.type <> 'taken' then
    raise exception 'lsr: only the debtor may initiate a settlement';
  end if;

  -- Force clean initial state.
  new.status := 'pending';
  new.rejection_reason := null;
  new.responded_at := null;
  new.requester_txn_id := null;
  new.responder_txn_id := null;
  return new;
end $$;

drop trigger if exists lsr_validate_insert on public.linked_settlement_requests;
create trigger lsr_validate_insert before insert on public.linked_settlement_requests
for each row execute function public.tg_lsr_validate_insert();

-- 4. RPC: accept_settlement_request(request_id)
--    Ledger-only. Writes two repayment transactions with null account ids,
--    decrements remaining_amount on both loans, flips status='settled' when
--    zero. Idempotent on terminal states.
create or replace function public.accept_settlement_request(request_id text)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req      public.linked_settlement_requests;
  v_r_loan   public.loans;
  v_p_loan   public.loans;
  v_from_name text;
  v_to_name   text;
  v_sender_person_id   text;
  v_receiver_person_id text;
  v_req_txn_id text;
  v_res_txn_id text;
  v_now timestamptz := now();
  v_new_remaining numeric;
  v_new_status text;
begin
  select * into v_req
    from public.linked_settlement_requests
   where id = request_id
   for update;
  if not found then
    raise exception 'lsr: request not found';
  end if;
  if v_req.status <> 'pending' then
    return v_req;
  end if;
  if v_req.to_user_id <> auth.uid() then
    raise exception 'lsr: only the target user can accept';
  end if;

  -- Lock both loans and re-validate.
  select * into v_r_loan from public.loans where id = v_req.requester_loan_id for update;
  if not found or v_r_loan.user_id <> v_req.from_user_id then
    raise exception 'lsr: requester loan missing or reassigned';
  end if;
  select * into v_p_loan from public.loans where id = v_req.responder_loan_id for update;
  if not found or v_p_loan.user_id <> v_req.to_user_id then
    raise exception 'lsr: responder loan missing or reassigned';
  end if;
  if v_r_loan.status <> 'active' or v_p_loan.status <> 'active' then
    raise exception 'lsr: loan is no longer active';
  end if;
  if v_r_loan.currency <> v_req.currency or v_p_loan.currency <> v_req.currency then
    raise exception 'lsr: currency mismatch at accept';
  end if;
  if v_req.amount > v_r_loan.remaining_amount or v_req.amount > v_p_loan.remaining_amount then
    raise exception 'lsr: amount exceeds remaining on one side';
  end if;

  -- Display names and person rows for the mirrored repayment txns.
  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_from_name
    from public.profiles p where p.id = v_req.from_user_id;
  select coalesce(nullif(trim(p.name), ''), 'Hisaab user') into v_to_name
    from public.profiles p where p.id = v_req.to_user_id;

  select p.id into v_sender_person_id
    from public.persons p
   where p.user_id = v_req.from_user_id
     and p.linked_profile_id = v_req.to_user_id
   limit 1;

  select p.id into v_receiver_person_id
    from public.persons p
   where p.user_id = v_req.to_user_id
     and p.linked_profile_id = v_req.from_user_id
   limit 1;

  v_req_txn_id := gen_random_uuid()::text;
  v_res_txn_id := gen_random_uuid()::text;

  -- Sender (debtor) repayment mirror. account ids are null on purpose.
  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_req_txn_id, v_req.from_user_id, 'repayment', v_req.amount, v_req.currency,
    null, null,
    v_to_name, v_sender_person_id, v_r_loan.id, null,
    null, '', v_req.note, v_now
  );

  -- Receiver (creditor) repayment mirror.
  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_res_txn_id, v_req.to_user_id, 'repayment', v_req.amount, v_req.currency,
    null, null,
    v_from_name, v_receiver_person_id, v_p_loan.id, null,
    null, '', v_req.note, v_now
  );

  -- Decrement remaining on both sides, flip to settled when zero.
  v_new_remaining := v_r_loan.remaining_amount - v_req.amount;
  v_new_status := case when v_new_remaining <= 0.00001 then 'settled' else 'active' end;
  update public.loans
     set remaining_amount = greatest(0, v_new_remaining),
         status = v_new_status
   where id = v_r_loan.id;

  v_new_remaining := v_p_loan.remaining_amount - v_req.amount;
  v_new_status := case when v_new_remaining <= 0.00001 then 'settled' else 'active' end;
  update public.loans
     set remaining_amount = greatest(0, v_new_remaining),
         status = v_new_status
   where id = v_p_loan.id;

  update public.linked_settlement_requests
     set status = 'accepted',
         responded_at = v_now,
         requester_txn_id = v_req_txn_id,
         responder_txn_id = v_res_txn_id
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

-- 5. RPC: reject_settlement_request(request_id, reason?)
create or replace function public.reject_settlement_request(request_id text, reason text default null)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req public.linked_settlement_requests;
begin
  select * into v_req
    from public.linked_settlement_requests
   where id = request_id
   for update;
  if not found then raise exception 'lsr: request not found'; end if;
  if v_req.status <> 'pending' then return v_req; end if;
  if v_req.to_user_id <> auth.uid() then
    raise exception 'lsr: only the target user can reject';
  end if;

  update public.linked_settlement_requests
     set status = 'rejected',
         rejection_reason = reason,
         responded_at = now()
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

-- 6. RPC: cancel_settlement_request(request_id)
create or replace function public.cancel_settlement_request(request_id text)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req public.linked_settlement_requests;
begin
  select * into v_req
    from public.linked_settlement_requests
   where id = request_id
   for update;
  if not found then raise exception 'lsr: request not found'; end if;
  if v_req.status <> 'pending' then return v_req; end if;
  if v_req.from_user_id <> auth.uid() then
    raise exception 'lsr: only the sender can cancel';
  end if;

  update public.linked_settlement_requests
     set status = 'cancelled',
         responded_at = now()
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

revoke all on function public.accept_settlement_request(text) from public;
revoke all on function public.reject_settlement_request(text, text) from public;
revoke all on function public.cancel_settlement_request(text) from public;
grant execute on function public.accept_settlement_request(text) to authenticated;
grant execute on function public.reject_settlement_request(text, text) to authenticated;
grant execute on function public.cancel_settlement_request(text) to authenticated;
