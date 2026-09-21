import type {
  InventoryItem,
  InventoryQuantityConfidence,
  InventoryTransaction,
  InventoryTransactionReason,
} from '@beadflow/shared-types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

class InventoryPersistenceError extends Error {}

const confidenceSchema = z.enum(['exact', 'estimated']);
const reasonSchema = z.enum(['purchase', 'manual_adjustment']);
const transactionBodySchema = z
  .object({
    paletteColorId: z.string().min(1),
    delta: z
      .number()
      .int()
      .refine((value) => value !== 0),
    reason: reasonSchema,
    quantityConfidence: confidenceSchema.optional(),
    lowStockThreshold: z.number().int().min(0).optional(),
  })
  .strict();
const setInventoryBodySchema = z
  .object({
    quantity: z.number().int().min(0),
    quantityConfidence: confidenceSchema,
    lowStockThreshold: z.number().int().min(0).nullable().optional(),
  })
  .strict();
const batchInventoryBodySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            paletteColorId: z.string().min(1),
            quantity: z.number().int().min(0),
            quantityConfidence: confidenceSchema,
            lowStockThreshold: z.number().int().min(0).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(221),
  })
  .strict();

export type ApplyInventoryInput = z.infer<typeof transactionBodySchema> & {
  accessToken: string;
};

export type SetInventoryInput = z.infer<typeof setInventoryBodySchema> & {
  paletteColorId: string;
  accessToken: string;
};

export type SetInventoryBatchInput = z.infer<typeof batchInventoryBodySchema> & {
  accessToken: string;
};

export type InventoryMutationResult = {
  item: InventoryItem;
  transaction?: InventoryTransaction;
};

export interface InventoryRepository {
  list(accessToken: string): Promise<readonly InventoryItem[]>;
  listTransactions(accessToken: string): Promise<readonly InventoryTransaction[]>;
  applyTransaction(input: ApplyInventoryInput): Promise<InventoryMutationResult>;
  setItem(input: SetInventoryInput): Promise<InventoryMutationResult>;
  setItems(input: SetInventoryBatchInput): Promise<readonly InventoryItem[]>;
}

export type InventoryRoutesOptions = {
  validPaletteColorIds: ReadonlySet<string>;
  repository: InventoryRepository | null;
};

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function authOrError(
  authorization: string | undefined,
  requestId: string,
): { accessToken: string } | { error: { code: string; message: string; requestId: string } } {
  const accessToken = bearerToken(authorization);
  return accessToken
    ? { accessToken }
    : {
        error: {
          code: 'AUTH_REQUIRED',
          message: '管理豆仓前必须登录。',
          requestId,
        },
      };
}

