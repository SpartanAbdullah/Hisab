# Migration data-safety review — the 32 unapplied files

**Date:** 2026-09-03 · **Branch:** `audit-p0-remediation` @ `e54e84f` · **Deployed client:** `main` @ `2248327`
**Companion pre-flight:** [`supabase-preflight-2026-09-03.sql`](../../supabase-preflight-2026-09-03.sql) (repo root)
**Production state evidence:** [`prod-verification-2026-09-03.md`](./prod-verification-2026-09-03.md)

---

## Why this document exists

The founder asked: *"why run all of these, and maybe we will break the existing data — review it once before you ask me to apply."*

Fair question, and the honest answer has two halves.

**On breaking existing data — the risk is low and it is now measured.** Of the 32 files, **28 cannot touch a single existing row.** Four run a backfill at apply time, and every one of them is a narrow, guarded, idempotent `UPDATE` of a column that is either brand-new or provably already correct. Exactly **three statements across all 32 files can abort on existing data**, and the pre-flight counts the offending rows for each. Nothing does a `DELETE` or a `TRUNCATE` of user data at apply time.

**On the real risk — it is not the data, it is the client.** Six of these files change the contract the *currently deployed* app depends on. Applying the SQL and not deploying the branch client in the same window breaks invite-link joins outright and silently corrupts join-by-code. That is the thing to plan around, and §4 spells it out.

One clarification before the detail, because it is the most common source of alarm:

> **DML inside a `$$ … $$` function body does not run when you paste the file.** It runs later, when a user calls that RPC. A raw `grep` for `UPDATE` across these files returns ~120 hits; **fewer than ten of them execute at apply time.** Every count below distinguishes the two.

---

## §0. Scope, and the 41 files you must NOT re-run

`supabase/tests/apply-order.txt` lists **74 lines**. Only the last 32 are pending.

| Lines | What | Action |
|---|---|---|
| 1 | `supabase-schema.sql` (base) | **Already applied. Do not re-run.** |
| 2 | `supabase/tests/prelude-notifications-rls.sql` | **Harness-only. Never apply to production.** |
| 3–42 | The 40 historical migrations | **Already applied** (verified 2026-09-03). **Do not re-run.** |
| 43–74 | **The 32 pending files** | The subject of this review. |

**Why does `apply-order.txt` list all 74 if 41 are done?** Because it is the *harness*'s build script, not a production runbook. `supabase/tests/run.sh` starts a throwaway empty `postgres:15` and builds the schema from zero on every run — it needs the full sequence. Production is not empty. `supabase_migrations.schema_migrations` is empty (everything was hand-applied in Studio), so nothing stops a re-run mechanically; the discipline has to be yours.

**Would re-running the 41 actually hurt?** Mostly no — they are written `IF NOT EXISTS` / `CREATE OR REPLACE` — but at least two would do real damage, and that is reason enough for a hard rule:

- `supabase-migration-audit-p0-...` — n/a, those are pending.
- Re-running `supabase-migration-connections-push-discovery.sql` and its siblings would re-`CREATE OR REPLACE` functions that the pending batch is about to *supersede*, silently reverting fixes if run out of order.
- The `fix-settlement-cancel-reject` alphabetical trap documented at `apply-order.txt:48-51` is exactly this class of accident.

**Rule: start at line 43 (`supabase-migration-audit-p0-currencies.sql`) and go down. Never scroll up.**

---

## §1. Per-file review, in apply order

Legend for **Category**: **(a)** pure additive DDL · **(b)** touches existing objects · **(c)** mutates existing rows at apply time.

---

### 1. `supabase-migration-audit-p0-currencies.sql` (170 lines)

| | |
|---|---|
| **Category** | **(b)** — drops and re-adds CHECK constraints on two live tables |
| **Apply-time DML** | None |
| **Can fail on data** | Yes, in principle — see below |
| **Transaction** | `begin;` :55 → `commit;` :121 |
| **Idempotent** | Yes — discovery loop no-ops, `drop constraint if exists` before each add |
| **Rollback block** | None (verification queries only, :123-170) |
| **Flag-gated** | No |

**The one statement that validates against existing rows:**

```sql
-- :101-103
alter table public.linked_transaction_requests
  add constraint ltr_currency_supported
  check (currency in ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD'));
```
…and the identical `lsr_currency_supported` at :112-114. No `NOT VALID`, so each takes `ACCESS EXCLUSIVE` and scans the table.

**This is a widening, so it is safe by construction.** The live constraint is `check (currency in ('AED','PKR'))` (confirmed in production, `prod-verification-2026-09-03.md:73-78`). Every row that satisfies the old two-value check satisfies the new eight-value one. A violation requires a row holding a ninth currency, which the old constraint made impossible. Pre-flight counts it anyway.

The `DROP` at :86 is dynamic — it discovers the old constraint by *definition* (`ilike '%currency%'` and `not ilike '%BHD%'`) rather than by name, because two competing `create table if not exists` declarations mean the server-generated name is unknowable from the repo (:57-67). Constraints unrelated to currency never match the predicate.

**Verdict: safest file in the batch. This is the one that unbreaks linked udhaar for 6 of your 8 currencies.**

---

### 2. `supabase-migration-audit-p0-loan-concurrency.sql` (207 lines)

| | |
|---|---|
| **Category** | **(a)** — one new function, `apply_loan_remaining_delta(TEXT, NUMERIC, NUMERIC)` :84-141 |
| **Apply-time DML** | None (the `UPDATE public.loans` at :122 is inside the body) |
| **Can fail on data** | None. No `ALTER TABLE` at all. |
| **Drops** | None |
| **Transaction** | `BEGIN;` :78 → `COMMIT;` :146 |
| **Idempotent** | Yes |
| **Rollback block** | None. Reversal = `DROP FUNCTION public.apply_loan_remaining_delta(text,numeric,numeric);` |
| **Flag-gated** | No |

**⚠ This file's ordering constraint is INVERTED, and it is the reason the one-window plan is not optional.** From its own header, :72-76:

> *"the client in this same commit calls the RPC unconditionally for every remaining_amount change. Until this migration is applied, ledger-mode repayments will fail with 'function … does not exist'. That is intentional (fail loud, not silently unlocked) … there is no dual-path fallback."*

Confirmed on the branch: `src/lib/supabaseDb.ts:531` calls `apply_loan_remaining_delta` **ungated**. So this file must land **at or before** the client deploy, never after. Applying it early is harmless (the deployed `main` client never calls it).

**Minor behavioural note:** :124-128 re-derives `loans.status` as `'settled'` or `'active'` only. A loan sitting in some third status value gets rewritten to `'active'` the first time a delta touches it. Worth a glance: `SELECT status, count(*) FROM loans GROUP BY 1;`

---

### 3. `supabase-migration-audit-p0-settlement-row-locks.sql` (900 lines)

| | |
|---|---|
| **Category** | **(b)** — `create or replace` of **two live cross-user money RPCs** |
| **Apply-time DML** | None — all 16 write statements are inside `$$` bodies |
| **Can fail on data** | None. No `ALTER TABLE`, no constraint, no column, no index. |
| **Transaction** | `BEGIN;` :244 → `COMMIT;` :797 |
| **Idempotent** | Yes |
| **Rollback block** | None. Reversal = re-run `supabase-migration-cross-user-account-effects.sql`. |
| **Flag-gated** | No |

**Drops — two, both legacy overloads:**
```sql
-- :250-251
drop function if exists public.accept_linked_request(text);
drop function if exists public.accept_settlement_request(text);
```
Production confirms the 2-arg forms are already live and the 1-arg leftovers are already gone (`prod-verification-2026-09-03.md:90-92`), so **both of these are no-ops on your database.** The replacements at :257 and :536 keep `responder_account_id text default null`, so even a client posting one argument resolves correctly.

**Deployed-client impact: none.** `main` calls both with either 1 or 2 named args (`main:src/lib/supabaseDb.ts:573`, `:692`); the `default null` absorbs both shapes.

What it actually adds is `for update` row locks (:308-313 loans, :318-322 accounts, :577-581, :607-611). Locks **block**, they don't reject — a concurrent writer waits rather than erroring. No new rejection path for any client.

---

### 4. `supabase-migration-audit-p0-kameti-draw.sql` (669 lines) — ⚠ ONE OF TWO FILES THAT MUTATE ROWS

| | |
|---|---|
| **Category** | **(c) MUTATES EXISTING ROWS AT APPLY TIME** |
| **Can fail on data** | None in the constraint sense — but see FREEZES below |
| **Transaction** | **NONE — no `BEGIN;`/`COMMIT;` anywhere in the file** |
| **Idempotent** | Yes (`if not exists`, `or replace`, `drop … if exists`, `draw_scheme is null` guard) |
| **Rollback block** | None, and reversal would need a data step |
| **Flag-gated** | No |

**The apply-time mutation.** A `DO $$ … $$` block — unlike a `CREATE FUNCTION` body — **executes immediately**:

```sql
-- :192-200
do $$
begin
  perform set_config('hisaab.committee_draw', 'on', true);
  update public.committees
     set draw_scheme = 'mulberry32-shuffle-v0'
   where draw_seed is not null
     and draw_scheme is null;
  perform set_config('hisaab.committee_draw', 'off', true);
end $$;
```

Benign: it backfills a brand-new, all-NULL column added two lines earlier (`alter table public.committees add column if not exists draw_scheme text;` :182), guarded so a re-run does nothing. But it is real DML on a live money-adjacent table. Pre-flight reports the row count.

