-- Hisaab — Audit 2026-09, item C-1/F-2 (cross-user half): row locks and
-- atomic delta arithmetic in the two linked-request accept RPCs.
--
-- Apply in Supabase Studio AFTER:
--   1. supabase-migration-settlement-emi-and-account-guards.sql  (2026-07-22)
--   2. supabase-migration-cross-user-account-effects.sql         (2026-07-25)
--        ^ the LATEST definition of BOTH functions replaced below
--   3. supabase-migration-audit-p0-loan-concurrency.sql          (2026-09-02)
--        ^ apply_loan_remaining_delta, the client-side CAS this file must
--          interlock with
-- Order vs the other 2026-09-02 audit migrations does not matter — none of them
-- redefine accept_linked_request / accept_settlement_request (verified by
-- grepping every CREATE FUNCTION in supabase-migration-audit-p0-*.sql).
--
-- Idempotent: safe to re-run. No DDL beyond CREATE OR REPLACE FUNCTION + the
-- two legacy 1-arg DROPs that supabase-migration-cross-user-account-effects.sql
-- already performs.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY (be precise — the premise that started this is only half true)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The brief was that accept_settlement_request performs an unlocked
-- read-modify-write on loans.remaining_amount. Re-reading the LATEST body
-- (supabase-migration-cross-user-account-effects.sql:417-633) shows the loan
-- rows ARE already taken with `select * into v_r_loan ... for update` at :453
-- and :457, so the later
--     v_new_remaining := v_r_loan.remaining_amount - v_req.amount;   (:577)
--     update public.loans set remaining_amount = greatest(0, v_new_remaining)  (:579)
-- is, under READ COMMITTED, protected by that lock: a concurrent
-- apply_loan_remaining_delta blocks on the same row and the FOR UPDATE re-reads
-- the committed value (EvalPlanQual), so the loan write itself does not lose an
-- update today. THAT PART IS NOT BROKEN. The gaps that ARE real:
--
--   L-1  Deadlock, accept_settlement_request. The two loans are locked in
--        (requester, responder) order — an order that depends on WHO sent the
--        request. Since supabase-migration-fix-bidirectional-linked-settlements.sql
--        either side may raise a settlement on the same loan pair, so two
--        pending requests X→Y and Y→X accepted concurrently lock the same two
--        loan rows in opposite orders: textbook ABBA. Postgres breaks it with
--        40P01 and the loser's accept fails with a raw "deadlock detected"
--        PostgREST error. Same shape for the two account rows (:474-511).
--
--   L-2  Missing lock, accept_linked_request, past-record-sync path
--        (cross-user-account-effects.sql:335-344). The sender's pre-existing
--        loan is read WITHOUT `for update`:
--            select status into v_loan_status from public.loans
--             where id = v_req.pre_existing_loan_id and user_id = ...;
--        its 'active' status is then relied on while the receiver's mirrored
--        loan is inserted with total = remaining = v_req.amount. A repayment
--        landing in that window (client → apply_loan_remaining_delta) settles
--        the sender's loan while the mirror is created full — the two sides of
--        a linked pair start out of sync, which every later settlement accept
--        then rejects with 'lsr: loan is no longer active'. This IS an
--        unlocked read-then-act on loans.
--
--   L-3  Lock-order inversion between the two RPCs. accept_linked_request
--        locks ACCOUNTS first (:205-243) and only afterwards reads loans;
--        accept_settlement_request locks LOANS first and accounts second.
--        Today that cannot deadlock only because L-2's loans read takes no
--        lock at all — i.e. fixing L-2 naively WOULD introduce a cross-RPC
--        ABBA deadlock. The loan lock therefore has to be hoisted, not just
--        added in place.
--
--   L-4  Stale-variable arithmetic (defence in depth). The loan UPDATEs
--        compute the new value in a plpgsql variable read ~125 lines earlier.
--        That is correct only for as long as the FOR UPDATE above it survives
--        every future edit of this function. apply_loan_remaining_delta
--        (supabase-migration-audit-p0-loan-concurrency.sql:122-133) already
--        does the arithmetic inside the UPDATE; making these two match removes
--        the dependency on a distant lock and on nobody reordering the body.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LOCK-ORDERING RULE ADOPTED (repo-wide)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   RULE:  loans  →  accounts  →  emi_schedules,
--          and WITHIN a table, rows are locked in ascending `id` order.
--          Everything else either locks a single row or a disjoint table.
--
--   Conformance of the neighbours (all re-read for this change):
--     · apply_loan_remaining_delta   — unlocked existence probe + ONE atomic
--       UPDATE on loans. Locks loans only. Conforms trivially.
--     · apply_account_balance_delta  — ONE atomic CAS UPDATE on accounts
--       (supabase-migration-prelaunch-hardening.sql:245-275). Locks accounts
--       only. Conforms trivially. Not called from these RPCs: both take the
--       balance with an in-statement `balance = balance + …` (already atomic,
--       already deadlock-free), and per the task brief those stay AS-IS.
--     · record_group_settlement      — locks split_groups FOR NO KEY UPDATE
--       then inserts group_settlements
--       (supabase-migration-audit-p0-group-concurrency.sql:349-353). Touches
--       neither loans nor accounts, so it is disjoint from this ordering and
--       cannot participate in a cycle with it.
--     · tg_ltr_validate_insert / tg_lsr_validate_insert — accounts FOR SHARE
--       only, never loans. No cycle.
--
--   Both functions below therefore acquire ALL of their loan locks, in id
--   order, in ONE statement placed before ANY account row is touched. The
--   pre-existing `... for update` selects that follow are then lock re-takes
--   (no-ops) that still serve their original purpose of reading the row.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- MINI-DIFF — every line that differs from the source definition
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── accept_linked_request(text, text) ──────────────────────────────────────
--    SOURCE: supabase-migration-cross-user-account-effects.sql:156-403
--    Signature, declares, every check, every error string, every insert and
--    every balance UPDATE are byte-identical. Three changes:
--
--    [A1] INSERTED after the past-record ledger-only guard (source :199),
--         before the first account lock:
--             if v_req.pre_existing_loan_id is not null then
--               perform 1 from public.loans
--                where id = v_req.pre_existing_loan_id
--                  and user_id = v_req.from_user_id
--                order by id
--                for update;
--             end if;
--         → fixes L-2 and L-3 (loans locked BEFORE accounts, matching
--           accept_settlement_request).
--
--    [A2] INSERTED before the requester-account validation block
--         (source :205):
--             perform 1 from public.accounts
--              where id in (v_req.requester_account_id, responder_account_id)
--              order by id
--              for update;
--         → both account rows taken in id order in one statement, so two
--           concurrent accepts touching the same two accounts cannot invert.
--           NULL ids match nothing, so ledger-only sides are unaffected.
--
--    [A3] CHANGED, source :335-338 — added `for update` (redundant now that
--         [A1] holds the lock, kept so the read-then-act shape is
--         self-documenting and survives future reordering):
--         -    select status into v_loan_status
--         -      from public.loans
--         -     where id = v_req.pre_existing_loan_id
--         -       and user_id = v_req.from_user_id;
--         +    select status into v_loan_status
--         +      from public.loans
--         +     where id = v_req.pre_existing_loan_id
--         +       and user_id = v_req.from_user_id
--         +     for update;
--
--    NOT changed: the two `update public.accounts set balance = balance + …`
--    blocks (source :327-332, :384-389) — already atomic in-statement deltas.
--
-- ── accept_settlement_request(text, text) ──────────────────────────────────
--    SOURCE: supabase-migration-cross-user-account-effects.sql:417-633
--    Signature, every guard, every error string, both transaction inserts,
--    both account-balance UPDATEs, both emi_schedules reconciliations and the
--    final request UPDATE are preserved. Six changes:
--
--    [B0] DECLARE: removed `v_new_status text;` — [B3]/[B5] compute the status
--         inside the UPDATE, so the variable became dead. `v_new_remaining`
--         is kept (now filled by RETURNING).
--
--    [B1] INSERTED after the `only the target user can accept` guard
--         (source :451), before the first loan select:
--             perform 1 from public.loans
--              where id in (v_req.requester_loan_id, v_req.responder_loan_id)
--              order by id
--              for update;
--         → fixes L-1 for loans. The two `select * … for update` below are
--           unchanged and now merely re-take locks already held.
--
--    [B2] INSERTED before the requester-account validation block
--         (source :474):
--             perform 1 from public.accounts
--              where id in (v_req.requester_account_id, responder_account_id)
--              order by id
--              for update;
--         → fixes L-1 for accounts. Strictly after [B1]: loans → accounts.
--
--    [B3] CHANGED, source :577-582 (requester loan) — stale-variable
--         read-modify-write becomes one atomic UPDATE. Identical semantics
--         (same greatest(0, …) clamp, same 0.00001 settle epsilon); the RHS
--         column references are the OLD row values, per SQL UPDATE rules:
--         -    v_new_remaining := v_r_loan.remaining_amount - v_req.amount;
--         -    v_new_status := case when v_new_remaining <= 0.00001 then 'settled' else 'active' end;
--         -    update public.loans
--         -       set remaining_amount = greatest(0, v_new_remaining),
--         -           status = v_new_status
--         -     where id = v_r_loan.id;
--         +    update public.loans
--         +       set remaining_amount = greatest(0, remaining_amount - v_req.amount),
--         +           status = case when remaining_amount - v_req.amount <= 0.00001
--         +                           then 'settled' else 'active' end
--         +     where id = v_r_loan.id
--         +    returning remaining_amount into v_new_remaining;
--
--    [B4] CHANGED, source :598 — the requester EMI coverage bound now uses the
--         value actually stored by [B3] instead of recomputing it from the
--         snapshot. Same number whenever nothing raced; correct when something
--         did. `emi_schedules` (the token supabase-audit-p0-verification.sql
--         §"settlement-emi applied?" greps prosrc for) is untouched:
--         -     and c.cum <= (v_r_loan.total_amount - greatest(0, v_r_loan.remaining_amount - v_req.amount)) + 0.00001;
--         +     and c.cum <= (v_r_loan.total_amount - v_new_remaining) + 0.00001;
--
--    [B5] CHANGED, source :600-605 (responder loan) — identical rewrite to
--         [B3], against v_p_loan.id.
--
--    [B6] CHANGED, source :621 — identical rewrite to [B4], against
--         v_p_loan.total_amount.
--
--    NOT changed: `v_r_loan.total_amount` / `v_p_loan.total_amount` still come
--    from the snapshot. total_amount is not mutated by any repayment path and
--    the row is locked for the whole transaction, so the snapshot is current.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- VALIDATED on a throwaway Postgres 15 (docker postgres:15) with a faithful
-- copy of the loans / accounts / persons / profiles / transactions /
-- emi_schedules / linked_*_requests shapes, an auth.uid() stub, and the real
-- prerequisite migrations applied in order (settlement-emi-and-account-guards →
-- cross-user-account-effects → audit-p0-loan-concurrency → this file):
--
--   · Applies clean and is re-runnable (applied 3×, no error).
--   · 12-case behavioural battery (full settle, partial settle, ledger-only,
--     overpay guard, wrong acceptor, non-pending replay, tombstoned account,
--     currency mismatch, settled loan, linked fresh-loan path, linked
--     past-record sync path, sync+account refusal) produced OUTPUT IDENTICAL
--     to the pre-change definitions — loans, EMI rows, balances and both
--     transaction rows byte-for-byte the same. Only the plpgsql line numbers in
--     error CONTEXT differ.
--   · Lock-order probe: the OLD acquisition sequence (requester loan, then
--     responder loan) reproducibly deadlocks (SQLSTATE 40P01) when two
--     opposing settlements on one loan pair are accepted concurrently; the
--     canonical `where id in (…) order by id for update` acquisition does not
--     — the second session simply waits.
--   · C-1 interlock: with an accept holding its transaction open, a concurrent
--     apply_loan_remaining_delta BLOCKS on the loan row for the full duration
--     and then fails LOAN_REMAINING_CONFLICT; the loan drops by exactly one
--     settlement. Reversed order, the accept's 'lsr: amount exceeds remaining
--     on one side' guard fires on the fresh value.
--   · L-2 proof: with a repayment transaction open on the sender's loan, the
--     OLD accept_linked_request completed in 4 ms and created the receiver's
--     mirror at the full amount against a loan that settled moments later
--     (permanent pair desync). The version below blocks, then correctly raises
--     'ltr: pre_existing loan has been settled or archived' and creates
--     nothing.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Legacy 1-arg signatures must not survive: PostgREST would see an ambiguous
-- overload (HTTP 300) for a {request_id}-only call. Mirrors
-- supabase-migration-cross-user-account-effects.sql:154,415 — no-op if that
-- migration has already been applied.
drop function if exists public.accept_linked_request(text);
drop function if exists public.accept_settlement_request(text);

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. accept_linked_request — loans locked before accounts  [A1-A3]
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- [A1] LOCK ORDER: loans first, before any account row. The sync path below
  -- reads this loan's status and then adopts it as the requester side of the
  -- pair, so the row must be pinned for the whole transaction — otherwise a
  -- concurrent repayment can settle it while the receiver's mirror is being
  -- inserted at the full amount.
  if v_req.pre_existing_loan_id is not null then
    perform 1
      from public.loans
     where id = v_req.pre_existing_loan_id
       and user_id = v_req.from_user_id
     order by id
     for update;
  end if;

  -- [A2] LOCK ORDER: both account rows, ascending id, in ONE statement, after
  -- the loan lock. NULL ids match nothing, so ledger-only sides are unaffected.
  perform 1
    from public.accounts
   where id in (v_req.requester_account_id, responder_account_id)
   order by id
   for update;

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
    -- [A3] `for update` (row already pinned by [A1]; explicit here so the
    -- read-then-adopt shape stays obviously locked).
    select status into v_loan_status
      from public.loans
     where id = v_req.pre_existing_loan_id
       and user_id = v_req.from_user_id
     for update;
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

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. accept_settlement_request — canonical lock order + atomic
--            remaining_amount deltas                             [B0-B6]
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- [B0] v_new_status removed: status is derived inside the UPDATEs below.
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

  -- [B1] LOCK ORDER: take BOTH loan rows in ascending id order in one
  -- statement, before anything else is locked. Either side of a linked pair
  -- may raise a settlement, so without a canonical order two concurrent
  -- accepts (X→Y and Y→X) would lock the same two rows in opposite orders and
  -- deadlock (40P01). The `for update` selects below re-take these locks.
  perform 1
    from public.loans
   where id in (v_req.requester_loan_id, v_req.responder_loan_id)
   order by id
   for update;

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

  -- [B2] LOCK ORDER: both account rows, ascending id, in ONE statement, and
  -- strictly AFTER the loan locks — loans → accounts, repo-wide. NULL ids
  -- match nothing, so ledger-only sides are unaffected.
  perform 1
    from public.accounts
   where id in (v_req.requester_account_id, responder_account_id)
   order by id
   for update;

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

  -- [B3] Atomic delta on the requester's loan: the arithmetic and the settle
  -- decision both happen inside the UPDATE, against the row's live value, not
  -- a variable snapshotted 120 lines up. Same clamp, same 0.00001 epsilon.
  update public.loans
     set remaining_amount = greatest(0, remaining_amount - v_req.amount),
         status = case when remaining_amount - v_req.amount <= 0.00001
                         then 'settled' else 'active' end
   where id = v_r_loan.id
  returning remaining_amount into v_new_remaining;

  -- Requester's EMI schedule follows the money (unchanged).
  -- [B4] coverage bound now reads the value actually stored above.
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
     and c.cum <= (v_r_loan.total_amount - v_new_remaining) + 0.00001;

  -- [B5] Atomic delta on the responder's loan (identical shape to [B3]).
  update public.loans
     set remaining_amount = greatest(0, remaining_amount - v_req.amount),
         status = case when remaining_amount - v_req.amount <= 0.00001
                         then 'settled' else 'active' end
   where id = v_p_loan.id
  returning remaining_amount into v_new_remaining;

  -- Responder's schedule too (unchanged).
  -- [B6] coverage bound now reads the value actually stored above.
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
     and c.cum <= (v_p_loan.total_amount - v_new_remaining) + 0.00001;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Grants — re-asserted verbatim from
