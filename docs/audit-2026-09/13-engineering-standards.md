# Phase 13 — Modern Engineering Standards Review

**Repo:** Hisaab (PWA + Capacitor Android, Supabase backend)
**Date:** 2026-09-02
**Role:** Principal Engineer — comparison against modern production standards for a money app preparing for rapid growth, enterprise scrutiny, and investor due diligence.
**Scope note:** security is summarized here; the dedicated security report goes deeper. Analytics likewise references the dedicated analytics report.

---

## 1. Scorecard

| # | Dimension | Score (1–10) | One-line verdict |
|---|-----------|:---:|---|
| 1 | Scalability | **4** | Client-executes-everything architecture with unbounded first-load fetches; incremental sync mitigates but the ceiling is real |
| 2 | Security posture (summary) | **5** | Genuine RLS/RPC discipline undermined by manual migration drift, missing HTTP security headers, and a false PIN claim |
| 3 | Observability & monitoring | **3** | Clean Sentry abstraction, but nothing else: no uptime, no DB monitoring, no alerting, no structured logs, no native crash reporting |
| 4 | Analytics | **1** | Zero product analytics of any kind (see dedicated analytics report) |
| 5 | Accessibility maturity | **3** | Sparse ad-hoc ARIA, no a11y linting, no focus management, `lang="en"` on an Urdu-default app |
| 6 | Maintainability | **7** | Standout internal docs and consistent architecture; dragged down by god-files and 40 unversioned root SQL files |
| 7 | Testing | **5** | 868 fast unit tests including a real money-engine store suite — but no integration, E2E, RLS, or migration tests and no coverage tracking |
| 8 | CI/CD maturity | **3** | One solid quality-gate workflow; zero deployment automation, migration CI, or rollback story |
| 9 | Performance practices | **4** | Route-level code splitting and immutable caching exist; no budgets, no Lighthouse CI, no bundle tracking, 1.2 MB main chunk |
| 10 | Mobile experience engineering | **4** | Thoughtful Capacitor config and excellent release docs; no OTA updates, no native crash reporting, fully manual releases |
| 11 | Product maturity signals | **3** | Pre-revenue, pre-launch, no analytics, no feature flags, no experimentation surface |

**Overall:** a well-crafted solo/AI-paired codebase whose *code quality and documentation* are ahead of its stage, but whose *operational engineering* (deploy, observe, measure, roll back) is essentially absent. An enterprise or acquirer review would flag the operations column immediately.

---

## 2. Dimension-by-dimension evidence

### 2.1 Scalability — 4/10

**Architecture ceiling.** There is no custom server; every business rule executes in the browser. All entity access funnels through a single 2,236-line client gateway (`src/lib/supabaseDb.ts`, wc: 2236 lines) and money mutations rely on a *client-side* compensation pattern (`src/lib/mutationSafety.ts`) plus an optimistic-lock RPC. The money engine itself (`processTransaction`) lives in a Zustand store and is described by the repo's own test file as "the most critical piece of code in the app — every branch moves real money" (`src/stores/transactionStore.test.ts:1-4`). A client-resident money engine means a killed tab or webview mid-mutation leaves compensation half-applied — the mutation-safety pattern compensates only while the JS runtime survives.

**Full-table fetch on first load — HIGH.** `transactionsDb.getAll()` selects `*` for the whole user with no `.range()`/pagination (`src/lib/supabaseDb.ts:128-136`). Across the gateway there are **59 `.select(` calls and only 2 `.limit(` calls** (`src/lib/supabaseDb.ts:806`, `:1288` are the only limits). Supabase/PostgREST enforces a default max-rows cap (commonly 1,000) per request; with no pagination loop, a power user's transaction history past that cap would be **silently truncated** — in a finance app that is silent balance-history loss, not just slowness. Whether the project raised the cap in Studio is unverifiable from the repo (see §6). Severity: **high** (correctness + scaling wall combined).

