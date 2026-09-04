-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P3: every active ISO 4217 currency, as reference DATA not a CHECK
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run (proved by
-- applying it twice in a row against the fully-migrated harness database).
--
-- APPLY ORDER: immediately BEFORE `supabase-migration-p3-invariant-monitoring
-- .sql` — i.e. after `supabase-migration-p3-rls-initplan-and-indexes.sql` and
-- BEFORE the two files that close the corpus. See "WHY HERE" below; the short
-- version is that this file creates a TABLE with a POLICY and no FUNCTION, so
-- it must sit ahead of the policy sweep's successor and it does not need to
-- sit after the function-grant sweep.
--
-- Prerequisites (all already in `supabase/tests/apply-order.txt` above it):
--   supabase-schema.sql                            (profiles, accounts,
--                                                   transactions, loans, goals,
--                                                   upcoming_expenses,
--                                                   split_groups)
--   supabase-migration-phase2b-linked-requests.sql (linked_transaction_requests)
--   supabase-migration-phase2c-a-settlement-requests.sql
--                                                  (linked_settlement_requests)
--   supabase-migration-phase3-budgets-recurring-remittances.sql
--                                                  (budgets,
--                                                   recurring_transactions,
--                                                   remittances)
--   supabase-migration-committees.sql              (committees)
--   supabase-migration-investments.sql             (investment_markets)
--   supabase-migration-audit-p0-currencies.sql     (ltr/lsr_currency_supported)
--   supabase-migration-p1-money-bounds.sql         (§2a — the 14 other
--                                                   <table>_<column>_supported
--                                                   whitelists this replaces)
--
-- ────────────────────────────────────────────────────────────────────────────
-- FOUNDER DECISION (2026-09-04)
-- ────────────────────────────────────────────────────────────────────────────
-- Hisaab accepts EVERY ACTIVE ISO 4217 CURRENCY, not just the eight the client
-- ships. The eight (AED PKR PHP SAR QAR OMR KWD BHD — src/db/types.ts:1
-- SUPPORTED_CURRENCIES) remain exactly what the UI offers; they are simply
-- eight rows in a table of 157 now, so nothing about the client changes and
-- nothing a client can pick stops working.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY A TABLE + FOREIGN KEY AND NOT A WIDER CHECK
-- ────────────────────────────────────────────────────────────────────────────
-- The whitelist has been widened twice in three days (AED/PKR → the eight, in
-- audit-p0-currencies.sql; then generated across 14 more columns in
-- p1-money-bounds.sql §2a). Each widening is a `DROP CONSTRAINT` + `ADD
-- CONSTRAINT` × 16 taking ACCESS EXCLUSIVE on 15 live money tables, and each
-- one duplicates the list into another file. With 157 codes that stops being
-- tenable:
--
--   * A CHECK cannot be introspected by the app. A table can: the client (or
--     a future admin screen) can render a currency picker straight from
--     `SELECT code, name_en, minor_units FROM currencies WHERE is_active`.
--   * Minor units have nowhere to live in a CHECK. They matter — JPY has no
--     decimals, KWD/BHD/OMR have three — and the rounding rules in
--     src/lib/ currently assume 2dp everywhere. This table is where that fact
--     becomes queryable (see docs/currencies.md §3).
--   * Adding or retiring a currency becomes one INSERT/UPDATE instead of a
--     DDL migration over 15 tables.
--   * A FOREIGN KEY is enforced by exactly the same machinery on every future
--     INSERT and UPDATE, and — unlike a CHECK — it can be added NOT VALID and
--     validated separately, so the apply never scans 15 tables under an
--     exclusive lock.
--
-- The FK is `ON UPDATE CASCADE, ON DELETE RESTRICT`:
--   * CASCADE, because ISO does occasionally re-letter a currency and the
--     rename must reach the ledger rows rather than break them.
--   * RESTRICT, because deleting a currency row that money references would
--     silently orphan history. Currencies are RETIRED by setting
--     `is_active = false`, never deleted. RESTRICT is the enforcement of that
--     rule, not a limitation.
--
-- `is_active` is deliberately NOT part of the FK. A row recorded in a currency
-- that later gets retired must keep its currency code; the flag governs what a
-- picker OFFERS, not what the ledger may HOLD. Nothing in this file enforces
-- `is_active` on writes and nothing should.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY HERE IN THE APPLY ORDER
-- ────────────────────────────────────────────────────────────────────────────
-- Position: line 3 from the bottom of `apply-order.txt` — after
-- `p3-rls-initplan-and-indexes.sql`, before `p3-invariant-monitoring.sql` and
-- `p3-rpc-execute-grants.sql`.
--
--   * AFTER p1-money-bounds — it drops that file's §2a constraints by name.
--     Running it first would leave 14 whitelists p1 would then re-create.
--   * AFTER p3-rls-initplan-and-indexes is NOT required and is chosen anyway
--     for a boring reason: that file's §2 sweep rewrites every bare
--     `auth.uid()` in a policy into the `(SELECT auth.uid())` initplan form.
--     This file's single policy is `USING (true)` — function-free, exactly
--     like `p1-app-config.sql:166`'s — so the sweep has nothing to do with it
--     in either direction. Placing this file after the sweep therefore costs
--     nothing and keeps the rule "the sweep is the last thing that touches
--     policies" literally true.
--   * BEFORE p3-invariant-monitoring, which its own header requires to be the
--     last thing that reads app data.
--   * BEFORE p3-rpc-execute-grants, and this is the part worth being explicit
--     about, because "the grants sweep must run last" is a real rule in this
--     repo:
--         **That sweep operates on FUNCTIONS ONLY.** Its §2/§3 iterate
--         `pg_proc`; its §4 is `ALTER DEFAULT PRIVILEGES … ON FUNCTIONS`
--         (p3-rpc-execute-grants.sql:502-507). There is no `ON TABLES` clause
--         anywhere in it and it never issues a table-level GRANT or REVOKE.
--     This file creates ZERO functions, so it has nothing for that sweep to
--     find, and the sweep cannot touch `public.currencies`' grants. The
--     `GRANT SELECT … TO anon, authenticated` in Section 3 below is therefore
--     final: no later file in the corpus alters it. (If a future file ever
--     adds an `ALTER DEFAULT PRIVILEGES … ON TABLES` clause, this file must
--     move below it — and Section 3's explicit GRANT would survive that
--     anyway, since default privileges only govern objects created AFTER
--     them.)
--
-- ────────────────────────────────────────────────────────────────────────────
-- DATA SAFETY — THIS FILE CANNOT FAIL ON TODAY'S DATA
-- ────────────────────────────────────────────────────────────────────────────
-- (House style: docs/audit-2026-09/migration-data-safety-review.md.)
--
--   Category           (b) — replaces constraints on 15 live tables
--   Apply-time DML     One INSERT into its OWN new table (157 seed rows).
--                      Not one row of user data is read, written or moved.
--   Can fail on data   No. Every FK is added NOT VALID and VALIDATEd inside an
--                      exception handler that downgrades a failure to a
--                      WARNING — the p1-money-bounds §1 pattern, verbatim.
--   Transaction        BEGIN → COMMIT around everything.
--   Idempotent         Yes. `create table if not exists`, seed is
--                      `on conflict (code) do update`, every constraint is
--                      `drop … if exists` before `add`.
--   Rollback block     Yes — commented out, at the bottom. Restores the
--                      eight-name CHECKs exactly as p1-money-bounds §2a and
--                      audit-p0-currencies wrote them.
--   Flag-gated         No. Nothing to gate: it only widens what is accepted.
--
-- Why "cannot fail" is a fact and not a hope, twice over:
--
--   1. **The change is a strict widening.** Every column being re-constrained
--      is today restricted to the eight shipped currencies, and all eight are
--      in the seed (Section 2 marks them `sort_order` 10-80). A row that
--      satisfies the old CHECK satisfies the new FK by construction. A
--      violation would require a row already holding a code the old CHECK made
--      impossible.
--   2. **Measured, not assumed.** `supabase-preflight-currencies-2026-09-04
--      .sql` (repo root) is a read-only query that counts, per table, the rows
--      whose currency is not in the seeded list. Production ran the equivalent
--      on 2026-09-03 as part of `supabase-preflight-2026-09-03.sql` §1/§15 and
--      returned 0 for every currency column. Expect 0 again.
--
-- Locks: `ADD CONSTRAINT … FOREIGN KEY … NOT VALID` takes SHARE ROW EXCLUSIVE
-- on the child table and on `currencies` — it blocks writes to that table for
-- the duration of a catalog update, not a scan. `VALIDATE CONSTRAINT` then
-- takes only SHARE UPDATE EXCLUSIVE and does a seq scan; concurrent reads and
-- writes continue. This is strictly cheaper than the ACCESS EXCLUSIVE + full
-- scan that the CHECKs it replaces cost.
--
-- ────────────────────────────────────────────────────────────────────────────
-- BOTH APP MODES TRACED (tasks/lessons.md:6-13)
-- ────────────────────────────────────────────────────────────────────────────
-- full_tracker: transactions/accounts/loans rows carry a currency; each gains
--   an FK in place of a CHECK. Same accept/reject verdict for all eight
--   shipped codes, so no artifact changes shape.
-- splits_only (ledger-only): `split_groups.currency`, `loans.currency` and
--   the transaction rows with BOTH account ids null are the whole money
--   record. They are covered by the same swap, again with an identical
--   verdict for the eight. Neither mode gains or loses a row, a constraint
--   error, or an artifact from this file.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY NOT SEEDED
-- ────────────────────────────────────────────────────────────────────────────
-- The seed is the active NATIONAL currencies only — 157 rows. Excluded:
--   * `XXX` (no currency) and `XTS` (reserved for testing). Excluding XXX is
--     load-bearing: `supabase/tests/tests/40-money-integrity.sql` uses it as
--     the sentinel for "an unlisted code is still refused".
--   * Precious metals `XAU XAG XPT XPD` — not money in this product.
--   * Fund/settlement codes `XDR XBA XBB XBC XBD XSU XUA`, and the inflation-
--     indexed unit-of-account codes `BOV CHE CHW CLF COU MXV USN UYI UYW`.
--     Nobody records an udhaar in a unit of account.
--   * Withdrawn codes: `CUC`, `SLL`, `ZWL`, `MRO`, `STD`, `VEF`, `BYR`. Their
--     replacements (`SLE`, `ZWG`, `MRU`, `STN`, `VES`/`VED`, `BYN`) are in.
--   The four currency-union codes that ARE real money — `XAF XCD XCG XOF XPF`
--   — are seeded.
--   `ANG` is seeded but flagged `is_active = false`: the Netherlands Antillean
--   guilder was replaced by the Caribbean guilder `XCG` on 2025-03-31. It stays
--   in the table because the FK must never reject a historical row, and
--   `is_active = false` is exactly how this file says "do not offer this".
--
-- MINOR UNITS — the part it is easy to get wrong, so it is stated in full:
--   0 decimals (16): BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV
--                    XAF XOF XPF
--   3 decimals (7):  BHD IQD JOD KWD LYD OMR TND
--   Everything else: 2.
--   `VUV` (Vanuatu vatu) is 0 in ISO 4217 and is seeded as 0 — it was not in
--   the briefed zero-decimal list, and ISO wins over the brief on a matter of
--   fact. `MGA` and `MRU` subdivide by 5, not 10; ISO 4217 nonetheless assigns
--   them minor_units = 2 and so does this table.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. The reference table
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.currencies (
  -- CHAR(3) because an ISO 4217 alphabetic code is exactly three characters,
  -- always. A TEXT foreign key against a CHAR(3) primary key is a supported
  -- combination (probed on postgres:15 before this file was written): the
  -- comparison resolves through the bpchar→text cast, a trailing-space code
  -- like 'USD ' does NOT match, and every one of the 16 referencing columns is
  -- plain TEXT.
  code        CHAR(3)  PRIMARY KEY,
  name_en     TEXT     NOT NULL,
  -- ISO 4217 "minor unit". 0, 2 or 3 exhausts the active list.
  minor_units SMALLINT NOT NULL DEFAULT 2,
  -- Governs what a picker OFFERS. NOT part of the FK — see the header.
  is_active   BOOLEAN  NOT NULL DEFAULT true,
  -- Lets the eight shipped currencies float to the top of a picker without
  -- the client hard-coding an order. Lower sorts first.
  sort_order  SMALLINT NOT NULL DEFAULT 1000,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guarded so a re-run against a table that already has them is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.currencies'::regclass
       AND conname  = 'currencies_code_format'
  ) THEN
    ALTER TABLE public.currencies
      ADD CONSTRAINT currencies_code_format CHECK (code ~ '^[A-Z]{3}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.currencies'::regclass
       AND conname  = 'currencies_minor_units_valid'
  ) THEN
    ALTER TABLE public.currencies
      ADD CONSTRAINT currencies_minor_units_valid CHECK (minor_units IN (0, 2, 3));
  END IF;
