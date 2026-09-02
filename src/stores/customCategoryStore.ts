import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { customCategoriesDb } from '../lib/supabaseDb';
import { validateNewCategoryName, type CategoryValidationError } from '../lib/mergedCategories';
import type { CustomCategory, CustomCategoryType } from '../db';
import { reportError } from '../lib/errorReporter';

// Thrown by addCategory so the UI can map a code to a localized message.
export class CustomCategoryError extends Error {
  code: CategoryValidationError;
  constructor(code: CategoryValidationError) {
    super(code);
    this.name = 'CustomCategoryError';
    this.code = code;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: string }).code === '23505';
}

interface CustomCategoryState {
  categories: CustomCategory[];
  loading: boolean;
  loadCategories: () => Promise<void>;
  addCategory: (type: CustomCategoryType, name: string) => Promise<CustomCategory>;
  deleteCategory: (id: string) => Promise<void>;
  reset: () => void;
}

const INITIAL: { categories: CustomCategory[]; loading: boolean } = {
  categories: [],
  loading: false,
};

export const useCustomCategoryStore = create<CustomCategoryState>((set, get) => ({
  ...INITIAL,

  reset: () => set(INITIAL),

  loadCategories: async () => {
    set({ loading: true });
    try {
      const categories = await customCategoriesDb.getAll();
      set({ categories });
    } finally {
      set({ loading: false });
    }
  },

  addCategory: async (type, rawName) => {
    const existing = get().categories.filter((c) => c.type === type).map((c) => c.name);
    const result = validateNewCategoryName(rawName, type, existing);
    if (!result.ok) throw new CustomCategoryError(result.code);

    const category: CustomCategory = {
      id: uuid(),
      type,
      name: result.name,
      createdAt: new Date().toISOString(),
    };
    try {
      await customCategoriesDb.add(category);
    } catch (err) {
      // The DB unique index is the final backstop (e.g. a race across
      // devices). DUPLICATE is an expected outcome - not reported.
      if (isUniqueViolation(err)) throw new CustomCategoryError('DUPLICATE');
      reportError(err, { feature: 'customCategoryStore.addCategory', extra: { categoryType: type } });
      throw err;
    }
    set((s) => ({ categories: [...s.categories, category] }));
    return category;
  },

  deleteCategory: async (id) => {
    await customCategoriesDb.delete(id);
    set((s) => ({ categories: s.categories.filter((c) => c.id !== id) }));
  },
}));
