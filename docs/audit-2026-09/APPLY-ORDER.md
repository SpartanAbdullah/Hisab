# Canonical migration apply order — Hisaab

**Written:** 2026-09-02 · **Status:** integration-tested on PostgreSQL 16.15 in Docker, never yet applied to production together.

This repo has no migration runner and no ledger table. The 40 `supabase-migration-*.sql` files at the repo root were applied by hand in Supabase Studio over ~5 months, and **their filenames do not sort into apply order** (the documented alphabetical trap: `fix-settlement-cancel-reject` sorts next to `fix-rls-recursion` but must run after the April `phase2c-*` files it patches). This document reconstructs that historical order, derives the required order for the 2026-09-02 audit-P0 remediation batch, and records an end-to-end integration run of all of it.

---

## 1. Historical order of the 40 existing migrations

### Evidence used

| Source | Weight | Notes |
|---|---|---|
| `git log --diff-filter=A --format='%ad %H' --date=format:'%Y-%m-%d %H:%M' -- <file>` (first commit that added the file) | **Primary** | Every one of the 40 files has a clean first-add commit. Author dates run 2026-03-26 → 2026-07-26 with no inversions. |
| In-file header prerequisites (`-- Apply after …`, `-- Run ONCE … AFTER …`, `-- Prerequisites (must already be applied)`) | Corroborating | 14 files carry one. **Every one agrees with the commit-date order** — no header names a file with a later first-commit date. |
| Cross-file object dependencies (a file that `CREATE OR REPLACE`s or `DROP`s an object another file creates) | Tie-break | Used only inside same-commit groups. |
| File mtimes | **Rejected** | They correlate loosely but are checkout artifacts — e.g. `p0-launch-blockers.sql` has an mtime of Jun 24 against a first commit of May 31. Not used. |

Five groups of files share a single commit; those are ordered by dependency, marked ⟂ below.

### The order

