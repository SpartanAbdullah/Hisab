import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, Info, AlertTriangle, Search, KeyRound, ArrowLeft, Users, Archive } from 'lucide-react';
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
import { track } from '../lib/telemetry';
import { groupsLookupDb } from '../lib/supabaseDb';
import { normalizeGroupCode } from '../lib/collaboration';
import {
  groupPreviewMessageKey,
  previewIsSoftFailure,
  type GroupPreview,
} from '../lib/groupPreview';

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
  // Two-step flow: first "Find group" resolves the input, then a second
  // deliberate "Join this group" tap actually joins.
  //
  // Audit 2026-09 UX-18: the confirm step used to echo back the code the user
  // had just typed — zero new information — because strict RLS blocks reading
  // a split_groups row you are not yet a member of. It now calls the
  // SECURITY DEFINER preview RPC (supabase-migration-p1-group-preview.sql)
  // and shows the group's name, emoji, member count, currency and owner
  // BEFORE the user broadcasts their profile name to strangers.
  const [confirming, setConfirming] = useState<ParsedInput | null>(null);
  const [preview, setPreview] = useState<GroupPreview | null>(null);
  // Set when the preview came back with a reason the join cannot succeed
  // (archived group). The confirm card still renders — the user should see
  // WHICH group it was — but the Join button is withheld.
  const [previewBlocked, setPreviewBlocked] = useState(false);
  const [finding, setFinding] = useState(false);
  const joinGuard = useSubmitGuard();
  const findGuard = useSubmitGuard();

  const resetConfirm = () => {
    setConfirming(null);
    setPreview(null);
    setPreviewBlocked(false);
  };

  const handleClose = () => {
    setInput('');
    setSubmitError(null);
    resetConfirm();
    onClose();
  };

  // Step 1 — resolve/validate the input into a confirmable target, and (for a
  // group code) fetch the preview. Guarded like the join step: each preview
  // MISS is charged to join_group_by_code's own rate window, so a double tap
  // must not spend two attempts.
  const handleFind = () => findGuard.run(runFind);
  const runFind = async () => {
    setSubmitError(null);
    const parsed = parseInput(input);
    if (parsed.kind === 'invalid') {
      setSubmitError(t('join_error_invalid'));
      return;
    }

    // Invite links have no preview RPC of their own — they resolve a token,
    // not a code — so they keep the legacy echo confirm.
    if (parsed.kind !== 'group_code') {
      setPreview(null);
      setPreviewBlocked(false);
      setConfirming(parsed);
      return;
    }

    setFinding(true);
    try {
      const result = await groupsLookupDb.previewByCode(normalizeGroupCode(parsed.code));

      if (result.status === 'ok') {
        setPreview(result.preview);
        setPreviewBlocked(false);
        setConfirming(parsed);
        return;
      }

      if (result.status === 'GROUP_ARCHIVED') {
        // Real group, real code — but joins are closed. Show what it is and
        // why, and withhold the Join button rather than letting the join RPC
        // fail with a raw error.
        setPreview('preview' in result ? result.preview : null);
        setPreviewBlocked(true);
        setConfirming(parsed);
        setSubmitError(t(groupPreviewMessageKey(result.status)));
        return;
      }

      if (previewIsSoftFailure(result.status)) {
        // An un-migrated database or a flaky network must never stop someone
        // joining a group whose code they legitimately hold: fall back to the
        // pre-UX-18 blind confirm rather than blocking.
        setPreview(null);
        setPreviewBlocked(false);
        setConfirming(parsed);
        return;
      }

      // A real answer about the code (not found / expired / rate limited /
      // your own group). Stay on the lookup step so the user can fix it —
      // and never advance to a confirm card for a code that cannot work.
      setSubmitError(t(groupPreviewMessageKey(result.status)));
      resetConfirm();
    } finally {
      setFinding(false);
    }
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
          resetConfirm();
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
          resetConfirm();
          return;
        }
        groupId = outcome.groupId;
      }
      // Catalog #18. `via` distinguishes the two redemption paths (they have
      // separate rate windows and, we suspect, very different conversion).
      track('group_joined', {
        via: confirming.kind === 'group_code' ? 'code' : 'link',
        surface: 'join_modal',
      });
      toast.show({
        type: 'success',
        title: t('join_success_title'),
        subtitle: t('join_success_subtitle'),
        duration: 5000,
      });
      setInput('');
      setSubmitError(null);
      resetConfirm();
      onClose();
      navigate(`/group/${groupId}`);
    } catch (error) {
      setSubmitError(t(inviteStatusMessageKey(inviteStatusFromThrown(error))));
      // Drop back to the lookup step so the user can fix the code.
      resetConfirm();
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

  const inputClass = "w-full border border-cream-border rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 bg-cream-card transition-all";

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
            // No Join button for a group that cannot accept one (archived):
            // the only honest action left is to go back and use another code.
            previewBlocked ? null : (
              <button
                onClick={handleJoin}
                disabled={loading}
                className="w-full bg-accent-600 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 flex items-center justify-center gap-2 shadow-md shadow-accent-600/20 min-h-[44px]"
              >
                <Link2 size={16} />
                {loading ? t('join_modal_joining') : t('join_confirm_cta')}
              </button>
            )
          ) : (
            <button
              onClick={handleFind}
              disabled={loading || finding || !input.trim()}
              className="w-full bg-accent-600 text-white rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 flex items-center justify-center gap-2 shadow-md shadow-accent-600/20 min-h-[44px]"
            >
              <Search size={16} />
              {finding ? t('join_finding') : t('join_find_cta')}
            </button>
          )}
        </div>
      )}
    >
      {confirming ? (
        // Step 2 — confirm card. UX-18: when the preview RPC answered, this
        // shows the actual group (name, emoji, members, currency, owner)
        // instead of echoing back the code the user just typed.
        <div className="space-y-4">
          {preview ? (
            <div className={`rounded-2xl border p-4 ${preview.isArchived ? 'bg-cream-soft border-cream-border' : 'bg-accent-50 border-accent-100'}`}>
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-cream-card flex items-center justify-center shrink-0 text-[20px] leading-none">
                  {preview.emoji || <Users size={18} className="text-accent-600" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold text-ink-500 uppercase tracking-widest">
                    {preview.isArchived ? t('join_preview_archived_label') : t('join_preview_label')}
                  </p>
                  <p className="text-[16px] font-bold text-ink-900 tracking-tight truncate mt-0.5">
                    {preview.name}
                  </p>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-cream-hairline space-y-1.5">
                <p className="text-[12px] text-ink-600 leading-snug">
                  {t('join_preview_owner').replace('{name}', preview.ownerDisplayName)}
                </p>
                <p className="text-[12px] text-ink-600 leading-snug">
                  {(preview.memberCount === 1 ? t('join_preview_members_one') : t('join_preview_members'))
                    .replace('{n}', String(preview.memberCount))}
                  {preview.currency ? ` · ${preview.currency}` : ''}
                </p>
              </div>
              {preview.isArchived && (
                <p className="mt-3 flex items-start gap-1.5 text-[11.5px] font-semibold text-ink-600 leading-snug">
                  <Archive size={13} className="shrink-0 mt-0.5" />
                  {t('join_preview_archived_body')}
                </p>
              )}
            </div>
          ) : (
            // Fallback for invite links (no preview RPC) and for a database
            // where supabase-migration-p1-group-preview.sql hasn't been applied
            // yet: the pre-UX-18 echo, plus an honest line saying so.
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
          )}
          <p className="text-[12px] text-ink-500 leading-relaxed px-1">
            {preview
              ? preview.isArchived ? t('join_preview_archived_help') : t('join_preview_double_check')
              : t('join_double_check')}
          </p>
          {!preview && confirming.kind === 'group_code' && (
            <p className="text-[11px] text-ink-400 leading-relaxed px-1">
              {t('join_preview_unavailable')}
            </p>
          )}
          <button
            type="button"
            onClick={() => { resetConfirm(); setSubmitError(null); }}
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
