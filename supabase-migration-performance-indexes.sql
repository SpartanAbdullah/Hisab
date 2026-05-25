-- ═══════════════════════════════════════════════════════════
-- Performance indexes
--
-- Adds btree indexes for the (user_id, …) / (group_id, …) /
-- (from_user_id, …) / (to_user_id, …) access patterns that the app's
-- list and detail queries actually use (see src/lib/supabaseDb.ts).
--
-- Every statement is:
--   • CREATE INDEX IF NOT EXISTS — idempotent, safe to re-run.
--
-- No table is dropped or altered. No RLS policy is touched.
-- No existing index is replaced. Where an equivalent partial/composite
-- index already exists (from earlier phase migrations) this file
-- intentionally skips it — see the "Already exists, skipping" comments
-- inline.
--
-- ────────────────────────────────────────────────────────────
-- HOW TO RUN
-- ────────────────────────────────────────────────────────────
-- Paste this whole file into Supabase Studio → SQL Editor → Run.
-- The editor wraps multi-statement submissions in a single transaction,
-- which is fine here: every statement is plain CREATE INDEX (no
-- CONCURRENTLY), so the whole file commits atomically. If anything
-- fails, nothing is created.
--
-- Lock impact: each CREATE INDEX takes a SHARE lock on its table for
-- the build duration. That blocks writes (INSERT/UPDATE/DELETE) to that
-- table only, but allows reads. For tables in this app the builds are
-- expected to complete in well under a second — the largest tables
-- (transactions, group_expenses) are still tiny by Postgres standards.
--
-- If you later need true zero-downtime index builds on a much larger
-- dataset, run individual statements as `CREATE INDEX CONCURRENTLY
-- IF NOT EXISTS …` from the SQL editor ONE STATEMENT AT A TIME (the
-- editor's single-tx wrapper rejects CONCURRENTLY in multi-statement
-- runs).
-- ───────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════
-- PRE-FLIGHT — list existing indexes so the diff is auditable.
-- Run this block BEFORE the CREATE statements; save the output.
-- ════════════════════════════════════════════════════════════
-- SELECT
--   schemaname,
--   tablename,
--   indexname,
--   indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public'
-- ORDER BY tablename, indexname;


-- ────────────────────────────────────────────────────────────
-- accounts
-- ────────────────────────────────────────────────────────────

-- accountsDb.getAll: WHERE user_id = ? ORDER BY created_at ASC
-- Also covers accountsDb.count (user_id-only filter).
CREATE INDEX IF NOT EXISTS idx_accounts_user_created
  ON public.accounts (user_id, created_at);


-- ────────────────────────────────────────────────────────────
-- transactions  (the heaviest list in the app)
-- ────────────────────────────────────────────────────────────

-- transactionsDb.getAll: WHERE user_id = ? ORDER BY created_at DESC
-- A DESC index lets the planner pull the rows in order without a sort.
CREATE INDEX IF NOT EXISTS idx_transactions_user_created
  ON public.transactions (user_id, created_at DESC);

-- Already exists (phase1-persons migration):
--   transactions_person_id_idx ON transactions (person_id)


-- ────────────────────────────────────────────────────────────
-- loans
-- ────────────────────────────────────────────────────────────

-- loansDb.getAll: WHERE user_id = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_loans_user_created
  ON public.loans (user_id, created_at DESC);

-- Already exists (phase1-persons migration):
--   loans_person_id_idx ON loans (person_id)


-- ────────────────────────────────────────────────────────────
-- persons
-- ────────────────────────────────────────────────────────────

-- Already exists (phase1-persons migration):
--   persons_user_id_idx           ON persons (user_id)
--   persons_user_name_lower_idx   ON persons (user_id, lower(name))
-- personsDb.getAll orders by raw `name`. Contact lists are short (tens of
-- rows), so an extra (user_id, name) index would be redundant — the
-- existing (user_id) index narrows the row set and an in-memory sort
-- on a few dozen rows is free. No new index added here.


-- ────────────────────────────────────────────────────────────
-- goals
-- ────────────────────────────────────────────────────────────

-- goalsDb.getAll: WHERE user_id = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_goals_user_created
  ON public.goals (user_id, created_at DESC);


-- ────────────────────────────────────────────────────────────
-- upcoming_expenses
-- ────────────────────────────────────────────────────────────

-- upcomingExpensesDb.getAll: WHERE user_id = ? ORDER BY due_date ASC
CREATE INDEX IF NOT EXISTS idx_upcoming_user_due
  ON public.upcoming_expenses (user_id, due_date);


-- ────────────────────────────────────────────────────────────
-- activities
-- ────────────────────────────────────────────────────────────

-- activitiesDb.getAll: WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100
CREATE INDEX IF NOT EXISTS idx_activities_user_ts
  ON public.activities (user_id, "timestamp" DESC);

-- activitiesDb.getByEntity: WHERE user_id = ? AND related_entity_id = ?
--                          ORDER BY timestamp DESC
CREATE INDEX IF NOT EXISTS idx_activities_user_entity_ts
  ON public.activities (user_id, related_entity_id, "timestamp" DESC);


