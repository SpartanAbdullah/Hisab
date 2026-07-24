-- Contacts: merge a LOCAL duplicate into another contact + unarchive.
-- Prerequisites (must already be applied):
--   supabase-migration-phase1-persons.sql        (persons + FKs)
--   supabase-migration-phase2a-linked-profile.sql (linked_profile_id)
--   supabase-migration-safe-contact-archive.sql  (archived_at + protect triggers)
-- Idempotent: CREATE OR REPLACE throughout; safe to re-run.
--
-- Design notes:
--  * merge_person reassigns every person reference atomically server-side:
--    loans.person_id/person_name, transactions.person_id/related_person
--    (including the NAME-FALLBACK rows with person_id IS NULL — the UI
--    attributes those by name, so they must follow the merge), plus
--    linked_transaction_requests.person_id and committee_members.person_id
--    defensively. Denormalized names are rewritten to the target's name or
--    name-fallback surfaces would resurrect the old identity.
--  * The SOURCE must be a local (unlinked), un-archived contact. The TARGET
--    may be linked — folding "Mamu Mubashir" into linked "Mubashir Ali" is
--    the headline use case. Two linked contacts can never merge (the source
--    rule blocks it; the partial unique index makes it structurally moot).
--  * The source is ARCHIVED, not deleted — history stays recoverable and
--    FKs can never orphan. SECURITY DEFINER passes tg_persons_protect_archive
--    (current_user is the function owner inside DEFINER functions).
--  * The tg_block_archived_person_reference trigger on loans/transactions
--    fires on person_id updates: the target must be un-archived, which the
--    guards below ensure before any reassignment runs.

BEGIN;

