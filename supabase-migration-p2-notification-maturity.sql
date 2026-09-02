-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P2 item M5: notification maturity
--   missing events · fatigue controls (mute + quiet hours + collapse/channels)
--   · deep links in the push payload · lifecycle pruning
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- ── APPLY ORDER ─────────────────────────────────────────────────────────────
-- Apply AFTER `supabase-migration-p2-trust-safety.sql`, which is itself the
-- last file of the corpus (docs/audit-2026-09/APPLY-ORDER.md §2 steps 1-11,
-- then every supabase-migration-p1-*.sql, then p2-trust-safety).
--
-- This file CREATE-OR-REPLACEs three functions whose CURRENT definitions live
-- elsewhere. Applying it BEFORE the file named below would be silently undone:
--
--   supabase-migration-p2-trust-safety.sql §4.4
--        fan_out_group_notification          ← THE LATEST DEFINITION.
--        Section 5 below rebuilds it from the p2 body verbatim and adds
--        exactly ONE marked line. If you are reading this after another file
--        has replaced it again, re-derive from THAT body, not from
--        supabase-migration-audit-p0-notifications.sql §4 (which p2 already
--        superseded by adding the `is_blocked_either_way` recipient filter).
--   supabase-migration-audit-p0-notifications.sql §3
--        group_notification_text             (Section 4 adds `member_left`;
--        p2-trust-safety does NOT touch this function)
--   supabase-migration-connections-push-discovery.sql §6
--        tg_notifications_push               (Section 8 adds the new payload
--        fields; nothing else has replaced it)
--
-- Hard prerequisites (objects this file reads or extends):
--   public.notifications (+ template/params/actor_id)  audit-p0-notifications
--   public.group_events, public.split_groups, public.group_members  schema
--   public.is_blocked_either_way(UUID, UUID)           p2-trust-safety §1
--   public.committees / committee_members / committee_payments  committees
--   public.persons.linked_profile_id                   phase2a-linked-profile
--   public.app_push_config, net.http_post              connections-push-disc.
--
-- ── BREAKING CHANGES FOR THE CLIENT ─────────────────────────────────────────
-- None. Everything here is additive:
--   • three nullable columns on `notifications` (a client that does not select
--     them is unaffected; supabaseDb.ts tolerates their absence);
--   • one new table (`notification_prefs`) the current client never reads;
--   • new notification rows of type 'group_update' (member_left) and a NEW
--     type 'kameti'. An un-updated client renders the server-composed
--     title/body for both and routes 'kameti' to /inbox — degraded, not
--     broken.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FIXES — evidence
-- ════════════════════════════════════════════════════════════════════════════
--
-- N-11 (docs/audit-2026-09/08-notifications.md:142-153) — "Important events
--   that generate no notification at all". The table names five gaps; this
--   file closes the three that are server-observable:
--     · "Kameti draw completed / round due / payout for members → None
--        cross-user — committees have no linked-member notifications anywhere
--        (committeeStore.ts has zero notification writes; only the owner's
--        local day-of reminder, notificationPlanner.ts:227-244)."
--        → Sections 6 and 7.
--     · "Group member left / removed you → member_joined is fanned out
--        (splitStore.ts:510, 592) but no member_left fan-out call exists.
--        Members discover silently."
--        → Section 5b. `leave_group` sets status='left'
--        (supabase-migration-safe-leave-group.sql:197) and the existing
--        tg_group_members_notify() returns NULL for any status <> 'connected'
--        (audit-p0-notifications.sql:372-374), so nothing fires today.
--     · "Budget breached → Derived Inbox Info card only … No push/local
--        reminder even when reminders are on."
--        → NOT IN THIS FILE, DELIBERATELY. Budgets are computed entirely on
--        the client (computeBudgetUsages in src/stores/budgetStore.ts:108 runs
--        over local `transactions`); the server never evaluates a budget and
--        adding a trigger for it would mean either duplicating that math in
--        SQL or writing rows the server cannot justify. It ships as a
--        DEVICE-LOCAL scheduled notification in src/lib/notificationPlanner.ts
--        (`budget:<id>:warn` / `budget:<id>:over`) — no notifications row, no
--        push, one device only. See docs/notifications.md §"Budget breach".
--   Settlement accepted/rejected is ALREADY covered and is deliberately NOT
--   duplicated here: tg_lsr_notify's UPDATE branch
--   (supabase-migration-linked-notifications-realtime.sql:96-109) notifies
--   new.from_user_id on pending→accepted and pending→rejected, and
--   tg_ltr_notify:52-65 does the same for loan requests. The audit says so
--   itself at 08-notifications.md:153.
--
-- N-10 (08-notifications.md:138-140) — "No quiet hours, no sound control, no
--   batching on the push path. Every notifications insert immediately becomes
--   a HIGH-priority, default_sound: true FCM message
--   (push-notify/index.ts:182-192) at whatever hour the actor acted — a
--   Gulf-based user adding expenses at 23:00 UAE rings phones in Pakistan at
--   midnight. … Android channels would also let users demote group noise vs.
--   money requests — currently all pushes are one undifferentiated channel."
--   → Sections 2 (prefs), 3 (channel/collapse/href defaults), 8 (payload).
--
-- N-8 (08-notifications.md:126-132) — "Tray/push deep links are shallow:
--   everything lands on /inbox or /groups. FCM payload carries only `type` and
--   `notification_id` (push-notify/index.ts:177-180)."
--   → Section 3 stamps an `href` on every row using the same rules as
--     src/lib/notificationContent.ts `notificationHref()`; Section 8 forwards
--     it.
--
-- N-12 (08-notifications.md:155-157) — "In-app channel has no lifecycle:
--   unbounded table, top-100 read window. No TTL, pruning, or archival exists
--   for notifications in any migration."
--   → Section 9.
--
-- Recommendation 8 (08-notifications.md:209) — "Anti-fatigue on push:
--   collapse-key per group thread, Android notification channels
--   (money-requests vs. group-activity), a quiet-hours window server-side …
--   and a summary notification instead of the silent >3 drop in
--   instantNotify.ts:111."  The last clause is client-side and ships in
--   src/lib/instantNotify.ts; everything else is here.
--
-- Recommendation 9 (08-notifications.md:210) — "Close the event gaps (N-11)".
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE FATIGUE MODEL — the four rules everything below implements
-- ════════════════════════════════════════════════════════════════════════════
--
-- RULE 1 — MUTE SUPPRESSES THE ROW. QUIET HOURS SUPPRESS ONLY THE RING.
--   A muted group writes NO notifications row for that recipient (the
--   group_events activity row is still written for everyone — same carve-out
--   the block filter already makes, p2-trust-safety:1621-1623). Quiet hours
--   never suppress a row: the in-app Inbox and bell must stay complete or the
--   user silently loses records. Quiet hours are evaluated at DELIVERY, in the
--   edge function, and only change how FCM presents the message.
--
-- RULE 2 — QUIET HOURS DELIVER SILENTLY, THEY DO NOT DEFER.
--   Inside the window the push is still sent, still lands in the tray, but
--   with android.priority NORMAL, notification_priority PRIORITY_LOW,
--   default_sound false and no vibration. The user wakes up to the
--   notification already there instead of being woken BY it.
--   Why not defer: pg_net is fire-and-forget with no scheduler and Supabase
--   has no queue here; deferring would need a pending-push table plus a cron
--   drain, i.e. a second delivery pipeline that can fail silently — exactly
--   the failure mode N-4 is about. Silent delivery gets ~90% of the benefit
--   for ~5% of the machinery. Documented in docs/notifications.md.
--
-- RULE 3 — EVERY ROW CARRIES ITS OWN ROUTING AND GROUPING.
--   `channel_id` (money | groups | kameti — 'reminders' is client-local),
--   `collapse_key` (group id + template, so ten expenses in one trip collapse
--   into one tray entry) and `href` are stamped by ONE BEFORE INSERT trigger
--   on `notifications`. That trigger covers writers this file does not own —
--   tg_ltr_notify, tg_lsr_notify, notify_contact_linked, respond_contact_link
--   — without editing their migrations.
--
-- RULE 4 — NOTHING NEW MAY BREAK A MONEY WRITE.
--   Every function added here is either an AFTER trigger that returns NULL, or
--   is called from one, and every one of them swallows its own errors the way
--   tg_notifications_push already does. A notification is never worth rolling
--   back a settlement.
--
-- ════════════════════════════════════════════════════════════════════════════
-- APP MODES
-- ════════════════════════════════════════════════════════════════════════════
-- Notifications are MODE-AGNOSTIC and this file keeps them that way. Nothing
-- below reads `accounts`, `transactions.source_account_id` or any other
-- full-tracker-only artifact: group fan-out keys off group_members, kameti off
-- committee_members, and the prefs/quiet-hours/pruning machinery is per-user.
-- A splits_only (ledger-only) user gets exactly the same rows, the same
-- channels and the same deep links as a full_tracker user. The one place the
-- distinction could have leaked in — the device-local budget reminder — is
-- client-side and budgets exist in both modes.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. Schema — routing/grouping columns on notifications
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS collapse_key TEXT;
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS channel_id TEXT;
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS href TEXT;

