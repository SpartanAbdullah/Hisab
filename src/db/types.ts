export type Currency = 'AED' | 'PKR';

export type AccountType = 'cash' | 'bank' | 'digital_wallet' | 'savings' | 'credit_card';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: Currency;
  balance: number;
  metadata: Record<string, string>;
  createdAt: string;
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
}

export interface Person {
  id: string;
  name: string;
  phone?: string | null;
  createdAt: string;
  updatedAt: string;
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

// ── App Mode ──
export type AppMode = 'splits_only' | 'full_tracker';
