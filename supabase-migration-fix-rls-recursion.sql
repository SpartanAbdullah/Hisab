-- Hisaab — RLS recursion fix
-- Run this ONCE in the Supabase SQL Editor.
--
-- Problem: creating a group returned 500 from /group_members.
--   - The INSERT policy on group_members falls back to `EXISTS (SELECT … FROM split_groups)`.
--   - The SELECT policy on split_groups does `EXISTS (SELECT … FROM group_members)`.
--   - The SELECT policy on group_members does `EXISTS (SELECT … FROM group_members)` — self-referential.
--   Postgres detects infinite recursion mid-evaluation and returns 500.
--
-- Fix: route the "is user a connected member of this group?" check through a
-- SECURITY DEFINER helper so that evaluating RLS on group_members does not
-- itself re-trigger RLS on group_members.

CREATE OR REPLACE FUNCTION public.is_group_member(gid TEXT, uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = gid
      AND profile_id = uid
      AND status = 'connected'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_group_member(TEXT, UUID) TO authenticated;

-- ── group_members: replace the self-referential SELECT policy ───────────────
DROP POLICY IF EXISTS "Users can view members of shared groups" ON group_members;
CREATE POLICY "Users can view members of shared groups"
  ON group_members FOR SELECT
  USING (
    profile_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM split_groups g
      WHERE g.id = group_members.group_id
        AND g.user_id = auth.uid()
    )
    OR public.is_group_member(group_members.group_id, auth.uid())
  );

-- ── split_groups: de-recurse the SELECT policy ──────────────────────────────
DROP POLICY IF EXISTS "Members can view shared groups" ON split_groups;
CREATE POLICY "Members can view shared groups"
  ON split_groups FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_group_member(split_groups.id, auth.uid())
  );

-- ── group_events: same pattern ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Connected members can view group events" ON group_events;
CREATE POLICY "Connected members can view group events"
  ON group_events FOR SELECT
  USING (public.is_group_member(group_events.group_id, auth.uid()));

DROP POLICY IF EXISTS "Connected members can create group events" ON group_events;
CREATE POLICY "Connected members can create group events"
  ON group_events FOR INSERT
  WITH CHECK (
    auth.uid() = actor_profile_id
    AND public.is_group_member(group_events.group_id, auth.uid())
  );

-- ── group_expenses ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Members can view shared group expenses" ON group_expenses;
CREATE POLICY "Members can view shared group expenses"
  ON group_expenses FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_group_member(group_expenses.group_id, auth.uid())
  );

DROP POLICY IF EXISTS "Connected members can create shared group expenses" ON group_expenses;
CREATE POLICY "Connected members can create shared group expenses"
  ON group_expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND public.is_group_member(group_expenses.group_id, auth.uid())
  );

-- ── group_settlements ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Members can view shared group settlements" ON group_settlements;
CREATE POLICY "Members can view shared group settlements"
  ON group_settlements FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.is_group_member(group_settlements.group_id, auth.uid())
  );

DROP POLICY IF EXISTS "Connected members can create shared group settlements" ON group_settlements;
CREATE POLICY "Connected members can create shared group settlements"
  ON group_settlements FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND public.is_group_member(group_settlements.group_id, auth.uid())
  );

-- ── group_invites ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Members can view invites in their groups" ON group_invites;
CREATE POLICY "Members can view invites in their groups"
  ON group_invites FOR SELECT
  USING (
    created_by = auth.uid()
    OR accepted_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM split_groups g
      WHERE g.id = group_invites.group_id AND g.user_id = auth.uid()
    )
    OR public.is_group_member(group_invites.group_id, auth.uid())
  );
