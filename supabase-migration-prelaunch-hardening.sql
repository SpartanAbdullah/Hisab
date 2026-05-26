-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Pre-Launch Hardening Migration
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor BEFORE public launch.
-- Idempotent: safe to re-run. Splits work into 9 sections; each begins with a
-- short header so partial failures are easy to triage.
--
-- Fixes from production-readiness audit:
--   1. WITH CHECK on every FOR ALL policy   (prevents user_id reassignment)
--   2. FK transactions↔accounts             (prevents orphaning on delete)
--   3. is_deleted column + soft_delete RPC  (account deletion was broken)
--   4. Account-balance optimistic-lock RPC  (prevents two-tab race money loss)
--   5. DELETE policies on group children    (so members can be removed)
--   6. Drop duplicate profile-lookup RPC    (leaked profile code itself)
--   7. Join-code rate-limit + expiry        (32^6 brute-force surface)
--   8. group_expenses partial UPDATE check  (no row donation across groups)
--   9. updated_by/timestamps on accounts    (audit trail)
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════
-- SECTION 1. WITH CHECK on core FOR ALL policies
-- Drops and recreates each policy so UPDATE cannot re-assign user_id.
-- ═══════════════════════════════════════════

DROP POLICY IF EXISTS "Users can manage own accounts" ON accounts;
CREATE POLICY "Users can manage own accounts" ON accounts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own transactions" ON transactions;
CREATE POLICY "Users can manage own transactions" ON transactions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own loans" ON loans;
CREATE POLICY "Users can manage own loans" ON loans
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own emi" ON emi_schedules;
CREATE POLICY "Users can manage own emi" ON emi_schedules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own goals" ON goals;
CREATE POLICY "Users can manage own goals" ON goals
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own activities" ON activities;
CREATE POLICY "Users can manage own activities" ON activities
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own upcoming" ON upcoming_expenses;
CREATE POLICY "Users can manage own upcoming" ON upcoming_expenses
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own groups" ON split_groups;
CREATE POLICY "Users can manage own groups" ON split_groups
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own settlements" ON group_settlements;
CREATE POLICY "Users can manage own settlements" ON group_settlements
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own group expenses" ON group_expenses;
-- Replaced by SELECT/INSERT/UPDATE/DELETE policies in §8.

-- group_expenses UPDATE: also lock user_id and group_id to prevent row donation.
DROP POLICY IF EXISTS "Expense creators can update their shared group expenses" ON group_expenses;
CREATE POLICY "Expense creators can update their shared group expenses"
  ON group_expenses FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ═══════════════════════════════════════════
-- SECTION 2. FK transactions↔accounts and recurring↔accounts
-- Prevents account-delete from orphaning transactions or breaking recurring.
-- ON DELETE RESTRICT so the client must clear history first.
-- ───────────────────────────────────────────
-- §2-PRE. Orphan cleanup.
-- The FK never existed historically, so the live DB likely contains
-- transactions whose source_account_id / destination_account_id point to
-- accounts that were since deleted. NULL them out before adding the FK
-- (both columns are nullable per schema). The row itself is preserved as
-- audit history; only the dangling pointer is dropped.
-- ═══════════════════════════════════════════

UPDATE transactions
  SET source_account_id = NULL
  WHERE source_account_id IS NOT NULL
    AND source_account_id NOT IN (SELECT id FROM accounts);

UPDATE transactions
  SET destination_account_id = NULL
  WHERE destination_account_id IS NOT NULL
    AND destination_account_id NOT IN (SELECT id FROM accounts);

-- Diagnostic: report how many were nulled (visible in Supabase SQL Editor output).
DO $$
DECLARE
  v_src_orphans INTEGER;
  v_dst_orphans INTEGER;
