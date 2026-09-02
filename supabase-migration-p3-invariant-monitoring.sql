-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P3 item L7: business-invariant monitoring (nightly reconciliation)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- APPLY ORDER: **LAST** — after every other migration in the repo
--   (supabase-schema.sql → the 40 historical files in
--    docs/audit-2026-09/APPLY-ORDER.md §1 order → the 11 audit-p0 files in §2
--    order → the p1-* / p2-* tail).
--   It creates only NEW objects (two tables, one view, `_recon_*` helpers,
--   `run_reconciliation`, `reconciliation_summary`, one optional cron job).
--   It ALTERs nothing, DROPs nothing that predates it, and adds no policy,
--   trigger, constraint or grant to any existing table.
--
-- SAFE AHEAD OF THE CLIENT. No client change is needed and none is possible:
--   both tables have RLS enabled with ZERO policies and no grants to `anon` or
--   `authenticated`, so the app can neither see nor touch any of this. Review
--   happens in Supabase Studio (service_role) or via a service-key poll of
--   `reconciliation_summary()`.
--
-- HARD DEPENDENCY (one): `public.group_member_net_balances(text)` from
--   supabase-migration-audit-p0-group-deletion-guard.sql. If it is absent the
--   group check records a `check_error` finding naming it; every other check
--   still runs. Nothing else here depends on any specific migration beyond the
--   base tables in supabase-schema.sql plus `deleted_at` / `updated_at` from
--   supabase-migration-incremental-sync-{core,tombstones}.sql and
--   `profiles.is_deleted` from supabase-migration-p0-launch-blockers.sql.
--
-- WHY THIS FILE EXISTS
--   docs/audit-2026-09/13-engineering-standards.md §2.3:
--     "No business-invariant monitoring — nothing detects the failure class
--      this repo has actually suffered (balance desync history per
--      project_creditcard_emi_desync memory): no reconciliation job, no
--      'sum of deltas ≠ balance' alarm."
--   docs/audit-2026-09/00-executive-summary.md:162 (item L7, P3):
--     "The failure class this repo has already lived through (credit-card
--      desync) currently has no detector; at scale the first signal must not be
--      angry users."
--   The 2026-07 incident this is aimed at: a credit card whose *Available*
--   credit (27,650) exceeded its own *Limit* (16,500) because the same debt was
--   credited back twice — src/lib/cardCredit.ts:1-10, src/lib/cardStatement.ts
--   :14-19. Nothing in the product noticed. A user did.
--
-- WHAT IT DOES NOT DO
--   It never repairs anything. Every check is read-only over app data and only
--   ever writes to `reconciliation_findings`. Repair is a human decision — see
--   docs/invariant-monitoring.md §7 (runbook).
--
-- ════════════════════════════════════════════════════════════════════════════
-- SIGN-MAPPING TABLE — how a `transactions` row moves `accounts.balance`
-- ----------------------------------------------------------------------------
-- Derived by reading src/stores/transactionStore.ts `processTransaction` (the
-- forward path, lines 925-1571) and cross-checked against `deleteTransaction`
-- (the inverse path, lines 2017-2249), which must undo exactly what the forward
-- path did. Server-side writers (supabase-migration-cross-user-account-effects
-- .sql `accept_linked_request`:312-389 and `accept_settlement_request`:533-575)
-- write transaction rows with the SAME leg convention and were verified against
-- the same table.
--
-- Notation:  A = transactions.amount            S = source_account_id
--            R = transactions.conversion_rate   D = destination_account_id
--            A*R  = round(A * R, 2)   (JS: Math.round(A*R*100)/100)
--            A/R  = round(A / R, 2)   (JS: Math.round(A/R*100)/100)
--            meta = the [[HISAAB_META:…]] header parsed out of `notes`
--                   (src/lib/internalNotes.ts)
--
-- | type                  | leg on S           | leg on D              | src line    |
-- |-----------------------|--------------------|-----------------------|-------------|
-- | income                | —                  | + A                   | :975        |
-- | opening_balance       | — (always null)    | + A                   | :1373       |
-- | expense               | − A                | —                     | :986        |
-- | loan_given            | − A                | — (always null)       | :1128       |
-- | loan_taken            | − A  (the funding  | + A                   | :1167,:1171 |
-- |                       |   credit card on a |                       |             |
-- |                       |   cash advance;    |                       |             |
-- |                       |   null otherwise)  |                       |             |
-- | transfer              | − A                | + (A*R if R else A)   | :1008-:1016 |
-- | repayment             |                    |                       |             |
-- |  · "given" shape      | (none)             | + (A*R if R else A)   | :1211,:1214 |
-- |    S NULL, D set      |                    |                       |             |
-- |  · "taken" shape      | − (A/R if R else A)| + COALESCE(meta.card  | :1243,:1256 |
-- |    S set              |                    |     CreditedAmount,A) | :1246,:1259 |
-- |                       |                    |   (D = the funding    |             |
-- |                       |                    |    card; set only when|             |
-- |                       |                    |    the CLAMPED credit |             |
-- |                       |                    |    was > 0)           |             |
-- |  · ledger-only        | NO LEGS            | NO LEGS               | loanStore   |
-- |    S NULL, D NULL     |                    |                       | .ts:203-218 |
-- | goal_contribution     |                    |                       |             |
-- |  · meta.goalSelf      | NO LEGS            | NO LEGS               | :1302-1309  |
-- |    Stored = '1'       |                    |                       |             |
-- |  · otherwise          | − (A/R if R else A)| + A (the goal's       | :1320,:1326 |
-- |                       |                    |   storedInAccount)    | :1340,:1346 |
-- | adjustment            | − A (when S set)   | + A (when D set)      | :1387-:1389 |
-- |                       |   — exactly one leg; the side carries the         |
-- |                       |   direction, and A is already abs(delta)          |
-- | investment_buy        | − (A/R if R else A)| —                     | :1458,:1462 |
-- | investment_sell       | —                  | + (A*R if R else A)   | :1476,:1479 |
-- | investment_dividend   | —                  | + (A*R if R else A)   | :1530,:1533 |
--
-- The two shapes of `repayment` are discriminated by the ROW, not by the loan:
-- the "given" branch only ever sets D (transactionStore.ts:1205); the "taken"
-- branch always sets S (:1242/:1255). Ledger-mode and "settle — no money moved"
-- write-off rows carry BOTH ids null (loanStore.ts:200-209,
-- tasks/lessons.md:26-27) and are correctly weightless.
--
-- EXCLUDED TYPES — mapped to ZERO legs on purpose
--   NONE of the twelve types in src/db/types.ts:18-30 is excluded; all twelve
--   are mapped above, and no type was guessed at.
--   Because `transactions.type` carries NO CHECK constraint (verified: only
--   transactions_amount_bounded / _conversion_rate_bounded /
--   _currency_supported exist on that table), a type outside the twelve is
--   possible in principle and would silently contribute nothing — hiding a real
--   drift or inventing a fake one. So an unmapped type is itself REPORTED, as
--   kind `unmapped_transaction_type`. Read that finding as "this file's sign map
--   is out of date", not as data corruption.
--
-- ROUNDING NOTE (a real, documented false-positive source)
--   The app rounds in JS floats (`Math.round(n*100)/100`); this file rounds in
--   Postgres `numeric` (exact, half-up). They disagree only on exact-tie cases
--   that float representation pushes below .5 (JS 1.005 → 1.00, PG → 1.01), and
--   only on the cross-currency legs (A*R, A/R). The account-drift tolerance is
--   therefore 0.01 PLUS 0.01 per converted leg on that account. See
--   docs/invariant-monitoring.md §5.
-- ════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. STORAGE — runs and findings
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.reconciliation_runs (
  id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  scope_user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'ok', 'ok_with_findings', 'error')),
  users_checked     INTEGER NOT NULL DEFAULT 0,
  batch_size        INTEGER NOT NULL DEFAULT 0,
  open_findings     INTEGER NOT NULL DEFAULT 0,
  new_findings      INTEGER NOT NULL DEFAULT 0,
  resolved_findings INTEGER NOT NULL DEFAULT 0,
  check_errors      INTEGER NOT NULL DEFAULT 0,
  checks_run        TEXT[] NOT NULL DEFAULT '{}',
  error_text        TEXT
);

COMMENT ON TABLE public.reconciliation_runs IS
  'One row per invocation of public.run_reconciliation(). scope_user_id NULL = every non-deleted profile. Service-role only (RLS on, zero policies).';

