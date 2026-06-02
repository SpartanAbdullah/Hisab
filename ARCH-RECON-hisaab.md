# Arch Recon — hisaab

## 0. Identity & deployment reality
- Type (marketing site / web app / API): Web app (PWA) + Android wrapper (Capacitor). No marketing site code in this repo; the app itself ships a few public marketing/legal pages (`/privacy`, `/terms`, `/contact`, `/delete-account`) via `src/pages/PublicInfoPages.tsx`.
- Language(s) & framework(s) + versions: TypeScript ~5.9.3, React 19.2.4, React Router 7.13.1, Zustand 5.0.12, Vite 8.0.1, Tailwind CSS 4.2.2, Capacitor 8.3.4, Supabase JS 2.100.0, Dexie 4.3.0, date-fns 4.1.0, recharts 3.8.0, Sentry browser SDK 10.54.0. Build target uses Vite + TS noEmit (build script `tsc -b && vite build`).
- Build tool & package manager: Vite (with `@tailwindcss/vite` and `@vitejs/plugin-react`). npm (lockfile is `package-lock.json`; CI uses `npm ci`).
- Is it deployed? Where (host)? Public URL if findable in config: Two surfaces.
  - Web: `VITE_PUBLIC_APP_URL=https://usehisaab.com` (referenced in `.env`, `.env.example`, and used to build canonical/OG URLs in `index.html` and invite/share links in `src/lib/collaboration.ts`). A `vercel.json` with SPA rewrites and cache-control headers is committed, strongly implying Vercel as the host, but the file does not pin a project name/team. UNKNOWN — needs dashboard/host check.
  - Android: Capacitor app `com.hisaab.app` ("Hisaab") wrapping the same `dist/` build. Distribution channel (Play Store internal track, closed test, public) UNKNOWN — needs dashboard/host check.
- Does it call any paid/metered external API (LLM, email, SMS, payments, storage)? List each + the file:line where it's called:
  - Supabase (DB + Auth + Realtime). Client created in [src/lib/supabase.ts:10](src/lib/supabase.ts:10). Auth e.g. [src/stores/supabaseAuthStore.ts:67](src/stores/supabaseAuthStore.ts:67). Realtime channel [src/lib/realtime.ts:45](src/lib/realtime.ts:45). All entity reads/writes go through [src/lib/supabaseDb.ts](src/lib/supabaseDb.ts).
  - Supabase Auth e-mail delivery (signup verification / password reset) — invoked via [src/stores/supabaseAuthStore.ts](src/stores/supabaseAuthStore.ts) calling `supabase.auth.resend` ([src/App.tsx:82](src/App.tsx:82)) and `supabase.auth.signUp`/`signInWithPassword`/`resetPasswordForEmail` (Supabase manages SMTP — built-in or custom is a dashboard setting; UNKNOWN — needs dashboard/host check).
  - Sentry browser SDK — optional, only initialised when `VITE_SENTRY_DSN` is set. Init at [src/lib/sentryReporter.ts:12](src/lib/sentryReporter.ts:12), wired in [src/main.tsx:11](src/main.tsx:11). Whether a DSN is configured in production UNKNOWN — needs dashboard/host check.
  - Google Fonts CDN (Geist family) — fetched in [index.html:25-27](index.html:25). Free, unmetered.
  - No LLM / SMS / payments / object-storage calls were found in `src/`.

