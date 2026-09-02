-- Hisaab — Audit 2026-09 item UX-18 / M8-adjacent: make joining a group
-- sighted instead of blind.
--
-- Apply in Supabase Studio AFTER supabase-migration-audit-p0-join-abuse-limits
-- .sql (it owns the join_code_attempts ledger and the join_code_expires_at
-- trigger this file reuses) and AFTER
-- supabase-migration-audit-p0-group-deletion-guard.sql (it adds
-- split_groups.archived_at, which the preview reports). Idempotent: safe to
-- re-run. Adds ONE new function; it changes no existing object.
--
-- ── Evidence (docs/audit-2026-09/06-user-experience.md, UX-18, High) ────────
--
--   "JoinGroupModal's own comment admits it: group metadata 'can't be
--    previewed before joining — strict RLS blocks reading a group you're not
--    yet a member of — so the confirm step echoes the verified code + its kind
--    instead' (JoinGroupModal.tsx:78-83). The 'confirmation' card shows the
--    user the code they just typed — zero new information … The user consents
--    to broadcasting their profile name to strangers they cannot see; a
--    mistyped/stale GRP- code joins the wrong group, fires a member_joined
--    event to all members (GroupDetailPage.tsx:133-139), and leaving is gated
--    on settled balances (GroupDetailPage.tsx:421-455).
--    Fix (M): a SECURITY DEFINER preview RPC returning
--    {name, emoji, memberCount, owner} — the exact pattern connect codes
--    already use (resolveProfileByCode)."
--
-- 05-security.md:258 also records that "group-preview denial was verified as
-- *client* behavior only" — i.e. the RLS that blocks the pre-read is real, so
-- the only correct fix is a definer function with a deliberately narrow
-- projection, not a loosened SELECT policy.
--
-- ── What the preview may and may not reveal ─────────────────────────────────
--
-- REVEALED (to a caller who already holds a valid, unexpired join code — i.e.
-- someone who could simply join and see all of it a second later):
--     name, emoji, member_count, currency, owner_display_name
-- NOT REVEALED, ever: group id, member identities, expenses, balances,
--     settlements, the join code itself, or anything at all for a code that
--     does not resolve.
--
-- The projection is fixed in SQL, not chosen by the caller, so it cannot be
-- widened from the client.
--
-- ── Anti-oracle rules (the reason this is not a plain lookup) ───────────────
--
-- A preview endpoint over the same 6-char / 32-symbol keyspace as
-- join_group_by_code (32^6 ~= 1.07e9, src/lib/collaboration.ts:1,17) would be
-- a free validity oracle if it answered without cost. So:
--
--   1. Misses are CHARGED to the SAME ledger and the SAME window the join RPC
--      uses — public.join_code_attempts, 5 failures per rolling 5 minutes.
--      Preview and join therefore share ONE budget: an attacker cannot use the
--      preview to double their guess rate, and cannot use it to pre-filter
--      codes before spending join attempts.
--   2. Like the join RPC (and for the same reason — audit H1), this function
--      NEVER RAISEs on a business outcome. A RAISE would roll back the very
--      attempt row the limiter counts, which is exactly the bug
--      audit-p0-join-abuse-limits.sql exists to fix.
--   3. A shape failure (not 6 chars) performs no lookup and is not charged —
--      it leaks nothing.
--   4. A blocked caller is NOT re-charged, so an honest user who retries can
--      still drain their window (same rule as join_group_by_code).
--   5. A successful preview is not recorded as a *succeeded* join attempt: a
--      preview is not a join, and join_code_attempts.succeeded is read by the
--      join flow. It is deliberately free, because a hit means the caller
--      already holds a working code.
--
-- ── Contract ───────────────────────────────────────────────────────────────
--
--   public.preview_group_by_code(p_code_normalized TEXT) RETURNS JSONB
--
--     {"status":"ok","name":…,"emoji":…,"member_count":int,
--      "currency":…,"owner_display_name":…,"is_archived":bool}
--     {"status":"INVALID_OR_EXPIRED_CODE"}     -- charged to the window
--     {"status":"RATE_LIMITED","retry_after_seconds":300}
--     {"status":"CANNOT_JOIN_OWN_GROUP"}       -- valid code, not a guess: free
--     {"status":"GROUP_ARCHIVED", + the same preview fields}
--     {"status":"INVALID_CODE"}                -- wrong shape, no lookup
--     {"status":"NOT_AUTHENTICATED"}
--
--   The failure vocabulary is deliberately IDENTICAL to join_group_by_code's,
--   so src/lib/joinCodeStatus.ts's existing status → i18n map covers the
--   preview with no new client vocabulary. GROUP_ARCHIVED is the one addition,
--   and it is surfaced as data rather than a raise precisely because
--   group-deletion-guard §5c currently raises on the join path (that file's own
--   open item G2) — previewing first lets the user find out before burning an
--   attempt.
--
--   GRANT: authenticated only. anon holds nothing — the same posture as
--   join_group_by_code and lookup_profile_by_code.

