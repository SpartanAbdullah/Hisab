import { describe, it, expect } from 'vitest';
import {
  CLAY_TINTS,
  CLAY_TINT_BY_DOMAIN,
  CLAY_ICON_SIZES,
  CLAY_FLOAT_RATIO,
  clayTintClass,
  clayIconPx,
  clayIconFloatOffset,
  clayIconClass,
  clayIconSrc,
  clayIconSrcSet,
  normalizeClayIconRegistry,
  resolveClayIcon,
  CLAY_STACK_FLOAT_RATIO,
  CLAY_STACK_GAP,
  clayIconStackOffset,
  clayIconVisibleHeight,
  clayTileStackPadding,
  clayTileLayoutClasses,
  clayTileIconClass,
  clayBadgeClass,
  clayCardLayoutClasses,
  type ClaySize,
} from './clay';

describe('tints', () => {
  it('carries the five product tints plus the two documented additions', () => {
    expect(CLAY_TINTS).toEqual(['gold', 'sky', 'blush', 'mint', 'coral', 'accent', 'neutral']);
  });

  it('has no duplicates', () => {
    expect(new Set(CLAY_TINTS).size).toBe(CLAY_TINTS.length);
  });

  it('maps every domain onto a real tint', () => {
    for (const tint of Object.values(CLAY_TINT_BY_DOMAIN)) {
      expect(CLAY_TINTS).toContain(tint);
    }
  });

  it('keeps the founder-specified domain pairings', () => {
    expect(CLAY_TINT_BY_DOMAIN.kameti).toBe('gold');
    expect(CLAY_TINT_BY_DOMAIN.splits).toBe('sky');
    expect(CLAY_TINT_BY_DOMAIN.khata).toBe('blush');
    expect(CLAY_TINT_BY_DOMAIN.savings).toBe('mint');
    expect(CLAY_TINT_BY_DOMAIN.spending).toBe('coral');
  });

  it('produces the CSS scope class', () => {
    expect(clayTintClass('gold')).toBe('clay-gold');
    expect(clayTintClass('neutral')).toBe('clay-neutral');
  });
});

describe('icon sizes', () => {
  const sizes: ClaySize[] = ['sm', 'md', 'lg'];

  it('is a strictly ascending ladder', () => {
    expect(clayIconPx('sm')).toBeLessThan(clayIconPx('md'));
    expect(clayIconPx('md')).toBeLessThan(clayIconPx('lg'));
  });

  it('exposes the exact px used for the <img> width/height attributes', () => {
    expect(CLAY_ICON_SIZES).toEqual({ sm: 36, md: 48, lg: 64 });
  });

  // These four numbers are the contract with index.css. The
  // .clay-icon-{sm,md,lg}.clay-icon-float rules hardcode -13/-17/-22px; if
  // the ratio or the size ladder ever moves, this test fails and the CSS has
  // to move with it. That is the whole reason the offset is a function.
  it('floats each size by 35% of its own height, rounded to a whole pixel', () => {
    expect(CLAY_FLOAT_RATIO).toBe(0.35);
    expect(clayIconFloatOffset('sm')).toBe(13); // 36 * 0.35 = 12.6
    expect(clayIconFloatOffset('md')).toBe(17); // 48 * 0.35 = 16.8
    expect(clayIconFloatOffset('lg')).toBe(22); // 64 * 0.35 = 22.4
  });

  it('never floats more than half the icon (it would detach from the tile)', () => {
    for (const size of sizes) {
      expect(clayIconFloatOffset(size)).toBeLessThan(clayIconPx(size) / 2);
    }
  });

  it('builds the img class list', () => {
    expect(clayIconClass('md', false)).toBe('clay-icon clay-icon-md');
    expect(clayIconClass('lg', true)).toBe('clay-icon clay-icon-lg clay-icon-float');
  });
});

