-- Hisaab — Group Codes + Profile Lookup
-- Run ONCE in the Supabase SQL Editor AFTER the RLS recursion fix migration.
--
-- This migration enables two user-facing features:
--   (1) A visible per-group join code (e.g. "GRP-A3B7CD") so someone can join
--       a group just by typing the code, without a shareable URL.
--   (2) Adding members to a group by their user public code (e.g. "HSB-XYZ123")
--       which resolves to a real Hisaab user and creates a connected member.
--
-- Both require lookups that RLS normally forbids (reading split_groups by
-- code, or reading another user's profile). Each is exposed through a
-- SECURITY DEFINER function that returns only the fields we actually need.

-- ── 1. Add join_code columns to split_groups ─────────────────────────────────
ALTER TABLE split_groups
  ADD COLUMN IF NOT EXISTS join_code TEXT,
  ADD COLUMN IF NOT EXISTS join_code_normalized TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_split_groups_join_code_normalized
  ON split_groups(join_code_normalized)
  WHERE join_code_normalized IS NOT NULL;

-- ── 2. Profile lookup by public_code ────────────────────────────────────────
-- Returns id + name + public_code of any profile matching the normalized
-- public code. Bypasses RLS via SECURITY DEFINER. Returns nothing if no match.
CREATE OR REPLACE FUNCTION public.lookup_profile_by_public_code(code_normalized TEXT)
RETURNS TABLE (id UUID, name TEXT, public_code TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT p.id, p.name, p.public_code
  FROM public.profiles p
  WHERE p.public_code_normalized = code_normalized
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_profile_by_public_code(TEXT) TO authenticated;

-- ── 3. Group lookup by join_code ────────────────────────────────────────────
-- Returns a minimal group record so a non-member can see what they're about
-- to join. Bypasses RLS via SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.lookup_group_by_join_code(code_normalized TEXT)
RETURNS TABLE (id TEXT, name TEXT, emoji TEXT, currency TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT g.id, g.name, g.emoji, g.currency
  FROM public.split_groups g
  WHERE g.join_code_normalized = code_normalized
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_group_by_join_code(TEXT) TO authenticated;

-- ── 3b. Backfill profiles.public_code_normalized ────────────────────────────
-- Existing rows were stored as "HSB-XYZ123" (preserving the prefix/hyphen).
-- The app now normalizes to just "XYZ123" so input like "xyz123", "HSB-xyz123",
-- or "@hsb-xyz123" all resolve to the same row. Rewrite any existing rows.
UPDATE profiles
SET public_code_normalized = UPPER(regexp_replace(
  public_code_normalized,
  '^@?HSB[-_ ]?|[-_ ]',
  '',
  'gi'
))
WHERE public_code_normalized IS NOT NULL;

-- ── 4. Self-join by group code ──────────────────────────────────────────────
-- A user joining by code needs to insert a group_members row referring to a
-- group they don't yet belong to. The existing INSERT policy already allows
-- `auth.uid() = profile_id`, so a user CAN insert their own membership row,
-- which is exactly what we need. No policy change required here.
--
-- However, reading the group_members row they just inserted relies on the
-- SELECT policy — already fixed in the previous migration to use
-- public.is_group_member().
