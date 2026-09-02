-- Hisaab — Audit 2026-09 item C5: make the join/lookup abuse limits real.
--
-- Apply in Supabase Studio AFTER supabase-migration-fix-group-invite-join-rpc.sql
-- (the current definition of join_group_by_code) and after
-- supabase-migration-connections-push-discovery.sql (source of the throttle
-- pattern reused below). Idempotent: safe to re-run.
--
-- ── Evidence (docs/audit-2026-09/05-security.md) ────────────────────────────
--
-- H1 / SEC-02 — "join_group_by_code brute-force rate limiter is a no-op".
--   supabase-migration-fix-group-invite-join-rpc.sql:46-50 (and the identical
--   shape at supabase-migration-p0-launch-blockers.sql:262-266 and
--   supabase-migration-prelaunch-hardening.sql:387-395) does:
--       INSERT INTO join_code_attempts(user_id, succeeded) VALUES (v_uid, false);
--       RAISE EXCEPTION 'INVALID_OR_EXPIRED_CODE' ...
--   The unhandled RAISE aborts the transaction, so the INSERT is rolled back.
--   join_code_attempts therefore only ever holds succeeded = true rows, and the
--   "5 failures per 5 minutes" gate (which counts succeeded = false) can never
--   fire. Keyspace: 6 chars over a 32-symbol alphabet (src/lib/collaboration.ts:1,17)
--   = 32^6 ~= 1.07e9, i.e. the only guessable credential in the system was
--   protected by nothing.
--   Fix here: the RPC now RETURNS a jsonb status object instead of raising, so
--   the failure row commits with the response and the sliding window actually
--   accumulates. The window logic itself is unchanged (5 failures / 5 minutes).
--
-- H1 (aggravator) — the 14-day expiry backfilled by p0-launch-blockers.sql:218-221
--   only touched rows that existed then. New groups are inserted by the client
--   (src/stores/splitStore.ts:434-447 -> src/lib/supabaseDb.ts:894-903) which
--   never writes join_code_expires_at, so every group created since has a NULL
--   expiry and the RPC treats NULL as "never expires".
--   Fix here: a BEFORE INSERT/UPDATE trigger stamps the expiry server-side
--   whenever a join code is set or rotated. No client change is required —
--   deliberately server-side so a future client (or a raw PostgREST write)
--   cannot reintroduce never-expiring codes.
--
-- H9 / SEC-03 — "lookup_profile_by_code is unthrottled".
--   supabase-migration-p0-launch-blockers.sql:369-385 defines it as a plain SQL
--   SECURITY DEFINER function granted to every authenticated user, returning
--   (profile_id, display_name) with zero attempt accounting — a validity oracle
--   at PostgREST speed over the same 32^6 keyspace, yielding a (UUID, real name)
--   directory. Contrast lookup_hisaab_users_by_phone
--   (supabase-migration-connections-push-discovery.sql:339-350) which prunes,
--   counts and inserts into phone_lookup_attempts before answering.
--   Fix here: the identical ledger/window pattern (20 calls per rolling hour)
--   against a new code_lookup_attempts table. EVERY call is charged to the
--   window — hits and misses alike — and a throttled caller gets zero rows,
--   which is byte-identical to "no such code", so the throttle itself is not a
--   distinguishable signal.
--
-- Also closes L12 (join_code_attempts grew without bound) by pruning inside the
-- RPC, the same way the phone throttle does.
--
-- ── New join_group_by_code contract ─────────────────────────────────────────
--   RETURNS jsonb, never raises for a business outcome:
--     {"status":"ok","group_id":…,"member_id":…,"was_already_connected":bool}
--     {"status":"INVALID_OR_EXPIRED_CODE"}   -- charged to the rate window
--     {"status":"RATE_LIMITED","retry_after_seconds":300}
--     {"status":"CANNOT_JOIN_OWN_GROUP"}
--     {"status":"INVALID_CODE"}              -- wrong shape, no lookup performed
--     {"status":"NOT_AUTHENTICATED"}
--   Success-path semantics are byte-for-byte the ones from
--   supabase-migration-fix-group-invite-join-rpc.sql:42-77 (same lookup, same
--   expiry check, same member insert/upsert, same was_already_connected rule,
--   same succeeded = true attempt row).
--   This is a breaking return-type change; the app is pre-launch and the client
--   in this same commit handles both the new object and a legacy thrown error.

