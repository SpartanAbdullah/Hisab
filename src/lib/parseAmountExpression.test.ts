import { describe, expect, it } from 'vitest';
import { parseAmountExpression } from './parseAmountExpression';

describe('parseAmountExpression', () => {
  it('evaluates a plain number', () => {
    expect(parseAmountExpression('100')).toBe(100);
    expect(parseAmountExpression('12.50')).toBe(12.5);
  });

  it('respects operator precedence', () => {
    expect(parseAmountExpression('120+45/3')).toBe(135);
    expect(parseAmountExpression('2*3+4')).toBe(10);
  });

  it('handles parentheses', () => {
    expect(parseAmountExpression('(10+20)/4')).toBe(7.5);
  });

  it('handles subtraction, multiplication and whitespace', () => {
    expect(parseAmountExpression('50 - 5')).toBe(45);
    expect(parseAmountExpression('12.5 * 2')).toBe(25);
  });

  it('handles leading decimals and unary minus', () => {
    expect(parseAmountExpression('.5+.5')).toBe(1);
    expect(parseAmountExpression('-5+10')).toBe(5);
  });

  it('rounds to money precision', () => {
    expect(parseAmountExpression('10/3')).toBe(3.33);
  });

  it('returns null for empty, garbage, or malformed input', () => {
    expect(parseAmountExpression('')).toBeNull();
    expect(parseAmountExpression('abc')).toBeNull();
    expect(parseAmountExpression('1++2')).toBeNull();
    expect(parseAmountExpression('1.2.3')).toBeNull();
    expect(parseAmountExpression('(1+2')).toBeNull();
  });

  it('returns null on divide-by-zero rather than Infinity', () => {
    expect(parseAmountExpression('5/0')).toBeNull();
  });

  it('never uses eval (rejects code-like input)', () => {
    expect(parseAmountExpression('alert(1)')).toBeNull();
    expect(parseAmountExpression('1;2')).toBeNull();
  });
});
