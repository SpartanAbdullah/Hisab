-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P2 item M6: trust & safety primitives (block / report), witness-link
-- lifecycle, per-loan rejection reason, and receipt-bucket limits + purge.
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- ── APPLY ORDER ─────────────────────────────────────────────────────────────
-- Apply LAST — after every audit-p0 file (docs/audit-2026-09/APPLY-ORDER.md §2,
-- steps 1-11) and after every supabase-migration-p1-*.sql. This file
-- CREATE-OR-REPLACEs functions whose CURRENT definitions live in:
--
--   supabase-migration-audit-p0-consent-guards.sql
--        link_contact_by_code, link_contact_by_discovery,
--        accept_group_membership, accept_group_invite
--   supabase-migration-audit-p0-join-abuse-limits.sql
--        join_group_by_code, lookup_profile_by_code
--   supabase-migration-audit-p0-notifications.sql
--        fan_out_group_notification
--   supabase-migration-audit-p0-account-deletion.sql
--        delete_current_user
--   supabase-migration-audit-p0-kameti-draw.sql
--        get_committee_witness            (kameti-draw's version, not phase2's)
--   supabase-migration-connections-push-discovery.sql
--        notify_contact_linked (v3), respond_contact_link,
--        lookup_hisaab_users_by_phone
--   supabase-migration-cross-user-account-effects.sql
--        tg_ltr_validate_insert
--   supabase-migration-phase2b-linked-requests.sql
--        reject_linked_request
--   supabase-migration-fix-settlement-cancel-reject.sql
--        reject_settlement_request
--   supabase-migration-receipts.sql
--        the receipts bucket + its four storage.objects policies
--
-- Applying this file BEFORE any of those would be silently undone by them.
-- It is order-independent with respect to the other p2 files as long as none of
-- them redefines the objects listed above.
--
-- ── BREAKING CHANGES FOR THE CLIENT ─────────────────────────────────────────
--   1. The kameti witness token is now stored as a SHA-256 hash and is
--      SERVER-GENERATED. `committeesDb.update({ shareToken })`
--      (src/lib/supabaseDb.ts:2437) now RAISES
--      `committees: WITNESS_TOKEN_IS_SERVER_ONLY`. The client must call
--      `rotate_committee_witness_token(p_committee_id)` instead
--      (src/stores/committeeStore.ts:154-161 `ensureShareToken`).
--      Existing shared links KEEP WORKING — §7.2 hashes them in place.
--   2. `committees.share_token` is nulled by §7.2. Any client that reads it to
--      re-display an existing link will now show nothing; the raw token is, by
--      design, no longer recoverable from the database. Re-share requires a
--      rotate (which invalidates the old link — that is the feature).
--   3. Receipt uploads larger than 5 MiB, or whose declared MIME is outside
--      {image/jpeg, image/png, image/webp, application/pdf}, are now rejected
--      by Storage. `uploadReceipt` (src/lib/receiptStorage.ts:67-75) has no
--      user-facing message for that failure yet.
-- Everything else in this file is additive or invisible to an un-updated
-- client: block/report are new tables the client does not yet know about, and
-- every block check reuses an EXISTING status value in the RPC it lives in.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT THIS FIXES — evidence
-- ════════════════════════════════════════════════════════════════════════════
--
-- M17 (docs/audit-2026-09/05-security.md:352) — "No abuse controls anywhere:
--   no block, mute, report, or unsubscribe." Evidence: src/lib/i18n.ts has no
--   block/mute/report strings; phase2b-linked-requests.sql:41-45 and
--   p0-launch-blockers.sql:150-161 show declining is per-item, so a rejected
--   loan request can be re-sent indefinitely and a force-added group cannot be
--   muted. Recommended fix, verbatim: "A `blocks` table checked by every
--   cross-user RPC/trigger, plus block/report actions on inbox items."
--   → §1 (tables + helpers), §2-§5 (every cross-user entry point).
--
-- M13 (05-security.md:313) / F-ST1 (04-supabase.md:232) — the receipts bucket
--   is created with no file_size_limit and no allowed_mime_types
--   (supabase-migration-receipts.sql:14-17), and `delete_current_user()` never
--   touches storage.objects, so a deleted user's receipt photos (financial PII)
--   persist indefinitely.
--   → §8.
--
-- M19 (05-security.md:372) / UX-24 (06-user-experience.md:107) / F-20 — the
--   kameti witness token is stored PLAINTEXT (committees-phase2.sql:13),
--   matched by plaintext equality (:28, and again at
--   audit-p0-kameti-draw.sql:364), granted to anon, never expires, and has no
--   revoke or rotate path anywhere in the repo
--   (src/stores/committeeStore.ts:154-161 is the only token API). The URL is
--   printed into every payout-slip PDF (src/lib/kametiSlipPdf.ts:72-79), which
--   is forwarded outside the circle by design — so one escaped copy is
--   permanent anonymous access to member names, slots, paid/unpaid status and
--   payout history.
--   → §7 (hash at rest, 90-day expiry, revoke, rotate, initials-only).
--
-- UX-13 (06-user-experience.md:70) — "Rejecting a linked request supports no
--   reason — the UI renders a field that can never be populated."
--   FINDING ON RE-READ: this is a CLIENT-ONLY gap. Both reject RPCs have
--   accepted `reason text default null` and written it to
--   `rejection_reason` since April (phase2b-linked-requests.sql:235,253 and
--   fix-settlement-cancel-reject.sql:76,98); the column exists on both tables
--   (phase2b:18, phase2c-a:171, fix-bidirectional:29). InboxPage.tsx:400-418
--   simply never sends it. NO new column is added — see §6 for why adding a
--   second `reject_reason` column would have been a bug.
--   → §6 normalises and bounds the reason instead (it is a cross-user free-text
--     channel, i.e. an M17 harassment surface of its own).
--
-- H10 (05-security.md:175) — phone claims are unverified. SMS OTP is out of
--   scope here. What IS in scope: a blocked user must not be able to find the
--   blocker through discovery.
--   → §5.
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE BLOCK MODEL — the three rules every check below implements
-- ════════════════════════════════════════════════════════════════════════════
--
-- RULE 1 — A BLOCK IS ONE-SIDED AND SILENT.
--   The blocked party is never told. Every refusal reuses a status value that
--   already existed in that RPC for an innocent cause, so "blocked" is
--   indistinguishable from "wrong code" / "not discoverable" / "invite
--   withdrawn". Where the CALLER is the blocker, the caller already knows, so a
--   distinct status is returned — that leaks nothing and is better UX.
--   Consequence: `blocks` has no SELECT policy for the blocked party, and
--   `is_blocked_either_way` / `has_blocked` are REVOKED from every client role.
--   Granting a client ANY function that answers "is this pair blocked" would
--   turn the whole model into an oracle, so there is deliberately no such RPC.
--
-- RULE 2 — A BLOCK STOPS NEW RELATIONSHIPS, NOT EXISTING DEBTS.
--   Blocking must never become a way to trap or evade money that is already
--   recorded. So:
--     BLOCKED: new contact links (either direction), new linked LOAN requests
--       and their acceptance, joining/being added to a group the blocker OWNS,
--       discovery by phone or by profile code, and notifications between the
--       pair.
--     NOT BLOCKED: settling an EXISTING linked loan pair
--       (linked_settlement_requests — see §3.3), reading a shared group ledger
--       the user is already a member of, and any row either side already owns.
--   If settlement requests were blocked, one party could block the other to
--   freeze a debt in place — the exact opposite of what a trust product should
--   do, and a worse harm than the one blocking solves.
--
-- RULE 3 — A BLOCK IS NOT A DELETION.
--   Existing contact rows, loans, group memberships, ledger rows and already
--   delivered notifications are untouched. Blocking is about what happens NEXT.
--   Unblocking (DELETE FROM blocks) restores everything with no side effects.
--
-- ════════════════════════════════════════════════════════════════════════════
-- MINI-DIFF — every line that differs from the source definition
-- (same discipline as supabase-migration-audit-p0-settlement-row-locks.sql)
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── link_contact_by_code(TEXT, TEXT) ────────────────────────────────────────
--    SOURCE: audit-p0-consent-guards.sql:557-653. Every declare, every status
--    string, the shape check, the caller-side validation, the shared
--    code_lookup_attempts window and the MISSES-ONLY charging rule are
--    byte-identical. ONE change:
--    [C1] INSERTED between the `v_target = v_uid` self-link check (source :635)
--         and the CONTACT_ALREADY_LINKED check (source :644):
--             IF public.has_blocked(v_uid, v_target) THEN
--               RETURN jsonb_build_object('status', 'BLOCKED_BY_YOU');
--             END IF;
--             IF public.has_blocked(v_target, v_uid) THEN
--               INSERT INTO public.code_lookup_attempts(user_id) VALUES (v_uid);
--               RETURN jsonb_build_object('status', 'NO_MATCH');
--             END IF;
--         Placed AFTER the self-check so CANNOT_LINK_SELF still wins, and
--         BEFORE the already-linked check so a blocked pair never reports the
--         state of the caller's own row back at them.
--         Charging: the blocked-caller branch charges exactly 1, identical to
--         the NO_MATCH branch it impersonates — the 20/hour ceiling is
--         unchanged. The blocker branch charges nothing (a resolved code is not
--         a guess, matching source :624-631).
--
-- ── link_contact_by_discovery(TEXT, UUID) ───────────────────────────────────
--    SOURCE: audit-p0-consent-guards.sql:717-813. Byte-identical including the
--    phone_e164_candidates re-derivation and the phone_lookup_attempts window.
--    ONE change:
--    [D1] INSERTED immediately after the `IF v_target IS NULL` NO_MATCH branch
--         (source :805-809), before the apply_verified_contact_link tail:
--             IF public.has_blocked(v_uid, v_target) THEN
--               RETURN jsonb_build_object('status', 'BLOCKED_BY_YOU');
--             END IF;
--             IF public.has_blocked(v_target, v_uid) THEN
--               INSERT INTO public.phone_lookup_attempts(user_id) VALUES (v_uid);
--               RETURN jsonb_build_object('status', 'NO_MATCH');
--             END IF;
--         Same charging symmetry as [C1], against the PHONE window (source
--         :707-716 explains why this RPC belongs to that budget, unchanged).
--
-- ── notify_contact_linked(UUID) ─────────────────────────────────────────────
--    SOURCE: connections-push-discovery.sql:81-179. Byte-identical including
--    the "caller must have linked the target" raise, the mutual-detection
--    branch, the declined-re-open rule and both notification bodies. ONE change:
--    [N1] INSERTED into the existing early-return guard (source :91-93), which
--         goes from
--             if target_profile_id is null or target_profile_id = auth.uid() then
--         to the same test plus
--             or public.is_blocked_either_way(auth.uid(), target_profile_id)
--         Silent return, exactly like the self-notify case: no
--         contact_link_requests row, no notification. Symmetric (either
--         direction) because this function only ever ASKS, and neither side
--         wants an ask from the other.
--
-- ── respond_contact_link(TEXT, BOOLEAN) ─────────────────────────────────────
--    SOURCE: connections-push-discovery.sql:194-289. Byte-identical including
--    the NOT_FOUND / NOT_YOURS / ALREADY_DECLINED / ALREADY_ACCEPTED terminal
--    replays and the un-archive rule. ONE change:
--    [R1] INSERTED after the ALREADY_ACCEPTED replay (source :226) and before
--         the `if not p_accept` decline branch:
--             if public.has_blocked(auth.uid(), v_req.from_user_id) then
--               return query select false, 'BLOCKED'::text, null::text; return;
--             end if;
--             if public.has_blocked(v_req.from_user_id, auth.uid()) then
--               update public.contact_link_requests
--                  set status = 'declined', responded_at = v_now
--                where id = p_request_id;
--               return query select true, 'DECLINED'::text, null::text; return;
--             end if;
--         Asymmetric on purpose (RULE 1): the responder-is-blocker case names
--         the block (they already know); the responder-is-blocked case is
--         byte-identical to them having pressed "Not now" themselves — no
--         person row, no notification back to the blocker.
--
-- ── tg_ltr_validate_insert() ────────────────────────────────────────────────
--    SOURCE: cross-user-account-effects.sql:57-140. Every raise string, the
--    whole pre_existing_loan_id block and the requester-account validation are
--    byte-identical. ONE change:
--    [T1] INSERTED after the `ltr: person not linked to target user` check
--         (source :77-79), before the pre-existing-loan block:
--             if public.is_blocked_either_way(new.from_user_id, new.to_user_id) then
--               raise exception 'ltr: recipient is not accepting requests';
--             end if;
--         Symmetric raise, neutral wording (it reads the same as a future
--         "requests off" preference, so it is not uniquely a block signal). A
--         loan request cannot be silently swallowed: doing so would leave the
--         sender with a request that is pending forever, and the sender's own
--         ledger is not written until accept, so there is nothing to falsify by
--         refusing loudly.
--
-- ── join_group_by_code(TEXT, TEXT) ──────────────────────────────────────────
--    SOURCE: audit-p0-join-abuse-limits.sql:162-255. Byte-identical including
--    the 5-failures/5-minutes window, the pruning DELETE, the expiry test and
--    the member insert/upsert branch. ONE change:
--    [J1] INSERTED between the CANNOT_JOIN_OWN_GROUP check (source :219-222)
--         and the member lookup (source :224):
--             IF public.is_blocked_either_way(v_uid, v_group.user_id) THEN
--               INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false);
--               RETURN jsonb_build_object('status', 'INVALID_OR_EXPIRED_CODE');
--             END IF;
--         Byte-identical to a wrong/expired code, AND charged to the window the
--         same way — so the response, the attempt row and the rate accounting
--         are all indistinguishable from a miss.
--         WHY THE OWNER, AND ONLY THE OWNER: a group belongs to its owner, so a
--         blocked pair must not be forced to co-own it. But a blocker who is
--         MERELY A MEMBER gets no veto, for two reasons. (a) Correctness: they
--         do not control the group, and letting one member silently exclude
--         arbitrary others from someone else's group is a bigger abuse surface
--         than the one it closes. (b) Privacy: a join that failed because of a
--         member's block would tell the joiner exactly who is inside a group
--         they cannot see — a membership oracle (the same shape as M16). The
--         victim is still protected inside that group: §4.4 stops every
--         notification between the pair, so they are never pushed the
--         harasser's activity.
--
-- ── accept_group_invite(TEXT, TEXT) ─────────────────────────────────────────
--    SOURCE: audit-p0-consent-guards.sql:1513-1622. Byte-identical including
--    the server-side hash, the 10-failures/15-minutes window, the guest-seat
--    rebind via linked_member_id and the was_already_connected rule. TWO
--    changes, one of them a declare:
--    [I1] ADDED declare:  v_owner UUID;
--    [I2] INSERTED after the invite row is found and locked (source :1568-1572,
--         the INVITE_NOT_FOUND_OR_EXPIRED branch) and before the member lookup:
--             SELECT g.user_id INTO v_owner
--               FROM public.split_groups g WHERE g.id = v_invite.group_id;
--             IF v_owner IS NOT NULL AND public.is_blocked_either_way(v_uid, v_owner) THEN
--               INSERT INTO public.invite_accept_attempts(user_id, succeeded) VALUES (v_uid, false);
--               RETURN jsonb_build_object('status', 'INVITE_NOT_FOUND_OR_EXPIRED');
--             END IF;
--         Same status, same failure row, same accounting as a dead token.
--         `v_invite.created_by` is deliberately NOT checked — an invite issued
--         by a mere member is the "merely a member" case argued under [J1].
--
-- ── accept_group_membership(TEXT) ───────────────────────────────────────────
--    SOURCE: audit-p0-consent-guards.sql:1139-1200. Byte-identical including
--    the ALREADY_CONNECTED idempotent replay and the "only 'invited' is
--    acceptable" rule. TWO changes, one of them a declare:
--    [M1] ADDED declare:  v_owner UUID;
--    [M2] INSERTED after the `v_member.status <> 'invited'` check (source
--         :1182-1187) and before the UPDATE:
--             SELECT g.user_id INTO v_owner
--               FROM public.split_groups g WHERE g.id = v_member.group_id;
--             IF v_owner IS NOT NULL AND public.is_blocked_either_way(v_uid, v_owner) THEN
--               RETURN jsonb_build_object(
--                 'success', false, 'reason_code', 'NO_PENDING_INVITE',
--                 'user_message', 'This invitation is no longer available.'
--               );
--             END IF;
--         Reuses the existing NO_PENDING_INVITE object verbatim — a blocked
--         invite is indistinguishable from a withdrawn one.
--         NOTE: decline_group_membership is deliberately NOT guarded. Refusing
--         must always work, unconditionally (that is its whole reason for
--         existing separately from leave_group, source :1216-1226).
--
-- ── fan_out_group_notification(TEXT,UUID,TEXT,TEXT,TEXT,TEXT,JSONB,UUID[],TEXT)
--    SOURCE: audit-p0-notifications.sql:223-342. Byte-identical including both
--    caps, the actor-name resolution, the unconditional group_events write and
--    the per-actor rate limit. ONE change:
--    [F1] ADDED one predicate to the recipient subquery (source :331-340):
--             AND NOT public.is_blocked_either_way(p_actor, gm.profile_id)
--         The group_events row is still written unconditionally — it is the
--         durable shared ledger and must not develop per-viewer holes; only the
--         notification (and therefore the push) is suppressed. Because the
--         predicate sits inside the subquery, a suppressed recipient no longer
--         consumes one of the c_max_recipients=100 slots. `p_actor` may be
--         NULL (system events); is_blocked_either_way(NULL, x) is false, so
--         those fan out unchanged.
--
-- ── lookup_hisaab_users_by_phone(TEXT[]) ────────────────────────────────────
--    SOURCE: connections-push-discovery.sql:323-361. Byte-identical including
--    the 60-number cap, the three raises and the 20/hour window that is charged
--    BEFORE the query. ONE change:
--    [P1] ADDED one predicate to the final SELECT (source :356-360):
--             and not public.is_blocked_either_way(auth.uid(), p.id)
--         The blocker simply does not appear in the result set —
--         indistinguishable from `phone_discoverable = false`. Rate accounting
--         is untouched because the charge happens before the query either way.
--
-- ── lookup_profile_by_code(TEXT) ────────────────────────────────────────────
--    SOURCE: audit-p0-join-abuse-limits.sql:270-312. Byte-identical including
--    "every non-answer is the same non-answer: zero rows" and the
--    charged-before-the-lookup rule. ONE change:
--    [L1] ADDED one predicate to the RETURN QUERY (source :304-310):
--             AND NOT public.is_blocked_either_way(v_uid, p.id)
--         Zero rows, exactly like a bad code or a throttled caller.
--
-- ── reject_linked_request(TEXT, TEXT) / reject_settlement_request(TEXT, TEXT)
--    SOURCES: phase2b-linked-requests.sql:235-259 and
--    fix-settlement-cancel-reject.sql:76-104. Signatures, ownership checks,
--    terminal-state replays and FOR UPDATE locks are byte-identical. ONE change
--    in each:
--    [X1] the assignment
--             rejection_reason = reason,
--         becomes
--             rejection_reason = left(nullif(btrim(coalesce(reason, '')), ''), 500),
--         so an all-whitespace reason stores NULL (the client renders the field
--         only when it is non-null) and the free-text channel is bounded.
--
-- ── get_committee_witness(TEXT) ─────────────────────────────────────────────
--    SOURCE: audit-p0-kameti-draw.sql:354-392 (NOT committees-phase2.sql:18-55
--    — kameti-draw replaced it to add 'drawScheme'). The committee payload keys,
--    the members ordering and the payments aggregate are byte-identical. FOUR
--    changes, all in §7.4 and all part of the M19 lifecycle:
--    [W1] the lookup becomes `where share_token_hash = public.hash_witness_token(p_token)`
--    [W2] a revoked / expired token returns NULL, exactly like a bad one
--    [W3] member `name` becomes `case when v.witness_initials_only then
--         public.witness_initials(m.name) else m.name end`
--    [W4] two new committee keys: 'witnessExpiresAt', 'initialsOnly'
--
-- ── delete_current_user() ───────────────────────────────────────────────────
--    SOURCE: audit-p0-account-deletion.sql:551-683. The owner guard, the
--    per-group member_account_deleted announcement loop, the solo-group DELETE,
--    the re-check, the profile scrub and the auth.users delete are
--    byte-identical. ONE change:
--    [E1] INSERTED between the profile scrub (source :666-672) and
--         `DELETE FROM auth.users` (source :678) — see §8.3 for the body and
--         for the storage-API caveat.
--
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 0. pgcrypto (digest / gen_random_bytes for the witness token)
-- Same guarded pattern as audit-p0-consent-guards.sql:1365-1378.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    BEGIN
      CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
    EXCEPTION WHEN OTHERS THEN
      CREATE EXTENSION pgcrypto;
    END;
  END IF;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 1. The primitives: blocks, reports, and the two definer helpers
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1.1 blocks ──────────────────────────────────────────────────────────────
-- One row = "blocker_id no longer wants anything new from blocked_id".
-- The PK is the pair, so blocking twice is a no-op the client can retry.
-- Both FKs cascade: when either account is deleted the row is meaningless.
--   CAVEAT (documented, not fixable here): blocks are keyed on auth user ids,
--   so a harasser who deletes and re-registers gets a fresh id and a clean
--   slate. Phone-level blocking would need H10's OTP work first.
CREATE TABLE IF NOT EXISTS public.blocks (
  blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_not_self CHECK (blocker_id <> blocked_id)
);

