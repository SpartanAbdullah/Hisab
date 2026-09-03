-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — PRE-FLIGHT for the 32 unapplied migrations (2026-09-03)
--
-- Companion to: docs/audit-2026-09/migration-data-safety-review.md
--
-- WHAT THIS IS
--   One read-only query. Paste the whole file into Supabase Studio → SQL Editor
--   and run it BEFORE applying any of the 32 pending migration files. It counts
--   the production rows that would (a) make a new constraint fail, (b) make a
--   new constraint land NOT VALID, (c) be REWRITTEN by an at-apply-time
--   backfill, or (d) become uneditable once a new trigger goes live.
--
-- IT IS STRICTLY READ-ONLY
--   Nothing but SELECT. No CREATE, no ALTER, no INSERT/UPDATE/DELETE, no
--   temp tables, no set_config, no function creation. Safe to run at any time,
--   on production, as many times as you like. It takes locks no heavier than a
--   plain SELECT.
--
-- HOW TO READ THE OUTPUT
--   Three columns: (file, check, violating_rows).
--     severity = BLOCKS   → violating_rows > 0 means the named migration file
--                           will ABORT and roll itself back. Fix the rows first.
--     severity = DEGRADES → violating_rows > 0 means the file still applies,
--                           but the constraint lands NOT VALID (a WARNING in
--                           the Studio output) or an index is silently skipped.
--     severity = REWRITES → violating_rows is the number of EXISTING USER ROWS
--                           the file will UPDATE at apply time. Not an error —
--                           it is the blast radius. Read it before you say yes.
--     severity = LOCKS    → violating_rows is a table row count; the named file
--                           takes an ACCESS EXCLUSIVE lock / rewrites or index-
--                           builds that table. Sizes the maintenance window.
--     severity = FREEZES  → violating_rows > 0 means those rows exist today and
--                           are legal, but a NEW trigger will refuse the next
--                           client edit of them.
--
--   IDEAL RESULT: every BLOCKS row is 0. DEGRADES rows at 0 are ideal but not
--   required. REWRITES / LOCKS / FREEZES are informational by design.
--
-- COMPATIBILITY
--   Runs unchanged against a database with only the 41 historical files applied
--   (production today) AND against a fully-migrated one. Every table and column
--   it names exists in BOTH states; it deliberately references none of the new
--   objects the 32 pending files create.
-- ════════════════════════════════════════════════════════════════════════════

WITH
-- ────────────────────────────────────────────────────────────────────────────
-- The eight currencies the client ships (src/db/types.ts:1 SUPPORTED_CURRENCIES).
-- Both audit-p0-currencies and p1-money-bounds whitelist exactly this set.
-- ────────────────────────────────────────────────────────────────────────────
cur AS (SELECT ARRAY['AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD'] AS ok)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 1. supabase-migration-audit-p0-currencies.sql                            ║
-- ║    :102 add constraint ltr_currency_supported CHECK (currency IN (...))  ║
-- ║    :113 add constraint lsr_currency_supported CHECK (currency IN (...))  ║
-- ║    No NOT VALID → validated against every existing row on ADD.           ║
-- ║    This is a WIDENING of an AED/PKR-only check, so a violation is only    ║
-- ║    possible if a row somehow holds a ninth currency.                     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
SELECT 'audit-p0-currencies'::text AS file,
       'BLOCKS   :102 ltr_currency_supported — linked_transaction_requests.currency outside the 8'::text AS check,
       (SELECT count(*) FROM public.linked_transaction_requests t, cur
         WHERE t.currency <> ALL (cur.ok))::bigint AS violating_rows
UNION ALL
SELECT 'audit-p0-currencies',
       'BLOCKS   :113 lsr_currency_supported — linked_settlement_requests.currency outside the 8',
       (SELECT count(*) FROM public.linked_settlement_requests t, cur
         WHERE t.currency <> ALL (cur.ok))

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 2. supabase-migration-audit-p0-notifications.sql                         ║
-- ║    :127 ADD CONSTRAINT notifications_text_length_check ... NOT VALID     ║
-- ║         → cannot block. Counts rows that make it land dirty.             ║
-- ║    :112 CREATE INDEX idx_notifications_actor_created (build cost).       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'audit-p0-notifications',
       'DEGRADES :127 notifications_text_length_check (NOT VALID) — title>200 or body>1000',
       (SELECT count(*) FROM public.notifications
         WHERE length(title) > 200 OR length(body) > 1000)
