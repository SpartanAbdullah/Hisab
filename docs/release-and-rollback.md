# Release & Rollback — Hisaab

This is the coordinated release procedure for a change that touches more than
one of Hisaab's three unsynchronized tracks — **database** (hand-applied SQL),
**web** (Vercel, auto-deploys on push to `main`), and **Android** (a manually
built `.aab`, Play review, staged rollout). It exists because
`docs/audit-2026-09/13-engineering-standards.md` §2.8 scored CI/CD 3/10
specifically for having *"no rollback story anywhere"*, and because the
2026-09-02 P0 remediation batch
(`docs/audit-2026-09/P0-REMEDIATION.md`, `docs/audit-2026-09/APPLY-ORDER.md`)
is the first release this repo has shipped where getting the order wrong
breaks the app for every user, not just one feature.

For a **web-only, non-breaking** change (the ~95% case), you don't need this
document — see `docs/updating-the-android-app.md` "The mental model". This
doc is for the coordinated case: a migration ships alongside a client change
that depends on it.

Read `docs/audit-2026-09/P0-REMEDIATION.md` and `docs/audit-2026-09/APPLY-ORDER.md`
first — they are the source of truth for *what* the current P0 batch does and
*in what order* its 11 files apply. This document is the surrounding
procedure: what to check before touching anything, how the three tracks are
sequenced against each other, and what to do when one of them needs to be
undone.

---

## 1. Pre-flight — run before touching anything

Do these in order. Stop and resolve anything that doesn't check out before
proceeding to §2.

### 1.1 Verify what production's schema actually is

Nothing in this repo can tell you which of the 40+ hand-applied
`supabase-migration-*.sql` files production has actually run
(`docs/audit-2026-09/02-repository-architecture.md` C-1). Do not assume the
APPLY-ORDER.md historical order was followed — verify:

1. Run `supabase-audit-p0-verification.sql` (read-only, safe to run any time)
   in Supabase Studio → SQL Editor against **production**.
2. Read Section 13 (migration verdicts) and the two flagged rows
   `APPLY-ORDER.md` §3 already documents as expected
   (`app_push_config` zero-policies-by-design, and the known
   `lookup_profile_by_public_code` client bug — neither blocks a release).
3. Any other row whose `result` starts with `!!` means production is **not**
   in the state the batch assumes. Resolve it — apply the missing
   prerequisite migration from `APPLY-ORDER.md` §1 — before proceeding.

### 1.2 Pre-flight the money-bounds constraints specifically

If this release includes `supabase-migration-p1-money-bounds.sql` (server-side
CHECK constraints + the split-sum trigger — H10 / M12), that file's own
**Section 5** is a read-only finder built exactly for this moment. Run its
**F1 query** ("the one-query pre-flight") against production *before*
applying the migration:

- **Expect zero rows.** Each row it returns is a money value already in the
  database that the new constraint would refuse to `VALIDATE` cleanly — the
  file still applies with `NOT VALID` (existing rows are grandfathered,
  per its own §1 policy), but a non-empty F1 result means you now have a
  known list of poisoned/out-of-range values to triage by hand before they
  next get edited.
- Also run **F2** if `group_expenses.splits` bounds are part of the release —
  it lists existing group-expense rows whose splits wouldn't pass the new
  arithmetic trigger. Those rows stay readable; only a *future edit* to them
  gets refused, per the file's own comment.
- Both queries are bare `SELECT`s — nothing writes. Safe to run against
  production at any time, not just release day.

### 1.3 Resolve the open founder decisions

`docs/audit-2026-09/P0-REMEDIATION.md` §3 lists two decisions the migrations
deliberately left open rather than picking unilaterally:

