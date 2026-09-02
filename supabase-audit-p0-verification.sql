-- ═══════════════════════════════════════════════════════════════════════════
-- Hisaab — P0 / C1 PRODUCTION SCHEMA VERIFICATION
-- ---------------------------------------------------------------------------
-- Audit item C1 (docs/audit-2026-09/00-executive-summary.md §6.1, §7.A.1):
-- "the production schema state is unprovable". This script proves it.
--
-- WHAT IT IS:  ONE strictly READ-ONLY query over the Postgres catalogs.
--              No DDL, no DML, no temp tables, no function calls that write.
--              Safe to run on production at any time, by anyone.
--
-- HOW TO RUN:  Supabase Studio → SQL Editor → New query → paste ALL of this →
--              Run → export/copy the FULL result grid.
--              See docs/audit-2026-09/P0-C1-runbook.md for the exact steps.
--
-- WHY ONE QUERY: the Supabase SQL Editor renders only the LAST statement's
--              result set. Everything below is therefore a single SELECT built
--              from UNION ALL blocks, so one run = one exportable table.
--
-- OUTPUT SHAPE: sort_key | section | check_name | result | detail
--              `result` is the verdict-bearing column. Read it first.
--              Rows whose result starts with "!!" need founder attention.
--
-- SUPERSEDES (do not run these individually any more — all their assertions
-- are folded in here, and unlike them this script REPORTS instead of aborting
-- on the first failure):
--   supabase-p0-security-verification.sql
--   supabase-group-invite-join-verification.sql
--   supabase-active-group-transaction-members-verification.sql
--   supabase-safe-leave-group-verification.sql
--   supabase-safe-contact-archive-verification.sql
--
-- Every check below cites the repo file + line that creates (or drops) the
-- artifact it looks for.
--
-- VALIDATED: parses and executes on PostgreSQL 15 (both the "artifact absent"
-- and "artifact present" branches of every verdict were exercised against a
-- throwaway database before this file was committed).
-- ═══════════════════════════════════════════════════════════════════════════

SELECT * FROM (

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 00 — RUN STAMP
-- Identifies which database/instance produced this output. Paste this row
-- back with the rest so the evidence is attributable.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    0                                        AS sort_key,
    '=== SECTION 00: RUN STAMP ==='          AS section,
    'database / server / time'               AS check_name,
    current_database()
      || ' @ ' || COALESCE(inet_server_addr()::text, 'local')
      || ' | ' || now()::text                AS result,
    version()                                AS detail

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 01 — RLS ENABLED / FORCED FLAGS FOR EVERY APP TABLE
-- Source: supabase-schema.sql (ALTER TABLE ... ENABLE ROW LEVEL SECURITY on
--         every table), plus every later migration that creates a table
--         (e.g. supabase-migration-p0-launch-blockers.sql:209 join_code_attempts,
--         supabase-migration-connections-push-discovery.sql:35/314/376/442,
--         supabase-migration-investments.sql:24/38/65,
--         supabase-migration-committees.sql:11/29/44).
-- A table listed here with 'RLS DISABLED' is world-readable to any
-- authenticated user via PostgREST. There should be NONE.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    100,
    '=== SECTION 01: RLS FLAGS (all public tables) ===',
    c.relname::text,
    CASE
      WHEN NOT c.relrowsecurity THEN '!! RLS DISABLED'
      WHEN (SELECT count(*) FROM pg_policy pol WHERE pol.polrelid = c.oid) = 0
        THEN '!! RLS ENABLED but ZERO POLICIES (table is fully locked out)'
      ELSE 'RLS enabled'
    END,
    'forced=' || c.relforcerowsecurity::text
      || ' | policies=' || (SELECT count(*) FROM pg_policy pol WHERE pol.polrelid = c.oid)::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 02 — FULL POLICY DUMP FOR THE TRUST-BOUNDARY TABLES
-- These are the ten tables whose policies decide multi-tenant isolation.
-- Compare against:
--   BASELINE  supabase-schema.sql:19-21 (profiles), :205 (split_groups),
--             :230 (group_expenses FOR ALL), :249 (group_settlements FOR ALL),
--             :352-384 (group_members SELECT/INSERT/UPDATE),
--             :403-426 (group_invites), :470-485 (notifications),
--             :495-532 (shared-group policies)
--   HARDENED  supabase-migration-p0-launch-blockers.sql:59-96 (profiles +
--             "Active profiles only" RESTRICTIVE on 20 tables),
--             :150-195 (group_members INSERT/UPDATE owner-only, group_invites UPDATE)
--             supabase-migration-prelaunch-hardening.sql:27-71 (WITH CHECK on
--             FOR ALL policies), :285-310 (DELETE policies on group children)
--             supabase-migration-notifications-rls.sql:21-36
--             supabase-migration-phase1-persons.sql:23-35
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    200,
    '=== SECTION 02: POLICIES (trust-boundary tables) ===',
    p.tablename || ' :: ' || p.policyname,
    p.cmd || ' | ' || p.permissive || ' | roles=' || array_to_string(p.roles, ','),
    'USING: ' || COALESCE(p.qual, '(none)')
      || '   ||   WITH CHECK: ' || COALESCE(p.with_check, '(none)')
  FROM pg_policies p
 WHERE p.schemaname = 'public'
   AND p.tablename IN (
     'group_members', 'group_expenses', 'group_settlements', 'notifications',
     'persons', 'split_groups', 'group_invites',
     'linked_transaction_requests', 'linked_settlement_requests', 'profiles'
   )

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 03 — DERIVED POLICY VERDICTS (the ones the audit turns on)
-- ───────────────────────────────────────────────────────────────────────────

-- 03.1 THE CRITICAL ONE (audit finding #1 / 05 C1).
-- BASELINE  supabase-schema.sql:364-373 — "Users can add members to own or
--           shared groups" WITH CHECK (auth.uid() = profile_id OR owner...):
--           ANY authenticated user can self-insert into ANY group.
-- HARDENED  supabase-migration-p0-launch-blockers.sql:150-161 — the baseline
--           policy is DROPPED and replaced by "Group owners can add members",
--           whose WITH CHECK references split_groups only (no profile_id).
SELECT
    300,
    '=== SECTION 03: CRITICAL POLICY VERDICTS ===',
    '03.1 group_members INSERT — self-join open?',
    CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'group_members'
           AND cmd IN ('INSERT', 'ALL')
      ) THEN '!! NO INSERT POLICY AT ALL — inserts blocked; investigate'
      WHEN EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'group_members'
           AND cmd IN ('INSERT', 'ALL')
           AND permissive = 'PERMISSIVE'
           AND COALESCE(with_check, qual) ILIKE '%profile_id%'
      ) THEN '!! VULNERABLE — baseline self-insert policy is LIVE (auth.uid() = profile_id). p0-launch-blockers NOT applied.'
      WHEN EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'group_members'
           AND policyname = 'Group owners can add members'
      ) THEN 'HARDENED — owner-only INSERT (p0-launch-blockers:152 present)'
      ELSE '!! UNRECOGNISED INSERT policy shape — read detail column'
    END,
    COALESCE(
      (SELECT string_agg(policyname || ' [' || cmd || '/' || permissive || '] => '
                         || COALESCE(with_check, qual, '(null)'), '  ;  ')
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_members'
          AND cmd IN ('INSERT', 'ALL')),
      '(no INSERT/ALL policies found)')

