import { describe, expect, it, vi } from 'vitest';
import { MutationScope, runSafeMutation } from './mutationSafety';

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
