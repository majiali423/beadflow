import { createHash, randomUUID } from 'node:crypto';

import type {
  PaletteColor,
  PatternCardListItem,
  PatternCardListResult,
  PatternCardSource,
  PatternCardSourceDeletionResult,
  PatternCardUploadResult,
  PatternGridAnalysisResult,
  PatternLegendCropSuggestion,
  PatternMaterialDraftItem,
  PatternMaterialReviewDraft,
} from '@beadflow/shared-types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxImageBytes = 15 * 1024 * 1024;
const uploadQuerySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    cropYStart: z.coerce.number().min(0).max(0.95).default(0.7),
    cropYEnd: z.coerce.number().min(0.05).max(1).default(0.99),
    declaredTotal: z.coerce.number().int().positive().max(1_000_000).optional(),
  })
  .strict()
  .refine((value) => value.cropYEnd - value.cropYStart >= 0.05, {
    message: '图例裁剪区域过小。',
  });
const fromClustersBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    imageBase64: z.string().min(1),
    occupiedCount: z.number().int().min(1).max(1_000_000),
    declaredTotal: z.number().int().positive().max(1_000_000).optional(),
    items: z
      .array(
        z
          .object({
            paletteColorId: z.string().min(1),
            quantity: z.number().int().positive().max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(221),
  })
  .strict();

type EvidenceRegionPayload = { x: number; y: number; width: number; height: number };
type LegendRecognitionPayload = {
  materials: readonly {
    code: string;
    quantity: number;
    raw_text: string;
    confidence?: number | null;
    evidence_region: EvidenceRegionPayload;
    recognition_source: 'direct' | 'compact' | 'spatial';
  }[];
  conflicts: readonly string[];
  recognized_total: number;
};

export interface PatternLegendClient {
  analyzeGrid(input: { image: Uint8Array; mimeType: string }): Promise<PatternGridAnalysisResult>;
  detectCrop(input: { image: Uint8Array; mimeType: string }): Promise<PatternLegendCropSuggestion>;
  recognize(input: {
    image: Uint8Array;
    mimeType: string;
    cropYStart: number;
    cropYEnd: number;
    declaredTotal?: number;
  }): Promise<LegendRecognitionPayload>;
}

export type CreatePatternCardInput = {
  name: string;
  image: Uint8Array;
  mimeType: PatternCardUploadResult['sourceMimeType'];
  sha256: string;
  declaredTotal?: number;
  conflicts: readonly string[];
  items: readonly PatternMaterialDraftItem[];
  accessToken: string;
};

export interface PatternCardUploadRepository {
  create(input: CreatePatternCardInput): Promise<PatternCardUploadResult>;
  getSource(patternCardId: string, accessToken: string): Promise<PatternCardSource>;
  deleteSource(
    patternCardId: string,
    accessToken: string,
  ): Promise<PatternCardSourceDeletionResult>;
  list(accessToken: string): Promise<PatternCardListResult>;
}

export type PatternCardUploadRoutesOptions = {
  paletteColors: readonly PaletteColor[];
  repository: PatternCardUploadRepository | null;
  cvClient: PatternLegendClient | null;
};

export class PatternCardUploadError extends Error {
  constructor(message = '图纸导入失败。') {
    super(message);
    this.name = 'PatternCardUploadError';
  }
}

export class PatternLegendTimeoutError extends PatternCardUploadError {
  constructor(operation: 'crop' | 'recognize') {
    super(operation === 'crop' ? '统计栏定位超时。' : '图纸 OCR 识别超时。');
    this.name = 'PatternLegendTimeoutError';
  }
}

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export function registerPatternCardUploadRoutes(
  app: FastifyInstance,
  options: PatternCardUploadRoutesOptions,
): void {
  app.post<{ Body: Buffer }>('/api/pattern-grid/analyze', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: '分析图纸前必须登录。',
          requestId: request.id,
        },
      });
    }
    const mimeType = request.headers['content-type']?.split(';')[0] ?? '';
    if (!allowedMimeTypes.has(mimeType)) {
      return reply.status(415).send({
        error: {
          code: 'UNSUPPORTED_PATTERN_TYPE',
          message: '只支持 JPEG、PNG 或 WebP 图纸。',
          requestId: request.id,
        },
      });
    }
    if (
      !Buffer.isBuffer(request.body) ||
      request.body.length < 1 ||
      request.body.length > maxImageBytes
    ) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PATTERN_UPLOAD',
          message: '请选择一张不超过 15MB 的图纸。',
          requestId: request.id,
        },
      });
    }
    if (!options.cvClient) {
      return reply.status(503).send({
        error: {
          code: 'PATTERN_GRID_NOT_CONFIGURED',
          message: '图纸分析服务尚未配置。',
          requestId: request.id,
        },
      });
    }
    try {
      return reply.send(await options.cvClient.analyzeGrid({ image: request.body, mimeType }));
    } catch (error) {
      request.log.error(error);
      const timedOut = error instanceof PatternLegendTimeoutError;
      return reply.status(timedOut ? 504 : 502).send({
        error: {
          code: timedOut ? 'PATTERN_GRID_TIMEOUT' : 'PATTERN_GRID_FAILED',
          message: timedOut
            ? '主网格分析超时，没有保存图纸，也没有修改库存。'
            : '主网格分析失败，没有修改库存。',
          requestId: request.id,
        },
      });
    }
  });

  app.post('/api/pattern-cards/from-clusters', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: { code: 'AUTH_REQUIRED', message: '保存图纸前必须登录。', requestId: request.id },
      });
    }
    if (!options.repository) {
      return reply.status(503).send({
        error: {
          code: 'PATTERN_IMPORT_NOT_CONFIGURED',
          message: '图纸存储尚未配置。',
          requestId: request.id,
        },
      });
    }
    const body = fromClustersBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_CLUSTER_DRAFT',
          message: '请填写图纸名称，并为每个颜色簇选择真实 MARD 色号。',
          requestId: request.id,
        },
      });
    }
    const paletteById = new Map(options.paletteColors.map((color) => [color.id, color]));
    const seen = new Set<string>();
    let occupiedFromClusters = 0;
    for (const item of body.data.items) {
      if (!paletteById.has(item.paletteColorId)) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_CLUSTER_DRAFT',
            message: `材料 ${item.paletteColorId} 不属于当前 MARD 色卡。`,
            requestId: request.id,
          },
        });
      }
      if (seen.has(item.paletteColorId)) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_CLUSTER_DRAFT',
            message: '同一色号不能保留两条材料，请先合并数量。',
            requestId: request.id,
          },
        });
      }
      seen.add(item.paletteColorId);
      occupiedFromClusters += item.quantity;
    }
    if (occupiedFromClusters !== body.data.occupiedCount) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_CLUSTER_DRAFT',
          message: '颜色簇数量之和必须等于确定占用数。',
          requestId: request.id,
        },
      });
    }
    const image = Buffer.from(body.data.imageBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (image.length < 1 || image.length > maxImageBytes) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PATTERN_UPLOAD',
          message: '请选择一张不超过 15MB 的图纸。',
          requestId: request.id,
        },
      });
    }

    try {
      const items = body.data.items.map((item, index): PatternMaterialDraftItem => ({
        id: randomUUID(),
        paletteColorId: item.paletteColorId,
        quantity: item.quantity,
        rawText: `cluster ${index + 1} · ${item.quantity} (manual)`,
        recognitionSource: 'manual',
        reviewState: 'confirmed',
      }));
      const result = await options.repository.create({
        name: body.data.name,
        image,
        mimeType: body.data.mimeType,
        sha256: createHash('sha256').update(image).digest('hex'),
        ...(body.data.declaredTotal === undefined
          ? {}
          : { declaredTotal: body.data.declaredTotal }),
        conflicts: [],
        items,
        accessToken,
      });
      return reply.status(result.deduplicated ? 200 : 201).send(result);
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'PATTERN_IMPORT_FAILED',
          message: '图纸资料保存失败，没有修改库存。',
          requestId: request.id,
        },
      });
    }
  });

  app.post<{ Body: Buffer }>('/api/pattern-cards/detect-legend-crop', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: '自动定位统计栏前必须登录。',
          requestId: request.id,
        },
      });
    }
    const mimeType = request.headers['content-type']?.split(';')[0] ?? '';
    if (!allowedMimeTypes.has(mimeType)) {
      return reply.status(415).send({
        error: {
          code: 'UNSUPPORTED_PATTERN_TYPE',
          message: '只支持 JPEG、PNG 或 WebP 图纸。',
          requestId: request.id,
        },
      });
    }
    if (
      !Buffer.isBuffer(request.body) ||
      request.body.length < 1 ||
      request.body.length > maxImageBytes
    ) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PATTERN_IMAGE',
          message: '请选择不超过 15MB 的有效图纸图片。',
          requestId: request.id,
        },
      });
    }
    if (!options.cvClient) {
      return reply.status(503).send({
        error: {
          code: 'PATTERN_OCR_NOT_CONFIGURED',
          message: 'OCR 服务尚未配置。',
          requestId: request.id,
        },
      });
    }
    try {
      return reply.send(await options.cvClient.detectCrop({ image: request.body, mimeType }));
    } catch (error) {
      request.log.error(error);
      const timedOut = error instanceof PatternLegendTimeoutError;
      return reply.status(timedOut ? 504 : 502).send({
        error: {
          code: timedOut ? 'LEGEND_CROP_TIMEOUT' : 'LEGEND_CROP_DETECTION_FAILED',
          message: timedOut
            ? '自动定位统计栏超时，可手动调整范围后继续。'
            : '自动定位统计栏失败，可手动调整范围后继续。',
          requestId: request.id,
        },
      });
    }
  });

  app.get('/api/pattern-cards', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: { code: 'AUTH_REQUIRED', message: '查看图纸库前必须登录。', requestId: request.id },
      });
    }
    if (!options.repository) {
      return reply.status(503).send({
        error: {
          code: 'PATTERN_IMPORT_NOT_CONFIGURED',
          message: '图纸存储尚未配置。',
          requestId: request.id,
        },
      });
    }
    try {
      return reply.send(await options.repository.list(accessToken));
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'PATTERN_LIBRARY_FAILED',
          message: '无法读取图纸库，未修改任何数据。',
          requestId: request.id,
        },
      });
    }
  });

  app.get<{ Params: { id: string } }>('/api/pattern-cards/:id/source', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: '查看图纸原图前必须登录。',
          requestId: request.id,
        },
      });
    }
    if (!z.string().uuid().safeParse(request.params.id).success) {
      return reply.status(400).send({
        error: { code: 'INVALID_CARD_ID', message: '图纸资料卡编号无效。', requestId: request.id },
      });
    }
    if (!options.repository) {
      return reply.status(503).send({
        error: {
          code: 'PATTERN_IMPORT_NOT_CONFIGURED',
          message: '图纸存储尚未配置。',
          requestId: request.id,
        },
      });
    }
    try {
      return reply.send(await options.repository.getSource(request.params.id, accessToken));
    } catch (error) {
      request.log.error(error);
      return reply.status(502).send({
        error: {
          code: 'PATTERN_SOURCE_FAILED',
          message: '无法读取该图纸的私有原图。',
          requestId: request.id,
        },
      });
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/api/pattern-cards/:id/source',
    async (request, reply) => {
      const accessToken = bearerToken(request.headers.authorization);
      if (!accessToken) {
        return reply.status(401).send({
          error: {
            code: 'AUTH_REQUIRED',
            message: '删除图纸原图前必须登录。',
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
      if (!options.repository) {
        return reply.status(503).send({
          error: {
            code: 'PATTERN_IMPORT_NOT_CONFIGURED',
            message: '图纸存储尚未配置。',
            requestId: request.id,
          },
        });
      }
      try {
        return reply.send(await options.repository.deleteSource(request.params.id, accessToken));
      } catch (error) {
        request.log.error(error);
        return reply.status(502).send({
          error: {
            code: 'PATTERN_SOURCE_DELETE_FAILED',
            message: '原图删除失败，资料卡和库存数据均未改动，请稍后重试。',
            requestId: request.id,
          },
        });
      }
    },
  );

  app.post<{ Body: Buffer }>('/api/pattern-cards/import', async (request, reply) => {
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      return reply.status(401).send({
        error: { code: 'AUTH_REQUIRED', message: '上传图纸前必须登录。', requestId: request.id },
      });
    }
    const mimeType = request.headers['content-type']?.split(';')[0] ?? '';
    const query = uploadQuerySchema.safeParse(request.query);
    if (!allowedMimeTypes.has(mimeType)) {
      return reply.status(415).send({
        error: {
          code: 'UNSUPPORTED_PATTERN_TYPE',
          message: '只支持 JPEG、PNG 或 WebP 图纸。',
          requestId: request.id,
        },
      });
    }
    if (
      !query.success ||
      !Buffer.isBuffer(request.body) ||
      request.body.length < 1 ||
      request.body.length > maxImageBytes
    ) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_PATTERN_UPLOAD',
          message: '请填写图纸名称，选择有效裁剪区域，并上传不超过 15MB 的图片。',
          requestId: request.id,
        },
      });
    }
    if (!options.repository || !options.cvClient) {
      return reply.status(503).send({
        error: {
          code: 'PATTERN_IMPORT_NOT_CONFIGURED',
          message: '图纸存储或 OCR 服务尚未配置。',
          requestId: request.id,
        },
      });
    }

    try {
      const recognition = await options.cvClient.recognize({
        image: request.body,
        mimeType,
        cropYStart: query.data.cropYStart,
        cropYEnd: query.data.cropYEnd,
        ...(query.data.declaredTotal === undefined
          ? {}
          : { declaredTotal: query.data.declaredTotal }),
      });
      const paletteByCode = new Map(options.paletteColors.map((color) => [color.code, color]));
      const items = recognition.materials.map((material): PatternMaterialDraftItem => {
        const color = paletteByCode.get(material.code);
        if (!color) throw new PatternCardUploadError(`OCR 返回了未知 MARD 色号：${material.code}`);
        return {
          id: randomUUID(),
          paletteColorId: color.id,
          quantity: material.quantity,
          rawText: material.raw_text,
          ...(material.confidence == null ? {} : { confidence: material.confidence }),
          evidenceRegion: material.evidence_region,
          recognitionSource: material.recognition_source,
          reviewState: 'pending',
        };
      });
      const result = await options.repository.create({
        name: query.data.name,
        image: request.body,
        mimeType: mimeType as PatternCardUploadResult['sourceMimeType'],
        sha256: createHash('sha256').update(request.body).digest('hex'),
        ...(query.data.declaredTotal === undefined
          ? {}
          : { declaredTotal: query.data.declaredTotal }),
        conflicts: recognition.conflicts,
        items,
        accessToken,
      });
      return reply.status(result.deduplicated ? 200 : 201).send(result);
    } catch (error) {
      request.log.error(error);
      const timedOut = error instanceof PatternLegendTimeoutError;
      return reply.status(timedOut ? 504 : 502).send({
        error: {
          code: timedOut ? 'PATTERN_OCR_TIMEOUT' : 'PATTERN_IMPORT_FAILED',
          message: timedOut
            ? 'OCR 识别超时，图片和库存均未改动。可保留当前框选范围后重试。'
            : 'OCR 或云端保存失败，没有生成可用于库存计算的正式材料。',
          requestId: request.id,
        },
      });
    }
  });
}