UNION ALL
SELECT 'audit-p0-notifications',
       'LOCKS    :112 CREATE INDEX idx_notifications_actor_created — notifications row count',
       (SELECT count(*) FROM public.notifications)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 3. supabase-migration-audit-p0-group-concurrency.sql                     ║
-- ║    :68 UPDATE public.group_expenses SET version = 1 WHERE version IS NULL║
-- ║        group_expenses.version is INTEGER NOT NULL DEFAULT 1              ║
-- ║        (supabase-schema.sql:308), so this must be 0. If it is not, the   ║
-- ║        schema has drifted and the review's conclusion is void.           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'audit-p0-group-concurrency',
       'REWRITES :68 UPDATE group_expenses SET version=1 WHERE version IS NULL (expect 0 — column is NOT NULL)',
       (SELECT count(*) FROM public.group_expenses WHERE version IS NULL)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 3b. supabase-migration-audit-p0-kameti-draw.sql                          ║
-- ║     :195 UPDATE public.committees SET draw_scheme = 'mulberry32-shuffle-v0'
-- ║          WHERE draw_seed IS NOT NULL AND draw_scheme IS NULL             ║
-- ║          — inside a DO block, which DOES run at paste time.              ║
-- ║     Plus three FREEZES: the new BEFORE triggers validate NEW-row STATE,  ║
-- ║     not deltas, so a pre-existing row in a shape the trigger dislikes    ║
-- ║     refuses EVERY future UPDATE — including a rename.                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'audit-p0-kameti-draw',
       'REWRITES :195 UPDATE committees SET draw_scheme — drawn kametis backfilled (upper bound)',
       (SELECT count(*) FROM public.committees WHERE draw_seed IS NOT NULL)
UNION ALL
SELECT 'audit-p0-kameti-draw',
       'FREEZES  :404 BALLOT_DRAW_SERVER_ONLY — ballot kametis with drawn_at but no draw_seed (refuse every future UPDATE)',
       (SELECT count(*) FROM public.committees
         WHERE payout_method = 'ballot' AND drawn_at IS NOT NULL AND draw_seed IS NULL)
UNION ALL
SELECT 'audit-p0-kameti-draw',
       'FREEZES  :484 BALLOT_SLOTS_SERVER_ONLY — members holding a slot in an undrawn ballot kameti',
       (SELECT count(*) FROM public.committee_members m
          JOIN public.committees c ON c.id = m.committee_id
         WHERE c.payout_method = 'ballot' AND c.draw_seed IS NULL AND m.slot IS NOT NULL)
UNION ALL
SELECT 'audit-p0-kameti-draw',
       'FREEZES  :465 DRAW_LOCKED — drawn kametis that can never accept a new member again',
       (SELECT count(*) FROM public.committees WHERE draw_seed IS NOT NULL)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 4. supabase-migration-audit-p0-account-deletion.sql                      ║
-- ║    :443/:452 ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (user_id)    ║
-- ║              REFERENCES auth.users(id) ON DELETE SET NULL                ║
-- ║    Not NOT VALID → the ADD scans every row against auth.users. An        ║
-- ║    orphaned user_id aborts the whole file.                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'audit-p0-account-deletion',
       'BLOCKS   :443 FK group_expenses.user_id -> auth.users — orphaned (non-NULL, no matching auth.users row)',
       (SELECT count(*) FROM public.group_expenses e
         WHERE e.user_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = e.user_id))
UNION ALL
SELECT 'audit-p0-account-deletion',
       'BLOCKS   :443 FK group_settlements.user_id -> auth.users — orphaned',
       (SELECT count(*) FROM public.group_settlements s
         WHERE s.user_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id))
UNION ALL
SELECT 'audit-p0-account-deletion',
       'LOCKS    :424/:452 ALTER TABLE group_expenses (DROP NOT NULL + FK rewrite) — row count',
       (SELECT count(*) FROM public.group_expenses)
UNION ALL
SELECT 'audit-p0-account-deletion',
       'LOCKS    :424/:452 ALTER TABLE group_settlements (DROP NOT NULL + FK rewrite) — row count',
       (SELECT count(*) FROM public.group_settlements)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 4b. supabase-migration-audit-p0-group-ledger-integrity.sql               ║