**Mitigation that deserves credit.** A Dexie read-mirror with cache-first loading plus `updated_at`/`deleted_at` incremental delta sync is genuinely implemented and applied in production per the tracker (`src/lib/mirrorCache.ts:170` `loadCacheFirst`; `src/lib/supabaseDb.ts:137-155` `getUpdatedSince`/`getDeletedSince`; `docs/incremental-sync-tracker.md` — all core steps "Done"). After first load, refetch cost is bounded. This is real engineering, and it moves the score from 3 to 4.

**Boot fan-out — MEDIUM.** App boot eagerly loads ~11 domain stores regardless of route: persons, linked requests, settlement requests, contact links, notifications, accounts, groups, budgets, categories, committees, recurring templates (`src/App.tsx:268-316`). Realtime is a single per-user channel whose `postgres_changes` handlers trigger debounced *full store reloads* rather than row patches (`src/lib/realtime.ts:19-30, 50-69`). Fine at hundreds of users; at 10x–100x this multiplies Supabase read load per change event.

**No server escape hatch.** The only server-side compute is one edge function (`supabase/functions/push-notify`). Anything that must not run on an untrusted client (fraud checks, rate limiting beyond join codes, scheduled jobs, heavy reports) currently has nowhere to live.

### 2.2 Security posture (summary) — 5/10

Deeper treatment belongs to the dedicated security report; the standards-relevant highlights:

- **Real strengths:** RLS with WITH CHECK, FK hardening, balance optimistic-lock, and join-code rate limiting were applied in a deliberate hardening pass (`supabase-migration-prelaunch-hardening.sql`); SECURITY DEFINER RPCs mediate cross-user effects (e.g. `supabase-migration-cross-user-account-effects.sql`); Sentry is configured with `sendDefaultPii: false` (`src/lib/sentryReporter.ts:21`); Capacitor webview has `webContentsDebuggingEnabled: false` and `allowMixedContent: false` (`capacitor.config.ts:22-24`).
- **Migration drift — HIGH.** 40 root-level `supabase-migration-*.sql` files (shell count: 40) are applied *manually* in Supabase Studio with no ordering scheme, no applied-state ledger in the repo, and several believed pending per the project's own memory docs. The deployed schema is unknowable from the repo. For a money app this is the single largest enterprise-review red flag on the backend.
- **No HTTP security headers — MEDIUM.** `vercel.json` sets only cache headers and a SPA rewrite (`vercel.json:1-34`): no Content-Security-Policy, no HSTS, no X-Frame-Options/frame-ancestors, no Referrer-Policy — despite a code comment implying CSP exists ("CSP blocks an inline <head> script", `src/main.tsx:12`). Evidence of an actual CSP being served is absent from the repo.
- **False security claim — HIGH.** PIN lock is settable in Settings but `PinLockScreen` has zero importers while the store listing claims the feature (Phase-1 finding, re-verified there; cited as launch-blocker in `docs/ux-audit-first-time-user-2026-07.md`).
- **Committed live DSN — LOW.** `.env.example` ships a real Sentry ingest DSN, not a placeholder (`.env.example:7`). DSNs are write-only but this invites third-party event injection into the production Sentry project and signals loose secret hygiene.
- **No supply-chain controls.** No Dependabot/Renovate config, no `npm audit` step, no CodeQL/secret-scanning workflows (`.github/workflows/` contains only `ci.yml`).

### 2.3 Observability & monitoring — 3/10

