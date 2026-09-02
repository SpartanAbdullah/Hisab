# Server-side money engine — the L4 pilot

**Written:** 2026-09-02 · **Status:** pilot built, Docker-validated on PostgreSQL 15.19, **flag OFF, migration not yet applied to production**

Audit refs: [`07-mobile-first.md` MF-01](audit-2026-09/07-mobile-first.md) · [`12-qa-review.md` O-1 / F-4](audit-2026-09/12-qa-review.md) · [`02-repository-architecture.md` H-3 / H-4](audit-2026-09/02-repository-architecture.md) · [`00-executive-summary.md` M1 / L4](audit-2026-09/00-executive-summary.md)

---

## 1. The problem, stated exactly

Hisaab has no server. Every money move is a **sequence of independent HTTPS calls from a phone**, wrapped in a client-side compensation scope (`src/lib/mutationSafety.ts`). A transfer is three of them:

1. `apply_account_balance_delta(source, −amount, expected)` — commits.
2. `apply_account_balance_delta(destination, +amount, expected)` — **times out.**
3. `transactions.upsert(row)` — never runs.

Rollback then tries to re-credit the source *over the same dead connection*. The module's own header says what happens next:

> "Compensations may themselves fail (the same network outage that killed the forward write usually kills the inverse)." — `src/lib/mutationSafety.ts:10-13`

Server truth afterwards: **the money left the wallet and arrived nowhere.** No transaction row, no marker, no repair queue — `outboxRunner.ts` is a scaffold whose dispatch handlers throw (`:26-29`), and `App.tsx:253-264` says so in a comment. The user sees a generic error and, once a refetch lands, a balance that is simply smaller. Recovery is the `adjustment` type, by hand, if they notice.

This is the daily condition of the target market (3G, Gulf↔Pakistan, low-end Android), not an exotic edge. MF-01 is rated high only because it is *visible* rather than silent.

**No client pattern can fix it.** Two network calls cannot be made atomic from the client side. The fix has to live where a transaction boundary exists: Postgres.

---

## 2. The pilot

`supabase-migration-p3-atomic-transfer.sql` adds one function:

```sql
transfer_between_accounts(
  p_transaction_id text, p_source_account_id text, p_destination_account_id text,
  p_amount numeric, p_destination_amount numeric, p_conversion_rate numeric,
  p_note text, p_category text, p_date timestamptz,
  p_expected_source_balance numeric, p_expected_destination_balance numeric,
  p_allow_negative boolean
) RETURNS jsonb
```

`SECURITY DEFINER`, `SET search_path = public`, `EXECUTE` granted to `authenticated` only (revoked from `PUBLIC`/`anon`). RLS is not consulted under DEFINER, so the `user_id = auth.uid()` predicate on every read and write **is** the access control — the `apply_loan_remaining_delta` precedent.

In one transaction it: locks both account rows `FOR UPDATE` in ascending `id` order → short-circuits an idempotent replay → validates ownership, soft-deletion, amount, currency and rate → compare-and-swaps both expected balances → applies the insufficient-balance guard → moves both balances → inserts the transactions row → returns `{status, replay, transaction_id, source_balance, destination_balance, destination_amount, conversion_rate}`.

### 2.1 The artifact contract

The RPC had to reproduce **exactly** what the client leaves behind — the full table lives in the migration header; the split is:

