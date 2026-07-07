// Generates every Hisaab icon asset from one source mark — "Single Wink"
// (docs/brand/LOGO_HANDOFF.md): green tile, stroke-drawn lowercase "h" with a
// closed-eye wink beside the top arm. Run with: node scripts/generate-icons.mjs
// Requires @resvg/resvg-js (devDependency). Keeps every surface byte-consistent.
// Keep the glyph in sync with src/components/BrandMark.tsx.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Brand tokens (LOGO_HANDOFF.md): green tile, ink glyph. Navy is the app
// chrome color (status bar / splash background), not part of the mark.
const GREEN = '#2FE3A0';
const INK = '#14182B';
const NAVY = '#0B0E2A';

// Handoff glyph on the 100 grid. The handoff tile spans 4..96, so for
// full-bleed icon surfaces the glyph is scaled 100/92 about the center —
// identical proportions, no transparent margin.
const GLYPH = `
  <path d="M36 26 V74 M36 56 C36 42 64 42 64 54 V74" stroke="${INK}" stroke-width="13" stroke-linecap="round" fill="none"/>
  <path d="M55 27 Q61 34 67 27" stroke="${INK}" stroke-width="7" stroke-linecap="round" fill="none"/>`;
const GLYPH_FB = `<g transform="translate(50 50) scale(1.08696) translate(-50 -50)">${GLYPH}</g>`;

const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">';
// Rounded squircle — favicon / PWA "any" / apple-touch / legacy launcher.
// rx 26.087 = the handoff's rx 24 scaled by 100/92.
const rounded = `${head}<rect width="100" height="100" rx="26.087" fill="${GREEN}"/>${GLYPH_FB}</svg>`;
// Full-bleed green — PWA maskable (the OS applies its own mask).
const maskable = `${head}<rect width="100" height="100" fill="${GREEN}"/>${GLYPH_FB}</svg>`;
// Circle — legacy round launcher icon.
const circle = `${head}<circle cx="50" cy="50" r="50" fill="${GREEN}"/>${GLYPH_FB}</svg>`;
// Transparent foreground for the Android adaptive icon (green comes from
// @color/ic_launcher_background). The glyph is scaled to ~2/3 so it sits
// inside the adaptive safe zone once the OS crops the outer border.
const foreground = `${head}<g transform="translate(50 50) scale(0.667) translate(-50 -50)">${GLYPH_FB}</g></svg>`;

function render(svg, px, rel) {
  const out = resolve(root, rel);
  mkdirSync(dirname(out), { recursive: true });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: px } }).render().asPng();
  writeFileSync(out, png);
  console.log(`  ${rel}  (${px}px)`);
}

console.log('PWA + web:');
render(rounded, 192, 'public/icon-192.png');
render(rounded, 512, 'public/icon-512.png');
render(maskable, 192, 'public/icon-192-maskable.png');
render(maskable, 512, 'public/icon-512-maskable.png');
render(rounded, 180, 'public/apple-touch-icon.png');

console.log('Android legacy launcher (square + round):');
const launcher = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
for (const [d, px] of launcher) {
  render(rounded, px, `android/app/src/main/res/mipmap-${d}/ic_launcher.png`);
  render(circle, px, `android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`);
}

console.log('Android adaptive foreground:');
const fg = [['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]];
for (const [d, px] of fg) {
  render(foreground, px, `android/app/src/main/res/mipmap-${d}/ic_launcher_foreground.png`);
}

// Capacitor splash: navy full-bleed with the tile mark centered at ~28% of
// the short edge. androidScaleType CENTER_CROP keeps the center visible on
// every aspect ratio, and the navy matches SplashScreen.backgroundColor +
// the in-app loading screen, so launch is one continuous navy surface.
console.log('Android splash screens:');
const splashes = [
  ['drawable', 480, 320],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
];
for (const [dir, w, h] of splashes) {
  const s = Math.round(Math.min(w, h) * 0.28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="${NAVY}"/>
    <g transform="translate(${(w - s) / 2} ${(h - s) / 2}) scale(${s / 100})">
      <rect width="100" height="100" rx="26.087" fill="${GREEN}"/>${GLYPH_FB}
    </g>
  </svg>`;
  render(svg, w, `android/app/src/main/res/${dir}/splash.png`);
}

console.log('Done.');
