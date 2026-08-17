import { useMemo, useState } from 'react';
import { X, Users, Wallet } from 'lucide-react';
import { Modal } from './Modal';
import { ContactPicker, type ContactValue } from './ContactPicker';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { computeShares, type ShareMethod } from '../lib/splitMath';
import { SHARE_ERROR_KEYS } from '../lib/shareErrors';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { SplitDirection } from '../lib/splitEvent';
import type { Currency } from '../db';

// The current user's slot in the share calculation. Not a Person row — "me" is
// never a contact — so it gets a reserved key the participant list understands.
export const ME = '__me__';

export interface SplitPlanParticipant {
  personId: string;
  personName: string;
  amount: number;
}

// What the sheet hands back. Amounts are already resolved to the cent, so the
// caller just executes — no re-deriving share math at submit time.
export interface SplitPlan {
  direction: SplitDirection;
  method: ShareMethod;
  myShare: number;
  /** i_paid: who owes me what. they_paid: empty — their debts aren't mine. */
  others: SplitPlanParticipant[];
  payer: { personId: string; personName: string } | null;
  partyCount: number;
}

interface Row {
  key: string;
  personId: string | null;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  total: number;
  currency: Currency;
  /** Reopening with an existing plan restores it for editing. */
  initial?: SplitPlan | null;
  onApply: (plan: SplitPlan | null) => void;
}

// Remounted on every open (see the `key` below) so the form seeds itself from
// `initial` through useState initialisers. No state-syncing effect to keep in
// step, and no chance of a stale participant list surviving a close/reopen.
export function SplitWithSheet(props: Props) {
  return <SplitWithSheetForm key={props.open ? 'open' : 'closed'} {...props} />;
}

function seedRows(initial: SplitPlan | null | undefined): Row[] {
  if (!initial) return [];
  const fromOthers = initial.others.map((o) => ({ key: o.personId, personId: o.personId, name: o.personName }));
  // they_paid keeps no `others` (their debts aren't ours to track), so the
  // payer is the only participant to restore.
  if (initial.direction === 'they_paid' && initial.payer) {
    return [
      { key: initial.payer.personId, personId: initial.payer.personId, name: initial.payer.personName },
      ...fromOthers,
    ];
  }
  return fromOthers;
}

