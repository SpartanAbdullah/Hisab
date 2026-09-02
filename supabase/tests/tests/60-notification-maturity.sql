-- ════════════════════════════════════════════════════════════════════════════
-- 60 · Notification maturity (P2 item M5)
--   supabase-migration-p2-notification-maturity.sql
--
-- Covers, end to end through the same doors a client uses:
--   · routing defaults stamped on EVERY writer's rows (channel/href/collapse)
--   · per-group mute suppresses the notification row but NOT the group_events
--     activity row
--   · member_left fan-out (audit N-11)
--   · quiet hours, with midnight wrap, in the recipient's own tz
--   · notification_prefs RLS is self-only
--   · kameti draw / round-due / payout-due for profile-linked members
--   · pruning (read > 90d, unread > 180d)
--
-- Depends on 00-fixtures.sql (users A/B/C/D, group G1) having run first.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('60-notification-maturity');

-- ── 1. Routing defaults fire for a writer this migration does not own ──────
-- tg_ltr_notify (linked-notifications-realtime.sql) inserts with no
-- channel/href/collapse; the BEFORE INSERT trigger must fill them.
RESET ROLE;
INSERT INTO public.notifications (id, user_id, type, title, body)
VALUES ('N-M5-money', '22222222-2222-2222-2222-222222222222',
        'linked_request', 'New shared loan to review', 'Ayesha wants to record AED 500.00 with you.');

SELECT test.assert(
  (SELECT channel_id = 'money' AND href = '/inbox' AND collapse_key = 'linked_request:N-M5-money'
     FROM public.notifications WHERE id = 'N-M5-money'),
  'defaults trigger stamps channel/href/collapse on a linked_request row',
  (SELECT channel_id || ' | ' || href || ' | ' || collapse_key
     FROM public.notifications WHERE id = 'N-M5-money'));

INSERT INTO public.notifications (id, user_id, group_id, type, template, title, body)
VALUES ('N-M5-group', '22222222-2222-2222-2222-222222222222', 'G1',
        'group_update', 'expense_added', 'Ayesha added an expense', 'Groceries in Dubai Trip.');

SELECT test.assert(
  (SELECT channel_id = 'groups' AND href = '/group/G1'
      AND collapse_key = 'group:G1:expense_added'
     FROM public.notifications WHERE id = 'N-M5-group'),
  'group rows deep-link to /group/:id and collapse per (group, template)  [N-8, N-10]',
  (SELECT channel_id || ' | ' || href || ' | ' || collapse_key
     FROM public.notifications WHERE id = 'N-M5-group'));

-- An explicit value is never overwritten.
INSERT INTO public.notifications (id, user_id, type, title, body, channel_id, href, collapse_key)
VALUES ('N-M5-explicit', '22222222-2222-2222-2222-222222222222', 'system', 't', 'b',
        'kameti', '/kameti/zz', 'custom:key');
SELECT test.assert(
  (SELECT channel_id = 'kameti' AND href = '/kameti/zz' AND collapse_key = 'custom:key'
     FROM public.notifications WHERE id = 'N-M5-explicit'),
  'defaults trigger fills NULLs only — an explicit value survives');

-- ── 2. notification_prefs RLS is self-only ────────────────────────────────
SET ROLE authenticated;
SELECT test.as_user('22222222-2222-2222-2222-222222222222');

SELECT test.assert_ok(
  $$INSERT INTO public.notification_prefs (user_id, group_id, muted)
    VALUES ('22222222-2222-2222-2222-222222222222', 'G1', true)$$,
  'a user can mute a group they are in');

SELECT test.assert_raises(
  $$INSERT INTO public.notification_prefs (user_id, group_id, muted)
    VALUES ('11111111-1111-1111-1111-111111111111', 'G1', true)$$,
  'row-level security',
  'a user CANNOT write a preference row for someone else  [self-only RLS]');

SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT test.assert(
  (SELECT count(*) FROM public.notification_prefs) = 0,
  'a user cannot SEE another user''s preference rows  [mutes are silent]',
  'visible rows: ' || (SELECT count(*)::text FROM public.notification_prefs));

