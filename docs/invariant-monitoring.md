# Invariant monitoring — the nightly reconciliation

**Written:** 2026-09-02 · **Audit item:** L7 (P3) · **Migration:** `supabase-migration-p3-invariant-monitoring.sql`
**Status:** integration-tested on PostgreSQL 15.19 in Docker against the full migration chain. **Not yet applied to production.**

---

## 1. Why this exists

> "No business-invariant monitoring — nothing detects the failure class this repo has actually suffered (balance desync history per `project_creditcard_emi_desync` memory): no reconciliation job, no 'sum of deltas ≠ balance' alarm."
> — `docs/audit-2026-09/13-engineering-standards.md` §2.3

> "The failure class this repo has already lived through (credit-card desync) currently has no detector; at scale the first signal must not be angry users."
> — `docs/audit-2026-09/00-executive-summary.md`:162, item L7

Hisaab's money engine runs **in the browser**. `processTransaction` moves balances through a client-side compensation pattern (`src/lib/mutationSafety.ts`); if the tab dies mid-mutation, the compensation dies with it. The schema was applied by hand over five months. Under those two conditions, drift is not hypothetical — it happened: a credit card once showed **Available 27,650 against a Limit of 16,500** because the same debt was credited back twice (`src/lib/cardCredit.ts`:1-10).

Nothing in the product noticed. A user did.

This migration adds a nightly job that recomputes each user's money from their own records and records every disagreement. **It never repairs anything.** Repair is a human decision (§7).

---

## 2. What gets installed

| Object | What it is |
|---|---|
| `reconciliation_runs` | one row per run: scope, timing, status, counts |
| `reconciliation_findings` | one row per open violation, aged across runs |
| `reconciliation_open_findings` (view) | the unresolved subset, with `age_hours` |
| `run_reconciliation(p_user_id, p_batch_size)` | the orchestrator |
| `reconciliation_summary()` | the machine-pollable alert surface |
| `_recon_check_accounts / _txn_types / _loans / _emi / _cards / _groups / _linked_pairs` | one function per invariant |
| `_recon_transaction_legs` | the sign map, expressed once |
| `_recon_note_meta` / `_recon_urldecode` / `_recon_numeric` / `_recon_mapped_types` / `_recon_cron_status` | helpers |
| pg_cron job `hisaab-nightly-reconciliation` | `0 22 * * *`, created only if pg_cron exists |

**Access:** both tables have RLS enabled with **zero policies** and all privileges revoked from `anon` / `authenticated`. `run_reconciliation` and `reconciliation_summary` are `service_role` only. The app cannot see, run, or be broken by any of it — which is why the file is safe to apply ahead of any client deploy.

**Apply order:** last, after everything else (`docs/audit-2026-09/APPLY-ORDER.md` §1 and §2, then the `p1-*` / `p2-*` tail). One hard dependency: `public.group_member_net_balances(text)` from `supabase-migration-audit-p0-group-deletion-guard.sql`. If it is missing, the group check records a `check_error` and every other check still runs.

---

## 3. The checks

Findings carry `expected` (what the records say), `actual` (what the column holds) and `delta = actual − expected`. **The sign of `delta` is the fastest triage signal:** positive means the stored value is *higher* than the evidence supports (money that appeared), negative means it is *lower* (money that vanished).

### `account_balance_drift` — the core "sum of deltas ≠ balance" alarm

**Asserts:** `accounts.balance = Σ(signed transaction legs on that account)`, summing from zero.

There is no separate opening-balance column and none is needed: `accountStore.createAccount` sets `balance = input.balance` *and* writes one `opening_balance` transaction for the same amount (`src/stores/accountStore.ts`:66-117). After creation the balance is never written absolutely — every change goes through `apply_account_balance_delta` (`accountStore.ts`:124-165). That is what makes the sum meaningful.

