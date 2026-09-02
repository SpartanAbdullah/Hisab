import { describe, expect, it } from 'vitest';
import { isLayerState, withLayer } from './backStackLayer';

describe('isLayerState', () => {
  it('matches a state carrying the same layer name', () => {
    expect(isLayerState({ layer: 'sheet' }, 'sheet')).toBe(true);
  });

  it('rejects a state with a different layer name', () => {
    expect(isLayerState({ layer: 'search' }, 'sheet')).toBe(false);
  });

  it('rejects null/undefined state', () => {
    expect(isLayerState(null, 'sheet')).toBe(false);
    expect(isLayerState(undefined, 'sheet')).toBe(false);
  });

  it('rejects non-object state', () => {
    expect(isLayerState('sheet', 'sheet')).toBe(false);
    expect(isLayerState(42, 'sheet')).toBe(false);
  });

  it('rejects an object with no layer field (e.g. a plain router state)', () => {
    expect(isLayerState({ usr: null, key: 'abc', idx: 3 }, 'sheet')).toBe(false);
  });
});

describe('withLayer', () => {
  it('adds the layer tag to an existing state object', () => {
    expect(withLayer({ usr: null, key: 'abc', idx: 3 }, 'sheet')).toEqual({
      usr: null,
      key: 'abc',
      idx: 3,
      layer: 'sheet',
    });
  });

  it('produces a state carrying just the layer tag when there was no prior state', () => {
    expect(withLayer(null, 'sheet')).toEqual({ layer: 'sheet' });
    expect(withLayer(undefined, 'sheet')).toEqual({ layer: 'sheet' });
  });

  it('overwrites a pre-existing layer field with the new layer name', () => {
    expect(withLayer({ layer: 'search' }, 'sheet')).toEqual({ layer: 'sheet' });
  });

  it('round-trips through isLayerState', () => {
    const state = withLayer({ key: 'xyz' }, 'scanner');
    expect(isLayerState(state, 'scanner')).toBe(true);
    expect(isLayerState(state, 'sheet')).toBe(false);
  });
});
