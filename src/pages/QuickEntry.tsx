import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
  HandCoins, Handshake, RotateCcw, Target, Delete, Users, Plus, ChevronRight, Lock,
} from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore, type TransactionInput } from '../stores/transactionStore';
import { useLoanStore } from '../stores/loanStore';
import { useGoalStore } from '../stores/goalStore';
import { useEmiStore } from '../stores/emiStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { usePersonStore } from '../stores/personStore';
import { useLinkedRequestStore, LINKED_REQUEST_CURRENCIES } from '../stores/linkedRequestStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useSplitStore } from '../stores/splitStore';
import { Modal } from '../components/Modal';
import { ContactPicker, type ContactValue } from '../components/ContactPicker';
import { decideLinkedBranch } from '../lib/linkedRequestBranch';
import { confirmCrossUserRequest } from '../lib/confirmCrossUserRequest';
import { ConfirmationSheet } from '../components/ConfirmationSheet';
import { SpendingWarningModal } from '../components/SpendingWarningModal';
import { useToast } from '../components/Toast';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, formatMoney, formatSignedMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { SUPPORTED_CURRENCIES, type Currency, type TransactionType, type SplitGroup } from '../db';
import { AddAccountStepper } from './AddAccountStepper';

// Internal type slot widened to include the "group_expense" sentinel.
// It's NOT a real `TransactionType` (those map 1:1 to rows in the
// transactions table); group expenses live in their own table and are
// authored via AddGroupExpenseModal, so the type guard is "if the user
// picked this tile, route to the group-picker step and hand off to App."
type EntryKind = TransactionType | 'group_expense';
type EntryIntent = 'expense' | 'income' | 'transfer' | 'person_money' | 'group_expense';
type RepaymentDirection = 'received' | 'paid' | null;

export interface QuickEntryPreset {
  type?: Extract<TransactionType, 'expense' | 'income' | 'transfer' | 'loan_given' | 'loan_taken' | 'repayment'>;
  // `intent` lets callers start QuickEntry at a higher level than `type`.
  // 'person_money' jumps directly to the Step-3 sub-picker after amount
  // entry (so the user picks gave/borrowed/paid-back themselves).
  // 'group_expense' routes amount → group picker.
  intent?: 'person_money' | 'group_expense';
  contact?: ContactValue;
  repaymentDirection?: Exclude<RepaymentDirection, null>;
  accountId?: string;
  lockContact?: boolean;
  lockAccount?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // QuickEntry → Group expense bridge. App holds the AddGroupExpenseModal
  // + CreateGroupModal so the user can finish the entry without losing
  // their typed amount when QuickEntry closes.
  onPickGroupExpense?: (group: SplitGroup, amount: string) => void;
  onCreateGroupForExpense?: (amount: string) => void;
  preset?: QuickEntryPreset | null;
}

