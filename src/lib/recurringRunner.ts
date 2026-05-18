// Recurring runner: on app boot, scans recurring_transactions templates and
// surfaces any that are due (nextDueDate <= today). Each due template is
// posted to a queue and the user is prompted via a toast; on confirmation
// the template materialises into a real Transaction and its nextDueDate
// advances. Skipped templates simply stay at their old nextDueDate so they
// re-prompt on the next boot.
//
// The runner deliberately does NOT auto-create transactions. Money moving
// without user confirmation is the opposite of trust. Even if the user
// "approves" all by default, the prompt is the moment they notice
// "wait, my rent went up — I should edit this".

import { useRecurringStore } from '../stores/recurringStore';

const RUN_LOCK_KEY = 'hisaab_recurring_run_lock_v1';
const RUN_LOCK_TTL_MS = 60_000;

export async function runRecurringExpansion(): Promise<void> {
  // Cheap concurrency guard: if the user reloads or two tabs open, only one
  // runner should prompt. Soft lock with TTL so a crash doesn't permanently
  // block the runner.
  try {
    const existing = localStorage.getItem(RUN_LOCK_KEY);
    if (existing) {
      const ts = Number(existing);
      if (Number.isFinite(ts) && Date.now() - ts < RUN_LOCK_TTL_MS) return;
    }
    localStorage.setItem(RUN_LOCK_KEY, String(Date.now()));
  } catch {
    // localStorage unavailable — proceed without lock.
  }

  const templates = useRecurringStore.getState().templates;
  const todayIso = new Date().toISOString().slice(0, 10);
  const due = templates.filter((t) => t.active && t.nextDueDate <= todayIso);
  if (due.length === 0) return;

  // Emit a custom event the UI can listen to. The actual prompting widget
  // lives in src/components/RecurringDuePrompt.tsx — kept decoupled so this
  // module remains testable as a pure function over templates.
  try {
    window.dispatchEvent(
      new CustomEvent<RecurringDueDetail>('hisaab:recurring-due', {
        detail: { templates: due, todayIso },
      }),
    );
  } catch {
    // window unavailable in SSR / tests — fine, runner is a no-op there.
  }
}

export interface RecurringDueDetail {
  templates: ReturnType<typeof useRecurringStore.getState>['templates'];
  todayIso: string;
}
