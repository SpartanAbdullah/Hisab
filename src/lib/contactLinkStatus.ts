// Contact-link result contract (audit 2026-09, C6 / security H2 / SEC-04).
//
// supabase-migration-audit-p0-consent-guards.sql makes
// `persons.linked_profile_id` RPC-only: a BEFORE INSERT OR UPDATE trigger
// raises 42501 (LINK_RPC_REQUIRED) for the `authenticated`/`anon` roles, and
// three SECURITY DEFINER functions become the only write path —
//
//   link_contact_by_code(p_person_id TEXT, p_code_normalized TEXT) -> JSONB
//   link_contact_by_discovery(p_person_id TEXT, p_profile_id UUID) -> JSONB
//   unlink_contact_profile(p_person_id TEXT)                       -> JSONB
//
// The two link RPCs differ only in what they accept as PROOF (a public code
// vs. a re-derived phone-discovery match) — identical JSON shape, identical
// status vocabulary — so one parser serves both. What differs is copy: on the
// discovery path there is no code to re-check and the throttle is the phone
// budget, hence `ContactLinkPath` below.
//
// All of them RETURN a status object instead of RAISEing on a business outcome (the
// rate-limit attempt row has to survive the call — same reasoning as
// joinCodeStatus.ts, whose shape this module deliberately mirrors).
//
// Migrations here are applied by hand, so a client build can meet either
// database. Everything below therefore also understands the pre-migration
// world: a missing function (PostgREST PGRST202) means "fall back to the old
// direct write", and a 42501 means "this build is talking to a migrated
// database through a path that no longer exists".
//
// Pure + colocated test; no React, no supabase import.
import type { I18nKey } from './i18n';

/** Every non-success outcome the contact-link flow can surface. */
export type ContactLinkFailureStatus =
  /** No session, or the profile is soft-deleted. */
  | 'NOT_AUTHENTICATED'
  /** Code failed the 6-char shape check — nothing was looked up or charged. */
  | 'INVALID_CODE'
  /** p_person_id is not one of the caller's contacts. */
  | 'CONTACT_NOT_FOUND'
  /** The contact is archived; unarchive before linking. */
  | 'CONTACT_ARCHIVED'
  /** The contact already points at a DIFFERENT user — unlink first. */
  | 'CONTACT_ALREADY_LINKED'
  /** Nothing resolved: no account holds that code, or — on the discovery
   *  path — the contact's saved number no longer matches that profile's
   *  discoverable number (they changed it, or opted out). Charged to the
   *  relevant lookup window; it is the only outcome that is. */
  | 'NO_MATCH'
  /** The code is the caller's own. */
  | 'CANNOT_LINK_SELF'
  /** Another contact of the caller's already points at this same user. */
  | 'DUPLICATE_LINKED_CONTACT'
  /** 20 lookups per hour: the code window (shared with lookup_profile_by_code)
   *  on the code path, the phone window (shared with
   *  lookup_hisaab_users_by_phone) on the discovery path. */
  | 'RATE_LIMITED'
  /** The DB has the consent guard but this call used the old direct write
   *  (42501 LINK_RPC_REQUIRED). Both link paths have a real RPC now, so this
   *  should be unreachable — it survives as the honest answer for any future
   *  caller that tries to write the column itself. */
  | 'LINK_RPC_REQUIRED'
  | 'NETWORK'
  | 'UNKNOWN';

/** Whether the OTHER side has added us back yet. Never trust this for the
 *  verified seal — that stays `isConsentVerifiedLink` over accepted
 *  contact_link_requests rows. */
export type ContactLinkState = 'pending' | 'mutual';

export type ContactLinkResult =
  | { status: 'ok'; profileId: string; displayName: string; linkState: ContactLinkState }
  | { status: ContactLinkFailureStatus; retryAfterSeconds?: number };

export type ContactUnlinkResult =
  | { status: 'ok'; wasLinked: boolean; unlinkedProfileId: string | null }
  | { status: ContactLinkFailureStatus; retryAfterSeconds?: number };

const FAILURE_STATUSES: readonly ContactLinkFailureStatus[] = [
  'NOT_AUTHENTICATED',
  'INVALID_CODE',
  'CONTACT_NOT_FOUND',
  'CONTACT_ARCHIVED',
  'CONTACT_ALREADY_LINKED',
  'NO_MATCH',
  'CANNOT_LINK_SELF',
  'DUPLICATE_LINKED_CONTACT',
  'RATE_LIMITED',
  'LINK_RPC_REQUIRED',
  'NETWORK',
  'UNKNOWN',
];

