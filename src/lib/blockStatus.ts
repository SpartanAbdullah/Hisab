// ───────────────────────────────────────────────────────────────────────────
// Block / report — the pure half.
//
// Audit 2026-09 M17, shipped server-side in supabase-migration-p2-trust-safety
// (see docs/trust-and-safety.md). Everything in this file is deliberately
// side-effect free so it can be unit-tested in Node: error→outcome mapping,
// the input caps the DB triggers enforce, and the client-side "hide inbound
// items from people I blocked" filter.
//
// THE ONE RULE THAT SHAPES THIS FILE (doc RULE 1): a block is one-sided and
// SILENT. `public.blocks` has no SELECT policy naming `blocked_id`, and
// `is_blocked_either_way` / `has_blocked` are revoked from `authenticated`, so
// there is no way — and must never be a way — for the client to ask "has this
// person blocked me?". Every helper here answers only the question the BLOCKER
// is allowed to ask: "have *I* blocked them?".
// ───────────────────────────────────────────────────────────────────────────

/** Where a report was raised from. Matches docs/trust-and-safety.md §4.2. */
export type ReportContextType =
  | 'inbox_item'
  | 'contact'
  | 'group_member'
  | 'group_expense'
  | 'kameti';

export const REPORT_REASONS = [
  'harassment',
  'spam',
  'impersonation',
  'wrong_amounts',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

// Server-side caps (tg_reports_validate / tg_blocks_normalize). Mirrored here
// so the UI can trim before sending instead of relying on a silent truncation.
export const BLOCK_REASON_MAX = 500;
export const REPORT_REASON_MAX = 128;
export const REPORT_DETAILS_MAX = 2000;
export const REPORT_CONTEXT_TYPE_MAX = 64;
export const REPORT_CONTEXT_ID_MAX = 128;

/** Trim, collapse empty-to-null, and cap — exactly what the triggers do. */
export function normalizeFreeText(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

// ── Error mapping ──────────────────────────────────────────────────────────

/** PostgREST/PostgREST-wrapped Postgres error code, when there is one. */
export function pgErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function errorText(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const o = err as { message?: unknown; details?: unknown; hint?: unknown };
    return [o.message, o.details, o.hint].filter((x) => typeof x === 'string').join(' ');
  }
  return '';
}

export type BlockOutcome = 'ok' | 'ALREADY_BLOCKED' | 'SELF' | 'FAILED';

/**
 * Blocking is a plain INSERT whose PK is the pair, so a repeat block collides
 * (23505) — that is a SUCCESS from the user's point of view, not an error.
 * A self-block trips the CHECK (23514).
 */
export function blockOutcomeFromError(err: unknown): BlockOutcome {
  if (!err) return 'ok';
  const code = pgErrorCode(err);
  if (code === '23505') return 'ALREADY_BLOCKED';
  if (code === '23514') return 'SELF';
  const text = errorText(err).toLowerCase();
  if (text.includes('duplicate key')) return 'ALREADY_BLOCKED';
  if (text.includes('blocks_not_self')) return 'SELF';
  return 'FAILED';
}

export type ReportOutcome = 'ok' | 'RATE_LIMITED' | 'SELF' | 'NOT_ALLOWED' | 'FAILED';

/**
 * tg_reports_validate raises 53400 for the 20/day cap, 22023 for a self-report
 * and 42501 for a spoofed reporter_id. The cap is a calm message, not an error
 * toast (docs/trust-and-safety.md §4.2).
 */
export function reportOutcomeFromError(err: unknown): ReportOutcome {
  if (!err) return 'ok';
  const code = pgErrorCode(err);
  if (code === '53400') return 'RATE_LIMITED';
  if (code === '22023') return 'SELF';
  if (code === '42501') return 'NOT_ALLOWED';
  const text = errorText(err).toUpperCase();
  if (text.includes('REPORT_RATE_LIMITED')) return 'RATE_LIMITED';
  return 'FAILED';
}

// ── Client-side filtering ──────────────────────────────────────────────────

/**
 * True when the current user has blocked `userId`. Reads MY block list only —
 * never an inference about who blocked me.
 */
export type BlockedIds = ReadonlySet<string> | readonly string[];

/** Normalise either accepted shape to a Set, without copying one that already is. */
function toBlockedSet(ids: BlockedIds): ReadonlySet<string> {
  if (Array.isArray(ids)) return new Set(ids as readonly string[]);
  return ids as ReadonlySet<string>;
}

export function isBlockedByMe(blockedIds: BlockedIds, userId: string | null | undefined): boolean {
  if (!userId) return false;
  return toBlockedSet(blockedIds).has(userId);
}

/**
 * Drop inbound items whose sender I have blocked.
 *
 * The server already refuses NEW requests from a blocked pair, but RULE 3 says
 * a block is not a deletion: anything that arrived BEFORE the block is still in
 * the table and would otherwise keep sitting in the inbox forever. Filtering at
 * the render site (rather than in the request stores, which other work owns and
 * which also feed the Outgoing tab) keeps this purely cosmetic and reversible —
 * unblocking brings the rows straight back.
 *
 * Outgoing items are deliberately NOT filtered: those are the user's own asks,
 * and hiding them would make a request they sent look like it vanished.
 */
export function hideBlockedSenders<T>(
  items: readonly T[],
  blockedIds: BlockedIds,
  senderOf: (item: T) => string | null | undefined,
): T[] {
  const set = toBlockedSet(blockedIds);
  if (set.size === 0) return [...items];
  return items.filter((item) => {
    const sender = senderOf(item);
    return !sender || !set.has(sender);
  });
}

// ── Witness initials preview (mirrors public.witness_initials) ──────────────

/**
 * "Ali Raza" → "A.R." · "Ali" → "A." · "" → "—".
 *
 * A client-side twin of the SQL function so the kameti settings toggle can show
 * a live preview without a round trip. At most two initials, same as the server
 * — if these two ever disagree the preview is a lie, so keep them in step.
 */
export function witnessInitials(name: string | null | undefined): string {
  const clean = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '—';
  const parts = clean.split(' ');
  let out = `${parts[0].charAt(0).toUpperCase()}.`;
  if (parts.length > 1 && parts[1]) out += `${parts[1].charAt(0).toUpperCase()}.`;
  return out;
}

// ── Witness link lifecycle ─────────────────────────────────────────────────

export type WitnessLinkState = 'none' | 'active' | 'revoked' | 'expired';

/**
 * What the organiser's share card should say. `expiresAt` is null until a token
 * has ever been minted; the p2 migration nulls `committees.share_token`, so a
 * committee that had a plaintext link before the migration still reports
 * `active` (the link works) even though the app can no longer display it.
 */
export function witnessLinkState(
  input: { expiresAt?: string | null; revokedAt?: string | null },
  now: Date = new Date(),
): WitnessLinkState {
  if (input.revokedAt) return 'revoked';
  if (!input.expiresAt) return 'none';
  const expires = new Date(input.expiresAt).getTime();
  if (Number.isNaN(expires)) return 'none';
  return expires > now.getTime() ? 'active' : 'expired';
}
