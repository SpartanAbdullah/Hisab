// Maps the record_group_settlement RPC's result envelope onto i18n copy.
//
// The settlement cap used to be a client-side check between two reads and an
// insert (splitStore.ts, audit 12-qa-review.md F-7): two devices recording the
// same repayment both passed it and the pair over-settled. The cap now lives
// in the database (supabase-migration-audit-p0-group-concurrency.sql) and, in
// the repo's established style for hardened RPCs (leave_group,
// join_group_by_code), failures come back as DATA — `{success, reason_code,
// user_message}` — not as a Postgres exception whose raw text would reach the
// user (audit 08-notifications.md N-13).
//
// Pure so it can be unit-tested; the translator is injected.

import type { I18nKey } from './i18n';
import { formatMoney } from './constants';

export type SettlementReasonCode =
  | 'SETTLEMENT_RECORDED'
  | 'ALREADY_RECORDED'
  | 'NOT_AUTHENTICATED'
  | 'NOT_ACTIVE_MEMBER'
  | 'INVALID_PARTICIPANTS'
  | 'INVALID_AMOUNT'
  | 'ALREADY_SETTLED'
  | 'EXCEEDS_OUTSTANDING';

export interface RecordSettlementResult {
  success?: boolean;
  reason_code?: string;
  user_message?: string;
  settlement_id?: string;
  cap?: number | string;
  currency?: string;
  amount?: number | string;
}

const MESSAGE_KEYS: Record<string, I18nKey> = {
  NOT_AUTHENTICATED: 'grp_settle_signin',
  NOT_ACTIVE_MEMBER: 'grp_settle_not_member',
  INVALID_PARTICIPANTS: 'grp_settle_invalid_participants',
  INVALID_AMOUNT: 'grp_settle_invalid_amount',
  ALREADY_SETTLED: 'grp_settle_already_settled',
  EXCEEDS_OUTSTANDING: 'grp_settle_exceeds',
};

export function isSettlementSuccess(result: RecordSettlementResult | null | undefined): boolean {
  return Boolean(result?.success);
}

/** User-facing failure text for a non-success RPC envelope. Never returns the
 *  server's raw `user_message` — that string is English-only and the app is
 *  Urdu-default; it is used only as a last resort for an unknown code. */
export function settlementFailureMessage(
  result: RecordSettlementResult | null | undefined,
  t: (key: I18nKey) => string,
): string {
  const code = (result?.reason_code ?? '').toUpperCase();
  const key = MESSAGE_KEYS[code];
  if (!key) {
    return (result?.user_message ?? '').trim() || t('grp_settle_failed');
  }
  if (code !== 'EXCEEDS_OUTSTANDING') return t(key);

  const rawCap = result?.cap;
  const cap = typeof rawCap === 'number' ? rawCap : Number(rawCap);
  if (!Number.isFinite(cap)) return t('grp_settle_already_settled');
  return t(key).replace('{amount}', formatMoney(cap, result?.currency || 'PKR'));
}
