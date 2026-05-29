# Incremental Sync Tracker

Status: in progress
Owner split: Codex implements app code and migration files. Abdullah runs Supabase migrations and verifies production data.

## Progress

| Step | Status | Owner | Notes |
| --- | --- | --- | --- |
| Audit schema support | Done | Codex | `accounts.updated_at` exists in `supabase-migration-prelaunch-hardening.sql`; core `transactions`, `loans`, and `budgets` still need sync columns. |
| Add local sync metadata | Done | Codex | Dexie `mirrorSync` table added in database version 7. |
| Incremental accounts sync | Done | Codex | Cached accounts load first; stale mirrors use `updated_at` incremental refresh when possible. |
| Core table migration | Done | Codex | `supabase-migration-incremental-sync-core.sql` adds `updated_at` triggers and indexes for transactions, loans, budgets, and idempotently accounts. |
| Apply migration in Supabase | Pending | Abdullah | Run the migration in the Supabase SQL editor or migration pipeline. |
| Incremental transactions sync | Pending | Codex | Depends on migration. Needs delete strategy before replacing full refresh completely. |
| Incremental loans sync | Pending | Codex | Depends on migration. |
| Incremental budgets sync | Pending | Codex | Depends on migration. |
| Delete/tombstone strategy | Pending | Codex + Abdullah | Choose soft deletes (`deleted_at`) for mirrored tables or keep periodic full refresh fallback. |
| QA: tests/build | Pending | Codex | Run after each implementation slice. |

## Current Decision

Use a hybrid rollout:

- Accounts: true incremental sync now, because `updated_at` is already present.
- Transactions, loans, budgets: keep cache-first full refresh for now, then switch to incremental after `supabase-migration-incremental-sync-core.sql` is applied.
- Deletes: keep full refresh fallback until we add a deliberate tombstone/soft-delete strategy.

## Abdullah Actions

- Review the generated sync migration before production.
- Apply the migration when ready.
- Confirm whether hard deletes should become soft deletes for transactions, loans, and budgets.

## Codex Actions

- Implement Dexie sync metadata. Done.
- Implement incremental account merge. Done.
- Generate the migration for remaining core tables. Done.
- Keep tests/build green.
