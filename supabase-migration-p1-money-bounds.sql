-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P1 item H10: server-side bounds on every money value
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- Apply AFTER (the whole audit-p0 set; this file only ADDS constraints and one
-- extra trigger, it never touches a policy, an RPC, or an existing trigger):
--   supabase-schema.sql
--   supabase-migration-phase3-budgets-recurring-remittances.sql
--   supabase-migration-committees.sql
--   supabase-migration-investments.sql
--   supabase-migration-audit-p0-currencies.sql            (see §0 note)
--   supabase-migration-audit-p0-group-ledger-integrity.sql (see §3 note)
--   supabase-migration-audit-p0-group-concurrency.sql
--   supabase-migration-audit-p0-consent-guards.sql
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
-- ────────────────────────────────────────────────────────────────────────────
-- docs/audit-2026-09/05-security.md  M12 (medium, UNVERIFIED)
--   "No server-side bounds on money values — poisoned amounts/splits
--    insertable into shared group ledgers."
--   Evidence: supabase-schema.sql:59-105, :210-230, :509-514 — transactions,
--   loans and group_expenses amounts are unconstrained NUMERIC (no CHECK > 0,
--   no cap, no currency whitelist);
--   supabase-migration-enforce-active-group-transaction-members.sql:41-59 (now
--   supabase-migration-audit-p0-group-ledger-integrity.sql:411-441) validates
--   the `splits` JSONB only for member-id membership — never positivity,
--   numeric type, or summing to the row's amount.
--   Cross-user impact: any connected member can POST
--     {amount: 0.01, splits: [{memberId: <victim>, amount: 50000}]}
--   and every member's client computes balances from the poisoned row
--   (src/lib/groupDebts.ts reads splits verbatim). In splits_only
--   (ledger-only) mode those rows ARE the entire money record.
--
-- docs/audit-2026-09/12-qa-review.md V-1 / F-9 (high)
--   Store-level money mutations accept unvalidated amounts. The client half of
--   that finding is fixed in src/stores/transactionStore.ts and
--   src/lib/currencyValidation.ts alongside this file; this migration is the
--   server of last resort for the same values, because every client guard is
--   bypassed by one curl against PostgREST.
--
-- ────────────────────────────────────────────────────────────────────────────
-- SIGN CONVENTION — CONFIRMED BEFORE WRITING ANY CHECK
-- ────────────────────────────────────────────────────────────────────────────
-- transactions.amount is stored UNSIGNED (magnitude only). Direction is
-- carried by which leg the account sits on:
--   src/stores/transactionStore.ts, `adjustment` branch:
--     "Direction is carried by which leg the account sits on, so the stored
--      amount stays positive like every other row."
--     amount = Math.abs(delta);  delta > 0 ? destination : source
-- So the correct bound is on the raw value, not on abs().
--
-- BUT the bound is `>= 0`, NOT `> 0`, for transactions and emi_schedules.
-- Zero is legitimately reachable today and blocking it would break shipped
-- flows:
--   * investment_buy of bonus shares at price 0 — src/stores/transactionStore.ts
--     computes amount = round(qty*price) + fees = 0 and the branch's own
--     comment says "Zero-cash entries (bonus shares at price 0) move no money".
--   * investment_sell where fees exactly equal proceeds —
--     src/lib/investmentMath.ts:206-208 permits `proceeds - fees == 0`.
--   * emi_schedules.amount — src/stores/emiStore.ts:61-79 computes
--     round(total/n); a 0.01 loan over 5 instalments yields four 0.00 rows and
--     one 0.01 row. Rare, but real, and freezing those users out of their own
--     schedule is worse than the 0.00 row.
-- Negative is never reachable on either column, and that is what M12 poisons.
-- accounts.balance IS legitimately negative (credit cards), so it is bounded
-- by magnitude only.
--
-- ────────────────────────────────────────────────────────────────────────────
-- THE MAGNITUDE CAP AND WHY IT IS 1e12
-- ────────────────────────────────────────────────────────────────────────────
-- Every amount in this product round-trips through a JavaScript `number`
-- (src/db/types.ts: `amount: number`) and is rounded to 2dp with
-- Math.round(x * 100) / 100 everywhere. That arithmetic is cent-exact only
-- while x * 100 <= Number.MAX_SAFE_INTEGER (9.007e15), i.e. while
-- x <= 9.007e13. 1e12 sits comfortably inside that with two orders of
-- magnitude of headroom, and is ~13 orders above the largest plausible
-- personal-khata entry (PKR 5,000,000 is the client's own PKR ceiling —
-- src/lib/currencyValidation.ts). Anything at or beyond 1e12 is garbage-data
-- DoS, not a user's udhaar. Named once, below, as MAX_MONEY.
--
-- ────────────────────────────────────────────────────────────────────────────
-- §0. THE CURRENCY WHITELIST LIVES IN EXACTLY ONE PLACE
-- ────────────────────────────────────────────────────────────────────────────
-- `v_currencies` in Section 2 is the ONLY literal list in this file; every
-- currency CHECK is generated from it. To add a ninth currency you edit
--   1. src/db/types.ts  SUPPORTED_CURRENCIES        (the client's source)
--   2. v_currencies in Section 2 of this file       (the server's source)
-- and re-run this migration — the DROP-then-ADD in the helper makes that a
-- clean replace. Verification query V3 prints every currency CHECK in the
-- database with a verdict column, so drift between the two is visible in one
-- query.
--
-- supabase-migration-audit-p0-currencies.sql already widened
-- linked_transaction_requests.currency and linked_settlement_requests.currency
-- to the same eight, under the names ltr_currency_supported /
-- lsr_currency_supported. This file deliberately does NOT redefine those two
-- (re-adding them here would mean the same list in two places, which is the
-- bug §0 exists to prevent) — it only adds the missing AMOUNT ceilings to
-- those tables, and V3 asserts all currency CHECKs agree.
--
-- ────────────────────────────────────────────────────────────────────────────
-- §1. NOT VALID, THEN BEST-EFFORT VALIDATE — WHY THE APPLY CANNOT FAIL
-- ────────────────────────────────────────────────────────────────────────────
-- Production is 40+ hand-applied migrations with no ledger (audit M1/F-MIG1),
-- so nobody can prove what is in the money columns today. Every constraint is
-- therefore added `NOT VALID` and only then VALIDATEd inside an exception
-- handler:
--   * NOT VALID still enforces the CHECK on every future INSERT and UPDATE —
--     the poisoning vector closes the moment this file is applied, regardless.
--   * VALIDATE re-checks the existing rows. If a pre-existing row violates it,
--     the VALIDATE alone rolls back (plpgsql subtransaction), the constraint
--     stays NOT VALID, and a WARNING names the constraint.
--   * Section 5's read-only finder queries then locate the exact offending
--     rows so a human can fix them and re-run this file.
-- The migration never aborts on legacy data. That is deliberate: a migration
-- that refuses to apply leaves the hole open.
--
-- ────────────────────────────────────────────────────────────────────────────
-- §2. HOW SECTION 3'S TRIGGER COMPOSES WITH THE EXISTING ONE
-- ────────────────────────────────────────────────────────────────────────────
-- supabase-migration-audit-p0-group-ledger-integrity.sql owns
--   FUNCTION public.tg_group_expenses_require_connected_members()
--   TRIGGER  group_expenses_require_connected_members
-- and supabase-migration-audit-p0-group-concurrency.sql owns
--   FUNCTION public.tg_group_expenses_version_guard()
-- This file creates a THIRD, separately-named function and trigger:
--   FUNCTION public.tg_group_expenses_validate_split_amounts()
--   TRIGGER  group_expenses_validate_split_amounts
-- It never CREATE OR REPLACEs, DROPs or renames either sibling. Postgres fires
-- BEFORE-row triggers in name order, so the order is
--   group_expenses_require_connected_members   (membership / authorship)
--   group_expenses_validate_split_amounts      (this file: arithmetic)
--   group_expenses_version_guard               (concurrency)
-- All three are pure validators that only RAISE or RETURN NEW unchanged, so
-- the order carries no meaning beyond which error message a doubly-invalid
-- write reports first.
--
-- Division of labour, so nothing is validated twice and nothing falls between:
--   require_connected_members  → paid_by and every split memberId is a
--                                CONNECTED member; ≥2 connected members.
--   validate_split_amounts     → the splits array is well-formed, every share
--                                is a real non-negative number, at least one
--                                is positive, every memberId belongs to THIS
--                                group, and the shares sum to `amount`.
-- The membership predicate is deliberately weaker here (`belongs to this
-- group`, any status) than the sibling's (`connected`): the sibling is the
-- authority on status, and duplicating it would make this trigger reject
-- historical rows the sibling deliberately allows to be edited.
--
-- ────────────────────────────────────────────────────────────────────────────
-- §3. WHY SPLIT SHARES ARE `>= 0` AND NOT `> 0`
-- ────────────────────────────────────────────────────────────────────────────
-- A zero share is reachable from the shipped UI, so `> 0` would be a
-- regression, not a fix:
--   * src/lib/splitMath.ts equalSplits(): base = floor(amount*100/n)/100. An
--     expense of 0.01 across 3 members produces [0, 0, 0.01].
--   * computeShares 'exact': a selected participant left at 0 is accepted as
--     long as the column totals match.
--   * computeShares 'percentage': a participant at 0% yields a 0.00 share.
-- The attack in M12 is not a zero share — it is a share that does not
-- RECONCILE with the row's amount (0.01 charged, 50,000 attributed). The sum
-- check is the actual defence; `>= 0` plus "at least one > 0" closes the
-- negative-share and all-zero-row variants. This is recorded here because it
-- is a deliberate deviation from the audit's literal wording.
--
-- ────────────────────────────────────────────────────────────────────────────
-- §4. BOTH APP MODES TRACED (tasks/lessons.md:6-13, :26-27)
-- ────────────────────────────────────────────────────────────────────────────
-- full_tracker  — transactions rows carry account ids. Every bound below is on
--                 a VALUE column; not one references source_account_id or
--                 destination_account_id, so nothing changes for this mode
--                 beyond rejecting negative/absurd values.
-- splits_only   — ledger-only rows have BOTH account ids NULL by design
--                 (src/stores/loanStore.ts applyRepayment: "Pure record: BOTH
--                 account ids are null by design in ledger mode"; the
--                 card-bill repayment records in transactionStore do the same;
--                 group_expenses/group_settlements have no account columns at
--                 all). Those rows satisfy every constraint here unchanged —
--                 verified by fixture 5 in the Docker suite.
-- opening balance of 0 — src/stores/accountStore.ts createAccount only writes
--                 an opening_balance transaction `if (input.balance > 0)`, so
--                 a zero-opening account creates NO row; and if one ever is
--                 written, `amount >= 0` accepts it. `> 0` would not have.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. The helper — add NOT VALID, then try to VALIDATE
--
-- pg_temp: session-scoped, dropped automatically when the SQL Editor session
-- ends, so this migration leaves no permanent helper surface behind.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pg_temp.hisaab_money_check(
  p_table TEXT,
  p_name  TEXT,
  p_expr  TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF to_regclass('public.' || quote_ident(p_table)) IS NULL THEN
    RAISE NOTICE 'p1-money-bounds: table public.% absent — % skipped', p_table, p_name;
    RETURN;
  END IF;

  -- Re-runnable: replace whatever this name currently means.
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', p_table, p_name);
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID',
                 p_table, p_name, p_expr);

  BEGIN
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', p_table, p_name);
    RAISE NOTICE 'p1-money-bounds: % on public.% — added and VALIDATED', p_name, p_table;
  EXCEPTION WHEN check_violation THEN
    -- The constraint survives as NOT VALID: still enforced on every future
    -- write, just not asserted over history. Section 5 finds the bad rows.
    RAISE WARNING 'p1-money-bounds: % on public.% left NOT VALID — existing rows violate it. Run the Section 5 finder for this table, fix the rows, then re-run this migration.',
      p_name, p_table;
  END;
END;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. The constraint inventory
--
-- MAX_MONEY = 1e12 (see the header). Written as the literal 1e12 in every
-- expression because a CHECK cannot reference a variable; grep for `1e12` to
-- find every use.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  -- ─────────────────────────────────────────────────────────────────────────
  -- THE SINGLE SOURCE OF TRUTH FOR THE CURRENCY WHITELIST.
  -- Mirror of src/db/types.ts:1 SUPPORTED_CURRENCIES. Edit here and only here
  -- (plus the client constant) when a ninth currency ships. See §0.
  -- ─────────────────────────────────────────────────────────────────────────
  v_currencies CONSTANT TEXT[] := ARRAY['AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD'];

  -- Rendered once into `'AED','PKR',...` and reused by every currency CHECK.
  v_list TEXT;

  -- (table, column) pairs carrying a user-visible currency code. Complete as
  -- of 2026-09-02: derived from a repo-wide grep of every `currency TEXT`
  -- column declaration across supabase-schema.sql and all supabase-migration-*
  -- files. linked_transaction_requests / linked_settlement_requests are
  -- deliberately absent — audit-p0-currencies.sql owns those (see §0).
  v_currency_cols CONSTANT TEXT[][] := ARRAY[
    ARRAY['profiles',               'primary_currency'],     -- schema.sql:11
    ARRAY['accounts',               'currency'],             -- schema.sql:45
    ARRAY['transactions',           'currency'],             -- schema.sql:64
    ARRAY['loans',                  'currency'],             -- schema.sql:97
    ARRAY['goals',                  'currency'],             -- schema.sql:137
    ARRAY['upcoming_expenses',      'currency'],             -- schema.sql:174
    ARRAY['split_groups',           'currency'],             -- schema.sql:198
    ARRAY['committees',             'currency'],             -- committees.sql:15
    ARRAY['investment_markets',     'currency'],             -- investments.sql:28
    ARRAY['budgets',                'currency'],             -- phase3.sql:23
    ARRAY['recurring_transactions', 'currency'],             -- phase3.sql:63
    ARRAY['remittances',            'source_currency'],      -- phase3.sql:105
    ARRAY['remittances',            'destination_currency'], -- phase3.sql:108
    ARRAY['remittances',            'fee_currency']          -- phase3.sql:112
  ];
  i INTEGER;
  v_tbl TEXT;
  v_col TEXT;
BEGIN
  SELECT string_agg(quote_literal(c), ',') INTO v_list
    FROM unnest(v_currencies) AS c;

  -- ── 2a. Currency whitelists ───────────────────────────────────────────────
  -- Constraint name: <table>_<column>_supported. Generated, never hand-typed.
  FOR i IN 1 .. array_length(v_currency_cols, 1) LOOP
    v_tbl := v_currency_cols[i][1];
    v_col := v_currency_cols[i][2];
    -- Column guard as well as table guard: `remittances` was removed from the
    -- product on 2026-06-19 but may still exist in prod with any shape.
    IF to_regclass('public.' || quote_ident(v_tbl)) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = v_tbl AND column_name = v_col
       )
    THEN
      PERFORM pg_temp.hisaab_money_check(
        v_tbl,
        v_tbl || '_' || v_col || '_supported',
        format('%I IN (%s)', v_col, v_list)
      );
    ELSE
      RAISE NOTICE 'p1-money-bounds: public.%.% absent — currency whitelist skipped', v_tbl, v_col;
    END IF;
  END LOOP;

  -- ── 2b. transactions ──────────────────────────────────────────────────────
  -- amount: unsigned magnitude (see the sign-convention note). `>= 0`, not
  -- `> 0` — zero-cash investment rows are legitimate.
  PERFORM pg_temp.hisaab_money_check(
    'transactions', 'transactions_amount_bounded',
    'amount >= 0 AND amount < 1e12');
  -- conversion_rate: mirrors src/lib/conversionMath.ts RATE_MIN/RATE_MAX
  -- (0.0001 … 100000) exactly, so a rate the client would reject cannot be
  -- posted around it. NULL is the same-currency case and stays legal.
  PERFORM pg_temp.hisaab_money_check(
    'transactions', 'transactions_conversion_rate_bounded',
    'conversion_rate IS NULL OR (conversion_rate >= 0.0001 AND conversion_rate <= 100000)');

  -- ── 2c. accounts ──────────────────────────────────────────────────────────
  -- Negative balances are correct for credit cards, so magnitude only.
  PERFORM pg_temp.hisaab_money_check(
    'accounts', 'accounts_balance_bounded',
    'balance > -1e12 AND balance < 1e12');

  -- ── 2d. loans ─────────────────────────────────────────────────────────────
  -- Column names are total_amount / remaining_amount (schema.sql:95-96).
  -- The 0.01 slack on the ordering check absorbs the 2dp rounding the client
  -- does on every repayment (src/lib/loanRemainingDelta.ts round2).
  PERFORM pg_temp.hisaab_money_check(
    'loans', 'loans_total_amount_bounded',
    'total_amount >= 0 AND total_amount < 1e12');
  PERFORM pg_temp.hisaab_money_check(
    'loans', 'loans_remaining_amount_bounded',
    'remaining_amount >= 0 AND remaining_amount < 1e12');
  PERFORM pg_temp.hisaab_money_check(
    'loans', 'loans_remaining_not_over_total',
    'remaining_amount <= total_amount + 0.01');

  -- ── 2e. emi_schedules ─────────────────────────────────────────────────────
  -- `>= 0`: the rounding tail of a tiny loan is a legitimate 0.00 instalment
  -- (see the sign-convention note). installment_number is not money but is
  -- bounded here because an absurd value is the same garbage-data DoS.
  PERFORM pg_temp.hisaab_money_check(
    'emi_schedules', 'emi_schedules_amount_bounded',
    'amount >= 0 AND amount < 1e12');
  PERFORM pg_temp.hisaab_money_check(
    'emi_schedules', 'emi_schedules_installment_number_sane',
    'installment_number >= 1 AND installment_number <= 1200');

  -- ── 2f. goals ─────────────────────────────────────────────────────────────
  PERFORM pg_temp.hisaab_money_check(
    'goals', 'goals_target_amount_bounded',
    'target_amount >= 0 AND target_amount < 1e12');
  PERFORM pg_temp.hisaab_money_check(
    'goals', 'goals_saved_amount_bounded',
    'saved_amount >= 0 AND saved_amount < 1e12');

  -- ── 2g. upcoming_expenses ─────────────────────────────────────────────────
  PERFORM pg_temp.hisaab_money_check(
    'upcoming_expenses', 'upcoming_expenses_amount_bounded',
    'amount >= 0 AND amount < 1e12');

  -- ── 2h. group_expenses — CROSS-USER. Strictly positive. ───────────────────
  -- The client already refuses `<= 0` (src/stores/splitStore.ts
  -- addGroupExpense: "Expense amount must be greater than zero"), and a
  -- zero-amount shared expense has no meaning — it exists only to make the
  -- splits arithmetic in Section 3 unfalsifiable.
  PERFORM pg_temp.hisaab_money_check(
    'group_expenses', 'group_expenses_amount_positive',
    'amount > 0 AND amount < 1e12');

  -- ── 2i. group_settlements — CROSS-USER. Strictly positive. ────────────────
  -- A zero settlement is a no-op row that still moves the leave-gate
  -- arithmetic; audit-p0-group-concurrency.sql caps the upper side against
  -- the live debt, this closes the lower side and the magnitude.
  PERFORM pg_temp.hisaab_money_check(
    'group_settlements', 'group_settlements_amount_positive',
    'amount > 0 AND amount < 1e12');

  -- ── 2j. Cross-user request tables — amount ceilings ───────────────────────
  -- `amount > 0` already exists inline (phase2b:13, phase2c-a:166,
  -- fix-bidirectional:24); only the ceiling is missing, and these are exactly
  -- the rows the audit's "X wants to record PKR 99,999,999 with you" spam
  -- scenario (H2) rides on.
  PERFORM pg_temp.hisaab_money_check(
    'linked_transaction_requests', 'ltr_amount_bounded',
    'amount > 0 AND amount < 1e12');
  PERFORM pg_temp.hisaab_money_check(
    'linked_settlement_requests', 'lsr_amount_bounded',
    'amount > 0 AND amount < 1e12');

  -- ── 2k. committees (kameti) ───────────────────────────────────────────────
  PERFORM pg_temp.hisaab_money_check(
    'committees', 'committees_contribution_amount_positive',
    'contribution_amount > 0 AND contribution_amount < 1e12');
  PERFORM pg_temp.hisaab_money_check(
    'committees', 'committees_counts_sane',
    'member_count >= 1 AND member_count <= 1000 AND total_rounds >= 1 AND total_rounds <= 1000');

  -- ── 2l. investments ───────────────────────────────────────────────────────
  -- investments.sql already pins the shape per kind (:55-60) and price > 0
  -- (:70); only the ceilings are missing.
  PERFORM pg_temp.hisaab_money_check(
    'investment_trades', 'investment_trades_amounts_bounded',
    'quantity >= 0 AND quantity < 1e12'
    || ' AND price_per_unit >= 0 AND price_per_unit < 1e12'
    || ' AND amount >= 0 AND amount < 1e12'
    || ' AND fees >= 0 AND fees < 1e12');
  PERFORM pg_temp.hisaab_money_check(
    'investment_prices', 'investment_prices_price_bounded',
    'price > 0 AND price < 1e12');

  -- ── 2m. budgets / recurring / remittances ─────────────────────────────────
  PERFORM pg_temp.hisaab_money_check(
    'budgets', 'budgets_monthly_amount_bounded',
    'monthly_amount >= 0 AND monthly_amount < 1e12');
  PERFORM pg_temp.hisaab_money_check(
    'recurring_transactions', 'recurring_transactions_amount_bounded',
    'amount > 0 AND amount < 1e12');
  IF to_regclass('public.remittances') IS NOT NULL THEN
    PERFORM pg_temp.hisaab_money_check(
      'remittances', 'remittances_amounts_bounded',
      'source_amount > 0 AND source_amount < 1e12'
      || ' AND destination_amount > 0 AND destination_amount < 1e12'
      || ' AND fee_amount >= 0 AND fee_amount < 1e12'
      || ' AND effective_rate >= 0.0001 AND effective_rate <= 100000');
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. group_expenses.splits — the arithmetic trigger (M12's core)
--
-- COMPOSES WITH, never replaces, tg_group_expenses_require_connected_members
-- and tg_group_expenses_version_guard. See §2 of the header for the division
-- of labour and the firing order.
--
-- The exact JSONB shape written by the client (verified end to end):
--   src/db/types.ts        SplitDetail { memberId: string; amount: number }
--   src/lib/splitMath.ts   every allocator returns SplitDetail[]
--   src/lib/supabaseDb.ts  `splits: e.splits` — the array goes to Postgres
--                          verbatim, so the keys on the wire are camelCase.
-- `member_id` is also accepted, mirroring the COALESCE the sibling trigger
-- already does, so a snake_case writer is validated rather than waved through.
--
-- NOT scoped to client roles. Unlike the membership/authorship siblings this
-- is a pure arithmetic invariant with no legitimate exception: a SECURITY
-- DEFINER RPC has no more business writing shares that don't add up than a
-- browser does. The only definer writer today, reconcile_group_expense, flips
-- is_reconciled and never touches amount/splits/group_id, so the guard below
-- short-circuits for it on the very first condition.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_group_expenses_validate_split_amounts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_splits   JSONB := COALESCE(NEW.splits, '[]'::jsonb);
  v_sum      NUMERIC;
  v_positive INTEGER;
  v_bad      INTEGER;
BEGIN
  -- Only re-validate when the money-bearing shape actually moves. Metadata
  -- edits (description, category, reconciliation, soft-delete) skip out here,
  -- which is what keeps historical rows editable and the definer reconcile
  -- path free.
  IF TG_OP = 'UPDATE'
     AND NEW.amount   IS NOT DISTINCT FROM OLD.amount
     AND NEW.splits   IS NOT DISTINCT FROM OLD.splits
     AND NEW.group_id IS NOT DISTINCT FROM OLD.group_id
  THEN
    RETURN NEW;
  END IF;

  -- (1) Shape. jsonb_array_elements below would raise a raw type error on a
  --     non-array; this turns it into a stable, greppable code.
  IF jsonb_typeof(v_splits) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_GROUP_SPLITS: splits must be a JSON array'
      USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(v_splits) = 0 THEN
    RAISE EXCEPTION 'INVALID_GROUP_SPLITS: an expense must be split across at least one member'
      USING ERRCODE = '23514';
  END IF;

  -- (2) Every element is an object with a numeric, non-negative, in-range
  --     share. `jsonb_typeof(... ->'amount') = 'number'` rejects the string
  --     "50000", null, true and a missing key in one predicate — JSONB cannot
  --     hold NaN or Infinity at all (they are not valid JSON), so finiteness
  --     is guaranteed by the type, not by a check.
  --     `>= 0` and not `> 0` — see §3 of the header.
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(v_splits) AS s(value)
   WHERE jsonb_typeof(s.value) <> 'object'
      OR jsonb_typeof(s.value -> 'amount') <> 'number'
      OR (s.value ->> 'amount')::numeric < 0
      OR (s.value ->> 'amount')::numeric >= 1e12;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'INVALID_GROUP_SPLIT_AMOUNT: every split share must be a number between 0 and 1e12 (% offending share(s))', v_bad
      USING ERRCODE = '23514';
  END IF;

  -- (3) A row where every share is zero attributes nothing while still
  --     carrying a positive amount — the sum check below would catch it, but
  --     this gives the honest message.
  SELECT count(*) INTO v_positive
    FROM jsonb_array_elements(v_splits) AS s(value)
   WHERE (s.value ->> 'amount')::numeric > 0;
  IF v_positive = 0 THEN
    RAISE EXCEPTION 'INVALID_GROUP_SPLIT_AMOUNT: at least one split share must be greater than zero'
      USING ERRCODE = '23514';
  END IF;

  -- (4) Every memberId is a real member row of THIS group. Deliberately
  --     status-agnostic: tg_group_expenses_require_connected_members is the
  --     authority on 'connected', and duplicating it here would reject
  --     historical rows that trigger deliberately still permits.
  --     This is the half that stops a cross-group id from being smuggled in.
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(v_splits) AS s(value)
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.group_members AS gm
      WHERE gm.id = COALESCE(s.value ->> 'memberId', s.value ->> 'member_id')
        AND gm.group_id = NEW.group_id
   );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'INVALID_GROUP_SPLIT_MEMBER: every split must name a member of this group (% offending share(s))', v_bad
      USING ERRCODE = '23514';
  END IF;

  -- (5) THE FINDING. Shares must reconcile with the amount charged.
  --     Tolerance 0.01 — one cent — because the client's allocators round each
  --     share to 2dp and hand the remainder to the last participant
  --     (src/lib/splitMath.ts proportionalSplits), and its own defensive check
  --     (splitsSumToTotal) uses 0.005. Server tolerance is the looser of the
  --     two on purpose: the server must never reject a row the client
  --     considered valid.
  SELECT COALESCE(sum((s.value ->> 'amount')::numeric), 0) INTO v_sum
    FROM jsonb_array_elements(v_splits) AS s(value);

  IF abs(v_sum - NEW.amount) > 0.01 THEN
    RAISE EXCEPTION 'GROUP_SPLITS_DO_NOT_SUM: splits total % but the expense is % — they must match within 0.01', v_sum, NEW.amount
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_expenses_validate_split_amounts ON public.group_expenses;
CREATE TRIGGER group_expenses_validate_split_amounts
  BEFORE INSERT OR UPDATE ON public.group_expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_expenses_validate_split_amounts();

COMMENT ON FUNCTION public.tg_group_expenses_validate_split_amounts() IS
  'Audit M12: group_expenses.splits must be a non-empty array of {memberId, amount} objects whose shares are numeric, in [0, 1e12), at least one positive, all naming members of this group, and summing to the expense amount within 0.01. Composes with (never replaces) tg_group_expenses_require_connected_members and tg_group_expenses_version_guard.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. VERIFICATION — read-only, safe to re-run at any time
-- ═══════════════════════════════════════════════════════════════════════════

-- V1. Every constraint this migration owns, and whether it is VALIDATED.
--     EXPECT: one row per constraint, `validated = true` for all of them.
--     A `false` here means legacy rows violate it — the constraint is still
--     enforced going forward; use Section 5 to find and fix the rows.
SELECT t.relname                   AS table_name,
       c.conname                   AS constraint_name,
       c.convalidated              AS validated,
       pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  JOIN pg_class     t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
   AND c.contype = 'c'
   AND (c.conname LIKE '%_bounded'
     OR c.conname LIKE '%_supported'
     OR c.conname LIKE '%_positive'
     OR c.conname LIKE '%_sane'
     OR c.conname = 'loans_remaining_not_over_total')
 ORDER BY t.relname, c.conname;

-- V2. Single-line pass/fail on validation state.
--     EXPECT: not_validated = 0.
SELECT count(*) FILTER (WHERE NOT c.convalidated) AS not_validated,
       count(*) FILTER (WHERE c.convalidated)     AS validated
  FROM pg_constraint c
  JOIN pg_class     t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
   AND c.contype = 'c'
   AND (c.conname LIKE '%_bounded'
     OR c.conname LIKE '%_supported'
     OR c.conname LIKE '%_positive'
     OR c.conname LIKE '%_sane');

-- V3. THE §0 DRIFT CHECK. Every currency CHECK in the database, from this
--     migration AND from audit-p0-currencies.sql, with a verdict.
--     EXPECT: every row 'OK — all 8'. A 'NARROW' row means some table's
--     whitelist was written by hand somewhere and has drifted from
--     v_currencies / SUPPORTED_CURRENCIES.
SELECT t.relname                   AS table_name,
       c.conname                   AS constraint_name,
       CASE
         WHEN pg_get_constraintdef(c.oid) LIKE '%AED%'
          AND pg_get_constraintdef(c.oid) LIKE '%PKR%'
          AND pg_get_constraintdef(c.oid) LIKE '%PHP%'
          AND pg_get_constraintdef(c.oid) LIKE '%SAR%'
          AND pg_get_constraintdef(c.oid) LIKE '%QAR%'
          AND pg_get_constraintdef(c.oid) LIKE '%OMR%'
          AND pg_get_constraintdef(c.oid) LIKE '%KWD%'
          AND pg_get_constraintdef(c.oid) LIKE '%BHD%'
         THEN 'OK — all 8'
         ELSE 'NARROW — drifted from SUPPORTED_CURRENCIES'
       END                         AS verdict,
       pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  JOIN pg_class     t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
   AND c.contype = 'c'
   AND pg_get_constraintdef(c.oid) ILIKE '%currency%'
 ORDER BY t.relname, c.conname;

-- V4. Every group_expenses trigger, in firing order (Postgres fires row
--     triggers alphabetically within each timing).
--     EXPECT these five on a fully-migrated database:
--       group_expenses_notify                      (AFTER,  notifications)
--       group_expenses_require_connected_members   (BEFORE, ledger-integrity)
--       group_expenses_validate_split_amounts      (BEFORE, THIS FILE)
--       group_expenses_version_guard               (BEFORE, concurrency)
--       trg_group_expenses_reconciliation_payer    (BEFORE, reconciliation)
--     A missing sibling means a migration was skipped or this file clobbered
--     one — it does not, but verify rather than trust.
SELECT t.tgname  AS trigger_name,
       p.proname AS function_name,
       CASE WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc  p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal
   AND c.relname = 'group_expenses'
 ORDER BY t.tgname;

-- V5. Assertions. Aborts loudly with a descriptive message on any failure.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'group_expenses_validate_split_amounts'
       AND tgrelid = 'public.group_expenses'::regclass AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'p1-money-bounds: the splits arithmetic trigger is missing';
  END IF;

  -- The siblings this file must NOT have disturbed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'group_expenses_require_connected_members'
       AND tgrelid = 'public.group_expenses'::regclass AND NOT tgisinternal
  ) THEN
    RAISE WARNING 'p1-money-bounds: group_expenses_require_connected_members is absent — apply supabase-migration-audit-p0-group-ledger-integrity.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'group_expenses_version_guard'
       AND tgrelid = 'public.group_expenses'::regclass AND NOT tgisinternal
  ) THEN
    RAISE WARNING 'p1-money-bounds: group_expenses_version_guard is absent — apply supabase-migration-audit-p0-group-concurrency.sql';
  END IF;

  -- The two cross-user ledger tables must be strictly positive, not merely
  -- non-negative — this is the constraint M12 turns on.
  -- `amount > (0)` is how pg_get_constraintdef renders `amount > 0` against a
  -- NUMERIC column (it inserts the literal's cast: `(amount > (0)::numeric)`).
  SELECT count(*) INTO v_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname IN ('group_expenses', 'group_settlements')
     AND c.contype = 'c'
     AND c.conname IN ('group_expenses_amount_positive', 'group_settlements_amount_positive')
     AND pg_get_constraintdef(c.oid) LIKE '%amount > (0)%';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'p1-money-bounds: expected a strict amount > 0 CHECK on both group_expenses and group_settlements, found %', v_count;
  END IF;

  RAISE NOTICE 'p1-money-bounds: verification passed';
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. FINDERS — read-only. Run these if V2 reports not_validated > 0,
-- or BEFORE applying, to know the blast radius in advance.
--
-- Every query is a bare SELECT. Nothing here writes.
-- ═══════════════════════════════════════════════════════════════════════════

-- F1. THE ONE-QUERY PRE-FLIGHT. Every money row in the database that this
--     migration would refuse. EXPECT: zero rows. Run it BEFORE applying — if
--     it returns rows, decide what each one should have been, fix them, then
--     apply, and every constraint will VALIDATE cleanly on the first run.
SELECT 'transactions.amount'              AS what, id::text, amount::text AS value FROM public.transactions       WHERE NOT (amount >= 0 AND amount < 1e12)
UNION ALL SELECT 'transactions.conversion_rate', id::text, conversion_rate::text  FROM public.transactions       WHERE conversion_rate IS NOT NULL AND NOT (conversion_rate >= 0.0001 AND conversion_rate <= 100000)
UNION ALL SELECT 'transactions.currency',      id::text, currency                 FROM public.transactions       WHERE currency NOT IN ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD')
UNION ALL SELECT 'accounts.balance',           id::text, balance::text            FROM public.accounts           WHERE NOT (balance > -1e12 AND balance < 1e12)
UNION ALL SELECT 'accounts.currency',          id::text, currency                 FROM public.accounts           WHERE currency NOT IN ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD')
UNION ALL SELECT 'loans.total_amount',         id::text, total_amount::text       FROM public.loans              WHERE NOT (total_amount >= 0 AND total_amount < 1e12)
UNION ALL SELECT 'loans.remaining_amount',     id::text, remaining_amount::text   FROM public.loans              WHERE NOT (remaining_amount >= 0 AND remaining_amount < 1e12)
UNION ALL SELECT 'loans.remaining>total',      id::text, remaining_amount::text || ' > ' || total_amount::text FROM public.loans WHERE remaining_amount > total_amount + 0.01
UNION ALL SELECT 'loans.currency',             id::text, currency                 FROM public.loans              WHERE currency NOT IN ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD')
UNION ALL SELECT 'emi_schedules.amount',       id::text, amount::text             FROM public.emi_schedules      WHERE NOT (amount >= 0 AND amount < 1e12)
UNION ALL SELECT 'goals.target_amount',        id::text, target_amount::text      FROM public.goals              WHERE NOT (target_amount >= 0 AND target_amount < 1e12)
UNION ALL SELECT 'goals.saved_amount',         id::text, saved_amount::text       FROM public.goals              WHERE NOT (saved_amount >= 0 AND saved_amount < 1e12)
UNION ALL SELECT 'goals.currency',             id::text, currency                 FROM public.goals              WHERE currency NOT IN ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD')
UNION ALL SELECT 'upcoming_expenses.amount',   id::text, amount::text             FROM public.upcoming_expenses  WHERE NOT (amount >= 0 AND amount < 1e12)
UNION ALL SELECT 'upcoming_expenses.currency', id::text, currency                 FROM public.upcoming_expenses  WHERE currency NOT IN ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD')
UNION ALL SELECT 'split_groups.currency',      id::text, currency                 FROM public.split_groups       WHERE currency NOT IN ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD')
UNION ALL SELECT 'group_expenses.amount',      id::text, amount::text             FROM public.group_expenses     WHERE NOT (amount > 0 AND amount < 1e12)
UNION ALL SELECT 'group_settlements.amount',   id::text, amount::text             FROM public.group_settlements  WHERE NOT (amount > 0 AND amount < 1e12)
UNION ALL SELECT 'profiles.primary_currency',  id::text, primary_currency         FROM public.profiles           WHERE primary_currency NOT IN ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD')
 ORDER BY 1, 2;

-- F2. Existing group_expenses rows whose splits would fail Section 3's
--     trigger. These rows are NOT rewritten by this migration and stay
--     readable — but any future edit to their amount/splits/group_id will now
--     be refused until they are corrected. EXPECT: zero rows.
--     `reason` says which rule each row breaks.
SELECT e.id,
       e.group_id,
       e.amount,
       (SELECT COALESCE(sum((s.value ->> 'amount')::numeric), 0)
          FROM jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) AS s(value)
         WHERE jsonb_typeof(s.value -> 'amount') = 'number')            AS splits_total,
       CASE
         WHEN jsonb_typeof(COALESCE(e.splits, '[]'::jsonb)) <> 'array' THEN 'splits is not an array'
         WHEN jsonb_array_length(COALESCE(e.splits, '[]'::jsonb)) = 0   THEN 'splits is empty'
         WHEN EXISTS (
           SELECT 1 FROM jsonb_array_elements(e.splits) AS s(value)
            WHERE jsonb_typeof(s.value -> 'amount') <> 'number'
         )                                                              THEN 'a share is not a number'
         WHEN EXISTS (
           SELECT 1 FROM jsonb_array_elements(e.splits) AS s(value)
            WHERE (s.value ->> 'amount')::numeric < 0
         )                                                              THEN 'a share is negative'
         WHEN EXISTS (
           SELECT 1 FROM jsonb_array_elements(e.splits) AS s(value)
            WHERE NOT EXISTS (
              SELECT 1 FROM public.group_members gm
               WHERE gm.id = COALESCE(s.value ->> 'memberId', s.value ->> 'member_id')
                 AND gm.group_id = e.group_id
            )
         )                                                              THEN 'a share names a non-member'
         ELSE 'shares do not sum to the amount'
       END                                                              AS reason
  FROM public.group_expenses e
 WHERE e.deleted_at IS NULL
   AND (
     jsonb_typeof(COALESCE(e.splits, '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(COALESCE(e.splits, '[]'::jsonb)) = 0
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(e.splits) AS s(value)
        WHERE jsonb_typeof(s.value) <> 'object'
           OR jsonb_typeof(s.value -> 'amount') <> 'number'
           OR (s.value ->> 'amount')::numeric < 0
           OR (s.value ->> 'amount')::numeric >= 1e12
           OR NOT EXISTS (
             SELECT 1 FROM public.group_members gm
              WHERE gm.id = COALESCE(s.value ->> 'memberId', s.value ->> 'member_id')
                AND gm.group_id = e.group_id
           )
     )
     OR abs(
          (SELECT COALESCE(sum((s.value ->> 'amount')::numeric), 0)
             FROM jsonb_array_elements(e.splits) AS s(value)
            WHERE jsonb_typeof(s.value -> 'amount') = 'number')
          - e.amount
        ) > 0.01
   )
 ORDER BY e.group_id, e.id;

-- ────────────────────────────────────────────────────────────────────────────
-- Manual staging verification (two accounts, one shared group):
--  1. As member A, straight through PostgREST with A's JWT, the M12 payload:
--       POST /rest/v1/group_expenses
--       {"amount": 0.01, "splits": [{"memberId": "<B>", "amount": 50000}], ...}
--     -> 23514 / GROUP_SPLITS_DO_NOT_SUM. Was a 201 before this file.
--  2. Same, with {"amount": -100} -> 23514 (group_expenses_amount_positive).
--  3. Same, with a negative share -> 23514 / INVALID_GROUP_SPLIT_AMOUNT.
--  4. Same, with a memberId belonging to a DIFFERENT group
--     -> 23514 / INVALID_GROUP_SPLIT_MEMBER.
--  5. From the app, add a normal equal-split expense -> succeeds, and the
--     shares still sum to the cent.
--  6. From the app, edit that expense's DESCRIPTION only -> succeeds (the
--     trigger short-circuits; historical rows stay editable).
--  7. Toggle reconciliation as the payer (definer RPC path) -> succeeds.
--  8. In splits_only mode: record a ledger-only repayment (both account ids
--     NULL) -> the transaction row inserts unchanged.
--  9. Create an account with opening balance 0 -> no opening_balance row is
--     written at all; create one with balance 10 -> the row inserts.
-- 10. POST /rest/v1/transactions {"amount": -5000, ...} with your own JWT
--     -> 23514 (transactions_amount_bounded). Was a 201 before this file.
-- 11. POST /rest/v1/accounts {"currency": "USD", ...}
--     -> 23514 (accounts_currency_supported).
-- ────────────────────────────────────────────────────────────────────────────
