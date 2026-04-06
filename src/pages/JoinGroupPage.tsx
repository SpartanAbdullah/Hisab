import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Link2, Users } from 'lucide-react';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';

export function JoinGroupPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { acceptInvite } = useSplitStore();
  const [loading, setLoading] = useState(false);
  const [joined, setJoined] = useState(false);

  const handleJoin = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const result = await acceptInvite(token);
      localStorage.removeItem('hisaab_pending_invite');
      setJoined(true);
      toast.show({ type: 'success', title: 'Group joined', subtitle: 'You can now see shared updates.' });
      setTimeout(() => navigate(`/group/${result.groupId}`, { replace: true }), 450);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to join this invite';
      toast.show({ type: 'error', title: 'Invite not available', subtitle: message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-mesh flex items-center justify-center px-5">
      <div className="w-full max-w-md card-premium p-6 text-center">
        <div className={`mx-auto w-16 h-16 rounded-3xl flex items-center justify-center ${
          joined ? 'bg-emerald-50 text-emerald-600' : 'bg-indigo-50 text-indigo-600'
        }`}>
          {joined ? <CheckCircle2 size={28} /> : <Users size={28} />}
        </div>

        <h1 className="text-xl font-bold tracking-tight text-slate-800 mt-4">
          {joined ? 'You are in' : 'Join shared group'}
        </h1>
        <p className="text-sm text-slate-500 mt-2 leading-relaxed">
          {joined
            ? 'Opening the group now so you can see expenses, edits, deletes, and settlements.'
            : 'This invite will connect your account to a shared Hisaab group and keep you updated on every change.'}
        </p>

        {!joined && (
          <div className="rounded-2xl bg-slate-50 border border-slate-200/70 px-4 py-3 mt-5 text-left">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-white border border-slate-200/70 flex items-center justify-center shrink-0">
                <Link2 size={16} className="text-slate-500" />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-slate-700">What happens next</p>
                <p className="text-[12px] text-slate-500 mt-1">
                  You will be attached to the group as a connected member and receive in-app updates whenever someone adds, edits, deletes, or settles an expense.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 flex gap-2">
          <button
            onClick={() => navigate('/groups')}
            className="flex-1 rounded-2xl py-3 text-sm font-semibold bg-slate-100 text-slate-600"
          >
            Not now
          </button>
          <button
            onClick={handleJoin}
            disabled={loading || !token || joined}
            className="flex-1 rounded-2xl py-3 text-sm font-bold btn-gradient disabled:opacity-40"
          >
            {loading ? 'Joining...' : joined ? 'Opening...' : 'Join group'}
          </button>
        </div>
      </div>
    </div>
  );
}
