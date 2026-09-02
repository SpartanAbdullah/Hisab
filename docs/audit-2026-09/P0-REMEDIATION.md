# Audit remediation tracker (P0–P3)

**Scope:** the full 2026-09 audit roadmap — P0 items C1–C11 from
[00-executive-summary.md §6.1](00-executive-summary.md) (pre-launch, blocking;
plus two extras picked up during implementation: group-deletion-guard, C10's
settlement-row-locks half), P1 items H1–H10 (30-day), P2 items M1–M9
(90-day), and P3 items L1–L7 (strategic). All work lives on branch
`audit-p0-remediation`, currently **uncommitted / partially-committed
working-tree changes** (not merged into `main`, not pushed — pushing `main`
auto-deploys the web app to Vercel via Vercel's Git integration, so this
branch is deliberately kept off `main` until the release checklist below is
run). `git log --oneline main..HEAD` at time of writing: `16268c8` (audit
docs) → `dfdec7e` + `0055472` (P0 client + SQL) → `e02f53f` (P1 batch A) →
`93f456c` (P1 batch B + P2/P3 first wave), plus further uncommitted work on
top (P3 L4 step 2, L2 wiring, and others still landing).

Migration apply order and integration-run results: **[APPLY-ORDER.md](APPLY-ORDER.md)**
(companion doc — read it before applying anything; not duplicated here).
**`supabase/tests/apply-order.txt` is the canonical apply order** for the
whole corpus now (APPLY-ORDER.md §2b) — 183 machine-checked assertions via
`supabase/tests/run.sh`, run in CI on every push/PR to `main`.

Source of truth for what each migration does: the header comment of each
`supabase-migration-*.sql` file at the repo root. This tracker summarizes
those headers and the accompanying docs (`docs/notifications.md`,
`docs/trust-and-safety.md`, `docs/server-side-money-engine.md`,
`docs/performance.md`, `docs/release-and-rollback.md`,
`docs/testing-the-trust-boundary.md`); the SQL files themselves are
canonical.

---

## 1. Release checklist

Do these in order. Do not skip or reorder — several migrations are BREAKING
in one or both directions (see §2), and the P1–P3 tail adds flag-gated
migrations that must not be enabled before their own pre-flight query has
been run (APPLY-ORDER.md §2b). Full procedure, rollback playbook and CI
gating: `docs/release-and-rollback.md`.

1. **Run `supabase-audit-p0-verification.sql`** in Supabase Studio → SQL
   Editor (read-only, safe to run any time) against production. Export the
   full result grid.
2. **Reconcile.** Any row whose `result` starts with `!!` needs founder
   attention before proceeding — it means production is not in the state the
   rest of the batch assumes. Section 13 (migration verdicts) is the
   fastest read; the two expected flags (`app_push_config`,
   `lookup_profile_by_public_code`) are documented, harmless exceptions
   (APPLY-ORDER.md §3).
3. **Apply ALL files in `supabase/tests/apply-order.txt` order, in one
   window, with the matching client.** This now covers the 11 audit-p0
   files *and* the 12-file P1/P2/P3 tail (APPLY-ORDER.md §2b) — not just the
   original 11. Via Supabase Studio SQL Editor (there is no migration runner
   in this repo — see `CLAUDE.md`). Confirm each file's own embedded
   verification notice says `OK`/`verification passed` before moving to the
   next.
4. **Set feature flags only after their own pre-flight (V-) query**, never
   before: `VITE_ATOMIC_TRANSFER` after `p3-atomic-transfer.sql` V1–V4 pass;
   `VITE_ATOMIC_REPAYMENT` after `p3-atomic-repayment.sql` V6 (the F-2
   corruption-signature finder) has been read and understood, and only after
   `VITE_ATOMIC_TRANSFER` has had its own release cycle — two flags flipped
   together make an incident un-bisectable; `VITE_REALTIME_BROADCAST` only
   after V6's *live* proof (save a real expense, confirm a broadcast row —
   Docker cannot verify this one). All four flags default off; none is
   required for this release to ship.
5. **Resolve the founder decisions in §6** before or during this window — at
   minimum acknowledge them; C2's R1 (unsettleable debt on deletion) and M1
   (the offline story) should be decided before merge, not after.
6. **Merge `audit-p0-remediation` → `main` and push.** Web deploys
   automatically via Vercel on push to `main`.
7. **Android:** `npm run build && npx cap sync android`, then hand the
   Gradle AAB build off to the founder (`gradlew` cannot run inside the
   agent sandbox — see `docs/updating-the-android-app.md` for the exact
   steps, version bump, and signing). Staged rollout: 20% → 50% → 100%
   (`docs/release-and-rollback.md` §2.3).
8. **Raise the `app_config` floor LAST**, only once web is live at 100% and
   the Android staged rollout has reached 100% — never before the fixed
   build is available to update to (`docs/release-and-rollback.md` §2.4).
