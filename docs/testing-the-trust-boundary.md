# Testing the trust boundary

**Written:** 2026-09-02 · Audit item **M7** (`docs/audit-2026-09/13-engineering-standards.md` §2.7, `02-repository-architecture.md` M-2).

Hisaab has no server. Every security decision the product makes — who may read a
group ledger, who may settle a debt, who may delete an account — is a Postgres
policy, trigger or `SECURITY DEFINER` function, spread across a base schema and
55 migration files that are **applied by hand in Supabase Studio**, whose
filenames do not sort into apply order, and which had, until this document, no
automated verification of any kind. The unit suite deliberately covers pure
functions only (`vitest.config.ts`), so nothing in CI ever touched that
boundary.

`supabase/tests/` closes that. It builds a Supabase-shaped Postgres from
scratch, applies the entire corpus in the canonical order, and then attacks it
as role `authenticated` with several different users.

---

## Running it locally

You need Docker. Nothing else — not psql, not the Supabase CLI.

```bash
bash supabase/tests/run.sh
```

That will:

1. `docker run postgres:15` on host port 55432 (override with `PG_PORT`),
2. apply `supabase/tests/scaffold.sql` — the Supabase-shaped prerequisites,
3. apply every file in `supabase/tests/apply-order.txt`, each with
   `psql -v ON_ERROR_STOP=1`, aborting on the first failure,
4. run every `supabase/tests/tests/*.sql` in filename order,
5. print a per-suite tally and exit non-zero if a single assertion failed.

Takes about 30–80 seconds end to end depending on the machine.

Useful flags:

| Flag | Effect |
|---|---|
| `--apply-only` | Apply the corpus and stop. Answers "does this migration compose?" |
| `--keep` | Leave the container running afterwards, and print how to reach it |
| `--shell` | Apply, then drop straight into `psql` inside the container |

To point it at a database you already have (this is what CI does):

```bash
HISAAB_TEST_DSN=postgresql://postgres:postgres@127.0.0.1:5432/hisaab \
  bash supabase/tests/run.sh
```

In that mode `run.sh` creates no container and needs `psql` on `PATH`.

### In CI

`.github/workflows/db-tests.yml` runs the same script on every push and PR to
`main`, against a `postgres:15` service container. It also fails the build if a
`supabase-migration-*.sql` file exists in the repo that `apply-order.txt` does
not list — that check is what stops a new migration from being silently
untested.

---

## What is in the directory

| File | What it is |
|---|---|
| `scaffold.sql` | The Supabase-shaped prerequisites: roles, `auth.users`, `auth.uid()`, storage/pg_net shims, the realtime publication, public-schema default privileges, and the `test.*` assertion helper. **Not a migration** — production already has all of it. |
| `prelude-notifications-rls.sql` | Four `DROP POLICY IF EXISTS` lines. See "the replay drift" below. **Not a migration.** |
| `apply-order.txt` | The canonical ordered file list, from `docs/audit-2026-09/APPLY-ORDER.md`. Comments and blanks ignored. |
| `run.sh` | The runner. |
| `tests/*.sql` | The assertions, one file per concern. |

### Why a hand-rolled assertion helper and not pgTAP

pgTAP is not in the `postgres:15` image. Installing it in CI means either a
custom image or apt + build tooling on every run, to get a dozen functions that
`scaffold.sql` §7 provides in sixty lines. The trade is deliberate: the CI job
is `docker run postgres:15` with **zero** extra dependencies, and the helper's
whole surface fits on one screen.

The helper:

| Function | Use |
|---|---|
| `test.suite(name)` | Label the assertions that follow |
| `test.assert(bool, name [, detail])` | Record a boolean |
| `test.assert_raises(sql, substring, name)` | Run SQL, expect an error containing `substring` |
| `test.assert_ok(sql, name)` | Run SQL, expect no error |
| `test.assert_zero_rows(sql, name)` | Run SQL, expect it to affect **zero rows** |
| `test.as_user(uuid)` | Set `request.jwt.claim.sub` |
| `test.summary()` | Print the tally; `RAISE` if anything failed, or if nothing ran |

