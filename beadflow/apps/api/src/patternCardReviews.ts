import type {
  CombinedPatternCardPurchaseListResult,
  PaletteColor,
  PatternCardConsumption,
  PatternCardConsumptionHistoryItem,
  PatternCardConsumptionHistoryResult,
  PatternCardInventoryCheckResult,
  PatternCardMaterialCandidate,
  PatternCardPurchaseListResult,
  PatternCardRecommendationResult,
  PatternCardReservation,
  PatternMaterialDraftItem,
  PatternMaterialReviewDraft,
  PatternMaterialVersion,
} from '@beadflow/shared-types';
import {
  calculateMaterialBalances,
  createPurchaseList,
  enrichMaterialBalances,
  filterPatternCardCandidates,
  rankPatternCardRecommendations,
} from '@beadflow/inventory-engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { InventoryRepository } from './inventory.js';

const evidenceRegionSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

const draftItemSchema = z
  .object({
    id: z.string().uuid(),
    paletteColorId: z.string().trim().min(1).max(100),
    quantity: z.number().int().positive().max(100_000),
    rawText: z.string().max(500).optional(),
    confidence: z.number().min(0).max(1).optional(),
    evidenceRegion: evidenceRegionSchema.optional(),
    recognitionSource: z.enum(['direct', 'compact', 'spatial', 'manual']),
    reviewState: z.enum(['pending', 'confirmed', 'edited', 'added']),
  })
  .strict();

const saveDraftSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    declaredTotal: z.number().int().positive().max(1_000_000).optional(),
    conflicts: z.array(z.string().trim().min(1).max(20)).max(221),
    items: z.array(draftItemSchema).max(221),
  })
  .strict();

const confirmDraftSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    acceptDeclaredTotalMismatch: z.boolean().default(false),
  })
  .strict();

const recommendationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(10),
    mode: z.enum(['ready', 'least_shortage', 'use_stockpile']).default('ready'),
    minTotalBeads: z.coerce.number().int().positive().max(1_000_000).optional(),
    maxTotalBeads: z.coerce.number().int().positive().max(1_000_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minTotalBeads === undefined ||
      value.maxTotalBeads === undefined ||
      value.minTotalBeads <= value.maxTotalBeads,
  );

const consumeSchema = z.object({ idempotencyKey: z.string().uuid() }).strict();
const reserveSchema = consumeSchema;
const consumptionHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const combinedPurchaseListSchema = z
  .object({
    patternCardIds: z.array(z.string().uuid()).min(1).max(20),
  })
  .strict();

export type SavePatternMaterialDraftInput = {
  patternCardId: string;
  expectedRevision: number;
  declaredTotal?: number;
  conflicts: readonly string[];
  items: readonly PatternMaterialDraftItem[];
  accessToken: string;
};

export type ConfirmPatternMaterialDraftInput = {
  patternCardId: string;
  expectedRevision: number;
  acceptDeclaredTotalMismatch: boolean;
  accessToken: string;
};

export interface PatternCardReviewRepository {
  getDraft(patternCardId: string, accessToken: string): Promise<PatternMaterialReviewDraft>;
  saveDraft(input: SavePatternMaterialDraftInput): Promise<PatternMaterialReviewDraft>;
  confirmDraft(input: ConfirmPatternMaterialDraftInput): Promise<PatternMaterialVersion>;
  getLatestVersion(patternCardId: string, accessToken: string): Promise<PatternMaterialVersion>;
  listConfirmedMaterials(accessToken: string): Promise<readonly PatternCardMaterialCandidate[]>;
  listActiveReservations(accessToken: string): Promise<readonly PatternCardReservation[]>;
  getActiveReservation(
    patternCardId: string,
    accessToken: string,
  ): Promise<PatternCardReservation | null>;
  reserveInventory(
    patternCardId: string,
    idempotencyKey: string,
    accessToken: string,
  ): Promise<PatternCardReservation>;
  releaseReservation(reservationId: string, accessToken: string): Promise<PatternCardReservation>;
  consumeInventory(
    patternCardId: string,
    idempotencyKey: string,
    accessToken: string,
  ): Promise<PatternCardConsumption>;
  undoConsumption(consumptionId: string, accessToken: string): Promise<PatternCardConsumption>;
  getLatestConsumption(
    patternCardId: string,
    accessToken: string,
  ): Promise<PatternCardConsumption | null>;
  listConsumptionHistory(
    limit: number,
    accessToken: string,
  ): Promise<readonly PatternCardConsumptionHistoryItem[]>;
}

export class PatternMaterialRevisionConflictError extends Error {
  constructor(message = '复核草稿已在其他位置更新，请刷新后比较差异。') {
    super(message);
    this.name = 'PatternMaterialRevisionConflictError';
  }
}

export class PatternMaterialReviewError extends Error {
  constructor(message = '材料复核操作失败。') {
    super(message);
    this.name = 'PatternMaterialReviewError';
  }
}