-- The PK covers (blocker_id, …). This index serves the OTHER direction, which
-- is the one is_blocked_either_way needs on every cross-user call.
CREATE INDEX IF NOT EXISTS idx_blocks_blocked
  ON public.blocks(blocked_id, blocker_id);

ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

-- Three policies, all pinned to blocker_id = auth.uid(). There is deliberately
-- NO policy naming blocked_id: the blocked party must never be able to read,
-- count or infer a row about themselves (RULE 1), and no UPDATE policy either
-- — changing a reason is DELETE + INSERT, which keeps created_at honest.
DROP POLICY IF EXISTS blocks_select_own ON public.blocks;
CREATE POLICY blocks_select_own ON public.blocks
  FOR SELECT USING (blocker_id = auth.uid());

DROP POLICY IF EXISTS blocks_insert_own ON public.blocks;
CREATE POLICY blocks_insert_own ON public.blocks
  FOR INSERT WITH CHECK (blocker_id = auth.uid());

DROP POLICY IF EXISTS blocks_delete_own ON public.blocks;
CREATE POLICY blocks_delete_own ON public.blocks
  FOR DELETE USING (blocker_id = auth.uid());

REVOKE ALL ON public.blocks FROM PUBLIC, anon;
GRANT SELECT, INSERT, DELETE ON public.blocks TO authenticated;

-- Bound the free-text reason the same way §6 bounds a rejection reason.
CREATE OR REPLACE FUNCTION public.tg_blocks_normalize()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.reason     := left(nullif(btrim(coalesce(NEW.reason, '')), ''), 500);
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS blocks_normalize ON public.blocks;
CREATE TRIGGER blocks_normalize
  BEFORE INSERT ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.tg_blocks_normalize();

COMMENT ON TABLE public.blocks IS
  'Audit M17: one-sided, silent block list. A row means blocker_id refuses NEW interaction from blocked_id. Readable and writable only by the blocker; the blocked party can never observe a row (see supabase-migration-p2-trust-safety.sql RULE 1). Existing debts are NOT frozen by a block (RULE 2).';