The per-type sign rules are the **sign-mapping table in the migration's header**, derived from `processTransaction` (`src/stores/transactionStore.ts`:925-1571) and cross-checked against `deleteTransaction` (:2017-2249), which must undo exactly what the forward path did. Server-side writers (`accept_linked_request`, `accept_settlement_request` in `supabase-migration-cross-user-account-effects.sql`) use the same convention and were verified against the same table.

Three rules are easy to get wrong and are worth knowing by heart:

- A **ledger-mode / write-off repayment carries both account ids null** and moves nothing (`src/stores/loanStore.ts`:200-209, `tasks/lessons.md`:26-27).
- A **self-stored goal contribution** (`meta.goalSelfStored = '1'`) moves nothing either — the money stayed where it was.
- A **clamped cash-advance repayment** credits the card by `meta.cardCreditedAmount`, **not** by the row's amount.

**Tolerance:** `0.01 + 0.01 × (number of cross-currency legs on that account)`. See §5.

**`details`** carries `by_type` — the per-transaction-type contribution to `expected`. On a real finding this usually names the culprit immediately.

### `unmapped_transaction_type` — the guard on the guard

`transactions.type` has **no CHECK constraint** (only `amount`, `conversion_rate` and `currency` are constrained). A type outside the twelve in `src/db/types.ts`:18-30 would contribute nothing to `expected` and could hide a real drift or invent a fake one. So an unknown type reports itself.

Read it as *"the sign map is out of date"*, not as corruption. Fix = add the type to `_recon_transaction_legs` and to `_recon_mapped_types()`, then re-run.

### `loan_remaining_drift`

**Asserts:** `loans.remaining_amount = GREATEST(0, total_amount − Σ repayments)`.

The `GREATEST(0, …)` is not a fudge — it is the app's semantics. `apply_loan_remaining_delta` clamps at zero, and `trackedApplyRepayment` deliberately does **not** pre-clamp the requested amount, so an overpayment settles the loan while the transaction row keeps the figure the user typed. Without the clamp every overpayment would be a false positive. `details.overpaid` flags those.

**Write-offs need no special case.** "Settle — no money moved" (`src/pages/LoanDetailPage.tsx`:194-196) goes through `loanStore.applyRepayment`, which writes a real repayment row for the full remaining amount tagged `meta.writeOff='1'`, both account ids null. It counts here exactly like cash — correct for *this* invariant, because it is money the loan no longer owes. `details.write_off_rows` surfaces the count so a loan that closed without a payment is never a surprise.

Loan totals are safe to anchor on: the loan edit UI never changes `total_amount` (`LoanDetailPage.tsx`:264-267 edits name and notes only), and the transaction-level edit that *does* change it resets `remaining = total` and is refused once repayments exist (`transactionStore.ts`:1758-1790).

**Tolerance:** 0.01. `details.status_consistent` reports whether `status='settled'` agrees with `remaining=0`.

### `emi_schedule_total_mismatch`

**Asserts:** `Σ(instalment amounts) = loans.total_amount`, for loans that have a schedule.

`emiStore.generateSchedule` gives the **last** instalment the remainder (`total − emiAmount × (n−1)`), so the sum is exact — the 0.01 here absorbs numeric noise only, *not* a per-instalment rounding drift.

### `emi_paid_overrun`

**Asserts:** `Σ(amount of instalments marked 'paid') ≤ (total_amount − remaining_amount)`.

`uncoveredToPaidIds` (`src/lib/emiCoverage.ts`) only ever marks a **prefix** whose cumulative amount is covered by money actually repaid (`COVERAGE_EPSILON = 0.00001`), so paid instalments can never outrun the money. When they do, a schedule is claiming an instalment is settled that no payment covers — the EMI half of the 2026-07 desync.

**The reverse direction is deliberately not reported.** A *lagging* schedule harms no balance and self-heals on the next repayment via `trackedMarkCoveredEmisPaid` / `trackedSyncEmisToLoan`.

**Counts are carried, not asserted.** `paid_instalments` and `repayment_count` are in `details` because one repayment legitimately covers many instalments and one instalment can be covered by many repayments. Only the amount comparison is an invariant.