--            supabase-migration-cross-user-account-effects.sql:637-641
-- ═══════════════════════════════════════════════════════════════════════════

revoke all on function public.accept_linked_request(text, text) from public, anon;
grant execute on function public.accept_linked_request(text, text) to authenticated;

revoke all on function public.accept_settlement_request(text, text) from public, anon;
grant execute on function public.accept_settlement_request(text, text) to authenticated;

COMMENT ON FUNCTION public.accept_settlement_request(text, text) IS
  'Accepts a linked settlement. Locks both loan rows in canonical id order, then both account rows, then applies remaining_amount as an atomic in-statement delta and reconciles emi_schedules on both sides (audit C-1/F-2 row-lock hardening).';

COMMENT ON FUNCTION public.accept_linked_request(text, text) IS
  'Accepts a linked loan request. Locks the sender''s pre-existing loan (sync path) before any account row, keeping the repo-wide loans -> accounts order (audit C-1/F-2 row-lock hardening).';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Verification — read-only, safe to run on production, any number
--            of times. Paste each block; every one should return the "Expect"
--            values.
-- ═══════════════════════════════════════════════════════════════════════════

-- 4.1 Exactly the 2-arg signatures exist, SECURITY DEFINER, search_path pinned,
--     and no legacy 1-arg leftovers (PostgREST would 300 on those).
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef                               AS security_definer,
       p.proconfig                               AS settings
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('accept_linked_request', 'accept_settlement_request')
 ORDER BY p.proname;
