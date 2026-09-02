# Hisaab — Performance Audit (Phase 3)

**Date:** 2026-09-02
**Scope:** Frontend runtime & bundle, data-fetching architecture, database/query performance and scaling posture. One codebase, two surfaces (PWA on Vercel + Capacitor Android), no custom server — all load lands on Supabase (PostgREST + Realtime + Postgres).
**Method:** 3 independent finders → 2-round adversarial verification per finding → consolidation with citation spot-checks (mirrorCache.ts, realtime.ts, supabaseDb.ts, vite.config.ts, App.tsx, QuickEntry.tsx re-read on 2026-09-02).

**Verification labels:** `CONFIRMED` = survived 2 independent refutation attempts. `PLAUSIBLE (downgraded)` = 1 of 2 refuters upheld; re-checked and adjusted here. `UNVERIFIED` = citations spot-checked by the lead where load-bearing, but not adversarially refuted.

---

## Summary

Hisaab's performance posture is defined by one architectural decision — **"download everything, compute client-side, refetch on any signal"** — colliding with its own target market: budget Android phones on Gulf/Pakistani mobile data. The app has genuinely good bones (route-level lazy loading, a Dexie mirror cache with purpose-built incremental sync, a 500 ms realtime debounce, performance indexes), but each mitigation is defeated by an adjacent decision:

- The **incremental-sync machinery is voided by its own cache-invalidation call**: every money write deletes the sync cursor, so every entry triggers a full transactions-table re-download (H2).
- The **transactions pipeline is unbounded end-to-end** — no query limit, no pagination, no virtualization, client-side analytics over the whole array — so the app gets slower every month of faithful use (H3).
- **Every foreground event fires ~14–21 unthrottled queries**, doubled by duplicate focus/visibility listeners and tripled on Android (H4).
- The **entry bundle is a 1.15 MB monolith** (332 KB gzip) with no vendor splitting, fully invalidated on every deploy (H1).
- Realtime rides **postgres_changes on the highest-churn tables** with ~12 bindings per session — a documented Supabase scaling wall with no broadcast fallback (H5).

Because there is no server, every one of these multiplies directly into Supabase load and user data cost. At 10k MAU the focus-refetch pattern alone projects to millions of PostgREST requests/day, and an active 2-year user pays ~0.75–2 MB of JSON per expense entry.

One **critical cross-cutting finding** (shared-group records destroyed by account deletion) and one high correctness finding (currency CHECK constraints) surfaced during the database pass and are retained here with cross-references. One headline database finding (delete_current_user FK abort) was **refuted by live reproduction** and is excluded from the main report.

Nothing here is exotic: the fixes are overwhelmingly S/M effort, and several are one-liners (see Quick wins).

---

## Critical issues

### C1. Deleting a Hisaab account hard-deletes that user's expenses inside SHARED groups, silently rewriting other members' balances — `CONFIRMED` (cross-cutting: data integrity, reported under Database)

- **Evidence:** `supabase-schema.sql:212` (`group_expenses.user_id REFERENCES auth.users ON DELETE CASCADE`), `supabase-schema.sql:237` (`group_settlements` same), `supabase-migration-p0-launch-blockers.sql:129` (`delete_current_user` = `DELETE FROM auth.users`), `supabase-migration-safe-leave-group.sql:110-136` (member balances derived from these rows), `src/lib/supabaseDb.ts:1363` (client invokes the RPC).
- Group expenses/settlements are shared records that every connected member's balance is computed from. When one member deletes their account, the `auth.users` cascade physically removes every expense they authored from groups other people still use — no tombstone (the app's own `deleted_at` soft-delete machinery is bypassed), no group event, no notification. `leave_group` carefully blocks leaving with a non-zero balance; account deletion destroys the same records with zero checks. Verifiers found it **understated**: `split_groups.user_id` is also CASCADE (`supabase-schema.sql:194`), so a group *owner* deleting their account destroys the **entire group** for all members. The RPC's own comment (p0-launch-blockers.sql:125-128) claims shared references are "anonymized" via SET NULL — only audit columns are; the primary rows are destroyed.
- **Impact:** Silent cross-user money-record loss — the exact harm class the repo's own lessons file warns about. Promoted from high to critical under the audit scale (cross-user data loss / money corruption); both verifiers flagged "arguably critical".
- **Fix (M):** On user deletion, soft-delete or reassign authored rows in groups that still have other connected members (anonymized placeholder member); hard-delete only in solo groups. Change `split_groups.user_id` cascade to ownership transfer or group tombstoning.

---

## High-impact issues

### H1. 1.15 MB (332 KB gzip) monolithic entry bundle, no vendor splitting; every deploy invalidates the whole thing — `CONFIRMED` [Frontend]

