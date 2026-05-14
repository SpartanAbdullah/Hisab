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
        {/* Drag handle — Sukoon grabber: 38 × 4.5 ink-200 */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-[38px] h-[4.5px] rounded-full bg-ink-200" />
        </div>
        {/* Header */}
        <div className="modal-header">
          <h2 className="font-semibold text-[15px] tracking-tight text-ink-900 truncate flex-1 min-w-0 pr-3">{title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-cream-soft border border-cream-hairline flex items-center justify-center shrink-0 active:bg-cream-hairline transition-colors"
            aria-label="Close"
          >
            <X size={15} className="text-ink-500" />
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
