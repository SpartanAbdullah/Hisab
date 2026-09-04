import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { Card3D } from './Card3D';
import { Icon3D } from './Icon3D';
import { Tile3D } from './Tile3D';
import { CLAY_TINTS, type ClayTint, type ClaySize } from '../lib/clay';

// ════════════════════════════════════════════════════════════════════════
// DEV-ONLY PREVIEW — NOT SHIPPED
//
// This component is deliberately NOT routed and NOT imported by anything.
// Vite tree-shakes it out of the bundle for exactly that reason (verified
// against scripts/check-bundle-size.mjs), so it costs zero bytes in
// production while still being typechecked and linted like real code.
//
// It exists so the page agents can eyeball the whole clay system at once:
// drop `<ClayShowcase />` at the top of any page, look at it in both
// themes, delete the line. Do not route it, do not link to it, do not
// import it from a shipped file.
//
// The dark toggle here writes `html.dark` directly rather than going
// through themeStore, so previewing dark does not persist a preference
// into the developer's own settings.
// ════════════════════════════════════════════════════════════════════════

// Copy lives in these arrays rather than in JSX so the file stays free of
// bare string literals (the i18n ratchet in eslint.config.js covers
// src/components/**). These are placeholder specimens, never user-facing —
// a shipped screen passes t('key') into Tile3D's `title` instead.
const TILES: { key: string; tint: ClayTint; icon: string; heading: string; sub: string; pill?: string }[] = [
  { key: 'kameti', tint: 'gold', icon: 'coins', heading: 'Kameti', sub: 'Committee ka hisaab', pill: '3 baaki' },
  { key: 'splits', tint: 'sky', icon: 'receipt', heading: 'Splits', sub: 'Group kharcha' },
  { key: 'khata', tint: 'blush', icon: 'handshake', heading: 'Khata', sub: 'Diya aur liya' },
  { key: 'savings', tint: 'mint', icon: 'piggybank', heading: 'Bachat', sub: 'Goals aur target' },
  { key: 'spending', tint: 'coral', icon: 'card', heading: 'Kharcha', sub: 'Is mahine ka' },
  { key: 'primary', tint: 'accent', icon: 'chart', heading: 'Analytics', sub: 'Rujhanat' },
];

const SIZES: ClaySize[] = ['sm', 'md', 'lg'];

const DEPTH_BUTTONS: { key: string; variant: 'primary' | 'secondary' | 'danger' | 'warning'; label: string }[] = [
  { key: 'p', variant: 'primary', label: 'Primary' },
  { key: 's', variant: 'secondary', label: 'Secondary' },
  { key: 'd', variant: 'danger', label: 'Danger' },
  { key: 'w', variant: 'warning', label: 'Warning' },
];

const SECTIONS = {
  tiles: 'Tier 1 — clay-tile (pressable)',
  stack: 'Tile — top + sm, 4-up @ 360px',
  stackLg: 'Tile — top + lg, label below (11px)',
  stackBare: 'Tile — top + lg, label hidden (sr-only)',
  cards: 'Tier 2 — clay-card (informational)',
  states: 'Tile states',
  icons: 'Icon3D sizes + float',
  buttons: 'Button depth',
  swatches: 'Tint scopes',
};

// 4-up stacked grid — the shape that made `iconPlacement="top"` exist.
const STACK_TILES: { key: string; tint: ClayTint; icon: string; heading: string }[] = [
  { key: 'kameti', tint: 'gold', icon: 'pot', heading: 'Kameti' },
  { key: 'splits', tint: 'sky', icon: 'receipt', heading: 'Splits' },
  { key: 'khata', tint: 'blush', icon: 'handshake', heading: 'Khata' },
  { key: 'savings', tint: 'mint', icon: 'piggybank', heading: 'Bachat' },
];

const STATE_TILES = [
  { key: 'plain', heading: 'No icon', sub: 'Bare tile, 44px min height' },
  { key: 'badge', heading: 'With badge', sub: 'Neutral pill under the subtitle' },
  { key: 'off', heading: 'Disabled', sub: 'Ambient shadow off, 50% opacity' },
];

const CARD_COPY = {
  heading: 'Informational surface',
  detail: 'No press, no focus ring, wider shadow, 24px radius. If it needs a tap, it is a tile.',
  note: 'Icons here sit inline, not floating — floating is a tile affordance.',
};

const ICON_NOTE = 'Unknown names render nothing at all, never a broken image.';
const STACK_BADGE = '2';
const INK_CTA = 'Raw ink CTA + clay-depth-ink';