- **Evidence:** vite build 2026-09-02: `dist/assets/index-Dd5g8xje.js` 1,152,419 bytes / ~330 KB gzip; `vite.config.ts:1-7` (spot-checked: 7 lines, react+tailwind plugins only, no `manualChunks`); `src/App.tsx:70-72` (spot-checked: eager imports of `QuickEntry` (2,010 lines), `AddGroupExpenseModal`, `CreateGroupModal`); `src/main.tsx:7` + `src/lib/sentryReporter.ts:1` (static `import * as Sentry from '@sentry/browser'` — the DSN check at line 10 gates init, not bundling); `src/lib/i18n.ts` (2,978 lines), `src/lib/supabaseDb.ts` (2,156 lines), `src/stores/transactionStore.ts` (2,011 lines) all in the entry graph.
- Route pages are properly `lazy()` (App.tsx:32-59) and heavy deps (jspdf 399 KB, AnalyticsPage 366 KB, html2canvas, jsQR) do split out — but the entry chunk still carries React+router, supabase-js, dexie, zustand, ~20 stores, the full DB layer, the whole bilingual i18n table, Sentry (even with no DSN), and three app-level modals. With no vendor chunk, any change to this huge shared graph rehashes the entire 1.15 MB (`vercel.json` immutable caching confirms the cross-deploy bust).
- **Caveat (verifier):** the Capacitor build bundles `dist` locally in the APK (`capacitor.config.ts:12`), so Android users pay parse/exec cost but not download. The PWA is still a first-class surface — group invite links, kameti witness links, and WhatsApp statement links all land web-first.
- **Estimated impact:** ~330 KB gzip download + 1.15 MB parse before interactivity, re-paid every deploy, on every acquisition-funnel entry point. On a 3G connection (~100 KB/s effective) that is 3–4 s of download alone.
- **Fix (M):** `manualChunks` (react / supabase / dexie vendors); dynamic-import Sentry only when a DSN is set; lazy-mount the three app-level modals behind their open flags.

### H2. Every money write voids the incremental-sync cursor → full transactions-table refetch per entry — `CONFIRMED` [Data-fetching]

- **Evidence (spot-checked):** `src/lib/mirrorCache.ts:233-236` (`markMirrorStale` deletes the entire `mirrorSync` row — both `lastSyncedAt` and `lastFullRefreshAt`); 29 `markMirrorStale` call sites across transactionStore/loanStore/accountStore/budgetStore (e.g. `transactionStore.ts:512/525/542`, `accountStore.ts:106`, `loanStore.ts:135`); `mirrorCache.ts:183-206` (cursor=0 → `needsFullRefresh` → full `fetchRemote`); `mirrorCache.ts:154` (`refreshMirrorIncremental` self-disables with no cursor); `src/lib/supabaseDb.ts:128-136` (fetchRemote = unbounded `select *`); `src/lib/realtime.ts:78-84` + `supabase-migration-linked-notifications-realtime.sql:130-146` (self-echo on the published transactions table triggers `loadTransactions` 500 ms after every local write).
- The repo built a full incremental-sync stack (`getUpdatedSince`/`getDeletedSince`, tombstones, `updated_at` triggers and indexes in `supabase-migration-incremental-sync-core.sql`/`-tombstones.sql`) — then defeated it. `mirrorPut` has already made the local mirror correct before `markMirrorStale` throws the cursor away, so the invalidation is redundant with respect to local state. The incremental path effectively only runs for users who read but never write.
- **Estimated impact:** a 2-year daily user (~1,500–4,000 rows) re-downloads ~0.75–2 MB of JSON per expense entry; at 5 entries/day that is 5–10 MB/day/user of pure waste — the dominant bandwidth, battery, and Supabase-egress cost of the app, growing linearly with account age. Loan/settlement flows stale multiple keys at once (full loans + accounts pulls too).
- **Fix (M):** replace `markMirrorStale`-after-write with `writeSyncState(key, row.updatedAt)` (advance the cursor — the mirror is already correct), or at minimum preserve `lastSyncedAt`/`lastFullRefreshAt` and clear only the freshness window. The realtime echo then becomes a cheap incremental diff.

### H3. transactions.getAll is unbounded end-to-end: no query limit, no pagination, no virtualization, client-side analytics over full history — `CONFIRMED` (merges 3 duplicate findings) [Data-fetching / Frontend / Database]

- **Evidence (spot-checked):** `src/lib/supabaseDb.ts:128-136` — `select('*')`, no `.limit()`/`.range()`; the only capped queries in the whole DB layer are activities and notifications at `.limit(100)` (`supabaseDb.ts:806, 1288`) — transactions, the fastest-growing table (self-described "the heaviest list in the app", `supabase-migration-performance-indexes.sql:64`), is the one without a cap. Callers: HomePage.tsx:146, TransactionsPage.tsx:206, AnalyticsPage.tsx:87, InboxPage.tsx:105, LoansPage.tsx:104, BudgetsPage.tsx:40, HisaabAIPage.tsx:111, and more.
- **Rendering:** `TransactionsPage.tsx:191` defaults `timeFilter` to `'all'`; `dayGroups` maps every row (281-305) and the JSX renders all of it (515-544) — no windowing, no load-more; search re-filters the whole array per keystroke (no debounce).
- **Aggregation:** `AnalyticsPage.tsx:91-119` computes all period/category/trend sums client-side over the full array — pagination cannot be added without also adding server-side aggregates.
- **Mitigation assessed and pierced:** the Dexie mirror serves cached rows instantly and would limit refetch frequency — but H2 voids the cursor on every write, so active users hit the full pull per write-then-view cycle anyway; and the mirror does nothing for the in-memory array size or the DOM node count, which grow without bound.
- **Estimated impact:** at ~1.5–2k rows/year of daily use, cold view = 0.75–2 MB transfer + thousands of DOM nodes committed; per-keystroke re-render of the full list on a budget WebView. Combined with H2 this is the app's scaling wall — the product gets measurably slower with faithful use, the inverse of what a daily-habit tracker needs.
- **Fix (L):** keyset pagination on `created_at` (mirror-backed), default time filter to a recent window, windowize the list, debounce search, move analytics sums to a SQL RPC or per-month materialized aggregates.

