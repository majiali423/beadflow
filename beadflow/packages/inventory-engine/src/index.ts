import type {
  InventoryItem,
  InventoryQuantityConfidence,
  InventoryTransaction,
  MaterialBalanceResult,
  PaletteColor,
  PatternCardMaterialCandidate,
  PatternCardReservation,
  PatternCardRecommendationFilter,
  PatternCardRecommendation,
  PatternCardRecommendationMode,
  PatternCardStockpileUse,
  PurchaseListGroup,
} from '@beadflow/shared-types';

export type MaterialBalance = {
  paletteColorId: string;
  required: number;
  reserved: number;
  available: number;
  shortage: number;
  remaining: number;
  quantityConfidence: InventoryQuantityConfidence;
};

export type InventoryTransactionInput = Omit<InventoryTransaction, 'createdAt'> & {
  createdAt: string;
};

export type ApplyInventoryTransactionOptions = {
  inventoryItemId?: string;
  quantityConfidence?: InventoryQuantityConfidence;
  lowStockThreshold?: number;
  updatedAt: string;
};

export type InventoryTransactionResult = {
  items: readonly InventoryItem[];
  transaction: InventoryTransaction;
};

export type PurchaseList = {
  items: readonly MaterialBalanceResult[];
  groups: readonly PurchaseListGroup[];
  copyText: string;
  csv: string;
};

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function rankPatternCardRecommendations(
  candidates: readonly PatternCardMaterialCandidate[],
  inventoryItems: readonly InventoryItem[],
  paletteColors: readonly PaletteColor[],
  limit = 10,
  mode: PatternCardRecommendationMode = 'least_shortage',
  filter: PatternCardRecommendationFilter = {},
  reservations: readonly PatternCardReservation[] = [],
): readonly PatternCardRecommendation[] {
  validateInventory(inventoryItems);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new InventoryValidationError([`invalid_recommendation_limit:${limit}`]);
  }
  const ranked = filterPatternCardCandidates(candidates, filter).map(
    (candidate): PatternCardRecommendation => {
      const requirements = new Map<string, number>();
      for (const item of candidate.items) {
        assertNonNegativeInteger(item.quantity, `invalid_requirement:${item.paletteColorId}`);
        if (item.quantity === 0 || requirements.has(item.paletteColorId)) {
          throw new InventoryValidationError([`invalid_candidate_material:${item.paletteColorId}`]);
        }
        requirements.set(item.paletteColorId, item.quantity);
      }
      const reservedElsewhere = new Map<string, number>();
      for (const reservation of reservations) {
        if (
          reservation.status !== 'active' ||
          reservation.patternCardId === candidate.patternCardId
        )
          continue;
        for (const item of reservation.items) {
          reservedElsewhere.set(
            item.paletteColorId,
            (reservedElsewhere.get(item.paletteColorId) ?? 0) + item.quantity,
          );
        }
      }
      const effectiveInventory = inventoryItems.map((item) => ({
        ...item,
        quantity: Math.max(item.quantity - (reservedElsewhere.get(item.paletteColorId) ?? 0), 0),
      }));
      const effectiveInventoryByColor = new Map(
        effectiveInventory.map((item) => [item.paletteColorId, item]),
      );
      const balances = enrichMaterialBalances(
        calculateMaterialBalances(requirements, effectiveInventory),
        paletteColors,
      );
      const totalBeads = sumNumbers(balances.map((item) => item.required));
      if (totalBeads <= 0 || totalBeads !== candidate.totalBeads) {
        throw new InventoryValidationError([`invalid_candidate_total:${candidate.patternCardId}`]);
      }
      const shortageTotal = sumNumbers(balances.map((item) => item.shortage));
      const shortageColorCount = balances.filter((item) => item.shortage > 0).length;
      const covered = totalBeads - shortageTotal;
      let safeCovered = 0;
      let lowStockAfterBuildCount = 0;
      let stockpileUsageTotal = 0;
      const stockpileUses: PatternCardStockpileUse[] = [];
      for (const balance of balances) {
        const inventory = effectiveInventoryByColor.get(balance.paletteColorId);
        const threshold = inventory?.lowStockThreshold ?? 0;
        const safeAvailable = Math.max((inventory?.quantity ?? 0) - threshold, 0);
        const stockpileUsage = Math.min(balance.required, safeAvailable);
        safeCovered += stockpileUsage;
        stockpileUsageTotal += stockpileUsage;
        if (stockpileUsage > 0) {
          stockpileUses.push({
            paletteColorId: balance.paletteColorId,
            code: balance.code,
            hex: balance.hex,
            quantity: stockpileUsage,
          });
        }
        if (
          inventory?.lowStockThreshold !== undefined &&
          balance.available >= balance.required &&
          balance.remaining <= inventory.lowStockThreshold
        ) {
          lowStockAfterBuildCount += 1;
        }
      }
      const coverageRatio = clampRatio(covered / totalBeads);
      const safeCoverageRatio = clampRatio(safeCovered / totalBeads);
      const canMake = shortageTotal === 0;
      const score = Math.round(coverageRatio * 65 + safeCoverageRatio * 20 + (canMake ? 15 : 0));
      const hasEstimatedInventory = balances.some(
        (item) => item.quantityConfidence === 'estimated',
      );
      const topShortages = balances
        .filter((item) => item.shortage > 0)
        .sort(
          (left, right) =>
            right.shortage - left.shortage ||
            left.code.localeCompare(right.code, undefined, { numeric: true }),
        )
        .slice(0, 3);
      const topStockpileUses = stockpileUses
        .sort(
          (left, right) =>
            right.quantity - left.quantity ||
            left.code.localeCompare(right.code, undefined, { numeric: true }),
        )
        .slice(0, 3);
      const reasons: string[] = [];
      if (mode === 'ready') reasons.push('所有色号库存都够，可以立即制作');
      if (mode === 'least_shortage') {
        reasons.push(
          canMake
            ? '无需补豆，可以直接制作'
            : `只需补 ${shortageTotal} 颗，涉及 ${shortageColorCount} 个色号`,
        );
      }
      if (mode === 'use_stockpile') {
        reasons.push(
          stockpileUsageTotal > 0
            ? `可消耗 ${stockpileUsageTotal} 颗高于提醒线的库存豆`
            : '没有可优先消耗的高库存豆',
        );
      }
      if (safeCoverageRatio >= 0.9) reasons.push('主要使用库存充足的色号');
      if (lowStockAfterBuildCount > 0) {
        reasons.push(`制作后有 ${lowStockAfterBuildCount} 色会达到低库存提醒线`);
      }
      if (hasEstimatedInventory) reasons.push('包含估算库存，制作前建议复核数量');

      return {
        patternCardId: candidate.patternCardId,
        name: candidate.name,
        materialVersion: candidate.materialVersion,
        totalBeads,
        colorCount: balances.length,
        confirmedAt: candidate.confirmedAt,
        canMake,
        score,
        coverageRatio,
        safeCoverageRatio,
        shortageTotal,
        shortageColorCount,
        lowStockAfterBuildCount,
        stockpileUsageTotal,
        topStockpileUses,
        hasEstimatedInventory,
        topShortages,
        reasons,
      };
    },
  );

  const visible = mode === 'ready' ? ranked.filter((item) => item.canMake) : ranked;
  visible.sort((left, right) => {
    if (mode === 'ready')
      return (
        right.safeCoverageRatio - left.safeCoverageRatio ||
        left.lowStockAfterBuildCount - right.lowStockAfterBuildCount ||
        right.stockpileUsageTotal - left.stockpileUsageTotal ||
        left.name.localeCompare(right.name, 'zh-CN')
      );
    if (mode === 'use_stockpile')
      return (
        Number(right.canMake) - Number(left.canMake) ||
        right.stockpileUsageTotal - left.stockpileUsageTotal ||
        left.lowStockAfterBuildCount - right.lowStockAfterBuildCount ||
        left.shortageTotal - right.shortageTotal ||
        left.name.localeCompare(right.name, 'zh-CN')
      );
    return (
      left.shortageTotal - right.shortageTotal ||
      left.shortageColorCount - right.shortageColorCount ||
      left.lowStockAfterBuildCount - right.lowStockAfterBuildCount ||
      right.safeCoverageRatio - left.safeCoverageRatio ||
      left.name.localeCompare(right.name, 'zh-CN')
    );
  });
  return visible.slice(0, limit);
}

