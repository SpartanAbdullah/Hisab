-- ═══════════════════════════════════════════════════════════════════════════
-- Cross-user account effects: money lands in / leaves real accounts
-- ═══════════════════════════════════════════════════════════════════════════
-- Until now the cross-user flow was ledger-only everywhere except the
-- settlement sender's Phase 2C-B opt-in:
--
--   · A linked LOAN request never touched an account on either side — the
--     sender's chosen account was silently ignored, so Full Money Tracker
--     balances drifted from reality the moment a linked loan was accepted.
--   · An accepted SETTLEMENT debited/credited the sender's opted-in account
--     but the receiver's side was hardcoded ledger-only.
--
-- This migration completes the model. Each side's account choice affects
-- ONLY their own books:
--
--   1. linked_transaction_requests grows requester_account_id (sender picks
--      at send time) and responder_account_id (receiver picks at accept).
--   2. linked_settlement_requests grows responder_account_id (receiver picks
--      at accept; requester_account_id already existed).
--   3. accept_linked_request / accept_settlement_request gain an optional
--      responder_account_id parameter and apply BOTH sides' balance effects
--      atomically with the mirrored rows.
--
-- Null account anywhere ⇒ that side stays ledger-only (simple-mode users and
-- "record only" choices). Per the Phase 2C-B trim precedent there is NO
-- balance-sufficiency check — users record reality; negatives are permitted.
--
-- Past-record syncs (pre_existing_loan_id set) stay ledger-only on BOTH
-- sides: that money moved before the contact was linked, so applying it to a
-- balance now would double-count.
--
-- Deployed-client compatibility: the one-arg accept RPCs are DROPPED and
-- recreated with a defaulted second parameter. PostgREST resolves an
-- {request_id}-only call against the defaulted signature, so older app
-- versions keep working (keeping both signatures would instead make that
-- call ambiguous and fail with a 300).
--
-- Idempotent — safe to re-run.
-- Apply AFTER supabase-migration-settlement-emi-and-account-guards.sql.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Columns ─────────────────────────────────────────────────────────────

alter table public.linked_transaction_requests
  add column if not exists requester_account_id text;
alter table public.linked_transaction_requests
  add column if not exists responder_account_id text;

alter table public.linked_settlement_requests
  add column if not exists responder_account_id text;

-- ── 2. Insert trigger: validate the sender's opted-in account ──────────────
-- Phase 2D body preserved; new: requester_account_id must be the sender's
-- own live account in the request currency, and is forbidden on past-record
-- syncs. responder_account_id is force-cleared — it belongs to accept time.

create or replace function public.tg_ltr_validate_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_linked uuid;
  v_loan_owner uuid;
  v_loan_person text;
  v_loan_status text;
  v_loan_type text;
  v_acct public.accounts;
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

  -- Pre-existing loan path: extra invariants (Phase 2D, unchanged).
  if new.pre_existing_loan_id is not null then
    select l.user_id, l.person_id, l.status, l.type
      into v_loan_owner, v_loan_person, v_loan_status, v_loan_type
      from public.loans l
     where l.id = new.pre_existing_loan_id;
    if v_loan_owner is null then
      raise exception 'ltr: pre_existing_loan_id not found';
    end if;
    if v_loan_owner <> new.from_user_id then
      raise exception 'ltr: caller does not own pre_existing loan';
    end if;
    if v_loan_person is distinct from new.person_id then
      raise exception 'ltr: pre_existing loan person_id mismatch';
    end if;
    if v_loan_status <> 'active' then
      raise exception 'ltr: pre_existing loan must be active to sync';
    end if;
    if (new.kind = 'lent'    and v_loan_type <> 'given') or
       (new.kind = 'borrowed' and v_loan_type <> 'taken') then
      raise exception 'ltr: kind/loan-type mismatch on sync request';
    end if;
    -- The synced money moved before linking — a balance effect now would
    -- double-count it.
    if new.requester_account_id is not null then
      raise exception 'ltr: past-record sync is ledger-only';
    end if;
  end if;

  -- NEW: sender-side opted-in account.
  if new.requester_account_id is not null then
    select * into v_acct
      from public.accounts
     where id = new.requester_account_id
     for share;
    if not found then
      raise exception 'ltr: requester account not found';
    end if;
    if v_acct.user_id <> new.from_user_id then
      raise exception 'ltr: requester account not owned';
    end if;
    if v_acct.deleted_at is not null then
      raise exception 'ltr: requester account was deleted';
    end if;
    if v_acct.currency <> new.currency then
      raise exception 'ltr: requester account currency mismatch';
    end if;
  end if;

  -- Force clean initial state even if the client tries to pre-set.
  new.status := 'pending';
  new.rejection_reason := null;
  new.responded_at := null;
  new.requester_loan_id := null;
  new.responder_loan_id := null;
  new.requester_txn_id := null;
  new.responder_txn_id := null;
  new.responder_account_id := null;
  return new;
