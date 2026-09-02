import { describe, it, expect } from 'vitest';
import {
  BACKUP_COLLECTIONS,
  BACKUP_SETTINGS_ALLOWLIST,
  CURRENT_BACKUP_VERSION,
  backupRejectMessageKey,
  pickRestorableSettings,
  validateBackupFile,
} from './backupImport';

function goodFile(over: Record<string, unknown> = {}) {
  return {
    version: CURRENT_BACKUP_VERSION,
    exportedAt: '2026-09-02T00:00:00.000Z',
    settings: { hisaab_lang: 'ur', hisaab_primary_currency: 'PKR' },
    data: { accounts: [{ id: 'a1', name: 'Cash' }] },
    ...over,
  };
}

describe('pickRestorableSettings — the M8 allowlist', () => {
  it('keeps allowlisted string preferences', () => {
    const out = pickRestorableSettings({
      hisaab_lang: 'en',
      hisaab_user_name: 'Ali',
      hisaab_app_mode: 'splits_only',
    });
    expect(out).toEqual({
      hisaab_lang: 'en',
      hisaab_user_name: 'Ali',
      hisaab_app_mode: 'splits_only',
    });
  });

  // THE bug: a WhatsApp-forwarded "backup" could plant any key it liked.
  it.each([
    'hisaab_pin_hash',
    'hisaab_pin_lockout',
    'hisaab_salt',
    'hisaab_identifier',
    'hisaab_supabase_uid',
    'hisaab_email',
    'hisaab_mobile',
    'hisaab_just_verified',
    'hisaab_push_token',
    'hisaab_users_by_phone',
    'hisaab_recurring_run_lock_v1',
    'hisaab_pending_invite',
    'supabase.auth.token',
    'sb-project-auth-token',
    '__proto__',
    'anything_at_all',
  ])('refuses to restore %s', (key) => {
    const out = pickRestorableSettings({ [key]: 'planted', hisaab_lang: 'ur' });
    expect(Object.keys(out)).toEqual(['hisaab_lang']);
    expect(out).not.toHaveProperty(key);
  });

  it('drops non-string values even on allowlisted keys', () => {
    const out = pickRestorableSettings({
      hisaab_lang: { toString: 'nope' },
      hisaab_user_name: 42,
      hisaab_app_mode: null,
      hisaab_onboarded: '1',
    });
    expect(out).toEqual({ hisaab_onboarded: '1' });
  });

  it('tolerates a missing / non-object settings blob', () => {
    expect(pickRestorableSettings(undefined)).toEqual({});
    expect(pickRestorableSettings(null)).toEqual({});
    expect(pickRestorableSettings('nope')).toEqual({});
    expect(pickRestorableSettings([1, 2, 3])).toEqual({});
  });

  it('contains no auth, PIN, push or device-identity key', () => {
    const forbidden = /pin|salt|identifier|uid|token|email|mobile|verified|phone/i;
    for (const key of BACKUP_SETTINGS_ALLOWLIST) {
      expect(key, `${key} must not be restorable`).not.toMatch(forbidden);
    }
  });
});

