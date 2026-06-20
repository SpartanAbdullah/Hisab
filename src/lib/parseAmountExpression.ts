// Tiny safe calculator for amount fields — lets users type "120+45/3" or
// "(10+20)/4" instead of reaching for a calculator (the #2 most-requested
// feature for expense apps). Hand-written recursive-descent parser — NO eval().
// Returns null on anything malformed so callers fall back to the raw value.

export function parseAmountExpression(input: string): number | null {
  const s = (input ?? '').trim();
  if (!s) return null;

  // Fast path: a plain number.
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);

  // Whitelist characters — reject anything that isn't arithmetic.
  if (!/^[\d.\s+\-*/()]+$/.test(s)) return null;

  const tokens = s.match(/\d+\.?\d*|\.\d+|[+\-*/()]/g);
  if (!tokens) return null;

  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];

  function expr(): number | null {
    let left = term();
    if (left === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = eat();
      const right = term();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function term(): number | null {
    let left = factor();
    if (left === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = eat();
      const right = factor();
      if (right === null) return null;
      if (op === '/') {
        if (right === 0) return null;
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }
  function factor(): number | null {
    const tok = peek();
    if (tok === '(') {
      eat();
      const val = expr();
      if (val === null || eat() !== ')') return null;
      return val;
    }
    if (tok === '-') {
      eat();
      const v = factor();
      return v === null ? null : -v;
    }
    if (tok != null && /^[\d.]/.test(tok)) {
      eat();
      const n = Number(tok);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  const result = expr();
  if (result === null || pos !== tokens.length) return null; // leftover = malformed
  if (!Number.isFinite(result)) return null;
  return Math.round(result * 100) / 100; // money precision
}