| Artifact | Owner after the pilot |
|---|---|
| source `accounts.balance` | **server**, in the transaction |
| destination `accounts.balance` | **server**, same transaction |
| `transactions` row (20 columns, `type='transfer'`) | **server**, same transaction |
| Dexie mirrors (`accounts`, `transactions`) + Zustand state | client, post-commit (adopting the server's balances) |
| `activity_log` entry | client, post-commit, best-effort — unchanged, because the repo's rule is that an activity-log failure must never roll back money that has moved (`transactionStore.ts:654-667`) |
| reminder reschedule (`nudgeReminderSchedule`) | client, post-commit — unchanged |
| card-bill cash-advance auto-settle | client, inside the same `MutationScope` — unchanged; it touches `loans` and writes ledger-only `repayment` rows, **no account balances** ("the money already moved via the transfer legs above") |

### 2.2 Error contract — only tokens the client already speaks

| Token | Meaning | Client behaviour |
|---|---|---|
| `BALANCE_CONFLICT` | a compare-and-swap was stale | **byte-identical message** to `apply_account_balance_delta`, so the existing `err.message.includes('BALANCE_CONFLICT')` parser and the refetch-and-retry-once ladder work unchanged. Current balances ride in `DETAIL` (`details` on `PostgrestError`) so the retry needs no extra fetch. |
| `INSUFFICIENT_BALANCE` | the server half of `checkBalance` | `DETAIL` carries `{account_name, available, requested, …}`; the wrapper rebuilds the **same bilingual `tStatic('err_insufficient')` string** the user sees today. |

Everything else (`NOT_AUTHENTICATED`, `ACCOUNT_NOT_FOUND`, `SAME_ACCOUNT`, `INVALID_AMOUNT`, `EXPECTED_BALANCE_REQUIRED`, `CONVERSION_RATE_REQUIRED`, `INVALID_CONVERSION_RATE`, `DESTINATION_AMOUNT_MISMATCH`, `TRANSACTION_ID_COLLISION`) is a poisoned payload or a programming error, unreachable from the shipped client — they exist because one `curl` against PostgREST bypasses every client guard.

**A correction worth recording:** the brief assumed the insufficient-balance guard could be copied from `apply_account_balance_delta`. It has none. Reading that function in full (`prelaunch-hardening.sql:245-275`) shows a bare CAS `UPDATE`; the guard has always been client-side `checkBalance`, which is exactly why CLAUDE.md says "the UI guard is the real protection". This RPC is therefore the **first** server-side balance guard in the product.

Also worth recording: the shipped transfer path has **no credit-card allow-negative escape**. `checkBalance(src, input.amount)` is applied to a credit-card source too, because a card's `balance` is its available credit. `p_allow_negative` exists for the *reversal* path (the `REVERSAL_NEEDS_NEGATIVE` hatch in `deleteTransaction`) and the future repair queue; the creation path always passes `false`, preserving today's behaviour precisely.

### 2.3 Idempotency

The transaction id is generated client-side (`uuid()` at `transactionStore.ts:947`) and is the primary key of `transactions` — so it is the natural idempotency key for the exact failure this file kills, "the call committed but the reply never arrived". A replay returns `{status:'ok', replay:true}` with the **current** balances and moves nothing. The check is taken *after* the row locks so two in-flight copies of the same retry serialise rather than race.

### 2.4 Locking

Repo rule (`supabase-migration-audit-p0-settlement-row-locks.sql:73-100`): **loans → accounts → emi_schedules**, and within a table, rows in ascending `id` order. This function touches only `accounts`, and takes both rows in one `ORDER BY id … FOR UPDATE` statement before any write. Two concurrent transfers over the same pair — including A→B racing B→A — cannot invert their lock order. It never touches `loans`, so it cannot form a cycle with `accept_linked_request` / `accept_settlement_request`.

### 2.5 Both app modes

- **full_tracker** — the only mode that reaches this path.
- **splits_only (ledger-only)** — **unreachable, confirmed not assumed.** A transfer requires two accounts and ledger mode has none; the branch's first guard is `if (!src || !dest) throw new Error('Account not found')`; and unlike `expense` / `loan_given` / `loan_taken` / `repayment`, `'transfer'` is **not** in `isSimpleModeBalanceBypassAllowed` (`transactionStore.ts:238-246`), so `checkBalance` is never waived for it either. The RPC keeps the property: a null or unknown account id raises `ACCOUNT_NOT_FOUND` rather than writing a row with both account ids null — the failure class `tasks/lessons.md` records. A regression test asserts it (`splits_only: a transfer is unreachable`).

---

## 3. The client side

`src/lib/supabaseDb.ts` gains one appended section: `atomicMoneyDb.transferAtomic()` — the RPC gateway, the error mapping above, and typed `code`s (`BALANCE_CONFLICT`, `INSUFFICIENT_BALANCE`, `ATOMIC_TRANSFER_UNAVAILABLE`).

`src/stores/transactionStore.ts` gains:

```ts
const ATOMIC_TRANSFER_ENABLED = import.meta.env.VITE_ATOMIC_TRANSFER === 'true';
```

and an `atomicTransfer(scope, leg)` helper beside `trackedBalanceDelta`. Inside `case 'transfer'`, everything before the money (account lookup, same-account guard, `checkBalance`, the cross-currency rate guard) is untouched and shared. Only the movement forks:

- **flag off** — the legacy two `trackedBalanceDelta` calls, byte-for-byte as before. This is what `transactionStore.test.ts` still exercises.
- **flag on** — one `transferAtomic` call; the store then **adopts the balances the server returned** (never recomputes them), and registers an inverse for the rest of the scope.

Everything after the fork is common: the `Transaction` object, the card-bill auto-settle, `trackedAddTransaction` (an **upsert**, so the server-written row is rewritten identically rather than duplicated — the branch pins `input.createdAt` first so the two writes agree to the millisecond), the activity entry, the reminder nudge.

On `BALANCE_CONFLICT` the helper refetches accounts once and retries — the same ladder `accountStore.updateBalance` already runs. A conflict means **nothing moved**, so there is nothing to compensate; two consecutive conflicts surface to the caller exactly as today.

The scope inverse is still a best-effort client compensation, and still fails in a total outage. What changed is that it now has **one** thing to undo instead of a half-applied pair, and the forward move can no longer be partially committed. That is the MF-01 failure, closed.

---

## 4. What Docker proved

`postgres:15` (**PostgreSQL 15.19** — the version Supabase projects commonly run), plus a Supabase-shaped scaffold in the style of [`APPLY-ORDER.md` §3](audit-2026-09/APPLY-ORDER.md): schemas `auth`/`extensions`, `auth.users`, `auth.uid()`/`auth.role()` reading `request.jwt.claim.sub`, roles `anon`/`authenticated`/`service_role`, `pgcrypto`; `accounts` + `transactions` with **every** column the historical migrations add (`person_id`, `receipt_path`, `related_investment_id`, `updated_at` + touch triggers, `deleted_at`), the prelaunch FKs, `apply_account_balance_delta` itself, and the `p1-money-bounds` CHECK constraints. Then the migration, then the suites.

| # | Scenario | Result |
|---|---|---|
| — | migration applies; V1–V4 self-verification | clean; `security_definer=t`, `search_path=public`, `auth_can=t / anon_can=f / public_can=f`, all 9 body-roll-call columns `t`, `p3-atomic-transfer: verification passed` |
| — | **re-apply** (idempotency) | clean, no duplicate objects |
| 1 | happy path, same currency (1000/0, move 250) | 750 / 250; **all 20 columns** of the row asserted field-by-field against the client contract, including `created_at` passthrough and the NULLs |
| 2 | stale expectation | `BALANCE_CONFLICT`, `DETAIL` carries the true 750/250, **nothing moved**; the client-shaped retry with fresh expectations then succeeds |
| 3 | insufficient (10 000 from 1 000) | `INSUFFICIENT_BALANCE`, `DETAIL` `{account_name:'Cash', available:1000, requested:10000}`, nothing moved |
| 4 | credit-card source | blocked without the escape (client parity); `p_allow_negative=true` lets the card go to −400 |
| 5 | cross-currency AED→PKR @76.5 | −100 / +7650, row `conversion_rate=76.5`; a lying `p_destination_amount` → `DESTINATION_AMOUNT_MISMATCH`; a missing rate → `CONVERSION_RATE_REQUIRED`; rate 999999 → `INVALID_CONVERSION_RATE`; **all three refusals moved nothing** |
| 6 | replay the same `p_transaction_id` | money moved **once**, one row, `{"replay":true}` with current balances; a replay carrying a stale expectation still short-circuits before the CAS |
| 7a | destination soft-deleted mid-flight | `ACCOUNT_NOT_FOUND`, **source untouched** — the MF-01 scenario, refused before any write |
| 7b | **mid-transaction failure** (trigger raising on the `transactions` INSERT, i.e. *after* both balance UPDATEs) | `SIMULATED_WRITE_FAILURE` and **both balance legs rolled back with the failed row**: 1000/0, zero rows. This is the proof — under the legacy path the source debit had already committed at this point |
| 8 | another user's account id | `ACCOUNT_NOT_FOUND`, neither side moved, no balance leaked |
| 9 | same account / negative / `NaN` / missing expectation / null account id | `SAME_ACCOUNT`, `INVALID_AMOUNT` ×2, `EXPECTED_BALANCE_REQUIRED`, `ACCOUNT_NOT_FOUND`; five refusals wrote nothing |
| 10 | no JWT | `NOT_AUTHENTICATED` |
| 11 | as role `authenticated` (RLS live) | succeeds; as `anon` → `permission denied for function transfer_between_accounts` |
| 12 | **two sessions, opposite directions** (A→B held open, then B→A) | the second session **blocked on the row locks for ~2s until the first committed**, then correctly returned `BALANCE_CONFLICT` with the post-A balances. **No deadlock** — the ascending-id lock order holds even though the two transfers run in opposite directions. Money moved exactly once. |

**30 in-session assertions, all PASS.** Plus, in the app: `npx vitest run` → **118 files / 1386 tests green**, including 11 new ones driving the flagged store path (`src/stores/transactionStoreAtomicTransfer.test.ts`) and the untouched legacy transfer tests. `npx tsc -b --noEmit` clean, `eslint` clean.

**Not proven by the harness** (same limitations `APPLY-ORDER.md` §7 records, plus one of ours):
- **PostgREST is absent** — every call was raw SQL. Named-argument binding for a 12-argument RPC, the `jsonb`→JS mapping, and whether `DETAIL` reaches `PostgrestError.details` on this Supabase version are **not** verified end to end. *This is the single highest-value thing to check in staging before enabling the flag.*
- The scaffold is a purpose-built subset, not a replay of all 41 historical migrations, so composition with the full production trigger/policy stack is inferred, not run.
- No PostgREST `max_rows`, no realtime, no `pg_net`.
- Production drift: nobody knows which of the 40+ migrations production actually has. Section 0 of the migration hard-checks the columns it needs and aborts with a named message, but that is a floor, not a schema audit.

---

## 5. Rollout

1. **Apply the migration.** `supabase-migration-p3-atomic-transfer.sql` in Supabase Studio. It is **safe ahead of the client**: it adds one function and nothing calls it while `VITE_ATOMIC_TRANSFER` is unset. Run Section 2 (V1–V4) and confirm `verification passed`.
2. **Staging smoke through PostgREST**, not psql: a real signed-in session, one same-currency transfer, one cross-currency, one deliberate conflict (move the balance in another tab first). Confirm the conflict's `details` arrives as JSON on the client. This is the gap the Docker run cannot close.
3. **Enable on web only** (`VITE_ATOMIC_TRANSFER=true` in Vercel, redeploy). Web is reversible in minutes; Android is a Play release with review latency, which is why it goes second.
4. **Watch** for one release cycle: `transactionStore.atomicTransfer.rpcFailed` in Sentry (`reportError` fires for every non-conflict failure), plus the migration's **V5 drift query** — transfer rows whose two account currencies disagree with their own `conversion_rate` — as the first row of the reconciliation surface L7 will grow. Zero rows is the expectation, before and after.
5. **Then Android**: `npm run build && npx cap sync android`, bump the version, hand the Gradle AAB build to the user (it cannot run in-agent). Per the repo's standing rule, the change is not done until both surfaces ship.
6. **Rollback** at any point is unsetting the flag and redeploying. The migration itself never needs reverting — an unused function is inert, and rows written by either path are identical.

---

## 6. The template — migrating the remaining branches

The pilot establishes a shape every subsequent branch copies:

1. **Read the branch end to end and write the artifact contract table first.** Every row, every balance, every mirror, every activity entry, for **both app modes**. This is where the value is: the table is the specification, and the failure mode `tasks/lessons.md` records (a vanished payment record) is an artifact nobody enumerated.
2. **One RPC per user-visible action**, not per table write. Signature carries the client-generated id (idempotency), the expected values (compare-and-swap), and the same amounts the client already computes.
3. **Lock in the repo order** (loans → accounts → emi_schedules), ascending `id`, in one statement, before any write.
4. **Reuse the error tokens the client already parses.** A new token means new client-side branching, which means new bugs. `BALANCE_CONFLICT` and `LOAN_REMAINING_CONFLICT` already have refetch-and-retry ladders.
5. **Leave the audit trail client-side.** Activity logging, reminders and mirrors are best-effort by design; moving them into the transaction would make an audit-log failure roll back money — the opposite of the current, correct, rule.
6. **Flag it**, default off, migration first, web first, Android second.
7. **Prove it in Docker** with the six shapes: happy, conflict, guard-refusal, cross-currency, replay, and a **mid-transaction failure** (a trigger that raises after the first write is the cheapest way to prove all-or-nothing).

### Order, by risk

| # | Branch | Legs today | Why this order | Size |
|---|---|---|---|---|
| **1** | `transfer` ✅ *(the pilot)* | 2 balances + 1 row | Two symmetric balance legs and nothing else — the smallest complete instance of the failure. | done |
| **2** | `repayment` (full-tracker, no card credit) ✅ *(§7-9 below)* | 1 balance + `apply_loan_remaining_delta` + N EMI status marks + 1 row | **Promoted ahead of `goal_contribution`**: it is the highest-risk multi-leg flow in the switch (three tables, two different optimistic locks) and it is the branch `tasks/lessons.md` already records losing a payment record. Doing it second means the template is proven against the hard case, not only the easy one. | done |
| **3** | `goal_contribution` *(now next)* | 1 balance + goal `saved_amount` (snapshot-based) + 1 row | Small, and the only one whose compensation is **snapshot**-based rather than delta-based (`rollback restores the exact prior savedAmount`) — precisely the shape that clobbers a concurrent write. Needs a `goals.saved_amount` CAS first, modelled on `apply_loan_remaining_delta`. | S |
| **4** | `loan_given` / `loan_taken` ✅ *(§12-14 below)* | 1–2 balances + loan **creation** + 1 row | Adds a row to a second table inside the transaction, and `loan_taken` has the cash-advance card leg. Also the ad-hoc-split entry point, so the blast radius of a mistake is wider. **Promoted ahead of `goal_contribution`** for the same reason `repayment` was: the cash advance is the only *four*-leg flow left, and the branch is the one that can take money out of a wallet leaving nothing at all behind. | done |
| **5** | card-bill pay (the `transfer` branch's credit-card tail) | N loan repayments + N ledger rows, over a statement-allocation plan | **Last, deliberately.** The allocation (`allocateBillPayment`, `clampCardCredit`) is real business logic with its own tested engine; porting it to plpgsql would fork the source of truth. The right shape is *plan on the client, apply on the server*: the client computes the plan, the RPC applies it in one transaction. That is a bigger design decision than the four above, and it should be made with the pilot's operational record in hand. | L |

Branches that need **no** RPC: `income`, `expense`, `opening_balance` and `adjustment` are single-leg — one balance write plus one row. They still have a (much narrower) window where the row insert fails after the balance moved, so they are worth a shared `record_single_leg_entry()` eventually, but they cannot leave money *half-moved between two accounts*, which is the finding.

### What this does **not** solve

- **Offline.** An atomic RPC still needs a connection. M1's other half — persisting pending work and replaying it (the outbox, or a compensation mini-queue in Dexie) — is a separate decision, and the honest interim answer remains "Hisaab needs a network to record money".
- **The god store.** H-3 (`processTransaction`, a 640-line 12-case switch) shrinks only as branches move out; the pilot removed two lines from it and added a helper. The structural win arrives around branch 4.
- **Cross-user flows.** Linked requests and group settlements already have server-side RPCs with row locks (`audit-p0-settlement-row-locks`); they are a different programme.

---

# Step 2 — the full-tracker loan repayment

**Written:** 2026-09-02 · **Status:** built, Docker-validated on PostgreSQL 15.19, **flag OFF, migration not yet applied to production**

`supabase-migration-p3-atomic-repayment.sql` · `VITE_ATOMIC_REPAYMENT` · `src/lib/repaymentAtomicPlan.ts` (+ tests) · `src/stores/transactionStoreAtomicRepayment.test.ts`

## 7. Why this branch, and why second

The pilot fixed a two-leg flow. The repayment branch is a **four-leg** one, spanning three tables and **two different optimistic locks**, each its own round-trip:

1. `apply_account_balance_delta(account, ±amount, expected)` — commits.
2. `apply_loan_remaining_delta(loan, −amount, expected)` — **times out.**
3. `emi_schedules.status = 'paid'` × N — never runs.
4. `transactions` INSERT (the record) — never runs.

Server truth afterwards: **the account moved, the loan did not, and there is no row saying why.** That is the 2026-07-18 incident `tasks/lessons.md:6-13` records ("bulk repayment left no record") in its full-tracker form — with a corrupted balance on top. `audit-p0-loan-concurrency.sql` closed the *lost update* on leg 2; it never made legs 1 and 2 atomic **with each other**.

It was promoted ahead of `goal_contribution` deliberately: proving the template against the hardest branch is worth more than proving it twice against easy ones.

## 8. The artifact contract

The full table lives in the migration header. The split:

| # | Artifact | Owner after step 2 |
|---|---|---|
| 1 | **one** `accounts.balance` — destination for a loan `given`, source for one `taken` | **server**, in the transaction |
| 2 | `loans.remaining_amount` **+** `loans.status` | **server**, same transaction (clamp at 0, 2dp, status derived in the same UPDATE — byte-for-byte `apply_loan_remaining_delta`) |
| 3 | `emi_schedules.status='paid'` for every covered instalment | **server**, same transaction — from a client-computed id list the server **re-validates** (ownership + loan membership) before marking |
| 4 | `transactions` row (20 columns, `type='repayment'`) | **server**, same transaction |
| 5-8 | Dexie mirrors (`transactions`, `accounts`, `loans`) + Zustand state in four stores | client, post-commit, adopting the server's figures |
| 9 | `activity_log` `loan_settled` (only on 0 remaining, only if not already settled) | client, post-commit, best-effort — unchanged |
| 10 | `activity_log` `emi_paid` ×1-2 (the targeted instalment, then the covered set) | client, post-commit, best-effort — unchanged, **including the two-entry structure** |
| 11 | `activity_log` `transaction_created` | client, post-commit — unchanged |
| 12 | reminder reschedule | client, post-commit — unchanged |
| 13 | **cash-advance CARD CREDIT leg** | **client, legacy path — OUT OF SCOPE**, see below |

### 8.1 What is deliberately not covered

A repayment against a loan that began as a **credit-card cash advance** credits the card as well as debiting the paying account: two account legs plus `clampCardCredit`'s headroom rule and the `cardCreditedAmount` internal note. `record_loan_repayment` takes exactly **one** account id and cannot express it. The client keeps that case on the legacy path (`useAtomicHere = ATOMIC_REPAYMENT_ENABLED && !(cashAdvanceCard && cardCredit.credited > 0)`), a regression test pins it, and the migration header says so in the artifact table so nobody later assumes coverage the function does not have. It joins branch 5 (card-bill pay), where the same *plan-on-the-client, apply-on-the-server* decision has to be made once.

### 8.2 Error contract — only tokens the client already speaks

| Token | Meaning | Client behaviour |
|---|---|---|
| `BALANCE_CONFLICT` | the account CAS was stale | byte-identical to `apply_account_balance_delta`; `DETAIL` carries the true balance |
| `LOAN_REMAINING_CONFLICT` | the loan CAS was stale | byte-identical to `apply_loan_remaining_delta`, which `loansDb.applyRemainingDelta` already maps to a coded `Error` and `loanRemainingDelta.ts` already has a ladder for; `DETAIL` carries the true remaining |
| `LOAN_NOT_FOUND` | gone, deleted, or not yours | same token as the loan CAS → `tStatic('err_loan_gone')`, never retried |
| `INSUFFICIENT_BALANCE` | the server half of `checkBalanceForTransaction` | `DETAIL` rebuilds the identical bilingual `err_insufficient` string |

The retry ladder is the **union** of the two the legacy path already ran, and keeps both rules: refetch **both** sides once, then retry — but only if the fresh remaining still passes `requireRemainingAtLeast = min(amount, remainingBefore)`. Blindly replaying past that floor is how a 500 payment reduces a now-200 loan by 200 while the row still says 500 — audit F-2 exactly. That predicate is a pure, tested function (`canRetryRepayment`).

### 8.3 Two corrections worth recording

1. **There are no `paid_at` / paid-amount semantics on EMI rows.** `emi_schedules` is `(id, user_id, loan_id, installment_number, due_date, amount, status, created_at)` and nothing more — the incremental-sync migrations added `updated_at`/`deleted_at` to `loans`, **not** here — and `emiSchedulesDb.update` is deliberately **status-only** (`supabaseDb.ts:1042-1047`). Marking an instalment paid is exactly one column write. Inventing a `paid_at` would have written a column `mapEmi` cannot read back.
2. **The cross-currency rate convention is not symmetric between the two directions.** A loan **given** converts `round(amount × rate, 2)`; a loan **taken** converts `round(amount ÷ rate, 2)` (`transactionStore.ts:1380` vs `:1410`). A single "multiply" implementation would silently mis-convert every repayment of a foreign-currency loan you took — by a factor of `rate²`. The server derives which convention applies from `loans.type` and cross-checks the client's own figure within 0.01 (`ACCOUNT_AMOUNT_MISMATCH`).

Also worth recording: an already-`paid` instalment id is **skipped, not refused** — that is exactly what `trackedMarkEmiPaid` does (`if (prevStatus === 'paid') return;`). Only a **foreign** id (another loan, another user) is refused, and that refusal happens before any write.

### 8.4 Locking

This is the first function in the repo to touch all three tables, so it is the reference implementation of the repo rule (`audit-p0-settlement-row-locks.sql:73-100`): **loans → accounts → emi_schedules**, ascending `id` within a table, all acquired before any write. It cannot invert order against `accept_linked_request` / `accept_settlement_request` (loans → accounts), `apply_loan_remaining_delta` (loans only), `apply_account_balance_delta` or `transfer_between_accounts` (accounts only).

### 8.5 Both app modes

- **full_tracker** — the only mode that reaches the RPC. Exactly one account id is non-null on the row; the other is `NULL` by design.
- **splits_only (ledger-only)** — **untouched, and provably so.** Ledger repayments go through `loanStore.applyRepayment`, which writes a row with **both** account ids null, applies the same loan CAS, logs its own activity and reconciles EMIs via `emiStore.reconcileCovered`. Not one line of that path changes, it never calls this RPC, and the RPC **refuses a null/empty account id** with `ACCOUNT_NOT_FOUND` so a ledger row can never be routed through it (Docker scenario 10, and a regression test).
  One subtlety reproduced faithfully: `'repayment'` **is** in `isSimpleModeBalanceBypassAllowed`, so a user who switched full_tracker → splits_only and still has accounts may legitimately push one negative. The client passes `p_allow_negative = true` in exactly that case and only that case; full tracker always passes `false`.

## 9. What Docker proved

`postgres:15` (**PostgreSQL 15.19**), Supabase-shaped scaffold in the style of [`APPLY-ORDER.md` §3](audit-2026-09/APPLY-ORDER.md): `auth`/`extensions`, `auth.users`, `auth.uid()`/`auth.role()` from `request.jwt.claim.sub`, roles `anon`/`authenticated`/`service_role`, `pgcrypto`; `accounts` / `loans` / `emi_schedules` / `transactions` with **every** historical column the RPC touches, the prelaunch FKs and touch triggers, RLS + policies, `apply_account_balance_delta` and `apply_loan_remaining_delta` verbatim, and the `p1-money-bounds` CHECK constraints. Then the migration, then the suites.

| # | Scenario | Result |
|---|---|---|
| — | migration applies; V1–V4 self-verification | clean; `security_definer=t`, `search_path=public`, `auth_can=t / anon_can=f / public_can=f`, all 13 body-roll-call columns `t`, `p3-atomic-repayment: verification passed` |
| — | **re-apply** (idempotency) | clean, no duplicate objects |
| 1 | happy path, loan **given** (bank 500, loan 1000, pay 250) | 750 / 750; **all 20 columns** of the row asserted field-by-field, including `created_at` passthrough, `related_person`/`person_id` from the loan, `source_account_id` NULL and the six NULLs |
| 2 | happy path, loan **taken** | account **debited** 500→250; the row carries `source_account_id` and a NULL destination |
| 3 | stale **loan** expectation | `LOAN_REMAINING_CONFLICT`, `DETAIL` carries the true remaining, **account and loan both untouched**, no row; the client-shaped retry then succeeds and moves each side exactly once |
| 4 | stale **account** expectation | `BALANCE_CONFLICT`, `DETAIL` carries the true balance, **and the loan is untouched too** — the leg order cannot half-apply |
| 5 | insufficient (10 000 from 250) | `INSUFFICIENT_BALANCE`, `DETAIL` `{account_name:'Cash', available:250, requested:10000}`; `p_allow_negative=true` then succeeds to −150 (the ledger bypass); a **credit** direction is never blocked by the guard |
| 6 | overpay clamp | loan → 0.00 + `'settled'` derived in the same statement; the account still moved the **full** amount; `loan_applied` reports the **clamped** 250, not the requested 400 — which is what the client's inverse gives back |
| 7 | cross-currency both ways | given: `round(7650 × 0.01307, 2)` credited, loan moves 7650 **PKR**; taken: `round(7650 ÷ 76.5, 2) = 100.00` debited. A lying `p_account_amount` → `ACCOUNT_AMOUNT_MISMATCH`, a missing rate → `CONVERSION_RATE_REQUIRED`, rate 999999 → `INVALID_CONVERSION_RATE`; **all three refusals moved nothing** |
| 8 | EMI marks | the covered prefix flips and `emi_marked` lists exactly those; an **already-paid** id is silently skipped (not an error, matching `trackedMarkEmiPaid`); an id from **another loan** → `EMI_SCHEDULE_INVALID` and **the loan, the account and the row are all untouched** |
| 9 | replay | money moved **once**, one row, `{"replay":true}` with current figures; a replay carrying stale expectations still short-circuits before either CAS; an id owned by another entry type → `TRANSACTION_ID_COLLISION` |
| 10 | **null / empty account id** | `ACCOUNT_NOT_FOUND` — a ledger repayment cannot be written here, and no row with both account ids null was produced |
| 11 | another user's loan / account, soft-deleted loan | `LOAN_NOT_FOUND` / `ACCOUNT_NOT_FOUND`; no balance leaked or moved |
| 12 | seven poisoned payloads (0, negative, `NaN`, 1e13, missing balance expectation, missing remaining expectation, empty tx id) | seven named refusals, **zero writes** |
| A | **mid-transaction failure** (trigger raising on the `transactions` INSERT, i.e. *after* the loan UPDATE, the account UPDATE **and** the EMI UPDATE) | `SIMULATED_WRITE_FAILURE` and **all four legs rolled back together**: balance 5000, loan 1200/`active`, zero instalments paid, zero rows. **This is the proof** — under the legacy path the account debit and the loan CAS had already committed independently by this point. The same call with the trigger removed then lands all four |
| A12 | destination account soft-deleted mid-flight | `ACCOUNT_NOT_FOUND`, **and the loan was never touched** — the legacy path had already CAS'd it |
| R | **two sessions, same loan and account** (A holds its transaction open, B calls) | B **blocked on the loan row lock for ~1.65 s** until A committed, then returned `LOAN_REMAINING_CONFLICT` with the post-A remaining in `DETAIL`. **No deadlock.** Money moved exactly once (750 / 750 / 1 row) |
| P | roles | as `authenticated` (RLS live) it succeeds; as `anon` → `permission denied for function record_loan_repayment`; no JWT → `NOT_AUTHENTICATED`; and even as `authenticated`, another user's loan → `LOAN_NOT_FOUND` (the `user_id = v_uid` predicate is the access control under DEFINER) |

**132 in-session SQL assertions, all PASS**, plus the role and race checks. In the app: `npx vitest run` → **126 files / 1537 tests green**, including 17 new pure-logic tests (`src/lib/repaymentAtomicPlan.test.ts`) and 20 driving the flagged store path (`src/stores/transactionStoreAtomicRepayment.test.ts`) — among them the consolidated multi-loan loop, the card-credit legacy fallback and the splits_only path. `npx tsc -b --noEmit` and `eslint` clean for these files.

**Not proven by the harness** (the pilot's §4 limitations, plus one of ours):
- **PostgREST is absent** — every call was raw SQL. Named-argument binding for a **13**-argument RPC including a `text[]`, the `jsonb`→JS mapping of `emi_marked`, and whether `DETAIL` reaches `PostgrestError.details` are **not** verified end to end. Highest-value staging check.
- The scaffold is a purpose-built subset, not a replay of all 41 historical migrations.
- Production drift: Section 0 hard-checks the 40 columns it needs and aborts with a named message, but that is a floor, not a schema audit.

## 10. Rollout (step 2)

1. **Apply `supabase-migration-p3-atomic-repayment.sql`** in Supabase Studio. Safe ahead of the client — it adds one function and nothing calls it while `VITE_ATOMIC_REPAYMENT` is unset. Run Section 2 (V1–V4) and confirm `verification passed`; V5/V6/V7 should return **zero rows**.
2. **Run V6 before enabling.** It is the F-2 corruption signature itself — loans whose recorded repayments exceed what the loan actually dropped. Rows here are *history*, written before `audit-p0-loan-concurrency` was applied; know the number before the flag goes on so any post-rollout row is unambiguous.
3. **Staging smoke through PostgREST**, not psql: a real signed-in session, one repayment of a loan given, one of a loan taken, one cross-currency in **each** direction, one with an EMI schedule, and one deliberate conflict (move the loan in another tab first). Confirm `details` arrives as JSON and `emi_marked` as an array.
4. **Enable on web only** (`VITE_ATOMIC_REPAYMENT=true` in Vercel, redeploy). Enable it **after** `VITE_ATOMIC_TRANSFER` has had a release cycle, not alongside it — two flags flipped together make an incident un-bisectable.
5. **Watch** for one release cycle: `transactionStore.atomicRepayment.rpcFailed` in Sentry, plus V5/V6/V7 as the reconciliation surface. Zero new rows is the expectation.
6. **Then Android**: `npm run build && npx cap sync android`, bump the version, hand the Gradle AAB build to the user.
7. **Rollback** is unsetting the flag and redeploying. The migration never needs reverting — an unused function is inert, and rows written by either path are identical.

## 11. What step 2 leaves open

- **The card-credit case** (§8.1) — still two client round-trips, still compensable only best-effort. It merges into branch 5.
- **The consolidated multi-loan repayment** is still N independent commits (`repaymentExecution.ts`'s committed-prefix model). Each iteration is now *individually* atomic, which is a real improvement — a mid-batch failure leaves whole repayments, never half ones — but "applied to 3 of 5" remains the honest report. Making the whole batch atomic is a different RPC and a different product decision.
- **The god store.** `processTransaction` gained a fork and a helper; the real shrink still arrives around branch 4.

---

# Step 3 — creating a loan (`loan_given` / `loan_taken`)

**Written:** 2026-09-02 · **Status:** built, Docker-validated on PostgreSQL 15.19 through the repo's own harness, **flag OFF, migration not yet applied to production**

`supabase-migration-p3-atomic-loan-create.sql` · `VITE_ATOMIC_LOAN_CREATE` · `src/lib/loanCreateAtomicPlan.ts` (+ tests) · `src/stores/transactionStoreAtomicLoanCreate.test.ts` · `supabase/tests/tests/7x-atomic-loan-create.sql`

## 12. Why this branch, and what it actually loses today

Steps 1 and 2 fixed flows that *move* money. This one **brings an obligation into existence**, and that is a different failure:

```
loan_given  (2 legs)
  1. apply_account_balance_delta(source, −amount, expected)   — commits
  2. loans INSERT                                             — TIMES OUT
  3. transactions INSERT                                      — never runs
```

Server truth: **the money left the wallet, no loan says who owes it, and no row says it ever happened.** Not a corrupted figure — a *disappeared* one. There is nothing for the user to find and nothing for a reconciliation query to match, because the only two artifacts that would have recorded the debt are the two that never landed.

The cash advance is worse, and is the only **four-leg** flow left in the switch:

```
loan_taken via a credit card
  1. apply_account_balance_delta(card, −amount, expected)     — commits
  2. apply_account_balance_delta(destination, +amount, exp.)  — TIMES OUT
  3. loans INSERT                                             — never runs
  4. transactions INSERT                                      — never runs
```

Available credit consumed; cash arrived nowhere; no record either side. That is MF-01's own scenario with a phantom card charge stacked on it — and step 2 explicitly deferred the *repayment* half of the card story, so leaving the *creation* half unprotected as well would have left the whole cash-advance lifecycle on the legacy path.

It was promoted ahead of `goal_contribution` for that reason.

## 13. The artifact contract

The full table lives in the migration header. The split:

| # | Artifact | Owner after step 3 |
|---|---|---|
| 1 | `accounts.balance` (primary) — source for a loan `given`, destination for one `taken` | **server**, in the transaction |
| 2 | `accounts.balance` (the cash-advance **card**) — `loan_taken` only | **server**, same transaction; both account rows locked in one ascending-`id` statement |
| 3 | `loans` row (12 columns, byte-for-byte `loansDb.add`) | **server**, same transaction — but only when `input.loanId` is absent; otherwise the entry attaches to an existing loan and nothing is created |
| 4 | `emi_schedules` rows | **server-capable, client-unused** — see §13.1 |
| 5 | `transactions` row (20 columns, `type='loan_given'`/`'loan_taken'`) | **server**, same transaction |
| 6-9 | Dexie mirrors (`transactions`, `accounts`, `loans`) + Zustand state in three stores | client, post-commit, adopting the server's figures |
| 10 | `activity_log` `loan_created` | client, post-commit, best-effort — unchanged, **including the exact string** |
| 11 | `activity_log` `transaction_created` | client, post-commit — unchanged |
| 12 | reminder reschedule | client, post-commit — unchanged |

### 13.1 Three corrections worth recording

1. **These branches do not write the EMI schedule at all.** The brief assumed they did. `emiStore.generateSchedule` is called by the **page** — `AddLoanModal.tsx:173-174` and `:195-196`, `QuickEntry.tsx:1205` — *after* `processTransaction` has already resolved, outside the `MutationScope` entirely. A failure there today leaves a funded loan with a partial or missing schedule and **nothing is rolled back**. The RPC therefore accepts a schedule (`p_emi`) and validates it in full — 1..N numbering, ids free, amounts summing to the loan within 0.01, the same tolerance `p1-money-bounds` uses everywhere — but the shipped client sends `null`, so behaviour is byte-for-byte identical today. Moving the page's call into `p_emi` is a one-line client change; the server half is built and tested. **Recorded so nobody assumes the gap is closed — it is closable, not closed.** Migration verification query **V7** counts the loans this already broke.

2. **There is no `due_date` on `loans`.** The brief asked for `p_due_date`. `loans` is `(id, user_id, person_name, type, total_amount, remaining_amount, currency, status, notes, created_at)` plus `person_id`, `loan_pair_id`, `updated_at`, `deleted_at` — nothing else. Due dates live only on `emi_schedules.due_date`, a TEXT `yyyy-MM-dd`. A `p_due_date` would have written a column `mapLoan` cannot read back — the same shape of mistake as step 2's invented `paid_at`.

3. **Loan creation has no cross-currency case.** The brief asked for a `p_conversion_rate`, and step 2 needed one badly (with an asymmetric convention). Here the loan takes its currency **from the funding account** (`transactionStore.ts:1540`, `:1571`) and a cash-advance card is required to match it (`:1580`). There is no second currency to convert between, and the client writes `conversionRate: null` on every one of these rows. The parameter is kept for signature symmetry and a non-null value is **refused** (`CONVERSION_RATE_NOT_APPLICABLE`) rather than silently written; **V6** watches production for any loan-creation row that carries a rate or touches a foreign-currency account.

A fourth, smaller one: `p_emi` is `JSONB` (a JSON array), **not** `jsonb[]` as the brief specified. A Postgres array-of-jsonb has no natural representation through PostgREST's named-argument binding, and §4 already flags `text[]` binding as the pilot's single highest staging risk — doubling it for no gain would have been the wrong trade.

### 13.2 Error contract — only tokens the client already speaks

| Token | Meaning | Client behaviour |
|---|---|---|
| `BALANCE_CONFLICT` | either account's compare-and-swap was stale | byte-identical to `apply_account_balance_delta` and to `transfer_between_accounts`; `DETAIL` carries `{account_id, account_balance, expected_account_balance}`. Raised for **either** account — the client's ladder refetches all of them anyway. |
| `INSUFFICIENT_BALANCE` | the server half of `checkBalanceForTransaction` | `DETAIL` rebuilds the identical bilingual `err_insufficient` string. Applied to a credit-card source too, exactly as `checkBalance` is today. |
| `LOAN_NOT_FOUND` | the loan being **attached to** is gone | same token as the loan CAS → `tStatic('err_loan_gone')`, never retried |

Everything else is a poisoned payload, unreachable from the shipped client: `NOT_AUTHENTICATED`, `INVALID_TRANSACTION_ID`, `INVALID_LOAN_ID`, `INVALID_LOAN_TYPE`, `INVALID_AMOUNT`, `INVALID_PERSON`, `ACCOUNT_NOT_FOUND`, `SAME_ACCOUNT`, `EXPECTED_BALANCE_REQUIRED`, `CURRENCY_MISMATCH`, `CONVERSION_RATE_NOT_APPLICABLE`, `INVALID_CASH_ADVANCE`, `LOAN_ID_COLLISION`, `LOAN_MISMATCH`, `EMI_PLAN_INVALID`, `EMI_PLAN_MISMATCH`, `EMI_ID_COLLISION`, `TRANSACTION_ID_COLLISION`.

Two of those are worth naming as **tightenings**, not ports:

- **`LOAN_ID_COLLISION`.** `loansDb.add` is an `upsert`, so on the legacy path a repeated loan id silently **overwrites a live loan**. The RPC refuses instead. Nothing in the app can produce one; a curl can.
- **`LOAN_MISMATCH`.** When an entry attaches to an existing loan, the server cross-checks the loan's `type` and `currency` against the payload's. Without it, a caller could post `p_type='taken'` against a loan you *gave* and turn a debit into a free credit.

### 13.3 Locking

`loans` → `accounts` → `emi_schedules`, ascending `id` within a table (`audit-p0-settlement-row-locks.sql:73-100`).

- The loan row is locked **only when attaching**; a loan being created has no row to lock, and its `INSERT` is itself the serialisation point via the primary key.
- **Both** account rows are taken in **one** `WHERE id = ANY(…) ORDER BY id … FOR UPDATE`, so two concurrent cash advances over the same card/account pair cannot invert their order, and a cash advance racing a `transfer_between_accounts` over the same two accounts cannot deadlock with it — the pilot takes the identical ascending-`id` order.
- `emi_schedules` is insert-only, and last.

### 13.4 Idempotency

`p_transaction_id` is the primary key of `transactions` and the client generates it (`transactionStore.ts:1321`), so it is the natural key for "the call committed but the reply never arrived". The replay check is taken **after** the row locks, so two copies of the same retry serialise. A replay returns `{status:'ok', replay:true}` with the current balances and the loan id, and moves nothing — **even when it carries the original, now-stale, expectations**.

`LOAN_ID_COLLISION` is the second guard, and the reason the retry ladder is safe at all: a `BALANCE_CONFLICT` must leave **no** loan behind, or the client's retry would immediately collide with the loan its own failed attempt created. A regression test pins exactly that (`a conflict writes NOTHING`).

### 13.5 Both app modes

- **full_tracker** — the only mode that reaches this RPC.
- **splits_only (ledger-only)** — **untouched, and confirmed rather than assumed.** In ledger mode both entry points bypass `processTransaction` entirely and call `loanStore.createLoan` directly: `AddLoanModal.tsx:164-165` (`if (isLedgerOnlyMode)`) and `QuickEntry.tsx:750`/`:850` (`if (isLedgerOnlyPersonFlow)`). That path writes **only a `loans` row** — no account leg, and **no `transactions` row at all**. Not one line changes, and the RPC **refuses a null/empty account** with `ACCOUNT_NOT_FOUND` so a ledger loan can never be routed through it. The RPC deliberately does **not** accept a null account "for ledger mode": no ledger path uses it, and accepting one would create a second, silent way to write a loan — the exact class of failure `tasks/lessons.md` records.
  One subtlety reproduced faithfully: `'loan_given'` and `'loan_taken'` **are both** in `isSimpleModeBalanceBypassAllowed` (`transactionStore.ts:249-257`), so a user who switched full_tracker → splits_only and still has accounts may legitimately push one negative. The client passes `p_allow_negative = true` in exactly that case and only that case; full tracker always passes `false`.

## 14. What the harness proved

Unlike steps 1 and 2 — which were validated in an ad-hoc Docker scaffold — step 3 runs inside the repo's own trust-boundary suite (`docs/testing-the-trust-boundary.md`): `postgres:15`, `scaffold.sql`, then the **entire 64-file corpus in `apply-order.txt`** (this migration is now entry #64), then the assertions, as role `authenticated` with a real JWT subject. That is a strictly stronger environment: the function is composed against every historical trigger, policy and CHECK the repo ships, not a purpose-built subset.

`supabase/tests/tests/7x-atomic-loan-create.sql`, its own user G so nothing can disturb the older fixtures:

| # | Scenario | Result |
|---|---|---|
| — | migration applies; Section 0 preconditions; V1–V4 self-verification | clean; `p3-atomic-loan-create: verification passed` |
| 0 | catalog shape | `security_definer=t`, `search_path=public`, `auth_can=t / anon_can=f` |
| 1 | happy path, loan **given** (bank 1000, lend 250) | 750; **all 12 columns** of the loans row and **all 20** of the transactions row asserted field-by-field, including `created_at` passthrough, the visible-note-only rule and the six NULLs |
| 2 | happy path, loan **taken** | account **credited** 750→1250; the row carries `destination_account_id` and a NULL source |
| 3 | **cash advance** (card 16500, bank 1250, draw 1500) | card → 15000 **and** bank → 2750 in one call; the row reads card → receiver, which is what `findCashAdvanceCardForLoan` looks for. Three guard refusals (non-card source, currency mismatch, card on a `given`) — **all wrote nothing** |
| 4 | the cross-currency question | a rate → `CONVERSION_RATE_NOT_APPLICABLE`; a currency disagreeing with the account → `CURRENCY_MISMATCH`; a PKR account funds a **PKR** loan and a **PKR** row, proving the currency is derived and not defaulted |
| 5 | stale expectation, on **either** account | `BALANCE_CONFLICT` both times, **and no orphan loan** — the property that makes the client's retry safe. Missing expectation → `EXPECTED_BALANCE_REQUIRED` |
| 6 | insufficient (10 000 from 250) | `INSUFFICIENT_BALANCE`, nothing written; `p_allow_negative=true` then takes the account to −150 (the splits_only bypass) |
| 7 | **EMI plan** | a sound 4×300 schedule lands as 4 `upcoming` rows in the same transaction; a plan summing to 600 against a 1200 loan → `EMI_PLAN_MISMATCH` with **zero of the four artifacts written**; the 333.33/333.33/333.34 rounding tail is accepted; 1..N violations → `EMI_PLAN_INVALID`; a reused id → `EMI_ID_COLLISION` |
| 8 | replay | `{"replay":true}` even carrying the original stale expectation; money moved **once**, one loan, one row. `LOAN_ID_COLLISION` refuses a create over a live loan and **the live loan is not overwritten**. Attaching (`p_create_loan=false`) writes the row without a second loan; a flipped direction → `LOAN_MISMATCH` |
| 9 | **mid-transaction failure** (trigger raising on the `transactions` INSERT — i.e. after the loan INSERT, **both** balance UPDATEs and the EMI INSERT) | `SIMULATED_WRITE_FAILURE` and **all five legs rolled back together**: bank 4850, card 15000, zero loans, zero instalments, zero rows. **This is the proof** — under the legacy path the card charge and the wallet credit had already committed independently by this point. The identical call with the trigger removed then lands all five |
| 10 | ledger guard + ownership | null / whitespace / soft-deleted / **another user's** account → `ACCOUNT_NOT_FOUND`, no balance leaked; seven poisoned payloads (empty tx id, empty loan id, `'lent'`, blank person, 0, `NaN`, 1e13) → seven named refusals, **zero writes** |
| 11 | the shipped drift watches | V5, V6 and V7 all return zero rows over everything the suite wrote; closing balances reconcile to the cent |
| P | roles | as `anon` → `permission denied for function create_loan_with_leg`; as `authenticated` with no JWT subject → `NOT_AUTHENTICATED` |

**65 new SQL assertions; the whole suite is 248 assertions, 0 failed** (`bash supabase/tests/run.sh`). In the app: `npx vitest run` → **131 files / 1650 tests green**, including 19 new pure-logic tests (`src/lib/loanCreateAtomicPlan.test.ts`) and 16 driving the flagged store path (`src/stores/transactionStoreAtomicLoanCreate.test.ts`) — among them the cash advance, the double-leg rollback, the attach-to-existing shape, the internal-note stripping rule and the splits_only path. `transactionStore.test.ts` gained a throwing `loanCreateAtomic` stub, so "the legacy path is byte-for-byte unchanged with the flag off" is asserted, not asserted-by-hope. `npx tsc -b --noEmit` and `eslint` clean for these files.

**Not proven by the harness** (the same limitations `docs/testing-the-trust-boundary.md` records):

- **PostgREST is absent** — every call was raw SQL. Named-argument binding for a **20**-argument RPC including a `jsonb` array, the `jsonb`→JS mapping of `emi_inserted`, and whether `DETAIL` reaches `PostgrestError.details` are **not** verified end to end. Highest-value staging check, as in steps 1 and 2.
- **Concurrency is sequential.** The ascending-`id` two-account lock is verified *statically* (V3/V4 assert the `ORDER BY id`), not by two live sessions racing a cash advance against a transfer. The pilot ran that two-session check by hand; this step did not.
- **Production drift.** Section 0 hard-checks the 45 columns it needs and aborts with a named message, but that is a floor, not a schema audit.

## 15. Rollout (step 3)

1. **Apply `supabase-migration-p3-atomic-loan-create.sql`** in Supabase Studio. Safe ahead of the client — it adds one function and nothing calls it while `VITE_ATOMIC_LOAN_CREATE` is unset. Run Section 2 (V1–V4) and confirm `verification passed`.
2. **Run V7 before enabling.** It counts loans whose EMI schedule does not add up to them — the orphan the *page's* post-hoc `generateSchedule` call already produces (§13.1). Know the number before the flag goes on. It should stop growing only once that call moves into `p_emi`, which this step does **not** do.
3. **Staging smoke through PostgREST**, not psql: a real signed-in session, one `loan_given`, one plain `loan_taken`, one **cash advance**, one attach-to-existing (an ad-hoc split), and one deliberate conflict (move the balance in another tab first). Confirm `details` arrives as JSON.
4. **Enable on web only** (`VITE_ATOMIC_LOAN_CREATE=true` in Vercel, redeploy) — and **after** `VITE_ATOMIC_TRANSFER` and `VITE_ATOMIC_REPAYMENT` have each had their own release cycle. Three flags flipped together make an incident un-bisectable.
5. **Watch** for one release cycle: `transactionStore.atomicLoanCreate.rpcFailed` and `transactionStore.atomicLoanCreate.deltaFork` in Sentry — the second fires when the server's account deltas disagree with `src/lib/loanCreateAtomicPlan.ts`'s copy of the same rule, which would mean the two halves have forked. Plus V5/V6/V7 as the reconciliation surface. Zero rows is the expectation.
6. **Then Android**: `npm run build && npx cap sync android`, bump the version, hand the Gradle AAB build to the user.
7. **Rollback** is unsetting the flag and redeploying. The migration never needs reverting — an unused function is inert, and rows written by either path are identical.

## 16. What step 3 leaves open

- ~~**The EMI schedule is still written by the page.**~~ **Closed — see §17 below.** The pages now plan the instalments before the money call and the RPC inserts them in the same transaction.
- **The cash-advance *repayment*** (step 2 §8.1) is still on the legacy path. Creation is now atomic; settling it is not. Both halves converge on branch 5's *plan on the client, apply on the server* decision.
- **`goal_contribution`** is now the last simple branch, and still needs a `goals.saved_amount` CAS of its own before it can be ported.
- **The god store.** `processTransaction` is down two multi-leg sequences and up three helpers. The structural shrink the audit asked for (H-3) arrives when the branches move out of the switch entirely, which none of these three steps has done.

---

# Step 3, addendum — the EMI schedule moves inside the transaction

**Written:** 2026-09-02 · **Status:** built, unit-tested, **flag still OFF, migration still not applied to production**

`src/lib/emiPlan.ts` (+ tests) · `src/stores/emiStore.ts` · `src/pages/AddLoanModal.tsx` · `src/pages/QuickEntry.tsx` · the `loan_given`/`loan_taken` branches of `src/stores/transactionStore.ts` · `src/stores/transactionStoreAtomicLoanCreate.test.ts`

## 17. The gap §13.1 named, closed

Step 3 shipped an RPC that **accepts** a schedule (`p_emi`, fully validated) while the client kept sending `null` — because the pages called `emiStore.generateSchedule` **after** `processTransaction` had already resolved, outside the `MutationScope` entirely:

```
1. create_loan_with_leg(...)      — commits: balance, loan, row
2. emiStore.generateSchedule(...) — TIMES OUT
```

Server truth afterwards: a funded loan with **no instalments**, and nothing rolled back. The loan detail page shows a plan the user configured and never got; `uncoveredToPaidIds` has nothing to walk; the reminder engine has no due dates. Migration verification query **V7** counts the loans this already produced. That is the failure this addendum removes.

### 17.1 Why the fix needed a new pure module

`generateSchedule` **computed and wrote in one step**, so there was no way to hand the plan to the RPC — the only thing that could produce instalments also inserted them. `src/lib/emiPlan.ts` separates the two:

```ts
planEmiRows({ totalAmount, installments, startDate, dueDates?, makeId? }): EmiPlanRow[]
// EmiPlanRow = { id, installmentNumber, dueDate, amount }
```

The arithmetic is byte-identical to what `generateSchedule` has always run (equal instalments at 2dp, the **last** absorbing the rounding tail so the plan always sums to the loan; `dueDates[i]` wins over the monthly walk from `startDate`, which is how a statement-native cash advance anchors to the card's statement day). `generateSchedule` now *calls* it and stamps on the `loanId` + `status` — so the legacy path and the atomic path share one source of truth, and `emiPlan.test.ts` pins the parity against a verbatim copy of the pre-extraction implementation over three fixtures (evenly divisible, rounding tail, statement-day anchored).

Two deliberate shapes:

- **A planned row carries no `loanId` and no `status`.** The atomic path has to plan *before* the loan id exists (the server mints the row and echoes the id back in `loan_id`), and `emi_schedules.status` is always `'upcoming'` at creation. Leaving both out makes `EmiPlanRow` structurally identical to `LoanEmiPlanRow`, so step 3's existing `emiPlanProblem` / `toEmiPayload` consume it unchanged.
- **`makeId` is injectable**, defaulting to the same `uuid()` `generateSchedule` always used. Only tests pass it — asserting a `p_emi` payload field-for-field needs predictable ids.

### 17.2 The wire shape

`toEmiPayload` produces exactly what `supabase/tests/tests/7x-atomic-loan-create.sql` §7 binds — snake_case, four keys, nothing else:

```json
[{"id":"...","installment_number":1,"due_date":"2026-10-01","amount":300},
 {"id":"...","installment_number":2,"due_date":"2026-11-01","amount":300}]
```

`p_emi` is `JSONB` (a JSON array), not `jsonb[]` — CORRECTION 4 in §13.1. **No plan sends `null`, never `[]`**: the two are the same to the server, but `null` is what "no plan" has always meant on the wire and keeping them unambiguous costs nothing.

### 17.3 The client path, end to end

1. **The page plans first.** `AddLoanModal` calls `planEmiRows` when the qist section is on and complete; `QuickEntry` does the same, deriving the cash-advance statement dates from `statementInstalmentDates` through a small factory so the **legacy** path still reads its clock at exactly the moment it always did rather than inheriting a value hoisted above a network round-trip.
2. **It rides in as `input.emiPlan`** — a new optional field on `LoanGivenInput` / `LoanTakenInput`, ignored entirely when the flag is off.
3. **The branch forwards it** as `AtomicLoanCreateLeg.emiRows`, validated once by `prepareEmiPayload` before the first attempt (never re-planned between a conflict and its retry — a second plan would mint a second set of ids and orphan the first).
4. **The server inserts the rows** in the same transaction as the balance, the loan and the transactions row.
5. **The client adopts from `result.emiInserted`**, *not* from the plan it sent: the server is the only thing that knows which rows exist, and a mirror claiming instalments Postgres does not have is precisely the desync `reconcileCovered` exists to clean up after. A replay reports an empty list, so a retry duplicates nothing.
6. **The page skips its own `generateSchedule`** — by asking `loanScheduleAlreadyCreated(loanId)`, which reads the *outcome* rather than the flag. A plan the store declined to forward therefore still gets a client-side schedule instead of silently getting none: the same failure, reintroduced one level up, is what that helper prevents.

The compensation grew a fifth leg: on a post-RPC failure the instalments are deleted (`deleteByLoan`) **before** the loan, and only for a loan this call created — `emiSchedulesDb` exposes no per-id delete, so that restriction is what keeps the inverse from wiping a pre-existing schedule.

### 17.4 What is deliberately *not* forwarded

**A plan attached to an existing loan** (`input.loanId` set — the ad-hoc-split / re-entry shape). It is dropped, for two reasons: a second schedule on a loan that already has one is not a product behaviour anyone asked for, and the inverse above could only unwind it by deleting the whole loan's schedule, which is destructive for instalments that were already there. Because it is *dropped* rather than *consumed*, `loanScheduleAlreadyCreated` stays false and the page generates one client-side — nothing is lost silently. A regression test pins it.

### 17.5 Error contract — one new client-side code

| Token (server) | Client |
|---|---|
| `EMI_PLAN_INVALID` / `EMI_PLAN_MISMATCH` / `EMI_ID_COLLISION` | all three map to one coded `EMI_PLAN_REJECTED` whose message is the bilingual `err_emi_plan_rejected` — the single new i18n key. The server's own token rides along as `serverToken` for Sentry only. |

The client runs `emiPlanProblem` (its copy of the same rules) **before** the call, so the common case is refused without a round-trip on 3G — and both refusals produce the identical string. The message says *nothing was saved*, because that is true: the RPC is atomic, so a refusal wrote **none** of the five artifacts, and the client never reached a single local write either. Never retried — a blind retry without the plan would create the loan the user was just told did not exist.

### 17.6 Both app modes

- **full_tracker** — the only mode that reaches the RPC, and now the only one whose schedule is written server-side.
- **splits_only (ledger-only)** — **untouched, and confirmed rather than assumed.** Both entry points bypass `processTransaction` entirely (`AddLoanModal`'s `if (isLedgerOnlyMode)` branch calls `loanStore.createLoan` then `generateSchedule`; QuickEntry's ledger branch creates the loan and offers no schedule at all). `generateSchedule` is unchanged in behaviour — only its arithmetic moved into `planEmiRows` — so ledger mode still writes its instalments client-side, and the RPC still refuses a null account (`ACCOUNT_NOT_FOUND`) so a ledger loan can never be routed through it. A regression test walks the whole ledger sequence and asserts zero RPC calls with four instalments written.

### 17.7 What this changes for the artifact table

Row **4** of §13's table flips:

| # | Artifact | Owner |
|---|---|---|
| 4 | `emi_schedules` rows | ~~server-capable, client-unused~~ → **server**, same transaction, when the user configured a plan on a loan the entry creates. Client-side (`generateSchedule`) in every other case: flag off, ledger mode, attach-to-existing. |

### 17.8 Verification

`npx vitest run` → **137 files / 1743 tests green**, including 12 new pure-logic tests (`src/lib/emiPlan.test.ts`, three of them the parity fixtures) and 8 new ones driving the flagged store path (`transactionStoreAtomicLoanCreate.test.ts`: the payload shape, adoption from `emi_inserted`, statement-day dates surviving intact, the local refusal, the *server* refusal leaving nothing behind, the five-leg rollback, attach-to-existing, and splits_only). `npx tsc -b --noEmit` and `eslint` clean.

**No new SQL.** `p_emi`'s validation was already built and Docker-proven in step 3 (scenario 7 of `supabase/tests/tests/7x-atomic-loan-create.sql`); this addendum only makes the client use it, and `emiPlan.test.ts` asserts the payload matches that suite's JSON field for field.

### 17.9 Open risks

- **PostgREST binding of `p_emi` is still unproven end to end.** §14 already flagged the `jsonb` array as part of the highest-value staging check; it now carries real data on every scheduled loan rather than always being `null`, so it moves from "unused parameter" to "on the critical path". Smoke a scheduled loan and a scheduled cash advance through a real signed-in session before enabling the flag.
- **V7 stops growing only after the flag is on.** Step 2 of §15's rollout said the orphan counter would keep climbing until this wiring existed. It exists — but the meter only changes when `VITE_ATOMIC_LOAN_CREATE=true` reaches users. Record V7's value immediately before flipping it.
- **`loanScheduleAlreadyCreated` reads the local store,** so it is only correct because the adoption in step 5 is synchronous with the RPC's return. If a future edit makes adoption lazy or moves it behind a refetch, the pages will start double-generating. The regression test that asserts `loanScheduleAlreadyCreated === true` right after a scheduled create is the tripwire.
- **A partial server insert is not representable today** (`p_emi` is all-or-nothing inside the transaction), so adoption filtering on `emi_inserted` is defence, not a tested path — the only way to exercise it would be a server that inserts a subset, which the function cannot do.
- **Android.** Per the standing rule this is not done until `npm run build && npx cap sync android` runs and the Gradle AAB build is handed to the user.

---

# Step 4 — the last two money-moving branches: `goal_contribution` and the whole credit-card story

**Written:** 2026-09-02 · **Status:** built, Docker-validated on PostgreSQL 15.19 through the repo's own harness, **flags OFF, migration not yet applied to production**

`supabase-migration-p3-atomic-goal-and-card.sql` · `VITE_ATOMIC_GOAL` + `VITE_ATOMIC_CARD_BILL` · `src/lib/goalContributionPlan.ts` and `src/lib/cardBillAtomicPlan.ts` (+ tests) · `src/stores/transactionStoreAtomicGoalCard.test.ts` · `supabase/tests/tests/7y-atomic-goal-and-card.sql`

## 18. Why these two, and what they actually lose today

These are branches **3** and **5** of §6's order table — the two the pilot left for last, for opposite reasons. `goal_contribution` was small but had the *worst-shaped* compensation in the switch; the card story was the *largest* flow and the one whose business logic could not be ported without forking a tested engine.

```
goal_contribution  (up to 4 legs)
  1. apply_account_balance_delta(source, −srcDeduct, expected)  — commits
  2. goals.saved_amount = <an ABSOLUTE figure>                  — TIMES OUT
  3. apply_account_balance_delta(storedIn, +amount, expected)   — never runs
  4. transactions INSERT                                        — never runs
```

Server truth: the wallet is lighter, the goal has not grown, no row says why. And leg 2 is worse than a missing write — it is an **absolute** write with no lock at all (`goalStore.addContribution` reads the local snapshot and writes `savedAmount + amount`), so two devices contributing to the same goal both read *S* and both write *S + x*, and one contribution vanishes. Its client compensation is **snapshot-based** ("put savedAmount back to what I read"), which is the one shape that *clobbers* a concurrent write — §6 called this out when it ordered the branches, and it is why this migration installs the first compare-and-swap `goals.saved_amount` has ever had.

```
card bill payment  (2 + 3N legs — the largest flow in the switch)
  1. apply_account_balance_delta(source, −amount, expected)     — commits
  2. apply_account_balance_delta(card,   +destAmt, expected)    — commits
  3. transactions INSERT (the transfer)                         — the tail
  then, PER cash-advance loan the card funded:
  4. apply_loan_remaining_delta(loan, −applied, expected)       — TIMES OUT
  5. emi_schedules status = 'paid' × M                          — never runs
  6. transactions INSERT (the ledger repayment row)             — never runs
```

Server truth: **the bill is paid but the loans it financed still say the money is owed** — so the app asks the user to pay the same debt a second time. That is the "Available 27,650 over Limit 16,500" double-credit disaster (`src/lib/cardCredit.ts:1-9`) reached from the other direction, and the 2026-07-18 "bulk repayment left no record" incident (`tasks/lessons.md:6-13`) in its card form.

```
cash-advance repayment crediting the card  (4 legs)
  1. apply_account_balance_delta(source, −srcDeduct, expected)  — commits
  2. apply_account_balance_delta(card,   +credited, expected)   — TIMES OUT
  3. apply_loan_remaining_delta(loan, −amount, expected)        — never runs
  4. emi marks + transactions INSERT                            — never runs
```

This is the case **step 2 explicitly deferred** (§8.1): `record_loan_repayment` takes exactly one account id and cannot express a second leg plus `clampCardCredit`'s headroom rule. Step 4 picks it up.

## 19. The artifact contracts

The full tables live in the migration header. The splits:

### 19.1 `contribute_to_goal`

| # | Artifact | Owner after step 4 |
|---|---|---|
| 1 | source `accounts.balance` (−`srcDeduct`) | **server**, in the transaction — and **skipped entirely** for the self-stored case, exactly as the client skips it |
| 2 | `goals.saved_amount` | **server**, same transaction, behind the **first CAS this column has ever had**; clamp and 2dp byte-for-byte `goalStore.addContribution` |
| 3 | stored-in `accounts.balance` (+`amount`) | **server**, same transaction; both account rows locked in one ascending-`id` statement |
| 4 | `transactions` row (20 columns, `type='goal_contribution'`) | **server**, same transaction |
| 5-6 | Dexie mirrors + Zustand in three stores | client, post-commit, adopting the server's figures |
| 7 | `activity_log` `transaction_created` | client, post-commit, best-effort — unchanged |
| 8 | reminder reschedule | client, post-commit — unchanged |

### 19.2 `pay_card_bill`, `p_row_type='transfer'` (paying a bill)

| # | Artifact | Owner after step 4 |
|---|---|---|
| 1-2 | source + card `accounts.balance` | **server**, in the transaction. The card credit is **deliberately unclamped** here (`cardCredit.ts:7-9`: an explicit "I moved money" is recorded as typed) |
| 3 | `transactions` row (`type='transfer'`) | **server**, same transaction |
| 4 | `loans.remaining_amount` + `status`, ×N | **server**, same transaction, each behind its own CAS; clamp + status derived in the same UPDATE |
| 5 | `emi_schedules.status='paid'`, ×M per loan | **server**, same transaction, from a client-computed id list the server **re-validates** (ownership + loan membership) |
| 6 | ledger `transactions` rows, ×N (both account ids **NULL**) | **server**, same transaction; the `[[HISAAB_META:…]]` note is built **client-side** and passed verbatim so the encoding cannot fork |
| 7-11 | mirrors, `loan_settled` / `emi_paid` activity, reminder | client, post-commit, best-effort — unchanged |

### 19.3 `pay_card_bill`, `p_row_type='repayment'` (the deferred card-credit leg)

| # | Artifact | Owner after step 4 |
|---|---|---|
| 1 | source `accounts.balance` (−`srcDeduct`) | **server**, in the transaction |
| 2 | card `accounts.balance` (+`clampCardCredit(...).credited`) | **server**, same transaction — and the client's clamped figure is **re-validated against the card's own headroom** |
| 3 | `loans.remaining_amount` + `status` | **server**, same transaction |
| 4 | `emi_schedules.status` (targeted + covered) | **server**, same transaction |
| 5 | `transactions` row (`type='repayment'`, source = wallet, destination = card, `cardCreditedAmount` in the note when the clamp bit partially) | **server**, same transaction — **one** row: the main row *is* the record, and the single plan line writes no second one |
| 6-9 | mirrors, activity, reminder | client, post-commit — unchanged |

### 19.4 Why one function, not two

The brief offered extending `record_loan_repayment`. It is not taken, and the reason is structural: that function is **step 2's shipped contract** — a 13-argument signature the client already binds by name, with its own migration file, verification block and Docker suite, already queued for production. PostgREST resolves RPCs by argument-**name** set, so adding parameters creates a second overload rather than replacing the first.

And the card leg lands inside `pay_card_bill` rather than in a function of its own because the two card flows are **one shape**: money leaves an account → some of it credits a card → cash-advance loan records are knocked down by a client-computed plan → instalments flip → rows are written. `p_row_type` is the only thing that differs. Splitting them would have duplicated ~300 lines of validation to express one branch.

### 19.5 The decision §6 asked for: **plan on the client, apply on the server**

§6 row 5 said the allocation "is real business logic with its own tested engine, and porting it to plpgsql would fork the source of truth". It is not ported. `allocateBillPayment` (`src/lib/cardStatement.ts`) and `clampCardCredit` (`src/lib/cardCredit.ts`) stay in TypeScript, behind their 30+ existing unit tests. What moved is the *plumbing*: the gather-the-inputs block was lifted out of the 640-line switch into `prepareCardBillPlan`, and **both the legacy path and the flagged path now consume it**, so they cannot drift. `transactionStore.test.ts`'s existing card-bill cases (a bill settles its advances, the clamped credit, the Available-over-Limit case, deleting a bill payment re-opens the loans) pin that extraction, and its `payCardBillAtomic` stub **throws**, so "the legacy path is byte-for-byte unchanged with the flags off" is asserted rather than hoped.

The server's job is to refuse a lying plan, and it does: Σ`applied` may not exceed what the payment credited (`PLAN_OVER_PAYMENT` — the money-minting shape), a repayment may not credit a card past its limit (`CARD_CREDIT_OVER_LIMIT`), every instalment must belong to its loan (`EMI_SCHEDULE_INVALID`), and a loan you *gave* can never be settled against a card bill (`PLAN_INVALID`).

### 19.6 Error contract — one new token, and one deliberate reuse

| Token | Meaning | Client behaviour |
|---|---|---|
| `BALANCE_CONFLICT` | a stale CAS on **any** account — **or on the GOAL** | byte-identical to `apply_account_balance_delta`. The goal branch's ladder refetches accounts **and** goals and retries once. **Reusing the token for the goal is deliberate**: §6 rule 4 is "reuse what the client already parses", and a `GOAL_SAVED_CONFLICT` would have been a fifth token with a fourth ladder. |
| `LOAN_REMAINING_CONFLICT` | a stale loan CAS in the plan | byte-identical to `apply_loan_remaining_delta`; `DETAIL` carries `{loan_id, loan_remaining}` so the client re-plans without a second fetch |
| `LOAN_NOT_FOUND` | a loan in the plan is gone | `tStatic('err_loan_gone')`, never retried |
| `INSUFFICIENT_BALANCE` | the server half of `checkBalance` | `DETAIL` rebuilds the identical bilingual string |
| **`GOAL_NOT_FOUND`** | **the one new token.** There was no goal equivalent of `err_loan_gone` because nothing server-side had ever refused a goal | modelled exactly on `LOAN_NOT_FOUND`: never retried, one new bilingual string (`err_goal_gone`) |

`CARD_BILL_PLAN_REJECTED` is a **client-side** union of the four plan refusals above, mapped to one new string (`err_card_bill_plan`). It is never retried — the plan is wrong, not stale.

**No retry floor on the goal, deliberately.** The repayment ladder needs `requireRemainingAtLeast` because a loan *clamps at zero* and a blind replay would overstate the reduction (audit F-2). A goal contribution is a pure `+amount` delta: replaying it against a fresh expectation adds exactly the same amount to whatever the truth now is. The card ladder keeps the floor, but only for `rowType='repayment'` — a bill payment's re-plan is self-limiting, because `allocateBillPayment` caps every line at its loan's remaining and the ledger row records the *recomputed* figure.

### 19.7 Four corrections worth recording

1. **The allocation engine is not ported, and must not be** — §19.5. The client plans; the server applies **and re-validates**.
2. **`goals` has no `deleted_at` and no `updated_at`.** It is `(id, user_id, title, target_amount, saved_amount, currency, stored_in_account_id, created_at)` plus `target_date`; the incremental-sync migrations added those columns to `accounts`/`transactions`/`loans`, **not here**. A `deleted_at IS NULL` predicate would match nothing, and a `saved_amount` write that also touched `updated_at` would write a column `mapGoal` cannot read back — the same shape of mistake as step 2's invented `paid_at` and step 3's invented `loans.due_date`. Section 0 raises a **warning** if a future migration adds `goals.deleted_at`, so the omission fails loudly rather than silently.
3. **`goals.stored_in_account_id` is a LABEL, not a foreign key.** It is `TEXT DEFAULT ''` with no FK, and the client's credit leg is guarded by `if (linkedAccount)` — a lookup in the *local* store. So "the goal names an account that no longer exists" is a legitimate, reachable state that must contribute **without** a credit leg rather than fail. The RPC reproduces it: a miss means "no linked leg", not an error. The client sends the id it decided on, the server returns the one it used, and a disagreement is reported (`atomicGoalContribution.linkedFork`) rather than thrown.
4. **The three cross-currency conventions are all different, and all live in this file.** `goal_contribution` divides (`round(amount ÷ rate, 2)`), `transfer → card` multiplies, `repayment of a taken loan` divides. A single "convert" implementation would mis-convert two of the three by a factor of *rate²*. The server derives which applies from the flow and cross-checks the client's own figure within 0.01 (`SOURCE_AMOUNT_MISMATCH` / `CARD_AMOUNT_MISMATCH`) instead of recomputing it and silently disagreeing.

A fifth, smaller one: the **self-stored** goal branch `break`s *before* the cross-currency check, so it is **currency-blind** — no rate is required, none is written, and the row's currency is the goal's. Reproduced exactly, including refusing a rate on that payload.

### 19.8 Both app modes

- **goal_contribution — `splits_only` is UNREACHABLE, confirmed on three independent gates**: `App.tsx:950-958` sends `/goals` to a `<Navigate>` in splits_only ("Savings goals stay full-tracker only"); `QuickEntry`'s `INTENTS` list keeps only `person_money` + `group_expense` in splits_only, so the tile never renders; and the branch's own first guard is `if (!src) throw`. `'goal_contribution'` is **also absent** from `isSimpleModeBalanceBypassAllowed`, so it uses the strict `checkBalance` — there is no ledger negative-balance subtlety to reproduce, unlike steps 2 and 3. `p_allow_negative` exists only for the future repair queue and the client **always** sends false.
- **card bill / cash-advance repayment — full_tracker only.** A card *is* an account and splits_only has none; the `transfer` intent is hidden there, and a ledger loan never writes the `loan_taken` row carrying a card as its source that `findCashAdvanceCardForLoan` reads. A ledger repayment stays on `loanStore.applyRepayment` and writes a row with **both account ids null**; not one line of it changes. One subtlety reproduced faithfully: `'repayment'` **is** in `isSimpleModeBalanceBypassAllowed`, so a full_tracker → splits_only switcher who still has accounts may legitimately push one negative — the client passes `p_allow_negative = true` in exactly that case and only for `rowType='repayment'`. A regression test pins that a splits_only repayment never reaches the RPC and still goes negative.
- Both RPCs **refuse a null/empty/unknown/foreign/soft-deleted account** with `ACCOUNT_NOT_FOUND`, so a ledger-shaped row can never be routed through them — the failure class `tasks/lessons.md` records.

### 19.9 Locking

The repo rule (`audit-p0-settlement-row-locks.sql:73-100`) is **loans → accounts → emi_schedules**, ascending `id` within a table. This file **extends the chain by one table, at the end**:

```
loans → accounts → emi_schedules → goals
```

`goals` goes last because it is a **leaf**: no other function in the corpus takes a lock on it (it is touched only by `goalsDb`'s plain PostgREST writes), so nothing can hold a goals lock while waiting for an accounts lock and no cycle is constructible.

- `contribute_to_goal`: accounts (source + stored-in, **one** statement, `ORDER BY id`) → goals (`FOR UPDATE`).
- `pay_card_bill`: loans (every plan loan id, **one** statement, `ORDER BY id`) → accounts (source + card, **one** statement, `ORDER BY id`) → emi_schedules.

Neither can invert order against `accept_linked_request` / `accept_settlement_request`, `apply_loan_remaining_delta`, `apply_account_balance_delta`, `transfer_between_accounts`, `record_loan_repayment` or `create_loan_with_leg`.

## 20. What the harness proved

Step 4 runs inside the repo's own trust-boundary suite (`docs/testing-the-trust-boundary.md`): `postgres:15`, `scaffold.sql`, then the **entire corpus in `apply-order.txt`**, then the assertions, as role `authenticated` with a real JWT subject.

`supabase/tests/tests/7y-atomic-goal-and-card.sql`, its own user I (`99999999-…`) and its own `H-` object-id prefix, so nothing here can disturb the fixtures — and, specifically, so `8y-guest-members`' `delete_current_user()` cannot cascade this suite's rows away underneath it.

| # | Scenario | Result |
|---|---|---|
| — | migration applies; Section 0 preconditions; V1–V4 self-verification | clean; `p3-atomic-goal-and-card: verification passed`. Re-apply is clean too |
| 0 | catalog shape | both functions `security_definer=t`, `search_path=public`, `auth_can=t / anon_can=f` |
| 1 | goal, tracked internally (bank 20 000, contribute 200) | 19 800 / goal 200; **all 20 columns** of the row asserted field-by-field, including `created_at` passthrough and the six NULLs |
| 2 | goal stored in ANOTHER account | both balances move in one call and the row carries the destination; **a lying `p_linked_account_id` is ignored** — the credit follows the goal, and the named account is untouched |
| 3 | **self-stored** | `source_delta = 0`, the balance is **unchanged**, `saved_amount` moves, destination NULL, the `goalSelfStored` note stored **verbatim**; a rate on that payload → `CONVERSION_RATE_NOT_APPLICABLE` |
| 4 | stored-in account that no longer exists | contributes with **no credit leg** — not an error (the column is a label, not an FK) |
| 5 | cross-currency PKR→AED @76.5 | `round(1000 ÷ 76.5, 2) = 13.07` leaves the wallet, the AED goal grows 1000; a lying source amount → `SOURCE_AMOUNT_MISMATCH`, a missing rate → `CONVERSION_RATE_REQUIRED`, rate 999999 → `INVALID_CONVERSION_RATE`; **all four refusals moved nothing** |
| 6 | **stale GOAL expectation** | `BALANCE_CONFLICT`, and **neither the goal nor the account moved and no row was written** — this is the lost-update bug, closed. A stale ACCOUNT expectation raises the same token; a missing one → `EXPECTED_SAVED_REQUIRED`; the client-shaped retry then moves each side exactly once |
| 7 | insufficient (10 000 from 250) | `INSUFFICIENT_BALANCE`, nothing written; `p_allow_negative=true` then takes the account to −150 |
| 8 | replay + 12 poisoned payloads | `{"replay":true}` **carrying the original stale expectations**, money moved once, one row; empty tx id / empty goal id / null / whitespace / soft-deleted / **another user's** goal / 0 / `NaN` / 1e13 → named refusals, **zero writes**, no saved amount leaked from the other user's goal |
| 9 | **goal mid-transaction failure** (trigger raising on the `transactions` INSERT — after the goal UPDATE **and** both balance UPDATEs) | `SIMULATED_WRITE_FAILURE` and **all four legs rolled back together** |
| 10 | card bill (bank 19 250, card 6 521.96 limit 16 500, one 8 666.68 advance, 1 311.36 revolving) pays 2 394.69 | both balances move, the advance steps by **exactly one instalment** to 7 583.35, `H-e5` flips and `H-e6` does not, and **both rows** land. The ledger row is asserted field-by-field: **both account ids NULL**, the loan's own person, no rate, empty category, the note verbatim |
| 11 | five plan refusals | `PLAN_OVER_PAYMENT` (settling 5 000 on a 100 payment — the money-minting shape), `PLAN_INVALID` (a loan you GAVE), `EMI_SCHEDULE_INVALID` (a foreign instalment), `LOAN_REMAINING_CONFLICT` (stale loan), `TRANSACTION_ID_COLLISION` (a reused ledger row id) — **all five wrote nothing** |
| 12 | **card mid-transaction failure** (trigger raising on the main INSERT — after the loan UPDATE, the instalment UPDATE, the LEDGER row **and both** balance UPDATEs) | `SIMULATED_WRITE_FAILURE` and **all six legs rolled back together**. **This is the proof** — under the legacy path the bill was paid and the loan had already moved independently by this point. The identical call with the trigger removed then lands all six |
| 13 | **cash-advance repayment crediting the card** | wallet debited, card credited, loan reduced, **one** row carrying wallet → card and the loan (a second ledger row → `PLAN_INVALID`). Crediting past the limit → `CARD_CREDIT_OVER_LIMIT`; the clamped version is accepted and the loan clamps to 0 with `status='settled'` derived in the same statement |
| 14 | replay + seven guard refusals | replay short-circuits before every CAS with **no second ledger row**; null source / null card / same account / non-card destination / bad row type / soft-deleted / **another user's card** → named refusals, zero writes, no balance leaked |
| 15 | the shipped drift watches | V5 (goal-leg drift), V6 (goal accounting), **V7 (the card lockstep invariant)** and V8 (bill-payment reconcile) all return zero rows over everything the suite wrote; closing balances and goal totals reconcile to the cent |
| P | roles | as `anon` → `permission denied` for **both**; as `authenticated` with no JWT subject → `NOT_AUTHENTICATED` for both |
| **R** | **two sessions racing the same card row** (A holds its transaction open for 2 s, B calls with the same expectations) | B **blocked on the row locks for ~1.00 s** until A committed, then returned `BALANCE_CONFLICT` with the post-A balance (12 688.65) in `DETAIL`. **No deadlock.** Money moved **exactly once**: one loan reduction, one instalment flipped, and only A's two rows exist |

**82 new SQL assertions; the whole suite is 449 assertions, 0 failed** (`bash supabase/tests/run.sh`), plus the two-session race run by hand against the kept container.

In the app: `npx vitest run` → **141 files / 1822 tests green**, including 32 new pure-logic tests (`src/lib/goalContributionPlan.test.ts` 14, `src/lib/cardBillAtomicPlan.test.ts` 18) and 24 driving the flagged store paths (`src/stores/transactionStoreAtomicGoalCard.test.ts`) — among them the self-stored no-leg case, the currency-blind self-store, the goal CAS retry, **the delta-based goal inverse that does not clobber a concurrent contribution**, the bill payment's ledger rows, the "nothing to settle stays on the plain transfer path" rule, the clamped and fully-covered card credits, both rollbacks, the re-plan on a loan conflict, and the splits_only path. `transactionStore.test.ts` gained throwing `goalContributeAtomic` / `payCardBillAtomic` stubs. `npx tsc -b --noEmit` and `eslint` clean for these files.

**Not proven by the harness** (the same limitations `docs/testing-the-trust-boundary.md` records):

- **PostgREST is absent** — every call was raw SQL. Named-argument binding for a **16**-argument RPC including a `jsonb` array of settlement lines, the `jsonb`→JS mapping of `lines[]` (nested objects with their own `emi_marked` arrays), and whether `DETAIL` reaches `PostgrestError.details` are **not** verified end to end. Highest-value staging check, as in steps 1–3.
- **The race was run by hand,** not in the suite — the harness runs one psql session per file. The ascending-`id` lock order is additionally verified *statically* (V3/V4 assert the `ORDER BY id`).
- **Production drift.** Section 0 hard-checks the 48 columns it needs and aborts with a named message, but that is a floor, not a schema audit.

## 21. Rollout (step 4)

1. **Apply `supabase-migration-p3-atomic-goal-and-card.sql`** in Supabase Studio. Safe ahead of the client — it adds two functions and nothing calls them while both flags are unset. Run Section 3 (V1–V4) and confirm `verification passed`.
2. **Run V6 and V7 before enabling.** V6 is the goal-accounting signature (a goal whose `saved_amount` disagrees with the contributions recorded against it — written by the lost update this CAS now prevents, or by the record-only `correctSavedAmount` repair). V7 is the **card lockstep invariant** — Σ(cash-advance remaining) exceeding the card's `used`, i.e. the Available-over-Limit signature. Know both numbers *before* the flags go on so any post-rollout row is unambiguous.
3. **Staging smoke through PostgREST**, not psql: a real signed-in session, one tracked-internally contribution, one stored-in-another-account, one **self-stored**, one cross-currency, one **card bill payment that settles an advance** (check the ledger row appears and the loan drops), one **cash-advance repayment with a partial clamp**, and one deliberate conflict (move the goal or the loan in another tab first). Confirm `details` arrives as JSON and `lines` as an array of objects.
4. **Enable one flag at a time, web only**, and **after** `VITE_ATOMIC_TRANSFER`, `VITE_ATOMIC_REPAYMENT` and `VITE_ATOMIC_LOAN_CREATE` have each had their own release cycle. `VITE_ATOMIC_GOAL` first (smaller blast radius), then `VITE_ATOMIC_CARD_BILL`. Five flags flipped together make an incident un-bisectable.
5. **Watch** for one release cycle: `transactionStore.atomicGoalContribution.rpcFailed`, `transactionStore.atomicGoalContribution.linkedFork` (the client and the server disagreed about the goal's stored-in account — a stale local account list), `transactionStore.atomicPayCardBill.rpcFailed`, plus V5–V8 as the reconciliation surface. Zero new rows is the expectation.
6. **Then Android**: `npm run build && npx cap sync android`, bump the version, hand the Gradle AAB build to the user.
7. **Rollback** is unsetting the flags and redeploying. The migration never needs reverting — unused functions are inert, and rows written by either path are identical.

## 22. The final branch table — what the money engine now covers

| # | Branch | Legs today | RPC | Flag | Status |
|---|---|---|---|---|---|
| 1 | `transfer` (plain) | 2 balances + 1 row | `transfer_between_accounts` | `VITE_ATOMIC_TRANSFER` | ✅ step 1 |
| 2 | `repayment` (full-tracker, no card) | 1 balance + loan CAS + N EMI + 1 row | `record_loan_repayment` | `VITE_ATOMIC_REPAYMENT` | ✅ step 2 |
| 3 | `loan_given` / `loan_taken` (incl. cash advance + EMI plan) | 1–2 balances + loan INSERT + N EMI + 1 row | `create_loan_with_leg` | `VITE_ATOMIC_LOAN_CREATE` | ✅ step 3 |
| 4 | `goal_contribution` (incl. self-stored) | ≤2 balances + goal CAS + 1 row | `contribute_to_goal` | `VITE_ATOMIC_GOAL` | ✅ **step 4** |
| 5 | card bill pay | 2 balances + 1 row + N × (loan CAS + M EMI + 1 row) | `pay_card_bill` (`'transfer'`) | `VITE_ATOMIC_CARD_BILL` | ✅ **step 4** |
| 6 | cash-advance repayment crediting the card | 2 balances + loan CAS + N EMI + 1 row | `pay_card_bill` (`'repayment'`) | `VITE_ATOMIC_CARD_BILL` | ✅ **step 4** |
| — | `income`, `expense`, `opening_balance`, `adjustment` | 1 balance + 1 row | `record_single_leg_entry` | `VITE_ATOMIC_SINGLE_LEG` | ✅ **closed by step 5** — see §24-31. (Written before step 5: *"single-leg; a narrow window remains where the row insert fails after the balance moved, but they cannot leave money half-moved between two places, which is the finding. A shared `record_single_leg_entry()` is the natural next step."*) |
| — | `investment_buy` / `investment_sell` / `investment_dividend` | 1 balance + 1 trade row + 1 row | `record_investment_trade` | `VITE_ATOMIC_INVEST` | ✅ **closed by step 5** — see §24-31. (Written before step 5: *"two-artifact, and genuinely uncovered: a drop between the balance and the trade row leaves a position that does not exist."*) |
| — | ledger-only (`splits_only`) money | `loanStore.applyRepayment` / `createLoan` | — | — | untouched by every step, and every RPC **refuses** a null account so it stays that way |
| — | cross-user (linked requests, group settlements, kameti draws) | — | already server-side | — | a different programme (`audit-p0-settlement-row-locks`, `audit-p0-kameti-draw`) |

**Every multi-leg money-moving branch of `processTransaction` now has a server-side transaction behind a flag.** That was L4's scope as step 4 left it; **step 5 (§24-31) closes the two single-artifact rows above as well**, so the table has no uncovered row left. The final version of it lives in §31.

## 23. What remains client-side — the honest list

Deliberately, and unchanged by all four steps:

1. **The audit trail.** `activity_log` entries (`transaction_created`, `loan_created`, `loan_settled`, `emi_paid`, `opening_balance`) are written post-commit, best-effort, via `logActivitySafe`. Moving them into the transaction would make an audit-log failure roll back money that has moved — the opposite of the current, correct rule. A spike in `logActivitySafe` reports means the trail is drifting behind the money; it does not mean money is wrong.
2. **The Dexie mirrors and Zustand state.** Read caches, repopulated by `refetchMoneyStores` after a failed rollback.
3. **The reminder reschedule** (`nudgeReminderSchedule`), fire-and-forget, native only.
4. **The allocation and clamping rules themselves** — `allocateBillPayment`, `clampCardCredit`, `uncoveredToPaidIds`, `planRepaymentEmiMarks`, `planGoalContributionLegs`, `planLoanCreateLegs`. This is the *plan on the client, apply on the server* decision, made once and applied to every branch: the server re-validates every number it is handed but never re-derives the rule.
5. **The scope inverse.** A rollback is still a best-effort client compensation and still fails in a total outage. What changed is that it now has **one** thing to undo instead of a half-applied sequence, and the forward move can no longer be partially committed.
6. ~~**The goal compensation's own write.**~~ **CLOSED by step 5 — see §25.3 and §26 correction 5.** The inverse became a *delta* (`addContribution(-applied)`) in step 4, so it could no longer clobber a concurrent contribution — but that delta still went through `goalsDb.update`, an unlocked read-modify-write. `apply_goal_saved_delta` now gives it a compare-and-swap, behind a retry-then-fall-back-to-the-legacy-write ladder (a rollback that *refuses to run* would be worse than one that races).
7. **The consolidated multi-loan repayment** is still N independent commits (`repaymentExecution.ts`'s committed-prefix model). Each iteration is individually atomic — a mid-batch failure leaves whole repayments, never half ones — but "applied to 3 of 5" remains the honest report.
8. **Offline.** An atomic RPC still needs a connection. M1's other half — persisting pending work and replaying it — is a separate decision, and the honest interim answer remains "Hisaab needs a network to record money".
9. **The god store.** H-3's 640-line switch gained forks and helpers rather than losing branches. Step 4 lifted `prepareCardBillPlan` and `toCardBillLines` out of it and deleted the inline allocation block, which is the first net *shrink* of the switch body in the whole programme — but the structural win the audit asked for arrives only when the branches move out entirely, which none of the four steps has done.

---

# Step 5 — the last two shapes: the investment trade, the single leg, and the goal compensation's own lock

**Written:** 2026-09-03 · **Status:** built, Docker-validated on PostgreSQL 15.19 through the repo's own harness, **flags OFF, migration not yet applied to production**

`supabase-migration-p3-atomic-investments-and-single-leg.sql` · `VITE_ATOMIC_SINGLE_LEG` + `VITE_ATOMIC_INVEST` · `src/stores/transactionStoreAtomicInvestSingle.test.ts` · `supabase/tests/tests/7z-atomic-investments-single-leg.sql`

## 24. Why these, and what they actually lose today

Step 4 closed every **multi-leg** branch of `processTransaction`. §22's table left two rows uncovered and §23 left one gap; this step is all three.

```
investment_buy / investment_sell / investment_dividend   (TWO artifacts)
  1. apply_account_balance_delta(account, ±cash, expected)  — commits
  2. investment_trades INSERT                               — TIMES OUT
  3. transactions INSERT                                    — never runs
```

Server truth: **the wallet moved and no trade exists.** That is worse than it sounds, and the reason is specific to how this feature is built. Positions — quantity, average cost, realised P&L — are **derived** by replaying the trade ledger on every render and are never stored (`src/lib/investmentMath.ts`; the schema header says it outright: *"there is no holdings table to drift"*). So a lost trade row is not a corrupted figure a reconciliation query could spot. It is a **deleted position**: a buy leaves a wallet that paid for shares nobody holds, and a sell leaves shares the app will happily let the user sell a second time. There is no artifact left to match against.

```
income / expense / opening_balance / adjustment          (ONE artifact + 1)
  1. apply_account_balance_delta(account, ±amount, expected) — commits
  2. transactions INSERT                                     — TIMES OUT
```

§6 called these "no RPC needed" and it was right about the *severity* — they cannot leave money half-moved between two places, which was MF-01's finding. It was wrong about the priority. This is the **most common write in the app**, and what it leaves behind is the one shape the product has no answer for: a balance that changed with nothing saying why. The user's own repair for that is `adjustment` — which is one of the same four branches, with the same window.

And the leftover from step 4, §23 item 6: the goal contribution's **compensation** still wrote `goals.saved_amount` through `goalsDb.update`, an unlocked read-modify-write. Step 4 gave the forward write a compare-and-swap; the inverse did not have one.

## 25. The artifact contracts

The full tables live in the migration header. The splits:

### 25.1 `record_single_leg_entry`

| # | Artifact | Owner after step 5 |
|---|---|---|
| 1 | `accounts.balance` (exactly ONE row) | **server**, in the transaction |
| 2 | `transactions` row (20 columns) | **server**, same transaction |
| 3 | Dexie mirrors + Zustand in two stores | client, post-commit, adopting the server's balance |
| 4 | `activity_log` `transaction_created`, or `opening_balance` for that one type | client, post-commit, best-effort — unchanged |
| 5 | reminder reschedule | client, post-commit — unchanged |

Per type, and this **is** the whole specification:

| type | leg | row source | row destination | balance guard |
|---|---|---|---|---|
| `income` | +amount | NULL | the account | none, ever |
| `opening_balance` | +amount | NULL | the account | none, ever |
| `expense` | −amount | the account | NULL | `checkBalanceForTransaction` |
| `adjustment` | ±delta | account if delta<0 | account if delta>0 | none, ever |

None of the four is cross-currency: each takes the row's currency from its one account and writes `conversion_rate` NULL. The signature therefore **has no `p_conversion_rate` at all** — a stronger refusal than accepting one and rejecting it, which is the shape `create_loan_with_leg` was stuck with because its caller already bound the argument.

### 25.2 `record_investment_trade`

| # | Artifact | Owner after step 5 |
|---|---|---|
| 1 | `accounts.balance` (exactly ONE row) | **server**, in the transaction |
| 2 | `investment_trades` row (16 columns) | **server**, same transaction |
| 3 | `transactions` row, `related_investment_id` set | **server**, same transaction |
| 4 | Zustand in three stores + the Dexie mirrors | client, post-commit, adopting the server's figures |
| 5 | `activity_log` `transaction_created` | client, post-commit — unchanged |
| 6 | reminder reschedule | client, post-commit — unchanged |
| — | **derived positions** (qty / avg cost / P&L) | **nobody.** Replayed from artifact 2 on every render. There is nothing to sync and nothing to drift — which is exactly why losing the trade row loses the position |
| — | `investment_prices` | untouched. A trade never writes a price; `updatePrice` is a separate user action |

### 25.3 `apply_goal_saved_delta`

One column, one compare-and-swap, no row writes — the goal twin of `apply_loan_remaining_delta`. Reached only from step 4's already-flagged goal path, as its inverse.

## 26. Five corrections worth recording

1. **There is no ledger-only `income` / `expense` / `opening_balance` / `adjustment` row in this product — confirmed, not assumed.** The brief allowed for one ("the single-leg RPC must accept a null account ONLY for the exact cases the legacy path writes a both-ids-null row today"). A full sweep of every `processTransaction` call site and every direct `transactions` writer found **zero** such cases, on three independent layers: the input types (`ExpenseInput.sourceAccountId: string` — not optional, unlike `RepaymentInput`'s), the runtime guards (all four branches throw before the row object is built), and the UI (`QuickEntry.tsx:330-332` removes the Spend/Receive/Move intents entirely in `splits_only` — *"Splits-only mode has no accounts"*). The both-ids-null shape that `tasks/lessons.md:26-27` records is exclusively `type = 'repayment'`, written by `loanStore.applyRepayment` and by the card-bill tail. **The RPC therefore refuses a null account unconditionally**, and verification query V5 watches production in case something nobody has traced produces one anyway.

2. **The adjustment's magnitude is a *function of the balance*, so it cannot be sent once and retried.** The RPC re-derives `|target − balance|` from the locked row — that is the point of moving it server-side, since "set it to X" is only truthfully X when the read and the write are one transaction — and cross-checks the client's figure (`AMOUNT_MISMATCH`). The first version of the retry ladder sent the *pre-conflict* magnitude alongside the *post-conflict* expectation: a payload whose two halves describe different worlds, which the server correctly refused. A unit test caught it. `atomicSingleLeg` now recomputes the magnitude on every attempt from the freshly read account, and the branch adopts the server's `amount` and direction rather than the values it derived before the call.

3. **The investment currency conventions are a THIRD pattern, and all three now live in one engine.** A buy **divides** (`round(amount / rate, 2)` — the `goal_contribution` shape); a sell and a dividend **multiply** (the `transfer` shape). And the *trigger* differs too: a buy and a sell convert only when `account.currency ≠ market.currency AND amount > 0` — a zero-cash entry (bonus shares at price 0) needs no rate and moves nothing — while a **dividend** converts on the currency test alone. The server reproduces each branch's own condition rather than a merged one.

4. **`investmentTradesDb.add` is an UPSERT**, so on the legacy path a repeated trade id silently **overwrites a live trade** — and with it the position that trade produced. The RPC refuses (`TRADE_ID_COLLISION`). Nothing in the app can produce one; a `curl` can. Same shape as step 3's `LOAN_ID_COLLISION`.

5. **A compare-and-swap on a *compensation* is a knife with two edges.** `apply_goal_saved_delta` protects the goal inverse from clobbering a concurrent contribution — but a rollback that *refuses to run* is strictly worse than one that races. `atomicGoalSavedDelta` therefore runs a three-rung ladder: try the CAS; on `BALANCE_CONFLICT` reload the goals and retry once against the truth (a pure delta is always safe to replay); on **any** remaining failure — a second conflict, a network drop, or the step-5 migration simply not being applied — fall back to the legacy unlocked write and report to Sentry. The result is never worse than today. A regression test pins the fallback.

A sixth, smaller one: the adjustment's `NOTHING_TO_CORRECT` guard is a genuine tightening, not a port. On the legacy path `Math.abs(delta) < 0.005` is evaluated against a local snapshot, so a correction to a balance that has *since become correct* still writes a row for a movement of zero.

## 27. Error contract — one new token

| Token | Meaning | Client behaviour |
|---|---|---|
| `BALANCE_CONFLICT` | a stale CAS — on an account, or (in `apply_goal_saved_delta`) on the **goal** | byte-identical to `apply_account_balance_delta`; both helpers refetch and retry once. A conflict means **nothing moved** |
| `INSUFFICIENT_BALANCE` | the server half of `checkBalance` / `checkBalanceForTransaction` | `DETAIL` rebuilds the identical bilingual `err_insufficient` string |
| `GOAL_NOT_FOUND` | step 4's token, reused rather than reinvented | `tStatic('err_goal_gone')`, never retried |
| **`INSUFFICIENT_HOLDINGS`** | **the one new token.** The server half of `simulateTimeline` — the one investment rule whose violation **mints shares** | folded, with `INVALID_TRADE` / `TRADE_AMOUNT_MISMATCH` / `ACCOUNT_AMOUNT_MISMATCH` / `TRADE_ID_COLLISION` / `MARKET_NOT_FOUND`, into one client-side `TRADE_REJECTED` whose message is the single new bilingual string (`err_trade_rejected`). The server's own token rides along as `serverToken` for Sentry only. **Never retried** — the trade is wrong, not stale, and the RPC is atomic so a refusal wrote none of the three artifacts |

Everything else is a poisoned payload, unreachable from the shipped client: `NOT_AUTHENTICATED`, `INVALID_TRANSACTION_ID`, `INVALID_TYPE`, `INVALID_AMOUNT`, `INVALID_KIND`, `INVALID_SYMBOL`, `EXPECTED_BALANCE_REQUIRED`, `TARGET_BALANCE_REQUIRED`, `NOTHING_TO_CORRECT`, `AMOUNT_MISMATCH`, `CONVERSION_RATE_REQUIRED`, `INVALID_CONVERSION_RATE`, `CONVERSION_RATE_NOT_APPLICABLE`, `MARKET_NOT_FOUND`, `ACCOUNT_NOT_FOUND`, `TRANSACTION_ID_COLLISION`, `INVALID_ARGUMENT`.

The client still runs `validateTradeInput` and `simulateTimeline` **before** calling, so the common refusal costs no round-trip on 3G — and a regression test asserts that a client-caught oversell makes **zero** RPC calls.

## 28. Locking, idempotency, and both app modes

**Locking.** The repo chain is `loans → accounts → emi_schedules → goals`. `record_single_leg_entry` and `record_investment_trade` touch **accounts only** — one row, taken `FOR UPDATE` through the same `ANY(...) ORDER BY id` shape their siblings use, before any write. `apply_goal_saved_delta` touches **goals only**, the leaf. `investment_markets` is immutable to this function so it is read, never locked; `investment_trades` is insert-only and the trade id is its own serialisation point via the primary key. None of the three can invert order against anything in the corpus.

**Idempotency.** `p_transaction_id` is the client-generated primary key of `transactions`, checked **after** the row lock so two copies of the same retry serialise. `record_investment_trade` has a second guarantee that matters more than usual: a replay returns **the trade id the FIRST call minted** (read back from `transactions.related_investment_id`), not the id this retry generated, and the client adopts *that* — a mirror claiming a trade Postgres does not have is precisely the desync a derived-position feature cannot survive. `apply_goal_saved_delta` is deliberately not idempotent: it is a delta with no id to key on, and its only caller runs at most once per scope.

**Both app modes.**

- **full_tracker** — the only mode that reaches either RPC.
- **splits_only (ledger-only)** — untouched, on both. There is no ledger single-leg entry at all (correction 1), and the ledger-shaped *trade* — "held outside Hisaab", `account_id` NULL — goes through `investmentStore.recordOutsideTrade`, which writes **one** `investment_trades` row and no money row and no balance (`investmentStore.ts:144-180`). Not one line of that path changes, and both RPCs refuse a null account so neither shape can be routed through them.
- One subtlety reproduced faithfully: `'expense'` **is** in `isSimpleModeBalanceBypassAllowed`, so a full_tracker → splits_only switcher who still has accounts may legitimately push one negative. The client passes `p_allow_negative = true` in exactly that case and only for `'expense'`. `'investment_*'` is **absent** from that list, so the buy guard is the strict `checkBalance` and the client always sends false.

## 29. What the harness proved

Step 5 runs inside the repo's own trust-boundary suite (`docs/testing-the-trust-boundary.md`): `postgres:15` (**PostgreSQL 15.19**), `scaffold.sql`, then the **entire 72-file corpus in `apply-order.txt`** (this migration is entry #65), then the assertions, as role `authenticated` with a real JWT subject.

`supabase/tests/tests/7z-atomic-investments-single-leg.sql`, with its own user J (`aaaaaaaa-…`) and its own `J-` object-id prefix, plus a user K whose rows exist only to be unreachable.

| # | Scenario | Result |
|---|---|---|
| — | migration applies; Section 0 preconditions; V1–V4 self-verification | clean; `p3-atomic-investments-and-single-leg: verification passed`. Re-apply is clean too |
| 0 | catalog shape | all three `security_definer=t`, `search_path=public`, `auth_can=t / anon_can=f` |
| 1 | expense (bank 5000, spend 100) | 4900; **all 20 columns** of the row asserted field-by-field, including `created_at` passthrough, the NULL rate and the six NULLs |
| 2 | income into an EMPTY account, and `opening_balance` | both credit with no guard at all; the row carries the destination and its own type |
| 3 | **adjustment** UP, DOWN, and to a **negative** target on a credit card | the balance is **SET to the target exactly**; the row's leg follows the direction and `amount` stays an unsigned magnitude; the negative target is allowed (that is what adjustment is *for*) |
| 3b | adjustment no-op and a lying `|delta|` | `NOTHING_TO_CORRECT` (evaluated **inside the lock**) and `AMOUNT_MISMATCH`; both wrote nothing |
| 4 | stale expectation | `BALANCE_CONFLICT`, **nothing moved, no row**; the client-shaped retry then succeeds, moving the money exactly once. A missing expectation → `EXPECTED_BALANCE_REQUIRED` |
| 5 | insufficient (10 000 from 300) | `INSUFFICIENT_BALANCE`, nothing written; `p_allow_negative=true` then takes the account negative (the splits_only bypass) |
| 6 | replay | `{"replay":true}` **carrying the original stale expectation**, money moved once, one row; an id owned by another entry type → `TRANSACTION_ID_COLLISION` |
| 7 | **the ledger guard** + poisoned payloads | null / whitespace / soft-deleted / **another user's** account → `ACCOUNT_NOT_FOUND`; empty tx id, a `transfer` type, 0, `NaN`, 1e13, a target on a non-adjustment, an adjustment with no target → seven named refusals. **Eleven refusals, zero writes**, and the other user's account is not even readable |
| 8 | **single-leg mid-transaction failure** (a trigger raising on the `transactions` INSERT, i.e. after the balance UPDATE) | `SIMULATED_WRITE_FAILURE` and **both legs rolled back together** — a changed balance with no row saying why, prevented |
| 9 | **buy** (100 × 10 + 5 fees) | 1005 leaves the wallet (fees CAPITALIZED), the symbol normalised to upper case; **all 16 columns** of the trade row asserted field-by-field (`amount = 0` for a buy, `traded_at` kept distinct from `created_at`) and the money row's `related_investment_id` |
| 10 | **sell** and **dividend** | 40 × 12 − 3 arrives; the dividend stores the **gross** on the trade, credits the **net**, and forces the company name empty |
| 11 | **the oversell replay** | selling 500 of a 60-share position → `INSUFFICIENT_HOLDINGS` with **none of the three artifacts written**; a **BACKDATED** sell that breaks a *later* one is caught; and a sell that is valid against the real buys **succeeds** even though the symbol carries an already-invalid historical sell — `computePosition` skips those, so `simulateTimeline` must too |
| 12 | the three currency conventions | cross-currency buy **DIVIDES** (`round(7650 / 76.5, 2) = 100.00` leaves an AED wallet while the row stays PKR); a missing rate → `CONVERSION_RATE_REQUIRED`, rate 999999 → `INVALID_CONVERSION_RATE`, a rate on a same-currency trade → `CONVERSION_RATE_NOT_APPLICABLE`, a lying account amount → `ACCOUNT_AMOUNT_MISMATCH`, a lying cash amount → `TRADE_AMOUNT_MISMATCH`. **Five refusals, nothing moved, no trade left behind** |
| 13 | `validateTradeInput`, re-run | negative fees, fees swallowing the dividend, zero quantity, fees exceeding the sale proceeds, a bad kind, a blank symbol → six named refusals |
| 14 | ownership, ledger guard, balance guard, replay, collision | another user's market → `MARKET_NOT_FOUND`; a null account → `ACCOUNT_NOT_FOUND`; an unaffordable buy → `INSUFFICIENT_BALANCE`; a replay returns the **first** call's trade id and creates no second trade; a reused trade id → `TRADE_ID_COLLISION` **and the live trade is not overwritten** |
| 15 | **investment mid-transaction failure** (the trigger raising on the money row, i.e. after the balance UPDATE **and** the `investment_trades` INSERT) | `SIMULATED_WRITE_FAILURE` and **all three legs rolled back together**. **This is the proof** — under the legacy path the wallet had already paid for shares nobody holds |
| 16 | `apply_goal_saved_delta` | a −200 delta lands behind the CAS; replaying it with the **original** expectation → `BALANCE_CONFLICT` and the goal does not move twice; a −1000 delta against 300 clamps to 0 and reports `goal_applied = −300`, not −1000; another user's goal → `GOAL_NOT_FOUND`; `NaN` and a missing expectation → `INVALID_ARGUMENT` |
| **R** | **two sessions racing the same account row** (session A opened through `dblink`, holding its transaction open) | session B **blocked on the row lock** until A committed (proved by a 1.5 s `lock_timeout` firing, SQLSTATE 55P03), then returned `BALANCE_CONFLICT` against its pre-A expectation, then succeeded on the client-shaped retry. **No deadlock. Money moved exactly once per call** and both rows exist. This is the first time the two-session check runs **inside** the suite rather than by hand — steps 1, 2 and 4 ran theirs manually. It degrades to a recorded SKIP if the image has no `dblink`, and the ascending-id lock order is additionally asserted statically by V3/V4 |
| 17 | the shipped drift watches | V5 (a single-leg row with no account), V6 (one touching two accounts or carrying a rate), **V7 (the LOST-TRADE signature, in both directions)** and V8 (an oversold position) all return zero rows over everything the suite wrote; every closing balance reconciles to the cent |
| P | roles | as `anon` → `permission denied` for all three; as `authenticated` with no JWT subject → `NOT_AUTHENTICATED` |

**90 new SQL assertions; the whole suite is 546 assertions, 0 failed** (`bash supabase/tests/run.sh`). (The pre-step-5 total is higher than the 449 §20 recorded — other suites have grown since step 4 — so read 546 as the current floor, not as 449 + 90.)

In the app: `npx vitest run` → **147 files / 1990 tests green**, including 22 driving the flagged store paths (`src/stores/transactionStoreAtomicInvestSingle.test.ts`) — among them the one-call proof for each shape, the adjustment that adopts the server's magnitude after a conflict retry, the client-side oversell that costs no round-trip, the server-side one that writes nothing and is never retried, both rollbacks, the replay that adopts the server's trade id, the splits_only negative expense, and both rungs of the goal-compensation ladder. `transactionStore.test.ts` gained throwing `singleLegAtomic` / `investmentTradeAtomic` / `goalSavedDelta` stubs — the widest tripwire in the suite, since income, expense and adjustment are its most common writes — so "the legacy path is byte-for-byte unchanged with the flags off" is asserted, not hoped. `npx tsc -b --noEmit` and `eslint` clean.

**Not proven by the harness** (the same limitations `docs/testing-the-trust-boundary.md` records):

- **PostgREST is absent** — every call was raw SQL. Named-argument binding for a **22**-argument RPC, the `jsonb`→JS mapping, and whether `DETAIL` reaches `PostgrestError.details` are **not** verified end to end. Highest-value staging check, as in steps 1–4.
- **The oversell replay's tie-breaking is collation-dependent in one place.** The client orders by `id.localeCompare(id)`; the server by SQL text ordering. They can differ only for two trades sharing the *same* `traded_at`, kind and `created_at` — and even then the verdict changes only in a constructed case. Worth knowing, not worth a schema change.
- **Production drift.** Section 0 hard-checks the 51 columns it needs and aborts with a named message, but that is a floor, not a schema audit.

## 30. Rollout (step 5)

1. **Apply `supabase-migration-p3-atomic-investments-and-single-leg.sql`** in Supabase Studio. Safe ahead of the client — it adds three functions and nothing calls them while both flags are unset. Run Section 4 (V1–V4) and confirm `verification passed`.
2. **Run V7 before enabling.** It is the **lost-trade signature** in both directions — a money row whose trade is gone, or an account-linked trade whose money row is gone. Rows here are history, written by exactly the failure this step closes. Know the number *before* the flags go on so any post-rollout row is unambiguous. V5, V6 and V8 should all be zero already; if V5 returns anything, a writer nobody has traced exists and correction 1 needs revisiting **before** the flag.
3. **Staging smoke through PostgREST**, not psql: a real signed-in session, one expense, one income, one **adjustment** (check the balance lands exactly on the target), one buy, one sell, one dividend, one **cross-currency buy** (check the wallet loses `amount ÷ rate`, not `× rate`), one deliberate oversell, and one deliberate conflict (move the balance in another tab first). Confirm `details` arrives as JSON.
4. **Enable one flag at a time, web only**, and **after** the four earlier flags have each had their own release cycle. `VITE_ATOMIC_SINGLE_LEG` first — it is the highest-volume path, so a week of it is worth more evidence than a week of anything else — then `VITE_ATOMIC_INVEST`. Seven flags flipped together make an incident un-bisectable.
5. **Watch** for one release cycle: `transactionStore.atomicSingleLeg.rpcFailed`; `transactionStore.atomicInvestmentTrade.rpcFailed` (its `extra.serverToken` says *which* rule the server disagreed about — a spike in `TRADE_AMOUNT_MISMATCH` or `ACCOUNT_AMOUNT_MISMATCH` means the two halves of the money derivation have forked, which is the one thing worth paging for); and `transactionStore.atomicGoalSavedDelta.fellBack` (the goal CAS could not be satisfied and the legacy write ran — expected to be rare and harmless, but a steady rate means concurrent goal writes are common enough to look at). Plus V5–V8 as the reconciliation surface.
6. **Then Android**: `npm run build && npx cap sync android`, bump the version, hand the Gradle AAB build to the user.
7. **Rollback** is unsetting the flags and redeploying. The migration never needs reverting — unused functions are inert, rows written by either path are identical, and `apply_goal_saved_delta` degrades to the legacy write on its own.

## 31. THE FINAL BRANCH TABLE — the money engine, complete

| # | Branch | Legs today | RPC | Flag | Status |
|---|---|---|---|---|---|
| 1 | `transfer` (plain) | 2 balances + 1 row | `transfer_between_accounts` | `VITE_ATOMIC_TRANSFER` | ✅ step 1 |
| 2 | `repayment` (full-tracker, no card) | 1 balance + loan CAS + N EMI + 1 row | `record_loan_repayment` | `VITE_ATOMIC_REPAYMENT` | ✅ step 2 |
| 3 | `loan_given` / `loan_taken` (incl. cash advance + EMI plan) | 1–2 balances + loan INSERT + N EMI + 1 row | `create_loan_with_leg` | `VITE_ATOMIC_LOAN_CREATE` | ✅ step 3 |
| 4 | `goal_contribution` (incl. self-stored) | ≤2 balances + goal CAS + 1 row | `contribute_to_goal` | `VITE_ATOMIC_GOAL` | ✅ step 4 |
| 5 | card bill pay | 2 balances + 1 row + N × (loan CAS + M EMI + 1 row) | `pay_card_bill` (`'transfer'`) | `VITE_ATOMIC_CARD_BILL` | ✅ step 4 |
| 6 | cash-advance repayment crediting the card | 2 balances + loan CAS + N EMI + 1 row | `pay_card_bill` (`'repayment'`) | `VITE_ATOMIC_CARD_BILL` | ✅ step 4 |
| 7 | `income` / `expense` / `opening_balance` / `adjustment` | 1 balance + 1 row | `record_single_leg_entry` | `VITE_ATOMIC_SINGLE_LEG` | ✅ **step 5** |
| 8 | `investment_buy` / `investment_sell` / `investment_dividend` | 1 balance + 1 trade row + 1 row | `record_investment_trade` | `VITE_ATOMIC_INVEST` | ✅ **step 5** |
| 9 | the goal contribution's **inverse** | 1 unlocked goal write | `apply_goal_saved_delta` | (none — ladder + fallback) | ✅ **step 5** |
| — | ledger-only (`splits_only`) money | `loanStore.applyRepayment` / `createLoan` | — | — | untouched by every step, and **every** RPC refuses a null account so it stays that way |
| — | cross-user (linked requests, group settlements, kameti draws) | — | already server-side | — | a different programme (`audit-p0-settlement-row-locks`, `audit-p0-kameti-draw`) |

**Every branch of `processTransaction` that moves money now has a server-side transaction behind a flag.** There is no row left in this table without one. L4's scope is closed — with two honest caveats: none of the seven flags is on yet, and *deletes and edits* are a separate programme (§32 item 7).

## 32. What remains client-side — the final honest list

Item 6 of §23 is now **closed**. The rest stands, and is deliberate:

1. **The audit trail.** `activity_log` entries are written post-commit, best-effort. Moving them into the transaction would make an audit-log failure roll back money that has moved — the opposite of the correct rule.
2. **The Dexie mirrors and Zustand state.** Read caches, repopulated by `refetchMoneyStores` after a failed rollback.
3. **The reminder reschedule**, fire-and-forget, native only.
4. **The allocation, clamping and validation rules themselves** — `allocateBillPayment`, `clampCardCredit`, `uncoveredToPaidIds`, `planRepaymentEmiMarks`, `planGoalContributionLegs`, `planLoanCreateLegs`, `planEmiRows`, and now `validateTradeInput` / `simulateTimeline`. This is the *plan on the client, apply on the server* decision, made once and applied to every branch: **the server re-validates every number it is handed, and re-runs every rule that could mint value, but it never re-derives the rule.** Step 5 is the clearest instance — `computePosition` stays in TypeScript, while the *oversell verdict* it implies is recomputed server-side, because that is the one an attacker would want to skip.
5. **The scope inverse.** Still a best-effort client compensation, and still fails in a total outage. What changed across the five steps is that it now has **one** thing to undo instead of a half-applied sequence, and the forward move can no longer be partially committed. The goal inverse additionally has its own CAS with a fallback (§26 correction 5).
6. **The consolidated multi-loan repayment** is still N independent commits (`repaymentExecution.ts`'s committed-prefix model). Each iteration is individually atomic — a mid-batch failure leaves whole repayments, never half ones — but "applied to 3 of 5" remains the honest report.
7. **Deletes and edits.** Every step covered *creation*. `deleteTransaction` and `updateTransaction` still unwind and re-apply money through the same multi-round-trip client sequences the create paths used to, with the same compensation model — deleting a `transfer` is still two balance calls and a row delete, and deleting an investment trade is a balance call plus a trade delete plus a row delete. That is now **the largest uncovered surface in the money engine**, and it is the honest next programme rather than a gap in this one: the RPCs would be reversals of the eight above, and the artifact-contract method in §6 applies unchanged.
8. **Offline.** An atomic RPC still needs a connection. M1's other half — persisting pending work and replaying it — is a separate decision, and the honest interim answer remains "Hisaab needs a network to record money".
9. **The god store.** H-3's switch gained forks and helpers rather than losing branches. Step 5 lifted the account-amount derivation out of the investment branches' four duplicated sub-blocks so the flagged and legacy paths consume one figure — a small net shrink — but the structural win the audit asked for arrives only when the branches move out of the switch entirely, which none of the five steps has done.
