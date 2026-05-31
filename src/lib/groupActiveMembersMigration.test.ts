import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase-migration-enforce-active-group-transaction-members.sql', 'utf8');
const verification = readFileSync('supabase-active-group-transaction-members-verification.sql', 'utf8');

describe('active-only group transaction members migration', () => {
  it('rejects a left payer and split participant server-side', () => {
    expect(migration).toContain('group_expenses_require_connected_members');
    expect(migration).toContain('gm.id = NEW.paid_by');
    expect(migration).toContain('jsonb_array_elements');
    expect(migration).toContain("gm.status = 'connected'");
    expect(migration).toContain('NOT_ENOUGH_ACTIVE_GROUP_MEMBERS');
    expect(migration).toContain('INACTIVE_GROUP_MEMBER');
  });

  it('rejects settlements involving inactive members server-side', () => {
    expect(migration).toContain('group_settlements_require_connected_members');
    expect(migration).toContain('gm.id = NEW.from_member');
    expect(migration).toContain('gm.id = NEW.to_member');
  });

  it('preserves historical rows by validating inserts and participant-changing edits only', () => {
    expect(migration).toContain("IF TG_OP = 'INSERT'");
    expect(migration).toContain('NEW.paid_by IS DISTINCT FROM OLD.paid_by');
    expect(migration).toContain('NEW.splits IS DISTINCT FROM OLD.splits');
    expect(migration).not.toContain('DELETE FROM public.group_expenses');
    expect(migration).not.toContain('DELETE FROM public.group_settlements');
    expect(verification).toContain('Historical expense and settlement rows remain untouched');
  });
});