export function filterPatternCardCandidates(
  candidates: readonly PatternCardMaterialCandidate[],
  filter: PatternCardRecommendationFilter = {},
): readonly PatternCardMaterialCandidate[] {
  const { minTotalBeads, maxTotalBeads } = filter;
  if (
    (minTotalBeads !== undefined && (!Number.isInteger(minTotalBeads) || minTotalBeads < 1)) ||
    (maxTotalBeads !== undefined && (!Number.isInteger(maxTotalBeads) || maxTotalBeads < 1)) ||
    (minTotalBeads !== undefined && maxTotalBeads !== undefined && minTotalBeads > maxTotalBeads)
  ) {
    throw new InventoryValidationError(['invalid_recommendation_total_beads_range']);
  }
  return candidates.filter(
    (candidate) =>
      (minTotalBeads === undefined || candidate.totalBeads >= minTotalBeads) &&
      (maxTotalBeads === undefined || candidate.totalBeads <= maxTotalBeads),
  );
}

function sumNumbers(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export class InventoryValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`库存数据校验失败：${issues.join('；')}`);
    this.name = 'InventoryValidationError';
  }
}

function assertNonNegativeInteger(value: number, issue: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InventoryValidationError([issue]);
  }
}

export function validateInventory(items: readonly InventoryItem[]): void {
  const issues: string[] = [];
  const colorIds = new Set<string>();

  for (const item of items) {
    if (colorIds.has(item.paletteColorId)) {
      issues.push(`duplicate_palette_color:${item.paletteColorId}`);
    }
    colorIds.add(item.paletteColorId);
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      issues.push(`invalid_quantity:${item.paletteColorId}`);
    }
    if (
      item.lowStockThreshold !== undefined &&
      (!Number.isInteger(item.lowStockThreshold) || item.lowStockThreshold < 0)
    ) {
      issues.push(`invalid_low_stock_threshold:${item.paletteColorId}`);
    }
  }

  if (issues.length > 0) throw new InventoryValidationError(issues);
}

