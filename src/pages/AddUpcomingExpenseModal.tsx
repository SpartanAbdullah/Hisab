import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useAccountStore } from '../stores/accountStore';
import { useUpcomingExpenseStore } from '../stores/upcomingExpenseStore';
import { useToast } from '../components/Toast';
import { formatMoney } from '../lib/constants';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { GraduationCap, HeartPulse, PartyPopper, Plane, Home, Zap, MoreHorizontal } from 'lucide-react';
import type { Currency } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
}

const CATEGORIES = [
  { value: 'Education', icon: GraduationCap, gradient: 'from-blue-500 to-blue-600', soft: 'bg-blue-50 text-blue-600 border-blue-100' },
  { value: 'Medical', icon: HeartPulse, gradient: 'from-rose-500 to-rose-600', soft: 'bg-rose-50 text-rose-600 border-rose-100' },
  { value: 'Event', icon: PartyPopper, gradient: 'from-purple-500 to-purple-600', soft: 'bg-purple-50 text-purple-600 border-purple-100' },
  { value: 'Travel', icon: Plane, gradient: 'from-cyan-500 to-cyan-600', soft: 'bg-cyan-50 text-cyan-600 border-cyan-100' },
  { value: 'Rent', icon: Home, gradient: 'from-amber-500 to-amber-600', soft: 'bg-amber-50 text-amber-600 border-amber-100' },
  { value: 'Utilities', icon: Zap, gradient: 'from-yellow-500 to-yellow-600', soft: 'bg-yellow-50 text-yellow-600 border-yellow-100' },
  { value: 'Other', icon: MoreHorizontal, gradient: 'from-slate-500 to-slate-600', soft: 'bg-slate-50 text-slate-600 border-slate-100' },
];

const REMINDER_OPTIONS = [
  { value: 3, label: '3 din pehle' },
  { value: 7, label: '7 din pehle' },
  { value: 14, label: '14 din pehle' },
  { value: 30, label: '30 din pehle' },
];

