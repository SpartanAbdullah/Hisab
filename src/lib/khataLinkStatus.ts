// Khata-link result contract (audit 2026-09, P3 item L2 / 11-competitive O2+G3).
//
// supabase-migration-p3-khata-link.sql adds three RPCs:
//
//   create_khata_link(p_person_id TEXT, p_initials_only BOOLEAN) -> JSONB
//   revoke_khata_link(p_person_id TEXT)                          -> JSONB
//   get_khata_view(p_token TEXT)                                 -> JSON | NULL
//
// The first two are owner-only and return a STATUS OBJECT rather than raising
// on a business outcome — same reasoning as contactLinkStatus.ts, whose shape
// this module deliberately mirrors: a raise would roll the whole call back,
// and these functions revoke a previous row before minting a new one.
//
// `get_khata_view` is the odd one out: it is anon-callable and answers with one
// uniform NULL for EVERY refusal (unknown / revoked / expired / owner deleted /
// blocked pair / rate-limited). That is a deliberate server-side decision — a
// status vocabulary there would be an oracle — so there is nothing to narrow on
// the failure side, only a shape to validate on the success side.
//
// Migrations here are applied by hand, so a client build can meet a database
// that does not have this file yet. A missing function (PostgREST PGRST202)
// therefore has its own status, and the ONLY correct UI for it is "sharing
// isn't available yet" — there is no legacy path to fall back to, because the
// feature did not exist before.
//
// Pure + colocated test; no React, no supabase import.
import type { I18nKey } from './i18n';
import { buildAppShareUrl } from './collaboration';
import type { Currency, Loan, Transaction } from '../db';

/** Every non-success outcome the owner-side (create/revoke) calls can surface. */
export type KhataLinkFailureStatus =
  /** No session, or the profile is soft-deleted. */
  | 'NOT_AUTHENTICATED'
  /** p_person_id is not one of the caller's contacts (or does not exist). */
  | 'NOT_FOUND'
  /** The contact is archived; unarchive before sharing a khata link. */
  | 'CONTACT_ARCHIVED'
  /** supabase-migration-p3-khata-link.sql is not applied to this database. */
  | 'RPC_MISSING'
  | 'NETWORK'
  | 'UNKNOWN';

export interface KhataLinkCreated {
  status: 'ok';
  /** The RAW token. The server returns it exactly once and never stores it —
   *  if this is dropped, the only recovery is to create again (which revokes
   *  the link just minted). Never persist it anywhere but the share sheet. */
  token: string;
  url: string;
  expiresAt: string;
  initialsOnly: boolean;
  /** Off by default. When true, get_khata_view includes this contact's
   *  loan/transaction notes (still capped at 140 chars server-side); when
   *  false every note the public page receives is null. */
  showNotes: boolean;
  /** True when an earlier link for this contact was revoked to make room. */
  replacedPrevious: boolean;
}

export type KhataLinkCreateResult = KhataLinkCreated | { status: KhataLinkFailureStatus };

export type KhataLinkRevokeResult =
  | { status: 'ok'; wasActive: boolean }
  | { status: KhataLinkFailureStatus };

const FAILURE_STATUSES: readonly KhataLinkFailureStatus[] = [
  'NOT_AUTHENTICATED',
  'NOT_FOUND',
  'CONTACT_ARCHIVED',
  'RPC_MISSING',
  'NETWORK',
  'UNKNOWN',
];

function asFailureStatus(raw: string): KhataLinkFailureStatus | null {
  const upper = raw.trim().toUpperCase();
  return FAILURE_STATUSES.find((status) => status === upper) ?? null;
}