BEGIN;

-- ═══════════════════════════════════════════════════════════
-- SECTION 1. Preconditions (fail loudly rather than half-apply)
-- ═══════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.join_code_attempts') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.join_code_attempts is missing. Apply supabase-migration-audit-p0-join-abuse-limits.sql first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'split_groups'
       AND column_name = 'join_code_expires_at'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: split_groups.join_code_expires_at is missing. Apply supabase-migration-audit-p0-join-abuse-limits.sql first.';
  END IF;
  -- archived_at is optional-but-expected; tolerate its absence so this file can
  -- be applied on a database where group-deletion-guard has not landed yet.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'split_groups'
       AND column_name = 'archived_at'
  ) THEN
    RAISE NOTICE 'p1-group-preview: split_groups.archived_at not present; preview will always report is_archived = false until supabase-migration-audit-p0-group-deletion-guard.sql is applied.';
    ALTER TABLE public.split_groups ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
  END IF;
END;
$$;


-- ═══════════════════════════════════════════════════════════
-- SECTION 2. preview_group_by_code
-- ═══════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.preview_group_by_code(TEXT);

CREATE FUNCTION public.preview_group_by_code(p_code_normalized TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID := auth.uid();
  v_now            TIMESTAMPTZ := now();
  v_group          public.split_groups%ROWTYPE;
  v_failures       INTEGER;
  v_member_count   INTEGER;
  v_owner_name     TEXT;
  v_preview        JSONB;
BEGIN
  -- No RAISE on any business outcome (see anti-oracle rule 2).
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  -- Shape check only; nothing is looked up, so this is free and leaks nothing.
  IF p_code_normalized IS NULL OR length(p_code_normalized) <> 6 THEN
    RETURN jsonb_build_object('status', 'INVALID_CODE');
  END IF;

  -- Keep the shared ledger bounded (audit L12), exactly as the join RPC does.
  DELETE FROM public.join_code_attempts AS jca
   WHERE jca.attempted_at < v_now - INTERVAL '1 day';

  -- The SAME sliding window as join_group_by_code, over the SAME rows: 5
  -- failures per 5 minutes per caller. Sharing the budget is the point.
  SELECT count(*) INTO v_failures
    FROM public.join_code_attempts AS jca
   WHERE jca.user_id = v_uid
     AND jca.succeeded = false
     AND jca.attempted_at > v_now - INTERVAL '5 minutes';
  IF v_failures >= 5 THEN
    -- Not recorded: a blocked call must not extend its own block.
    RETURN jsonb_build_object('status', 'RATE_LIMITED', 'retry_after_seconds', 300);
  END IF;

  SELECT sg.* INTO v_group
    FROM public.split_groups AS sg
   WHERE sg.join_code_normalized = p_code_normalized
   LIMIT 1;

  IF v_group.id IS NULL
     OR (v_group.join_code_expires_at IS NOT NULL AND v_group.join_code_expires_at < v_now) THEN
    -- CHARGED. Without this the preview is a free oracle over the whole
    -- keyspace and the join limiter becomes irrelevant.
    INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false);
    RETURN jsonb_build_object('status', 'INVALID_OR_EXPIRED_CODE');
  END IF;

  -- A valid code is not a guess, so nothing below is charged.

  IF v_group.user_id = v_uid THEN
    RETURN jsonb_build_object('status', 'CANNOT_JOIN_OWN_GROUP');
  END IF;

  -- Only people actually IN the group. 'invited' and 'left' rows are neither
  -- participants nor the caller's business.
  SELECT count(*) INTO v_member_count
    FROM public.group_members AS gm
   WHERE gm.group_id = v_group.id
     AND gm.status = 'connected';

  -- Owner's display name, resolved the same way lookup_profile_by_code does:
  -- a deleted or nameless owner degrades to the generic label rather than
  -- leaking a NULL or an email.
  SELECT COALESCE(NULLIF(trim(p.name), ''), 'Hisaab user') INTO v_owner_name
    FROM public.profiles AS p
   WHERE p.id = v_group.user_id
     AND COALESCE(p.is_deleted, false) = false
   LIMIT 1;

  -- FIXED projection. Note what is absent: the group id, the member list, any
  -- money. A preview must not be a data-export endpoint.
  v_preview := jsonb_build_object(
    'name',               COALESCE(NULLIF(trim(v_group.name), ''), 'Group'),
    'emoji',              COALESCE(v_group.emoji, ''),
    'member_count',       COALESCE(v_member_count, 0),
    'currency',           v_group.currency,
    'owner_display_name', COALESCE(v_owner_name, 'Hisaab user'),
    'is_archived',        (v_group.archived_at IS NOT NULL)
  );

  IF v_group.archived_at IS NOT NULL THEN
    -- Still show what the group IS — the user typed a real code and deserves
    -- to know which group it was — but say plainly that it is closed.
    RETURN v_preview || jsonb_build_object('status', 'GROUP_ARCHIVED');
  END IF;

  RETURN v_preview || jsonb_build_object('status', 'ok');
