import type { InventoryQuantityConfidence, PaletteColor } from '@beadflow/shared-types';

export type DemoInventoryItem = {
  paletteColorId: string;
  quantity: number;
  quantityConfidence: InventoryQuantityConfidence;
  lowStockThreshold: number;
};

function codeHash(code: string): number {
  return Array.from(code).reduce((value, character) => value * 31 + character.charCodeAt(0), 17);
}

export function createDemoInventoryPlan(
  colors: readonly PaletteColor[],
): readonly DemoInventoryItem[] {
  return colors.map((color) => {
    const { r, g, b } = color.rgb;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const chroma = maximum - minimum;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const variation = Math.abs(codeHash(color.code));
    const isBlackOrWhite = chroma <= 18 && (luminance <= 55 || luminance >= 235);

    let startingQuantity = isBlackOrWhite ? 4000 : 2000;
    let consumption: number;
    if (isBlackOrWhite) {
      consumption = 260 + (variation % 441);
    } else if (chroma <= 35) {
      consumption = 480 + (variation % 421);
    } else if (r > g + 28 && r > b + 20) {
      consumption = 360 + (variation % 391);
    } else if (b > r + 28) {
      consumption = 300 + (variation % 351);
    } else if (g > r + 24) {
      consumption = 240 + (variation % 311);
    } else {
      consumption = 100 + (variation % 251);
    }
    startingQuantity = Math.max(startingQuantity - consumption, 0);

    return {
      paletteColorId: color.id,
      quantity: startingQuantity,
      quantityConfidence: 'estimated',
      lowStockThreshold: isBlackOrWhite ? 800 : 500,
    };
  });
}
