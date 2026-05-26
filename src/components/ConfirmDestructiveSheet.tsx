import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle } from 'lucide-react';

// Imperative replacement for window.confirm() for destructive actions.
// Native confirm() does not render reliably inside iOS standalone PWA / Capacitor
// WebView and visually breaks the app's design language.
//
// Usage:
//   const ok = await confirmDestructive({
//     title: 'Delete this transaction?',
//     description: 'This will reverse the balance change. You can\'t undo this.',
//     confirmLabel: 'Delete',
//   });
//   if (!ok) return;

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'destructive' | 'warning';
}

interface ConfirmState {
  open: boolean;
  options: ConfirmOptions | null;
  resolve: ((ok: boolean) => void) | null;
  ask: (opts: ConfirmOptions) => Promise<boolean>;
  answer: (ok: boolean) => void;
}

const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  options: null,
  resolve: null,
  ask: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ open: true, options: opts, resolve });
    }),
  answer: (ok) => {
    const r = get().resolve;
    set({ open: false, options: null, resolve: null });
    r?.(ok);
  },
}));

export function confirmDestructive(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().ask(opts);
}

export function ConfirmDestructiveSheet() {
  const open = useConfirmStore((s) => s.open);
  const options = useConfirmStore((s) => s.options);
  const answer = useConfirmStore((s) => s.answer);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (open) requestAnimationFrame(() => setShow(true));
    else setShow(false);
  }, [open]);

  if (!open || !options) return null;

  const tone = options.tone ?? 'destructive';
  const accent = tone === 'destructive' ? 'text-pay-text' : 'text-amber-600';
  const confirmBg = tone === 'destructive' ? 'bg-pay-500' : 'bg-amber-500';

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center" onClick={() => answer(false)}>
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm transition-opacity" />
      <div
        className={`relative bg-white w-full max-w-[480px] rounded-t-3xl overflow-hidden transition-transform duration-300 shadow-2xl ${
          show ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-7 pb-5 text-center">
          <div className="w-12 h-12 rounded-full bg-pay-50 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle size={22} className={accent} strokeWidth={2} />
          </div>
          <p className="font-bold text-[16px] text-ink-900 tracking-tight">{options.title}</p>
          {options.description && (
            <p className="text-[13px] text-ink-500 mt-2 leading-relaxed">{options.description}</p>
          )}
        </div>

        <div className="px-6 pb-7 pt-2 space-y-2 pb-safe">
          <button
            type="button"
            onClick={() => answer(true)}
            className={`w-full ${confirmBg} text-white rounded-2xl py-3.5 text-[14px] font-semibold active:scale-[0.98] transition-transform`}
          >
            {options.confirmLabel ?? 'Confirm'}
          </button>
          <button
            type="button"
            onClick={() => answer(false)}
            className="w-full bg-cream-soft text-ink-700 rounded-2xl py-3.5 text-[14px] font-semibold active:scale-[0.98] transition-transform"
          >
            {options.cancelLabel ?? 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
