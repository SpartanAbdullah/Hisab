import { useEffect, useState } from 'react';
import { Link2, Copy, MessageCircle, ShieldOff, AlertTriangle, Lock } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { useKhataLinkStore } from '../stores/khataLinkStore';
import { daysUntilExpiry, formatKhataError } from '../lib/khataLinkStatus';
import { buildWhatsAppUrl, hasWhatsAppNumber } from '../lib/whatsappReminder';

// Owner-side control panel for one contact's public khata link (audit P3 / L2;
// 11-competitive-analysis O2 + G3).
//
// THREE THINGS ONLY: create/rotate, share, revoke. Everything else about the
// link lives on the server.
//
// WHY THE TOKEN IS NEVER CACHED: create_khata_link returns the raw token
// EXACTLY ONCE and stores only its SHA-256, so there is nothing to re-read.
// The store keeps it in memory while this sheet is open and drops it after —
// persisting a live capability URL to localStorage would undo the reason the
// token is hashed at rest in the first place. A user who loses it rotates,
// which is one tap and is the correct semantics for a capability.
//
// WHY ROTATING IS LOUD: a rotate kills the previous URL. Someone who already
// forwarded the old link over WhatsApp needs to be told, or they will simply
// see it stop opening.

interface Props {
  open: boolean;
  onClose: () => void;
  personId: string;
  personName: string;
  /** The contact's saved WhatsApp number, if any. Null → the contact picker. */
  phone?: string | null;
}

function copyWithFallback(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithTextarea(text));
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): Promise<void> {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  } finally {
    document.body.removeChild(textarea);
  }
}