-- Expect: exactly 2 rows, both args = 'request_id text, responder_account_id text',
--         security_definer = t, settings = {search_path=public}

-- 4.2 Only authenticated may execute; anon may not.
SELECT has_function_privilege('authenticated', 'public.accept_linked_request(text,text)',     'EXECUTE') AS lr_auth,
       has_function_privilege('anon',          'public.accept_linked_request(text,text)',     'EXECUTE') AS lr_anon,
       has_function_privilege('authenticated', 'public.accept_settlement_request(text,text)', 'EXECUTE') AS sr_auth,
       has_function_privilege('anon',          'public.accept_settlement_request(text,text)', 'EXECUTE') AS sr_anon;
-- Expect: t, f, t, f

-- 4.3 accept_settlement_request carries every marker this migration depends on
--     AND still carries the tokens earlier verification scripts key on.
SELECT (p.prosrc ILIKE '%emi_schedules%')                                        AS keeps_emi_reconciliation,
       (p.prosrc ILIKE '%greatest(0, remaining_amount - v_req.amount)%')         AS atomic_loan_delta,
       (p.prosrc NOT ILIKE '%greatest(0, v_new_remaining)%')                     AS no_stale_variable_write,
       (p.prosrc ILIKE '%in (v_req.requester_loan_id, v_req.responder_loan_id)%')AS canonical_loan_lock,
       (p.prosrc ILIKE '%in (v_req.requester_account_id, responder_account_id)%')AS canonical_account_lock,
       (length(p.prosrc) - length(replace(lower(p.prosrc), 'for update;', ''))) / 11
                                                                                 AS for_update_stmts,
       (p.prosrc ILIKE '%lsr: amount exceeds remaining on one side%')            AS keeps_overpay_guard,
       (p.prosrc ILIKE '%lsr: requester account was deleted%')                   AS keeps_tombstone_guard,
       (p.prosrc ILIKE '%lsr: currency mismatch at accept%')                     AS keeps_currency_guard,
       (p.prosrc ILIKE '%0.00001%')                                              AS keeps_settle_epsilon
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'accept_settlement_request';
-- Expect: t, t, t, t, t, 7, t, t, t, t
--         for_update_stmts counts locking STATEMENTS (matches on 'for update;',
--         so the word inside a comment is not counted). 7 = the lsr request
--         row, the canonical loans lock [B1], v_r_loan, v_p_loan, the canonical
--         accounts lock [B2], v_r_acct, v_p_acct. Before this migration it was
--         5 — the two canonical locks are the additions.