-- ────────────────────────────────────────────────────────────
-- notifications
-- ────────────────────────────────────────────────────────────

-- notificationsDb.getAll: WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications (user_id, created_at DESC);

-- notificationsDb.markAllRead: WHERE user_id = ? AND read_at IS NULL
-- Partial index — only stores unread rows, so the unread-badge count is
-- effectively a row-count scan over a tiny slice.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON public.notifications (user_id)
  WHERE read_at IS NULL;

-- notificationsDb.markGroupRead: WHERE user_id = ? AND group_id = ?
--                                AND read_at IS NULL
CREATE INDEX IF NOT EXISTS idx_notifications_user_group_unread
  ON public.notifications (user_id, group_id)
  WHERE read_at IS NULL;


-- ────────────────────────────────────────────────────────────
-- linked_transaction_requests  (Phase 2B inbox)
-- ────────────────────────────────────────────────────────────

-- linkedRequestsDb.getAll: WHERE from_user_id = ? OR to_user_id = ?
--                         ORDER BY created_at DESC
-- The two partial indexes from phase2b only cover status='pending'. The
-- inbox page loads ALL statuses (accepted/rejected history is visible).
-- These full-coverage indexes feed the OR-BitmapOr scan for that query.
CREATE INDEX IF NOT EXISTS idx_ltr_from_created
  ON public.linked_transaction_requests (from_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ltr_to_created
  ON public.linked_transaction_requests (to_user_id, created_at DESC);

-- Already exist (phase2b-linked-requests migration):
--   idx_ltr_to_pending   ON linked_transaction_requests (to_user_id, created_at DESC)
--                        WHERE status = 'pending'
--   idx_ltr_from_pending ON linked_transaction_requests (from_user_id, created_at DESC)
--                        WHERE status = 'pending'


-- ────────────────────────────────────────────────────────────
-- linked_settlement_requests  (Phase 2C inbox)
-- ────────────────────────────────────────────────────────────

-- settlementRequestsDb.getAll: same OR pattern as linked_transaction_requests.
CREATE INDEX IF NOT EXISTS idx_lsr_from_created
  ON public.linked_settlement_requests (from_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lsr_to_created
  ON public.linked_settlement_requests (to_user_id, created_at DESC);

-- Already exist (phase2c-a + fix-bidirectional migrations):
--   idx_lsr_to_pending, idx_lsr_from_pending, idx_lsr_pair


-- ────────────────────────────────────────────────────────────
-- emi_schedules
-- ────────────────────────────────────────────────────────────

-- emiSchedulesDb.deleteByLoan: WHERE loan_id = ? AND user_id = ?
-- Also accelerates in-app filters that look up schedules for a loan.
CREATE INDEX IF NOT EXISTS idx_emi_loan
  ON public.emi_schedules (loan_id);

-- emiSchedulesDb.getAll: WHERE user_id = ? ORDER BY installment_number ASC
CREATE INDEX IF NOT EXISTS idx_emi_user_installment
  ON public.emi_schedules (user_id, installment_number);


-- ────────────────────────────────────────────────────────────
-- budgets
-- ────────────────────────────────────────────────────────────

-- Already exists (phase3 migration):
--   budgets_user_id_idx ON budgets (user_id)
-- budgetsDb.getAll orders by `category`. With one row per category per
-- user, the row count is tiny — no extra ORDER-BY index needed.


-- ────────────────────────────────────────────────────────────
-- recurring_transactions
-- ────────────────────────────────────────────────────────────

-- recurringTransactionsDb.getAll: WHERE user_id = ? ORDER BY next_due_date ASC
-- A non-partial index covering the full list-fetch (the phase3 partial
-- index only fires when WHERE active = true is present, which this query
-- does not include).
CREATE INDEX IF NOT EXISTS idx_recurring_user_due
  ON public.recurring_transactions (user_id, next_due_date);

-- Already exist (phase3 migration):
--   recurring_user_id_idx  ON recurring_transactions (user_id)
--   recurring_due_date_idx ON recurring_transactions (user_id, next_due_date)
--                          WHERE active = true


-- ────────────────────────────────────────────────────────────
-- remittances
-- ────────────────────────────────────────────────────────────

-- Already exists (phase3 migration):
--   remittances_sent_at_idx ON remittances (user_id, sent_at DESC)
-- Exactly matches remittancesDb.getAll. No new index needed.


-- ────────────────────────────────────────────────────────────
-- split_groups
-- ────────────────────────────────────────────────────────────

-- splitGroupsDb.getAll: WHERE user_id = ? ORDER BY created_at DESC
-- (Owned-groups query; membership query goes via group_members.)
CREATE INDEX IF NOT EXISTS idx_split_groups_user_created
  ON public.split_groups (user_id, created_at DESC);


-- ────────────────────────────────────────────────────────────
-- group_members
-- ────────────────────────────────────────────────────────────

-- groupMembersDb.getMine + splitGroupsDb.getAll membership join:
--   WHERE profile_id = ? AND status = 'connected'
CREATE INDEX IF NOT EXISTS idx_gmembers_profile_status
  ON public.group_members (profile_id, status);

-- groupMembersDb.getByGroup + new getByGroups (loadGroups O1 batched fetch):
--   WHERE group_id = ?           ORDER BY created_at ASC
--   WHERE group_id IN (…)        ORDER BY created_at ASC
CREATE INDEX IF NOT EXISTS idx_gmembers_group_created
  ON public.group_members (group_id, created_at);


-- ────────────────────────────────────────────────────────────
-- group_expenses
-- ────────────────────────────────────────────────────────────

-- groupExpensesDb.getByGroup: WHERE group_id = ? AND deleted_at IS NULL
--                            ORDER BY created_at DESC
-- Partial index — soft-deleted rows are excluded from every read path
-- the app issues, so we don't waste index space on them.
CREATE INDEX IF NOT EXISTS idx_gexp_group_live
  ON public.group_expenses (group_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- groupExpensesDb.getAllVisible + getAllVisibleForBalances:
--   WHERE deleted_at IS NULL ORDER BY created_at DESC
-- RLS scopes the row set to the user's groups; this index keeps the
-- pre-filter ordered scan cheap.
CREATE INDEX IF NOT EXISTS idx_gexp_live_created
  ON public.group_expenses (created_at DESC)
  WHERE deleted_at IS NULL;


-- ────────────────────────────────────────────────────────────
-- group_settlements
-- ────────────────────────────────────────────────────────────

-- groupSettlementsDb.getByGroup: WHERE group_id = ? AND deleted_at IS NULL
--                                ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_gsett_group_live
  ON public.group_settlements (group_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- groupSettlementsDb.getAllVisible + getAllVisibleForBalances:
--   WHERE deleted_at IS NULL ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_gsett_live_created
  ON public.group_settlements (created_at DESC)
  WHERE deleted_at IS NULL;


-- ────────────────────────────────────────────────────────────
-- group_invites
-- ────────────────────────────────────────────────────────────

-- groupInvitesDb.getByTokenHash: WHERE token_hash = ? AND revoked_at IS NULL
-- token_hash is the join-link's secret material; lookups must be sub-ms.
CREATE INDEX IF NOT EXISTS idx_ginvites_token_active
  ON public.group_invites (token_hash)
  WHERE revoked_at IS NULL;

-- groupInvitesDb.getActiveByGroup: WHERE group_id = ? AND revoked_at IS NULL
--                                  ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_ginvites_group_active
  ON public.group_invites (group_id, created_at DESC)
  WHERE revoked_at IS NULL;


-- ────────────────────────────────────────────────────────────
-- group_events
-- ────────────────────────────────────────────────────────────

-- groupEventsDb.getByGroup: WHERE group_id = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_gevents_group_created
  ON public.group_events (group_id, created_at DESC);


-- ════════════════════════════════════════════════════════════
-- POST-FLIGHT — verify every new index built successfully.
-- ════════════════════════════════════════════════════════════

-- 1. Confirm the new indexes appear. Compare against the pre-flight
--    snapshot. Expect 27 new rows whose indexname begins with `idx_`.
-- SELECT
--   schemaname,
--   tablename,
--   indexname,
--   indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public'
-- ORDER BY tablename, indexname;

-- 2. Count the new indexes added by THIS migration. Expect 27.
-- SELECT COUNT(*) AS new_index_count
-- FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND indexname IN (
--     'idx_accounts_user_created',
--     'idx_transactions_user_created',
--     'idx_loans_user_created',
--     'idx_goals_user_created',
--     'idx_upcoming_user_due',
--     'idx_activities_user_ts',
--     'idx_activities_user_entity_ts',
--     'idx_notifications_user_created',
--     'idx_notifications_user_unread',
--     'idx_notifications_user_group_unread',
--     'idx_ltr_from_created',
--     'idx_ltr_to_created',
--     'idx_lsr_from_created',
--     'idx_lsr_to_created',
--     'idx_emi_loan',
--     'idx_emi_user_installment',
--     'idx_recurring_user_due',
--     'idx_split_groups_user_created',
--     'idx_gmembers_profile_status',
--     'idx_gmembers_group_created',
--     'idx_gexp_group_live',
--     'idx_gexp_live_created',
--     'idx_gsett_group_live',
--     'idx_gsett_live_created',
--     'idx_ginvites_token_active',
--     'idx_ginvites_group_active',
--     'idx_gevents_group_created'
--   );

-- 3. Spot-check one of the heavy queries actually uses the new index.
--    EXPLAIN should show "Index Scan using idx_transactions_user_created"
--    instead of "Seq Scan on transactions".
-- EXPLAIN
-- SELECT *
-- FROM public.transactions
-- WHERE user_id = '00000000-0000-0000-0000-000000000000'
-- ORDER BY created_at DESC
-- LIMIT 100;
