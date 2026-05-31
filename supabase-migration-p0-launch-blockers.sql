-- Hisaab P0 launch blockers
-- Apply in Supabase SQL Editor after the existing migrations.
-- This migration is intentionally additive/idempotent where possible.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Active-profile gate and protected profile security fields
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.is_current_profile_active()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles p
     WHERE p.id = auth.uid()
       AND COALESCE(p.is_deleted, false) = false
  );
$$;

REVOKE ALL ON FUNCTION public.is_current_profile_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_current_profile_active() TO authenticated;

CREATE OR REPLACE FUNCTION public.tg_profiles_protect_security_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND auth.uid() IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.is_deleted IS DISTINCT FROM OLD.is_deleted
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Profile security fields cannot be changed by the client'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_protect_security_fields ON public.profiles;
CREATE TRIGGER profiles_protect_security_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_profiles_protect_security_fields();

DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own active profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = id AND public.is_current_profile_active());

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own active profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id AND public.is_current_profile_active())
  WITH CHECK (auth.uid() = id AND public.is_current_profile_active());

-- Restrictive policies compose with the existing per-table ownership policies.
-- Even a still-valid JWT from a previously soft-deleted account is blocked.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts', 'transactions', 'loans', 'emi_schedules', 'goals',
    'activities', 'upcoming_expenses', 'split_groups', 'group_expenses',
    'group_settlements', 'group_members', 'group_invites', 'group_events',
    'notifications', 'persons', 'linked_transaction_requests',
    'linked_settlement_requests', 'budgets', 'recurring_transactions',
    'remittances'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS "Active profiles only" ON public.%I', table_name);
      EXECUTE format(
        'CREATE POLICY "Active profiles only" ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_current_profile_active())) WITH CHECK ((SELECT public.is_current_profile_active()))',
        table_name
      );
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Permanent server-enforced account deletion
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_current_user()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Mark first so concurrent policy checks stop admitting new work. The
  -- profile row is then removed by auth.users ON DELETE CASCADE.
  UPDATE public.profiles
     SET is_deleted = true,
         deleted_at = now(),
         name = '',
         public_code = NULL,
         public_code_normalized = NULL
   WHERE id = v_uid;

  -- The auth identity is permanently removed. Existing foreign keys cascade
  -- personal rows and owned groups, while shared references using SET NULL
  -- are anonymized. A stale JWT cannot recreate rows because its auth user FK
  -- no longer exists and the active-profile RLS gate fails.
  DELETE FROM auth.users WHERE id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auth user not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_current_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_current_user() TO authenticated;
DROP FUNCTION IF EXISTS public.soft_delete_current_user();

-- Remove identities left behind by the previous soft-delete implementation.
DELETE FROM auth.users u
USING public.profiles p
WHERE u.id = p.id
  AND p.is_deleted = true;

-- ---------------------------------------------------------------------------
-- 3. RPC-only group joining
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can add members to own or shared groups" ON public.group_members;
DROP POLICY IF EXISTS "Group owners can add members" ON public.group_members;
CREATE POLICY "Group owners can add members"
  ON public.group_members FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.split_groups g
       WHERE g.id = group_members.group_id
         AND g.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update own member link or owner can manage group members" ON public.group_members;
DROP POLICY IF EXISTS "Group owners can update members" ON public.group_members;
CREATE POLICY "Group owners can update members"
  ON public.group_members FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.split_groups g
       WHERE g.id = group_members.group_id AND g.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.split_groups g
       WHERE g.id = group_members.group_id AND g.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Invite creators and accepted users can update invites" ON public.group_invites;
DROP POLICY IF EXISTS "Group owners can update invites" ON public.group_invites;
CREATE POLICY "Group owners can update invites"
  ON public.group_invites FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.split_groups g
       WHERE g.id = group_invites.group_id AND g.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.split_groups g
       WHERE g.id = group_invites.group_id AND g.user_id = auth.uid()
    )
  );

DROP FUNCTION IF EXISTS public.lookup_group_by_join_code(TEXT);
DROP FUNCTION IF EXISTS public.join_group_by_code(TEXT);

CREATE TABLE IF NOT EXISTS public.join_code_attempts (
  user_id UUID NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_join_attempts_user_time
  ON public.join_code_attempts(user_id, attempted_at DESC);

ALTER TABLE public.join_code_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no client access to join_code_attempts" ON public.join_code_attempts;
CREATE POLICY "no client access to join_code_attempts"
  ON public.join_code_attempts FOR ALL
  USING (false) WITH CHECK (false);

ALTER TABLE public.split_groups
  ADD COLUMN IF NOT EXISTS join_code_expires_at TIMESTAMPTZ;

UPDATE public.split_groups
   SET join_code_expires_at = now() + INTERVAL '14 days'
 WHERE join_code IS NOT NULL
   AND join_code_expires_at IS NULL;

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
   WHERE jca.user_id = v_uid AND jca.succeeded = false
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

  SELECT gm.* INTO v_member FROM public.group_members AS gm
   WHERE gm.group_id = v_group.id AND gm.profile_id = v_uid LIMIT 1;
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
       SET status = 'connected', joined_at = COALESCE(gm.joined_at, v_now)
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

  SELECT gm.* INTO v_member FROM public.group_members AS gm
   WHERE gm.group_id = v_invite.group_id AND gm.profile_id = v_uid LIMIT 1;
  IF v_member.id IS NULL AND v_invite.linked_member_id IS NOT NULL THEN
    SELECT gm.* INTO v_member FROM public.group_members AS gm
     WHERE gm.id = v_invite.linked_member_id AND gm.group_id = v_invite.group_id
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
       SET profile_id = v_uid, status = 'connected', joined_at = COALESCE(gm.joined_at, v_now)
     WHERE gm.id = v_member.id;
  END IF;

  UPDATE public.group_invites AS gi
     SET accepted_by = v_uid, accepted_at = COALESCE(gi.accepted_at, v_now)
   WHERE gi.id = v_invite.id;
  RETURN QUERY SELECT v_invite.group_id, v_member.id, was_already_connected;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_group_invite(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_group_invite(TEXT, TEXT) TO authenticated;

-- Keep profile-code lookup usable for contact linking without returning
-- deleted users or serving a deleted caller.
CREATE OR REPLACE FUNCTION public.lookup_profile_by_code(code TEXT)
RETURNS TABLE(profile_id UUID, display_name TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, COALESCE(NULLIF(trim(p.name), ''), 'Hisaab user')
    FROM public.profiles p
   WHERE public.is_current_profile_active()
     AND p.public_code_normalized = COALESCE(code, '')
     AND p.id <> auth.uid()
     AND COALESCE(p.is_deleted, false) = false
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.lookup_profile_by_code(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_profile_by_code(TEXT) TO authenticated;
DROP FUNCTION IF EXISTS public.lookup_profile_by_public_code(TEXT);

COMMIT;
