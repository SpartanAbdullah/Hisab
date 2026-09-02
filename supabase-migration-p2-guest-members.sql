-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P2: GUEST MEMBERS IN GROUPS
--   audit docs/audit-2026-09/11-competitive-analysis.md  G6 / O4  (medium)
--   audit docs/audit-2026-09/06-user-experience.md       B6       (July, open)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- APPLY ORDER — this file must come AFTER, in this order:
--     supabase-migration-audit-p0-group-ledger-integrity.sql   (the connected-
--       member triggers on group_expenses / group_settlements this file leans on)
--     supabase-migration-audit-p0-group-concurrency.sql        (record_group_settlement,
--       group_settlement_cap)
--     supabase-migration-audit-p0-account-deletion.sql         (status='left' on
--       a deleted account's seat — the reason is_guest excludes 'left')
--     supabase-migration-audit-p0-group-deletion-guard.sql     (Tier A/B, the
--       archived-group freeze this file must not bypass)
--     supabase-migration-audit-p0-consent-guards.sql           (the invite-consent
--       trigger and the guest-seat self-claim carve-out)
--     supabase-migration-p1-money-bounds.sql                   (the split-amount
--       validator, whose membership predicate is status-agnostic — §0.3)
--     supabase-migration-p2-trust-safety.sql                   (this file
--       CREATE OR REPLACEs its join_group_by_code — mini-diff [G1] in §5)
--   Registered in supabase/tests/apply-order.txt after the p2-analytics files.
--
-- ════════════════════════════════════════════════════════════════════════════
-- §0. WHAT A GUEST IS, AND WHY ALMOST NOTHING HAD TO CHANGE
-- ════════════════════════════════════════════════════════════════════════════
-- THE PROBLEM (11-competitive-analysis.md:88, O4 at :121). Every Cluster A
-- rival — Splitwise placeholder friends, Settle Up offline members, Splid
-- anonymous members, Tricount profiles — lets a group contain people who never
-- install the app. Hisaab's CreateGroupModal (src/pages/CreateGroupModal.tsx
-- :51-79) resolves members ONLY by a Hisaab public code, and nothing on screen
-- says so. Ad-hoc SplitWithSheet already proves the data model holds non-app
-- people; the GROUP container is where July blocker B6 is still open.
--
-- THE DEFINITION CHOSEN:
--     a guest = group_members row with
--                 profile_id IS NULL          (no Hisaab account behind it)
--                 status     = 'connected'    (a LIVE participant)
--                 display_name                (what the owner typed)
--               + an optional row in the new group_guest_identities table
--                 holding SHA-256 hashes of their phone, for a later claim.
--
-- `status = 'connected'` is the load-bearing decision, and it is why this
-- migration adds almost no enforcement. Read what already gates the ledger:
--
--   0.1  tg_group_expenses_require_connected_members
--        (audit-p0-group-ledger-integrity.sql:396-441) requires
--          · ≥ 2 members with status='connected' in the group,
--          · paid_by to be a status='connected' member,
--          · EVERY split participant to be a status='connected' member.
--        It never inspects profile_id. A guest at 'connected' satisfies all
--        three unchanged — so guests can be split participants and payers with
--        ZERO change to that trigger.
--
--   0.2  tg_group_settlements_require_connected_members (:455-521) and
--        public.record_group_settlement (audit-p0-group-concurrency.sql
--        :365-376) require from_member AND to_member to be status='connected'
--        members of the group — again with no profile_id test. So the task's
--        "relax both-connected to both-connected-OR-guest" turns out to need NO
--        relaxation at all: a guest IS connected. What still gates the write is
--        the RECORDER: record_group_settlement:356 demands
--        is_group_member(group, auth.uid()), and is_group_member
--        (consent-guards.sql §2.1) still means "profile_id = uid AND status =
--        'connected'". A guest has a NULL profile_id, so is_group_member is
--        false for them and nobody can act AS a guest — a settlement involving
--        one is always recorded BY a real connected member on their behalf.
--        That is exactly the semantics we want, and it is already true.
--        Verification 6.4 and supabase/tests/tests/8y-guest-members.sql assert
--        it rather than assuming it. The outstanding-amount cap
--        (group_settlement_cap) is arithmetic over expenses/settlements and
--        never reads profile_id, so it applies to a guest edge unchanged.
--
--   0.3  tg_group_expenses_validate_split_amounts (p1-money-bounds.sql:446+,
--        header §2 at :140-151) checks that every split memberId "belongs to
--        THIS group, any status" — deliberately weaker than its sibling. So a
--        guest id in the splits array passes the arithmetic validator too.
--        CONFIRMED by reading, as the task asked.
--
--   0.4  DELETION GUARD. tg_split_groups_guard_delete
--        (group-deletion-guard.sql:496-540): Tier A counts other members with
--        `status='connected' AND profile_id IS NOT NULL`; Tier B filters
--        `b.member_profile_id IS NOT NULL`. BOTH already scope to profile-linked
--        members, so guests never block a group delete — which is what that
--        file's own header (:93-110) argued for when guests were inert legacy
--        rows, and stays true now that they are live participants. Its header
--        observation "guests can never settle" is SUPERSEDED by this file and
--        that is deliberate: guests can now be settled WITH (by a real member),
--        which strictly improves the situation the header worried about — an
--        owner who owes a guest can now clear that balance instead of being
--        stranded. Nothing about the delete verdict changes.
--
--   0.5  ACCOUNT DELETION. delete_current_user's "does this group still have
--        another participant" test (account-deletion.sql:523-530) is
--        `status='connected' AND profile_id IS NOT NULL AND profile_id <> uid`,
--        so a group whose only other members are guests is still SOLO and is
--        still hard-deleted with the account — no new OWNED_GROUPS_WITH_MEMBERS
--        dead-end. In every SHARED group the caller's own seat goes
--        profile_id := NULL, status := 'left'; other members' guest rows are
--        never touched. Asserted in the Docker suite.
--
--   0.6  is_guest EXCLUDES status='left' ON PURPOSE. account-deletion.sql
--        :112-124 sets a departed account's seat to profile_id NULL AND
--        status='left' precisely so it is NOT claimable. If is_guest were just
--        `profile_id IS NULL`, every deleted-account seat would read as an
--        unclaimed guest. `status <> 'left'` keeps that distinction and also
--        keeps LEGACY placeholders (the old status='guest' default,
--        supabase-schema.sql:322) labelled as guests, which they are.
--
--   0.7  ARCHIVED GROUPS. tg_block_join_archived_group
--        (group-deletion-guard.sql:680-714) refuses ANY row entering
--        status='connected' in an archived group, and it is NOT role-scoped —
--        it fires for SECURITY DEFINER callers too. add_group_guest therefore
--        pre-checks archived_at and returns GROUP_ARCHIVED rather than letting
--        that trigger raise.
--
--   0.8  CONSENT IS UNTOUCHED. tg_group_members_require_invite_consent
--        (consent-guards.sql:912-971) already returns NEW unchanged when
--        `NEW.profile_id IS NULL` — "guest placeholders carry no consent
--        question" (:930-932). A guest is not a person's account, so nothing
--        here weakens H6/SEC-05: no real user is conscripted, no stranger is
--        named in a split, and the only way a guest seat ever gains a
--        profile_id is a consented claim (§5) run by that profile themselves.
--
--   0.9  BOTH APP MODES. group_expenses / group_settlements have no account
--        columns at all (p1-money-bounds.sql:175-181), and nothing in this file
--        touches accounts, transactions or balances. full_tracker and
--        splits_only therefore behave IDENTICALLY for every guest flow — the
--        artifacts a guest expense/settlement leaves (group_expenses row,
--        group_settlements row, group_events row, member list entry) are the
--        same in both, and no artifact is mode-conditional. tasks/lessons.md:6-13.
--
-- ════════════════════════════════════════════════════════════════════════════
-- §0b. WHO MAY ADD A GUEST — owner AND any connected member (decided)
-- ════════════════════════════════════════════════════════════════════════════
-- Splitwise lets any group member add a placeholder; Settle Up and Splid the
-- same. Owner-only would break the flatmate story the moment the flatmate who
-- did NOT create the group pays for the cleaner. The blast radius is small and
-- bounded: a guest has no account, receives no notification, cannot be
-- conscripted and cannot act; the worst a malicious member can do is clutter
-- one group's member list, which is capped at 25 guests / 60 members per group
-- and is visible to everyone (the add writes a group_events row).
-- REMOVAL is narrower — owner OR the member who added the guest — and only
-- while the seat has no ledger rows at all (§4b). Once money references a
-- guest, the seat is permanent, exactly like a real member's.
--
-- ════════════════════════════════════════════════════════════════════════════
-- §0c. RESIDUAL RISK, STATED PLAINLY (the phone-hash claim)
-- ════════════════════════════════════════════════════════════════════════════
-- profiles.phone_e164 is SELF-ASSERTED — connections-push-discovery.sql adds
-- the column and the phone_discoverable opt-in, but nothing verifies the number
-- by OTP. So a phone-hash guest claim (§5) proves "this joiner typed the same
-- number the seat's creator typed", not "this joiner controls that number".
-- To exploit it an attacker needs the group's join code (32^6 keyspace, 5 failed
-- attempts per 5 minutes) AND the victim's number, and the prize is inheriting a
-- LEDGER POSITION inside a group they could have joined anyway — no account, no
-- balance and no money moves, because group money never touches accounts (§0.9).
-- Mitigations shipped here rather than pretending the risk away:
--   · the claim requires an EXACT, UNIQUE hash match; two matching seats claim
--     neither (ambiguity is refused, never guessed — same discipline as
--     whoOwesMe rule 2, docs/who-owes-me.md §3);
--   · the claim is announced: the profile_id NULL -> uid transition satisfies
--     tg_group_members_notify's v_became test (audit-p0-notifications.sql
--     :379-381), so every other connected member gets a member_joined event and
--     notification. A silent takeover is not possible;
--   · the hashes live in a table NO client role can read (§2), so a co-member
--     cannot even enumerate which guests carry a number;
--   · the owner-assigned path (an invite link with linked_member_id, §5b)
--     needs no phone at all and is the stronger option — it requires possession
--     of an owner-issued single-use token.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1. group_members.is_guest — an explicit, derived column
-- ═══════════════════════════════════════════════════════════════════════════
-- DECIDED: a STORED GENERATED column rather than a plain boolean or a helper
-- function. Reasons, from the schema:
--   * it CANNOT drift. A plain column would need every writer to set it, and
--     there are six of them (client insert, add_group_guest, join_group_by_code,
--     accept_group_invite, accept_group_membership, delete_current_user); the
--     one that forgot would mislabel a seat forever.
--   * the predicate is already the truth. profile_id IS NULL is what every
--     existing guard keys on (§0.4, §0.5, §0.8), so is_guest is a NAME for a
--     rule the database already enforces, not a new fact to keep in sync.
--   * it is readable from PostgREST with no extra query, so the client's Guest
--     tag needs no join, and it is indexable for the claim lookup in §5.
-- Adding it rewrites the table (ACCESS EXCLUSIVE) — group_members is small.
-- It is generated, so it can never be written by any client; PostgREST rejects
-- an INSERT that names it, and no code path in src/lib/supabaseDb.ts does
-- (groupMembersDb.add / addMany / update all build explicit column lists).
ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS is_guest BOOLEAN
    GENERATED ALWAYS AS (profile_id IS NULL AND status <> 'left') STORED;

