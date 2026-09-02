# Staging Environment — Runbook

**Date:** 2026-09-02 · **Status:** runbook only — nothing here has been
executed. No staging Supabase project, staging Vercel env scope, or Android
staging build flavor exists today. This is the structural fix for what
`docs/audit-2026-09/02-repository-architecture.md` H-5 calls "every migration
is applied first to production, by hand," restated as the prod-first SQL
hazard in `docs/release-and-rollback.md` §4 — roadmap item **L5** in
`00-executive-summary.md` §6.4.

**Read first:** `docs/release-and-rollback.md` and
`docs/audit-2026-09/APPLY-ORDER.md` (the canonical migration order this doc
replays). This runbook only adds a "second environment" step in front of
`release-and-rollback.md` §2.1.

---

## 0. What already exists — reuse it, don't rebuild it

- **`supabase/tests/run.sh` + `supabase/tests/apply-order.txt`** — a
  Docker-based harness applying the full SQL corpus (schema + 40 historical
  migrations + audit-P0/P1/P2/P3, ~105 files) to a throwaway `postgres:15` in
  canonical order, then trust-boundary assertions. Accepts `HISAAB_TEST_DSN`
  to target any Postgres, not just its own container — the mechanism §1 uses.
- **`.github/workflows/db-tests.yml`** — runs that harness on every push/PR
  to `main` against a GitHub Actions Postgres service. Proves the corpus
  composes with itself, not with a real Supabase project (PostgREST,
  `pg_net`, Realtime, real `auth.users` — gaps `APPLY-ORDER.md` §7 lists).
  Closing that gap is §1.
- **`src/lib/telemetry.ts`** — PostHog EU wrapper, gated behind
  `VITE_POSTHOG_KEY` + opt-in consent (default off); §2 only adds
  environment-scoped keys, no new code.
- **`vercel.json`** — already carries CSP/HSTS/etc. headers; §2 is a Vercel
  dashboard env-scope change, not a file edit here.

## 1. Second Supabase project ("hisaab-staging")

### 1.1 Create and link

1. Supabase dashboard → New project → `hisaab-staging`, same region as
   production. **Free tier is sufficient** — schema/RLS/RPC validation only,
   never production data.
2. `supabase link --project-ref <staging-ref>` from a separate checkout (or
   re-link per session) — the CLI links one project per `.supabase/config.toml`,
   which doesn't exist in this repo today (only `supabase/tests/` and
   `supabase/functions/` exist under `supabase/`) — creating it is part of this step.

### 1.2 Replay the corpus

```bash
HISAAB_TEST_DSN="postgresql://postgres:<staging-db-password>@db.<staging-ref>.supabase.co:5432/postgres" \
  bash supabase/tests/run.sh
```

Applies every file in `apply-order.txt` — base schema, 40 historical
migrations, audit-P0/P1/P2/P3 — in canonical order with `ON_ERROR_STOP=1`
per file, then runs `supabase/tests/tests/*.sql`. Use `--apply-only` to
inspect schema before assertions, `--shell` for a `psql` session after.

**This does not close the "production drift" gap** — `APPLY-ORDER.md` §7 is
explicit the harness proves the *files* compose with each other, not that
they match what's actually live in production (five migrations are flagged
"possibly unapplied" — `APPLY-ORDER.md` §1). Run
`supabase-audit-p0-verification.sql` against **production** first (per
`docs/release-and-rollback.md` §1.1) and reconcile before trusting staging as
a stand-in for intended prod state.

### 1.3 Seed test users

`auth.users` rows don't transfer via SQL replay (GoTrue-managed, not touched
by `apply-order.txt`). Options, in preference order: (1) **manual signup
through the staging-pointed PWA** (§2) — exercises real onboarding including
the `email_confirmed_at` gate (`CLAUDE.md` "Routing/auth"); (2) **Studio →
Authentication → Add user** — fast fixture accounts skipping email
verification, for pure SQL/RLS testing; (3) mirror
**`supabase/tests/tests/00-fixtures.sql`'s** fixture shape — the harness's
own scaffold fabricates `auth.users` for its Docker-only path (not usable
against real Supabase, where GoTrue owns that table) but is a useful
reference. Keep a fixed small roster (3-4 users, owner/member/joiner)
mirroring `APPLY-ORDER.md` §5's A/B/C smoke pattern so scenarios reproduce
session to session.

## 2. Vercel: environment-scoped Supabase config

**The problem today:** one `.env`, one set of `VITE_SUPABASE_URL`/
`VITE_SUPABASE_ANON_KEY` values in Vercel, no environment separation
(`docs/release-and-rollback.md` §4). Any preview deployment either fails to
build meaningfully or, if prod values are set project-wide, **points preview
traffic at production data**.

### 2.1 Steps

Vercel supports per-environment variables natively (Settings → Environment
Variables → Production/Preview/Development checkboxes per key):

1. For `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`: add a **Production**-
   scoped value (unchanged) and a separate **Preview**-scoped value pointing
   at `hisaab-staging` — Vercel allows multiple values per key across
   non-overlapping scopes; this is the mechanism, not a workaround.