export function AddUpcomingExpenseModal({ open, onClose }: Props) {
  const { accounts } = useAccountStore();
  const { createExpense } = useUpcomingExpenseStore();
  const toast = useToast();
  const t = useT();

  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [reminderDays, setReminderDays] = useState(7);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedAccount = accounts.find(a => a.id === accountId);

  const reset = () => {
    setStep(0); setTitle(''); setCategory(''); setAmount(''); setDueDate('');
    setAccountId(''); setReminderDays(7); setNotes('');
  };

  const handleClose = () => { reset(); onClose(); };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const currency: Currency = selectedAccount?.currency ?? 'AED';
      await createExpense({
        title: title.trim(),
        amount: parseFloat(amount),
        currency,
        dueDate,
        accountId,
        category,
        notes,
        reminderDaysBefore: reminderDays,
      });
      toast.show({ type: 'success', title: t('upcoming_create'), subtitle: `${title} — ${formatMoney(parseFloat(amount), currency)}` });
      reset();
      onClose();
    } catch (err) {
      toast.show({ type: 'error', title: t('error'), subtitle: err instanceof Error ? err.message : 'Failed' });
    } finally { setSaving(false); }
  };

  const stepTitles = [t('upcoming_name'), t('upcoming_amount'), t('upcoming_due'), t('upcoming_account')];

  const canNext = () => {
    if (step === 0) return title.trim().length > 0 && category.length > 0;
    if (step === 1) return parseFloat(amount) > 0;
    if (step === 2) return !!dueDate;
    if (step === 3) return !!accountId;
    return false;
  };

  const footer = step < 3 ? (
    <button
      onClick={() => setStep(s => s + 1)}
      disabled={!canNext()}
      className="w-full btn-gradient rounded-2xl py-4 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20 transition-all"
    >
      {t('quick_next')} &rarr;
    </button>
  ) : (
    <div className="flex gap-2.5">
      <button onClick={() => setStep(s => s - 1)} className="px-4 py-3.5 rounded-2xl text-sm font-semibold border border-slate-200/60 text-slate-500 active:bg-slate-50 transition-all">
        &larr;
      </button>
      <button
        onClick={handleSubmit}
        disabled={saving || !canNext()}
        className="flex-1 btn-gradient rounded-2xl py-3.5 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20"
      >
        {saving ? t('upcoming_creating') : t('upcoming_create')}
      </button>
    </div>
  );

  return (
    <Modal open={open} onClose={handleClose} title={stepTitles[step]} footer={footer}>
      {/* Step progress */}
      <div className="flex gap-1.5 mb-5">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-300 ${i <= step ? 'bg-indigo-500' : 'bg-slate-100'}`} />
        ))}
      </div>

      {/* Step 0: Title + Category */}
      {step === 0 && (
        <div className="space-y-4 animate-fade-in">
          <div>
            <label className="form-label">
              {t('upcoming_name')}
            </label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Beti ki Fees, Car Service, Rent..."
              className="input-field" autoFocus />
          </div>

          <div>
            <label className="form-label">
              {t('category')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {CATEGORIES.map(cat => {
                const CatIcon = cat.icon;
                const active = category === cat.value;
                return (
                  <button key={cat.value} type="button" onClick={() => setCategory(cat.value)}
                    className={`p-3 rounded-2xl border-2 flex flex-col items-center gap-2 transition-all active:scale-95 ${
                      active ? `bg-gradient-to-br ${cat.gradient} text-white border-transparent shadow-md` : `bg-white ${cat.soft}`
                    }`}
                  >
                    <CatIcon size={20} strokeWidth={active ? 2.2 : 1.5} />
                    <span className="text-[10px] font-bold">{cat.value}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Step 1: Amount */}
      {step === 1 && (
        <div className="space-y-4 animate-fade-in">
          <div className="text-center py-2">
            <div className="inline-flex items-center gap-2 bg-slate-50 rounded-xl px-3 py-1.5 mb-4">
              <span className="text-[11px] font-bold text-slate-400">{title}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-lg bg-slate-200/60 text-slate-500 font-semibold">{category}</span>
            </div>
          </div>
          <div>
            <label className="form-label">
              {t('upcoming_amount')}
            </label>
            <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className="input-field text-center text-2xl font-bold tabular-nums" autoFocus />
          </div>
          <button onClick={() => setStep(0)}
            className="w-full text-center text-[12px] text-slate-400 py-1 font-medium">&larr; Back</button>
        </div>
      )}

      {/* Step 2: Due Date */}
      {step === 2 && (
        <div className="space-y-4 animate-fade-in">
          <div className="text-center py-2">
            <p className="text-3xl font-bold tabular-nums text-slate-800">{parseFloat(amount || '0').toLocaleString()}</p>
            <p className="text-[11px] text-slate-400 mt-1">{title} · {category}</p>
          </div>
          <div>
            <label className="form-label">
              {t('upcoming_due')}
            </label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
              className="input-field" autoFocus />
          </div>
          <button onClick={() => setStep(1)}
            className="w-full text-center text-[12px] text-slate-400 py-1 font-medium">&larr; Back</button>
        </div>
      )}

      {/* Step 3: Account + Reminder */}
      {step === 3 && (
        <div className="space-y-4 animate-fade-in">
          {/* Summary bar */}
          <div className="bg-slate-50/80 rounded-2xl p-3.5 flex items-center justify-between border border-slate-100/60">
            <div>
              <p className="text-[13px] font-semibold text-slate-700">{title}</p>
              <p className="text-[10px] text-slate-400">{category} · {dueDate}</p>
            </div>
            <span className="font-bold text-[15px] tabular-nums text-slate-800">{parseFloat(amount || '0').toLocaleString()}</span>
          </div>

          {/* Account selection */}
          <div>
            <label className="form-label">
              {t('upcoming_account')}
            </label>
            <div className="space-y-2">
              {accounts.map(a => {
                const meta = currencyMeta[a.currency];
                return (
                  <button key={a.id} type="button" onClick={() => setAccountId(a.id)}
                    className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                      accountId === a.id ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{meta?.flag}</span>
                      <div>
                        <p className="text-[13px] font-semibold text-slate-700">{a.name}</p>
                        <p className="text-[10px] text-slate-400 capitalize">{a.type.replace('_', ' ')}</p>
                      </div>
                    </div>
                    <p className="text-[13px] font-bold text-slate-700 tabular-nums">{formatMoney(a.balance, a.currency)}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reminder timing */}
          <div>
            <label className="form-label">
              Reminder
            </label>
            <div className="flex gap-2 flex-wrap">
              {REMINDER_OPTIONS.map(opt => (
                <button key={opt.value} type="button" onClick={() => setReminderDays(opt.value)}
                  className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-all active:scale-95 ${
                    reminderDays === opt.value ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-white text-slate-500 border-slate-200/60'
                  }`}
                >{opt.label}</button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="form-label">
              {t('quick_note')}
            </label>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional..."
              className="input-field" />
          </div>
        </div>
      )}
    </Modal>
  );
}