export function calculateMaterialBalances(
  requirements: ReadonlyMap<string, number>,
  inventoryItems: readonly InventoryItem[],
): readonly MaterialBalance[] {
  validateInventory(inventoryItems);
  const inventoryByColor = new Map(inventoryItems.map((item) => [item.paletteColorId, item]));
  const colorIds = new Set([...requirements.keys(), ...inventoryByColor.keys()]);
  const balances: MaterialBalance[] = [];

  for (const paletteColorId of colorIds) {
    const required = requirements.get(paletteColorId) ?? 0;
    assertNonNegativeInteger(required, `invalid_requirement:${paletteColorId}`);
    const reserved = 0;
    const available = inventoryByColor.get(paletteColorId)?.quantity ?? 0;
    const netRequired = required - reserved;
    balances.push({
      paletteColorId,
      required,
      reserved,
      available,
      shortage: Math.max(netRequired - available, 0),
      remaining: available - netRequired,
      quantityConfidence: inventoryByColor.get(paletteColorId)?.quantityConfidence ?? 'exact',
    });
  }

  return balances.sort((left, right) => left.paletteColorId.localeCompare(right.paletteColorId));
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function enrichMaterialBalances(
  balances: readonly MaterialBalance[],
  paletteColors: readonly PaletteColor[],
): readonly MaterialBalanceResult[] {
  const paletteById = new Map(paletteColors.map((color) => [color.id, color]));
  return balances
    .filter((balance) => balance.required > 0)
    .map((balance) => {
      const color = paletteById.get(balance.paletteColorId);
      if (!color) {
        throw new InventoryValidationError([`unknown_palette_color:${balance.paletteColorId}`]);
      }
      return {
        ...balance,
        code: color.code,
        ...(color.name ? { name: color.name } : {}),
        hex: color.hex,
        family: color.code.charAt(0),
        netRequired: balance.required - balance.reserved,
      };
    })
    .sort((left, right) => left.code.localeCompare(right.code, undefined, { numeric: true }));
}

export function createPurchaseList(balances: readonly MaterialBalanceResult[]): PurchaseList {
  const items = [...balances.filter((balance) => balance.shortage > 0)].sort(
    (left, right) =>
      right.shortage - left.shortage ||
      left.code.localeCompare(right.code, undefined, { numeric: true }),
  );
  const families = new Map<string, MaterialBalanceResult[]>();
  for (const item of items) {
    const family = families.get(item.family) ?? [];
    family.push(item);
    families.set(item.family, family);
  }
  const groups = [...families.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, familyItems]) => ({ family, items: familyItems }));
  const copyText =
    items.length === 0
      ? '当前所选项目无需采购。'
      : [
          'BeadFlow MARD 采购清单',
          ...items.map((item) => {
            const confidenceNote =
              item.quantityConfidence === 'estimated' ? '（当前库存为估算）' : '';
            return `${item.code} × ${item.shortage} 颗${confidenceNote}`;
          }),
        ].join('\n');
  const csvRows = [
    ['MARD色号', '色名', '色系', '缺少数量', '当前库存', '库存可信度'],
    ...items.map((item) => [
      item.code,
      item.name ?? '',
      item.family,
      item.shortage,
      item.available,
      item.quantityConfidence === 'estimated' ? '估算' : '准确',
    ]),
  ];
  return {
    items,
    groups,
    copyText,
    csv: `\uFEFF${csvRows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`,
  };
}

