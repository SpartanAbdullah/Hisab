import { useEffect, useState, useCallback } from 'react';
import { CheckCircle, AlertCircle, Info, X, Undo2 } from 'lucide-react';
import { create } from 'zustand';

type ToastType = 'success' | 'error' | 'info';

// An optional inline action — used mainly for "Undo" so reversible actions can
// happen instantly with a way back, instead of a blocking confirmation.
interface ToastAction {
  label: string;
  onPress: () => void;
}

interface ToastData {
  id: string;
  type: ToastType;
  title: string;
  subtitle?: string;
  duration?: number;
  action?: ToastAction;
}

interface ToastStore {
  toasts: ToastData[];
  show: (toast: Omit<ToastData, 'id'>) => void;
  dismiss: (id: string) => void;
}

// Co-located store — the toast hook and the Toast renderer share this
// closure. Splitting them would force a circular-style import.
// eslint-disable-next-line react-refresh/only-export-components
export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  show: (toast) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const icons = { success: CheckCircle, error: AlertCircle, info: Info };
const bgColors = {
  success: 'bg-receive-600 shadow-receive-600/25',
  error: 'bg-pay-600 shadow-pay-600/25',
  info: 'bg-info-600 shadow-info-600/25',
};

function ToastItem({ toast }: { toast: ToastData }) {
  const { dismiss } = useToast();
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => dismiss(toast.id), 300);
  }, [dismiss, toast.id]);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    // Give people longer to react when there's an action to take (e.g. Undo).
    const timer = setTimeout(handleDismiss, toast.duration ?? (toast.action ? 6000 : 3000));
    return () => clearTimeout(timer);
  }, [handleDismiss, toast.duration, toast.action]);

  const Icon = icons[toast.type];

  return (
    <div
      className={`${bgColors[toast.type]} text-white rounded-2xl px-4 py-3 flex items-start gap-3 shadow-lg transition-all duration-300 ${
        visible && !exiting ? 'translate-y-0 opacity-100 scale-100' : '-translate-y-3 opacity-0 scale-95'
      }`}
    >
      <Icon size={18} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold tracking-tight">{toast.title}</p>
        {toast.subtitle && <p className="text-xs opacity-75 mt-0.5">{toast.subtitle}</p>}
      </div>
      {toast.action && (
        <button
          onClick={() => {
            toast.action?.onPress();
            handleDismiss();
          }}
          className="relative shrink-0 -my-1 px-2.5 py-1.5 rounded-lg bg-white/20 active:bg-white/30 text-white text-[12px] font-bold flex items-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <Undo2 size={13} strokeWidth={2.6} />
          {toast.action.label}
        </button>
      )}
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="relative shrink-0 mt-0.5 opacity-50 active:opacity-100 transition-opacity before:absolute before:-inset-2.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 rounded"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts } = useToast();
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 w-full max-w-[440px] px-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  );
}
