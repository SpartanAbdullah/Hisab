-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P2 item G5 / O10: per-record edit history ("who changed what")
--   an append-only, server-written change ledger for the four money tables
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- ── APPLY ORDER ─────────────────────────────────────────────────────────────
-- Canonical order: `supabase/tests/apply-order.txt` (see
-- docs/audit-2026-09/APPLY-ORDER.md §2b — that file wins over the prose).
-- This file sits AFTER the last `supabase-migration-p2-*.sql`
-- (`p2-realtime-broadcast`) and BEFORE
-- `supabase-migration-p3-invariant-monitoring.sql`, which must stay last.
--
-- Hard prerequisites (objects this file READS; it replaces none of them):
--   public.group_expenses / group_settlements / loans / transactions  schema
--   ... plus `deleted_at` on all four            incremental-sync-tombstones
--   ... plus `version` on group_expenses         supabase-schema.sql:308
--   public.split_groups                          supabase-schema.sql
--   public.is_group_member(TEXT, UUID)           audit-p0-consent-guards §2.1
--                                                (connected-only membership)
--
-- ── WHAT THIS FILE DOES **NOT** TOUCH ───────────────────────────────────────
-- Nothing existing. It CREATE-OR-REPLACEs no function anybody else owns,
-- rewrites no policy, and drops no trigger it did not create. Every object
-- here is new and prefixed `record_edits` / `*_record_edits`:
--
--   table     public.record_edits
--   functions public.record_edits_splits(JSONB)
--             public.tg_record_edits()
--             public.prune_record_edits(INTEGER, INTEGER)
--   triggers  group_expenses_record_edits, group_settlements_record_edits,
--             loans_record_edits, transactions_record_edits
--   policy    "Members and owners can read edit history" (SELECT only)
--   cron job  hisaab-prune-record-edits (guarded; only if pg_cron exists)
--
-- ── BREAKING CHANGES FOR THE CLIENT ─────────────────────────────────────────
-- None. Purely additive. `editHistoryDb` in src/lib/supabaseDb.ts throws a
-- typed EditHistoryUnavailableError when this table is absent, and
-- EditHistorySheet renders an "not available yet" state — so the client can
-- ship before or after this file with no coordination.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FIXES — evidence
-- ════════════════════════════════════════════════════════════════════════════
--
-- docs/audit-2026-09/11-competitive-analysis.md **G5** (medium):
--   "Splitwise logs who added/edited/deleted every expense in a full activity
--    log; Settle Up syncs edits in real time with member notifications.
--    Hisaab has an activity feed (/activity, App.tsx:456) and client-side
--    Undo/compensation (mutationSafety.ts) but **no surfaced who-changed-what
--    history per record**. For a two-sided ledger — Hisaab's defining feature
--    — edit accountability is the dispute-resolution layer; Settle Up's and
--    Tricount's 2025 sync scandals (members seeing different/vanishing
--    balances) show ledger-integrity doubt is the fatal failure mode."
--
-- …and **O10** in the same file's opportunity table: "Per-record edit history
--   ('who changed what') … Medium (audit columns + RLS across the manual-
--   migration workflow) … the dispute-resolution layer that completes the
--   consent wedge."
--
-- WHY THE EXISTING SURFACES DO NOT COVER IT:
--   • `group_events` (audit-p0-notifications §5) records that an expense was
--     *updated* — never WHICH FIELD moved or FROM WHAT. "Ali updated Hotel"
--     settles no argument about whether the amount went 500 → 450.
--   • `notifications` is per-recipient, prunes at 90/180 days
--     (p2-notification-maturity §9), and carries only a display payload.
--   • `group_expenses.version` proves a row changed; it holds no history.
--   • `updated_by` / `deleted_by` are CLIENT-WRITABLE columns on the row —
--     they hold the LATEST writer only, and a raw PostgREST caller can put
--     anyone's uuid in them. They are evidence of nothing.
--
-- ════════════════════════════════════════════════════════════════════════════
-- DESIGN DECISIONS worth arguing with before changing
-- ════════════════════════════════════════════════════════════════════════════
--
-- D1. **The actor is `auth.uid()` and nothing else.** The notification
--     triggers fall back to `NEW.updated_by` / `NEW.deleted_by`
--     (audit-p0-notifications.sql:478) because a wrong *display name* on a
--     push is cosmetic. An audit trail cannot: those columns are inside the
--     client's WITH CHECK envelope, so a fallback would let a member stamp
--     another member's uuid on their own edit. When `auth.uid()` is NULL —
--     a SECURITY DEFINER RPC invoked by pg_cron, the service_role key, or the
--     push edge function — the row is written with `actor_id = NULL` and
--     `actor_kind = 'system'`.
--
--     `actor_kind` exists so that "system did it" stays distinguishable from
--     "a user did it and later deleted their account" (the FK is ON DELETE
--     SET NULL, matching how audit-p0-account-deletion anonymizes rather than
--     erases a shared ledger).
--
-- D2. **`owner_id` is a real column, not a join.** RLS has to answer "may
--     this user read this history row?" for a `loans` row whose loan may have
--     been hard-deleted since (deleteLoanCascade does exactly that). A
--     policy that joined back to `public.loans` would make a deleted loan's
--     history readable by NOBODY *and* would need a per-table CASE. One
--     denormalized uuid, stamped by the trigger from `NEW.user_id`, is
--     cheaper, indexable, and survives the row it describes.
--
-- D3. **A whitelist, never `to_jsonb(NEW)`.** Each trigger declares its own
--     tracked columns as trigger arguments. Only money, date, note,
--     splits and participant columns are listed. Deliberately absent:
--       · `source_account_id` / `destination_account_id` — an account id must
--         never leak into a row a GROUP MEMBER can read (D4), and in
--         `splits_only` (ledger) mode both are NULL anyway, so including them
--         would make the two app modes produce different audit rows for the
--         same user action. They are not tracked in EITHER mode.
--       · `user_id`, `updated_at`, `version`, `deleted_at`, `created_by`,
--         `updated_by`, `deleted_by`, `is_reconciled`, `reconciled_at`,
--         `reconciled_by`, `receipt_path`, `conversion_rate`, `category`,
--         `related_loan_id`, `related_goal_id`, `related_investment_id`.
--     Consequence, stated plainly: an UPDATE that moves only untracked
--     columns writes NO history row. That is the "skip pure updated_at /
--     version bumps and mirror-only no-ops" rule — it falls out of the
--     whitelist diff being empty, not out of a special case.
--
-- D4. **RLS: group rows are shared, personal rows are not.**
--       group_expenses / group_settlements → `group_id` is stamped; ANY
--         connected member of that group may SELECT (via `is_group_member`),
--         plus the author via `owner_id`. This mirrors the row's own SELECT
--         policy (audit-p0-group-ledger-integrity.sql:256) exactly — the
--         history of a row is never more visible than the row.
--       loans / transactions → `group_id` is NULL, so only `owner_id =
--         auth.uid()` matches. A personal loan's history is private, in both
--         app modes.
--     There is NO INSERT, UPDATE or DELETE policy, and the corresponding
--     grants are revoked. The only writer is the SECURITY DEFINER trigger.
--
-- D5. **INSERT/UPDATE only — no DELETE trigger, on purpose.** A hard DELETE
--     of a group ledger row is already impossible (group-ledger-integrity
--     removed the DELETE policies). For `loans` / `transactions` a DELETE
--     trigger would fire once per row during `delete_current_user()`'s
--     `DELETE FROM auth.users` cascade — writing a fresh audit trail of a
--     user in the middle of erasing themselves, which is both a privacy
--     inversion and an unbounded write amplification on account deletion.
--     The `'delete'` action value is reserved in the CHECK so a future
--     migration can add it deliberately without a constraint change; nothing
--     writes it today.
--
-- D6. **Splits are normalized, then compared order-insensitively.**
--     `record_edits_splits()` reduces each split to `{memberId, amount}` and
--     sorts by memberId, so re-serializing the same participants in a
--     different order is not "a change" — and no unexpected key a future
--     client adds to a split object can smuggle itself into the audit row.
--
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. The table
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.record_edits (
  id          BIGSERIAL PRIMARY KEY,
  table_name  TEXT        NOT NULL,
  record_id   TEXT        NOT NULL,
  group_id    TEXT        REFERENCES public.split_groups(id) ON DELETE CASCADE,
  owner_id    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_id    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_kind  TEXT        NOT NULL DEFAULT 'user',
  action      TEXT        NOT NULL,
  changed     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Re-runnable column adds, for a database that got an earlier shape of this
-- file. CREATE TABLE IF NOT EXISTS alone would silently keep the old columns.
ALTER TABLE public.record_edits
  ADD COLUMN IF NOT EXISTS table_name  TEXT,
  ADD COLUMN IF NOT EXISTS record_id   TEXT,
  ADD COLUMN IF NOT EXISTS group_id    TEXT,
  ADD COLUMN IF NOT EXISTS owner_id    UUID,
  ADD COLUMN IF NOT EXISTS actor_id    UUID,
  ADD COLUMN IF NOT EXISTS actor_kind  TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS action      TEXT,
  ADD COLUMN IF NOT EXISTS changed     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT now();

-- `'delete'` is reserved (D5) — no trigger writes it today.
ALTER TABLE public.record_edits DROP CONSTRAINT IF EXISTS record_edits_action_check;
ALTER TABLE public.record_edits
  ADD CONSTRAINT record_edits_action_check
  CHECK (action IN ('insert', 'update', 'delete', 'soft_delete'));

ALTER TABLE public.record_edits DROP CONSTRAINT IF EXISTS record_edits_actor_kind_check;
ALTER TABLE public.record_edits
  ADD CONSTRAINT record_edits_actor_kind_check
  CHECK (actor_kind IN ('user', 'system'));

-- `changed` is always an object of {column: {old, new}} — never an array,
-- never a bare row. Cheap structural backstop for D3.
ALTER TABLE public.record_edits DROP CONSTRAINT IF EXISTS record_edits_changed_object;
ALTER TABLE public.record_edits
  ADD CONSTRAINT record_edits_changed_object
  CHECK (jsonb_typeof(changed) = 'object');

COMMENT ON TABLE public.record_edits IS
  'Audit G5/O10: append-only "who changed what" ledger for group_expenses, group_settlements, loans and transactions. Written ONLY by the SECURITY DEFINER trigger tg_record_edits(); no client INSERT/UPDATE/DELETE policy or grant exists. `changed` holds {column: {old, new}} for a whitelist of money/date/note/splits/participant columns only — never a full row, and never an account id in either app mode.';

COMMENT ON COLUMN public.record_edits.owner_id IS
  'The audited row''s user_id, denormalized so RLS can answer for a loan/transaction whose row has since been hard-deleted (see D2 in the migration header).';
COMMENT ON COLUMN public.record_edits.actor_kind IS
  'user = auth.uid() was present. system = a SECURITY DEFINER path ran with no JWT (pg_cron, service_role, the push edge function). Distinguishes "system did it" from "a user did it and later deleted their account", which also leaves actor_id NULL.';

-- ── 1.1 Indexes ────────────────────────────────────────────────────────────
-- forRecord(table, id): the sheet's only read on a loan / expense screen.
CREATE INDEX IF NOT EXISTS idx_record_edits_record
  ON public.record_edits (table_name, record_id, created_at DESC);

-- forGroup(groupId): a whole group's history, newest first.
CREATE INDEX IF NOT EXISTS idx_record_edits_group
  ON public.record_edits (group_id, created_at DESC)
  WHERE group_id IS NOT NULL;

-- The RLS personal arm.
CREATE INDEX IF NOT EXISTS idx_record_edits_owner
  ON public.record_edits (owner_id, created_at DESC)
  WHERE owner_id IS NOT NULL;

-- The prune predicate (Section 5).
CREATE INDEX IF NOT EXISTS idx_record_edits_prune
  ON public.record_edits (created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. RLS — read-only, and never wider than the audited row (D4)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.record_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members and owners can read edit history" ON public.record_edits;
CREATE POLICY "Members and owners can read edit history"
  ON public.record_edits FOR SELECT TO authenticated
  USING (
    (record_edits.owner_id IS NOT NULL AND record_edits.owner_id = auth.uid())
    OR (
      record_edits.group_id IS NOT NULL
      AND public.is_group_member(record_edits.group_id, auth.uid())
    )
  );

-- No INSERT / UPDATE / DELETE policy, deliberately. Belt and braces at the
-- privilege layer too, so a future `GRANT ALL ON ALL TABLES` cannot quietly
-- open a write door that RLS would then have to hold shut alone.
REVOKE ALL ON public.record_edits FROM PUBLIC;
REVOKE ALL ON public.record_edits FROM anon;
REVOKE ALL ON public.record_edits FROM authenticated;
GRANT SELECT ON public.record_edits TO authenticated;

-- The client never inserts, so it never needs the sequence.
REVOKE ALL ON SEQUENCE public.record_edits_id_seq FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Split normalization (D6)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_edits_splits(p_val JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_val IS NULL OR jsonb_typeof(p_val) <> 'array' THEN NULL
    ELSE COALESCE(
      (
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'memberId', COALESCE(e.value ->> 'memberId', e.value ->> 'member_id'),
                   'amount',   e.value -> 'amount'
                 )
                 ORDER BY COALESCE(e.value ->> 'memberId', e.value ->> 'member_id')
               )
          FROM jsonb_array_elements(p_val) AS e(value)
      ),
      '[]'::jsonb
    )
  END;
$$;

COMMENT ON FUNCTION public.record_edits_splits(JSONB) IS
  'Reduces a group_expenses.splits array to a sorted [{memberId, amount}] projection so the audit diff is order-insensitive and cannot carry keys a future client adds to a split object.';

REVOKE ALL ON FUNCTION public.record_edits_splits(JSONB) FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. The trigger function
--
-- ONE generic function, driven by each trigger's own column whitelist in
-- TG_ARGV. Adding a table later means adding a trigger, not editing this.
--
-- SECURITY DEFINER because the caller is `authenticated`, which has no INSERT
-- privilege on record_edits and no INSERT policy (Section 2) — exactly the
-- shape audit-p0-notifications.sql uses for its own fan-out triggers.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_record_edits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old     JSONB;
  v_new     JSONB;
  v_changed JSONB := '{}'::jsonb;
  v_col     TEXT;
  v_ov      JSONB;
  v_nv      JSONB;
  v_action  TEXT;
  v_actor   UUID  := auth.uid();
  v_group   TEXT;
  v_owner   UUID;
BEGIN
  v_new := to_jsonb(NEW);
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
  END IF;

  -- ── 4.1 Which kind of event is this? ─────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    -- A row born already soft-deleted is a sync artefact, not an event. Same
    -- refusal the notification triggers make (audit-p0-notifications.sql:434).
    IF (v_new ->> 'deleted_at') IS NOT NULL THEN
      RETURN NULL;
    END IF;
    v_action := 'insert';

  ELSIF (v_old ->> 'deleted_at') IS NULL AND (v_new ->> 'deleted_at') IS NOT NULL THEN
    v_action := 'soft_delete';

  ELSIF (v_new ->> 'deleted_at') IS NOT NULL THEN
    -- An already-dead row being touched (an undelete is handled below only if
    -- deleted_at goes back to NULL, which the app never does). Nothing to say.
    RETURN NULL;

  ELSE
    v_action := 'update';
  END IF;

  -- ── 4.2 The whitelist diff (D3) ──────────────────────────────────────────
  FOREACH v_col IN ARRAY TG_ARGV LOOP
    -- A column the table does not have (an older production shape) is skipped
    -- rather than exploding inside somebody's money write.
    CONTINUE WHEN NOT (v_new ? v_col);

    IF v_col = 'splits' THEN
      v_nv := public.record_edits_splits(v_new -> v_col);
      v_ov := CASE WHEN v_old IS NULL THEN NULL
                   ELSE public.record_edits_splits(v_old -> v_col) END;
    ELSE
      v_nv := NULLIF(v_new -> v_col, 'null'::jsonb);
      v_ov := CASE WHEN v_old IS NULL THEN NULL
                   ELSE NULLIF(v_old -> v_col, 'null'::jsonb) END;
    END IF;

    -- An empty string is ABSENCE, not a value. `notes`, `note`, `date`,
    -- `description` and `related_person` all default to '' in this schema, so
    -- without this every INSERT would carry a meaningless `notes: ""` entry,
    -- and "" → "paid at the table" would render as a value-to-value change
    -- instead of "set the note".
    IF v_nv IS NOT NULL AND jsonb_typeof(v_nv) = 'string' AND (v_nv #>> '{}') = '' THEN
      v_nv := NULL;
    END IF;
    IF v_ov IS NOT NULL AND jsonb_typeof(v_ov) = 'string' AND (v_ov #>> '{}') = '' THEN
      v_ov := NULL;
    END IF;

    IF v_action = 'insert' THEN
      -- The values this record came into existence with.
      IF v_nv IS NOT NULL THEN
        v_changed := v_changed || jsonb_build_object(
          v_col, jsonb_build_object('old', NULL, 'new', v_nv));
      END IF;

    ELSIF v_action = 'soft_delete' THEN
      -- The values that just stopped counting. `new` is null on every entry:
      -- the whole record went away, not one field.
      IF v_nv IS NOT NULL THEN
        v_changed := v_changed || jsonb_build_object(
          v_col, jsonb_build_object('old', v_nv, 'new', NULL));
      END IF;

    ELSE
      -- jsonb equality compares numbers numerically, so 500 and 500.00 are
      -- the same value and do NOT produce a history row.
      IF v_ov IS DISTINCT FROM v_nv THEN
        v_changed := v_changed || jsonb_build_object(
          v_col, jsonb_build_object('old', v_ov, 'new', v_nv));
      END IF;
    END IF;
  END LOOP;

  -- THE no-op rule. An UPDATE that moved only updated_at, version, a
  -- reconcile flag, or nothing at all (the offline mirror re-pushing an
  -- identical row) leaves the whitelist diff empty and writes nothing.
  IF v_action = 'update' AND v_changed = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  -- ── 4.3 Provenance ───────────────────────────────────────────────────────
  IF v_new ? 'group_id' THEN
    v_group := v_new ->> 'group_id';
  END IF;
  v_owner := NULLIF(v_new ->> 'user_id', '')::uuid;

  INSERT INTO public.record_edits
    (table_name, record_id, group_id, owner_id, actor_id, actor_kind, action, changed)
  VALUES (
    TG_TABLE_NAME,
    v_new ->> 'id',
    v_group,
    v_owner,
    v_actor,                                           -- D1: never updated_by
    CASE WHEN v_actor IS NULL THEN 'system' ELSE 'user' END,
    v_action,
    v_changed
  );

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.tg_record_edits() IS
  'Audit G5/O10: writes one public.record_edits row per meaningful INSERT / UPDATE / soft-delete of a money row. Tracked columns come from the trigger''s own TG_ARGV whitelist (money, date, note, splits, participants — never account ids, never a full row). An UPDATE whose whitelist diff is empty writes nothing, which is how pure updated_at/version bumps and mirror-only no-ops are skipped. Actor is auth.uid() only; NULL means a definer/cron path and is stamped actor_kind=system.';

REVOKE ALL ON FUNCTION public.tg_record_edits() FROM PUBLIC, anon, authenticated;

-- ── 4.4 The four triggers ──────────────────────────────────────────────────
--
-- NAME ORDERING. Postgres fires per-row triggers of the same timing in NAME
-- order. These are all AFTER triggers, so they cannot affect what any BEFORE
-- guard (version_guard, require_connected_members, validate_split_amounts,
-- block_when_archived) sees or rejects — a refused write never reaches an
-- AFTER trigger, and no history row is written for it. Resulting AFTER order
-- on the two group tables, for the record:
--
--   group_expenses     : …_notify → …_reconciliation_payer → …_record_edits
--   group_settlements  : …_notify → …_record_edits
--   loans/transactions : …_record_edits → trg_broadcast_* (p2-realtime-broadcast)
--
-- Being last on the group tables is the useful position: the notification
-- fan-out has already run, so a failure here cannot swallow a notification,
-- and both live in the same transaction as the money write.

DROP TRIGGER IF EXISTS group_expenses_record_edits ON public.group_expenses;
CREATE TRIGGER group_expenses_record_edits
  AFTER INSERT OR UPDATE ON public.group_expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_record_edits(
    'amount', 'description', 'date', 'notes', 'paid_by', 'split_type', 'splits');

DROP TRIGGER IF EXISTS group_settlements_record_edits ON public.group_settlements;
CREATE TRIGGER group_settlements_record_edits
  AFTER INSERT OR UPDATE ON public.group_settlements
  FOR EACH ROW EXECUTE FUNCTION public.tg_record_edits(
    'amount', 'date', 'note', 'from_member', 'to_member');

-- loans: `created_at` is the loan's date. No account column exists on this
-- table at all, so both app modes log identically by construction.
DROP TRIGGER IF EXISTS loans_record_edits ON public.loans;
CREATE TRIGGER loans_record_edits
  AFTER INSERT OR UPDATE ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.tg_record_edits(
    'person_name', 'person_id', 'total_amount', 'remaining_amount',
    'currency', 'status', 'notes');

-- transactions: `created_at` IS the user-visible date (there is no separate
-- date column — src/db/types.ts Transaction), and it is editable, so a moved
-- date shows up as a created_at change. source_account_id /
-- destination_account_id are ABSENT on purpose (D3): a splits_only ledger row
-- carries BOTH as NULL, and a full_tracker row carries real ids — tracking
-- them would make the two modes produce different history for the same act.
DROP TRIGGER IF EXISTS transactions_record_edits ON public.transactions;
CREATE TRIGGER transactions_record_edits
  AFTER INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.tg_record_edits(
    'amount', 'currency', 'related_person', 'person_id', 'notes', 'created_at');

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. Lifecycle — 180-day pruning
--
-- Same shape as prune_notifications (p2-notification-maturity §9): bounded
-- per call so a first run on a large table cannot hold a long lock, never
-- granted to a client role, scheduled behind a pg_cron guard.
--
-- 180 days is the retention chosen for a DISPUTE window, not for forensics:
-- a group trip or a personal loan argument that is still live six months
-- later is not going to be settled by an audit row. It is deliberately
-- longer than the notification retention (90 read / 180 unread) so a
-- notification a member is still holding always still has its history behind
-- it.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.prune_record_edits(
  p_days  INTEGER DEFAULT 180,
  p_limit INTEGER DEFAULT 20000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER := 0;
BEGIN
  WITH doomed AS (
    SELECT e.id
      FROM public.record_edits e
     WHERE e.created_at < now() - make_interval(days => GREATEST(p_days, 1))
     ORDER BY e.created_at
     LIMIT GREATEST(p_limit, 1)
  )
  DELETE FROM public.record_edits e
   USING doomed d
   WHERE e.id = d.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.prune_record_edits(INTEGER, INTEGER) IS
  'Audit G5/O10 lifecycle: deletes record_edits rows older than 180 days. Bounded per call (default 20k); returns the count deleted. Re-run until it returns 0. Never grant to a client role.';

REVOKE ALL ON FUNCTION public.prune_record_edits(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;

-- ── 5.1 Scheduling, guarded ────────────────────────────────────────────────
-- pg_cron is available on Supabase but NOT enabled by default, and this file
-- must apply cleanly without it (including in the Docker test harness).
-- Guarded exactly like p2-notification-maturity §9.1, and it unschedules only
-- ITS OWN jobname — the two jobs that file owns are untouched.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('hisaab-prune-record-edits');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    -- 03:41 UTC ≈ 08:41 PKT — after the quiet window, and 24 minutes after
    -- hisaab-prune-notifications so the two deletes never overlap.
    PERFORM cron.schedule(
      'hisaab-prune-record-edits', '41 3 * * *',
      'SELECT public.prune_record_edits();'
    );
    RAISE NOTICE 'p2-edit-history: pg_cron job scheduled (hisaab-prune-record-edits)';
  ELSE
    RAISE NOTICE 'p2-edit-history: pg_cron NOT installed — scheduling skipped.';
    RAISE NOTICE '  Enable it in Supabase Studio → Database → Extensions → pg_cron, then re-run THIS FILE (idempotent), or';
    RAISE NOTICE '  schedule this statement daily from Studio → Integrations → Cron:';
    RAISE NOTICE '    SELECT public.prune_record_edits();   -- 180-day edit-history retention';
  END IF;
END;
$$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION — read-only. Run after the COMMIT above.
-- Every assertion aborts with a descriptive message; a clean run prints
-- "p2-edit-history: OK".
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n INTEGER;
BEGIN
  -- V1. The table exists, RLS is on, and it has exactly one policy: SELECT.
  IF to_regclass('public.record_edits') IS NULL THEN
    RAISE EXCEPTION 'record_edits is missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.record_edits'::regclass) THEN
    RAISE EXCEPTION 'record_edits has RLS DISABLED';
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'record_edits';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'record_edits should carry exactly 1 policy (SELECT), found %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'record_edits' AND cmd <> 'SELECT';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'record_edits carries a non-SELECT policy — clients must never write history';
  END IF;

  -- V2. Privileges: authenticated may read and nothing else; anon sees nothing.
  IF NOT has_table_privilege('authenticated', 'public.record_edits', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated cannot SELECT record_edits — the sheet would be empty for everyone';
  END IF;
  IF has_table_privilege('authenticated', 'public.record_edits', 'INSERT')
     OR has_table_privilege('authenticated', 'public.record_edits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.record_edits', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated still holds a WRITE privilege on record_edits';
  END IF;
  IF has_table_privilege('anon', 'public.record_edits', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read record_edits';
  END IF;

  -- V3. All four triggers are installed and enabled.
  SELECT count(*) INTO v_n
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal
     AND t.tgname IN ('group_expenses_record_edits', 'group_settlements_record_edits',
                      'loans_record_edits', 'transactions_record_edits')
     AND c.relname IN ('group_expenses', 'group_settlements', 'loans', 'transactions')
     AND t.tgenabled <> 'D';
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'expected 4 enabled record_edits triggers, found %', v_n;
  END IF;

  -- V4. No trigger tracks an account id (D3 / both app modes).
  SELECT count(*) INTO v_n
    FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgname LIKE '%\_record\_edits'
     AND encode(t.tgargs, 'escape') LIKE '%account_id%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'a record_edits trigger tracks an account id column — ledger mode and full-tracker mode would log differently';
  END IF;

  -- V5. The writer is SECURITY DEFINER with a pinned search_path.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'tg_record_edits'
       AND p.prosecdef AND 'search_path=public' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'tg_record_edits is not SECURITY DEFINER with search_path=public';
  END IF;

  -- V6. The prune function exists and no client role can call it.
  IF to_regprocedure('public.prune_record_edits(integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'prune_record_edits is missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.prune_record_edits(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute prune_record_edits';
  END IF;

  RAISE NOTICE 'p2-edit-history: OK';
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- OPERATOR QUERIES — read-only, run by hand after applying.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Q1. Volume census by table. `transactions` is expected to dominate — every
--     saved expense writes one row. Watch it for a week before deciding
--     whether 180 days is affordable.
--
--   SELECT table_name, action, count(*), min(created_at), max(created_at)
--     FROM public.record_edits GROUP BY 1, 2 ORDER BY 3 DESC;
--
-- Q2. Table size, the number that actually matters for the retention call.
--
--   SELECT pg_size_pretty(pg_total_relation_size('public.record_edits'));
--
-- Q3. Leak check — should return ZERO rows, forever. Any hit means a trigger
--     whitelist grew an account id.
--
--   SELECT id, table_name, record_id
--     FROM public.record_edits
--    WHERE changed::text ILIKE '%account_id%'
--       OR changed ?| ARRAY['source_account_id', 'destination_account_id'];
--
-- Q4. Actor census. A large `system` share on group tables means definer RPCs
--     are running without a JWT and the trail is losing names.
--
--   SELECT actor_kind, count(*) FROM public.record_edits GROUP BY 1;
--
-- Q5. Orphan census — history rows whose subject row no longer exists
--     (a hard-deleted loan or transaction). Expected non-zero and harmless;
--     they stay readable by their owner until pruned.
--
--   SELECT count(*) FROM public.record_edits e
--    WHERE e.table_name = 'loans'
--      AND NOT EXISTS (SELECT 1 FROM public.loans l WHERE l.id = e.record_id);
--
-- Q6. Is the pruning job actually running? (pg_cron only)
--
--   SELECT jobname, schedule, active FROM cron.job
--    WHERE jobname = 'hisaab-prune-record-edits';
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS group_expenses_record_edits    ON public.group_expenses;
--   DROP TRIGGER IF EXISTS group_settlements_record_edits ON public.group_settlements;
--   DROP TRIGGER IF EXISTS loans_record_edits             ON public.loans;
--   DROP TRIGGER IF EXISTS transactions_record_edits      ON public.transactions;
--   DROP FUNCTION IF EXISTS public.tg_record_edits();
--   DROP FUNCTION IF EXISTS public.prune_record_edits(INTEGER, INTEGER);
--   DROP FUNCTION IF EXISTS public.record_edits_splits(JSONB);
--   -- keep the table if you want the history; otherwise:
--   -- DROP TABLE IF EXISTS public.record_edits;
--   SELECT cron.unschedule('hisaab-prune-record-edits');   -- pg_cron only
-- ════════════════════════════════════════════════════════════════════════════