`assert_zero_rows` exists because that is the shape RLS actually produces for a
denied `UPDATE`/`DELETE`: not an error, just nothing changed. Asserting for an
exception there would have quietly passed on a database with no policy at all.

`assert` and `summary` are `SECURITY DEFINER` (so a test running as
`authenticated` can still write the results table). `assert_raises`,
`assert_ok` and `assert_zero_rows` are deliberately **`SECURITY INVOKER`** — the
SQL under test must run as the caller, or every RLS assertion in the suite would
silently pass as the table owner.

---

## Adding a test

1. Pick the file whose concern it belongs to, or add a new one. Files run in
   filename order and share one database, so the numbering is load-bearing:

   | File | Concern |
   |---|---|
   | `00-fixtures.sql` | Users A–F, group G1, expense E1, the ex-member C |
   | `10-group-ledger-rls.sql` | Membership, ex-members, ledger policies, catalog shape |
   | `20-notifications-and-consent.sql` | Notification inboxes, contact links, invite tokens |
   | `30-join-lookup-invite-rpcs.sql` | Join / lookup / preview / invite RPC contracts + rate limits |
   | `40-money-integrity.sql` | Split sums, currency whitelist, loan CAS, settlement cap |
   | `50-lifecycle-and-config.sql` | Kameti draw, group deletion, account deletion, `app_config` |
   | `99-summary.sql` | Tally; fails the run |

2. Start the file with `SELECT test.suite('…');`, then `SET ROLE authenticated;`
   and `SELECT test.as_user('<uuid>');`.

3. **Always `SET ROLE authenticated`** (or `anon`) before an assertion about
   access. As the superuser, RLS does not apply and every RLS test passes
   vacuously. `RESET ROLE` deliberately, for catalog checks and for verifying
   that a write really did not land — and note in a comment why.

4. Assert the *observable contract*, not the implementation. `assert_raises`
   matches on a substring of the error, so match the **stable code**
   (`GROUP_HAS_OTHER_MEMBERS`, `LOAN_REMAINING_CONFLICT`) rather than the prose.

5. Never call an RPC twice in one `test.assert(...)` — once for the value and
   once for the detail string. Evaluation order is unspecified and most of these
   RPCs are not idempotent. Land the result in a `CREATE TEMP TABLE _x AS
   SELECT …` first, then read it twice.

6. Rate-limit budgets are **per caller**. A windowed test must use a user no
   earlier test has spent misses for.

7. Anything destructive (account deletion, group deletion) goes in `50-…` and
   uses users E/F, which exist for exactly that reason.

If a test exposes a defect, **do not edit the migration to make it green**.
Report it. A migration is a production artifact applied by hand; changing one
after the fact desynchronises the repo from the database.

---

## A gap this harness found (and that is now closed)

The first run of this suite exposed a real defect in
`supabase-migration-audit-p0-kameti-draw.sql`: both immutability triggers keyed
off `committees.draw_seed IS NOT NULL`, so before any draw an organiser's client
could hand-write `committee_members.slot` on a `payout_method = 'ballot'`
committee and never call `perform_committee_draw()` — a "ballot" kameti with a
hand-picked payout order and no seed (the M10 abuse via the *never draw* path).

The migration was amended in place (it had not been applied anywhere yet): for
`ballot` committees, `slot` and `drawn_at` are server-only both before and after
the draw; for `fixed` committees manual slots stay allowed pre-draw; switching
`fixed → ballot` with slots already set is refused
(`BALLOT_SWITCH_NEEDS_CLEAR_SLOTS`), and the RPC's slotted-guard now raises a
distinct `SLOTS_ALREADY_SET`. `50-lifecycle-and-config.sql` asserts the
refusals and that a genuine draw still succeeds after a rig attempt was refused.
Verification query 5.9 in the migration (`unseeded_ballots_with_an_order`) is
the production-drift check for any pre-existing rigged rows.

## The replay drift (not a bug in production)

