import { describe, it, expect } from 'vitest';
import { renderKametiSlipInnerHtml } from './kametiSlipPdf';

describe('renderKametiSlipInnerHtml', () => {
  const html = renderKametiSlipInnerHtml({
    committeeName: 'Office Committee',
    currency: 'PKR',
    round: 3,
    totalRounds: 10,
    pool: 80000,
    recipientName: 'Bilal',
    contributed: 24000,
    net: 56000,
    witnessUrl: 'https://usehisaab.com/kameti/witness/abc123',
    date: '2026-07-03T09:00:00.000Z',
    organiserName: 'Muhammad Abdullah',
  });

  it('leads with the payout amount, recipient, and round', () => {
    expect(html).toContain('Office Committee');
    expect(html).toContain('You received');
    expect(html).toContain('80,000.00');
    expect(html).toContain('Round 3 of 10');
    expect(html).toContain('Bilal received the Round 3 payout.');
  });

  it('shows the recipient position and the witness verify link', () => {
    expect(html).toContain('24,000.00'); // contributed
    expect(html).toContain('56,000.00'); // net
    expect(html).toContain('usehisaab.com/kameti/witness/abc123');
    expect(html).toContain('#047857'); // received teal
  });

  it('omits the witness block when no url is given', () => {
    const bare = renderKametiSlipInnerHtml({
      committeeName: 'C', currency: 'PKR', round: 1, totalRounds: 5, pool: 5000,
      recipientName: 'A', contributed: 1000, net: 4000, date: '2026-07-03T09:00:00.000Z',
    });
    expect(bare).not.toContain('Verify this kameti live');
  });
});
