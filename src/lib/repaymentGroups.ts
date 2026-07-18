// Build the person(+currency) groups the repayment step offers as payment
// targets. A person who borrowed several times is ONE thing to pay back, so
// the group — not the individual loan line — is the primary unit; the split
// between `allocatable` and `linked` loans decides what a lump payment may
// touch (linked loans settle via the cross-user confirm flow instead).
// Pure so the grouping rules stay unit-tested and identical across surfaces.

import type { Currency, Loan } from '../db';

export interface RepaymentGroup {
  key: string; // `${direction}:${currency}:${personId ?? lowercased name}` — LoansPage's group key rule
  name: string;
  currency: Currency;
  direction: 'given' | 'taken';
  loans: Loan[]; // every active loan in the group, remaining desc
  allocatable: Loan[]; // non-linked with real remaining — what a lump may touch
  linked: Loan[]; // mirrored to another user — settle via their loan page
  allocatableRemaining: number;
  totalRemaining: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildRepaymentGroups(args: {
  loans: Loan[];
  direction: 'received' | 'paid'; // received → their 'given' loans; paid → your 'taken' ones
  linkedLoanIds: Set<string>;
  personIdFilter?: string | null; // locked-contact preset narrows to one person
  query?: string; // matches person name or loan note
}): RepaymentGroup[] {
  const loanType = args.direction === 'received' ? 'given' : 'taken';
  const query = (args.query ?? '').trim().toLowerCase();

  const filtered = args.loans.filter((l) => {
    if (l.status !== 'active') return false;
    if (l.type !== loanType) return false;
    if (args.personIdFilter && l.personId !== args.personIdFilter) return false;
    if (query && !l.personName.toLowerCase().includes(query) && !(l.notes ?? '').toLowerCase().includes(query)) return false;
    return true;
  });

  const buckets = new Map<string, RepaymentGroup>();
  for (const l of filtered) {
    const personKey = l.personId ?? l.personName.trim().toLowerCase();
    // Direction is part of the key: with no direction filter upstream a person
    // could have groups on both sides, and those must never merge.
    const key = `${loanType}:${l.currency}:${personKey}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        name: l.personName,
        currency: l.currency,
        direction: loanType,
        loans: [],
        allocatable: [],
        linked: [],
        allocatableRemaining: 0,
        totalRemaining: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.loans.push(l);
    bucket.totalRemaining = round2(bucket.totalRemaining + l.remainingAmount);
    if (args.linkedLoanIds.has(l.id)) {
      bucket.linked.push(l);
    } else if (l.remainingAmount > 0.01) {
      bucket.allocatable.push(l);
      bucket.allocatableRemaining = round2(bucket.allocatableRemaining + l.remainingAmount);
    }
  }

  const groups = [...buckets.values()];
  for (const g of groups) {
    g.loans.sort((a, b) => b.remainingAmount - a.remainingAmount);
    g.allocatable.sort((a, b) => b.remainingAmount - a.remainingAmount);
  }
  return groups.sort((a, b) => b.totalRemaining - a.totalRemaining);
}
