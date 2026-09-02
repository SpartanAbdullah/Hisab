-- Hisaab — Audit 2026-09 item C10 (kameti part): make "provably fair" binding.
--
-- Apply in Supabase Studio AFTER supabase-migration-committees.sql and
-- supabase-migration-committees-phase2.sql. Idempotent: safe to re-run.
--
-- ── Evidence ────────────────────────────────────────────────────────────────
--
-- docs/audit-2026-09/05-security.md M10 — "Kameti 'provably fair' ballot is not
--   a real commit-reveal — the organiser can re-roll until the draw suits them".
--   src/stores/committeeStore.ts:115-130 generated the seed, the commitment AND
--   the slot order on the organiser's own device and wrote them in one plain
--   UPDATE. supabase-migration-committees.sql:55-73 gives the organiser a plain
--   owner UPDATE policy, so the DB accepted any (seed, commitment, order)
--   triple — even a mutually inconsistent one. phase2.sql:18-57 then served
--   those stored values verbatim to anon via get_committee_witness() as "the
--   honest record".
--   The attack needs no tooling: re-run the local draw until slot 1 is yours,
--   then persist the matching pair. Every witness verification passes. Worse,
--   because the order is a deterministic function of the seed, brute-forcing a
--   seed that produces ANY chosen permutation of N members costs ~N! hashes —
--   about 3.6M for N=10, i.e. a second of client CPU.
--
-- docs/audit-2026-09/12-qa-review.md F-13 — "Ballot re-run possible (no
--   store/server drawn-guard)"; the manual QA sheet (line 307) already expects
--   "double-tap the draw button — slots must not silently re-shuffle
--   (F-13, expected fragile)".
--
-- supabase/tests (M7, docs/testing-the-trust-boundary.md) — THE NEVER-DRAW PATH.
--   The first cut of this file gated BOTH immutability triggers on
--   `committees.draw_seed IS NOT NULL`, i.e. on the draw having already
--   happened. Before a draw there was no lock at all, so the organiser's client
--   could simply UPDATE committee_members.slot on a payout_method='ballot'
--   kameti and then never call perform_committee_draw() — which from then on
--   refused FOREVER, because its guard trips on `v_slotted > 0`. The result was
--   a "ballot" kameti with a hand-picked payout order, no seed and no
--   commitment: M10's abuse reached by never drawing instead of by re-rolling.
--   Hand-stamping committees.drawn_at had the same effect. The harness pinned
--   the hole in supabase/tests/tests/50-lifecycle-and-config.sql as two
--   assertions named GAP(kameti-draw); they now assert the refusals below.
--
--   The fix could NOT be "block slot writes". payout_method='fixed' is the
--   column default and manual slots are that mode's entire point (the organiser
--   chooses who gets paid in which round). So both triggers now gate on
--   payout_method, and enforce a STATE INVARIANT rather than a write-delta:
--
--     on a ballot kameti, drawn_at and every member slot are NULL unless
--     committees.draw_seed is non-null — and draw_seed is reachable only from
--     inside perform_committee_draw().
--
--   Because it is an invariant and not a delta rule, it holds identically for
--   INSERT and UPDATE, before and after a draw, and it survives a
--   payout_method flip — which is what the old delta rules did not.
--
-- ── What this migration does ────────────────────────────────────────────────
--
-- 1. perform_committee_draw(p_committee_id) — a SECURITY DEFINER RPC that, in
--    ONE transaction: locks the committee row, checks the caller is the
--    organiser, refuses if a draw already exists (stable code ALREADY_DRAWN),
--    generates the seed from SERVER entropy (gen_random_bytes), computes the
--    order in SQL, writes every member slot + the committee draw columns, and
--    returns the order. The organiser never supplies or sees the seed before
--    it is committed, so there is nothing left to re-roll.
--
-- 2. Two BEFORE INSERT/UPDATE triggers that make the draw append-only against
--    RAW PostgREST writes, not just against the app. Every rule below is
--    skipped inside perform_committee_draw() via the transaction-local
--    `hisaab.committee_draw` flag, so "client" here means any write that did
--    not come through the RPC.
--
--    THE FULL RULE TABLE — payout_method × column × before/after the draw.
--    ("locked" = refused; "free" = the client may write it.)
--
--      committees                     fixed              ballot
--        draw_seed / draw_commitment
--        / draw_scheme                locked always      locked always
--                                     (DRAW_FIELDS_ARE_SERVER_ONLY, 42501)
--        drawn_at                     free               locked while
--                                                        draw_seed IS NULL
--                                                        (BALLOT_DRAW_SERVER_ONLY)
--                                     locked once draw_seed IS NOT NULL
--                                     (DRAW_LOCKED)
--        payout_method                free -> ballot     locked once draw_seed
--                                     ONLY if no member  IS NOT NULL
--                                     holds a slot       (DRAW_LOCKED)
--                                     (else BALLOT_SWITCH_NEEDS_CLEAR_SLOTS)
--
--      committee_members              fixed              ballot
--        slot (INSERT or UPDATE)      free before the    locked while the
--                                     draw               parent's draw_seed
--                                                        IS NULL
--                                                        (BALLOT_SLOTS_SERVER_ONLY)
--                                     locked once the parent's draw_seed
--                                     IS NOT NULL (DRAW_LOCKED)
--        INSERT a member              free               free  (both: locked
--                                                        once drawn)
--        committee_id (re-parent)     locked if EITHER the old or the new
--                                     parent carries a draw_seed (DRAW_LOCKED)
--
--    Every refusal raises SQLSTATE 42501 (insufficient_privilege), which
--    PostgREST surfaces as HTTP 403 rather than a 500. The message still
--    carries the stable code, which is what the client matches on
--    (COMMITTEE_DRAW_ERRORS in src/lib/supabaseDb.ts).
--
--    fixed -> ballot with slots already set is REFUSED, not silently cleared.
--    Clearing would have the trigger destroy rows the organiser can see in the
--    UI without telling them, and would need a nested write into
--    committee_members from inside the committees trigger. Refusing is the
--    safer half of the choice the audit left open: the remedy is explicit and
--    reversible — NULL the slots (still allowed while the kameti is 'fixed'),
--    then switch with `payout_method = 'ballot', drawn_at = NULL`, then draw.
--
--    Without (2), an organiser could simply INSERT a committee that already
--    carries a brute-forced seed, re-order the slots afterwards, or hand-write
--    the slots of a ballot and never draw at all. Fixing the RPC alone would
--    have moved the hole, not closed it.
--
-- ── Single-phase, and why that is the right bar here ────────────────────────
--
-- The audit's suggested fix was a two-RPC commit-then-reveal. Commit-reveal
-- exists to constrain an UNTRUSTED source of randomness. Here the randomness is
-- generated by Postgres inside the same transaction that consumes it: the
-- organiser has no pre-image, no retry, and no write path to the seed. A
-- pre-draw commitment would add a round trip and a new "committed but never
-- revealed" state to reason about, and would buy nothing — the organiser cannot
-- influence a seed they never touch. Nothing in the app publishes a commitment
-- to witnesses before the draw either (the witness panel only appears after
-- drawn_at), so there is no pre-draw audience for a commitment to bind.
--
-- draw_commitment is therefore a SEAL, not a commitment: sha256(seed), written
-- with the seed, so any later edit of the seed is detectable. It is what
-- src/components/CommitteeVerifyDraw.tsx already displays.
--
-- ── Determinism scheme: "sha256-rank-v1" ────────────────────────────────────
--
--   rank(id) = encode(digest(seed || ':' || member_id, 'sha256'), 'hex')
--   order    = member ids sorted by rank ASC, ties broken by member_id ASC,
--              both compared byte-wise (collate "C" == JavaScript string `<`
--              over lowercase hex).
--   slot(id) = position in that order, 1-based.
--
-- This REPLACES the previous xmur3 + mulberry32 Fisher-Yates shuffle. That PRNG
-- could not be ported to plpgsql without hand-rolling 32-bit Math.imul wrap
-- semantics, and a server draw the client cannot reproduce byte-for-byte would
-- be worse than no server draw at all. src/lib/committeeDraw.ts was changed to
-- match, and keeps the legacy shuffle for VERIFY-ONLY so pre-fix rows are not
-- painted as tampered. Rows drawn before this migration are backfilled with
-- draw_scheme = 'mulberry32-shuffle-v0' — verification query 5.6 lists them.
--
-- ── FIXED CROSS-CHECK VECTOR (mirrors src/lib/committeeDraw.test.ts) ────────
--
--   seed       = '00112233445566778899aabbccddeeff'
--   member ids = m1, m2, m3, m4, m5
--   ranks:
--     m1 -> 51e0bdc994f0427918337c264c882c5f8ee0744dc748f9fe21551065a53adb6a
--     m2 -> 90d21fef9a44c2cd2618b4d53b8d9c229221d004f86d5074a015c32d540b2825
--     m3 -> bd5fddabdfbcf0149db3b82b907180b6af15a644affcb4aa2f53190ff1c8e667
--     m4 -> 059f50d5e2c6af646c6a7f0a8b9e449fcec8d1d73bfdc99c003470cbe608a524
--     m5 -> c9cf26d8917790e30295caae45412598ed5b84a93e5d1baaf6accd499d764ed5
--   order      = {m4, m1, m2, m3, m5}   (so m4 gets slot 1, m5 slot 5)
--   commitment = sha256(seed)
--              = 5947d7c33d783f94b3b4c1a96ebc8991ed28f1b069b71e03376cba8caa98a720
--
--   Verification query 5.1 below re-derives this in SQL. If it ever stops
--   matching, the server draw and the client recompute have diverged and every
--   witness verification is a coin flip — treat it as a launch blocker.
--
-- ── App modes ───────────────────────────────────────────────────────────────
-- Kameti is mode-agnostic: it is a NO-CUSTODY tracker. Neither full_tracker nor
-- splits_only creates accounts, transactions or balance deltas from a draw —
-- the draw only assigns committee_members.slot. Nothing here touches money, so
-- there is no per-mode artifact divergence to trace (contrast tasks/lessons.md
-- on repayments). Both modes reach the same RPC through the same store action.

