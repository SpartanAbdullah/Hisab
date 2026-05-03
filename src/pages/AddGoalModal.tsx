import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useGoalStore } from '../stores/goalStore';
import { useAccountStore } from '../stores/accountStore';
import { currencyMeta } from '../lib/design-tokens';
import { useT } from '../lib/i18n';
import { SUPPORTED_CURRENCIES, type Currency } from '../db';

interface Props { open: boolean; onClose: () => void; }

export function AddGoalModal({ open, onClose }: Props) {
  const { createGoal } = useGoalStore();
  const { accounts } = useAccountStore();
  const t = useT();

  const [title, setTitle] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('AED');
  const [linkAccount, setLinkAccount] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const savingsAccounts = accounts.filter(a => a.type === 'savings' || a.type === 'bank');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const amt = parseFloat(targetAmount);
    if (!title.trim() || !amt) { setError(t('fill_all')); return; }
    if (linkAccount && !accountId) { setError(t('fill_all')); return; }

    // Currency comes from linked account if one is selected
    const goalCurrency = linkAccount && accountId
      ? (accounts.find(a => a.id === accountId)?.currency ?? currency)
      : currency;

    setSaving(true);
    try {
      await createGoal({
        title: title.trim(),
        targetAmount: amt,
        currency: goalCurrency,
        storedInAccountId: linkAccount ? accountId : '',
      });
      setTitle(''); setTargetAmount(''); setAccountId(''); setLinkAccount(false);
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('goal_new')}
      footer={
        <button type="submit" form="goal-form" disabled={saving}
          className="w-full btn-gradient rounded-2xl py-4 text-sm font-bold disabled:opacity-30 shadow-md shadow-indigo-500/20"
        >{saving ? t('goal_creating') : t('goal_create')}</button>
      }
    >
      <form id="goal-form" onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="form-label">{t('goal_name')}</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Emergency Fund, Laptop" className="input-field" required />
        </div>

        <div>
          <label className="form-label">{t('goal_target')}</label>
          <input type="number" step="0.01" value={targetAmount} onChange={e => setTargetAmount(e.target.value)} placeholder="0.00" className="input-field text-center text-lg font-bold tabular-nums" required />
        </div>

        {/* FIX 3: Ask if goal has a linked savings account */}
        <div>
          <label className="form-label">{t('goal_has_account')}</label>
          <div className="flex gap-2.5">
            <button type="button" onClick={() => { setLinkAccount(true); }}
              className={`flex-1 py-3 rounded-2xl text-[13px] font-bold border-2 transition-all active:scale-[0.97] ${
                linkAccount ? 'bg-gradient-to-r from-purple-500 to-violet-500 text-white border-transparent shadow-md' : 'bg-white text-slate-500 border-slate-200/60'
              }`}
            >Yes</button>
            <button type="button" onClick={() => { setLinkAccount(false); setAccountId(''); }}
              className={`flex-1 py-3 rounded-2xl text-[13px] font-bold border-2 transition-all active:scale-[0.97] ${
                !linkAccount ? 'bg-gradient-to-r from-slate-600 to-slate-700 text-white border-transparent shadow-md' : 'bg-white text-slate-500 border-slate-200/60'
              }`}
            >No</button>
          </div>
        </div>

        {linkAccount ? (
          <div className="animate-fade-in">
            <label className="form-label">{t('goal_linked')}</label>
            <div className="space-y-2">
              {savingsAccounts.map(a => {
                const meta = currencyMeta[a.currency];
                return (
                  <button key={a.id} type="button" onClick={() => { setAccountId(a.id); setCurrency(a.currency); }}
                    className={`w-full p-3.5 rounded-2xl border-2 flex items-center justify-between text-left transition-all active:scale-[0.98] ${
                      accountId === a.id ? 'border-indigo-400 bg-indigo-50/50 shadow-sm shadow-indigo-500/5' : 'border-slate-200/60 bg-white'
                    }`}
                  >
                    <span className="text-[13px] font-semibold text-slate-700 flex items-center gap-1.5"><span>{meta?.flag}</span> {a.name}</span>
                    <span className="text-[12px] text-slate-400 tabular-nums">{a.currency}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="animate-fade-in">
            <div className="bg-slate-50/80 rounded-2xl p-4 border border-slate-100/60 text-center">
              <p className="text-[12px] text-slate-500 font-medium">{t('goal_no_link_desc')}</p>
            </div>
            <div className="mt-3">
              <label className="form-label">Currency</label>
              <div className="grid grid-cols-2 gap-2">
                {SUPPORTED_CURRENCIES.map(c => {
                  const meta = currencyMeta[c];
                  return (
                    <button key={c} type="button" onClick={() => setCurrency(c)}
                      className={`py-3 rounded-2xl border-2 text-[13px] font-semibold text-center transition-all active:scale-[0.97] flex items-center justify-center gap-1.5 ${
                        currency === c ? 'border-indigo-400 bg-indigo-50/50 text-indigo-700 shadow-sm' : 'border-slate-200/60 bg-white text-slate-500'
                      }`}
                    >{meta?.flag} {c}</button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {error && <p className="text-[12px] text-red-500 font-semibold bg-red-50 rounded-xl p-3">{error}</p>}
      </form>
    </Modal>
  );
}
