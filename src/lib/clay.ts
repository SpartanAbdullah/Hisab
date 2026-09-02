// ============================================================
// 3D CLAY — pure helpers
//
// The clay treatment itself is CSS (see the "3D CLAY" block at the bottom
// of src/index.css and docs/design-system.md §10). This file holds only the
// parts that have to be reasoned about in TypeScript: the tint vocabulary,
// the icon size ladder, the asset URL shape, and the manifest lookup that
// decides whether an icon exists at all.
//
// Everything here is pure — no DOM, no imports — so it is covered by
// clay.test.ts, which is the repo's testing philosophy (vitest.config.ts:
// pure functions get tests, components get eyeballed).
// ============================================================

/**
 * The clay tint vocabulary.
 *
 * gold/sky/blush/mint/coral are the five product tints. `accent` and
 * `neutral` are two deliberate additions, documented in index.css and
 * docs/design-system.md §10:
 *   accent  — Button's `depth` primary (accent violet is the app's real
 *             primary-action colour; coral is reserved for money-out).
 *   neutral — Card3D's default, for a surface with no domain meaning.
 */
export const CLAY_TINTS = [
  'gold',
  'sky',
  'blush',
  'mint',
  'coral',
  'accent',
  'neutral',
] as const;

export type ClayTint = (typeof CLAY_TINTS)[number];

/** Domain → tint. The mapping the founder specified, in one place. */
export const CLAY_TINT_BY_DOMAIN = {
  kameti: 'gold',
  splits: 'sky',
  khata: 'blush',
  savings: 'mint',
  spending: 'coral',
  primary: 'accent',
  plain: 'neutral',
} as const satisfies Record<string, ClayTint>;

export type ClayDomain = keyof typeof CLAY_TINT_BY_DOMAIN;

/**
 * The CSS class that scopes a tint. Tint classes only remap custom
 * properties — they paint nothing — so this composes onto .clay-tile,
 * .clay-card, .clay-depth, or a bare wrapper.
 */
export function clayTintClass(tint: ClayTint): string {
  return `clay-${tint}`;
}

// ---- Icon sizes -----------------------------------------------------------

export type ClaySize = 'sm' | 'md' | 'lg';

/**
 * Rendered icon box, in CSS pixels. These MUST stay in lockstep with the
 * .clay-icon-{sm,md,lg} rules in index.css: the numbers here become the
 * <img> width/height attributes, which is what reserves layout space before
 * the asset loads (no CLS), while the CSS is what actually sizes the box.
 */
export const CLAY_ICON_SIZES: Record<ClaySize, number> = {
  sm: 36,
  md: 48,
  lg: 64,
};

/** How much of its own height a floating icon hangs above the tile's edge. */
export const CLAY_FLOAT_RATIO = 0.35;

export function clayIconPx(size: ClaySize): number {
  return CLAY_ICON_SIZES[size];
}

/**
 * Negative top margin, in px (a positive number here; the CSS applies it as
 * a negative). Rounded to a whole pixel — a fractional margin on a WebView
 * lands the icon on a half-pixel and softens its edge.
 *
 * Mirrors the .clay-icon-*.clay-icon-float rules in index.css; this function
 * is what proves the two agree (see clay.test.ts).
 */
export function clayIconFloatOffset(size: ClaySize): number {
  return Math.round(clayIconPx(size) * CLAY_FLOAT_RATIO);
}

/** Class list for the <img> itself. */
export function clayIconClass(size: ClaySize, float: boolean): string {
  const parts = ['clay-icon', `clay-icon-${size}`];
  if (float) parts.push('clay-icon-float');
  return parts.join(' ');
}

// ---- Tile layout ----------------------------------------------------------

/**
 * Where a tile's icon sits.
 *   corner — hangs off the top inline-end corner, text beside it (default).
 *   top    — centred over the tile's top edge, text centred beneath.
 *
 * `top` exists for dense grids: a 4-up row on a 360px phone leaves ~74px per
 * tile, and the corner layout reserves 64px for the icon alone.
 */
export type ClayIconPlacement = 'corner' | 'top';

/** Tiles carry sm or md art; `lg` is for standalone/hero use, not tiles. */
export type ClayTileIconSize = Extract<ClaySize, 'sm' | 'md'>;

/**
 * Where a tile's badge sits.
 *   inline — a pill in the content flow, under the subtitle (default).
 *   corner — a count pinned to the top inline-end corner, over the icon.
 */
export type ClayBadgePlacement = 'inline' | 'corner';

export type ClayCardPadding = 'none' | 'sm' | 'md' | 'lg';

/**
 * A stacked icon overhangs its tile more than a corner one — with the title
 * directly beneath rather than beside, it needs to clear the edge more
 * decisively to read as floating.
 */
export const CLAY_STACK_FLOAT_RATIO = 0.4;

/** Negative top margin (as a positive px number) for a stacked icon. */
export function clayIconStackOffset(size: ClaySize): number {
  return Math.round(clayIconPx(size) * CLAY_STACK_FLOAT_RATIO);
}

/** How much of a stacked icon's height actually sits inside the tile. */
export function clayIconVisibleHeight(size: ClaySize): number {
  return clayIconPx(size) - clayIconStackOffset(size);
}

/** Gap between the visible bottom of a stacked icon and the title. */
export const CLAY_STACK_GAP = 8;

/**
 * The tile's `padding-block-start` under a stacked icon. This is the number
 * that stops the title colliding with the art, so it is derived rather than
 * eyeballed — and clay.test.ts pins it to the `.clay-tile-stack-*` rules in
 * index.css, which is what keeps the two from drifting apart.
 */
export function clayTileStackPadding(size: ClaySize): number {
  return clayIconVisibleHeight(size) + CLAY_STACK_GAP;
}

