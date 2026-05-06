-- Fix linked settlement request creation for valid linked users.
--
-- The insert validator must inspect both mirrored loan rows. With normal
-- invoker privileges, loan RLS hides the counterparty's loan from the sender,
-- so valid settlement requests can fail with "responder loan not found" and
-- the app shows the generic "Could not send the settlement" message.
--
-- SECURITY DEFINER lets the validator read the mirrored rows while the
-- auth.uid() checks below still ensure only the signed-in sender can create
-- their own settlement request.
create or replace function public.tg_lsr_validate_insert() returns trigger
language plpgsql security definer set search_path = public as $$
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

  new.status := 'pending';
  new.rejection_reason := null;
  new.responded_at := null;
  new.requester_txn_id := null;
  new.responder_txn_id := null;
  return new;
end $$;