END;
$$;

COMMENT ON TABLE  public.currencies IS
  'Active ISO 4217 currencies. Reference data: readable by every client role, writable by none. Retire a currency with is_active = false; never DELETE (the FKs are ON DELETE RESTRICT). See docs/currencies.md.';
COMMENT ON COLUMN public.currencies.minor_units IS
  'ISO 4217 minor unit: decimal places. 0 (JPY, KRW, …), 2 (most), 3 (KWD, BHD, OMR, …).';
COMMENT ON COLUMN public.currencies.is_active IS
  'Whether a picker should OFFER this currency. Deliberately not enforced by the foreign keys — a retired currency must stay legal on historical rows.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. The seed — 157 active ISO 4217 currencies
--
-- ON CONFLICT (code) DO UPDATE, so a re-run repairs a hand-edited name or a
-- wrong minor_units without touching `is_active` (an operator may have
-- deliberately disabled a currency; a re-run must not silently re-enable it)
-- and without resetting `created_at`.
--
-- The eight shipped currencies carry sort_order 10-80 in the client's own
-- order (src/db/types.ts:1). Everything else is 1000 and sorts by name.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO public.currencies (code, name_en, minor_units, is_active, sort_order) VALUES
  -- ── the eight the client ships (src/db/types.ts:1 SUPPORTED_CURRENCIES) ──
  ('AED', 'UAE Dirham',                        2, true,  10),
  ('PKR', 'Pakistani Rupee',                   2, true,  20),
  ('PHP', 'Philippine Peso',                   2, true,  30),
  ('SAR', 'Saudi Riyal',                       2, true,  40),
  ('QAR', 'Qatari Riyal',                      2, true,  50),
  ('OMR', 'Omani Rial',                        3, true,  60),
  ('KWD', 'Kuwaiti Dinar',                     3, true,  70),
  ('BHD', 'Bahraini Dinar',                    3, true,  80),
  -- ── the rest of the active ISO 4217 list, alphabetical ──────────────────
  ('AFN', 'Afghan Afghani',                    2, true,  1000),
  ('ALL', 'Albanian Lek',                      2, true,  1000),
  ('AMD', 'Armenian Dram',                     2, true,  1000),
  -- Replaced by XCG on 2025-03-31; kept so historical rows stay legal.
  ('ANG', 'Netherlands Antillean Guilder',     2, false, 1000),
  ('AOA', 'Angolan Kwanza',                    2, true,  1000),
  ('ARS', 'Argentine Peso',                    2, true,  1000),
  ('AUD', 'Australian Dollar',                 2, true,  1000),
  ('AWG', 'Aruban Florin',                     2, true,  1000),
  ('AZN', 'Azerbaijani Manat',                 2, true,  1000),
  ('BAM', 'Bosnia and Herzegovina Convertible Mark', 2, true, 1000),
  ('BBD', 'Barbadian Dollar',                  2, true,  1000),
  ('BDT', 'Bangladeshi Taka',                  2, true,  1000),
  ('BGN', 'Bulgarian Lev',                     2, true,  1000),
  ('BIF', 'Burundian Franc',                   0, true,  1000),
  ('BMD', 'Bermudian Dollar',                  2, true,  1000),
  ('BND', 'Brunei Dollar',                     2, true,  1000),
  ('BOB', 'Bolivian Boliviano',                2, true,  1000),
  ('BRL', 'Brazilian Real',                    2, true,  1000),
  ('BSD', 'Bahamian Dollar',                   2, true,  1000),
  ('BTN', 'Bhutanese Ngultrum',                2, true,  1000),
  ('BWP', 'Botswana Pula',                     2, true,  1000),
  ('BYN', 'Belarusian Ruble',                  2, true,  1000),
  ('BZD', 'Belize Dollar',                     2, true,  1000),
  ('CAD', 'Canadian Dollar',                   2, true,  1000),
  ('CDF', 'Congolese Franc',                   2, true,  1000),
  ('CHF', 'Swiss Franc',                       2, true,  1000),
  ('CLP', 'Chilean Peso',                      0, true,  1000),
  ('CNY', 'Chinese Yuan Renminbi',             2, true,  1000),
  ('COP', 'Colombian Peso',                    2, true,  1000),
  ('CRC', 'Costa Rican Colon',                 2, true,  1000),
  ('CUP', 'Cuban Peso',                        2, true,  1000),
  ('CVE', 'Cape Verdean Escudo',               2, true,  1000),
  ('CZK', 'Czech Koruna',                      2, true,  1000),
  ('DJF', 'Djiboutian Franc',                  0, true,  1000),
  ('DKK', 'Danish Krone',                      2, true,  1000),
  ('DOP', 'Dominican Peso',                    2, true,  1000),
  ('DZD', 'Algerian Dinar',                    2, true,  1000),
  ('EGP', 'Egyptian Pound',                    2, true,  1000),
  ('ERN', 'Eritrean Nakfa',                    2, true,  1000),
  ('ETB', 'Ethiopian Birr',                    2, true,  1000),
  ('EUR', 'Euro',                              2, true,  1000),
  ('FJD', 'Fijian Dollar',                     2, true,  1000),
  ('FKP', 'Falkland Islands Pound',            2, true,  1000),
  ('GBP', 'Pound Sterling',                    2, true,  1000),
  ('GEL', 'Georgian Lari',                     2, true,  1000),
  ('GHS', 'Ghanaian Cedi',                     2, true,  1000),
  ('GIP', 'Gibraltar Pound',                   2, true,  1000),
  ('GMD', 'Gambian Dalasi',                    2, true,  1000),
  ('GNF', 'Guinean Franc',                     0, true,  1000),
  ('GTQ', 'Guatemalan Quetzal',                2, true,  1000),
  ('GYD', 'Guyanese Dollar',                   2, true,  1000),
  ('HKD', 'Hong Kong Dollar',                  2, true,  1000),
  ('HNL', 'Honduran Lempira',                  2, true,  1000),
  ('HTG', 'Haitian Gourde',                    2, true,  1000),
  ('HUF', 'Hungarian Forint',                  2, true,  1000),
  ('IDR', 'Indonesian Rupiah',                 2, true,  1000),
  ('ILS', 'Israeli New Shekel',                2, true,  1000),
  ('INR', 'Indian Rupee',                      2, true,  1000),
  ('IQD', 'Iraqi Dinar',                       3, true,  1000),
  ('IRR', 'Iranian Rial',                      2, true,  1000),
  ('ISK', 'Icelandic Krona',                   0, true,  1000),
  ('JMD', 'Jamaican Dollar',                   2, true,  1000),
  ('JOD', 'Jordanian Dinar',                   3, true,  1000),
  ('JPY', 'Japanese Yen',                      0, true,  1000),
  ('KES', 'Kenyan Shilling',                   2, true,  1000),
  ('KGS', 'Kyrgyzstani Som',                   2, true,  1000),
  ('KHR', 'Cambodian Riel',                    2, true,  1000),
  ('KMF', 'Comorian Franc',                    0, true,  1000),
  ('KPW', 'North Korean Won',                  2, true,  1000),
  ('KRW', 'South Korean Won',                  0, true,  1000),
  ('KYD', 'Cayman Islands Dollar',             2, true,  1000),
  ('KZT', 'Kazakhstani Tenge',                 2, true,  1000),
  ('LAK', 'Lao Kip',                           2, true,  1000),
  ('LBP', 'Lebanese Pound',                    2, true,  1000),
  ('LKR', 'Sri Lankan Rupee',                  2, true,  1000),
  ('LRD', 'Liberian Dollar',                   2, true,  1000),
  ('LSL', 'Lesotho Loti',                      2, true,  1000),
  ('LYD', 'Libyan Dinar',                      3, true,  1000),
  ('MAD', 'Moroccan Dirham',                   2, true,  1000),
  ('MDL', 'Moldovan Leu',                      2, true,  1000),
  -- Subdivides by 5, not 10; ISO 4217 still assigns minor_units 2.
  ('MGA', 'Malagasy Ariary',                   2, true,  1000),
  ('MKD', 'Macedonian Denar',                  2, true,  1000),
  ('MMK', 'Myanmar Kyat',                      2, true,  1000),
  ('MNT', 'Mongolian Tugrik',                  2, true,  1000),
  ('MOP', 'Macanese Pataca',                   2, true,  1000),
  -- Also a fifths currency; ISO 4217 minor_units 2.
  ('MRU', 'Mauritanian Ouguiya',               2, true,  1000),
  ('MUR', 'Mauritian Rupee',                   2, true,  1000),
  ('MVR', 'Maldivian Rufiyaa',                 2, true,  1000),
  ('MWK', 'Malawian Kwacha',                   2, true,  1000),
  ('MXN', 'Mexican Peso',                      2, true,  1000),
  ('MYR', 'Malaysian Ringgit',                 2, true,  1000),
  ('MZN', 'Mozambican Metical',                2, true,  1000),
  ('NAD', 'Namibian Dollar',                   2, true,  1000),
  ('NGN', 'Nigerian Naira',                    2, true,  1000),
  ('NIO', 'Nicaraguan Cordoba',                2, true,  1000),
  ('NOK', 'Norwegian Krone',                   2, true,  1000),
  ('NPR', 'Nepalese Rupee',                    2, true,  1000),
  ('NZD', 'New Zealand Dollar',                2, true,  1000),
  ('PAB', 'Panamanian Balboa',                 2, true,  1000),
  ('PEN', 'Peruvian Sol',                      2, true,  1000),
  ('PGK', 'Papua New Guinean Kina',            2, true,  1000),
  ('PLN', 'Polish Zloty',                      2, true,  1000),
  ('PYG', 'Paraguayan Guarani',                0, true,  1000),
  ('RON', 'Romanian Leu',                      2, true,  1000),
  ('RSD', 'Serbian Dinar',                     2, true,  1000),
  ('RUB', 'Russian Ruble',                     2, true,  1000),
  ('RWF', 'Rwandan Franc',                     0, true,  1000),
  ('SBD', 'Solomon Islands Dollar',            2, true,  1000),
  ('SCR', 'Seychellois Rupee',                 2, true,  1000),
  ('SDG', 'Sudanese Pound',                    2, true,  1000),
  ('SEK', 'Swedish Krona',                     2, true,  1000),
  ('SGD', 'Singapore Dollar',                  2, true,  1000),
  ('SHP', 'Saint Helena Pound',                2, true,  1000),
  ('SLE', 'Sierra Leonean Leone',              2, true,  1000),
  ('SOS', 'Somali Shilling',                   2, true,  1000),
  ('SRD', 'Surinamese Dollar',                 2, true,  1000),
  ('SSP', 'South Sudanese Pound',              2, true,  1000),
  ('STN', 'Sao Tome and Principe Dobra',       2, true,  1000),
  ('SVC', 'Salvadoran Colon',                  2, true,  1000),
  ('SYP', 'Syrian Pound',                      2, true,  1000),
  ('SZL', 'Swazi Lilangeni',                   2, true,  1000),
  ('THB', 'Thai Baht',                         2, true,  1000),
  ('TJS', 'Tajikistani Somoni',                2, true,  1000),
  ('TMT', 'Turkmenistani Manat',               2, true,  1000),
  ('TND', 'Tunisian Dinar',                    3, true,  1000),
  ('TOP', 'Tongan Paanga',                     2, true,  1000),
  ('TRY', 'Turkish Lira',                      2, true,  1000),
  ('TTD', 'Trinidad and Tobago Dollar',        2, true,  1000),
  ('TWD', 'New Taiwan Dollar',                 2, true,  1000),
  ('TZS', 'Tanzanian Shilling',                2, true,  1000),
  ('UAH', 'Ukrainian Hryvnia',                 2, true,  1000),
  ('UGX', 'Ugandan Shilling',                  0, true,  1000),
  ('USD', 'US Dollar',                         2, true,  1000),
  ('UYU', 'Uruguayan Peso',                    2, true,  1000),
  ('UZS', 'Uzbekistani Som',                   2, true,  1000),
  ('VED', 'Venezuelan Digital Bolivar',        2, true,  1000),
  ('VES', 'Venezuelan Sovereign Bolivar',      2, true,  1000),
  ('VND', 'Vietnamese Dong',                   0, true,  1000),
  -- ISO 4217 minor unit 0 (not in the briefed zero list; ISO is the authority).
  ('VUV', 'Vanuatu Vatu',                      0, true,  1000),
  ('WST', 'Samoan Tala',                       2, true,  1000),
  ('XAF', 'Central African CFA Franc',         0, true,  1000),
  ('XCD', 'East Caribbean Dollar',             2, true,  1000),
  ('XCG', 'Caribbean Guilder',                 2, true,  1000),
  ('XOF', 'West African CFA Franc',            0, true,  1000),
  ('XPF', 'CFP Franc',                         0, true,  1000),
  ('YER', 'Yemeni Rial',                       2, true,  1000),
  ('ZAR', 'South African Rand',                2, true,  1000),
  ('ZMW', 'Zambian Kwacha',                    2, true,  1000),
  ('ZWG', 'Zimbabwe Gold',                     2, true,  1000)