## 1. The stack
- Frontend: React 19 + TypeScript with React Router 7 (`BrowserRouter`, lazy-loaded route components, see [src/App.tsx:25](src/App.tsx:25) onward). State management is Zustand — one store per domain under [src/stores/](src/stores/) (auth, accounts, transactions, loans, budgets, groups/splits, recurring, remittances, settlement/linked requests, persons, onboarding, app mode, UI, notifications, activity, EMI, goal, upcoming expense). Styling is Tailwind CSS 4 via the Vite plugin; design tokens live in [src/lib/design-tokens.ts](src/lib/design-tokens.ts). Charts use `recharts`. Internationalisation strings in [src/lib/i18n.ts](src/lib/i18n.ts) (default lang is `ur`).
- Backend / API: No server-side runtime in this repo. There are NO Vercel/Netlify serverless functions, no `/api` folder, no Supabase Edge Functions referenced from the client (`grep` for `supabase.functions.invoke` returned zero hits). Business logic lives in:
  - Client code (stores and `src/lib/*` helpers — balance arithmetic, settlement nudging, recurring-template expansion, monthly wrap math, trust scoring, two-phase compensating mutations in [src/lib/mutationSafety.ts](src/lib/mutationSafety.ts)).
  - Postgres RPCs invoked from the client (e.g. `apply_account_balance_delta` for optimistic-locked balance writes at [src/lib/supabaseDb.ts:80](src/lib/supabaseDb.ts:80), `join_group_by_code` for invite redemption — defined in `supabase-migration-*.sql`). These are SQL `SECURITY DEFINER` functions running inside Supabase Postgres.
- Database / storage:
  - Authoritative store: Supabase Postgres. Tables defined across `supabase-schema.sql` and 30+ migration SQL files at the repo root. ~21 tables in total: `profiles`, `accounts`, `transactions`, `loans`, `emi_schedules`, `goals`, `activities`, `upcoming_expenses`, `split_groups`, `group_expenses`, `group_settlements`, `group_members`, `group_invites`, `group_events`, `notifications`, `persons` (`supabase-migration-phase1-persons.sql`), `linked_transaction_requests` and `linked_settlement_requests` (Phase 2b/2c), `budgets`, `recurring_transactions`, `remittances` (Phase 3), `join_code_attempts` (rate-limit ledger, prelaunch-hardening).
  - Local store: Dexie/IndexedDB DB `HisaabDB:user:<uid>` (per-user, isolated; legacy `HisaabDB` cleanup helper at [src/db/database.ts:236](src/db/database.ts:236)). Schema versions 1→7 declared at [src/db/database.ts:100-195](src/db/database.ts:100). Phase 3 reshapes Dexie as a READ MIRROR + an `outbox` table for queued offline mutations (header comment at [src/db/database.ts:19-38](src/db/database.ts:19)). Per-table mirror cursors live in `mirrorSync`.
  - Other client storage: `localStorage` keys `hisaab_supabase_uid`, `hisaab_user_name`, `hisaab_primary_currency`, `hisaab_pin_hash`, `hisaab_identifier`, `hisaab_pending_invite`, `pwa-install-banner` flags, recurring-runner timestamps, monthly-wrap snapshots.
  - DB credentials are read only from `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` at [src/lib/supabase.ts:3-4](src/lib/supabase.ts:3). No service-role key is referenced anywhere in `src/`.
- Auth & permissions: Supabase Auth (email + password). Sign-up requires email verification — `App.tsx` hard-gates app access on `user.email_confirmed_at` and shows an `UnverifiedEmailScreen` ([src/App.tsx:72](src/App.tsx:72), [src/App.tsx:301](src/App.tsx:301)). After auth, an onboarding gate checks `profiles.onboarding_completed`. Account deletion is implemented as a soft-delete via the `account_soft_delete` RPC + a session-level `is_deleted` check ([src/stores/supabaseAuthStore.ts:33-57](src/stores/supabaseAuthStore.ts:33)).
  - Row-Level Security IS enabled. Policies are defined in code/migrations across `supabase-schema.sql` and 10 migration files (114 RLS-related statements counted via grep). Highlights:
    - `supabase-schema.sql`: per-table `ENABLE ROW LEVEL SECURITY` + initial `FOR ALL USING (auth.uid() = user_id)` policies on owner-scoped tables.
    - `supabase-migration-prelaunch-hardening.sql` (2026-05-26): re-issues every `FOR ALL` policy WITH CHECK (so UPDATE cannot re-assign `user_id`), adds FK `transactions.{source,destination}_account_id → accounts(id) ON DELETE RESTRICT`, adds `is_deleted` flag + soft-delete RPC, adds `apply_account_balance_delta` optimistic-lock RPC, adds DELETE policies on group children, drops a duplicate profile-lookup RPC that leaked the profile public code, adds the join-code rate-limit table + 5-minute window, locks UPDATE on `group_expenses` so rows can't be donated across groups.
    - `supabase-migration-fix-rls-recursion.sql`, `supabase-migration-fix-settlement-request-rls.sql`, `supabase-migration-notifications-rls.sql`, group/linked-request/persons phase migrations all add their own per-policy SQL.
