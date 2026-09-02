import { useEffect, useMemo, useState } from 'react';
import { Copy, Link2, UserPlus, UserRoundPlus, Trash2, Send, Pencil } from 'lucide-react';
import { Modal } from './Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import {
  MAX_GROUP_GUESTS,
  MAX_GUEST_NAME_LENGTH,
  buildGuestInviteText,
  getGuestMembers,
  guestNameProblemMessage,
  guestRpcFailureMessage,
  isGuestMember,
  validateGuestName,
} from '../lib/groupGuests';
import type { GroupInvite, GroupMember, SplitGroup } from '../db';

interface Props {
  open: boolean;
  group: SplitGroup;
  onClose: () => void;
}

// The raw enum used to be printed straight into the badge ("invited",
// "guest"). Since owner-added members now land as 'invited' by default (audit
// H6 / SEC-05) that string is on screen for every new group, so it goes through
// i18n like every other user-facing word — same vocabulary GroupDetailPage's
// member chips use.
//
// The GUEST case is checked FIRST and deliberately: a guest seat is
// status='connected' (that is what makes them a real ledger participant), so
// the status-only branch below would otherwise label them "on Hisaab", which is
// exactly the one thing they are not.
function statusLabel(t: ReturnType<typeof useT>, member: GroupMember): string {
  if (member.isOwner) return t('member_owner');
  if (isGuestMember(member)) return t('guest_tag');
  if (member.status === 'connected') return t('member_on_app');
  if (member.status === 'invited') return t('member_invited');
  return t('member_not_on_app');
}

function statusBadgeClass(member: GroupMember) {
  if (isGuestMember(member)) return 'bg-cream-soft text-ink-600';
  if (member.status === 'connected') return 'bg-receive-50 text-receive-text';
  if (member.status === 'invited') return 'bg-warn-50 text-warn-600';
  return 'bg-cream-soft text-ink-500';
}

// Maps renameGroupGuest's status vocabulary to copy. Not the same helper as
// guestRpcFailureMessage (groupGuests.ts): that one's NOT_ALLOWED / INVALID_NAME
// copy is written for add/remove ("...can remove this seat", "up to 60
// characters") and would read wrong here, so rename gets its own small map —
// reusing guest_err_duplicate_name / guest_err_archived / guest_err_not_member
// as-is since those are generic enough to fit both flows.
function renameFailureMessage(t: ReturnType<typeof useT>, status: string): string {
  if (status === 'DUPLICATE_NAME') return t('guest_err_duplicate_name');
  if (status === 'INVALID_NAME') return t('guest_err_rename_invalid');
  if (status === 'GROUP_ARCHIVED') return t('guest_err_archived');
  if (status === 'NOT_ACTIVE_MEMBER') return t('guest_err_not_member');
  return t('guest_err_generic');
}