### `card_available_over_limit` — the 2026-07 shape

**Asserts:** `accounts.balance ≤ metadata.creditLimit` for credit cards.

A card's balance **is** its available credit; the bank never owes headroom beyond the limit (`src/lib/cardCredit.ts`:1-10). This finding is literally the reported bug: the same debt credited back twice.

### `card_advance_exceeds_used`

**Asserts:** `Σ(active cash-advance remaining) ≤ used`, where `used = creditLimit − balance`.

The documented model is `used = revolving purchases + Σ(cash-advance remaining)` (`src/lib/cardStatement.ts`:14-19) — but `revolving` is *defined* as `used − Σ(remaining)` (`cardStatement.ts`:161), so the equation as written is a tautology and cannot be tested directly. Its testable corollary is that `revolving` must never go negative. When it does, the loans still track financed principal the card no longer says is owed: a payment reduced the card but not the loans, or a loan was restored without the card. `details.revolving_purchases` shows how far negative.

Cash advances are found the way the app finds them (`transactionStore.findActiveCashAdvanceLoansForCard`:724-739): live `loan_taken` rows whose `source_account_id` is the card, joined to loans of type `taken`, status `active`, remaining > 0.005, and matching the card's currency.

### `group_ledger_imbalance`

**Asserts:** within a group, `Σ(net balance over all members) = 0`. Money between members can only be redistributed; it cannot be created.

The net figure comes from the **server recompute**, not a reimplementation: `public.group_member_net_balances` (`supabase-migration-audit-p0-group-deletion-guard.sql`:401-449), documented there as using the same arithmetic, sign convention, rounding and `deleted_at` filter as `leave_group` (`supabase-migration-safe-leave-group.sql`:110-138). If that function is absent the check **raises** rather than guessing with a private copy that could drift from the authority.

A non-zero total means one of four things, all decomposed into `details`:

| `details` field | Meaning |
|---|---|
| `split_sum_gap` | Σ(expense amount − Σ its splits) — splits that do not add up |
| `orphan_payer_total` | expense amounts whose `paid_by` names a member row that does not exist |
| `orphan_split_total` | split amounts whose `memberId` names a member row that does not exist |
| `orphan_settlements` | settlements naming a non-member on either side |

Members who have **left** are included on purpose — a departed member's residual position must still be counted for the group to net to zero.

**Tolerance:** 0.01, the same threshold `leave_group` itself uses.

### `linked_pair_divergence` / `linked_pair_missing_loan`

**Asserts:** for each **accepted** `linked_transaction_requests` row, the requester's and responder's mirrored loans agree on what is outstanding.

`accept_settlement_request` reduces both sides in one transaction (row-locked by `supabase-migration-audit-p0-settlement-row-locks.sql`) and the client refuses to delete a repayment on an active linked loan (`transactionStore.ts`:2127-2131). A divergence means one of those guards was bypassed or an edit landed on one side only.

`requester_loan_id` / `responder_loan_id` carry **no foreign key**, so a hard delete or a tombstone on one side leaves a dangling pointer and a one-sided debt that nothing else in the schema would notice — that is `linked_pair_missing_loan`.

`expected` = the requester side, `actual` = the responder side. The finding is attributed to the requester so each pair is examined exactly once.

### `check_error`

A check function raised. `details` carries `check`, `sqlstate`, `message`, and the failing batch's first user id and size. The run's status becomes `error`.

Every `(batch × check)` runs in its own subtransaction, so one broken check loses only its own rows for that batch. **Proven** in validation (§8): with `group_member_net_balances` renamed away, the group check errored and the account check still reported its drift in the same run.

---

## 4. Reading a finding

