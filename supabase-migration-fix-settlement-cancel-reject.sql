-- ═══════════════════════════════════════════════════════════
-- Fix: settlement request cancel/reject failures.
--
-- Why this exists
-- ───────────────
-- linked_settlement_requests RPCs were originally defined in
-- supabase-migration-phase2c-a-settlement-requests.sql with four RPCs:
--   create_settlement_request, accept_settlement_request,
--   reject_settlement_request, cancel_settlement_request
--
-- Later migrations:
--   - phase2c-b-sender-opt-in.sql  →  altered the table, recreated `accept`
--                                     and the validate trigger only
--   - fix-bidirectional-linked-settlements.sql → recreated table (idempotent)
--                                     and recreated `accept` + `create` only
--
-- Result: `cancel_settlement_request` and `reject_settlement_request` were
-- never recreated after the table shape changed (column requester_account_id
-- added). On a project provisioned from the bidirectional migration without
-- ever running phase2c-a, the two RPCs don't exist at all — Supabase returns
-- PGRST202 ("Could not find the function ...") and the client surfaces a
-- generic "couldn't cancel / reject" toast.
--
-- This migration drops + recreates both RPCs cleanly so they're guaranteed
-- to exist on the current table shape, with grants. Idempotent — safe to
-- run repeatedly.
-- ═══════════════════════════════════════════════════════════

-- Drop any stale signatures of both functions before recreating. Using
-- `if exists` so this is no-op on fresh projects.
drop function if exists public.cancel_settlement_request(text);
drop function if exists public.reject_settlement_request(text, text);

-- ─────────────────────────────────────────────────────────────
-- cancel_settlement_request: sender withdraws a pending request.
-- ─────────────────────────────────────────────────────────────
-- Only the original sender (from_user_id) may cancel. If the request is
-- already in a terminal state (accepted/rejected/cancelled), the function
-- returns the existing row silently so the client just sees the latest
-- status — no spurious "you can't cancel" error.
create or replace function public.cancel_settlement_request(request_id text)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
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
  if v_req.from_user_id <> auth.uid() then
    raise exception 'lsr: only the sender can cancel';
  end if;

  update public.linked_settlement_requests
     set status = 'cancelled',
         responded_at = now()
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

-- ─────────────────────────────────────────────────────────────
-- reject_settlement_request: receiver declines a pending request.
-- ─────────────────────────────────────────────────────────────
-- Only the receiver (to_user_id) may reject. Optional `reason` is stored
-- for the sender to see in their outbox. Same terminal-state behaviour as
-- cancel: a non-pending row is returned unchanged.
create or replace function public.reject_settlement_request(request_id text, reason text default null)
returns public.linked_settlement_requests
language plpgsql security definer set search_path = public as $$
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
         rejection_reason = reason,
         responded_at = now()
   where id = request_id
   returning * into v_req;

  return v_req;
end $$;

-- Grant execute. Both functions are SECURITY DEFINER so they bypass the
-- table's missing UPDATE policy (the design pattern is "no UPDATE policy,
-- all state transitions via SECURITY DEFINER RPCs" — see the comment in
-- supabase-migration-phase2b-linked-requests.sql:45).
revoke all on function public.cancel_settlement_request(text) from public;
revoke all on function public.reject_settlement_request(text, text) from public;
grant execute on function public.cancel_settlement_request(text) to authenticated;
grant execute on function public.reject_settlement_request(text, text) to authenticated;
