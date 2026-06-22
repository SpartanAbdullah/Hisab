import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useAccountStore } from '../stores/accountStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { formatMoney, formatSignedMoney } from '../lib/constants';
import type { SplitGroup, SplitType, SplitDetail } from '../db';
import {
  friendlyGroupParticipantError,
  getActiveGroupMembers,
  getInactiveGroupMembers,
  NEED_TWO_ACTIVE_MEMBERS_MESSAGE,
} from '../lib/groupActiveMembers';
import { findRecentDuplicate } from '../lib/duplicateExpense';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';

interface Props {
  open: boolean;
  group: SplitGroup;
  onClose: () => void;
  // When opened via the QuickEntry "Group expense" flow we already know
  // the amount the user typed on the numpad. Pre-fill it so they don't
  // re-enter; null/undefined keeps the existing "empty form" behaviour
  // for the GroupDetailPage entry point.
  prefillAmount?: string;
  // Recent group expenses (passed by GroupDetailPage) used to warn on a likely
  // duplicate — e.g. both flatmates logging the same rent. Omitted on the
  // QuickEntry handoff path, where the check simply doesn't run.
  recentExpenses?: ReadonlyArray<{ id: string; description: string; amount: number; createdAt: string }>;
}

const CATEGORIES = ['Food', 'Transport', 'Shopping', 'Bills', 'Entertainment', 'Travel', 'Health', 'General'];

function sameDisplayName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLocaleLowerCase() === (b ?? '').trim().toLocaleLowerCase();
}

