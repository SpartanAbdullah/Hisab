-- Run in Supabase SQL Editor after supabase-migration-p0-launch-blockers.sql.
-- This is a read-only catalog verification. Any failed assertion aborts.

DO $$
DECLARE
  insert_policy TEXT;
BEGIN
  IF to_regprocedure('public.delete_current_user()') IS NULL THEN
    RAISE EXCEPTION 'delete_current_user() is missing';
  END IF;
  IF to_regprocedure('public.soft_delete_current_user()') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy soft_delete_current_user() still exists';
  END IF;
  IF to_regprocedure('public.lookup_group_by_join_code(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy lookup_group_by_join_code(text) still exists';
  END IF;
  IF to_regprocedure('public.join_group_by_code(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy join_group_by_code(text) still exists';
  END IF;
  IF to_regprocedure('public.join_group_by_code(text,text)') IS NULL THEN
    RAISE EXCEPTION 'canonical join_group_by_code(text,text) is missing';
  END IF;
  IF to_regprocedure('public.accept_group_invite(text,text)') IS NULL THEN
    RAISE EXCEPTION 'accept_group_invite(text,text) is missing';
  END IF;

  SELECT with_check INTO insert_policy
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'group_members'
     AND policyname = 'Group owners can add members';
  IF insert_policy IS NULL THEN
    RAISE EXCEPTION 'owner-only group_members INSERT policy is missing';
  END IF;
  IF insert_policy ILIKE '%profile_id%' OR insert_policy NOT ILIKE '%split_groups%' THEN
    RAISE EXCEPTION 'group_members INSERT policy still permits direct self-join: %', insert_policy;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'group_members'
       AND policyname = 'Active profiles only'
       AND permissive = 'RESTRICTIVE'
  ) THEN
    RAISE EXCEPTION 'group_members active-profile restrictive policy is missing';
  END IF;

  RAISE NOTICE 'P0 security catalog verification passed';
  RAISE NOTICE 'Direct group_id self-join is blocked: INSERT is owner-only and join RPCs require a valid code or invite token';
END;
$$;

