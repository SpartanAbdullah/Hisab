import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, Info, AlertTriangle, Search, KeyRound, ArrowLeft } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useSplitStore } from '../stores/splitStore';
import { useToast } from '../components/Toast';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import {
  inviteStatusFromThrown,
  inviteStatusMessageKey,
  joinStatusMessageKey,
} from '../lib/joinCodeStatus';

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

// NOTE: neither branch throws for a business outcome any more. Both
// join_group_by_code (audit C5) and accept_group_invite (audit H3) return a
// jsonb status object, because a RAISE rolled back the very rate-limit ledger
// row each limiter counts. The catch below is the transport/unexpected path
// only, and it routes through the invite vocabulary — the last remaining thing
// that can throw here is an unexpected failure inside the store.

export function JoinGroupModal({ open, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { acceptInvite, joinGroupByCode } = useSplitStore();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Two-step flow: first "Find group" validates + parses the code into a
  // confirmation, then a second deliberate "Join this group" tap actually
  // joins. Group metadata (emoji/name/members) can't be previewed before
  // joining — strict RLS blocks reading a group you're not yet a member of —
  // so the confirm step echoes the verified code + its kind instead.
  const [confirming, setConfirming] = useState<ParsedInput | null>(null);
  const joinGuard = useSubmitGuard();

  const handleClose = () => {
    setInput('');
    setSubmitError(null);
    setConfirming(null);
    onClose();
  };

  // Step 1 — resolve/validate the input into a confirmable target.
  const handleFind = () => {
    setSubmitError(null);
    const parsed = parseInput(input);
    if (parsed.kind === 'invalid') {
      setSubmitError(t('join_error_invalid'));
      return;
    }
    setConfirming(parsed);
  };

  // Step 2 — commit the join for the already-confirmed target. Guarded so a
  // double tap can't fire two redemptions (each counts against a rate window).
  const handleJoin = () => joinGuard.run(runJoin);
  const runJoin = async () => {
    if (!confirming || confirming.kind === 'invalid') return;
    setSubmitError(null);
    setLoading(true);
    try {
      let groupId: string;
      if (confirming.kind === 'group_code') {
        // Failures arrive as data now, so RATE_LIMITED gets its own message
        // instead of being lumped in with "code not found".
        const outcome = await joinGroupByCode(confirming.code);
        if (outcome.status !== 'ok') {
          setSubmitError(t(joinStatusMessageKey(outcome.status)));
          setConfirming(null);
          return;
        }
        groupId = outcome.groupId;
      } else {
        // Invite links carry their own status vocabulary (a separate rate
        // window: 10 failed redemptions per 15 minutes, vs 5 wrong codes per
        // 5 minutes), so they get their own messages rather than the code ones.
        const outcome = await acceptInvite(confirming.token);
        if (outcome.status !== 'ok') {
          setSubmitError(t(inviteStatusMessageKey(outcome.status)));
          setConfirming(null);
          return;
        }
        groupId = outcome.groupId;
      }
      toast.show({
        type: 'success',
        title: t('join_success_title'),
        subtitle: t('join_success_subtitle'),
        duration: 5000,
      });
      setInput('');
      setSubmitError(null);
      setConfirming(null);
      onClose();
      navigate(`/group/${groupId}`);
    } catch (error) {
      setSubmitError(t(inviteStatusMessageKey(inviteStatusFromThrown(error))));
      // Drop back to the lookup step so the user can fix the code.
      setConfirming(null);
    } finally {
      setLoading(false);
    }
  };

  // Human-readable echo of what was resolved, for the confirm card.
  const confirmTarget = confirming && confirming.kind !== 'invalid'
    ? confirming.kind === 'group_code'
      ? confirming.code.trim()
      : 'Invite link'
    : '';

  const inputClass = "w-full border border-cream-border rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-accent-500 bg-cream-card transition-all";

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
              className="flex items-start gap-2 bg-pay-50 border border-pay-100 rounded-xl px-3 py-2.5"
            >
              <AlertTriangle size={14} className="text-pay-text shrink-0 mt-0.5" />
              <p className="text-[12px] font-medium text-pay-text leading-snug">{submitError}</p>
            </div>
          )}
          {confirming ? (
            <button
              onClick={handleJoin}
              disabled={loading}
              className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 flex items-center justify-center gap-2 shadow-md shadow-indigo-500/20 min-h-[44px]"
            >
              <Link2 size={16} />
              {loading ? t('join_modal_joining') : t('join_confirm_cta')}
            </button>
          ) : (
            <button
              onClick={handleFind}
              disabled={loading || !input.trim()}
              className="w-full bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 flex items-center justify-center gap-2 shadow-md shadow-indigo-500/20 min-h-[44px]"
            >
              <Search size={16} />
              {t('join_find_cta')}
            </button>
          )}
        </div>
      )}
    >
      {confirming ? (
        // Step 2 — confirm card. Echoes the verified code/kind so the user
        // takes a deliberate second tap before actually joining.
        <div className="space-y-4">
          <div className="rounded-2xl bg-accent-50 border border-accent-100 p-4 flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-cream-card flex items-center justify-center shrink-0">
              {confirming.kind === 'group_code'
                ? <KeyRound size={18} className="text-accent-600" />
                : <Link2 size={18} className="text-accent-600" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-ink-500 uppercase tracking-widest">{t('join_ready')}</p>
              <p className="text-[15px] font-bold text-ink-900 font-mono tracking-tight truncate mt-0.5">
                {confirmTarget}
              </p>
            </div>
          </div>
          <p className="text-[12px] text-ink-500 leading-relaxed px-1">
            {t('join_double_check')}
          </p>
          <button
            type="button"
            onClick={() => { setConfirming(null); setSubmitError(null); }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-500 active:opacity-60 disabled:opacity-40 min-h-[44px]"
          >
            <ArrowLeft size={14} />
            {t('join_use_different')}
          </button>
        </div>
      ) : (
        // Step 1 — lookup.
        <div className="space-y-4">
          <div className="rounded-2xl bg-accent-100/60 border border-cream-border px-4 py-3 flex items-start gap-3">
            <div className="w-8 h-8 rounded-xl bg-cream-card flex items-center justify-center shrink-0">
              <Info size={14} className="text-accent-600" />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-accent-600">{t('join_modal_hint_title')}</p>
              <p className="text-[12px] text-accent-600/80 mt-1 leading-relaxed">
                {t('join_modal_hint_body')}
              </p>
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">
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
                  handleFind();
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
      )}
    </Modal>
  );
}
