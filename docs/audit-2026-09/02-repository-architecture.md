# Phase 2 — Repository & Architecture Deep Audit

**Date:** 2026-09-02
**Auditor role:** Staff Software Engineer / Principal Architect (adversarial due-diligence posture)
**Scope:** Folder structure, layering, naming, component design, state management, data-access architecture, error handling, logging, type safety, testing strategy, build configuration, deployment/release train.
**Repo state audited:** branch `main`, HEAD `2248327` ("Daily Wisdom into center screen"), in sync with `origin/main`; working tree clean except untracked `CLAUDE.md` and this audit directory.

---

## Summary

Hisaab is one of the more disciplined solo-built React codebases I have audited: layering (pages → Zustand stores → a single DAL → Supabase) is genuinely enforced, TypeScript strictness is maximal with effectively **zero** `any` usage in 69k lines, pure money math is extracted to `src/lib/` with 90 colocated test files, and the repo documents its own past failures (`tasks/lessons.md`) — a rare maturity signal.

The weaknesses are structural, not cosmetic. The backend is 46 hand-applied SQL files with no migration runner and no recorded applied-state — a drift time bomb the repo's own memory admits is already live (multiple migrations "pending user apply"). All money-movement business logic executes **client-side** through a 2,202-line god store whose central `processTransaction` action is a ~640-line, 12-case switch coupled to five other stores; correctness under concurrency rests on a best-effort compensation pattern plus one optimistic-lock RPC. Observability is thin exactly where the stakes are highest: **zero** `reportError` calls in the entire store layer. And the logout cleanup list has already drifted — three stores with user financial data (`budgetStore`, `recurringStore`, `remittanceStore`) are never reset on sign-out, the precise cross-user leak class the file's own comment promises to prevent.

**Scores: architecture 7, maintainability 6, scalability 5, techDebt 6.**

---

## Strengths (honest, brief)

1. **Layering is real, not aspirational.** All entity access goes through `src/lib/supabaseDb.ts` (2,236 lines, 34 exported per-entity DAL objects, `supabaseDb.ts:28-2173`). A repo-wide grep for direct Supabase client imports outside `lib/`/`stores/` finds exactly **one** page: `src/pages/AuthPage.tsx` (auth flows only — defensible). Stores never import Dexie directly; only `resetAllStores.ts`, `mirrorCache.ts`, and `outboxRunner.ts` touch `src/db/database.ts`.
2. **Type discipline is exceptional.** `tsconfig.app.json:24-30` enables `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`. Grep across `src/`: **0** real `as any` (the two matches at `GroupDetailPage.tsx:210,558` are the English words "has any" in comments), **0** `: any`, only 7 `as unknown as`. CI enforces `tsc -b` (` .github/workflows/ci.yml:26-27`).
3. **Money math is extracted and tested.** ~90 test files / 8,880 test lines colocated in `src/lib/` (splitMath, committeeDraw, conversionMath, repaymentAllocation, cardCredit, investmentMath…). The single split engine (`splitMath`) is genuinely reused by all split surfaces — `AllocateRepaymentModal.tsx`, `AllocateSettlementModal.tsx`, `SplitWithSheet.tsx`, `AddGroupExpenseModal.tsx`, `QuickEntry.tsx`, `RepaymentModal.tsx`, `HisaabAIPage.tsx` — no duplicated allocation math.
4. **The testing philosophy has quietly outgrown its own claim.** `vitest.config.ts:2-5` and `CLAUDE.md` say stores/DB are untested by design, but `src/stores/transactionStore.test.ts` is a 954-line suite that mocks the DAL and exercises the real Zustand store, including rollback-on-failure (`transactionStore.test.ts:1-14`, describe blocks at lines 233, 400, 635, 725, 769). The most dangerous code path has real coverage.
5. **Compensation pattern is thoughtfully documented.** `src/lib/mutationSafety.ts:1-14` explains the no-client-transactions problem, LIFO inverse execution, and honest acknowledgment that compensations themselves fail under the same outage.
6. **Self-documentation is unusually good.** `CLAUDE.md` (58 lines), `ARCH-RECON-hisaab.md`, `tasks/lessons.md` (distilled post-mortems, e.g. the 2026-07-18 "bulk repayment left no record" incident), `RELEASE.md` (347-line release runbook), 16 docs in `docs/`.
7. **Logging hygiene:** 0 `console.log` in production source (the 82 console hits are `warn`/`error`); `errorReporter.ts` is a clean abstraction with a real Sentry backend wired at boot (`src/main.tsx:7,16-18`, `src/lib/sentryReporter.ts`), env-gated by `VITE_SENTRY_DSN`, with PII-avoidance intent (`sentryReporter.ts:18`).

