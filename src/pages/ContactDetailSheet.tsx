import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, HandCoins, Handshake, RefreshCw, History, ShieldCheck, Trash2, MessageCircle, Check, X, FileText, Merge, QrCode, Clock, Phone } from 'lucide-react';
import { Modal } from '../components/Modal';
import { QRScanner } from '../components/QRScanner';
import { formatConnectCode } from '../lib/connectQr';
import { usePersonStore, ContactLinkError, DuplicateLinkedContactError } from '../stores/personStore';
import { useContactLinkStore } from '../stores/contactLinkStore';
import { usePhoneDiscoveryStore, findPhoneMatch } from '../stores/phoneDiscoveryStore';
import { useSupabaseAuthStore } from '../stores/supabaseAuthStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useLoanStore } from '../stores/loanStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useAccountStore } from '../stores/accountStore';
import { useToast } from '../components/Toast';
import { codeLookupBudgetSpent, resolveProfileByCode } from '../lib/collaboration';
import { formatLinkError, retryAfterMinutes } from '../lib/contactLinkStatus';
import { buildWhatsAppUrl, hasWhatsAppNumber } from '../lib/whatsappReminder';
import { formatMoney } from '../lib/constants';
import { computeTrustScore, trustLevelStyle } from '../lib/trustScore';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { markMirrorStale } from '../lib/mirrorCache';
import { VerifiedBadge } from '../components/VerifiedBadge';
import { isConsentVerifiedLink } from '../lib/contactVerification';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import type { Person } from '../db';
import { QuickEntry, type QuickEntryPreset } from './QuickEntry';
import { EditTransactionModal } from '../components/EditTransactionModal';
import { SendStatementModal } from '../components/SendStatementModal';
import { useT } from '../lib/i18n';
import { getActionLabel } from '../lib/transactionLabel';
import type { Transaction } from '../db';

interface Props {
  open: boolean;
  person: Person | null;
  onClose: () => void;
}

type Mode = 'idle' | 'entering' | 'resolved';

