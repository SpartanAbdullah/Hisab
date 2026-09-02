-- ════════════════════════════════════════════════════════════════════════════
-- 8z · Edit history — "who changed what"
--      (supabase-migration-p2-edit-history.sql, audit G5 / O10)
--
-- Evidence:
--   11-competitive-analysis.md G5 — "Hisaab has an activity feed and
--     client-side Undo but no surfaced who-changed-what history per record.
--     For a two-sided ledger — Hisaab's defining feature — edit accountability
--     is the dispute-resolution layer; Settle Up's and Tricount's 2025 sync
--     scandals (members seeing different/vanishing balances) show
--     ledger-integrity doubt is the fatal failure mode."
--   11-competitive-analysis.md O10 — the same item in the opportunity table:
--     "audit columns + RLS across the manual-migration workflow".
--
-- What this file proves:
--   · the table is READ-ONLY to every client role, at both the policy and the
--     privilege layer;
--   · a group row's history is visible to connected members and to nobody
--     else (an ex-member sees zero), while a loan's history is owner-only;
--   · the actor is auth.uid(), NOT the client-writable updated_by column;
--   · pure updated_at bumps and mirror-only no-op writes record NOTHING;
--   · the change JSON never carries an account id, and a splits_only (both
--     account ids NULL) transaction logs identically to a full_tracker one.
--
-- Runs after 50-lifecycle (which leaves G1 unarchived with A and B connected
-- and C as the ex-member) and before 99-summary.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8z-edit-history');

-- ── Catalog shape. Reads pg_* , so RESET ROLE deliberately. ────────────────
RESET ROLE;

SELECT test.assert(
  to_regclass('public.record_edits') IS NOT NULL
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.record_edits'::regclass),
  'record_edits exists with RLS enabled');

SELECT test.assert(
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'record_edits') = 1
  AND NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = 'record_edits'
                     AND cmd <> 'SELECT'),
  'record_edits carries exactly one policy and it is SELECT-only',
  (SELECT string_agg(policyname || ' [' || cmd || ']', ' ; ') FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'record_edits'));

SELECT test.assert(
  has_table_privilege('authenticated', 'public.record_edits', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.record_edits', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.record_edits', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.record_edits', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.record_edits', 'SELECT'),
  'authenticated may only read record_edits; anon may not read it at all');

SELECT test.assert(
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
      AND t.tgname IN ('group_expenses_record_edits', 'group_settlements_record_edits',
                       'loans_record_edits', 'transactions_record_edits')) = 4,
  'all four record_edits triggers are installed and enabled');

-- Both app modes, asserted at the trigger definition: no whitelist may name an
-- account column, or a full_tracker row and a splits_only row would produce
-- different history for the same user action.
SELECT test.assert(
  (SELECT count(*) FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgname LIKE '%\_record\_edits'
      AND encode(t.tgargs, 'escape') LIKE '%account_id%') = 0,
  'no record_edits trigger tracks an account id column');

SELECT test.assert(
  to_regprocedure('public.prune_record_edits(integer,integer)') IS NOT NULL
  AND NOT has_function_privilege('authenticated',
        'public.prune_record_edits(integer,integer)', 'EXECUTE'),
  'prune_record_edits exists (180-day retention) and no client role can call it');

-- ── Everything from here is a client. ──────────────────────────────────────
SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

-- ═══════════════════════════════════════════════════════════════════════════
-- A group expense, through its whole life.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO group_expenses (id, user_id, group_id, description, amount,
                            paid_by, split_type, splits, date, created_by)
SELECT 'E-HIST', auth.uid(), 'G1', 'Dinner', 60.00, 'M-A', 'equal',
       jsonb_build_array(
         jsonb_build_object('memberId', 'M-A', 'amount', 30.00),
         jsonb_build_object('memberId', (SELECT v FROM test.fixture WHERE k = 'M-B'),
                            'amount', 30.00)),
       '2026-08-01', auth.uid();