- **What exists:** a clean reporter abstraction with a noop fallback (`src/lib/errorReporter.ts:18-40`), global `error`/`unhandledrejection` handlers (`src/lib/errorReporter.ts:59-72`), and Sentry init at boot when a DSN is present (`src/main.tsx:16-20`; `src/lib/sentryReporter.ts:8-28`) with 10% prod trace sampling (`sentryReporter.ts:17`). The interface takes feature/user/extra context — this is a good foundation.
- **What is missing (everything else):**
  - **No uptime monitoring** — no synthetic checks, no health endpoint, no status page anywhere in the repo.
  - **No DB monitoring or alerting** — nothing watches Supabase connection counts, RPC error rates, RLS denials, or the optimistic-lock retry rate; no PagerDuty/Slack/webhook alert config exists in the repo.
  - **No structured logging** — 82 raw `console.*` calls across `src` (grep count), including in the realtime reload path (`src/lib/realtime.ts:30`); no log levels, no correlation IDs.
  - **No native crash reporting — HIGH for a mobile-first app.** The Android wrapper has no Crashlytics or Sentry Android SDK (grep across `android/` for crashlytics/sentry: zero hits; `package.json:17-43` contains only `@sentry/browser`). A webview process crash, ANR, or plugin-layer failure on the primary target platform is invisible.
  - **No business-invariant monitoring** — nothing detects the failure class this repo has actually suffered (balance desync history per `project_creditcard_emi_desync` memory): no reconciliation job, no "sum of deltas ≠ balance" alarm.
- Severity: **high** overall — a money app with drifting-schema risk and a client-side compensation model needs invariant monitoring more than most, and has none.

### 2.4 Analytics — 1/10

No analytics SDK, no event taxonomy, no funnel instrumentation anywhere (`package.json:17-43` — no PostHog/Amplitude/Mixpanel/Firebase Analytics/GA; the only `src/lib/analytics.ts` is *financial charting* math for the in-app Analytics page, not product telemetry). Launch decisions (onboarding drop-off across the 6-step flow, mode-quiz outcomes, feature adoption of kameti/splits) will be made blind. See the dedicated analytics report. Severity: **high** for a product entering launch.

### 2.5 Accessibility maturity — 3/10

- **No a11y linting:** `eslint.config.js` extends only js/tseslint/react-hooks/react-refresh — no `eslint-plugin-jsx-a11y` (`eslint.config.js:19-24`).
- **Sparse ARIA:** 149 `aria-` attributes across 59 of ~150 TSX files (grep counts) — mostly ad-hoc `aria-label`s; the shared `Modal.tsx` has a single `aria-label="Close"` (`src/components/Modal.tsx:88`) and **no** `role="dialog"`, `aria-modal`, focus trap, or Escape handling (grep for `role=|onKeyDown|Escape|focus` in Modal.tsx: only line 88 matches).
- **Language mismatch:** `index.html:2` hardcodes `lang="en"` while the app defaults to Urdu (`src/lib/i18n.ts` — `ur` default per architecture); screen readers will announce Roman-Urdu text with English phonetics. Severity: **medium** given the target audience.
- No axe/pa11y/Lighthouse-a11y checks in CI (`.github/workflows/ci.yml` has none), no documented keyboard-navigation or contrast policy, no `prefers-reduced-motion` audit trail.
- Mitigating: the app is mobile-touch-first for a market where screen-reader use is lower, but a Play Store launch still faces Android accessibility scanner scrutiny and this is untested.

### 2.6 Maintainability — 7/10

**Strong — unusually so for the stage:**
- Layered internal documentation: `CLAUDE.md` (58 lines), `ARCH-RECON-hisaab.md` (97 lines of infra/security recon), `tasks/lessons.md` (47 lines of recorded failure lessons), `BACKLOG.md` (331 lines), plus operational docs (`docs/updating-the-android-app.md`, `docs/incremental-sync-tracker.md`, `RELEASE.md`). Most seed-stage teams have none of this.
- Consistent architecture: one DB gateway (`src/lib/supabaseDb.ts`), one Zustand store per domain (30 files in `src/stores/`), pure logic in `src/lib/` with colocated tests (45 test files in `src/lib/` alone).
- Code is heavily commented with *rationale*, not restatement (e.g. `vitest.config.ts:2-6`, `capacitor.config.ts:2-8`, `src/lib/sentryReporter.ts:4-7`).

