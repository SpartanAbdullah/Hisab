// Execute a multi-loan repayment as N ordinary single-loan repayments, one
// per allocation — the model AllocateRepaymentModal proved out. Supabase has
// no cross-loan transaction, so each repayment commits independently: a
// mid-batch failure keeps the committed prefix and the caller reports
// "applied to N of M" honestly (a retry with the remainder recomputes from
// the now-reduced remainings, so double-pay is impossible). Dependencies are
// injected so the loop is unit-testable without Supabase.

export interface RepaymentExecItem {
  loanId: string;
  amount: number;
}

// Structurally matches the store's RepaymentInput so the real
// processTransaction can be passed straight in.
export interface RepaymentTransactionInput {
  type: 'repayment';
  amount: number;
  loanId: string;
  sourceAccountId?: string;
  destinationAccountId?: string;
  emiId?: string;
  conversionRate?: number;
  notes?: string;
}

export interface RepaymentExecDeps {
  mode: 'tracker' | 'splits_only';
  direction: 'given' | 'taken'; // given → money lands in accountId; taken → leaves it
  accountId?: string; // required in tracker mode
  conversionRate?: number; // same per-unit rate stamped on every item
  notes?: string;
  emiIdByLoan?: Record<string, string>;
  processTransaction: (input: RepaymentTransactionInput) => Promise<unknown>;
  applyRepayment: (loanId: string, amount: number) => Promise<void>;
}

export interface RepaymentExecResult {
  total: number;
  done: number;
  applied: RepaymentExecItem[]; // committed prefix, in order
  failed?: { item: RepaymentExecItem; error: unknown }; // first failure; loop stops there
  totalApplied: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function executeAllocatedRepayments(
  items: RepaymentExecItem[],
  deps: RepaymentExecDeps,
): Promise<RepaymentExecResult> {
  const applied: RepaymentExecItem[] = [];
  const sumApplied = () => round2(applied.reduce((a, x) => a + x.amount, 0));

  for (const item of items) {
    try {
      if (deps.mode === 'splits_only') {
        await deps.applyRepayment(item.loanId, item.amount);
      } else {
        await deps.processTransaction({
          type: 'repayment',
          amount: item.amount,
          loanId: item.loanId,
          ...(deps.direction === 'given'
            ? { destinationAccountId: deps.accountId }
            : { sourceAccountId: deps.accountId }),
          emiId: deps.emiIdByLoan?.[item.loanId],
          conversionRate: deps.conversionRate,
          notes: deps.notes,
        });
      }
      applied.push(item);
    } catch (error) {
      return { total: items.length, done: applied.length, applied, failed: { item, error }, totalApplied: sumApplied() };
    }
  }
  return { total: items.length, done: applied.length, applied, totalApplied: sumApplied() };
}