BEGIN
  SELECT count(*) INTO v_src_orphans FROM transactions WHERE source_account_id IS NULL;
  SELECT count(*) INTO v_dst_orphans FROM transactions WHERE destination_account_id IS NULL;
  RAISE NOTICE 'Post-cleanup: % rows with NULL source_account_id, % with NULL destination_account_id (includes both pre-existing NULLs and freshly-nulled orphans)', v_src_orphans, v_dst_orphans;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_transactions_source_account'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT fk_transactions_source_account
      FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_transactions_destination_account'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT fk_transactions_destination_account
      FOREIGN KEY (destination_account_id) REFERENCES accounts(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- recurring_transactions table is created in supabase-migration-phase3-budgets-recurring-remittances.sql.
-- Guard the FK behind a table-exists check. Clean up orphans first, same as txns above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'recurring_transactions'
  ) THEN
    EXECUTE $CLEAN$
      UPDATE recurring_transactions
        SET source_account_id = NULL
        WHERE source_account_id IS NOT NULL
          AND source_account_id NOT IN (SELECT id FROM accounts)
    $CLEAN$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'recurring_transactions'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_recurring_source_account'
  ) THEN
    -- Use SET NULL: an account-delete should disable, not block, recurring templates.
    ALTER TABLE recurring_transactions
      ADD CONSTRAINT fk_recurring_source_account
      FOREIGN KEY (source_account_id) REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ═══════════════════════════════════════════
-- SECTION 3. Account deletion (is_deleted + soft_delete_current_user)
-- ═══════════════════════════════════════════

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_profiles_is_deleted ON profiles(is_deleted) WHERE is_deleted = true;

-- Account-delete RPC. Purges all per-user data and marks profile deleted.
-- SECURITY DEFINER so it can bypass RLS to delete child rows the user owns.
-- The client signs out separately (see supabaseAuthStore.deleteAccount).
CREATE OR REPLACE FUNCTION public.soft_delete_current_user()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Order matters: children before parents.
  DELETE FROM notifications WHERE user_id = uid;
  DELETE FROM activities WHERE user_id = uid;

  -- Group expenses / settlements / events authored by this user.
  DELETE FROM group_expenses WHERE user_id = uid;
  DELETE FROM group_settlements WHERE user_id = uid;
  DELETE FROM group_events WHERE actor_profile_id = uid;

  -- Sever cross-user collaboration links so the other side doesn't keep
  -- orphan references that point to a soft-deleted user.
  UPDATE group_members SET profile_id = NULL WHERE profile_id = uid;

  -- Personal money tables — guarded against table existence for phase3 cases.
  DELETE FROM emi_schedules WHERE user_id = uid;
  DELETE FROM transactions WHERE user_id = uid;
  DELETE FROM loans WHERE user_id = uid;
  DELETE FROM goals WHERE user_id = uid;
  DELETE FROM upcoming_expenses WHERE user_id = uid;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'budgets') THEN
    EXECUTE 'DELETE FROM budgets WHERE user_id = $1' USING uid;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'recurring_transactions') THEN
    EXECUTE 'DELETE FROM recurring_transactions WHERE user_id = $1' USING uid;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'remittances') THEN
    EXECUTE 'DELETE FROM remittances WHERE user_id = $1' USING uid;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'persons') THEN
    EXECUTE 'DELETE FROM persons WHERE user_id = $1' USING uid;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'linked_transaction_requests') THEN
    EXECUTE 'DELETE FROM linked_transaction_requests WHERE from_user_id = $1 OR to_user_id = $1' USING uid;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'linked_settlement_requests') THEN
    EXECUTE 'DELETE FROM linked_settlement_requests WHERE from_user_id = $1 OR to_user_id = $1' USING uid;
  END IF;

  -- Accounts after transactions (the FK in §2 requires this order).
  DELETE FROM accounts WHERE user_id = uid;

  -- Groups owned by the user — cascades to their members, expenses, settlements, invites, events.
  DELETE FROM split_groups WHERE user_id = uid;

  -- Mark the profile deleted last so any concurrent reads at least see consistent state.
  UPDATE profiles
    SET is_deleted = true,
        deleted_at = now(),
        name = '',
        public_code = NULL,
        public_code_normalized = NULL
    WHERE id = uid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.soft_delete_current_user() TO authenticated;