---

## Findings by severity

### CRITICAL

**C-1. Schema source-of-truth is 46 manually-applied SQL files with no runner, no applied-state ledger, and known live drift.**
Evidence: 46 `supabase-*.sql` files at repo root (count via `ls supabase-*.sql | wc -l`); `CLAUDE.md` §"Supabase migrations": *"There is no migration runner — the user applies them manually in Supabase Studio."* The project's own memory records at least three migrations still pending as of late July 2026 (connections-push-discovery, cross-user-account-effects, contacts-merge-unarchive). Nothing in the repo can tell you which of the 46 files production has actually run; there is no `schema_migrations` table, no numbering/ordering convention (names are semantic, not sequenced), and several files are *fix-of-a-fix* (`supabase-migration-fix-group-invite-join-rpc.sql`, `supabase-migration-fix-settlement-cancel-reject.sql`, `supabase-migration-fix-rls-recursion.sql`) whose correctness depends on apply order. For an app where RLS policies and SECURITY DEFINER RPCs *are* the security boundary and the money-integrity layer, an unverifiable production schema is a launch blocker for any diligence process. Verification scripts exist (`supabase-p0-security-verification.sql`, `supabase-safe-leave-group-verification.sql`) but nothing runs them automatically.
Fix direction: adopt `supabase db push`/CLI migrations or at minimum a numbered `migrations/` directory plus a version table, and run the verification SQL in CI against a shadow database.

### HIGH

**H-1. Logout cleanup has already drifted: three stores holding user financial data are never reset on sign-out.**
`src/stores/resetAllStores.ts:50-73` enumerates 21 store resets by hand, but omits `budgetStore`, `recurringStore`, and `remittanceStore` — all three of which define a `reset()` (`budgetStore.ts:33`, `recurringStore.ts:37`, `remittanceStore.ts:36`) that a repo-wide grep confirms is **never called from anywhere**. `resetAllStores.ts:3-6` promises "the next person who signs in on this device cannot see a millisecond of the previous user's accounts, loans, groups, activity" — yet user A's budgets and recurring/subscription templates survive in memory into user B's session on a shared device (a core persona: shared family phones in Pakistan). `resetAllUserStores` is the only cleanup path, called from every auth transition (`supabaseAuthStore.ts:48,77,91,99,128,164`). This is the classic hand-maintained-list failure mode: every new store silently widens the leak. Fix: a store registry (each store self-registers its reset) or an exhaustiveness unit test that imports every `src/stores/*Store.ts` and asserts membership.

**H-2. The store layer — where every money mutation lives — reports nothing to Sentry.**
`grep -rn "reportError" src/stores` → **0 hits**. Only 4 files in the app use the error reporter at all (`ErrorBoundary.tsx:3,27`, `errorReporter.ts` itself, `sentryReporter.ts`, `main.tsx`), plus 2 call sites in pages. A failed compensation rollback in `runSafeMutation` — the exact scenario `mutationSafety.ts:10-13` warns about, where "the user sees money vanish" — produces no telemetry unless the error happens to bubble uncaught to the window handlers (`errorReporter.ts:59-72`). Errors caught and toasted in pages (e.g. `QuickEntry.tsx:1036,1074,1126`) die silently from the operator's perspective. Given `CLAUDE.md` explicitly instructs "report through `reportError(err, context)`", the codebase does not follow its own stated convention. Combined with zero product analytics (Phase 1 finding), the operator will learn about money-corruption bugs from angry WhatsApp messages, not dashboards.