ON CONFLICT (code) DO UPDATE
  SET name_en     = EXCLUDED.name_en,
      minor_units = EXCLUDED.minor_units,
      sort_order  = EXCLUDED.sort_order,
      updated_at  = now();
-- NOTE: `is_active` is deliberately absent from the DO UPDATE list. Re-running
-- this file must not re-enable a currency an operator disabled by hand.

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. RLS — readable by every client role, writable by none
--
-- Modelled on supabase-migration-p1-app-config.sql §2, with ONE deliberate
-- difference: no `FORCE ROW LEVEL SECURITY`. `app_config` can afford FORCE
-- because its seed is `on conflict do nothing`; this file's seed is an
-- `on conflict do update`, and under FORCE a re-run would depend on the
-- applying role holding BYPASSRLS. Both Supabase Studio (`postgres`) and the
-- harness do hold it, but making a re-run's success depend on that is a
-- needless trap. The table is owned by `postgres`; there is no scenario in
-- which owner-bypass is the weakness here.
--
-- `anon` is NOT optional. Two public, logged-out pages print money amounts and
-- need to resolve a currency's minor units:
--   * the kameti witness page  (get_committee_witness, p2-trust-safety)
--   * the public khata page    (get_khata_view,        p3-khata-link)
-- Both are rendered above every gate in src/App.tsx and have no session.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "currencies read for all app clients" ON public.currencies;
CREATE POLICY "currencies read for all app clients"
  ON public.currencies
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Deliberately NO insert/update/delete policy. RLS on + no permissive write
-- policy = every client write denied. Only service_role (RLS-exempt) — i.e.
-- Supabase Studio or an edge function — may change reference data.
--
-- REVOKE ALL first, then GRANT SELECT. Supabase ships
-- `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon, authenticated,
-- service_role` in schema `public` (mirrored by the harness at
-- supabase/tests/scaffold.sql:236-237), so a brand-new table arrives with
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER already handed to both
-- client roles. RLS would stop the DML regardless; stripping the grants means
-- the privilege system says no first, and it makes the grant list assertable
-- (V6 below expects exactly SELECT, nothing else).
REVOKE ALL ON public.currencies FROM anon, authenticated;
GRANT SELECT ON public.currencies TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Replace all 16 currency whitelists with foreign keys
--
-- The 14 from p1-money-bounds.sql §2a (named <table>_<column>_supported, and
-- generated there, never hand-typed) plus the two audit-p0-currencies.sql owns
-- (ltr_currency_supported / lsr_currency_supported).
--
-- Per column:
--   1. drop the named CHECK if it is there; NOTICE if it is not (a database
--      that never got p1-money-bounds, or a future rename, must not abort);
--   2. sweep for ANY OTHER CHECK on that table whose definition names the
--      column AND contains a quoted 'AED' — i.e. a leftover value whitelist
--      under a name this file does not know. Amount/rate bounds never match
--      (they contain no currency literal), and neither does anything
--      unrelated;
--   3. add the FK NOT VALID, then VALIDATE inside an exception handler.
--
-- The FK is added even when the CHECK was absent — the point is the FK, not
-- the swap.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pg_temp.hisaab_currency_fk(
  p_table TEXT,
  p_col   TEXT,
  p_check TEXT      -- the whitelist CHECK this replaces, by name
) RETURNS VOID
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_fk  TEXT := p_table || '_' || p_col || '_fk_currency';
  r     RECORD;
