# P0 Remediation Tracker — Audit 2026-09

**Scope:** items C1–C11 from [00-executive-summary.md §6.1](00-executive-summary.md) (the pre-launch, blocking list), plus two extras picked up during implementation (group-deletion-guard, C10's settlement-row-locks half). All work lives on branch `audit-p0-remediation`, currently **uncommitted working-tree changes** (not merged into `main`, not pushed — pushing `main` auto-deploys the web app to Vercel via Vercel's Git integration, so this branch is deliberately kept off `main` until the release checklist below is run).

Migration apply order and integration-run results: **[APPLY-ORDER.md](APPLY-ORDER.md)** (companion doc — read it before applying anything; not duplicated here).

Source of truth for what each migration does: the header comment of each `supabase-migration-audit-p0-*.sql` file at the repo root. This tracker summarizes those headers; the SQL files themselves are canonical.

---

## 1. How to release this

Do these in order. Do not skip or reorder — several migrations are BREAKING in one or both directions (see §2).

1. **Run `supabase-audit-p0-verification.sql`** in Supabase Studio → SQL Editor (read-only, safe to run any time) against production. Export the full result grid.
2. **Paste the output to Claude for review.** Any row whose `result` starts with `!!` needs founder attention before proceeding — it means production is not in the state the other 11 migrations assume.
3. **Apply the 11 remaining `supabase-migration-audit-p0-*.sql` files in the order given in [APPLY-ORDER.md](APPLY-ORDER.md)** via Supabase Studio SQL Editor (there is no migration runner in this repo — see `CLAUDE.md`). Each file's own header also states its prerequisites; APPLY-ORDER.md is the merged, whole-batch sequence.
4. **Resolve the founder decisions in §3** before or during this window — at minimum acknowledge them; C2's R1 (unsettleable debt on deletion) should be decided before merge, not after.
5. **Merge `audit-p0-remediation` → `main` and push.** Web deploys automatically via Vercel on push to `main`.
6. **Android:** `npm run build && npx cap sync android`, then hand the Gradle AAB build off to the founder (`gradlew` cannot run inside the agent sandbox — see `docs/updating-the-android-app.md` for the exact steps, version bump, and signing).
7. **Coordinate the window.** Steps 3 and 5–6 must land close together: client-before-SQL breaks invites/linking (consent-guards, join-abuse-limits contracts change shape); SQL-before-client is fine to apply early EXCEPT where a migration's header says otherwise (loan-concurrency: `full_tracker` repayments start failing the moment it's applied until the matching client ships).
8. **Smoke test** after both are live:
   - Full-tracker: record a repayment on a loan from two browser tabs (same account) — confirm the second gets a conflict, not a silent double-debit.
   - Splits-only: record a group settlement from two tabs against the same debt — confirm the second is rejected, not an over-settle.
   - Join a group by code, then by invite link — confirm both still work end-to-end (contract changed shape in join-abuse-limits + consent-guards).
   - Draw a kameti — confirm the draw button is inert after the first draw (no re-roll).
   - Record a linked (cross-user) udhaar entry in a non-AED/PKR currency (e.g. SAR) — confirm it saves.
   - Delete a test account that is a member (not owner) of a shared group with a non-zero balance — confirm the group's ledger survives for the remaining members.
   - Trigger a group notification (add an expense in a 2-person group) — confirm the other member receives it and it renders in the active language.
   - PIN: set a PIN, background the app 60s+, confirm the lock screen gates re-entry; confirm cold start also gates.

---

## 2. Per-item status

Effort/impact framing follows §6.1 of the executive summary. "Breaking" is as declared in the migration's own header (search each file for `BREAKING`).

