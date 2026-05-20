-- Hisaab - payer-owned group expense reconciliation
-- Run this in Supabase SQL Editor after supabase-migration-reconciliation.sql.
--
-- Why this exists:
-- A group expense row is often created by one member but paid by another.
-- RLS can block a normal UPDATE from the payer because they are not the row's
-- creator. This RPC performs one narrow action: toggle reconciliation, only
-- when the signed-in user is the profile linked to the paid_by member row.

CREATE OR REPLACE FUNCTION public.reconcile_group_expense(
  p_expense_id TEXT,
  p_is_reconciled BOOLEAN
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_expense public.group_expenses%ROWTYPE;
  v_paid_member_profile UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT *
    INTO v_expense
    FROM public.group_expenses
   WHERE id = p_expense_id
     AND deleted_at IS NULL
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Group expense not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT profile_id
    INTO v_paid_member_profile
    FROM public.group_members
   WHERE id = v_expense.paid_by
     AND group_id = v_expense.group_id
     AND status = 'connected'
   LIMIT 1;

  IF v_paid_member_profile IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the paid-by member can reconcile this expense' USING ERRCODE = '42501';
  END IF;

  UPDATE public.group_expenses
     SET is_reconciled = p_is_reconciled,
         reconciled_by = CASE WHEN p_is_reconciled THEN v_uid ELSE NULL END,
         reconciled_at = CASE WHEN p_is_reconciled THEN now() ELSE NULL END
   WHERE id = p_expense_id;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_group_expense(TEXT, BOOLEAN) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.reconcile_group_expense(TEXT, BOOLEAN) FROM anon, public;