function asFailureStatus(raw: string): ContactLinkFailureStatus | null {
  const upper = raw.trim().toUpperCase();
  return FAILURE_STATUSES.find((status) => status === upper) ?? null;
}

function readRetryAfter(row: Record<string, unknown>): number | undefined {
  const raw = row.retry_after_seconds;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function readLinkState(raw: unknown): ContactLinkState {
  // Fail closed: anything we don't recognise is treated as one-sided, which
  // only ever costs a "waiting for them" line the user can dismiss.
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'mutual' ? 'mutual' : 'pending';
}

function unwrapRow(data: unknown): Record<string, unknown> | null {
  // PostgREST hands a jsonb-returning RPC back as the object itself, but a
  // RETURNS TABLE (or a `.select()` on it) arrives as an array of rows.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  return row as Record<string, unknown>;
}

function failure(row: Record<string, unknown>, rawStatus: string): ContactLinkResult {
  const status = asFailureStatus(rawStatus) ?? 'UNKNOWN';
  const retryAfterSeconds = readRetryAfter(row);
  return retryAfterSeconds === undefined ? { status } : { status, retryAfterSeconds };
}

/** Narrows whatever `rpc('link_contact_by_code')` — or, identically,
 *  `rpc('link_contact_by_discovery')` — returned. The two share a contract on
 *  purpose: same keys, same status vocabulary, so there is one parser and one
 *  set of UI branches whichever proof the user supplied. */
export function parseLinkByCodeResponse(data: unknown): ContactLinkResult {
  const row = unwrapRow(data);
  if (!row) return { status: 'UNKNOWN' };

  const rawStatus = row.status;
  if (typeof rawStatus !== 'string') return { status: 'UNKNOWN' };
  if (rawStatus.trim().toLowerCase() !== 'ok') return failure(row, rawStatus);

  const profileId = row.profile_id;
  if (typeof profileId !== 'string' || !profileId) return { status: 'UNKNOWN' };
  const displayName = row.display_name;
  return {
    status: 'ok',
    profileId,
    displayName: typeof displayName === 'string' && displayName.trim() ? displayName : 'Hisaab user',
    linkState: readLinkState(row.link_state),
  };
}

/** Narrows whatever `rpc('unlink_contact_profile')` returned. */
export function parseUnlinkResponse(data: unknown): ContactUnlinkResult {
  const row = unwrapRow(data);
  if (!row) return { status: 'UNKNOWN' };

  const rawStatus = row.status;
  if (typeof rawStatus !== 'string') return { status: 'UNKNOWN' };
  if (rawStatus.trim().toLowerCase() !== 'ok') {
    const parsed = failure(row, rawStatus);
    return parsed as ContactUnlinkResult;
  }

  const unlinked = row.unlinked_profile_id;
  return {
    status: 'ok',
    wasLinked: Boolean(row.was_linked),
    unlinkedProfileId: typeof unlinked === 'string' && unlinked ? unlinked : null,
  };
}

/** True when the RPC itself is absent — i.e. the consent-guard migration has
 *  not been applied to this database yet, so the legacy direct write is still
 *  the correct (and still permitted) path. */
export function isMissingFunctionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && (code === 'PGRST202' || code === '42883')) return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return /could not find the function|function .* does not exist|schema cache/i.test(message);
}

/** True for the trigger's 42501 LINK_RPC_REQUIRED — the database is migrated
 *  but the caller used the old direct write. */
export function isLinkRpcRequiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && /link_rpc_required/i.test(message)) return true;
  return code === '42501';
}

// Probes against thrown/transport errors, in priority order.
const THROWN_ERROR_PROBES: Array<{ match: RegExp; status: ContactLinkFailureStatus }> = [
  { match: /link_rpc_required/i, status: 'LINK_RPC_REQUIRED' },
  { match: /rate[_ ]?limit/i, status: 'RATE_LIMITED' },
  { match: /duplicate|already linked|23505/i, status: 'DUPLICATE_LINKED_CONTACT' },
  { match: /not authenticated|jwt|28000/i, status: 'NOT_AUTHENTICATED' },
  { match: /network|failed to fetch|load failed|timeout/i, status: 'NETWORK' },
];

