// Group-join preview contract (audit 2026-09, UX-18 "Joining a group is
// completely blind").
//
// JoinGroupModal's confirm step used to echo back the code the user had just
// typed — literally zero new information — because strict RLS blocks reading a
// split_groups row you are not yet a member of. Meanwhile joining broadcasts
// your profile name to strangers, fires member_joined at every existing
// member, and leaving is gated on settled balances. So the confirmation asked
// for consent to something invisible.
//
// supabase-migration-p1-group-preview.sql adds a SECURITY DEFINER RPC,
// preview_group_by_code(p_code_normalized), that answers with a FIXED, minimal
// projection for a valid unexpired code — and charges misses to
// join_group_by_code's own join_code_attempts window so the preview cannot
// become a free validity oracle over the 32^6 keyspace.
//
// Everything here is pure (joinCodeStatus.ts precedent): parse + map only, no
// Supabase, no React, colocated test.

import type { I18nKey } from './i18n';
import { type JoinCodeFailureStatus, joinStatusMessageKey } from './joinCodeStatus';

/** Exactly what the RPC is allowed to reveal — no group id, no member list. */
export interface GroupPreview {
  name: string;
  emoji: string;
  memberCount: number;
  currency: string;
  ownerDisplayName: string;
  isArchived: boolean;
}

export type GroupPreviewFailureStatus =
  | JoinCodeFailureStatus
  /** Valid code, but the owner has archived the group — joins are closed. */
  | 'GROUP_ARCHIVED'
  /**
   * The RPC isn't in the database yet. Migrations here are hand-applied, so a
   * new client build can meet an old database — and a missing PREVIEW must
   * never block a JOIN that would otherwise work. Callers degrade to the
   * legacy code-echo confirm step on this status.
   */
  | 'UNAVAILABLE';

export type GroupPreviewResult =
  | { status: 'ok'; preview: GroupPreview }
  /** Archived groups still return the preview, so the user knows WHICH group. */
  | { status: 'GROUP_ARCHIVED'; preview: GroupPreview }
  | { status: GroupPreviewFailureStatus };

const FAILURE_STATUSES: readonly GroupPreviewFailureStatus[] = [
  'INVALID_CODE',
  'INVALID_OR_EXPIRED_CODE',
  'RATE_LIMITED',
  'CANNOT_JOIN_OWN_GROUP',
  'GROUP_ARCHIVED',
  'NOT_AUTHENTICATED',
  'UNAVAILABLE',
  'NETWORK',
  'UNKNOWN',
];

function asFailureStatus(raw: string): GroupPreviewFailureStatus | null {
  const upper = raw.trim().toUpperCase();
  return FAILURE_STATUSES.find(status => status === upper) ?? null;
}

function toInt(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function toText(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
}

/**
 * Reads the preview fields out of a row. Returns null when the payload claims
 * success but carries no name — a success with nothing to show is worse than
 * a clean failure, because the confirm card would be blind again.
 */
function readPreview(row: Record<string, unknown>): GroupPreview | null {
  const name = row.name;
  if (typeof name !== 'string' || name.trim() === '') return null;
  return {
    name: name.trim(),
    emoji: typeof row.emoji === 'string' ? row.emoji : '',
    memberCount: toInt(row.member_count),
    currency: toText(row.currency, ''),
    ownerDisplayName: toText(row.owner_display_name, 'Hisaab user'),
    isArchived: Boolean(row.is_archived),
  };
}

/**
 * Narrows whatever `supabase.rpc('preview_group_by_code')` returned into the
 * discriminated result. Tolerates the jsonb object, a single-row array (some
 * PostgREST shapes), and empty/garbage payloads.
 */
export function parseGroupPreviewResponse(data: unknown): GroupPreviewResult {
  if (data == null) return { status: 'INVALID_OR_EXPIRED_CODE' };

  if (Array.isArray(data)) {
    const first = data[0];
    if (!first || typeof first !== 'object') return { status: 'INVALID_OR_EXPIRED_CODE' };
    return parseGroupPreviewResponse(first);
  }

  if (typeof data !== 'object') return { status: 'UNKNOWN' };
  const row = data as Record<string, unknown>;

  const rawStatus = row.status;
  if (typeof rawStatus !== 'string') return { status: 'UNKNOWN' };

  if (rawStatus.trim().toLowerCase() === 'ok') {
    const preview = readPreview(row);
    return preview ? { status: 'ok', preview } : { status: 'UNKNOWN' };
  }

  const status = asFailureStatus(rawStatus) ?? 'UNKNOWN';
  if (status === 'GROUP_ARCHIVED') {
    const preview = readPreview(row);
    // An archived group without a readable preview degrades to the plain
    // failure — the user still gets the right message, just no card.
    return preview ? { status, preview } : { status };
  }
  return { status };
}

// PostgREST's "function not found" family. A new client meeting a database
// where supabase-migration-p1-group-preview.sql has not been applied must fall
// back to the legacy blind confirm rather than refusing to join.
const MISSING_FUNCTION_PROBES =
  /pgrst202|could not find the function|schema cache|does not exist|42883/i;

const THROWN_PROBES: Array<{ match: RegExp; status: GroupPreviewFailureStatus }> = [
  { match: MISSING_FUNCTION_PROBES, status: 'UNAVAILABLE' },
  { match: /rate[_ ]?limit/i, status: 'RATE_LIMITED' },
  { match: /group[_ ]?archived/i, status: 'GROUP_ARCHIVED' },
  { match: /cannot_join_own_group/i, status: 'CANNOT_JOIN_OWN_GROUP' },
  { match: /invalid_or_expired_code/i, status: 'INVALID_OR_EXPIRED_CODE' },
  { match: /invalid_code/i, status: 'INVALID_CODE' },
  { match: /not authenticated|jwt|28000/i, status: 'NOT_AUTHENTICATED' },
  { match: /network|failed to fetch|load failed|timeout/i, status: 'NETWORK' },
];

/** Maps a thrown error / PostgREST error object to the preview vocabulary. */
export function previewStatusFromThrown(err: unknown): GroupPreviewFailureStatus {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  else if (typeof err === 'string') parts.push(err);
  else if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    for (const field of ['message', 'code', 'details', 'hint'] as const) {
      if (typeof e[field] === 'string') parts.push(e[field] as string);
    }
  }
  const raw = parts.join(' ');
  if (!raw.trim()) return 'UNKNOWN';
  for (const { match, status } of THROWN_PROBES) {
    if (match.test(raw)) return status;
  }
  return 'UNKNOWN';
}

/**
 * True when the modal should silently fall back to the legacy code-echo
 * confirm instead of showing an error: the preview is a nice-to-have, and
 * neither a missing migration nor a flaky network should stop someone joining
 * a group whose code they legitimately hold.
 */
export function previewIsSoftFailure(status: GroupPreviewFailureStatus): boolean {
  return status === 'UNAVAILABLE' || status === 'NETWORK' || status === 'UNKNOWN';
}

/** i18n key for a hard preview failure (one worth blocking the confirm for). */
export function groupPreviewMessageKey(status: GroupPreviewFailureStatus): I18nKey {
  if (status === 'GROUP_ARCHIVED') return 'join_error_archived';
  if (status === 'UNAVAILABLE') return 'join_error_unknown';
  return joinStatusMessageKey(status as JoinCodeFailureStatus);
}
