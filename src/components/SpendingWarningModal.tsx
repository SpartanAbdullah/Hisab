import { Modal } from './Modal';
import { AlertTriangle } from 'lucide-react';
import { formatMoney } from '../lib/constants';
import { useT } from '../lib/i18n';
import type { UpcomingExpense } from '../db';

interface Props {
  open: boolean;
  expense: UpcomingExpense | null;
  onContinue: () => void;
  onCancel: () => void;
}

export function SpendingWarningModal({ open, expense, onContinue, onCancel }: Props) {
  const t = useT();
  if (!expense) return null;

  const daysLeft = Math.ceil((new Date(expense.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  return (
    <Modal open={open} onClose={onCancel} title={t('spend_warning_title')}
      footer={
        <div className="flex gap-2.5">
          <button onClick={onCancel}
            className="flex-1 py-3.5 rounded-2xl text-sm font-bold border-2 border-slate-200/60 text-slate-600 active:bg-slate-50 transition-all"
          >
            {t('spend_warning_cancel')}
          </button>
          <button onClick={onContinue}
            className="flex-1 btn-gradient rounded-2xl py-3.5 text-sm font-bold shadow-md shadow-indigo-500/20"
          >
            {t('spend_warning_continue')}
          </button>
        </div>
      }
    >
      <div className="text-center space-y-4 py-2">
        <div className="w-16 h-16 rounded-3xl bg-amber-50 flex items-center justify-center mx-auto">
          <AlertTriangle size={32} className="text-amber-500" />
        </div>
        <div>
          <p className="text-[15px] font-bold text-slate-800">
            Yaad rakhein: "{expense.title}"
          </p>
          <p className="text-[13px] text-slate-600 mt-2">
            <span className="font-bold text-amber-600">{formatMoney(expense.amount, expense.currency)}</span>
            {' '}{t('spend_warning_msg_suffix')} {expense.title}
          </p>
          <p className="text-[12px] text-slate-400 mt-1">
            {new Date(expense.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            {' — '}
            {daysLeft <= 0 ? 'Overdue!' : `${daysLeft} ${t('upcoming_due_in')}`}
          </p>
        </div>
        <p className="text-[12px] text-slate-500 bg-amber-50 rounded-xl p-3 border border-amber-100/60">
          Kya aap phir bhi aage badhna chahte hain?
        </p>
      </div>
    </Modal>
  );
}
