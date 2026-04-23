import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { usePersonStore } from '../stores/personStore';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from '../components/Toast';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import type { Loan } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  loan: Loan;
}

// Phase 2C-A: ledger-only settlement. Shown only for linked loans where the
// current user is the debtor (loan.type === 'taken'). Non-linked loans use
// the existing RepaymentModal, unchanged.
export function SettleLinkedLoanModal({ open, onClose, loan }: Props) {
  const { createRequest } = useSettlementRequestStore();
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const persons = usePersonStore((s) => s.persons);
  const { accounts, loadAccounts } = useAccountStore();
  const toast = useToast();
  const t = useT();

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Phase 2C-B: sender-side optional apply-to-balance.
  const [applyToBalance, setApplyToBalance] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState('');

  useEffect(() => {
    if (open) {
      // Prefill with the full remaining by default; user can reduce for partial.
      setAmount(String(loan.remainingAmount));
      setNote('');
      setError('');
      setApplyToBalance(false);
      setSelectedAccountId('');
      void loadAccounts();
    }
  }, [open, loan.remainingAmount, loadAccounts]);

  // Currency-strict filter: only the loan's currency is eligible.
  const eligibleAccounts = useMemo(
    () => accounts.filter((a) => a.currency === loan.currency),
    [accounts, loan.currency],
  );
  const hasEligibleAccounts = eligibleAccounts.length > 0;

  // Resolve the counterparty name for the header.
  const counterpartyName = (() => {
    if (loan.personId) {
      const p = persons.find((x) => x.id === loan.personId);
      if (p) return p.name;
    }
    return loan.personName || t('ltr_unknown_person');
  })();

  // Find the accepted linked_transaction_request that birthed this loan.
  // The request stores both mirrored loan ids; we match on either side and
  // require status='accepted'. That row's id == loan_pair_id we need, and
  // it also gives us requesterLoanId / responderLoanId / both user ids.
  const pair = (() => {
    return linkedRequests.find(
      (r) =>
        r.status === 'accepted' &&
        (r.requesterLoanId === loan.id || r.responderLoanId === loan.id),
    ) ?? null;
  })();

  const canSubmit = (() => {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return false;
    if (amt - loan.remainingAmount > 0.00001) return false;
    if (!pair) return false;
    // If opt-in is on, an eligible account must be selected. Otherwise the
    // submit is ledger-only and always allowed.
    if (applyToBalance) {
      if (!selectedAccountId) return false;
      if (!eligibleAccounts.some((a) => a.id === selectedAccountId)) return false;
    }
    return true;
  })();

  const handleSubmit = async () => {
    if (!pair || !pair.requesterLoanId || !pair.responderLoanId) {
      setError(t('stl_create_error'));
      return;
    }
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt - loan.remainingAmount > 0.00001) {
      setError(t('stl_amount_invalid'));
      return;
    }

    // Determine which side of the pair belongs to the current user (the
    // debtor in 2C-A). The request-row fields are "requester" / "responder"
    // from the POV of the person who sent the ORIGINAL 2B request — not the
    // settlement. Map accordingly.
    const meIsRequester = pair.requesterLoanId === loan.id;
    const requesterLoanIdForSettlement = loan.id;
    const responderLoanIdForSettlement: string = meIsRequester ? pair.responderLoanId : pair.requesterLoanId;
    const counterpartyUserId = meIsRequester ? pair.toUserId : pair.fromUserId;

    setSaving(true);
    setError('');
    try {
      const requesterAccountId = applyToBalance && selectedAccountId ? selectedAccountId : null;
      await createRequest({
        loanPairId: pair.id,
        requesterLoanId: requesterLoanIdForSettlement,
        responderLoanId: responderLoanIdForSettlement,
        toUserId: counterpartyUserId,
        amount: amt,
        currency: loan.currency,
        note,
        requesterAccountId,
      });
      toast.show({ type: 'success', title: t('stl_sent_title'), subtitle: t('stl_sent_subtitle') });
      onClose();
    } catch {
      setError(t('stl_create_error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('stl_title').replace('{name}', counterpartyName)}
      footer={
        <button
          onClick={handleSubmit}
          disabled={saving || !canSubmit}
          className="cta-primary"
        >
          {saving ? t('stl_sending') : t('stl_send')}
        </button>
      }
    >
      <div className="space-y-4">
        <div className="bg-slate-50/80 rounded-2xl p-3.5 border border-slate-100/60">
          <p className="text-[13px] text-slate-600">
            {t('stl_direction_paying_to')
              .replace('{name}', counterpartyName)
              .replace('{amount}', formatMoney(parseFloat(amount) || 0, loan.currency))}
          </p>
        </div>

        <div>
          <label className="form-label">
            {t('stl_amount_label')}
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input-field text-center text-lg font-bold tabular-nums"
          />
          <p className="text-[11px] text-slate-400 mt-1.5">
            {t('stl_amount_hint').replace('{remaining}', formatMoney(loan.remainingAmount, loan.currency))}
          </p>
        </div>

        <div>
          <label className="form-label">
            {t('stl_note_label')}
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="input-field"
            placeholder=""
          />
        </div>

        {/* Phase 2C-B: sender-side opt-in toggle + account picker. */}
        <label className={`flex items-center gap-2.5 p-3 rounded-2xl border ${
          hasEligibleAccounts
            ? 'bg-slate-50/80 border-slate-100/60 cursor-pointer'
            : 'bg-slate-50/50 border-slate-100/60 opacity-60 cursor-not-allowed'
        }`}>
          <input
            type="checkbox"
            checked={applyToBalance}
            disabled={!hasEligibleAccounts}
            onChange={(e) => {
              setApplyToBalance(e.target.checked);
              if (!e.target.checked) setSelectedAccountId('');
            }}
            className="w-4 h-4 rounded border-slate-300 text-indigo-600 accent-indigo-600"
          />
          <span className="text-[13px] text-slate-600 font-medium flex-1">
            {t('stl_apply_toggle_label')}
          </span>
        </label>

        {hasEligibleAccounts ? (
          <p className="text-[11px] text-slate-400 -mt-2">{t('stl_apply_toggle_hint')}</p>
        ) : (
          <p className="text-[11px] text-amber-600 -mt-2">{t('stl_apply_no_eligible')}</p>
        )}

        {applyToBalance && hasEligibleAccounts ? (
          <div>
            <label className="form-label">
              {t('stl_apply_pick_account')}
            </label>
            <div className="space-y-2">
              {eligibleAccounts.map((a) => {
                const meta = currencyMeta[a.currency];
                const isSelected = selectedAccountId === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setSelectedAccountId(a.id)}
                    className={isSelected ? 'selector-base selector-selected' : 'selector-base'}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{meta?.flag}</span>
                      <div>
                        <p className="text-[13px] font-semibold text-slate-700">{a.name}</p>
                        <p className="text-[10px] text-slate-400 capitalize">{a.type.replace('_', ' ')}</p>
                      </div>
                    </div>
                    <p className="text-[13px] font-bold text-slate-700 tabular-nums">
                      {formatMoney(a.balance, a.currency)}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {applyToBalance && selectedAccountId ? (
          <p className="text-[12px] text-amber-700 bg-amber-50/70 rounded-2xl p-3 leading-relaxed">
            {t('stl_apply_reduce_hint')}
          </p>
        ) : (
          <p className="text-[12px] text-indigo-700 bg-indigo-50/70 rounded-2xl p-3 leading-relaxed">
            {t('stl_ledger_only_hint')}
          </p>
        )}

        {error && (
          <p className="text-[12px] text-red-500 font-semibold bg-red-50 rounded-xl p-3">{error}</p>
        )}
      </div>
    </Modal>
  );
}
