-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P3 item L2: the counterparty living-balance link ("khata link").
-- A read-only, token-gated, per-person ledger page the owner can hand to the
-- other side over WhatsApp, whether or not that person ever installs Hisaab.
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
--
-- ── APPLY ORDER ─────────────────────────────────────────────────────────────
-- AFTER supabase-migration-p2-trust-safety.sql (which is itself LAST in
-- docs/audit-2026-09/APPLY-ORDER.md §2). Two hard dependencies, both checked
-- by SECTION 0, which ABORTS with a named message rather than creating
-- functions that would fail at runtime:
--
--   public.is_blocked_either_way(UUID, UUID)   p2-trust-safety.sql §1.3
--        The block gate. A khata link between a blocked pair must resolve as
--        NOT_FOUND, exactly like a wrong token.
--   public.witness_initials(TEXT)              p2-trust-safety.sql §7.2
--        "Ali Raza" -> "A.R.". REUSED, not re-declared: the initials-only
--        option on a khata link must render identically to the initials-only
--        option on a kameti witness page, and two copies of that function
--        would eventually disagree.
--
-- Also requires (all long applied):
--   supabase-schema.sql                      loans, transactions
--   supabase-migration-phase1-persons.sql    persons, loans.person_id,
--                                            transactions.person_id
--   supabase-migration-incremental-sync-tombstones.sql  loans/transactions
--                                            deleted_at
--   the profiles table with name + is_deleted (audit-p0-account-deletion.sql)
--
-- ── BREAKING CHANGES FOR THE CLIENT ─────────────────────────────────────────
-- NONE. Everything here is additive: two new tables, three new functions, one
-- new trigger. No existing function, policy, trigger, column or grant is
-- touched. An un-updated client is completely unaware of it, and the new
-- public route is inert until a link is minted.
--
-- ════════════════════════════════════════════════════════════════════════════
-- WHAT THIS BUILDS — evidence
-- ════════════════════════════════════════════════════════════════════════════
--
-- G3 (docs/audit-2026-09/11-competitive-analysis.md:82, HIGH) — "The
--   counterparty reminder loop, the khata category's proven engine, is
--   absent." Khatabook/OkCredit/CreditBook/Udhaar Book all ship an automatic
--   balance link to the customer on every entry; "the primary collection
--   feature and the original viral growth engine". Hisaab's only counterparty
--   channel today is a manual, sender-initiated WhatsApp text
--   (src/lib/whatsappReminder.ts) plus push that needs BOTH parties on-app.
--   "A counterparty who never installs Hisaab experiences nothing automatic —
--   no nudge, no living balance link."
--
-- O2 (11-competitive-analysis.md:119) — the recommendation, verbatim:
--   "Automatic counterparty loop: WhatsApp share prompt at save + a
--    per-person living balance link (reuse the witness-link pattern for a
--    read-only 'your khata with X' page)".
--   THIS FILE IS THE SECOND HALF (the living balance link). The share prompt
--   at save is deferred — see the note at the bottom of this header.
--
-- L2 (00-executive-summary.md:157, P3) — "The counterparty living-balance
--   link + automatic WhatsApp nudge loop as the growth engine … the khata
--   category's proven engine, adapted to consent culture; also the answer to
--   'where does growth come from without paid acquisition.'"
--
-- ════════════════════════════════════════════════════════════════════════════
-- THE PRIVACY CONTRACT — what a khata link reveals, and what it can never
-- ════════════════════════════════════════════════════════════════════════════
--
-- A khata link is a CAPABILITY URL. Whoever holds it sees the page; there is
-- no login, no identity check, and no way to tell the intended counterparty
-- from someone the link was forwarded to. That is the same trade the kameti
-- witness link makes (p2 §7), and the same three defences apply here: the
-- token is 256 bits of server entropy, only its SHA-256 is stored, and the
-- owner can revoke or rotate at any time. Two more are added, because a khata
-- is more personal than a committee ledger:
--
--   1. STRICT PROJECTION. get_khata_view returns exactly six things:
--        · the owner's display name (profiles.name)
--        · the person's name AS THE OWNER RECORDED IT (persons.name)
--        · per-currency net balance
--        · that person's loans (id, direction, totals, currency, status,
--          note, dates)
--        · the repayment/disbursement transaction rows on those loans
--          (id, type, amount, currency, loan id, note, date)
--        · the link's own expiry + initials-only flag
--      It NEVER returns: any other person, any account or balance, any phone
--      number, any email, any user id / profile id, any group, kameti,
--      budget, goal or investment, and no id at all beyond the loan and
--      transaction ids the page needs as stable React keys. Those ids are
--      opaque, already known to both sides of the debt, and useless without
--      the token — there is no other RPC an anon caller can feed them to.
--
--   2. INITIALS-ONLY. Same option as the kameti witness page. When set, BOTH
--      names collapse to initials ("A.R."), so a forwarded link still proves
--      the ledger without publishing who owes whom by name. It covers both
--      names on purpose: the counterparty already knows both, so hiding only
--      one buys nothing against the forwarding threat this option exists for.
--
-- Freshness is the point (it is a LIVING balance): the view is computed at
-- read time, so a repayment recorded in the app is visible on the next
-- refresh. There is no snapshot and nothing to keep in sync.
--
-- BLOCKS (p2 RULE 2, adapted). If the person is a LINKED profile and either
-- side has blocked the other, the link resolves as NOT_FOUND — indistinguish-
-- able from a wrong, revoked or expired token. This is NOT the "freezing an
-- existing debt" that RULE 2 forbids: the debt itself, both ledgers, and every
-- in-app settlement path are untouched. What is withdrawn is a PUSH channel
-- into a blocked person's browser, which is exactly the "new relationship"
-- half of the rule. The owner's own view of the loans never changes.
--
-- ════════════════════════════════════════════════════════════════════════════
-- BOTH APP MODES — traced, per CLAUDE.md and tasks/lessons.md
-- ════════════════════════════════════════════════════════════════════════════
-- full_tracker : a loan leaves a `loans` row AND a loan_given/loan_taken
--                transaction row against a real account; each repayment leaves
--                a `repayment` transaction row.
-- splits_only  : there are NO accounts. The loan may leave ONLY the `loans`
--                row, and a ledger-mode repayment leaves a `transactions` row
--                with BOTH source_account_id AND destination_account_id NULL.
--
-- SECTION 5's transaction projection filters on user_id, related_loan_id,
-- deleted_at and type ONLY. It never mentions an account column, so a
-- both-nulls ledger row is selected exactly like a full-tracker row. The
-- oldest ledger-only repayments (which mutated loans.remaining_amount with no
-- row at all — the 2026-07-18 correction in tasks/lessons.md) are still
-- visible, because the page runs the SAME `buildStatement` engine the in-app
-- statement runs (src/lib/statementOfAccount.ts), which synthesises a
-- "repayments (summary)" line for any paid-down amount no row accounts for.
-- That is why this RPC ships the RAW loans + transactions rather than a
-- pre-rendered ledger: one engine, so the public page and the in-app
-- statement can never disagree about what was paid.
--
-- ════════════════════════════════════════════════════════════════════════════
-- RATE LIMITING — what is possible from SQL, and what is not (READ THIS)
-- ════════════════════════════════════════════════════════════════════════════
-- The honest answer first: per-IP rate limiting is IMPOSSIBLE here. This RPC
-- is called by `anon` through PostgREST; auth.uid() is NULL, there is no
-- session row to charge, and the client IP is not reliably exposed to a
-- Postgres function (request.headers carries whatever the proxy forwarded,
-- which an attacker controls). Every existing budget in this repo —
-- code_lookup_attempts, phone_lookup_attempts, join_code_attempts,
-- invite_accept_attempts — is keyed on auth.uid() and therefore has no
-- equivalent here.
--
-- What SECTION 2 does instead, and what each part is actually worth:
--
--   · A PER-LINK HIT LEDGER with an hourly ceiling (240/hour). This is the
--     one control with real value: it bounds how fast a LEAKED link can be
--     scraped or polled, and 240/hour is far above two humans refreshing a
--     shared page. Over the ceiling the view returns NULL — the same
--     "not found" a wrong token gets, so the ceiling leaks nothing either.
--
--   · A GLOBAL MISS LEDGER with a circuit breaker (500 misses / 15 min ->
--     every lookup returns NULL without hashing). This is DETECTION and load
--     shedding, not security: the token is 256 bits, so brute force was never
--     the threat. Its real job is to keep a scanner from turning an unindexed
--     hash lookup into a database load problem, and to leave evidence in the
--     table that a scan happened.
--
--   · Nothing here defends against a distributed scrape of a link the
--     attacker ALREADY HAS. Only revoke does, and the owner controls that.
--
-- The correct place for per-IP limiting is the edge (Vercel middleware or a
-- Supabase edge function fronting the lookup). That is deliberately NOT built
-- here — it would be a second, untested deployment surface for a threat the
-- 256-bit token already makes uneconomic. Logged as an open risk instead.
--
-- ════════════════════════════════════════════════════════════════════════════
-- DEFERRED (not in this file, on purpose)
-- ════════════════════════════════════════════════════════════════════════════
-- O2's OTHER half — the "share prompt at save" nudge that offers the link
-- immediately after a loan is recorded — is deferred. It is pure client work
-- (no schema), and it belongs in the success paths of QuickEntry.tsx and
-- AddLoanModal.tsx. See the client task notes.
--
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 0. Hard preconditions. Abort loudly rather than half-apply.
-- Same discipline as supabase-migration-p3-atomic-transfer.sql §0.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regprocedure('public.is_blocked_either_way(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'p3-khata-link: public.is_blocked_either_way(uuid,uuid) is missing. Apply supabase-migration-p2-trust-safety.sql FIRST — without it a blocked pair could still push a khata link at each other.';
  END IF;
  IF to_regprocedure('public.witness_initials(text)') IS NULL THEN
    RAISE EXCEPTION 'p3-khata-link: public.witness_initials(text) is missing. Apply supabase-migration-p2-trust-safety.sql FIRST — the initials-only option reuses it so the two public pages render names identically.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='loans' AND column_name='person_id') THEN
    RAISE EXCEPTION 'p3-khata-link: loans.person_id is missing. Apply supabase-migration-phase1-persons.sql FIRST.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='loans' AND column_name='deleted_at') THEN
    RAISE EXCEPTION 'p3-khata-link: loans.deleted_at is missing. Apply supabase-migration-incremental-sync-tombstones.sql FIRST — without it a deleted loan would keep showing on a public page.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='loans' AND column_name='updated_at') THEN
    RAISE EXCEPTION 'p3-khata-link: loans.updated_at is missing. Apply supabase-migration-incremental-sync-core.sql FIRST — buildStatement dates its synthesised "repayments (summary)" line from it.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='persons' AND column_name='archived_at') THEN
    RAISE EXCEPTION 'p3-khata-link: persons.archived_at is missing. Apply the contacts archive migration FIRST.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='persons' AND column_name='linked_profile_id') THEN
    RAISE EXCEPTION 'p3-khata-link: persons.linked_profile_id is missing. Apply supabase-migration-phase2a-linked-profile.sql FIRST — the block gate needs it.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='transactions' AND column_name='deleted_at') THEN
    RAISE EXCEPTION 'p3-khata-link: transactions.deleted_at is missing. Apply supabase-migration-incremental-sync-tombstones.sql FIRST.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='profiles' AND column_name='is_deleted') THEN
    RAISE EXCEPTION 'p3-khata-link: profiles.is_deleted is missing. Apply supabase-migration-audit-p0-account-deletion.sql FIRST — a soft-deleted owner must not keep serving a public page.';
  END IF;
END;
$$;

-- pgcrypto for gen_random_bytes / digest. Same guarded pattern as
-- p2-trust-safety.sql §0 and audit-p0-consent-guards.sql:1365-1378.
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
-- SECTION 1. khata_links — the capability itself
-- ════════════════════════════════════════════════════════════════════════════

-- One row = one khata link the owner minted for one of their contacts.
-- Revoked rows are KEPT (revoked_at set, never deleted) so the lookup ledger
-- in §2 keeps its foreign key and an operator can still see that a link
-- existed. The partial unique index below is what enforces "one ACTIVE link
-- per person".
CREATE TABLE IF NOT EXISTS public.khata_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- persons.id is TEXT app-side (phase1-persons.sql:9). CASCADE: deleting the
  -- contact must kill their public page, not orphan it.
  person_id  TEXT NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  -- SHA-256 (lowercase hex) of the raw token. The raw token is returned
  -- exactly once by create_khata_link and is never stored anywhere.
  token_hash TEXT NOT NULL,
  -- UX-24's answer to named delinquency, adapted: when true BOTH names on the
  -- public page render as initials. Ordinary owner-writable preference —
  -- toggling it does NOT invalidate the link (see the column grant below).
  initials_only BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days'),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE lookup index. Unique because two links must never collide on a hash.
CREATE UNIQUE INDEX IF NOT EXISTS khata_links_token_hash_uidx
  ON public.khata_links (token_hash);

-- "One active link per person", enforced by the database rather than by the
-- RPC being careful. A rotate revokes first, then inserts, so this never
-- fires on the happy path — it fires if a future caller forgets.
CREATE UNIQUE INDEX IF NOT EXISTS khata_links_active_uidx
  ON public.khata_links (owner_id, person_id) WHERE revoked_at IS NULL;

-- Serves the owner's "does this contact have a live link?" read.
CREATE INDEX IF NOT EXISTS khata_links_owner_person_idx
  ON public.khata_links (owner_id, person_id, created_at DESC);

ALTER TABLE public.khata_links ENABLE ROW LEVEL SECURITY;

-- Owner-only, in both directions. There is deliberately NO INSERT or DELETE
-- policy: minting is create_khata_link's job (it is the only thing that can
-- produce a hash whose preimage anyone knows), and killing a link is a revoke,
-- not a delete — a deleted row would take the lookup ledger's evidence with it.
DROP POLICY IF EXISTS khata_links_select_own ON public.khata_links;
CREATE POLICY khata_links_select_own ON public.khata_links
  FOR SELECT USING (owner_id = auth.uid());

