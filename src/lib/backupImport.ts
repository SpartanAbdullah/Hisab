// Backup-file validation + the settings restore allowlist.
//
// Audit 2026-09, security M8 ("Backup import writes arbitrary localStorage
// keys and is destructively non-atomic"). Two separate holes lived in
// dataExport.importData:
//
//   1. `Object.entries(parsed.settings).forEach(([k, v]) => localStorage
//      .setItem(k, v))` — NO allowlist. Backup files travel by WhatsApp by
//      design, so a tampered file could plant `hisaab_pin_hash` (an
//      attacker-known PIN the day PIN ships), `hisaab_supabase_uid` (desyncs
//      every uid-derived Dexie path), push tokens, mode flags, anything.
//   2. The import DELETEd every table before inserting, so a malformed file
//      that merely passed `parsed.data && parsed.version` destroyed the user's
//      cloud data and then failed.
//
// Everything here is pure — no Supabase, no React, no localStorage — so it is
// unit-testable per the repo's testing philosophy. dataExport.ts calls
// validateBackupFile() BEFORE it touches a single row, and
// pickRestorableSettings() instead of iterating whatever the file supplied.

// Type-only (erased at build): the same precedent as joinCodeStatus.ts, so a
// renamed key breaks the build instead of shipping a raw key to a toast.
import type { I18nKey } from './i18n';

/** Backup format versions this build can restore. */
export const SUPPORTED_BACKUP_VERSIONS = [1, 2, 3] as const;

/** The current version exportAllData() writes. */
export const CURRENT_BACKUP_VERSION = 3;

// ── The allowlist ───────────────────────────────────────────────────────────
//
// Exactly the preference keys a backup is allowed to carry, in and out. Every
// key here is a user preference that is meaningless as an attack: worst case a
// bad file changes the display language or the display name.
//
// DELIBERATELY EXCLUDED, and why (do not add these without re-reading M8):
//   hisaab_pin_hash, hisaab_pin_lockout, hisaab_salt, hisaab_identifier
//       — the local PIN cluster. `hisaab_identifier` binds the PIN hash to an
//         identity, so restoring it re-points the lock screen. A planted hash
//         is a known PIN.
//   hisaab_supabase_uid, hisaab_email, hisaab_mobile, hisaab_just_verified
//       — auth/session identity. The Dexie mirror is partitioned by the uid
//         (`HisaabDB:user:<uid>`), so a planted uid silently mixes two users'
//         local data.
//   hisaab_push_token, hisaab_users_by_phone
//       — device/push identity and a discovery cache; a planted token points
//         this device's notifications at someone else's registration.
//   every *_dismissed / *_last_shown / *_snoozes / *_run_lock / backfill key
//       — device-local UI bookkeeping. Restoring them onto a new device
//         suppresses first-run guidance and can re-arm or defeat idempotency
//         locks (hisaab_recurring_run_lock_v1).
//
// hisaab_data_version is here on purpose: it describes the exported data and
// travels with it.
export const BACKUP_SETTINGS_ALLOWLIST = [
  'hisaab_onboarded',
  'hisaab_user_name',
  'hisaab_primary_currency',
  'hisaab_lang',
  'hisaab_app_mode',
  'hisaab_data_version',
] as const;

export type BackupSettingKey = typeof BACKUP_SETTINGS_ALLOWLIST[number];

/** Collections a backup may carry, in FK-safe insert order. */
export const BACKUP_COLLECTIONS = [
  'accounts',
  'transactions',
  'loans',
  'emiSchedules',
  'goals',
  'investmentMarkets',
  'investmentTrades',
  'investmentPrices',
  'activityLog',
  'upcomingExpenses',
  'splitGroups',
  'groupExpenses',
  'groupSettlements',
] as const;

export type BackupCollection = typeof BACKUP_COLLECTIONS[number];