**Two new BEFORE triggers on live tables, and they validate STATE, not deltas.** That distinction matters: a pre-existing row in a disliked shape isn't rejected today, but **refuses every future UPDATE — including a rename.**

`trg_committees_draw_immutable` (:415-417, `BEFORE INSERT OR UPDATE ON public.committees`) raises `42501` when:

| Cite | Condition | Code |
|---|---|---|
| :348-358 | client writes/changes `draw_seed`, `draw_commitment` or `draw_scheme` | `DRAW_FIELDS_ARE_SERVER_ONLY` |
| :362-370 | `drawn_at` or `payout_method` changes on a drawn kameti | `DRAW_LOCKED` |
| :382-392 | flipping `payout_method` → `'ballot'` while members hold slots | `BALLOT_SWITCH_NEEDS_CLEAR_SLOTS` |
| :404-409 | resulting row is `ballot` + `drawn_at IS NOT NULL` + `draw_seed IS NULL` | `BALLOT_DRAW_SERVER_ONLY` |

`trg_committee_members_draw_locked` (:505-507) raises on any INSERT into a drawn kameti (:465-468), any `slot` change (:470-473), and slot-setting on an undrawn ballot kameti (:484-486).

**⚠ Breaks the deployed client.** The file's own evidence (:10-15): `main:src/stores/committeeStore.ts:115-130` *"generated the seed, the commitment AND the slot order on the organiser's own device and wrote them in one plain UPDATE."* That write hits :348-358 and raises. **Any client build older than this commit loses ballot-kameti draws entirely** — and Android users on an old APK stay broken until they update. This is a genuine forced upgrade, not a graceful degrade.

**Two actions before applying:** wrap the file in `BEGIN;` / `COMMIT;` by hand (nothing in it is transaction-hostile), and read the three FREEZES counts in the pre-flight. The file's own §5.7/§5.9 advice for violating rows is *"delete the row or relabel it 'fixed'"* — i.e. it assumes they are test data. Verify that on production.

---

### 5. `supabase-migration-audit-p0-group-ledger-integrity.sql` (786 lines) — ⚠ BROADEST BLAST RADIUS

| | |
|---|---|
| **Category** | **(b)** — rewrites the RLS policy set on two live money tables |
| **Apply-time DML** | None on data rows. But the `DO` block at :538-572 **executes DDL at apply time.** |
| **Can fail on data** | None. No `ALTER TABLE`, no constraint, no column, no index. |
| **Transaction** | `BEGIN;` :227 → `COMMIT;` :574 |
| **Idempotent** | Yes |
| **Rollback block** | None — and see the warning below about why that matters here |
| **Flag-gated** | No |

**12 `DROP POLICY` + 2 `DROP TRIGGER`.** Most are rename-and-recreate with an identical predicate. Four are genuine removals:

| Cite | Dropped | Replaced by | Narrower? |
|---|---|---|---|
| :237 | `"Users can manage own settlements"` (`FOR ALL`) | split into SELECT :295 / INSERT :304 / UPDATE :317 — **no DELETE** | **Yes.** This is the audit C4 fix (production still has it: `prod-verification:59-61`). |
| :275 | `"Expense creators can update their shared group expenses"` | :277-286, adds `AND is_group_member(...)` | **Yes.** An ex-member can no longer edit or soft-delete their own history. |
| :290 | `"Expense creators can delete their shared group expenses"` | **nothing** | **Yes — total removal of hard DELETE.** |
| :329 | `"Connected members can delete shared group settlements"` | **nothing** | **Yes — total removal.** |

**⚠ The unbounded sweep at :559-569 — capture the pre-state first.**

```sql
FOR r IN SELECT policyname FROM pg_policies
          WHERE schemaname='public' AND tablename=v_table
            AND permissive='PERMISSIVE'
            AND NOT (policyname = ANY (v_expected))
LOOP
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, v_table);
```

This drops **every permissive policy on `group_expenses` and `group_settlements` that is not one of six allowlisted names** — including anything hand-created in Studio that this repo has never seen. Its justification (:530-535) is that production has 40+ hand-applied migrations with no ledger. The drop list survives only as a session `RAISE NOTICE`, so **if you don't capture it, it is unrecoverable.** Run and save this first:

```sql
SELECT tablename, policyname, permissive, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname='public' AND tablename IN ('group_expenses','group_settlements')
 ORDER BY 1,2;
```

Restrictive policies are exempt (:564), so the `"Active profiles only"` set survives.

**Deployed-client impact — two silent behaviour changes.** `main`'s `groupExpensesDb.deleteByGroup` (`main:src/lib/supabaseDb.ts:1059`) and `groupSettlementsDb.deleteByGroup` (`:1129`) are hard `DELETE`s. After :290/:329 they affect **0 rows and report success**, leaving orphaned ledger rows behind a deleted group. This is deliberate — file #9 depends on exactly this behaviour — but it is a silent no-op on the live client. See §4.

---

### 6. `supabase-migration-audit-p0-notifications.sql` (675 lines)

| | |
|---|---|
| **Category** | **(b)** — adds columns to `notifications`, drops two INSERT policies |
| **Apply-time DML** | None |
| **Transaction** | `BEGIN;` :90 → `COMMIT;` :561 |
| **Idempotent** | Yes |
| **Rollback block** | None |
| **Flag-gated** | No |

**Schema changes — none can fail:**
```sql
-- :96-101
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS template TEXT;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
```
`NOT NULL DEFAULT` on PG11+ is a metadata-only fast default — no table rewrite. The FK is on a new all-NULL column, so validation is trivially satisfied (it does take a brief `SHARE ROW EXCLUSIVE` on `auth.users`).

The CHECK is explicitly `NOT VALID`, so it **cannot fail**:
```sql
-- :126-128
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_text_length_check
  CHECK (length(title) <= 200 AND length(body) <= 1000) NOT VALID;
```

**⚠ Deployed-client impact — client-side notification fan-out stops.**
```sql
-- :142-146
DROP POLICY IF EXISTS "Users can insert notifications for self or fellow members" ON public.notifications;
CREATE POLICY "Users can insert own notifications"
  ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
-- :153
DROP POLICY IF EXISTS "Connected members can create group events" ON public.group_events;
```
`main`'s `fanOutGroupUpdate` (`main:src/stores/splitStore.ts:244-274`) writes `notifications` rows **for other users** and inserts `group_events` directly. Both writes are wrapped in `try/catch` + `console.error` and are explicitly non-fatal — so `main` users **silently stop generating group notifications and activity entries** until the new client ships. Degradation, not breakage. This is the audit C7 phishing fix (`prod-verification:62-64`).

---

### 7. `supabase-migration-audit-p0-group-concurrency.sql` (540 lines) — ⚠ MUTATES ROWS (provably a no-op)

| | |
|---|---|
| **Category** | **(c)** on paper; a **provable no-op** in practice |
| **Transaction** | `BEGIN;` :61 → `COMMIT;` :468 |
| **Idempotent** | Yes |
| **Rollback block** | None |
| **Flag-gated** | No |

**The mutation:**
```sql
-- :68
UPDATE public.group_expenses SET version = 1 WHERE version IS NULL;
```

**This matches zero rows, provably.** `supabase-schema.sql:308` declares `ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1` on `group_expenses` — the column has been `NOT NULL` since the base schema, so `version IS NULL` is unsatisfiable. The pre-flight verifies this; a non-zero result would mean the schema has drifted and this review's conclusion is void.

**⚠ New BEFORE UPDATE trigger — check your client.**
```sql
-- :114-117
DROP TRIGGER IF EXISTS group_expenses_version_guard ON public.group_expenses;
CREATE TRIGGER group_expenses_version_guard
  BEFORE UPDATE ON public.group_expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_expenses_version_guard();
```
It raises `40001` if a core-field edit (`description`/`amount`/`paid_by`/`splits`/`split_type`/`category`) does not carry `OLD.version + 1` (:105-108).

**Good news: `main` already sets `version`.** `main:src/lib/supabaseDb.ts:1021` includes `version` in the group-expense UPDATE column list. Soft-delete and reconcile flips deliberately do *not* bump the version (:102-104), matching what `main` sends. **No breakage.** One gap worth knowing: `main:src/lib/dataExport.ts:218` restores expenses **without** `version` — that is an INSERT, not an UPDATE, so the trigger (UPDATE-only) never sees it.

---

### 8. `supabase-migration-audit-p0-account-deletion.sql` (920 lines)

