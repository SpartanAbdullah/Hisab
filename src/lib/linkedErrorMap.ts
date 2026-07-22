// Maps the backend's terse 'lsr:'/'ltr:' RPC error strings to bilingual,
// recovery-oriented copy. The RPCs raise developer-grade messages ("lsr:
// requester account was deleted") that used to surface verbatim in toasts —
// meaningless to users and English-only. authErrorMap precedent. Unknown
// messages pass through untouched so genuine diagnostics stay visible.
import { tStatic, type I18nKey } from './i18n';

const LINKED_ERROR_KEYS: Array<{ match: string; key: I18nKey }> = [
  { match: 'lsr: requester account was deleted', key: 'lsr_err_account_deleted' },
  { match: 'lsr: amount exceeds remaining', key: 'lsr_err_amount_exceeds' },
  { match: 'lsr: loan is no longer active', key: 'lsr_err_loan_inactive' },
  { match: 'lsr: only the target user can accept', key: 'lsr_err_not_target' },
  { match: 'lsr: request not found', key: 'lsr_err_not_found' },
];

export function friendlyLinkedError(raw: string): string {
  for (const { match, key } of LINKED_ERROR_KEYS) {
    if (raw.includes(match)) return tStatic(key);
  }
  return raw;
}
