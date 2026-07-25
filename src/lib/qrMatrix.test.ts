import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import { buildQrMatrix } from './qrMatrix';
import { buildConnectUrl, extractConnectCode } from './connectQr';

// Rasterise a module grid into the RGBA buffer jsQR consumes. `scale` is the
// pixels-per-module a real screen would render at.
function rasterise(modules: boolean[][], scale: number) {
  const extent = modules.length;
  const size = extent * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dark = modules[Math.floor(y / scale)][Math.floor(x / scale)];
      const i = (y * size + x) * 4;
      const v = dark ? 0 : 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, size };
}

function decode(value: string, scale = 4): string | null {
  const { modules } = buildQrMatrix(value);
  const { data, size } = rasterise(modules, scale);
  return jsQR(data, size, size, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

// These are round trips through the SAME decoder the in-app scanner uses, so
// a regression that makes real codes unscannable fails here rather than in
// someone's hands at a dinner table.
describe('buildQrMatrix round-trip', () => {
  it('encodes a connect URL that jsQR reads back exactly', () => {
    const url = 'https://usehisaab.com/u/HSB-ABC234';
    expect(decode(url)).toBe(url);
  });

  it('survives the full app path: build → encode → decode → extract', () => {
    const url = buildConnectUrl('HSB-ABC234');
    const decoded = decode(url);
    expect(decoded).toBe(url);
    expect(extractConnectCode(decoded!)).toBe('ABC234');
  });

  it('still decodes at 2px per module (small screen, tight layout)', () => {
    const url = 'https://usehisaab.com/u/HSB-XYZ789';
    expect(decode(url, 2)).toBe(url);
  });

  it('handles a long origin without truncating the payload', () => {
    const url = 'https://staging.usehisaab.example.com/u/HSB-QWERTY';
    expect(decode(url)).toBe(url);
  });
});

describe('buildQrMatrix geometry', () => {
  it('surrounds the symbol with a 4-module quiet zone', () => {
    const { modules, extent } = buildQrMatrix('https://usehisaab.com/u/HSB-ABC234');
    for (let i = 0; i < extent; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        // Top, bottom, left and right borders must be entirely light —
        // a quiet zone eaten by layout is the classic "won't scan" bug.
        expect(modules[j][i]).toBe(false);
        expect(modules[extent - 1 - j][i]).toBe(false);
        expect(modules[i][j]).toBe(false);
        expect(modules[i][extent - 1 - j]).toBe(false);
      }
    }
  });

  it('emits one path square per dark module', () => {
    const { modules, path } = buildQrMatrix('https://usehisaab.com/u/HSB-ABC234');
    const darkCount = modules.flat().filter(Boolean).length;
    expect(path.match(/M/g)?.length).toBe(darkCount);
    expect(darkCount).toBeGreaterThan(0);
  });

  it('is square and includes both quiet zones in extent', () => {
    const { modules, extent } = buildQrMatrix('x', 4);
    expect(modules.length).toBe(extent);
    expect(modules[0].length).toBe(extent);
    // Version 1 is 21 modules; + 4 either side = 29 at minimum.
    expect(extent).toBeGreaterThanOrEqual(29);
  });
});