-- ═══════════════════════════════════════════════════════════
-- 1. Schema
-- ═══════════════════════════════════════════════════════════

-- digest() / gen_random_bytes() live in pgcrypto. Supabase ships it; this is a
-- no-op if already installed (in whichever schema it was installed into).
create extension if not exists pgcrypto;

alter table public.committees add column if not exists draw_scheme text;

comment on column public.committees.draw_scheme is
  'Which deterministic ordering produced the stored slots. sha256-rank-v1 = server draw (perform_committee_draw). mulberry32-shuffle-v0 = legacy pre-audit client draw, verify-only, NOT server-guaranteed.';

-- Provenance for rows drawn before this migration. Only stamps rows that
-- actually carry a seed, and never overwrites an existing value. Wrapped in the
-- draw-context flag so that on a RE-RUN (when section 3's trigger already
-- exists) this write isn't rejected as a client tampering attempt. The DO block
-- is its own transaction, so the flag cannot outlive it.
do $$
begin
  perform set_config('hisaab.committee_draw', 'on', true);
  update public.committees
     set draw_scheme = 'mulberry32-shuffle-v0'
   where draw_seed is not null
     and draw_scheme is null;
  perform set_config('hisaab.committee_draw', 'off', true);
end $$;

-- ═══════════════════════════════════════════════════════════
-- 2. The server draw
-- ═══════════════════════════════════════════════════════════

