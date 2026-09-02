// Group-lifecycle guard errors (audit 2026-09).
//
// supabase-migration-audit-p0-group-deletion-guard.sql puts a BEFORE DELETE
// trigger on split_groups that RAISEs one of two stable marker codes when a
// client tries to hard-delete a SHARED group:
//
//   GROUP_HAS_OTHER_MEMBERS         another connected, profile-linked member
//                                   is still in the group
//   GROUP_HAS_OUTSTANDING_BALANCES  an ex-member with a live Hisaab account
//                                   still has a non-zero net position
//
// The marker is the whole `message`; the human detail (names / amounts) is in
// DETAIL and the resolution in HINT. Two further markers can reach the client
// from the same migration:
//
//   GROUP_ARCHIVED            a write into an archived group was refused
//   GROUP_ARCHIVE_RPC_ONLY    a direct PATCH of archived_at was refused
//
// PostgrestError splits a RAISE across message/details/hint depending on how it
// was thrown, so every field is searched — the same defensive read
// SettingsPage.readOwnedGroupsBlocker does for OWNED_GROUPS_WITH_MEMBERS.
// Pure: no React, no store reads, colocated test. linkedErrorMap precedent.

export type GroupGuardCode =
  | 'GROUP_HAS_OTHER_MEMBERS'
  | 'GROUP_HAS_OUTSTANDING_BALANCES'
  | 'GROUP_ARCHIVED'
  | 'GROUP_ARCHIVE_RPC_ONLY';

export interface GroupGuardFailure {
  code: GroupGuardCode;
  /** Server-side DETAIL: the member names, or the unsettled amounts. English,
   *  server-composed — shown as supporting detail under localized copy. */
  detail: string;
}

// Longest-first so GROUP_ARCHIVE_RPC_ONLY is never shadowed by a prefix match,
// and so the two delete markers are checked before the archive ones.
const GUARD_CODES: readonly GroupGuardCode[] = [
  'GROUP_HAS_OUTSTANDING_BALANCES',
  'GROUP_HAS_OTHER_MEMBERS',
  'GROUP_ARCHIVE_RPC_ONLY',
  'GROUP_ARCHIVED',
];

/** Flatten every string field a PostgrestError / Error / string can carry. */
function errorParts(error: unknown): string[] {
  if (typeof error === 'string') return [error];
  if (error instanceof Error) {
    const parts = [error.message];
    for (const key of ['details', 'hint', 'code'] as const) {
      const value = (error as unknown as Record<string, unknown>)[key];
      if (typeof value === 'string') parts.push(value);
    }
    return parts;
  }
  if (error && typeof error === 'object') {
    const parts: string[] = [];
    for (const key of ['message', 'details', 'hint', 'code'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === 'string') parts.push(value);
    }
    return parts;
  }
  return [];
}

function readDetail(error: unknown, code: GroupGuardCode, blob: string): string {
  const details =
    error && typeof error === 'object' && typeof (error as Record<string, unknown>).details === 'string'
      ? ((error as Record<string, unknown>).details as string).trim()
      : '';
  // DETAIL is where the trigger puts the names/amounts. When it is present and
  // does not merely echo the marker, it IS the detail.
  if (details && !details.includes(code)) return details;
  // Other transports flatten everything into one string; take what trails the
  // marker in the same fragment.
  const at = blob.indexOf(code);
  if (at === -1) return '';
  return blob
    .slice(at + code.length)
    .split(' | ')[0]
    .replace(/^[\s:;,—–-]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();
}

/**
 * Recognise a group-lifecycle guard refusal, or return null so the caller keeps
 * its own fallback and genuine diagnostics stay visible.
 */
export function readGroupGuardFailure(error: unknown): GroupGuardFailure | null {
  const blob = errorParts(error).join(' | ');
  if (!blob) return null;
  for (const code of GUARD_CODES) {
    if (blob.includes(code)) {
      return { code, detail: readDetail(error, code, blob) };
    }
  }
  return null;
}

/** True when the refusal is one of the two DELETE-guard tiers — i.e. offering
 *  Archive as the alternative is the right next step. */
export function isGroupDeleteBlocked(error: unknown): boolean {
  const failure = readGroupGuardFailure(error);
  return failure?.code === 'GROUP_HAS_OTHER_MEMBERS'
    || failure?.code === 'GROUP_HAS_OUTSTANDING_BALANCES';
}

// ───────────────────────────────────────────────────────────────────────────
// MEMBER_ALREADY_EXISTS — supabase-migration-audit-p0-consent-guards.sql §2.2
// raises SQLSTATE 23505 when an owner re-INSERTs a member row for someone who
// already has one (typically after they declined). PostgREST surfaces it as a
// unique-violation, so both the code and the marker are checked.
// ───────────────────────────────────────────────────────────────────────────

export function isMemberAlreadyExistsError(error: unknown): boolean {
  const parts = errorParts(error);
  const blob = parts.join(' | ');
  if (/member_already_exists/i.test(blob)) return true;
  const code =
    error && typeof error === 'object' && typeof (error as Record<string, unknown>).code === 'string'
      ? ((error as Record<string, unknown>).code as string)
      : '';
  return code === '23505' && /group_members/i.test(blob);
}
