import { useMemo, useState } from 'react';
import { Copy, Share2 } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import {
  buildPaymentReminderMessage,
  getReminderAge,
  type PaymentReminderDirection,
  type PaymentReminderTone,
  type ReminderAge,
  type ReminderTemplateMap,
} from '../lib/paymentReminders';
import type { Currency } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
  personName: string;
  amount: number;
  currency: Currency;
  direction: PaymentReminderDirection;
  startedAt?: string | null;
}

function copyWithFallback(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithTextareaFallback(text));
  }

  return copyWithTextareaFallback(text);
}

function copyWithTextareaFallback(text: string): Promise<void> {
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

function formatDuration(age: ReminderAge, t: ReturnType<typeof useT>) {
  if (age.days === null) return t('reminder_duration_fallback');
  if (age.days === 0) return t('reminder_duration_today');
  if (age.days === 1) return t('reminder_duration_yesterday');
  if (age.days < 30) return t('reminder_duration_days').replace('{count}', String(age.days));

  const months = Math.max(1, Math.floor(age.days / 30));
  if (months === 1) return t('reminder_duration_month');
  return t('reminder_duration_months').replace('{count}', String(months));
}

function formatMeta(age: ReminderAge, t: ReturnType<typeof useT>) {
  if (age.days === null) return t('reminder_no_due_date');
  if (age.days === 0) return t('reminder_open_today');
  if (age.days === 1) return t('reminder_open_days').replace('{count}', '1');
  if (age.isOverdue) return t('reminder_overdue_days').replace('{count}', String(age.days));
  return t('reminder_open_days').replace('{count}', String(age.days));
}

export function PaymentReminderModal({ open, onClose, personName, amount, currency, direction, startedAt }: Props) {
  const t = useT();
  const toast = useToast();
  const [tone, setTone] = useState<PaymentReminderTone>('friendly');
  const [copying, setCopying] = useState(false);
  const [sharing, setSharing] = useState(false);

  const age = useMemo(() => getReminderAge(startedAt), [startedAt]);
  const amountText = formatMoney(amount, currency);
  const duration = formatDuration(age, t);
  const shareAvailable = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const templates: ReminderTemplateMap = {
    receivable: {
      friendly: t('reminder_receivable_friendly'),
      neutral: t('reminder_receivable_neutral'),
      formal: t('reminder_receivable_formal'),
    },
    payable: {
      friendly: t('reminder_payable_friendly'),
      neutral: t('reminder_payable_neutral'),
      formal: t('reminder_payable_formal'),
    },
  };

  const message = buildPaymentReminderMessage({
    name: personName,
    amount: amountText,
    duration,
    direction,
    tone,
  }, templates);

  const handleCopy = async () => {
    setCopying(true);
    try {
      await copyWithFallback(message);
      toast.show({ type: 'success', title: t('reminder_copied') });
    } catch {
      toast.show({ type: 'error', title: t('reminder_copy_failed') });
    } finally {
      setCopying(false);
    }
  };

  const handleShare = async () => {
    if (!shareAvailable) return;
    setSharing(true);
    try {
      await navigator.share({ text: message });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        toast.show({ type: 'error', title: t('reminder_share_failed') });
      }
    } finally {
      setSharing(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('reminder_title')}
      footer={
        <div className="flex gap-2.5">
          <button
            onClick={handleCopy}
            disabled={copying}
            className="flex-1 bg-ink-900 text-white rounded-2xl py-3.5 text-sm font-bold shadow-md shadow-indigo-500/20 flex items-center justify-center gap-2 disabled:opacity-30"
          >
            <Copy size={15} /> {copying ? t('quick_processing') : t('reminder_copy')}
          </button>
          {shareAvailable ? (
            <button
              onClick={handleShare}
              disabled={sharing}
              className="px-4 rounded-2xl py-3.5 text-sm font-bold bg-cream-soft text-ink-700 flex items-center justify-center gap-2 active:bg-slate-200 disabled:opacity-40"
            >
              <Share2 size={15} /> {t('reminder_share')}
            </button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        <div className={`rounded-2xl p-4 border ${direction === 'receivable' ? 'bg-receive-50/60 border-receive-100/70' : 'bg-pay-50/60 border-pay-100/70'}`}>
          <p className={`text-[10px] font-bold uppercase tracking-widest ${direction === 'receivable' ? 'text-receive-text' : 'text-pay-text'}`}>
            {direction === 'receivable' ? t('reminder_they_owe_me') : t('reminder_i_owe_them')}
          </p>
          <p className="text-2xl font-extrabold text-ink-900 tabular-nums tracking-tight mt-1">{amountText}</p>
          <p className="text-[12px] text-ink-500 mt-1">{personName} - {formatMeta(age, t)}</p>
        </div>

        <div>
          <p className="form-label">{t('reminder_tone')}</p>
          <div className="grid grid-cols-3 gap-2">
            {(['friendly', 'neutral', 'formal'] as PaymentReminderTone[]).map((nextTone) => (
              <button
                key={nextTone}
                type="button"
                onClick={() => setTone(nextTone)}
                className={`py-2.5 rounded-xl text-[11px] font-bold border transition-all active:scale-95 ${
                  tone === nextTone ? 'bg-ink-900 text-white border-ink-900' : 'bg-white text-ink-500 border-cream-border'
                }`}
              >
                {nextTone === 'friendly' ? t('reminder_tone_friendly') : nextTone === 'neutral' ? t('reminder_tone_neutral') : t('reminder_tone_formal')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="form-label">{t('reminder_preview')}</p>
          <div className="rounded-2xl bg-cream-soft border border-cream-hairline p-4">
            <p className="text-[13px] text-ink-800 leading-relaxed whitespace-pre-line">{message}</p>
          </div>
          <p className="text-[10px] text-ink-500 mt-2">{t('reminder_manual_only')}</p>
        </div>
      </div>
    </Modal>
  );
}