export class HttpPatternLegendClient implements PatternLegendClient {
  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly cropTimeoutMs = 20_000,
    private readonly recognizeTimeoutMs = 180_000,
  ) {}

  private async fetchWithTimeout(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    operation: 'crop' | 'recognize',
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetcher(`${this.url}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new PatternLegendTimeoutError(operation);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async analyzeGrid(
    input: Parameters<PatternLegendClient['analyzeGrid']>[0],
  ): Promise<PatternGridAnalysisResult> {
    const form = new FormData();
    form.append('image', new Blob([input.image], { type: input.mimeType }), 'pattern');
    const response = await this.fetchWithTimeout(
      '/pattern-grid/analyze',
      { method: 'POST', body: form },
      this.recognizeTimeoutMs,
      'recognize',
    );
    if (!response.ok)
      throw new PatternCardUploadError(`主网格分析服务失败（${response.status}）。`);
    const payload = (await response.json()) as {
      status: 'needs_review';
      grid_detected: boolean;
      row_count: number | null;
      column_count: number | null;
      occupied_count: number;
      empty_count: number;
      uncertain_count: number;
      cells: readonly {
        row: number;
        column: number;
        state: PatternGridAnalysisResult['cells'][number]['state'];
        reason: string;
        cluster_id: number | null;
      }[];
      color_clusters: readonly {
        cluster_id: number;
        cell_count: number;
        median_lab: { lightness: number; a: number; b: number };
        empty_reference_distance: number;
      }[];
      reasons: readonly string[];
      requires_user_confirmation: true;
      inventory_mutated: false;
    };
    return {
      status: payload.status,
      gridDetected: payload.grid_detected,
      ...(payload.row_count === null ? {} : { rowCount: payload.row_count }),
      ...(payload.column_count === null ? {} : { columnCount: payload.column_count }),
      occupiedCount: payload.occupied_count,
      emptyCount: payload.empty_count,
      uncertainCount: payload.uncertain_count,
      cells: payload.cells.map((cell) => ({
        row: cell.row,
        column: cell.column,
        state: cell.state,
        reason: cell.reason,
        ...(cell.cluster_id === null ? {} : { clusterId: cell.cluster_id }),
      })),
      colorClusters: payload.color_clusters.map((cluster) => ({
        clusterId: cluster.cluster_id,
        cellCount: cluster.cell_count,
        medianLab: cluster.median_lab,
        emptyReferenceDistance: cluster.empty_reference_distance,
      })),
      reasons: payload.reasons,
      requiresUserConfirmation: payload.requires_user_confirmation,
      inventoryMutated: payload.inventory_mutated,
    };
  }

  async detectCrop(
    input: Parameters<PatternLegendClient['detectCrop']>[0],
  ): Promise<PatternLegendCropSuggestion> {
    const form = new FormData();
    form.append('image', new Blob([input.image], { type: input.mimeType }), 'pattern');
    const response = await this.fetchWithTimeout(
      '/pattern-legend/detect-crop',
      { method: 'POST', body: form },
      this.cropTimeoutMs,
      'crop',
    );
    if (!response.ok)
      throw new PatternCardUploadError(`统计栏定位服务失败（${response.status}）。`);
    const payload = (await response.json()) as {
      crop_y_start: number;
      crop_y_end: number;
      confidence: number;
      method: PatternLegendCropSuggestion['method'];
      needs_manual_review: boolean;
      evidence_box_count: number;
    };
    return {
      cropYStart: payload.crop_y_start,
      cropYEnd: payload.crop_y_end,
      confidence: payload.confidence,
      method: payload.method,
      needsManualReview: payload.needs_manual_review,
      evidenceBoxCount: payload.evidence_box_count,
    };
  }

  async recognize(input: Parameters<PatternLegendClient['recognize']>[0]) {
    const form = new FormData();
    form.append('image', new Blob([input.image], { type: input.mimeType }), 'pattern');
    form.append('crop_y_start', String(input.cropYStart));
    form.append('crop_y_end', String(input.cropYEnd));
    if (input.declaredTotal !== undefined) {
      form.append('declared_total', String(input.declaredTotal));
    }
    const response = await this.fetchWithTimeout(
      '/pattern-legend/recognize',
      { method: 'POST', body: form },
      this.recognizeTimeoutMs,
      'recognize',
    );
    if (!response.ok) throw new PatternCardUploadError(`OCR 服务失败（${response.status}）。`);
    return (await response.json()) as LegendRecognitionPayload;
  }
}

type CreatePatternCardPayload = PatternMaterialReviewDraft & {
  name: string;
  sourceImagePath: string;
  sourceMimeType: PatternCardUploadResult['sourceMimeType'];
  deduplicated: boolean;
};

type PatternCardRow = {
  id: string;
  name: string;
  status: 'draft' | 'confirmed';
  declared_total: number | null;
  recognized_total: number;
  material_version: number;
  review_conflicts: unknown[];
  updated_at: string;
  pattern_assets: {
    source_image_path: string;
    source_mime_type: PatternCardListItem['sourceMimeType'];
    source_deleted_at: string | null;
  };
  pattern_material_draft_items: readonly { id: string; review_state: string }[];
};

export class SupabasePatternCardUploadRepository implements PatternCardUploadRepository {
  constructor(
    private readonly url: string,
    private readonly publishableKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private headers(accessToken: string): Record<string, string> {
    return { apikey: this.publishableKey, authorization: `Bearer ${accessToken}` };
  }

  private async userId(accessToken: string): Promise<string> {
    const response = await this.fetcher(`${this.url}/auth/v1/user`, {
      headers: this.headers(accessToken),
    });
    const payload = (await response.json()) as { id?: string; message?: string };
    if (!response.ok || !payload.id) throw new PatternCardUploadError(payload.message);
    return payload.id;
  }

  private async signedUrl(path: string, accessToken: string): Promise<string> {
    const signed = await this.fetcher(`${this.url}/storage/v1/object/sign/pattern-images/${path}`, {
      method: 'POST',
      headers: { ...this.headers(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: 600 }),
    });
    const payload = (await signed.json()) as { signedURL?: string; message?: string };
    if (!signed.ok || !payload.signedURL) throw new PatternCardUploadError(payload.message);
    return `${this.url}/storage/v1${payload.signedURL}`;
  }

  async list(accessToken: string): Promise<PatternCardListResult> {
    const select = [
      'id',
      'name',
      'status',
      'declared_total',
      'recognized_total',
      'material_version',
      'review_conflicts',
      'updated_at',
      'pattern_assets!inner(source_image_path,source_mime_type,source_deleted_at)',
      'pattern_material_draft_items(id,review_state)',
    ].join(',');
    const query = new URLSearchParams({ select, status: 'neq.archived', order: 'updated_at.desc' });
    const response = await this.fetcher(`${this.url}/rest/v1/pattern_cards?${query}`, {
      headers: this.headers(accessToken),
    });
    const payload = (await response.json()) as PatternCardRow[] | { message?: string };
    if (!response.ok || !Array.isArray(payload)) {
      throw new PatternCardUploadError((payload as { message?: string }).message);
    }
    return {
      items: await Promise.all(
        payload.map(async (row) => {
          const source = row.pattern_assets.source_deleted_at
            ? { sourceDeletedAt: new Date(row.pattern_assets.source_deleted_at).toISOString() }
            : {
                sourceImageUrl: await this.signedUrl(
                  row.pattern_assets.source_image_path,
                  accessToken,
                ),
              };
          return {
            patternCardId: row.id,
            name: row.name,
            sourceMimeType: row.pattern_assets.source_mime_type,
            ...source,
            status: row.status === 'confirmed' ? 'confirmed' : 'needs_review',
            ...(row.declared_total === null ? {} : { declaredTotal: row.declared_total }),
            recognizedTotal: row.recognized_total,
            colorCount: row.pattern_material_draft_items.length,
            pendingItemCount: row.pattern_material_draft_items.filter(
              (item) => item.review_state === 'pending',
            ).length,
            conflictCount: row.review_conflicts.length,
            materialVersion: row.material_version,
            updatedAt: new Date(row.updated_at).toISOString(),
          } satisfies PatternCardListItem;
        }),
      ),
    };
  }

  async getSource(patternCardId: string, accessToken: string): Promise<PatternCardSource> {
    const response = await this.fetcher(`${this.url}/rest/v1/rpc/get_pattern_card_source`, {
      method: 'POST',
      headers: { ...this.headers(accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({ p_pattern_card_id: patternCardId }),
    });
    const payload = (await response.json()) as
      | {
          patternCardId: string;
          name: string;
          sourceImagePath: string;
          sourceMimeType: PatternCardSource['sourceMimeType'];
          sourceDeletedAt?: string;
        }
      | { message?: string };
    if (!response.ok || !('patternCardId' in payload)) {
      throw new PatternCardUploadError((payload as { message?: string }).message);
    }
    const common = {
      patternCardId: payload.patternCardId,
      name: payload.name,
      sourceMimeType: payload.sourceMimeType,
    };
    return payload.sourceDeletedAt
      ? { ...common, sourceDeletedAt: new Date(payload.sourceDeletedAt).toISOString() }
      : {
          ...common,
          sourceImageUrl: await this.signedUrl(payload.sourceImagePath, accessToken),
        };
  }

  async deleteSource(
    patternCardId: string,
    accessToken: string,
  ): Promise<PatternCardSourceDeletionResult> {
    const prepare = await this.fetcher(
      `${this.url}/rest/v1/rpc/prepare_pattern_card_source_deletion`,
      {
        method: 'POST',
        headers: { ...this.headers(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ p_pattern_card_id: patternCardId }),
      },
    );
    const prepared = (await prepare.json()) as
      | { patternCardId: string; sourceImagePath: string; sourceDeletedAt?: string }
      | { message?: string };
    if (!prepare.ok || !('patternCardId' in prepared)) {
      throw new PatternCardUploadError((prepared as { message?: string }).message);
    }
    if (prepared.sourceDeletedAt) {
      return {
        patternCardId: prepared.patternCardId,
        sourceDeletedAt: new Date(prepared.sourceDeletedAt).toISOString(),
        alreadyDeleted: true,
      };
    }

    const storageDelete = await this.fetcher(
      `${this.url}/storage/v1/object/pattern-images/${prepared.sourceImagePath}`,
      { method: 'DELETE', headers: this.headers(accessToken) },
    );
    if (!storageDelete.ok && storageDelete.status !== 404) {
      throw new PatternCardUploadError('私有存储中的原图删除失败。');
    }

    const complete = await this.fetcher(
      `${this.url}/rest/v1/rpc/complete_pattern_card_source_deletion`,
      {
        method: 'POST',
        headers: { ...this.headers(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ p_pattern_card_id: patternCardId }),
      },
    );
    const completed = (await complete.json()) as
      { patternCardId: string; sourceDeletedAt: string } | { message?: string };
    if (!complete.ok || !('patternCardId' in completed)) {
      throw new PatternCardUploadError((completed as { message?: string }).message);
    }
    return {
      patternCardId: completed.patternCardId,
      sourceDeletedAt: new Date(completed.sourceDeletedAt).toISOString(),
      alreadyDeleted: false,
    };
  }

  async create(input: CreatePatternCardInput): Promise<PatternCardUploadResult> {
    const userId = await this.userId(input.accessToken);
    const path = `${userId}/patterns/${input.sha256}/source`;
    const upload = await this.fetcher(`${this.url}/storage/v1/object/pattern-images/${path}`, {
      method: 'POST',
      headers: {
        ...this.headers(input.accessToken),
        'content-type': input.mimeType,
        'x-upsert': 'true',
      },
      body: input.image,
    });
    if (!upload.ok) throw new PatternCardUploadError('图纸原图上传失败。');

    const response = await this.fetcher(`${this.url}/rest/v1/rpc/create_pattern_card_from_ocr`, {
      method: 'POST',
      headers: { ...this.headers(input.accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        p_source_image_path: path,
        p_source_mime_type: input.mimeType,
        p_sha256: input.sha256,
        p_name: input.name,
        p_declared_total: input.declaredTotal ?? null,
        p_conflicts: input.conflicts,
        p_items: input.items,
      }),
    });
    const payload = (await response.json()) as CreatePatternCardPayload | { message?: string };
    if (!response.ok || !('patternCardId' in payload)) {
      throw new PatternCardUploadError((payload as { message?: string }).message);
    }

    const restore = await this.fetcher(`${this.url}/rest/v1/rpc/restore_pattern_card_source`, {
      method: 'POST',
      headers: { ...this.headers(input.accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        p_pattern_card_id: payload.patternCardId,
        p_source_image_path: payload.sourceImagePath,
      }),
    });
    if (!restore.ok) throw new PatternCardUploadError('原图恢复状态写入失败。');

    return {
      patternCardId: payload.patternCardId,
      name: payload.name,
      sourceImageUrl: await this.signedUrl(payload.sourceImagePath, input.accessToken),
      sourceMimeType: payload.sourceMimeType,
      deduplicated: payload.deduplicated,
      review: {
        patternCardId: payload.patternCardId,
        revision: payload.revision,
        status: payload.status,
        ...(payload.declaredTotal === undefined ? {} : { declaredTotal: payload.declaredTotal }),
        recognizedTotal: payload.recognizedTotal,
        conflicts: payload.conflicts,
        items: payload.items,
        updatedAt: new Date(payload.updatedAt).toISOString(),
      },
    };
  }
}
