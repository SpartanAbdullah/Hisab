// Join-by-code result contract (audit 2026-09, C5 / security H1).
//
// supabase-migration-audit-p0-join-abuse-limits.sql reworks join_group_by_code
// to RETURN a jsonb status object instead of RAISEing on failure. That change
// is the whole fix: the old function recorded the failed attempt and then
// raised in the same transaction, so the INSERT into join_code_attempts was
// rolled back and the "5 failures / 5 minutes" brute-force gate could never
// fire. Returning normally lets the failure row commit.
//
// Migrations here are applied by hand (no runner), so a client build can meet
// either function. Everything below therefore accepts BOTH shapes:
//   new: { status: 'ok' | 'RATE_LIMITED' | ... , group_id, member_id, ... }
//   old: [{ group_id, member_id, was_already_connected }] + a thrown Error
// linkedErrorMap.ts precedent — pure, colocated test, no React.
import type { I18nKey } from './i18n';

/** Every non-success outcome the join flow can surface. */
export type JoinCodeFailureStatus =
  /** Client-side shape check failed, or the RPC saw a non-6-char code. */
  | 'INVALID_CODE'
  /** No group matches, or the group's join code has expired. */
  | 'INVALID_OR_EXPIRED_CODE'
  /** Sliding-window brute-force limiter tripped (5 failures / 5 minutes). */
  | 'RATE_LIMITED'
  /** The code belongs to a group the caller already owns. */
  | 'CANNOT_JOIN_OWN_GROUP'
  | 'NOT_AUTHENTICATED'
  | 'NETWORK'
  | 'UNKNOWN';

export type JoinCodeResult =
  | { status: 'ok'; groupId: string; memberId: string; wasAlreadyConnected: boolean }
  | { status: JoinCodeFailureStatus };

const FAILURE_STATUSES: readonly JoinCodeFailureStatus[] = [
  'INVALID_CODE',
  'INVALID_OR_EXPIRED_CODE',
  'RATE_LIMITED',
  'CANNOT_JOIN_OWN_GROUP',
  'NOT_AUTHENTICATED',
  'NETWORK',
  'UNKNOWN',
];

function asFailureStatus(raw: string): JoinCodeFailureStatus | null {
  const upper = raw.trim().toUpperCase();
  return FAILURE_STATUSES.find(status => status === upper) ?? null;
}

function readRow(row: Record<string, unknown>): JoinCodeResult | null {
  const groupId = row.group_id;
  const memberId = row.member_id;
  if (typeof groupId !== 'string' || !groupId) return null;
  return {
    status: 'ok',
    groupId,
    memberId: typeof memberId === 'string' ? memberId : '',
    wasAlreadyConnected: Boolean(row.was_already_connected),
  };
}

/**
 * Narrows whatever `supabase.rpc('join_group_by_code')` returned into the
 * discriminated result. Handles the new jsonb object, the legacy RETURNS TABLE
 * row array, and empty/garbage payloads (which mean "no group matched").
 */
export function parseJoinByCodeResponse(data: unknown): JoinCodeResult {
  if (data == null) return { status: 'INVALID_OR_EXPIRED_CODE' };

  // Legacy RETURNS TABLE — PostgREST hands back an array of rows.
  if (Array.isArray(data)) {
    const first = data[0];
    if (!first || typeof first !== 'object') return { status: 'INVALID_OR_EXPIRED_CODE' };
    return parseJoinByCodeResponse(first);
  }

  if (typeof data !== 'object') return { status: 'UNKNOWN' };
  const row = data as Record<string, unknown>;

  const rawStatus = row.status;
  if (typeof rawStatus === 'string') {
    if (rawStatus.trim().toLowerCase() === 'ok') {
      return readRow(row) ?? { status: 'UNKNOWN' };
    }
    return { status: asFailureStatus(rawStatus) ?? 'UNKNOWN' };
  }

  // Legacy single row with no status field.
  return readRow(row) ?? { status: 'INVALID_OR_EXPIRED_CODE' };
}

// Substring probes against the OLD function's raised messages (and PostgREST /
// fetch transport failures). Order matters: the first match wins.
const THROWN_ERROR_PROBES: Array<{ match: RegExp; status: JoinCodeFailureStatus }> = [
  { match: /rate[_ ]?limit/i, status: 'RATE_LIMITED' },
  { match: /cannot_join_own_group/i, status: 'CANNOT_JOIN_OWN_GROUP' },
  { match: /invalid_or_expired_code|group code not found|group_code_not_found/i, status: 'INVALID_OR_EXPIRED_CODE' },
  { match: /invalid_code|group code required/i, status: 'INVALID_CODE' },
  { match: /not authenticated|jwt|28000/i, status: 'NOT_AUTHENTICATED' },
  { match: /network|failed to fetch|load failed|timeout/i, status: 'NETWORK' },
];

