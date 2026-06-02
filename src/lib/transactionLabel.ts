import type { Transaction, Loan, Account, Goal } from "../db";
import type { useT } from "./i18n";

// Match the exact key set that the i18n `t` function accepts so callers
// can pass their hook result directly without casting.
type TFn = ReturnType<typeof useT>;

interface Opts {
  personName?: string | null;
  loan?: Loan | null;
  sourceAccount?: Account | null;
  destinationAccount?: Account | null;
  goal?: Goal | null;
}

// Single source of truth for how an entry reads back to the user.
// Past-tense, direction-aware, plain English. Apply at TransactionItem,
// ContactDetailSheet history, EditTransactionModal header, and anywhere
// else the previous code did `transaction.type.replace(/_/g, ' ')`.
export function getActionLabel(
  transaction: Pick<
    Transaction,
    "type" | "sourceAccountId" | "destinationAccountId" | "relatedPerson" | "relatedLoanId"
  >,
  t: TFn,
  opts: Opts = {},
): string {
  const person = opts.personName ?? transaction.relatedPerson ?? null;

  switch (transaction.type) {
    case "expense":
      return t("action_spent");
    case "income":
      return t("action_received");
    case "transfer":
      return t("action_moved");
    case "loan_given":
      return person
        ? t("action_gave").replace("{person}", person)
        : t("action_gave_noperson");
    case "loan_taken":
      return person
        ? t("action_borrowed").replace("{person}", person)
        : t("action_borrowed_noperson");
    case "repayment": {
      // Direction: prefer linked-loan type when available; fall back to
      // which slot carries the money. Repayment on a `given` loan flows
      // INTO the user (destinationAccountId set); on a `taken` loan it
      // flows OUT (sourceAccountId set).
      const dir: "received" | "paid" = opts.loan?.type === "given"
        ? "received"
        : opts.loan?.type === "taken"
          ? "paid"
          : transaction.destinationAccountId
            ? "received"
            : "paid";
      if (dir === "received") {
        return person
          ? t("action_they_paid_back").replace("{person}", person)
          : t("action_they_paid_back_noperson");
      }
      return person
        ? t("action_i_paid_back").replace("{person}", person)
        : t("action_i_paid_back_noperson");
    }
    case "goal_contribution":
      return opts.goal?.title
        ? t("action_saved_goal").replace("{goal}", opts.goal.title)
        : t("action_saved_goal_nogoal");
    case "opening_balance":
      return t("action_opening_balance");
    default:
      return transaction.type;
  }
}

// Compact one-line subtitle for a transaction row: just the friendly
// direction + person, no amount (amount is rendered separately). Useful
// when callers want a denser two-line layout.
export function getActionSubtitle(
  transaction: Pick<
    Transaction,
    "type" | "sourceAccountId" | "destinationAccountId" | "relatedPerson" | "relatedLoanId"
  >,
  t: TFn,
  opts: Opts = {},
): string {
  if (transaction.type === "transfer") {
    const src = opts.sourceAccount?.name;
    const dst = opts.destinationAccount?.name;
    if (src && dst) return `${src} → ${dst}`;
  }
  return getActionLabel(transaction, t, opts);
}
