-- Incremental sync support for Hisaab core mirrors.
-- Run after the existing prelaunch hardening migration.
--
-- This migration adds `updated_at` timestamps and indexes used by cache-first
-- clients to fetch only rows changed since the last successful sync.

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Accounts already received updated_at in prelaunch hardening. Keep this
-- idempotent so fresh installs and older databases converge.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_accounts_touch ON accounts;
CREATE TRIGGER trg_accounts_touch
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_accounts_user_updated
  ON accounts(user_id, updated_at);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_transactions_touch ON transactions;
CREATE TRIGGER trg_transactions_touch
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_transactions_user_updated
  ON transactions(user_id, updated_at);

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_loans_touch ON loans;
CREATE TRIGGER trg_loans_touch
  BEFORE UPDATE ON loans
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_loans_user_updated
  ON loans(user_id, updated_at);

ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_budgets_touch ON budgets;
CREATE TRIGGER trg_budgets_touch
  BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE INDEX IF NOT EXISTS idx_budgets_user_updated
  ON budgets(user_id, updated_at);

COMMIT;
