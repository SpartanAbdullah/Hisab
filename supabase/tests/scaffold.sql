-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Supabase-shaped scaffold for the database test harness
-- ----------------------------------------------------------------------------
-- Audit 2026-09: P2 item M7 (docs/audit-2026-09/13-engineering-standards.md
-- §2.7 — "no test touches the trust boundary"; 02-repository-architecture.md
-- M-2 — 40+ hand-applied SQL files with no automated verification).
--
-- This file recreates, in a stock `postgres:15` container, the parts of a
-- Supabase project that the repo's SQL files depend on but do not create
-- themselves. It is a faithful reproduction of the throwaway harness described
-- in docs/audit-2026-09/APPLY-ORDER.md §3, promoted into the repository so CI
-- can run it on every push.
--
-- IT IS NOT A MIGRATION. It is never applied to production; nothing in it
-- should ever be pasted into Supabase Studio. Supabase already provides every
-- object below.
--
-- Sections:
--   0. Roles                       (anon / authenticated / service_role / …)
--   1. Schemas + extensions        (auth, extensions, storage, net, vault)
--   2. auth.users shim + auth.uid()/auth.role()/auth.email()
--   3. storage shims
--   4. net.http_post stub          (pg_net replacement)
--   5. realtime publication
--   6. public-schema grants + default privileges
--   7. `test` schema: the assertion helper the SQL tests use
--   8. notifications-rls replay prelude (APPLY-ORDER.md §6 "non-defect")
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 0. ROLES
--    Supabase's PostgREST connects as `authenticator` and SET ROLEs to one of
--    anon / authenticated / service_role per request. The tests do the SET ROLE
--    themselves; `authenticator` exists only so grants that name it apply.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role',
                           'authenticator', 'supabase_admin']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', r);
    END IF;
  END LOOP;
END;
$$;

GRANT anon, authenticated, service_role TO authenticator;
-- The test driver connects as the superuser and SET ROLEs down; it needs
-- membership in each target role.
DO $$
BEGIN
  EXECUTE format('GRANT anon, authenticated, service_role TO %I', current_user);
EXCEPTION WHEN OTHERS THEN NULL;  -- already a member / is superuser
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. SCHEMAS + EXTENSIONS
-- ────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS net;
CREATE SCHEMA IF NOT EXISTS vault;

-- supabase-migration-audit-p0-consent-guards.sql:1369-1377 installs pgcrypto
-- itself, preferring `WITH SCHEMA extensions`. Install it up front so its
-- functions (digest, gen_random_bytes) resolve for every earlier file too.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA auth, extensions, storage, net
  TO anon, authenticated, service_role;

-- Supabase sets this on the database so `extensions.*` resolves unqualified.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path TO "$user", public, extensions',
                 current_database());
