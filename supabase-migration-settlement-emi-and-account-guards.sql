-- ═══════════════════════════════════════════════════════════════════════════
-- Settlement RPC: EMI schedules follow the money + deleted-account guard
-- ═══════════════════════════════════════════════════════════════════════════
-- Two long-standing gaps in accept_settlement_request (live version from
-- supabase-migration-fix-bidirectional-linked-settlements.sql):
--
--   1. It decremented both loans but NEVER touched emi_schedules, so a
--      settlement accepted by the other user left instalments showing unpaid
--      ("the schedule desync") on BOTH sides. The client's reconcile banner
--      was the only recovery. Now the RPC marks the oldest fully-covered
--      instalments paid for each side, using the exact client coverage rule
--      (src/lib/emiCoverage.ts): cumulative oldest-first walk, an instalment
--      is covered iff its running total fits inside the paid-down amount,
--      epsilon 0.00001. Already-paid rows still count toward the total.
--
--   2. It would happily debit/credit a SOFT-DELETED account (accounts are
--      tombstoned via deleted_at) — an invisible balance mutation the client
--      can neither see nor undo. Accepting now fails loudly instead.
--
-- Idempotent — safe to re-run.
-- Apply AFTER supabase-migration-fix-bidirectional-linked-settlements.sql.
-- ═══════════════════════════════════════════════════════════════════════════

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
    -- NEW: a tombstoned account must never silently absorb a balance change.
    if v_r_acct.deleted_at is not null then
      raise exception 'lsr: requester account was deleted';
    end if;
    if v_r_acct.currency <> v_req.currency then
      raise exception 'lsr: requester account currency mismatch';
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

  if v_req.requester_account_id is not null then
    update public.accounts
       set balance = balance + case when v_r_loan.type = 'given' then v_req.amount else -v_req.amount end
     where id = v_req.requester_account_id
       and user_id = v_req.from_user_id
       and deleted_at is null;
  end if;

  v_new_remaining := v_r_loan.remaining_amount - v_req.amount;
  v_new_status := case when v_new_remaining <= 0.00001 then 'settled' else 'active' end;
  update public.loans
     set remaining_amount = greatest(0, v_new_remaining),
         status = v_new_status
   where id = v_r_loan.id;

  -- NEW: the requester's EMI schedule follows the money. Mark the oldest
  -- instalments now fully covered by (total - new remaining) as paid —
  -- same cumulative rule and epsilon as the client (src/lib/emiCoverage.ts).
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

  -- NEW: same for the responder's schedule.
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
         responder_txn_id = v_res_txn_id
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

revoke all on function public.accept_settlement_request(text) from public, anon;
grant execute on function public.accept_settlement_request(text) to authenticated;