describe('tile layout', () => {
  // The whole point of these three: other agents are consuming Tile3D right
  // now. The pre-existing call shape (corner placement, md icon, inline
  // badge) must keep emitting exactly the class strings it emitted before
  // iconPlacement/iconSize/badgePlacement existed.
  it('keeps the default path byte-identical to the pre-options behaviour', () => {
    expect(clayTileLayoutClasses({ hasIcon: true })).toEqual(['clay-tile-has-icon']);
    expect(clayTileIconClass('corner')).toBe('clay-tile-icon');
    expect(clayBadgeClass('inline')).toBe('clay-tile-badge');
  });

  it('emits nothing extra when there is no icon', () => {
    expect(clayTileLayoutClasses({ hasIcon: false })).toEqual([]);
    expect(clayTileLayoutClasses({ hasIcon: false, iconPlacement: 'top' })).toEqual([]);
  });

  it('explicit defaults match the implicit ones', () => {
    expect(clayTileLayoutClasses({ hasIcon: true, iconPlacement: 'corner', iconSize: 'md' })).toEqual(
      clayTileLayoutClasses({ hasIcon: true }),
    );
  });

  it('gives each corner pairing its own class rather than tweaking the md one', () => {
    expect(clayTileLayoutClasses({ hasIcon: true, iconSize: 'sm' })).toEqual(['clay-tile-has-icon-sm']);
    expect(clayTileLayoutClasses({ hasIcon: true, iconSize: 'lg' })).toEqual(['clay-tile-has-icon-lg']);
  });

  it('stacks for top placement, with no inline-end gutter class', () => {
    const sm = clayTileLayoutClasses({ hasIcon: true, iconPlacement: 'top', iconSize: 'sm' });
    expect(sm).toEqual(['clay-tile-stack', 'clay-tile-stack-sm']);
    expect(sm).not.toContain('clay-tile-has-icon');
    expect(clayTileLayoutClasses({ hasIcon: true, iconPlacement: 'top' })).toEqual([
      'clay-tile-stack',
      'clay-tile-stack-md',
    ]);
    expect(clayTileLayoutClasses({ hasIcon: true, iconPlacement: 'top', iconSize: 'lg' })).toEqual([
      'clay-tile-stack',
      'clay-tile-stack-lg',
    ]);
  });

  // label="hidden" LAYERS on the stacked classes; it never replaces them,
  // because the icon's reserved top padding still has to be there.
  it('adds the bare modifier when the label is hidden, keeping the stack classes', () => {
    expect(
      clayTileLayoutClasses({ hasIcon: true, iconPlacement: 'top', iconSize: 'lg', label: 'hidden' }),
    ).toEqual(['clay-tile-stack', 'clay-tile-stack-lg', 'clay-tile-stack-bare']);
  });

  it("defaults to a visible label, and 'below' is the same as omitting it", () => {
    expect(clayTileLayoutClasses({ hasIcon: true, iconPlacement: 'top', label: 'below' })).toEqual(
      clayTileLayoutClasses({ hasIcon: true, iconPlacement: 'top' }),
    );
  });

  // Corner tiles have no hidden-label shape: an icon bolted to the corner of
  // a box with no text in it is not a tile, it is a mistake.
  it('never hides the label on a corner tile', () => {
    expect(clayTileLayoutClasses({ hasIcon: true, label: 'hidden' })).toEqual(['clay-tile-has-icon']);
  });

  it('positions the icon by placement', () => {
    expect(clayTileIconClass('top')).toBe('clay-tile-icon-top');
  });

  // Corner badge LAYERS on the base pill so it inherits cream-card + ink-900,
  // the only pairing that clears AA across all seven tints.
  it('layers the corner badge on top of the base pill', () => {
    expect(clayBadgeClass('corner')).toBe('clay-tile-badge clay-tile-badge-corner');
    expect(clayBadgeClass('corner').split(' ')).toContain('clay-tile-badge');
  });
});