UNION ALL

-- 03.2 Audit finding #5 / C4: the leftover FOR ALL authorship-only policy on
-- group_settlements ORs past every membership check, letting ex-members
-- rewrite/delete shared settlements.
-- Source: supabase-migration-prelaunch-hardening.sql:59-61 re-creates
--         "Users can manage own settlements" FOR ALL (the parallel
--         group_expenses one at :63 was correctly dropped).
SELECT
    301,
    '=== SECTION 03: CRITICAL POLICY VERDICTS ===',
    '03.2 group_settlements — leftover FOR ALL authorship policy?',
    CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'group_settlements'
           AND cmd = 'ALL' AND permissive = 'PERMISSIVE'
      ) THEN '!! PRESENT — audit C4 exploitable (ex-member ledger falsification)'
      ELSE 'absent — C4 policy half already fixed'
    END,
    COALESCE(
      (SELECT string_agg(policyname || ' => USING ' || COALESCE(qual, '(none)'), '  ;  ')
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_settlements' AND cmd = 'ALL'),
      '(none)')

UNION ALL

-- 03.3 group_expenses — same class. Baseline supabase-schema.sql:230 creates a
-- FOR ALL policy; supabase-migration-prelaunch-hardening.sql:63 drops it and
-- §8 (:432-441) leaves per-command policies.
SELECT
    302,
    '=== SECTION 03: CRITICAL POLICY VERDICTS ===',
    '03.3 group_expenses — baseline FOR ALL policy dropped?',
    CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'group_expenses'
           AND policyname = 'Users can manage own group expenses'
      ) THEN '!! STILL PRESENT — prelaunch-hardening §1 (line 63) NOT applied'
      ELSE 'dropped (prelaunch-hardening:63 applied, or never created)'
    END,
    COALESCE(
      (SELECT string_agg(policyname || ' [' || cmd || ']', ' ; ' ORDER BY cmd)
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'group_expenses'),
      '(none)')

UNION ALL

-- 03.4 The "Active profiles only" RESTRICTIVE gate.
-- Source: supabase-migration-p0-launch-blockers.sql:74-96 — creates one
-- RESTRICTIVE FOR ALL policy named "Active profiles only" on each of 20 tables.
-- Presence on ALL of them is the strongest single signal that p0 ran.
SELECT
    303,
    '=== SECTION 03: CRITICAL POLICY VERDICTS ===',
    '03.4 "Active profiles only" RESTRICTIVE gate coverage',
    CASE
      WHEN (SELECT count(*) FROM pg_policies
             WHERE schemaname = 'public' AND policyname = 'Active profiles only'
               AND permissive = 'RESTRICTIVE') = 0
        THEN '!! 0 tables — p0-launch-blockers §1 NOT applied'
      WHEN (SELECT count(*) FROM pg_policies
             WHERE schemaname = 'public' AND policyname = 'Active profiles only'
               AND permissive = 'RESTRICTIVE') < 15
        THEN '!! PARTIAL COVERAGE — p0 may have half-applied; see detail'
      ELSE 'present on '
           || (SELECT count(*)::text FROM pg_policies
                WHERE schemaname = 'public' AND policyname = 'Active profiles only'
                  AND permissive = 'RESTRICTIVE')
           || ' tables (p0-launch-blockers:88-92 applied)'
    END,
    COALESCE(
      (SELECT string_agg(tablename, ', ' ORDER BY tablename)
         FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'Active profiles only'
          AND permissive = 'RESTRICTIVE'),
      '(none)')

UNION ALL

-- 03.5 profiles SELECT/UPDATE policy naming.
-- BASELINE supabase-schema.sql:19-20 → "Users can view own profile" /
--          "Users can update own profile"
-- HARDENED supabase-migration-p0-launch-blockers.sql:61/67 → "...own ACTIVE
--          profile" with is_current_profile_active() in the predicate.
SELECT
    304,
    '=== SECTION 03: CRITICAL POLICY VERDICTS ===',
    '03.5 profiles policies — baseline or hardened?',
    CASE
      WHEN EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname='public' AND tablename='profiles'
                      AND policyname IN ('Users can view own active profile',
                                         'Users can update own active profile'))
        THEN 'HARDENED (p0-launch-blockers:61/67 applied)'
      WHEN EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname='public' AND tablename='profiles'
                      AND policyname IN ('Users can view own profile',
                                         'Users can update own profile'))
        THEN '!! BASELINE names live — p0-launch-blockers NOT applied'
      ELSE '!! neither shape found — read Section 02 dump'
    END,
    COALESCE(
      (SELECT string_agg(policyname || ' [' || cmd || ']', ' ; ' ORDER BY policyname)
         FROM pg_policies WHERE schemaname='public' AND tablename='profiles'),
      '(none)')

UNION ALL

-- 03.6 notifications INSERT — audit finding #6 / C7 (any co-member can insert
-- an arbitrary notification that is forwarded verbatim as an app-branded push).
-- Source: supabase-migration-notifications-rls.sql:35-44 (and the identical
--         policy at supabase-schema.sql:484).
SELECT
    305,
    '=== SECTION 03: CRITICAL POLICY VERDICTS ===',
    '03.6 notifications INSERT — self-only or fellow-member?',
    CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename='notifications'
           AND cmd IN ('INSERT','ALL')
           AND COALESCE(with_check, qual) ILIKE '%is_group_member%'
      ) THEN '!! fellow-member INSERT allowed — C7 phishing surface open'
      WHEN EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename='notifications'
           AND cmd IN ('INSERT','ALL')
      ) THEN 'INSERT policy present — inspect predicate in detail'
      ELSE '!! no INSERT policy on notifications'
    END,
    COALESCE(
      (SELECT string_agg(policyname || ' => ' || COALESCE(with_check, qual, '(null)'), ' ; ')
         FROM pg_policies
        WHERE schemaname='public' AND tablename='notifications' AND cmd IN ('INSERT','ALL')),
      '(none)')

