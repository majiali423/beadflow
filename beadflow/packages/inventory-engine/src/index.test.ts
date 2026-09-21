import { parsePalette } from '@beadflow/palette-engine';
import type {
  InventoryItem,
  PatternCardMaterialCandidate,
  PatternCardReservation,
} from '@beadflow/shared-types';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  applyInventoryTransaction,
  calculateMaterialBalances,
  createPurchaseList,
  enrichMaterialBalances,
  InventoryValidationError,
  isLowStock,
  rankPatternCardRecommendations,
  validateInventory,
} from './index';

const codes = [
  'A1',
  'A10',
  'B17',
  'C5',
  'D8',
  'E3',
  'F11',
  'G2',
  'H6',
  'M1',
  'B4',
  'C12',
  'D20',
  'F7',
  'E17',
  'G16',
  'H18',
  'M7',
] as const;
const colorIds = codes.map((code) => `mard-221-2026-07-user-verified:${code}`);
const mardPalette = parsePalette(
  readFileSync(new URL('../../../assets/palettes/mard221.json', import.meta.url), 'utf8'),
  221,
).palette;

function realisticRequirements(total: number): ReadonlyMap<string, number> {
  const base = Math.floor(total / colorIds.length);
  return new Map(
    colorIds.map((colorId, index) => [colorId, base + (index < total % colorIds.length ? 1 : 0)]),
  );
}

