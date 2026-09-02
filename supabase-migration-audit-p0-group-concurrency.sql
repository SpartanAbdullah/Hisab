-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Group concurrency: expense version check + server-side settlement cap
-- (audit item C10, groups half)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
-- Apply AFTER:
--   supabase-schema.sql
--   supabase-migration-fix-rls-recursion.sql
--   supabase-migration-p0-launch-blockers.sql
--   supabase-migration-safe-leave-group.sql
--   supabase-migration-enforce-active-group-transaction-members.sql
--   supabase-migration-audit-p0-group-ledger-integrity.sql
--   supabase-migration-audit-p0-notifications.sql
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
-- ────────────────────────────────────────────────────────────────────────────
-- Audit 2026-09-02, docs/audit-2026-09/12-qa-review.md:
--
--   F-6 (high, C-3) — "Group-expense `version` never compared on update".
--     group_expenses.version is written on every edit
--     (src/stores/splitStore.ts:877 sets version = existing.version + 1) but
--     NOTHING ever compares it: src/lib/supabaseDb.ts:1007-1031 issues a bare
--     `.update(row).eq('id', id)`. Two people editing the same expense =
--     last-writer-wins, and because per-member owed amounts derive from
--     `splits`, one person's shares silently replace the other's with no
--     signal to anybody.
--
--   F-7 (high, C-4) — "Group settlement cap is a client-side TOCTOU".
--     src/stores/splitStore.ts:1060-1075 reads the outstanding debt, computes
--     a cap, then inserts — with the whole window open for another device to
--     do exactly the same. Both inserts pass, the pair over-settles, and the
--     balance flips sign. In splits_only (ledger-only) mode these rows ARE
--     the entire money record, so there is nothing else to reconcile against.
--
-- ────────────────────────────────────────────────────────────────────────────
-- HOW IT IS FIXED
-- ────────────────────────────────────────────────────────────────────────────
--   1. A BEFORE UPDATE guard makes `version` genuinely monotonic: any client
--      edit that changes the money-bearing fields MUST carry version + 1.
--      Paired with the client's new `.eq('version', expected)` predicate, a
--      losing writer gets 0 affected rows (surfaced as a conflict) instead of
--      silently winning.
--   2. `public.group_settlement_cap()` recomputes the outstanding amount
--      between two members INSIDE the transaction, reusing the same balance
--      arithmetic as supabase-migration-safe-leave-group.sql:110-136 and
--      src/lib/groupDebts.ts. `public.record_group_settlement()` takes a row
--      lock on the group, re-checks the cap under that lock, and inserts —
--      so two concurrent recordings serialize and the second one is rejected
--      with a stable reason code. A BEFORE INSERT trigger applies the same
--      cap to any raw PostgREST insert that bypasses the RPC.
--
-- Both the RPC and the trigger use the cap
--   max( direct pairwise debt(from → to),  min(-net(from), net(to)) )
-- which is exactly what the client allowed (the larger of the raw pairwise
-- view and the simplified/rerouted view, splitStore.ts:1060-1071). The second
-- term is the ceiling over every possible debt simplification, so the server
-- never rejects a settlement the pre-existing client UI would have offered.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. F-6 — group_expenses.version must actually move
-- ═══════════════════════════════════════════════════════════════════════════

-- Backfill: pre-existing rows created before the column had a default.
UPDATE public.group_expenses SET version = 1 WHERE version IS NULL;

CREATE OR REPLACE FUNCTION public.tg_group_expenses_version_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  -- SECURITY DEFINER RPCs (reconcile_group_expense, the account-deletion
  -- sweepers) run as the function owner and do their own authorisation — the
  -- same scoping convention as
  -- supabase-migration-safe-leave-group.sql:28 and the ledger-integrity
  -- triggers. They are exempt.
  v_client BOOLEAN := current_user IN ('authenticated', 'anon');
  v_core_changed BOOLEAN;