END;
$$;

COMMENT ON FUNCTION public.preview_group_by_code(TEXT) IS
  'Audit 2026-09 UX-18. Returns a FIXED, minimal preview {name, emoji, member_count, currency, owner_display_name, is_archived} for a valid unexpired group join code, so a user can see what they are joining before broadcasting their profile name to strangers. Never raises on a business outcome. Misses are charged to public.join_code_attempts under join_group_by_code''s own 5-failures-per-5-minutes window, so the preview cannot be used as a free validity oracle or to double an attacker''s guess rate. Grants: authenticated only.';

REVOKE ALL ON FUNCTION public.preview_group_by_code(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_group_by_code(TEXT) TO authenticated;

COMMIT;


-- ═══════════════════════════════════════════════════════════
-- SECTION 3. Read-only verification (run after COMMIT)
-- ═══════════════════════════════════════════════════════════

-- 3.1 The function exists with the expected identity.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid)             AS returns,
       l.lanname                                 AS language,
       p.prosecdef                               AS security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language  l ON l.oid = p.prolang
 WHERE n.nspname = 'public'
   AND p.proname = 'preview_group_by_code';
-- Expect: preview_group_by_code(text) -> jsonb, plpgsql, security_definer = t

-- 3.2 Anti-oracle: it charges misses to the SHARED ledger, and never raises.
SELECT (pg_get_functiondef('public.preview_group_by_code(text)'::regprocedure)
          LIKE '%INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false)%')
                                                          AS charges_misses,
       (pg_get_functiondef('public.preview_group_by_code(text)'::regprocedure)
          NOT LIKE '%RAISE EXCEPTION%')                   AS no_raise_paths,
       (pg_get_functiondef('public.preview_group_by_code(text)'::regprocedure)
          LIKE '%succeeded = false%')                     AS shares_join_window;
-- Expect: t, t, t

-- 3.3 Projection discipline: the group id and the member list must NOT appear
--     in the returned object.
SELECT (pg_get_functiondef('public.preview_group_by_code(text)'::regprocedure)
          NOT LIKE '%''group_id''%')                      AS hides_group_id,
       (pg_get_functiondef('public.preview_group_by_code(text)'::regprocedure)
          NOT LIKE '%''members''%')                       AS hides_member_list;
-- Expect: t, t

-- 3.4 Privilege posture.
SELECT has_function_privilege('anon',          'public.preview_group_by_code(text)', 'EXECUTE') AS anon_can,
       has_function_privilege('authenticated', 'public.preview_group_by_code(text)', 'EXECUTE') AS auth_can;
-- Expect: f, t

-- 3.5 Manual authenticated QA (run as a normal signed-in account, NOT the
--     group owner):
--   a. SELECT public.preview_group_by_code('ZZZZZZ');
--      -> {"status":"INVALID_OR_EXPIRED_CODE"}
--      -> SELECT count(*) FROM public.join_code_attempts
--          WHERE succeeded = false AND attempted_at > now() - INTERVAL '5 minutes';
--         must have INCREASED by 1. (If it did not, the preview is a free
--         oracle — that is the whole point of this file.)
--   b. Repeat (a) five times, then call it once more
--      -> {"status":"RATE_LIMITED","retry_after_seconds":300}
--      and confirm public.join_group_by_code('ZZZZZZ','QA') is ALSO rate
--      limited in the same window — one shared budget, not two.
--   c. SELECT public.preview_group_by_code('<a real code>');
--      -> {"status":"ok","name":…,"emoji":…,"member_count":…,"currency":…,
--          "owner_display_name":…,"is_archived":false}
--      and NO group_id / members / amounts anywhere in the payload.
--   d. As the group's OWNER: -> {"status":"CANNOT_JOIN_OWN_GROUP"}
--   e. archive_group(<that group>), then preview again as the non-owner
--      -> {"status":"GROUP_ARCHIVED", …the same preview fields…}
--   f. Expire the code
--      (UPDATE public.split_groups SET join_code_expires_at = now() - INTERVAL '1 day' …)
--      then preview -> {"status":"INVALID_OR_EXPIRED_CODE"} and a charged row,
--      i.e. an expired code is indistinguishable from a wrong one.
--   g. SELECT public.preview_group_by_code('ABC');  -- wrong shape
--      -> {"status":"INVALID_CODE"} and NO new attempt row.
