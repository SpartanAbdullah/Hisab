// Loans mirrored to another Hisaab user (accepted linked pair) must settle
// through the cross-user confirm flow, so every local repayment surface has
// to exclude them. One shared builder keeps LoansPage, QuickEntry and the
// repayment modals agreeing on which loan ids count as linked.

export interface LinkedRequestLike {
  status: string;
  requesterLoanId?: string | null;
  responderLoanId?: string | null;
}

export function linkedLoanIdSet(requests: LinkedRequestLike[]): Set<string> {
  const ids = new Set<string>();
  for (const r of requests) {
    if (r.status !== 'accepted') continue;
    if (r.requesterLoanId) ids.add(r.requesterLoanId);
    if (r.responderLoanId) ids.add(r.responderLoanId);
  }
  return ids;
}
