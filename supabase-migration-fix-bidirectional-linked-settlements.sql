-- Allow either side of a linked loan to initiate a settlement request.
--
-- Previous behavior only allowed the debtor-side mirrored loan
-- (type = 'taken') to create linked_settlement_requests. That left the
-- creditor with no repayment action in the app. This keeps the confirmation
-- workflow intact: sender proposes, counterparty accepts, then both mirrored
-- loans receive repayment transactions.

alter table public.linked_transaction_requests
  add column if not exists loan_pair_id text;

update public.linked_transaction_requests
   set loan_pair_id = id
 where status = 'accepted'
   and loan_pair_id is null;

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
  requester_account_id text,
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

alter table public.linked_settlement_requests
  add column if not exists requester_account_id text;

drop policy if exists lsr_select_participant on public.linked_settlement_requests;
create policy lsr_select_participant on public.linked_settlement_requests
  for select using (from_user_id = auth.uid() or to_user_id = auth.uid());

-- New app versions create requests through the RPC below; currently deployed
-- app versions may still use a raw table insert, so keep that path valid too.
drop trigger if exists lsr_validate_insert on public.linked_settlement_requests;

drop policy if exists lsr_insert_own on public.linked_settlement_requests;
drop policy if exists lsr_insert_via_rpc_only on public.linked_settlement_requests;
create policy lsr_insert_own on public.linked_settlement_requests
  for insert with check (from_user_id = auth.uid());

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
  if new.amount > v_r_loan.remaining_amount or new.amount > v_p_loan.remaining_amount then
    raise exception 'lsr: amount exceeds remaining';
  end if;
  if v_r_loan.type = v_p_loan.type then
    raise exception 'lsr: linked loan directions are invalid';
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

create trigger lsr_validate_insert before insert on public.linked_settlement_requests
for each row execute function public.tg_lsr_validate_insert();

create or replace function public.create_settlement_request(
  request_id text,
  loan_pair_id text,
  requester_loan_id text,
  responder_loan_id text,
  to_user_id uuid,
  amount numeric,
  currency text,
  note text default '',
  requester_account_id text default null
)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req public.linked_settlement_requests;
  v_r_loan public.loans;
  v_p_loan public.loans;
  v_r_pair text;
  v_p_pair text;
  v_acct public.accounts;
  v_from_user_id uuid := auth.uid();
begin
  if v_from_user_id is null then
    raise exception 'lsr: not authenticated';
  end if;
  if v_from_user_id = to_user_id then
    raise exception 'lsr: self-settlement not allowed';
  end if;

  select * into v_r_loan from public.loans where id = requester_loan_id;
  if not found then
    raise exception 'lsr: requester loan not found';
  end if;
  if v_r_loan.user_id <> v_from_user_id then
    raise exception 'lsr: requester loan does not belong to sender';
  end if;

  select * into v_p_loan from public.loans where id = responder_loan_id;
  if not found then
    raise exception 'lsr: responder loan not found';
  end if;
  if v_p_loan.user_id <> to_user_id then
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
  if loan_pair_id <> v_r_pair then
    raise exception 'lsr: loan_pair_id does not match the loans';
  end if;
  if v_r_loan.status <> 'active' or v_p_loan.status <> 'active' then
    raise exception 'lsr: both loans must be active';
  end if;
  if v_r_loan.currency <> v_p_loan.currency or currency <> v_r_loan.currency then
    raise exception 'lsr: currency mismatch';
  end if;
  if amount <= 0 then
    raise exception 'lsr: amount must be positive';
  end if;
  if amount > v_r_loan.remaining_amount or amount > v_p_loan.remaining_amount then
    raise exception 'lsr: amount exceeds remaining';
  end if;
  if v_r_loan.type = v_p_loan.type then
    raise exception 'lsr: linked loan directions are invalid';
  end if;

  if requester_account_id is not null then
    select * into v_acct
      from public.accounts
     where id = requester_account_id;
    if not found then
      raise exception 'lsr: requester account not found';
    end if;
    if v_acct.user_id <> v_from_user_id then
      raise exception 'lsr: requester account not owned';
    end if;
    if v_acct.currency <> currency then
      raise exception 'lsr: requester account currency mismatch';
    end if;
  end if;

  insert into public.linked_settlement_requests(
    id, loan_pair_id, requester_loan_id, responder_loan_id,
    from_user_id, to_user_id, amount, currency, note, requester_account_id,
    status, rejection_reason, requester_txn_id, responder_txn_id
  ) values (
    request_id, loan_pair_id, requester_loan_id, responder_loan_id,
    v_from_user_id, to_user_id, amount, currency, coalesce(note, ''), requester_account_id,
    'pending', null, null, null
  )
  returning * into v_req;

  return v_req;
end $$;

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

grant execute on function public.accept_settlement_request(text) to authenticated;
grant execute on function public.create_settlement_request(text, text, text, text, uuid, numeric, text, text, text) to authenticated;
