import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, Info, AlertTriangle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';

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
//   3. Group join code (GRP-XXXXXX or XXXXXX) — the primary flow.
// Heuristic: `GRP-` prefix or <=10 stripped chars → group code;
// anything longer and URL-like → invite token.
function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'invalid' };

  const urlMatch = trimmed.match(/\/join\/([^/?#\s]+)/);
  if (urlMatch) return { kind: 'invite', token: urlMatch[1] };

  const stripped = trimmed.replace(/^@/, '').replace(/[-_\s]/g, '').toUpperCase();
  if (/^GRP/.test(trimmed.toUpperCase()) || stripped.length <= 10) {
    return { kind: 'group_code', code: trimmed };
  }
  if (/^[A-Za-z0-9]{12,64}$/.test(stripped)) {
    return { kind: 'invite', token: trimmed };
  }
  return { kind: 'invalid' };
}

// Map backend error messages to user-friendly keys. Kept narrow and explicit
// so a new failure mode surfaces the raw message instead of being silently
// lumped under "unknown".
function classifyJoinError(err: unknown, tFn: (key: string) => string): string {
  const raw = err instanceof Error ? err.message : '';
  const lower = raw.toLowerCase();
  if (lower.includes('group code not found') || lower.includes('invite not found')) {
    return tFn('join_error_not_found');
  }
  if (lower.includes('invite expired')) {
    return tFn('join_error_expired');
  }
  if (lower.includes('not authenticated')) {
    return tFn('join_error_auth');
  }
  if (/network|failed to fetch|load failed/i.test(raw)) {
    return tFn('join_error_network');
  }
  return raw || tFn('join_error_not_found');
}

export function JoinGroupModal({ open, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { acceptInvite, joinGroupByCode } = useSplitStore();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleClose = () => {
    setInput('');
    setSubmitError(null);
    onClose();
  };

  const handleJoin = async () => {
    setSubmitError(null);
    const parsed = parseInput(input);
    if (parsed.kind === 'invalid') {
      setSubmitError(t('join_error_invalid'));
      return;
    }
    setLoading(true);
    try {
      const result = parsed.kind === 'group_code'
        ? await joinGroupByCode(parsed.code)
        : await acceptInvite(parsed.token);
      toast.show({
        type: 'success',
        title: t('join_success_title'),
        subtitle: t('join_success_subtitle'),
        duration: 5000,
      });
      setInput('');
      setSubmitError(null);
      onClose();
      navigate(`/group/${result.groupId}`);
    } catch (error) {
      const message = classifyJoinError(error, t);
      setSubmitError(message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "w-full border border-slate-200/60 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white transition-all";

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t('join_modal_title')}
      footer={(
        <div className="space-y-2.5">
          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 bg-red-50 border border-red-200/70 rounded-xl px-3 py-2.5"
            >
              <AlertTriangle size={14} className="text-red-500 shrink-0 mt-0.5" />
              <p className="text-[12px] font-medium text-red-600 leading-snug">{submitError}</p>
            </div>
          )}
          <button
            onClick={handleJoin}
            disabled={loading || !input.trim()}
            className="w-full btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 flex items-center justify-center gap-2 shadow-md shadow-indigo-500/20"
          >
            <Link2 size={16} />
            {loading ? t('join_modal_joining') : t('join_modal_submit')}
          </button>
        </div>
      )}
    >
      <div className="p-5 space-y-4">
        <div className="rounded-2xl bg-indigo-50/60 border border-indigo-100/70 px-4 py-3 flex items-start gap-3">
          <div className="w-8 h-8 rounded-xl bg-white flex items-center justify-center shrink-0">
            <Info size={14} className="text-indigo-500" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-indigo-700">{t('join_modal_hint_title')}</p>
            <p className="text-[12px] text-indigo-600/80 mt-1 leading-relaxed">
              {t('join_modal_hint_body')}
            </p>
          </div>
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            {t('join_modal_label')}
          </label>
          <input
            autoFocus
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (submitError) setSubmitError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleJoin();
              }
            }}
            placeholder={t('join_modal_placeholder')}
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
