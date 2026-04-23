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
      <div className={`modal-backdrop ${show ? 'opacity-100' : 'opacity-0'}`} />
      <div
        className={`modal-sheet ${show ? 'translate-y-0' : 'translate-y-full'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-9 h-1 rounded-full bg-slate-200/80" />
        </div>
        {/* Header */}
        <div className="modal-header">
          <h2 className="font-bold text-[15px] tracking-tight text-slate-800">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-xl flex items-center justify-center bg-slate-100/80 active:bg-slate-200 transition-colors">
            <X size={15} className="text-slate-400" />
          </button>
        </div>
        {/* Scrollable content */}
        <div className="modal-body">{children}</div>
        {/* Pinned footer */}
        {footer && (
          <div className="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
