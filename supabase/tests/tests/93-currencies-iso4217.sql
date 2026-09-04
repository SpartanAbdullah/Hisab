-- ════════════════════════════════════════════════════════════════════════════
-- 93 · ISO 4217 currencies — the reference table and the 16 foreign keys
--
-- Covers `supabase-migration-p3-currencies-iso4217.sql` (founder decision
-- 2026-09-04: accept every active ISO 4217 currency, not just the eight the
-- client ships).
--
-- What is being proved, in four groups:
--
--   1. THE TABLE IS REFERENCE DATA. It exists, RLS is on, `anon` can read it
--      (the logged-out kameti-witness and public-khata pages print amounts and
--      need minor units), and `authenticated` cannot write it — asserted for
--      INSERT, UPDATE and DELETE separately, because RLS-denied UPDATE/DELETE
--      is silent (`assert_zero_rows`, docs/testing-the-trust-boundary.md) and
--      only a missing GRANT turns them into an error.
--
--   2. THE WHITELISTS ARE GONE AND FKs REPLACED THEM. Written as a SET query
--      over `pg_constraint` — "no CHECK anywhere in public still lists a
--      currency literal", and "each of the 16 columns carries a VALIDATED FK
--      to currencies(code)" — not as a hand-list, so a future migration that
--      reintroduces a whitelist, or drops one of the FKs, fails here without
--      anybody remembering to update this file.
--
--   3. THE BEHAVIOUR CHANGED IN EXACTLY ONE DIRECTION. A currency that used
--      to be refused (JPY, USD) is now accepted; a code that is not a currency
--      at all (XXX, ZZZ) is still refused, and specifically with a FOREIGN KEY
--      violation rather than a CHECK violation.
--
--   4. MINOR UNITS ARE RIGHT. JPY = 0, KWD = 3, USD = 2 — one from each
--      bucket. Getting these wrong is the classic ISO 4217 bug and it is
--      invisible until someone rounds a Yen amount to two decimals.
--
-- Runs at 93-, after `92-function-grants.sql` and before `99-summary.sql`.
-- That is safe even though 92 is documented as "last before the summary": 92's
-- assertions are set queries over `pg_proc` / `pg_default_acl`, and this
-- migration creates NO function and alters no function grant, so there is
-- nothing here for 92 to have missed. It has to run after 40-money-integrity,
-- which asserts the currency contract from the other side.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('93-currencies-iso4217');

RESET ROLE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE TABLE
-- ═══════════════════════════════════════════════════════════════════════════

SELECT test.assert(
  to_regclass('public.currencies') IS NOT NULL,
  'public.currencies exists');

SELECT test.assert(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.currencies'::regclass),
  'RLS is enabled on public.currencies');

SELECT test.assert(
  (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.currencies'::regclass) = 1,
  'currencies carries exactly one policy (SELECT); no write policy exists',
  COALESCE((SELECT string_agg(polname || ' cmd=' || polcmd::text, ', ')
              FROM pg_policy WHERE polrelid = 'public.currencies'::regclass), '(none)'));

SELECT test.assert(
  (SELECT polcmd FROM pg_policy WHERE polrelid = 'public.currencies'::regclass) = 'r',
  'the single policy is FOR SELECT');

-- The primary key is what makes the 16 foreign keys legal at all.
SELECT test.assert(
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid = 'public.currencies'::regclass AND contype = 'p'),
  'currencies has a primary key on code');

-- Seed shape. 157 rows, ANG retired, three minor-unit buckets.
SELECT test.assert(
  (SELECT count(*) FROM public.currencies) = 157,
  'the seed installed 157 active ISO 4217 currencies',
  'actual: ' || (SELECT count(*)::text FROM public.currencies));

SELECT test.assert(
  (SELECT count(*) FROM public.currencies WHERE is_active) = 156
  AND NOT (SELECT is_active FROM public.currencies WHERE code = 'ANG'),
  'ANG is seeded but retired (replaced by XCG on 2025-03-31); everything else is active');

SELECT test.assert(
  (SELECT count(*) FROM public.currencies WHERE minor_units = 0) = 16
  AND (SELECT count(*) FROM public.currencies WHERE minor_units = 2) = 134
  AND (SELECT count(*) FROM public.currencies WHERE minor_units = 3) = 7,
  'minor-unit buckets are 16 / 134 / 7',
  (SELECT string_agg(minor_units || '→' || n, ' ' ORDER BY minor_units)
     FROM (SELECT minor_units, count(*) AS n FROM public.currencies GROUP BY 1) s));

