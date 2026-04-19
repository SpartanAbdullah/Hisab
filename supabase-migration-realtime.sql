-- Hisaab — Realtime publication
-- Run ONCE in the Supabase SQL Editor.
--
-- Supabase Realtime only pushes row changes for tables that are part of the
-- `supabase_realtime` publication. This adds the two tables the app
-- subscribes to:
--   - notifications:  per-user push of new in-app notifications.
--   - group_members:  so you see new groups you were added to, and other
--                     members joining/leaving a group you're viewing.
--
-- RLS still applies — the server only delivers rows a user is allowed to see.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'group_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.group_members;
  END IF;
END
$$;
