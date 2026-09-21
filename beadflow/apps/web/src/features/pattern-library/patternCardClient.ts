import type {
  CombinedPatternCardPurchaseListResult,
  PatternCardConsumption,
  PatternCardConsumptionHistoryResult,
  PatternCardInventoryCheckResult,
  PatternCardListResult,
  PatternLegendCropSuggestion,
  PatternCardPurchaseListResult,
  PatternCardRecommendationResult,
  PatternCardRecommendationMode,
  PatternCardRecommendationFilter,
  PatternCardReservation,
  PatternCardSource,
  PatternCardSourceDeletionResult,
  PatternCardUploadResult,
  PatternMaterialDraftItem,
  PatternMaterialReviewDraft,
  PatternMaterialVersion,
} from '@beadflow/shared-types';

type ApiErrorPayload = { error?: { code?: string; message?: string } };

export class PatternCardApiError extends Error {
  constructor(
    message: string,
    readonly code = 'PATTERN_CARD_REQUEST_FAILED',
  ) {
    super(message);
    this.name = 'PatternCardApiError';
  }
}

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
  const payload = (await response.json()) as T | ApiErrorPayload;
  if (!response.ok) {
    const apiError = payload as ApiErrorPayload;
    throw new PatternCardApiError(apiError.error?.message ?? fallback, apiError.error?.code);
  }
  return payload as T;
}

export async function savePatternCardFromClusters(
  input: {
    file: File;
    name: string;
    occupiedCount: number;
    declaredTotal?: number;
    items: readonly { paletteColorId: string; quantity: number }[];
    accessToken: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<PatternCardUploadResult> {
  const imageBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? '');
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.onerror = () => reject(new PatternCardApiError('图纸读取失败，没有修改库存。'));
    reader.readAsDataURL(input.file);
  });
  return parseResponse(
    await fetcher('/api/pattern-cards/from-clusters', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: input.name,
        mimeType: input.file.type,
        imageBase64,
        occupiedCount: input.occupiedCount,
        ...(input.declaredTotal === undefined ? {} : { declaredTotal: input.declaredTotal }),
        items: input.items,
      }),
    }),
    '图纸资料保存失败，没有修改库存。',
  );
}

export async function importPatternCard(
  input: {
    file: File;
    name: string;
    cropYStart: number;
    cropYEnd: number;
    declaredTotal?: number;
    accessToken: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<PatternCardUploadResult> {
  const query = new URLSearchParams({
    name: input.name,
    cropYStart: String(input.cropYStart),
    cropYEnd: String(input.cropYEnd),
  });
  if (input.declaredTotal !== undefined) query.set('declaredTotal', String(input.declaredTotal));
  const response = await fetcher(`/api/pattern-cards/import?${query}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': input.file.type,
    },
    body: input.file,
  });
  return parseResponse(response, '图纸上传或 OCR 失败。');
}

export async function detectPatternLegendCrop(
  file: File,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternLegendCropSuggestion> {
  return parseResponse(
    await fetcher('/api/pattern-cards/detect-legend-crop', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': file.type,
      },
      body: file,
    }),
    '自动定位统计栏失败，可手动调整范围后继续。',
  );
}

export async function listPatternCards(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardListResult> {
  return parseResponse(
    await fetcher('/api/pattern-cards', {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '无法读取图纸库。',
  );
}

export async function loadPatternCardRecommendations(
  accessToken: string,
  mode: PatternCardRecommendationMode = 'ready',
  limit = 10,
  filter: PatternCardRecommendationFilter = {},
  fetcher: typeof fetch = fetch,
): Promise<PatternCardRecommendationResult> {
  const query = new URLSearchParams({ limit: String(limit), mode });
  if (filter.minTotalBeads !== undefined) query.set('minTotalBeads', String(filter.minTotalBeads));
  if (filter.maxTotalBeads !== undefined) query.set('maxTotalBeads', String(filter.maxTotalBeads));
  return parseResponse(
    await fetcher(`/api/pattern-card-recommendations?${query}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '无法根据库存生成图纸推荐。',
  );
}

export async function loadCombinedPatternCardPurchaseList(
  patternCardIds: readonly string[],
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<CombinedPatternCardPurchaseListResult> {
  return parseResponse(
    await fetcher('/api/pattern-cards/combined-purchase-list', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ patternCardIds }),
    }),
    '多图补豆清单生成失败，没有修改库存。',
  );
}

