import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useUIStore } from '../stores/uiStore';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function Modal({ open, onClose, title, children, footer }: Props) {
  const [show, setShow] = useState(false);
  const { openModal, closeModal } = useUIStore();

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      openModal();
      requestAnimationFrame(() => setShow(true));
    } else {
      setShow(false);
      document.body.style.overflow = '';
      closeModal();
    }
    return () => {
      if (open) {
        document.body.style.overflow = '';
        closeModal();
      }
    };
  }, [open, openModal, closeModal]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={onClose}>
      <div className={`absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0'}`} />
      <div
        className={`relative bg-white w-full max-w-[480px] rounded-t-3xl max-h-[92dvh] flex flex-col transition-transform duration-350 ease-out shadow-2xl ${
          show ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-9 h-1 rounded-full bg-slate-200/80" />
        </div>
        {/* Header */}
        <div className="shrink-0 bg-white/90 backdrop-blur-md px-5 py-2.5 border-b border-slate-100/60 flex items-center justify-between z-10">
          <h2 className="font-bold text-[15px] tracking-tight text-slate-800">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-xl flex items-center justify-center bg-slate-100/80 active:bg-slate-200 transition-colors">
            <X size={15} className="text-slate-400" />
          </button>
        </div>
        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-5 pb-5">{children}</div>
        {/* Pinned footer */}
        {footer && (
          <div className="shrink-0 px-5 pb-6 pt-3 bg-white border-t border-slate-100/60">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
