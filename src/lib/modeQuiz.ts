import type { AppMode } from '../db';

// A tiny, fun onboarding quiz that recommends an app mode. Each answer leans
// toward one mode; the recommendation is the mode with more leanings (ties go
// to full_tracker, the superset that can also do splits). Pure + testable; the
// UI maps the *Key fields to localized copy.
export interface QuizOption {
  emoji: string;
  labelKey: string;
  leansTo: AppMode;
}

export interface QuizQuestion {
  id: string;
  promptKey: string;
  options: QuizOption[];
}

export const MODE_QUIZ: QuizQuestion[] = [
  {
    id: 'purpose',
    promptKey: 'quiz_q1',
    options: [
      { emoji: '\u{1F4B0}', labelKey: 'quiz_q1_a', leansTo: 'full_tracker' },
      { emoji: '\u{1F9FE}', labelKey: 'quiz_q1_b', leansTo: 'splits_only' },
      { emoji: '\u{1F31F}', labelKey: 'quiz_q1_c', leansTo: 'full_tracker' },
    ],
  },
  {
    id: 'accounts',
    promptKey: 'quiz_q2',
    options: [
      { emoji: '\u{1F3E6}', labelKey: 'quiz_q2_a', leansTo: 'full_tracker' },
      { emoji: '\u{1F645}', labelKey: 'quiz_q2_b', leansTo: 'splits_only' },
    ],
  },
  {
    id: 'budget',
    promptKey: 'quiz_q3',
    options: [
      { emoji: '\u{1F4CA}', labelKey: 'quiz_q3_a', leansTo: 'full_tracker' },
      { emoji: '\u{1F91D}', labelKey: 'quiz_q3_b', leansTo: 'splits_only' },
    ],
  },
];

// Recommend a mode from the per-question leanings. Tie → full_tracker (it can
// do everything splits_only does, plus accounts/budgets).
export function recommendMode(answers: readonly AppMode[]): AppMode {
  const splits = answers.filter((a) => a === 'splits_only').length;
  const full = answers.filter((a) => a === 'full_tracker').length;
  return splits > full ? 'splits_only' : 'full_tracker';
}
