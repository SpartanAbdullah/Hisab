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

//
// Reporting contract (audit 2026-09 H1). A rollback is a silent money-recovery
// event: without telemetry the operator only learns about it from an angry
// WhatsApp message. Four signals, all keyed on a greppable `feature` string:
//
//   mutationSafety.rollback.recovered            info   ≥1 inverse ran, ALL succeeded
//   mutationSafety.rollback.compensationFailed   error  ≥1 inverse threw
//   mutationSafety.runSafeMutation.rollbackFailed        error  apply threw AND rollback
//                                                        was not ok — carries the ORIGINAL
//                                                        error, the scariest state in the app
//   mutationSafety.runSafeMutation.recoveryHookFailed    error  onRollbackFailure itself threw
//
// `extra.mutation` carries the caller-supplied label (e.g. "transactionStore.
// processTransaction") and counts only — never amounts, names or note text.
// Reporting is strictly additive: no control flow, return value or throw
// behaviour depends on it.

import { reportError, reportMessage } from './errorReporter';

export type Compensation = () => Promise<void> | void;

export interface RollbackResult {
  ok: boolean;
  errors: unknown[];
}

/** PII-free one-liner per failed inverse, for the Sentry `extra` payload. */
function failureSignatures(errors: unknown[]): string[] {
  return errors.slice(0, 10).map((err) =>
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  );
}

export class MutationScope {
  private compensations: Compensation[] = [];
  private active = true;
  /**
   * Greppable owner of this mutation ("transactionStore.processTransaction").
   * Reported as `extra.mutation`; never user data.
   * (Plain field, not a parameter property — `erasableSyntaxOnly` is on.)
   */
  private readonly label: string;

  constructor(label = 'unknown') {
    this.label = label;
  }

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
    const attempted = this.compensations.length;
    const errors: unknown[] = [];
    for (let i = this.compensations.length - 1; i >= 0; i--) {
      try {
        await this.compensations[i]();
      } catch (err) {
        errors.push(err);
      }
    }
    this.compensations = [];
    if (attempted > 0) {
      if (errors.length > 0) {
        // Money moved and at least one inverse could not un-move it.
        reportError(errors[0], {
          feature: 'mutationSafety.rollback.compensationFailed',
          extra: {
            mutation: this.label,
            compensationsAttempted: attempted,
            compensationsFailed: errors.length,
            failures: failureSignatures(errors),
          },
        });
      } else {
        // Clean recovery — invisible to the user, but an operator watching a
        // spike here is watching a bug in the forward path.
        reportMessage('mutation rolled back cleanly', {
          feature: 'mutationSafety.rollback.recovered',
          level: 'info',
          extra: { mutation: this.label, compensationsAttempted: attempted },
        });
      }
    }
    return { ok: errors.length === 0, errors };
  }
}

// Convenience: wrap a full mutation flow. The caller's `apply` function
// registers its own compensations on the passed scope and returns a value.
// If apply throws, we roll back and re-throw. If rollback itself partially
// fails, the caller's `onRollbackFailure` is invoked (typically a refetch)
// before the original error propagates.
export async function runSafeMutation<T>(
  apply: (scope: MutationScope) => Promise<T>,
  onRollbackFailure?: (errors: unknown[]) => Promise<void> | void,
  label = 'unknown',
): Promise<T> {
  const scope = new MutationScope(label);
  try {
    const result = await apply(scope);
    scope.commit();
    return result;
  } catch (originalError) {
    const rollback = await scope.rollback();
    if (!rollback.ok) {
      // The compensation failures themselves were already reported by
      // rollback(); this second signal is the one that carries the ORIGINAL
      // error, i.e. what the user was trying to do when the money got stuck.
      reportError(originalError, {
        feature: 'mutationSafety.runSafeMutation.rollbackFailed',
        extra: {
          mutation: label,
          compensationsFailed: rollback.errors.length,
          failures: failureSignatures(rollback.errors),
          recoveryHook: onRollbackFailure ? 'present' : 'absent',
        },
      });
    }
    if (!rollback.ok && onRollbackFailure) {
      try {
        await onRollbackFailure(rollback.errors);
      } catch (hookError) {
        // Ignore — we're already in the error path for the original failure.
        // Still reported: a failed recovery hook means local state stayed
        // stale on top of a failed rollback.
        reportError(hookError, {
          feature: 'mutationSafety.runSafeMutation.recoveryHookFailed',
          extra: { mutation: label },
        });
      }
    }
    throw originalError;
  }
}