describe('stacked icon geometry', () => {
  it('overhangs more than a corner icon, so it still reads as floating', () => {
    expect(CLAY_STACK_FLOAT_RATIO).toBe(0.4);
    expect(CLAY_STACK_FLOAT_RATIO).toBeGreaterThan(CLAY_FLOAT_RATIO);
    for (const size of ['sm', 'md', 'lg'] as ClaySize[]) {
      expect(clayIconStackOffset(size)).toBeGreaterThan(clayIconFloatOffset(size));
    }
  });

  // These six numbers ARE the contract with index.css:
  //   .clay-icon-{sm,md,lg}.clay-tile-icon-top { margin-block-start: -14/-19/-26px }
  //   .clay-tile-stack-{sm,md,lg}             { padding-block-start: 30/37/46px }
  // If the ratio or the size ladder moves, this fails and the CSS moves too.
  it('pins the offsets the .clay-tile-icon-top rules hardcode', () => {
    expect(clayIconStackOffset('sm')).toBe(14); // 36 * 0.4 = 14.4
    expect(clayIconStackOffset('md')).toBe(19); // 48 * 0.4 = 19.2
    expect(clayIconStackOffset('lg')).toBe(26); // 64 * 0.4 = 25.6
  });

  it('pins the top padding the .clay-tile-stack-* rules hardcode', () => {
    expect(CLAY_STACK_GAP).toBe(8);
    expect(clayTileStackPadding('sm')).toBe(30);
    expect(clayTileStackPadding('md')).toBe(37);
    expect(clayTileStackPadding('lg')).toBe(46);
  });

  // The reason the padding exists at all: the title must clear the art.
  it('always reserves the visible part of the icon plus a real gap', () => {
    for (const size of ['sm', 'md', 'lg'] as ClaySize[]) {
      expect(clayIconVisibleHeight(size)).toBe(clayIconPx(size) - clayIconStackOffset(size));
      expect(clayTileStackPadding(size)).toBeGreaterThan(clayIconVisibleHeight(size));
    }
  });

  // A 4-up grid on a 360px phone: 360 - 40 gutters - 3*8 gaps = 296 / 4 = 74px.
  // The stacked tile has 6px inline padding each side, so a 36px icon must fit
  // with room to spare — this is the constraint that made 'top' exist.
  it('fits a sm icon in a 74px 4-up tile', () => {
    const tileWidth = (360 - 40 - 3 * 8) / 4;
    expect(tileWidth).toBe(74);
    expect(clayIconPx('sm')).toBeLessThan(tileWidth - 2 * 6);
  });

  // The founder's ask (2026-09-03) was "make the icons more obvious", and lg
  // on a 4-up grid is how: 64px of art on a 74px tile is 86% of its width —
  // deliberately past the 74% the corner layout ever reserved, and past the
  // tile's own 6px padding box. It still must not be WIDER than the tile, or
  // adjacent icons in a row start touching across the 8px gap.
  it('lets an lg icon dominate a 74px 4-up tile without overflowing it', () => {
    const tileWidth = (360 - 40 - 3 * 8) / 4;
    expect(clayIconPx('lg')).toBeGreaterThan(tileWidth * 0.74);
    expect(clayIconPx('lg')).toBeLessThan(tileWidth);
    // It overflows the 6px padding box on purpose — that is the "bigger than
    // its box" read, and it only works because nothing in the clay system
    // sets overflow: hidden.
    expect(clayIconPx('lg')).toBeGreaterThan(tileWidth - 2 * 6);
  });

  // Minimum tap target (design-system §4 / .clay-tile min-height: 44px).
  // The title dropped to 11px in the 2026-09-03 pass, so the arithmetic that
  // proves the target is still legal had to move with it.
  it('keeps every stacked pairing above the 44px tap target', () => {
    for (const size of ['sm', 'md', 'lg'] as ClaySize[]) {
      // top padding + an 11px title line + 10px bottom padding
      expect(clayTileStackPadding(size) + 11 + 10).toBeGreaterThanOrEqual(44);
      // …and with the label hidden: top padding + .clay-tile-stack-bare's
      // 14px bottom padding, no text at all.
      expect(clayTileStackPadding(size) + 14).toBeGreaterThanOrEqual(44);
    }
  });
});

describe('card layout', () => {
  it('keeps the default path byte-identical to the pre-options behaviour', () => {
    expect(clayCardLayoutClasses({})).toEqual(['clay-card-md']);
    expect(clayCardLayoutClasses({ padding: 'md' })).toEqual(['clay-card-md']);
  });

  it('covers every padding rung, including none', () => {
    for (const p of ['none', 'sm', 'md', 'lg'] as const) {
      expect(clayCardLayoutClasses({ padding: p })).toEqual([`clay-card-${p}`]);
    }
  });

  it('reserves the icon gutter when a card carries a corner icon', () => {
    expect(clayCardLayoutClasses({ hasIcon: true })).toEqual(['clay-card-md', 'clay-card-has-icon']);
  });

  // padding="none" means the caller owns the spacing; silently adding 64px
  // back would defeat the only reason that rung exists.
  it('never adds a gutter under padding="none"', () => {
    expect(clayCardLayoutClasses({ padding: 'none', hasIcon: true })).toEqual(['clay-card-none']);
  });
});

