// Which past-record loans may be offered for "Sync past records" with a linked
// contact — and, critically, which may NOT because they're already shared.
//
// Offering an already-shared loan for sync again creates a duplicate linked
// request and leaves both users' ledgers ambiguous (the reported "keeps asking
// to sync again" bug). A loan counts as already-shared when ANY live (non
// cancelled / non-rejected) request references it, OR the loan itself is
// already linked. Pure + tested; the store selector is a thin wrapper.

import type { Loan, LinkedRequest } from '../db';
import { isLinkedLoan } from './linkedLoanGuards';

type LinkedRequestLink = Pick<
  LinkedRequest,
  'status' | 'preExistingLoanId' | 'requesterLoanId' | 'responderLoanId'
>;

/**
 * Loan ids that are already shared with the other user and must be excluded
 * from a fresh sync. Three signals, any of which blocks:
 *  - `preExistingLoanId` — a "sync past record" request already references it
 *    (mid-sync or synced);
 *  - `requesterLoanId` / `responderLoanId` — the loan is one half of a mirrored
 *    pair. This survives even when `loans.loan_pair_id` isn't backfilled
 *    server-side, and it's what catches the recipient's mirrored copy (the
 *    two-user ping-pong) and loans linked via the normal fresh-loan branch.
 * Cancelled / rejected requests free the slot so the user can retry.
 */
export function alreadySharedLoanIds(requests: LinkedRequestLink[]): Set<string> {
  const ids = new Set<string>();
  for (const r of requests) {
    if (r.status === 'cancelled' || r.status === 'rejected') continue;
    if (r.preExistingLoanId) ids.add(r.preExistingLoanId);
    if (r.requesterLoanId) ids.add(r.requesterLoanId);
    if (r.responderLoanId) ids.add(r.responderLoanId);
  }
  return ids;
}

/**
 * Loans belonging to `personId` that are eligible to be synced right now:
 * active, still owed, not already linked, and not already shared via a live
 * request. Currency support (AED/PKR only) is applied by the caller so it can
 * split the remainder into a "skipped" bucket for the UI.
 */
export function syncCandidateLoans(
  personId: string,
  loans: Loan[],
  requests: LinkedRequestLink[],
): Loan[] {
  const blocked = alreadySharedLoanIds(requests);
  return loans.filter(
    (l) =>
      l.personId === personId &&
      l.status === 'active' &&
      l.remainingAmount > 0.01 &&
      !isLinkedLoan(l) &&
      !blocked.has(l.id),
  );
}
