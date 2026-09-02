-- ═══════════════════════════════════════════════════════════════════════════
-- Audit 2026-09 · P0 item C9 — widen the cross-user currency CHECK constraints
--
-- Findings: docs/audit-2026-09/04-supabase.md  F-MIG2 (HIGH, CONFIRMED)
--           docs/audit-2026-09/03-performance.md H6  (HIGH, CONFIRMED)
--
-- PROBLEM
-- The two cross-user request tables hard-code `check (currency in ('AED','PKR'))`
-- while the client ships eight currencies (src/db/types.ts:1
-- SUPPORTED_CURRENCIES = AED, PKR, PHP, SAR, QAR, OMR, KWD, BHD). The primary
-- entry paths (full-tracker QuickEntry, AddLoanModal, SettleLinkedLoanModal)
-- do not gate on currency, so a Saudi / Qatari / Omani / Kuwaiti / Bahraini /
-- Filipino user recording a linked udhaar hits a raw Postgres 23514 check
-- violation and loses the entry. The flagship cross-user feature is dead for
-- 6 of 8 shipped currencies.
--
-- CONSTRAINTS WIDENED BY THIS MIGRATION (originals, file:line)
--   1. public.linked_transaction_requests.currency
--        supabase-migration-phase2b-linked-requests.sql:14
--          `currency text not null check (currency in ('AED','PKR')),`
--   2. public.linked_settlement_requests.currency
--        supabase-migration-phase2c-a-settlement-requests.sql:167
--          `currency text not null check (currency in ('AED','PKR')),`
--   3. public.linked_settlement_requests.currency  (same table, re-declared)
--        supabase-migration-fix-bidirectional-linked-settlements.sql:25
--          `currency text not null check (currency in ('AED','PKR')),`
--        Both files use `create table if not exists`, so whichever ran first
--        owns the live constraint; its auto-generated name is unknown from the
--        repo. This migration therefore DISCOVERS the constraint(s) by
--        definition rather than by name (see the DO block below).
--
-- A repo-wide grep (`grep -rni currency --include=*.sql .` filtered to
-- check/constraint lines) finds NO other currency CHECK constraints. Every
-- other currency guard in SQL is a runtime equality comparison inside an RPC
-- (e.g. cross-user-account-effects.sql:125, :219, :240, :464, :488, :508 —
-- "account currency mismatch" / "currency mismatch at accept"), which compares
-- a request's currency against a loan's or account's currency and is
-- value-list-agnostic. Those are correct and are NOT touched here.
--
-- SAFETY / IDEMPOTENCY
--   * Only widens the accepted set — no existing row can become invalid, so
--     no data migration or backfill is required and the ADD is validated
--     against existing rows harmlessly.
--   * Re-runnable: every drop is `if exists`, the discovery loop is a no-op
--     once the old constraints are gone, and the new named constraints are
--     dropped-then-added each run.
--   * Table guards: the whole block no-ops if a table doesn't exist yet.
--   * Nothing else about the tables (columns, RLS, RPCs, indexes) is changed.
--
-- APPLY: paste into Supabase Studio → SQL Editor and run (there is no
-- migration runner in this repo; see CLAUDE.md). PENDING until the user
-- confirms it has been applied to production.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ---------------------------------------------------------------------------
-- 1. Drop the legacy AED/PKR-only CHECKs by discovery.
--
--    The originals were declared inline and unnamed, so Postgres auto-named
--    them (conventionally `<table>_currency_check`, but that is not guaranteed
--    across the two competing `create table if not exists` definitions of
--    linked_settlement_requests). We match on the constraint DEFINITION —
--    any CHECK on these tables that (a) mentions the currency column, and
--    (b) does NOT already accept the full eight-currency list — and drop it.
--    Constraints unrelated to currency (ltr_different_parties,
--    lsr_different_parties, amount > 0, status/kind enums) never match.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select t.relname as tbl, c.conname as con
      from pg_constraint c
      join pg_class      t on t.oid = c.conrelid
      join pg_namespace  n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname in ('linked_transaction_requests', 'linked_settlement_requests')
       and c.contype  = 'c'
       and pg_get_constraintdef(c.oid) ilike '%currency%'
       -- Only the narrow ones: a definition that already lists BHD is this
       -- migration's own constraint (re-run) and is replaced below anyway.
       and pg_get_constraintdef(c.oid) not ilike '%BHD%'
  loop
    execute format('alter table public.%I drop constraint if exists %I', r.tbl, r.con);
    raise notice 'audit-p0-currencies: dropped % on public.%', r.con, r.tbl;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Re-add as explicitly NAMED constraints covering all eight shipped