2. `VITE_PUBLIC_APP_URL` — scope Preview to the preview URL, or leave it at
   `usehisaab.com` if invite/witness deep links need to resolve against prod
   during manual testing; decide and record the choice here.
3. `VITE_ENABLE_OUTBOX` — leave unset in both scopes (scaffold, handlers
   throw — `outboxRunner.ts:26-29`).
4. `VITE_ATOMIC_TRANSFER` — only `true` in Preview once
   `supabase-migration-p3-atomic-transfer.sql` is applied to staging; its own
   `.env.example` warning says it fails loud otherwise — better to discover
   that on staging than prod.

### 2.2 PostHog / Sentry separation

- **PostHog:** a second project (or PostHog's environment/tag feature, plan
  permitting) so staging traffic doesn't pollute the activation/invite-loop
  funnels `docs/go-to-market.md` §3.1 reads from PostHog. Set
  `VITE_POSTHOG_KEY` to the staging key in Vercel's Preview scope.
- **Sentry:** a second project, or the same project with an `environment`
  tag (`"staging"`/`"production"`) set at `Sentry.init()`, keyed off
  `import.meta.env.MODE` or a new `VITE_APP_ENV` — Sentry natively
  filters/alerts by that tag, so a second project isn't required the way it
  effectively is for PostHog's funnel math.

---

## 3. Android staging build

Capacitor ships whatever's in `dist/` at `cap sync` time — no runtime env
switch inside the compiled app.

1. **`.env.staging`** (gitignored) holding staging
   `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`/`VITE_POSTHOG_KEY`.
2. **Separate build+sync:** `cp .env.staging .env.local && npm run build &&
   npx cap sync android` (or `vite build --mode staging`, which Vite maps to
   `.env.staging` automatically) — document whichever is adopted as a new
   `cap:sync:staging` script alongside `package.json`'s existing `cap:sync`.
3. **Side-by-side install needs `applicationIdSuffix ".staging"`** in
   `android/app/build.gradle` (`com.usehisaab.app` → `com.usehisaab.app.staging`),
   e.g. a new `productFlavors { staging { applicationIdSuffix ".staging";
   versionNameSuffix "-staging" } production { } }` block under a
   `flavorDimensions "environment"`. **A native Gradle change — described
   here, not applied.** A separate signing keystore for staging is optional
   but recommended — reusing the production keystore makes a staging APK
   indistinguishable from a real release by signature; don't compound the
   existing keystore-custody risk (`docs/release-and-rollback.md`) without
   deciding that trade-off deliberately. May also need `AndroidManifest.xml`
   changes (distinct app name/icon so staging is visually distinguishable on
   a test device) — native-project work for the founder, out of this
   runbook's execution scope.

---

## 4. The new release rule

**Migrations land on staging first.** Insert this as a new step in front of
`docs/release-and-rollback.md` §2's existing §2.1 (apply to production):

> **§2.0 (new) — Apply to staging first.** Run the `APPLY-ORDER.md` file(s)
> against `hisaab-staging` (via `HISAAB_TEST_DSN`, §1.2, or pasted into
> staging's Studio SQL Editor in the same order). Run
> `supabase/tests/run.sh`'s assertions against staging — the same
> trust-boundary suite `db-tests.yml` runs on Docker Postgres, now against a
> project with real PostgREST/Realtime/Auth, closing the gap `APPLY-ORDER.md`
> §7 names as unclosable by Docker alone. Only proceed to production once
> staging's assertions pass **and** a manual smoke pass of
> `release-and-rollback.md` §2.5's checklist runs against the staging-pointed
> preview deployment (§2) — real client flows (loan repayment, group
> settlement, join-by-code, kameti draw, cross-user udhaar, account deletion,
> notification fan-out, PIN lock), not just SQL assertions.

Everything downstream — web deploy, Android staged rollout, the `app_config`
kill-switch sequencing — is unchanged from `release-and-rollback.md` §2.2
onward; this only adds the staging gate in front.

### 4.1 Follow-on: CLI-managed migrations

Once staging has absorbed a few real releases — a **follow-on, not this
doc's scope** — generate timestamped `supabase/migrations/<ts>_<name>.sql`
files from the `apply-order.txt` corpus (`supabase db diff` /
`supabase migration new`) and switch to `supabase db push` against both
environments instead of pasting into Studio. Answers
`02-repository-architecture.md` C-1's "no runner, no ledger" at the root
instead of working around it. Don't adopt a new migration tool and a new
environment in the same change window.

---

## 5. What needs the founder

| # | What | Why |
|---|---|---|
| F1 | **Supabase org access/billing** to create `hisaab-staging` | Org/billing admin action |
| F2 | **Vercel Project Settings write access** for Preview-scoped env vars (§2.1) | Vercel dashboard admin action |
| F3 | **Play internal-test track** for the staging APK (or sideload) — same Play Console/Gradle hand-off bottleneck as every Android release (`docs/release-and-rollback.md` §2.3) | Play Console access |
| F4 | **PostHog/Sentry second-project creation** (§2.2), if not using the environment-tag route | Org/billing admin action |

---

*Grounded against commit `2248327` and the working tree, 2026-09-02. Nothing
here has been executed — every step is a proposed procedure for the founder
(or a future agent, once F1-F4 are granted) to carry out.*