CREATE TABLE IF NOT EXISTS public.reconciliation_findings (
  id              BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  -- run_id      = the run that FIRST opened this finding
  -- last_run_id = the most recent run that still saw it
  run_id          BIGINT NOT NULL REFERENCES public.reconciliation_runs(id) ON DELETE CASCADE,
  last_run_id     BIGINT NOT NULL REFERENCES public.reconciliation_runs(id) ON DELETE CASCADE,
  resolved_run_id BIGINT REFERENCES public.reconciliation_runs(id) ON DELETE SET NULL,
  -- NULL only for `check_error` rows, which belong to a run, not to a user.
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warn')),
  entity_id       TEXT,
  expected        NUMERIC,
  actual          NUMERIC,
  delta           NUMERIC,
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count      INTEGER NOT NULL DEFAULT 1,
  resolved_at     TIMESTAMPTZ,
  -- Stable identity across runs: the same drift on the same entity stays ONE
  -- row that ages, instead of a new row every night.
  --   fingerprint = kind || '|' || user_id || '|' || entity_id
  fingerprint     TEXT NOT NULL
);

COMMENT ON TABLE public.reconciliation_findings IS
  'One row per (kind, user, entity) invariant violation. Opened when first seen, refreshed while it persists, stamped resolved_at by the first run that no longer sees it. Service-role only (RLS on, zero policies). Read-only evidence — nothing in this file repairs data.';
COMMENT ON COLUMN public.reconciliation_findings.expected IS
  'What the invariant says the value should be, derived from the records.';
COMMENT ON COLUMN public.reconciliation_findings.actual IS
  'What the stored column actually holds.';
COMMENT ON COLUMN public.reconciliation_findings.delta IS
  'actual - expected, 2dp. The sign is meaningful — see docs/invariant-monitoring.md §3.';