describe('asset urls', () => {
  it('points at the public/3d output of the asset pipeline', () => {
    expect(clayIconSrc('coins')).toBe('/3d/coins.webp');
    expect(clayIconSrcSet('coins')).toBe('/3d/coins@2x.webp 2x');
  });

  it('names only the 2x in srcSet, since 1x is already in src', () => {
    expect(clayIconSrcSet('receipt').split(',')).toHaveLength(1);
    expect(clayIconSrcSet('receipt')).toMatch(/ 2x$/);
  });
});

describe('normalizeClayIconRegistry', () => {
  it('accepts a record of metadata (the expected generated shape)', () => {
    const reg = normalizeClayIconRegistry({
      coins: { width: 512, height: 512, credit: 'CC0' },
      receipt: { width: 256, height: 256 },
    });
    expect(Object.keys(reg).sort()).toEqual(['coins', 'receipt']);
    expect(reg.coins).toEqual({ width: 512, height: 512, credit: 'CC0' });
    expect(reg.receipt.credit).toBeUndefined();
  });

  it('accepts a plain array of names', () => {
    const reg = normalizeClayIconRegistry(['coins', 'chat']);
    expect(Object.keys(reg).sort()).toEqual(['chat', 'coins']);
    expect(reg.coins).toEqual({ width: 0, height: 0 });
  });

  it('accepts manifest.json’s own [{ name, width, height, credit }] shape', () => {
    const reg = normalizeClayIconRegistry([
      { name: 'coins', width: 512, height: 512, credit: 'CC0 / Foo' },
    ]);
    expect(reg.coins).toEqual({ width: 512, height: 512, credit: 'CC0 / Foo' });
  });

  it('accepts a Set', () => {
    expect(Object.keys(normalizeClayIconRegistry(new Set(['coins'])))).toEqual(['coins']);
  });

  it('fails closed on junk rather than throwing', () => {
    expect(normalizeClayIconRegistry(null)).toEqual({});
    expect(normalizeClayIconRegistry(undefined)).toEqual({});
    expect(normalizeClayIconRegistry(42)).toEqual({});
    expect(normalizeClayIconRegistry('coins')).toEqual({});
    expect(normalizeClayIconRegistry([1, 2, null])).toEqual({});
  });

  it('coerces non-numeric dimensions to 0 instead of leaking NaN into width/height', () => {
    const reg = normalizeClayIconRegistry({ coins: { width: '512', height: null } });
    expect(reg.coins).toEqual({ width: 0, height: 0, credit: undefined });
  });

  // The generator ships `{ w, h }`; public/3d/manifest.json ships
  // `{ width, height, source }`. Both must survive the same normaliser.
  it('accepts the generator’s short { w, h } spelling', () => {
    const reg = normalizeClayIconRegistry({ coins: { w: 160, h: 160 } });
    expect(reg.coins.width).toBe(160);
    expect(reg.coins.height).toBe(160);
  });

  it('falls back to the manifest’s `source` when there is no `credit`', () => {
    const reg = normalizeClayIconRegistry([
      { name: 'coins', width: 160, height: 160, source: '3dicons.co', license: 'CC0-1.0' },
    ]);
    expect(reg.coins.credit).toBe('3dicons.co');
  });
});

describe('resolveClayIcon', () => {
  const registry = normalizeClayIconRegistry(['coins', 'receipt']);

  it('returns the name when the pipeline produced that asset', () => {
    expect(resolveClayIcon('coins', registry)).toBe('coins');
  });

  // The load-bearing case: an icon the sibling agent has not shipped yet
  // must render NOTHING, never a broken <img>.
  it('returns null for an unknown name', () => {
    expect(resolveClayIcon('unicorn', registry)).toBeNull();
  });

  it('returns null for missing/empty names', () => {
    expect(resolveClayIcon(undefined, registry)).toBeNull();
    expect(resolveClayIcon(null, registry)).toBeNull();
    expect(resolveClayIcon('', registry)).toBeNull();
  });

  // Guards against `registry['toString']` resolving to Object.prototype and
  // making every inherited member look like a shipped icon.
  it('does not resolve inherited Object.prototype members', () => {
    expect(resolveClayIcon('toString', registry)).toBeNull();
    expect(resolveClayIcon('constructor', registry)).toBeNull();
  });

  it('returns null against an empty registry', () => {
    expect(resolveClayIcon('coins', {})).toBeNull();
  });
});
