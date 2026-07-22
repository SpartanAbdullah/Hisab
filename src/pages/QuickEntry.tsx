import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
  HandCoins, Handshake, RotateCcw, Target, Delete, Users, Plus, ChevronDown, ChevronRight, Lock, Sparkles,
  Search, X, CreditCard,
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
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { ContactPicker, type ContactValue } from '../components/ContactPicker';
import { AccountSelect } from '../components/AccountSelect';
import { decideLinkedBranch } from '../lib/linkedRequestBranch';
import { linkedLoanIdSet } from '../lib/linkedLoanIdSet';
import { buildRepaymentGroups } from '../lib/repaymentGroups';
import { allocateRepayment, previewAllocations } from '../lib/repaymentAllocation';
import { executeAllocatedRepayments } from '../lib/repaymentExecution';
import { CurrencyConversionCard } from '../components/CurrencyConversionCard';
import { rateIsSane } from '../lib/conversionMath';
import { confirmCrossUserRequest } from '../lib/confirmCrossUserRequest';
import { ConfirmationSheet } from '../components/ConfirmationSheet';
import { SpendingWarningModal } from '../components/SpendingWarningModal';
import { useToast } from '../components/Toast';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import { CategoryPicker } from '../components/CategoryPicker';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { SUPPORTED_CURRENCIES, type Currency, type TransactionType, type SplitGroup, type Loan } from '../db';
import { AddAccountStepper } from './AddAccountStepper';

// Internal type slot widened to include the "group_expense" sentinel.
// It's NOT a real `TransactionType` (those map 1:1 to rows in the
// transactions table); group expenses live in their own table and are
// authored via AddGroupExpenseModal, so the type guard is "if the user
// picked this tile, route to the group-picker step and hand off to App."
type EntryKind = TransactionType | 'group_expense';
type EntryIntent = 'expense' | 'income' | 'transfer' | 'person_money' | 'group_expense' | 'cash_advance';
type RepaymentDirection = 'received' | 'paid' | null;
// What a repayment applies to: the person(+currency) GROUP — one lump spread
// across their loans oldest-first — or one specific loan line (today's
// behavior, still available under "choose a specific loan").
type RepayTarget = { kind: 'group'; key: string } | { kind: 'loan'; id: string } | null;

export interface QuickEntryPreset {
  type?: Extract<TransactionType, 'expense' | 'income' | 'transfer' | 'loan_given' | 'loan_taken' | 'repayment'>;
  // `intent` lets callers start QuickEntry at a higher level than `type`.
  // 'person_money' starts at the gave/borrowed/paid-back sub-picker;
  // 'group_expense' routes amount → group picker.
  intent?: 'person_money' | 'group_expense';
  contact?: ContactValue;
  repaymentDirection?: Exclude<RepaymentDirection, null>;
  accountId?: string;
  // Pre-fill the transfer DESTINATION (e.g. paying a credit-card bill, where
  // the card is the destination and the user picks which account pays).
  destinationAccountId?: string;
  // Cash advance: pre-select (and lock) the credit card funding a loan_taken.
  // Used by the card page's "Cash advance" action — the user only enters the
  // amount and picks where the cash landed; no contact is asked for.
  cashAdvanceCardId?: string;
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
  const guardClose = useDiscardGuard();

  const [step, setStep] = useState(0);
  const [intent, setIntent] = useState<EntryIntent | null>(null);
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<EntryKind>('expense');
  const [repaymentDirection, setRepaymentDirection] = useState<RepaymentDirection>(null);
  // Cash-advance mode: a loan_taken funded by one of the user's own credit
  // cards. No counterparty is asked for — the card IS the counterparty.
  const [cashAdvance, setCashAdvance] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [destId, setDestId] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [contact, setContact] = useState<ContactValue>({ id: null, name: '' });
  const [repayTarget, setRepayTarget] = useState<RepayTarget>(null);
  const [expandedGroupKey, setExpandedGroupKey] = useState('');
  const [loanSearch, setLoanSearch] = useState('');
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

  // Same safety-net for accounts and loans. QuickEntry can open over a page
  // that never loaded them (an unmatched URL, a cold deep-link) — the gate
  // used to read an empty store and lie: "You need an account first" with 13
  // accounts existing. Cache-first loads make this cheap on a warm cache.
  useEffect(() => {
    if (!open) return;
    const { accounts: loadedAccounts, loadAccounts } = useAccountStore.getState();
    if (loadedAccounts.length === 0) void loadAccounts().catch(() => {});
    const { loans: loadedLoans, loadLoans } = useLoanStore.getState();
    if (loadedLoans.length === 0) void loadLoans().catch(() => {});
    const { schedules, loadSchedules } = useEmiStore.getState();
    if (schedules.length === 0) void loadSchedules().catch(() => {});
  }, [open]);

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
  // shows everything; "Cash advance" appears only when a credit card exists.
  const hasCreditCard = accounts.some((a) => a.type === 'credit_card');
  const ALL_INTENTS: { value: EntryIntent; label: string; sub: string; icon: typeof ArrowUpRight }[] = [
    { value: 'expense', label: t('intent_spend'), sub: t('intent_spend_sub'), icon: ArrowUpRight },
    { value: 'income', label: t('intent_receive'), sub: t('intent_receive_sub'), icon: ArrowDownLeft },
    { value: 'transfer', label: t('intent_move'), sub: t('intent_move_sub'), icon: ArrowLeftRight },
    { value: 'person_money', label: t('intent_person'), sub: t('intent_person_sub'), icon: HandCoins },
    { value: 'group_expense', label: t('intent_group'), sub: t('intent_group_sub'), icon: Users },
    { value: 'cash_advance', label: t('intent_cash_advance'), sub: t('intent_cash_advance_sub'), icon: CreditCard },
  ];
  const INTENTS = appMode === 'splits_only'
    ? ALL_INTENTS.filter((i) => i.value === 'person_money' || i.value === 'group_expense')
    : ALL_INTENTS.filter((i) => i.value !== 'cash_advance' || hasCreditCard);

  const reset = () => {
    setStep(0); setIntent(null); setAmount(''); setType('expense'); setRepaymentDirection(null);
    setCashAdvance(false);
    setSourceId(''); setDestId(''); setCategory('');
    setNotes(''); setContact({ id: null, name: '' }); setRepayTarget(null); setExpandedGroupKey(''); setLoanSearch('');
    setGoalId(''); setConversionRate('');
    setHasEmi(false); setEmiInstallments(''); setEmiStartDate('');
  };
  const handleClose = () => { reset(); onClose(); };

