// Bridges a parsed natural-language draft to a real transaction input.
// Pure — it never posts; the AI tab calls processTransaction with the result
// only after the user taps Confirm on the chip.

import type { Account } from '../db';
import type { ParsedExpense } from './nlExpenseParser';
import type { TransactionInput } from '../stores/transactionStore';

/**
 * Choose the account a draft should post against: prefer one whose currency
 * matches the parsed/assumed currency, else the first account. Null when the
 * user has no accounts (the UI then guides them to add one).
 */
export function pickAccountForDraft(
  draft: Pick<ParsedExpense, 'currency'>,
  accounts: Account[],
): Account | null {
  if (accounts.length === 0) return null;
  if (draft.currency) {
    const match = accounts.find((a) => a.currency === draft.currency);
    if (match) return match;
  }
  return accounts[0];
}

/**
 * Map a confirmed draft + chosen account into a TransactionInput ready for
 * processTransaction. Returns null when there is no postable amount.
 *
 * Note: expense/income inputs carry NO currency of their own — the ledger uses
 * the account's currency. So the parsed currency only steers account selection
 * upstream (pickAccountForDraft); it is intentionally not forwarded here.
 * The merchant/description rides in `notes`; `category` passes through when known.
 */
export function buildTransactionFromDraft(
  draft: Pick<ParsedExpense, 'amount' | 'direction' | 'category' | 'label'>,
  account: Account,
): TransactionInput | null {
  if (draft.amount === null || draft.amount <= 0) return null;
  const amount = draft.amount;
  const category = draft.category ?? '';
  // Keep notes meaningful: drop it when the label is just an echo of the
  // category (e.g. label "Rent" + category "Rent").
  const labelIsEcho =
    !!draft.category && draft.label.trim().toLowerCase() === draft.category.toLowerCase();
  const notes = draft.label && !labelIsEcho ? draft.label : '';

  if (draft.direction === 'income') {
    return { type: 'income', amount, destinationAccountId: account.id, category, notes };
  }
  return { type: 'expense', amount, sourceAccountId: account.id, category, notes };
}
