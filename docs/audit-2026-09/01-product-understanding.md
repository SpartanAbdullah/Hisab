# Phase 1 — Product Understanding (Hisaab)

**Audit date:** 2026-09-02
**Role:** Product Manager + UX Researcher (Phase 1 of 13-phase master audit)
**Sources:** repository only. Every claim cites file:line or file+section. Anything not determinable from the repo is listed under "Evidence unavailable."

---

## (a) Product summary

### Problem the app solves
Hisaab is a **no-custody money *tracker*** for Pakistani/Urdu-speaking users — primarily expats in the Gulf and their families back home — whose money life spans informal instruments that mainstream finance apps ignore: **udhaar (interpersonal loans/khata), kameti/committee (ROSCA savings circles), qist (instalments), group splits, and dual-currency (AED + PKR) living**. The app's own framing: "Hisaab is NOT a lender... We never hold, move, lend or transfer a single rupee or dirham. We only help you keep track" (docs/play-store-listing.md:60), and the onboarding tagline: "Loans, expenses, committees, splits — all in one place, all clear" / "Built for Pakistani expats — works in AED, PKR, and across GCC" (src/lib/i18n.ts:1308-1310, 1428-1430).

The core trust posture — "no bank passwords, no sync to break" — is a deliberate permanent constraint marketed as the promise (src/pages/OnboardingPage.tsx:158-160; i18n.ts:410-412). All data is manually entered or peer-shared; there is no bank integration, no payments, and no custom server (CLAUDE.md:7).

### Product category
Personal + **social** finance tracker (digital khata-book / Splitwise / envelope-budget / ROSCA-tracker hybrid). Play-listing title: "Hisaab: Khata & Expense Tracker" (docs/play-store-listing.md:15). Policy positioning is explicitly "no financial features" (docs/play-store-listing.md:141-145).

### Target users
From the listing ("students, families, freelancers, overseas workers, flatmates and anyone running a kameti or keeping a khata", docs/play-store-listing.md:62) and the July UX audit's persona set (docs/ux-audit-first-time-user-2026-07.md:8-11):

### Personas (grounded in repo evidence)
1. **Bilal — Gulf blue-collar worker, first finance app, Roman-Urdu-first.** Tracks cash wages, sends money home, needs offline entry on site (docs/ux-audit-first-time-user-2026-07.md:8, 178). Served by: full_tracker mode, cash accounts, Roman-Urdu default (`ur` default lang, CLAUDE.md:50), Quick Entry numpad.
2. **Imran — shopkeeper replacing a paper khata.** Udhaar ledger with non-app people, WhatsApp reminders, qist/EMI schedules (personas at ux-audit:8-10; WhatsApp reminder works for people without the app, ux-audit:272). Served by: Loans/khata pages, splits_only ledger mode (no accounts required — src/App.tsx:472-473 comment on modes), `wa.me` deep links (src/lib/whatsappReminder.ts referenced in docs/statement-family-build-plan.md:14).
3. **Ayesha — student/flatmate splitting rent and groceries.** Served by: groups with join codes (`/join/:token`, App.tsx:449), ad-hoc "split with people, no group" splits (commit 331a702; src/components/SplitWithSheet.tsx), splits_only mode.
4. **Khala Rubina — family kameti organizer.** Served by: Kameti pages with provably-fair draw + a public read-only witness link that needs no account (`/kameti/witness/` gate checked before every auth gate, src/App.tsx:390-396), payout slips (src/lib/kametiSlipPdf.ts).

(The ux-audit also names Sana, a USD-paid freelancer — notably *not* servable today; see Missing flows below.)