  useEffect(() => {
    if (!open) return;
    // Type-first flow: the wizard opens on "What happened?" (step 1) and only
    // asks for the amount once the type is known, so the amount screen can
    // carry context. Presets that already know the type skip straight to the
    // amount; person_money presets start at the gave/borrowed/paid sub-picker.
    setStep(
      preset?.type || preset?.cashAdvanceCardId || preset?.intent === 'group_expense'
        ? 0
        : preset?.intent === 'person_money'
          ? 3
          : 1,
    );
    setIntent(preset?.intent ?? null);
    setAmount('');
    setType(preset?.intent === 'group_expense' ? 'group_expense' : (preset?.type ?? 'expense'));
    setRepaymentDirection(preset?.repaymentDirection ?? null);
    setCashAdvance(!!preset?.cashAdvanceCardId);
    setSourceId(
      preset?.cashAdvanceCardId
        ? preset.cashAdvanceCardId
        : preset?.accountId && ['expense', 'transfer', 'loan_given'].includes(preset.type ?? '')
          ? preset.accountId
          : '',
    );
    setDestId(
      preset?.accountId && ['income', 'loan_taken'].includes(preset.type ?? '') && !preset?.cashAdvanceCardId
        ? preset.accountId
        : preset?.destinationAccountId && preset.type === 'transfer'
          ? preset.destinationAccountId
          : '',
    );
    setContact(preset?.contact ?? { id: null, name: '' });
    setRepayTarget(null);
    setExpandedGroupKey('');
    setCategory('');
    setNotes('');
    setConversionRate('');
  }, [open, preset]);

  useEffect(() => {
    if (!open) return;
    if (preset?.cashAdvanceCardId) {
      if (type === 'loan_taken') setSourceId(preset.cashAdvanceCardId);
      return; // cash-advance preset carries no accountId — nothing else to re-apply
    }
    if (preset?.accountId) {
      if (['expense', 'transfer', 'loan_given'].includes(type)) setSourceId(preset.accountId);
      if (['income', 'loan_taken'].includes(type)) setDestId(preset.accountId);
      // Repayment splits by loan direction at submit; preselect both sides so
      // whichever one the chosen loan needs is already the viewed account.
      if (type === 'repayment') { setSourceId(preset.accountId); setDestId(preset.accountId); }
    }
    if (preset?.destinationAccountId && type === 'transfer') setDestId(preset.destinationAccountId);
  }, [open, preset?.accountId, preset?.destinationAccountId, preset?.cashAdvanceCardId, type]);

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
  // A loan is "linked" when an accepted linked_transaction_request mirrors it
  // to another Hisaab user. Such a loan must settle through the dedicated
  // settlement-request flow (so the counterparty confirms) — repaying it
  // locally here would diverge the two mirrored ledgers.
  const linkedLoanIds = linkedLoanIdSet(linkedRequests);
  const selectedLoan = repayTarget?.kind === 'loan' ? loans.find(l => l.id === repayTarget.id) : undefined;
  const selectedLoanIsLinked = !!selectedLoan && linkedLoanIds.has(selectedLoan.id);
  const hasAccounts = accounts.length > 0;

  // The person (+ currency) group is the primary repayment target: one lump
  // settles across their loans oldest-first, so ten borrowings never force
  // ten entries. Grouping reuses LoansPage's key rule so it stays consistent
  // app-wide; the search box narrows by name or note. When no direction was
  // picked (top-level Repayment tile) both directions are listed.
  const buildGroupsFor = (direction: 'received' | 'paid') =>
    buildRepaymentGroups({
      loans,
      direction,
      linkedLoanIds,
      personIdFilter: preset?.contact?.id,
      query: loanSearch,
    });
  const repaymentLoanGroups = repaymentDirection
    ? buildGroupsFor(repaymentDirection)
    : [...buildGroupsFor('received'), ...buildGroupsFor('paid')].sort((a, b) => b.totalRemaining - a.totalRemaining);
  // Pre-search count: drives the empty state and when the search box appears
  // (only once the list is long enough that scanning is the friction).
  const repayableLoanCount = loans.filter((l) =>
    l.status === 'active' &&
    (repaymentDirection === 'received' ? l.type === 'given' : repaymentDirection === 'paid' ? l.type === 'taken' : true) &&
    (!preset?.contact?.id || l.personId === preset.contact.id),
  ).length;
  const showLoanSearch = repayableLoanCount > 4;

  // Effective repayment context — one loan or a whole group. Every guard,
  // the account requirement and the conversion card key off these four
  // instead of a single selected loan.
  const selectedRepayGroup = repayTarget?.kind === 'group' ? repaymentLoanGroups.find((g) => g.key === repayTarget.key) : undefined;
  const repayDirectionType = selectedLoan?.type ?? selectedRepayGroup?.direction;
  const repayCurrency = selectedLoan?.currency ?? selectedRepayGroup?.currency;
  const repayCap = selectedLoan ? selectedLoan.remainingAmount : selectedRepayGroup?.allocatableRemaining ?? 0;
  // Oldest-first (FIFO): a consolidated return pays down what they've owed
  // longest — the split the user would have calculated by hand.
  const repayAllocations = selectedRepayGroup && parseFloat(amount) > 0
    ? allocateRepayment(selectedRepayGroup.allocatable, parseFloat(amount), 'oldest')
    : [];
  // A group target that reaches exactly one loan behaves byte-identically to
  // picking that loan directly (incl. the per-loan confirm route).
  const groupSingleLoan = repayTarget?.kind === 'group' && repayAllocations.length === 1
    ? loans.find((l) => l.id === repayAllocations[0].loanId)
    : undefined;
  const effectiveSingleLoan = selectedLoan ?? groupSingleLoan;
  const isGroupBatch = repayTarget?.kind === 'group' && repayAllocations.length > 1;

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

  // Side-aware account lock. A preset's accountId locks ONLY the side the
  // viewed account plays for the current type — never both. For transfers the
  // opposite list excludes the locked/selected account, otherwise "Move" from
  // an account page showed the same single account as both From and To and
  // the transfer could never be submitted (sourceId !== destId is required).
  const sourceLockId =
    preset?.lockAccount && preset.accountId && ['expense', 'transfer', 'loan_given', 'goal_contribution'].includes(type)
      ? preset.accountId
      : null;
  const destLockId =
    preset?.lockAccount && preset.accountId && ['income', 'loan_taken'].includes(type)
      ? preset.accountId
      : null;
  const sourceChoices = sourceLockId
    ? accounts.filter((a) => a.id === sourceLockId)
    : accounts.filter((a) => type !== 'transfer' || !destId || a.id !== destId);
  const destChoices = (() => {
    let list = destLockId
      ? accounts.filter((a) => a.id === destLockId)
      : accounts.filter((a) => type !== 'transfer' || !sourceId || a.id !== sourceId);
    // Cash advance: the money lands somewhere spendable — never another card —
    // and must match the funding card's currency (store-enforced).
    if (cashAdvance) {
      list = list.filter(
        (a) => a.type !== 'credit_card' && (!selectedCashAdvanceCard || a.currency === selectedCashAdvanceCard.currency),
      );
    }
    return list;
  })();

