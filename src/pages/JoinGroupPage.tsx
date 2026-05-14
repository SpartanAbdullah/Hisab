import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Link2, Users } from 'lucide-react';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';

type InviteFailureKind = 'not_found' | 'expired' | 'group_gone' | 'auth' | 'network' | 'unknown';

interface InviteFailure {
  kind: InviteFailureKind;
  title: string;
  message: string;
  canRetry: boolean;
}

// Map whatever acceptInvite() threw into a human message. Keeps the UI copy
// in one place so invite errors don't drift between toast and inline state.
function classifyInviteError(err: unknown): InviteFailure {
  const raw = err instanceof Error ? err.message : '';
  const lower = raw.toLowerCase();

  if (lower.includes('invite not found')) {
    return {
      kind: 'not_found',
      title: 'Invite link not valid',
      message: "This invite doesn't exist anymore. Ask the group owner to send a fresh link.",
      canRetry: false,
    };
  }
  if (lower.includes('invite expired')) {
    return {
      kind: 'expired',
      title: 'Invite expired',
      message: 'This invite is past its expiry. Ask the group owner to generate a new one.',
      canRetry: false,
    };
  }
  if (lower.includes('group not found')) {
    return {
      kind: 'group_gone',
      title: 'Group no longer exists',
      message: "The group this invite pointed to has been deleted. There's nothing to join.",
      canRetry: false,
    };
  }
  if (lower.includes('not authenticated')) {
    return {
      kind: 'auth',
      title: 'Sign in first',
      message: 'You need to be signed in before you can accept this invite.',
      canRetry: false,
    };
  }
  if (/network|failed to fetch|load failed/i.test(raw)) {
    return {
      kind: 'network',
      title: 'Connection problem',
      message: "We couldn't reach the server. Check your connection and try again.",
      canRetry: true,
    };
  }
  return {
    kind: 'unknown',
    title: 'Could not join this group',
    message: raw || "Something unexpected went wrong. You can try again or ask for a new invite.",
    canRetry: true,
  };
}

export function JoinGroupPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { acceptInvite } = useSplitStore();
  const [loading, setLoading] = useState(false);
  const [joined, setJoined] = useState(false);
  const [failure, setFailure] = useState<InviteFailure | null>(null);

  const handleJoin = async () => {
    if (!token) return;
    setLoading(true);
    setFailure(null);
    try {
      const result = await acceptInvite(token);
      localStorage.removeItem('hisaab_pending_invite');
      setJoined(true);
      toast.show({ type: 'success', title: 'Group joined', subtitle: 'You can now see shared updates.' });
      setTimeout(() => navigate(`/group/${result.groupId}`, { replace: true }), 450);
    } catch (error) {
      const classified = classifyInviteError(error);
      setFailure(classified);
      // Only toast for retry-able cases; persistent failures are shown inline
      // and would otherwise produce duplicate messaging that vanishes mid-read.
      if (classified.canRetry) {
        toast.show({ type: 'error', title: classified.title, subtitle: classified.message });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-mesh flex items-center justify-center px-5">
      <div className="w-full max-w-md rounded-2xl bg-cream-card border border-cream-border p-6 text-center">
        <div className={`mx-auto w-16 h-16 rounded-3xl flex items-center justify-center ${
          joined
            ? 'bg-receive-50 text-receive-text'
            : failure
              ? 'bg-pay-50 text-pay-text'
              : 'bg-accent-100 text-accent-600'
        }`}>
          {joined
            ? <CheckCircle2 size={28} />
            : failure
              ? <AlertTriangle size={28} />
              : <Users size={28} />}
        </div>

        <h1 className="text-xl font-bold tracking-tight text-ink-900 mt-4">
          {joined ? 'You are in' : failure ? failure.title : 'Join shared group'}
        </h1>
        <p className="text-sm text-ink-500 mt-2 leading-relaxed">
          {joined
            ? 'Opening the group now so you can see expenses, edits, deletes, and settlements.'
            : failure
              ? failure.message
              : 'This invite will connect your account to a shared Hisaab group and keep you updated on every change.'}
        </p>

        {!joined && !failure && (
          <div className="rounded-2xl bg-cream-soft border border-cream-border/70 px-4 py-3 mt-5 text-left">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-white border border-cream-border/70 flex items-center justify-center shrink-0">
                <Link2 size={16} className="text-ink-500" />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-ink-800">What happens next</p>
                <p className="text-[12px] text-ink-500 mt-1">
                  You will be attached to the group as a connected member and receive in-app updates whenever someone adds, edits, deletes, or settles an expense.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 flex gap-2">
          <button
            onClick={() => navigate('/groups')}
            className="flex-1 rounded-2xl py-3 text-sm font-semibold bg-cream-soft text-ink-700"
          >
            {failure && !failure.canRetry ? 'Back to groups' : 'Not now'}
          </button>
          {(!failure || failure.canRetry) && (
            <button
              onClick={handleJoin}
              disabled={loading || !token || joined}
              className="flex-1 rounded-2xl py-3 text-sm font-bold bg-ink-900 text-white disabled:opacity-40"
            >
              {loading ? 'Joining...' : joined ? 'Opening...' : failure ? 'Try again' : 'Join group'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