**Weak:**
- **God files:** `src/lib/i18n.ts` is 3,089 lines and `src/lib/supabaseDb.ts` 2,236 lines (wc); every feature touches both, guaranteeing merge friction the day a second developer arrives. Severity: **medium**.
- **40 root-level SQL migration files** with no numbering, no ordering manifest, and no tooling (`supabase-migration-*.sql`, repo root) — reconstructing the schema requires archaeology plus the human who ran them. Severity: **high** (overlaps §2.2).
- **Commit hygiene is inconsistent:** recent history mixes disciplined messages with `Updates` and `Added contact improvement and Contact's integratons` (git log: `daee004`, `f67b7a8`).
- Root directory litter: stray `vite-*.err.log` / `vite-*.out.log` files committed at the repo root (repo root listing).

### 2.7 Testing — 5/10

**Better than its own description:** the config comment says "tests cover pure functions only" (`vitest.config.ts:2-6`), but `src/stores/transactionStore.test.ts` actually exercises the *real* Zustand money engine against an in-memory `supabaseDb` mock that honors the optimistic-lock semantics, including rollback-on-failure (`transactionStore.test.ts:1-30`, coverage list lines 6-15). ~868 `it(`/`test(` cases across 90 test files (grep/find counts) run in CI on every push (`ci.yml:31-32`). DST determinism is pinned via UTC setup (`vitest.config.ts:13-15`).

**Gaps that matter for a money app:**
- **No integration tests against a real Postgres/RLS instance** — acknowledged as deferred in `vitest.config.ts:3-5`. The RLS policies, SECURITY DEFINER RPCs, and triggers in 40 SQL files — the actual security and money boundary — have *zero* automated verification; the repo instead ships manual "verification" SQL scripts a human must run in Studio (`supabase-p0-security-verification.sql`, `supabase-safe-leave-group-verification.sql`, etc.). Severity: **high**.
- **No E2E tests** — no Playwright/Cypress anywhere (`package.json:45-65`); the 6-step onboarding, QuickEntry, and cross-user request flows are verified only by hand.
- **No coverage tracking** — no coverage config, no threshold, no reporter in `vitest.config.ts` or `ci.yml`.
- **No component/DOM tests** beyond a handful of logic-level `.test.tsx` files (5 in `src/components/`); the config explicitly notes happy-dom would be opt-in per file (`vitest.config.ts:9-10`).

### 2.8 CI/CD maturity — 3/10

**What exists:** one workflow, `ci.yml`, running typecheck → lint → unit tests → production build on push/PR to main with a 10-minute timeout and npm caching (`ci.yml:9-41`). Dummy env vars keep the build hermetic (`ci.yml:35-40`). This is a competent quality gate.

**What does not exist (the entire deployment half of CI/CD):**
- **No deploy gating:** Vercel deploys are driven by its own git integration, independent of CI status — no evidence in the repo of "CI must pass before deploy" (no Vercel ignore-build script, no deployment workflow). A red main branch can still ship to usehisaab.com. Severity: **medium** (unverifiable dashboard config — see §6).
- **No preview-environment checks:** no PR preview smoke tests, no Lighthouse-on-preview, nothing.
- **No migration CI — HIGH:** SQL is applied by a human pasting into Supabase Studio (`docs/incremental-sync-tracker.md:4` — "Abdullah runs Supabase migrations"; applied-state tracked only in prose tables, e.g. lines 14, 19). No `supabase db` CLI pipeline, no shadow-db validation, no drift detection.
- **No release automation for Android:** fully manual — hand-edit `versionCode` in `android/app/build.gradle`, hand-run Gradle in PowerShell, hand-upload the AAB (`docs/updating-the-android-app.md:30-51`). No CI signing, no fastlane, no internal-track automation.
- **No rollback story anywhere:** no documented web rollback (Vercel instant-rollback is unmentioned in any doc), no Android staged-rollout/halt procedure, and schema rollbacks are impossible to even define given no migration ledger.
- **No dependency automation:** no Dependabot/Renovate, no audit step (`.github/` contains only `workflows/ci.yml`).

### 2.9 Performance practices — 4/10