-- ── 1.2 reports ─────────────────────────────────────────────────────────────
-- Write-only for clients. There is no SELECT policy at all, so PostgREST
-- returns zero rows to `authenticated` no matter what; only service_role and
-- Studio (which bypass RLS) can read them. This is a deliberate design choice:
-- a readable report table would tell a harasser they had been reported.
--
-- Both user FKs are ON DELETE SET NULL, not CASCADE — a report must outlive the
-- accounts involved, otherwise a reported user deletes their account and erases
-- the operator's only record of why.
CREATE TABLE IF NOT EXISTS public.reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reported_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- What the report is ABOUT, so the operator can find it in Studio.
  -- Free-form on purpose (a CHECK here would need a migration every time the
  -- client grows a new surface); §1.2's trigger bounds the length instead.
  context_type TEXT,
  context_id   TEXT,
  reason       TEXT,
  details      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Operator triage marker. No client can read or write it (no SELECT/UPDATE
  -- policy); it exists so a human working the queue in Studio can tell handled
  -- from unhandled without a second tool.
  reviewed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reports_reported_time
  ON public.reports(reported_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_open
  ON public.reports(created_at DESC) WHERE reviewed_at IS NULL;

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reports_insert_self ON public.reports;
CREATE POLICY reports_insert_self ON public.reports
  FOR INSERT WITH CHECK (reporter_id = auth.uid());

-- No SELECT / UPDATE / DELETE policy exists, on purpose.
REVOKE ALL ON public.reports FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.reports TO authenticated;

-- Normalise, bound, and rate-limit. The reason this is a trigger and not an
-- RPC: the client's contract is a plain PostgREST INSERT, which cannot be
-- turned into a flood without hitting the cap below.
CREATE OR REPLACE FUNCTION public.tg_reports_validate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Twenty reports a day is far above any honest use and far below what it
  -- takes to bury an operator's queue or the project's row quota.
  c_max_per_day CONSTANT INTEGER := 20;
  v_recent INTEGER;
BEGIN
  IF NEW.reporter_id IS NULL OR NEW.reporter_id <> auth.uid() THEN
    RAISE EXCEPTION 'reports: reporter_id must be the caller' USING ERRCODE = '42501';
  END IF;
  IF NEW.reported_id IS NOT NULL AND NEW.reported_id = NEW.reporter_id THEN
    RAISE EXCEPTION 'reports: cannot report yourself' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_recent
    FROM public.reports r
   WHERE r.reporter_id = NEW.reporter_id
     AND r.created_at > now() - INTERVAL '1 day';
  IF v_recent >= c_max_per_day THEN
    RAISE EXCEPTION 'reports: REPORT_RATE_LIMITED' USING ERRCODE = '53400';
  END IF;

  NEW.context_type := left(nullif(btrim(coalesce(NEW.context_type, '')), ''), 64);
  NEW.context_id   := left(nullif(btrim(coalesce(NEW.context_id, '')), ''), 128);
  NEW.reason       := left(nullif(btrim(coalesce(NEW.reason, '')), ''), 128);
  NEW.details      := left(nullif(btrim(coalesce(NEW.details, '')), ''), 2000);
  NEW.created_at   := now();
  NEW.reviewed_at  := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reports_validate ON public.reports;
CREATE TRIGGER reports_validate
  BEFORE INSERT ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.tg_reports_validate();

COMMENT ON TABLE public.reports IS
  'Audit M17: user-to-user abuse reports. INSERT-only for clients (no SELECT policy at all, so a harasser can never learn they were reported); reviewed in Supabase Studio / by service_role. Capped at 20 per reporter per day. Reporting does NOT block — the client should offer both.';

-- ── 1.3 The two helpers every check below uses ──────────────────────────────
-- BOTH are SECURITY DEFINER (they must see rows RLS hides from the caller) and
-- BOTH are revoked from every client role. That revoke is load-bearing, not
-- hygiene: any client-callable function answering "is this pair blocked" would
-- hand the blocked party the exact bit RULE 1 exists to withhold. Every caller
-- below is itself SECURITY DEFINER (or a SECURITY DEFINER trigger), so none of
-- them needs a client grant.

CREATE OR REPLACE FUNCTION public.is_blocked_either_way(a UUID, b UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a IS NOT NULL
     AND b IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.blocks AS bl
        WHERE (bl.blocker_id = a AND bl.blocked_id = b)
           OR (bl.blocker_id = b AND bl.blocked_id = a)
     );
$$;

REVOKE ALL ON FUNCTION public.is_blocked_either_way(UUID, UUID)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.is_blocked_either_way(UUID, UUID) IS
  'Audit M17: TRUE when either user has blocked the other. NEVER grant to a client role — it is the oracle the one-sided block model exists to prevent.';

CREATE OR REPLACE FUNCTION public.has_blocked(p_blocker UUID, p_blocked UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_blocker IS NOT NULL
     AND p_blocked IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.blocks AS bl
        WHERE bl.blocker_id = p_blocker
          AND bl.blocked_id = p_blocked
     );
$$;

REVOKE ALL ON FUNCTION public.has_blocked(UUID, UUID)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.has_blocked(UUID, UUID) IS
  'Audit M17: directional half of is_blocked_either_way. Used where the answer differs depending on WHICH side blocked (the blocker may be told; the blocked party never is). NEVER grant to a client role.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2. Enforcement — contact linking
-- ════════════════════════════════════════════════════════════════════════════

-- ── 2.1 link_contact_by_code — mini-diff [C1] ───────────────────────────────
CREATE OR REPLACE FUNCTION public.link_contact_by_code(
  p_person_id       TEXT,
  p_code_normalized TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_now       TIMESTAMPTZ := now();
  v_person    public.persons%ROWTYPE;
  v_target    UUID;
  v_name      TEXT;
  v_recent    INTEGER;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  -- Shape check first: no lookup happens, so this leaks nothing and must not
  -- be charged. Public codes are 6 chars over a 32-symbol alphabet once
  -- normalizePublicCode has stripped the HSB- prefix
  -- (src/lib/collaboration.ts:1,13-14,24-26).
  IF p_code_normalized IS NULL OR length(p_code_normalized) <> 6 THEN
    RETURN jsonb_build_object('status', 'INVALID_CODE');
  END IF;

  -- Caller-side validation next — still no code lookup, still uncharged.
  SELECT * INTO v_person
    FROM public.persons AS p
   WHERE p.id = p_person_id
     AND p.user_id = v_uid
   FOR UPDATE;

  IF v_person.id IS NULL THEN
    RETURN jsonb_build_object('status', 'CONTACT_NOT_FOUND');
  END IF;
  IF v_person.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'CONTACT_ARCHIVED');
  END IF;

  -- ── Rate window ───────────────────────────────────────────────────────────
  -- Shared with lookup_profile_by_code on purpose. This RPC resolves a public
  -- code, so an unshared window here would be a second validity oracle over
  -- the same 32^6 keyspace and would defeat the sibling migration's H9 fix.
  DELETE FROM public.code_lookup_attempts AS cla
   WHERE cla.attempted_at < v_now - INTERVAL '1 hour';

  SELECT count(*) INTO v_recent
    FROM public.code_lookup_attempts AS cla
   WHERE cla.user_id = v_uid
     AND cla.attempted_at > v_now - INTERVAL '1 hour';
  IF v_recent >= 20 THEN
    -- Not recorded: a blocked call must not extend its own block.
    RETURN jsonb_build_object('status', 'RATE_LIMITED', 'retry_after_seconds', 3600);
  END IF;

  SELECT p.id, COALESCE(NULLIF(trim(p.name), ''), 'Hisaab user')
    INTO v_target, v_name
    FROM public.profiles AS p
   WHERE p.public_code_normalized = p_code_normalized
     AND COALESCE(p.is_deleted, false) = false
   LIMIT 1;

  IF v_target IS NULL THEN
    -- CHARGED HERE AND ONLY HERE. See the CHARGING RULE note in the header:
    -- the client has already spent one lookup rendering the confirm-name
    -- preview for this same code, so charging a resolved code again cost every
    -- honest link 2 of 20 while buying nothing — a code that RESOLVES is not a
    -- guess an attacker can iterate. A code that does NOT resolve is, and it
    -- still costs exactly 1 whichever entry point burned it, so the ceiling on
    -- guesses per hour is unchanged at 20.
    -- Committed because we RETURN instead of RAISEing (audit H1).
    INSERT INTO public.code_lookup_attempts(user_id) VALUES (v_uid);
    RETURN jsonb_build_object('status', 'NO_MATCH');
  END IF;
  IF v_target = v_uid THEN
    RETURN jsonb_build_object('status', 'CANNOT_LINK_SELF');
  END IF;

  -- ── [C1] Audit M17 block gate. ────────────────────────────────────────────
  -- Caller is the blocker: they already know, so say so plainly and charge
  -- nothing (a resolved code is not a guess).
  IF public.has_blocked(v_uid, v_target) THEN
    RETURN jsonb_build_object('status', 'BLOCKED_BY_YOU');
  END IF;
  -- Caller is the blocked party: byte-identical to a code that resolves to
  -- nobody, INCLUDING the attempt row, so the block is unobservable.
  IF public.has_blocked(v_target, v_uid) THEN
    INSERT INTO public.code_lookup_attempts(user_id) VALUES (v_uid);
    RETURN jsonb_build_object('status', 'NO_MATCH');
  END IF;

  -- Re-pointing a LIVE link at a different user would silently move
  -- loan/settlement consent from one real person to another, so that is
  -- refused and the caller must unlink first. Re-linking to the SAME target is
  -- a no-op replay (double tap, two devices) and falls through to the normal
  -- success path so notify_contact_linked's own dedup decides what to do.
  IF v_person.linked_profile_id IS NOT NULL
     AND v_person.linked_profile_id <> v_target THEN
    RETURN jsonb_build_object('status', 'CONTACT_ALREADY_LINKED');
  END IF;

  -- Proof accepted. Everything past this point is identical for both link
  -- paths and lives in exactly one place (1.2).
  RETURN public.apply_verified_contact_link(v_person.id, v_target, v_name);
END;
$$;

REVOKE ALL ON FUNCTION public.link_contact_by_code(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_contact_by_code(TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.link_contact_by_code(TEXT, TEXT) IS
  'Audit H2/SEC-04 + M17: verifies the target public code server-side, refuses a blocked pair (BLOCKED_BY_YOU to the blocker; NO_MATCH, charged, to the blocked party), shares the code_lookup_attempts window with lookup_profile_by_code, and defers the reciprocal side to apply_verified_contact_link -> notify_contact_linked.';

-- ── 2.2 link_contact_by_discovery — mini-diff [D1] ──────────────────────────
CREATE OR REPLACE FUNCTION public.link_contact_by_discovery(
  p_person_id  TEXT,
  p_profile_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_now        TIMESTAMPTZ := now();
  v_person     public.persons%ROWTYPE;
  v_candidates TEXT[];
  v_target     UUID;
  v_name       TEXT;
  v_recent     INTEGER;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  -- Shape check: nothing is looked up, so nothing is charged. There is no
  -- INVALID_CODE here (there is no code), and a null id is indistinguishable
  -- from "the badge resolved to nobody", so it reports NO_MATCH.
  IF p_profile_id IS NULL THEN
    RETURN jsonb_build_object('status', 'NO_MATCH');
  END IF;

  -- Uncharged: the caller already knows their own id, so this leaks nothing.
  IF p_profile_id = v_uid THEN
    RETURN jsonb_build_object('status', 'CANNOT_LINK_SELF');
  END IF;

  -- Caller-side validation next — still no lookup against anyone else's row,
  -- so still uncharged.
  SELECT * INTO v_person
    FROM public.persons AS p
   WHERE p.id = p_person_id
     AND p.user_id = v_uid
   FOR UPDATE;

  IF v_person.id IS NULL THEN
    RETURN jsonb_build_object('status', 'CONTACT_NOT_FOUND');
  END IF;
  IF v_person.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'CONTACT_ARCHIVED');
  END IF;

  -- Same rule as 1.4: re-pointing a LIVE link at a different user would
  -- silently move loan/settlement consent from one real person to another.
  -- Re-linking to the SAME target is a no-op replay (double tap, two devices)
  -- and falls through so notify_contact_linked's own dedup decides.
  IF v_person.linked_profile_id IS NOT NULL
     AND v_person.linked_profile_id <> p_profile_id THEN
    RETURN jsonb_build_object('status', 'CONTACT_ALREADY_LINKED');
  END IF;

  -- ── Rate window (phone discovery's, not the code window) ──────────────────
  DELETE FROM public.phone_lookup_attempts AS pla
   WHERE pla.attempted_at < v_now - INTERVAL '1 hour';

  SELECT count(*) INTO v_recent
    FROM public.phone_lookup_attempts AS pla
   WHERE pla.user_id = v_uid
     AND pla.attempted_at > v_now - INTERVAL '1 hour';
  IF v_recent >= 20 THEN
    -- Not recorded: a blocked call must not extend its own block.
    RETURN jsonb_build_object('status', 'RATE_LIMITED', 'retry_after_seconds', 3600);
  END IF;

  -- THE verification. The client's pairing is never consulted beyond naming
  -- the profile to test; the numbers come from the caller's OWN contact row.
  v_candidates := public.phone_e164_candidates(v_person.phone);

  IF array_length(v_candidates, 1) IS NOT NULL THEN
    SELECT pr.id, COALESCE(NULLIF(trim(pr.name), ''), 'Hisaab user')
      INTO v_target, v_name
      FROM public.profiles AS pr
     WHERE pr.id = p_profile_id
       AND pr.phone_discoverable
       AND pr.phone_e164 IS NOT NULL
       AND pr.phone_e164 = ANY (v_candidates)
       AND pr.id <> v_uid
       AND COALESCE(pr.is_deleted, false) = false
     LIMIT 1;
  END IF;

  IF v_target IS NULL THEN
    -- Charged: this is the one branch an attacker could iterate.
    INSERT INTO public.phone_lookup_attempts(user_id) VALUES (v_uid);
    RETURN jsonb_build_object('status', 'NO_MATCH');
  END IF;

  -- ── [D1] Audit M17 block gate. Same asymmetry and same charging symmetry as
  -- link_contact_by_code, against the PHONE window this RPC belongs to.
  IF public.has_blocked(v_uid, v_target) THEN
    RETURN jsonb_build_object('status', 'BLOCKED_BY_YOU');
  END IF;
  IF public.has_blocked(v_target, v_uid) THEN
    INSERT INTO public.phone_lookup_attempts(user_id) VALUES (v_uid);
    RETURN jsonb_build_object('status', 'NO_MATCH');
  END IF;

  RETURN public.apply_verified_contact_link(v_person.id, v_target, v_name);
END;
$$;

REVOKE ALL ON FUNCTION public.link_contact_by_discovery(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_contact_by_discovery(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.link_contact_by_discovery(TEXT, UUID) IS
  'Audit H2/SEC-04 + M17: the code-less link path. Re-runs lookup_hisaab_users_by_phone''s own match server-side, then refuses a blocked pair (BLOCKED_BY_YOU to the blocker; NO_MATCH, charged to phone_lookup_attempts, to the blocked party).';

-- ── 2.3 notify_contact_linked — mini-diff [N1] ──────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_contact_linked(target_profile_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_caller_name  text;
  v_existing_id  text;
  v_req_id       text;
  v_req_status   text;
  v_now          timestamptz := now();
begin
  -- [N1] `or public.is_blocked_either_way(...)` added to the existing guard.
  -- Symmetric: this function only ever ASKS, and neither side of a blocked
  -- pair wants an ask from the other. Silent, like the self-notify case.
  if target_profile_id is null
     or target_profile_id = auth.uid()
     or public.is_blocked_either_way(auth.uid(), target_profile_id) then
    return;
  end if;

  -- Anti-abuse: the caller must actually have linked the target (a persons
  -- row of theirs points at it). You can only connect-back someone you added.
  if not exists (
    select 1 from public.persons p
     where p.user_id = auth.uid()
       and p.linked_profile_id = target_profile_id
  ) then
    raise exception 'notify_contact_linked: caller is not linked to target';
  end if;

  select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_caller_name
    from public.profiles p where p.id = auth.uid();

  -- Already mutual? (Either they added the caller independently, or an
  -- earlier accept / the old auto-reciprocal migration already wrote the
  -- row.) Record it as accepted and stay silent about adding back — there
  -- is nothing to decide.
  select p.id into v_existing_id
    from public.persons p
   where p.user_id = target_profile_id
     and p.linked_profile_id = auth.uid()
   limit 1;

  select r.id, r.status into v_req_id, v_req_status
    from public.contact_link_requests r
   where r.from_user_id = auth.uid()
     and r.to_user_id = target_profile_id
   limit 1;

  if v_existing_id is not null then
    if v_req_id is null then
      insert into public.contact_link_requests(id, from_user_id, to_user_id, from_name, status, created_at, responded_at)
      values (gen_random_uuid()::text, auth.uid(), target_profile_id, v_caller_name, 'accepted', v_now, v_now)
      on conflict (from_user_id, to_user_id) do nothing;
    elsif v_req_status <> 'accepted' then
      update public.contact_link_requests
         set status = 'accepted', responded_at = v_now, from_name = v_caller_name
       where id = v_req_id;
    end if;

    insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
    values (
      gen_random_uuid()::text, target_profile_id, null, null, 'contact_linked',
      'New connection on Hisaab',
      v_caller_name || ' added you using your code — you''re now connected, and you can share loans or settle up either way.',
      v_now
    );
    return;
  end if;

  -- Not mutual yet → open (or re-open) the ask. A previously declined ask
  -- re-opens only because the caller deliberately linked again, which means
  -- unlinking and re-entering the code — not something that happens by
  -- accident, and not something the caller can repeat without the owner's
  -- code in hand.
  if v_req_id is null then
    v_req_id := gen_random_uuid()::text;
    begin
      insert into public.contact_link_requests(id, from_user_id, to_user_id, from_name, status, created_at)
      values (v_req_id, auth.uid(), target_profile_id, v_caller_name, 'pending', v_now);
    exception when unique_violation then
      select r.id, r.status into v_req_id, v_req_status
        from public.contact_link_requests r
       where r.from_user_id = auth.uid()
         and r.to_user_id = target_profile_id
       limit 1;
    end;
  elsif v_req_status = 'declined' then
    update public.contact_link_requests
       set status = 'pending', created_at = v_now, responded_at = null, from_name = v_caller_name
     where id = v_req_id;
  else
    -- Already pending — the owner has an un-actioned ask sitting there.
    -- Don't stack a second notification on top of it.
    return;
  end if;

  insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
  values (
    gen_random_uuid()::text, target_profile_id, null, null, 'contact_linked',
    'New connection on Hisaab',
    v_caller_name || ' added you using your Hisaab code. Add them to your contacts so you can share loans and settle up both ways.',
    v_now
  );
end $$;

REVOKE ALL ON FUNCTION public.notify_contact_linked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_contact_linked(uuid) TO authenticated;

COMMENT ON FUNCTION public.notify_contact_linked(uuid) IS
  'v3 + audit M17. Opens (or re-opens) the reciprocal contact_link_requests ask and its notification. Returns silently, writing nothing, when either party has blocked the other.';

-- ── 2.4 respond_contact_link — mini-diff [R1] ───────────────────────────────
CREATE OR REPLACE FUNCTION public.respond_contact_link(
  p_request_id text,
  p_accept     boolean
)
RETURNS TABLE(success boolean, reason_code text, person_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_req        public.contact_link_requests%rowtype;
  v_person_id  text;
  v_from_name  text;
  v_my_name    text;
  v_now        timestamptz := now();
begin
  select * into v_req from public.contact_link_requests where id = p_request_id;
  if not found then
    return query select false, 'NOT_FOUND'::text, null::text; return;
  end if;
  if v_req.to_user_id <> auth.uid() then
    return query select false, 'NOT_YOURS'::text, null::text; return;
  end if;

  -- Terminal replay: report the existing outcome rather than flipping it.
  if v_req.status = 'declined' then
    return query select p_accept = false, 'ALREADY_DECLINED'::text, null::text; return;
  end if;

  if v_req.status = 'accepted' then
    select p.id into v_person_id
      from public.persons p
     where p.user_id = auth.uid() and p.linked_profile_id = v_req.from_user_id
     limit 1;
    return query select true, 'ALREADY_ACCEPTED'::text, v_person_id; return;
  end if;

  -- ── [R1] Audit M17 block gate, placed before BOTH the decline and accept
  -- branches so a blocked pair can never produce a persons row or a
  -- notification.
  -- Responder is the blocker: name it. They already know.
  if public.has_blocked(auth.uid(), v_req.from_user_id) then
    return query select false, 'BLOCKED'::text, null::text; return;
  end if;
  -- Responder is the blocked party (the asker blocked them after asking):
  -- byte-identical to them having pressed "Not now" themselves. No contact
  -- row, and — critically — no "added you back" notification to the blocker.
  if public.has_blocked(v_req.from_user_id, auth.uid()) then
    update public.contact_link_requests
       set status = 'declined', responded_at = v_now
     where id = p_request_id;
    return query select true, 'DECLINED'::text, null::text; return;
  end if;

  if not p_accept then
    update public.contact_link_requests
       set status = 'declined', responded_at = v_now
     where id = p_request_id;
    return query select true, 'DECLINED'::text, null::text; return;
  end if;

  select coalesce(nullif(trim(p.name), ''), nullif(trim(v_req.from_name), ''), 'A Hisaab user')
    into v_from_name
    from public.profiles p where p.id = v_req.from_user_id;
  v_from_name := coalesce(nullif(trim(v_from_name), ''), nullif(trim(v_req.from_name), ''), 'A Hisaab user');
  select coalesce(nullif(trim(p.name), ''), 'A Hisaab user') into v_my_name
    from public.profiles p where p.id = auth.uid();

  -- Find-or-create against the Phase 2A unique partial index on
  -- (user_id, linked_profile_id) where not null — same shape as
  -- accept_linked_request so the two paths can never diverge.
  select p.id into v_person_id
    from public.persons p
   where p.user_id = auth.uid()
     and p.linked_profile_id = v_req.from_user_id
   limit 1;

  if v_person_id is null then
    v_person_id := gen_random_uuid()::text;
    begin
      insert into public.persons(id, user_id, name, phone, linked_profile_id, created_at, updated_at)
      values (v_person_id, auth.uid(), v_from_name, null, v_req.from_user_id, v_now, v_now);
    exception when unique_violation then
      select p.id into v_person_id
        from public.persons p
       where p.user_id = auth.uid()
         and p.linked_profile_id = v_req.from_user_id
       limit 1;
    end;
  end if;

  -- A contact the owner archived earlier must come back — otherwise the
  -- accept "succeeds" and the contact stays invisible.
  if v_person_id is not null then
    update public.persons
       set archived_at = null, updated_at = v_now
     where id = v_person_id
       and user_id = auth.uid()
       and archived_at is not null;
  end if;

  update public.contact_link_requests
     set status = 'accepted', responded_at = v_now
   where id = p_request_id;

  -- Close the loop for the adder: they asked, they get told.
  insert into public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
  values (
    gen_random_uuid()::text, v_req.from_user_id, null, null, 'contact_linked',
    'Connected on Hisaab',
    v_my_name || ' added you back — you''re connected both ways and can share loans or settle up.',
    v_now
  );

  return query select true, 'ACCEPTED'::text, v_person_id;
end $$;

REVOKE ALL ON FUNCTION public.respond_contact_link(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_contact_link(text, boolean) TO authenticated;

COMMENT ON FUNCTION public.respond_contact_link(text, boolean) IS
  'The owner''s Add / Not now on a contact-link ask, + audit M17. Adds reason_code BLOCKED when the responder has blocked the asker; silently DECLINEs (no person row, no notification) when the asker has blocked the responder.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3. Enforcement — linked money requests
-- ════════════════════════════════════════════════════════════════════════════

-- ── 3.1 tg_ltr_validate_insert — mini-diff [T1] ────────────────────────────
-- This trigger, not an RPC, is the actual insert path: there is no
-- create_linked_request RPC. The client INSERTs the row directly under the
-- ltr_insert_own policy (phase2b-linked-requests.sql:41-43), so the trigger is
-- the only place that sees every write.
CREATE OR REPLACE FUNCTION public.tg_ltr_validate_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_linked uuid;
  v_loan_owner uuid;
  v_loan_person text;
  v_loan_status text;
  v_loan_type text;
  v_acct public.accounts;
begin
  if new.from_user_id <> auth.uid() then
    raise exception 'ltr: from_user_id must be caller';
  end if;
  if new.from_user_id = new.to_user_id then
    raise exception 'ltr: self-link not allowed';
  end if;
  select p.linked_profile_id into v_linked
    from public.persons p
   where p.id = new.person_id
     and p.user_id = new.from_user_id;
  if v_linked is null or v_linked <> new.to_user_id then
    raise exception 'ltr: person not linked to target user';
  end if;

  -- [T1] Audit M17. A linked LOAN request is a NEW cross-user relationship
  -- (RULE 2), including the past-record sync path below, so a blocked pair may
  -- not open one in either direction. Wording is neutral on purpose: it reads
  -- identically to a future "not accepting requests" preference, so it is not
  -- uniquely a block signal. Refused loudly rather than swallowed, because a
  -- silently dropped request would sit "pending" in the sender's outbox
  -- forever; nothing is written to either ledger until accept, so there is no
  -- money record to falsify by refusing.
  if public.is_blocked_either_way(new.from_user_id, new.to_user_id) then
    raise exception 'ltr: recipient is not accepting requests';
  end if;

  -- Pre-existing loan path: extra invariants (Phase 2D, unchanged).
  if new.pre_existing_loan_id is not null then
    select l.user_id, l.person_id, l.status, l.type
      into v_loan_owner, v_loan_person, v_loan_status, v_loan_type
      from public.loans l
     where l.id = new.pre_existing_loan_id;
    if v_loan_owner is null then
      raise exception 'ltr: pre_existing_loan_id not found';
    end if;
    if v_loan_owner <> new.from_user_id then
      raise exception 'ltr: caller does not own pre_existing loan';
    end if;
    if v_loan_person is distinct from new.person_id then
      raise exception 'ltr: pre_existing loan person_id mismatch';
    end if;
    if v_loan_status <> 'active' then
      raise exception 'ltr: pre_existing loan must be active to sync';
    end if;
    if (new.kind = 'lent'    and v_loan_type <> 'given') or
       (new.kind = 'borrowed' and v_loan_type <> 'taken') then
      raise exception 'ltr: kind/loan-type mismatch on sync request';
    end if;
    -- The synced money moved before linking — a balance effect now would
    -- double-count it.
    if new.requester_account_id is not null then
      raise exception 'ltr: past-record sync is ledger-only';
    end if;
  end if;

  -- NEW: sender-side opted-in account.
  if new.requester_account_id is not null then
    select * into v_acct
      from public.accounts
     where id = new.requester_account_id
     for share;
    if not found then
      raise exception 'ltr: requester account not found';
    end if;
    if v_acct.user_id <> new.from_user_id then
      raise exception 'ltr: requester account not owned';
    end if;
    if v_acct.deleted_at is not null then
      raise exception 'ltr: requester account was deleted';
    end if;
    if v_acct.currency <> new.currency then
      raise exception 'ltr: requester account currency mismatch';
    end if;
  end if;

  -- Force clean initial state even if the client tries to pre-set.
  new.status := 'pending';
  new.rejection_reason := null;
  new.responded_at := null;
  new.requester_loan_id := null;
  new.responder_loan_id := null;
  new.requester_txn_id := null;
  new.responder_txn_id := null;
  new.responder_account_id := null;
  return new;
end $$;

-- ── 3.2 The accept side — an ADDITIVE trigger, deliberately not a rewrite ──
-- accept_linked_request's live body is 250 lines of concurrency-critical code
-- (audit-p0-settlement-row-locks.sql:257-530: the loans→accounts→emi_schedules
-- lock ordering and the in-statement delta arithmetic). Re-transcribing it to
-- add one IF would put that at risk for no gain, so the check goes on the
-- STATE TRANSITION instead. This is strictly stronger than an in-RPC check: it
-- also covers a raw PostgREST UPDATE and any future accept path.
--
-- Only pending → accepted is guarded. reject / cancel must always work — a
-- blocked pair must be able to clear a request out of both inboxes.
CREATE OR REPLACE FUNCTION public.tg_ltr_block_accept()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'accepted'
     AND OLD.status IS DISTINCT FROM 'accepted'
     AND public.is_blocked_either_way(NEW.from_user_id, NEW.to_user_id) THEN
    RAISE EXCEPTION 'ltr: recipient is not accepting requests';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ltr_block_accept ON public.linked_transaction_requests;
CREATE TRIGGER ltr_block_accept
  BEFORE UPDATE ON public.linked_transaction_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_ltr_block_accept();

COMMENT ON FUNCTION public.tg_ltr_block_accept() IS
  'Audit M17: refuses the pending -> accepted transition on a linked loan request when either party has blocked the other. On the transition rather than inside accept_linked_request so the P0 lock-ordering body is not re-transcribed, and so raw PostgREST writes are covered too.';

-- ── 3.3 SETTLEMENTS ARE DELIBERATELY NOT BLOCKED ───────────────────────────
-- linked_settlement_requests (tg_lsr_validate_insert,
-- create_settlement_request, accept_settlement_request) is intentionally left
-- alone. RULE 2: a settlement request can only exist for an ALREADY ACCEPTED
-- loan pair (the trigger requires both loans to belong to one accepted
-- linked_transaction_requests row —
-- fix-bidirectional-linked-settlements.sql:99-112). Blocking it would mean:
--   · a debtor who is blocked by their creditor can never record a repayment,
--     so the creditor's block freezes the debt in place; and
--   · a creditor who is blocked by their debtor can never be repaid.
-- Either is a worse harm than the one blocking solves, and both turn a safety
-- feature into a debt-collection weapon. Winding an existing obligation DOWN
-- is exactly the interaction a blocked pair still needs.
-- The lsr_notify notification (linked-notifications-realtime.sql) is likewise
-- left alone: suppressing it would strand the settlement unanswered.
-- If a user genuinely wants no contact at all, the answer is to settle to zero
-- and then block — which the client copy should say (see docs/trust-and-safety.md).

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 4. Enforcement — groups
-- ════════════════════════════════════════════════════════════════════════════

-- ── 4.1 join_group_by_code — mini-diff [J1] ────────────────────────────────
CREATE OR REPLACE FUNCTION public.join_group_by_code(
  p_code_normalized TEXT,
  p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_group public.split_groups%ROWTYPE;
  v_member public.group_members%ROWTYPE;
  v_now TIMESTAMPTZ := now();
  v_failures INTEGER;
  v_was_already_connected BOOLEAN;
BEGIN
  -- No RAISE anywhere on a business outcome: an unhandled RAISE would roll the
  -- attempt row back, which is exactly the bug this migration exists to fix.
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  -- Shape check only. Nothing is looked up, so this leaks nothing and is not
  -- charged to the window.
  IF p_code_normalized IS NULL OR length(p_code_normalized) <> 6 THEN
    RETURN jsonb_build_object('status', 'INVALID_CODE');
  END IF;

  -- Keep the ledger bounded (audit L12). Rows older than the widest window we
  -- read are dead weight.
  DELETE FROM public.join_code_attempts AS jca
   WHERE jca.attempted_at < v_now - INTERVAL '1 day';

  -- Sliding window, unchanged: 5 failed attempts per 5 minutes per caller.
  SELECT count(*) INTO v_failures
    FROM public.join_code_attempts AS jca
   WHERE jca.user_id = v_uid
     AND jca.succeeded = false
     AND jca.attempted_at > v_now - INTERVAL '5 minutes';
  IF v_failures >= 5 THEN
    -- Deliberately NOT recorded: a blocked call must not extend its own block,
    -- or an honest user who retries never drains the window.
    RETURN jsonb_build_object('status', 'RATE_LIMITED', 'retry_after_seconds', 300);
  END IF;

  SELECT sg.* INTO v_group
    FROM public.split_groups AS sg
   WHERE sg.join_code_normalized = p_code_normalized
   LIMIT 1;
  IF v_group.id IS NULL
     OR (v_group.join_code_expires_at IS NOT NULL AND v_group.join_code_expires_at < v_now) THEN
    -- THE load-bearing line: this INSERT now survives, because we return
    -- normally instead of raising.
    INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false);
    RETURN jsonb_build_object('status', 'INVALID_OR_EXPIRED_CODE');
  END IF;
  IF v_group.user_id = v_uid THEN
    -- Valid code, so not a guess: not charged to the window.
    RETURN jsonb_build_object('status', 'CANNOT_JOIN_OWN_GROUP');
  END IF;

  -- [J1] Audit M17. Only the group OWNER's block counts — see the header for
  -- why a mere member gets no veto (it would be both an exclusion weapon and a
  -- membership oracle). Response, attempt row and rate accounting are all
  -- byte-identical to a wrong or expired code.
  IF public.is_blocked_either_way(v_uid, v_group.user_id) THEN
    INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false);
    RETURN jsonb_build_object('status', 'INVALID_OR_EXPIRED_CODE');
  END IF;

  SELECT gm.* INTO v_member
    FROM public.group_members AS gm
   WHERE gm.group_id = v_group.id
     AND gm.profile_id = v_uid
   LIMIT 1;
  IF v_member.id IS NULL THEN
    v_member.id := gen_random_uuid()::text;
    INSERT INTO public.group_members(
      id, group_id, profile_id, display_name, role, status, invited_by, joined_at
    ) VALUES (
      v_member.id, v_group.id, v_uid, COALESCE(NULLIF(trim(p_display_name), ''), 'Member'),
      'member', 'connected', v_uid, v_now
    );
    v_was_already_connected := false;
  ELSE
    v_was_already_connected := v_member.status = 'connected';
    UPDATE public.group_members AS gm
       SET status = 'connected',
           joined_at = COALESCE(gm.joined_at, v_now)
     WHERE gm.id = v_member.id;
  END IF;

  INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, true);

  RETURN jsonb_build_object(
    'status', 'ok',
    'group_id', v_group.id,
    'member_id', v_member.id,
    'was_already_connected', v_was_already_connected
  );
END;
$$;

REVOKE ALL ON FUNCTION public.join_group_by_code(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_group_by_code(TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.join_group_by_code(TEXT, TEXT) IS
  'Audit H1 + M17. Status-object result so the rate window commits; a blocked pair (caller vs group OWNER) is refused as INVALID_OR_EXPIRED_CODE and charged identically to a miss.';

-- ── 4.2 accept_group_invite — mini-diff [I1]/[I2] ──────────────────────────
CREATE OR REPLACE FUNCTION public.accept_group_invite(
  p_invite_token TEXT,
  p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_now    TIMESTAMPTZ := now();
  v_hash   TEXT;
  v_invite public.group_invites%ROWTYPE;
  v_member public.group_members%ROWTYPE;
  v_failures INTEGER;
  v_was_already_connected BOOLEAN;
  v_owner  UUID;                                   -- [I1]
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  -- Shape check only: nothing is looked up, so it is not charged.
  IF p_invite_token IS NULL OR length(btrim(p_invite_token)) = 0 THEN
    RETURN jsonb_build_object('status', 'INVALID_TOKEN');
  END IF;

  -- Keep the ledger bounded (audit L12), same as the sibling RPC.
  DELETE FROM public.invite_accept_attempts AS iaa
   WHERE iaa.attempted_at < v_now - INTERVAL '1 day';

  -- 10 failures per rolling 15 minutes. Redeeming an invite is a once-per-link
  -- action reached from a URL, so this is far above honest usage.
  SELECT count(*) INTO v_failures
    FROM public.invite_accept_attempts AS iaa
   WHERE iaa.user_id = v_uid
     AND iaa.succeeded = false
     AND iaa.attempted_at > v_now - INTERVAL '15 minutes';
  IF v_failures >= 10 THEN
    -- Not recorded: a blocked call must not extend its own block.
    RETURN jsonb_build_object('status', 'RATE_LIMITED', 'retry_after_seconds', 900);
  END IF;

  -- THE fix for "the stored hash is the password": the caller supplies the
  -- preimage and the server derives the hash. A stolen hash is now inert.
  v_hash := public.hash_invite_token(p_invite_token);

  SELECT gi.* INTO v_invite
    FROM public.group_invites AS gi
   WHERE gi.token_hash = v_hash
     AND gi.revoked_at IS NULL
     AND (gi.expires_at IS NULL OR gi.expires_at >= v_now)
     AND (gi.accepted_by IS NULL OR gi.accepted_by = v_uid)
   FOR UPDATE;

  IF v_invite.id IS NULL THEN
    -- Commits, because we return instead of raising. That is the whole point.
    INSERT INTO public.invite_accept_attempts(user_id, succeeded) VALUES (v_uid, false);
    RETURN jsonb_build_object('status', 'INVITE_NOT_FOUND_OR_EXPIRED');
  END IF;

  -- [I2] Audit M17. Owner only, for the reasons argued at [J1]; the answer and
  -- the failure row are byte-identical to a dead token.
  SELECT g.user_id INTO v_owner
    FROM public.split_groups g WHERE g.id = v_invite.group_id;
  IF v_owner IS NOT NULL AND public.is_blocked_either_way(v_uid, v_owner) THEN
    INSERT INTO public.invite_accept_attempts(user_id, succeeded) VALUES (v_uid, false);
    RETURN jsonb_build_object('status', 'INVITE_NOT_FOUND_OR_EXPIRED');
  END IF;

  SELECT gm.* INTO v_member
    FROM public.group_members AS gm
   WHERE gm.group_id = v_invite.group_id
     AND gm.profile_id = v_uid
   LIMIT 1;

  IF v_member.id IS NULL AND v_invite.linked_member_id IS NOT NULL THEN
    SELECT gm.* INTO v_member
      FROM public.group_members AS gm
     WHERE gm.id = v_invite.linked_member_id
       AND gm.group_id = v_invite.group_id
       AND (gm.profile_id IS NULL OR gm.profile_id = v_uid)
     FOR UPDATE;
  END IF;

  IF v_member.id IS NULL THEN
    v_member.id := gen_random_uuid()::text;
    INSERT INTO public.group_members(
      id, group_id, profile_id, display_name, role, status, invited_by, joined_at
    ) VALUES (
      v_member.id, v_invite.group_id, v_uid,
      COALESCE(NULLIF(trim(p_display_name), ''), 'Member'),
      'member', 'connected', v_invite.created_by, v_now
    );
    v_was_already_connected := false;
  ELSE
    v_was_already_connected := v_member.status = 'connected' AND v_member.profile_id = v_uid;
    UPDATE public.group_members AS gm
       SET profile_id = v_uid,
           status = 'connected',
           joined_at = COALESCE(gm.joined_at, v_now)
     WHERE gm.id = v_member.id;
  END IF;

  UPDATE public.group_invites AS gi
     SET accepted_by = v_uid,
         accepted_at = COALESCE(gi.accepted_at, v_now)
   WHERE gi.id = v_invite.id;

  INSERT INTO public.invite_accept_attempts(user_id, succeeded) VALUES (v_uid, true);

  RETURN jsonb_build_object(
    'status', 'ok',
    'group_id', v_invite.group_id,
    'member_id', v_member.id,
    'was_already_connected', v_was_already_connected
  );
END;
$$;

REVOKE ALL ON FUNCTION public.accept_group_invite(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_group_invite(TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.accept_group_invite(TEXT, TEXT) IS
  'Audit H3/SEC-07 + M17. Raw token hashed server-side; a status object so the rate window commits; a blocked pair (caller vs group OWNER) reports INVITE_NOT_FOUND_OR_EXPIRED and records the same failure row as a dead token.';

-- ── 4.3 accept_group_membership — mini-diff [M1]/[M2] ──────────────────────
CREATE OR REPLACE FUNCTION public.accept_group_membership(p_group_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_now    TIMESTAMPTZ := now();
  v_member public.group_members%ROWTYPE;
  v_owner  UUID;                                   -- [M1]
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'NOT_AUTHENTICATED',
      'user_message', 'Please sign in again.'
    );
  END IF;

  SELECT * INTO v_member
    FROM public.group_members AS gm
   WHERE gm.group_id = p_group_id
     AND gm.profile_id = v_uid
   FOR UPDATE;

  IF v_member.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'NO_PENDING_INVITE',
      'user_message', 'This invitation is no longer available.'
    );
  END IF;

  -- Idempotent replay (two devices, double tap).
  IF v_member.status = 'connected' THEN
    RETURN jsonb_build_object(
      'success', true, 'reason_code', 'ALREADY_CONNECTED',
      'group_id', v_member.group_id, 'member_id', v_member.id,
      'user_message', 'You are already in this group.'
    );
  END IF;

  -- Only a live invitation can be accepted. A 'left' row (declined earlier, or
  -- left via leave_group) is terminal here — rejoining goes through the join
  -- code / invite link, which is the consented path.
  IF v_member.status <> 'invited' THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'NO_PENDING_INVITE',
      'user_message', 'This invitation is no longer available.'
    );
  END IF;

  -- [M2] Audit M17. Owner only ([J1]); reuses the NO_PENDING_INVITE object
  -- verbatim, so a blocked invite is indistinguishable from a withdrawn one.
  -- decline_group_membership stays UNguarded on purpose: refusing must always
  -- work.
  SELECT g.user_id INTO v_owner
    FROM public.split_groups g WHERE g.id = v_member.group_id;
  IF v_owner IS NOT NULL AND public.is_blocked_either_way(v_uid, v_owner) THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'NO_PENDING_INVITE',
      'user_message', 'This invitation is no longer available.'
    );
  END IF;

  UPDATE public.group_members AS gm
     SET status = 'connected',
         joined_at = COALESCE(gm.joined_at, v_now)
   WHERE gm.id = v_member.id;

  RETURN jsonb_build_object(
    'success', true, 'reason_code', 'ACCEPTED',
    'group_id', v_member.group_id, 'member_id', v_member.id,
    'user_message', 'You joined the group.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.accept_group_membership(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_group_membership(TEXT) TO authenticated;

COMMENT ON FUNCTION public.accept_group_membership(TEXT) IS
  'Audit H6/SEC-05 + M17: the invitee promotes their own status=invited row to connected. Reports NO_PENDING_INVITE when the invitee and the group OWNER have blocked each other.';

-- ── 4.4 fan_out_group_notification — mini-diff [F1] ────────────────────────
CREATE OR REPLACE FUNCTION public.fan_out_group_notification(
  p_group_id    TEXT,
  p_actor       UUID,
  p_event_type  TEXT,
  p_entity_type TEXT,
  p_entity_id   TEXT,
  p_template    TEXT,
  p_params      JSONB,
  p_recipients  UUID[] DEFAULT NULL,  -- NULL = every other connected member
  -- Optional third-person text for the shared group_events feed. The
  -- notification body is written TO one reader ("… added you …"), which reads
  -- wrong in a feed everyone sees. '{actor}' is substituted.
  p_event_summary TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- One actor may cause at most this many notification rows per rolling
  -- minute. A 20-member group expense costs 19, so this comfortably covers
  -- honest bursts (a trip being entered) while capping a flood attack and
  -- the FCM quota burn it would drive.
  c_max_per_minute CONSTANT INTEGER := 120;
  -- No legitimate Hisaab group is anywhere near this size; the cap stops one
  -- pathological group from becoming an amplifier.
  c_max_recipients CONSTANT INTEGER := 100;

  v_group      public.split_groups%ROWTYPE;
  v_actor_name TEXT;
  v_params     JSONB;
  v_title      TEXT;
  v_body       TEXT;
  v_event_id   TEXT := gen_random_uuid()::TEXT;
  v_recent     INTEGER := 0;
BEGIN
  SELECT * INTO v_group FROM public.split_groups WHERE id = p_group_id;
  IF v_group.id IS NULL THEN
    RETURN;  -- group already gone (cascade delete) — nothing to announce.
  END IF;

  SELECT COALESCE(NULLIF(trim(p.name), ''), 'A Hisaab user')
    INTO v_actor_name
    FROM public.profiles p
   WHERE p.id = p_actor;

  -- The actor's group display name is friendlier than their profile name and
  -- matches what the other members see in the member list.
  SELECT COALESCE(NULLIF(trim(gm.display_name), ''), v_actor_name)
    INTO v_actor_name
    FROM public.group_members gm
   WHERE gm.group_id = p_group_id
     AND gm.profile_id = p_actor
   ORDER BY gm.created_at
   LIMIT 1;

  v_params := COALESCE(p_params, '{}'::jsonb)
    || jsonb_build_object(
         'groupId',   p_group_id,
         'groupName', v_group.name,
         'currency',  v_group.currency,
         'actorName', COALESCE(v_actor_name, 'A member')
       );

  SELECT t.title, t.body INTO v_title, v_body
    FROM public.group_notification_text(p_template, v_params) AS t;

  -- The activity row is written unconditionally: it is the durable record of
  -- what happened and must survive both the rate limit and a zero-recipient
  -- group. Previously client-written (splitStore.ts:260) and therefore lost
  -- whenever the actor went offline mid-write (audit N-2).
  -- It is ALSO not filtered by blocks: group_events is the shared ledger of a
  -- group both parties chose to remain in, and per-viewer holes in it would
  -- desynchronise the activity feed and every balance narrative built on it.
  INSERT INTO public.group_events (
    id, group_id, actor_profile_id, event_type, entity_type, entity_id,
    summary, payload, created_at
  ) VALUES (
    v_event_id, p_group_id, p_actor, p_event_type, p_entity_type, p_entity_id,
    left(
      COALESCE(
        replace(p_event_summary, '{actor}', COALESCE(v_actor_name, 'A member')),
        v_body
      ),
      500
    ),
    v_params, now()
  );

  -- Per-sender rate limit. Over the limit we skip SILENTLY — the audit's
  -- requirement — because raising here would roll back the money write that
  -- fired this trigger.
  IF p_actor IS NOT NULL THEN
    SELECT count(*) INTO v_recent
      FROM public.notifications n
     WHERE n.actor_id = p_actor
       AND n.created_at > now() - interval '1 minute';
    IF v_recent >= c_max_per_minute THEN
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.notifications (
    id, user_id, group_id, event_id, type, title, body,
    template, params, actor_id, read_at, created_at
  )
  SELECT
    gen_random_uuid()::TEXT, r.profile_id, p_group_id, v_event_id,
    'group_update', left(v_title, 200), left(v_body, 1000),
    p_template, v_params, p_actor, NULL, now()
  FROM (
    SELECT DISTINCT gm.profile_id
      FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND gm.status = 'connected'
       AND gm.profile_id IS NOT NULL
       AND gm.profile_id IS DISTINCT FROM p_actor
       AND (p_recipients IS NULL OR gm.profile_id = ANY (p_recipients))
       -- [F1] Audit M17: no push, no inbox row, between a blocked pair. The
       -- group_events row above still exists for both of them. p_actor may be
       -- NULL (system events) — is_blocked_either_way(NULL, x) is false, so
       -- those fan out unchanged.
       AND NOT public.is_blocked_either_way(p_actor, gm.profile_id)
     LIMIT c_max_recipients
  ) AS r;
END;
$$;

COMMENT ON FUNCTION public.fan_out_group_notification(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID[], TEXT) IS
  'Writes the durable group_events activity row plus template-composed notifications for the other connected members. Rate-limited per actor; over the limit notifications are skipped silently and the activity row still commits. Audit M17: recipients who have blocked the actor (or whom the actor has blocked) are skipped — the group_events row is NOT filtered.';

REVOKE ALL ON FUNCTION public.fan_out_group_notification(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, UUID[], TEXT) FROM PUBLIC, anon, authenticated;

-- ── 4.5 Structural backstop on group_members ───────────────────────────────
-- The RPCs above return clean status objects, which is what the client needs.
-- This trigger is the floor under them: it also covers the OWNER FORCE-ADD path
-- (a raw client INSERT under the owner-only policy, landing as status='invited'
-- via tg_group_members_require_invite_consent) and any raw PostgREST write.
--
-- It is a SEPARATE, SECURITY DEFINER trigger rather than an edit to
-- tg_group_members_require_invite_consent because that function is NOT security
-- definer — it reads `current_user` to exempt the definer RPCs
-- (audit-p0-consent-guards.sql:922), and making it definer would break that
-- exemption test outright. A definer function is required here because the
-- block rows are invisible to the inserting client under RLS.
CREATE OR REPLACE FUNCTION public.tg_group_members_block_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner UUID;
BEGIN
  IF NEW.profile_id IS NULL THEN
    RETURN NEW;  -- guest placeholder: no account, no block relationship.
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Only a row GAINING a profile, or becoming connected, is a membership
    -- event. Everything else (leave_group's status='left', display-name edits,
    -- delete_current_user's profile_id := NULL) passes untouched.
    IF NEW.profile_id IS NOT DISTINCT FROM OLD.profile_id
       AND NOT (NEW.status = 'connected' AND OLD.status IS DISTINCT FROM 'connected') THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT g.user_id INTO v_owner
    FROM public.split_groups g WHERE g.id = NEW.group_id;

  IF v_owner IS NULL OR v_owner = NEW.profile_id THEN
    RETURN NEW;
  END IF;

  IF public.is_blocked_either_way(NEW.profile_id, v_owner) THEN
    RAISE EXCEPTION 'GROUP_MEMBERSHIP_BLOCKED: this group is not available'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_members_block_guard ON public.group_members;
CREATE TRIGGER group_members_block_guard
  BEFORE INSERT OR UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_block_guard();

COMMENT ON FUNCTION public.tg_group_members_block_guard() IS
  'Audit M17: structural floor under the join/accept RPCs. Refuses any membership row that would connect a user to a group whose OWNER they have blocked (or who has blocked them). Fires name-first, before group_members_require_invite_consent.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 5. Enforcement — discovery (a blocked user cannot FIND the blocker)
-- ════════════════════════════════════════════════════════════════════════════

-- ── 5.1 lookup_hisaab_users_by_phone — mini-diff [P1] ──────────────────────
CREATE OR REPLACE FUNCTION public.lookup_hisaab_users_by_phone(p_numbers text[])
RETURNS TABLE(phone_e164 text, profile_id uuid, display_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_recent int;
begin
  if auth.uid() is null then
    raise exception 'lookup_hisaab_users_by_phone: not authenticated';
  end if;
  if p_numbers is null or array_length(p_numbers, 1) is null then
    return;
  end if;
  if array_length(p_numbers, 1) > 60 then
    raise exception 'lookup_hisaab_users_by_phone: too many numbers (max 60)';
  end if;

  -- 20 calls per rolling hour. Enough for normal contact-list refreshes,
  -- far too slow to enumerate a number range.
  delete from public.phone_lookup_attempts
   where attempted_at < now() - interval '1 hour';
  select count(*) into v_recent
    from public.phone_lookup_attempts a
   where a.user_id = auth.uid()
     and a.attempted_at > now() - interval '1 hour';
  if v_recent >= 20 then
    raise exception 'lookup_hisaab_users_by_phone: rate limit exceeded';
  end if;
  insert into public.phone_lookup_attempts(user_id) values (auth.uid());

  return query
    select p.phone_e164,
           p.id,
           coalesce(nullif(trim(p.name), ''), 'Hisaab user')
      from public.profiles p
     where p.phone_discoverable
       and p.phone_e164 is not null
       and p.phone_e164 = any(p_numbers)
       and p.id <> auth.uid()
       -- [P1] Audit M17 + H10: a blocked pair simply does not appear —
       -- indistinguishable from phone_discoverable = false. The window was
       -- already charged above, so rate accounting is unchanged.
       and not public.is_blocked_either_way(auth.uid(), p.id);
end $$;

REVOKE ALL ON FUNCTION public.lookup_hisaab_users_by_phone(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_hisaab_users_by_phone(text[]) TO authenticated;

COMMENT ON FUNCTION public.lookup_hisaab_users_by_phone(text[]) IS
  'Phone discovery, 60 numbers per call, 20 calls per hour. Audit M17: a blocked pair is omitted from the result, indistinguishable from not being discoverable.';

-- ── 5.2 lookup_profile_by_code — mini-diff [L1] ────────────────────────────
CREATE OR REPLACE FUNCTION public.lookup_profile_by_code(code TEXT)
RETURNS TABLE(profile_id UUID, display_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_recent INTEGER;
BEGIN
  -- Every non-answer is the same non-answer: zero rows. A caller can never tell
  -- "no such code" from "you are throttled" from "your profile is inactive"
  -- from "one of you blocked the other".
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN;
  END IF;

  DELETE FROM public.code_lookup_attempts AS cla
   WHERE cla.attempted_at < now() - INTERVAL '1 hour';

  -- 20 lookups per rolling hour, matching lookup_hisaab_users_by_phone. Code
  -- entry is always an explicit user action (ConnectByCodePage, ContactsPage,
  -- ContactDetailSheet, QR scan), so this is far above real usage and far below
  -- what a 32^6 sweep needs.
  SELECT count(*) INTO v_recent
    FROM public.code_lookup_attempts AS cla
   WHERE cla.user_id = v_uid
     AND cla.attempted_at > now() - INTERVAL '1 hour';
  IF v_recent >= 20 THEN
    RETURN;
  END IF;

  -- Charged BEFORE the lookup, so misses cost exactly what hits cost.
  INSERT INTO public.code_lookup_attempts(user_id) VALUES (v_uid);

  RETURN QUERY
    SELECT p.id, COALESCE(NULLIF(trim(p.name), ''), 'Hisaab user')
      FROM public.profiles AS p
     WHERE p.public_code_normalized = COALESCE(code, '')
       AND p.id <> v_uid
       AND COALESCE(p.is_deleted, false) = false
       -- [L1] Audit M17: zero rows, exactly like a bad code.
       AND NOT public.is_blocked_either_way(v_uid, p.id)
     LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_profile_by_code(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_profile_by_code(TEXT) TO authenticated;

COMMENT ON FUNCTION public.lookup_profile_by_code(TEXT) IS
  'Audit H9 + M17: throttled profile-code lookup, 20 per rolling hour, charged before the lookup. Returns zero rows for a miss, a throttled caller, an inactive profile, OR a blocked pair — all indistinguishable.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 6. UX-13 — the per-loan rejection reason
-- ════════════════════════════════════════════════════════════════════════════
--
-- NO NEW COLUMN. On re-reading the SQL, the reason channel has existed since
-- April on BOTH tables and BOTH reject RPCs:
--
--   linked_transaction_requests.rejection_reason  phase2b-linked-requests.sql:18
--   linked_settlement_requests.rejection_reason   phase2c-a-settlement-requests.sql:171
--                                                 fix-bidirectional-…:29 (redeclared)
--   reject_linked_request(request_id, reason)     phase2b:235,253
--   reject_settlement_request(request_id, reason) fix-settlement-cancel-reject.sql:76,98
--
-- and the client already READS it (`request.rejectionReason`,
-- src/pages/InboxPage.tsx:1341-1343). What is missing is the client sending it
-- (handleReject at :400-418 and :491-509 is a bare confirmDestructive).
-- Adding a second `reject_reason` column would therefore have created two
-- columns with the same meaning, silently split the data between them, and
-- broken the card that already renders the old one. The ALTERs below are
-- defensive no-ops that make this file safe on a drifted database.
--
-- What IS added: normalisation and a bound. A rejection reason is a free-text
-- string one user writes into another user's inbox — an M17 harassment channel
-- in its own right — so it is trimmed, empty-to-NULL (the card renders only
-- when non-null), and capped at 500 characters.

ALTER TABLE public.linked_transaction_requests
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE public.linked_settlement_requests
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- ── 6.1 reject_linked_request — mini-diff [X1] ─────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_linked_request(request_id text, reason text default null)
RETURNS public.linked_transaction_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_req public.linked_transaction_requests;
begin
  select * into v_req
    from public.linked_transaction_requests
   where id = request_id
   for update;
  if not found then raise exception 'ltr: request not found'; end if;
  if v_req.status <> 'pending' then return v_req; end if;
  if v_req.to_user_id <> auth.uid() then
    raise exception 'ltr: only the target user can reject';
  end if;

  update public.linked_transaction_requests
     set status = 'rejected',
         -- [X1] UX-13 + M17: trim, empty -> NULL, cap at 500.
         rejection_reason = left(nullif(btrim(coalesce(reason, '')), ''), 500),
         responded_at = now()
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

REVOKE ALL ON FUNCTION public.reject_linked_request(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_linked_request(text, text) TO authenticated;

COMMENT ON FUNCTION public.reject_linked_request(text, text) IS
  'UX-13: the receiver declines a linked loan request, optionally saying why. `reason` is trimmed, empty-to-NULL and capped at 500 chars; it lands in rejection_reason, which InboxPage already renders. Signature unchanged — `reason` has defaulted to NULL since phase2b, so an un-updated client keeps working.';

-- ── 6.2 reject_settlement_request — mini-diff [X1] ─────────────────────────
CREATE OR REPLACE FUNCTION public.reject_settlement_request(request_id text, reason text default null)
RETURNS public.linked_settlement_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v_req public.linked_settlement_requests;
begin
  select * into v_req
    from public.linked_settlement_requests
   where id = request_id
   for update;
  if not found then
    raise exception 'lsr: request not found';
  end if;
  if v_req.status <> 'pending' then
    return v_req;
  end if;
  if v_req.to_user_id <> auth.uid() then
    raise exception 'lsr: only the target user can reject';
  end if;

  update public.linked_settlement_requests
     set status = 'rejected',
         -- [X1] UX-13 + M17: trim, empty -> NULL, cap at 500.
         rejection_reason = left(nullif(btrim(coalesce(reason, '')), ''), 500),
         responded_at = now()
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

REVOKE ALL ON FUNCTION public.reject_settlement_request(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_settlement_request(text, text) TO authenticated;

COMMENT ON FUNCTION public.reject_settlement_request(text, text) IS
  'UX-13: the receiver declines a settlement request, optionally saying why. Same normalisation and same unchanged signature as reject_linked_request.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 7. M19 / UX-24 / F-20 — the kameti witness-link lifecycle
-- ════════════════════════════════════════════════════════════════════════════
--
-- BEFORE: committees.share_token holds a 256-bit token in PLAINTEXT
-- (committees-phase2.sql:13); get_committee_witness matches it with plaintext
-- equality and is granted to anon; the client mints it once and never again
-- (src/stores/committeeStore.ts:154-161); the URL is printed into every payout
-- slip PDF (src/lib/kametiSlipPdf.ts:72-79). One escaped copy = permanent,
-- anonymous, un-revokable access to member names, slots, paid/unpaid status and
-- payout history.
--
-- AFTER:
--   · only sha256(token) is stored — a read-path mistake or a backup leak no
--     longer hands out live capabilities (the same standard group invites have
--     held since audit-p0-consent-guards.sql:1380);
--   · every link expires (90 days by default, refreshed by a rotate);
--   · the organiser can REVOKE (kill the link) or ROTATE (kill it and mint a
--     new one) — the "un-share" path UX-24 says does not exist;
--   · an optional initials-only mode answers UX-24's "named delinquency": the
--     witness page can prove the ledger without publishing "Ali Raza — UNPAID"
--     to whoever the PDF reached.
--
-- MIGRATION OF LIVE LINKS: §7.2 hashes the existing plaintext tokens IN PLACE
-- and then nulls the plaintext. Every already-shared link keeps working (the
-- lookup hashes what the visitor presents) and gets a 90-day clock. Nothing
-- breaks for a witness; what breaks is the CLIENT's ability to re-read the raw
-- token, which is the point — see BREAKING CHANGES at the top of this file.

-- ── 7.1 Columns ────────────────────────────────────────────────────────────
ALTER TABLE public.committees
  ADD COLUMN IF NOT EXISTS share_token_hash          TEXT,
  ADD COLUMN IF NOT EXISTS witness_token_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS witness_token_revoked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS witness_initials_only     BOOLEAN NOT NULL DEFAULT false;

-- Replaces committees_share_token_uidx as the lookup index. The old index on
-- the plaintext column is dropped in §7.2 once the backfill has run.
CREATE UNIQUE INDEX IF NOT EXISTS committees_share_token_hash_uidx
  ON public.committees (share_token_hash) WHERE share_token_hash IS NOT NULL;

COMMENT ON COLUMN public.committees.share_token_hash IS
  'Audit M19: SHA-256 (lowercase hex) of the witness token. The raw token is returned exactly once, by rotate_committee_witness_token, and is never stored.';
COMMENT ON COLUMN public.committees.witness_token_expires_at IS
  'Audit M19/UX-24: the witness link stops working after this instant. Default now() + 90 days, refreshed by a rotate.';
COMMENT ON COLUMN public.committees.witness_token_revoked_at IS
  'Audit M19/UX-24: set by revoke_committee_witness_token. A revoked token is indistinguishable from a wrong one (both return NULL).';
COMMENT ON COLUMN public.committees.witness_initials_only IS
  'Audit UX-24: when true the public witness page shows member INITIALS instead of full names, so a forwarded link cannot publish named delinquency. Ordinary owner-writable column.';

-- ── 7.2 Hashing helper, initials helper, and the one-time backfill ─────────
CREATE OR REPLACE FUNCTION public.hash_witness_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT CASE
           WHEN btrim(COALESCE(p_token, '')) = '' THEN NULL
           ELSE encode(digest(btrim(p_token), 'sha256'), 'hex')
         END;
$$;

REVOKE ALL ON FUNCTION public.hash_witness_token(TEXT) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.hash_witness_token(TEXT) IS
  'Audit M19: SHA-256 lowercase hex of a witness token. Same construction as hash_invite_token. Revoked from clients — the only callers that matter run as the definer.';

-- "Ali Raza" -> "A.R."   ·   "Ali" -> "A."   ·   "" -> "—"
-- Deliberately at most two initials: a third leaks little but adds nothing, and
-- kameti member lists are short enough that more characters re-identify people.
CREATE OR REPLACE FUNCTION public.witness_initials(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_clean TEXT := btrim(regexp_replace(COALESCE(p_name, ''), '\s+', ' ', 'g'));
  v_out   TEXT;
BEGIN
  IF v_clean = '' THEN
    RETURN '—';
  END IF;
  v_out := upper(left(split_part(v_clean, ' ', 1), 1)) || '.';
  IF position(' ' IN v_clean) > 0 THEN
    v_out := v_out || upper(left(split_part(v_clean, ' ', 2), 1)) || '.';
  END IF;
  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.witness_initials(TEXT) IS
  'Audit UX-24: at most two initials from a member name, for the initials-only witness view.';

-- THE ONE-TIME BACKFILL. Idempotent: the WHERE clause stops it doing anything
-- on a second run, and the plaintext is gone after the first.
DO $$
DECLARE
  v_migrated INTEGER := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'committees'
       AND column_name = 'share_token'
  ) THEN
    -- On a FIRST run §7.3's guard trigger does not exist yet, so this is moot.
    -- On a RE-RUN it does, and all three UPDATEs below would match zero rows
    -- anyway — but the escape hatch is set regardless so the backfill can never
    -- be the thing that makes a re-apply fail.
    PERFORM set_config('hisaab.witness_token', 'on', true);

    -- 1. Hash every live plaintext token, so already-shared links keep working.
    UPDATE public.committees
       SET share_token_hash = public.hash_witness_token(share_token)
     WHERE share_token IS NOT NULL
       AND share_token_hash IS NULL;
    GET DIAGNOSTICS v_migrated = ROW_COUNT;

    -- 2. Give every migrated link the same 90-day clock a fresh one gets.
    UPDATE public.committees
       SET witness_token_expires_at = now() + INTERVAL '90 days'
     WHERE share_token_hash IS NOT NULL
       AND witness_token_expires_at IS NULL;

    -- 3. Destroy the plaintext. This is the M19 fix; everything else is
    --    lifecycle. Do NOT reorder this before step 1.
    UPDATE public.committees
       SET share_token = NULL
     WHERE share_token IS NOT NULL;

    PERFORM set_config('hisaab.witness_token', 'off', true);

    IF v_migrated > 0 THEN
      RAISE NOTICE 'p2-trust-safety: hashed % plaintext witness token(s) in place; the raw tokens are no longer recoverable and every existing witness link now expires in 90 days.', v_migrated;
    END IF;
  END IF;
END;
$$;

-- The plaintext index has nothing left to index and its uniqueness would now
-- collide across NULLs-only rows. Drop it; §7.1's hash index replaces it.
DROP INDEX IF EXISTS public.committees_share_token_uidx;

-- ── 7.3 The write guard — the token is server-only from here on ────────────
-- Mirrors tg_committees_draw_immutable (audit-p0-kameti-draw.sql:250-294),
-- including its `current_setting` escape hatch so the definer RPCs below can
-- write the fields nobody else may.
-- witness_initials_only is deliberately NOT guarded: it is an ordinary
-- owner-writable preference, like `notes`.
CREATE OR REPLACE FUNCTION public.tg_committees_witness_token_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_in_rpc BOOLEAN := coalesce(current_setting('hisaab.witness_token', true), 'off') = 'on';
BEGIN
  IF v_in_rpc THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.share_token IS NOT NULL
       OR NEW.share_token_hash IS NOT NULL
       OR NEW.witness_token_revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'committees: WITNESS_TOKEN_IS_SERVER_ONLY — use rotate_committee_witness_token()';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.share_token IS DISTINCT FROM OLD.share_token
     OR NEW.share_token_hash IS DISTINCT FROM OLD.share_token_hash
     OR NEW.witness_token_expires_at IS DISTINCT FROM OLD.witness_token_expires_at
     OR NEW.witness_token_revoked_at IS DISTINCT FROM OLD.witness_token_revoked_at THEN
    RAISE EXCEPTION 'committees: WITNESS_TOKEN_IS_SERVER_ONLY — use rotate_committee_witness_token() / revoke_committee_witness_token()';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_committees_witness_token_guard ON public.committees;
CREATE TRIGGER trg_committees_witness_token_guard
  BEFORE INSERT OR UPDATE ON public.committees
  FOR EACH ROW EXECUTE FUNCTION public.tg_committees_witness_token_guard();

COMMENT ON FUNCTION public.tg_committees_witness_token_guard() IS
  'Audit M19: the witness token and its lifecycle columns may only be written by rotate_committee_witness_token / revoke_committee_witness_token. Stops a client (or a raw PostgREST write) reintroducing a plaintext, never-expiring token.';

-- ── 7.4 rotate / revoke ────────────────────────────────────────────────────
-- Contract:
--   rotate_committee_witness_token(p_committee_id TEXT) -> JSONB
--     {"status":"ok","token":"<64 hex>","expires_at":"…","initials_only":bool,
--      "replaced_previous":bool}
--     {"status":"NOT_AUTHENTICATED"}
--     {"status":"NOT_FOUND"}      -- not the caller's committee (organiser-only)
--   THE RAW TOKEN IS RETURNED EXACTLY ONCE. It is not stored and cannot be
--   re-read. A client that loses it must rotate again — which is the correct
--   semantics for a capability URL.
CREATE OR REPLACE FUNCTION public.rotate_committee_witness_token(p_committee_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_now      TIMESTAMPTZ := now();
  v_token    TEXT;
  v_had      BOOLEAN;
  v_expires  TIMESTAMPTZ;
  v_initials BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  SELECT (c.share_token_hash IS NOT NULL), c.witness_initials_only
    INTO v_had, v_initials
    FROM public.committees c
   WHERE c.id = p_committee_id
     AND c.user_id = v_uid
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Organiser-only. A non-organiser gets the same answer as a bad id.
    RETURN jsonb_build_object('status', 'NOT_FOUND');
  END IF;

  -- 256 bits from server entropy — same strength as the client's old
  -- generateSeed()+generateSeed(), but the organiser's device never chooses it.
  v_token   := encode(gen_random_bytes(32), 'hex');
  v_expires := v_now + INTERVAL '90 days';

  PERFORM set_config('hisaab.witness_token', 'on', true);
  UPDATE public.committees
     SET share_token              = NULL,
         share_token_hash         = public.hash_witness_token(v_token),
         witness_token_expires_at = v_expires,
         witness_token_revoked_at = NULL,
         updated_at               = v_now
   WHERE id = p_committee_id
     AND user_id = v_uid;
  PERFORM set_config('hisaab.witness_token', 'off', true);

  RETURN jsonb_build_object(
    'status', 'ok',
    'token', v_token,
    'expires_at', v_expires,
    'initials_only', COALESCE(v_initials, false),
    'replaced_previous', COALESCE(v_had, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_committee_witness_token(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_committee_witness_token(TEXT) TO authenticated;

COMMENT ON FUNCTION public.rotate_committee_witness_token(TEXT) IS
  'Audit M19/UX-24: organiser-only. Mints a fresh 256-bit witness token server-side, stores only its SHA-256, resets the 90-day expiry, clears any revocation, and INVALIDATES the previous link. Returns the raw token exactly once — it is never stored and cannot be re-read.';

-- revoke_committee_witness_token(p_committee_id TEXT) -> JSONB
--   {"status":"ok","was_active":bool}
--   {"status":"NOT_AUTHENTICATED"} | {"status":"NOT_FOUND"}
-- The "un-share" UX-24 says does not exist. Idempotent.
CREATE OR REPLACE FUNCTION public.revoke_committee_witness_token(p_committee_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_now  TIMESTAMPTZ := now();
  v_was  BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  SELECT (c.share_token_hash IS NOT NULL AND c.witness_token_revoked_at IS NULL)
    INTO v_was
    FROM public.committees c
   WHERE c.id = p_committee_id
     AND c.user_id = v_uid
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'NOT_FOUND');
  END IF;

  PERFORM set_config('hisaab.witness_token', 'on', true);
  UPDATE public.committees
     SET witness_token_revoked_at = COALESCE(witness_token_revoked_at, v_now),
         updated_at               = v_now
   WHERE id = p_committee_id
     AND user_id = v_uid;
  PERFORM set_config('hisaab.witness_token', 'off', true);

  RETURN jsonb_build_object('status', 'ok', 'was_active', COALESCE(v_was, false));
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_committee_witness_token(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_committee_witness_token(TEXT) TO authenticated;

COMMENT ON FUNCTION public.revoke_committee_witness_token(TEXT) IS
  'Audit M19/UX-24: organiser-only kill switch for the public witness link. Idempotent. A revoked link is indistinguishable from a wrong one.';

-- ── 7.5 get_committee_witness — mini-diff [W1]-[W4] ────────────────────────
CREATE OR REPLACE FUNCTION public.get_committee_witness(p_token text)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare
  v public.committees;
  result json;
begin
  if p_token is null or length(p_token) < 8 then
    return null;
  end if;

  -- [W1] hash lookup, not plaintext equality.
  select * into v from public.committees
   where share_token_hash = public.hash_witness_token(p_token);
  if not found then
    return null;
  end if;

  -- [W2] revoked or expired reads exactly like a wrong token. No status code,
  -- no distinguishable timing branch worth the complexity — the witness page
  -- shows its existing "link not found" state either way.
  if v.witness_token_revoked_at is not null then
    return null;
  end if;
  if v.witness_token_expires_at is not null and v.witness_token_expires_at < now() then
    return null;
  end if;

  select json_build_object(
    'committee', json_build_object(
      'id', v.id, 'name', v.name, 'currency', v.currency,
      'contributionAmount', v.contribution_amount, 'memberCount', v.member_count,
      'cadence', v.cadence, 'totalRounds', v.total_rounds, 'startDate', v.start_date,
      'payoutMethod', v.payout_method, 'status', v.status, 'drawnAt', v.drawn_at,
      'drawSeed', v.draw_seed, 'drawCommitment', v.draw_commitment,
      'drawScheme', v.draw_scheme, 'createdAt', v.created_at,
      -- [W4] so the page can say "this link expires on …" and render the
      -- initials-only notice instead of looking like a data bug.
      'witnessExpiresAt', v.witness_token_expires_at,
      'initialsOnly', v.witness_initials_only
    ),
    'members', coalesce((
      select json_agg(json_build_object(
        -- [W3] UX-24: initials, not names, when the organiser asked for it.
        -- Slots and paid/unpaid stay visible — the ledger is still provable,
        -- it just no longer publishes who is behind on their payments.
        'id', m.id,
        'name', case when v.witness_initials_only
                     then public.witness_initials(m.name)
                     else m.name end,
        'slot', m.slot, 'isOrganizer', m.is_organizer,
        'payoutReceivedAt', m.payout_received_at, 'exitedAt', m.exited_at
      ) order by m.slot nulls last, m.created_at)
      from public.committee_members m where m.committee_id = v.id
    ), '[]'::json),
    'payments', coalesce((
      select json_agg(json_build_object('memberId', p.member_id, 'round', p.round))
      from public.committee_payments p where p.committee_id = v.id
    ), '[]'::json)
  ) into result;

  return result;
end $$;

GRANT EXECUTE ON FUNCTION public.get_committee_witness(text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_committee_witness(text) IS
  'Public kameti witness snapshot. Audit M19/UX-24: matches the SHA-256 of the presented token (nothing plaintext is stored), returns NULL for a revoked or expired link, and renders member INITIALS when the organiser set witness_initials_only. Still exposes no phone numbers and no organiser user_id.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 8. M13 / F-ST1 — receipts: bucket limits and deletion purge
-- ════════════════════════════════════════════════════════════════════════════

-- ── 8.1 Bucket-level size cap and MIME allowlist ───────────────────────────
-- THIS is the real enforcement: Supabase Storage rejects the upload at the API
-- boundary, before any row reaches storage.objects, so it cannot be bypassed by
-- a crafted RLS-passing request the way a policy-only check can.
--
-- SIZE: 5 MiB, not the audit's suggested 2 MiB. src/lib/receiptStorage.ts:47-63
-- compresses to a 1280px JPEG at q0.7 (~150-300 KB) but FALLS BACK to the
-- original file whenever the browser cannot decode it (HEIC is the common
-- case), while still declaring contentType 'image/jpeg'. A 2 MiB cap would fail
-- those uploads today with no user-facing message. 5 MiB still kills the M13
-- scenario (50 MB objects) and leaves headroom; tighten to 2 MiB once the
-- client rejects oversize files up front with a translated message.
--
-- MIME: the four the brief allows. PDF is included because it is a legitimate
-- receipt format even though the current client only ever uploads JPEG.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'p2-trust-safety: storage.buckets not present — skipping the receipts bucket limits (§8.1/§8.2). Apply supabase-migration-receipts.sql on a real Supabase project.';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('receipts', 'receipts', false)
  ON CONFLICT (id) DO NOTHING;

  BEGIN
    UPDATE storage.buckets
       SET file_size_limit    = 5242880,   -- 5 MiB
           allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
     WHERE id = 'receipts';
  EXCEPTION WHEN undefined_column THEN
    RAISE WARNING 'p2-trust-safety: storage.buckets has no file_size_limit / allowed_mime_types column on this server — M13 is NOT closed. Set the limits in the Supabase dashboard (Storage -> receipts -> Settings).';
  END;
END;
$$;

-- ── 8.2 Defence in depth on storage.objects ────────────────────────────────
-- The four policies from supabase-migration-receipts.sql:19-50 are restated
-- verbatim except the INSERT/UPDATE pair, which gains a filename-extension
-- allowlist and a metadata size guard.
--
-- HONEST LIMITATION, stated because it matters: on real Supabase the object row
-- is created and the `metadata` jsonb (which carries `size` and `mimetype`) is
-- populated by the storage service, so a WITH CHECK on metadata may see NULL at
-- insert time. The guard below therefore tolerates NULL metadata and only
-- rejects a size it can actually see. §8.1 is the enforcement; this is the
-- backstop, and the extension allowlist is the part that always fires.
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'p2-trust-safety: storage.objects not present — skipping the receipts policies (§8.2).';
    RETURN;
  END IF;

  -- SELECT / DELETE are byte-identical to supabase-migration-receipts.sql:20-25
  -- and :45-50 — restated only so this file is self-contained on a drifted
  -- database.
  EXECUTE $ddl$DROP POLICY IF EXISTS receipts_select_own ON storage.objects$ddl$;
  EXECUTE $ddl$
    CREATE POLICY receipts_select_own ON storage.objects
      FOR SELECT USING (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
  $ddl$;

  EXECUTE $ddl$DROP POLICY IF EXISTS receipts_delete_own ON storage.objects$ddl$;
  EXECUTE $ddl$
    CREATE POLICY receipts_delete_own ON storage.objects
      FOR DELETE USING (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
  $ddl$;

  -- INSERT / UPDATE: the original prefix rule, PLUS a filename-extension
  -- allowlist (always evaluable, so it always fires) and a size guard that is
  -- skipped when metadata is not yet populated. Note the parenthesisation —
  -- an unbracketed `A AND B AND C OR D` would bind OR last and defeat the
  -- prefix check entirely.
  EXECUTE $ddl$DROP POLICY IF EXISTS receipts_insert_own ON storage.objects$ddl$;
  EXECUTE $ddl$
    CREATE POLICY receipts_insert_own ON storage.objects
      FOR INSERT WITH CHECK (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = auth.uid()::text
        AND lower(name) ~ '\.(jpg|jpeg|png|webp|pdf)$'
        AND (
          metadata IS NULL
          OR metadata->>'size' IS NULL
          OR (metadata->>'size')::bigint <= 5242880
        )
      )
  $ddl$;

  EXECUTE $ddl$DROP POLICY IF EXISTS receipts_update_own ON storage.objects$ddl$;
  EXECUTE $ddl$
    CREATE POLICY receipts_update_own ON storage.objects
      FOR UPDATE USING (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
      WITH CHECK (
        bucket_id = 'receipts'
        AND (storage.foldername(name))[1] = auth.uid()::text
        AND lower(name) ~ '\.(jpg|jpeg|png|webp|pdf)$'
        AND (
          metadata IS NULL
          OR metadata->>'size' IS NULL
          OR (metadata->>'size')::bigint <= 5242880
        )
      )
  $ddl$;
EXCEPTION WHEN insufficient_privilege OR undefined_function THEN
  RAISE WARNING 'p2-trust-safety: could not replace the receipts policies on storage.objects (%). Run §8.2 as the storage owner, or set the limits from the Supabase dashboard.', SQLERRM;
END;
$$;

-- ── 8.3 delete_current_user — mini-diff [E1] ───────────────────────────────
-- F-ST1: "delete_current_user() never touches storage.objects, so a deleted
-- user's receipt photos (financial PII) persist indefinitely — at odds with the
-- account-deletion promise." audit-p0-account-deletion.sql:177 records the same
-- gap and explicitly does not close it.
--
-- CAVEAT, DOCUMENTED RATHER THAN HIDDEN: deleting a storage.objects ROW removes
-- Storage's index entry, which is what makes the file unreachable through the
-- API and unlistable. It does NOT itself issue a delete against the underlying
-- S3/GCS object. For a hard guarantee the operator must also run a
-- storage-API purge (supabase.storage.from('receipts').remove([...]) with the
-- service-role key, or the dashboard) — see docs/trust-and-safety.md. The row
-- delete is what SQL can do, and it is strictly better than the current
-- nothing: after it, no signed URL can be minted and no list call returns the
-- object.
--
-- The purge is wrapped so that a Storage outage, a missing schema (a
-- self-hosted or scaffolded database) or a privilege gap can never make an
-- account deletion FAIL — the right-to-delete must not depend on Storage. It
-- warns loudly instead, and the warning is the operator's cue to purge by hand.
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

  -- ── [E1] 4d-bis. Purge the user's receipt objects (audit F-ST1 / M13).
  -- Dynamic SQL so a database without the storage schema (scaffolds, self-host
  -- variants) plans this lazily instead of failing to create the function;
  -- WARNING rather than EXCEPTION so Storage can never block a right-to-delete.
  BEGIN
    EXECUTE 'DELETE FROM storage.objects '
            'WHERE bucket_id = ''receipts'' AND split_part(name, ''/'', 1) = $1'
      USING v_uid::text;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'delete_current_user: receipt purge for % skipped (%) — purge the receipts/%/ folder with the storage API.', v_uid, SQLERRM, v_uid;
  END;

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
  'Permanent account deletion. Refuses with OWNED_GROUPS_WITH_MEMBERS (DETAIL = comma-separated group names) when the caller owns a group that still has other participants. Otherwise: emits a member_account_deleted group_event and marks the membership left in every shared group, hard-deletes solo groups, purges the caller''s receipts/<uid>/ storage rows (audit F-ST1 — see the storage-API caveat in supabase-migration-p2-trust-safety.sql §8.3), then deletes the auth identity. Shared group_expenses / group_settlements survive with user_id SET NULL.';

REVOKE ALL ON FUNCTION public.delete_current_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_current_user() TO authenticated;

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 9. READ-ONLY VERIFICATION — run after the COMMIT above
-- Nothing below writes. Every query states its expected answer.
-- ════════════════════════════════════════════════════════════════════════════

-- 9.1 The two new tables exist, have RLS on, and carry exactly the policies the
--     model requires (blocks: 3, all blocker-scoped; reports: 1, INSERT only).
SELECT c.relname,
       c.relrowsecurity                                   AS rls_enabled,
       count(pol.polname)                                 AS policies,
       string_agg(pol.polname || '[' || pol.polcmd::text || ']', ', ' ORDER BY pol.polname) AS detail
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
 WHERE n.nspname = 'public' AND c.relname IN ('blocks', 'reports')
 GROUP BY c.relname, c.relrowsecurity
 ORDER BY c.relname;
-- Expect: blocks  | t | 3 | blocks_delete_own[d], blocks_insert_own[a], blocks_select_own[r]
--         reports | t | 1 | reports_insert_self[a]

-- 9.2 THE LOAD-BEARING PRIVILEGE CHECK. No client role may ask "is this pair
--     blocked", and no client role may read a report.
SELECT has_function_privilege('authenticated', 'public.is_blocked_either_way(uuid,uuid)', 'EXECUTE') AS auth_can_probe_blocks,
       has_function_privilege('anon',          'public.is_blocked_either_way(uuid,uuid)', 'EXECUTE') AS anon_can_probe_blocks,
       has_function_privilege('authenticated', 'public.has_blocked(uuid,uuid)', 'EXECUTE')           AS auth_can_probe_direction,
       has_table_privilege   ('authenticated', 'public.reports', 'SELECT')                            AS auth_can_read_reports,
       has_table_privilege   ('authenticated', 'public.reports', 'INSERT')                            AS auth_can_file_report,
       has_table_privilege   ('authenticated', 'public.blocks',  'SELECT')                            AS auth_can_read_own_blocks;
-- Expect: f, f, f, f, t, t

-- 9.3 Every guarded entry point actually references a block helper.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       (pg_get_functiondef(p.oid) LIKE '%is_blocked_either_way%'
        OR pg_get_functiondef(p.oid) LIKE '%has_blocked%')  AS has_block_check
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'link_contact_by_code', 'link_contact_by_discovery', 'notify_contact_linked',
     'respond_contact_link', 'tg_ltr_validate_insert', 'tg_ltr_block_accept',
     'join_group_by_code', 'accept_group_invite', 'accept_group_membership',
     'tg_group_members_block_guard', 'fan_out_group_notification',
     'lookup_hisaab_users_by_phone', 'lookup_profile_by_code'
   )
 ORDER BY p.proname;
-- Expect: 13 rows, has_block_check = t on every one.

-- 9.4 Preserved contracts: the status vocabularies and the rate-limit
--     accounting the audit-p0 files depend on are still present.
SELECT
  (pg_get_functiondef('public.join_group_by_code(text,text)'::regprocedure) NOT LIKE '%RAISE EXCEPTION%')             AS join_never_raises,
  (pg_get_functiondef('public.join_group_by_code(text,text)'::regprocedure) LIKE '%CANNOT_JOIN_OWN_GROUP%')           AS join_keeps_own_group_status,
  (pg_get_functiondef('public.link_contact_by_code(text,text)'::regprocedure) LIKE '%DUPLICATE_LINKED_CONTACT%'
     OR pg_get_functiondef('public.apply_verified_contact_link(text,uuid,text)'::regprocedure) LIKE '%DUPLICATE_LINKED_CONTACT%') AS link_keeps_duplicate_status,
  (pg_get_functiondef('public.link_contact_by_code(text,text)'::regprocedure) LIKE '%code_lookup_attempts%')          AS link_keeps_code_window,
  (pg_get_functiondef('public.link_contact_by_discovery(text,uuid)'::regprocedure) LIKE '%phone_lookup_attempts%')    AS discovery_keeps_phone_window,
  (pg_get_functiondef('public.accept_group_invite(text,text)'::regprocedure) LIKE '%invite_accept_attempts%')         AS invite_keeps_window,
  (pg_get_functiondef('public.accept_group_membership(text)'::regprocedure) LIKE '%ALREADY_CONNECTED%')               AS accept_keeps_replay,
  (pg_get_functiondef('public.decline_group_membership(text)'::regprocedure) NOT LIKE '%is_blocked%')                 AS decline_is_unguarded;
-- Expect: t, t, t, t, t, t, t, t
--         (decline_is_unguarded = t is deliberate: refusing must always work.)

-- 9.5 Settlements are deliberately NOT block-gated (RULE 2).
SELECT (pg_get_functiondef('public.tg_lsr_validate_insert()'::regprocedure)   NOT LIKE '%is_blocked%') AS lsr_insert_unguarded,
       (pg_get_functiondef('public.accept_settlement_request(text,text)'::regprocedure) NOT LIKE '%is_blocked%') AS lsr_accept_unguarded;
-- Expect: t, t — a block must never freeze an existing debt.

-- 9.6 The triggers are armed and fire in the intended order.
SELECT c.relname AS table_name, t.tgname, t.tgenabled
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal
   AND n.nspname = 'public'
   AND t.tgname IN ('blocks_normalize', 'reports_validate', 'ltr_block_accept',
                    'group_members_block_guard', 'trg_committees_witness_token_guard')
 ORDER BY c.relname, t.tgname;
-- Expect: 5 rows, tgenabled = 'O' on each.
-- Note: on group_members, 'group_members_block_guard' sorts BEFORE
-- 'group_members_require_invite_consent', so the block refusal wins.

-- 9.7 Witness token: nothing plaintext survives, the hash index exists, and
--     every live link now carries an expiry.
SELECT count(*) FILTER (WHERE share_token IS NOT NULL)                                  AS plaintext_tokens_left,
       count(*) FILTER (WHERE share_token_hash IS NOT NULL)                             AS hashed_tokens,
       count(*) FILTER (WHERE share_token_hash IS NOT NULL
                          AND witness_token_expires_at IS NULL)                         AS hashed_without_expiry,
       count(*) FILTER (WHERE witness_initials_only)                                    AS initials_only_committees
  FROM public.committees;
-- Expect: plaintext_tokens_left = 0, hashed_without_expiry = 0.

SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'committees'
   AND indexname IN ('committees_share_token_hash_uidx', 'committees_share_token_uidx');
-- Expect: exactly one row — committees_share_token_hash_uidx.

SELECT (pg_get_functiondef('public.get_committee_witness(text)'::regprocedure) LIKE '%hash_witness_token%')          AS witness_hashes_input,
       (pg_get_functiondef('public.get_committee_witness(text)'::regprocedure) LIKE '%witness_token_revoked_at%')    AS witness_honours_revoke,
       (pg_get_functiondef('public.get_committee_witness(text)'::regprocedure) LIKE '%witness_initials_only%')       AS witness_honours_initials,
       (pg_get_functiondef('public.get_committee_witness(text)'::regprocedure) NOT LIKE '%where share_token =%')     AS witness_no_plaintext_lookup;
-- Expect: t, t, t, t

-- 9.8 Initials helper produces what the witness page expects.
SELECT public.witness_initials('Ali Raza')      AS two_words,   -- A.R.
       public.witness_initials('  ali   raza ') AS messy,       -- A.R.
       public.witness_initials('Ali')           AS one_word,    -- A.
       public.witness_initials('')              AS empty;       -- —

-- 9.9 Receipts: bucket limits and the purge line in delete_current_user.
SELECT id, public, file_size_limit, allowed_mime_types
  FROM storage.buckets WHERE id = 'receipts';
-- Expect: public = false, file_size_limit = 5242880,
--         allowed_mime_types = {image/jpeg,image/png,image/webp,application/pdf}

SELECT (pg_get_functiondef('public.delete_current_user()'::regprocedure) LIKE '%storage.objects%')      AS purges_receipts,
       (pg_get_functiondef('public.delete_current_user()'::regprocedure) LIKE '%OWNED_GROUPS_WITH_MEMBERS%') AS keeps_owner_guard,
       (pg_get_functiondef('public.delete_current_user()'::regprocedure) LIKE '%member_account_deleted%') AS keeps_departure_event;
-- Expect: t, t, t

-- 9.10 UX-13: both reject RPCs still take (text, text) and normalise the reason.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       (pg_get_functiondef(p.oid) LIKE '%nullif(btrim(coalesce(reason%')  AS normalises_reason
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('reject_linked_request', 'reject_settlement_request')
 ORDER BY p.proname;
-- Expect: 2 rows, args = 'text, text' on both, normalises_reason = t.

-- 9.11 MANUAL QA (run as three real signed-in accounts A, B, C — the harness
--      cannot prove PostgREST behaviour):
--   a. A blocks B:  INSERT INTO blocks(blocker_id, blocked_id) VALUES (A, B);
--      then as B:   SELECT * FROM blocks;                      -> 0 rows
--      then as A:   SELECT * FROM blocks;                      -> 1 row
--   b. As B: SELECT * FROM lookup_profile_by_code('<A''s code>');  -> 0 rows
--      As C: same call                                          -> 1 row
--      (proves the block, not the code, is what changed.)
--   c. As B: SELECT link_contact_by_code('<B''s person id>', '<A''s code>');
--      -> {"status":"NO_MATCH"}   and code_lookup_attempts gained exactly 1 row.
--      As A: the mirror call -> {"status":"BLOCKED_BY_YOU"}, no attempt row.
--   d. As B: SELECT join_group_by_code('<code of a group A owns>', 'B');
--      -> {"status":"INVALID_OR_EXPIRED_CODE"} and one succeeded=false row.
--      As B: join a group C owns that A is merely a member of -> {"status":"ok"}
--      (the documented carve-out), and A receives NO notification for B's
--      subsequent expenses in that group.
--   e. As A: INSERT a linked_transaction_request naming B
--      -> ERROR 'ltr: recipient is not accepting requests'.
--      An EXISTING accepted loan pair between A and B: B can still
--      create_settlement_request and A can still accept_settlement_request.
--   f. Kameti: as the organiser, SELECT rotate_committee_witness_token('<id>');
--      open /kameti/witness/<returned token> -> renders.
--      Rotate again -> the OLD url now renders "not found".
--      SELECT revoke_committee_witness_token('<id>') -> the new url dies too.
--      UPDATE committees SET witness_initials_only = true WHERE id = '<id>';
--      -> the witness page shows 'A.R.' instead of 'Ali Raza'.
--      UPDATE committees SET share_token = 'x' WHERE id = '<id>';
--      -> ERROR 'committees: WITNESS_TOKEN_IS_SERVER_ONLY'.
--   g. Receipts: upload a 6 MB file -> rejected by Storage.
--      Delete the account -> SELECT count(*) FROM storage.objects
--      WHERE bucket_id='receipts' AND split_part(name,'/',1)='<uid>' -> 0,
--      then confirm the underlying files with the storage API (see §8.3).
