-- Hisaab — Notifications RLS fix (fan-out)
-- Run ONCE in the Supabase SQL Editor.
--
-- Problem: creating a group showed an "error" toast to the creator even though
-- the group was saved. Members got no notification and had to refresh to see
-- the group.
--
-- Root cause: the original notifications policy is `FOR ALL USING (auth.uid()
-- = user_id)`. PostgREST applies that as WITH CHECK on INSERT too. So a user
-- CAN insert a notification for themselves but NOT for anyone else. The
-- fan-out path (createGroup, joinGroupByCode, addGroupExpense, etc.) tries to
-- insert rows with user_id = OTHER members' profile IDs, which fails RLS,
-- which throws, which reaches the UI as "error".
--
-- Fix: split the catch-all into explicit SELECT/UPDATE/DELETE policies (self
-- only) and a permissive INSERT policy that allows you to create a
-- notification for yourself OR for a fellow connected member of a group you
-- both belong to. The `is_group_member` helper (created in the RLS recursion
-- migration) makes both sides of that check cheap and recursion-safe.

DROP POLICY IF EXISTS "Users can manage own notifications" ON notifications;

CREATE POLICY "Users can view own notifications"
  ON notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own notifications"
  ON notifications FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert notifications for self or fellow members"
  ON notifications FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    OR (
      group_id IS NOT NULL
      AND public.is_group_member(group_id, auth.uid())
      AND public.is_group_member(group_id, user_id)
    )
  );