create or replace function public.perform_committee_draw(p_committee_id text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid        uuid := auth.uid();
  v            public.committees;
  v_members    int;
  v_slotted    int;
  v_seed       text;
  v_commitment text;
  v_drawn_at   timestamptz;
  v_order      text[];
begin
  if v_uid is null then
    raise exception 'perform_committee_draw: NOT_AUTHENTICATED';
  end if;

  -- FOR UPDATE serialises the double-tap: the second call blocks here, then
  -- sees the first call's drawn_at and bails with ALREADY_DRAWN.
  select * into v from public.committees where id = p_committee_id for update;
  if not found then
    raise exception 'perform_committee_draw: NOT_FOUND';
  end if;

  if v.user_id <> v_uid then
    raise exception 'perform_committee_draw: NOT_ORGANISER';
  end if;

  if v.status <> 'active' then
    raise exception 'perform_committee_draw: NOT_ACTIVE';
  end if;

  -- The drawn-guard. Either of these means an order already exists and members
  -- may have seen it; re-rolling is exactly the abuse M10 describes.
  select count(*), count(*) filter (where slot is not null)
    into v_members, v_slotted
    from public.committee_members
   where committee_id = v.id;

  if v.drawn_at is not null or v.draw_seed is not null then
    raise exception 'perform_committee_draw: ALREADY_DRAWN';
  end if;

  -- Defence in depth, and no longer the ballot path's guard. Section 3's
  -- invariant makes a slotted-but-unseeded BALLOT committee unrepresentable,
  -- so for payout_method='ballot' this branch is now UNREACHABLE BY DESIGN.
  -- What it still catches is a payout_method='fixed' kameti whose organiser
  -- already hand-picked an order and is now asking for a ballot: drawing would
  -- silently overwrite that order. It gets its own code rather than
  -- ALREADY_DRAWN, because nothing was drawn and the remedy is different —
  -- NULL the slots first (allowed while the kameti is 'fixed'), then draw.
  -- Reaching this at all from the app would be a bug: the draw CTA is only
  -- offered on a ballot kameti.
  if v_slotted > 0 then
    raise exception 'perform_committee_draw: SLOTS_ALREADY_SET — % member(s) already hold a hand-picked slot; clear them before drawing', v_slotted;
  end if;

  if v_members < 2 then
    raise exception 'perform_committee_draw: TOO_FEW_MEMBERS';
  end if;

  -- Server entropy. 16 bytes -> 32 lowercase hex chars, matching the format the
  -- client already renders. The organiser has no input to and no pre-image of
  -- this value; it is consumed in the same statement block that creates it.
  v_seed       := encode(gen_random_bytes(16), 'hex');
  v_commitment := encode(digest(v_seed, 'sha256'), 'hex');
  v_drawn_at   := now();

  -- Let the immutability triggers below know these writes come from here.
  -- set_config(..., true) is transaction-local, so it cannot leak to a later
  -- statement on the same pooled connection.
  perform set_config('hisaab.committee_draw', 'on', true);

  -- sha256-rank-v1. collate "C" pins byte-order comparison so the ordering
  -- cannot drift with the database's collation.
  select array_agg(member_id order by rank_hex collate "C", member_id collate "C")
    into v_order
    from (
      select m.id::text as member_id,
             encode(digest(v_seed || ':' || m.id::text, 'sha256'), 'hex') as rank_hex
        from public.committee_members m
       where m.committee_id = v.id
    ) ranked;

  update public.committee_members m
     set slot = pos.ord
    from unnest(v_order) with ordinality as pos(member_id, ord)
   where m.committee_id = v.id
     and m.id = pos.member_id;

  update public.committees
     set payout_method   = 'ballot',
         drawn_at        = v_drawn_at,
         draw_seed       = v_seed,
         draw_commitment = v_commitment,
         draw_scheme     = 'sha256-rank-v1',
         updated_at      = now()
   where id = v.id;

  perform set_config('hisaab.committee_draw', 'off', true);

  return json_build_object(
    'status',         'ok',
    'committeeId',    v.id,
    'payoutMethod',   'ballot',
    'drawnAt',        v_drawn_at,
    'drawSeed',       v_seed,
    'drawCommitment', v_commitment,
    'drawScheme',     'sha256-rank-v1',
    'order',          to_json(v_order)
  );
end $$;

revoke all on function public.perform_committee_draw(text) from public, anon;
grant execute on function public.perform_committee_draw(text) to authenticated;

comment on function public.perform_committee_draw(text) is
  'Audit 2026-09 C10/M10. Organiser-only, once-only server ballot draw. Seed is server-generated; ordering is sha256-rank-v1. Second call raises ALREADY_DRAWN.';

-- ═══════════════════════════════════════════════════════════
-- 3. Make the draw append-only against raw PostgREST writes
-- ═══════════════════════════════════════════════════════════

create or replace function public.tg_committees_draw_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_in_draw boolean := coalesce(current_setting('hisaab.committee_draw', true), 'off') = 'on';
  v_slotted int;
begin
  if v_in_draw then
    return new;
  end if;

  -- (a) The three seal columns are server-only in BOTH modes, forever. A client
  --     that could supply its own seed could brute-force one matching a
  --     hand-picked order (~N! hashes) and every verification would pass.
  if tg_op = 'INSERT' then
    if new.draw_seed is not null or new.draw_commitment is not null or new.draw_scheme is not null then
      raise exception 'committees: DRAW_FIELDS_ARE_SERVER_ONLY — use perform_committee_draw()'
        using errcode = '42501';
    end if;
  elsif new.draw_seed is distinct from old.draw_seed
     or new.draw_commitment is distinct from old.draw_commitment
     or new.draw_scheme is distinct from old.draw_scheme then
    raise exception 'committees: DRAW_FIELDS_ARE_SERVER_ONLY — use perform_committee_draw()'
      using errcode = '42501';
  end if;

  -- (b) Once a draw exists the outcome is frozen: no re-dating it, and no
  --     flipping payout_method to escape the member-slot lock in section 3b.
  if tg_op = 'UPDATE' and old.draw_seed is not null then
    if new.drawn_at is distinct from old.drawn_at then
      raise exception 'committees: DRAW_LOCKED — drawn_at is immutable after a draw'
        using errcode = '42501';
    end if;
    if new.payout_method is distinct from old.payout_method then
      raise exception 'committees: DRAW_LOCKED — payout_method is immutable after a draw'
        using errcode = '42501';
    end if;
  end if;

  -- (c) THE LAUNDERING ROUTE. Set the slots while the kameti is 'fixed'
  --     (legal — that is the mode), then relabel it 'ballot' so the hand-picked
  --     order is presented to witnesses as a draw. Section 3b's per-row check
  --     cannot see this: no member row is written, only the parent's mode.
  --
  --     Refused rather than silently cleared — see the rule table in this
  --     file's header for the reasoning and the two-step remedy. Checked BEFORE
  --     (d) so a slotted switch names the slots, which are the actual problem,
  --     rather than the drawn_at it also carries.
  if tg_op = 'UPDATE'
     and new.payout_method = 'ballot'
     and old.payout_method is distinct from 'ballot' then
    select count(*) into v_slotted
      from public.committee_members
     where committee_id = new.id and slot is not null;
    if v_slotted > 0 then
      raise exception 'committees: BALLOT_SWITCH_NEEDS_CLEAR_SLOTS — % member(s) hold a hand-picked slot; clear the slots before switching this kameti to ballot', v_slotted
        using errcode = '42501';
    end if;
  end if;

  -- (d) THE NEVER-DRAW GAP. A ballot kameti is "drawn" only if the SERVER drew
  --     it. Stated as an invariant on the resulting row rather than as a delta,
  --     so it holds for INSERT and UPDATE alike and cannot be walked around by
  --     changing payout_method in the same statement that carries a stale
  --     drawn_at. draw_seed is unreachable from a client by (a), so pinning
  --     drawn_at to it pins it to perform_committee_draw().
  --
  --     payout_method='fixed' is untouched here: an organiser-chosen order IS
  --     that mode, and committeeStore.setFixedOrder stamps drawn_at as "the
  --     order was settled at", which stays legal.
  if new.payout_method = 'ballot'
     and new.drawn_at is not null
     and new.draw_seed is null then
    raise exception 'committees: BALLOT_DRAW_SERVER_ONLY — drawn_at on a ballot kameti is set only by perform_committee_draw()'
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists trg_committees_draw_immutable on public.committees;
create trigger trg_committees_draw_immutable
  before insert or update on public.committees
  for each row execute function public.tg_committees_draw_immutable();

-- 3b. Two rules, in order of when they bite:
--
--     BEFORE the draw, on a payout_method='ballot' kameti, a slot must be NULL.
--     Slots are the draw's OUTPUT, never an input to it. Without this the
--     organiser hand-writes the order and never calls the RPC at all — the
--     never-draw path this file's Evidence section describes. Stated as an
--     invariant on the row (`new.slot is not null`), not as a change, so an
--     INSERT that arrives already slotted is refused too.
--
--     AFTER the draw, slots and membership freeze in BOTH modes — otherwise the
--     organiser keeps the honest seed and simply rewrites the slots. (That is
--     detectable by CommitteeVerifyDraw, but "detectable" is a weaker promise
--     than "impossible", and the witness page is what non-app relatives see.)
--
--     payout_method='fixed' before a draw is deliberately left wide open: the
--     organiser picking the payout round for each member is the whole feature.
--
--     DELETE is deliberately NOT blocked. Deleting a committee cascades into
--     committee_members, and a BEFORE DELETE guard here would make
--     committeesDb.delete() fail on every drawn kameti — a worse bug than the
--     one it closes. Removing a member after a draw still breaks verification
--     loudly (the member list no longer reproduces the stored order), so it is
--     detectable rather than silent.
create or replace function public.tg_committee_members_draw_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_drawn  boolean;
  v_method text;
begin
  if coalesce(current_setting('hisaab.committee_draw', true), 'off') = 'on' then
    return new;
  end if;

  select (c.draw_seed is not null), c.payout_method
    into v_drawn, v_method
    from public.committees c where c.id = new.committee_id;

  -- Parent already gone (a cascade in flight) → nothing to protect.
  if not found then
    return new;
  end if;

  if v_drawn then
    if tg_op = 'INSERT' then
      raise exception 'committee_members: DRAW_LOCKED — cannot add a member after the ballot draw'
        using errcode = '42501';
    end if;

    if new.slot is distinct from old.slot then
      raise exception 'committee_members: DRAW_LOCKED — slot is immutable after the ballot draw'
        using errcode = '42501';
    end if;

    if new.committee_id is distinct from old.committee_id then
      raise exception 'committee_members: DRAW_LOCKED — a drawn member cannot be moved between committees'
        using errcode = '42501';
    end if;

  -- PRE-DRAW, BALLOT: the slot is the draw's output. Refusing it here is what
  -- makes perform_committee_draw()'s `v_slotted > 0` branch unreachable for
  -- ballot, and therefore what stops the RPC from being permanently bricked by
  -- a hand-written order.
  elsif v_method = 'ballot' and new.slot is not null then
    raise exception 'committee_members: BALLOT_SLOTS_SERVER_ONLY — slot on a ballot kameti is assigned only by perform_committee_draw()'
      using errcode = '42501';
  end if;

  -- The lookup above sees only the NEW parent, so moving a member OUT of a
  -- drawn kameti and into an undrawn one slipped past the DRAW_LOCKED check —
  -- an equivalent of the member removal the DELETE note below accepts, but one
  -- the error message above already claimed to block. Check the old parent too.
  if tg_op = 'UPDATE'
     and new.committee_id is distinct from old.committee_id
     and exists (select 1 from public.committees c
                  where c.id = old.committee_id and c.draw_seed is not null) then
    raise exception 'committee_members: DRAW_LOCKED — a drawn member cannot be moved between committees'
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists trg_committee_members_draw_locked on public.committee_members;
create trigger trg_committee_members_draw_locked
  before insert or update on public.committee_members
  for each row execute function public.tg_committee_members_draw_locked();

-- ═══════════════════════════════════════════════════════════
-- 4. Witness payload carries the scheme
-- ═══════════════════════════════════════════════════════════
-- Unchanged from phase2 except for the added 'drawScheme' key, so a witness can
-- tell a server draw from a legacy client draw without an account. Redefined
-- in full because create or replace cannot patch a function body.

create or replace function public.get_committee_witness(p_token text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v public.committees;
  result json;
begin
  if p_token is null or length(p_token) < 8 then
    return null;
  end if;
  select * into v from public.committees where share_token = p_token;
  if not found then
    return null;
  end if;

  select json_build_object(
    'committee', json_build_object(
      'id', v.id, 'name', v.name, 'currency', v.currency,
      'contributionAmount', v.contribution_amount, 'memberCount', v.member_count,
      'cadence', v.cadence, 'totalRounds', v.total_rounds, 'startDate', v.start_date,
      'payoutMethod', v.payout_method, 'status', v.status, 'drawnAt', v.drawn_at,
      'drawSeed', v.draw_seed, 'drawCommitment', v.draw_commitment,
      'drawScheme', v.draw_scheme, 'createdAt', v.created_at
    ),
    'members', coalesce((
      select json_agg(json_build_object(
        'id', m.id, 'name', m.name, 'slot', m.slot, 'isOrganizer', m.is_organizer,
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

grant execute on function public.get_committee_witness(text) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════
-- 5. VERIFICATION — run after applying
-- ═══════════════════════════════════════════════════════════
-- (If digest()/gen_random_bytes() are unqualified-unresolvable in your Studio
--  session, prefix them with the schema pgcrypto was installed into, usually
--  `extensions.`.)

-- 5.1 THE CROSS-CHECK. Must reproduce the vector in this file's header and in
--     src/lib/committeeDraw.test.ts. Expect: {m4,m1,m2,m3,m5}
select array_agg(member_id order by rank_hex collate "C", member_id collate "C") as sql_order
  from (
    select m.id::text as member_id,
           encode(digest('00112233445566778899aabbccddeeff' || ':' || m.id, 'sha256'), 'hex') as rank_hex
      from (values ('m1'),('m2'),('m3'),('m4'),('m5')) as m(id)
  ) ranked;

-- 5.2 The seal for the same vector.
--     Expect: 5947d7c33d783f94b3b4c1a96ebc8991ed28f1b069b71e03376cba8caa98a720
select encode(digest('00112233445566778899aabbccddeeff', 'sha256'), 'hex') as commitment;

-- 5.3 The RPC exists, is SECURITY DEFINER, and anon cannot call it.
select p.proname, p.prosecdef,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_can,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_can
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'perform_committee_draw';
-- Expect: one row, prosecdef = t, auth_can = t, anon_can = f

-- 5.4 Both immutability triggers are armed.
select c.relname, t.tgname, t.tgenabled
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where t.tgname in ('trg_committees_draw_immutable', 'trg_committee_members_draw_locked');
-- Expect: two rows, tgenabled = 'O' for both

-- 5.5 The scheme column exists.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'committees' and column_name = 'draw_scheme';
-- Expect: one row, text

-- 5.6 Provenance of every existing draw. Anything still on
--     'mulberry32-shuffle-v0' is a PRE-FIX record: its order matches its seed,
--     but the seed came from the organiser's device and carries no server
--     guarantee. Pre-launch these should be test data — delete them (or accept
--     that their fairness is unproven).
select coalesce(draw_scheme, '(none)') as scheme, count(*), min(drawn_at) as oldest
  from public.committees
 where draw_seed is not null
 group by 1;

-- 5.7 No committee carries a seed whose slots were never assigned (would mean a
--     half-applied draw). Expect: 0
select count(*) as seeded_but_unslotted
  from public.committees c
 where c.draw_seed is not null
   and not exists (select 1 from public.committee_members m
                    where m.committee_id = c.id and m.slot is not null);

-- 5.9 THE NEVER-DRAW INVARIANT. A ballot kameti may carry slots or a drawn_at
--     only if the server drew it. Anything here is a pre-fix hand-picked
--     "ballot" order: it has no seed, so its fairness is not merely unproven,
--     it is unprovable. Delete the row or relabel it 'fixed' (honest) — the
--     witness page must not present it as a draw. Expect: 0
select count(*) as unseeded_ballots_with_an_order
  from public.committees c
 where c.payout_method = 'ballot'
   and c.draw_seed is null
   and (c.drawn_at is not null
        or exists (select 1 from public.committee_members m
                    where m.committee_id = c.id and m.slot is not null));

-- 5.10 Manual QA as a signed-in organiser (do this on a throwaway committee):
--   a. Create a 'ballot' kameti with 4 members, then:
--        select public.perform_committee_draw('<committee id>');
--      -> {"status":"ok", ..., "drawScheme":"sha256-rank-v1", "order":[...]}
--   b. Call it a SECOND time
--      -> ERROR: perform_committee_draw: ALREADY_DRAWN   (slots unchanged)
--   c. As a DIFFERENT signed-in user:
--        select public.perform_committee_draw('<same id>');
--      -> ERROR: perform_committee_draw: NOT_ORGANISER
--   d. Try to rig it by hand (this is the M10 attack, and must now fail):
--        update public.committees set draw_seed = 'deadbeef' where id = '<id>';
--      -> ERROR: committees: DRAW_FIELDS_ARE_SERVER_ONLY
--        update public.committee_members set slot = 1 where id = '<any member>';
--      -> ERROR: committee_members: DRAW_LOCKED
--        insert into public.committees (..., draw_seed, draw_commitment) values (...);
--      -> ERROR: committees: DRAW_FIELDS_ARE_SERVER_ONLY
--   e. The NEVER-DRAW attack, on a SECOND throwaway ballot kameti that has NOT
--      been drawn:
--        update public.committee_members set slot = 1 where id = '<any member>';
--      -> ERROR: committee_members: BALLOT_SLOTS_SERVER_ONLY
--        update public.committees set drawn_at = now() where id = '<undrawn id>';
--      -> ERROR: committees: BALLOT_DRAW_SERVER_ONLY
--      then perform_committee_draw('<undrawn id>') must still SUCCEED — the
--      point of the fix is that a refused rig does not brick the real draw.
--   f. The fixed mode is untouched. On a THIRD throwaway kameti created with
--      payout_method = 'fixed':
--        update public.committee_members set slot = 2 where id = '<member>';
--      -> ok (this is what the mode is for)
--        update public.committees set drawn_at = now() where id = '<fixed id>';
--      -> ok
--        update public.committees set payout_method = 'ballot' where id = '<fixed id>';
--      -> ERROR: committees: BALLOT_SWITCH_NEEDS_CLEAR_SLOTS
--      The documented remedy, in this order:
--        update public.committee_members set slot = null where committee_id = '<fixed id>';
--        update public.committees set payout_method = 'ballot', drawn_at = null
--          where id = '<fixed id>';
--        select public.perform_committee_draw('<fixed id>');
--   g. Open the witness link and press "Check this draw" -> must say verified.
--      Recompute independently to be sure, e.g.:
--        printf '%s' '<drawSeed>:<member id>' | sha256sum
--      Sorting every member by that hash must reproduce the slot order shown.