UNION ALL

-- 03.7 group_invites SELECT — audit finding #6 (token_hash is member-readable
-- AND is the accepted credential).
-- Source: supabase-schema.sql:403-413.
-- NOTE: supabase-migration-audit-p0-consent-guards.sql:1407-1416 closes C6 at
-- the COLUMN-privilege layer (REVOKE SELECT on the table, then a column GRANT
-- that omits token_hash), deliberately leaving the row policy in place so
-- members keep seeing their group's invites. A policy-only verdict therefore
-- reports "C6 open" on a database where C6 is closed — the column grant is
-- checked first.
SELECT
    306,
    '=== SECTION 03: CRITICAL POLICY VERDICTS ===',
    '03.7 group_invites SELECT — members can read token_hash?',
    CASE
      WHEN to_regclass('public.group_invites') IS NULL
        THEN '!! TABLE MISSING'
      WHEN NOT has_column_privilege('authenticated', 'public.group_invites',
                                    'token_hash', 'SELECT')
        THEN 'token_hash NOT readable by authenticated — C6 closed (consent-guards column grant)'
      WHEN EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename='group_invites'
           AND cmd IN ('SELECT','ALL')
           AND qual ILIKE '%is_group_member%'
      ) THEN '!! members can SELECT invites (token_hash readable) — C6 open'
      ELSE 'members cannot broadly SELECT invites — inspect detail'
    END,
    'token_hash SELECT grant to authenticated = '
      || COALESCE(has_column_privilege('authenticated', 'public.group_invites',
                                       'token_hash', 'SELECT')::text, '?')
      || '  ||  '
      || COALESCE(
           (SELECT string_agg(policyname || ' [' || cmd || '] => ' || COALESCE(qual,'(none)'), ' ; ')
              FROM pg_policies WHERE schemaname='public' AND tablename='group_invites'),
           '(none)')

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 04 — FUNCTIONS PRESENT (name, exact argument signature, security)
-- Every name below is defined by at least one migration in the repo. The
-- ARGUMENT SIGNATURE is the load-bearing part: several functions were
-- redefined with different arities across migrations, and PostgREST fails with
-- HTTP 300 if two overloads coexist.
--   join_group_by_code(text)        supabase-migration-prelaunch-hardening.sql:350  (JSONB, 1 arg)
--   join_group_by_code(text,text)   supabase-migration-p0-launch-blockers.sql:223   (TABLE, 2 args)
--                                   supabase-migration-fix-group-invite-join-rpc.sql:6 (repairs ambiguity)
--   accept_group_invite(text,text)  supabase-migration-p0-launch-blockers.sql:298
--   lookup_profile_by_code(text)    supabase-migration-phase2a-linked-profile.sql:28,
--                                   re-created supabase-migration-p0-launch-blockers.sql:369
--   lookup_profile_by_public_code   supabase-migration-group-codes.sql:26 (DROPPED by
--                                   prelaunch-hardening:318 and p0:386)
--   lookup_group_by_join_code       supabase-migration-group-codes.sql:44 (DROPPED by p0:197)
--   apply_account_balance_delta     supabase-migration-prelaunch-hardening.sql:245
--   delete_current_user()           supabase-migration-p0-launch-blockers.sql:102
--   soft_delete_current_user()      supabase-migration-prelaunch-hardening.sql:169 (DROPPED by p0:138)
--   is_current_profile_active()     supabase-migration-p0-launch-blockers.sql:15
--   is_group_member(text,uuid)      supabase-schema.sql:~335
--   leave_group(text)               supabase-migration-safe-leave-group.sql:55
--   archive_contact_if_settled(text) supabase-migration-safe-contact-archive.sql:17
--   merge_person(text,text)         supabase-migration-contacts-merge-unarchive.sql:29
--   unarchive_contact(text)         supabase-migration-contacts-merge-unarchive.sql:186
--   notify_contact_linked(uuid)     supabase-migration-contact-link-notify.sql:18,
--                                   redefined -reciprocal.sql:22 and -connections-push-discovery.sql:81
--   respond_contact_link(text,bool) supabase-migration-connections-push-discovery.sql:194
--   lookup_hisaab_users_by_phone(text[]) supabase-migration-connections-push-discovery.sql:323
--   register_push_token(text,text)  supabase-migration-connections-push-discovery.sql:413
--   accept_linked_request(...)      supabase-migration-cross-user-account-effects.sql:156 (2 args)
--   accept_settlement_request(...)  supabase-migration-settlement-emi-and-account-guards.sql:24 (1 arg)
--                                   supabase-migration-cross-user-account-effects.sql:417 (2 args)
--   cancel/reject_settlement_request supabase-migration-fix-settlement-cancel-reject.sql:41,76
--   reconcile_group_expense(...)    supabase-migration-fix-group-expense-reconciliation-rpc.sql:10
--   get_committee_witness(text)     supabase-migration-committees-phase2.sql:18
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    400,
    '=== SECTION 04: FUNCTIONS PRESENT ===',
    p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'security invoker' END
      || ' | returns ' || pg_get_function_result(p.oid),
    'search_path/config=' || COALESCE(array_to_string(p.proconfig, ','), '(NOT SET)')
      || ' | lang=' || l.lanname
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language  l ON l.oid = p.prolang
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'join_group_by_code', 'accept_group_invite',
     'lookup_profile_by_code', 'lookup_profile_by_public_code',
     'lookup_group_by_join_code',
     'apply_account_balance_delta',
     'delete_current_user', 'soft_delete_current_user',
     'is_current_profile_active', 'is_group_member',
     'leave_group',
     'archive_contact_if_settled', 'unarchive_contact', 'merge_person',
     'notify_contact_linked', 'respond_contact_link',
     'lookup_hisaab_users_by_phone', 'register_push_token',
     'accept_linked_request', 'reject_linked_request', 'cancel_linked_request',
     'create_settlement_request', 'accept_settlement_request',
     'reject_settlement_request', 'cancel_settlement_request',
     'reconcile_group_expense', 'get_committee_witness',
     'enforce_group_expense_reconciliation_payer',
     'tg_profiles_protect_security_fields',
     'tg_group_members_protect_membership_fields',
     'tg_group_expenses_require_connected_members',
     'tg_group_settlements_require_connected_members',
     'tg_persons_protect_archive', 'tg_block_archived_person_reference',
     'tg_ltr_validate_insert', 'tg_ltr_notify', 'tg_lsr_notify',
     'tg_notifications_push', 'tg_accounts_touch', 'tg_touch_updated_at',
     'tg_persons_touch'
   )

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 05 — FUNCTIONS THAT MUST BE *ABSENT*
-- Each row names an exact signature a migration explicitly DROPs. A "STILL
-- PRESENT" verdict means that migration never ran (or ran before something
-- re-created the function — the alphabetical-apply trap).
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    500,
    '=== SECTION 05: FUNCTIONS THAT MUST BE ABSENT ===',
    x.sig,
    CASE WHEN to_regprocedure(x.sig) IS NULL
         THEN 'absent (as expected)'
         ELSE '!! STILL PRESENT — ' || x.impact
    END,
    x.why
  FROM (VALUES
    ('public.soft_delete_current_user()',
     'dropped by supabase-migration-p0-launch-blockers.sql:138 (replaced by delete_current_user)',
     'p0-launch-blockers did NOT run, or prelaunch-hardening ran AFTER it'),
    ('public.lookup_group_by_join_code(text)',
     'dropped by supabase-migration-p0-launch-blockers.sql:197 (created group-codes.sql:44)',
     'unthrottled group lookup by join code is live'),
    ('public.join_group_by_code(text)',
     'dropped by supabase-migration-p0-launch-blockers.sql:198 (created prelaunch-hardening.sql:350)',
     'coexists with the 2-arg version => PostgREST HTTP 300 ambiguity on every join'),
    ('public.lookup_profile_by_public_code(text)',
     'dropped by prelaunch-hardening.sql:318 AND p0-launch-blockers.sql:386 (created group-codes.sql:26)',
     'leaks profiles.public_code; NOTE the shipped client still CALLS this RPC'),
    ('public.accept_linked_request(text)',
     'dropped by supabase-migration-cross-user-account-effects.sql:154',
     'coexists with the 2-arg default version => ambiguous PostgREST call'),
    ('public.accept_settlement_request(text)',
     'dropped by supabase-migration-cross-user-account-effects.sql:415',
     'coexists with the 2-arg default version => ambiguous PostgREST call')
  ) AS x(sig, why, impact)

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 06 — CLIENT-CALLED RPC COVERAGE
-- Exactly the 23 RPC names the shipped client invokes via supabase.rpc(...)
-- (enumerated from src/). A MISSING row means a live app feature is broken in
-- production right now. Audit finding #1 flags one of these specifically:
-- the client calls lookup_profile_by_public_code, which prelaunch-hardening
-- and p0-launch-blockers both DROP.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    600,
    '=== SECTION 06: CLIENT-CALLED RPC COVERAGE ===',
    r.rpc_name,
    CASE
      WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = r.rpc_name) = 0
        THEN '!! MISSING — client call fails (PGRST202)'
      WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = r.rpc_name) > 1
        THEN '!! OVERLOADED — possible PostgREST 300 ambiguity'
      ELSE 'ok'
    END,
    COALESCE(
      (SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ' ; ')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = r.rpc_name),
      '(not found)')
  FROM (VALUES
    ('accept_group_invite'), ('accept_linked_request'), ('accept_settlement_request'),
    ('apply_account_balance_delta'), ('archive_contact_if_settled'),
    ('cancel_linked_request'), ('cancel_settlement_request'),
    ('create_settlement_request'), ('delete_current_user'),
    ('get_committee_witness'), ('join_group_by_code'), ('leave_group'),
    ('lookup_hisaab_users_by_phone'), ('lookup_profile_by_code'),
    ('lookup_profile_by_public_code'), ('merge_person'), ('notify_contact_linked'),
    ('reconcile_group_expense'), ('register_push_token'), ('reject_linked_request'),
    ('reject_settlement_request'), ('respond_contact_link'), ('unarchive_contact')
  ) AS r(rpc_name)

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 07 — TRIGGERS ON THE MONEY / MEMBERSHIP TABLES
-- Expected (with source):
--   group_members     group_members_protect_membership_fields   safe-leave-group.sql:47
--   group_expenses    group_expenses_require_connected_members  enforce-active-group-transaction-members.sql:67
--   group_expenses    trg_group_expenses_reconciliation_payer   reconciliation.sql:58
--   group_settlements group_settlements_require_connected_members enforce-active-group-transaction-members.sql:107
--   persons           persons_protect_archive                   safe-contact-archive.sql:124
--   profiles          profiles_protect_security_fields          p0-launch-blockers.sql:53
--   loans             loans_block_archived_person_reference     safe-contact-archive.sql:150
--   transactions      transactions_block_archived_person_reference safe-contact-archive.sql:155
--   accounts          trg_accounts_touch                        prelaunch-hardening.sql:461 / incremental-sync-core.sql:24
--   notifications     notifications_push                        connections-push-discovery.sql:486
--   linked_transaction_requests  ltr_notify                     linked-notifications-realtime.sql:71
--   linked_settlement_requests   lsr_notify                     linked-notifications-realtime.sql:115
-- NOTE: persons has NO trigger protecting linked_profile_id (audit C6 / H2) —
--       its absence here is the confirmation of that finding.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    700,
    '=== SECTION 07: TRIGGERS ===',
    t.tgrelid::regclass::text || ' :: ' || t.tgname,
    CASE t.tgenabled
      WHEN 'D' THEN '!! DISABLED'
      WHEN 'O' THEN 'enabled (origin)'
      WHEN 'R' THEN 'enabled (replica)'
      WHEN 'A' THEN 'enabled (always)'
      ELSE t.tgenabled::text
    END,
    'function=public.' || pr.proname || '()'
  FROM pg_trigger t
  JOIN pg_proc pr ON pr.oid = t.tgfoid
 WHERE NOT t.tgisinternal
   AND t.tgrelid IN (
     SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (
          'group_members', 'group_expenses', 'group_settlements', 'persons',
          'profiles', 'accounts', 'transactions', 'loans', 'notifications',
          'linked_transaction_requests', 'linked_settlement_requests'
        )
   )

