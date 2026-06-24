// Generates every Hisaab icon asset from one source mark (logo concept A:
// navy squircle, cream "H", violet balance-bar). Run with: node scripts/generate-icons.mjs
// Requires @resvg/resvg-js (devDependency). Keeps every surface byte-consistent.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The mark, defined once at a 512 base grid. Colors are the brand tokens:
// navy #0B0E2A, cream #F4F2EC, violet accent #7C5CFF.
const H = `
  <rect x="160" y="146" width="56" height="220" rx="10" fill="#F4F2EC"/>
  <rect x="296" y="146" width="56" height="220" rx="10" fill="#F4F2EC"/>
  <rect x="160" y="229" width="192" height="54" rx="10" fill="#7C5CFF"/>`;

const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">';
// Rounded squircle — favicon / PWA "any" / apple-touch / legacy launcher.
const rounded = `${head}<rect width="512" height="512" rx="112" fill="#0B0E2A"/>${H}</svg>`;
// Full-bleed navy — PWA maskable (the OS applies its own mask).
const maskable = `${head}<rect width="512" height="512" fill="#0B0E2A"/>${H}</svg>`;
// Circle — legacy round launcher icon.
const circle = `${head}<circle cx="256" cy="256" r="256" fill="#0B0E2A"/>${H}</svg>`;
// Transparent foreground for the Android adaptive icon. The H is scaled to ~2/3
// so it sits inside the adaptive safe zone once the OS crops the outer border.
const foreground = `${head}<g transform="translate(256 256) scale(0.667) translate(-256 -256)">${H}</g></svg>`;

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

console.log('Done.');