### H4. Refetch-on-focus storm: every foreground event fires refreshLiveData twice (three times on Android) with zero throttling — `CONFIRMED` (merges 1 duplicate) [Data-fetching]

- **Evidence (spot-checked):** `src/App.tsx:228-241` registers BOTH `visibilitychange` and `focus` handlers calling `resumeGlobalRealtime()`; `src/lib/realtime.ts:197-207` — no dedup/cooldown, and even with a healthy channel it unconditionally runs `refreshLiveData()` (line 206); `refreshLiveData` (184-193, re-read) = 6 parallel loads: notifications, linked requests, settlement requests, contact links, persons, `loadGroups` (itself 3–4 queries via `supabaseDb.ts:868-893` + `splitStore.ts:291`); `src/lib/nativeBridge.ts:83-99` — Capacitor `appStateChange` adds a third trigger plus `getSession` + `rescheduleNotifications`; `src/pages/InboxPage.tsx:115-119` adds its own focus listener; `pushRegistration.ts:77-86` adds bursts on push receipt/tap.
- None of the six stores hit has a freshness gate (the codebase HAS one — `loadCacheFirst`'s 2-min window — wired only to accounts/transactions/loans/budgets, none of which refreshLiveData touches). The 500 ms `scheduleReload` debounce covers only postgres_changes callbacks, not this path.
- **Estimated impact:** ~14–18 queries per web tab-return, ~21+ per Android app-switch (verifiers converged on 14–21; the original ~18–27 was a mild overcount). The core workflow is flicking between WhatsApp and Hisaab: at 10k users × ~20 foreground events/day × ~15 queries ≈ **3M+ PostgREST requests/day** from this pattern alone, plus battery/data cost and racing bursts on flaky networks.
- **Fix (S):** guard `resumeGlobalRealtime` with a last-run timestamp (skip < 15–30 s), and skip `refreshLiveData` entirely when the channel stayed healthy (a joined socket means no events were missed).

### H5. Realtime publication covers the highest-churn tables with ~12 postgres_changes bindings per session — a documented Supabase scaling wall — `CONFIRMED` (merges 1 duplicate) [Database / Data-fetching]

- **Evidence:** `supabase-migration-linked-notifications-realtime.sql:126-146` (adds loans, transactions, accounts to `supabase_realtime`); `src/lib/realtime.ts:49-154` (12 postgres_changes bindings on one channel, incl. duplicate from_/to_ pairs for 3 request tables because the filter DSL can't OR); `realtime.ts:211-223` (a 13th per-open-group channel); `realtime.ts:68-70` (in-code acknowledgment that every local write self-echoes).
- Supabase's postgres_changes pipeline evaluates each WAL change against subscriptions centrally on a single-threaded service; Supabase's own docs recommend Broadcast at scale. Every expense entry writes transactions AND accounts (2+ published WAL changes). `user_id=eq` filters bound delivery but the subscription-enumeration work scales with subscriber count. Aggravator: every delivered event triggers a full table refetch per client (H2), and self-echo doubles it. **Worse:** the recovery path `refreshLiveData` deliberately omits accounts/transactions/loans — a silently dropped money-table event has no recovery short of a page that refetches or a cold reload, so drops re-manifest as stale balances.
- **Evidence-unavailable:** the ~2k-concurrent breaking point depends on the Supabase plan/realtime config, not visible in the repo. The architecture has zero bounding mechanism regardless.
- **Fix (L):** move money-table change signaling to Realtime Broadcast (`realtime.broadcast_changes` from a trigger) or a per-user sync-hints row; keep postgres_changes only for low-churn tables.

### H6. Cross-user loan/settlement tables hard-code `currency IN ('AED','PKR')` while the app ships 8 currencies — linked udhaar fails with raw check violations for 6 of them — `CONFIRMED` (cross-cutting: correctness, retained here as launch-market blocker) [Database]

- **Evidence:** `supabase-migration-phase2b-linked-requests.sql:14`, `supabase-migration-phase2c-a-settlement-requests.sql:167`, `supabase-migration-fix-bidirectional-linked-settlements.sql:25` (all `check (currency in ('AED','PKR'))`, never widened by any later migration — verified by grep); `src/db/types.ts:1` (8 supported currencies); `src/lib/supabaseDb.ts:555-567` (insert passes `input.currency` straight through); `src/lib/linkedRequestBranch.ts:4-9` ("No cross-currency gate"); `QuickEntry.tsx:758-783` (full-tracker path un-gated), `AddLoanModal.tsx:98-116, 161` (un-gated in both modes; raw `err.message` shown).
- Enforcement is inconsistent: the splits-only QuickEntry branch and the sync-past-records flow gate client-side on `LINKED_REQUEST_CURRENCIES=['AED','PKR']` and degrade gracefully — but the **primary paths** (full_tracker FAB flow and the LoansPage Add Loan modal in both modes) send SAR/QAR/OMR/KWD/BHD/PHP straight to Postgres, which rejects with a check violation shown verbatim, and **no loan is recorded at all**.
- **Impact:** the flagship cross-user udhaar feature is dead on arrival for the Gulf-expat target audience outside AED, with a lost entry and a raw Postgres error after filling the whole form.
- **Fix (S):** migration widening both CHECKs to the SUPPORTED_CURRENCIES list (or a shared currency domain), plus a consistent client gate.

---

## Medium-impact issues

### Frontend

**M1. QuickEntry (2,010 lines) is permanently mounted with whole-store subscriptions to ~8 stores and no closed-state early return — `PLAUSIBLE, downgraded from high` (both refuters upheld mechanics; one showed the impact bounded).**
Evidence (spot-checked): `App.tsx:501-512` (always rendered); `QuickEntry.tsx:96-108` (no-selector `useAccountStore()`, `useTransactionStore()`, `useLoanStore()` ×2, `useGoalStore()`, `useEmiStore()`, `useUpcomingExpenseStore()`); single unconditional return at line 1171; `Modal.tsx:69` discards children only after construction. Any update to any of these stores — including `loading` flag flips from realtime echoes — re-executes the component body app-wide, including unmemoized `buildRepaymentGroups` twice + a sort (315-325) and `TX_TYPES`/`ALL_INTENTS` rebuilds (181-206). **Downgrade rationale:** JSX is step-gated (`{step === N && …}`) with step reset to 0 on close, so a closed render builds only the small numpad subtree; `payeeProfiles` IS memoized on transactions (437-441), so typing latency does not scale with transaction count; remaining work is loans-linear with trivial constants. Real waste (sub-ms per spurious render, many renders), not user-perceptible jank. Fix (S/M): `if (!open) return null` after hooks, selector subscriptions, useMemo the derived lists.

**M2. Chatty, partially duplicated cold boot: ~25–30 REST round-trips with profiles fetched 3×, committees loaded 2× (6 queries), and no mode gate — `PLAUSIBLE, downgraded from high` (merges 4 findings).**
Evidence (spot-checked App.tsx:266-331): boot fires persons, 3 request inboxes, notifications, accounts, groups (4 queries), budgets, categories, committees (3), recurring — concurrently (not serial), plus the auth waterfall: `supabaseAuthStore.ts:65-83` awaits `isDeletedProfile` (a rare-path guard) before publishing the session, serializing 2 RTTs ahead of everything; the profiles row is fetched 3× (`supabaseAuthStore.ts:33-41`, `onboardingStore.ts:42-45`, `supabaseAuthStore.ts:212-217`), and again on every auth event including hourly token refreshes (`supabaseAuthStore.ts:86-102`). HomePage then re-runs `committeeStore.loadAll` (`HomePage.tsx:153`; no freshness gate in `committeeStore.ts:53-65`) and adds transactions/loans/goals/upcoming/EMI/investments(×3). The boot effect has **no app-mode gate** — splits_only users (who have no accounts) still load accounts, budgets, categories, committees, templates (~8 wasted queries/boot; HomePage.tsx:139-141 shows the correct mode-gated pattern). **Downgrade rationale:** loads are parallel over HTTP/2; the four heaviest stores are mirror-cached so warm boots paint from Dexie; the persons-backfill duplicate only occurs until the first successful run per device (flag checked before the loads, `backfillPersons.ts:154-156`). Still: ~25 un-batched requests × every open × every user, with a triple profile read and a serial auth hop. Fix (L): 1–2 SECURITY DEFINER boot RPCs; dedupe the profile reads; freshness-gate committeeStore; mode-gate the boot loaders (S); parallelize the deleted-profile check (S).

**M3. 82 whole-store Zustand subscriptions across 36 files; zero `React.memo` anywhere — `UNVERIFIED`.**
Grep: `use[A-Za-z]+Store()` → 82 hits (e.g. TransactionsPage.tsx:181-184, HomePage.tsx:90-108, `Modal.tsx:18` — every mounted Modal re-renders when ANY modal opens/closes); `memo(` → 0 matches in pages/components. Zustand v5 no-selector hooks re-render on any state change, so one saved transaction cascades loading-flag flips through every mounted subscriber. Newer code uses selectors (HomePage.tsx:204-209 with the React #185 comment) — the pattern is known, just not applied. Fix (M): codemod to per-field selectors; memo list rows.

**M4. Recharts costs a 366 KB (106 KB gzip) chunk for four basic charts — `UNVERIFIED`.**
`dist/assets/AnalyticsPage-*.js` 366 KB; `AnalyticsPage.tsx:3`. Correctly lazy, but a 3G tab-open pays ~106 KB + parse behind a full-screen Suspense loader for chart shapes achievable in hand-rolled SVG at ~5% of the weight; re-downloads every deploy. Fix (L): lightweight SVG components or idle prefetch after home paint (S).

**M5. Service worker gives hashed assets no cache fallback and makes every navigation network-first — `UNVERIFIED`.**
`public/sw.js:43-46` (`/assets/` → bare `fetch`, no catch), 33-37 (navigate → network-first, fallback only to precached `/`), 1-11 (precache = icons+manifest). Offline, any lazy chunk not in the HTTP cache breaks the app — undercutting the offline positioning; online, every cold start is gated on the slowest network round-trip. Fonts excluded from runtime cache by the same-origin check (sw.js:55). Fix (M): cache-first for immutable `/assets/`, stale-while-revalidate navigations (or Workbox via vite-plugin-pwa).

### Data-fetching

**M6. GroupDetailPage fetches group_expenses 3× and group_settlements 3× per open; hot write paths re-hydrate members unconditionally — `UNVERIFIED` (merges 4 findings).**
`GroupDetailPage.tsx:237-255` (Promise.all of getGroupExpenses + getSimplifiedDebts + getPairwiseDebts + getSettlements); `splitStore.ts:1111-1119, 1173-1179` (each debt getter independently refetches both tables); `splitStore.ts:1052-1055` (addSettlement = 4 more fetches to validate one cap); `splitStore.ts:995` (deleteSettlement refetches ALL settlements to find one row); `supabaseDb.ts:868-893` (getAll downloads owned group rows twice); `splitStore.ts:210-215` vs 222-226 (hydrateGroup skips the warm-path check that getGroupOrFetch implements, on createInvite/addGroupExpense/deleteSettlement/joinGroup); every member realtime event re-runs loadGroups + the whole reload (GroupDetailPage.tsx:268-275). The debt math is pure (src/lib) and could run on rows already in hand; the in-flight-promise dedup pattern exists (`splitStore.ts:151-159`) but only for the dashboard. ~8–9 queries with triple-duplicate payloads per open of the app's most social surface. Fix (S/M): fetch once in reload(), pass arrays to the pure functions; route write paths through getGroupOrFetch.

**M7. Realtime handlers discard the delivered row payload and refetch whole tables; the notifications handler skips even the 500 ms debounce — `UNVERIFIED` (merges 2 findings).**
`realtime.ts:52-58` (loadNotifications called per event, no scheduleReload — a group fan-out burst fires one 100-row reload per insert) vs 71-153 (all other handlers debounced); all handlers ignore `payload.new/old` and trigger full store reloads, which for money tables compounds with H2 into full-table pulls. Fix (S for the debounce; M to apply payloads with refetch fallback).

**M8. Consolidated repayment is a sequential N+1 loop (~3 RTTs per loan) whose per-iteration latency defeats the realtime debounce — `UNVERIFIED`.**
`repaymentExecution.ts:57-79` (sequential loop; the non-atomic model is a documented honesty tradeoff), each iteration ≥3 serial hops (balance RPC → insert → awaited activity insert, `transactionStore.ts:299-303, 509-513, 1389-1394`); at N=10, 300 ms RTT ≈ 10–15 s of spinner, and because iterations take ~1 s the 500 ms debounce FIRES between them — full-table refetches (H2) run concurrently with the remaining writes on the same mobile uplink. Same shape in `settlementExecution.ts`. Fix (M): suppress reload handlers during batch mutations; long-term a single atomic allocation RPC.

**M9. Cache layer covers only 4 of ~15 mirrored tables; ten stores refetch unconditionally on every page mount, and the FAB fires an unconditional loadGroups per open — `UNVERIFIED` (merges 2 findings).**
`mirrorCache.ts:7` (CORE_MIRROR_KEYS = accounts, transactions, loans, budgets); `db/database.ts:159-195` declares Dexie tables for persons, emiSchedules, goals, splitGroups, groupExpenses, upcomingExpenses, recurring, activityLog — never wired to loadCacheFirst. InboxPage ≈15 queries/visit (InboxPage.tsx:101-112); LoansPage 7 stores; `QuickEntry.tsx:152-160`'s comment claims "loadGroups returns fast on a warm cache" but `splitStore.ts:283-299` has no cache — every FAB open issues 2 network queries on the app's hottest gesture. Fix (M): extend loadCacheFirst to the declared tables or add an in-memory freshMs gate; gate the FAB load on `groups.length === 0 || stale` (S).

**M10. User-perceived save latency includes awaited post-commit side effects — `UNVERIFIED`.**
`transactionStore.ts:1389-1394` (awaited activity insert after the money committed); `splitStore.ts:463-478, 480-610` (group mutations await fanOutGroupUpdate (2 inserts) then a full 4-query loadGroups the realtime subscription will re-fire moments later — createGroup ≈7 sequential hops before the modal closes). Fix (S): fire-and-forget the activity insert (already error-swallowed); optimistic patch + realtime reconcile for groups.

**M11. `ensureSupportingStoresLoaded` awaits four independent store loads sequentially before every transaction mutation — `UNVERIFIED`.**
`transactionStore.ts:256-274` (await loadAccounts → loadLoans → loadGoals → loadSchedules; call sites 759, 1402, 1804, 2075). Worst case ~4 serial RTTs (~1–2 s) of dead time before the first save after boot — on the exact interaction the product optimizes. Fix (S): `Promise.all`.

**M12. Unbounded full-history fetches on every other growing table — `UNVERIFIED` (merges 2 findings).**
`supabaseDb.ts:724-731` (emi_schedules: all rows, all statuses, incl. paid schedules of settled loans — loaded on Home/Loans/Inbox); 961-986, 1078-1100 (group expense/settlement balance scans include every group the user was ever in — settled year-old trip groups are pure constant-contribution waste); 1258-1265 (group_events: append-only, no LIMIT); 440-449, 528-537, 656-665 (three cross-user request tables accumulate terminal-status history forever, pulled at every boot AND every focus event per H4). Each grows monotonically; boot/focus payloads multiply silently over 1–2 years. Fix (M): status/date filters, exclude settled groups from balance scans, paginate history, cap group_events.

### Database

**M13. `apply_account_balance_delta` has no `deleted_at` guard and uses NUMERIC value-equality as its only lock — `UNVERIFIED`.**
`supabase-migration-prelaunch-hardening.sql:245-275`. (1) The RPC moves balance onto soft-deleted accounts (all reads filter them out → money vanishes from every total). (2) The optimistic lock compares a JSON-serialized JS float against NUMERIC — representation drift (e.g. direct `balance = balance - amount` writes in `phase2c-b-sender-opt-in.sql:232-235`) can wedge an account in permanent BALANCE_CONFLICT loops. Related: the conflict-retry path refetches ALL accounts and replaces store state mid-mutation (`accountStore.ts:136-145`), a state-clobber hazard during multi-leg transfers. Fix (S): `AND deleted_at IS NULL`; switch to a monotonic version column; single-row conflict refetch.

**M14. Soft-deleted rows accumulate forever; hot composite indexes are non-partial, so tombstones bloat every query — `UNVERIFIED`.**
`supabase-migration-incremental-sync-tombstones.sql:7-33`; `supabase-migration-performance-indexes.sql:69-70, 81-82` (`idx_transactions_user_created`, `idx_loans_user_created` not partial on `deleted_at IS NULL`); 8+ tables soft-delete-only with no purge job or retention policy anywhere in the SQL. Fix (M): pg_cron purge past all sync watermarks; partial hot indexes.

**M15. Kameti tables have no user_id index despite every query and every RLS policy filtering on user_id — `UNVERIFIED`.**
`supabase-migration-committees.sql:11-53` (only committee-scoped indexes), 63-72 (policies all `user_id = auth.uid()`); `supabaseDb.ts:1779-1783, 1847-1852, 1883-1887` (unbounded user_id reads). committee_payments grows ~1 row/member/round (a 20-member weekly BC ≈ 1,000+ rows/year); with no index each read is a sequential scan whose cost scales with total rows across ALL users. Fix (S): three indexes in a performance-indexes v2 file.

**M16. `join_code_attempts` is append-only with no TTL, no pruning, and no FK — rows accumulate forever and survive account deletion — `UNVERIFIED`.**
`supabase-migration-p0-launch-blockers.sql:200-213, 264, 288` (insert on every failure AND success; only the last 5 minutes are ever read); contrast `phone_lookup_attempts` which got both the FK cascade and a 1-hour self-prune (`connections-push-discovery.sql:315, 341-342`) — this table was forgotten twice. Orphaned rows also contradict the permanent-deletion privacy claim. Fix (S): mirror phone_lookup_attempts.

**M17. Client-writable notifications fan-out with no size/rate constraints; each insert fires a pg_net HTTP call — `UNVERIFIED` (also a security finding; cross-referenced to the security report).**
`supabase-schema.sql:455-465, 484-493`; `supabaseDb.ts:1292-1308`; `connections-push-discovery.sql:450-488`. Any group co-member can insert unlimited arbitrary-content notification rows per member, each triggering a pg_net POST → push. Performance angle: unbounded storage + pg_net queue churn under bulk inserts. Fix (M): SECURITY DEFINER RPC with rate limits + length CHECKs + retention.

**M18. No migration tracking at all; re-running `supabase-schema.sql` on a hardened DB would recreate dropped insecure objects — `UNVERIFIED` (primarily ops/security; performance angle: drift makes the index/sync migrations unverifiable).**
47 root-level SQL files applied manually; no schema_migrations, no CLI directory; `supabase-schema.sql:275-287` recreates the profile-lookup RPC that `p0-launch-blockers.sql:386` deliberately DROPs; the permissive group_members INSERT policy would be recreated too (schema:364-373 vs p0:150-161); `join_group_by_code` defined 3 competing times. Whether the incremental-sync and performance-index migrations are actually live is unknowable from the repo (see Evidence-unavailable). Fix (L): Supabase CLI migrations + canonical baseline + verification SQL in CI.

**M19. Data-integrity gaps that feed performance-relevant blast radius — `UNVERIFIED` (condensed; primarily correctness, cross-referenced).**
(a) Core money tables lack CHECK constraints (negative amounts, arbitrary type strings, unbounded client-minted TEXT primary keys that propagate into every FK/index/realtime payload) — `supabase-schema.sql:41-96` vs the constrained 2025+ tables. (b) Group membership exists twice (`split_groups.members` JSONB + `group_members` rows) with no consistency trigger; `paid_by`/splits member ids are dangling strings feeding cross-user balance math (`safe-leave-group.sql:110-125`). (c) `emi_schedules` has no FK to loans, no `deleted_at`, no `updated_at` trigger — excluded from incremental sync, so server-side EMI status writes can't reach cached clients incrementally (the repo's own EMI-desync history shows this class recurs). Fixes (S–M each): NOT VALID + VALIDATE constraint retrofits; drop the JSONB column; add the EMI FK + sync columns.

---

## Quick wins

| # | Fix | Effort | Source finding | Estimated impact |
|---|-----|--------|----------------|------------------|
| 1 | Debounce `resumeGlobalRealtime` (skip < 15–30 s since last run) + skip refetch when channel healthy | S | H4 | Eliminates ~14–21 queries per app switch; at 10k users ≈ millions of requests/day removed |
| 2 | Advance the sync cursor instead of deleting it in `markMirrorStale` | M (but 1-file) | H2 | Turns a 0.75–2 MB full pull per money entry into a ~1-row incremental diff |
| 3 | Wrap notifications realtime handler in `scheduleReload` | S | M7 | Coalesces N 100-row refetches per fan-out burst into 1 |
| 4 | `Promise.all` the four loads in `ensureSupportingStoresLoaded` | S | M11 | Up to ~3 RTTs (~1 s) off first-entry save latency |
| 5 | Gate QuickEntry's per-open `loadGroups` on emptiness/staleness | S | M9 | 2 queries + a loading-flag render storm off every FAB open |
| 6 | `if (!open) return null` in QuickEntry + selector subscriptions | S | M1 | Stops app-wide body re-execution on every store update |
| 7 | Fire-and-forget the post-commit activity insert | S | M10 | 1 RTT off every save spinner |
| 8 | Mode-gate the boot loaders for splits_only | S | M2 | ~8 queries off every boot for the ledger-mode cohort |
| 9 | Parallelize `isDeletedProfile` with session publish; skip on TOKEN_REFRESHED | S | M2 | 1 RTT off time-to-first-data every launch; removes an hourly fleet-wide query |
| 10 | Indexes: committees ×3, `contact_link_requests(to_user_id, created_at)`, `transactions(related_loan_id)` partial, `phone_lookup_attempts(attempted_at)` | S | M15, L-tier | Prevents sequential scans as tables grow |
| 11 | Widen the AED/PKR CHECK constraints | S | H6 | Unblocks cross-user udhaar for 6 of 8 currencies |
| 12 | `join_code_attempts`: FK cascade + prune, mirroring phone_lookup_attempts | S | M16 | Caps an unbounded security table |
| 13 | Dynamic-import Sentry behind the DSN check | S | H1 | Removes the SDK from the no-DSN entry bundle |
| 14 | Fix `hasCache = rows > 0` → use the sync-state row | S | L-tier | Gives zero-data (new) users the freshness window they currently never get |

---

## Frontend section — posture summary

Route-level code splitting is done right and heavy deps (jspdf, html2canvas, jsQR, recharts) are correctly out of the entry graph. Everything else about the frontend runtime works against the low-end-device target: a 1.15 MB single entry chunk with no vendor splitting (H1), an always-mounted 2,010-line QuickEntry re-executing on every store change (M1), 82 whole-store subscriptions with zero memoization (M3), five intended lazy boundaries dead because the same modules are statically imported elsewhere — including native-only `notificationScheduler` riding in the web bundle (low; the build's own INEFFECTIVE_DYNAMIC_IMPORT warnings are being ignored, so **no bundle monitoring exists in CI**), a render-blocking Google Fonts stylesheet (low), a full-screen splash for every Suspense hit with no HomePage prefetch (low), and a service worker that deliberately caches nothing that matters (M5). The team demonstrably knows the right patterns (selectors with the React #185 comment, memoized payeeProfiles, step-gated JSX) — they are applied inconsistently, not unknown.

## Data-fetching section — posture summary

This is the weakest layer of the app. The architecture is "notification-only realtime + refetch whole tables," and its three costliest behaviors compound: writes void the incremental cursor (H2) → refetches are full-table (H3) → and refetch triggers are duplicated and unthrottled (H4, M7). The mirror-cache design is genuinely good — Dexie tables, tombstones, updated_at triggers, a freshness window — but covers only 4 stores (M9), never propagates background refreshes to the UI (low: `loadCacheFirst` writes fresh rows only to Dexie, so stale balances persist until the next explicit load — `mirrorCache.ts:193-204`), and treats empty results as no-cache so new users get zero caching (low). Multi-fetch duplication is endemic: profiles ×3 at boot (M2), committees ×2, group expenses/settlements ×3 per group open (M6), owned group rows downloaded twice per loadGroups (low). Per-device backfill bursts (up to 100 concurrent PATCHes, localStorage-only completion flag) add one-time boot pressure on exactly the oldest, heaviest accounts (low).

## Database section — posture summary

The schema shows two generations: 2025+ tables have enums, CHECKs, FKs, partial indexes, and self-pruning attempt ledgers; the original money tables have none of it (M19), and later features (kameti) never got the index pass at all (M15). Unbounded growth is the theme — no LIMIT on any heavy list (H3, M12), no tombstone purge (M14), append-only ledgers without TTL (M16), request-history tables that never shed terminal rows (M12). The realtime publication includes the hottest tables with no broadcast alternative (H5). Cross-cutting integrity findings surfaced here: the account-deletion cascade destroying shared group records (C1) and the AED/PKR CHECK freeze (H6). Operationally, the absence of any migration tracking (M18) means none of the index/sync findings can be confirmed against production. Low-tier items: AB-BA lock ordering in the accept RPCs (deadlock → raw 40P01 mid-consolidated-loop), the anonymous kameti witness RPC with no rate limiting or token-entropy enforcement, the hand-maintained 20-table "active profiles" RESTRICTIVE policy list that post-p0 tables never joined, and three index-coverage gaps on hot OR-scans and prune deletes.

---

## Low-severity findings (abbreviated; all `UNVERIFIED` unless noted)

1. **Render-blocking Google Fonts stylesheet**, 4 weights, excluded from SW cache (`index.html:45-47`, `sw.js:55`). Self-host Geist.
2. **MonthlyWrapModal** re-runs a full-history scan at app level on every transaction change to decide "no" 11 months of 12 (`MonthlyWrapModal.tsx:24-46`). Gate before compute.
3. **Background mirror refreshes never reach the UI** — fresh rows written to Dexie, discarded from Zustand (`mirrorCache.ts:193-204`, spot-checked). Return/callback the refresh.
4. **Five dead lazy boundaries** (INEFFECTIVE_DYNAMIC_IMPORT: supabase.ts, supabaseDb.ts, goalStore, transactionStore, notificationScheduler); add a bundle-size CI check.
5. **Single full-screen Suspense fallback + no HomePage modulepreload** — startup ≈3+ sequential RTTs of splash (`App.tsx:444-499`).
6. **Empty result sets never cached** (`mirrorCache.ts:181-189`, spot-checked: `hasCache = cached.length > 0`) — new users get the least caching.
7. **splitGroupsDb.getAll downloads owned rows twice** + 2-stage waterfall re-run on every write/member-event/focus (`supabaseDb.ts:868-893`).
8. **hydrateGroup ignores warm store copy** on 4 hot write paths (`splitStore.ts:210-215`).
9. **Balance-conflict retry refetches ALL accounts** and replaces state mid-mutation (`accountStore.ts:136-145`).
10. **Person-backfill**: localStorage-only completion flag → re-runs per device; up to 100 concurrent PATCHes (`backfillPersons.ts:21, 140-145, 237-265`). Server-side flag + batch RPC.
11. **isDeletedProfile re-queried on every auth event** incl. hourly token refreshes (`supabaseAuthStore.ts:86-102`).
12. **AB-BA deadlock window** in accept RPC lock ordering during mutual settle-ups (`cross-user-account-effects.sql:453-459`); canonical lock order.
13. **Anonymous kameti witness RPC**: no rate limit, no token-entropy enforcement (`committees-phase2.sql:18-28, 57`).
14. **Hardcoded 20-table RESTRICTIVE RLS list** — kameti/investments/categories/push tokens never joined the deleted-account gate (`p0-launch-blockers.sql:74-96`).
15. **Index gaps**: contact_link_requests history OR-scan, `transactions.related_loan_id`, phone_lookup_attempts global prune predicate (`connections-push-discovery.sql:57-61, 341-342`).
16. **splits_only boot loads full-tracker stores** — folded into M2.

---

## Refuted during verification

- **"delete_current_user cascade collides with ON DELETE RESTRICT FKs → account deletion aborts with a raw FK violation" — REFUTED.** Both refuters reproduced the exact schema topology (repo FK creation order and the reverse) in live Postgres 15 and 17: the multi-path cascade from `auth.users` succeeds because RI check events for deleted accounts rows are queued after the transactions-cascade events already in the statement's queue; RESTRICT's "immediacy" concerns transaction-level deferral, not intra-command cascade ordering. Sanity checks confirmed the RESTRICT FKs are live (direct account delete → 23503). Residual low-severity note only: a hypothetical future cross-user account reference would block deletion — no such write path exists. (The repo's own prior audit had flagged this as needing exactly this live test.)

---

## Evidence-unavailable / further investigation

The following cannot be determined from the repository and bound several findings' precision:

1. **Live Supabase Studio state** — which of the 47 manually-applied SQL files are actually live (project memory says several were pending). Every index/policy/publication/constraint finding is asserted from migration SQL, not the running instance. The incremental-sync queries may be running unindexed — or the sync migrations may not be applied at all.
2. **Real-device performance data** — no RUM, analytics, Lighthouse, or field TTI/INP/frame data exists anywhere in the repo. All device-impact statements are derived from bundle/query analysis.
3. **Production data volumes** — transactions/loans/committee row counts per user; scale estimates (1,500–4,000 rows ≈ 0.75–2 MB) derive from the product brief's "2 years of daily use" assumption.
4. **Supabase plan limits & realtime config** — max concurrent postgres_changes subscriptions, messages/sec, pool size; H5's breaking point depends on these. Also PostgREST `max-rows` (a default 1000 cap would *silently truncate* the mirror for heavy users — worth checking urgently given `replaceMirror` semantics).
5. **Vercel production config** beyond vercel.json; CDN behavior for stale hashed assets post-deploy.
6. **Android WebView version distribution**, which governs real parse cost of the 1.15 MB entry chunk on the native surface.
7. **Whether VITE_SENTRY_DSN is set in production** (tracing sampleRate 0.1 runtime overhead).
8. **PostgREST/API-gateway rate-limiting behavior** under the backfill's 100-concurrent PATCH bursts and the focus-refetch bursts.
9. **pg_net queue retention** for the notifications push trigger.
10. **On-device network waterfalls** (HTTP/2 reuse, gzip ratios, Capacitor WebView connection behavior) — boot cost is counted in round-trips; wall-clock impact needs device profiling.

**Recommended next steps:** (a) run the repo's own `*-verification.sql` files against production and diff against the migration set; (b) add minimal RUM (web-vitals → a Supabase table) before launch so every finding here becomes measurable; (c) land quick wins #1–#5 before any marketing push — they remove the two dominant per-user cost multipliers (focus storms and full-refetch-per-write) for roughly two days of work.
