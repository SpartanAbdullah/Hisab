import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnimatedMoney } from './AnimatedMoney';

// The count-up runs on requestAnimationFrame, which doesn't exist in this
// suite's node environment — and that is exactly the case worth pinning. The
// FIRST paint (server render, no-JS, or the frame before rAF fires) must show
// the REAL figure, never a placeholder zero.
//
// Getting this wrong would put "AED 0" on the Home hero for a frame, which in
// a money app reads as "your balance is gone" rather than "still loading".
describe('AnimatedMoney', () => {
  it('renders the true amount on the very first paint, before any animation', () => {
    const html = renderToStaticMarkup(
      <AnimatedMoney amount={1234.5} currency="AED" />,
    );
    expect(html).toContain('1,234');
    expect(html).toContain('.50');
    expect(html).toContain('AED');
  });

  it('never shows a placeholder zero for a non-zero balance', () => {
    const html = renderToStaticMarkup(<AnimatedMoney amount={87654.21} currency="PKR" />);
    expect(html).toContain('87,654');
    expect(html).not.toContain('>0<');
  });

  it('renders the real figure when animation is switched off', () => {
    const html = renderToStaticMarkup(
      <AnimatedMoney amount={42} currency="AED" animate={false} />,
    );
    expect(html).toContain('42');
  });

  it('keeps MoneyDisplay negative handling intact', () => {
    const html = renderToStaticMarkup(<AnimatedMoney amount={-500} currency="AED" />);
    // MoneyDisplay renders a typographic minus, not a hyphen.
    expect(html).toContain('−');
    expect(html).toContain('500');
  });

  it('survives a non-finite amount instead of rendering NaN', () => {
    const html = renderToStaticMarkup(<AnimatedMoney amount={Number.NaN} currency="AED" />);
    expect(html).not.toContain('NaN');
  });
});