-- The mute oracle itself must be unreachable from a client role.
SELECT test.assert_raises(
  $$SELECT public.notification_muted('22222222-2222-2222-2222-222222222222'::uuid, 'G1')$$,
  'permission denied',
  'notification_muted is not EXECUTE-able by authenticated  [no mute oracle]');

-- ── 3. A muted group writes no row, but the activity feed stays whole ─────
-- A (owner) adds an expense. B has muted G1; A is the actor so gets nothing
-- either way. Net: zero new notifications, one new group_events row.
RESET ROLE;
CREATE TEMP TABLE m5_before AS
SELECT (SELECT count(*) FROM public.notifications WHERE group_id = 'G1') AS notifs,
       (SELECT count(*) FROM public.group_events  WHERE group_id = 'G1') AS events;

SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                            paid_by, split_type, splits, created_by)
SELECT 'E-M5', auth.uid(), 'G1', 'Muted lunch', 40.00, 'M-A', 'equal',
       jsonb_build_array(
         jsonb_build_object('memberId', 'M-A', 'amount', 20.00),
         jsonb_build_object('memberId', (SELECT v FROM test.fixture WHERE k = 'M-B'),
                            'amount', 20.00)),
       auth.uid();

RESET ROLE;
SELECT test.assert(
  (SELECT count(*) FROM public.notifications WHERE group_id = 'G1')
    = (SELECT notifs FROM m5_before),
  'a muted group produces ZERO notification rows for the muter  [N-10]',
  'delta: ' || ((SELECT count(*) FROM public.notifications WHERE group_id = 'G1')
                 - (SELECT notifs FROM m5_before))::text);

SELECT test.assert(
  (SELECT count(*) FROM public.group_events WHERE group_id = 'G1')
    = (SELECT events FROM m5_before) + 1,
  'the shared group_events activity row is STILL written for a muted group',
  'delta: ' || ((SELECT count(*) FROM public.group_events WHERE group_id = 'G1')
                 - (SELECT events FROM m5_before))::text);

-- Unmute and prove the same write now reaches B.
UPDATE public.notification_prefs SET muted = false
 WHERE user_id = '22222222-2222-2222-2222-222222222222' AND group_id = 'G1';

SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                            paid_by, split_type, splits, created_by)
SELECT 'E-M5b', auth.uid(), 'G1', 'Unmuted lunch', 40.00, 'M-A', 'equal',
       jsonb_build_array(
         jsonb_build_object('memberId', 'M-A', 'amount', 20.00),
         jsonb_build_object('memberId', (SELECT v FROM test.fixture WHERE k = 'M-B'),
                            'amount', 20.00)),
       auth.uid();

RESET ROLE;
SELECT test.assert(
  EXISTS (SELECT 1 FROM public.notifications
           WHERE user_id = '22222222-2222-2222-2222-222222222222'
             AND template = 'expense_added'
             AND params->>'expenseId' = 'E-M5b'),
  'unmuting restores fan-out to that member');

-- ── 4. member_left (audit N-11) ───────────────────────────────────────────
-- C left in 00-fixtures via leave_group() — which ran BEFORE this migration
-- installed the trigger. Re-run the transition on a fresh member so the test
-- does not depend on fixture ordering.
RESET ROLE;
INSERT INTO group_members (id, group_id, profile_id, display_name, role, status, invited_by, joined_at)
VALUES ('M-M5D', 'G1', '44444444-4444-4444-4444-444444444444', 'Danish', 'member', 'connected',
        '11111111-1111-1111-1111-111111111111', now());

UPDATE public.group_members SET status = 'left' WHERE id = 'M-M5D';

SELECT test.assert(
  EXISTS (SELECT 1 FROM public.notifications
           WHERE template = 'member_left'
             AND user_id = '11111111-1111-1111-1111-111111111111'),
  'a member leaving notifies the remaining connected members  [N-11]',
  'member_left rows: ' || (SELECT count(*)::text FROM public.notifications WHERE template = 'member_left'));

SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM public.notifications
               WHERE template = 'member_left'
                 AND user_id = '44444444-4444-4444-4444-444444444444'),
  'the leaver is not notified about their own departure');

SELECT test.assert(
  EXISTS (SELECT 1 FROM public.group_events
           WHERE group_id = 'G1' AND event_type = 'member_left'
             AND summary LIKE '%left the group%'),
  'member_left writes a third-person activity row, not the reader-addressed body',
  COALESCE((SELECT summary FROM public.group_events WHERE event_type = 'member_left' LIMIT 1), '(none)'));

-- A second UPDATE that does not change status must not re-announce.
CREATE TEMP TABLE m5_left_before AS
SELECT count(*) AS n FROM public.notifications WHERE template = 'member_left';
UPDATE public.group_members SET display_name = 'Danish K' WHERE id = 'M-M5D';
SELECT test.assert(
  (SELECT count(*) FROM public.notifications WHERE template = 'member_left')
    = (SELECT n FROM m5_left_before),
  'editing a left member''s row does not re-announce the departure');

-- ── 5. Quiet hours ────────────────────────────────────────────────────────
INSERT INTO public.notification_prefs (user_id, group_id, muted, quiet_hours_start, quiet_hours_end, tz)
VALUES ('33333333-3333-3333-3333-333333333333', NULL, false, 22, 7, 'Asia/Karachi');

SELECT test.assert(
  public.notification_in_quiet_hours('33333333-3333-3333-3333-333333333333',
    TIMESTAMPTZ '2026-09-02 18:30:00+00'),   -- 23:30 PKT
  'a wrapping window (22 → 07) is quiet at 23:30 local');

SELECT test.assert(
  public.notification_in_quiet_hours('33333333-3333-3333-3333-333333333333',
    TIMESTAMPTZ '2026-09-02 01:00:00+00'),   -- 06:00 PKT
  'a wrapping window is still quiet at 06:00 local');

SELECT test.assert(
  NOT public.notification_in_quiet_hours('33333333-3333-3333-3333-333333333333',
    TIMESTAMPTZ '2026-09-02 07:00:00+00'),   -- 12:00 PKT
  'a wrapping window is NOT quiet at midday');

-- Same instant, different tz → different verdict. This is the whole point.
UPDATE public.notification_prefs SET tz = 'America/New_York'
 WHERE user_id = '33333333-3333-3333-3333-333333333333' AND group_id IS NULL;
SELECT test.assert(
  NOT public.notification_in_quiet_hours('33333333-3333-3333-3333-333333333333',
    TIMESTAMPTZ '2026-09-02 18:30:00+00'),   -- 14:30 EDT
  'quiet hours are evaluated in the RECIPIENT''s timezone');

-- A user with only a per-group row has no quiet window (quiet lives on the
-- global row only).
SELECT test.assert(
  NOT public.notification_in_quiet_hours('22222222-2222-2222-2222-222222222222', now()),
  'quiet hours are read from the global row only, never a per-group row');

-- A garbage tz degrades to the home market instead of erroring.
UPDATE public.notification_prefs SET tz = 'Not/AZone'
 WHERE user_id = '33333333-3333-3333-3333-333333333333' AND group_id IS NULL;
SELECT test.assert_ok(
  $$SELECT public.notification_in_quiet_hours('33333333-3333-3333-3333-333333333333', now())$$,
  'an invalid stored timezone never breaks the push path');

-- ── 6. Kameti (audit N-11) ────────────────────────────────────────────────
-- A runs a 3-round monthly kameti. B is a linked contact of A's, in slot 2.
-- C is an UNLINKED member (no person row) and must receive nothing.
RESET ROLE;
-- An earlier suite may already have linked A→B through the consent RPCs
-- (persons_user_profile_uniq allows only one). Reuse it if so.
INSERT INTO public.persons (id, user_id, name, linked_profile_id)
SELECT 'P-B', '11111111-1111-1111-1111-111111111111', 'Bilal',
       '22222222-2222-2222-2222-222222222222'
 WHERE NOT EXISTS (
   SELECT 1 FROM public.persons
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
      AND linked_profile_id = '22222222-2222-2222-2222-222222222222');

