import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Search, X, Receipt, HandCoins, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useSplitStore } from '../stores/splitStore';
import { groupExpensesDb } from '../lib/supabaseDb';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
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
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [groupExpenses, setGroupExpenses] = useState<GroupExpense[]>([]);
  const [loading, setLoading] = useState(false);

  const { accounts, loadAccounts } = useAccountStore();
  const { transactions, loadTransactions } = useTransactionStore();
  const { loans, loadLoans } = useLoanStore();
  const { groups, loadGroups } = useSplitStore();

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
      loadGroups().catch(() => undefined),
      groupExpensesDb.getAllVisible().catch(() => [] as GroupExpense[]),
    ]).then(([, , , , visibleGroupExpenses]) => {
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
    loadGroups,
  ]);

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);

  const results = useMemo<SearchResult[]>(() => {
    const rows: SearchResult[] = [];

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
      for (const expense of groupExpenses.filter(item => item.groupId === group.id)) {
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
    }

    return rows;
  }, [accountById, transactions, loans, groups, groupExpenses, groupById]);

  const trimmedQuery = query.trim();
  const isEmptyQuery = trimmedQuery.length === 0;

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

  // Group the visible rows by scope so the list reads as labelled sections
  // ("Transactions", "Loans", "Group expenses") instead of one flat stream.
  // Insertion order of the map preserves the scope order rows first appear in.
  const groupedResults = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const result of visibleResults) {
      const bucket = map.get(result.scope);
      if (bucket) bucket.push(result);
      else map.set(result.scope, [result]);
    }
    return [...map.entries()];
  }, [visibleResults]);

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
                placeholder={t('search_scope_placeholder')}
                className="w-full h-11 rounded-2xl bg-cream-soft border border-cream-border pl-10 pr-3 text-[14px] font-medium text-ink-900 outline-none focus:border-accent-500"
              />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="min-w-[44px] min-h-[44px] rounded-xl bg-cream-soft border border-cream-border flex items-center justify-center text-ink-500 active:scale-95 transition-transform"
              aria-label="Close search"
            >
              <X size={17} />
            </button>
          </div>

          <div className="max-h-[72dvh] overflow-y-auto p-3">
            {loading && results.length === 0 ? (
              <p className="text-center text-[12px] text-ink-500 py-8">Searching money activity...</p>
            ) : visibleResults.length === 0 ? (
              isEmptyQuery ? (
                /* Empty query, nothing to recall yet — tell the user what
                   Search reaches across so the blank box isn't a dead end. */
                <p className="text-center text-[12px] text-ink-500 py-8 px-4 leading-relaxed">
                  {t('search_covers')}
                </p>
              ) : (
                <p className="text-center text-[12px] text-ink-500 py-8 px-4 leading-relaxed">
                  {t('search_no_matches').replace('{q}', trimmedQuery)} {t('search_covers')}
                </p>
              )
            ) : (
              <div className="space-y-3">
                {/* On an empty query the list is the most recent activity —
                    label it so the user knows these aren't search matches. */}
                {isEmptyQuery && (
                  <p className="px-1 text-[10px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                    {t('search_recent')}
                  </p>
                )}
                {groupedResults.map(([scope, rows]) => (
                  <div key={scope} className="space-y-1.5">
                    {/* Scope section header — replaces the per-row chip so the
                        scope label reads at >=10px and the list is grouped. */}
                    <p className="px-1 text-[10px] font-semibold text-ink-400 uppercase tracking-[0.1em]">
                      {scope}
                    </p>
                    {rows.map((result) => {
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
                            <p className="text-[13px] font-semibold text-ink-900 truncate">{result.title}</p>
                            <p className="text-[11px] text-ink-500 truncate mt-0.5">{result.meta}</p>
                          </div>
                          <ChevronRight size={15} className="text-ink-300 shrink-0" />
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
