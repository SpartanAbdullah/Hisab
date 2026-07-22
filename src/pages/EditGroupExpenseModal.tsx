import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSplitStore } from '../stores/splitStore';
import { useAccountStore } from '../stores/accountStore';
import { useAppModeStore } from '../stores/appModeStore';
import { useToast } from '../components/Toast';
import { confirmDestructive } from '../components/ConfirmDestructiveSheet';
import { AccountSelect } from '../components/AccountSelect';
import { useT } from '../lib/i18n';
import { formatMoney } from '../lib/constants';
import { parseInternalNote } from '../lib/internalNotes';
import type { SplitGroup, GroupExpense, SplitType, SplitDetail } from '../db';
import {
  friendlyGroupParticipantError,
  getActiveGroupMembers,
  getInactiveGroupMembers,
  NEED_TWO_ACTIVE_MEMBERS_MESSAGE,
} from '../lib/groupActiveMembers';

interface Props {
  open: boolean;
  group: SplitGroup;
  expense: GroupExpense | null;
  onClose: () => void;
}

const CATEGORIES = ['Food', 'Transport', 'Shopping', 'Bills', 'Entertainment', 'Travel', 'Health', 'General'];

function sameDisplayName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLocaleLowerCase() === (b ?? '').trim().toLocaleLowerCase();
}

