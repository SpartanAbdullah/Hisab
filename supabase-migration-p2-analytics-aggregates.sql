-- ═══════════════════════════════════════════════════════════════════════════
-- supabase-migration-p2-analytics-aggregates.sql
-- SQL-side analytics aggregates — audit P2 item M2 (03-performance.md H3/M2)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS FIXES
-- ---------------
-- `src/pages/AnalyticsPage.tsx` calls `loadTransactions()`, which is
-- `transactionsDb.getAll()` — a keyset-paged fetch of the user's ENTIRE
-- transaction history (`src/lib/supabaseDb.ts`, 500 rows a page, no upper
-- bound) — and then sums the whole array in the browser on every render pass:
-- `sumByCurrency` × 2, `groupByCategory`, `monthlyTrend`, `dailySpending`,
-- `topExpenses`, plus a second `previousRange` pass for the spend-trend card.
-- Audit 03-performance.md M2 flags this as the "Analytics aggregates the full
-- history client-side" item; on a low-end Android over 3G (07-mobile-first.md
-- MF-14) it is both the bytes and the main-thread time.
--
-- This file adds ONE read-only aggregate RPC, `analytics_monthly_summary`, so
-- Postgres does the grouping and the client receives tens of rows instead of
-- thousands.
--
-- STATUS / ROLLOUT
-- ----------------
--   * NON-BREAKING and SAFE TO APPLY AHEAD OF THE CLIENT. It creates one
--     function and one index and changes no existing object, no policy and no
--     table. Nothing in the shipped client calls it until a build ships with
--     `VITE_ANALYTICS_RPC=true` (default OFF — see §7 and docs/performance.md
--     §6.5). With the flag off, AnalyticsPage's code path is unchanged.
--   * IDEMPOTENT. Every statement is `CREATE OR REPLACE` / `IF NOT EXISTS` /
--     `DROP … IF EXISTS`. Re-applying is a no-op beyond benign NOTICEs.
--   * APPLY ORDER: after `supabase-migration-p1-money-bounds.sql`, and in
--     practice LAST — after every file in docs/audit-2026-09/APPLY-ORDER.md §1
--     and §2 and after `supabase-migration-p2-realtime-broadcast.sql`. It
--     shares no object with any of them, so the position is a safe default
--     rather than a dependency. Its ONLY hard prerequisites are the
--     `transactions` table (supabase-schema.sql) and its `deleted_at` column
--     (`supabase-migration-incremental-sync-core.sql`); §1 aborts loudly if
--     either is missing.
--
-- EVIDENCE
-- --------
--   * docs/audit-2026-09/03-performance.md — H3 / M2 ("Analytics page
--     aggregates the user's entire transaction history client-side").
--   * docs/audit-2026-09/07-mobile-first.md — MF-14 (cold start / data cost on
--     a low-end Android over 3G).
--   * src/pages/AnalyticsPage.tsx — the six client-side aggregation passes.
--   * src/lib/analytics.ts — the pure aggregation this file had to port, and
--     `monthlySummaryFromTransactions` in the same file, which is the exact
--     TypeScript twin of the RPC below.
--   * src/lib/analytics.test.ts — `ANALYTICS_FIXTURE`, the fixture §8 seeds.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE RULE-PORT TABLE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every rule the client aggregation obeys, and how (or whether) it crossed into
-- SQL. "Pinned by" names the test that fails if the two sides drift.
--
-- ┌────┬──────────────────────────────────────┬──────────────────────────────────────┬────────────────────────────┐
-- │ #  │ Rule in src/lib/analytics.ts +       │ Port in this file                    │ Pinned by                  │
-- │    │ AnalyticsPage.tsx                    │                                      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ R1 │ The store only ever holds rows with  │ WHERE t.deleted_at IS NULL           │ §6 V4 (Docker: a           │
-- │    │ deleted_at IS NULL (transactionsDb   │                                      │ soft-deleted row is        │
-- │    │ .getAllPaged filters `.is('deleted_  │                                      │ excluded)                  │
-- │    │ at', null)). Analytics never sees a   │                                      │                            │
-- │    │ soft-deleted row.                    │                                      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ R2 │ Only the signed-in user's rows       │ WHERE t.user_id = auth.uid(); the    │ §6 V5 (Docker: a second    │
-- │    │ (`.eq('user_id', getUserId())`).     │ function takes NO user-id parameter  │ user's rows never appear)  │
-- │    │                                      │ and raises AUTH_REQUIRED on a null   │                            │
-- │    │                                      │ auth.uid().                          │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ R3 │ Window is INCLUSIVE at both ends and │ created_at >= p_from AND             │ analytics.test.ts "R3: the │
-- │    │ compared as INSTANTS:                │ created_at <= p_to, both timestamptz │ window is inclusive at     │
-- │    │ `new Date(t.createdAt) >= start &&   │ (see "WHY timestamptz" below)        │ BOTH ends"; §8 equality    │
-- │    │  new Date(t.createdAt) <= end`       │                                      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ R4 │ `t.category || 'Other'` — an EMPTY   │ COALESCE(NULLIF(t.category,''),      │ analytics.test.ts "R4"     │
-- │    │ string is a missing category, and    │ 'Other'); NULLIF catches '' and      │ + §8 equality              │
-- │    │ JS `||` also catches null/undefined. │ COALESCE catches NULL.               │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ R5 │ NO currency conversion, ANYWHERE.    │ GROUP BY t.currency; conversion_rate │ analytics.test.ts "R5"     │
-- │    │ Figures stay per-currency; the       │ is not referenced by this file at    │ (a row carrying            │
-- │    │ chart filters to ONE currency        │ all. Multi-currency users get one    │ conversion_rate 0.013 sums │
-- │    │ (`tx.currency === chartCurrency`)    │ row per currency, never a total.     │ at face value)             │
-- │    │ and the cards list each separately.  │                                      │                            │
-- │    │ `conversion_rate` on a transaction   │                                      │                            │
-- │    │ describes the ACCOUNT leg, not an    │                                      │                            │
-- │    │ analytics rate — analytics.ts never  │                                      │                            │
-- │    │ reads it.                            │                                      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ R6 │ Only `type = 'expense'` counts as    │ NOT ported as a filter — ON PURPOSE. │ analytics.test.ts "R6"     │
-- │    │ spend and `type = 'income'` as       │ The RPC returns one row per type and │ + the derivation tests     │
-- │    │ income. transfer / adjustment /      │ the CLIENT filters, so the single    │                            │
-- │    │ opening_balance / goal_contribution /│ definition of "what is spend" stays  │                            │
-- │    │ loan_given / loan_taken / repayment /│ in analytics.ts and cannot drift out │                            │
-- │    │ investment_buy / investment_sell /   │ of step with a hardcoded SQL list.   │                            │
-- │    │ investment_dividend are IGNORED.     │                                      │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ R7 │ BOTH APP MODES. Analytics reads      │ No predicate on source_account_id or │ analytics.test.ts "R7";    │
-- │    │ type/amount/currency/category/       │ destination_account_id anywhere in   │ §6 V6 (Docker: a row with  │
-- │    │ createdAt only — never an account    │ this file. A splits_only ledger row  │ BOTH account ids NULL is   │
-- │    │ id. A splits_only (ledger-only) row  │ with BOTH ids NULL aggregates like   │ aggregated identically)    │
-- │    │ has BOTH account ids NULL and must   │ any other. full_tracker and          │                            │
-- │    │ aggregate identically.               │ splits_only produce IDENTICAL rows.  │                            │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ R8 │ Sums are IEEE-754 adds in array      │ sum(t.amount) over NUMERIC, returned │ §8 equality compares at    │
-- │    │ order.                               │ as numeric. Postgres is exact where  │ 1e-9; the app's money is   │
-- │    │                                      │ JS accumulates float error, so the   │ 2-dp and every figure is   │
-- │    │                                      │ two can differ in the ~1e-13 range.  │ rendered via formatMoney   │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │ R9 │ Category COLOUR is assigned by FIRST │ Not computed in SQL. The RPC returns │ analytics.test.ts          │
-- │    │ APPEARANCE in the transaction array  │ max(created_at) per bucket; the      │ "assigns colour by FIRST   │
-- │    │ (the Map insertion index is used     │ client orders categories by that     │ APPEARANCE" and            │
-- │    │ BEFORE the .sort by amount), and the │ DESC, which IS first-appearance      │ "groupByCategoryFromSummary│
-- │    │ store is created_at DESC.            │ order in a created_at-DESC list.     │ === groupByCategory"       │
-- ├────┼──────────────────────────────────────┼──────────────────────────────────────┼────────────────────────────┤
-- │R10 │ percentage = round(amount/total*100),│ Stays 100% CLIENT-side               │ "groupByCategoryFromSummary│
-- │    │ 0 when total <= 0; ranking by amount │ (`categoryDataFrom`, shared verbatim │ === groupByCategory"       │
-- │    │ DESC; COLORS[i % 10].                │ by both paths).                      │                            │
-- └────┴──────────────────────────────────────┴──────────────────────────────────────┴────────────────────────────┘
--
-- NOT PORTED, and why (each still runs client-side, on the loaded rows):
--   * `dailySpending`  — needs per-DAY grain, which a monthly summary discards.
--   * `topExpenses`    — needs individual ROWS (id, notes, amount), not sums.
--   * `monthlyTrend`   — needs a window that is NOT the selected period (it
--                        always walks N months back from *now*), and its bucket
--                        end is `…, 0, 23, 59, 59` — i.e. it silently drops the
--                        last 999 ms of every month, which a `date_trunc`
--                        bucket does not. Serving it from here would introduce
--                        a divergence this file refuses to hide.
--   * the spend-trend card — same story: its own previous-period window.
-- Consequence, stated plainly: this migration removes the CLIENT-SIDE SUMMING
-- for the summary cards, the currency chips and the category pie. It does NOT
-- yet remove the full-history FETCH, because the three items above still need
-- row-level data. That is the follow-on item recorded in docs/performance.md §7.
--
-- WHY timestamptz PARAMETERS, not `date`
-- --------------------------------------
-- The audit item names `analytics_monthly_summary(p_from date, p_to date)`.
-- Whole-day `date` parameters cannot express the windows AnalyticsPage actually
-- uses: three of its four periods end at `now` — an instant in the middle of a
-- day — and `getDateRange('last_month')` ends at `…, 0, 23, 59, 59`. A `date`
-- signature would have had to widen the last day, which silently pulls in
-- future-dated rows the client path excludes (Hisaab lets the user set
-- `createdAt`, so those exist). Since the whole point of this task is that the
-- two paths produce IDENTICAL figures, the parameters are `timestamptz` and the
-- boundary is exact. `p_tz` (an IANA zone, default 'UTC') controls only the
-- MONTH BUCKETING, so a UTC+4 device's "April" is the device's April.
--
-- WHY SECURITY DEFINER
-- --------------------
-- The `transactions` RLS policy is re-evaluated per row; over a full history
-- that is the cost this file exists to remove, and an aggregate returning only
-- grouped sums has nothing per-row to authorise. The compensating controls are
-- all here and all checkable (§6 V1/V2): a pinned `search_path`, no user-id
-- parameter of any kind, an explicit `user_id = auth.uid()` predicate, a hard
-- refusal when `auth.uid()` is NULL, EXECUTE revoked from `public`/`anon`, and
-- `STABLE` + `RETURNS TABLE` so the function cannot write anything.
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
END
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- §2. The RPC
-- ───────────────────────────────────────────────────────────────────────────
-- Grain: one row per (local calendar month, currency, transaction type,
-- category). See the rule-port table above for what each clause is a port of.
--
-- `latest_at` (= max(created_at) in the bucket) exists solely so the client can
-- reproduce the category COLOUR order without row-level data — rule R9.

DROP FUNCTION IF EXISTS public.analytics_monthly_summary(timestamptz, timestamptz, text);

CREATE OR REPLACE FUNCTION public.analytics_monthly_summary(
  p_from timestamptz,
  p_to   timestamptz,
  p_tz   text DEFAULT 'UTC'
)
RETURNS TABLE (
  month_start date,
  currency    text,
  "type"      text,
  category    text,
  total       numeric,
  tx_count    bigint,
  latest_at   timestamptz
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
  -- R2. SECURITY DEFINER bypasses RLS, so this predicate IS the authorisation.
  -- There is deliberately no user-id parameter: the only readable rows are the
  -- caller's own.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: analytics_monthly_summary is per-user and needs a signed-in caller.'
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
    -- Month bucket in the CALLER's zone, so a UTC+4 device's April is April.
    (date_trunc('month', t.created_at AT TIME ZONE v_tz))::date        AS month_start,
    t.currency::text                                                  AS currency,
    t.type::text                                                      AS "type",
    -- R4: '' and NULL are both "no category", exactly like JS `||`.
    COALESCE(NULLIF(t.category, ''), 'Other')                         AS category,
    -- R5/R8: face-value sum, per currency. conversion_rate is NOT read.
    sum(t.amount)                                                     AS total,
    count(*)                                                          AS tx_count,
    -- R9: lets the client rebuild first-appearance colour order.
    max(t.created_at)                                                 AS latest_at
  FROM public.transactions t
  WHERE t.user_id = v_uid                 -- R2
    AND t.deleted_at IS NULL              -- R1
    AND t.created_at >= p_from            -- R3 (inclusive)
    AND t.created_at <= p_to              -- R3 (inclusive)
    -- R7: NO predicate on source_account_id / destination_account_id. A
    -- splits_only ledger row carries BOTH as NULL and must count identically.
    -- R6: NO predicate on t.type. Every type is returned; the client decides
    -- what counts as spend/income, so that rule has exactly one definition.
  GROUP BY 1, 2, 3, 4
  ORDER BY 1, 2, 3, 4;   -- matches monthlySummaryFromTransactions' row order
END
$$;

COMMENT ON FUNCTION public.analytics_monthly_summary(timestamptz, timestamptz, text) IS
  'Per-(month, currency, type, category) transaction sums for the CALLING user. '
  'Read-only, owner-scoped, skips soft-deleted rows, never converts currency, '
  'never reads an account id (identical in full_tracker and splits_only). '
  'TypeScript twin + rule-port table: src/lib/analytics.ts '
  'monthlySummaryFromTransactions / supabase-migration-p2-analytics-aggregates.sql.';

REVOKE ALL ON FUNCTION public.analytics_monthly_summary(timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_monthly_summary(timestamptz, timestamptz, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_monthly_summary(timestamptz, timestamptz, text) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- §3. Index
-- ───────────────────────────────────────────────────────────────────────────
-- `supabase-migration-performance-indexes.sql` (§ "transactions") ALREADY
-- creates:
--     idx_transactions_user_created ON public.transactions (user_id, created_at DESC)
-- which supports this RPC's `user_id = ? AND created_at BETWEEN ? AND ?` range
-- perfectly well. It is restated below with IF NOT EXISTS purely so this file
-- is self-sufficient on a database where that migration was never applied — on
-- a normal project it is a no-op NOTICE.
--
-- The second index is the actual addition: partial (soft-deleted rows are never
-- read by anything here) and COVERING, so the aggregate can be satisfied by an
-- index-only scan without touching the heap at all — which is the difference
-- between "cheap" and "cheap on a 20k-row history".
--
-- COST, stated honestly: this is a second index on the app's most
-- write-heavy table. Every transaction insert/update maintains it. If write
-- latency ever matters more than Analytics, DROP it (§5) — the RPC still works,
-- just via idx_transactions_user_created plus heap fetches.

CREATE INDEX IF NOT EXISTS idx_transactions_user_created
  ON public.transactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_analytics_summary
  ON public.transactions (user_id, created_at)
  INCLUDE (currency, type, category, amount)
  WHERE deleted_at IS NULL;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- §4. What this file does NOT do
-- ═══════════════════════════════════════════════════════════════════════════
--   * It does not touch any table, policy, trigger, publication or grant other
--     than its own function's.
--   * It does not add a materialized view or any cached aggregate. There is
--     nothing to refresh and nothing that can go stale.
--   * It does not make the client stop fetching transactions — see "NOT PORTED"
--     in the header. That needs a daily-grain RPC and a top-expenses RPC.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §5. Rollback
-- ═══════════════════════════════════════════════════════════════════════════
-- In practice the rollback is "unset VITE_ANALYTICS_RPC and redeploy" — the
-- function is inert with no caller. To remove it entirely:
--
--   DROP FUNCTION IF EXISTS public.analytics_monthly_summary(timestamptz, timestamptz, text);
--   DROP INDEX  IF EXISTS public.idx_transactions_analytics_summary;
--   -- do NOT drop idx_transactions_user_created; it predates this file.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §6. Verification (run after applying; V3-V6 need a signed-in session)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- V1. The function exists, is SECURITY DEFINER, STABLE, and has a pinned
--     search_path. Expect exactly one row: definer=t, volatile='s',
--     search_path='{search_path=public, pg_temp}'.
--
-- SELECT p.proname,
--        p.prosecdef              AS definer,
--        p.provolatile            AS volatile,
--        p.proconfig              AS search_path
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'analytics_monthly_summary';
--
-- V2. Only `authenticated` may execute it. Expect: anon=f, authenticated=t,
--     public=f.
--
-- SELECT has_function_privilege('anon',
--          'public.analytics_monthly_summary(timestamptz,timestamptz,text)', 'EXECUTE') AS anon_can,
--        has_function_privilege('authenticated',
--          'public.analytics_monthly_summary(timestamptz,timestamptz,text)', 'EXECUTE') AS auth_can,
--        has_function_privilege('public',
--          'public.analytics_monthly_summary(timestamptz,timestamptz,text)', 'EXECUTE') AS public_can;
--
-- V3. It returns something sensible for the signed-in user. Compare the
--     `expense` rows against what the Analytics page shows for the same window.
--
-- SELECT * FROM public.analytics_monthly_summary(
--          (date_trunc('month', now()) - interval '2 months')::timestamptz,
--          now())
--  ORDER BY month_start, currency, "type", category;
--
-- V4. Soft-deleted rows are invisible. Expect 0.
--
-- SELECT count(*) AS should_be_zero
--   FROM public.analytics_monthly_summary('1970-01-01Z'::timestamptz, now()) s
--   JOIN public.transactions t
--     ON t.user_id = auth.uid() AND t.deleted_at IS NOT NULL
--    AND (date_trunc('month', t.created_at AT TIME ZONE 'UTC'))::date = s.month_start
--    AND t.currency = s.currency AND t.type = s."type"
--  WHERE s.tx_count = 1 AND s.total = t.amount;   -- a lone soft-deleted row would surface here
--
-- V5. Owner scoping. Expect the two totals to be equal — the RPC must never
--     return more than the caller's own non-deleted rows.
--
-- SELECT (SELECT COALESCE(sum(tx_count), 0)
--           FROM public.analytics_monthly_summary('1970-01-01Z'::timestamptz, 'infinity'::timestamptz)) AS via_rpc,
--        (SELECT count(*) FROM public.transactions
--          WHERE user_id = auth.uid() AND deleted_at IS NULL)                                            AS via_table;
--
-- V6. Both app modes. A splits_only user's ledger rows (BOTH account ids NULL)
--     must be inside the RPC's counts. Expect ledger_rows_counted = t.
--
-- SELECT (SELECT count(*) FROM public.transactions
--          WHERE user_id = auth.uid() AND deleted_at IS NULL
--            AND source_account_id IS NULL AND destination_account_id IS NULL) = 0
--        OR (SELECT COALESCE(sum(tx_count), 0)
--              FROM public.analytics_monthly_summary('1970-01-01Z'::timestamptz, 'infinity'::timestamptz))
--           = (SELECT count(*) FROM public.transactions
--               WHERE user_id = auth.uid() AND deleted_at IS NULL)
--        AS ledger_rows_counted;
--
-- V7. The plan uses an index, not a sequential scan. Expect "Index Only Scan
--     using idx_transactions_analytics_summary" (or an Index Scan using
--     idx_transactions_user_created if §3's second index was dropped).
--
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT (date_trunc('month', created_at AT TIME ZONE 'UTC'))::date, currency, type,
--        COALESCE(NULLIF(category,''),'Other'), sum(amount), count(*), max(created_at)
--   FROM public.transactions
--  WHERE user_id = auth.uid() AND deleted_at IS NULL
--    AND created_at >= (now() - interval '1 year') AND created_at <= now()
--  GROUP BY 1,2,3,4;
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §7. The client flag
-- ═══════════════════════════════════════════════════════════════════════════
--   VITE_ANALYTICS_RPC   unset / anything but 'true'  → today's behaviour,
--                        byte-for-byte: AnalyticsPage aggregates client-side
--                        and never calls this function.
--                        'true'                        → the summary cards, the
--                        currency chips and the category pie are served by
--                        `analyticsDb.monthlySummary` (src/lib/supabaseDb.ts),
--                        with an automatic fall back to the client aggregation
--                        if the call fails (unapplied migration, offline).
--
-- Rollout: apply this file → verify §6 → ship a web build with the flag on →
-- ship the Android AAB with the same flag (the Play binary lags the web
-- deploy). No step is breaking; rollback at any point is unsetting the flag.
-- Narrative: docs/performance.md §6.5.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §8. Integration test — how the RPC was proven equal to the TypeScript
-- ═══════════════════════════════════════════════════════════════════════════
-- Harness: a `postgres:15` container plus the Supabase-shaped scaffold from
-- docs/audit-2026-09/APPLY-ORDER.md §3 (schemas auth/extensions; auth.users;
-- auth.uid() reading `request.jwt.claim.sub`; roles anon/authenticated), the
-- `transactions` table from supabase-schema.sql, its `deleted_at` column, and
-- then this file.
--
-- Seed: `ANALYTICS_FIXTURE` from src/lib/analytics.test.ts, inserted verbatim —
-- 18 rows covering two currencies, a conversion_rate-bearing row, a ledger-only
-- row with BOTH account ids NULL, an empty category, four non-income/expense
-- types, two calendar months, both window edges, one row outside each edge, and
-- (added by the harness) one soft-deleted row and one row owned by a DIFFERENT
-- user.
--
-- Assertion: `analytics_monthly_summary(FIXTURE_FROM, FIXTURE_TO, 'UTC')` run
-- as role `authenticated` with the fixture user's jwt claim, dumped as JSON and
-- compared element-by-element against
-- `monthlySummaryFromTransactions(ANALYTICS_FIXTURE, FIXTURE_FROM, FIXTURE_TO)`
-- — same row count, same order, same month_start/currency/type/category, and
-- totals equal to within 1e-9 (rule R8).
--
-- Result and what it does NOT prove: see docs/performance.md §6.5.