BEGIN
  IF NOT v_client THEN
    RETURN NEW;
  END IF;

  -- version may never go backwards, whatever the edit was.
  IF COALESCE(NEW.version, 1) < COALESCE(OLD.version, 1) THEN
    RAISE EXCEPTION 'GROUP_EXPENSE_VERSION_CONFLICT: version cannot move backwards (% -> %)',
      OLD.version, NEW.version USING ERRCODE = '40001';
  END IF;

  v_core_changed :=
       NEW.description IS DISTINCT FROM OLD.description
    OR NEW.amount      IS DISTINCT FROM OLD.amount
    OR NEW.paid_by     IS DISTINCT FROM OLD.paid_by
    OR NEW.splits      IS DISTINCT FROM OLD.splits
    OR NEW.split_type  IS DISTINCT FROM OLD.split_type
    OR NEW.category    IS DISTINCT FROM OLD.category;

  -- Soft-delete (deleted_at) and reconcile flips deliberately do NOT bump the
  -- version — they don't move anybody's share, and the client doesn't send a
  -- new version for them.
  IF v_core_changed AND COALESCE(NEW.version, 1) <> COALESCE(OLD.version, 1) + 1 THEN
    RAISE EXCEPTION 'GROUP_EXPENSE_VERSION_CONFLICT: an edit must carry version % (got %)',
      COALESCE(OLD.version, 1) + 1, NEW.version USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_expenses_version_guard ON public.group_expenses;
CREATE TRIGGER group_expenses_version_guard
  BEFORE UPDATE ON public.group_expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_expenses_version_guard();

COMMENT ON FUNCTION public.tg_group_expenses_version_guard() IS
  'Optimistic-lock backstop for group expenses (audit F-6): a client edit that moves description/amount/paid_by/splits/split_type/category must carry OLD.version + 1, and version can never move backwards. The client pairs this with .eq(version, expected) so a losing concurrent writer gets 0 rows, not a silent clobber.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. F-7 — the settlement cap, computed in the database
-- ═══════════════════════════════════════════════════════════════════════════

-- Net position of one member. Positive = they are owed money, negative = they
-- owe. Identical arithmetic to leave_group (safe-leave-group.sql:110-138) so
-- the two can never disagree about whether a member is square.
CREATE OR REPLACE FUNCTION public.group_member_net_balance(
  p_group_id  TEXT,
  p_member_id TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_net NUMERIC := 0;
BEGIN
  SELECT COALESCE(SUM(delta), 0) INTO v_net
  FROM (
    SELECT e.amount AS delta
      FROM public.group_expenses e
     WHERE e.group_id = p_group_id
       AND e.deleted_at IS NULL
       AND e.paid_by = p_member_id
    UNION ALL
    SELECT -COALESCE((split.value->>'amount')::NUMERIC, 0) AS delta
      FROM public.group_expenses e
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) AS split(value)
     WHERE e.group_id = p_group_id
       AND e.deleted_at IS NULL
       AND COALESCE(split.value->>'memberId', split.value->>'member_id') = p_member_id
    UNION ALL
    SELECT s.amount AS delta
      FROM public.group_settlements s
     WHERE s.group_id = p_group_id
       AND s.deleted_at IS NULL
       AND s.from_member = p_member_id
    UNION ALL
    SELECT -s.amount AS delta
      FROM public.group_settlements s
     WHERE s.group_id = p_group_id
       AND s.deleted_at IS NULL
       AND s.to_member = p_member_id
  ) balance_parts;

  RETURN round(COALESCE(v_net, 0), 2);
END;
$$;

COMMENT ON FUNCTION public.group_member_net_balance(TEXT, TEXT) IS
  'Net group position of one member: positive = owed money, negative = owes money. Same arithmetic as leave_group and the client balance pass.';

