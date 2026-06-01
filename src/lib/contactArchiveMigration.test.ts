import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve('supabase-migration-safe-contact-archive.sql'), 'utf8');

describe('safe contact archive migration', () => {
  it('uses auth ownership and returns the same result for unknown or other-user ids', () => {
    expect(migration).toContain('v_uid UUID := auth.uid()');
    expect(migration).toContain('p.user_id = v_uid');
    expect(migration).toContain("-- Unknown ids and another user's ids intentionally return the same result.");
    expect(migration).toContain("'CONTACT_NOT_FOUND'");
  });

  it('archives only settled local contacts while preserving historical rows', () => {
    expect(migration).toContain("v_contact.linked_profile_id IS NOT NULL");
    expect(migration).toContain("'LINKED_CONTACT'");
    expect(migration).toContain("type = 'taken'");
    expect(migration).toContain("type = 'given'");
    expect(migration).toContain("l.status = 'active'");
    expect(migration).toContain("'BALANCE_NOT_SETTLED'");
    expect(migration).toContain('SET archived_at = now()');
    expect(migration).not.toContain('DELETE FROM public.persons');
  });

  it('blocks stale clients from creating records against archived contacts', () => {
    expect(migration).toContain('loans_block_archived_person_reference');
    expect(migration).toContain('transactions_block_archived_person_reference');
    expect(migration).toContain('Archived contacts cannot be used for new financial records');
    expect(migration).toContain('persons_protect_archive');
  });

  it('adds an active-contact partial index for selectors', () => {
    expect(migration).toContain('WHERE archived_at IS NULL');
  });
});
