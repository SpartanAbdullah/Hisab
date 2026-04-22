-- Hisaab — Atomic join-by-code RPC
-- Run ONCE in the Supabase SQL Editor AFTER the group-codes migration.
--
-- Problem: the previous client flow did
--   1. lookup_group_by_join_code  (SECURITY DEFINER, fine)
--   2. SELECT * FROM split_groups WHERE id = ?  <-- RLS blocks non-members
--   3. INSERT INTO group_members ... profile_id = auth.uid()
-- Step 2 fails under the "Members can view shared groups" policy because
-- the user is neither the owner nor yet a connected member. The whole join
-- never gets a chance to commit step 3.
--
-- Fix: bundle the lookup + the membership upsert into one SECURITY DEFINER
-- function. The caller still has to know the code (so we don't leak
-- anything), but the RLS read check no longer stands between them and a
-- successful join.

CREATE OR REPLACE FUNCTION public.join_group_by_code(
  p_code_normalized TEXT,
  p_display_name    TEXT
)
RETURNS TABLE (
  group_id             TEXT,
  member_id            TEXT,
  was_already_connected BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID := auth.uid();
  v_group_id       TEXT;
  v_existing_id    TEXT;
  v_existing_stat  TEXT;
  v_new_member_id  TEXT;
  v_now            TIMESTAMPTZ := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_code_normalized IS NULL OR length(p_code_normalized) = 0 THEN
    RAISE EXCEPTION 'Group code required' USING ERRCODE = '22023';
  END IF;

  -- Resolve the group. No row → user-visible "not found".
  SELECT g.id
    INTO v_group_id
    FROM public.split_groups g
   WHERE g.join_code_normalized = p_code_normalized
   LIMIT 1;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'Group code not found' USING ERRCODE = 'P0002';
  END IF;

  -- Is the caller already linked to this group (as guest, invited, or connected)?
  SELECT m.id, m.status
    INTO v_existing_id, v_existing_stat
    FROM public.group_members m
   WHERE m.group_id = v_group_id
     AND m.profile_id = v_uid
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    IF v_existing_stat <> 'connected' THEN
      UPDATE public.group_members
         SET status    = 'connected',
             joined_at = COALESCE(joined_at, v_now)
       WHERE id = v_existing_id;
      RETURN QUERY SELECT v_group_id, v_existing_id, FALSE;
    ELSE
      -- Already fully connected — treat as a no-op, but still return the id
      -- so the client can navigate. The caller checks was_already_connected
      -- to decide whether to fire member_joined fan-out.
      RETURN QUERY SELECT v_group_id, v_existing_id, TRUE;
    END IF;
  ELSE
    v_new_member_id := gen_random_uuid()::text;
    INSERT INTO public.group_members (
      id, group_id, profile_id, display_name,
      role, status, invited_by, joined_at, created_at
    ) VALUES (
      v_new_member_id, v_group_id, v_uid, COALESCE(NULLIF(p_display_name, ''), 'Member'),
      'member', 'connected', v_uid, v_now, v_now
    );
    RETURN QUERY SELECT v_group_id, v_new_member_id, FALSE;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_group_by_code(TEXT, TEXT) TO authenticated;

-- Revoke from anon so unauthenticated clients can't fish for valid codes.
REVOKE EXECUTE ON FUNCTION public.join_group_by_code(TEXT, TEXT) FROM anon, public;
