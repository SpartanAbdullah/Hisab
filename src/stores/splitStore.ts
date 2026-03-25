import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db } from '../db';
import type { SplitGroup, GroupExpense, GroupSettlement, SplitType, SplitDetail, GroupMember, Currency } from '../db';

interface SimplifiedDebt {
  from: string;   // member id
  fromName: string;
  to: string;     // member id
  toName: string;
  amount: number;
}

interface SplitState {
  groups: SplitGroup[];
  loading: boolean;

  loadGroups: () => Promise<void>;
  createGroup: (name: string, emoji: string, members: string[], currency: Currency) => Promise<SplitGroup>;
  deleteGroup: (id: string) => Promise<void>;

  getGroupExpenses: (groupId: string) => Promise<GroupExpense[]>;
  addGroupExpense: (input: {
    groupId: string;
    description: string;
    amount: number;
    paidBy: string;
    splitType: SplitType;
    splits: SplitDetail[];
    category: string;
    notes?: string;
  }) => Promise<GroupExpense>;

  getSettlements: (groupId: string) => Promise<GroupSettlement[]>;
  addSettlement: (input: {
    groupId: string;
    fromMember: string;
    toMember: string;
    amount: number;
    note?: string;
  }) => Promise<GroupSettlement>;

  getSimplifiedDebts: (groupId: string) => Promise<SimplifiedDebt[]>;
  getMyBalance: (groupId: string) => Promise<number>;
}

export const useSplitStore = create<SplitState>((set, get) => ({
  groups: [],
  loading: false,

  loadGroups: async () => {
    set({ loading: true });
    const groups = await db.splitGroups.orderBy('createdAt').reverse().toArray();
    set({ groups, loading: false });
  },

  createGroup: async (name, emoji, memberNames, currency) => {
    const ownerName = localStorage.getItem('hisaab_user_name') ?? 'You';
    const members: GroupMember[] = [
      { id: uuid(), name: ownerName, isOwner: true },
      ...memberNames.map(n => ({ id: uuid(), name: n, isOwner: false })),
    ];
    const group: SplitGroup = {
      id: uuid(),
      name,
      emoji,
      members,
      currency,
      settled: false,
      createdAt: new Date().toISOString(),
    };
    await db.splitGroups.add(group);
    await get().loadGroups();
    return group;
  },

  deleteGroup: async (id) => {
    await db.splitGroups.delete(id);
    await db.groupExpenses.where('groupId').equals(id).delete();
    await db.groupSettlements.where('groupId').equals(id).delete();
    await get().loadGroups();
  },

  getGroupExpenses: async (groupId) => {
    return db.groupExpenses.where('groupId').equals(groupId).reverse().sortBy('createdAt');
  },

  addGroupExpense: async (input) => {
    const expense: GroupExpense = {
      id: uuid(),
      groupId: input.groupId,
      description: input.description,
      amount: input.amount,
      paidBy: input.paidBy,
      splitType: input.splitType,
      splits: input.splits,
      category: input.category || 'General',
      date: new Date().toISOString(),
      notes: input.notes || '',
      createdAt: new Date().toISOString(),
    };
    await db.groupExpenses.add(expense);
    return expense;
  },

  getSettlements: async (groupId) => {
    return db.groupSettlements.where('groupId').equals(groupId).reverse().sortBy('createdAt');
  },

  addSettlement: async (input) => {
    const settlement: GroupSettlement = {
      id: uuid(),
      groupId: input.groupId,
      fromMember: input.fromMember,
      toMember: input.toMember,
      amount: input.amount,
      date: new Date().toISOString(),
      note: input.note || '',
      createdAt: new Date().toISOString(),
    };
    await db.groupSettlements.add(settlement);
    return settlement;
  },

  getSimplifiedDebts: async (groupId) => {
    const group = await db.splitGroups.get(groupId);
    if (!group) return [];

    const expenses = await db.groupExpenses.where('groupId').equals(groupId).toArray();
    const settlements = await db.groupSettlements.where('groupId').equals(groupId).toArray();

    // Calculate net balance for each member
    const balances = new Map<string, number>();
    group.members.forEach(m => balances.set(m.id, 0));

    for (const exp of expenses) {
      // Payer's balance goes up (they are owed money)
      balances.set(exp.paidBy, (balances.get(exp.paidBy) ?? 0) + exp.amount);
      // Each split member's balance goes down (they owe money)
      for (const split of exp.splits) {
        balances.set(split.memberId, (balances.get(split.memberId) ?? 0) - split.amount);
      }
    }

    // Apply settlements
    for (const s of settlements) {
      balances.set(s.fromMember, (balances.get(s.fromMember) ?? 0) + s.amount);
      balances.set(s.toMember, (balances.get(s.toMember) ?? 0) - s.amount);
    }

    // Simplify debts: separate creditors (positive) and debtors (negative)
    const creditors: { id: string; amount: number }[] = [];
    const debtors: { id: string; amount: number }[] = [];

    balances.forEach((bal, id) => {
      const rounded = Math.round(bal * 100) / 100;
      if (rounded > 0.01) creditors.push({ id, amount: rounded });
      else if (rounded < -0.01) debtors.push({ id, amount: Math.abs(rounded) });
    });

    creditors.sort((a, b) => b.amount - a.amount);
    debtors.sort((a, b) => b.amount - a.amount);

    const debts: SimplifiedDebt[] = [];
    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const amount = Math.min(creditors[ci].amount, debtors[di].amount);
      if (amount > 0.01) {
        const fromMember = group.members.find(m => m.id === debtors[di].id);
        const toMember = group.members.find(m => m.id === creditors[ci].id);
        debts.push({
          from: debtors[di].id,
          fromName: fromMember?.name ?? '?',
          to: creditors[ci].id,
          toName: toMember?.name ?? '?',
          amount: Math.round(amount * 100) / 100,
        });
      }
      creditors[ci].amount -= amount;
      debtors[di].amount -= amount;
      if (creditors[ci].amount < 0.01) ci++;
      if (debtors[di].amount < 0.01) di++;
    }

    return debts;
  },

  getMyBalance: async (groupId) => {
    const group = await db.splitGroups.get(groupId);
    if (!group) return 0;
    const owner = group.members.find(m => m.isOwner);
    if (!owner) return 0;

    const debts = await get().getSimplifiedDebts(groupId);
    let balance = 0;
    for (const d of debts) {
      if (d.to === owner.id) balance += d.amount;     // someone owes me
      if (d.from === owner.id) balance -= d.amount;    // I owe someone
    }
    return Math.round(balance * 100) / 100;
  },
}));