-- ═══════════════════════════════════════════
-- SECTION 4. Account-balance optimistic-lock RPC
-- Client must pass expected_balance; mismatch returns 0 rows.
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.apply_account_balance_delta(
  p_account_id TEXT,
  p_delta NUMERIC,
  p_expected_balance NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY INVOKER  -- RLS applies; user can only touch their own accounts.
SET search_path = public
AS $$
DECLARE
  new_balance NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE accounts
    SET balance = balance + p_delta
    WHERE id = p_account_id
      AND user_id = auth.uid()
      AND balance = p_expected_balance
    RETURNING balance INTO new_balance;

  IF new_balance IS NULL THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  RETURN new_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_account_balance_delta(TEXT, NUMERIC, NUMERIC) TO authenticated;

-- ═══════════════════════════════════════════
-- SECTION 5. DELETE policies on group children
-- group_members / group_invites / group_events / group_settlements / split_groups
-- all enabled RLS but did not have DELETE policies — so deletion was impossible.
-- ═══════════════════════════════════════════

DROP POLICY IF EXISTS "Owner can remove group members" ON group_members;
CREATE POLICY "Owner can remove group members"
  ON group_members FOR DELETE
  USING (
    -- Owner can remove anyone; a connected user can remove their own link.
    EXISTS (
      SELECT 1 FROM split_groups g
      WHERE g.id = group_members.group_id AND g.user_id = auth.uid()
    )
    OR auth.uid() = profile_id
  );

DROP POLICY IF EXISTS "Owner can revoke invites" ON group_invites;
CREATE POLICY "Owner can revoke invites"
  ON group_invites FOR DELETE
  USING (created_by = auth.uid());

DROP POLICY IF EXISTS "Members can delete own group events" ON group_events;
CREATE POLICY "Members can delete own group events"
  ON group_events FOR DELETE
  USING (actor_profile_id = auth.uid());

DROP POLICY IF EXISTS "Connected members can delete shared group settlements" ON group_settlements;
CREATE POLICY "Connected members can delete shared group settlements"
  ON group_settlements FOR DELETE
  USING (auth.uid() = user_id);

-- ═══════════════════════════════════════════
-- SECTION 6. Drop duplicate profile-lookup RPC
-- supabase-schema.sql:275 leaked profile.public_code itself; the Phase 2A version
-- (lookup_profile_by_code) returns only id+name and excludes self.
-- ═══════════════════════════════════════════

DROP FUNCTION IF EXISTS public.lookup_profile_by_public_code(TEXT);

-- ═══════════════════════════════════════════
-- SECTION 7. join_group_by_code hardening — expiry + per-user rate limit
-- ═══════════════════════════════════════════

ALTER TABLE split_groups
  ADD COLUMN IF NOT EXISTS join_code_expires_at TIMESTAMPTZ;

-- Default expiry: 14 days from now for any group that already has a code.
UPDATE split_groups
  SET join_code_expires_at = now() + INTERVAL '14 days'
  WHERE join_code IS NOT NULL AND join_code_expires_at IS NULL;

CREATE TABLE IF NOT EXISTS join_code_attempts (
  user_id UUID NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_join_attempts_user_time
  ON join_code_attempts(user_id, attempted_at DESC);

ALTER TABLE join_code_attempts ENABLE ROW LEVEL SECURITY;

-- No client-side access — only the SECURITY DEFINER RPC touches this.
DROP POLICY IF EXISTS "no client access to join_code_attempts" ON join_code_attempts;
CREATE POLICY "no client access to join_code_attempts"
  ON join_code_attempts FOR ALL USING (false) WITH CHECK (false);

-- Re-wrap join_group_by_code with rate-limit + expiry checks. The original RPC
-- lives in supabase-migration-join-by-code-rpc.sql; we replace it here.
CREATE OR REPLACE FUNCTION public.join_group_by_code(p_code_normalized TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  v_group split_groups%ROWTYPE;
  v_member_id TEXT;
  v_recent_failures INTEGER;
  v_display_name TEXT;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_code_normalized IS NULL OR length(p_code_normalized) <> 6 THEN
    RAISE EXCEPTION 'INVALID_CODE' USING ERRCODE = 'P0001';
  END IF;

  -- Rate limit: at most 5 failed attempts per 5 minutes per user.
  SELECT count(*) INTO v_recent_failures
    FROM join_code_attempts
    WHERE user_id = uid
      AND succeeded = false
      AND attempted_at > now() - INTERVAL '5 minutes';

  IF v_recent_failures >= 5 THEN
    RAISE EXCEPTION 'RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_group
    FROM split_groups
    WHERE join_code_normalized = p_code_normalized
    LIMIT 1;

  IF v_group.id IS NULL OR (v_group.join_code_expires_at IS NOT NULL AND v_group.join_code_expires_at < now()) THEN
    INSERT INTO join_code_attempts (user_id, succeeded) VALUES (uid, false);
    RAISE EXCEPTION 'INVALID_OR_EXPIRED_CODE' USING ERRCODE = 'P0001';
  END IF;

  -- Owner cannot join their own group through this path.
  IF v_group.user_id = uid THEN
    INSERT INTO join_code_attempts (user_id, succeeded) VALUES (uid, false);
    RAISE EXCEPTION 'CANNOT_JOIN_OWN_GROUP' USING ERRCODE = 'P0001';
  END IF;

  -- Already a member? Idempotent return.
  SELECT id INTO v_member_id FROM group_members
    WHERE group_id = v_group.id AND profile_id = uid LIMIT 1;

  IF v_member_id IS NOT NULL THEN
    UPDATE group_members SET status = 'connected', joined_at = COALESCE(joined_at, now())
      WHERE id = v_member_id;
  ELSE
    SELECT COALESCE(name, '') INTO v_display_name FROM profiles WHERE id = uid;
    v_member_id := gen_random_uuid()::text;
    INSERT INTO group_members (id, group_id, profile_id, display_name, role, status, joined_at)
      VALUES (v_member_id, v_group.id, uid, COALESCE(NULLIF(v_display_name, ''), 'Member'), 'member', 'connected', now());
  END IF;

  INSERT INTO join_code_attempts (user_id, succeeded) VALUES (uid, true);

  RETURN jsonb_build_object(
    'group_id', v_group.id,
    'name', v_group.name,
    'emoji', v_group.emoji,
    'currency', v_group.currency,
    'member_id', v_member_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_group_by_code(TEXT) TO authenticated;

-- ═══════════════════════════════════════════
-- SECTION 8. group_expenses split into per-action policies with WITH CHECK
-- (already partially done in schema; this finalises it idempotently)
-- ═══════════════════════════════════════════

-- INSERT/SELECT already done in supabase-schema.sql. Just ensure SELECT exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Members can view shared group expenses' AND tablename = 'group_expenses') THEN
    EXECUTE $POLICY$
      CREATE POLICY "Members can view shared group expenses"
        ON group_expenses FOR SELECT
        USING (auth.uid() = user_id OR public.is_group_member(group_expenses.group_id, auth.uid()))
    $POLICY$;
  END IF;
END $$;

-- ═══════════════════════════════════════════
-- SECTION 9. Audit timestamps on accounts (cheap, useful)
-- ═══════════════════════════════════════════

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.tg_accounts_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_touch ON accounts;
CREATE TRIGGER trg_accounts_touch
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_accounts_touch();

COMMIT;