| # | File | First commit | Ordering evidence |
|---|---|---|---|
| 0 | `supabase-schema.sql` | 2026-03-26 | Base schema. **Caveat:** later edited in-place (2026-04-19 ×2, 2026-05-13), so today's file is *not* what production first ran — see §5 "notifications-rls drift". |
| 1 | `supabase-migration-fix-rls-recursion.sql` | 2026-04-19 19:23 | ⟂ same commit as #2; #2's header says "AFTER the RLS recursion fix migration" |
| 2 | `supabase-migration-group-codes.sql` | 2026-04-19 19:23 | ⟂ header |
| 3 | `supabase-migration-notifications-rls.sql` | 2026-04-19 21:26 | ⟂ same commit as #4; order vs #4 immaterial (disjoint) |
| 4 | `supabase-migration-realtime.sql` | 2026-04-19 21:26 | ⟂ publication-only |
| 5 | `supabase-migration-join-by-code-rpc.sql` | 2026-04-22 10:51 | header: "AFTER the group-codes migration" |
| 6 | `supabase-migration-phase1-persons.sql` | 2026-04-22 22:00 | |
| 7 | `supabase-migration-phase2a-linked-profile.sql` | 2026-04-23 00:02 | ⟂ same commit as #8; adds `persons.linked_profile_id` that #8 depends on |
| 8 | `supabase-migration-phase2b-linked-requests.sql` | 2026-04-23 00:02 | ⟂ |
| 9 | `supabase-migration-phase2c-a-settlement-requests.sql` | 2026-04-23 12:55 | ⟂ same commit as #10; "-a"/"-b" naming + #10 patches #9's table |
| 10 | `supabase-migration-phase2c-b-sender-opt-in.sql` | 2026-04-23 12:55 | ⟂ |
| 11 | `supabase-migration-fix-settlement-request-rls.sql` | 2026-05-06 20:44 | patches #9's policies |
| 12 | `supabase-migration-fix-bidirectional-linked-settlements.sql` | 2026-05-08 23:52 | redeclares `linked_settlement_requests` |
| 13 | `supabase-migration-reconciliation.sql` | 2026-05-13 17:53 | |
| 14 | `supabase-migration-phase2d-sync-past-records.sql` | 2026-05-16 01:10 | |
| 15 | `supabase-migration-phase3-budgets-recurring-remittances.sql` | 2026-05-19 03:21 | header carries its own internal "Apply order:" |
| 16 | `supabase-migration-fix-group-expense-reconciliation-rpc.sql` | 2026-05-20 16:21 | header: "after supabase-migration-reconciliation.sql" (#13) |
| 17 | `supabase-migration-performance-indexes.sql` | 2026-05-25 18:26 | |
| 18 | `supabase-migration-prelaunch-hardening.sql` | 2026-05-27 01:43 | |
| 19 | `supabase-migration-incremental-sync-core.sql` | 2026-05-29 15:30 | header: "after the existing prelaunch hardening migration" (#18) |
| 20 | `supabase-migration-incremental-sync-tombstones.sql` | 2026-05-29 16:38 | follows #19 |
| 21 | `supabase-migration-p0-launch-blockers.sql` | 2026-05-31 13:30 | |
| 22 | `supabase-migration-safe-leave-group.sql` | 2026-05-31 16:52 | header: "after supabase-migration-p0-launch-blockers.sql" (#21) |
| 23 | `supabase-migration-fix-group-invite-join-rpc.sql` | 2026-05-31 20:56 | header: "after supabase-migration-p0-launch-blockers.sql" (#21) |
| 24 | `supabase-migration-enforce-active-group-transaction-members.sql` | 2026-05-31 21:44 | header: "after supabase-migration-safe-leave-group.sql" (#22) |
| 25 | `supabase-migration-safe-contact-archive.sql` | 2026-06-01 17:02 | header lists prerequisites |
| 26 | **`supabase-migration-fix-settlement-cancel-reject.sql`** | 2026-06-06 14:27 | **THE ALPHABETICAL TRAP.** Sorts 5th by filename; actually 27th. It rewrites `cancel_settlement_request` / `reject_settlement_request` created by #9/#10 (April). Applying it before them silently loses the fix. |
| 27 | `supabase-migration-linked-notifications-realtime.sql` | 2026-06-22 12:40 | ⟂ same commit as #28/#29; creates the `lsr_notify`/`ltr_notify` triggers the contact-link files then extend |
| 28 | `supabase-migration-contact-link-notify.sql` | 2026-06-22 12:40 | ⟂ creates `notify_contact_linked` |
| 29 | `supabase-migration-contact-link-reciprocal.sql` | 2026-06-22 12:40 | ⟂ replaces `notify_contact_linked` from #28 — must follow it |
| 30 | `supabase-migration-goal-target-date.sql` | 2026-06-23 09:50 | |
| 31 | `supabase-migration-custom-categories.sql` | 2026-06-23 11:27 | |
| 32 | `supabase-migration-receipts.sql` | 2026-06-23 12:23 | |
| 33 | `supabase-migration-committees.sql` | 2026-06-23 15:38 | |
| 34 | `supabase-migration-committees-phase2.sql` | 2026-06-23 15:53 | patches #33 |
| 35 | `supabase-migration-investments.sql` | 2026-07-14 21:36 | ⚠ possibly unapplied |
| 36 | `supabase-migration-settlement-emi-and-account-guards.sql` | 2026-07-22 18:11 | ⚠ possibly unapplied |
| 37 | `supabase-migration-onboarding-intent.sql` | 2026-07-23 10:01 | |
| 38 | `supabase-migration-contacts-merge-unarchive.sql` | 2026-07-24 15:43 | ⚠ possibly unapplied |
| 39 | `supabase-migration-cross-user-account-effects.sql` | 2026-07-25 16:04 | ⚠ possibly unapplied — replaces `accept_linked_request` / `accept_settlement_request` from #36 |
| 40 | `supabase-migration-connections-push-discovery.sql` | 2026-07-26 00:24 | ⚠ possibly unapplied |

### ⚠ Files project memory / trackers flag as possibly UNAPPLIED in production

Five, all from the July tail. None has ever been confirmed applied by the user:

| File | Source of the doubt |
|---|---|
| `supabase-migration-investments.sql` | memory `project_investment_tracker.md`: "needs supabase-migration-investments.sql applied" |
| `supabase-migration-settlement-emi-and-account-guards.sql` | memory `project_recovery_audit_2026_07.md`: "settlement-EMI SQL migration (user must apply)" |
| `supabase-migration-contacts-merge-unarchive.sql` | memory `project_behavior_aware_reminders.md`: "contacts merge/unarchive RPCs (SQL pending user apply)" |
| `supabase-migration-cross-user-account-effects.sql` | memory `project_crossuser_account_effects.md`: "SQL migration cross-user-account-effects **PENDING** user apply" |
| `supabase-migration-connections-push-discovery.sql` | memory `project_connections_push_discovery.md`: "SQL migration + Firebase setup BOTH pending user"; `05-security.md:194` documents the live pre-migration behaviour |

Also unverified for the whole set: `docs/play-store-launch-tracker.md` Y1 (`Run supabase-p0-security-verification.sql in prod`) is still ⏳, so **no production schema verification has ever been run**. That is audit finding #1 and the precondition for trusting any of this.

**Consequence for the audit-P0 batch:** four of the eleven new files hard-depend on the ⚠ set —
`settlement-row-locks` needs #36 + #39, `join-abuse-limits` and `consent-guards` need #40, `notifications` needs #40.
**Run `supabase-audit-p0-verification.sql` Section 13 against production first.** It answers "applied / not applied" for exactly these five (rows 1303–1307). If any says NO, apply the missing migration in the order above before starting the batch.

---

## 2. Audit-P0 apply order (the 2026-09-02 batch)

Eleven `supabase-migration-audit-p0-*.sql` files, plus one read-only `supabase-audit-p0-verification.sql`.
(The task brief said "12 migrations"; the twelfth file in the batch is the consolidated **verification** script, not a migration. There is no missing file — `find . -name '*audit-p0*'` returns exactly these twelve.)

### Order

| Step | File | Breaking? | Why here |
|---|---|---|---|
| 1 | `supabase-migration-audit-p0-currencies.sql` | **Safe ahead of the client** | Only widens two CHECK constraints (AED/PKR → all 8 shipped currencies). No dependency in either direction; first because it is pure risk reduction. |
| 2 | `supabase-migration-audit-p0-loan-concurrency.sql` | **BREAKING** — ship with the client | Creates `apply_loan_remaining_delta`. Header: *"Until this migration is applied, ledger-mode repayments will fail with 'function … does not exist'. That is intentional (fail loud)."* Must precede step 3. |
| 3 | `supabase-migration-audit-p0-settlement-row-locks.sql` | Non-breaking (replaces two RPCs in place, same signatures) | Header: apply **AFTER** `settlement-emi-and-account-guards` (#36), `cross-user-account-effects` (#39) — it replaces their `accept_linked_request` / `accept_settlement_request` — **and after `loan-concurrency`**, the client CAS it interlocks with. *DDL-wise it applies fine without step 2 (verified), but its own check 4.5 then reports `loan_cas_present = f` and the interlock is absent at runtime.* |
| 4 | `supabase-migration-audit-p0-kameti-draw.sql` | **BREAKING** — ship with the client | Only depends on `committees` + `committees-phase2` (#33/#34). Independent of everything else in the batch. Breaking because the organiser device can no longer write `draw_seed`/`draw_commitment`/`draw_scheme` in either mode, nor `drawn_at` or `committee_members.slot` on a `payout_method='ballot'` kameti at any point — before or after a draw — so a ballot order can only come from `perform_committee_draw()`; `payout_method='fixed'` keeps its hand-picked slots and `drawn_at`, but a slotted fixed kameti can no longer be relabelled `ballot` (`BALLOT_SWITCH_NEEDS_CLEAR_SLOTS`). |
| 5 | `supabase-migration-audit-p0-group-ledger-integrity.sql` | Non-breaking for reads/writes by *active* members; breaking for hard-DELETE of ledger rows | **The keystone.** Rewrites every policy on `group_expenses` / `group_settlements`. **MUST precede steps 6, 7 and 9** (see the hard dependencies below). |
| 6 | `supabase-migration-audit-p0-notifications.sql` | **BREAKING** — ship with the client | Header: apply **AFTER** `group-ledger-integrity` ("policies on group_expenses / group_settlements live there — this file adds only AFTER triggers"), and after `connections-push-discovery` (#40). Breaking: client `notifications` INSERT for other users is now refused; group fan-out moves server-side and rows carry `template`+`params`. |
| 7 | `supabase-migration-audit-p0-group-concurrency.sql` | **BREAKING** — ship with the client | Header lists `group-ledger-integrity` **and** `notifications` as prerequisites. Breaking: any expense UPDATE touching money fields must carry `version + 1`, and settlement inserts are capped server-side. |
| 8 | `supabase-migration-audit-p0-account-deletion.sql` | Non-breaking (adds a refusal path + a new RPC) | Header: after `p0-launch-blockers`, `safe-leave-group`, `enforce-active-group-transaction-members`. **Order vs step 9 is immaterial — verified disjoint** (guard.sql §0.2: "Disjoint objects → either apply order is safe"). |
| 9 | `supabase-migration-audit-p0-group-deletion-guard.sql` | **BREAKING** — ship with the client | **Hard-aborts** unless `group-ledger-integrity` ran first (see below). Breaking: `splitStore.deleteGroup` on a shared group now raises `GROUP_HAS_OTHER_MEMBERS`; the client needs the archive path. |
| 10 | `supabase-migration-audit-p0-join-abuse-limits.sql` | **BREAKING** — ship with the client | Header: after `fix-group-invite-join-rpc` (#23) and `connections-push-discovery` (#40). Breaking: `join_group_by_code` changes from *raise* to a jsonb status object. |
| 11 | `supabase-migration-audit-p0-consent-guards.sql` | **BREAKING** — ship with the client | Its own footer: applied **last** of its three siblings because it redefines `accept_group_invite` (which step 10 leaves alone) and extends the `group_members` guard from `safe-leave-group`. Four client contract changes; header: *"Do not deploy this to production ahead of that client change."* |
| — | `supabase-audit-p0-verification.sql` | read-only | Run last. 280 verdict rows. |

### Hard dependencies (proven, not inferred)

1. **`group-ledger-integrity` → `group-deletion-guard`.** Enforced in code. Running the guard first on a baseline database aborts with:
   > `ERROR: PRECONDITION FAILED: a client can still hard-DELETE group ledger rows (…). Apply supabase-migration-audit-p0-group-ledger-integrity.sql FIRST, then re-run this file.`

   Reason (from the guard's §0): installing the `split_groups` delete guard while the per-row DELETE policies still exist would let `splitStore.deleteGroup` wipe every expense and settlement *before* the guard refuses, leaving a surviving group with an empty ledger.
2. **`group-ledger-integrity` → `notifications`.** `notifications` adds AFTER triggers to `group_expenses` / `group_settlements` and deliberately does not touch their policies; the policies must already be the hardened set.
3. **`group-ledger-integrity` + `notifications` → `group-concurrency`.** Stated in its header; its version guard and cap trigger sit on top of both.
4. **`loan-concurrency` → `settlement-row-locks`** (runtime, not DDL). `settlement-row-locks` applies cleanly without it, but its verification 4.5 then reports `loan_cas_present = f` and the lock interlock the file exists to create is one-sided.
5. **`settlement-emi-and-account-guards` + `cross-user-account-effects` → `settlement-row-locks`.** It replaces the latest definitions of both accept RPCs; applying it earlier would be overwritten.

### Deliberately order-independent (verified, both directions safe)

- `consent-guards` vs `join-abuse-limits` — `consent-guards` restates `code_lookup_attempts` with `CREATE TABLE IF NOT EXISTS`; the recommended order (10 then 11) only means `link_contact_by_code` shares an already-live rate window rather than creating it.
- `account-deletion` vs `group-deletion-guard` — disjoint objects (auth-cascade door vs client-DELETE door); §0.2 of the guard analyses the interaction and confirms `delete_current_user`'s own solo-group DELETE is exempt from the trigger twice over.
- `currencies` and `kameti-draw` — no shared objects with any sibling.

### Breaking / non-breaking summary

**Must ship in the same deploy as the client build (7):** `loan-concurrency`, `kameti-draw`, `notifications`, `group-concurrency`, `group-deletion-guard`, `join-abuse-limits`, `consent-guards`.

**Safe to apply ahead of the client (4):** `currencies`, `settlement-row-locks`, `account-deletion`, `group-ledger-integrity`.
*Caveat on `group-ledger-integrity`:* it is safe for the current client's normal paths (an active connected member keeps full read/write on their own rows), but it removes the DELETE policies, so any client path that hard-deletes a group expense or settlement will start failing. It is grouped as "safe ahead" only because nothing in the shipped client does that on a live row — the app soft-deletes via `deleted_at`.

---

## 2b. Post-P0 migrations (P1/P2/P3)

**`supabase/tests/apply-order.txt` is now the canonical apply order for the
whole corpus** — base schema → 40 historical files → the 11 §2 audit-P0
files → the P1/P2/P3 tail below, in exactly that order, one file at a time.
It is machine-checked: `supabase/tests/run.sh` applies every line in that
file to a throwaway Postgres and then runs `supabase/tests/tests/*.sql`
against the result — **183 assertions, all passing** (152 from the original
trust-boundary suite `docs/testing-the-trust-boundary.md`, +31 from
`60-notification-maturity.sql`). CI runs the same script on every push/PR to
`main` (`.github/workflows/db-tests.yml`) and fails if any
`supabase-migration-*.sql` file exists that `apply-order.txt` doesn't list.

**§1 and §2 above are now historical** for the files they cover (the 40
historical migrations + the 11 audit-P0 files) — they remain correct and are
kept for their dependency reasoning and the Docker integration-run detail,
but `apply-order.txt` is the file to actually follow, including for those
41. Do not hand-merge the two orderings; if they ever appear to disagree,
`apply-order.txt` wins and this doc needs a follow-up correction.

The table below covers only the twelve files `apply-order.txt` adds after
the audit-P0 batch — 4 P1, 5 P2, 3 P3 (one file, `p3-khata-link.sql`, sorts
into the P2 run even though it's a P3 item, because its only hard dependency
is `p2-trust-safety.sql`; see its row).

| # | File | Purpose (from its own header) | Depends on | Classification | Docker-validated | Pre-flight query named in header |
|---|---|---|---|---|---|---|
| 1 | `supabase-migration-p1-app-config.sql` | H9: `app_config` singleton (min supported web semver + Android versionCode) — the version-skew kill switch, world-readable, `service_role`-write-only, seeded inert with today's shipped versions. | `supabase-schema.sql` only. | **Safe-ahead** (adds one standalone table; gate is inert until a human raises the floor — §2.4 of `docs/release-and-rollback.md`) | Y — applied as part of the full `apply-order.txt` corpus run (183 assertions). No dedicated per-file Docker session recorded in its header. | None named; the header's own check is "confirm the row was seeded with the current `package.json`/`build.gradle` versions." |
| 2 | `supabase-migration-p1-profile-lang.sql` | H5 precondition: `profiles.lang` column (`NOT NULL DEFAULT 'ur'`), so a future writer (trigger/RPC/push function) can know the recipient's language. Does **not** itself localize anything server-side. | `supabase-schema.sql`, `supabase-migration-p0-launch-blockers.sql`, `supabase-migration-audit-p0-notifications.sql`. Order-independent vs. every other P1 file. | **Safe-ahead** (one nullable-free column with a default; client already tolerates its absence) | Y — full-corpus run. | None named. |
| 3 | `supabase-migration-p1-group-preview.sql` | UX-18: `preview_group_by_code(code)` — a SECURITY DEFINER RPC returning a narrow `{name, emoji, member_count, currency, owner_display_name, is_archived}` projection so joining a group is no longer blind. Anti-oracle: shares the join RPC's rate-limit ledger and never RAISEs on a business outcome. | `supabase-migration-audit-p0-join-abuse-limits.sql` (owns `join_code_attempts` + the expiry trigger), `supabase-migration-audit-p0-group-deletion-guard.sql` (owns `split_groups.archived_at`). | **Safe-ahead** (adds one function, changes no existing object) | Y — full-corpus run (`30-join-lookup-invite-rpcs.sql` exercises the shared rate-limit ledger this RPC reuses). | None named beyond the two dependency checks. |
| 4 | `supabase-migration-p1-money-bounds.sql` | H10 / M12: server-side CHECK bounds on every money column (`amount >= 0` for `transactions`/`emi_schedules`, magnitude cap `1e12` = `MAX_MONEY`, single-source currency whitelist `v_currencies`) + a `group_expenses.splits` arithmetic/positivity trigger. | The whole audit-p0 set (`currencies`, `group-ledger-integrity`, `group-concurrency`, `consent-guards`) + `supabase-schema.sql`, `phase3-budgets-recurring-remittances.sql`, `committees.sql`, `investments.sql`. | **Safe-ahead** (widen/CHECK-`NOT VALID` only; existing rows grandfathered) | Y — full-corpus run (`40-money-integrity.sql`). | **§5 F1** — "the one-query pre-flight": every existing money row that the new constraint would refuse. Expect zero rows before applying to production (`docs/release-and-rollback.md` §1.2). **F2** — existing `group_expenses.splits` rows that would fail the new arithmetic trigger (run only if the splits bound ships in this release). |
| 5 | `supabase-migration-p2-trust-safety.sql` | M6 / M13 / M19 / UX-13: `blocks` + `reports` tables enforced at 13 cross-user entry points, server-hashed/expiring/rotatable kameti witness tokens, receipt bucket size/MIME limits + purge on account deletion, rejection-reason normalization. | **Apply LAST** of everything before it — CREATE-OR-REPLACEs functions owned by `audit-p0-consent-guards`, `audit-p0-join-abuse-limits`, `audit-p0-notifications`, `audit-p0-account-deletion`, `audit-p0-kameti-draw`, `connections-push-discovery`, `cross-user-account-effects`, `phase2b-linked-requests`, `fix-settlement-cancel-reject`, `receipts`. | **BREAKING-with-client** (3 breaking changes: witness token is now server-only, `committees.share_token` nulled, receipts >5 MiB / off-allowlist MIME rejected) | Y — full-corpus run + a dedicated Docker session (`docs/trust-and-safety.md` §7): 56 files (schema+historical+audit-p0+P1) then this file applied **twice** (idempotency), 62 functional-smoke assertions (40 block/report + 9 group-membership-ordering + 13 settlement-carve-out). | None named as a bare pre-flight `SELECT`; the file's own §-verification block is the post-apply check, run before enabling any client that depends on it. |
| 6 | `supabase-migration-p2-notification-maturity.sql` | M5: `member_left` fan-out, kameti `draw_completed`/`round_due`/`payout_due` notifications, `notification_prefs` (mute + quiet hours + tz), Android channel/collapse-key plumbing, `notification_href_for()`, 90-day lifecycle pruning (`prune_notifications`, pg_cron-guarded). | **Apply AFTER `p2-trust-safety.sql`** — rebuilds `fan_out_group_notification` from *its* latest body (not audit-p0-notifications' original) and CREATE-OR-REPLACEs `group_notification_text`, `tg_notifications_push`. Also reads `audit-p0-notifications` tables, `committees`/`committee_members`, `phase2a-linked-profile`, `connections-push-discovery`. | **Non-breaking / additive** (nullable columns, one new table, two new notification types an un-updated client renders via the existing template/params path) | Y — full-corpus run, `60-notification-maturity.sql` (31 assertions: routing defaults, mute suppression, `member_left`, quiet-hours wrap + tz, kameti draw/round/payout, sweep idempotency, pruning). | No pre-flight `SELECT`; post-apply operator queries **Q1–Q8** in the migration footer (Q6 = per-kameti reachability census — how many members are actually notifiable via a linked profile). |
| 7 | `supabase-migration-p3-khata-link.sql` | L2: the counterparty "living balance link" — a capability-URL, read-only, per-person ledger page, reusing the witness-link security pattern (256-bit token, SHA-256 stored, revoke/rotate). | Section 0 hard-checks and **ABORTS with a named message** rather than degrading: `is_blocked_either_way()` and `witness_initials()` from `p2-trust-safety.sql` §1.3/§7.2 (reused, not re-declared), plus `supabase-schema.sql`, `phase1-persons.sql`, `incremental-sync-tombstones.sql`, `audit-p0-account-deletion.sql`. | **Safe-ahead** (2 new tables, 3 new functions, 1 new trigger; no existing object touched; inert until a link is minted) | Y — full-corpus run. No dedicated Docker session recorded beyond that. | Section 0's own abort-with-named-message check stands in for a pre-flight query. |
| 8 | `supabase-migration-p3-atomic-transfer.sql` | L4 step 1: `transfer_between_accounts()` — the account→account transfer as one Postgres transaction (locks both account rows ascending-`id`, CAS both balances, inserts the row), behind `VITE_ATOMIC_TRANSFER` (default off). | `supabase-migration-prelaunch-hardening.sql` (`apply_account_balance_delta` CAS contract, FKs), `supabase-migration-p1-money-bounds.sql` (the CHECK constraints its own validation mirrors). Verified disjoint from every audit-p0 object. | **Flag-gated safe-ahead** — `VITE_ATOMIC_TRANSFER`, default `false`; the function is unused (and inert) while unset. | Y — full-corpus run, plus a dedicated Docker session (`docs/server-side-money-engine.md` §4): 30 in-session SQL assertions (happy path, stale CAS, insufficient balance, credit-card escape, cross-currency both ways, replay, mid-transaction rollback proof, cross-user isolation, role checks, two-session lock-order race) + `1386` app-level vitest tests green. | **§2 V1–V4** self-verification — confirm `security_definer=t`, `search_path=public`, `auth_can=t / anon_can=f`, all 9 body-roll-call columns `t`, `"verification passed"`. **V5** (post-enable drift query) — transfer rows whose currencies disagree with `conversion_rate`; expect zero, before and after. |
| 9 | `supabase-migration-p3-atomic-repayment.sql` | L4 step 2: `record_loan_repayment()` — the full-tracker loan repayment (account CAS + `apply_loan_remaining_delta` CAS + N EMI marks + the transaction row) as one transaction, behind `VITE_ATOMIC_REPAYMENT` (default off). Promoted ahead of `goal_contribution` as the highest-risk multi-leg branch. | `supabase-migration-prelaunch-hardening.sql`, `supabase-migration-audit-p0-loan-concurrency.sql` (`apply_loan_remaining_delta` — clamp/status/error-token contract copied verbatim), `supabase-migration-p1-money-bounds.sql`. Soft-ordered after `p3-atomic-transfer.sql` (same rollout, not a hard dependency). | **Flag-gated safe-ahead** — `VITE_ATOMIC_REPAYMENT`, default `false`. | Y — dedicated Docker session (`docs/server-side-money-engine.md` §9): 132 in-session SQL assertions (both loan directions, stale loan CAS, stale account CAS, insufficient-balance + allow-negative escape, cross-currency both directions, EMI marks incl. foreign-id refusal, replay, null-account refusal proving splits_only is unreachable, mid-transaction 4-leg rollback proof, two-session loan-row-lock race, role checks) + `1537` app-level vitest tests green. | **V6** — "the F-2 corruption signature itself": loans whose recorded repayments exceed what the loan actually dropped. Header instruction: **run V6 before enabling the flag** so any post-rollout row is unambiguous (`docs/server-side-money-engine.md` §10 step 2). V5/V7 are the same class of drift query, expected zero. |
| 10 | `supabase-migration-p2-realtime-broadcast.sql` | H5 / F-SC1: moves `accounts`/`transactions`/`loans` change notifications from per-row `postgres_changes` to a private-channel Postgres `Broadcast` (`realtime.send`, one message per affected user per statement), behind `VITE_REALTIME_BROADCAST` (default off). Full detail: the Addendum section below (unchanged; this row cross-references it, not a duplicate entry). | No object shared with any §1/§2/other-P1-P3 file — order-independent; "last" is the safe default for a new file, not a requirement. | **Flag-gated safe-ahead** — `VITE_REALTIME_BROADCAST`, default unset (off); with the flag off, triggers write broadcasts nobody subscribes to. | Y — dedicated Docker session on `postgres:15` against a stubbed `realtime` schema: applies clean, re-applies clean, correct per-user/per-statement message counts, money write commits whether `realtime.send` is absent or raising. | **V1** (`realtime.send` present), **V6** — live proof: save one test expense, confirm a broadcast row appears. §5 (dropping the three tables from `supabase_realtime`) is a **separate follow-up step**, run only after both web and the Play binary have the flag on. |
| 11 | `supabase-migration-p3-invariant-monitoring.sql` | L7: nightly business-invariant reconciliation (`run_reconciliation()`, `reconciliation_findings`, `reconciliation_summary()`) — the "sum of deltas ≠ balance" alarm the 2026-07 credit-card desync incident had no detector for. Read-only over app data; repairs nothing. | **LAST — after every other migration in the repo.** Hard dependency: `group_member_net_balances(text)` from `supabase-migration-audit-p0-group-deletion-guard.sql` (absence degrades to one named `check_error` finding, not a failure). Also reads `deleted_at`/`updated_at` (incremental-sync files) and `profiles.is_deleted` (`p0-launch-blockers`). | **Safe-ahead** — both tables RLS-on/zero-policies, no grants to `anon`/`authenticated`; the app cannot see or touch any of it. | Y — full-corpus run. No dedicated Docker session recorded beyond that. | **"First run = census."** `reconciliation_findings` rows are "opened when first seen, refreshed while it persists, stamped `resolved_at` by the first run that no longer sees it" — so the very first `run_reconciliation()` call establishes the baseline population, not an alarm state; do not page anyone off it. Compare the *second* run's delta against the first. |

**Added 2026-09-03 — 7 more files, `apply-order.txt` order (rows 12–18 below sit
between row 8 `p3-atomic-repayment.sql` and row 11 `p3-invariant-monitoring.sql`
in the real corpus; `p2-analytics-aggregates.sql` and `p2-realtime-broadcast.sql`
also sit in that span and are already covered above/below):**

| # | File | Purpose (from its own header) | Depends on | Classification | Docker-validated | Pre-flight query named in header |
|---|---|---|---|---|---|---|
| 12 | `supabase-migration-p3-atomic-loan-create.sql` | L4 step 3: `create_loan_with_leg()` — full-tracker loan creation (`loan_given`/`loan_taken`, including the credit-card cash-advance leg and an optional EMI schedule) as one Postgres transaction, behind `VITE_ATOMIC_LOAN_CREATE` (default off). | `supabase-migration-prelaunch-hardening.sql` (`apply_account_balance_delta` CAS + FKs), `supabase-migration-audit-p0-loan-concurrency.sql` (not called, but its `LOAN_*` error-token vocabulary is reused), `supabase-migration-p1-money-bounds.sql` (the CHECKs its own validation mirrors). Soft-ordered after `p3-atomic-transfer.sql` + `p3-atomic-repayment.sql` (one rollout, not a hard dependency). Section 0 also hard-checks `supabase-schema.sql`, `phase1-persons.sql`, `reconciliation.sql`, `receipts.sql`, `incremental-sync-core.sql`, `incremental-sync-tombstones.sql` and aborts by name if any is missing. | **Flag-gated safe-ahead** — `VITE_ATOMIC_LOAN_CREATE`, default `false`. | Y — dedicated Docker session inside the trust-boundary suite (`docs/server-side-money-engine.md` §14, `postgres:15`, the full `apply-order.txt` corpus at the time): 65 new SQL assertions, suite total **248 assertions, 0 failed**, plus 131 vitest files / 1650 tests green (19 new pure-logic + 16 flagged-store-path tests). | **§15 step 2 — V7** (DRIFT WATCH #3): loans whose EMI schedule does not sum to the loan — the orphan the page's post-hoc `generateSchedule` call already produces. "Know the number before the flag goes on." V5/V6 are the same class, expected zero. |
| 13 | `supabase-migration-p3-atomic-goal-and-card.sql` | L4 step 4: `contribute_to_goal()` (goal contribution, incl. self-stored) and `pay_card_bill()` (bill payment settling cash-advance loans, both the `'transfer'` and the deferred `'repayment'` leg) — each one Postgres transaction, behind `VITE_ATOMIC_GOAL` / `VITE_ATOMIC_CARD_BILL` (both default off). | `supabase-migration-prelaunch-hardening.sql`, `supabase-migration-audit-p0-loan-concurrency.sql` (`apply_loan_remaining_delta`'s clamp/status/error-token contract reproduced verbatim), `supabase-migration-goal-target-date.sql`, `supabase-migration-p1-money-bounds.sql`. Soft-ordered after `p3-atomic-transfer.sql`, `p3-atomic-repayment.sql`, `p3-atomic-loan-create.sql` (one rollout). Section 0 also hard-checks `supabase-schema.sql`, `phase1-persons.sql`, `reconciliation.sql`, `receipts.sql`, `incremental-sync-core.sql`, `incremental-sync-tombstones.sql`. | **Flag-gated safe-ahead** — `VITE_ATOMIC_GOAL` and/or `VITE_ATOMIC_CARD_BILL`, both default `false`. | Y — dedicated Docker session (`docs/server-side-money-engine.md` §20): 82 new SQL assertions, suite total **449 assertions, 0 failed** (plus a hand-run two-session lock race on the same card row — B blocked ~1.00s on the row lock, then `BALANCE_CONFLICT`, no deadlock, money moved exactly once), plus 141 vitest files / 1822 tests green (32 new pure-logic + 24 flagged-store-path tests). | **§21 step 2 — V6** (goal-accounting signature: a goal whose `saved_amount` disagrees with its recorded contributions) and **V7** (the card lockstep invariant: Σ cash-advance-remaining exceeding the card's `used` — the Available-over-Limit signature). "Know both numbers before the flags go on." |
| 14 | `supabase-migration-p3-atomic-investments-and-single-leg.sql` | L4 step 5, the last two shapes: `record_single_leg_entry()` (`income`/`expense`/`opening_balance`/`adjustment`) and `record_investment_trade()` (`investment_buy`/`sell`/`dividend`), each one Postgres transaction; plus `apply_goal_saved_delta()`, a CAS for the goal-contribution compensation's own inverse write. Behind `VITE_ATOMIC_SINGLE_LEG` / `VITE_ATOMIC_INVEST` (the goal-delta path is reached only via the already-flagged `VITE_ATOMIC_GOAL`), all default off. | `supabase-schema.sql`, `supabase-migration-prelaunch-hardening.sql`, `supabase-migration-investments.sql` (`investment_markets`/`investment_trades`/`transactions.related_investment_id`), `supabase-migration-p1-money-bounds.sql`, `supabase-migration-incremental-sync-tombstones.sql`. Sits directly after `p3-atomic-goal-and-card.sql` in `apply-order.txt`. | **Flag-gated safe-ahead** — inert until its flags are set; re-applying is clean. | **IN PROGRESS as of 2026-09-03 — do not treat as landed.** No §-numbered write-up exists yet in `docs/server-side-money-engine.md`: its §22 "final branch table" still lists `income`/`expense`/`opening_balance`/`adjustment` and `investment_buy`/`sell`/`dividend` as uncovered ("—" rows) and its §23 open list still names `apply_goal_saved_delta` as "the smallest remaining gap" — both written *before* this file existed, and neither has been refreshed since. The migration file itself (1529 lines) reads complete, with its own SECTION 0 preconditions, SECTIONs 1–3 (the three functions), a SECTION 4 verification block (V1–V9, incl. drift watches), and a SECTION 5 manual-QA script. Its paired test file, `supabase/tests/tests/7z-atomic-investments-single-leg.sql`, was mid-edit in the working tree at the time of this review: `git diff` shows its last two `assert_raises` calls (the `NOT_AUTHENTICATED` checks) were completing a statement that had been truncated mid-line with no trailing newline before this session's edit. As it stands right now it counts **92** `test.assert*` calls — uncommitted, alongside modified `src/lib/i18n.ts`, `src/lib/supabaseDb.ts`, `src/stores/transactionStore.ts` and two new untracked test files (`src/lib/mirrorCache.coverage.test.ts`, `src/stores/transactionHistoryPersistence.test.ts`) — so the client wiring for the two flags is evidently still landing. Re-derive the assertion count and Docker-session status from `docs/server-side-money-engine.md` once it gains a §24 (or equivalent) for step 5. | The file's own drift watches: **V7** (the lost-trade signature — an account-linked trade whose balance leg exists with no matching `investment_trades` row), **V8** (the oversold-position replay — every `(market, symbol)` net quantity across the suite's writes, flagging negative), **V9** (the goal-accounting signature, restated for step 5's compensation CAS). V5/V6 cover the single-leg no-account and both-accounts/cross-currency cases. No "run before enabling" callout exists yet — no rollout section has been written for this step. |
| 15 | `supabase-migration-p2-analytics-aggregates-2.sql` | M2(d): `analytics_daily_series()` and `analytics_top_expenses()` — the two remaining Analytics-page surfaces (`dailySpending`, `topExpenses`) that `p2-analytics-aggregates.sql`'s monthly-summary RPC didn't cover; `monthlyTrend` needed no third RPC (served by re-calling `analytics_monthly_summary` over the trend window, once its month-end bucket-truncation bug was fixed client-side in `endOfMonthExact`). | `supabase-migration-p2-analytics-aggregates.sql` directly — shares its prerequisites (`transactions` + `deleted_at`; §1 aborts if either is missing) and touches nothing else; does **not** modify `analytics_monthly_summary`. | **Non-breaking, safe ahead of the client** — `VITE_ANALYTICS_RPC`, default off; even with the flag on, `AnalyticsPage` fails soft back to client-side aggregation on any RPC error. Adds no index (§3 of the file explains why the two `p2-analytics-aggregates.sql` already created are enough). | Y — full `apply-order.txt` corpus run, `postgres:15`; `supabase/tests/tests/8x-analytics-rpcs.sql`, **16 assertions, all green** (`docs/performance.md:746,833`). | The file's own V1–V7 self-verification (signature/SECURITY DEFINER shape, grants, output sanity against the client-side twins, daily-vs-monthly reconciliation, owner/expense-only scoping, both-app-modes null-account exclusion, V7 = index-only-scan plan check). No named production drift-watch beyond those seven. |
| 16 | `supabase-migration-p2-guest-members.sql` | G6/O4: non-app "guest" group members (`profile_id IS NULL`, `status='connected'`, a `display_name`, an optional SHA-256 phone hash for a later claim). Adds `add_group_guest`/`remove_group_guest` RPCs and `group_guest_identities`; `CREATE OR REPLACE`s `join_group_by_code` with a mini-diff (the guest-seat self-claim carve-out). | In this order per its header: `supabase-migration-audit-p0-group-ledger-integrity.sql`, `supabase-migration-audit-p0-group-concurrency.sql`, `supabase-migration-audit-p0-account-deletion.sql`, `supabase-migration-audit-p0-group-deletion-guard.sql`, `supabase-migration-audit-p0-consent-guards.sql`, `supabase-migration-p1-money-bounds.sql`, `supabase-migration-p2-trust-safety.sql` (owns the `join_group_by_code` it mini-diffs). | **Non-breaking / additive** — §0 of the file argues (and §6.4's verification re-derives from the live catalog, not assumed) that the existing connected-member triggers gate on `status`, never `profile_id`, so a guest at `'connected'` already satisfies them; the `join_group_by_code` change is a mini-diff, not a contract change. | Y — full corpus run; `supabase/tests/tests/8y-guest-members.sql`, **31 assertions** per `docs/guest-members.md` §10 (corpus total there: 331 assertions, 0 failed); `src/lib/groupGuests.test.ts` (16) + 3 appended to `whoOwesGroupInputs.test.ts`. **Stale count flag:** the file counts **38** `test.assert*` calls today — 7 more than the doc's 31 — consistent with the SECTION 3b rename-trigger amendment below having landed after `docs/guest-members.md` §10 was last written. Treat 38 as the live figure until that doc is refreshed. | **§6.4** "THE CONFIRMATIONS §0 claims" — re-reads the live catalog to confirm the ledger triggers still gate on `status='connected'` and never require `profile_id`; aborts by name on drift. §6.3 is a census of every group's guest seats and phone-hash claimability. |
| 17 | `supabase-migration-p2-kameti-editing.sql` | UX-25: safe post-creation editing for a kameti, as a matrix over lifecycle state (`open` / `collecting` / `drawn`). Adds `update_committee`/`add_committee_member`/`remove_committee_member` RPCs plus a third, independent `BEFORE UPDATE` trigger on `committees` that composes with (never replaces) the existing draw-immutability and witness-token-guard triggers. | `supabase-migration-committees.sql`, `supabase-migration-committees-phase2.sql`, `supabase-migration-audit-p0-kameti-draw.sql` (the draw + its two triggers), `supabase-migration-p2-trust-safety.sql` (witness-token guard + RPCs), `supabase-migration-p2-notification-maturity.sql` (`committee_round_date`, used by `add_committee_member`). | **Non-breaking / additive** — only ADDs objects; never `CREATE OR REPLACE`s `tg_committees_draw_immutable`, `tg_committee_members_draw_locked`, `tg_committees_witness_token_guard`, `perform_committee_draw` or `get_committee_witness`. | Y, as part of the full corpus run — but **no dedicated Docker session or explicit assertion-count claim in its own header**, unlike the atomic-* files' self-citations, and no doc (`docs/*.md`) states a figure either. `supabase/tests/tests/8w-kameti-editing.sql` counts **36** `test.assert*` calls (counted directly from the file for this update). `docs/audit-2026-09/P0-REMEDIATION.md` §4 M8 records only that the feature shipped, no number. | **§6.4** DRIFT CHECK — `member_count`/`total_rounds` vs. the actual roster, expect 0 rows. **§6.5** SLOT CONTIGUITY — on a fixed kameti with an order, assigned slots must be exactly `1..total_rounds` with no gaps, expect 0 rows. |
| 18 | `supabase-migration-p2-edit-history.sql` | G5/O10: append-only, server-written per-record edit history ("who changed what") on `group_expenses`, `group_settlements`, `loans`, `transactions`. New `record_edits` table, `tg_record_edits()` (×4 triggers), `prune_record_edits()` — read-only to every client role. | Reads only, replaces nothing: `group_expenses`/`group_settlements`/`loans`/`transactions` schema + their `deleted_at` columns (`incremental-sync-tombstones.sql`), `group_expenses.version` (`supabase-schema.sql:308`), `split_groups`, `is_group_member` (`audit-p0-consent-guards.sql` §2.1). Sits after `p2-realtime-broadcast.sql` (the last other `p2-*`) and before `p3-invariant-monitoring.sql`, which must stay last. | **Purely additive, non-breaking** — `editHistoryDb` throws a typed `EditHistoryUnavailableError` and `EditHistorySheet` renders a "not available yet" state when the table is absent, so client and migration can ship in either order. | Y — full corpus run; `supabase/tests/tests/8z-edit-history.sql`, **26 assertions** (`docs/edit-history.md` §9: corpus total there 357 assertions, 0 failed); idempotency-checked **3×** in a row against the fully migrated database; `src/lib/editHistory.test.ts`, 21 vitest cases. | No pre-apply query — net-new table, nothing to check beforehand. The file's own **V1–V6** post-apply self-verification prints `p2-edit-history: OK`. **Q1** (volume census by table) and **Q2** (table size) are the named operator queries to run "after a week in production before trusting the 180-day retention figure" (§8) — `transactions` is flagged as the volume risk to watch there. |

### Amendments, corrections, and the corpus total, as of 2026-09-03

- **`supabase/tests/apply-order.txt` remains the single canonical apply order** for the whole corpus — restated, not changed, by this update. It now lists **72 non-comment, non-blank lines**: 1 harness-only prelude (`supabase/tests/prelude-notifications-rls.sql`, never applied to production) + **71 production files** (`supabase-schema.sql` + 70 `supabase-migration-*.sql` files), which matches `ls supabase-migration-*.sql | wc -l` (70) + the base schema exactly. Do not hand-merge this table with `apply-order.txt`; if they ever disagree, `apply-order.txt` wins.
- **Correction to the note above ("apply-order.txt lists p1-profile-lang.sql twice"): no longer true.** `grep -c profile-lang supabase/tests/apply-order.txt` returns 1 today — the file lists `supabase-migration-p1-profile-lang.sql` exactly once, in its correct P1 position. The duplicate this doc previously flagged has been fixed (by whom/when is not recorded in either file's history); the sentence is corrected here rather than left stale.
- **In-place amendment — `supabase-migration-p3-khata-link.sql` (row 7, §2b table above): `show_notes`.** The file as it stands today already carries a `khata_links.show_notes BOOLEAN NOT NULL DEFAULT false` column, an owner-only `UPDATE (initials_only, show_notes)` grant, and a `p_show_notes` parameter on the minting RPC (default `NULL` → carries forward the previous link's choice, else `false`) — gating whether `get_khata_view()` ever includes that contact's loan/transaction notes on the public page, capped at 140 chars via `khata_cap_note` either way when it does. Because this migration has never been applied anywhere (per its own row's PENDING status in `docs/play-store-listing.md`'s claims ledger), the addition was folded directly into the one file rather than shipped as a follow-up — there is no separate `show_notes` patch file to sequence.
- **In-place amendment — `supabase-migration-p2-guest-members.sql` (row 16 above): the SECTION 3b rename-trigger addendum.** `tg_group_members_guest_rename_rules()` — a `BEFORE UPDATE OF display_name` trigger, guest seats only (`profile_id IS NULL AND status <> 'left'`) — was added as a "residual close" after the file's initial §3 BEFORE INSERT guest-seat rules shipped with no UPDATE twin, which meant a guest rename (`renameGroupGuest`, `src/stores/splitStore.ts:821`) was validated client-side only and two owner devices could race two guests onto the same live name. The new trigger reuses `INVALID_GUEST_NAME`/`DUPLICATE_GROUP_MEMBER_NAME` verbatim from the INSERT trigger, but with a tighter 1–40-char bound matching `renameGroupGuest`'s own client-side bound (not §3's 1–60), and composes with — never replaces — `tg_group_members_protect_membership_fields`. `docs/guest-members.md` §9 records this as "Closed." Same as the khata-link amendment above: the file has never been applied to production, so this was folded in directly rather than shipped as a separate migration — it is the reason the file's own test suite now counts more assertions (38) than `docs/guest-members.md` §10's stated 31, per row 16's note.
- **The kameti-draw in-place amendment.** `supabase-migration-audit-p0-kameti-draw.sql` (§2, step 4 above) was amended in place after `docs/testing-the-trust-boundary.md`'s first run found both immutability triggers keyed only off `committees.draw_seed IS NOT NULL`, letting an organiser hand-write `committee_members.slot` on a `payout_method='ballot'` kameti and never call `perform_committee_draw()` at all — a *never-draw* path around the M10 fix that no verification query in the original file caught. Because the file had not yet been applied anywhere, it was corrected directly rather than shipped as a follow-up migration: for `ballot` committees, `slot`/`drawn_at` are now server-only both before and after the draw; `fixed → ballot` with slots already set is refused (`BALLOT_SWITCH_NEEDS_CLEAR_SLOTS`); the RPC's slotted-guard raises a distinct `SLOTS_ALREADY_SET`. Verification query **5.9** (`unseeded_ballots_with_an_order`) in the migration is the production-drift check for any pre-existing rigged rows — run it once after applying, before trusting a fresh "provably fair" claim. `supabase/tests/tests/50-lifecycle-and-config.sql` asserts both the refusals and that a genuine draw still succeeds after a rig attempt is blocked.
- **The realtime-broadcast V6 guard.** `supabase-migration-p2-realtime-broadcast.sql`'s own §6 V6 check is the only verification in this whole tail that cannot be satisfied by the Docker harness — it requires a live Supabase project's hosted Realtime service and a real save. Treat "applied + V1–V5 clean" as necessary but not sufficient; do not flip `VITE_REALTIME_BROADCAST` for any surface until V6 has been run against that project once.

---

## 3. Integration run log — summary

**Harness:** `postgres:16` container (PostgreSQL 16.15), database `hisaab`, plus a Supabase-shaped scaffold (schemas `auth`/`extensions`/`storage`/`net`/`vault`; `auth.users(id, email, raw_user_meta_data)`; `auth.uid()` / `auth.role()` / `auth.email()` reading `current_setting('request.jwt.claim.*', true)`; roles `anon`/`authenticated`/`service_role`/`supabase_admin`; `pgcrypto`; publication `supabase_realtime`; `storage.buckets`/`storage.objects`/`storage.foldername()`; a logging `net.http_post()` stub). Everything else (`is_current_profile_active`, `is_group_member`, …) comes from the migrations themselves. Each file run with `psql -v ON_ERROR_STOP=1`.

| Stage | Files | Result |
|---|---|---|
| Scaffold | 1 | ok (one expected `wal_level is insufficient` warning on `CREATE PUBLICATION`) |
| `supabase-schema.sql` + 40 historical migrations, in §1 order | 41 | **41 / 41 applied cleanly, 0 failures** (one harness prelude required — see §5) |
| 11 audit-P0 files, in §2 order — first pass | 11 | **11 / 11 applied cleanly, 0 failures** |
| Each file's own embedded verification section | 11 | **11 / 11 pass.** `audit-p0-notifications: OK` and `audit-p0-group-concurrency: OK` notices raised; all boolean roll-calls as expected (`anon_can = f`, `auth_can = t`, `for_update_stmts = 7 / 6`, `desynced_pairs = 0`, `seeded_but_unslotted = 0`, `groups_with_code = 0 / missing_expiry = 0`, `owner_scoped/skips_deleted/raises_conflict/clamps_at_zero = t,t,t,t`). |
| `supabase-audit-p0-verification.sql` | 1 | **280 rows, 0 SQL errors.** Section 13 (migration verdicts): all ten rows **YES / OK**. |
| Negative ordering test 1 | — | `group-deletion-guard` **without** `group-ledger-integrity` → aborts with `PRECONDITION FAILED` as designed. Dependency proven. |
| Negative ordering test 2 | — | `settlement-row-locks` **without** `loan-concurrency` → applies (DDL-clean) but check 4.5 reports `loan_cas_present = f`. Runtime-only dependency confirmed. |

### Remaining flagged rows in the consolidated verification (both expected, neither a batch defect)

| Row | Verdict | Assessment |
|---|---|---|
| `01 · app_push_config` | `!! RLS ENABLED but ZERO POLICIES` | **By design.** `connections-push-discovery.sql` creates it for the service-role edge function only. Client lock-out is the intent. |
| `06 · lookup_profile_by_public_code` | `!! MISSING — client call fails (PGRST202)` | **Real, known, and NOT fixed by this batch.** `src/lib/supabaseDb.ts:1550` still calls an RPC dropped by both `prelaunch-hardening.sql:318` and `p0-launch-blockers.sql:386`. Exactly the state `docs/audit-2026-09/P0-C1-runbook.md:82` says to treat as "a live production bug, not a clean bill of health". Needs a **client** fix (out of scope for these SQL files). |

---

## 4. Idempotency result

All 11 audit-P0 files re-applied a second time against the already-migrated database:

**11 / 11 clean, 0 failures.** Output is limited to benign `NOTICE: … already exists, skipping` / `… does not exist, skipping` lines from the `IF NOT EXISTS` / `DROP … IF EXISTS` guards, plus the same two `: OK` verification notices. No object was duplicated, no policy conflicted, no trigger was doubled.

Every file's claim of idempotency in its own header therefore holds under a full second pass, not only in isolation.

---

## 5. Smoke results — cross-interaction, role `authenticated`, three test users

Run as role `authenticated` with `request.jwt.claim.sub` switched between users A (owner), B (member), C (joiner). **41 assertions, 41 PASS, 0 FAIL.**

| # | Assertion | Migration exercised |
|---|---|---|
| 1–3 | A creates a group; join code expiry stamped server-side; owner self-member insert allowed | join-abuse-limits, consent-guards |
| 4 | Owner adding another user lands as `status='invited'`, not `connected` | consent-guards (H6) |
| 5–6 | `accept_group_membership` succeeds; member becomes `connected` | consent-guards |
| 7 | Group expense insert by an active member | group-ledger-integrity |
| 8–9 | Server-side notification fan-out reaches the member (2 rows); durable `group_events` activity row written by the trigger, not the client | notifications (C7 / N-2) |
| 10 | Expense UPDATE without a version bump → `GROUP_EXPENSE_VERSION_CONFLICT: an edit must carry version 2 (got 1)` | group-concurrency (F-6) |
| 11 | `group_settlement_cap(G, B, A)` = 50.00 | group-concurrency |
| 12–13 | Over-cap `record_group_settlement` refused **as data** (`success=false, reason_code=EXCEEDS_OUTSTANDING`) and inserts nothing | group-concurrency (F-7) |
| 14 | Raw PostgREST-style over-cap INSERT blocked by the trigger: `SETTLEMENT_EXCEEDS_OUTSTANDING: settlement of 500.00 exceeds the outstanding 50.00` | group-concurrency |
| 15 | Legitimate 50.00 settlement recorded | group-concurrency |
| 16 | Owner hard-DELETE of a **shared** group → `GROUP_HAS_OTHER_MEMBERS` | group-deletion-guard (L13) |
| 17–19 | `archive_group` succeeds; writes into an archived group blocked (`GROUP_ARCHIVED`); `unarchive_group` succeeds | group-deletion-guard |
| 20–21 | Bad join code returns `{"status":"INVALID_OR_EXPIRED_CODE"}` instead of raising, **and the failed-attempt row COMMITS** (the H1 root cause) | join-abuse-limits (H1) |
| 22 | Good join code returns `{"status":"ok", …}` with a member id | join-abuse-limits |
| 23 | 21 `lookup_profile_by_code` calls in an hour → the next returns **0 rows** (indistinguishable from "no such code") | join-abuse-limits (H9) |
| 24 | Direct `UPDATE persons SET linked_profile_id` → `LINK_RPC_REQUIRED` | consent-guards (H2) |
| 25–26 | `link_contact_by_code` returns `{"status":"ok","link_state":"pending"}`; the caller's own row links, the **target's ledger stays empty**, and one `contact_link_requests` row is `pending` | consent-guards (H2) |
| 27 | `link_contact_by_discovery` → `{"status":"ok","link_state":"pending"}` | consent-guards |
| 28–30 | `perform_committee_draw` succeeds once; second call → `ALREADY_DRAWN`; hand-writing `draw_seed` → `DRAW_FIELDS_ARE_SERVER_ONLY` | kameti-draw (M10 / F-13) |
| 31–32 | `apply_loan_remaining_delta(-500, expected 2000)` → 1500.00; replaying the stale expected value → `LOAN_REMAINING_CONFLICT` | loan-concurrency (F-2) |
| 33 | Notification INSERT into another user's inbox → RLS violation | notifications (H5) |
| 34–37 | B deletes their account: B's settlement row **survives**, `user_id` is NULL (anonymized), A's expense untouched, and a `member_account_deleted` group_event is emitted | account-deletion (C2) |
| 38 | A (owner of a group that still has other members) calling `delete_current_user()` → `OWNED_GROUPS_WITH_MEMBERS` | account-deletion (C2) |
| 39 | C leaves with a zero balance → `{"success":true,"reason_code":"LEFT_GROUP"}` | safe-leave-group × consent-guards |
| 40 | `group_invites.token_hash` is not column-readable by `authenticated` (table-wide SELECT revoked, column grant omits it) | consent-guards (C6) |
| 41 | `accept_settlement_request` body contains `FOR UPDATE` row locks | settlement-row-locks (L-1/L-2) |

**No conflicting triggers or policies were observed.** The two tables with the densest trigger stacks compose correctly:
`group_expenses` carries 6 triggers (`block_when_archived`, `notify`, `require_authorship`, `require_connected_members`, `version_guard`, `reconciliation_payer`) from 4 different migrations, and `group_settlements` carries 5 (`block_when_archived`, `enforce_cap`, `notify`, `require_authorship`, `require_connected_members`) from 4. Both fire in name order without interfering — the archive guard, the cap guard and the membership guard each rejected their own case cleanly in the smoke run.

---

## 6. Defects found & fixed

Two, both in **`supabase-audit-p0-verification.sql`** — the consolidated read-only script. Both produced a **false "still broken" verdict** on a database where the fix was correctly applied, which is the worst failure mode for a verification script (it would have sent the operator chasing a non-existent regression, or worse, re-running migrations). No defect was found in any of the 11 migration files.

### Defect 1 — Section 08 currency verdict used a sentinel that is not one of the app's currencies

The widened-constraint test looked for `USD`. USD is **not** one of Hisaab's eight shipped currencies (`src/db/types.ts`: AED, PKR, PHP, SAR, QAR, OMR, KWD, BHD), so `NOT ILIKE '%USD%'` stays true forever and the row reported `!! NARROW — AED/PKR only (C9 open)` against a constraint that plainly listed all eight. `supabase-migration-audit-p0-currencies.sql`'s own V1/V2 checks use `BHD`; the consolidated script did not match them.

```diff
+    -- Sentinel = BHD, not USD. USD is NOT one of the app's eight currencies
+    -- (src/db/types.ts SUPPORTED_CURRENCIES = AED, PKR, PHP, SAR, QAR, OMR,
+    -- KWD, BHD), so a "NOT LIKE '%USD%'" test stays true even after
+    -- supabase-migration-audit-p0-currencies.sql widens the constraint —
+    -- reporting "C9 open" on a fixed database. BHD is the sentinel that file's
+    -- own V1/V2 checks use.
     CASE
       WHEN pg_get_constraintdef(con.oid) ILIKE '%''AED''%'
-       AND pg_get_constraintdef(con.oid) NOT ILIKE '%''USD''%'
+       AND pg_get_constraintdef(con.oid) NOT ILIKE '%''BHD''%'
         THEN '!! NARROW — AED/PKR only (C9 open: 6 of 8 currencies error out)'
+      WHEN pg_get_constraintdef(con.oid) ILIKE '%''BHD''%'
+        THEN 'widened — all 8 shipped currencies accepted (C9 closed)'
       ELSE 'widened / other currency constraint — read detail'
     END,
```

Before: `!! NARROW — AED/PKR only (C9 open …)` ×2.
After: `widened — all 8 shipped currencies accepted (C9 closed)` ×2.

### Defect 2 — Section 03.7 checked only the RLS policy, but C6 is closed at the column-grant layer

`consent-guards.sql:1407-1416` closes C6 by `REVOKE SELECT ON group_invites FROM authenticated` followed by a **column** GRANT that omits `token_hash`, deliberately leaving the row policy in place so members keep seeing their group's invites. The verdict only inspected `pg_policies`, so it reported `!! members can SELECT invites (token_hash readable) — C6 open` on a database where `has_column_privilege('authenticated','group_invites','token_hash','SELECT')` is **false**.

```diff
+-- NOTE: supabase-migration-audit-p0-consent-guards.sql:1407-1416 closes C6 at
+-- the COLUMN-privilege layer (REVOKE SELECT on the table, then a column GRANT
+-- that omits token_hash), deliberately leaving the row policy in place so
+-- members keep seeing their group's invites. A policy-only verdict therefore
+-- reports "C6 open" on a database where C6 is closed — the column grant is
+-- checked first.
 SELECT
     306,
     '=== SECTION 03: CRITICAL POLICY VERDICTS ===',
     '03.7 group_invites SELECT — members can read token_hash?',
     CASE
+      WHEN to_regclass('public.group_invites') IS NULL
+        THEN '!! TABLE MISSING'
+      WHEN NOT has_column_privilege('authenticated', 'public.group_invites',
+                                    'token_hash', 'SELECT')
+        THEN 'token_hash NOT readable by authenticated — C6 closed (consent-guards column grant)'
       WHEN EXISTS (
         SELECT 1 FROM pg_policies
          WHERE schemaname='public' AND tablename='group_invites'
            AND cmd IN ('SELECT','ALL')
            AND qual ILIKE '%is_group_member%'
       ) THEN '!! members can SELECT invites (token_hash readable) — C6 open'
       ELSE 'members cannot broadly SELECT invites — inspect detail'
     END,
-    COALESCE(
-      (SELECT string_agg(policyname || ' [' || cmd || '] => ' || COALESCE(qual,'(none)'), ' ; ')
-         FROM pg_policies WHERE schemaname='public' AND tablename='group_invites'),
-      '(none)')
+    'token_hash SELECT grant to authenticated = '
+      || COALESCE(has_column_privilege('authenticated', 'public.group_invites',
+                                       'token_hash', 'SELECT')::text, '?')
+      || '  ||  '
+      || COALESCE(
+           (SELECT string_agg(policyname || ' [' || cmd || '] => ' || COALESCE(qual,'(none)'), ' ; ')
+              FROM pg_policies WHERE schemaname='public' AND tablename='group_invites'),
+           '(none)')
```

Before: `!! members can SELECT invites (token_hash readable) — C6 open`.
After: `token_hash NOT readable by authenticated — C6 closed (consent-guards column grant)`, with the grant state shown in the detail column. The `!! … C6 open` branch is preserved and still fires on a database where the column grant was never applied.

### One non-defect worth recording: the notifications-rls replay drift

`supabase-migration-notifications-rls.sql` will **not** re-apply against today's `supabase-schema.sql`. It fails with `42710 policy "Users can view own notifications" … already exists`, because `supabase-schema.sql` was edited in place after that migration was written (`git log` on the schema: 2026-04-19 `05c6df8`, 2026-04-19 `6e3c2f9`, 2026-05-13 `0eb0dba`) and today's schema file already ships all four notification policies.

This is **not a bug in production** — production applied the 2026-03-26 schema, which had only `"Users can manage own notifications"`. It is a bug in the repo's *replayability*: `supabase-schema.sql` is no longer a faithful "run this first" artifact. The harness works around it with a 4-line prelude that drops those four policies before the migration runs. Anyone rebuilding a staging database from this repo needs the same prelude, or must stop treating `supabase-schema.sql` as replayable. **Nothing in `src/` and no repo SQL file was changed for this** — the prelude lives only in the (deleted) scratch harness.

---

## 7. Known limitations of the harness vs real Supabase

The run proves the SQL composes; it does not prove the deployment behaves. What was simulated, faked, or not covered:

| Area | Status in the harness | Risk it leaves open |
|---|---|---|
| **PostgREST** | Absent. Every "client" call was raw SQL as role `authenticated`. | Anything PostgREST-specific: named-argument binding for the renamed `accept_group_invite(p_invite_token, …)`; the RPC return-shape mapping for the new `jsonb` returns; `PGRST202` "function not found" behaviour; `Prefer: return=representation`; `select('*')` failing with a *column* permission denied (only the privilege state was asserted, not the HTTP 403). |
| **PostgREST `max_rows`** | Not simulated. | Supabase caps rows per request (default 1000). The new server-side notification fan-out can produce many rows per group action, and `group_member_net_balances` returns one row per member — pagination/truncation behaviour is untested. |
| **`pg_net`** | Replaced by a stub `net.http_post()` that logs to a table and returns an id. | The real function is async and fire-and-forget; failures, timeouts and back-pressure against the FCM edge function are unobserved. The push edge function (`supabase/functions/push-notify`) was never invoked. |
| **Realtime** | `supabase_realtime` exists as a plain publication on a `wal_level=replica` server (Postgres warned: *"wal_level is insufficient to publish logical changes"*). | Whether the newly-notified rows actually reach subscribed clients — and whether the tighter `notifications` INSERT policy breaks the client's realtime subscription filter — is untested. |
| **Storage** | `storage.buckets` / `storage.objects` / `storage.foldername()` are hand-rolled shims; `supabase-migration-receipts.sql` applied against them. | Real Supabase Storage RLS, the `receipts` bucket, and object ownership semantics are not exercised. `account-deletion.sql:177` explicitly notes `storage.objects` is *not* touched by `delete_current_user` — receipts of a deleted user therefore survive, and that residual was not testable here. |
| **`auth.users`** | 3-column shim (`id`, `email`, `raw_user_meta_data`). GoTrue's real table has ~30 columns, identities, sessions, refresh tokens. | `DELETE FROM auth.users` in `delete_current_user()` cascaded only through *this repo's* FKs. In production it also reaps `auth.identities`, `auth.sessions`, `auth.refresh_tokens` and (if configured) audit rows. Deletion latency and any GoTrue trigger/webhook are unknown. |
| **Roles & GUCs** | `SET LOCAL ROLE authenticated` + `set_config('request.jwt.claim.sub', …)`. | Supabase's actual `authenticator` → `authenticated` role switch, JWT claim shape (`request.jwt.claims` json in newer versions vs `request.jwt.claim.sub`), and `SET ROLE` timing per statement are approximated. Any function reading a claim other than `sub` was not covered. |
| **Concurrency** | Single session. Every lock/CAS test was sequential. | The deadlock scenarios `settlement-row-locks` exists to fix (ABBA on two loan rows, lock-order inversion between the two accept RPCs) were verified **statically** — by asserting `FOR UPDATE` counts (7 and 6) and canonical lock ordering in `prosrc` — not by racing two sessions. The two-session QA in that file's §4.7 still needs running on staging. |
| **Data volume** | Empty tables plus ~20 smoke rows. | The `performance-indexes` migration and the new `group_settlement_cap` / `group_member_net_balances` balance CTEs were never seen under load. No `EXPLAIN` was checked. |
| **Postgres version** | 16.15. Supabase projects commonly run 15.x. | The batch was authored and individually validated on 15.19 by the sibling agents; nothing in it uses 16-only syntax. Low risk, but the composed run has only been proven on 16. |
| **Production drift** | The harness replays this repo's files. Production is whatever was actually pasted into Studio over 5 months — including the five ⚠ possibly-unapplied migrations and any manual edits. | **This is the largest gap and it is not closable from here.** The harness proves the files compose *with each other*; it cannot prove they compose with production. Run `supabase-audit-p0-verification.sql` against production first, and reconcile Section 13 before applying anything. |

---

## 8. Recommended production sequence

1. Run `supabase-audit-p0-verification.sql` (read-only) against production. Record Section 13.
2. For every Section 13 row that says NO, apply the corresponding §1 migration, in §1 order.
3. Re-run the verification. Section 13 must be all YES/OK before continuing.
4. Apply `supabase-migration-audit-p0-currencies.sql` (step 1) — safe on its own, immediate benefit for the 6 non-AED/PKR currencies.
5. Ship the client build and apply steps 2–11 **in the same maintenance window**, in the §2 order. Seven of the eleven break the current client.
6. Re-run `supabase-audit-p0-verification.sql`. Expect the two known flags in §3 (`app_push_config`, `lookup_profile_by_public_code`) and nothing else.
7. Work the manual two-session QA still outstanding: `settlement-row-locks` §4.7 (deadlock/40P01), `group-concurrency`'s concurrent `record_group_settlement`, and `group-ledger-integrity`'s ex-member PostgREST probes.
8. Separately, fix the client's call to the dropped `lookup_profile_by_public_code` (`src/lib/supabaseDb.ts:1550`) — no SQL file in this batch addresses it.

---

## Addendum · `supabase-migration-p2-realtime-broadcast.sql` (P2 item M2b)

**Added 2026-09-02, after §1-§8 above were written.** Not part of the audit-P0
batch; it belongs to the P2 performance work (03-performance.md H5,
04-supabase.md F-SC1).

| | |
|---|---|
| **Position** | **LAST** — after every file in §1 and §2. |
| **Hard dependencies** | None. Its only new objects are `public.hisaab_broadcast_money_change()`, nine `trg_broadcast_*` triggers on `transactions`/`accounts`/`loans`, and one SELECT policy on `realtime.messages`. It shares no object with any §1 or §2 file, so it is order-independent in practice; "last" is just the safe default for a new file. |
| **Breaking?** | **No — safe to apply ahead of the client, and that is the intended sequence.** The client side is behind `VITE_REALTIME_BROADCAST` (default OFF). With the flag off, the triggers write broadcasts nobody subscribes to; nothing in the shipped client changes. |
| **Prerequisite** | Broadcast-from-database must exist on the project (`realtime.send(jsonb,text,text,boolean)`). Check V1 in the file's §6 answers this. Every DDL block is guarded, so the file applies cleanly even where it does not — the triggers are then inert. |
| **Verification** | §6 of the file: V1 (`realtime.send` present), V2 (9 triggers enabled), V3 (SECURITY DEFINER + pinned search_path), V4 (policies on `realtime.messages` — there must be **no** client INSERT policy), V5 (publication untouched), V6 (**live proof**: save one expense, expect broadcast rows). |
| **Rollback** | §4 of the file (drop the triggers/function/policy). In practice the rollback is unsetting the client flag — the DB side is inert without a subscriber. |
| **Follow-up, NOT part of applying it** | §5 of the file drops `transactions`/`accounts`/`loans` from the `supabase_realtime` publication. Run that **only after** every shipped client (web *and* the Play Store Android binary, which lags) has the flag ON — otherwise old clients go silently stale. |

Integration-tested on `postgres:15` in Docker against a stubbed `realtime`
schema (the real `realtime.messages` / `realtime.send` / `realtime.topic` do
not exist on a bare Postgres image; the stubs are written out at the end of
the file's §6). Applied clean, re-applied clean, and both failure guards were
exercised: a money write commits when `realtime.send` is absent, and when it
raises. Not proven by that harness: actual delivery by the hosted Realtime
service and the private-channel authorization handshake — use V6 plus a
two-device check on staging.

Rollout narrative and the client-side flag contract: `docs/performance.md` §6.