function SplitWithSheetForm({ open, onClose, total, currency, initial, onApply }: Props) {
  const t = useT();
  const guardClose = useDiscardGuard();

  const [direction, setDirection] = useState<SplitDirection>(initial?.direction ?? 'i_paid');
  const [rows, setRows] = useState<Row[]>(() => seedRows(initial));
  const [method, setMethod] = useState<ShareMethod>(initial?.method ?? 'equal');
  const [exact, setExact] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>({});
  const [payerKey, setPayerKey] = useState<string>(initial?.payer?.personId ?? '');
  const [picker, setPicker] = useState<ContactValue>({ id: null, name: '' });
  const [error, setError] = useState('');

  // Me first so the "last participant absorbs the rounding remainder" rule in
  // splitMath never quietly hands the user's own share the odd cent — it lands
  // on the last person added, which is at least consistent and visible.
  const participantKeys = useMemo(() => [ME, ...rows.map((r) => r.key)], [rows]);
  const nameFor = (key: string) => (key === ME ? t('split_you') : rows.find((r) => r.key === key)?.name ?? '');

  const result = useMemo(
    () => computeShares({ amount: total, participantIds: participantKeys, method, exact, percentages, shares }),
    [total, participantKeys, method, exact, percentages, shares],
  );

  const shareFor = (key: string) => result.splits.find((s) => s.memberId === key)?.amount ?? 0;
  const myShare = shareFor(ME);
  const owedToMe = useMemo(
    () => Math.round(result.splits.filter((s) => s.memberId !== ME).reduce((sum, s) => sum + s.amount, 0) * 100) / 100,
    [result.splits],
  );

  const isDirty = rows.length > 0 || method !== 'equal';
  const needsPayer = direction === 'they_paid';

  const addRow = (value: ContactValue) => {
    const name = value.name.trim();
    if (!name) return;
    // A person can only appear once — a duplicate row would silently double
    // their share and create two loans against the same contact.
    const already = rows.some((r) =>
      value.id ? r.personId === value.id : r.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (already) {
      setError(t('split_already_added').replace('{name}', name));
      setPicker({ id: null, name: '' });
      return;
    }
    setError('');
    setRows((prev) => [...prev, { key: value.id ?? `new:${name.toLocaleLowerCase()}`, personId: value.id, name }]);
    setPicker({ id: null, name: '' });
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    if (payerKey === key) setPayerKey('');
    setError('');
  };

  const handleApply = () => {
    if (rows.length === 0) {
      setError(t('val_pick_member'));
      return;
    }
    if (!result.valid) {
      setError(t(SHARE_ERROR_KEYS[result.error!]));
      return;
    }
    if (needsPayer && !payerKey) {
      setError(t('split_need_payer'));
      return;
    }

    // Rows carry a null personId until the parent resolves typed names through
    // findOrCreateByName at save time. `personId` here is a placeholder key;
    // the caller replaces it with the real Person id.
    const payerRow = rows.find((r) => r.key === payerKey) ?? null;
    onApply({
      direction,
      method,
      myShare,
      others: direction === 'i_paid'
        ? rows.map((r) => ({ personId: r.personId ?? r.key, personName: r.name, amount: shareFor(r.key) }))
        : [],
      payer: payerRow ? { personId: payerRow.personId ?? payerRow.key, personName: payerRow.name } : null,
      partyCount: participantKeys.length,
    });
    onClose();
  };

  const clearSplit = () => {
    onApply(null);
    onClose();
  };

  const inputClass = 'w-full border border-cream-border rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-accent-500 bg-cream-card transition-all';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('split_with_title')}
      confirmClose={() => guardClose(isDirty)}
      footer={
        <div className="space-y-2.5">
          {error && (
            <p role="alert" className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-xl px-3 py-2 leading-snug">
              {error}
            </p>
          )}
          <button onClick={handleApply} disabled={rows.length === 0} className="cta-primary">
            {t('split_apply')}
          </button>
          {initial && (
            <button onClick={clearSplit} className="w-full text-[12px] font-semibold text-ink-500 py-2">
              {t('split_remove')}
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-5 p-5">
        <div>
          <label className="form-label">{t('split_who_paid')}</label>
          <div className="flex gap-2.5 mt-1.5">
            {(['i_paid', 'they_paid'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => { setDirection(d); setError(''); }}
                className={`flex-1 py-3 rounded-2xl text-[13px] font-bold border-2 transition-all active:scale-[0.97] ${
                  direction === d
                    ? 'bg-ink-900 text-white border-transparent shadow-md'
                    : 'bg-cream-card text-ink-500 border-cream-border'
                }`}
              >
                {d === 'i_paid' ? t('split_i_paid') : t('split_they_paid')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="form-label">{t('split_between')}</label>
          <div className="flex flex-wrap gap-2 mt-1.5 mb-2.5">
            <span className="inline-flex items-center px-3.5 py-2 rounded-xl text-[12px] font-semibold bg-accent-100 text-accent-600">
              {t('split_you')}
            </span>
            {rows.map((r) => (
              <span key={r.key} className="inline-flex items-center gap-1.5 pl-3.5 pr-2 py-2 rounded-xl text-[12px] font-semibold bg-cream-soft text-ink-700 border border-cream-border">
                {r.name}
                <button
                  type="button"
                  onClick={() => removeRow(r.key)}
                  aria-label={t('split_remove_person').replace('{name}', r.name)}
                  className="w-5 h-5 rounded-full flex items-center justify-center text-ink-400 active:bg-cream-border transition-colors"
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
          <ContactPicker
            value={picker}
            onChange={(next) => {
              setPicker(next);
              // Selecting a saved contact commits immediately; typed names wait
              // for the explicit Add so a half-typed name isn't captured.
              if (next.id) addRow(next);
            }}
            placeholder={t('split_add_placeholder')}
            className={inputClass}
          />
          {picker.name.trim() && !picker.id && (
            <button
              type="button"
              onClick={() => addRow(picker)}
              className="mt-2 w-full py-2.5 rounded-xl text-[12px] font-bold text-accent-600 bg-accent-50 border border-accent-100 active:scale-[0.98] transition-transform"
            >
              {t('split_add_named').replace('{name}', picker.name.trim())}
            </button>
          )}
        </div>

        {needsPayer && rows.length > 0 && (
          <div>
            <label className="form-label">{t('split_payer_label')}</label>
            <div className="flex flex-wrap gap-2 mt-1.5">
              {rows.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => { setPayerKey(r.key); setError(''); }}
                  className={`min-h-[44px] inline-flex items-center px-3.5 py-2 rounded-xl text-[12px] font-semibold transition-all ${
                    payerKey === r.key ? 'bg-ink-900 text-white' : 'bg-cream-soft text-ink-700'
                  }`}
                >
                  {r.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="form-label">{t('group_split_type')}</label>
          <div className="grid grid-cols-4 gap-1.5 mt-1.5">
            {(['equal', 'exact', 'percentage', 'shares'] as ShareMethod[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMethod(m); setError(''); }}
                className={`min-h-[44px] inline-flex items-center justify-center py-2 rounded-xl text-[11px] font-bold transition-all ${
                  method === m ? 'bg-ink-900 text-white' : 'bg-cream-soft text-ink-500'
                }`}
              >
                {m === 'equal' ? t('group_split_equal') : m === 'exact' ? t('group_split_exact') : m === 'percentage' ? t('group_split_pct') : t('group_split_shares')}
              </button>
            ))}
          </div>
        </div>

        {method !== 'equal' && rows.length > 0 && (
          <div className="space-y-2">
            {participantKeys.map((key) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-[12px] text-ink-700 font-medium w-20 truncate">{nameFor(key)}</span>
                <input
                  className="flex-1 min-h-[44px] border border-cream-border rounded-xl px-3 py-2 text-sm bg-cream-card"
                  type="number"
                  inputMode="decimal"
                  placeholder={method === 'shares' ? '1' : method === 'percentage' ? '%' : '0'}
                  value={
                    method === 'exact' ? exact[key] ?? ''
                      : method === 'percentage' ? percentages[key] ?? ''
                      : shares[key] ?? '1'
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (method === 'exact') setExact((p) => ({ ...p, [key]: v }));
                    else if (method === 'percentage') setPercentages((p) => ({ ...p, [key]: v }));
                    else setShares((p) => ({ ...p, [key]: v }));
                    setError('');
                  }}
                />
                <span className="text-[11px] text-ink-500 w-8 shrink-0">
                  {method === 'percentage' ? '%' : method === 'shares' ? '×' : currency}
                </span>
              </div>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="rounded-2xl border border-cream-border bg-cream-soft/70 p-3.5 space-y-2">
            {participantKeys.map((key) => (
              <div key={key} className="flex items-center justify-between">
                <span className={`text-[12px] ${key === ME ? 'font-bold text-ink-900' : 'font-medium text-ink-700'}`}>
                  {nameFor(key)}
                </span>
                <span className="text-[12px] font-semibold tabular-nums text-ink-900">
                  {formatMoney(shareFor(key), currency)}
                </span>
              </div>
            ))}
            <div className="pt-2 border-t border-cream-border flex items-start gap-2">
              {direction === 'i_paid' ? <Wallet size={13} className="text-accent-600 shrink-0 mt-0.5" /> : <Users size={13} className="text-accent-600 shrink-0 mt-0.5" />}
              <p className="text-[11px] font-semibold text-accent-600 leading-snug">
                {direction === 'i_paid'
                  ? t('split_summary_i_paid')
                      .replace('{total}', formatMoney(total, currency))
                      .replace('{mine}', formatMoney(myShare, currency))
                      .replace('{owed}', formatMoney(owedToMe, currency))
                  : t('split_summary_they_paid')
                      .replace('{name}', nameFor(payerKey) || t('loan_they'))
                      .replace('{mine}', formatMoney(myShare, currency))}
              </p>
            </div>
          </div>
        )}

        <p className="text-[11px] text-ink-500 bg-cream-soft/80 border border-cream-hairline rounded-2xl p-3 leading-relaxed">
          {t('split_no_group_hint')}
        </p>
      </div>
    </Modal>
  );
}
