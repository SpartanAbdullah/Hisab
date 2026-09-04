import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { Inbox, Send, AlertTriangle, Repeat, CreditCard, CalendarClock, ChevronRight, UserPlus, BellRing, HandCoins, Tag, Users, ListChecks, CheckCircle2, WalletMinimal } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { NavyHero, TopBar } from '../components/NavyHero';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useSettlementRequestStore } from '../stores/settlementRequestStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useAppModeStore } from '../stores/appModeStore';
import { usePersonStore } from '../stores/personStore';
import { useBudgetStore } from '../stores/budgetStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useRecurringStore } from '../stores/recurringStore';
import { useAccountStore } from '../stores/accountStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useContactLinkStore } from '../stores/contactLinkStore';
import { useLoanStore } from '../stores/loanStore';
import { useEmiStore } from '../stores/emiStore';
import { useCommitteeStore } from '../stores/committeeStore';
import { useBlockStore } from '../stores/blockStore';
import { BlockReportSheet, type BlockReportMode } from '../components/BlockReportSheet';
import { hideBlockedSenders } from '../lib/blockStatus';
import { buildInboxActionItems, buildInboxInfoItems, isInboxInfoNotification, type ActionContent, type ActionItem, type InfoItem, type InfoIcon as InfoIconKind } from '../lib/inboxInfo';
import { notificationHref, renderNotificationContent } from '../lib/notificationContent';
import type { RecurringDueDetail } from '../lib/recurringRunner';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import { useToast } from '../components/Toast';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { AcceptIntoAccountSheet, type AcceptIntoAccountRequest } from '../components/AcceptIntoAccountSheet';
import { formatMoney } from '../lib/constants';
import { approxOther, plausibilityCheck } from '../lib/currencyValidation';
import { friendlyLinkedError } from '../lib/linkedErrorMap';
import { useCategoryOptions } from '../lib/mergedCategories';
import { useT, type I18nKey } from '../lib/i18n';
import { daysWaiting } from '../lib/notificationCounts';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { EmptyState } from '../components/EmptyState';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import type { LinkedRequest, SettlementRequest, Transaction } from '../db';

type Tab = 'incoming' | 'outgoing' | 'info' | 'action';

type InboxItem =
  | { kind: 'linked'; item: LinkedRequest }
  | { kind: 'settlement'; item: SettlementRequest };