/**
 * Layout classes a Tile3D adds on top of `.clay-tile` + its tint class.
 *
 * The default path (corner placement, md icon) returns exactly
 * `['clay-tile-has-icon']` — the single class Tile3D emitted before any of
 * these options existed. Tested, because other agents are consuming Tile3D
 * right now and a changed class string on the default path would be a silent
 * regression in their screens.
 */
export function clayTileLayoutClasses(opts: {
  hasIcon: boolean;
  iconPlacement?: ClayIconPlacement;
  iconSize?: ClayTileIconSize;
}): string[] {
  const { hasIcon, iconPlacement = 'corner', iconSize = 'md' } = opts;
  if (!hasIcon) return [];
  if (iconPlacement === 'top') return ['clay-tile-stack', `clay-tile-stack-${iconSize}`];
  return iconSize === 'sm' ? ['clay-tile-has-icon-sm'] : ['clay-tile-has-icon'];
}

/** Positioning class for the icon itself, by placement. */
export function clayTileIconClass(placement: ClayIconPlacement): string {
  return placement === 'top' ? 'clay-tile-icon-top' : 'clay-tile-icon';
}

/**
 * Badge classes. `corner` LAYERS on top of the base pill rather than
 * replacing it, so it keeps the cream-card + ink-900 pairing (the only one
 * that clears AA across all seven tints) and changes placement only.
 */
export function clayBadgeClass(placement: ClayBadgePlacement): string {
  return placement === 'corner' ? 'clay-tile-badge clay-tile-badge-corner' : 'clay-tile-badge';
}

/**
 * Layout classes a Card3D adds on top of `.clay-card` + its tint class.
 *
 * A floating icon on a tier-2 card is sanctioned — the tiers are separated by
 * the lip, the press, the focus ring and the radius, not by the art — so this
 * mirrors the tile's corner treatment. The one asymmetry: `padding="none"`
 * gets NO gutter, because a caller who asked for no padding owns the spacing
 * and would not expect 64px silently added back.
 */
export function clayCardLayoutClasses(opts: {
  padding?: ClayCardPadding;
  hasIcon?: boolean;
}): string[] {
  const { padding = 'md', hasIcon = false } = opts;
  const classes = [`clay-card-${padding}`];
  if (hasIcon && padding !== 'none') classes.push('clay-card-has-icon');
  return classes;
}

// ---- Asset URLs -----------------------------------------------------------

/** Where the sibling asset pipeline writes the icons. */
export const CLAY_ICON_DIR = '/3d';

export function clayIconSrc(name: string): string {
  return `${CLAY_ICON_DIR}/${name}.webp`;
}

/** 2x descriptor only — the 1x lives in `src`, so `srcSet` names just the @2x. */
export function clayIconSrcSet(name: string): string {
  return `${CLAY_ICON_DIR}/${name}@2x.webp 2x`;
}

// ---- Manifest ------------------------------------------------------------

export interface ClayIconMeta {
  width: number;
  height: number;
  credit?: string;
}

/**
 * Normalises whatever shape `src/lib/clayIcons.generated.ts` currently
 * exports into a lookup table.
 *
 * This function exists because that file is generated by a DIFFERENT agent
 * and is expected to be overwritten. Rather than couple every consumer to
 * one guessed shape, accept the three plausible ones — a record of metadata,
 * an array of names, or a Set — and fail closed (empty table) on anything
 * else. An unknown icon then renders nothing, which is the required
 * behaviour anyway: never a broken image.
 */
export function normalizeClayIconRegistry(source: unknown): Record<string, ClayIconMeta> {
  const out: Record<string, ClayIconMeta> = {};
  if (!source) return out;

  const names: string[] = [];
  const metas = new Map<string, ClayIconMeta>();

  if (Array.isArray(source)) {
    for (const entry of source) {
      if (typeof entry === 'string') {
        names.push(entry);
      } else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        // manifest.json's own shape: [{ name, width, height, credit }]
        const e = entry as { name: string; width?: unknown; height?: unknown; credit?: unknown };
        names.push(e.name);
        metas.set(e.name, readMeta(e));
      }
    }
  } else if (source instanceof Set) {
    for (const entry of source) if (typeof entry === 'string') names.push(entry);
  } else if (typeof source === 'object') {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      names.push(key);
      if (value && typeof value === 'object') metas.set(key, readMeta(value as Record<string, unknown>));
    }
  }

  for (const name of names) {
    if (!name) continue;
    out[name] = metas.get(name) ?? { width: 0, height: 0 };
  }
  return out;
}

// `w`/`h` are accepted alongside `width`/`height` because the generator emits
// the short form (src/lib/clayIcons.generated.ts) while manifest.json uses the
// long one — same data, two spellings, and neither is worth a build step to
// reconcile. `credit` likewise falls back to the manifest's `source`.
function readMeta(value: Record<string, unknown>): ClayIconMeta {
  const width = typeof value.width === 'number' ? value.width : value.w;
  const height = typeof value.height === 'number' ? value.height : value.h;
  const credit = typeof value.credit === 'string' ? value.credit : value.source;
  return {
    width: typeof width === 'number' ? width : 0,
    height: typeof height === 'number' ? height : 0,
    credit: typeof credit === 'string' ? credit : undefined,
  };
}

/**
 * Returns the icon name if the registry has it, otherwise null.
 *
 * The null is the whole point: Icon3D renders nothing at all for an unknown
 * name. A tile whose icon has not been produced yet must degrade to a plain
 * clay tile, never to a browser's broken-image glyph.
 */
export function resolveClayIcon(
  name: string | undefined | null,
  registry: Record<string, ClayIconMeta>,
): string | null {
  if (!name) return null;
  return Object.prototype.hasOwnProperty.call(registry, name) ? name : null;
}