describe('validateBackupFile', () => {
  it('accepts a well-formed current-version file', () => {
    const result = validateBackupFile(JSON.stringify(goodFile()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(CURRENT_BACKUP_VERSION);
    expect(result.rowCount).toBe(1);
    expect(result.data.accounts).toHaveLength(1);
    expect(result.settings).toEqual({ hisaab_lang: 'ur', hisaab_primary_currency: 'PKR' });
  });

  it('accepts a parsed object as well as a JSON string', () => {
    expect(validateBackupFile(goodFile()).ok).toBe(true);
  });

  it('defaults every absent collection to an empty array', () => {
    const result = validateBackupFile(goodFile({ data: {} }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const collection of BACKUP_COLLECTIONS) {
      expect(result.data[collection]).toEqual([]);
    }
    expect(result.rowCount).toBe(0);
  });

  it('keeps splits_only ledger rows whose account ids are both null', () => {
    // tasks/lessons.md: in ledger-only mode a repayment transaction has NO
    // account on either leg. The validator must not treat that as damage.
    const result = validateBackupFile(goodFile({
      data: {
        transactions: [
          { id: 't1', type: 'repayment', amount: 500, currency: 'PKR', sourceAccountId: null, destinationAccountId: null },
        ],
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.transactions).toHaveLength(1);
    expect(result.data.transactions[0].sourceAccountId).toBeNull();
    expect(result.data.transactions[0].destinationAccountId).toBeNull();
  });

  it.each([
    ['not json at all', 'this is not json'],
    ['a bare JSON array', '[]'],
    ['a bare JSON string', '"hello"'],
    ['null', 'null'],
  ])('rejects %s as NOT_JSON', (_label, raw) => {
    const result = validateBackupFile(raw);
    expect(result).toMatchObject({ ok: false, reason: 'NOT_JSON' });
  });

  it('rejects a missing or non-numeric version', () => {
    expect(validateBackupFile(goodFile({ version: undefined })))
      .toMatchObject({ ok: false, reason: 'BAD_SHAPE' });
    expect(validateBackupFile(goodFile({ version: '3' })))
      .toMatchObject({ ok: false, reason: 'BAD_SHAPE' });
  });

  it('rejects a missing or non-object data block', () => {
    expect(validateBackupFile(goodFile({ data: undefined })))
      .toMatchObject({ ok: false, reason: 'BAD_SHAPE' });
    expect(validateBackupFile(goodFile({ data: [] })))
      .toMatchObject({ ok: false, reason: 'BAD_SHAPE' });
  });

  it('rejects a future version instead of half-restoring it', () => {
    expect(validateBackupFile(goodFile({ version: 99 })))
      .toMatchObject({ ok: false, reason: 'UNSUPPORTED_VERSION' });
  });

  it('rejects a collection that is not an array of objects', () => {
    expect(validateBackupFile(goodFile({ data: { accounts: 'oops' } })))
      .toMatchObject({ ok: false, reason: 'BAD_COLLECTION', collection: 'accounts' });
    expect(validateBackupFile(goodFile({ data: { loans: [null] } })))
      .toMatchObject({ ok: false, reason: 'BAD_COLLECTION', collection: 'loans' });
    expect(validateBackupFile(goodFile({ data: { goals: ['a string row'] } })))
      .toMatchObject({ ok: false, reason: 'BAD_COLLECTION', collection: 'goals' });
  });

  it('rejects a row with no usable id — before anything is deleted', () => {
    expect(validateBackupFile(goodFile({ data: { accounts: [{ name: 'no id' }] } })))
      .toMatchObject({ ok: false, reason: 'BAD_ROW', collection: 'accounts' });
    expect(validateBackupFile(goodFile({ data: { accounts: [{ id: '   ' }] } })))
      .toMatchObject({ ok: false, reason: 'BAD_ROW', collection: 'accounts' });
    expect(validateBackupFile(goodFile({ data: { accounts: [{ id: 7 }] } })))
      .toMatchObject({ ok: false, reason: 'BAD_ROW', collection: 'accounts' });
  });

  it('strips non-allowlisted settings from an otherwise valid file', () => {
    const result = validateBackupFile(goodFile({
      settings: { hisaab_lang: 'en', hisaab_pin_hash: 'deadbeef', hisaab_supabase_uid: 'attacker' },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings).toEqual({ hisaab_lang: 'en' });
  });
});

describe('backupRejectMessageKey', () => {
  it('maps every reason to a distinct i18n key', () => {
    const keys = (['NOT_JSON', 'BAD_SHAPE', 'UNSUPPORTED_VERSION', 'BAD_COLLECTION', 'BAD_ROW'] as const)
      .map(backupRejectMessageKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key.startsWith('import_err_')).toBe(true);
  });
});