// Phase 2A: per-contact sheet. Shows name, linked state, and one action —
// "Link to Hisaab user" or "Unlink". The code lookup only runs on explicit
// Resolve button press, never on keystrokes.
export function ContactDetailSheet({ open, person, onClose }: Props) {
  const { linkToProfile, linkToDiscoveredProfile, unlinkFromProfile, archiveIfSettled, updatePhone } =
    usePersonStore();
  const persons = usePersonStore((s) => s.persons);
  const syncableBreakdownFor = useLinkedRequestStore((s) => s.syncableBreakdownFor);
  const syncPastRecords = useLinkedRequestStore((s) => s.syncPastRecords);
  // Subscribe to requests so the syncable count updates after a sync fires.
  const requests = useLinkedRequestStore((s) => s.requests);
  // Loans + transactions feed the private trust score. Reads stay subscribed
  // so the score live-updates if a loan settles while this sheet is open.
  const loans = useLoanStore((s) => s.loans);
  const transactions = useTransactionStore((s) => s.transactions);
  const toast = useToast();
  const t = useT();

  const [mode, setMode] = useState<Mode>('idle');
  const [code, setCode] = useState('');
  const [resolving, setResolving] = useState(false);
  // `code` is the raw code this preview came from — the link RPC verifies it
  // server-side, so it must be carried through to the confirm step. A
  // discovery hit has no code (null) and can only use the legacy write path.
  const [resolved, setResolved] = useState<
    { profileId: string; displayName: string; code: string | null } | null
  >(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [showMergePicker, setShowMergePicker] = useState(false);
  const [merging, setMerging] = useState(false);
  const [showMoneyEntry, setShowMoneyEntry] = useState(false);
  const [moneyPreset, setMoneyPreset] = useState<QuickEntryPreset | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [savingPhone, setSavingPhone] = useState(false);
  const [showStatement, setShowStatement] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  // Double-tap guards (audit C10/F-8) — one per independent money/request
  // mutating action on this sheet. See src/lib/useSubmitGuard.ts.
  const syncGuard = useSubmitGuard();
  const linkGuard = useSubmitGuard();
  const unlinkGuard = useSubmitGuard();
  const archiveGuard = useSubmitGuard();
  const mergeGuard = useSubmitGuard();

  // Whether THEY have added this user back. A link is one-sided until the
  // other person accepts, and the sheet used to claim otherwise.
  const myId = useSupabaseAuthStore((s) => s.user?.id ?? '');
  const contactLinks = useContactLinkStore((s) => s.requests);
  const discover = usePhoneDiscoveryStore((s) => s.discover);
  const discoveryResults = usePhoneDiscoveryStore((s) => s.results);

  const savePhone = async () => {
    if (!person) return;
    setSavingPhone(true);
    try {
      await updatePhone(person.id, phoneDraft);
      setEditingPhone(false);
      toast.show({ type: 'success', title: phoneDraft.trim() ? t('contact_whatsapp_saved') : t('contact_whatsapp_removed') });
    } catch {
      toast.show({ type: 'error', title: t('err_could_not_save') });
    } finally {
      setSavingPhone(false);
    }
  };

  useEffect(() => {
    if (!open) {
      // Reset any in-flight link flow when the sheet closes.
      setMode('idle');
      setCode('');
      setResolving(false);
      setResolved(null);
      setError('');
      setSaving(false);
      setSyncing(false);
      setArchiving(false);
      setEditingPhone(false);
      setShowStatement(false);
      setShowScanner(false);
    }
  }, [open]);

  // Check this contact's saved number against opted-in Hisaab accounts, so
  // an unlinked contact who is already a user can be linked in one tap
  // instead of a code exchange. Store-level dedupe makes a re-open free.
  useEffect(() => {
    if (!open || !person?.phone || person.linkedProfileId) return;
    void discover([person.phone]);
  }, [open, person?.phone, person?.linkedProfileId, discover]);

  // Compute the syncable set here so the card can show an honest
  // per-currency preview. Re-runs when requests change so the card hides
  // itself after a successful sync without needing manual refresh.
  const { syncable } = useMemo(
    () => (person ? syncableBreakdownFor(person.id) : { syncable: [], skipped: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [person?.id, requests, syncableBreakdownFor],
  );
  // Bucket the open balance by currency so we never quietly add PKR into
  // an AED total (different units). The sync action sends each loan as
  // its own request with its own currency — we just need the preview
  // to be honest about it.
  const syncableByCurrency = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const loan of syncable) {
      const bucket = map.get(loan.currency) ?? { total: 0, count: 0 };
      bucket.total += loan.remainingAmount;
      bucket.count += 1;
      map.set(loan.currency, bucket);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [syncable]);

  // Private trust score. Computed only against this person's loans, so the
  // dependency list is precise — re-runs when their loans or repayments
  // change but not when unrelated loans mutate. The score is never sent
  // anywhere: it exists only in the current user's view of this contact.
  const trustScore = useMemo(
    () => (person ? computeTrustScore(person.id, person.name, loans, transactions) : null),
    [person, loans, transactions],
  );

  if (!person) return null;

  const isLinked = !!person.linkedProfileId;
  // The seal — and the "connected both ways" prose — needs CONSENT, not a
  // linked_profile_id I wrote myself — see src/lib/contactVerification.ts
  // (audit 2026-09 SEC-09). An unaccepted or legacy link falls through to
  // the waiting copy below instead of claiming a mutual connection.
  const linkVerified = isConsentVerifiedLink(contactLinks, myId, person.linkedProfileId);
  // Derived from the subscribed snapshot (not a store read) so the badge
  // repaints on the render where the lookup landed.
  const discoveryHit = isLinked ? null : findPhoneMatch(discoveryResults, person.phone);
  const trustStyle = trustScore ? trustLevelStyle(trustScore.level) : null;
  const relationshipBalances = (() => {
    const byCurrency = new Map<string, number>();
    for (const loan of loans.filter((entry) => entry.personId === person.id && entry.status === 'active')) {
      const delta = loan.type === 'given' ? loan.remainingAmount : -loan.remainingAmount;
      byCurrency.set(loan.currency, (byCurrency.get(loan.currency) ?? 0) + delta);
    }
    return [...byCurrency.entries()].filter(([, value]) => Math.abs(value) > 0.00001);
  })();
  // All of this contact's loans (personId, with a name fallback for legacy
  // loans created before the contact record existed) — the raw material for a
  // statement that spans every loan direction and currency with this person.
  const personLoans = loans.filter(
    (loan) =>
      !loan.deletedAt &&
      (loan.personId === person.id ||
        (!loan.personId && loan.personName.trim().toLowerCase() === person.name.trim().toLowerCase())),
  );
  const recentEntries = transactions
    .filter((transaction) => transaction.personId === person.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  const openMoneyEntry = (entryPreset: QuickEntryPreset) => {
    setMoneyPreset({
      ...entryPreset,
      contact: { id: person.id, name: person.name },
      lockContact: true,
    });
    setShowMoneyEntry(true);
  };

  // Guarded: syncPastRecords loops createRequest via Promise.all internally —
  // a double tap would send 2N cross-user requests (audit C10/F-8).
  const handleSyncPastRecords = () => syncGuard.run(runSyncPastRecords);
  const runSyncPastRecords = async () => {
    if (!person) return;
    const ok = await confirmDestructive({
      title: t('contact_sync_confirm_title').replace('{name}', person.name),
      description: t('contact_sync_confirm_body'),
      confirmLabel: t('contact_sync_confirm_cta'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    setSyncing(true);
    try {
      const result = await syncPastRecords(person.id);
      if (result.created.length > 0) {
        const skippedNote =
          result.skipped.length > 0
            ? ` ${result.skipped.length} ${result.skipped.length === 1 ? 'loan' : 'loans'} in unsupported currencies stayed local.`
            : '';
        toast.show({
          type: 'success',
          title: `Sent ${result.created.length} ${result.created.length === 1 ? 'record' : 'records'} for confirmation`,
          subtitle: `Each one shows up in their Inbox to accept or decline.${skippedNote}`,
        });
      }
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not sync past records',
        subtitle: err instanceof Error ? err.message : 'Try again in a moment.',
      });
    } finally {
      setSyncing(false);
    }
  };

  // A throttled lookup returns zero rows, exactly like a genuine miss, so the
  // only hint we have is our own count of charges this hour.
  const noPreviewMessage = () =>
    codeLookupBudgetSpent()
      ? t('clink_err_rate_limited').replace('{minutes}', String(retryAfterMinutes(undefined)))
      : t('clink_err_no_match');

  const handleResolve = async () => {
    setError('');
    setResolved(null);
    const trimmed = code.trim();
    if (!trimmed) {
      setError(t('clink_err_invalid_code'));
      return;
    }
    setResolving(true);
    try {
      const found = await resolveProfileByCode(trimmed);
      if (!found) {
        setError(noPreviewMessage());
        return;
      }
      setResolved({ ...found, code: trimmed });
      setMode('resolved');
    } catch {
      setError(t('addc_link_err_lookup'));
    } finally {
      setResolving(false);
    }
  };

  const handleConfirmLink = () => linkGuard.run(runConfirmLink);
  const runConfirmLink = async () => {
    if (!resolved) return;
    setSaving(true);
    setError('');
    try {
      // Both paths are server-verified now; only the PROOF differs. Code path:
      // the server re-resolves the code (the resolved profile rides along only
      // as the pre-migration fallback). Discovery path: no code exists, so the
      // server re-runs the phone match itself against this contact's saved
      // number — the profile id below is a claim it checks, not a credential.
      const linked = resolved.code
        ? await linkToProfile(person.id, resolved.code, {
            profileId: resolved.profileId,
            displayName: resolved.displayName,
          })
        : await linkToDiscoveredProfile(person.id, resolved.profileId, resolved.displayName);
      toast.show({
        type: 'success',
        title: t('clink_added_toast').replace('{name}', linked.displayName || resolved.displayName),
        // Honest about consent: linked on your side; theirs is their call.
        subtitle:
          linked.linkState === 'mutual'
            ? t('clink_mutual')
            : t('clink_waiting').replace('{name}', linked.displayName || resolved.displayName),
      });
      onClose();
    } catch (err) {
      if (err instanceof DuplicateLinkedContactError) {
        // Name the contact that's already linked to this person — a common case
        // when both sides exchange codes and a reciprocal contact was auto-made,
        // so the user isn't stuck on an opaque "already linked" message.
        const existing = persons.find((p) => p.linkedProfileId === resolved.profileId && p.id !== person.id);
        setError(
          existing
            ? t('contact_dup_link_named').replace('{name}', existing.name)
            : t('contact_dup_link_generic'),
        );
      } else {
        // Same statuses either way, but NO_MATCH / RATE_LIMITED need discovery
        // wording — "check the code" is meaningless when there was no code.
        setError(formatLinkError(err, t, resolved.code ? 'code' : 'discovery'));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUnlink = () => unlinkGuard.run(runUnlink);
  const runUnlink = async () => {
    const ok = await confirmDestructive({
      title: t('contact_unlink_confirm_title').replace('{name}', person.name),
      description: t('contact_unlink_confirm_body'),
      confirmLabel: t('contact_unlink_confirm_cta'),
      cancelLabel: t('cancel'),
      tone: 'warning',
    });
    if (!ok) return;
    setSaving(true);
    setError('');
    try {
      await unlinkFromProfile(person.id);
      onClose();
    } catch (err) {
      // Unlink has its own copy for the generic case; a specific server status
      // (not signed in, contact gone) still gets its own message.
      const status = err instanceof ContactLinkError ? err.status : 'UNKNOWN';
      setError(status === 'UNKNOWN' ? t('clink_err_unlink') : formatLinkError(err, t));
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = () => archiveGuard.run(runArchive);
  const runArchive = async () => {
    const confirmed = await confirmDestructive({
      title: 'Remove this contact?',
      description: t('del_contact_body'),
      confirmLabel: 'Remove contact',
    });
    if (!confirmed) return;

    setArchiving(true);
    setError('');
    try {
      const result = await archiveIfSettled(person.id);
      if (!result.success) {
        setError(result.userMessage);
        return;
      }
      toast.show({
        type: 'success',
        title: 'Contact removed',
        subtitle: 'Past settled records still keep the contact name.',
      });
      onClose();
    } catch {
      setError('Could not remove this contact. Try again.');
    } finally {
      setArchiving(false);
    }
  };

  // Fold this LOCAL duplicate into another contact: one atomic server-side
  // RPC reassigns every loan/transaction (id-keyed AND name-fallback rows),
  // then archives this row. Loans/transactions are mirrored stores — mark
  // them stale and refetch so the reassignment is visible immediately.
  const handleMerge = (target: Person) => mergeGuard.run(() => runMerge(target));
  const runMerge = async (target: Person) => {
    const confirmed = await confirmDestructive({
      title: t('merge_confirm_title').replace('{target}', target.name),
      description: t('merge_confirm_body')
        .replace('{source}', person.name)
        .replace('{target}', target.name),
      confirmLabel: t('merge_cta'),
      tone: 'warning',
    });
    if (!confirmed) return;
    setMerging(true);
    setError('');
    try {
      const result = await usePersonStore.getState().mergePerson(person.id, target.id);
      if (!result.success) {
        setShowMergePicker(false);
        // The RPC returns structured reason codes precisely so the client
        // owns the words — never surface the server's English strings.
        setError(
          result.reasonCode === 'LINKED_CONTACT' ? t('merge_err_linked')
          : result.reasonCode === 'SAME_CONTACT' ? t('merge_err_same')
          : t('merge_err_not_found'),
        );
        return;
      }
      markMirrorStale('loans');
      markMirrorStale('transactions');
      void useLoanStore.getState().loadLoans().catch(() => {});
      void useTransactionStore.getState().loadTransactions().catch(() => {});
      toast.show({
        type: 'success',
        title: t('merge_done').replace('{target}', target.name),
        subtitle: t('merge_done_sub')
          .replace('{n}', String(result.movedLoans))
          .replace('{m}', String(result.movedTransactions)),
      });
      setShowMergePicker(false);
      onClose();
    } catch (err) {
      setShowMergePicker(false);
      // PGRST202 = the merge RPC doesn't exist yet (SQL migration not
      // applied). Everything else gets the generic bilingual message —
      // raw PostgREST/network text never reaches the user.
      const code = (err as { code?: string } | null)?.code;
      setError(code === 'PGRST202' ? t('merge_err_migration') : t('merge_err_generic'));
    } finally {
      setMerging(false);
    }
  };

  return (
    <>
    <Modal open={open} onClose={onClose} title={person.name}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-accent-100 text-accent-600 flex items-center justify-center text-sm font-bold">
            {(person.name[0] ?? '?').toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            {/* Inner span carries `truncate` — ellipsis doesn't work on flex
                containers, and a bare text node can't shrink (min-content),
                which clipped the badge off-screen for long names. */}
            <p className="text-[14px] font-semibold text-ink-900 flex items-center gap-1.5 min-w-0">
              <span className="truncate">{person.name}</span>
              {linkVerified && <VerifiedBadge size={15} title={t('contact_linked_pill')} />}
            </p>
            {isLinked && person.linkedProfileId ? (
              // Surface WHICH Hisaab account this contact is paired with so the
              // user can verify before syncing or unlinking. The display name
              // is the contact's own name; the short account ref (font-mono)
              // is the stable, comparable identifier for that account.
              <p className="text-[11px] text-ink-500 truncate">
                {t('contact_linked_to')} <span className="font-semibold text-ink-700">{person.name}</span>
                {' · '}
                <span className="font-mono text-ink-600">{person.linkedProfileId.slice(0, 8)}</span>
              </p>
            ) : (
              <p className="text-[11px] text-ink-500">
                {t('contact_not_linked')}
              </p>
            )}
          </div>
          {isLinked && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-receive-text bg-receive-50 rounded-full px-2.5 py-1">
              {t('contact_linked_pill')}
            </span>
          )}
        </div>

        <div className="rounded-2xl bg-accent-50 border border-accent-100 p-4">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-accent-600">{t('current_balance')}</p>
          {relationshipBalances.length === 0 ? (
            <p className="text-[14px] font-semibold text-ink-900 mt-1">You are settled up with {person.name}.</p>
          ) : (
            <div className="space-y-1 mt-1">
              {relationshipBalances.map(([currency, balance]) => (
                <p key={currency} className="text-[14px] font-semibold text-ink-900">
                  {balance > 0
                    ? `${person.name} owes you ${formatMoney(balance, currency)}.`
                    : `You owe ${person.name} ${formatMoney(Math.abs(balance), currency)}.`}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Send a full Statement of Account with this contact — spans every
            loan (both directions) and currency, delivered as a one-page PDF or
            a WhatsApp text ping. Shown once there's any loan history. */}
        {personLoans.length > 0 && (
          <button
            type="button"
            onClick={() => setShowStatement(true)}
            className="w-full py-3 rounded-2xl bg-accent-100 text-accent-600 text-[13px] font-bold flex items-center justify-center gap-2 press"
          >
            <FileText size={14} strokeWidth={2.2} /> {t('soa_cta')}
          </button>
        )}

        {/* WhatsApp number — add it once so payment reminders go straight to
            their chat, and so the contact list shows the WhatsApp badge. */}
        <div className="rounded-2xl bg-cream-card border border-cream-border p-3.5">
          <div className="flex items-center gap-2.5">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${hasWhatsAppNumber(person.phone) ? 'bg-receive-50' : 'bg-cream-soft'}`}>
              <MessageCircle size={16} strokeWidth={2} style={{ color: hasWhatsAppNumber(person.phone) ? '#1FA855' : 'var(--color-ink-400)' }} />
            </div>
            {editingPhone ? (
              <div className="flex-1 flex items-center gap-2">
                <input
                  autoFocus
                  value={phoneDraft}
                  onChange={(e) => setPhoneDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void savePhone(); } if (e.key === 'Escape') setEditingPhone(false); }}
                  placeholder="+971 50 123 4567"
                  inputMode="tel"
                  className="flex-1 min-w-0 bg-cream-soft border border-cream-border rounded-lg px-3 py-2 text-[13px] text-ink-900 outline-none focus:border-accent-500"
                />
                <button type="button" disabled={savingPhone} onClick={() => void savePhone()} className="text-receive-600 disabled:opacity-40 press-xs" aria-label={t('cat_save')}><Check size={16} strokeWidth={2.8} /></button>
                <button type="button" onClick={() => setEditingPhone(false)} className="text-ink-400 press-xs" aria-label={t('cancel')}><X size={16} /></button>
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-semibold text-ink-900">{t('contact_whatsapp')}</p>
                  <p className="text-[11px] text-ink-500 truncate">{person.phone || t('contact_whatsapp_none')}</p>
                </div>
                {hasWhatsAppNumber(person.phone) && (
                  <a href={buildWhatsAppUrl(person.phone, '')} target="_blank" rel="noopener noreferrer" className="shrink-0 press-xs" style={{ color: '#1FA855' }} aria-label="WhatsApp">
                    <MessageCircle size={17} />
                  </a>
                )}
                <button type="button" onClick={() => { setPhoneDraft(person.phone ?? ''); setEditingPhone(true); }} className="text-accent-600 text-[11px] font-semibold shrink-0">
                  {person.phone ? t('contact_whatsapp_edit') : t('contact_whatsapp_add')}
                </button>
              </>
            )}
          </div>
        </div>

        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-500 mb-2">{t('add_money_entry')}</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: t('person_gave'), type: 'loan_given' as const, icon: HandCoins },
              { label: t('person_borrowed'), type: 'loan_taken' as const, icon: Handshake },
              { label: t('person_paid_me_back'), type: 'repayment' as const, repaymentDirection: 'received' as const, icon: ArrowDownLeft },
              { label: t('person_i_paid_back'), type: 'repayment' as const, repaymentDirection: 'paid' as const, icon: ArrowUpRight },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => openMoneyEntry({ type: action.type, repaymentDirection: action.repaymentDirection })}
                className="rounded-xl bg-cream-card border border-cream-border px-3 py-3 text-left press"
              >
                <action.icon size={14} className="text-accent-600 mb-1.5" />
                <span className="text-[12px] font-semibold text-ink-900">{action.label}</span>
              </button>
            ))}
          </div>
        </div>

        {recentEntries.length > 0 && (
          <div className="rounded-2xl bg-cream-card border border-cream-border p-3.5">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-500 mb-2">{t('recent_money_history')}</p>
            <div className="space-y-2">
              {recentEntries.map((entry) => {
                const linkedLoan = entry.relatedLoanId ? loans.find((l) => l.id === entry.relatedLoanId) ?? null : null;
                const label = getActionLabel(entry, t, { personName: person.name, loan: linkedLoan });
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setEditingTransaction(entry)}
                    className="w-full flex justify-between gap-3 text-[12px] text-left rounded-lg py-1 active:bg-cream-soft transition-colors"
                  >
                    <span className="text-ink-700 truncate">{label}</span>
                    <span className="font-semibold text-ink-900 shrink-0">{formatMoney(entry.amount, entry.currency)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {recentEntries.length === 0 && (
          <p className="text-[12px] text-ink-500 bg-cream-soft border border-cream-hairline rounded-xl p-3 leading-relaxed">
            No money history with {person.name} yet. Add the first entry above.
          </p>
        )}

        {/* Private trust history card. Visible only when there's at least one
            prior loan with this person — for fresh contacts the score is
            empty and hiding the card keeps the sheet clean. */}
        {trustScore && trustStyle && trustScore.totalLoans > 0 && (
          <div className="rounded-2xl bg-cream-card border border-cream-border p-3.5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-2xl bg-cream-soft border border-cream-hairline flex items-center justify-center shrink-0">
                <ShieldCheck size={16} className="text-ink-600" strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[12.5px] font-semibold text-ink-900 tracking-tight">
                    Your private history
                  </p>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-widest rounded-full px-2 py-0.5 border ${trustStyle.badgeClass} flex items-center gap-1.5`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${trustStyle.dot}`} />
                    {trustStyle.label}
                  </span>
                </div>
                <p className="text-[11px] text-ink-500 mt-1 leading-relaxed">
                  {trustScore.summary}
                </p>
                <div className="grid grid-cols-3 gap-2 mt-2.5">
                  <div className="rounded-xl bg-cream-soft px-2 py-1.5">
                    <p className="text-[9.5px] text-ink-500 uppercase tracking-widest font-bold">
                      Total
                    </p>
                    <p className="text-[13px] text-ink-900 font-bold tabular-nums">
                      {trustScore.totalLoans}
                    </p>
                  </div>
                  <div className="rounded-xl bg-cream-soft px-2 py-1.5">
                    <p className="text-[9.5px] text-ink-500 uppercase tracking-widest font-bold">
                      Settled
                    </p>
                    <p className="text-[13px] text-receive-text font-bold tabular-nums">
                      {trustScore.settledLoans}
                    </p>
                  </div>
                  <div className="rounded-xl bg-cream-soft px-2 py-1.5">
                    <p className="text-[9.5px] text-ink-500 uppercase tracking-widest font-bold">
                      Open
                    </p>
                    <p className="text-[13px] text-ink-900 font-bold tabular-nums">
                      {trustScore.activeLoans}
                    </p>
                  </div>
                </div>
                <p className="text-[10.5px] text-ink-400 mt-2 italic leading-relaxed">
                  Only you can see this. The other person is never notified.
                </p>
              </div>
            </div>
          </div>
        )}

        {isLinked ? (
          <div className="space-y-3">
            {/* Phase 2D: Sync past records. Surfaces only after linking,
                only when there's something to share. Each loan becomes one
                linked request in the recipient's Inbox; the sender's
                existing loan history (repayments, EMI, notes) stays
                intact — the RPC reuses it on accept. */}
            {syncable.length > 0 && (
              <div className="rounded-2xl bg-accent-50 border border-cream-border p-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-accent-100 flex items-center justify-center shrink-0">
                    <History size={18} className="text-accent-600" strokeWidth={1.8} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-ink-900 tracking-tight">
                      {syncable.length} past{' '}
                      {syncable.length === 1 ? 'record' : 'records'} with {person.name}
                    </p>
                    <p className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                      Send {syncable.length === 1 ? 'it' : 'them'} for confirmation so
                      both ledgers stay in sync. Each lands in their Inbox to accept
                      or decline — your repayment history stays intact on your side.
                    </p>
                  </div>
                </div>
                {syncableByCurrency.length > 0 && (
                  <div className="text-[11px] text-ink-500 mt-2.5 pl-[52px] space-y-0.5">
                    <p className="text-ink-500">Open balance:</p>
                    {syncableByCurrency.map(([currency, { total, count }]) => (
                      <p
                        key={currency}
                        className="tabular-nums flex items-baseline justify-between gap-3"
                      >
                        <span className="font-semibold text-ink-900">
                          {formatMoney(total, currency)}
                        </span>
                        <span className="text-ink-500 text-[10.5px]">
                          {count} {count === 1 ? 'loan' : 'loans'}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
                <button
                  onClick={handleSyncPastRecords}
                  disabled={syncing}
                  className="mt-3 w-full py-2.5 rounded-xl bg-ink-900 text-white text-[12.5px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 press"
                >
                  <RefreshCw size={12} strokeWidth={2.4} />
                  {syncing
                    ? 'Sending…'
                    : `Sync ${syncable.length === 1 ? 'this record' : `${syncable.length} records`}`}
                </button>
              </div>
            )}

            {linkVerified ? (
              <p className="text-[11px] text-ink-500 leading-relaxed">
                {t('clink_mutual')} &mdash; {person.name} appears in your contacts and you
                appear in theirs. Loans and splits you record can be shared.
              </p>
            ) : (
              // Honest intermediate state. Claiming a mutual connection that
              // the other side hasn't consented to (still pending, or a
              // legacy link predating the consent flow) is exactly the
              // confusion that made people ask "why can't they see me?" —
              // see src/lib/contactVerification.ts (audit 2026-09 SEC-09).
              <div className="rounded-2xl bg-warn-50 border border-cream-border p-3.5 flex items-start gap-2.5">
                <Clock size={15} className="text-warn-600 shrink-0 mt-0.5" strokeWidth={2.2} />
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-ink-900">
                    {t('clink_waiting').replace('{name}', person.name)}
                  </p>
                  <p className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
                    {t('clink_waiting_desc')}
                  </p>
                </div>
              </div>
            )}
            <button
              onClick={handleUnlink}
              disabled={saving}
              className="cta-destructive"
            >
              {saving ? 'Working…' : 'Unlink'}
            </button>
          </div>
        ) : mode === 'idle' ? (
          <div className="space-y-2">
            {/* One-tap link when this contact's saved number already resolved
                to a Hisaab account — no code exchange needed at all.
                NO verified seal here (audit 2026-09 SEC-09): phone numbers are
                self-claimed with zero ownership check, so this match proves
                only that SOME account claims this number. A neutral phone
                glyph plus an explicit caption, so nobody links a stranger
                believing Hisaab vouched for them. */}
            {discoveryHit && (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  // No code behind a phone match — see handleConfirmLink.
                  setResolved({
                    profileId: discoveryHit.profileId,
                    displayName: discoveryHit.displayName,
                    code: null,
                  });
                  setMode('resolved');
                }}
                className="w-full rounded-2xl bg-cream-soft border border-cream-border px-3.5 py-3 flex items-start gap-2.5 text-left disabled:opacity-50 press-lg"
              >
                <Phone size={16} strokeWidth={2.2} className="shrink-0 mt-0.5 text-ink-500" aria-hidden />
                <span className="flex-1 min-w-0">
                  <span className="block text-[12px] text-ink-700 leading-snug">
                    {t('disc_found').replace('{name}', discoveryHit.displayName)}
                  </span>
                  <span className="block text-[10.5px] text-ink-500 leading-relaxed mt-0.5">
                    {t('disc_unverified_note')}
                  </span>
                </span>
                <span className="shrink-0 text-[11.5px] font-bold text-accent-600 mt-0.5">
                  {t('disc_link_cta')}
                </span>
              </button>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setShowScanner(true)}
                className="flex-1 py-3 rounded-2xl bg-ink-900 text-white text-[12.5px] font-bold flex items-center justify-center gap-1.5 press"
              >
                <QrCode size={14} strokeWidth={2.2} /> {t('qr_scan_cta')}
              </button>
              <button
                onClick={() => setMode('entering')}
                className="flex-1 py-3 rounded-2xl bg-cream-soft border border-cream-border text-ink-700 text-[12.5px] font-bold press"
              >
                {t('addc_link_code')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="form-label">
                User code
              </label>
              <input
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  // Invalidate any prior resolved state on every edit so the
                  // user must press Resolve again for the new value.
                  if (resolved) setResolved(null);
                  if (mode === 'resolved') setMode('entering');
                  if (error) setError('');
                }}
                placeholder="HSB-XXXXXX"
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="off"
                className="input-field"
              />
              <p className="text-[11px] text-ink-500 mt-1.5">
                Ask them to open their code in Contacts &rarr; Your connect code
                &mdash; or scan the QR they show you.
              </p>
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] font-bold text-accent-600"
              >
                <QrCode size={13} strokeWidth={2.2} /> {t('qr_scan_cta')}
              </button>
            </div>

            {mode === 'resolved' && resolved ? (
              <div className="rounded-2xl border border-receive-100/70 bg-receive-50/60 p-3">
                <p className="text-[11px] font-bold text-receive-text uppercase tracking-widest">Found</p>
                <p className="text-[14px] font-semibold text-ink-900 mt-0.5">{resolved.displayName}</p>
                <p className="text-[11px] text-ink-500 mt-1">
                  {/* Precise about what confirming does and doesn't do: the
                      link is yours immediately; appearing in THEIR contacts
                      is their call, not something this button decides. */}
                  Confirming links them on your side straight away, and asks{' '}
                  {resolved.displayName} to add you back so records can flow both ways.
                </p>
              </div>
            ) : (
              <button
                onClick={handleResolve}
                disabled={resolving || !code.trim()}
                className="w-full py-3 rounded-2xl bg-accent-100 text-accent-600 text-[13px] font-bold active:bg-accent-100 transition-all disabled:opacity-40"
              >
                {resolving ? 'Looking up…' : 'Resolve'}
              </button>
            )}

            {mode === 'resolved' && resolved && (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setMode('entering');
                    setResolved(null);
                  }}
                  disabled={saving}
                  className="px-4 py-3 rounded-2xl bg-cream-soft text-ink-500 text-[12px] font-bold active:bg-slate-200 transition-all disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmLink}
                  disabled={saving}
                  className="flex-1 py-3 rounded-2xl bg-ink-900 text-white text-[13px] font-bold disabled:opacity-40 shadow-md shadow-indigo-500/20"
                >
                  {saving ? 'Linking…' : 'Confirm link'}
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="text-[12px] text-pay-text font-semibold bg-pay-50 rounded-xl p-3">{error}</p>
        )}

        {!isLinked && (
          <div className="pt-1 border-t border-cream-hairline">
            {/* Merge: a local duplicate is the only legal merge SOURCE —
                linked contacts can only ever absorb, never be merged away. */}
            <button
              type="button"
              onClick={() => setShowMergePicker(true)}
              disabled={merging || archiving || saving}
              className="w-full mt-3 py-3 rounded-2xl bg-cream-soft border border-cream-hairline text-ink-700 text-[12.5px] font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <Merge size={13} strokeWidth={2.2} />
              {t('merge_button')}
            </button>
            <button
              type="button"
              onClick={handleArchive}
              disabled={archiving || saving}
              className="w-full mt-2 py-3 rounded-2xl bg-pay-50 text-pay-text text-[12.5px] font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <Trash2 size={13} strokeWidth={2.2} />
              {archiving ? 'Removing…' : 'Remove local contact'}
            </button>
            <p className="text-[10.5px] text-ink-400 mt-1.5 text-center leading-relaxed">
              Available after your balance with this contact is settled.
            </p>
          </div>
        )}
      </div>
    </Modal>
    <QuickEntry
      open={showMoneyEntry}
      preset={moneyPreset}
      onClose={() => {
        setShowMoneyEntry(false);
        setMoneyPreset(null);
      }}
    />
    <EditTransactionModal
      open={!!editingTransaction}
      transaction={editingTransaction}
      onClose={() => setEditingTransaction(null)}
    />
    <SendStatementModal
      open={showStatement}
      onClose={() => setShowStatement(false)}
      partyName={person.name}
      loans={personLoans}
      transactions={transactions}
      scope="contact"
      phone={person.phone}
    />
    {/* Scanner overlays the whole screen, so it lives outside the Modal's
        transformed container (a fixed child of a transformed ancestor is
        positioned against that ancestor, not the viewport). */}
    <QRScanner
      open={showScanner}
      onClose={() => setShowScanner(false)}
      onCode={(scanned) => {
        setShowScanner(false);
        setCode(formatConnectCode(scanned));
        setMode('entering');
        // Resolve straight away: the user pointed a camera at a specific
        // person's code — making them then press "Resolve" is a step with
        // no decision in it.
        void (async () => {
          setError('');
          setResolved(null);
          setResolving(true);
          try {
            const found = await resolveProfileByCode(scanned);
            if (!found) {
              setError(noPreviewMessage());
              return;
            }
            setResolved({ ...found, code: scanned });
            setMode('resolved');
          } catch {
            setError(t('addc_link_err_lookup'));
          } finally {
            setResolving(false);
          }
        })();
      }}
      onManualEntry={() => setMode('entering')}
    />
    {/* Merge target picker — sibling of the sheet (fixed overlays must not
        nest inside a transformed modal). */}
    <Modal open={showMergePicker} onClose={() => setShowMergePicker(false)} title={t('merge_pick_title')}>
      <div className="space-y-2">
        <p className="text-[12px] text-ink-500 leading-relaxed">
          {t('merge_pick_desc').replace('{source}', person.name)}
        </p>
        {(() => {
          // Cards are not people: legacy card-named person rows (pre-rebuild
          // cash advances) must never absorb a human's history. Exclude any
          // contact whose name matches an account.
          const accountNames = new Set(
            useAccountStore.getState().accounts.map((a) => a.name.trim().toLowerCase()),
          );
          const targets = persons.filter(
            (p) => p.id !== person.id && !accountNames.has(p.name.trim().toLowerCase()),
          );
          if (targets.length === 0) {
            return <p className="text-[12px] text-ink-400 px-1 py-3">{t('merge_pick_empty')}</p>;
          }
          return targets.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={merging}
              onClick={() => void handleMerge(p)}
              className="w-full text-left rounded-2xl bg-cream-soft border border-cream-hairline px-4 py-3 flex items-center gap-2.5 active:bg-cream-hairline transition-colors disabled:opacity-50"
            >
              <span className="w-8 h-8 rounded-xl bg-accent-100 text-accent-600 flex items-center justify-center text-[12px] font-bold shrink-0">
                {(p.name[0] ?? '?').toUpperCase()}
              </span>
              <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-ink-900">{p.name}</span>
              {isConsentVerifiedLink(contactLinks, myId, p.linkedProfileId) && (
                <VerifiedBadge size={14} title={t('contact_linked_pill')} />
              )}
            </button>
          ));
        })()}
      </div>
    </Modal>
    </>
  );
}
