import { useEffect, useState } from 'react';
import { Ban, Check, Flag, ShieldAlert } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { useSubmitGuard } from '../lib/useSubmitGuard';
import { useBlockStore } from '../stores/blockStore';
import {
  BLOCK_REASON_MAX,
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  type ReportContextType,
  type ReportReason,
} from '../lib/blockStatus';

// ───────────────────────────────────────────────────────────────────────────
// One sheet for both trust-and-safety actions (audit 2026-09 M17).
//
// They are deliberately SEPARATE actions with separate copy, because they do
// different things: block protects you now; report tells the operator. The
// sheet offers "block as well" from the report side so the common case is one
// gesture, but never silently does one when the user asked for the other.
//
// The block copy is the load-bearing part of this component. Everything in
// `blk_point_*` is a promise the SQL actually keeps, and the two uncomfortable
// ones are stated out loud rather than buried:
//   • a group you already share still shows them (docs/trust-and-safety.md 6.2)
//   • a block is per-account, and accounts are free (6.3)
// Users who think block does more than it does are the failure mode this exists
// to prevent.
// ───────────────────────────────────────────────────────────────────────────

export type BlockReportMode = 'block' | 'report';

interface Props {
  open: boolean;
  mode: BlockReportMode;
  /** The other person's auth user id. Nothing renders without one. */
  targetUserId: string | null;
  targetName: string;
  contextType: ReportContextType;
  contextId?: string | null;
  /**
   * Pre-formatted live balance with this person ("PKR 4,000"), when there is
   * one. Drives the RULE 2 "settle to zero, then block" nudge. Omit when the
   * surface has no balance to speak of (a group member row, an inbox card).
   */
  openBalanceText?: string | null;
  onClose: () => void;
  /** Fired after a successful block/report so the caller can refresh a list. */
  onDone?: () => void;
}

// Exhaustive by construction: a new value in REPORT_REASONS is a type error
// here rather than a blank row in the list.
const REASON_LABEL_KEY = {
  harassment: 'rep_reason_harassment',
  spam: 'rep_reason_spam',
  impersonation: 'rep_reason_impersonation',
  wrong_amounts: 'rep_reason_wrong_amounts',
  other: 'rep_reason_other',
} as const satisfies Record<ReportReason, string>;

