-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — P2 · SAFE POST-CREATION EDITING FOR A KAMETI (committee)
--
-- APPLY ORDER — in Supabase Studio, AFTER:
--     supabase-migration-committees.sql            (the three tables)
--     supabase-migration-committees-phase2.sql     (witness payload)
--     supabase-migration-audit-p0-kameti-draw.sql  (the draw + its two triggers)
--     supabase-migration-p2-trust-safety.sql       (witness-token guard + RPCs)
--     supabase-migration-p2-notification-maturity.sql
--                                                  (committee_round_date, used
--                                                   by add_committee_member)
--   Idempotent: safe to re-run. It only ADDs objects — it never
--   CREATE-OR-REPLACEs `tg_committees_draw_immutable`,
--   `tg_committee_members_draw_locked`, `tg_committees_witness_token_guard`,
--   `perform_committee_draw` or `get_committee_witness`. This file's guard is a
--   THIRD, independent BEFORE UPDATE trigger that composes with those (every
--   one of them is a pure validator that returns NEW unchanged, so firing
--   order only decides which refusal the user sees first).
--
-- ── Evidence ────────────────────────────────────────────────────────────────
--
-- docs/audit-2026-09/06-user-experience.md UX-25 — "No dropout/removal or
--   order-fixing path — the organizer's only structural action is deleting the
--   whole committee." Edit member = name/phone only (KametiDetailPage);
--   committeeStore.updateMember deliberately touches neither slot nor
--   payments; deleteCommittee is the only escape. A typo'd contribution amount,
--   a wrong start date, a member who never actually joined — every one of them
--   currently costs the organiser the entire record. Mid-cycle dropout is *the*
--   classic ROSCA failure mode and the app had no answer at all.
--   (docs/audit-2026-09/12-qa-review.md tracks the same gap in its kameti row;
--   its F-18 id belongs to the consolidated-repayment finding, not to this one.)
--
-- The obvious fix — "let the organiser PATCH the committee row" — is the wrong
-- one, and the reason is the whole point of this file. `committees` carries a
-- plain owner UPDATE policy (committees.sql:69), so PostgREST will happily
-- accept `contribution_amount = 1` on a kameti whose members have already paid
-- three rounds at 5000, or `start_date` moved six months on one whose witness
-- link is already circulating. Nothing would be corrupted in a way Postgres
-- can see: every number would still be internally consistent, and every
-- historical payment would silently start meaning something else.
--
-- So editing is expressed as a MATRIX over the committee's LIFECYCLE STATE,
-- enforced server-side twice: once by an RPC that validates the whole patch
-- before touching anything, and once by a trigger that refuses the same writes
-- when they arrive as raw PostgREST (which is what an attacker — or a future
-- careless client — actually sends).
--
-- ── THE EDIT MATRIX ─────────────────────────────────────────────────────────
--
-- Three states. Note carefully what "drawn" means here:
--
--   open        no committee_payments row exists AND draw_seed IS NULL
--   collecting  at least one committee_payments row exists, draw_seed IS NULL
--   drawn       draw_seed IS NOT NULL (a SERVER ballot draw happened)
--
--   `drawn_at` is NOT the draw marker for this matrix. A payout_method='fixed'
--   kameti is stamped drawn_at at CREATION (committeeStore.createCommittee:129
--   — "the order was settled at"), so keying the lock off drawn_at would freeze
--   every fixed kameti from birth and hand the organiser exactly the dead end
--   UX-25 describes. draw_seed is reachable only from inside
--   perform_committee_draw() (audit-p0-kameti-draw.sql §3a), which makes it the
--   only honest "an order was drawn and members have seen it" signal.
--
--   field / action        open        collecting            drawn
--   ─────────────────────────────────────────────────────────────────────────
--   name                  edit        edit                  edit
--   emoji                 edit        edit                  edit
--   notes                 edit        edit                  edit
--   status                edit        edit                  edit
--     (active <-> completed is a lifecycle flag, not money math. It also
--      silences notify_committee_rounds_due, which filters status='active' —
--      p2-notification-maturity.sql §7. Never locked, in any state.)
--   contribution_amount   edit        KAMETI_LOCKED_PAYMENTS  KAMETI_LOCKED_DRAW
--   currency              edit        KAMETI_LOCKED_PAYMENTS  KAMETI_LOCKED_DRAW
--   cadence               edit        KAMETI_LOCKED_PAYMENTS  KAMETI_LOCKED_DRAW
--   start_date            edit        KAMETI_LOCKED_PAYMENTS  KAMETI_LOCKED_DRAW
--   payout_method         edit*       KAMETI_LOCKED_PAYMENTS  KAMETI_LOCKED_DRAW
--   member_count          RPC only    RPC only              RPC only
--   total_rounds          RPC only    RPC only              RPC only
--     (KAMETI_INVALID_PATCH on any direct write, in EVERY state: these two
--      counters are derived from the committee_members rows. A client that can
--      move them independently can make member_count disagree with the roster,
--      and poolAmount() = contribution × member_count is what every member is
--      told they will receive.)
--   add a member          allowed†    allowed†              KAMETI_LOCKED_DRAW
--   remove a member       allowed‡    allowed‡              KAMETI_LOCKED_DRAW
--   draw_seed /
--   draw_commitment /
--   draw_scheme /
--   drawn_at /
--   share_token*          — untouched by this file; already server-only via
--                           audit-p0-kameti-draw.sql and p2-trust-safety.sql.
--                           update_committee() refuses those keys outright
--                           (KAMETI_INVALID_PATCH) rather than forwarding them
--                           into a write the older triggers would reject with a
--                           less helpful code.
--
--   * payout_method, and why the transition is not a plain assignment:
--     fixed -> ballot is refused by tg_committees_draw_immutable (rule c) while
--     ANY member holds a slot, because a hand-picked order relabelled 'ballot'
--     is presented to witnesses as a draw. The documented remedy is the
--     two-step: NULL the slots (legal while the kameti is still 'fixed'), then
--     flip with `payout_method='ballot', drawn_at=NULL`. update_committee()
--     performs exactly that two-step, in that order, inside ONE transaction —
--     it does NOT set the `hisaab.committee_draw` bypass flag, so the audit-p0
--     trigger still validates every statement it issues. The RPC is a
--     choreography of legal writes, not an exemption from them.
--     ballot -> fixed is only reachable pre-draw (a drawn ballot is frozen by
--     rule b), where no slot exists; the RPC assigns slots 1..N in creation
--     order and stamps drawn_at, so the schedule renders immediately — the same
--     shape createCommittee() produces for a fixed kameti.
--
--   † add_committee_member appends a member AND a round (member_count + 1,
--     total_rounds + 1, slot = the new last round when the kameti is 'fixed';
--     NULL when it is an undrawn 'ballot', because a ballot's slot is the
--     draw's OUTPUT and the member trigger refuses any other source). Refused
--     when:
--       - draw_seed IS NOT NULL                    -> KAMETI_LOCKED_DRAW
--         (tg_committee_members_draw_locked refuses the INSERT anyway; we get
--          there first so the caller sees the kameti-editing code space.)
--       - any member already has payout_received_at -> KAMETI_LOCKED_PAYMENTS
--         THIS is the real money-math rule, and it is stricter than "no
--         payments". A confirmed payout means somebody has physically received
--         contribution × member_count. Adding a member afterwards raises the
--         pool for everyone who has NOT yet received, so the early recipients
--         got a smaller pool than the late ones for the same total outlay —
--         a silent transfer between members that no screen would ever show.
--         Recording contributions is harmless by comparison: the new member
--         simply starts in arrears for the elapsed rounds, which
--         KametiDetailPage already renders per member.
--       - the appended round has already elapsed
--         (committee_round_date(start_date, cadence, total_rounds + 1) <= today
--          in Asia/Karachi, matching the sweep's day boundary)
--                                                  -> KAMETI_INVALID_PATCH
--       - status <> 'active', blank name, or member_count already >= 60
--                                                  -> KAMETI_INVALID_PATCH
--
--   ‡ remove_committee_member deletes the member, compacts the slots above it
--     (fixed only — an undrawn ballot has no slots) and decrements both
--     counters. Refused when:
--       - draw_seed IS NOT NULL                    -> KAMETI_LOCKED_DRAW
--       - the member is the organiser               -> KAMETI_INVALID_PATCH
--       - member_count would drop below 2           -> KAMETI_INVALID_PATCH
--       - the member has ANY committee_payments row -> KAMETI_LOCKED_PAYMENTS
--       - the member has payout_received_at         -> KAMETI_LOCKED_PAYMENTS
--       - ANY payment exists on the committee for a round >=
--         coalesce(member.slot, total_rounds)       -> KAMETI_LOCKED_PAYMENTS
--         The compaction shifts every slot above the removed one DOWN by one,
--         so round R's recipient becomes the member who used to hold R+1. If
--         anything has already been collected for round R, that rewrites who
--         was owed what in a round that already happened. Only the untouched
--         tail of the cycle may be re-shaped.
--
-- ── Error codes (stable; the client matches on these tokens) ────────────────
--
--   KAMETI_LOCKED_PAYMENTS   money has been recorded; this field/action is
--                            frozen because changing it would re-price rows
--                            that already exist.
--   KAMETI_LOCKED_DRAW       the ballot has been drawn; the kameti's shape is
--                            what the witnesses were shown.
--   KAMETI_INVALID_PATCH     the patch itself is not acceptable — unknown or
--                            derived key, bad value, or a structural rule
--                            (organiser, minimum members, cycle already over).
--   NOT_AUTHENTICATED / NOT_FOUND / NOT_ORGANISER
--                            reused verbatim from perform_committee_draw so
--                            the client keeps ONE code space and ONE mapper
--                            (COMMITTEE_DRAW_ERRORS / toCommitteeDrawError in
--                            src/lib/supabaseDb.ts). NOT_ORGANISER rather than
--                            a conflated NOT_FOUND, matching what the draw RPC
--                            already discloses for the same rows.
--
--   Every refusal raises SQLSTATE 42501 (insufficient_privilege) so PostgREST
--   answers 403 rather than 500, exactly as the audit-p0 guards do. Value
--   validation raises 22023 (invalid_parameter_value); both carry the stable
--   token in the message, which is what the client reads.
--
-- ── App modes ───────────────────────────────────────────────────────────────
-- Kameti is MODE-AGNOSTIC, and editing does not change that. It is a
-- no-custody tracker: nothing here creates an account, a transaction, a
-- balance delta or an activity row in either full_tracker or splits_only, so
-- there is no per-mode artifact to diverge (contrast tasks/lessons.md on
-- repayments, where ledger-only silently left no record). Both modes reach
-- these RPCs through the same three store actions. The one cross-surface
-- effect is date-driven and identical in both: editing start_date or cadence
-- re-times notify_committee_rounds_due (it recomputes round dates from the
-- committee row on every sweep), and the client re-runs its local scheduler
-- after a successful edit.
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════
-- 0. Prerequisite check — fail loudly, not at 3am in an RPC
-- ═══════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.committee_round_date(date,text,integer)') is null then
    raise exception 'apply supabase-migration-p2-notification-maturity.sql first — committee_round_date(date,text,integer) is missing';
  end if;
  if to_regprocedure('public.perform_committee_draw(text)') is null then
    raise exception 'apply supabase-migration-audit-p0-kameti-draw.sql first — perform_committee_draw(text) is missing';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════
-- 1. Schema — the one always-editable field the table lacked
-- ═══════════════════════════════════════════════════════════
-- Groups carry an emoji; kametis never did, so the only way to tell two
-- "Family Kameti"s apart in a list was to open them. It is pure decoration:
-- no math, no witness meaning, editable in every state alongside the name.

alter table public.committees add column if not exists emoji text;

comment on column public.committees.emoji is
  'Optional decoration for the kameti card. No money meaning; editable in every lifecycle state (see supabase-migration-p2-kameti-editing.sql).';

-- ═══════════════════════════════════════════════════════════
-- 2. The guard trigger — raw PostgREST cannot bypass the RPCs
-- ═══════════════════════════════════════════════════════════
-- BEFORE UPDATE only. INSERT is deliberately untouched: creation legitimately
-- supplies member_count/total_rounds/contribution_amount in one shot
-- (committeesDb.add), and the draw/witness triggers already police what a new
-- row may claim about a draw or a token.
--
-- The `hisaab.committee_edit` escape is transaction-local (set_config(...,
-- true)), so it cannot leak to the next statement on a pooled connection —
-- the same discipline audit-p0-kameti-draw.sql uses for `hisaab.committee_draw`
-- and p2-trust-safety.sql for `hisaab.witness_token`. Both of those flags are
-- honoured here too: perform_committee_draw legitimately writes payout_method
-- and drawn_at, and the witness RPCs legitimately write the token columns.

create or replace function public.tg_committees_edit_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_payments int;
begin
  if coalesce(current_setting('hisaab.committee_edit', true), 'off') = 'on'
     or coalesce(current_setting('hisaab.committee_draw', true), 'off') = 'on'
     or coalesce(current_setting('hisaab.witness_token', true), 'off') = 'on' then
    return new;
  end if;

  -- (a) The derived counters are RPC-only in EVERY state. poolAmount() =
  --     contribution_amount × member_count is the number every member is
  --     promised; a client that can move member_count without adding a member
  --     changes that promise while the roster stays put.
  if new.member_count is distinct from old.member_count
     or new.total_rounds is distinct from old.total_rounds then
    raise exception 'committees: KAMETI_INVALID_PATCH — member_count / total_rounds are derived; use add_committee_member() / remove_committee_member()'
      using errcode = '42501';
  end if;

  -- (b) Nothing lockable was touched (a rename, a note, a status flip, the
  --     witness_initials_only preference, an updated_at bump) → let it pass in
  --     every state. This is the always-editable row of the matrix.
  if new.currency            is not distinct from old.currency
     and new.contribution_amount is not distinct from old.contribution_amount
     and new.cadence         is not distinct from old.cadence
     and new.start_date      is not distinct from old.start_date
     and new.payout_method   is not distinct from old.payout_method then
    return new;
  end if;

  -- (c) The draw is the stronger, permanent lock — checked first so a kameti
  --     that is both drawn and collecting names the reason that will never go
  --     away.
  if old.draw_seed is not null then
    raise exception 'committees: KAMETI_LOCKED_DRAW — the ballot has been drawn; only the name, emoji, notes and status may change'
      using errcode = '42501';
  end if;

  select count(*) into v_payments
    from public.committee_payments where committee_id = old.id;

  if v_payments > 0 then
    raise exception 'committees: KAMETI_LOCKED_PAYMENTS — % contribution(s) already recorded; the amount, currency, cadence, start date and payout method are frozen', v_payments
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists trg_committees_edit_guard on public.committees;
create trigger trg_committees_edit_guard
  before update on public.committees
  for each row execute function public.tg_committees_edit_guard();

comment on function public.tg_committees_edit_guard() is
  'UX-25 / p2-kameti-editing: refuses a raw client UPDATE of the money-shaping committee columns once a contribution is recorded or the ballot is drawn, and of the derived counters always. Composes with tg_committees_draw_immutable and tg_committees_witness_token_guard; honours all three transaction-local RPC flags.';

-- ═══════════════════════════════════════════════════════════
-- 3. update_committee(p_committee_id, p_patch)
-- ═══════════════════════════════════════════════════════════
-- Contract:
--   update_committee(text, jsonb) -> jsonb
--     {"status":"ok","committee":{ …camelCase row… }}
--   raises (message carries the token; SQLSTATE 42501 / 22023):
--     update_committee: NOT_AUTHENTICATED | NOT_FOUND | NOT_ORGANISER
--     update_committee: KAMETI_LOCKED_DRAW
--     update_committee: KAMETI_LOCKED_PAYMENTS
--     update_committee: KAMETI_INVALID_PATCH — <why>
--
-- Accepted keys (camelCase, mirroring the client's Committee type):
--   name, emoji, notes, status                       — every state
--   currency, contributionAmount, cadence,
--   startDate, payoutMethod                          — `open` only
-- Any other key, including every draw/witness column and the two derived
-- counters, is KAMETI_INVALID_PATCH. Absent keys are left alone; an explicit
-- JSON null on `emoji` clears it (the only nullable field here).

create or replace function public.update_committee(p_committee_id text, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  c            public.committees;
  v_key        text;
  v_payments   int;
  v_drawn      boolean;
  v_locked_key boolean := false;
  v_name       text;
  v_emoji      text;
  v_notes      text;
  v_status     text;
  v_currency   text;
  v_amount     numeric;
  v_cadence    text;
  v_start      date;
  v_method     text;
  v_switch     text := null;   -- 'to_ballot' | 'to_fixed' | null
  v_out        jsonb;
begin
  if v_uid is null then
    raise exception 'update_committee: NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — the patch must be a non-empty JSON object'
      using errcode = '22023';
  end if;

  -- FOR UPDATE serialises two devices editing the same kameti, and pins the
  -- payment/draw state we validate against for the rest of the transaction.
  select * into c from public.committees where id = p_committee_id for update;
  if not found then
    raise exception 'update_committee: NOT_FOUND' using errcode = '42501';
  end if;
  if c.user_id <> v_uid then
    raise exception 'update_committee: NOT_ORGANISER' using errcode = '42501';
  end if;

  v_drawn := c.draw_seed is not null;
  select count(*) into v_payments
    from public.committee_payments where committee_id = c.id;

  -- ── Whitelist + matrix, BEFORE anything is written. A patch that carries
  --    one legal and one illegal key changes nothing at all.
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key in ('name', 'emoji', 'notes', 'status') then
      null;                                   -- always editable
    elsif v_key in ('currency', 'contributionAmount', 'cadence', 'startDate', 'payoutMethod') then
      v_locked_key := true;                   -- `open` only — checked below
    else
      raise exception 'update_committee: KAMETI_INVALID_PATCH — "%" is not an editable field (derived counters and every draw/witness column are server-owned)', v_key
        using errcode = '22023';
    end if;
  end loop;

  if v_locked_key then
    if v_drawn then
      raise exception 'update_committee: KAMETI_LOCKED_DRAW — the ballot has been drawn; only the name, emoji, notes and status may change'
        using errcode = '42501';
    end if;
    if v_payments > 0 then
      raise exception 'update_committee: KAMETI_LOCKED_PAYMENTS — % contribution(s) already recorded; the amount, currency, cadence, start date and payout method are frozen', v_payments
        using errcode = '42501';
    end if;
  end if;

  -- ── Values.
  v_name := case when p_patch ? 'name' then nullif(btrim(p_patch->>'name'), '') else c.name end;
  if v_name is null or char_length(v_name) > 80 then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — name must be 1-80 characters'
      using errcode = '22023';
  end if;

  v_emoji := case when p_patch ? 'emoji' then nullif(btrim(coalesce(p_patch->>'emoji', '')), '') else c.emoji end;
  if v_emoji is not null and char_length(v_emoji) > 8 then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — emoji must be at most 8 characters'
      using errcode = '22023';
  end if;

  v_notes := case when p_patch ? 'notes' then coalesce(p_patch->>'notes', '') else c.notes end;
  if char_length(v_notes) > 500 then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — notes must be at most 500 characters'
      using errcode = '22023';
  end if;

  v_status := coalesce(p_patch->>'status', c.status);
  if v_status not in ('active', 'completed') then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — status must be active or completed'
      using errcode = '22023';
  end if;

  v_currency := coalesce(p_patch->>'currency', c.currency);
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — currency must be a 3-letter ISO code'
      using errcode = '22023';
  end if;

  begin
    v_amount := coalesce((p_patch->>'contributionAmount')::numeric, c.contribution_amount);
  exception when others then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — contributionAmount must be a number'
      using errcode = '22023';
  end;
  -- Mirrors the committees_contribution_amount_positive CHECK from
  -- supabase-migration-p1-money-bounds.sql §2k, so an out-of-range amount comes
  -- back as a stable code rather than a raw constraint violation.
  if v_amount is null or v_amount <= 0 or v_amount >= 1e12 then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — contributionAmount must be greater than 0 and under 1e12'
      using errcode = '22023';
  end if;

  v_cadence := coalesce(p_patch->>'cadence', c.cadence);
  if v_cadence not in ('daily', 'weekly', 'monthly') then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — cadence must be daily, weekly or monthly'
      using errcode = '22023';
  end if;

  begin
    v_start := coalesce((p_patch->>'startDate')::date, c.start_date);
  exception when others then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — startDate must be YYYY-MM-DD'
      using errcode = '22023';
  end;

  v_method := coalesce(p_patch->>'payoutMethod', c.payout_method);
  if v_method not in ('fixed', 'ballot') then
    raise exception 'update_committee: KAMETI_INVALID_PATCH — payoutMethod must be fixed or ballot'
      using errcode = '22023';
  end if;
  if v_method <> c.payout_method then
    v_switch := case when v_method = 'ballot' then 'to_ballot' else 'to_fixed' end;
  end if;

  -- ── Write. The flag lets THIS function move the derived counters and the
  --    locked columns; it does NOT set `hisaab.committee_draw`, so every
  --    statement below is still validated by tg_committees_draw_immutable and
  --    tg_committee_members_draw_locked. The fixed -> ballot choreography is
  --    the documented two-step, made atomic.
  perform set_config('hisaab.committee_edit', 'on', true);

  if v_switch = 'to_ballot' then
    -- Step 1 of the two-step: clear the hand-picked order while the kameti is
    -- still 'fixed' (the only window in which a slot write is legal). Skipping
    -- this earns BALLOT_SWITCH_NEEDS_CLEAR_SLOTS from the audit-p0 trigger.
    update public.committee_members
       set slot = null
     where committee_id = c.id and slot is not null;
  end if;

  update public.committees
     set name                = v_name,
         emoji               = v_emoji,
         notes               = v_notes,
         status              = v_status,
         currency            = v_currency,
         contribution_amount = v_amount,
         cadence             = v_cadence,
         start_date          = v_start,
         payout_method       = v_method,
         -- Step 2: a switch to ballot must also drop drawn_at, or rule (d) of
         -- tg_committees_draw_immutable refuses the row as an unseeded
         -- "drawn" ballot. A switch to fixed stamps it, matching what
         -- createCommittee() does for a fixed kameti ("the order was settled
         -- at"). Otherwise it is left exactly as it was.
         drawn_at            = case v_switch
                                 when 'to_ballot' then null
                                 when 'to_fixed'  then now()
                                 else drawn_at
                               end,
         updated_at          = now()
   where id = c.id;

  if v_switch = 'to_fixed' then
    -- Reachable only pre-draw, where an undrawn ballot holds no slots at all.
    -- Assign the creation order so the schedule and the round navigator have
    -- something to show; the organiser can still re-order (setFixedOrder).
    update public.committee_members m
       set slot = ord.n
      from (
        select id, row_number() over (order by created_at, id) as n
          from public.committee_members
         where committee_id = c.id
      ) ord
     where m.id = ord.id and m.committee_id = c.id;
  end if;

  perform set_config('hisaab.committee_edit', 'off', true);

  select jsonb_build_object(
    'status', 'ok',
    'committee', jsonb_build_object(
      'id', x.id, 'name', x.name, 'emoji', x.emoji, 'currency', x.currency,
      'contributionAmount', x.contribution_amount, 'memberCount', x.member_count,
      'cadence', x.cadence, 'totalRounds', x.total_rounds, 'startDate', x.start_date,
      'payoutMethod', x.payout_method, 'status', x.status, 'notes', x.notes,
      'drawnAt', x.drawn_at, 'updatedAt', x.updated_at
    )
  ) into v_out
    from public.committees x where x.id = c.id;

  return v_out;
end $$;

revoke all on function public.update_committee(text, jsonb) from public, anon;
grant execute on function public.update_committee(text, jsonb) to authenticated;

comment on function public.update_committee(text, jsonb) is
  'UX-25 / p2-kameti-editing: organiser-only patch of a kameti. name/emoji/notes/status always; currency/contributionAmount/cadence/startDate/payoutMethod only while no contribution is recorded and the ballot is undrawn. Refuses with KAMETI_LOCKED_PAYMENTS / KAMETI_LOCKED_DRAW / KAMETI_INVALID_PATCH.';

-- ═══════════════════════════════════════════════════════════
-- 4. add_committee_member(...)
-- ═══════════════════════════════════════════════════════════
-- Contract:
--   add_committee_member(p_committee_id text, p_name text,
--                        p_phone text default null,
--                        p_person_id text default null) -> jsonb
--     {"status":"ok","member":{…},"memberCount":n,"totalRounds":n}
--   raises: NOT_AUTHENTICATED | NOT_FOUND | NOT_ORGANISER
--           KAMETI_LOCKED_DRAW | KAMETI_LOCKED_PAYMENTS | KAMETI_INVALID_PATCH

create or replace function public.add_committee_member(
  p_committee_id text,
  p_name         text,
  p_phone        text default null,
  p_person_id    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  c           public.committees;
  v_name      text := nullif(btrim(coalesce(p_name, '')), '');
  v_paid_out  int;
  v_next      int;
  v_slot      int;
  v_id        text := gen_random_uuid()::text;
  v_now       timestamptz := now();
  v_today     date := (now() at time zone 'Asia/Karachi')::date;
begin
  if v_uid is null then
    raise exception 'add_committee_member: NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if v_name is null or char_length(v_name) > 60 then
    raise exception 'add_committee_member: KAMETI_INVALID_PATCH — the member name must be 1-60 characters'
      using errcode = '22023';
  end if;

  select * into c from public.committees where id = p_committee_id for update;
  if not found then
    raise exception 'add_committee_member: NOT_FOUND' using errcode = '42501';
  end if;
  if c.user_id <> v_uid then
    raise exception 'add_committee_member: NOT_ORGANISER' using errcode = '42501';
  end if;

  if c.draw_seed is not null then
    raise exception 'add_committee_member: KAMETI_LOCKED_DRAW — the ballot has been drawn; the roster it was drawn over cannot change'
      using errcode = '42501';
  end if;

  if c.status <> 'active' then
    raise exception 'add_committee_member: KAMETI_INVALID_PATCH — this kameti is marked completed'
      using errcode = '22023';
  end if;

  -- The pool rule. See the matrix in this file's header: once ANY payout has
  -- been confirmed, growing member_count would hand later recipients a bigger
  -- pool than the ones already paid out, for the same personal outlay.
  select count(*) into v_paid_out
    from public.committee_members
   where committee_id = c.id and payout_received_at is not null;
  if v_paid_out > 0 then
    raise exception 'add_committee_member: KAMETI_LOCKED_PAYMENTS — % member(s) have already received their pool; adding a member now would change what the remaining members receive', v_paid_out
      using errcode = '42501';
  end if;

  if c.member_count >= 60 then
    raise exception 'add_committee_member: KAMETI_INVALID_PATCH — a kameti is capped at 60 members'
      using errcode = '22023';
  end if;

  v_next := c.total_rounds + 1;
  if public.committee_round_date(c.start_date, c.cadence, v_next) <= v_today then
    raise exception 'add_committee_member: KAMETI_INVALID_PATCH — the round this member would receive (round %) has already passed', v_next
      using errcode = '22023';
  end if;

  -- A fixed kameti hands the newcomer the new last round. An undrawn ballot
  -- must leave the slot NULL: tg_committee_members_draw_locked refuses any
  -- other source for a ballot slot, and that refusal is what keeps
  -- perform_committee_draw() callable.
  v_slot := case when c.payout_method = 'fixed' then v_next else null end;

  perform set_config('hisaab.committee_edit', 'on', true);

  insert into public.committee_members
    (id, committee_id, user_id, name, phone, person_id, slot, is_organizer, created_at)
  values
    (v_id, c.id, v_uid, v_name, nullif(btrim(coalesce(p_phone, '')), ''),
     nullif(btrim(coalesce(p_person_id, '')), ''), v_slot, false, v_now);

  update public.committees
     set member_count = c.member_count + 1,
         total_rounds = v_next,
         updated_at   = v_now
   where id = c.id;

  perform set_config('hisaab.committee_edit', 'off', true);

  return jsonb_build_object(
    'status', 'ok',
    'member', jsonb_build_object(
      'id', v_id, 'committeeId', c.id, 'name', v_name,
      'phone', nullif(btrim(coalesce(p_phone, '')), ''),
      'personId', nullif(btrim(coalesce(p_person_id, '')), ''),
      'slot', v_slot, 'isOrganizer', false,
      'payoutReceivedAt', null, 'exitedAt', null, 'createdAt', v_now
    ),
    'memberCount', c.member_count + 1,
    'totalRounds', v_next
  );
end $$;

revoke all on function public.add_committee_member(text, text, text, text) from public, anon;
grant execute on function public.add_committee_member(text, text, text, text) to authenticated;

comment on function public.add_committee_member(text, text, text, text) is
  'UX-25 / p2-kameti-editing: organiser-only. Appends a member AND a round (member_count+1, total_rounds+1). Refused after a ballot draw or once any payout has been confirmed.';

-- ═══════════════════════════════════════════════════════════
-- 5. remove_committee_member(...)
-- ═══════════════════════════════════════════════════════════
-- Contract:
--   remove_committee_member(p_committee_id text, p_member_id text) -> jsonb
--     {"status":"ok","committeeId":…,"removedSlot":n|null,
--      "memberCount":n,"totalRounds":n}
--   raises: NOT_AUTHENTICATED | NOT_FOUND | NOT_ORGANISER
--           KAMETI_LOCKED_DRAW | KAMETI_LOCKED_PAYMENTS | KAMETI_INVALID_PATCH

create or replace function public.remove_committee_member(
  p_committee_id text,
  p_member_id    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  c          public.committees;
  m          public.committee_members;
  v_pays     int;
  v_from     int;
  v_now      timestamptz := now();
begin
  if v_uid is null then
    raise exception 'remove_committee_member: NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  select * into c from public.committees where id = p_committee_id for update;
  if not found then
    raise exception 'remove_committee_member: NOT_FOUND' using errcode = '42501';
  end if;
  if c.user_id <> v_uid then
    raise exception 'remove_committee_member: NOT_ORGANISER' using errcode = '42501';
  end if;

  select * into m
    from public.committee_members
   where id = p_member_id and committee_id = c.id
   for update;
  if not found then
    raise exception 'remove_committee_member: NOT_FOUND' using errcode = '42501';
  end if;

  if c.draw_seed is not null then
    raise exception 'remove_committee_member: KAMETI_LOCKED_DRAW — the ballot has been drawn; removing a member would make the published order unverifiable'
      using errcode = '42501';
  end if;

  if m.is_organizer then
    raise exception 'remove_committee_member: KAMETI_INVALID_PATCH — the organiser cannot be removed from their own kameti'
      using errcode = '22023';
  end if;

  if c.member_count - 1 < 2 then
    raise exception 'remove_committee_member: KAMETI_INVALID_PATCH — a kameti needs at least 2 members'
      using errcode = '22023';
  end if;

  select count(*) into v_pays
    from public.committee_payments where member_id = m.id;
  if v_pays > 0 then
    raise exception 'remove_committee_member: KAMETI_LOCKED_PAYMENTS — % contribution(s) are recorded against this member', v_pays
      using errcode = '42501';
  end if;

  if m.payout_received_at is not null then
    raise exception 'remove_committee_member: KAMETI_LOCKED_PAYMENTS — this member has already received their pool'
      using errcode = '42501';
  end if;

  -- The compaction rule. Removing the member shifts every slot above theirs
  -- DOWN by one and drops the last round, so any round at or after that point
  -- changes meaning. Only an untouched tail may be re-shaped.
  v_from := coalesce(m.slot, c.total_rounds);
  select count(*) into v_pays
    from public.committee_payments
   where committee_id = c.id and round >= v_from;
  if v_pays > 0 then
    raise exception 'remove_committee_member: KAMETI_LOCKED_PAYMENTS — % contribution(s) are recorded for round % or later; removing this member would re-number those rounds', v_pays, v_from
      using errcode = '42501';
  end if;

  perform set_config('hisaab.committee_edit', 'on', true);

  delete from public.committee_members where id = m.id;

  if m.slot is not null then
    -- Legal: the kameti is undrawn, and on a 'fixed' kameti the slot is the
    -- organiser's to choose. An undrawn ballot has no slots, so this matches
    -- nothing there.
    update public.committee_members
       set slot = slot - 1
     where committee_id = c.id and slot > m.slot;
  end if;

  update public.committees
     set member_count = c.member_count - 1,
         total_rounds = greatest(c.total_rounds - 1, 1),
         updated_at   = v_now
   where id = c.id;

  perform set_config('hisaab.committee_edit', 'off', true);

  return jsonb_build_object(
    'status', 'ok',
    'committeeId', c.id,
    'removedSlot', m.slot,
    'memberCount', c.member_count - 1,
    'totalRounds', greatest(c.total_rounds - 1, 1)
  );
end $$;

revoke all on function public.remove_committee_member(text, text) from public, anon;
grant execute on function public.remove_committee_member(text, text) to authenticated;

comment on function public.remove_committee_member(text, text) is
  'UX-25 / p2-kameti-editing: organiser-only. Removes a member, compacts the slots above it and decrements both counters. Refused after a ballot draw, for the organiser, below 2 members, or when any contribution touches the member or the affected rounds.';

-- ═══════════════════════════════════════════════════════════
-- 6. VERIFICATION — run after applying
-- ═══════════════════════════════════════════════════════════

-- 6.1 All three RPCs exist, are SECURITY DEFINER, and anon cannot call them.
select p.proname, p.prosecdef,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_can,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_can
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('update_committee', 'add_committee_member', 'remove_committee_member')
 order by 1;
-- Expect: three rows, prosecdef = t, auth_can = t, anon_can = f

-- 6.2 All THREE committees BEFORE triggers are armed and coexist.
select t.tgname, t.tgenabled
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where c.relname = 'committees' and not t.tgisinternal
 order by 1;
-- Expect: at least trg_committees_draw_immutable, trg_committees_edit_guard,
--         trg_committees_witness_token_guard — all tgenabled = 'O'

-- 6.3 The emoji column exists.
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'committees' and column_name = 'emoji';
-- Expect: one row, text

-- 6.4 DRIFT CHECK — member_count must equal the actual roster, and
--     total_rounds must equal member_count. Anything here predates the RPCs
--     (or was written by a client before this trigger existed) and will make
--     poolAmount() lie on that kameti's card. Expect: 0 rows.
select c.id, c.name, c.member_count, c.total_rounds,
       (select count(*) from public.committee_members m where m.committee_id = c.id) as actual_members
  from public.committees c
 where c.member_count <> (select count(*) from public.committee_members m where m.committee_id = c.id)
    or c.total_rounds <> c.member_count;

-- 6.5 SLOT CONTIGUITY — on a fixed kameti with an order, the assigned slots
--     must be exactly 1..total_rounds with no gaps (what the compaction in §5
--     preserves). A gap renders as "—" in the schedule. Expect: 0 rows.
select c.id, c.name, c.total_rounds,
       (select count(*) from public.committee_members m
         where m.committee_id = c.id and m.slot is not null) as slotted,
       (select max(m.slot) from public.committee_members m where m.committee_id = c.id) as max_slot
  from public.committees c
 where c.payout_method = 'fixed'
   and exists (select 1 from public.committee_members m
                where m.committee_id = c.id and m.slot is not null)
   and (
     (select count(distinct m.slot) from public.committee_members m
       where m.committee_id = c.id and m.slot is not null) <> c.total_rounds
     or (select max(m.slot) from public.committee_members m
          where m.committee_id = c.id) <> c.total_rounds
   );

-- 6.6 Manual QA as a signed-in organiser (throwaway kameti, both app modes —
--     the flows are identical, which is the point of the mode note above):
--   a. Fresh kameti, no payments:
--        select public.update_committee('<id>', '{"contributionAmount": 7500}');
--      -> {"status":"ok", …} and the card's pool updates.
--   b. Tick one member paid, then repeat (a)
--      -> ERROR: update_committee: KAMETI_LOCKED_PAYMENTS
--        select public.update_committee('<id>', '{"name":"New name"}');
--      -> still ok. The name is never locked.
--   c. Bypass attempt (this is what the trigger is for):
--        update public.committees set contribution_amount = 1 where id = '<id>';
--      -> ERROR: committees: KAMETI_LOCKED_PAYMENTS
--        update public.committees set member_count = 99 where id = '<id>';
--      -> ERROR: committees: KAMETI_INVALID_PATCH
--   d. As a DIFFERENT signed-in user:
--        select public.update_committee('<id>', '{"name":"x"}');
--      -> ERROR: update_committee: NOT_ORGANISER
--   e. Draw the ballot, then:
--        select public.update_committee('<id>', '{"cadence":"weekly"}');
--      -> ERROR: update_committee: KAMETI_LOCKED_DRAW
--        select public.add_committee_member('<id>', 'Late Joiner');
--      -> ERROR: add_committee_member: KAMETI_LOCKED_DRAW
--        select public.update_committee('<id>', '{"emoji":"🏦"}');
--      -> still ok.
--   f. On an undrawn FIXED kameti with slots, switch to ballot in ONE call:
--        select public.update_committee('<id>', '{"payoutMethod":"ballot"}');
--      -> ok; every slot is NULL and drawn_at is NULL, so the draw CTA returns.
--        select public.perform_committee_draw('<id>');
--      -> ok. (Before this file, that switch was BALLOT_SWITCH_NEEDS_CLEAR_SLOTS
--         with no in-app way to clear the slots.)
--   g. Remove a clean member from a fixed kameti with slots 1..4:
--        select public.remove_committee_member('<id>', '<the slot-2 member>');
--      -> ok; the old slots 3,4 become 2,3 and total_rounds drops to 3. Check
--         the schedule has no "—" row (verification 6.5).