export function QuickEntry({
  open,
  onClose,
  onPickGroupExpense,
  onCreateGroupForExpense,
  preset,
}: Props) {
  const { accounts } = useAccountStore();
  const { processTransaction } = useTransactionStore();
  const { loans } = useLoanStore();
  const { createLoan, applyRepayment } = useLoanStore();
  const { goals } = useGoalStore();
  const { generateSchedule } = useEmiStore();
  const { expenses: upcomingExpenses } = useUpcomingExpenseStore();
  const groups = useSplitStore((s) => s.groups);
  const groupsLoading = useSplitStore((s) => s.loading);
  const loadGroups = useSplitStore((s) => s.loadGroups);
  const appMode = useAppModeStore((s) => s.mode);
  const linkedRequests = useLinkedRequestStore((s) => s.requests);
  const navigate = useNavigate();
  const toast = useToast();
  const t = useT();

  const [step, setStep] = useState(0);
  const [intent, setIntent] = useState<EntryIntent | null>(null);
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<EntryKind>('expense');
  const [repaymentDirection, setRepaymentDirection] = useState<RepaymentDirection>(null);
  const [sourceId, setSourceId] = useState('');
  const [destId, setDestId] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [loanId, setLoanId] = useState('');
  const [goalId, setGoalId] = useState('');
  const [conversionRate, setConversionRate] = useState('');
  const [ledgerCurrency, setLedgerCurrency] = useState<Currency>((localStorage.getItem('hisaab_primary_currency') as Currency) || 'AED');
  const [hasEmi, setHasEmi] = useState(false);
  const [emiInstallments, setEmiInstallments] = useState('');
  const [emiStartDate, setEmiStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmData, setConfirmData] = useState<{ title: string; description: string; changes: Array<{ accountName: string; currency: string; before: number; after: number }>; route?: string }>({ title: '', description: '', changes: [] });
  const [showInlineAccount, setShowInlineAccount] = useState(false);
  const [showSpendingWarning, setShowSpendingWarning] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && step === 0) setTimeout(() => amountRef.current?.focus(), 300);
  }, [open, step]);

  // Safety-net: kick off a groups load the moment QuickEntry opens. If
  // App.tsx already preloaded on boot (the common case), this is a no-op
  // because the store already has the data — the fetch isn't gated on
  // empty state but `loadGroups` itself returns fast on a warm cache.
  // Belt-and-braces ensures the picker never shows "no groups" when the
  // user actually has some.
  useEffect(() => {
    if (open) void loadGroups().catch(() => {});
  }, [open, loadGroups]);

  // FIX 4: Rename Transfer to Move
  // Eighth tile (`group_expense`) is a sentinel — not a TransactionType.
  // Picking it routes Step 2 to a group picker instead of the normal
  // details form. The actual save happens in AddGroupExpenseModal which
  // App.tsx opens once the user picks (or creates) a group.
  const TX_TYPES = [
    { value: 'expense' as EntryKind, label: t('tx_expense'), sub: t('tx_expense_sub'), icon: ArrowUpRight, gradient: 'from-red-500 to-rose-500', soft: 'bg-red-50 text-red-500 border-red-100' },
    { value: 'income' as EntryKind, label: t('tx_income'), sub: t('tx_income_sub'), icon: ArrowDownLeft, gradient: 'from-emerald-500 to-teal-500', soft: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
    { value: 'transfer' as EntryKind, label: t('tx_transfer'), sub: t('tx_transfer_sub'), icon: ArrowLeftRight, gradient: 'from-blue-500 to-cyan-500', soft: 'bg-blue-50 text-blue-600 border-blue-100' },
    { value: 'loan_given' as EntryKind, label: t('tx_loan_given'), sub: t('tx_loan_given_sub'), icon: HandCoins, gradient: 'from-blue-500 to-indigo-500', soft: 'bg-blue-50 text-blue-600 border-blue-100' },
    { value: 'loan_taken' as EntryKind, label: t('tx_loan_taken'), sub: t('tx_loan_taken_sub'), icon: Handshake, gradient: 'from-amber-500 to-orange-500', soft: 'bg-amber-50 text-amber-600 border-amber-100' },
    { value: 'repayment' as EntryKind, label: t('tx_repayment'), sub: t('tx_repayment_sub'), icon: RotateCcw, gradient: 'from-teal-500 to-emerald-500', soft: 'bg-teal-50 text-teal-600 border-teal-100' },
    { value: 'goal_contribution' as EntryKind, label: t('tx_goal_contribution'), sub: t('tx_goal_contribution_sub'), icon: Target, gradient: 'from-purple-500 to-violet-500', soft: 'bg-purple-50 text-purple-600 border-purple-100' },
    { value: 'group_expense' as EntryKind, label: t('intent_group'), sub: t('intent_group_sub'), icon: Users, gradient: 'from-violet-500 to-purple-500', soft: 'bg-accent-50 text-accent-600 border-accent-100' },
  ];
  // Intent picker. Splits-only mode has no accounts, so the Spend/Receive/
  // Move intents (which require source/dest account selection) are hidden
  // entirely — only the people-oriented intents remain. Full-tracker mode
  // shows everything.
  const ALL_INTENTS: { value: EntryIntent; label: string; sub: string; icon: typeof ArrowUpRight }[] = [
    { value: 'expense', label: t('intent_spend'), sub: t('intent_spend_sub'), icon: ArrowUpRight },
    { value: 'income', label: t('intent_receive'), sub: t('intent_receive_sub'), icon: ArrowDownLeft },
    { value: 'transfer', label: t('intent_move'), sub: t('intent_move_sub'), icon: ArrowLeftRight },
    { value: 'person_money', label: t('intent_person'), sub: t('intent_person_sub'), icon: HandCoins },
    { value: 'group_expense', label: t('intent_group'), sub: t('intent_group_sub'), icon: Users },
  ];
  const INTENTS = appMode === 'splits_only'
    ? ALL_INTENTS.filter((i) => i.value === 'person_money' || i.value === 'group_expense')
    : ALL_INTENTS;

  const reset = () => {
    setStep(0); setIntent(null); setAmount(''); setType('expense'); setRepaymentDirection(null);
    setSourceId(''); setDestId(''); setCategory('');
    setNotes(''); setContact({ id: null, name: '' }); setLoanId('');
    setGoalId(''); setConversionRate('');
    setHasEmi(false); setEmiInstallments(''); setEmiStartDate('');
  };
  const handleClose = () => { reset(); onClose(); };

  useEffect(() => {
    if (!open) return;
    setStep(0);
    // Hydrate intent from preset so the Step-0 Next button routes to the
    // right subsequent step (Step 3 for person_money, Step 2 with type set
    // for group_expense).
    setIntent(preset?.intent ?? null);
    setAmount('');
    setType(preset?.intent === 'group_expense' ? 'group_expense' : (preset?.type ?? 'expense'));
    setRepaymentDirection(preset?.repaymentDirection ?? null);
    setSourceId(
      preset?.accountId && ['expense', 'transfer', 'loan_given'].includes(preset.type ?? '')
        ? preset.accountId
        : '',
    );
    setDestId(
      preset?.accountId && ['income', 'loan_taken'].includes(preset.type ?? '')
        ? preset.accountId
        : '',
    );
    setContact(preset?.contact ?? { id: null, name: '' });
    setLoanId('');
    setCategory('');
    setNotes('');
    setConversionRate('');
  }, [open, preset]);

  useEffect(() => {
    if (!open || !preset?.accountId) return;
    if (['expense', 'transfer', 'loan_given'].includes(type)) setSourceId(preset.accountId);
    if (['income', 'loan_taken'].includes(type)) setDestId(preset.accountId);
  }, [open, preset?.accountId, type]);

  const numpadPress = (key: string) => {
    if (key === 'del') { setAmount(a => a.slice(0, -1)); }
    else if (key === '.') { if (!amount.includes('.')) setAmount(a => a + '.'); }
    else { const parts = amount.split('.'); if (parts[1]?.length >= 2) return; setAmount(a => a + key); }
  };

  const isLedgerOnlyPersonFlow = appMode === 'splits_only' && ['loan_given', 'loan_taken', 'repayment'].includes(type);
  const needsSource = !isLedgerOnlyPersonFlow && ['expense', 'transfer', 'loan_given', 'goal_contribution'].includes(type);
  const needsDest = !isLedgerOnlyPersonFlow && ['income', 'transfer', 'loan_taken'].includes(type);
  const needsPerson = ['loan_given', 'loan_taken'].includes(type);
  const needsLoan = type === 'repayment';
  const needsGoal = type === 'goal_contribution';
  const showCategory = ['income', 'expense'].includes(type);
  const isGroupExpense = type === 'group_expense';
  const selectedLoan = loans.find(l => l.id === loanId);
  // A loan is "linked" when an accepted linked_transaction_request mirrors it
  // to another Hisaab user. Such a loan must settle through the dedicated
  // settlement-request flow (so the counterparty confirms) — repaying it
  // locally here would diverge the two mirrored ledgers.
  const selectedLoanIsLinked = !!selectedLoan && linkedRequests.some(
    (r) => r.status === 'accepted' && (r.requesterLoanId === selectedLoan.id || r.responderLoanId === selectedLoan.id),
  );
  const hasAccounts = accounts.length > 0;
  const filteredLoans = loans.filter((loan) => {
    if (loan.status !== 'active') return false;
    if (repaymentDirection === 'received' && loan.type !== 'given') return false;
    if (repaymentDirection === 'paid' && loan.type !== 'taken') return false;
    if (preset?.contact?.id && loan.personId !== preset.contact.id) return false;
    return true;
  });

  // Group-expense handoff. The actual save happens in App's
  // AddGroupExpenseModal — we just close + relay.
  const handlePickGroup = (group: SplitGroup) => {
    onPickGroupExpense?.(group, amount);
    reset();
  };
  const handleCreateNewGroup = () => {
    onCreateGroupForExpense?.(amount);
    reset();
  };

  // BATCH6: Universal cross-currency detection for ALL transaction types
  const srcAccount = accounts.find(a => a.id === sourceId);
  const dstAccount = accounts.find(a => a.id === destId);
  const selectedGoal = goals.find(g => g.id === goalId);
  const availableCashAdvanceCards = accounts.filter(a =>
    a.type === 'credit_card' &&
    a.id !== destId &&
    (!dstAccount || a.currency === dstAccount.currency)
  );
  const selectedCashAdvanceCard = availableCashAdvanceCards.find(a => a.id === sourceId);

  // Active currency for the amount step + quick-amount presets. Prefer the
  // preset account's currency (when QuickEntry was launched pinned to an
  // account); otherwise the user's primary currency.
  const primaryCurrency = (localStorage.getItem('hisaab_primary_currency') as Currency) || 'AED';
  const presetAccount = preset?.accountId ? accounts.find(a => a.id === preset.accountId) : undefined;
  const activeCurrency: Currency = presetAccount?.currency ?? primaryCurrency;
  // Quick-amount chips scale with the primary currency: PKR users deal in
  // far larger nominal amounts than AED users, so offer a bigger preset set.
  const quickAmounts = primaryCurrency === 'PKR'
    ? [500, 1000, 5000, 10000, 50000]
    : [50, 100, 500, 1000, 5000];

  // Determine if cross-currency conversion is needed
  const isCrossCurrency = (() => {
    if (type === 'transfer' && srcAccount && dstAccount) return srcAccount.currency !== dstAccount.currency;
    if (type === 'repayment' && selectedLoan) {
      if (selectedLoan.type === 'given' && dstAccount) return dstAccount.currency !== selectedLoan.currency;
      if (selectedLoan.type === 'taken' && srcAccount) return srcAccount.currency !== selectedLoan.currency;
    }
    if (type === 'goal_contribution' && srcAccount && selectedGoal) return srcAccount.currency !== selectedGoal.currency;
    return false;
  })();

  // Determine the two currencies for the conversion card
  const crossCurrencyFrom = (() => {
    if (type === 'transfer' && srcAccount) return srcAccount.currency;
    if (type === 'repayment' && selectedLoan) return selectedLoan.currency;
    if (type === 'goal_contribution' && srcAccount) return srcAccount.currency;
    return '';
  })();
  const crossCurrencyTo = (() => {
    if (type === 'transfer' && dstAccount) return dstAccount.currency;
    if (type === 'repayment') {
      if (selectedLoan?.type === 'given' && dstAccount) return dstAccount.currency;
      if (selectedLoan?.type === 'taken' && srcAccount) return srcAccount.currency;
    }
    if (type === 'goal_contribution' && selectedGoal) return selectedGoal.currency;
    return '';
  })();

  // Conversion-rate sanity bounds (Phase H2 hardening). A typo'd rate
  // would silently corrupt balances; reject outside a sane window.
  const RATE_MIN = 0.0001;
  const RATE_MAX = 100000;
  const rateIsValid = () => {
    if (!isCrossCurrency) return true;
    const r = parseFloat(conversionRate);
    return r >= RATE_MIN && r <= RATE_MAX;
  };

  const canSubmit = () => {
    const amt = parseFloat(amount);
    if (!amt) return false;
    // BATCH6: Block ALL cross-currency submissions without rate
    if (isCrossCurrency && !parseFloat(conversionRate)) return false;
    // Phase H2: reject out-of-bounds conversion rates
    if (!rateIsValid()) return false;
    // Phase H2: overpayment guard on repayments (mirrors the simple-mode
    // check at line 337, now applied to all paths).
    if (type === 'repayment' && selectedLoan) {
      if (amt > selectedLoan.remainingAmount + 0.00001) return false;
    }
    switch (type) {
      case 'income': return !!destId;
      case 'expense': return !!sourceId;
      case 'transfer': return !!sourceId && !!destId && sourceId !== destId;
      case 'loan_given': return (isLedgerOnlyPersonFlow || !!sourceId) && !!contact.name.trim();
      case 'loan_taken': return (isLedgerOnlyPersonFlow || !!destId) && !!contact.name.trim();
      case 'repayment':
        if (!loanId) return false;
        // Linked loans settle via the loan page, not here.
        if (selectedLoanIsLinked) return false;
        if (isLedgerOnlyPersonFlow) return true;
        return selectedLoan?.type === 'given' ? !!destId : !!sourceId;
      case 'goal_contribution': return !!sourceId && !!goalId;
      default: return false;
    }
  };

  // Spending warning: check if source account has an upcoming expense within 30 days
  const upcomingForSource = sourceId
    ? upcomingExpenses.filter(e =>
        e.accountId === sourceId && e.status === 'upcoming' &&
        Math.ceil((new Date(e.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) <= 30
      ).sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
    : [];
  const nearestUpcoming = upcomingForSource[0] ?? null;

  const preSubmit = () => {
    // If deducting from account that has upcoming expense, show warning first
    if (nearestUpcoming && ['expense', 'transfer', 'loan_given', 'goal_contribution'].includes(type)) {
      setShowSpendingWarning(true);
      return;
    }
    handleSubmit();
  };

  // Phase 2B: whether the current form state will branch into a linked
  // request on submit. Drives the inline helper + CTA label only.
  const contactInStore = needsPerson && contact.id
    ? usePersonStore.getState().persons.find((p) => p.id === contact.id) ?? null
    : null;
  const branchAccount = type === 'loan_given' ? srcAccount : type === 'loan_taken' ? dstAccount : null;
  // Currency that would carry the cross-user record: the chosen account's
  // currency in full-tracker, the picked ledger currency in split-only.
  const branchCurrency = isLedgerOnlyPersonFlow ? ledgerCurrency : branchAccount?.currency;
  // In split-only the record can only be mirrored for currencies the linked
  // request table accepts (AED/PKR); other currencies stay local. Full-tracker
  // keeps its existing (un-gated) behaviour.
  const branchCurrencyMirrorable = !isLedgerOnlyPersonFlow
    || (!!branchCurrency && (LINKED_REQUEST_CURRENCIES as readonly string[]).includes(branchCurrency));
  const wouldBranchToLinked = !!(
    (type === 'loan_given' || type === 'loan_taken') &&
    contactInStore?.linkedProfileId &&
    branchCurrency &&
    branchCurrencyMirrorable
  );

  async function ensureResolvedPerson(name: string, id: string) {
    const existing = usePersonStore.getState().persons.find((p) => p.id === id);
    if (existing) return existing;
    return usePersonStore.getState().findOrCreateByName(name);
  }

  const handleSubmit = async () => {
    setShowSpendingWarning(false);
    const amt = parseFloat(amount);
    if (!amt) return;
    setSaving(true);
    try {
      let input: TransactionInput;
      const changes: Array<{ accountName: string; currency: string; before: number; after: number }> = [];

      // Resolve contact once if this entry type needs a person. `needsPerson`
      // is the source of truth for whether a contact row must exist.
      const resolvedPerson = needsPerson
        ? (contact.id
            ? await ensureResolvedPerson(contact.name.trim(), contact.id)
            : await usePersonStore.getState().findOrCreateByName(contact.name.trim()))
        : null;

      // A linked loan must settle through its dedicated flow so the OTHER
      // side confirms — never reduce it locally (that diverges the two
      // mirrored ledgers). Bounce to the loan page's settle action.
      if (type === 'repayment' && selectedLoan && selectedLoanIsLinked) {
        reset();
        onClose();
        navigate(`/loan/${selectedLoan.id}`);
        return;
      }

      if (isLedgerOnlyPersonFlow) {
        if (type === 'repayment') {
          if (!selectedLoan) throw new Error('Loan not found');
          if (amt > selectedLoan.remainingAmount + 0.00001) {
            throw new Error('Repayment cannot exceed the remaining balance');
          }
          await applyRepayment(selectedLoan.id, amt);
          setConfirmData({
            title: t('confirm_repayment_saved'),
            description: selectedLoan.type === 'given'
              ? `${selectedLoan.personName} paid you back ${formatMoney(amt, selectedLoan.currency)}.`
              : `You paid ${selectedLoan.personName} back ${formatMoney(amt, selectedLoan.currency)}.`,
            changes: [],
            route: `/loan/${selectedLoan.id}`,
          });
        } else {
          // Split-only can still mirror a loan to a linked contact. The
          // cross-user record carries no balance movement (no account is
          // involved), so split-only is irrelevant to it — branch exactly
          // like full-tracker. Only AED/PKR can be mirrored; any other
          // currency stays a local-only ledger loan.
          if (type === 'loan_given' || type === 'loan_taken') {
            const branch = decideLinkedBranch({
              type,
              person: resolvedPerson,
              requestCurrency: ledgerCurrency,
            });
            if (branch.branch === true && (LINKED_REQUEST_CURRENCIES as readonly string[]).includes(ledgerCurrency)) {
              const guard = await confirmCrossUserRequest({ amount: amt, currency: branch.currency, personName: resolvedPerson!.name });
              if (guard.blockedReason) { toast.show({ type: 'error', title: 'Check the amount', subtitle: guard.blockedReason }); return; }
              if (!guard.ok) return;
              await useLinkedRequestStore.getState().createRequest({
                toUserId: branch.toUserId,
                personId: branch.personId,
                kind: branch.kind,
                amount: amt,
                currency: branch.currency,
                note: notes,
              });
              toast.show({ type: 'success', title: t('ltr_sent_title'), subtitle: t('ltr_sent_subtitle') });
              reset();
              onClose();
              return;
            }
          }
          const loan = await createLoan({
            personName: resolvedPerson!.name,
            personId: resolvedPerson!.id,
            type: type === 'loan_given' ? 'given' : 'taken',
            totalAmount: amt,
            currency: ledgerCurrency,
            notes,
          });
          setConfirmData({
            title: t('confirm_loan_saved'),
            description: loan.type === 'given'
              ? `${loan.personName} owes you ${formatMoney(amt, loan.currency)}.`
              : `You owe ${loan.personName} ${formatMoney(amt, loan.currency)}.`,
            changes: [],
            route: `/loan/${loan.id}`,
          });
        }
        setShowConfirmation(true);
        reset();
        return;
      }

      // Phase 2B: Full Money Tracker can branch linked-contact loan entries
      // into an approval request. Simple mode must record local wallet effects
      // immediately, so it uses the normal transaction path below.
      if (appMode !== 'splits_only' && (type === 'loan_given' || type === 'loan_taken')) {
        const accountForBranch = type === 'loan_given' ? srcAccount : dstAccount;
        const branch = decideLinkedBranch({
          type,
          person: resolvedPerson,
          requestCurrency: accountForBranch?.currency,
        });
        if (branch.branch === true) {
          // Deliberate confirm before mirroring a currency-locked record to them.
          const guard = await confirmCrossUserRequest({ amount: amt, currency: branch.currency, personName: resolvedPerson!.name });
          if (guard.blockedReason) { toast.show({ type: 'error', title: 'Check the amount', subtitle: guard.blockedReason }); return; }
          if (!guard.ok) return;
          await useLinkedRequestStore.getState().createRequest({
            toUserId: branch.toUserId,
            personId: branch.personId,
            kind: branch.kind,
            amount: amt,
            currency: branch.currency,
            note: notes,
          });
          toast.show({ type: 'success', title: t('ltr_sent_title'), subtitle: t('ltr_sent_subtitle') });
          reset();
          onClose();
          return;
        }
      }

      switch (type) {
        case 'income': { const d = accounts.find(a => a.id === destId)!; changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + amt }); input = { type: 'income', amount: amt, destinationAccountId: destId, category, notes }; break; }
        case 'expense': { const s = accounts.find(a => a.id === sourceId)!; changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt }); input = { type: 'expense', amount: amt, sourceAccountId: sourceId, category, notes }; break; }
        case 'transfer': {
          const s = accounts.find(a => a.id === sourceId)!;
          const d = accounts.find(a => a.id === destId)!;
          changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt });
          const rate = parseFloat(conversionRate) || 1;
          const dAmt = s.currency !== d.currency ? Math.round(amt * rate * 100) / 100 : amt;
          changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + dAmt });
          input = { type: 'transfer', amount: amt, sourceAccountId: sourceId, destinationAccountId: destId, conversionRate: s.currency !== d.currency ? rate : undefined, notes };
          break;
        }
        case 'loan_given': { const s = accounts.find(a => a.id === sourceId)!; changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - amt }); input = { type: 'loan_given', amount: amt, sourceAccountId: sourceId, personName: resolvedPerson!.name, personId: resolvedPerson!.id, notes }; break; }
        case 'loan_taken': {
          const d = accounts.find(a => a.id === destId)!;
          if (selectedCashAdvanceCard) {
            changes.push({ accountName: selectedCashAdvanceCard.name, currency: selectedCashAdvanceCard.currency, before: selectedCashAdvanceCard.balance, after: selectedCashAdvanceCard.balance - amt });
          }
          changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + amt });
          input = { type: 'loan_taken', amount: amt, destinationAccountId: destId, sourceAccountId: selectedCashAdvanceCard?.id, personName: resolvedPerson!.name, personId: resolvedPerson!.id, notes };
          break;
        }
        case 'repayment': {
          if (!selectedLoan) throw new Error('Loan not found');
          const rate = parseFloat(conversionRate) || undefined;
          if (selectedLoan.type === 'given' && destId) {
            const d = accounts.find(a => a.id === destId)!;
            const addAmt = isCrossCurrency && rate ? Math.round(amt * rate * 100) / 100 : amt;
            changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + addAmt });
          } else if (selectedLoan.type === 'taken' && sourceId) {
            const s = accounts.find(a => a.id === sourceId)!;
            const deductAmt = isCrossCurrency && rate ? Math.round(amt / rate * 100) / 100 : amt;
            changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - deductAmt });
          }
          input = { type: 'repayment', amount: amt, loanId, sourceAccountId: selectedLoan.type === 'taken' ? sourceId : undefined, destinationAccountId: selectedLoan.type === 'given' ? destId : undefined, conversionRate: isCrossCurrency ? rate : undefined, notes };
          break;
        }
        case 'goal_contribution': {
          const s = accounts.find(a => a.id === sourceId)!;
          const gcRate = parseFloat(conversionRate) || undefined;
          const deductAmt = isCrossCurrency && gcRate ? Math.round(amt / gcRate * 100) / 100 : amt;
          changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - deductAmt });
          input = { type: 'goal_contribution', amount: amt, sourceAccountId: sourceId, goalId, conversionRate: isCrossCurrency ? gcRate : undefined, notes };
          break;
        }
        default: throw new Error('Unknown type');
      }

      const resultTx = await processTransaction(input);

      // EMI scheduling is a follow-up write, not part of the transaction
      // itself. If it fails we must NOT show "Transaction Failed" — the money
      // has already moved and a retry would duplicate the transaction. Surface
      // a distinct "partial success" toast instead and still confirm the txn.
      let emiFailed = false;
      if (hasEmi && resultTx.relatedLoanId && emiInstallments && emiStartDate) {
        try {
          await generateSchedule({
            loanId: resultTx.relatedLoanId,
            totalAmount: amt,
            installments: parseInt(emiInstallments),
            startDate: emiStartDate,
          });
        } catch (err) {
          emiFailed = true;
          console.error('generateSchedule failed after successful transaction', err);
          toast.show({
            type: 'error',
            title: 'EMI schedule not created',
            subtitle: 'Your transaction was saved, but setting up the installment plan failed. Open the loan to retry.',
            duration: 6000,
          });
        }
      }

      const typeLabel = TX_TYPES.find(tx => tx.value === type)?.label ?? type;
      const confirmationCurrency = changes[0]?.currency ?? localStorage.getItem('hisaab_primary_currency') ?? 'PKR';
      const resultDescription = (() => {
        const first = changes[0];
        if (type === 'expense' && first) return `${formatMoney(amt, first.currency)} was deducted from ${first.accountName}.`;
        if (type === 'income' && first) return `${formatMoney(amt, first.currency)} was added to ${first.accountName}.`;
        if (type === 'transfer' && changes.length === 2) return `${formatMoney(amt, changes[0].currency)} moved from ${changes[0].accountName} to ${changes[1].accountName}.`;
        if (type === 'loan_given') return `${resolvedPerson!.name} owes you ${formatMoney(amt, confirmationCurrency)}.`;
        if (type === 'loan_taken') return `You owe ${resolvedPerson!.name} ${formatMoney(amt, confirmationCurrency)}.`;
        if (type === 'repayment' && selectedLoan) {
          return selectedLoan.type === 'given'
            ? `${selectedLoan.personName} paid you back ${formatMoney(amt, selectedLoan.currency)}.`
            : `You paid ${selectedLoan.personName} back ${formatMoney(amt, selectedLoan.currency)}.`;
        }
        return `${formatMoney(amt, confirmationCurrency)} saved.`;
      })();
      // Deep-link the "View" button only where a detail page exists: loans
      // (incl. the loan a repayment belongs to) and goals. Plain
      // expense/income/transfer have no per-record route, so leave it unset
      // and the View button hides gracefully.
      const confirmRoute = (() => {
        if ((type === 'loan_given' || type === 'loan_taken') && resultTx.relatedLoanId) return `/loan/${resultTx.relatedLoanId}`;
        if (type === 'repayment' && selectedLoan) return `/loan/${selectedLoan.id}`;
        if (type === 'goal_contribution') return '/goals';
        return undefined;
      })();
      setConfirmData({
        title: emiFailed ? `${typeLabel} — Saved (EMI pending)` : `${typeLabel} — Done!`,
        description: resultDescription,
        changes,
        route: confirmRoute,
      });
      setShowConfirmation(true);
      reset();
    } catch (err) {
      toast.show({ type: 'error', title: 'Transaction Failed', subtitle: err instanceof Error ? err.message : t('toast_error_generic') });
    } finally { setSaving(false); }
  };

  const inputClass = "w-full border border-cream-border rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all";

  // Heads-up "After: …" preview for source rows (money leaving an account).
  // Glanceable only — never blocks submit. Tints pay-text + shows a small
  // "Low balance" caption when the move would push a non-credit account
  // negative. Credit cards legitimately carry a negative available balance,
  // so we don't flag them.
  const renderAfterBalance = (acct: { balance: number; currency: string; type: string }) => {
    const amt = parseFloat(amount);
    if (!amt) return null;
    const after = acct.balance - amt;
    const goesNegative = after < 0 && acct.type !== 'credit_card';
    return (
      <p className={`text-[10px] mt-0.5 tabular-nums ${goesNegative ? 'text-pay-text' : 'text-ink-500'}`}>
        {t('qe_after').replace('{amount}', formatSignedMoney(after, acct.currency))}
        {goesNegative && <span className="ml-1.5 font-semibold">{t('qe_low_balance')}</span>}
      </p>
    );
  };

  return (
    <>
      <Modal open={open && !showInlineAccount} onClose={handleClose}
        title={step === 0 ? t('quick_how_much') : step === 1 ? t('quick_what_type') : t('quick_details')}
        footer={step === 0 ? (
          <button
            onClick={() => {
              if (parseFloat(amount) <= 0) return;
              // Routing precedence:
              //   preset.type      → Step 2 (details directly for that type)
              //   preset.intent='person_money' → Step 3 (gave/borrowed/paid sub-picker)
              //   preset.intent='group_expense' → Step 2 (group picker variant)
              //   otherwise        → Step 1 (intent picker)
              if (preset?.type) { setStep(2); return; }
              if (preset?.intent === 'person_money') { setStep(3); return; }
              if (preset?.intent === 'group_expense') { setStep(2); return; }
              setStep(1);
            }}
            disabled={!parseFloat(amount)}
            className="w-full bg-ink-900 text-white rounded-2xl py-4 text-sm font-semibold disabled:opacity-30 active:scale-[0.98] transition-transform"
          >{`${t('quick_next')} \u2192`}</button>
        ) : step === 1 ? (
          <button onClick={() => setStep(0)} className="w-full text-center text-[12px] text-ink-500 py-2 font-medium">
            &#x2190; {t('quick_change_amount')}
          </button>
        ) : step === 2 ? (
          isGroupExpense ? (
            // Group expense exits via the picker tap, not a Save button.
            // Just give the user a way back to change the amount or type.
            <button
              onClick={() => setStep(1)}
              className="w-full text-center text-[12px] text-ink-500 py-2 font-medium"
            >
              &#x2190; Back
            </button>
          ) : (
            <div className="flex gap-2.5">
              <button onClick={() => setStep(1)} className="px-4 py-3.5 rounded-2xl text-sm font-semibold border border-cream-border text-ink-500 active:bg-cream-soft transition-colors bg-cream-card">
                &#x2190;
              </button>
              <button onClick={preSubmit} disabled={saving || !canSubmit()}
                className="flex-1 bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-semibold disabled:opacity-30 active:scale-[0.98] transition-transform"
              >{saving ? t('quick_processing') : wouldBranchToLinked ? t('ltr_branch_cta') : `${t('quick_save')} \u2713`}</button>
            </div>
          )
        ) : undefined}
      >

        {/* Step 0: Amount — Sukoon's centred big number + white keypad */}
        {step === 0 && (
          <div className="space-y-5">
            <div className="text-center py-4">
              <p className="text-[12px] font-semibold text-ink-500 tracking-[0.12em] uppercase">{activeCurrency}</p>
              <input
                ref={amountRef}
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ''); if ((v.match(/\./g) ?? []).length <= 1) setAmount(v); }}
                placeholder="0"
                className="text-[54px] font-semibold text-center w-full border-none outline-none bg-transparent tabular-nums text-ink-900"
                style={{ letterSpacing: '-0.025em' }}
              />
              <p className="text-[12px] text-ink-500 mt-2">{t('quick_enter_amount')}</p>
            </div>

            {/* Quick amounts */}
            <div className="flex gap-2 justify-center flex-wrap">
              {quickAmounts.map(v => (
                <button key={v} onClick={() => setAmount(String(v))}
                  className="min-h-[44px] px-3.5 py-2 rounded-xl text-xs font-semibold bg-cream-card text-ink-600 border border-cream-border active:bg-cream-soft active:scale-95 transition-all tabular-nums"
                >{v.toLocaleString()}</button>
              ))}
            </div>

            {/* Numpad — Sukoon: white cells, 1px cream-border, radius 14 */}
            <div className="grid grid-cols-3 gap-2" aria-label="Number pad" role="group">
              {['1','2','3','4','5','6','7','8','9','.','0','del'].map(key => (
                <button key={key} onClick={() => numpadPress(key)}
                  aria-label={key === 'del' ? 'Delete last digit' : undefined}
                  className={`h-12 rounded-[14px] text-[19px] font-medium transition-all active:scale-95 flex items-center justify-center border ${
                    key === 'del' ? 'bg-pay-50 text-pay-text border-pay-100 active:bg-pay-100' : 'bg-cream-card text-ink-900 border-cream-border active:bg-cream-soft'
                  }`}
                >{key === 'del' ? <Delete size={18} /> : key}</button>
              ))}
            </div>

          </div>
        )}

        {/* Step 1: Type — Sukoon card rows on cream */}
        {step === 1 && (
          <div className="space-y-5 animate-fade-in">
            <div className="text-center py-2">
              <p className="text-4xl font-semibold tabular-nums text-ink-900" style={{ letterSpacing: '-0.025em' }}>
                {parseFloat(amount).toLocaleString()}
              </p>
              <p className="text-[12px] text-ink-500 mt-1">{t('quick_where_money')}</p>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {INTENTS.map(tx => {
                const Icon = tx.icon;
                const isActive = intent === tx.value;
                // Tone-map by transaction semantics: receive (green) for inflows,
                // pay (coral) for outflows, accent (violet) for goals, neutral
                // (ink/cream) for transfer, warn for loan_taken.
                const tone =
                  tx.value === 'income'
                    ? 'receive'
                    : tx.value === 'expense'
                    ? 'pay'
                    : tx.value === 'group_expense' || tx.value === 'person_money'
                    ? 'accent'
                    : 'neutral';
                const inactiveBg = {
                  receive: 'bg-receive-50',
                  pay: 'bg-pay-50',
                  accent: 'bg-accent-50',
                  warn: 'bg-warn-50',
                  neutral: 'bg-cream-soft',
                }[tone];
                const inactiveText = {
                  receive: 'text-receive-text',
                  pay: 'text-pay-text',
                  accent: 'text-accent-600',
                  warn: 'text-warn-600',
                  neutral: 'text-ink-600',
                }[tone];
                return (
                  <button key={tx.value} onClick={() => {
                    setIntent(tx.value);
                    if (tx.value === 'person_money') {
                      setStep(3);
                    } else {
                      setType(tx.value);
                      setStep(2);
                    }
                  }}
                    className={`p-3.5 rounded-2xl border flex items-center gap-3 text-left transition-all duration-200 active:scale-[0.96] ${
                      isActive
                        ? 'bg-ink-900 text-white border-ink-900'
                        : `bg-cream-card border-cream-border`
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${isActive ? 'bg-white/15 text-white' : `${inactiveBg} ${inactiveText}`}`}>
                      <Icon size={16} strokeWidth={1.8} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-[13px] font-semibold tracking-tight ${isActive ? 'text-white' : 'text-ink-900'}`}>
                        {tx.label}
                      </p>
                      <p className={`text-[10px] ${isActive ? 'text-white/65' : 'text-ink-500'}`}>{tx.sub}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3 animate-fade-in">
            <p className="text-[12px] text-ink-500 leading-relaxed">{t('intent_person_prompt')}</p>
            {[
              { value: 'loan_given' as const, label: t('person_gave'), sub: t('person_gave_sub'), icon: HandCoins },
              { value: 'loan_taken' as const, label: t('person_borrowed'), sub: t('person_borrowed_sub'), icon: Handshake },
              { value: 'repayment_received' as const, label: t('person_paid_me_back'), sub: t('person_paid_me_back_sub'), icon: ArrowDownLeft },
              { value: 'repayment_paid' as const, label: t('person_i_paid_back'), sub: t('person_i_paid_back_sub'), icon: ArrowUpRight },
            ].map((choice) => (
              <button
                key={choice.value}
                type="button"
                onClick={() => {
                  if (choice.value === 'repayment_received' || choice.value === 'repayment_paid') {
                    setType('repayment');
                    setRepaymentDirection(choice.value === 'repayment_received' ? 'received' : 'paid');
                  } else {
                    setType(choice.value);
                    setRepaymentDirection(null);
                  }
                  setStep(2);
                }}
                className="w-full rounded-2xl border border-cream-border bg-cream-card p-3.5 flex items-center gap-3 text-left active:scale-[0.98] transition-transform"
              >
                <div className="w-9 h-9 rounded-xl bg-accent-50 text-accent-600 flex items-center justify-center">
                  <choice.icon size={16} strokeWidth={1.8} />
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-ink-900">{choice.label}</p>
                  <p className="text-[10.5px] text-ink-500 mt-0.5">{choice.sub}</p>
                </div>
              </button>
            ))}
            <button onClick={() => setStep(preset?.intent === 'person_money' ? 0 : 1)} className="w-full text-center text-[12px] text-ink-500 py-2 font-medium">
              &#x2190; {t('back')}
            </button>
          </div>
        )}

        {/* Step 2: Details */}
        {step === 2 && (
          <div className="space-y-4 animate-fade-in">
            {/* Summary */}
            <div className="bg-cream-card border border-cream-border rounded-2xl p-3.5 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                {(() => {
                  const T = TX_TYPES.find(tx => tx.value === type);
                  if (!T) return null;
                  return (
                    <div className="w-8 h-8 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center">
                      <T.icon size={14} className="text-ink-600" />
                    </div>
                  );
                })()}
                <span className="text-[13px] font-semibold text-ink-900 tracking-tight">{TX_TYPES.find(tx => tx.value === type)?.label}</span>
              </div>
              <span className="font-semibold text-[15px] tabular-nums text-ink-900">{parseFloat(amount).toLocaleString()}</span>
            </div>

            {/* Group expense branch — pick an existing group OR create a
                new one. Either path closes QuickEntry; App.tsx then opens
                AddGroupExpenseModal (with the typed amount prefilled) or
                CreateGroupModal → AddGroupExpenseModal chained. */}
            {isGroupExpense && (
              <div className="space-y-3 animate-fade-in">
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                  Which group?
                </label>
                {groupsLoading && groups.length === 0 ? (
                  // Skeleton — visible only when groups truly haven't
                  // loaded yet. Avoids the "no groups" flash for users
                  // who DO have groups but opened QuickEntry before the
                  // boot-time preload finished.
                  <div className="rounded-2xl bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3 animate-pulse">
                        <div className="w-9 h-9 rounded-xl bg-cream-soft shrink-0" />
                        <div className="flex-1 space-y-1.5">
                          <div className="h-3 w-28 rounded-full bg-cream-soft" />
                          <div className="h-2.5 w-20 rounded-full bg-cream-soft" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : groups.length === 0 ? (
                  <div className="rounded-2xl bg-cream-card border border-cream-border p-4 text-center space-y-2">
                    <p className="text-[12.5px] text-ink-700 font-medium">
                      You don't have any groups yet.
                    </p>
                    <p className="text-[11px] text-ink-500 leading-relaxed">
                      Create one to split this expense with friends or flatmates.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-2xl bg-cream-card border border-cream-border overflow-hidden divide-y divide-cream-hairline">
                    {groups.map((g) => {
                      const connected = g.members.filter((m) => m.status === 'connected').length;
                      return (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => handlePickGroup(g)}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-cream-soft transition-colors"
                        >
                          <div className="w-9 h-9 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center text-base shrink-0">
                            {g.emoji}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium text-ink-900 truncate tracking-tight">
                              {g.name}
                            </p>
                            <p className="text-[10.5px] text-ink-500 mt-0.5">
                              {connected}/{g.members.length} members · {g.currency}
                            </p>
                          </div>
                          <ChevronRight size={14} className="text-ink-300 shrink-0" />
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleCreateNewGroup}
                  className="w-full rounded-2xl border-2 border-dashed border-cream-border bg-transparent text-ink-700 py-3 text-[12.5px] font-semibold active:bg-cream-soft transition-colors flex items-center justify-center gap-2"
                >
                  <Plus size={13} strokeWidth={2.4} /> Create new group
                </button>
                <p className="text-[11px] text-ink-500 leading-relaxed bg-cream-card border border-cream-border rounded-2xl p-3">
                  Picking a group opens the full expense form — you'll choose who paid, how to split, and the category there. Your amount carries over.
                </p>
              </div>
            )}

            {/* Account selectors */}
            {(needsSource || needsDest) && !hasAccounts && (
              <div className="rounded-2xl bg-warn-50 border border-cream-border p-4">
                <p className="text-[12px] text-ink-700 leading-relaxed">{t('acct_need_for_tx')}</p>
                <button
                  type="button"
                  onClick={() => setShowInlineAccount(true)}
                  className="mt-3 w-full rounded-xl bg-ink-900 text-white py-2.5 text-[12px] font-semibold"
                >
                  {t('quick_create_first')}
                </button>
              </div>
            )}
            {needsSource && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_from')}</label>
                {preset?.lockAccount && preset.accountId && (() => {
                  const lockedAcct = accounts.find(a => a.id === preset.accountId);
                  if (!lockedAcct) return null;
                  return (
                    <p className="text-[10.5px] text-accent-600 font-semibold mb-2 flex items-center gap-1.5">
                      <Lock size={11} /> {t('locked_to_account').replace('{name}', lockedAcct.name)}
                    </p>
                  );
                })()}
                <div className="space-y-2">
                  {(preset?.lockAccount && preset.accountId ? accounts.filter(a => a.id === preset.accountId) : accounts).map(a => {
                    const meta = currencyMeta[a.currency];
                    return (
                    <button key={a.id} type="button" onClick={() => setSourceId(a.id)}
                      className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                        sourceId === a.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{meta?.flag}</span>
                        <div>
                          <p className="text-[13px] font-semibold text-ink-900">{a.name}</p>
                          <p className="text-[10px] text-ink-500 capitalize">{a.type.replace('_', ' ')}</p>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                        {renderAfterBalance(a)}
                      </div>
                    </button>
                  );})}
                </div>
              </div>
            )}

            {needsDest && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_to')}</label>
                {preset?.lockAccount && preset.accountId && (() => {
                  const lockedAcct = accounts.find(a => a.id === preset.accountId);
                  if (!lockedAcct) return null;
                  return (
                    <p className="text-[10.5px] text-accent-600 font-semibold mb-2 flex items-center gap-1.5">
                      <Lock size={11} /> {t('locked_to_account').replace('{name}', lockedAcct.name)}
                    </p>
                  );
                })()}
                <div className="space-y-2">
                  {(preset?.lockAccount && preset.accountId ? accounts.filter(a => a.id === preset.accountId) : accounts).map(a => {
                    const meta = currencyMeta[a.currency];
                    return (
                    <button key={a.id} type="button" onClick={() => setDestId(a.id)}
                      className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                        destId === a.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{meta?.flag}</span>
                        <div>
                          <p className="text-[13px] font-semibold text-ink-900">{a.name}</p>
                          <p className="text-[10px] text-ink-500 capitalize">{a.type.replace('_', ' ')}</p>
                        </div>
                      </div>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                    </button>
                  );})}
                </div>
              </div>
            )}

            {/* Universal cross-currency conversion screen */}
            {isCrossCurrency && crossCurrencyFrom && crossCurrencyTo && (
              <div className="bg-info-50 rounded-2xl p-4 border border-cream-border space-y-3 animate-fade-in">
                <p className="text-[10.5px] font-semibold text-info-600 uppercase tracking-[0.12em]">{t('conv_title')}</p>
                <p className="text-[12px] text-ink-600">
                  {t('conv_moving')} <span className="font-semibold text-ink-900">{formatMoney(parseFloat(amount), crossCurrencyFrom)}</span>
                </p>
                <div>
                  <label className="block text-[11px] font-semibold text-ink-500 mb-1.5">
                    {t('conv_rate')} 1 {crossCurrencyFrom} = ___ {crossCurrencyTo}
                  </label>
                  <input type="number" step="0.0001" value={conversionRate} onChange={e => setConversionRate(e.target.value)}
                    placeholder="e.g. 78.50" className={inputClass} autoFocus />
                  {conversionRate && !rateIsValid() && (
                    <p className="mt-1.5 text-[11px] text-pay-text font-semibold leading-relaxed">
                      {parseFloat(conversionRate) < RATE_MIN ? t('err_rate_too_low') : t('err_rate_too_high')}
                    </p>
                  )}
                </div>
                {conversionRate && parseFloat(conversionRate) > 0 && (
                  <div className="bg-cream-card rounded-xl p-3 text-center border border-cream-border animate-fade-in">
                    <p className="text-[10px] text-ink-500">{t('conv_will_get')}</p>
                    <p className="text-lg font-semibold text-receive-text tabular-nums">
                      {formatMoney(Math.round(parseFloat(amount) * parseFloat(conversionRate) * 100) / 100, crossCurrencyTo)}
                    </p>
                  </div>
                )}
              </div>
            )}

            {needsPerson && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_who')}</label>
                {preset?.lockContact && preset.contact ? (
                  <div className="rounded-2xl border border-accent-100 bg-accent-50 px-4 py-3 flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-accent-100 flex items-center justify-center shrink-0">
                      <Lock size={13} className="text-accent-600" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-ink-900 truncate">{preset.contact.name}</p>
                      <p className="text-[10px] text-ink-500">
                        {t('locked_to_contact').replace('{name}', preset.contact.name)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <ContactPicker value={contact} onChange={setContact} placeholder={t('quick_who_placeholder')} className={inputClass} />
                )}
                {wouldBranchToLinked ? (
                  <p className="text-[11px] text-accent-600 mt-1.5">{t('ltr_branch_helper')}</p>
                ) : (
                  <p className="text-[11px] text-ink-500 mt-1.5">{t('ltr_linked_only_helper')}</p>
                )}
              </div>
            )}

            {isLedgerOnlyPersonFlow && type !== 'repayment' && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('onboard_currency_label')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {SUPPORTED_CURRENCIES.map((currency) => (
                    <button
                      key={currency}
                      type="button"
                      onClick={() => setLedgerCurrency(currency)}
                      className={ledgerCurrency === currency ? 'selector-base selector-selected' : 'selector-base'}
                    >
                      <span className="text-[13px] font-semibold text-ink-800">{currencyMeta[currency]?.flag} {currency}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {type === 'loan_taken' && availableCashAdvanceCards.length > 0 && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('cash_advance_source')}</label>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setSourceId('')}
                    className={`w-full p-3 rounded-2xl border text-left text-[12px] font-semibold transition-all ${
                      !selectedCashAdvanceCard ? 'border-accent-500 bg-accent-50 text-accent-600' : 'border-cream-border bg-cream-card text-ink-500'
                    }`}
                  >
                    No credit card
                  </button>
                  {availableCashAdvanceCards.map(a => (
                    <button key={a.id} type="button" onClick={() => setSourceId(a.id)}
                      className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                        selectedCashAdvanceCard?.id === a.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                      }`}
                    >
                      <div>
                        <p className="text-[13px] font-semibold text-ink-900">{a.name}</p>
                        <p className="text-[10px] text-ink-500">Credit card</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                        {renderAfterBalance(a)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* EMI Setup for Loans */}
            {needsPerson && (
              <div className="space-y-3">
                <label className="flex items-center gap-2.5 cursor-pointer p-3 rounded-2xl bg-cream-card border border-cream-border">
                  <input type="checkbox" checked={hasEmi} onChange={e => setHasEmi(e.target.checked)} className="w-4 h-4 rounded border-cream-border text-accent-600 accent-accent-600" />
                  <span className="text-[13px] text-ink-800 font-medium">{t('loan_set_emi')}</span>
                </label>
                {hasEmi && (
                  <div className="grid grid-cols-2 gap-3 animate-fade-in">
                    <div>
                      <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('loan_installments')}</label>
                      <input type="number" value={emiInstallments} onChange={e => setEmiInstallments(e.target.value)} placeholder="12" className={inputClass} />
                    </div>
                    <div>
                      <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">Start Date</label>
                      <input type="date" value={emiStartDate} onChange={e => setEmiStartDate(e.target.value)} className={inputClass} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {needsLoan && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_which_loan')}</label>
                {filteredLoans.length === 0 ? (
                  <p className="text-[12px] text-ink-500 bg-cream-soft border border-cream-hairline rounded-xl p-3 leading-relaxed">
                    {t('loan_no_tx')}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {selectedLoan && parseFloat(amount) > selectedLoan.remainingAmount + 0.00001 && (
                      <p className="text-[11px] text-pay-text font-semibold leading-relaxed bg-pay-50 border border-pay-100 rounded-xl px-3 py-2">
                        {t('err_overpayment').replace('{remaining}', formatMoney(selectedLoan.remainingAmount, selectedLoan.currency))}
                      </p>
                    )}
                    {filteredLoans.map(l => (
                      <button key={l.id} type="button" onClick={() => setLoanId(l.id)}
                        className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                          loanId === l.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-ink-900 truncate">{l.personName}</p>
                          <p className="text-[10px] text-ink-500">{l.type === 'given' ? t('loan_receivable') : t('loan_payable')}</p>
                        </div>
                        <p className="text-[13px] font-semibold text-ink-900 tabular-nums shrink-0 ml-2">{formatMoney(l.remainingAmount, l.currency)}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {needsLoan && selectedLoanIsLinked && (
              <div className="rounded-2xl bg-accent-50 border border-accent-100 p-3.5 space-y-2.5">
                <p className="text-[12px] text-accent-600 leading-relaxed">{t('ltr_repay_linked_notice')}</p>
                <button
                  type="button"
                  onClick={() => { if (selectedLoan) { reset(); onClose(); navigate(`/loan/${selectedLoan.id}`); } }}
                  className="w-full rounded-xl bg-ink-900 text-white py-2.5 text-[12px] font-semibold active:scale-[0.98] transition-transform"
                >{t('ltr_repay_linked_cta')}</button>
              </div>
            )}
            {needsLoan && !selectedLoanIsLinked && selectedLoan?.type === 'given' && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_money_where')}</label>
                <div className="space-y-2">
                  {accounts.map(a => {
                    const meta = currencyMeta[a.currency];
                    return (
                      <button key={a.id} type="button" onClick={() => setDestId(a.id)}
                        className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                          destId === a.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{meta?.flag}</span>
                          <div>
                            <p className="text-[13px] font-semibold text-ink-900">{a.name}</p>
                            <p className="text-[10px] text-ink-500 capitalize">{a.type.replace('_', ' ')}</p>
                          </div>
                        </div>
                        <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {needsLoan && !selectedLoanIsLinked && selectedLoan?.type === 'taken' && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_pay_from')}</label>
                <div className="space-y-2">
                  {accounts.map(a => {
                    const meta = currencyMeta[a.currency];
                    return (
                      <button key={a.id} type="button" onClick={() => setSourceId(a.id)}
                        className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                          sourceId === a.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{meta?.flag}</span>
                          <div>
                            <p className="text-[13px] font-semibold text-ink-900">{a.name}</p>
                            <p className="text-[10px] text-ink-500 capitalize">{a.type.replace('_', ' ')}</p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                          {renderAfterBalance(a)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {needsGoal && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_which_goal')}</label>
                <div className="space-y-2">
                  {goals.map(g => {
                    const pct = g.targetAmount > 0 ? Math.min(100, Math.round((g.savedAmount / g.targetAmount) * 100)) : 0;
                    return (
                      <button key={g.id} type="button" onClick={() => setGoalId(g.id)}
                        className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                          goalId === g.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-ink-900 truncate">{g.title}</p>
                          <p className="text-[10px] text-ink-500 tabular-nums">{formatMoney(g.savedAmount, g.currency)} / {formatMoney(g.targetAmount, g.currency)} · {pct}%</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {showCategory && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('category')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {(type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map(c => (
                    <button key={c} type="button" onClick={() => setCategory(c)}
                      className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-colors active:scale-95 ${
                        category === c ? 'bg-ink-900 text-white border-ink-900' : 'bg-cream-card text-ink-600 border-cream-border'
                      }`}
                    >{c}</button>
                  ))}
                </div>
              </div>
            )}

            {!isGroupExpense && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_note')}</label>
                <input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('quick_note_placeholder')} className={inputClass} />
              </div>
            )}

            {(needsPerson || needsLoan) && (
              <p className="text-[12px] text-ink-600 bg-cream-card border border-cream-border rounded-2xl p-3 leading-relaxed">
                {t('money_not_moved_notice')}
              </p>
            )}

            {/* Glanceable confirm/private chip near Save — tells the user
                whether this loan will mirror to a linked contact (who must
                confirm) or stay a private local-only record. */}
            {(type === 'loan_given' || type === 'loan_taken') && (() => {
              const personName = (preset?.lockContact && preset.contact ? preset.contact.name : contact.name).trim();
              if (wouldBranchToLinked) {
                return (
                  <div className="flex items-center gap-2 rounded-2xl bg-accent-50 border border-accent-100 px-3 py-2.5">
                    <Users size={13} className="text-accent-600 shrink-0" />
                    <p className="text-[11px] font-semibold text-accent-600 leading-snug">
                      {t('loan_will_confirm').replace('{name}', personName || t('loan_they'))}
                    </p>
                  </div>
                );
              }
              return (
                <div className="flex items-center gap-2 rounded-2xl bg-cream-soft border border-cream-border px-3 py-2.5">
                  <Lock size={13} className="text-ink-500 shrink-0" />
                  <p className="text-[11px] font-semibold text-ink-600 leading-snug">
                    {t('loan_private')}
                  </p>
                </div>
              );
            })()}

          </div>
        )}
      </Modal>

      <AddAccountStepper open={showInlineAccount} onClose={() => setShowInlineAccount(false)} onComplete={() => setShowInlineAccount(false)} inline />
      <ConfirmationSheet open={showConfirmation} onClose={() => { setShowConfirmation(false); onClose(); }} title={confirmData.title} description={confirmData.description} balanceChanges={confirmData.changes} viewRoute={confirmData.route} />
      <SpendingWarningModal
        open={showSpendingWarning}
        expense={nearestUpcoming}
        onContinue={() => handleSubmit()}
        onCancel={() => setShowSpendingWarning(false)}
      />
    </>
  );
}