-- The maximum a from → to settlement may be, right now.
--   max( direct pairwise debt,  min(-net(from), net(to)) )
-- p_lock takes a row lock on the group first, which is what serializes two
-- concurrent recordings (audit F-7).
CREATE OR REPLACE FUNCTION public.group_settlement_cap(
  p_group_id    TEXT,
  p_from_member TEXT,
  p_to_member   TEXT,
  p_lock        BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pair    NUMERIC := 0;
  v_net_from NUMERIC := 0;
  v_net_to   NUMERIC := 0;
  v_flow    NUMERIC := 0;
BEGIN
  IF p_from_member IS NULL OR p_to_member IS NULL OR p_from_member = p_to_member THEN
    RETURN 0;
  END IF;

  -- SECURITY DEFINER reads every row in the group, so gate on membership or
  -- this becomes an oracle for "does group X have outstanding debt". A NULL
  -- uid means an internal/maintenance call, which is already privileged.
  IF auth.uid() IS NOT NULL AND NOT public.is_group_member(p_group_id, auth.uid()) THEN
    RETURN 0;
  END IF;

  IF p_lock THEN
    -- FOR NO KEY UPDATE: serializes settlement recording within one group
    -- without blocking rows that merely reference the group by FK.
    PERFORM 1 FROM public.split_groups WHERE id = p_group_id FOR NO KEY UPDATE;
  END IF;

  -- Direct pairwise obligation, mirroring src/lib/groupDebts.ts:
  --   owe[F|T] = F's split shares on expenses T paid  −  settlements F→T
  --   net      = owe[F|T] − owe[T|F]
  -- A payer never owes themselves their own share, so p_from <> p_to above is
  -- the only self-exclusion needed.
  SELECT COALESCE(SUM(delta), 0) INTO v_pair
  FROM (
    SELECT COALESCE((split.value->>'amount')::NUMERIC, 0) AS delta
      FROM public.group_expenses e
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) AS split(value)
     WHERE e.group_id = p_group_id
       AND e.deleted_at IS NULL
       AND e.paid_by = p_to_member
       AND COALESCE(split.value->>'memberId', split.value->>'member_id') = p_from_member
    UNION ALL
    SELECT -COALESCE((split.value->>'amount')::NUMERIC, 0) AS delta
      FROM public.group_expenses e
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) AS split(value)
     WHERE e.group_id = p_group_id
       AND e.deleted_at IS NULL
       AND e.paid_by = p_from_member
       AND COALESCE(split.value->>'memberId', split.value->>'member_id') = p_to_member
    UNION ALL
    SELECT -s.amount AS delta
      FROM public.group_settlements s
     WHERE s.group_id = p_group_id
       AND s.deleted_at IS NULL
       AND s.from_member = p_from_member
       AND s.to_member = p_to_member
    UNION ALL
    SELECT s.amount AS delta
      FROM public.group_settlements s
     WHERE s.group_id = p_group_id
       AND s.deleted_at IS NULL
       AND s.from_member = p_to_member
       AND s.to_member = p_from_member
  ) pair_parts;

  v_pair := round(COALESCE(v_pair, 0), 2);

  -- Ceiling over every possible debt simplification: the payer can never send
  -- more than they owe overall, nor more than the receiver is owed overall.
  v_net_from := public.group_member_net_balance(p_group_id, p_from_member);
  v_net_to   := public.group_member_net_balance(p_group_id, p_to_member);
  IF v_net_from < 0 AND v_net_to > 0 THEN
    v_flow := LEAST(-v_net_from, v_net_to);
  END IF;

  RETURN GREATEST(v_pair, v_flow, 0);
END;
$$;

COMMENT ON FUNCTION public.group_settlement_cap(TEXT, TEXT, TEXT, BOOLEAN) IS
  'Outstanding amount a from -> to group settlement may not exceed: max(direct pairwise debt, min(-net(from), net(to))) — the same ceiling the client UI offered, computed transactionally. p_lock serializes concurrent recordings (audit F-7).';

