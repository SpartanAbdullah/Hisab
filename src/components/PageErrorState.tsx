import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  title?: string;
  message?: string;
  onRetry?: () => void;
  variant?: 'full' | 'inline';
}

// Single source of truth for "this page/section failed to load" UI. `full`
// takes the whole viewport (use when nothing else on the page is usable);
// `inline` is a banner that sits above otherwise-rendered content (use when
// the page has cached/partial data the user can still act on).
export function PageErrorState({
  title = "Couldn't load this",
  message = 'Check your connection and try again.',
  onRetry,
  variant = 'full',
}: Props) {
  if (variant === 'inline') {
    return (
      <div className="rounded-2xl border border-red-200/70 bg-red-50 px-4 py-3 flex items-start gap-3">
        <div className="w-8 h-8 rounded-xl bg-red-100 text-red-600 flex items-center justify-center shrink-0">
          <AlertTriangle size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-red-700 tracking-tight">{title}</p>
          <p className="text-[11px] text-red-600/80 mt-0.5 leading-relaxed">{message}</p>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="shrink-0 rounded-xl bg-white text-red-600 px-3 py-1.5 text-[11px] font-bold border border-red-200/70 active:scale-95 transition-all flex items-center gap-1.5"
          >
            <RefreshCw size={11} /> Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-mesh px-6">
      <div className="w-full max-w-sm card-premium p-6 text-center">
        <div className="mx-auto w-14 h-14 rounded-3xl bg-red-50 text-red-500 flex items-center justify-center">
          <AlertTriangle size={24} />
        </div>
        <h3 className="font-bold text-[15px] text-slate-700 tracking-tight mt-4">{title}</h3>
        <p className="text-[12px] text-slate-500 mt-2 leading-relaxed">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-5 w-full rounded-2xl py-3 text-sm font-bold btn-gradient shadow-md shadow-indigo-500/20 flex items-center justify-center gap-2"
          >
            <RefreshCw size={14} /> Try again
          </button>
        )}
      </div>
    </div>
  );
}
