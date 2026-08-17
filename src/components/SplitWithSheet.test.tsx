import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SplitWithSheet, type SplitPlan } from './SplitWithSheet';
import { formatMoney } from '../lib/constants';

const THREE_WAY: SplitPlan = {
  direction: 'i_paid',
  method: 'equal',
  myShare: 400,
  others: [
    { personId: 'p-ali', personName: 'Ali', amount: 400 },
    { personId: 'p-sara', personName: 'Sara', amount: 400 },
  ],
  payer: null,
  partyCount: 3,
};

function render(plan: SplitPlan | null, total = 1200) {
  return renderToStaticMarkup(
    <SplitWithSheet
      open
      onClose={() => undefined}
      total={total}
      currency="AED"
      initial={plan}
      onApply={() => undefined}
    />,
  );
}

describe('SplitWithSheet', () => {
  it('restores an existing plan and shows every participant including the user', () => {
    const html = render(THREE_WAY);
    expect(html).toContain('You');
    expect(html).toContain('Ali');
    expect(html).toContain('Sara');
  });

  it('previews the per-person share for the bill it was given', () => {
    const html = render(THREE_WAY);
    // 1200 across 3 people — the preview must show the real share, not the
    // amounts baked into the incoming plan.
    expect(html).toContain(formatMoney(400, 'AED'));
  });

  it('recomputes shares when the bill changes rather than reusing stale amounts', () => {
    const html = render(THREE_WAY, 900);
    expect(html).toContain(formatMoney(300, 'AED'));
    expect(html).not.toContain(formatMoney(400, 'AED'));
  });

  it('tells the user the FULL bill leaves the account, not just their share', () => {
    const html = render(THREE_WAY);
    expect(html).toContain(formatMoney(1200, 'AED')); // total out
    expect(html).toContain(formatMoney(800, 'AED'));  // coming back
  });

  it('names the payer and says nothing leaves the account when someone else paid', () => {
    const html = render({
      ...THREE_WAY,
      direction: 'they_paid',
      others: [],
      payer: { personId: 'p-ali', personName: 'Ali' },
      partyCount: 2,
    }, 800);
    expect(html).toContain('Ali');
    expect(html).toContain('Nothing leaves your account now');
    expect(html).toContain(formatMoney(400, 'AED')); // my half of 800
  });

  it('offers to remove the split only when one is already applied', () => {
    expect(render(THREE_WAY)).toContain('Remove split');
    expect(render(null)).not.toContain('Remove split');
  });

  it('always states that no group is needed — the whole point of the feature', () => {
    expect(render(null)).toContain('No group needed');
  });
});