  // Seed account defaults when the details step opens so the collapsed
  // selector usually starts with the right account already picked: the
  // last-used account for everyday spend/receive, or the only account when
  // there's exactly one. Transfers stay manual (two sides must differ) and
  // presets/locks always win. The user can still tap the row to change.
  useEffect(() => {
    if (!open || step !== 2 || cashAdvance || isLedgerOnlyPersonFlow) return;
    // Seed ONLY an account whose currency matches what the amount was typed
    // under — expense/income have no conversion step, so a silently seeded
    // different-currency account would record the flat number in the wrong
    // currency. On mismatch we seed nothing and the user picks consciously.
    const seedable = (id: string) => {
      const a = accounts.find((x) => x.id === id);
      return a && a.currency === activeCurrency ? id : '';
    };
    const remembered = (key: string) => seedable(localStorage.getItem(key) ?? '');
    const onlyAccount = accounts.length === 1 ? seedable(accounts[0].id) : '';
    if (needsSource && !sourceId && type !== 'transfer' && !sourceLockId) {
      setSourceId((type === 'expense' ? remembered('hisaab_qe_last_source') : '') || onlyAccount);
    }
    if (needsDest && !destId && type !== 'transfer' && !destLockId) {
      setDestId((type === 'income' ? remembered('hisaab_qe_last_dest') : '') || onlyAccount);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, type]);

  // Active currency for the amount step + quick-amount presets. Prefer the
  // preset account's currency (when QuickEntry was launched pinned to an
  // account); otherwise the user's primary currency.
  const primaryCurrency = (localStorage.getItem('hisaab_primary_currency') as Currency) || 'AED';
  const presetAccountId = preset?.accountId ?? preset?.cashAdvanceCardId;
  const presetAccount = presetAccountId ? accounts.find(a => a.id === presetAccountId) : undefined;
  const activeCurrency: Currency = presetAccount?.currency ?? primaryCurrency;
  // Quick-amount chips scale with the primary currency: PKR users deal in
  // far larger nominal amounts than AED users, so offer a bigger preset set.
  const quickAmounts = primaryCurrency === 'PKR'
    ? [500, 1000, 5000, 10000, 50000]
    : [50, 100, 500, 1000, 5000];

  // Determine if cross-currency conversion is needed
  const isCrossCurrency = (() => {
    if (type === 'transfer' && srcAccount && dstAccount) return srcAccount.currency !== dstAccount.currency;
    if (type === 'repayment' && repayCurrency && repayDirectionType) {
      if (repayDirectionType === 'given' && dstAccount) return dstAccount.currency !== repayCurrency;
      if (repayDirectionType === 'taken' && srcAccount) return srcAccount.currency !== repayCurrency;
    }
    if (type === 'goal_contribution' && srcAccount && selectedGoal) return srcAccount.currency !== selectedGoal.currency;
    return false;
  })();

  // Per-type props for the conversion card. `known` is the side the user has
  // already typed (the main amount); `other` is what the card asks about.
  // rateSemantics mirrors the store math EXACTLY:
  //   transfer / repayment-given → other = amount * rate  ('other-per-known')
  //   repayment-taken / goal     → other = amount / rate  ('known-per-other')
  // Previously the repayment-taken label asked for the rate in the opposite
  // direction from what the store divided by — following the label corrupted
  // the deduction. The card derives the rate from amounts, so the direction
  // can no longer be entered backwards.
  const conversionProps = (() => {
    if (type === 'transfer' && srcAccount && dstAccount)
      return { knownCurrency: srcAccount.currency, otherCurrency: dstAccount.currency, otherSide: 'receiving' as const, rateSemantics: 'other-per-known' as const };
    if (type === 'repayment' && repayCurrency && repayDirectionType) {
      // Same per-unit rate applies to every loan in a group batch — they all
      // share the group's currency by construction.
      if (repayDirectionType === 'given' && dstAccount)
        return { knownCurrency: repayCurrency, otherCurrency: dstAccount.currency, otherSide: 'receiving' as const, rateSemantics: 'other-per-known' as const };
      if (repayDirectionType === 'taken' && srcAccount)
        return { knownCurrency: repayCurrency, otherCurrency: srcAccount.currency, otherSide: 'paying' as const, rateSemantics: 'known-per-other' as const };
    }
    if (type === 'goal_contribution' && srcAccount && selectedGoal)
      return { knownCurrency: selectedGoal.currency, otherCurrency: srcAccount.currency, otherSide: 'paying' as const, rateSemantics: 'known-per-other' as const };
    return null;
  })();

  // Conversion-rate sanity bounds (Phase H2 hardening). A typo'd rate
  // would silently corrupt balances; reject outside a sane window.
  const rateIsValid = () => {
    if (!isCrossCurrency) return true;
    return rateIsSane(parseFloat(conversionRate));
  };

  const canSubmit = () => {
    const amt = parseFloat(amount);
    if (!amt) return false;
    // BATCH6: Block ALL cross-currency submissions without rate
    if (isCrossCurrency && !parseFloat(conversionRate)) return false;
    // Phase H2: reject out-of-bounds conversion rates
    if (!rateIsValid()) return false;
    // Phase H2: overpayment guard on repayments (mirrors the simple-mode
    // check at line 337, now applied to all paths). For a group target the
    // cap is the person's total allocatable remaining.
    if (type === 'repayment' && repayTarget) {
      if (amt > repayCap + 0.00001) return false;
    }
    switch (type) {
      case 'income': return !!destId;
      case 'expense': return !!sourceId;
      case 'transfer': return !!sourceId && !!destId && sourceId !== destId;
      case 'loan_given': return (isLedgerOnlyPersonFlow || !!sourceId) && !!contact.name.trim();
      case 'loan_taken':
        // Cash advance: the card is the counterparty — require the card
        // (sourceId) instead of a typed contact.
        if (cashAdvance) return !!destId && !!selectedCashAdvanceCard;
        return (isLedgerOnlyPersonFlow || !!destId) && !!contact.name.trim();
      case 'repayment':
        if (!repayTarget) return false;
        if (repayTarget.kind === 'loan') {
          if (!selectedLoan) return false;
          // Linked loans settle via the loan page, not here.
          if (selectedLoanIsLinked) return false;
        } else if (!selectedRepayGroup || selectedRepayGroup.allocatable.length === 0) {
          return false;
        }
        if (isLedgerOnlyPersonFlow) return true;
        return repayDirectionType === 'given' ? !!destId : !!sourceId;
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
    // Only warn when this spend would actually leave the account short of the
    // upcoming bill — i.e. the balance after this deduction drops below the
    // bill amount. Previously EVERY spend for 30 days after adding a bill
    // triggered the full-screen warning, regardless of whether it threatened it.
    const amt = parseFloat(amount) || 0;
    const wouldFallShort =
      nearestUpcoming && srcAccount &&
      srcAccount.balance - amt < nearestUpcoming.amount;
    if (wouldFallShort && ['expense', 'transfer', 'loan_given', 'goal_contribution'].includes(type)) {
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
      // is the source of truth for whether a contact row must exist. A cash
      // advance has no human counterparty — the card is the lender — so no
      // Person row is created (it would pollute the contact pickers).
      const resolvedPerson = needsPerson && !cashAdvance
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
          if (amt > repayCap + 0.00001) {
            throw new Error('Repayment cannot exceed the remaining balance');
          }
          if (isGroupBatch && selectedRepayGroup) {
            // Consolidated repayment (ledger-only): one lump across the
            // person's loans, oldest first. No accounts are involved.
            const result = await executeAllocatedRepayments(repayAllocations, {
              mode: 'splits_only',
              direction: selectedRepayGroup.direction,
              notes,
              processTransaction,
              applyRepayment,
            });
            if (result.failed && result.done === 0) {
              throw result.failed.error instanceof Error ? result.failed.error : new Error('Failed');
            }
            if (result.failed) {
              // Committed prefix stays — report how far we got so a retry
              // only needs to cover the rest.
              toast.show({
                type: 'error',
                title: t('alloc_partial_title').replace('{done}', String(result.done)).replace('{total}', String(result.total)),
                subtitle: result.failed.error instanceof Error ? result.failed.error.message : t('toast_error_generic'),
                duration: 6000,
              });
              reset();
              onClose();
              return;
            }
            const clearedCount = previewAllocations(selectedRepayGroup.allocatable, repayAllocations).filter((l) => l.cleared).length;
            setConfirmData({
              title: t('confirm_repayment_saved'),
              description:
                t('qe_group_done_desc')
                  .replace('{amount}', formatMoney(result.totalApplied, selectedRepayGroup.currency))
                  .replace('{n}', String(result.total)) +
                (clearedCount > 0 ? ` · ${t('qe_group_cleared_count').replace('{n}', String(clearedCount))}` : ''),
              changes: [],
            });
            setShowConfirmation(true);
            reset();
            return;
          }
          if (!effectiveSingleLoan) throw new Error('Loan not found');
          await applyRepayment(effectiveSingleLoan.id, amt, notes);
          setConfirmData({
            title: t('confirm_repayment_saved'),
            description: (effectiveSingleLoan.type === 'given' ? t('repay_done_received_desc') : t('repay_done_paid_desc'))
              .replace('{person}', effectiveSingleLoan.personName)
              .replace('{amount}', formatMoney(amt, effectiveSingleLoan.currency)),
            changes: [],
            route: `/loan/${effectiveSingleLoan.id}`,
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
            description: (loan.type === 'given' ? t('loan_done_owes_you') : t('loan_done_you_owe'))
              .replace('{person}', loan.personName)
              .replace('{amount}', formatMoney(amt, loan.currency)),
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
      // Card-funded entries never branch: a cash advance is between the user
      // and their own card — branching here used to fire a cross-user request
      // and silently skip the card debit entirely.
      if (appMode !== 'splits_only' && (type === 'loan_given' || type === 'loan_taken') && !selectedCashAdvanceCard) {
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

      // Consolidated repayment (full tracker): one lump across a person's
      // loans, oldest first, executed as N ordinary single-loan repayments.
      // Each commits independently — a mid-batch failure keeps the committed
      // prefix and is reported honestly; a retry with the remainder
      // recomputes from the reduced remainings, so double-pay is impossible.
      if (type === 'repayment' && isGroupBatch && selectedRepayGroup) {
        const direction = selectedRepayGroup.direction;
        const batchAccountId = direction === 'given' ? destId : sourceId;
        const account = accounts.find((a) => a.id === batchAccountId);
        if (!account) throw new Error('Account not found');
        const rate = parseFloat(conversionRate) || undefined;
        // Sum the PER-ITEM rounded conversions — the store rounds each of the
        // N repayments separately, so rounding once on the total here would
        // drift from the real balance by cents and could let a razor-thin
        // 'taken' pre-flight pass only to fail mid-batch.
        const perItemMove = (a: number) => isCrossCurrency && rate
          ? (direction === 'given' ? Math.round(a * rate * 100) / 100 : Math.round(a / rate * 100) / 100)
          : a;
        const totalMove = Math.round(repayAllocations.reduce((a, x) => a + perItemMove(x.amount), 0) * 100) / 100;
        const accountMove = direction === 'given' ? totalMove : -totalMove;
        // The store rejects any single deduction that would overdraw the
        // account, so a 'taken' batch the balance can't fully cover is a
        // guaranteed mid-batch failure — refuse to start instead.
        if (direction === 'taken' && account.balance < -accountMove) {
          toast.show({ type: 'error', title: t('error'), subtitle: t('err_batch_balance_short') });
          return;
        }
        const result = await executeAllocatedRepayments(repayAllocations, {
          mode: 'tracker',
          direction,
          accountId: batchAccountId,
          conversionRate: isCrossCurrency ? rate : undefined,
          notes,
          processTransaction,
          applyRepayment,
        });
        if (result.failed && result.done === 0) {
          throw result.failed.error instanceof Error ? result.failed.error : new Error('Transaction failed');
        }
        if (result.failed) {
          toast.show({
            type: 'error',
            title: t('alloc_partial_title').replace('{done}', String(result.done)).replace('{total}', String(result.total)),
            subtitle: result.failed.error instanceof Error ? result.failed.error.message : t('toast_error_generic'),
            duration: 6000,
          });
          reset();
          onClose();
          return;
        }
        const clearedCount = previewAllocations(selectedRepayGroup.allocatable, repayAllocations).filter((l) => l.cleared).length;
        setConfirmData({
          title: `${t('tx_repayment')} — Done!`,
          description:
            t('qe_group_done_desc')
              .replace('{amount}', formatMoney(result.totalApplied, selectedRepayGroup.currency))
              .replace('{n}', String(result.total)) +
            (clearedCount > 0 ? ` · ${t('qe_group_cleared_count').replace('{n}', String(clearedCount))}` : ''),
          // `account` was captured before the batch ran, so before/after
          // reflect the pre-batch balance plus the aggregate move.
          changes: [{ accountName: account.name, currency: account.currency, before: account.balance, after: account.balance + accountMove }],
        });
        setShowConfirmation(true);
        reset();
        return;
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
          // Cash advance: the card is the counterparty — record its name on
          // the loan but create no Person row (personId stays null).
          input = {
            type: 'loan_taken',
            amount: amt,
            destinationAccountId: destId,
            sourceAccountId: selectedCashAdvanceCard?.id,
            personName: cashAdvance && selectedCashAdvanceCard ? selectedCashAdvanceCard.name : resolvedPerson!.name,
            personId: cashAdvance ? null : resolvedPerson!.id,
            notes,
          };
          break;
        }
        case 'repayment': {
          if (!effectiveSingleLoan) throw new Error('Loan not found');
          const rate = parseFloat(conversionRate) || undefined;
          if (effectiveSingleLoan.type === 'given' && destId) {
            const d = accounts.find(a => a.id === destId)!;
            const addAmt = isCrossCurrency && rate ? Math.round(amt * rate * 100) / 100 : amt;
            changes.push({ accountName: d.name, currency: d.currency, before: d.balance, after: d.balance + addAmt });
          } else if (effectiveSingleLoan.type === 'taken' && sourceId) {
            const s = accounts.find(a => a.id === sourceId)!;
            const deductAmt = isCrossCurrency && rate ? Math.round(amt / rate * 100) / 100 : amt;
            changes.push({ accountName: s.name, currency: s.currency, before: s.balance, after: s.balance - deductAmt });
          }
          input = { type: 'repayment', amount: amt, loanId: effectiveSingleLoan.id, sourceAccountId: effectiveSingleLoan.type === 'taken' ? sourceId : undefined, destinationAccountId: effectiveSingleLoan.type === 'given' ? destId : undefined, conversionRate: isCrossCurrency ? rate : undefined, notes };
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

      // Remember the everyday accounts so the next spend/receive opens with
      // the selector already on the right one. Only from a generic entry —
      // an account-page launch pins its own account and says nothing about
      // the user's habitual choice.
      if (!preset?.accountId) {
        if (type === 'expense' && sourceId) localStorage.setItem('hisaab_qe_last_source', sourceId);
        if (type === 'income' && destId) localStorage.setItem('hisaab_qe_last_dest', destId);
      }

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
            title: t('emi_schedule_failed_title'),
            subtitle: t('emi_schedule_failed_sub'),
            duration: 6000,
          });
        }
      }

      const typeLabel = cashAdvance ? t('intent_cash_advance') : (TX_TYPES.find(tx => tx.value === type)?.label ?? type);
      const confirmationCurrency = changes[0]?.currency ?? localStorage.getItem('hisaab_primary_currency') ?? 'PKR';
      const resultDescription = (() => {
        const first = changes[0];
        if (type === 'expense' && first) return t('qe_done_deducted').replace('{amount}', formatMoney(amt, first.currency)).replace('{account}', first.accountName);
        if (type === 'income' && first) return t('qe_done_added').replace('{amount}', formatMoney(amt, first.currency)).replace('{account}', first.accountName);
        if (type === 'transfer' && changes.length === 2) return t('qe_done_moved').replace('{amount}', formatMoney(amt, changes[0].currency)).replace('{src}', changes[0].accountName).replace('{dst}', changes[1].accountName);
        if (type === 'loan_given') return t('loan_done_owes_you').replace('{person}', resolvedPerson!.name).replace('{amount}', formatMoney(amt, confirmationCurrency));
        if (type === 'loan_taken' && cashAdvance && selectedCashAdvanceCard) {
          return t('qe_ca_done_desc')
            .replace('{amount}', formatMoney(amt, selectedCashAdvanceCard.currency))
            .replace('{card}', selectedCashAdvanceCard.name)
            .replace('{account}', accounts.find(a => a.id === destId)?.name ?? '');
        }
        if (type === 'loan_taken') return t('loan_done_you_owe').replace('{person}', resolvedPerson!.name).replace('{amount}', formatMoney(amt, confirmationCurrency));
        if (type === 'repayment' && effectiveSingleLoan) {
          return (effectiveSingleLoan.type === 'given' ? t('repay_done_received_desc') : t('repay_done_paid_desc'))
            .replace('{person}', effectiveSingleLoan.personName)
            .replace('{amount}', formatMoney(amt, effectiveSingleLoan.currency));
        }
        return `${formatMoney(amt, confirmationCurrency)} saved.`;
      })();
      // Deep-link the "View" button only where a detail page exists: loans
      // (incl. the loan a repayment belongs to) and goals. Plain
      // expense/income/transfer have no per-record route, so leave it unset
      // and the View button hides gracefully.
      const confirmRoute = (() => {
        if ((type === 'loan_given' || type === 'loan_taken') && resultTx.relatedLoanId) return `/loan/${resultTx.relatedLoanId}`;
        if (type === 'repayment' && effectiveSingleLoan) return `/loan/${effectiveSingleLoan.id}`;
        if (type === 'goal_contribution') return '/goals';
        return undefined;
      })();
      setConfirmData({
        title: (emiFailed ? t('title_saved_emi_pending') : t('title_done')).replace('{label}', typeLabel),
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

  // Type-first flow: the amount screen knows what's being recorded, so its
  // title asks the specific question instead of a context-free "How much?".
  const amountTitle = (() => {
    if (cashAdvance) return t('qe_amt_cash_advance');
    switch (type) {
      case 'expense': return t('qe_amt_expense');
      case 'income': return t('qe_amt_income');
      case 'transfer': return t('qe_amt_transfer');
      case 'loan_given': return t('qe_amt_loan_given');
      case 'loan_taken': return t('qe_amt_loan_taken');
      case 'repayment': return repaymentDirection === 'paid' ? t('qe_amt_repay_paid') : t('qe_amt_repay_received');
      case 'goal_contribution': return t('qe_amt_goal');
      case 'group_expense': return t('qe_amt_group');
      default: return t('quick_how_much');
    }
  })();
  // The amount step offers a back arrow only when a previous screen exists —
  // presets that fix the type land directly on the amount.
  const canGoBackFromAmount = !preset?.type && !preset?.cashAdvanceCardId;

  return (
    <>
      <Modal open={open && !showInlineAccount} onClose={handleClose}
        confirmClose={() => guardClose(!!amount.trim() || step === 2)}
        title={step === 0 ? amountTitle : step === 2 ? t('quick_details') : t('qe_title_what_happened')}
        footer={step === 0 ? (
          <div className="flex gap-2.5">
          {canGoBackFromAmount && (
            <button
              onClick={() => setStep(intent === 'person_money' ? 3 : 1)}
              className="px-4 rounded-2xl text-sm font-semibold border border-cream-border text-ink-500 active:bg-cream-soft transition-colors bg-cream-card"
            >
              &#x2190;
            </button>
          )}
          <button
            onClick={() => {
              if (parseFloat(amount) <= 0) return;
              // Type-first flow: the type is already chosen before the
              // amount, so Next always lands on the details step.
              setStep(2);
            }}
            disabled={!parseFloat(amount)}
            className="flex-1 bg-ink-900 text-white rounded-2xl py-4 text-sm font-semibold disabled:opacity-30 active:scale-[0.98] transition-transform"
          >{`${t('quick_next')} \u2192`}</button>
          </div>
        ) : step === 2 ? (
          isGroupExpense ? (
            // Group expense exits via the picker tap, not a Save button.
            // Just give the user a way back to change the amount.
            <button
              onClick={() => setStep(0)}
              className="w-full text-center text-[12px] text-ink-500 py-2 font-medium"
            >
              &#x2190; {t('quick_change_amount')}
            </button>
          ) : (
            <div className="flex gap-2.5">
              <button onClick={() => setStep(0)} className="px-4 py-3.5 rounded-2xl text-sm font-semibold border border-cream-border text-ink-500 active:bg-cream-soft transition-colors bg-cream-card">
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
              {/* readOnly + inputMode="none": the in-app numpad below is the
                  single input surface on touch — previously tapping the field
                  ALSO opened the phone's native keyboard, showing two keypads
                  at once. Physical keyboards still work via onKeyDown. */}
              <input
                ref={amountRef}
                type="text"
                inputMode="none"
                readOnly
                value={amount}
                onKeyDown={(e) => {
                  if (e.key >= '0' && e.key <= '9') { numpadPress(e.key); e.preventDefault(); }
                  else if (e.key === '.') { numpadPress('.'); e.preventDefault(); }
                  else if (e.key === 'Backspace' || e.key === 'Delete') { numpadPress('del'); e.preventDefault(); }
                }}
                placeholder="0"
                className="text-[54px] font-semibold text-center w-full border-none outline-none bg-transparent tabular-nums text-ink-900 caret-transparent"
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

            {/* Plain-words entry lives in Hisaab AI — surface it here so the
                headline "type it in words" claim is discoverable from the FAB,
                not hidden behind a separate tab. */}
            <button
              onClick={() => { handleClose(); navigate('/hisaab-ai'); }}
              className="w-full flex items-center justify-center gap-1.5 text-[12px] text-ink-500 active:scale-[0.98] transition-transform pt-1 min-h-[40px]"
            >
              <Sparkles size={13} className="text-accent-500 shrink-0" />
              {t('quick_type_instead')}
            </button>

          </div>
        )}

        {/* Step 1: What happened? — type-first, so every later screen has
            context. The amount comes next. */}
        {step === 1 && (
          <div className="space-y-5 animate-fade-in">
            <p className="text-[12px] text-ink-500 leading-relaxed">{t('quick_where_money')}</p>
            <div className="grid grid-cols-2 gap-2.5">
              {INTENTS.map(tx => {
                const Icon = tx.icon;
                const isActive = intent === tx.value;
                // Tone-map by transaction semantics: receive (green) for inflows,
                // pay (coral) for outflows, accent (violet) for people/groups,
                // warn (amber) for cash advance — card debt deserves its own
                // colour, not the neutral cream that made it look like Move —
                // and neutral (ink/cream) for transfer.
                const tone =
                  tx.value === 'income'
                    ? 'receive'
                    : tx.value === 'expense'
                    ? 'pay'
                    : tx.value === 'group_expense' || tx.value === 'person_money'
                    ? 'accent'
                    : tx.value === 'cash_advance'
                    ? 'warn'
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
                    // Clear account picks left over from a previously chosen
                    // type — a stale credit-card sourceId would otherwise turn
                    // a person-borrow into a silent cash advance. Preset
                    // accounts re-apply via the hydration effect.
                    setSourceId('');
                    setDestId('');
                    if (tx.value === 'person_money') {
                      setCashAdvance(false);
                      setStep(3);
                    } else if (tx.value === 'cash_advance') {
                      // Cash advance is a loan_taken funded by the user's own
                      // credit card — no contact will be asked for.
                      setType('loan_taken');
                      setRepaymentDirection(null);
                      setCashAdvance(true);
                      setStep(0);
                    } else {
                      setType(tx.value);
                      setCashAdvance(false);
                      setStep(0);
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
                  setCashAdvance(false);
                  // Stale account picks from an earlier type choice must not
                  // leak into this flow; presets re-apply via the effect.
                  setSourceId('');
                  setDestId('');
                  setStep(0);
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
            {/* When the sheet was launched straight into the person picker
                (contact page preset) there is no earlier screen to go back to. */}
            {preset?.intent !== 'person_money' && (
              <button onClick={() => setStep(1)} className="w-full text-center text-[12px] text-ink-500 py-2 font-medium">
                &#x2190; {t('back')}
              </button>
            )}
          </div>
        )}

        {/* Step 2: Details */}
        {step === 2 && (
          <div className="space-y-4 animate-fade-in">
            {/* Summary. Cash advance wears its warn identity here too — the
                same amber as its intent tile, so the mode is unmistakable. */}
            <div className={`rounded-2xl p-3.5 flex items-center justify-between border ${cashAdvance ? 'bg-warn-50 border-warn-100' : 'bg-cream-card border-cream-border'}`}>
              <div className="flex items-center gap-2.5">
                {(() => {
                  const Icon = cashAdvance ? CreditCard : TX_TYPES.find(tx => tx.value === type)?.icon;
                  if (!Icon) return null;
                  return (
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center border ${cashAdvance ? 'bg-warn-100/60 border-warn-100 text-warn-600' : 'bg-cream-soft border-cream-hairline text-ink-600'}`}>
                      <Icon size={14} />
                    </div>
                  );
                })()}
                <span className={`text-[13px] font-semibold tracking-tight ${cashAdvance ? 'text-warn-700' : 'text-ink-900'}`}>
                  {cashAdvance ? t('intent_cash_advance') : TX_TYPES.find(tx => tx.value === type)?.label}
                </span>
              </div>
              <span className={`font-semibold text-[15px] tabular-nums ${cashAdvance ? 'text-warn-700' : 'text-ink-900'}`}>{parseFloat(amount).toLocaleString()}</span>
            </div>

            {/* Group expense branch — pick an existing group OR create a
                new one. Either path closes QuickEntry; App.tsx then opens
                AddGroupExpenseModal (with the typed amount prefilled) or
                CreateGroupModal → AddGroupExpenseModal chained. */}
            {isGroupExpense && (
              <div className="space-y-3 animate-fade-in">
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em]">
                  {t('qe_which_group')}
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
            {/* Cash advance: pick the funding card first (locked when launched
                from the card's own page), then where the cash landed. */}
            {cashAdvance && !isLedgerOnlyPersonFlow && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('qe_ca_which_card')}</label>
                {preset?.cashAdvanceCardId && (() => {
                  const lockedCard = accounts.find(a => a.id === preset.cashAdvanceCardId);
                  if (!lockedCard) return null;
                  return (
                    <p className="text-[10.5px] text-accent-600 font-semibold mb-2 flex items-center gap-1.5">
                      <Lock size={11} /> {t('qe_ca_locked').replace('{name}', lockedCard.name)}
                    </p>
                  );
                })()}
                <AccountSelect
                  accounts={preset?.cashAdvanceCardId
                    ? accounts.filter(a => a.id === preset.cashAdvanceCardId)
                    : accounts.filter(a => a.type === 'credit_card' && (!dstAccount || a.currency === dstAccount.currency))}
                  selectedId={sourceId}
                  onSelect={setSourceId}
                  locked={!!preset?.cashAdvanceCardId}
                  renderRight={(a) => (
                    <>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                      {renderAfterBalance(a)}
                    </>
                  )}
                />
                <p className="text-[11px] text-ink-500 leading-relaxed bg-cream-card border border-cream-border rounded-2xl p-3 mt-2">
                  {t('qe_ca_helper')}
                </p>
              </div>
            )}

            {needsSource && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_from')}</label>
                {sourceLockId && (() => {
                  const lockedAcct = accounts.find(a => a.id === sourceLockId);
                  if (!lockedAcct) return null;
                  return (
                    <p className="text-[10.5px] text-accent-600 font-semibold mb-2 flex items-center gap-1.5">
                      <Lock size={11} /> {t('locked_to_account').replace('{name}', lockedAcct.name)}
                    </p>
                  );
                })()}
                <AccountSelect
                  accounts={sourceChoices}
                  selectedId={sourceId}
                  onSelect={(id) => {
                    setSourceId(id);
                    // A different account can mean a different currency — a
                    // previously typed conversion no longer applies.
                    setConversionRate('');
                  }}
                  locked={!!sourceLockId}
                  renderRight={(a) => (
                    <>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                      {renderAfterBalance(a)}
                    </>
                  )}
                />
              </div>
            )}

            {needsDest && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">
                  {cashAdvance ? t('qe_ca_dest_label') : t('quick_to')}
                </label>
                {destLockId && (() => {
                  const lockedAcct = accounts.find(a => a.id === destLockId);
                  if (!lockedAcct) return null;
                  return (
                    <p className="text-[10.5px] text-accent-600 font-semibold mb-2 flex items-center gap-1.5">
                      <Lock size={11} /> {t('locked_to_account').replace('{name}', lockedAcct.name)}
                    </p>
                  );
                })()}
                <AccountSelect
                  accounts={destChoices}
                  selectedId={destId}
                  onSelect={(id) => {
                    setDestId(id);
                    setConversionRate('');
                  }}
                  locked={!!destLockId}
                />
              </div>
            )}

            {/* Cross-currency: ask for the amount that landed/left on the
                other side and derive the rate — no rate-direction guessing. */}
            {isCrossCurrency && conversionProps && (
              <CurrencyConversionCard
                knownAmount={parseFloat(amount) || 0}
                knownCurrency={conversionProps.knownCurrency}
                otherCurrency={conversionProps.otherCurrency}
                otherSide={conversionProps.otherSide}
                rateSemantics={conversionProps.rateSemantics}
                rate={conversionRate}
                onRateChange={setConversionRate}
              />
            )}

            {needsPerson && !cashAdvance && (
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

            {/* The old opt-in "Cash Advance Source" picker that hid inside the
                person-borrow flow is gone — cash advances now have their own
                explicit entry (intent tile + card-page action) with the card
                picker rendered above. Borrowing from a person is person-only. */}

            {/* EMI Setup for Loans (incl. cash advances — card installment
                plans are the most common EMI case) */}
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
                      <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('kameti_start_date')}</label>
                      <input type="date" value={emiStartDate} onChange={e => setEmiStartDate(e.target.value)} className={inputClass} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {needsLoan && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_which_loan')}</label>
                {repayableLoanCount === 0 ? (
                  <p className="text-[12px] text-ink-500 bg-cream-soft border border-cream-hairline rounded-xl p-3 leading-relaxed">
                    {t('loan_no_tx')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {/* Only when the target still resolves — a search query can
                        hide the selected group, and an empty error box helps
                        no one (canSubmit already blocks that state). */}
                    {(selectedRepayGroup || selectedLoan) && parseFloat(amount) > repayCap + 0.00001 && (
                      <p className="text-[11px] text-pay-text font-semibold leading-relaxed bg-pay-50 border border-pay-100 rounded-xl px-3 py-2">
                        {selectedRepayGroup
                          ? t('err_overpayment_group')
                              .replace('{person}', selectedRepayGroup.name)
                              .replace('{remaining}', formatMoney(selectedRepayGroup.allocatableRemaining, selectedRepayGroup.currency))
                          : t('err_overpayment').replace('{remaining}', formatMoney(selectedLoan!.remainingAmount, selectedLoan!.currency))}
                      </p>
                    )}
                    {/* Search — appears once the list is long enough that finding
                        the right loan by scanning is the friction users hit. */}
                    {showLoanSearch && (
                      <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
                        <input
                          value={loanSearch}
                          onChange={(e) => setLoanSearch(e.target.value)}
                          placeholder={t('quick_loan_search_placeholder')}
                          className="w-full border border-cream-border rounded-2xl pl-9 pr-9 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all"
                        />
                        {loanSearch && (
                          <button
                            type="button"
                            onClick={() => setLoanSearch('')}
                            aria-label="Clear search"
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400 active:text-ink-600"
                          >
                            <X size={15} />
                          </button>
                        )}
                      </div>
                    )}
                    {repaymentLoanGroups.length === 0 ? (
                      <p className="text-[12px] text-ink-500 bg-cream-soft border border-cream-hairline rounded-xl p-3 leading-relaxed">
                        {t('search_no_matches').replace('{q}', loanSearch.trim())}
                      </p>
                    ) : (
                      // One card per person (+ currency): the person is the
                      // primary payment target — one lump settles across all
                      // their loans, oldest first. Single-loan people keep the
                      // plain per-loan row; "choose a specific loan" expands
                      // the individual lines for line-level control.
                      repaymentLoanGroups.map((group) => {
                        const isSelectedGroup = repayTarget?.kind === 'group' && repayTarget.key === group.key;
                        const multi = group.allocatable.length > 1;
                        const expanded = expandedGroupKey === group.key || group.allocatable.length === 0;
                        const loanRow = (l: Loan) => (
                          <button key={l.id} type="button"
                            onClick={() => {
                              // A different loan can carry a different
                              // currency — drop any typed conversion.
                              if (!(repayTarget?.kind === 'loan' && repayTarget.id === l.id)) setConversionRate('');
                              setRepayTarget({ kind: 'loan', id: l.id });
                            }}
                            className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                              repayTarget?.kind === 'loan' && repayTarget.id === l.id ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="text-[12.5px] font-medium text-ink-800 truncate">
                                {l.notes?.trim() ? l.notes : (l.type === 'given' ? t('loan_receivable') : t('loan_payable'))}
                              </p>
                              <p className="text-[10px] text-ink-500 mt-0.5">
                                {new Date(l.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                              </p>
                            </div>
                            <p className="text-[13px] font-semibold text-ink-900 tabular-nums shrink-0 ml-2">{formatMoney(l.remainingAmount, l.currency)}</p>
                          </button>
                        );
                        if (!multi) {
                          return (
                            <div key={group.key} className="space-y-1.5">
                              <div className="flex items-center justify-between px-0.5">
                                <p className="text-[12px] font-semibold text-ink-900 truncate">{group.name}</p>
                                <p className="text-[10.5px] text-ink-500 tabular-nums shrink-0 ml-2">
                                  {group.loans.length > 1 ? `${t('qe_group_n_loans').replace('{n}', String(group.loans.length))} · ` : ''}
                                  {formatMoney(group.totalRemaining, group.currency)}
                                </p>
                              </div>
                              <div className="space-y-2">{group.loans.map(loanRow)}</div>
                            </div>
                          );
                        }
                        return (
                          <div key={group.key} className="space-y-1.5">
                            <button type="button"
                              onClick={() => {
                                if (!isSelectedGroup) setConversionRate('');
                                setRepayTarget({ kind: 'group', key: group.key });
                              }}
                              className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                                isSelectedGroup ? 'border-accent-500 bg-accent-50' : 'border-cream-border bg-cream-card'
                              }`}
                            >
                              <div className="min-w-0">
                                <p className="text-[13px] font-semibold text-ink-900 truncate">{group.name}</p>
                                <p className="text-[10px] text-ink-500 mt-0.5">
                                  {t('qe_group_n_loans').replace('{n}', String(group.allocatable.length))} · {t('qe_group_all_loans')}
                                </p>
                              </div>
                              <p className="text-[13px] font-semibold text-ink-900 tabular-nums shrink-0 ml-2">
                                {formatMoney(group.allocatableRemaining, group.currency)}
                              </p>
                            </button>
                            {group.linked.length > 0 && (
                              <p className="text-[10.5px] text-ink-500 leading-relaxed px-0.5">{t('alloc_linked_note')}</p>
                            )}
                            {isSelectedGroup && repayAllocations.length > 0 && (
                              <div className="rounded-2xl border border-cream-border bg-cream-soft/60 p-3 space-y-2">
                                <p className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-500">{t('qe_group_alloc_note')}</p>
                                {(() => {
                                  const ordered = [...group.allocatable].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                                  const byId = new Map(ordered.map((l) => [l.id, l]));
                                  return previewAllocations(ordered, repayAllocations).map((line) => {
                                    const l = byId.get(line.loanId)!;
                                    return (
                                      <div key={line.loanId} className="flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                          <p className="text-[11.5px] font-medium text-ink-800 truncate">
                                            {l.notes?.trim() ? l.notes : (l.type === 'given' ? t('loan_receivable') : t('loan_payable'))}
                                          </p>
                                          <p className="text-[9.5px] text-ink-500 mt-0.5">
                                            {new Date(l.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                                          </p>
                                        </div>
                                        <div className="text-right shrink-0">
                                          <p className={`text-[12px] font-bold tabular-nums ${line.applied > 0 ? 'text-receive-text' : 'text-ink-400'}`}>
                                            {line.applied > 0 ? formatMoney(line.applied, group.currency) : '—'}
                                          </p>
                                          {line.cleared ? (
                                            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-receive-text">{t('alloc_cleared')}</p>
                                          ) : line.applied > 0 ? (
                                            <p className="text-[9px] text-ink-500 tabular-nums">
                                              {t('loan_remaining')}: {formatMoney(line.after, group.currency)}
                                            </p>
                                          ) : null}
                                        </div>
                                      </div>
                                    );
                                  });
                                })()}
                              </div>
                            )}
                            <button type="button"
                              onClick={() => setExpandedGroupKey((k) => (k === group.key ? '' : group.key))}
                              className="flex items-center gap-1 px-0.5 py-1 text-[11px] font-semibold text-accent-600 active:opacity-70"
                            >
                              <ChevronDown size={13} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                              {t('qe_group_pick_specific')}
                            </button>
                            {expanded && <div className="space-y-2">{group.loans.map(loanRow)}</div>}
                          </div>
                        );
                      })
                    )}
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
            {needsLoan && !selectedLoanIsLinked && repayDirectionType === 'given' && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_money_where')}</label>
                <AccountSelect
                  accounts={accounts}
                  selectedId={destId}
                  preferredCurrency={repayCurrency}
                  onSelect={(id) => { setDestId(id); setConversionRate(''); }}
                />
              </div>
            )}
            {needsLoan && !selectedLoanIsLinked && repayDirectionType === 'taken' && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_pay_from')}</label>
                <AccountSelect
                  accounts={accounts}
                  selectedId={sourceId}
                  preferredCurrency={repayCurrency}
                  onSelect={(id) => { setSourceId(id); setConversionRate(''); }}
                  renderRight={(a) => (
                    <>
                      <p className="text-[13px] font-semibold text-ink-900 tabular-nums">{formatSignedMoney(a.balance, a.currency)}</p>
                      {renderAfterBalance(a)}
                    </>
                  )}
                />
              </div>
            )}

            {needsGoal && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_which_goal')}</label>
                <div className="space-y-2">
                  {goals.map(g => {
                    const pct = g.targetAmount > 0 ? Math.min(100, Math.round((g.savedAmount / g.targetAmount) * 100)) : 0;
                    return (
                      <button key={g.id} type="button"
                        onClick={() => {
                          if (g.id !== goalId) setConversionRate('');
                          setGoalId(g.id);
                        }}
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
                <CategoryPicker
                  type={type === 'income' ? 'income' : 'expense'}
                  value={category}
                  onChange={setCategory}
                />
              </div>
            )}

            {!isGroupExpense && (
              <div>
                <label className="block text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('quick_note')}</label>
                <input value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('quick_note_placeholder')} className={inputClass} />
              </div>
            )}

            {/* Cash advances DO move money (card debited, cash credited), so
                the "money not moved" ledger notice would be misleading there. */}
            {(needsPerson || needsLoan) && !cashAdvance && (
              <p className="text-[12px] text-ink-600 bg-cream-card border border-cream-border rounded-2xl p-3 leading-relaxed">
                {t('money_not_moved_notice')}
              </p>
            )}

            {/* Glanceable confirm/private chip near Save — tells the user
                whether this loan will mirror to a linked contact (who must
                confirm) or stay a private local-only record. Not relevant to
                a cash advance (no counterparty to mirror to). */}
            {(type === 'loan_given' || type === 'loan_taken') && !cashAdvance && (() => {
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