export class PatternMaterialNotReadyError extends Error {
  constructor(message = '图纸尚未完成人工复核，不能计算库存。') {
    super(message);
    this.name = 'PatternMaterialNotReadyError';
  }
}

export class PatternConsumptionError extends Error {
  constructor(
    message: string,
    readonly code: 'INSUFFICIENT_INVENTORY' | 'UNDO_EXPIRED' | 'CONSUMPTION_FAILED',
  ) {
    super(message);
    this.name = 'PatternConsumptionError';
  }
}

export class PatternReservationError extends Error {
  constructor(
    message: string,
    readonly code:
      'INSUFFICIENT_AVAILABLE_INVENTORY' | 'RESERVATION_ALREADY_CONSUMED' | 'RESERVATION_FAILED',
  ) {
    super(message);
    this.name = 'PatternReservationError';
  }
}

export type PatternCardReviewRoutesOptions = {
  validPaletteColorIds: ReadonlySet<string>;
  paletteColors: readonly PaletteColor[];
  inventoryRepository: InventoryRepository | null;
  repository: PatternCardReviewRepository | null;
};

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

async function calculateInventoryCheck(
  patternCardId: string,
  accessToken: string,
  options: PatternCardReviewRoutesOptions,
): Promise<PatternCardInventoryCheckResult> {
  if (!options.repository || !options.inventoryRepository) {
    throw new Error('PERSISTENCE_NOT_CONFIGURED');
  }
  const [version, inventory, reservations] = await Promise.all([
    options.repository.getLatestVersion(patternCardId, accessToken),
    options.inventoryRepository.list(accessToken),
    options.repository.listActiveReservations(accessToken),
  ]);
  const requirements = new Map(version.items.map((item) => [item.paletteColorId, item.quantity]));
  const ownReservation = reservations.find(
    (reservation) => reservation.patternCardId === patternCardId && reservation.status === 'active',
  );
  const ownByColor = new Map(
    (ownReservation?.items ?? []).map((item) => [item.paletteColorId, item.quantity]),
  );
  const otherByColor = new Map<string, number>();
  for (const reservation of reservations) {
    if (reservation.status !== 'active' || reservation.patternCardId === patternCardId) continue;
    for (const item of reservation.items) {
      otherByColor.set(
        item.paletteColorId,
        (otherByColor.get(item.paletteColorId) ?? 0) + item.quantity,
      );
    }
  }
  const inventoryByColor = new Map(inventory.map((item) => [item.paletteColorId, item]));
  const baseBalances = enrichMaterialBalances(
    calculateMaterialBalances(
      requirements,
      inventory.map((item) => ({
        ...item,
        quantity: Math.max(
          item.quantity -
            (ownByColor.get(item.paletteColorId) ?? 0) -
            (otherByColor.get(item.paletteColorId) ?? 0),
          0,
        ),
      })),
    ),
    options.paletteColors,
  );
  const balances = baseBalances.map((balance) => {
    const required = requirements.get(balance.paletteColorId) ?? 0;
    const reservedForThisCard = ownByColor.get(balance.paletteColorId) ?? 0;
    const reservedElsewhere = otherByColor.get(balance.paletteColorId) ?? 0;
    const onHand = inventoryByColor.get(balance.paletteColorId)?.quantity ?? 0;
    const netRequired = Math.max(required - reservedForThisCard, 0);
    const freelyAvailable = Math.max(onHand - reservedForThisCard - reservedElsewhere, 0);
    return {
      ...balance,
      required,
      reserved: reservedForThisCard,
      netRequired,
      available: freelyAvailable,
      shortage: Math.max(netRequired - freelyAvailable, 0),
      remaining: freelyAvailable - netRequired,
      onHand,
      reservedForThisCard,
      reservedElsewhere,
      freelyAvailable,
    };
  });
  return {
    patternCard: {
      patternCardId,
      materialVersion: version.version,
      totalBeads: version.totalQuantity,
      colorCount: version.items.length,
      confirmedAt: version.confirmedAt,
    },
    balances,
    totals: {
      required: sum(balances.map((item) => item.required)),
      reservedForThisCard: sum(balances.map((item) => item.reservedForThisCard)),
      reservedElsewhere: sum(balances.map((item) => item.reservedElsewhere)),
      shortage: sum(balances.map((item) => item.shortage)),
      colorsReady: balances.filter((item) => item.shortage === 0).length,
      colorsShort: balances.filter((item) => item.shortage > 0).length,
    },
    hasEstimatedInventory: balances.some((item) => item.quantityConfidence === 'estimated'),
  };
}

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function validateDraftItems(
  items: readonly PatternMaterialDraftItem[],
  validPaletteColorIds: ReadonlySet<string>,
): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (!validPaletteColorIds.has(item.paletteColorId)) {
      return `材料 ${item.paletteColorId} 不属于当前 MARD 色卡。`;
    }
    if (seen.has(item.paletteColorId)) {
      return `同一色号不能保留两条材料，请先合并数量。`;
    }
    seen.add(item.paletteColorId);
    if (item.recognitionSource === 'manual' && item.reviewState === 'pending') {
      return '手工新增材料不能保持待确认状态。';
    }
  }
  return null;
}

