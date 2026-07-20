// Collapsed account selector. Shows ONLY the chosen account as a single row;
// tapping it expands the full list — grouped Wallets & Cash / Banks / Credit
// Cards via AccountGroupSections — to pick a different one. Replaces the
// always-expanded lists that overwhelmed users with several accounts. With no
// selection yet the list starts expanded, so first-time flows lose nothing.

import { useState, type ReactNode } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { AccountGroupSections } from './AccountGroupSections';
import { formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { orderAccountsForCurrency } from '../lib/accountCurrencyOrder';
import { useT } from '../lib/i18n';
import type { Account, AccountType, Currency } from '../db';

const TYPE_LABEL_KEY: Record<AccountType, 'type_cash' | 'type_bank' | 'type_wallet' | 'type_savings' | 'type_credit_card'> = {
  cash: 'type_cash',
  bank: 'type_bank',
  digital_wallet: 'type_wallet',
  savings: 'type_savings',
  credit_card: 'type_credit_card',
};

interface Props {
  accounts: Account[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Locked: render the selected row only — no expansion affordance. */
  locked?: boolean;
  /** Right-hand content per row (defaults to the signed balance). */
  renderRight?: (account: Account) => ReactNode;
  /**
   * The currency the flow already knows the money is in (e.g. the loan's).
   * Matching accounts float to the top of each section; mismatched ones stay
   * pickable but carry a "rate needed" tag so a PKR account never masquerades
   * as an option equal to an AED one on an AED loan.
   */
  preferredCurrency?: Currency;
}

export function AccountSelect({ accounts, selectedId, onSelect, locked = false, renderRight, preferredCurrency }: Props) {
  const t = useT();
  const ordered = orderAccountsForCurrency(accounts, preferredCurrency);
  const selected = accounts.find((a) => a.id === selectedId) ?? null;
  const [expanded, setExpanded] = useState(false);
  // Derived, not synced: with no valid selection (none yet, or the selection
  // was filtered out of the list) the list is always expanded — no stale or
  // empty collapsed row is possible.
  const open = expanded || !selected;

  const right = (a: Account) => renderRight?.(a) ?? (
    <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
  );

  const isMismatch = (a: Account) => Boolean(preferredCurrency && a.currency !== preferredCurrency);

  const rowLeft = (a: Account) => (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-sm">{currencyMeta[a.currency]?.flag}</span>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-ink-900 truncate">{a.name}</p>
        <p className="text-[10px] text-ink-500 flex items-center gap-1">
          {t(TYPE_LABEL_KEY[a.type] ?? 'type_bank')}
          {isMismatch(a) && (
            <span className="inline-flex items-center rounded-full bg-warn-50 text-warn-600 font-semibold px-1.5 py-px">
              {a.currency} · {t('acct_rate_needed')}
            </span>
          )}
        </p>
      </div>
    </div>
  );

  // Nothing to offer — don't render a "Choose an account" prompt over an
  // empty list (e.g. a locked account that has since been deleted).
  if (accounts.length === 0) return null;

  if (selected && locked) {
    return (
      <div className="w-full p-3.5 rounded-2xl border-2 border-accent-500 bg-accent-50 flex items-center justify-between">
        {rowLeft(selected)}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <div className="text-right">{right(selected)}</div>
          <Lock size={13} className="text-accent-600" />
        </div>
      </div>
    );
  }

  if (selected && !open) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full p-3.5 rounded-2xl border-2 border-accent-500 bg-accent-50 flex items-center justify-between text-left transition-all active:scale-[0.98]"
      >
        {rowLeft(selected)}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <div className="text-right">{right(selected)}</div>
          <div className="flex flex-col items-center text-accent-600">
            <ChevronDown size={14} strokeWidth={2.2} />
            <span className="text-[8.5px] font-semibold uppercase tracking-[0.08em]">{t('acct_select_change')}</span>
          </div>
        </div>
      </button>
    );
  }

  return (
    <div className="animate-fade-in">
      {!selected && (
        <p className="text-[11px] text-ink-500 mb-2">{t('acct_select_placeholder')}</p>
      )}
      <AccountGroupSections
        accounts={ordered}
        renderAccount={(a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              // Re-tapping the current selection just collapses — no onSelect,
              // so consumers' change side-effects (e.g. clearing a typed
              // conversion rate) only fire on a real change.
              if (a.id !== selectedId) onSelect(a.id);
              setExpanded(false);
            }}
            className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
              a.id === selectedId ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
            }`}
          >
            {rowLeft(a)}
            <div className="text-right shrink-0 ml-2">{right(a)}</div>
          </button>
        )}
      />
    </div>
  );
}
