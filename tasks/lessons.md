# Lessons

Rules I (Claude) must follow in this repo, distilled from corrections and near-misses.
Review at the start of every session.

## Corrections (2026-07-18 — bulk repayment left no record)

- **Trace BOTH app modes end-to-end for any money flow.** Full-tracker creates transaction
  rows; ledger-only (`splits_only`) historically mutated `loans.remainingAmount` with NO
  transaction, NO activity for partial payments, and NO statement itemisation. Shipping the
  bulk-repayment feature on top of that silently vanished the user's payment records. Rule:
  before calling a money feature done, enumerate every artifact each mode leaves behind
  (transaction row? activity entry? statement line? loan history?) and prove each exists.
- **Never gate a primary action behind an edge-case trigger.** The "spread across their
  loans" offer only appeared on overpayment — invisible the moment the typed amount fit the
  opened loan. Primary capabilities need persistent, always-visible affordances.
- **When end-to-end verification is blocked (no login), say so louder** and walk each state
  transition on paper for both modes — unit tests of the pure math did not catch a
  record-keeping hole one layer up.
- **When a user says "it does nothing", check the submit handler's FIRST guard line before
  anything else.** RepaymentModal's `if (!parsedAmount || !accountId) return;` silently killed
  the Record-payment button in ledger mode (no account picker → accountId always '') while
  canSubmit kept the button enabled. A deploy log proving the build is current means the bug
  is real — stop suspecting staleness and re-read the entry-point guards for each mode.
  Also: every guard that requires an account must carry the `isLedgerOnlyMode ||` exception,
  and any code path over transactions must tolerate rows with BOTH account ids null (ledger
  repayment records).

## Process

- **Search for existing infrastructure before designing new.** The consolidated-repayment
  "missing feature" (2026-07-17) already had a pure, tested allocation engine
  (`src/lib/repaymentAllocation.ts` + `AllocateRepaymentModal`) — it was just buried on a
  secondary screen. The fix was surfacing + wiring, not building. Always grep for prior art
  (allocation, math, modals) before proposing new modules.
- **Every app change ships to BOTH web and Android** (`npm run build` + `npx cap sync android`,
  then hand off the Gradle AAB build). Never call a change done web-only.
- **Pure logic goes in `src/lib/` with a colocated `*.test.ts`** (Vitest). Stores/DB writes are
  verified manually — that's the repo's deliberate testing philosophy (see vitest.config.ts).
- **Money-moving code must follow the existing safety patterns:** `runSafeMutation`/`MutationScope`
  compensation, `apply_account_balance_delta` optimistic lock, UI-level overpayment guards
  (the store silently clamps at 0 — the UI guard is the real protection).
- **Keep grouping keys consistent app-wide:** person key = `personId ?? lowercased trimmed name`,
  group key includes direction + currency (LoansPage rule). A person can hold both directions
  and multiple currencies simultaneously — never merge across either.
- **i18n:** all user-facing strings live in `src/lib/i18n.ts` as `{ ur (roman Urdu), en }`.
  No hardcoded English in JSX; check both languages render.