UNION ALL

-- 07.x Named-trigger presence roll-call (so a MISSING trigger produces a row,
-- not just an absence you have to notice).
SELECT
    701,
    '=== SECTION 07: TRIGGERS (expected roll-call) ===',
    e.tbl || ' :: ' || e.trg,
    CASE
      WHEN to_regclass('public.' || e.tbl) IS NULL THEN '!! TABLE MISSING'
      WHEN EXISTS (
        SELECT 1 FROM pg_trigger t
         WHERE t.tgrelid = to_regclass('public.' || e.tbl)
           AND t.tgname = e.trg AND NOT t.tgisinternal
      ) THEN 'present'
      ELSE '!! MISSING'
    END,
    e.src
  FROM (VALUES
    ('group_members','group_members_protect_membership_fields','supabase-migration-safe-leave-group.sql:47'),
    ('group_expenses','group_expenses_require_connected_members','supabase-migration-enforce-active-group-transaction-members.sql:67'),
    ('group_expenses','trg_group_expenses_reconciliation_payer','supabase-migration-reconciliation.sql:58'),
    ('group_settlements','group_settlements_require_connected_members','supabase-migration-enforce-active-group-transaction-members.sql:107'),
    ('persons','persons_protect_archive','supabase-migration-safe-contact-archive.sql:124'),
    ('profiles','profiles_protect_security_fields','supabase-migration-p0-launch-blockers.sql:53'),
    ('loans','loans_block_archived_person_reference','supabase-migration-safe-contact-archive.sql:150'),
    ('transactions','transactions_block_archived_person_reference','supabase-migration-safe-contact-archive.sql:155'),
    ('accounts','trg_accounts_touch','supabase-migration-prelaunch-hardening.sql:461 / incremental-sync-core.sql:24'),
    ('notifications','notifications_push','supabase-migration-connections-push-discovery.sql:486'),
    ('linked_transaction_requests','ltr_notify','supabase-migration-linked-notifications-realtime.sql:71'),
    ('linked_settlement_requests','lsr_notify','supabase-migration-linked-notifications-realtime.sql:115')
  ) AS e(tbl, trg, src)

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 08 — CURRENCY CHECK CONSTRAINTS (audit finding #10 / C9)
-- Source: supabase-migration-phase2b-linked-requests.sql:14,
--         supabase-migration-phase2c-a-settlement-requests.sql:167,
--         supabase-migration-fix-bidirectional-linked-settlements.sql:25
--         — all three hard-code check (currency in ('AED','PKR')) while the
--         app ships 8 currencies. Never widened by any later migration.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    800,
    '=== SECTION 08: CURRENCY CHECK CONSTRAINTS ===',
    con.conrelid::regclass::text || ' :: ' || con.conname,
    -- Sentinel = BHD, not USD. USD is NOT one of the app's eight currencies
    -- (src/db/types.ts SUPPORTED_CURRENCIES = AED, PKR, PHP, SAR, QAR, OMR,
    -- KWD, BHD), so a "NOT LIKE '%USD%'" test stays true even after
    -- supabase-migration-audit-p0-currencies.sql widens the constraint —
    -- reporting "C9 open" on a fixed database. BHD is the sentinel that file's
    -- own V1/V2 checks use.
    CASE
      WHEN pg_get_constraintdef(con.oid) ILIKE '%''AED''%'
       AND pg_get_constraintdef(con.oid) NOT ILIKE '%''BHD''%'
        THEN '!! NARROW — AED/PKR only (C9 open: 6 of 8 currencies error out)'
      WHEN pg_get_constraintdef(con.oid) ILIKE '%''BHD''%'
        THEN 'widened — all 8 shipped currencies accepted (C9 closed)'
      ELSE 'widened / other currency constraint — read detail'
    END,
    pg_get_constraintdef(con.oid)
  FROM pg_constraint con
 WHERE con.contype = 'c'
   AND con.connamespace = 'public'::regnamespace
   AND pg_get_constraintdef(con.oid) ILIKE '%currency%'

UNION ALL

-- 08.x Explicit presence check on the two linked-request tables even if the
-- constraint is named unexpectedly or absent.
SELECT
    801,
    '=== SECTION 08: CURRENCY CHECK CONSTRAINTS ===',
    t.tbl || ' — any currency CHECK at all?',
    CASE
      WHEN to_regclass('public.' || t.tbl) IS NULL THEN '!! TABLE MISSING'
      WHEN EXISTS (
        SELECT 1 FROM pg_constraint con
         WHERE con.conrelid = to_regclass('public.' || t.tbl)
           AND con.contype = 'c'
           AND pg_get_constraintdef(con.oid) ILIKE '%currency%'
      ) THEN 'constraint exists (see rows above for its definition)'
      ELSE 'NO currency CHECK — C9 already resolved on this table, or never created'
    END,
    'source: supabase-migration-phase2b-linked-requests.sql:14 / phase2c-a:167 / fix-bidirectional:25'
  FROM (VALUES ('linked_transaction_requests'), ('linked_settlement_requests')) AS t(tbl)

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 09 — REALTIME PUBLICATION CONTENTS
-- Source: supabase-migration-realtime.sql:19,26 (notifications, group_members)
--         supabase-migration-linked-notifications-realtime.sql:119-143
--         (linked_transaction_requests, linked_settlement_requests)
-- Also answers audit §7.A.2 ("Realtime publication contents" unknown).
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    900,
    '=== SECTION 09: REALTIME PUBLICATION ===',
    pt.pubname || ' :: ' || pt.schemaname || '.' || pt.tablename,
    'in publication',
    ''
  FROM pg_publication_tables pt
 WHERE pt.pubname = 'supabase_realtime'

UNION ALL

SELECT
    901,
    '=== SECTION 09: REALTIME PUBLICATION (expected roll-call) ===',
    x.tbl,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_publication_tables pt
         WHERE pt.pubname = 'supabase_realtime'
           AND pt.schemaname = 'public' AND pt.tablename = x.tbl
      ) THEN 'in supabase_realtime'
      ELSE '!! NOT in supabase_realtime (live updates dead for this table)'
    END,
    x.src
  FROM (VALUES
    ('notifications','supabase-migration-realtime.sql:19'),
    ('group_members','supabase-migration-realtime.sql:26'),
    ('linked_transaction_requests','supabase-migration-linked-notifications-realtime.sql:119-143'),
    ('linked_settlement_requests','supabase-migration-linked-notifications-realtime.sql:119-143')
  ) AS x(tbl, src)

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 10 — TABLE EXISTENCE (possibly-unapplied migrations)
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    1000,
    '=== SECTION 10: TABLE EXISTENCE ===',
    t.tbl,
    CASE WHEN to_regclass('public.' || t.tbl) IS NULL
         THEN '!! MISSING'
         ELSE 'present' END,
    t.src
  FROM (VALUES
    -- rate limiting / hardening
    ('join_code_attempts',   'p0-launch-blockers.sql:200 AND prelaunch-hardening.sql:332'),
    ('phone_lookup_attempts','connections-push-discovery.sql:314'),
    -- connections / push / discovery
    ('contact_link_requests','connections-push-discovery.sql:35'),
    ('device_push_tokens',   'connections-push-discovery.sql:376'),
    ('app_push_config',      'connections-push-discovery.sql:442'),
    -- committees (kameti)
    ('committees',           'committees.sql:11'),
    ('committee_members',    'committees.sql:29'),
    ('committee_payments',   'committees.sql:44'),
    -- investments
    ('investment_markets',   'investments.sql:24'),
    ('investment_trades',    'investments.sql:38'),
    ('investment_prices',    'investments.sql:65'),
    -- phase 3
    ('budgets',              'phase3-budgets-recurring-remittances.sql:18'),
    ('recurring_transactions','phase3-budgets-recurring-remittances.sql:58'),
    ('remittances',          'phase3-budgets-recurring-remittances.sql:101'),
    -- cross-user request pipeline
    ('persons',                    'phase1-persons.sql:8'),
    ('linked_transaction_requests','phase2b-linked-requests.sql'),
    ('linked_settlement_requests', 'phase2c-a-settlement-requests.sql:167'),
    -- group core
    ('split_groups',      'supabase-schema.sql'),
    ('group_members',     'supabase-schema.sql'),
    ('group_expenses',    'supabase-schema.sql'),
    ('group_settlements', 'supabase-schema.sql'),
    ('group_invites',     'supabase-schema.sql:386'),
    ('group_events',      'supabase-schema.sql'),
    ('notifications',     'supabase-schema.sql')
  ) AS t(tbl, src)

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 11 — COLUMN EXISTENCE (the load-bearing ALTER TABLEs)
-- Columns are the cheapest fingerprint for a migration that only adds fields.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    1100,
    '=== SECTION 11: COLUMN EXISTENCE ===',
    c.tbl || '.' || c.col,
    CASE
      WHEN to_regclass('public.' || c.tbl) IS NULL THEN '!! TABLE MISSING'
      WHEN EXISTS (
        SELECT 1 FROM information_schema.columns ic
         WHERE ic.table_schema = 'public'
           AND ic.table_name = c.tbl
           AND ic.column_name = c.col
      ) THEN 'present'
      ELSE '!! MISSING'
    END,
    c.src
  FROM (VALUES
    ('profiles','is_deleted',                  'p0-launch-blockers.sql:12 / prelaunch-hardening.sql:161'),
    ('profiles','deleted_at',                  'p0-launch-blockers.sql:13 / prelaunch-hardening.sql:162'),
    ('profiles','public_code_normalized',      'supabase-schema.sql:260 (index) / group-codes.sql'),
    ('profiles','phone_e164',                  'connections-push-discovery.sql:304'),
    ('profiles','phone_discoverable',          'connections-push-discovery.sql:305'),
    ('split_groups','join_code',               'group-codes.sql:16'),
    ('split_groups','join_code_normalized',    'group-codes.sql:17'),
    ('split_groups','join_code_expires_at',    'p0-launch-blockers.sql:216 / prelaunch-hardening.sql:325'),
    ('accounts','updated_at',                  'prelaunch-hardening.sql:448 / incremental-sync-core.sql:22'),
    ('accounts','deleted_at',                  'incremental-sync-tombstones.sql:8'),
    ('transactions','updated_at',              'incremental-sync-core.sql:33'),
    ('transactions','deleted_at',              'incremental-sync-tombstones.sql:11'),
    ('transactions','person_id',               'phase1-persons.sql:49'),
    ('transactions','receipt_path',            'receipts.sql (alter transactions)'),
    ('transactions','related_investment_id',   'investments.sql:81'),
    ('loans','person_id',                      'phase1-persons.sql:48'),
    ('loans','deleted_at',                     'incremental-sync-tombstones.sql:14'),
    ('budgets','deleted_at',                   'incremental-sync-tombstones.sql:17'),
    ('persons','linked_profile_id',            'phase2a-linked-profile.sql (consent predicate — audit H2)'),
    ('persons','archived_at',                  'safe-contact-archive.sql:11'),
    ('group_expenses','version',               'supabase-schema.sql:308 (stored, never compared — audit #8)'),
    ('group_expenses','deleted_at',            'supabase-schema.sql:306'),
    ('group_settlements','created_by',         'supabase-schema.sql:311'),
    ('linked_transaction_requests','requester_account_id','cross-user-account-effects.sql:45'),
    ('linked_transaction_requests','responder_account_id','cross-user-account-effects.sql:47'),
    ('linked_settlement_requests','responder_account_id','cross-user-account-effects.sql:50'),
    ('contact_link_requests','from_name',      'connections-push-discovery.sql:53'),
    ('committees','draw_seed',                 'committees-phase2.sql:11'),
    ('committees','draw_commitment',           'committees-phase2.sql:12'),
    ('committees','share_token',               'committees-phase2.sql:13')
  ) AS c(tbl, col, src)

