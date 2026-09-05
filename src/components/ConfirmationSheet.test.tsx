import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ConfirmationSheet } from './ConfirmationSheet';

// The coin drop and the settle-up burst are CROSS-FILE CONTRACTS: index.css
// owns the keyframes and the single reduced-motion gate under exact class
// names, and this sheet has to put those names on the right elements — the
// wallet <img>, an absolutely-positioned coin <img> that rests invisible, and
// (only when a debt closed) the CelebrationMark's bits. Break either side and
// nothing throws; the approved animation just silently never plays, which is
// exactly how the coin shipped as dead code the first time (reviewer blocker,
// 2026-09-05). These tests pin the wiring.
//
// renderToStaticMarkup runs no effects, so the sheet is rendered in its
// pre-slide frame; the header — the part under test — is fully present.
const render = (props: Partial<Parameters<typeof ConfirmationSheet>[0]> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ConfirmationSheet open onClose={() => {}} title={''} description={''} balanceChanges={[]} {...props} />
    </MemoryRouter>,
  );

describe('ConfirmationSheet coin drop', () => {
  it('renders the wallet with .animate-wallet-catch on every open — money moved', () => {
    const html = render();
    expect(html.match(/animate-wallet-catch/g)?.length).toBe(1);
    // The wallet is the 3D clay asset, not the lucide tick the sheet used
    // to show. (If the clay assets were missing the tick would be the
    // correct fallback; the generated registry ships both.)
    expect(html).toContain('/3d/wallet');
    expect(html).not.toContain('lucide-circle-check');
  });

  it('renders exactly one coin, absolutely positioned and resting at opacity 0', () => {
    const html = render();
    const coin = html.match(/<img\b[^>]*animate-coin-drop[^>]*>/g) ?? [];
    expect(coin).toHaveLength(1);
    expect(coin[0]).toContain('absolute');
    expect(coin[0]).toContain('opacity-0');
    // Headroom for the 46px fall (see the component comment): the coin rests
    // 12px inside the 36px stage, not above it.
    expect(coin[0]).toContain('top-3');
    expect(coin[0]).toContain('/3d/money');
  });

  it('keeps both moving images out of the accessibility tree', () => {
    const html = render();
    const imgs = html.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length).toBeGreaterThanOrEqual(2);
    for (const img of imgs) {
      expect(img).toContain('alt=""');
      expect(img).toContain('aria-hidden="true"');
    }
  });

  it('shows no confetti on an ordinary save', () => {
    const html = render();
    expect(html).not.toContain('animate-confetti-bit');
    expect(html).not.toContain('animate-celebrate-check');
  });

  it('renders nothing while closed, so every open is a fresh mount and the animations replay', () => {
    expect(render({ open: false })).toBe('');
  });
});

describe('ConfirmationSheet settle-up burst', () => {
  it('swaps the wallet for the CelebrationMark, with its confetti, when the save closed a debt', () => {
    const html = render({ settled: true });
    expect(html).toContain('animate-celebrate-ring');
    expect(html).toContain('animate-celebrate-pop');
    expect(html).toContain('animate-celebrate-check');
    expect(html.match(/animate-confetti-bit/g)?.length).toBe(20);
    expect(html).not.toContain('animate-coin-drop');
    expect(html).not.toContain('animate-wallet-catch');
  });
});
