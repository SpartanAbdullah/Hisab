-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Safe account deletion for SHARED groups  (audit 2026-09 item C2)
-- ----------------------------------------------------------------------------
-- Apply in the Supabase SQL Editor AFTER:
--   supabase-migration-p0-launch-blockers.sql
--   supabase-migration-safe-leave-group.sql
--   supabase-migration-enforce-active-group-transaction-members.sql
-- Idempotent: safe to re-run (every ALTER is guarded, every function is
-- CREATE OR REPLACE, every trigger is DROP IF EXISTS + CREATE).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS BROKEN
-- ─────────────────────────────────────────────────────────────────────────────
-- `public.delete_current_user()` (supabase-migration-p0-launch-blockers.sql:129)
-- is a bare `DELETE FROM auth.users` that trusts foreign-key cascades. Three of
-- those cascades destroy OTHER users' money records:
--
--   * group_expenses.user_id   REFERENCES auth.users ON DELETE CASCADE
--                              (supabase-schema.sql:212)
--   * group_settlements.user_id REFERENCES auth.users ON DELETE CASCADE
--                              (supabase-schema.sql:237)
--   * split_groups.user_id     REFERENCES auth.users ON DELETE CASCADE
--                              (supabase-schema.sql:194)
--
-- Consequence today:
--   (a) A member who deletes their account HARD-DELETES every expense and
--       settlement they authored inside groups other people still use. Those
--       rows are the inputs to every other member's balance
--       (supabase-migration-safe-leave-group.sql:110-136 derives balances from
--       exactly these two tables), so everyone else's ledger is silently
--       rewritten. No tombstone (the app's own `deleted_at` soft-delete
--       machinery is bypassed), no group event, no notification.
--   (b) A group OWNER who deletes their account cascades the whole
--       `split_groups` row away — the entire group, its members, invites,
--       events, and every other member's expenses vanish.
--   (c) The RPC's own comment (p0-launch-blockers.sql:125-128) claims shared
--       references are "anonymized via SET NULL". Only the audit columns
--       (created_by / updated_by / deleted_by / reconciled_by /
--       group_members.profile_id / group_events.actor_profile_id) are SET NULL.
--       The PRIMARY rows are destroyed.
--
-- Contrast: `public.leave_group()` refuses to let a member leave with a
-- non-zero balance or an unreconciled expense. Account deletion performs the
-- same exit with zero checks and takes the records with it.
--
-- Audit references: docs/audit-2026-09/03-performance.md § C1 (CONFIRMED,
-- critical) and docs/audit-2026-09/04-supabase.md § F-RLS11.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- MECHANISM CHOSEN, AND WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. group_expenses.user_id / group_settlements.user_id
--    → column made NULLABLE, FK switched from ON DELETE CASCADE to
--      ON DELETE SET NULL.
--    The row survives; only the authorship pointer is severed. This is chosen
--    over the alternatives because:
--      * Soft-delete (setting `deleted_at`) would REMOVE the amounts from every
--        balance calculation — every read path filters `deleted_at IS NULL`
--        (supabaseDb.ts getAllVisible / getByGroup / getAllVisibleForBalances,
--        leave_group's balance CTE) — i.e. it would corrupt other members'
--        balances just as badly as the cascade does, only more quietly.
--      * Reassignment to a placeholder auth user would require minting a real
--        `auth.users` row (a fake account, with a login surface) and would
--        misattribute authorship.
--      * SET NULL costs nothing at read time: the CLIENT NEVER READS user_id on
--        these two tables. `mapGroupExpense` (src/lib/supabaseDb.ts:1567) and
--        `mapGroupSettlement` (:1586) do not project it; display attribution
--        comes from `paid_by` / `from_member` / `to_member`, which point at
--        `group_members.id` — and that row survives (see table analysis below).
--        So the ledger stays complete AND stays readable.
--    NULL is fail-closed everywhere it matters: every policy that references
--    these columns compares `auth.uid() = user_id`, which yields NULL (not
--    TRUE) for an anonymized row, so nobody inherits write/delete rights over
--    a departed member's records. Full policy-by-policy audit below.
--
-- 2. split_groups.user_id — FK deliberately LEFT AS CASCADE.
--    Instead, `delete_current_user()` now REFUSES to run (stable error
--    `OWNED_GROUPS_WITH_MEMBERS`) when the caller owns any group that still has
--    another connected participant, and explicitly deletes only the caller's
--    SOLO groups before touching auth.users. Rationale:
--      * Auto-transferring ownership to "the oldest connected member" (the
--        audit's alternative suggestion) hands a second user unilateral
--        group-delete power (`splitGroupsDb.remove`, supabaseDb.ts:912) without
--        that user ever consenting to become owner. Silent privilege grants in
--        a money app are their own incident class.
--      * Orphaning the group (user_id NULL) would break `split_groups`' own
--        FOR ALL ownership policy for EVERY member, freezing the group's name,
--        join code and settled flag forever with no admin.
--      * A hard stop is honest, reversible, and matches the shape of
--        `leave_group`'s existing ONLY_OWNER_ADMIN refusal
--        (safe-leave-group.sql:100-106). §5 below ships the missing
--        `transfer_group_ownership()` RPC so the stop is actionable rather
--        than a dead end.
--    Solo groups (no other connected participant) keep the existing behaviour:
--    a full hard delete, which is correct — nobody else can see those rows.
--
-- 3. A `member_account_deleted` group_event is written into every affected
--    shared group so the remaining members see WHY attribution changed, and the
--    departing member's `group_members` row is soft-deactivated to `status =
--    'left'` (the same terminal state `leave_group` uses).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PER-TABLE CASCADE ANALYSIS  (does this table suffer the same cross-user
-- destruction? — investigated as required, conclusion stated for each)
-- ─────────────────────────────────────────────────────────────────────────────
--   group_expenses.user_id      CASCADE → YES, destroys other members' ledger.
--                               FIXED here (nullable + SET NULL).
--   group_settlements.user_id   CASCADE → YES, same. FIXED here.
--   split_groups.user_id        CASCADE → YES (destroys the whole group).
--                               FIXED here by refusing deletion instead of
--                               changing the FK; see rationale above.
--   group_members.profile_id    ALREADY `ON DELETE SET NULL`
--                               (supabase-schema.sql:319) → NO destruction: the
--                               member row survives, so `paid_by` /
--                               `from_member` / `to_member` / split JSON member
--                               ids never dangle and the display name stays
--                               readable. NO FK CHANGE NEEDED. This migration
--                               still touches the row for a different reason:
--                               it sets `status = 'left'` alongside the NULL,
--                               because a `connected` row with a NULL
--                               profile_id is claimable by any other user with
--                               a matching display name
--                               (`claimPaidByMemberIfMine`, splitStore.ts:160-177
--                               requires `status === 'connected'`) — i.e. a
--                               ghost-identity takeover of a deleted user's
--                               history. `status='left'` closes that, and also
--                               stops the row counting toward the
--                               "≥2 connected members" gate that
--                               enforce-active-group-transaction-members
--                               applies to NEW expenses.
--   group_events.actor_profile_id  ALREADY `ON DELETE SET NULL`
--                               (supabase-schema.sql:432) → NO destruction; the
--                               authored history survives anonymized. NO CHANGE.
--   group_invites.created_by    CASCADE, NOT NULL (supabase-schema.sql:390) →
--                               destroys the deleting user's invites. NOT a
--                               cross-user money record: an invite is a bearer
--                               credential, only a group OWNER may create one
--                               ("Group owners can create invites",
--                               schema:415), and an owner with other members
--                               can no longer delete their account at all.
--                               Destroying a deleted user's outstanding invite
--                               tokens is the SAFE outcome. NO CHANGE.
--   group_expenses / group_settlements audit columns (created_by, updated_by,
--                               deleted_by, reconciled_by) — already SET NULL
--                               (schema:304-314, reconciliation.sql). NO CHANGE.
--   persons.user_id             CASCADE → correct: `persons` is a PRIVATE
--                               per-user contact list (RLS `user_id =
--                               auth.uid()`, phase1-persons.sql:22-36). Nobody
--                               else can read those rows, so deleting them
--                               destroys nothing shared.
--   persons.linked_profile_id   ALREADY `ON DELETE SET NULL` → the COUNTERPARTY's
--                               contact row survives with the link severed
--                               (phase2a-linked-profile.sql:11-15). This is the
--                               correct cross-user behaviour already. NO CHANGE.
--   linked_transaction_requests / linked_settlement_requests /
--   contact_link_requests (from_user_id, to_user_id both CASCADE) →
--                               the handshake rows vanish from the
--                               counterparty's inbox/history. Deliberately NOT
--                               changed: these rows are request envelopes that
--                               EMBED the deleted user's identity, while the
--                               money they produced on acceptance lives in the
--                               counterparty's OWN `loans` / `transactions`
--                               rows (user_id-scoped) and is untouched. No
--                               balance is rewritten. Erasing the envelopes is
--                               required by the permanent-deletion promise.
--   notifications               user_id CASCADE (own rows), group_id / event_id
--                               CASCADE from surviving parents. NO cross-user
--                               loss. NO CHANGE.
--   accounts / transactions / loans / emi_schedules / goals /
--   upcoming_expenses / budgets / recurring_transactions / committees* /
--   investment_* / custom_categories
--                               all single-user, owner-only RLS. CASCADE is
--                               correct. NO CHANGE.
--   join_code_attempts          no FK at all (p0:200-204); rows outlive the
--                               account. Out of scope here — tracked as audit
--                               M16 (a separate one-line fix).
--   storage.objects (receipts bucket) — not touched by delete_current_user;
--                               out of scope here, tracked as audit F-ST1.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EVERY POLICY / TRIGGER / RPC RE-READ AND VERIFIED TO TOLERATE user_id = NULL
-- ─────────────────────────────────────────────────────────────────────────────
-- Sources read: supabase-schema.sql, supabase-migration-prelaunch-hardening.sql,
-- supabase-migration-p0-launch-blockers.sql, supabase-migration-fix-rls-recursion.sql,
-- supabase-migration-safe-leave-group.sql,
-- supabase-migration-enforce-active-group-transaction-members.sql,
-- supabase-migration-reconciliation.sql,
-- supabase-migration-fix-group-expense-reconciliation-rpc.sql,
-- supabase-migration-group-codes.sql, supabase-migration-join-by-code-rpc.sql,
-- supabase-migration-fix-group-invite-join-rpc.sql,
-- supabase-migration-performance-indexes.sql, supabase-migration-realtime.sql,
-- supabase-migration-linked-notifications-realtime.sql,
-- supabase-migration-incremental-sync-core.sql / -tombstones.sql.
--
-- POLICIES that reference group_expenses.user_id:
--   1. "Members can view shared group expenses" (SELECT, schema:502 /
--      fix-rls-recursion / prelaunch §8)
--        USING (auth.uid() = user_id OR is_group_member(group_id, auth.uid()))
--        → NULL OR TRUE = TRUE for a fellow member (row stays visible ✓);
--          NULL OR FALSE = NULL for a stranger (still denied ✓).
--   2. "Connected members can create shared group expenses" (INSERT,
--      schema:509 / fix-rls-recursion)
--        WITH CHECK (auth.uid() = user_id AND is_group_member(...))
--        → a client-supplied NULL user_id yields NULL, not TRUE → rejected.
--          Fail-closed ✓ (and §2 below adds a belt-and-braces trigger).
--   3. "Expense creators can update their shared group expenses" (UPDATE,
--      schema:516, tightened prelaunch:67-71)
--        USING/WITH CHECK (auth.uid() = user_id) → NULL → nobody can edit an
--        anonymized row. Intended: departed members' history is frozen ✓.
--   4. "Expense creators can delete their shared group expenses" (DELETE,
--      schema:520) → NULL → nobody can hard-delete it ✓ (this is the point).
--   5. "Users can manage own group expenses" (legacy FOR ALL, schema:230,
--      DROPped at prelaunch:63). If a drifted DB still has it: USING
--      (auth.uid() = user_id) → NULL grants nothing. Harmless ✓.
--   6. "Active profiles only" RESTRICTIVE (p0:74-96) — predicates on the
--      CALLER's profile, never on the row's user_id. Unaffected ✓.
--
-- POLICIES that reference group_settlements.user_id:
--   7. "Users can manage own settlements" (FOR ALL, schema:249 / prelaunch:59)
--        USING/WITH CHECK (auth.uid() = user_id) → NULL grants nothing; SELECT
--        still resolves through policy 8 because permissive policies OR ✓.
--   8. "Members can view shared group settlements" (SELECT, schema:524 /
--      fix-rls-recursion) — same NULL-OR-TRUE analysis as policy 1 ✓.
--   9. "Connected members can create shared group settlements" (INSERT,
--      schema:531 / fix-rls-recursion) — fail-closed on NULL, as policy 2 ✓.
--  10. "Connected members can delete shared group settlements" (DELETE,
--      prelaunch:307) USING (auth.uid() = user_id) → NULL → frozen ✓.
--  11. "Active profiles only" RESTRICTIVE — caller-scoped, unaffected ✓.
--
-- POLICIES on the surrounding group tables (checked; none reads these two
-- user_id columns, so all are unaffected — listed for completeness):
--  12. split_groups "Users can manage own groups" (FOR ALL, prelaunch:55) and
--      "Members can view shared groups" (SELECT, schema:495 / fix-rls-recursion).
--  13. group_members "Users can view members of shared groups" (SELECT,
--      schema:352 / fix-rls-recursion), "Group owners can add members"
--      (INSERT, p0:152), "Group owners can update members" (UPDATE, p0:165),
--      "Owner can remove group members" (DELETE, prelaunch:285 — DROPped by
--      safe-leave-group:16-17, so there is intentionally no DELETE path).
--      Note: these read profile_id, which is already nullable; a NULL
--      profile_id simply matches nobody ✓.
--  14. group_events "Connected members can view group events" (SELECT),
--      "Connected members can create group events" (INSERT, schema:444-453 /
--      fix-rls-recursion), "Members can delete own group events" (DELETE,
--      prelaunch:302) — all keyed on actor_profile_id / is_group_member ✓.
--  15. group_invites SELECT (schema:403 / fix-rls-recursion), INSERT
--      (schema:415), "Group owners can update invites" (p0:182), "Owner can
--      revoke invites" (DELETE, prelaunch:297) ✓.
--  16. notifications SELECT/UPDATE/DELETE/INSERT (schema:470-493) ✓.
--
-- TRIGGERS that fire when the FK performs its SET NULL update (an RI SET NULL
-- IS a real UPDATE, so BEFORE UPDATE triggers do fire — each was re-read to
-- confirm it no-ops on a user_id-only change):
--  17. `group_expenses_require_connected_members`
--      (enforce-active-group-transaction-members.sql:66) — body is gated on
--      `TG_OP='INSERT' OR NEW.group_id/paid_by/splits IS DISTINCT FROM OLD.*`.
--      A user_id-only update matches none of those → skips entirely ✓.
--      (Critical: had it not been gated, the SET NULL would ABORT account
--      deletion for any group whose other members had since left.)
--  18. `trg_group_expenses_reconciliation_payer`
--      (reconciliation.sql) — gated on is_reconciled / reconciled_at /
--      reconciled_by changing. user_id-only update → skips ✓.
--  19. `group_settlements_require_connected_members`
--      (enforce-active-group-transaction-members.sql:106) — gated on
--      group_id / from_member / to_member changing → skips ✓.
--  20. `group_members_protect_membership_fields` (safe-leave-group.sql:46)
--      WOULD raise 42501 on `OLD.status='connected' AND NEW.profile_id IS
--      DISTINCT FROM OLD.profile_id` — but only when
--      `current_user IN ('authenticated','anon')`. Both the FK's own SET NULL
--      action and this migration's explicit UPDATE run inside SECURITY DEFINER
--      / RI context as the table owner, so the guard is not triggered ✓.
--  21. `profiles_protect_security_fields` (p0:52) — profiles only; the RPC's
--      `is_deleted` write already runs as definer today ✓.
--  22. No `updated_at` touch trigger exists on group_expenses /
--      group_settlements (incremental-sync-core.sql covers only accounts,
--      transactions, loans, budgets), so the SET NULL cannot ripple into the
--      incremental-sync cursor ✓.
--
-- RPCs / FUNCTIONS re-read for NULL tolerance:
--  23. `leave_group(TEXT)` (safe-leave-group.sql:55) — its balance CTE
--      (:110-136) keys on `paid_by`, splits member ids, `from_member`,
--      `to_member` and `deleted_at`; it NEVER reads user_id. An anonymized row
--      therefore still counts in everyone's balance, which is exactly the
--      behaviour C1 asks for ✓.
--  24. `reconcile_group_expense(TEXT, BOOLEAN)`
--      (fix-group-expense-reconciliation-rpc.sql) — authorizes on
--      `group_members.profile_id` of the `paid_by` member, not user_id. For a
--      departed member's expense that lookup returns NULL/none, so
--      `IS DISTINCT FROM v_uid` is TRUE and the RPC refuses — nobody can
--      reconcile a ghost's expense. Verified this cannot wedge anyone else:
--      leave_group's unreconciled gate (:159-164) only inspects the CALLER's
--      own `paid_by` rows ✓.
--  25. `enforce_group_expense_reconciliation_payer()` (reconciliation.sql) —
--      same profile_id-based rule ✓.
--  26. `is_group_member(TEXT, UUID)` (schema:335 / fix-rls-recursion) — reads
--      group_members.profile_id only; `is_group_member(g, NULL)` is FALSE ✓.
--  27. `is_current_profile_active()` (p0:15) — caller-scoped ✓.
--  28. `join_group_by_code(TEXT, TEXT)` (p0:223) and the superseded
--      `join_group_by_code(TEXT)` (prelaunch:350) — read split_groups.user_id
--      and group_members only ✓.
--  29. `accept_group_invite(TEXT, TEXT)` (p0:298) — group_invites +
--      group_members only ✓.
--  30. `lookup_profile_by_code(TEXT)` (p0:369) — profiles only ✓.
--  31. `apply_account_balance_delta(...)` (prelaunch:245) — accounts only,
--      untouched by this migration ✓.
--  32. `soft_delete_current_user()` (prelaunch:169) — already DROPped at
--      p0:138. Note for the record: it contained the SAME bug in explicit form
--      (`DELETE FROM group_expenses WHERE user_id = uid`, prelaunch:187-188).
--      This migration re-asserts the DROP so a drifted DB cannot resurrect it.
--
-- CLIENT read paths confirmed not to project these columns:
--   src/lib/supabaseDb.ts:1567 mapGroupExpense, :1586 mapGroupSettlement,
--   :getAllVisibleForBalances (both tables) — none select or read `user_id`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- KNOWN RESIDUAL RISKS — deliberately NOT changed here; each needs its own
-- product decision. Do not treat account deletion as fully closed until these
-- are triaged.
-- ─────────────────────────────────────────────────────────────────────────────
--   R1. (REPRODUCED — see the validation note below.) A member may still delete
--       their account while carrying a non-zero group balance, which
--       `leave_group` would have refused. Their debt is
--       now preserved (that is the fix) but becomes unsettleable: a new
--       settlement requires BOTH parties to be connected members
--       (enforce-active-group-transaction-members.sql:84-99), and the departed
--       member is now 'left'. The counterparty's own net therefore stays ≠ 0
--       forever, which in turn blocks THEM from using leave_group (:142-155).
--       Options for the follow-up: a write-off / "absorb the departed member's
--       balance" RPC that redistributes the residue across the remaining
--       members with a group_event, or a balance pre-check in
--       delete_current_user mirroring leave_group's. This migration
--       intentionally does not choose, because refusing deletion on an
--       outstanding balance also conflicts with the app's permanent-deletion
--       promise.
--   R2. The SAME cross-user destruction is still reachable through a different
--       door: a group owner can hard-DELETE a shared split_groups row straight
--       from the client (`splitGroupsDb.remove`, src/lib/supabaseDb.ts:912,
--       permitted by the "Users can manage own groups" FOR ALL policy), which
--       cascades away every other member's expenses with no checks at all.
--       Closing that needs a BEFORE DELETE guard on split_groups plus a client
--       story for shared-group teardown, so it is out of scope for C2 and is
--       filed as its own item.
--   R3. `group_members.display_name` is deliberately PRESERVED on the departed
--       member's row: it is what makes the retained ledger readable ("Ali paid
--       500"), and it is data the other members see and rely on. The row no
--       longer links to any account (profile_id NULL, profiles.name blanked,
--       auth identity gone). Confirm this reading against the published privacy
--       policy before launch.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- VALIDATION — this migration was executed, not just written.
-- ─────────────────────────────────────────────────────────────────────────────
-- A throwaway Postgres 15 was loaded with supabase-schema.sql + reconciliation
-- + fix-rls-recursion + phase1-persons + phase2a-linked-profile +
-- prelaunch-hardening + p0-launch-blockers + safe-leave-group +
-- enforce-active-group-transaction-members +
-- fix-group-expense-reconciliation-rpc (all applied clean), with an auth.uid()
-- shim and real `authenticated` role sessions. Results:
--   BASELINE (before this migration): a member's account deletion took the
--     shared group from 2 expenses → 1 and 1 settlement → 0. C1 reproduced.
--   AFTER: the member's expense AND settlement survive with user_id NULL; the
--     group_event is written with expensesRetained/settlementsRetained = 1/1;
--     group_members goes to status='left', profile_id NULL; the member's SOLO
--     group is still hard-deleted; the owner's deletion raises
--     OWNED_GROUPS_WITH_MEMBERS with DETAIL='Dubai Trip'.
--   RLS as the surviving member (role `authenticated`): the anonymized rows are
--     still SELECTable, while UPDATE / DELETE both affect 0 rows. An INSERT
--     with a NULL user_id is rejected by §2.
--   BALANCE PROOF: with a departed member's 300 AED expense retained,
--     leave_group still returns OUTSTANDING_PAYABLE 300.00 for the member who
--     owes it — on the old schema that debt silently disappeared. The same run
--     confirms R1: the follow-up settlement is refused by
--     tg_group_settlements_require_connected_members, so the debt is currently
--     unsettleable.
--   transfer_group_ownership: self-transfer refused (INVALID_NEW_OWNER),
--     transfer to a connected member succeeds, roles swap, and the ex-owner can
--     then delete their account with the whole group left intact.
--   IDEMPOTENCY: applied three times in a row, no errors.
--
-- INTERACTION WITH supabase-migration-audit-p0-group-ledger-integrity.sql
-- (the other pending audit migration on these same two tables) — VERIFIED:
--   That migration replaces the per-command policies (all still
--   `auth.uid() = user_id` shaped, so the NULL analysis above holds unchanged —
--   it also removes both DELETE policies entirely, which only makes an
--   anonymized row MORE frozen) and upgrades
--   tg_group_expenses_require_connected_members /
--   tg_group_settlements_require_connected_members with an
--   "authorship cannot be reassigned" rule (`NEW.user_id IS DISTINCT FROM
--   OLD.user_id` → 42501). This FK's ON DELETE SET NULL *is* a user_id change,
--   so that rule would abort account deletion — except both new triggers gate
--   the rule on `current_user IN ('authenticated','anon')`, and neither the RI
--   SET NULL action nor a SECURITY DEFINER RPC body runs under those roles.
--   Proven, not assumed: the full stack (schema + 9 prior migrations +
--   group-ledger-integrity + this file) was loaded and delete_current_user()
--   was invoked from a genuine `SET ROLE authenticated` session — it succeeded,
--   the expense and settlement survived anonymized, the membership went to
--   'left' and the group_event was written. The two migrations touch disjoint
--   objects (policies/triggers vs. FKs/columns/functions), so either apply
--   order is safe.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. Preserve shared-group history: nullable authorship + SET NULL FKs
-- Locates the existing auth.users foreign key by catalog lookup (the schema
-- created it inline, so the name is server-generated) and only rewrites it when
-- it is not already ON DELETE SET NULL. Re-running is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_table   TEXT;
  v_conname TEXT;
  v_deltype "char";
BEGIN
  FOREACH v_table IN ARRAY ARRAY['group_expenses', 'group_settlements']
  LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE NOTICE 'Skipping %: table not present', v_table;
      CONTINUE;
    END IF;

    -- 1a. The column must be nullable before SET NULL can ever fire.
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id DROP NOT NULL', v_table);

    -- 1b. Find the single-column FK on user_id that points at auth.users.
    SELECT c.conname, c.confdeltype
      INTO v_conname, v_deltype
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = c.conkey[1]
     WHERE c.conrelid = ('public.' || v_table)::regclass
       AND c.contype = 'f'
       AND c.confrelid = 'auth.users'::regclass
       AND array_length(c.conkey, 1) = 1
       AND a.attname = 'user_id'
     LIMIT 1;

    IF v_conname IS NULL THEN
      RAISE NOTICE '%.user_id has no FK to auth.users — creating one with ON DELETE SET NULL', v_table;
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL',
        v_table, v_table || '_user_id_fkey'
      );
    ELSIF v_deltype = 'n' THEN
      RAISE NOTICE '%.% is already ON DELETE SET NULL — nothing to do', v_table, v_conname;
    ELSE
      RAISE NOTICE 'Rewriting %.% (confdeltype=%) to ON DELETE SET NULL', v_table, v_conname, v_deltype;
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_conname);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL',
        v_table, v_conname
      );
    END IF;

    v_conname := NULL;
    v_deltype := NULL;
  END LOOP;
END;
$$;

COMMENT ON COLUMN public.group_expenses.user_id IS
  'Author of the expense. NULLABLE by design: when the author deletes their Hisaab account the FK sets this to NULL so the shared record survives, anonymized, for the other members whose balances depend on it. A NULL here means "author account deleted" — every write policy compares auth.uid() = user_id, so a NULL row is frozen (readable by group members, editable/deletable by nobody).';

COMMENT ON COLUMN public.group_settlements.user_id IS
  'Author of the settlement. NULLABLE by design — see the comment on group_expenses.user_id.';

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. NULL authorship may only ever arrive via the FK, never a client
-- The RLS INSERT checks already fail closed on a NULL user_id (NULL AND … is
-- not TRUE), but that is an implicit guarantee spread over several policies.
-- This makes it explicit and loud. RI SET NULL is an UPDATE, so it does not
-- fire these BEFORE INSERT triggers.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_require_authorship_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'MISSING_AUTHORSHIP: %.user_id may not be NULL on insert', TG_TABLE_NAME
      USING ERRCODE = '23502';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_require_authorship_on_insert() IS
  'Rejects rows inserted without an author. NULL user_id is reserved for the ON DELETE SET NULL anonymization applied when an author deletes their account.';

DROP TRIGGER IF EXISTS group_expenses_require_authorship ON public.group_expenses;
CREATE TRIGGER group_expenses_require_authorship
  BEFORE INSERT ON public.group_expenses
  FOR EACH ROW EXECUTE FUNCTION public.tg_require_authorship_on_insert();

DROP TRIGGER IF EXISTS group_settlements_require_authorship ON public.group_settlements;
CREATE TRIGGER group_settlements_require_authorship
  BEFORE INSERT ON public.group_settlements
  FOR EACH ROW EXECUTE FUNCTION public.tg_require_authorship_on_insert();

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Shared-group predicate
-- "Does this group still have a participant other than p_uid?" — a participant
-- is a connected member linked to a real profile, OR the group owner. The owner
-- fallback matters because a drifted/legacy group may have no group_members row
-- for its owner; without it such a group would be misread as solo and hard
-- deleted.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.group_has_other_connected_members(
  p_group_id TEXT,
  p_uid UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.status = 'connected'
       AND gm.profile_id IS NOT NULL
       AND gm.profile_id <> p_uid
  ) OR EXISTS (
    SELECT 1
      FROM public.split_groups g
     WHERE g.id = p_group_id
       AND g.user_id IS NOT NULL
       AND g.user_id <> p_uid
  );
$$;

COMMENT ON FUNCTION public.group_has_other_connected_members(TEXT, UUID) IS
  'TRUE when a group still has a real participant other than p_uid (a connected, profile-linked member, or a different owner). Used to tell a shared group from a solo one during account deletion.';

REVOKE ALL ON FUNCTION public.group_has_other_connected_members(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.group_has_other_connected_members(TEXT, UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. delete_current_user — refuse on owned shared groups, announce the
-- departure in the groups the user leaves behind, then delete.
-- Replaces supabase-migration-p0-launch-blockers.sql:102-134.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.delete_current_user()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_blocking      TEXT;
  v_still_owned   INTEGER;
  v_member        RECORD;
  v_expenses      INTEGER;
  v_settlements   INTEGER;
  v_display       TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- ── 4a. Owner guard ──────────────────────────────────────────────────────
  -- split_groups.user_id is still ON DELETE CASCADE, and that cascade would
  -- take the group, its members, invites, events, and EVERY member's expenses
  -- with it. Refuse instead, naming the groups so the client can tell the user
  -- exactly what to transfer or wind down first.
  SELECT string_agg(g.name, ', ' ORDER BY g.name)
    INTO v_blocking
    FROM public.split_groups g
   WHERE g.user_id = v_uid
     AND public.group_has_other_connected_members(g.id, v_uid);

  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION 'OWNED_GROUPS_WITH_MEMBERS'
      USING ERRCODE = 'P0001',
            DETAIL  = v_blocking,
            HINT    = 'Transfer ownership of these groups (public.transfer_group_ownership) or settle and remove the other members before deleting your account.';
  END IF;

  -- ── 4b. Announce the departure in every shared group the user participates
  -- in, and soft-deactivate their membership. Runs BEFORE the auth.users delete
  -- so the group_members row is still resolvable. actor_profile_id is written
  -- as NULL on purpose: the actor is about to cease to exist, and the FK would
  -- null it moments later anyway.
  FOR v_member IN
    SELECT gm.id AS member_id, gm.group_id, gm.display_name
      FROM public.group_members gm
     WHERE gm.profile_id = v_uid
       AND public.group_has_other_connected_members(gm.group_id, v_uid)
  LOOP
    SELECT count(*) INTO v_expenses
      FROM public.group_expenses e
     WHERE e.group_id = v_member.group_id
       AND e.user_id = v_uid
       AND e.deleted_at IS NULL;

    SELECT count(*) INTO v_settlements
      FROM public.group_settlements s
     WHERE s.group_id = v_member.group_id
       AND s.user_id = v_uid
       AND s.deleted_at IS NULL;

    v_display := COALESCE(NULLIF(trim(v_member.display_name), ''), 'A member');

    INSERT INTO public.group_events (
      id, group_id, actor_profile_id, event_type, entity_type, entity_id,
      summary, payload
    ) VALUES (
      gen_random_uuid()::text,
      v_member.group_id,
      NULL,
      'member_account_deleted',
      'member',
      v_member.member_id,
      v_display || ' deleted their Hisaab account. Their past expenses and settlements stay in this group, without a linked account.',
      jsonb_build_object(
        'memberId',            v_member.member_id,
        'displayName',         v_display,
        'expensesRetained',    v_expenses,
        'settlementsRetained', v_settlements,
        'deletedAt',           now()
      )
    );

    -- Soft-deactivate: 'left' is the same terminal state leave_group uses.
    -- Nulling profile_id here (rather than leaving it to the FK) keeps the two
    -- writes in one statement and, critically, prevents a `connected` row with
    -- a NULL profile from being claimed by another user with the same display
    -- name (claimPaidByMemberIfMine, src/stores/splitStore.ts:160-177).
    -- Runs as the function owner, so group_members_protect_membership_fields
    -- (safe-leave-group.sql:46) does not fire its authenticated-only guard.
    UPDATE public.group_members
       SET status     = 'left',
           profile_id = NULL
     WHERE id = v_member.member_id;
  END LOOP;

  -- ── 4c. Solo groups: delete explicitly, so the only thing left for the
  -- auth.users cascade to reach is nothing. Re-verified below.
  DELETE FROM public.split_groups g
   WHERE g.user_id = v_uid
     AND NOT public.group_has_other_connected_members(g.id, v_uid);

  SELECT count(*) INTO v_still_owned
    FROM public.split_groups g
   WHERE g.user_id = v_uid;

  IF v_still_owned > 0 THEN
    -- Only reachable if someone joined one of these groups between 4a and now.
    RAISE EXCEPTION 'OWNED_GROUPS_WITH_MEMBERS'
      USING ERRCODE = 'P0001',
            DETAIL  = 'A member joined one of your groups while the deletion was running.',
            HINT    = 'Please try again.';
  END IF;

  -- ── 4d. Mark the profile first so concurrent policy checks stop admitting
  -- new work. The profile row itself is then removed by the auth.users cascade.
  UPDATE public.profiles
     SET is_deleted = true,
         deleted_at = now(),
         name = '',
         public_code = NULL,
         public_code_normalized = NULL
   WHERE id = v_uid;

  -- ── 4e. Permanently remove the auth identity.
  -- Cascades now reach only rows that are private to this user. The two shared
  -- ledgers (group_expenses, group_settlements) are SET NULL by §1, so their
  -- rows survive anonymized for the members who still depend on them.
  DELETE FROM auth.users WHERE id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Auth user not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.delete_current_user() IS
  'Permanent account deletion. Refuses with OWNED_GROUPS_WITH_MEMBERS (DETAIL = comma-separated group names) when the caller owns a group that still has other participants. Otherwise: emits a member_account_deleted group_event and marks the membership left in every shared group, hard-deletes solo groups, then deletes the auth identity. Shared group_expenses / group_settlements survive with user_id SET NULL.';

REVOKE ALL ON FUNCTION public.delete_current_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_current_user() TO authenticated;

-- Re-assert the p0 drop: the pre-p0 implementation hard-deleted shared group
-- rows explicitly (prelaunch-hardening.sql:187-188) and must not come back on a
-- drifted database.
DROP FUNCTION IF EXISTS public.soft_delete_current_user();

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. transfer_group_ownership — the escape hatch that makes
-- OWNED_GROUPS_WITH_MEMBERS actionable.
-- Owner-only. The new owner must already be a connected, profile-linked member,
-- so this can never hand a group to a stranger. No client UI calls this yet
-- (see the client follow-ups in the handover notes).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.transfer_group_ownership(
  p_group_id       TEXT,
  p_new_owner_member_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_group        public.split_groups%ROWTYPE;
  v_new_owner    public.group_members%ROWTYPE;
  v_old_member   public.group_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = p_group_id
   FOR UPDATE;

  IF v_group.id IS NULL OR v_group.user_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'NOT_GROUP_OWNER',
      'user_message', 'Only the group owner can transfer ownership.'
    );
  END IF;

  SELECT * INTO v_new_owner
    FROM public.group_members
   WHERE id = p_new_owner_member_id
     AND group_id = p_group_id
     AND status = 'connected'
     AND profile_id IS NOT NULL
     AND profile_id <> v_uid
   FOR UPDATE;

  IF v_new_owner.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason_code', 'INVALID_NEW_OWNER',
      'user_message', 'Pick a member who has joined this group on Hisaab.'
    );
  END IF;

  UPDATE public.split_groups
     SET user_id = v_new_owner.profile_id
   WHERE id = p_group_id;

  UPDATE public.group_members
     SET role = 'owner'
   WHERE id = v_new_owner.id;

  SELECT * INTO v_old_member
    FROM public.group_members
   WHERE group_id = p_group_id
     AND profile_id = v_uid
   LIMIT 1;

  IF v_old_member.id IS NOT NULL THEN
    UPDATE public.group_members
       SET role = 'member'
     WHERE id = v_old_member.id;
  END IF;

  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload
  ) VALUES (
    gen_random_uuid()::text,
    p_group_id,
    v_uid,
    'group_ownership_transferred',
    'group',
    p_group_id,
    'Group ownership moved to ' || COALESCE(NULLIF(trim(v_new_owner.display_name), ''), 'another member') || '.',
    jsonb_build_object(
      'newOwnerMemberId',  v_new_owner.id,
      'newOwnerProfileId', v_new_owner.profile_id,
      'previousOwnerMemberId', v_old_member.id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'reason_code', 'OWNERSHIP_TRANSFERRED',
    'user_message', 'Ownership transferred.',
    'new_owner_member_id', v_new_owner.id
  );
END;
$$;

COMMENT ON FUNCTION public.transfer_group_ownership(TEXT, TEXT) IS
  'Owner-only ownership transfer. The target must be a connected, profile-linked member of the same group. Moves split_groups.user_id, swaps the two owner/member roles, and logs a group_ownership_transferred event. Exists so delete_current_user''s OWNED_GROUPS_WITH_MEMBERS refusal has a resolution path.';

REVOKE ALL ON FUNCTION public.transfer_group_ownership(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_group_ownership(TEXT, TEXT) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6. Index for the anonymized-row sweeps used by support/verification.
-- Partial, so it costs nothing until an account is actually deleted.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_gexp_orphaned_author
  ON public.group_expenses (group_id)
  WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_gsett_orphaned_author
  ON public.group_settlements (group_id)
  WHERE user_id IS NULL;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION — read-only. Run after the migration; nothing below writes.
-- ════════════════════════════════════════════════════════════════════════════

-- V1. Both shared ledgers must now be ON DELETE SET NULL ('n'); split_groups
--     stays CASCADE ('c') by design (delete_current_user refuses instead).
--     EXPECT: group_expenses = n, group_settlements = n, split_groups = c.
SELECT c.conrelid::regclass::text AS table_name,
       c.conname                  AS constraint_name,
       CASE c.confdeltype WHEN 'c' THEN 'CASCADE'
                          WHEN 'n' THEN 'SET NULL'
                          WHEN 'a' THEN 'NO ACTION'
                          WHEN 'r' THEN 'RESTRICT'
                          ELSE c.confdeltype::text END AS on_delete
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
 WHERE c.contype = 'f'
   AND c.confrelid = 'auth.users'::regclass
   AND a.attname = 'user_id'
   AND c.conrelid IN ('public.group_expenses'::regclass,
                      'public.group_settlements'::regclass,
                      'public.split_groups'::regclass)
 ORDER BY 1;

-- V2. Authorship columns must be nullable. EXPECT: is_nullable = YES for both.
SELECT table_name, column_name, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND column_name = 'user_id'
   AND table_name IN ('group_expenses', 'group_settlements')
 ORDER BY 1;

-- V3. New objects must exist. EXPECT 5 rows.
SELECT p.proname AS function_name
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('delete_current_user',
                     'group_has_other_connected_members',
                     'transfer_group_ownership',
                     'tg_require_authorship_on_insert')
 ORDER BY 1;

SELECT tgname AS trigger_name, tgrelid::regclass::text AS on_table
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgname IN ('group_expenses_require_authorship',
                  'group_settlements_require_authorship')
 ORDER BY 1;

-- V4. The legacy hard-deleting RPC must be gone. EXPECT 0 rows.
SELECT p.proname
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'soft_delete_current_user';

-- V5. Which accounts would currently be BLOCKED from self-deletion, and why.
--     Support/comms use this before announcing the change to users.
SELECT g.user_id       AS owner_user_id,
       count(*)        AS blocking_group_count,
       string_agg(g.name, ', ' ORDER BY g.name) AS group_names
  FROM public.split_groups g
 WHERE public.group_has_other_connected_members(g.id, g.user_id)
 GROUP BY g.user_id
 ORDER BY 2 DESC;

-- V6. Shared records already preserved by an account deletion (anonymized
--     authorship). EXPECT 0 before the first post-migration deletion.
SELECT 'group_expenses' AS source, count(*) AS anonymized_rows
  FROM public.group_expenses WHERE user_id IS NULL
UNION ALL
SELECT 'group_settlements', count(*)
  FROM public.group_settlements WHERE user_id IS NULL;

-- V7. Departure announcements emitted so far, newest first.
SELECT e.group_id, e.entity_id AS member_id, e.summary, e.payload, e.created_at
  FROM public.group_events e
 WHERE e.event_type = 'member_account_deleted'
 ORDER BY e.created_at DESC
 LIMIT 50;

-- V8. Integrity sweep: no live shared expense/settlement may point at a
--     group_members row that does not exist. EXPECT 0 rows.
SELECT 'expense' AS kind, e.id, e.group_id, e.paid_by AS member_ref
  FROM public.group_expenses e
 WHERE e.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.group_members gm
                    WHERE gm.id = e.paid_by AND gm.group_id = e.group_id)
UNION ALL
SELECT 'settlement', s.id, s.group_id, s.from_member
  FROM public.group_settlements s
 WHERE s.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.group_members gm
                    WHERE gm.id = s.from_member AND gm.group_id = s.group_id)
UNION ALL
SELECT 'settlement', s.id, s.group_id, s.to_member
  FROM public.group_settlements s
 WHERE s.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.group_members gm
                    WHERE gm.id = s.to_member AND gm.group_id = s.group_id);
