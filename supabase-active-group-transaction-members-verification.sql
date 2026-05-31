-- Run in Supabase SQL Editor after
-- supabase-migration-enforce-active-group-transaction-members.sql.
-- Read-only catalog assertions. Any failed assertion aborts.

DO $$
DECLARE
  expense_trigger_definition TEXT;
  settlement_trigger_definition TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger AS pt
     WHERE pt.tgname = 'group_expenses_require_connected_members'
       AND pt.tgrelid = 'public.group_expenses'::regclass
       AND NOT pt.tgisinternal
  ) THEN
    RAISE EXCEPTION 'group expense active-member trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger AS pt
     WHERE pt.tgname = 'group_settlements_require_connected_members'
       AND pt.tgrelid = 'public.group_settlements'::regclass
       AND NOT pt.tgisinternal
  ) THEN
    RAISE EXCEPTION 'group settlement active-member trigger is missing';
  END IF;

  SELECT pg_get_functiondef('public.tg_group_expenses_require_connected_members()'::regprocedure)
    INTO expense_trigger_definition;
  SELECT pg_get_functiondef('public.tg_group_settlements_require_connected_members()'::regprocedure)
    INTO settlement_trigger_definition;

  IF expense_trigger_definition NOT LIKE '%gm.status = ''connected''%' THEN
    RAISE EXCEPTION 'expense trigger does not enforce connected membership';
  END IF;
  IF expense_trigger_definition NOT LIKE '%jsonb_array_elements%' THEN
    RAISE EXCEPTION 'expense trigger does not validate split JSON participants';
  END IF;
  IF settlement_trigger_definition NOT LIKE '%gm.status = ''connected''%' THEN
    RAISE EXCEPTION 'settlement trigger does not enforce connected membership';
  END IF;

  RAISE NOTICE 'Active-only group transaction member verification passed';
  RAISE NOTICE 'Historical expense and settlement rows remain untouched';
END;
$$;

-- Manual staging verification:
-- 1. Pick a group_members row with status = 'left'.
-- 2. INSERT a group_expenses row using that member as paid_by: must raise
--    INACTIVE_GROUP_MEMBER.
-- 3. INSERT a group_expenses row with that member in splits JSON: must raise
--    INACTIVE_GROUP_MEMBER.
-- 4. INSERT a group_settlements row with that member as from_member or
--    to_member: must raise INACTIVE_GROUP_MEMBER.
-- 5. SELECT old rows involving that member: they must still be present.
-- 6. Rejoin through the hardened join RPC, confirm status = 'connected', then
--    repeat inserts with valid connected participants: they should succeed.
