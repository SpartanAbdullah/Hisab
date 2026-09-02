-- ════════════════════════════════════════════════════════════════════════════
-- 8x · The analytics RPC family
--     supabase-migration-p2-analytics-aggregates.sql      (analytics_monthly_summary)
--     supabase-migration-p2-analytics-aggregates-2.sql    (analytics_daily_series,
--                                                          analytics_top_expenses)
--
-- These three functions are SECURITY DEFINER and read the `transactions` table
-- with RLS bypassed, so the ONLY thing standing between one user's history and
-- another's is the `user_id = auth.uid()` predicate inside each body. That, the
-- soft-delete guard, and — for the two new ones — row-for-row equality with the
-- TypeScript twins in src/lib/analytics.ts are what this file pins.
--
-- EXPECTED VALUES ARE NOT HAND-WRITTEN. Every figure asserted below was dumped
-- from `dailySeriesFromTransactions(ANALYTICS_FIXTURE, FIXTURE_FROM, FIXTURE_TO)`
-- and `topExpensesFromTransactions(ANALYTICS_FIXTURE, FIXTURE_FROM, FIXTURE_TO, 5)`
-- (src/lib/analytics.ts + analytics.test.ts) and pasted verbatim. If the SQL and
-- the TypeScript ever drift, this file fails — which is the entire point.
--
-- Users (new; A–F belong to the earlier files and are not touched):
--   G  aaaaaaaa-…  owns the fixture history
--   H  bbbbbbbb-…  owns ONE row inside the same window — the owner-scoping
--                  negative control
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8x-analytics-rpcs');

RESET ROLE;
INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'analytics-g@hisaab.test'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'analytics-h@hisaab.test');

SET ROLE authenticated;
SELECT test.as_user('aaaaaaaa-0000-4000-8000-00000000000a');

-- One real account, because supabase-migration-prelaunch-hardening.sql adds
-- FKs transactions.source_account_id → accounts(id). The ledger-only rows below
-- deliberately leave BOTH ids NULL — that is the splits_only shape, and the
-- whole point of rules D6/T7 is that it aggregates identically.
INSERT INTO accounts (id, user_id, name, type, currency, balance)
VALUES ('G-ACC', auth.uid(), 'Cash', 'cash', 'AED', 0);

-- ── ANALYTICS_FIXTURE, verbatim (src/lib/analytics.test.ts) ─────────────────
-- 18 rows: two currencies, a conversion_rate-bearing row, TWO ledger-only rows
-- (both account ids NULL), an empty category, four non-income/expense types,
-- two calendar months, both window edges, one row just outside each edge.
INSERT INTO transactions
  (id, user_id, type, amount, currency, source_account_id, destination_account_id,
   conversion_rate, category, notes, created_at)
VALUES
  ('f00', auth.uid(), 'expense',        999,    'AED', 'G-ACC', NULL, NULL,  'Rent',          '', '2026-03-31T23:59:59.999Z'),
  ('f01', auth.uid(), 'expense',        100,    'AED', 'G-ACC', NULL, NULL,  'Food & Dining', '', '2026-04-01T00:00:00.000Z'),
  ('f02', auth.uid(), 'expense',        250.55, 'AED', 'G-ACC', NULL, NULL,  'Rent',          '', '2026-04-03T10:00:00.000Z'),
  ('f03', auth.uid(), 'expense',        40.45,  'AED', 'G-ACC', NULL, NULL,  '',              '', '2026-04-03T18:30:00.000Z'),
  ('f04', auth.uid(), 'income',         5000,   'AED', 'G-ACC', NULL, NULL,  'Salary',        '', '2026-04-05T08:00:00.000Z'),
  ('f05', auth.uid(), 'expense',        3000,   'PKR', 'G-ACC', NULL, NULL,  'Food & Dining', '', '2026-04-06T09:00:00.000Z'),
  ('f06', auth.uid(), 'income',         12000,  'PKR', 'G-ACC', NULL, NULL,  'Freelance',     '', '2026-04-07T09:00:00.000Z'),
  ('f07', auth.uid(), 'expense',        82.5,   'PKR', 'G-ACC', NULL, 0.013, 'Travel',        '', '2026-04-08T09:00:00.000Z'),
  -- LEDGER-ONLY (splits_only): BOTH account ids NULL.
  ('f08', auth.uid(), 'expense',        60,     'AED', NULL,    NULL, NULL,  'Food & Dining', '', '2026-04-09T12:00:00.000Z'),
  ('f09', auth.uid(), 'transfer',       700,    'AED', 'G-ACC', NULL, NULL,  'Transfer',      '', '2026-04-10T12:00:00.000Z'),
  ('f10', auth.uid(), 'adjustment',     15,     'AED', 'G-ACC', NULL, NULL,  'Adjustment',    '', '2026-04-11T12:00:00.000Z'),
  ('f11', auth.uid(), 'investment_buy', 2000,   'AED', 'G-ACC', NULL, NULL,  'Investment',    '', '2026-04-12T12:00:00.000Z'),
  -- LEDGER-ONLY repayment record — the shape tasks/lessons.md was written about.
  ('f12', auth.uid(), 'repayment',      300,    'AED', NULL,    NULL, NULL,  'Loan',          '', '2026-04-13T12:00:00.000Z'),
  ('f13', auth.uid(), 'expense',        90,     'AED', 'G-ACC', NULL, NULL,  'Food & Dining', '', '2026-05-02T07:00:00.000Z'),
  ('f14', auth.uid(), 'expense',        400,    'AED', 'G-ACC', NULL, NULL,  'Rent',          '', '2026-05-04T07:00:00.000Z'),
  ('f15', auth.uid(), 'income',         5200,   'AED', 'G-ACC', NULL, NULL,  'Salary',        '', '2026-05-05T07:00:00.000Z'),
  ('f16', auth.uid(), 'expense',        25,     'AED', 'G-ACC', NULL, NULL,  'Groceries',     '', '2026-05-31T23:59:59.000Z'),
  ('f17', auth.uid(), 'expense',        777,    'AED', 'G-ACC', NULL, NULL,  'Rent',          '', '2026-06-01T00:00:00.000Z');