BEGIN;

-- ═══════════════════════════════════════════════════════════
-- SECTION 1. Attempt ledgers
-- ═══════════════════════════════════════════════════════════

-- Already created by p0-launch-blockers / prelaunch-hardening; restated so this
-- file stands alone if applied against a partially-migrated database.
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

-- New: per-caller ledger for profile-code lookups (H9). Same shape as
-- phone_lookup_attempts — the RPC is the only thing that ever touches it.
CREATE TABLE IF NOT EXISTS public.code_lookup_attempts (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_lookup_attempts_user_time
  ON public.code_lookup_attempts(user_id, attempted_at DESC);

ALTER TABLE public.code_lookup_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no client access to code_lookup_attempts" ON public.code_lookup_attempts;
CREATE POLICY "no client access to code_lookup_attempts"
  ON public.code_lookup_attempts FOR ALL
  USING (false) WITH CHECK (false);


-- ═══════════════════════════════════════════════════════════
-- SECTION 2. Join codes always carry an expiry
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.split_groups
  ADD COLUMN IF NOT EXISTS join_code_expires_at TIMESTAMPTZ;

-- Every group created after the p0 backfill has a NULL expiry. Give them the
-- same 14-day window the backfill used.
UPDATE public.split_groups
   SET join_code_expires_at = now() + INTERVAL '14 days'
 WHERE join_code IS NOT NULL
   AND join_code_expires_at IS NULL;

-- Server-side stamping so the client never has to remember. Fires on insert
-- (new group) and on code rotation (owner writes a fresh join_code), and never
-- overrides an expiry the writer set explicitly.
CREATE OR REPLACE FUNCTION public.tg_split_groups_join_code_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.join_code IS NOT NULL AND NEW.join_code_expires_at IS NULL THEN
      NEW.join_code_expires_at := now() + INTERVAL '14 days';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Rotating the code refreshes the window; an explicit expiry change wins.
    IF NEW.join_code IS DISTINCT FROM OLD.join_code
       AND NEW.join_code IS NOT NULL
       AND NEW.join_code_expires_at IS NOT DISTINCT FROM OLD.join_code_expires_at THEN
      NEW.join_code_expires_at := now() + INTERVAL '14 days';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_split_groups_join_code_expiry ON public.split_groups;
CREATE TRIGGER trg_split_groups_join_code_expiry
  BEFORE INSERT OR UPDATE ON public.split_groups
  FOR EACH ROW EXECUTE FUNCTION public.tg_split_groups_join_code_expiry();


-- ═══════════════════════════════════════════════════════════
-- SECTION 3. join_group_by_code — status result, committing rate limiter
-- ═══════════════════════════════════════════════════════════

-- Return type changes from TABLE(...) to jsonb, so the old signature must go.
DROP FUNCTION IF EXISTS public.join_group_by_code(TEXT, TEXT);
-- Legacy one-argument form (prelaunch-hardening) must stay dropped.
DROP FUNCTION IF EXISTS public.join_group_by_code(TEXT);

CREATE FUNCTION public.join_group_by_code(
  p_code_normalized TEXT,
  p_display_name TEXT
)
RETURNS JSONB
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
  v_was_already_connected BOOLEAN;
BEGIN
  -- No RAISE anywhere on a business outcome: an unhandled RAISE would roll the
  -- attempt row back, which is exactly the bug this migration exists to fix.
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  -- Shape check only. Nothing is looked up, so this leaks nothing and is not
  -- charged to the window.
  IF p_code_normalized IS NULL OR length(p_code_normalized) <> 6 THEN
    RETURN jsonb_build_object('status', 'INVALID_CODE');
  END IF;

  -- Keep the ledger bounded (audit L12). Rows older than the widest window we
  -- read are dead weight.
  DELETE FROM public.join_code_attempts AS jca
   WHERE jca.attempted_at < v_now - INTERVAL '1 day';

  -- Sliding window, unchanged: 5 failed attempts per 5 minutes per caller.
  SELECT count(*) INTO v_failures
    FROM public.join_code_attempts AS jca
   WHERE jca.user_id = v_uid
     AND jca.succeeded = false
     AND jca.attempted_at > v_now - INTERVAL '5 minutes';
  IF v_failures >= 5 THEN
    -- Deliberately NOT recorded: a blocked call must not extend its own block,
    -- or an honest user who retries never drains the window.
    RETURN jsonb_build_object('status', 'RATE_LIMITED', 'retry_after_seconds', 300);
  END IF;

  SELECT sg.* INTO v_group
    FROM public.split_groups AS sg
   WHERE sg.join_code_normalized = p_code_normalized
   LIMIT 1;
  IF v_group.id IS NULL
     OR (v_group.join_code_expires_at IS NOT NULL AND v_group.join_code_expires_at < v_now) THEN
    -- THE load-bearing line: this INSERT now survives, because we return
    -- normally instead of raising.
    INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false);
    RETURN jsonb_build_object('status', 'INVALID_OR_EXPIRED_CODE');
  END IF;
  IF v_group.user_id = v_uid THEN
    -- Valid code, so not a guess: not charged to the window.
    RETURN jsonb_build_object('status', 'CANNOT_JOIN_OWN_GROUP');
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
    v_was_already_connected := false;
  ELSE
    v_was_already_connected := v_member.status = 'connected';
    UPDATE public.group_members AS gm
       SET status = 'connected',
           joined_at = COALESCE(gm.joined_at, v_now)
     WHERE gm.id = v_member.id;
  END IF;

  INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, true);

  RETURN jsonb_build_object(
    'status', 'ok',
    'group_id', v_group.id,
    'member_id', v_member.id,
    'was_already_connected', v_was_already_connected
  );