SELECT test.assert(
  (SELECT count(*) FROM record_edits
    WHERE table_name = 'group_expenses' AND record_id = 'E-HIST'
      AND action = 'insert'
      AND actor_id = '11111111-1111-1111-1111-111111111111'
      AND group_id = 'G1'
      AND changed -> 'amount' ->> 'new' = '60.00') = 1,
  'an expense INSERT writes one history row: action=insert, the actor, the group, the amount');

-- The whitelist is a whitelist. A full row would carry user_id, version,
-- created_by, reconcile flags — none of which belong in a shared ledger.
SELECT test.assert(
  NOT (SELECT changed ?| ARRAY['user_id', 'version', 'created_by', 'updated_by',
                               'deleted_at', 'is_reconciled', 'group_id']
         FROM record_edits
        WHERE record_id = 'E-HIST' AND action = 'insert'),
  'the change JSON is a whitelist projection, never the row',
  (SELECT changed::text FROM record_edits WHERE record_id = 'E-HIST' AND action = 'insert'));

-- D1: the actor is auth.uid(). `updated_by` is inside the client's WITH CHECK
-- envelope, so trusting it would let any member stamp another member's uuid
-- on their own edit. A writes here while naming B as updated_by.
UPDATE group_expenses
   SET notes = 'settled at the table',
       updated_by = '22222222-2222-2222-2222-222222222222'
 WHERE id = 'E-HIST';

SELECT test.assert(
  (SELECT actor_id FROM record_edits
    WHERE record_id = 'E-HIST' ORDER BY id DESC LIMIT 1)
    = '11111111-1111-1111-1111-111111111111',
  'the actor is auth.uid(), NOT the client-writable updated_by column',
  (SELECT actor_id::text FROM record_edits WHERE record_id = 'E-HIST' ORDER BY id DESC LIMIT 1));

SELECT test.assert(
  (SELECT changed -> 'notes' ->> 'new' FROM record_edits
    WHERE record_id = 'E-HIST' ORDER BY id DESC LIMIT 1) = 'settled at the table'
  AND (SELECT changed -> 'notes' -> 'old' FROM record_edits
        WHERE record_id = 'E-HIST' ORDER BY id DESC LIMIT 1) = 'null'::jsonb,
  'a note set from empty records {old: null, new: "…"}');

-- Mirror-only no-op: the offline mirror re-pushing an identical row.
CREATE TEMP TABLE _eh_before AS
  SELECT count(*) AS n FROM record_edits WHERE record_id = 'E-HIST';
UPDATE group_expenses SET notes = notes WHERE id = 'E-HIST';
SELECT test.assert(
  (SELECT count(*) FROM record_edits WHERE record_id = 'E-HIST')
    = (SELECT n FROM _eh_before),
  'an UPDATE that changes no tracked column writes NO history row');

-- A real money move. The version guard demands version + 1 for a core edit,
-- so this is also proof the audit trigger composes with it rather than
-- fighting it.
UPDATE group_expenses
   SET amount = 45.00,
       splits = jsonb_build_array(
         jsonb_build_object('memberId', 'M-A', 'amount', 22.50),
         jsonb_build_object('memberId', (SELECT v FROM test.fixture WHERE k = 'M-B'),
                            'amount', 22.50)),
       version = version + 1
 WHERE id = 'E-HIST';

SELECT test.assert(
  (SELECT changed -> 'amount' ->> 'old' = '60.00'
      AND changed -> 'amount' ->> 'new' = '45.00'
      AND action = 'update'
     FROM record_edits WHERE record_id = 'E-HIST' ORDER BY id DESC LIMIT 1),
  'an amount edit records {old: 60.00, new: 45.00}',
  (SELECT changed::text FROM record_edits WHERE record_id = 'E-HIST' ORDER BY id DESC LIMIT 1));

-- Participants. B is dropped from the split; the row must carry both sides so
-- the client can render "… removed Bilal from the split".
UPDATE group_expenses
   SET splits = jsonb_build_array(jsonb_build_object('memberId', 'M-A', 'amount', 45.00)),
       version = version + 1
 WHERE id = 'E-HIST';