DROP POLICY IF EXISTS khata_links_update_own ON public.khata_links;
CREATE POLICY khata_links_update_own ON public.khata_links
  FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- RLS decides WHICH ROWS; column grants decide WHICH COLUMNS. Both are needed:
-- RLS cannot hide a column, and `token_hash` must never leave the database —
-- a client that could read it could verify guesses offline against its own
-- copy, which is precisely what hashing at rest exists to prevent.
REVOKE ALL ON public.khata_links FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, owner_id, person_id, initials_only, expires_at, revoked_at, created_at)
  ON public.khata_links TO authenticated;
-- The ONLY column a client may write directly. Everything else is RPC-only.
GRANT UPDATE (initials_only) ON public.khata_links TO authenticated;

-- Belt and braces behind the column grant: if a future migration widens that
-- GRANT by accident, this still refuses to let a client mint, extend or
-- resurrect a capability. Mirrors tg_committees_witness_token_guard
-- (p2-trust-safety.sql §7.3), including its current_setting escape hatch.
CREATE OR REPLACE FUNCTION public.tg_khata_links_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_in_rpc BOOLEAN := coalesce(current_setting('hisaab.khata_link', true), 'off') = 'on';
BEGIN
  IF v_in_rpc THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'khata_links: KHATA_LINK_IS_SERVER_ONLY — use create_khata_link()';
  END IF;

  IF NEW.owner_id   IS DISTINCT FROM OLD.owner_id
     OR NEW.person_id  IS DISTINCT FROM OLD.person_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'khata_links: KHATA_LINK_IS_SERVER_ONLY — use create_khata_link() / revoke_khata_link()';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_khata_links_guard ON public.khata_links;