`supabase-migration-notifications-rls.sql` will not re-apply against today's
`supabase-schema.sql`: it fails with `42710 policy "Users can view own
notifications" … already exists`, because the schema file was edited **in place**
after that migration was written and now already ships all four policies.
Production is fine — it applied the March schema, which had only
`"Users can manage own notifications"`. What is broken is the repo's
*replayability*: `supabase-schema.sql` is no longer a faithful "run this first"
artifact. `prelude-notifications-rls.sql` drops the four policies so a fresh
database reaches the state production was actually in. Anyone rebuilding a
staging database from this repo needs the same prelude.

---

## What the harness cannot simulate

This proves the SQL **composes and enforces**. It does not prove the deployment
behaves. Everything below is still only provable on staging.

| Area | Status here | What that leaves open |
|---|---|---|
| **PostgREST** | Absent. Every "client" call is raw SQL as `authenticated`. | Named-argument binding for the renamed `accept_group_invite(p_invite_token, …)`; `jsonb` return-shape mapping; `PGRST202` "function not found"; `Prefer: return=representation`. The suite asserts that `SELECT *` on `group_invites` is *refused* — it cannot assert that PostgREST turns that into an HTTP 403 rather than a 500. |
| **PostgREST `max_rows`** | Not simulated. | Supabase caps rows per request (default 1000). The server-side notification fan-out can produce many rows per group action and `group_member_net_balances` returns one row per member; pagination/truncation is untested. |
| **`pg_net`** | Stubbed: `net.http_post()` logs to `net.http_calls` and returns an id. | The real function is async and fire-and-forget. Failures, timeouts and back-pressure against the FCM edge function are unobserved, and `supabase/functions/push-notify` is never invoked. |
| **Realtime** | `supabase_realtime` exists as a plain publication on a `wal_level=replica` server. | Whether notified rows actually reach subscribed clients, and whether the tightened `notifications` INSERT policy breaks the client's subscription filter. |
| **Storage** | `storage.buckets` / `objects` / `foldername()` are hand-rolled shims. | Real Storage RLS, the `receipts` bucket, object ownership. `account-deletion.sql:177` notes `storage.objects` is *not* touched by `delete_current_user`, so a deleted user's receipts survive — untestable here. |
| **GoTrue / `auth.users`** | A 5-column shim. | The real table has ~30 columns plus `auth.identities`, `sessions`, `refresh_tokens`. `delete_current_user()`'s `DELETE FROM auth.users` cascades only through *this repo's* FKs here. Deletion latency and any GoTrue trigger or webhook are unknown. |
| **Roles & JWT claims** | `SET ROLE authenticated` + `set_config('request.jwt.claim.sub', …)`. | Supabase's real `authenticator` → `authenticated` switch, and the claim shape (`request.jwt.claims` JSON on newer versions vs `request.jwt.claim.sub`). Any function reading a claim other than `sub` is uncovered. |
| **Concurrency** | Single session; every lock/CAS assertion is sequential. | The deadlock scenarios `settlement-row-locks` exists to fix (ABBA on two loan rows; lock-order inversion between the two accept RPCs) are still only verified *statically*. Two-session QA on staging is still outstanding. |
| **Data volume** | Empty tables plus ~40 fixture rows. | `performance-indexes` and the balance CTEs have never been seen under load. No `EXPLAIN` is checked. |
| **Production drift** | The harness replays *this repo's files*. | Production is whatever was actually pasted into Studio over five months, including the five migrations `APPLY-ORDER.md` §1 flags as possibly unapplied. **This is the largest gap and it is not closable from here.** Run `supabase-audit-p0-verification.sql` against production and reconcile Section 13 before applying anything. |

### Also out of scope: the browser half of M7

M7 asked for two things. This document is the first: the database trust
boundary. The second — a **Playwright smoke test** covering signup → onboarding
→ create a group → add an expense → settle → sign out — is **not built**. It
needs a `devDependencies` entry and an npm script, i.e. `package.json`, which
was owned by another workstream while this was written. That remains the open
half of M7.
