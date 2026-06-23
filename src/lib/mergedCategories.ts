import { useMemo } from 'react';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from './constants';
import { useCustomCategoryStore } from '../stores/customCategoryStore';
import type { CustomCategoryType } from '../db';

// Merge built-in + user-defined category names.
//
// Rules:
//  - Built-in order is preserved.
//  - Custom names are appended, but BEFORE a trailing "Other" so "Other" always
//    stays the last fallback option.
//  - De-duped case-insensitively against the built-ins (a custom name equal to
//    a built-in is dropped — it can't be created in the first place, this is a
//    belt-and-braces guard).
// Pure so it can be unit-tested without React/stores.
export function mergeCategories(
  builtIns: readonly string[],
  customNames: readonly string[],
): string[] {
  const seen = new Set(builtIns.map((c) => c.toLowerCase()));
  const extras: string[] = [];
  for (const raw of customNames) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    extras.push(name);
  }
  if (extras.length === 0) return [...builtIns];
  const last = builtIns[builtIns.length - 1];
  if (last && last.toLowerCase() === 'other') {
    return [...builtIns.slice(0, -1), ...extras, last];
  }
  return [...builtIns, ...extras];
}

export function builtInsFor(type: CustomCategoryType): readonly string[] {
  return type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

export type CategoryValidationError = 'EMPTY' | 'TOO_LONG' | 'DUPLICATE';

// Validate a proposed custom-category name against the built-ins AND the user's
// existing custom names (case-insensitive). Pure + tested; the store calls this
// before writing, and the DB unique index is the final backstop.
export function validateNewCategoryName(
  rawName: string,
  type: CustomCategoryType,
  existingCustomNames: readonly string[],
): { ok: true; name: string } | { ok: false; code: CategoryValidationError } {
  const name = rawName.trim();
  if (!name) return { ok: false, code: 'EMPTY' };
  if (name.length > 28) return { ok: false, code: 'TOO_LONG' };
  const taken = new Set(
    [...builtInsFor(type), ...existingCustomNames].map((c) => c.toLowerCase()),
  );
  if (taken.has(name.toLowerCase())) return { ok: false, code: 'DUPLICATE' };
  return { ok: true, name };
}

// Ensure a (possibly deleted/legacy) current value still appears in a picker so
// editing an existing transaction never silently loses its category.
export function withCurrentValue(options: string[], current?: string | null): string[] {
  if (!current) return options;
  return options.some((o) => o.toLowerCase() === current.toLowerCase())
    ? options
    : [...options, current];
}

// React hook: the merged option list for a direction, recomputed when the
// custom-category store changes.
export function useCategoryOptions(type: CustomCategoryType): string[] {
  const categories = useCustomCategoryStore((s) => s.categories);
  return useMemo(() => {
    const names = categories.filter((c) => c.type === type).map((c) => c.name);
    return mergeCategories(builtInsFor(type), names);
  }, [categories, type]);
}