BEGIN
  IF to_regclass('public.' || quote_ident(p_table)) IS NULL THEN
    RAISE NOTICE 'p3-currencies: table public.% absent — %.% skipped', p_table, p_table, p_col;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_col
  ) THEN
    RAISE NOTICE 'p3-currencies: column public.%.% absent — skipped', p_table, p_col;
    RETURN;
  END IF;

  -- 1. the named whitelist.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = ('public.' || quote_ident(p_table))::regclass
       AND conname  = p_check
       AND contype  = 'c'
  ) THEN
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', p_table, p_check);
    RAISE NOTICE 'p3-currencies: dropped CHECK % on public.%', p_check, p_table;
  ELSE
    RAISE NOTICE 'p3-currencies: CHECK % not present on public.% — nothing to drop',
                 p_check, p_table;
  END IF;

  -- 2. any other surviving value whitelist on the same column.
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = ('public.' || quote_ident(p_table))::regclass
       AND c.contype  = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%' || p_col || '%'
       AND pg_get_constraintdef(c.oid) ILIKE '%''AED''%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', p_table, r.conname);
    RAISE NOTICE 'p3-currencies: swept leftover whitelist % on public.%', r.conname, p_table;
  END LOOP;

  -- 3. the foreign key. Re-runnable: drop by name, then add.
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', p_table, v_fk);
  EXECUTE format(
    'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) '
    'REFERENCES public.currencies(code) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID',
    p_table, v_fk, p_col);

  BEGIN
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', p_table, v_fk);
    RAISE NOTICE 'p3-currencies: % on public.%.% — added and VALIDATED', v_fk, p_table, p_col;
  EXCEPTION WHEN foreign_key_violation THEN
    -- Survives as NOT VALID: still enforced on every future INSERT/UPDATE,
    -- just not asserted over history. The preflight finds the rows.
    RAISE WARNING 'p3-currencies: % on public.%.% left NOT VALID — existing rows hold a currency that is not in public.currencies. Run supabase-preflight-currencies-2026-09-04.sql, fix or seed those codes, then re-run this file.',
      v_fk, p_table, p_col;
  END;