-- 4.4 accept_linked_request: the sync-path loan read is locked, and the loan
--     lock is hoisted ABOVE the account lock (loans -> accounts).
SELECT (p.prosrc ILIKE '%where id = v_req.pre_existing_loan_id%for update%')     AS sync_loan_locked,
       (position(lower('from public.loans') in lower(p.prosrc))
          < position(lower('from public.accounts') in lower(p.prosrc)))          AS loans_locked_before_accounts,
       (p.prosrc ILIKE '%in (v_req.requester_account_id, responder_account_id)%')AS canonical_account_lock,
       (p.prosrc ILIKE '%ltr: past-record sync is ledger-only%')                 AS keeps_sync_guard,
       (p.prosrc ILIKE '%ltr: responder account was deleted%')                   AS keeps_tombstone_guard,
       (p.prosrc ILIKE '%ltr: pre_existing loan has been settled or archived%')  AS keeps_status_guard,
       (length(p.prosrc) - length(replace(lower(p.prosrc), 'for update;', ''))) / 11
                                                                                 AS for_update_stmts
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'accept_linked_request';
-- Expect: t, t, t, t, t, t, 6
--         6 = ltr request row, hoisted sync-loan lock [A1], canonical accounts
--         lock [A2], v_r_acct, v_p_acct, sync-path status read [A3].
--         Before this migration it was 3.