export function registerInventoryRoutes(
  app: FastifyInstance,
  options: InventoryRoutesOptions,
): void {
  app.get('/api/inventory', async (request, reply) => {
    const auth = authOrError(request.headers.authorization, request.id);
    if ('error' in auth) return reply.status(401).send(auth);
    if (!options.repository) {
      return reply.status(503).send({
        error: {
          code: 'PERSISTENCE_NOT_CONFIGURED',
          message: 'Supabase 尚未配置。',
          requestId: request.id,
        },
      });
    }
    try {
      return reply.send(await options.repository.list(auth.accessToken));
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'INVENTORY_LIST_FAILED',
          message: '无法读取云端豆仓。',
          requestId: request.id,
        },
      });
    }
  });

  app.get('/api/inventory/transactions', async (request, reply) => {
    const auth = authOrError(request.headers.authorization, request.id);
    if ('error' in auth) return reply.status(401).send(auth);
    if (!options.repository) {
      return reply.status(503).send({
        error: {
          code: 'PERSISTENCE_NOT_CONFIGURED',
          message: 'Supabase 尚未配置。',
          requestId: request.id,
        },
      });
    }
    try {
      return reply.send(await options.repository.listTransactions(auth.accessToken));
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'INVENTORY_HISTORY_FAILED',
          message: '无法读取库存流水。',
          requestId: request.id,
        },
      });
    }
  });

  app.post('/api/inventory/transactions', async (request, reply) => {
    const auth = authOrError(request.headers.authorization, request.id);
    if ('error' in auth) return reply.status(401).send(auth);
    if (!options.repository) {
      return reply.status(503).send({
        error: {
          code: 'PERSISTENCE_NOT_CONFIGURED',
          message: 'Supabase 尚未配置。',
          requestId: request.id,
        },
      });
    }
    const body = transactionBodySchema.safeParse(request.body);
    if (!body.success || !options.validPaletteColorIds.has(body.data.paletteColorId)) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_INVENTORY_TRANSACTION',
          message: '库存变化必须使用有效 MARD 色号和非零整数数量。',
          requestId: request.id,
        },
      });
    }
    try {
      return reply.status(201).send(
        await options.repository.applyTransaction({
          ...body.data,
          accessToken: auth.accessToken,
        }),
      );
    } catch (error) {
      request.log.error(error);
      return reply.status(409).send({
        error: {
          code: 'INVENTORY_TRANSACTION_FAILED',
          message:
            error instanceof Error && error.message.includes('INSUFFICIENT_INVENTORY')
              ? '库存不足，本次变化没有写入。'
              : '库存变化失败，本次数量和流水均未写入。',
          requestId: request.id,
        },
      });
    }
  });

  app.post('/api/inventory/batch', async (request, reply) => {
    const auth = authOrError(request.headers.authorization, request.id);
    if ('error' in auth) return reply.status(401).send(auth);
    if (!options.repository) {
      return reply.status(503).send({
        error: {
          code: 'PERSISTENCE_NOT_CONFIGURED',
          message: 'Supabase 尚未配置。',
          requestId: request.id,
        },
      });
    }
    const body = batchInventoryBodySchema.safeParse(request.body);
    if (
      !body.success ||
      new Set(body.data.items.map((item) => item.paletteColorId)).size !== body.data.items.length ||
      body.data.items.some((item) => !options.validPaletteColorIds.has(item.paletteColorId))
    ) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_INVENTORY_BATCH',
          message: '批量库存包含重复、未知色号或无效数量。',
          requestId: request.id,
        },
      });
    }
    try {
      return reply.status(201).send({
        items: await options.repository.setItems({
          ...body.data,
          accessToken: auth.accessToken,
        }),
      });
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'INVENTORY_BATCH_FAILED',
          message: '批量库存没有写入，原有库存保持不变。',
          requestId: request.id,
        },
      });
    }
  });

  app.put<{ Params: { paletteColorId: string } }>(
    '/api/inventory/:paletteColorId',
    async (request, reply) => {
      const auth = authOrError(request.headers.authorization, request.id);
      if ('error' in auth) return reply.status(401).send(auth);
      if (!options.repository) {
        return reply.status(503).send({
          error: {
            code: 'PERSISTENCE_NOT_CONFIGURED',
            message: 'Supabase 尚未配置。',
            requestId: request.id,
          },
        });
      }
      const body = setInventoryBodySchema.safeParse(request.body);
      if (!body.success || !options.validPaletteColorIds.has(request.params.paletteColorId)) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_INVENTORY_ITEM',
            message: '库存数量、可信度或低库存阈值不合法。',
            requestId: request.id,
          },
        });
      }
      try {
        return reply.send(
          await options.repository.setItem({
            ...body.data,
            paletteColorId: request.params.paletteColorId,
            accessToken: auth.accessToken,
          }),
        );
      } catch (error) {
        request.log.error(error);
        return reply.status(502).send({
          error: {
            code: 'INVENTORY_UPDATE_FAILED',
            message: '豆仓更新失败，原数量保持不变。',
            requestId: request.id,
          },
        });
      }
    },
  );
}

type InventoryItemRow = {
  id: string;
  user_id: string;
  palette_color_id: string;
  quantity: number;
  quantity_confidence: InventoryQuantityConfidence;
  low_stock_threshold: number | null;
  updated_at: string;
};

type InventoryTransactionRow = {
  id: string;
  user_id: string;
  palette_color_id: string;
  delta: number;
  reason: InventoryTransactionReason;
  created_at: string;
};