**Present:** genuine route-level code splitting — dist emits per-page chunks (AccountDetailPage, AnalyticsPage, etc. in `dist/assets/`); immutable far-future caching for hashed assets and no-cache for `sw.js` (`vercel.json:4-20`); a stale-chunk recovery mechanism wired into global error handlers (`src/lib/errorReporter.ts:62,69` → `notifyStaleChunkLoadError`, `src/lib/appRecovery.ts`, `src/components/GlobalChunkRecoveryOverlay.tsx`) — a real-world deploy-skew fix most teams learn the hard way; service worker with network-first navigation fallback (`public/sw.js:31-38`).

**Absent:**
- **No performance budgets, no Lighthouse CI, no bundle-size tracking** — `ci.yml` builds but measures nothing; `vite.config.ts` is 7 lines with no `manualChunks`, no `chunkSizeWarningLimit`, no analyzer (`vite.config.ts:1-7`).
- **Heavy chunks unmanaged:** main entry chunk is **1.2 MB** (pre-gzip), `jspdf` 392 KB, `AnalyticsPage` (recharts) 360 KB, `html2canvas` 196 KB, `jsQR` 128 KB (du over `dist/assets/`, total dist 3.6 MB). On the target market's low-end Android devices and 3G/4G networks, a 1.2 MB main bundle is a real first-load tax. Severity: **medium**.
- No Web Vitals / RUM collection (Sentry tracing sampled at 10% is the only signal, `sentryReporter.ts:17`, and no `browserTracingIntegration` is explicitly configured).

### 2.10 Mobile experience engineering — 4/10

**Present:** disciplined Capacitor config — https scheme for SW/crypto parity, mixed content off, webview debugging off, keyboard/status-bar/splash tuned, notification small-icon handled (`capacitor.config.ts:13-50`); best-in-class *written* release runbooks (`RELEASE.md`, `docs/updating-the-android-app.md`), including keystore-loss warnings (`RELEASE.md:19-21`).

**Absent:**
- **No OTA update mechanism — HIGH for a Capacitor money app.** The docs correctly identify the need and name Capgo/Appflow, but mark it "optional, post-launch" (`docs/updating-the-android-app.md:81-87`) and no updater plugin is installed (`package.json:17-43`). Consequence: every web bug fix — including a money-math fix — reaches Android users only after a Play review cycle plus user-driven store updates, while the PWA gets it instantly. The two surfaces *will* run divergent money logic against the same database for days at a time. The repo's own standing rule ("every app code change ships to BOTH web and the Android wrapper", memory `feedback_web_android_sync`) manages build parity but cannot manage *installed-base* parity.
- **No native crash reporting** (§2.3) — the platform where most users live is observationally dark below the webview.
- **No mobile CI:** the Android project is never built in CI (`ci.yml` runs web build only), so a Capacitor/Gradle breakage is discovered at release time on one developer's machine (`docs/updating-the-android-app.md:43-51` documents the manual PowerShell build).
- Single platform: no iOS story at all (no `ios/` directory), which caps the Gulf-expat market reach an acquirer would ask about.

### 2.11 Product maturity signals — 3/10

- **Pre-revenue with no monetization mechanism** — only a promise string in i18n (`src/lib/i18n.ts:475-476` per Phase-1) and a premium design mock.
- **Pre-launch:** Play Console setup, closed test, and security-verification SQL runs were open items in `docs/play-store-launch-tracker.md`; the repo's own July UX audit lists 8 launch blockers (`docs/ux-audit-first-time-user-2026-07.md`), several re-verified as still present in Phase 1.
- **No feature flags, no experimentation, no remote config** — the outbox's `VITE_ENABLE_OUTBOX` build-time env (`.env.example:9-11`) is the only toggle in the system; nothing can be dark-launched or ramped.
- **No analytics** (§2.4) — no way to measure activation, retention, or the mode-quiz split that shapes the entire product.
- **Listing/product truth gaps:** claimed currencies (USD/EUR/GBP) not in the type system (`docs/play-store-listing.md:35` vs `src/db/types.ts:1`), PIN claim vs no-op implementation — an acquirer's product diligence would treat these as integrity findings, not polish.
- Positive signals: the roadmap discipline (BACKLOG.md, statement-family plan, Monarch-inspiration tracker with 9 shipped items per memory) shows real product-management muscle for a solo operation.