end $$;

-- ── 3. accept_linked_request: both sides' balance effects ──────────────────
-- Phase 2D body preserved (loan reuse, receiver person find-or-create).
-- New: optional responder_account_id parameter; account validation mirrors
-- the settlement RPC (owned + live + currency, raise loudly otherwise);
-- transactions carry the account ids and balances move in the same
-- database transaction as the mirrored rows.
--
-- Direction map (loan txns follow the client convention: loan_given spends
-- from source_account_id, loan_taken receives into destination_account_id):
--   kind='lent'      sender loan_given  −amount │ receiver loan_taken +amount
--   kind='borrowed'  sender loan_taken  +amount │ receiver loan_given −amount

drop function if exists public.accept_linked_request(text);

create or replace function public.accept_linked_request(
  request_id text,
  responder_account_id text default null
)
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
  v_loan_status          text;
  v_r_acct               public.accounts;
  v_p_acct               public.accounts;
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

  -- Past-record syncs are ledger-only on both sides (see trigger).
  if v_req.pre_existing_loan_id is not null and responder_account_id is not null then
    raise exception 'ltr: past-record sync is ledger-only';
  end if;

  -- Sender-side opted-in account: re-validate at accept time. Raising here
  -- (rather than silently downgrading to ledger-only) follows the
  -- settlement precedent — the sender must cancel and resend rather than
  -- have their stated account effect silently dropped.
  if v_req.requester_account_id is not null then
    select * into v_r_acct
      from public.accounts
     where id = v_req.requester_account_id
     for update;
    if not found then
      raise exception 'ltr: requester account not found';
    end if;
    if v_r_acct.user_id <> v_req.from_user_id then
      raise exception 'ltr: requester account not owned';
    end if;
    if v_r_acct.deleted_at is not null then
      raise exception 'ltr: requester account was deleted';
    end if;
    if v_r_acct.currency <> v_req.currency then
      raise exception 'ltr: requester account currency mismatch';
    end if;
  end if;

  -- Receiver-side account: the acceptor just picked it, so any failure is
  -- immediate feedback, not a bricked request.
  if responder_account_id is not null then
    select * into v_p_acct
      from public.accounts
     where id = responder_account_id
     for update;
    if not found then
      raise exception 'ltr: responder account not found';
    end if;
    if v_p_acct.user_id <> v_req.to_user_id then
      raise exception 'ltr: responder account not owned';
    end if;
    if v_p_acct.deleted_at is not null then
      raise exception 'ltr: responder account was deleted';
    end if;
    if v_p_acct.currency <> v_req.currency then
      raise exception 'ltr: responder account currency mismatch';
    end if;
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

  -- Sender + receiver display-name cache.
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

  -- Receiver-side mirror IDs (always fresh).
  v_responder_loan_id := gen_random_uuid()::text;
  v_responder_txn_id  := gen_random_uuid()::text;

  if v_req.pre_existing_loan_id is null then
    -- ─── Fresh-loan path: brand-new loan on both sides ───
    v_requester_loan_id := gen_random_uuid()::text;
    v_requester_txn_id  := gen_random_uuid()::text;

    insert into public.loans(
      id, user_id, person_name, person_id, type,
      total_amount, remaining_amount, currency, status, notes, created_at
    ) values (
      v_requester_loan_id, v_req.from_user_id,
      coalesce(v_sender_person_name, v_to_name), v_sender_person_id, v_requester_loan_type,
      v_req.amount, v_req.amount, v_req.currency, 'active', v_req.note, v_now
    );

    -- Sender-side mirrored transaction, now carrying the opted-in account.
    insert into public.transactions(
      id, user_id, type, amount, currency,
      source_account_id, destination_account_id,
      related_person, person_id, related_loan_id, related_goal_id,
      conversion_rate, category, notes, created_at
    ) values (
      v_requester_txn_id, v_req.from_user_id, v_requester_txn_type, v_req.amount, v_req.currency,
      case when v_requester_txn_type = 'loan_given' then v_req.requester_account_id else null end,
      case when v_requester_txn_type = 'loan_taken' then v_req.requester_account_id else null end,
      coalesce(v_sender_person_name, v_to_name), v_sender_person_id, v_requester_loan_id, null,
      null, '', v_req.note, v_now
    );

    -- Sender balance: lent = money left, borrowed = money arrived.
    if v_req.requester_account_id is not null then
      update public.accounts
         set balance = balance + case when v_req.kind = 'lent' then -v_req.amount else v_req.amount end
       where id = v_req.requester_account_id
         and user_id = v_req.from_user_id
         and deleted_at is null;
    end if;
  else
    -- ─── Past-record sync path: reuse sender-side loan + transaction ───
    select status into v_loan_status
      from public.loans
     where id = v_req.pre_existing_loan_id
       and user_id = v_req.from_user_id;
    if v_loan_status is null then
      raise exception 'ltr: pre_existing loan no longer available';
    end if;
    if v_loan_status <> 'active' then
      raise exception 'ltr: pre_existing loan has been settled or archived';
    end if;

    v_requester_loan_id := v_req.pre_existing_loan_id;

    select id into v_requester_txn_id
      from public.transactions
     where related_loan_id = v_requester_loan_id
       and user_id = v_req.from_user_id
       and type in ('loan_given', 'loan_taken')
     order by created_at asc
     limit 1;
  end if;

  -- Receiver-side mirrored loan.
  insert into public.loans(
    id, user_id, person_name, person_id, type,
    total_amount, remaining_amount, currency, status, notes, created_at
  ) values (
    v_responder_loan_id, v_req.to_user_id,
    v_from_name, v_receiver_person_id, v_responder_loan_type,
    v_req.amount, v_req.amount, v_req.currency, 'active', v_req.note, v_now
  );

  -- Receiver-side mirrored transaction, carrying the acceptor's account.
  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_responder_txn_id, v_req.to_user_id, v_responder_txn_type, v_req.amount, v_req.currency,
    case when v_responder_txn_type = 'loan_given' then responder_account_id else null end,
    case when v_responder_txn_type = 'loan_taken' then responder_account_id else null end,
    v_from_name, v_receiver_person_id, v_responder_loan_id, null,
    null, '', v_req.note, v_now
  );

  -- Receiver balance: they accepted "borrowed" = money arrived; accepted
  -- "they borrowed from me" = money left.
  if responder_account_id is not null then
    update public.accounts
       set balance = balance + case when v_responder_txn_type = 'loan_taken' then v_req.amount else -v_req.amount end
     where id = responder_account_id
       and user_id = v_req.to_user_id
       and deleted_at is null;
  end if;

  update public.linked_transaction_requests
     set status = 'accepted',
         responded_at = v_now,
         requester_loan_id = v_requester_loan_id,
         responder_loan_id = v_responder_loan_id,
         requester_txn_id  = v_requester_txn_id,
         responder_txn_id  = v_responder_txn_id,
         responder_account_id = accept_linked_request.responder_account_id
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

