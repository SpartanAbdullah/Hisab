import { describe, expect, it } from 'vitest';
import { databaseNameForUser } from './database';
import { cacheKey, mirrorSyncKey } from '../lib/mirrorCache';

describe('local database isolation', () => {
  it('uses a different IndexedDB database for each authenticated user', () => {
    expect(databaseNameForUser('user-a')).toBe('HisaabDB:user:user-a');
    expect(databaseNameForUser('user-b')).toBe('HisaabDB:user:user-b');
    expect(databaseNameForUser('user-a')).not.toBe(databaseNameForUser('user-b'));
  });

  it('partitions mirror timestamps and Dexie mirrorSync rows by user', () => {
    expect(cacheKey('accounts', 'user-a')).toBe('hisaab:mirror:user-a:accounts:syncedAt');
    expect(cacheKey('accounts', 'user-a')).not.toBe(cacheKey('accounts', 'user-b'));
    expect(mirrorSyncKey('accounts', 'user-a')).toBe('user-a:accounts');
    expect(mirrorSyncKey('accounts', 'user-a')).not.toBe(mirrorSyncKey('accounts', 'user-b'));
  });
});

