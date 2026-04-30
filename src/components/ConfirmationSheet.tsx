import { CheckCircle, ArrowRight } from 'lucide-react';
import { formatMoney } from '../lib/constants';
import { Button } from './Button';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import { useUIStore } from '../stores/uiStore';

interface BalanceChange {
  accountName: string;
  currency: string;
  before: number;
  after: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  balanceChanges: BalanceChange[];
}

export function ConfirmationSheet({ open, onClose, title, description, balanceChanges }: Props) {
  const [show, setShow] = useState(false);
  const t = useT();
  const { openModal, closeModal } = useUIStore();
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    let modalId: string | null = null;
    if (open) {
      modalId = openModal(() => onCloseRef.current());
      requestAnimationFrame(() => setShow(true));
      const timer = setTimeout(() => onCloseRef.current(), 2500);
      return () => {
        clearTimeout(timer);
        closeModal(modalId ?? undefined);
      };
    } else {
      setShow(false);
    }
  }, [open, openModal, closeModal]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" />
      <div
        className={`relative bg-white w-full max-w-[480px] rounded-t-3xl overflow-hidden transition-transform duration-400 shadow-2xl ${
          show ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Success header */}
        <div className="relative overflow-hidden px-6 py-8 text-center text-white">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-600" />
          <div className="absolute inset-0 opacity-30" style={{ background: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,0.2), transparent 50%)' }} />
          <div className="relative">
            <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-4 animate-bounce-in">
              <CheckCircle size={30} strokeWidth={1.5} />
            </div>
            <p className="font-bold text-lg tracking-tight">{title}</p>
            <p className="text-sm opacity-80 mt-1">{description}</p>
          </div>
        </div>

        {/* Balance changes */}
        {balanceChanges.length > 0 && (
          <div className="px-6 py-5 space-y-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('balance_changes')}</p>
            {balanceChanges.map((change, i) => (
              <div key={i} className="flex items-center gap-3 bg-slate-50/80 rounded-2xl p-4 border border-slate-100/60">
                <div className="flex-1 text-center">
                  <p className="text-[10px] text-slate-400 font-medium">{change.accountName}</p>
                  <p className="text-sm font-bold text-slate-400 line-through mt-1">
                    {formatMoney(change.before, change.currency)}
                  </p>
                </div>
                <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center shrink-0">
                  <ArrowRight size={14} className="text-indigo-500" />
                </div>
                <div className="flex-1 text-center">
                  <p className="text-[10px] text-slate-400 font-medium">{t('updated')}</p>
                  <p className={`text-sm font-bold mt-1 ${change.after >= change.before ? 'text-emerald-600' : 'text-red-500'}`}>
                    {formatMoney(change.after, change.currency)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="px-6 pb-8 pt-2">
          <Button variant="gradient" size="lg" onClick={onClose}>
            {t('done_btn')}
          </Button>
        </div>
      </div>
    </div>
  );
}
