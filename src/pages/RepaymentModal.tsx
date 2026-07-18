import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useAppModeStore } from '../stores/appModeStore';
import { AllocateRepaymentModal } from '../components/AllocateRepaymentModal';
import { linkedLoanIdSet } from '../lib/linkedLoanIdSet';
import { totalRemaining } from '../lib/repaymentAllocation';
import { ConfirmationSheet } from '../components/ConfirmationSheet';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useToast } from '../components/Toast';
import { AccountSelect } from '../components/AccountSelect';
import { CurrencyConversionCard } from '../components/CurrencyConversionCard';
import { rateIsSane, RATE_MIN } from '../lib/conversionMath';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { resolvePersonName } from '../lib/resolvePersonName';
import type { Loan } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  loan: Loan;
  emiId?: string;
  presetAmount?: number;
  lockAmount?: boolean;
  installmentNumber?: number;
  // Fired once, after a repayment has committed and the user dismisses the
  // confirmation. Carries the amount just paid so the host can build a receipt
  // / offer to send an updated statement.
  onRepaid?: (info?: { amount: number }) => void;
}

export function RepaymentModal({
  open,
  onClose,
  loan,
  emiId,
  presetAmount,
  lockAmount = false,
  installmentNumber,
  onRepaid,
}: Props) {
  const { accounts } = useAccountStore();
  const { processTransaction, getByLoan } = useTransactionStore();
  const { loans, applyRepayment } = useLoanStore();
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const appMode = useAppModeStore((s) => s.mode);
  const toast = useToast();
  const t = useT();
  // Captured at commit so onRepaid can report the amount after the fields reset.
  const lastAmountRef = useRef(0);

  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showAllocateOverflow, setShowAllocateOverflow] = useState(false);
  const [confirmData, setConfirmData] = useState<{
    title: string;
    description: string;
    changes: Array<{ accountName: string; currency: string; before: number; after: number }>;
  }>({ title: '', description: '', changes: [] });

  const isGiven = loan.type === 'given';
  const isLedgerOnlyMode = appMode === 'splits_only';
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const cashAdvanceTransaction = getByLoan(loan.id).find(
    (transaction) => transaction.type === 'loan_taken' && Boolean(transaction.sourceAccountId),
  );
  const cashAdvanceCard = cashAdvanceTransaction?.sourceAccountId
    ? accounts.find((account) => account.id === cashAdvanceTransaction.sourceAccountId)
    : null;
  const isCrossCurrency = selectedAccount ? selectedAccount.currency !== loan.currency : false;
  const isInstallmentPayment = Boolean(emiId);
  const installmentAmount = presetAmount != null ? Math.min(presetAmount, loan.remainingAmount) : undefined;

  // When the typed amount exceeds THIS loan but the person has other active
  // loans of the same currency + direction, don't dead-end on the overpayment
  // error — offer to spread the lump across them (oldest first). Linked loans
  // are excluded: they settle via the cross-user confirm flow. Instalment
  // payments (locked amount / emiId) never overflow by design.
  const linkedLoanIds = linkedLoanIdSet(linkedRequests);
  const loanPersonKey = loan.personId ?? loan.personName.trim().toLowerCase();
  const siblingLoans = loans.filter((l) =>
    l.id !== loan.id &&
    l.status === 'active' &&
    l.type === loan.type &&
    l.currency === loan.currency &&
    (l.personId ?? l.personName.trim().toLowerCase()) === loanPersonKey &&
    l.remainingAmount > 0.01 &&
    !linkedLoanIds.has(l.id),
  );
  const canOfferOverflow = !lockAmount && !emiId && !linkedLoanIds.has(loan.id) && siblingLoans.length > 0;

  useEffect(() => {
    if (!open) return;
    setAmount(installmentAmount != null ? String(installmentAmount) : '');
    setAccountId('');
    setConversionRate('');
    setNotes(installmentNumber ? `EMI #${installmentNumber} paid` : '');
  }, [installmentAmount, installmentNumber, open]);

  const handleClose = () => {
    setAmount('');
    setAccountId('');
    setConversionRate('');
    setNotes('');
    onClose();
  };

  const canSubmit = () => {
    const parsedAmount = parseFloat(amount);
    if (!(parsedAmount > 0)) return false;
    // Block overpayment at the canSubmit gate. transactionStore.ts:230
    // silently clamps `remainingAmount` to 0, which would drop the
    // overage with no user feedback — unacceptable for a money app.
    if (parsedAmount > loan.remainingAmount + 0.00001) return false;
    if (!isLedgerOnlyMode && !accountId) return false;
    if (!isLedgerOnlyMode && isCrossCurrency && !rateIsSane(parseFloat(conversionRate))) return false;
    return true;
  };

  // Used by the inline error hint below the amount input.
  const amountValidationMsg = (() => {
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount) return null;
    if (parsedAmount > loan.remainingAmount + 0.00001) {
      return t('err_overpayment').replace('{remaining}', formatMoney(loan.remainingAmount, loan.currency));
    }
    return null;
  })();

  const handleSubmit = async () => {
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || !accountId) return;
    // Defense-in-depth: even if canSubmit was bypassed somehow, refuse
    // overpayments and out-of-bounds rates at the action layer.
    if (parsedAmount > loan.remainingAmount + 0.00001) {
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: t('err_overpayment').replace('{remaining}', formatMoney(loan.remainingAmount, loan.currency)),
      });
      return;
    }
    if (!isLedgerOnlyMode && isCrossCurrency) {
      const r = parseFloat(conversionRate);
      if (!rateIsSane(r)) {
        toast.show({
          type: 'error',
          title: t('error'),
          subtitle: r < RATE_MIN ? t('err_rate_too_low') : t('err_rate_too_high'),
        });
        return;
      }
    }

    // Phase H2: re-state what's about to happen so the user can catch a
    // wrong-loan tap before it commits. Direction-aware copy mirrors the
    // modal title — they should read identically.
    const personName = resolvePersonName({ personId: loan.personId, fallback: loan.personName });
    const amountLabel = formatMoney(parsedAmount, loan.currency);
    const body = isGiven
      ? t('confirm_repayment_body_received').replace('{person}', personName).replace('{amount}', amountLabel)
      : t('confirm_repayment_body_paid').replace('{person}', personName).replace('{amount}', amountLabel);
    const ok = await confirmDestructive({
      title: t('confirm_repayment_title'),
      description: body,
      confirmLabel: t('confirm_repayment_yes'),
      cancelLabel: t('confirm_repayment_no'),
      tone: 'warning',
    });
    if (!ok) return;
    lastAmountRef.current = parsedAmount;

    setSaving(true);
    try {
      const changes: Array<{ accountName: string; currency: string; before: number; after: number }> = [];
      const account = isLedgerOnlyMode ? null : accounts.find((entry) => entry.id === accountId);
      if (!isLedgerOnlyMode && !account) throw new Error('Account not found');

      const rate = parseFloat(conversionRate) || undefined;

      if (isLedgerOnlyMode) {
        await applyRepayment(loan.id, parsedAmount);
      } else if (isGiven) {
        if (!account) throw new Error('Account not found');
        const addedAmount = isCrossCurrency && rate ? Math.round(parsedAmount * rate * 100) / 100 : parsedAmount;
        changes.push({
          accountName: account.name,
          currency: account.currency,
          before: account.balance,
          after: account.balance + addedAmount,
        });
        await processTransaction({
          type: 'repayment',
          amount: parsedAmount,
          loanId: loan.id,
          destinationAccountId: accountId,
          emiId,
          conversionRate: isCrossCurrency ? rate : undefined,
          notes,
        });
      } else {
        if (!account) throw new Error('Account not found');
        const deductedAmount = isCrossCurrency && rate ? Math.round(parsedAmount / rate * 100) / 100 : parsedAmount;
        changes.push({
          accountName: account.name,
          currency: account.currency,
          before: account.balance,
          after: account.balance - deductedAmount,
        });
        if (cashAdvanceCard && cashAdvanceCard.currency === loan.currency) {
          changes.push({
            accountName: cashAdvanceCard.name,
            currency: cashAdvanceCard.currency,
            before: cashAdvanceCard.balance,
            after: cashAdvanceCard.balance + parsedAmount,
          });
        }
        await processTransaction({
          type: 'repayment',
          amount: parsedAmount,
          loanId: loan.id,
          sourceAccountId: accountId,
          emiId,
          conversionRate: isCrossCurrency ? rate : undefined,
          notes,
        });
      }

      setConfirmData({
        title: `${isInstallmentPayment ? t('loan_mark_paid') : t('loan_repay')} - Done!`,
        description: `${formatMoney(parsedAmount, loan.currency)} ${isGiven ? 'received from' : 'repaid to'} ${resolvePersonName({ personId: loan.personId, fallback: loan.personName })}`,
        changes,
      });
      setShowConfirmation(true);
      setAmount('');
      setAccountId('');
      setConversionRate('');
      setNotes('');
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !showConfirmation && !showAllocateOverflow}
        onClose={handleClose}
        title={(() => {
          const personName = resolvePersonName({ personId: loan.personId, fallback: loan.personName });
          // Direction-aware title. On a `given` loan, the OTHER person is
          // doing the paying ("Ali is paying you back"). On a `taken` loan,
          // the user is paying ("You're paying Ali back").
          const key = loan.type === 'given' ? 'repay_they_paying_title' : 'repay_you_paying_title';
          return t(key).replace('{person}', personName);
        })()}
        footer={
          <button
            onClick={handleSubmit}
            disabled={saving || !canSubmit()}
            className="cta-primary"
          >
            {saving
              ? t('repay_paying')
              : isInstallmentPayment
              ? t('loan_mark_paid')
              : /* Direction-aware: on a given loan we're recording money
                   coming back to us; on a taken loan we're recording a
                   payment going out. */
                isGiven
              ? t('repay_record_received')
              : t('repay_record_paid')}
          </button>
        }
      >
        <div className="space-y-4">
          <div className={`rounded-2xl p-4 border ${isGiven ? 'bg-receive-50/50 border-receive-100' : 'bg-pay-50 border-pay-100'}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-bold text-ink-500 uppercase tracking-widest">
                  {isGiven ? t('loan_receivable') : t('loan_payable')}
                </p>
                {installmentNumber ? (
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-500 mt-1">
                    EMI #{installmentNumber}
                  </p>
                ) : null}
                <p className="text-lg font-bold tabular-nums tracking-tight mt-1 text-ink-900">
                  {formatMoney(loan.remainingAmount, loan.currency)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-ink-500">Total</p>
                <p className="text-[13px] font-semibold text-ink-500 tabular-nums">
                  {formatMoney(loan.totalAmount, loan.currency)}
                </p>
              </div>
            </div>
          </div>

          <div>
            <label className="form-label">
              {(lockAmount ? t('loan_installment_amount') : t('repay_amount'))} ({loan.currency})
            </label>
            {/* Quick-fill chips — Full / Half / (when an EMI instalment is
                known) Next instalment. Each is a >=44px tap target so a
                thumb can hit it cleanly. Hidden when the amount is locked
                to a specific EMI. */}
            {!lockAmount ? (
              <div className="flex gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => setAmount(String(loan.remainingAmount))}
                  className="flex-1 min-h-[44px] rounded-xl bg-cream-soft border border-cream-border text-[12px] font-semibold text-ink-700 active:scale-[0.97] transition-transform"
                >
                  {t('repay_full')}
                </button>
                <button
                  type="button"
                  onClick={() => setAmount(String(Math.round((loan.remainingAmount / 2) * 100) / 100))}
                  className="flex-1 min-h-[44px] rounded-xl bg-cream-soft border border-cream-border text-[12px] font-semibold text-ink-700 active:scale-[0.97] transition-transform"
                >
                  {t('repay_half')}
                </button>
                {installmentAmount != null && (
                  <button
                    type="button"
                    onClick={() => setAmount(String(installmentAmount))}
                    className="flex-1 min-h-[44px] rounded-xl bg-accent-50 border border-accent-100 text-[12px] font-semibold text-accent-600 active:scale-[0.97] transition-transform"
                  >
                    {t('repay_next')}
                  </button>
                )}
              </div>
            ) : null}
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              disabled={lockAmount}
              className="input-field text-center text-xl font-bold tabular-nums disabled:bg-cream-soft disabled:text-ink-500 disabled:cursor-not-allowed"
              autoFocus
            />
            {!lockAmount ? (
              <button
                type="button"
                onClick={() => setAmount(String(loan.remainingAmount))}
                className="mt-2 text-[11px] text-accent-600 font-bold active:opacity-70"
              >
                Full amount: {formatMoney(loan.remainingAmount, loan.currency)}
              </button>
            ) : null}
            {amountValidationMsg && (
              <p className="mt-2 text-[11px] text-pay-text font-semibold leading-relaxed">
                {amountValidationMsg}
              </p>
            )}
            {amountValidationMsg && canOfferOverflow && (
              <div className="mt-2 rounded-2xl bg-accent-50 border border-accent-100 p-3 space-y-2.5">
                <p className="text-[11px] text-accent-600 leading-relaxed">
                  {t('repay_overflow_body')
                    .replace('{person}', resolvePersonName({ personId: loan.personId, fallback: loan.personName }))
                    .replace('{n}', String(siblingLoans.length))
                    .replace('{total}', formatMoney(totalRemaining(siblingLoans), loan.currency))}
                </p>
                <button
                  type="button"
                  onClick={() => setShowAllocateOverflow(true)}
                  className="w-full rounded-xl bg-ink-900 text-white py-2.5 text-[12px] font-semibold active:scale-[0.98] transition-transform"
                >
                  {t('repay_overflow_cta')}
                </button>
              </div>
            )}
          </div>

          {!isLedgerOnlyMode && (
          <div>
            <label className="form-label">
              {isGiven ? t('repay_receive_in') : t('repay_pay_from')}
            </label>
            <AccountSelect
              accounts={accounts}
              selectedId={accountId}
              onSelect={(id) => {
                setAccountId(id);
                // A different account can mean a different currency — the
                // previous conversion no longer applies.
                setConversionRate('');
              }}
            />
          </div>
          )}

          {/* Cross-currency: the user types what actually landed in (or left)
              the account; the rate is derived. The old free-form rate input's
              label asked for the opposite direction from the store math on
              'taken' loans — a direction the user can no longer get wrong. */}
          {!isLedgerOnlyMode && isCrossCurrency && selectedAccount && parseFloat(amount) > 0 ? (
            <CurrencyConversionCard
              knownAmount={parseFloat(amount)}
              knownCurrency={loan.currency}
              otherCurrency={selectedAccount.currency}
              otherSide={isGiven ? 'receiving' : 'paying'}
              rateSemantics={isGiven ? 'other-per-known' : 'known-per-other'}
              rate={conversionRate}
              onRateChange={setConversionRate}
            />
          ) : null}

          <div>
            <label className="form-label">
              {t('quick_note')}
            </label>
            <input
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional..."
              className="input-field"
            />
          </div>

          {!isLedgerOnlyMode && (
            <p className="text-[12px] text-ink-500 bg-cream-soft/80 border border-cream-hairline rounded-2xl p-3 leading-relaxed">
              {t('money_not_moved_notice')}
            </p>
          )}
        </div>
      </Modal>

      <ConfirmationSheet
        open={showConfirmation}
        onClose={() => {
          setShowConfirmation(false);
          onClose();
          // Nudge the statement/receipt send only after a successful commit —
          // this sheet is shown solely on the success path.
          onRepaid?.({ amount: lastAmountRef.current });
        }}
        title={confirmData.title}
        description={confirmData.description}
        balanceChanges={confirmData.changes}
      />

      {/* Overflow hand-off: the lump the user typed, pre-filled, spread
          oldest-first across this loan + the person's other active loans. */}
      <AllocateRepaymentModal
        open={open && showAllocateOverflow}
        onClose={() => setShowAllocateOverflow(false)}
        loans={[loan, ...siblingLoans]}
        direction={loan.type}
        currency={loan.currency}
        personName={resolvePersonName({ personId: loan.personId, fallback: loan.personName })}
        initialLump={parseFloat(amount) > 0 ? parseFloat(amount) : undefined}
        initialStrategy="oldest"
        initialAccountId={selectedAccount && selectedAccount.currency === loan.currency ? accountId : undefined}
        onDone={(info) => {
          setShowAllocateOverflow(false);
          onRepaid?.({ amount: info?.totalApplied ?? 0 });
          handleClose();
        }}
      />
    </>
  );
}
