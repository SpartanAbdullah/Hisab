import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';

interface Props {
  open: boolean;
  onClose: () => void;
}

type ParsedInput =
  | { kind: 'invite'; token: string }
  | { kind: 'group_code'; code: string }
  | { kind: 'invalid' };

// Accepts three input shapes:
//   1. Full invite URL (https://…/join/<token>) — matches older invite links.
//   2. Raw invite token (24-char alphanumeric).
//   3. Group join code (GRP-XXXXXX or XXXXXX) — the new primary flow.
// Heuristic: `GRP-` prefix or 6-char-ish uppercase string → group code;
// anything longer and URL-like → invite token.
function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'invalid' };

  const urlMatch = trimmed.match(/\/join\/([^/?#\s]+)/);
  if (urlMatch) return { kind: 'invite', token: urlMatch[1] };

  // Strip common prefixes to judge length.
  const stripped = trimmed.replace(/^@/, '').replace(/[-_\s]/g, '').toUpperCase();
  if (/^GRP/.test(trimmed.toUpperCase()) || stripped.length <= 10) {
    return { kind: 'group_code', code: trimmed };
  }
  if (/^[A-Za-z0-9]{12,64}$/.test(stripped)) {
    return { kind: 'invite', token: trimmed };
  }
  return { kind: 'invalid' };
}

export function JoinGroupModal({ open, onClose }: Props) {
  const toast = useToast();
  const navigate = useNavigate();
  const { acceptInvite, joinGroupByCode } = useSplitStore();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleJoin = async () => {
    const parsed = parseInput(input);
    if (parsed.kind === 'invalid') {
      toast.show({
        type: 'error',
        title: 'Invalid input',
        subtitle: 'Paste a group code (GRP-…) or an invite link.',
      });
      return;
    }
    setLoading(true);
    try {
      const result = parsed.kind === 'group_code'
        ? await joinGroupByCode(parsed.code)
        : await acceptInvite(parsed.token);
      toast.show({ type: 'success', title: 'Joined group' });
      setInput('');
      onClose();
      navigate(`/group/${result.groupId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to join';
      toast.show({ type: 'error', title: 'Could not join', subtitle: message });
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Join a Group"
      footer={(
        <button
          onClick={handleJoin}
          disabled={loading || !input.trim()}
          className="w-full btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 flex items-center justify-center gap-2"
        >
          <Link2 size={16} /> {loading ? 'Joining...' : 'Join Group'}
        </button>
      )}
    >
      <div className="p-5 space-y-4">
        <div className="rounded-2xl bg-indigo-50/60 border border-indigo-100/70 px-4 py-3">
          <p className="text-[13px] font-semibold text-indigo-700">Have a group code or invite?</p>
          <p className="text-[12px] text-indigo-600/80 mt-1">
            Enter the group code (e.g. <span className="font-mono">GRP-ABC123</span>) the owner shared with you, or paste an invite link.
          </p>
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            Group Code or Invite Link
          </label>
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleJoin(); } }}
            placeholder="GRP-ABC123  or  https://…/join/…"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass + ' mt-1.5 font-mono text-[12px]'}
          />
        </div>
      </div>
    </Modal>
  );
}
