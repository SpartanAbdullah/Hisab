-- ════════════════════════════════════════════════════════════════════════════
-- 8v · Khata-link notes gate — khata_links.show_notes
--      (supabase-migration-p3-khata-link.sql, L2 privacy follow-up)
--
-- get_khata_view is a PUBLIC, anon-callable, capability-URL projection. It
-- used to return a loan/transaction's `notes` verbatim to whoever held the
-- link — free text the owner wrote for themselves, unbounded. show_notes
-- closes that: default false hides every note, an explicit opt-in shows them
-- (still capped at 140 chars server-side either way), the column is
-- owner-writable only (same treatment as initials_only), and rotating a link
-- carries the previous choice forward unless the caller overrides it.
--
-- Runs after 00-fixtures (reuses owner A) and is otherwise self-contained —
-- its own person/loan/transaction ids — so it cannot collide with any other
-- file and does not depend on file order.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
SELECT test.suite('8v-khata-notes');

-- ── Catalog shape. Reads pg_* / information_schema, so RESET ROLE deliberately.
RESET ROLE;

-- Assertion: COLUMN NOT WRITABLE BY ANON. Same column-grant shape as
-- initials_only — authenticated may UPDATE it (owner-only, RLS narrows the
-- row further), anon has no grant on it at all.
SELECT test.assert(
  has_column_privilege('authenticated', 'public.khata_links', 'show_notes', 'UPDATE')
  AND NOT has_column_privilege('anon', 'public.khata_links', 'show_notes', 'UPDATE'),
  'show_notes is owner-writable (authenticated) but NOT anon-writable',
  'authenticated=' || has_column_privilege('authenticated', 'public.khata_links', 'show_notes', 'UPDATE')::text
    || ' anon=' || has_column_privilege('anon', 'public.khata_links', 'show_notes', 'UPDATE')::text);

-- ── Setup: A's contact, a loan and a repayment, both carrying notes. ────────
SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

INSERT INTO persons (id, user_id, name)
VALUES ('P-KN', auth.uid(), 'Notes Contact');

-- 150 'x's: well over the 140-char cap, so the cap assertion below is real.
INSERT INTO loans (id, user_id, person_id, person_name, type, total_amount,
                   remaining_amount, currency, status, notes)
VALUES ('L-KN1', auth.uid(), 'P-KN', 'Notes Contact', 'given', 10000, 10000,
        'PKR', 'active', repeat('x', 150));

INSERT INTO transactions (id, user_id, type, amount, currency, related_loan_id,
                          related_person, notes)
VALUES ('T-KN1', auth.uid(), 'loan_given', 10000, 'PKR', 'L-KN1', 'Notes Contact',
        'a short private note');

-- ═══════════════════════════════════════════════════════════════════════════
-- DEFAULT HIDES NOTES.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _mint1 AS SELECT create_khata_link('P-KN') AS r;
-- Temp tables are owner-private by default; the anon reads below need it too.
GRANT SELECT ON _mint1 TO PUBLIC;
SELECT test.assert(
  (SELECT r ->> 'status' FROM _mint1) = 'ok'
  AND (SELECT (r ->> 'show_notes')::boolean FROM _mint1) = false,
  'create_khata_link defaults show_notes to false',
  (SELECT r::text FROM _mint1));

SET ROLE anon;
CREATE TEMP TABLE _view1 AS
  SELECT get_khata_view((SELECT r ->> 'token' FROM _mint1)) AS v;

SELECT test.assert(
  (SELECT v ->> 'showNotes' FROM _view1) = 'false'
  AND (SELECT (v -> 'loans') -> 0 ->> 'notes' FROM _view1) IS NULL
  AND (SELECT (v -> 'transactions') -> 0 ->> 'notes' FROM _view1) IS NULL,
  'DEFAULT: the public view hides both the loan note and the transaction note',
  (SELECT v::text FROM _view1));

-- ═══════════════════════════════════════════════════════════════════════════
-- OPT-IN SHOWS NOTES, AND THE CAP IS APPLIED.
-- ═══════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');
CREATE TEMP TABLE _mint2 AS SELECT create_khata_link('P-KN', NULL, true) AS r;
GRANT SELECT ON _mint2 TO PUBLIC;
SELECT test.assert(
  (SELECT r ->> 'status' FROM _mint2) = 'ok'
  AND (SELECT (r ->> 'show_notes')::boolean FROM _mint2) = true
  AND (SELECT (r ->> 'replaced_previous')::boolean FROM _mint2) = true,
  'opting in (p_show_notes=true) sets show_notes and rotates the previous link',
  (SELECT r::text FROM _mint2));

SET ROLE anon;
CREATE TEMP TABLE _view2 AS
  SELECT get_khata_view((SELECT r ->> 'token' FROM _mint2)) AS v;

SELECT test.assert(
  (SELECT v ->> 'showNotes' FROM _view2) = 'true'
  AND (SELECT (v -> 'transactions') -> 0 ->> 'notes' FROM _view2) = 'a short private note',
  'OPT-IN: a note within the cap is shown verbatim once show_notes is true',
  (SELECT v::text FROM _view2));

SELECT test.assert(
  (SELECT length((v -> 'loans') -> 0 ->> 'notes') FROM _view2) = 141
  AND (SELECT right((v -> 'loans') -> 0 ->> 'notes', 1) FROM _view2) = '…'
  AND (SELECT (v -> 'loans') -> 0 ->> 'notes' FROM _view2) <> repeat('x', 150),
  'CAP: a 150-char note is truncated to 140 chars plus a trailing ellipsis, even opted in',
  (SELECT (v -> 'loans') -> 0 ->> 'notes' FROM _view2));

-- ═══════════════════════════════════════════════════════════════════════════
-- ROTATION PRESERVES THE OWNER'S CHOICE UNLESS OVERRIDDEN.
-- ═══════════════════════════════════════════════════════════════════════════
SET ROLE authenticated;
SELECT test.as_user('11111111-1111-1111-1111-111111111111');

-- Rotate with p_show_notes NULL: must carry the `true` from _mint2 forward.
CREATE TEMP TABLE _mint3 AS SELECT create_khata_link('P-KN') AS r;
GRANT SELECT ON _mint3 TO PUBLIC;
SELECT test.assert(
  (SELECT (r ->> 'show_notes')::boolean FROM _mint3) = true,
  'a rotate with p_show_notes NULL carries the previous show_notes forward',
  (SELECT r::text FROM _mint3));

-- Rotate again, this time explicitly overriding it off.
CREATE TEMP TABLE _mint4 AS SELECT create_khata_link('P-KN', NULL, false) AS r;
GRANT SELECT ON _mint4 TO PUBLIC;
SELECT test.assert(
  (SELECT (r ->> 'show_notes')::boolean FROM _mint4) = false,
  'a rotate with p_show_notes=false overrides the previous true',
  (SELECT r::text FROM _mint4));

SET ROLE anon;
SELECT test.assert(
  (get_khata_view((SELECT r ->> 'token' FROM _mint4)) ->> 'showNotes') = 'false',
  'the public view reflects the overridden (false) choice, not the carried-forward one');

-- Belt-and-braces on the column-grant assertion above: a live write attempt
-- from anon is refused, not merely ungranted in the catalog.
SELECT test.assert_raises(
  $$ UPDATE khata_links SET show_notes = true WHERE person_id = 'P-KN' $$,
  'permission denied',
  'anon cannot UPDATE khata_links.show_notes directly');

RESET ROLE;
