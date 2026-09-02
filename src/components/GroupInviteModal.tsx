import { useEffect, useMemo, useState } from 'react';
import { Copy, Link2, UserPlus } from 'lucide-react';
import { Modal } from './Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import type { GroupInvite, SplitGroup } from '../db';

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
function statusLabel(t: ReturnType<typeof useT>, status?: string, isOwner?: boolean): string {
  if (isOwner) return t('member_owner');
  if (status === 'connected') return t('member_on_app');
  if (status === 'invited') return t('member_invited');
  return t('member_not_on_app');
}

function statusBadgeClass(status?: string) {
  if (status === 'connected') return 'bg-receive-50 text-receive-text';
  if (status === 'invited') return 'bg-warn-50 text-warn-600';
  return 'bg-cream-soft text-ink-500';
}

export function GroupInviteModal({ open, group, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const { createInvite, getGroupInvites } = useSplitStore();
  const [loading, setLoading] = useState(false);
  const [invites, setInvites] = useState<GroupInvite[]>([]);

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

  return (
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
            const status = member.status ?? (member.profileId ? 'connected' : 'guest');
            return (
              <div key={member.id} className="rounded-2xl bg-cream-card border border-cream-border p-3 flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-[12px] font-bold ${
                  member.isOwner ? 'bg-accent-100 text-accent-600' : 'bg-cream-soft text-ink-700'
                }`}>
                  {member.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-ink-800 truncate">{member.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full ${statusBadgeClass(status)}`}>
                      {statusLabel(t, status, member.isOwner)}
                    </span>
                    {linkedInvite && (
                      <span className="text-[10px] text-ink-500 truncate">
                        {t('ginv_invite_ready')}
                      </span>
                    )}
                  </div>
                </div>
                {status !== 'connected' && (
                  <button
                    onClick={() => handleCreateInvite(member.id)}
                    disabled={loading}
                    className="shrink-0 rounded-xl bg-cream-soft text-ink-700 px-3 py-2 text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-40"
                  >
                    {linkedInvite ? <Copy size={13} /> : <UserPlus size={13} />}
                    {linkedInvite ? t('ginv_copy') : t('ginv_invite')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