function serviceUnavailable(requestId: string) {
  return {
    error: {
      code: 'PERSISTENCE_NOT_CONFIGURED',
      message: 'Supabase 尚未配置，复核草稿没有写入云端。',
      requestId,
    },
  };
}

export function registerPatternCardReviewRoutes(
  app: FastifyInstance,
  options: PatternCardReviewRoutesOptions,
) {
  app.get('/api/pattern-card-consumptions', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken)
      return reply.status(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: '查看制作历史前必须登录。',
          requestId: request.id,
        },
      });
    const query = consumptionHistoryQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.status(400).send({
        error: {
          code: 'INVALID_LIMIT',
          message: '制作历史数量必须在 1 到 50 之间。',
          requestId: request.id,
        },
      });
    if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));
    try {
      const result: PatternCardConsumptionHistoryResult = {
        items: await options.repository.listConsumptionHistory(query.data.limit, accessToken),
      };
      return reply.send(result);
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'CONSUMPTION_HISTORY_FAILED',
          message: '制作历史读取失败，没有修改库存。',
          requestId: request.id,
        },
      });
    }
  });

  app.get<{ Params: { id: string } }>(
    '/api/pattern-cards/:id/consumption/latest',
    async (request, reply) => {
      const accessToken = bearerToken(request.headers.authorization);
      if (!accessToken)
        return reply.status(401).send({
          error: {
            code: 'AUTH_REQUIRED',
            message: '查看制作记录前必须登录。',
            requestId: request.id,
          },
        });
      if (!z.string().uuid().safeParse(request.params.id).success)
        return reply.status(400).send({
          error: {
            code: 'INVALID_CARD_ID',
            message: '图纸资料卡编号无效。',
            requestId: request.id,
          },
        });
      if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));
      try {
        return reply.send(
          await options.repository.getLatestConsumption(request.params.id, accessToken),
        );
      } catch (error) {
        request.log.error(error);
        return reply.status(502).send({
          error: {
            code: 'CONSUMPTION_LOAD_FAILED',
            message: '制作记录读取失败。',
            requestId: request.id,
          },
        });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/pattern-cards/:id/reservation',
    async (request, reply) => {
      const accessToken = bearerToken(request.headers.authorization);
      if (!accessToken)
        return reply.status(401).send({
          error: {
            code: 'AUTH_REQUIRED',
            message: '查看待做预留前必须登录。',
            requestId: request.id,
          },
        });
      if (!z.string().uuid().safeParse(request.params.id).success)
        return reply.status(400).send({
          error: {
            code: 'INVALID_CARD_ID',
            message: '图纸资料卡编号无效。',
            requestId: request.id,
          },
        });
      if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));
      try {
        return reply.send(
          await options.repository.getActiveReservation(request.params.id, accessToken),
        );
      } catch (error) {
        request.log.error(error);
        return reply.status(502).send({
          error: {
            code: 'RESERVATION_LOAD_FAILED',
            message: '待做预留读取失败。',
            requestId: request.id,
          },
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/pattern-cards/:id/reserve', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken)
      return reply.status(401).send({
        error: { code: 'AUTH_REQUIRED', message: '加入待做前必须登录。', requestId: request.id },
      });
    if (!z.string().uuid().safeParse(request.params.id).success)
      return reply.status(400).send({
        error: { code: 'INVALID_CARD_ID', message: '图纸资料卡编号无效。', requestId: request.id },
      });
    const body = reserveSchema.safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({
        error: {
          code: 'INVALID_IDEMPOTENCY_KEY',
          message: '本次预留操作编号无效。',
          requestId: request.id,
        },
      });
    if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));
    try {
      return reply
        .status(201)
        .send(
          await options.repository.reserveInventory(
            request.params.id,
            body.data.idempotencyKey,
            accessToken,
          ),
        );
    } catch (error) {
      if (error instanceof PatternReservationError)
        return reply.status(error.code === 'INSUFFICIENT_AVAILABLE_INVENTORY' ? 409 : 422).send({
          error: { code: error.code, message: error.message, requestId: request.id },
        });
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'RESERVATION_FAILED',
          message: '加入待做失败，库存没有改变。',
          requestId: request.id,
        },
      });
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/pattern-card-reservations/:id/release',
    async (request, reply) => {
      const accessToken = bearerToken(request.headers.authorization);
      if (!accessToken)
        return reply.status(401).send({
          error: { code: 'AUTH_REQUIRED', message: '取消待做前必须登录。', requestId: request.id },
        });
      if (!z.string().uuid().safeParse(request.params.id).success)
        return reply.status(400).send({
          error: {
            code: 'INVALID_RESERVATION_ID',
            message: '待做预留编号无效。',
            requestId: request.id,
          },
        });
      if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));
      try {
        return reply.send(
          await options.repository.releaseReservation(request.params.id, accessToken),
        );
      } catch (error) {
        if (error instanceof PatternReservationError)
          return reply.status(409).send({
            error: { code: error.code, message: error.message, requestId: request.id },
          });
        request.log.error(error);
        return reply.status(502).send({
          error: {
            code: 'RESERVATION_RELEASE_FAILED',
            message: '取消待做失败，预留仍然保留。',
            requestId: request.id,
          },
        });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/pattern-cards/:id/consume', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken)
      return reply.status(401).send({
        error: { code: 'AUTH_REQUIRED', message: '扣减库存前必须登录。', requestId: request.id },
      });
    if (!z.string().uuid().safeParse(request.params.id).success)
      return reply.status(400).send({
        error: { code: 'INVALID_CARD_ID', message: '图纸资料卡编号无效。', requestId: request.id },
      });
    const body = consumeSchema.safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({
        error: {
          code: 'INVALID_IDEMPOTENCY_KEY',
          message: '本次制作操作编号无效。',
          requestId: request.id,
        },
      });
    if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));
    try {
      return reply
        .status(201)
        .send(
          await options.repository.consumeInventory(
            request.params.id,
            body.data.idempotencyKey,
            accessToken,
          ),
        );
    } catch (error) {
      if (error instanceof PatternConsumptionError) {
        return reply.status(error.code === 'INSUFFICIENT_INVENTORY' ? 409 : 422).send({
          error: { code: error.code, message: error.message, requestId: request.id },
        });
      }
      if (error instanceof PatternReservationError) {
        return reply.status(409).send({
          error: { code: error.code, message: error.message, requestId: request.id },
        });
      }
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'CONSUMPTION_FAILED',
          message: '库存扣减失败，没有进行部分扣减。',
          requestId: request.id,
        },
      });
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/pattern-card-consumptions/:id/undo',
    async (request, reply) => {
      const accessToken = bearerToken(request.headers.authorization);
      if (!accessToken)
        return reply.status(401).send({
          error: { code: 'AUTH_REQUIRED', message: '撤销扣减前必须登录。', requestId: request.id },
        });
      if (!z.string().uuid().safeParse(request.params.id).success)
        return reply.status(400).send({
          error: {
            code: 'INVALID_CONSUMPTION_ID',
            message: '制作记录编号无效。',
            requestId: request.id,
          },
        });
      if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));
      try {
        return reply.send(await options.repository.undoConsumption(request.params.id, accessToken));
      } catch (error) {
        if (error instanceof PatternConsumptionError)
          return reply.status(409).send({
            error: { code: error.code, message: error.message, requestId: request.id },
          });
        request.log.error(error);
        return reply.status(502).send({
          error: {
            code: 'UNDO_FAILED',
            message: '撤销失败，库存没有进行部分恢复。',
            requestId: request.id,
          },
        });
      }
    },
  );

  app.get('/api/pattern-card-recommendations', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: '查看图纸推荐前必须登录。',
          requestId: request.id,
        },
      });
    }
    if (!options.repository || !options.inventoryRepository) {
      return reply.status(503).send(serviceUnavailable(request.id));
    }
    const query = recommendationQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_RECOMMENDATION_QUERY',
          message: '推荐数量、模式或总颗数范围无效。',
          requestId: request.id,
        },
      });
    }
    try {
      const [candidates, inventory, reservations] = await Promise.all([
        options.repository.listConfirmedMaterials(accessToken),
        options.inventoryRepository.list(accessToken),
        options.repository.listActiveReservations(accessToken),
      ]);
      const filter = {
        ...(query.data.minTotalBeads === undefined
          ? {}
          : { minTotalBeads: query.data.minTotalBeads }),
        ...(query.data.maxTotalBeads === undefined
          ? {}
          : { maxTotalBeads: query.data.maxTotalBeads }),
      };
      const filteredCandidates = filterPatternCardCandidates(candidates, filter);
      const result: PatternCardRecommendationResult = {
        mode: query.data.mode,
        items: rankPatternCardRecommendations(
          filteredCandidates,
          inventory,
          options.paletteColors,
          query.data.limit,
          query.data.mode,
          filter,
          reservations,
        ),
        evaluatedCount: filteredCandidates.length,
      };
      return reply.send(result);
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'PATTERN_RECOMMENDATION_FAILED',
          message: '无法根据正式图纸和当前库存生成推荐，未修改任何数据。',
          requestId: request.id,
        },
      });
    }
  });

  app.post('/api/pattern-cards/combined-purchase-list', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken)
      return reply.status(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: '合并计算补豆前必须登录。',
          requestId: request.id,
        },
      });
    const body = combinedPurchaseListSchema.safeParse(request.body);
    if (
      !body.success ||
      new Set(body.data?.patternCardIds).size !== body.data?.patternCardIds.length
    )
      return reply.status(400).send({
        error: {
          code: 'INVALID_PATTERN_CARD_SELECTION',
          message: '请选择 1–20 张不重复的已确认图纸。',
          requestId: request.id,
        },
      });
    if (!options.repository || !options.inventoryRepository)
      return reply.status(503).send(serviceUnavailable(request.id));
    try {
      const [candidates, inventory, reservations] = await Promise.all([
        options.repository.listConfirmedMaterials(accessToken),
        options.inventoryRepository.list(accessToken),
        options.repository.listActiveReservations(accessToken),
      ]);
      const candidatesById = new Map(
        candidates.map((candidate) => [candidate.patternCardId, candidate]),
      );
      const selected = body.data.patternCardIds.map((id) => candidatesById.get(id));
      if (selected.some((candidate) => candidate === undefined))
        return reply.status(409).send({
          error: {
            code: 'PATTERN_CARDS_NOT_CONFIRMED',
            message: '所选图纸中有不存在或尚未完成人工确认的项目，请刷新后重新选择。',
            requestId: request.id,
          },
        });
      const patternCards = selected.filter(
        (candidate): candidate is PatternCardMaterialCandidate => candidate !== undefined,
      );
      const requirements = new Map<string, number>();
      for (const card of patternCards)
        for (const item of card.items)
          requirements.set(
            item.paletteColorId,
            (requirements.get(item.paletteColorId) ?? 0) + item.quantity,
          );
      const selectedIds = new Set(patternCards.map((card) => card.patternCardId));
      const reservedElsewhere = new Map<string, number>();
      for (const reservation of reservations) {
        if (reservation.status !== 'active' || selectedIds.has(reservation.patternCardId)) continue;
        for (const item of reservation.items)
          reservedElsewhere.set(
            item.paletteColorId,
            (reservedElsewhere.get(item.paletteColorId) ?? 0) + item.quantity,
          );
      }
      const balances = enrichMaterialBalances(
        calculateMaterialBalances(
          requirements,
          inventory.map((item) => ({
            ...item,
            quantity: Math.max(
              item.quantity - (reservedElsewhere.get(item.paletteColorId) ?? 0),
              0,
            ),
          })),
        ),
        options.paletteColors,
      );
      const purchase = createPurchaseList(balances);
      const cardLines = patternCards.map((card) => `${card.name}（${card.totalBeads} 颗）`);
      const result: CombinedPatternCardPurchaseListResult = {
        patternCards: patternCards.map((card) => ({
          patternCardId: card.patternCardId,
          name: card.name,
          materialVersion: card.materialVersion,
          totalBeads: card.totalBeads,
          colorCount: card.items.length,
          confirmedAt: card.confirmedAt,
        })),
        balances,
        totals: {
          patternCards: patternCards.length,
          required: sum(balances.map((item) => item.required)),
          shortage: sum(balances.map((item) => item.shortage)),
          colorsReady: balances.filter((item) => item.shortage === 0).length,
          colorsShort: balances.filter((item) => item.shortage > 0).length,
        },
        hasEstimatedInventory: balances.some((item) => item.quantityConfidence === 'estimated'),
        ...purchase,
        copyText: [
          'BeadFlow 多图合并补豆清单',
          `所选图纸：${cardLines.join('、')}`,
          '',
          ...(purchase.items.length === 0
            ? ['当前无需补豆。']
            : purchase.copyText.split('\n').slice(1)),
        ].join('\n'),
      };
      return reply.send(result);
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'COMBINED_PURCHASE_LIST_FAILED',
          message: '多图补豆清单生成失败，没有修改库存。',
          requestId: request.id,
        },
      });
    }
  });

  const inventoryHandle = async (
    request: FastifyRequest,
    reply: FastifyReply,
    includePurchaseList: boolean,
  ) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: { code: 'AUTH_REQUIRED', message: '计算库存前必须登录。', requestId: request.id },
      });
    }
    const params = request.params as { id?: string };
    if (!params.id || !z.string().uuid().safeParse(params.id).success) {
      return reply.status(400).send({
        error: { code: 'INVALID_CARD_ID', message: '图纸资料卡编号无效。', requestId: request.id },
      });
    }
    if (!options.repository || !options.inventoryRepository) {
      return reply.status(503).send(serviceUnavailable(request.id));
    }
    try {
      const check = await calculateInventoryCheck(params.id, accessToken, options);
      if (!includePurchaseList) return reply.send(check);
      const purchase = createPurchaseList(check.balances);
      const result: PatternCardPurchaseListResult = { ...check, ...purchase };
      return reply.send(result);
    } catch (error) {
      if (error instanceof PatternMaterialNotReadyError) {
        return reply.status(409).send({
          error: { code: 'MATERIALS_NOT_CONFIRMED', message: error.message, requestId: request.id },
        });
      }
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'PATTERN_CARD_INVENTORY_CHECK_FAILED',
          message: '无法读取正式材料版本和个人库存，未修改任何库存数据。',
          requestId: request.id,
        },
      });
    }
  };

  app.get('/api/pattern-cards/:id/inventory-check', async (request, reply) =>
    inventoryHandle(request, reply, false),
  );
  app.get('/api/pattern-cards/:id/purchase-list', async (request, reply) =>
    inventoryHandle(request, reply, true),
  );

  app.get<{ Params: { id: string } }>('/api/pattern-cards/:id/review', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: '读取复核草稿前必须登录。',
          requestId: request.id,
        },
      });
    }
    if (!z.string().uuid().safeParse(request.params.id).success) {
      return reply.status(400).send({
        error: { code: 'INVALID_CARD_ID', message: '图纸资料卡编号无效。', requestId: request.id },
      });
    }
    if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));
    try {
      return reply.send(await options.repository.getDraft(request.params.id, accessToken));
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'REVIEW_LOAD_FAILED',
          message: '复核草稿读取失败，本地修改不应被清除。',
          requestId: request.id,
        },
      });
    }
  });

  app.put<{ Params: { id: string } }>('/api/pattern-cards/:id/review', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: '保存复核草稿前必须登录。',
          requestId: request.id,
        },
      });
    }
    if (!z.string().uuid().safeParse(request.params.id).success) {
      return reply.status(400).send({
        error: { code: 'INVALID_CARD_ID', message: '图纸资料卡编号无效。', requestId: request.id },
      });
    }
    if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));

    const body = saveDraftSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REVIEW_DRAFT',
          message: '复核草稿格式无效。',
          requestId: request.id,
        },
      });
    }
    const itemIssue = validateDraftItems(body.data.items, options.validPaletteColorIds);
    if (itemIssue) {
      return reply.status(400).send({
        error: { code: 'INVALID_REVIEW_DRAFT', message: itemIssue, requestId: request.id },
      });
    }

    try {
      return reply.send(
        await options.repository.saveDraft({
          patternCardId: request.params.id,
          expectedRevision: body.data.expectedRevision,
          ...(body.data.declaredTotal === undefined
            ? {}
            : { declaredTotal: body.data.declaredTotal }),
          conflicts: body.data.conflicts,
          items: body.data.items,
          accessToken,
        }),
      );
    } catch (error) {
      if (error instanceof PatternMaterialRevisionConflictError) {
        return reply.status(409).send({
          error: { code: 'REVISION_CONFLICT', message: error.message, requestId: request.id },
        });
      }
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'REVIEW_SAVE_FAILED',
          message: '复核草稿保存失败，本地修改不应被清除。',
          requestId: request.id,
        },
      });
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/pattern-cards/:id/review/confirm',
    async (request, reply) => {
      const accessToken = bearerToken(request.headers.authorization);
      if (!accessToken) {
        return reply.status(401).send({
          error: {
            code: 'AUTH_REQUIRED',
            message: '确认正式材料版本前必须登录。',
            requestId: request.id,
          },
        });
      }
      if (!z.string().uuid().safeParse(request.params.id).success) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_CARD_ID',
            message: '图纸资料卡编号无效。',
            requestId: request.id,
          },
        });
      }
      if (!options.repository) return reply.status(503).send(serviceUnavailable(request.id));
      const body = confirmDraftSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_CONFIRMATION',
            message: '确认参数无效。',
            requestId: request.id,
          },
        });
      }
      try {
        return reply.status(201).send(
          await options.repository.confirmDraft({
            patternCardId: request.params.id,
            expectedRevision: body.data.expectedRevision,
            acceptDeclaredTotalMismatch: body.data.acceptDeclaredTotalMismatch,
            accessToken,
          }),
        );
      } catch (error) {
        if (error instanceof PatternMaterialRevisionConflictError) {
          return reply.status(409).send({
            error: { code: 'REVISION_CONFLICT', message: error.message, requestId: request.id },
          });
        }
        if (error instanceof PatternMaterialReviewError) {
          return reply.status(422).send({
            error: { code: 'REVIEW_INCOMPLETE', message: error.message, requestId: request.id },
          });
        }
        request.log.error(error);
        return reply.status(502).send({
          error: {
            code: 'REVIEW_CONFIRM_FAILED',
            message: '正式材料版本创建失败，复核草稿仍然保留。',
            requestId: request.id,
          },
        });
      }
    },
  );
}

