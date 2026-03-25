import { useState } from 'react';
import { X, UserPlus } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import type { Currency } from '../db';
import { currencyMeta } from '../lib/design-tokens';

const EMOJIS = ['✈️', '🍕', '🏠', '🎉', '🛒', '💼', '🎓', '🏖️', '⚽', '🎮', '🍔', '☕', '🎬', '🚗', '💊', '🎁', '👨‍👩‍👧‍👦', '🏋️', '📱', '🎵', '🍳', '🧳', '🎃', '❤️'];

interface Props { open: boolean; onClose: () => void; }

export function CreateGroupModal({ open, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { createGroup } = useSplitStore();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('✈️');
  const [currency, setCurrency] = useState<Currency>((localStorage.getItem('hisaab_primary_currency') as Currency) || 'PKR');
  const [memberName, setMemberName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const reset = () => { setName(''); setEmoji('✈️'); setMemberName(''); setMembers([]); };

  const addMember = () => {
    const trimmed = memberName.trim();
    if (trimmed && !members.includes(trimmed)) {
      setMembers([...members, trimmed]);
      setMemberName('');
    }
  };

  const removeMember = (m: string) => setMembers(members.filter(x => x !== m));

  const handleSubmit = async () => {
    if (!name.trim() || members.length === 0) {
      toast.show({ type: 'error', title: t('fill_all') });
      return;
    }
    setSaving(true);
    try {
      await createGroup(name.trim(), emoji, members, currency);
      toast.show({ type: 'success', title: t('group_created'), subtitle: name });
      reset();
      onClose();
    } catch {
      toast.show({ type: 'error', title: t('error') });
    } finally { setSaving(false); }
  };

  const inputClass = "w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all";

  return (
    <Modal open={open} onClose={onClose} title={t('group_new')} footer={
      <button onClick={handleSubmit} disabled={saving || !name.trim() || members.length === 0}
        className="w-full btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20">
        {saving ? t('group_creating') : t('group_create')}
      </button>
    }>
      <div className="space-y-5 p-5">
        {/* Emoji picker */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_emoji')}</label>
          <div className="flex flex-wrap gap-2 mt-2">
            {EMOJIS.map(e => (
              <button key={e} onClick={() => setEmoji(e)}
                className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all ${emoji === e ? 'bg-indigo-100 ring-2 ring-indigo-400 scale-110' : 'bg-slate-50 active:scale-95'}`}>
                {e}
              </button>
            ))}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_name')}</label>
          <input className={inputClass + ' mt-1.5'} value={name} onChange={e => setName(e.target.value)} placeholder={t('group_name_placeholder')} />
        </div>

        {/* Currency */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Currency</label>
          <div className="grid grid-cols-2 gap-2 mt-1.5">
            {(['AED', 'PKR'] as Currency[]).map(c => {
              const meta = currencyMeta[c];
              return (
                <button key={c} onClick={() => setCurrency(c)}
                  className={`p-3 rounded-2xl border text-left transition-all ${currency === c ? 'border-indigo-400 bg-indigo-50/50' : 'border-slate-200/60 bg-white'}`}>
                  <p className="text-lg font-bold">{meta?.flag} {c}</p>
                  <p className="text-[10px] text-slate-400">{meta?.name}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Members */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_members')}</label>
          <div className="flex gap-2 mt-1.5">
            <input className={inputClass} value={memberName} onChange={e => setMemberName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addMember(); } }}
              placeholder={t('group_member_name')} />
            <button onClick={addMember} className="shrink-0 w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center active:scale-95 transition-all">
              <UserPlus size={18} className="text-indigo-600" />
            </button>
          </div>

          {/* Owner chip + member chips */}
          <div className="flex flex-wrap gap-2 mt-3">
            <div className="px-3 py-1.5 rounded-xl bg-indigo-100 text-indigo-700 text-[12px] font-semibold flex items-center gap-1.5">
              {localStorage.getItem('hisaab_user_name') ?? 'You'} <span className="text-[9px] opacity-60">(you)</span>
            </div>
            {members.map(m => (
              <div key={m} className="px-3 py-1.5 rounded-xl bg-slate-100 text-slate-700 text-[12px] font-semibold flex items-center gap-1.5">
                {m}
                <button onClick={() => removeMember(m)} className="ml-0.5 opacity-50 hover:opacity-100"><X size={12} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