UNION ALL

-- ───────────────────────────────────────────────────────────────────────────
-- SECTION 12 — FOREIGN KEYS ADDED BY prelaunch-hardening §2
-- Source: supabase-migration-prelaunch-hardening.sql:110-153
-- ───────────────────────────────────────────────────────────────────────────
SELECT
    1200,
    '=== SECTION 12: FOREIGN KEYS ===',
    f.conname,
    CASE
      WHEN EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conname = f.conname
                      AND c.connamespace = 'public'::regnamespace)
        THEN 'present'
      ELSE '!! MISSING'
    END,
    f.src
  FROM (VALUES
    ('fk_transactions_source_account',      'prelaunch-hardening.sql:113 (ON DELETE RESTRICT)'),
    ('fk_transactions_destination_account', 'prelaunch-hardening.sql:124 (ON DELETE RESTRICT)'),
    ('fk_recurring_source_account',         'prelaunch-hardening.sql:151 (ON DELETE SET NULL)')
  ) AS f(conname, src)

UNION ALL

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 13 — VERDICT HELPERS: "IS THIS MIGRATION APPLIED?"
-- Each verdict is keyed on that migration's MOST DISTINCTIVE artifact — one
-- that no other file in the repo creates. Read this section first; the
-- sections above are the supporting evidence.
-- ═══════════════════════════════════════════════════════════════════════════

