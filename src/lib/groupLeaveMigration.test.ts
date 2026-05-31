import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase-migration-safe-leave-group.sql', 'utf8');
const verification = readFileSync('supabase-safe-leave-group-verification.sql', 'utf8');

describe('secure leave_group migration', () => {
  it('revokes direct group_members deletion and verifies no authenticated DELETE policy remains', () => {
    expect(migration).toContain('DROP POLICY IF EXISTS "Owner can remove group members"');
    expect(verification).toContain("tablename = 'group_members'");
    expect(verification).toContain("cmd = 'DELETE'");
    expect(verification).toContain("roles && ARRAY['authenticated']::name[]");
  });

  it('protects connected membership updates from client-side deactivation', () => {
    expect(migration).toContain('group_members_protect_membership_fields');
    expect(migration).toContain("OLD.status = 'connected'");
    expect(migration).toContain('NEW.status IS DISTINCT FROM OLD.status');
    expect(migration).toContain('NEW.profile_id IS DISTINCT FROM OLD.profile_id');
  });

  it('keeps the P0 legacy join-code lookup bypass removed', () => {
    expect(verification).toContain("to_regprocedure('public.lookup_group_by_join_code(text)') IS NOT NULL");
  });

  it('uses auth.uid, connected membership, balance checks, pending checks, and soft deactivation', () => {
    expect(migration).toContain('uid UUID := auth.uid()');
    expect(migration).toContain("AND status = 'connected'");
    expect(migration).toContain("reason_code', CASE WHEN v_payable > 0 THEN 'OUTSTANDING_PAYABLE' ELSE 'OUTSTANDING_RECEIVABLE' END");
    expect(migration).toContain("'UNRECONCILED_PARTICIPATION'");
    expect(migration).toContain("'PENDING_SPLIT_INVITE_REQUEST'");
    expect(migration).toContain("SET status = 'left'");
  });
});