- Cache / CDN:
  - `vercel.json` sets immutable cache for `/assets/*`, no-cache for `/sw.js`, 24-hour cache for `/manifest.json`, and a catch-all SPA rewrite to `/index.html`.
  - Service worker [public/sw.js](public/sw.js) (`hisaab-v4` cache) — pre-caches a small shell, network-first for navigations, bypasses cache for `/assets/*` (hashed bundles handle their own immutability), network-first-then-cache otherwise. Registered from [src/lib/serviceWorker.ts](src/lib/serviceWorker.ts); skipped on Capacitor/native to avoid stale-bundle issues.
  - Tailwind/Vite produces hashed bundles in `dist/` (lazy chunks for nearly every page — see [src/App.tsx:25-45](src/App.tsx:25)).
  - No CDN platform config beyond Vercel headers. Supabase Realtime is used directly (no proxy).

## 2. Build & ship
- Git: branches present? is a real .env file committed (yes/no)? does .gitignore cover secrets:
  - Branches (local + remote): `main`, `capacitor-setup`. Remote `origin` is `https://github.com/SpartanAbdullah/Hisab.git`.
  - `.env` is present locally and gitignored (`.gitignore:14` lists `.env`; `git ls-files` returns only `.env.example`; `git check-ignore -v .env` confirms exclusion). However, an audit of git history (`git log --all -S "<supabase-url>"`) shows that historical commits `88ed40c` and `dfea60e` accidentally committed **built JS bundles under `android/app/build/intermediates/.../assets/public/assets/*.js`** with the production `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` baked in. Commit `7768457` (2026-05-31) deleted those build artifacts and added `android/**/build/` to `.gitignore`, but the values remain reachable in the git history of branch `main` (and remote `origin/main`). The anon key is a publishable key (it is intended to be client-side) and is gated by RLS, so impact is mitigated — but a key-rotation + history-rewrite decision is still worth making at audit time.
  - `.gitignore` covers: `.env`, `node_modules`, `dist`, `dist-ssr`, `*.local`, `.vscode/*` (with extensions.json exception), `.claude/`, `android/.gradle/`, `android/.idea/`, `android/local.properties`, `android/**/build/`, `*.iml`, `*.apk`, `*.aab`, `*.jks`, `*.keystore`.
- Secrets handling: how are API keys stored? any hardcoded/committed keys (report file:line, NOT the value):
  - Runtime: read from `import.meta.env` (Vite). Caller: [src/lib/supabase.ts:3-4](src/lib/supabase.ts:3) (Supabase URL + anon key), [src/lib/sentryReporter.ts:9](src/lib/sentryReporter.ts:9) (Sentry DSN), [src/lib/outboxRunner.ts:29](src/lib/outboxRunner.ts:29) (feature flag), [src/stores/supabaseAuthStore.ts:26](src/stores/supabaseAuthStore.ts:26) and [src/lib/collaboration.ts:43](src/lib/collaboration.ts:43) (public app URL).
  - Current working tree (HEAD): the production Supabase URL and anon key sit in the gitignored `.env` file at [.env:1-2](.env:1) (working copy only; not tracked). No hardcoded keys were found anywhere under `src/` (grep for `supabase.co|sb_publishable|sb_secret|sk_live|sk_test|pk_live|pk_test|sentry.io|API_KEY` returned zero hits).
  - Git history (NOT current tree): the same URL + anon key are reachable in old build-artifact files under `android/app/build/intermediates/assets/debug/mergeDebugAssets/public/assets/*.js` (added in commits `88ed40c`, modified in `dfea60e`, deleted in `7768457`). UNKNOWN — needs dashboard/host check whether the project's Supabase access-control posture treats the anon key as "fine to be public" or "should be rotated."