COMMENT ON COLUMN public.group_members.is_guest IS
  'True for a seat with no Hisaab account behind it that is still a live participant. Excludes status=''left'' so a deleted account''s anonymized seat (audit-p0-account-deletion.sql) is NOT mistaken for a claimable guest.';

-- Claim lookup (§5) and the member-list Guest tag both filter on this.
CREATE INDEX IF NOT EXISTS idx_group_members_group_guest
  ON public.group_members(group_id)
  WHERE profile_id IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2. group_guest_identities — the hashed phone, invisible to clients
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A SEPARATE TABLE, not a column on group_members. A hash of a 10-digit
-- national number is trivially brute-forced, so it is PII in practice and must
-- not be readable by co-members. Hiding a COLUMN needs the grant surgery
-- consent-guards.sql §3.2 performed on group_invites (revoke the table grant,
-- grant the safe columns back) — and group_members is read by
-- select('*') in two hot paths AND by a realtime postgres_changes subscription
-- (src/lib/realtime.ts:156,367), which a column-grant revoke would put at risk
-- for no gain. A sibling table with deny-all RLS achieves strictly MORE (not
-- even the owner can read the hash back) at zero risk to existing reads.
CREATE TABLE IF NOT EXISTS public.group_guest_identities (
  member_id    TEXT PRIMARY KEY REFERENCES public.group_members(id) ON DELETE CASCADE,
  group_id     TEXT NOT NULL REFERENCES public.split_groups(id) ON DELETE CASCADE,
  -- Every E.164 candidate the typed number could mean, hashed. An array, not a
  -- scalar: phone_e164_candidates can legitimately return two candidates for
  -- one typed string (a national number that also parses as a country-coded
  -- one), and storing only the first would silently break the claim.
  phone_hashes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_guest_identities_group
  ON public.group_guest_identities(group_id);

ALTER TABLE public.group_guest_identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no client access to group_guest_identities" ON public.group_guest_identities;
CREATE POLICY "no client access to group_guest_identities"
  ON public.group_guest_identities FOR ALL
  USING (false) WITH CHECK (false);

-- Belt and braces: RLS with no permissive policy already denies, but an
-- explicit REVOKE means a future "add a policy for debugging" cannot quietly
-- widen it. service_role is untouched (support tooling).
REVOKE ALL ON public.group_guest_identities FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.group_guest_identities IS
  'Hashed phone identities for guest group seats. No client role may read or write it; only add_group_guest writes and only join_group_by_code reads. Raw numbers are never stored.';

-- pgcrypto, same defensive install as consent-guards.sql §3.1.
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

-- SHA-256 lowercase hex of one E.164 string, same shape as hash_invite_token
-- (consent-guards.sql §3.1). Deliberately unsalted: there is no secret this
-- migration could keep that the database itself would not also hold, so the
-- protection is the deny-all table above, not the digest.
CREATE OR REPLACE FUNCTION public.hash_phone_e164(p_e164 TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT CASE
           WHEN p_e164 IS NULL OR btrim(p_e164) = '' THEN NULL
           ELSE encode(digest(btrim(p_e164), 'sha256'), 'hex')
         END;
$$;

REVOKE ALL ON FUNCTION public.hash_phone_e164(TEXT) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.hash_phone_e164(TEXT) IS
  'SHA-256 lowercase hex of one E.164 number. Never client-executable: it is only meaningful next to group_guest_identities, which no client can read.';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3. The floor under every guest-seat INSERT
-- ═══════════════════════════════════════════════════════════════════════════
-- add_group_guest (§4) is the client's path and returns clean status objects.
-- This trigger is the invariant underneath it, and it deliberately fires for
-- EVERY role — including SECURITY DEFINER callers — because the group owner can
-- still POST a guest row straight to /rest/v1/group_members under the existing
-- "Users can add members to own or shared groups" policy (supabase-schema.sql
-- :365-374, profile_id IS NULL makes `auth.uid() = profile_id` NULL, so it is
-- the owner branch that lets the row through). Without this, that raw path
-- would bypass the cap, the duplicate-name rule, and would keep minting inert
-- status='guest' rows.
--
-- A SEPARATE trigger, not an edit to tg_group_members_require_invite_consent:
-- that function reads current_user to exempt definer RPCs (consent-guards.sql
-- :922) and its body is asserted string-by-string by its own verification block
-- and by p2-trust-safety. Same reasoning p2-trust-safety.sql:1691-1699 gives for
-- tg_group_members_block_guard. Name order matters only for which error a
-- doubly-invalid write reports first; BEFORE-row triggers fire alphabetically,
-- so this one ('group_members_guest_seat_rules') runs before
-- 'group_members_require_invite_consent', which returns NEW unchanged for a
-- NULL profile_id anyway.
CREATE OR REPLACE FUNCTION public.tg_group_members_guest_seat_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  -- Bounds, not policy: a guest costs one row and no notification, but an
  -- unbounded list is an amplifier and makes the member picker unusable.
  c_max_guests  CONSTANT INTEGER := 25;
  c_max_members CONSTANT INTEGER := 60;
  v_name        TEXT;
  v_guests      INTEGER;
  v_members     INTEGER;
BEGIN
  -- Only unclaimed placeholder seats. Every row with an account behind it is
  -- someone else's business (consent-guards owns those rules).
  IF NEW.profile_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_name := btrim(COALESCE(NEW.display_name, ''));
  IF v_name = '' OR length(v_name) > 60 THEN
    RAISE EXCEPTION 'INVALID_GUEST_NAME: a guest needs a name of 1-60 characters'
      USING ERRCODE = '23514';
  END IF;
  NEW.display_name := v_name;

  -- A guest is a LIVE participant, and never an owner. Forcing rather than
  -- rejecting mirrors tg_group_members_require_invite_consent's own rationale
  -- (consent-guards.sql:952-953): a client that still writes the legacy
  -- status='guest' must not have group creation bricked under it.
  IF COALESCE(NEW.status, '') IN ('', 'guest') THEN
    NEW.status := 'connected';
  END IF;
  NEW.role := 'member';

  -- Two members with the same name in one group are indistinguishable
  -- everywhere the app keys people by NAME — the repo-wide person key is
  -- `personId ?? lowercased trimmed name` and docs/who-owes-me.md §3 rule 3
  -- merges same-named members into ONE row. Refusing here is the honest
  -- alternative to silently merging two different people's money later.
  -- Scoped to LIVE seats, so a 'left' member's old name is reusable.
  IF EXISTS (
    SELECT 1 FROM public.group_members AS gm
     WHERE gm.group_id = NEW.group_id
       AND gm.id IS DISTINCT FROM NEW.id
       AND gm.status IN ('connected', 'invited')
       AND lower(btrim(gm.display_name)) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_GROUP_MEMBER_NAME: someone in this group already uses that name'
      USING ERRCODE = '23505';
  END IF;

  SELECT count(*) FILTER (WHERE gm.profile_id IS NULL AND gm.status <> 'left'),
         count(*) FILTER (WHERE gm.status <> 'left')
    INTO v_guests, v_members
    FROM public.group_members AS gm
   WHERE gm.group_id = NEW.group_id;

  IF v_guests >= c_max_guests THEN
    RAISE EXCEPTION 'TOO_MANY_GROUP_GUESTS: a group can hold at most % guests', c_max_guests
      USING ERRCODE = '23514';
  END IF;
  IF v_members >= c_max_members THEN
    RAISE EXCEPTION 'TOO_MANY_GROUP_MEMBERS: a group can hold at most % members', c_max_members
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_members_guest_seat_rules ON public.group_members;
CREATE TRIGGER group_members_guest_seat_rules
  BEFORE INSERT ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_guest_seat_rules();

COMMENT ON FUNCTION public.tg_group_members_guest_seat_rules() IS
  'G6/O4: normalises and bounds every guest seat (profile_id IS NULL) however it is inserted — status=connected, role=member, trimmed 1-60 char name, no duplicate live name in the group, <=25 guests and <=60 members. Fires for definer callers too, because the owner can still POST a guest row directly.';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3b. ADDENDUM — the floor under a guest-seat RENAME (residual close)
-- ═══════════════════════════════════════════════════════════════════════════
-- §3 above is BEFORE INSERT only — a Postgres row trigger never fires on an
-- UPDATE it was not also declared for. src/stores/splitStore.ts's
-- renameGroupGuest says so itself (:148-151): "there is NO server RPC and NO
-- trigger validating this write (tg_group_members_guest_seat_rules is BEFORE
-- INSERT only), so the 1-40-char + live-duplicate checks here are the ONLY
-- enforcement." A client-only guard is invisible to a second device: two
-- owner sessions can each pass their own optimistic check and race two guests
-- onto the same live name, or race a rename against a concurrent
-- add_group_guest call. This closes that gap the same way §3 closed the
-- INSERT gap — a SEPARATE trigger, not an edit to
-- tg_group_members_protect_membership_fields (consent-guards.sql §2.3, also
-- BEFORE UPDATE on group_members): that function owns group_id/role/
-- profile_id/status and its body is asserted string-by-string by this file's
-- own §6.4 and by consent-guards.sql's verification block. A plain rename
-- (UPDATE ... SET display_name = ...) touches none of the columns that
-- function inspects, so the two triggers COMPOSE rather than collide — both
-- run, neither's outcome depends on the other, and BEFORE-row triggers fire
-- alphabetically ('group_members_guest_rename_rules' before
-- 'group_members_protect_membership_fields') for the rare case both would
-- have something to say.
--
-- SCOPE: guest seats only, read off OLD (this is BEFORE UPDATE — OLD is the
-- row as it stood before the statement). OLD.profile_id IS NOT NULL (a real
-- account behind the seat) or OLD.status = 'left' (a departed account's
-- anonymized seat, §0.6 — NOT a claimable guest) both return NEW unchanged,
-- mirroring §3's own "profile_id IS NOT NULL -> RETURN NEW" branch. A
-- profile-linked member's rename is untouched by this trigger, full stop.
--
-- Client-role scoped exactly like tg_group_members_protect_membership_fields
-- (consent-guards.sql:1022, "current_user NOT IN ('authenticated', 'anon')"):
-- skips entirely for a SECURITY DEFINER caller. Nothing renames a guest via
-- RPC today, but the pattern is the repo's convention for guards that must
-- not fight a future definer path.
--
-- CODES: the exact same stable strings §3 already raises (this file, :326 and
-- :353) — INVALID_GUEST_NAME and DUPLICATE_GROUP_MEMBER_NAME, same ERRCODEs
-- (23514 / 23505) — reused byte-for-byte rather than invented fresh, so any
-- future wiring of renameGroupGuest onto these errors (GroupDetailPage.tsx's
-- and GroupInviteModal.tsx's renameFailureMessage already expect a
-- DUPLICATE_NAME / INVALID_NAME status vocabulary matching add/remove's) keys
-- on the same names add_group_guest's own duplicate-name unique_violation
-- catch (§4a) does. The bound is 1-40, not §3's 1-60 — renameGroupGuest's own
-- client-side bound (splitStore.ts:821, guest_err_rename_invalid's copy),
-- because rename is a DIFFERENT, tighter contract than add and this trigger
-- is the floor under THAT contract, not §3's.
CREATE OR REPLACE FUNCTION public.tg_group_members_guest_rename_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_name TEXT;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Only a LIVE guest seat. A profile-linked member's rename, or a rename
  -- landing on a departed ('left') seat, is someone else's business.
  IF OLD.profile_id IS NOT NULL OR OLD.status = 'left' THEN
    RETURN NEW;
  END IF;

  v_name := btrim(COALESCE(NEW.display_name, ''));
  IF v_name = '' OR length(v_name) > 40 THEN
    RAISE EXCEPTION 'INVALID_GUEST_NAME: a guest needs a name of 1-40 characters'
      USING ERRCODE = '23514';
  END IF;
  NEW.display_name := v_name;

  -- Same scope the client already checks (splitStore.ts:840-844): any LIVE
  -- seat (status <> 'left'), not just 'connected'/'invited' — a rename must
  -- not collide with anyone the app currently displays as a member.
  IF EXISTS (
    SELECT 1 FROM public.group_members AS gm
     WHERE gm.group_id = OLD.group_id
       AND gm.id IS DISTINCT FROM OLD.id
       AND gm.status <> 'left'
       AND lower(btrim(gm.display_name)) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_GROUP_MEMBER_NAME: someone in this group already uses that name'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS group_members_guest_rename_rules ON public.group_members;
CREATE TRIGGER group_members_guest_rename_rules
  BEFORE UPDATE OF display_name ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_group_members_guest_rename_rules();

COMMENT ON FUNCTION public.tg_group_members_guest_rename_rules() IS
  'Residual close (P2 follow-up): §3''s BEFORE INSERT guest-seat rules had no UPDATE twin, so a guest rename (owner UPDATE of display_name, e.g. src/stores/splitStore.ts renameGroupGuest) was validated ONLY client-side and two owner devices could race two guests onto one name. BEFORE UPDATE OF display_name, guest seats only (profile_id IS NULL AND status <> left): trims and bounds to 1-40 chars, refuses a live duplicate name (any status except left, case-insensitive). Composes with, never replaces, tg_group_members_protect_membership_fields. Reuses INVALID_GUEST_NAME / DUPLICATE_GROUP_MEMBER_NAME verbatim from the INSERT trigger.';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4a. add_group_guest — the client's path
-- ═══════════════════════════════════════════════════════════════════════════
-- Contract (status object, never RAISE on a business outcome — the repo rule
-- from audit H1: a RAISE rolls back everything the call already committed):
--
--   add_group_guest(p_group_id TEXT, p_display_name TEXT,
--                   p_phone TEXT DEFAULT NULL, p_member_id TEXT DEFAULT NULL)
--     -> {"status":"ok","member_id":…,"display_name":…,"has_phone":bool}
--        {"status":"ALREADY_ADDED","member_id":…}    -- idempotent replay
--        {"status":"NOT_AUTHENTICATED"}
--        {"status":"NOT_ACTIVE_MEMBER"}              -- also the answer for a
--                                                       guessed group id
--        {"status":"GROUP_ARCHIVED"}
--        {"status":"INVALID_NAME"}
--        {"status":"DUPLICATE_NAME"}
--        {"status":"TOO_MANY_GUESTS","limit":25}
--        {"status":"TOO_MANY_MEMBERS","limit":60}
--
-- p_member_id lets the CLIENT mint the id (uuid, like every other group write
-- in splitStore) so a double tap or a retry after a dropped response replays
-- onto the same row instead of creating a twin — the same idempotency contract
-- record_group_settlement uses on p_settlement_id.
--
-- p_phone is the RAW string the user typed. It is normalised through
-- phone_e164_candidates (consent-guards.sql §1.3 — the SQL twin of
-- src/lib/phoneIdentity.ts) and only the HASHES are stored. The raw number
-- never lands in a column and is never echoed back; `has_phone` is the only
-- thing the caller learns, and a number that yields no E.164 candidate is
-- accepted as "no phone" rather than refused (the guest is still perfectly
-- usable without one — the phone only buys the later auto-claim).
CREATE OR REPLACE FUNCTION public.add_group_guest(
  p_group_id     TEXT,
  p_display_name TEXT,
  p_phone        TEXT DEFAULT NULL,
  p_member_id    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_max_guests  CONSTANT INTEGER := 25;
  c_max_members CONSTANT INTEGER := 60;
  v_uid        UUID := auth.uid();
  v_now        TIMESTAMPTZ := now();
  v_group      public.split_groups%ROWTYPE;
  v_name       TEXT;
  v_member_id  TEXT;
  v_existing   public.group_members%ROWTYPE;
  v_candidates TEXT[];
  v_hashes     TEXT[] := ARRAY[]::TEXT[];
  v_candidate  TEXT;
  v_guests     INTEGER;
  v_members    INTEGER;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  v_name := btrim(COALESCE(p_display_name, ''));
  IF v_name = '' OR length(v_name) > 60 THEN
    RETURN jsonb_build_object('status', 'INVALID_NAME');
  END IF;

  -- Lock the group for the same reason record_group_settlement does: the cap
  -- read and the insert must not race another member adding a guest.
  SELECT * INTO v_group
    FROM public.split_groups
   WHERE id = p_group_id
   FOR NO KEY UPDATE;

  -- One shared response for a missing group, a guessed id and a non-member, so
  -- this RPC is not a "does group X exist" oracle (leave_group's discipline).
  IF v_group.id IS NULL OR NOT public.is_group_member(p_group_id, v_uid) THEN
    RETURN jsonb_build_object('status', 'NOT_ACTIVE_MEMBER');
  END IF;

  -- §0.7: tg_block_join_archived_group would RAISE on the insert below, which
  -- would roll this call back. Answer with data instead.
  IF v_group.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'GROUP_ARCHIVED');
  END IF;

  v_member_id := COALESCE(NULLIF(btrim(p_member_id), ''), gen_random_uuid()::text);

  -- Idempotent replay. Scoped to this group so a caller cannot probe for the
  -- existence of a member id in someone else's group.
  SELECT * INTO v_existing
    FROM public.group_members AS gm
   WHERE gm.id = v_member_id
     AND gm.group_id = p_group_id;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'ALREADY_ADDED', 'member_id', v_existing.id);
  END IF;

  -- Pre-checks that mirror the §3 trigger, so the common failures come back as
  -- data. The trigger stays the authority (it also covers the raw POST path);
  -- the EXCEPTION block below catches the rare race between the two.
  IF EXISTS (
    SELECT 1 FROM public.group_members AS gm
     WHERE gm.group_id = p_group_id
       AND gm.status IN ('connected', 'invited')
       AND lower(btrim(gm.display_name)) = lower(v_name)
  ) THEN
    RETURN jsonb_build_object('status', 'DUPLICATE_NAME');
  END IF;

  SELECT count(*) FILTER (WHERE gm.profile_id IS NULL AND gm.status <> 'left'),
         count(*) FILTER (WHERE gm.status <> 'left')
    INTO v_guests, v_members
    FROM public.group_members AS gm
   WHERE gm.group_id = p_group_id;

  IF v_guests >= c_max_guests THEN
    RETURN jsonb_build_object('status', 'TOO_MANY_GUESTS', 'limit', c_max_guests);
  END IF;
  IF v_members >= c_max_members THEN
    RETURN jsonb_build_object('status', 'TOO_MANY_MEMBERS', 'limit', c_max_members);
  END IF;

  BEGIN
    INSERT INTO public.group_members(
      id, group_id, profile_id, display_name, role, status, invited_by, joined_at, created_at
    ) VALUES (
      v_member_id, p_group_id, NULL, v_name, 'member', 'connected', v_uid, NULL, v_now
    );
  EXCEPTION
    WHEN unique_violation THEN
      -- DUPLICATE_GROUP_MEMBER_NAME from the trigger, or a genuine PK race.
      RETURN jsonb_build_object('status', 'DUPLICATE_NAME');
    WHEN check_violation THEN
      RETURN jsonb_build_object('status', 'TOO_MANY_GUESTS', 'limit', c_max_guests);
  END;

  -- Phone -> E.164 candidates -> hashes. Nothing raw is retained.
  v_candidates := public.phone_e164_candidates(p_phone);
  IF array_length(v_candidates, 1) IS NOT NULL THEN
    FOREACH v_candidate IN ARRAY v_candidates LOOP
      v_hashes := v_hashes || public.hash_phone_e164(v_candidate);
    END LOOP;
  END IF;

  IF array_length(v_hashes, 1) IS NOT NULL THEN
    INSERT INTO public.group_guest_identities(member_id, group_id, phone_hashes, created_by, created_at)
    VALUES (v_member_id, p_group_id, v_hashes, v_uid, v_now)
    ON CONFLICT (member_id) DO UPDATE SET phone_hashes = EXCLUDED.phone_hashes;
  END IF;

  -- Transparency: the activity feed records who added whom. Recipients is an
  -- EMPTY array, not NULL — a guest is not an event worth a push to everyone,
  -- but it must not be invisible either. fan_out_group_notification writes the
  -- durable group_events row first and only then filters recipients
  -- (p2-trust-safety.sql:1549+), so an empty array yields exactly the feed row
  -- and zero notifications. Best-effort: a feed failure must never lose a
  -- member row (the same rule tg_group_members_notify_invited follows).
  BEGIN
    PERFORM public.fan_out_group_notification(
      p_group_id, v_uid, 'guest_added', 'member', v_member_id,
      'group_added', jsonb_build_object('memberId', v_member_id, 'displayName', v_name),
      ARRAY[]::UUID[],
      '{actor} added ' || v_name || ' (not on Hisaab)'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'status', 'ok',
    'member_id', v_member_id,
    'display_name', v_name,
    'has_phone', array_length(v_hashes, 1) IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.add_group_guest(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_group_guest(TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.add_group_guest(TEXT, TEXT, TEXT, TEXT) IS
  'G6/O4: any CONNECTED member of the group adds a named seat with no Hisaab account (profile_id NULL, status connected). The phone is normalised to E.164 candidates and stored only as SHA-256 hashes in group_guest_identities, which no client can read. Idempotent on p_member_id; failures are data, never exceptions.';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4b. remove_group_guest — undoing a typo, and nothing more
-- ═══════════════════════════════════════════════════════════════════════════
-- group_members has had NO client DELETE path since safe-leave-group.sql:16-17
-- dropped it, and that is correct: a member id is referenced by paid_by,
-- from_member, to_member and every splits[].memberId, so deleting one would
-- dangle the ledger. But without an escape hatch a mistyped guest name would be
-- permanent, and the seat cannot leave on its own (a guest has no account and
-- so can never call leave_group). This RPC threads that needle:
--   * only a guest seat, only while it has ZERO ledger references anywhere
--     (expenses paid, splits participated in, settlements either side —
--     soft-deleted rows INCLUDED, because a deleted expense can be restored
--     and its member id must still resolve);
--   * only the group owner or the member who added it;
--   * hard DELETE, so the group_guest_identities row goes with it (CASCADE).
--
--   remove_group_guest(p_group_id TEXT, p_member_id TEXT) -> JSONB
--     {"status":"ok","member_id":…}
--     {"status":"NOT_AUTHENTICATED"} {"status":"NOT_ACTIVE_MEMBER"}
--     {"status":"GROUP_ARCHIVED"} {"status":"NOT_A_GUEST"}
--     {"status":"NOT_ALLOWED"}        -- not the owner and not the adder
--     {"status":"GUEST_HAS_LEDGER"}   -- money references this seat; keep it
CREATE OR REPLACE FUNCTION public.remove_group_guest(
  p_group_id  TEXT,
  p_member_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_group  public.split_groups%ROWTYPE;
  v_member public.group_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  SELECT * INTO v_group
    FROM public.split_groups WHERE id = p_group_id FOR NO KEY UPDATE;

  IF v_group.id IS NULL OR NOT public.is_group_member(p_group_id, v_uid) THEN
    RETURN jsonb_build_object('status', 'NOT_ACTIVE_MEMBER');
  END IF;
  IF v_group.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'GROUP_ARCHIVED');
  END IF;

  SELECT * INTO v_member
    FROM public.group_members AS gm
   WHERE gm.id = p_member_id
     AND gm.group_id = p_group_id
   FOR UPDATE;

  IF v_member.id IS NULL OR v_member.profile_id IS NOT NULL OR v_member.status = 'left' THEN
    RETURN jsonb_build_object('status', 'NOT_A_GUEST');
  END IF;

  IF v_group.user_id IS DISTINCT FROM v_uid
     AND v_member.invited_by IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('status', 'NOT_ALLOWED');
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.group_expenses e
        WHERE e.group_id = p_group_id
          AND (e.paid_by = p_member_id
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(COALESCE(e.splits, '[]'::jsonb)) AS s(value)
                  WHERE COALESCE(s.value->>'memberId', s.value->>'member_id') = p_member_id))
     ) OR EXISTS (
       SELECT 1 FROM public.group_settlements st
        WHERE st.group_id = p_group_id
          AND (st.from_member = p_member_id OR st.to_member = p_member_id)
     ) THEN
    RETURN jsonb_build_object('status', 'GUEST_HAS_LEDGER');
  END IF;

  DELETE FROM public.group_members WHERE id = p_member_id;

  RETURN jsonb_build_object('status', 'ok', 'member_id', p_member_id);
END;
$$;

REVOKE ALL ON FUNCTION public.remove_group_guest(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_group_guest(TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.remove_group_guest(TEXT, TEXT) IS
  'G6/O4: deletes an unused guest seat (owner or the member who added it). Refuses GUEST_HAS_LEDGER the moment any expense, split share or settlement — including soft-deleted ones — references the member id, so the ledger can never dangle.';


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5. THE CLAIM — one mechanism, extended, never a second one
-- ═══════════════════════════════════════════════════════════════════════════
-- 5b (already shipped, verified by reading, UNCHANGED here): the OWNER-ASSIGNED
-- path. accept_group_invite (consent-guards.sql §3.5, restated by
-- p2-trust-safety.sql §4.2) looks up the invite's linked_member_id and accepts
-- a row with `gm.profile_id IS NULL OR gm.profile_id = v_uid`, then UPDATEs
-- profile_id := v_uid, status := 'connected'. That IS the guest-seat rebind —
-- "same guest-seat rebind via linked_member_id … Guest-seat rebinding is KEPT"
-- (consent-guards.sql:1505-1510). The client simply has to offer it for a guest
-- seat, which is a UI change (GroupInviteModal), not a SQL one.
--
-- 5a (added here, mini-diff [G1]): the JOIN-BY-CODE path. join_group_by_code
-- previously matched an existing seat ONLY by profile_id, so someone joining a
-- group where a guest seat is waiting for them landed on a brand-new row and
-- their share history stayed orphaned on the placeholder. Below is
-- p2-trust-safety.sql §4.1's body with THREE changes and nothing else:
--
--   [G1a] after the profile_id lookup misses, try exactly one unclaimed guest
--         seat in this group whose stored hashes contain the hash of the
--         CALLER'S OWN profiles.phone_e164. Two or more matches claim NOTHING
--         (ambiguity is refused, never guessed). The client's assertion is
--         never consulted — there is no parameter to spoof, exactly as
--         link_contact_by_discovery re-derives its own match.
--   [G1b] the reactivate branch now also writes `profile_id = v_uid`. For the
--         pre-existing path that is a no-op (the row was found BY profile_id);
--         for a claimed guest seat it is the rebind. The consent-guards UPDATE
--         guard permits it — its single carve-out is exactly
--         "OLD.profile_id IS NULL AND NEW.profile_id = auth.uid()"
--         (consent-guards.sql:1048-1059), self-consent by construction, the
--         same door claimPaidByMemberIfMine already uses.
--   [G1c] was_already_connected is now
--         `status = 'connected' AND profile_id = v_uid`, matching
--         accept_group_invite's own rule (p2-trust-safety.sql:1434). Without
--         this a claimed guest seat — already 'connected' — would report the
--         joiner as already in the group and the client would skip its
--         welcome. A pure bug fix for the new path; identical for the old one.
--
-- EVERYTHING ELSE IS BYTE-FOR-BYTE p2-trust-safety's: no RAISE on a business
-- outcome, the same 5-failures/5-minutes join_code_attempts window with the
-- same "a blocked call is not recorded" rule, CANNOT_JOIN_OWN_GROUP uncharged,
-- and the [J1] audit-M17 owner-block check answering exactly like a wrong code.
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
  -- [G1a]
  v_phone_hash TEXT;
  v_guest_matches INTEGER := 0;
  v_guest_member_id TEXT;
  v_claimed_guest BOOLEAN := false;
BEGIN
  IF v_uid IS NULL OR NOT public.is_current_profile_active() THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  IF p_code_normalized IS NULL OR length(p_code_normalized) <> 6 THEN
    RETURN jsonb_build_object('status', 'INVALID_CODE');
  END IF;

  DELETE FROM public.join_code_attempts AS jca
   WHERE jca.attempted_at < v_now - INTERVAL '1 day';

  SELECT count(*) INTO v_failures
    FROM public.join_code_attempts AS jca
   WHERE jca.user_id = v_uid
     AND jca.succeeded = false
     AND jca.attempted_at > v_now - INTERVAL '5 minutes';
  IF v_failures >= 5 THEN
    RETURN jsonb_build_object('status', 'RATE_LIMITED', 'retry_after_seconds', 300);
  END IF;

  SELECT sg.* INTO v_group
    FROM public.split_groups AS sg
   WHERE sg.join_code_normalized = p_code_normalized
   LIMIT 1;
  IF v_group.id IS NULL
     OR (v_group.join_code_expires_at IS NOT NULL AND v_group.join_code_expires_at < v_now) THEN
    INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false);
    RETURN jsonb_build_object('status', 'INVALID_OR_EXPIRED_CODE');
  END IF;
  IF v_group.user_id = v_uid THEN
    RETURN jsonb_build_object('status', 'CANNOT_JOIN_OWN_GROUP');
  END IF;

  -- [J1] Audit M17, unchanged.
  IF public.is_blocked_either_way(v_uid, v_group.user_id) THEN
    INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false);
    RETURN jsonb_build_object('status', 'INVALID_OR_EXPIRED_CODE');
  END IF;

  SELECT gm.* INTO v_member
    FROM public.group_members AS gm
   WHERE gm.group_id = v_group.id
     AND gm.profile_id = v_uid
   LIMIT 1;

  -- ── [G1a] guest-seat claim by phone hash ─────────────────────────────────
  -- Only when the joiner has no seat of their own yet. The probe is the
  -- CALLER'S own profiles.phone_e164 — nothing the request can name.
  IF v_member.id IS NULL THEN
    SELECT public.hash_phone_e164(pr.phone_e164) INTO v_phone_hash
      FROM public.profiles AS pr
     WHERE pr.id = v_uid;

    IF v_phone_hash IS NOT NULL THEN
      SELECT count(*), min(gm.id)
        INTO v_guest_matches, v_guest_member_id
        FROM public.group_members AS gm
        JOIN public.group_guest_identities AS gi ON gi.member_id = gm.id
       WHERE gm.group_id = v_group.id
         AND gm.profile_id IS NULL
         AND gm.status = 'connected'
         AND v_phone_hash = ANY (gi.phone_hashes);

      -- Exactly one, or nothing. Two seats carrying the same number is an
      -- ambiguity the server refuses to resolve on the user's behalf.
      IF v_guest_matches = 1 THEN
        SELECT gm.* INTO v_member
          FROM public.group_members AS gm
         WHERE gm.id = v_guest_member_id
         FOR UPDATE;
        v_claimed_guest := v_member.id IS NOT NULL;
      END IF;
    END IF;
  END IF;

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
    -- [G1c] IS NOT DISTINCT FROM, not '=': a guest seat's profile_id is NULL,
    -- and `TRUE AND NULL` is NULL — which would surface as a null
    -- was_already_connected and leave the client's welcome branch undecided.
    v_was_already_connected := (v_member.status = 'connected'
                                AND v_member.profile_id IS NOT DISTINCT FROM v_uid);
    UPDATE public.group_members AS gm
       SET profile_id = v_uid,                       -- [G1b]
           status = 'connected',
           joined_at = COALESCE(gm.joined_at, v_now)
     WHERE gm.id = v_member.id;
  END IF;

  -- The claimed seat's phone identity has done its job and must not linger as
  -- a matchable hash for anyone else.
  IF v_claimed_guest THEN
    DELETE FROM public.group_guest_identities WHERE member_id = v_member.id;
  END IF;

  INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, true);

  RETURN jsonb_build_object(
    'status', 'ok',
    'group_id', v_group.id,
    'member_id', v_member.id,
    'was_already_connected', v_was_already_connected,
    'claimed_guest_seat', v_claimed_guest
  );
END;
$$;

REVOKE ALL ON FUNCTION public.join_group_by_code(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_group_by_code(TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.join_group_by_code(TEXT, TEXT) IS
  'Audit H1 + M17 + G6/O4. Status-object result so the rate window commits; a blocked pair (caller vs group OWNER) is refused as INVALID_OR_EXPIRED_CODE and charged identically to a miss. [G1] A joiner with no seat claims a single unclaimed guest seat whose stored phone hash matches their own profile number — never two, never one the request names.';

COMMIT;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6. VERIFICATION — read-only. Run everything below after the COMMIT.
-- A clean run prints "p2-guest-members: OK".
-- ═══════════════════════════════════════════════════════════════════════════

-- 6.1 Objects exist with the expected shape.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid)             AS returns,
       p.prosecdef                               AS security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('add_group_guest', 'remove_group_guest', 'hash_phone_e164',
                     'join_group_by_code', 'tg_group_members_guest_seat_rules',
                     'tg_group_members_guest_rename_rules')
 ORDER BY p.proname;
-- Expect:
--   add_group_guest(text,text,text,text)     -> jsonb,   t
--   hash_phone_e164(text)                    -> text,    f
--   join_group_by_code(text,text)            -> jsonb,   t
--   remove_group_guest(text,text)            -> jsonb,   t
--   tg_group_members_guest_rename_rules()    -> trigger, f
--   tg_group_members_guest_seat_rules()      -> trigger, f

-- 6.2 Grants: the two client RPCs are reachable, the internals are not.
SELECT has_function_privilege('authenticated', 'public.add_group_guest(text,text,text,text)', 'EXECUTE')  AS client_can_add,
       has_function_privilege('authenticated', 'public.remove_group_guest(text,text)', 'EXECUTE')         AS client_can_remove,
       has_function_privilege('anon',          'public.add_group_guest(text,text,text,text)', 'EXECUTE')  AS anon_can_add,
       has_function_privilege('authenticated', 'public.hash_phone_e164(text)', 'EXECUTE')                 AS client_can_hash,
       has_table_privilege   ('authenticated', 'public.group_guest_identities', 'SELECT')                 AS client_can_read_hashes;
-- Expect: t, t, f, f, f

-- 6.3 Every group's guest seats, and whether they carry a claimable number.
SELECT g.name AS group_name,
       gm.id  AS member_id,
       gm.display_name,
       gm.status,
       gm.is_guest,
       (gi.member_id IS NOT NULL) AS has_phone_hash
  FROM public.group_members gm
  JOIN public.split_groups  g  ON g.id = gm.group_id
  LEFT JOIN public.group_guest_identities gi ON gi.member_id = gm.id
 WHERE gm.profile_id IS NULL
 ORDER BY g.name, gm.created_at;

-- 6.4 THE CONFIRMATIONS §0 claims. Each is read out of the live catalog, not
--     assumed, so a partially-applied database fails loudly here.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  -- §0.1/§0.2: the ledger triggers gate on STATUS, never on profile_id — which
  -- is the entire reason a guest at 'connected' can be a participant.
  SELECT pg_get_functiondef('public.tg_group_expenses_require_connected_members()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%gm.status = ''connected''%' THEN
    RAISE EXCEPTION 'group expense trigger no longer gates on status=connected — guests would be silently rejected or silently allowed';
  END IF;
  IF v_def LIKE '%profile_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'group expense trigger now requires a profile_id — guests can no longer be split participants (G6 regression)';
  END IF;

  SELECT pg_get_functiondef('public.tg_group_settlements_require_connected_members()'::regprocedure) INTO v_def;
  IF v_def LIKE '%profile_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'group settlement trigger now requires a profile_id — a guest could no longer be settled with';
  END IF;

  -- §0.2: the recorder is still a real member. If this ever loosened, a guest
  -- seat would become an identity anyone could act as.
  SELECT pg_get_functiondef('public.record_group_settlement(text,text,text,text,numeric,text,timestamptz)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%is_group_member(p_group_id, uid)%' THEN
    RAISE EXCEPTION 'record_group_settlement no longer requires the RECORDER to be a connected member';
  END IF;
  IF v_def NOT LIKE '%group_settlement_cap%' THEN
    RAISE EXCEPTION 'record_group_settlement no longer applies the outstanding-amount cap';
  END IF;

  -- §0.3: the arithmetic validator stays status-agnostic.
  SELECT pg_get_functiondef('public.tg_group_expenses_validate_split_amounts()'::regprocedure) INTO v_def;
  IF v_def LIKE '%status = ''connected''%' THEN
    RAISE EXCEPTION 'the split-amount validator has grown a status test — it would now duplicate (and can drift from) its sibling';
  END IF;

  -- §0.4: guests never block a delete.
  SELECT pg_get_functiondef('public.tg_split_groups_guard_delete()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%gm.profile_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'the group deletion guard Tier A no longer scopes to profile-linked members — guests would strand every group';
  END IF;
  IF v_def NOT LIKE '%b.member_profile_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'the group deletion guard Tier B no longer scopes to profile-linked members';
  END IF;

  -- §0.8: the consent carve-out this file's claim path relies on.
  SELECT pg_get_functiondef('public.tg_group_members_protect_membership_fields()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%OLD.profile_id IS NULL AND NEW.profile_id = v_uid%' THEN
    RAISE EXCEPTION 'the guest-seat self-claim carve-out is gone — join_group_by_code''s rebind and claimPaidByMemberIfMine would both break';
  END IF;

  SELECT pg_get_functiondef('public.tg_group_members_require_invite_consent()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%NEW.profile_id IS NULL%' THEN
    RAISE EXCEPTION 'the invite-consent trigger no longer exempts guest placeholders';
  END IF;

  -- §5: the three [G1] changes are actually in the deployed body.
  SELECT pg_get_functiondef('public.join_group_by_code(text,text)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%group_guest_identities%' THEN
    RAISE EXCEPTION 'join_group_by_code does not claim guest seats — [G1a] missing';
  END IF;
  IF v_def NOT LIKE '%SET profile_id = v_uid%' THEN
    RAISE EXCEPTION 'join_group_by_code does not rebind profile_id — [G1b] missing, claimed seats stay unclaimed';
  END IF;
  IF v_def NOT LIKE '%v_guest_matches = 1%' THEN
    RAISE EXCEPTION 'join_group_by_code does not require a UNIQUE guest match — an ambiguous phone would be guessed';
  END IF;
  IF v_def LIKE '%RAISE EXCEPTION%' THEN
    RAISE EXCEPTION 'join_group_by_code raises again — the rate-limit ledger row would roll back (audit H1)';
  END IF;
  IF v_def NOT LIKE '%CANNOT_JOIN_OWN_GROUP%' THEN
    RAISE EXCEPTION 'join_group_by_code lost CANNOT_JOIN_OWN_GROUP';
  END IF;
  IF v_def NOT LIKE '%is_blocked_either_way%' THEN
    RAISE EXCEPTION 'join_group_by_code lost the audit-M17 owner-block check';
  END IF;

  -- Structure.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'group_members'
       AND column_name = 'is_guest' AND is_generated = 'ALWAYS'
  ) THEN
    RAISE EXCEPTION 'group_members.is_guest is missing or is not a generated column';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'group_members'
       AND t.tgname = 'group_members_guest_seat_rules'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'group_members_guest_seat_rules trigger is missing';
  END IF;

  -- §3b: the UPDATE OF display_name twin, scoped correctly.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'group_members'
       AND t.tgname = 'group_members_guest_rename_rules'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'group_members_guest_rename_rules trigger is missing — a guest rename has no server-side backstop';
  END IF;

  SELECT pg_get_functiondef('public.tg_group_members_guest_rename_rules()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%INVALID_GUEST_NAME%' OR v_def NOT LIKE '%DUPLICATE_GROUP_MEMBER_NAME%' THEN
    RAISE EXCEPTION 'tg_group_members_guest_rename_rules does not reuse §3''s stable error codes';
  END IF;
  IF v_def NOT LIKE '%OLD.profile_id IS NOT NULL OR OLD.status = ''left''%' THEN
    RAISE EXCEPTION 'tg_group_members_guest_rename_rules no longer scopes to live guest seats (OLD.profile_id/OLD.status) — a profile-linked rename could be blocked, or a guest rename could go unvalidated';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'group_guest_identities'
       AND permissive = 'PERMISSIVE'
       AND COALESCE(qual, 'false') <> 'false'
  ) THEN
    RAISE EXCEPTION 'group_guest_identities has a permissive policy — the phone hashes are readable';
  END IF;

  RAISE NOTICE 'p2-guest-members: OK';
END;
$$;
