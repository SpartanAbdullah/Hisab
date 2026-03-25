import type { Transaction } from '../db';

export interface CategoryData {
  category: string;
  amount: number;
  percentage: number;
  color: string;
}

export interface MonthlyData {
  month: string;
  income: number;
  expense: number;
}

export interface DailyData {
  day: string;
  amount: number;
}

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16'];

export function groupByCategory(transactions: Transaction[], startDate: Date, endDate: Date): CategoryData[] {
  const expenses = transactions.filter(t => t.type === 'expense' && new Date(t.createdAt) >= startDate && new Date(t.createdAt) <= endDate);
  const map = new Map<string, number>();
  expenses.forEach(t => { map.set(t.category || 'Other', (map.get(t.category || 'Other') ?? 0) + t.amount); });
  const total = expenses.reduce((s, t) => s + t.amount, 0);
  return Array.from(map.entries())
    .map(([category, amount], i) => ({ category, amount, percentage: total > 0 ? Math.round((amount / total) * 100) : 0, color: COLORS[i % COLORS.length] }))
    .sort((a, b) => b.amount - a.amount);
}

export function monthlyTrend(transactions: Transaction[], months: number): MonthlyData[] {
  const result: MonthlyData[] = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    const label = start.toLocaleDateString('en', { month: 'short' });
    const filtered = transactions.filter(t => { const d = new Date(t.createdAt); return d >= start && d <= end; });
    result.push({
      month: label,
      income: filtered.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0),
      expense: filtered.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0),
    });
  }
  return result;
}

export function dailySpending(transactions: Transaction[], startDate: Date, endDate: Date): DailyData[] {
  const expenses = transactions.filter(t => t.type === 'expense' && new Date(t.createdAt) >= startDate && new Date(t.createdAt) <= endDate);
  const map = new Map<string, number>();
  expenses.forEach(t => {
    const day = new Date(t.createdAt).getDate().toString();
    map.set(day, (map.get(day) ?? 0) + t.amount);
  });
  const result: DailyData[] = [];
  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  for (let i = 0; i < Math.min(days, 31); i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const key = d.getDate().toString();
    result.push({ day: key, amount: map.get(key) ?? 0 });
  }
  return result;
}

export function topExpenses(transactions: Transaction[], startDate: Date, endDate: Date, limit = 5): Transaction[] {
  return transactions
    .filter(t => t.type === 'expense' && new Date(t.createdAt) >= startDate && new Date(t.createdAt) <= endDate)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

export function groupSpendingByGroup(expenses: { groupId: string; groupName: string; amount: number }[]): { name: string; amount: number; color: string }[] {
  const map = new Map<string, { name: string; amount: number }>();
  expenses.forEach(e => {
    const existing = map.get(e.groupId);
    if (existing) existing.amount += e.amount;
    else map.set(e.groupId, { name: e.groupName, amount: e.amount });
  });
  return Array.from(map.values())
    .sort((a, b) => b.amount - a.amount)
    .map((item, i) => ({ ...item, color: COLORS[i % COLORS.length] }));
}
