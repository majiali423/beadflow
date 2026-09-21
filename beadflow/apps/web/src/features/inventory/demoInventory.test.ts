import { parsePalette } from '@beadflow/palette-engine';
import { describe, expect, test } from 'vitest';

import { createDemoInventoryPlan } from './demoInventory';

const palette = parsePalette(
  JSON.stringify({
    name: 'MARD 221',
    version: '2026-07-user-verified',
    colors: [
      { code: 'H7', hex: '#010101', rgb: [1, 1, 1] },
      { code: 'H1', hex: '#FFFFFF', rgb: [255, 255, 255] },
      { code: 'H6', hex: '#2C2C2C', rgb: [44, 44, 44] },
      { code: 'H2', hex: '#FBFBFB', rgb: [251, 251, 251] },
      { code: 'A10', hex: '#F47E38', rgb: [244, 126, 56] },
      { code: 'B17', hex: '#9EB33E', rgb: [158, 179, 62] },
      { code: 'C5', hex: '#00B8DA', rgb: [0, 184, 218] },
      { code: 'F11', hex: '#592323', rgb: [89, 35, 35] },
    ],
  }),
).palette;

describe('virtual demo inventory plan', () => {
  test('keeps actual black and white families near 4000 and consumes common colors from 2000', () => {
    const plan = createDemoInventoryPlan(palette.colors);
    const byCode = new Map(palette.colors.map((color, index) => [color.code, plan[index]!]));

    for (const code of ['H7', 'H1', 'H6', 'H2']) {
      expect(byCode.get(code)?.quantity).toBeGreaterThanOrEqual(3200);
      expect(byCode.get(code)?.quantity).toBeLessThan(4000);
      expect(byCode.get(code)?.lowStockThreshold).toBe(800);
    }
    for (const code of ['A10', 'B17', 'C5', 'F11']) {
      expect(byCode.get(code)?.quantity).toBeGreaterThanOrEqual(1100);
      expect(byCode.get(code)?.quantity).toBeLessThan(2000);
      expect(byCode.get(code)?.lowStockThreshold).toBe(500);
    }
    expect(plan.every((item) => item.quantityConfidence === 'estimated')).toBe(true);
    expect(new Set(plan.map((item) => item.paletteColorId)).size).toBe(plan.length);
  });
});
