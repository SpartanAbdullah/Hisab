// Phase 2B: decide whether a new loan entry should be saved locally (existing
// path) or branched into a linked_transaction_request.
//
// Branching rule: the picked contact is linked to another Hisaab user and the
// entry type is loan_given or loan_taken. No cross-currency gate: Phase 2B
// mirrors record only the obligation (no balance movement, account ids are
// null at accept time), so the sender's / receiver's account currencies don't
// constrain acceptance. Cross-currency handling re-enters the design when
// balance movement returns in a later phase.

import type { Currency, LinkedRequestKind, Person } from '../db';

export type BranchDecision =
  | { branch: false }
  | { branch: true; kind: LinkedRequestKind; toUserId: string; personId: string; currency: Currency };

export function decideLinkedBranch(input: {
  type: 'loan_given' | 'loan_taken';
  person: Person | null | undefined;
  requestCurrency: Currency | null | undefined;
}): BranchDecision {
  const { type, person, requestCurrency } = input;
  if (!person || !person.linkedProfileId) return { branch: false };
  if (!requestCurrency) return { branch: false };

  return {
    branch: true,
    kind: type === 'loan_given' ? 'lent' : 'borrowed',
    toUserId: person.linkedProfileId,
    personId: person.id,
    currency: requestCurrency,
  };
}
