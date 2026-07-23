-- ═══════════════════════════════════════════════════════════════════════════
-- Onboarding intent — one column on profiles
-- ═══════════════════════════════════════════════════════════════════════════
-- The intent-first onboarding question ("What brings you to Hisaab?") stores
-- its answer locally for instant routing AND here for durability across
-- devices. Values: spending | loans | kameti | splits | budgets.
-- The client writes it best-effort (a missing column is silently tolerated),
-- so this migration can be applied any time.
--
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists onboarding_intent text default null;