type SupabaseErrorPayload = { message?: string };

type PatternConsumptionHistoryRow = {
  id: string;
  pattern_card_id: string;
  material_version: number;
  idempotency_key: string;
  status: 'applied' | 'reverted';
  total_quantity: number;
  created_at: string;
  undo_expires_at: string;
  reverted_at: string | null;
  pattern_cards: { name: string } | null;
  pattern_card_consumption_items: Array<{
    palette_color_id: string;
    quantity: number;
    balance_after: number;
  }>;
};

function normalizeDraft(payload: PatternMaterialReviewDraft): PatternMaterialReviewDraft {
  return { ...payload, updatedAt: new Date(payload.updatedAt).toISOString() };
}

function normalizeVersion(payload: PatternMaterialVersion): PatternMaterialVersion {
  return { ...payload, confirmedAt: new Date(payload.confirmedAt).toISOString() };
}

function normalizeConsumption(payload: PatternCardConsumption): PatternCardConsumption {
  return {
    ...payload,
    createdAt: new Date(payload.createdAt).toISOString(),
    undoExpiresAt: new Date(payload.undoExpiresAt).toISOString(),
    ...(payload.revertedAt ? { revertedAt: new Date(payload.revertedAt).toISOString() } : {}),
  };
}

function normalizeReservation(payload: PatternCardReservation): PatternCardReservation {
  return {
    ...payload,
    createdAt: new Date(payload.createdAt).toISOString(),
    ...(payload.releasedAt ? { releasedAt: new Date(payload.releasedAt).toISOString() } : {}),
    ...(payload.consumedAt ? { consumedAt: new Date(payload.consumedAt).toISOString() } : {}),
  };
}

