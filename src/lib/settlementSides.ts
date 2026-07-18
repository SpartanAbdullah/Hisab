// Which linked-pair row backs a loan, and how a settlement request's sides
// map onto it. The linked_transaction_request row's "requester"/"responder"
// fields are from the POV of whoever sent the ORIGINAL loan request — not the
// settlement — so the current user's loan id always becomes the settlement's
// requesterLoanId and the mirrored id the responder's. Extracted from
// SettleLinkedLoanModal so the bulk settlement path can't drift from the
// single-loan one.

export interface LinkedPairLike {
  id: string;
  status: string;
  requesterLoanId?: string | null;
  responderLoanId?: string | null;
  fromUserId: string;
  toUserId: string;
}

export interface SettlementSides {
  loanPairId: string;
  requesterLoanId: string;
  responderLoanId: string;
  toUserId: string;
}

export function resolveSettlementSides(loanId: string, requests: LinkedPairLike[]): SettlementSides | null {
  const pair = requests.find(
    (r) => r.status === 'accepted' && (r.requesterLoanId === loanId || r.responderLoanId === loanId),
  );
  if (!pair || !pair.requesterLoanId || !pair.responderLoanId) return null;
  const meIsRequester = pair.requesterLoanId === loanId;
  return {
    loanPairId: pair.id,
    requesterLoanId: loanId,
    responderLoanId: meIsRequester ? pair.responderLoanId : pair.requesterLoanId,
    toUserId: meIsRequester ? pair.toUserId : pair.fromUserId,
  };
}
