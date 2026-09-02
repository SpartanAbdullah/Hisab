import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { useSubmitGuard } from '../lib/useSubmitGuard';
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
import { clampCardCredit } from '../lib/cardCredit';
import { isLoanRemainingConflict } from '../lib/loanRemainingDelta';
import { useToast } from '../components/Toast';
import { AccountSelect } from '../components/AccountSelect';
import { CurrencyConversionCard } from '../components/CurrencyConversionCard';
import { rateIsSane, RATE_MIN } from '../lib/conversionMath';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import { track } from '../lib/telemetry';
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
  const { loans, applyRepayment, loadLoans } = useLoanStore();
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const appMode = useAppModeStore((s) => s.mode);
  const toast = useToast();
  const t = useT();
  const submitGuard = useSubmitGuard();
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
    setNotes(installmentNumber ? t('emi_note_paid').replace('{n}', String(installmentNumber)) : '');
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

  // Entry re-check lives in submitGuard (a ref, so two taps in one frame
  // can't both pass); `saving` stays purely for the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    const parsedAmount = parseFloat(amount);
    // Ledger-only mode has no account picker — requiring accountId here made
    // the Record payment button silently dead in that mode (canSubmit enabled
    // it, this line swallowed the tap). Account is only a tracker-mode need.
    if (!parsedAmount || (!isLedgerOnlyMode && !accountId)) return;
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
        await applyRepayment(loan.id, parsedAmount, notes);
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
          // Mirror the store's clamp: the card only receives what its limit
          // still allows — a bill already paid by transfer receives nothing.
          const { credited } = clampCardCredit(cashAdvanceCard, parsedAmount);
          if (credited > 0) {
            changes.push({
              accountName: cashAdvanceCard.name,
              currency: cashAdvanceCard.currency,
              before: cashAdvanceCard.balance,
              after: cashAdvanceCard.balance + credited,
            });
          }
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

      // Catalog #12. Fires only once the commit above has actually succeeded.
      // `emiId` payments are one instalment of a schedule, never "consolidated"
      // (that term is reserved for the cross-loan lump allocator).
      track('repayment_recorded', {
        consolidated: false,
        settles_loan: parsedAmount >= loan.remainingAmount - 0.00001,
        mode: isLedgerOnlyMode ? 'splits_only' : 'full_tracker',
        currency: loan.currency,
      });
      setConfirmData({
        title: t('title_done').replace('{label}', isInstallmentPayment ? t('loan_mark_paid') : t('loan_repay')),
        description: (isGiven ? t('repay_done_received_from') : t('repay_done_paid_to'))
          .replace('{amount}', formatMoney(parsedAmount, loan.currency))
          .replace('{person}', resolvePersonName({ personId: loan.personId, fallback: loan.personName })),
        changes,
      });
      setShowConfirmation(true);
      setAmount('');
      setAccountId('');
      setConversionRate('');
      setNotes('');
    } catch (err) {
      // Audit C10: both repayment paths can now refuse a stale write (another
      // device moved this loan, or deleted it). The message already explains
      // it; pull the loan back from truth so the remaining figure on screen —
      // and the overpayment guard reading it — is the one they must re-enter
      // against, instead of the stale number that just failed.
      if (isLoanRemainingConflict(err)) void loadLoans();
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
                    {t('repay_emi_number').replace('{n}', String(installmentNumber))}
                  </p>
                ) : null}
                <p className="text-lg font-bold tabular-nums tracking-tight mt-1 text-ink-900">
                  {formatMoney(loan.remainingAmount, loan.currency)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-ink-500">{t('label_total')}</p>
                <p className="text-[13px] font-semibold text-ink-500 tabular-nums">
                  {formatMoney(loan.totalAmount, loan.currency)}
                </p>
              </div>
            </div>
          </div>

          {/* Always-visible bulk hand-off: a person with several loans is ONE
              thing to pay back — don't make the user discover this only by
              overtyping the amount. */}
          {canOfferOverflow && (
            <button
              type="button"
              onClick={() => setShowAllocateOverflow(true)}
              className="w-full rounded-2xl border border-accent-100 bg-accent-50 py-3 px-4 flex items-center justify-between gap-2 press"
            >
              <span className="text-[12px] font-semibold text-accent-600 text-left">
                {t('repay_pay_all_cta').replace('{n}', String(siblingLoans.length + 1))}
              </span>
              <span className="text-[12px] font-bold text-accent-600 tabular-nums shrink-0">
                {formatMoney(totalRemaining([loan, ...siblingLoans]), loan.currency)}
              </span>
            </button>
          )}

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
                  className="flex-1 min-h-[44px] rounded-xl bg-cream-soft border border-cream-border text-[12px] font-semibold text-ink-700 press"
                >
                  {t('repay_full')}
                </button>
                <button
                  type="button"
                  onClick={() => setAmount(String(Math.round((loan.remainingAmount / 2) * 100) / 100))}
                  className="flex-1 min-h-[44px] rounded-xl bg-cream-soft border border-cream-border text-[12px] font-semibold text-ink-700 press"
                >
                  {t('repay_half')}
                </button>
                {installmentAmount != null && (
                  <button
                    type="button"
                    onClick={() => setAmount(String(installmentAmount))}
                    className="flex-1 min-h-[44px] rounded-xl bg-accent-50 border border-accent-100 text-[12px] font-semibold text-accent-600 press"
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
                {t('repay_full_amount').replace('{amount}', formatMoney(loan.remainingAmount, loan.currency))}
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
                  className="w-full rounded-xl bg-ink-900 text-white py-2.5 text-[12px] font-semibold press"
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
              preferredCurrency={loan.currency}
              onSelect={(id) => {
                setAccountId(id);
                // A different account can mean a different currency — the
                // previous conversion no longer applies.
                setConversionRate('');
              }}
            />
          </div>
          )}

          {/* Cash-advance guard rail: when the funding card's bill is already
              (partly) covered, say so BEFORE the user pays — the card will not
              be credited past its limit, and a fully covered bill means this
              payment only updates the loan record. */}
          {!isLedgerOnlyMode && !isGiven && cashAdvanceCard && cashAdvanceCard.currency === loan.currency && parseFloat(amount) > 0 && (() => {
            const preview = clampCardCredit(cashAdvanceCard, parseFloat(amount));
            if (preview.skipped <= 0) return null;
            return (
              <div className="rounded-2xl bg-warn-50 border border-warn-100 p-3">
                <p className="text-[11.5px] text-warn-600 leading-relaxed font-medium">
                  {preview.credited <= 0
                    ? t('repay_card_covered_full').replace('{card}', cashAdvanceCard.name)
                    : t('repay_card_covered_partial')
                        .replace('{card}', cashAdvanceCard.name)
                        .replace('{amount}', formatMoney(preview.credited, cashAdvanceCard.currency))}
                </p>
              </div>
            );
          })()}

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
              placeholder={t('quick_note_placeholder')}
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