-- MATERIALIZED, deliberately: without it Postgres projects the target list
-- BELOW the LIMIT, so jsonb_array_length() would also run against the insert
-- row (whose splits."old" is JSON null) and error instead of asserting.
WITH latest AS MATERIALIZED (
  SELECT changed -> 'splits' AS sp FROM record_edits
   WHERE record_id = 'E-HIST' ORDER BY id DESC LIMIT 1
)
SELECT test.assert(
  (SELECT jsonb_array_length(sp -> 'old') = 2
      AND jsonb_array_length(sp -> 'new') = 1 FROM latest),
  'dropping a participant records the whole before/after split set',
  (SELECT sp::text FROM latest));

-- …and the stored splits are the normalized {memberId, amount} projection,
-- so no unexpected key a future client adds can ride along into a shared row.
WITH arrays AS MATERIALIZED (
  SELECT changed -> 'splits' -> 'old' AS arr FROM record_edits
   WHERE record_id = 'E-HIST'
     AND jsonb_typeof(changed -> 'splits' -> 'old') = 'array'
)
SELECT test.assert(
  (SELECT bool_and((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e.value) AS k)
                     = ARRAY['amount', 'memberId'])
     FROM arrays a, LATERAL jsonb_array_elements(a.arr) AS e(value)),
  'stored splits are normalized to {memberId, amount} only');

-- Soft delete is its own action, not an update.
UPDATE group_expenses SET deleted_at = now(), deleted_by = auth.uid()
 WHERE id = 'E-HIST';

SELECT test.assert(
  (SELECT action = 'soft_delete'
      AND changed -> 'amount' ->> 'old' = '45.00'
      AND changed -> 'amount' -> 'new' = 'null'::jsonb
     FROM record_edits WHERE record_id = 'E-HIST' ORDER BY id DESC LIMIT 1),
  'a deleted_at transition records action=soft_delete carrying the amount that stopped counting',
  (SELECT action || ' ' || changed::text FROM record_edits
    WHERE record_id = 'E-HIST' ORDER BY id DESC LIMIT 1));

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — a history row is never more visible than the row it describes.
-- ═══════════════════════════════════════════════════════════════════════════

-- B is a connected member of G1 and did not write any of the above.
SELECT test.as_user('22222222-2222-2222-2222-222222222222');
SELECT test.assert(
  (SELECT count(*) FROM record_edits WHERE record_id = 'E-HIST') >= 4,
  'a connected member reads the whole history of a group expense they did not author',
  'rows visible to B: ' || (SELECT count(*) FROM record_edits WHERE record_id = 'E-HIST'));

-- C left G1 in 00-fixtures. is_group_member() is connected-only.
SELECT test.as_user('33333333-3333-3333-3333-333333333333');
SELECT test.assert(
  (SELECT count(*) FROM record_edits WHERE record_id = 'E-HIST') = 0,
  'an EX-member of the group sees none of it');

-- D was never in G1 at all.
SELECT test.as_user('44444444-4444-4444-4444-444444444444');
SELECT test.assert(
  (SELECT count(*) FROM record_edits WHERE group_id = 'G1') = 0,
  'a stranger sees no group history');

-- ═══════════════════════════════════════════════════════════════════════════
-- Personal records: owner-only, and identical in both app modes.
-- ═══════════════════════════════════════════════════════════════════════════

SELECT test.as_user('11111111-1111-1111-1111-111111111111');

-- A ledger-mode (splits_only) loan: no account leg exists anywhere in this
-- table, so this is the same row shape both modes produce.
INSERT INTO loans (id, user_id, person_name, type, total_amount, remaining_amount,
                   currency, status, notes)
VALUES ('L-HIST', auth.uid(), 'Bilal', 'given', 500.00, 500.00, 'AED', 'active', '');

UPDATE loans SET remaining_amount = 450.00 WHERE id = 'L-HIST';