INSERT INTO test.fixture (k, v)
SELECT 'P-B', (SELECT id FROM public.persons
                WHERE user_id = '11111111-1111-1111-1111-111111111111'
                  AND linked_profile_id = '22222222-2222-2222-2222-222222222222'
                LIMIT 1)
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;

INSERT INTO public.committees
  (id, user_id, name, currency, contribution_amount, member_count, cadence,
   total_rounds, start_date, payout_method, status)
VALUES ('K1', '11111111-1111-1111-1111-111111111111', 'Office Kameti', 'PKR',
        5000, 3, 'monthly', 3, DATE '2026-09-02', 'ballot', 'active');

-- Slots are left NULL: on a ballot kameti a hand-written slot raises
-- BALLOT_SLOTS_SERVER_ONLY (audit-p0-kameti-draw.sql §3). The draw assigns
-- them.
INSERT INTO public.committee_members (id, committee_id, user_id, name, person_id, is_organizer)
VALUES ('KM-A', 'K1', '11111111-1111-1111-1111-111111111111', 'Ayesha', NULL, true),
       ('KM-B', 'K1', '11111111-1111-1111-1111-111111111111', 'Bilal',
        (SELECT v FROM test.fixture WHERE k = 'P-B'), false),
       ('KM-C', 'K1', '11111111-1111-1111-1111-111111111111', 'Chand',  NULL, false);

-- The real draw, through the real RPC, as the organiser.
SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
SELECT public.perform_committee_draw('K1');
RESET ROLE;

-- Remember B's drawn slot — the ballot decides it, so the payout assertions
-- below must ask rather than assume.
INSERT INTO test.fixture (k, v)
SELECT 'KM-B-slot', (SELECT slot::TEXT FROM public.committee_members WHERE id = 'KM-B')
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;

SELECT test.assert(
  (SELECT count(*) FROM public.notifications
    WHERE template = 'kameti_draw_completed') = 1,
  'a completed draw notifies exactly the profile-linked members  [N-11]',
  'rows: ' || (SELECT count(*)::text FROM public.notifications WHERE template = 'kameti_draw_completed'));

SELECT test.assert(
  (SELECT user_id FROM public.notifications WHERE template = 'kameti_draw_completed')
    = '22222222-2222-2222-2222-222222222222',
  'the linked member is notified; the unlinked one and the organiser are not');

SELECT test.assert(
  (SELECT href = '/kameti/K1' AND channel_id = 'kameti'
      AND collapse_key = 'kameti:K1:kameti_draw_completed'
      AND params->>'slot' = (SELECT v FROM test.fixture WHERE k = 'KM-B-slot')
     FROM public.notifications WHERE template = 'kameti_draw_completed'),
  'kameti rows deep-link to the kameti and carry the reader''s own drawn slot',
  (SELECT href || ' | ' || channel_id || ' | slot=' || COALESCE(params->>'slot','?')
     || ' | drawn=' || (SELECT v FROM test.fixture WHERE k = 'KM-B-slot')
     FROM public.notifications WHERE template = 'kameti_draw_completed'));

-- Sweep the date of B's OWN round: they should get both the collection
-- reminder and their payout notice. The ballot decides which round that is,
-- so the date is computed, not hardcoded.
SELECT public.notify_committee_rounds_due(
  public.committee_round_date(DATE '2026-09-02', 'monthly',
    (SELECT v FROM test.fixture WHERE k = 'KM-B-slot')::INT));

SELECT test.assert(
  EXISTS (SELECT 1 FROM public.notifications
           WHERE template = 'kameti_round_due'
             AND params->>'round' = (SELECT v FROM test.fixture WHERE k = 'KM-B-slot')
             AND user_id = '22222222-2222-2222-2222-222222222222'),
  'the round-due sweep notifies linked members on the round date  [N-11]');

SELECT test.assert(
  EXISTS (SELECT 1 FROM public.notifications
           WHERE template = 'kameti_payout_due'
             AND params->>'round' = (SELECT v FROM test.fixture WHERE k = 'KM-B-slot')
             AND user_id = '22222222-2222-2222-2222-222222222222'),
  'the slot holder for that round gets their own payout notification');

