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
| 4 | `supabase-migration-audit-p0-kameti-draw.sql` | **BREAKING** — ship with the client | Only depends on `committees` + `committees-phase2` (#33/#34). Independent of everything else in the batch. Breaking because the organiser device can no longer write `draw_seed`/`draw_commitment`/slots — the client must call `perform_committee_draw()`. |
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
