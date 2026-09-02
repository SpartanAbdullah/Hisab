-- ════════════════════════════════════════════════════════════════════════════
-- 20 · Notifications, contact links, invite tokens
--
-- Evidence:
--   05-security.md H5  — any client could write a notification into any other
--                        user's inbox (the pre-fix policy was a permissive
--                        "self OR fellow group member" INSERT).
--   05-security.md H2  — persons.linked_profile_id was directly writable, so a
--                        client could claim a link the other side never gave.
--   05-security.md C6  — group_invites.token_hash was readable by every member,
--                        turning a hashed invite into a bearer token.
--   08-notifications.md N-2 — fan-out must be server-side and durable.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('20-notifications-and-consent');

SET ROLE authenticated;

-- ── NOTIFICATIONS: INSERT is self-only (H5) ────────────────────────────────
SELECT test.as_user('22222222-2222-2222-2222-222222222222');

SELECT test.assert_ok($$
  INSERT INTO notifications (id, user_id, type, title, body)
  VALUES ('N-self', auth.uid(), 'group_update', 'mine', 'ok')
$$, 'a user CAN insert a notification into their own inbox');

-- A is a fellow connected member of G1 — under the old policy this succeeded.
SELECT test.assert_raises($$
  INSERT INTO notifications (id, user_id, type, title, body)
  VALUES ('N-hack', '11111111-1111-1111-1111-111111111111',
          'group_update', 'spoofed', 'you owe me 5000')
$$, 'row-level security',
  'a user CANNOT insert a notification into a fellow member''s inbox (H5)');

SELECT test.assert_raises($$
  INSERT INTO notifications (id, user_id, type, title, body)
  VALUES ('N-hack2', '44444444-4444-4444-4444-444444444444',
          'group_update', 'spoofed', 'stranger')
$$, 'row-level security',
  'a user CANNOT insert a notification into a stranger''s inbox');

SELECT test.assert(
  (SELECT count(*) FROM notifications
    WHERE user_id = '11111111-1111-1111-1111-111111111111') = 0,
  'a user cannot even SELECT another user''s notifications');

RESET ROLE;
SELECT test.assert(
  (SELECT bool_and(with_check NOT ILIKE '%is_group_member%')
     FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications'
      AND cmd = 'INSERT'),
  'no notifications INSERT policy still carries the "fellow member" escape',
  COALESCE((SELECT string_agg(policyname || ' => ' || with_check, ' ; ')
              FROM pg_policies WHERE schemaname='public'
               AND tablename='notifications' AND cmd='INSERT'), '(none)'));

SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname = 'public' AND tablename = 'notifications'
                 AND cmd = 'ALL' AND permissive = 'PERMISSIVE'),
  'notifications has no permissive FOR ALL policy left over');

-- ── SERVER-SIDE FAN-OUT (N-2): the trigger, not the client, told the group ─
-- The fixture's E1 insert was made by A only. B and C's rows can only have
-- come from the AFTER trigger, because the policy above forbids A writing them.
SELECT test.assert(
  (SELECT count(*) FROM notifications
    WHERE params ->> 'expenseId' = 'E1'
      AND user_id <> '11111111-1111-1111-1111-111111111111') >= 1,
  'the expense fan-out reached other members server-side',
  'rows: ' || (SELECT count(*) FROM notifications
                WHERE params ->> 'expenseId' = 'E1')::text);

SELECT test.assert(
  (SELECT bool_and(template IS NOT NULL AND params <> '{}'::jsonb)
     FROM notifications WHERE params ->> 'expenseId' = 'E1'),
  'fan-out rows carry template + params, not frozen English (N-1)');

SELECT test.assert(
  (SELECT count(*) FROM group_events
    WHERE entity_id = 'E1' AND event_type = 'expense_added') = 1,
  'a durable group_events activity row was written by the trigger');

-- ── persons.linked_profile_id (H2) ────────────────────────────────────────
SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

SELECT test.assert_ok($$
  INSERT INTO persons (id, user_id, name) VALUES ('P-1', auth.uid(), 'Bilal')
$$, 'a user can create an unlinked contact');

SELECT test.assert_raises($$
  UPDATE persons SET linked_profile_id = '22222222-2222-2222-2222-222222222222'
   WHERE id = 'P-1'
$$, 'LINK_RPC_REQUIRED',
  'a direct UPDATE of persons.linked_profile_id is refused (H2)');

SELECT test.assert_raises($$
  INSERT INTO persons (id, user_id, name, linked_profile_id)
  VALUES ('P-2', auth.uid(), 'Chand', '33333333-3333-3333-3333-333333333333')
$$, 'LINK_RPC_REQUIRED',
  'a direct INSERT carrying linked_profile_id is refused (H2)');

SELECT test.assert(
  (SELECT linked_profile_id IS NULL FROM persons WHERE id = 'P-1'),
  'the contact is still unlinked after both attempts');

-- The supported path returns a PENDING link — consent is the other side's.
CREATE TEMP TABLE _link AS SELECT link_contact_by_code('P-1', 'BBB222') AS r;
SELECT test.assert((SELECT r ->> 'link_state' FROM _link) = 'pending',
  'link_contact_by_code creates a PENDING link, not a fait accompli',
  (SELECT r::text FROM _link));

-- …and the TARGET's ledger stays empty: B has no contact row for A.
-- Checked as superuser so RLS cannot make this pass vacuously.
RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM persons
    WHERE user_id = '22222222-2222-2222-2222-222222222222') = 0,
  'the link target''s own contact ledger is untouched until they accept',
  'rows: ' || (SELECT count(*) FROM persons
                WHERE user_id = '22222222-2222-2222-2222-222222222222')::text);
SET ROLE authenticated;

-- ── group_invites.token_hash (C6) ─────────────────────────────────────────
-- consent-guards closes this at the COLUMN-privilege layer: REVOKE SELECT on
-- the table, then a column GRANT that omits token_hash. The row policy stays
-- so members still see their group's invites.
RESET ROLE;
SELECT test.assert(
  NOT has_column_privilege('authenticated', 'public.group_invites',
                           'token_hash', 'SELECT'),
  'group_invites.token_hash is NOT column-readable by authenticated (C6)');

SELECT test.assert(
  NOT has_table_privilege('authenticated', 'public.group_invites', 'SELECT'),
  'authenticated has no table-wide SELECT on group_invites');

SELECT test.assert(
  has_column_privilege('authenticated', 'public.group_invites', 'id', 'SELECT'),
  'the other group_invites columns are still readable (members keep the list)');

SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert_raises(
  $$ SELECT token_hash FROM group_invites $$,
  'permission denied',
  'SELECT token_hash FROM group_invites is refused for authenticated');
SELECT test.assert_raises(
  $$ SELECT * FROM group_invites $$,
  'permission denied',
  'SELECT * FROM group_invites is refused (PostgREST select("*") shape)');
