-- Run after supabase-migration-safe-contact-archive.sql.
-- Read-only catalog verification for the archive RPC and write guards.

DO $$
BEGIN
  IF to_regprocedure('public.archive_contact_if_settled(text)') IS NULL THEN
    RAISE EXCEPTION 'archive_contact_if_settled(text) is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'persons_protect_archive' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'persons archive-state guard is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'persons' AND column_name = 'archived_at'
  ) THEN
    RAISE EXCEPTION 'persons.archived_at is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'loans_block_archived_person_reference' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'loans archived-contact guard is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'transactions_block_archived_person_reference' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'transactions archived-contact guard is missing';
  END IF;
  RAISE NOTICE 'Safe contact archive catalog verification passed';
END;
$$;