COMMENT ON COLUMN public.notifications.collapse_key IS
  'Tray grouping key forwarded to FCM as android.notification.tag and to the client as data.collapse_key. Ten expenses in one group collapse to one tray entry. Stamped by tg_notifications_defaults when the writer leaves it NULL.';
COMMENT ON COLUMN public.notifications.channel_id IS
  'Android notification channel: money | groups | kameti. (The fourth client channel, ''reminders'', is used only by device-local scheduled reminders and never appears on a row.) Lets a user demote group noise without losing loan requests.';
COMMENT ON COLUMN public.notifications.href IS
  'In-app route this notification opens, e.g. /group/<id>, /kameti/<id>, /inbox. Mirrors notificationHref() in src/lib/notificationContent.ts and closes audit N-8 (every push used to land on /inbox or /groups).';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. notification_prefs — per-recipient mute + quiet hours
--
-- One row per (user, group). group_id IS NULL is the user's GLOBAL row and is
-- the only row quiet_hours/tz are ever read from; per-group rows exist to
-- carry `muted`. A user with no rows at all has the product default: not
-- muted, no quiet hours.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.notification_prefs (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- NULL = the user's global row. Non-NULL = a per-group override.
  group_id          TEXT REFERENCES public.split_groups(id) ON DELETE CASCADE,
  muted             BOOLEAN NOT NULL DEFAULT FALSE,
  -- Local hours 0-23. Both NULL = no quiet hours. start = end is treated as
  -- "no window" rather than "24 hours of silence" — a 24h mute is what `muted`
  -- is for, and a mis-set slider must never silence a loan request forever.
  quiet_hours_start SMALLINT CHECK (quiet_hours_start IS NULL OR (quiet_hours_start BETWEEN 0 AND 23)),
  quiet_hours_end   SMALLINT CHECK (quiet_hours_end   IS NULL OR (quiet_hours_end   BETWEEN 0 AND 23)),
  -- IANA zone. 'Asia/Karachi' is the product's home market; the client sends
  -- Intl.DateTimeFormat().resolvedOptions().timeZone on first write.
  tz                TEXT NOT NULL DEFAULT 'Asia/Karachi',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (user, group) INCLUDING the global row. A plain UNIQUE would let
-- a user hold two global rows (NULLs are distinct in Postgres < 15's default
-- and under NULLS DISTINCT in 15+), which would make "am I muted" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS notification_prefs_user_scope_uidx
  ON public.notification_prefs (user_id, COALESCE(group_id, ''));

-- The mute lookup runs once per recipient per fan-out; keep it index-only.
CREATE INDEX IF NOT EXISTS notification_prefs_user_muted_idx
  ON public.notification_prefs (user_id)
  WHERE muted;

ALTER TABLE public.notification_prefs ENABLE ROW LEVEL SECURITY;

-- Self-only, all four verbs. A preference is nobody else's business — and in
-- particular "has X muted me" must not be answerable by anyone but X (the same
-- reasoning that keeps `blocks` unreadable, p2-trust-safety RULE 1).
DROP POLICY IF EXISTS notification_prefs_select_own ON public.notification_prefs;
CREATE POLICY notification_prefs_select_own ON public.notification_prefs
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS notification_prefs_insert_own ON public.notification_prefs;
CREATE POLICY notification_prefs_insert_own ON public.notification_prefs
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS notification_prefs_update_own ON public.notification_prefs;
CREATE POLICY notification_prefs_update_own ON public.notification_prefs
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS notification_prefs_delete_own ON public.notification_prefs;
CREATE POLICY notification_prefs_delete_own ON public.notification_prefs
  FOR DELETE TO authenticated USING (user_id = auth.uid());

COMMENT ON TABLE public.notification_prefs IS
  'Audit N-10: per-recipient notification fatigue controls. group_id NULL = global row (the only place quiet_hours/tz are read); group_id set = per-group mute. Self-only RLS.';

-- ── 2.1 Mute oracle ────────────────────────────────────────────────────────
-- SECURITY DEFINER because the fan-out runs as the definer but reads rows
-- belonging to the RECIPIENT, which RLS would otherwise hide. REVOKEd from
-- every client role for the same reason is_blocked_either_way is: granting it
-- would answer "has this person muted my group" to the person being muted.
CREATE OR REPLACE FUNCTION public.notification_muted(p_user UUID, p_group TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.notification_prefs np
        WHERE np.user_id = p_user
          AND np.muted
          -- The global row (group_id IS NULL) mutes everything; a per-group
          -- row mutes only that group. A NULL p_group therefore matches the
          -- global row only, which is what kameti/system events want.
          AND (np.group_id IS NULL OR np.group_id = p_group)
     );
$$;

REVOKE ALL ON FUNCTION public.notification_muted(UUID, TEXT) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.notification_muted(UUID, TEXT) IS
  'Audit N-10: TRUE when this recipient has muted this group, or muted everything. Never grant to a client role — mutes are one-sided and silent, like blocks.';

-- ── 2.2 Quiet-hours predicate ──────────────────────────────────────────────
-- Answers "is it currently quiet time for this user", in THEIR timezone, with
-- wrap-around (22:00 → 07:00 spans midnight). Read only by the push trigger.
CREATE OR REPLACE FUNCTION public.notification_in_quiet_hours(p_user UUID, p_at TIMESTAMPTZ DEFAULT now())
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start SMALLINT;
  v_end   SMALLINT;
  v_tz    TEXT;
  v_hour  INTEGER;
BEGIN
  IF p_user IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT np.quiet_hours_start, np.quiet_hours_end, np.tz
    INTO v_start, v_end, v_tz
    FROM public.notification_prefs np
   WHERE np.user_id = p_user
     AND np.group_id IS NULL;

  IF v_start IS NULL OR v_end IS NULL OR v_start = v_end THEN
    RETURN FALSE;  -- no window configured (see the CHECK comment in §2)
  END IF;

  BEGIN
    v_hour := EXTRACT(HOUR FROM (p_at AT TIME ZONE COALESCE(v_tz, 'Asia/Karachi')))::INTEGER;
  EXCEPTION WHEN OTHERS THEN
    -- A client that stored a garbage zone must not break push delivery.
    v_hour := EXTRACT(HOUR FROM (p_at AT TIME ZONE 'Asia/Karachi'))::INTEGER;
  END;

  IF v_start < v_end THEN
    RETURN v_hour >= v_start AND v_hour < v_end;          -- e.g. 01 → 06
  END IF;
  RETURN v_hour >= v_start OR v_hour < v_end;             -- e.g. 22 → 07
END;
$$;

REVOKE ALL ON FUNCTION public.notification_in_quiet_hours(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.notification_in_quiet_hours(UUID, TIMESTAMPTZ) IS
  'Audit N-10: TRUE when p_at falls inside the recipient''s configured quiet window, evaluated in their own tz with midnight wrap. Read by tg_notifications_push; the edge function turns it into a silent delivery, never a dropped row.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Routing/grouping defaults — ONE trigger, every writer
--
-- A BEFORE INSERT trigger rather than nine edits: the writers are spread over
-- five migrations (tg_ltr_notify, tg_lsr_notify, notify_contact_linked,
-- respond_contact_link, fan_out_group_notification, and the kameti helper
-- below), three of which this file has no business rewriting. Any writer may
-- still set the columns explicitly; the trigger only fills NULLs.
-- ═══════════════════════════════════════════════════════════════════════════

-- Channel catalog. Keep in step with CHANNELS in src/lib/pushRegistration.ts.
CREATE OR REPLACE FUNCTION public.notification_channel_for(p_type TEXT, p_template TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN COALESCE(p_template, '') LIKE 'kameti\_%' THEN 'kameti'
    WHEN p_type = 'kameti'                          THEN 'kameti'
    -- Money the reader must act on: a loan to confirm, a repayment to accept.
    -- This channel is the one that must survive a user demoting group noise.
    WHEN p_type IN ('linked_request', 'linked_settlement') THEN 'money'
    ELSE 'groups'
  END;
$$;

-- Deep-link catalog. MIRRORS notificationHref() in
-- src/lib/notificationContent.ts:146-159 — including its deliberate carve-out
-- that an 'invite' row goes to /groups and NOT /group/:id, because the
-- recipient is only `invited`, is_group_member() is false for them, and RLS
-- hides the group row: /group/:id would be a permanent "Loading…".
CREATE OR REPLACE FUNCTION public.notification_href_for(
  p_type TEXT, p_group_id TEXT, p_template TEXT, p_params JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN COALESCE(NULLIF(p_params->>'committeeId', ''), '') <> ''
     AND (COALESCE(p_template, '') LIKE 'kameti\_%' OR p_type = 'kameti')
      THEN '/kameti/' || (p_params->>'committeeId')
    WHEN p_type = 'group_update' AND COALESCE(p_group_id, '') <> ''
      THEN '/group/' || p_group_id
    WHEN p_type IN ('group_update', 'invite') THEN '/groups'
    ELSE '/inbox'
  END;
$$;

-- Collapse catalog. Group traffic collapses per (group, template): a trip
-- entered as ten expenses is ONE tray entry that keeps updating, instead of
-- ten (audit N-10: "adding 10 expenses to a group fires 10 pushes per
-- member"). Money items deliberately do NOT collapse with each other — two
-- different loan requests are two different decisions — so they fall back to
-- the row id, which is also what the pre-M5 push used as its tag
-- (push-notify/index.ts:190) and therefore preserves retry dedupe.
CREATE OR REPLACE FUNCTION public.notification_collapse_key_for(
  p_type TEXT, p_group_id TEXT, p_template TEXT, p_params JSONB, p_id TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN COALESCE(NULLIF(p_params->>'committeeId', ''), '') <> ''
     AND (COALESCE(p_template, '') LIKE 'kameti\_%' OR p_type = 'kameti')
      THEN 'kameti:' || (p_params->>'committeeId') || ':' || COALESCE(p_template, p_type)
    WHEN COALESCE(p_group_id, '') <> ''
      THEN 'group:' || p_group_id || ':' || COALESCE(p_template, p_type)
    ELSE COALESCE(p_type, 'system') || ':' || p_id
  END;
$$;

CREATE OR REPLACE FUNCTION public.tg_notifications_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.channel_id IS NULL THEN
    NEW.channel_id := public.notification_channel_for(NEW.type, NEW.template);
  END IF;
  IF NEW.href IS NULL THEN
    NEW.href := public.notification_href_for(NEW.type, NEW.group_id, NEW.template, NEW.params);
  END IF;
  IF NEW.collapse_key IS NULL THEN
    NEW.collapse_key := public.notification_collapse_key_for(
      NEW.type, NEW.group_id, NEW.template, NEW.params, NEW.id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Routing metadata is a nicety; the row is the record. Never let a bad
  -- params payload block a loan request from reaching someone's Inbox.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notifications_defaults ON public.notifications;
CREATE TRIGGER notifications_defaults
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.tg_notifications_defaults();

COMMENT ON FUNCTION public.tg_notifications_defaults() IS
  'Audit N-8/N-10: stamps channel_id, href and collapse_key on every notifications row, whichever migration''s trigger wrote it. Fills NULLs only.';

-- ── 3.1 Backfill the existing rows ─────────────────────────────────────────
-- Bounded and idempotent: only touches rows that have no channel yet.
UPDATE public.notifications n
   SET channel_id   = public.notification_channel_for(n.type, n.template),
       href         = public.notification_href_for(n.type, n.group_id, n.template, n.params),
       collapse_key = public.notification_collapse_key_for(n.type, n.group_id, n.template, n.params, n.id)
 WHERE n.channel_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Template catalog — add `member_left`
--
-- CREATE OR REPLACE of audit-p0-notifications.sql §3. That file is still the
-- latest definition (p2-trust-safety does not touch this function). The body
-- below is IDENTICAL to it except for the two lines marked [M5-a].
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.group_notification_text(
  p_template TEXT,
  p_params   JSONB
)
RETURNS TABLE (title TEXT, body TEXT)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_actor  TEXT := COALESCE(NULLIF(trim(p_params->>'actorName'), ''), 'A member');
  v_group  TEXT := COALESCE(NULLIF(trim(p_params->>'groupName'), ''), 'the group');
  v_desc   TEXT := COALESCE(NULLIF(trim(p_params->>'description'), ''), 'An expense');
  v_from   TEXT := COALESCE(NULLIF(trim(p_params->>'fromName'), ''), 'Someone');
  v_to     TEXT := COALESCE(NULLIF(trim(p_params->>'toName'), ''), 'someone');
  v_money  TEXT;
BEGIN
  IF (p_params->>'amount') IS NOT NULL THEN
    v_money := COALESCE(NULLIF(trim(p_params->>'currency'), ''), '')
      || CASE WHEN COALESCE(NULLIF(trim(p_params->>'currency'), ''), '') = '' THEN '' ELSE ' ' END
      || trim(to_char((p_params->>'amount')::NUMERIC, 'FM999999999990.00'));
  END IF;

  IF p_template = 'group_added' THEN
    title := 'Added to ' || v_group;
    body  := v_actor || ' added you to a shared group.';
  ELSIF p_template = 'member_joined' THEN
    title := v_actor || ' joined ' || v_group;
    body  := v_actor || ' is now connected to the group.';
  -- [M5-a] Audit N-11: "Group member left / removed you → Members discover
  -- silently." leave_group soft-deactivates to status='left'
  -- (safe-leave-group.sql:197) and nothing announced it.
  ELSIF p_template = 'member_left' THEN
    title := v_actor || ' left ' || v_group;
    body  := v_actor || ' is no longer in ' || v_group || '. Their past expenses and settlements stay in the ledger.';
  ELSIF p_template = 'expense_added' THEN
    title := v_actor || ' added an expense';
    body  := v_desc || COALESCE(' for ' || v_money, '') || ' was added in ' || v_group || '.';
  ELSIF p_template = 'expense_updated' THEN
    title := v_actor || ' updated an expense';
    body  := v_desc || ' was changed in ' || v_group || '.';
  ELSIF p_template = 'expense_deleted' THEN
    title := v_actor || ' deleted an expense';
    body  := v_desc || ' was removed from ' || v_group || '.';
  ELSIF p_template = 'settlement_added' THEN
    title := v_from || ' settled up';
    body  := v_from || ' settled ' || COALESCE(v_money, 'up') || ' with ' || v_to || ' in ' || v_group || '.';
  ELSIF p_template = 'settlement_deleted' THEN
    title := v_actor || ' removed a settlement';
    body  := 'The ' || v_from || ' → ' || v_to || ' settlement in ' || v_group || ' was undone.';
  ELSE
    title := 'Update in ' || v_group;
    body  := v_actor || ' made a change in ' || v_group || '.';
  END IF;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.group_notification_text(TEXT, JSONB) IS
  'Fixed server-side template catalog for group notifications. The ONLY source of notification title/body for group events — clients can no longer author them (audit H5). M5 adds member_left.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. fan_out_group_notification — mute filter
--
-- CREATE OR REPLACE on the CURRENT definition, which is
-- supabase-migration-p2-trust-safety.sql §4.4 (NOT audit-p0-notifications.sql
-- §4 — p2 already added the is_blocked_either_way recipient filter [F1] and
-- the group_events carve-out comment). The body below is that p2 body VERBATIM
-- except for the four lines marked [M5-b].
--
--   mini-diff vs. supabase-migration-p2-trust-safety.sql:1549-1676
--   ------------------------------------------------------------------------
--        AND NOT public.is_blocked_either_way(p_actor, gm.profile_id)
--   +   -- [M5-b] Audit N-10 …
--   +   AND NOT public.notification_muted(gm.profile_id, p_group_id)
--        LIMIT c_max_recipients
--   ------------------------------------------------------------------------
--   Nothing else changes. channel_id / href / collapse_key are stamped by the
--   Section 3 BEFORE INSERT trigger, which is exactly why this function did
--   not need a wider edit.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fan_out_group_notification(
  p_group_id    TEXT,
  p_actor       UUID,
  p_event_type  TEXT,
  p_entity_type TEXT,
  p_entity_id   TEXT,
  p_template    TEXT,
  p_params      JSONB,
  p_recipients  UUID[] DEFAULT NULL,  -- NULL = every other connected member
  -- Optional third-person text for the shared group_events feed. The
  -- notification body is written TO one reader ("… added you …"), which reads
  -- wrong in a feed everyone sees. '{actor}' is substituted.
  p_event_summary TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- One actor may cause at most this many notification rows per rolling
  -- minute. A 20-member group expense costs 19, so this comfortably covers
  -- honest bursts (a trip being entered) while capping a flood attack and
  -- the FCM quota burn it would drive.
  c_max_per_minute CONSTANT INTEGER := 120;
  -- No legitimate Hisaab group is anywhere near this size; the cap stops one
  -- pathological group from becoming an amplifier.
  c_max_recipients CONSTANT INTEGER := 100;

  v_group      public.split_groups%ROWTYPE;
  v_actor_name TEXT;
  v_params     JSONB;
  v_title      TEXT;
  v_body       TEXT;
  v_event_id   TEXT := gen_random_uuid()::TEXT;
  v_recent     INTEGER := 0;
BEGIN
  SELECT * INTO v_group FROM public.split_groups WHERE id = p_group_id;
  IF v_group.id IS NULL THEN
    RETURN;  -- group already gone (cascade delete) — nothing to announce.
  END IF;

  SELECT COALESCE(NULLIF(trim(p.name), ''), 'A Hisaab user')
    INTO v_actor_name
    FROM public.profiles p
   WHERE p.id = p_actor;

  -- The actor's group display name is friendlier than their profile name and
  -- matches what the other members see in the member list.
  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), v_actor_name)
    INTO v_actor_name
    FROM public.group_members gm
   WHERE gm.group_id = p_group_id
     AND gm.profile_id = p_actor
   ORDER BY gm.created_at
   LIMIT 1;

  v_params := COALESCE(p_params, '{}'::jsonb)
    || jsonb_build_object(
         'groupId',   p_group_id,
         'groupName', v_group.name,
         'currency',  v_group.currency,
         'actorName', COALESCE(v_actor_name, 'A member')
       );

  SELECT t.title, t.body INTO v_title, v_body
    FROM public.group_notification_text(p_template, v_params) AS t;

  -- The activity row is written unconditionally: it is the durable record of
  -- what happened and must survive both the rate limit and a zero-recipient
  -- group. Previously client-written (splitStore.ts:260) and therefore lost
  -- whenever the actor went offline mid-write (audit N-2).
  -- It is ALSO not filtered by blocks: group_events is the shared ledger of a
  -- group both parties chose to remain in, and per-viewer holes in it would
  -- desynchronise the activity feed and every balance narrative built on it.
  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload, created_at
  ) VALUES (
    v_event_id, p_group_id, p_actor, p_event_type, p_entity_type, p_entity_id,
    left(
      COALESCE(
        replace(p_event_summary, '{actor}', COALESCE(v_actor_name, 'A member')),
        v_body
      ),
      500
    ),
    v_params, now()
  );

  -- Per-sender rate limit. Over the limit we skip SILENTLY — the audit's
  -- requirement — because raising here would roll back the money write that
  -- fired this trigger.
  IF p_actor IS NOT NULL THEN
    SELECT count(*) INTO v_recent
      FROM public.notifications n
     WHERE n.actor_id = p_actor
       AND n.created_at > now() - interval '1 minute';
    IF v_recent >= c_max_per_minute THEN
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.notifications (
    id, user_id, group_id, event_id, type, title, body,
    template, params, actor_id, read_at, created_at
  )
  SELECT
    gen_random_uuid()::TEXT, r.profile_id, p_group_id, v_event_id,
    'group_update', left(v_title, 200), left(v_body, 1000),
    p_template, v_params, p_actor, NULL, now()
  FROM (
    SELECT DISTINCT gm.profile_id
      FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.status = 'connected'
       AND gm.profile_id IS NOT NULL
       AND gm.profile_id IS DISTINCT FROM p_actor
       AND (p_recipients IS NULL OR gm.profile_id = ANY (p_recipients))
       -- [F1] Audit M17: no push, no inbox row, between a blocked pair. The
       -- group_events row above still exists for both of them. p_actor may be
       -- NULL (system events) — is_blocked_either_way(NULL, x) is false, so
       -- those fan out unchanged.
       AND NOT public.is_blocked_either_way(p_actor, gm.profile_id)
       -- [M5-b] Audit N-10: a muted group writes NO row for that recipient.
       -- Same carve-out as the block filter: the group_events row above is
       -- written for everyone, so the shared activity feed stays whole and
       -- the member still sees the change when they open the group.
       AND NOT public.notification_muted(gm.profile_id, p_group_id)
     LIMIT c_max_recipients
  ) AS r;
END;
$$;

COMMENT ON FUNCTION public.fan_out_group_notification(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID[], TEXT) IS
  'Writes the durable group_events activity row plus template-composed notifications for the other connected members. Rate-limited per actor; over the limit notifications are skipped silently and the activity row still commits. Audit M17: blocked pairs are skipped. Audit N-10 (M5): recipients who muted this group are skipped. group_events is NOT filtered by either.';

REVOKE ALL ON FUNCTION public.fan_out_group_notification(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID[], TEXT) FROM PUBLIC, anon, authenticated;

-- ── 5b. member_left ────────────────────────────────────────────────────────
-- A SEPARATE trigger rather than an edit to tg_group_members_notify(), which
-- is owned by supabase-migration-audit-p0-notifications.sql §5 and bails at
-- its first statement for any status <> 'connected' (line 372). Composing
-- instead of replacing keeps that file's join/add semantics untouched; the two
-- triggers are mutually exclusive by construction (one fires only on
-- becoming-connected, the other only on leaving-connected).
CREATE OR REPLACE FUNCTION public.tg_group_members_notify_left()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- The leaver is the actor. leave_group() is self-service so auth.uid() is
  -- normally them; the COALESCE covers an owner-side removal and any
  -- definer-context UPDATE where auth.uid() is NULL.
  v_actor UUID := COALESCE(auth.uid(), OLD.profile_id, NEW.profile_id);
  v_name  TEXT := COALESCE(NULLIF(trim(NEW.display_name), ''), 'A member');
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;
  IF OLD.status <> 'connected' OR NEW.status NOT IN ('left', 'removed') THEN
    RETURN NULL;
  END IF;
  IF NEW.profile_id IS NULL THEN
    RETURN NULL;  -- a guest slot being deactivated announces nothing.
  END IF;

  -- The leaver is already status<>'connected' by the time this AFTER trigger
  -- runs, so fan_out's own recipient filter excludes them without help.
  PERFORM public.fan_out_group_notification(
    NEW.group_id, v_actor, 'member_left', 'member', NEW.id,
    'member_left', jsonb_build_object('memberId', NEW.id, 'memberName', v_name),
    NULL::UUID[],
    '{actor} left the group'
  );

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- leave_group() returns a status object the client renders; a notification
  -- failure must never turn a successful leave into an error.
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS group_members_notify_left ON public.group_members;
CREATE TRIGGER group_members_notify_left
  AFTER UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_notify_left();

COMMENT ON FUNCTION public.tg_group_members_notify_left() IS
  'Audit N-11: announces a member leaving (status connected → left/removed). Composes with tg_group_members_notify, which only handles becoming-connected.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6. Kameti (committee) notifications for profile-linked members
--
-- Committees are single-owner tables (supabase-migration-committees.sql: RLS
-- is owner-only on all three), so there is no group_members table to fan out
-- over and fan_out_group_notification cannot be reused — it requires a
-- split_groups row and writes a group_events row.
--
-- WHO IS NOTIFIED: a committee member is reachable only if the organiser
-- linked them to a real Hisaab account. The chain is
--   committee_members.person_id → persons.id → persons.linked_profile_id
-- (persons.linked_profile_id added by
-- supabase-migration-phase2a-linked-profile.sql:8, and only ever written by
-- the consent-gated link RPCs after audit-p0-consent-guards.sql H2). Members
-- with no person_id, an unlinked person, or an exited_at are not reachable and
-- get nothing — the witness link (get_committee_witness) remains their channel.
-- The organiser is never notified: they are the actor, and they already have
-- the device-local day-of reminder (notificationPlanner.ts:227-244).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.notify_committee_members(
  p_committee_id TEXT,
  p_template     TEXT,       -- kameti_draw_completed | kameti_round_due | kameti_payout_due
  p_round        INTEGER DEFAULT NULL,
  p_recipients   UUID[] DEFAULT NULL   -- NULL = every reachable linked member
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_max_recipients CONSTANT INTEGER := 100;

  v            public.committees%ROWTYPE;
  v_money      TEXT;
  v_title      TEXT;
  v_body       TEXT;
  v_inserted   INTEGER := 0;
BEGIN
  SELECT * INTO v FROM public.committees WHERE id = p_committee_id;
  IF v.id IS NULL THEN
    RETURN 0;
  END IF;

  v_money := v.currency || ' ' || trim(to_char(v.contribution_amount, 'FM999999999990.00'));

  IF p_template = 'kameti_draw_completed' THEN
    v_title := 'Kameti order drawn — ' || v.name;
    v_body  := 'The ballot for ' || v.name || ' is done. Open the kameti to see your turn and verify the draw.';
  ELSIF p_template = 'kameti_round_due' THEN
    v_title := v.name || ' — round ' || COALESCE(p_round, 0) || ' due';
    v_body  := 'Round ' || COALESCE(p_round, 0) || ' of ' || v.name || ' is due today: ' || v_money || ' per member.';
  ELSIF p_template = 'kameti_payout_due' THEN
    v_title := 'Your kameti turn — ' || v.name;
    v_body  := 'Round ' || COALESCE(p_round, 0) || ' of ' || v.name || ' pays out to you. Confirm with the organiser once you receive it.';
  ELSE
    RETURN 0;
  END IF;

  INSERT INTO public.notifications (
    id, user_id, group_id, event_id, type, title, body,
    template, params, actor_id, read_at, created_at
  )
  SELECT
    gen_random_uuid()::TEXT, r.profile_id, NULL, NULL,
    'kameti', left(v_title, 200), left(v_body, 1000),
    p_template,
    jsonb_build_object(
      'committeeId',   v.id,
      'committeeName', v.name,
      'currency',      v.currency,
      'amount',        v.contribution_amount,
      'round',         p_round,
      'slot',          r.slot,
      'memberName',    r.member_name
    ),
    v.user_id, NULL, now()
  FROM (
    SELECT DISTINCT ON (pr.linked_profile_id)
           pr.linked_profile_id AS profile_id,
           cm.slot              AS slot,
           cm.name              AS member_name
      FROM public.committee_members cm
      JOIN public.persons pr
        ON pr.id = cm.person_id
       AND pr.user_id = v.user_id        -- the organiser's own contact list
     WHERE cm.committee_id = v.id
       AND cm.exited_at IS NULL
       AND pr.linked_profile_id IS NOT NULL
       -- Never notify the organiser about their own committee.
       AND pr.linked_profile_id IS DISTINCT FROM v.user_id
       AND (p_recipients IS NULL OR pr.linked_profile_id = ANY (p_recipients))
       -- Audit M17: a blocked pair exchanges nothing, kameti included.
       AND NOT public.is_blocked_either_way(v.user_id, pr.linked_profile_id)
       -- Audit N-10: kameti rows honour the recipient's GLOBAL mute (there is
       -- no group to mute per-thread; NULL p_group matches the global row).
       AND NOT public.notification_muted(pr.linked_profile_id, NULL)
     ORDER BY pr.linked_profile_id, cm.slot NULLS LAST, cm.created_at
     LIMIT c_max_recipients
  ) AS r;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
EXCEPTION WHEN OTHERS THEN
  -- Called from a trigger on the draw path. perform_committee_draw() is the
  -- provably-fair ballot; it must commit whatever happens here.
  RETURN 0;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_committee_members(TEXT, TEXT, INTEGER, UUID[]) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.notify_committee_members(TEXT, TEXT, INTEGER, UUID[]) IS
  'Audit N-11: notifies the profile-linked members of a committee (committee_members.person_id → persons.linked_profile_id). Organiser excluded; blocks and global mutes honoured. Never raises.';

-- ── 6.1 Draw completed ─────────────────────────────────────────────────────
-- perform_committee_draw() (audit-p0-kameti-draw.sql:217-224) stamps drawn_at,
-- draw_seed, draw_commitment and draw_scheme in ONE update. Keying off
-- drawn_at NULL → NOT NULL makes this fire exactly once, including for the
-- legacy client-side draw path that also sets drawn_at.
CREATE OR REPLACE FUNCTION public.tg_committees_notify_draw()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.drawn_at IS NULL AND NEW.drawn_at IS NOT NULL THEN
    PERFORM public.notify_committee_members(NEW.id, 'kameti_draw_completed', NULL, NULL);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS committees_notify_draw ON public.committees;
CREATE TRIGGER committees_notify_draw
  AFTER UPDATE ON public.committees
  FOR EACH ROW EXECUTE FUNCTION public.tg_committees_notify_draw();

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 7. Kameti round-due / payout-due sweep
--
-- These are DATE-driven, not event-driven: nothing in the database changes on
-- the day a round falls due, so there is no row to hang a trigger on. The
-- sweep below is the server half; it is scheduled by pg_cron in Section 9 when
-- the extension exists, and can be run by hand or from a dashboard scheduler
-- otherwise (see the notice that section raises).
--
-- Round dates mirror roundDate() in src/lib/committeeMath.ts:11-17 exactly:
--   start_date + (round - 1) × {1 day | 1 week | 1 month}
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.committee_round_date(
  p_start DATE, p_cadence TEXT, p_round INTEGER
)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_cadence
    WHEN 'daily'  THEN p_start + ((p_round - 1) || ' days')::INTERVAL
    WHEN 'weekly' THEN p_start + ((p_round - 1) || ' weeks')::INTERVAL
    ELSE               p_start + ((p_round - 1) || ' months')::INTERVAL
  END::DATE;
$$;

CREATE OR REPLACE FUNCTION public.notify_committee_rounds_due(p_on DATE DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Local dates in the home market. A round "due today" for a Karachi kameti
  -- should not fire on a UTC boundary six hours early.
  v_day   DATE := COALESCE(p_on, (now() AT TIME ZONE 'Asia/Karachi')::DATE);
  v_total INTEGER := 0;
  r       RECORD;
  v_paid  INTEGER;
BEGIN
  FOR r IN
    SELECT c.id, c.user_id, c.total_rounds, c.member_count, c.start_date, c.cadence,
           gs.round
      FROM public.committees c
      CROSS JOIN LATERAL generate_series(1, GREATEST(c.total_rounds, 1)) AS gs(round)
     WHERE c.status = 'active'
       AND public.committee_round_date(c.start_date, c.cadence, gs.round) = v_day
  LOOP
    -- Same outstanding-ness gate the local planner uses
    -- (notificationPlanner.ts:232): a round already fully collected is DONE
    -- and must not ring.
    SELECT count(*) INTO v_paid
      FROM public.committee_payments p
     WHERE p.committee_id = r.id AND p.round = r.round;

    IF v_paid < r.member_count THEN
      -- Idempotency: the sweep may run more than once a day (a retry, a manual
      -- run, two cron nodes). One collapse_key per (committee, template) plus
      -- a 20-hour window means at most one of each per day per recipient.
      IF NOT EXISTS (
        SELECT 1 FROM public.notifications n
         WHERE n.collapse_key = 'kameti:' || r.id || ':kameti_round_due'
           AND n.created_at > now() - interval '20 hours'
      ) THEN
        v_total := v_total + public.notify_committee_members(r.id, 'kameti_round_due', r.round, NULL);
      END IF;
    END IF;

    -- Payout: the member holding this round's slot, whoever they are, even if
    -- the round is already collected — receiving is the event, not paying.
    IF NOT EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.collapse_key = 'kameti:' || r.id || ':kameti_payout_due'
         AND n.params->>'round' = r.round::TEXT
         AND n.created_at > now() - interval '20 hours'
    ) THEN
      v_total := v_total + public.notify_committee_members(
        r.id, 'kameti_payout_due', r.round,
        ARRAY(
          SELECT pr.linked_profile_id
            FROM public.committee_members cm
            JOIN public.persons pr ON pr.id = cm.person_id AND pr.user_id = r.user_id
           WHERE cm.committee_id = r.id
             AND cm.slot = r.round
             AND cm.exited_at IS NULL
             AND cm.payout_received_at IS NULL
             AND pr.linked_profile_id IS NOT NULL
        )::UUID[]
      );
    END IF;
  END LOOP;

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_committee_rounds_due(DATE) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.notify_committee_rounds_due(DATE) IS
  'Audit N-11: daily sweep emitting kameti_round_due (all linked members, only while the round is not fully collected) and kameti_payout_due (this round''s slot holder). Idempotent within 20 hours via collapse_key. Schedule with pg_cron (§9) or an external scheduler.';

-- NOTE ON payout_due AND AN EMPTY RECIPIENT ARRAY:
-- ARRAY(...)::UUID[] is `{}` when the slot holder is not profile-linked. That
-- is NOT the same as NULL — notify_committee_members treats NULL as "everyone"
-- and an empty array as "nobody", so an unlinked slot holder correctly
-- notifies no one instead of spamming the whole circle.

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 8. Push dispatch — carry channel, collapse key, deep link, quiet flag
--
-- CREATE OR REPLACE of supabase-migration-connections-push-discovery.sql §6
-- (lines 450-488). Nothing else has replaced it. The body below is that body
-- verbatim except the lines marked [M5-c].
--
--   mini-diff vs. supabase-migration-connections-push-discovery.sql:450-488
--   ------------------------------------------------------------------------
--        body    := jsonb_build_object(
--          'user_id', new.user_id,
--          'title',   new.title,
--          'body',    new.body,
--          'type',    new.type,
--   +      'href',         new.href,
--   +      'channel_id',   new.channel_id,
--   +      'collapse_key', new.collapse_key,
--   +      'quiet',        public.notification_in_quiet_hours(new.user_id, now()),
--          'notification_id', new.id
--        )
--   ------------------------------------------------------------------------
--   `quiet` is COMPUTED here but ENFORCED in the edge function: the trigger has
--   cheap access to the recipient's prefs (the edge function would need an
--   extra REST round-trip per push), while the delivery decision — silent
--   notification vs. drop vs. defer — belongs with the FCM message builder.
--   Nothing here decides whether the push happens; a quiet-hours push is still
--   sent, just without sound or high priority. See RULE 2 in the header.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_notifications_push() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_url    TEXT;
  v_secret TEXT;
BEGIN
  SELECT value INTO v_url    FROM public.app_push_config WHERE key = 'edge_url';
  SELECT value INTO v_secret FROM public.app_push_config WHERE key = 'edge_secret';
  -- Not configured yet → in-app delivery only. No error, no noise.
  IF v_url IS NULL OR v_secret IS NULL THEN
    RETURN NULL;
  END IF;

  -- pg_net is fire-and-forget: the insert never waits on FCM, and a push
  -- failure can never roll back the notification the app depends on.
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-hisaab-push-secret', v_secret
    ),
    body    := jsonb_build_object(
      'user_id', new.user_id,
      'title',   new.title,
      'body',    new.body,
      'type',    new.type,
      -- [M5-c] Audit N-8: the tap target, so a "Ali added an expense in Flat
      -- 12" push opens Flat 12 instead of the top of /groups.
      'href',         new.href,
      -- [M5-c] Audit N-10: Android channel + tray collapse key, so group noise
      -- is demotable and a ten-expense trip is one tray entry.
      'channel_id',   new.channel_id,
      'collapse_key', new.collapse_key,
      -- [M5-c] Audit N-10: recipient-local quiet hours, evaluated here where
      -- the prefs row is one index lookup away. Enforced in the edge function.
      'quiet',        public.notification_in_quiet_hours(new.user_id, now()),
      'notification_id', new.id
    )
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- A broken push pipeline must never break the write that triggered it.
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS notifications_push ON public.notifications;
CREATE TRIGGER notifications_push
  AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.tg_notifications_push();

COMMENT ON FUNCTION public.tg_notifications_push() IS
  'notifications INSERT → push-notify edge function via pg_net. M5 adds href (N-8 deep links), channel_id + collapse_key (N-10 channels/collapse) and a recipient-local `quiet` flag the edge function turns into a silent delivery.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 9. Lifecycle — pruning (audit N-12)
--
-- "No TTL, pruning, or archival exists for notifications in any migration; the
--  client reads the newest 100 (supabaseDb.ts:1283-1291). … the table grows
--  forever behind an AFTER INSERT trigger that fires pg_net calls per row."
--
-- Read rows are disposable after 90 days. UNREAD rows get 180 — a user who has
-- not opened the app in three months should still find their loan request.
-- ═══════════════════════════════════════════════════════════════════════════

-- The prune predicate is (read_at IS NULL, created_at) shaped. A single index
-- on that pair serves both arms of the OR and keeps the delete from seq-
-- scanning a table whose whole problem is that it is large.
CREATE INDEX IF NOT EXISTS idx_notifications_prune
  ON public.notifications ((read_at IS NULL), created_at);

CREATE OR REPLACE FUNCTION public.prune_notifications(
  p_read_days   INTEGER DEFAULT 90,
  p_unread_days INTEGER DEFAULT 180,
  p_limit       INTEGER DEFAULT 20000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER := 0;
BEGIN
  -- Bounded per call so a first run on a large table cannot hold a long lock
  -- or blow up WAL. Re-run until it returns 0 (the cron job below runs daily,
  -- so a backlog drains over a few days without anyone watching).
  WITH doomed AS (
    SELECT n.id
      FROM public.notifications n
     WHERE (n.read_at IS NOT NULL AND n.created_at < now() - make_interval(days => p_read_days))
        OR (n.read_at IS NULL     AND n.created_at < now() - make_interval(days => p_unread_days))
     ORDER BY n.created_at
     LIMIT GREATEST(p_limit, 1)
  )
  DELETE FROM public.notifications n
   USING doomed d
   WHERE n.id = d.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_notifications(INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.prune_notifications(INTEGER, INTEGER, INTEGER) IS
  'Audit N-12: deletes read notifications older than 90 days and unread ones older than 180. Bounded per call (default 20k rows); returns the count deleted. Never grant to a client role.';

-- ── 9.1 Scheduling, guarded ────────────────────────────────────────────────
-- pg_cron is available on Supabase but is NOT enabled by default, and this
-- file must apply cleanly on a database without it (including the Docker test
-- harness). Guarded exactly like the rest of the corpus guards optional
-- extensions: check pg_extension, else raise a NOTICE telling the operator
-- what to do by hand.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- cron.schedule() with an existing jobname updates it on pg_cron >= 1.4
    -- but errors on older builds, so unschedule first and ignore "not found".
    BEGIN
      PERFORM cron.unschedule('hisaab-prune-notifications');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      PERFORM cron.unschedule('hisaab-kameti-rounds-due');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- 03:17 UTC ≈ 08:17 PKT — after the quiet window, before the day starts.
    PERFORM cron.schedule(
      'hisaab-prune-notifications', '17 3 * * *',
      'SELECT public.prune_notifications();'
    );
    -- 04:05 UTC ≈ 09:05 PKT, an hour after the local reminder hour (10:00
    -- local) would have covered the ORGANISER — members hear about the round
    -- at roughly the same time of day the organiser's own reminder fires.
    PERFORM cron.schedule(
      'hisaab-kameti-rounds-due', '5 4 * * *',
      'SELECT public.notify_committee_rounds_due();'
    );
    RAISE NOTICE 'p2-notification-maturity: pg_cron jobs scheduled (hisaab-prune-notifications, hisaab-kameti-rounds-due)';
  ELSE
    RAISE NOTICE 'p2-notification-maturity: pg_cron NOT installed — scheduling skipped.';
    RAISE NOTICE '  Enable it in Supabase Studio → Database → Extensions → pg_cron, then re-run THIS FILE (idempotent), or';
    RAISE NOTICE '  schedule these two statements daily from Studio → Integrations → Cron (or any external scheduler hitting a SECURITY DEFINER RPC):';
    RAISE NOTICE '    SELECT public.prune_notifications();          -- N-12 lifecycle';
    RAISE NOTICE '    SELECT public.notify_committee_rounds_due();  -- N-11 kameti round/payout';
  END IF;
END;
$$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION — read-only. Run after the COMMIT above.
-- Every assertion aborts with a descriptive message; a clean run prints
-- "p2-notification-maturity: OK".
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INTEGER;
  v_text  TEXT;
  v_title TEXT;
  v_body  TEXT;
  v_bool  BOOLEAN;
BEGIN
  -- 1. The three routing columns exist.
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'notifications'
     AND column_name IN ('collapse_key', 'channel_id', 'href');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'notifications is missing collapse_key/channel_id/href (found %)', v_count;
  END IF;

  -- 2. notification_prefs exists, has RLS, and every policy is self-only.
  IF to_regclass('public.notification_prefs') IS NULL THEN
    RAISE EXCEPTION 'notification_prefs is missing';
  END IF;
  SELECT relrowsecurity INTO v_bool FROM pg_class WHERE oid = 'public.notification_prefs'::regclass;
  IF NOT v_bool THEN
    RAISE EXCEPTION 'notification_prefs does not have RLS enabled';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'notification_prefs';
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'notification_prefs should have 4 policies (select/insert/update/delete), found %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'notification_prefs'
     AND COALESCE(qual, with_check) NOT LIKE '%auth.uid()%';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'notification_prefs has % policy/policies that are not self-scoped', v_count;
  END IF;

  -- 3. The mute / quiet-hours oracles are NOT client-callable (they answer
  --    "has this person silenced me", which the one-sided model forbids).
  IF has_function_privilege('authenticated', 'public.notification_muted(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'notification_muted is EXECUTE-able by authenticated';
  END IF;
  IF has_function_privilege('authenticated', 'public.notification_in_quiet_hours(uuid,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'notification_in_quiet_hours is EXECUTE-able by authenticated';
  END IF;
  IF has_function_privilege('authenticated', 'public.notify_committee_members(text,text,integer,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'notify_committee_members is EXECUTE-able by authenticated';
  END IF;
  IF has_function_privilege('authenticated', 'public.prune_notifications(integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'prune_notifications is EXECUTE-able by authenticated';
  END IF;

  -- 4. The fan-out still carries BOTH the p2 block filter and the new mute
  --    filter. A regression here would silently undo M17 or M5.
  SELECT prosrc INTO v_text FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fan_out_group_notification';
  IF v_text NOT LIKE '%is_blocked_either_way%' THEN
    RAISE EXCEPTION 'fan_out_group_notification lost the M17 block filter — this file was applied BEFORE p2-trust-safety';
  END IF;
  IF v_text NOT LIKE '%notification_muted%' THEN
    RAISE EXCEPTION 'fan_out_group_notification is missing the M5 mute filter';
  END IF;

  -- 5. The push payload carries the four new fields.
  SELECT prosrc INTO v_text FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tg_notifications_push';
  IF v_text NOT LIKE '%''href''%' OR v_text NOT LIKE '%''channel_id''%'
     OR v_text NOT LIKE '%''collapse_key''%' OR v_text NOT LIKE '%''quiet''%' THEN
    RAISE EXCEPTION 'tg_notifications_push does not forward href/channel_id/collapse_key/quiet';
  END IF;

  -- 6. Triggers installed.
  FOR v_text IN
    SELECT unnest(ARRAY['notifications_defaults', 'group_members_notify_left',
                        'committees_notify_draw', 'notifications_push'])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = v_text AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'trigger % is missing', v_text;
    END IF;
  END LOOP;
  -- …and the audit-p0 join/add trigger still exists alongside ours.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'group_members_notify' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'group_members_notify (audit-p0) was clobbered';
  END IF;

  -- 7. member_left composes non-empty text.
  SELECT t.title, t.body INTO v_title, v_body
    FROM public.group_notification_text('member_left',
      jsonb_build_object('actorName', 'Ali', 'groupName', 'Flat 12')) AS t;
  IF COALESCE(v_title, '') = '' OR COALESCE(v_body, '') = '' THEN
    RAISE EXCEPTION 'template member_left composed empty text';
  END IF;
  -- …and every pre-existing template still does (no regression in §4).
  FOR v_text IN
    SELECT unnest(ARRAY['group_added', 'member_joined', 'expense_added', 'expense_updated',
                        'expense_deleted', 'settlement_added', 'settlement_deleted', 'nonsense_key'])
  LOOP
    SELECT t.title, t.body INTO v_title, v_body
      FROM public.group_notification_text(v_text,
        jsonb_build_object('actorName','Ali','groupName','Flat 12','currency','AED',
                           'description','Groceries','amount',250.5,
                           'fromName','Ali','toName','Sara')) AS t;
    IF COALESCE(v_title, '') = '' OR COALESCE(v_body, '') = '' THEN
      RAISE EXCEPTION 'template % composed empty text', v_text;
    END IF;
  END LOOP;

  -- 8. Routing helpers agree with src/lib/notificationContent.ts.
  IF public.notification_href_for('group_update', 'g1', 'expense_added', '{}'::jsonb) <> '/group/g1' THEN
    RAISE EXCEPTION 'href_for(group_update with group) should be /group/g1';
  END IF;
  IF public.notification_href_for('invite', 'g1', NULL, '{}'::jsonb) <> '/groups' THEN
    RAISE EXCEPTION 'href_for(invite) must be /groups, never /group/:id (RLS hides the group from an invitee)';
  END IF;
  IF public.notification_href_for('linked_request', NULL, NULL, '{}'::jsonb) <> '/inbox' THEN
    RAISE EXCEPTION 'href_for(linked_request) should be /inbox';
  END IF;
  IF public.notification_href_for('kameti', NULL, 'kameti_round_due',
       jsonb_build_object('committeeId','c1')) <> '/kameti/c1' THEN
    RAISE EXCEPTION 'href_for(kameti) should be /kameti/c1';
  END IF;
  IF public.notification_channel_for('linked_settlement', NULL) <> 'money' THEN
    RAISE EXCEPTION 'channel_for(linked_settlement) should be money';
  END IF;
  IF public.notification_channel_for('group_update', 'expense_added') <> 'groups' THEN
    RAISE EXCEPTION 'channel_for(group_update) should be groups';
  END IF;
  IF public.notification_channel_for('kameti', 'kameti_draw_completed') <> 'kameti' THEN
    RAISE EXCEPTION 'channel_for(kameti) should be kameti';
  END IF;
  IF public.notification_collapse_key_for('group_update', 'g1', 'expense_added', '{}'::jsonb, 'n1')
       <> 'group:g1:expense_added' THEN
    RAISE EXCEPTION 'collapse key for group traffic should be group:<id>:<template>';
  END IF;
  IF public.notification_collapse_key_for('linked_request', NULL, NULL, '{}'::jsonb, 'n1')
       <> 'linked_request:n1' THEN
    RAISE EXCEPTION 'money notifications must NOT collapse with each other';
  END IF;

  -- 9. Quiet hours: no prefs row → never quiet.
  IF public.notification_in_quiet_hours('00000000-0000-0000-0000-000000000000'::uuid, now()) THEN
    RAISE EXCEPTION 'a user with no prefs row must never be in quiet hours';
  END IF;

  -- 10. Round dates match src/lib/committeeMath.ts roundDate().
  IF public.committee_round_date(DATE '2026-01-31', 'monthly', 2) <> DATE '2026-02-28' THEN
    RAISE EXCEPTION 'monthly round 2 from 2026-01-31 should clamp to 2026-02-28, got %',
      public.committee_round_date(DATE '2026-01-31', 'monthly', 2);
  END IF;
  IF public.committee_round_date(DATE '2026-03-01', 'weekly', 3) <> DATE '2026-03-15' THEN
    RAISE EXCEPTION 'weekly round 3 should be start + 14 days';
  END IF;
  IF public.committee_round_date(DATE '2026-03-01', 'daily', 1) <> DATE '2026-03-01' THEN
    RAISE EXCEPTION 'round 1 is always the start date';
  END IF;

  -- 11. The prune index exists (N-12: the delete must not seq-scan).
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_notifications_prune'
  ) THEN
    RAISE EXCEPTION 'idx_notifications_prune is missing';
  END IF;

  RAISE NOTICE 'p2-notification-maturity: OK';
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- OPERATOR QUERIES — run these in Studio after applying.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- -- Q1. Are the routing columns populated on live traffic?
-- SELECT channel_id, count(*), count(*) FILTER (WHERE href IS NULL) AS no_href
--   FROM public.notifications
--  WHERE created_at > now() - interval '7 days'
--  GROUP BY 1 ORDER BY 2 DESC;
--
-- -- Q2. Collapse effectiveness: how many rows share a tray entry?
-- SELECT collapse_key, count(*) AS rows_collapsed
--   FROM public.notifications
--  WHERE created_at > now() - interval '24 hours'
--  GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 20;
--
-- -- Q3. Who has muted what (support triage — run as the DB owner):
-- SELECT user_id, group_id, muted, quiet_hours_start, quiet_hours_end, tz
--   FROM public.notification_prefs ORDER BY updated_at DESC LIMIT 50;
--
-- -- Q4. Lifecycle pressure — how much is prunable right now?
-- SELECT count(*) FILTER (WHERE read_at IS NOT NULL AND created_at < now() - interval '90 days')  AS read_over_90,
--        count(*) FILTER (WHERE read_at IS NULL     AND created_at < now() - interval '180 days') AS unread_over_180,
--        count(*) AS total
--   FROM public.notifications;
--
-- -- Q5. Is the pruning job actually running? (pg_cron only)
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'hisaab-%';
-- SELECT jobname, status, return_message, start_time
--   FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
--
-- -- Q6. Kameti reach — how many committee members are actually notifiable?
-- SELECT c.id, c.name,
--        count(*) AS members,
--        count(pr.linked_profile_id) AS reachable
--   FROM public.committees c
--   JOIN public.committee_members cm ON cm.committee_id = c.id AND cm.exited_at IS NULL
--   LEFT JOIN public.persons pr ON pr.id = cm.person_id AND pr.user_id = c.user_id
--  WHERE c.status = 'active'
--  GROUP BY 1, 2 ORDER BY 4 DESC;
--
-- -- Q7. Dry-run the kameti sweep for a specific date without waiting a day:
-- SELECT public.notify_committee_rounds_due(DATE '2026-09-15');
--
-- -- Q8. Manual prune (returns rows deleted; re-run until it returns 0):
-- SELECT public.prune_notifications();
