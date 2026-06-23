import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useAppModeStore } from '../stores/appModeStore';
import { ConfirmationSheet } from '../components/ConfirmationSheet';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { useToast } from '../components/Toast';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
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
}

export function RepaymentModal({
  open,
  onClose,
  loan,
  emiId,
  presetAmount,
  lockAmount = false,
  installmentNumber,
}: Props) {
  const { accounts } = useAccountStore();
  const { processTransaction, getByLoan } = useTransactionStore();
  const { applyRepayment } = useLoanStore();
  const appMode = useAppModeStore((s) => s.mode);
  const toast = useToast();
  const t = useT();

  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
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

  // Conversion-rate sanity bounds. A typo'd rate of 0.0001 or 999999
  // would silently corrupt a balance, so we reject anything outside a
  // sane window. Real-world rates for AED/PKR/USD/EUR sit between
  // 0.005 and 350, well within these bounds.
  const RATE_MIN = 0.0001;
  const RATE_MAX = 100000;

  const canSubmit = () => {
    const parsedAmount = parseFloat(amount);
    if (!(parsedAmount > 0)) return false;
    // Block overpayment at the canSubmit gate. transactionStore.ts:230
    // silently clamps `remainingAmount` to 0, which would drop the
    // overage with no user feedback — unacceptable for a money app.
    if (parsedAmount > loan.remainingAmount + 0.00001) return false;
    if (!isLedgerOnlyMode && !accountId) return false;
    if (!isLedgerOnlyMode && isCrossCurrency) {
      const r = parseFloat(conversionRate);
      if (!(r >= RATE_MIN && r <= RATE_MAX)) return false;
    }
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

  const rateValidationMsg = (() => {
    if (!isCrossCurrency) return null;
    const r = parseFloat(conversionRate);
    if (!conversionRate) return null;
    if (r < RATE_MIN) return t('err_rate_too_low');
    if (r > RATE_MAX) return t('err_rate_too_high');
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
      if (!(r >= RATE_MIN && r <= RATE_MAX)) {
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
        open={open && !showConfirmation}
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
          </div>

          {!isLedgerOnlyMode && (
          <div>
            <label className="form-label">
              {isGiven ? t('repay_receive_in') : t('repay_pay_from')}
            </label>
            <div className="space-y-2">
              {accounts.map((account) => {
                const meta = currencyMeta[account.currency];
                return (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => {
                      setAccountId(account.id);
                      setConversionRate('');
                    }}
                    className={accountId === account.id ? 'selector-base selector-selected' : 'selector-base'}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{meta?.flag}</span>
                      <div>
                        <p className="text-[13px] font-semibold text-ink-800">{account.name}</p>
                        <p className="text-[10px] text-ink-500 capitalize">{account.type.replace('_', ' ')}</p>
                      </div>
                    </div>
                    <p className="text-[13px] font-bold text-ink-800 tabular-nums">
                      {formatSignedMoney(account.balance, account.currency)}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {!isLedgerOnlyMode && isCrossCurrency && selectedAccount ? (
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl p-4 border border-blue-100/60 space-y-3 animate-fade-in">
              <p className="text-[11px] font-bold text-blue-600 uppercase tracking-widest">{t('conv_title')}</p>
              <p className="text-[12px] text-ink-700">
                Loan: <span className="font-bold">{loan.currency}</span> - Account: <span className="font-bold">{selectedAccount.currency}</span>
              </p>
              <div>
                <label className="block text-[11px] font-bold text-ink-500 mb-1.5">
                  {t('conv_rate')} 1 {loan.currency} = ___ {selectedAccount.currency}
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={conversionRate}
                  onChange={(event) => setConversionRate(event.target.value)}
                  placeholder="e.g. 78.50"
                  className="input-field"
                />
                {rateValidationMsg && (
                  <p className="mt-1.5 text-[11px] text-pay-text font-semibold leading-relaxed">
                    {rateValidationMsg}
                  </p>
                )}
              </div>
              {conversionRate && parseFloat(conversionRate) > 0 && parseFloat(amount) > 0 ? (
                <div className="bg-cream-card rounded-xl p-3 text-center border border-blue-100/60 animate-fade-in">
                  <p className="text-[10px] text-ink-500">{isGiven ? t('conv_will_get') : 'Will deduct'}</p>
                  <p className="text-lg font-bold text-receive-text tabular-nums">
                    {isGiven
                      ? formatMoney(Math.round(parseFloat(amount) * parseFloat(conversionRate) * 100) / 100, selectedAccount.currency)
                      : formatMoney(Math.round(parseFloat(amount) / parseFloat(conversionRate) * 100) / 100, selectedAccount.currency)}
                  </p>
                </div>
              ) : null}
            </div>
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
        }}
        title={confirmData.title}
        description={confirmData.description}
        balanceChanges={confirmData.changes}
      />
    </>
  );
}