| | |
|---|---|
| **Category** | **(b)** — FK rewrite on two live tables |
| **Apply-time DML** | None (all writes are inside `delete_current_user`'s body) |
| **Transaction** | `BEGIN;` :401 → `COMMIT;` :819 |
| **Idempotent** | Yes (catalog-driven, re-run is a no-op) |
| **Rollback block** | None |
| **Flag-gated** | No |

**The two statements that validate against existing rows** (inside the `DO` at :410-461, so they execute at apply time):
```sql
-- :424
EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id DROP NOT NULL', v_table);
-- :452
EXECUTE format(
  'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL',
  v_table, v_conname);
```
for `v_table ∈ {group_expenses, group_settlements}`.

`DROP NOT NULL` can never fail. **`ADD CONSTRAINT … FOREIGN KEY` is not `NOT VALID`, so it scans every row against `auth.users` and an orphan aborts the whole file.** Pre-flight counts orphans on both tables. Cost: `ACCESS EXCLUSIVE` on the table plus `SHARE ROW EXCLUSIVE` on `auth.users` (briefly blocks signup/login writes).

**One `DROP` of a live object:**
```sql
-- :694
DROP FUNCTION IF EXISTS public.soft_delete_current_user();
```
Neither `main` nor the branch client calls it — verified. Safe.

`delete_current_user()` is `CREATE OR REPLACE` with an unchanged zero-arg signature (:555), so `main:src/lib/supabaseDb.ts:1363` keeps working. Its *semantics* change (soft delete → `DELETE FROM auth.users` at :678 with ledger anonymisation via the new SET NULL FKs) — that is the intended fix, and it only fires when a user deletes their account.

---

### 9. `supabase-migration-audit-p0-group-deletion-guard.sql` (1123 lines)

| | |
|---|---|
| **Category** | **(b)** — 2 new columns + 1 index on `split_groups`, 5 new triggers on 4 live tables |
| **Apply-time DML** | None |
| **Transaction** | `BEGIN;` :344 → `COMMIT;` :987 |
| **Idempotent** | Yes (validated 3× in the harness, :339-341) |
| **Rollback block** | None |
| **Flag-gated** | No |

**Schema — cannot fail on data, but locks:**
```sql
-- :558-561
ALTER TABLE public.split_groups ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE public.split_groups ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
-- :569-571
CREATE INDEX IF NOT EXISTS idx_split_groups_archived ON public.split_groups (archived_at) WHERE archived_at IS NOT NULL;
```
Both columns are nullable with no default. The FK validates trivially (all NULL). The index is correctly **not** `CONCURRENTLY` (it is inside a transaction) and takes `SHARE` on `split_groups` while building — a small table.

**Hard prerequisite, programmatically enforced** (:365-370): the file aborts with `PRECONDITION FAILED` if file #5 (`group-ledger-integrity`) has not been applied. Rolls back cleanly with nothing left behind. **The ordering is not advisory — it is checked.**

**Five new triggers. Only one changes behaviour on day one:**

| Trigger / table | Cite | Live impact |
|---|---|---|
| `split_groups_guard_delete` `BEFORE DELETE` | :548-550 | **ACTIVE IMMEDIATELY.** Blocks group deletion when other connected members exist (`GROUP_HAS_OTHER_MEMBERS` :508) or balances are outstanding (`GROUP_HAS_OUTSTANDING_BALANCES` :533). **`main:src/pages/GroupDetailPage.tsx:381-395` has no try/catch** — the owner gets a raw PostgREST error string. The file admits this at :252-259. |
| `split_groups_protect_archive` `BEFORE UPDATE` | :598-600 | Inert — the columns are new and all-NULL; full-row upserts compare equal. |
| `group_expenses_block_when_archived` | :664-666 | Dormant until someone calls `archive_group`. |
| `group_settlements_block_when_archived` | :669-671 | Dormant. |
| `group_members_block_join_archived` | :712-714 | Dormant. |

Residual risk the file names itself (:281-284): the guard cannot bind `service_role`, so a manual Studio `DELETE` on `split_groups` still cascades and destroys every member's ledger. Treat that as a privileged operation.

---

### 10. `supabase-migration-audit-p0-join-abuse-limits.sql` (392 lines) — ⚠ MUTATES ROWS

| | |
|---|---|
| **Category** | **(c) MUTATES EXISTING ROWS AT APPLY TIME** |
| **Transaction** | `BEGIN;` :68 → `COMMIT;` :320 |
| **Idempotent** | Yes |
| **Rollback block** | None |
| **Flag-gated** | No |

**The mutation:**
```sql
-- :112-120
ALTER TABLE public.split_groups
  ADD COLUMN IF NOT EXISTS join_code_expires_at TIMESTAMPTZ;

UPDATE public.split_groups
   SET join_code_expires_at = now() + INTERVAL '14 days'
 WHERE join_code IS NOT NULL
   AND join_code_expires_at IS NULL;
```
The column is created in the same file, so on production **every group holding a join code is touched.** Effect: every currently-immortal join code now expires 14 days from apply time. That is the intended fix, and it is a real product behaviour change worth stating out loud to users. Pre-flight reports the count.

**⚠ SOFT BREAK of the deployed client — the return type changes.**
```sql
-- :158-160
DROP FUNCTION IF EXISTS public.join_group_by_code(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.join_group_by_code(TEXT);
```
recreated at :169 with the **same argument names** but `RETURNS JSONB` instead of `RETURNS TABLE(...)`. `main:src/lib/supabaseDb.ts:1417-1421` does `data[0].group_id` on what is now a bare object → `undefined`. **Join-by-code is silently corrupted, not merely failed** — it produces a broken group/member id rather than an error. See §4; this is the second-worst client coupling in the batch.

```sql
-- :318
DROP FUNCTION IF EXISTS public.lookup_profile_by_public_code(TEXT);
```
Already absent from production (`prod-verification:70-72`), and `main`'s `profilesDb.findByPublicCode` already returns `null` on the error path. No new damage.

---

### 11. `supabase-migration-audit-p0-consent-guards.sql` (2108 lines) — ⚠ MUTATES ROWS + HARD CLIENT BREAK

| | |
|---|---|
| **Category** | **(c) MUTATES EXISTING ROWS AT APPLY TIME** |
| **Transaction** | `BEGIN;` :254 → `COMMIT;` :1630 |
| **Idempotent** | Yes |
| **Rollback block** | None |
| **Flag-gated** | No |

**The mutation:**
```sql
-- :1441-1445
UPDATE public.group_invites
   SET expires_at = now() + INTERVAL '14 days'
 WHERE expires_at IS NULL
   AND revoked_at IS NULL
   AND accepted_at IS NULL;
```
`main:src/stores/splitStore.ts:573` writes `expiresAt: null`, and the old `accept_group_invite` treated NULL as "never expires" — so **every invite URL ever generated is still redeemable today.** This gives each one 14 more days and then closes it. Intended; a real behaviour change. Pre-flight counts them.

**The guarded unique index — it degrades, it does not block:**
```sql
-- :993-999
IF v_dupes > 0 THEN
  RAISE WARNING 'group_members holds % (group_id, profile_id) pair(s) with duplicate rows — unique index NOT created. …';
ELSE
  CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_profile_uniq
    ON public.group_members(group_id, profile_id)
    WHERE profile_id IS NOT NULL;
END IF;
```
Good design — duplicates cannot abort the migration. But the failure is a `WARNING` in the Studio output, which is easy to scroll past. **Read the pre-flight count; if it is non-zero, you silently ship without the structural backstop.**

**⚠ Column-privilege change on `group_invites` — this is the C6 fix and it BREAKS the live client:**
```sql
-- :1407-1416
REVOKE SELECT ON public.group_invites FROM authenticated;
REVOKE SELECT ON public.group_invites FROM PUBLIC;
REVOKE ALL    ON public.group_invites FROM anon;
GRANT SELECT (
  id, group_id, created_by, linked_member_id,
  expires_at, revoked_at, accepted_by, accepted_at, created_at
) ON public.group_invites TO authenticated;
```
`token_hash` is deliberately excluded. **`main` reads it:** `main:src/lib/supabaseDb.ts:1230` does `select('*')` filtered `.eq('token_hash', tokenHash)`, and `:1239` does `select('*')` by `group_id`. Under column-level grants, PostgREST's `select=*` expands to all columns → `42501 permission denied`. The invite-preview and invite-list paths fail for anyone still on `main`.

**⚠ HARD BREAK — `accept_group_invite` signature change:**
```sql
-- :1511
DROP FUNCTION IF EXISTS public.accept_group_invite(TEXT, TEXT);
```
recreated at :1520 as `accept_group_invite(p_invite_token TEXT, p_display_name TEXT) RETURNS JSONB`. `main:src/lib/supabaseDb.ts:1429` sends `{ p_invite_token_hash, p_display_name }`. supabase-js sends **named** arguments, so this is `PGRST202 function not found`. The return type also flips `TABLE` → `JSONB`, which `main`'s `data[0]` parse cannot read either. **Invite-link joins die outright for every user still on `main`.** This is the single hardest coupling in the batch.

---

### 12. `supabase-migration-p1-app-config.sql` (265 lines)

| | |
|---|---|
| **Category** | **(a)** — one new table, `app_config` |
| **Apply-time DML** | One `INSERT` into its **own new table**, :190-195, `on conflict (id) do nothing` |
| **Can fail on data** | None — all three CHECKs (:101, :116, :129) are on a brand-new empty table |
| **Transaction** | **NONE — no `BEGIN;`/`COMMIT;`** |
| **Idempotent** | Yes |
| **Rollback block** | None |
| **Flag-gated** | No |

Seeds `('default', '1.0.0', 1, null, null)` — matching `package.json` and `versionCode 1` — so **the version gate starts inert**. The `on conflict do nothing` means a re-run never stomps a floor you raised by hand during an incident. RLS on + forced, one `SELECT` policy `TO anon, authenticated USING (true)` (needed because the version gate sits above the auth gate). No write grant to any client role.

---

### 13. `supabase-migration-p1-profile-lang.sql` (170 lines)

| | |
|---|---|
| **Category** | **(b)** — one column on `profiles` |
| **Apply-time DML** | None |
| **Transaction** | `begin;` :73 → `commit;` :107 |
| **Idempotent** | Yes |
| **Rollback block** | **Yes — :166-167, commented out, DDL-only** (`drop constraint`, `drop column`). A true reversal here, since the column's data is entirely derived. |
| **Flag-gated** | No |

```sql
-- :82-83
alter table public.profiles
  add column if not exists lang text not null default 'ur';
-- :95-96 (guarded)
alter table public.profiles
  add constraint profiles_lang_check check (lang in ('ur', 'en'));
```
`NOT NULL DEFAULT` is a PG11+ fast default — metadata only, **no table rewrite**. Every existing row is backfilled to `'ur'` by the catalog default, so the CHECK cannot fail. Users who chose `'en'` overwrite it on next app boot (`App.tsx reconcileProfileLang`).

**Cannot fail on data. Nothing to pre-flight.**

---

### 14. `supabase-migration-p1-group-preview.sql` (299 lines)

| | |
|---|---|
| **Category** | **(a)** — one new function, `preview_group_by_code` |
| **Apply-time DML** | None |
| **Can fail on data** | None. :117 `ALTER TABLE public.split_groups ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;` restates file #9's column — a no-op once that is applied. |
| **Drops** | :127 `DROP FUNCTION IF EXISTS public.preview_group_by_code(TEXT);` — its own object |
| **Transaction** | `BEGIN;` :91 → `COMMIT;` :232 |
| **Rollback block** | None |
| **Flag-gated** | No |

`main` does not call it. The branch client does (`:2257`) but swallows a missing-function error (`:2254`), so it degrades rather than fails. **Zero risk.**

---

### 15. `supabase-migration-p1-money-bounds.sql` (802 lines) — the biggest constraint surface, and it cannot fail

| | |
|---|---|
| **Category** | **(b)** — ~34 CHECK constraints across 20 live tables + 1 new trigger |
| **Apply-time DML** | None |
| **Transaction** | `BEGIN;` :188 → `COMMIT;` :553 |
| **Idempotent** | Yes |
| **Rollback block** | None |
| **Flag-gated** | No |

**Why 34 new constraints on live money tables cannot break your data.** Every one goes through one helper (:191-224):

```sql
-- :211-222
EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', p_table, p_name);
EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s) NOT VALID',
               p_table, p_name, p_expr);
BEGIN
  EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', p_table, p_name);
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'p1-money-bounds: % on public.% left NOT VALID — existing rows violate it. …', …;
END;
```

**`NOT VALID` first, then a `VALIDATE` wrapped in an exception handler that downgrades to a `WARNING`.** So: the migration always succeeds; a constraint whose table holds violating rows lands `NOT VALID` (still enforced on every future INSERT/UPDATE, just not retroactively) and names itself in the output. This is the right pattern and it is why this file is `DEGRADES`, never `BLOCKS`.

The pre-flight enumerates **all 34** so you know before you run which ones will land dirty. Coverage: 14 currency whitelists (§2a), then amount/rate bounds on `transactions`, `accounts`, `loans`, `emi_schedules`, `goals`, `upcoming_expenses`, `group_expenses`, `group_settlements`, `linked_*_requests`, `committees`, `investment_trades`, `investment_prices`, `budgets`, `recurring_transactions`, `remittances` (§2b–§2m). `MAX_MONEY = 1e12`.

**⚠ The one thing to look at — the splits trigger FREEZES rows.**
```sql
-- :545-548
DROP TRIGGER IF EXISTS group_expenses_validate_split_amounts ON public.group_expenses;
CREATE TRIGGER group_expenses_validate_split_amounts
  BEFORE INSERT OR UPDATE ON public.group_expenses …
```
It short-circuits when `amount`/`splits`/`group_id` are unchanged (:461-467), so metadata edits, reconcile flips and soft-deletes stay free — historical rows are not touched at apply time. But an existing expense whose splits don't sum to its amount within 0.01 (:534-538), holds a non-numeric share (:487-495), or names a member id absent from its group (:513-525) **can never have its amount or splits edited again by any client.** Three pre-flight rows count exactly these.

---

### 16. `supabase-migration-p2-trust-safety.sql` (2793 lines) — ⚠ THE ONLY IRREVERSIBLE MUTATION

| | |
|---|---|
| **Category** | **(c) MUTATES EXISTING ROWS AT APPLY TIME — and one of them cannot be undone** |
| **Transaction** | `BEGIN;` :365 → `COMMIT;` :2629 |
| **Idempotent** | Yes (the backfill is `WHERE`-guarded and the plaintext is gone after run 1) |
| **Rollback block** | None |
| **Flag-gated** | No |

**The irreversible step (:2049-2091, inside a `DO` block, so it runs at apply time):**
```sql
-- :2068-2071   1. hash every live plaintext token so shared links keep working
UPDATE public.committees
   SET share_token_hash = public.hash_witness_token(share_token)
 WHERE share_token IS NOT NULL AND share_token_hash IS NULL;

-- :2075-2078   2. give every migrated link the 90-day clock a fresh one gets
UPDATE public.committees
   SET witness_token_expires_at = now() + INTERVAL '90 days'
 WHERE share_token_hash IS NOT NULL AND witness_token_expires_at IS NULL;

-- :2082-2084   3. destroy the plaintext — THIS IS THE M19 FIX
UPDATE public.committees
   SET share_token = NULL
 WHERE share_token IS NOT NULL;
```

Step 3 is a **one-way door**. After it, `committees.share_token` is gone and no rollback can restore it. What survives: every already-shared witness link keeps working (the lookup hashes what the visitor presents) and gets 90 days. What is lost: the client's ability to re-read the raw token — which is the entire point of the fix. Pre-flight reports how many kametis are affected.

**Structurally cannot collide.** The new `CREATE UNIQUE INDEX IF NOT EXISTS committees_share_token_hash_uidx` (:1992) is created on an all-NULL column, and production already carries a UNIQUE index on the plaintext column (`committees_share_token_uidx`, dropped only afterwards at :2096) — so duplicate plaintext tokens, and therefore duplicate hashes, are impossible. Verified empirically in the harness.

**Other schema changes — all additive, none can fail:**
```sql
-- :1877-1880
ALTER TABLE public.linked_transaction_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE public.linked_settlement_requests  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
-- :1985-1988
ALTER TABLE public.committees
  ADD COLUMN IF NOT EXISTS share_token_hash          TEXT,
  ADD COLUMN IF NOT EXISTS witness_token_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS witness_token_revoked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS witness_initials_only     BOOLEAN NOT NULL DEFAULT false;
```
Plus two new tables (`blocks` :394, `reports` :460) and a `CREATE OR REPLACE` of `delete_current_user` (:2481) that supersedes file #8's — which is exactly why apply order matters here.

---

### 17. `supabase-migration-p2-notification-maturity.sql` (1380 lines) — ⚠ MUTATES ROWS (whole table)

| | |
|---|---|
| **Category** | **(c) MUTATES EXISTING ROWS AT APPLY TIME** |
| **Transaction** | `BEGIN;` :164 → `COMMIT;` :1157 |
| **Idempotent** | Yes (`WHERE channel_id IS NULL`) |
| **Rollback block** | None |
| **Flag-gated** | No |

**The mutation — the largest by row count in the batch:**
```sql
-- :435-439
UPDATE public.notifications n
   SET channel_id   = public.notification_channel_for(n.type, n.template),
       href         = public.notification_href_for(n.type, n.group_id, n.template, n.params),
       collapse_key = public.notification_collapse_key_for(n.type, n.group_id, n.template, n.params, n.id)
 WHERE n.channel_id IS NULL;
```
`channel_id` is added by this same file (:173), so on production **this rewrites every row in `notifications`.** Three columns filled from pure functions of columns already on the row — no data is lost, nothing is deleted, and re-running is a no-op. But it is a full-table `UPDATE`, so it doubles the table's heap temporarily and holds a long `ROW EXCLUSIVE` inside the transaction. **Pre-flight reports the row count; if `notifications` is large, consider running the whole file off-peak.** This is also the file that finally adds pruning (:1084 `prune_notifications`, 90 days read / 180 unread) — the table has had no TTL until now.

Also: `CREATE UNIQUE INDEX notification_prefs_user_scope_uidx` (:214) is on a brand-new table. Cannot fail.

---

### 18. `supabase-migration-p3-khata-link.sql` (965 lines)

| | |
|---|---|
| **Category** | **(a)** — two new tables (`khata_links` :262, `khata_link_lookups` :381) + 6 new functions |
| **Apply-time DML** | None |
| **Can fail on data** | None — both `CREATE UNIQUE INDEX` (:285, :291) are on new empty tables |
| **Transaction** | `BEGIN;` :190 → `COMMIT;` :806 |
| **Rollback block** | None |
| **Flag-gated** | No — but `main` cannot see it; the branch client calls it at `:5206`, `:5222`, `:5248` |

`get_khata_view` is granted to `anon` (:801) by design — the public `/khata/:token` page, same capability-URL pattern as the kameti witness link. **Zero data risk.**

---

### 19–23. The five `p3-atomic-*` files — all inert, all flag-gated OFF

`p3-atomic-transfer` (664) · `p3-atomic-repayment` (955) · `p3-atomic-loan-create` (1149) · `p3-atomic-goal-and-card` (1916) · `p3-atomic-investments-and-single-leg` (1529)

| | |
|---|---|
| **Category** | **(a) pure additive DDL — all five** |
| **Apply-time DML** | **None in any of the five.** Every `UPDATE`/`INSERT` is inside a `$$` function body. |
| **Can fail on data** | **None in any of the five.** No `ADD CONSTRAINT`, no `SET NOT NULL`, no UNIQUE, no type change, no FK, no `ALTER TABLE` at all. |
| **Drops** | **None in any of the five.** All eight function names are new — they appear nowhere in the repo outside these files, the harness tests, and `p3-rpc-execute-grants`. |
| **Transaction** | `BEGIN;`/`COMMIT;` at :217/:513, :298/:729, :328/:916, :482/:1629, :377/:1255 |
| **Idempotent** | Yes (`CREATE OR REPLACE`) |
| **Rollback block** | **None in any of the five.** Reversal = hand-written `DROP FUNCTION` using each file's own `REVOKE` argument list. |

**Flag-gating — all seven flags confirmed in code, all default OFF:**

| Flag | Client gate | RPC |
|---|---|---|
| `VITE_ATOMIC_TRANSFER` | `transactionStore.ts:466` | `transfer_between_accounts` |
| `VITE_ATOMIC_REPAYMENT` | `:710` | `record_loan_repayment` |
| `VITE_ATOMIC_LOAN_CREATE` | `:959` | `create_loan_with_leg` |
| `VITE_ATOMIC_GOAL` | `:1280` | `contribute_to_goal`, `apply_goal_saved_delta` |
| `VITE_ATOMIC_CARD_BILL` | `:1464` | `pay_card_bill` |
| `VITE_ATOMIC_SINGLE_LEG` | `:1753` | `record_single_leg_entry` |
| `VITE_ATOMIC_INVEST` | `:1754` | `record_investment_trade` |

All use the strict `import.meta.env.VITE_X === 'true'` form, so absent/empty/`"false"` is off. `.env.example` lists all seven with empty values; `.env` contains none. `main` calls **none** of the eight RPCs — `git grep` on `main:src/` returns zero hits.

**Three things to know before applying these five:**

1. **Section 0 preconditions abort cleanly.** `p3-atomic-goal-and-card` requires `accounts.metadata` (:427) and `goals.stored_in_account_id` (:430). `p3-atomic-investments-and-single-leg` requires `investment_markets` / `investment_trades` / `transactions.related_investment_id` (:316-326) — production has these (`prod-verification:93-95`). A missing precondition aborts before any DDL and writes nothing.
2. **The post-`COMMIT` verification blocks can be very slow.** `p3-atomic-goal-and-card` V8 (:1829-1847) self-joins `transactions` on `r.notes LIKE '%' || t.id || '%'` — an unindexable substring join, effectively O(n²). **Skip it or run it in a separate tab on apply day.** `p3-atomic-repayment` V6/V7 (:859-894) are also heavy. All are read-only.
3. **One absolute balance write exists**, `p3-atomic-investments-and-single-leg:606` `UPDATE public.accounts SET balance = p_target_balance` (the adjustment path). Every other path accumulates a delta. It is guarded by `FOR UPDATE` (:483-487) plus a CAS (:532), so it is safe — but it is the one statement that overwrites rather than adds. Runtime only.

**Verdict: the five largest files in the batch are the five safest. Applying them changes nothing until you flip a flag.**

---

### 24–25. `p2-analytics-aggregates` (445) and `p2-analytics-aggregates-2` (539)

| | |
|---|---|
| **Category** | **(a) pure additive DDL** — three new functions |
| **Apply-time DML** | None |
| **Can fail on data** | None |
| **Drops** | Own objects only: `:194`, and `:217`/`:294` in the sequel — `DROP FUNCTION IF EXISTS` before create |
| **Transaction** | `BEGIN;` :164/:182 → `COMMIT;` :307/:370 |
| **Rollback block** | **Yes — :320-327 and :395-406, DDL-only.** Correct: the files create no data. |
| **Flag-gated** | **Yes — `VITE_ANALYTICS_RPC`**, `AnalyticsPage.tsx:62`, default off, and the client fails soft to the old path even when on. |

**The one production-impact statement in either file:**
```sql
-- p2-analytics-aggregates:299-305
CREATE INDEX IF NOT EXISTS idx_transactions_user_created
  ON public.transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_analytics_summary
  ON public.transactions (user_id, created_at)
  INCLUDE (currency, type, category, amount) WHERE deleted_at IS NULL;
```
Two **non-concurrent** index builds inside a transaction, each taking `SHARE` on `transactions` — **blocking all writes to your hottest money table for the duration of the build.** Correct choice given the transaction wrapper, but it sizes the window. The first restates an index owned by `performance-indexes.sql`, so on production it is likely a no-op `NOTICE`. Pre-flight reports the `transactions` row count. The sequel adds no index (:385-388, explicitly declined).

---

### 26. `supabase-migration-p2-guest-members.sql` (1121 lines)

| | |
|---|---|
| **Category** | **(b)** — one generated column on `group_members` + 1 new table + 2 new triggers |
| **Apply-time DML** | None |
| **Transaction** | `BEGIN;` :173 → `COMMIT;` :947 |
| **Idempotent** | Yes |
| **Rollback block** | None |
| **Flag-gated** | No |

**The one locking statement — the file flags it itself at :189:**
```sql
-- :193-195
ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS is_guest BOOLEAN
    GENERATED ALWAYS AS (profile_id IS NULL AND status <> 'left') STORED;
```
A `STORED` generated column forces a **full table rewrite under `ACCESS EXCLUSIVE`**. It cannot fail on data (the expression is total), but it locks `group_members` for the rewrite. Pre-flight reports the row count — this is a small table, so expect milliseconds. Being generated, no client can ever write it; PostgREST rejects an INSERT that names it, and `groupMembersDb.add`/`addMany`/`update` all build explicit column lists.

It also `CREATE OR REPLACE`s `join_group_by_code` (:811) — the third file in the batch to do so. Apply order is what makes the last one win.

---

### 27. `supabase-migration-p2-realtime-broadcast.sql` (446 lines)

| | |
|---|---|
| **Category** | **(b)** — nine new AFTER STATEMENT triggers on `transactions`, `accounts`, `loans` + one policy on `realtime.messages` |
| **Apply-time DML** | None |
| **Can fail on data** | None. Failure modes are environmental (missing `realtime` schema, insufficient ownership) and all are caught → `RAISE WARNING`, migration continues (:305-309). |
| **Drops** | Own triggers only, :228/:237/:246 (dynamic, 9 drops / 9 creates) |
| **Transaction** | `begin;` :122 → `commit;` :313 |
| **Rollback block** | **Yes — :315-331, DDL-only** |
| **Flag-gated** | **Partially — see below** |

**Cannot abort a user write.** The trigger body is wrapped in `begin … exception when others then raise warning …` (:155-194) and always `return null` (:196), plus a runtime capability guard at :151-153.

**⚠ The flag gates the client, not the server.** `VITE_REALTIME_BROADCAST` (`src/lib/realtime.ts:101`, default off) gates only the **subscription**. The nine triggers fire and write to `realtime.messages` from the moment the file is applied — the header says so at :62-65. Cost: one small insert per money statement per affected user, **plus** materialising transition tables (`REFERENCING NEW TABLE AS new_rows`) on every INSERT/UPDATE/DELETE of `transactions`/`accounts`/`loans`. Not free on bulk updates. "Inert until the flag flips" is true of the feature, not of the write path.

---

### 28. `supabase-migration-p2-kameti-editing.sql` (861 lines)

| | |
|---|---|
| **Category** | **(b)** — `ALTER TABLE committees` + a **third** BEFORE trigger on it |
| **Apply-time DML** | None |
| **Can fail on data** | None. :211 `alter table public.committees add column if not exists emoji text;` — nullable, no default, catalog-only. |
| **Drops** | :285 `drop trigger if exists trg_committees_edit_guard on public.committees;` — its own object, the only DROP |
| **Transaction** | **NONE — no `BEGIN;`/`COMMIT;`** |
| **Idempotent** | Yes |
| **Rollback block** | **None** |
| **Flag-gated** | **No** |

Yes, this is a **third** `BEFORE UPDATE` trigger on `committees` (:285-288), composing with `trg_committees_draw_immutable` (file #4) and `trg_committees_witness_token_guard` (file #16). It replaces neither. All three are pure validators returning `NEW` unchanged, so firing order only decides which refusal message surfaces first.

**⚠ Breaks a deployed-client path, with no flag.** From apply time, any raw `UPDATE public.committees` moving `member_count`/`total_rounds` raises `42501` (:249-253), and moving `currency`/`contribution_amount`/`cadence`/`start_date`/`payout_method` on a drawn or collecting kameti raises `42501` (:269-280). **`main:src/stores/committeeStore.ts:434` does exactly that:** `await committeesDb.update(committeeId, { payoutMethod: 'fixed' })` in `setFixedOrder`. The branch client pre-checks the same rule client-side first; a production build predating that pre-check gets a raw 403.

Pre-flight includes the file's own drift detector (its §6.4): kametis whose `member_count` or `total_rounds` already disagrees with the roster can no longer be repaired by a client UPDATE after this — only via the new `update_committee` RPC.

**Recommend wrapping this file in `BEGIN;`/`COMMIT;` by hand.** Nothing in it is transaction-hostile, and a half-applied state (guard armed, `update_committee` absent) is the worst combination: raw edits blocked, RPC unavailable.

---

### 29. `supabase-migration-p2-edit-history.sql` (697 lines) — ⚠ HIGHEST-CONSEQUENCE ITEM IN THE BATCH

| | |
|---|---|
| **Category** | **(b)** — new table + **four AFTER ROW triggers on four live money tables** |
| **Apply-time DML** | None |
| **Transaction** | `BEGIN;` :147 → `COMMIT;` :555 |
| **Idempotent** | Yes |
| **Rollback block** | **Yes — :686-696, DDL-only.** `DROP TABLE record_edits` is deliberately left commented (:694-695) so a rollback preserves collected history. |
| **Flag-gated** | **No, and there is no kill switch for the triggers** short of dropping them. |

**Three CHECK constraints added WITHOUT `NOT VALID`:**
```sql
-- :180-195
ALTER TABLE public.record_edits DROP CONSTRAINT IF EXISTS record_edits_action_check;
ALTER TABLE public.record_edits
  ADD CONSTRAINT record_edits_action_check CHECK (action IN ('insert','update','delete','soft_delete'));
… ADD CONSTRAINT record_edits_actor_kind_check CHECK (actor_kind IN ('user','system'));
… ADD CONSTRAINT record_edits_changed_object  CHECK (jsonb_typeof(changed) = 'object');
```
On a first application these validate a **brand-new empty table** — zero risk. `record_edits` does not exist in production (`prod-verification:14-16`), so this is a first application. No pre-flight row needed.

**The four triggers:**
```sql
-- :446-476
CREATE TRIGGER group_expenses_record_edits    AFTER INSERT OR UPDATE ON public.group_expenses    FOR EACH ROW EXECUTE FUNCTION public.tg_record_edits('amount','description','date','notes','paid_by','split_type','splits');
CREATE TRIGGER group_settlements_record_edits AFTER INSERT OR UPDATE ON public.group_settlements FOR EACH ROW EXECUTE FUNCTION public.tg_record_edits('amount','date','note','from_member','to_member');
CREATE TRIGGER loans_record_edits             AFTER INSERT OR UPDATE ON public.loans             FOR EACH ROW EXECUTE FUNCTION public.tg_record_edits('person_name','person_id','total_amount','remaining_amount','currency','status','notes');
CREATE TRIGGER transactions_record_edits      AFTER INSERT OR UPDATE ON public.transactions      FOR EACH ROW EXECUTE FUNCTION public.tg_record_edits('amount','currency','related_person','person_id','notes','created_at');
```

**⚠ `tg_record_edits` (:296-421) has NO EXCEPTION HANDLER — an audit-insert failure rolls back the user's money write.**

Contrast the realtime broadcast function, which wraps its body precisely so "a realtime hiccup must never be able to fail an expense." Here, anything that makes the `INSERT INTO public.record_edits` at :406-417 fail propagates and **aborts the user's transaction**. Concrete surfaces:

- FK `group_id → split_groups(id)` (:157): a `group_expenses` row whose `group_id` has no parent.
- FK `owner_id → auth.users(id)` (:158): a money row whose `user_id` is not in `auth.users`.
- :404 `v_owner := NULLIF(v_new ->> 'user_id','')::uuid` — an unparseable `user_id` raises `22P02`.
- `record_id TEXT NOT NULL` (:156) from `v_new ->> 'id'` — a NULL id.

All are unlikely on a healthy schema; none is impossible. Note the interaction with file #8, which **makes `group_expenses.user_id` nullable** — a NULL `user_id` is fine here (`owner_id` is nullable, :158), but the FK path is worth thinking about. **Decide explicitly before applying: if you want fail-open, wrap the body in `EXCEPTION WHEN OTHERS THEN RAISE WARNING; RETURN NULL;`.**

**Cost:** one plpgsql invocation per row on every INSERT and UPDATE of all four tables; when the whitelist diff is non-empty, one `record_edits` insert (`BIGSERIAL` nextval + 4 index maintenance ops). **Every saved expense writes a second row.** The no-op escape at :396-398 means pure `updated_at`/`version` bumps cost CPU but not a row. Combined with file #27, `transactions` and `loans` end up carrying both a per-row edit-history trigger and a per-statement broadcast trigger.

**Self-schedules pg_cron at apply time** (:532-553): if the extension is present it schedules `hisaab-prune-record-edits` at `'41 3 * * *'`. Touches only its own jobname.

---

### 30. `supabase-migration-p3-rls-initplan-and-indexes.sql` (781 lines)

| | |
|---|---|
| **Category** | **(b)** — mechanically rewrites every policy in schema `public`, drops one index, adds 14 + 3 PKs |
| **Apply-time DML** | None on user data |
| **Transaction** | **NONE — no `BEGIN;`/`COMMIT;`** |
| **Idempotent** | Yes — *proven*: 94 policies rewritten on pass 1, 0 on passes 2 and 3, with an identical `pg_policies` md5 across all three (:255-259) |
| **Rollback block** | Partial — :778-780, commented, DDL-only |
| **Flag-gated** | No |

**The policy rewrite is expression-only and semantics-preserving.** It deparses each policy, wraps bare `auth.uid()`/`auth.jwt()`/`auth.role()`/`current_setting()` in a scalar subquery, and applies it back with `ALTER POLICY … USING (…) WITH CHECK (…)`. That form changes **only** the expressions — never the command, the role list, or PERMISSIVE vs RESTRICTIVE (:243-247). The negative lookbehind `(?<!SELECT )` makes it re-runnable. This is Supabase's own documented fix for the 87 `auth_rls_initplan` advisor warnings on your production database.

**The two statements that touch existing objects:**
```sql
-- :399
DROP INDEX IF EXISTS public.idx_group_events_group_created;
```
Resolves the `duplicate_index` advisor warning (`prod-verification:325`). The surviving twin `idx_gevents_group_created` is byte-identical, and :401-412 recreates it if neither exists. Safe.

```sql
-- :611-613 (inside a DO loop over the three attempt ledgers)
ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS id BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.%I ADD CONSTRAINT %I PRIMARY KEY (id);
```
An IDENTITY column's default is volatile → **full table rewrite under `ACCESS EXCLUSIVE`** on `join_code_attempts`, `phone_lookup_attempts` and `code_lookup_attempts`. It cannot fail on data (the column is generated, so NOT NULL and unique by construction), and the loop skips any table that already has a PK. Production confirms both existing ledgers have no PK (`prod-verification:356-358`). Pre-flight reports both row counts — these are rate-limit logs, so expect them to be small, but check.

Plus 14 FK covering indexes (§4) addressing the `unindexed_foreign_keys` advisor. **The file explicitly declines `CONCURRENTLY`** (:67-79) and explains why — read that note before pasting into a large database. **Recommend wrapping in `BEGIN;`/`COMMIT;` by hand.**

**Must be re-run after adding any future migration that touches a policy** (:141-143).

---

### 31. `supabase-migration-p3-invariant-monitoring.sql` (1453 lines)

| | |
|---|---|
| **Category** | **(a) pure additive DDL** — 2 new tables, 1 view, 15 new functions |
| **Apply-time DML** | **None against user data.** |
| **Can fail on data** | None. Both CHECKs (:137, :162) and the `CREATE UNIQUE INDEX` (:196) are inline on brand-new empty tables. |
| **Drops** | :1064 `DROP TABLE pg_temp._recon_stage` — runtime, session-local temp only. :1352 `cron.unschedule` of its own jobname. **Nothing pre-existing.** |
| **Transaction** | **NONE — no `BEGIN;`/`COMMIT;`** |
| **Idempotent** | Yes |
| **Rollback block** | **None** |
| **Flag-gated** | No, and none is possible — the app can neither see nor call any of it |

Its header claim (:10-13) — *"It ALTERs nothing, DROPs nothing that predates it, and adds no policy, trigger, constraint or grant to any existing table"* — **verified accurate.**

**Does `run_reconciliation` ever write to user tables? No.** Complete write inventory: `reconciliation_runs` (:1055, :1179), `reconciliation_findings` (:1126, :1141, :1157), and a temp table (:1066-1121). Every user table is read-only. All eight check functions are declared `STABLE` (:448, :511, :564, :649, :743, :846, :949), which makes them **structurally incapable** of writing. The header's *"It never repairs anything… Repair is a human decision"* (:44-47) holds under reading.

**Two things to know:**
1. **It self-schedules at apply time.** `DO $cron$` at :1335-1362 — if `pg_cron` is installed it schedules `hisaab-nightly-reconciliation` at `'0 22 * * *'`. **Applying this file arms a nightly full-database scan with no further step.** Guarded: absent pg_cron degrades to a `RAISE NOTICE`. It never runs `CREATE EXTENSION`.
2. **Verification V5 (:1428-1447) is uncommented and executable**, and it expands every live transaction of every user into legs then anti-joins with `NOT IN`. Read-only and safe, but by far the slowest statement in the file. Consider deleting it from the paste on apply day.

Lockout is real: RLS on with zero policies (:207-208), `REVOKE ALL` from `PUBLIC, anon, authenticated` on both tables, the view and all 15 functions; `GRANT` only to `service_role`.

---

### 32. `supabase-migration-p3-rpc-execute-grants.sql` (727 lines) — TRULY LAST

| | |
|---|---|
| **Category** | **(b)** — ACL and `proconfig` sweep over `pg_proc`. **CREATEs nothing, REPLACEs no function body, no DDL, no DML.** |
| **Apply-time DML** | None |
| **Can fail on data** | None |
| **Transaction** | **NONE — no `BEGIN;`/`COMMIT;`** |
| **Idempotent** | Yes — it is *meant* to be re-run after any future migration |
| **Rollback block** | **Yes**, at the bottom of the file |
| **Flag-gated** | No |

This closes the 56 security-advisor WARNs on your production database (`prod-verification:143-148`): 19 SECURITY DEFINER functions executable by `anon`, 31 by `authenticated` (including trigger functions reachable as bare `POST /rest/v1/rpc/tg_notifications_push`), and 5 with a mutable `search_path`.

**Why it must be genuinely last:** it sweeps `pg_proc`. A function created by a file applied *after* this one keeps the `authenticated` EXECUTE that Supabase's default privileges hand it and escapes the `search_path` pin. §4's `ALTER DEFAULT PRIVILEGES` closes the PUBLIC/`anon` half for future functions, but nothing can retroactively revoke `authenticated` on a function that does not exist yet.

**⚠ The one risk: the allowlist was built from the BRANCH's client, not `main`'s.** The header states the `authenticated` allowlist is *"the exact set of names `grep -rhoE "\.rpc\(…" src/` returns (56 names, 2026-09-03)"*. I cross-checked all 23 RPCs `main` calls against the 56-name `v_client_rpcs` array:

**All 23 are covered except one — `lookup_profile_by_public_code`**, which is absent from the array. That is correct and harmless: the function is already gone from production (`prod-verification:70-72`), and `main`'s `profilesDb.findByPublicCode` already returns `null` on the error path.

Two nuances the file gets right and are worth recording:
- **R1:** an RLS policy expression is privilege-checked against the querying role, so revoking `is_current_profile_active()` from `authenticated` would turn *every* `SELECT` on `accounts`/`transactions`/`loans`/`profiles` into `42501` (34 policies reference it, 9 reference `is_group_member`). Both stay granted to `authenticated` via `v_internal_keep` — and lose `anon`.
- **R2:** a SECURITY INVOKER trigger function runs as the writing user, so four SECURITY DEFINER callees (`group_settlement_cap`, `group_member_net_balances`, `is_group_member` ×2) must keep `authenticated` EXECUTE or the settlement cap and group deletion break for everyone.

**`anon` allowlist is exactly two:** `get_committee_witness(TEXT)` and `get_khata_view(TEXT)` — the two public capability-URL pages. `main` calls `get_committee_witness` (`:1818`); covered.

---

## §2. Summary (a) — files that cannot affect existing rows

**19 of 32 are pure additive DDL.** Applying them can create new tables, functions, indexes and grants, and nothing else. No existing row is read for validation, rewritten, or deleted.

| # | File | What it adds |
|---|---|---|
| 2 | `audit-p0-loan-concurrency` | 1 function |
| 12 | `p1-app-config` | 1 table + 1 seed row into that table |
| 14 | `p1-group-preview` | 1 function |
| 18 | `p3-khata-link` | 2 tables + 6 functions |
| 19 | `p3-atomic-transfer` | 1 function |
| 20 | `p3-atomic-repayment` | 1 function |
| 21 | `p3-atomic-loan-create` | 1 function |
| 22 | `p3-atomic-goal-and-card` | 2 functions |
| 23 | `p3-atomic-investments-and-single-leg` | 3 functions |
| 24 | `p2-analytics-aggregates` | 1 function + 2 indexes on `transactions` |
| 25 | `p2-analytics-aggregates-2` | 2 functions |
| 31 | `p3-invariant-monitoring` | 2 tables + 1 view + 15 functions |

And these seven touch existing objects but still cannot affect a row's *contents*:

| # | File | Why it is safe |
|---|---|---|
| 1 | `audit-p0-currencies` | Widens a CHECK — no existing row can become invalid |
| 3 | `audit-p0-settlement-row-locks` | Replaces two function bodies; drops two overloads already absent from production |
| 5 | `audit-p0-group-ledger-integrity` | Policies and triggers only — no `ALTER TABLE` |
| 6 | `audit-p0-notifications` | Nullable / fast-default columns + a `NOT VALID` CHECK |
| 13 | `p1-profile-lang` | `NOT NULL DEFAULT 'ur'` fast default; CHECK cannot fail |
| 15 | `p1-money-bounds` | **34 CHECKs, all `NOT VALID` with a `VALIDATE` that downgrades to a WARNING** |
| 32 | `p3-rpc-execute-grants` | ACLs and `proconfig` only |

---

## §3. Summary (b) — the files that mutate existing rows, with the exact statements

**Six statements across four files. That is the complete list.**

### 4. `audit-p0-kameti-draw:195-198` — backfill a new column
```sql
update public.committees
   set draw_scheme = 'mulberry32-shuffle-v0'
 where draw_seed is not null
   and draw_scheme is null;
```
New all-NULL column added at :182. Guarded, idempotent, reversible (`SET draw_scheme = NULL`).

### 7. `audit-p0-group-concurrency:68` — provably a no-op
```sql
UPDATE public.group_expenses SET version = 1 WHERE version IS NULL;
```
`group_expenses.version` is `INTEGER NOT NULL DEFAULT 1` since `supabase-schema.sql:308`. Matches zero rows.

### 10. `audit-p0-join-abuse-limits:117-120` — join codes get a 14-day life
```sql
UPDATE public.split_groups
   SET join_code_expires_at = now() + INTERVAL '14 days'
 WHERE join_code IS NOT NULL
   AND join_code_expires_at IS NULL;
```
New column added at :112. Reversible (`SET join_code_expires_at = NULL`). **User-visible behaviour change.**

### 11. `audit-p0-consent-guards:1441-1445` — invite links stop being immortal
```sql
UPDATE public.group_invites
   SET expires_at = now() + INTERVAL '14 days'
 WHERE expires_at IS NULL
   AND revoked_at IS NULL
   AND accepted_at IS NULL;
```
Reversible (`SET expires_at = NULL`). **User-visible behaviour change.**

### 16. `p2-trust-safety:2068-2084` — ⚠ THE ONLY IRREVERSIBLE ONE
```sql
UPDATE public.committees SET share_token_hash = public.hash_witness_token(share_token)
 WHERE share_token IS NOT NULL AND share_token_hash IS NULL;

UPDATE public.committees SET witness_token_expires_at = now() + INTERVAL '90 days'
 WHERE share_token_hash IS NOT NULL AND witness_token_expires_at IS NULL;

UPDATE public.committees SET share_token = NULL WHERE share_token IS NOT NULL;   -- ← one-way door
```
Existing witness links keep working and get 90 days. **The plaintext token cannot be recovered by any rollback.**

### 17. `p2-notification-maturity:435-439` — the whole `notifications` table
```sql
UPDATE public.notifications n
   SET channel_id   = public.notification_channel_for(n.type, n.template),
       href         = public.notification_href_for(n.type, n.group_id, n.template, n.params),
       collapse_key = public.notification_collapse_key_for(n.type, n.group_id, n.template, n.params, n.id)
 WHERE n.channel_id IS NULL;
```
Three new columns filled from pure functions of existing columns. Nothing lost, nothing deleted. **Largest row count in the batch.**

**No file in the batch runs a `DELETE` or `TRUNCATE` against user data at apply time.**

---

## §4. Client coupling — the actual risk

The intended plan is **"one window: apply all 32, then deploy."** This section is why that is the right plan and not merely a tidy one.

### 4a. Breaks the LIVE (`main`) client if SQL is applied first

| Severity | File | What breaks |
|---|---|---|
| 🔴 **HARD** | 11 `consent-guards:1511` | `DROP FUNCTION accept_group_invite(TEXT,TEXT)` → recreated as `(p_invite_token, p_display_name) RETURNS JSONB`. `main:supabaseDb.ts:1429` sends `p_invite_token_hash` → **PGRST202**. Return type also flips `TABLE`→`JSONB`. **Invite-link joins die.** |
| 🔴 **HARD** | 11 `consent-guards:1407-1416` | `REVOKE SELECT ON group_invites` + column re-grant excluding `token_hash`. `main:supabaseDb.ts:1230,:1239` do `select('*')` → **42501**. Invite preview and list fail. |
| 🟠 **SILENT CORRUPTION** | 10 `join-abuse-limits:158-166` | `join_group_by_code` keeps its arg names but returns `JSONB` not `TABLE`. `main:supabaseDb.ts:1417-1421` does `data[0].group_id` → `undefined`. **Join-by-code produces a broken group/member id rather than an error.** |
| 🟠 **HARD (feature)** | 4 `kameti-draw:348-358` | Client-side seed/commitment/slot write is refused. `main:committeeStore.ts:115-130`. **Ballot draws die on old builds — including old Android APKs.** |
| 🟠 **HARD (feature)** | 28 `kameti-editing:269-280` | Raw `payout_method` update refused. `main:committeeStore.ts:434` `setFixedOrder` → raw 403. |
| 🟡 **UNHANDLED ERROR** | 9 `group-deletion-guard:548-550` | Group delete now raises. `main:GroupDetailPage.tsx:381-395` **has no try/catch** — the owner sees a raw PostgREST string. |
| 🟡 **SILENT DEGRADE** | 6 `notifications:142-153` | Client-side notification fan-out and `group_events` inserts stop. `main:splitStore.ts:244-274` catches and logs — non-fatal. |
| 🟡 **SILENT NO-OP** | 5 `group-ledger-integrity:290,:329` | `deleteByGroup` affects 0 rows and reports success. Orphaned ledger rows behind deleted groups. |

### 4b. Breaks the NEW (branch) client if SQL is applied after the deploy

23 branch RPCs are **ungated** — the new client calls them unconditionally. Deploying the client first means every one fails with `PGRST202` until the SQL lands:

`apply_loan_remaining_delta` (#2), `record_group_settlement` (#7), `list_pending_group_memberships`, `accept_group_membership`, `decline_group_membership` (#11), `add_group_guest`, `remove_group_guest` (#26), `archive_group`, `unarchive_group` (#9), `transfer_group_ownership` (#8), `perform_committee_draw` (#4), `update_committee`, `add_committee_member`, `remove_committee_member` (#28), `rotate_committee_witness_token`, `revoke_committee_witness_token` (#16), `create_khata_link`, `revoke_khata_link`, `get_khata_view` (#18).

Four degrade gracefully instead: `link_contact_by_code`, `link_contact_by_discovery`, `unlink_contact_profile` (fall back to `legacyDirectContactLink`) and `preview_group_by_code` (swallowed).

**`apply_loan_remaining_delta` is the sharpest:** `main` never calls it, the branch calls it for **every** `remaining_amount` change with no fallback. Ledger-mode repayments fail loudly until file #2 is applied.

### 4c. Which files force the single window

**These six make "SQL and client in one window" mandatory rather than merely preferable:**

**#4 kameti-draw · #5 group-ledger-integrity · #6 notifications · #9 group-deletion-guard · #10 join-abuse-limits · #11 consent-guards · #28 kameti-editing**

Everything else is either safe ahead of the client (the 19 additive files, the 5 flag-gated atomics, the 2 analytics files) or safe behind it. **Keep the deploy gap to minutes, not hours** — and remember Android users on an old APK stay in the "before" state until they update, which is exactly what `p1-app-config`'s version gate (#12) exists to manage. Consider seeding a real `min_supported_version` there **after** the client ships.

---

## §5. Summary (c) — the constraint pre-flight

**One file, one query, strictly read-only:** [`supabase-preflight-2026-09-03.sql`](../../supabase-preflight-2026-09-03.sql)

Returns `(file, check, violating_rows)` — 66 rows. Severities: **BLOCKS** (non-zero aborts that file), **DEGRADES** (constraint lands `NOT VALID` / index silently skipped), **REWRITES** (row blast radius of an apply-time backfill), **LOCKS** (table row count for a rewrite or index build), **FREEZES** (rows that stay legal but become uneditable).

**The complete BLOCKS list — only four checks in the whole batch can abort a file:**

| File | Statement | What to count |
|---|---|---|
| `audit-p0-currencies` | :102 `add constraint ltr_currency_supported` | `linked_transaction_requests` with a currency outside the 8 |
| `audit-p0-currencies` | :113 `add constraint lsr_currency_supported` | `linked_settlement_requests`, same |
| `audit-p0-account-deletion` | :443/:452 `ADD CONSTRAINT … FOREIGN KEY (user_id) REFERENCES auth.users` | orphaned `group_expenses.user_id` / `group_settlements.user_id` |
| `p2-trust-safety` | :1992/:2068 `committees_share_token_hash_uidx` | duplicate `committees.share_token` — **provably 0**, a UNIQUE index on that column already exists |

**Validation performed.** The pre-flight was executed against two throwaway `postgres:15` databases built by the harness:

1. **Historical-only** (base + prelude + the 40 applied migrations — production's exact shape): **runs clean, 66 rows, exit 0.** It deliberately references no object the pending 32 create.
2. **Fully migrated** (all 74 lines of `apply-order.txt`): **runs clean, 66 rows, all zeros, exit 0.**
3. **Negative test** — violating fixtures seeded into the historical DB (a 5e12 `USD` transaction with a 999999 conversion rate, a loan with `remaining > total`, duplicate `(group_id, profile_id)` member rows, and an expense whose splits sum to 10 against an amount of 100). **Every corresponding counter went non-zero and no other counter moved.** The checks detect what they claim to detect.

---

## §6. Recommended sequence

### Step 0 — a restore point you have actually tested
Confirm PITR is enabled on the project, note the timestamp, and take an on-demand backup. Every file below is transactional or hand-wrappable, so a mid-file failure rolls itself back — but `p2-trust-safety` destroys plaintext witness tokens irreversibly, and the `group-ledger-integrity` policy sweep drops policies it only names in a `NOTICE`. **PITR is the only real undo for those two.**

### Step 1 — capture the pre-state (read-only, save the output)
```sql
-- (i) the policies file #5's sweep may silently drop
SELECT tablename, policyname, permissive, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname='public' AND tablename IN ('group_expenses','group_settlements')
 ORDER BY 1,2;

-- (ii) loan statuses file #2 may rewrite to 'active'
SELECT status, count(*) FROM public.loans GROUP BY 1;
```

### Step 2 — run the pre-flight
Paste `supabase-preflight-2026-09-03.sql` whole. **Read every row.**
- Any **BLOCKS** > 0 → stop and fix those rows first.
- Any **DEGRADES** > 0 → decide: fix now, or accept the constraint landing `NOT VALID`.
- **REWRITES / LOCKS / FREEZES** → note the numbers; they size the window and tell you what becomes uneditable.

### Step 3 — apply in four batches, verifying between each

Paste each file **whole** into the Studio SQL Editor, one file at a time, in `apply-order.txt` order. Studio wraps the editor content in one transaction, so a file that already has `BEGIN;`/`COMMIT;` will log `there is already a transaction in progress` — **harmless, expected, not an error.**

> **Hand-wrap these four**, which carry no transaction of their own: **#4 `kameti-draw`**, **#28 `kameti-editing`**, **#30 `p3-rls-initplan-and-indexes`**, **#31 `p3-invariant-monitoring`**. Add `BEGIN;` at the top and `COMMIT;` at the bottom before pasting. Nothing in any of them is transaction-hostile, and a half-applied `kameti-editing` (guard armed, RPC missing) is the worst state in the batch. `p1-app-config` (#12) and `p3-rpc-execute-grants` (#32) also lack one, but neither can leave a harmful partial state.

**Batch A — the audit-P0 batch (files 1–11). ⏸ STOP AND VERIFY AFTER THIS.**
This is the batch that closes C4, C6, C7 and C9 and carries every hard client coupling. After it:
- Re-run the pre-flight — REWRITES rows should now read 0 (the backfills are done).
- Re-run `supabase-audit-p0-verification.sql` and confirm the `!!` rows from `prod-verification-2026-09-03.md` have cleared.
- Confirm `join_code_attempts` / `code_lookup_attempts` / `invite_accept_attempts` exist with deny-all RLS.
- **Check the Studio output for the `group_members holds N duplicate pair(s)` warning from #11.**
- Confirm the `Dropped unexpected permissive policy …` notices from #5 match your Step 1 capture.

**Batch B — P1 (files 12–15).** Small and safe. `p1-money-bounds` is the one to watch: **scan its output for `left NOT VALID` warnings** and match them against the pre-flight's DEGRADES rows.

**Batch C — P2 + the flag-gated P3s (files 16–29).** Contains the irreversible `p2-trust-safety` step and the largest `UPDATE` (`p2-notification-maturity`). Run off-peak. The five `p3-atomic-*` files are inert — consider deleting their heavy post-`COMMIT` verification blocks from the paste (especially `goal-and-card` V8).

**Batch D — the sweeps (files 30–32).** Must be genuinely last: #30 can only fix policies that already exist, and #32 can only revoke functions that already exist. Delete `p3-invariant-monitoring`'s V5 (:1428-1447) from the paste unless you want a full-table scan on apply day. **Note that #31 arms a nightly `pg_cron` job**, and #29 arms a daily prune job — decide whether you want those on.

### Step 4 — deploy the client, both surfaces, immediately
`npm run build && npx cap sync android`, push for Vercel, then hand off the Gradle AAB build. **Keep the gap between Step 3 and Step 4 to minutes.** Until the client ships, the §4a list is live for every user.

### Step 5 — after the client is out
- Leave all seven `VITE_ATOMIC_*` flags and `VITE_ANALYTICS_RPC` **off**. Flip them one at a time, later, with the drift-watch queries at the bottom of each atomic file as your baseline.
- Set a real `min_supported_version` in `app_config` so old Android builds are told to update rather than silently hitting the §4a errors.
- Re-run `supabase-audit-p0-verification.sql` and the Supabase advisors; the 87 `auth_rls_initplan` warnings and the 56 security WARNs should be gone.
- **Decide on `tg_record_edits`' missing exception handler** (#29) — the one place in the batch where an audit-row failure can roll back a user's money write.

---

## §7. The short answer to "why run all of these?"

You do not have to run all of them. But the batch is not 32 independent choices — it is roughly four:

1. **Files 1–11 close the four exploitable P0 findings your own production verification confirmed are open right now**: an ex-member can falsify a group ledger (C4), group members can read invite `token_hash` (C6), any user can insert notifications for a fellow member (C7), and 6 of your 8 shipped currencies error out on linked udhaar (C9). These carry the client coupling; they are also the reason the branch exists.
2. **Files 12–15** are small, additive, and make 34 money invariants enforceable without being able to fail.
3. **Files 16–29** are the P2 feature and hardening layer. Two of them mutate rows; one of those is irreversible.
4. **Files 30–32** are advisor sweeps that must run after everything else, and are re-runnable forever after.

**What the review found that changes the risk picture:** the one backfill that sounded most alarming (`group_expenses.version`) is provably a no-op; the 34 new money constraints cannot fail by construction; the five biggest files are inert until a flag flips; and the only irreversible statement in 32 files is a single `UPDATE committees SET share_token = NULL` that is the whole point of the fix it belongs to.

**The thing to plan for is not the data. It is the 15 minutes between the last `COMMIT` and the client deploy.**
