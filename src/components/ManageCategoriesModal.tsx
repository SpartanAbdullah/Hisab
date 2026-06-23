import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { confirmDestructive } from './ConfirmDestructiveSheet';
import { useT } from '../lib/i18n';
import { builtInsFor, type CategoryValidationError } from '../lib/mergedCategories';
import { useCustomCategoryStore, CustomCategoryError } from '../stores/customCategoryStore';
import type { CustomCategoryType } from '../db';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Central place to add/remove custom categories for both expense and income.
// Built-ins are shown read-only (they can't be removed); the user's own
// categories sit above them with a delete affordance. Deleting never rewrites
// historical rows — it only removes the name from future pickers.
export function ManageCategoriesModal({ open, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const categories = useCustomCategoryStore((s) => s.categories);
  const addCategory = useCustomCategoryStore((s) => s.addCategory);
  const deleteCategory = useCustomCategoryStore((s) => s.deleteCategory);

  const [tab, setTab] = useState<CustomCategoryType>('expense');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const builtIns = builtInsFor(tab);
  const custom = categories.filter((c) => c.type === tab);

  const errorMessage = (code: CategoryValidationError) =>
    code === 'EMPTY' ? t('cat_err_empty') : code === 'TOO_LONG' ? t('cat_err_too_long') : t('cat_err_duplicate');

  const handleAdd = async () => {
    const name = draft.trim();
    if (!name) return;
    setSaving(true);
    try {
      await addCategory(tab, name);
      setDraft('');
      toast.show({ type: 'success', title: t('cat_added') });
    } catch (err) {
      const code = err instanceof CustomCategoryError ? err.code : 'DUPLICATE';
      toast.show({ type: 'error', title: errorMessage(code) });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmDestructive({
      title: t('cat_delete_confirm_title'),
      description: t('cat_delete_confirm_body'),
      confirmLabel: t('cat_remove'),
    });
    if (!ok) return;
    await deleteCategory(id);
    toast.show({ type: 'success', title: t('cat_deleted') });
  };

  return (
    <Modal open={open} onClose={onClose} title={t('cat_manage_title')}>
      <div className="space-y-4">
        {/* Expense / Income tabs */}
        <div className="grid grid-cols-2 gap-2">
          {(['expense', 'income'] as CustomCategoryType[]).map((tb) => (
            <button
              key={tb}
              type="button"
              onClick={() => setTab(tb)}
              className={`selector-base justify-center text-[12.5px] font-semibold ${tab === tb ? 'selector-selected' : ''}`}
            >
              {tb === 'expense' ? t('cat_expense_tab') : t('cat_income_tab')}
            </button>
          ))}
        </div>

        {/* Add a new category */}
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
            placeholder={t('cat_add_placeholder')}
            maxLength={28}
            className="input-field flex-1"
          />
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={saving || !draft.trim()}
            className="shrink-0 px-4 rounded-2xl bg-ink-900 text-white text-[13px] font-semibold flex items-center gap-1.5 active:scale-95 disabled:opacity-30 transition-all"
          >
            <Plus size={14} strokeWidth={2.6} /> {t('cat_add_button')}
          </button>
        </div>

        {/* The user's own categories (deletable) */}
        <div>
          <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('cat_your_own')}</p>
          {custom.length === 0 ? (
            <p className="text-[12px] text-ink-400 py-3 text-center">{t('cat_none_custom')}</p>
          ) : (
            <div className="rounded-2xl bg-cream-card border border-cream-border divide-y divide-cream-hairline overflow-hidden">
              {custom.map((c) => (
                <div key={c.id} className="flex items-center gap-2 px-3.5 py-2.5">
                  <span className="flex-1 text-[13px] text-ink-900">{c.name}</span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(c.id)}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-pay-text active:bg-pay-50 transition-colors"
                    aria-label={`${t('cat_remove')} ${c.name}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Built-in categories (read-only) */}
        <div>
          <p className="text-[10.5px] font-semibold text-ink-500 uppercase tracking-[0.12em] mb-2">{t('cat_built_in')}</p>
          <div className="flex flex-wrap gap-1.5">
            {builtIns.map((c) => (
              <span key={c} className="px-3 py-1.5 rounded-xl text-[11px] font-semibold bg-cream-soft text-ink-500 border border-cream-hairline">
                {c}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