export function BlockReportSheet({
  open, mode, targetUserId, targetName, contextType, contextId, openBalanceText, onClose, onDone,
}: Props) {
  const t = useT();
  const toast = useToast();
  const block = useBlockStore((s) => s.block);
  const report = useBlockStore((s) => s.report);

  const [reason, setReason] = useState('');
  const [reportReason, setReportReason] = useState<ReportReason>('harassment');
  const [details, setDetails] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [saving, setSaving] = useState(false);

  // Double-tap guards — one per mutating handler (audit F-8). A ref, not the
  // `saving` state, is what actually stops a second tap in the same frame.
  const blockGuard = useSubmitGuard();
  const reportGuard = useSubmitGuard();

  // Reset on close so reopening on a DIFFERENT person never inherits the last
  // person's typed reason.
  useEffect(() => {
    if (open) return;
    setReason('');
    setReportReason('harassment');
    setDetails('');
    setAlsoBlock(true);
    setSaving(false);
  }, [open]);

  if (!targetUserId) return null;

  const runBlock = () => blockGuard.run(async () => {
    setSaving(true);
    try {
      const outcome = await block(targetUserId, reason);
      if (outcome === 'ok') {
        toast.show({ type: 'success', title: t('blk_blocked_toast').replace('{name}', targetName) });
      } else if (outcome === 'ALREADY_BLOCKED') {
        toast.show({ type: 'info', title: t('blk_already_toast').replace('{name}', targetName) });
      } else {
        toast.show({ type: 'error', title: outcome === 'SELF' ? t('blk_self') : t('blk_failed') });
        return;
      }
      onDone?.();
      onClose();
    } finally {
      setSaving(false);
    }
  });

  const runReport = () => reportGuard.run(async () => {
    setSaving(true);
    try {
      const outcome = await report({
        reportedId: targetUserId,
        contextType,
        contextId: contextId ?? null,
        reason: reportReason,
        details,
      });
      if (outcome === 'RATE_LIMITED') {
        // The cap is not the user's fault — calm message, not an error toast.
        toast.show({ type: 'info', title: t('rep_rate_limited') });
        return;
      }
      if (outcome !== 'ok') {
        toast.show({ type: 'error', title: outcome === 'SELF' ? t('rep_self') : t('rep_failed') });
        return;
      }
      // Reports are write-only by design (no SELECT policy at all), so this
      // confirmation is optimistic — there is nothing to read back.
      toast.show({ type: 'success', title: t('rep_sent_toast') });
      if (alsoBlock) {
        const blocked = await block(targetUserId, reason);
        if (blocked === 'ok' || blocked === 'ALREADY_BLOCKED') {
          toast.show({ type: 'success', title: t('blk_blocked_toast').replace('{name}', targetName) });
        }
      }
      onDone?.();
      onClose();
    } finally {
      setSaving(false);
    }
  });

  const points = [
    t('blk_point_silent'),
    t('blk_point_new_stops'),
    t('blk_point_existing'),
    t('blk_point_shared_group'),
    t('blk_point_not_delete'),
    t('blk_point_new_account'),
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        mode === 'block'
          ? t('blk_sheet_title').replace('{name}', targetName)
          : t('rep_sheet_title').replace('{name}', targetName)
      }
      footer={
        <button
          type="button"
          onClick={mode === 'block' ? runBlock : runReport}
          disabled={saving}
          className={`w-full py-3 rounded-2xl text-[13px] font-bold disabled:opacity-40 press ${
            mode === 'block' ? 'bg-pay-600 text-white' : 'bg-ink-900 text-white'
          }`}
        >
          {mode === 'block' ? t('blk_confirm_cta') : t('rep_submit_cta')}
        </button>
      }
    >
      {mode === 'block' ? (
        <div className="space-y-3">
          {openBalanceText && (
            <div className="rounded-2xl bg-warn-50 border border-warn-100 p-3.5">
              <p className="text-[12.5px] font-semibold text-warn-600 flex items-center gap-1.5">
                <ShieldAlert size={14} strokeWidth={2.2} /> {t('blk_settle_first_title')}
              </p>
              <p className="text-[11.5px] text-ink-600 mt-1 leading-relaxed">
                {t('blk_settle_first_body')
                  .replace('{name}', targetName)
                  .replace('{amount}', openBalanceText)}
              </p>
            </div>
          )}

          <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-3.5 space-y-2">
            <p className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">
              {t('blk_what_happens')}
            </p>
            {points.map((line) => (
              <div key={line} className="flex items-start gap-2">
                <Check size={12} strokeWidth={3} className="text-ink-400 shrink-0 mt-[3px]" />
                <p className="text-[11.5px] text-ink-600 leading-relaxed">{line}</p>
              </div>
            ))}
          </div>

          <div>
            <label htmlFor="block-reason" className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">
              {t('blk_reason_label')}
            </label>
            <input
              id="block-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={BLOCK_REASON_MAX}
              placeholder={t('blk_reason_ph')}
              className="w-full mt-1.5 border border-cream-border rounded-xl px-4 py-3 text-[13px] bg-cream-bg focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[11.5px] text-ink-500 leading-relaxed flex items-start gap-2">
            <Flag size={13} className="text-ink-400 shrink-0 mt-[2px]" strokeWidth={2.2} />
            <span>{t('rep_intro')}</span>
          </p>

          <div>
            <p className="text-[10px] font-bold text-ink-500 uppercase tracking-widest mb-1.5">
              {t('rep_reason_label')}
            </p>
            <div className="rounded-2xl bg-cream-card border border-cream-border divide-y divide-cream-hairline overflow-hidden">
              {REPORT_REASONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setReportReason(value)}
                  aria-pressed={reportReason === value}
                  className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left active:bg-cream-soft transition-colors"
                >
                  <span
                    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                      reportReason === value ? 'bg-ink-900 border-ink-900 text-white' : 'border-cream-border text-transparent'
                    }`}
                  >
                    <Check size={10} strokeWidth={3.2} />
                  </span>
                  <span className="text-[12.5px] text-ink-800">{t(REASON_LABEL_KEY[value])}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="report-details" className="text-[10px] font-bold text-ink-500 uppercase tracking-widest">
              {t('rep_details_label')}
            </label>
            <textarea
              id="report-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              maxLength={REPORT_DETAILS_MAX}
              placeholder={t('rep_details_ph')}
              className="w-full mt-1.5 border border-cream-border rounded-2xl px-4 py-3 text-sm bg-cream-card focus:outline-none focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500 transition-all resize-none"
            />
          </div>

          <button
            type="button"
            onClick={() => setAlsoBlock(!alsoBlock)}
            aria-pressed={alsoBlock}
            className="w-full flex items-center gap-2.5 rounded-2xl bg-cream-soft border border-cream-hairline px-3.5 py-3 text-left"
          >
            <span
              className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                alsoBlock ? 'bg-pay-600 border-pay-600 text-white' : 'border-cream-border text-transparent'
              }`}
            >
              <Check size={10} strokeWidth={3.2} />
            </span>
            <span className="text-[12.5px] text-ink-800 flex items-center gap-1.5">
              <Ban size={12} className="text-ink-400" /> {t('rep_also_block')}
            </span>
          </button>
        </div>
      )}
    </Modal>
  );
}
