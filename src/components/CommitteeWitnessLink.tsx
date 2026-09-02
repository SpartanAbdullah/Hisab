import { useState } from 'react';
import { format } from 'date-fns';
import { Copy, Eye, EyeOff, Link2, MessageCircle, ShieldAlert, Square, SquareCheck } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useCommitteeStore } from '../stores/committeeStore';
import { buildAppShareUrl } from '../lib/collaboration';
import { buildWhatsAppUrl } from '../lib/whatsappReminder';
import { witnessInitials, witnessLinkState } from '../lib/blockStatus';
import type { Committee, CommitteeMember } from '../db';

// ───────────────────────────────────────────────────────────────────────────
// Organiser controls for the public kameti witness link (audit M19 / UX-24).
//
// WHAT CHANGED, AND WHY THIS COMPONENT EXISTS AT ALL:
// the token used to be minted on the organiser's phone, stored in plaintext,
// never expired, and had no un-share path. `supabase-migration-p2-trust-safety`
// nulls the plaintext column and keeps only a SHA-256, so the app CANNOT
// display an existing link any more — it can only mint a new one, once, and
// hand it straight to the share sheet.
//
// Three consequences the UI has to be honest about:
//   1. A link the organiser shared before this migration STILL WORKS (it was
//      hashed in place) and now expires in 90 days — but we can't show it. So
//      "no link we can show you" is offered as *Create link*, and creating one
//      says out loud that it kills whatever is out there.
//   2. The raw token is displayed exactly once and is never stored — not in
//      the store, not in localStorage, not in the payout slip.
//   3. Revoke and expiry both make the link read exactly like a wrong one on
//      the witness page. That is deliberate, not a missing error state.
// ───────────────────────────────────────────────────────────────────────────

interface Props {
  committee: Committee;
  members: CommitteeMember[];
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => Promise.resolve());
  }
  return Promise.resolve();
}

