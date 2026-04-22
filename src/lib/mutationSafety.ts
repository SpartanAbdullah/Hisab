// Two-phase commit emulation for multi-step mutations that touch Supabase and
// Zustand. Supabase has no client-side transactions, so we can't atomically
// debit one account and credit another. If the second write fails, the first
// one has already committed and the user sees money vanish.
//
// MutationScope lets the caller register an inverse for every side-effect as
// it happens. On a thrown error, rollback() runs the registered inverses in
// LIFO order. On success, commit() discards them.
//
// Compensations may themselves fail (same network outage that killed the
// forward write usually kills the inverse). rollback() still runs every
// remaining compensation best-effort and returns the collected errors so the
// caller can decide whether to force a refetch from remote truth.

export type Compensation = () => Promise<void> | void;

export interface RollbackResult {
  ok: boolean;
  errors: unknown[];
}

export class MutationScope {
  private compensations: Compensation[] = [];
  private active = true;

  register(compensation: Compensation): void {
    if (!this.active) return;
    this.compensations.push(compensation);
  }

  commit(): void {
    this.active = false;
    this.compensations = [];
  }

  async rollback(): Promise<RollbackResult> {
    if (!this.active) return { ok: true, errors: [] };
    this.active = false;
    const errors: unknown[] = [];
    for (let i = this.compensations.length - 1; i >= 0; i--) {
      try {
        await this.compensations[i]();
      } catch (err) {
        errors.push(err);
      }
    }
    this.compensations = [];
    return { ok: errors.length === 0, errors };
  }
}

// Convenience: wrap a full mutation flow. The caller's `apply` function
// registers its own compensations on the passed scope and returns a value.
// If apply throws, we roll back and re-throw. If rollback itself partially
// fails, the caller's `onRollbackFailure` is invoked (typically a refetch)
// before the original error propagates.
export async function runSafeMutation<T>(apply: (scope: MutationScope) => Promise<T>, onRollbackFailure?: (errors: unknown[]) => Promise<void> | void): Promise<T> {
  const scope = new MutationScope();
  try {
    const result = await apply(scope);
    scope.commit();
    return result;
  } catch (originalError) {
    const rollback = await scope.rollback();
    if (!rollback.ok && onRollbackFailure) {
      try {
        await onRollbackFailure(rollback.errors);
      } catch {
        // Ignore — we're already in the error path for the original failure.
      }
    }
    throw originalError;
  }
}