export function EditGroupExpenseModal({ open, group, expense, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const guardClose = useDiscardGuard();
  const { updateGroupExpense, deleteGroupExpense } = useSplitStore();
  const { accounts, loadAccounts } = useAccountStore();
  const appMode = useAppModeStore((s) => s.mode);
  const activeMembers = getActiveGroupMembers(group);
  const inactiveMembers = getInactiveGroupMembers(group);

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>({});
  const [percentages, setPercentages] = useState<Record<string, string>>({});
  const [shares, setShares] = useState<Record<string, string>>({});
  const [category, setCategory] = useState('General');
  const [paidFromAccountId, setPaidFromAccountId] = useState('');
  // Whether "Not tracked in my wallet" is the deliberate choice — as opposed
  // to '' merely meaning "no account picked yet" while the picker is open.
  const [dontTrack, setDontTrack] = useState(true);
  const [saving, setSaving] = useState(false);

  const currentUserId = localStorage.getItem('hisaab_supabase_uid') ?? '';
  const currentUserName = localStorage.getItem('hisaab_user_name') ?? '';
  // Creator-only editing (matches the RLS policy on the shared row). Rows
  // created before created_by existed (null) stay editable — the DB layer's
  // 0-row check is the backstop for those.
  const isCreator = !expense?.createdBy || expense.createdBy === currentUserId;
  const creatorName = expense?.createdBy
    ? group.members.find((m) => m.profileId === expense.createdBy)?.name ?? null
    : null;
  const paidByMember = group.members.find(member => member.id === paidBy);
  const isPaidByMe = Boolean(
    paidByMember?.profileId === currentUserId ||
    (paidByMember && !paidByMember.profileId && sameDisplayName(paidByMember.name, currentUserName)),
  );
  const shouldTrackExpense = appMode === 'full_tracker' && isPaidByMe && accounts.length > 0;

  useEffect(() => {
    if (open && appMode === 'full_tracker') {
      void loadAccounts();
    }
  }, [appMode, open, loadAccounts]);

  useEffect(() => {
    if (expense && open) {
      const meta = parseInternalNote(expense.notes).meta;
      setDescription(expense.description);
      setAmount(String(expense.amount));
      setPaidBy(expense.paidBy);
      setSplitType(expense.splitType);
      const activeMemberIds = new Set(getActiveGroupMembers(group).map((member) => member.id));
      setSelectedMembers(expense.splits.map(split => split.memberId).filter((id) => activeMemberIds.has(id)));
      setCategory(expense.category || 'General');
      setPaidFromAccountId(meta.paidFromAccountId ?? '');
      setDontTrack(!meta.paidFromAccountId);
      if (expense.splitType === 'exact') {
        const values: Record<string, string> = {};
        expense.splits.forEach(split => { values[split.memberId] = String(split.amount); });
        setExactAmounts(values);
      }
      // Percentage/shares were previously dropped on edit — the fallback
      // recomputed them as equal splits. Re-derive the editors' inputs from
      // the stored amounts so the original proportions survive a save.
      if (expense.splitType === 'percentage' && expense.amount > 0) {
        // Remainder-correct: independently rounded per-member percentages can
        // sum to 99.93 or 100.07 and then fail the modal's own 100% check on
        // an untouched expense. Pin the last member to whatever closes the
        // gap so the seeded set always sums to exactly 100.
        const values: Record<string, string> = {};
        let running = 0;
        expense.splits.forEach((split, index) => {
          if (index === expense.splits.length - 1) {
            values[split.memberId] = String(Math.round((100 - running) * 100) / 100);
          } else {
            const pct = Math.round((split.amount / expense.amount) * 100 * 100) / 100;
            values[split.memberId] = String(pct);
            running = Math.round((running + pct) * 100) / 100;
          }
        });
        setPercentages(values);
      }
      if (expense.splitType === 'shares') {
        // Raw share counts aren't persisted (only amounts). Normalize by the
        // smallest amount so proportions survive AND the scale stays share-
        // like — a newly toggled member's default share of '1' then means
        // "same as the smallest", not a rounding error against raw amounts.
        const smallest = Math.min(...expense.splits.map(s => s.amount).filter(a => a > 0));
        const values: Record<string, string> = {};
        expense.splits.forEach(split => {
          const share = smallest > 0 ? Math.round((split.amount / smallest) * 100) / 100 : 1;
          values[split.memberId] = String(share);
        });
        setShares(values);
      }
    }
  }, [expense, group, open]);

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

  const amt = parseFloat(amount) || 0;

  const toggleMember = (id: string) => {
    setSelectedMembers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const computeSplits = (): { valid: boolean; splits: SplitDetail[]; error?: string } => {
    if (selectedMembers.length === 0) return { valid: false, splits: [], error: t('fill_all') };
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
      // Round the float sum to 2dp BEFORE comparing — 99.99 must fail and
      // 100.00 must pass without 1e-14 float dust flipping the verdict.
      const totalPct = Math.round(selectedMembers.reduce((sum, id) => sum + parseFloat(percentages[id] || '0'), 0) * 100) / 100;
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
    return { valid: true, splits: selectedMembers.map(id => ({ memberId: id, amount: amt / selectedMembers.length })) };
  };

  const handleSave = async () => {
    if (!expense) return;
    if (!description.trim() || amt <= 0 || !paidBy) {
      toast.show({ type: 'error', title: t('fill_all') });
      return;
    }
    if (activeMembers.length < 2) {
      toast.show({ type: 'error', title: NEED_TWO_ACTIVE_MEMBERS_MESSAGE });
      return;
    }
    const { valid, splits, error } = computeSplits();
    if (!valid) {
      toast.show({ type: 'error', title: error || t('error') });
      return;
    }
    setSaving(true);
    try {
      await updateGroupExpense(expense.id, {
        description: description.trim(),
        amount: amt,
        paidBy,
        splitType,
        splits,
        category,
        paidFromAccountId: shouldTrackExpense ? paidFromAccountId || null : null,
      });
      toast.show({ type: 'success', title: 'Expense updated!' });
      onClose();
    } catch (err) {
      const message = friendlyGroupParticipantError(err) || t('error');
      toast.show({ type: 'error', title: 'Expense not updated', subtitle: message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!expense) return;
    const ok = await confirmDestructive({
      title: 'Delete this expense?',
      description: 'It will be removed for everyone in the group.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setSaving(true);
    try {
      await deleteGroupExpense(expense.id);
      toast.show({ type: 'success', title: 'Expense deleted' });
      onClose();
    } catch (err) {
      // Honest failure — previously a silently no-op'd delete toasted success.
      toast.show({
        type: 'error',
        title: t('grp_expense_not_deleted'),
        subtitle: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full border border-cream-border rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-accent-500 bg-cream-card transition-all';

  return (
    <Modal open={open} onClose={onClose} title="Edit Expense"
      confirmClose={() => guardClose(!!expense && (
        description !== expense.description ||
        amount !== String(expense.amount) ||
        paidBy !== expense.paidBy ||
        splitType !== expense.splitType
      ))}
      footer={
      <div className="flex gap-2">
        <button onClick={handleDelete} disabled={saving || !isCreator} className="px-4 py-3.5 rounded-2xl bg-pay-50 text-pay-text active:bg-pay-100 transition-all disabled:opacity-30">
          <Trash2 size={16} />
        </button>
        <button onClick={handleSave} disabled={saving || !isCreator || !description.trim() || amt <= 0}
          className="flex-1 bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20">
          {saving ? t('quick_processing') : 'Save Changes'}
        </button>
      </div>
    }>
      <div className="space-y-5 p-5">
        {/* Only the creator's shared row is writable (RLS). Everyone else
            used to get a fake success toast while nothing changed. */}
        {!isCreator && (
          <p className="text-[12px] text-warn-700 bg-warn-50 border border-warn-100 rounded-xl p-3 leading-relaxed">
            {creatorName
              ? t('grp_creator_banner').replace('{name}', creatorName)
              : t('grp_creator_banner_generic')}
          </p>
        )}
        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_desc')}</label>
          <input className={`${inputClass} mt-1.5`} value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_amount')}</label>
          <input className={`${inputClass} mt-1.5 text-lg font-bold`} type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
        </div>

        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_paid_by')}</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {activeMembers.map(member => (
              <button key={member.id} onClick={() => setPaidBy(member.id)}
                className={`px-3.5 py-2 rounded-xl text-[12px] font-semibold transition-all ${paidBy === member.id ? 'bg-ink-900 text-white' : 'bg-cream-soft text-ink-700'}`}>
                {member.name}
              </button>
            ))}
          </div>
        </div>

        {shouldTrackExpense && (
          <div>
            <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('paid_from')}</label>
            <div className="space-y-2 mt-1.5">
              <button
                onClick={() => { setDontTrack(true); setPaidFromAccountId(''); }}
                className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all ${
                  dontTrack ? 'border-emerald-300 bg-receive-50/60 shadow-sm shadow-emerald-500/5' : 'border-cream-border bg-cream-card'
                }`}
              >
                <div>
                  <p className="text-[13px] font-semibold text-ink-800">Not tracked in my wallet</p>
                  <p className="text-[10px] text-ink-500">Use this for card/cash paid outside this app.</p>
                </div>
              </button>
              {/* "Not tracked" is a deliberate state (paidFromAccountId=''),
                  so the account picker only appears once the user opts back
                  into tracking — otherwise its "Choose an account" prompt
                  would contradict the selected option above. */}
              {dontTrack ? (
                <button
                  onClick={() => setDontTrack(false)}
                  className="w-full p-3.5 rounded-2xl border-2 border-cream-border bg-cream-card text-left transition-all active:scale-[0.98]"
                >
                  <p className="text-[13px] font-semibold text-ink-800">{t('acct_select_placeholder')}…</p>
                </button>
              ) : (
                <AccountSelect accounts={accounts} selectedId={paidFromAccountId} onSelect={setPaidFromAccountId} preferredCurrency={group.currency} />
              )}
            </div>
          </div>
        )}

        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_split_between')}</label>
          <div className="flex flex-wrap gap-2 mt-1.5">
            {activeMembers.map(member => (
              <button key={member.id} onClick={() => toggleMember(member.id)}
                className={`px-3.5 py-2 rounded-xl text-[12px] font-semibold transition-colors active:scale-95 ${selectedMembers.includes(member.id) ? 'bg-receive-600 text-white' : 'bg-cream-soft text-ink-600 border border-cream-border'}`}>
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
                className={`py-2 rounded-xl text-[11px] font-bold transition-all ${splitType === split ? 'bg-ink-900 text-white' : 'bg-cream-soft text-ink-500'}`}>
                {split === 'equal' ? t('group_split_equal') : split === 'exact' ? t('group_split_exact') : split === 'percentage' ? t('group_split_pct') : t('group_split_shares')}
              </button>
            ))}
          </div>
        </div>

        {amt > 0 && selectedMembers.length > 0 && splitType === 'equal' && (
          <p className="text-[12px] text-ink-500 bg-cream-soft rounded-xl px-3 py-2.5 text-center font-medium">
            {t('group_each_pays')}: <span className="font-bold text-ink-900">{formatMoney(Math.round((amt / selectedMembers.length) * 100) / 100, group.currency)}</span>
          </p>
        )}

        {amt > 0 && splitType === 'exact' && selectedMembers.map(id => (
          <div key={id} className="flex items-center gap-2">
            <span className="text-[12px] text-ink-700 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
            <input className="flex-1 border border-cream-border rounded-xl px-3 py-2 text-sm bg-cream-card" type="number" inputMode="decimal"
              value={exactAmounts[id] || ''} onChange={e => setExactAmounts({ ...exactAmounts, [id]: e.target.value })} placeholder="0" />
          </div>
        ))}

        {amt > 0 && splitType === 'percentage' && selectedMembers.map(id => (
          <div key={id} className="flex items-center gap-2">
            <span className="text-[12px] text-ink-700 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
            <input className="flex-1 border border-cream-border rounded-xl px-3 py-2 text-sm bg-cream-card" type="number" inputMode="decimal"
              value={percentages[id] || ''} onChange={e => setPercentages({ ...percentages, [id]: e.target.value })} placeholder="%" />
            <span className="text-[11px] text-ink-500">%</span>
          </div>
        ))}

        {amt > 0 && splitType === 'shares' && selectedMembers.map(id => (
          <div key={id} className="flex items-center gap-2">
            <span className="text-[12px] text-ink-700 font-medium w-20 truncate">{group.members.find(member => member.id === id)?.name}</span>
            <input className="flex-1 border border-cream-border rounded-xl px-3 py-2 text-sm bg-cream-card" type="number" inputMode="decimal"
              value={shares[id] || '1'} onChange={e => setShares({ ...shares, [id]: e.target.value })} placeholder="1" />
            <span className="text-[11px] text-ink-500">{t('group_split_shares')}</span>
          </div>
        ))}

        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('category')}</label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {CATEGORIES.map(item => (
              <button key={item} onClick={() => setCategory(item)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${category === item ? 'bg-ink-900 text-white' : 'bg-cream-soft text-ink-500'}`}>
                {item}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
