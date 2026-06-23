-- ═══════════════════════════════════════════════════════════
-- Savings goals: optional target date
-- Run ONCE in the Supabase SQL Editor.
--
-- Adds an optional deadline to goals so Hisaab can suggest a monthly
-- save amount ("save ~850/mo to reach 10,000 by Dec") and show an
-- on-track / behind signal. Nullable — existing open-ended goals keep
-- working unchanged. RLS is already "manage own goals" (FOR ALL).
-- Idempotent.
-- ═══════════════════════════════════════════════════════════

alter table public.goals
  add column if not exists target_date date;
