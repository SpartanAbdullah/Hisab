# Phase 10 — Product Analytics Audit

**Date:** 2026-09-02
**Auditor role:** Growth/Product Analytics Consultant
**Repo state:** main @ 2248327 (2026-08-17), clean tree
**Scope:** Does Hisaab measure user experience at all? What exists, what it can answer, what it cannot — then a concrete, privacy-appropriate instrumentation design for launch.

---

## 1. Verdict up front

**Hisaab has zero product analytics.** No SDK, no custom event pipeline, no pageview counter, no feedback form, no NPS, no session recording, no feature-adoption or funnel instrumentation of any kind. The only telemetry that leaves the device is Sentry crash reporting — and even that is wired to just one in-app call site plus two window-level handlers, so it sees uncaught render crashes and nothing else. The repo's own Play data-safety doc states it plainly: *"Analytics: no product analytics SDK found"* (docs/play-store-data-safety.md:56).

**How does the team currently know users are successful?** They cannot. There is no signal for signups, onboarding completion, first-entry creation, retention, mode split, group joins, or kameti creation anywhere in the codebase.

**How do they know users are struggling?** Three narrow channels only:
1. Sentry — but only for uncaught render crashes and unhandled promise rejections (see §3).
2. A `mailto:support@usehisaab.com` link — shown only on the full crash screen (src/components/ErrorBoundary.tsx:40-41) and on public info pages (src/pages/PublicInfoPages.tsx:6). A struggling-but-not-crashed user has no in-app way to say so.
3. Whatever Play Console / Vercel / Supabase dashboards show out of the box (installs, HTTP traffic, auth-user counts) — none of which is visible in the repo and none of which answers a product question (see Evidence-unavailable).

A user who signs up, gets confused by the mode quiz, creates zero entries, and churns on day 1 is **indistinguishable from a user who never existed**. For a pre-launch app whose central product bet is an unusual two-mode onboarding fork (full_tracker vs splits_only, src/pages/OnboardingPage.tsx:78, 274-482) and a viral group-invite loop, launching in this state means the first launch teaches the team nothing.

---

## 2. Verification: no analytics SDK exists

**package.json (dependencies + devDependencies, package.json:17-70):** the only observability package is `@sentry/browser@^10.54.0` (package.json:29). There is no `posthog-js`, `amplitude`, `mixpanel-browser`, `@segment/*`, `@vercel/analytics`, `firebase/analytics`, `plausible-tracker`, `umami`, `matomo`, `hotjar`, `logrocket`, or any equivalent.

**Source grep (`posthog|amplitude|mixpanel|segment|gtag|plausible|umami|matomo|heap|hotjar|clarity|fullstory|logrocket` across src/):** every hit is an incidental English word — "plausible" in validation comments (src/lib/validateEmail.ts:3, src/lib/currencyValidation.ts:25), "heap" in prose comments (src/pages/HomePage.tsx:151, src/lib/recurringRunner.ts:19), "Segment"/"segmented" meaning UI segmented controls (src/pages/LoansPage.tsx:179, src/pages/TransactionsPage.tsx:409). The single real mention is a comment listing PostHog as a *possible future backend* for the error-reporter abstraction (src/lib/errorReporter.ts:2). A comment in splitStore mentions "telemetry parity" but refers to keeping a field for code-path symmetry, not to any telemetry system (src/stores/splitStore.ts:878).

**index.html:** no analytics `<script>` tag; the only external resources are Google Fonts (index.html:47-49). **The CSP actively forbids analytics**: `script-src 'self'` and a `connect-src` allowlist of only self, `*.supabase.co`, Sentry ingest hosts, and localhost (index.html:22). Any analytics SDK added without editing this meta tag would **fail silently** — requests blocked by CSP produce no user-visible error. This is simultaneously good security hygiene and a footgun for whoever adds instrumentation later (see F4).

**vercel.json:** headers and SPA rewrites only (vercel.json:1-30); no analytics configuration, and `@vercel/analytics` is not installed, so Vercel Web Analytics is not injected from the codebase.

**Android wrapper:** no Firebase Analytics / Google Analytics artifacts found in android/ config greps; push uses `@capacitor/push-notifications` (package.json:22) with FCM for delivery only.

