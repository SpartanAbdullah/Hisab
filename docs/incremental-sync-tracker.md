# Incremental Sync Tracker

Status: in progress
Owner split: Codex implements app code and migration files. Abdullah runs Supabase migrations and verifies production data.

## Progress

| Step | Status | Owner | Notes |
| --- | --- | --- | --- |
| Audit schema support | Done | Codex | `updated_at` now exists for accounts, transactions, loans, and budgets after the incremental sync migration. |
| Add local sync metadata | Done | Codex | Dexie `mirrorSync` table added in database version 7. |
| Incremental accounts sync | Done | Codex | Cached accounts load first; stale mirrors use `updated_at` incremental refresh when possible. |
| Core table migration | Done | Codex | `supabase-migration-incremental-sync-core.sql` adds `updated_at` triggers and indexes for transactions, loans, budgets, and idempotently accounts. |
| Apply migration in Supabase | Done | Abdullah | Abdullah confirmed the SQL was run in Supabase and changes were pushed to production. |
| Incremental transactions sync | Done | Codex | Uses `updated_at` incremental merge. Hard deletes still depend on periodic full refresh. |
| Incremental loans sync | Done | Codex | Uses `updated_at` incremental merge. Hard deletes still depend on periodic full refresh. |
| Incremental budgets sync | Done | Codex | Uses `updated_at` incremental merge. Hard deletes still depend on periodic full refresh. |
| Tombstone migration | Done | Codex | `supabase-migration-incremental-sync-tombstones.sql` adds `deleted_at` and deleted-row indexes. |
| Apply tombstone migration | Pending | Abdullah | Run the tombstone migration in Supabase before relying on deleted-row incremental sync in production. |
| Delete/tombstone strategy | Done | Codex | App deletes are now soft deletes for accounts, transactions, loans, and budgets; incremental sync removes tombstones from Dexie. |
| QA: tests/build | Pending | Codex | Run after each implementation slice. |

## Current Decision

Use a hybrid rollout:

- Accounts: true incremental sync now, because `updated_at` is already present.
- Transactions, loans, budgets: true incremental sync is enabled after Abdullah applied `supabase-migration-incremental-sync-core.sql`.
- Deletes: tombstone sync is implemented in app code. It becomes active in production after Abdullah applies `supabase-migration-incremental-sync-tombstones.sql`.

## Abdullah Actions

- Review the generated sync migration before production. Done.
- Apply the migration when ready. Done.
- Confirm whether hard deletes should become soft deletes for transactions, loans, and budgets.
- Apply `supabase-migration-incremental-sync-tombstones.sql` in Supabase.

## Codex Actions

- Implement Dexie sync metadata. Done.
- Implement incremental account merge. Done.
- Generate the migration for remaining core tables. Done.
- Implement incremental transactions, loans, and budgets. Done.
- Implement tombstone sync and soft deletes. Done.
- Keep tests/build green.