function unwrapRow(data: unknown): Record<string, unknown> | null {
  // PostgREST hands a jsonb-returning RPC back as the object itself, but a
  // RETURNS TABLE (or a `.select()` on it) arrives as an array of rows.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  return row as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A khata token is exactly 64 lowercase hex characters — the same shape the
 *  server's own guard checks before it hashes anything. Validating it here
 *  means a mistyped URL never costs a round trip (and never charges the
 *  server's miss ledger). */
export function isKhataToken(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw);
}

/** The public URL for a minted token. Mirrors buildInviteUrl's shape; falls
 *  back to a root-relative path when no origin is configured (SSR, tests). */
export function buildKhataLinkUrl(token: string, baseUrl?: string): string {
  const base = (baseUrl ?? buildAppShareUrl()).replace(/\/+$/, '');
  return base ? `${base}/khata/${token}` : `/khata/${token}`;
}

/** Narrows whatever `rpc('create_khata_link')` returned. */
export function parseCreateKhataLinkResponse(
  data: unknown,
  baseUrl?: string,
): KhataLinkCreateResult {
  const row = unwrapRow(data);
  if (!row) return { status: 'UNKNOWN' };

  const rawStatus = row.status;
  if (typeof rawStatus !== 'string') return { status: 'UNKNOWN' };
  if (rawStatus.trim().toLowerCase() !== 'ok') {
    return { status: asFailureStatus(rawStatus) ?? 'UNKNOWN' };
  }

  const token = readString(row.token);
  // A success we cannot read is not a success: handing the user a share sheet
  // with a broken URL is worse than an honest error.
  if (!isKhataToken(token)) return { status: 'UNKNOWN' };

  return {
    status: 'ok',
    token,
    url: buildKhataLinkUrl(token, baseUrl),
    expiresAt: readString(row.expires_at),
    initialsOnly: row.initials_only === true,
    showNotes: row.show_notes === true,
    replacedPrevious: row.replaced_previous === true,
  };
}

/** Narrows whatever `rpc('revoke_khata_link')` returned. */
export function parseRevokeKhataLinkResponse(data: unknown): KhataLinkRevokeResult {
  const row = unwrapRow(data);
  if (!row) return { status: 'UNKNOWN' };

  const rawStatus = row.status;
  if (typeof rawStatus !== 'string') return { status: 'UNKNOWN' };
  if (rawStatus.trim().toLowerCase() !== 'ok') {
    return { status: asFailureStatus(rawStatus) ?? 'UNKNOWN' };
  }
  return { status: 'ok', wasActive: row.was_active === true };
}

/** True when the RPC itself is absent — i.e. this database has not had
 *  supabase-migration-p3-khata-link.sql applied yet. */
export function isMissingKhataRpcError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && (code === 'PGRST202' || code === '42883')) return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return /could not find the function|function .* does not exist|schema cache/i.test(message);
}

// Probes against thrown/transport errors, in priority order.
const THROWN_ERROR_PROBES: Array<{ match: RegExp; status: KhataLinkFailureStatus }> = [
  { match: /khata_link_is_server_only/i, status: 'RPC_MISSING' },
  { match: /not authenticated|jwt|28000/i, status: 'NOT_AUTHENTICATED' },
  { match: /network|failed to fetch|load failed|timeout/i, status: 'NETWORK' },
];

/** Maps an error thrown by the transport into the same vocabulary, so the UI
 *  has one code path either way. */
export function khataStatusFromThrown(err: unknown): KhataLinkFailureStatus {
  if (isMissingKhataRpcError(err)) return 'RPC_MISSING';
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && /network/i.test(err) ? 'NETWORK' : 'UNKNOWN';
  }
  const raw = (err as { message?: unknown }).message;
  if (typeof raw !== 'string' || !raw) return 'UNKNOWN';
  for (const { match, status } of THROWN_ERROR_PROBES) {
    if (match.test(raw)) return status;
  }
  return 'UNKNOWN';
}

const STATUS_MESSAGE_KEYS: Record<KhataLinkFailureStatus, I18nKey> = {
  NOT_AUTHENTICATED: 'clink_err_auth',
  NOT_FOUND: 'clink_err_contact_missing',
  CONTACT_ARCHIVED: 'clink_err_archived',
  RPC_MISSING: 'khata_err_unavailable',
  NETWORK: 'clink_err_network',
  UNKNOWN: 'khata_err_unknown',
};

export function khataStatusMessageKey(status: KhataLinkFailureStatus): I18nKey {
  return STATUS_MESSAGE_KEYS[status] ?? 'khata_err_unknown';
}

/** One place that turns anything a create/revoke call threw into display copy.
 *  Duck-typed on purpose: a rejected result object (which carries `status`) and
 *  a raw transport error both work. */
export function formatKhataError(err: unknown, translate: (key: I18nKey) => string): string {
  let status: KhataLinkFailureStatus | null = null;
  if (err && typeof err === 'object') {
    const raw = (err as { status?: unknown }).status;
    if (typeof raw === 'string') status = asFailureStatus(raw);
  }
  return translate(khataStatusMessageKey(status ?? khataStatusFromThrown(err)));
}

// ── The public view ─────────────────────────────────────────────────────────
// get_khata_view's projection, narrowed. The page feeds `loans` and
// `transactions` straight into buildStatement (src/lib/statementOfAccount.ts),
// which is the SAME engine the in-app statement uses — one engine, so the
// public page and the owner's own statement can never disagree about what was
// paid, in either app mode.

export interface KhataNetBalance {
  currency: Currency;
  balance: number; // signed: POSITIVE = the person owes the owner
}

export interface KhataView {
  ownerName: string;
  personName: string;
  initialsOnly: boolean;
  /** False means the owner has not opted in — every `notes` field below is
   *  null, and the page should say so rather than render a silent gap. */
  showNotes: boolean;
  expiresAt: string;
  asOf: string;
  net: KhataNetBalance[];
  loans: Loan[];
  transactions: Transaction[];
}

function readNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [];
}

/** Narrows whatever `rpc('get_khata_view')` returned. NULL — the server's one
 *  uniform refusal — and any payload we cannot read both become null, so the
 *  page has exactly one "this link isn't valid" state. */
export function parseKhataView(data: unknown, fallbackPersonName = ''): KhataView | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;

  const owner = (row.owner ?? {}) as Record<string, unknown>;
  const person = (row.person ?? {}) as Record<string, unknown>;
  const ownerName = readString(owner.name).trim();
  const personName = readString(person.name).trim() || fallbackPersonName;
  // Without a party name there is no khata to render — treat it as invalid
  // rather than shipping a page addressed to nobody.
  if (!ownerName || !personName) return null;

  const loans: Loan[] = asArray(row.loans).map((l) => ({
    id: readString(l.id),
    // Not part of the projection (it would be a second copy of the same name);
    // buildStatement never reads it, and the page shows `personName` instead.
    personName,
    personId: null,
    type: readString(l.type) === 'taken' ? 'taken' : 'given',
    totalAmount: readNumber(l.totalAmount),
    remainingAmount: readNumber(l.remainingAmount),
    currency: readString(l.currency) as Currency,
    status: readString(l.status) === 'settled' ? 'settled' : 'active',
    notes: readString(l.notes),
    createdAt: readString(l.createdAt),
    updatedAt: readString(l.updatedAt) || undefined,
  }));

  const transactions: Transaction[] = asArray(row.transactions).map((t) => ({
    id: readString(t.id),
    type: readString(t.type) as Transaction['type'],
    amount: readNumber(t.amount),
    currency: readString(t.currency) as Currency,
    // Both app modes: a splits_only ledger row legitimately has BOTH account
    // ids null, and the projection never carried them anyway.
    sourceAccountId: null,
    destinationAccountId: null,
    relatedPerson: personName,
    relatedLoanId: readString(t.relatedLoanId) || null,
    relatedGoalId: null,
    conversionRate: null,
    category: '',
    notes: readString(t.notes),
    createdAt: readString(t.createdAt),
  }));

  const net: KhataNetBalance[] = asArray(row.net).map((n) => ({
    currency: readString(n.currency) as Currency,
    balance: readNumber(n.balance),
  }));

  return {
    ownerName,
    personName,
    initialsOnly: row.initialsOnly === true,
    showNotes: row.showNotes === true,
    expiresAt: readString(row.expiresAt),
    asOf: readString(row.asOf) || new Date().toISOString(),
    net,
    loans: loans.filter((l) => l.id),
    transactions: transactions.filter((t) => t.id && t.relatedLoanId),
  };
}

/** Whole days until a link expires, floored at 0. Drives the "expires in N
 *  days" line on the share sheet and the public page. */
export function daysUntilExpiry(expiresAt: string, now: number = Date.now()): number {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - now) / (24 * 60 * 60 * 1000)));
}

// ── Share-at-save nudge memory (audit 2026-09 P3 L2) ───────────────────────
// After a loan is recorded, AddLoanModal/QuickEntry offer "Share their khata
// link". Nagging on every single loan for the same person is worse than not
// offering at all, so once the nudge has been shown for a person it goes
// quiet for NUDGE_SNOOZE_DAYS regardless of whether they tapped it — the
// "not now" is implicit in having already been shown, not a separate choice.
// Device-local (localStorage) and best-effort: a storage failure means the
// nudge just offers again next time, never that it breaks the save flow.
const NUDGE_KEY_PREFIX = 'hisaab_khata_nudge_snoozed_until:';
const NUDGE_SNOOZE_DAYS = 14;

function nudgeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** True when this person hasn't been offered the nudge in the last
 *  NUDGE_SNOOZE_DAYS (or ever). */
export function shouldOfferKhataShareNudge(personId: string, now: number = Date.now()): boolean {
  if (!personId) return false;
  try {
    const raw = nudgeStorage()?.getItem(NUDGE_KEY_PREFIX + personId);
    if (!raw) return true;
    const until = Number(raw);
    return !Number.isFinite(until) || now >= until;
  } catch {
    return true;
  }
}

/** Record that the nudge was just shown for this person — quiets it for
 *  NUDGE_SNOOZE_DAYS. Call this the moment the nudge is shown, not only when
 *  it's accepted. */
export function snoozeKhataShareNudge(personId: string, now: number = Date.now()): void {
  if (!personId) return;
  try {
    nudgeStorage()?.setItem(NUDGE_KEY_PREFIX + personId, String(now + NUDGE_SNOOZE_DAYS * 24 * 60 * 60 * 1000));
  } catch {
    // Storage blocked — the nudge just offers again next save. Never throw.
  }
}
