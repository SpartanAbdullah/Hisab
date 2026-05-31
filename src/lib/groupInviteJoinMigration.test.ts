import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase-migration-fix-group-invite-join-rpc.sql', 'utf8');
const verification = readFileSync('supabase-group-invite-join-verification.sql', 'utf8');

describe('hardened group invite join repair migration', () => {
  it('fully qualifies join-path column references that collide with RPC output names', () => {
    expect(migration).toContain('WHERE gm.group_id = v_group.id');
    expect(migration).toContain('WHERE gm.group_id = v_invite.group_id');
    expect(migration).toContain('WHERE gm.id = v_invite.linked_member_id');
    expect(migration).toContain('WHERE gi.token_hash = p_invite_token_hash');
    expect(migration).toContain('WHERE gi.id = v_invite.id');
  });

  it('keeps direct membership insertion unavailable to anonymous callers', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("RAISE EXCEPTION 'Not authenticated'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.accept_group_invite(TEXT, TEXT) FROM PUBLIC, anon');
    expect(migration).not.toContain('CREATE POLICY');
    expect(verification).toContain("has_function_privilege('anon', 'public.accept_group_invite(text,text)', 'EXECUTE')");
    expect(verification).toContain("insert_policy ILIKE '%profile_id%'");
  });

  it('allows idempotent reopen only for the account that consumed the invite', () => {
    expect(migration).toContain('(gi.accepted_by IS NULL OR gi.accepted_by = v_uid)');
    expect(migration).toContain('(gm.profile_id IS NULL OR gm.profile_id = v_uid)');
  });
});
