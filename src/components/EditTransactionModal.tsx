import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { ContactPicker, type ContactValue } from './ContactPicker';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { usePersonStore } from '../stores/personStore';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { CategoryPicker } from './CategoryPicker';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { parseInternalNote } from '../lib/internalNotes';
import { useT } from '../lib/i18n';
import { getActionLabel } from '../lib/transactionLabel';
import type { Transaction } from '../db';

interface Props {
  open: boolean;
  transaction: Transaction | null;
  onClose: () => void;
}

export function EditTransactionModal({ open, transaction, onClose }: Props) {
  const { accounts, loadAccounts } = useAccountStore();
  const { updateTransaction, deleteTransaction } = useTransactionStore();
  const loans = useLoanStore((s) => s.loans);
  const toast = useToast();
  const t = useT();

  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [cashAdvanceCardId, setCashAdvanceCardId] = useState('');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [originalPersonId, setOriginalPersonId] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      void loadAccounts();
    }
  }, [open, loadAccounts]);

  useEffect(() => {
    if (!transaction || !open) return;

    const parsedNote = parseInternalNote(transaction.notes);
    setAmount(String(transaction.amount));
    setAccountId(transaction.type === 'loan_taken' ? transaction.destinationAccountId ?? '' : transaction.sourceAccountId ?? '');
    setCashAdvanceCardId(transaction.type === 'loan_taken' ? transaction.sourceAccountId ?? '' : '');
    // Hydrate contact from personId when present (post-backfill or post-Phase-1
    // rows); fall back to the legacy string cache for the exceptional case
    // where a row predates Phase 1B-A backfill.
    const hydratedId = transaction.personId ?? null;
    const hydratedName = hydratedId
      ? usePersonStore.getState().persons.find((p) => p.id === hydratedId)?.name ?? transaction.relatedPerson ?? ''
      : transaction.relatedPerson ?? '';
    setContact({ id: hydratedId, name: hydratedName });
    setOriginalPersonId(hydratedId);
    setCategory(transaction.category ?? '');
    setNotes(parsedNote.visibleNote);
  }, [transaction, open]);

  if (!transaction) return null;

  const destinationAccount = transaction.type === 'loan_taken'
    ? accounts.find((account) => account.id === accountId)
    : null;
  const availableCashAdvanceCards = accounts.filter((account) => (
    account.type === 'credit_card' &&
    account.id !== accountId &&
    (!destinationAccount || account.currency === destinationAccount.currency)
  ));
  const selectedCashAdvanceCard = availableCashAdvanceCards.find((account) => account.id === cashAdvanceCardId);

  const editableAmount = parseFloat(amount);
  const isExpense = transaction.type === 'expense';
  const isLoanGiven = transaction.type === 'loan_given';
  const isLoanTaken = transaction.type === 'loan_taken';
  const noteMeta = parseInternalNote(transaction.notes).meta;
  const isDirectlyEditable = (isExpense || isLoanGiven || isLoanTaken) && !noteMeta.groupExpenseId;

  const canSave = (() => {
    if (!(editableAmount > 0) || !accountId) return false;
    if ((isLoanGiven || isLoanTaken) && !contact.name.trim()) return false;
    return true;
  })();

  // A non-null original id that the user has since typed over creates a
  // different contact rather than renaming the existing one — surface that
  // so they don't do it unintentionally. Rename lives in a later phase.
  const willCreateNewContact =
    (isLoanGiven || isLoanTaken) &&
    contact.id === null &&
    contact.name.trim() !== '' &&
    originalPersonId !== null;

  const handleSave = async () => {
    if (!canSave) return;

    setSaving(true);
    try {
      if (isExpense) {
        await updateTransaction(transaction.id, {
          type: 'expense',
          amount: editableAmount,
          sourceAccountId: accountId,
          category,
          notes,
        });
      } else if (isLoanGiven) {
        const trimmedName = contact.name.trim();
        const resolved = contact.id
          ? { id: contact.id, name: trimmedName }
          : await usePersonStore.getState().findOrCreateByName(trimmedName);
        await updateTransaction(transaction.id, {
          type: 'loan_given',
          amount: editableAmount,
          sourceAccountId: accountId,
          personName: resolved.name,
          personId: resolved.id,
          notes,
        });
      } else if (isLoanTaken) {
        const trimmedName = contact.name.trim();
        const resolved = contact.id
          ? { id: contact.id, name: trimmedName }
          : await usePersonStore.getState().findOrCreateByName(trimmedName);
        await updateTransaction(transaction.id, {
          type: 'loan_taken',
          amount: editableAmount,
          destinationAccountId: accountId,
          sourceAccountId: selectedCashAdvanceCard?.id,
          personName: resolved.name,
          personId: resolved.id,
          notes,
        });
      }

      toast.show({ type: 'success', title: 'Entry updated' });
      onClose();
    } catch (error) {
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: error instanceof Error ? error.message : 'Failed',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirmDestructive({
      title: t('del_tx_title'),
      description: t('del_tx_body'),
      confirmLabel: 'Delete',
    });
    if (!ok) return;

    setSaving(true);
    try {
      await deleteTransaction(transaction.id);
      toast.show({ type: 'success', title: 'Entry deleted' });
      onClose();
    } catch (error) {
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: error instanceof Error ? error.message : 'Failed',
      });
    } finally {
      setSaving(false);
    }
  };

  if (!isDirectlyEditable) {
    const source = transaction.sourceAccountId ? accounts.find((account) => account.id === transaction.sourceAccountId) : null;
    const destination = transaction.destinationAccountId ? accounts.find((account) => account.id === transaction.destinationAccountId) : null;
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Entry details"
        footer={(
          <button
            onClick={handleDelete}
            disabled={saving || Boolean(noteMeta.groupExpenseId)}
            className="w-full rounded-2xl bg-pay-50 text-pay-text py-3.5 text-sm font-bold disabled:opacity-40"
          >
            {saving ? t('quick_processing') : 'Delete entry'}
          </button>
        )}
      >
        <div className="space-y-4">
          <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-4">
            <p className="text-[11px] font-bold text-ink-500 uppercase tracking-widest">
              {getActionLabel(transaction, t, {
                personName: transaction.relatedPerson,
                loan: transaction.relatedLoanId ? loans.find((l) => l.id === transaction.relatedLoanId) ?? null : null,
              })}
            </p>
            <p className="text-lg font-bold text-ink-900 tabular-nums mt-1">
              {formatMoney(transaction.amount, transaction.currency)}
            </p>
          </div>
          {source && <p className="text-[13px] text-ink-700">From: <span className="font-semibold">{source.name}</span></p>}
          {destination && <p className="text-[13px] text-ink-700">To: <span className="font-semibold">{destination.name}</span></p>}
          {transaction.relatedPerson && <p className="text-[13px] text-ink-700">Person: <span className="font-semibold">{transaction.relatedPerson}</span></p>}
          {transaction.notes && <p className="text-[12px] text-ink-500">{parseInternalNote(transaction.notes).visibleNote}</p>}
          <p className="text-[12px] text-ink-500 bg-cream-soft rounded-xl p-3 leading-relaxed">
            This entry is kept read-only to protect linked balances. Deleting it restores the affected balances and removes the entry.
          </p>
          {noteMeta.groupExpenseId && (
            <p className="text-[12px] text-warn-600 bg-warn-50 rounded-xl p-3 leading-relaxed">
              This entry belongs to a group expense. Edit or delete it from the group details screen.
            </p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('edit_entry_title')}
      footer={(
        <div className="flex gap-2">
          <button
            onClick={handleDelete}
            disabled={saving}
            aria-label="Delete entry"
            className="min-h-[44px] min-w-[44px] px-4 rounded-2xl bg-pay-50 text-pay-text active:bg-pay-100 transition-all disabled:opacity-50 flex items-center justify-center"
          >
            <Trash2 size={16} />
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !canSave}
            className="flex-1 bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20"
          >
            {saving ? t('quick_processing') : 'Save Changes'}
          </button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="bg-cream-soft/80 rounded-2xl p-3.5 border border-cream-hairline">
          <p className="text-[11px] font-bold text-ink-500 uppercase tracking-widest">
            {getActionLabel(transaction, t, {
              personName: contact.name || transaction.relatedPerson,
              loan: transaction.relatedLoanId ? loans.find((l) => l.id === transaction.relatedLoanId) ?? null : null,
            })}
          </p>
          <p className="text-lg font-bold text-ink-900 tabular-nums mt-1">
            {formatMoney(transaction.amount, transaction.currency)}
          </p>
        </div>

        <div>
          <label className="form-label">Amount</label>
          <input
            type="number"
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="input-field text-center text-lg font-bold tabular-nums"
          />
        </div>

        <div>
          <label className="form-label">
            {isLoanTaken ? t('loan_received_into') : t('quick_from')}
          </label>
          <div className="space-y-2">
            {accounts.map((account) => {
              const meta = currencyMeta[account.currency];
              const isSelected = accountId === account.id;
              return (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => {
                    setAccountId(account.id);
                    if (cashAdvanceCardId === account.id) setCashAdvanceCardId('');
                  }}
                  className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                    isSelected ? 'border-accent-500 bg-accent-50 shadow-sm shadow-indigo-500/5' : 'border-cream-border bg-white'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{meta?.flag}</span>
                    <div>
                      <p className="text-[13px] font-semibold text-ink-800">{account.name}</p>
                      <p className="text-[10px] text-ink-500 capitalize">{account.type.replace('_', ' ')}</p>
                    </div>
                  </div>
                  <p className="text-[13px] font-bold text-ink-800 tabular-nums">{formatSignedMoney(account.balance, account.currency)}</p>
                </button>
              );
            })}
          </div>
        </div>

        {isLoanTaken && availableCashAdvanceCards.length > 0 && (
          <div>
            <label className="form-label">{t('cash_advance_source')}</label>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setCashAdvanceCardId('')}
                className={`w-full p-3 rounded-2xl border text-left text-[12px] font-semibold transition-all ${
                  !selectedCashAdvanceCard ? 'border-accent-500 bg-accent-50 text-accent-600' : 'border-cream-border bg-white text-ink-500'
                }`}
              >
                No credit card
              </button>
              {availableCashAdvanceCards.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => setCashAdvanceCardId(account.id)}
                  className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                    selectedCashAdvanceCard?.id === account.id ? 'border-accent-500 bg-accent-50 shadow-sm shadow-indigo-500/5' : 'border-cream-border bg-white'
                  }`}
                >
                  <div>
                    <p className="text-[13px] font-semibold text-ink-800">{account.name}</p>
                    <p className="text-[10px] text-ink-500">Credit card</p>
                  </div>
                  <p className="text-[13px] font-bold text-ink-800 tabular-nums">{formatSignedMoney(account.balance, account.currency)}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {(isLoanGiven || isLoanTaken) && (
          <div>
            <label className="form-label">{t('quick_who')}</label>
            <ContactPicker
              value={contact}
              onChange={setContact}
              placeholder={t('quick_who_placeholder')}
              className="input-field"
            />
            {willCreateNewContact && (
              <p className="text-[11px] text-warn-600 mt-1.5">This will create a new contact.</p>
            )}
          </div>
        )}

        {isExpense && (
          <div>
            <label className="form-label">{t('category')}</label>
            <CategoryPicker type="expense" value={category} onChange={setCategory} includeCurrent />
          </div>
        )}

        <div>
          <label className="form-label">{t('quick_note')}</label>
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="input-field"
            placeholder="Optional..."
          />
        </div>
      </div>
    </Modal>
  );
}
