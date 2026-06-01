-- Safe contact removal: archive settled local contacts without destroying history.
-- Apply after:
--   supabase-migration-phase1-persons.sql
--   supabase-migration-phase2a-linked-profile.sql
--   supabase-migration-incremental-sync-tombstones.sql
--   supabase-migration-p0-launch-blockers.sql

BEGIN;

ALTER TABLE public.persons
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS persons_active_user_name_idx
  ON public.persons(user_id, lower(name))
  WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.archive_contact_if_settled(p_contact_id TEXT)
RETURNS TABLE (
  success BOOLEAN,
  reason_code TEXT,
  user_message TEXT,
  payable_amount JSONB,
  receivable_amount JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_contact public.persons%ROWTYPE;
  v_payable JSONB := '{}'::JSONB;
  v_receivable JSONB := '{}'::JSONB;
  v_payable_text TEXT;
  v_receivable_text TEXT;
  v_message TEXT;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.* INTO v_contact
    FROM public.persons AS p
   WHERE p.id = p_contact_id
     AND p.user_id = v_uid
     AND p.archived_at IS NULL
   FOR UPDATE;

  -- Unknown ids and another user's ids intentionally return the same result.
  IF v_contact.id IS NULL THEN
    RETURN QUERY SELECT false, 'CONTACT_NOT_FOUND',
      'This contact could not be removed.', '{}'::JSONB, '{}'::JSONB;
    RETURN;
  END IF;

  IF v_contact.linked_profile_id IS NOT NULL THEN
    RETURN QUERY SELECT false, 'LINKED_CONTACT',
      'Linked contacts can''t be deleted. You can hide or remove the relationship only after everything is settled.',
      '{}'::JSONB, '{}'::JSONB;
    RETURN;
  END IF;

  WITH balances AS (
    SELECT l.currency, l.type, sum(l.remaining_amount) AS amount
      FROM public.loans AS l
     WHERE l.user_id = v_uid
       AND l.person_id = v_contact.id
       AND l.status = 'active'
       AND l.deleted_at IS NULL
     GROUP BY l.currency, l.type
  )
  SELECT
    COALESCE(jsonb_object_agg(currency, amount) FILTER (WHERE type = 'taken' AND amount <> 0), '{}'::JSONB),
    COALESCE(jsonb_object_agg(currency, amount) FILTER (WHERE type = 'given' AND amount <> 0), '{}'::JSONB),
    string_agg(currency || ' ' || trim(to_char(amount, 'FM999999999999990.00')), ', ' ORDER BY currency)
      FILTER (WHERE type = 'taken' AND amount <> 0),
    string_agg(currency || ' ' || trim(to_char(amount, 'FM999999999999990.00')), ', ' ORDER BY currency)
      FILTER (WHERE type = 'given' AND amount <> 0)
    INTO v_payable, v_receivable, v_payable_text, v_receivable_text
    FROM balances;

  IF v_payable <> '{}'::JSONB OR v_receivable <> '{}'::JSONB THEN
    v_message := 'You can''t delete this contact yet because your balance is not settled.';
    IF v_payable <> '{}'::JSONB THEN
      v_message := v_message || ' You owe ' || v_payable_text || '.';
    END IF;
    IF v_receivable <> '{}'::JSONB THEN
      v_message := v_message || ' You are owed ' || v_receivable_text || '.';
    END IF;
    RETURN QUERY SELECT false, 'BALANCE_NOT_SETTLED', v_message, v_payable, v_receivable;
    RETURN;
  END IF;

  UPDATE public.persons AS p
     SET archived_at = now()
   WHERE p.id = v_contact.id
     AND p.user_id = v_uid;

  RETURN QUERY SELECT true, 'ARCHIVED',
    'Contact removed. Past settled records still keep the contact name.',
    '{}'::JSONB, '{}'::JSONB;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_contact_if_settled(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_contact_if_settled(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.tg_persons_protect_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION 'Contact archive state can only be changed through archive_contact_if_settled'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS persons_protect_archive ON public.persons;
CREATE TRIGGER persons_protect_archive
  BEFORE UPDATE OF archived_at ON public.persons
  FOR EACH ROW EXECUTE FUNCTION public.tg_persons_protect_archive();

CREATE OR REPLACE FUNCTION public.tg_block_archived_person_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.person_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.person_id IS DISTINCT FROM OLD.person_id)
     AND EXISTS (
       SELECT 1
         FROM public.persons AS p
        WHERE p.id = NEW.person_id
          AND p.archived_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Archived contacts cannot be used for new financial records'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS loans_block_archived_person_reference ON public.loans;
CREATE TRIGGER loans_block_archived_person_reference
  BEFORE INSERT OR UPDATE OF person_id ON public.loans
  FOR EACH ROW EXECUTE FUNCTION public.tg_block_archived_person_reference();

DROP TRIGGER IF EXISTS transactions_block_archived_person_reference ON public.transactions;
CREATE TRIGGER transactions_block_archived_person_reference
  BEFORE INSERT OR UPDATE OF person_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.tg_block_archived_person_reference();

COMMIT;