export function ShareKhataLinkSheet({ open, onClose, personId, personName, phone = null }: Props) {
  const t = useT();
  const toast = useToast();
  const link = useKhataLinkStore((s) => s.links[personId] ?? null);
  const busy = useKhataLinkStore((s) => s.busyPersonId === personId);
  const error = useKhataLinkStore((s) => s.error);
  const createLink = useKhataLinkStore((s) => s.createLink);
  const revokeLink = useKhataLinkStore((s) => s.revokeLink);
  const forget = useKhataLinkStore((s) => s.forget);
  const clearError = useKhataLinkStore((s) => s.clearError);

  // Initials-only and show-notes are both chosen BEFORE minting, so the very
  // first link the user shares already honours them — asking afterwards
  // would mean rotating.
  const [initialsOnly, setInitialsOnly] = useState(false);
  // Off by default: a loan/payment note is free text the owner wrote for
  // themselves, not written with a forwardable public page in mind.
  const [showNotes, setShowNotes] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (open) {
      clearError();
      setInitialsOnly(link?.initialsOnly ?? false);
      setShowNotes(link?.showNotes ?? false);
    } else {
      // Drop the in-memory capability URL the moment the sheet closes.
      forget(personId);
    }
    // `link` is read only at open-time to seed the toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, personId]);

  const message = link
    ? t('khata_share_wa_text').replace('{name}', personName).replace('{url}', link.url)
    : '';
  const whatsappUrl = buildWhatsAppUrl(phone, message);
  const expiryDays = link ? daysUntilExpiry(link.expiresAt) : 0;

  const handleCreate = async () => {
    const created = await createLink(personId, initialsOnly, showNotes);
    if (!created) {
      toast.show({ type: 'error', title: formatKhataError({ status: useKhataLinkStore.getState().error }, t) });
    }
  };

  const handleRevoke = async () => {
    const ok = await revokeLink(personId);
    if (ok) {
      toast.show({ type: 'success', title: t('khata_share_revoked_toast') });
    } else {
      toast.show({ type: 'error', title: formatKhataError({ status: useKhataLinkStore.getState().error }, t) });
    }
  };

  const handleCopy = async () => {
    if (!link) return;
    setCopying(true);
    try {
      await copyWithFallback(link.url);
      toast.show({ type: 'success', title: t('khata_share_copied') });
    } catch {
      toast.show({ type: 'error', title: t('khata_share_copy_failed') });
    } finally {
      setCopying(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('khata_share_title')}
      footer={
        <div className="flex flex-col gap-2.5">
          {!link ? (
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy}
              className="w-full rounded-2xl py-3.5 text-sm font-bold text-white flex items-center justify-center gap-2 bg-accent-600 disabled:opacity-40 press"
            >
              <Link2 size={16} strokeWidth={2.2} /> {busy ? t('khata_share_working') : t('khata_share_create_cta')}
            </button>
          ) : (
            <>
              <div className="flex gap-2.5">
                <a
                  href={whatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => toast.show({ type: 'success', title: t('reminder_wa_opening') })}
                  className="flex-1 rounded-2xl py-3 text-[13px] font-bold flex items-center justify-center gap-2 press"
                  style={{ background: '#1FA855', color: '#fff' }}
                >
                  <MessageCircle size={14} /> {t('khata_share_whatsapp')}
                </a>
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={copying}
                  className="px-4 rounded-2xl py-3 text-[13px] font-bold bg-cream-soft text-ink-700 flex items-center justify-center gap-2 active:bg-cream-border disabled:opacity-30"
                >
                  <Copy size={14} /> {copying ? t('khata_share_working') : t('khata_share_copy')}
                </button>
              </div>
              <div className="flex gap-2.5">
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={busy}
                  className="flex-1 rounded-2xl py-2.5 text-[12px] font-bold bg-cream-soft text-ink-700 active:bg-cream-border disabled:opacity-30"
                >
                  {t('khata_share_rotate_cta')}
                </button>
                <button
                  type="button"
                  onClick={handleRevoke}
                  disabled={busy}
                  className="flex-1 rounded-2xl py-2.5 text-[12px] font-bold bg-pay-50 text-pay-text flex items-center justify-center gap-1.5 disabled:opacity-30 press"
                >
                  <ShieldOff size={13} strokeWidth={2.2} /> {t('khata_share_revoke_cta')}
                </button>
              </div>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-[12.5px] text-ink-700 leading-relaxed">
          {t('khata_share_desc').replace('{name}', personName)}
        </p>

        {/* Pre-mint options. Hidden once a link exists, because changing this
            afterwards requires a rotate — which the rotate button already is. */}
        {!link && (
          <div className="space-y-2">
            <label className="flex items-center justify-between gap-3 rounded-2xl bg-cream-card border border-cream-border px-4 py-3 cursor-pointer">
              <span className="text-[12.5px] font-semibold text-ink-800">
                {t('khata_share_initials_label')}
                <span className="block text-[10.5px] font-normal text-ink-500 mt-0.5">
                  {t('khata_share_initials_sub')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={initialsOnly}
                onChange={(e) => setInitialsOnly(e.target.checked)}
                className="w-4 h-4 accent-accent-600 shrink-0"
              />
            </label>

            {/* Off by default — notes are free text the owner wrote for
                themselves, not written with a forwardable page in mind. */}
            <label className="flex items-center justify-between gap-3 rounded-2xl bg-cream-card border border-cream-border px-4 py-3 cursor-pointer">
              <span className="text-[12.5px] font-semibold text-ink-800">
                {t('khata_share_notes_label')}
                <span className="block text-[10.5px] font-normal text-ink-500 mt-0.5">
                  {t('khata_share_notes_sub')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={showNotes}
                onChange={(e) => setShowNotes(e.target.checked)}
                className="w-4 h-4 accent-accent-600 shrink-0"
              />
            </label>
          </div>
        )}

        {/* The minted URL. Shown in full so the user can see exactly what they
            are about to send. */}
        {link && (
          <div>
            <p className="form-label">{t('khata_share_link_label')}</p>
            <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-3.5">
              <p className="text-[11.5px] text-ink-800 break-all leading-relaxed">{link.url}</p>
            </div>
            {expiryDays > 0 && (
              <p className="text-[10.5px] text-ink-500 mt-2 tabular-nums">
                {t('khata_share_expires').replace('{days}', String(expiryDays))}
              </p>
            )}
          </div>
        )}

        {/* A rotate silently killed a URL the user may already have sent. Say so. */}
        {link?.replacedPrevious && (
          <div className="flex items-start gap-2.5 rounded-2xl bg-warn-50 border border-warn-50 p-3">
            <AlertTriangle size={15} className="text-warn-700 shrink-0 mt-0.5" strokeWidth={2.2} />
            <p className="text-[11.5px] text-warn-700 leading-relaxed">{t('khata_share_replaced')}</p>
          </div>
        )}

        {/* What the link does and does not reveal — the honest version, shown
            before the share, not buried in a settings screen. */}
        <div className="rounded-2xl bg-cream-card border border-cream-border p-3.5 space-y-2">
          <div className="flex items-start gap-2.5">
            <Lock size={14} className="text-ink-500 shrink-0 mt-0.5" strokeWidth={2.2} />
            <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('khata_share_privacy')}</p>
          </div>
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={14} className="text-ink-500 shrink-0 mt-0.5" strokeWidth={2.2} />
            <p className="text-[11.5px] text-ink-600 leading-relaxed">{t('khata_share_capability_warning')}</p>
          </div>
        </div>

        {error && (
          <p className="text-[11.5px] text-pay-text leading-relaxed">{formatKhataError({ status: error }, t)}</p>
        )}

        {link && (
          <p className="text-[10px] text-ink-400">
            {(hasWhatsAppNumber(phone) ? t('reminder_wa_to_name') : t('reminder_wa_pick')).replace('{name}', personName)}
          </p>
        )}
      </div>
    </Modal>
  );
}