export function ClayShowcase() {
  const t = useT();
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    setDark(next);
  };

  return (
    <div className="space-y-8 p-5 pt-8">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-2 rounded-xl bg-cream-card px-3 py-2 text-xs font-semibold text-ink-900 shadow-sm"
      >
        {dark ? <Sun size={14} /> : <Moon size={14} />}
        {dark ? t('theme_light') : t('theme_dark')}
      </button>

      {/* ---- Tier 1 ---- */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-500">{SECTIONS.tiles}</h2>
        <div className="grid grid-cols-2 gap-x-3 gap-y-6 pt-4">
          {TILES.map((tile) => (
            <Tile3D
              key={tile.key}
              tint={tile.tint}
              icon={tile.icon}
              title={tile.heading}
              subtitle={tile.sub}
              badge={tile.pill}
              onClick={() => undefined}
            />
          ))}
        </div>
      </section>

      {/* ---- Stacked 4-up ---- */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-500">{SECTIONS.stack}</h2>
        <div className="grid grid-cols-4 gap-2 pt-4">
          {STACK_TILES.map((tile, i) => (
            <Tile3D
              key={tile.key}
              tint={tile.tint}
              icon={tile.icon}
              iconPlacement="top"
              iconSize="sm"
              title={tile.heading}
              badge={i === 1 ? STACK_BADGE : undefined}
              badgePlacement="corner"
              selected={i === 0}
              onClick={() => undefined}
            />
          ))}
        </div>
      </section>

      {/* ---- Stacked 4-up, lg icon, label BELOW ----
          The home-grid shape after the 2026-09-03 founder pass: 64px of art
          on a ~74px tile, an 11px medium ink-700 caption under it. */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-500">{SECTIONS.stackLg}</h2>
        <div className="grid grid-cols-4 gap-x-2 gap-y-7 pt-7">
          {STACK_TILES.map((tile, i) => (
            <Tile3D
              key={tile.key}
              tint={tile.tint}
              icon={tile.icon}
              iconPlacement="top"
              iconSize="lg"
              title={tile.heading}
              badge={i === 1 ? STACK_BADGE : undefined}
              badgePlacement="corner"
              onClick={() => undefined}
            />
          ))}
        </div>
      </section>

      {/* ---- Stacked 4-up, lg icon, label HIDDEN ----
          The other half of the founder's either/or. The title is still
          rendered — as an sr-only span — so every tile keeps a real
          accessible name; only the pixels are gone. */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-500">{SECTIONS.stackBare}</h2>
        <div className="grid grid-cols-4 gap-x-2 gap-y-7 pt-7">
          {STACK_TILES.map((tile, i) => (
            <Tile3D
              key={tile.key}
              tint={tile.tint}
              icon={tile.icon}
              iconPlacement="top"
              iconSize="lg"
              label="hidden"
              title={tile.heading}
              badge={i === 1 ? STACK_BADGE : undefined}
              badgePlacement="corner"
              onClick={() => undefined}
            />
          ))}
        </div>
      </section>

      {/* ---- Tile states ---- */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-500">{SECTIONS.states}</h2>
        <div className="space-y-3">
          <Tile3D tint="sky" title={STATE_TILES[0].heading} subtitle={STATE_TILES[0].sub} onClick={() => undefined} />
          <div className="pt-4">
            <Tile3D
              tint="mint"
              icon="coins"
              title={STATE_TILES[1].heading}
              subtitle={STATE_TILES[1].sub}
              badge={STATE_TILES[1].key}
              onClick={() => undefined}
            />
          </div>
          <div className="pt-4">
            <Tile3D tint="coral" icon="bell" title={STATE_TILES[2].heading} subtitle={STATE_TILES[2].sub} disabled />
          </div>
        </div>
      </section>

      {/* ---- Tier 2 ---- */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-500">{SECTIONS.cards}</h2>
        <Card3D as="section" padding="lg">
          <p className="text-sm font-semibold text-ink-900">{CARD_COPY.heading}</p>
          <p className="mt-1 text-xs text-ink-600">{CARD_COPY.detail}</p>
        </Card3D>
        <Card3D tint="gold">
          <div className="flex items-center gap-3">
            <Icon3D name="receipt" size="sm" />
            <p className="text-xs text-ink-700">{CARD_COPY.note}</p>
          </div>
        </Card3D>
        {/* Corner icon on a tier-2 card + the style passthrough used for a
            staggered entrance delay. */}
        <div className="pt-4">
          <Card3D tint="mint" icon="trophy" style={{ animationDelay: '120ms' }}>
            <p className="text-sm font-semibold text-ink-900">{CARD_COPY.heading}</p>
          </Card3D>
        </div>
      </section>

      {/* ---- Icons ---- */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-500">{SECTIONS.icons}</h2>
        <Card3D tint="sky">
          <div className="flex items-end gap-5">
            {SIZES.map((size) => (
              <Icon3D key={size} name="coins" size={size} />
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-600">{ICON_NOTE}</p>
        </Card3D>
      </section>

      {/* ---- Buttons ---- */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-500">{SECTIONS.buttons}</h2>
        <div className="flex flex-wrap gap-3">
          {DEPTH_BUTTONS.map((b) => (
            <Button key={b.key} variant={b.variant} depth>
              {b.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          {DEPTH_BUTTONS.map((b) => (
            <Button key={b.key} variant={b.variant}>
              {b.label}
            </Button>
          ))}
        </div>
        {/* The ink CTA is not a <Button> variant — it is composed by hand, which
            is exactly how a page is expected to use .clay-depth-ink. */}
        <button
          type="button"
          className="clay-depth clay-depth-ink inline-flex items-center rounded-2xl bg-ink-900 px-5 py-3 text-sm font-semibold text-white"
        >
          {INK_CTA}
        </button>
      </section>

      {/* ---- Swatches ---- */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-500">{SECTIONS.swatches}</h2>
        <div className="grid grid-cols-4 gap-3">
          {CLAY_TINTS.map((tint) => (
            <Card3D key={tint} tint={tint} padding="sm">
              <p className="text-[11px] font-semibold text-ink-900">{tint}</p>
            </Card3D>
          ))}
        </div>
      </section>
    </div>
  );
}
