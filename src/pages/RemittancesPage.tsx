import { useCallback, useMemo, useState } from 'react';
import { Plus, Send, CheckCircle2, ArrowRight } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageErrorState } from '../components/PageErrorState';
import { ListSkeleton } from '../components/ListSkeleton';
import { Modal } from '../components/Modal';
import { useRemittanceStore } from '../stores/remittanceStore';
import { useAccountStore } from '../stores/accountStore';
import { formatMoney } from '../lib/constants';
import { SUPPORTED_CURRENCIES, type Currency, type RemittanceChannel } from '../db';
import { useToast } from '../components/Toast';
import { useAsyncLoad } from '../hooks/useAsyncLoad';

const CHANNELS: { id: RemittanceChannel; label: string }[] = [
  { id: 'bank_transfer', label: 'Bank transfer' },
  { id: 'wise', label: 'Wise' },
  { id: 'remitly', label: 'Remitly' },
  { id: 'western_union', label: 'Western Union' },
  { id: 'hundi', label: 'Hundi' },
  { id: 'other', label: 'Other' },
];

export function RemittancesPage() {
  const remittances = useRemittanceStore((s) => s.remittances);
  const loadRemittances = useRemittanceStore((s) => s.loadRemittances);
  const markReceived = useRemittanceStore((s) => s.markReceived);
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const toast = useToast();
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    const tasks: Promise<unknown>[] = [loadRemittances()];
    if (accounts.length === 0) tasks.push(loadAccounts());
    await Promise.all(tasks);
  }, [loadRemittances, loadAccounts, accounts.length]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  // Quick aggregate strip: this month's total sent + avg effective rate.
  // Gives the user one number to brag/wince about per channel.
  const thisMonth = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const inMonth = remittances.filter((r) => new Date(r.sentAt).getTime() >= monthStart);
    return {
      count: inMonth.length,
      sumBySource: aggregateBy(inMonth, 'sourceCurrency', (r) => r.sourceAmount),
      avgRate:
        inMonth.length > 0
          ? inMonth.reduce((acc, r) => acc + r.effectiveRate, 0) / inMonth.length
          : 0,
    };
  }, [remittances]);

  const handleMarkReceived = async (id: string) => {
    try {
      await markReceived(id);
      toast.show({ type: 'success', title: 'Marked received' });
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not update',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    }
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-28">
      <PageHeader
        title="Remittances"
        back
        action={
          <button
            onClick={() => setShowAdd(true)}
            aria-label="Log a remittance"
            className="nav-icon-button"
          >
            <Plus size={16} className="text-ink-600" />
          </button>
        }
      />

      <div className="px-5 pt-5 space-y-3">
        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title="Couldn't load remittances"
            message={loadError ?? 'Some data failed to load.'}
            onRetry={retryLoad}
          />
        )}

        {loadStatus === 'loading' && remittances.length === 0 ? (
          <ListSkeleton rows={3} withAvatar={false} />
        ) : remittances.length === 0 ? (
          loadStatus === 'ready' ? (
            <EmptyState
              icon={Send}
              tone="accent"
              title="No remittances logged"
              description="Track money sent home with the channel, fee, and effective rate — so you can compare months."
              subhint="Pehli baar Wise use ki? Yahan log karo, dekho asli rate kya mila."
              actionLabel="Log a remittance"
              onAction={() => setShowAdd(true)}
            />
          ) : null
        ) : (
          <>
            {/* This-month strip */}
            <div className="rounded-2xl bg-navy-800 text-white px-4 py-3.5 bg-navy-bloom">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/55">
                This month
              </p>
              <div className="flex items-baseline justify-between mt-1">
                <p className="text-[20px] font-semibold tabular-nums">
                  {thisMonth.count} {thisMonth.count === 1 ? 'transfer' : 'transfers'}
                </p>
                {thisMonth.avgRate > 0 && (
                  <p className="text-[11px] text-white/70 tabular-nums">
                    avg rate {thisMonth.avgRate.toFixed(2)}
                  </p>
                )}
              </div>
              {thisMonth.sumBySource.length > 0 && (
                <p className="text-[11px] text-white/65 mt-1 tabular-nums">
                  {thisMonth.sumBySource
                    .map(([ccy, sum]) => `${formatMoney(sum, ccy)} sent`)
                    .join(' · ')}
                </p>
              )}
            </div>

            <div className="space-y-2.5">
              {remittances.map((r) => (
                <div
                  key={r.id}
                  className="rounded-2xl bg-cream-card border border-cream-border p-4"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[14px] font-semibold text-ink-900 tracking-tight truncate">
                      → {r.recipientName || 'Recipient'}
                    </p>
                    <p
                      className={`text-[10.5px] font-bold uppercase tracking-widest rounded-full px-2 py-0.5 ${
                        r.status === 'received'
                          ? 'bg-receive-50 text-receive-text'
                          : r.status === 'failed'
                            ? 'bg-pay-50 text-pay-text'
                            : 'bg-warn-50 text-warn-600'
                      }`}
                    >
                      {r.status}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 tabular-nums text-[12.5px] text-ink-700">
                    <span className="font-semibold text-ink-900">
                      {formatMoney(r.sourceAmount, r.sourceCurrency)}
                    </span>
                    <ArrowRight size={12} className="text-ink-400" />
                    <span className="font-semibold text-receive-text">
                      {formatMoney(r.destinationAmount, r.destinationCurrency)}
                    </span>
                  </div>
                  <p className="text-[11px] text-ink-500 mt-1 tabular-nums">
                    {channelLabel(r.channel)} · fee {formatMoney(r.feeAmount, r.feeCurrency)} ·
                    rate {r.effectiveRate.toFixed(2)}
                  </p>
                  <p className="text-[10.5px] text-ink-400 mt-1">
                    Sent {new Date(r.sentAt).toLocaleDateString()}
                    {r.receivedAt && ` · received ${new Date(r.receivedAt).toLocaleDateString()}`}
                  </p>
                  {r.status === 'pending' && (
                    <button
                      onClick={() => handleMarkReceived(r.id)}
                      className="mt-3 text-[11.5px] font-semibold text-receive-text bg-receive-50 rounded-lg px-2.5 py-1 inline-flex items-center gap-1 active:scale-95 transition-transform"
                    >
                      <CheckCircle2 size={11} /> Mark received
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <AddRemittanceModal open={showAdd} onClose={() => setShowAdd(false)} />
    </main>
  );
}

function aggregateBy<T, K extends string>(
  items: T[],
  keyField: keyof T,
  valueOf: (item: T) => number,
): [K, number][] {
  const map = new Map<K, number>();
  for (const item of items) {
    const k = item[keyField] as unknown as K;
    map.set(k, (map.get(k) ?? 0) + valueOf(item));
  }
  return [...map.entries()];
}

function channelLabel(c: RemittanceChannel): string {
  return CHANNELS.find((x) => x.id === c)?.label ?? c;
}

interface AddRemittanceModalProps {
  open: boolean;
  onClose: () => void;
}

function AddRemittanceModal({ open, onClose }: AddRemittanceModalProps) {
  const createRemittance = useRemittanceStore((s) => s.createRemittance);
  const accounts = useAccountStore((s) => s.accounts);
  const toast = useToast();
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [destinationAccountId, setDestinationAccountId] = useState('');
  const [sourceAmount, setSourceAmount] = useState('');
  const [destinationAmount, setDestinationAmount] = useState('');
  const [destinationCurrency, setDestinationCurrency] = useState<Currency>('PKR');
  const [channel, setChannel] = useState<RemittanceChannel>('wise');
  const [feeAmount, setFeeAmount] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [notes, setNotes] = useState('');
  const [sentAt, setSentAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [saving, setSaving] = useState(false);

  const sourceAccount = accounts.find((a) => a.id === sourceAccountId) ?? null;
  const sourceCurrency = sourceAccount?.currency ?? 'AED';

  // Live preview of the effective rate so the user can see what they actually
  // got. Recomputed on every keystroke; cheap arithmetic.
  const previewRate = useMemo(() => {
    const src = Number(sourceAmount);
    const dst = Number(destinationAmount);
    const fee = Number(feeAmount) || 0;
    if (!Number.isFinite(src) || !Number.isFinite(dst) || src <= 0 || dst <= 0) return null;
    const netSrc = Math.max(src - fee, 0.0001);
    return dst / netSrc;
  }, [sourceAmount, destinationAmount, feeAmount]);

  const handleSave = async () => {
    const srcN = Number(sourceAmount);
    const dstN = Number(destinationAmount);
    if (!sourceAccountId) {
      toast.show({ type: 'error', title: 'Pick a source account' });
      return;
    }
    if (!Number.isFinite(srcN) || srcN <= 0 || !Number.isFinite(dstN) || dstN <= 0) {
      toast.show({ type: 'error', title: 'Enter valid amounts' });
      return;
    }
    setSaving(true);
    try {
      await createRemittance({
        sourceAccountId,
        sourceCurrency,
        sourceAmount: srcN,
        destinationAccountId: destinationAccountId || null,
        destinationCurrency,
        destinationAmount: dstN,
        channel,
        feeAmount: Number(feeAmount) || 0,
        feeCurrency: sourceCurrency,
        recipientName: recipientName.trim(),
        notes: notes.trim(),
        sentAt: new Date(sentAt).toISOString(),
      });
      toast.show({ type: 'success', title: 'Remittance logged' });
      onClose();
      setSourceAccountId('');
      setSourceAmount('');
      setDestinationAmount('');
      setFeeAmount('');
      setRecipientName('');
      setNotes('');
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not log',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    } finally {
      setSaving(false);
    }
  };

  const destinationAccountChoices = accounts.filter((a) => a.currency === destinationCurrency);

  return (
    <Modal open={open} onClose={onClose} title="Log remittance">
      <div className="space-y-4">
        <div>
          <label className="form-label">From account</label>
          <select
            value={sourceAccountId}
            onChange={(e) => setSourceAccountId(e.target.value)}
            className="input-field"
          >
            <option value="">Pick an account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="form-label">Sent ({sourceCurrency})</label>
            <input
              type="number"
              inputMode="decimal"
              value={sourceAmount}
              onChange={(e) => setSourceAmount(e.target.value)}
              placeholder="0"
              className="input-field tabular-nums"
            />
          </div>
          <div>
            <label className="form-label">Fee ({sourceCurrency})</label>
            <input
              type="number"
              inputMode="decimal"
              value={feeAmount}
              onChange={(e) => setFeeAmount(e.target.value)}
              placeholder="0"
              className="input-field tabular-nums"
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="form-label">Currency</label>
            <select
              value={destinationCurrency}
              onChange={(e) => setDestinationCurrency(e.target.value as Currency)}
              className="input-field"
            >
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="form-label">Received ({destinationCurrency})</label>
            <input
              type="number"
              inputMode="decimal"
              value={destinationAmount}
              onChange={(e) => setDestinationAmount(e.target.value)}
              placeholder="0"
              className="input-field tabular-nums"
            />
          </div>
        </div>

        {previewRate != null && (
          <div className="rounded-xl bg-receive-50 px-3 py-2 text-[11.5px] text-receive-text">
            Effective rate:{' '}
            <span className="font-bold tabular-nums">{previewRate.toFixed(2)}</span>{' '}
            {destinationCurrency} per 1 {sourceCurrency} (after fees)
          </div>
        )}

        <div>
          <label className="form-label">Destination account (optional)</label>
          <select
            value={destinationAccountId}
            onChange={(e) => setDestinationAccountId(e.target.value)}
            className="input-field"
          >
            <option value="">Not linked (cash pickup, etc.)</option>
            {destinationAccountChoices.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <p className="text-[10.5px] text-ink-500 mt-1.5">
            Link a {destinationCurrency} account here to auto-credit when you mark received.
          </p>
        </div>

        <div>
          <label className="form-label">Channel</label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as RemittanceChannel)}
            className="input-field"
          >
            {CHANNELS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="form-label">Recipient name</label>
          <input
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            placeholder="e.g. Ammi, Bhai, Family account"
            className="input-field"
          />
        </div>

        <div>
          <label className="form-label">Notes (optional)</label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. for school fees"
            className="input-field"
          />
        </div>

        <div>
          <label className="form-label">Sent at</label>
          <input
            type="datetime-local"
            value={sentAt}
            onChange={(e) => setSentAt(e.target.value)}
            className="input-field"
          />
        </div>

        <button onClick={handleSave} disabled={saving} className="cta-primary">
          {saving ? 'Saving…' : 'Log remittance'}
        </button>
      </div>
    </Modal>
  );
}
