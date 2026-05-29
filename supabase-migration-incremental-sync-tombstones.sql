-- Tombstone support for Hisaab incremental sync.
-- Adds soft-delete markers for core mirrored tables so clients can remove
-- deleted rows during incremental sync instead of waiting for a full refresh.

BEGIN;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_user_deleted
  ON accounts(user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_user_deleted
  ON transactions(user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_loans_user_deleted
  ON loans(user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_budgets_user_deleted
  ON budgets(user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

COMMIT;
