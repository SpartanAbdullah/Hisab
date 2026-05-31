-- Run in Supabase SQL Editor after supabase-migration-fix-group-invite-join-rpc.sql.
-- Catalog assertions are read-only. Any failed assertion aborts.

DO $$
DECLARE
  insert_policy TEXT;
  invite_definition TEXT;
  code_definition TEXT;
BEGIN
  IF to_regprocedure('public.lookup_group_by_join_code(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy public group-code lookup bypass exists';
  END IF;
  IF to_regprocedure('public.join_group_by_code(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy one-argument join RPC exists';
  END IF;
  IF to_regprocedure('public.join_group_by_code(text,text)') IS NULL THEN
    RAISE EXCEPTION 'canonical join_group_by_code(text,text) is missing';
  END IF;
  IF to_regprocedure('public.accept_group_invite(text,text)') IS NULL THEN
    RAISE EXCEPTION 'canonical accept_group_invite(text,text) is missing';
  END IF;

  SELECT pg_get_functiondef('public.join_group_by_code(text,text)'::regprocedure)
    INTO code_definition;
  SELECT pg_get_functiondef('public.accept_group_invite(text,text)'::regprocedure)
    INTO invite_definition;

  IF code_definition NOT LIKE '%WHERE gm.group_id = v_group.id%' THEN
    RAISE EXCEPTION 'join_group_by_code does not qualify group_members.group_id';
  END IF;
  IF invite_definition NOT LIKE '%WHERE gi.token_hash = p_invite_token_hash%' THEN
    RAISE EXCEPTION 'accept_group_invite does not use the hardened token parameter';
  END IF;
  IF invite_definition NOT LIKE '%gi.accepted_by IS NULL OR gi.accepted_by = v_uid%' THEN
    RAISE EXCEPTION 'accept_group_invite permits consumed invite replay';
  END IF;

  SELECT pp.with_check INTO insert_policy
    FROM pg_policies AS pp
   WHERE pp.schemaname = 'public'
     AND pp.tablename = 'group_members'
     AND pp.policyname = 'Group owners can add members';
  IF insert_policy IS NULL OR insert_policy ILIKE '%profile_id%' THEN
    RAISE EXCEPTION 'group_members INSERT policy permits direct self-join: %', insert_policy;
  END IF;

  IF has_function_privilege('anon', 'public.join_group_by_code(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.accept_group_invite(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute a join RPC';
  END IF;

  RAISE NOTICE 'Group invite join verification passed';
END;
$$;

-- Manual authenticated QA queries:
-- 1. As the invited signed-in account:
--    SELECT * FROM public.accept_group_invite('<sha256 token hash>', '<display name>');
-- 2. Repeat as the same account: returns the same group/member with
--    was_already_connected = true.
-- 3. Repeat as a different active account: raises INVITE_NOT_FOUND_OR_EXPIRED.
-- 4. As anon: both RPCs must be unavailable because EXECUTE is revoked.
-- 5. As a soft-deleted/stale account: both RPCs raise Not authenticated.
