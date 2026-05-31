-- Run in Supabase SQL Editor after supabase-migration-safe-leave-group.sql.
-- Read-only catalog checks for the secure Leave Group deployment.

DO $$
BEGIN
  IF to_regprocedure('public.leave_group(text)') IS NULL THEN
    RAISE EXCEPTION 'leave_group(text) is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'group_members_protect_membership_fields'
       AND tgrelid = 'public.group_members'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'group_members membership-protection trigger is missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'group_members'
       AND cmd = 'DELETE'
       AND roles && ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'authenticated group_members DELETE policy still exists';
  END IF;

  IF has_function_privilege('anon', 'public.leave_group(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute leave_group(text)';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
     WHERE p.oid = 'public.leave_group(text)'::regprocedure
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'public can execute leave_group(text)';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.leave_group(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute leave_group(text)';
  END IF;

  IF to_regprocedure('public.lookup_group_by_join_code(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy lookup_group_by_join_code(text) bypass reappeared';
  END IF;

  RAISE NOTICE 'Secure leave_group catalog verification passed';
  RAISE NOTICE 'Direct authenticated group_members DELETE remains blocked';
  RAISE NOTICE 'Legacy join-code lookup bypass remains absent';
END;
$$;
