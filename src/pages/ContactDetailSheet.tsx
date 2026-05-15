import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, History } from 'lucide-react';
import { Modal } from '../components/Modal';
import { usePersonStore, DuplicateLinkedContactError } from '../stores/personStore';
import { useLinkedRequestStore } from '../stores/linkedRequestStore';
import { useToast } from '../components/Toast';
import { resolveProfileByCode } from '../lib/collaboration';
import { formatMoney } from '../lib/constants';
import type { Person } from '../db';

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
  const { linkToProfile, unlinkFromProfile } = usePersonStore();
  const syncableBreakdownFor = useLinkedRequestStore((s) => s.syncableBreakdownFor);
  const syncPastRecords = useLinkedRequestStore((s) => s.syncPastRecords);
  // Subscribe to requests so the syncable count updates after a sync fires.
  const requests = useLinkedRequestStore((s) => s.requests);
  const toast = useToast();

  const [mode, setMode] = useState<Mode>('idle');
  const [code, setCode] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<{ profileId: string; displayName: string } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

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

  if (!person) return null;

  const isLinked = !!person.linkedProfileId;

  const handleSyncPastRecords = async () => {
    if (!person) return;
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
        setError('Another of your contacts is already linked to this user.');
      } else {
        setError('Could not link this contact. Try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleUnlink = async () => {
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

  return (
    <Modal open={open} onClose={onClose} title={person.name}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-accent-100 text-accent-600 flex items-center justify-center text-sm font-bold">
            {(person.name[0] ?? '?').toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-ink-900 truncate">{person.name}</p>
            <p className="text-[11px] text-ink-500">
              {isLinked ? 'Linked to a Hisaab user' : 'Not linked to a Hisaab user'}
            </p>
          </div>
          {isLinked && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-receive-text bg-receive-50 rounded-full px-2.5 py-1">
              Linked
            </span>
          )}
        </div>

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
              Linking is private &mdash; the other user is not notified.
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
                  Confirming will tag this contact with their account. No messages are sent.
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
      </div>
    </Modal>
  );
}