-- Idempotency: a second sweep the same day adds nothing.
CREATE TEMP TABLE m5_kameti_before AS
SELECT count(*) AS n FROM public.notifications WHERE type = 'kameti';
SELECT public.notify_committee_rounds_due(
  public.committee_round_date(DATE '2026-09-02', 'monthly',
    (SELECT v FROM test.fixture WHERE k = 'KM-B-slot')::INT));
SELECT test.assert(
  (SELECT count(*) FROM public.notifications WHERE type = 'kameti')
    = (SELECT n FROM m5_kameti_before),
  're-running the sweep the same day is a no-op  [20h collapse_key window]');

-- The ORGANISER's own round pays out to a member with no linked profile →
-- nobody is notified for that payout, even though round_due still reaches B.
SELECT public.notify_committee_rounds_due(
  public.committee_round_date(DATE '2026-09-02', 'monthly',
    (SELECT slot FROM public.committee_members WHERE id = 'KM-A')));
SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM public.notifications
               WHERE template = 'kameti_payout_due'
                 AND params->>'round' = (SELECT slot::TEXT FROM public.committee_members WHERE id = 'KM-A')),
  'an unlinked slot holder notifies NOBODY (empty array ≠ everyone)');

-- A fully-collected round is done and must not ring. Use C's round, which
-- neither sweep above has touched.
INSERT INTO public.committee_payments (id, committee_id, user_id, member_id, round)
SELECT 'KP-' || m.id, 'K1', '11111111-1111-1111-1111-111111111111', m.id,
       (SELECT slot FROM public.committee_members WHERE id = 'KM-C')
  FROM public.committee_members m WHERE m.committee_id = 'K1';
SELECT public.notify_committee_rounds_due(
  public.committee_round_date(DATE '2026-09-02', 'monthly',
    (SELECT slot FROM public.committee_members WHERE id = 'KM-C')));
SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM public.notifications
               WHERE template = 'kameti_round_due'
                 AND params->>'round' = (SELECT slot::TEXT FROM public.committee_members WHERE id = 'KM-C')),
  'a fully-collected round produces no reminder  [same gate as the local planner]');

-- ── 7. Pruning (audit N-12) ───────────────────────────────────────────────
INSERT INTO public.notifications (id, user_id, type, title, body, read_at, created_at) VALUES
  ('N-old-read',    '11111111-1111-1111-1111-111111111111', 'system', 'old read',    '', now() - interval '200 days', now() - interval '200 days'),
  ('N-old-unread',  '11111111-1111-1111-1111-111111111111', 'system', 'old unread',  '', NULL,                        now() - interval '200 days'),
  ('N-mid-read',    '11111111-1111-1111-1111-111111111111', 'system', 'mid read',    '', now() - interval '120 days', now() - interval '120 days'),
  ('N-mid-unread',  '11111111-1111-1111-1111-111111111111', 'system', 'mid unread',  '', NULL,                        now() - interval '120 days'),
  ('N-fresh-read',  '11111111-1111-1111-1111-111111111111', 'system', 'fresh read',  '', now(),                       now() - interval '2 days');

SELECT test.assert(public.prune_notifications() = 3,
  'prune deletes read>90d and unread>180d, and nothing else  [N-12]',
  'expected 3 (old-read, old-unread, mid-read)');

SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM public.notifications WHERE id IN ('N-old-read','N-old-unread','N-mid-read'))
  AND (SELECT count(*) FROM public.notifications WHERE id IN ('N-mid-unread','N-fresh-read')) = 2,
  'an unread 120-day-old item SURVIVES; a read one does not',
  'survivors: ' || (SELECT COALESCE(string_agg(id, ','), '(none)') FROM public.notifications
                     WHERE id LIKE 'N-%read' OR id LIKE 'N-%unread'));

SELECT test.assert(public.prune_notifications() = 0,
  'a second prune is a no-op');

RESET ROLE;