CREATE INDEX IF NOT EXISTS idx_recon_findings_open
  ON public.reconciliation_findings (kind, detected_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recon_findings_user
  ON public.reconciliation_findings (user_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_findings_run
  ON public.reconciliation_findings (last_run_id);
-- One OPEN row per fingerprint. Resolved history is unconstrained, so a drift
-- that comes back opens a NEW row and the old resolution stays auditable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_findings_open_fingerprint
  ON public.reconciliation_findings (fingerprint)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recon_runs_started
  ON public.reconciliation_runs (started_at DESC);

-- ── Lockout: RLS on, ZERO policies, no grants to app roles ──────────────────
-- With RLS enabled and no policy at all, every role except a BYPASSRLS role
-- (service_role) and the table owner sees zero rows and can write nothing. The
-- REVOKEs make that explicit rather than incidental (Supabase's default
-- privileges grant table access to anon/authenticated).
ALTER TABLE public.reconciliation_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_findings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.reconciliation_runs     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.reconciliation_findings FROM PUBLIC, anon, authenticated;
GRANT  ALL ON TABLE public.reconciliation_runs     TO service_role;
GRANT  ALL ON TABLE public.reconciliation_findings TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. HELPERS
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 2.1 Tolerant numeric parse ──────────────────────────────────────────────
-- The app reads these strings with parseFloat, which returns NaN rather than
-- throwing. A hard cast here would abort a whole check over one malformed
-- metadata value, so garbage degrades to NULL instead.
CREATE OR REPLACE FUNCTION public._recon_numeric(p_in TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_in IS NULL OR btrim(p_in) = '' THEN RETURN NULL; END IF;
  RETURN btrim(p_in)::NUMERIC;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;

-- ── 2.2 Internal-note meta ──────────────────────────────────────────────────
-- src/lib/internalNotes.ts stores `[[HISAAB_META:<encodeURIComponent(JSON)>]]`
-- in front of the visible note. Two sign-map rules read it
-- (`cardCreditedAmount`, `goalSelfStored`) and the loan check reads a third
-- (`writeOff`), so reconciliation must parse it the same way. Anything
-- malformed degrades to '{}' — one bad note must never take out a whole check.

CREATE OR REPLACE FUNCTION public._recon_urldecode(p_in TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_parts TEXT[];
  v_hex   TEXT;
  i       INT;
BEGIN
  IF p_in IS NULL THEN RETURN NULL; END IF;
  -- Everything before the first '%' is literal; every later chunk begins with a
  -- two-hex-digit escape produced by encodeURIComponent.
  v_parts := string_to_array(p_in, '%');
  v_hex := encode(convert_to(v_parts[1], 'utf8'), 'hex');
  FOR i IN 2 .. COALESCE(array_length(v_parts, 1), 1) LOOP
    IF v_parts[i] ~ '^[0-9A-Fa-f]{2}' THEN
      v_hex := v_hex || lower(substr(v_parts[i], 1, 2))
                     || encode(convert_to(substr(v_parts[i], 3), 'utf8'), 'hex');
    ELSE
      v_hex := v_hex || '25' || encode(convert_to(v_parts[i], 'utf8'), 'hex'); -- literal '%'
    END IF;
  END LOOP;
  RETURN convert_from(decode(v_hex, 'hex'), 'utf8');
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public._recon_note_meta(p_notes TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_end  INT;
  v_json TEXT;
BEGIN
  IF p_notes IS NULL OR left(p_notes, 14) <> '[[HISAAB_META:' THEN
    RETURN '{}'::jsonb;
  END IF;
  v_end := position(']]' IN p_notes);           -- 1-indexed start of the suffix
  IF v_end <= 15 THEN RETURN '{}'::jsonb; END IF;
  v_json := public._recon_urldecode(substr(p_notes, 15, v_end - 15));
  IF v_json IS NULL THEN RETURN '{}'::jsonb; END IF;
  RETURN v_json::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN '{}'::jsonb;
END $$;

-- ── 2.3 pg_cron job status (dynamic — `cron.job` may not exist) ─────────────
-- A plain SELECT that names cron.job fails to PARSE when pg_cron is absent,
-- even inside a CASE branch that would never execute, so the verification
-- query in Section 7 reads the job through this instead.
CREATE OR REPLACE FUNCTION public._recon_cron_status()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v_sched TEXT;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN 'pg_cron absent — schedule from the dashboard (docs/invariant-monitoring.md §6)';
  END IF;
  EXECUTE 'SELECT schedule FROM cron.job WHERE jobname = $1'
    INTO v_sched USING 'hisaab-nightly-reconciliation';
  IF v_sched IS NULL THEN
    RETURN '!! pg_cron present but the job is missing';
  END IF;
  RETURN 'ok — ' || v_sched;
END $$;

-- ── 2.4 The canonical mapped-type list ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public._recon_mapped_types()
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE
AS $$ SELECT ARRAY[
  'income','expense','loan_given','loan_taken','repayment','transfer',
  'goal_contribution','opening_balance','adjustment',
  'investment_buy','investment_sell','investment_dividend'
]::TEXT[]; $$;

-- ── 2.5 Transaction → account legs ──────────────────────────────────────────
-- The sign-mapping table above, expressed exactly once. Every branch is a
-- UNION ALL arm so the code reads top-to-bottom against that comment block.
CREATE OR REPLACE FUNCTION public._recon_transaction_legs(p_user_ids UUID[])
RETURNS TABLE (
  txn_id     TEXT,
  user_id    UUID,
  txn_type   TEXT,
  account_id TEXT,
  delta      NUMERIC,
  converted  BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH t AS (
    SELECT
      x.id, x.user_id, x.type, x.amount,
      x.source_account_id AS s, x.destination_account_id AS d,
      (x.conversion_rate IS NOT NULL) AS converted,
      CASE WHEN x.conversion_rate IS NOT NULL
           THEN round(x.amount * x.conversion_rate, 2) ELSE x.amount END AS dest_amt,
      CASE WHEN x.conversion_rate IS NOT NULL AND x.conversion_rate <> 0
           THEN round(x.amount / x.conversion_rate, 2) ELSE x.amount END AS src_amt,
      public._recon_note_meta(x.notes) AS meta
    FROM public.transactions x
    WHERE x.user_id = ANY (p_user_ids)
      AND x.deleted_at IS NULL          -- tombstoned rows were already reversed
  )
  SELECT t.id, t.user_id, t.type, leg.acct, leg.dlt, t.converted
  FROM t
  CROSS JOIN LATERAL (
        -- income / opening_balance: money arrives
        SELECT t.d AS acct, t.amount AS dlt
         WHERE t.type IN ('income', 'opening_balance') AND t.d IS NOT NULL
    UNION ALL
        -- expense / loan_given: money leaves
        SELECT t.s, -t.amount
         WHERE t.type IN ('expense', 'loan_given') AND t.s IS NOT NULL
    UNION ALL
        -- transfer: debit source, credit destination (converted if cross-ccy)
        SELECT t.s, -t.amount   WHERE t.type = 'transfer' AND t.s IS NOT NULL
    UNION ALL
        SELECT t.d, t.dest_amt  WHERE t.type = 'transfer' AND t.d IS NOT NULL
    UNION ALL
        -- loan_taken: the receiving account is credited; a cash advance also
        -- debits the funding credit card (S).
        SELECT t.d, t.amount    WHERE t.type = 'loan_taken' AND t.d IS NOT NULL
    UNION ALL
        SELECT t.s, -t.amount   WHERE t.type = 'loan_taken' AND t.s IS NOT NULL
    UNION ALL
        -- repayment, "given" shape (destination only): money comes back in
        SELECT t.d, t.dest_amt
         WHERE t.type = 'repayment' AND t.s IS NULL AND t.d IS NOT NULL
    UNION ALL
        -- repayment, "taken" shape: money leaves the paying account …
        SELECT t.s, -t.src_amt
         WHERE t.type = 'repayment' AND t.s IS NOT NULL
    UNION ALL
        -- … and, on a cash advance, credits the funding card by the CLAMPED
        -- amount (src/lib/cardCredit.ts), stamped into the note when it bit.
        SELECT t.d, COALESCE(public._recon_numeric(t.meta->>'cardCreditedAmount'), t.amount)
         WHERE t.type = 'repayment' AND t.s IS NOT NULL AND t.d IS NOT NULL
    UNION ALL
        -- goal_contribution: self-stored contributions move NO balance.
        SELECT t.s, -t.src_amt
         WHERE t.type = 'goal_contribution' AND t.s IS NOT NULL
           AND COALESCE(t.meta->>'goalSelfStored', '') <> '1'
    UNION ALL
        SELECT t.d, t.amount
         WHERE t.type = 'goal_contribution' AND t.d IS NOT NULL
           AND COALESCE(t.meta->>'goalSelfStored', '') <> '1'
    UNION ALL
        -- adjustment: exactly one leg; the side carries the direction.
        SELECT t.d, t.amount    WHERE t.type = 'adjustment' AND t.d IS NOT NULL
    UNION ALL
        SELECT t.s, -t.amount   WHERE t.type = 'adjustment' AND t.s IS NOT NULL
    UNION ALL
        -- investments
        SELECT t.s, -t.src_amt  WHERE t.type = 'investment_buy' AND t.s IS NOT NULL
    UNION ALL
        SELECT t.d, t.dest_amt
         WHERE t.type IN ('investment_sell', 'investment_dividend') AND t.d IS NOT NULL
  ) AS leg(acct, dlt)
  WHERE leg.acct IS NOT NULL AND leg.dlt IS NOT NULL;
$$;

COMMENT ON FUNCTION public._recon_transaction_legs(UUID[]) IS
  'Expands each live transaction row into its signed account legs, per the sign-mapping table in the header of supabase-migration-p3-invariant-monitoring.sql (derived from transactionStore.processTransaction, verified against deleteTransaction).';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. THE CHECKS
--
-- Every check is its own function with the SAME signature, so the orchestrator
-- can call each inside its own subtransaction: a check that raises is recorded
-- as a `check_error` finding and the remaining checks still run.
--
--   _recon_check_<name>(p_user_ids UUID[])
--     RETURNS TABLE(kind, severity, user_id, entity_id,
--                   expected, actual, delta, details)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 3.1 (a) Account balance drift ───────────────────────────────────────────
-- INVARIANT: accounts.balance = Σ(signed transaction legs on that account).
--   There is no separate "opening balance" column and none is needed:
--   accountStore.createAccount (accountStore.ts:66-117) sets
--   balance = input.balance AND writes one `opening_balance` transaction for
--   the same amount, so summing from ZERO reproduces the account exactly.
--   Balance is never written absolutely after that — every change goes through
--   apply_account_balance_delta (accountStore.ts:124-165), which is what makes
--   this sum meaningful at all.
-- TOLERANCE: 0.01, plus 0.01 per cross-currency leg on the account (the
--   JS-float vs numeric rounding divergence documented in the header).
-- SCOPE: live accounts only (deleted_at IS NULL) — a retired account's balance
--   is deliberately no longer maintained (transactionStore.ts:2019-2021), and
--   an account must be at zero before it can be retired (accountStore.ts:201).
CREATE OR REPLACE FUNCTION public._recon_check_accounts(p_user_ids UUID[])
RETURNS TABLE (
  kind TEXT, severity TEXT, user_id UUID, entity_id TEXT,
  expected NUMERIC, actual NUMERIC, delta NUMERIC, details JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH legs AS (
    SELECT * FROM public._recon_transaction_legs(p_user_ids)
  ),
  per_type AS (
    SELECT l.user_id, l.account_id, l.txn_type, round(SUM(l.delta), 2) AS sum_delta
    FROM legs l
    GROUP BY l.user_id, l.account_id, l.txn_type
  ),
  agg AS (
    SELECT p.user_id, p.account_id,
           round(SUM(p.sum_delta), 2)                  AS expected,
           jsonb_object_agg(p.txn_type, p.sum_delta)   AS by_type
    FROM per_type p
    GROUP BY p.user_id, p.account_id
  ),
  cnt AS (
    SELECT l.user_id, l.account_id,
           COUNT(*)                            AS leg_count,
           COUNT(*) FILTER (WHERE l.converted) AS converted_legs
    FROM legs l
    GROUP BY l.user_id, l.account_id
  )
  SELECT
    'account_balance_drift',
    'error',
    a.user_id,
    a.id,
    COALESCE(g.expected, 0),
    round(a.balance, 2),
    round(a.balance - COALESCE(g.expected, 0), 2),
    jsonb_build_object(
      'account_name',        a.name,
      'account_type',        a.type,
      'currency',            a.currency,
      'leg_count',           COALESCE(c.leg_count, 0),
      'converted_leg_count', COALESCE(c.converted_legs, 0),
      'base_tolerance',      0.01,
      'tolerance_used',      0.01 + 0.01 * COALESCE(c.converted_legs, 0),
      'by_type',             COALESCE(g.by_type, '{}'::jsonb)
    )
  FROM public.accounts a
  LEFT JOIN agg g ON g.account_id = a.id AND g.user_id = a.user_id
  LEFT JOIN cnt c ON c.account_id = a.id AND c.user_id = a.user_id
  WHERE a.user_id = ANY (p_user_ids)
    AND a.deleted_at IS NULL
    AND abs(round(a.balance - COALESCE(g.expected, 0), 2))
        > 0.01 + 0.01 * COALESCE(c.converted_legs, 0);
$$;

-- ── 3.1b Unmapped transaction types ─────────────────────────────────────────
-- Guards the check above. A type this file does not know about contributes
-- nothing to `expected`, which could hide a real drift or invent a fake one.
-- Reported so the sign map gets updated — not so data gets repaired.
CREATE OR REPLACE FUNCTION public._recon_check_txn_types(p_user_ids UUID[])
RETURNS TABLE (
  kind TEXT, severity TEXT, user_id UUID, entity_id TEXT,
  expected NUMERIC, actual NUMERIC, delta NUMERIC, details JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    'unmapped_transaction_type',
    'error',
    NULL::UUID,
    x.type,
    NULL::NUMERIC,
    COUNT(*)::NUMERIC,
    NULL::NUMERIC,
    jsonb_build_object(
      'message',      'transactions.type is not in the sign-mapping table — the account-drift check cannot weigh these rows',
      'sample_ids',   (array_agg(x.id ORDER BY x.created_at DESC))[1:5],
      'mapped_types', to_jsonb(public._recon_mapped_types())
    )
  FROM public.transactions x
  WHERE x.user_id = ANY (p_user_ids)
    AND x.deleted_at IS NULL
    AND NOT (x.type = ANY (public._recon_mapped_types()))
  GROUP BY x.type;
$$;

-- ── 3.2 (b) Loan remaining drift ────────────────────────────────────────────
-- INVARIANT: loans.remaining_amount = GREATEST(0, total_amount − Σ repayments).
--   The GREATEST(0, …) is not a fudge — it IS the app's semantics.
--   apply_loan_remaining_delta clamps at zero
--   (supabase-migration-audit-p0-loan-concurrency.sql) and
--   transactionStore.trackedApplyRepayment deliberately does NOT pre-clamp the
--   requested amount ("the RPC's own GREATEST(0, …) reproduces the old
--   Math.max(0, …) exactly, so an overpayment still settles the loan"), so an
--   overpayment settles the loan while the transaction row keeps the full
--   figure the user typed. Without the clamp every overpayment would be a
--   false positive.
-- WRITE-OFF / SETTLE-WITHOUT-PAYMENT: needs no special case. "Settle — no money
--   moved" goes through loanStore.applyRepayment (LoanDetailPage.tsx:194-196),
--   which writes a real repayment row for the full remaining amount, tagged
--   meta.writeOff='1', with BOTH account ids null. It counts here exactly like
--   cash, which is right for THIS invariant (it is money the loan no longer
--   owes). The count of such rows is surfaced in `details` so a reviewer is
--   never surprised by a loan that closed without a payment.
-- TOLERANCE: 0.01.
-- ALSO CARRIED (not asserted): `status_consistent` — status='settled' should
--   coincide with remaining=0. Reported inside details rather than as its own
--   finding, because the app derives status from remaining in one place and a
--   mismatch is a symptom of the drift, not an independent fault.
CREATE OR REPLACE FUNCTION public._recon_check_loans(p_user_ids UUID[])
RETURNS TABLE (
  kind TEXT, severity TEXT, user_id UUID, entity_id TEXT,
  expected NUMERIC, actual NUMERIC, delta NUMERIC, details JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH rep AS (
    SELECT
      x.related_loan_id       AS loan_id,
      round(SUM(x.amount), 2) AS paid,
      COUNT(*)                AS n,
      COUNT(*) FILTER (
        WHERE COALESCE(public._recon_note_meta(x.notes)->>'writeOff', '') <> ''
      )                       AS write_offs,
      COUNT(*) FILTER (
        WHERE x.source_account_id IS NULL AND x.destination_account_id IS NULL
      )                       AS ledger_rows
    FROM public.transactions x
    WHERE x.user_id = ANY (p_user_ids)
      AND x.deleted_at IS NULL
      AND x.type = 'repayment'
      AND x.related_loan_id IS NOT NULL
    GROUP BY x.related_loan_id
  )
  SELECT
    'loan_remaining_drift',
    'error',
    l.user_id,
    l.id,
    GREATEST(0, round(l.total_amount - COALESCE(r.paid, 0), 2)),
    round(l.remaining_amount, 2),
    round(l.remaining_amount - GREATEST(0, round(l.total_amount - COALESCE(r.paid, 0), 2)), 2),
    jsonb_build_object(
      'person_name',       l.person_name,
      'loan_type',         l.type,
      'loan_status',       l.status,
      'currency',          l.currency,
      'total_amount',      round(l.total_amount, 2),
      'repayments_sum',    COALESCE(r.paid, 0),
      'repayment_count',   COALESCE(r.n, 0),
      'write_off_rows',    COALESCE(r.write_offs, 0),
      'ledger_only_rows',  COALESCE(r.ledger_rows, 0),
      'overpaid',          COALESCE(r.paid, 0) > l.total_amount + 0.01,
      'status_consistent', (l.status = 'settled') = (round(l.remaining_amount, 2) <= 0.005),
      'tolerance_used',    0.01
    )
  FROM public.loans l
  LEFT JOIN rep r ON r.loan_id = l.id
  WHERE l.user_id = ANY (p_user_ids)
    AND l.deleted_at IS NULL
    AND abs(round(l.remaining_amount
                  - GREATEST(0, round(l.total_amount - COALESCE(r.paid, 0), 2)), 2)) > 0.01;
$$;

-- ── 3.3 (c) EMI schedule coverage ───────────────────────────────────────────
-- Two invariants, two kinds, both only for loans that actually HAVE a schedule.
--
--  emi_schedule_total_mismatch
--    Σ(schedule amounts) = loans.total_amount.
--    emiStore.generateSchedule gives the LAST instalment the remainder
--    (`total − emiAmount*(n−1)`), so the sum is exact and 0.01 covers numeric
--    noise only — it is NOT absorbing a per-instalment rounding drift. Loan
--    edits regenerate the schedule over the new amount
--    (transactionStore.ts:1792-1801) and are refused once repayments exist
--    (:1758-1763), so a mismatch means a schedule and a loan really diverged.
--
--  emi_paid_overrun
--    Σ(amount of instalments marked 'paid') ≤ (total_amount − remaining_amount).
--    src/lib/emiCoverage.ts `uncoveredToPaidIds` only ever marks a PREFIX whose
--    cumulative amount is covered by money actually repaid (COVERAGE_EPSILON =
--    0.00001), so paid instalments can never outrun the money. When they do, a
--    schedule is claiming an instalment is settled that no payment covers — the
--    EMI half of the 2026-07 desync.
--    The reverse direction (a LAGGING schedule) is deliberately NOT reported:
--    it is cosmetic, harms no balance, and self-heals on the next repayment via
--    trackedMarkCoveredEmisPaid / trackedSyncEmisToLoan.
--    Counts (`paid_instalments` vs `repayment_count`) are carried in details
--    rather than asserted: one repayment legitimately covers many instalments
--    and one instalment can be covered by many repayments, so only the AMOUNT
--    comparison is an invariant.
-- TOLERANCE: 0.01 for both.
CREATE OR REPLACE FUNCTION public._recon_check_emi(p_user_ids UUID[])
RETURNS TABLE (
  kind TEXT, severity TEXT, user_id UUID, entity_id TEXT,
  expected NUMERIC, actual NUMERIC, delta NUMERIC, details JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sched AS (
    SELECT
      e.loan_id,
      round(SUM(e.amount), 2)                                           AS sched_total,
      round(COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'paid'), 0), 2) AS paid_total,
      COUNT(*)                                                          AS n,
      COUNT(*) FILTER (WHERE e.status = 'paid')                         AS n_paid
    FROM public.emi_schedules e
    WHERE e.user_id = ANY (p_user_ids)
    GROUP BY e.loan_id
  ),
  rep AS (
    SELECT x.related_loan_id AS loan_id, COUNT(*) AS n
    FROM public.transactions x
    WHERE x.user_id = ANY (p_user_ids)
      AND x.deleted_at IS NULL
      AND x.type = 'repayment'
      AND x.related_loan_id IS NOT NULL
    GROUP BY x.related_loan_id
  ),
  base AS (
    SELECT l.id, l.user_id, l.person_name, l.currency,
           l.total_amount, l.remaining_amount,
           s.sched_total, s.paid_total, s.n, s.n_paid, COALESCE(r.n, 0) AS rep_n
    FROM public.loans l
    JOIN sched s ON s.loan_id = l.id
    LEFT JOIN rep r ON r.loan_id = l.id
    WHERE l.user_id = ANY (p_user_ids)
      AND l.deleted_at IS NULL
  )
  SELECT
    'emi_schedule_total_mismatch', 'error', b.user_id, b.id,
    round(b.total_amount, 2), b.sched_total,
    round(b.sched_total - b.total_amount, 2),
    jsonb_build_object(
      'person_name', b.person_name, 'currency', b.currency,
      'instalments', b.n, 'paid_instalments', b.n_paid,
      'repayment_count', b.rep_n,
      'message', 'the instalment plan no longer adds up to the loan it belongs to',
      'tolerance_used', 0.01)
  FROM base b
  WHERE abs(round(b.sched_total - b.total_amount, 2)) > 0.01

  UNION ALL

  SELECT
    'emi_paid_overrun', 'error', b.user_id, b.id,
    round(b.total_amount - b.remaining_amount, 2), b.paid_total,
    round(b.paid_total - (b.total_amount - b.remaining_amount), 2),
    jsonb_build_object(
      'person_name', b.person_name, 'currency', b.currency,
      'money_repaid', round(b.total_amount - b.remaining_amount, 2),
      'instalments', b.n, 'paid_instalments', b.n_paid,
      'repayment_count', b.rep_n,
      'message', 'instalments marked paid exceed the money actually repaid on this loan',
      'tolerance_used', 0.01)
  FROM base b
  WHERE b.paid_total - (b.total_amount - b.remaining_amount) > 0.01;
$$;

-- ── 3.4 (d) Credit-card invariant ───────────────────────────────────────────
-- The model (src/lib/cardStatement.ts:14-19):
--     used (= creditLimit − balance) = revolving purchases + Σ(cash-advance remaining)
-- `revolving` is DEFINED as `used − Σ(remaining)` (cardStatement.ts:161), so the
-- equation as written is a tautology and cannot be tested directly. Its two
-- testable corollaries are exactly what the 2026-07 incident violated:
--
--  card_available_over_limit — balance > creditLimit.
--    A card's balance IS its available credit; it can never exceed the limit
--    (src/lib/cardCredit.ts:1-10). This is literally the reported bug shape
--    ("Available 27,650 over Limit 16,500") — the same debt credited twice.
--
--  card_advance_exceeds_used — Σ(active cash-advance remaining) > used.
--    Financed principal the loans still track but the card no longer says is
--    owed, i.e. `revolving` has gone negative. The desync in the other
--    direction: a payment reduced the card but not the loans, or a loan was
--    restored without the card.
--
-- Cash advances for a card are found the way the app finds them
-- (transactionStore.findActiveCashAdvanceLoansForCard:724-739): live
-- `loan_taken` rows whose source_account_id is the card, joined to loans of
-- type 'taken', status 'active', remaining > 0.005, currency = the card's
-- (the same currency filter as transactionStore.ts:1041).
-- TOLERANCE: 0.01 on both, one-sided (only the violating direction fires).
CREATE OR REPLACE FUNCTION public._recon_check_cards(p_user_ids UUID[])
RETURNS TABLE (
  kind TEXT, severity TEXT, user_id UUID, entity_id TEXT,
  expected NUMERIC, actual NUMERIC, delta NUMERIC, details JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH carded AS (
    SELECT
      a.id, a.user_id, a.name, a.currency,
      round(a.balance, 2)                                     AS balance,
      public._recon_numeric(a.metadata->>'creditLimit')       AS lim
    FROM public.accounts a
    WHERE a.user_id = ANY (p_user_ids)
      AND a.deleted_at IS NULL
      AND a.type = 'credit_card'
  ),
  c AS (
    SELECT k.*, round(k.lim - k.balance, 2) AS used
    FROM carded k
    WHERE k.lim IS NOT NULL AND k.lim > 0
  ),
  adv AS (
    SELECT
      c.id                                             AS card_id,
      round(COALESCE(SUM(l.remaining_amount), 0), 2)   AS sum_remaining,
      COUNT(l.id)                                      AS advance_count
    FROM c
    LEFT JOIN LATERAL (
      SELECT DISTINCT l2.id, l2.remaining_amount
      FROM public.transactions x
      JOIN public.loans l2
        ON l2.id           = x.related_loan_id
       AND l2.user_id      = c.user_id
       AND l2.deleted_at   IS NULL
       AND l2.type         = 'taken'
       AND l2.status       = 'active'
       AND l2.remaining_amount > 0.005
       AND l2.currency     = c.currency
      WHERE x.user_id           = c.user_id
        AND x.deleted_at        IS NULL
        AND x.type              = 'loan_taken'
        AND x.source_account_id = c.id
        AND x.related_loan_id   IS NOT NULL
    ) l ON TRUE
    GROUP BY c.id
  )
  SELECT
    'card_available_over_limit', 'error', c.user_id, c.id,
    c.lim, c.balance, round(c.balance - c.lim, 2),
    jsonb_build_object(
      'account_name', c.name, 'currency', c.currency,
      'credit_limit', c.lim, 'balance_available_credit', c.balance,
      'message', 'available credit exceeds the card''s own limit — the 2026-07 double-credit shape',
      'tolerance_used', 0.01)
  FROM c
  WHERE c.balance - c.lim > 0.01

  UNION ALL

  SELECT
    'card_advance_exceeds_used', 'error', c.user_id, c.id,
    v.sum_remaining, c.used, round(c.used - v.sum_remaining, 2),
    jsonb_build_object(
      'account_name', c.name, 'currency', c.currency,
      'credit_limit', c.lim, 'balance_available_credit', c.balance,
      'used', c.used, 'sum_advance_remaining', v.sum_remaining,
      'advance_count', v.advance_count,
      'revolving_purchases', round(c.used - v.sum_remaining, 2),
      'message', 'cash-advance principal still tracked on loans exceeds what the card says is owed (revolving < 0)',
      'tolerance_used', 0.01)
  FROM c
  JOIN adv v ON v.card_id = c.id
  WHERE v.sum_remaining - c.used > 0.01;
$$;

-- ── 3.5 (e) Group ledger balance ────────────────────────────────────────────
-- INVARIANT: within a group, Σ(net balance over ALL members) = 0. Money between
-- members can only be redistributed; it can never be created.
-- A non-zero total means one of:
--   · an expense whose splits do not sum to its amount;
--   · an expense whose paid_by names a member row that does not exist;
--   · a split whose memberId names a member row that does not exist;
--   · a settlement whose from_member / to_member names a non-member.
-- All four are decomposed into `details` so triage does not start from scratch.
--
-- The net figure comes from the SERVER recompute, not a reimplementation:
-- public.group_member_net_balances (supabase-migration-audit-p0-group-deletion-
-- guard.sql:401-449), documented there as using "the same arithmetic, sign
-- convention, rounding and deleted_at filter as leave_group"
-- (supabase-migration-safe-leave-group.sql:110-138). If that function is absent
-- this check RAISES, and the orchestrator records a `check_error` — deliberately
-- preferred over a private copy that could silently drift from the authority.
-- NOTE: it returns EVERY member row regardless of status, including members who
--   have left; that is required here, since a departed member's residual
--   position must still be counted for the group to net to zero.
-- SCOPE: one row per group, attributed to the group OWNER (split_groups.user_id)
--   so a shared group is examined exactly once regardless of batch membership.
-- TOLERANCE: 0.01 (the same 0.01 leave_group itself uses at
--   supabase-migration-safe-leave-group.sql:142).
CREATE OR REPLACE FUNCTION public._recon_check_groups(p_user_ids UUID[])
RETURNS TABLE (
  kind TEXT, severity TEXT, user_id UUID, entity_id TEXT,
  expected NUMERIC, actual NUMERIC, delta NUMERIC, details JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regprocedure('public.group_member_net_balances(text)') IS NULL THEN
    RAISE EXCEPTION
      'group_member_net_balances(text) is missing — apply supabase-migration-audit-p0-group-deletion-guard.sql before relying on the group ledger check';
  END IF;

  RETURN QUERY
  WITH nets AS (
    SELECT g.id AS group_id, g.user_id AS owner_id, g.name AS group_name,
           round(COALESCE(SUM(b.net), 0), 2) AS total_net,
           COUNT(b.member_id)                AS member_count
    FROM public.split_groups g
    LEFT JOIN LATERAL public.group_member_net_balances(g.id) b ON TRUE
    WHERE g.user_id = ANY (p_user_ids)
    GROUP BY g.id, g.user_id, g.name
  ),
  diag AS (
    SELECT
      g.id AS group_id,
      -- expenses whose splits do not sum to the expense amount
      COALESCE((
        SELECT round(SUM(e.amount - COALESCE((
                 SELECT SUM(COALESCE(public._recon_numeric(s.value->>'amount'), 0))
                 FROM jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) s), 0)), 2)
        FROM public.group_expenses e
        WHERE e.group_id = g.id AND e.deleted_at IS NULL
      ), 0) AS split_sum_gap,
      -- expense amounts attributed to a payer with no member row
      COALESCE((
        SELECT round(SUM(e.amount), 2)
        FROM public.group_expenses e
        WHERE e.group_id = g.id AND e.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.group_members m
                           WHERE m.group_id = g.id AND m.id = e.paid_by)
      ), 0) AS orphan_payer_total,
      -- split amounts owed by a member row that does not exist
      COALESCE((
        SELECT round(SUM(COALESCE(public._recon_numeric(s.value->>'amount'), 0)), 2)
        FROM public.group_expenses e
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) s
        WHERE e.group_id = g.id AND e.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.group_members m
                           WHERE m.group_id = g.id
                             AND m.id = COALESCE(s.value->>'memberId', s.value->>'member_id'))
      ), 0) AS orphan_split_total,
      -- settlements naming a non-member on either side
      COALESCE((
        SELECT COUNT(*)
        FROM public.group_settlements st
        WHERE st.group_id = g.id AND st.deleted_at IS NULL
          AND (NOT EXISTS (SELECT 1 FROM public.group_members m
                            WHERE m.group_id = g.id AND m.id = st.from_member)
            OR NOT EXISTS (SELECT 1 FROM public.group_members m
                            WHERE m.group_id = g.id AND m.id = st.to_member))
      ), 0) AS orphan_settlements
    FROM public.split_groups g
    WHERE g.user_id = ANY (p_user_ids)
  )
  SELECT
    'group_ledger_imbalance', 'error', n.owner_id, n.group_id,
    0::NUMERIC, n.total_net, n.total_net,
    jsonb_build_object(
      'group_name',         n.group_name,
      'member_count',       n.member_count,
      'split_sum_gap',      d.split_sum_gap,
      'orphan_payer_total', d.orphan_payer_total,
      'orphan_split_total', d.orphan_split_total,
      'orphan_settlements', d.orphan_settlements,
      'source',             'public.group_member_net_balances',
      'tolerance_used',     0.01)
  FROM nets n
  JOIN diag d ON d.group_id = n.group_id
  WHERE abs(n.total_net) > 0.01;
END $$;

-- ── 3.6 (f) Linked (cross-user) loan pairs ──────────────────────────────────
-- INVARIANT: an accepted linked_transaction_request mirrors ONE debt onto TWO
-- users' books. The two loans must always agree on what is still outstanding.
-- accept_settlement_request (supabase-migration-cross-user-account-effects.sql
-- :577+, row-locked by supabase-migration-audit-p0-settlement-row-locks.sql)
-- reduces both sides in one transaction, and the client refuses to delete a
-- repayment on an ACTIVE linked loan (transactionStore.ts:2127-2131) — so a
-- divergence means one of those guards was bypassed or an edit landed on one
-- side only.
-- Two kinds:
--   linked_pair_divergence   — both loans exist, remaining amounts differ.
--   linked_pair_missing_loan — one side's loan row is gone. The
--     requester_loan_id / responder_loan_id columns carry NO foreign key, so a
--     hard delete or a tombstone on one side leaves a dangling pointer and a
--     one-sided debt that nothing else in the schema would notice.
-- SCOPE: attributed to the REQUESTER (from_user_id) so each pair is examined
--   exactly once. `expected` = the requester side, `actual` = the responder side.
-- TOLERANCE: 0.01.
CREATE OR REPLACE FUNCTION public._recon_check_linked_pairs(p_user_ids UUID[])
RETURNS TABLE (
  kind TEXT, severity TEXT, user_id UUID, entity_id TEXT,
  expected NUMERIC, actual NUMERIC, delta NUMERIC, details JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pairs AS (
    SELECT r.id, r.from_user_id, r.to_user_id, r.amount, r.currency,
           r.requester_loan_id, r.responder_loan_id, r.responded_at,
           rl.remaining_amount AS req_remaining, rl.status AS req_status,
           rl.total_amount     AS req_total,
           pl.remaining_amount AS res_remaining, pl.status AS res_status,
           pl.total_amount     AS res_total
    FROM public.linked_transaction_requests r
    LEFT JOIN public.loans rl ON rl.id = r.requester_loan_id AND rl.deleted_at IS NULL
    LEFT JOIN public.loans pl ON pl.id = r.responder_loan_id AND pl.deleted_at IS NULL
    WHERE r.from_user_id = ANY (p_user_ids)
      AND r.status = 'accepted'
      AND r.requester_loan_id IS NOT NULL
      AND r.responder_loan_id IS NOT NULL
  )
  SELECT
    'linked_pair_divergence', 'error', p.from_user_id, p.id,
    round(p.req_remaining, 2), round(p.res_remaining, 2),
    round(p.res_remaining - p.req_remaining, 2),
    jsonb_build_object(
      'requester_loan_id', p.requester_loan_id, 'responder_loan_id', p.responder_loan_id,
      'requester_user_id', p.from_user_id,      'responder_user_id', p.to_user_id,
      'requester_status',  p.req_status,        'responder_status',  p.res_status,
      'requester_total',   round(p.req_total, 2),
      'responder_total',   round(p.res_total, 2),
      'currency', p.currency, 'accepted_at', p.responded_at, 'tolerance_used', 0.01)
  FROM pairs p
  WHERE p.req_remaining IS NOT NULL
    AND p.res_remaining IS NOT NULL
    AND abs(round(p.res_remaining - p.req_remaining, 2)) > 0.01

  UNION ALL

  SELECT
    'linked_pair_missing_loan', 'error', p.from_user_id, p.id,
    round(p.amount, 2),
    round(COALESCE(p.req_remaining, p.res_remaining), 2),
    NULL::NUMERIC,
    jsonb_build_object(
      'requester_loan_id', p.requester_loan_id, 'responder_loan_id', p.responder_loan_id,
      'requester_loan_present', p.req_remaining IS NOT NULL,
      'responder_loan_present', p.res_remaining IS NOT NULL,
      'requester_user_id', p.from_user_id, 'responder_user_id', p.to_user_id,
      'currency', p.currency, 'accepted_at', p.responded_at,
      'message', 'one side of an accepted linked loan no longer exists — the debt is now one-sided')
  FROM pairs p
  WHERE p.req_remaining IS NULL OR p.res_remaining IS NULL;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. THE ORCHESTRATOR
--
-- run_reconciliation(NULL)   → every non-deleted profile, in batches.
-- run_reconciliation('<uid>')→ one user (support / triage workflow).
--
-- Isolation: each (batch × check) runs inside its own subtransaction. A check
-- that raises loses only THAT batch's rows for THAT check and is recorded as a
-- `check_error` finding; every other check and every other batch still runs.
--
-- Failure outside the checks (staging, merge, the profile scan) is caught too:
-- the run row is written BEFORE the guarded block, so it survives the rollback
-- and lands with status='error' and error_text set. The function then returns
-- normally instead of re-raising — deliberately, because re-raising would roll
-- back the very evidence an operator needs. reconciliation_summary() surfaces
-- run_status='error', which is what the alert fires on.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.run_reconciliation(
  p_user_id    UUID DEFAULT NULL,
  p_batch_size INT  DEFAULT 200
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id   BIGINT;
  v_checks   TEXT[] := ARRAY[
                '_recon_check_accounts',
                '_recon_check_txn_types',
                '_recon_check_loans',
                '_recon_check_emi',
                '_recon_check_cards',
                '_recon_check_groups',
                '_recon_check_linked_pairs'];
  v_check    TEXT;
  v_batch    UUID[];
  v_offset   INT := 0;
  v_users    INT := 0;
  v_scope    TEXT := COALESCE(p_user_id::TEXT, 'ALL');
  v_new      INT := 0;
  v_resolved INT := 0;
  v_open     INT := 0;
  v_errors   INT := 0;
  v_staged   INT := 0;
  v_fatal    TEXT;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 THEN p_batch_size := 200; END IF;

  INSERT INTO public.reconciliation_runs (scope_user_id, status, checks_run, batch_size)
  VALUES (p_user_id, 'running', v_checks, p_batch_size)
  RETURNING id INTO v_run_id;

  -- Staging holds everything this run observed, before it is merged against the
  -- open findings. Created OUTSIDE the guarded block so it still exists if the
  -- block aborts. ON COMMIT DROP so pg_cron (one txn per run) and a Studio
  -- session behave identically.
  IF to_regclass('pg_temp._recon_stage') IS NOT NULL THEN
    EXECUTE 'DROP TABLE pg_temp._recon_stage';
  END IF;
  CREATE TEMP TABLE _recon_stage (
    kind TEXT, severity TEXT, user_id UUID, entity_id TEXT,
    expected NUMERIC, actual NUMERIC, delta NUMERIC, details JSONB,
    fingerprint TEXT
  ) ON COMMIT DROP;

  BEGIN
    LOOP
      SELECT array_agg(u.id ORDER BY u.id) INTO v_batch
      FROM (
        SELECT p.id
        FROM public.profiles p
        WHERE (p_user_id IS NULL OR p.id = p_user_id)
          AND COALESCE(p.is_deleted, FALSE) = FALSE
        ORDER BY p.id
        OFFSET v_offset
        LIMIT p_batch_size
      ) u;

      EXIT WHEN v_batch IS NULL OR COALESCE(array_length(v_batch, 1), 0) = 0;
      v_users  := v_users + array_length(v_batch, 1);
      v_offset := v_offset + p_batch_size;

      FOREACH v_check IN ARRAY v_checks LOOP
        BEGIN
          EXECUTE format(
            'INSERT INTO _recon_stage
               (kind, severity, user_id, entity_id, expected, actual, delta, details, fingerprint)
             SELECT c.kind, c.severity, c.user_id, c.entity_id,
                    c.expected, c.actual, c.delta, c.details,
                    c.kind || ''|'' || COALESCE(c.user_id::text, ''-'')
                           || ''|'' || COALESCE(c.entity_id, ''-'')
               FROM public.%I($1) c',
            v_check
          ) USING v_batch;
        EXCEPTION WHEN OTHERS THEN
          v_errors := v_errors + 1;
          INSERT INTO _recon_stage
            (kind, severity, user_id, entity_id, expected, actual, delta, details, fingerprint)
          VALUES (
            'check_error', 'error', NULL, v_check || '@' || v_scope,
            NULL, NULL, NULL,
            jsonb_build_object(
              'check', v_check, 'scope', v_scope,
              'sqlstate', SQLSTATE, 'message', SQLERRM,
              'batch_first_user', v_batch[1],
              'batch_size', array_length(v_batch, 1)),
            'check_error|-|' || v_check || '@' || v_scope);
        END;
      END LOOP;
    END LOOP;

    -- The same check_error fingerprint can arrive from several batches.
    DELETE FROM _recon_stage a
     USING _recon_stage b
     WHERE a.ctid > b.ctid AND a.fingerprint = b.fingerprint;

    SELECT count(*) INTO v_staged FROM _recon_stage;

    -- Merge 1 — refresh findings that are still open and still observed.
    UPDATE public.reconciliation_findings f
       SET expected     = s.expected,
           actual       = s.actual,
           delta        = s.delta,
           details      = s.details,
           severity     = s.severity,
           last_run_id  = v_run_id,
           last_seen_at = now(),
           seen_count   = f.seen_count + 1
      FROM _recon_stage s
     WHERE f.fingerprint = s.fingerprint
       AND f.resolved_at IS NULL;

    -- Merge 2 — open findings that are new.
    WITH ins AS (
      INSERT INTO public.reconciliation_findings
        (run_id, last_run_id, user_id, kind, severity, entity_id,
         expected, actual, delta, details, fingerprint)
      SELECT v_run_id, v_run_id, s.user_id, s.kind, s.severity, s.entity_id,
             s.expected, s.actual, s.delta, s.details, s.fingerprint
        FROM _recon_stage s
       WHERE NOT EXISTS (
               SELECT 1 FROM public.reconciliation_findings f
                WHERE f.fingerprint = s.fingerprint AND f.resolved_at IS NULL)
      RETURNING 1
    )
    SELECT count(*) INTO v_new FROM ins;

    -- Merge 3 — resolve open findings this run no longer sees.
    -- Scope matters: a single-user run must not close another user's findings.
    WITH res AS (
      UPDATE public.reconciliation_findings f
         SET resolved_at     = now(),
             resolved_run_id = v_run_id,
             last_run_id     = v_run_id
       WHERE f.resolved_at IS NULL
         AND (
               p_user_id IS NULL
               OR f.user_id = p_user_id
               OR (f.user_id IS NULL AND f.entity_id LIKE '%@' || p_user_id::TEXT)
             )
         AND NOT EXISTS (SELECT 1 FROM _recon_stage s WHERE s.fingerprint = f.fingerprint)
      RETURNING 1
    )
    SELECT count(*) INTO v_resolved FROM res;

  EXCEPTION WHEN OTHERS THEN
    v_fatal := SQLSTATE || ': ' || SQLERRM;
  END;

  SELECT count(*) INTO v_open
    FROM public.reconciliation_findings WHERE resolved_at IS NULL;

  UPDATE public.reconciliation_runs
     SET finished_at       = now(),
         status            = CASE WHEN v_fatal IS NOT NULL THEN 'error'
                                  WHEN v_errors > 0        THEN 'error'
                                  WHEN v_staged > 0        THEN 'ok_with_findings'
                                  ELSE 'ok' END,
         users_checked     = v_users,
         open_findings     = v_open,
         new_findings      = v_new,
         resolved_findings = v_resolved,
         check_errors      = v_errors,
         error_text        = v_fatal
   WHERE id = v_run_id;

  -- Log line for alerting. `HISAAB_RECONCILIATION_ALERT` is a deliberately
  -- unique token: a Supabase log alert (Logs -> postgres_logs) matching that
  -- string is the cheapest possible wiring, and it needs no service key to
  -- leave the database. See docs/invariant-monitoring.md §6.
  IF v_fatal IS NOT NULL OR v_errors > 0 OR v_open > 0 THEN
    RAISE WARNING
      'HISAAB_RECONCILIATION_ALERT run=% scope=% open=% new=% resolved=% check_errors=% fatal=%',
      v_run_id, v_scope, v_open, v_new, v_resolved, v_errors, COALESCE(v_fatal, '-');
  ELSE
    RAISE NOTICE
      'HISAAB_RECONCILIATION_OK run=% scope=% users=% open=0', v_run_id, v_scope, v_users;
  END IF;

  RETURN v_run_id;
END $$;

COMMENT ON FUNCTION public.run_reconciliation(UUID, INT) IS
  'Nightly business-invariant reconciliation (audit 2026-09 item L7). p_user_id NULL = every non-deleted profile, in batches of p_batch_size. Read-only over app data; writes only reconciliation_runs / reconciliation_findings. Never repairs anything.';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. THE ALERT SURFACE
-- ═══════════════════════════════════════════════════════════════════════════

-- Human review in Studio.
CREATE OR REPLACE VIEW public.reconciliation_open_findings AS
SELECT
  f.id, f.kind, f.severity, f.user_id, f.entity_id,
  f.expected, f.actual, f.delta,
  f.detected_at, f.last_seen_at, f.seen_count,
  round((EXTRACT(EPOCH FROM (now() - f.detected_at)) / 3600.0)::NUMERIC, 1) AS age_hours,
  f.details, f.run_id AS first_run_id, f.last_run_id
FROM public.reconciliation_findings f
WHERE f.resolved_at IS NULL;

REVOKE ALL ON public.reconciliation_open_findings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reconciliation_open_findings TO service_role;

-- Machine polling. ALWAYS returns at least one row (kind = '__run__') so an
-- uptime/alert tool can write a rule without special-casing "no rows".
--
--   ALERT on the '__run__' row when:
--     run_status <> 'ok'       → a check errored, or findings exist
--     open_count > 0           → any unresolved invariant violation
--     run_age_minutes > 1500   → the nightly job did not run (25h)
--   (No rows at all = reconciliation has never completed. Alert on that too.)
CREATE OR REPLACE FUNCTION public.reconciliation_summary()
RETURNS TABLE (
  run_id          BIGINT,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  run_status      TEXT,
  run_age_minutes NUMERIC,
  users_checked   INTEGER,
  kind            TEXT,
  severity        TEXT,
  open_count      BIGINT,
  new_in_run      BIGINT,
  resolved_in_run BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH last_run AS (
    SELECT * FROM public.reconciliation_runs
     WHERE finished_at IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1
  ),
  -- Explicit column names: inside a CTE the UNION's own select-list names
  -- apply, not the function's RETURNS TABLE aliases.
  summary_rows (run_id, started_at, finished_at, run_status, run_age_minutes,
                users_checked, kind, severity, open_count, new_in_run,
                resolved_in_run) AS (
  SELECT
    r.id, r.started_at, r.finished_at, r.status,
    round((EXTRACT(EPOCH FROM (now() - r.started_at)) / 60.0)::NUMERIC, 1),
    r.users_checked,
    '__run__'::TEXT,
    CASE WHEN r.status = 'ok' AND r.open_findings = 0 THEN 'ok' ELSE 'error' END,
    (SELECT count(*) FROM public.reconciliation_findings WHERE resolved_at IS NULL),
    r.new_findings::BIGINT,
    r.resolved_findings::BIGINT
  FROM last_run r

  UNION ALL

  SELECT
    r.id, r.started_at, r.finished_at, r.status,
    round((EXTRACT(EPOCH FROM (now() - r.started_at)) / 60.0)::NUMERIC, 1),
    r.users_checked,
    f.kind,
    CASE WHEN bool_or(f.severity = 'error') THEN 'error' ELSE 'warn' END,
    count(*) FILTER (WHERE f.resolved_at IS NULL),
    count(*) FILTER (WHERE f.run_id = r.id),
    count(*) FILTER (WHERE f.resolved_run_id = r.id)
  FROM last_run r
  JOIN public.reconciliation_findings f
    ON f.resolved_at IS NULL OR f.resolved_run_id = r.id OR f.run_id = r.id
  GROUP BY r.id, r.started_at, r.finished_at, r.status, r.users_checked, f.kind
  )
  -- '__run__' first (it is what an alert rule reads), then the kinds A-Z.
  SELECT * FROM summary_rows ORDER BY (kind <> '__run__'), kind;
$$;

COMMENT ON FUNCTION public.reconciliation_summary() IS
  'Poll target for an uptime/alert tool (service key). The kind=''__run__'' row carries the last finished run plus the total open-finding count; one further row per finding kind. Alert on run_status <> ''ok'', open_count > 0, or run_age_minutes > 1500.';

-- Execution is service-role only. The app must never call any of this.
REVOKE ALL ON FUNCTION public.run_reconciliation(UUID, INT)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconciliation_summary()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_transaction_legs(UUID[])   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_check_accounts(UUID[])     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_check_txn_types(UUID[])    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_check_loans(UUID[])        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_check_emi(UUID[])          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_check_cards(UUID[])        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_check_groups(UUID[])       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_check_linked_pairs(UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_note_meta(TEXT)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_urldecode(TEXT)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_numeric(TEXT)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_mapped_types()             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._recon_cron_status()              FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.run_reconciliation(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconciliation_summary()      TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6. SCHEDULING (pg_cron — guarded)
--
-- 22:00 UTC. PKT is UTC+05:00 → 03:00 Pakistan; GST is UTC+04:00 → 02:00 Gulf.
-- (The brief's "23:00 UTC = 03:00 PKT" is an hour out — 23:00 UTC is 04:00 PKT.
--  22:00 UTC is the hour that is quiet in BOTH markets.)
--
-- If pg_cron is not installed this block does nothing but RAISE NOTICE with the
-- exact dashboard steps. It never fails the migration.
-- ═══════════════════════════════════════════════════════════════════════════

DO $cron$
DECLARE
  v_jobid BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '[p3-invariant-monitoring] pg_cron is NOT installed — the nightly run was NOT scheduled.';
    RAISE NOTICE '[p3-invariant-monitoring] Enable it (Supabase Dashboard -> Database -> Extensions -> pg_cron), then re-run this file, or create the job in the Cron UI:';
    RAISE NOTICE '[p3-invariant-monitoring]   name:     hisaab-nightly-reconciliation';
    RAISE NOTICE '[p3-invariant-monitoring]   schedule: 0 22 * * *   (22:00 UTC = 03:00 PKT / 02:00 GST)';
    RAISE NOTICE '[p3-invariant-monitoring]   command:  SELECT public.run_reconciliation();';
    RETURN;
  END IF;

  BEGIN
    EXECUTE 'SELECT jobid FROM cron.job WHERE jobname = $1'
      INTO v_jobid USING 'hisaab-nightly-reconciliation';
    IF v_jobid IS NOT NULL THEN
      EXECUTE 'SELECT cron.unschedule($1)' USING 'hisaab-nightly-reconciliation';
    END IF;
    EXECUTE 'SELECT cron.schedule($1, $2, $3)'
      USING 'hisaab-nightly-reconciliation', '0 22 * * *', 'SELECT public.run_reconciliation();';
    RAISE NOTICE '[p3-invariant-monitoring] scheduled hisaab-nightly-reconciliation at 22:00 UTC (03:00 PKT / 02:00 GST).';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[p3-invariant-monitoring] pg_cron present but scheduling failed (% - %). Create the job from the dashboard Cron UI: 0 22 * * *  ->  SELECT public.run_reconciliation();',
      SQLSTATE, SQLERRM;
  END;
END
$cron$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 7. VERIFICATION — read-only. Nothing below changes data.
-- Every row should read "ok".
-- ═══════════════════════════════════════════════════════════════════════════

-- V1. Objects exist (3 relations + 15 functions).
SELECT
  'V1 objects' AS check_name,
  CASE WHEN count(*) = 18 THEN 'ok — 18/18'
       ELSE '!! MISSING (' || count(*) || '/18)' END AS verdict,
  string_agg(name, ', ' ORDER BY name) AS detail
FROM (
  SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('reconciliation_runs', 'reconciliation_findings',
                       'reconciliation_open_findings')
  UNION ALL
  SELECT p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('run_reconciliation', 'reconciliation_summary',
                       '_recon_transaction_legs', '_recon_note_meta',
                       '_recon_urldecode', '_recon_numeric', '_recon_mapped_types',
                       '_recon_cron_status',
                       '_recon_check_accounts', '_recon_check_txn_types',
                       '_recon_check_loans', '_recon_check_emi',
                       '_recon_check_cards', '_recon_check_groups',
                       '_recon_check_linked_pairs')
) q;

-- V2. The app cannot read the findings (RLS on, zero policies, no grants).
SELECT
  'V2 lockout' AS check_name,
  CASE WHEN bool_and(c.relrowsecurity)
        AND NOT EXISTS (SELECT 1 FROM pg_policies
                         WHERE schemaname = 'public'
                           AND tablename IN ('reconciliation_runs', 'reconciliation_findings'))
        AND NOT has_table_privilege('authenticated', 'public.reconciliation_findings', 'SELECT')
        AND NOT has_table_privilege('anon', 'public.reconciliation_findings', 'SELECT')
       THEN 'ok — service_role only'
       ELSE '!! CLIENT-VISIBLE' END AS verdict,
  'rls=' || bool_and(c.relrowsecurity)::text
    || ' policies=' || (SELECT count(*) FROM pg_policies
                         WHERE schemaname = 'public'
                           AND tablename IN ('reconciliation_runs', 'reconciliation_findings'))::text
    || ' authenticated_select=' || has_table_privilege('authenticated', 'public.reconciliation_findings', 'SELECT')::text AS detail
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('reconciliation_runs', 'reconciliation_findings');

-- V3. The app cannot execute the job.
SELECT
  'V3 execute' AS check_name,
  CASE WHEN NOT has_function_privilege('authenticated', 'public.run_reconciliation(uuid,int)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.run_reconciliation(uuid,int)', 'EXECUTE')
        AND has_function_privilege('service_role', 'public.run_reconciliation(uuid,int)', 'EXECUTE')
       THEN 'ok — service_role only'
       ELSE '!! CLIENT-CALLABLE or service_role locked out' END AS verdict;

-- V4. Nightly schedule.
SELECT 'V4 schedule' AS check_name, public._recon_cron_status() AS verdict;

-- V5. Sign-map round trip: no live, account-bearing transaction of a MAPPED
--     type is silently weightless (self-stored goal contributions are the one
--     legitimate exception and are excluded).
WITH scanned AS (
  SELECT DISTINCT l.txn_id
  FROM public._recon_transaction_legs(
         ARRAY(SELECT id FROM public.profiles WHERE COALESCE(is_deleted, FALSE) = FALSE)) l
)
SELECT
  'V5 sign map' AS check_name,
  CASE WHEN count(*) = 0 THEN 'ok — every account-bearing row produces legs'
       ELSE '!! ' || count(*) || ' account-bearing rows produce no legs' END AS verdict,
  COALESCE(string_agg(DISTINCT t.type, ', '), '(none)') AS detail
FROM public.transactions t
WHERE t.deleted_at IS NULL
  AND (t.source_account_id IS NOT NULL OR t.destination_account_id IS NOT NULL)
  AND t.type = ANY (public._recon_mapped_types())
  AND NOT (t.type = 'goal_contribution'
           AND COALESCE(public._recon_note_meta(t.notes)->>'goalSelfStored', '') = '1')
  AND t.id NOT IN (SELECT txn_id FROM scanned);

-- V6. Live dry run — writes a run row and any findings. This is the intended
--     way to see the current state of production.
--   SELECT public.run_reconciliation();
--   SELECT * FROM public.reconciliation_summary();
--   SELECT * FROM public.reconciliation_open_findings ORDER BY kind, abs(delta) DESC NULLS LAST;