---

## 3. Strong areas (with evidence)

1. **Internal documentation culture** — architecture recon, failure-lessons file, per-initiative trackers with owner/status tables (`ARCH-RECON-hisaab.md`; `tasks/lessons.md`; `docs/incremental-sync-tracker.md:5-24`). This is diligence-room-ready material most startups fabricate after the fact.
2. **Money-engine test suite with rollback coverage** — real stores + in-memory DB honoring optimistic-lock semantics, explicitly testing compensation ("Rollback restores source balance when the final write throws", `src/stores/transactionStore.test.ts:15`).
3. **Incremental sync done properly** — cache-first load, `updated_at` deltas, soft-delete tombstones, per-table sync status surfaced in Settings (`src/lib/mirrorCache.ts:170`; `supabaseDb.ts:137-155`; `docs/incremental-sync-tracker.md`).
4. **Deploy-skew recovery** — stale-chunk detection wired into both global error handlers with a user-facing recovery overlay (`src/lib/errorReporter.ts:62,69`; `src/components/GlobalChunkRecoveryOverlay.tsx`).
5. **Error-reporting abstraction** — swappable reporter with noop fallback, PII off by default, contextual tagging (`src/lib/errorReporter.ts:18-40`; `src/lib/sentryReporter.ts:21`).
6. **Hermetic, fast CI quality gate** — typecheck/lint/test/build in one 10-minute-capped job with dummy env injection (`ci.yml:12,35-41`).
7. **Sensible web delivery hygiene** — per-route chunks (`dist/assets/`), immutable asset caching + no-cache SW (`vercel.json:4-20`).

## 4. Weak areas (with evidence and severity)

| Finding | Severity | Evidence |
|---|---|---|
| Manual, unordered, unledgered SQL migrations (40 files) → deployed schema unknowable, several believed unapplied | **Critical** (launch blocker for enterprise review; drift can silently break money RPCs) | repo root `supabase-migration-*.sql` ×40; `docs/incremental-sync-tracker.md:4` |
| Unbounded `getAll()` fetches vs PostgREST row cap → silent history truncation for power users | **High** | `src/lib/supabaseDb.ts:128-136`; only 2 `.limit()` in 59 selects (`:806`, `:1288`) |
| Zero server-side/RLS/migration test automation; verification is human-run SQL scripts | **High** | `vitest.config.ts:3-5`; `supabase-p0-security-verification.sql` |
| No native crash reporting on the primary platform | **High** | no Crashlytics/Sentry in `android/`; `package.json:29` (@sentry/browser only) |
| No OTA update path → divergent money logic across installed base after every fix | **High** | `docs/updating-the-android-app.md:81-87`; no updater in `package.json` |
| No uptime/DB/invariant monitoring or alerting of any kind | **High** | absence across repo; only `sentryReporter.ts` |
| No product analytics | **High** | `package.json:17-43`; `src/lib/analytics.ts` is charting math |
| No deploy gates, no rollback documentation, manual Android versioning | **Medium** | `.github/workflows/` = ci.yml only; `docs/updating-the-android-app.md:30-51` |
| No HTTP security headers (CSP/HSTS/frame-ancestors) despite CSP-assuming comment | **Medium** | `vercel.json:1-34`; `src/main.tsx:12` |
| 1.2 MB main chunk, no perf budgets/Lighthouse/bundle tracking | **Medium** | `du dist/assets`; `vite.config.ts:1-7`; `ci.yml` |
| Accessibility: no jsx-a11y lint, no dialog semantics/focus trap, `lang="en"` on Urdu-default app | **Medium** | `eslint.config.js:19-24`; `src/components/Modal.tsx:88`; `index.html:2` |
| God files: i18n.ts 3,089 lines, supabaseDb.ts 2,236 lines | **Medium** | wc counts |
| Live Sentry DSN committed in `.env.example` | **Low** | `.env.example:7` |
| Commit-message hygiene; stray log files at repo root | **Low** | git log `daee004`/`f67b7a8`; `vite-*.log` at root |

