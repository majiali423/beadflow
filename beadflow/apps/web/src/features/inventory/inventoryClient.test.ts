import type { InventoryItem, InventoryTransaction } from '@beadflow/shared-types';
import { describe, expect, test, vi } from 'vitest';

import {
  applyInventoryTransaction,
  listInventory,
  listInventoryTransactions,
  setInventoryItem,
  setInventoryItemsBatch,
} from './inventoryClient';

const paletteColorId = 'mard-221-2026-07-user-verified:B17';
const item: InventoryItem = {
  id: 'inventory-b17',
  userId: 'user-1',
  paletteColorId,
  quantity: 320,
  quantityConfidence: 'estimated',
  lowStockThreshold: 50,
  updatedAt: '2026-07-20T03:00:00.000Z',
};
const transaction: InventoryTransaction = {
  id: 'transaction-b17',
  userId: 'user-1',
  paletteColorId,
  delta: -56,
  reason: 'pattern_consumption',
  createdAt: '2026-07-20T04:00:00.000Z',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('inventory API client', () => {
  test('loads inventory and traceable history with the access token', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([item]))
      .mockResolvedValueOnce(jsonResponse([transaction]));

    await expect(listInventory('token-1', fetcher)).resolves.toEqual([item]);
    await expect(listInventoryTransactions('token-1', fetcher)).resolves.toEqual([transaction]);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/inventory',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer token-1' }),
      }),
    );
  });

  test('sets an estimated absolute quantity without dropping the threshold', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ item, transaction }));

    await setInventoryItem(
      {
        paletteColorId,
        quantity: 320,
        quantityConfidence: 'estimated',
        lowStockThreshold: 50,
        accessToken: 'token-1',
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      `/api/inventory/${encodeURIComponent(paletteColorId)}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          quantity: 320,
          quantityConfidence: 'estimated',
          lowStockThreshold: 50,
        }),
      }),
    );
  });

  test('posts a negative manual correction as an explicit transaction', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ item: { ...item, quantity: 264 }, transaction }, 201));

    await applyInventoryTransaction(
      {
        paletteColorId,
        delta: -56,
        reason: 'manual_adjustment',
        accessToken: 'token-1',
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      '/api/inventory/transactions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          paletteColorId,
          delta: -56,
          reason: 'manual_adjustment',
        }),
      }),
    );
  });

  test('keeps the server error code and message for rollback feedback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'INVENTORY_TRANSACTION_FAILED',
            message: '库存不足，本次变化没有写入。',
          },
        },
        409,
      ),
    );

    await expect(
      applyInventoryTransaction(
        {
          paletteColorId,
          delta: -500,
          reason: 'manual_adjustment',
          accessToken: 'token-1',
        },
        fetcher,
      ),
    ).rejects.toMatchObject({
      code: 'INVENTORY_TRANSACTION_FAILED',
      message: '库存不足，本次变化没有写入。',
    });
  });

  test('sends a validated demo plan through one batch request', async () => {
    const batch = [
      {
        paletteColorId,
        quantity: 3540,
        quantityConfidence: 'estimated' as const,
        lowStockThreshold: 800,
      },
      {
        paletteColorId: 'mard-221-2026-07-user-verified:A10',
        quantity: 1480,
        quantityConfidence: 'estimated' as const,
        lowStockThreshold: 500,
      },
    ];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ items: [item] }, 201));

    await setInventoryItemsBatch({ items: batch, accessToken: 'token-1' }, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      '/api/inventory/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ items: batch }),
      }),
    );
  });
});