END;
$fn$;

DO $$
DECLARE
  -- (table, column, the whitelist CHECK being replaced).
  -- Rows 1-14 mirror p1-money-bounds.sql §2a's v_currency_cols exactly, in the
  -- same order; rows 15-16 are audit-p0-currencies.sql's two.
  v_cols CONSTANT TEXT[][] := ARRAY[
    ARRAY['profiles',                    'primary_currency',     'profiles_primary_currency_supported'],
    ARRAY['accounts',                    'currency',             'accounts_currency_supported'],
    ARRAY['transactions',                'currency',             'transactions_currency_supported'],
    ARRAY['loans',                       'currency',             'loans_currency_supported'],
    ARRAY['goals',                       'currency',             'goals_currency_supported'],
    ARRAY['upcoming_expenses',           'currency',             'upcoming_expenses_currency_supported'],
    ARRAY['split_groups',                'currency',             'split_groups_currency_supported'],
    ARRAY['committees',                  'currency',             'committees_currency_supported'],
    ARRAY['investment_markets',          'currency',             'investment_markets_currency_supported'],
    ARRAY['budgets',                     'currency',             'budgets_currency_supported'],
    ARRAY['recurring_transactions',      'currency',             'recurring_transactions_currency_supported'],
    ARRAY['remittances',                 'source_currency',      'remittances_source_currency_supported'],
    ARRAY['remittances',                 'destination_currency', 'remittances_destination_currency_supported'],
    ARRAY['remittances',                 'fee_currency',         'remittances_fee_currency_supported'],
    ARRAY['linked_transaction_requests', 'currency',             'ltr_currency_supported'],
    ARRAY['linked_settlement_requests',  'currency',             'lsr_currency_supported']
  ];
  i INTEGER;