### Revenue model
**No-ads freemium, monetization deferred.** The only in-repo revenue statement is the Settings/about string: "Everyday tracking stays free, always. Premium extras may come later — but we will never make money from ads or from selling your data" (src/lib/i18n.ts:475-476). The listing repeats "No ads, ever" and "Free to start" (docs/play-store-listing.md:50, 53). A design mock for a "tasteful premium gate for advanced AI" exists (docs/design-extract/ai-tab-3.jsx:258), but **there is no payment integration, no plan/entitlement code, and no gated feature anywhere in src/** (grep for freemium/pricing/premium finds only design tokens and the promise string). Revenue today: **zero mechanism**. This is a pre-revenue product; the "premium AI" idea is the only sketched monetization path.

### Maturity stage
Pre-public-launch / closed-testing-era. Signed AAB built (docs/play-store-launch-tracker.md:35), but Play Console setup, screenshots, reviewer account, 14-day closed test, and several security-verification SQL runs were still ⏳/🚧 as of the tracker (docs/play-store-launch-tracker.md:30-51). 40 manually-applied migration files (repo root count) with several still pending user application per memory/trackers — schema drift risk is structural (CLAUDE.md:30).

---

## (b) User journey maps — top journeys

### J1. First run (sign-up → first screen)
1. **AuthPage** (email+password sign-up; Supabase Auth) → hard gate on `email_confirmed_at` shows `UnverifiedEmailScreen` with resend + "I've verified — log in" (src/App.tsx:87-158, 422-428).
2. **Onboarding** — 6 screens (src/pages/OnboardingPage.tsx):
   - Step 0 Welcome: brand, 4 trust bullets, **language picker (en/ur)** (lines 144-199).
   - Step 1 Name + primary currency from 8 supported (AED default) (lines 202-240).
   - Step 2 **Intent** — "what brings you here": spending / loans / kameti / splits / budgets; routes the landing page and leans the mode (lines 51-67, 242-270).
   - Step 3 Safety reassurance (5 "not a bank" bullets) (lines 273-310).
   - Step 4 **Mode quiz** → recommends `full_tracker` vs `splits_only`; user can override or skip (lines 312-427; src/lib/modeQuiz.ts).
   - Step 5 full_tracker: create first account (type/name/opening balance) or skip; splits_only: "fresh start" explainer (lines 429-544).
3. `completeOnboarding` persists name/currency/mode to profile, auto-creates a "Cash Wallet"/"Naqdee" starter account for full_tracker even when the account step was skipped (src/stores/onboardingStore.ts:71-79) — the July audit flagged this phantom account (ux-audit:129).
4. Landing: intent-routed (`/loans`, `/kameti`, `/groups`, `/budgets`, else `/`) (OnboardingPage.tsx:123-128).

**Friction risks:** onboarding-completed check treats `localStorage 'hisaab_onboarded'` OR account-count>0 OR profile flag as done (onboardingStore.ts:53-56) — a splits_only user on a device where the profile fetch fails falls back to localStorage; email-typo limbo and verification-handoff issues documented at ux-audit:138-141.

### J2. Log an expense
- **Entry point:** center FAB on BottomNav → `QuickEntry` modal, mounted globally (src/App.tsx:500-512; src/components/BottomNav.tsx:60-91).
- full_tracker types: expense / income / transfer / loan_given / loan_taken / group_expense (+ cash_advance when a credit card exists); splits_only shows only person_money + group_expense intents (src/pages/QuickEntry.tsx:182-206).
- Flow: numpad amount → type → account (with live "After: balance" preview; never strands an account-less user — ux-audit:267) → category/notes → save. Expense rows can be split ad-hoc via `SplitWithSheet` (QuickEntry.tsx:293; src/components/SplitWithSheet.tsx — resolved-to-the-cent shares, i_paid/they_paid directions).
- **Alternate path:** typed natural language ("karak 3 aed") lives in the **Hisaab AI tab** (`/hisaab-ai`, src/App.tsx:476), with a confirm-chip contract (ux-audit:266, 238-241). July audit flagged this headline feature as buried (ux-audit:141) — not verifiably fixed.
- **Receipt photo:** only attachable in `EditTransactionModal` (ReceiptField's sole consumer — src/components/ReceiptField.tsx used only by src/components/EditTransactionModal.tsx), i.e. edit-only, while the listing sells "receipt photos" at entry (docs/play-store-listing.md:33).

### J3. Split with a group
- **Create:** `/groups` (SplitsPage) → CreateGroupModal — members added **only by resolved Hisaab public code** (src/pages/CreateGroupModal.tsx:38-76); or via QuickEntry "Group expense" tile which chains CreateGroupModal → AddGroupExpenseModal preserving the typed amount (src/App.tsx:61-69, 525-545).
- **Join:** share/join code → JoinGroupModal on /groups, or invite deep link `/join/:token` (App.tsx:449) which is saved pre-auth and resumed post-login (App.tsx:190-194, 363-371; src/lib/pendingInvite.ts). Join is RPC-rate-limited (`join_group_by_code`, ARCH-RECON §3).
- **Add expense:** GroupDetailPage inline "+" or the QuickEntry path; optional "Paid from" account reconciles it into personal books.
- **Settle:** GroupDetailPage balances tab → SettleUpModal / GroupSettleUpModal (src/pages/GroupSettleUpModal.tsx; per-recipient WhatsApp card + settle-up-plan PDF per docs/statement-family-build-plan.md:57-65).
- **Escape hatch:** ad-hoc split without any group (SplitWithSheet from an expense; commits 331a702, 54b0700) — covers "split with contacts incl. non-app people by name," partially mitigating the July B6 blocker (groups themselves still require app users with codes; CreateGroupModal has zero guest-member support — grep for "guest" in CreateGroupModal.tsx returns nothing).

### J4. Lend / settle a loan (khata/udhaar)
- **Record:** `/loans` → AddLoanModal, or QuickEntry loan_given/loan_taken. In full_tracker a given loan debits a real account; in splits_only it is a pure ledger entry with both account ids null (CLAUDE.md:44-46; tasks/lessons.md:6-27 records past data-vanishing bugs here).
- **Linked contacts:** if the person is a connected Hisaab user, the loan can become a **linked request** the counterparty accepts/rejects in `/inbox` (tabs incoming/outgoing/info/action — src/pages/InboxPage.tsx:39), with cross-user account effects and a record-only default (memory: project_crossuser_account_effects; supabase-migration-cross-user-account-effects.sql).
- **Repay:** LoanDetailPage → RepaymentModal (direction-aware, hard overpayment block — ux-audit:271); lump-sum consolidated repayment allocates oldest-first across a person's loans (memory: project_consolidated_repayment; src/lib/repaymentAllocation.ts per tasks/lessons.md:31-35).
- **Instalments:** EMI schedules on loans (`emi_schedules` table, ARCH-RECON §1) with two-way settlement sync (supabase-migration-settlement-emi-and-account-guards.sql).
- **Social close:** WhatsApp reminder to non-app people; post-repayment statement/receipt nudge (docs/statement-family-build-plan.md:32-46).

### J5. Kameti (committee/ROSCA) cycle
- **Create:** `/kameti` → CreateCommitteeModal (amount, cadence, rounds, members by name/phone — no app account needed for members).
- **Draw:** organizer runs a **provably-fair ballot** (`runBallot`, commit-reveal seed; verification UI in src/components/CommitteeVerifyDraw.tsx, KametiDetailPage.tsx:9, 38).
- **Rounds:** per-round paid toggles (`setPaid`), payout confirmation (`confirmPayout`) auto-offers a payout-slip PDF (KametiDetailPage.tsx:40-41, 247; src/components/KametiPayoutSlipSheet.tsx).
- **Trust artifact:** `ensureShareToken` → **public witness link** `/kameti/witness/:token`, readable with no account, checked before all auth gates (src/App.tsx:390-396; src/pages/KametiWitnessPage.tsx).
- Post-creation member name/phone edits now exist (KametiDetailPage.tsx:58-70), addressing part of the July "nothing editable" finding; committee-level edits (amount, rounds, member exit) still absent from the store API surface (committeeStore selectors at KametiDetailPage.tsx:30-43 expose no updateCommittee).

---

## (c) Feature inventory with entry points

| Feature | Entry points | Mode availability | Evidence |
|---|---|---|---|
| Quick Entry (expense/income/transfer/loan/cash-advance/group-expense) | FAB on BottomNav (global); presets deep-link from other pages | Both (reduced type set in splits_only) | App.tsx:500-512; QuickEntry.tsx:182-206 |
| Natural-language entry + AI Q&A ("Hisaab AI") | Bottom-nav tab `/hisaab-ai` | Both (insight drill-down full_tracker only) | App.tsx:476-477; BottomNav.tsx:34-36 |
| Accounts (cash/bank/wallet/savings/credit card), grouped Wallets/Banks/Cards | Home cards → `/accounts`, `/account/:id`; onboarding step 5 | full_tracker only | App.tsx:458-459; db/types.ts:4 |
| Transactions history + edit + reconcile ring | Home → `/transactions`; account detail | full_tracker only | App.tsx:460; HomePage nav grep line 987 |
| Loans / khata / udhaar + EMI (qist) | Bottom-nav Loans tab (full) / Home cards (splits) → `/loans`, `/loan/:id` | Both | App.tsx:461-462; BottomNav.tsx:27-33 |
| Consolidated (lump) repayment across a person's loans | LoanDetailPage / person view → AllocateRepaymentModal | Both | tasks/lessons.md:31-35 |
| Linked contacts & connection requests (consent-based, QR/public code) | `/contacts`, ContactDetailSheet, `/u/:code` scanned-QR landing | Both | App.tsx:452-455; ConnectByCodePage |
| Cross-user linked loan & settlement requests | `/inbox` (incoming/outgoing/info/action tabs), bell badge | Both | InboxPage.tsx:39; App.tsx:266-287 |
| Group splits (join codes, invites, settlement, per-group settle-up PDF) | `/groups`, `/group/:id`, `/join/:token`; QuickEntry bridge | Both | App.tsx:447-449, 525-545 |
| Ad-hoc splits (no group) | expense flow → SplitWithSheet | Both | SplitWithSheet.tsx; commit 331a702 |
| Kameti / committees + provably-fair draw + witness link + payout slips | `/kameti`, `/kameti/:id`, public `/kameti/witness/:token` | Both (no accounts needed) | App.tsx:474-475, 390-396 |
| Budgets (envelope "left to spend") | `/budgets`; Home banner | full_tracker only | App.tsx:465; HomePage grep line 1098 |
| Subscriptions/recurring tracker (consolidated; never auto-posts) | `/subscriptions` (old `/recurring` redirects); RecurringDuePrompt global queue | full_tracker only | App.tsx:466-471, 513-515 |
| Savings goals (+ dated-goal coach) | `/goals`; Home card | full_tracker only | App.tsx:485-493 |
| Investments tracker (record-keeping, avg-cost, manual prices) | `/investments`, `/investment/:marketId/:symbol`; Home card | full_tracker only | App.tsx:469-470 |
| Analytics/Insights + category drill-in | `/analytics`, `/hisaab-ai/insight/:category` | Analytics both; insight drill full_tracker | App.tsx:450, 477 |
| Activity feed | `/activity` (splits-mode bottom-nav tab) | Both | App.tsx:456; BottomNav.tsx:30-31 |
| Monthly Wrap ("Spotify Wrapped") + shareable card | self-triggering modal, first session of month; AnalyticsPage share | Both | App.tsx:516-518; statement-family-build-plan.md:67-75 |
| Statements / payment receipts (bilingual PDF/WhatsApp) | LoanDetailPage → SendStatementModal; settle-up flows | Both | statement-family-build-plan.md:11-46 |
| Receipt photos on transactions | **EditTransactionModal only** (not entry flow) | full_tracker | ReceiptField.tsx sole consumer = EditTransactionModal.tsx |
| Upcoming expenses / bill reminders | Home → AddUpcomingExpenseModal | full_tracker | src/pages/AddUpcomingExpenseModal.tsx |
| Push notifications (FCM, 3-tier delivery) + Android local reminder engine | boot registration; Settings opt-in | Both (native only for local reminders) | App.tsx:244-251; docs/push-notifications-setup.md |
| Daily money-wisdom quote | self-triggering daily modal; Settings toggle | Both | App.tsx:519-521 |
| Data export/import (JSON) | Settings | Both | ARCH-RECON §3 backups; dataExport.ts |
| PIN lock (**set-only; never enforces**) | Settings → PIN setup | Both | SettingsPage.tsx:275-298; PinLockScreen.tsx has zero importers (grep) |
| Language toggle (roman Urdu default / English) | onboarding step 0, corner pill, Settings | Both | OnboardingPage.tsx:18-27, 174-192 |
| Account deletion (soft-delete RPC) + public legal pages | Settings → `/delete-account`; `/privacy`, `/terms`, `/contact` | Public, no login | App.tsx:563-580 |
| PWA install prompt + offline read mirror + offline banner | automatic | Both | App.tsx:441-443; ARCH-RECON §1 Dexie |

**Dormant/dead surfaces:** Remittances (route hard-redirects home, page file remains — App.tsx:478-480, src/pages/RemittancesPage.tsx); `seedDemoData` (no callers — src/stores/onboardingStore.ts:96, grep); offline outbox (all dispatch handlers throw behind `VITE_ENABLE_OUTBOX` — src/lib/outboxRunner.ts:26-29); i18n `onboard_bullet_4` unused by the 4-bullet welcome (i18n.ts:1444 vs OnboardingPage.tsx:157-164).

---

## (d) Navigation map — every route in src/App.tsx

**Pre-auth / public (bypass all gates):**
| Route | Reached by | Evidence |
|---|---|---|
| `/privacy`, `/terms`, `/contact` (+ `/support` alias), `/delete-account` | direct URL, Settings links (SettingsPage.tsx:1091-1130), Play-listing requirements | App.tsx:563-580 |
| `/kameti/witness/:token` | shared witness link (WhatsApp), no account needed | App.tsx:390-396 |

**Gate order:** loading → AuthPage (no user) → UnverifiedEmailScreen (`!email_confirmed_at`) → OnboardingPage (`!completed`) → app shell (App.tsx:404-437).

**Authenticated shell (BottomNav: full_tracker = Home · Loans · [+] · Hisaab AI · Groups; splits_only = Home · Activity · [+] · Hisaab AI · Groups — BottomNav.tsx:11-19):**

| Route | Element | How reached | Mode guard |
|---|---|---|---|
| `/` | HomePage | nav Home tab; logout reset (App.tsx:381-385); catch-all redirect | — |
| `/groups` | SplitsPage | nav Groups tab; onboarding intent 'splits' | — |
| `/group/:id` | GroupDetailPage | group card on /groups | — |
| `/join/:token` | JoinGroupPage | invite deep link (pre-auth saved, resumed post-login App.tsx:190-194, 363-371) | — |
| `/analytics` | AnalyticsPage | Home card (HomePage line 1112) | — |
| `/settings` | SettingsPage | Home avatar (App.tsx comment BottomNav.tsx:18-19; HomePage lines 482, 864) | — |
| `/contacts` | ContactsPage | Home cards (lines 644, 1127) | — |
| `/u/:code` | ConnectByCodePage | scanned QR / App Links from camera (App.tsx:453-455) | — |
| `/activity` | ActivityPage | splits nav tab; Home (lines 658, 1118) | — |
| `/inbox` | InboxPage | bell icon in page chrome (badge boot-loaded, App.tsx:277-287; HomePage line 1290) | — |
| `/accounts`, `/account/:id` | Accounts pages | Home account cards (lines 892, 1491) | full_tracker else → `/` |
| `/transactions` | TransactionsPage | Home (lines 987, 1563) | full_tracker else → `/` |
| `/loans`, `/loan/:id` | Loans pages | nav tab (full) / Home cards (lines 576-606, 1001-1039); intent 'loans' | both modes |
| `/budgets` | BudgetsPage | Home (1098); Settings (847); intent 'budgets' | full_tracker else → `/` |
| `/subscriptions` | SubscriptionsPage | Home (1106); Settings (860) | full_tracker else → `/` |
| `/recurring` | redirect → `/subscriptions` | legacy links | — |
| `/investments`, `/investment/:marketId/:symbol` | Investments pages | Home (1139, 1197) | full_tracker else → `/` |
| `/kameti`, `/kameti/:id` | Kameti pages | Home (1133); Settings (908); intent 'kameti' | both modes |
| `/hisaab-ai` | HisaabAIPage | nav tab | both |
| `/hisaab-ai/insight/:category` | InsightDetailPage | AnalyticsPage/AI drill-in | full_tracker else → `/hisaab-ai` |
| `/goals` | GoalsPage | Home (1090) | full_tracker else → `/` |
| `/remittances` | redirect → `/` | retired feature (App.tsx:478-480) | — |
| `*` | redirect → `/` | unmatched URLs (App.tsx:495-497) | — |

**Global overlays (route-less):** QuickEntry, AddGroupExpenseModal + CreateGroupModal chain, RecurringDuePrompt, MonthlyWrapModal, DailyQuote, PWAInstallPrompt, OfflineBanner, ConfirmDestructiveSheet, ToastContainer, GlobalChunkRecoveryOverlay (App.tsx:439-546, 550-561).

---

## Missing, confusing, and redundant flows

### Missing user flows (adversarial view)
1. **PIN lock has no lock screen — a security claim sold on the store listing is a no-op.** Settings lets users set/remove a PIN with a success toast (SettingsPage.tsx:275-298); `PinLockScreen` (src/pages/PinLockScreen.tsx:12) has **zero importers** anywhere in src/ (grep 2026-09-02) — unchanged since the July blocker B3 (ux-audit:66-71) while the listing still claims "Optional PIN lock" (play-store-listing.md:50, 103). **Severity: high** (false security promise; Play data-safety exposure).
2. **No offline write path, while the listing claims "Offline-first — log on the bus."** Outbox runner is still a scaffold whose handlers throw, gated off (outboxRunner.ts:26-29); listing claims persist (play-store-listing.md:43, 96). Bilal's core scenario remains impossible (ux-audit B2). **Severity: high** (broken headline claim for the primary persona).
3. **No USD/EUR/GBP** — `SUPPORTED_CURRENCIES = ['AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD']` (src/db/types.ts:1) vs the listing's "PKR, AED, USD, EUR & GBP" (play-store-listing.md:35, 88). Sana persona is excluded at minute one (ux-audit B1). **Severity: high** (false claim + excludes UK/US diaspora segment).
4. **No receipt attach during entry** — edit-only (ReceiptField consumer set), vs "receipt photos" in the listing (play-store-listing.md:33). **Severity: medium.**
5. **No guest members in groups** — CreateGroupModal adds only resolved public codes (CreateGroupModal.tsx:38-76). Ad-hoc splits (SplitWithSheet) now cover the non-app-flatmate case outside groups, but the *group* promise still silently requires everyone on Hisaab, and nothing says so. **Severity: medium** (was July blocker B6; partially mitigated, uncommunicated).
6. **No monetization flow at all** — no upgrade, entitlement, or payment path anywhere in src/ despite a "premium extras may come later" public promise (i18n.ts:475-476) and a designed premium gate (docs/design-extract/ai-tab-3.jsx:258). For diligence: revenue is aspiration, not implementation. **Severity: medium (business).**
7. **No committee-level post-creation editing** (amount/rounds/member exit) — member name/phone only (KametiDetailPage.tsx:58-70); a mistyped pool amount forces delete-and-recreate mid-cycle. **Severity: medium.**
8. **No in-app password change / primary-currency change surface confirmed** — primary currency is a one-shot onboarding decision (ux-audit:190-191 "no Settings row"); not re-verified fixed in SettingsPage grep. **Severity: low-medium.**
9. **No first-party analytics/telemetry** — no product-usage instrumentation exists (ARCH-RECON §3: no PostHog/Mixpanel/GA); the team cannot measure any of the journeys above. **Severity: medium** (flying blind at launch).

### Confusing flows
1. **"Record vs move money" ambiguity is the app's own #1 systemic theme** — goals deduct or don't depending on entry door, group "Paid from" books the full amount, bill "Done" records nothing (ux-audit:26-33, 127, 144-149). CLAUDE.md itself warns "this has silently vanished user payment records before" (CLAUDE.md:46). Partially addressed by the record-only defaults in cross-user effects (memory), but the July findings are not marked resolved anywhere in-repo.
2. **Two-mode routing asymmetry:** in splits_only, seven routes silently bounce to `/` (App.tsx:458-470, 491) — a user following a shared deep link (e.g. `/budgets` from a blog/screenshot) gets a silent redirect with no explanation.
3. **Mode + intent double-decision in onboarding:** Step 2 intent picks a leaning, Step 4 quiz re-asks essentially the same thing and can contradict it (OnboardingPage.tsx:51-59 vs 84-93) — two mode-influencing questions in one funnel is redundant cognitive load; kameti intent leans full_tracker (line 56) even though kameti needs no accounts (App.tsx:472-473).
4. **Onboarding-completed heuristic** ORs three signals including a stale localStorage flag (onboardingStore.ts:53-56) — a user who signed out mid-onboarding on a shared device can skip onboarding entirely on the next account (flag is device-scoped, not user-scoped).
5. **AI tab holds the headline entry method** ("plain words") while the FAB is a numpad — the flagship differentiator is one tab away from where users add money (ux-audit:141; BottomNav has no hint).
6. **Witness link vs group invite vs connect code vs join code** — four different share-token systems (`/kameti/witness/:token`, `/join/:token`, `/u/:code`, group join codes typed in-modal) with different rules; nothing in-product explains which is which.

### Redundant / overlapping flows
1. **Three ways to split an expense:** group expense (GroupDetailPage), QuickEntry group-expense bridge (App.tsx:61-69), ad-hoc SplitWithSheet on a plain expense — plus loans for 1:1 debts. The ledger concepts overlap (an ad-hoc split creates person balances that look like loans); no unified "who owes me" surface reconciles them except Contacts.
2. **Two AddGroupExpenseModal instances** live simultaneously (app-level + GroupDetailPage-local), acknowledged as intentional but fragile (App.tsx:534-537).
3. **Duplicate onboarding demo-data path** (`seedDemoData`, onboardingStore.ts:96-197) is fully implemented, calls real writes, and is dead code — a future accidental wiring would inject fake HBL/Mashreq accounts into a real profile.
4. **RemittancesPage.tsx + remittances data layer kept "dormant"** (App.tsx:478-480) — shipped code with no route, a maintenance and confusion tax.
5. **Subscriptions vs Upcoming Expenses vs Recurring** were consolidated (App.tsx:466-468) but Upcoming Expenses persists as a separate entity/modal (AddUpcomingExpenseModal.tsx) — "a bill I expect" can be modeled two ways.

---

## Evidence unavailable (cannot be determined from the repo)
- **Production reality of any claim:** whether the Play listing is live, which claims shipped in the store build, closed-test status, install counts, retention, DAU (docs/play-store-launch-tracker.md leaves Y6-Y11/T1-T5 open as of its last edit; no analytics exist in-code).
- **Whether pending SQL migrations were actually applied** in Supabase Studio (connections/push/discovery, cross-user account effects, contacts merge/unarchive, settlement-EMI — flagged pending in project memory; the repo has no migration runner or applied-state ledger, CLAUDE.md:30).
- **Actual user base / persona validation:** personas here derive from the repo's own July 2026 persona audit and listing copy, not from real user research artifacts (none exist in-repo).
- **Monetization decisions beyond the i18n promise string** — no pricing doc, no "no-ads freemium decision" document is present in docs/ (it is referenced only in project memory, which is outside the repo).
- **Whether the July UX-audit blockers (B1-B8) were formally triaged** — no tracker in-repo marks them fixed/waived; this report re-verified B1 (currency), B2 (offline), B3 (PIN), B6 (guests, partial) as still-present in code and could not re-verify B4, B5, B7, B8 within Phase 1 scope.
- Live behavior of push notifications, App Links (`/u/:code` from camera), and the Android wrapper on real devices.
