import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationScope, runSafeMutation } from './mutationSafety';
import {
  type ErrorContext,
  type ErrorReporter,
  resetErrorReportDedupe,
  setErrorReporter,
} from './errorReporter';

// Reporting is observed through the reporter seam rather than by spying on
// the module, so these tests also prove `setErrorReporter` is honoured.
interface Captured { kind: 'exception' | 'message'; payload: unknown; context?: ErrorContext }
let captured: Captured[] = [];
const spyReporter: ErrorReporter = {
  captureException: (error, context) => { captured.push({ kind: 'exception', payload: error, context }); },
  captureMessage: (message, context) => { captured.push({ kind: 'message', payload: message, context }); },
};
const noopReporter: ErrorReporter = { captureException: () => {}, captureMessage: () => {} };
const featuresOf = () => captured.map((c) => c.context?.feature);
const byFeature = (feature: string) => captured.find((c) => c.context?.feature === feature);

beforeEach(() => {
  captured = [];
  resetErrorReportDedupe();
  setErrorReporter(spyReporter);
});
afterEach(() => {
  setErrorReporter(noopReporter);
  resetErrorReportDedupe();
});

describe('MutationScope', () => {
  it('rolls back compensations in LIFO order on rollback', async () => {
    const calls: string[] = [];
    const scope = new MutationScope();
    scope.register(() => { calls.push('first'); });
    scope.register(() => { calls.push('second'); });
    scope.register(() => { calls.push('third'); });

    const result = await scope.rollback();
    // LIFO: third registered → first to run.
    expect(calls).toEqual(['third', 'second', 'first']);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('runs every compensation even when one throws, and collects errors', async () => {
    const calls: string[] = [];
    const scope = new MutationScope();
    scope.register(() => { calls.push('one'); });
    scope.register(() => { throw new Error('boom'); });
    scope.register(() => { calls.push('three'); });

    const result = await scope.rollback();
    expect(calls).toEqual(['three', 'one']);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect((result.errors[0] as Error).message).toBe('boom');
  });

  it('awaits async compensations sequentially', async () => {
    const calls: string[] = [];
    const scope = new MutationScope();
    scope.register(async () => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push('slow');
    });
    scope.register(() => { calls.push('fast'); });

    await scope.rollback();
    // "fast" registered second, so it runs first; "slow" must still wait
    // for its own promise to settle before next compensations run.
    expect(calls).toEqual(['fast', 'slow']);
  });

  it('commit() drops compensations and is idempotent', async () => {
    const calls: string[] = [];
    const scope = new MutationScope();
    scope.register(() => { calls.push('should-not-run'); });
    scope.commit();
    const result = await scope.rollback();
    expect(calls).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('register() after rollback is a no-op (cannot resurrect a torn scope)', async () => {
    const calls: string[] = [];
    const scope = new MutationScope();
    scope.register(() => { calls.push('before'); });
    await scope.rollback();
    scope.register(() => { calls.push('after'); });
    await scope.rollback();
    expect(calls).toEqual(['before']);
  });
});

describe('runSafeMutation', () => {
  it('returns the apply value on success and clears compensations', async () => {
    const calls: string[] = [];
    const value = await runSafeMutation(async (scope) => {
      scope.register(() => { calls.push('compensate'); });
      return 42;
    });
    expect(value).toBe(42);
    expect(calls).toEqual([]);
  });

  it('rolls back and re-throws the original error if apply fails', async () => {
    const calls: string[] = [];
    await expect(
      runSafeMutation(async (scope) => {
        scope.register(() => { calls.push('rollback-1'); });
        scope.register(() => { calls.push('rollback-2'); });
        throw new Error('original');
      }),
    ).rejects.toThrow('original');
    expect(calls).toEqual(['rollback-2', 'rollback-1']);
  });

  it('invokes onRollbackFailure when a compensation throws, but still re-throws original', async () => {
    // Typed signature so .mock.calls[i] is `[unknown[]]` not the default `[]`.
    const onRollbackFailure = vi.fn<(errors: unknown[]) => Promise<void>>(async () => undefined);
    await expect(
      runSafeMutation(
        async (scope) => {
          scope.register(() => { throw new Error('comp-failed'); });
          throw new Error('original');
        },
        onRollbackFailure,
      ),
    ).rejects.toThrow('original');
    expect(onRollbackFailure).toHaveBeenCalledTimes(1);
    expect(onRollbackFailure.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('swallows onRollbackFailure errors so the original error stays primary', async () => {
    const onRollbackFailure = vi.fn<(errors: unknown[]) => Promise<void>>(async () => {
      throw new Error('rollback handler exploded');
    });
    await expect(
      runSafeMutation(
        async (scope) => {
          scope.register(() => { throw new Error('comp'); });
          throw new Error('original');
        },
        onRollbackFailure,
      ),
    ).rejects.toThrow('original');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Audit 2026-09 H1 — the compensation path must not be silent.
// ─────────────────────────────────────────────────────────────────────────
describe('mutationSafety reporting contract', () => {
  it('reports an info breadcrumb when a rollback RUNS and every inverse succeeds', async () => {
    const scope = new MutationScope('transactionStore.processTransaction');
    scope.register(() => {});
    scope.register(() => {});
    await scope.rollback();

    const event = byFeature('mutationSafety.rollback.recovered');
    expect(event).toBeDefined();
    expect(event?.kind).toBe('message');
    expect(event?.context?.level).toBe('info');
    expect(event?.context?.extra).toMatchObject({
      mutation: 'transactionStore.processTransaction',
      compensationsAttempted: 2,
    });
  });

  it('stays silent when there was nothing to compensate', async () => {
    await new MutationScope('noop').rollback();
    await new MutationScope('noop2').rollback();
    expect(captured).toEqual([]);
  });

  it('stays silent on commit (the happy path must not cost quota)', async () => {
    await runSafeMutation(async (scope) => { scope.register(() => {}); return 1; }, undefined, 'happy');
    expect(captured).toEqual([]);
  });

  it('reports compensation failures at error level with the failed count', async () => {
    const scope = new MutationScope('loanStore.applyRepayment');
    scope.register(() => {});
    scope.register(() => { throw new Error('inverse-a'); });
    scope.register(() => { throw new Error('inverse-b'); });
    await scope.rollback();

    const event = byFeature('mutationSafety.rollback.compensationFailed');
    expect(event?.kind).toBe('exception');
    expect(event?.context?.extra).toMatchObject({
      mutation: 'loanStore.applyRepayment',
      compensationsAttempted: 3,
      compensationsFailed: 2,
    });
    // LIFO: 'inverse-b' registered last, so it failed first.
    expect((event?.context?.extra as { failures: string[] }).failures).toEqual([
      'Error: inverse-b',
      'Error: inverse-a',
    ]);
  });

  it('reports the ORIGINAL error when rollback itself fails', async () => {
    await expect(
      runSafeMutation(
        async (scope) => {
          scope.register(() => { throw new Error('comp-failed'); });
          throw new Error('original-money-error');
        },
        undefined,
        'transactionStore.deleteTransaction',
      ),
    ).rejects.toThrow('original-money-error');

    expect(featuresOf()).toEqual([
      'mutationSafety.rollback.compensationFailed',
      'mutationSafety.runSafeMutation.rollbackFailed',
    ]);
    const event = byFeature('mutationSafety.runSafeMutation.rollbackFailed');
    expect((event?.payload as Error).message).toBe('original-money-error');
    expect(event?.context?.extra).toMatchObject({
      mutation: 'transactionStore.deleteTransaction',
      compensationsFailed: 1,
      recoveryHook: 'absent',
    });
  });

  it('reports a throwing recovery hook without disturbing the original error', async () => {
    const onRollbackFailure = vi.fn<(errors: unknown[]) => Promise<void>>(async () => {
      throw new Error('refetch-exploded');
    });
    await expect(
      runSafeMutation(
        async (scope) => {
          scope.register(() => { throw new Error('comp'); });
          throw new Error('original');
        },
        onRollbackFailure,
        'splitStore.updateGroupExpense',
      ),
    ).rejects.toThrow('original');

    const event = byFeature('mutationSafety.runSafeMutation.recoveryHookFailed');
    expect((event?.payload as Error).message).toBe('refetch-exploded');
    expect(event?.context?.extra).toMatchObject({ mutation: 'splitStore.updateGroupExpense' });
  });

  it('does not report rollbackFailed when the rollback succeeded', async () => {
    await expect(
      runSafeMutation(
        async (scope) => { scope.register(() => {}); throw new Error('original'); },
        undefined,
        'ok-rollback',
      ),
    ).rejects.toThrow('original');
    expect(featuresOf()).toEqual(['mutationSafety.rollback.recovered']);
  });

  it('never lets a throwing reporter break a mutation', async () => {
    setErrorReporter({
      captureException: () => { throw new Error('sentry down'); },
      captureMessage: () => { throw new Error('sentry down'); },
    });
    const scope = new MutationScope('resilience');
    scope.register(() => { throw new Error('inverse'); });
    const result = await scope.rollback();
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('de-dupes an identical report from the same call site inside the window', async () => {
    for (let i = 0; i < 5; i += 1) {
      const scope = new MutationScope('retry-loop');
      scope.register(() => { throw new Error('same-failure'); });
      await scope.rollback();
    }
    expect(
      captured.filter((c) => c.context?.feature === 'mutationSafety.rollback.compensationFailed'),
    ).toHaveLength(1);
  });

  it('lets a DIFFERENT error from the same call site through immediately', async () => {
    for (const message of ['first', 'second', 'third']) {
      const scope = new MutationScope('varied');
      scope.register(() => { throw new Error(message); });
      await scope.rollback();
    }
    expect(
      captured.filter((c) => c.context?.feature === 'mutationSafety.rollback.compensationFailed'),
    ).toHaveLength(3);
  });
});