## 5. Future risks

**What breaks at 10x users:**
1. **Row-cap truncation becomes routine** — active users cross 1,000 transactions within a year of daily use; their oldest history silently disappears from every device on next full refresh (`supabaseDb.ts:128-136`).
2. **Realtime reload amplification** — every write by any group/kameti peer triggers debounced store reloads on every connected member (`src/lib/realtime.ts:50-69` pattern); read volume grows superlinearly with group size × activity.
3. **Boot fan-out cost** — 11 eager store loads per session (`App.tsx:268-316`) against Supabase's connection/read quotas; no per-route lazy data loading.
4. **Support blindness** — with no analytics, no native crash reports, no invariant monitoring, and 10% trace sampling, the first sign of a money-corruption regression at scale will be angry users, exactly the failure mode this repo has already lived through once (credit-card desync history, memory `project_creditcard_emi_desync`).
5. **Single-human deployment bottleneck** — every schema change and every Android release passes through one person's hands and machine (`docs/incremental-sync-tracker.md:4`; `docs/updating-the-android-app.md:43-51`); bus factor 1 on the entire ops surface.

**What blocks an enterprise/acquirer review:**
1. **Schema provenance** — inability to prove which of 40 migrations are live in production; no reproducible environment. This alone fails most technical due-diligence checklists.
2. **Untested trust boundary** — RLS policies and SECURITY DEFINER RPCs (the entire multi-tenant isolation story) have no automated tests; the acquirer must re-audit from scratch.
3. **Claims-vs-reality gaps** — PIN, offline-first, currency list (Phase-1 findings) read as misrepresentation in a diligence context, however innocent the cause.
4. **No SDLC controls** — no branch protection evidence, no code review (solo direct-to-main commits), no dependency/secret scanning, no incident-response or rollback runbooks. SOC 2-style questionnaires would score near zero on change management and monitoring.
5. **Platform concentration** — Android-only native presence, Supabase-only backend with no abstraction for exit, Vercel dashboard state undocumented.

---

## 6. Evidence unavailable / further investigation

Cannot be determined from the repository; verify before relying on any conclusion above:

1. **Supabase Studio state:** which of the 40 migration files are actually applied in production; the PostgREST `max-rows` setting (determines whether the `getAll()` truncation risk is at 1,000 rows or higher); Realtime/connection quotas and current plan tier; whether Point-in-Time Recovery / backups are enabled.
2. **Vercel dashboard:** whether deployments are gated on CI, whether preview deployments exist, whether instant rollback has ever been exercised, custom headers configured outside `vercel.json`, and Web Analytics/Speed Insights toggles.
3. **Sentry project:** whether the DSN in `.env.example` is the production DSN, actual event volume, alert rules configured in the Sentry UI (none exist in-repo), and release/sourcemap upload (no sourcemap upload step exists in `ci.yml`, so stack traces are likely minified — worth confirming).
4. **GitHub settings:** branch protection on `main`, required status checks, secret-scanning/Dependabot toggles enabled at the org/repo level rather than via committed config.
5. **Real-device performance:** cold-start time and first-load cost of the 1.2 MB main chunk on representative low-end Android hardware and Gulf/Pakistan network conditions; no field data exists (no RUM).
6. **Play Console:** current release state vs `docs/play-store-launch-tracker.md` (the doc may be stale); staged-rollout configuration options.
7. **Keystore custody:** `RELEASE.md:19-21` warns about keystore loss; whether a backup actually exists is unverifiable and existential for Android updates.
8. **Load behavior at PostgREST row cap:** empirically confirm with a >1,000-row test account whether `transactionsDb.getAll()` truncates (recommended as the first follow-up experiment).