/**
 * Maps an error thrown by the pre-migration function (or by the transport) to
 * the same status vocabulary, so the UI has one code path either way.
 */
export function joinStatusFromThrown(err: unknown): JoinCodeFailureStatus {
  const raw = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : '';
  if (!raw) return 'UNKNOWN';
  for (const { match, status } of THROWN_ERROR_PROBES) {
    if (match.test(raw)) return status;
  }
  return 'UNKNOWN';
}

const STATUS_MESSAGE_KEYS: Record<JoinCodeFailureStatus, I18nKey> = {
  INVALID_CODE: 'join_error_invalid',
  INVALID_OR_EXPIRED_CODE: 'join_error_not_found',
  RATE_LIMITED: 'join_error_rate_limited',
  CANNOT_JOIN_OWN_GROUP: 'join_error_own_group',
  NOT_AUTHENTICATED: 'join_error_auth',
  NETWORK: 'join_error_network',
  UNKNOWN: 'join_error_unknown',
};

/** i18n key for the message to show for a failed join. */
export function joinStatusMessageKey(status: JoinCodeFailureStatus): I18nKey {
  return STATUS_MESSAGE_KEYS[status] ?? 'join_error_unknown';
}

// ───────────────────────────────────────────────────────────────────────────
// INVITE-LINK REDEMPTION (audit 2026-09, H3 / SEC-07)
//
// supabase-migration-audit-p0-consent-guards.sql §3.5 rebuilds
// accept_group_invite with the same "status object, never RAISE" contract the
// join RPC got, for the same reason: a RAISE would roll back the
// invite_accept_attempts row the rate limiter counts. Two further breaking
// changes ride along —
//   * the argument is RENAMED p_invite_token_hash -> p_invite_token, and
//   * it takes the RAW token; the server hashes it (hash_invite_token), so a
//     leaked token_hash is inert and the column is no longer client-readable.
//
// Migrations here are hand-applied, so a build can still meet the OLD function
// (RETURNS TABLE + RAISE). Everything below accepts both shapes, exactly like
// the join-by-code half above.
// ───────────────────────────────────────────────────────────────────────────

export type InviteAcceptFailureStatus =
  /** Empty/garbage token — the RPC performed no lookup. */
  | 'INVALID_TOKEN'
  /** No live invite matches: revoked, expired, or already used by someone else. */
  | 'INVITE_NOT_FOUND_OR_EXPIRED'
  /** Legacy-only: the OLD function raised a distinct "Invite expired". */
  | 'INVITE_EXPIRED'
  /** Legacy-only: the OLD function raised "Group not found". */
  | 'GROUP_NOT_FOUND'
  /** 10 failed redemptions per rolling 15 minutes. */
  | 'RATE_LIMITED'
  | 'NOT_AUTHENTICATED'
  | 'NETWORK'
  | 'UNKNOWN';

export type InviteAcceptResult =
  | { status: 'ok'; groupId: string; memberId: string; wasAlreadyConnected: boolean }
  | { status: InviteAcceptFailureStatus; retryAfterSeconds?: number };

const INVITE_FAILURE_STATUSES: readonly InviteAcceptFailureStatus[] = [
  'INVALID_TOKEN',
  'INVITE_NOT_FOUND_OR_EXPIRED',
  'INVITE_EXPIRED',
  'GROUP_NOT_FOUND',
  'RATE_LIMITED',
  'NOT_AUTHENTICATED',
  'NETWORK',
  'UNKNOWN',
];

function asInviteFailureStatus(raw: string): InviteAcceptFailureStatus | null {
  const upper = raw.trim().toUpperCase();
  return INVITE_FAILURE_STATUSES.find(status => status === upper) ?? null;
}

function readInviteRow(row: Record<string, unknown>): InviteAcceptResult | null {
  const groupId = row.group_id;
  if (typeof groupId !== 'string' || !groupId) return null;
  const memberId = row.member_id;
  return {
    status: 'ok',
    groupId,
    memberId: typeof memberId === 'string' ? memberId : '',
    wasAlreadyConnected: Boolean(row.was_already_connected),
  };
}