function mapItem(row: InventoryItemRow): InventoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    paletteColorId: row.palette_color_id,
    quantity: row.quantity,
    quantityConfidence: row.quantity_confidence,
    ...(row.low_stock_threshold === null ? {} : { lowStockThreshold: row.low_stock_threshold }),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapTransaction(row: InventoryTransactionRow): InventoryTransaction {
  return {
    id: row.id,
    userId: row.user_id,
    paletteColorId: row.palette_color_id,
    delta: row.delta,
    reason: row.reason,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class SupabaseInventoryRepository implements InventoryRepository {
  constructor(
    private readonly url: string,
    private readonly publishableKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private headers(accessToken: string): Record<string, string> {
    return {
      apikey: this.publishableKey,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    };
  }

  async list(accessToken: string): Promise<readonly InventoryItem[]> {
    const query =
      'select=id,user_id,palette_color_id,quantity,quantity_confidence,low_stock_threshold,updated_at&order=updated_at.desc';
    const response = await this.fetcher(`${this.url}/rest/v1/inventory_items?${query}`, {
      headers: this.headers(accessToken),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) throw this.persistenceError(payload, response.status);
    return (payload as InventoryItemRow[]).map(mapItem);
  }

  async listTransactions(accessToken: string): Promise<readonly InventoryTransaction[]> {
    const query =
      'select=id,user_id,palette_color_id,delta,reason,created_at&order=created_at.desc&limit=200';
    const response = await this.fetcher(`${this.url}/rest/v1/inventory_transactions?${query}`, {
      headers: this.headers(accessToken),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) throw this.persistenceError(payload, response.status);
    return (payload as InventoryTransactionRow[]).map(mapTransaction);
  }

  async applyTransaction(input: ApplyInventoryInput): Promise<InventoryMutationResult> {
    return this.rpc('apply_inventory_transaction', input.accessToken, {
      p_palette_color_id: input.paletteColorId,
      p_delta: input.delta,
      p_reason: input.reason,
      p_project_id: null,
      p_quantity_confidence: input.quantityConfidence ?? null,
      p_low_stock_threshold: input.lowStockThreshold ?? null,
    });
  }

  async setItem(input: SetInventoryInput): Promise<InventoryMutationResult> {
    return this.rpc('set_inventory_item', input.accessToken, {
      p_palette_color_id: input.paletteColorId,
      p_quantity: input.quantity,
      p_quantity_confidence: input.quantityConfidence,
      p_low_stock_threshold: input.lowStockThreshold ?? null,
    });
  }

  async setItems(input: SetInventoryBatchInput): Promise<readonly InventoryItem[]> {
    const response = await this.fetcher(`${this.url}/rest/v1/rpc/set_inventory_items_batch`, {
      method: 'POST',
      headers: this.headers(input.accessToken),
      body: JSON.stringify({ p_items: input.items }),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) throw this.persistenceError(payload, response.status);
    const result = payload as {
      items: Array<InventoryItem & { lowStockThreshold?: number | null }>;
    };
    return result.items.map((item) => ({
      ...item,
      ...(item.lowStockThreshold === null ? { lowStockThreshold: undefined } : {}),
      updatedAt: new Date(item.updatedAt).toISOString(),
    }));
  }

  private async rpc(
    name: string,
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<InventoryMutationResult> {
    const response = await this.fetcher(`${this.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: this.headers(accessToken),
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) throw this.persistenceError(payload, response.status);
    const result = payload as {
      item: InventoryItem & { lowStockThreshold?: number | null };
      transaction?: InventoryTransaction;
    };
    return {
      item: {
        ...result.item,
        ...(result.item.lowStockThreshold === null ? { lowStockThreshold: undefined } : {}),
        updatedAt: new Date(result.item.updatedAt).toISOString(),
      },
      ...(result.transaction
        ? {
            transaction: {
              ...result.transaction,
              createdAt: new Date(result.transaction.createdAt).toISOString(),
            },
          }
        : {}),
    };
  }

  private persistenceError(payload: unknown, status: number): InventoryPersistenceError {
    const message = (payload as { message?: string }).message;
    return new InventoryPersistenceError(message ?? `Supabase 请求失败（${status}）。`);
  }
}
