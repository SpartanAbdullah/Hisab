-- ═══════════════════════════════════════════════════════════
-- Phase 2D: Sync past records on link
--
-- Lets a sender share a loan that already exists on their side
-- (recorded BEFORE the contact got linked) with the now-linked
-- recipient. Reuses the existing accept_linked_request flow:
-- the new column tells the RPC "don't create a duplicate
-- sender-side loan — attach to this one instead".
-- ═══════════════════════════════════════════════════════════

-- 1. New column. NULL means "this is a fresh-loan request" (existing
-- Phase 2B behaviour). Non-NULL means "this references an already-
-- existing sender-side loan; just create the mirror on accept".
alter table public.linked_transaction_requests
  add column if not exists pre_existing_loan_id text;

-- Optional FK on the column. Set null on delete because if the sender
-- deletes the loan before the receiver acts, the request is moot —
-- we'll guard that in the RPC.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ltr_pre_existing_loan_fk'
  ) then
    alter table public.linked_transaction_requests
      add constraint ltr_pre_existing_loan_fk
      foreign key (pre_existing_loan_id) references public.loans(id)
      on delete set null;
  end if;
end $$;

-- Unique index so a single loan can't be syncing through more than one
-- pending request at a time. Partial: only pending rows count; once a
-- request is accepted/rejected/cancelled the slot is free again (though
-- accepted records the linkage in requester_loan_id so a re-sync of the
-- same loan is logically a no-op anyway).
create unique index if not exists idx_ltr_pre_existing_pending
  on public.linked_transaction_requests(pre_existing_loan_id)
  where pre_existing_loan_id is not null and status = 'pending';

-- 2. Re-validate the insert trigger to cover the new column.
-- Sender-only invariants: must own the loan, loan must reference the
-- same person_id, loan must currently be active (no point syncing a
-- settled record).
create or replace function public.tg_ltr_validate_insert() returns trigger
language plpgsql as $$
declare
  v_linked uuid;
  v_loan_owner uuid;
  v_loan_person text;
  v_loan_status text;
  v_loan_type text;
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

  -- Pre-existing loan path: extra invariants.
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
    -- Direction must agree: kind='lent' ↔ loan.type='given'.
    if (new.kind = 'lent'    and v_loan_type <> 'given') or
       (new.kind = 'borrowed' and v_loan_type <> 'taken') then
      raise exception 'ltr: kind/loan-type mismatch on sync request';
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
  return new;
end $$;

-- 3. Updated accept RPC. When pre_existing_loan_id is set, REUSE that
-- sender-side loan instead of creating a duplicate, and also reuse the
-- original "loan_given"/"loan_taken" transaction (find by related_loan_id).
-- The receiver-side mirror is always created fresh.
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
  v_loan_status          text;
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
    -- ─── Phase 2B path: brand-new loan on both sides ───
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
  else
    -- ─── Phase 2D path: reuse sender-side loan + transaction ───
    -- Loan must still be active on accept (sender could have settled
    -- or deleted in the meantime). Bail with a clear error so the
    -- receiver sees the request as un-actionable.
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

    -- Find the original sender-side transaction that created this loan.
    -- The Phase 2A loan-creation flow always writes one loan_given /
    -- loan_taken transaction with related_loan_id = the new loan id, so
    -- this lookup is deterministic (LIMIT 1 is just defensive).
    select id into v_requester_txn_id
      from public.transactions
     where related_loan_id = v_requester_loan_id
       and user_id = v_req.from_user_id
       and type in ('loan_given', 'loan_taken')
     order by created_at asc
     limit 1;
    -- If we can't find the originating transaction (legacy data), leave
    -- requester_txn_id null on the request rather than fabricating one.
  end if;

  -- Receiver-side mirrored loan. The amount on the request mirrors what
  -- the SENDER chose to share: for a fresh request it's the original
  -- amount; for a sync request the client passes the loan's CURRENT
  -- remaining_amount (so the receiver doesn't see "owed AED 1000" when
  -- 700 has already been repaid locally).
  insert into public.loans(
    id, user_id, person_name, person_id, type,
    total_amount, remaining_amount, currency, status, notes, created_at
  ) values (
    v_responder_loan_id, v_req.to_user_id,
    v_from_name, v_receiver_person_id, v_responder_loan_type,
    v_req.amount, v_req.amount, v_req.currency, 'active', v_req.note, v_now
  );

  -- Receiver-side mirrored transaction. Account ids are null by design:
  -- linked records track the obligation without moving balances.
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

-- 4. Backwards-compat: the existing reject_linked_request / cancel_linked_request
-- RPCs work as-is — they don't touch the loans table, so the pre_existing path
-- needs no changes there. (Cancelling a sync request leaves the sender's
-- original loan untouched, which is the correct behaviour.)

-- Permissions stay the same — accept is already granted to authenticated.
