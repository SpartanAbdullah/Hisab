# Phase 12 — Quality Assurance Review

**Date:** 2026-09-02
**Auditor role:** QA Lead (adversarial pre-launch QA / due-diligence review)
**Scope:** input validation, error handling & recovery, edge cases (rounding, non-atomic loops, recurring idempotency, timezone boundaries, duplicate submission, concurrent multi-device edits, offline behavior, deep-link/invite tokens), and the two-app-mode matrix. Three deliverable artifacts: manual test checklist, release regression checklist, ranked high-risk scenarios.
**Ground rules honored:** every claim cites `file:line`; nothing outside `docs/audit-2026-09/` was modified; unknowables are listed in §9.

Severity scale: **critical** = money corruption / data loss / account takeover / cross-user leak / launch blocker; **high** = significant user harm, security weakness or scaling wall; **medium** = real but bounded; **low** = polish.

---

## 1. Executive summary

Hisaab's money-mutation core is unusually well-reasoned for a client-only app: a documented compensation pattern (`src/lib/mutationSafety.ts:1-14`), an optimistic-locked balance RPC with one refetch-retry (`src/stores/accountStore.ts:120-155`), an honest committed-prefix model for multi-loan batches (`src/lib/repaymentExecution.ts:1-8`), and a genuinely good recurring-expansion idempotency stamp + compare-and-set advance (`src/components/RecurringDuePrompt.tsx:54-73`, `src/stores/recurringStore.ts:96-116`). The repo's own lessons file (`tasks/lessons.md`) shows the team learns from failures.

But the robustness story is **uneven by construction**:

