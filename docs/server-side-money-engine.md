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
| **1** | `transfer` ✅ *(this pilot)* | 2 balances + 1 row | Two symmetric balance legs and nothing else — the smallest complete instance of the failure. | done |
| **2** | `goal_contribution` | 1 balance + goal `saved_amount` (snapshot-based) + 1 row | Next smallest, and the only one whose compensation is **snapshot**-based rather than delta-based (`rollback restores the exact prior savedAmount`) — precisely the shape that clobbers a concurrent write. Needs a `goals.saved_amount` CAS first, modelled on `apply_loan_remaining_delta`. | S |
| **3** | `repayment` (full-tracker, no card credit) | 1 balance + `apply_loan_remaining_delta` + EMI status sync + 1 row | Already half-server-side: the loan leg is a CAS RPC, so this is mostly *joining* two existing atomic operations. Touches loans **and** accounts — the first branch that must honour the lock order in a single function. Do the plain case before the card case. | M |
| **4** | `loan_given` / `loan_taken` | 1–2 balances + loan **creation** + 1 row | Adds a row to a second table inside the transaction, and `loan_taken` has the cash-advance card leg. Also the ad-hoc-split entry point, so the blast radius of a mistake is wider. | M |
| **5** | card-bill pay (the `transfer` branch's credit-card tail) | N loan repayments + N ledger rows, over a statement-allocation plan | **Last, deliberately.** The allocation (`allocateBillPayment`, `clampCardCredit`) is real business logic with its own tested engine; porting it to plpgsql would fork the source of truth. The right shape is *plan on the client, apply on the server*: the client computes the plan, the RPC applies it in one transaction. That is a bigger design decision than the four above, and it should be made with the pilot's operational record in hand. | L |

Branches that need **no** RPC: `income`, `expense`, `opening_balance` and `adjustment` are single-leg — one balance write plus one row. They still have a (much narrower) window where the row insert fails after the balance moved, so they are worth a shared `record_single_leg_entry()` eventually, but they cannot leave money *half-moved between two accounts*, which is the finding.

### What this does **not** solve

- **Offline.** An atomic RPC still needs a connection. M1's other half — persisting pending work and replaying it (the outbox, or a compensation mini-queue in Dexie) — is a separate decision, and the honest interim answer remains "Hisaab needs a network to record money".
- **The god store.** H-3 (`processTransaction`, a 640-line 12-case switch) shrinks only as branches move out; the pilot removed two lines from it and added a helper. The structural win arrives around branch 4.
- **Cross-user flows.** Linked requests and group settlements already have server-side RPCs with row locks (`audit-p0-settlement-row-locks`); they are a different programme.
