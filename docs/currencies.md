# Currencies

**Written:** 2026-09-04 · Founder decision the same day: **Hisaab accepts every
active ISO 4217 currency**, not just the eight the client offers.

Migration: [`supabase-migration-p3-currencies-iso4217.sql`](../supabase-migration-p3-currencies-iso4217.sql)
· Pre-flight: [`supabase-preflight-currencies-2026-09-04.sql`](../supabase-preflight-currencies-2026-09-04.sql)
· Tests: `supabase/tests/tests/93-currencies-iso4217.sql` (33 assertions)

---

## 1. The model

There is one table, `public.currencies`, and every currency column in the
database is a foreign key into it.

| Column | Type | Notes |
|---|---|---|
| `code` | `CHAR(3)` **PK** | The ISO 4217 alphabetic code. `CHECK (code ~ '^[A-Z]{3}$')`. |
| `name_en` | `TEXT NOT NULL` | English name. Display is the client's problem — this is a label, not i18n copy. |
| `minor_units` | `SMALLINT NOT NULL DEFAULT 2` | Decimal places. `CHECK (minor_units IN (0, 2, 3))`. |
| `is_active` | `BOOLEAN NOT NULL DEFAULT true` | Whether a picker should **offer** it. |
| `sort_order` | `SMALLINT NOT NULL DEFAULT 1000` | The eight shipped currencies carry 10-80 so they float to the top of a picker; everything else is 1000. |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | |

**157 rows seeded.** 156 active; `ANG` is seeded but inactive (replaced by
`XCG` on 2025-03-31).

**RLS is on. One policy: `FOR SELECT TO anon, authenticated USING (true)`.**
No write policy exists, and `REVOKE ALL` + `GRANT SELECT` means the privilege
system refuses a client write before RLS is even consulted. Only `service_role`
— Supabase Studio, or an edge function — can change reference data.

`anon` is not optional. Two public, logged-out pages print money amounts and
need to know a currency's minor units: the kameti witness page
(`get_committee_witness`) and the public khata page (`get_khata_view`). Both
render above every gate in `src/App.tsx`.

### The 16 foreign keys

| Table | Column |
|---|---|
| `profiles` | `primary_currency` |
| `accounts` | `currency` |
| `transactions` | `currency` |
| `loans` | `currency` |
| `goals` | `currency` |
| `upcoming_expenses` | `currency` |
| `split_groups` | `currency` |
| `committees` | `currency` |
| `investment_markets` | `currency` |
| `budgets` | `currency` |
| `recurring_transactions` | `currency` |
| `remittances` | `source_currency`, `destination_currency`, `fee_currency` |
| `linked_transaction_requests` | `currency` |
| `linked_settlement_requests` | `currency` |

Each is named `<table>_<column>_fk_currency` and is
**`ON UPDATE CASCADE, ON DELETE RESTRICT`**.

---

## 2. Why a foreign key and not a wider CHECK

The whitelist had already been widened twice in three days:
`supabase-migration-audit-p0-currencies.sql` took two cross-user tables from
`('AED','PKR')` to the eight the client ships, and
`supabase-migration-p1-money-bounds.sql` §2a then generated the same eight-code
CHECK across 14 more columns. Each widening is a `DROP CONSTRAINT` +
`ADD CONSTRAINT` on 15 live money tables under `ACCESS EXCLUSIVE`, and each one
copies the list into another file. At 157 codes that stops working:

- **A CHECK cannot be read by the app.** A table can — a picker is
  `SELECT code, name_en, minor_units FROM currencies WHERE is_active ORDER BY sort_order, name_en`.
- **Minor units have nowhere to live in a CHECK.** They are a fact about each
  currency, and the fact matters (§3).
- **Adding or retiring a currency becomes one row**, not a DDL migration over
  15 tables.
- **A FK can be added `NOT VALID` and validated separately**, so the apply is a
  catalog update under `SHARE ROW EXCLUSIVE` plus a concurrent-safe scan under
  `SHARE UPDATE EXCLUSIVE` — strictly cheaper than the exclusive lock + full
  scan a CHECK costs.

**`ON UPDATE CASCADE`** because ISO does occasionally re-letter a currency, and
a rename must reach the ledger rows rather than break them.
**`ON DELETE RESTRICT`** because deleting a currency that money references
would orphan history — retirement is `is_active = false`, and RESTRICT is what
enforces that rather than merely asking for it.

**`is_active` is deliberately not part of the FK.** A row recorded in a
currency that is later retired keeps its code. The flag governs what a picker
*offers*, never what the ledger may *hold*. Nothing enforces `is_active` on a
write, and nothing should.

**No index on the referencing columns, on purpose.** The reason an FK usually
wants one is the parent-side check: every `DELETE` or key-`UPDATE` on the
parent scans each child. On `currencies` neither happens — rows are retired,
not deleted, and the seed's upsert touches only `name_en` / `minor_units` /
`sort_order`, never `code`. `supabase/tests/tests/90-performance-hardening.sql`
excludes these 16 from its uncovered-FK census with that reasoning inline.

---

## 3. Minor units — the rule, and the gap it exposes