-- ── 4. accept_settlement_request: receiver-side landing account ────────────
-- Base = supabase-migration-settlement-emi-and-account-guards.sql (EMI sync
-- + tombstone guard), preserved verbatim. New: optional responder_account_id
-- parameter validated like the requester's, applied to the receiver's
-- mirrored repayment txn and balance.
--
-- Direction map (repayments): a debtor's money leaves (source, −amount);
-- a creditor's money arrives (destination, +amount) — each side judged by
-- their OWN loan type.

drop function if exists public.accept_settlement_request(text);

create or replace function public.accept_settlement_request(
  request_id text,
  responder_account_id text default null
)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req      public.linked_settlement_requests;
  v_r_loan   public.loans;
  v_p_loan   public.loans;
  v_r_acct   public.accounts;
  v_p_acct   public.accounts;
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
  if v_r_loan.type = v_p_loan.type then
    raise exception 'lsr: linked loan directions are invalid';
  end if;

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
    if v_r_acct.deleted_at is not null then
      raise exception 'lsr: requester account was deleted';
    end if;
    if v_r_acct.currency <> v_req.currency then
      raise exception 'lsr: requester account currency mismatch';
    end if;
  end if;

  -- NEW: receiver-side landing account.
  if responder_account_id is not null then
    select * into v_p_acct
      from public.accounts
     where id = responder_account_id
     for update;
    if not found then
      raise exception 'lsr: responder account not found';
    end if;
    if v_p_acct.user_id <> v_req.to_user_id then
      raise exception 'lsr: responder account not owned';
    end if;
    if v_p_acct.deleted_at is not null then
      raise exception 'lsr: responder account was deleted';
    end if;
    if v_p_acct.currency <> v_req.currency then
      raise exception 'lsr: responder account currency mismatch';
    end if;
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

  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_req_txn_id, v_req.from_user_id, 'repayment', v_req.amount, v_req.currency,
    case when v_r_loan.type = 'taken' then v_req.requester_account_id else null end,
    case when v_r_loan.type = 'given' then v_req.requester_account_id else null end,
    v_to_name, v_sender_person_id, v_r_loan.id, null,
    null, '', v_req.note, v_now
  );

  -- Receiver's mirrored repayment, now carrying their landing account.
  insert into public.transactions(
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at
  ) values (
    v_res_txn_id, v_req.to_user_id, 'repayment', v_req.amount, v_req.currency,
    case when v_p_loan.type = 'taken' then responder_account_id else null end,
    case when v_p_loan.type = 'given' then responder_account_id else null end,
    v_from_name, v_receiver_person_id, v_p_loan.id, null,
    null, '', v_req.note, v_now
  );

  if v_req.requester_account_id is not null then
    update public.accounts
       set balance = balance + case when v_r_loan.type = 'given' then v_req.amount else -v_req.amount end
     where id = v_req.requester_account_id
       and user_id = v_req.from_user_id
       and deleted_at is null;
  end if;

  -- NEW: receiver balance — creditor receives (+), debtor pays (−).
  if responder_account_id is not null then
    update public.accounts
       set balance = balance + case when v_p_loan.type = 'given' then v_req.amount else -v_req.amount end
     where id = responder_account_id
       and user_id = v_req.to_user_id
       and deleted_at is null;
  end if;

  v_new_remaining := v_r_loan.remaining_amount - v_req.amount;
  v_new_status := case when v_new_remaining <= 0.00001 then 'settled' else 'active' end;
  update public.loans
     set remaining_amount = greatest(0, v_new_remaining),
         status = v_new_status
   where id = v_r_loan.id;

  -- Requester's EMI schedule follows the money (unchanged).
  update public.emi_schedules e
     set status = 'paid'
    from (
      select id,
             sum(amount) over (order by installment_number asc, id asc) as cum
        from public.emi_schedules
       where loan_id = v_r_loan.id
         and user_id = v_req.from_user_id
    ) c
   where e.id = c.id
     and e.loan_id = v_r_loan.id
     and e.user_id = v_req.from_user_id
     and e.status <> 'paid'
     and c.cum <= (v_r_loan.total_amount - greatest(0, v_r_loan.remaining_amount - v_req.amount)) + 0.00001;

  v_new_remaining := v_p_loan.remaining_amount - v_req.amount;
  v_new_status := case when v_new_remaining <= 0.00001 then 'settled' else 'active' end;
  update public.loans
     set remaining_amount = greatest(0, v_new_remaining),
         status = v_new_status
   where id = v_p_loan.id;

  -- Responder's schedule too (unchanged).
  update public.emi_schedules e
     set status = 'paid'
    from (
      select id,
             sum(amount) over (order by installment_number asc, id asc) as cum
        from public.emi_schedules
       where loan_id = v_p_loan.id
         and user_id = v_req.to_user_id
    ) c
   where e.id = c.id
     and e.loan_id = v_p_loan.id
     and e.user_id = v_req.to_user_id
     and e.status <> 'paid'
     and c.cum <= (v_p_loan.total_amount - greatest(0, v_p_loan.remaining_amount - v_req.amount)) + 0.00001;

  update public.linked_settlement_requests
     set status = 'accepted',
         responded_at = v_now,
         requester_txn_id = v_req_txn_id,
         responder_txn_id = v_res_txn_id,
         responder_account_id = accept_settlement_request.responder_account_id
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

-- ── 5. Grants ──────────────────────────────────────────────────────────────

revoke all on function public.accept_linked_request(text, text) from public, anon;
grant execute on function public.accept_linked_request(text, text) to authenticated;

revoke all on function public.accept_settlement_request(text, text) from public, anon;
grant execute on function public.accept_settlement_request(text, text) to authenticated;
