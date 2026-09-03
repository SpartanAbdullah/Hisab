# Production schema verification — 2026-09-03

Evidence for audit item **C1** ("production schema state is unprovable"). Produced by running
`supabase-audit-p0-verification.sql` (one read-only SELECT over the catalogs) plus an object
inventory and Supabase's security/performance advisors against the production project
`nnhwxjrgxsefywalwvaq` ("Hisaab", ap-northeast-2, Postgres 17.6) through the Supabase MCP,
read-only, at 2026-09-03 05:48 UTC. `supabase_migrations.schema_migrations` is empty
(every file was applied by hand in Studio), so artifacts are the only evidence.

## Verdict

- **All 40 historical migrations (apply-order.txt §1) are applied**, cleanly: every Section 13
  verdict is YES, the legacy overloads are gone, `join_group_by_code` has the single 2-arg shape.
- **None of the branch batch (§2 audit-p0 through p3-invariant-monitoring, 31 files) is applied.**
  The object inventory has no `blocks`, `app_config`, `record_edits`, `reconciliation_*`,
  `khata_link_lookups`, guest-member, broadcast, or `atomic_*` artifacts.
- The rows flagged `!!` are exactly the audit's open P0 items that the branch files close:
  C4 (`group_settlements` FOR ALL authorship policy), C6 (`token_hash` readable by members),
  C7 (fellow-member `notifications` INSERT), C9 (AED/PKR-only currency CHECKs), and the
  dropped `lookup_profile_by_public_code` the deployed client still calls.
- `app_push_config` / `phone_lookup_attempts`: RLS on, zero policies — intentional (only
  SECURITY DEFINER code touches them).
- Security advisor: 0 ERROR, 56 WARN, 2 INFO. The WARNs are 19 SECURITY DEFINER functions
  executable by `anon`, 31 by `authenticated` (including trigger/internal functions),
  5 functions with a mutable `search_path`, and "leaked password protection" disabled
  (dashboard toggle: Authentication → Providers → Email → *Prevent use of leaked passwords*).

## Raw digest (verification grid + security advisors)