ISO 4217 assigns each currency a *minor unit*: the number of decimal places.
Across the active list there are exactly three values.

| Minor units | Count | Currencies |
|---|---|---|
| **0** | 16 | BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF |
| **2** | 134 | everything else |
| **3** | 7 | BHD IQD JOD KWD LYD OMR TND |

Two traps worth naming:

- **`MGA` and `MRU` subdivide by 5, not 10.** ISO 4217 nonetheless assigns them
  `minor_units = 2`, and so does this table. Do not "fix" it.
- **`VUV` is 0.** It is easy to miss because it is not one of the famous
  zero-decimal currencies.

**The client currently assumes 2dp everywhere.** `Math.round(x * 100) / 100` is
the rounding idiom across `src/lib/`, and `src/lib/currencyValidation.ts`
carries per-currency ceilings but not per-currency precision. Three of the
eight shipped currencies (OMR, KWD, BHD) are 3dp, so this predates the ISO
work — the table does not fix it, it makes the fact **queryable** so it can be
fixed. Treat `currencies.minor_units` as the server-side source of truth when
that work happens.

---

## 4. Adding or disabling a currency

Both are data changes in Supabase Studio (as `service_role`). **Neither needs a
migration.**

**Add one:**

```sql
INSERT INTO public.currencies (code, name_en, minor_units, is_active, sort_order)
VALUES ('XYZ', 'Example Currency', 2, true, 1000)
ON CONFLICT (code) DO UPDATE
  SET name_en = EXCLUDED.name_en, minor_units = EXCLUDED.minor_units;
```

Then add it to the seed in `supabase-migration-p3-currencies-iso4217.sql`
Section 2 and to the `seeded` array in
`supabase-preflight-currencies-2026-09-04.sql`, so a database rebuilt from the
repo matches production.

**Retire one — never `DELETE`:**

```sql
UPDATE public.currencies SET is_active = false, updated_at = now()
 WHERE code = 'XYZ';
```

Existing rows in that currency stay valid and stay readable; the code simply
stops being offered. A `DELETE` is refused by `ON DELETE RESTRICT` the moment
any money row references it, and would be the wrong thing even when it is not.

**Re-running the migration is safe and will not undo a retirement.** The seed's
`ON CONFLICT DO UPDATE` list is `name_en`, `minor_units`, `sort_order` — it
deliberately does **not** include `is_active`, so a re-run cannot silently
re-enable a currency someone disabled by hand.

**What the client offers is still `src/db/types.ts`'s `SUPPORTED_CURRENCIES`**
(AED PKR PHP SAR QAR OMR KWD BHD). Seeding a currency makes the *server* accept
it; the picker does not change until that constant does. That split is
intentional — the server should never be the thing that loses a user's entry.

---

## 5. What is deliberately not seeded

The seed is active **national** currencies only.

| Excluded | Why |
|---|---|
| `XXX`, `XTS` | "No currency" and "reserved for testing". `XXX` is load-bearing: `40-money-integrity.sql` and `93-currencies-iso4217.sql` use it as the sentinel for "a three-letter string is not automatically money". |
| `XAU XAG XPT XPD` | Precious metals. Not money in this product. |
| `XDR XBA XBB XBC XBD XSU XUA` | IMF / settlement units. |
| `BOV CHE CHW CLF COU MXV USN UYI UYW` | Inflation-indexed units of account. Nobody records an udhaar in one. |
| `CUC SLL ZWL MRO STD VEF BYR` | Withdrawn. Their replacements (`SLE ZWG MRU STN VES`/`VED BYN`) are in. |

The four currency-union codes that *are* real money — `XAF XCD XCG XOF XPF` —
are seeded.

---

## 6. Applying it

Production had all 73 earlier `apply-order.txt` files applied as of
2026-09-03, so this is the only pending migration.

1. Run [`supabase-preflight-currencies-2026-09-04.sql`](../supabase-preflight-currencies-2026-09-04.sql)
   in Studio. It is one read-only `SELECT`. **Expect zero rows.**
2. Run [`supabase-migration-p3-currencies-iso4217.sql`](../supabase-migration-p3-currencies-iso4217.sql)
   in Studio, whole file, one paste.
3. Read the V1-V6 output at the bottom: **16 FKs, 0 unvalidated, 0 leftover
   whitelists; 157 rows / 156 active / 16-134-7; V4 returns no rows; all eight
   shipped currencies present; grants are exactly `SELECT` for `anon` and
   `authenticated`.**

**No client deploy is required, and no advisor sweep needs re-running.** The
file creates no function (so `p3-rpc-execute-grants.sql`'s `pg_proc` sweep has
nothing new to find) and its one policy is function-free `USING (true)` (so
`p3-rls-initplan-and-indexes.sql`'s `auth.uid()` sweep has nothing to rewrite).

If something goes wrong, the migration's own commented-out rollback block
restores the sixteen eight-currency CHECKs and drops the table. It is validated
in both branches: with a row already recorded outside the eight it restores the
other fifteen CHECKs, keeps that column's FK, and refuses to drop the table
(guarded — an unguarded `DROP TABLE` there would abort and undo the restore);
with no such row it restores all sixteen and drops `currencies`.
