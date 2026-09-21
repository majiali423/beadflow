import type { InventoryItem, InventoryTransaction } from '@beadflow/shared-types';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { buildApp } from './app.js';
import type {
  ApplyInventoryInput,
  InventoryMutationResult,
  InventoryRepository,
  SetInventoryBatchInput,
  SetInventoryInput,
} from './inventory.js';

const paletteColorId = 'mard-221-2026-07-user-verified:B17';
const validPaletteColorIds = new Set([
  paletteColorId,
  'mard-221-2026-07-user-verified:A10',
  'mard-221-2026-07-user-verified:C5',
]);
const inventoryItem: InventoryItem = {
  id: '71715f5b-5223-4a20-bb7d-cd526439804e',
  userId: '648841a8-427f-4557-8862-2679ce9b43d6',
  paletteColorId,
  quantity: 320,
  quantityConfidence: 'estimated',
  lowStockThreshold: 50,
  updatedAt: '2026-07-20T03:00:00.000Z',
};
const transaction: InventoryTransaction = {
  id: '082019ca-d762-4f48-a01b-cdf183933bc7',
  userId: inventoryItem.userId,
  paletteColorId,
  delta: 120,
  reason: 'purchase',
  createdAt: '2026-07-20T03:00:00.000Z',
};

class RecordingInventoryRepository implements InventoryRepository {
  readonly list = vi.fn(async () => [inventoryItem]);
  readonly listTransactions = vi.fn(async () => [transaction]);
  readonly applyTransaction = vi.fn(
    async (input: ApplyInventoryInput): Promise<InventoryMutationResult> => ({
      item: { ...inventoryItem, quantity: inventoryItem.quantity + input.delta },
      transaction: {
        ...transaction,
        delta: input.delta,
        reason: input.reason,
      },
    }),
  );
  readonly setItem = vi.fn(async (input: SetInventoryInput): Promise<InventoryMutationResult> => ({
    item: {
      ...inventoryItem,
      paletteColorId: input.paletteColorId,
      quantity: input.quantity,
      quantityConfidence: input.quantityConfidence,
      ...(input.lowStockThreshold === null || input.lowStockThreshold === undefined
        ? {}
        : { lowStockThreshold: input.lowStockThreshold }),
    },
  }));
  readonly setItems = vi.fn(async (input: SetInventoryBatchInput) =>
    input.items.map((entry, index) => ({
      ...inventoryItem,
      id: `batch-item-${index}`,
      paletteColorId: entry.paletteColorId,
      quantity: entry.quantity,
      quantityConfidence: entry.quantityConfidence,
      ...(entry.lowStockThreshold === null ? {} : { lowStockThreshold: entry.lowStockThreshold }),
    })),
  );
}

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function inventoryApp(repository: InventoryRepository) {
  const app = buildApp({
    inventory: { repository, validPaletteColorIds },
  });
  apps.push(app);
  return app;
}

describe('inventory API', () => {
  test('lists only repository-visible inventory for an authenticated user', async () => {
    const repository = new RecordingInventoryRepository();
    const response = await inventoryApp(repository).inject({
      method: 'GET',
      url: '/api/inventory',
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([inventoryItem]);
    expect(repository.list).toHaveBeenCalledWith('signed-in-user-token');
  });

  test('records a manual stock correction through the atomic repository boundary', async () => {
    const repository = new RecordingInventoryRepository();
    const response = await inventoryApp(repository).inject({
      method: 'POST',
      url: '/api/inventory/transactions',
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: {
        paletteColorId,
        delta: -56,
        reason: 'manual_adjustment',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(repository.applyTransaction).toHaveBeenCalledWith({
      paletteColorId,
      delta: -56,
      reason: 'manual_adjustment',
      accessToken: 'signed-in-user-token',
    });
  });

  test('sets an estimated count and low-stock threshold without inventing a color', async () => {
    const repository = new RecordingInventoryRepository();
    const response = await inventoryApp(repository).inject({
      method: 'PUT',
      url: `/api/inventory/${encodeURIComponent(paletteColorId)}`,
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: {
        quantity: 320,
        quantityConfidence: 'estimated',
        lowStockThreshold: 50,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(repository.setItem).toHaveBeenCalledWith({
      paletteColorId,
      quantity: 320,
      quantityConfidence: 'estimated',
      lowStockThreshold: 50,
      accessToken: 'signed-in-user-token',
    });
  });

  test('rejects unknown MARD colors and zero-value transactions before persistence', async () => {
    const repository = new RecordingInventoryRepository();
    const response = await inventoryApp(repository).inject({
      method: 'POST',
      url: '/api/inventory/transactions',
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: {
        paletteColorId: 'invented-color',
        delta: 0,
        reason: 'purchase',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_INVENTORY_TRANSACTION');
    expect(repository.applyTransaction).not.toHaveBeenCalled();
  });

  test('exposes traceable transaction history and requires authentication', async () => {
    const repository = new RecordingInventoryRepository();
    const app = inventoryApp(repository);
    const history = await app.inject({
      method: 'GET',
      url: '/api/inventory/transactions',
      headers: { authorization: 'Bearer signed-in-user-token' },
    });
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/inventory',
    });

    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual([transaction]);
    expect(anonymous.statusCode).toBe(401);
  });

  test('validates a multi-color batch before one atomic repository call', async () => {
    const repository = new RecordingInventoryRepository();
    const batch = [...validPaletteColorIds].map((colorId, index) => ({
      paletteColorId: colorId,
      quantity: 1300 + index * 240,
      quantityConfidence: 'estimated' as const,
      lowStockThreshold: 500,
    }));
    const response = await inventoryApp(repository).inject({
      method: 'POST',
      url: '/api/inventory/batch',
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { items: batch },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().items).toHaveLength(3);
    expect(repository.setItems).toHaveBeenCalledWith({
      items: batch,
      accessToken: 'signed-in-user-token',
    });
  });
});