function readRetryAfter(row: Record<string, unknown>): number | undefined {
  const raw = row.retry_after_seconds;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Narrows whatever `supabase.rpc('accept_group_invite')` returned. Handles the
 * new jsonb status object, the legacy RETURNS TABLE row array, and empty
 * payloads (which mean "no invite matched").
 */
export function parseAcceptInviteResponse(data: unknown): InviteAcceptResult {
  if (data == null) return { status: 'INVITE_NOT_FOUND_OR_EXPIRED' };

  if (Array.isArray(data)) {
    const first = data[0];
    if (!first || typeof first !== 'object') return { status: 'INVITE_NOT_FOUND_OR_EXPIRED' };
    return parseAcceptInviteResponse(first);
  }

  if (typeof data !== 'object') return { status: 'UNKNOWN' };
  const row = data as Record<string, unknown>;

  const rawStatus = row.status;
  if (typeof rawStatus === 'string') {
    if (rawStatus.trim().toLowerCase() === 'ok') {
      return readInviteRow(row) ?? { status: 'UNKNOWN' };
    }
    const status = asInviteFailureStatus(rawStatus) ?? 'UNKNOWN';
    const retryAfterSeconds = readRetryAfter(row);
    return retryAfterSeconds === undefined ? { status } : { status, retryAfterSeconds };
  }

  return readInviteRow(row) ?? { status: 'INVITE_NOT_FOUND_OR_EXPIRED' };
}

// Substring probes against the OLD function's raised messages, PostgREST's
// "function not found" (an un-migrated database met by a new client), and
// transport failures. Order matters: the first match wins.
const INVITE_THROWN_PROBES: Array<{ match: RegExp; status: InviteAcceptFailureStatus }> = [
  { match: /rate[_ ]?limit/i, status: 'RATE_LIMITED' },
  { match: /invite expired|invite_expired/i, status: 'INVITE_EXPIRED' },
  { match: /group not found|group_not_found/i, status: 'GROUP_NOT_FOUND' },
  {
    match: /invite not found|invite_not_found_or_expired|invite already|could not find the function|schema cache|does not exist/i,
    status: 'INVITE_NOT_FOUND_OR_EXPIRED',
  },
  { match: /invalid_token|invite token required/i, status: 'INVALID_TOKEN' },
  { match: /not authenticated|jwt|28000/i, status: 'NOT_AUTHENTICATED' },
  { match: /network|failed to fetch|load failed|timeout/i, status: 'NETWORK' },
];

/** Maps an error thrown by the pre-migration function (or the transport) into
 *  the same status vocabulary, so the UI has one code path either way. */
export function inviteStatusFromThrown(err: unknown): InviteAcceptFailureStatus {
  const raw = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : '';
  if (!raw) return 'UNKNOWN';
  for (const { match, status } of INVITE_THROWN_PROBES) {
    if (match.test(raw)) return status;
  }
  return 'UNKNOWN';
}

const INVITE_MESSAGE_KEYS: Record<InviteAcceptFailureStatus, I18nKey> = {
  INVALID_TOKEN: 'join_error_invalid',
  INVITE_NOT_FOUND_OR_EXPIRED: 'invite_error_not_found',
  INVITE_EXPIRED: 'join_error_expired',
  GROUP_NOT_FOUND: 'invite_error_group_gone',
  RATE_LIMITED: 'invite_error_rate_limited',
  NOT_AUTHENTICATED: 'join_error_auth',
  NETWORK: 'join_error_network',
  UNKNOWN: 'join_error_unknown',
};

const INVITE_TITLE_KEYS: Record<InviteAcceptFailureStatus, I18nKey> = {
  INVALID_TOKEN: 'invite_fail_title_invalid',
  INVITE_NOT_FOUND_OR_EXPIRED: 'invite_fail_title_invalid',
  INVITE_EXPIRED: 'invite_fail_title_invalid',
  GROUP_NOT_FOUND: 'invite_fail_title_group_gone',
  RATE_LIMITED: 'invite_fail_title_rate_limited',
  NOT_AUTHENTICATED: 'invite_fail_title_auth',
  NETWORK: 'invite_fail_title_network',
  UNKNOWN: 'invite_fail_title_unknown',
};

/** i18n key for the body copy of a failed invite redemption. */
export function inviteStatusMessageKey(status: InviteAcceptFailureStatus): I18nKey {
  return INVITE_MESSAGE_KEYS[status] ?? 'join_error_unknown';
}

/** i18n key for the headline of a failed invite redemption. */
export function inviteStatusTitleKey(status: InviteAcceptFailureStatus): I18nKey {
  return INVITE_TITLE_KEYS[status] ?? 'invite_fail_title_unknown';
}

/** Only a transient failure is worth a "Try again" button — a dead invite is
 *  dead, and re-tapping a rate-limited one only wastes the user's time. */
export function inviteStatusCanRetry(status: InviteAcceptFailureStatus): boolean {
  return status === 'NETWORK' || status === 'UNKNOWN';
}
