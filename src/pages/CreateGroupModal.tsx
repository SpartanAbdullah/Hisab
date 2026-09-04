import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, UserPlus, Check, UserRoundPlus } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useDiscardGuard } from '../lib/useDiscardGuard';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useSplitStore, type GuestMemberInput, type ResolvedMemberInput } from '../stores/splitStore';
import {
  MAX_GROUP_GUESTS,
  MAX_GUEST_NAME_LENGTH,
  guestNameProblemMessage,
  validateGuestName,
} from '../lib/groupGuests';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { type Currency, type SplitGroup } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { CurrencyPicker } from '../components/CurrencyPicker';
import { getPrimaryCurrency } from '../lib/primaryCurrency';
import { profilesDb } from '../lib/supabaseDb';
import { normalizePublicCode } from '../lib/collaboration';
import { track } from '../lib/telemetry';
import { bucketCount } from '../lib/telemetryEvents';

const EMOJIS = ['✈️', '🍕', '🏠', '🎉', '🛒', '💼', '🎓', '🏖️', '⚽', '🎮', '🍔', '☕', '🎬', '🚗', '💊', '🎁', '👨‍👩‍👧‍👦', '🏋️', '📱', '🎵', '🍳', '🧳', '🎃', '❤️'];

interface Props {
  open: boolean;
  onClose: () => void;
  // Optional override of the post-create behaviour. Default: navigate to
  // the new group's detail page (so the user lands on the activation
  // loop). QuickEntry's "Group expense → Create new" flow passes this
  // to redirect into AddGroupExpenseModal instead, carrying the amount
  // the user already typed.
  onCreated?: (group: SplitGroup) => void;
}

