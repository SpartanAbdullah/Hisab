import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useT } from '../lib/i18n';

interface Props {
  title?: string;
  message?: string;
  secondaryText?: string;
  actionLabel?: string;
  onRetry?: () => void;
  variant?: 'full' | 'inline';
}

// Single source of truth for "this page/section failed to load" UI. `full`
// takes the whole viewport (use when nothing else on the page is usable);
// `inline` is a banner that sits above otherwise-rendered content (use when
// the page has cached/partial data the user can still act on).
export function PageErrorState({
  title,
  message,
  secondaryText,
  actionLabel,
  onRetry,
  variant = 'full',
}: Props) {
  const t = useT();
  // Localized fallbacks — callers can still override with explicit copy.
  const resolvedTitle = title ?? t('err_page_title');
  const resolvedMessage = message ?? t('err_page_msg');
  const resolvedActionLabel = actionLabel ?? t('err_retry');
  if (variant === 'inline') {
    return (
      <div className="rounded-[18px] border border-pay-100 bg-pay-50 px-4 py-3 flex items-start gap-3">
        <div className="w-8 h-8 rounded-xl bg-pay-100 text-pay-text flex items-center justify-center shrink-0">
          <AlertTriangle size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-pay-text tracking-tight">{resolvedTitle}</p>
          <p className="text-[11px] text-pay-text/85 mt-0.5 leading-relaxed">{resolvedMessage}</p>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="shrink-0 rounded-xl bg-cream-card text-pay-text px-3 py-1.5 text-[11px] font-semibold border border-pay-100 active:scale-95 transition-all flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pay-600 focus-visible:ring-offset-2"
          >
            <RefreshCw size={11} /> {resolvedActionLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-cream-bg px-6">
      <div className="w-full max-w-sm rounded-[18px] bg-cream-card border border-cream-border p-6 text-center">
        <div className="mx-auto w-14 h-14 rounded-3xl bg-pay-50 text-pay-text flex items-center justify-center">
          <AlertTriangle size={24} />
        </div>
        <h3 className="font-semibold text-[15px] text-ink-900 tracking-tight mt-4">{resolvedTitle}</h3>
        <p className="text-[12px] text-ink-500 mt-2 leading-relaxed">{resolvedMessage}</p>
        {secondaryText && (
          <p className="text-[11px] font-medium text-ink-500 mt-3">{secondaryText}</p>
        )}
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-5 w-full rounded-2xl py-3 text-sm font-semibold bg-ink-900 text-white active:scale-[0.98] transition-transform flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
          >
            <RefreshCw size={14} /> {resolvedActionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
