import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useGoalStore } from '../stores/goalStore';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { SUPPORTED_CURRENCIES, type Currency } from '../db';

interface Props { open: boolean; onClose: () => void; }

// A goal is a simple set-aside tracker: a name + a target + (optionally) a
// deadline. Adding money just grows the saved bar — it does NOT move money
// between accounts, which keeps the model easy to grasp for new users. The old
// "link a savings account / internal" question was a no-op label and is gone.
export function AddGoalModal({ open, onClose }: Props) {
  const { createGoal } = useGoalStore();
  const t = useT();

  const [title, setTitle] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>(() => (localStorage.getItem('hisaab_primary_currency') as Currency) || 'AED');
  const [targetDate, setTargetDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const today = new Date().toISOString().slice(0, 10);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const amt = parseFloat(targetAmount);
    if (!title.trim()) { setError(t('val_need_name')); return; }
    if (!amt) { setError(t('val_need_amount')); return; }

    setSaving(true);
    try {
      await createGoal({
        title: title.trim(),
        targetAmount: amt,
        currency,
        targetDate: targetDate || null,
      });
      setTitle(''); setTargetAmount(''); setTargetDate('');
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('goal_new')}
      footer={
        <button type="submit" form="goal-form" disabled={saving} className="cta-primary">
          {saving ? t('goal_creating') : t('goal_create')}
        </button>
      }
    >
      <form id="goal-form" onSubmit={handleSubmit} className="space-y-4">
        <p className="text-[12px] text-ink-500 leading-relaxed bg-cream-soft/80 border border-cream-hairline rounded-2xl p-3">
          {t('goal_intro')}
        </p>

        <div>
          <label className="form-label">{t('goal_name')}</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Emergency Fund, Laptop, Eid" className="input-field" required />
        </div>

        <div>
          <label className="form-label">{t('goal_target')}</label>
          <input type="number" step="0.01" value={targetAmount} onChange={e => setTargetAmount(e.target.value)} placeholder="0.00" className="input-field text-center text-lg font-bold tabular-nums" required />
        </div>

        <div>
          <label className="form-label">Currency</label>
          <div className="grid grid-cols-2 gap-2">
            {SUPPORTED_CURRENCIES.map(c => {
              const meta = currencyMeta[c];
              return (
                <button key={c} type="button" onClick={() => setCurrency(c)}
                  className={`justify-center text-[13px] font-semibold ${currency === c ? 'selector-base selector-selected' : 'selector-base'}`}
                >
                  <span className="text-ink-800">{meta?.flag} {c}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="form-label">{t('goal_target_date')}</label>
          <input type="date" min={today} value={targetDate} onChange={e => setTargetDate(e.target.value)} className="input-field" />
          <p className="text-[11px] text-ink-500 mt-1.5 leading-relaxed">{t('goal_target_date_help')}</p>
        </div>

        {error && <p className="text-[12px] text-pay-text font-semibold bg-pay-50 rounded-xl p-3">{error}</p>}
      </form>
    </Modal>
  );
}
