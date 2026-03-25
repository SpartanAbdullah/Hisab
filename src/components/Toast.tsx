import { useEffect, useState, useCallback } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import { create } from 'zustand';

type ToastType = 'success' | 'error' | 'info';

interface ToastData {
  id: string;
  type: ToastType;
  title: string;
  subtitle?: string;
  duration?: number;
}

interface ToastStore {
  toasts: ToastData[];
  show: (toast: Omit<ToastData, 'id'>) => void;
  dismiss: (id: string) => void;
}

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
  success: 'bg-emerald-600 shadow-emerald-500/25',
  error: 'bg-red-500 shadow-red-500/25',
  info: 'bg-indigo-600 shadow-indigo-500/25',
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
    const timer = setTimeout(handleDismiss, toast.duration ?? 3000);
    return () => clearTimeout(timer);
  }, [handleDismiss, toast.duration]);

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
      <button onClick={handleDismiss} className="shrink-0 mt-0.5 opacity-50 active:opacity-100 transition-opacity">
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
