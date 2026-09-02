-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Consent Guards (audit 2026-09 items H2 / SEC-04, H6 / SEC-05,
--                          H3 / SEC-07 — all three CONFIRMED, HIGH)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- APPLY ORDER — see the note at the very bottom of this file. Short version:
--   … existing migrations … → audit-p0-group-ledger-integrity
--                           → audit-p0-join-abuse-limits
--                           → THIS FILE (last of the three audit-p0 siblings)
--
-- One theme runs through all three findings: **a cross-user trust predicate
-- that the party being trusted never wrote.** A user's own `persons` row is
-- taken as proof that another user consented to be linked (H2); a group
-- owner's own INSERT manufactures the victim's "connected" status (H6); and a
-- hash that every group member can READ is accepted verbatim as the invite
-- credential (H3). In each case the fix is the same shape: take the write away
-- from the client, and put a SECURITY DEFINER RPC in front of it that verifies
-- something the caller could not have forged.
--
-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 1 EVIDENCE — H2 / SEC-04: persons.linked_profile_id is freely
--                      client-writable (docs/audit-2026-09/05-security.md:87-95)
-- ════════════════════════════════════════════════════════════════════════════
-- supabase-migration-phase1-persons.sql:26-32
--     persons_insert_own  WITH CHECK (user_id = auth.uid())
--     persons_update_own  USING/WITH CHECK (user_id = auth.uid())
--   Row-scoped only — no column is restricted.
-- supabase-migration-phase2a-linked-profile.sql:7-21
--   linked_profile_id is added with an FK to profiles and a partial unique
--   index, and NOTHING else. No trigger, no column grant, no RPC.
-- src/lib/supabaseDb.ts:358-363 (personsDb.setLinkedProfileId)
--     supabase.from('persons').update({ linked_profile_id: linkedProfileId })
--       .eq('id', id).eq('user_id', getUserId())
--   A plain PostgREST PATCH. The "you must know their HSB code" check lives
--   entirely in the client (src/stores/personStore.ts:92-110 calls
--   personsDb.lookupProfileByCode first) and is therefore not a check at all —
--   a raw REST call skips it and writes any profile UUID.
--
-- Every downstream cross-user guard treats that self-written row as proof of
-- an established, consented link:
--   supabase-migration-cross-user-account-effects.sql:74-80 (tg_ltr_validate_insert)
--     select p.linked_profile_id … where p.id = new.person_id
--                                   and p.user_id = new.from_user_id;
--     if v_linked is null or v_linked <> new.to_user_id then raise …
--     -> unlimited linked_transaction_requests ("X wants to record
--        PKR 99,999,999 with you") against any known UUID.
--   supabase-migration-connections-push-discovery.sql:97-104 (notify_contact_linked v3)
--     the same self-forgeable existence check gates the notification/ask.
--   supabase-migration-contact-link-reciprocal.sql:36-69 (superseded but may
--     still be live in prod) force-writes an attacker-named persons row into
--     the VICTIM's ledger off the back of it.
--
-- FIX (1.1) A BEFORE INSERT OR UPDATE trigger on persons scoped to
--   `current_user IN ('authenticated','anon')` — the repo's established shape,
--   copied from supabase-migration-safe-leave-group.sql:28 and
--   supabase-migration-safe-contact-archive.sql:108-120
--   (tg_persons_protect_archive). SECURITY DEFINER functions execute as the
--   function owner, so every legitimate RPC below is exempt automatically.
-- FIX (1.2) public.apply_verified_contact_link — the shared consent step. Both
--   link RPCs below end here, so the "write the column, then ASK the other
--   side" half can never drift between them. Revoked from every client role:
--   it performs NO verification of its own and trusts its caller to have done
--   it, so reachability from `authenticated` would reopen H2 verbatim.
-- FIX (1.3) public.phone_e164_candidates — the SQL twin of toE164Candidates
--   (src/lib/phoneIdentity.ts:43-85). Needed because the discovery RPC in 1.5
--   must re-derive, server-side, the exact number set the client asked
--   lookup_hisaab_users_by_phone about.
-- FIX (1.4) public.link_contact_by_code — the replacement write path. It
--   re-verifies the target's public code SERVER-side against
--   profiles.public_code_normalized, and shares the code_lookup_attempts
--   window the sibling migration put in front of lookup_profile_by_code
--   (audit H9). Without that, this RPC would simply become a second,
--   unthrottled validity oracle over the identical 32^6 keyspace and would
--   undo the sibling fix.
--
--   CHARGING RULE (changed 2026-09-02, audit follow-up "double charge"): only
--   a MISS is charged. The first draft charged unconditionally, before the
--   lookup, reasoning that "a miss must cost exactly what a hit costs". That
--   was right for a standalone oracle and wrong here, because the client has
--   ALREADY spent one lookup on the same code: ContactDetailSheet /
--   ContactsPage call lookup_profile_by_code to render the "link to <name>?"
--   preview, and only then call this RPC with the same code. Every honest
--   link therefore burned 2 of the 20/hour budget, and a user adding ten
--   contacts in one sitting hit a limit built for a hundred guesses.
--   Security is unchanged: the number an attacker can iterate is the number
--   of WRONG codes, and a wrong code still costs exactly 1 on either path
--   (lookup_profile_by_code charges it, and so does the NO_MATCH branch
--   here). A code that resolves is not a guess — it is the answer, and the
--   attacker learns nothing further by being charged for it. Ceiling: still
--   20 failed guesses per hour per account.
-- FIX (1.5) public.link_contact_by_discovery — the code-LESS path, for the
--   "this contact is already on Hisaab" badge (phone discovery). Same consent
--   flow, different proof: instead of a public code the server re-runs the
--   discovery match itself — the caller's OWN persons.phone, normalised by
--   1.3, against the target profile's phone_e164 while phone_discoverable is
--   true. So the client can only "link" a profile that
--   lookup_hisaab_users_by_phone would have handed it anyway; the pairing the
--   client asserts is never trusted, only re-derived. Charged to the
--   phone_lookup_attempts window (connections-push-discovery.sql:314-321),
--   NOT the code window: this path resolves a phone, not a code, and the
--   client already spent one phone lookup to surface the badge — same
--   reasoning, and the same miss-only charging rule, as 1.4.
-- FIX (1.6) public.unlink_contact_profile — the clearing counterpart.
--
-- CONSENT MODEL — deliberately UNCHANGED from what ships today, only enforced:
--   * The CALLER's own side of the link is written the moment they prove
--     possession of the code. Sharing an HSB code IS the consent to be added
--     by whoever holds it — that is the whole design of
--     supabase-migration-contact-link-notify.sql. What was missing was proof;
--     it is now server-verified instead of client-asserted.
--   * The TARGET's side is never force-written here. link_contact_by_code
--     delegates to the existing notify_contact_linked v3
--     (connections-push-discovery.sql:81-179), which opens a PENDING
--     contact_link_requests row and notifies — unless a reciprocal persons row
--     already exists, in which case it records the pair as accepted and says
--     "you're now connected". The accept/decline door stays exactly where it
--     is: public.respond_contact_link (connections-push-discovery.sql:194-289).
--     Nothing is duplicated here.
--
-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2 EVIDENCE — H6 / SEC-05: group owners conscript members with zero
--                      consent (docs/audit-2026-09/05-security.md:131-139)
-- ════════════════════════════════════════════════════════════════════════════
-- supabase-migration-p0-launch-blockers.sql:150-161
--     CREATE POLICY "Group owners can add members" … FOR INSERT
--       WITH CHECK (EXISTS (SELECT 1 FROM split_groups g
--                            WHERE g.id = group_members.group_id
--                              AND g.user_id = auth.uid()))
--   Constrains neither profile_id nor status nor role.
-- supabase-schema.sql:335-348  is_group_member() -> status = 'connected' only.
-- src/stores/splitStore.ts:406-466 (createGroup) writes strangers straight in
--   with status:'connected' (:423, :438) via
--   src/lib/supabaseDb.ts:1227-1241 (groupMembersDb.addMany).
-- src/pages/CreateGroupModal.tsx resolves ANY stranger's public code with no
--   relationship check.
-- supabase-migration-safe-leave-group.sql:28-41 blocks the victim from
--   flipping their own status back, and :142-155 refuses leave_group while the
--   net balance is non-zero — so an attacker who attaches an expense naming
--   the victim as debtor wedges the exit shut. The audit found this HALF of the
--   finding understated: conscription plus an inescapable exit.
--
-- FIX (2.2) A BEFORE INSERT trigger forces every client-inserted row whose
--   profile_id belongs to SOMEONE ELSE to status='invited', role='member',
--   joined_at=NULL, invited_by=<the actual inserter>. Forcing rather than
--   raising is deliberate: the client in tree today inserts 'connected', and
--   this file must not brick group creation in the window before the client
--   catches up. A raw PostgREST insert is rewritten the same way.
-- FIX (2.3) The UPDATE guard is widened so nobody can promote someone ELSE to
--   'connected' — the only client-side promotion left is the guest-seat
--   self-claim (OLD.profile_id IS NULL -> NEW.profile_id = auth.uid()), which
--   is a live app path (src/stores/splitStore.ts:169-196
--   claimPaidByMemberIfMine) and is self-consent by definition.
-- FIX (2.5) accept_group_membership / decline_group_membership — the invitee's
--   door. DECLINE HAS NO BALANCE GATE AND NEVER CAN: it is a separate RPC from
--   leave_group precisely so an 'invited' user can always refuse. (Belt and
--   braces: with the victim sitting at 'invited', they are not a 'connected'
--   member, so tg_group_expenses_require_connected_members — restated in
--   supabase-migration-audit-p0-group-ledger-integrity.sql:396-441 — already
--   refuses to let anyone name them in a split. The wedge cannot be built.)
-- FIX (2.6) list_pending_group_memberships — REQUIRED, not a nicety. An
--   'invited' user fails is_group_member(), so the split_groups SELECT policy
--   (supabase-schema.sql:495-500) hides the group row entirely: without this
--   RPC the invitee can see that they have a member row but cannot learn the
--   group's name to decide. is_group_member() itself is left requiring
--   'connected' (re-asserted verbatim in 2.1) — invited users see nothing else.
-- FIX (2.4) An AFTER INSERT trigger composes the invitation notification
--   SERVER-side. This is not optional either: the notifications INSERT policy
--   (supabase-schema.sql:484-493) requires is_group_member(group_id, user_id)
--   for the RECIPIENT, which an 'invited' user fails — so the client's
--   existing fan-out (src/stores/splitStore.ts:265-283) would fail for the
--   whole batch and the invitee would never be told. No duplicate notification
--   results, for exactly that reason.
--
-- PRESERVED 'connected'-creating paths (all SECURITY DEFINER -> exempt from
-- the client-scoped triggers; each verified by reading it):
--   public.join_group_by_code(TEXT, TEXT)
--     supabase-migration-fix-group-invite-join-rpc.sql:6-79, superseded by
--     supabase-migration-audit-p0-join-abuse-limits.sql:162-255 — inserts
--     status 'connected' (:235) / UPDATEs an existing row to 'connected'
--     (:241). Untouched by this file.
--   public.accept_group_invite(...)  — redefined in section 3 below, still
--     definer, still creates/rebinds 'connected' rows.
--   public.leave_group(TEXT)
--     supabase-migration-safe-leave-group.sql:55-209 — UPDATEs 'connected' ->
--     'left'. Untouched; still the only exit for a CONNECTED member.
--   public.reconcile_group_expense(...) — does not touch group_members.
--
-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3 EVIDENCE — H3 / SEC-07: group_invites.token_hash is member-readable
--                      AND is the credential (05-security.md:98-106)
-- ════════════════════════════════════════════════════════════════════════════
-- supabase-schema.sql:403-413 / supabase-migration-fix-rls-recursion.sql:103-114
--     CREATE POLICY "Members can view invites in their groups"
--       ON group_invites FOR SELECT
--       USING (created_by = auth.uid() OR accepted_by = auth.uid()
--              OR <owner> OR public.is_group_member(group_id, auth.uid()))
--   Whole rows — token_hash included — to every connected member.
-- src/lib/supabaseDb.ts:1276-1293  select('*') on group_invites (two methods).
-- supabase-migration-fix-group-invite-join-rpc.sql:111
--     WHERE gi.token_hash = p_invite_token_hash
--   …and :125-149 rebinds a guest seat (profile_id IS NULL) to the caller,
--   handing over that seat's whole expense/settlement history.
-- src/lib/collaboration.ts:36-40 (sha256Hex) + src/stores/splitStore.ts:599
--     const tokenHash = await sha256Hex(token);
--     groupsLookupDb.acceptInvite(tokenHash, …)
--   The client hashes and sends the HASH. So the stored hash IS the password,
--   and RLS hands it to every member. Hashing at rest bought nothing.
--
-- FIX (3.2) token_hash stops being readable by clients. Column-level grants,
--   not a policy: RLS cannot express "all columns except one". Note the exact
--   dance — a table-level GRANT SELECT overrides any column-level REVOKE, so
--   the table grant must be revoked FIRST and the safe columns granted back.
--   Everything the client legitimately reads is preserved verbatim; the list
--   was taken from mapGroupInvite (src/lib/supabaseDb.ts:1662-1675) and the
--   GroupInvite interface (src/db/types.ts:298-309), which between them use
--   id, group_id, created_by, linked_member_id, expires_at, revoked_at,
--   accepted_by, accepted_at, created_at — and token_hash, whose ONLY client
--   consumers are groupInvitesDb.add (write) and groupInvitesDb.getByTokenHash
--   (a dead method — repo-wide grep finds no caller).
-- FIX (3.5) accept_group_invite takes the RAW token and hashes it server-side
--   with the SAME function the client uses to create the row: SHA-256 of the
--   UTF-8 bytes, lowercase hex (src/lib/collaboration.ts:36-40 ===
--   encode(digest(token,'sha256'),'hex')). Verification 4.9 pins that
--   equivalence against a known digest. Consequence: a leaked hash is now
--   inert — hashing it again does not match anything.
--   The parameter is RENAMED (p_invite_token_hash -> p_invite_token) on
--   purpose. PostgREST passes named arguments, so an un-updated client fails
--   loudly instead of silently hashing a hash.
-- FIX (3.5) Rate limit, using the ledger pattern of
--   supabase-migration-audit-p0-join-abuse-limits.sql:93-105 — including its
--   central lesson: the RPC returns a STATUS OBJECT and never RAISEs on a
--   business outcome, because an unhandled RAISE rolls the attempt row back
--   and the limiter becomes a no-op (that was audit H1).
-- FIX (3.3) Invite links stop being immortal. src/stores/splitStore.ts:573
--   writes expiresAt: null and accept_group_invite treats NULL as "never
--   expires", so every invite link ever generated is still live. A BEFORE
--   INSERT trigger stamps 14 days, mirroring
--   audit-p0-join-abuse-limits.sql:125-150 for join codes, plus a one-time
--   backfill. Server-side on purpose: no client change needed, and no future
--   client can reintroduce a never-expiring link.
--
-- ════════════════════════════════════════════════════════════════════════════
-- BREAKING CHANGES FOR THE CLIENT (full file:line list is in the handoff)
--   1. persons.linked_profile_id PATCH -> rejected 42501. Use
--      link_contact_by_code (public code), link_contact_by_discovery (phone
--      discovery hit) or unlink_contact_profile.
--   2. group_members INSERT of another user now lands as 'invited'. The group
--      is not visible to them until accept_group_membership.
--   3. group_invites select('*') -> permission denied. Select explicit columns.
--   4. accept_group_invite: renamed argument, RAW token, jsonb return.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. persons.linked_profile_id — RPC-only (H2 / SEC-04)
-- ═══════════════════════════════════════════════════════════════════════════

-- Restated so this file stands alone against a partially-migrated database.
-- Created by supabase-migration-audit-p0-join-abuse-limits.sql:93-105; the
-- IF NOT EXISTS makes the apply order between the two files irrelevant.
CREATE TABLE IF NOT EXISTS public.code_lookup_attempts (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_lookup_attempts_user_time
  ON public.code_lookup_attempts(user_id, attempted_at DESC);

ALTER TABLE public.code_lookup_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no client access to code_lookup_attempts" ON public.code_lookup_attempts;
CREATE POLICY "no client access to code_lookup_attempts"
  ON public.code_lookup_attempts FOR ALL
  USING (false) WITH CHECK (false);

-- Same restatement for the PHONE-discovery side, which link_contact_by_discovery
-- (1.5) charges. Created by supabase-migration-connections-push-discovery.sql
-- :303-321 together with the two profiles columns; all four are restated with
-- IF NOT EXISTS so this file cannot create a function whose first execution
-- dies on a missing column. Identical definitions — re-running is a no-op.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone_e164 TEXT,
  ADD COLUMN IF NOT EXISTS phone_discoverable BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS profiles_phone_discovery_idx
  ON public.profiles(phone_e164)
  WHERE phone_e164 IS NOT NULL AND phone_discoverable;

CREATE TABLE IF NOT EXISTS public.phone_lookup_attempts (
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS phone_lookup_attempts_user_idx
  ON public.phone_lookup_attempts(user_id, attempted_at DESC);

ALTER TABLE public.phone_lookup_attempts ENABLE ROW LEVEL SECURITY;
-- The original shipped with RLS on and no policies at all, which already denies
-- every client. An explicit deny-all says so out loud and matches the sibling
-- ledgers, so a future "add a policy for debugging" cannot quietly widen it.
DROP POLICY IF EXISTS "no client access to phone_lookup_attempts" ON public.phone_lookup_attempts;
CREATE POLICY "no client access to phone_lookup_attempts"
  ON public.phone_lookup_attempts FOR ALL
  USING (false) WITH CHECK (false);


-- ── 1.1 The write guard ────────────────────────────────────────────────────
-- Same shape as tg_persons_protect_archive (safe-contact-archive.sql:108-120),
-- but BEFORE INSERT OR UPDATE with no column list. `UPDATE OF linked_profile_id`
-- would have been cheaper and is what the archive guard uses, but the
-- unqualified form cannot be dodged by any future write shape, and this column
-- is the consent predicate for every cross-user money flow in the app.
--
-- INSERT is covered because nothing in the client ever inserts a non-null
-- linked_profile_id: personsDb.add (src/lib/supabaseDb.ts:348-354) passes
-- `p.linkedProfileId ?? null`, and the only producer of a Person object is
-- personStore.createPerson (src/stores/personStore.ts:74-89), which never sets
-- the field. Blocking non-null on insert is therefore free, and it stops the
-- obvious way around an UPDATE-only guard: delete the row and re-insert it
-- pre-linked.
CREATE OR REPLACE FUNCTION public.tg_persons_protect_linked_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- SECURITY DEFINER RPCs run as the function owner, not 'authenticated', so
  -- they fall straight through. That exemption is what keeps
  -- accept_linked_request / respond_contact_link / accept_settlement_request /
  -- merge_person working (each verified — see the header).
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.linked_profile_id IS NOT NULL THEN
        RAISE EXCEPTION 'LINK_RPC_REQUIRED: a contact link can only be created through link_contact_by_code'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.linked_profile_id IS DISTINCT FROM OLD.linked_profile_id THEN
      RAISE EXCEPTION 'LINK_RPC_REQUIRED: a contact link can only be changed through link_contact_by_code or unlink_contact_profile'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS persons_protect_linked_profile ON public.persons;
CREATE TRIGGER persons_protect_linked_profile
  BEFORE INSERT OR UPDATE ON public.persons
  FOR EACH ROW EXECUTE FUNCTION public.tg_persons_protect_linked_profile();

COMMENT ON FUNCTION public.tg_persons_protect_linked_profile() IS
  'Audit H2/SEC-04: persons.linked_profile_id is the consent predicate every cross-user flow trusts, so no client role may write it. SECURITY DEFINER RPCs are exempt by design.';


-- ── 1.2 apply_verified_contact_link — the shared consent step ──────────────
-- Everything the two link RPCs do AFTER they have proven, each in its own way,
-- that the caller is entitled to link this profile. Factored out rather than
-- copied: the reciprocal-side logic is exactly what drifted last time, when
-- contact-link-reciprocal.sql and connections-push-discovery.sql each grew
-- their own copy and one of them force-wrote a row into the victim's ledger.
-- One body, one behaviour, both paths.
--
--   apply_verified_contact_link(p_person_id TEXT, p_target UUID,
--                               p_display_name TEXT) -> JSONB
--     {"status":"ok","profile_id":…,"display_name":…,"link_state":"mutual"|"pending"}
--     {"status":"DUPLICATE_LINKED_CONTACT"}
--     {"status":"NOT_AUTHENTICATED"}
--
-- SECURITY NOTE — this function verifies NOTHING about p_target. It is the
-- write, not the check. The REVOKE below (including from `authenticated`) is
-- therefore load-bearing, not hygiene: reachable from a client role it would
-- be H2 all over again, with a nicer name. It stays SECURITY DEFINER so the
-- 1.1 trigger lets its UPDATE through, and it reads auth.uid() itself rather
-- than taking the caller's id as an argument, so there is no id to spoof even
-- if a future blanket GRANT does hand it to a client.
CREATE OR REPLACE FUNCTION public.apply_verified_contact_link(
  p_person_id    TEXT,
  p_target       UUID,
  p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_reciprocal TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  -- The write the client used to do itself. This runs as the definer, so the
  -- 1.1 trigger lets it through.
  BEGIN
    UPDATE public.persons
       SET linked_profile_id = p_target,
           updated_at = now()
     WHERE id = p_person_id
       AND user_id = v_uid;
  EXCEPTION WHEN unique_violation THEN
    -- persons_user_profile_uniq (phase2a-linked-profile.sql:19-21): the caller
    -- already has a different contact pointing at this same user. Mapped to
    -- the code personStore.DuplicateLinkedContactError already renders.
    RETURN jsonb_build_object('status', 'DUPLICATE_LINKED_CONTACT');
  END;

  -- The OTHER side: ask, never force. notify_contact_linked v3
  -- (connections-push-discovery.sql:81-179) opens a pending
  -- contact_link_requests row + notification, or records the pair as accepted
  -- when a reciprocal persons row already exists. Re-implementing that logic
  -- here would let the two copies drift, which is exactly how the
  -- contact-link-reciprocal / connections-push-discovery pair went wrong once
  -- already. Best-effort, mirroring the client's own try/catch
  -- (src/stores/personStore.ts): the link itself already succeeded and must
  -- not be rolled back by a notification failure.
  BEGIN
    PERFORM public.notify_contact_linked(p_target);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  SELECT p.id INTO v_reciprocal
    FROM public.persons AS p
   WHERE p.user_id = p_target
     AND p.linked_profile_id = v_uid
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'ok',
    'profile_id', p_target,
    'display_name', COALESCE(NULLIF(btrim(p_display_name), ''), 'Hisaab user'),
    'link_state', CASE WHEN v_reciprocal IS NULL THEN 'pending' ELSE 'mutual' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_verified_contact_link(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.apply_verified_contact_link(TEXT, UUID, TEXT) IS
  'Audit H2/SEC-04: the shared write+ask half of link_contact_by_code and link_contact_by_discovery. Performs NO authorisation of its own — never grant it to a client role.';


-- ── 1.3 phone_e164_candidates — the SQL twin of toE164Candidates ───────────
-- src/lib/phoneIdentity.ts:43-85, transliterated. It exists so 1.5 can decide
-- FOR ITSELF which numbers a saved contact could mean, instead of believing a
-- (profile_id, person_id) pairing the client asserts.
--
-- Kept deliberately identical, including the parts that look arbitrary:
--   * digits outside 7..15 -> no candidates at all (E.164 ceiling);
--   * a leading '+' on the RAW string means "the user told us the country",
--     so the digits are trusted as-is and nothing else is guessed;
--   * '00' is the same statement written the old way;
--   * otherwise at most ONE leading trunk '0' is stripped, and each supported
--     country (UAE +971, 9 national digits starting 5; Pakistan +92, 10
--     starting 3) contributes a candidate if the length and mobile prefix fit;
--   * finally, a number that already carries a known calling code but no '+'.
-- Two countries, no libphonenumber — same trade-off the client documents.
--
-- If phoneIdentity.ts ever changes, this must change with it or discovery
-- links silently stop resolving. Verification 4.11 pins the pairs that the
-- client's own test file (src/lib/phoneIdentity.test.ts) asserts.
CREATE OR REPLACE FUNCTION public.phone_e164_candidates(p_raw TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_trimmed   TEXT := btrim(COALESCE(p_raw, ''));
  v_digits    TEXT;
  v_rest      TEXT;
  v_national  TEXT;
  v_candidate TEXT;
  v_out       TEXT[] := ARRAY[]::TEXT[];
  v_country   RECORD;
BEGIN
  v_digits := regexp_replace(v_trimmed, '[^0-9]', '', 'g');

  -- MIN_DIGITS / MAX_DIGITS in phoneIdentity.ts.
  IF length(v_digits) < 7 OR length(v_digits) > 15 THEN
    RETURN v_out;
  END IF;

  IF left(v_trimmed, 1) = '+' THEN
    RETURN ARRAY['+' || v_digits];
  END IF;

  IF left(v_digits, 2) = '00' THEN
    v_rest := substr(v_digits, 3);
    IF length(v_rest) >= 7 THEN
      RETURN ARRAY['+' || v_rest];
    END IF;
    RETURN v_out;
  END IF;

  v_national := CASE WHEN left(v_digits, 1) = '0' THEN substr(v_digits, 2) ELSE v_digits END;

  FOR v_country IN
    SELECT * FROM (VALUES ('971'::TEXT, 9::INT, '5'::TEXT),
                          ('92'::TEXT, 10::INT, '3'::TEXT))
      AS c(calling, national_length, mobile_prefix)
  LOOP
    IF length(v_national) = v_country.national_length
       AND left(v_national, length(v_country.mobile_prefix)) = v_country.mobile_prefix THEN
      v_candidate := '+' || v_country.calling || v_national;
      IF length(v_candidate) <= 16 AND NOT (v_candidate = ANY (v_out)) THEN
        v_out := v_out || v_candidate;
      END IF;
    END IF;
  END LOOP;

  FOR v_country IN
    SELECT * FROM (VALUES ('971'::TEXT, 9::INT, '5'::TEXT),
                          ('92'::TEXT, 10::INT, '3'::TEXT))
      AS c(calling, national_length, mobile_prefix)
  LOOP
    IF left(v_digits, length(v_country.calling)) = v_country.calling THEN
      v_rest := substr(v_digits, length(v_country.calling) + 1);
      IF length(v_rest) = v_country.national_length THEN
        v_candidate := '+' || v_digits;
        IF length(v_candidate) <= 16 AND NOT (v_candidate = ANY (v_out)) THEN
          v_out := v_out || v_candidate;
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.phone_e164_candidates(TEXT) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.phone_e164_candidates(TEXT) IS
  'SQL twin of toE164Candidates in src/lib/phoneIdentity.ts. Used by link_contact_by_discovery to re-derive, server-side, the numbers a saved contact could mean.';


-- ── 1.4 link_contact_by_code — the replacement write path ───────────────────
-- Contract:
--   link_contact_by_code(p_person_id TEXT, p_code_normalized TEXT) -> JSONB
--     {"status":"ok","profile_id":uuid,"display_name":text,
--      "link_state":"mutual"|"pending"}
--     {"status":"NOT_AUTHENTICATED"}
--     {"status":"INVALID_CODE"}              -- wrong shape, nothing looked up
--     {"status":"CONTACT_NOT_FOUND"}         -- not the caller's contact
--     {"status":"CONTACT_ARCHIVED"}
--     {"status":"CONTACT_ALREADY_LINKED"}    -- unlink first
--     {"status":"RATE_LIMITED","retry_after_seconds":3600}
--     {"status":"NO_MATCH"}                  -- charged to the window
--     {"status":"CANNOT_LINK_SELF"}
--     {"status":"DUPLICATE_LINKED_CONTACT"}  -- 23505 on the phase-2A index
-- Never RAISEs on a business outcome — the attempt row must survive (audit H1).
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
  'Audit H2/SEC-04: one of the two client paths that may set persons.linked_profile_id. Verifies the target public code server-side, shares the code_lookup_attempts rate window with lookup_profile_by_code (charging MISSES only — see the CHARGING RULE note in the file header), and defers the reciprocal side to apply_verified_contact_link -> notify_contact_linked.';


-- ── 1.5 link_contact_by_discovery — the code-LESS path ─────────────────────
-- Contract (deliberately the same status vocabulary as 1.4, so the client has
-- one parser and one set of copy):
--   link_contact_by_discovery(p_person_id TEXT, p_profile_id UUID) -> JSONB
--     {"status":"ok","profile_id":uuid,"display_name":text,
--      "link_state":"mutual"|"pending"}
--     {"status":"NOT_AUTHENTICATED"}
--     {"status":"CONTACT_NOT_FOUND"}         -- not the caller's contact
--     {"status":"CONTACT_ARCHIVED"}
--     {"status":"CONTACT_ALREADY_LINKED"}    -- unlink first
--     {"status":"CANNOT_LINK_SELF"}
--     {"status":"RATE_LIMITED","retry_after_seconds":3600}
--     {"status":"NO_MATCH"}                  -- charged to the PHONE window
--     {"status":"DUPLICATE_LINKED_CONTACT"}  -- 23505 on the phase-2A index
-- Never RAISEs on a business outcome — the attempt row must survive (audit H1).
--
-- WHY THIS EXISTS. The phone-discovery badge ("this contact is already on
-- Hisaab", src/stores/phoneDiscoveryStore.ts) hands the client a profile_id
-- with no public code attached. Before this RPC that link had to be written
-- directly, which 1.1 now refuses — so the feature degraded to "ask them for
-- their code", which is a worse product AND, on its own, would have pushed
-- users toward sharing codes more freely.
--
-- WHY IT IS SAFE. The (person, profile) pairing the client sends is treated as
-- a CLAIM, never as evidence. The server re-runs the discovery match itself:
--
--     profiles.phone_e164 = ANY (phone_e164_candidates(persons.phone))
--       AND profiles.phone_discoverable
--       AND profiles.phone_e164 IS NOT NULL
--       AND profiles.id <> auth.uid()
--
-- which is byte-for-byte the predicate of lookup_hisaab_users_by_phone
-- (connections-push-discovery.sql:352-360) with the caller's own saved number
-- as the probe set — plus the soft-delete filter 1.4 already applies, so a
-- deleted account cannot be linked even if discovery would still surface it.
-- Consequences worth stating:
--   * the caller can only link a profile that discovery WOULD have returned to
--     them anyway, from a number THEY had already saved on the contact;
--   * the target's phone_discoverable opt-in is re-checked at link time, so
--     turning discovery off retroactively closes this door;
--   * a stale badge (they changed number, or opted out after the badge
--     rendered) yields NO_MATCH rather than a link;
--   * nothing about the target's number is ever echoed back — the answer is
--     one bit, and that bit is rate-limited.
--
-- RATE WINDOW: phone_lookup_attempts, NOT code_lookup_attempts. This resolves a
-- phone, so it belongs to the phone oracle's budget; sharing the code window
-- would let ordinary contact adding lock a user out of code lookups and vice
-- versa. Charged on a MISS only, for the same reason 1.4 is: the client spent
-- one phone lookup to render the badge, and a match is not a guess. A miss —
-- the only outcome that teaches an attacker anything ("does profile X have a
-- number I can produce?") — still costs 1 against the same 20/hour ceiling.
-- Note that this is a strictly WORSE oracle than the one it shares a budget
-- with: lookup_hisaab_users_by_phone tests 60 numbers per charge, this tests
-- one number against one named profile.
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

  RETURN public.apply_verified_contact_link(v_person.id, v_target, v_name);
END;
$$;

REVOKE ALL ON FUNCTION public.link_contact_by_discovery(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_contact_by_discovery(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.link_contact_by_discovery(TEXT, UUID) IS
  'Audit H2/SEC-04: the code-less link path. Re-runs lookup_hisaab_users_by_phone''s own match server-side (caller''s persons.phone -> phone_e164_candidates -> target profiles.phone_e164, phone_discoverable required) so a client can only link a profile discovery would have returned. Charged to phone_lookup_attempts on a miss.';


-- ── 1.6 unlink_contact_profile ─────────────────────────────────────────────
-- Contract:
--   unlink_contact_profile(p_person_id TEXT) -> JSONB
--     {"status":"ok","was_linked":bool,"unlinked_profile_id":uuid|null}
--     {"status":"NOT_AUTHENTICATED"}
--     {"status":"CONTACT_NOT_FOUND"}
-- Semantics match src/stores/personStore.ts:112-118 exactly: clear the column,
-- leave contact_link_requests alone. notify_contact_linked's re-open rule
-- (connections-push-discovery.sql:145-165) depends on a declined ask being
-- re-openable by unlinking and re-entering the code, so touching the request
-- row here would change that behaviour.
CREATE OR REPLACE FUNCTION public.unlink_contact_profile(p_person_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_person public.persons%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  SELECT * INTO v_person
    FROM public.persons AS p
   WHERE p.id = p_person_id
     AND p.user_id = v_uid
   FOR UPDATE;

  IF v_person.id IS NULL THEN
    RETURN jsonb_build_object('status', 'CONTACT_NOT_FOUND');
  END IF;

  IF v_person.linked_profile_id IS NULL THEN
    RETURN jsonb_build_object('status', 'ok', 'was_linked', false, 'unlinked_profile_id', null);
  END IF;

  UPDATE public.persons
     SET linked_profile_id = NULL,
         updated_at = now()
   WHERE id = v_person.id
     AND user_id = v_uid;

  RETURN jsonb_build_object(
    'status', 'ok',
    'was_linked', true,
    'unlinked_profile_id', v_person.linked_profile_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unlink_contact_profile(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_contact_profile(TEXT) TO authenticated;

COMMENT ON FUNCTION public.unlink_contact_profile(TEXT) IS
  'Audit H2/SEC-04: the only client path that may clear persons.linked_profile_id. Same semantics as the old PostgREST PATCH, minus the ability to point it anywhere.';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. Group membership requires the member's consent (H6 / SEC-05)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 2.1 is_group_member stays 'connected'-only ─────────────────────────────
-- Re-asserted verbatim from supabase-schema.sql:335-348. Production has 40+
-- hand-applied migrations with no ledger (audit F-MIG1), and the entire
-- consent model in this section rests on 'invited' NOT counting as membership:
-- an invited user must see no expenses, no settlements, no group row, and must
-- not be nameable in a split. Restating it costs nothing and removes the
-- question.
CREATE OR REPLACE FUNCTION public.is_group_member(gid TEXT, uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = gid
      AND profile_id = uid
      AND status = 'connected'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_group_member(TEXT, UUID) TO authenticated;


-- ── 2.2 Owner-inserted members start as 'invited' ──────────────────────────
CREATE OR REPLACE FUNCTION public.tg_group_members_require_invite_consent()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  -- Definer RPCs (join_group_by_code, accept_group_invite, and the accept RPC
  -- below) create 'connected' rows legitimately and are exempt.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Guest placeholders (profile_id IS NULL) are not a person's account and
  -- carry no consent question. The inserter's own row (owner self-add during
  -- createGroup) is self-consent. Everything else is an invitation.
  IF NEW.profile_id IS NULL OR NEW.profile_id = v_uid THEN
    RETURN NEW;
  END IF;

  -- One row per (group, profile). Without this an owner could re-INSERT a
  -- member who declined — both re-opening the harassment loop and creating a
  -- duplicate row that would corrupt getByGroup and every balance derived from
  -- it. The supported way back in for a previously-declined user is the join
  -- code / invite link, whose definer RPCs REUSE the existing row
  -- (audit-p0-join-abuse-limits.sql:238-244).
  IF EXISTS (
    SELECT 1 FROM public.group_members AS gm
     WHERE gm.group_id = NEW.group_id
       AND gm.profile_id = NEW.profile_id
  ) THEN
    RAISE EXCEPTION 'MEMBER_ALREADY_EXISTS: this person already has a membership row in this group; re-invite them with the group join code'
      USING ERRCODE = '23505';
  END IF;

  -- Forced, not rejected: the client in tree still inserts 'connected', and
  -- this migration must not brick group creation before the client lands.
  NEW.status      := 'invited';
  -- role='owner' on a conscripted row makes leave_group return
  -- ONLY_OWNER_ADMIN (safe-leave-group.sql:100-106) — the exit wedge the audit
  -- called out. An invitation never carries a role.
  NEW.role        := 'member';
  -- joined_at is a fact about acceptance, not about being listed.
  NEW.joined_at   := NULL;
  -- Truthful provenance: whoever actually issued the invitation.
  NEW.invited_by  := v_uid;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_members_require_invite_consent ON public.group_members;
CREATE TRIGGER group_members_require_invite_consent
  BEFORE INSERT ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_require_invite_consent();

COMMENT ON FUNCTION public.tg_group_members_require_invite_consent() IS
  'Audit H6/SEC-05: a client INSERT naming another user lands as status=invited, role=member, joined_at=NULL — never as connected membership. SECURITY DEFINER join/accept RPCs are exempt.';


-- Structural backstop for the duplicate rule above. Guarded: a database that
-- already contains duplicates must not fail the whole migration, and merging
-- duplicate member rows is a data decision, not a schema one.
DO $$
DECLARE
  v_dupes INTEGER;
BEGIN
  SELECT count(*) INTO v_dupes
    FROM (
      SELECT group_id, profile_id
        FROM public.group_members
       WHERE profile_id IS NOT NULL
       GROUP BY group_id, profile_id
      HAVING count(*) > 1
    ) d;

  IF v_dupes > 0 THEN
    RAISE WARNING 'group_members holds % (group_id, profile_id) pair(s) with duplicate rows — unique index NOT created. Resolve them, then re-run this migration. Verification query 4.6 lists them.', v_dupes;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_profile_uniq
      ON public.group_members(group_id, profile_id)
      WHERE profile_id IS NOT NULL;
  END IF;
END;
$$;


-- ── 2.3 Nobody may promote SOMEONE ELSE to 'connected' ─────────────────────
-- Drop-in upgrade of tg_group_members_protect_membership_fields
-- (supabase-migration-safe-leave-group.sql:22-49): same function name, same
-- trigger name, original rules preserved verbatim, two rules added.
--
-- The original guard only fired when OLD.status = 'connected', which left the
-- new 'invited' state wide open: the owner-only UPDATE policy
-- (p0-launch-blockers.sql:163-178) would have let a group owner PATCH the
-- victim's invited row straight to 'connected' and re-manufacture exactly the
-- consent this section removes.
CREATE OR REPLACE FUNCTION public.tg_group_members_protect_membership_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- ── Original rules (safe-leave-group.sql:28-41), unchanged ──────────────
  IF NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR (
       OLD.status = 'connected'
       AND (
         NEW.profile_id IS DISTINCT FROM OLD.profile_id
         OR NEW.status IS DISTINCT FROM OLD.status
       )
     ) THEN
    RAISE EXCEPTION 'Group membership changes must use an approved RPC'
      USING ERRCODE = '42501';
  END IF;

  -- ── NEW: an identity, once attached, is not reassignable by a client ────
  -- Previously only protected while OLD.status = 'connected', so an owner
  -- could repoint an invited row at a different victim.
  IF OLD.profile_id IS NOT NULL AND NEW.profile_id IS DISTINCT FROM OLD.profile_id THEN
    RAISE EXCEPTION 'Group membership changes must use an approved RPC'
      USING ERRCODE = '42501';
  END IF;

  -- ── NEW: promotion to 'connected' is consent, and consent is not a PATCH ─
  -- The single exception is the guest-seat self-claim: an unclaimed
  -- placeholder (OLD.profile_id IS NULL) taken by the caller THEMSELVES. That
  -- is a live app path — claimPaidByMemberIfMine, src/stores/splitStore.ts
  -- :169-196 — and it is self-consent by construction. Claiming a seat FOR
  -- someone else is not.
  IF NEW.status = 'connected'
     AND OLD.status IS DISTINCT FROM 'connected'
     AND NOT (OLD.profile_id IS NULL AND NEW.profile_id = v_uid) THEN
    RAISE EXCEPTION 'GROUP_CONSENT_REQUIRED: membership must be accepted by the member through accept_group_membership'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_members_protect_membership_fields ON public.group_members;
CREATE TRIGGER group_members_protect_membership_fields
  BEFORE UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_protect_membership_fields();

COMMENT ON FUNCTION public.tg_group_members_protect_membership_fields() IS
  'Audit H6/SEC-05 + safe-leave-group: clients may not change group_id/role, may not touch a connected row, may not reassign an attached profile_id, and may not promote anyone but themselves (from an unclaimed guest seat) to connected.';


-- ── 2.4 Tell the invitee, server-side ──────────────────────────────────────
-- Required, not decorative: the notifications INSERT policy
-- (supabase-schema.sql:484-493) demands is_group_member(group_id, user_id) for
-- the RECIPIENT, which an 'invited' user fails — so the client's fan-out
-- (src/stores/splitStore.ts:265-283) can no longer reach them at all. It sends
-- one batched insert, so the whole batch would fail and nobody would be told.
-- Composing here is also H5-shaped hardening: the text is server-authored, not
-- attacker-supplied.
CREATE OR REPLACE FUNCTION public.tg_group_members_notify_invited()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_name TEXT;
  v_inviter    TEXT;
BEGIN
  IF NEW.profile_id IS NULL OR NEW.status <> 'invited' THEN
    RETURN NULL;
  END IF;
  IF NEW.invited_by IS NULL OR NEW.invited_by = NEW.profile_id THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(NULLIF(trim(g.name), ''), 'a shared group') INTO v_group_name
    FROM public.split_groups AS g WHERE g.id = NEW.group_id;
  SELECT COALESCE(NULLIF(trim(p.name), ''), 'A Hisaab user') INTO v_inviter
    FROM public.profiles AS p WHERE p.id = NEW.invited_by;

  INSERT INTO public.notifications(id, user_id, group_id, event_id, type, title, body, created_at)
  VALUES (
    gen_random_uuid()::text,
    NEW.profile_id,
    NEW.group_id,
    NULL,
    -- 'invite' is an existing member of the client's notification type union
    -- (src/db/types.ts:328), so the tray renders it today.
    'invite',
    'Group invitation',
    COALESCE(v_inviter, 'Someone') || ' invited you to join "' || COALESCE(v_group_name, 'a shared group') || '". You are not in the group until you accept.',
    now()
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- A notification failure must never block the membership row.
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS group_members_notify_invited ON public.group_members;
CREATE TRIGGER group_members_notify_invited
  AFTER INSERT ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_notify_invited();


-- ── 2.5 The invitee's door: accept / decline ───────────────────────────────
-- Contract (jsonb, matching leave_group's success/reason_code/user_message
-- shape from safe-leave-group.sql:86-207 so the client's existing result
-- handling generalises):
--   accept_group_membership(p_group_id TEXT) -> JSONB
--     {"success":true,"reason_code":"ACCEPTED","group_id":…,"member_id":…,"user_message":…}
--     {"success":true,"reason_code":"ALREADY_CONNECTED","group_id":…,"member_id":…,"user_message":…}
--     {"success":false,"reason_code":"NO_PENDING_INVITE","user_message":…}
--     {"success":false,"reason_code":"NOT_AUTHENTICATED","user_message":…}
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
  'Audit H6/SEC-05: the invitee promotes their own status=invited row to connected. auth.uid() must equal profile_id; no other party can call it for them.';


-- decline_group_membership(p_group_id TEXT) -> JSONB
--   {"success":true,"reason_code":"DECLINED","user_message":…}
--   {"success":true,"reason_code":"ALREADY_DECLINED","user_message":…}
--   {"success":false,"reason_code":"NO_PENDING_INVITE","user_message":…}
--   {"success":false,"reason_code":"ALREADY_CONNECTED","user_message":…}
--   {"success":false,"reason_code":"NOT_AUTHENTICATED","user_message":…}
--
-- THE LOAD-BEARING PROPERTY: there is NO balance gate, NO unreconciled-expense
-- gate and NO pending-invite gate here — none of leave_group's checks
-- (safe-leave-group.sql:142-191). That is the entire point. The audit's
-- aggravating finding was that an attacker could conscript a victim and then
-- wedge the exit shut by attaching an expense that fails the leave gate. A
-- never-accepted user must ALWAYS be able to refuse, unconditionally, so this
-- is a separate RPC from leave_group and must stay one.
--
-- No such expense can exist anyway: an 'invited' user is not a connected
-- member, so tg_group_expenses_require_connected_members
-- (audit-p0-group-ledger-integrity.sql:411-441) rejects any split naming them.
-- Belt AND braces, on purpose.
CREATE OR REPLACE FUNCTION public.decline_group_membership(p_group_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_member public.group_members%ROWTYPE;
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

  IF v_member.status = 'left' THEN
    RETURN jsonb_build_object(
      'success', true, 'reason_code', 'ALREADY_DECLINED',
      'user_message', 'You already declined this invitation.'
    );
  END IF;

  -- A member who actually joined must use leave_group — that is where the
  -- balance/reconciliation rules live, and they exist for good reason once
  -- real money records reference the member id.
  IF v_member.status = 'connected' THEN
    RETURN jsonb_build_object(
      'success', false, 'reason_code', 'ALREADY_CONNECTED',
      'user_message', 'You are already in this group. Use Leave group instead.'
    );
  END IF;

  -- Soft-deactivate, exactly as leave_group does (safe-leave-group.sql:196-198):
  -- the member id may already be referenced, and rejoining through the join
  -- code reuses this row rather than creating a duplicate.
  UPDATE public.group_members AS gm
     SET status = 'left'
   WHERE gm.id = v_member.id;

  RETURN jsonb_build_object(
    'success', true, 'reason_code', 'DECLINED',
    'user_message', 'Invitation declined.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.decline_group_membership(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decline_group_membership(TEXT) TO authenticated;

COMMENT ON FUNCTION public.decline_group_membership(TEXT) IS
  'Audit H6/SEC-05: unconditional refusal of a group invitation. Deliberately carries none of leave_group''s balance or reconciliation gates so a never-accepted user can never be trapped.';


-- ── 2.6 Let the invitee see what they are deciding about ───────────────────
-- An 'invited' user fails is_group_member(), so the split_groups SELECT policy
-- (supabase-schema.sql:495-500) hides the group row. They can read their own
-- group_members row (schema:352-362, `profile_id = auth.uid()`) and nothing
-- else — not even the group's name. Without this RPC the invitation is
-- undecidable, and "just widen the split_groups policy to invited users" would
-- hand a conscripted stranger read access to a group they never joined.
--
--   list_pending_group_memberships() -> TABLE(
--     group_id TEXT, member_id TEXT, group_name TEXT, group_emoji TEXT,
--     currency TEXT, invited_by UUID, invited_by_name TEXT,
--     invited_at TIMESTAMPTZ)
-- Returns only rows where profile_id = auth.uid() AND status = 'invited', and
-- only these scalar fields — no member list, no expenses, no join code.
CREATE OR REPLACE FUNCTION public.list_pending_group_memberships()
RETURNS TABLE (
  group_id        TEXT,
  member_id       TEXT,
  group_name      TEXT,
  group_emoji     TEXT,
  currency        TEXT,
  invited_by      UUID,
  invited_by_name TEXT,
  invited_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT gm.group_id,
           gm.id,
           COALESCE(NULLIF(trim(g.name), ''), 'Shared group'),
           COALESCE(g.emoji, ''),
           COALESCE(g.currency, 'PKR'),
           gm.invited_by,
           COALESCE(NULLIF(trim(p.name), ''), 'A Hisaab user'),
           gm.created_at
      FROM public.group_members AS gm
      JOIN public.split_groups  AS g ON g.id = gm.group_id
      LEFT JOIN public.profiles AS p ON p.id = gm.invited_by
     WHERE gm.profile_id = v_uid
       AND gm.status = 'invited'
     ORDER BY gm.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_pending_group_memberships() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pending_group_memberships() TO authenticated;

COMMENT ON FUNCTION public.list_pending_group_memberships() IS
  'Audit H6/SEC-05: the invitee''s read window. Own invited rows only, scalar group fields only — no membership list, no ledger, no join code.';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. Invite tokens: the hash stops being readable AND stops being the
--            credential (H3 / SEC-07)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 3.1 Server-side hashing, byte-identical to the client's ────────────────
-- src/lib/collaboration.ts:36-40 does SHA-256 over the UTF-8 bytes and joins
-- the digest as lowercase hex. encode(digest(text,'sha256'),'hex') is exactly
-- that on a UTF8 database. Verification 4.9 pins it to a known digest so a
-- future change to either side fails loudly instead of silently invalidating
-- every outstanding invite link.
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

CREATE OR REPLACE FUNCTION public.hash_invite_token(p_token TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(digest(btrim(COALESCE(p_token, '')), 'sha256'), 'hex');
$$;

-- Not a secret, but there is no reason for a client to hold it: the only
-- caller that matters runs as the definer.
REVOKE ALL ON FUNCTION public.hash_invite_token(TEXT) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.hash_invite_token(TEXT) IS
  'SHA-256 lowercase hex, matching sha256Hex in src/lib/collaboration.ts. Single source of truth for group invite token hashing.';


-- ── 3.2 token_hash leaves the client-readable surface ──────────────────────
-- RLS cannot say "all columns but one", so this is a privilege change, not a
-- policy change. THE ORDER BELOW IS LOAD-BEARING: a table-level GRANT SELECT
-- is a separate privilege that outranks every column-level grant, so a bare
-- "REVOKE SELECT (token_hash)" would have done nothing at all. The table-wide
-- grant must be revoked FIRST, and the safe columns granted back explicitly.
-- The SELECT POLICY is untouched — RLS still decides WHICH ROWS a member sees;
-- these grants decide WHICH COLUMNS.
--
-- service_role is deliberately not touched (edge functions / admin tooling).
REVOKE SELECT ON public.group_invites FROM authenticated;
REVOKE SELECT ON public.group_invites FROM PUBLIC;
REVOKE ALL    ON public.group_invites FROM anon;

-- Exactly the columns mapGroupInvite reads (src/lib/supabaseDb.ts:1662-1675),
-- minus token_hash. Nothing the app renders is lost.
GRANT SELECT (
  id, group_id, created_by, linked_member_id,
  expires_at, revoked_at, accepted_by, accepted_at, created_at
) ON public.group_invites TO authenticated;

-- INSERT keeps token_hash: the owner's client creates the invite and knows the
-- raw token at that moment (src/stores/splitStore.ts:570-587). Writing a hash
-- it already computed discloses nothing. Reading OTHER people's hashes was the
-- vulnerability, and that is now gone.
GRANT INSERT ON public.group_invites TO authenticated;

-- UPDATE is narrowed to the four columns groupInvitesDb.update actually writes
-- (src/lib/supabaseDb.ts:1294-1301), so an owner cannot rewrite token_hash or
-- backdate created_at either.
REVOKE UPDATE ON public.group_invites FROM authenticated;
GRANT UPDATE (revoked_at, accepted_by, accepted_at, linked_member_id)
  ON public.group_invites TO authenticated;

-- DELETE grant (if any) is left exactly as prelaunch-hardening.sql:297-300 set
-- it; changing it is out of scope for this finding.


-- ── 3.3 Invite links stop being immortal ───────────────────────────────────
-- src/stores/splitStore.ts:573 writes `expiresAt: null`, and
-- accept_group_invite treats NULL as "never expires" — so every invite URL
-- ever generated is still redeemable. Same server-side stamping shape as
-- audit-p0-join-abuse-limits.sql:125-150 uses for join codes, so no client
-- change is needed and no future client can reintroduce the problem.
UPDATE public.group_invites
   SET expires_at = now() + INTERVAL '14 days'
 WHERE expires_at IS NULL
   AND revoked_at IS NULL
   AND accepted_at IS NULL;

CREATE OR REPLACE FUNCTION public.tg_group_invites_default_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.expires_at IS NULL THEN
    NEW.expires_at := now() + INTERVAL '14 days';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_invites_default_expiry ON public.group_invites;
CREATE TRIGGER group_invites_default_expiry
  BEFORE INSERT ON public.group_invites
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_invites_default_expiry();


-- ── 3.4 Attempt ledger for invite redemption ───────────────────────────────
-- Same shape and same deny-all RLS as code_lookup_attempts
-- (audit-p0-join-abuse-limits.sql:93-105). A separate table rather than a
-- shared one: profile-code lookups and invite redemptions have different
-- honest-usage rates, and conflating them would let ordinary contact adding
-- lock a user out of a legitimate invite link.
CREATE TABLE IF NOT EXISTS public.invite_accept_attempts (
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded    BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_invite_accept_attempts_user_time
  ON public.invite_accept_attempts(user_id, attempted_at DESC);

ALTER TABLE public.invite_accept_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no client access to invite_accept_attempts" ON public.invite_accept_attempts;
CREATE POLICY "no client access to invite_accept_attempts"
  ON public.invite_accept_attempts FOR ALL
  USING (false) WITH CHECK (false);


-- ── 3.5 accept_group_invite — raw token, server-side hash, status result ───
-- New contract:
--   accept_group_invite(p_invite_token TEXT, p_display_name TEXT) -> JSONB
--     {"status":"ok","group_id":…,"member_id":…,"was_already_connected":bool}
--     {"status":"INVITE_NOT_FOUND_OR_EXPIRED"}   -- charged to the window
--     {"status":"RATE_LIMITED","retry_after_seconds":900}
--     {"status":"INVALID_TOKEN"}                 -- empty, no lookup performed
--     {"status":"NOT_AUTHENTICATED"}
--
-- Two deliberate breaking changes, both so an un-updated client fails loudly:
--   * the argument is RENAMED (PostgREST passes named args), and
--   * it now takes the RAW token, so passing a hash cannot possibly work.
-- The return type changes from TABLE(...) to jsonb because a RAISE would roll
-- back the attempt row and turn the rate limiter into the same no-op the
-- sibling migration had to fix (audit H1).
--
-- Everything else is byte-for-byte the semantics of
-- supabase-migration-fix-group-invite-join-rpc.sql:86-158: same revoked/expiry/
-- accepted_by predicate, same own-membership-first lookup, same guest-seat
-- rebind via linked_member_id, same was_already_connected rule, same invite
-- stamping. Guest-seat rebinding is KEPT: with the hash unreadable and the raw
-- token required, only someone actually holding the invite link can do it,
-- which is the feature rather than the bug.
DROP FUNCTION IF EXISTS public.accept_group_invite(TEXT, TEXT);

CREATE FUNCTION public.accept_group_invite(
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
  'Audit H3/SEC-07: takes the RAW invite token and hashes it server-side, so the stored hash is no longer a usable credential. Returns a status object (never raises on a business outcome) so the invite_accept_attempts rate window actually commits.';

COMMIT;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4. VERIFICATION — read-only. Run everything below after the COMMIT.
-- Nothing here writes.
-- ═══════════════════════════════════════════════════════════════════════════

-- 4.1 Every new/changed function exists with the expected signature, language,
--     return type and SECURITY DEFINER flag.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid)             AS returns,
       l.lanname                                 AS language,
       p.prosecdef                               AS security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language  l ON l.oid = p.prolang
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'link_contact_by_code', 'link_contact_by_discovery',
     'apply_verified_contact_link', 'phone_e164_candidates',
     'unlink_contact_profile',
     'accept_group_membership', 'decline_group_membership',
     'list_pending_group_memberships', 'accept_group_invite',
     'hash_invite_token', 'is_group_member',
     'tg_persons_protect_linked_profile',
     'tg_group_members_require_invite_consent',
     'tg_group_members_protect_membership_fields',
     'tg_group_members_notify_invited',
     'tg_group_invites_default_expiry'
   )
 ORDER BY p.proname;
-- Expect, among others:
--   accept_group_invite(text, text)             -> jsonb, plpgsql, t
--   accept_group_membership(text)               -> jsonb, plpgsql, t
--   apply_verified_contact_link(text,uuid,text) -> jsonb, plpgsql, t
--   decline_group_membership(text)              -> jsonb, plpgsql, t
--   link_contact_by_code(text, text)            -> jsonb, plpgsql, t
--   link_contact_by_discovery(text, uuid)       -> jsonb, plpgsql, t
--   phone_e164_candidates(text)                 -> text[], plpgsql, f
--   unlink_contact_profile(text)                -> jsonb, plpgsql, t
--   list_pending_group_memberships()            -> TABLE(...), plpgsql, t
--   is_group_member(text, uuid)                 -> boolean, sql, t

-- 4.2 anon holds EXECUTE on none of the new client-facing RPCs.
SELECT has_function_privilege('anon', 'public.link_contact_by_code(text,text)', 'EXECUTE')     AS anon_link,
       has_function_privilege('anon', 'public.link_contact_by_discovery(text,uuid)', 'EXECUTE') AS anon_link_disc,
       has_function_privilege('anon', 'public.unlink_contact_profile(text)', 'EXECUTE')        AS anon_unlink,
       has_function_privilege('anon', 'public.accept_group_membership(text)', 'EXECUTE')       AS anon_accept_member,
       has_function_privilege('anon', 'public.decline_group_membership(text)', 'EXECUTE')      AS anon_decline_member,
       has_function_privilege('anon', 'public.accept_group_invite(text,text)', 'EXECUTE')      AS anon_accept_invite,
       has_function_privilege('authenticated', 'public.hash_invite_token(text)', 'EXECUTE')    AS client_can_hash;
-- Expect: f, f, f, f, f, f, f

-- 4.2b The unverified internals must NOT be reachable from a client role.
--      apply_verified_contact_link writes linked_profile_id with no checks of
--      its own — a client GRANT here is H2 with extra steps.
SELECT has_function_privilege('authenticated', 'public.apply_verified_contact_link(text,uuid,text)', 'EXECUTE') AS client_can_apply,
       has_function_privilege('anon',          'public.apply_verified_contact_link(text,uuid,text)', 'EXECUTE') AS anon_can_apply,
       has_function_privilege('authenticated', 'public.phone_e164_candidates(text)', 'EXECUTE')                 AS client_can_normalise,
       has_function_privilege('authenticated', 'public.link_contact_by_code(text,text)', 'EXECUTE')             AS client_can_link,
       has_function_privilege('authenticated', 'public.link_contact_by_discovery(text,uuid)', 'EXECUTE')        AS client_can_link_disc;
-- Expect: f, f, f, t, t

-- 4.3 Every trigger is armed and enabled ('O' = enabled, origin).
SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled, p.proname AS function_name
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc  p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal
   AND c.relname IN ('persons', 'group_members', 'group_invites')
 ORDER BY c.relname, t.tgname;
-- Expect to see at least:
--   group_invites  group_invites_default_expiry
--   group_members  group_members_notify_invited
--   group_members  group_members_protect_membership_fields
--   group_members  group_members_require_invite_consent
--   persons        persons_protect_archive        (pre-existing)
--   persons        persons_protect_linked_profile
--   persons        persons_touch                  (pre-existing)

-- 4.4 Assertions on the bodies, so a partially-applied or hand-edited database
--     is caught rather than assumed.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  -- H2: the guard covers INSERT as well as UPDATE, and exempts definer roles.
  SELECT pg_get_functiondef('public.tg_persons_protect_linked_profile()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%current_user IN (''authenticated'', ''anon'')%' THEN
    RAISE EXCEPTION 'persons link guard is not scoped to client roles — it would break every SECURITY DEFINER RPC';
  END IF;
  IF v_def NOT LIKE '%TG_OP = ''INSERT''%' THEN
    RAISE EXCEPTION 'persons link guard does not cover INSERT — delete-and-reinsert would bypass it';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'persons' AND t.tgname = 'persons_protect_linked_profile'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'persons_protect_linked_profile trigger is missing';
  END IF;

  -- H2: the link RPC verifies the code server-side AND charges the shared window.
  SELECT pg_get_functiondef('public.link_contact_by_code(text,text)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%public_code_normalized = p_code_normalized%' THEN
    RAISE EXCEPTION 'link_contact_by_code does not verify the public code server-side';
  END IF;
  IF v_def NOT LIKE '%INSERT INTO public.code_lookup_attempts(user_id) VALUES (v_uid)%' THEN
    RAISE EXCEPTION 'link_contact_by_code is not charged to the code_lookup_attempts window — it is a second unthrottled code oracle';
  END IF;
  -- The charge must sit INSIDE the miss branch. If it ever moves back above
  -- the lookup, every honest link costs 2 of 20 again (the preview already
  -- spent one) — the double-charge this file's CHARGING RULE note is about.
  IF v_def NOT LIKE '%v_target IS NULL THEN%INSERT INTO public.code_lookup_attempts%' THEN
    RAISE EXCEPTION 'link_contact_by_code charges the lookup window outside the NO_MATCH branch — successful links are being double-charged';
  END IF;
  IF v_def NOT LIKE '%apply_verified_contact_link%' THEN
    RAISE EXCEPTION 'link_contact_by_code no longer routes the write/ask through apply_verified_contact_link';
  END IF;

  -- H2: the shared consent step is the ONLY place the column is written, and
  -- it still asks rather than force-writes the other side.
  SELECT pg_get_functiondef('public.apply_verified_contact_link(text,uuid,text)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%notify_contact_linked%' THEN
    RAISE EXCEPTION 'apply_verified_contact_link no longer routes the reciprocal side through notify_contact_linked';
  END IF;
  IF v_def LIKE '%INSERT INTO public.persons%' THEN
    RAISE EXCEPTION 'apply_verified_contact_link force-writes a row into the OTHER user''s ledger — that is the contact-link-reciprocal bug';
  END IF;
  IF has_function_privilege('authenticated', 'public.apply_verified_contact_link(text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'apply_verified_contact_link is executable by authenticated — it performs no authorisation, so this reopens H2';
  END IF;

  -- H2 (discovery): the pairing the client sends must be re-derived, not trusted.
  SELECT pg_get_functiondef('public.link_contact_by_discovery(text,uuid)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%phone_e164_candidates(v_person.phone)%' THEN
    RAISE EXCEPTION 'link_contact_by_discovery does not re-derive the caller''s own saved number — it would be trusting the client''s pairing';
  END IF;
  IF v_def NOT LIKE '%pr.phone_discoverable%' THEN
    RAISE EXCEPTION 'link_contact_by_discovery ignores the target''s phone_discoverable opt-in';
  END IF;
  IF v_def NOT LIKE '%pr.phone_e164 = ANY (v_candidates)%' THEN
    RAISE EXCEPTION 'link_contact_by_discovery does not match the target number server-side';
  END IF;
  IF v_def NOT LIKE '%INSERT INTO public.phone_lookup_attempts(user_id) VALUES (v_uid)%' THEN
    RAISE EXCEPTION 'link_contact_by_discovery is not charged to the phone_lookup_attempts window';
  END IF;
  IF v_def LIKE '%code_lookup_attempts%' THEN
    RAISE EXCEPTION 'link_contact_by_discovery charges the CODE window — contact adding would lock users out of code lookups';
  END IF;
  IF v_def NOT LIKE '%v_target IS NULL THEN%INSERT INTO public.phone_lookup_attempts%' THEN
    RAISE EXCEPTION 'link_contact_by_discovery charges the phone window outside the NO_MATCH branch — successful links are being double-charged';
  END IF;

  -- H6: is_group_member still means 'connected', or the whole section is void.
  SELECT pg_get_functiondef('public.is_group_member(text,uuid)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%status = ''connected''%' THEN
    RAISE EXCEPTION 'is_group_member no longer requires status = connected — invited users would gain full access';
  END IF;

  -- H6: the insert guard forces invited/member and blocks duplicates.
  SELECT pg_get_functiondef('public.tg_group_members_require_invite_consent()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%:= ''invited''%' THEN
    RAISE EXCEPTION 'group member insert guard does not force status = invited';
  END IF;
  IF v_def NOT LIKE '%:= ''member''%' THEN
    RAISE EXCEPTION 'group member insert guard does not clamp role — the owner-role exit wedge is still reachable';
  END IF;

  -- H6: the update guard blocks promoting anyone but yourself.
  SELECT pg_get_functiondef('public.tg_group_members_protect_membership_fields()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%GROUP_CONSENT_REQUIRED%' THEN
    RAISE EXCEPTION 'group member update guard does not block client promotion to connected';
  END IF;
  IF v_def NOT LIKE '%Group membership changes must use an approved RPC%' THEN
    RAISE EXCEPTION 'group member update guard lost the original safe-leave-group rules';
  END IF;

  -- H6: decline must carry no balance gate, ever.
  SELECT pg_get_functiondef('public.decline_group_membership(text)'::regprocedure) INTO v_def;
  IF v_def LIKE '%OUTSTANDING_PAYABLE%' OR v_def LIKE '%group_expenses%' THEN
    RAISE EXCEPTION 'decline_group_membership has acquired a balance gate — an invited user could be trapped';
  END IF;

  -- H3: raw token in, hash derived server-side, no RAISE on business outcomes.
  SELECT pg_get_functiondef('public.accept_group_invite(text,text)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%public.hash_invite_token(p_invite_token)%' THEN
    RAISE EXCEPTION 'accept_group_invite still accepts a pre-computed hash as the credential';
  END IF;
  IF v_def LIKE '%RAISE EXCEPTION%' THEN
    RAISE EXCEPTION 'accept_group_invite raises on a business outcome — the rate-limit ledger row would roll back';
  END IF;
  IF v_def NOT LIKE '%INSERT INTO public.invite_accept_attempts(user_id, succeeded) VALUES (v_uid, false)%' THEN
    RAISE EXCEPTION 'accept_group_invite does not record failed redemption attempts';
  END IF;

  RAISE NOTICE 'Consent guards verification passed';
  RAISE NOTICE 'linked_profile_id is RPC-only; owner-added members start as invited; invite hashes are neither readable nor a credential';
END;
$$;

-- 4.5 H3: token_hash is genuinely unreadable by client roles, and the columns
--     the app needs are still readable.
SELECT a.attname AS column_name,
       has_column_privilege('authenticated', 'public.group_invites', a.attname, 'SELECT') AS authenticated_can_read
  FROM pg_attribute a
 WHERE a.attrelid = 'public.group_invites'::regclass
   AND a.attnum > 0
   AND NOT a.attisdropped
 ORDER BY a.attnum;
-- Expect: token_hash = f; every other column = t.

SELECT has_table_privilege('authenticated', 'public.group_invites', 'SELECT') AS table_wide_select,
       has_table_privilege('anon',          'public.group_invites', 'SELECT') AS anon_select;
-- Expect: f, f  (a table-wide SELECT here would override the column grants
--                and re-expose token_hash)

-- 4.6 H6: who is currently in a group they never accepted into? These are the
--     rows the finding is about — a member added by someone else, still
--     'connected', who never went through a join/invite RPC (those set
--     invited_by = the joiner themselves or the invite creator with joined_at
--     stamped). NOT auto-migrated: flipping live groups to 'invited' would cut
--     real users out of real ledgers mid-flight. Review this list and decide.
SELECT gm.group_id,
       g.name          AS group_name,
       gm.id           AS member_id,
       gm.profile_id,
       gm.display_name,
       gm.invited_by,
       gm.status,
       gm.created_at
  FROM public.group_members gm
  JOIN public.split_groups  g ON g.id = gm.group_id
 WHERE gm.status = 'connected'
   AND gm.profile_id IS NOT NULL
   AND gm.invited_by IS DISTINCT FROM gm.profile_id
 ORDER BY gm.created_at DESC;
-- Optional, ONLY after reviewing the list above:
--   UPDATE public.group_members SET status = 'invited', joined_at = NULL
--    WHERE id IN (...);   -- explicit ids, never a blanket predicate

-- Duplicate (group_id, profile_id) pairs — these block the unique index the
-- migration tries to create (a WARNING is raised if any exist).
SELECT group_id, profile_id, count(*) AS row_count
  FROM public.group_members
 WHERE profile_id IS NOT NULL
 GROUP BY group_id, profile_id
HAVING count(*) > 1;
-- Expect: zero rows.

SELECT indexname FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'group_members'
   AND indexname = 'group_members_group_profile_uniq';
-- Expect: one row (absent only if the WARNING above fired).

-- 4.7 H2: nobody outside a definer RPC can have written a link. This is a
--     point-in-time census, not an assertion — pre-existing links stay valid.
SELECT count(*) FILTER (WHERE p.linked_profile_id IS NOT NULL)                AS linked_contacts,
       count(*) FILTER (
         WHERE p.linked_profile_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.persons q
              WHERE q.user_id = p.linked_profile_id
                AND q.linked_profile_id = p.user_id
           )
       )                                                                       AS one_sided_links
  FROM public.persons p;
-- One-sided links are EXPECTED and legitimate (the reciprocal side is pending
-- until the other user accepts). Recorded here as a baseline.

-- 4.8 Both attempt ledgers are unreachable from a client.
SELECT c.relname, c.relrowsecurity, count(pol.polname) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
 WHERE n.nspname = 'public'
   AND c.relname IN ('code_lookup_attempts', 'invite_accept_attempts')
 GROUP BY c.relname, c.relrowsecurity;
-- Expect: relrowsecurity = t for both, one deny-all policy each.

-- 4.9 The server hash matches the client's sha256Hex EXACTLY. If this ever
--     returns false, every outstanding invite link is silently dead.
SELECT public.hash_invite_token('test') AS server_hash,
       public.hash_invite_token('test')
         = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' AS matches_sha256_hex,
       public.hash_invite_token('  test  ') = public.hash_invite_token('test') AS trims_whitespace;
-- Expect: t, t   (9f86d0… is the canonical SHA-256 of "test")

-- 4.10 No invite link is immortal any more.
SELECT count(*) FILTER (WHERE revoked_at IS NULL AND accepted_at IS NULL)                        AS live_invites,
       count(*) FILTER (WHERE revoked_at IS NULL AND accepted_at IS NULL AND expires_at IS NULL) AS never_expiring
  FROM public.group_invites;
-- Expect: never_expiring = 0

-- 4.11 H2 (discovery): phone_e164_candidates must agree with the client's
--      toE164Candidates EXACTLY. Every pair below is lifted from
--      src/lib/phoneIdentity.test.ts. If any row is false, discovery links
--      silently stop resolving (or, worse, resolve for the wrong number).
SELECT public.phone_e164_candidates('+971 50 123 4567') = ARRAY['+971501234567'] AS intl_uae,
       public.phone_e164_candidates('+92 300 1234567')  = ARRAY['+923001234567'] AS intl_pk,
       public.phone_e164_candidates('00971501234567')   = ARRAY['+971501234567'] AS double_zero,
       public.phone_e164_candidates('050 123 4567')     = ARRAY['+971501234567'] AS national_uae,
       public.phone_e164_candidates('03001234567')      = ARRAY['+923001234567'] AS national_pk,
       public.phone_e164_candidates('501234567')        = ARRAY['+971501234567'] AS bare_uae,
       public.phone_e164_candidates('3001234567')       = ARRAY['+923001234567'] AS bare_pk,
       public.phone_e164_candidates('971501234567')     = ARRAY['+971501234567'] AS cc_no_plus,
       public.phone_e164_candidates('(050) 123-4567')   = ARRAY['+971501234567'] AS punctuation;
-- Expect: t for every column.

SELECT public.phone_e164_candidates('')            = ARRAY[]::TEXT[] AS empty,
       public.phone_e164_candidates(NULL)          = ARRAY[]::TEXT[] AS null_in,
       public.phone_e164_candidates('12345')       = ARRAY[]::TEXT[] AS too_short,
       public.phone_e164_candidates('not a phone') = ARRAY[]::TEXT[] AS not_a_number,
       public.phone_e164_candidates('042345678')   = ARRAY[]::TEXT[] AS landline,
       public.phone_e164_candidates('+1234567890123456') = ARRAY[]::TEXT[] AS over_e164;
-- Expect: t for every column. A non-empty answer here means the guard would
-- accept a number the client would never have asked discovery about.

-- 4.12 H2 (discovery): how many contacts could actually use this path today?
--      A contact with no saved phone can never link by discovery — that is
--      correct, not a bug, but it is worth knowing the size before shipping.
SELECT count(*)                                                                AS contacts,
       count(*) FILTER (WHERE array_length(public.phone_e164_candidates(p.phone), 1) IS NOT NULL)
                                                                               AS with_usable_phone,
       count(*) FILTER (WHERE p.linked_profile_id IS NOT NULL)                 AS already_linked
  FROM public.persons p
 WHERE p.archived_at IS NULL;

SELECT count(*) FILTER (WHERE phone_discoverable)                              AS discoverable_profiles,
       count(*) FILTER (WHERE phone_discoverable AND phone_e164 IS NULL)       AS opted_in_without_number
  FROM public.profiles;
-- opted_in_without_number should be 0; such a profile is discoverable in name
-- only and can never be matched by either RPC.

-- ───────────────────────────────────────────────────────────────────────────
-- MANUAL QA (two real accounts — A the owner/attacker, B the victim)
--
-- H2 / linked_profile_id
--  1. As A, straight through PostgREST with A's JWT:
--       PATCH /rest/v1/persons?id=eq.<own contact>  {"linked_profile_id":"<B uuid>"}
--     -> 42501, message begins LINK_RPC_REQUIRED.
--       POST /rest/v1/persons  {..., "linked_profile_id":"<B uuid>"}
--     -> 42501 as well.
--  2. As A: SELECT public.link_contact_by_code('<A contact id>', 'ZZZZZZ');
--     -> {"status":"NO_MATCH"}; repeat 21x within an hour -> "RATE_LIMITED"
--        (shared with lookup_profile_by_code, so a code-lookup burst counts).
--  3. As A with B's REAL code -> {"status":"ok", "link_state":"pending"} and
--     B sees an "add them back?" card; contact_link_requests holds one pending
--     row. B accepts via respond_contact_link -> B's persons row is created by
--     the existing RPC (unchanged), and a re-run of link_contact_by_code from
--     the other side reports link_state "mutual".
--  4. As A: SELECT public.unlink_contact_profile('<A contact id>');
--     -> {"status":"ok","was_linked":true}; the column is NULL again.
--  5. Regression: B accepts a linked loan request from A -> accept_linked_request
--     still creates B's person row (definer path, exempt from the guard).
--  5a. Double charge: as a FRESH account, note
--        SELECT count(*) FROM public.code_lookup_attempts WHERE user_id = <A>;
--      then link one contact by code through the app (preview + confirm).
--      -> the count goes up by exactly 1, not 2. Now enter a code that does
--      not exist -> it goes up by 1 again. Twenty bad codes still lock the
--      window; twenty good links no longer do.
--
-- H2 / linked_profile_id via phone discovery
--  5b. Setup: as B, Settings -> phone discovery, save B's number (stored as
--      profiles.phone_e164 with phone_discoverable = true). As A, save a
--      contact whose phone is that number written ANY way the app accepts
--      ("0300 1234567", "+92 300 1234567", "03001234567").
--      As A: SELECT public.link_contact_by_discovery('<A contact id>', '<B uuid>');
--      -> {"status":"ok","link_state":"pending"}; B gets the same "add them
--      back?" card as the code path, and contact_link_requests holds one
--      pending row. Nothing about B's number is echoed back.
--  5c. The pairing is NOT trusted. As A, on a contact whose phone is someone
--      else's (or blank), call the same RPC with B's uuid ->
--      {"status":"NO_MATCH"}, and code_lookup_attempts is untouched while
--      phone_lookup_attempts gains exactly one row. Repeat 20x within the hour
--      -> "RATE_LIMITED", and lookup_hisaab_users_by_phone is throttled too
--      (one shared budget, by design).
--  5d. Opt-out closes the door retroactively. As B, turn phone discovery off
--      (phone_discoverable = false). As A, with the SAME correct number saved,
--      call the RPC -> {"status":"NO_MATCH"}. The stale badge cannot be
--      cashed in.
--  5e. Self / archived / already-linked: calling it with A's own uuid ->
--      CANNOT_LINK_SELF; on an archived contact -> CONTACT_ARCHIVED; on a
--      contact already linked to someone else -> CONTACT_ALREADY_LINKED.
--      None of these touch phone_lookup_attempts.
--  5f. The internals are unreachable:
--        SELECT public.apply_verified_contact_link('<A contact id>', '<B uuid>', 'B');
--      as A -> "permission denied for function apply_verified_contact_link".
--      Same for phone_e164_candidates. If either succeeds, STOP: H2 is open.
--
-- H6 / group membership
--  6. As A: create a group naming B. Read group_members -> B's row is
--     status='invited', role='member', joined_at NULL. B receives an "invited
--     you to join" notification.
--  7. As B: the group does NOT appear in the groups list; a raw
--     GET /rest/v1/split_groups?id=eq.<gid> returns zero rows.
--     SELECT public.list_pending_group_memberships(); -> one row with the
--     group's name and A's name.
--  8. As A: PATCH /rest/v1/group_members?id=eq.<B row> {"status":"connected"}
--     -> 42501 GROUP_CONSENT_REQUIRED.
--     As B: the same PATCH -> 42501 too (accept goes through the RPC).
--  9. As A: try to add an expense whose splits name B -> rejected,
--     INACTIVE_GROUP_MEMBER (B is not connected). The exit wedge cannot be built.
-- 10. As B: SELECT public.decline_group_membership('<gid>');
--     -> {"success":true,"reason_code":"DECLINED"}; the row is 'left'.
--     As A: re-INSERT B into the same group -> 23505 MEMBER_ALREADY_EXISTS.
--     Share the group join code instead -> join_group_by_code reuses B's row
--     and connects them (consented).
-- 11. As B (fresh invite): accept_group_membership -> connected; the group and
--     its ledger appear; leave_group behaves exactly as before.
--
-- H3 / invite tokens
-- 12. As a connected member C: GET /rest/v1/group_invites?select=* -> permission
--     denied for column token_hash. With an explicit column list -> rows come
--     back with every field except token_hash.
-- 13. As C, with a token_hash obtained from a pre-migration copy:
--     SELECT public.accept_group_invite('<the hash>', 'C');
--     -> {"status":"INVITE_NOT_FOUND_OR_EXPIRED"} — the hash is inert.
-- 14. As C with the RAW token from the invite URL -> {"status":"ok", ...}.
-- 15. 11 bad tokens inside 15 minutes -> the 11th returns
--     {"status":"RATE_LIMITED","retry_after_seconds":900}, and
--     SELECT count(*) FROM public.invite_accept_attempts WHERE succeeded = false
--     is > 0 (it would have been 0 under the old raising version — that IS the
--     H1 bug class this avoids).
-- 16. A newly created invite has expires_at ≈ now() + 14 days with no client
--     change; redeeming it after that returns INVITE_NOT_FOUND_OR_EXPIRED.
-- ───────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────────────
-- APPLY ORDER
--
-- Prerequisites (any order, all must already be applied):
--   supabase-schema.sql
--   supabase-migration-fix-rls-recursion.sql
--   supabase-migration-prelaunch-hardening.sql
--   supabase-migration-p0-launch-blockers.sql
--   supabase-migration-safe-leave-group.sql          (guard extended here)
--   supabase-migration-phase1-persons.sql
--   supabase-migration-phase2a-linked-profile.sql
--   supabase-migration-safe-contact-archive.sql      (persons.archived_at)
--   supabase-migration-connections-push-discovery.sql(notify_contact_linked v3,
--                                                     respond_contact_link,
--                                                     profiles.phone_e164 /
--                                                     phone_discoverable,
--                                                     phone_lookup_attempts —
--                                                     all restated here with
--                                                     IF NOT EXISTS, but
--                                                     lookup_hisaab_users_by_phone
--                                                     itself is NOT, so phone
--                                                     discovery still needs it)
--   supabase-migration-fix-group-invite-join-rpc.sql (accept_group_invite v1)
--
-- The three audit-p0 siblings written today, in this order:
--   1. supabase-migration-audit-p0-group-ledger-integrity.sql
--        Policies/triggers on group_expenses + group_settlements. Disjoint
--        from this file, but its expense trigger is what makes step 9 of the
--        manual QA above pass, so applying it first makes the H6 fix
--        demonstrable end-to-end.
--   2. supabase-migration-audit-p0-join-abuse-limits.sql
--        Creates code_lookup_attempts and rewrites join_group_by_code +
--        lookup_profile_by_code. This file RESTATES code_lookup_attempts with
--        IF NOT EXISTS, so the order between 2 and 3 is not load-bearing — but
--        applying 2 first means link_contact_by_code shares an already-live
--        rate window instead of creating it.
--   3. supabase-migration-audit-p0-consent-guards.sql  <- THIS FILE
--        Applied last because it redefines accept_group_invite (which file 2
--        leaves alone) and extends the group_members guard from
--        safe-leave-group.
--
-- CLIENT: this file changes four contracts (persons.linked_profile_id writes,
-- owner-added member status, group_invites SELECT columns, accept_group_invite
-- signature and return shape). The client is updated in the NEXT batch; until
-- it lands, code-linking a contact, creating a group with members, viewing a
-- group's invites, and redeeming an invite link will fail. Do not deploy this
-- to production ahead of that client change.
-- ───────────────────────────────────────────────────────────────────────────
