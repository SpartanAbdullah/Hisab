-- Hisaab: left group members remain historical-only.
-- Apply after supabase-migration-safe-leave-group.sql.
--
-- Existing rows are intentionally preserved. New expenses, participant-changing
-- expense edits, and new/participant-changing settlements must reference only
-- connected members from the same group.

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_group_expenses_require_connected_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.paid_by IS DISTINCT FROM OLD.paid_by
     OR NEW.splits IS DISTINCT FROM OLD.splits THEN
    IF (
      SELECT count(*)
        FROM public.group_members AS gm
       WHERE gm.group_id = NEW.group_id
         AND gm.status = 'connected'
    ) < 2 THEN
      RAISE EXCEPTION 'NOT_ENOUGH_ACTIVE_GROUP_MEMBERS: at least two connected members are required'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.group_members AS gm
       WHERE gm.id = NEW.paid_by
         AND gm.group_id = NEW.group_id
         AND gm.status = 'connected'
    ) THEN
      RAISE EXCEPTION 'INACTIVE_GROUP_MEMBER: paid_by must be an active connected member of this group'
        USING ERRCODE = '23514';
    END IF;

    IF jsonb_typeof(COALESCE(NEW.splits, '[]'::jsonb)) <> 'array' THEN
      RAISE EXCEPTION 'INVALID_GROUP_SPLITS: splits must be a JSON array'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(COALESCE(NEW.splits, '[]'::jsonb)) AS split(value)
       WHERE NOT EXISTS (
         SELECT 1
           FROM public.group_members AS gm
          WHERE gm.id = COALESCE(split.value->>'memberId', split.value->>'member_id')
            AND gm.group_id = NEW.group_id
            AND gm.status = 'connected'
       )
    ) THEN
      RAISE EXCEPTION 'INACTIVE_GROUP_MEMBER: every split participant must be an active connected member of this group'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_expenses_require_connected_members ON public.group_expenses;
CREATE TRIGGER group_expenses_require_connected_members
  BEFORE INSERT OR UPDATE ON public.group_expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_expenses_require_connected_members();

COMMENT ON FUNCTION public.tg_group_expenses_require_connected_members() IS
  'Preserves historical expenses while rejecting new or participant-changing expenses unless paid_by and every split participant are connected members of the same group.';

CREATE OR REPLACE FUNCTION public.tg_group_settlements_require_connected_members()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.from_member IS DISTINCT FROM OLD.from_member
     OR NEW.to_member IS DISTINCT FROM OLD.to_member THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.group_members AS gm
       WHERE gm.id = NEW.from_member
         AND gm.group_id = NEW.group_id
         AND gm.status = 'connected'
    ) OR NOT EXISTS (
      SELECT 1
        FROM public.group_members AS gm
       WHERE gm.id = NEW.to_member
         AND gm.group_id = NEW.group_id
         AND gm.status = 'connected'
    ) THEN
      RAISE EXCEPTION 'INACTIVE_GROUP_MEMBER: settlements require active connected group members'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_settlements_require_connected_members ON public.group_settlements;
CREATE TRIGGER group_settlements_require_connected_members
  BEFORE INSERT OR UPDATE ON public.group_settlements
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_settlements_require_connected_members();

COMMENT ON FUNCTION public.tg_group_settlements_require_connected_members() IS
  'Preserves settlement history while rejecting new or participant-changing settlements unless both members are connected members of the same group.';

COMMIT;