- **§3.1 (C2/R1):** what happens when a user deletes their account while
  carrying an unsettled balance in a shared group — refuse deletion until
  settled (lead's recommendation), or allow it plus a write-off RPC.
- **§3.2 (C6):** whether to leave pre-existing conscripted `'connected'`
  group members as-is, or run a one-time backfill/notification pass.

Neither blocks *applying* the SQL (both migrations ship with a safe default),
but both change user-facing behavior — decide before the release window, not
after a support ticket.

### 1.4 Confirm which track this release touches

- **SQL only, no client dependency** → apply per §2.1, no coordination with
  Vercel/Play needed. (`APPLY-ORDER.md`'s "safe ahead of the client" list:
  `currencies`, `settlement-row-locks`, `account-deletion`,
  `group-ledger-integrity`.)
- **SQL + web** → §2.1 then §2.2, same maintenance window.
- **SQL + web + Android** → all of §2, in order, same window. This is the
  case 7 of the 11 audit-P0 files are in (`APPLY-ORDER.md` §2 "Must ship in
  the same deploy as the client build").

---

## 2. The release sequence

**Do not reorder these steps.** The dependency is one-directional: a client
that expects a migration's new RPC contract will hard-fail (by design — "fail
loud") if that migration hasn't landed yet; a migration that changes an RPC
contract before the matching client ships will break the *currently live*
app for every user until the client catches up. Steps 2.1 and 2.2/2.3 must
land inside the same maintenance window for anything marked BREAKING.

### 2.1 Apply migrations, in `APPLY-ORDER.md` order

Via Supabase Studio → SQL Editor (there is no migration runner in this repo —
see `CLAUDE.md` "Supabase migrations"). Follow the numbered order in
`APPLY-ORDER.md` §2 exactly, not filename alphabetical order — the doc's own
"alphabetical trap" example (`fix-settlement-cancel-reject.sql` sorting next
to, but needing to run 22 files after, `fix-rls-recursion.sql`) is proof this
has already bitten the repo once historically.

After each file, its own embedded verification section prints a notice —
confirm it says `OK` before moving to the next file.

### 2.2 Deploy web

Merge to `main` and push. Vercel's Git integration auto-deploys on push — no
manual step. **Do this only after 2.1 has completed for every migration this
release's client code depends on.**

If `.github/workflows/security.yml` or `ci.yml` would fail on this diff,
fix that first — see `docs/ops-checklist.md` "Branch protection for main"
for why a red CI run should not become a live deploy once branch protection
is turned on (it currently can — see §5 below).

### 2.3 Build and upload the Android AAB, staged rollout

Per `docs/updating-the-android-app.md` Part A: bump `versionCode`/`versionName`,
`npm run build && npx cap sync android`, then hand the signed-build step to
the founder — Gradle needs a loopback socket the agent sandbox blocks.

Upload to Play Console → Production → **staged rollout, not 100% immediately**:

1. **20%** — hold for at least a few hours to a day. Watch Play Console →
   Quality → Android vitals → Crashes, and Sentry (if `VITE_SENTRY_DSN` is
   set) for anything that only reproduces on-device.
2. **50%** — once 20% is clean.
3. **100%** — once 50% is clean.

This is the only place a broken *native* build can be caught before every
Android user has it — there is no OTA layer yet (§6) and no way to un-push a
`.aab` once Play has served it to a device. A staged rollout is the entire
Android safety net.

### 2.4 Raise the `app_config` floor — LAST, and only once 2.2 and 2.3 are both 100%

If this release includes a genuinely breaking migration, `public.app_config`
(`supabase-migration-p1-app-config.sql`) is the kill switch that forces old
clients to update rather than keep calling a contract that no longer exists.
Its own header states the policy; restated here because getting the order
wrong locks out every user of a working app:

> Bump `min_supported_version` / `min_supported_version_code` **only** after
> the fixed build is live on Vercel **and** rolled out to 100% on Play.
> Raising the floor before the fix is available locks users out of an app
> they cannot update to. The gate is a kill switch, not a nag — no "remind me
> later" path exists by design.

Concretely: do **not** touch the `app_config` row until 2.2 has been live on
`usehisaab.com` and 2.3's staged rollout has reached 100%. Then, via
`service_role` (Studio SQL Editor — the table has no client write policy by
design), set `min_supported_version` to the web semver and
`min_supported_version_code` to the Android `versionCode` this release
shipped.

### 2.5 Smoke test

Run the checklist in `docs/audit-2026-09/P0-REMEDIATION.md` §1 step 8 (loan
repayment double-tab conflict, group settlement over-settle rejection, join
by code + by invite, kameti draw idempotency, cross-user non-AED/PKR udhaar,
account deletion inside a shared group, group notification fan-out language,
PIN lock on background/cold-start). Every audit-P0 file's own header lists
its narrower verification query too, if a specific item needs isolating.

---

## 3. Rollback playbook, per layer

There is no single "rollback" command here — each track has a different
undo story, and for the 7 audit-P0 migrations that ship *with* the client
(`APPLY-ORDER.md` §2 "Must ship in the same deploy"), rolling back **one**
track without the other reintroduces the exact skew this whole procedure
exists to prevent. Read the "which direction is safe" note under each layer.

### 3.1 Web (Vercel) — instant rollback

Vercel keeps every previous deployment. To roll back:

- Vercel dashboard → the project → **Deployments** → find the last-known-good
  deployment → **⋯ → Promote to Production** (labelled "Instant Rollback" in
  Vercel's own docs). This repoints `usehisaab.com` at the old build
  immediately — no rebuild, no CI re-run.
- Safe to do independently **only if** the migrations this release depended
  on are still additive/backwards-compatible with the *previous* client (true
  for the 4 "safe ahead of the client" migrations). If the release included
  one of the 7 breaking migrations, rolling back the web deploy alone means
  the old client is now calling an RPC contract that no longer exists —
  check whether the SQL also needs reverting (§3.3) before doing this alone.

### 3.2 Android — halt the rollout; there is no true "rollback"

Play does not let you downgrade a `versionCode` or re-serve an older AAB to
users who already updated. The levers you actually have:

- **Halt the staged rollout.** Play Console → Production → the active
  release → **Halt rollout**. This stops the percentage from climbing further
  — it does **not** un-install the new version from devices that already got
  it, and does not roll anyone back to the previous binary.
- **The `app_config` version floor is the real kill switch** (§2.4). If a
  *new* release is broken, do **not** raise the floor to it — that's the one
  way to make a bad Android release actively worse (it would force-update
  users onto the broken build). If an *old* release turns out to be the
  problem (e.g. you need to force everyone off a pre-fix binary), raising
  `min_supported_version_code` to the fixed build's code is exactly the
  mechanism `supabase-migration-p1-app-config.sql` exists for.
- **To actually get users off a bad build:** ship a new release with a
  *higher* `versionCode` that reverts the problematic change, and let the
  normal update mechanism (or a raised floor, if it's urgent) carry users to
  it. This is slower than Vercel's instant rollback by design — Play review
  + staged rollout apply to the fix the same as to anything else, unless
  Play's expedited review applies.

### 3.3 SQL — additive-only by policy; true rollback is the exception, not the rule

This repo's stated policy (`src/lib/versionGate.ts` header, restated in
`supabase-migration-p1-app-config.sql`) is: **keep every schema/RPC change
additive and backwards-compatible** — new nullable columns, new RPCs, new
*optional* parameters; never rename, repurpose, drop, or tighten an existing
RPC's contract in place. This exists precisely so that a schema change
doesn't need a working rollback story in the first place: an old client stays
a supported client until the floor is deliberately raised.

None of the 11 audit-P0 migrations ships a `DOWN` script — there is no
migration runner in this repo to run one against (`CLAUDE.md`). Practically:

| Migration | Reversible? | How |
|---|---|---|
| `audit-p0-currencies.sql` | Yes, cleanly, **if** no non-AED/PKR row was written since applying | `ALTER TABLE ... DROP CONSTRAINT`, re-add the narrower AED/PKR-only CHECK. Check for violating rows first (same shape as the money-bounds F1 query, §1.2) or the `ADD CONSTRAINT` fails. |
| `audit-p0-account-deletion.sql` | Yes, low-risk either way | Non-breaking/additive (FK `CASCADE`→`SET NULL`, nullable columns, one new RPC). Reverting the FK behavior is possible but nothing forces the new RPC's use, so leaving it applied is lower-risk than reverting. |
| `audit-p0-settlement-row-locks.sql` | Technically yes, **not recommended** | Replaces two RPCs in place with the same signature; the previous bodies exist in `settlement-emi-and-account-guards.sql` / `cross-user-account-effects.sql`. Restoring them **reopens the deadlock and lock-order bugs this file exists to fix.** Forward-fix instead. |
| `audit-p0-group-ledger-integrity.sql` (the keystone) | **No — forward-fix only** | Removing the DELETE policies it drops is exactly what reopens C4 (ex-members falsifying the shared ledger). Nothing downstream of it (`notifications`, `group-concurrency`, `group-deletion-guard`) can apply without it either — reverting it means reverting all four. |
| `audit-p0-loan-concurrency.sql`, `-kameti-draw.sql`, `-notifications.sql`, `-group-concurrency.sql`, `-group-deletion-guard.sql`, `-join-abuse-limits.sql`, `-consent-guards.sql` (the 7 "ships with client" migrations) | **Only in lockstep with a matching web + Android rollback** | Each changed an RPC contract, a trigger, or a policy the *live* client now depends on. Dropping the new function/trigger/policy without also rolling back §3.1 and, where relevant, §3.2 breaks the app currently in front of users — the opposite of a rollback. If one of these needs undoing, the SQL side is the *last* thing you touch, not the first: roll back web (§3.1) and consider halting/floor-gating Android (§3.2) first, confirm the old client is live, **then** decide whether the SQL genuinely needs reverting or whether the old client tolerates the new schema (most of these were designed to fail loud rather than corrupt data — check the migration's own header for what an old client sees against the new schema before assuming it needs reverting at all). |

**The practical rule:** prefer a forward-fix migration over a revert for
anything past `group-ledger-integrity.sql` in the dependency chain — a
forward-fix (a new, small, additive migration that corrects the bug) doesn't
reopen a closed vulnerability and doesn't require an Android release to
un-break. Reach for a true SQL rollback only for the 4 migrations in the
"safe ahead of the client" list, and even then, check the F1-style
pre-flight query for that table first.

---

## 4. The prod-first SQL hazard, and why this repo needs a staging project

`docs/audit-2026-09/02-repository-architecture.md` H-5 names this directly:
*"every migration is applied first to production, by hand"* — there is no
environment separation anywhere in this repo (one `.env`, no staging config;
CI builds against dummy Supabase values, `ci.yml`). The APPLY-ORDER.md
integration run proves the 11 audit-P0 files compose cleanly with each other
and with the 40 historical migrations **in a Docker `postgres:16` harness** —
it explicitly does **not** prove they compose with production, because the
harness fakes or omits PostgREST, `pg_net`, Realtime, Supabase Auth's real
`auth.users` shape, and true multi-session concurrency
(`APPLY-ORDER.md` §7, the "Known limitations of the harness vs real
Supabase" table). Production is "whatever was actually pasted into Studio
over 5 months" — a state this repo cannot reconstruct from source alone.

**Recommendation:** stand up a second Supabase project (free tier is enough
for schema/RLS/RPC validation; it does not need production data) as a
**staging project**, and replay this repo's SQL files against it — via the
Supabase CLI (`supabase db push` against the staging project, once the CLI
is connected — `docs/audit-2026-09/P0-C1-runbook.md` Option B) or by pasting
the same files into staging's Studio SQL Editor in `APPLY-ORDER.md` order.
Then:

1. Every future migration gets applied to staging first, smoke-tested there
   (§2.5's checklist works against any Supabase project, not just prod), and
   only then applied to production.
2. Real PostgREST behavior (the exact gap the Docker harness couldn't cover —
   named-argument RPC binding, `jsonb` return-shape mapping, the `max_rows`
   truncation risk from `13-engineering-standards.md` §2.1) becomes
   verifiable before it ships, not after.
3. A staging Vercel preview deployment (Vercel supports per-branch envs)
   pointed at the staging Supabase project closes the loop — a PR can be
   smoke-tested end-to-end before it ever touches `main`.

This is explicitly **not** part of the current P0 batch (it's a process
change, not a migration) — flagged here as the structural fix to the prod-
first hazard, for the founder to schedule.

---

## 5. Deploy gating — CI green before a production deploy

**Nothing in this repo currently stops a red `main` from deploying to
`usehisaab.com`** (`13-engineering-standards.md` §2.8: *"Vercel deploys are
driven by its own git integration, independent of CI status — no evidence
... of 'CI must pass before deploy'"*). No file in this repo can fix that by
itself — Vercel's deploy trigger is dashboard/project configuration, not a
committed config file (`vercel.json` covers headers/rewrites only, and
Vercel does not read a "required checks" setting from it). Two mechanisms
close this, used together:

1. **Vercel's "Ignored Build Step"** (Project Settings → Git → Ignored Build
   Step) can be pointed at a script that exits non-zero unless the commit's
   GitHub check-runs (from `ci.yml` and `.github/workflows/security.yml`)
   are green, which makes Vercel skip the build/deploy for that commit
   entirely. Vercel's own recommended pattern for "wait for CI" is a small
   shell script using `gh` or the GitHub Checks API; document the exact
   script in the Vercel project (not in this repo) once written, since it
   depends on a `GITHUB_TOKEN`/PAT configured as a Vercel project env var.
2. **GitHub branch protection on `main`**, requiring the `ci` and `security`
   status checks (and `db-tests`, once that workflow exists) to pass before
   a merge is even allowed — this is the primary gate; the Vercel Ignored
   Build Step is defense-in-depth for a direct push that bypasses PR review.
   The exact settings to turn on are in `docs/ops-checklist.md`
   "Branch protection for main" — that's a GitHub repo-settings change, not
   a file this repo can commit.

Until both are configured, treat "push passed CI" as advisory, not
enforced — the discipline of not merging a red PR is the only real gate
today.

---

## 6. Over-the-air (OTA) web updates for Android — Capgo vs Appflow

`docs/updating-the-android-app.md` Part B already names this as the
post-launch fix for the divergent-money-logic risk
(`13-engineering-standards.md` §2.10: *"every web bug fix — including a
money-math fix — reaches Android users only after a Play review cycle... The
two surfaces will run divergent money logic against the same database for
days at a time"*). This section is the buy-vs-build evaluation.

**What both do:** ship a JS/HTML/CSS-only bundle update straight to
installed Capacitor apps, no new `.aab`, no Play review round-trip — the
Vercel-style instant update, for the web-asset layer only. Neither can touch
a native plugin, permission, icon, or `targetSdk` bump; those always need a
full Play release (Part A of that doc).

| | **Capgo** | **Ionic Appflow (Live Updates)** |
|---|---|---|
| Model | Third-party, Capacitor-specific, open-source core with a hosted/self-hostable update server | Official Ionic product, hosted only |
| Cost | Free/low-cost tiers scale to small apps; paid tiers for volume | Paid; historically the pricier of the two for a solo/small-team app |
| Ecosystem fit | Built specifically for Capacitor (the framework this app already uses) — active community adoption as "the popular Capacitor choice" | Built for the broader Ionic stack; Capacitor support exists but Appflow itself is the Ionic-branded offering, not Capacitor-native |
| Self-hosting | Available (open-source update server) — removes vendor lock-in and a recurring cost as the priority stated in `docs/updating-the-android-app.md` ("open-source, affordable") | Hosted-only, no self-host option |
| Operational maturity | Newer, smaller vendor — verify current SLA/uptime and pricing at adoption time, don't take this table as current pricing | Backed by Ionic (larger company); **verify Appflow's product status directly before committing** — Ionic has been consolidating/deprecating parts of its paid tooling in recent years, so confirm at adoption time whether Appflow Live Updates is still actively sold/supported, not assumed from this doc |

**Recommendation: Capgo**, when the time comes — it matches what
`docs/updating-the-android-app.md` already named as "the popular Capacitor
choice," fits a solo/small-team cost profile, and its self-host option means
no new vendor becomes a second bus-factor-1 dependency alongside Supabase/
Vercel/Play (`docs/ops-checklist.md` already tracks that risk). Re-verify
Appflow's current status before ruling it out entirely — Ionic's product
lineup changes, and this recommendation should be re-checked at adoption
time, not treated as permanent.

**When to adopt — not yet, and not casually even then:**

- `docs/updating-the-android-app.md` already says "set this up after v1 is
  stable — it's not needed to launch." Nothing in this audit changes that;
  if anything it raises the bar, because OTA is a second live-update channel
  for a money app that doesn't yet have branch protection (§5), a staging
  Supabase project (§4), or the app-config kill switch exercised in
  production even once.
- Concretely, adopt only after: (a) the P0 batch above has shipped and
  stabilized (fewer breaking client/SQL pairings expected going forward),
  (b) at least one full Play release cycle (upload → staged rollout →
  100%) has been run successfully end-to-end, so there's a known-good
  baseline to OTA-update *from*, and (c) branch protection + the security
  workflow (§5, `docs/ops-checklist.md`) are enforced — an OTA channel that
  can push straight to installed devices is exactly the kind of surface
  that should not ship from an unreviewed commit.
- **Play policy caveat** (already in `docs/updating-the-android-app.md`,
  restated here because it's load-bearing for a finance app): Google Play
  allows OTA updates of interpreted web code *as long as the update doesn't
  change the app's core purpose or use OTA to bypass review for
  policy-violating content*. Money-moving logic changes are exactly the kind
  of change worth asking "would Play's reviewers have wanted to see this"
  before pushing OTA rather than through Part A. When in doubt, ship the
  fix as a normal Play release instead — OTA is for the same class of change
  it always was (copy, styling, non-critical bug fixes), not a way to avoid
  review for a money-path change.
- **OTA does not replace the `app_config` kill switch** (§2.4). They solve
  different problems: OTA updates working code faster; the kill switch stops
  a genuinely incompatible old binary from running at all. Keep both once
  OTA exists.

---

## 7. Secret scanning — what the first CI run will (and won't) flag

`.github/workflows/security.yml` runs `gitleaks` over the full git history
on every push/PR to `main` and on a weekly schedule. Two things worth
knowing before the first run:

- **The known historical exposure is real.** `ARCH-RECON-hisaab.md` §2:
  commits `88ed40c` and `dfea60e` (2026-05-01 and 2026-05-31) committed built
  Android JS bundles with the production `VITE_SUPABASE_URL` +
  `VITE_SUPABASE_ANON_KEY` baked in; commit `7768457` deleted the build
  artifacts and added `android/**/build/` to `.gitignore`, but the values
  remain reachable in `main`'s git history today. Verified directly for this
  doc (`git grep` for the key's `sb_publishable_…` prefix on both commits,
  without printing the value) — both files each commit touched do contain
  it.
- **Gitleaks' default ruleset does NOT catch this.** Verified by running
  gitleaks v8.30.1 with its bundled default config against this repo's full
  184-commit history: **zero leaks found** for the known exposure — there is
  no rule for Supabase's `sb_publishable_…`/`sb_secret_…` key format in
  gitleaks' shipped `config/gitleaks.toml`. Without correcting for this, the
  security workflow would be silently blind to the one issue it was written
  to catch. `.gitleaks.toml` at the repo root adds one project-specific rule
  for exactly this key format (`[extend] useDefault = true` plus the added
  rule — every other default rule still runs); `security.yml` points
  `GITLEAKS_CONFIG` at it.
- **With that rule added, the first run will flag history** — 3 lines across
  the two commits (88ed40c touches two build-artifact files with the same
  compiled chunk; dfea60e touches one) — exactly as expected. `.gitleaksignore`
  at the repo root pre-allowlists those 3 findings by their gitleaks
  fingerprint (`commit:file:rule:line` — never a secret value), plus one
  unrelated pre-existing false positive (a duration constant in
  `src/lib/settlementNudges.ts` that trips the default `generic-api-key`
  entropy heuristic), so the **first CI run is green**, not a wall of
  expected noise. Both files carry the full reasoning for each entry inline.
- **Allowlisting is not the same as closing the exposure.** The key involved
  is Supabase's client-safe publishable/anon key — designed to ship inside a
  browser bundle, and every table it can reach is gated by RLS
  (`CLAUDE.md` "Data flow"), which is why this was triaged as low-impact
  rather than a live incident. It is **not**, however, zero risk, and
  rotating it (issue a new anon key in Supabase Studio → Project Settings →
  API, update `VITE_SUPABASE_ANON_KEY` everywhere it's set) is still
  recommended defense-in-depth — not yet done as of this writing. A full
  history rewrite (`git filter-repo` / BFG) to scrub the old key from `main`
  entirely is a heavier, separate decision (it rewrites every commit hash on
  the branch) — raise it with the founder rather than doing it unprompted;
  it is out of scope for this document.