REVOKE ALL ON FUNCTION public.group_settlement_cap(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
-- Read-only and member-scoped information; the settle-up sheet may ask for it.
GRANT EXECUTE ON FUNCTION public.group_settlement_cap(TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
-- Not client-callable: it reads every row in the group and takes a member id
-- as its only argument, so exposing it would be a balance oracle. Only
-- group_settlement_cap (SECURITY DEFINER, and membership-gated) calls it.
REVOKE ALL ON FUNCTION public.group_member_net_balance(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ── The RPC the client records settlements through ─────────────────────────
-- Failures are DATA, not exceptions — the same contract as leave_group and
-- join_group_by_code (audit C5: a RAISE rolls the transaction back, taking any
-- evidence with it, and PostgREST error strings leak to users, audit N-13).
--
-- Reason codes:
--   SETTLEMENT_RECORDED    success
--   ALREADY_RECORDED       success, idempotent replay of the same id
--   NOT_AUTHENTICATED      no/expired session
--   NOT_ACTIVE_MEMBER      caller is not a connected member of the group
--   INVALID_PARTICIPANTS   from/to missing, equal, or not connected members
--   INVALID_AMOUNT         amount is not a positive finite number
--   ALREADY_SETTLED        nothing outstanding between the two right now
--   EXCEEDS_OUTSTANDING    amount > cap  (payload carries cap + currency)
CREATE OR REPLACE FUNCTION public.record_group_settlement(
  p_settlement_id TEXT,
  p_group_id      TEXT,
  p_from_member   TEXT,
  p_to_member     TEXT,
  p_amount        NUMERIC,
  p_note          TEXT DEFAULT '',
  p_date          TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid       UUID := auth.uid();
  v_group   public.split_groups%ROWTYPE;
  v_cap     NUMERIC;
  v_amount  NUMERIC;
  v_now     TIMESTAMPTZ := now();
  v_existing TEXT;
BEGIN
  IF uid IS NULL THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'NOT_AUTHENTICATED',
      'user_message', 'Please sign in again.'
    );
  END IF;

  IF p_settlement_id IS NULL OR length(trim(p_settlement_id)) = 0 THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'INVALID_PARTICIPANTS',
      'user_message', 'This settlement could not be identified.'
    );
  END IF;

  -- Idempotent replay: a double tap, or a retry after a dropped response,
  -- must not record the payment twice.
  SELECT s.id INTO v_existing
    FROM public.group_settlements s
   WHERE s.id = p_settlement_id;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'reason_code', 'ALREADY_RECORDED',
      'settlement_id', v_existing
    );
  END IF;

  v_amount := round(COALESCE(p_amount, 0), 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'INVALID_AMOUNT',
      'user_message', 'Enter an amount greater than zero.'
    );
  END IF;

  -- Lock the group. Everything below — the cap read AND the insert — now runs
  -- serialized against any other settlement being recorded in this group,
  -- which is the whole point of F-7.
  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = p_group_id
   FOR NO KEY UPDATE;

  IF v_group.id IS NULL OR NOT public.is_group_member(p_group_id, uid) THEN
    -- One shared response so the RPC never reveals whether a guessed group id
    -- exists (same discipline as leave_group).
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'NOT_ACTIVE_MEMBER',
      'user_message', 'You are not an active member of this group.'
    );
  END IF;

  IF p_from_member IS NULL OR p_to_member IS NULL OR p_from_member = p_to_member
     OR NOT EXISTS (
       SELECT 1 FROM public.group_members gm
        WHERE gm.id = p_from_member AND gm.group_id = p_group_id AND gm.status = 'connected')
     OR NOT EXISTS (
       SELECT 1 FROM public.group_members gm
        WHERE gm.id = p_to_member AND gm.group_id = p_group_id AND gm.status = 'connected') THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'INVALID_PARTICIPANTS',
      'user_message', 'This member has left the group and can''t be part of a settlement.'
    );
  END IF;

  -- p_lock => FALSE: the group row is already locked above.
  v_cap := public.group_settlement_cap(p_group_id, p_from_member, p_to_member, FALSE);

  IF v_cap <= 0.01 THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'ALREADY_SETTLED',
      'user_message', 'This balance is already settled.',
      'cap', 0, 'currency', v_group.currency
    );
  END IF;

  IF v_amount > v_cap + 0.005 THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'EXCEEDS_OUTSTANDING',
      'user_message', format(
        'Settlement cannot exceed the outstanding %s %s.',
        v_group.currency, trim(to_char(v_cap, 'FM999999999990.00'))
      ),
      'cap', v_cap, 'currency', v_group.currency
    );
  END IF;

  INSERT INTO public.group_settlements (
    id, user_id, group_id, from_member, to_member, amount, date, note,
    created_at, created_by, updated_by
  ) VALUES (
    p_settlement_id, uid, p_group_id, p_from_member, p_to_member, v_amount,
    COALESCE(p_date, v_now), COALESCE(p_note, ''), v_now, uid, uid
  );

  RETURN jsonb_build_object(
    'success', true, 'reason_code', 'SETTLEMENT_RECORDED',
    'settlement_id', p_settlement_id, 'amount', v_amount,
    'currency', v_group.currency
  );
END;
$$;

COMMENT ON FUNCTION public.record_group_settlement(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ) IS
  'Records one group settlement with the outstanding-amount cap enforced inside the transaction under a group row lock (audit F-7). Idempotent on p_settlement_id. Failures return {success:false, reason_code, user_message} rather than raising.';