- Env config: is .env.example present? list the env var NAMES expected:
  - `.env.example` is committed. Expected variable names:
    - `VITE_SUPABASE_URL` (required)
    - `VITE_SUPABASE_ANON_KEY` (required)
    - `VITE_PUBLIC_APP_URL` (recommended — drives canonical URL, OG tags, invite links, auth redirects; defaults to `window.location.origin`)
    - `VITE_SENTRY_DSN` (optional — Sentry stays disabled if unset)
    - `VITE_ENABLE_OUTBOX` (optional — gates the offline-outbox scaffold; runner is inert unless this is `'true'`)
  - The runtime type declaration is in [src/vite-env.d.ts:4-6](src/vite-env.d.ts:4) and matches.
- CI/CD: any pipeline/config files (.github/workflows, vercel.json, netlify.toml, etc.) — list them:
  - `.github/workflows/ci.yml` — runs on push/PR to `main`: Node 22, `npm ci`, `tsc -b`, `npm run lint`, `npm test` (Vitest), and a production `vite build` with dummy Supabase env vars. No deploy step in this workflow.
  - `vercel.json` — header rules + SPA rewrite (Vercel inferred). No `netlify.toml`, no GitHub Actions deploy job.
  - Capacitor scripts in `package.json` (`cap:sync`, `cap:open:android`, `cap:run:android`) — Android build is manual (Android Studio / Gradle). No GitHub Actions for the Android build.

## 3. Run & survive
- Error tracking / logging:
  - Sentry browser SDK (`@sentry/browser` 10.54.0). Boot-time init in [src/lib/sentryReporter.ts](src/lib/sentryReporter.ts) (DSN-driven; `sendDefaultPii: false`; 10% trace sample rate in prod, 100% in dev; ignores known ResizeObserver noise). Wired through a small `ErrorReporter` indirection in [src/lib/errorReporter.ts](src/lib/errorReporter.ts) so the rest of the app calls `reportError(err, context)` and gets either Sentry or a console no-op.
  - Global handlers installed at [src/lib/errorReporter.ts:59-72](src/lib/errorReporter.ts:59) (`window.onerror`, `unhandledrejection`) and routed through `notifyStaleChunkLoadError` for the post-deploy chunk-load recovery UX.
  - React `ErrorBoundary` ([src/components/ErrorBoundary.tsx](src/components/ErrorBoundary.tsx)) wraps the app.
  - There is no separate analytics/telemetry vendor (no PostHog/Mixpanel/Segment/GA imports). `src/lib/analytics.ts` is local transaction aggregation for the in-app Analytics page, not user-event tracking.
- Rate limiting / abuse protection: any, especially on endpoints that call paid APIs:
  - Database-level: `supabase-migration-prelaunch-hardening.sql` (§7) adds a `join_code_attempts` ledger and re-wraps `join_group_by_code` to enforce a sliding 5-minute window over failed attempts before raising `INVALID_OR_EXPIRED_CODE`, plus a per-code expiry on `split_groups.join_code_expires_at`. RLS on `join_code_attempts` is `FOR ALL USING (false)` — only the SECURITY DEFINER RPC touches it.
  - HTTP / infra rate limiting: nothing in the repo. Supabase Auth has built-in rate limits (per-project dashboard setting) — UNKNOWN — needs dashboard/host check. Vercel has built-in DDoS/edge protection — UNKNOWN — needs dashboard/host check. No application-level rate limiting around Sentry events or any other paid surface.
- Input validation: present on user/API inputs:
  - No schema-validation library (`zod`, `yup`, `joi`, `ajv`, `class-validator`) is installed or imported anywhere — confirmed via `package.json` and src-wide grep.
  - Client-side: per-form ad-hoc validation in the Add/Edit pages (e.g. positive-amount checks, currency dropdowns from a fixed `SUPPORTED_CURRENCIES` list, member-status guards in [src/lib/groupLeave.ts](src/lib/groupLeave.ts), invite-token normalisation in [src/lib/collaboration.ts](src/lib/collaboration.ts), public-code normalisation that strips prefix/hyphens before lookup).
  - Server-side: validation is enforced by RLS policies + Postgres constraints (NOT NULL, DEFAULTs, FKs added by the hardening migration, `WITH CHECK` clauses that prevent ownership reassignment) and by SECURITY DEFINER RPCs (`join_group_by_code`, `apply_account_balance_delta`, profile lookups, settlement-request RPCs). The hardening migration explicitly lists "no row donation across groups" as a guard on `group_expenses.UPDATE`.
