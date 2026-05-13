-- Hisaab v2.0 — Supabase Database Schema
-- Run this in the Supabase SQL Editor to create all tables
-- Column names = exact snake_case of the app's camelCase TypeScript types

-- ══════════════════════════════════════
-- 1. PROFILES (extends Supabase auth.users)
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  primary_currency TEXT NOT NULL DEFAULT 'AED',
  app_mode TEXT NOT NULL DEFAULT 'full_tracker',
  lang TEXT NOT NULL DEFAULT 'ur',
  onboarding_completed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, name) VALUES (NEW.id, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ══════════════════════════════════════
-- 2. ACCOUNTS
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'cash',
  currency TEXT NOT NULL DEFAULT 'AED',
  balance NUMERIC NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_accounts_user ON accounts(user_id);
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own accounts" ON accounts FOR ALL USING (auth.uid() = user_id);

-- ══════════════════════════════════════
-- 3. TRANSACTIONS
-- Matches TypeScript: Transaction { sourceAccountId, destinationAccountId, relatedPerson, relatedLoanId, relatedGoalId, conversionRate, category, notes }
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AED',
  source_account_id TEXT DEFAULT NULL,
  destination_account_id TEXT DEFAULT NULL,
  related_person TEXT DEFAULT NULL,
  related_loan_id TEXT DEFAULT NULL,
  related_goal_id TEXT DEFAULT NULL,
  conversion_rate NUMERIC DEFAULT NULL,
  category TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_reconciled BOOLEAN NOT NULL DEFAULT false,
  reconciled_at TIMESTAMPTZ DEFAULT NULL,
  reconciled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_source ON transactions(source_account_id);
CREATE INDEX idx_transactions_dest ON transactions(destination_account_id);
CREATE INDEX idx_transactions_created ON transactions(created_at DESC);
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own transactions" ON transactions FOR ALL USING (auth.uid() = user_id);

-- ══════════════════════════════════════
-- 4. LOANS
-- Matches TypeScript: Loan { personName, totalAmount, remainingAmount, currency, status, notes }
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  person_name TEXT NOT NULL,
  type TEXT NOT NULL,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  remaining_amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AED',
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_loans_user ON loans(user_id);
ALTER TABLE loans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own loans" ON loans FOR ALL USING (auth.uid() = user_id);

-- ══════════════════════════════════════
-- 5. EMI SCHEDULES
-- Matches TypeScript: EmiSchedule { loanId, installmentNumber, dueDate, amount, status }
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS emi_schedules (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  loan_id TEXT NOT NULL,
  installment_number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'upcoming',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_emi_user ON emi_schedules(user_id);
CREATE INDEX idx_emi_loan ON emi_schedules(loan_id);
ALTER TABLE emi_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own emi" ON emi_schedules FOR ALL USING (auth.uid() = user_id);

-- ══════════════════════════════════════
-- 6. GOALS
-- Matches TypeScript: Goal { title, targetAmount, savedAmount, currency, storedInAccountId }
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  target_amount NUMERIC NOT NULL DEFAULT 0,
  saved_amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AED',
  stored_in_account_id TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_goals_user ON goals(user_id);
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own goals" ON goals FOR ALL USING (auth.uid() = user_id);

-- ══════════════════════════════════════
-- 7. ACTIVITIES
-- Matches TypeScript: ActivityLog { type, description, relatedEntityId, relatedEntityType, timestamp }
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  related_entity_id TEXT DEFAULT '',
  related_entity_type TEXT DEFAULT '',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activities_user ON activities(user_id);
CREATE INDEX idx_activities_ts ON activities(timestamp DESC);
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own activities" ON activities FOR ALL USING (auth.uid() = user_id);

-- ══════════════════════════════════════
-- 8. UPCOMING EXPENSES
-- Matches TypeScript: UpcomingExpense { title, amount, currency, dueDate, accountId, category, notes, isPaid, status, reminderDaysBefore }
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS upcoming_expenses (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AED',
  due_date TEXT NOT NULL,
  account_id TEXT DEFAULT '',
  category TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  is_paid BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'upcoming',
  reminder_days_before INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_upcoming_user ON upcoming_expenses(user_id);
ALTER TABLE upcoming_expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own upcoming" ON upcoming_expenses FOR ALL USING (auth.uid() = user_id);

-- ══════════════════════════════════════
-- 9. SPLIT GROUPS
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS split_groups (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '',
  members JSONB NOT NULL DEFAULT '[]',
  currency TEXT NOT NULL DEFAULT 'AED',
  settled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_split_groups_user ON split_groups(user_id);
ALTER TABLE split_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own groups" ON split_groups FOR ALL USING (auth.uid() = user_id);

-- ══════════════════════════════════════
-- 10. GROUP EXPENSES
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS group_expenses (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  paid_by TEXT NOT NULL,
  split_type TEXT NOT NULL DEFAULT 'equal',
  splits JSONB NOT NULL DEFAULT '[]',
  category TEXT DEFAULT '',
  date TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_reconciled BOOLEAN NOT NULL DEFAULT false,
  reconciled_at TIMESTAMPTZ DEFAULT NULL,
  reconciled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_group_expenses_group ON group_expenses(group_id);
ALTER TABLE group_expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own group expenses" ON group_expenses FOR ALL USING (auth.uid() = user_id);

-- ══════════════════════════════════════
-- 11. GROUP SETTLEMENTS
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS group_settlements (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  from_member TEXT NOT NULL,
  to_member TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  date TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_group_settlements_group ON group_settlements(group_id);
ALTER TABLE group_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own settlements" ON group_settlements FOR ALL USING (auth.uid() = user_id);

-- ════════════════════════════════════════
-- 12. SHARED GROUP COLLABORATION (vNext)
-- ════════════════════════════════════════

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS public_code TEXT,
  ADD COLUMN IF NOT EXISTS public_code_normalized TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_public_code_normalized
  ON profiles(public_code_normalized)
  WHERE public_code_normalized IS NOT NULL;

ALTER TABLE split_groups
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS join_code TEXT,
  ADD COLUMN IF NOT EXISTS join_code_normalized TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_split_groups_join_code_normalized
  ON split_groups(join_code_normalized)
  WHERE join_code_normalized IS NOT NULL;

-- SECURITY DEFINER lookups for "join by code" and "add by user code" flows.
-- These bypass RLS to return minimal public fields that should be visible to
-- any authenticated user when they supply a valid code.
CREATE OR REPLACE FUNCTION public.lookup_profile_by_public_code(code_normalized TEXT)
RETURNS TABLE (id UUID, name TEXT, public_code TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT p.id, p.name, p.public_code
  FROM public.profiles p
  WHERE p.public_code_normalized = code_normalized
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.lookup_profile_by_public_code(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.lookup_group_by_join_code(code_normalized TEXT)
RETURNS TABLE (id TEXT, name TEXT, emoji TEXT, currency TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT g.id, g.name, g.emoji, g.currency
  FROM public.split_groups g
  WHERE g.join_code_normalized = code_normalized
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.lookup_group_by_join_code(TEXT) TO authenticated;

ALTER TABLE group_expenses
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE group_settlements
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'guest',
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_profile ON group_members(profile_id);
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER helper: lets RLS policies check "is this user a connected
-- member of this group?" without re-triggering RLS on group_members, which
-- would otherwise recurse (PostgreSQL aborts with error code 42P17).
CREATE OR REPLACE FUNCTION public.is_group_member(gid TEXT, uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = gid
      AND profile_id = uid
      AND status = 'connected'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_group_member(TEXT, UUID) TO authenticated;

CREATE POLICY "Users can view members of shared groups"
  ON group_members FOR SELECT
  USING (
    profile_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM split_groups g
      WHERE g.id = group_members.group_id
        AND g.user_id = auth.uid()
    )
    OR public.is_group_member(group_members.group_id, auth.uid())
  );

CREATE POLICY "Users can add members to own or shared groups"
  ON group_members FOR INSERT
  WITH CHECK (
    auth.uid() = profile_id OR
    EXISTS (
      SELECT 1 FROM split_groups g
      WHERE g.id = group_members.group_id
        AND g.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own member link or owner can manage group members"
  ON group_members FOR UPDATE
  USING (
    auth.uid() = profile_id OR
    EXISTS (
      SELECT 1 FROM split_groups g
      WHERE g.id = group_members.group_id
        AND g.user_id = auth.uid()
    )
  );

CREATE TABLE IF NOT EXISTS group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  linked_member_id TEXT REFERENCES group_members(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_invites_token_hash ON group_invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id);
ALTER TABLE group_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view invites in their groups"
  ON group_invites FOR SELECT
  USING (
    created_by = auth.uid()
    OR accepted_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM split_groups g
      WHERE g.id = group_invites.group_id AND g.user_id = auth.uid()
    )
    OR public.is_group_member(group_invites.group_id, auth.uid())
  );

CREATE POLICY "Group owners can create invites"
  ON group_invites FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM split_groups g
      WHERE g.id = group_invites.group_id
        AND g.user_id = auth.uid()
    )
  );

CREATE POLICY "Invite creators and accepted users can update invites"
  ON group_invites FOR UPDATE
  USING (created_by = auth.uid() OR accepted_by = auth.uid());

CREATE TABLE IF NOT EXISTS group_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  actor_profile_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_events_group_created ON group_events(group_id, created_at DESC);
ALTER TABLE group_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Connected members can view group events"
  ON group_events FOR SELECT
  USING (public.is_group_member(group_events.group_id, auth.uid()));

CREATE POLICY "Connected members can create group events"
  ON group_events FOR INSERT
  WITH CHECK (
    auth.uid() = actor_profile_id
    AND public.is_group_member(group_events.group_id, auth.uid())
  );

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES split_groups(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES group_events(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'group_update',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notifications"
  ON notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own notifications"
  ON notifications FOR DELETE
  USING (auth.uid() = user_id);

-- INSERT must allow fan-out — a member notifying other connected members of
-- the same group. Without this, any write that triggers notifications rejects.
CREATE POLICY "Users can insert notifications for self or fellow members"
  ON notifications FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    OR (
      group_id IS NOT NULL
      AND public.is_group_member(group_id, auth.uid())
      AND public.is_group_member(group_id, user_id)
    )
  );

CREATE POLICY "Members can view shared groups"
  ON split_groups FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_group_member(split_groups.id, auth.uid())
  );

CREATE POLICY "Members can view shared group expenses"
  ON group_expenses FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_group_member(group_expenses.group_id, auth.uid())
  );

CREATE POLICY "Connected members can create shared group expenses"
  ON group_expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND public.is_group_member(group_expenses.group_id, auth.uid())
  );

CREATE POLICY "Expense creators can update their shared group expenses"
  ON group_expenses FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Expense creators can delete their shared group expenses"
  ON group_expenses FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Members can view shared group settlements"
  ON group_settlements FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_group_member(group_settlements.group_id, auth.uid())
  );

CREATE POLICY "Connected members can create shared group settlements"
  ON group_settlements FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND public.is_group_member(group_settlements.group_id, auth.uid())
  );