-- ║     :400/:407 an amount-only edit now re-runs full participant           ║
-- ║     validation and raises NOT_ENOUGH_ACTIVE_GROUP_MEMBERS below 2        ║
-- ║     connected members. Legacy one-member groups become read-only.        ║
-- ║     :275/:290 an ex-member (status <> 'connected') loses the ability to  ║
-- ║     edit or soft-delete their own historical rows.                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'audit-p0-group-ledger-integrity',
       'FREEZES  :407 NOT_ENOUGH_ACTIVE_GROUP_MEMBERS — groups with fewer than 2 connected members',
       (SELECT count(*) FROM public.split_groups g
         WHERE (SELECT count(*) FROM public.group_members gm
                 WHERE gm.group_id = g.id AND gm.status = 'connected') < 2)
UNION ALL
SELECT 'audit-p0-group-ledger-integrity',
       'FREEZES  :383 INACTIVE_GROUP_AUTHOR — live expenses authored by someone no longer connected to that group',
       (SELECT count(*) FROM public.group_expenses e
         WHERE e.deleted_at IS NULL AND e.user_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.group_members gm
                            WHERE gm.group_id = e.group_id
                              AND gm.profile_id = e.user_id
                              AND gm.status = 'connected'))
UNION ALL
SELECT 'audit-p0-group-ledger-integrity',
       'FREEZES  :475 INACTIVE_GROUP_AUTHOR — live settlements authored by someone no longer connected to that group',
       (SELECT count(*) FROM public.group_settlements s
         WHERE s.deleted_at IS NULL AND s.user_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.group_members gm
                            WHERE gm.group_id = s.group_id
                              AND gm.profile_id = s.user_id
                              AND gm.status = 'connected'))

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 5. supabase-migration-audit-p0-join-abuse-limits.sql                     ║
-- ║    :117 UPDATE public.split_groups SET join_code_expires_at = now()+14d  ║
-- ║         WHERE join_code IS NOT NULL AND join_code_expires_at IS NULL     ║
-- ║    The column is added by :112 in the same file, so on production every  ║
-- ║    group with a join code is touched. After this, every existing join    ║
-- ║    code expires in 14 days.                                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'audit-p0-join-abuse-limits',
       'REWRITES :117 UPDATE split_groups.join_code_expires_at — groups whose join code starts a 14-day clock',
       (SELECT count(*) FROM public.split_groups WHERE join_code IS NOT NULL)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 6. supabase-migration-audit-p0-consent-guards.sql                        ║
-- ║    :996 CREATE UNIQUE INDEX group_members_group_profile_uniq             ║
-- ║         ON group_members(group_id, profile_id) WHERE profile_id NOT NULL ║
-- ║    Guarded by a DO block (:980-1001): duplicates → RAISE WARNING and the ║
-- ║    index is NOT created. The file still succeeds, silently weaker.       ║
-- ║    :1441 UPDATE public.group_invites SET expires_at = now() + 14 days    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'audit-p0-consent-guards',
       'DEGRADES :996 group_members_group_profile_uniq — duplicate (group_id, profile_id) pairs (>0 SKIPS the index)',
       (SELECT count(*) FROM (
          SELECT group_id, profile_id FROM public.group_members
           WHERE profile_id IS NOT NULL
           GROUP BY group_id, profile_id HAVING count(*) > 1) d)
UNION ALL
SELECT 'audit-p0-consent-guards',
       'REWRITES :1441 UPDATE group_invites.expires_at — immortal invite links given a 14-day clock',
       (SELECT count(*) FROM public.group_invites
         WHERE expires_at IS NULL AND revoked_at IS NULL AND accepted_at IS NULL)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 7. supabase-migration-p1-money-bounds.sql — CURRENCY WHITELISTS          ║