-- Negative control 1: a soft-deleted row that would otherwise be the single
-- biggest AED expense in the window.
INSERT INTO transactions
  (id, user_id, type, amount, currency, source_account_id, category, notes, created_at, deleted_at)
VALUES
  ('f90', auth.uid(), 'expense', 99999, 'AED', 'G-ACC', 'Deleted', '', '2026-04-20T00:00:00.000Z', now());

-- Tie fixture for rule T2, parked OUTSIDE the fixture window so it cannot
-- disturb the equality run above.
INSERT INTO transactions
  (id, user_id, type, amount, currency, source_account_id, category, notes, created_at)
VALUES
  ('t1', auth.uid(), 'expense', 100, 'AED', 'G-ACC', 'Tie', '', '2026-07-02T00:00:00.000Z'),
  ('t2', auth.uid(), 'expense', 100, 'AED', 'G-ACC', 'Tie', '', '2026-07-04T00:00:00.000Z'),
  ('t3', auth.uid(), 'expense', 100, 'AED', 'G-ACC', 'Tie', '', '2026-07-04T00:00:00.000Z');

-- Negative control 2: another user's row, right in the middle of the window.
SELECT test.as_user('bbbbbbbb-0000-4000-8000-00000000000b');
INSERT INTO transactions
  (id, user_id, type, amount, currency, source_account_id, category, notes, created_at)
VALUES
  ('h01', auth.uid(), 'expense', 55555, 'AED', NULL, 'Not yours', '', '2026-04-15T00:00:00.000Z');

SELECT test.as_user('aaaaaaaa-0000-4000-8000-00000000000a');

-- ── The TypeScript twins' output, pasted verbatim ───────────────────────────
RESET ROLE;
CREATE TEMP TABLE expect_daily (day date, currency text, "type" text, total numeric, tx_count bigint);
INSERT INTO expect_daily VALUES
  ('2026-04-01','AED','expense',        100,   1),
  ('2026-04-03','AED','expense',        291,   2),
  ('2026-04-05','AED','income',         5000,  1),
  ('2026-04-06','PKR','expense',        3000,  1),
  ('2026-04-07','PKR','income',         12000, 1),
  ('2026-04-08','PKR','expense',        82.5,  1),
  ('2026-04-09','AED','expense',        60,    1),
  ('2026-04-10','AED','transfer',       700,   1),
  ('2026-04-11','AED','adjustment',     15,    1),
  ('2026-04-12','AED','investment_buy', 2000,  1),
  ('2026-04-13','AED','repayment',      300,   1),
  ('2026-05-02','AED','expense',        90,    1),
  ('2026-05-04','AED','expense',        400,   1),
  ('2026-05-05','AED','income',         5200,  1),
  ('2026-05-31','AED','expense',        25,    1);