```sql
-- everything currently open, worst first
SELECT kind, user_id, entity_id, expected, actual, delta, age_hours, seen_count, details
  FROM public.reconciliation_open_findings
 ORDER BY abs(delta) DESC NULLS LAST;

-- one user end to end
SELECT * FROM public.reconciliation_open_findings
 WHERE user_id = '<uuid>';

-- did it get fixed?
SELECT kind, entity_id, detected_at, resolved_at, resolved_run_id
  FROM public.reconciliation_findings
 WHERE resolved_at IS NOT NULL
 ORDER BY resolved_at DESC LIMIT 50;
```

**Lifecycle.** A finding is identified by `fingerprint = kind|user_id|entity_id`:

- **new** → inserted with `detected_at`, `seen_count = 1`;
- **still there** → the same row is refreshed (`expected`/`actual`/`delta`/`details` updated, `seen_count` incremented, `last_seen_at` bumped). It does **not** duplicate;
- **gone** → the first run that no longer sees it stamps `resolved_at` and `resolved_run_id`;
- **back again** → a *new* row opens, so the old resolution stays auditable.

A partial unique index enforces one open row per fingerprint.

`seen_count` is the age signal that matters: a finding at `seen_count = 1` may be a mid-write snapshot; at `seen_count = 7` it is a real, persistent inconsistency.

**Scoping.** `run_reconciliation('<user uuid>')` checks one user and resolves only that user's findings — safe for support triage without touching anyone else's state. Note that a `check_error` raised by a full run is scoped `@ALL` and only a full run can clear it.

---

## 5. Known false-positive sources

| Source | Effect | How it is handled |
|---|---|---|
| **Cross-currency rounding.** The app rounds in JS floats (`Math.round(n*100)/100`); Postgres rounds `numeric` exactly, half-up. They disagree only on exact ties that float representation pushes below .5 (JS `1.005 → 1.00`, PG → `1.01`), and only on legs computed as `A*R` or `A/R`. | up to ±0.01 per converted leg | account tolerance is `0.01 + 0.01 × converted_leg_count`; `details.converted_leg_count` and `details.tolerance_used` are recorded |
| **Ledger-only (`splits_only`) rows.** Repayments written by `loanStore.applyRepayment` carry **both** account ids null. | none, if the sign map is respected | mapped to zero legs; `details.ledger_only_rows` on loan findings |
| **Write-offs / "settle — no money moved".** A repayment row for the full remaining amount, no cash behind it. | none for the loan invariant | counted as a repayment (correct); `details.write_off_rows` flags it |
| **Overpaid loans.** The store clamps `remaining` at 0 while the row keeps the typed amount. | would be a permanent false positive without the clamp | `expected = GREATEST(0, …)`; `details.overpaid` |
| **Self-stored goal contributions.** `meta.goalSelfStored='1'` — money stays put. | none | mapped to zero legs |
| **Clamped card credits.** A repayment credits the card by `meta.cardCreditedAmount`, not `amount`. | none | the leg reads the note meta |
| **Retired (soft-deleted) accounts.** Their balances are no longer maintained; reversal legs skip them. | would drift forever | `deleted_at IS NULL` filter; an account must be at zero to be retired anyway |
| **Tombstoned transactions.** Already reversed when deleted. | double-counting | `deleted_at IS NULL` filter |
| **Mid-write snapshots.** The job reads uncommitted-adjacent state on a very active account. | a one-night finding that clears itself | `seen_count = 1` findings are noise-prone; escalate on `seen_count ≥ 2` |
| **Soft-deleted profiles.** `profiles.is_deleted = true` users are skipped. | their residual data is never checked | intentional; account deletion anonymizes rather than erases |
| **A transaction type nobody told the sign map about.** | silent under- or over-count on the account check | reported as `unmapped_transaction_type` |

**Not a false-positive source, but worth knowing:** the group split-sum drift can no longer be *created* through the app — `tg_group_expenses_validate_split_amounts` (an audit-P0 sibling) rejects it at write time with `GROUP_SPLITS_DO_NOT_SUM`. The check still matters for rows written before that trigger existed.

---

## 6. Scheduling and alerting

### The job