- **Validation is 100% ad-hoc per form** — there is no schema-validation library anywhere (`package.json` has no zod/yup/valibot/ajv — grep returned zero hits) and the store layer trusts its callers (e.g. `processTransaction`'s `income` branch applies `input.amount` with no positivity/finite check, `src/stores/transactionStore.ts:794-801`).
- **Optimistic locking exists ONLY for account balances** (`src/lib/supabaseDb.ts:78-98`) and recurring-template advances (`src/stores/recurringStore.ts:100-107`). Loans, EMIs, goals, group expenses, and group settlements are all absolute-write, read-then-write — every one is a multi-device lost-update or double-settle waiting to happen (§4.6).
- **Offline is a hard-fail mode**: the outbox is a scaffold whose every dispatch handler throws behind a disabled flag (`src/lib/outboxRunner.ts:26-29,140-163`), so a network drop mid-`transfer` can permanently strand a half-applied money move (§4.7) — the exact failure the compensation pattern's own comment admits it cannot fix (`src/lib/mutationSafety.ts:10-13`).
- **The PIN lock is still a no-op** — settable and hashed in Settings (`src/stores/authStore.ts:38-45`) but `PinLockScreen` has zero importers (only its own definition at `src/pages/PinLockScreen.tsx:12`), while the Play listing sells it (`docs/play-store-listing.md:50,103,128`) and even asserts "Every feature named … is a shipped feature" (`docs/play-store-listing.md:145`).
- **Date-boundary logic is split between two calendars** — a local-date helper exists precisely because "toISOString() is UTC and lags local by 4–5h in this app's Gulf/Pakistan markets" (`src/lib/thisWeek.ts:74-84`), yet ~20 call sites still use the UTC calendar, including the recurring-due runner itself (`src/lib/recurringRunner.ts:34`) and monthly-wrap grouping (`src/lib/monthlyWrap.ts:86`) (§4.4).
- **The test suite's own determinism claim is false**: `vitest.config.ts:13-15` says the setup file pins UTC for DST-boundary determinism, but `vitest.setup.ts` contains only a localStorage polyfill and no `TZ` assignment; `.github/workflows/ci.yml` sets no `TZ` either. CI is deterministic only because ubuntu runners happen to default to UTC.

**Scores (1–10):** input validation **5**, error handling & recovery **7**, concurrency safety **4**, offline resilience **3**, date/time correctness **4**, duplicate-submission safety **6**, release-safety net (tests/CI) **5**. Overall QA readiness: **4.5/10** — not ready for a public launch without the fixes ranked in §8.

---

## 2. Input validation map

### 2.1 No validation layer exists

- No schema-validation dependency: grep for `zod|yup|valibot|ajv|superstruct` in `package.json` returns nothing.
- The DB gateway (`src/lib/supabaseDb.ts`) passes fields through verbatim (e.g. `accountsDb.add`, `src/lib/supabaseDb.ts:57-63`); whatever a store hands it reaches Postgres.
- The store layer is inconsistent: some branches validate (`transfer` requires distinct accounts and a rate for cross-currency, `src/stores/transactionStore.ts:819-830`; investment trades run `validateTradeInput`, `src/stores/transactionStore.ts:1217-1220`; group expenses require `amount > 0`, `src/stores/splitStore.ts:629-631`), while others trust callers completely — `income` (`src/stores/transactionStore.ts:794-801`) and `opening_balance` (`src/stores/transactionStore.ts:1183-1190`) apply `input.amount` with **no positivity, finiteness, or magnitude check**. A future caller passing `NaN` or a negative would corrupt a balance or fail opaquely at the RPC.

### 2.2 Per-form reliance on ad-hoc checks (the actual defense line)

| Form / surface | Validation | Evidence | Gap |
|---|---|---|---|
| QuickEntry (numpad) | digits + one `.` + 2dp only; `canSubmit` requires truthy `parseFloat(amount)` | `src/pages/QuickEntry.tsx:276-280,525-562` | `parseFloat` accepts nothing bad here because the numpad constrains input; but `!amt` also blocks legitimate `0`-only states silently |
| RepaymentModal | `parsedAmount > 0`, overpayment cap, ledger-mode account exemption, `rateIsSane` | `src/pages/RepaymentModal.tsx:117-126,140-152` | Good — this is the post-lesson hardened form (`tasks/lessons.md:20-27`) |
| AllocateRepaymentModal | lump `> 0`, per-loan clamp to remaining, total ≤ remaining+ε | `src/components/AllocateRepaymentModal.tsx:73-105` | Manual-mode `type="number"` inputs accept `e`/`-` keystrokes; negatives are filtered by `.filter((a) => a.amount > 0)` (line 81) — OK |
| AddAccountStepper | opening balance blank=0, never negative/non-numeric; CC limit `> 0`, dueDay 1–31 | `src/pages/AddAccountStepper.tsx:107-121` | Good |
| AddGroupExpenseModal | `amount > 0` (store), soft duplicate warning (same description+amount within 1h) | `src/stores/splitStore.ts:629-631`, `src/pages/AddGroupExpenseModal.tsx:183`, `src/lib/duplicateExpense.ts:19-36` | Duplicate detection exists ONLY for group expenses — personal expenses/loans have no double-log detection |
| Hisaab AI split confirm | `parseAmountExpression` fallback `parseFloat`; `Number.isFinite(amt) && amt > 0` gate | `src/pages/HisaabAIPage.tsx:978-979,1024-1025` | OK; input charset regex-filtered (line 1006) |
| Recurring template create | `validateRecurringStart` blocks absurd start dates at the store ("server of last resort") | `src/stores/recurringStore.ts:49-56` | Validates against **UTC** today (see §4.4) |
| Linked (cross-user) request | `plausibilityCheck` blocks zero/negative/absurd; AED/PKR magnitude bounds; deliberate-confirm thresholds | `src/stores/linkedRequestStore.ts:107-113`, `src/lib/currencyValidation.ts:30-67,96-105` | **Bounds exist only for AED and PKR** — `CURRENCY_BOUNDS` has two keys (`src/lib/currencyValidation.ts:13-16`); PHP/SAR/QAR/KWD/BHD/OMR amounts are unbounded ("Currencies without bounds … always pass", line 28-29) |
| Committee create | `name.trim()`, members mapped as-is | `src/stores/committeeStore.ts:67-104` | No check that `contributionAmount > 0` or `members.length >= 2` at store level — UI-only |

### 2.3 Amount-expression parsing

`parseAmountExpression` (`src/lib/parseAmountExpression.ts:6-75`) is a safe hand-written recursive-descent parser (no `eval`, whitelist, division-by-zero → null, 2dp rounding). **Note it can legitimately return negative values** ("5-10" → −5); the only caller (`src/pages/HisaabAIPage.tsx:978,1086`) guards with `amt > 0`, but any future caller must repeat that guard — the parser itself does not enforce positivity. Contrary to the phase brief's assumption, QuickEntry does **not** use it (grep: only HisaabAIPage imports it) — the numpad path is `parseFloat` only (`src/pages/QuickEntry.tsx:526`).

### 2.4 Currency mismatches

- Cross-currency transfer/repayment/goal/investment paths all demand a `conversionRate` and check `rateIsSane` (`src/stores/transactionStore.ts:828-830,1032,1062`, `src/lib/conversionMath.ts:10-15`). **Finding (medium):** the sane window is 0.0001–100000 — five orders of magnitude — so a decimal-point typo (22.6 vs 226) passes every check; there is no per-pair plausibility (the AED↔PKR ≈76 knowledge in `src/lib/currencyValidation.ts:11` is used for *display*, never to bound entered rates).
- Repayment allocation account pickers filter to loan-currency accounts (`src/components/AllocateRepaymentModal.tsx:62-65`), and cash-advance paths enforce card/loan currency match (`src/stores/transactionStore.ts:987-988,1047-1049`). Good.
- Linked-loan mirrors lock currency at creation, enforced by `assertLinkedLoanEditAllowed` (`src/stores/loanStore.ts:184`).

**Findings:**
- **[HIGH] V-1.** Store-level money mutations accept unvalidated amounts for several types (income, opening_balance) — the single validation layer is per-form and inconsistent; any new caller (AI flows, future outbox replay) can post negative/NaN money. `src/stores/transactionStore.ts:794-801,1183-1190`.
- **[MEDIUM] V-2.** Currency plausibility bounds cover only 2 of 8 currencies. `src/lib/currencyValidation.ts:13-16,28-29`.
- **[MEDIUM] V-3.** `rateIsSane`'s 0.0001–100000 window cannot catch order-of-magnitude rate typos; a wrong rate silently corrupts the destination balance (its own comment admits the stakes: `src/lib/conversionMath.ts:7-9`).
- **[LOW] V-4.** No duplicate-entry detection outside group expenses (`src/lib/duplicateExpense.ts` is imported only by `AddGroupExpenseModal.tsx:20`).

---

## 3. Error handling & recovery

### 3.1 MutationScope compensation — and what happens when rollback itself fails

The pattern (`src/lib/mutationSafety.ts:22-74`) registers LIFO inverses; on failure `rollback()` runs every compensation best-effort, collects errors, and `runSafeMutation` invokes `onRollbackFailure` (in practice `refetchMoneyStores`, `src/stores/transactionStore.ts:630-642`) before rethrowing the original error.

Traced honestly, the failure ladder is:

1. **Forward step fails, compensations succeed** → remote and local are restored; user sees an error toast. ✅
2. **Forward step fails, a compensation fails** → `refetchMoneyStores` re-pulls accounts/transactions/loans/EMIs/goals in parallel so *local* state matches whatever *remote* now holds. But remote itself is now **half-applied** (e.g. transfer: source debited via the already-committed `apply_account_balance_delta`, destination never credited). Nothing re-attempts the compensation later — there is no persistent repair queue (the outbox is disabled, §4.7). The file's own header admits this: "Compensations may themselves fail (same network outage that killed the forward write usually kills the inverse)" (`src/lib/mutationSafety.ts:10-13`). The only user-facing remedy is the manual `adjustment` transaction type (`src/stores/transactionStore.ts:89-97,1193-1207`). **[HIGH] E-1.**
3. **Refetch also fails (fully offline)** → local state may be stale *and* remote half-applied; a `console.error` is the only trace (`src/stores/transactionStore.ts:639-641`).

Two deliberate deviations are well-documented and correct: tracked helpers bypass store methods whose embedded `logActivity` could throw *after* the persist and defeat compensation registration (`src/stores/transactionStore.ts:305-310,433-438`), and post-commit activity-log failures are swallowed (`src/stores/transactionStore.ts:614-623`).

**Compensation snapshot-staleness caveat [MEDIUM] E-2:** `trackedApplyRepayment` snapshots `prevRemaining` from local state and its inverse writes that **absolute** value back (`src/stores/transactionStore.ts:352-371`). If another device modified the loan between forward write and rollback, the rollback silently clobbers the other device's change. Same shape in `trackedAddContribution` (`src/stores/transactionStore.ts:404-417`) and the EMI status restores (`src/stores/transactionStore.ts:486-494`). Only `trackedBalanceDelta`'s inverse is commutative ("delta-based … so concurrent mutations commute" is claimed at `src/stores/transactionStore.ts:280-282`, but three of the helpers are snapshot-based, not delta-based).

### 3.2 Manual (non-scope) rollbacks

`splitStore.addGroupExpense` creates the personal mirror transaction *first*, then the group row; if the group insert fails it manually deletes the mirror and merely logs if that rollback fails (`src/stores/splitStore.ts:662-693`) — an orphaned personal expense referencing a nonexistent group expense id. **[MEDIUM] E-3.**

### 3.3 appRecovery / stale-chunk handling

`src/lib/appRecovery.ts` is solid: pattern-matches five chunk-failure signatures (lines 17-23), presents a differentiated "App update available" UI (41-50), and recovery deletes only `hisaab-*` caches, updates the SW registration, and reloads *even if those steps throw* (60-86). Tested (`src/lib/appRecovery.test.ts` exists). One gap: `recoverFromStaleApp` never clears a stuck outbox/Dexie state, and the "Your saved data is safe" copy (line 48) is untested against a mid-mutation failure — but as a chunk-recovery tool it is fit for purpose. ✅

### 3.4 Committed-prefix loops report honestly

Both batch executors stop at first failure, return `done/total`, and the UIs surface "applied to N of M" (`src/lib/repaymentExecution.ts:38-79`, `src/components/AllocateRepaymentModal.tsx:141-154`, `src/pages/QuickEntry.tsx:660-675,904-919`). Retry safety is real: re-running recomputes allocations from the now-reduced remainings (`src/lib/repaymentExecution.ts:4-6`). ✅ (But see §4.2 for what the artifact trail looks like mid-failure.)

---

## 4. Edge cases

### 4.1 Currency-conversion rounding in repayment allocation

- Allocation math rounds every intermediate to 2dp (`round2` in `src/lib/repaymentAllocation.ts:21-49`), guaranteeing Σ allocations = min(lump, total remaining) at 2dp.
- The **per-item conversion rule** is honored: the consolidated tracker-mode path deliberately sums per-item rounded conversions rather than rounding the total once — "the store rounds each of the N repayments separately, so rounding once on the total here would drift from the real balance by cents" (`src/pages/QuickEntry.tsx:801-804`); the store side rounds each `srcDeduct`/`destAmt` per repayment (`src/stores/transactionStore.ts:1034,1064`).
- Residual risk **[LOW] R-1:** loan `status: 'settled'` requires `newRemaining === 0` exactly (`src/stores/loanStore.ts:91`); the clamp `Math.max(0, …)` makes full payoffs exact, but a float chain that leaves 0.0000001 remains 'active'. `trackedApplyRepayment` rounds to 2dp first (`src/stores/transactionStore.ts:356`) so the tracker path is safe; the ledger path (`loanStore.applyRepayment`) does **not** round `newRemaining` (line 90) — a 3-decimal amount (possible via `type="number"` step bypass in manual allocation inputs) could strand a loan at 0.004 forever, invisible (display rounds) but never 'settled'.

### 4.2 Consolidated repayment interrupted mid-loop

By design N independent commits (`src/lib/repaymentExecution.ts:1-8`). Interruption behaviors verified:

- **Failure thrown by step k:** committed prefix stays; toast reports k of N; QuickEntry and AllocateRepaymentModal both close and keep the prefix (`src/pages/QuickEntry.tsx:660-675`, `src/components/AllocateRepaymentModal.tsx:141-154`). Retry recomputes → no double-pay. ✅
- **Process death / tab close mid-loop (not a thrown error):** no report at all — the user finds some loans paid and some not, with **no marker that these N rows belonged to one lump** (each repayment is an ordinary row; unlike ad-hoc splits there is no shared `splitEventId` — compare `src/lib/splitEvent.ts:82-84`). Statement reads as N separate payments. **[MEDIUM] R-2.**
- **Ledger-mode step semantics:** each step calls `applyRepayment`, whose *balance write succeeds first* and whose record-keeping transaction row is explicitly **best-effort** — "the balance update above is the source of truth and must not be failed retroactively if the record write hits a network error" (`src/stores/loanStore.ts:107-141`). So a flaky connection can reduce `remainingAmount` *with no transaction row, no activity line* — a degraded regression of the exact incident `tasks/lessons.md:6-13` documents ("silently vanished the user's payment records"). The loop treats that step as *success* (no error thrown), so not even the "N of M" toast fires. **[HIGH] R-3.**

### 4.3 Recurring-transaction idempotency across device clocks

The design is strong:

- Expansion stamp `templateId@dueDate` written into the transaction's internal note; a second Confirm (retry, stale modal on another device) is detected and refused (`src/components/RecurringDuePrompt.tsx:54-73`).
- Due-date advance is a server compare-and-set — `advanceIfDue(id, expectedCurrent, next)`; a loser refreshes instead of double-advancing ("which would silently skip a month", `src/stores/recurringStore.ts:100-107`).
- Post-date anchoring: the materialized transaction is stamped at due-date noon so a late confirm doesn't misfile months (`src/components/RecurringDuePrompt.tsx:76-79`).
- Cross-tab prompt storm is soft-locked via localStorage TTL 60s (`src/lib/recurringRunner.ts:15-31`).

Residual gaps:

- **[MEDIUM] R-4. Clock-forward device:** a device with a wrong future date sees templates "due", and a user confirming posts them early and advances `nextDueDate` — the CAS protects against *concurrent* advance, not *wrong-clock* advance. When the clock is fixed, the entry exists with a future stamp. No server-time check anywhere (all `Date.now()`/`new Date()` are client-local).
- **[MEDIUM] R-5. Stamp check degrades offline:** if `loadTransactions()` fails, the dedupe check runs against an empty/stale list ("stamp check degrades gracefully", `src/components/RecurringDuePrompt.tsx:62-63`) — two devices confirming the same due template in the same window can still double-post; the second device's `advanceIfDue` will lose, but its *transaction* has already posted. Bounded (needs two devices + same window + no sync), but it is real money duplication.

### 4.4 Timezone / date-boundary divergence (tests pin UTC — except they don't)

The codebase *knows* the right rule: `localIso` exists "because every surface that compares against date-only fields … must use the SAME calendar — toISOString() is UTC and lags local by 4-5h in this app's Gulf/Pakistan markets, misclassifying 'today' between midnight and dawn" (`src/lib/thisWeek.ts:74-84`). Yet the UTC calendar is still used at ~20 sites (grep `toISOString().slice(0, 10)`), including:

- **`src/lib/recurringRunner.ts:34`** — the due scan itself. A template due today does not prompt between local midnight and ~04:00–05:00 (Gulf/PK offsets). It self-heals later that day, but "reminder didn't fire on the morning I opened the app" is a trust bug in a reminders product. **[MEDIUM] T-1.**
- **`src/stores/recurringStore.ts:53` + `src/components/AddRecurringModal.tsx:46,68,98`** — start-date default and validation use UTC today; between midnight and dawn the modal defaults to *yesterday's* date and "today" can be soft-flagged as past. **[LOW] T-2.**
- **`src/lib/monthlyWrap.ts:86`** — Wrap groups spend by UTC day; a 01:00 local expense on the 1st files into the *previous month's* Wrap. **[LOW] T-3.**
- **`src/lib/loggingStreak.ts:11-18`** — streak days derive from UTC timestamps; logging at 01:00 counts for "yesterday", silently breaking/extending streaks. **[LOW] T-4.**
- **`src/pages/SubscriptionsPage.tsx:59`, `src/pages/HisaabAIPage.tsx:189`, `src/pages/InboxPage.tsx:266`** — mixed with `localIso`-based Home surfaces, so *Home and Subscriptions can disagree about whether the same template is due* in the midnight–dawn window. **[MEDIUM] T-5.**

DST itself is a non-issue for the target markets (Gulf/PK have no DST) and `advanceDate` is day-anchored UTC math with correct month-end clamping and anchoring (`src/stores/recurringStore.ts:136-169`) — genuinely good. The documented residual (Jan 31 → Feb 28 → Mar 28 for non-month-end anchors) is acknowledged in-code (`src/stores/recurringStore.ts:133-135`).

**[MEDIUM] T-6. False test-determinism claim:** `vitest.config.ts:13-15` — "Pinning to UTC in CI keeps DST-boundary assertions deterministic" via `setupFiles` — but `vitest.setup.ts` only polyfills storage (no `process.env.TZ`), and `.github/workflows/ci.yml` sets no TZ (whole file reviewed). A developer in GST running `npm test` executes date-sensitive tests in GST; CI is UTC only by runner default. Any date-boundary test that passes locally and fails in CI (or vice versa) will confuse triage.

### 4.5 Duplicate submissions (double-tap)

The convention is a `saving` state that disables the button — present in QuickEntry (`src/pages/QuickEntry.tsx:136,620,1212`), AllocateRepaymentModal (`:48,121,173`), RepaymentModal (`:61,185,285`), RecurringDuePrompt (`working`, `:28,209`).

- **[MEDIUM] D-1.** None of the handlers **re-check** the flag on entry: `handleSubmit` in QuickEntry goes straight to work (`src/pages/QuickEntry.tsx:616-620`), relying on the DOM `disabled` attribute updating before the second tap lands. On a janky low-end Android WebView (the primary market device), two taps inside one long frame both dispatch. Consequences vary: a doubled expense (two rows, two debits — optimistic-lock retry makes the second debit *succeed*, not fail), a doubled loan, a doubled linked request. A one-line `if (saving) return;` guard is missing everywhere.
- **Protected by the DB anyway:** committee payment ticks — `unique (member_id, round)` (`supabase-migration-committees.sql:51`) makes the second insert error out; recurring confirm is stamped (§4.3); settlement/link accepts are status-gated server-side (`supabase-migration-cross-user-account-effects.sql:189,446` — *pending apply*, see §9).
- **Unprotected:** `linkedRequestStore.createRequest` has no idempotency key (`src/stores/linkedRequestStore.ts:107-131`) — a double-fire sends the counterparty **two identical debt requests**, each independently acceptable → mirrored debt duplicated across two users. Highest-blast-radius double-tap in the app. **[HIGH] D-2.**
- `committeeStore.runBallot` has **no drawn-guard in the store** (`src/stores/committeeStore.ts:115-130`); the UI hides the button once `isDrawn` (`src/pages/KametiDetailPage.tsx:88,104`), but a double-tap before re-render, or a second device with stale state, re-shuffles slots after members may have seen (or been WhatsApp'd) the first draw — in a feature whose selling point is *provable fairness*. **[MEDIUM] D-3.**

### 4.6 Concurrent edits from two devices — the lock inventory

| Entity | Concurrency control | Evidence | Multi-device failure mode |
|---|---|---|---|
| Account balance | Optimistic lock RPC + one refetch-retry | `src/lib/supabaseDb.ts:78-98`, `src/stores/accountStore.ts:120-155` | Safe for the *delta*; see caveat below |
| Recurring nextDueDate | Compare-and-set `advanceIfDue` | `src/stores/recurringStore.ts:100-107` | Safe |
| Loan remainingAmount | **None** — read local state, write absolute value | `src/stores/loanStore.ts:87-98`, `src/stores/transactionStore.ts:352-359` | Two devices repay simultaneously → last write wins; one repayment's reduction is **lost** while both repayment transaction rows (and both account debits) exist → user's records say they paid 2×X but the loan only dropped by X. Money-integrity corruption. **[HIGH] C-1** |
| EMI status | None (absolute status writes) | `src/stores/transactionStore.ts:482,710` | Statuses flap; self-heals on next reconcile — bounded |
| Goal savedAmount | None (read-modify-write with clamp) | `src/stores/goalStore.ts:74-83` | Lost contribution on concurrent add **[MEDIUM] C-2** |
| Group expense | `version` column **stored but never compared** — update filters by id only | `src/lib/supabaseDb.ts:1002-1026` (row.version written if provided; no `.eq('version', …)`) | Concurrent edits: last-writer-wins, splits silently overwritten. The version field is decorative. **[HIGH] C-3** |
| Group settlement | Client-side cap check (read debts → insert), no server guard | `src/stores/splitStore.ts:1048-1076` | Two members record the same debt's settlement concurrently → both pass `cap`, both insert → debt over-settled / direction flips negative. **[HIGH] C-4** |
| Cross-user requests (loan/settlement) | Server RPC status gate (`status <> 'pending'` → error) | `supabase-migration-cross-user-account-effects.sql:189,446` | Safe **iff the migration was applied** (§9) |
| Committee slots/draw | None | `src/stores/committeeStore.ts:115-150` | See D-3 |

**Balance-lock caveat [MEDIUM] C-5:** on `BALANCE_CONFLICT`, `updateBalance` refetches and retries with the fresh expected balance (`src/stores/accountStore.ts:137-145`) — but the *insufficient-balance guard* (`checkBalance`, `src/stores/transactionStore.ts:192-201`) already ran against the stale figure and is **not re-run**. Device A empties the account; device B (holding the ≤2-min-fresh mirror, `src/lib/mirrorCache.ts:5,186-191`) records a large expense: stale check passes → conflict → refetch-retry **succeeds** → balance goes negative with no warning, in full-tracker mode whose contract is "strict validation" (`src/stores/transactionStore.ts:250-253`).

### 4.7 Offline mid-mutation with the outbox disabled

- The outbox is a scaffold: flag off by default and every dispatch handler throws (`src/lib/outboxRunner.ts:26-29,140-163`). No store writes to it (`enqueueOutboxOp` has no production callers in stores).
- Write ordering is DB-first everywhere (e.g. `loansDb.add` before state update, `src/stores/loanStore.ts:74-77`; `transactionsDb.add` before state, `src/stores/transactionStore.ts:509-513`), so a *fully* offline single-step write fails cleanly with an error toast and no phantom local state. ✅
- The dangerous window is **connectivity loss mid-multi-step scope**: step 1 committed remotely, step 2 fails, compensations fail (§3.1 case 2/3) → **permanent half-applied money** (debited source, no credited destination; or repaid loan with no card credit) with no repair queue and no persisted marker. Recovery = the user noticing and using the `adjustment` type. **[HIGH] O-1.**
- The mirror serves cached reads for a snappy offline *open* (`src/lib/mirrorCache.ts:189-204`), and `OfflineBanner` signals connectivity (`src/App.tsx:443`) — but every mutation hard-fails. The Play listing nevertheless claims "Offline-first — log on the bus or in a no-signal basement; syncs when you're back online" (`docs/play-store-listing.md:43,96`). **[HIGH] O-2 — false product claim** (independently flagged in Phase 1; re-verified here at the code level).

### 4.8 Deep-link / invite tokens

- **Group invites:** stored as `token_hash` with `expires_at`, `revoked_at`, `accepted_by/at` (`src/lib/supabaseDb.ts:1212-1224`); acceptance goes through the `accept_group_invite` RPC by hash (`src/lib/supabaseDb.ts:1429-1431`). Client failure taxonomy handles not-found/expired/group-gone/auth/network distinctly and clears the stored pending token only for terminal failures (`src/pages/JoinGroupPage.tsx:19-68,90-98`). Pending-invite resume across login/onboarding is pure and tested (`src/lib/pendingInvite.ts:17-27`, `pendingInvite.test.ts`). Structurally sound. Whether a token is single-use vs reusable-until-expiry, and expiry length, live in the SQL/RPC — client evidence alone cannot confirm reuse blocking (§9).
- **Cross-account acceptance:** `acceptInvite` requires an authenticated session (auth failure branch, `src/pages/JoinGroupPage.tsx:47-54`); a token forwarded to a second person joins *that* person — by design for group invites (invite = capability). The `linked_member_id` claim path exists (`src/lib/supabaseDb.ts:1219`) — whether an already-claimed member slot rejects a second claimer is RPC-side (§9).
- **Join by code:** `join_group_by_code` RPC, direct table lookup disabled client-side (`src/lib/supabaseDb.ts:1394-1408`); rate-limiting was part of prelaunch hardening (`supabase-migration-prelaunch-hardening.sql` per its filename; MEMORY records join-code rate limit applied 2026-05-26).
- **Kameti witness link:** 256-bit token (`src/stores/committeeStore.ts:132-139`), read-only anon SECURITY DEFINER RPC returning null for bad tokens (`src/lib/supabaseDb.ts:1815-1819`). **[LOW] K-1:** `ensureShareToken` is create-only — no revoke/rotate anywhere in the store; a witness link, once shared, exposes the committee snapshot forever.
- **[MEDIUM] K-2. i18n hole on the invite surface:** `JoinGroupPage` is 100% hardcoded English (`src/pages/JoinGroupPage.tsx:26-28,88,127-167` — no `useT` import) in an ur-default app. The first screen a invited non-user's relative sees may be in the wrong language.

### 4.9 The two-app-mode matrix — three flows traced

Per `tasks/lessons.md:8-13`: "before calling a money feature done, enumerate every artifact each mode leaves behind (transaction row? activity entry? statement line? loan history?) and prove each exists."

**Flow A — single loan repayment**

| Artifact | full_tracker | splits_only |
|---|---|---|
| Path | `processTransaction({type:'repayment'})` (`src/pages/RepaymentModal.tsx:193-246`) | `applyRepayment` (`src/pages/RepaymentModal.tsx:193-194`) |
| Account leg(s) | ✅ debit/credit via `trackedBalanceDelta` (`src/stores/transactionStore.ts:1035,1080`) | ✅ n/a by design (no accounts) |
| Transaction row | ✅ inside scope (`src/stores/transactionStore.ts:1380`) | ⚠️ written with both account ids null — but **best-effort**, swallowed on failure (`src/stores/loanStore.ts:115-141`) |
| Loan remaining/status | ✅ snapshot-compensated (`:348-372`) | ✅ but no compensation at all — a repayment is one absolute write |
| Activity entry | ✅ (`:1389-1394`) | ⚠️ best-effort (`src/stores/loanStore.ts:143-154`) |
| EMI reconcile | ✅ in-scope (`:1099-1111`) | ⚠️ best-effort (`src/stores/loanStore.ts:169-176`) |

Verdict: the tracker column is atomic-ish; the ledger column's *only* guaranteed artifact is the mutated `remainingAmount` — everything else can silently drop on a network blip (finding R-3). The mode-guard lesson itself (dead Record button) is fixed: `canSubmit`/first-guard both carry the ledger exemption (`src/pages/RepaymentModal.tsx:124,140-144`).

**Flow B — consolidated (multi-loan) repayment**

| | full_tracker | splits_only |
|---|---|---|
| Path | N × `processTransaction` (`src/lib/repaymentExecution.ts:62-72`) | N × `applyRepayment` (`:59-61`) |
| Account required | yes (`src/components/AllocateRepaymentModal.tsx:102-105` — `isLedgerOnlyMode ||` exemption present) | no |
| Partial-failure report | ✅ "N of M" both modes (`AllocateRepaymentModal.tsx:141-154`) | ✅ — but see R-3: ledger step "success" doesn't guarantee a record row |
| Lump grouping artifact | ❌ none in either mode (R-2) | ❌ |

**Flow C — ad-hoc split (SplitWithSheet → executeSplitEvent)**

The money model is explicitly documented per mode (`src/lib/splitEvent.ts:6-27`): tracker/i_paid = own-share expense + per-person `loan_given` receivables (account moves by full T, analytics see only m); they_paid = a single taken loan, no account leg; splits_only = "no accounts exist, so both directions are loans only" (`:22`). Rows share a `splitEventId` (`:82-84`) — the batch *is* reconstructible, unlike Flow B. Receivables commit before the payer's own share so a mid-batch failure loses the recoverable row, never the obligations (`:30-34`). QuickEntry passes the mode correctly (`src/pages/QuickEntry.tsx:890`) and reports committed prefixes (`:904-919`). In splits_only, QuickEntry's intent menu exposes only person/group entries (`src/pages/QuickEntry.tsx:204-206`), so the tracker-only `account!` deref at `:864` is unreachable in ledger mode — verified guarded by `canSubmit` requiring `sourceId` for expenses (`:540`). ✅ Best-designed of the three flows.

**Matrix residual [MEDIUM] M-1:** mode is a client-side stored preference (`useAppModeStore`) and `isSimpleModeBalanceBypassAllowed` disables balance checks entirely in splits_only (`src/stores/transactionStore.ts:235-243`). A mode *switch* after data exists (splits→tracker) inherits transactions with null account ids and loans with no funding legs; nothing in the store layer reconciles them. No migration/guard code for mode switching was found (search: no `setMode` migration logic in `src/stores/appModeStore.ts`, 21 lines).

---

## 5. Consolidated findings (severity-ranked)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| F-1 | **critical** | PIN lock settable but never enforced (`PinLockScreen` unimported) while the store listing claims it as shipped — false security claim at launch | `src/pages/PinLockScreen.tsx:12` (sole reference), `src/stores/authStore.ts:27-45`, `docs/play-store-listing.md:50,103,128,145` |
| F-2 | **high** | Concurrent loan repayment across devices = lost update; records (rows + debits) exceed actual loan reduction | §4.6 C-1; `src/stores/loanStore.ts:87-98` |
| F-3 | **high** | Ledger-mode repayment record row is best-effort → payment can vanish from history on network blip (degraded recurrence of the 2026-07-18 incident) | R-3; `src/stores/loanStore.ts:107-141`; `tasks/lessons.md:6-13` |
| F-4 | **high** | Half-applied multi-leg mutation is permanent when compensation fails offline; no repair queue (outbox disabled/scaffold) | O-1/E-1; `src/lib/mutationSafety.ts:10-13`, `src/lib/outboxRunner.ts:26-29,140-163` |
| F-5 | **high** | "Offline-first … syncs when you're back online" is untrue — all mutations hard-fail offline | O-2; `docs/play-store-listing.md:43,96` |
| F-6 | **high** | Group-expense `version` never compared on update — concurrent edits silently clobber | C-3; `src/lib/supabaseDb.ts:1002-1026` |
| F-7 | **high** | Group settlement cap is a client-side TOCTOU — concurrent recordings over-settle | C-4; `src/stores/splitStore.ts:1048-1076` |
| F-8 | **high** | Double-fired linked request duplicates mirrored debt across two users (no idempotency key, no `saving` re-check in handlers) | D-2/D-1; `src/stores/linkedRequestStore.ts:107-131`, `src/pages/QuickEntry.tsx:616-620` |
| F-9 | **high** | Store-level mutations accept unvalidated amounts (income/opening_balance); the only validation layer is per-form ad-hoc | V-1; `src/stores/transactionStore.ts:794-801` |
| F-10 | medium | Stale-balance retry path bypasses the insufficient-balance guard → silent negative balances in strict mode | C-5; `src/stores/accountStore.ts:137-145` |
| F-11 | medium | Two calendars (UTC vs localIso) disagree between midnight and dawn — recurring runner, wrap, streaks, subscriptions vs Home | T-1..T-5; `src/lib/recurringRunner.ts:34` vs `src/lib/thisWeek.ts:74-84` |
| F-12 | medium | vitest "UTC pin" claimed but not implemented; CI deterministic only by runner default | T-6; `vitest.config.ts:13-15`, `vitest.setup.ts`, `.github/workflows/ci.yml` |
| F-13 | medium | Ballot re-run possible (no store/server drawn-guard) — undermines provable-fairness promise | D-3; `src/stores/committeeStore.ts:115-130` |
| F-14 | medium | Snapshot-based compensations clobber concurrent third-party writes on rollback | E-2; `src/stores/transactionStore.ts:352-371` |
| F-15 | medium | Currency plausibility bounds only for AED/PKR; conversion-rate sanity window spans 5 orders of magnitude | V-2/V-3; `src/lib/currencyValidation.ts:13-16`, `src/lib/conversionMath.ts:10-11` |
| F-16 | medium | Invite-acceptance page hardcoded English in an ur-default app | K-2; `src/pages/JoinGroupPage.tsx:26-68` |
| F-17 | medium | Mode switch (splits→tracker) has no data reconciliation path | M-1; `src/stores/appModeStore.ts` |
| F-18 | medium | Consolidated repayment leaves no lump-grouping artifact (splits do: `splitEventId`) | R-2; `src/lib/repaymentExecution.ts` vs `src/lib/splitEvent.ts:82-84` |
| F-19 | low | Ledger `applyRepayment` doesn't round remaining → possible never-settled 0.00x loans | R-1; `src/stores/loanStore.ts:90-91` |
| F-20 | low | Witness share token has no revoke/rotate | K-1; `src/stores/committeeStore.ts:132-139` |
| F-21 | low | No duplicate-entry detection for personal expenses/loans | V-4; `src/lib/duplicateExpense.ts` usage |

---

## 6. Artifact 1 — Manual testing checklist (by flow)

No store/DB-layer automated tests exist by design (`vitest.config.ts:1-6`), so this checklist IS the current safety net. Each item lists the check and the pass condition. Run in **both modes** where marked ⚖; run on a real low-end Android device where marked 📱.

### 6.1 Onboarding & modes
- [ ] Complete 6-step onboarding in ur and en; verify mode quiz lands full_tracker and splits_only correctly (`src/lib/modeQuiz.ts`).
- [ ] splits_only: verify `/accounts`, `/transactions`, `/budgets`, `/subscriptions`, `/investments`, `/goals` all redirect home (`src/App.tsx:458-493`).
- [ ] splits_only: QuickEntry offers ONLY person/group intents (`src/pages/QuickEntry.tsx:204-206`).
- [ ] Create first account with blank balance (=0), negative balance (blocked), and `1e5`-style input (`src/pages/AddAccountStepper.tsx:112-121`).

### 6.2 QuickEntry money entries ⚖ 📱
- [ ] Expense/income/transfer happy paths; verify before/after balances in the confirmation match actual account changes.
- [ ] Transfer to same account blocked (`src/stores/transactionStore.ts:819`).
- [ ] Cross-currency transfer without rate blocked; rate 0, rate 0.00001, rate 100001 blocked (`src/pages/QuickEntry.tsx:528-531`, `src/lib/conversionMath.ts:10-15`).
- [ ] **Double-tap the save button as fast as possible on a mid-scroll janky frame** 📱 — exactly one transaction row must exist afterwards (D-1).
- [ ] Expense that would leave the account short of an upcoming bill triggers the spending warning; equal-or-safe amounts don't (`src/pages/QuickEntry.tsx:573-587`).
- [ ] Insufficient balance blocked in tracker; permitted (negative allowed) in splits_only (`src/stores/transactionStore.ts:235-254`).

### 6.3 Loans & repayments ⚖
- [ ] Create given/taken loans in both modes; ledger mode must show the currency picker, not an account picker (`src/pages/QuickEntry.tsx:1707-1716`).
- [ ] Single repayment, both modes: verify ALL artifacts — loan remaining, status on full payoff, transaction row (null/null accounts in ledger), activity line, statement line, EMI statuses (lessons rule, `tasks/lessons.md:8-13`).
- [ ] Ledger repayment **with network killed right after tapping save** 📱: balance must NOT change without a record row — this currently FAILS by design (F-3); document actual behavior.
- [ ] Overpayment blocked at UI in both modes (`src/pages/RepaymentModal.tsx:117-126`); typed exact remaining fully settles (status flips).
- [ ] Repayment on a linked loan bounces to the loan page settle flow (`src/pages/QuickEntry.tsx:638-643`).
- [ ] Consolidated repayment: smallest/largest/oldest/manual strategies; leftover warning when lump > total; per-loan clamp in manual mode (`src/components/AllocateRepaymentModal.tsx:73-105`).
- [ ] Consolidated repayment partial failure (airplane mode mid-batch) 📱: verify "applied to N of M" toast and that retry only covers the remainder without double-pay (`src/lib/repaymentExecution.ts:4-7`).
- [ ] Cross-currency repayment: verify the source deduction equals Σ per-item rounded conversions, not a single rounded total (`src/pages/QuickEntry.tsx:801-804`).

### 6.4 Cards / cash advance / EMI (full_tracker only)
- [ ] Cash advance from card → loan created with card as counterparty, no Person row (`src/pages/QuickEntry.tsx:958-975`).
- [ ] Card bill payment via transfer settles funded advance loans; statement-native allocation steps one instalment when limit+dueDay set; greedy fallback otherwise (`src/stores/transactionStore.ts:857-940`).
- [ ] Repay a cash-advance loan whose bill was ALREADY paid: card credit clamped to headroom / skipped, stamp in internal note (`src/stores/transactionStore.ts:1051-1096`).
- [ ] Editing a bill-payment transfer that settled advances is blocked with the delete-and-re-enter message (`src/stores/transactionStore.ts:1427-1434`).
- [ ] EMI: overpaying a targeted instalment marks later covered instalments paid; deleting the repayment un-marks them (`src/stores/transactionStore.ts:1100-1111,696-723`).

### 6.5 Groups & settlements
- [ ] Add group expense with linked personal account: verify personal mirror expense + group row + note metadata linkage (`src/stores/splitStore.ts:662-682`).
- [ ] Duplicate warning when a second member logs same description+amount within 1h (`src/pages/AddGroupExpenseModal.tsx:183`).
- [ ] Non-creator edit/delete of a group expense is rejected with the visible RLS message, not silent success (`src/lib/supabaseDb.ts:1018-1025`).
- [ ] Record settlement > outstanding blocked; second settlement after full settle blocked (`src/stores/splitStore.ts:1055-1063`).
- [ ] **Two devices record the same settlement within seconds** — expected failure today (F-7): document the resulting negative/flipped balance.
- [ ] Settlement delete restricted to its recorder (`src/stores/splitStore.ts:1000-1002`).
- [ ] Group leave/last-member flows per `src/lib/groupLeave.ts` tests.

### 6.6 Invites, links, cross-user
- [ ] Expired invite, revoked invite, deleted-group invite, signed-out acceptance: each shows its distinct message and terminal ones clear the pending token (`src/pages/JoinGroupPage.tsx:19-68,90-98`).
- [ ] Invite deep link opened before login resumes to `/join/<token>` after onboarding completes (`src/lib/pendingInvite.ts:17-27`).
- [ ] Same invite link opened by a second account after acceptance — verify RPC behavior (single-use or capacity?) and record it (§9).
- [ ] Linked loan request: create → accept on second account; verify mirror rows both sides, currency locked, request cannot be accepted twice (server gate) — requires the cross-user-account-effects migration applied (§9).
- [ ] Double-tap "send request" 📱 — check inbox on the receiving account for duplicates (F-8, expected to fail today).
- [ ] Kameti witness link works signed-out; garbage token renders the null path (`src/lib/supabaseDb.ts:1815-1819`).

### 6.7 Recurring / subscriptions (full_tracker)
- [ ] Due template prompts on boot; Confirm posts on the due date at noon, not today (`src/components/RecurringDuePrompt.tsx:76-79`).
- [ ] Confirm on device A, then Confirm the same stale prompt on device B → B shows "already posted" and advances, no second row (`:60-73`).
- [ ] Skip shows the Undo toast and Undo restores the prior due date (`:137-162`).
- [ ] Month-end anchoring: template due Jan 31 advances Feb 28/29 then Mar 31 (`src/stores/recurringStore.ts:146-157`).
- [ ] **Open the app between 00:00 and 05:00 local with a template due today** — currently does NOT prompt (F-11/T-1); document.
- [ ] Set device clock +1 month, open app, DON'T confirm, fix clock — verify nothing advanced (R-4 window is confirm-gated).

### 6.8 Kameti
- [ ] Ballot draw once; verify commitment/seed recompute (`src/lib/committeeDraw.ts` tests) and that the draw button disappears (`src/pages/KametiDetailPage.tsx:88`).
- [ ] Double-tap the draw button 📱 — slots must not silently re-shuffle (F-13, expected fragile).
- [ ] Tick/untick round payments rapidly — unique constraint should surface at most an error toast, never duplicate collected totals (`supabase-migration-committees.sql:51`).

### 6.9 Offline & recovery 📱
- [ ] Airplane mode: app opens from mirror; every save action fails with a clear error and NO local phantom row (`src/lib/mirrorCache.ts:189-204`, DB-first writes).
- [ ] Kill network between transfer legs (throttle to make the window hittable): observe the half-applied result and whether refetch surfaces it (F-4) — document the exact user-visible state.
- [ ] Deploy a new build, keep an old tab, navigate to a lazy route: stale-chunk screen appears, "Refresh app" recovers (`src/lib/appRecovery.ts:41-58,60-86`).
- [ ] Post-rollback refetch: force a mutation failure and verify balances re-sync from remote (`src/stores/transactionStore.ts:630-642`).

### 6.10 i18n & Android parity
- [ ] Every flow above in ur (default) — JoinGroupPage will fail (F-16).
- [ ] Repeat smoke of 6.2/6.3 inside the Capacitor wrapper after `npx cap sync android` (standing rule, `tasks/lessons.md:36-37`).

---

## 7. Artifact 2 — Release regression checklist (run every release)

Ordered by cost-of-miss; ~45 minutes on one web + one Android device pair.

1. **Build & static gates:** `tsc -b`, eslint, vitest, vite build green (`.github/workflows/ci.yml:24-40`) + `npx cap sync android` and a Gradle AAB build hand-off (`tasks/lessons.md:36-37`).
2. **Mode matrix smoke (⚖ both modes):** one expense, one loan create, one repayment, one ad-hoc split — verify each leaves its full artifact set per §4.9 tables (lessons rule `tasks/lessons.md:8-13`).
3. **Balance integrity triangle:** expense + transfer + cross-currency transfer; verify closing balances equal hand-computed figures; verify a BALANCE_CONFLICT (two tabs, simultaneous saves) resolves without drift (`src/stores/accountStore.ts:120-155`).
4. **Repayment core:** single full payoff (status flips settled, EMIs all paid), consolidated partial across ≥3 loans, overpayment blocked; ledger-mode repayment leaves a null/null transaction row (`src/stores/loanStore.ts:115-131`).
5. **Card bill triangle:** cash advance → statement-native bill pay → verify loan knocked down + card credit clamped + no double credit (`src/stores/transactionStore.ts:857-940,1051-1096`).
6. **Delete/undo paths:** delete a repayment (EMI un-mark, balance reversal, allowNegative escape offered when spent — `src/stores/transactionStore.ts:208-233`), delete a loan cascade, delete a group settlement.
7. **Recurring:** one due prompt Confirm posts exactly one row with the due-date stamp; re-Confirm refuses (`src/components/RecurringDuePrompt.tsx:60-73`).
8. **Groups:** add expense (with account link), edit by non-creator rejected visibly, settle, over-settle blocked.
9. **Cross-user:** send + accept a linked loan request between two test accounts; accept twice fails; balances land per chosen accounts.
10. **Invites:** fresh invite joins; expired invite shows expiry message; pending-invite resume through a fresh login.
11. **Offline sanity:** airplane-mode open (mirror renders), one blocked write (clean error, no phantom row), OfflineBanner appears.
12. **Update recovery:** stale-chunk screen + refresh on the previous deployed build.
13. **i18n spot:** the release's changed screens in ur AND en (`tasks/lessons.md:46-48`).
14. **Double-tap sweep:** rapid double-tap on every NEW/CHANGED submit button this release (D-1 is systemic; new forms inherit it).
15. **Timezone spot (release cut near month end):** set device to 00:30 local, check Home "this week", subscriptions due, and any new date-boundary surface agree with each other (F-11).

---

## 8. Artifact 3 — Ranked high-risk scenarios (what breaks, blast radius)

1. **Two devices repay the same loan within minutes (C-1/F-2).** Breaks: `remainingAmount` loses one repayment (absolute write, no lock — `src/stores/loanStore.ts:98`); both transaction rows and both account debits persist. Blast radius: the app's core promise — the khata is now *wrong in the lender's favor or borrower's favor* and the discrepancy is invisible until someone reconciles rows against the loan by hand. Affects any household where two family members track the same debt — the app's exact target user.
2. **Network drop mid-transfer / mid-repayment-with-card-credit (O-1/F-4).** Breaks: money debited, never credited; compensation and refetch both fail offline; no repair queue exists. Blast radius: silent balance shrinkage for a single user; support-unrecoverable except via manual `adjustment`; each occurrence is a trust-terminating event for a money app.
3. **Ledger-mode repayment record write fails (R-3/F-3).** Breaks: loan drops but no transaction/activity/statement artifact — payment history vanishes. Blast radius: splits_only users (a full onboarding segment); recurrence of the incident class the repo's own lessons file calls "unacceptable for a money app" (`tasks/lessons.md:6-13`, `src/stores/loanStore.ts:107-113`).
4. **PIN lock shipped as a claim, not a feature (F-1).** Breaks: user hands phone to a relative believing the hisaab is locked; everything is open (`PinLockScreen` unreferenced). Blast radius: privacy harm in exactly the shared-device culture the product targets + Play-listing misrepresentation ("Every feature named … is a shipped feature", `docs/play-store-listing.md:145`) — a policy/launch risk.
5. **Concurrent group settlement recording (C-4/F-7).** Breaks: both sides of a debt record the same settlement; balances over-settle or flip. Blast radius: whole group's trust in the split math; disputes are social, not just numeric.
6. **Concurrent group-expense edit (C-3/F-6).** Breaks: last-writer-wins clobbers splits despite a `version` column that's never compared (`src/lib/supabaseDb.ts:1002-1026`). Blast radius: per-member owed amounts silently change under people's feet.
7. **Double-tapped linked request (D-2/F-8).** Breaks: counterparty receives two identical debt requests; accepting both mirrors the debt twice on *two users'* ledgers. Blast radius: cross-user — the hardest class to clean up (requires both sides to delete).
8. **Stale-balance negative overdraft (C-5/F-10).** Breaks: strict-mode account goes negative with no warning after a conflict-retry. Blast radius: bounded (one account, visible negative), but it violates the mode's stated contract (`src/stores/transactionStore.ts:250-253`).
9. **Midnight–dawn date skew (T-1/T-5/F-11).** Breaks: recurring prompts don't fire, Home vs Subscriptions disagree, wrap/streaks misfile late-night entries. Blast radius: wide but shallow — wrong *information*, not wrong money; corrodes reminder trust in the Gulf-shift-worker demographic that is awake at those hours.
10. **Ballot re-run (D-3/F-13).** Breaks: kameti slots reshuffle after the draw was witnessed. Blast radius: one committee, but it detonates the "provably fair" differentiator; a WhatsApped payout slip and a re-drawn order are un-reconcilable socially.
11. **Mode switch with existing data (M-1/F-17).** Breaks: tracker surfaces meet null-account rows and loans with no funding legs; every "code path over transactions must tolerate rows with BOTH account ids null" (`tasks/lessons.md:26-27`) — an invariant enforced only by convention. Blast radius: unknown-unknowns across analytics, statements, budgets.
12. **Half-committed consolidated repayment with no lump marker (R-2/F-18).** Breaks: statement shows k unexplained part-payments. Blast radius: confusion + support load, no money loss.

---

## 9. Evidence-unavailable / further investigation

These cannot be determined from the repository and must be verified against live infrastructure:

1. **Which of the 40 `supabase-migration-*.sql` files are actually applied.** Migrations are applied manually in Supabase Studio; MEMORY records at least `cross-user-account-effects`, `connections-push-discovery`, and `contacts-merge-unarchive` as **pending user apply**. Every server-side guard cited here (settlement/link accept status gates `supabase-migration-cross-user-account-effects.sql:189,446`; committee payment uniqueness `supabase-migration-committees.sql:51`; join-code rate limit) is conditional on its migration being live. A drift audit (schema dump vs repo SQL) is the single highest-value verification task before launch.
2. **`apply_account_balance_delta` server semantics** — whether the RPC enforces any floor (negative-balance rejection) server-side, or only the compare-and-swap. Client evidence covers only the conflict path (`src/lib/supabaseDb.ts:78-98`).
3. **Group-invite reuse policy** — single-use vs multi-use until expiry, expiry duration, and whether a `linked_member_id` slot rejects a second claimant; all live in the `accept_group_invite` RPC body (repo SQL exists in `supabase-migration-fix-group-invite-join-rpc.sql` but the *applied* version is unverifiable).
4. **Realtime propagation latency** between devices — determines the practical width of every concurrency window in §4.6 (C-1, C-3, C-4).
5. **Real-device double-tap reproducibility** (D-1) — the window is frame-timing dependent; needs a low-end Android WebView, not code reading.
6. **Push delivery** (`supabase/functions/push-notify`) behavior on failure — Firebase setup recorded as pending in MEMORY; not exercisable from the repo.
7. **Behavior of Supabase auth email-confirmation configuration** — the `email_confirmed_at` hard-block (`src/App.tsx:417-428`) assumes a dashboard setting whose live state is unknown.
8. **B4/B5/B7/B8 of the July 2026 UX audit** (destructive import, goals losing money, AI advice corrupting data, raw Postgres error) — flagged unverified by Phase 1 (`docs/ux-audit-first-time-user-2026-07.md`); B5/B7 overlap this phase's validation findings and deserve a dedicated pass with a live login.
9. **Mode-switch reachability** — whether any shipped UI actually lets a user flip `full_tracker` ↔ `splits_only` post-onboarding (M-1 assumed reachable via settings; enumeration of `setMode` callers on a live build would settle its real-world exposure).

---

*Report generated 2026-09-02 as part of the Phase 12 QA review. All line numbers refer to the repo state at commit 2248327 ("Daily Wisdom into center screen").*