END;
$$;

REVOKE ALL ON FUNCTION public.join_group_by_code(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_group_by_code(TEXT, TEXT) TO authenticated;


-- ═══════════════════════════════════════════════════════════
-- SECTION 4. lookup_profile_by_code — throttled (H9)
-- ═══════════════════════════════════════════════════════════

-- Same signature and return shape as before; the body gains the
-- lookup_hisaab_users_by_phone throttle. Dropped first so the language change
-- (sql -> plpgsql) is unambiguous.
DROP FUNCTION IF EXISTS public.lookup_profile_by_code(TEXT);

CREATE FUNCTION public.lookup_profile_by_code(code TEXT)
RETURNS TABLE(profile_id UUID, display_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_recent INTEGER;
BEGIN
  -- Every non-answer is the same non-answer: zero rows. A caller can never tell
  -- "no such code" from "you are throttled" from "your profile is inactive".
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN;
  END IF;

  DELETE FROM public.code_lookup_attempts AS cla
   WHERE cla.attempted_at < now() - INTERVAL '1 hour';

  -- 20 lookups per rolling hour, matching lookup_hisaab_users_by_phone. Code
  -- entry is always an explicit user action (ConnectByCodePage, ContactsPage,
  -- ContactDetailSheet, QR scan), so this is far above real usage and far below
  -- what a 32^6 sweep needs.
  SELECT count(*) INTO v_recent
    FROM public.code_lookup_attempts AS cla
   WHERE cla.user_id = v_uid
     AND cla.attempted_at > now() - INTERVAL '1 hour';
  IF v_recent >= 20 THEN
    RETURN;
  END IF;

  -- Charged BEFORE the lookup, so misses cost exactly what hits cost.
  INSERT INTO public.code_lookup_attempts(user_id) VALUES (v_uid);

  RETURN QUERY
    SELECT p.id, COALESCE(NULLIF(trim(p.name), ''), 'Hisaab user')
      FROM public.profiles AS p
     WHERE p.public_code_normalized = COALESCE(code, '')
       AND p.id <> v_uid
       AND COALESCE(p.is_deleted, false) = false
     LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_profile_by_code(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_profile_by_code(TEXT) TO authenticated;

-- Superseded leaky variant — stays dropped.
DROP FUNCTION IF EXISTS public.lookup_profile_by_public_code(TEXT);

COMMIT;


-- ═══════════════════════════════════════════════════════════
-- SECTION 5. Read-only verification (run after COMMIT)
-- ═══════════════════════════════════════════════════════════

-- 5.1 Both RPCs exist with the expected return type and language.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid)             AS returns,
       l.lanname                                 AS language,
       p.prosecdef                               AS security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language  l ON l.oid = p.prolang
 WHERE n.nspname = 'public'
   AND p.proname IN ('join_group_by_code', 'lookup_profile_by_code')
 ORDER BY p.proname;
-- Expect: join_group_by_code(text, text) -> jsonb, plpgsql, t
--         lookup_profile_by_code(text)   -> TABLE(profile_id uuid, display_name text), plpgsql, t

-- 5.2 The join RPC no longer raises on a business outcome, and the failure row
--     is recorded on the invalid-code path.
SELECT (pg_get_functiondef('public.join_group_by_code(text,text)'::regprocedure)
          NOT LIKE '%RAISE EXCEPTION%')                              AS no_raise_paths,
       (pg_get_functiondef('public.join_group_by_code(text,text)'::regprocedure)
          LIKE '%INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false)%')
                                                                     AS records_failures,
       (pg_get_functiondef('public.join_group_by_code(text,text)'::regprocedure)
          LIKE '%WHERE gm.group_id = v_group.id%')                   AS qualifies_member_lookup;
-- Expect: t, t, t

-- 5.3 The lookup RPC charges the window before answering.
SELECT (pg_get_functiondef('public.lookup_profile_by_code(text)'::regprocedure)
          LIKE '%INSERT INTO public.code_lookup_attempts(user_id) VALUES (v_uid)%') AS throttled;
-- Expect: t

-- 5.4 Neither ledger is reachable by a client; anon holds no EXECUTE.
SELECT c.relname, c.relrowsecurity, count(pol.polname) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
 WHERE n.nspname = 'public'
   AND c.relname IN ('join_code_attempts', 'code_lookup_attempts')
 GROUP BY c.relname, c.relrowsecurity;
-- Expect: relrowsecurity = t for both, with the deny-all policy present.

SELECT has_function_privilege('anon', 'public.join_group_by_code(text,text)', 'EXECUTE') AS anon_join,
       has_function_privilege('anon', 'public.lookup_profile_by_code(text)', 'EXECUTE')  AS anon_lookup;
-- Expect: f, f

-- 5.5 Every live join code carries an expiry, and the stamping trigger is armed.
SELECT count(*) FILTER (WHERE join_code IS NOT NULL)                                    AS groups_with_code,
       count(*) FILTER (WHERE join_code IS NOT NULL AND join_code_expires_at IS NULL)    AS missing_expiry
  FROM public.split_groups;
-- Expect: missing_expiry = 0

SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgrelid = 'public.split_groups'::regclass
   AND tgname = 'trg_split_groups_join_code_expiry';
-- Expect: one row, tgenabled = 'O'

-- 5.6 Manual authenticated QA (run as a normal signed-in account):
--   a. SELECT public.join_group_by_code('ZZZZZZ', 'QA');   -- 5x
--      -> first five return {"status":"INVALID_OR_EXPIRED_CODE"}
--      -> sixth returns {"status":"RATE_LIMITED","retry_after_seconds":300}
--      -> SELECT count(*) FROM public.join_code_attempts WHERE succeeded = false;
--         must be > 0 (this was always 0 before the fix — that IS the bug).
--   b. Wait 5 minutes, then join with a real code -> {"status":"ok", ...}.
--   c. SELECT public.lookup_profile_by_code('XXXXXX') 21x in an hour
--      -> the 21st returns zero rows, identical to a miss.