```
VERIFICATION rows: 262
    1  === SECTION 00: RUN STAMP ===
   33  === SECTION 01: RLS FLAGS (all public tables) ===
   41  === SECTION 02: POLICIES (trust-boundary tables) ===
    7  === SECTION 03: CRITICAL POLICY VERDICTS ===
   38  === SECTION 04: FUNCTIONS PRESENT ===
    6  === SECTION 05: FUNCTIONS THAT MUST BE ABSENT ===
   23  === SECTION 06: CLIENT-CALLED RPC COVERAGE ===
   17  === SECTION 07: TRIGGERS ===
   12  === SECTION 07: TRIGGERS (expected roll-call) ===
    4  === SECTION 08: CURRENCY CHECK CONSTRAINTS ===
    9  === SECTION 09: REALTIME PUBLICATION ===
    4  === SECTION 09: REALTIME PUBLICATION (expected roll-call) ===
   24  === SECTION 10: TABLE EXISTENCE ===
   30  === SECTION 11: COLUMN EXISTENCE ===
    3  === SECTION 12: FOREIGN KEYS ===
   10  === SECTION 13: MIGRATION VERDICTS ===

--- RUN STAMP ---
postgres @ 2406:da12:b78:de13:cdee:ce2d:2e18:79bf/128 | 2026-09-03 05:48:04.441996+00

--- ROWS FLAGGED "!!" ---
[100] app_push_config
     !! RLS ENABLED but ZERO POLICIES (table is fully locked out)
     forced=false | policies=0
[100] phone_lookup_attempts
     !! RLS ENABLED but ZERO POLICIES (table is fully locked out)
     forced=false | policies=0
[301] 03.2 group_settlements — leftover FOR ALL authorship policy?
     !! PRESENT — audit C4 exploitable (ex-member ledger falsification)
     Users can manage own settlements => USING (auth.uid() = user_id)  ;  Active profiles only => USING ( SELECT is_current_profile_active() AS is_current_profile_active)
[305] 03.6 notifications INSERT — self-only or fellow-member?
     !! fellow-member INSERT allowed — C7 phishing surface open
     Users can insert notifications for self or fellow members => ((auth.uid() = user_id) OR ((group_id IS NOT NULL) AND is_group_member(group_id, auth.uid()) AND is_group_member(group_id, user_id))) ; Active profiles only => ( SELECT is_current_profile_active() AS is_current_profile_active)
[306] 03.7 group_invites SELECT — members can read token_hash?
     !! members can SELECT invites (token_hash readable) — C6 open
     token_hash SELECT grant to authenticated = true  ||  Group owners can create invites [INSERT] => (none) ; Members can view invites in their groups [SELECT] => ((created_by = auth.uid()) OR (accepted_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM split_groups g
  WHERE ((g.id = group_invites.group_id
[600] lookup_profile_by_public_code
     !! MISSING — client call fails (PGRST202)
     (not found)
[800] linked_settlement_requests :: linked_settlement_requests_currency_check
     !! NARROW — AED/PKR only (C9 open: 6 of 8 currencies error out)
     CHECK ((currency = ANY (ARRAY['AED'::text, 'PKR'::text])))
[800] linked_transaction_requests :: linked_transaction_requests_currency_check
     !! NARROW — AED/PKR only (C9 open: 6 of 8 currencies error out)
     CHECK ((currency = ANY (ARRAY['AED'::text, 'PKR'::text])))

--- SECTION 13 VERDICTS ---
p0-launch-blockers applied?
     YES — fully applied
     is_current_profile_active=true | ActiveProfilesOnly_tables=20 | owner_only_member_insert=true | soft_delete_removed=true | delete_current_user=true
prelaunch-hardening applied?
     YES — applied
     apply_account_balance_delta=true | fk_src=true | fk_dst=true | accounts.updated_at=true
connections-push-discovery applied?
     YES — applied
     lookup_hisaab_users_by_phone=true | device_push_tokens=true | app_push_config=true | contact_link_requests=true | phone_lookup_attempts=true | respond_contact_link=true | notifications_push_trigger=true
cross-user-account-effects applied?
     YES — applied cleanly
     ltr.requester_account_id=true | accept_linked_request(text,text)=true | accept_linked_request(text) leftover=false | accept_settlement_request(text,text)=true | accept_settlement_request(text) leftover=false
investments applied?
     YES — applied
     investment_markets=true | investment_trades=true | investment_prices=true | transactions.related_investment_id=true
settlement-emi (and account guards) applied?
     YES — the live RPC settles EMI instalments
     deleted_account_guard_present=true | signatures=(request_id text, responder_account_id text)
contacts-merge-unarchive applied?
     YES — applied
     merge_person=true | unarchive_contact=true | tg_block_archived_person_reference=true
safe-leave-group applied?  [supporting]
     YES — applied
     leave_group=true | protect_membership_trigger=true
enforce-active-group-transaction-members applied?  [supporting]
     YES — applied
     expenses_fn=true | settlements_fn=true
join RPC overload state (fix-group-invite-join-rpc)  [supporting]
     OK — single 2-arg hardened overload
     (p_code_normalized text, p_display_name text) -> TABLE(group_id text, member_id text, was_already_connected boolean)

--- SECTION 01 RLS (non-"RLS enabled") ---
app_push_config: !! RLS ENABLED but ZERO POLICIES (table is fully locked out) (forced=false | policies=0)
phone_lookup_attempts: !! RLS ENABLED but ZERO POLICIES (table is fully locked out) (forced=false | policies=0)

--- SECTION 04 functions: search_path NOT SET ---
tg_accounts_touch() | security invoker | returns trigger
tg_block_archived_person_reference() | security invoker | returns trigger
tg_persons_touch() | security invoker | returns trigger
tg_touch_updated_at() | security invoker | returns trigger

--- SECTION 08 currency constraints ---
linked_settlement_requests :: linked_settlement_requests_currency_check: !! NARROW — AED/PKR only (C9 open: 6 of 8 currencies error out)
linked_transaction_requests :: linked_transaction_requests_currency_check: !! NARROW — AED/PKR only (C9 open: 6 of 8 currencies error out)
linked_settlement_requests — any currency CHECK at all?: constraint exists (see rows above for its definition)
linked_transaction_requests — any currency CHECK at all?: constraint exists (see rows above for its definition)

--- SECTION 09 realtime publication ---
supabase_realtime :: public.accounts: in publication
supabase_realtime :: public.contact_link_requests: in publication
supabase_realtime :: public.group_members: in publication
supabase_realtime :: public.linked_settlement_requests: in publication
supabase_realtime :: public.linked_transaction_requests: in publication
supabase_realtime :: public.loans: in publication
supabase_realtime :: public.notifications: in publication
supabase_realtime :: public.persons: in publication
supabase_realtime :: public.transactions: in publication
group_members: in supabase_realtime
linked_settlement_requests: in supabase_realtime
linked_transaction_requests: in supabase_realtime
notifications: in supabase_realtime

=== SECURITY ADVISORS: 58 lints ===
    2  INFO rls_enabled_no_policy
   19  WARN anon_security_definer_function_executable
    1  WARN auth_leaked_password_protection
   31  WARN authenticated_security_definer_function_executable
    5  WARN function_search_path_mutable

--- ERROR-level details ---

--- WARN-level details (non search_path) ---
  anon_security_definer_function_executable: Function `public.cancel_linked_request(request_id text)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/cancel_linked_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.cancel_settlement_request(request_id text)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/cancel_settlement_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.create_settlement_request(request_id text, loan_pair_id text, requester_loan_id text, responder_loan_id text, to_user_id uuid, amount numeric, currency text, note text, requester_account_id text)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/create_settlement_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.enforce_group_expense_reconciliation_payer()` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/enforce_group_expense_reconciliation_payer`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.get_committee_witness(p_token text)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/get_committee_witness`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.handle_new_user()` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/handle_new_user`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.is_group_member(gid text, uid uuid)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/is_group_member`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.lookup_hisaab_users_by_phone(p_numbers text[])` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/lookup_hisaab_users_by_phone`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.notify_contact_linked(target_profile_id uuid)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/notify_contact_linked`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.register_push_token(p_token text, p_platform text)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/register_push_token`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.reject_linked_request(request_id text, reason text)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/reject_linked_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.reject_settlement_request(request_id text, reason text)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/reject_settlement_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.respond_contact_link(p_request_id text, p_accept boolean)` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/respond_contact_link`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.rls_auto_enable()` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/rls_auto_enable`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.tg_lsr_notify()` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_lsr_notify`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.tg_lsr_validate_insert()` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_lsr_validate_insert`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.tg_ltr_notify()` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_ltr_notify`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.tg_ltr_validate_insert()` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_ltr_validate_insert`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  anon_security_definer_function_executable: Function `public.tg_notifications_push()` can be executed by the `anon` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_notifications_push`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.accept_group_invite(p_invite_token_hash text, p_display_name text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/accept_group_invite`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.accept_linked_request(request_id text, responder_account_id text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/accept_linked_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.accept_settlement_request(request_id text, responder_account_id text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/accept_settlement_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.archive_contact_if_settled(p_contact_id text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/archive_contact_if_settled`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.cancel_linked_request(request_id text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/cancel_linked_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.cancel_settlement_request(request_id text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/cancel_settlement_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.create_settlement_request(request_id text, loan_pair_id text, requester_loan_id text, responder_loan_id text, to_user_id uuid, amount numeric, currency text, note text, requester_account_id text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/create_settlement_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.delete_current_user()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/delete_current_user`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.enforce_group_expense_reconciliation_payer()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/enforce_group_expense_reconciliation_payer`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.get_committee_witness(p_token text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/get_committee_witness`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.handle_new_user()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/handle_new_user`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.is_current_profile_active()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/is_current_profile_active`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.is_group_member(gid text, uid uuid)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/is_group_member`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.join_group_by_code(p_code_normalized text, p_display_name text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/join_group_by_code`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.leave_group(p_group_id text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/leave_group`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.lookup_hisaab_users_by_phone(p_numbers text[])` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/lookup_hisaab_users_by_phone`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.lookup_profile_by_code(code text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/lookup_profile_by_code`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.merge_person(p_source_id text, p_target_id text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/merge_person`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.notify_contact_linked(target_profile_id uuid)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/notify_contact_linked`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.reconcile_group_expense(p_expense_id text, p_is_reconciled boolean)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/reconcile_group_expense`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.register_push_token(p_token text, p_platform text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/register_push_token`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.reject_linked_request(request_id text, reason text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/reject_linked_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.reject_settlement_request(request_id text, reason text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/reject_settlement_request`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.respond_contact_link(p_request_id text, p_accept boolean)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/respond_contact_link`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.rls_auto_enable()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/rls_auto_enable`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.tg_lsr_notify()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_lsr_notify`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.tg_lsr_validate_insert()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_lsr_validate_insert`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.tg_ltr_notify()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_ltr_notify`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.tg_ltr_validate_insert()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_ltr_validate_insert`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.tg_notifications_push()` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/tg_notifications_push`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  authenticated_security_definer_function_executable: Function `public.unarchive_contact(p_contact_id text)` can be executed by the `authenticated` role as a `SECURITY DEFINER` function via `/rest/v1/rpc/unarchive_contact`. Revoke `EXECUTE` or switch it to `SECURITY INVOKER` if that is not intentional.
  auth_leaked_password_protection: Supabase Auth prevents the use of compromised passwords by checking against HaveIBeenPwned.org. Enable this feature to enhance security.
```

## Raw digest (performance advisors)

```
PERFORMANCE ADVISORS: 173
    2  INFO no_primary_key
   27  INFO unindexed_foreign_keys
   36  INFO unused_index
   87  WARN auth_rls_initplan
    1  WARN duplicate_index
   20  WARN multiple_permissive_policies

--- WARN/ERROR details ---
  [WARN] auth_rls_initplan: Table \`public.profiles\` has a row level security policy \`Users can insert own profile\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query perform
  [WARN] auth_rls_initplan: Table \`public.split_groups\` has a row level security policy \`Members can view shared groups\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query p
  [WARN] auth_rls_initplan: Table \`public.group_invites\` has a row level security policy \`Group owners can create invites\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query
  [WARN] auth_rls_initplan: Table \`public.group_events\` has a row level security policy \`Connected members can view group events\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptima
  [WARN] auth_rls_initplan: Table \`public.group_events\` has a row level security policy \`Connected members can create group events\` that re-evaluates current_setting() or auth.<function>() for each row. This produces subopti
  [WARN] auth_rls_initplan: Table \`public.group_expenses\` has a row level security policy \`Expense creators can delete their shared group expenses\` that re-evaluates current_setting() or auth.<function>() for each row. This 
  [WARN] auth_rls_initplan: Table \`public.group_members\` has a row level security policy \`Users can view members of shared groups\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptim
  [WARN] auth_rls_initplan: Table \`public.budgets\` has a row level security policy \`budgets_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance at sca
  [WARN] auth_rls_initplan: Table \`public.budgets\` has a row level security policy \`budgets_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance at sca
  [WARN] auth_rls_initplan: Table \`public.budgets\` has a row level security policy \`budgets_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance at sca
  [WARN] auth_rls_initplan: Table \`public.recurring_transactions\` has a row level security policy \`recurring_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query p
  [WARN] auth_rls_initplan: Table \`public.recurring_transactions\` has a row level security policy \`recurring_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query p
  [WARN] auth_rls_initplan: Table \`public.recurring_transactions\` has a row level security policy \`recurring_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query p
  [WARN] auth_rls_initplan: Table \`public.recurring_transactions\` has a row level security policy \`recurring_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query p
  [WARN] auth_rls_initplan: Table \`public.remittances\` has a row level security policy \`remittances_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performanc
  [WARN] auth_rls_initplan: Table \`public.group_expenses\` has a row level security policy \`Members can view shared group expenses\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptim
  [WARN] auth_rls_initplan: Table \`public.group_expenses\` has a row level security policy \`Connected members can create shared group expenses\` that re-evaluates current_setting() or auth.<function>() for each row. This produ
  [WARN] auth_rls_initplan: Table \`public.group_settlements\` has a row level security policy \`Members can view shared group settlements\` that re-evaluates current_setting() or auth.<function>() for each row. This produces su
  [WARN] auth_rls_initplan: Table \`public.group_settlements\` has a row level security policy \`Connected members can create shared group settlements\` that re-evaluates current_setting() or auth.<function>() for each row. This
  [WARN] auth_rls_initplan: Table \`public.group_invites\` has a row level security policy \`Members can view invites in their groups\` that re-evaluates current_setting() or auth.<function>() for each row. This produces subopti
  [WARN] auth_rls_initplan: Table \`public.notifications\` has a row level security policy \`Users can view own notifications\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.notifications\` has a row level security policy \`Users can update own notifications\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.notifications\` has a row level security policy \`Users can delete own notifications\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.remittances\` has a row level security policy \`remittances_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performanc
  [WARN] auth_rls_initplan: Table \`public.notifications\` has a row level security policy \`Users can insert notifications for self or fellow members\` that re-evaluates current_setting() or auth.<function>() for each row. This
  [WARN] auth_rls_initplan: Table \`public.persons\` has a row level security policy \`persons_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance at sca
  [WARN] auth_rls_initplan: Table \`public.persons\` has a row level security policy \`persons_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance at sca
  [WARN] auth_rls_initplan: Table \`public.persons\` has a row level security policy \`persons_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance at sca
  [WARN] auth_rls_initplan: Table \`public.persons\` has a row level security policy \`persons_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance at sca
  [WARN] auth_rls_initplan: Table \`public.linked_transaction_requests\` has a row level security policy \`ltr_select_participant\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal 
  [WARN] auth_rls_initplan: Table \`public.linked_transaction_requests\` has a row level security policy \`ltr_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query pe
  [WARN] auth_rls_initplan: Table \`public.linked_settlement_requests\` has a row level security policy \`lsr_select_participant\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal q
  [WARN] auth_rls_initplan: Table \`public.linked_settlement_requests\` has a row level security policy \`lsr_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query per
  [WARN] auth_rls_initplan: Table \`public.budgets\` has a row level security policy \`budgets_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance at sca
  [WARN] auth_rls_initplan: Table \`public.remittances\` has a row level security policy \`remittances_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performanc
  [WARN] auth_rls_initplan: Table \`public.remittances\` has a row level security policy \`remittances_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performanc
  [WARN] auth_rls_initplan: Table \`public.group_events\` has a row level security policy \`Members can delete own group events\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.accounts\` has a row level security policy \`Users can manage own accounts\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query perfor
  [WARN] auth_rls_initplan: Table \`public.transactions\` has a row level security policy \`Users can manage own transactions\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.loans\` has a row level security policy \`Users can manage own loans\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance 
  [WARN] auth_rls_initplan: Table \`public.emi_schedules\` has a row level security policy \`Users can manage own emi\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query perfor
  [WARN] auth_rls_initplan: Table \`public.goals\` has a row level security policy \`Users can manage own goals\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance 
  [WARN] auth_rls_initplan: Table \`public.activities\` has a row level security policy \`Users can manage own activities\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query pe
  [WARN] auth_rls_initplan: Table \`public.upcoming_expenses\` has a row level security policy \`Users can manage own upcoming\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal que
  [WARN] auth_rls_initplan: Table \`public.split_groups\` has a row level security policy \`Users can manage own groups\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query perf
  [WARN] auth_rls_initplan: Table \`public.group_settlements\` has a row level security policy \`Users can manage own settlements\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal 
  [WARN] auth_rls_initplan: Table \`public.group_expenses\` has a row level security policy \`Expense creators can update their shared group expenses\` that re-evaluates current_setting() or auth.<function>() for each row. This 
  [WARN] auth_rls_initplan: Table \`public.group_invites\` has a row level security policy \`Owner can revoke invites\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query perfor
  [WARN] auth_rls_initplan: Table \`public.group_settlements\` has a row level security policy \`Connected members can delete shared group settlements\` that re-evaluates current_setting() or auth.<function>() for each row. This
  [WARN] auth_rls_initplan: Table \`public.profiles\` has a row level security policy \`Users can view own active profile\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query pe
  [WARN] auth_rls_initplan: Table \`public.profiles\` has a row level security policy \`Users can update own active profile\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query 
  [WARN] auth_rls_initplan: Table \`public.committee_payments\` has a row level security policy \`committee_payments_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.committee_payments\` has a row level security policy \`committee_payments_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.group_members\` has a row level security policy \`Group owners can add members\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query pe
  [WARN] auth_rls_initplan: Table \`public.group_members\` has a row level security policy \`Group owners can update members\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query
  [WARN] auth_rls_initplan: Table \`public.committee_payments\` has a row level security policy \`committee_payments_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.group_invites\` has a row level security policy \`Group owners can update invites\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query
  [WARN] auth_rls_initplan: Table \`public.custom_categories\` has a row level security policy \`custom_categories_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.custom_categories\` has a row level security policy \`custom_categories_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.custom_categories\` has a row level security policy \`custom_categories_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.custom_categories\` has a row level security policy \`custom_categories_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.committees\` has a row level security policy \`committees_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance 
  [WARN] auth_rls_initplan: Table \`public.committees\` has a row level security policy \`committees_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance 
  [WARN] auth_rls_initplan: Table \`public.committees\` has a row level security policy \`committees_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance 
  [WARN] auth_rls_initplan: Table \`public.committees\` has a row level security policy \`committees_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance 
  [WARN] auth_rls_initplan: Table \`public.committee_members\` has a row level security policy \`committee_members_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.committee_members\` has a row level security policy \`committee_members_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.committee_members\` has a row level security policy \`committee_members_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.committee_members\` has a row level security policy \`committee_members_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.committee_payments\` has a row level security policy \`committee_payments_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.investment_markets\` has a row level security policy \`investment_markets_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.investment_markets\` has a row level security policy \`investment_markets_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.investment_markets\` has a row level security policy \`investment_markets_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.investment_markets\` has a row level security policy \`investment_markets_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal qu
  [WARN] auth_rls_initplan: Table \`public.investment_trades\` has a row level security policy \`investment_trades_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.investment_trades\` has a row level security policy \`investment_trades_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.investment_trades\` has a row level security policy \`investment_trades_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.investment_trades\` has a row level security policy \`investment_trades_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.investment_prices\` has a row level security policy \`investment_prices_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.investment_prices\` has a row level security policy \`investment_prices_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.investment_prices\` has a row level security policy \`investment_prices_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.investment_prices\` has a row level security policy \`investment_prices_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal quer
  [WARN] auth_rls_initplan: Table \`public.contact_link_requests\` has a row level security policy \`clr_select_participant\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query 
  [WARN] auth_rls_initplan: Table \`public.device_push_tokens\` has a row level security policy \`dpt_select_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance
  [WARN] auth_rls_initplan: Table \`public.device_push_tokens\` has a row level security policy \`dpt_insert_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance
  [WARN] auth_rls_initplan: Table \`public.device_push_tokens\` has a row level security policy \`dpt_update_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance
  [WARN] auth_rls_initplan: Table \`public.device_push_tokens\` has a row level security policy \`dpt_delete_own\` that re-evaluates current_setting() or auth.<function>() for each row. This produces suboptimal query performance
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`anon\` for action \`DELETE\`. Policies include \`{"Connected members can delete shared group settlements","Users can mana
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`anon\` for action \`INSERT\`. Policies include \`{"Connected members can create shared group settlements","Users can mana
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`anon\` for action \`SELECT\`. Policies include \`{"Members can view shared group settlements","Users can manage own settl
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`authenticated\` for action \`DELETE\`. Policies include \`{"Connected members can delete shared group settlements","Users
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`authenticated\` for action \`INSERT\`. Policies include \`{"Connected members can create shared group settlements","Users
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`authenticated\` for action \`SELECT\`. Policies include \`{"Members can view shared group settlements","Users can manage 
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`authenticator\` for action \`DELETE\`. Policies include \`{"Connected members can delete shared group settlements","Users
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`authenticator\` for action \`INSERT\`. Policies include \`{"Connected members can create shared group settlements","Users
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`authenticator\` for action \`SELECT\`. Policies include \`{"Members can view shared group settlements","Users can manage 
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`dashboard_user\` for action \`DELETE\`. Policies include \`{"Connected members can delete shared group settlements","User
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`dashboard_user\` for action \`INSERT\`. Policies include \`{"Connected members can create shared group settlements","User
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`dashboard_user\` for action \`SELECT\`. Policies include \`{"Members can view shared group settlements","Users can manage
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`supabase_privileged_role\` for action \`DELETE\`. Policies include \`{"Connected members can delete shared group settleme
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`supabase_privileged_role\` for action \`INSERT\`. Policies include \`{"Connected members can create shared group settleme
  [WARN] multiple_permissive_policies: Table \`public.group_settlements\` has multiple permissive policies for role \`supabase_privileged_role\` for action \`SELECT\`. Policies include \`{"Members can view shared group settlements","Users 
  [WARN] multiple_permissive_policies: Table \`public.split_groups\` has multiple permissive policies for role \`anon\` for action \`SELECT\`. Policies include \`{"Members can view shared groups","Users can manage own groups"}\`
  [WARN] multiple_permissive_policies: Table \`public.split_groups\` has multiple permissive policies for role \`authenticated\` for action \`SELECT\`. Policies include \`{"Members can view shared groups","Users can manage own groups"}\`
  [WARN] multiple_permissive_policies: Table \`public.split_groups\` has multiple permissive policies for role \`authenticator\` for action \`SELECT\`. Policies include \`{"Members can view shared groups","Users can manage own groups"}\`
  [WARN] multiple_permissive_policies: Table \`public.split_groups\` has multiple permissive policies for role \`dashboard_user\` for action \`SELECT\`. Policies include \`{"Members can view shared groups","Users can manage own groups"}\`
  [WARN] multiple_permissive_policies: Table \`public.split_groups\` has multiple permissive policies for role \`supabase_privileged_role\` for action \`SELECT\`. Policies include \`{"Members can view shared groups","Users can manage own g
  [WARN] duplicate_index: Table \`public.group_events\` has identical indexes {idx_gevents_group_created,idx_group_events_group_created}. Drop all except one of them

--- INFO grouped ---
unindexed_foreign_keys (27)
   Table \`public.committee_members\` has a foreign key \`committee_members_user_id_fkey\` without a covering index. This can lead to suboptima
   Table \`public.committee_payments\` has a foreign key \`committee_payments_user_id_fkey\` without a covering index. This can lead to subopti
   Table \`public.committees\` has a foreign key \`committees_user_id_fkey\` without a covering index. This can lead to suboptimal query perfor
   Table \`public.group_events\` has a foreign key \`group_events_actor_profile_id_fkey\` without a covering index. This can lead to suboptimal
   Table \`public.group_expenses\` has a foreign key \`group_expenses_created_by_fkey\` without a covering index. This can lead to suboptimal q
   Table \`public.group_expenses\` has a foreign key \`group_expenses_deleted_by_fkey\` without a covering index. This can lead to suboptimal q
   Table \`public.group_expenses\` has a foreign key \`group_expenses_reconciled_by_fkey\` without a covering index. This can lead to suboptima
   Table \`public.group_expenses\` has a foreign key \`group_expenses_updated_by_fkey\` without a covering index. This can lead to suboptimal q
   Table \`public.group_expenses\` has a foreign key \`group_expenses_user_id_fkey\` without a covering index. This can lead to suboptimal quer
   Table \`public.group_invites\` has a foreign key \`group_invites_accepted_by_fkey\` without a covering index. This can lead to suboptimal qu
   Table \`public.group_invites\` has a foreign key \`group_invites_created_by_fkey\` without a covering index. This can lead to suboptimal que
   Table \`public.group_invites\` has a foreign key \`group_invites_linked_member_id_fkey\` without a covering index. This can lead to suboptim
   Table \`public.group_members\` has a foreign key \`group_members_invited_by_fkey\` without a covering index. This can lead to suboptimal que
   Table \`public.group_settlements\` has a foreign key \`group_settlements_created_by_fkey\` without a covering index. This can lead to subopt
   Table \`public.group_settlements\` has a foreign key \`group_settlements_deleted_by_fkey\` without a covering index. This can lead to subopt
   Table \`public.group_settlements\` has a foreign key \`group_settlements_updated_by_fkey\` without a covering index. This can lead to subopt
   Table \`public.group_settlements\` has a foreign key \`group_settlements_user_id_fkey\` without a covering index. This can lead to suboptima
   Table \`public.investment_prices\` has a foreign key \`investment_prices_market_id_fkey\` without a covering index. This can lead to subopti
   Table \`public.linked_settlement_requests\` has a foreign key \`linked_settlement_requests_requester_loan_id_fkey\` without a covering index
   Table \`public.linked_settlement_requests\` has a foreign key \`linked_settlement_requests_responder_loan_id_fkey\` without a covering index
   Table \`public.linked_transaction_requests\` has a foreign key \`linked_transaction_requests_person_id_fkey\` without a covering index. This
   Table \`public.notifications\` has a foreign key \`notifications_event_id_fkey\` without a covering index. This can lead to suboptimal query
   Table \`public.notifications\` has a foreign key \`notifications_group_id_fkey\` without a covering index. This can lead to suboptimal query
   Table \`public.persons\` has a foreign key \`persons_linked_profile_id_fkey\` without a covering index. This can lead to suboptimal query pe
   Table \`public.recurring_transactions\` has a foreign key \`fk_recurring_source_account\` without a covering index. This can lead to subopti
   Table \`public.split_groups\` has a foreign key \`split_groups_created_by_fkey\` without a covering index. This can lead to suboptimal query
   Table \`public.transactions\` has a foreign key \`transactions_reconciled_by_fkey\` without a covering index. This can lead to suboptimal qu
no_primary_key (2)
   Table \`public.phone_lookup_attempts\` does not have a primary key
   Table \`public.join_code_attempts\` does not have a primary key
unused_index (36)
   Index \`idx_goals_user_created\` on table \`public.goals\` has not been used
   Index \`idx_upcoming_user_due\` on table \`public.upcoming_expenses\` has not been used
   Index \`idx_activities_user_entity_ts\` on table \`public.activities\` has not been used
   Index \`idx_lsr_from_created\` on table \`public.linked_settlement_requests\` has not been used
   Index \`idx_lsr_to_created\` on table \`public.linked_settlement_requests\` has not been used
   Index \`idx_emi_user_installment\` on table \`public.emi_schedules\` has not been used
   Index \`idx_recurring_user_due\` on table \`public.recurring_transactions\` has not been used
   Index \`idx_gexp_live_created\` on table \`public.group_expenses\` has not been used
   Index \`idx_gsett_group_live\` on table \`public.group_settlements\` has not been used
   Index \`idx_gsett_live_created\` on table \`public.group_settlements\` has not been used
   Index \`idx_ginvites_token_active\` on table \`public.group_invites\` has not been used
   Index \`idx_ginvites_group_active\` on table \`public.group_invites\` has not been used
   Index \`recurring_due_date_idx\` on table \`public.recurring_transactions\` has not been used
   Index \`remittances_user_id_idx\` on table \`public.remittances\` has not been used
   Index \`idx_profiles_is_deleted\` on table \`public.profiles\` has not been used
   Index \`contact_link_requests_to_pending_idx\` on table \`public.contact_link_requests\` has not been used
   Index \`persons_active_user_name_idx\` on table \`public.persons\` has not been used
   Index \`profiles_phone_discovery_idx\` on table \`public.profiles\` has not been used
   Index \`persons_user_id_idx\` on table \`public.persons\` has not been used
   Index \`idx_ltr_to_pending\` on table \`public.linked_transaction_requests\` has not been used
   Index \`idx_ltr_from_pending\` on table \`public.linked_transaction_requests\` has not been used
   Index \`device_push_tokens_user_idx\` on table \`public.device_push_tokens\` has not been used
   Index \`idx_budgets_user_updated\` on table \`public.budgets\` has not been used
   Index \`idx_budgets_user_deleted\` on table \`public.budgets\` has not been used
   Index \`idx_investment_trades_user_created\` on table \`public.investment_trades\` has not been used
   Index \`idx_lsr_to_pending\` on table \`public.linked_settlement_requests\` has not been used
   Index \`idx_lsr_from_pending\` on table \`public.linked_settlement_requests\` has not been used
   Index \`idx_lsr_pair\` on table \`public.linked_settlement_requests\` has not been used
   Index \`idx_investment_markets_user_deleted\` on table \`public.investment_markets\` has not been used
   Index \`idx_investment_trades_user_deleted\` on table \`public.investment_trades\` has not been used
   Index \`idx_transactions_related_investment\` on table \`public.transactions\` has not been used
   Index \`idx_investment_markets_user_created\` on table \`public.investment_markets\` has not been used
   Index \`idx_investment_trades_market\` on table \`public.investment_trades\` has not been used
   Index \`idx_investment_trades_user_symbol\` on table \`public.investment_trades\` has not been used
   Index \`idx_investment_prices_user_deleted\` on table \`public.investment_prices\` has not been used
   Index \`idx_transactions_reconciled\` on table \`public.transactions\` has not been used
```

## Pre-apply baseline — `pg_policies` snapshot (108 policies, 2026-09-03)

Captured read-only before any of the 32 pending files is applied. Every name is one the
repo's own SQL creates (no hand-made policies); the two ledger tables carry exactly the nine
policies `supabase-migration-audit-p0-group-ledger-integrity.sql` allowlists, so its
"drop anything unallowlisted" step has nothing unexpected to drop.

```
accounts :: Active profiles only [ALL/R] · Users can manage own accounts [ALL/P]
activities :: Active profiles only [ALL/R] · Users can manage own activities [ALL/P]
budgets :: Active profiles only [ALL/R] · budgets_{select,insert,update,delete}_own
committee_members :: committee_members_{select,insert,update,delete}_own
committee_payments :: committee_payments_{select,insert,update,delete}_own
committees :: committees_{select,insert,update,delete}_own
contact_link_requests :: clr_select_participant [SELECT/P]
custom_categories :: custom_categories_{select,insert,update,delete}_own
device_push_tokens :: dpt_{select,insert,update,delete}_own
emi_schedules :: Active profiles only [ALL/R] · Users can manage own emi [ALL/P]
goals :: Active profiles only [ALL/R] · Users can manage own goals [ALL/P]
group_events :: Active profiles only [ALL/R] · Connected members can create group events [INSERT/P] · Connected members can view group events [SELECT/P] · Members can delete own group events [DELETE/P]
group_expenses :: Active profiles only [ALL/R] · Connected members can create shared group expenses [INSERT/P] · Expense creators can delete their shared group expenses [DELETE/P] · Expense creators can update their shared group expenses [UPDATE/P] · Members can view shared group expenses [SELECT/P]
group_invites :: Active profiles only [ALL/R] · Group owners can create invites [INSERT/P] · Group owners can update invites [UPDATE/P] · Members can view invites in their groups [SELECT/P] · Owner can revoke invites [DELETE/P]
group_members :: Active profiles only [ALL/R] · Group owners can add members [INSERT/P] · Group owners can update members [UPDATE/P] · Users can view members of shared groups [SELECT/P]
group_settlements :: Active profiles only [ALL/R] · Connected members can create shared group settlements [INSERT/P] · Connected members can delete shared group settlements [DELETE/P] · Members can view shared group settlements [SELECT/P] · Users can manage own settlements [ALL/P]  ← the C4 policy, dropped by group-ledger-integrity
investment_markets / investment_prices / investment_trades :: <table>_{select,insert,update,delete}_own
join_code_attempts :: no client access to join_code_attempts [ALL/P, false/false]
linked_settlement_requests :: Active profiles only [ALL/R] · lsr_insert_own [INSERT/P] · lsr_select_participant [SELECT/P]
linked_transaction_requests :: Active profiles only [ALL/R] · ltr_insert_own [INSERT/P] · ltr_select_participant [SELECT/P]
loans :: Active profiles only [ALL/R] · Users can manage own loans [ALL/P]
notifications :: Active profiles only [ALL/R] · Users can delete own notifications [DELETE/P] · Users can insert notifications for self or fellow members [INSERT/P]  ← C7 · Users can update own notifications [UPDATE/P] · Users can view own notifications [SELECT/P]
persons :: Active profiles only [ALL/R] · persons_{select,insert,update,delete}_own
profiles :: Users can insert own profile [INSERT/P] · Users can update own active profile [UPDATE/P] · Users can view own active profile [SELECT/P]
recurring_transactions :: Active profiles only [ALL/R] · recurring_{select,insert,update,delete}_own
remittances :: Active profiles only [ALL/R] · remittances_{select,insert,update,delete}_own
split_groups :: Active profiles only [ALL/R] · Members can view shared groups [SELECT/P] · Users can manage own groups [ALL/P]
transactions :: Active profiles only [ALL/R] · Users can manage own transactions [ALL/P]
upcoming_expenses :: Active profiles only [ALL/R] · Users can manage own upcoming [ALL/P]
```

Table sizes at the same moment (for lock/maintenance-window sizing): 25 auth users; largest
tables `activities` 917 rows, `transactions` 714, `notifications` 499, `loans` 269; every
table under 1 MB; whole schema under 5 MB.

## Pre-flight run against production — 2026-09-03 (read-only, `supabase-preflight-2026-09-03.sql`)

All 66 checks executed through the Supabase MCP. Result:

| severity | checks | non-zero |
|---|---|---|
| BLOCKS (file would abort) | 5 | **0** |
| DEGRADES (constraint would land NOT VALID / index skipped) | 37 | **0** |
| REWRITES (existing rows updated at apply time) | 6 | invites→14-day expiry **4**, join codes→14-day expiry **5**, notifications channel/href backfill **500**; version backfill 0, draw_scheme backfill 0, witness-token destruction **0** (the only irreversible statement is a no-op on today's data) |
| FREEZES (legal today, new trigger refuses future edits) | 9 | groups with <2 connected members **3** (see below); every other freeze 0 |
| LOCKS (table sizes) | 9 | largest is `transactions` at 716 rows — no maintenance window needed |

Conclusion: no pending file can fail on today's production data, and none rewrites money
rows. The only behavioural consequence for existing data is that the three single-member
groups can no longer have expense amounts edited until a second member connects (audit C4/C10
design: a ledger needs two live parties).

## Post-apply verification — 2026-09-03 (founder applied the batch in Studio)

The founder ran `supabase/tests/apply-order.txt` top to bottom — i.e. including the 41
already-applied historical files and the harness-only prelude. Read-only re-check afterwards:

- **Data intact:** exact counts and sums identical to the morning baseline (716 transactions,
  271 loans, 40 accounts, 25 profiles, 82 group expenses; account-balance and loan-remaining
  sums unchanged). The re-run of the historical files did no harm: every idempotent file was a
  no-op and the batch order was preserved, so the final state is the branch's.
- **Prelude effect neutralised:** it drops the four notifications policies, the notifications-rls
  migration re-creates them and audit-p0-notifications replaces the INSERT one; final state =
  `Users can insert own notifications` + view/update/delete own + the RESTRICTIVE gate.
- **30 of 32 branch files verifiably applied.** C4 (no FOR ALL on group_settlements), C6
  (`token_hash` not readable), C7 (self-only INSERT) closed; 123 policies, 0 bare `auth.uid()`;
  anon-executable SECURITY DEFINER = exactly {get_committee_witness, get_khata_view}; 0 functions
  without search_path; duplicate index gone; identity PKs present; join_group_by_code is the
  single JSONB overload; app_config seeded (`min_supported_version` 1.0.0); every new table
  (blocks, record_edits, khata_links, reconciliation_*, group_guest_identities, code_lookup_attempts,
  reports) present; **all 57 `supabase.rpc()` names the branch client calls exist and are
  EXECUTE-able by `authenticated`**.
- **Gap 1 — `supabase-migration-audit-p0-currencies.sql` did not take effect:** the two
  `*_currency_check` constraints are still AED/PKR-only and `ltr/lsr_currency_supported` are
  absent. Safe to re-run (idempotent; preflight shows 0 rows outside AED/PKR).
- **Gap 2 — `pg_cron` is not installed** (extensions: pg_stat_statements, pgcrypto, plpgsql,
  supabase_vault, uuid-ossp). The three guarded schedulers skipped with a NOTICE: nightly
  `run_reconciliation()` (p3-invariant-monitoring §6), `hisaab-prune-record-edits`
  (p2-edit-history), kameti due-sweep (p2-notification-maturity §9). Enable pg_cron in
  Dashboard → Database → Extensions, then re-run those three files (idempotent) or create the
  jobs in the Cron UI. `reconciliation_runs` is empty until then.
- Security advisor after apply: 0 ERROR; 2 anon WARNs (the allowlist), 59 authenticated WARNs
  (all client RPCs or policy/trigger helpers), 4 INFO rls-no-policy (app_push_config,
  khata_link_lookups, reconciliation_runs, reconciliation_findings — all server-only tables),
  leaked-password protection still off.