export async function loadPatternCardReview(
  patternCardId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternMaterialReviewDraft> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(patternCardId)}/review`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '无法读取图纸复核草稿。',
  );
}

export async function loadPatternCardSource(
  patternCardId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardSource> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(patternCardId)}/source`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '无法读取图纸原图。',
  );
}

export async function deletePatternCardSource(
  patternCardId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardSourceDeletionResult> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(patternCardId)}/source`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '原图删除失败，资料卡和库存数据均未改动。',
  );
}

export async function savePatternCardReview(
  input: {
    patternCardId: string;
    expectedRevision: number;
    declaredTotal?: number;
    conflicts: readonly string[];
    items: readonly PatternMaterialDraftItem[];
    accessToken: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<PatternMaterialReviewDraft> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(input.patternCardId)}/review`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: input.expectedRevision,
        ...(input.declaredTotal === undefined ? {} : { declaredTotal: input.declaredTotal }),
        conflicts: input.conflicts,
        items: input.items,
      }),
    }),
    '复核草稿保存失败，本地修改仍保留。',
  );
}

export async function confirmPatternCardReview(
  input: {
    patternCardId: string;
    expectedRevision: number;
    acceptDeclaredTotalMismatch: boolean;
    accessToken: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<PatternMaterialVersion> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(input.patternCardId)}/review/confirm`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expectedRevision: input.expectedRevision,
        acceptDeclaredTotalMismatch: input.acceptDeclaredTotalMismatch,
      }),
    }),
    '正式材料确认失败，草稿仍然保留。',
  );
}

export async function checkPatternCardInventory(
  patternCardId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardInventoryCheckResult> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(patternCardId)}/inventory-check`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '库存对比失败，没有修改库存。',
  );
}

export async function loadPatternCardPurchaseList(
  patternCardId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardPurchaseListResult> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(patternCardId)}/purchase-list`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '补豆清单生成失败，没有修改库存。',
  );
}

export async function loadLatestPatternCardConsumption(
  patternCardId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardConsumption | null> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(patternCardId)}/consumption/latest`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '无法读取最近制作记录。',
  );
}

export async function loadActivePatternCardReservation(
  patternCardId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardReservation | null> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(patternCardId)}/reservation`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '无法读取待做预留。',
  );
}

export async function reservePatternCardInventory(
  input: { patternCardId: string; idempotencyKey: string; accessToken: string },
  fetcher: typeof fetch = fetch,
): Promise<PatternCardReservation> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(input.patternCardId)}/reserve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ idempotencyKey: input.idempotencyKey }),
    }),
    '加入待做失败，实际库存没有改变。',
  );
}

export async function releasePatternCardReservation(
  reservationId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardReservation> {
  return parseResponse(
    await fetcher(`/api/pattern-card-reservations/${encodeURIComponent(reservationId)}/release`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '取消待做失败，预留仍然保留。',
  );
}

export async function loadPatternCardConsumptionHistory(
  accessToken: string,
  limit = 20,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardConsumptionHistoryResult> {
  return parseResponse(
    await fetcher(`/api/pattern-card-consumptions?limit=${limit}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '无法读取制作与库存变动历史。',
  );
}

export async function consumePatternCardInventory(
  input: { patternCardId: string; idempotencyKey: string; accessToken: string },
  fetcher: typeof fetch = fetch,
): Promise<PatternCardConsumption> {
  return parseResponse(
    await fetcher(`/api/pattern-cards/${encodeURIComponent(input.patternCardId)}/consume`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ idempotencyKey: input.idempotencyKey }),
    }),
    '库存扣减失败，没有进行部分扣减。',
  );
}

export async function undoPatternCardConsumption(
  consumptionId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternCardConsumption> {
  return parseResponse(
    await fetcher(`/api/pattern-card-consumptions/${encodeURIComponent(consumptionId)}/undo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    '撤销失败，库存没有进行部分恢复。',
  );
}
