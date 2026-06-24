import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../stores/uiStore';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  // Optional gate for dismissal (backdrop tap / X). Return false (or a Promise
  // resolving false) to KEEP the modal open — used to guard unsaved changes.
  confirmClose?: () => boolean | Promise<boolean>;
}

export function Modal({ open, onClose, title, children, footer, confirmClose }: Props) {
  const [show, setShow] = useState(false);
  const { openModal, closeModal } = useUIStore();

  const requestClose = async () => {
    if (confirmClose) {
      const ok = await confirmClose();
      if (!ok) return;
    }
    onClose();
  };

  // Register a STABLE close handler on the modal stack so the hardware back
  // button can dismiss this modal. The ref keeps it pointing at the latest
  // requestClose (which closes over the current confirmClose/onClose) without
  // changing identity, so push/pop stay balanced across re-renders.
  const requestCloseRef = useRef(requestClose);
  const closeHandlerRef = useRef(() => { void requestCloseRef.current(); });
  useEffect(() => {
    requestCloseRef.current = requestClose;
  });

  useEffect(() => {
    const closeHandler = closeHandlerRef.current;
    if (open) {
      document.body.style.overflow = 'hidden';
      openModal(closeHandler);
      requestAnimationFrame(() => setShow(true));
    } else {
      // Intentional: `show` is an animation flag synchronized with the
      // `open` prop. Deriving it via render-time computation would skip
      // the enter/exit transition, which is the whole point.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShow(false);
      document.body.style.overflow = '';
      closeModal(closeHandler);
    }
    return () => {
      if (open) {
        document.body.style.overflow = '';
        closeModal(closeHandler);
      }
    };
  }, [open, openModal, closeModal]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={requestClose}>
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
            onClick={requestClose}
            className="nav-icon-button border border-cream-hairline shrink-0"
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
