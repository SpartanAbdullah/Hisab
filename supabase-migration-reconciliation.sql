-- Transaction reconciliation markers for personal transactions and group expenses.
-- Apply this in Supabase before deploying the UI that toggles reconciliation.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS is_reconciled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reconciled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_reconciled
  ON transactions(user_id, is_reconciled, created_at DESC);

ALTER TABLE group_expenses
  ADD COLUMN IF NOT EXISTS is_reconciled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reconciled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_group_expenses_reconciled
  ON group_expenses(group_id, is_reconciled, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_group_expense_reconciliation_payer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  paid_member_profile UUID;
BEGIN
  IF NEW.is_reconciled IS DISTINCT FROM OLD.is_reconciled
    OR NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at
    OR NEW.reconciled_by IS DISTINCT FROM OLD.reconciled_by
  THEN
    SELECT profile_id
      INTO paid_member_profile
      FROM group_members
      WHERE id = NEW.paid_by
        AND group_id = NEW.group_id
      LIMIT 1;

    IF paid_member_profile IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Only the paid-by member can reconcile this expense';
    END IF;

    IF NEW.is_reconciled THEN
      NEW.reconciled_by := auth.uid();
      NEW.reconciled_at := COALESCE(NEW.reconciled_at, now());
    ELSE
      NEW.reconciled_by := NULL;
      NEW.reconciled_at := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_expenses_reconciliation_payer ON group_expenses;
CREATE TRIGGER trg_group_expenses_reconciliation_payer
BEFORE UPDATE ON group_expenses
FOR EACH ROW
EXECUTE FUNCTION enforce_group_expense_reconciliation_payer();