| # | Item | Migration file(s) | Breaking | Client files touched (evidence: `git diff --stat main`, `grep` for RPC/module usage) | Docker/throwaway-DB validated (per header) | Open follow-ups |
|---|------|--------------------|:---:|----------------------------------------------------------------------------------------|:---:|------------------|
| C1 | Prod schema unprovable — verification + CLI adoption | `supabase-audit-p0-verification.sql` (read-only) | No | — (SQL-only; runbook at [P0-C1-runbook.md](P0-C1-runbook.md)) | Y (PostgreSQL 15, both artifact-present/absent branches exercised) | **USER ACTION:** run it in Supabase Studio, paste output for review. Supabase CLI migration adoption (numbered, tracked, CI-applied) is still pending — blocked on the user connecting the Supabase CLI to the project. |
| C2 | Account deletion cascades into shared-group ledgers | `supabase-migration-audit-p0-account-deletion.sql` | Not flagged BREAKING (additive: FK CASCADE→SET NULL, columns made nullable) | `src/pages/GroupDetailPage.tsx`, `src/stores/splitStore.ts`, `src/lib/supabaseDb.ts`, `src/db/types.ts` (all reference `transfer_group_ownership` — the "Assign another admin" UI) | Y (throwaway Postgres 15, `supabase-schema.sql` + `reconciliation` loaded) | **PRODUCT DECISION** open — see §3.1. Header also files two smaller residuals (R2: owner can still hard-delete a shared group outright — closed separately by group-deletion-guard below; R3: departed member's `display_name` is deliberately retained on ledger rows — confirm against privacy policy before launch). |
| C3 | False listing claims (PIN / offline / currency) | none (docs + client only) | N/A | `docs/play-store-listing.md`, `docs/play-store-data-safety.md`, `docs/privacy-data-safety-inventory.md`, `RELEASE.md`; PIN wiring: `src/App.tsx`, `src/pages/PinLockScreen.tsx`, `src/stores/authStore.ts`, `src/lib/pinCrypto.ts` (new, PBKDF2 150k salted) | N/A | Listing claims corrected; PIN now actually gates cold start + 60s background + is asked for on re-auth. The PIN claim should return to the public store listing only after a device-verification pass (§7.C of the executive summary — no device farm has run yet). |
| C4 | `group_settlements` FOR ALL policy lets ex-members falsify the ledger | `supabase-migration-audit-p0-group-ledger-integrity.sql` | Not flagged BREAKING | RLS/trigger-only; no direct client dependency (client already writes rows through the same shape) | Not stated in header | None recorded beyond what's in the file. |
| C5 | Join-code brute-force limiter is a no-op; join codes never expire | `supabase-migration-audit-p0-join-abuse-limits.sql` | **Yes** — `join_group_by_code` return type changes `TABLE(...)` → `jsonb`, never raises for a business outcome | `src/pages/JoinGroupModal.tsx`, `src/pages/JoinGroupPage.tsx`, `src/stores/splitStore.ts`, `src/lib/collaboration.ts`, `src/lib/joinCodeStatus.ts` (new), `src/components/GroupCard.tsx` (Refresh-code UI) | Not stated in header | Join codes now expire 14 days; Refresh-code UI shipped in `GroupCard.tsx`. |
| C6 | Cross-user consent predicates are client-writable | `supabase-migration-audit-p0-consent-guards.sql` | **Yes** — see the 4 breaking changes listed in the migration's own header: (1) `persons.linked_profile_id` PATCH now rejected (42501) — use `link_contact_by_code` / `link_contact_by_discovery` / `unlink_contact_profile`; (2) owner-inserted `group_members` land as `'invited'`, not visible until accepted; (3) `group_invites` `select('*')` → permission denied, explicit columns only; (4) `accept_group_invite` — renamed argument, raw token (not hash), jsonb return | `src/pages/ContactDetailSheet.tsx`, `src/pages/ContactsPage.tsx`, `src/stores/personStore.ts`, `src/lib/contactLinkStatus.ts` (new), `src/lib/contactVerification.ts` (new), `src/pages/GroupDetailPage.tsx`, `src/pages/JoinGroupModal.tsx`, `src/pages/JoinGroupPage.tsx`, `src/components/GroupInviteModal.tsx`, `src/components/VerifiedBadge.tsx`, `src/lib/collaboration.ts`, `src/lib/supabaseDb.ts` | Not stated in header | **DATA DECISION** open — see §3.2. Pre-existing conscripted `'connected'` group members are NOT auto-migrated to `'invited'`; migration's verification query 4.6 lists the affected rows for manual triage. |
| C7 | Notification fan-out is client-side and forgeable | `supabase-migration-audit-p0-notifications.sql` | Ships with client (fan-out moves server-side; rows now also carry `template`+`params`) | `src/lib/notificationContent.ts` (new — renders template+params through i18n), `src/lib/instantNotify.ts`, `src/pages/InboxPage.tsx`, `src/pages/ActivityPage.tsx` | Not stated in header | Group notifications now render in the active language via `template`+`params`; `title`/`body` kept as fallback for legacy rows and the push pipeline. |
| C8 | Session hygiene (sign-out failure, re-auth, VerifiedBadge) | none (client only) | N/A | `src/stores/supabaseAuthStore.ts`, `src/pages/SettingsPage.tsx`, `src/components/VerifiedBadge.tsx` | N/A | — |
| C9 | Cross-user currency CHECK hard-limited to AED/PKR | `supabase-migration-audit-p0-currencies.sql` | Apply **BEFORE** client deploy (per header) | `src/pages/AddLoanModal.tsx`, `src/pages/SettleLinkedLoanModal.tsx`, `src/db/types.ts` | Not Docker-validated; header states widen-only CHECK is safe by construction (no existing row can become invalid) | None recorded. |
| C10 | Concurrency floor (loans, groups, kameti, settlements, client double-tap) | `supabase-migration-audit-p0-loan-concurrency.sql` (loans) · `supabase-migration-audit-p0-group-concurrency.sql` (group expense version + settlement cap) · `supabase-migration-audit-p0-kameti-draw.sql` (draw binding) · `supabase-migration-audit-p0-settlement-row-locks.sql` (cross-user accept RPC deadlock/lock-order fixes) + client double-tap guards | loan-concurrency: **Yes** — `full_tracker` repayments FAIL until applied (client already calls `apply_loan_remaining_delta`). group-concurrency, kameti-draw: ship with client. settlement-row-locks: server-only, no client contract change (per header, the loan-row lock behavior was already correct; this closes a deadlock + a missing lock + a lock-order inversion). | `src/lib/loanRemainingDelta.ts` (new), `src/stores/loanStore.ts`, `src/stores/transactionStore.ts`, `src/pages/RepaymentModal.tsx`, `src/pages/LoanDetailPage.tsx`, `src/pages/QuickEntry.tsx`, `src/components/AllocateRepaymentModal.tsx` (loans); `src/lib/groupSettlementResult.ts` (new), `src/stores/splitStore.ts`, `src/pages/GroupSettleUpModal.tsx`, `src/components/AllocateSettlementModal.tsx` (groups); `src/lib/committeeDraw.ts`, `src/stores/committeeStore.ts`, `src/components/CommitteeVerifyDraw.tsx`, `src/pages/KametiDetailPage.tsx`, `src/pages/CreateCommitteeModal.tsx` (kameti); `src/lib/useSubmitGuard.ts` (new — double-tap re-check + idempotency key), applied across ~25 submit surfaces (see diff stat) | settlement-row-locks: Y (Docker `postgres:15`, header says "faithful" reproduction). Others: not stated in header. | Kameti draw fix is single-phase (server-generated seed inside the same transaction, not two-RPC commit-reveal) — header explains why commit-reveal buys nothing here (organiser never sees the seed pre-commit). |
| C11 | Splits-only repayment records are best-effort | client only (depends on `loan-concurrency`) | Depends on loan-concurrency | `src/stores/loanStore.ts`, `src/stores/transactionStore.ts` | N/A | Direct recurrence-prevention for the documented "vanished payment records" incident class (`tasks/lessons.md`). |
| Extra | Owner can hard-delete a shared group outright (C2's R2 residual) | `supabase-migration-audit-p0-group-deletion-guard.sql` | Must apply **AFTER** `group-ledger-integrity.sql` (Section 0 of the file refuses to install otherwise) | `src/pages/GroupDetailPage.tsx`, `src/stores/splitStore.ts`, `src/lib/supabaseDb.ts`, `src/db/types.ts`, `src/lib/groupGuardErrors.ts` (new) — archive/unarchive UI | Y (throwaway PostgreSQL 15.19 with an auth shim, per header) | Order relative to `account-deletion.sql` does not matter (disjoint objects, per header's Section 0.2 interaction analysis). |

---

## 3. Decisions needed from the founder

### 3.1 C2 / R1 — account deletion with an unsettled shared-group balance

A member can still delete their account while carrying a non-zero balance in a shared group. `leave_group` would have refused this exit; account deletion (as fixed by this migration) now *preserves* the debt instead of destroying it — but the debt becomes **unsettleable**: a new settlement requires both parties to be connected members, and the departed member is `'left'`. The counterparty's own net balance stays non-zero indefinitely, which in turn blocks the counterparty from using `leave_group` themselves.

Options (from the migration's own header, which deliberately does not choose):
- **(a) Refuse deletion until settled** — mirror `leave_group`'s balance gate inside `delete_current_user`. **Lead recommends this pre-launch.**
- **(b) Allow deletion + add a write-off/absorb action** — an RPC that redistributes the departed member's residual balance across remaining members with a `group_event` recording it.

Refusing deletion on principle also sits in tension with the app's "permanent deletion" promise — that tension is exactly why the migration left it open rather than picking (a) unilaterally.

### 3.2 C6 — pre-existing conscripted `'connected'` group members

`consent-guards.sql` changes future owner-adds of members to land as `'invited'` (requiring acceptance) instead of instantly `'connected'`. It does **not** retroactively migrate members who are already `'connected'` without ever having accepted — flipping live groups' membership status could cut people out of groups they've been using. The migration's verification query 4.6 produces a census of affected rows. This needs a decision: leave as-is (grandfather them), or run a one-time backfill/notification pass.

### 3.3 R3 (C2) — departed member's display name retention

`group_members.display_name` is deliberately kept on a deleted user's row so the shared ledger stays readable ("Ali paid 500"). The row no longer links to any account or auth identity. Confirm this reading is consistent with the published privacy policy before launch (flagged, not blocking).

---

## 4. Pending user actions

- Run `supabase-audit-p0-verification.sql` in Supabase Studio against production and share the output (C1 — the prerequisite for treating any other item as "confirmed fixed" in prod).
- Connect the Supabase CLI to the project so migrations can move to a numbered, tracked, CI-applied model (C1, long-term).
- Apply all 12 `supabase-migration-audit-p0-*.sql` / verification files in [APPLY-ORDER.md](APPLY-ORDER.md) order.
- Decide 3.1 and 3.2 above.
- After merge + push (web) and `npm run build && npx cap sync android`, run the Gradle AAB build locally per `docs/updating-the-android-app.md` (cannot run in the agent sandbox — needs a loopback socket).
- Confirm R3 (§3.3) against the privacy policy text.

---

## 5. Deferred to P1+ (not part of this P0 batch)

- **M11** — multi-account rate-limit bypass (free account creation multiplies every per-user limit).
- `accept_group_invite` now has a limiter, but **linked (cross-user) requests have no per-pair pending cap**.
- Legacy mutual contact links **lose the VerifiedBadge** until a backfill is written.
- Witness-token **revoke/rotate** (kameti witness links).
- `member_left` notifications are not yet wired.
- Owner-side `group_events` localization (activity log entries the group owner sees, as opposed to member-facing notifications, are not yet localized).
- Kameti **legacy draws** — pre-fix test/demo draw data should be deleted rather than migrated.

---

*Maintained by the engagement lead as the founder's single tracker for P0 remediation. See [00-executive-summary.md §6.1](00-executive-summary.md) for the original findings this tracker implements, and [APPLY-ORDER.md](APPLY-ORDER.md) for the canonical migration apply sequence and integration-run results.*
