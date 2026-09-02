import { useState } from 'react';
import { Handshake, CheckCircle2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { formatMoney } from '../lib/constants';
import type { SplitGroup } from '../db';
import { friendlyGroupParticipantError, validateNewSettlementParticipants } from '../lib/groupActiveMembers';

interface Debt { from: string; fromName: string; to: string; toName: string; amount: number; }
interface Props {
  open: boolean;
  group: SplitGroup;
  debts: Debt[];
  // The current user's member id in this group, so we can render "You" in
  // place of their name and float their own debts to the top.
  currentMemberId?: string;
  onClose: () => void;
}

export function SettleUpModal({ open, group, debts, currentMemberId, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { addSettlement } = useSplitStore();
  const submitGuard = useSubmitGuard();
  const [selectedDebt, setSelectedDebt] = useState<Debt | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Settle the full outstanding amount (default) or a partial slice.
  const [mode, setMode] = useState<'full' | 'partial'>('full');
  const activeDebts = debts
    .filter((debt) => validateNewSettlementParticipants(group, debt.from, debt.to) === null)
    // Rows involving "You" come first — that's what the user is most likely
    // here to do. Stable within each bucket otherwise.
    .map((debt, originalIndex) => ({ debt, originalIndex }))
    .sort((a, b) => {
      const aMe = a.debt.from === currentMemberId || a.debt.to === currentMemberId;
      const bMe = b.debt.from === currentMemberId || b.debt.to === currentMemberId;
      if (aMe === bMe) return a.originalIndex - b.originalIndex;
      return aMe ? -1 : 1;
    })
    .map((entry) => entry.debt);

  // Render the current user as a bold accent "You"; everyone else keeps their
  // name. Returned as a node so the "You" can carry weight + colour.
  const renderParty = (memberId: string, name: string) =>
    memberId === currentMemberId ? (
      <span className="font-bold text-accent-600">{t('label_you')}</span>
    ) : (
      <span>{name}</span>
    );

  // Same as renderParty but for the accent-tinted summary card, where the
  // surrounding text is already accent-600 — "You" gets underline + heavier
  // weight so it still reads as emphasised.
  const renderPartyOnNavy = (memberId: string, name: string) =>
    memberId === currentMemberId ? (
      <span className="font-extrabold underline decoration-2 underline-offset-2">{t('label_you')}</span>
    ) : (
      <span>{name}</span>
    );

  // Directional subtitle from the current user's point of view. "You pay {name}"
  // when the user is the debtor, "{name} pays you" when they're the creditor,
  // and a neutral "{from} pays {to}" for debts between two other members.
  const directionalSubtitle = (debt: Debt): string => {
    if (debt.from === currentMemberId) return t('settle_you_pay').replace('{name}', debt.toName);
    if (debt.to === currentMemberId) return t('settle_pays_you').replace('{name}', debt.fromName);
    return t('settle_pays').replace('{from}', debt.fromName).replace('{to}', debt.toName);
  };

  // Ref-backed entry re-check: two taps in one frame both see `saving ===
  // false` (state is async) and would record the same settlement twice, which
  // the client-side cap check cannot catch. `saving` stays for the UI.
  const handleSettle = () => submitGuard.run(runSettle);

  const runSettle = async () => {
    if (!selectedDebt) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError(t('sum_err_amount_zero'));
      return;
    }
    if (amt > selectedDebt.amount + 0.00001) {
      setError(t('sum_err_amount_max').replace('{amount}', formatMoney(selectedDebt.amount, group.currency)));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await addSettlement({ groupId: group.id, fromMember: selectedDebt.from, toMember: selectedDebt.to, amount: amt, note });
      toast.show({
        type: 'success',
        title: t('sum_saved_title'),
        subtitle: t('sum_saved_sub')
          .replace('{from}', selectedDebt.fromName)
          .replace('{to}', selectedDebt.toName)
          .replace('{amount}', formatMoney(amt, group.currency)),
      });
      setSelectedDebt(null); setAmount(''); setNote('');
      onClose();
    } catch (error) {
      const message = friendlyGroupParticipantError(error) || (error instanceof Error ? error.message : t('error'));
      setError(message);
      toast.show({ type: 'error', title: t('sum_not_saved'), subtitle: message });
    }
    finally { setSaving(false); }
  };

  const inputClass = "w-full border border-cream-border rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-accent-500 bg-cream-card transition-all";

  // Live "remaining after this" figure for the amount step.
  const enteredAmount = Number(amount);
  const hasValidAmount = Number.isFinite(enteredAmount) && enteredAmount > 0;
  const remainingAfter = selectedDebt && hasValidAmount
    ? Math.round((selectedDebt.amount - enteredAmount) * 100) / 100
    : selectedDebt?.amount ?? 0;
  const fullySettled = selectedDebt ? remainingAfter <= 0.005 : false;
  // Disable-until-valid: a positive amount that doesn't exceed what's owed.
  const canSettle = hasValidAmount && !!selectedDebt && enteredAmount - selectedDebt.amount <= 0.005;

  const selectDebt = (d: Debt) => {
    setSelectedDebt(d);
    setAmount(d.amount.toString());
    setMode('full');
    setError('');
  };

  const chooseFull = () => {
    if (!selectedDebt) return;
    setMode('full');
    setAmount(selectedDebt.amount.toString());
    setError('');
  };

  const choosePartial = () => {
    setMode('partial');
    setAmount('');
    setError('');
  };

  return (
    <Modal open={open} onClose={onClose} title={t('group_settle_title')} footer={
      selectedDebt ? (
        <button onClick={handleSettle} disabled={saving || !canSettle}
          className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20">
          {saving ? t('quick_processing') : t('group_settle_save')}
        </button>
      ) : activeDebts.length === 0 ? (
        <button onClick={onClose}
          className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold shadow-md shadow-indigo-500/20">
          {t('settle_done')}
        </button>
      ) : undefined
    }>
      <div className="p-5 space-y-4">
        {!selectedDebt ? (
          activeDebts.length === 0 ? (
            // Calm "all square" empty state — reassuring, not a dead-end line.
            <div className="text-center py-6">
              <div className="mx-auto w-14 h-14 rounded-3xl bg-receive-50 text-receive-text flex items-center justify-center">
                <Handshake size={26} strokeWidth={1.8} />
              </div>
              <p className="text-[15px] font-bold text-ink-900 tracking-tight mt-4">{t('settle_all_square')}</p>
              <p className="text-[12px] text-ink-500 mt-1.5 leading-relaxed max-w-[260px] mx-auto">
                {t('settle_all_square_sub')}
              </p>
            </div>
          ) : (
            activeDebts.map((d, i) => {
              const involvesMe = d.from === currentMemberId || d.to === currentMemberId;
              return (
                <button key={i} onClick={() => selectDebt(d)}
                  className={`w-full rounded-2xl border p-4 flex items-center justify-between gap-3 text-left active:scale-[0.98] transition-all min-h-[44px] ${
                    involvesMe ? 'bg-accent-50 border-accent-100' : 'bg-cream-card border-cream-border'
                  }`}>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-ink-800 flex items-center gap-1 flex-wrap">
                      {renderParty(d.from, d.fromName)}
                      <span className="text-ink-400">&rarr;</span>
                      {renderParty(d.to, d.toName)}
                    </p>
                    <p className="text-[10.5px] text-ink-500 mt-0.5">{directionalSubtitle(d)}</p>
                  </div>
                  <p className="text-[14px] font-bold text-ink-900 tabular-nums shrink-0">{formatMoney(d.amount, group.currency)}</p>
                </button>
              );
            })
          )
        ) : (
          <>
            <div className="bg-accent-100 rounded-2xl p-4 text-center">
              <p className="text-[12px] text-accent-600 font-semibold flex items-center justify-center gap-1.5 flex-wrap">
                {renderPartyOnNavy(selectedDebt.from, selectedDebt.fromName)}
                <span className="opacity-60">&rarr;</span>
                {renderPartyOnNavy(selectedDebt.to, selectedDebt.toName)}
              </p>
              <p className="text-[11px] text-accent-600/80 mt-0.5">{directionalSubtitle(selectedDebt)}</p>
              <p className="text-xl font-bold text-accent-600 mt-1.5">{formatMoney(selectedDebt.amount, group.currency)}</p>
            </div>

            {/* Full / Partial selector. Full is the default and prefills the
                whole outstanding amount; Partial clears it for a custom slice. */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={chooseFull}
                className={`min-h-[44px] rounded-2xl px-3 py-2.5 text-[12.5px] font-semibold border transition-all active:scale-[0.98] ${
                  mode === 'full'
                    ? 'bg-accent-600 text-white border-accent-600'
                    : 'bg-cream-card text-ink-700 border-cream-border'
                }`}
              >
                {t('settle_full').replace('{amount}', formatMoney(selectedDebt.amount, group.currency))}
              </button>
              <button
                type="button"
                onClick={choosePartial}
                className={`min-h-[44px] rounded-2xl px-3 py-2.5 text-[12.5px] font-semibold border transition-all active:scale-[0.98] ${
                  mode === 'partial'
                    ? 'bg-accent-600 text-white border-accent-600'
                    : 'bg-cream-card text-ink-700 border-cream-border'
                }`}
              >
                {t('settle_partial')}
              </button>
            </div>

            <div>
              <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_settle_amount')}</label>
              <input
                className={inputClass + ' mt-1.5 text-lg font-bold'}
                type="number"
                inputMode="decimal"
                value={amount}
                onChange={e => { setAmount(e.target.value); if (mode !== 'partial') setMode('partial'); }}
              />
              {/* Live remaining hint — neutral ink while a balance is left,
                  receive-text once this settlement clears it. */}
              {hasValidAmount && (
                fullySettled ? (
                  <p className="text-[11px] font-semibold text-receive-text mt-1.5 flex items-center gap-1">
                    <CheckCircle2 size={12} />
                    {t('settle_fully_settled')}
                  </p>
                ) : (
                  <p className="text-[11px] text-ink-500 mt-1.5">
                    {t('settle_remaining').replace('{amount}', '')}<span className="font-semibold tabular-nums text-ink-700">{formatMoney(Math.max(0, remainingAfter), group.currency)}</span>
                  </p>
                )
              )}
            </div>
            {error && (
              <p role="alert" className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-xl px-3 py-2">
                {error}
              </p>
            )}
            <div>
              <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_settle_note')}</label>
              <input className={inputClass + ' mt-1.5'} value={note} onChange={e => setNote(e.target.value)} placeholder={t('sum_note_placeholder')} />
            </div>
            <button onClick={() => { setSelectedDebt(null); setError(''); }} className="text-[12px] text-ink-500 font-medium underline min-h-[44px]">
              {t('common_back_arrow')}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
