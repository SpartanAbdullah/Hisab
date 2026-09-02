import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { ContactPicker, type ContactValue } from './ContactPicker';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { usePersonStore } from '../stores/personStore';
import { useToast } from './Toast';
import { CategoryPicker } from './CategoryPicker';
import { ReceiptField } from './ReceiptField';
import { AccountSelect } from './AccountSelect';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { groupExpensesDb } from '../lib/supabaseDb';
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
  const { updateTransaction, deleteTransaction, restoreTransaction } = useTransactionStore();
  const persistReceiptPath = useTransactionStore((s) => s.setReceiptPath);
  const allTransactions = useTransactionStore((s) => s.transactions);
  const loans = useLoanStore((s) => s.loans);
  const toast = useToast();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();

  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [destAccountId, setDestAccountId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [txDate, setTxDate] = useState('');
  const [cashAdvanceCardId, setCashAdvanceCardId] = useState('');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [originalPersonId, setOriginalPersonId] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Group-mirror liveness, probed once on open: true = group expense still
  // exists (route to the group screen), false = orphan (freely deletable),
  // null = not a group mirror. Assume LIVE until the probe answers.
  const [groupLive, setGroupLive] = useState<boolean | null>(null);

  useEffect(() => {
    if (open) {
      void loadAccounts();
    }
  }, [open, loadAccounts]);

  useEffect(() => {
    if (!open || !transaction) return;
    const gid = parseInternalNote(transaction.notes).meta.groupExpenseId;
    if (!gid) {
      setGroupLive(null);
      return;
    }
    setGroupLive(true);
    void groupExpensesDb
      .probeExists(gid)
      .then((alive) => setGroupLive(alive))
      .catch(() => setGroupLive(true));
  }, [open, transaction]);

  useEffect(() => {
    if (!transaction || !open) return;

    const parsedNote = parseInternalNote(transaction.notes);
    setAmount(String(transaction.amount));
    setAccountId(
      transaction.type === 'loan_taken' || transaction.type === 'income'
        ? transaction.destinationAccountId ?? ''
        : transaction.sourceAccountId ?? '',
    );
    setDestAccountId(transaction.type === 'transfer' ? transaction.destinationAccountId ?? '' : '');
    setConversionRate(transaction.conversionRate ? String(transaction.conversionRate) : '');
    setTxDate((transaction.createdAt ?? '').slice(0, 10));
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
    setReceiptPath(transaction.receiptPath ?? null);
  }, [transaction, open]);

  // Persist a receipt attach/remove immediately (it's a side attachment, not
  // part of the amount/category edit) so it survives even if the form is
  // closed without saving.
  const handleReceiptChange = async (path: string | null) => {
    if (!transaction) return;
    setReceiptPath(path);
    try {
      await persistReceiptPath(transaction.id, path);
    } catch {
      toast.show({ type: 'error', title: t('receipt_failed') });
    }
  };

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
  // Dirty = any editable field differs from the hydrated transaction (receipt
  // changes persist immediately, so they're excluded).
  const origAccountId = transaction.type === 'loan_taken' || transaction.type === 'income'
    ? (transaction.destinationAccountId ?? '')
    : (transaction.sourceAccountId ?? '');
  const origCashAdvance = transaction.type === 'loan_taken' ? (transaction.sourceAccountId ?? '') : '';
  const origDate = (transaction.createdAt ?? '').slice(0, 10);
  const isDirty =
    amount !== String(transaction.amount) ||
    accountId !== origAccountId ||
    destAccountId !== (transaction.type === 'transfer' ? transaction.destinationAccountId ?? '' : '') ||
    txDate !== origDate ||
    cashAdvanceCardId !== origCashAdvance ||
    category !== (transaction.category ?? '') ||
    notes !== parseInternalNote(transaction.notes).visibleNote ||
    (contact.id ?? null) !== originalPersonId;
  const isExpense = transaction.type === 'expense';
  const isIncome = transaction.type === 'income';
  const isTransfer = transaction.type === 'transfer';
  const isLoanGiven = transaction.type === 'loan_given';
  const isLoanTaken = transaction.type === 'loan_taken';
  const noteMeta = parseInternalNote(transaction.notes).meta;
  // A split row is one slice of a shared bill. Editing it alone would desync
  // the slices from each other — raise your own share and the account no longer
  // moves by the real total — so the whole event is edited or deleted together.
  const isDirectlyEditable = (isExpense || isIncome || isTransfer || isLoanGiven || isLoanTaken)
    && !noteMeta.groupExpenseId
    && !noteMeta.splitEventId;

  const splitRows = noteMeta.splitEventId
    ? allTransactions.filter((row) => parseInternalNote(row.notes).meta.splitEventId === noteMeta.splitEventId)
    : [];
  // Pre-flight the blocker that deleteTransaction raises per row, so a
  // part-settled split refuses BEFORE we start destroying its siblings rather
  // than halfway through.
  const splitSettledRow = splitRows.find((row) =>
    row.relatedLoanId && allTransactions.some((x) => x.type === 'repayment' && x.relatedLoanId === row.relatedLoanId),
  );

  const transferSource = isTransfer ? accounts.find((a) => a.id === accountId) : null;
  const transferDest = isTransfer ? accounts.find((a) => a.id === destAccountId) : null;
  const transferCrossCurrency = Boolean(
    transferSource && transferDest && transferSource.currency !== transferDest.currency,
  );

  const canSave = (() => {
    if (!(editableAmount > 0) || !accountId) return false;
    if ((isLoanGiven || isLoanTaken) && !contact.name.trim()) return false;
    if (isTransfer) {
      if (!destAccountId || destAccountId === accountId) return false;
      if (transferCrossCurrency && !(parseFloat(conversionRate) > 0)) return false;
    }
    if (!txDate) return false;
    return true;
  })();

  // Only send createdAt when the user actually changed the date — the stored
  // value keeps its original time-of-day otherwise.
  const editedCreatedAt = txDate && txDate !== origDate
    ? new Date(`${txDate}T12:00:00`).toISOString()
    : undefined;

  // A non-null original id that the user has since typed over creates a
  // different contact rather than renaming the existing one — surface that
  // so they don't do it unintentionally. Rename lives in a later phase.
  const willCreateNewContact =
    (isLoanGiven || isLoanTaken) &&
    contact.id === null &&
    contact.name.trim() !== '' &&
    originalPersonId !== null;

  // Ref-backed entry re-check (audit F-8/D-1) shared by save/delete: the
  // `saving` STATE flag updates asynchronously, so two taps in one frame
  // both read it as false and would double-apply a balance reversal.
  // `saving` stays for the disabled/label UI.
  const handleSave = () => submitGuard.run(runSave);
  const handleDelete = () => submitGuard.run(runDelete);
  const handleDeleteSplit = () => submitGuard.run(runDeleteSplit);

  const runSave = async () => {
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
          createdAt: editedCreatedAt,
        });
      } else if (isIncome) {
        await updateTransaction(transaction.id, {
          type: 'income',
          amount: editableAmount,
          destinationAccountId: accountId,
          category,
          notes,
          createdAt: editedCreatedAt,
        });
      } else if (isTransfer) {
        await updateTransaction(transaction.id, {
          type: 'transfer',
          amount: editableAmount,
          sourceAccountId: accountId,
          destinationAccountId: destAccountId,
          conversionRate: transferCrossCurrency ? parseFloat(conversionRate) : undefined,
          notes,
          createdAt: editedCreatedAt,
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
          createdAt: editedCreatedAt,
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
          createdAt: editedCreatedAt,
        });
      }

      toast.show({ type: 'success', title: t('tx_updated') });
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

  const runDelete = async () => {
    const snapshot = transaction;
    // One-tap Undo is only offered for the types restoreTransaction can
    // faithfully restore (expense/income — row + balance). For everything
    // else an "undone" row would come back WITHOUT its money effects and a
    // re-delete would reverse balances twice, minting money.
    const canUndo = snapshot.type === 'expense' || snapshot.type === 'income';
    setSaving(true);
    try {
      await deleteTransaction(transaction.id);
      onClose();
      toast.show(
        canUndo
          ? {
              type: 'success',
              title: t('tx_deleted'),
              action: {
                label: t('undo'),
                onPress: () => {
                  void restoreTransaction(snapshot).catch(() =>
                    toast.show({ type: 'error', title: t('undo_failed') }),
                  );
                },
              },
            }
          : {
              type: 'success',
              title: t('tx_deleted'),
              subtitle: t('tx_delete_no_undo_note'),
            },
      );
    } catch (error) {
      // The reversal was blocked because the credited money was since spent.
      // Real escape: let the user delete anyway, taking the account visibly
      // negative (correctable afterwards) instead of stranding the row.
      const blocked = error as Error & { code?: string; accountName?: string; balanceAfter?: number; accountCurrency?: string };
      if (blocked?.code === 'REVERSAL_NEEDS_NEGATIVE') {
        const after = formatSignedMoney(blocked.balanceAfter ?? 0, (blocked.accountCurrency || transaction.currency) as typeof transaction.currency);
        const ok = await confirmDestructive({
          title: t('del_anyway_title'),
          description: t('del_anyway_body')
            .replace(/\{account\}/g, blocked.accountName ?? '')
            .replace('{after}', after),
          confirmLabel: t('del_anyway_cta'),
          cancelLabel: t('not_now'),
          tone: 'warning',
        });
        if (ok) {
          try {
            await deleteTransaction(transaction.id, { allowNegative: true });
            onClose();
            toast.show({ type: 'success', title: t('tx_deleted'), subtitle: t('tx_delete_no_undo_note') });
          } catch (retryErr) {
            toast.show({
              type: 'error',
              title: t('error'),
              subtitle: retryErr instanceof Error ? retryErr.message : 'Failed',
            });
          }
        }
        setSaving(false);
        return;
      }
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: error instanceof Error ? error.message : 'Failed',
      });
    } finally {
      setSaving(false);
    }
  };

  // Delete every row of an ad-hoc split as one action: the payer's own share
  // AND each receivable. Removing only some of them would leave the account
  // debited for a bill that no longer exists in the ledger.
  const runDeleteSplit = async () => {
    if (splitRows.length === 0) return;
    if (splitSettledRow) {
      toast.show({ type: 'error', title: t('split_delete_blocked') });
      return;
    }
    const ok = await confirmDestructive({
      title: t('split_delete_event'),
      description: t('split_delete_confirm')
        .replace('{n}', String(splitRows.length))
        .replace('{label}', noteMeta.splitLabel || t('tx_expense')),
      confirmLabel: t('tx_delete_entry'),
      cancelLabel: t('not_now'),
      tone: 'destructive',
    });
    if (!ok) return;

    setSaving(true);
    let done = 0;
    try {
      // Receivables first, own-share last — same reasoning as when writing the
      // split: if this stops halfway, the recoverable row is the one left over.
      const ordered = [...splitRows].sort((a, b) => Number(!!b.relatedLoanId) - Number(!!a.relatedLoanId));
      for (const row of ordered) {
        await deleteTransaction(row.id);
        done += 1;
      }
      onClose();
      toast.show({ type: 'success', title: t('tx_deleted'), subtitle: t('tx_delete_no_undo_note') });
    } catch (error) {
      toast.show({
        type: 'error',
        title: t('split_partial_title').replace('{done}', String(done)).replace('{total}', String(splitRows.length)),
        subtitle: error instanceof Error ? error.message : 'Failed',
        duration: 6000,
      });
      if (done > 0) onClose();
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
        title={t('tx_details_title')}
        footer={(
          // Group mirrors: the on-open probe decides. LIVE group expense →
          // delete disabled (route via the group screen); orphan whose group
          // was deleted → freely deletable (previously locked forever).
          // Ad-hoc splits delete as a whole event, never row by row.
          noteMeta.splitEventId ? (
            <button
              onClick={handleDeleteSplit}
              disabled={saving || !!splitSettledRow}
              className="w-full rounded-2xl bg-pay-50 text-pay-text py-3.5 text-sm font-bold disabled:opacity-40"
            >
              {saving ? t('quick_processing') : t('split_delete_event')}
            </button>
          ) : (
            <button
              onClick={handleDelete}
              disabled={saving || groupLive === true}
              className="w-full rounded-2xl bg-pay-50 text-pay-text py-3.5 text-sm font-bold disabled:opacity-40"
            >
              {saving ? t('quick_processing') : t('tx_delete_entry')}
            </button>
          )
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
          {source && <p className="text-[13px] text-ink-700">{t('label_from')} <span className="font-semibold">{source.name}</span></p>}
          {destination && <p className="text-[13px] text-ink-700">{t('label_to')} <span className="font-semibold">{destination.name}</span></p>}
          {transaction.relatedPerson && <p className="text-[13px] text-ink-700">{t('label_person')} <span className="font-semibold">{transaction.relatedPerson}</span></p>}
          {transaction.notes && <p className="text-[12px] text-ink-500">{parseInternalNote(transaction.notes).visibleNote}</p>}
          <p className="text-[12px] text-ink-500 bg-cream-soft rounded-xl p-3 leading-relaxed">
            {noteMeta.splitEventId ? t('split_locked_edit') : t('tx_readonly_note')}
          </p>
          {noteMeta.splitEventId && (
            <div className="rounded-2xl border border-cream-border bg-cream-card p-3.5 space-y-2">
              <p className="text-[10.5px] font-bold text-ink-500 uppercase tracking-widest">
                {t('split_ways').replace('{n}', noteMeta.splitPartyCount ?? String(splitRows.length))}
              </p>
              {splitRows.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3">
                  <span className="text-[12px] text-ink-700 truncate">
                    {row.type === 'expense' ? t('split_you') : row.relatedPerson ?? ''}
                  </span>
                  <span className={`text-[12px] font-semibold tabular-nums ${row.id === transaction.id ? 'text-accent-600' : 'text-ink-900'}`}>
                    {formatMoney(row.amount, row.currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {splitSettledRow && (
            <p className="text-[12px] text-warn-600 bg-warn-50 rounded-xl p-3 leading-relaxed">
              {t('split_delete_blocked')}
            </p>
          )}
          {noteMeta.groupExpenseId && groupLive !== false && (
            <p className="text-[12px] text-warn-600 bg-warn-50 rounded-xl p-3 leading-relaxed">
              {t('tx_group_expense_warn')}
            </p>
          )}
          {noteMeta.groupExpenseId && groupLive === false && (
            <p className="text-[12px] text-ink-600 bg-cream-soft rounded-xl p-3 leading-relaxed">
              {t('tx_group_orphan_note')}
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
      confirmClose={() => guardClose(isDirty)}
      footer={(
        <div className="flex gap-2">
          <button
            onClick={handleDelete}
            disabled={saving}
            aria-label={t('tx_delete_entry')}
            className="min-h-[44px] min-w-[44px] px-4 rounded-2xl bg-pay-50 text-pay-text active:bg-pay-100 transition-all disabled:opacity-50 flex items-center justify-center"
          >
            <Trash2 size={16} />
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !canSave}
            className="flex-1 bg-accent-600 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-accent-600/20"
          >
            {saving ? t('quick_processing') : t('save')}
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
          <label className="form-label">{t('amount_label')}</label>
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
            {isLoanTaken ? t('loan_received_into') : isIncome ? t('quick_to') : t('quick_from')}
          </label>
          <AccountSelect
            accounts={accounts}
            selectedId={accountId}
            onSelect={(id) => {
              setAccountId(id);
              // The main account can't also fund itself as a cash advance,
              // and a transfer can't target its own source.
              if (cashAdvanceCardId === id) setCashAdvanceCardId('');
              if (isTransfer && destAccountId === id) setDestAccountId('');
              setConversionRate('');
            }}
          />
        </div>

        {isTransfer && (
          <div>
            <label className="form-label">{t('quick_to')}</label>
            <AccountSelect
              accounts={accounts.filter((a) => a.id !== accountId)}
              selectedId={destAccountId}
              onSelect={(id) => {
                setDestAccountId(id);
                setConversionRate('');
              }}
            />
          </div>
        )}

        {isTransfer && transferCrossCurrency && transferSource && transferDest && (
          <div>
            <label className="form-label">
              {t('edit_rate_label')
                .replace('{src}', transferSource.currency)
                .replace('{dst}', transferDest.currency)}
            </label>
            <input
              type="number"
              step="0.0001"
              value={conversionRate}
              onChange={(event) => setConversionRate(event.target.value)}
              className="input-field text-center tabular-nums"
              placeholder="0.00"
            />
            {parseFloat(conversionRate) > 0 && editableAmount > 0 && (
              <p className="text-[11px] text-ink-500 mt-1.5 tabular-nums">
                {formatMoney(editableAmount, transferSource.currency)} → {formatMoney(Math.round(editableAmount * parseFloat(conversionRate) * 100) / 100, transferDest.currency)}
              </p>
            )}
          </div>
        )}

        <div>
          <label className="form-label">{t('edit_date_label')}</label>
          <input
            type="date"
            value={txDate}
            onChange={(event) => setTxDate(event.target.value)}
            className="input-field"
          />
          {txDate !== origDate && (
            <p className="text-[11px] text-ink-500 mt-1.5">{t('edit_date_hint')}</p>
          )}
        </div>

        {isLoanTaken && availableCashAdvanceCards.length > 0 && (
          <div>
            <label className="form-label">{t('cash_advance_source')}</label>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setCashAdvanceCardId('')}
                className={`w-full p-3 rounded-2xl border text-left text-[12px] font-semibold transition-all ${
                  !selectedCashAdvanceCard ? 'border-accent-500 bg-accent-50 text-accent-600' : 'border-cream-border bg-cream-card text-ink-500'
                }`}
              >
                {t('cash_advance_none')}
              </button>
              {availableCashAdvanceCards.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => setCashAdvanceCardId(account.id)}
                  className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                    selectedCashAdvanceCard?.id === account.id ? 'border-accent-500 bg-accent-50 shadow-sm shadow-accent-500/5' : 'border-cream-border bg-cream-card'
                  }`}
                >
                  <div>
                    <p className="text-[13px] font-semibold text-ink-800">{account.name}</p>
                    <p className="text-[10px] text-ink-500">{t('etm_credit_card')}</p>
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
              <p className="text-[11px] text-warn-600 mt-1.5">{t('etm_will_create_contact')}</p>
            )}
          </div>
        )}

        {(isExpense || isIncome) && (
          <div>
            <label className="form-label">{t('category')}</label>
            <CategoryPicker type={isIncome ? 'income' : 'expense'} value={category} onChange={setCategory} includeCurrent />
          </div>
        )}

        <div>
          <label className="form-label">{t('quick_note')}</label>
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="input-field"
            placeholder={t('quick_note_placeholder')}
          />
        </div>

        <ReceiptField
          transactionId={transaction.id}
          receiptPath={receiptPath}
          onChange={(path) => void handleReceiptChange(path)}
        />
      </div>
    </Modal>
  );
}
