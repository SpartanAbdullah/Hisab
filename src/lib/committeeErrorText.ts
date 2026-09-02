import { CommitteeDrawError, type CommitteeDrawErrorCode } from './supabaseDb';
import type { I18nKey } from './i18n';

// ───────────────────────────────────────────────────────────────────────────
// Every stable code the kameti server guards can raise — the draw RPC, the
// ballot/slot immutability triggers, and the three post-creation editing RPCs
// (supabase-migration-p2-kameti-editing.sql) — mapped to a sentence.
//
// Exhaustive by construction (`Record` over the whole union), so a code added
// to COMMITTEE_DRAW_ERRORS is a TYPE ERROR here rather than a silent
// fall-through to "couldn't run the draw". It lives in its own module because
// both KametiDetailPage and EditCommitteeSheet surface these, and a second
// copy would drift the moment one of them gained a code.
// ───────────────────────────────────────────────────────────────────────────
export const COMMITTEE_ERROR_KEY: Record<CommitteeDrawErrorCode | 'UNKNOWN', I18nKey> = {
  ALREADY_DRAWN: 'kameti_draw_already',
  DRAW_LOCKED: 'kameti_draw_locked',
  DRAW_FIELDS_ARE_SERVER_ONLY: 'kameti_draw_server_note',
  NOT_ORGANISER: 'kameti_draw_not_organizer',
  NOT_FOUND: 'kameti_draw_failed',
  NOT_ACTIVE: 'kameti_draw_failed',
  NOT_AUTHENTICATED: 'clink_err_auth',
  TOO_FEW_MEMBERS: 'kameti_draw_too_few',
  SLOTS_ALREADY_SET: 'kameti_err_slots_already_set',
  BALLOT_SLOTS_SERVER_ONLY: 'kameti_err_ballot_slots_server_only',
  BALLOT_SWITCH_NEEDS_CLEAR_SLOTS: 'kameti_err_ballot_switch_needs_clear_slots',
  KAMETI_LOCKED_PAYMENTS: 'kameti_err_locked_payments',
  KAMETI_LOCKED_DRAW: 'kameti_err_locked_draw',
  KAMETI_INVALID_PATCH: 'kameti_err_invalid_patch',
  UNKNOWN: 'kameti_draw_failed',
};

/** Anything that is not a recognised committee refusal reads as UNKNOWN. */
export function committeeErrorKey(err: unknown): I18nKey {
  const code = err instanceof CommitteeDrawError ? err.code : 'UNKNOWN';
  return COMMITTEE_ERROR_KEY[code] ?? 'kameti_draw_failed';
}
