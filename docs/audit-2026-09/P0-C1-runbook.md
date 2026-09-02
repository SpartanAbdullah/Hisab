# P0-C1 Runbook — Prove the production schema state

**Audit item:** C1 in [00-executive-summary.md](00-executive-summary.md) §6.1, and §7.A.1 ("Evidence Unavailable" item #1).
**Effort:** ~15 minutes for Option A. **Blocking:** yes — until this is done, no security statement in the audit (good or bad) is meaningful.

> The audit's #1 finding is that Hisaab's entire trust boundary lives in 40 hand-applied SQL files with no runner, no applied-state ledger, and no drift detection, and that the production verification SQL was **never run** (`docs/play-store-launch-tracker.md:30`). This runbook closes that gap.

---

## What you are proving

Under the *baseline* schema (`supabase-schema.sql:364`), **any authenticated user can insert themselves into any group** as a connected member and read/write that group's whole shared ledger. The fix exists only in `supabase-migration-p0-launch-blockers.sql:152`, which may or may not have been applied. Roughly fifteen audit findings sit on the same "we think this migration ran" foundation.

One script settles all of them: **`supabase-audit-p0-verification.sql`** at the repo root.

It is **strictly read-only** — catalog `SELECT`s only, no `DDL`, no `DML`, no temp tables, no function calls that write. It is safe to run on production at any time. It cannot lock anything, cannot change anything, and cannot fail your database.

---

## Option A — Run it now in Supabase Studio (do this today)

### Steps

1. Open **[supabase.com/dashboard](https://supabase.com/dashboard)** → select the **Hisaab production project**.
   - If you have more than one project, confirm you are on production before running. Section 00 of the output stamps the database name and server so the evidence is attributable after the fact.
2. Left sidebar → **SQL Editor** → **+ New query**.
3. Open `supabase-audit-p0-verification.sql` from the repo root, **select all**, copy, and paste the whole file into the editor.
   - Paste **all of it**. It is deliberately one single `SELECT` statement (with `UNION ALL` blocks) because the Studio editor renders only the **last** statement's result set — splitting it would silently discard most of the checks.
4. Press **Run** (or `Ctrl/Cmd + Enter`). It should complete in under a second.
5. **Export the full result.** Two ways, in order of preference:
   - **Download CSV** — the button at the bottom-right of the results panel. Save it as `docs/audit-2026-09/C1-prod-verification-<YYYY-MM-DD>.csv`.
   - Or click into the grid, `Ctrl/Cmd + A`, `Ctrl/Cmd + C`, and paste into a text file.
   - Do **not** screenshot it. The `detail` column contains full policy predicates that get truncated visually but are the actual evidence.

### Reading the output

Five columns: `sort_key | section | check_name | result | detail`.

- **Read the `result` column first.** Anything starting with `!!` needs attention.
- **Jump straight to `=== SECTION 13: MIGRATION VERDICTS ===`** (sort_key 1301–1310). Ten rows, each a plain-English "is this migration applied?" answer. That is the headline.
- **Section 03** is the detail behind the criticals — most importantly `03.1 group_members INSERT — self-join open?`.
- Sections 01–12 are the raw evidence supporting those verdicts.

The script **reports** rather than aborting on the first failure, so a single run gives you the complete picture even when several migrations are missing.

### What to paste back to Claude

Paste the **whole CSV / whole result grid**. Not a summary, not just the failures — the rows that say "present" are as load-bearing as the ones that say "MISSING," because they are what lets the audit's conditional findings be closed rather than left open.

If the output is too large to paste comfortably, save the CSV into `docs/audit-2026-09/` and tell Claude the file path.

At minimum, if you can only paste a fraction, paste **all of Section 13** plus **all of Section 03**.

### Then: commit the output

```
docs/audit-2026-09/C1-prod-verification-<YYYY-MM-DD>.csv
```

Committing it is half the point of the exercise. It turns "we believe the hardening is applied" into a dated, diffable artifact — the thing a security reviewer or acquirer actually asks for. Re-run and re-commit after every future migration.

---

## Interpreting the seven headline verdicts

Each verdict is keyed on that migration's most distinctive artifact — one that no other file in the repo creates, so a false positive is not possible from an adjacent migration.

| Verdict row | Keyed on | If it says NO |
|---|---|---|
| `p0-launch-blockers applied?` | `is_current_profile_active()` + the `"Active profiles only"` RESTRICTIVE policies + the owner-only `group_members` INSERT policy + `soft_delete_current_user()` being gone | **Stop.** The audit's worst case is live: any user can self-join any group. Apply `supabase-migration-p0-launch-blockers.sql` before anything else. |
| `prelaunch-hardening applied?` | `apply_account_balance_delta(text,numeric,numeric)` + the two `transactions↔accounts` FKs | Every account-balance write is last-writer-wins; two-tab usage loses money. |
| `connections-push-discovery applied?` | `lookup_hisaab_users_by_phone(text[])` + `device_push_tokens` + `app_push_config` | Phone discovery, the contact-link consent flow, and tier-3 push are all dead in production. |
| `cross-user-account-effects applied?` | `linked_transaction_requests.requester_account_id` + the 2-arg `accept_*` RPCs (with the 1-arg ones dropped) | Linked loans never touch real accounts; full-tracker balances drift from reality on accept. |
| `investments applied?` | `investment_markets` / `investment_trades` / `investment_prices` | The Investments tab writes to tables that do not exist. |
| `settlement-emi applied?` | The live `accept_settlement_request` body containing `emi_schedules` | The EMI schedule-desync bug is active — settlements leave instalments showing unpaid on both sides. |
| `contacts-merge-unarchive applied?` | `merge_person(text,text)` + `unarchive_contact(text)` | The Contacts merge and unarchive buttons fail with a 404 from PostgREST. |

Three supporting verdicts follow them: `safe-leave-group`, `enforce-active-group-transaction-members`, and the **join RPC overload state** — that last one flags the live ordering trap where `join_group_by_code` exists in both a 1-arg and a 2-arg form, which makes PostgREST return HTTP 300 on *every* group join.

Two rows deserve a special look regardless of their verdict:

- **Section 06, `lookup_profile_by_public_code`.** The shipped client calls this RPC, but both `prelaunch-hardening.sql:318` and `p0-launch-blockers.sql:386` **drop** it. If Section 05 says "absent (as expected)" *and* Section 06 says "MISSING," that is a live production bug, not a clean bill of health.
- **Section 07, `persons`.** There is deliberately **no** trigger protecting `persons.linked_profile_id`. Its absence in the trigger list is the confirmation of audit finding H2/C6 — the consent predicate every cross-user flow trusts is settable by a plain PATCH.

---

## Option B — Connect the Supabase CLI (do this next)

Option A is a manual afternoon. Option B makes every future verification and migration automatic, and is the second half of audit item C1 ("adopt Supabase CLI migrations, numbered and tracked").

### What you set up, once

1. **Install the CLI** (Windows, PowerShell):
   ```powershell
   npm install -g supabase
   # or: scoop install supabase
   supabase --version
   ```

2. **Create a personal access token**: Supabase Dashboard → account menu → **Access Tokens** → *Generate new token*. Name it something like `hisaab-cli-local`. Copy it — it is shown once.

3. **Log in**:
   ```powershell
   supabase login
   # paste the token when prompted
   ```

4. **Link the repo to the production project**. Get the project ref from the dashboard URL (`https://supabase.com/dashboard/project/<PROJECT_REF>`) or Project Settings → General:
   ```powershell
   cd C:\Users\MuhammadAbdullah\Desktop\Hisaab-2.0
   supabase link --project-ref <PROJECT_REF>
   ```
   This creates `supabase/.temp/` and records the link. It does **not** push anything.

5. **Confirm read access works**:
   ```powershell
   supabase db execute --file supabase-audit-p0-verification.sql
   ```

**Security notes:** the access token is a full-power credential for your Supabase account — keep it out of the repo (`supabase login` stores it in your user profile, not the project). `supabase/.temp/` should be gitignored. Do **not** paste the token, the database password, or the `service_role` key into a chat, an issue, or a commit. Claude never needs any of them — it needs the *output* of queries, not the credentials.

### What Claude can then do, read-only

With the CLI linked, "what does production actually look like?" stops being a question anyone has to answer by hand:

- **Re-run this verification on demand** — `supabase db execute --file supabase-audit-p0-verification.sql` — and diff today's answer against the committed CSV, so schema drift becomes a visible change rather than a discovery during an incident.
- **Dump the live schema** — `supabase db dump --schema public --file prod-schema-snapshot.sql` — and diff it against the repo's SQL to find artifacts that exist in production but in no migration file (the class of drift that two prior in-repo incidents came from).
- **Generate typed rows** — `supabase gen types typescript --linked > src/types/supabase.ts` — which makes schema drift visible to `tsc` instead of surfacing as a runtime `undefined`. Audit item M9 asks for exactly this.
- **Answer specific questions against the catalog** rather than against the repo's assumptions — "is this policy live?", "which overload of this RPC exists?", "is this table in the realtime publication?"

### The migration-runner step (the durable fix)

The remaining half of C1 is moving off hand-applied files. The shape:

1. `supabase init` (if `supabase/config.toml` isn't set up for it yet — the repo already has a `supabase/` directory for the edge function).
2. Convert the 40 root-level `supabase-migration-*.sql` files into timestamped files under `supabase/migrations/`, **in the order they were actually applied to production** — which is precisely what the Option A output tells you. Do not do this before running Option A; the ordering is the whole risk (`fix-settlement-cancel-reject.sql` regressing settlements is the live alphabetical-apply trap).
3. `supabase db push` applies pending migrations and records them in the `supabase_migrations.schema_migrations` ledger — an applied-state ledger, which is the thing the repo has never had.
4. Add a CI job that applies every migration to a throwaway Postgres on each PR, so an unappliable migration fails the build rather than the production database.

Until step 2 is done, keep writing migrations as root-level `supabase-migration-*.sql` files and applying them by hand — do not half-convert.

---

## Appendix — the five existing verification scripts this supersedes

These predate the consolidated script. Each aborts on its first failed assertion (a `DO $$ ... RAISE EXCEPTION $$` block), so each tells you about one problem at a time and stops. Every assertion they make is folded into `supabase-audit-p0-verification.sql`, which reports all of them at once instead.

| Script | Covered what | Now folded into |
|---|---|---|
| `supabase-p0-security-verification.sql` | `delete_current_user` present, `soft_delete_current_user` / `lookup_group_by_join_code` / `join_group_by_code(text)` gone, `accept_group_invite(text,text)` present, owner-only `group_members` INSERT, `"Active profiles only"` RESTRICTIVE policy | Sections 03.1, 03.4, 04, 05, 13.1 |
| `supabase-group-invite-join-verification.sql` | Join/invite RPC signatures and the join-code path | Sections 04, 05, 06, 13.10 |
| `supabase-active-group-transaction-members-verification.sql` | The two `*_require_connected_members` triggers on `group_expenses` / `group_settlements` | Sections 07, 07.x, 13.9 |
| `supabase-safe-leave-group-verification.sql` | `leave_group(text)` and the `group_members` membership-field protect trigger | Sections 04, 07.x, 13.8 |
| `supabase-safe-contact-archive-verification.sql` | `archive_contact_if_settled`, `persons.archived_at`, and the archived-person reference-blocking triggers | Sections 04, 07, 07.x, 11 |

**Run the consolidated script, not these.** They are kept in the repo only as the provenance for the checks above; delete them once the CLI migration ledger exists and the consolidated output is committed.

---

*Prepared for audit item C1, 2026-09-02. The verification script itself is `supabase-audit-p0-verification.sql` at the repo root; every check in it cites the migration file and line that creates or drops the artifact it looks for.*