export function CreateGroupModal({ open, onClose, onCreated }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const guardClose = useDiscardGuard();
  const submitGuard = useSubmitGuard();
  const { createGroup } = useSplitStore();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('✈️');
  const [currency, setCurrency] = useState<Currency>(() => getPrimaryCurrency());
  // Ranks the CurrencyPicker's five inline chips from the currencies this
  // user already holds money in. accountStore is a global store that is
  // already loaded app-wide, so this subscribes to data in memory — no fetch.
  const accounts = useAccountStore((s) => s.accounts);
  const usedCurrencies = useMemo(() => [...new Set(accounts.map((a) => a.currency))], [accounts]);
  const [codeInput, setCodeInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [members, setMembers] = useState<ResolvedMemberInput[]>([]);
  // People who will never install Hisaab (audit G6 / O4, July blocker B6).
  // Staged locally and written by createGroup through add_group_guest once the
  // group row exists — a guest seat needs a group_id, and the phone hash needs
  // the definer RPC.
  const [guests, setGuests] = useState<GuestMemberInput[]>([]);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName(''); setEmoji('✈️'); setCodeInput(''); setMembers([]);
    setGuests([]); setGuestName(''); setGuestPhone('');
  };

  const currentUserId = localStorage.getItem('hisaab_supabase_uid');
  const ownerName = localStorage.getItem('hisaab_user_name') ?? 'You';

  const addMember = async () => {
    const normalized = normalizePublicCode(codeInput);
    if (!normalized) {
      toast.show({ type: 'error', title: t('group_code_err_empty') });
      return;
    }
    if (members.some(m => normalizePublicCode(m.publicCode) === normalized)) {
      toast.show({ type: 'error', title: t('group_code_err_dup') });
      return;
    }
    setResolving(true);
    try {
      const match = await profilesDb.findByPublicCode(normalized);
      if (!match) {
        toast.show({ type: 'error', title: t('group_code_err_not_found'), subtitle: t('group_code_err_not_found_sub') });
        return;
      }
      if (match.id === currentUserId) {
        toast.show({ type: 'error', title: t('group_code_err_self'), subtitle: t('group_code_err_self_sub') });
        return;
      }
      setMembers(prev => [...prev, { profileId: match.id, name: match.name || match.publicCode, publicCode: match.publicCode }]);
      setCodeInput('');
    } catch {
      toast.show({ type: 'error', title: t('group_code_err_lookup_failed') });
    } finally {
      setResolving(false);
    }
  };

  const removeMember = (profileId: string) => setMembers(members.filter(m => m.profileId !== profileId));

  // Staging only — no network, so no submit guard is needed here, but the
  // duplicate check has to see BOTH the resolved code members and the guests
  // already staged: wherever a profile is absent the app keys people by name
  // (docs/who-owes-me.md §3 rule 3), so two same-named seats would silently
  // merge into one person's money. Same rule the server enforces.
  const addGuest = () => {
    if (guests.length >= MAX_GROUP_GUESTS) {
      toast.show({ type: 'error', title: t('guest_err_too_many') });
      return;
    }
    const problem = validateGuestName(
      guestName,
      [
        { name: ownerName, status: 'connected' },
        ...members.map(m => ({ name: m.name, status: 'invited' as const })),
      ],
      guests.map(g => g.name),
    );
    if (problem) {
      toast.show({ type: 'error', title: guestNameProblemMessage(problem) });
      return;
    }
    setGuests(prev => [...prev, { name: guestName.trim(), phone: guestPhone.trim() || undefined }]);
    setGuestName('');
    setGuestPhone('');
  };

  const removeGuest = (index: number) => setGuests(guests.filter((_, i) => i !== index));

  // Ref-backed entry re-check; `saving` state stays for the disabled/label UI.
  const handleSubmit = () => submitGuard.run(runSubmit);

  const runSubmit = async () => {
    if (!name.trim()) {
      toast.show({ type: 'error', title: t('fill_all') });
      return;
    }
    setSaving(true);
    try {
      const created = await createGroup(name.trim(), emoji, members, currency, guests);
      // Catalog #15. Size travels as a BUCKET and the group name never leaves
      // the device — a group created with 1 member is the "empty shell" signal
      // report 10 wants, and that needs no identifying detail. Guests count
      // toward the size: a trip with three named non-app people is not an
      // empty shell, and reading it as one would misdiagnose activation.
      track('group_created', {
        member_count_bucket: bucketCount(members.length + guests.length + 1),
        currency,
      });
      // Guide the user straight into the activation loop: created → add
      // first expense or share code. Longer duration so the nudge outlives
      // the page transition.
      toast.show({
        type: 'success',
        title: t('group_created'),
        subtitle: t('group_created_subtitle'),
        duration: 5000,
      });
      reset();
      onClose();
      // Caller-provided override (e.g. QuickEntry → AddGroupExpense flow)
      // wins over the default group-detail navigate. Default keeps the
      // existing GroupsPage-tap-Create-button behaviour intact.
      if (onCreated) {
        onCreated(created);
      } else {
        navigate(`/group/${created.id}`);
      }
    } catch (err) {
      // createGroup throws an already-translated message when a guest seat is
      // refused (duplicate name, cap) and rolls the group back, so surfacing it
      // beats a bare "error" the user cannot act on.
      const message = err instanceof Error && err.message ? err.message : t('error');
      toast.show({ type: 'error', title: t('error'), subtitle: message });
    } finally { setSaving(false); }
  };

  const inputClass = "w-full border border-cream-border rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all";

  return (
    <Modal open={open} onClose={onClose} title={t('group_new')}
      confirmClose={() => guardClose(!!name.trim() || members.length > 0 || guests.length > 0 || !!codeInput.trim() || !!guestName.trim() || emoji !== '✈️')}
      footer={
      <button onClick={handleSubmit} disabled={saving || !name.trim()}
        className="w-full bg-accent-600 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-accent-600/20">
        {saving ? t('group_creating') : t('group_create')}
      </button>
    }>
      <div className="space-y-5 p-5">
        {/* Emoji picker */}
        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_emoji')}</label>
          <div className="flex flex-wrap gap-2 mt-2">
            {EMOJIS.map(e => (
              <button key={e} onClick={() => setEmoji(e)}
                className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all ${emoji === e ? 'bg-accent-100 ring-2 ring-accent-500 scale-110' : 'bg-cream-soft active:scale-95'}`}>
                {e}
              </button>
            ))}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_name')}</label>
          <input className={inputClass + ' mt-1.5'} value={name} onChange={e => setName(e.target.value)} placeholder={t('group_name_placeholder')} />
        </div>

        {/* Currency */}
        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('common_currency')}</label>
          <div className="mt-1.5">
            <CurrencyPicker
              value={currency}
              onChange={setCurrency}
              primary={getPrimaryCurrency()}
              used={usedCurrencies}
            />
          </div>
        </div>

        {/* Members — by user code */}
        <div>
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('group_members')}</label>
          <p className="text-[11px] text-ink-500 mt-1">
            {t('group_code_hint')}
          </p>
          <div className="flex gap-2 mt-2">
            <input
              className={inputClass + ' font-mono text-[12px]'}
              value={codeInput}
              onChange={e => setCodeInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addMember(); } }}
              placeholder={t('group_code_placeholder')}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              onClick={() => void addMember()}
              disabled={resolving || !codeInput.trim()}
              className="shrink-0 w-12 h-12 rounded-2xl bg-accent-100 flex items-center justify-center active:scale-95 transition-all disabled:opacity-40"
            >
              {resolving ? <div className="w-4 h-4 border-2 border-accent-500 border-t-transparent rounded-full animate-spin" /> : <UserPlus size={18} className="text-accent-600" />}
            </button>
          </div>

          {/* Owner chip + resolved member chips */}
          <div className="flex flex-wrap gap-2 mt-3">
            <div className="px-3 py-1.5 rounded-xl bg-accent-100 text-accent-600 text-[12px] font-semibold flex items-center gap-1.5">
              {ownerName} <span className="text-[9px] opacity-60">{t('group_owner_you_tag')}</span>
            </div>
            {members.map(m => (
              <div key={m.profileId} className="px-3 py-1.5 rounded-xl bg-receive-50 text-receive-text text-[12px] font-semibold flex items-center gap-1.5 border border-receive-100/60">
                <Check size={11} strokeWidth={3} />
                {m.name}
                <button onClick={() => removeMember(m.profileId)} className="ml-0.5 opacity-50 hover:opacity-100"><X size={12} /></button>
              </div>
            ))}
            {guests.map((g, i) => (
              <div key={`guest-${i}`} className="px-3 py-1.5 rounded-xl bg-cream-soft text-ink-700 text-[12px] font-semibold flex items-center gap-1.5 border border-cream-hairline">
                <UserRoundPlus size={11} strokeWidth={2.5} />
                {g.name}
                <span className="text-[9px] opacity-60 uppercase tracking-wide">{t('guest_tag')}</span>
                <button onClick={() => removeGuest(i)} className="ml-0.5 opacity-50 hover:opacity-100"><X size={12} /></button>
              </div>
            ))}
          </div>
          {members.length === 0 && guests.length === 0 && (
            <p className="text-[11px] text-ink-500 mt-2.5">
              {t('group_no_members_yet_hint')}
            </p>
          )}
        </div>

        {/* ── Guests: people who will never install Hisaab ────────────────────
            The gap this closes is audit G6/O4 (July blocker B6): the group
            container silently required a Hisaab code for everyone, and nothing
            on screen said so. A guest is a full ledger participant — shares,
            payer, settlements — recorded on their behalf by real members. */}
        <div className="pt-1">
          <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">{t('guest_add_title')}</label>
          <p className="text-[11px] text-ink-500 mt-1">{t('guest_add_hint')}</p>
          <div className="flex gap-2 mt-2">
            <input
              className={inputClass}
              value={guestName}
              maxLength={MAX_GUEST_NAME_LENGTH}
              onChange={e => setGuestName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGuest(); } }}
              placeholder={t('guest_name_placeholder')}
            />
            <button
              onClick={addGuest}
              disabled={!guestName.trim() || guests.length >= MAX_GROUP_GUESTS}
              className="shrink-0 w-12 h-12 rounded-2xl bg-cream-soft flex items-center justify-center active:scale-95 transition-all disabled:opacity-40"
              aria-label={t('guest_add_cta')}
            >
              <UserRoundPlus size={18} className="text-ink-700" />
            </button>
          </div>
          <input
            className={inputClass + ' mt-2'}
            value={guestPhone}
            onChange={e => setGuestPhone(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGuest(); } }}
            placeholder={t('guest_phone_placeholder')}
            inputMode="tel"
            autoComplete="off"
          />
          <p className="text-[11px] text-ink-500 mt-2">{t('guest_phone_hint')}</p>
        </div>
      </div>
    </Modal>
  );
}