SELECT test.assert(
  (SELECT changed -> 'remaining_amount' ->> 'old' = '500.00'
      AND changed -> 'remaining_amount' ->> 'new' = '450.00'
     FROM record_edits WHERE record_id = 'L-HIST' ORDER BY id DESC LIMIT 1),
  'a repayment against a loan records remaining 500.00 → 450.00 (the "Ali changed amount 500 → 450" row)',
  (SELECT changed::text FROM record_edits WHERE record_id = 'L-HIST' ORDER BY id DESC LIMIT 1));

-- THE updated_at RULE. trg_loans_touch (incremental-sync-core) bumps
-- updated_at on every UPDATE; a write that moves nothing else must still
-- record nothing.
CREATE TEMP TABLE _lh_before AS
  SELECT count(*) AS n, (SELECT updated_at FROM loans WHERE id = 'L-HIST') AS ts
    FROM record_edits WHERE record_id = 'L-HIST';
UPDATE loans SET status = status WHERE id = 'L-HIST';
SELECT test.assert(
  (SELECT updated_at FROM loans WHERE id = 'L-HIST') > (SELECT ts FROM _lh_before)
  AND (SELECT count(*) FROM record_edits WHERE record_id = 'L-HIST') = (SELECT n FROM _lh_before),
  'a pure updated_at bump writes NO history row (updated_at moved, history did not)');

-- Owner-only: B is A's counterparty on this loan and still sees nothing.
SELECT test.as_user('22222222-2222-2222-2222-222222222222');
SELECT test.assert(
  (SELECT count(*) FROM record_edits WHERE record_id = 'L-HIST') = 0,
  'a personal loan''s history is owner-only — group membership grants nothing here');

-- Both app modes, at the row level. Two transactions by the same user: one
-- full_tracker (real account leg) and one splits_only (BOTH account ids
-- NULL). Their history rows must be indistinguishable.
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
INSERT INTO accounts (id, user_id, name, type, currency, balance)
VALUES ('ACC-HIST', auth.uid(), 'Wallet', 'cash', 'AED', 1000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO transactions (id, user_id, type, amount, currency, source_account_id, notes)
VALUES ('T-FULL', auth.uid(), 'expense', 100.00, 'AED', 'ACC-HIST', 'tracker mode');
INSERT INTO transactions (id, user_id, type, amount, currency,
                          source_account_id, destination_account_id, notes)
VALUES ('T-LEDGER', auth.uid(), 'expense', 100.00, 'AED', NULL, NULL, 'ledger mode');

SELECT test.assert(
  (SELECT (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(changed) AS k)
     FROM record_edits WHERE record_id = 'T-FULL' ORDER BY id DESC LIMIT 1)
  = (SELECT (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(changed) AS k)
       FROM record_edits WHERE record_id = 'T-LEDGER' ORDER BY id DESC LIMIT 1),
  'a splits_only transaction (both account ids NULL) records exactly the same fields as a full_tracker one',
  (SELECT changed::text FROM record_edits WHERE record_id = 'T-LEDGER' ORDER BY id DESC LIMIT 1));

SELECT test.assert(
  (SELECT count(*) FROM record_edits
    WHERE changed::text ILIKE '%account_id%'
       OR changed ?| ARRAY['source_account_id', 'destination_account_id']) = 0,
  'NO history row anywhere carries an account id');

-- ═══════════════════════════════════════════════════════════════════════════
-- The table is append-only from every client door.
-- ═══════════════════════════════════════════════════════════════════════════

SELECT test.assert_raises($$
  INSERT INTO record_edits (table_name, record_id, action, changed)
  VALUES ('loans', 'L-HIST', 'update', '{"amount":{"old":1,"new":2}}'::jsonb)
$$, 'permission denied',
  'a client cannot forge a history row');

SELECT test.assert_raises(
  $$ UPDATE record_edits SET changed = '{}'::jsonb WHERE record_id = 'L-HIST' $$,
  'permission denied',
  'a client cannot rewrite a history row');

SELECT test.assert_raises(
  $$ DELETE FROM record_edits WHERE record_id = 'L-HIST' $$,
  'permission denied',
  'a client cannot erase its own trail');