`supabase-migration-p3-invariant-monitoring.sql` creates the pg_cron job **only if the extension exists**; otherwise it prints the exact steps and does nothing.

```
name:     hisaab-nightly-reconciliation
schedule: 0 22 * * *
command:  SELECT public.run_reconciliation();
```

**22:00 UTC, not 23:00.** PKT is UTC+05:00 → **03:00 Pakistan**; GST is UTC+04:00 → **02:00 Gulf**. (23:00 UTC would be 04:00 PKT.) 22:00 UTC is the hour that is quiet in both markets.

If pg_cron is not enabled: **Supabase Dashboard → Database → Extensions → `pg_cron`**, then either re-run this migration or create the job in **Integrations → Cron** with the three values above. Re-running the migration is idempotent — it unschedules the existing job by name before rescheduling, so you never end up with two.

### Alerting — the recommendation

**Use the log alert. It is the only option that keeps the service-role key inside the database.**

Every run ends with one distinctive log line:

```
NOTICE:   HISAAB_RECONCILIATION_OK    run=15 scope=ALL users=2 open=0
WARNING:  HISAAB_RECONCILIATION_ALERT run=16 scope=ALL open=1 new=1 resolved=0 check_errors=0 fatal=-
```

Wire it up in **Supabase Dashboard → Logs → Logs Explorer**, save the query, and attach an alert / scheduled report:

```sql
-- Logs Explorer uses BigQuery SQL, not Postgres SQL.
select cast(timestamp as datetime) as ts, event_message
from postgres_logs
where event_message like '%HISAAB_RECONCILIATION_ALERT%'
order by timestamp desc
limit 50;
```

Add a **second, equally important** rule for the job never running at all — a silent detector is worse than none:

```sql
-- run over a 26-hour window in the date picker; a result of 0 means the
-- nightly job never fired, which is a silent detector and worse than a finding
select count(*) as runs_in_window
from postgres_logs
where event_message like '%HISAAB_RECONCILIATION_%';
```

### Alternative: a Vercel cron polling `reconciliation_summary()`

Richer routing (Slack, PagerDuty, email templates), at a real cost: it requires a **new serverless route in a repo that deliberately has no server**, and it puts `SUPABASE_SERVICE_ROLE_KEY` — the credential that bypasses every RLS policy in the database — into Vercel's environment and into every preview deployment that inherits it. Choose it only if you actually need the routing.

```jsonc
// vercel.json
{ "crons": [{ "path": "/api/reconciliation-check", "schedule": "30 22 * * *" }] }
```

```ts
// api/reconciliation-check.ts — sketch
const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reconciliation_summary`, {
  method: 'POST',
  headers: {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: '{}',
});
const rows = await res.json();
const run = rows.find((r) => r.kind === '__run__');
const bad =
  !run ||                              // reconciliation has never completed
  run.run_status !== 'ok' ||           // a check errored, or findings exist
  run.open_count > 0 ||                // any unresolved violation
  run.run_age_minutes > 1500;          // the nightly job did not run (25h)
