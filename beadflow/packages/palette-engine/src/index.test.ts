import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  PaletteValidationError,
  deltaE2000,
  nearestPaletteColors,
  parsePalette,
  rgbToLab,
} from './index';

const validPalette = JSON.stringify({
  name: 'Verified',
  version: '1',
  colors: [
    { code: 'A1', hex: '#FFFFFF', rgb: [255, 255, 255] },
    { code: 'A2', hex: '#000000', rgb: [0, 0, 0] },
  ],
});

describe('palette import', () => {
  test('validates the bundled user-verified MARD palette', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../assets/palettes/mard221.json'),
      'utf8',
    );
    const report = parsePalette(source, 221);

    expect(report.palette.name).toBe('MARD 221');
    expect(report.palette.colors).toHaveLength(221);
    expect(new Set(report.palette.colors.map((color) => color.code))).toHaveLength(221);
  });

  test('rejects duplicate codes and HEX/RGB mismatches', () => {
    const invalid = JSON.stringify({
      name: 'Invalid',
      version: '1',
      colors: [
        { code: 'A1', hex: '#FFFFFF', rgb: [0, 0, 0] },
        { code: 'A1', hex: '#FFFFFF', rgb: [255, 255, 255] },
      ],
    });

    expect(() => parsePalette(invalid)).toThrow(PaletteValidationError);
  });
});

describe('color calculations', () => {
  test('matches the CIEDE2000 reference pair', () => {
    const distance = deltaE2000({ l: 50, a: 2.6772, b: -79.7751 }, { l: 50, a: 0, b: -82.7485 });
    expect(distance).toBeCloseTo(2.0425, 4);
  });

  test('returns the nearest active palette color', () => {
    const palette = parsePalette(validPalette).palette;
    const result = nearestPaletteColors(rgbToLab({ r: 250, g: 250, b: 250 }), palette.colors);
    expect(result[0]?.color.code).toBe('A1');
  });
});
