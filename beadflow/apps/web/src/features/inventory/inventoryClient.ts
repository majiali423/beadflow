import type {
  InventoryItem,
  InventoryQuantityConfidence,
  InventoryTransaction,
  InventoryTransactionReason,
} from '@beadflow/shared-types';

type ApiError = {
  error?: { code?: string; message?: string };
};

export type InventoryMutationResult = {
  item: InventoryItem;
  transaction?: InventoryTransaction;
};

export class InventoryApiError extends Error {
  constructor(
    message: string,
    readonly code = 'INVENTORY_REQUEST_FAILED',
  ) {
    super(message);
    this.name = 'InventoryApiError';
  }
}

async function inventoryRequest<T>(
  path: string,
  accessToken: string,
  method: 'GET' | 'PUT' | 'POST',
  body: Record<string, unknown> | null,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new InventoryApiError('无法连接豆仓服务，请检查网络后重试。', 'NETWORK_ERROR');
  }

  const payload = (await response.json()) as T | ApiError;
  if (!response.ok) {
    const apiError = payload as ApiError;
    throw new InventoryApiError(
      apiError.error?.message ?? '豆仓操作失败，原有库存保持不变。',
      apiError.error?.code,
    );
  }
  return payload as T;
}

export function listInventory(
  accessToken: string,
  fetcher?: typeof fetch,
): Promise<readonly InventoryItem[]> {
  return inventoryRequest('/api/inventory', accessToken, 'GET', null, fetcher);
}

export function listInventoryTransactions(
  accessToken: string,
  fetcher?: typeof fetch,
): Promise<readonly InventoryTransaction[]> {
  return inventoryRequest('/api/inventory/transactions', accessToken, 'GET', null, fetcher);
}

export function setInventoryItem(
  input: {
    paletteColorId: string;
    quantity: number;
    quantityConfidence: InventoryQuantityConfidence;
    lowStockThreshold: number | null;
    accessToken: string;
  },
  fetcher?: typeof fetch,
): Promise<InventoryMutationResult> {
  return inventoryRequest(
    `/api/inventory/${encodeURIComponent(input.paletteColorId)}`,
    input.accessToken,
    'PUT',
    {
      quantity: input.quantity,
      quantityConfidence: input.quantityConfidence,
      lowStockThreshold: input.lowStockThreshold,
    },
    fetcher,
  );
}

export function applyInventoryTransaction(
  input: {
    paletteColorId: string;
    delta: number;
    reason: InventoryTransactionReason;
    accessToken: string;
  },
  fetcher?: typeof fetch,
): Promise<InventoryMutationResult> {
  return inventoryRequest(
    '/api/inventory/transactions',
    input.accessToken,
    'POST',
    {
      paletteColorId: input.paletteColorId,
      delta: input.delta,
      reason: input.reason,
    },
    fetcher,
  );
}

export function setInventoryItemsBatch(
  input: {
    items: readonly {
      paletteColorId: string;
      quantity: number;
      quantityConfidence: InventoryQuantityConfidence;
      lowStockThreshold: number | null;
    }[];
    accessToken: string;
  },
  fetcher?: typeof fetch,
): Promise<{ items: readonly InventoryItem[] }> {
  return inventoryRequest(
    '/api/inventory/batch',
    input.accessToken,
    'POST',
    { items: input.items },
    fetcher,
  );
}
