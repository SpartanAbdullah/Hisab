import { useEffect, useState } from 'react';
import { Users, Lock } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard, useSubmitIntentId } from '../lib/useSubmitGuard';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useEmiStore } from '../stores/emiStore';
import { useLoanStore } from '../stores/loanStore';
import { usePersonStore } from '../stores/personStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useAppModeStore } from '../stores/appModeStore';
import { ContactPicker, type ContactValue } from '../components/ContactPicker';
import { useToast } from '../components/Toast';
import { AccountSelect } from '../components/AccountSelect';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { decideLinkedBranch } from '../lib/linkedRequestBranch';
import { confirmCrossUserRequest } from '../lib/confirmCrossUserRequest';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { SUPPORTED_CURRENCIES, type Currency, type LoanType } from '../db';

interface Props { open: boolean; onClose: () => void; }

export function AddLoanModal({ open, onClose }: Props) {
  const { accounts, loadAccounts } = useAccountStore();
  const { processTransaction } = useTransactionStore();
  const { generateSchedule } = useEmiStore();
  const { loans, createLoan } = useLoanStore();
  const appMode = useAppModeStore((s) => s.mode);
  const isLedgerOnlyMode = appMode === 'splits_only';
  const toast = useToast();
  const t = useT();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();

  const [loanType, setLoanType] = useState<LoanType>('given');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  // UX-34: one helper, one fallback. See src/lib/primaryCurrency.ts.
  const [ledgerCurrency, setLedgerCurrency] = useState<Currency>(getPrimaryCurrency);
  const [cashAdvanceSourceId, setCashAdvanceSourceId] = useState('');
  const [notes, setNotes] = useState('');
  const [hasEmi, setHasEmi] = useState(false);
  const [installments, setInstallments] = useState('');
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  void loans;

  useEffect(() => {
    if (open && !isLedgerOnlyMode) {
      void loadAccounts();
    }
  }, [isLedgerOnlyMode, open, loadAccounts]);

  const destinationAccount = accounts.find((account) => account.id === accountId);
  const availableCashAdvanceCards = accounts.filter((account) => (
    account.type === 'credit_card' &&
    account.id !== accountId &&
    (!destinationAccount || account.currency === destinationAccount.currency)
  ));
  // Phase 2B: detect if the current form state will branch into a linked
  // request. Used purely to swap the CTA label and show an inline hint.
  const personInStore = contact.id
    ? usePersonStore.getState().persons.find((p) => p.id === contact.id) ?? null
    : null;
  const selectedAccount = accounts.find((a) => a.id === accountId);
  const requestCurrency = isLedgerOnlyMode ? ledgerCurrency : selectedAccount?.currency;
  const wouldBranchToLinked = !!(
    personInStore?.linkedProfileId &&
    requestCurrency
  );

  // UX-12 (audit 2026-09): the EMI section is NOT available on the linked
  // branch. That branch creates no loan on this device — accept_linked_request
  // mints the loan rows on both sides only when the counterparty confirms — so
  // there is nothing for generateSchedule() to attach a schedule to, and
  // linked_transaction_requests has no instalment columns to carry one across
  // (supabase-migration-phase2b-linked-requests.sql:7-26). The old code left
  // the section visible AND required here and then `return`ed before any
  // schedule generation: a user could configure 12 instalments, tap send, and
  // end up with no schedule on either side and no warning. We hide it and say
  // why instead. The typed values are parked, not cleared, so flipping back to
  // an unlinked contact restores them.
  const emiAvailable = !wouldBranchToLinked;
  const emiActive = hasEmi && emiAvailable;

  // Disable-until-valid: a positive amount, a name, an account (when tracking),
  // and — if an EMI plan is toggled on AND reachable — both EMI fields, so the
  // user can't think they set up instalments and silently get none.
  const parsedAmount = parseFloat(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const emiConfigured = !emiActive || (parseInt(installments) > 0 && !!startDate);
  const canSubmit = !!contact.name.trim() && amountValid && (isLedgerOnlyMode || !!accountId) && emiConfigured;
  const isDirty = !!contact.name.trim() || !!amount.trim() || !!notes.trim() || hasEmi;

  // One request id per submit intent: the same id survives a double tap and a
  // retry of an unchanged form (so a duplicate insert collides on the primary
  // key instead of mirroring a second debt onto the other user), and is
  // replaced the instant any field — or the modal's open state — changes.
  const nextRequestId = useSubmitIntentId(
    [open, loanType, contact.id ?? '', contact.name.trim(), amount, notes, accountId, ledgerCurrency].join('|'),
  );

  // Entry re-check lives in submitGuard (a ref, so two taps in one frame can't
  // both pass); `saving` stays purely for the disabled/label UI.
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    return submitGuard.run(runSubmit);
  };

  const runSubmit = async () => {
    setError('');
    const amt = parseFloat(amount);
    const trimmedName = contact.name.trim();
    if (!amountValid) { setError(t('val_need_amount')); return; }
    if (!trimmedName) { setError(t('val_need_name')); return; }
    if (!isLedgerOnlyMode && !accountId) { setError(t('val_pick_account')); return; }
    if (!emiConfigured) { setError(t('val_emi_incomplete')); return; }
    setSaving(true);
    try {
      const person = contact.id
        ? await ensureResolvedPerson(trimmedName, contact.id)
        : await usePersonStore.getState().findOrCreateByName(trimmedName);

      const txType = loanType === 'given' ? 'loan_given' : 'loan_taken';
      const branch = decideLinkedBranch({
        type: txType,
        person,
        requestCurrency,
      });

      if (branch.branch === true) {
        // Backstop for UX-12. `wouldBranchToLinked` (which drives whether the
        // EMI section renders) is a UI-level approximation of this decision:
        // it reads only the person already in the store and ignores
        // archivedAt, so a typed name that resolves to a linked person can
        // land here with hasEmi still true. Refuse loudly rather than drop the
        // plan — the same rule as the section-level hide above.
        if (hasEmi) { setError(t('ltr_emi_unavailable_body')); return; }
        // Deliberate confirm before mirroring a currency-locked record to them.
        const guard = await confirmCrossUserRequest({ amount: amt, currency: branch.currency, personName: person.name });
        if (guard.blockedReason) { setError(guard.blockedReason); return; }
        if (!guard.ok) return;
        await useLinkedRequestStore.getState().createRequest({
          toUserId: branch.toUserId,
          personId: branch.personId,
          kind: branch.kind,
          amount: amt,
          currency: branch.currency,
          note: notes,
          requestId: nextRequestId(),
        });
        toast.show({ type: 'success', title: t('ltr_sent_title'), subtitle: t('ltr_sent_subtitle') });
        setContact({ id: null, name: '' }); setAmount(''); setAccountId(''); setCashAdvanceSourceId(''); setNotes('');
        setHasEmi(false); setInstallments(''); setStartDate('');
        onClose();
        return;
      }

      if (isLedgerOnlyMode) {
        const loan = await createLoan({
          personName: person.name,
          personId: person.id,
          type: loanType,
          totalAmount: amt,
          currency: ledgerCurrency,
          notes,
        });
        if (emiActive && installments && startDate) {
          await generateSchedule({ loanId: loan.id, totalAmount: amt, installments: parseInt(installments), startDate });
        }
        setContact({ id: null, name: '' }); setAmount(''); setAccountId(''); setCashAdvanceSourceId(''); setNotes('');
        setHasEmi(false); setInstallments(''); setStartDate('');
        onClose();
        return;
      }

      const tx = await processTransaction(
        loanType === 'given'
          ? { type: 'loan_given', amount: amt, sourceAccountId: accountId, personName: person.name, personId: person.id, notes }
          : {
              type: 'loan_taken',
              amount: amt,
              destinationAccountId: accountId,
              sourceAccountId: cashAdvanceSourceId || undefined,
              personName: person.name,
              personId: person.id,
              notes,
            }
      );
      if (emiActive && tx.relatedLoanId && installments && startDate) {
        await generateSchedule({ loanId: tx.relatedLoanId, totalAmount: amt, installments: parseInt(installments), startDate });
      }
      setContact({ id: null, name: '' }); setAmount(''); setAccountId(''); setCashAdvanceSourceId(''); setNotes('');
      setHasEmi(false); setInstallments(''); setStartDate('');
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : t('ltr_create_error')); }
    finally { setSaving(false); }
  };

  // Fetch the full Person row (needed for linkedProfileId when the contact
  // was picked from the ContactPicker dropdown rather than typed fresh).
  async function ensureResolvedPerson(name: string, id: string) {
    const existing = usePersonStore.getState().persons.find((p) => p.id === id);
    if (existing) return existing;
    return usePersonStore.getState().findOrCreateByName(name);
  }

  return (
    <Modal open={open} onClose={onClose} title={t('loan_new')}
      confirmClose={() => guardClose(isDirty)}
      footer={
        <button type="submit" form="loan-form" disabled={saving || !canSubmit}
          className="cta-primary"
        >{saving ? t('loan_creating') : wouldBranchToLinked ? t('ltr_branch_cta') : t('loan_create')}</button>
      }
    >
      <form id="loan-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="flex gap-2.5">
          {(['given', 'taken'] as const).map(tp => (
            <button key={tp} type="button" onClick={() => setLoanType(tp)}
              className={`flex-1 py-3 rounded-2xl text-[13px] font-bold border-2 transition-all active:scale-[0.97] ${
                loanType === tp
                  ? tp === 'given' ? 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white border-transparent shadow-md' : 'bg-gradient-to-r from-amber-500 to-orange-500 text-white border-transparent shadow-md'
                  : 'bg-cream-card text-ink-500 border-cream-border'
              }`}
            >{tp === 'given' ? t('loan_i_gave') : t('loan_i_took')}</button>
          ))}
        </div>

        <div>
          <label className="form-label">{t('loan_to_whom')}</label>
          <ContactPicker value={contact} onChange={setContact} placeholder={t('quick_who_placeholder')} required className="input-field" />
          {wouldBranchToLinked ? (
            <p className="text-[11px] text-accent-600 mt-1.5">{t('ltr_branch_helper')}</p>
          ) : (
            <p className="text-[11px] text-ink-500 mt-1.5">{t('ltr_linked_only_helper')}</p>
          )}
        </div>

        <div>
          <label className="form-label">{t('amount_label')}</label>
          <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className="input-field text-center text-lg font-bold tabular-nums" required />
        </div>

        {isLedgerOnlyMode ? (
          <div>
            <label className="form-label">{t('onboard_currency_label')}</label>
            <div className="grid grid-cols-2 gap-2">
              {SUPPORTED_CURRENCIES.map((currency) => {
                const meta = currencyMeta[currency];
                return (
                  <button
                    key={currency}
                    type="button"
                    onClick={() => setLedgerCurrency(currency)}
                    className={ledgerCurrency === currency ? 'selector-base selector-selected' : 'selector-base'}
                  >
                    <span className="text-[13px] font-semibold text-ink-800 flex items-center gap-1.5">
                      <span>{meta?.flag}</span> {currency}
                    </span>
                    <span className="text-[11px] text-ink-500">{meta?.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div>
            <label className="form-label">{loanType === 'given' ? t('loan_paid_from') : t('loan_received_into')}</label>
            <AccountSelect accounts={accounts} selectedId={accountId} onSelect={setAccountId} />
          </div>
        )}

        {!isLedgerOnlyMode && loanType === 'taken' && availableCashAdvanceCards.length > 0 && (
          <div>
            <label className="form-label">{t('cash_advance_source')}</label>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setCashAdvanceSourceId('')}
                className={`w-full p-3 rounded-2xl border text-left text-[12px] font-semibold transition-all ${
                  !cashAdvanceSourceId ? 'border-accent-500 bg-accent-50 text-accent-600' : 'border-cream-border bg-cream-card text-ink-500'
                }`}
              >
                {t('cash_advance_none')}
              </button>
              {availableCashAdvanceCards.map(a => (
                <button key={a.id} type="button" onClick={() => setCashAdvanceSourceId(a.id)}
                  className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                    cashAdvanceSourceId === a.id ? 'border-accent-500 bg-accent-50 shadow-sm shadow-indigo-500/5' : 'border-cream-border bg-cream-card'
                  }`}
                >
                  <span className="text-[13px] font-semibold text-ink-800">{a.name}</span>
                  <span className="text-[12px] text-ink-500 tabular-nums">{a.currency}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="form-label">{t('quick_note')}</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('quick_note_placeholder')} className="input-field" />
        </div>

        <p className="text-[12px] text-ink-500 bg-cream-soft/80 border border-cream-hairline rounded-2xl p-3 leading-relaxed">
          {t('money_not_moved_notice')}
        </p>

        {/* UX-12: the qist/EMI section only exists on the paths that actually
            create a loan row here. On the linked branch it is replaced by an
            explanation — never rendered-then-ignored. */}
        {emiAvailable ? (
          <>
            <label className="flex items-center gap-2.5 cursor-pointer p-3 rounded-2xl bg-cream-soft/80 border border-cream-hairline">
              <input type="checkbox" checked={hasEmi} onChange={e => setHasEmi(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-accent-600 accent-indigo-600" />
              <span className="text-[13px] text-ink-700 font-medium">{t('loan_set_emi')}</span>
            </label>

            {hasEmi && (
              <div className="grid grid-cols-2 gap-3 animate-fade-in">
                <div>
                  <label className="form-label">{t('loan_installments')}</label>
                  <input type="number" value={installments} onChange={e => setInstallments(e.target.value)} placeholder="12" className="input-field" required />
                </div>
                <div>
                  <label className="form-label">{t('kameti_start_date')}</label>
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input-field" required />
                </div>
              </div>
            )}
            {hasEmi && !emiConfigured && (
              <p className="text-[11px] text-warn-700 -mt-1.5">{t('val_emi_incomplete')}</p>
            )}
          </>
        ) : (
          <div className="rounded-2xl bg-cream-soft/80 border border-cream-hairline p-3">
            <p className="text-[12px] font-semibold text-ink-700 leading-snug">{t('ltr_emi_unavailable_title')}</p>
            <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">{t('ltr_emi_unavailable_body')}</p>
            {hasEmi && (
              // The user HAD configured a plan before the contact turned out to
              // be linked. Say so — the values are kept, not thrown away.
              <p className="text-[11px] text-warn-700 font-semibold mt-2 leading-relaxed">
                {t('ltr_emi_kept_warning')}
              </p>
            )}
          </div>
        )}

        {/* Glanceable confirm/private chip near the Save CTA — mirrors
            QuickEntry's loan helper. Linked contacts get a confirm request;
            everyone else stays a private local-only record. */}
        {wouldBranchToLinked ? (
          <div className="flex items-center gap-2 rounded-2xl bg-accent-50 border border-accent-100 px-3 py-2.5">
            <Users size={13} className="text-accent-600 shrink-0" />
            <p className="text-[11px] font-semibold text-accent-600 leading-snug">
              {t('loan_will_confirm').replace('{name}', contact.name.trim() || t('loan_they'))}
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-2xl bg-cream-soft border border-cream-border px-3 py-2.5">
            <Lock size={13} className="text-ink-500 shrink-0" />
            <p className="text-[11px] font-semibold text-ink-600 leading-snug">
              {t('loan_private')}
            </p>
          </div>
        )}

        {error && <p className="text-[12px] text-pay-text font-semibold bg-pay-50 rounded-xl p-3">{error}</p>}
      </form>
    </Modal>
  );
}
