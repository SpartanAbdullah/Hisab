# Lessons

Rules I (Claude) must follow in this repo, distilled from corrections and near-misses.
Review at the start of every session.

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