**No trackEvent/logEvent/telemetry function exists anywhere in src/** (grep: zero call sites).

---

## 3. What DOES exist, and what it can and cannot answer

### 3.1 Sentry crash reporting (src/lib/sentryReporter.ts + src/lib/errorReporter.ts)

- Initialised at boot from `VITE_SENTRY_DSN` (src/lib/sentryReporter.ts:8-10, wired in src/main.tsx:18-20); returns null and falls back to a console-only noop reporter when unset (src/lib/errorReporter.ts:23-34).
- Privacy posture is deliberately conservative: `sendDefaultPii: false` (src/lib/sentryReporter.ts:21), and although the `ErrorContext` interface supports `userId` (src/lib/errorReporter.ts:13), **no call site ever passes one** — confirmed both by grep and by the repo's own disclosure (docs/privacy-data-safety-inventory.md:152).
- `tracesSampleRate: 0.1` in prod (src/lib/sentryReporter.ts:17) — nominal performance tracing, but no custom spans/transactions are instrumented anywhere, so this yields generic page-load traces at best.

**What Sentry can answer:** "did an uncaught exception white-screen someone, and where in the bundle?"

**What it cannot answer — and this is narrower than the team may believe:** `reportError()` is invoked from exactly **one** in-app location — the React ErrorBoundary (src/components/ErrorBoundary.tsx:27-30) — plus the two window-level handlers for `error` and `unhandledrejection` (src/lib/errorReporter.ts:59-72). **Zero store, DB-layer, or mutation-safety call sites exist** (grep for `reportError(`/`reportMessage(`: only ErrorBoundary.tsx and errorReporter.ts itself). Meanwhile the stores routinely catch and swallow failures to `console.error`, e.g. `console.error('logActivity failed in trackedCreateLoan (non-fatal)', err)` (src/stores/transactionStore.ts:342-344) — one of 8+ catch blocks in that file alone. **The money-mutation layer — the part of the app where a silent failure costs a user real trust — is invisible to Sentry.** A failed balance update, a compensation rollback firing, a Supabase RPC error surfaced as a toast: none of these produce any remote signal. The carefully built `feature`-tag context system (src/lib/errorReporter.ts:10-11) is effectively unused: the only feature tags that can ever appear are `react.render`, `window.onerror`, and `window.unhandledrejection`.

Sentry is an **error** tool regardless: even fully wired, it cannot answer a single product question (activation, retention, funnel drop-off, feature adoption).

### 3.2 src/lib/analytics.ts is NOT telemetry — do not be misled by the filename

`analytics.ts` is in-app spending aggregation **for the user's own charts**: `groupByCategory`, `monthlyTrend`, `dailySpending`, `topExpenses`, `groupSpendingByGroup` (src/lib/analytics.ts:23-85). It takes the user's local transaction array and returns chart data for AnalyticsPage. It sends nothing anywhere and measures the *user's money*, not the *product's performance*. Anyone grepping "analytics" and concluding the app is instrumented would be wrong; the distinction matters for this audit and for Play data-safety honesty (which the docs already get right, docs/play-store-data-safety.md:56).

### 3.3 Feedback collection: essentially none

Grep for feedback/NPS/survey/rating across src/ returns only CSS and code comments (e.g. src/index.css:458, src/pages/AddGroupExpenseModal.tsx:74). The only user-voice channels are the crash-screen prefilled mailto (src/components/ErrorBoundary.tsx:39-42) and the support address on public pages (src/pages/PublicInfoPages.tsx:6). There is no in-app "send feedback" entry point in Settings, no rating prompt, no NPS, no session replay.

### 3.4 Server-side proxies

Supabase tables (profiles, transactions, groups, committees…) could be queried manually in Studio for crude counts — signups, rows created. Nothing in the repo automates or dashboards this, and row counts cannot reconstruct funnels, sessions, or drop-off (an abandoned onboarding leaves at most a profile row; a QuickEntry abandoned at the numpad leaves nothing).

---

## 4. Findings (severity-tagged)

### F1 — HIGH: Launching with zero product measurement; the core product bets are unfalsifiable
No instrumentation exists for any step of activation (signup → onboarding steps 0-5 → mode selection → first account → first entry; src/pages/OnboardingPage.tsx:75, 144-482), for the group-invite loop (src/pages/JoinGroupPage.tsx), for kameti creation (src/pages/CreateCommitteeModal.tsx), or for retention. The two-mode fork is the app's most unusual design decision and its adoption split, mode-specific churn, and quiz-mislead rate will all be unknown at launch. Phase 1 flagged this; this phase confirms it exhaustively (§2). The repo's own July UX audit found 8 launch blockers by manual walkthrough (docs/ux-audit-first-time-user-2026-07.md) — post-launch, equivalent problems will only be discoverable the same slow, manual way, or via one-star reviews.

### F2 — HIGH: Sentry is blind to the money layer; one in-app call site total
`reportError` is called only from ErrorBoundary.componentDidCatch (src/components/ErrorBoundary.tsx:27) plus window-level handlers (src/lib/errorReporter.ts:61-71). Store catch blocks swallow to console (src/stores/transactionStore.ts:342-344 and throughout). Failed mutations, compensation rollbacks (src/lib/mutationSafety.ts flows), and RPC errors produce no remote signal. For a money app whose lessons file records silently-vanished payment records, "we only hear about uncaught render crashes" is a materially false sense of coverage. Fix is cheap: the abstraction already exists — add `reportError(err, { feature: ... })` beside the existing console.error lines in every store catch and inside runSafeMutation's compensation path.

### F3 — MEDIUM: No feedback channel for non-crashed users
The only way a confused-but-functioning user can reach the team is finding the support email on a public page (src/pages/PublicInfoPages.tsx:6). No Settings-level "feedback / report a problem" entry, no post-action micro-surveys, no NPS. For a launch into a WhatsApp-native audience, even a "Message us on WhatsApp" row in Settings would outperform silence.

### F4 — MEDIUM: CSP will silently kill any analytics added later
`connect-src`/`script-src` allowlists (index.html:22) block every third-party analytics host. Whoever adds instrumentation must extend the CSP in the same change or the SDK will no-op with no error — a classic "we shipped analytics but got zero events" failure. Flagging now so it's in the implementation checklist (§6).

### F5 — LOW: Live Sentry DSN committed in .env.example
`.env.example:8` contains a real DSN (`https://cec5f4a4...@o4511619171680256.ingest.de.sentry.io/4511619187736656`). DSNs are not secrets in the credential sense (they are visible in any shipped bundle), but a committed *example* file should hold a placeholder — anyone cloning the repo and copying the example will pollute the production Sentry project with local-dev noise.

### F6 — LOW: `tracesSampleRate: 0.1` buys nothing yet
No custom transactions/spans are defined (src/lib/sentryReporter.ts:17 is the only tracing config), so prod tracing spend yields only default page-load samples. Either instrument the few flows that matter (QuickEntry save, statement PDF generation) or set it to 0 until then.

---

## 5. The fix: analytics design for a privacy-sensitive Pakistani finance app

### 5.1 Framework recommendation

Constraints that shape the choice: (a) the app's public promise — *"lekin ads ya data bech kar kamai kabhi nahi hogi"* / never ads or data-selling (src/lib/i18n.ts:475-476) — and the no-custody trust positioning; (b) Play data-safety declarations must stay honest and are already carefully maintained (docs/play-store-data-safety.md); (c) no custom server exists and the team is small; (d) EU-region data residency is already the pattern (Sentry EU ingest, docs/privacy-data-safety-inventory.md:152); (e) audience is price-of-trust sensitive, not ad-targeted.

**Recommendation: PostHog, EU Cloud to start, with a documented self-host exit path.**
- Full event/funnel/cohort/retention product (Plausible/Umami are pageview counters — they cannot express "signup → first entry → D7" and are insufficient here; keep them off the table or use only as a marketing-site counter).
- EU Cloud (Frankfurt) keeps residency consistent with the Sentry posture; PostHog is open-source and self-hostable on a single VM if the team later wants zero third parties — that exit path is the honest answer to "privacy-sensitive," not a weaker tool.
- Free tier (1M events/month) comfortably covers a closed test and early launch.
- **Configuration is where privacy is won:** autocapture OFF, session recording OFF, `person_profiles: 'identified_only'`, no geolocation enrichment beyond country, EU host. Only explicit `track()` calls from our wrapper fire.
- The codebase already has the perfect integration pattern: mirror `errorReporter.ts` — a `src/lib/telemetry.ts` exposing `track(event, props)` with a noop default and `setTelemetry()` at boot (src/main.tsx:18-20 shows exactly where). This keeps the SDK swappable and makes "analytics disabled" (no key / consent declined) a first-class state, same as the Sentry DSN-unset path (src/lib/sentryReporter.ts:10).

**Runner-up:** self-hosted PostHog from day one (adds ops burden the team doesn't have today) or Aptabase (self-hostable, mobile-first, event-only, very light — viable if the team wants counts + simple funnels with minimal surface).

### 5.2 PII policy (non-negotiable rules for every event)

1. **Never send:** amounts, balances, person/contact names, phone numbers, note/description text, account names, group names, kameti names, free text of any kind, AI-entry raw input.
2. **Identity:** use the Supabase auth user id as the distinct id (already a first-party opaque UUID). No email, no name in person properties. This *is* a "User ID shared with a third party" under Play data safety — **docs/play-store-data-safety.md and docs/privacy-data-safety-inventory.md:148-152 must be updated in the same PR that ships the SDK** (both docs already anticipate re-disclosure).
3. **Properties are enums and buckets only:** currency *code* is fine; amount is not — if magnitude matters, bucket it (`<100 / 100-1k / 1k-10k / >10k` in account currency). Member counts capped at a bucket (`1,2,3,4,5,6-10,10+`).
4. **Consent:** a Settings toggle ("Help improve Hisaab — anonymous usage stats", ur+en strings in src/lib/i18n.ts), default ON with disclosure at onboarding's safety step (step 3 already talks trust — OnboardingPage.tsx:274) or default OFF if counsel prefers; either way the toggle must actually gate `track()` (the noop-reporter pattern makes this trivial) and persist to the profile so it holds across devices.
5. **CSP:** add the analytics ingest host to `connect-src` (index.html:22) in the same change (F4).
6. **Witness page caution:** kameti witness links are viewed by non-users (src/pages/KametiWitnessPage.tsx) — track only an anonymous `kameti_witness_viewed` with no identify call; never create person profiles for witnesses.

### 5.3 Top ~25 events (name → properties → where it fires)

Activation funnel:
| # | Event | Properties | Fire location |
|---|-------|-----------|---------------|
| 1 | `app_opened` | surface (pwa/android), language, app_mode, is_logged_in | src/main.tsx boot |
| 2 | `signup_started` | method | src/pages/AuthPage.tsx |
| 3 | `auth_completed` | method, is_new_user | AuthPage success path |
| 4 | `onboarding_step_viewed` | step (0-5) | OnboardingPage step transitions (src/pages/OnboardingPage.tsx:144-482) |
| 5 | `onboarding_mode_selected` | mode, quiz_intent (spending/loans/kameti/splits/budgets, src/pages/OnboardingPage.tsx:54-58), was_default_kept | OnboardingPage step 4 |
| 6 | `onboarding_completed` | mode, language, currency, created_first_account | OnboardingPage finish (src/pages/OnboardingPage.tsx:104) |
| 7 | `account_created` | account_type, is_first, source (onboarding/accounts_page) | AddAccountStepper |
| 8 | `quick_entry_opened` | source (fab/home) | QuickEntry mount |
| 9 | `entry_created` | entry_type (expense/income/transfer/loan/cash_advance/split), source (quick_entry/ai/recurring/group), is_first_ever, mode, currency | transaction/loan/split store success paths |
| 10 | `quick_entry_abandoned` | last_step, had_amount | QuickEntry unmount without save |

Loans / udhaar (cross-user loop):
| 11 | `loan_created` | direction (given/taken), linked_contact (bool), has_schedule, currency |
| 12 | `repayment_recorded` | consolidated (bool), settles_loan (bool) |
| 13 | `contact_link_requested` / 14 `contact_link_accepted` | via (code/phone) — ConnectByCodePage / InboxPage |

Group viral loop:
| 15 | `group_created` | member_count_bucket |
| 16 | `group_invite_shared` | channel (link/code/whatsapp) |
| 17 | `group_invite_opened` | is_authed (bool) — JoinGroupPage mount (src/pages/JoinGroupPage.tsx) |
| 18 | `group_joined` | via (link/code), time_since_invite_bucket |
| 19 | `group_expense_added` | split_type, participant_count_bucket |
| 20 | `settle_up_completed` | scope (group/adhoc), method (record_only/account_effect) |

Kameti:
| 21 | `kameti_created` | member_count_bucket, rounds, frequency — CreateCommitteeModal |
| 22 | `kameti_ballot_drawn` | member_count_bucket |
| 23 | `kameti_witness_viewed` | (anonymous, no identify) — KametiWitnessPage |

Engagement/infrastructure:
| 24 | `push_permission_result` | granted (bool), surface — src/lib/pushRegistration.ts:89,125 |
| 25 | `notification_opened` | type (reminder/inbox/loan) |
| 26 | `statement_shared` | doc_type (receipt/statement/settle_slip/kameti_slip), channel — statementPdf share paths |
| 27 | `ai_entry_submitted` | parsed_ok (bool), accepted (bool) — HisaabAIPage (no raw text!) |
| 28 | `error_surfaced` | feature — bridge from errorReporter so error rate joins product data |

Person properties (set once/on change): `app_mode`, `language`, `primary_currency`, `surface`, `push_granted`, `signup_week`, `acquired_via` (invite_link / witness_link / organic).

### 5.4 The 5 funnels + cohorts to watch at launch

1. **Activation:** `auth_completed` → `onboarding_completed` → first `entry_created` → `entry_created` on a later day within 7d. Target: identify the single biggest drop step in week 1. Break down by `mode` and `language`.
2. **Mode-fork health:** `onboarding_mode_selected` split; then D7 retention per mode, and % of splits_only users hitting redirected full_tracker routes (instrument the App.tsx:458-470 redirect as an event) — the direct measure of "did the quiz put people in the right mode."
3. **Group viral loop (k-factor):** `group_invite_shared` → `group_invite_opened` → `auth_completed` (new user) → `group_joined`. invites-sent-per-user × conversion = organic growth coefficient; this is the app's only growth engine.
4. **Kameti depth:** `kameti_created` → `kameti_ballot_drawn` → first payout recorded → `kameti_witness_viewed`. Kameti is the differentiator; measure whether created kametis reach round 1 or die as empty shells.
5. **Push opt-in → return:** `push_permission_result(granted)` rate by surface, then `notification_opened` → same-day `entry_created`. Determines whether the reminder engine (behavior-aware reminders work) actually drives the habit loop.

**Cohorts:** by `app_mode`; by `language` (ur default vs en); by `acquired_via` (invite-link joiners vs organic — expected to retain very differently); by `primary_currency` (AED Gulf expat vs PKR home) ; by push-granted vs denied. **Weekly retention curves per cohort are the launch dashboard.**

### 5.5 Implementation-effort estimate

| Work item | Effort |
|---|---|
| `src/lib/telemetry.ts` wrapper (noop + PostHog impl, consent gate, boot wiring mirroring errorReporter) | 0.5 day |
| CSP update + env plumbing + Capacitor smoke test on Android | 0.5 day |
| Instrument the ~28 events above (most are one line at an existing success path) | 1.5-2 days |
| Consent toggle in Settings + ur/en strings + onboarding disclosure | 0.5 day |
| Play data-safety + privacy-inventory doc updates (docs/play-store-data-safety.md, docs/privacy-data-safety-inventory.md) | 0.5 day |
| PostHog project setup, 5 funnels, retention dashboard, weekly email report | 0.5 day |
| **Total** | **~4-4.5 dev-days** |
| (Separately, F2 fix: `reportError` in every store catch + mutationSafety compensation path) | ~1 day |

Both fit before a closed-test launch and should land before it — a closed test with no instrumentation wastes the testers.

---

## 6. Scores (1-10)

| Dimension | Score | Basis |
|---|---|---|
| Product analytics coverage | 1 | Nothing exists (§2) |
| Error observability | 3 | Sentry wired but single call site; money layer dark (F2); privacy posture good |
| Feedback channels | 2 | Crash-screen mailto only (F3) |
| Privacy readiness for adding analytics | 7 | CSP allowlist, sendDefaultPii:false, honest data-safety docs, clean reporter abstraction — good foundations |
| Launch measurement readiness | 1 | No funnel, retention, or adoption signal possible today |

---

## 7. Evidence-unavailable / further investigation

Cannot be determined from the repository; state, do not guess:
- **Whether production `.env` on Vercel actually sets `VITE_SENTRY_DSN`** (only `.env.example:8` is visible; the real `.env` is untracked). If prod DSN is unset, even crash reporting is dark in production.
- **Vercel dashboard state:** whether Vercel Web Analytics / Speed Insights is toggled on server-side (not injected from this codebase, but Vercel can serve it independently for some plans). Check the Vercel project settings.
- **Sentry project state:** event volume, alert rules, whether anyone reviews it.
- **Play Console:** installs, vitals, pre-launch reports — external.
- **Supabase Studio:** whether anyone runs ad-hoc SQL counts as a stopgap; auth-user counts; Realtime usage.
- **Legal review** of default-on vs default-off consent for the analytics toggle under the audience's applicable regimes (PK PDPB status, UAE PDPL for Gulf users) — recommend counsel input before choosing the default.
- **Android build config** was only grep-audited for analytics artifacts; a full review of android/ Gradle dependencies for transitive Google Play Services measurement libs is worth a 15-minute check before declaring "no analytics" in the store listing.