**H-3. `transactionStore.ts` is a 2,202-line god store; `processTransaction` is a ~640-line 12-case switch coupled to five sibling stores.**
Evidence: `wc -l` = 2,202 (next largest store is 1,198); `processTransaction` spans `transactionStore.ts:758-1401` with 12 `case` branches (expense, income, transfer, loans, cash advance, goals, three investment types…); the file contains **58** `*.getState()` cross-store calls (repo total: 376, of which 265 in `src/stores/`). `ensureSupportingStoresLoaded` (`transactionStore.ts:256-271`) imperatively hydrates account/loan/goal/EMI stores before any mutation — an implicit dependency graph invisible to the type system. Every new transaction type grows this function; every branch shares mutable locals (`transactionStore.ts:779-790`: `amount`, `currency`, `sourceAccountId`… reassigned per branch). The 954-line test suite mitigates but does not remove the risk: this is the highest-blast-radius file in the repo and it is structurally the hardest to review. Fix direction: extract each case into a pure `plan`-builder in `src/lib/` (returning row+delta descriptors) and keep the store as a thin executor — the codebase already has this exact pattern in its lib layer.

**H-4. The offline story is a half-wired scaffold contradicted by shipped UX.**
`src/lib/outboxRunner.ts:29` gates on `VITE_ENABLE_OUTBOX === 'true'`; line 157 throws `"Outbox dispatch not yet implemented for ${entry.kind}"` for outbox entries. The Dexie mirror cache (`src/lib/mirrorCache.ts`, 245 lines) is wired into only 4 of 30 stores (`accountStore`, `budgetStore`, `loanStore`, `transactionStore`); incremental sync (`getUpdatedSince`) is used by only 4 stores despite two dedicated migrations (`supabase-migration-incremental-sync-core.sql`, `-tombstones.sql`). Yet `OfflineBanner.tsx` ships and the Play listing markets offline capability (Phase 1 finding). Architecturally the risk is worse than "feature missing": partially-wired write mirroring is the classic source of split-brain bugs when someone later flips the flag. Either finish the outbox behind an integration-test harness or delete it and let `CLAUDE.md`'s honest note ("don't assume offline writes work") become the product truth.

**H-5. The release train has three unsynchronized tracks with no shared version gate.**
Track 1: web auto-deploys to Vercel on push to `main` (`CLAUDE.md` §Shipping rule; `vercel.json` is headers/rewrites only). Track 2: Android is a manual local Gradle build — `android/app/build.gradle:23-24` still reads `versionCode 1 / versionName "1.0.0"`, and the AAB build cannot even run in the development agent's sandbox (`CLAUDE.md`: "gradlew needs a localhost socket… the user runs it in their own PowerShell"). Track 3: schema changes are manual Studio pastes (C-1). Nothing prevents web shipping a feature whose RPC doesn't exist in production yet, or the Android bundle lagging weeks behind the PWA against the same database. There is no environment separation visible anywhere in the repo (one `.env`, no staging config, CI builds against dummy Supabase values — `ci.yml:36-40`) — meaning every migration is applied *first* to production, by hand. For a money app this is the single most fragile operational property.

