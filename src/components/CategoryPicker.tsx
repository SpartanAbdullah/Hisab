import { useState } from 'react';
import { Plus, Check, X } from 'lucide-react';
import { useToast } from './Toast';
import { useT } from '../lib/i18n';
import { useCategoryOptions, withCurrentValue, type CategoryValidationError } from '../lib/mergedCategories';
import { useCustomCategoryStore, CustomCategoryError } from '../stores/customCategoryStore';
import type { CustomCategoryType } from '../db';

interface Props {
  type: CustomCategoryType;
  value: string;
  onChange: (category: string) => void;
  // Keep the current value visible even if it's not in the merged list (e.g.
  // editing a transaction whose custom category was later deleted).
  includeCurrent?: boolean;
  // Show the inline "+ New" affordance. Default on.
  allowCreate?: boolean;
}

// Button-grid category picker with an inline "+ New" affordance. The merged
// (built-in + custom) list comes from the custom-category store, so a category
// created here immediately appears in every other picker too.
export function CategoryPicker({ type, value, onChange, includeCurrent = false, allowCreate = true }: Props) {
  const t = useT();
  const toast = useToast();
  const addCategory = useCustomCategoryStore((s) => s.addCategory);
  const baseOptions = useCategoryOptions(type);
  const options = includeCurrent ? withCurrentValue(baseOptions, value) : baseOptions;

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const errorMessage = (code: CategoryValidationError) =>
    code === 'EMPTY' ? t('cat_err_empty') : code === 'TOO_LONG' ? t('cat_err_too_long') : t('cat_err_duplicate');

  const cancelAdd = () => { setAdding(false); setDraft(''); };

  const submit = async () => {
    const name = draft.trim();
    if (!name) { cancelAdd(); return; }
    setSaving(true);
    try {
      const created = await addCategory(type, name);
      onChange(created.name);
      toast.show({ type: 'success', title: t('cat_added') });
      cancelAdd();
    } catch (err) {
      const code = err instanceof CustomCategoryError ? err.code : 'DUPLICATE';
      toast.show({ type: 'error', title: errorMessage(code) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold border transition-colors active:scale-95 ${
            value === c ? 'bg-ink-900 text-white border-ink-900' : 'bg-cream-card text-ink-600 border-cream-border'
          }`}
        >
          {c}
        </button>
      ))}

      {allowCreate && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="px-3 py-1.5 rounded-xl text-[11px] font-semibold border border-dashed border-accent-500/60 text-accent-600 bg-accent-50/60 active:scale-95 flex items-center gap-1 transition-colors"
        >
          <Plus size={12} strokeWidth={2.6} /> {t('cat_add_new')}
        </button>
      )}

      {allowCreate && adding && (
        <span className="inline-flex items-center gap-1.5 rounded-xl border border-accent-500 bg-cream-card pl-2.5 pr-1.5 py-1">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void submit(); }
              if (e.key === 'Escape') cancelAdd();
            }}
            placeholder={t('cat_new_placeholder')}
            maxLength={28}
            className="w-28 text-[11px] bg-transparent outline-none text-ink-900 placeholder:text-ink-400"
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => void submit()}
            className="text-receive-600 disabled:opacity-40 press-xs"
            aria-label={t('cat_save')}
          >
            <Check size={14} strokeWidth={2.8} />
          </button>
          <button type="button" onClick={cancelAdd} className="text-ink-400 press-xs" aria-label={t('cancel')}>
            <X size={14} strokeWidth={2.6} />
          </button>
        </span>
      )}
    </div>
  );
}