export function CommitteeWitnessLink({ committee, members }: Props) {
  const t = useT();
  const toast = useToast();
  const rotateWitnessToken = useCommitteeStore((s) => s.rotateWitnessToken);
  const revokeWitnessToken = useCommitteeStore((s) => s.revokeWitnessToken);
  const setWitnessInitialsOnly = useCommitteeStore((s) => s.setWitnessInitialsOnly);

  // The minted URL lives ONLY here, in component state, for the life of this
  // sheet. It is never lifted into the store or persisted anywhere.
  const [minted, setMinted] = useState<{ url: string; replacedPrevious: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const rotateGuard = useSubmitGuard();
  const revokeGuard = useSubmitGuard();
  const initialsGuard = useSubmitGuard();

  const state = witnessLinkState({
    expiresAt: committee.witnessExpiresAt,
    revokedAt: committee.witnessRevokedAt,
  });
  const initialsOnly = committee.witnessInitialsOnly === true;
  const previewName = members[0]?.name ?? '';

  const stateLine =
    state === 'active' && committee.witnessExpiresAt
      ? t('kwt_state_active').replace('{date}', format(new Date(committee.witnessExpiresAt), 'd MMM yyyy'))
      : state === 'revoked'
        ? t('kwt_state_revoked')
        : state === 'expired'
          ? t('kwt_state_expired')
          : t('kwt_state_none');

  const handleRotate = () => rotateGuard.run(async () => {
    setBusy(true);
    try {
      const result = await rotateWitnessToken(committee.id);
      if (result.status !== 'ok') {
        toast.show({
          type: 'error',
          title: result.status === 'NOT_FOUND' ? t('kwt_not_organiser') : t('kwt_failed'),
        });
        return;
      }
      setMinted({
        url: `${buildAppShareUrl()}/kameti/witness/${result.token}`,
        replacedPrevious: result.replacedPrevious,
      });
    } finally {
      setBusy(false);
    }
  });

  const handleRevoke = () => revokeGuard.run(async () => {
    const ok = await confirmDestructive({
      title: t('kwt_revoke_confirm_title'),
      description: t('kwt_revoke_confirm_body'),
      confirmLabel: t('kwt_revoke_cta'),
      cancelLabel: t('cancel'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await revokeWitnessToken(committee.id);
      if (result.status !== 'ok') {
        toast.show({
          type: 'error',
          title: result.status === 'NOT_FOUND' ? t('kwt_not_organiser') : t('kwt_failed'),
        });
        return;
      }
      toast.show({ type: 'success', title: t('kwt_revoked_toast') });
    } finally {
      setBusy(false);
    }
  });

  const handleToggleInitials = () => initialsGuard.run(async () => {
    setBusy(true);
    try {
      await setWitnessInitialsOnly(committee.id, !initialsOnly);
    } catch {
      toast.show({ type: 'error', title: t('kwt_failed') });
    } finally {
      setBusy(false);
    }
  });

  const shareBody = minted
    ? t('kameti_witness_msg').replace('{committee}', committee.name).replace('{url}', minted.url)
    : '';

  return (
    <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
      <div className="flex items-center gap-2">
        <Eye size={16} className="text-ink-500 shrink-0" strokeWidth={2.2} />
        <p className="text-[13px] font-semibold text-ink-900">{t('kwt_section_title')}</p>
      </div>
      <p className="text-[11px] text-ink-500 mt-1">{stateLine}</p>

      {/* UX-24's privacy warning. Shown BEFORE the first share, not after — it
          is the thing that makes "forwarded to a family WhatsApp group" a
          decision rather than a surprise. */}
      <div className="mt-3 rounded-xl bg-cream-soft border border-cream-hairline p-3 space-y-1.5">
        <p className="text-[10px] font-bold text-ink-500 uppercase tracking-widest flex items-center gap-1.5">
          <ShieldAlert size={11} strokeWidth={2.4} /> {t('kwt_privacy_title')}
        </p>
        {[t('kwt_privacy_1'), t('kwt_privacy_2'), t('kwt_privacy_3')].map((line) => (
          <p key={line} className="text-[11px] text-ink-600 leading-relaxed">{line}</p>
        ))}
      </div>

      {/* Initials-only — a live preview, because "A.R." is only reassuring once
          you have seen it applied to a real member's name. */}
      <button
        type="button"
        onClick={handleToggleInitials}
        disabled={busy}
        aria-pressed={initialsOnly}
        className="w-full mt-3 flex items-start gap-2.5 rounded-xl bg-cream-soft border border-cream-hairline p-3 text-left disabled:opacity-50"
      >
        <span className="shrink-0 mt-[1px] text-ink-500">
          {initialsOnly ? <SquareCheck size={15} strokeWidth={2.4} /> : <Square size={15} strokeWidth={2.2} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold text-ink-900 flex items-center gap-1.5">
            <EyeOff size={11} className="text-ink-400" /> {t('kwt_initials_title')}
          </span>
          <span className="block text-[11px] text-ink-500 mt-0.5 leading-relaxed">{t('kwt_initials_sub')}</span>
          {previewName && (
            <span className="block text-[11px] text-ink-600 font-mono mt-1">
              {t('kwt_initials_preview')
                .replace('{name}', previewName)
                .replace('{initials}', witnessInitials(previewName))}
            </span>
          )}
        </span>
      </button>

      {state === 'active' && (
        <p className="text-[10.5px] text-ink-400 mt-3 leading-relaxed">{t('kwt_replace_warn')}</p>
      )}

      <button
        type="button"
        onClick={handleRotate}
        disabled={busy}
        className="w-full mt-2 py-3 rounded-2xl bg-ink-900 text-white text-[12.5px] font-bold flex items-center justify-center gap-2 disabled:opacity-50 press"
      >
        <Link2 size={14} /> {state === 'active' ? t('kwt_replace_cta') : t('kwt_create_cta')}
      </button>

      {state === 'active' && (
        <button
          type="button"
          onClick={handleRevoke}
          disabled={busy}
          className="w-full mt-2 py-3 rounded-2xl bg-pay-50 text-pay-text text-[12.5px] font-bold disabled:opacity-50 active:bg-pay-100 transition-colors"
        >
          {t('kwt_revoke_cta')}
        </button>
      )}

      {/* Show-once sheet. Closing it is the last moment this token exists on
          this device — there is no "show again". */}
      <Modal
        open={!!minted}
        onClose={() => setMinted(null)}
        title={t('kwt_token_once_title')}
        footer={
          <button
            type="button"
            onClick={() => setMinted(null)}
            className="w-full py-3 rounded-2xl bg-ink-900 text-white text-[13px] font-bold press"
          >
            {t('kwt_done_cta')}
          </button>
        }
      >
        <div className="space-y-3">
          <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('kwt_token_once_body')}</p>
          {minted?.replacedPrevious && (
            <p className="text-[11.5px] text-warn-600 bg-warn-50 border border-warn-100 rounded-xl p-2.5 leading-relaxed">
              {t('kwt_replaced_previous')}
            </p>
          )}
          <div className="rounded-xl bg-cream-soft border border-cream-hairline px-3 py-2.5">
            <p className="text-[10.5px] font-mono text-ink-700 break-all leading-snug">{minted?.url}</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={async () => {
                if (!minted) return;
                await copyText(minted.url);
                toast.show({ type: 'success', title: t('kwt_copied_toast') });
              }}
              className="flex-1 min-h-[44px] rounded-2xl bg-cream-soft border border-cream-border text-ink-700 text-[12.5px] font-semibold flex items-center justify-center gap-2 active:bg-cream-hairline transition-colors"
            >
              <Copy size={14} /> {t('kwt_copy_cta')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!minted) return;
                window.open(buildWhatsAppUrl(null, shareBody), '_blank', 'noopener,noreferrer');
              }}
              className="flex-1 min-h-[44px] rounded-2xl bg-receive-50 border border-receive-100 text-receive-text text-[12.5px] font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-all"
            >
              <MessageCircle size={14} /> {t('kwt_share_cta')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