if (bad) await notify(run, rows);
```

`reconciliation_summary()` always returns **at least one row** (`kind = '__run__'`), so an alert rule never has to special-case "no rows" — except for the genuine "never ran" case, where the result is empty and must itself be treated as an alert.

Whichever you choose, guard the route or query so the service key is never returned to a caller.

---

## 7. Runbook — a finding fired, now what

1. **Confirm it is persistent.** `seen_count = 1` on a busy account can be a mid-write snapshot. Re-run for that user and see whether it survives:
   ```sql
   SELECT public.run_reconciliation('<user uuid>');
   SELECT * FROM public.reconciliation_open_findings WHERE user_id = '<user uuid>';
   ```
   If it disappears, it was a snapshot. Note it and move on.

2. **Read `details` before reading any table.** It is built for exactly this moment: `by_type` for an account drift, `split_sum_gap` / `orphan_*` for a group, `write_off_rows` / `overpaid` for a loan, `revolving_purchases` for a card.

3. **Reproduce the arithmetic.** For an account:
   ```sql
   SELECT txn_type, account_id, round(SUM(delta), 2) AS contribution, count(*) AS legs
     FROM public._recon_transaction_legs(ARRAY['<user uuid>'::uuid])
    WHERE account_id = '<account id>'
    GROUP BY txn_type, account_id
    ORDER BY abs(SUM(delta)) DESC;
   ```
   Then look at the rows of the dominant type, newest first.

4. **Decide which side is the truth.** In Hisaab the **records are the truth** and the balance is a cache of them — every mutation writes a row and then applies a delta. So the normal repair is to correct the *balance*, not to invent or delete records. Two exceptions:
   - a repayment row with no matching loan reduction (or vice versa) means one half of a compensation was lost — read `reconciliation_runs` timing against Sentry for that window before touching anything;
   - an `unmapped_transaction_type` finding means the *checker* is wrong, not the data. Fix the sign map first, re-run, and only then judge any account findings that reference that type.

5. **Never repair from SQL by hand if a supported path exists.** The app's own `adjustment` transaction type exists precisely to reconcile a balance to reality, and it leaves a record. A raw `UPDATE accounts SET balance = …` leaves the next night's run reporting the same drift in the opposite direction. If you must write SQL, route balances through `apply_account_balance_delta` and loans through `apply_loan_remaining_delta` so the optimistic locks stay honest.

6. **For a `linked_pair_*` finding, remember two humans are involved.** Both users' books must end up agreeing. Do not fix one side and close the finding — re-run and confirm the pair converged.

7. **For a `check_error`, the checker is down, not the data.** Nothing was verified for that check on that batch. Fix the cause (most likely: `group_member_net_balances` missing because `supabase-migration-audit-p0-group-deletion-guard.sql` was never applied), then re-run a **full** scan — a single-user run cannot clear an `@ALL`-scoped check error.

8. **Close the loop.** Re-run and confirm `resolved_at` is stamped:
   ```sql
   SELECT public.run_reconciliation();
   SELECT kind, entity_id, resolved_at, resolved_run_id
     FROM public.reconciliation_findings
    WHERE fingerprint = '<the fingerprint>';
   ```

9. **Write it down.** If the finding revealed a code path that can produce drift, that belongs in `tasks/lessons.md`, not just in a fixed row.

---

## 8. RPC error-rate observability (documented, not implemented)

The audit also asks for RPC error-rate alerting. This part needs dashboard access and is **not** in the migration — but here is exactly how to get it, including one correction worth knowing.

**`pg_stat_statements` cannot do it.** It records calls, rows and time; it has **no error counter**. A `SECURITY DEFINER` function that ends in `RAISE EXCEPTION` still records a normal call. The same is true of `pg_stat_user_functions`. Anyone who tells you to "check the error rate in pg_stat_statements" is wrong.

**Error counts come from the logs.** Every one of Hisaab's RPC contracts raises a distinctive uppercase token, which makes them trivially greppable. The full set in the current migrations:

`ACCOUNT_NOT_FOUND`, `BALANCE_CONFLICT`, `CANNOT_JOIN_OWN_GROUP`, `CONVERSION_RATE_REQUIRED`, `DESTINATION_AMOUNT_MISMATCH`, `EXPECTED_BALANCE_REQUIRED`, `GROUP_ARCHIVED`, `GROUP_ARCHIVE_RPC_ONLY`, `GROUP_CONSENT_REQUIRED`, `GROUP_EXPENSE_VERSION_CONFLICT`, `GROUP_HAS_OTHER_MEMBERS`, `GROUP_HAS_OUTSTANDING_BALANCES`, `GROUP_MEMBERSHIP_BLOCKED`, `GROUP_SPLITS_DO_NOT_SUM`, `INACTIVE_GROUP_AUTHOR`, `INACTIVE_GROUP_MEMBER`, `INSUFFICIENT_BALANCE`, `INVALID_*`, `INVITE_NOT_FOUND_OR_EXPIRED`, `LINK_RPC_REQUIRED`, `LOAN_NOT_FOUND`, `LOAN_REMAINING_CONFLICT`, `MEMBER_ALREADY_EXISTS`, `MISSING_AUTHORSHIP`, `NOT_AUTHENTICATED`, `NOT_ENOUGH_ACTIVE_GROUP_MEMBERS`, `OWNED_GROUPS_WITH_MEMBERS`, `SETTLEMENT_EXCEEDS_OUTSTANDING`, `DRAW_FIELDS_ARE_SERVER_ONLY`, `ALREADY_DRAWN`.

**Logs Explorer — error frequency by token, last 24h:**

```sql
-- Logs Explorer (BigQuery SQL). The severity lives on metadata.parsed.
select
  regexp_extract(event_message, r'([A-Z][A-Z_]{5,})') as token,
  count(*) as occurrences