**H-6. DAL derives identity from `localStorage`, not the auth session.**
`supabaseDb.ts:19-23`: every query scopes by `localStorage.getItem('hisaab_supabase_uid')`. RLS is the real enforcement (good), but this cache is writable by any XSS payload, any DevTools user, and goes stale across the multi-account transitions that `supabaseAuthStore` handles (six `resetAllUserStores` call sites at `supabaseAuthStore.ts:48-164` show how hairy those transitions already are). A stale uid yields silently-empty query results (`.eq('user_id', staleId)` returns `[]`, not an error) — the DAL would report "no accounts" rather than failing loudly. `supabase.auth.getUser()`/session state is the authoritative source and is already available on the same client object.

### MEDIUM

**M-1. Untyped Supabase row mapping — schema drift is invisible to the compiler.**
All 34 DAL objects map rows via hand-written mappers of shape `function mapAccount(r: Record<string, unknown>): Account` with per-field `as` casts (`supabaseDb.ts:1449-1464`). There are no generated types (`src/lib/supabase.ts` creates an untyped client — no `createClient<Database>`). Consequence: rename a column in migration SQL and `tsc -b` stays green while every read returns `undefined as string`. With 46 hand-applied migrations (C-1) this is the second half of the same drift bomb. `supabase gen types typescript` + a typed client would make CI catch it.

**M-2. Testing strategy has a shaped hole exactly one layer above the tested math.**
90 test files / 8,880 lines cover `src/lib/` pure functions plus three store suites (`transactionStore.test.ts`, `budgetStore.test.ts`, `recurringStore.test.ts`). Untested by design: the other 27 stores (including `splitStore.ts` at 1,198 lines — group money flows), the entire DAL, all 34 pages, and every RPC/RLS policy (no pgTAP, no SQL tests; only manual verification scripts). The repo's own post-mortem proves the risk is not hypothetical: `tasks/lessons.md:7-14` records that "unit tests of the pure math did not catch a record-keeping hole one layer up" (the vanished bulk-repayment records). The two-mode requirement (`full_tracker`/`splits_only`, `App.tsx:458-470`) doubles every path yet nothing automated walks both modes. The `transactionStore.test.ts` mock-DAL pattern already exists and is cheap to extend to `splitStore` — the marginal cost of closing the worst of this gap is low.

