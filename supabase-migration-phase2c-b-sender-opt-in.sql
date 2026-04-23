-- ═══════════════════════════════════════════════════════════
-- Phase 2C-B (Trimmed): sender-side optional apply-to-balance.
-- Only requester_account_id is introduced. No responder_account_id.
-- Receiver path is byte-identical to 2C-A.
-- ═══════════════════════════════════════════════════════════

-- 1. Column: sender's optional account to debit on accept.
alter table public.linked_settlement_requests
  add column if not exists requester_account_id text;

-- 2. Insert trigger: all 2C-A checks preserved; one new branch gates
-- requester_account_id on ownership + currency match.
create or replace function public.tg_lsr_validate_insert() returns trigger
language plpgsql as $$
declare
  v_r_loan public.loans;
  v_p_loan public.loans;
  v_r_pair text;
  v_p_pair text;
  v_acct   public.accounts;
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

  if v_r_loan.type <> 'taken' then
    raise exception 'lsr: only the debtor may initiate a settlement';
  end if;

  -- Phase 2C-B: validate sender-side opted-in account.
  if new.requester_account_id is not null then
    select * into v_acct
      from public.accounts
     where id = new.requester_account_id
     for share;
    if not found then
      raise exception 'lsr: requester account not found';
    end if;
    if v_acct.user_id <> new.from_user_id then
      raise exception 'lsr: requester account not owned';
    end if;
    if v_acct.currency <> new.currency then
      raise exception 'lsr: requester account currency mismatch';
    end if;
  end if;

  -- Force clean initial state (unchanged).
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

-- 3. accept_settlement_request(request_id text) — signature unchanged.
--    All 2C-A semantics preserved. One new conditional branch: when the
--    request row carries a non-null requester_account_id, the sender's
--    mirrored repayment transaction records source_account_id and the
--    sender's account balance is decremented in the same transaction.
--    Per the approved trim, no sender-balance sufficiency check — the
--    sender opted in knowingly; negative balances are permitted here.
create or replace function public.accept_settlement_request(request_id text)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req      public.linked_settlement_requests;
  v_r_loan   public.loans;
  v_p_loan   public.loans;
  v_r_acct   public.accounts;
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

  -- Phase 2C-B: sender-side account re-validation, only when opted in.
  if v_req.requester_account_id is not null then
    select * into v_r_acct
      from public.accounts
     where id = v_req.requester_account_id
     for update;
    if not found then
      raise exception 'lsr: requester account not found';
    end if;
    if v_r_acct.user_id <> v_req.from_user_id then
      raise exception 'lsr: requester account not owned';
    end if;
    if v_r_acct.currency <> v_req.currency then
      raise exception 'lsr: requester account currency mismatch';
    end if;
    -- Per trim: do NOT block on insufficient sender balance.
  end if;

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

  -- Sender (debtor) repayment mirror.
  --   source_account_id = opted-in account (may be null — unchanged from 2C-A)
  --   destination_account_id = null (always)
  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_req_txn_id, v_req.from_user_id, 'repayment', v_req.amount, v_req.currency,
    v_req.requester_account_id, null,
    v_to_name, v_sender_person_id, v_r_loan.id, null,
    null, '', v_req.note, v_now
  );

  -- Receiver (creditor) repayment mirror. ALWAYS ledger-only. Account ids
  -- are hardcoded null. There is no code path that can change this.
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

  -- Phase 2C-B: the ONLY accounts mutation in this RPC. Gated by
  -- requester_account_id != null. Scoped by id AND user_id so a bug
  -- elsewhere cannot target anyone else's account.
  if v_req.requester_account_id is not null then
    update public.accounts
       set balance = balance - v_req.amount
     where id = v_req.requester_account_id
       and user_id = v_req.from_user_id;
  end if;

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

-- Existing grant on accept_settlement_request(text) remains valid
-- (signature unchanged). reject_ / cancel_ RPCs are untouched.