from postgres_logs
cross join unnest(metadata) as m
cross join unnest(m.parsed) as parsed
where parsed.error_severity in ('ERROR', 'FATAL')
group by token
order by occurrences desc;
```
(Set the time window with the Logs Explorer date picker rather than a `where` clause on `timestamp` — it drives BigQuery partition pruning and keeps the query cheap.)

**What to alert on, and why (these are not all bugs):**

| Token | Normal? | Alert when |
|---|---|---|
| `BALANCE_CONFLICT`, `LOAN_REMAINING_CONFLICT`, `GROUP_EXPENSE_VERSION_CONFLICT` | **Yes** — these are the optimistic locks doing their job; the client retries once | the *rate* jumps. A step change means either a realtime storm re-firing writes or genuine multi-device contention |
| `SETTLEMENT_EXCEEDS_OUTSTANDING`, `GROUP_SPLITS_DO_NOT_SUM`, `INVALID_*` | **Yes** — server-side validation rejecting bad input | a sustained spike suggests the client is computing something wrong, not that users suddenly got sloppy |
| `NOT_AUTHENTICATED`, `LINK_RPC_REQUIRED`, `GROUP_ARCHIVE_RPC_ONLY`, `DRAW_FIELDS_ARE_SERVER_ONLY` | **No** | any occurrence — the client is bypassing a supported path, or an attacker is probing |
| `PGRST202` (function not found) | **No** | any occurrence — a migration is missing in production. The known live instance is `lookup_profile_by_public_code` (`src/lib/supabaseDb.ts`:1550), documented in `APPLY-ORDER.md` §3 |
| `42501` (permission denied), `42P17` (RLS recursion) | **No** | any occurrence |

**Call counts** (the denominator for a rate) come from `pg_stat_user_functions`, which Supabase exposes when `track_functions` is on:

```sql
select funcname, calls, total_time, self_time
from pg_stat_user_functions
where schemaname = 'public'
order by calls desc;
```

Divide a token's log count by its function's `calls` for a true error rate. Reset the baseline with `pg_stat_reset()` when you want a clean window.

---

## 9. Validation record

Harness: `postgres:15` container (**PostgreSQL 15.19**) with the Supabase-shaped scaffold from `docs/audit-2026-09/APPLY-ORDER.md` §3, then the full chain — `supabase-schema.sql` + 40 historical migrations in §1 order + 11 audit-P0 files in §2 order + the five `p1-*` / `p2-*` files. **58 / 58 applied cleanly**, then this migration on top.

| Test | Result |
|---|---|
| Apply on the full chain | clean; verification V1–V5 all `ok` |
| Idempotency | applied **5×** total, 0 errors; only benign `already exists, skipping` notices; no duplicate objects and no duplicate cron job |
| Seeded book: 2 users, 4 accounts, 4 loans, 14 transactions covering **every mapped type**, a 5-instalment EMI plan, a cash advance, a cross-currency transfer, a self-stored goal contribution, a shared group, an accepted linked pair | baseline run: **`status = ok`, 0 findings** — the sign map reproduces every balance to the paisa |
| Deliberate drift, one per check | **all 9 finding kinds fired with the correct `expected`/`actual`/`delta`:** `account_balance_drift` (+137.50 cash, +4500 card), `card_available_over_limit` (+500), `card_advance_exceeds_used` (−4500), `emi_paid_overrun` (+2000), `emi_schedule_total_mismatch` (+400), `loan_remaining_drift` (−300), `group_ledger_imbalance` (+100), `linked_pair_divergence` (−200), `unmapped_transaction_type` (`kameti_payout`) |
| Persistence | re-running with the drift in place refreshed the same rows and incremented `seen_count` (1 → 4); no duplicates |
| Resolution | after repairing every drift, the next run stamped `resolved_at` + `resolved_run_id` on **all 11** open findings and returned `status = ok`, `open = 0` |
| Check isolation | `group_member_net_balances` renamed away → `check_error` finding recorded with the raised message, run `status = error`, **and the account check still reported its drift in the same run** |
| Single-user scoping | `run_reconciliation('<A>')` resolved A's finding and left B's loan drift and A's still-real linked-pair finding open |
| Note-meta parser | `cardCreditedAmount`, `goalSelfStored`, multi-key, `&`-escaped and **Urdu UTF-8** payloads all parse; plain notes containing `%`, malformed JSON and `NULL` all degrade to `{}` without raising |
| Clamped card credit | a 2000 repayment with `meta.cardCreditedAmount = 500` produced legs `acc_cash −2000` / `acc_card +500` and reconciled to **0 findings** |
| pg_cron **absent** | migration applies; prints the dashboard steps; `V4` reports "pg_cron absent" |
| pg_cron **present** (installed 1.6, `shared_preload_libraries`) | job created at `0 22 * * *`; re-applying unschedules and reschedules — exactly **one** job row |
| Role matrix | `service_role`: reads tables + view, runs the job, reads the summary. `authenticated`: `permission denied` on the table, on `run_reconciliation`, and on `reconciliation_summary` |
| Alert log line | clean run → `NOTICE HISAAB_RECONCILIATION_OK … open=0`; drifted run → `WARNING HISAAB_RECONCILIATION_ALERT run=16 open=1 new=1 …` |

### What the harness does **not** prove

- **Production drift.** The harness replays this repo's files; production is whatever was pasted into Studio over five months. `docs/audit-2026-09/APPLY-ORDER.md` §7 covers this in full. The first production run may surface findings that are *history*, not new corruption — see §10.
- **Scale.** Empty tables plus ~20 seeded rows. No `EXPLAIN`, no load. `_recon_check_groups` calls `group_member_net_balances` once per group and that function runs four correlated subqueries per member; a tenant with thousands of groups is untested. Start with a small `p_batch_size` and watch the run duration in `reconciliation_runs`.
- **Concurrency.** The job reads while users write. Findings from a mid-write snapshot are expected and are why `seen_count` exists.
- **PostgREST.** `reconciliation_summary()` was called as SQL, not over HTTP. The Vercel-cron sketch in §6 is untested.

---

## 10. Before the first production run

1. Apply the file (last, per §2). It is safe ahead of any client deploy.
2. Run the verification block at the bottom of the migration. V1–V3 must be `ok`. V4 tells you whether the cron job exists.
3. **Run it once manually and expect findings.** `SELECT public.run_reconciliation();` The first run reconciles five months of history written by a client-side money engine, against a schema whose applied state has never been verified (audit finding #1). Treat the first result as a **census**, not an incident:
   ```sql
   SELECT kind, count(*), round(sum(abs(delta)), 2) AS total_absolute_delta
     FROM public.reconciliation_open_findings GROUP BY kind ORDER BY 2 DESC;
   ```
4. Triage that census by `kind` before wiring any alert. Then fix, re-run until `open = 0`, and only then turn the alert on — an alert that is red on day one gets muted by day three, which is exactly the failure this whole file exists to prevent.