CREATE TRIGGER trg_khata_links_guard
  BEFORE INSERT OR UPDATE ON public.khata_links
  FOR EACH ROW EXECUTE FUNCTION public.tg_khata_links_guard();

COMMENT ON TABLE public.khata_links IS
  'Audit L2/O2/G3: the per-counterparty living-balance link. One ACTIVE row per (owner, person); rotating revokes the previous. Only sha256(token) is stored and the raw token is returned exactly once. Owner-readable except token_hash (column grant), owner-writable only for initials_only; minting and revoking are RPC-only.';
COMMENT ON COLUMN public.khata_links.token_hash IS
  'SHA-256 (lowercase hex) of the raw khata token. NOT granted to any client role — reading it would let a holder verify guesses offline.';
COMMENT ON COLUMN public.khata_links.initials_only IS
  'When true the public khata page renders BOTH names as initials (public.witness_initials), so a forwarded link proves the ledger without naming who owes whom.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2. khata_link_lookups — the hit / miss ledger
-- Read the RATE LIMITING block in the header before changing anything here.
-- ════════════════════════════════════════════════════════════════════════════

-- link_id NOT NULL  -> a HIT: this link resolved. Charged against that link's
--                      hourly ceiling.
-- link_id NULL      -> a MISS: the presented token matched nothing (or matched
--                      a revoked/expired/blocked link). Charged against the
--                      global circuit breaker.
CREATE TABLE IF NOT EXISTS public.khata_link_lookups (
  id           BIGSERIAL PRIMARY KEY,
  link_id      UUID REFERENCES public.khata_links(id) ON DELETE CASCADE,
  looked_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS khata_link_lookups_link_time_idx
  ON public.khata_link_lookups (link_id, looked_up_at DESC);
-- Serves both the 15-minute miss window and the 24-hour prune.
CREATE INDEX IF NOT EXISTS khata_link_lookups_time_idx
  ON public.khata_link_lookups (looked_up_at);

ALTER TABLE public.khata_link_lookups ENABLE ROW LEVEL SECURITY;

-- No policies at all, and revoked from every role. The ONLY writer is
-- get_khata_view, which runs as the definer. A readable ledger would tell an
-- anonymous visitor whether a token had ever resolved — the exact oracle the
-- uniform NULL return exists to close. Operators read it in Studio.
REVOKE ALL ON public.khata_link_lookups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.khata_link_lookups_id_seq FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.khata_link_lookups IS
  'Audit L2: khata-link lookup ledger. link_id NOT NULL = a hit (charged to that link''s 240/hour ceiling); link_id NULL = a miss (charged to a global 500-per-15-minutes circuit breaker). Per-IP limiting is impossible from SQL — see the RATE LIMITING block in supabase-migration-p3-khata-link.sql. No client role can read or write it.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3. The hashing helper
-- ════════════════════════════════════════════════════════════════════════════

-- Same construction as hash_witness_token / hash_invite_token. Declared
-- separately rather than reusing hash_witness_token so that this file adds no
-- second caller to a p2 object it does not own — if the witness token's
-- construction is ever changed, khata links must not silently change with it.
CREATE OR REPLACE FUNCTION public.hash_khata_token(p_token TEXT)
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

REVOKE ALL ON FUNCTION public.hash_khata_token(TEXT) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.hash_khata_token(TEXT) IS
  'Audit L2: SHA-256 lowercase hex of a khata-link token. Revoked from every client role — the only callers that matter run as the definer.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 4. create / revoke  (owner-only)
-- ════════════════════════════════════════════════════════════════════════════

-- create_khata_link(p_person_id TEXT, p_initials_only BOOLEAN DEFAULT NULL) -> JSONB
--   {"status":"ok","token":"<64 hex>","expires_at":"…","initials_only":bool,
--    "replaced_previous":bool}
--   {"status":"NOT_AUTHENTICATED"}
--   {"status":"NOT_FOUND"}         -- not the caller's contact (owner-only)
--   {"status":"CONTACT_ARCHIVED"}  -- restore the contact first
--
-- THE RAW TOKEN IS RETURNED EXACTLY ONCE. It is not stored and cannot be
-- re-read; a client that loses it must create again, which revokes the old
-- link. That is the correct semantics for a capability URL and it is the same
-- contract rotate_committee_witness_token already has.
--
-- p_initials_only: NULL keeps whatever the previous link for this person had
-- (so a rotate does not silently un-hide names); true/false sets it.
CREATE OR REPLACE FUNCTION public.create_khata_link(
  p_person_id     TEXT,
  p_initials_only BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_now      TIMESTAMPTZ := now();
  v_person   public.persons%ROWTYPE;
  v_token    TEXT;
  v_expires  TIMESTAMPTZ;
  v_initials BOOLEAN;
  v_prev     BOOLEAN := false;
  v_revoked  INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  SELECT * INTO v_person
    FROM public.persons AS p
   WHERE p.id = p_person_id
     AND p.user_id = v_uid
   FOR UPDATE;

  IF v_person.id IS NULL THEN
    -- Owner-only. Someone else's contact gets the same answer as a bad id.
    RETURN jsonb_build_object('status', 'NOT_FOUND');
  END IF;
  IF v_person.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'CONTACT_ARCHIVED');
  END IF;

  -- Carry the previous link's preference forward unless the caller said.
  SELECT k.initials_only INTO v_initials
    FROM public.khata_links k
   WHERE k.owner_id = v_uid
     AND k.person_id = p_person_id
     AND k.revoked_at IS NULL
   LIMIT 1;
  v_initials := COALESCE(p_initials_only, v_initials, false);

  PERFORM set_config('hisaab.khata_link', 'on', true);

  -- ROTATE = revoke then mint. The old URL dies the moment this commits; that
  -- is the whole point of rotating.
  UPDATE public.khata_links
     SET revoked_at = v_now
   WHERE owner_id = v_uid
     AND person_id = p_person_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  v_prev := v_revoked > 0;

  -- 256 bits of SERVER entropy. The owner's device never chooses the token,
  -- so a compromised or badly-seeded client cannot weaken it.
  v_token   := encode(gen_random_bytes(32), 'hex');
  v_expires := v_now + INTERVAL '90 days';

  INSERT INTO public.khata_links (owner_id, person_id, token_hash, initials_only, expires_at, created_at)
  VALUES (v_uid, p_person_id, public.hash_khata_token(v_token), v_initials, v_expires, v_now);

  PERFORM set_config('hisaab.khata_link', 'off', true);

  RETURN jsonb_build_object(
    'status', 'ok',
    'token', v_token,
    'expires_at', v_expires,
    'initials_only', v_initials,
    'replaced_previous', v_prev
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_khata_link(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_khata_link(TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.create_khata_link(TEXT, BOOLEAN) IS
  'Audit L2/O2: owner-only. Mints a fresh 256-bit khata-link token server-side, stores only its SHA-256, sets a 90-day expiry, and REVOKES any previous link for that contact (one active link per person). Returns the raw token exactly once — it is never stored and cannot be re-read.';

-- revoke_khata_link(p_person_id TEXT) -> JSONB
--   {"status":"ok","was_active":bool} | NOT_AUTHENTICATED | NOT_FOUND
-- The un-share. Idempotent: revoking twice is {"was_active":false}.
CREATE OR REPLACE FUNCTION public.revoke_khata_link(p_person_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_now     TIMESTAMPTZ := now();
  v_revoked INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.persons p WHERE p.id = p_person_id AND p.user_id = v_uid
  ) THEN
    RETURN jsonb_build_object('status', 'NOT_FOUND');
  END IF;

  PERFORM set_config('hisaab.khata_link', 'on', true);
  UPDATE public.khata_links
     SET revoked_at = v_now
   WHERE owner_id = v_uid
     AND person_id = p_person_id
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  PERFORM set_config('hisaab.khata_link', 'off', true);

  RETURN jsonb_build_object('status', 'ok', 'was_active', v_revoked > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_khata_link(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_khata_link(TEXT) TO authenticated;

COMMENT ON FUNCTION public.revoke_khata_link(TEXT) IS
  'Audit L2/O2: owner-only kill switch for a contact''s public khata link. Idempotent. A revoked link is indistinguishable from a wrong one.';

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 5. get_khata_view — THE public, anon-callable projection
-- ════════════════════════════════════════════════════════════════════════════
--
-- Returns NULL — one uniform, unexplained NULL — for every one of:
--   · a malformed or unknown token
--   · a revoked link
--   · an expired link
--   · a link whose owner has soft-deleted their account
--   · a link whose contact is a linked profile on either side of a block
--   · a link over its hourly hit ceiling, or a global miss flood
-- No status codes, no distinguishable branch. The page shows the same
-- "link not found" state for all of them, exactly like get_committee_witness.
CREATE OR REPLACE FUNCTION public.get_khata_view(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  -- See the RATE LIMITING block in the header for what each of these is worth.
  c_hits_per_hour       CONSTANT INTEGER := 240;
  c_misses_per_window   CONSTANT INTEGER := 500;
  c_miss_window         CONSTANT INTERVAL := INTERVAL '15 minutes';
  c_retention           CONSTANT INTERVAL := INTERVAL '24 hours';

  v_now       TIMESTAMPTZ := now();
  v_link      public.khata_links%ROWTYPE;
  v_person    public.persons%ROWTYPE;
  v_owner     TEXT;
  v_deleted   BOOLEAN;
  v_recent    INTEGER;
  v_owner_nm  TEXT;
  v_person_nm TEXT;
  v_key       TEXT;
  v_result    JSON;
BEGIN
  -- One indexed range delete, normally zero rows. Same "prune on every call"
  -- shape as code_lookup_attempts (audit-p0-consent-guards.sql:645-646).
  DELETE FROM public.khata_link_lookups AS l
   WHERE l.looked_up_at < v_now - c_retention;

  -- ── Shape check. Nothing is looked up, so nothing is charged. ─────────────
  -- A khata token is exactly 64 lowercase hex characters.
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  -- ── Global miss circuit breaker. Checked BEFORE the hash lookup, which is
  -- the only thing it can actually protect. ─────────────────────────────────
  SELECT count(*) INTO v_recent
    FROM public.khata_link_lookups AS l
   WHERE l.link_id IS NULL
     AND l.looked_up_at > v_now - c_miss_window;
  IF v_recent >= c_misses_per_window THEN
    -- Deliberately NOT recorded: a shed request must not extend the shed.
    RETURN NULL;
  END IF;

  SELECT * INTO v_link
    FROM public.khata_links AS k
   WHERE k.token_hash = public.hash_khata_token(p_token);

  IF NOT FOUND
     OR v_link.revoked_at IS NOT NULL
     OR v_link.expires_at < v_now THEN
    -- A revoked or expired link is charged as a miss exactly like an unknown
    -- token, so the ledger cannot be used to tell them apart either.
    INSERT INTO public.khata_link_lookups (link_id) VALUES (NULL);
    RETURN NULL;
  END IF;

  -- ── Per-link hourly ceiling. Bounds how fast a LEAKED link is scraped. ────
  SELECT count(*) INTO v_recent
    FROM public.khata_link_lookups AS l
   WHERE l.link_id = v_link.id
     AND l.looked_up_at > v_now - INTERVAL '1 hour';
  IF v_recent >= c_hits_per_hour THEN
    RETURN NULL;
  END IF;

  -- The contact, as the owner recorded them.
  SELECT * INTO v_person
    FROM public.persons AS p
   WHERE p.id = v_link.person_id
     AND p.user_id = v_link.owner_id;
  IF NOT FOUND THEN
    INSERT INTO public.khata_link_lookups (link_id) VALUES (NULL);
    RETURN NULL;
  END IF;

  -- The owner. A soft-deleted account stops serving its public pages.
  SELECT COALESCE(NULLIF(btrim(pr.name), ''), 'Hisaab user'), COALESCE(pr.is_deleted, false)
    INTO v_owner, v_deleted
    FROM public.profiles AS pr
   WHERE pr.id = v_link.owner_id;
  IF NOT FOUND OR v_deleted THEN
    INSERT INTO public.khata_link_lookups (link_id) VALUES (NULL);
    RETURN NULL;
  END IF;

  -- ── Block gate (p2 M17). Only meaningful when the contact is a LINKED
  -- profile — an unlinked contact is a name in the owner's phone, and there is
  -- no second account to have blocked anyone. NOT_FOUND, like everything else.
  IF v_person.linked_profile_id IS NOT NULL
     AND public.is_blocked_either_way(v_link.owner_id, v_person.linked_profile_id) THEN
    INSERT INTO public.khata_link_lookups (link_id) VALUES (NULL);
    RETURN NULL;
  END IF;

  -- Charge the hit. Past this point the view WILL be returned.
  INSERT INTO public.khata_link_lookups (link_id) VALUES (v_link.id);

  v_owner_nm  := CASE WHEN v_link.initials_only THEN public.witness_initials(v_owner) ELSE v_owner END;
  v_person_nm := CASE WHEN v_link.initials_only
                      THEN public.witness_initials(v_person.name)
                      ELSE v_person.name END;

  -- The app's person key is `personId ?? lower(trim(name))` (CLAUDE.md), so a
  -- loan recorded before this contact existed as a row is matched by NAME.
  -- Without this the public page would show an empty ledger for exactly the
  -- oldest, most-likely-to-be-disputed debts.
  v_key := lower(btrim(v_person.name));

  WITH scoped_loans AS (
    SELECT l.*
      FROM public.loans AS l
     WHERE l.user_id = v_link.owner_id
       AND l.deleted_at IS NULL
       AND (
         l.person_id = v_link.person_id
         OR (l.person_id IS NULL AND lower(btrim(l.person_name)) = v_key)
       )
  )
  SELECT json_build_object(
    'owner', json_build_object('name', v_owner_nm),
    'person', json_build_object('name', v_person_nm),
    'initialsOnly', v_link.initials_only,
    'expiresAt', v_link.expires_at,
    'asOf', v_now,
    -- Signed the same way src/lib/statementOfAccount.ts signs a statement:
    -- POSITIVE = the person owes the owner. Never merged across currencies
    -- (LoansPage's grouping rule: direction + currency).
    'net', COALESCE((
      SELECT json_agg(json_build_object('currency', n.currency, 'balance', n.balance)
                      ORDER BY n.currency)
        FROM (
          SELECT sl.currency,
                 round(SUM(CASE WHEN sl.type = 'given'
                                THEN sl.remaining_amount
                                ELSE -sl.remaining_amount END)::numeric, 2) AS balance
            FROM scoped_loans sl
           GROUP BY sl.currency
        ) AS n
    ), '[]'::json),
    'loans', COALESCE((
      SELECT json_agg(json_build_object(
               'id', sl.id,
               'type', sl.type,
               'totalAmount', sl.total_amount,
               'remainingAmount', sl.remaining_amount,
               'currency', sl.currency,
               'status', sl.status,
               'notes', COALESCE(sl.notes, ''),
               'createdAt', sl.created_at,
               'updatedAt', sl.updated_at
             ) ORDER BY sl.created_at)
        FROM scoped_loans sl
    ), '[]'::json),
    -- Both app modes: filtered on user_id / related_loan_id / deleted_at /
    -- type ONLY. No account column is mentioned, so a splits_only ledger row
    -- with BOTH account ids NULL is selected exactly like a full-tracker row.
    'transactions', COALESCE((
      SELECT json_agg(json_build_object(
               'id', t.id,
               'type', t.type,
               'amount', t.amount,
               'currency', t.currency,
               'relatedLoanId', t.related_loan_id,
               'notes', COALESCE(t.notes, ''),
               'createdAt', t.created_at
             ) ORDER BY t.created_at)
        FROM public.transactions AS t
       WHERE t.user_id = v_link.owner_id
         AND t.deleted_at IS NULL
         AND t.related_loan_id IN (SELECT sl.id FROM scoped_loans sl)
         AND t.type IN ('loan_given', 'loan_taken', 'repayment')
    ), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_khata_view(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_khata_view(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.get_khata_view(TEXT) IS
  'Audit L2/O2/G3: the public per-counterparty ledger. Matches the SHA-256 of the presented token; returns ONE uniform NULL for unknown / revoked / expired / owner-deleted / blocked / rate-limited. Projects ONLY: owner name, contact name (both as initials when initials_only), per-currency net, that contact''s loans, and the loan_given/loan_taken/repayment rows on them. Never any other person, account, balance, phone, email or user id.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICATION — run AFTER the commit. Every row should read as noted.
-- ════════════════════════════════════════════════════════════════════════════

-- V1. The objects exist and are wired.
SELECT to_regclass('public.khata_links')            IS NOT NULL AS links_table,
       to_regclass('public.khata_link_lookups')     IS NOT NULL AS lookups_table,
       to_regprocedure('public.create_khata_link(text, boolean)') IS NOT NULL AS fn_create,
       to_regprocedure('public.revoke_khata_link(text)')          IS NOT NULL AS fn_revoke,
       to_regprocedure('public.get_khata_view(text)')             IS NOT NULL AS fn_view,
       to_regprocedure('public.hash_khata_token(text)')           IS NOT NULL AS fn_hash;
-- expect: t t t t t t

-- V2. THE PRIVACY INVARIANT: no client role can read token_hash, and only
--     initials_only is client-writable.
SELECT string_agg(DISTINCT column_name, ',' ORDER BY column_name) AS readable_columns
  FROM information_schema.column_privileges
 WHERE table_schema = 'public' AND table_name = 'khata_links'
   AND grantee IN ('anon', 'authenticated') AND privilege_type = 'SELECT';
-- expect: created_at,expires_at,id,initials_only,owner_id,person_id,revoked_at
--         (token_hash MUST NOT appear)

SELECT string_agg(DISTINCT column_name, ',' ORDER BY column_name) AS writable_columns
  FROM information_schema.column_privileges
 WHERE table_schema = 'public' AND table_name = 'khata_links'
   AND grantee IN ('anon', 'authenticated') AND privilege_type = 'UPDATE';
-- expect: initials_only

-- V3. The lookup ledger is invisible to every client role.
SELECT count(*) AS lookup_grants
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND table_name = 'khata_link_lookups'
   AND grantee IN ('anon', 'authenticated', 'PUBLIC');
-- expect: 0

-- V4. anon may call the view and NOTHING else.
SELECT has_function_privilege('anon', 'public.get_khata_view(text)', 'EXECUTE')             AS anon_can_view,
       has_function_privilege('anon', 'public.create_khata_link(text, boolean)', 'EXECUTE') AS anon_can_create,
       has_function_privilege('anon', 'public.revoke_khata_link(text)', 'EXECUTE')          AS anon_can_revoke,
       has_function_privilege('anon', 'public.hash_khata_token(text)', 'EXECUTE')           AS anon_can_hash;
-- expect: t f f f

-- V5. The projection contains no forbidden column. A grep over the compiled
--     function body is crude but it is the check that would have caught a
--     copy-paste of an account or phone column into the json_build_object.
SELECT (pg_get_functiondef('public.get_khata_view(text)'::regprocedure) LIKE '%hash_khata_token%')      AS hashes_input,
       (pg_get_functiondef('public.get_khata_view(text)'::regprocedure) LIKE '%is_blocked_either_way%') AS honours_blocks,
       (pg_get_functiondef('public.get_khata_view(text)'::regprocedure) LIKE '%witness_initials%')      AS honours_initials,
       (pg_get_functiondef('public.get_khata_view(text)'::regprocedure) NOT LIKE '%account_id%')        AS no_account_ids,
       (pg_get_functiondef('public.get_khata_view(text)'::regprocedure) NOT LIKE '%phone%')             AS no_phone,
       -- No identity key is ever built into the JSON payload.
       (pg_get_functiondef('public.get_khata_view(text)'::regprocedure) NOT LIKE '%''ownerId''%')       AS no_owner_id_key,
       (pg_get_functiondef('public.get_khata_view(text)'::regprocedure) NOT LIKE '%''personId''%')      AS no_person_id_key,
       (pg_get_functiondef('public.get_khata_view(text)'::regprocedure) NOT LIKE '%''profileId''%')     AS no_profile_id_key;
-- expect: t t t t t t t t

-- V6. One active link per person is enforced by an index, not by hope.
SELECT indexdef FROM pg_indexes
 WHERE schemaname = 'public' AND indexname = 'khata_links_active_uidx';
-- expect: ... UNIQUE ... (owner_id, person_id) WHERE (revoked_at IS NULL)

-- V7. Operator view: live links and how hard each is being hit today.
SELECT k.id, k.owner_id, k.person_id, k.initials_only, k.expires_at,
       count(l.id) FILTER (WHERE l.looked_up_at > now() - INTERVAL '24 hours') AS views_24h
  FROM public.khata_links k
  LEFT JOIN public.khata_link_lookups l ON l.link_id = k.id
 WHERE k.revoked_at IS NULL AND k.expires_at > now()
 GROUP BY k.id
 ORDER BY views_24h DESC;

-- V8. Scan detection. A non-trivial number here means someone is probing.
SELECT date_trunc('hour', looked_up_at) AS hour, count(*) AS misses
  FROM public.khata_link_lookups
 WHERE link_id IS NULL
 GROUP BY 1 ORDER BY 1 DESC LIMIT 24;

-- ════════════════════════════════════════════════════════════════════════════
-- MANUAL QA — run as a signed-in owner with at least one contact and one loan.
-- Every one of these was also executed against PostgreSQL 16 in Docker; see
-- the agent report for the harness.
-- ════════════════════════════════════════════════════════════════════════════
--
--  1. Mint:      select public.create_khata_link('<person_id>');
--     -> {"status":"ok","token":"<64 hex>","replaced_previous":false, …}
--        Copy the token; it is never retrievable again.
--
--  2. Read it as anon (anon key, no JWT):
--        select public.get_khata_view('<token>');
--     -> the owner name, the contact name, per-currency net, the loans and the
--        loan/repayment rows. NOTHING else — diff it against the PRIVACY
--        CONTRACT list in the header.
--
--  3. Ledger-only mode: record a repayment as a splits_only user (both account
--     ids NULL) and re-read.
--     -> the repayment row IS in `transactions`. This is the 2026-07-18
--        regression in tasks/lessons.md; it must never come back.
--
--  4. Rotate:    select public.create_khata_link('<person_id>');
--     -> {"replaced_previous":true} and the OLD token now returns NULL.
--
--  5. Revoke:    select public.revoke_khata_link('<person_id>');
--     -> {"status":"ok","was_active":true}; the new token returns NULL too.
--        Calling it again -> {"was_active":false}. Nothing else changed:
--        the loans, the contact and the in-app statement are untouched.
--
--  6. Expiry:    update khata_links set expires_at = now() - interval '1 day'
--                  where id = '<id>';   -- as service_role; a client cannot
--     -> the token returns NULL. (A client trying that UPDATE gets
--        "permission denied for column expires_at", and if the grant were ever
--        widened, KHATA_LINK_IS_SERVER_ONLY from the guard trigger.)
--
--  7. Block:     link the contact to a real profile, then insert a block row
--                in either direction.
--     -> the token returns NULL. Delete the block row -> it works again.
--        The loans never moved.
--
--  8. Someone else's contact: call create_khata_link with a person_id you do
--     not own.  -> {"status":"NOT_FOUND"}.
--
--  9. anon tries to mint: call create_khata_link with the anon key.
--     -> permission denied for function create_khata_link.
--
-- 10. anon tries to read the table: select * from khata_links;
--     -> permission denied. As `authenticated`, selecting token_hash ->
--        "permission denied for column token_hash"; selecting the other
--        columns returns only your own rows.
-- ════════════════════════════════════════════════════════════════════════════