END;
$$;
SET search_path TO "$user", public, extensions;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. auth.users + the JWT claim shims
--    The real GoTrue table has ~30 columns plus auth.identities / sessions /
--    refresh_tokens. Only these three are referenced by this repo's SQL
--    (57 FK references to auth.users(id); raw_user_meta_data is read by the
--    profile bootstrap). See docs/testing-the-trust-boundary.md for what that
--    approximation costs.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth.users (
  id                  UUID PRIMARY KEY,
  email               TEXT UNIQUE,
  phone               TEXT,
  raw_user_meta_data  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- auth.uid() reads the `sub` claim exactly as Supabase's does. The tests set it
-- with `SELECT set_config('request.jwt.claim.sub', '<uuid>', true)`.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''),
                  current_user::text);
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.email', true), '');
$$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. STORAGE SHIMS  (supabase-migration-receipts.sql applies against these)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage.buckets (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  public  BOOLEAN NOT NULL DEFAULT false,
  file_size_limit   BIGINT,
  allowed_mime_types TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id  TEXT REFERENCES storage.buckets(id),
  name       TEXT,
  owner      UUID,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_to_array(name, '/');
$$;

GRANT SELECT ON storage.buckets TO anon, authenticated, service_role;
GRANT ALL ON storage.objects TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION storage.foldername(TEXT)
  TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. pg_net STUB
--    The real net.http_post is async fire-and-forget. This one logs the call so
--    a test can assert "the trigger tried to push" without a network.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS net.http_calls (
  id      BIGSERIAL PRIMARY KEY,
  url     TEXT,
  body    JSONB,
  headers JSONB,
  called_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION net.http_post(
  url     TEXT,
  body    JSONB DEFAULT '{}'::jsonb,
  params  JSONB DEFAULT '{}'::jsonb,
  headers JSONB DEFAULT '{}'::jsonb,
  timeout_milliseconds INT DEFAULT 5000
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT;
BEGIN
  INSERT INTO net.http_calls (url, body, headers)
  VALUES (url, body, headers)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. REALTIME PUBLICATION
--    On a wal_level=replica server Postgres emits a warning here; harmless, the
--    publication object is all the migrations need.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END;
$$;

-- 5b. REALTIME BROADCAST STUB (realtime.send / realtime.topic / realtime.messages)
--     Supabase's Realtime extension ships these; a bare postgres image does not.
--     supabase-migration-p2-realtime-broadcast.sql guards on their presence, so
--     without this stub its triggers would be created but never exercised. The
--     stub mirrors the shapes documented at the end of that migration.
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (
  id          BIGSERIAL PRIMARY KEY,
  topic       TEXT,
  event       TEXT,
  payload     JSONB,
  private     BOOLEAN,
  extension   TEXT,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION realtime.send(payload JSONB, event TEXT, topic TEXT, private BOOLEAN DEFAULT true)
RETURNS VOID LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO realtime.messages (topic, event, payload, private, extension)
  VALUES (topic, event, payload, private, 'broadcast');
$$;
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS TEXT
LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic', true) $$;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;
GRANT SELECT ON realtime.messages TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. PUBLIC-SCHEMA GRANTS
--    Supabase ships default privileges that hand every new public table to
--    anon/authenticated/service_role — RLS, not GRANT, is the access control.
--    Without this, every migration's tables would be unreadable and the RLS
--    tests would pass for the wrong reason.
-- ────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT ALL ON TABLES TO anon, authenticated, service_role', current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT ALL ON SEQUENCES TO anon, authenticated, service_role', current_user);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
    'GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role', current_user);
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. THE ASSERTION HELPER
--
--    Deliberately NOT pgTAP: pgTAP is not in the `postgres:15` image and
--    installing it in CI means apt + build tooling (or a custom image) for a
--    dozen functions we can write in 60 lines. Plain SQL keeps the CI job at
--    "docker run postgres:15" with zero extra dependencies.
--
--    test.assert()        — record a boolean assertion.
--    test.assert_raises() — run SQL, expect an error containing a substring.
--    test.assert_ok()     — run SQL, expect no error.
--    test.as_user()       — switch the JWT `sub` claim.
--    test.summary()       — print the tally and RAISE if anything failed.
--
--    assert()/record are SECURITY DEFINER so a test running as `authenticated`
--    can still write the results table. assert_raises()/assert_ok() are
--    deliberately SECURITY INVOKER — the SQL under test MUST run as the caller
--    or every RLS assertion would silently pass as the table owner.
-- ────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS test;
GRANT USAGE ON SCHEMA test TO anon, authenticated, service_role;

DROP TABLE IF EXISTS test.results;
CREATE TABLE test.results (
  id      BIGSERIAL PRIMARY KEY,
  suite   TEXT,
  name    TEXT NOT NULL,
  passed  BOOLEAN NOT NULL,
  detail  TEXT
);

CREATE OR REPLACE FUNCTION test.suite(p_suite TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = test, public AS $$
BEGIN
  PERFORM set_config('test.current_suite', p_suite, false);
  RAISE NOTICE '── suite: %', p_suite;
END;
$$;

CREATE OR REPLACE FUNCTION test.assert(p_ok BOOLEAN, p_name TEXT,
                                       p_detail TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = test, public AS $$
DECLARE v_ok BOOLEAN := COALESCE(p_ok, false);
BEGIN
  INSERT INTO test.results (suite, name, passed, detail)
  VALUES (NULLIF(current_setting('test.current_suite', true), ''),
          p_name, v_ok, p_detail);
  IF v_ok THEN
    RAISE NOTICE '  ok   %', p_name;
  ELSE
    RAISE NOTICE '  FAIL %  [%]', p_name, COALESCE(p_detail, 'assertion was false');
  END IF;
END;
$$;

-- Run p_sql; pass if it raises an error whose SQLERRM contains p_expect.
-- SECURITY INVOKER on purpose (see the note above).
CREATE OR REPLACE FUNCTION test.assert_raises(p_sql TEXT, p_expect TEXT,
                                              p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    PERFORM test.assert(SQLERRM ILIKE '%' || p_expect || '%', p_name,
                        'raised: ' || SQLERRM);
    RETURN;
  END;
  PERFORM test.assert(false, p_name,
                      'expected an error containing "' || p_expect
                      || '" but the statement succeeded');
END;
$$;

-- Run p_sql; pass if it does NOT raise.
CREATE OR REPLACE FUNCTION test.assert_ok(p_sql TEXT, p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  PERFORM test.assert(true, p_name);
EXCEPTION WHEN OTHERS THEN
  PERFORM test.assert(false, p_name, 'unexpected error: ' || SQLERRM);
END;
$$;

-- Run p_sql (expected to affect rows); pass if it silently affects ZERO rows.
-- This is the RLS shape PostgREST produces for a denied UPDATE/DELETE: no
-- error, just nothing changed. Distinguishing it from a WITH CHECK violation
-- matters — the audit cares that ex-members cannot mutate ledger rows, and
-- Postgres expresses that as 0 rows, not as an exception.
CREATE OR REPLACE FUNCTION test.assert_zero_rows(p_sql TEXT, p_name TEXT)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE v_count BIGINT;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM test.assert(v_count = 0, p_name, 'rows affected: ' || v_count);
EXCEPTION WHEN OTHERS THEN
  -- An outright error is also a refusal; accept it and say so.
  PERFORM test.assert(true, p_name, 'refused with an error: ' || SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION test.as_user(p_uid UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_uid::text, ''), false);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', false);
END;
$$;

CREATE OR REPLACE FUNCTION test.summary() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = test, public AS $$
DECLARE
  v_total INT; v_failed INT; v_list TEXT;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE NOT passed) INTO v_total, v_failed
    FROM test.results;
  SELECT string_agg(format('%s / %s%s', COALESCE(suite,'-'), name,
                           COALESCE(' — ' || detail, '')), E'\n    ')
    INTO v_list FROM test.results WHERE NOT passed;

  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════';
  RAISE NOTICE '  %  assertions,  %  failed', v_total, v_failed;
  RAISE NOTICE '════════════════════════════════════════════════════';

  IF v_total = 0 THEN
    RAISE EXCEPTION 'TEST HARNESS ERROR: zero assertions were recorded';
  END IF;
  IF v_failed > 0 THEN
    RAISE EXCEPTION E'% assertion(s) FAILED:\n    %', v_failed, v_list;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION
  test.suite(TEXT),
  test.assert(BOOLEAN, TEXT, TEXT),
  test.assert_raises(TEXT, TEXT, TEXT),
  test.assert_ok(TEXT, TEXT),
  test.assert_zero_rows(TEXT, TEXT),
  test.as_user(UUID),
  test.summary()
TO anon, authenticated, service_role;
GRANT SELECT, INSERT ON test.results TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE test.results_id_seq
  TO anon, authenticated, service_role;