- Tests: framework + rough coverage signal (count of test files):
  - Vitest 3.2.4 configured for Node environment (no DOM/JSDom) at [vitest.config.ts](vitest.config.ts). 22 test files under `src/**/*.test.{ts,tsx}`:
    - `src/lib/`: trustScore, monthlyWrap, settlementNudges, analytics, mutationSafety, constants, groupLeave, groupLeaveMigration, appRecovery, pendingInvite, groupInviteJoinMigration, groupActiveMembers, groupActiveMembersMigration, linkedRequestBranch, resolvePersonName, contactArchiveMigration.
    - `src/stores/`: recurringStore, budgetStore, transactionStore.
    - `src/db/`: databaseIsolation.
    - `src/components/`: ContactPicker, ConfirmDestructiveSheet (the only `.tsx` test).
  - Per the file header at [vitest.config.ts:1-7](vitest.config.ts:1), tests deliberately cover pure functions only; "stores and the DB layer talk to Supabase — those need integration tests with a staging instance, which we'll add later." No integration / e2e suite exists in the repo.
- Backups / recovery: anything in the repo about this:
  - User-driven JSON export/import: [src/lib/dataExport.ts](src/lib/dataExport.ts) (`exportAllData`, `importData`, `downloadJSON`). The Settings page surfaces this as a backup affordance.
  - Outbox + soft-delete: the outbox runner ([src/lib/outboxRunner.ts](src/lib/outboxRunner.ts)) provides forward-recovery for offline mutations once `VITE_ENABLE_OUTBOX=true`; soft-delete columns (`deleted_at`) preserve historical rows server-side. `clearUserDatabase` / `clearLegacyDatabase` in [src/db/database.ts:229-238](src/db/database.ts:229) handle local-DB resets at sign-out / user-switch.
  - Server-side backups: no repo-level config. Supabase manages PITR / daily backups per plan — UNKNOWN — needs dashboard/host check.

## 4. Cannot be determined from repo
- Hosting plan & region for Vercel (or whichever host the prod web app actually runs on) and whether the project is the `usehisaab.com` apex or a subdomain.
- Whether the production Supabase project is on Free / Pro / Team, its region, and the configured PITR / daily-backup retention.
- Whether Supabase Auth is configured with the built-in SMTP or a custom provider, and the email-confirmation / password-reset rate limits set in the dashboard.
- Whether the historical commits that exposed the production Supabase URL + anon key in compiled JS bundles have been treated as a key-rotation event (rotate `VITE_SUPABASE_ANON_KEY` and re-issue) or accepted as low-risk because of RLS.
- Whether `VITE_SENTRY_DSN` is set in the production environment (Sentry only initialises if the DSN env var is present at build/runtime).
- All Supabase Row-Level-Security policies (and any storage-bucket policies, scheduled `pg_cron` jobs, or non-checked-in RPCs) that may have been edited directly in the Supabase Studio dashboard rather than via migration SQL in this repo.
- DNS, TLS, and CDN/proxy chain in front of `usehisaab.com` (Cloudflare? Vercel direct?). Whether HSTS / CSP / other security headers are set at the edge — `vercel.json` only sets `Cache-Control`.
- Play Store listing status, signing key (`*.jks`/`*.keystore` are gitignored — location of the real keystore lives elsewhere), and release-track (internal / closed / production) for the Capacitor Android wrapper.
- Who has Owner / Admin access on the GitHub repo, the Supabase project, the Vercel project, the Google Play console, the Sentry org, and the domain registrar for `usehisaab.com`.
- Whether spend caps / budget alerts are configured on Supabase (egress, DB compute), Vercel, and Sentry (event quota).
- Any out-of-band cron jobs or scheduled functions (none are in the repo; the `recurringRunner` runs in-browser on app boot).
- Pen-test / SOC2 / GDPR posture (docs/privacy-data-safety-inventory.md describes data flows but does not assert a compliance status).
