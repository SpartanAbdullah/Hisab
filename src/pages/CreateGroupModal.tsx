import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, UserPlus, Check } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useSplitStore, type ResolvedMemberInput } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import type { Currency } from '../db';
import { currencyMeta } from '../lib/design-tokens';
import { profilesDb } from '../lib/supabaseDb';
import { normalizePublicCode } from '../lib/collaboration';

const EMOJIS = ['✈️', '🍕', '🏠', '🎉', '🛒', '💼', '🎓', '🏖️', '⚽', '🎮', '🍔', '☕', '🎬', '🚗', '💊', '🎁', '👨‍👩‍👧‍👦', '🏋️', '📱', '🎵', '🍳', '🧳', '🎃', '❤️'];

interface Props { open: boolean; onClose: () => void; }

export function CreateGroupModal({ open, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { createGroup } = useSplitStore();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('✈️');
  const [currency, setCurrency] = useState<Currency>((localStorage.getItem('hisaab_primary_currency') as Currency) || 'PKR');
  const [codeInput, setCodeInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [members, setMembers] = useState<ResolvedMemberInput[]>([]);
  const [saving, setSaving] = useState(false);

  const reset = () => { setName(''); setEmoji('✈️'); setCodeInput(''); setMembers([]); };

  const currentUserId = localStorage.getItem('hisaab_supabase_uid');
  const ownerName = localStorage.getItem('hisaab_user_name') ?? 'You';

  const addMember = async () => {
    const normalized = normalizePublicCode(codeInput);
    if (!normalized) {
      toast.show({ type: 'error', title: 'Enter a user code' });
      return;
    }
    if (members.some(m => normalizePublicCode(m.publicCode) === normalized)) {
      toast.show({ type: 'error', title: 'Already added' });
      return;
    }
    setResolving(true);
    try {
      const match = await profilesDb.findByPublicCode(normalized);
      if (!match) {
        toast.show({ type: 'error', title: 'User not found', subtitle: 'Check the code and try again.' });
        return;
      }
      if (match.id === currentUserId) {
        toast.show({ type: 'error', title: "That's your own code", subtitle: "You're always included." });
        return;
      }
      setMembers(prev => [...prev, { profileId: match.id, name: match.name || match.publicCode, publicCode: match.publicCode }]);
      setCodeInput('');
    } catch {
      toast.show({ type: 'error', title: 'Lookup failed' });
    } finally {
      setResolving(false);
    }
  };

  const removeMember = (profileId: string) => setMembers(members.filter(m => m.profileId !== profileId));

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.show({ type: 'error', title: t('fill_all') });
      return;
    }
    setSaving(true);
    try {
      const created = await createGroup(name.trim(), emoji, members, currency);
      toast.show({ type: 'success', title: t('group_created'), subtitle: name });
      reset();
      onClose();
      navigate(`/group/${created.id}`);
    } catch {
      toast.show({ type: 'error', title: t('error') });
    } finally { setSaving(false); }
  };

  const inputClass = "w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all";

  return (
    <Modal open={open} onClose={onClose} title={t('group_new')} footer={
      <button onClick={handleSubmit} disabled={saving || !name.trim()}
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

        {/* Members — by user code */}
        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('group_members')}</label>
          <p className="text-[11px] text-slate-500 mt-1">
            Add by user code. Ask them to share theirs from Settings → My Account.
          </p>
          <div className="flex gap-2 mt-2">
            <input
              className={inputClass + ' font-mono text-[12px]'}
              value={codeInput}
              onChange={e => setCodeInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addMember(); } }}
              placeholder="HSB-XXXXXX"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              onClick={() => void addMember()}
              disabled={resolving || !codeInput.trim()}
              className="shrink-0 w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center active:scale-95 transition-all disabled:opacity-40"
            >
              {resolving ? <div className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" /> : <UserPlus size={18} className="text-indigo-600" />}
            </button>
          </div>

          {/* Owner chip + resolved member chips */}
          <div className="flex flex-wrap gap-2 mt-3">
            <div className="px-3 py-1.5 rounded-xl bg-indigo-100 text-indigo-700 text-[12px] font-semibold flex items-center gap-1.5">
              {ownerName} <span className="text-[9px] opacity-60">(you)</span>
            </div>
            {members.map(m => (
              <div key={m.profileId} className="px-3 py-1.5 rounded-xl bg-emerald-50 text-emerald-700 text-[12px] font-semibold flex items-center gap-1.5 border border-emerald-200/60">
                <Check size={11} strokeWidth={3} />
                {m.name}
                <button onClick={() => removeMember(m.profileId)} className="ml-0.5 opacity-50 hover:opacity-100"><X size={12} /></button>
              </div>
            ))}
          </div>
          {members.length === 0 && (
            <p className="text-[11px] text-slate-400 mt-2.5">
              You can also create the group first and share the join code later.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
