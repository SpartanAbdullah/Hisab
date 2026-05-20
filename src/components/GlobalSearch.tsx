import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Search, X, Wallet, Receipt, Users, HandCoins, Target, CalendarClock, Repeat, Send, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useGoalStore } from '../stores/goalStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { useSplitStore } from '../stores/splitStore';
import { useRecurringStore } from '../stores/recurringStore';
import { useRemittanceStore } from '../stores/remittanceStore';
import { groupExpensesDb } from '../lib/supabaseDb';
import { formatMoney } from '../lib/constants';
import type { Currency, GroupExpense } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
}

type SearchResult = {
  id: string;
  title: string;
  meta: string;
  scope: string;
  href: string;
  icon: ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  terms: string;
};

const normalize = (value: string) => value.trim().toLowerCase();

export function GlobalSearch({ open, onClose }: Props) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [groupExpenses, setGroupExpenses] = useState<GroupExpense[]>([]);
  const [loading, setLoading] = useState(false);

  const { accounts, loadAccounts } = useAccountStore();
  const { transactions, loadTransactions } = useTransactionStore();
  const { loans, loadLoans } = useLoanStore();
  const { goals, loadGoals } = useGoalStore();
  const { expenses: upcomingExpenses, loadExpenses } = useUpcomingExpenseStore();
  const { groups, loadGroups } = useSplitStore();
  const { templates, loadTemplates } = useRecurringStore();
  const { remittances, loadRemittances } = useRemittanceStore();

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => {
      setQuery('');
      setLoading(true);
      inputRef.current?.focus();
    }, 80);
    let cancelled = false;
    Promise.all([
      loadAccounts().catch(() => undefined),
      loadTransactions().catch(() => undefined),
      loadLoans().catch(() => undefined),
      loadGoals().catch(() => undefined),
      loadExpenses().catch(() => undefined),
      loadGroups().catch(() => undefined),
      loadTemplates().catch(() => undefined),
      loadRemittances().catch(() => undefined),
      groupExpensesDb.getAllVisible().catch(() => [] as GroupExpense[]),
    ]).then(([, , , , , , , , visibleGroupExpenses]) => {
      if (cancelled) return;
      setGroupExpenses(visibleGroupExpenses ?? []);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(focusTimer);
    };
  }, [
    open,
    loadAccounts,
    loadTransactions,
    loadLoans,
    loadGoals,
    loadExpenses,
    loadGroups,
    loadTemplates,
    loadRemittances,
  ]);

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);

  const results = useMemo<SearchResult[]>(() => {
    const rows: SearchResult[] = [];

    for (const account of accounts) {
      rows.push({
        id: `account-${account.id}`,
        title: account.name,
        meta: `${account.type.replace(/_/g, ' ')} - ${formatMoney(account.balance, account.currency)}`,
        scope: 'Account',
        href: `/account/${account.id}`,
        icon: Wallet,
        terms: `${account.name} ${account.type} ${account.currency} account wallet balance`,
      });
    }

    for (const transaction of transactions) {
      const source = transaction.sourceAccountId ? accountById.get(transaction.sourceAccountId)?.name : '';
      const destination = transaction.destinationAccountId ? accountById.get(transaction.destinationAccountId)?.name : '';
      rows.push({
        id: `transaction-${transaction.id}`,
        title: transaction.category || transaction.type.replace(/_/g, ' '),
        meta: `${formatMoney(transaction.amount, transaction.currency)} - ${source || destination || transaction.type}`,
        scope: 'Transaction',
        href: '/transactions',
        icon: Receipt,
        terms: `${transaction.type} ${transaction.category} ${transaction.notes} ${transaction.relatedPerson ?? ''} ${source ?? ''} ${destination ?? ''} ${transaction.amount} ${transaction.currency}`,
      });
    }

    for (const loan of loans) {
      rows.push({
        id: `loan-${loan.id}`,
        title: loan.personName,
        meta: `${loan.type === 'given' ? 'To receive' : 'To pay'} - ${formatMoney(loan.remainingAmount, loan.currency)}`,
        scope: 'Loan',
        href: `/loan/${loan.id}`,
        icon: HandCoins,
        terms: `${loan.personName} ${loan.notes} ${loan.type} loan ${loan.totalAmount} ${loan.remainingAmount} ${loan.currency}`,
      });
    }

    for (const group of groups) {
      rows.push({
        id: `group-${group.id}`,
        title: `${group.emoji} ${group.name}`,
        meta: `${group.members.length} members - ${group.currency}`,
        scope: 'Group',
        href: `/group/${group.id}`,
        icon: Users,
        terms: `${group.name} ${group.emoji} ${group.currency} ${group.members.map((member) => member.name).join(' ')}`,
      });
    }

    for (const expense of groupExpenses) {
      const group = groupById.get(expense.groupId);
      const paidBy = group?.members.find((member) => member.id === expense.paidBy)?.name ?? 'Someone';
      const currency = (group?.currency ?? 'AED') as Currency;
      rows.push({
        id: `group-expense-${expense.id}`,
        title: expense.description,
        meta: `${group?.name ?? 'Group'} - paid by ${paidBy} - ${formatMoney(expense.amount, currency)}`,
        scope: 'Group expense',
        href: `/group/${expense.groupId}`,
        icon: Receipt,
        terms: `${expense.description} ${expense.category} ${expense.notes} ${paidBy} ${group?.name ?? ''} ${expense.amount}`,
      });
    }

    for (const goal of goals) {
      rows.push({
        id: `goal-${goal.id}`,
        title: goal.title,
        meta: `${formatMoney(goal.savedAmount, goal.currency)} saved of ${formatMoney(goal.targetAmount, goal.currency)}`,
        scope: 'Goal',
        href: '/goals',
        icon: Target,
        terms: `${goal.title} goal savings ${goal.savedAmount} ${goal.targetAmount} ${goal.currency}`,
      });
    }

    for (const expense of upcomingExpenses) {
      rows.push({
        id: `upcoming-${expense.id}`,
        title: expense.title,
        meta: `${expense.status} - due ${new Date(expense.dueDate).toLocaleDateString()} - ${formatMoney(expense.amount, expense.currency)}`,
        scope: 'Upcoming',
        href: '/activity',
        icon: CalendarClock,
        terms: `${expense.title} ${expense.category} ${expense.notes} upcoming due ${expense.amount} ${expense.currency}`,
      });
    }

    for (const template of templates) {
      rows.push({
        id: `recurring-${template.id}`,
        title: template.label || template.category,
        meta: `${template.cadence} - next ${template.nextDueDate} - ${formatMoney(template.amount, template.currency)}`,
        scope: 'Recurring',
        href: '/recurring',
        icon: Repeat,
        terms: `${template.label} ${template.category} ${template.notes} recurring ${template.cadence} ${template.amount} ${template.currency}`,
      });
    }

    for (const remittance of remittances) {
      rows.push({
        id: `remittance-${remittance.id}`,
        title: remittance.recipientName,
        meta: `${remittance.status} - ${formatMoney(remittance.sourceAmount, remittance.sourceCurrency)} to ${formatMoney(remittance.destinationAmount, remittance.destinationCurrency)}`,
        scope: 'Remittance',
        href: '/remittances',
        icon: Send,
        terms: `${remittance.recipientName} ${remittance.channel} ${remittance.notes} remittance ${remittance.sourceAmount} ${remittance.destinationAmount}`,
      });
    }

    return rows;
  }, [accounts, accountById, transactions, loans, groups, groupExpenses, groupById, goals, upcomingExpenses, templates, remittances]);

  const visibleResults = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return results.slice(0, 12);
    const tokens = needle.split(/\s+/).filter(Boolean);
    return results
      .filter((result) => {
        const haystack = normalize(`${result.title} ${result.meta} ${result.scope} ${result.terms}`);
        return tokens.every((token) => haystack.includes(token));
      })
      .slice(0, 40);
  }, [query, results]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-navy-950/55 backdrop-blur-sm">
      <div className="min-h-dvh flex items-start justify-center px-4 pt-5">
        <div className="w-full max-w-[480px] rounded-[20px] bg-cream-bg shadow-2xl shadow-navy-950/30 overflow-hidden animate-fade-in">
          <div className="flex items-center gap-2 p-3 border-b border-cream-border bg-cream-card">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search everything"
                className="w-full h-11 rounded-2xl bg-cream-soft border border-cream-border pl-10 pr-3 text-[14px] font-medium text-ink-900 outline-none focus:border-accent-500"
              />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-10 h-10 rounded-xl bg-cream-soft border border-cream-border flex items-center justify-center text-ink-500 active:scale-95 transition-transform"
              aria-label="Close search"
            >
              <X size={17} />
            </button>
          </div>

          <div className="max-h-[72dvh] overflow-y-auto p-3">
            {loading && results.length === 0 ? (
              <p className="text-center text-[12px] text-ink-500 py-8">Searching across Hisaab...</p>
            ) : visibleResults.length === 0 ? (
              <p className="text-center text-[12px] text-ink-500 py-8">No matching results.</p>
            ) : (
              <div className="space-y-1.5">
                {visibleResults.map((result) => {
                  const Icon = result.icon;
                  return (
                    <button
                      key={result.id}
                      type="button"
                      onClick={() => {
                        navigate(result.href);
                        onClose();
                      }}
                      className="w-full rounded-2xl bg-cream-card border border-cream-border px-3.5 py-3 flex items-center gap-3 text-left active:bg-cream-soft transition-colors"
                    >
                      <div className="w-9 h-9 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center shrink-0">
                        <Icon size={16} className="text-accent-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="text-[13px] font-semibold text-ink-900 truncate">{result.title}</p>
                          <span className="shrink-0 rounded-full bg-info-50 px-2 py-0.5 text-[9px] font-bold text-info-600">
                            {result.scope}
                          </span>
                        </div>
                        <p className="text-[11px] text-ink-500 truncate mt-0.5">{result.meta}</p>
                      </div>
                      <ChevronRight size={15} className="text-ink-300 shrink-0" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
