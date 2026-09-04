-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — PRE-FLIGHT for supabase-migration-p3-currencies-iso4217.sql
-- (2026-09-04)
--
-- Companion to: supabase-migration-p3-currencies-iso4217.sql
--               docs/currencies.md
--               docs/audit-2026-09/migration-data-safety-review.md (house style)
--
-- NOTE ON THE FILENAME: this is a diagnostic, NOT a migration, so it must not
-- be named `supabase-migration-*` — `.github/workflows/db-tests.yml` globs that
-- prefix and fails the build for any such file missing from
-- `supabase/tests/apply-order.txt` (tasks/lessons.md, 2026-09-03).
--
-- WHAT THIS IS
--   ONE read-only SELECT. Paste it into Supabase Studio → SQL Editor and run
--   it BEFORE applying `supabase-migration-p3-currencies-iso4217.sql`. It
--   counts, per currency column, the production rows whose code is not in the
--   157-row seed that migration installs.
--
-- IT IS STRICTLY READ-ONLY
--   Nothing but SELECT. No CREATE, no ALTER, no INSERT/UPDATE/DELETE, no temp
--   tables, no set_config. Safe to run at any time, as often as you like, and
--   it takes locks no heavier than a plain SELECT.
--
-- HOW TO READ THE OUTPUT
--   Columns: (column_ref, currency_code, violating_rows).
--
--   IDEAL RESULT: **ZERO ROWS RETURNED.** That is what is expected, and the
--   reason is structural rather than hopeful: every column below is today
--   constrained to the eight shipped currencies (AED PKR PHP SAR QAR OMR KWD
--   BHD) by `<table>_<column>_supported` from
--   `supabase-migration-p1-money-bounds.sql` §2a or by
--   `ltr/lsr_currency_supported` from
--   `supabase-migration-audit-p0-currencies.sql`, and all eight are in the
--   seed. A row here would mean a code the live CHECK already makes
--   impossible.
--
--   IF A ROW IS RETURNED: the migration still applies — that FK is added
--   `NOT VALID` and its `VALIDATE` is downgraded to a WARNING, so the constraint
--   lands and guards every future write while history goes unasserted. To
--   clear it afterwards, either add the missing code to `public.currencies`
--   (one INSERT) or correct the rows, then re-run the migration; its
--   DROP-then-ADD makes that a clean replace.
--
-- COMPATIBILITY
--   Runs unchanged BEFORE and AFTER the migration — it names no object the
--   migration creates. It does name `public.remittances`: the feature was
--   removed from the product on 2026-06-19 but the table is still in the
--   schema and still whitelisted, so its three currency columns are covered.
--   If that table is ever actually DROPped, delete the last three UNION ALL
--   branches (SQL cannot guard a missing table at run time — parsing fails
--   first).
-- ════════════════════════════════════════════════════════════════════════════

WITH seeded AS (
  -- The exact 157 codes seeded by supabase-migration-p3-currencies-iso4217.sql
  -- Section 2. Keep in sync with that file if a currency is ever added.
  SELECT unnest(ARRAY[
    'AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD',
    'AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN',
    'BAM','BBD','BDT','BGN','BIF','BMD','BND','BOB','BRL','BSD','BTN','BWP',
    'BYN','BZD',
    'CAD','CDF','CHF','CLP','CNY','COP','CRC','CUP','CVE','CZK',
    'DJF','DKK','DOP','DZD',
    'EGP','ERN','ETB','EUR',
    'FJD','FKP',
    'GBP','GEL','GHS','GIP','GMD','GNF','GTQ','GYD',
    'HKD','HNL','HTG','HUF',
    'IDR','ILS','INR','IQD','IRR','ISK',
    'JMD','JOD','JPY',
    'KES','KGS','KHR','KMF','KPW','KRW','KYD','KZT',
    'LAK','LBP','LKR','LRD','LSL','LYD',
    'MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN',
    'MYR','MZN',
    'NAD','NGN','NIO','NOK','NPR','NZD',
    'PAB','PEN','PGK','PLN','PYG',
    'RON','RSD','RUB','RWF',
    'SBD','SCR','SDG','SEK','SGD','SHP','SLE','SOS','SRD','SSP','STN','SVC',
    'SYP','SZL',
    'THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS',
    'UAH','UGX','USD','UYU','UZS',
    'VED','VES','VND','VUV',
    'WST',
    'XAF','XCD','XCG','XOF','XPF',
    'YER',
    'ZAR','ZMW','ZWG'
  ]) AS code
),
live AS (
  SELECT 'profiles.primary_currency'::text        AS column_ref, primary_currency AS currency_code FROM public.profiles
  UNION ALL SELECT 'accounts.currency',               currency FROM public.accounts
  UNION ALL SELECT 'transactions.currency',           currency FROM public.transactions
  UNION ALL SELECT 'loans.currency',                  currency FROM public.loans
  UNION ALL SELECT 'goals.currency',                  currency FROM public.goals
  UNION ALL SELECT 'upcoming_expenses.currency',      currency FROM public.upcoming_expenses
  UNION ALL SELECT 'split_groups.currency',           currency FROM public.split_groups
  UNION ALL SELECT 'committees.currency',             currency FROM public.committees
  UNION ALL SELECT 'investment_markets.currency',     currency FROM public.investment_markets
  UNION ALL SELECT 'budgets.currency',                currency FROM public.budgets
  UNION ALL SELECT 'recurring_transactions.currency', currency FROM public.recurring_transactions
  UNION ALL SELECT 'linked_transaction_requests.currency', currency FROM public.linked_transaction_requests
  UNION ALL SELECT 'linked_settlement_requests.currency',  currency FROM public.linked_settlement_requests
  -- remittances: the product removed the FEATURE on 2026-06-19 but the table
  -- is still in the schema (supabase-migration-phase3-budgets-recurring-
  -- remittances.sql:105-112) and is still whitelisted by p1-money-bounds §2a,
  -- so its three columns are read here. A query cannot guard a missing table
  -- at run time — parsing fails first — so if a future cleanup ever DROPs
  -- `remittances`, delete these three UNION ALL branches by hand.
  UNION ALL SELECT 'remittances.source_currency',      source_currency      FROM public.remittances
  UNION ALL SELECT 'remittances.destination_currency', destination_currency FROM public.remittances
  UNION ALL SELECT 'remittances.fee_currency',         fee_currency         FROM public.remittances
)
SELECT l.column_ref,
       l.currency_code,
       count(*) AS violating_rows
  FROM live l
 WHERE l.currency_code IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM seeded s WHERE s.code = l.currency_code)
 GROUP BY 1, 2
 ORDER BY 1, 2;