BEGIN
  FOR i IN 1 .. array_length(v_cols, 1) LOOP
    PERFORM pg_temp.hisaab_currency_fk(v_cols[i][1], v_cols[i][2], v_cols[i][3]);
  END LOOP;
END;
$$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only — safe to re-run at any time)
-- ═══════════════════════════════════════════════════════════════════════════

-- V1. Every currency column is now FK-covered.
--     EXPECT 16 rows, every `verdict` = 'OK — FK, validated'. A row reading
--     'FK NOT VALIDATED' means step 3's VALIDATE was downgraded to a WARNING;
--     run the preflight and re-apply. A missing row means that table or column
--     does not exist in this database (check the apply log's NOTICEs).
SELECT t.relname                     AS table_name,
       a.attname                     AS column_name,
       c.conname                     AS constraint_name,
       CASE WHEN c.convalidated THEN 'OK — FK, validated'
            ELSE 'FK NOT VALIDATED' END AS verdict
  FROM pg_constraint c
  JOIN pg_class      t ON t.oid = c.conrelid
  JOIN pg_namespace  n ON n.oid = t.relnamespace
  JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute  a ON a.attrelid = t.oid AND a.attnum = k.attnum
 WHERE n.nspname   = 'public'
   AND c.contype   = 'f'
   AND c.confrelid = 'public.currencies'::regclass
 ORDER BY 1, 2;

-- V2. One-line pass/fail.
--     EXPECT: currency_fks = 16, unvalidated_fks = 0, leftover_whitelists = 0.
SELECT
  (SELECT count(*) FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'public.currencies'::regclass) AS currency_fks,
  (SELECT count(*) FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'public.currencies'::regclass
      AND NOT convalidated)                                            AS unvalidated_fks,
  (SELECT count(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%''AED''%')               AS leftover_whitelists;

-- V3. Table shape and size.
--     EXPECT: total = 157, active = 156 (ANG is retired), the three
--     minor-unit buckets = 16 / 134 / 7, and rls_enabled = true.
SELECT count(*)                                          AS total,
       count(*) FILTER (WHERE is_active)                 AS active,
       count(*) FILTER (WHERE minor_units = 0)           AS zero_decimal,
       count(*) FILTER (WHERE minor_units = 2)           AS two_decimal,
       count(*) FILTER (WHERE minor_units = 3)           AS three_decimal,
       (SELECT relrowsecurity FROM pg_class
         WHERE oid = 'public.currencies'::regclass)      AS rls_enabled
  FROM public.currencies;

-- V4. THE ONE THAT MATTERS: no money row anywhere holds a currency the table
--     does not know. EXPECT zero rows returned.
--     (This is the post-apply twin of supabase-preflight-currencies-2026-09-04
--      .sql. If a FK landed NOT VALID, this query names the offenders.)
SELECT * FROM (
  SELECT 'profiles.primary_currency'              AS col, primary_currency     AS code, count(*) AS rows FROM public.profiles               GROUP BY 2
  UNION ALL SELECT 'accounts.currency',               currency,             count(*) FROM public.accounts               GROUP BY 2
  UNION ALL SELECT 'transactions.currency',           currency,             count(*) FROM public.transactions           GROUP BY 2
  UNION ALL SELECT 'loans.currency',                  currency,             count(*) FROM public.loans                  GROUP BY 2
  UNION ALL SELECT 'goals.currency',                  currency,             count(*) FROM public.goals                  GROUP BY 2
  UNION ALL SELECT 'upcoming_expenses.currency',      currency,             count(*) FROM public.upcoming_expenses      GROUP BY 2
  UNION ALL SELECT 'split_groups.currency',           currency,             count(*) FROM public.split_groups           GROUP BY 2
  UNION ALL SELECT 'committees.currency',             currency,             count(*) FROM public.committees             GROUP BY 2
  UNION ALL SELECT 'investment_markets.currency',     currency,             count(*) FROM public.investment_markets     GROUP BY 2
  UNION ALL SELECT 'budgets.currency',                currency,             count(*) FROM public.budgets                GROUP BY 2
  UNION ALL SELECT 'recurring_transactions.currency', currency,             count(*) FROM public.recurring_transactions GROUP BY 2
  UNION ALL SELECT 'ltr.currency',                    currency,             count(*) FROM public.linked_transaction_requests GROUP BY 2
  UNION ALL SELECT 'lsr.currency',                    currency,             count(*) FROM public.linked_settlement_requests  GROUP BY 2
) s
WHERE code IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.currencies c WHERE c.code = s.code)
ORDER BY 1, 2;

-- V5. The eight the client ships are all present and active.
--     EXPECT 8 rows, no 'MISSING'.
SELECT w.code,
       COALESCE(c.name_en, 'MISSING')                     AS name_en,
       COALESCE(c.minor_units::text, 'MISSING')           AS minor_units,
       COALESCE(c.is_active::text, 'MISSING')             AS is_active
  FROM unnest(ARRAY['AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD']) AS w(code)
  LEFT JOIN public.currencies c ON c.code = w.code
 ORDER BY 1;

-- V6. Grants: `anon` and `authenticated` may SELECT and nothing else.
--     EXPECT exactly two rows, both privilege_type = 'SELECT'.
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND table_name = 'currencies'
   AND grantee IN ('anon', 'authenticated')
 ORDER BY 1, 2;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (commented out — uncomment the whole block and run it to revert)
--
-- Restores the state this file replaced: the 16 eight-currency CHECK
-- whitelists exactly as p1-money-bounds.sql §2a and audit-p0-currencies.sql
-- wrote them, then removes the table.
--
-- ⚠ THIS IS A NARROWING. If any row was recorded in a ninth currency after
-- this file was applied, the matching `ADD CONSTRAINT` will fail and that
-- table keeps its FK instead — which is the correct outcome (never make a
-- user's money row illegal). Run V4 above first if you want to know in
-- advance.
--
-- ⚠ Run it BEFORE `p3-invariant-monitoring` / `p3-rpc-execute-grants` care:
-- neither touches this table, so order does not matter for them.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--
-- DO $rb$
-- DECLARE
--   v_list CONSTANT TEXT := $q$'AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD'$q$;
--   v_cols CONSTANT TEXT[][] := ARRAY[
--     ARRAY['profiles',                    'primary_currency',     'profiles_primary_currency_supported'],
--     ARRAY['accounts',                    'currency',             'accounts_currency_supported'],
--     ARRAY['transactions',                'currency',             'transactions_currency_supported'],
--     ARRAY['loans',                       'currency',             'loans_currency_supported'],
--     ARRAY['goals',                       'currency',             'goals_currency_supported'],
--     ARRAY['upcoming_expenses',           'currency',             'upcoming_expenses_currency_supported'],
--     ARRAY['split_groups',                'currency',             'split_groups_currency_supported'],
--     ARRAY['committees',                  'currency',             'committees_currency_supported'],
--     ARRAY['investment_markets',          'currency',             'investment_markets_currency_supported'],
--     ARRAY['budgets',                     'currency',             'budgets_currency_supported'],
--     ARRAY['recurring_transactions',      'currency',             'recurring_transactions_currency_supported'],
--     ARRAY['remittances',                 'source_currency',      'remittances_source_currency_supported'],
--     ARRAY['remittances',                 'destination_currency', 'remittances_destination_currency_supported'],
--     ARRAY['remittances',                 'fee_currency',         'remittances_fee_currency_supported'],
--     ARRAY['linked_transaction_requests', 'currency',             'ltr_currency_supported'],
--     ARRAY['linked_settlement_requests',  'currency',             'lsr_currency_supported']
--   ];
--   i INTEGER;
--   v_tbl TEXT; v_col TEXT; v_chk TEXT; v_fk TEXT;
-- BEGIN
--   FOR i IN 1 .. array_length(v_cols, 1) LOOP
--     v_tbl := v_cols[i][1]; v_col := v_cols[i][2]; v_chk := v_cols[i][3];
--     v_fk  := v_tbl || '_' || v_col || '_fk_currency';
--     CONTINUE WHEN to_regclass('public.' || quote_ident(v_tbl)) IS NULL;
--     BEGIN
--       EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IN (%s))',
--                      v_tbl, v_chk, v_col, v_list);
--       EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_tbl, v_fk);
--       RAISE NOTICE 'rollback: % restored on public.%', v_chk, v_tbl;
--     EXCEPTION WHEN check_violation THEN
--       RAISE WARNING 'rollback: public.%.% holds a currency outside the eight — CHECK NOT restored, FK kept.',
--                     v_tbl, v_col;
--     END;
--   END LOOP;
-- END;
-- $rb$;
--
-- -- Drop the table only if every FK really did come off. A bare
-- -- `DROP TABLE` here would ERROR the moment one column kept its FK (see the
-- -- warning above), and that error would roll back the whole rollback,
-- -- including the CHECKs the loop just restored. Guarded, so a partial
-- -- rollback stays a partial rollback instead of becoming no rollback.
-- DO $rb2$
-- DECLARE
--   v_left INT;
-- BEGIN
--   IF to_regclass('public.currencies') IS NULL THEN
--     RAISE NOTICE 'rollback: public.currencies already gone';
--     RETURN;
--   END IF;
--   SELECT count(*) INTO v_left FROM pg_constraint
--    WHERE contype = 'f' AND confrelid = 'public.currencies'::regclass;
--   IF v_left = 0 THEN
--     DROP TABLE public.currencies;
--     RAISE NOTICE 'rollback: public.currencies dropped';
--   ELSE
--     RAISE WARNING 'rollback: public.currencies KEPT — % foreign key(s) still reference it (%). Those columns hold a currency outside the eight; fix or accept the rows, then drop the table by hand.',
--       v_left,
--       (SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
--          FROM pg_constraint
--         WHERE contype = 'f' AND confrelid = 'public.currencies'::regclass);
--   END IF;
-- END;
-- $rb2$;
--
-- COMMIT;
