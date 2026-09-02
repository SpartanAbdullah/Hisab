-- ════════════════════════════════════════════════════════════════════════════
-- HARNESS PRELUDE — not a migration, never apply this to production.
-- ----------------------------------------------------------------------------
-- docs/audit-2026-09/APPLY-ORDER.md §6 ("the notifications-rls replay drift"):
--
--   supabase-migration-notifications-rls.sql will NOT re-apply against today's
--   supabase-schema.sql. It fails with
--       42710  policy "Users can view own notifications" … already exists
--   because supabase-schema.sql was edited in place after that migration was
--   written (2026-04-19 ×2, 2026-05-13) and now already ships all four
--   notification policies.
--
--   This is NOT a production bug — production applied the 2026-03-26 schema,
--   which had only "Users can manage own notifications". It is a bug in the
--   repo's *replayability*: supabase-schema.sql is no longer a faithful
--   "run this first" artifact.
--
-- Dropping the four policies here puts a freshly-built database into the state
-- production was actually in on 2026-04-19, so the migration can do its job.
-- Applied between supabase-schema.sql and
-- supabase-migration-notifications-rls.sql — see apply-order.txt.
--
-- If supabase-schema.sql is ever made replayable (or the migration is made
-- idempotent), delete this file and its apply-order.txt line.
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Users can view own notifications"   ON notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can delete own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can insert notifications for self or fellow members"
  ON notifications;
