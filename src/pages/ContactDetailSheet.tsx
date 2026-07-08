import { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, HandCoins, Handshake, RefreshCw, History, ShieldCheck, Trash2, MessageCircle, Check, X, FileText } from 'lucide-react';
import { Modal } from '../components/Modal';
import { usePersonStore, DuplicateLinkedContactError } from '../stores/personStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useLoanStore } from '../stores/loanStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useToast } from '../components/Toast';
import { resolveProfileByCode } from '../lib/collaboration';
import { buildWhatsAppUrl, hasWhatsAppNumber } from '../lib/whatsappReminder';
import { formatMoney } from '../lib/constants';
import { computeTrustScore, trustLevelStyle } from '../lib/trustScore';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
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
  const { linkToProfile, unlinkFromProfile, archiveIfSettled, updatePhone } = usePersonStore();
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
  const [resolved, setResolved] = useState<{ profileId: string; displayName: string } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [showMoneyEntry, setShowMoneyEntry] = useState(false);
  const [moneyPreset, setMoneyPreset] = useState<QuickEntryPreset | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState('');
  const [savingPhone, setSavingPhone] = useState(false);
  const [showStatement, setShowStatement] = useState(false);

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
    }
  }, [open]);

  // Compute the syncable / skipped split here so the card can show an
  // honest per-currency preview and surface the count of loans that
  // can't sync yet (currencies outside what linked_transaction_requests
  // accepts). Re-runs when requests change so the card hides itself
  // after a successful sync without needing manual refresh.
  const { syncable, skipped } = useMemo(
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
  // Same bucketing for the skipped list so the warning chip can list
  // "1 SAR · 2 OMR" rather than a generic count.
  const skippedCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const loan of skipped) set.add(loan.currency);
    return [...set].sort();
  }, [skipped]);

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

  const handleSyncPastRecords = async () => {
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

  const handleResolve = async () => {
    setError('');
    setResolved(null);
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter a user code to continue.');
      return;
    }
    setResolving(true);
    try {
      const found = await resolveProfileByCode(trimmed);
      if (!found) {
        setError('No user with this code.');
        return;
      }
      setResolved(found);
      setMode('resolved');
    } catch {
      setError('Could not look up this code. Try again.');
    } finally {
      setResolving(false);
    }
  };

  const handleConfirmLink = async () => {
    if (!resolved) return;
    setSaving(true);
    setError('');
    try {
      await linkToProfile(person.id, resolved.profileId);
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
        setError('Could not link this contact. Try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUnlink = async () => {
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
    } catch {
      setError('Could not unlink this contact. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
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

  return (
    <>
    <Modal open={open} onClose={onClose} title={person.name}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-accent-100 text-accent-600 flex items-center justify-center text-sm font-bold">
            {(person.name[0] ?? '?').toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-ink-900 truncate">{person.name}</p>
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
            className="w-full py-3 rounded-2xl bg-accent-100 text-accent-600 text-[13px] font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
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
                <button type="button" disabled={savingPhone} onClick={() => void savePhone()} className="text-receive-600 active:scale-90 disabled:opacity-40" aria-label={t('cat_save')}><Check size={16} strokeWidth={2.8} /></button>
                <button type="button" onClick={() => setEditingPhone(false)} className="text-ink-400 active:scale-90" aria-label={t('cancel')}><X size={16} /></button>
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-semibold text-ink-900">{t('contact_whatsapp')}</p>
                  <p className="text-[11px] text-ink-500 truncate">{person.phone || t('contact_whatsapp_none')}</p>
                </div>
                {hasWhatsAppNumber(person.phone) && (
                  <a href={buildWhatsAppUrl(person.phone, '')} target="_blank" rel="noopener noreferrer" className="shrink-0 active:scale-90" style={{ color: '#1FA855' }} aria-label="WhatsApp">
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
                className="rounded-xl bg-cream-card border border-cream-border px-3 py-3 text-left active:scale-[0.98] transition-transform"
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
                  className="mt-3 w-full py-2.5 rounded-xl bg-ink-900 text-white text-[12.5px] font-semibold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform disabled:opacity-50"
                >
                  <RefreshCw size={12} strokeWidth={2.4} />
                  {syncing
                    ? 'Sending…'
                    : `Sync ${syncable.length === 1 ? 'this record' : `${syncable.length} records`}`}
                </button>
                {skipped.length > 0 && (
                  <p className="text-[10.5px] text-ink-500 mt-2 leading-relaxed pl-1">
                    {skipped.length}{' '}
                    {skipped.length === 1 ? 'loan' : 'loans'} in{' '}
                    {skippedCurrencies.join(', ')}{' '}
                    {skipped.length === 1 ? "can't" : "can't"} be synced yet — linked records support AED &amp; PKR only.
                  </p>
                )}
              </div>
            )}

            {/* Edge case: every loan with this person is in an unsupported
                currency. The "sync" card is hidden because syncable is
                empty, but the user should still know why. */}
            {syncable.length === 0 && skipped.length > 0 && (
              <div className="rounded-2xl bg-warn-50 border border-cream-border p-3 flex items-start gap-2.5">
                <History size={14} className="text-warn-600 mt-0.5 shrink-0" />
                <p className="text-[11px] text-ink-700 leading-relaxed">
                  {skipped.length}{' '}
                  past {skipped.length === 1 ? 'record' : 'records'} with{' '}
                  {person.name} in {skippedCurrencies.join(', ')} can't be
                  synced — linked records support AED &amp; PKR only for now.
                </p>
              </div>
            )}

            <p className="text-[11px] text-ink-500 leading-relaxed">
              You're connected both ways &mdash; {person.name} was notified and you
              appear in each other's contacts. Loans and splits you record can be shared.
            </p>
            <button
              onClick={handleUnlink}
              disabled={saving}
              className="cta-destructive"
            >
              {saving ? 'Working…' : 'Unlink'}
            </button>
          </div>
        ) : mode === 'idle' ? (
          <button
            onClick={() => setMode('entering')}
            className="w-full py-3 rounded-2xl bg-ink-900 text-white text-[13px] font-bold shadow-md shadow-indigo-500/20"
          >
            Link to Hisaab user
          </button>
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
                Ask them to copy their code from Settings &rarr; My Account.
              </p>
            </div>

            {mode === 'resolved' && resolved ? (
              <div className="rounded-2xl border border-receive-100/70 bg-receive-50/60 p-3">
                <p className="text-[11px] font-bold text-receive-text uppercase tracking-widest">Found</p>
                <p className="text-[14px] font-semibold text-ink-900 mt-0.5">{resolved.displayName}</p>
                <p className="text-[11px] text-ink-500 mt-1">
                  Confirming connects you both &mdash; {resolved.displayName} gets a notification
                  and you'll appear in each other's contacts.
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
            <button
              type="button"
              onClick={handleArchive}
              disabled={archiving || saving}
              className="w-full mt-3 py-3 rounded-2xl bg-pay-50 text-pay-text text-[12.5px] font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
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
    </>
  );
}