/** Maps an error thrown by the transport (or by an older function) into the
 *  same vocabulary, so the UI has one code path either way. */
export function linkStatusFromThrown(err: unknown): ContactLinkFailureStatus {
  if (isLinkRpcRequiredError(err)) return 'LINK_RPC_REQUIRED';
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && /network/i.test(err) ? 'NETWORK' : 'UNKNOWN';
  }
  if ((err as { code?: unknown }).code === '23505') return 'DUPLICATE_LINKED_CONTACT';
  const raw = (err as { message?: unknown }).message;
  if (typeof raw !== 'string' || !raw) return 'UNKNOWN';
  for (const { match, status } of THROWN_ERROR_PROBES) {
    if (match.test(raw)) return status;
  }
  return 'UNKNOWN';
}

const STATUS_MESSAGE_KEYS: Record<ContactLinkFailureStatus, I18nKey> = {
  NOT_AUTHENTICATED: 'clink_err_auth',
  INVALID_CODE: 'clink_err_invalid_code',
  CONTACT_NOT_FOUND: 'clink_err_contact_missing',
  CONTACT_ARCHIVED: 'clink_err_archived',
  CONTACT_ALREADY_LINKED: 'clink_err_already_linked',
  NO_MATCH: 'clink_err_no_match',
  CANNOT_LINK_SELF: 'clink_err_self',
  DUPLICATE_LINKED_CONTACT: 'contact_dup_link_generic',
  RATE_LIMITED: 'clink_err_rate_limited',
  LINK_RPC_REQUIRED: 'clink_err_code_required',
  NETWORK: 'clink_err_network',
  UNKNOWN: 'clink_err_unknown',
};

/** Which proof the failed call was carrying. Only the copy differs — the
 *  statuses, the parsing and every UI branch are shared. */
export type ContactLinkPath = 'code' | 'discovery';

// Two statuses read as nonsense on the discovery path. NO_MATCH there does not
// mean "wrong code" (there is no code) but "that number isn't theirs any more,
// or they turned discovery off", and the throttle is the phone-lookup budget,
// not the code one. Everything else says the same thing either way.
const DISCOVERY_MESSAGE_KEYS: Partial<Record<ContactLinkFailureStatus, I18nKey>> = {
  NO_MATCH: 'clink_err_discovery_no_match',
  RATE_LIMITED: 'clink_err_discovery_rate_limited',
};

/** i18n key for the message to show for a failed link/unlink. Defaults to the
 *  code path, which is what every non-discovery caller wants. */
export function linkStatusMessageKey(
  status: ContactLinkFailureStatus,
  path: ContactLinkPath = 'code',
): I18nKey {
  if (path === 'discovery') {
    const override = DISCOVERY_MESSAGE_KEYS[status];
    if (override) return override;
  }
  return STATUS_MESSAGE_KEYS[status] ?? 'clink_err_unknown';
}

/** Whole minutes to show in the rate-limit message. Always at least 1, so the
 *  copy never reads "try again in 0 minutes". Defaults to the server's own
 *  one-hour window when it didn't say. */
export function retryAfterMinutes(seconds: number | undefined): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 60;
  return Math.max(1, Math.ceil(seconds / 60));
}

/** One place that turns anything a link/unlink call threw into display copy.
 *  Duck-typed on purpose: a ContactLinkError (which carries `status`) and a
 *  raw transport error both work, and this module stays free of any store
 *  import (personStore imports it, not the other way round). */
export function formatLinkError(
  err: unknown,
  translate: (key: I18nKey) => string,
  path: ContactLinkPath = 'code',
): string {
  let status: ContactLinkFailureStatus | null = null;
  let retryAfterSeconds: number | undefined;
  if (err && typeof err === 'object') {
    const raw = (err as { status?: unknown }).status;
    if (typeof raw === 'string') status = asFailureStatus(raw);
    const retry = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof retry === 'number') retryAfterSeconds = retry;
  }
  const resolved = status ?? linkStatusFromThrown(err);
  return translate(linkStatusMessageKey(resolved, path)).replace(
    '{minutes}',
    String(retryAfterMinutes(retryAfterSeconds)),
  );
}