REVOKE ALL ON FUNCTION public.record_group_settlement(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_group_settlement(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ) TO authenticated;

-- ── Backstop: the cap also applies to a raw PostgREST insert ───────────────
-- The RPC is the client's path, but group_settlements still has an INSERT
-- policy (owned by supabase-migration-audit-p0-group-ledger-integrity.sql), so
-- a member could POST straight to /rest/v1/group_settlements. Scoped to client
-- roles, so the RPC above (SECURITY DEFINER, runs as the owner) is not charged
-- twice for the same check.
CREATE OR REPLACE FUNCTION public.tg_group_settlements_enforce_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_cap NUMERIC;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.amount, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_AMOUNT: settlement amount must be greater than zero'
      USING ERRCODE = '23514';
  END IF;

  -- p_lock => TRUE: without the RPC's lock this insert needs its own, or two
  -- raw concurrent posts would both read a stale cap.
  v_cap := public.group_settlement_cap(NEW.group_id, NEW.from_member, NEW.to_member, TRUE);

  IF round(NEW.amount, 2) > v_cap + 0.005 THEN
    RAISE EXCEPTION 'SETTLEMENT_EXCEEDS_OUTSTANDING: settlement of % exceeds the outstanding %',
      round(NEW.amount, 2), v_cap USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_settlements_enforce_cap ON public.group_settlements;
CREATE TRIGGER group_settlements_enforce_cap
  BEFORE INSERT ON public.group_settlements
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_settlements_enforce_cap();

COMMENT ON FUNCTION public.tg_group_settlements_enforce_cap() IS
  'Applies the same outstanding-amount cap as record_group_settlement to raw client inserts, taking its own group row lock (audit F-7). SECURITY DEFINER callers are exempt because they already checked under a lock.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION — read-only. Run after the COMMIT above.
-- A clean run prints "audit-p0-group-concurrency: OK".
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_name TEXT;
BEGIN
  FOR v_name IN
    SELECT unnest(ARRAY['group_expenses_version_guard', 'group_settlements_enforce_cap'])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = v_name AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'trigger % is missing', v_name;
    END IF;
  END LOOP;

  FOR v_name IN
    SELECT unnest(ARRAY['group_member_net_balance', 'group_settlement_cap', 'record_group_settlement'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_name
    ) THEN
      RAISE EXCEPTION 'function %() is missing', v_name;
    END IF;
  END LOOP;

  IF NOT has_function_privilege(
       'authenticated',
       'public.record_group_settlement(text,text,text,text,numeric,text,timestamptz)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot EXECUTE record_group_settlement';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.record_group_settlement(text,text,text,text,numeric,text,timestamptz)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'anon can EXECUTE record_group_settlement';
  END IF;

  -- No group_expenses row may be left without a version.
  IF EXISTS (SELECT 1 FROM public.group_expenses WHERE version IS NULL) THEN
    RAISE EXCEPTION 'group_expenses still has NULL versions';
  END IF;

  RAISE NOTICE 'audit-p0-group-concurrency: OK';
END;
$$;

-- Manual spot-checks (run as a signed-in member):
--
--   -- F-6: a stale edit must affect 0 rows, not clobber.
--   UPDATE public.group_expenses SET amount = 1, version = 2
--    WHERE id = '<expense id>' AND version = 1;   -- second run: UPDATE 0
--
--   -- F-6: skipping the increment is rejected outright.
--   UPDATE public.group_expenses SET amount = 999 WHERE id = '<expense id>';
--   -- ERROR: GROUP_EXPENSE_VERSION_CONFLICT
--
--   -- F-7: what the server thinks is outstanding right now.
--   SELECT public.group_settlement_cap('<group id>', '<from member>', '<to member>');
--
--   -- F-7: over-settling is refused as data, and nothing is inserted.
--   SELECT public.record_group_settlement(
--     gen_random_uuid()::text, '<group id>', '<from member>', '<to member>', 999999);
--   -- {"success": false, "reason_code": "EXCEEDS_OUTSTANDING", "cap": ...}
--
--   -- F-7 concurrency: run the same call from two sessions at once; exactly
--   -- one succeeds when the two amounts together exceed the cap.