CREATE TEMP TABLE expect_top (ord int, id text, amount numeric, currency text, category text);
INSERT INTO expect_top VALUES
  (1, 'f14', 400,    'AED', 'Rent'),
  (2, 'f02', 250.55, 'AED', 'Rent'),
  (3, 'f01', 100,    'AED', 'Food & Dining'),
  (4, 'f13', 90,     'AED', 'Food & Dining'),
  (5, 'f08', 60,     'AED', 'Food & Dining'),
  (6, 'f05', 3000,   'PKR', 'Food & Dining'),
  (7, 'f07', 82.5,   'PKR', 'Travel');
GRANT SELECT ON expect_daily, expect_top TO authenticated;
SET ROLE authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- A1. analytics_daily_series is row-for-row equal to dailySeriesFromTransactions
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE got_daily AS
  SELECT * FROM public.analytics_daily_series(
    '2026-04-01T00:00:00.000Z'::timestamptz,
    '2026-05-31T23:59:59.000Z'::timestamptz,
    'UTC');

SELECT test.assert(
  (SELECT count(*) FROM got_daily) = (SELECT count(*) FROM expect_daily)
  AND NOT EXISTS (
    SELECT 1
      FROM got_daily g
      FULL JOIN expect_daily e
        ON e.day = g.day AND e.currency = g.currency AND e."type" = g."type"
     WHERE e.day IS NULL OR g.day IS NULL
        OR abs(e.total - g.total) > 1e-9
        OR e.tx_count <> g.tx_count),
  'A1 analytics_daily_series == dailySeriesFromTransactions, row for row',
  'sql rows: ' || (SELECT count(*) FROM got_daily)::text
    || ', ts rows: ' || (SELECT count(*) FROM expect_daily)::text);

-- ═══════════════════════════════════════════════════════════════════════════
-- A2. Row ORDER matches the TypeScript sort, so the two compare 1:1 without
--     either side re-sorting (day, currency, type ascending).
-- ═══════════════════════════════════════════════════════════════════════════
WITH returned AS (
  SELECT row_number() OVER () AS ord, day, currency, "type"
    FROM public.analytics_daily_series(
           '2026-04-01T00:00:00.000Z'::timestamptz,
           '2026-05-31T23:59:59.000Z'::timestamptz, 'UTC')
), sorted AS (
  SELECT ord, row_number() OVER (ORDER BY day, currency, "type") AS want FROM returned
)
SELECT test.assert(
  (SELECT bool_and(ord = want) FROM sorted),
  'A2 daily series is returned ordered (day, currency, type)');

-- ═══════════════════════════════════════════════════════════════════════════
-- A3. Rule D1 — the window is INCLUSIVE at both ends and excludes the rest.
--     f00 (Mar 31 23:59:59.999) and f17 (Jun 1 00:00:00) sit just outside;
--     f01 and f16 sit exactly ON the edges.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM got_daily WHERE day IN ('2026-03-31','2026-06-01'))
  AND EXISTS (SELECT 1 FROM got_daily WHERE day = '2026-04-01' AND total = 100)
  AND EXISTS (SELECT 1 FROM got_daily WHERE day = '2026-05-31' AND total = 25),
  'A3 window inclusive at BOTH ends, nothing outside it');

-- ═══════════════════════════════════════════════════════════════════════════
-- A4. p_tz really cuts the day buckets: in Asia/Dubai (UTC+4) the
--     2026-05-31T23:59:59Z row belongs to JUNE 1 locally.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  EXISTS (SELECT 1 FROM public.analytics_daily_series(
            '2026-04-01T00:00:00.000Z'::timestamptz,
            '2026-05-31T23:59:59.000Z'::timestamptz, 'Asia/Dubai')
           WHERE day = '2026-06-01' AND total = 25)
  AND (SELECT count(*) FROM public.analytics_daily_series(
            '2026-04-01T00:00:00.000Z'::timestamptz,
            '2026-05-31T23:59:59.000Z'::timestamptz, 'Not/AZone')) = 15,
  'A4 p_tz cuts local days; an unknown zone falls back to UTC instead of erroring');

-- ═══════════════════════════════════════════════════════════════════════════
-- A5. Rule D5 — currencies are never merged and conversion_rate is ignored.
--     f07 carries conversion_rate 0.013 and must sum at FACE VALUE.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT total FROM got_daily WHERE day = '2026-04-08' AND currency = 'PKR') = 82.5
  AND NOT EXISTS (SELECT 1 FROM got_daily WHERE day = '2026-04-06' AND currency = 'AED'),
  'A5 no FX conversion, and PKR never folds into AED');