-- 13.1 supabase-migration-p0-launch-blockers.sql
-- Key: is_current_profile_active() (:15) — created nowhere else — plus the
-- RESTRICTIVE "Active profiles only" policies (:88-92) and the owner-only
-- group_members INSERT policy (:152). soft_delete_current_user() must be gone (:138).
SELECT
    1301,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'p0-launch-blockers applied?',
    CASE
      WHEN to_regprocedure('public.is_current_profile_active()') IS NOT NULL
       AND (SELECT count(*) FROM pg_policies
             WHERE schemaname='public' AND policyname='Active profiles only'
               AND permissive='RESTRICTIVE') >= 15
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname='public' AND tablename='group_members'
                      AND policyname='Group owners can add members')
       AND to_regprocedure('public.soft_delete_current_user()') IS NULL
        THEN 'YES — fully applied'
      WHEN to_regprocedure('public.is_current_profile_active()') IS NOT NULL
        THEN '!! PARTIAL — is_current_profile_active exists but a companion artifact is missing (see detail)'
      ELSE '!! NO — the audit''s worst-case baseline is LIVE'
    END,
    'is_current_profile_active='
      || (to_regprocedure('public.is_current_profile_active()') IS NOT NULL)::text
      || ' | ActiveProfilesOnly_tables='
      || (SELECT count(*)::text FROM pg_policies
           WHERE schemaname='public' AND policyname='Active profiles only' AND permissive='RESTRICTIVE')
      || ' | owner_only_member_insert='
      || EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='group_members'
                    AND policyname='Group owners can add members')::text
      || ' | soft_delete_removed='
      || (to_regprocedure('public.soft_delete_current_user()') IS NULL)::text
      || ' | delete_current_user='
      || (to_regprocedure('public.delete_current_user()') IS NOT NULL)::text

