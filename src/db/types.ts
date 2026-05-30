export const SUPPORTED_CURRENCIES = ['AED', 'PKR', 'PHP', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD'] as const;
export type Currency = typeof SUPPORTED_CURRENCIES[number];

export type AccountType = 'cash' | 'bank' | 'digital_wallet' | 'savings' | 'credit_card';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: Currency;
  balance: number;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export type TransactionType =
  | 'income'
  | 'expense'
  | 'loan_given'
  | 'loan_taken'
  | 'repayment'
  | 'transfer'
  | 'goal_contribution'
  | 'opening_balance';

export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  currency: Currency;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  relatedPerson: string | null;
  personId?: string | null;
  relatedLoanId: string | null;
  relatedGoalId: string | null;
  conversionRate: number | null;
  category: string;
  notes: string;
  createdAt: string;
  isReconciled?: boolean;
  reconciledAt?: string | null;
  reconciledBy?: string | null;
  updatedAt?: string;
  deletedAt?: string | null;
}

export type LoanType = 'given' | 'taken';
export type LoanStatus = 'active' | 'settled';

export interface Loan {
  id: string;
  personName: string;
  personId?: string | null;
  type: LoanType;
  totalAmount: number;
  remainingAmount: number;
  currency: Currency;
  status: LoanStatus;
  notes: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface Person {
  id: string;
  name: string;
  phone?: string | null;
  linkedProfileId?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Phase 2B: linked transaction request. Cloud-only; no Dexie mirror.
export type LinkedRequestKind = 'lent' | 'borrowed';
export type LinkedRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface LinkedRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  personId: string | null;
  kind: LinkedRequestKind;
  amount: number;
  currency: Currency;
  note: string;
  status: LinkedRequestStatus;
  rejectionReason: string | null;
  requesterLoanId: string | null;
  responderLoanId: string | null;
  requesterTxnId: string | null;
  responderTxnId: string | null;
  loanPairId: string | null;
  // Phase 2D: set when the request references an already-existing sender-side
  // loan from before the contact got linked. Acceptance reuses that loan
  // instead of creating a duplicate; the recipient still gets a fresh mirror.
  // Distinguishes "sync past record" cards from fresh-loan requests in Inbox.
  preExistingLoanId: string | null;
  createdAt: string;
  respondedAt: string | null;
}

// Phase 2C-A: linked settlement request. Cloud-only; same mirroring pattern
// as LinkedRequest. No account-related fields — Phase 2C-A is ledger-only.
export type SettlementRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface SettlementRequest {
  id: string;
  loanPairId: string;
  requesterLoanId: string;
  responderLoanId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  currency: Currency;
  note: string;
  status: SettlementRequestStatus;
  rejectionReason: string | null;
  requesterTxnId: string | null;
  responderTxnId: string | null;
  // Phase 2C-B (sender-only opt-in). Null ⇒ ledger-only on both sides.
  requesterAccountId?: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export type EmiStatus = 'upcoming' | 'paid' | 'late';

export interface EmiSchedule {
  id: string;
  loanId: string;
  installmentNumber: number;
  dueDate: string;
  amount: number;
  status: EmiStatus;
}

export interface Goal {
  id: string;
  title: string;
  targetAmount: number;
  savedAmount: number;
  currency: Currency;
  storedInAccountId: string; // empty string = tracked internally
  createdAt: string;
}

export type UpcomingExpenseStatus = 'upcoming' | 'done' | 'cancelled';

export interface UpcomingExpense {
  id: string;
  title: string;
  amount: number;
  currency: Currency;
  dueDate: string;
  accountId: string; // which account will be charged
  category: string;
  notes: string;
  isPaid: boolean;
  status: UpcomingExpenseStatus;
  reminderDaysBefore: number;
  createdAt: string;
}

export type ActivityType =
  | 'account_created'
  | 'account_deleted'
  | 'transaction_created'
  | 'transaction_modified'
  | 'transaction_deleted'
  | 'loan_created'
  | 'loan_settled'
  | 'emi_paid'
  | 'goal_created'
  | 'goal_contribution'
  | 'opening_balance'
  | 'group_created'
  | 'group_expense'
  | 'group_settlement';

export interface ActivityLog {
  id: string;
  type: ActivityType;
  description: string;
  relatedEntityId: string;
  relatedEntityType: string;
  timestamp: string;
}

// ── Group Splits ──
export type SplitType = 'equal' | 'exact' | 'percentage' | 'shares';

export interface GroupMember {
  id: string;
  name: string;
  isOwner: boolean;
  profileId?: string | null;
  role?: 'owner' | 'member';
  status?: 'guest' | 'invited' | 'connected';
  joinedAt?: string | null;
}

export interface SplitGroup {
  id: string;
  name: string;
  emoji: string;
  members: GroupMember[];
  currency: Currency;
  settled: boolean;
  createdAt: string;
  createdBy?: string | null;
  joinCode?: string | null;
  joinCodeNormalized?: string | null;
}

export interface SplitDetail {
  memberId: string;
  amount: number;
}

export interface GroupExpense {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  paidBy: string; // member id
  splitType: SplitType;
  splits: SplitDetail[];
  category: string;
  date: string;
  notes: string;
  createdAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  version?: number;
  isReconciled?: boolean;
  reconciledAt?: string | null;
  reconciledBy?: string | null;
}

export interface GroupSettlement {
  id: string;
  groupId: string;
  fromMember: string; // member id
  toMember: string;   // member id
  amount: number;
  date: string;
  note: string;
  createdAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
}

export type GroupEventType =
  | 'group_created'
  | 'member_invited'
  | 'member_joined'
  | 'expense_added'
  | 'expense_updated'
  | 'expense_deleted'
  | 'settlement_added';

export interface GroupInvite {
  id: string;
  groupId: string;
  tokenHash: string;
  createdBy: string;
  linkedMemberId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

export interface GroupEvent {
  id: string;
  groupId: string;
  actorProfileId: string | null;
  eventType: GroupEventType;
  entityType: 'group' | 'member' | 'group_expense' | 'group_settlement' | 'invite';
  entityId: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AppNotification {
  id: string;
  userId: string;
  groupId: string | null;
  eventId: string | null;
  type: 'group_update' | 'invite' | 'system';
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

// ── Budgets ──
// A monthly spending cap per (category, currency). Multiple budgets per
// category are NOT supported on purpose — one user, one currency, one
// monthly cap. If the user wants to track spend across currencies they
// can create one budget per currency.
export interface Budget {
  id: string;
  category: string;
  monthlyAmount: number;
  currency: Currency;
  // Optional soft-warning threshold as a percentage. Defaults to 80% if
  // not set; surfaces a non-blocking banner on Home once crossed.
  warnAtPercent: number;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

// ── Recurring Transactions ──
export type RecurringCadence = 'daily' | 'weekly' | 'monthly' | 'yearly';

// A template that materialises into a real Transaction on its due date.
// Designed for salary, rent, subscriptions, EMIs the user wants tracked
// without re-typing. The runner in src/lib/recurringRunner.ts walks the
// list on app boot and prompts confirmation for any due entries.
export interface RecurringTransaction {
  id: string;
  // The Transaction shape this expands into. Only the leaf fields the user
  // can edit at template time are kept — generated fields (id, createdAt)
  // are produced fresh at expansion.
  type: 'income' | 'expense' | 'transfer';
  amount: number;
  currency: Currency;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  category: string;
  notes: string;
  // Scheduling. nextDueDate advances by `cadence` after each expansion.
  cadence: RecurringCadence;
  nextDueDate: string; // ISO date (YYYY-MM-DD)
  // Soft-pause without deleting. Useful for "I quit Netflix this month
  // but might restart next month" — keeps the template, skips the run.
  active: boolean;
  // Display label for the user. Defaults to the category when unset.
  label: string;
  createdAt: string;
}

// ── Remittances ──
// A first-class money-home record. NOT a Transaction subtype because
// remittances have their own metadata (channel, fees, effective rate)
// that doesn't belong on the generic ledger row. The send-side debit
// and receive-side credit are still represented as transactions on
// the linked accounts; the Remittance entity is the umbrella that
// ties them together with the cost-of-conversion context.
export type RemittanceChannel = 'bank_transfer' | 'wise' | 'remitly' | 'western_union' | 'hundi' | 'other';
export type RemittanceStatus = 'pending' | 'received' | 'failed';

export interface Remittance {
  id: string;
  // Send side — money leaving the source country.
  sourceAccountId: string;
  sourceCurrency: Currency;
  sourceAmount: number;
  // Receive side — money arriving in the destination country.
  destinationAccountId: string | null; // null when received in cash / unlinked
  destinationCurrency: Currency;
  destinationAmount: number;
  // Channel + cost transparency.
  channel: RemittanceChannel;
  feeAmount: number;
  feeCurrency: Currency;
  // Derived: destinationAmount / (sourceAmount - feeAmountInSourceCurrency)
  // Stored explicitly so the user can compare channels across months
  // without re-deriving from rates that decay over time.
  effectiveRate: number;
  status: RemittanceStatus;
  recipientName: string;
  notes: string;
  // The two transaction IDs we wrote on commit. Kept so reconciling
  // a remittance can find and reconcile both legs in one shot.
  sourceTxnId: string | null;
  destinationTxnId: string | null;
  sentAt: string;
  receivedAt: string | null;
  createdAt: string;
}

// ── App Mode ──
export type AppMode = 'splits_only' | 'full_tracker';