-- ═══════════════════════════════════════════════════════════════════════════
-- A6. Rule D6 / R7 — BOTH APP MODES. The two ledger-only rows (f08, f12: BOTH
--     account ids NULL) are counted exactly like full_tracker rows, and the
--     unbounded series accounts for every non-deleted row the user owns.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT COALESCE(sum(tx_count), 0)
     FROM public.analytics_daily_series('1970-01-01T00:00:00Z'::timestamptz, 'infinity'::timestamptz, 'UTC'))
  = (SELECT count(*) FROM public.transactions
      WHERE user_id = auth.uid() AND deleted_at IS NULL)
  AND (SELECT total FROM got_daily WHERE day = '2026-04-09' AND currency = 'AED') = 60
  AND EXISTS (SELECT 1 FROM got_daily WHERE day = '2026-04-13' AND "type" = 'repayment'),
  'A6 ledger-only rows (BOTH account ids NULL) aggregate identically — both app modes',
  'series: ' || (SELECT COALESCE(sum(tx_count), 0)
                   FROM public.analytics_daily_series('1970-01-01T00:00:00Z'::timestamptz,
                                                      'infinity'::timestamptz, 'UTC'))::text
    || ', table: ' || (SELECT count(*) FROM public.transactions
                        WHERE user_id = auth.uid() AND deleted_at IS NULL)::text);

-- ═══════════════════════════════════════════════════════════════════════════
-- A7. Rule D7 — the soft-deleted 99,999 row is invisible to BOTH new RPCs.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM public.analytics_daily_series(
                '1970-01-01T00:00:00Z'::timestamptz, 'infinity'::timestamptz, 'UTC')
               WHERE total >= 99999)
  AND NOT EXISTS (SELECT 1 FROM public.analytics_top_expenses(
                '1970-01-01T00:00:00Z'::timestamptz, 'infinity'::timestamptz, 100)
               WHERE id = 'f90'),
  'A7 soft-deleted rows never surface in either RPC');

-- ═══════════════════════════════════════════════════════════════════════════
-- A8. Rule D8 — owner scoping. H owns a 55,555 AED expense inside the window
--     and it must be invisible; a caller with NO jwt claim is refused outright.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM public.analytics_top_expenses(
                '1970-01-01T00:00:00Z'::timestamptz, 'infinity'::timestamptz, 100)
               WHERE id = 'h01')
  AND NOT EXISTS (SELECT 1 FROM public.analytics_daily_series(
                '1970-01-01T00:00:00Z'::timestamptz, 'infinity'::timestamptz, 'UTC')
               WHERE total = 55555),
  'A8 another user''s rows are invisible to both RPCs');

SELECT test.as_user(NULL::uuid);
SELECT test.assert_raises(
  $$ SELECT * FROM public.analytics_daily_series('2026-04-01T00:00:00Z'::timestamptz, '2026-05-31T00:00:00Z'::timestamptz, 'UTC') $$,
  'AUTH_REQUIRED',
  'A8b analytics_daily_series refuses a caller with no auth.uid()');
SELECT test.assert_raises(
  $$ SELECT * FROM public.analytics_top_expenses('2026-04-01T00:00:00Z'::timestamptz, '2026-05-31T00:00:00Z'::timestamptz, 5) $$,
  'AUTH_REQUIRED',
  'A8c analytics_top_expenses refuses a caller with no auth.uid()');
SELECT test.as_user('aaaaaaaa-0000-4000-8000-00000000000a');

-- ═══════════════════════════════════════════════════════════════════════════
-- A9. analytics_top_expenses is row-for-row equal to
--     topExpensesFromTransactions — same rows, same order, top 5 PER CURRENCY.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE got_top AS
  SELECT row_number() OVER () AS ord, *
    FROM public.analytics_top_expenses(
      '2026-04-01T00:00:00.000Z'::timestamptz,
      '2026-05-31T23:59:59.000Z'::timestamptz,
      5);

SELECT test.assert(
  (SELECT count(*) FROM got_top) = 7
  AND NOT EXISTS (
    SELECT 1 FROM got_top g
      FULL JOIN expect_top e ON e.ord = g.ord
     WHERE e.ord IS NULL OR g.ord IS NULL
        OR e.id <> g.id OR e.currency <> g.currency OR e.category <> g.category
        OR abs(e.amount - g.amount) > 1e-9),
  'A9 analytics_top_expenses == topExpensesFromTransactions (5 per currency, in order)',
  'sql rows: ' || (SELECT count(*) FROM got_top)::text);