UNION ALL

-- 13.2 supabase-migration-prelaunch-hardening.sql
-- Key: apply_account_balance_delta(text,numeric,numeric) (:245) — defined in
-- this file ONLY (verified: no other supabase-*.sql mentions it) — plus the
-- two transactions↔accounts FKs (:113,:124).
SELECT
    1302,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'prelaunch-hardening applied?',
    CASE
      WHEN to_regprocedure('public.apply_account_balance_delta(text,numeric,numeric)') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname='fk_transactions_source_account'
                      AND connamespace='public'::regnamespace)
        THEN 'YES — applied'
      WHEN to_regprocedure('public.apply_account_balance_delta(text,numeric,numeric)') IS NOT NULL
        THEN '!! PARTIAL — balance RPC present but §2 FKs missing'
      ELSE '!! NO — optimistic-lock balance RPC absent; every balance write is last-writer-wins'
    END,
    'apply_account_balance_delta='
      || (to_regprocedure('public.apply_account_balance_delta(text,numeric,numeric)') IS NOT NULL)::text
      || ' | fk_transactions_source_account='
      || EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_transactions_source_account'
                  AND connamespace='public'::regnamespace)::text
      || ' | fk_transactions_destination_account='
      || EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_transactions_destination_account'
                  AND connamespace='public'::regnamespace)::text
      || ' | accounts.updated_at='
      || EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='accounts' AND column_name='updated_at')::text

UNION ALL

-- 13.3 supabase-migration-connections-push-discovery.sql
-- Key: lookup_hisaab_users_by_phone(text[]) (:323) + device_push_tokens (:376)
-- + profiles.phone_e164 (:304). None of these exist in any other file.
SELECT
    1303,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'connections-push-discovery applied?',
    CASE
      WHEN to_regprocedure('public.lookup_hisaab_users_by_phone(text[])') IS NOT NULL
       AND to_regclass('public.device_push_tokens') IS NOT NULL
       AND to_regclass('public.app_push_config') IS NOT NULL
        THEN 'YES — applied'
      WHEN to_regprocedure('public.lookup_hisaab_users_by_phone(text[])') IS NOT NULL
        OR to_regclass('public.device_push_tokens') IS NOT NULL
        THEN '!! PARTIAL — see detail'
      ELSE 'NO — phone discovery, contact-link consent flow and tier-3 push are all dead'
    END,
    'lookup_hisaab_users_by_phone='
      || (to_regprocedure('public.lookup_hisaab_users_by_phone(text[])') IS NOT NULL)::text
      || ' | device_push_tokens=' || (to_regclass('public.device_push_tokens') IS NOT NULL)::text
      || ' | app_push_config='    || (to_regclass('public.app_push_config') IS NOT NULL)::text
      || ' | contact_link_requests=' || (to_regclass('public.contact_link_requests') IS NOT NULL)::text
      || ' | phone_lookup_attempts=' || (to_regclass('public.phone_lookup_attempts') IS NOT NULL)::text
      || ' | respond_contact_link=' || (to_regprocedure('public.respond_contact_link(text,boolean)') IS NOT NULL)::text
      || ' | notifications_push_trigger='
      || COALESCE(EXISTS (SELECT 1 FROM pg_trigger t
                           WHERE t.tgrelid = to_regclass('public.notifications')
                             AND t.tgname = 'notifications_push' AND NOT t.tgisinternal)::text, 'n/a')

UNION ALL

-- 13.4 supabase-migration-cross-user-account-effects.sql
-- Key: linked_transaction_requests.requester_account_id (:45) — added only
-- here — plus the 2-arg accept RPCs that replace the dropped 1-arg ones
-- (:154/:156, :415/:417).
SELECT
    1304,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'cross-user-account-effects applied?',
    CASE
      WHEN EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='linked_transaction_requests'
                      AND column_name='requester_account_id')
       AND to_regprocedure('public.accept_linked_request(text,text)') IS NOT NULL
       AND to_regprocedure('public.accept_settlement_request(text,text)') IS NOT NULL
       AND to_regprocedure('public.accept_linked_request(text)') IS NULL
       AND to_regprocedure('public.accept_settlement_request(text)') IS NULL
        THEN 'YES — applied cleanly'
      WHEN EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='linked_transaction_requests'
                      AND column_name='requester_account_id')
        THEN '!! PARTIAL / AMBIGUOUS — columns added but RPC signatures wrong (see detail)'
      ELSE 'NO — linked loans never touch real accounts; full-tracker balances drift'
    END,
    'ltr.requester_account_id='
      || EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='linked_transaction_requests'
                    AND column_name='requester_account_id')::text
      || ' | ltr.responder_account_id='
      || EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='linked_transaction_requests'
                    AND column_name='responder_account_id')::text
      || ' | lsr.responder_account_id='
      || EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='linked_settlement_requests'
                    AND column_name='responder_account_id')::text
      || ' | accept_linked_request(text,text)='
      || (to_regprocedure('public.accept_linked_request(text,text)') IS NOT NULL)::text
      || ' | accept_linked_request(text) leftover='
      || (to_regprocedure('public.accept_linked_request(text)') IS NOT NULL)::text
      || ' | accept_settlement_request(text,text)='
      || (to_regprocedure('public.accept_settlement_request(text,text)') IS NOT NULL)::text
      || ' | accept_settlement_request(text) leftover='
      || (to_regprocedure('public.accept_settlement_request(text)') IS NOT NULL)::text

UNION ALL