export type BackupRejectReason =
  /** Not JSON at all, or JSON that isn't an object. */
  | 'NOT_JSON'
  /** Missing/!number version, or `data` isn't an object. */
  | 'BAD_SHAPE'
  /** A version this build doesn't know how to restore (e.g. a future export). */
  | 'UNSUPPORTED_VERSION'
  /** A known collection is present but isn't an array of objects. */
  | 'BAD_COLLECTION'
  /** A row in a known collection has no usable string id. */
  | 'BAD_ROW';

export interface BackupRejection {
  ok: false;
  reason: BackupRejectReason;
  /** Which collection tripped BAD_COLLECTION / BAD_ROW, for the message. */
  collection?: BackupCollection;
}

export interface BackupAcceptance {
  ok: true;
  version: number;
  data: Record<BackupCollection, Record<string, unknown>[]>;
  /** Already filtered through BACKUP_SETTINGS_ALLOWLIST. */
  settings: Partial<Record<BackupSettingKey, string>>;
  /** Total rows across all collections — handy for the confirmation copy. */
  rowCount: number;
}

export type BackupValidation = BackupAcceptance | BackupRejection;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Filters an arbitrary `settings` blob down to the allowlist, keeping only
 * string values. Anything else — an unknown key, a nested object, a number, a
 * null — is dropped silently, because a backup file is untrusted input and the
 * only correct response to an unexpected key is to ignore it.
 */
export function pickRestorableSettings(settings: unknown): Partial<Record<BackupSettingKey, string>> {
  const out: Partial<Record<BackupSettingKey, string>> = {};
  if (!isPlainObject(settings)) return out;
  for (const key of BACKUP_SETTINGS_ALLOWLIST) {
    const value = settings[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Full pre-flight check. Returns the normalised payload or a reason — and
 * NOTHING is deleted or written until this returns ok.
 *
 * Accepts either a raw JSON string or an already-parsed value.
 */
export function validateBackupFile(input: unknown): BackupValidation {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'NOT_JSON' };
    }
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'NOT_JSON' };

  const version = parsed.version;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return { ok: false, reason: 'BAD_SHAPE' };
  }
  if (!isPlainObject(parsed.data)) return { ok: false, reason: 'BAD_SHAPE' };
  if (!(SUPPORTED_BACKUP_VERSIONS as readonly number[]).includes(version)) {
    return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  }

  const source = parsed.data;
  const data = {} as Record<BackupCollection, Record<string, unknown>[]>;
  let rowCount = 0;

  for (const collection of BACKUP_COLLECTIONS) {
    const raw = source[collection];
    // Absent is fine — older versions and partial exports (the investment
    // tables are exported with a .catch(() => []) fallback) simply omit them.
    if (raw === undefined || raw === null) {
      data[collection] = [];
      continue;
    }
    if (!Array.isArray(raw)) return { ok: false, reason: 'BAD_COLLECTION', collection };

    const rows: Record<string, unknown>[] = [];
    for (const row of raw) {
      if (!isPlainObject(row)) return { ok: false, reason: 'BAD_COLLECTION', collection };
      // Every table in this schema is keyed by a client-supplied id, and the
      // restore re-inserts that id verbatim. A row without one would either
      // fail the insert halfway through or, worse, be silently accepted with a
      // generated id and break every FK that pointed at the original.
      if (typeof row.id !== 'string' || row.id.trim() === '') {
        return { ok: false, reason: 'BAD_ROW', collection };
      }
      rows.push(row);
      rowCount += 1;
    }
    data[collection] = rows;
  }

  return {
    ok: true,
    version,
    data,
    settings: pickRestorableSettings(parsed.settings),
    rowCount,
  };
}

/** i18n key for a rejection, so the toast isn't hardcoded English. */
export function backupRejectMessageKey(reason: BackupRejectReason): I18nKey {
  switch (reason) {
    case 'NOT_JSON': return 'import_err_not_json';
    case 'UNSUPPORTED_VERSION': return 'import_err_version';
    case 'BAD_COLLECTION': return 'import_err_bad_collection';
    case 'BAD_ROW': return 'import_err_bad_row';
    case 'BAD_SHAPE':
    default: return 'import_err_shape';
  }
}
