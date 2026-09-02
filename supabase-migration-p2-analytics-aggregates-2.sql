-- ═══════════════════════════════════════════════════════════════════════════
-- supabase-migration-p2-analytics-aggregates-2.sql
-- The rest of the Analytics fetch — audit P2 item M2 (03-performance.md H3/M2)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS FIXES
-- ---------------
-- `supabase-migration-p2-analytics-aggregates.sql` (M2c) moved the summary
-- cards, the currency chips and the category pie into Postgres via
-- `analytics_monthly_summary`. It stated its own limit plainly: it removed the
-- client-side SUMMING for three surfaces but NOT the full-history FETCH,
-- because three surfaces still needed row-level or finer-grained data:
--
--     dailySpending  → per-DAY grain, which a monthly bucket discards
--     topExpenses    → individual ROWS (amount, category, notes)
--     monthlyTrend   → a window that is not the selected period, AND a bucket
--                      end (`…, 0, 23, 59, 59`) that no SQL bucket reproduces
--
-- This file adds the two RPCs the first two need. The third needed no RPC: the
-- bucket-end problem was a BUG (it silently dropped the last 999 ms of every
-- month — money in the ledger, money in no chart), it is now fixed in
-- TypeScript (`endOfMonthExact` in src/lib/analytics.ts, pinned by
-- "counts a transaction in the LAST 999 ms of a month" in analytics.test.ts),
-- and a fixed bucket is EXACTLY one calendar month — which is exactly what
-- `date_trunc('month', …)` produces. So the trend is served by calling the
-- EXISTING `analytics_monthly_summary` over the trend window
-- (`monthlyTrendFromSummary`), and the spend-trend card the same way over the
-- previous window. Two new functions, three surfaces, no fourth RPC.
--
-- Net effect: with `VITE_ANALYTICS_RPC=true` and all three RPCs answering,
-- `AnalyticsPage` no longer calls `loadTransactions()` at all — the unbounded
-- `transactionsDb.getAll()` keyset walk (500 rows a page, no upper bound) is
-- gone from that page. Other pages that genuinely need the rows still load them.
--
-- STATUS / ROLLOUT
-- ----------------
--   * NON-BREAKING and SAFE TO APPLY AHEAD OF THE CLIENT. It creates two
--     functions and changes no existing object, policy, table, index or grant.
--     Nothing calls them until a build ships with `VITE_ANALYTICS_RPC=true`
--     (default OFF), and even then the page FAILS SOFT back to the client
--     aggregation if a call errors.
--   * IDEMPOTENT. `DROP FUNCTION IF EXISTS` + `CREATE OR REPLACE`. Re-applying
--     is a no-op beyond benign NOTICEs.
--   * APPLY ORDER: immediately AFTER
--     `supabase-migration-p2-analytics-aggregates.sql`. It shares that file's
--     prerequisites (`transactions` + its `deleted_at` column) and nothing else;
--     §1 aborts loudly if either is missing. It does NOT modify
--     `analytics_monthly_summary` — that function is untouched by this file.
--   * ADDS NO INDEX. §3 explains why the two indexes M2c already created are
--     enough, and why a third one on the app's most write-heavy table was not
--     worth its write cost.
--
-- EVIDENCE
-- --------
--   * docs/audit-2026-09/03-performance.md — H3 / M2.
--   * docs/performance.md §7 — "The rest of the Analytics fetch", the item this
--     file closes, including the monthlyTrend bucket-end note.
--   * src/lib/analytics.ts — `dailySeriesFromTransactions`,
--     `topExpensesFromTransactions` (the TypeScript twins of the two functions
--     below), `dailySpendingFromSeries`, `topExpensesFromRows`,
--     `monthlyTrendFromSummary`, `endOfMonthExact`.
--   * src/lib/analytics.test.ts — `ANALYTICS_FIXTURE`, the fixture §8 seeds.
--   * supabase/tests/tests/8x-analytics-rpcs.sql — the harness assertions.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE RULE-PORT TABLE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Rules D1-D8 govern `analytics_daily_series`, T1-T7 `analytics_top_expenses`.
-- Rules R1-R2 (soft-delete, owner scoping) and R5/R7/R8 (no FX, no account-id
-- predicate, NUMERIC sums) are inherited verbatim from
-- supabase-migration-p2-analytics-aggregates.sql and are restated only where
-- the port differs. "Pinned by" names what fails if the sides drift.
--
-- ┌────┬──────────────────────────────────────┬──────────────────────────────────────┬────────────────────────────┐
-- │ #  │ Rule in src/lib/analytics.ts +       │ Port in this file                    │ Pinned by                  │
-- │    │ AnalyticsPage.tsx                    │                                      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ D1 │ `dailySpending` filters              │ created_at >= p_from AND             │ analytics.test.ts "D1";    │
-- │    │ `new Date(t.createdAt) >= startDate  │ created_at <= p_to (timestamptz,     │ §8 equality; 8x A3         │
-- │    │  && … <= endDate` — INCLUSIVE both   │ exact instants — same reasoning as   │                            │
-- │    │ ends, compared as instants.          │ M2c's "WHY timestamptz").            │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ D2 │ Rows are bucketed by the LOCAL day   │ (created_at AT TIME ZONE v_tz)::date │ analytics.test.ts "D2";    │
-- │    │ (`new Date(t.createdAt).getDate()`). │ — a real calendar DATE, in the       │ §8 equality; 8x A4         │
-- │    │                                      │ caller's zone.                       │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ D3 │ The chart's bar key is the           │ NOT ported — ON PURPOSE. SQL returns │ analytics.test.ts "keeps   │
-- │    │ DAY-OF-MONTH, so a >1-month window   │ the DATE (a fact); the day-of-month  │ the 31-bar cap and the     │
-- │    │ collides Apr 5 with May 5, and the   │ fold + the 31-bar walk stay in       │ day-of-month collision"    │
-- │    │ bar walk stops after 31 bars.        │ `dailyFromDayOfMonthTotals`, shared  │                            │
-- │    │ Quirky, but shipped.                 │ verbatim by BOTH client paths.       │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ D4 │ Only `type='expense'` is spend; the  │ NOT ported as a filter — same reason │ analytics.test.ts "D4"     │
-- │    │ chart is one currency at a time.     │ as M2c R6. EVERY type and EVERY      │ + the derivation test      │
-- │    │                                      │ currency comes back, one row each;   │                            │
-- │    │                                      │ `dailySpendingFromSeries` filters.   │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ D5 │ No currency conversion, ever         │ GROUP BY currency. conversion_rate   │ analytics.test.ts "D3";    │
-- │    │ (M2c R5).                            │ is not referenced in this file.      │ 8x A5                      │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ D6 │ BOTH APP MODES (M2c R7): analytics   │ NO predicate on source_account_id or │ analytics.test.ts "D5";    │
-- │    │ reads type/amount/currency/createdAt │ destination_account_id, in either    │ 8x A6                      │
-- │    │ only. A splits_only row has BOTH     │ function.                            │                            │
-- │    │ account ids NULL.                    │                                      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ D7 │ Soft-deleted rows are never in the   │ WHERE deleted_at IS NULL             │ 8x A7                      │
-- │    │ store (M2c R1).                      │                                      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ D8 │ Only the signed-in user's rows       │ user_id = auth.uid(); NO user-id     │ 8x A8                      │
-- │    │ (M2c R2).                            │ parameter; AUTH_REQUIRED on NULL.    │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ T1 │ `topExpenses` filters type='expense' │ WHERE type = 'expense' — this ONE    │ analytics.test.ts "T1";    │
-- │    │ inside the window.                   │ type filter IS ported, because the   │ §8 equality                │
-- │    │                                      │ function's whole contract is "top    │                            │
-- │    │                                      │ EXPENSES"; there is no other         │                            │
-- │    │                                      │ consumer that could want more.       │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ T2 │ RANKING: `.sort((a,b) => b.amount -  │ ORDER BY amount DESC, created_at     │ analytics.test.ts "T3"     │
-- │    │ a.amount)` over `chartTransactions`. │ DESC, id DESC.                       │ (an explicit tie fixture); │
-- │    │ Array.sort is STABLE and the input   │                                      │ §8 equality                │
-- │    │ is the store array (created_at DESC, │                                      │                            │
-- │    │ id DESC — transactionsDb.getAllPaged │                                      │                            │
-- │    │ order), so equal amounts keep that   │                                      │                            │
-- │    │ order.                               │                                      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ T3 │ The page shows ONE currency's top N  │ Top N PER CURRENCY via row_number()  │ analytics.test.ts "T2";    │
-- │    │ (`chartTransactions` is filtered by  │ OVER (PARTITION BY currency …). A    │ 8x A9                      │
-- │    │ `chartCurrency` BEFORE the sort).    │ global top-N would hand a PKR viewer │                            │
-- │    │                                      │ five AED rows and an empty list. See │                            │
-- │    │                                      │ "WHY PARTITIONED" below.             │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ T4 │ `.slice(0, limit)`, limit=5 from the │ p_limit int DEFAULT 5, CLAMPED to    │ 8x A10                     │
-- │    │ page.                                │ 1..100 so a bad caller cannot ask    │                            │
-- │    │                                      │ for the whole table row by row.      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ T5 │ Rendered fields: category (title +   │ Returns exactly id, created_at,      │ analytics.test.ts "carries │
-- │    │ drill-in href), notes (subtitle via  │ amount, currency, category, notes.   │ exactly the columns the    │
-- │    │ parseInternalNote), amount+currency, │ Nothing else — no account ids, no    │ page renders"              │
-- │    │ id (React key).                      │ person, no loan/goal links.          │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ T6 │ `tx.category || 'Other'` is applied  │ NOT ported. Raw category is returned │ analytics.test.ts          │
-- │    │ at RENDER time in the top list (NOT  │ (COALESCE to '' for NULL only), and  │ "topExpensesFromRows ===   │
-- │    │ in the aggregation, unlike the pie's │ the page applies `|| 'Other'` — the  │ topExpenses"               │
-- │    │ R4).                                 │ same expression it always did.       │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ T7 │ Same window/soft-delete/owner/both-  │ Identical clauses to D1/D6/D7/D8.    │ 8x A6-A8                   │
-- │    │ modes rules as everything above.     │                                      │                            │
-- └────┴──────────────────────────────────────┴──────────────────────────────────────┴────────────────────────────┘
--
-- WHY PARTITIONED BY CURRENCY (a deliberate deviation)
-- ----------------------------------------------------
-- The audit's suggested signature is `analytics_top_expenses(p_from, p_to,
-- p_currency, p_limit)`; docs/performance.md §7 carries the same shape. The
-- signature implemented here drops `p_currency` and returns the top `p_limit`
-- per currency instead. Reason: the page lets the user flip between currency
-- chips WITHOUT re-fetching (today it re-slices `chartTransactions` in memory).
-- A per-currency parameter would have made every chip tap a network round-trip;
-- a partitioned result answers every chip from the one call and is a strict
-- superset of what any single-currency call would return. The client filter
-- (`topExpensesFromRows`) is the same `.filter(currency === chartCurrency)` the
-- page already performs. Result size is bounded by
-- `p_limit × (currencies the user actually spends in)` — single digits.
--
-- WHY SECURITY DEFINER
-- --------------------
-- Same argument as M2c, with one honest difference worth stating: unlike the
-- aggregates, `analytics_top_expenses` returns ROW-LEVEL data, so "the
-- aggregate has nothing per-row to authorise" does not apply to it. Its
-- compensating controls are therefore doing real work and are all checkable
-- (§6 V1/V2 and the 8x harness): a pinned `search_path`, NO user-id parameter
-- of any kind, an explicit `user_id = auth.uid()` predicate that is the ONLY
-- way rows are selected, a hard refusal when `auth.uid()` is NULL, a clamped
-- `p_limit`, `EXECUTE` revoked from `public`/`anon`, and `STABLE` +
-- `RETURNS TABLE` so it cannot write. It is SECURITY DEFINER rather than
-- INVOKER for exactly one reason: the `transactions` RLS policy is re-evaluated
-- per row, and the whole point of this file is to stop paying per-row costs
-- over a full history.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- §1. Preconditions (loud, not silent)
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.transactions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.transactions does not exist. Apply supabase-schema.sql first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'deleted_at'
  ) THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: public.transactions has no deleted_at column. Apply supabase-migration-incremental-sync-core.sql FIRST, then re-run this file.';
  END IF;

  -- Not a hard dependency (nothing here calls it), but applying this file
  -- without its sibling means the client still cannot drop the full-history
  -- fetch: AnalyticsPage needs all THREE RPCs before it skips loadTransactions.
  IF to_regprocedure('public.analytics_monthly_summary(timestamptz,timestamptz,text)') IS NULL THEN
    RAISE WARNING
      'analytics_monthly_summary is missing — apply supabase-migration-p2-analytics-aggregates.sql too, or AnalyticsPage will keep fetching the full history.';
  END IF;
END
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- §2. analytics_daily_series — per-day totals per (currency, type)
-- ───────────────────────────────────────────────────────────────────────────
-- Grain: one row per (local calendar DATE, currency, transaction type).
-- Serves the daily-spend chart. Rules D1-D8 above.

DROP FUNCTION IF EXISTS public.analytics_daily_series(timestamptz, timestamptz, text);

CREATE OR REPLACE FUNCTION public.analytics_daily_series(
  p_from timestamptz,
  p_to   timestamptz,
  p_tz   text DEFAULT 'UTC'
)
RETURNS TABLE (
  "day"    date,
  currency text,
  "type"   text,
  total    numeric,
  tx_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tz  text := COALESCE(NULLIF(p_tz, ''), 'UTC');
BEGIN
  -- D8. SECURITY DEFINER bypasses RLS, so this predicate IS the authorisation.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: analytics_daily_series is per-user and needs a signed-in caller.'
      USING ERRCODE = '28000';
  END IF;

  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'BAD_WINDOW: p_from and p_to are both required.'
      USING ERRCODE = '22023';
  END IF;

  -- An unknown zone must not take the page down: fall back to UTC, which is
  -- also what a browser reporting no resolved zone would send.
  BEGIN
    PERFORM now() AT TIME ZONE v_tz;
  EXCEPTION WHEN OTHERS THEN
    v_tz := 'UTC';
  END;

  RETURN QUERY
  SELECT
    (t.created_at AT TIME ZONE v_tz)::date   AS "day",     -- D2
    t.currency::text                         AS currency,  -- D5
    t.type::text                             AS "type",    -- D4
    sum(t.amount)                            AS total,
    count(*)                                 AS tx_count
  FROM public.transactions t
  WHERE t.user_id = v_uid                 -- D8
    AND t.deleted_at IS NULL              -- D7
    AND t.created_at >= p_from            -- D1 (inclusive)
    AND t.created_at <= p_to              -- D1 (inclusive)
    -- D6: NO predicate on source_account_id / destination_account_id. A
    -- splits_only ledger row carries BOTH as NULL and must count identically.
  GROUP BY 1, 2, 3
  ORDER BY 1, 2, 3;   -- matches dailySeriesFromTransactions' row order
END
$$;

COMMENT ON FUNCTION public.analytics_daily_series(timestamptz, timestamptz, text) IS
  'Per-(local day, currency, type) transaction sums for the CALLING user. '
  'Read-only, owner-scoped, skips soft-deleted rows, never converts currency, '
  'never reads an account id (identical in full_tracker and splits_only). '
  'TypeScript twin: src/lib/analytics.ts dailySeriesFromTransactions.';

REVOKE ALL ON FUNCTION public.analytics_daily_series(timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_daily_series(timestamptz, timestamptz, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_daily_series(timestamptz, timestamptz, text) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- §3. analytics_top_expenses — top N expense ROWS per currency
-- ───────────────────────────────────────────────────────────────────────────
-- Grain: individual rows. The only row-level RPC in the analytics family, and
-- the only one that filters on `type` (rule T1). Rules T1-T7 above.

DROP FUNCTION IF EXISTS public.analytics_top_expenses(timestamptz, timestamptz, integer);

CREATE OR REPLACE FUNCTION public.analytics_top_expenses(
  p_from  timestamptz,
  p_to    timestamptz,
  p_limit integer DEFAULT 5
)
RETURNS TABLE (
  id         text,
  created_at timestamptz,
  amount     numeric,
  currency   text,
  category   text,
  notes      text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  -- T4. Clamped, not trusted: a caller cannot turn a top-5 list into a
  -- full-table export one page at a time.
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 5), 1), 100);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: analytics_top_expenses is per-user and needs a signed-in caller.'
      USING ERRCODE = '28000';
  END IF;

  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'BAD_WINDOW: p_from and p_to are both required.'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH ranked AS (
    SELECT
      t.id::text                       AS id,
      t.created_at                     AS created_at,
      t.amount                         AS amount,
      t.currency::text                 AS currency,
      -- T6: raw category. `|| 'Other'` stays at render time, client-side.
      COALESCE(t.category, '')::text   AS category,
      COALESCE(t.notes, '')::text      AS notes,
      row_number() OVER (
        PARTITION BY t.currency                                   -- T3
        ORDER BY t.amount DESC, t.created_at DESC, t.id DESC      -- T2
      ) AS rn
    FROM public.transactions t
    WHERE t.user_id = v_uid               -- T7 / D8
      AND t.deleted_at IS NULL            -- T7 / D7
      AND t.type = 'expense'              -- T1 (the one ported type filter)
      AND t.created_at >= p_from          -- T7 / D1 (inclusive)
      AND t.created_at <= p_to            -- T7 / D1 (inclusive)
      -- T7 / D6: NO predicate on either account id — a splits_only ledger
      -- expense (BOTH ids NULL) can rank exactly like a full_tracker one.
  )
  SELECT r.id, r.created_at, r.amount, r.currency, r.category, r.notes
    FROM ranked r
   WHERE r.rn <= v_limit                                          -- T4
   ORDER BY r.currency, r.amount DESC, r.created_at DESC, r.id DESC;
END
$$;

COMMENT ON FUNCTION public.analytics_top_expenses(timestamptz, timestamptz, integer) IS
  'Top p_limit expense rows PER CURRENCY in [p_from, p_to] for the CALLING user, '
  'ranked amount DESC, created_at DESC, id DESC. Read-only, owner-scoped, skips '
  'soft-deleted rows, never reads an account id. p_limit is clamped to 1..100. '
  'TypeScript twin: src/lib/analytics.ts topExpensesFromTransactions.';

REVOKE ALL ON FUNCTION public.analytics_top_expenses(timestamptz, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_top_expenses(timestamptz, timestamptz, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_top_expenses(timestamptz, timestamptz, integer) TO authenticated;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- §4. What this file does NOT do
-- ═══════════════════════════════════════════════════════════════════════════
--   * It does not touch `analytics_monthly_summary`, any table, policy,
--     trigger, publication, or any grant other than its own two functions'.
--   * It adds NO INDEX. The two that
--     supabase-migration-p2-analytics-aggregates.sql created already cover
--     both queries' access path — `idx_transactions_user_created (user_id,
--     created_at DESC)` for the range, and the partial covering
--     `idx_transactions_analytics_summary (user_id, created_at) INCLUDE
--     (currency, type, category, amount) WHERE deleted_at IS NULL`, which makes
--     `analytics_daily_series` an index-only scan (it needs no column outside
--     that INCLUDE list). `analytics_top_expenses` needs `notes` and therefore
--     pays heap fetches — but only for rows inside a bounded window, and the
--     result is single digits. A third index (e.g. on `(user_id, type,
--     created_at)`) would buy that one query a little and charge EVERY
--     transaction write for it, forever. Declined, deliberately.
--   * It does not add a materialized view or any cached aggregate. Nothing to
--     refresh, nothing that can go stale.
--   * It does not change the flag. `VITE_ANALYTICS_RPC` still gates all three
--     RPCs together, and still fails soft.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §5. Rollback
-- ═══════════════════════════════════════════════════════════════════════════
-- In practice: unset `VITE_ANALYTICS_RPC` and redeploy — both functions are
-- inert with no caller. To remove them entirely:
--
--   DROP FUNCTION IF EXISTS public.analytics_daily_series(timestamptz, timestamptz, text);
--   DROP FUNCTION IF EXISTS public.analytics_top_expenses(timestamptz, timestamptz, integer);
--   -- do NOT drop analytics_monthly_summary or either index; they predate this file.
--
-- Note the client behaviour if only these two are dropped while the flag stays
-- on: the page reports the failure through `reportError` and falls back to
-- `loadTransactions()` + client aggregation — the pre-M2 code path, intact.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §6. Verification (run after applying; V3+ need a signed-in session)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- V1. Both functions exist, are SECURITY DEFINER + STABLE, with a pinned
--     search_path. Expect two rows, each definer=t, volatile='s',
--     search_path='{search_path=public, pg_temp}'.
--
-- SELECT p.proname,
--        p.prosecdef   AS definer,
--        p.provolatile AS volatile,
--        p.proconfig   AS search_path
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('analytics_daily_series', 'analytics_top_expenses')
--  ORDER BY p.proname;
--
-- V2. Only `authenticated` may execute them. Expect anon=f, auth=t, public=f
--     on both rows.
--
-- SELECT f AS fn,
--        has_function_privilege('anon',          f, 'EXECUTE') AS anon_can,
--        has_function_privilege('authenticated', f, 'EXECUTE') AS auth_can,
--        has_function_privilege('public',        f, 'EXECUTE') AS public_can
--   FROM (VALUES
--     ('public.analytics_daily_series(timestamptz,timestamptz,text)'),
--     ('public.analytics_top_expenses(timestamptz,timestamptz,integer)')
--   ) AS v(f);
--
-- V3. Sane output for the signed-in user. Compare the expense rows against the
--     daily chart for the same window.
--
-- SELECT * FROM public.analytics_daily_series(
--          date_trunc('month', now())::timestamptz, now(), 'UTC')
--  WHERE "type" = 'expense'
--  ORDER BY "day", currency;
--
-- V4. The daily series adds up to the monthly summary over the same window —
--     the two RPCs must never disagree. Expect zero rows.
--
-- SELECT d.currency, d."type", d.total AS daily_total, m.total AS monthly_total
--   FROM (SELECT currency, "type", sum(total) AS total
--           FROM public.analytics_daily_series(
--                  date_trunc('month', now())::timestamptz, now(), 'UTC')
--          GROUP BY 1, 2) d
--   FULL JOIN (SELECT currency, "type", sum(total) AS total
--                FROM public.analytics_monthly_summary(
--                       date_trunc('month', now())::timestamptz, now(), 'UTC')
--               GROUP BY 1, 2) m
--     ON m.currency = d.currency AND m."type" = d."type"
--  WHERE COALESCE(d.total, -1) IS DISTINCT FROM COALESCE(m.total, -1);
--
-- V5. Top expenses are owner-scoped and expense-only. Expect should_be_zero = 0.
--
-- SELECT count(*) AS should_be_zero
--   FROM public.analytics_top_expenses('1970-01-01Z'::timestamptz, 'infinity'::timestamptz, 100) x
--   JOIN public.transactions t ON t.id = x.id
--  WHERE t.user_id <> auth.uid() OR t.type <> 'expense' OR t.deleted_at IS NOT NULL;
--
-- V6. Both app modes. A splits_only user's ledger rows (BOTH account ids NULL)
--     must be inside the daily series' counts. Expect ledger_rows_counted = t.
--
-- SELECT (SELECT count(*) FROM public.transactions
--          WHERE user_id = auth.uid() AND deleted_at IS NULL
--            AND source_account_id IS NULL AND destination_account_id IS NULL) = 0
--        OR (SELECT COALESCE(sum(tx_count), 0)
--              FROM public.analytics_daily_series('1970-01-01Z'::timestamptz, 'infinity'::timestamptz, 'UTC'))
--           = (SELECT count(*) FROM public.transactions
--               WHERE user_id = auth.uid() AND deleted_at IS NULL)
--        AS ledger_rows_counted;
--
-- V7. Plans use an index, not a sequential scan. Expect an Index Only Scan on
--     idx_transactions_analytics_summary for the first, and an Index Scan on
--     one of the two transactions indexes for the second.
--
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT (created_at AT TIME ZONE 'UTC')::date, currency, type, sum(amount), count(*)
--   FROM public.transactions
--  WHERE user_id = auth.uid() AND deleted_at IS NULL
--    AND created_at >= (now() - interval '1 year') AND created_at <= now()
--  GROUP BY 1, 2, 3;
--
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT id, created_at, amount, currency, category, notes
--   FROM public.transactions
--  WHERE user_id = auth.uid() AND deleted_at IS NULL AND type = 'expense'
--    AND created_at >= (now() - interval '1 year') AND created_at <= now()
--  ORDER BY amount DESC, created_at DESC, id DESC
--  LIMIT 5;
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §7. The client flag
-- ═══════════════════════════════════════════════════════════════════════════
--   VITE_ANALYTICS_RPC   unset / anything but 'true'  → today's behaviour:
--                        AnalyticsPage calls loadTransactions() and aggregates
--                        client-side. Neither function here is ever called.
--                        'true'                        → the page calls all
--                        three analytics RPCs and, when ALL of them answer,
--                        SKIPS loadTransactions() entirely. If ANY call fails
--                        (unapplied migration → PGRST202, offline, timeout) it
--                        reports through reportError, loads the transactions and
--                        renders the client aggregation — a finance app must
--                        never answer "how much did I spend" with a blank card.
--
-- Rollout: apply supabase-migration-p2-analytics-aggregates.sql (if it is not
-- applied yet) → apply THIS file → run §6 → ship a web build with the flag on →
-- ship the Android AAB with the same flag (the Play binary lags the web
-- deploy). No step is breaking; rollback at any point is unsetting the flag.
-- Narrative: docs/performance.md §6.6.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §8. Integration test — how these RPCs were proven equal to the TypeScript
-- ═══════════════════════════════════════════════════════════════════════════
-- Harness: `supabase/tests/run.sh` (postgres:15 in Docker, the whole SQL corpus
-- in canonical apply order, then supabase/tests/tests/*.sql as role
-- `authenticated`). This file's assertions live in
-- supabase/tests/tests/8x-analytics-rpcs.sql.
--
-- Seed: `ANALYTICS_FIXTURE` from src/lib/analytics.test.ts, inserted verbatim —
-- 18 rows covering two currencies, a conversion_rate-bearing row, a ledger-only
-- row with BOTH account ids NULL, an empty category, four non-income/expense
-- types, two calendar months, both window edges, one row outside each edge —
-- plus, added by the harness, a soft-deleted row, a row owned by a DIFFERENT
-- user, and an amount-tie pair that exercises rule T2.
--
-- Assertion: each RPC's output, run as `authenticated` with the fixture user's
-- jwt claim, is compared against the TypeScript twin's output for the same
-- fixture and window — same row count, same order, same values (totals to
-- within 1e-9, rule R8).
--
-- Result and what it does NOT prove: see docs/performance.md §6.6.
