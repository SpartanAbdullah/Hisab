// Did an edit change the money-bearing fields of a group expense (payer,
// amount, or the split shares)? Used to decide whether a RECONCILED (settled)
// expense should reopen — editing those silently changes what people owe.
// Pure + tested.

interface ExpenseShape {
  paidBy: string;
  amount: number;
  splits: ReadonlyArray<{ memberId: string; amount: number }>;
}

export function coreExpenseFieldsChanged(before: ExpenseShape, after: ExpenseShape): boolean {
  if (before.paidBy !== after.paidBy) return true;
  if (Math.abs(before.amount - after.amount) > 0.001) return true;

  const b = new Map(before.splits.map((s) => [s.memberId, s.amount]));
  const a = new Map(after.splits.map((s) => [s.memberId, s.amount]));
  if (b.size !== a.size) return true;
  for (const [memberId, amount] of a) {
    const prev = b.get(memberId);
    if (prev === undefined || Math.abs(prev - amount) > 0.001) return true;
  }
  return false;
}
