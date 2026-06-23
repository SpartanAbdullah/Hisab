-- Kameti phase 2 — transparency layer.
--   * draw_seed / draw_commitment: provably-fair commit-reveal ballot. The
--     commitment (SHA-256 of the seed) is recorded with the draw; revealing the
--     seed lets anyone recompute and verify the order wasn't rigged.
--   * share_token + get_committee_witness(): a read-only "witness link" so any
--     member — even a non-app relative — can see the same honest ledger in a
--     browser without an account. The RPC is SECURITY DEFINER and granted to
--     anon, so it bypasses RLS for a valid token but NEVER exposes phones or
--     the organizer's user_id.

alter table public.committees add column if not exists draw_seed text;
alter table public.committees add column if not exists draw_commitment text;
alter table public.committees add column if not exists share_token text;

create unique index if not exists committees_share_token_uidx
  on public.committees (share_token) where share_token is not null;

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
      'drawSeed', v.draw_seed, 'drawCommitment', v.draw_commitment, 'createdAt', v.created_at
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