-- ║    §2a, generated <table>_<column>_supported CHECKs. Every one is added  ║
-- ║    NOT VALID first (:212) and only then VALIDATEd inside an exception    ║
-- ║    handler (:216-222), so NONE of these can abort the file. A non-zero   ║
-- ║    count means that constraint stays NOT VALID with a named WARNING.     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a profiles_primary_currency_supported',
       (SELECT count(*) FROM public.profiles t, cur WHERE t.primary_currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a accounts_currency_supported',
       (SELECT count(*) FROM public.accounts t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a transactions_currency_supported',
       (SELECT count(*) FROM public.transactions t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a loans_currency_supported',
       (SELECT count(*) FROM public.loans t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a goals_currency_supported',
       (SELECT count(*) FROM public.goals t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a upcoming_expenses_currency_supported',
       (SELECT count(*) FROM public.upcoming_expenses t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a split_groups_currency_supported',
       (SELECT count(*) FROM public.split_groups t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a committees_currency_supported',
       (SELECT count(*) FROM public.committees t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a investment_markets_currency_supported',
       (SELECT count(*) FROM public.investment_markets t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a budgets_currency_supported',
       (SELECT count(*) FROM public.budgets t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a recurring_transactions_currency_supported',
       (SELECT count(*) FROM public.recurring_transactions t, cur WHERE t.currency <> ALL (cur.ok))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2a remittances_{source,destination,fee}_currency_supported',
       (SELECT count(*) FROM public.remittances t, cur
         WHERE t.source_currency      <> ALL (cur.ok)
            OR t.destination_currency <> ALL (cur.ok)
            OR t.fee_currency         <> ALL (cur.ok))

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 8. supabase-migration-p1-money-bounds.sql — AMOUNT BOUNDS (§2b … §2m)    ║
-- ║    Same NOT VALID mechanism: DEGRADES, never BLOCKS. MAX_MONEY = 1e12.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2b transactions_amount_bounded (amount >= 0 AND < 1e12)',
       (SELECT count(*) FROM public.transactions WHERE NOT (amount >= 0 AND amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2b transactions_conversion_rate_bounded (NULL or 0.0001..100000)',
       (SELECT count(*) FROM public.transactions
         WHERE conversion_rate IS NOT NULL
           AND NOT (conversion_rate >= 0.0001 AND conversion_rate <= 100000))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2c accounts_balance_bounded (-1e12 < balance < 1e12)',
       (SELECT count(*) FROM public.accounts WHERE NOT (balance > -1e12 AND balance < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2d loans_total_amount_bounded (>= 0 AND < 1e12)',
       (SELECT count(*) FROM public.loans WHERE NOT (total_amount >= 0 AND total_amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2d loans_remaining_amount_bounded (>= 0 AND < 1e12)',
       (SELECT count(*) FROM public.loans WHERE NOT (remaining_amount >= 0 AND remaining_amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2d loans_remaining_not_over_total (remaining <= total + 0.01)',
       (SELECT count(*) FROM public.loans WHERE NOT (remaining_amount <= total_amount + 0.01))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2e emi_schedules_amount_bounded (>= 0 AND < 1e12)',
       (SELECT count(*) FROM public.emi_schedules WHERE NOT (amount >= 0 AND amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2e emi_schedules_installment_number_sane (1..1200)',
       (SELECT count(*) FROM public.emi_schedules
         WHERE NOT (installment_number >= 1 AND installment_number <= 1200))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2f goals_target_amount_bounded (>= 0 AND < 1e12)',
       (SELECT count(*) FROM public.goals WHERE NOT (target_amount >= 0 AND target_amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2f goals_saved_amount_bounded (>= 0 AND < 1e12)',
       (SELECT count(*) FROM public.goals WHERE NOT (saved_amount >= 0 AND saved_amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2g upcoming_expenses_amount_bounded (>= 0 AND < 1e12)',
       (SELECT count(*) FROM public.upcoming_expenses WHERE NOT (amount >= 0 AND amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2h group_expenses_amount_positive (> 0 AND < 1e12) — CROSS-USER',
       (SELECT count(*) FROM public.group_expenses WHERE NOT (amount > 0 AND amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2i group_settlements_amount_positive (> 0 AND < 1e12) — CROSS-USER',
       (SELECT count(*) FROM public.group_settlements WHERE NOT (amount > 0 AND amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2j ltr_amount_bounded (> 0 AND < 1e12)',
       (SELECT count(*) FROM public.linked_transaction_requests WHERE NOT (amount > 0 AND amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2j lsr_amount_bounded (> 0 AND < 1e12)',
       (SELECT count(*) FROM public.linked_settlement_requests WHERE NOT (amount > 0 AND amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2k committees_contribution_amount_positive (> 0 AND < 1e12)',
       (SELECT count(*) FROM public.committees
         WHERE NOT (contribution_amount > 0 AND contribution_amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2k committees_counts_sane (member_count 1..1000, total_rounds 1..1000)',
       (SELECT count(*) FROM public.committees
         WHERE NOT (member_count >= 1 AND member_count <= 1000
                AND total_rounds >= 1 AND total_rounds <= 1000))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2l investment_trades_amounts_bounded (qty/price/amount/fees)',
       (SELECT count(*) FROM public.investment_trades
         WHERE NOT (quantity >= 0 AND quantity < 1e12
                AND price_per_unit >= 0 AND price_per_unit < 1e12
                AND amount >= 0 AND amount < 1e12
                AND fees >= 0 AND fees < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2l investment_prices_price_bounded (> 0 AND < 1e12)',
       (SELECT count(*) FROM public.investment_prices WHERE NOT (price > 0 AND price < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2m budgets_monthly_amount_bounded (>= 0 AND < 1e12)',
       (SELECT count(*) FROM public.budgets WHERE NOT (monthly_amount >= 0 AND monthly_amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2m recurring_transactions_amount_bounded (> 0 AND < 1e12)',
       (SELECT count(*) FROM public.recurring_transactions WHERE NOT (amount > 0 AND amount < 1e12))
UNION ALL
SELECT 'p1-money-bounds', 'DEGRADES §2m remittances_amounts_bounded (source/destination/fee/rate)',
       (SELECT count(*) FROM public.remittances
         WHERE NOT (source_amount > 0 AND source_amount < 1e12
                AND destination_amount > 0 AND destination_amount < 1e12
                AND fee_amount >= 0 AND fee_amount < 1e12
                AND effective_rate >= 0.0001 AND effective_rate <= 100000))

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 9. supabase-migration-p1-money-bounds.sql §3 — the splits trigger        ║
-- ║    :545 CREATE TRIGGER group_expenses_validate_split_amounts             ║
-- ║         BEFORE INSERT OR UPDATE ON public.group_expenses                 ║
-- ║    It re-validates ONLY when amount / splits / group_id move (:461-467), ║
-- ║    so it does not touch existing rows at apply time. But a row counted   ║
-- ║    below can never have its amount or splits edited again by any client. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'p1-money-bounds',
       'FREEZES  §3(5) GROUP_SPLITS_DO_NOT_SUM — live expenses whose splits miss the amount by > 0.01',
       (SELECT count(*) FROM public.group_expenses e
         WHERE e.deleted_at IS NULL
           AND jsonb_typeof(COALESCE(e.splits,'[]'::jsonb)) = 'array'
           AND jsonb_array_length(COALESCE(e.splits,'[]'::jsonb)) > 0
           AND NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements(COALESCE(e.splits,'[]'::jsonb)) s(value)
                  WHERE jsonb_typeof(s.value -> 'amount') <> 'number')
           AND abs(COALESCE((
                 SELECT sum((s.value ->> 'amount')::numeric)
                   FROM jsonb_array_elements(COALESCE(e.splits,'[]'::jsonb)) s(value)), 0)
               - e.amount) > 0.01)
UNION ALL
SELECT 'p1-money-bounds',
       'FREEZES  §3(1)(2) INVALID_GROUP_SPLITS — live expenses with an empty/non-array/non-numeric splits payload',
       (SELECT count(*) FROM public.group_expenses e
         WHERE e.deleted_at IS NULL
           AND (jsonb_typeof(COALESCE(e.splits,'[]'::jsonb)) <> 'array'
             OR jsonb_array_length(COALESCE(e.splits,'[]'::jsonb)) = 0
             OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(COALESCE(e.splits,'[]'::jsonb)) s(value)
                   WHERE jsonb_typeof(s.value) <> 'object'
                      OR jsonb_typeof(s.value -> 'amount') <> 'number')))
UNION ALL
SELECT 'p1-money-bounds',
       'FREEZES  §3(4) INVALID_GROUP_SPLIT_MEMBER — live expenses naming a member id absent from their group',
       (SELECT count(*) FROM public.group_expenses e
         WHERE e.deleted_at IS NULL
           AND jsonb_typeof(COALESCE(e.splits,'[]'::jsonb)) = 'array'
           AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements(COALESCE(e.splits,'[]'::jsonb)) s(value)
                  WHERE NOT EXISTS (
                        SELECT 1 FROM public.group_members gm
                         WHERE gm.id = COALESCE(s.value ->> 'memberId', s.value ->> 'member_id')
                           AND gm.group_id = e.group_id)))

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 10. supabase-migration-p2-trust-safety.sql §7                            ║
-- ║     :1992 CREATE UNIQUE INDEX committees_share_token_hash_uidx           ║
-- ║           ON committees (share_token_hash) WHERE ... IS NOT NULL         ║
-- ║           Created on an all-NULL column, so the CREATE cannot fail; the  ║
-- ║           §7.2 backfill that fills it CAN, if two committees share a     ║
-- ║           plaintext token (equal tokens hash equal).                     ║
-- ║     :2068 UPDATE committees SET share_token_hash = hash(share_token)     ║
-- ║     :2082 UPDATE committees SET share_token = NULL   ← IRREVERSIBLE      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
-- NOTE: production already carries a UNIQUE index `committees_share_token_uidx`
-- on the plaintext column (created by supabase-migration-committees-phase2.sql
-- and dropped by p2-trust-safety:2096 only AFTER the backfill). Duplicate
-- plaintext tokens are therefore structurally impossible and this count is
-- provably 0. Kept as a tripwire in case that index was ever dropped by hand.
SELECT 'p2-trust-safety',
       'BLOCKS   :1992/:2068 committees_share_token_hash_uidx — duplicate committees.share_token (provably 0: unique index exists)',
       (SELECT COALESCE(sum(n) - count(*), 0) FROM (
          SELECT count(*) AS n FROM public.committees
           WHERE share_token IS NOT NULL
           GROUP BY share_token HAVING count(*) > 1) d)
UNION ALL
SELECT 'p2-trust-safety',
       'REWRITES :2082 UPDATE committees SET share_token = NULL — plaintext witness tokens destroyed (IRREVERSIBLE)',
       (SELECT count(*) FROM public.committees WHERE share_token IS NOT NULL)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 11. supabase-migration-p2-notification-maturity.sql                      ║
-- ║     :435 UPDATE public.notifications SET channel_id/href/collapse_key    ║
-- ║          WHERE channel_id IS NULL  → on production that is EVERY row.    ║
-- ║     :1073 CREATE INDEX idx_notifications_prune ON notifications(...)     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'p2-notification-maturity',
       'REWRITES :435 UPDATE notifications SET channel_id/href/collapse_key — rows touched (= whole table)',
       (SELECT count(*) FROM public.notifications)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 12. supabase-migration-p2-guest-members.sql                              ║
-- ║     :193 ALTER TABLE group_members ADD COLUMN is_guest BOOLEAN           ║
-- ║          GENERATED ALWAYS AS (...) STORED                                ║
-- ║     A STORED generated column REWRITES the table under ACCESS EXCLUSIVE. ║
-- ║     Cannot fail on data (the expression is total), but it locks.         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'p2-guest-members',
       'LOCKS    :193 ADD COLUMN is_guest ... STORED — full rewrite of group_members, row count',
       (SELECT count(*) FROM public.group_members)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 12b. supabase-migration-p2-kameti-editing.sql                            ║
-- ║      :285 a THIRD BEFORE UPDATE trigger on committees. From apply time   ║
-- ║      any raw UPDATE moving member_count / total_rounds raises 42501      ║
-- ║      (:249-253), so a kameti whose stored counts already disagree with   ║
-- ║      its roster can no longer be repaired by a client UPDATE — only by   ║
-- ║      the new update_committee RPC.                                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'p2-kameti-editing',
       'FREEZES  :249 COUNT_FIELDS_ARE_DERIVED — kametis whose member_count or total_rounds already disagrees with the roster',
       (SELECT count(*) FROM public.committees c
         WHERE c.member_count IS DISTINCT FROM
               (SELECT count(*) FROM public.committee_members m WHERE m.committee_id = c.id)
            OR c.total_rounds IS DISTINCT FROM c.member_count)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 13. supabase-migration-p2-analytics-aggregates.sql                       ║
-- ║     :299 CREATE INDEX idx_transactions_user_created                      ║
-- ║     :302 CREATE INDEX idx_transactions_analytics_summary                 ║
-- ║     Two index builds on the largest table. No CONCURRENTLY (the file is  ║
-- ║     inside BEGIN/COMMIT), so writes to transactions block for the build. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'p2-analytics-aggregates',
       'LOCKS    :299/:302 two CREATE INDEX on public.transactions — row count',
       (SELECT count(*) FROM public.transactions)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 14. supabase-migration-p2-edit-history.sql                               ║
-- ║     :445/:451/:459/:472 four AFTER triggers on the live money tables.    ║
-- ║     Not an apply-time data risk; these numbers size the ONGOING write    ║
-- ║     amplification (one record_edits row per qualifying write from here). ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'p2-edit-history',
       'LOCKS    :459 AFTER trigger loans_record_edits — loans row count (ongoing write amplification)',
       (SELECT count(*) FROM public.loans)
UNION ALL
SELECT 'p2-edit-history',
       'LOCKS    :472 AFTER trigger transactions_record_edits — transactions row count (ongoing write amplification)',
       (SELECT count(*) FROM public.transactions)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 15. supabase-migration-p3-rls-initplan-and-indexes.sql §6                ║
-- ║     :611 ALTER TABLE %I ADD COLUMN id BIGINT GENERATED ALWAYS AS IDENTITY║
-- ║     :613 ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY (id)               ║
-- ║     An IDENTITY column's default is volatile → FULL TABLE REWRITE under  ║
-- ║     ACCESS EXCLUSIVE on each attempt ledger. Cannot fail on data.        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
UNION ALL
SELECT 'p3-rls-initplan-and-indexes',
       'LOCKS    :611 ADD COLUMN id IDENTITY — join_code_attempts rewrite, row count',
       (SELECT count(*) FROM public.join_code_attempts)
UNION ALL
SELECT 'p3-rls-initplan-and-indexes',
       'LOCKS    :611 ADD COLUMN id IDENTITY — phone_lookup_attempts rewrite, row count',
       (SELECT count(*) FROM public.phone_lookup_attempts)

ORDER BY 1, 2;

-- ════════════════════════════════════════════════════════════════════════════
-- FILES WITH NO PRE-FLIGHT ROW BELOW — and why
--
-- These 17 of the 32 create only NEW objects and cannot fail on, or touch, a
-- single existing row. Nothing to count.
--
--   audit-p0-loan-concurrency          new fn apply_loan_remaining_delta
--   audit-p0-settlement-row-locks      CREATE OR REPLACE of 2 existing fns
--   audit-p0-kameti-draw               ADD COLUMN committees.draw_scheme (nullable)
--   audit-p0-group-ledger-integrity    policy/trigger replacement only
--   audit-p0-group-deletion-guard      ADD COLUMN split_groups.archived_at/_by (nullable)
--   p1-app-config                      new table + one seed row, ON CONFLICT DO NOTHING
--   p1-profile-lang                    ADD COLUMN profiles.lang NOT NULL DEFAULT 'ur'
--                                      (PG11+ metadata-only; the CHECK cannot fail
--                                       because every backfilled value is 'ur')
--   p1-group-preview                   new fn preview_group_by_code
--   p3-khata-link                      new tables khata_links / khata_link_lookups
--   p3-atomic-transfer                 new fn only
--   p3-atomic-repayment                new fn only
--   p3-atomic-loan-create              new fn only
--   p3-atomic-goal-and-card            new fns only
--   p3-atomic-investments-and-single-leg  new fns only
--   p2-analytics-aggregates-2          new fns only
--   p2-realtime-broadcast              new fn only
--   p2-kameti-editing                  ADD COLUMN committees.emoji (nullable) + new fns
--   p3-invariant-monitoring            new reconciliation_* tables + read-only checks
--   p3-rpc-execute-grants              ACL/proconfig sweep only — no DDL, no DML
--
-- The two files above that DO rewrite existing function bodies
-- (audit-p0-settlement-row-locks, audit-p0-group-ledger-integrity) carry client
-- -coupling risk, not data risk. See §3 of the review document.
-- ════════════════════════════════════════════════════════════════════════════