export function applyInventoryTransaction(
  items: readonly InventoryItem[],
  input: InventoryTransactionInput,
  options: ApplyInventoryTransactionOptions,
): InventoryTransactionResult {
  validateInventory(items);
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new InventoryValidationError([`invalid_transaction_delta:${input.delta}`]);
  }

  const itemIndex = items.findIndex((item) => item.paletteColorId === input.paletteColorId);
  const current = itemIndex >= 0 ? items[itemIndex] : undefined;
  if (current && current.userId !== input.userId) {
    throw new InventoryValidationError([`inventory_owner_mismatch:${input.paletteColorId}`]);
  }
  if (!current && input.delta < 0) {
    throw new InventoryValidationError([`insufficient_inventory:${input.paletteColorId}`]);
  }

  const nextQuantity = (current?.quantity ?? 0) + input.delta;
  if (nextQuantity < 0) {
    throw new InventoryValidationError([`insufficient_inventory:${input.paletteColorId}`]);
  }

  const nextItem: InventoryItem = {
    id: current?.id ?? options.inventoryItemId ?? '',
    userId: input.userId,
    paletteColorId: input.paletteColorId,
    quantity: nextQuantity,
    quantityConfidence: options.quantityConfidence ?? current?.quantityConfidence ?? 'exact',
    ...(options.lowStockThreshold !== undefined
      ? { lowStockThreshold: options.lowStockThreshold }
      : current?.lowStockThreshold !== undefined
        ? { lowStockThreshold: current.lowStockThreshold }
        : {}),
    updatedAt: options.updatedAt,
  };
  if (!nextItem.id) {
    throw new InventoryValidationError([`missing_inventory_item_id:${input.paletteColorId}`]);
  }

  const nextItems =
    itemIndex >= 0
      ? items.map((item, index) => (index === itemIndex ? nextItem : item))
      : [...items, nextItem];

  return {
    items: nextItems,
    transaction: { ...input },
  };
}

export function isLowStock(item: InventoryItem): boolean {
  return item.lowStockThreshold !== undefined && item.quantity <= item.lowStockThreshold;
}
