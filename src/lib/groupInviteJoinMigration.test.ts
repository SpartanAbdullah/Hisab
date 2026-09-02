import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The invite-join contract this client is wired against. accept_group_invite
// was REDEFINED by the consent-guards migration (audit 2026-09, H3 / SEC-07):
// raw token in, server-side hash, jsonb status out. The older
// supabase-migration-fix-group-invite-join-rpc.sql is now SUPERSEDED — pinning
// its shape would pin the vulnerability, so this file pins the new design and
// asserts the old one can no longer be what ships.
const migration = readFileSync('supabase-migration-audit-p0-consent-guards.sql', 'utf8');
const superseded = readFileSync('supabase-migration-fix-group-invite-join-rpc.sql', 'utf8');

describe('accept_group_invite — consent-guards redefinition', () => {
  it('takes the RAW token and derives the hash server-side', () => {
    // The whole point: the stored token_hash was BOTH the credential and
    // readable by every group member, so hashing at rest bought nothing. The
    // client must now send the preimage.
    expect(migration).toContain('p_invite_token TEXT');
    expect(migration).toContain('v_hash := public.hash_invite_token(p_invite_token);');
    expect(migration).toContain('WHERE gi.token_hash = v_hash');
    // The renamed argument is deliberate — PostgREST passes named args, so an
    // un-updated client fails loudly instead of silently hashing a hash.
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.accept_group_invite(TEXT, TEXT);');
    expect(superseded).toContain('p_invite_token_hash');
  });

  it('returns a jsonb status object and never raises on a business outcome', () => {
    // A RAISE would roll back the invite_accept_attempts row the rate limiter
    // counts — that is exactly the audit H1 bug, in a second place.
    expect(migration).toContain("RETURN jsonb_build_object('status', 'INVITE_NOT_FOUND_OR_EXPIRED')");
    expect(migration).toContain("RETURN jsonb_build_object('status', 'RATE_LIMITED', 'retry_after_seconds', 900)");
    expect(migration).toContain("RETURN jsonb_build_object('status', 'INVALID_TOKEN')");
    expect(migration).toContain("RETURN jsonb_build_object('status', 'NOT_AUTHENTICATED')");
    expect(migration).toContain("'status', 'ok'");
    expect(migration).toContain('INSERT INTO public.invite_accept_attempts(user_id, succeeded) VALUES (v_uid, false)');
  });

  it('keeps the join-path column qualification the superseded fix introduced', () => {
    expect(migration).toContain('WHERE gm.group_id = v_invite.group_id');
    expect(migration).toContain('WHERE gm.id = v_invite.linked_member_id');
    expect(migration).toContain('WHERE gi.id = v_invite.id');
  });

  it('keeps direct membership insertion unavailable to anonymous callers', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.accept_group_invite(TEXT, TEXT) FROM PUBLIC, anon');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.accept_group_invite(TEXT, TEXT) TO authenticated');
  });

  it('allows idempotent reopen only for the account that consumed the invite', () => {
    expect(migration).toContain('(gi.accepted_by IS NULL OR gi.accepted_by = v_uid)');
    expect(migration).toContain('(gm.profile_id IS NULL OR gm.profile_id = v_uid)');
  });

  it('stops invite links being immortal and takes token_hash off the read surface', () => {
    // splitStore.createInvite writes expiresAt: null, so the expiry is stamped
    // server-side; and the client can no longer select('*') on group_invites.
    expect(migration).toContain('CREATE TRIGGER group_invites_default_expiry');
    expect(migration).toContain('REVOKE SELECT ON public.group_invites FROM authenticated;');
    expect(migration).toContain('GRANT SELECT (');
    expect(migration).not.toContain('GRANT SELECT (\n  id, group_id, created_by, linked_member_id, token_hash');
  });
});