export function GroupInviteModal({ open, group, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { createInvite, getGroupInvites, addGroupGuest, removeGroupGuest, renameGroupGuest } = useSplitStore();
  const [loading, setLoading] = useState(false);
  const [invites, setInvites] = useState<GroupInvite[]>([]);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  // Ref-backed entry re-check: two taps in one frame both read `loading ===
  // false` (state is async) and would fire two add_group_guest calls with two
  // different minted ids, i.e. two seats for one person. The RPC's idempotency
  // is per member id, so it cannot save us here — this guard is the protection.
  const addGuard = useSubmitGuard();
  const removeGuard = useSubmitGuard();
  const renameGuard = useSubmitGuard();
  const [renamingGuest, setRenamingGuest] = useState<GroupMember | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Rename is owner-only (docs/guest-members.md §9.4 / §5) — the seat-rules
  // trigger is INSERT-only, so the group_members UPDATE RLS policy (owner OR
  // the linked profile — impossible for an unclaimed guest) is the only server
  // gate, and the pencil affordance must not offer an action every non-owner
  // tap would silently 0-row.
  const currentUserId = localStorage.getItem('hisaab_supabase_uid');
  const isOwner = group.members.find((m) => m.isOwner)?.profileId === currentUserId;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getGroupInvites(group.id).then((rows) => {
      if (!cancelled) setInvites(rows);
    }).catch(() => {
      if (!cancelled) setInvites([]);
    });
    return () => {
      cancelled = true;
    };
  }, [getGroupInvites, group.id, open]);

  const inviteLookup = useMemo(
    () => new Map(invites.filter(invite => invite.linkedMemberId).map(invite => [invite.linkedMemberId as string, invite])),
    [invites],
  );

  const guestCount = getGuestMembers(group).length;

  const handleCreateInvite = async (linkedMemberId?: string | null) => {
    setLoading(true);
    try {
      const result = await createInvite(group.id, linkedMemberId ?? null);
      await navigator.clipboard.writeText(result.url);
      toast.show({
        type: 'success',
        title: t('ginv_link_copied'),
        subtitle: linkedMemberId ? t('ginv_copied_sub_member') : t('ginv_copied_sub_open'),
      });
      setInvites(await getGroupInvites(group.id));
    } catch {
      toast.show({ type: 'error', title: t('ginv_err_create') });
    } finally {
      setLoading(false);
    }
  };

  /**
   * "Invite them to Hisaab" for a guest seat.
   *
   * This is the SAME mechanism as assigning the seat, not a second one: the
   * invite carries `linked_member_id`, and accept_group_invite rebinds a
   * profile_id-NULL seat by that id (consent-guards.sql §3.5). So whoever opens
   * the link takes over this seat WITH its expenses and settlements, instead of
   * landing on a fresh row and orphaning the history.
   *
   * The number the seat was created with is NOT available here — add_group_guest
   * stores it only as a hash in a table no client can read — so the WhatsApp
   * link opens the contact picker rather than a pre-addressed chat.
   */
  const handleInviteGuest = (member: GroupMember) => {
    setLoading(true);
    void (async () => {
      try {
        const result = await createInvite(group.id, member.id);
        const text = buildGuestInviteText(member.name, group.name, result.url);
        await navigator.clipboard.writeText(result.url).catch(() => {});
        setInvites(await getGroupInvites(group.id));
        window.open(buildWhatsAppUrl(null, text), '_blank', 'noopener,noreferrer');
      } catch {
        toast.show({ type: 'error', title: t('ginv_err_create') });
      } finally {
        setLoading(false);
      }
    })();
  };

  const handleAddGuest = () => addGuard.run(async () => {
    const problem = validateGuestName(guestName, group.members);
    if (problem) {
      toast.show({ type: 'error', title: guestNameProblemMessage(problem) });
      return;
    }
    setLoading(true);
    try {
      const result = await addGroupGuest(group.id, guestName.trim(), guestPhone.trim() || undefined);
      if (result.status !== 'ok' && result.status !== 'ALREADY_ADDED') {
        toast.show({ type: 'error', title: guestRpcFailureMessage(result.status) });
        return;
      }
      setGuestName('');
      setGuestPhone('');
      toast.show({ type: 'success', title: t('guest_added'), subtitle: result.displayName ?? undefined });
    } catch {
      toast.show({ type: 'error', title: t('guest_err_generic') });
    } finally {
      setLoading(false);
    }
  });

  const handleRemoveGuest = (member: GroupMember) => removeGuard.run(async () => {
    setLoading(true);
    try {
      const result = await removeGroupGuest(group.id, member.id);
      if (result.status !== 'ok') {
        toast.show({ type: 'error', title: guestRpcFailureMessage(result.status) });
        return;
      }
      toast.show({ type: 'success', title: t('guest_removed'), subtitle: member.name });
    } catch {
      toast.show({ type: 'error', title: t('guest_err_generic') });
    } finally {
      setLoading(false);
    }
  });

  const openRenameGuest = (member: GroupMember) => {
    setRenameValue(member.name);
    setRenamingGuest(member);
  };

  const handleRenameGuest = () => renameGuard.run(async () => {
    if (!renamingGuest) return;
    const trimmed = renameValue.trim();
    setLoading(true);
    try {
      const result = await renameGroupGuest(group.id, renamingGuest.id, trimmed);
      if (result.status !== 'ok') {
        toast.show({ type: 'error', title: renameFailureMessage(t, result.status) });
        return;
      }
      toast.show({ type: 'success', title: t('guest_renamed'), subtitle: trimmed });
      setRenamingGuest(null);
    } catch {
      toast.show({ type: 'error', title: t('guest_err_generic') });
    } finally {
      setLoading(false);
    }
  });

  const inputClass = "w-full border border-cream-border rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all";

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={t('ginv_title')}
      footer={(
        <button
          onClick={() => handleCreateInvite(null)}
          disabled={loading}
          className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 flex items-center justify-center gap-2"
        >
          <Link2 size={16} /> {loading ? t('ginv_creating_link') : t('ginv_copy_link_cta')}
        </button>
      )}
    >
      <div className="p-5 space-y-4">
        <div className="rounded-2xl bg-accent-100/60 border border-cream-border px-4 py-3">
          <p className="text-[13px] font-semibold text-accent-600">{t('ginv_transparency_title')}</p>
          <p className="text-[12px] text-accent-600/80 mt-1">
            {t('ginv_transparency_body')}
          </p>
        </div>

        <div className="space-y-2">
          {group.members.map((member) => {
            const linkedInvite = inviteLookup.get(member.id);
            const guest = isGuestMember(member);
            return (
              <div key={member.id} className="rounded-2xl bg-cream-card border border-cream-border p-3">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-[12px] font-bold ${
                    member.isOwner ? 'bg-accent-100 text-accent-600' : 'bg-cream-soft text-ink-700'
                  }`}>
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-ink-800 truncate">{member.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full ${statusBadgeClass(member)}`}>
                        {statusLabel(t, member)}
                      </span>
                      {linkedInvite && (
                        <span className="text-[10px] text-ink-500 truncate">
                          {t('ginv_invite_ready')}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* A guest is status='connected', so the old
                      `status !== 'connected'` test would have hidden every
                      affordance for exactly the people who need one. */}
                  {!member.isOwner && (member.status !== 'connected' || guest) && (
                    <button
                      onClick={() => (guest ? handleInviteGuest(member) : void handleCreateInvite(member.id))}
                      disabled={loading}
                      className="shrink-0 rounded-xl bg-cream-soft text-ink-700 px-3 py-2 text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-40"
                    >
                      {guest ? <Send size={13} /> : linkedInvite ? <Copy size={13} /> : <UserPlus size={13} />}
                      {guest ? t('guest_invite_cta') : linkedInvite ? t('ginv_copy') : t('ginv_invite')}
                    </button>
                  )}
                </div>
                {guest && (
                  <div className="mt-2.5 pt-2.5 border-t border-cream-hairline flex items-center justify-between gap-3">
                    <p className="text-[10.5px] text-ink-500 leading-snug">{t('guest_assign_hint')}</p>
                    <div className="shrink-0 flex items-center gap-3">
                      {isOwner && (
                        <button
                          onClick={() => openRenameGuest(member)}
                          disabled={loading}
                          aria-label={t('guest_rename_cta')}
                          className="text-ink-500 active:opacity-60 disabled:opacity-40"
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                      <button
                        onClick={() => handleRemoveGuest(member)}
                        disabled={loading}
                        className="text-[11px] font-semibold text-pay-text active:opacity-60 flex items-center gap-1 disabled:opacity-40"
                      >
                        <Trash2 size={12} /> {t('guest_remove_cta')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Add someone who is not on Hisaab (audit G6 / O4) ───────────────
            Any CONNECTED member may do this, not just the owner — see the
            migration's §0b. Nothing about it touches accounts in either app
            mode; a guest is a ledger seat, never a money movement. */}
        <div className="rounded-2xl bg-cream-card border border-cream-border p-3.5">
          <p className="text-[12px] font-bold text-ink-800">{t('guest_add_cta')}</p>
          <p className="text-[11px] text-ink-500 mt-1">{t('guest_add_hint')}</p>
          <div className="flex gap-2 mt-2.5">
            <input
              className={inputClass}
              value={guestName}
              maxLength={MAX_GUEST_NAME_LENGTH}
              onChange={(e) => setGuestName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddGuest(); } }}
              placeholder={t('guest_name_placeholder')}
            />
            <button
              onClick={handleAddGuest}
              disabled={loading || !guestName.trim() || guestCount >= MAX_GROUP_GUESTS}
              className="shrink-0 w-11 h-11 rounded-2xl bg-cream-soft flex items-center justify-center active:scale-95 transition-all disabled:opacity-40"
              aria-label={t('guest_add_cta')}
            >
              <UserRoundPlus size={17} className="text-ink-700" />
            </button>
          </div>
          <input
            className={inputClass + ' mt-2'}
            value={guestPhone}
            onChange={(e) => setGuestPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddGuest(); } }}
            placeholder={t('guest_phone_placeholder')}
            inputMode="tel"
            autoComplete="off"
          />
          <p className="text-[11px] text-ink-500 mt-2">{t('guest_phone_hint')}</p>
        </div>
      </div>
    </Modal>

    {/* Rename sheet (docs/guest-members.md §9.4). Owner-only, unclaimed
        guest seats only — see the isOwner gate on the pencil button above. */}
    <Modal
      open={!!renamingGuest}
      onClose={() => setRenamingGuest(null)}
      title={t('guest_rename_title')}
      footer={(
        <button
          onClick={handleRenameGuest}
          disabled={loading || !renameValue.trim()}
          className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30"
        >
          {t('save')}
        </button>
      )}
    >
      <div className="p-5">
        <input
          className={inputClass}
          value={renameValue}
          maxLength={40}
          autoFocus
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleRenameGuest(); } }}
          placeholder={t('guest_name_placeholder')}
        />
      </div>
    </Modal>
    </>
  );
}