-- The eight the client ships (src/db/types.ts:1 SUPPORTED_CURRENCIES) must
-- keep working unchanged — that is the whole compatibility promise.
SELECT test.assert(
  (SELECT count(*) FROM public.currencies
    WHERE code IN ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD')
      AND is_active) = 8,
  'all eight client-shipped currencies are present and active');

-- ── 4. MINOR UNITS — one assertion per bucket ─────────────────────────────
SELECT test.assert(
  (SELECT minor_units FROM public.currencies WHERE code = 'JPY') = 0,
  'JPY has 0 minor units');

SELECT test.assert(
  (SELECT minor_units FROM public.currencies WHERE code = 'KWD') = 3,
  'KWD has 3 minor units');

SELECT test.assert(
  (SELECT minor_units FROM public.currencies WHERE code = 'USD') = 2,
  'USD has 2 minor units');

-- The excluded codes. XXX ("no currency") is the sentinel 40-money-integrity
-- and the negative tests below rely on; the metals and fund codes have no
-- business in a khata.
SELECT test.assert(
  NOT EXISTS (SELECT 1 FROM public.currencies
               WHERE code IN ('XXX','XTS','XAU','XAG','XPT','XPD','XDR',
                              'BOV','CHE','CHW','CLF','COU','MXV','USN',
                              'UYI','UYW')),
  'no-currency / metal / fund-unit codes are deliberately NOT seeded',
  COALESCE((SELECT string_agg(code, ', ') FROM public.currencies
             WHERE code IN ('XXX','XTS','XAU','XAG','XPT','XPD','XDR',
                            'BOV','CHE','CHW','CLF','COU','MXV','USN',
                            'UYI','UYW')), '(none — correct)'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. GRANTS AND WRITE DENIAL
-- ═══════════════════════════════════════════════════════════════════════════

SELECT test.assert(
  has_table_privilege('anon',          'public.currencies', 'SELECT')
  AND has_table_privilege('authenticated', 'public.currencies', 'SELECT'),
  'anon AND authenticated hold SELECT on currencies (public pages print amounts)');

SELECT test.assert(
  NOT has_table_privilege('authenticated', 'public.currencies', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.currencies', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.currencies', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.currencies', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.currencies', 'UPDATE')
  AND NOT has_table_privilege('anon', 'public.currencies', 'DELETE'),
  'neither client role holds any write privilege on currencies');

-- Behavioural half: the catalog says no, and so does the server.
SET ROLE anon;
SELECT test.assert(
  (SELECT count(*) FROM public.currencies) = 157,
  'anon can actually SELECT all 157 rows (RLS policy TO anon USING (true))');
RESET ROLE;

SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

SELECT test.assert_ok(
  $$ SELECT code, name_en, minor_units FROM public.currencies WHERE code = 'PKR' $$,
  'authenticated can read currencies');

SELECT test.assert_raises(
  $$ INSERT INTO public.currencies (code, name_en, minor_units)
     VALUES ('QQQ', 'Fake Coin', 2) $$,
  'permission denied',
  'authenticated cannot INSERT a currency');

SELECT test.assert_raises(
  $$ UPDATE public.currencies SET minor_units = 9 WHERE code = 'JPY' $$,
  'permission denied',
  'authenticated cannot UPDATE a currency');

SELECT test.assert_raises(
  $$ DELETE FROM public.currencies WHERE code = 'JPY' $$,
  'permission denied',
  'authenticated cannot DELETE a currency');

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THE WHITELISTS ARE GONE, THE FOREIGN KEYS ARE THERE
-- ═══════════════════════════════════════════════════════════════════════════

RESET ROLE;   -- catalog reads; RLS is irrelevant and role is not the subject

-- Every former whitelist by name, from p1-money-bounds §2a (14) and
-- audit-p0-currencies (2). None may survive.
CREATE TEMP TABLE _former_whitelists (n TEXT);
INSERT INTO _former_whitelists (n) VALUES
  ('profiles_primary_currency_supported'),
  ('accounts_currency_supported'),
  ('transactions_currency_supported'),
  ('loans_currency_supported'),
  ('goals_currency_supported'),
  ('upcoming_expenses_currency_supported'),
  ('split_groups_currency_supported'),
  ('committees_currency_supported'),
  ('investment_markets_currency_supported'),
  ('budgets_currency_supported'),
  ('recurring_transactions_currency_supported'),
  ('remittances_source_currency_supported'),
  ('remittances_destination_currency_supported'),
  ('remittances_fee_currency_supported'),
  ('ltr_currency_supported'),
  ('lsr_currency_supported');

SELECT test.assert(
  (SELECT count(*) FROM _former_whitelists f
     JOIN pg_constraint c ON c.conname = f.n AND c.contype = 'c'
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace ns ON ns.oid = t.relnamespace AND ns.nspname = 'public') = 0,
  'all 16 named currency-whitelist CHECKs are gone',
  COALESCE((SELECT string_agg(f.n, ', ') FROM _former_whitelists f
              JOIN pg_constraint c ON c.conname = f.n AND c.contype = 'c'), '(none — correct)'));

-- Set query, deliberately not a name list: NOTHING in public may still pin a
-- currency by value. This is what catches a new migration re-adding one.
SELECT test.assert(
  (SELECT count(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace ns ON ns.oid = t.relnamespace
    WHERE ns.nspname = 'public' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%''AED''%') = 0,
  'no CHECK constraint anywhere in public still enumerates currency literals',
  COALESCE((SELECT string_agg(c.conrelid::regclass::text || '.' || c.conname, ', ')
              FROM pg_constraint c
             WHERE c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%''AED''%'), '(none — correct)'));

-- 16 FKs, one per currency column, every one VALIDATED.
CREATE TEMP TABLE _currency_fks AS
SELECT t.relname AS tbl, a.attname AS col, c.conname AS con, c.convalidated,
       c.confupdtype, c.confdeltype
  FROM pg_constraint c
  JOIN pg_class      t  ON t.oid = c.conrelid
  JOIN pg_namespace  ns ON ns.oid = t.relnamespace AND ns.nspname = 'public'
  JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute  a  ON a.attrelid = t.oid AND a.attnum = k.attnum
 WHERE c.contype = 'f' AND c.confrelid = 'public.currencies'::regclass;

SELECT test.assert(
  (SELECT count(*) FROM _currency_fks) = 16,
  '16 foreign keys reference currencies(code) — one per currency column',
  'actual: ' || (SELECT count(*)::text FROM _currency_fks));

SELECT test.assert(
  (SELECT count(*) FROM _currency_fks WHERE NOT convalidated) = 0,
  'every currency FK is VALIDATED (no legacy row holds an unknown code)',
  COALESCE((SELECT string_agg(tbl || '.' || col, ', ')
              FROM _currency_fks WHERE NOT convalidated), '(none — correct)'));

-- ON UPDATE CASCADE ('c'), ON DELETE RESTRICT ('r'): an ISO re-lettering must
-- reach the ledger; a currency row that money references must not be deletable.
SELECT test.assert(
  (SELECT count(*) FROM _currency_fks
    WHERE confupdtype <> 'c' OR confdeltype <> 'r') = 0,
  'every currency FK is ON UPDATE CASCADE / ON DELETE RESTRICT',
  COALESCE((SELECT string_agg(tbl || '.' || col || ' upd=' || confupdtype::text ||
                              ' del=' || confdeltype::text, ', ')
              FROM _currency_fks
             WHERE confupdtype <> 'c' OR confdeltype <> 'r'), '(none — correct)'));

-- Named coverage: each of the 16 (table, column) pairs is present. The count
-- assertion above cannot tell 16-of-the-right-ones from 16-of-anything.
CREATE TEMP TABLE _expected_fk_cols (tbl TEXT, col TEXT);
INSERT INTO _expected_fk_cols VALUES
  ('profiles',                    'primary_currency'),
  ('accounts',                    'currency'),
  ('transactions',                'currency'),
  ('loans',                       'currency'),
  ('goals',                       'currency'),
  ('upcoming_expenses',           'currency'),
  ('split_groups',                'currency'),
  ('committees',                  'currency'),
  ('investment_markets',          'currency'),
  ('budgets',                     'currency'),
  ('recurring_transactions',      'currency'),
  ('remittances',                 'source_currency'),
  ('remittances',                 'destination_currency'),
  ('remittances',                 'fee_currency'),
  ('linked_transaction_requests', 'currency'),
  ('linked_settlement_requests',  'currency');

SELECT test.assert(
  NOT EXISTS (
    SELECT 1 FROM _expected_fk_cols e
     WHERE NOT EXISTS (SELECT 1 FROM _currency_fks f
                        WHERE f.tbl = e.tbl AND f.col = e.col)),
  'every one of the 16 expected (table, column) pairs carries the FK',
  COALESCE((SELECT string_agg(e.tbl || '.' || e.col, ', ')
              FROM _expected_fk_cols e
             WHERE NOT EXISTS (SELECT 1 FROM _currency_fks f
                                WHERE f.tbl = e.tbl AND f.col = e.col)),
           '(none missing — correct)'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. BEHAVIOUR — what used to be refused is accepted; garbage still is not
-- ═══════════════════════════════════════════════════════════════════════════

SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

-- JPY: a real currency the eight-code whitelist refused until today. This is
-- the founder decision, made observable.
SELECT test.assert_ok($$
  INSERT INTO transactions (id, user_id, type, amount, currency, category)
  VALUES ('T-jpy', auth.uid(), 'expense', 1200, 'JPY', 'food')
$$, 'a transaction in JPY is accepted (was refused by the eight-code whitelist)');

-- USD: the code 40-money-integrity used to assert was refused. Same story.
SELECT test.assert_ok($$
  INSERT INTO loans (id, user_id, person_name, type, total_amount,
                     remaining_amount, currency)
  VALUES ('L-usd', auth.uid(), 'Nadia', 'lent', 100, 100, 'USD')
$$, 'a loan in USD is accepted');

-- A three-letter code that is not an ISO currency is still refused, and the
-- refusal is now a FOREIGN KEY violation, not a CHECK violation. Matching on
-- the constraint name proves which mechanism did the rejecting.
SELECT test.assert_raises($$
  INSERT INTO transactions (id, user_id, type, amount, currency, category)
  VALUES ('T-xxx', auth.uid(), 'expense', 10, 'XXX', 'food')
$$, 'transactions_currency_fk_currency',
  'XXX (ISO "no currency") is refused by the foreign key');

SELECT test.assert_raises($$
  INSERT INTO split_groups (id, user_id, name, currency)
  VALUES ('G-zzz', auth.uid(), 'Nowhere', 'ZZZ')
$$, 'split_groups_currency_fk_currency',
  'ZZZ (not a currency at all) is refused by the foreign key');

-- The FK guards UPDATE as well as INSERT — the poisoning vector is a PATCH
-- against PostgREST just as much as a POST.
SELECT test.assert_raises($$
  UPDATE transactions SET currency = 'ZZZ' WHERE id = 'T-jpy'
$$, 'foreign key',
  'switching an existing row to an unknown currency is refused');

-- ON DELETE RESTRICT: a currency in use cannot be removed. Asserted as the
-- table owner (RESET ROLE) precisely because `authenticated` would be stopped
-- by the missing grant long before the FK had anything to say.
RESET ROLE;
SELECT test.assert_raises(
  $$ DELETE FROM public.currencies WHERE code = 'JPY' $$,
  'transactions_currency_fk_currency',
  'a currency referenced by a money row cannot be deleted (ON DELETE RESTRICT)');

-- An unused currency is deletable — proving the RESTRICT above is the FK
-- talking and not some blanket refusal.
SELECT test.assert_ok(
  $$ DELETE FROM public.currencies WHERE code = 'KPW' $$,
  'an unreferenced currency row can be removed by the owner');
-- put it back; later suites and a re-run must see the full seed.
INSERT INTO public.currencies (code, name_en, minor_units, is_active, sort_order)
VALUES ('KPW', 'North Korean Won', 2, true, 1000)
ON CONFLICT (code) DO NOTHING;

-- ── cleanup: leave the database as 92- left it ────────────────────────────
DELETE FROM public.transactions WHERE id = 'T-jpy';
DELETE FROM public.loans        WHERE id = 'L-usd';
DROP TABLE IF EXISTS _former_whitelists, _currency_fks, _expected_fk_cols;