export function InboxPage() {
  const user = useSupabaseAuthStore((s) => s.user);
  const { requests, loadRequests, accept, reject, cancel } = useLinkedRequestStore();
  const settlements = useSettlementRequestStore((s) => s.requests);
  const loadSettlements = useSettlementRequestStore((s) => s.loadRequests);
  const acceptSettlement = useSettlementRequestStore((s) => s.accept);
  const rejectSettlement = useSettlementRequestStore((s) => s.reject);
  const cancelSettlement = useSettlementRequestStore((s) => s.cancel);
  const persons = usePersonStore((s) => s.persons);
  // Persons must be warm here: phone numbers power the outgoing-request
  // "Remind" WhatsApp deep link (same reason LoansPage loads them).
  const loadPersons = usePersonStore((s) => s.loadPersons);
  const budgets = useBudgetStore((s) => s.budgets);
  const loadBudgets = useBudgetStore((s) => s.loadBudgets);
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  const templates = useRecurringStore((s) => s.templates);
  const loadTemplates = useRecurringStore((s) => s.loadTemplates);
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const upcoming = useUpcomingExpenseStore((s) => s.expenses);
  const loadExpenses = useUpcomingExpenseStore((s) => s.loadExpenses);
  const notifications = useNotificationStore((s) => s.notifications);
  const loadNotifications = useNotificationStore((s) => s.loadNotifications);
  const markNotificationRead = useNotificationStore((s) => s.markRead);
  const contactLinks = useContactLinkStore((s) => s.requests);
  const loadContactLinks = useContactLinkStore((s) => s.loadRequests);
  const respondContactLink = useContactLinkStore((s) => s.respond);
  // "To-do" tab sources — raw slices only, filtering in useMemo (React #185).
  const loans = useLoanStore((s) => s.loans);
  const emiSchedules = useEmiStore((s) => s.schedules);
  const committees = useCommitteeStore((s) => s.committees);
  const committeePayments = useCommitteeStore((s) => s.payments);
  // My block list (audit M17). Subscribed raw so the inbox re-filters in the
  // same frame a block lands, and un-filters the moment it is undone.
  const blocks = useBlockStore((s) => s.blocks);
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const t = useT();
  // Account plumbing on settlement cards is a Full Money Tracker concern —
  // simple mode has no account model the user thinks in.
  const appMode = useAppModeStore((s) => s.mode);

  // An explicit destination (Home's "N kaam pending" row navigates with
  // state.tab) beats the smart-landing heuristic — the user was promised a
  // specific queue and must land on it.
  const tabHint = (location.state as { tab?: Tab } | null)?.tab;
  const [tab, setTab] = useState<Tab>(tabHint ?? 'incoming');
  const [busyId, setBusyId] = useState<string | null>(null);
  // Uncategorised-expense actions resolve in place via the edit sheet.
  const [selectedTxn, setSelectedTxn] = useState<Transaction | null>(null);
  // Full-tracker accepts route through the account sheet (irreversibility
  // confirm folded in). Simple mode and past-record syncs keep the plain
  // confirmDestructive path — there is no account question to ask there.
  const [acceptSheet, setAcceptSheet] = useState<
    { kind: 'linked' | 'settlement'; id: string; req: AcceptIntoAccountRequest } | null
  >(null);
  // One guard per cross-user money action — a ref, so two taps landing in the
  // same frame can't both pass. `busyId` stays purely for the disabled/label
  // UI (React state updates are async, so it alone can't stop a double-accept
  // or double-settle from mirroring twice onto the other person's ledger).
  const acceptGuard = useSubmitGuard();
  const acceptSettlementGuard = useSubmitGuard();
  const rejectGuard = useSubmitGuard();
  const cancelGuard = useSubmitGuard();
  const rejectSettlementGuard = useSubmitGuard();
  const cancelSettlementGuard = useSubmitGuard();
  // Block / report target for the sheet. `contextId` is the inbox row the
  // action was raised from, so the operator's Studio query can find it.
  const [safety, setSafety] = useState<
    { mode: BlockReportMode; userId: string; name: string; contextId: string } | null
  >(null);

  const load = useCallback(async () => {
    await Promise.all([
      loadRequests(), loadSettlements(), loadPersons(),
      // Info-tab sources (cheap; most are already warm from app boot).
      loadBudgets(), loadTransactions(), loadTemplates(), loadAccounts(), loadExpenses(), loadNotifications(),
      loadContactLinks().catch(() => {}),
      // "To-do" tab sources (same story — warm from boot / Home).
      useLoanStore.getState().loadLoans(),
      useEmiStore.getState().loadSchedules(),
      useCommitteeStore.getState().loadAll(),
      // Block list — without it the inbox would briefly show cards from people
      // the user has already blocked. Never fatal: loadBlocks swallows and
      // reports its own failure, leaving the previous list in place.
      useBlockStore.getState().loadBlocks(),
    ]);
  }, [loadRequests, loadSettlements, loadPersons, loadBudgets, loadTransactions, loadTemplates, loadAccounts, loadExpenses, loadNotifications, loadContactLinks]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  useEffect(() => {
    const onFocus = () => { void loadRequests(); void loadSettlements(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadRequests, loadSettlements]);

  const myId = user?.id ?? '';

  const blockedIds = useMemo(() => new Set(blocks.map((b) => b.blockedId)), [blocks]);

  // The server already refuses NEW requests from a blocked pair, but a block is
  // not a deletion (docs/trust-and-safety.md RULE 3) — anything that arrived
  // BEFORE the block is still in the table and would sit in the inbox forever.
  // So hide it here, at the render site: purely cosmetic, and unblocking brings
  // every row straight back.
  //
  // INCOMING ONLY. Outgoing items are the user's own asks; hiding those would
  // make a request they sent look like it silently vanished.
  const anyIncomingHidden = useMemo(
    () =>
      blockedIds.size > 0 &&
      (requests.some((r) => r.toUserId === myId && blockedIds.has(r.fromUserId)) ||
        settlements.some((r) => r.toUserId === myId && blockedIds.has(r.fromUserId))),
    [requests, settlements, blockedIds, myId],
  );

  const visible: InboxItem[] = useMemo(() => {
    const incomingOnly = <T extends { fromUserId: string; toUserId: string }>(rows: T[]) =>
      tab === 'incoming' ? hideBlockedSenders(rows, blockedIds, (r) => r.fromUserId) : rows;
    const linkedItems: InboxItem[] = incomingOnly(requests)
      .filter((r) => (tab === 'incoming' ? r.toUserId === myId : r.fromUserId === myId))
      .map((r) => ({ kind: 'linked' as const, item: r }));
    const settlementItems: InboxItem[] = incomingOnly(settlements)
      .filter((r) => (tab === 'incoming' ? r.toUserId === myId : r.fromUserId === myId))
      .map((r) => ({ kind: 'settlement' as const, item: r }));
    // Pending (not-yet-acted) requests pin to the top so an older request
    // never gets buried under newer, already-resolved ones. Within each
    // group, newest-first. Acting on a card flips its status off 'pending',
    // so it drops below the pending block on the very next render.
    return [...linkedItems, ...settlementItems].sort((a, b) => {
      const ap = a.item.status === 'pending' ? 0 : 1;
      const bp = b.item.status === 'pending' ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return b.item.createdAt.localeCompare(a.item.createdAt);
    });
  }, [requests, settlements, tab, myId, blockedIds]);

  // Where the pinned pending block ends — drives the "Earlier" divider so the
  // acted-upon history reads as a visually separate section below.
  const pendingVisibleCount = useMemo(
    () => visible.filter((e) => e.item.status === 'pending').length,
    [visible],
  );

  // "X added you — add them back?" asks. These live on Incoming because they
  // are a DECISION, not an FYI: nothing is written into this user's contacts
  // until they answer, and leaving it unanswered is a valid outcome.
  const contactAsks = useMemo(
    () =>
      hideBlockedSenders(
        contactLinks.filter((r) => r.toUserId === myId && r.status === 'pending'),
        blockedIds,
        (r) => r.fromUserId,
      ).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [contactLinks, myId, blockedIds],
  );

  // Badge counts follow the same filter, or the tab would advertise work that
  // has been hidden and can never be cleared.
  const incomingPendingCount = useMemo(
    () =>
      requests.filter((r) => r.status === 'pending' && r.toUserId === myId && !blockedIds.has(r.fromUserId)).length +
      settlements.filter((r) => r.status === 'pending' && r.toUserId === myId && !blockedIds.has(r.fromUserId)).length +
      contactAsks.length,
    [requests, settlements, myId, contactAsks, blockedIds],
  );
  const outgoingPendingCount = useMemo(
    () =>
      requests.filter((r) => r.status === 'pending' && r.fromUserId === myId).length +
      settlements.filter((r) => r.status === 'pending' && r.fromUserId === myId).length,
    [requests, settlements, myId],
  );

  const infoItems = useMemo(
    () => buildInboxInfoItems({ budgets, transactions, templates, accounts, upcoming, today: new Date() }),
    [budgets, transactions, templates, accounts, upcoming],
  );
  // Unread informational notifications (e.g. "someone added you via your code")
  // sit at the top of the Info tab, newest first.
  const infoNotifs = useMemo(
    () => notifications.filter(isInboxInfoNotification).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [notifications],
  );
  // The Info badge counts only clearable unread notifications. The live
  // derived signals below (budget / credit-card / subscription) are
  // informational content — they must NOT drive a red count the user can
  // never clear (that was the "stays at 1 after reading" bug).
  const infoCount = infoNotifs.length;

  // "To-do" tab: every item clears itself when the user does the thing, so
  // (unlike Info) a derived count IS legitimate here — it can reach zero.
  const cardFundedLoanIds = useMemo(() => {
    const map = new Map<string, string>();
    for (const txn of transactions) {
      if (txn.type === 'loan_taken' && txn.relatedLoanId && txn.sourceAccountId) {
        map.set(txn.relatedLoanId, txn.sourceAccountId);
      }
    }
    return map;
  }, [transactions]);
  // Live category names gate the one-tap suggestion: never offer to file
  // under a category the user has deleted.
  const expenseCategories = useCategoryOptions('expense');
  const actionItems = useMemo(
    () =>
      buildInboxActionItems({
        loans,
        schedules: emiSchedules,
        transactions,
        templates,
        committees,
        committeePayments,
        accounts,
        cardFundedLoanIds,
        expenseCategories,
        today: new Date(),
      }),
    [loans, emiSchedules, transactions, templates, committees, committeePayments, accounts, cardFundedLoanIds, expenseCategories],
  );
  const actionCount = actionItems.length;

  // One-tap file-under-suggestion: the user's own history proposed the
  // category; accepting is a metadata-only patch with an Undo, and the
  // card self-clears because the txn drops out of the unfiled filter.
  const acceptSuggestion = async (item: ActionItem) => {
    if (item.content.kind !== 'uncategorized' || !item.content.suggestedCategory) return;
    if (item.resolve.kind !== 'editTxn') return;
    const { txnId } = item.resolve;
    const category = item.content.suggestedCategory;
    try {
      await useTransactionStore.getState().setCategory(txnId, category);
      toast.show({
        type: 'success',
        title: t('todo_uncat_filed').replace('{category}', category),
        action: {
          label: t('undo'),
          onPress: () => {
            void useTransactionStore.getState().setCategory(txnId, '').catch(() => {});
          },
        },
      });
    } catch (err) {
      toast.show({
        type: 'error',
        title: t('error'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    }
  };

  // One-tap resolve: navigate to the owning page, open the edit sheet, or
  // re-fire the globally-mounted recurring prompt (idempotent via its
  // expansionKey stamp), depending on what the item needs.
  const resolveAction = (item: ActionItem) => {
    const r = item.resolve;
    if (r.kind === 'navigate') {
      navigate(r.href);
    } else if (r.kind === 'editTxn') {
      const txn = transactions.find((x) => x.id === r.txnId);
      if (txn) setSelectedTxn(txn);
    } else {
      const tpl = templates.find((x) => x.id === r.templateId);
      if (tpl) {
        window.dispatchEvent(
          new CustomEvent<RecurringDueDetail>('hisaab:recurring-due', {
            detail: { templates: [tpl], todayIso: new Date().toISOString().slice(0, 10) },
          }),
        );
      }
    }
  };

  // Answer a connection ask. Accepting writes the reciprocal contact
  // server-side (and refetches persons); declining writes nothing at all.
  const handleContactAsk = async (id: string, accept: boolean, name: string) => {
    setBusyId(id);
    try {
      const ok = await respondContactLink(id, accept);
      if (!ok) {
        toast.show({ type: 'error', title: t('clink_err') });
        return;
      }
      toast.show(
        accept
          ? { type: 'success', title: t('clink_added_toast').replace('{name}', name) }
          : { type: 'info', title: t('clink_declined_toast') },
      );
    } catch (err) {
      console.error('respondContactLink failed', err);
      toast.show({ type: 'error', title: t('clink_err'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };

  // Smart landing: once data is loaded, jump to whichever tab has the most
  // active items. Tie-break order Incoming > To-do > Info > Outgoing (cross-
  // user approvals first, then things waiting on the user). Runs once via a
  // ref so a later store refresh — or the user's own tab tap — is never
  // overridden. An explicit tab hint from the caller disables it entirely.
  const didAutoSelect = useRef(!!tabHint);
  useEffect(() => {
    if (didAutoSelect.current || loadStatus !== 'ready') return;
    didAutoSelect.current = true;
    const counts: Record<Tab, number> = {
      incoming: incomingPendingCount,
      action: actionCount,
      info: infoCount,
      outgoing: outgoingPendingCount,
    };
    let best: Tab = 'incoming';
    for (const candidate of ['incoming', 'action', 'info', 'outgoing'] as Tab[]) {
      if (counts[candidate] > counts[best]) best = candidate;
    }
    if (counts[best] > 0) setTab(best);
  }, [loadStatus, incomingPendingCount, actionCount, infoCount, outgoingPendingCount]);

  // Phase H4: surface the actual error in each catch instead of swallowing
  // it. Previously every failure showed the same generic toast title, which
  // made it impossible to tell whether the issue was missing RPCs, RLS,
  // stale state, network, or auth. Now the catch logs to console.error AND
  // includes the message as the toast subtitle, so users can read it and
  // we can see it in DevTools / Sentry.
  const errorSubtitle = (err: unknown): string => {
    if (err instanceof Error) return friendlyLinkedError(err.message);
    if (typeof err === 'string') return friendlyLinkedError(err);
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unknown error';
    }
  };

  // The actual accept call, shared by the plain-confirm path (accountId
  // null) and the account sheet. Returns success so the sheet knows whether
  // to close or stay open for a retry. Guarded: a dropped double-tap
  // resolves to undefined, which both callers treat as "not ok" (stay open /
  // no-op) — exactly the safe outcome for a suppressed duplicate.
  const performAccept = (id: string, accountId: string | null): Promise<boolean | undefined> =>
    acceptGuard.run(() => runAccept(id, accountId));

  const runAccept = async (id: string, accountId: string | null): Promise<boolean> => {
    const req = requests.find((r) => r.id === id);
    setBusyId(id);
    try {
      await accept(id, accountId);
      toast.show({
        type: 'success',
        title: t('inbox_accepted_title'),
        subtitle: req ? t('inbox_accepted_sub').replace('{amount}', formatMoney(req.amount, req.currency)) : undefined,
      });
      return true;
    } catch (err) {
      console.error('[inbox] accept failed', err);
      toast.show({ type: 'error', title: t('ltr_accept_error'), subtitle: errorSubtitle(err) });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const handleAccept = async (id: string) => {
    // Tier-2: cross-user, irreversible, currency-locks on accept → deliberate confirm.
    const req = requests.find((r) => r.id === id);
    if (req) {
      // Defense-in-depth: refuse an implausible amount before it mirrors onto
      // your ledger, even if it slipped past the sender's guard.
      const plaus = plausibilityCheck(req.amount, req.currency);
      if (!plaus.passed && plaus.severity === 'block') {
        toast.show({ type: 'error', title: t('inbox_amount_off_title'), subtitle: t('inbox_amount_off_sub').replace('{reason}', plaus.reason ?? '') });
        return;
      }
      // Full tracker: the account sheet carries the confirmation. Past-record
      // syncs stay ledger-only by design (the money moved before linking), so
      // they keep the plain confirm below.
      if (appMode === 'full_tracker' && !req.preExistingLoanId) {
        setAcceptSheet({
          kind: 'linked',
          id,
          req: {
            amount: req.amount,
            currency: req.currency,
            contactName: contactNameFor(req),
            // They lent me money → it landed with me; they borrowed → it left me.
            direction: req.kind === 'lent' ? 'in' : 'out',
            flavor: 'loan',
          },
        });
        return;
      }
      const approx = approxOther(req.amount, req.currency);
      const warnNote = !plaus.passed && plaus.reason ? ` ${plaus.reason}` : '';
      const ok = await confirmDestructive({
        title: t('confirm_accept_title').replace('{amount}', formatMoney(req.amount, req.currency)),
        description:
          t('confirm_accept_body').replace('{approx}', approx ? `${approx}. ` : '') + warnNote,
        confirmLabel: t('ltr_accept'),
        cancelLabel: t('not_now'),
        tone: 'warning',
      });
      if (!ok) return;
    }
    await performAccept(id, null);
  };
  const handleReject = (id: string) => rejectGuard.run(() => runReject(id));

  const runReject = async (id: string) => {
    const ok = await confirmDestructive({
      title: t('inbox_reject_confirm_title'),
      description: t('inbox_reject_confirm_body'),
      confirmLabel: t('inbox_reject_confirm_cta'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await reject(id);
    } catch (err) {
      console.error('[inbox] reject failed', err);
      toast.show({ type: 'error', title: t('ltr_reject_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };
  const handleCancel = (id: string) => cancelGuard.run(() => runCancel(id));

  const runCancel = async (id: string) => {
    const ok = await confirmDestructive({
      title: t('inbox_cancel_confirm_title'),
      description: t('inbox_cancel_confirm_body'),
      confirmLabel: t('inbox_cancel_confirm_cta'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await cancel(id);
    } catch (err) {
      console.error('[inbox] cancel failed', err);
      toast.show({ type: 'error', title: t('ltr_cancel_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };

  // Guarded like performAccept: a dropped double-tap resolves to undefined,
  // which both callers (the plain-confirm path and the account sheet) treat
  // as "not ok" — the safe outcome for a suppressed duplicate.
  const performAcceptSettlement = (id: string, accountId: string | null): Promise<boolean | undefined> =>
    acceptSettlementGuard.run(() => runAcceptSettlement(id, accountId));

  const runAcceptSettlement = async (id: string, accountId: string | null): Promise<boolean> => {
    const req = settlements.find((r) => r.id === id);
    setBusyId(id);
    try {
      await acceptSettlement(id, accountId);
      toast.show({
        type: 'success',
        title: t('inbox_settled_title'),
        subtitle: req ? t('inbox_settled_sub').replace('{amount}', formatMoney(req.amount, req.currency)) : undefined,
      });
      return true;
    } catch (err) {
      console.error('[inbox] accept settlement failed', err);
      toast.show({ type: 'error', title: t('stl_accept_error'), subtitle: errorSubtitle(err) });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const handleAcceptSettlement = async (id: string) => {
    const req = settlements.find((r) => r.id === id);
    if (req && appMode === 'full_tracker') {
      // My side of the pair says which way the money moved for me: my loan
      // 'given' → I'm the creditor being repaid (money in); 'taken' → I'm
      // the debtor whose payment is being recorded (money out).
      const myLoan = loans.find((l) => l.id === req.responderLoanId);
      setAcceptSheet({
        kind: 'settlement',
        id,
        req: {
          amount: req.amount,
          currency: req.currency,
          contactName: contactNameForSettlement(req),
          direction: myLoan ? (myLoan.type === 'given' ? 'in' : 'out') : 'unknown',
          flavor: 'settlement',
        },
      });
      return;
    }
    if (req) {
      const ok = await confirmDestructive({
        title: t('confirm_settle_title').replace('{amount}', formatMoney(req.amount, req.currency)),
        description: t('confirm_settle_body'),
        confirmLabel: t('confirm_settle_cta'),
        cancelLabel: t('not_now'),
        tone: 'warning',
      });
      if (!ok) return;
    }
    await performAcceptSettlement(id, null);
  };
  const handleRejectSettlement = (id: string) => rejectSettlementGuard.run(() => runRejectSettlement(id));

  const runRejectSettlement = async (id: string) => {
    const ok = await confirmDestructive({
      title: t('inbox_reject_confirm_title'),
      description: t('inbox_reject_confirm_body'),
      confirmLabel: t('inbox_reject_confirm_cta'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await rejectSettlement(id);
    } catch (err) {
      console.error('[inbox] reject settlement failed', err);
      toast.show({ type: 'error', title: t('stl_reject_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };
  const handleCancelSettlement = (id: string) => cancelSettlementGuard.run(() => runCancelSettlement(id));

  const runCancelSettlement = async (id: string) => {
    const ok = await confirmDestructive({
      title: t('inbox_cancel_confirm_title'),
      description: t('inbox_cancel_confirm_body'),
      confirmLabel: t('inbox_cancel_confirm_cta'),
      cancelLabel: t('not_now'),
      tone: 'warning',
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await cancelSettlement(id);
    } catch (err) {
      console.error('[inbox] cancel settlement failed', err);
      toast.show({ type: 'error', title: t('stl_cancel_error'), subtitle: errorSubtitle(err) });
    } finally {
      setBusyId(null);
    }
  };

  function contactNameForSettlement(r: SettlementRequest): string {
    if (r.fromUserId === myId) {
      const p = persons.find((x) => x.linkedProfileId === r.toUserId);
      if (p) return p.name;
    }
    if (r.toUserId === myId) {
      const p = persons.find((x) => x.linkedProfileId === r.fromUserId);
      if (p) return p.name;
    }
    return t('ltr_unknown_person');
  }

  function contactNameFor(r: LinkedRequest): string {
    // Outgoing: the sender knows the contact by their local persons.name.
    // Incoming: the receiver may not have a contact row for the sender yet
    // (the accept RPC auto-creates one on confirm). Fall back to "Hisaab user".
    if (r.fromUserId === myId && r.personId) {
      const p = persons.find((x) => x.id === r.personId);
      if (p) return p.name;
    }
    if (r.toUserId === myId) {
      const p = persons.find((x) => x.linkedProfileId === r.fromUserId);
      if (p) return p.name;
    }
    return t('ltr_unknown_person');
  }

  // Which-account line for a settlement card, resolved for MY side only
  // (the other user's account id can't be resolved here and is irrelevant).
  // Full tracker only; direction comes from my loan in the pair.
  function settlementAccountLine(r: SettlementRequest): string | null {
    if (appMode !== 'full_tracker') return null;
    const mine = r.fromUserId === myId;
    const myAccountId = mine ? r.requesterAccountId : r.responderAccountId;
    if (myAccountId) {
      const name = accounts.find((a) => a.id === myAccountId)?.name;
      if (!name) return null;
      const myLoan = loans.find((l) => l.id === (mine ? r.requesterLoanId : r.responderLoanId));
      if (!myLoan) return t('stl_account_neutral').replace('{account}', name);
      // My loan 'taken' → I'm the debtor, money left me; 'given' → it landed.
      return (myLoan.type === 'taken' ? t('stl_from_account') : t('stl_into_account')).replace('{account}', name);
    }
    // My side stayed ledger-only. Say so once the card matters (pending
    // outgoing / any accepted) — rejected & cancelled history stays quiet.
    if (mine) return r.status === 'pending' || r.status === 'accepted' ? t('stl_outgoing_no_account') : null;
    return r.status === 'accepted' ? t('stl_incoming_no_account') : null;
  }

  // Same for linked LOAN cards. Direction from the request kind and which
  // side of it I'm on: sender+lent / receiver+borrowed = money left me.
  function linkedAccountLine(r: LinkedRequest): string | null {
    if (appMode !== 'full_tracker') return null;
    const mine = r.fromUserId === myId;
    const myAccountId = mine ? r.requesterAccountId : r.responderAccountId;
    if (myAccountId) {
      const name = accounts.find((a) => a.id === myAccountId)?.name;
      if (!name) return null;
      const moneyOut = mine ? r.kind === 'lent' : r.kind === 'borrowed';
      return (moneyOut ? t('req_from_account') : t('req_into_account')).replace('{account}', name);
    }
    // Accepted with no account on my side (incl. past-record syncs, where
    // ledger-only is by design): state it, so nobody assumes a balance moved.
    return r.status === 'accepted' ? t('req_no_account_note') : null;
  }

  // One-tap WhatsApp nudge for an outgoing request stuck on the other side.
  // Known phone → opens their chat; unknown → WhatsApp's own contact picker
  // (buildWhatsAppUrl degrades gracefully), so the button always works.
  function remindUrlFor(entry: InboxItem): string {
    const isLinked = entry.kind === 'linked';
    const name = isLinked
      ? contactNameFor(entry.item as LinkedRequest)
      : contactNameForSettlement(entry.item as SettlementRequest);
    const phone = (() => {
      if (isLinked) {
        const r = entry.item as LinkedRequest;
        const byPersonId = r.personId ? persons.find((x) => x.id === r.personId) : undefined;
        return byPersonId?.phone ?? persons.find((x) => x.linkedProfileId === r.toUserId)?.phone ?? null;
      }
      return persons.find((x) => x.linkedProfileId === entry.item.toUserId)?.phone ?? null;
    })();
    const template = !isLinked
      ? t('req_remind_settlement')
      : (entry.item as LinkedRequest).kind === 'lent'
        ? t('req_remind_linked_lent')
        : t('req_remind_linked_borrowed');
    const message = template
      .replaceAll('{name}', name)
      .replaceAll('{amount}', formatMoney(entry.item.amount, entry.item.currency));
    return buildWhatsAppUrl(phone, message);
  }

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <NavyHero>
        <TopBar
          title={t('ltr_inbox_title')}
          back
          // Hide the inbox bell from the top-right — we're already on the
          // inbox page, the icon would be redundant + confusing.
          showInbox={false}
          action={
            <PillToggle
              tab={tab}
              setTab={setTab}
              incomingCount={incomingPendingCount}
              outgoingCount={outgoingPendingCount}
              infoCount={infoCount}
              actionCount={actionCount}
              incomingLabel={t('ltr_tab_incoming')}
              outgoingLabel={t('ltr_tab_outgoing')}
              infoLabel={t('ltr_tab_info')}
              actionLabel={t('ltr_tab_action')}
            />
          }
        />
        <div className="px-5 pb-7">
          <p className="text-white text-[16px] font-medium leading-snug max-w-[300px]">
            {tab === 'incoming' ? t('ltr_incoming_hint') : tab === 'outgoing' ? t('ltr_outgoing_hint') : tab === 'action' ? t('ltr_action_hint') : t('ltr_info_hint')}
          </p>
        </div>
      </NavyHero>

      <div className="sukoon-body min-h-[60dvh] px-5 pt-5 space-y-3">
        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title={t('inbox_err_load')}
            message={loadError ?? t('err_some_data_failed')}
            onRetry={retryLoad}
          />
        )}

        {/* Connection asks pin above the request list. Someone used this
            user's code; nothing has been written to their contacts and
            nothing will be until they answer. */}
        {tab === 'incoming' &&
          contactAsks.map((ask) => (
            <ContactAskCard
              key={ask.id}
              name={ask.fromName}
              busy={busyId === ask.id}
              onAdd={() => void handleContactAsk(ask.id, true, ask.fromName)}
              onSkip={() => void handleContactAsk(ask.id, false, ask.fromName)}
              onReport={() => setSafety({ mode: 'report', userId: ask.fromUserId, name: ask.fromName, contextId: ask.id })}
              onBlock={() => setSafety({ mode: 'block', userId: ask.fromUserId, name: ask.fromName, contextId: ask.id })}
            />
          ))}

        {/* Say that something is hidden rather than letting a blocked sender's
            request appear to have vanished into thin air. */}
        {tab === 'incoming' && anyIncomingHidden && (
          <p className="text-[10.5px] text-ink-400 px-1 leading-relaxed">{t('blk_hidden_note')}</p>
        )}

        {tab === 'action' ? (
          loadStatus === 'loading' && actionItems.length === 0 ? (
            <ListSkeleton rows={3} withAvatar={false} />
          ) : actionItems.length === 0 ? (
            loadStatus === 'ready' ? (
              <EmptyState
                icon={ListChecks}
                tone="receive"
                title={t('inbox_empty_action_title')}
                description={t('inbox_empty_action_desc')}
                // A cleared queue is a dead end — hand the user a way out
                // instead of leaving them staring at an empty list.
                actionLabel={t('inbox_empty_action_cta')}
                onAction={() => navigate('/')}
              />
            ) : null
          ) : (
            // Reveals in reading order so a queue of five to-dos lands as a
            // list being handed to you, not five things appearing at once.
            <div className="space-y-2.5 stagger-in">
              {actionItems.map((it) => (
                <ActionCard
                  key={it.id}
                  item={it}
                  onResolve={() => resolveAction(it)}
                  onAccept={() => void acceptSuggestion(it)}
                />
              ))}
            </div>
          )
        ) : tab === 'info' ? (
          loadStatus === 'loading' && infoItems.length === 0 && infoNotifs.length === 0 ? (
            <ListSkeleton rows={3} withAvatar={false} />
          ) : infoItems.length === 0 && infoNotifs.length === 0 ? (
            loadStatus === 'ready' ? (
              <EmptyState
                icon={Inbox}
                tone="receive"
                title={t('inbox_empty_info_title')}
                description={t('inbox_empty_info_desc')}
              />
            ) : null
          ) : (
            <div className="space-y-2.5 stagger-in">
              {infoNotifs.map((n) => {
                // Server rows carry template+params; render them in the
                // reader's language and fall back to the stored text for
                // legacy rows (audit N-1 / H5 — clients no longer author it).
                const content = renderNotificationContent(n, t);
                // Group + kameti rows land here too now (they are unread
                // notifications with no request row of their own, and the bell
                // counts them — so this tab has to be able to show them).
                // A "person added you" glyph on a group expense would misread,
                // so the icon follows the row's own kind.
                const RowIcon = n.type === 'contact_linked' ? UserPlus : Users;
                return (
                  <button
                    key={n.id}
                    type="button"
                    // A group INVITE row is actionable, not just informational:
                    // Accept/Decline lives on the Groups tab, and the invitee
                    // cannot open /group/:id at all (RLS hides a group they
                    // have not joined). notificationHref already routes 'invite'
                    // to /groups — tapping now follows it instead of only
                    // marking the row read and going nowhere.
                    onClick={() => {
                      void markNotificationRead(n.id);
                      const href = notificationHref(n);
                      if (href !== '/inbox') navigate(href);
                    }}
                    className="w-full text-left rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3 press-lg"
                  >
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-accent-50">
                      <RowIcon size={17} className="text-accent-600" strokeWidth={2} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-ink-900 tracking-tight truncate">
                        {content.title || (n.type === 'contact_linked' ? t('ntf_new_connection') : t('ntf_update'))}
                      </p>
                      <p className="text-[11.5px] text-ink-500 mt-0.5 line-clamp-2">{content.body}</p>
                    </div>
                    <span className="w-2 h-2 rounded-full bg-accent-500 shrink-0" aria-hidden />
                  </button>
                );
              })}
              {infoItems.map((it) => (
                <InfoCard key={it.id} item={it} onOpen={() => it.href && navigate(it.href)} />
              ))}
            </div>
          )
        ) : loadStatus === 'loading' && visible.length === 0 ? (
          <ListSkeleton rows={3} withAvatar={false} />
        ) : visible.length === 0 &&
          // An ask sitting right above is something to do — don't contradict
          // it with "nothing needs your attention".
          !(tab === 'incoming' && contactAsks.length > 0) ? (
          loadStatus === 'ready' ? (
            tab === 'incoming' ? (
              <EmptyState
                icon={Inbox}
                tone="accent"
                title={t('inbox_empty_incoming_title')}
                description={t('inbox_empty_incoming_desc')}
                // One-line explainer so an empty incoming tab reads as
                // "nothing to do" rather than "is this broken?".
                subhint={t('inbox_incoming_explainer')}
              />
            ) : (
              <EmptyState
                icon={Send}
                tone="receive"
                title={t('inbox_empty_outgoing_title')}
                description={t('inbox_empty_outgoing_desc')}
                // Outgoing-empty nudges toward the place linked requests are
                // created: a linked contact's detail sheet.
                actionLabel={t('inbox_send_request')}
                onAction={() => navigate('/contacts')}
              />
            )
          ) : null
        ) : (
          // Keyed on `tab`: switching Incoming <-> Outgoing swaps the whole
          // list, so replaying the reveal is the honest signal that the
          // content changed rather than merely re-sorted.
          <div className="space-y-2.5 stagger-in" key={tab}>
            {/* "Waiting on others (N)" — the outgoing asks that the bell now
                marks with a quiet dot instead of a red number (audit N-7 kept:
                no alarm), given a named home so the user can see who is slow
                and nudge them. Header only; the cards below carry who/what and
                the age line. */}
            {tab === 'outgoing' && pendingVisibleCount > 0 && (
              <div className="flex items-center gap-2 pb-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                  {t('inbox_waiting_on_others').replace('{n}', String(pendingVisibleCount))}
                </span>
                <span className="flex-1 h-px bg-cream-hairline" />
              </div>
            )}
            {visible.map((entry, idx) => {
              // Divider sits at the boundary between the pinned pending block
              // and the resolved history — shown only when both groups exist.
              const showDivider =
                pendingVisibleCount > 0 &&
                pendingVisibleCount < visible.length &&
                idx === pendingVisibleCount;
              const card =
                entry.kind === 'linked' ? (
                  <RequestCard
                    request={entry.item}
                    tab={tab}
                    busy={busyId === entry.item.id}
                    contactName={contactNameFor(entry.item)}
                    remindUrl={remindUrlFor(entry)}
                    accountLine={linkedAccountLine(entry.item)}
                    onAccept={() => handleAccept(entry.item.id)}
                    onReject={() => handleReject(entry.item.id)}
                    onCancel={() => handleCancel(entry.item.id)}
                    // Per-SENDER actions, not per-item. The audit's own words:
                    // "declining is per-item, not per-sender" is exactly the gap.
                    onReport={tab === 'incoming'
                      ? () => setSafety({ mode: 'report', userId: entry.item.fromUserId, name: contactNameFor(entry.item as LinkedRequest), contextId: entry.item.id })
                      : undefined}
                    onBlock={tab === 'incoming'
                      ? () => setSafety({ mode: 'block', userId: entry.item.fromUserId, name: contactNameFor(entry.item as LinkedRequest), contextId: entry.item.id })
                      : undefined}
                  />
                ) : (
                  <SettlementCard
                    request={entry.item}
                    tab={tab}
                    busy={busyId === entry.item.id}
                    contactName={contactNameForSettlement(entry.item)}
                    remindUrl={remindUrlFor(entry)}
                    accountLine={settlementAccountLine(entry.item)}
                    fullTracker={appMode === 'full_tracker'}
                    onAccept={() => handleAcceptSettlement(entry.item.id)}
                    onReject={() => handleRejectSettlement(entry.item.id)}
                    onCancel={() => handleCancelSettlement(entry.item.id)}
                    onReport={tab === 'incoming'
                      ? () => setSafety({ mode: 'report', userId: entry.item.fromUserId, name: contactNameForSettlement(entry.item as SettlementRequest), contextId: entry.item.id })
                      : undefined}
                    onBlock={tab === 'incoming'
                      ? () => setSafety({ mode: 'block', userId: entry.item.fromUserId, name: contactNameForSettlement(entry.item as SettlementRequest), contextId: entry.item.id })
                      : undefined}
                  />
                );
              return (
                <Fragment key={`${entry.kind}-${entry.item.id}`}>
                  {showDivider && (
                    <div className="flex items-center gap-2 pt-1.5 pb-0.5">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                        {t('inbox_resolved_divider')}
                      </span>
                      <span className="flex-1 h-px bg-cream-hairline" />
                    </div>
                  )}
                  {card}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>

      <EditTransactionModal
        open={!!selectedTxn}
        transaction={selectedTxn}
        onClose={() => setSelectedTxn(null)}
      />

      <AcceptIntoAccountSheet
        open={!!acceptSheet}
        request={acceptSheet?.req ?? null}
        onClose={() => setAcceptSheet(null)}
        onConfirm={async (accountId) => {
          if (!acceptSheet) return;
          const ok =
            acceptSheet.kind === 'linked'
              ? await performAccept(acceptSheet.id, accountId)
              : await performAcceptSettlement(acceptSheet.id, accountId);
          // Stay open on failure so the user can retry or fall back to
          // record-only; the error toast already explains what went wrong.
          if (ok) setAcceptSheet(null);
        }}
      />

      {/* Block / report the SENDER of an inbox item (audit M17). */}
      <BlockReportSheet
        open={!!safety}
        mode={safety?.mode ?? 'block'}
        targetUserId={safety?.userId ?? null}
        targetName={safety?.name ?? t('ltr_unknown_person')}
        contextType="inbox_item"
        contextId={safety?.contextId ?? null}
        onClose={() => setSafety(null)}
      />
    </main>
  );
}

// Per-sender safety actions on an inbox card. Rendered as quiet text buttons
// under the primary accept/decline row: they must be findable when a request
// is unwanted, without competing with the action the card is actually for.
function CardSafetyActions({ onReport, onBlock }: { onReport?: () => void; onBlock?: () => void }) {
  const t = useT();
  if (!onReport && !onBlock) return null;
  return (
    <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-cream-hairline">
      {onReport && (
        <button type="button" onClick={onReport} className="text-[11px] font-semibold text-ink-400 active:opacity-60">
          {t('blk_action_report')}
        </button>
      )}
      {onBlock && (
        <button type="button" onClick={onBlock} className="text-[11px] font-semibold text-pay-text active:opacity-60">
          {t('blk_action_block')}
        </button>
      )}
    </div>
  );
}

// Hoisted out of PillToggle — components defined inside a parent's render
// body lose state on every parent re-render (react-hooks/static-components).
function Pill({
  value,
  label,
  count,
  activeTab,
  onSelect,
}: {
  value: Tab;
  label: string;
  count: number;
  activeTab: Tab;
  onSelect: (t: Tab) => void;
}) {
  const isActive = activeTab === value;
  return (
    <button
      onClick={() => onSelect(value)}
      data-pill={value}
      className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors flex items-center gap-1 ${
        isActive ? 'bg-white text-ink-900' : 'text-white/70'
      }`}
    >
      {label}
      {count > 0 && (
        <span
          className={`min-w-[14px] h-3.5 px-1 rounded-full text-[9px] font-bold flex items-center justify-center tabular-nums ${
            isActive ? 'bg-pay-600 text-white' : 'bg-white/15 text-white'
          }`}
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );
}

function PillToggle({
  tab,
  setTab,
  incomingCount,
  outgoingCount,
  infoCount,
  actionCount,
  incomingLabel,
  outgoingLabel,
  infoLabel,
  actionLabel,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  incomingCount: number;
  outgoingCount: number;
  infoCount: number;
  actionCount: number;
  incomingLabel: string;
  outgoingLabel: string;
  infoLabel: string;
  actionLabel: string;
}) {
  // Keep the selected pill visible: with four pills the cluster can scroll,
  // and smart-landing may select a tab whose pill sits behind the fold.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapRef.current?.querySelector<HTMLElement>(`[data-pill="${tab}"]`);
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [tab]);
  return (
    // Four pills can outgrow a narrow phone next to the back button — the
    // cluster caps its width and scrolls sideways (scrollbar hidden, house
    // convention) instead of pushing the TopBar off-screen.
    <div ref={wrapRef} className="bg-white/10 rounded-full p-0.5 flex items-center max-w-[calc(100vw-96px)] overflow-x-auto no-scrollbar">
      <Pill value="incoming" label={incomingLabel} count={incomingCount} activeTab={tab} onSelect={setTab} />
      <Pill value="action" label={actionLabel} count={actionCount} activeTab={tab} onSelect={setTab} />
      <Pill value="info" label={infoLabel} count={infoCount} activeTab={tab} onSelect={setTab} />
      <Pill value="outgoing" label={outgoingLabel} count={outgoingCount} activeTab={tab} onSelect={setTab} />
    </div>
  );
}

const INFO_ICON: Record<InfoIconKind, typeof AlertTriangle> = {
  budget: AlertTriangle,
  renewal: Repeat,
  card: CreditCard,
  bill: CalendarClock,
};

const INFO_TONE: Record<InfoItem['tone'], { wrap: string; icon: string }> = {
  pay: { wrap: 'bg-pay-50', icon: 'text-pay-text' },
  warn: { wrap: 'bg-warn-50', icon: 'text-warn-600' },
  info: { wrap: 'bg-info-50', icon: 'text-info-600' },
  accent: { wrap: 'bg-accent-50', icon: 'text-accent-600' },
  // Praise items (e.g. a card bill cleared before its due day).
  receive: { wrap: 'bg-receive-50', icon: 'text-receive-text' },
};

// Icon + tone derive from the structured content kind; the words come from
// t() keys here (the lib stays i18n-free — thisWeek.ts pattern).
const ACTION_META: Record<ActionContent['kind'], { icon: typeof AlertTriangle; tone: InfoItem['tone'] }> = {
  emi: { icon: HandCoins, tone: 'pay' },
  recurring: { icon: Repeat, tone: 'warn' },
  kameti: { icon: Users, tone: 'info' },
  uncategorized: { icon: Tag, tone: 'accent' },
};

// Same chrome as InfoCard, but ALWAYS tappable — every item's tap is the
// one action that clears it (open the loan, file the expense, post the
// charge, tick the round). Uncategorised cards with a history-backed
// suggestion grow a one-tap accept chip (sibling of the main button —
// nested buttons are invalid HTML).
function ActionCard({ item, onResolve, onAccept }: { item: ActionItem; onResolve: () => void; onAccept?: () => void }) {
  const t = useT();
  const c = item.content;
  const meta = ACTION_META[c.kind];
  const Icon = meta.icon;
  const tone = INFO_TONE[meta.tone];
  let title: string;
  let body: string;
  if (c.kind === 'emi') {
    title = (c.count === 1
      ? t('todo_emi_title_one')
      : t('todo_emi_title_many').replace('{n}', String(c.count))
    ).replace('{name}', c.person);
    body = (c.direction === 'pay' ? t('todo_emi_body_pay') : t('todo_emi_body_collect'))
      .replace('{amount}', formatMoney(c.total, c.currency))
      .replace('{d}', String(c.daysLate));
  } else if (c.kind === 'recurring') {
    title = t('todo_recurring_title').replace('{label}', c.label);
    body = t('todo_recurring_body')
      .replace('{amount}', formatMoney(c.amount, c.currency))
      .replace('{date}', format(new Date(`${c.dueDate}T12:00:00`), 'MMM d'));
  } else if (c.kind === 'kameti') {
    title = (c.incompleteRounds > 1
      ? t('todo_kameti_title_many').replace('{k}', String(c.incompleteRounds))
      : t('todo_kameti_title_one').replace('{r}', String(c.round))
    ).replace('{name}', c.name);
    body = t('todo_kameti_body')
      .replace('{paid}', String(c.paid))
      .replace('{n}', String(c.members))
      .replace('{amount}', formatMoney(c.amount, c.currency));
  } else {
    title = t('todo_uncat_title');
    body = `${formatMoney(c.amount, c.currency)} · ${format(new Date(c.dateIso), 'MMM d')}${c.note ? ` · ${c.note}` : ''}`;
  }
  const suggestion = c.kind === 'uncategorized' ? c.suggestedCategory : undefined;

  const mainRow = (
    <>
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${tone.wrap}`}>
        <Icon size={17} className={tone.icon} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink-900 tracking-tight truncate">{title}</p>
        <p className="text-[11.5px] text-ink-500 mt-0.5 truncate">{body}</p>
      </div>
      <ChevronRight size={15} className="text-ink-300 shrink-0" />
    </>
  );

  if (suggestion && onAccept) {
    return (
      <div className="rounded-[18px] bg-cream-card border border-cream-border overflow-hidden">
        <button
          type="button"
          onClick={onResolve}
          className="w-full text-left p-4 flex items-center gap-3 active:bg-cream-soft transition-colors"
        >
          {mainRow}
        </button>
        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={onAccept}
            className="w-full min-h-[40px] rounded-xl bg-receive-50 text-receive-text text-[12px] font-semibold flex items-center justify-center gap-1.5 press"
          >
            <CheckCircle2 size={13} strokeWidth={2.2} />
            {t('todo_uncat_suggest').replace('{category}', suggestion)}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onResolve}
      className="w-full text-left rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3 press-lg"
    >
      {mainRow}
    </button>
  );
}

function InfoCard({ item, onOpen }: { item: InfoItem; onOpen: () => void }) {
  const Icon = INFO_ICON[item.icon];
  const tone = INFO_TONE[item.tone];
  const tappable = !!item.href;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!tappable}
      className={`w-full text-left rounded-[18px] bg-cream-card border border-cream-border p-4 flex items-center gap-3 ${tappable ? 'active:scale-[0.99] transition-transform' : ''}`}
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${tone.wrap}`}>
        <Icon size={17} className={tone.icon} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink-900 tracking-tight truncate">{item.title}</p>
        <p className="text-[11.5px] text-ink-500 mt-0.5 truncate">{item.body}</p>
      </div>
      {tappable && <ChevronRight size={15} className="text-ink-300 shrink-0" />}
    </button>
  );
}

// "Asif added you on Hisaab — add Asif back?"
//
// Deliberately two equal-weight choices rather than a dismissible banner:
// the whole point of the consent model is that NOT adding someone back is a
// legitimate, first-class answer, not a thing you achieve by ignoring a card.
function ContactAskCard({
  name, busy, onAdd, onSkip, onReport, onBlock,
}: {
  name: string;
  busy: boolean;
  onAdd: () => void;
  onSkip: () => void;
  onReport?: () => void;
  onBlock?: () => void;
}) {
  const t = useT();
  return (
    <div className="rounded-[18px] bg-accent-50 border border-accent-100 p-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent-100 flex items-center justify-center shrink-0">
          <UserPlus size={17} className="text-accent-600" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
            {t('clink_card_title').replace('{name}', name)}
          </p>
          <p className="text-[11.5px] text-ink-500 mt-1 leading-relaxed">
            {t('clink_card_body')}
          </p>
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="px-4 py-2.5 rounded-xl bg-cream-card border border-cream-border text-ink-600 text-[12px] font-semibold disabled:opacity-50 press-sm"
        >
          {t('clink_skip_cta')}
        </button>
        <button
          type="button"
          onClick={onAdd}
          disabled={busy}
          className="flex-1 py-2.5 rounded-xl bg-ink-900 text-white text-[12.5px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 press"
        >
          <UserPlus size={13} strokeWidth={2.4} />
          {t('clink_add_cta').replace('{name}', name)}
        </button>
      </div>
      <CardSafetyActions onReport={onReport} onBlock={onBlock} />
    </div>
  );
}

/** "3 din se intezar" for a pending outgoing ask. null when the timestamp is
 *  unreadable, so the caller just omits the line. `daysWaiting` is pure and
 *  tested; the words live here, per the repo's lib-owns-facts rule. */
function waitingLabel(createdAtIso: string, t: (key: I18nKey) => string): string | null {
  const days = daysWaiting(createdAtIso, new Date());
  if (days === null) return null;
  if (days === 0) return t('inbox_waiting_today');
  if (days === 1) return t('inbox_waiting_1d');
  return t('inbox_waiting_nd').replace('{n}', String(days));
}

function SettlementCard({
  request, tab, busy, contactName, remindUrl, accountLine, fullTracker, onAccept, onReject, onCancel, onReport, onBlock,
}: {
  request: SettlementRequest;
  tab: Tab;
  busy: boolean;
  contactName: string;
  remindUrl: string;
  // Pre-resolved which-account line for MY side (or a "record only" note),
  // null when there's nothing to say. Built by settlementAccountLine.
  accountLine: string | null;
  fullTracker: boolean;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  /** Incoming only — a per-SENDER escape hatch, not a per-item one. */
  onReport?: () => void;
  onBlock?: () => void;
}) {
  const t = useT();
  const isPending = request.status === 'pending';
  // The "will NOT change your account balances" promise only holds where
  // accounts can't be involved: the sender stayed ledger-only (outgoing),
  // or the viewer is in simple mode (incoming). A full-tracker acceptor is
  // about to be ASKED about an account — don't promise them otherwise.
  const showLedgerHint =
    tab === 'outgoing' ? !request.requesterAccountId : !fullTracker;
  const title = (tab === 'outgoing' ? t('stl_card_outgoing') : t('stl_card_incoming')).replace(
    '{name}', contactName,
  );

  const statusKey = (`stl_status_${request.status}`) as
    | 'stl_status_pending' | 'stl_status_accepted' | 'stl_status_rejected' | 'stl_status_cancelled';
  const statusClasses = {
    pending:   'bg-warn-50 text-warn-600',
    accepted:  'bg-receive-50 text-receive-text',
    rejected:  'bg-cream-soft text-ink-500',
    cancelled: 'bg-cream-soft text-ink-500',
  }[request.status];

  return (
    <div className={`rounded-[18px] bg-cream-card p-4 ${isPending ? 'border-2 border-accent-100' : 'border border-cream-border'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-900 tracking-tight">{title}</p>
          <p className="text-[18px] font-semibold text-ink-900 tabular-nums mt-1 tracking-tight">
            {formatMoney(request.amount, request.currency)}
          </p>
          <p className="text-[10.5px] text-ink-500 mt-1">
            {format(new Date(request.createdAt), 'MMM d, h:mm a')}
            {/* How long this ask has been sitting — the piece that tells the
                sender whether it's worth a nudge. Outgoing + pending only. */}
            {tab === 'outgoing' && isPending && waitingLabel(request.createdAt, t) ? (
              <span className="text-ink-400"> · {waitingLabel(request.createdAt, t)}</span>
            ) : null}
          </p>
          {accountLine && (
            <p className="text-[11px] text-ink-500 mt-1.5 flex items-start gap-1.5 leading-snug">
              <WalletMinimal size={12} className="shrink-0 mt-[1px] text-ink-400" />
              <span>{accountLine}</span>
            </p>
          )}
          {request.note ? (
            <p className="text-[11px] text-ink-500 italic mt-1.5 truncate">&ldquo;{request.note}&rdquo;</p>
          ) : null}
        </div>
        <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] rounded-full px-2.5 py-1 ${statusClasses}`}>
          {t(statusKey)}
        </span>
      </div>

      {isPending ? (
        <>
          {showLedgerHint && (
            <p className="text-[11px] text-accent-600 bg-accent-50 rounded-xl p-2.5 mt-3 leading-relaxed">
              {t('stl_ledger_only_hint')}
            </p>
          )}
          <div className="flex gap-2 mt-2">
            {tab === 'incoming' ? (
              <>
                <button
                  onClick={onReject}
                  disabled={busy}
                  className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-cream-soft border border-cream-border text-ink-600 text-[12px] font-semibold active:bg-cream-hairline transition-colors disabled:opacity-50"
                >
                  {busy ? t('ltr_rejecting') : t('ltr_reject')}
                </button>
                <button
                  onClick={onAccept}
                  disabled={busy}
                  className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-50 press"
                >
                  {busy ? t('ltr_accepting') : t('ltr_accept')}
                </button>
              </>
            ) : (
              <>
                {/* Remind: one-tap WhatsApp nudge — the defined way to chase
                    a request the other side hasn't confirmed yet. Rendered as
                    an anchor so Android hands it to the WhatsApp intent. */}
                <a
                  href={remindUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold flex items-center justify-center gap-1.5 press"
                >
                  <BellRing size={13} strokeWidth={2.2} />
                  {t('req_remind_cta')}
                </a>
                <button
                  onClick={onCancel}
                  disabled={busy}
                  className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-pay-50 text-pay-text text-[12px] font-semibold active:bg-pay-100 transition-colors disabled:opacity-50"
                >
                  {busy ? t('ltr_cancelling') : t('ltr_cancel')}
                </button>
              </>
            )}
          </div>
        </>
      ) : null}
      <CardSafetyActions onReport={onReport} onBlock={onBlock} />
    </div>
  );
}

function RequestCard({
  request, tab, busy, contactName, remindUrl, accountLine, onAccept, onReject, onCancel, onReport, onBlock,
}: {
  request: LinkedRequest;
  tab: Tab;
  busy: boolean;
  contactName: string;
  remindUrl: string;
  // Pre-resolved which-account line for MY side (or a "record only" note),
  // null when there's nothing to say. Built by linkedAccountLine.
  accountLine: string | null;
  onAccept: () => void;
  onReject: () => void;
  onCancel: () => void;
  /** Incoming only — a per-SENDER escape hatch, not a per-item one. */
  onReport?: () => void;
  onBlock?: () => void;
}) {
  const t = useT();
  const isPending = request.status === 'pending';
  const amountText = formatMoney(request.amount, request.currency);
  const isIncoming = tab === 'incoming';

  let title: string;
  if (tab === 'outgoing') {
    title = request.kind === 'lent'
      ? t('ltr_card_lent').replace('{name}', contactName)
      : t('ltr_card_borrowed').replace('{name}', contactName);
  } else {
    title = request.kind === 'lent'
      ? t('ltr_card_incoming_lent').replace('{name}', contactName)
      : t('ltr_card_incoming_borrowed').replace('{name}', contactName);
  }

  // Incoming: fold the amount and the resulting stance into one sentence so
  // the user reads "what this means for me" without doing the mental math.
  // lent → they lent you → you'd owe them (pay-text). borrowed → they borrowed
  // from you → they'd owe you (receive-text).
  const stanceClause = isIncoming
    ? request.kind === 'lent'
      ? t('inbox_card_incoming_lent_full').replace('{name}', contactName)
      : t('inbox_card_incoming_borrowed_full').replace('{name}', contactName)
    : null;
  const stanceColor = request.kind === 'lent' ? 'text-pay-text' : 'text-receive-text';

  const statusKey = (`ltr_status_${request.status}`) as
    | 'ltr_status_pending' | 'ltr_status_accepted' | 'ltr_status_rejected' | 'ltr_status_cancelled';
  const statusClasses = {
    pending:   'bg-warn-50 text-warn-600',
    accepted:  'bg-receive-50 text-receive-text',
    rejected:  'bg-cream-soft text-ink-500',
    cancelled: 'bg-cream-soft text-ink-500',
  }[request.status];

  return (
    <div className={`rounded-[18px] bg-cream-card p-4 ${isPending ? 'border-2 border-warn-50' : 'border border-cream-border'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-[13px] font-medium text-ink-900 tracking-tight">
              {isIncoming ? (
                <>
                  {title} <span className="font-semibold tabular-nums">{amountText}</span>
                  {stanceClause && (
                    <>
                      {' '}
                      <span className="text-ink-400">— </span>
                      <span className={`font-semibold ${stanceColor}`}>{stanceClause}</span>
                    </>
                  )}
                </>
              ) : (
                title
              )}
            </p>
            {/* Phase 2D: marks a "sync past record" request so the recipient
                sees this is historical, not a fresh-loan announcement. Same
                accept/decline flow underneath. */}
            {request.preExistingLoanId && (
              <span className="text-[8.5px] font-semibold uppercase tracking-[0.1em] rounded-full bg-accent-100 text-accent-600 px-1.5 py-0.5 shrink-0">
                {t('inbox_past_record_tag')}
              </span>
            )}
          </div>
          {!isIncoming && (
            <p className="text-[18px] font-semibold text-ink-900 tabular-nums mt-1 tracking-tight">
              {amountText}
            </p>
          )}
          <p className="text-[10.5px] text-ink-500 mt-1">
            {format(new Date(request.createdAt), 'MMM d, h:mm a')}
            {/* How long this ask has been sitting — the piece that tells the
                sender whether it's worth a nudge. Outgoing + pending only. */}
            {tab === 'outgoing' && isPending && waitingLabel(request.createdAt, t) ? (
              <span className="text-ink-400"> · {waitingLabel(request.createdAt, t)}</span>
            ) : null}
          </p>
          {accountLine && (
            <p className="text-[11px] text-ink-500 mt-1.5 flex items-start gap-1.5 leading-snug">
              <WalletMinimal size={12} className="shrink-0 mt-[1px] text-ink-400" />
              <span>{accountLine}</span>
            </p>
          )}
          {request.note ? (
            <p className="text-[11px] text-ink-500 italic mt-1.5 truncate">&ldquo;{request.note}&rdquo;</p>
          ) : null}
          {request.rejectionReason ? (
            <p className="text-[11px] text-ink-500 mt-1.5">{request.rejectionReason}</p>
          ) : null}
        </div>
        <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] rounded-full px-2.5 py-1 ${statusClasses}`}>
          {t(statusKey)}
        </span>
      </div>

      {isPending ? (
        <div className="flex gap-2 mt-3">
          {tab === 'incoming' ? (
            <>
              <button
                onClick={onReject}
                disabled={busy}
                className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-cream-soft border border-cream-border text-ink-600 text-[12px] font-semibold active:bg-cream-hairline transition-colors disabled:opacity-50"
              >
                {busy ? t('ltr_rejecting') : t('ltr_reject')}
              </button>
              <button
                onClick={onAccept}
                disabled={busy}
                className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold disabled:opacity-50 press"
              >
                {busy ? t('ltr_accepting') : t('ltr_accept')}
              </button>
            </>
          ) : (
            <>
              {/* Remind: one-tap WhatsApp nudge — the defined way to chase a
                  request the other side hasn't confirmed yet. */}
              <a
                href={remindUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-ink-900 text-white text-[12px] font-semibold flex items-center justify-center gap-1.5 press"
              >
                <BellRing size={13} strokeWidth={2.2} />
                {t('req_remind_cta')}
              </a>
              <button
                onClick={onCancel}
                disabled={busy}
                className="flex-1 min-h-[44px] py-2.5 rounded-xl bg-pay-50 text-pay-text text-[12px] font-semibold active:bg-pay-100 transition-colors disabled:opacity-50"
              >
                {busy ? t('ltr_cancelling') : t('ltr_cancel')}
              </button>
            </>
          )}
        </div>
      ) : null}
      <CardSafetyActions onReport={onReport} onBlock={onBlock} />
    </div>
  );
}
