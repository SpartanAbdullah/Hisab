import Dexie, { type Table } from 'dexie';
import type { Account, Transaction, Loan, EmiSchedule, Goal, ActivityLog, UpcomingExpense, SplitGroup, GroupExpense, GroupSettlement } from './types';

export class HisaabDatabase extends Dexie {
  accounts!: Table<Account, string>;
  transactions!: Table<Transaction, string>;
  loans!: Table<Loan, string>;
  emiSchedules!: Table<EmiSchedule, string>;
  goals!: Table<Goal, string>;
  activityLog!: Table<ActivityLog, string>;
  upcomingExpenses!: Table<UpcomingExpense, string>;
  splitGroups!: Table<SplitGroup, string>;
  groupExpenses!: Table<GroupExpense, string>;
  groupSettlements!: Table<GroupSettlement, string>;

  constructor() {
    super('HisaabDB');
    this.version(1).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, createdAt',
      loans: 'id, personName, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
    });
    this.version(2).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, createdAt',
      loans: 'id, personName, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
      upcomingExpenses: 'id, accountId, dueDate, isPaid',
    });
    this.version(3).stores({
      accounts: 'id, type, currency',
      transactions: 'id, type, sourceAccountId, destinationAccountId, relatedLoanId, relatedGoalId, createdAt',
      loans: 'id, personName, type, status',
      emiSchedules: 'id, loanId, status, dueDate',
      goals: 'id, storedInAccountId',
      activityLog: 'id, type, relatedEntityId, timestamp',
      upcomingExpenses: 'id, accountId, dueDate, isPaid',
      splitGroups: 'id, createdAt',
      groupExpenses: 'id, groupId, paidBy, createdAt',
      groupSettlements: 'id, groupId, fromMember, toMember',
    });
  }
}

export const db = new HisaabDatabase();