function inventoryItem(
  paletteColorId: string,
  quantity: number,
  confidence: 'exact' | 'estimated' = 'exact',
): InventoryItem {
  return {
    id: `inventory-${paletteColorId}`,
    userId: 'user-1',
    paletteColorId,
    quantity,
    quantityConfidence: confidence,
    lowStockThreshold: 20,
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

describe('inventory and material engine', () => {
  test('calculates shortages, remaining stock and confidence without hiding negative remaining', () => {
    const requirements = realisticRequirements(3_505);
    const items = colorIds.map((colorId, index) =>
      inventoryItem(colorId, index % 2 === 0 ? 18 : 42, index === 2 ? 'estimated' : 'exact'),
    );

    const balances = calculateMaterialBalances(requirements, items);
    const estimated = balances.find((balance) => balance.paletteColorId === colorIds[2]);

    expect(balances.some((balance) => balance.shortage > 0)).toBe(true);
    expect(balances.some((balance) => balance.remaining < 0)).toBe(true);
    expect(estimated?.quantityConfidence).toBe('estimated');
    expect(
      balances.every(
        (balance) => balance.shortage === Math.max(balance.required - balance.available, 0),
      ),
    ).toBe(true);
  });

  test('creates a grouped, shortage-sorted text and CSV purchase list from real MARD colors', () => {
    const requirements = realisticRequirements(3_505);
    const inventory = colorIds.map((colorId, index) =>
      inventoryItem(
        colorId,
        index === 0 ? 110 : 24 + index,
        index % 3 === 0 ? 'estimated' : 'exact',
      ),
    );
    const balances = enrichMaterialBalances(
      calculateMaterialBalances(requirements, inventory),
      mardPalette.colors,
    );
    const purchaseList = createPurchaseList(balances);

    expect(purchaseList.items.length).toBeGreaterThan(8);
    expect(purchaseList.items.every((item) => item.shortage > 0)).toBe(true);
    expect(
      purchaseList.items.every(
        (item, index) => index === 0 || purchaseList.items[index - 1]!.shortage >= item.shortage,
      ),
    ).toBe(true);
    expect(purchaseList.groups.length).toBeGreaterThan(4);
    expect(purchaseList.copyText).toContain('BeadFlow MARD 采购清单');
    expect(purchaseList.copyText).toContain('当前库存为估算');
    expect(purchaseList.csv).toMatch(/^\uFEFFMARD色号,色名,色系,缺少数量,当前库存,库存可信度\r\n/);
    expect(purchaseList.csv.split('\r\n')).toHaveLength(purchaseList.items.length + 2);
  });

  test('applies a purchase immutably and creates a traceable transaction', () => {
    const original = [inventoryItem(colorIds[0]!, 80)];
    const result = applyInventoryTransaction(
      original,
      {
        id: 'transaction-purchase-1',
        userId: 'user-1',
        paletteColorId: colorIds[0]!,
        delta: 120,
        reason: 'purchase',
        createdAt: '2026-07-20T01:00:00.000Z',
      },
      { updatedAt: '2026-07-20T01:00:00.000Z' },
    );

    expect(original[0]?.quantity).toBe(80);
    expect(result.items[0]?.quantity).toBe(200);
    expect(result.transaction.reason).toBe('purchase');
    expect(result.transaction.delta).toBe(120);
  });

  test('creates a new exact inventory item only when an id is supplied', () => {
    const result = applyInventoryTransaction(
      [],
      {
        id: 'transaction-first-purchase',
        userId: 'user-1',
        paletteColorId: colorIds[1]!,
        delta: 300,
        reason: 'purchase',
        createdAt: '2026-07-20T01:00:00.000Z',
      },
      {
        inventoryItemId: 'inventory-new',
        updatedAt: '2026-07-20T01:00:00.000Z',
        quantityConfidence: 'estimated',
        lowStockThreshold: 50,
      },
    );

    expect(result.items[0]).toMatchObject({
      id: 'inventory-new',
      quantity: 300,
      quantityConfidence: 'estimated',
      lowStockThreshold: 50,
    });
  });

  test('rolls back an over-consumption without mutating inventory or emitting a transaction', () => {
    const original = [inventoryItem(colorIds[2]!, 45, 'estimated')];
    const snapshot = structuredClone(original);

    expect(() =>
      applyInventoryTransaction(
        original,
        {
          id: 'transaction-too-large',
          userId: 'user-1',
          paletteColorId: colorIds[2]!,
          delta: -46,
          reason: 'manual_adjustment',
          createdAt: '2026-07-20T02:00:00.000Z',
        },
        { updatedAt: '2026-07-20T02:00:00.000Z' },
      ),
    ).toThrow(/insufficient_inventory/);
    expect(original).toEqual(snapshot);
  });

  test('rejects duplicate colors, fractional quantities and zero-value transactions', () => {
    const duplicate = [inventoryItem(colorIds[0]!, 20), inventoryItem(colorIds[0]!, 30)];
    expect(() => validateInventory(duplicate)).toThrow(InventoryValidationError);
    expect(() => validateInventory([inventoryItem(colorIds[1]!, 2.5)])).toThrow(/invalid_quantity/);
    expect(() =>
      applyInventoryTransaction(
        [],
        {
          id: 'transaction-zero',
          userId: 'user-1',
          paletteColorId: colorIds[1]!,
          delta: 0,
          reason: 'manual_adjustment',
          createdAt: '2026-07-20T02:00:00.000Z',
        },
        {
          inventoryItemId: 'inventory-new',
          updatedAt: '2026-07-20T02:00:00.000Z',
        },
      ),
    ).toThrow(/invalid_transaction_delta/);
  });

  test('marks stock low only when a configured threshold is reached', () => {
    expect(isLowStock(inventoryItem(colorIds[0]!, 20))).toBe(true);
    expect(isLowStock(inventoryItem(colorIds[0]!, 21))).toBe(false);
    expect(
      isLowStock({
        ...inventoryItem(colorIds[0]!, 0),
        lowStockThreshold: undefined,
      }),
    ).toBe(false);
  });

  test('ranks realistic confirmed pattern cards by buildability and safe stock usage', () => {
    const candidates: readonly PatternCardMaterialCandidate[] = [
      {
        patternCardId: 'card-abundant',
        name: '库存充足的双色大图',
        materialVersion: 2,
        totalBeads: 500,
        confirmedAt: '2026-07-22T05:00:00.000Z',
        items: [
          { paletteColorId: colorIds[0]!, quantity: 300 },
          { paletteColorId: colorIds[1]!, quantity: 200 },
        ],
      },
      {
        patternCardId: 'card-tight',
        name: '库存刚好够但会触发预警',
        materialVersion: 1,
        totalBeads: 50,
        confirmedAt: '2026-07-22T05:00:00.000Z',
        items: [{ paletteColorId: colorIds[2]!, quantity: 50 }],
      },
      {
        patternCardId: 'card-near',
        name: '只差少量的一百颗图纸',
        materialVersion: 1,
        totalBeads: 100,
        confirmedAt: '2026-07-22T05:00:00.000Z',
        items: [{ paletteColorId: colorIds[3]!, quantity: 100 }],
      },
      {
        patternCardId: 'card-far',
        name: '库存明显不足的大图',
        materialVersion: 1,
        totalBeads: 400,
        confirmedAt: '2026-07-22T05:00:00.000Z',
        items: [{ paletteColorId: colorIds[4]!, quantity: 400 }],
      },
    ];
    const inventory = [
      inventoryItem(colorIds[0]!, 1_000),
      inventoryItem(colorIds[1]!, 800),
      inventoryItem(colorIds[2]!, 60),
      inventoryItem(colorIds[3]!, 90, 'estimated'),
      inventoryItem(colorIds[4]!, 50),
    ];

    const ranked = rankPatternCardRecommendations(candidates, inventory, mardPalette.colors, 10);

    expect(ranked.map((item) => item.patternCardId)).toEqual([
      'card-abundant',
      'card-tight',
      'card-near',
      'card-far',
    ]);
    expect(ranked[0]).toMatchObject({ canMake: true, score: 100, shortageTotal: 0 });
    expect(ranked[1]?.reasons).toContain('制作后有 1 色会达到低库存提醒线');
    expect(ranked[2]).toMatchObject({
      canMake: false,
      shortageTotal: 10,
      shortageColorCount: 1,
      hasEstimatedInventory: true,
    });
    expect(ranked[2]?.topShortages[0]).toMatchObject({ code: 'C5', shortage: 10 });
  });

  test('applies three distinct explainable recommendation modes to realistic stock levels', () => {
    const candidates: readonly PatternCardMaterialCandidate[] = [
      {
        patternCardId: 'card-stockpile',
        name: '消耗囤积色的大图',
        materialVersion: 1,
        totalBeads: 620,
        confirmedAt: '2026-07-22T05:00:00.000Z',
        items: [
          { paletteColorId: colorIds[0]!, quantity: 400 },
          { paletteColorId: colorIds[1]!, quantity: 220 },
        ],
      },
      {
        patternCardId: 'card-tight',
        name: '库存刚好够的小图',
        materialVersion: 1,
        totalBeads: 90,
        confirmedAt: '2026-07-22T05:00:00.000Z',
        items: [{ paletteColorId: colorIds[2]!, quantity: 90 }],
      },
      {
        patternCardId: 'card-short',
        name: '只需补少量的图',
        materialVersion: 1,
        totalBeads: 300,
        confirmedAt: '2026-07-22T05:00:00.000Z',
        items: [{ paletteColorId: colorIds[3]!, quantity: 300 }],
      },
    ];
    const inventory = [
      inventoryItem(colorIds[0]!, 4_000),
      inventoryItem(colorIds[1]!, 2_000),
      inventoryItem(colorIds[2]!, 95),
      inventoryItem(colorIds[3]!, 280),
    ];

    const ready = rankPatternCardRecommendations(
      candidates,
      inventory,
      mardPalette.colors,
      10,
      'ready',
    );
    const leastShortage = rankPatternCardRecommendations(
      candidates,
      inventory,
      mardPalette.colors,
      10,
      'least_shortage',
    );
    const stockpile = rankPatternCardRecommendations(
      candidates,
      inventory,
      mardPalette.colors,
      10,
      'use_stockpile',
    );

    expect(ready.map((item) => item.patternCardId)).toEqual(['card-stockpile', 'card-tight']);
    expect(ready.every((item) => item.shortageTotal === 0)).toBe(true);
    expect(leastShortage.map((item) => item.patternCardId)).toEqual([
      'card-stockpile',
      'card-tight',
      'card-short',
    ]);
    expect(leastShortage[2]).toMatchObject({ shortageTotal: 20, shortageColorCount: 1 });
    expect(leastShortage[2]?.reasons[0]).toBe('只需补 20 颗，涉及 1 个色号');
    expect(stockpile[0]).toMatchObject({
      patternCardId: 'card-stockpile',
      stockpileUsageTotal: 620,
    });
    expect(stockpile[0]?.topStockpileUses.map((item) => item.quantity)).toEqual([400, 220]);
    expect(stockpile[0]?.reasons[0]).toBe('可消耗 620 颗高于提醒线的库存豆');
  });

  test('does not recommend stock already held for another pending pattern', () => {
    const sharedColor = colorIds[0]!;
    const candidates: readonly PatternCardMaterialCandidate[] = [
      {
        patternCardId: 'card-reserved',
        name: '已加入待做的大图',
        materialVersion: 1,
        totalBeads: 700,
        confirmedAt: '2026-07-22T05:00:00.000Z',
        items: [{ paletteColorId: sharedColor, quantity: 700 }],
      },
      {
        patternCardId: 'card-competing',
        name: '争用同色库存的图',
        materialVersion: 1,
        totalBeads: 500,
        confirmedAt: '2026-07-22T05:00:00.000Z',
        items: [{ paletteColorId: sharedColor, quantity: 500 }],
      },
    ];
    const reservations: readonly PatternCardReservation[] = [
      {
        id: 'reservation-1',
        patternCardId: 'card-reserved',
        materialVersion: 1,
        idempotencyKey: 'operation-1',
        status: 'active',
        totalQuantity: 700,
        items: [{ paletteColorId: sharedColor, quantity: 700 }],
        createdAt: '2026-07-22T06:00:00.000Z',
      },
    ];

    const ranked = rankPatternCardRecommendations(
      candidates,
      [inventoryItem(sharedColor, 1_000)],
      mardPalette.colors,
      10,
      'least_shortage',
      {},
      reservations,
    );

    expect(ranked.find((item) => item.patternCardId === 'card-reserved')).toMatchObject({
      canMake: true,
      shortageTotal: 0,
    });
    expect(ranked.find((item) => item.patternCardId === 'card-competing')).toMatchObject({
      canMake: false,
      shortageTotal: 200,
    });
  });

  test('filters 24 confirmed cards against a complete 221-color inventory before ranking', () => {
    const fullInventory: readonly InventoryItem[] = mardPalette.colors.map((color, index) => ({
      id: `full-inventory-${index}`,
      userId: 'user-1',
      paletteColorId: color.id,
      quantity: index < 2 ? 4_000 : 2_000,
      quantityConfidence: index % 17 === 0 ? 'estimated' : 'exact',
      lowStockThreshold: index < 2 ? 800 : 500,
      updatedAt: '2026-07-22T08:00:00.000Z',
    }));
    const totals = [320, 900, 2_136] as const;
    const candidates: readonly PatternCardMaterialCandidate[] = Array.from(
      { length: 24 },
      (_, cardIndex) => {
        const totalBeads = totals[cardIndex % totals.length]!;
        const base = Math.floor(totalBeads / 6);
        return {
          patternCardId: `real-card-${String(cardIndex + 1).padStart(2, '0')}`,
          name: `真实资料卡 ${cardIndex + 1}`,
          materialVersion: 1,
          totalBeads,
          confirmedAt: '2026-07-22T08:00:00.000Z',
          items: Array.from({ length: 6 }, (_, itemIndex) => ({
            paletteColorId: mardPalette.colors[(cardIndex * 6 + itemIndex) % 221]!.id,
            quantity: base + (itemIndex < totalBeads % 6 ? 1 : 0),
          })),
        };
      },
    );

    const small = rankPatternCardRecommendations(
      candidates,
      fullInventory,
      mardPalette.colors,
      50,
      'ready',
      { maxTotalBeads: 500 },
    );
    const medium = rankPatternCardRecommendations(
      candidates,
      fullInventory,
      mardPalette.colors,
      50,
      'least_shortage',
      { minTotalBeads: 501, maxTotalBeads: 1_500 },
    );
    const large = rankPatternCardRecommendations(
      candidates,
      fullInventory,
      mardPalette.colors,
      50,
      'use_stockpile',
      { minTotalBeads: 1_501 },
    );

    expect(fullInventory).toHaveLength(221);
    expect(candidates).toHaveLength(24);
    expect(small).toHaveLength(8);
    expect(small.every((item) => item.totalBeads <= 500)).toBe(true);
    expect(medium).toHaveLength(8);
    expect(medium.every((item) => item.totalBeads >= 501 && item.totalBeads <= 1_500)).toBe(true);
    expect(large).toHaveLength(8);
    expect(large.every((item) => item.totalBeads >= 1_501)).toBe(true);
  });

  test('rejects a candidate whose declared total does not match confirmed materials', () => {
    expect(() =>
      rankPatternCardRecommendations(
        [
          {
            patternCardId: 'card-bad-total',
            name: '错误总数',
            materialVersion: 1,
            totalBeads: 99,
            confirmedAt: '2026-07-22T05:00:00.000Z',
            items: [{ paletteColorId: colorIds[0]!, quantity: 100 }],
          },
        ],
        [inventoryItem(colorIds[0]!, 1_000)],
        mardPalette.colors,
      ),
    ).toThrow(/invalid_candidate_total/);
  });
});
