import { useEffect, useMemo, useState } from 'react';
import { Copy, Link2, UserPlus } from 'lucide-react';
import { Modal } from './Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from './Toast';
import type { GroupInvite, SplitGroup } from '../db';

interface Props {
  open: boolean;
  group: SplitGroup;
  onClose: () => void;
}

function statusBadgeClass(status?: string) {
  if (status === 'connected') return 'bg-emerald-50 text-emerald-600';
  if (status === 'invited') return 'bg-amber-50 text-amber-600';
  return 'bg-slate-100 text-slate-500';
}

export function GroupInviteModal({ open, group, onClose }: Props) {
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
        title: 'Invite link copied',
        subtitle: linkedMemberId ? 'Share it with that member to connect them.' : 'Anyone with the link can join this group.',
      });
      setInvites(await getGroupInvites(group.id));
    } catch {
      toast.show({ type: 'error', title: 'Could not create invite' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite Members"
      footer={(
        <button
          onClick={() => handleCreateInvite(null)}
          disabled={loading}
          className="w-full btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 flex items-center justify-center gap-2"
        >
          <Link2 size={16} /> {loading ? 'Creating link...' : 'Copy group invite link'}
        </button>
      )}
    >
      <div className="p-5 space-y-4">
        <div className="rounded-2xl bg-indigo-50/60 border border-indigo-100/70 px-4 py-3">
          <p className="text-[13px] font-semibold text-indigo-700">Transparency stays inside the group</p>
          <p className="text-[12px] text-indigo-600/80 mt-1">
            Connected members will see shared expense adds, edits, deletes, and settlements, but not each other&apos;s private accounts.
          </p>
        </div>

        <div className="space-y-2">
          {group.members.map((member) => {
            const linkedInvite = inviteLookup.get(member.id);
            const status = member.status ?? (member.profileId ? 'connected' : 'guest');
            return (
              <div key={member.id} className="card-premium p-3 flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-[12px] font-bold ${
                  member.isOwner ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600'
                }`}>
                  {member.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-slate-700 truncate">{member.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full ${statusBadgeClass(status)}`}>
                      {status}
                    </span>
                    {linkedInvite && (
                      <span className="text-[10px] text-slate-400 truncate">
                        Invite ready
                      </span>
                    )}
                  </div>
                </div>
                {status !== 'connected' && (
                  <button
                    onClick={() => handleCreateInvite(member.id)}
                    disabled={loading}
                    className="shrink-0 rounded-xl bg-slate-100 text-slate-600 px-3 py-2 text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-40"
                  >
                    {linkedInvite ? <Copy size={13} /> : <UserPlus size={13} />}
                    {linkedInvite ? 'Copy' : 'Invite'}
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