--    currencies (src/db/types.ts:1 — SUPPORTED_CURRENCIES).
--    Explicit names mean the next widening can drop by name, not by discovery.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.linked_transaction_requests') is not null then
    alter table public.linked_transaction_requests
      drop constraint if exists ltr_currency_supported;
    alter table public.linked_transaction_requests
      add constraint ltr_currency_supported
      check (currency in ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD'));
    raise notice 'audit-p0-currencies: ltr_currency_supported installed';
  else
    raise notice 'audit-p0-currencies: linked_transaction_requests absent — skipped';
  end if;

  if to_regclass('public.linked_settlement_requests') is not null then
    alter table public.linked_settlement_requests
      drop constraint if exists lsr_currency_supported;
    alter table public.linked_settlement_requests
      add constraint lsr_currency_supported
      check (currency in ('AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD'));
    raise notice 'audit-p0-currencies: lsr_currency_supported installed';
  else
    raise notice 'audit-p0-currencies: linked_settlement_requests absent — skipped';
  end if;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (read-only — safe to re-run at any time)
-- ═══════════════════════════════════════════════════════════════════════════

-- V1. Every currency CHECK now on the two cross-user request tables.
--     EXPECT exactly two rows — ltr_currency_supported and
--     lsr_currency_supported — each listing all 8 currencies. Any row named
--     `*_currency_check` still listing only AED/PKR means step 1 missed it.
select t.relname                      as table_name,
       c.conname                      as constraint_name,
       pg_get_constraintdef(c.oid)    as definition,
       case
         when pg_get_constraintdef(c.oid) ilike '%BHD%' then 'OK — widened'
         else 'STILL NARROW'
       end                            as verdict
  from pg_constraint c
  join pg_class     t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'public'
   and t.relname in ('linked_transaction_requests', 'linked_settlement_requests')
   and c.contype = 'c'
   and pg_get_constraintdef(c.oid) ilike '%currency%'
 order by t.relname, c.conname;

-- V2. Single-line pass/fail summary.
--     EXPECT: narrow_currency_checks = 0 AND widened_currency_checks = 2.
select count(*) filter (where pg_get_constraintdef(c.oid) not ilike '%BHD%')
         as narrow_currency_checks,
       count(*) filter (where pg_get_constraintdef(c.oid) ilike '%BHD%')
         as widened_currency_checks
  from pg_constraint c
  join pg_class     t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'public'
   and t.relname in ('linked_transaction_requests', 'linked_settlement_requests')
   and c.contype = 'c'
   and pg_get_constraintdef(c.oid) ilike '%currency%';

-- V3. Currencies actually present in the two tables today (read-only).
--     Pre-migration this can only be AED/PKR; post-migration it should start
--     showing SAR/QAR/OMR/KWD/BHD/PHP as Gulf users record linked udhaar.
--     (Assumes both tables exist — skip this one if V1 returned no rows.)
select 'linked_transaction_requests' as table_name, currency, count(*) as row_count
  from public.linked_transaction_requests group by 2
union all
select 'linked_settlement_requests', currency, count(*)
  from public.linked_settlement_requests group by 2
 order by 1, 2;
