import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { ContactPicker, type ContactValue } from './ContactPicker';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { usePersonStore } from '../stores/personStore';
import { useToast } from './Toast';
import { EXPENSE_CATEGORIES, formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { parseInternalNote } from '../lib/internalNotes';
import { useT } from '../lib/i18n';
import type { Transaction } from '../db';

interface Props {
  open: boolean;
  transaction: Transaction | null;
  onClose: () => void;
}

export function EditTransactionModal({ open, transaction, onClose }: Props) {
  const { accounts, loadAccounts } = useAccountStore();
  const { updateTransaction, deleteTransaction } = useTransactionStore();
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
    if (!confirm('Delete this entry?')) return;

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
            className="px-4 py-3.5 rounded-2xl bg-red-50 text-red-500 active:bg-red-100 transition-all disabled:opacity-50"
          >
            <Trash2 size={16} />
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !canSave}
            className="flex-1 btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20"
          >
            {saving ? t('quick_processing') : 'Save Changes'}
          </button>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="bg-slate-50/80 rounded-2xl p-3.5 border border-slate-100/60">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
            {isExpense ? t('tx_expense') : isLoanGiven ? t('tx_loan_given') : t('tx_loan_taken')}
          </p>
          <p className="text-lg font-bold text-slate-800 tabular-nums mt-1">
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
                    isSelected ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{meta?.flag}</span>
                    <div>
                      <p className="text-[13px] font-semibold text-slate-700">{account.name}</p>
                      <p className="text-[10px] text-slate-400 capitalize">{account.type.replace('_', ' ')}</p>
                    </div>
                  </div>
                  <p className="text-[13px] font-bold text-slate-700 tabular-nums">{formatMoney(account.balance, account.currency)}</p>
                </button>
              );
            })}
          </div>
        </div>

        {isLoanTaken && availableCashAdvanceCards.length > 0 && (
          <div>
            <label className="form-label">Cash Advance Source</label>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setCashAdvanceCardId('')}
                className={`w-full p-3 rounded-2xl border text-left text-[12px] font-semibold transition-all ${
                  !selectedCashAdvanceCard ? 'border-indigo-400 bg-indigo-50/50 text-indigo-700' : 'border-slate-200/60 bg-white text-slate-500'
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
                    selectedCashAdvanceCard?.id === account.id ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
                  }`}
                >
                  <div>
                    <p className="text-[13px] font-semibold text-slate-700">{account.name}</p>
                    <p className="text-[10px] text-slate-400">Credit card</p>
                  </div>
                  <p className="text-[13px] font-bold text-slate-700 tabular-nums">{formatMoney(account.balance, account.currency)}</p>
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
              <p className="text-[11px] text-amber-600 mt-1.5">This will create a new contact.</p>
            )}
          </div>
        )}

        {isExpense && (
          <div>
            <label className="form-label">{t('category')}</label>
            <div className="flex flex-wrap gap-1.5">
              {EXPENSE_CATEGORIES.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setCategory(item)}
                  className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-all active:scale-95 ${
                    category === item ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-500/20' : 'bg-white text-slate-500 border-slate-200/60'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
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
