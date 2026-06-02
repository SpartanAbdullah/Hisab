import { describe, expect, it } from "vitest";
import { getActionLabel, getActionSubtitle } from "./transactionLabel";
import type { Loan, Account, Transaction, Goal } from "../db";

// Stub `t` that returns the key verbatim (with placeholders intact).
// All assertions match against the literal key strings the label helper
// would request, plus any placeholder substitution it performs locally.
const t = (key: string) => key;

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: "tx-1",
    type: "expense",
    amount: 100,
    currency: "PKR",
    sourceAccountId: null,
    destinationAccountId: null,
    relatedPerson: null,
    relatedLoanId: null,
    relatedGoalId: null,
    conversionRate: null,
    category: "",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Transaction;
}

function makeLoan(overrides: Partial<Loan>): Loan {
  return {
    id: "loan-1",
    personName: "Ali",
    type: "given",
    totalAmount: 1000,
    remainingAmount: 500,
    currency: "PKR",
    status: "active",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Loan;
}

describe("getActionLabel", () => {
  describe("simple types without person interpolation", () => {
    it("expense → 'You spent'", () => {
      expect(getActionLabel(makeTx({ type: "expense" }), t)).toBe("action_spent");
    });
    it("income → 'You received'", () => {
      expect(getActionLabel(makeTx({ type: "income" }), t)).toBe("action_received");
    });
    it("transfer → 'You moved'", () => {
      expect(getActionLabel(makeTx({ type: "transfer" }), t)).toBe("action_moved");
    });
    it("opening_balance → fixed label", () => {
      expect(getActionLabel(makeTx({ type: "opening_balance" }), t)).toBe("action_opening_balance");
    });
  });

  describe("loan_given direction + person interpolation", () => {
    it("with person name interpolates {person}", () => {
      expect(getActionLabel(makeTx({ type: "loan_given" }), t, { personName: "Ali" })).toBe("action_gave");
      // Verify the helper attempted interpolation — our stub `t` returns
      // the key, so the placeholder remains. We re-run with a t-stub that
      // simulates real interpolation.
      const realT = (key: string) => key === "action_gave" ? "You gave to {person}" : key;
      expect(getActionLabel(makeTx({ type: "loan_given" }), realT, { personName: "Ali" }))
        .toBe("You gave to Ali");
    });
    it("without person name falls back to no-person variant", () => {
      expect(getActionLabel(makeTx({ type: "loan_given" }), t)).toBe("action_gave_noperson");
    });
    it("prefers opts.personName over transaction.relatedPerson", () => {
      const tx = makeTx({ type: "loan_given", relatedPerson: "Ahmed" });
      const realT = (key: string) => key === "action_gave" ? "You gave to {person}" : key;
      expect(getActionLabel(tx, realT, { personName: "Ali" })).toBe("You gave to Ali");
    });
    it("falls back to transaction.relatedPerson when opts.personName is absent", () => {
      const tx = makeTx({ type: "loan_given", relatedPerson: "Ahmed" });
      const realT = (key: string) => key === "action_gave" ? "You gave to {person}" : key;
      expect(getActionLabel(tx, realT)).toBe("You gave to Ahmed");
    });
  });

  describe("loan_taken direction + person interpolation", () => {
    it("with person", () => {
      const realT = (key: string) => key === "action_borrowed" ? "You borrowed from {person}" : key;
      expect(getActionLabel(makeTx({ type: "loan_taken" }), realT, { personName: "Ali" }))
        .toBe("You borrowed from Ali");
    });
    it("without person", () => {
      expect(getActionLabel(makeTx({ type: "loan_taken" }), t)).toBe("action_borrowed_noperson");
    });
  });

  describe("repayment direction inference", () => {
    it("loan.type='given' → 'They paid you back'", () => {
      const tx = makeTx({ type: "repayment", relatedLoanId: "loan-1" });
      expect(getActionLabel(tx, t, { loan: makeLoan({ type: "given" }), personName: "Ali" }))
        .toBe("action_they_paid_back");
    });
    it("loan.type='taken' → 'You paid them back'", () => {
      const tx = makeTx({ type: "repayment", relatedLoanId: "loan-1" });
      expect(getActionLabel(tx, t, { loan: makeLoan({ type: "taken" }), personName: "Ali" }))
        .toBe("action_i_paid_back");
    });
    it("no loan + destinationAccountId set → 'received' (money came IN)", () => {
      const tx = makeTx({ type: "repayment", destinationAccountId: "acct-1" });
      expect(getActionLabel(tx, t, { personName: "Ali" })).toBe("action_they_paid_back");
    });
    it("no loan + sourceAccountId set → 'paid' (money went OUT)", () => {
      const tx = makeTx({ type: "repayment", sourceAccountId: "acct-1" });
      expect(getActionLabel(tx, t, { personName: "Ali" })).toBe("action_i_paid_back");
    });
    it("loan.type takes precedence over slot-based inference", () => {
      // Both sourceAccountId set AND loan.type='given' — loan wins.
      const tx = makeTx({ type: "repayment", sourceAccountId: "acct-1" });
      expect(getActionLabel(tx, t, { loan: makeLoan({ type: "given" }), personName: "Ali" }))
        .toBe("action_they_paid_back");
    });
    it("repayment without person falls back to no-person variant", () => {
      const tx = makeTx({ type: "repayment", destinationAccountId: "acct-1" });
      expect(getActionLabel(tx, t)).toBe("action_they_paid_back_noperson");
    });
    it("repayment interpolates {person} when provided", () => {
      const tx = makeTx({ type: "repayment", relatedLoanId: "loan-1" });
      const realT = (key: string) => key === "action_they_paid_back" ? "{person} paid you back" : key;
      expect(getActionLabel(tx, realT, { loan: makeLoan({ type: "given" }), personName: "Ali" }))
        .toBe("Ali paid you back");
    });
  });

  describe("goal_contribution interpolation", () => {
    it("with goal interpolates {goal}", () => {
      const tx = makeTx({ type: "goal_contribution" });
      const goal: Goal = {
        id: "g1",
        title: "House Deposit",
        currency: "PKR",
        savedAmount: 50000,
        targetAmount: 100000,
        storedInAccountId: "",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const realT = (key: string) => key === "action_saved_goal" ? "You saved toward {goal}" : key;
      expect(getActionLabel(tx, realT, { goal })).toBe("You saved toward House Deposit");
    });
    it("without goal falls back", () => {
      expect(getActionLabel(makeTx({ type: "goal_contribution" }), t)).toBe("action_saved_goal_nogoal");
    });
  });
});

describe("getActionSubtitle", () => {
  it("transfer with both accounts → 'Source → Destination' arrow format", () => {
    const tx = makeTx({ type: "transfer" });
    const src = { name: "Cash" } as Account;
    const dst = { name: "Bank" } as Account;
    expect(getActionSubtitle(tx, t, { sourceAccount: src, destinationAccount: dst }))
      .toBe("Cash → Bank");
  });
  it("transfer without account info falls back to label", () => {
    expect(getActionSubtitle(makeTx({ type: "transfer" }), t)).toBe("action_moved");
  });
  it("non-transfer types delegate to getActionLabel", () => {
    expect(getActionSubtitle(makeTx({ type: "expense" }), t)).toBe("action_spent");
  });
});