CREATE OR REPLACE FUNCTION public.merge_person(p_source_id TEXT, p_target_id TEXT)
RETURNS TABLE (
  success BOOLEAN,
  reason_code TEXT,
  user_message TEXT,
  moved_loans INTEGER,
  moved_transactions INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_source public.persons%ROWTYPE;
  v_target public.persons%ROWTYPE;
  v_loans INTEGER := 0;
  v_txns INTEGER := 0;
  v_tmp INTEGER := 0;
  v_sweep_names BOOLEAN := false;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_source_id = p_target_id THEN
    RETURN QUERY SELECT false, 'SAME_CONTACT',
      'Pick two different contacts to merge.', 0, 0;
    RETURN;
  END IF;

  -- Deterministic lock order (by id) so two concurrent merges can't deadlock.
  PERFORM 1
    FROM public.persons
   WHERE id IN (p_source_id, p_target_id)
     AND user_id = v_uid
   ORDER BY id
     FOR UPDATE;

  SELECT p.* INTO v_source
    FROM public.persons AS p
   WHERE p.id = p_source_id AND p.user_id = v_uid AND p.archived_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'CONTACT_NOT_FOUND',
      'That contact is not available to merge.', 0, 0;
    RETURN;
  END IF;

  SELECT p.* INTO v_target
    FROM public.persons AS p
   WHERE p.id = p_target_id AND p.user_id = v_uid AND p.archived_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'CONTACT_NOT_FOUND',
      'The contact to merge into is not available.', 0, 0;
    RETURN;
  END IF;

  IF v_source.linked_profile_id IS NOT NULL THEN
    RETURN QUERY SELECT false, 'LINKED_CONTACT',
      'Linked contacts can''t be merged away. Merge local duplicates INTO them instead.', 0, 0;
    RETURN;
  END IF;

  -- Name-fallback rows (person_id IS NULL, attributed by name in the UI)
  -- follow the merge ONLY when the source's name is unambiguous: if a THIRD
  -- active contact shares the name, those legacy rows may belong to them —
  -- sweeping them would silently reassign a stranger's history. (The target
  -- itself sharing the name is fine: rows then follow the merge intent.)
  SELECT NOT EXISTS (
    SELECT 1 FROM public.persons AS p2
     WHERE p2.user_id = v_uid
       AND p2.id NOT IN (v_source.id, v_target.id)
       AND p2.archived_at IS NULL
       AND lower(btrim(p2.name)) = lower(btrim(v_source.name))
  ) INTO v_sweep_names;

  -- Loans: id-keyed rows always move; deleted rows follow too (integrity)
  -- but only LIVE rows are counted for the user-facing toast.
  WITH moved AS (
    UPDATE public.loans
       SET person_id = v_target.id, person_name = v_target.name
     WHERE user_id = v_uid AND person_id = v_source.id
     RETURNING deleted_at
  )
  SELECT count(*) FILTER (WHERE deleted_at IS NULL)::INTEGER INTO v_loans FROM moved;

  IF v_sweep_names THEN
    WITH moved AS (
      UPDATE public.loans
         SET person_id = v_target.id, person_name = v_target.name
       WHERE user_id = v_uid
         AND person_id IS NULL
         AND lower(btrim(person_name)) = lower(btrim(v_source.name))
       RETURNING deleted_at
    )
    SELECT count(*) FILTER (WHERE deleted_at IS NULL)::INTEGER INTO v_tmp FROM moved;
    v_loans := v_loans + v_tmp;
  END IF;

  -- Transactions: same two passes.
  WITH moved AS (
    UPDATE public.transactions
       SET person_id = v_target.id, related_person = v_target.name
     WHERE user_id = v_uid AND person_id = v_source.id
     RETURNING deleted_at
  )
  SELECT count(*) FILTER (WHERE deleted_at IS NULL)::INTEGER INTO v_txns FROM moved;

  IF v_sweep_names THEN
    WITH moved AS (
      UPDATE public.transactions
         SET person_id = v_target.id, related_person = v_target.name
       WHERE user_id = v_uid
         AND person_id IS NULL
         AND related_person IS NOT NULL
         AND lower(btrim(related_person)) = lower(btrim(v_source.name))
       RETURNING deleted_at
    )
    SELECT count(*) FILTER (WHERE deleted_at IS NULL)::INTEGER INTO v_tmp FROM moved;
    v_txns := v_txns + v_tmp;
  END IF;

  -- Defensive sweeps: local contacts normally have neither, but a merge must
  -- never leave a dangling reference behind.
  UPDATE public.linked_transaction_requests
     SET person_id = v_target.id
   WHERE person_id = v_source.id
     AND from_user_id = v_uid;

  UPDATE public.committee_members AS cm
     SET person_id = v_target.id
   WHERE cm.person_id = v_source.id
     AND EXISTS (
       SELECT 1 FROM public.committees AS c
        WHERE c.id = cm.committee_id AND c.user_id = v_uid
     );

  -- Keep the best contact details: a phone number on the duplicate fills a
  -- gap on the target, never overwrites.
  IF v_target.phone IS NULL AND v_source.phone IS NOT NULL THEN
    UPDATE public.persons SET phone = v_source.phone WHERE id = v_target.id;
  END IF;

  -- Retire the source: archived, not deleted — recoverable, un-orphanable.
  UPDATE public.persons SET archived_at = now() WHERE id = v_source.id;

  RETURN QUERY SELECT true, 'MERGED',
    'Merged into ' || v_target.name || '.', v_loans, v_txns;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_person(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_person(TEXT, TEXT) TO authenticated;

-- Unarchive: the protect trigger blocks direct client writes to archived_at,
-- so restoring goes through the same SECURITY DEFINER door as archiving.
-- Linked contacts can never BE archived, so no linked guard is needed here.
CREATE OR REPLACE FUNCTION public.unarchive_contact(p_contact_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE public.persons
     SET archived_at = NULL
   WHERE id = p_contact_id
     AND user_id = v_uid
     AND archived_at IS NOT NULL;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.unarchive_contact(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unarchive_contact(TEXT) TO authenticated;

-- Harden the archived-reference guard against the check-then-act race: the
-- original trigger's plain EXISTS reads a READ COMMITTED snapshot, so an
-- insert racing a merge could slip a row onto a person being archived.
-- FOR KEY SHARE makes the check lock-coupled (it conflicts with the merge's
-- FOR UPDATE), exactly like real FK RI checks — a racing insert now blocks
-- until the merge commits, re-reads, sees archived_at, and is rejected.
CREATE OR REPLACE FUNCTION public.tg_block_archived_person_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_archived_at TIMESTAMPTZ;
BEGIN
  IF NEW.person_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.person_id IS DISTINCT FROM OLD.person_id) THEN
    SELECT p.archived_at INTO v_archived_at
      FROM public.persons AS p
     WHERE p.id = NEW.person_id
       FOR KEY SHARE;
    IF v_archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Archived contacts cannot be used for new financial records'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
