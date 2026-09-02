-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P3 / L4 STEP 4: the LAST two money-moving branches.
--   `contribute_to_goal`  — goal_contribution (account → goals.saved_amount)
--   `pay_card_bill`       — the credit-card story, both halves:
--                             (a) a TRANSFER into a card that settles the
--                                 cash-advance loans that card funded, and
--                             (b) a REPAYMENT of a cash-advance loan that
--                                 credits the card back (the clamped leg step 2
--                                 deliberately left on the legacy path).
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- APPLY ORDER
--   AFTER  supabase-migration-prelaunch-hardening.sql        (#18 in docs/audit-2026-09/APPLY-ORDER.md)
--            ^ apply_account_balance_delta (the account CAS contract mirrored
--              here) and the accounts/transactions FKs.
--   AFTER  supabase-migration-audit-p0-loan-concurrency.sql
--            ^ apply_loan_remaining_delta: its clamp, its status derivation and
--              its LOAN_REMAINING_CONFLICT / LOAN_NOT_FOUND token vocabulary are
--              reproduced verbatim so the client's existing ladders keep working.
--   AFTER  supabase-migration-goal-target-date.sql
--            ^ goals.target_date (not written here, but Section 0 asserts the
--              table is the shape mapGoal reads back).
--   AFTER  supabase-migration-p1-money-bounds.sql
--            ^ the CHECK constraints this file's own validation mirrors
--              (transactions.amount >= 0 AND < 1e12; conversion_rate in
--               0.0001..100000; goals_saved_amount_bounded;
--               loans_remaining_not_over_total; the eight-currency whitelist).
--   AFTER  supabase-migration-p3-atomic-transfer.sql    (step 1)
--   AFTER  supabase-migration-p3-atomic-repayment.sql   (step 2)
--   AFTER  supabase-migration-p3-atomic-loan-create.sql (step 3)
--            ^ none is a hard dependency, but the four are ONE rollout and this
--              file copies their error contract, their lock order and their
--              idempotency model verbatim.
--   Also requires (all in the historical set, long applied):
--     supabase-schema.sql                      accounts, transactions, loans,
--                                              emi_schedules, goals
--     supabase-migration-phase1-persons.sql    transactions.person_id,
--                                              loans.person_id
--     supabase-migration-reconciliation.sql    is_reconciled/reconciled_at/by
--     supabase-migration-receipts.sql          transactions.receipt_path
--     supabase-migration-incremental-sync-core.sql        updated_at (+trigger)
--     supabase-migration-incremental-sync-tombstones.sql  deleted_at
--   Section 0 hard-checks every one of those columns and ABORTS with a named
--   message rather than creating functions that would fail at runtime.
--
--   SAFE AHEAD OF THE CLIENT. This file only ADDS two functions. Nothing calls
--   them until a build ships with VITE_ATOMIC_GOAL=true and/or
--   VITE_ATOMIC_CARD_BILL=true (src/stores/transactionStore.ts,
--   `ATOMIC_GOAL_ENABLED` / `ATOMIC_CARD_BILL_ENABLED`), both FALSE by default.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES — the evidence
-- ────────────────────────────────────────────────────────────────────────────
-- docs/audit-2026-09/07-mobile-first.md  MF-01 (high, borderline critical):
--   money left half-moved server-side on a flaky network; the compensation and
--   the refetch die in the same outage; the outbox that would repair it is
--   inert.  Fix (L): "move multi-leg money moves into single SECURITY DEFINER
--   RPCs so atomicity lives in Postgres."
-- docs/audit-2026-09/12-qa-review.md  O-1 / F-4 (high) and F-2 (the loan
--   corruption signature), 02-repository-architecture.md H-3 / H-4,
--   00-executive-summary.md M1 / L4.
-- These are branches #3 and #5 of the order table in
--   docs/server-side-money-engine.md §6 — the last two that move money.
--
--   goal_contribution (up to 4 legs)
--     1. apply_account_balance_delta(source, −srcDeduct, expected)   — commits
--     2. goals.saved_amount = <absolute figure>                      — TIMES OUT
--     3. apply_account_balance_delta(storedIn, +amount, expected)    — never runs
--     4. transactions INSERT                                         — never runs
--   Server truth: the wallet is lighter, the goal has not grown, and there is
--   no row saying anything happened. Worse than the transfer case, because
--   leg 2's client compensation is SNAPSHOT-based ("put savedAmount back to
--   what I read") — the one shape that CLOBBERS a concurrent contribution made
--   on another device (transactionStore.ts trackedAddContribution:1046-1059).
--
--   card bill payment (2 + 3N legs — the largest flow in the switch)
--     1. apply_account_balance_delta(source, −amount, expected)      — commits
--     2. apply_account_balance_delta(card,   +destAmt, expected)     — commits
--     3. transactions INSERT (the transfer)                          — the tail
--     then, PER cash-advance loan the card funded:
--     4. apply_loan_remaining_delta(loan, −applied, expected)        — TIMES OUT
--     5. emi_schedules status = 'paid' × M                           — never runs
--     6. transactions INSERT (the ledger repayment row)              — never runs
--   Server truth: the card bill is paid but the loans it financed still say the
--   money is owed — so the app asks the user to pay the SAME debt again. That is
--   the "Available-27,650-over-Limit-16,500" double-credit disaster
--   (src/lib/cardCredit.ts:1-9) reached from the other direction, and the
--   2026-07-18 "bulk repayment left no record" incident (tasks/lessons.md:6-13)
--   in its card form.
--
--   cash-advance repayment crediting the card (4 legs)
--     1. apply_account_balance_delta(source, −srcDeduct, expected)   — commits
--     2. apply_account_balance_delta(card,   +credited, expected)    — TIMES OUT
--     3. apply_loan_remaining_delta(loan, −amount, expected)         — never runs
--     4. emi marks + transactions INSERT                             — never runs
--   Server truth: money left the wallet, the card was not credited, the loan
--   still stands. This is the case step 2 EXPLICITLY deferred
--   (supabase-migration-p3-atomic-repayment.sql, artifact 13 / §8.1) because
--   `record_loan_repayment` takes exactly ONE account id.
--
-- The inverse of leg 1 has to travel the same dead connection that killed leg 2
-- (src/lib/mutationSafety.ts:10-13 says so in its own header), so no client
-- pattern closes this. A transaction boundary does.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHY TWO ROW TYPES IN ONE FUNCTION (a decision worth recording)
-- ════════════════════════════════════════════════════════════════════════════
-- The brief offered a third option: extend `record_loan_repayment` to carry the
-- card leg. It is not taken, for a reason that is structural rather than
-- stylistic: `record_loan_repayment` is step 2's shipped contract — a 13-argument
-- signature the client already binds by name, with its own migration file, its
-- own verification block and its own Docker suite. Widening it would change a
-- function that is already queued for production, and PostgREST resolves RPCs by
-- argument NAME set, so adding parameters creates a second overload rather than
-- replacing the first. The card leg therefore lands here.
--
-- And it lands in `pay_card_bill` rather than a function of its own because the
-- two card flows are ONE shape:
--     money leaves an account → some of it credits a CARD → cash-advance loan
--     records are knocked down by a client-computed plan → instalments flip →
--     rows are written.
-- `p_row_type` is the only thing that differs:
--     'transfer'   the main row is the bill payment; each plan entry ALSO writes
--                  its own ledger-only 'repayment' row (both account ids NULL),
--                  exactly as the legacy tail does.
--     'repayment'  the main row IS the repayment (source = wallet,
--                  destination = card); the single plan entry writes no extra
--                  row (its `row_id` is NULL).
-- One function, one lock order, one error contract, one flag. Splitting them
-- would have duplicated ~300 lines of validation to express one branch.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE ARTIFACT CONTRACT — `contribute_to_goal`
-- Traced from src/stores/transactionStore.ts `case 'goal_contribution'`
-- (:2094-2160), trackedAddContribution (:1046-1059), goalStore.addContribution
-- (:75-84), trackedBalanceDelta (:325-329) and the shared tail (:2346-2385).
-- ════════════════════════════════════════════════════════════════════════════
--
--  # | Artifact                    | Today (client, 2-4 remote round-trips)                              | This RPC (1 transaction)
-- ---+-----------------------------+---------------------------------------------------------------------+--------------------------------------------
--  1 | accounts.balance (SOURCE)   | trackedBalanceDelta(sourceAccountId, −srcDeduct) via                 | UPDATE accounts SET balance = balance − delta
--    |                             | apply_account_balance_delta (CAS, own round-trip).                   | after FOR UPDATE + expected-balance compare.
--    |                             | srcDeduct = amount            (same currency)                        | SKIPPED ENTIRELY for the self-stored case,
--    |                             |           = round(amount / rate, 2)  (cross-currency)                | exactly as the client skips it.
--    |                             | NOT APPLIED AT ALL when the goal is stored IN the source account.    |
--  2 | goals.saved_amount          | trackedAddContribution → goalStore.addContribution: reads the LOCAL  | UPDATE goals SET saved_amount =
--    |                             | snapshot and writes the ABSOLUTE figure                              |   GREATEST(0, round(saved_amount + amount, 2))
--    |                             | Math.max(0, round2(savedAmount + amount)). No lock, no CAS —         | after FOR UPDATE + a compare-and-swap on
--    |                             | the loan lost-update bug (audit F-2) in its goal form.               | p_expected_saved_amount. SAME clamp, same 2dp.
--  3 | accounts.balance (STORED-IN)| trackedBalanceDelta(goal.storedInAccountId, +amount) — ONLY when the | Second UPDATE, SAME transaction. Both account
--    |                             | goal names a DIFFERENT account AND that account is present in the    | rows locked in ONE ascending-id statement.
--    |                             | local store. THIRD round-trip.                                       | Derived from goals.stored_in_account_id.
--  4 | transactions row            | trackedAddTransaction → transactionsDb.add (UPSERT), after the switch| INSERT … same 20 columns, same values, same tx
--  5 | Dexie mirrors + Zustand     | mirrorPut(accounts/transactions) + set() in three stores             | client-side, post-commit (unchanged)
--  6 | activity 'transaction_created'| logActivitySafe(description) AFTER runSafeMutation commits         | client-side, post-commit (unchanged)
--  7 | reminder reschedule         | nudgeReminderSchedule() — fire-and-forget, native only               | client-side, post-commit (unchanged)
--
-- THE SELF-STORED CASE, reproduced exactly (transactionStore.ts:2105-2113):
--   contributing FROM the account the goal is stored in moves NO money — the
--   cash physically stays where it is. The client writes ONLY saved_amount and
--   the row, stamps { goalSelfStored: '1' } into the row's internal note so the
--   delete path skips the refund symmetrically, and — this is the subtle part —
--   `break`s BEFORE the currency branch, so a self-stored contribution is
--   CURRENCY-BLIND: no rate is required, none is written, and the row's
--   currency is the GOAL's. The RPC reproduces all three properties, including
--   refusing a conversion rate on a self-stored payload.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE ARTIFACT CONTRACT — `pay_card_bill`, p_row_type = 'transfer'
-- Traced from src/stores/transactionStore.ts `case 'transfer'` (:1593-1762),
-- its credit-card tail (:1677-1760), trackedApplyRepayment (:513-563),
-- trackedMarkCoveredEmisPaid (:1103-1149), src/lib/cardStatement.ts
-- allocateBillPayment (:200-239) and src/lib/emiCoverage.ts.
-- ════════════════════════════════════════════════════════════════════════════
--
--  # | Artifact                    | Today (client)                                                       | This RPC
-- ---+-----------------------------+----------------------------------------------------------------------+------------------------------------------
--  1 | accounts.balance (SOURCE)   | trackedBalanceDelta(source, −amount)                                 | UPDATE, same tx, after CAS
--  2 | accounts.balance (CARD)     | trackedBalanceDelta(card, +destAmount) where destAmount =            | UPDATE, same tx, after CAS. Both account
--    |                             | round(amount × rate, 2) cross-currency, else amount.                 | rows in ONE ascending-id lock statement.
--    |                             | DELIBERATELY UNCLAMPED — a direct transfer is recorded as typed      | The headroom clamp is applied ONLY to the
--    |                             | (src/lib/cardCredit.ts:7-9).                                         | 'repayment' row type. Same rule, same file.
--  3 | transactions row ('transfer')| trackedAddTransaction, after the switch                             | INSERT, same 20 columns, same tx
--  4 | loans.remaining_amount ×N   | trackedApplyRepayment(loan, applied) per plan line, via              | UPDATE per line, same tx, each after its own
--    | + loans.status              | apply_loan_remaining_delta (CAS, one round-trip EACH)                | compare-and-swap. Clamp at 0 + status
--    |                             | The PLAN comes from allocateBillPayment (statement-native) or the    | derived in the SAME statement — byte-for-byte
--    |                             | legacy greedy fallback when the card has no limit/statement day.     | apply_loan_remaining_delta.
--  5 | emi_schedules status ×M     | trackedMarkCoveredEmisPaid(loanId) per line: uncoveredToPaidIds      | UPDATE … SET status='paid' from a
--    |                             | over (totalAmount − remainingAmount) AFTER the loan moved            | client-computed id list the server
--    |                             |                                                                      | RE-VALIDATES (ownership + loan membership).
--  6 | transactions rows ×N        | one ledger-only 'repayment' row per line: BOTH account ids NULL,     | INSERT per line, same tx, from the plan's
--    | (the ledger repayments)     | notes = buildInternalNote('Covered by card bill payment',            | `row_id` / `row_note`. The NOTE is built
--    |                             | { linkedTransactionId }) — the link EditTransactionModal reads       | CLIENT-SIDE and passed verbatim, so the
--    |                             | to refuse an edit (:2413-2423).                                      | encoding can never fork.
--  7 | Dexie mirrors + Zustand     | mirrorPut ×(2 + N) + set() in four stores                            | client-side, post-commit (unchanged)
--  8 | activity 'loan_settled' ×   | inside trackedApplyRepayment, best-effort                            | client-side, post-commit, best-effort
--  9 | activity 'emi_paid' ×       | inside trackedMarkCoveredEmisPaid, best-effort                       | client-side, post-commit, best-effort
-- 10 | activity 'transaction_created'| logActivitySafe(description + " · settled N cash-advance records") | client-side, post-commit (unchanged)
-- 11 | reminder reschedule         | nudgeReminderSchedule()                                              | client-side, post-commit (unchanged)
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE ARTIFACT CONTRACT — `pay_card_bill`, p_row_type = 'repayment'
-- Traced from `case 'repayment'` (:1923-2092), specifically the branch
-- `cashAdvanceCard && cardCredit.credited > 0` (:2003-2006 and :2020-2023),
-- src/lib/cardCredit.ts clampCardCredit (:44-51) and cardCreditedAmountOf
-- (:1378-1382).
-- ════════════════════════════════════════════════════════════════════════════
--
--  # | Artifact                    | Today (client)                                                       | This RPC
-- ---+-----------------------------+----------------------------------------------------------------------+------------------------------------------
--  1 | accounts.balance (SOURCE)   | trackedBalanceDelta(source, −srcDeduct)                              | UPDATE, same tx, after CAS
--  2 | accounts.balance (CARD)     | trackedBalanceDelta(card, +clampCardCredit(card, amount).credited)   | UPDATE, same tx, after CAS — and the
--    |                             | Clamped to the card's remaining headroom so a bill already paid by a | client's clamped figure is RE-VALIDATED
--    |                             | transfer cannot be credited back a second time.                      | against the card's own headroom.
--  3 | loans.remaining_amount + status | trackedApplyRepayment(loanId, amount)                             | UPDATE, same tx, after its CAS
--  4 | emi_schedules status ×M     | trackedMarkEmiPaid(emiId)? + trackedMarkCoveredEmisPaid(loanId)      | UPDATE from the re-validated id list
--  5 | transactions row ('repayment')| trackedAddTransaction: source = wallet, destination = CARD,        | INSERT, same 20 columns, same tx. The
--    |                             | notes = buildInternalNote(notes, { cardCreditedAmount }) when the    | note is built client-side and passed
--    |                             | clamp bit partially — deletion reverses exactly that figure.         | verbatim.
--  6-9| mirrors / activity / reminder | as above                                                          | client-side, post-commit (unchanged)
--
-- Artifacts 5-11 / 6-9 stay client-side by design: local caches and a
-- best-effort audit trail. The repo's rule is that an activity-log failure must
-- NEVER roll back money that has moved (transactionStore.ts logActivitySafe).
--
-- ════════════════════════════════════════════════════════════════════════════
-- BOTH APP MODES TRACED (tasks/lessons.md:6-13, :26-27)
-- ════════════════════════════════════════════════════════════════════════════
-- goal_contribution
--   full_tracker — the only mode that reaches it.
--   splits_only  — UNREACHABLE, confirmed not assumed, on THREE independent
--                  gates: src/App.tsx:950-958 sends /goals to a <Navigate> in
--                  splits_only ("Savings goals stay full-tracker only");
--                  QuickEntry's INTENTS list (:326-328) keeps only
--                  person_money + group_expense in splits_only, so the
--                  goal_contribution tile is never rendered; and the branch's
--                  own first guard is `if (!src) throw` with `needsSource`
--                  including 'goal_contribution' (:408). 'goal_contribution' is
--                  ALSO absent from isSimpleModeBalanceBypassAllowed (:253-261)
--                  — it uses the strict `checkBalance`, never the bypassing
--                  `checkBalanceForTransaction` — so there is no ledger
--                  negative-balance subtlety to reproduce here, unlike steps 2
--                  and 3. p_allow_negative exists only for the future repair
--                  queue and the client ALWAYS sends false.
--                  The RPC keeps the property: a NULL/empty/unknown/foreign/
--                  soft-deleted source account raises ACCOUNT_NOT_FOUND rather
--                  than writing a row with both account ids null.
--
-- pay_card_bill (both row types)
--   full_tracker — the only mode that reaches it. A credit card IS an account,
--                  and splits_only has none: QuickEntry hides the 'transfer'
--                  intent entirely in splits_only (:326-328), and
--                  RepaymentModal's cash-advance card lookup starts from a
--                  loan_taken row carrying a sourceAccountId, which ledger mode
--                  never writes (loanStore.createLoan writes no transactions
--                  row at all — see step 3's §13.5).
--   splits_only  — a ledger repayment goes through loanStore.applyRepayment and
--                  writes a row with BOTH account ids null. Not one line of it
--                  changes, it never calls this RPC, and the RPC REFUSES a
--                  null/empty source or card with ACCOUNT_NOT_FOUND so such a
--                  row can never be routed through it.
--                  One subtlety reproduced faithfully: 'repayment' IS in
--                  isSimpleModeBalanceBypassAllowed, so a user who switched
--                  full_tracker → splits_only and still has accounts may
--                  legitimately push one negative. The client passes
--                  p_allow_negative = true in exactly that case and only that
--                  case, and only for p_row_type='repayment'. The 'transfer'
--                  row type always passes false, because the transfer branch
--                  uses the strict `checkBalance` too.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ERROR CONTRACT — only tokens the client ALREADY parses, plus ONE
-- ════════════════════════════════════════════════════════════════════════════
--   BALANCE_CONFLICT        bare token, byte-identical to
--                           apply_account_balance_delta
--                           (prelaunch-hardening.sql:270), to
--                           transfer_between_accounts, to record_loan_repayment
--                           and to create_loan_with_leg. DETAIL carries
--                           {account_id, account_balance, expected_account_balance}
--                           — or, for the GOAL compare-and-swap,
--                           {goal_id, goal_saved_amount, expected_saved_amount}.
--
--                           REUSING IT FOR THE GOAL CAS IS DELIBERATE. The
--                           template's rule 4 (docs/server-side-money-engine.md
--                           §6) is "reuse the tokens the client already parses;
--                           a new token means new client-side branching, which
--                           means new bugs." A GOAL_SAVED_CONFLICT would have
--                           been a fifth token with a fourth ladder. The client
--                           already refetches ACCOUNTS on BALANCE_CONFLICT; the
--                           goal branch's ladder refetches accounts AND goals
--                           and retries once, which is correct for either
--                           source of the conflict. Unlike a loan repayment,
--                           the goal write is a pure `+amount` DELTA, so a
--                           replay against a fresh expectation is always
--                           correct — no requireRemainingAtLeast floor is
--                           needed or wanted.
--   LOAN_REMAINING_CONFLICT byte-identical to apply_loan_remaining_delta;
--                           DETAIL carries {loan_id, loan_remaining} so the
--                           client can re-plan without a second fetch.
--   LOAN_NOT_FOUND          same token and meaning as the loan CAS → the client
--                           turns it into tStatic('err_loan_gone'), never
--                           retried.
--   INSUFFICIENT_BALANCE    the server half of checkBalance /
--                           checkBalanceForTransaction. DETAIL carries
--                           {account_id, account_name, account_type, currency,
--                            available, requested} so the wrapper rebuilds the
--                           identical bilingual tStatic('err_insufficient').
--   GOAL_NOT_FOUND          THE ONE NEW TOKEN. There was no goal equivalent of
--                           err_loan_gone because nothing server-side had ever
--                           refused a goal. It is modelled exactly on
--                           LOAN_NOT_FOUND: never retried, mapped to a single
--                           new bilingual string (i18n `err_goal_gone`).
--
-- Everything else is a poisoned payload or a programming error, unreachable
-- from the shipped client, and exists because ONE curl against PostgREST
-- bypasses every client guard: NOT_AUTHENTICATED, INVALID_TRANSACTION_ID,
-- INVALID_GOAL_ID, INVALID_AMOUNT, INVALID_ROW_TYPE, ACCOUNT_NOT_FOUND,
-- SAME_ACCOUNT, NOT_A_CREDIT_CARD, EXPECTED_BALANCE_REQUIRED,
-- EXPECTED_SAVED_REQUIRED, CONVERSION_RATE_REQUIRED, INVALID_CONVERSION_RATE,
-- CONVERSION_RATE_NOT_APPLICABLE, SOURCE_AMOUNT_MISMATCH,
-- CARD_AMOUNT_MISMATCH, CARD_CREDIT_OVER_LIMIT, CURRENCY_MISMATCH,
-- PLAN_INVALID, PLAN_OVER_PAYMENT, EMI_SCHEDULE_INVALID,
-- TRANSACTION_ID_COLLISION.
--
-- ════════════════════════════════════════════════════════════════════════════
-- LOCKING
-- ════════════════════════════════════════════════════════════════════════════
-- Repo-wide rule (supabase-migration-audit-p0-settlement-row-locks.sql:73-100):
--   loans → accounts → emi_schedules, and WITHIN a table rows in ascending
--   `id` order. This file EXTENDS the chain by one table, at the END:
--
--       loans → accounts → emi_schedules → goals
--
--   `goals` goes last because it is a leaf: no other function in the whole
--   corpus takes a lock on it (grepped — goals is touched only by goalsDb's
--   plain PostgREST writes), so nothing can hold a goals lock while waiting for
--   an accounts lock, and no cycle is constructible.
--
--   contribute_to_goal:  accounts (source + stored-in, ONE statement,
--                        ORDER BY id) → goals (FOR UPDATE).
--   pay_card_bill:       loans (every plan loan id, ONE statement, ORDER BY id)
--                        → accounts (source + card, ONE statement, ORDER BY id)
--                        → emi_schedules (the plan's instalments, ORDER BY id).
--
-- Neither can invert order against accept_linked_request /
-- accept_settlement_request (loans → accounts), apply_loan_remaining_delta
-- (loans only), apply_account_balance_delta / transfer_between_accounts
-- (accounts only), record_loan_repayment or create_loan_with_leg
-- (loans → accounts → emi_schedules).
--
-- ════════════════════════════════════════════════════════════════════════════
-- IDEMPOTENCY
-- ════════════════════════════════════════════════════════════════════════════
-- The failure these functions kill is "the call committed but the reply never
-- arrived". The transaction id is generated client-side (uuid v4) and is the
-- primary key of `transactions`, so it is the natural idempotency key. After
-- taking the row locks — so two in-flight copies of the same retry serialise
-- rather than race — a pre-existing row with that id short-circuits to
-- {status:'ok', replay:true} carrying the CURRENT figures, and moves nothing.
-- pay_card_bill's per-line `row_id`s are a SECOND guard: a ledger row id that
-- already exists raises TRANSACTION_ID_COLLISION rather than upserting over a
-- live record (which is what transactionsDb.add's UPSERT would do).
--
-- ════════════════════════════════════════════════════════════════════════════
-- FOUR CORRECTIONS WORTH RECORDING (things a reader would otherwise assume)
-- ════════════════════════════════════════════════════════════════════════════
-- 1. THE ALLOCATION ENGINE IS NOT PORTED, AND MUST NOT BE.
--    `allocateBillPayment` and `clampCardCredit` (src/lib/cardStatement.ts,
--    src/lib/cardCredit.ts) are real, tested business logic with 30+ unit tests
--    behind them. Re-implementing the statement-native allocation in plpgsql
--    would fork the source of truth — the failure mode CLAUDE.md's "search for
--    existing infrastructure before designing new" rule exists to prevent. So:
--    THE CLIENT PLANS, THE SERVER APPLIES, and the server re-validates every
--    number it is handed (Σ applied ≤ the card credit; each `applied` ≤ its
--    loan's remaining after the CAS clamp; each instalment id owned by that
--    loan; each card credit ≤ the card's own headroom). A lying plan is refused,
--    not trusted — but the RULE that produced it stays in TypeScript.
--
-- 2. `goals` HAS NO `deleted_at` AND NO `updated_at`. It is
--    (id, user_id, title, target_amount, saved_amount, currency,
--     stored_in_account_id, created_at) plus target_date
--    (supabase-migration-goal-target-date.sql) — and nothing else; the
--    incremental-sync migrations added updated_at/deleted_at to accounts,
--    transactions and loans, NOT here. A `deleted_at IS NULL` predicate on
--    goals would silently match nothing on a database that has one and error on
--    one that does not, and a saved_amount write that also touched updated_at
--    would write a column mapGoal (supabaseDb.ts:2212-2221) cannot read back —
--    the same shape of mistake as step 2's invented `paid_at` and step 3's
--    invented `loans.due_date`. Goal lookups here are therefore
--    `WHERE id = … AND user_id = v_uid`, with no soft-delete predicate.
--
-- 3. THE GOAL'S STORED-IN ACCOUNT IS A LABEL, NOT A FOREIGN KEY.
--    `goals.stored_in_account_id` is `TEXT DEFAULT ''` with no FK
--    (supabase-schema.sql:138), and the client's credit leg is guarded by
--    `if (linkedAccount)` — a lookup in the LOCAL store (:2127-2131, :2147-2151).
--    So "the goal names an account that no longer exists" is a legitimate,
--    reachable state, and it must contribute WITHOUT a credit leg rather than
--    fail. The RPC reproduces that exactly: it looks the account up, and a miss
--    means "no linked leg", not an error. The client sends the id it decided on
--    and the server returns the one it used, so a disagreement is visible
--    (reported as `linkedFork`, never thrown — the money has already committed
--    correctly by the server's own reckoning).
--
-- 4. THE THREE CROSS-CURRENCY CONVENTIONS ARE ALL DIFFERENT, AND ALL LIVE HERE.
--       goal_contribution      srcDeduct = round(amount ÷ rate, 2)   (:2118)
--       transfer → card        cardCredit = round(amount × rate, 2)  (:1621)
--       repayment of a taken   srcDeduct = round(amount ÷ rate, 2)   (:1995)
--       loan
--    A single "multiply" implementation would mis-convert two of the three by a
--    factor of rate². The server derives which convention applies from the flow
--    (p_row_type, and self-stored vs not) and cross-checks the client's own
--    figure within 0.01 (SOURCE_AMOUNT_MISMATCH / CARD_AMOUNT_MISMATCH) rather
--    than recomputing it and silently disagreeing.
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 0. Preconditions — fail with a name, never with a runtime surprise
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing TEXT[] := ARRAY[]::TEXT[];
  v_pairs   TEXT[][] := ARRAY[
    ARRAY['accounts','id'], ARRAY['accounts','user_id'], ARRAY['accounts','name'],
    ARRAY['accounts','type'], ARRAY['accounts','currency'], ARRAY['accounts','balance'],
    ARRAY['accounts','metadata'], ARRAY['accounts','deleted_at'],
    ARRAY['goals','id'], ARRAY['goals','user_id'], ARRAY['goals','title'],
    ARRAY['goals','target_amount'], ARRAY['goals','saved_amount'],
    ARRAY['goals','currency'], ARRAY['goals','stored_in_account_id'],
    ARRAY['loans','id'], ARRAY['loans','user_id'], ARRAY['loans','person_name'],
    ARRAY['loans','person_id'], ARRAY['loans','type'], ARRAY['loans','total_amount'],
    ARRAY['loans','remaining_amount'], ARRAY['loans','currency'], ARRAY['loans','status'],
    ARRAY['loans','deleted_at'],
    ARRAY['emi_schedules','id'], ARRAY['emi_schedules','user_id'],
    ARRAY['emi_schedules','loan_id'], ARRAY['emi_schedules','status'],
    ARRAY['transactions','id'], ARRAY['transactions','user_id'], ARRAY['transactions','type'],
    ARRAY['transactions','amount'], ARRAY['transactions','currency'],
    ARRAY['transactions','source_account_id'], ARRAY['transactions','destination_account_id'],
    ARRAY['transactions','related_person'], ARRAY['transactions','person_id'],
    ARRAY['transactions','related_loan_id'], ARRAY['transactions','related_goal_id'],
    ARRAY['transactions','conversion_rate'], ARRAY['transactions','category'],
    ARRAY['transactions','notes'], ARRAY['transactions','created_at'],
    ARRAY['transactions','is_reconciled'], ARRAY['transactions','reconciled_at'],
    ARRAY['transactions','reconciled_by'], ARRAY['transactions','receipt_path'],
    ARRAY['transactions','deleted_at']
  ];
  i INTEGER;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name  = v_pairs[i][1]
         AND column_name = v_pairs[i][2]
    ) THEN
      v_missing := v_missing || (v_pairs[i][1] || '.' || v_pairs[i][2]);
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: p3-atomic-goal-and-card needs column(s) % — apply the migrations listed in this file''s APPLY ORDER header first, then re-run.',
      array_to_string(v_missing, ', ');
  END IF;

  -- CORRECTION 2: assert the ABSENCE we rely on, so a future migration that
  -- adds goals.deleted_at makes this file fail loudly instead of silently
  -- letting a soft-deleted goal be contributed to.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'goals' AND column_name = 'deleted_at'
  ) THEN
    RAISE WARNING 'p3-atomic-goal-and-card: goals.deleted_at now EXISTS. contribute_to_goal does not filter on it (it did not exist when this file was written) — a soft-deleted goal can still be contributed to. Add the predicate.';
  END IF;

  IF to_regprocedure('public.apply_account_balance_delta(text,numeric,numeric)') IS NULL THEN
    RAISE WARNING 'p3-atomic-goal-and-card: apply_account_balance_delta is ABSENT — supabase-migration-prelaunch-hardening.sql has not been applied. These functions still install (they reimplement the same compare-and-swap inline), but the legacy client paths they replace are still running unlocked balance writes.';
  END IF;
END;
$$;

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. contribute_to_goal — the whole contribution, one transaction
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.contribute_to_goal(
  p_transaction_id          TEXT,
  p_goal_id                 TEXT,
  p_source_account_id       TEXT,
  p_amount                  NUMERIC,   -- GOAL currency; the row's amount
  p_source_amount           NUMERIC,   -- SOURCE currency; what the wallet loses
  p_conversion_rate         NUMERIC,   -- NULL for same-currency AND self-stored
  p_note                    TEXT,
  p_category                TEXT,
  p_date                    TIMESTAMPTZ,
  p_linked_account_id       TEXT,      -- the client's own decision; cross-checked
  p_expected_source_balance NUMERIC,
  p_expected_linked_balance NUMERIC,
  p_expected_saved_amount   NUMERIC,
  p_allow_negative          BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER   -- RLS is not consulted; the user_id = v_uid predicates below
                   -- ARE the access control (apply_loan_remaining_delta precedent).
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_src           public.accounts%ROWTYPE;
  v_linked        public.accounts%ROWTYPE;
  v_goal          public.goals%ROWTYPE;
  v_existing      public.transactions%ROWTYPE;
  v_self_stored   BOOLEAN := false;
  v_amount        NUMERIC;
  v_src_amount    NUMERIC;
  v_linked_id     TEXT := NULL;
  v_new_src       NUMERIC;
  v_new_linked    NUMERIC := NULL;
  v_new_saved     NUMERIC;
  v_created_at    TIMESTAMPTZ;
  v_stored_in     TEXT;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────────────
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- ── Shape validation (mirrors assertInputAmountsInBounds + the branch's own
  --    first guards, so a curl cannot post what the UI cannot) ─────────────
  IF p_transaction_id IS NULL OR length(trim(p_transaction_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_goal_id IS NULL OR length(trim(p_goal_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_GOAL_ID' USING ERRCODE = 'P0001',
      DETAIL = 'every goal_contribution row points at a goal';
  END IF;

  -- A ledger-only (splits_only) user can never reach this branch (see BOTH APP
  -- MODES above). Refusing loudly is what keeps a row with both account ids
  -- null from ever being written here (tasks/lessons.md:26-27).
  IF p_source_account_id IS NULL OR length(trim(p_source_account_id)) = 0 THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'a goal contribution requires a source account; splits_only mode has no goals at all';
  END IF;

  -- Strictly positive, finite, below the shared 1e12 ceiling — the same rule as
  -- src/lib/currencyValidation.ts checkMoneyAmount and p1-money-bounds.
  -- NUMERIC 'NaN' is a real value in Postgres, so it is rejected explicitly.
  IF p_amount IS NULL OR p_amount = 'NaN'::NUMERIC OR p_amount <= 0 OR p_amount >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001',
      DETAIL = 'amount must be greater than 0 and less than 1e12';
  END IF;

  IF p_expected_saved_amount IS NULL THEN
    -- Refusing to guess is the point: without an expectation there is no
    -- compare-and-swap, and this RPC would become the blind absolute write the
    -- client does today.
    RAISE EXCEPTION 'EXPECTED_SAVED_REQUIRED' USING ERRCODE = 'P0001',
      DETAIL = 'the goal has no expected saved_amount';
  END IF;

  v_amount := round(p_amount, 2);

  -- ══ LOCK ORDER: accounts → goals (see the LOCKING header) ═══════════════
  -- (1) BOTH candidate account rows, in ONE statement, ascending id. The linked
  --     id is only a candidate at this point — it may not exist (CORRECTION 3)
  --     — but locking a row that turns out to be absent is a no-op, and taking
  --     the lock before the lookup is what keeps the order deterministic.
  PERFORM 1 FROM public.accounts
   WHERE id = ANY(
           ARRAY[p_source_account_id]
           || CASE WHEN p_linked_account_id IS NOT NULL
                        AND length(trim(p_linked_account_id)) > 0
                        AND p_linked_account_id <> p_source_account_id
                   THEN ARRAY[p_linked_account_id] ELSE ARRAY[]::TEXT[] END)
     AND user_id = v_uid
   ORDER BY id
     FOR UPDATE;

  -- (2) the goal row.
  PERFORM 1 FROM public.goals
   WHERE id = p_goal_id AND user_id = v_uid
     FOR UPDATE;

  -- ── Idempotent replay ───────────────────────────────────────────────────
  -- Taken AFTER the locks so two copies of the same retry serialise: the
  -- second one sees the first one's committed row instead of racing it.
  SELECT * INTO v_existing
    FROM public.transactions
   WHERE id = p_transaction_id
     AND user_id = v_uid;

  IF FOUND THEN
    IF v_existing.type <> 'goal_contribution' THEN
      RAISE EXCEPTION 'TRANSACTION_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'that id already belongs to a ' || v_existing.type || ' entry';
    END IF;

    SELECT balance INTO v_new_src FROM public.accounts
     WHERE id = p_source_account_id AND user_id = v_uid;
    SELECT saved_amount INTO v_new_saved FROM public.goals
     WHERE id = p_goal_id AND user_id = v_uid;
    IF v_existing.destination_account_id IS NOT NULL THEN
      SELECT balance INTO v_new_linked FROM public.accounts
       WHERE id = v_existing.destination_account_id AND user_id = v_uid;
    END IF;

    RETURN jsonb_build_object(
      'status',            'ok',
      'replay',            true,
      'transaction_id',    v_existing.id,
      'goal_id',           v_existing.related_goal_id,
      'goal_saved_amount', v_new_saved,
      'goal_applied',      0,
      'source_balance',    v_new_src,
      'source_delta',      0,
      'linked_account_id', v_existing.destination_account_id,
      'linked_balance',    v_new_linked,
      'linked_delta',      0,
      'currency',          v_existing.currency,
      'self_stored',       (v_existing.destination_account_id IS NULL),
      'created_at',        v_existing.created_at,
      'row_deleted',       (v_existing.deleted_at IS NOT NULL)
    );
  END IF;

  -- ── Load the source account (lock already held) ─────────────────────────
  SELECT * INTO v_src FROM public.accounts
   WHERE id = p_source_account_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'source account is unknown, deleted, or not yours';
  END IF;

  -- ── Load the goal (CORRECTION 2: no deleted_at on this table) ───────────
  SELECT * INTO v_goal FROM public.goals
   WHERE id = p_goal_id AND user_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GOAL_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'goal is unknown or not yours';
  END IF;

  v_stored_in  := NULLIF(trim(COALESCE(v_goal.stored_in_account_id, '')), '');
  -- transactionStore.ts:2105 — `goal.storedInAccountId === input.sourceAccountId`
  v_self_stored := (v_stored_in IS NOT NULL AND v_stored_in = v_src.id);

  IF v_self_stored THEN
    -- The self-stored branch `break`s before the currency check, so it is
    -- CURRENCY-BLIND and never writes a rate. A rate on this payload means the
    -- client and the server disagree about which branch this is.
    IF p_conversion_rate IS NOT NULL THEN
      RAISE EXCEPTION 'CONVERSION_RATE_NOT_APPLICABLE' USING ERRCODE = 'P0001',
        DETAIL = 'a contribution kept in the account the goal is stored in moves no money and converts nothing';
    END IF;
    v_src_amount := 0;
    v_linked_id  := NULL;
  ELSE
    -- ── The linked credit leg. Derived from the GOAL, not from the caller —
    --    p_linked_account_id is a cross-check only. CORRECTION 3: a stored-in
    --    account that no longer exists means "no leg", not an error.
    IF v_stored_in IS NOT NULL AND v_stored_in <> v_src.id THEN
      SELECT * INTO v_linked FROM public.accounts
       WHERE id = v_stored_in AND user_id = v_uid AND deleted_at IS NULL;
      IF FOUND THEN
        v_linked_id := v_linked.id;
      END IF;
    END IF;

    -- p_linked_account_id is NOT authoritative and is deliberately not
    -- enforced: the server's own derivation wins, and it is returned as
    -- `linked_account_id` so the client can compare and REPORT a disagreement
    -- (a stale local account list must not turn into a failed contribution).

    -- ── The cross-currency convention: DIVIDE (transactionStore.ts:2118).
    IF v_src.currency <> v_goal.currency THEN
      IF p_conversion_rate IS NULL THEN
        RAISE EXCEPTION 'CONVERSION_RATE_REQUIRED' USING ERRCODE = 'P0001',
          DETAIL = 'the source account and the goal are in different currencies';
      END IF;
      -- Mirrors src/lib/conversionMath.ts RATE_MIN/RATE_MAX and the
      -- transactions_conversion_rate_bounded CHECK, so a rate the client would
      -- reject cannot be posted around it.
      IF p_conversion_rate = 'NaN'::NUMERIC
         OR p_conversion_rate < 0.0001 OR p_conversion_rate > 100000 THEN
        RAISE EXCEPTION 'INVALID_CONVERSION_RATE' USING ERRCODE = 'P0001',
          DETAIL = 'rate must be between 0.0001 and 100000';
      END IF;
      v_src_amount := round(v_amount / p_conversion_rate, 2);
    ELSE
      IF p_conversion_rate IS NOT NULL THEN
        RAISE EXCEPTION 'CONVERSION_RATE_NOT_APPLICABLE' USING ERRCODE = 'P0001',
          DETAIL = 'the source account and the goal share a currency';
      END IF;
      v_src_amount := v_amount;
    END IF;

    -- The client computed the same figure; if the two disagree, one of them is
    -- wrong and no money should move on either's word.
    IF p_source_amount IS NULL
       OR p_source_amount = 'NaN'::NUMERIC
       OR abs(round(p_source_amount, 2) - v_src_amount) > 0.01 THEN
      RAISE EXCEPTION 'SOURCE_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
        DETAIL = 'client said ' || COALESCE(p_source_amount::TEXT, '<null>')
                 || ', the server derives ' || v_src_amount::TEXT;
    END IF;

    IF p_expected_source_balance IS NULL THEN
      RAISE EXCEPTION 'EXPECTED_BALANCE_REQUIRED' USING ERRCODE = 'P0001',
        DETAIL = 'the source account has no expected balance';
    END IF;
    IF v_linked_id IS NOT NULL AND p_expected_linked_balance IS NULL THEN
      RAISE EXCEPTION 'EXPECTED_BALANCE_REQUIRED' USING ERRCODE = 'P0001',
        DETAIL = 'the goal''s stored-in account has no expected balance';
    END IF;
  END IF;

  -- ── Optimistic lock: the source account (only when it actually moves).
  --    A self-stored contribution writes no balance today and takes no CAS
  --    today; adding one would fail contributions that currently succeed.
  IF NOT v_self_stored
     AND round(v_src.balance, 2) <> round(p_expected_source_balance, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',               v_src.id,
        'account_balance',          v_src.balance,
        'expected_account_balance', p_expected_source_balance
      )::TEXT;
  END IF;

  -- ── Optimistic lock: the goal's stored-in account.
  IF v_linked_id IS NOT NULL
     AND round(v_linked.balance, 2) <> round(p_expected_linked_balance, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',               v_linked.id,
        'account_balance',          v_linked.balance,
        'expected_account_balance', p_expected_linked_balance
      )::TEXT;
  END IF;

  -- ── Optimistic lock: goals.saved_amount. THE FIRST ONE THAT HAS EVER
  --    EXISTED — goalStore.addContribution reads the local snapshot and writes
  --    an absolute figure, so two devices contributing to the same goal both
  --    read S and both write S+x, losing one contribution entirely. Same token
  --    as the account CAS (see the ERROR CONTRACT header for why).
  IF round(v_goal.saved_amount, 2) <> round(p_expected_saved_amount, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'goal_id',               v_goal.id,
        'goal_saved_amount',     v_goal.saved_amount,
        'expected_saved_amount', p_expected_saved_amount
      )::TEXT;
  END IF;

  -- ── Insufficient-balance guard ──────────────────────────────────────────
  -- The server half of the branch's `checkBalance(src, srcDeduct)` — note it is
  -- the STRICT checkBalance, not checkBalanceForTransaction: 'goal_contribution'
  -- is absent from isSimpleModeBalanceBypassAllowed, so there is no ledger
  -- bypass to reproduce. p_allow_negative exists for the future repair queue and
  -- the client always sends false.
  IF NOT v_self_stored
     AND NOT COALESCE(p_allow_negative, false)
     AND v_src.balance < v_src_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',   v_src.id,
        'account_name', v_src.name,
        'account_type', v_src.type,
        'currency',     v_src.currency,
        'available',    v_src.balance,
        'requested',    v_src_amount
      )::TEXT;
  END IF;

  -- ══ THE WRITES. Everything above refused without touching a row. ════════
  -- Arithmetic is done IN the UPDATE (never from a plpgsql snapshot) — the
  -- L-4 lesson from supabase-migration-audit-p0-settlement-row-locks.sql.

  -- 1. The goal. Byte-for-byte goalStore.addContribution's expression
  --    Math.max(0, Math.round((savedAmount + amount) * 100) / 100): the SUM is
  --    rounded, not the addend, and the clamp is at zero. (The clamp cannot bite
  --    for a positive contribution; it is reproduced because the same column is
  --    written by the delete path's negative delta.)
  UPDATE public.goals
     SET saved_amount = GREATEST(0, round(saved_amount + v_amount, 2))
   WHERE id = v_goal.id AND user_id = v_uid
  RETURNING saved_amount INTO v_new_saved;

  IF v_new_saved IS NULL THEN
    -- Unreachable: the row was selected under FOR UPDATE above.
    RAISE EXCEPTION 'GOAL_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'the goal disappeared mid-contribution';
  END IF;

  -- 2. The source account. The balance itself is not re-rounded, matching
  --    apply_account_balance_delta (`balance = balance + p_delta`); only the
  --    DELTA is 2dp, matching accountStore.updateBalance's rounding.
  IF v_self_stored THEN
    v_new_src := v_src.balance;
  ELSE
    UPDATE public.accounts
       SET balance = balance - v_src_amount
     WHERE id = v_src.id AND user_id = v_uid AND deleted_at IS NULL
    RETURNING balance INTO v_new_src;

    IF v_new_src IS NULL THEN
      RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
        DETAIL = 'the source account disappeared mid-contribution';
    END IF;
  END IF;

  -- 3. The goal's stored-in account.
  IF v_linked_id IS NOT NULL THEN
    UPDATE public.accounts
       SET balance = balance + v_amount
     WHERE id = v_linked_id AND user_id = v_uid AND deleted_at IS NULL
    RETURNING balance INTO v_new_linked;

    IF v_new_linked IS NULL THEN
      RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
        DETAIL = 'the goal''s stored-in account disappeared mid-contribution';
    END IF;
  END IF;

  -- 4. The row. EXACTLY the columns and values transactionsDb.add writes for a
  --    goal entry, read back the same way by mapTransaction:
  --      type                   'goal_contribution'
  --      amount                 the caller's amount, VERBATIM (the client stores
  --                             `input.amount` unrounded on the row and rounds
  --                             only the deltas)
  --      currency               the GOAL's currency, in all three sub-branches
  --      source_account_id      always the funding account
  --      destination_account_id the goal's stored-in account when a credit leg
  --                             ran, else NULL (self-stored, no link, or a link
  --                             whose account is gone)
  --      related_person         NULL; person_id NULL; related_loan_id NULL
  --      related_goal_id        the goal
  --      related_investment_id  omitted entirely — the client only sends it when
  --                             non-null, so a database without
  --                             supabase-migration-investments.sql still works
  --      conversion_rate        the caller's rate, or NULL
  --      notes                  the caller's notes, INCLUDING the
  --                             [[HISAAB_META:{"goalSelfStored":"1"}]] the
  --                             self-stored branch stamps; the server never
  --                             synthesises one
  --      is_reconciled          false; reconciled_at/by, receipt_path NULL
  --      updated_at             left to the column default, because the
  --                             client's insert payload omits it too
  v_created_at := COALESCE(p_date, now());

  INSERT INTO public.transactions (
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at,
    is_reconciled, reconciled_at, reconciled_by, receipt_path, deleted_at
  ) VALUES (
    p_transaction_id, v_uid, 'goal_contribution',
    p_amount, v_goal.currency,
    v_src.id, v_linked_id,
    NULL, NULL, NULL, v_goal.id,
    p_conversion_rate, COALESCE(p_category, ''), COALESCE(p_note, ''), v_created_at,
    false, NULL, NULL, NULL, NULL
  );

  RETURN jsonb_build_object(
    'status',            'ok',
    'replay',            false,
    'transaction_id',    p_transaction_id,
    'goal_id',           v_goal.id,
    'goal_saved_amount', v_new_saved,
    -- What the GOAL actually moved. Differs from the amount only if the clamp
    -- bit; compensations must give back THIS, never the requested amount.
    'goal_applied',      round(v_new_saved - v_goal.saved_amount, 2),
    'source_balance',    v_new_src,
    -- Signed, already 2dp — the client registers its inverse against THESE,
    -- never against a locally recomputed figure.
    'source_delta',      CASE WHEN v_self_stored THEN 0 ELSE -v_src_amount END,
    'linked_account_id', v_linked_id,
    'linked_balance',    v_new_linked,
    'linked_delta',      CASE WHEN v_linked_id IS NULL THEN NULL ELSE v_amount END,
    'currency',          v_goal.currency,
    'self_stored',       v_self_stored,
    'created_at',        v_created_at,
    'row_deleted',       false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.contribute_to_goal(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT,
  NUMERIC, NUMERIC, NUMERIC, BOOLEAN
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.contribute_to_goal(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT,
  NUMERIC, NUMERIC, NUMERIC, BOOLEAN
) TO authenticated;

COMMENT ON FUNCTION public.contribute_to_goal(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT,
  NUMERIC, NUMERIC, NUMERIC, BOOLEAN
) IS
  'Audit L4 step 4 (MF-01 / O-1 / F-4): the whole goal contribution — the source account leg, goals.saved_amount, the optional stored-in-account credit leg and the transactions row — in ONE Postgres transaction. Installs the FIRST compare-and-swap goals.saved_amount has ever had (goalStore.addContribution reads a local snapshot and writes an absolute figure, so two devices lose one contribution); the conflict token is BALANCE_CONFLICT, deliberately, so no new client ladder is needed. Locks accounts (both, one statement, ascending id) then goals, extending the repo lock chain by one leaf table. Reproduces the SELF-STORED case exactly: goal stored in the funding account => no balance legs at all, currency-blind, no rate. A stored-in account that no longer exists means no credit leg, not an error (the column is a label, not an FK). Idempotent on p_transaction_id. Ledger-mode users have no goals at all (App.tsx routes /goals away in splits_only) and a null account raises ACCOUNT_NOT_FOUND. Gated client-side by VITE_ATOMIC_GOAL.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. pay_card_bill — the credit-card story, one transaction
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.pay_card_bill(
  p_transaction_id          TEXT,
  p_row_type                TEXT,      -- 'transfer' | 'repayment'
  p_source_account_id       TEXT,
  p_card_account_id         TEXT,
  p_amount                  NUMERIC,   -- the ROW's amount
  p_source_amount           NUMERIC,   -- what the wallet loses (magnitude)
  p_card_amount             NUMERIC,   -- what the card gains (magnitude)
  p_currency                TEXT,      -- the ROW's currency; cross-checked
  p_conversion_rate         NUMERIC,
  p_note                    TEXT,
  p_category                TEXT,
  p_date                    TIMESTAMPTZ,
  p_plan                    JSONB,     -- [{loan_id, applied, expected_remaining, emi_ids, row_id, row_note}]
  p_expected_source_balance NUMERIC,
  p_expected_card_balance   NUMERIC,
  p_allow_negative          BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_src           public.accounts%ROWTYPE;
  v_card          public.accounts%ROWTYPE;
  v_existing      public.transactions%ROWTYPE;
  v_loan          public.loans%ROWTYPE;
  v_main_loan     public.loans%ROWTYPE;
  v_amount        NUMERIC;
  v_src_amount    NUMERIC;
  v_card_amount   NUMERIC;
  v_new_src       NUMERIC;
  v_new_card      NUMERIC;
  v_limit_txt     TEXT;
  v_limit         NUMERIC;
  v_headroom      NUMERIC;
  v_plan_len      INTEGER := 0;
  v_loan_ids      TEXT[] := ARRAY[]::TEXT[];
  v_row_ids       TEXT[] := ARRAY[]::TEXT[];
  v_all_emi_ids   TEXT[] := ARRAY[]::TEXT[];
  v_entry_emis    TEXT[];
  v_applied_sum   NUMERIC := 0;
  v_bad           INTEGER;
  v_dup           TEXT;
  v_created_at    TIMESTAMPTZ;
  v_entry         JSONB;
  v_applied       NUMERIC;
  v_new_remaining NUMERIC;
  v_new_status    TEXT;
  v_marked        TEXT[];
  v_lines         JSONB := '[]'::JSONB;
  v_row_id        TEXT;
  v_settled       INTEGER := 0;
BEGIN
  -- ── Auth ────────────────────────────────────────────────────────────────
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- ── Shape validation ────────────────────────────────────────────────────
  IF p_transaction_id IS NULL OR length(trim(p_transaction_id)) = 0 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION_ID' USING ERRCODE = 'P0001';
  END IF;

  IF p_row_type IS NULL OR p_row_type NOT IN ('transfer', 'repayment') THEN
    RAISE EXCEPTION 'INVALID_ROW_TYPE' USING ERRCODE = 'P0001',
      DETAIL = 'row type must be transfer or repayment, got ' || COALESCE(p_row_type, '<null>');
  END IF;

  -- Both ids are mandatory: this function exists BECAUSE money moves from a
  -- wallet to a card. A ledger repayment has neither and belongs to
  -- loanStore.applyRepayment (tasks/lessons.md:26-27).
  IF p_source_account_id IS NULL OR length(trim(p_source_account_id)) = 0
     OR p_card_account_id IS NULL OR length(trim(p_card_account_id)) = 0 THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'a card bill payment requires both a source account and a card; ledger-mode repayments use loanStore.applyRepayment, not this RPC';
  END IF;

  IF p_source_account_id = p_card_account_id THEN
    RAISE EXCEPTION 'SAME_ACCOUNT' USING ERRCODE = 'P0001',
      DETAIL = 'a card cannot pay its own bill';
  END IF;

  IF p_amount IS NULL OR p_amount = 'NaN'::NUMERIC OR p_amount <= 0 OR p_amount >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001',
      DETAIL = 'amount must be greater than 0 and less than 1e12';
  END IF;
  IF p_source_amount IS NULL OR p_source_amount = 'NaN'::NUMERIC
     OR p_source_amount <= 0 OR p_source_amount >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001',
      DETAIL = 'the source amount must be greater than 0 and less than 1e12';
  END IF;
  IF p_card_amount IS NULL OR p_card_amount = 'NaN'::NUMERIC
     OR p_card_amount < 0 OR p_card_amount >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT' USING ERRCODE = 'P0001',
      DETAIL = 'the card amount must be at least 0 and less than 1e12';
  END IF;

  IF p_expected_source_balance IS NULL OR p_expected_card_balance IS NULL THEN
    RAISE EXCEPTION 'EXPECTED_BALANCE_REQUIRED' USING ERRCODE = 'P0001',
      DETAIL = 'both the source account and the card need an expected balance';
  END IF;

  v_amount      := round(p_amount, 2);
  v_src_amount  := round(p_source_amount, 2);
  v_card_amount := round(p_card_amount, 2);

  -- ── The plan's shape, before anything is locked ─────────────────────────
  IF p_plan IS NOT NULL THEN
    IF jsonb_typeof(p_plan) <> 'array' THEN
      RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'p_plan must be a JSON array of settlement lines';
    END IF;
    v_plan_len := jsonb_array_length(p_plan);
  END IF;

  IF v_plan_len > 200 THEN
    -- A card cannot plausibly finance 200 open cash advances; a payload that
    -- says so is an attempt to hold 200 loan row locks in one transaction.
    RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
      DETAIL = 'at most 200 settlement lines';
  END IF;

  IF p_row_type = 'repayment' AND v_plan_len <> 1 THEN
    RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
      DETAIL = 'a repayment row settles exactly one loan — its own';
  END IF;

  IF v_plan_len > 0 THEN
    -- Pass 1: TYPES only. A value cast on a wrongly-typed member would raise an
    -- unnamed error, and AND does not short-circuit reliably in a WHERE.
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements(p_plan) AS e
     WHERE jsonb_typeof(e -> 'loan_id') IS DISTINCT FROM 'string'
        OR jsonb_typeof(e -> 'applied') IS DISTINCT FROM 'number'
        OR jsonb_typeof(e -> 'expected_remaining') IS DISTINCT FROM 'number'
        OR (e ? 'emi_ids' AND jsonb_typeof(e -> 'emi_ids') NOT IN ('array', 'null'))
        OR (e ? 'row_id'  AND jsonb_typeof(e -> 'row_id')  NOT IN ('string', 'null'));
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'every line needs loan_id (string), applied (number), expected_remaining (number), optional emi_ids (array) and row_id (string|null)';
    END IF;

    -- Pass 2: VALUES.
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements(p_plan) AS e
     WHERE length(trim(e ->> 'loan_id')) = 0
        OR (e ->> 'applied')::NUMERIC = 'NaN'::NUMERIC
        OR (e ->> 'applied')::NUMERIC <= 0
        OR (e ->> 'applied')::NUMERIC >= 1e12
        OR (e ->> 'expected_remaining')::NUMERIC = 'NaN'::NUMERIC
        OR (e ->> 'expected_remaining')::NUMERIC < 0;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'a line has an empty loan_id, a non-positive/absurd applied amount, or a negative expected_remaining';
    END IF;

    SELECT array_agg(e ->> 'loan_id' ORDER BY e ->> 'loan_id')
      INTO v_loan_ids
      FROM jsonb_array_elements(p_plan) AS e;

    IF (SELECT count(DISTINCT x) FROM unnest(v_loan_ids) AS x) <> v_plan_len THEN
      -- allocateBillPayment emits at most one line per loan. Two lines for one
      -- loan would make the second CAS fail anyway; refusing is clearer.
      RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'the same loan appears twice in the plan';
    END IF;

    SELECT COALESCE(array_agg(x), ARRAY[]::TEXT[]) INTO v_row_ids
      FROM (SELECT e ->> 'row_id' AS x FROM jsonb_array_elements(p_plan) AS e) s
     WHERE x IS NOT NULL AND length(trim(x)) > 0;

    IF (SELECT count(DISTINCT x) FROM unnest(v_row_ids) AS x)
       <> COALESCE(array_length(v_row_ids, 1), 0) THEN
      RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'duplicate ledger row ids in the plan';
    END IF;

    IF p_row_type = 'repayment' AND COALESCE(array_length(v_row_ids, 1), 0) > 0 THEN
      RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'a repayment row IS the record; its line must not ask for a second one';
    END IF;
    IF p_row_type = 'transfer'
       AND COALESCE(array_length(v_row_ids, 1), 0) <> v_plan_len THEN
      RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'every settled cash advance under a bill payment gets its own ledger row';
    END IF;

    SELECT round(sum((e ->> 'applied')::NUMERIC), 2) INTO v_applied_sum
      FROM jsonb_array_elements(p_plan) AS e;

    -- THE LOCKSTEP INVARIANT (src/lib/cardStatement.ts:16-19), and it applies
    -- to the BILL PAYMENT only: the cash-advance principal is ALREADY inside
    -- the card's `used`, so a payment reduces `used` and the matching share of
    -- the loans together. Settling more principal than the payment actually
    -- credited would mint money — the double-credit disaster, reached from the
    -- other direction.
    --
    -- It must NOT be applied to p_row_type='repayment': there the card credit
    -- is a CLAMPED side-effect (clampCardCredit), so paying 1000 against a card
    -- with 400 of headroom legitimately reduces the loan by 1000 and the card
    -- by 400 — the other 600 of the bill was already paid by a transfer, which
    -- had already credited the card. That asymmetry is the whole point of the
    -- clamp, and enforcing lockstep here would break the case this file exists
    -- to fix.
    IF p_row_type = 'transfer' AND v_applied_sum > v_card_amount + 0.01 THEN
      RAISE EXCEPTION 'PLAN_OVER_PAYMENT' USING ERRCODE = 'P0001',
        DETAIL = 'the plan settles ' || v_applied_sum::TEXT
                 || ' of principal but only ' || v_card_amount::TEXT
                 || ' was credited to the card';
    END IF;

    -- NOTE the CASE rather than COALESCE: a JSON `null` is not a SQL NULL, so
    -- COALESCE would hand jsonb_array_elements_text a scalar and raise an
    -- unnamed "cannot extract elements from a scalar".
    SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::TEXT[]) INTO v_all_emi_ids
      FROM jsonb_array_elements(p_plan) AS e,
           LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(e -> 'emi_ids') = 'array'
                  THEN e -> 'emi_ids' ELSE '[]'::JSONB END) AS x;
  END IF;

  -- ══ LOCK ORDER: loans → accounts → emi_schedules ════════════════════════
  -- (1) every loan in the plan, in ONE statement, ascending id.
  IF COALESCE(array_length(v_loan_ids, 1), 0) > 0 THEN
    PERFORM 1 FROM public.loans
     WHERE id = ANY(v_loan_ids) AND user_id = v_uid
     ORDER BY id
       FOR UPDATE;
  END IF;

  -- (2) BOTH account rows, in ONE statement, ascending id — the same order
  --     transfer_between_accounts and create_loan_with_leg take, so a bill
  --     payment cannot deadlock against either.
  PERFORM 1 FROM public.accounts
   WHERE id = ANY(ARRAY[p_source_account_id, p_card_account_id])
     AND user_id = v_uid
   ORDER BY id
     FOR UPDATE;

  -- (3) the instalments, last, ascending id.
  IF COALESCE(array_length(v_all_emi_ids, 1), 0) > 0 THEN
    PERFORM 1 FROM public.emi_schedules
     WHERE id = ANY(v_all_emi_ids) AND user_id = v_uid
     ORDER BY id
       FOR UPDATE;
  END IF;

  -- ── Idempotent replay ───────────────────────────────────────────────────
  SELECT * INTO v_existing
    FROM public.transactions
   WHERE id = p_transaction_id
     AND user_id = v_uid;

  IF FOUND THEN
    IF v_existing.type <> p_row_type THEN
      RAISE EXCEPTION 'TRANSACTION_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'that id already belongs to a ' || v_existing.type || ' entry';
    END IF;

    SELECT balance INTO v_new_src  FROM public.accounts
     WHERE id = p_source_account_id AND user_id = v_uid;
    SELECT balance INTO v_new_card FROM public.accounts
     WHERE id = p_card_account_id AND user_id = v_uid;

    RETURN jsonb_build_object(
      'status',         'ok',
      'replay',         true,
      'transaction_id', v_existing.id,
      'row_type',       v_existing.type,
      'source_balance', v_new_src,
      'source_delta',   0,
      'card_balance',   v_new_card,
      'card_delta',     0,
      'currency',       v_existing.currency,
      'settled',        0,
      'lines',          '[]'::JSONB,
      'created_at',     v_existing.created_at,
      'row_deleted',    (v_existing.deleted_at IS NOT NULL)
    );
  END IF;

  -- ── Load both accounts (locks already held) ─────────────────────────────
  SELECT * INTO v_src FROM public.accounts
   WHERE id = p_source_account_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'source account is unknown, deleted, or not yours';
  END IF;

  SELECT * INTO v_card FROM public.accounts
   WHERE id = p_card_account_id AND user_id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'card account is unknown, deleted, or not yours';
  END IF;

  -- Both entry points reach here only with a real credit card: the transfer
  -- tail's guard is `dest.type === 'credit_card'`, and the repayment branch's
  -- card comes from findCashAdvanceCardForLoan.
  IF v_card.type <> 'credit_card' THEN
    RAISE EXCEPTION 'NOT_A_CREDIT_CARD' USING ERRCODE = 'P0001',
      DETAIL = 'the destination of a card bill payment must be a credit_card account';
  END IF;

  -- ── The main row's own currency + conversion convention ─────────────────
  IF p_row_type = 'transfer' THEN
    -- transactionStore.ts:1599 — `currency = src.currency` for a transfer.
    IF p_currency IS NOT NULL AND p_currency <> v_src.currency THEN
      RAISE EXCEPTION 'CURRENCY_MISMATCH' USING ERRCODE = 'P0001',
        DETAIL = 'client said ' || p_currency || ', the source account is ' || v_src.currency;
    END IF;
    IF abs(v_src_amount - v_amount) > 0.01 THEN
      RAISE EXCEPTION 'SOURCE_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
        DETAIL = 'a transfer debits its source by exactly the row amount';
    END IF;

    IF v_src.currency <> v_card.currency THEN
      IF p_conversion_rate IS NULL THEN
        RAISE EXCEPTION 'CONVERSION_RATE_REQUIRED' USING ERRCODE = 'P0001',
          DETAIL = 'the source account and the card are in different currencies';
      END IF;
      IF p_conversion_rate = 'NaN'::NUMERIC
         OR p_conversion_rate < 0.0001 OR p_conversion_rate > 100000 THEN
        RAISE EXCEPTION 'INVALID_CONVERSION_RATE' USING ERRCODE = 'P0001',
          DETAIL = 'rate must be between 0.0001 and 100000';
      END IF;
      -- CORRECTION 4: the transfer convention is MULTIPLY (:1621).
      IF abs(round(v_amount * p_conversion_rate, 2) - v_card_amount) > 0.01 THEN
        RAISE EXCEPTION 'CARD_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
          DETAIL = 'client said ' || v_card_amount::TEXT || ', the server derives '
                   || round(v_amount * p_conversion_rate, 2)::TEXT;
      END IF;
    ELSE
      IF p_conversion_rate IS NOT NULL THEN
        RAISE EXCEPTION 'CONVERSION_RATE_NOT_APPLICABLE' USING ERRCODE = 'P0001',
          DETAIL = 'the source account and the card share a currency';
      END IF;
      IF abs(v_card_amount - v_amount) > 0.01 THEN
        RAISE EXCEPTION 'CARD_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
          DETAIL = 'a same-currency transfer credits the card by exactly the row amount';
      END IF;
    END IF;

    -- A DIRECT TRANSFER IS DELIBERATELY UNCLAMPED (src/lib/cardCredit.ts:7-9):
    -- "an explicit 'I moved money' is recorded as typed — the UI surfaces the
    -- overpaid state instead." No headroom check here, on purpose.
  ELSE
    -- p_row_type = 'repayment'. The main row IS the repayment record, so its
    -- currency is the LOAN's and its source deduction uses the DIVIDE
    -- convention (:1995).
    v_entry := p_plan -> 0;
    SELECT * INTO v_main_loan FROM public.loans
     WHERE id = (v_entry ->> 'loan_id') AND user_id = v_uid AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LOAN_NOT_FOUND' USING ERRCODE = 'P0001',
        DETAIL = 'loan is unknown, deleted, or not yours';
    END IF;

    IF p_currency IS NOT NULL AND p_currency <> v_main_loan.currency THEN
      RAISE EXCEPTION 'CURRENCY_MISMATCH' USING ERRCODE = 'P0001',
        DETAIL = 'client said ' || p_currency || ', the loan is ' || v_main_loan.currency;
    END IF;
    -- transactionStore.ts:1969-1971 — the client refuses a card whose currency
    -- differs from the loan's before any money moves.
    IF v_card.currency <> v_main_loan.currency THEN
      RAISE EXCEPTION 'CURRENCY_MISMATCH' USING ERRCODE = 'P0001',
        DETAIL = 'the cash-advance card must match the loan currency';
    END IF;
    IF abs(round((v_entry ->> 'applied')::NUMERIC, 2) - v_amount) > 0.01 THEN
      RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
        DETAIL = 'a repayment settles its own loan by exactly the row amount';
    END IF;

    IF v_src.currency <> v_main_loan.currency THEN
      IF p_conversion_rate IS NULL THEN
        RAISE EXCEPTION 'CONVERSION_RATE_REQUIRED' USING ERRCODE = 'P0001',
          DETAIL = 'the paying account and the loan are in different currencies';
      END IF;
      IF p_conversion_rate = 'NaN'::NUMERIC
         OR p_conversion_rate < 0.0001 OR p_conversion_rate > 100000 THEN
        RAISE EXCEPTION 'INVALID_CONVERSION_RATE' USING ERRCODE = 'P0001',
          DETAIL = 'rate must be between 0.0001 and 100000';
      END IF;
      IF abs(round(v_amount / p_conversion_rate, 2) - v_src_amount) > 0.01 THEN
        RAISE EXCEPTION 'SOURCE_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
          DETAIL = 'client said ' || v_src_amount::TEXT || ', the server derives '
                   || round(v_amount / p_conversion_rate, 2)::TEXT;
      END IF;
    ELSE
      IF p_conversion_rate IS NOT NULL THEN
        RAISE EXCEPTION 'CONVERSION_RATE_NOT_APPLICABLE' USING ERRCODE = 'P0001',
          DETAIL = 'the paying account and the loan share a currency';
      END IF;
      IF abs(v_src_amount - v_amount) > 0.01 THEN
        RAISE EXCEPTION 'SOURCE_AMOUNT_MISMATCH' USING ERRCODE = 'P0001',
          DETAIL = 'a same-currency repayment debits its source by exactly the row amount';
      END IF;
    END IF;

    -- ── THE CLAMP (src/lib/cardCredit.ts clampCardCredit). The CLIENT computes
    --    it; the server re-validates it, because crediting a card past its
    --    limit is the "Available 27,650 over Limit 16,500" bug and one curl
    --    would reproduce it. `metadata.creditLimit` is a STRING inside a JSONB
    --    column, so it is guarded by a numeric regex before the cast — a
    --    hand-edited 'unlimited' must mean "no clamp", not an error.
    v_limit_txt := v_card.metadata ->> 'creditLimit';
    IF v_limit_txt IS NOT NULL AND v_limit_txt ~ '^[0-9]+(\.[0-9]+)?$' THEN
      v_limit := v_limit_txt::NUMERIC;
    ELSE
      v_limit := NULL;
    END IF;

    IF v_limit IS NOT NULL AND v_limit > 0 THEN
      v_headroom := GREATEST(0, round(v_limit - v_card.balance, 2));
      IF v_card_amount > v_headroom + 0.01 THEN
        RAISE EXCEPTION 'CARD_CREDIT_OVER_LIMIT' USING ERRCODE = 'P0001',
          DETAIL = jsonb_build_object(
            'account_id',   v_card.id,
            'account_name', v_card.name,
            'headroom',     v_headroom,
            'requested',    v_card_amount
          )::TEXT;
      END IF;
    END IF;
  END IF;

  -- ── Optimistic locks on both accounts ───────────────────────────────────
  IF round(v_src.balance, 2) <> round(p_expected_source_balance, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',               v_src.id,
        'account_balance',          v_src.balance,
        'expected_account_balance', p_expected_source_balance
      )::TEXT;
  END IF;

  IF round(v_card.balance, 2) <> round(p_expected_card_balance, 2) THEN
    RAISE EXCEPTION 'BALANCE_CONFLICT' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',               v_card.id,
        'account_balance',          v_card.balance,
        'expected_account_balance', p_expected_card_balance
      )::TEXT;
  END IF;

  -- ── Insufficient-balance guard on the paying account ────────────────────
  -- Applied to a credit-card SOURCE too, exactly as checkBalance is today (a
  -- card's `balance` IS its available credit, so "insufficient" means "over the
  -- limit"). p_allow_negative is true only for a splits_only repayment.
  IF NOT COALESCE(p_allow_negative, false) AND v_src.balance < v_src_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING
      ERRCODE = 'P0001',
      DETAIL  = jsonb_build_object(
        'account_id',   v_src.id,
        'account_name', v_src.name,
        'account_type', v_src.type,
        'currency',     v_src.currency,
        'available',    v_src.balance,
        'requested',    v_src_amount
      )::TEXT;
  END IF;

  -- ── The main row's id, and every ledger row id, must be free ────────────
  IF COALESCE(array_length(v_row_ids, 1), 0) > 0 THEN
    SELECT id INTO v_dup FROM public.transactions
     WHERE id = ANY(v_row_ids) LIMIT 1;
    IF v_dup IS NOT NULL THEN
      RAISE EXCEPTION 'TRANSACTION_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'ledger row ' || v_dup || ' already exists';
    END IF;
    IF p_transaction_id = ANY(v_row_ids) THEN
      RAISE EXCEPTION 'TRANSACTION_ID_COLLISION' USING ERRCODE = 'P0001',
        DETAIL = 'a ledger row cannot reuse the bill payment''s own id';
    END IF;
  END IF;

  -- ── VALIDATION PASS over the plan. Every loan, every CAS, every instalment
  --    checked BEFORE the first write. (The transaction would roll back a late
  --    refusal anyway — this ordering is what makes that provable rather than
  --    merely true.)
  IF v_plan_len > 0 THEN
    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_plan) LOOP
      SELECT * INTO v_loan FROM public.loans
       WHERE id = (v_entry ->> 'loan_id') AND user_id = v_uid AND deleted_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'LOAN_NOT_FOUND' USING ERRCODE = 'P0001',
          DETAIL = 'loan ' || (v_entry ->> 'loan_id') || ' is unknown, deleted, or not yours';
      END IF;

      -- A card funds cash advances, which are loans you TOOK. Settling a loan
      -- you GAVE against a card bill would be free money.
      IF v_loan.type <> 'taken' THEN
        RAISE EXCEPTION 'PLAN_INVALID' USING ERRCODE = 'P0001',
          DETAIL = 'loan ' || v_loan.id || ' is a loan you GAVE; a card bill settles cash advances only';
      END IF;
      IF v_loan.currency <> v_card.currency THEN
        -- The client filters fundedLoans to `l.currency === dest.currency`
        -- (transactionStore.ts:1685) before planning.
        RAISE EXCEPTION 'CURRENCY_MISMATCH' USING ERRCODE = 'P0001',
          DETAIL = 'loan ' || v_loan.id || ' is ' || v_loan.currency
                   || ' but the card is ' || v_card.currency;
      END IF;

      -- The loan compare-and-swap, byte-identical to apply_loan_remaining_delta.
      IF round(v_loan.remaining_amount, 2)
         <> round((v_entry ->> 'expected_remaining')::NUMERIC, 2) THEN
        RAISE EXCEPTION 'LOAN_REMAINING_CONFLICT' USING
          ERRCODE = 'P0001',
          DETAIL  = jsonb_build_object(
            'loan_id',            v_loan.id,
            'loan_remaining',     v_loan.remaining_amount,
            'expected_remaining', (v_entry ->> 'expected_remaining')::NUMERIC
          )::TEXT;
      END IF;

      -- Every instalment must belong to THIS loan and THIS user. An
      -- already-paid one is SKIPPED, not refused — that is exactly what
      -- trackedMarkEmiPaid does (`if (prevStatus === 'paid') return;`).
      v_entry_emis := ARRAY(
        SELECT jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(v_entry -> 'emi_ids') = 'array'
               THEN v_entry -> 'emi_ids' ELSE '[]'::JSONB END));
      IF COALESCE(array_length(v_entry_emis, 1), 0) > 0 THEN
        SELECT count(*) INTO v_bad
          FROM unnest(v_entry_emis) AS x
         WHERE NOT EXISTS (
           SELECT 1 FROM public.emi_schedules s
            WHERE s.id = x AND s.user_id = v_uid AND s.loan_id = v_loan.id);
        IF v_bad > 0 THEN
          RAISE EXCEPTION 'EMI_SCHEDULE_INVALID' USING ERRCODE = 'P0001',
            DETAIL = v_bad::TEXT || ' instalment id(s) do not belong to loan ' || v_loan.id;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- ══ THE WRITES. Everything above refused without touching a row. ════════
  v_created_at := COALESCE(p_date, now());

  -- 1. The loans, their instalments and their ledger rows.
  IF v_plan_len > 0 THEN
    FOR v_entry IN SELECT * FROM jsonb_array_elements(p_plan) LOOP
      -- The clamp and the status derivation happen IN the statement, exactly as
      -- apply_loan_remaining_delta does them — never from a plpgsql snapshot.
      UPDATE public.loans
         SET remaining_amount = round(GREATEST(0, remaining_amount
                                                  - round((v_entry ->> 'applied')::NUMERIC, 2)), 2),
             status = CASE
                        WHEN round(GREATEST(0, remaining_amount
                                               - round((v_entry ->> 'applied')::NUMERIC, 2)), 2) = 0
                          THEN 'settled' ELSE 'active' END
       WHERE id = (v_entry ->> 'loan_id') AND user_id = v_uid AND deleted_at IS NULL
      RETURNING remaining_amount, status INTO v_new_remaining, v_new_status;

      IF v_new_remaining IS NULL THEN
        RAISE EXCEPTION 'LOAN_NOT_FOUND' USING ERRCODE = 'P0001',
          DETAIL = 'loan ' || (v_entry ->> 'loan_id') || ' disappeared mid-payment';
      END IF;

      SELECT * INTO v_loan FROM public.loans
       WHERE id = (v_entry ->> 'loan_id') AND user_id = v_uid;

      -- What the loan ACTUALLY moved — the clamped figure, not the requested
      -- one. Compensations must give back THIS.
      v_applied := round(round((v_entry ->> 'expected_remaining')::NUMERIC, 2) - v_new_remaining, 2);

      v_entry_emis := ARRAY(
        SELECT jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(v_entry -> 'emi_ids') = 'array'
               THEN v_entry -> 'emi_ids' ELSE '[]'::JSONB END));
      v_marked := ARRAY[]::TEXT[];
      IF COALESCE(array_length(v_entry_emis, 1), 0) > 0 THEN
        WITH flipped AS (
          UPDATE public.emi_schedules
             SET status = 'paid'
           WHERE id = ANY(v_entry_emis)
             AND user_id = v_uid
             AND loan_id = v_loan.id
             AND status <> 'paid'
          RETURNING id
        )
        SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::TEXT[]) INTO v_marked FROM flipped;
      END IF;

      -- The ledger-only 'repayment' row. EXACTLY what the transfer tail writes
      -- (transactionStore.ts:1733-1752): BOTH account ids NULL, the loan's own
      -- person, no rate, empty category, and the note the client already built
      -- (so the [[HISAAB_META:…]] encoding can never fork).
      v_row_id := NULLIF(trim(COALESCE(v_entry ->> 'row_id', '')), '');
      IF v_row_id IS NOT NULL THEN
        INSERT INTO public.transactions (
          id, user_id, type, amount, currency,
          source_account_id, destination_account_id,
          related_person, person_id, related_loan_id, related_goal_id,
          conversion_rate, category, notes, created_at,
          is_reconciled, reconciled_at, reconciled_by, receipt_path, deleted_at
        ) VALUES (
          v_row_id, v_uid, 'repayment',
          round((v_entry ->> 'applied')::NUMERIC, 2), v_loan.currency,
          NULL, NULL,
          v_loan.person_name, v_loan.person_id, v_loan.id, NULL,
          NULL, '', COALESCE(v_entry ->> 'row_note', ''), v_created_at,
          false, NULL, NULL, NULL, NULL
        );
      END IF;

      v_settled := v_settled + 1;
      v_lines := v_lines || jsonb_build_object(
        'loan_id',        v_loan.id,
        'applied',        v_applied,
        'remaining',      v_new_remaining,
        'status',         v_new_status,
        'settled_now',    (v_new_remaining = 0),
        'person_name',    v_loan.person_name,
        'person_id',      v_loan.person_id,
        'currency',       v_loan.currency,
        'emi_marked',     to_jsonb(v_marked),
        'row_id',         v_row_id
      );
    END LOOP;
  END IF;

  -- 2. The source account.
  UPDATE public.accounts
     SET balance = balance - v_src_amount
   WHERE id = v_src.id AND user_id = v_uid AND deleted_at IS NULL
  RETURNING balance INTO v_new_src;
  IF v_new_src IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
      DETAIL = 'the source account disappeared mid-payment';
  END IF;

  -- 3. The card. A zero credit is a legal no-op (clampCardCredit returns
  --    { credited: 0 } when the bill is already covered), and the UPDATE is
  --    skipped rather than writing balance + 0.
  IF v_card_amount > 0 THEN
    UPDATE public.accounts
       SET balance = balance + v_card_amount
     WHERE id = v_card.id AND user_id = v_uid AND deleted_at IS NULL
    RETURNING balance INTO v_new_card;
    IF v_new_card IS NULL THEN
      RAISE EXCEPTION 'ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0001',
        DETAIL = 'the card disappeared mid-payment';
    END IF;
  ELSE
    v_new_card := v_card.balance;
  END IF;

  -- 4. The main row.
  --    transfer  → source = wallet, destination = card, no person, no loan
  --    repayment → source = wallet, destination = card, the LOAN's person and
  --                the loan id (transactionStore.ts:1926-1928, :2004/:2021)
  INSERT INTO public.transactions (
    id, user_id, type, amount, currency,
    source_account_id, destination_account_id,
    related_person, person_id, related_loan_id, related_goal_id,
    conversion_rate, category, notes, created_at,
    is_reconciled, reconciled_at, reconciled_by, receipt_path, deleted_at
  ) VALUES (
    p_transaction_id, v_uid, p_row_type,
    p_amount,
    CASE WHEN p_row_type = 'transfer' THEN v_src.currency ELSE v_main_loan.currency END,
    v_src.id, v_card.id,
    CASE WHEN p_row_type = 'transfer' THEN NULL ELSE v_main_loan.person_name END,
    CASE WHEN p_row_type = 'transfer' THEN NULL ELSE v_main_loan.person_id END,
    CASE WHEN p_row_type = 'transfer' THEN NULL ELSE v_main_loan.id END,
    NULL,
    p_conversion_rate, COALESCE(p_category, ''), COALESCE(p_note, ''), v_created_at,
    false, NULL, NULL, NULL, NULL
  );

  RETURN jsonb_build_object(
    'status',         'ok',
    'replay',         false,
    'transaction_id', p_transaction_id,
    'row_type',       p_row_type,
    'source_balance', v_new_src,
    'source_delta',   -v_src_amount,
    'card_balance',   v_new_card,
    'card_delta',     v_card_amount,
    'currency',       CASE WHEN p_row_type = 'transfer'
                          THEN v_src.currency ELSE v_main_loan.currency END,
    'settled',        v_settled,
    'lines',          v_lines,
    'created_at',     v_created_at,
    'row_deleted',    false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pay_card_bill(
  TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, TEXT, TEXT,
  TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, BOOLEAN
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.pay_card_bill(
  TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, TEXT, TEXT,
  TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, BOOLEAN
) TO authenticated;

COMMENT ON FUNCTION public.pay_card_bill(
  TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, TEXT, TEXT,
  TIMESTAMPTZ, JSONB, NUMERIC, NUMERIC, BOOLEAN
) IS
  'Audit L4 step 4 (MF-01 / F-2 / O-1 / F-4): the whole credit-card story in ONE Postgres transaction — the wallet debit, the card credit, every cash-advance loan the payment settles (remaining + status), every instalment it covers, and every row. Two row types, one shape: p_row_type=''transfer'' is a bill payment whose plan lines each write their own ledger-only repayment row; p_row_type=''repayment'' is a cash-advance repayment whose single line IS the main row (the case supabase-migration-p3-atomic-repayment.sql deliberately left on the legacy path, because record_loan_repayment takes exactly one account). The ALLOCATION stays in TypeScript (src/lib/cardStatement.ts allocateBillPayment, src/lib/cardCredit.ts clampCardCredit): the client plans, the server applies and RE-VALIDATES — the plan may not settle more principal than the payment credited (PLAN_OVER_PAYMENT), may not credit a card past its limit on a repayment (CARD_CREDIT_OVER_LIMIT; a direct transfer stays unclamped, by design), and every instalment must belong to its loan. Locks loans (all, one statement, ascending id) -> accounts (both, one statement, ascending id) -> emi_schedules, per the repo rule. Compare-and-swap on both balances (BALANCE_CONFLICT) and on every loan (LOAN_REMAINING_CONFLICT) — the tokens the client ladders already parse. Idempotent on p_transaction_id, and every ledger row id must be free. Ledger-mode (splits_only) repayments never come here: they use loanStore.applyRepayment and a null account raises ACCOUNT_NOT_FOUND. Gated client-side by VITE_ATOMIC_CARD_BILL.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. VERIFICATION — read-only, safe to re-run at any time
-- ═══════════════════════════════════════════════════════════════════════════

-- V1. Both functions exist with the expected signatures, are SECURITY DEFINER,
--     and pin their search_path.
--     EXPECT: two rows; security_definer = t; config contains search_path=public.
SELECT p.proname,
       p.prosecdef                               AS security_definer,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.proconfig                               AS config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('contribute_to_goal', 'pay_card_bill')
 ORDER BY p.proname;

-- V2. Privileges: authenticated may execute both; anon and PUBLIC may not.
--     EXPECT: every column t / f as named.
SELECT has_function_privilege('authenticated',
         'public.contribute_to_goal(text,text,text,numeric,numeric,numeric,text,text,timestamptz,text,numeric,numeric,numeric,boolean)',
         'EXECUTE') AS goal_auth_can,
       has_function_privilege('anon',
         'public.contribute_to_goal(text,text,text,numeric,numeric,numeric,text,text,timestamptz,text,numeric,numeric,numeric,boolean)',
         'EXECUTE') AS goal_anon_can,
       has_function_privilege('authenticated',
         'public.pay_card_bill(text,text,text,text,numeric,numeric,numeric,text,numeric,text,text,timestamptz,jsonb,numeric,numeric,boolean)',
         'EXECUTE') AS card_auth_can,
       has_function_privilege('anon',
         'public.pay_card_bill(text,text,text,text,numeric,numeric,numeric,text,numeric,text,text,timestamptz,jsonb,numeric,numeric,boolean)',
         'EXECUTE') AS card_anon_can;

-- V3. Body roll-call — the invariants this file exists to install.
--     EXPECT: every column t.
SELECT (g LIKE '%FOR UPDATE%')                                AS goal_takes_row_locks,
       (g LIKE '%ORDER BY id%')                               AS goal_locks_accounts_in_id_order,
       (g LIKE '%BALANCE_CONFLICT%')                          AS goal_has_cas,
       (g LIKE '%expected_saved_amount%')                     AS goal_cas_is_on_saved_amount,
       (g LIKE '%GREATEST(0, round(saved_amount + v_amount, 2))%') AS goal_clamp_matches_client,
       (g LIKE '%INSUFFICIENT_BALANCE%')                      AS goal_guards_balance,
       (g LIKE '%v_self_stored%')                             AS goal_reproduces_self_stored,
       (g LIKE '%user_id = v_uid%')                           AS goal_owner_scoped,
       (c LIKE '%FOR UPDATE%')                                AS card_takes_row_locks,
       (c LIKE '%ORDER BY id%')                               AS card_locks_in_id_order,
       (c LIKE '%LOAN_REMAINING_CONFLICT%')                   AS card_has_loan_cas,
       (c LIKE '%PLAN_OVER_PAYMENT%')                         AS card_enforces_lockstep,
       (c LIKE '%CARD_CREDIT_OVER_LIMIT%')                    AS card_enforces_headroom,
       (c LIKE '%EMI_SCHEDULE_INVALID%')                      AS card_revalidates_emis,
       (c LIKE '%INSERT INTO public.transactions%')           AS card_writes_rows
  FROM (SELECT pg_get_functiondef(
          'public.contribute_to_goal(text,text,text,numeric,numeric,numeric,text,text,timestamptz,text,numeric,numeric,numeric,boolean)'::regprocedure) AS g,
               pg_get_functiondef(
          'public.pay_card_bill(text,text,text,text,numeric,numeric,numeric,text,numeric,text,text,timestamptz,jsonb,numeric,numeric,boolean)'::regprocedure) AS c
       ) s;

-- V4. Assertions. Aborts loudly with a descriptive message on any failure.
DO $$
DECLARE
  v_g   TEXT;
  v_c   TEXT;
  v_gs  CONSTANT TEXT :=
    'public.contribute_to_goal(text,text,text,numeric,numeric,numeric,text,text,timestamptz,text,numeric,numeric,numeric,boolean)';
  v_cs  CONSTANT TEXT :=
    'public.pay_card_bill(text,text,text,text,numeric,numeric,numeric,text,numeric,text,text,timestamptz,jsonb,numeric,numeric,boolean)';
BEGIN
  IF to_regprocedure(v_gs) IS NULL THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: contribute_to_goal is missing';
  END IF;
  IF to_regprocedure(v_cs) IS NULL THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: pay_card_bill is missing';
  END IF;

  v_g := pg_get_functiondef(v_gs::regprocedure);
  v_c := pg_get_functiondef(v_cs::regprocedure);

  IF v_g NOT LIKE '%FOR UPDATE%' OR v_c NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: the row locks are gone — concurrent contributions and bill payments can now interleave';
  END IF;
  IF v_g NOT LIKE '%ORDER BY id%' OR v_c NOT LIKE '%ORDER BY id%' THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: the ascending-id lock order is gone — these can now deadlock against transfer_between_accounts';
  END IF;
  IF v_g NOT LIKE '%expected_saved_amount%' THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: the goals.saved_amount compare-and-swap is gone — two devices can lose a contribution again';
  END IF;
  IF v_g NOT LIKE '%v_self_stored%' THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: the self-stored case is gone — a goal kept in its own account would now be double-counted';
  END IF;
  IF v_c NOT LIKE '%LOAN_REMAINING_CONFLICT%' THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: the loan compare-and-swap is gone — a bill payment can now lose a concurrent repayment';
  END IF;
  IF v_c NOT LIKE '%PLAN_OVER_PAYMENT%' THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: the lockstep invariant is gone — a plan can now settle more principal than the payment credited (money minted)';
  END IF;
  IF v_c NOT LIKE '%CARD_CREDIT_OVER_LIMIT%' THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: the card headroom clamp is gone — the Available-over-Limit bug is reachable again';
  END IF;
  IF v_c NOT LIKE '%EMI_SCHEDULE_INVALID%' THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: the instalment ownership check is gone — a plan can now flip another loan''s instalments';
  END IF;
  IF NOT has_function_privilege('authenticated', v_gs, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_cs, 'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: authenticated cannot execute both functions';
  END IF;
  IF has_function_privilege('anon', v_gs, 'EXECUTE')
     OR has_function_privilege('anon', v_cs, 'EXECUTE') THEN
    RAISE EXCEPTION 'p3-atomic-goal-and-card: anon can execute one of the functions';
  END IF;

  RAISE NOTICE 'p3-atomic-goal-and-card: verification passed';
END;
$$;

-- V5. DRIFT WATCH #1 — goal_contribution rows whose legs contradict themselves.
--     EXPECT: zero rows, before and after.
--
--     Legitimate shapes:
--       source set, destination NULL      → tracked internally, self-stored, or
--                                           a stored-in account that is gone
--       source set, destination set       → the goal is stored in a DIFFERENT
--                                           real account
--       source NULL                       → NEVER. splits_only has no goals.
SELECT t.id, t.created_at, t.amount, t.currency,
       t.source_account_id, t.destination_account_id, t.related_goal_id,
       CASE
         WHEN t.source_account_id IS NULL
           THEN 'a goal contribution with no source account (ledger mode has no goals)'
         WHEN t.related_goal_id IS NULL
           THEN 'a goal contribution pointing at no goal'
         WHEN t.destination_account_id = t.source_account_id
           THEN 'a goal contribution crediting the account it debited'
         ELSE 'unclassified goal-leg drift'
       END AS problem
  FROM public.transactions t
 WHERE t.type = 'goal_contribution'
   AND t.deleted_at IS NULL
   AND (t.source_account_id IS NULL
        OR t.related_goal_id IS NULL
        OR t.destination_account_id = t.source_account_id)
 ORDER BY t.created_at DESC;

-- V6. DRIFT WATCH #2 — the goal-accounting signature: a goal whose saved_amount
--     does not match the contributions recorded against it. Rows here are
--     HISTORY, written before this CAS existed (two devices, one lost
--     contribution) or by the record-only `correctSavedAmount` repair — know the
--     number BEFORE the flag goes on so any post-rollout row is unambiguous.
--     EXPECT: a stable number; zero NEW rows after the flag.
SELECT g.id, g.title, g.currency,
       g.saved_amount,
       round(COALESCE(sum(t.amount), 0), 2)                     AS contributions_recorded,
       round(g.saved_amount - COALESCE(sum(t.amount), 0), 2)    AS gap
  FROM public.goals g
  LEFT JOIN public.transactions t
         ON t.related_goal_id = g.id
        AND t.type = 'goal_contribution'
        AND t.deleted_at IS NULL
 GROUP BY g.id, g.title, g.currency, g.saved_amount
HAVING abs(g.saved_amount - COALESCE(sum(t.amount), 0)) > 0.01
 ORDER BY abs(g.saved_amount - COALESCE(sum(t.amount), 0)) DESC;

-- V7. DRIFT WATCH #3 — THE CARD LOCKSTEP INVARIANT
--     (src/lib/cardStatement.ts:16-19):
--         used (= creditLimit − balance) = revolving purchases
--                                          + Σ(cash-advance remaining)
--     so Σ(remaining) may never EXCEED `used`. When it does, the same debt is
--     counted twice — the "Available 27,650 over Limit 16,500" signature — and
--     it is exactly what a bill payment that credited the card but failed to
--     settle its loans leaves behind.
--     EXPECT: zero rows, before and after.
SELECT a.id                                   AS card_id,
       a.name                                 AS card_name,
       (a.metadata ->> 'creditLimit')         AS credit_limit,
       a.balance,
       round((a.metadata ->> 'creditLimit')::NUMERIC - a.balance, 2) AS used,
       round(sum(l.remaining_amount), 2)      AS advances_remaining,
       round(sum(l.remaining_amount)
             - ((a.metadata ->> 'creditLimit')::NUMERIC - a.balance), 2) AS over_by
  FROM public.accounts a
  JOIN public.transactions t
    ON t.source_account_id = a.id
   AND t.type = 'loan_taken'
   AND t.deleted_at IS NULL
  JOIN public.loans l
    ON l.id = t.related_loan_id
   AND l.deleted_at IS NULL
   AND l.status = 'active'
 WHERE a.type = 'credit_card'
   AND a.deleted_at IS NULL
   AND (a.metadata ->> 'creditLimit') ~ '^[0-9]+(\.[0-9]+)?$'
   AND (a.metadata ->> 'creditLimit')::NUMERIC > 0
 GROUP BY a.id, a.name, a.metadata, a.balance
HAVING sum(l.remaining_amount)
       > ((a.metadata ->> 'creditLimit')::NUMERIC - a.balance) + 0.01
 ORDER BY 7 DESC;

-- V8. DRIFT WATCH #4 — a bill payment's ledger rows must reconcile to it: for
--     every 'transfer' into a credit card that carries linked repayment rows,
--     Σ(linked rows) may not exceed what the transfer credited.
--     EXPECT: zero rows.
SELECT t.id                                   AS transfer_id,
       t.created_at,
       t.amount                               AS paid,
       t.conversion_rate,
       round(sum(r.amount), 2)                AS settled,
       count(r.id)                            AS ledger_rows
  FROM public.transactions t
  JOIN public.transactions r
    ON r.type = 'repayment'
   AND r.deleted_at IS NULL
   AND r.source_account_id IS NULL
   AND r.destination_account_id IS NULL
   AND r.notes LIKE '%' || t.id || '%'
 WHERE t.type = 'transfer'
   AND t.deleted_at IS NULL
 GROUP BY t.id, t.created_at, t.amount, t.conversion_rate
HAVING round(sum(r.amount), 2)
       > round(t.amount * COALESCE(t.conversion_rate, 1), 2) + 0.01
 ORDER BY t.created_at DESC;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. Manual authenticated QA (run as a normal signed-in account).
-- Every one of these also runs in Docker — see
-- supabase/tests/tests/7y-atomic-goal-and-card.sql and
-- docs/server-side-money-engine.md §18-22.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  1. Goal contribution, same currency (Bank 1000 AED, goal "Umrah" AED,
--     tracked internally, saved 0, contribute 200):
--       select public.contribute_to_goal(
--         gen_random_uuid()::text, '<goal>', '<bank>', 200, 200, null,
--         '', '', now(), null, 1000, null, 0, false);
--     → {"source_balance":800.00,"goal_saved_amount":200.00,"self_stored":false}
--       and ONE transactions row: type 'goal_contribution',
--       source_account_id = <bank>, destination_account_id NULL,
--       related_goal_id = <goal>.
--
--  2. Goal stored in a DIFFERENT account: the same call also credits that
--     account by the full amount and the row carries it as its destination.
--
--  3. Goal stored in the SOURCE account (self-stored): pass the same id for
--     both. → source_balance UNCHANGED, saved_amount moves, the row's
--     destination is NULL. A conversion rate on this payload →
--     CONVERSION_RATE_NOT_APPLICABLE.
--
--  4. Stale expectation on the GOAL (p_expected_saved_amount = 0 when it is
--     already 200). → BALANCE_CONFLICT, DETAIL carries goal_saved_amount.
--     NOTHING moved — not the account, not the goal, no row.
--
--  5. Insufficient (contribute 10 000 from an 800 account).
--     → INSUFFICIENT_BALANCE, DETAIL {available:800, requested:10000}.
--
--  6. Cross-currency (PKR account 50 000, AED goal, contribute AED 100 at
--     rate 76.5): p_source_amount must be round(100 / 76.5, 2) = 1.31 …
--     no: the CLIENT sends round(amount / rate, 2); a lying figure →
--     SOURCE_AMOUNT_MISMATCH.
--
--  7. Replay: call #1 again with the SAME p_transaction_id.
--     → {"replay":true, …}; the money moves once, one row, not two.
--
--  8. Card bill: transfer 2 394.69 AED from <bank> into <card> (limit 16 500,
--     balance 6 521.96, one active advance of 8 666.68 with a 1 083.33
--     instalment due):
--       select public.pay_card_bill(
--         gen_random_uuid()::text, 'transfer', '<bank>', '<card>',
--         2394.69, 2394.69, 2394.69, 'AED', null, '', '', now(),
--         '[{"loan_id":"<adv>","applied":1083.33,"expected_remaining":8666.68,
--            "emi_ids":["<emi1>"],"row_id":"<uuid>","row_note":"Covered by card bill payment"}]'::jsonb,
--         <bank balance>, 6521.96, false);
--     → bank − 2 394.69, card + 2 394.69, the advance down to 7 583.35, the
--       instalment 'paid', and TWO transactions rows (the transfer and one
--       ledger repayment with both account ids NULL).
--
--  9. A plan that settles MORE principal than the payment credited.
--     → PLAN_OVER_PAYMENT, nothing written. (This is the money-minting shape.)
--
-- 10. Cash-advance repayment crediting the card (p_row_type 'repayment'):
--     one plan line, row_id NULL. → wallet debited, card credited by the
--     CLAMPED figure, loan reduced, instalments flipped, ONE row carrying
--     source = wallet and destination = card. A p_card_amount above the card's
--     headroom → CARD_CREDIT_OVER_LIMIT.
--
-- 11. An instalment id belonging to another loan → EMI_SCHEDULE_INVALID, and
--     the loan, the balances and the rows are all untouched.
--
-- 12. anon: call either with the anon key.
--     → permission denied for function …
-- ═══════════════════════════════════════════════════════════════════════════