**M-3. Oversized page components carry business logic that belongs in lib/stores.**
`QuickEntry.tsx` 2,088 lines; `HomePage.tsx` 1,642; `InboxPage.tsx` 1,395; `AccountDetailPage.tsx` 1,268; `SettingsPage.tsx` 1,242; `HisaabAIPage.tsx` 1,237; `GroupDetailPage.tsx` 1,082 (per `wc -l src/pages/*.tsx`; pages total 26,333 lines vs components 70 files). Pages also make 44 direct `*.getState()` calls, bypassing subscription semantics. The hooks layer is nearly empty (4 hooks: `useAsyncLoad`, `useCountUp`, `useOnlineStatus`, `useReducedMotion`) — extraction pressure has gone into `lib/` (good) but not into hooks/feature components, so page-level flow logic (e.g. QuickEntry's mode-dependent submit guards, the exact class of bug in `tasks/lessons.md:21-28`) is untestable.

**M-4. Modal/sheet system is fragmented with visible sibling duplication.**
Four overlapping container primitives — `Modal.tsx` (104), `ConfirmationSheet.tsx` (140), `ConfirmDestructiveSheet.tsx` (146) plus 12 files hand-rolling `fixed inset-0` overlays. Naming/layering inconsistency: four modals live in `src/pages/` (`RecordTradeModal.tsx` 582, `RepaymentModal.tsx` 531, `EditGroupExpenseModal.tsx` 418, `AddGroupExpenseModal.tsx` 404) while their siblings live in `src/components/`. `AllocateRepaymentModal.tsx` (307) and `AllocateSettlementModal.tsx` (335) are near-twin allocation UIs over the same engine. This is exactly where a second contributor will pick the wrong primitive.

**M-5. Dead and dormant code paths persist in shipping surfaces.**
(a) `src/pages/PinLockScreen.tsx` has zero importers while Settings can still set `hisaab_pin_hash` (key listed at `resetAllStores.ts:43`) — the false-security-claim finding from Phase 1, restated here as dead code. (b) `onboardingStore.ts:19,96` exports `seedDemoData` — an action that would write fake accounts — with zero call sites in any `.tsx`. (c) The retired Remittances feature keeps a full store (`remittanceStore.ts`, 149 lines), a 438-line `RemittancesPage.tsx`, and a DAL object (`remittancesDb`, `supabaseDb.ts:2039`) behind a redirect (`App.tsx:478-480`). Dead money-writing code is a liability, not slack: one accidental import re-arms it.

**M-6. `CLAUDE.md` — the primary orientation document — is untracked.**
`git status`: `?? CLAUDE.md`; `git check-ignore` confirms it is not gitignored, simply never committed. The document that encodes the shipping rules, the two-mode invariant, and the migration process exists on exactly one laptop. Same class of risk (bus factor) as the unrecoverable Android keystore (`RELEASE.md` §1: "If you lose it, you can never update the app on Play").

**M-7. Store hydration uses `length === 0` as a loaded-flag — empty is indistinguishable from never-loaded.**
`ensureSupportingStoresLoaded` (`transactionStore.ts:256-271`) and QuickEntry's safety-net effects (`QuickEntry.tsx:169-173`) re-fetch whenever a store's array is empty. A genuinely account-less user (day-one, or `splits_only`) pays a redundant network round-trip on **every** transaction submit, and any code that trusts "loaded" semantics can loop. The comment at `QuickEntry.tsx` (near line 165) records a bug this pattern already caused ("the gate used to read an empty store and lie: 'You need an account first' with 13 accounts existing"). A `status: 'idle'|'loading'|'loaded'` field per store is the standard fix.

### LOW

**L-1. `i18n.ts` is a single 3,089-line file with ~1,740 keys** and no missing-key/parity check between `ur` and `en` (no test asserts both locales exist per key). One typo'd key ships silently as raw key text.

**L-2. Build config is minimal to a fault.** `vite.config.ts` is 7 lines — no manual chunking, no bundle-size budget, no PWA plugin (the service worker `public/sw.js` is hand-rolled, registered via `src/lib/serviceWorker.ts` from `main.tsx:5`). Lazy-loading of all 28 routes (`App.tsx`, 28 `lazy(` calls) is the only bundle discipline. No source-map upload to Sentry is configured, so production stack traces will be minified.

**L-3. ESLint is default-recommended only** (`eslint.config.js:20-25`: js/ts recommended + react-hooks + react-refresh) — no import-cycle rule, no `no-restricted-imports` fencing the layering that today survives on discipline alone (e.g. nothing mechanically prevents a page importing `./lib/supabase` the way `AuthPage.tsx` does).

**L-4. Stale debug artifacts at repo root:** `vite-loading-preview.err.log`, `vite-loading-preview.out.log`, `vite-pwa-test.err.log`, `vite-pwa-test.out.log` are committed clutter alongside the 46 SQL files, which themselves make the repo root a 60+-entry junk drawer.

**L-5. Deliberate error swallows are documented but scattered:** 13 `catch { /* … */ }`-style empty handlers across src (grep count), e.g. fire-and-forget loads at `QuickEntry.tsx:159` (`void loadGroups().catch(() => {})`). Each is individually defensible; collectively they are the places H-2's missing telemetry hurts most.

---

## Scores (1-10, 10 = pristine)

| Dimension | Score | Reasoning |
|---|---|---|
| **Architecture** | **7** | The layering is real and verified (one DAL, one direct-Supabase exception in `AuthPage.tsx`; stores never touch Dexie), the compensation pattern is honest about its limits, mode-gating is centralized in `App.tsx:458-470`, and lib-extraction of money math is exemplary. Docked for: all money orchestration living client-side atop a best-effort rollback (a ceiling no client pattern can raise — the durable fix is more Postgres RPCs), the `transactionStore` god-object (H-3), a half-wired offline layer that contradicts shipped UX (H-4), and identity-from-localStorage in the DAL (H-6). |
| **Maintainability** | **6** | Zero `any` in 69k lines, maximal strict flags, superb self-documentation (`CLAUDE.md`, `tasks/lessons.md`), 0 stray `console.log`, only 2 TODO markers. Docked for: seven pages over 1,000 lines with untestable in-page flow logic (M-3), a fragmented modal system with twin components (M-4), a 3,089-line i18n monolith (L-1), the hand-maintained reset list that has already drifted into a leak (H-1 — the proof that manual lists here don't hold), untyped row mapping that lets schema changes rot silently (M-1), and the orientation doc existing outside version control (M-6). |
| **Scalability** | **5** | Fine for the current single-developer, pre-launch, thousands-of-users horizon: RLS + Realtime + lazy routes will carry it. But every axis of growth hits a wall that is already visible in-repo: team scaling is blocked by the release train (no staging, prod-first manual SQL — H-5, C-1); data scaling is blocked by `getAll()`-shaped loads and `length===0` hydration (M-7) with incremental sync adopted by only 4 stores (H-4); feature scaling is blocked by the 12-case `processTransaction` switch (H-3) that every new money type must grow; and operational scaling is blocked by near-zero telemetry from the money path (H-2). |
| **Tech debt** | **6** | Marker debt is almost nil (2 TODOs, 7 `as unknown as`), the worst historical debts were actually paid down (credit-card model rebuild, split-engine consolidation), and dead code is bounded and known. Docked for: the migration pile with unknown production applied-state (C-1 — the largest single debt item and it compounds with every new file), the throwing outbox scaffold (H-4), dead money-writing paths kept live-adjacent (`seedDemoData`, `PinLockScreen`, remittances — M-5), the drifted reset list (H-1), and root-level log-file clutter (L-4). |

---

## Evidence-unavailable / further investigation

The following could **not** be determined from the repository and must be verified against live systems:

1. **Which of the 46 SQL files production Supabase has actually applied** — the central question of C-1. Requires running the verification scripts (`supabase-p0-security-verification.sql` etc.) in Studio against production. The repo's memory notes claim at least three migrations pending as of 2026-07-26; only Studio can confirm.
2. **Vercel project configuration** — environment variables (`VITE_SENTRY_DSN` set or not? `VITE_ENABLE_OUTBOX` off?), preview-deploy behavior, and whether previews point at the production database (if so, every PR preview is a production-data client).
3. **Sentry dashboard state** — whether the DSN is configured in production and what error volume the window-level handlers are actually capturing (H-2 predicts near-silence from stores).
4. **The production Android AAB's actual embedded web build version** vs current `main` — `versionCode 1` in `android/app/build.gradle:23` suggests no released update path has been exercised yet.
5. **RLS policy correctness under concurrency and cross-user flows** — policies live across many migration files; only live testing (or a shadow-DB pgTAP suite) can prove the composed result. Deferred to the Phase-3 security pass.
6. **Real-device behavior** of the Capacitor wrapper (keyboard, back-button, deep links from WhatsApp invite/witness links) — not determinable from source.
7. **Whether `git check-ignore` behavior for `CLAUDE.md` matches other machines** — the file may be committed on a different working copy; the audited clone shows it untracked (M-6).

**Recommended Phase-3+ follow-ups:** (a) DAL/RLS security pass focused on the SECURITY DEFINER RPC surface and the group/committee membership paths; (b) an integration-test spike using the existing `transactionStore.test.ts` mock-DAL pattern against `splitStore`; (c) a migration-consolidation exercise producing one canonical `schema.sql` + numbered increments; (d) the B4/B5/B7/B8 launch blockers from `docs/ux-audit-first-time-user-2026-07.md` that Phase 1 left unverified.