-- 4.5 The neighbours this ordering rule depends on are present and unchanged
--     in shape (single-table, atomic-UPDATE functions).
SELECT to_regprocedure('public.apply_loan_remaining_delta(text,numeric,numeric)')   IS NOT NULL AS loan_cas_present,
       to_regprocedure('public.apply_account_balance_delta(text,numeric,numeric)')  IS NOT NULL AS balance_cas_present;
-- Expect: t, t   (if loan_cas_present = f, apply
--         supabase-migration-audit-p0-loan-concurrency.sql FIRST — the client
--         routes every repayment through it.)

-- 4.6 Live invariant: no linked loan pair may disagree about being settled.
--     Run before and after a cross-user settlement smoke test.
SELECT count(*) AS desynced_pairs
  FROM public.linked_settlement_requests r
  JOIN public.loans lr ON lr.id = r.requester_loan_id
  JOIN public.loans lp ON lp.id = r.responder_loan_id
 WHERE r.status = 'accepted'
   AND round(lr.remaining_amount, 2) <> round(lp.remaining_amount, 2);
-- Expect: 0 for every pair settled after this migration. Pre-existing rows may
--         already be skewed by the pre-fix behaviour — this query finds them.

-- 4.7 Manual concurrency QA (two psql sessions, or two devices):
--   a. Session A: BEGIN; SELECT public.accept_settlement_request('<req>', null);
--      -- do not commit yet.
--      Session B: SELECT public.apply_loan_remaining_delta('<same requester
--      loan>', -100, <its current remaining>);
--      -> B BLOCKS on the loan row lock (it does not silently succeed).
--      Commit A -> B fails with LOAN_REMAINING_CONFLICT (its expected value is
--      now stale). Both records are consistent; nothing is lost.
--   b. Two pending settlement requests on the SAME loan pair, one in each
--      direction, accepted at the same moment from two sessions:
--      -> one succeeds, the other fails its own guard ('lsr: amount exceeds
--         remaining on one side' or 'lsr: loan is no longer active').
--      -> NEITHER should report 'deadlock detected' (SQLSTATE 40P01). A 40P01
--         here means the canonical lock order [B1]/[B2] did not apply.