9. **Coordinate the window.** Steps 3 and 6–7 must land close together:
   client-before-SQL breaks invites/linking (consent-guards,
   join-abuse-limits contracts change shape); SQL-before-client is fine to
   apply early EXCEPT where a migration's header says otherwise
   (loan-concurrency: `full_tracker` repayments start failing the moment
   it's applied until the matching client ships).
10. **Smoke test** after both are live (full list:
    `docs/release-and-rollback.md` §2.5):
    - Full-tracker: record a repayment on a loan from two browser tabs (same
      account) — confirm the second gets a conflict, not a silent
      double-debit.
    - Splits-only: record a group settlement from two tabs against the same
      debt — confirm the second is rejected, not an over-settle.
    - Join a group by code, then by invite link — confirm both still work
      end-to-end (contract changed shape in join-abuse-limits +
      consent-guards); confirm the group preview card (P1 H8) shows before
      joining.
    - Draw a kameti — confirm the draw button is inert after the first draw
      (no re-roll); confirm a hand-written slot before a draw is refused.
    - Record a linked (cross-user) udhaar entry in a non-AED/PKR currency
      (e.g. SAR) — confirm it saves.
    - Delete a test account that is a member (not owner) of a shared group
      with a non-zero balance — confirm the group's ledger survives for the
      remaining members.
    - Trigger a group notification (add an expense in a 2-person group) —
      confirm the other member receives it and it renders in the active
      language.
    - PIN: set a PIN, background the app 60s+, confirm the lock screen gates
      re-entry; confirm cold start also gates.
11. **First reconciliation run is a census, not an alarm.** Once
    `p3-invariant-monitoring.sql` is applied, run `run_reconciliation()`
    once and treat its output as the baseline population, not a fire drill
    — compare the *second* run's delta against the first before reacting to
    any row (APPLY-ORDER.md §2b).

---

## 2. Per-item status

Effort/impact framing follows §6.1 of the executive summary. "Breaking" is as declared in the migration's own header (search each file for `BREAKING`).

| # | Item | Migration file(s) | Breaking | Client files touched (evidence: `git diff --stat main`, `grep` for RPC/module usage) | Docker/throwaway-DB validated (per header) | Open follow-ups |
|---|------|--------------------|:---:|----------------------------------------------------------------------------------------|:---:|------------------|
| C1 | Prod schema unprovable — verification + CLI adoption | `supabase-audit-p0-verification.sql` (read-only) | No | — (SQL-only; runbook at [P0-C1-runbook.md](P0-C1-runbook.md)) | Y (PostgreSQL 15, both artifact-present/absent branches exercised) | **USER ACTION:** run it in Supabase Studio, paste output for review. Supabase CLI migration adoption (numbered, tracked, CI-applied) is still pending — blocked on the user connecting the Supabase CLI to the project. |
| C2 | Account deletion cascades into shared-group ledgers | `supabase-migration-audit-p0-account-deletion.sql` | Not flagged BREAKING (additive: FK CASCADE→SET NULL, columns made nullable) | `src/pages/GroupDetailPage.tsx`, `src/stores/splitStore.ts`, `src/lib/supabaseDb.ts`, `src/db/types.ts` (all reference `transfer_group_ownership` — the "Assign another admin" UI) | Y (throwaway Postgres 15, `supabase-schema.sql` + `reconciliation` loaded) | **PRODUCT DECISION** open — see §6.1 (D1). Header also files two smaller residuals (R2: owner can still hard-delete a shared group outright — closed separately by group-deletion-guard below; R3: departed member's `display_name` is deliberately retained on ledger rows — confirm against privacy policy before launch). |
| C3 | False listing claims (PIN / offline / currency) | none (docs + client only) | N/A | `docs/play-store-listing.md`, `docs/play-store-data-safety.md`, `docs/privacy-data-safety-inventory.md`, `RELEASE.md`; PIN wiring: `src/App.tsx`, `src/pages/PinLockScreen.tsx`, `src/stores/authStore.ts`, `src/lib/pinCrypto.ts` (new, PBKDF2 150k salted) | N/A | Listing claims corrected; PIN now actually gates cold start + 60s background + is asked for on re-auth. The PIN claim should return to the public store listing only after a device-verification pass (§7.C of the executive summary — no device farm has run yet). |
| C4 | `group_settlements` FOR ALL policy lets ex-members falsify the ledger | `supabase-migration-audit-p0-group-ledger-integrity.sql` | Not flagged BREAKING | RLS/trigger-only; no direct client dependency (client already writes rows through the same shape) | Not stated in header | None recorded beyond what's in the file. |
| C5 | Join-code brute-force limiter is a no-op; join codes never expire | `supabase-migration-audit-p0-join-abuse-limits.sql` | **Yes** — `join_group_by_code` return type changes `TABLE(...)` → `jsonb`, never raises for a business outcome | `src/pages/JoinGroupModal.tsx`, `src/pages/JoinGroupPage.tsx`, `src/stores/splitStore.ts`, `src/lib/collaboration.ts`, `src/lib/joinCodeStatus.ts` (new), `src/components/GroupCard.tsx` (Refresh-code UI) | Not stated in header | Join codes now expire 14 days; Refresh-code UI shipped in `GroupCard.tsx`. |
| C6 | Cross-user consent predicates are client-writable | `supabase-migration-audit-p0-consent-guards.sql` | **Yes** — see the 4 breaking changes listed in the migration's own header: (1) `persons.linked_profile_id` PATCH now rejected (42501) — use `link_contact_by_code` / `link_contact_by_discovery` / `unlink_contact_profile`; (2) owner-inserted `group_members` land as `'invited'`, not visible until accepted; (3) `group_invites` `select('*')` → permission denied, explicit columns only; (4) `accept_group_invite` — renamed argument, raw token (not hash), jsonb return | `src/pages/ContactDetailSheet.tsx`, `src/pages/ContactsPage.tsx`, `src/stores/personStore.ts`, `src/lib/contactLinkStatus.ts` (new), `src/lib/contactVerification.ts` (new), `src/pages/GroupDetailPage.tsx`, `src/pages/JoinGroupModal.tsx`, `src/pages/JoinGroupPage.tsx`, `src/components/GroupInviteModal.tsx`, `src/components/VerifiedBadge.tsx`, `src/lib/collaboration.ts`, `src/lib/supabaseDb.ts` | Not stated in header | **DATA DECISION** open — see §6.1 (D2). Pre-existing conscripted `'connected'` group members are NOT auto-migrated to `'invited'`; migration's verification query 4.6 lists the affected rows for manual triage. |
| C7 | Notification fan-out is client-side and forgeable | `supabase-migration-audit-p0-notifications.sql` | Ships with client (fan-out moves server-side; rows now also carry `template`+`params`) | `src/lib/notificationContent.ts` (new — renders template+params through i18n), `src/lib/instantNotify.ts`, `src/pages/InboxPage.tsx`, `src/pages/ActivityPage.tsx` | Not stated in header | Group notifications now render in the active language via `template`+`params`; `title`/`body` kept as fallback for legacy rows and the push pipeline. |
| C8 | Session hygiene (sign-out failure, re-auth, VerifiedBadge) | none (client only) | N/A | `src/stores/supabaseAuthStore.ts`, `src/pages/SettingsPage.tsx`, `src/components/VerifiedBadge.tsx` | N/A | — |
| C9 | Cross-user currency CHECK hard-limited to AED/PKR | `supabase-migration-audit-p0-currencies.sql` | Apply **BEFORE** client deploy (per header) | `src/pages/AddLoanModal.tsx`, `src/pages/SettleLinkedLoanModal.tsx`, `src/db/types.ts` | Not Docker-validated; header states widen-only CHECK is safe by construction (no existing row can become invalid) | None recorded. |
| C10 | Concurrency floor (loans, groups, kameti, settlements, client double-tap) | `supabase-migration-audit-p0-loan-concurrency.sql` (loans) · `supabase-migration-audit-p0-group-concurrency.sql` (group expense version + settlement cap) · `supabase-migration-audit-p0-kameti-draw.sql` (draw binding) · `supabase-migration-audit-p0-settlement-row-locks.sql` (cross-user accept RPC deadlock/lock-order fixes) + client double-tap guards | loan-concurrency: **Yes** — `full_tracker` repayments FAIL until applied (client already calls `apply_loan_remaining_delta`). group-concurrency, kameti-draw: ship with client. settlement-row-locks: server-only, no client contract change (per header, the loan-row lock behavior was already correct; this closes a deadlock + a missing lock + a lock-order inversion). | `src/lib/loanRemainingDelta.ts` (new), `src/stores/loanStore.ts`, `src/stores/transactionStore.ts`, `src/pages/RepaymentModal.tsx`, `src/pages/LoanDetailPage.tsx`, `src/pages/QuickEntry.tsx`, `src/components/AllocateRepaymentModal.tsx` (loans); `src/lib/groupSettlementResult.ts` (new), `src/stores/splitStore.ts`, `src/pages/GroupSettleUpModal.tsx`, `src/components/AllocateSettlementModal.tsx` (groups); `src/lib/committeeDraw.ts`, `src/stores/committeeStore.ts`, `src/components/CommitteeVerifyDraw.tsx`, `src/pages/KametiDetailPage.tsx`, `src/pages/CreateCommitteeModal.tsx` (kameti); `src/lib/useSubmitGuard.ts` (new — double-tap re-check + idempotency key), applied across ~25 submit surfaces (see diff stat) | settlement-row-locks: Y (Docker `postgres:15`, header says "faithful" reproduction). Others: not stated in header. | Kameti draw fix is single-phase (server-generated seed inside the same transaction, not two-RPC commit-reveal) — header explains why commit-reveal buys nothing here (organiser never sees the seed pre-commit). |
| C11 | Splits-only repayment records are best-effort | client only (depends on `loan-concurrency`) | Depends on loan-concurrency | `src/stores/loanStore.ts`, `src/stores/transactionStore.ts` | N/A | Direct recurrence-prevention for the documented "vanished payment records" incident class (`tasks/lessons.md`). |
| Extra | Owner can hard-delete a shared group outright (C2's R2 residual) | `supabase-migration-audit-p0-group-deletion-guard.sql` | Must apply **AFTER** `group-ledger-integrity.sql` (Section 0 of the file refuses to install otherwise) | `src/pages/GroupDetailPage.tsx`, `src/stores/splitStore.ts`, `src/lib/supabaseDb.ts`, `src/db/types.ts`, `src/lib/groupGuardErrors.ts` (new) — archive/unarchive UI | Y (throwaway PostgreSQL 15.19 with an auth shim, per header) | Order relative to `account-deletion.sql` does not matter (disjoint objects, per header's Section 0.2 interaction analysis). |

---

## 3. P1 (30-day) — status

Source: commit messages `e02f53f` (batch A) and `93f456c` (batch B), plus
`00-executive-summary.md` §6.2 for each item's original ask. All ten H-items
are landed on the branch; none has a pending SQL migration of its own beyond
what §2b of APPLY-ORDER.md already lists.

| # | Item | Outcome | Follow-ups |
|---|---|---|---|
| H1 | Observability | 82 `reportError` call sites added across stores/lib; `mutationSafety` rollback signals (+12 tests); 10s de-dupe; a Sentry scope-leak grouping bug fixed; native crash-reporting decision doc written. | Native crash reporting itself (Sentry Android / Crashlytics) is a **decision doc**, not shipped — see `docs/native-crash-reporting.md` and §6 below. |
| H2 | Product analytics | Consent-gated PostHog EU (default off), structural PII guard, lazy-loaded; 28-event typed catalog with 13 wired; consent toggle + feedback/WhatsApp card components; data-safety docs updated. | 15 of 28 catalog events still unwired. PostHog project key + the feedback WhatsApp number are env vars nobody has set yet — founder action (§6). |
| H3 | Android launch chain | Cold-start deep links via `getLaunchUrl`; `assetlinks.json` published (placeholder fingerprints); `/kameti/witness` autoVerify; release-build guard for `google-services.json`; contextual notification-permission prompt. | `assetlinks.json` fingerprints are placeholders — need the real Play App Signing SHA-256 (founder action). `google-services.json` itself still not provided. |
| H4 | Data layer | Mirror dirty-flag + blocking incremental sync (per-expense payload ~1MB → ~2KB); 20s resume cooldown; money tables added to resume refresh; keyset pagination with truncation detection (`fetchAllPages`); `onRefreshed` hook. | None recorded beyond what shipped. |
| H5 | i18n integrity | Default language flipped to roman Urdu (single `DEFAULT_LANGUAGE` constant, explicit choices win); ~460 hardcoded strings across 36 files moved into `{ur, en}`; `profiles.lang` migration + client sync (`p1-profile-lang.sql`); ESLint ratchet against bare JSX literals. | 197 bare-literal violations remain across 9 files, tracked as an explicit ratchet allowlist in `eslint.config.js` — not yet zero. Server-side push-text localization is a separate, deferred item (`docs/notifications.md` §10.3). Native-speaker Roman Urdu review (register: tu/tum) is still outstanding — founder action (§6). |
| H6 | Security headers + session hygiene | HTTP security headers in `vercel.json` (CSP w/ `frame-ancestors`, HSTS, `nosniff`, Referrer/Permissions-Policy); glob-discovered store-reset registry + keep-list localStorage sweep; push-token/reminder teardown before sign-out. | None recorded beyond what shipped. |
| H7 | PWA input integrity | `interactive-widget=resizes-content` viewport; `visualViewport` keyboard-inset handling; back-stack layers for sheets/search/scanner; `history.state.idx`-based back; scroll restoration on POP. | None recorded beyond what shipped. |
| H8 | UX honesty | EMI plan no longer silently dropped on linked loans; transactional backup import with a key allowlist; sync card gated behind `VITE_ENABLE_OUTBOX`; Analytics uses the house loading pattern; single primary-currency fallback; `preview_group_by_code` RPC + preview card (`p1-group-preview.sql`). | None recorded beyond what shipped. |
| H9 | Version-skew gate | `app_config` table (`p1-app-config.sql`) + `UpdateRequiredScreen` + `__APP_VERSION__` Vite define; fails open by design until a human raises the floor. | Gate is inert until the founder deliberately raises `min_supported_version`/`_code` — not before this release is 100% live on both surfaces (§1 step 8). |
| H10 | Money-value bounds | 37 CHECK constraints + a single-source currency whitelist + a `group_expenses.splits` sum trigger (`p1-money-bounds.sql`); client-side amount bounds as the first line of `processTransaction`; split checks. | Pre-flight F1/F2 queries (APPLY-ORDER.md §2b row 4) must be run against production before this migration ships — not yet done, since production has not been touched. |

Gates recorded at the P1 batch B commit: `tsc -b` clean, 1386 tests green,
`eslint` 0 errors.

---

## 4. P2 (90-day) — status

Source: commit `93f456c` and the seven docs written alongside it
(`docs/performance.md`, `docs/notifications.md`, `docs/trust-and-safety.md`,
`docs/testing-the-trust-boundary.md`, `docs/ops-checklist.md`,
`docs/release-and-rollback.md`, `docs/design-system.md`), plus
`00-executive-summary.md` §6.3 for each item's original ask.

| # | Item | Status | Detail / source |
|---|---|---|---|
| M1 | Decide the offline story | **Founder decision pending.** | Not resolved either way — the outbox scaffold (`src/lib/outboxRunner.ts`) is neither finished nor deleted. The audit's own long-term alternative (move multi-leg money moves into Postgres RPCs) is in progress as P3 L4 instead (see below), which reduces how much the outbox decision matters but does not replace it — see §6. |
| M2 | Performance program | **(a) and (b) done, (c) in progress.** | (a) vendor chunk splitting + CI bundle-size script + self-hosted Geist: entry chunk 1.27 MB → 282 KB raw / 367 → 81 KB gzip (`docs/performance.md` §1–§5). (b) lazy Sentry SDK (−82 KB raw off entry), Realtime Broadcast for `accounts`/`transactions`/`loans` behind `VITE_REALTIME_BROADCAST` (`p2-realtime-broadcast.sql`), boot-load dedupe (−6 to −11 requests per cold boot) (`docs/performance.md` §6). (c) still open per `docs/performance.md` §7: transactions-list virtualization, SQL-side analytics aggregates, the four eagerly-mounted app-level modals, boot RPC consolidation, and wiring `check-bundle-size.mjs` into `package.json`/CI. |
| M3 | Accessibility floor | **Core done, rest open.** | Accessible `Modal` (dialog semantics, focus trap, Escape, restore-focus, browser-back layer) landed; WCAG-passing token values in both themes; `PageHeader` token background fixed (`docs/accessibility-contrast.md`). Not yet done: `lang` attribute following the active language, `jsx-a11y` + an axe CI step, the full dark-ramp contrast pass beyond what shipped. |
| M4 | Design-system truth | **Done.** | `design-tokens.ts` cut from 264 to 35 lines (~250 dead CSS lines removed); `Button.tsx` moved onto house tokens; `docs/design-system.md` written as the single source of truth. |
| M5 | Notification maturity | **Backend done, client UI pending.** | `p2-notification-maturity.sql`: `member_left` fan-out, kameti `draw_completed`/`round_due`/`payout_due`, `notification_prefs` (mute + quiet hours + tz), Android channels + collapse keys, `notification_href_for()`, 90-day pruning — 31 assertions in `60-notification-maturity.sql`. Three UI pieces are named but not built (`docs/notifications.md` §8): per-group mute toggle (`GroupDetailPage.tsx`), quiet-hours + push section (`SettingsPage.tsx`), and the bell-badge fix (`InboxAction.tsx`, logic already written and tested in `notificationCounts.ts` but not wired in). |
| M6 | Trust & safety | **SQL done, client wiring in progress.** | `p2-trust-safety.sql`: `blocks` + `reports` tables enforced at 13 cross-user entry points, server-hashed/expiring/rotatable kameti witness tokens, receipts bucket 5 MiB/MIME cap + purge on deletion, rejection-reason normalization — Docker-validated (`docs/trust-and-safety.md` §7, 62 functional-smoke assertions). Client side is explicitly **not built yet** per that doc's own header: block/report actions on Inbox/contact sheet/group member list, the "Blocked people" Settings list, and the witness-link rotate/revoke/initials-only UI (§4 of that doc lists exact file/line insertion points). |
| M7 | Test the trust boundary | **DB suite done, Playwright in progress.** | `supabase/tests/` — a from-scratch Postgres, the full corpus applied in canonical order, then attacked as role `authenticated` by multiple users: 183 assertions, wired into CI (`.github/workflows/db-tests.yml`) on every push/PR to `main` (`docs/testing-the-trust-boundary.md`). It found and fixed a real defect in place (the kameti-draw pre-draw slot gap — see APPLY-ORDER.md §2b). `playwright.config.ts` exists at the repo root; the onboarding + QuickEntry + cross-user-request smoke walk across both app modes it's meant to drive is not yet written. |
| M8 | Unify the calendar + product opportunities | **Calendar half done, product half in progress.** | `localDate.ts` + the migration of ~20 UTC `toISOString().slice(0,10)` call sites (recurring runner, monthly wrap, streaks, Subscriptions) to local-date math is done (`docs/performance.md`-adjacent commit; `src/lib/localDate.ts` + `localDate.test.ts`). The product half of M8 (guest members O4, debt-minimization settle-up + unified who-owes-me O7, per-record edit history O10, kameti post-creation editing, consolidated-repayment lump marker) has not shipped. |
| M9 | Ops floor | **Done** (the shippable slice — see the caveats). | Dependabot (`.github/dependabot.yml`), a security workflow (npm audit + gitleaks with verified fingerprints, `.gitleaks.toml` / `.gitleaksignore`), `docs/release-and-rollback.md`, `docs/ops-checklist.md`, `CLAUDE.md` committed. **Caveats, not yet closed:** deploy gating (branch protection + Vercel "Ignored Build Step") is a GitHub/Vercel dashboard setting this repo cannot commit — `docs/release-and-rollback.md` §5 says today "push passed CI" is advisory, not enforced. OTA (Capgo) is explicitly deferred, not "not yet built" — `docs/release-and-rollback.md` §6 says adopt only after this batch has stabilized and one full Play release cycle has run. Keystore-backup confirmation is a founder action (`docs/ops-checklist.md`), not verifiable from the repo. |

---

## 5. P3 — status

Source: `docs/server-side-money-engine.md`, `docs/trust-and-safety.md`
(khata-link is the P2-adjacent half of L2), `docs/release-and-rollback.md`
§4, `docs/performance.md`, and `00-executive-summary.md` §6.4.

| # | Item | Status | Detail / source |
|---|---|---|---|
| L1 | Phone/OTP-first auth + onboarding collapse | **Design doc only.** | No migration, no client change. Blocks both H5's follow-up (native Urdu review still needed regardless) and M6's residual (block is per-account, defeated by delete-and-re-register — `docs/trust-and-safety.md` §6.3). SMS provider choice is a founder decision (§6). |
| L2 | Counterparty living-balance link ("khata link") + WhatsApp nudge loop | **Second half done (migration written), pending client wiring.** | `supabase-migration-p3-khata-link.sql` — capability-URL, read-only, per-person ledger page, reusing the witness-link security pattern; strict six-field projection; fully additive, inert until a link is minted. The automatic WhatsApp share-prompt-at-save half (the first half of O2) is explicitly deferred in the migration's own header, and the client route/UI for the link page itself is not yet wired. |
| L3 | Monetization mechanism | **Design doc only.** | No billing code written. Pricing/entitlement model is a founder decision (§6) — the audit's own concern ("a promise string, not a mechanism") stands until this ships. |
| L4 | Progressive server-side money engine | **Transfer + repayment done (flag-gated); loan-create in progress.** | Step 1 `transfer_between_accounts` (`p3-atomic-transfer.sql`, `VITE_ATOMIC_TRANSFER`) and step 2 `record_loan_repayment` (`p3-atomic-repayment.sql`, `VITE_ATOMIC_REPAYMENT`) are both built, Docker-validated (30 + 132 in-session assertions respectively — APPLY-ORDER.md §2b), and both flags default off. Step 3 (branch 4 in the risk-ordered table, `loan_given`/`loan_taken`) is next per `docs/server-side-money-engine.md` §6 and is in progress. Steps 4 (`goal_contribution`) and 5 (card-bill pay) are not started. |
| L5 | Staging environment + environment separation | **Runbook written, not stood up.** | `docs/release-and-rollback.md` §4 names the exact recommendation (a second Supabase project as staging, replayed via the Supabase CLI or Studio in `apply-order.txt` order) and what it closes (real PostgREST behavior, `max_rows` truncation risk). Requires the founder to actually create the project and grant CLI/Vercel-env access (§6). |
| L6 | Kameti-led marketing + Splitwise-refugee campaign + iOS evaluation | **Doc only.** | `docs/go-to-market.md` written. No campaign executed, no iOS evaluation performed — both are explicitly sequenced after the trust story ships and analytics can measure it. |
| L7 | Business-invariant monitoring | **Done.** | `supabase-migration-p3-invariant-monitoring.sql` — nightly reconciliation (`run_reconciliation()`, `reconciliation_findings`, `reconciliation_summary()`), read-only, RLS-on/zero-policies, applies LAST. First run is a census, not an alarm (§1 step 11, APPLY-ORDER.md §2b). |

---

## 6. Founder decisions/actions

Consolidated from every doc above — the P0 tracker's original §3/§4, plus
what P1/P2/P3 added. Grouped as **decisions** (pick an option, product
consequence either way) and **actions** (no judgment call, just needs doing
by someone with access this agent doesn't have).

### 6.1 Decisions

| # | Decision | Detail | Source |
|---|---|---|---|
| D1 | C2/R1 — account deletion with an unsettled shared-group balance | A member can delete their account while carrying a non-zero balance in a shared group; the debt survives but becomes **unsettleable** (the departed member is `'left'`, a settlement needs both parties connected), which also blocks the counterparty from `leave_group`. Options: **(a)** refuse deletion until settled, mirroring `leave_group`'s gate — **lead recommends this pre-launch** — or **(b)** allow deletion + a write-off/absorb RPC that redistributes the residual with a `group_event` recording it. (a) sits in tension with the app's "permanent deletion" promise, which is why the migration left it open. | `supabase-migration-audit-p0-account-deletion.sql` header; §2 table C2 above |
| D2 | C6 — pre-existing conscripted `'connected'` group members | `consent-guards.sql` changes future owner-adds to land as `'invited'` (requiring acceptance); it does **not** retroactively migrate members already `'connected'` without ever accepting. Verification query 4.6 in that file produces a census. Decide: grandfather them, or run a one-time backfill/notification pass. | `supabase-migration-audit-p0-consent-guards.sql` header |
| D3 | R3 (C2) — departed member's display-name retention | `group_members.display_name` is deliberately kept on a deleted user's row so the shared ledger stays readable; the row no longer links to any account or auth identity. Confirm this is consistent with the published privacy policy before launch (flagged, not blocking). | `supabase-migration-audit-p0-account-deletion.sql` header |
| D4 | Kameti legacy/test draws | Pre-fix test/demo draw data (from before `audit-p0-kameti-draw.sql` and its in-place amendment, APPLY-ORDER.md §2b) should probably be deleted rather than carried forward as if it were a provably-fair draw. Decide whether to purge it before marketing "provably fair," and if so, which rows qualify. | Deferred-items list (original P0 tracker), APPLY-ORDER.md §2b |
| D5 | M1 — the offline story | Either finish the outbox (`src/lib/outboxRunner.ts`, persist pending compensations in Dexie, replay on connectivity, behind an integration-test harness) or delete the scaffold and be honest that Hisaab needs a network to record money. P3 L4 (the server-side money engine) reduces how much this matters for the flows it covers, but does not replace the decision for what's left. | `00-executive-summary.md` M1; `docs/server-side-money-engine.md` §6 "What this does not solve" |
| D6 | L1 — SMS/OTP provider | Phone/OTP-first auth is a P3 design doc only; picking an SMS provider (cost, Pakistan/Gulf deliverability, Supabase Auth's supported list) is the first concrete step and hasn't been made. | `00-executive-summary.md` L1 |
| D7 | L3 — pricing / entitlement model | Premium-AI monetization is a design doc with no billing code; needs an actual price point and entitlement mechanism decided before it can ship. | `00-executive-summary.md` L3 |
| D8 | VITE_* flag rollout order | Four independent flags now exist (`VITE_ATOMIC_TRANSFER`, `VITE_ATOMIC_REPAYMENT`, `VITE_REALTIME_BROADCAST`, plus the always-on `app_config` gate). The documented rule is: one flag per release cycle, each only after its own pre-flight query, transfer before repayment (repayment's rollout doc says so explicitly), and the `app_config` floor raised only after both surfaces are 100% live. This is written down (§1 above, APPLY-ORDER.md §2b) but needs someone to actually own sequencing it rather than flipping several at once. | `docs/server-side-money-engine.md` §5/§10; §1 step 4 above |

### 6.2 Actions (no judgment call — needs doing)

| # | Action | Why | Source |
|---|---|---|---|
| A1 | Run `supabase-audit-p0-verification.sql` in Supabase Studio against **production** and share the output | The prerequisite for treating any "fixed" claim in this tracker as confirmed in prod, not just in Docker (C1) | §1 step 1–2 above |
| A2 | Connect the Supabase CLI to the project | Long-term fix for C1 — moves migrations to a numbered, tracked, CI-applied model instead of hand-pasting into Studio | `00-executive-summary.md` C1; `docs/release-and-rollback.md` §4 |
| A3 | Apply every file in `supabase/tests/apply-order.txt` order, in one window, with the matching client build | Covers all 23 pending migrations (11 audit-p0 + 12 P1/P2/P3), not just the original 11 | §1 step 3 above; APPLY-ORDER.md §2b |
| A4 | After merge + push (web) and `npm run build && npx cap sync android`, run the Gradle AAB build locally | `gradlew` needs a loopback socket the agent sandbox blocks — see `docs/updating-the-android-app.md` | CLAUDE.md "Shipping rule" |
| A5 | Rotate the Supabase anon key | `git log` on `main` still contains commits (`88ed40c`, `dfea60e`) with the production anon key baked into build artifacts; RLS limits the blast radius but rotation is still recommended defense-in-depth and has not been done | `docs/testing-the-trust-boundary.md` §7 (secret-scanning section) |
| A6 | Set the PostHog project key + the feedback WhatsApp number as env vars | H2's analytics/feedback work is built and consent-gated but inert without these; 15 of 28 catalog events also still need wiring | §3 H2 above |
| A7 | Provide the real Play App Signing SHA-256 fingerprint for `assetlinks.json`, and a real `google-services.json` | H3's Android launch-chain work currently ships placeholder fingerprints and no Firebase config; deep links and push both need these to work on a real device | §3 H3 above |
| A8 | Native-speaker Roman Urdu review (register: tu/tum vs aap across adjacent strings) | H5 moved ~460 strings into `{ur, en}` but nobody has proofread them for register consistency; also named in the original audit's "Human validation" gap list | `00-executive-summary.md` §7.D item 16 |
| A9 | Confirm Supabase org / Vercel project env access is available for a second (staging) project | L5's recommendation can't be executed without someone actually provisioning it | §5 L5 above; `docs/release-and-rollback.md` §4 |
| A10 | Confirm Play App Signing enrollment and Supabase PITR/backup settings | Both are dashboard states this repo cannot read or set; `docs/ops-checklist.md` §1.3 and §5 give the exact checks to run and where to record the result | `docs/ops-checklist.md` §1.3, §5 |
| A11 | Decide the `@sentry/capacitor` adoption window and run its Gradle-build verification | A conditional drop-in for H1's native crash-reporting gap — every version constraint checks out on paper but the native Android path is unproven without a real Gradle build (same sandbox limitation as A4); `docs/native-crash-reporting.md` §4 is the checklist, with Firebase Crashlytics as the named fallback if it fails | `docs/native-crash-reporting.md` §Decision, §4 |
| A12 | Verify the Android keystore backup exists and is restorable | Losing `hisaab-upload.jks` or its passwords permanently ends the ability to publish updates to the existing Play listing | `docs/ops-checklist.md` §1 |
| A13 | Own the trust-and-safety report queue | `public.reports` has no operator console by design (INSERT-only for clients); someone has to run the SQL query in `docs/trust-and-safety.md` §3 periodically once M6's client side ships | `docs/trust-and-safety.md` §3, §5 (Play UGC policy mapping) |

---

## 7. Known open risks

Deduped from every doc's own open-risk section. Not a to-do list — recorded
so nobody re-discovers the same gap and re-litigates it as new.

- **Production drift is the largest unclosed gap in the entire batch.** Every Docker/throwaway-DB validation in this tracker proves the SQL composes with itself; none of it proves what production actually has applied. Nothing closes this except A1. (APPLY-ORDER.md §7, `docs/release-and-rollback.md` §4, `docs/trust-and-safety.md` §7)
- **PostgREST is untested end-to-end everywhere.** Every Docker session in this batch ran raw SQL as role `authenticated` — named-argument RPC binding, `jsonb` return-shape mapping, and whether `DETAIL` reaches `PostgrestError.details` are unverified for every new RPC (join-abuse-limits, consent-guards, group-preview, atomic-transfer, atomic-repayment, khata-link, trust-safety's rotate/revoke). Staging smoke-testing through a real client is the named gap-closer for all of them. (APPLY-ORDER.md §7; `docs/server-side-money-engine.md` §4, §9)
- **Tier-3 push is still believed off in production.** Every notification anti-fatigue improvement (M5) is invisible until Firebase + `app_push_config` are actually configured; this predates the current batch and nothing in it changes that. (`docs/notifications.md` §10.1)
- **No web push exists at all.** A PWA-only user only learns about a cross-user event if a tab is open; channels/collapse-keys/quiet-hours are Android-only concepts. (`docs/notifications.md` §10.2)
- **Push text is still English**, even after `profiles.lang` exists — nothing reads it server-side yet; only in-app/tier-2 notifications are correctly localized. (`docs/notifications.md` §10.3)
- **Block is per-account, and accounts are free.** A harasser who deletes and re-registers gets a clean slate; nothing in SQL can fix this without phone verification (L1/H10's OTP work, itself a founder decision — D6). (`docs/trust-and-safety.md` §6.3)
- **The "merely a member" carve-out in the block model is a deliberate, real hole.** A blocked user can still join a group whose *owner* they haven't blocked, even if the blocker is a member; the alternative (letting one member exclude others) was judged worse. Confirmed as intentional, not a bug — but it must be stated correctly in the block-sheet copy or users will believe they're more protected than they are. (`docs/trust-and-safety.md` §6.2)
- **Receipt deletion is a logical purge, not a physical one.** Deleting a `storage.objects` row removes the index entry but does not itself issue a delete against the underlying blob; a real guarantee needs a storage-API purge, not yet automated. Do not claim otherwise in the privacy policy. (`docs/trust-and-safety.md` §6.1)
- **Unbounded receipt object count is still open** — the 5 MiB size cap doesn't stop one account writing many small objects under arbitrary names in its own folder. (`docs/trust-and-safety.md` §6.6)
- **No true SQL rollback exists past `group-ledger-integrity.sql`** in the dependency chain — forward-fix is the only safe path for 7 of the 11 audit-p0 migrations plus everything that depends on them; reverting risks reopening a closed vulnerability or breaking the client currently live. (`docs/release-and-rollback.md` §3.3)
- **Nothing currently stops a red `main` from deploying to production** — Vercel's git integration is independent of CI status; branch protection + an Ignored-Build-Step gate are both outside-the-repo settings, not yet turned on (M9 caveat, A2-adjacent). (`docs/release-and-rollback.md` §5)
- **The kameti notification sweep has no alerting if it stops running** — `kameti_round_due`/`kameti_payout_due` depend on a scheduler (pg_cron or a dashboard cron) that isn't guaranteed to exist; check `cron.job_run_details` rather than assuming silence means nothing due. (`docs/notifications.md` §10.5)
- **Kameti reach depends on the organiser having linked contacts** — a committee typed as plain names notifies nobody, with no UI telling the organiser. (`docs/notifications.md` §10.6)
- **`notification_prefs` has no UI yet** — mute/quiet-hours exist server-side and are unreachable by a normal user until M5's client follow-ups ship (§4 above). (`docs/notifications.md` §10.7)
- **Realtime Broadcast's V6 check cannot be satisfied by Docker** — it needs a live Supabase project and a real save; treat "V1–V5 clean" as necessary, not sufficient, before enabling `VITE_REALTIME_BROADCAST` on any surface. (APPLY-ORDER.md §2b; `docs/performance.md` §6.4)
- **M9's OTA / deploy-gating / keystore items are dashboard or vendor decisions this repo cannot verify from source** — see A9–A12 above; treating M9 as fully closed would be wrong even though its shippable SQL/CI/doc slice is done. (`docs/release-and-rollback.md` §5–§6, `docs/ops-checklist.md`)
- **The card-bill-pay branch of the server-side money engine (L4 step 5) forks the allocation engine if done naively** — `allocateBillPayment`/`clampCardCredit` is real tested business logic; the right shape (plan-on-client, apply-on-server) is a bigger design decision than steps 1–3 and hasn't been made yet. (`docs/server-side-money-engine.md` §6 "Order, by risk")
- **`profiles.lang` push localization is a precondition, not a fix** — the column exists and the client writes it, but no trigger or edge function reads it yet; closing the gap is tracked as a separate, larger unit of work. (`supabase-migration-p1-profile-lang.sql` header)

---

*Maintained by the engagement lead as the founder's single tracker for P0–P3 remediation. See [00-executive-summary.md §6](00-executive-summary.md) for the original findings this tracker implements, and [APPLY-ORDER.md](APPLY-ORDER.md) for the canonical migration apply sequence and integration-run results.*
