-- Hisaab: repair hardened group-join RPC ambiguity without reopening self-join.
-- Apply after supabase-migration-p0-launch-blockers.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.join_group_by_code(
  p_code_normalized TEXT,
  p_display_name TEXT
)
RETURNS TABLE (
  group_id TEXT,
  member_id TEXT,
  was_already_connected BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_group public.split_groups%ROWTYPE;
  v_member public.group_members%ROWTYPE;
  v_now TIMESTAMPTZ := now();
  v_failures INTEGER;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_code_normalized IS NULL OR length(p_code_normalized) <> 6 THEN
    RAISE EXCEPTION 'INVALID_CODE' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_failures
    FROM public.join_code_attempts AS jca
   WHERE jca.user_id = v_uid
     AND jca.succeeded = false
     AND jca.attempted_at > now() - INTERVAL '5 minutes';
  IF v_failures >= 5 THEN
    RAISE EXCEPTION 'RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  SELECT sg.* INTO v_group
    FROM public.split_groups AS sg
   WHERE sg.join_code_normalized = p_code_normalized
   LIMIT 1;
  IF v_group.id IS NULL
     OR (v_group.join_code_expires_at IS NOT NULL AND v_group.join_code_expires_at < now()) THEN
    INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false);
    RAISE EXCEPTION 'INVALID_OR_EXPIRED_CODE' USING ERRCODE = 'P0001';
  END IF;
  IF v_group.user_id = v_uid THEN
    RAISE EXCEPTION 'CANNOT_JOIN_OWN_GROUP' USING ERRCODE = 'P0001';
  END IF;

  SELECT gm.* INTO v_member
    FROM public.group_members AS gm
   WHERE gm.group_id = v_group.id
     AND gm.profile_id = v_uid
   LIMIT 1;
  IF v_member.id IS NULL THEN
    v_member.id := gen_random_uuid()::text;
    INSERT INTO public.group_members(
      id, group_id, profile_id, display_name, role, status, invited_by, joined_at
    ) VALUES (
      v_member.id, v_group.id, v_uid, COALESCE(NULLIF(trim(p_display_name), ''), 'Member'),
      'member', 'connected', v_uid, v_now
    );
    was_already_connected := false;
  ELSE
    was_already_connected := v_member.status = 'connected';
    UPDATE public.group_members AS gm
       SET status = 'connected',
           joined_at = COALESCE(gm.joined_at, v_now)
     WHERE gm.id = v_member.id;
  END IF;
  INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, true);
  RETURN QUERY SELECT v_group.id, v_member.id, was_already_connected;
END;
$$;

REVOKE ALL ON FUNCTION public.join_group_by_code(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_group_by_code(TEXT, TEXT) TO authenticated;

DROP FUNCTION IF EXISTS public.accept_group_invite(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.accept_group_invite(
  p_invite_token_hash TEXT,
  p_display_name TEXT
)
RETURNS TABLE (
  group_id TEXT,
  member_id TEXT,
  was_already_connected BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_invite public.group_invites%ROWTYPE;
  v_member public.group_members%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT gi.* INTO v_invite
    FROM public.group_invites AS gi
   WHERE gi.token_hash = p_invite_token_hash
     AND gi.revoked_at IS NULL
     AND (gi.expires_at IS NULL OR gi.expires_at >= v_now)
     AND (gi.accepted_by IS NULL OR gi.accepted_by = v_uid)
   FOR UPDATE;
  IF v_invite.id IS NULL THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND_OR_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT gm.* INTO v_member
    FROM public.group_members AS gm
   WHERE gm.group_id = v_invite.group_id
     AND gm.profile_id = v_uid
   LIMIT 1;
  IF v_member.id IS NULL AND v_invite.linked_member_id IS NOT NULL THEN
    SELECT gm.* INTO v_member
      FROM public.group_members AS gm
     WHERE gm.id = v_invite.linked_member_id
       AND gm.group_id = v_invite.group_id
       AND (gm.profile_id IS NULL OR gm.profile_id = v_uid)
     FOR UPDATE;
  END IF;

  IF v_member.id IS NULL THEN
    v_member.id := gen_random_uuid()::text;
    INSERT INTO public.group_members(
      id, group_id, profile_id, display_name, role, status, invited_by, joined_at
    ) VALUES (
      v_member.id, v_invite.group_id, v_uid, COALESCE(NULLIF(trim(p_display_name), ''), 'Member'),
      'member', 'connected', v_invite.created_by, v_now
    );
    was_already_connected := false;
  ELSE
    was_already_connected := v_member.status = 'connected' AND v_member.profile_id = v_uid;
    UPDATE public.group_members AS gm
       SET profile_id = v_uid,
           status = 'connected',
           joined_at = COALESCE(gm.joined_at, v_now)
     WHERE gm.id = v_member.id;
  END IF;

  UPDATE public.group_invites AS gi
     SET accepted_by = v_uid,
         accepted_at = COALESCE(gi.accepted_at, v_now)
   WHERE gi.id = v_invite.id;
  RETURN QUERY SELECT v_invite.group_id, v_member.id, was_already_connected;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_group_invite(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_group_invite(TEXT, TEXT) TO authenticated;

COMMIT;