export class SupabasePatternCardReviewRepository implements PatternCardReviewRepository {
  constructor(
    private readonly url: string,
    private readonly publishableKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getDraft(patternCardId: string, accessToken: string): Promise<PatternMaterialReviewDraft> {
    return normalizeDraft(
      await this.rpc<PatternMaterialReviewDraft>('get_pattern_material_review', accessToken, {
        p_pattern_card_id: patternCardId,
      }),
    );
  }

  async saveDraft(input: SavePatternMaterialDraftInput): Promise<PatternMaterialReviewDraft> {
    return normalizeDraft(
      await this.rpc<PatternMaterialReviewDraft>(
        'save_pattern_material_review',
        input.accessToken,
        {
          p_pattern_card_id: input.patternCardId,
          p_expected_revision: input.expectedRevision,
          p_declared_total: input.declaredTotal ?? null,
          p_conflicts: input.conflicts,
          p_items: input.items,
        },
      ),
    );
  }

  async confirmDraft(input: ConfirmPatternMaterialDraftInput): Promise<PatternMaterialVersion> {
    return normalizeVersion(
      await this.rpc<PatternMaterialVersion>('confirm_pattern_material_review', input.accessToken, {
        p_pattern_card_id: input.patternCardId,
        p_expected_revision: input.expectedRevision,
        p_accept_declared_total_mismatch: input.acceptDeclaredTotalMismatch,
      }),
    );
  }

  async getLatestVersion(
    patternCardId: string,
    accessToken: string,
  ): Promise<PatternMaterialVersion> {
    return normalizeVersion(
      await this.rpc<PatternMaterialVersion>('get_latest_pattern_material_version', accessToken, {
        p_pattern_card_id: patternCardId,
      }),
    );
  }

  async listConfirmedMaterials(
    accessToken: string,
  ): Promise<readonly PatternCardMaterialCandidate[]> {
    return this.rpc<readonly PatternCardMaterialCandidate[]>(
      'list_confirmed_pattern_materials',
      accessToken,
      {},
    );
  }

  async listActiveReservations(accessToken: string): Promise<readonly PatternCardReservation[]> {
    const result = await this.rpc<readonly PatternCardReservation[]>(
      'list_active_pattern_card_reservations',
      accessToken,
      {},
    );
    return result.map(normalizeReservation);
  }

  async getActiveReservation(
    patternCardId: string,
    accessToken: string,
  ): Promise<PatternCardReservation | null> {
    const result = await this.rpc<PatternCardReservation | null>(
      'get_active_pattern_card_reservation',
      accessToken,
      { p_pattern_card_id: patternCardId },
    );
    return result ? normalizeReservation(result) : null;
  }

  async reserveInventory(
    patternCardId: string,
    idempotencyKey: string,
    accessToken: string,
  ): Promise<PatternCardReservation> {
    return normalizeReservation(
      await this.rpc<PatternCardReservation>('reserve_pattern_card_inventory', accessToken, {
        p_pattern_card_id: patternCardId,
        p_idempotency_key: idempotencyKey,
      }),
    );
  }

  async releaseReservation(
    reservationId: string,
    accessToken: string,
  ): Promise<PatternCardReservation> {
    return normalizeReservation(
      await this.rpc<PatternCardReservation>('release_pattern_card_reservation', accessToken, {
        p_reservation_id: reservationId,
      }),
    );
  }

  async consumeInventory(
    patternCardId: string,
    idempotencyKey: string,
    accessToken: string,
  ): Promise<PatternCardConsumption> {
    return normalizeConsumption(
      await this.rpc<PatternCardConsumption>('consume_pattern_card_inventory', accessToken, {
        p_pattern_card_id: patternCardId,
        p_idempotency_key: idempotencyKey,
      }),
    );
  }

  async undoConsumption(
    consumptionId: string,
    accessToken: string,
  ): Promise<PatternCardConsumption> {
    return normalizeConsumption(
      await this.rpc<PatternCardConsumption>('undo_pattern_card_consumption', accessToken, {
        p_consumption_id: consumptionId,
      }),
    );
  }

  async getLatestConsumption(
    patternCardId: string,
    accessToken: string,
  ): Promise<PatternCardConsumption | null> {
    const result = await this.rpc<PatternCardConsumption | null>(
      'get_latest_pattern_card_consumption',
      accessToken,
      { p_pattern_card_id: patternCardId },
    );
    return result ? normalizeConsumption(result) : null;
  }

  async listConsumptionHistory(
    limit: number,
    accessToken: string,
  ): Promise<readonly PatternCardConsumptionHistoryItem[]> {
    const select = [
      'id',
      'pattern_card_id',
      'material_version',
      'idempotency_key',
      'status',
      'total_quantity',
      'created_at',
      'undo_expires_at',
      'reverted_at',
      'pattern_cards(name)',
      'pattern_card_consumption_items(palette_color_id,quantity,balance_after)',
    ].join(',');
    const response = await this.fetcher(
      `${this.url}/rest/v1/pattern_card_consumptions?select=${select}&order=created_at.desc&limit=${limit}`,
      {
        headers: {
          apikey: this.publishableKey,
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    const payload = (await response.json()) as
      PatternConsumptionHistoryRow[] | SupabaseErrorPayload;
    if (!response.ok) {
      throw new PatternConsumptionError(
        (payload as SupabaseErrorPayload).message ?? 'Supabase 制作历史请求失败。',
        'CONSUMPTION_FAILED',
      );
    }
    return (payload as PatternConsumptionHistoryRow[]).map((row) => ({
      id: row.id,
      patternCardId: row.pattern_card_id,
      patternCardName: row.pattern_cards?.name ?? '未命名图纸',
      materialVersion: row.material_version,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      totalQuantity: row.total_quantity,
      items: row.pattern_card_consumption_items
        .map((item) => ({
          paletteColorId: item.palette_color_id,
          quantity: item.quantity,
          balanceAfter: item.balance_after,
        }))
        .sort((left, right) => left.paletteColorId.localeCompare(right.paletteColorId)),
      createdAt: new Date(row.created_at).toISOString(),
      undoExpiresAt: new Date(row.undo_expires_at).toISOString(),
      ...(row.reverted_at ? { revertedAt: new Date(row.reverted_at).toISOString() } : {}),
      undoAvailable:
        row.status === 'applied' && Date.now() <= new Date(row.undo_expires_at).getTime(),
    }));
  }

  private async rpc<T>(
    name: string,
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetcher(`${this.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: this.publishableKey,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as T | SupabaseErrorPayload;
    if (!response.ok) {
      const message = (payload as SupabaseErrorPayload).message ?? 'Supabase 材料复核请求失败。';
      if (message.includes('REVISION_CONFLICT')) {
        throw new PatternMaterialRevisionConflictError();
      }
      if (
        message.includes('UNRESOLVED_CONFLICTS') ||
        message.includes('REVIEW_INCOMPLETE') ||
        message.includes('TOTAL_MISMATCH_NOT_ACCEPTED')
      ) {
        throw new PatternMaterialReviewError(
          message.includes('TOTAL_MISMATCH_NOT_ACCEPTED')
            ? '材料合计与图纸声明总数不一致，需要人工确认差异。'
            : '仍有待确认材料或未解决冲突，不能生成正式版本。',
        );
      }
      if (message.includes('PATTERN_MATERIALS_NOT_CONFIRMED')) {
        throw new PatternMaterialNotReadyError();
      }
      if (message.includes('INSUFFICIENT_INVENTORY')) {
        throw new PatternConsumptionError(
          '当前库存不足，整次扣减已取消。',
          'INSUFFICIENT_INVENTORY',
        );
      }
      if (message.includes('INSUFFICIENT_AVAILABLE_INVENTORY')) {
        throw new PatternReservationError(
          '可用库存不足；已有待做图纸的预留不会被挤占。',
          'INSUFFICIENT_AVAILABLE_INVENTORY',
        );
      }
      if (message.includes('RESERVATION_ALREADY_CONSUMED')) {
        throw new PatternReservationError(
          '这份待做已开始制作，不能再取消预留。',
          'RESERVATION_ALREADY_CONSUMED',
        );
      }
      if (message.includes('UNDO_EXPIRED')) {
        throw new PatternConsumptionError('已超过 10 分钟撤销期限。', 'UNDO_EXPIRED');
      }
      throw new PatternMaterialReviewError(message);
    }
    return payload as T;
  }
}