-- 13.5 supabase-migration-investments.sql
-- Key: the three investment_* tables (:24,:38,:65) + transactions.related_investment_id (:81).
SELECT
    1305,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'investments applied?',
    CASE
      WHEN to_regclass('public.investment_markets') IS NOT NULL
       AND to_regclass('public.investment_trades')  IS NOT NULL
       AND to_regclass('public.investment_prices')  IS NOT NULL
        THEN 'YES — applied'
      WHEN to_regclass('public.investment_markets') IS NOT NULL
        OR to_regclass('public.investment_trades')  IS NOT NULL
        THEN '!! PARTIAL — see detail'
      ELSE 'NO — the Investments tab writes to tables that do not exist'
    END,
    'investment_markets=' || (to_regclass('public.investment_markets') IS NOT NULL)::text
      || ' | investment_trades=' || (to_regclass('public.investment_trades') IS NOT NULL)::text
      || ' | investment_prices=' || (to_regclass('public.investment_prices') IS NOT NULL)::text
      || ' | transactions.related_investment_id='
      || EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='transactions'
                    AND column_name='related_investment_id')::text

UNION ALL

-- 13.6 supabase-migration-settlement-emi-and-account-guards.sql
-- Key: accept_settlement_request's BODY references emi_schedules (:24 onward,
-- 5 occurrences). The prior live version (fix-bidirectional-linked-settlements.sql)
-- has ZERO references to emi_schedules — so prosrc is the discriminator.
-- NOTE: cross-user-account-effects.sql carries the same EMI logic forward, so
-- a YES here is also satisfied by 13.4 being YES. A NO here with 13.4 NO means
-- the EMI desync bug is live in production.
SELECT
    1306,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'settlement-emi (and account guards) applied?',
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='accept_settlement_request')
        THEN '!! accept_settlement_request MISSING entirely'
      WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname='accept_settlement_request'
                      AND p.prosrc ILIKE '%emi_schedules%')
        THEN 'YES — the live RPC settles EMI instalments'
      ELSE '!! NO — live RPC is the pre-EMI version (fix-bidirectional-linked-settlements.sql); the schedule-desync bug is ACTIVE'
    END,
    'deleted_account_guard_present='
      || EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='accept_settlement_request'
                    AND p.prosrc ILIKE '%deleted_at%')::text
      || ' | signatures='
      || COALESCE((SELECT string_agg('(' || pg_get_function_identity_arguments(p.oid) || ')', ' ; ')
                     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname='accept_settlement_request'), '(none)')

UNION ALL

-- 13.7 supabase-migration-contacts-merge-unarchive.sql
-- Key: merge_person(text,text) (:29) and unarchive_contact(text) (:186).
-- Both are defined in this file only. The client calls both.
SELECT
    1307,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'contacts-merge-unarchive applied?',
    CASE
      WHEN to_regprocedure('public.merge_person(text,text)') IS NOT NULL
       AND to_regprocedure('public.unarchive_contact(text)')  IS NOT NULL
        THEN 'YES — applied'
      WHEN to_regprocedure('public.merge_person(text,text)') IS NOT NULL
        OR to_regprocedure('public.unarchive_contact(text)')  IS NOT NULL
        THEN '!! PARTIAL — see detail'
      ELSE '!! NO — the Contacts merge/unarchive buttons fail in production'
    END,
    'merge_person=' || (to_regprocedure('public.merge_person(text,text)') IS NOT NULL)::text
      || ' | unarchive_contact=' || (to_regprocedure('public.unarchive_contact(text)') IS NOT NULL)::text
      || ' | tg_block_archived_person_reference='
      || (to_regprocedure('public.tg_block_archived_person_reference()') IS NOT NULL)::text

UNION ALL

-- 13.8 (supporting) supabase-migration-safe-leave-group.sql
-- Key: leave_group(text) (:55) — defined in this file only — plus the
-- membership-field protect trigger (:47).
SELECT
    1308,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'safe-leave-group applied?  [supporting]',
    CASE
      WHEN to_regprocedure('public.leave_group(text)') IS NOT NULL
        THEN 'YES — applied'
      ELSE '!! NO — the client''s leave_group RPC call fails; audit #2 comparison basis invalid'
    END,
    'leave_group=' || (to_regprocedure('public.leave_group(text)') IS NOT NULL)::text
      || ' | protect_membership_trigger='
      || COALESCE(EXISTS (SELECT 1 FROM pg_trigger t
                           WHERE t.tgrelid = to_regclass('public.group_members')
                             AND t.tgname = 'group_members_protect_membership_fields'
                             AND NOT t.tgisinternal)::text, 'n/a')

UNION ALL

-- 13.9 (supporting) supabase-migration-enforce-active-group-transaction-members.sql
-- Key: the two BEFORE INSERT OR UPDATE triggers (:67, :107) and their
-- functions — defined in this file only.
SELECT
    1309,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'enforce-active-group-transaction-members applied?  [supporting]',
    CASE
      WHEN to_regprocedure('public.tg_group_expenses_require_connected_members()') IS NOT NULL
       AND to_regprocedure('public.tg_group_settlements_require_connected_members()') IS NOT NULL
        THEN 'YES — applied'
      ELSE '!! NO — expenses/settlements can name left or non-existent members'
    END,
    'expenses_fn=' || (to_regprocedure('public.tg_group_expenses_require_connected_members()') IS NOT NULL)::text
      || ' | settlements_fn=' || (to_regprocedure('public.tg_group_settlements_require_connected_members()') IS NOT NULL)::text

UNION ALL

-- 13.10 (supporting) supabase-migration-fix-group-invite-join-rpc.sql
-- Key: it repairs the join RPC ambiguity by leaving exactly ONE
-- join_group_by_code overload — the 2-arg one (:6). Two overloads = broken.
SELECT
    1310,
    '=== SECTION 13: MIGRATION VERDICTS ===',
    'join RPC overload state (fix-group-invite-join-rpc)  [supporting]',
    CASE
      WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='join_group_by_code') = 0
        THEN '!! join_group_by_code MISSING — joining a group by code is impossible'
      WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname='join_group_by_code') > 1
        THEN '!! AMBIGUOUS — 2 overloads live; PostgREST returns HTTP 300 on every join'
      WHEN to_regprocedure('public.join_group_by_code(text,text)') IS NOT NULL
        THEN 'OK — single 2-arg hardened overload'
      ELSE '!! only the legacy 1-arg overload exists (prelaunch-hardening version)'
    END,
    COALESCE((SELECT string_agg('(' || pg_get_function_identity_arguments(p.oid) || ') -> '
                                || pg_get_function_result(p.oid), ' ; ')
                FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='join_group_by_code'), '(none)')

) AS v
ORDER BY sort_key, check_name;