export function AddGroupExpenseModal({ open, group, onClose, prefillAmount, recentExpenses }: Props) {
  const t = useT();
  const toast = useToast();
  const { addGroupExpense } = useSplitStore();
  const { accounts, loadAccounts } = useAccountStore();
  const appMode = useAppModeStore((s) => s.mode);
  const activeMembers = getActiveGroupMembers(group);
  const inactiveMembers = getInactiveGroupMembers(group);
  const defaultPayerId = activeMembers.find(member => member.profileId === localStorage.getItem('hisaab_supabase_uid'))?.id
    ?? '';

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState(prefillAmount ?? '');
  const [paidBy, setPaidBy] = useState(defaultPayerId);
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>(activeMembers.map(m => m.id));
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>({});
  const [category, setCategory] = useState('General');
  const [paidFromAccountId, setPaidFromAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const amt = parseFloat(amount) || 0;
  // Live running totals for the split preview. Glanceable feedback so the
  // user can see whether an exact/percentage split adds up before saving.
  const exactTotal = selectedMembers.reduce((sum, id) => sum + (parseFloat(exactAmounts[id] || '0') || 0), 0);
  const pctTotal = selectedMembers.reduce((sum, id) => sum + (parseFloat(percentages[id] || '0') || 0), 0);
  const sharesTotal = selectedMembers.reduce((sum, id) => sum + (parseFloat(shares[id] || '1') || 0), 0);
  const exactRemaining = Math.round((amt - exactTotal) * 100) / 100;
  const exactIsOff = Math.abs(exactTotal - amt) > 0.01;
  const pctIsOff = Math.abs(pctTotal - 100) > 0.01;
  const currentUserId = localStorage.getItem('hisaab_supabase_uid') ?? '';
  const currentUserName = localStorage.getItem('hisaab_user_name') ?? '';
  const paidByMember = group.members.find(member => member.id === paidBy);
  const isPaidByMe = Boolean(
    paidByMember?.profileId === currentUserId ||
    (paidByMember && !paidByMember.profileId && sameDisplayName(paidByMember.name, currentUserName)),
  );
  const shouldTrackExpense = appMode === 'full_tracker' && isPaidByMe && accounts.length > 0;
  const activeMemberIdsKey = activeMembers.map((member) => member.id).join('|');

  useEffect(() => {
    if (!open) return;
    const activeMemberIds = new Set(activeMemberIdsKey ? activeMemberIdsKey.split('|') : []);
    setSelectedMembers((current) => current.filter((id) => activeMemberIds.has(id)));
    if (!activeMemberIds.has(paidBy)) setPaidBy(defaultPayerId);
  }, [activeMemberIdsKey, defaultPayerId, open, paidBy]);

  useEffect(() => {
    if (open && appMode === 'full_tracker') {
      void loadAccounts();
    }
  }, [appMode, open, loadAccounts]);

  // When prefillAmount arrives (modal opened from QuickEntry flow), seed
  // the local amount state. Runs on every open transition so consecutive
  // QuickEntry launches with different amounts don't show stale values.
  useEffect(() => {
    if (open && prefillAmount) setAmount(prefillAmount);
  }, [open, prefillAmount]);

  useEffect(() => {
    if (!open) return;
    if (!shouldTrackExpense) {
      setPaidFromAccountId('');
      return;
    }
    if (paidFromAccountId && !accounts.some(account => account.id === paidFromAccountId)) {
      setPaidFromAccountId('');
    }
  }, [open, shouldTrackExpense, paidFromAccountId, accounts]);

  const toggleMember = (id: string) => {
    setSelectedMembers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const computeSplits = (): { valid: boolean; splits: SplitDetail[]; error?: string } => {
    if (selectedMembers.length === 0) return { valid: false, splits: [], error: t('val_pick_member') };

    if (splitType === 'equal') {
      const base = Math.floor((amt * 100) / selectedMembers.length) / 100;
      const remainder = Math.round((amt - base * selectedMembers.length) * 100) / 100;
      return {
        valid: true,
        splits: selectedMembers.map((id, index) => ({
          memberId: id,
          amount: index === selectedMembers.length - 1 ? base + remainder : base,
        })),
      };
    }

    if (splitType === 'exact') {
      const splits = selectedMembers.map(id => ({ memberId: id, amount: parseFloat(exactAmounts[id] || '0') }));
      const total = splits.reduce((sum, split) => sum + split.amount, 0);
      if (Math.abs(total - amt) > 0.01) return { valid: false, splits, error: t('group_total_mismatch') };
      return { valid: true, splits };
    }

    if (splitType === 'percentage') {
      const splits = selectedMembers.map(id => {
        const pct = parseFloat(percentages[id] || '0');
        return { memberId: id, amount: Math.round((pct / 100) * amt * 100) / 100 };
      });
      const totalPct = selectedMembers.reduce((sum, id) => sum + parseFloat(percentages[id] || '0'), 0);
      if (Math.abs(totalPct - 100) > 0.01) return { valid: false, splits, error: t('group_pct_mismatch') };
      return { valid: true, splits };
    }

    if (splitType === 'shares') {
      const totalShares = selectedMembers.reduce((sum, id) => sum + parseFloat(shares[id] || '1'), 0);
      if (totalShares === 0) return { valid: false, splits: [], error: t('val_shares_zero') };
      const splits = selectedMembers.map(id => {
        const share = parseFloat(shares[id] || '1');
        return { memberId: id, amount: Math.round((share / totalShares) * amt * 100) / 100 };
      });
      return { valid: true, splits };
    }

    return { valid: false, splits: [] };
  };

  const handleSubmit = async () => {
    setSubmitError(null);

    if (!defaultPayerId) {
      setSubmitError('Your group membership could not be matched. Reopen the group or ask the owner to reconnect you before adding an expense.');
      return;
    }
    if (!description.trim()) {
      setSubmitError(t('val_need_name'));
      return;
    }
    if (amt <= 0) {
      setSubmitError(t('val_need_amount'));
      return;
    }
    if (!paidBy) {
      setSubmitError(t('fill_all'));
      return;
    }
    if (activeMembers.length < 2) {
      setSubmitError(NEED_TWO_ACTIVE_MEMBERS_MESSAGE);
      return;
    }
    if (shouldTrackExpense && !paidFromAccountId) {
      setSubmitError('Select the account you paid from.');
      return;
    }

    const { valid, splits, error } = computeSplits();
    if (!valid) {
      setSubmitError(error || t('error'));
      return;
    }

    // Soft-warn on a likely duplicate (both flatmates logging the same bill).
    if (recentExpenses && recentExpenses.length > 0) {
      const dup = findRecentDuplicate({ description: description.trim(), amount: amt }, recentExpenses, Date.now());
      if (dup) {
        const ok = await confirmDestructive({
          title: 'Looks like a duplicate',
          description: `A "${dup.description}" for ${formatMoney(dup.amount, group.currency)} was added moments ago. Add this one too?`,
          confirmLabel: 'Add anyway',
          cancelLabel: 'Cancel',
          tone: 'warning',
        });
        if (!ok) return;
      }
    }

    setSaving(true);
    try {
      await addGroupExpense({
        groupId: group.id,
        description: description.trim(),
        amount: amt,
        paidBy,
        splitType,
        splits,
        category,
        paidFromAccountId: shouldTrackExpense ? paidFromAccountId : undefined,
      });
      const payerName = activeMembers.find((member) => member.id === paidBy)?.name ?? 'Someone';
      const paidFrom = paidFromAccountId ? accounts.find((account) => account.id === paidFromAccountId)?.name : null;
      toast.show({
        type: 'success',
        title: 'Group expense saved',
        subtitle: `${payerName} paid ${formatMoney(amt, group.currency)}${paidFrom ? ` from ${paidFrom}` : ''} and split it between ${splits.length} people.`,
      });
      setDescription('');
      setAmount('');
      setSubmitError(null);
      onClose();
    } catch (err) {
      // Surface the real message — "error" with no subtitle used to leave
      // the user guessing whether a retry was safe.
      const message = friendlyGroupParticipantError(err) || t('error');
      setSubmitError(message);
      toast.show({ type: 'error', title: 'Expense not saved', subtitle: message });
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full border border-cream-border rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-accent-500 bg-white transition-all';

  return (
    <Modal open={open} onClose={onClose} title={t('group_expense_add')} footer={
      <div className="space-y-2.5">
        {submitError && (
          <p
            role="alert"
            className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-xl px-3 py-2 leading-snug"
          >
            {submitError}
          </p>
        )}
        <button onClick={handleSubmit} disabled={saving || !description.trim() || amt <= 0 || activeMembers.length < 2 || !defaultPayerId || (shouldTrackExpense && !paidFromAccountId)}
          className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20">
          {saving ? t('quick_processing') : t('group_save_expense')}
        </button>
      </div>
    }>
      <div className="space-y-5 p-5">
        {!defaultPayerId && (
          <p role="alert" className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-xl px-3 py-2 leading-snug">
            Your group membership could not be matched. Reopen the group or ask the owner to reconnect you before adding an expense.
          </p>
        )}
        {activeMembers.length < 2 && (
          <p role="alert" className="text-[12px] font-medium text-pay-text bg-pay-50 border border-pay-100 rounded-xl px-3 py-2 leading-snug">
            {NEED_TWO_ACTIVE_MEMBERS_MESSAGE}
          </p>
        )}
        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_desc')}</label>
          <input className={`${inputClass} mt-1.5`} value={description} onChange={e => setDescription(e.target.value)} placeholder={t('group_desc_placeholder')} />
        </div>

        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_amount')}</label>
          <input className={`${inputClass} mt-1.5 text-lg font-bold`} type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
        </div>

        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_paid_by')}</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {activeMembers.map(member => (
              <button key={member.id} onClick={() => setPaidBy(member.id)}
                className={`min-h-[44px] inline-flex items-center px-3.5 py-2 rounded-xl text-[12px] font-semibold transition-all ${paidBy === member.id ? 'bg-ink-900 text-white' : 'bg-cream-soft text-ink-700'}`}>
                {member.name}
              </button>
            ))}
          </div>
        </div>

        {shouldTrackExpense && (
          <div>
            <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('paid_from')}</label>
            <div className="space-y-2 mt-1.5">
              {accounts.map(account => (
                <button key={account.id} onClick={() => setPaidFromAccountId(account.id)}
                  className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all ${
                    paidFromAccountId === account.id ? 'border-accent-500 bg-accent-50 shadow-sm shadow-indigo-500/5' : 'border-cream-border bg-white'
                  }`}>
                  <div>
                    <p className="text-[13px] font-semibold text-ink-800">{account.name}</p>
                    <p className="text-[10px] text-ink-500 capitalize">{account.type.replace('_', ' ')}</p>
                  </div>
                  <p className="text-[13px] font-bold text-ink-800 tabular-nums">{formatSignedMoney(account.balance, account.currency)}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_split_between')}</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {activeMembers.map(member => (
              <button key={member.id} onClick={() => toggleMember(member.id)}
                className={`min-h-[44px] inline-flex items-center px-3.5 py-2 rounded-xl text-[12px] font-semibold transition-colors active:scale-95 ${selectedMembers.includes(member.id) ? 'bg-receive-600 text-white' : 'bg-cream-soft text-ink-600 border border-cream-border'}`}>
                {member.name}
              </button>
            ))}
          </div>
        </div>

        {inactiveMembers.length > 0 && (
          <p className="text-[11px] text-ink-500">
            Historical members: {inactiveMembers.map((member) => member.name).join(', ')}
          </p>
        )}

        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_split_type')}</label>
          <div className="grid grid-cols-4 gap-1.5 mt-1.5">
            {(['equal', 'exact', 'percentage', 'shares'] as SplitType[]).map(split => (
              <button key={split} onClick={() => setSplitType(split)}
                className={`min-h-[44px] inline-flex items-center justify-center py-2 rounded-xl text-[11px] font-bold transition-all ${splitType === split ? 'bg-ink-900 text-white' : 'bg-cream-soft text-ink-500'}`}>
                {split === 'equal' ? t('group_split_equal') : split === 'exact' ? t('group_split_exact') : split === 'percentage' ? t('group_split_pct') : t('group_split_shares')}
              </button>
            ))}
          </div>
        </div>

        {amt > 0 && selectedMembers.length > 0 && (
          <div className="space-y-2">
            {splitType === 'equal' && (
              <p className="text-[12px] text-ink-500 bg-cream-soft rounded-xl px-3 py-2.5 text-center font-medium">
                {t('group_each_pays')}: <span className="font-bold text-ink-900">{formatMoney(Math.round((amt / selectedMembers.length) * 100) / 100, group.currency)}</span>
              </p>
            )}
            {splitType === 'exact' && selectedMembers.map(id => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-[12px] text-ink-700 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
                <input className="flex-1 min-h-[44px] border border-cream-border rounded-xl px-3 py-2 text-sm bg-white" type="number" inputMode="decimal"
                  value={exactAmounts[id] || ''} onChange={e => setExactAmounts({ ...exactAmounts, [id]: e.target.value })} placeholder="0" />
              </div>
            ))}
            {splitType === 'exact' && (
              <p className={`text-[11px] font-semibold tabular-nums px-1 ${exactIsOff ? 'text-pay-text' : 'text-ink-500'}`}>
                {t('split_allocated').replace('{a}', formatMoney(exactTotal, group.currency)).replace('{b}', formatMoney(amt, group.currency))}
                {' — '}{formatMoney(Math.abs(exactRemaining), group.currency)} {exactRemaining < 0 ? 'over' : 'left'}
              </p>
            )}
            {splitType === 'percentage' && selectedMembers.map(id => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-[12px] text-ink-700 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
                <input className="flex-1 min-h-[44px] border border-cream-border rounded-xl px-3 py-2 text-sm bg-white" type="number" inputMode="decimal"
                  value={percentages[id] || ''} onChange={e => setPercentages({ ...percentages, [id]: e.target.value })} placeholder="%" />
                <span className="text-[11px] text-ink-500">%</span>
              </div>
            ))}
            {splitType === 'percentage' && (
              <p className={`text-[11px] font-semibold tabular-nums px-1 ${pctIsOff ? 'text-pay-text' : 'text-ink-500'}`}>
                {t('split_total_pct').replace('{n}', String(Math.round(pctTotal * 100) / 100))}
              </p>
            )}
            {splitType === 'shares' && selectedMembers.map(id => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-[12px] text-ink-700 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
                <input className="flex-1 min-h-[44px] border border-cream-border rounded-xl px-3 py-2 text-sm bg-white" type="number" inputMode="numeric"
                  value={shares[id] || '1'} onChange={e => setShares({ ...shares, [id]: e.target.value })} placeholder="1" />
                <span className="text-[11px] text-ink-500">shares</span>
              </div>
            ))}
            {splitType === 'shares' && (
              <p className="text-[11px] font-semibold tabular-nums px-1 text-ink-500">
                {t('split_total_shares').replace('{n}', String(Math.round(sharesTotal * 100) / 100))}
              </p>
            )}
          </div>
        )}

        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('category')}</label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {CATEGORIES.map(item => (
              <button key={item} onClick={() => setCategory(item)}
                className={`min-h-[44px] inline-flex items-center px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${category === item ? 'bg-ink-900 text-white' : 'bg-cream-soft text-ink-500'}`}>
                {item}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