-- ═══════════════════════════════════════════════════════════════════════════
-- A10. Rule T4 — p_limit is CLAMPED to 1..100, never trusted. A caller asking
--      for 0 still gets one row per currency; asking for 100000 cannot turn a
--      top-N list into a full-table export.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT count(*) FROM public.analytics_top_expenses(
     '2026-04-01T00:00:00Z'::timestamptz, '2026-05-31T23:59:59.000Z'::timestamptz, 0)) = 2
  AND (SELECT count(*) FROM public.analytics_top_expenses(
     '2026-04-01T00:00:00Z'::timestamptz, '2026-05-31T23:59:59.000Z'::timestamptz, NULL)) = 7
  AND (SELECT max(c) FROM (
        SELECT count(*) AS c FROM public.analytics_top_expenses(
          '1970-01-01T00:00:00Z'::timestamptz, 'infinity'::timestamptz, 100000)
         GROUP BY currency) s) <= 100,
  'A10 p_limit is clamped to 1..100 (0 → 1 per currency, NULL → default 5)');

-- ═══════════════════════════════════════════════════════════════════════════
-- A11. Rule T2 — the ranking tie-break. Three equal 100.00 expenses: t2 and t3
--      share a created_at, t1 is older. The client's stable sort over a
--      (created_at DESC, id DESC) store array yields t3, t2, t1.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT array_agg(id ORDER BY ord)
     FROM (SELECT row_number() OVER () AS ord, id
             FROM public.analytics_top_expenses(
               '2026-07-01T00:00:00Z'::timestamptz, '2026-07-31T00:00:00Z'::timestamptz, 5)) s)
  = ARRAY['t3','t2','t1'],
  'A11 amount ties break by created_at DESC then id DESC',
  (SELECT array_agg(id)::text FROM public.analytics_top_expenses(
     '2026-07-01T00:00:00Z'::timestamptz, '2026-07-31T00:00:00Z'::timestamptz, 5)));

-- ═══════════════════════════════════════════════════════════════════════════
-- A12. The two new functions carry the same compensating controls as the
--      monthly summary: SECURITY DEFINER + STABLE + a pinned search_path, and
--      EXECUTE granted ONLY to `authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('analytics_daily_series','analytics_top_expenses')
      AND p.prosecdef
      AND p.provolatile = 's'
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']) = 2
  AND NOT has_function_privilege('anon',
        'public.analytics_daily_series(timestamptz,timestamptz,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon',
        'public.analytics_top_expenses(timestamptz,timestamptz,integer)', 'EXECUTE')
  AND NOT has_function_privilege('public',
        'public.analytics_top_expenses(timestamptz,timestamptz,integer)', 'EXECUTE')
  AND has_function_privilege('authenticated',
        'public.analytics_daily_series(timestamptz,timestamptz,text)', 'EXECUTE')
  AND has_function_privilege('authenticated',
        'public.analytics_top_expenses(timestamptz,timestamptz,integer)', 'EXECUTE'),
  'A12 both RPCs are SECURITY DEFINER + STABLE + pinned search_path, executable only by authenticated');

-- ═══════════════════════════════════════════════════════════════════════════
-- A13. Cross-RPC consistency: the daily series and the monthly summary must
--      never disagree about the same window. This is what lets AnalyticsPage
--      show cards from one RPC and a chart from another on one screen.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert(
  NOT EXISTS (
    SELECT 1
      FROM (SELECT currency, "type", sum(total) AS total
              FROM public.analytics_daily_series(
                     '2026-04-01T00:00:00.000Z'::timestamptz,
                     '2026-05-31T23:59:59.000Z'::timestamptz, 'UTC')
             GROUP BY 1, 2) d
      FULL JOIN (SELECT currency, "type", sum(total) AS total
                   FROM public.analytics_monthly_summary(
                          '2026-04-01T00:00:00.000Z'::timestamptz,
                          '2026-05-31T23:59:59.000Z'::timestamptz, 'UTC')
                  GROUP BY 1, 2) m
        ON m.currency = d.currency AND m."type" = d."type"
     WHERE d.currency IS NULL OR m.currency IS NULL
        OR abs(d.total - m.total) > 1e-9),
  'A13 daily series and monthly summary agree per (currency, type) over one window');

-- ═══════════════════════════════════════════════════════════════════════════
-- A14. A NULL window is refused rather than silently scanning everything.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT test.assert_raises(
  $$ SELECT * FROM public.analytics_daily_series(NULL, now(), 'UTC') $$,
  'BAD_WINDOW',
  'A14 a NULL window is refused (BAD_WINDOW), not treated as unbounded');

SELECT test.as_user(NULL::uuid);
RESET ROLE;
