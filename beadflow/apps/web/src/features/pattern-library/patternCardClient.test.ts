import type { PatternCardUploadResult, PatternMaterialReviewDraft } from '@beadflow/shared-types';
import { describe, expect, test, vi } from 'vitest';

import {
  consumePatternCardInventory,
  deletePatternCardSource,
  detectPatternLegendCrop,
  importPatternCard,
  listPatternCards,
  loadCombinedPatternCardPurchaseList,
  loadPatternCardPurchaseList,
  loadPatternCardConsumptionHistory,
  loadPatternCardRecommendations,
  loadActivePatternCardReservation,
  releasePatternCardReservation,
  reservePatternCardInventory,
  savePatternCardReview,
  undoPatternCardConsumption,
} from './patternCardClient';
import type { PatternCardApiError } from './patternCardClient';

const cardId = 'c972bbec-bea3-49bf-b6c6-dae04b8146d1';
const review: PatternMaterialReviewDraft = {
  patternCardId: cardId,
  revision: 0,
  status: 'needs_review',
  declaredTotal: 303,
  recognizedTotal: 303,
  conflicts: [],
  items: [],
  updatedAt: '2026-07-22T07:00:00.000Z',
};
const uploadResult: PatternCardUploadResult = {
  patternCardId: cardId,
  name: '冰面包',
  sourceImageUrl: 'https://storage.example/signed',
  sourceMimeType: 'image/jpeg',
  deduplicated: false,
  review,
};

describe('pattern card client', () => {
  test('requests a read-only automatic crop suggestion before OCR import', async () => {
    const suggestion = {
      cropYStart: 0.78,
      cropYEnd: 0.87,
      confidence: 0.91,
      method: 'color_bar_rows' as const,
      needsManualReview: false,
      evidenceBoxCount: 12,
    };
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(suggestion), { status: 200 }),
    );
    const file = new File([new Uint8Array(3_200_000)], 'pattern.jpg', {
      type: 'image/jpeg',
    });

    await expect(detectPatternLegendCrop(file, 'user-token', fetcher)).resolves.toEqual(suggestion);
    expect(fetcher).toHaveBeenCalledWith('/api/pattern-cards/detect-legend-crop', {
      method: 'POST',
      headers: { authorization: 'Bearer user-token', 'content-type': 'image/jpeg' },
      body: file,
    });
  });

  test('uploads raw image bytes with encoded name, crop and declared total', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(uploadResult), { status: 201 }),
    );
    const file = new File([new Uint8Array(3_200_000)], 'pattern.jpg', { type: 'image/jpeg' });

    await expect(
      importPatternCard(
        {
          file,
          name: '冰面包 & 镜像',
          cropYStart: 0.73,
          cropYEnd: 0.96,
          declaredTotal: 303,
          accessToken: 'user-token',
        },
        fetcher,
      ),
    ).resolves.toMatchObject({ patternCardId: cardId });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain('/api/pattern-cards/import?');
    expect(String(url)).toContain('name=%E5%86%B0%E9%9D%A2%E5%8C%85+%26+%E9%95%9C%E5%83%8F');
    expect(String(url)).toContain('cropYStart=0.73');
    expect(init).toMatchObject({
      method: 'POST',
      body: file,
      headers: { authorization: 'Bearer user-token', 'content-type': 'image/jpeg' },
    });
  });

  test('preserves the server revision-conflict message for safe UI recovery', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'REVISION_CONFLICT', message: '草稿已在其他设备更新。' },
          }),
          { status: 409 },
        ),
    );

    await expect(
      savePatternCardReview(
        {
          patternCardId: cardId,
          expectedRevision: 0,
          declaredTotal: 303,
          conflicts: [],
          items: [],
          accessToken: 'user-token',
        },
        fetcher,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PatternCardApiError>>({
        code: 'REVISION_CONFLICT',
        message: '草稿已在其他设备更新。',
      }),
    );
  });

  test('uses an explicit DELETE request for the private source image only', async () => {
    const payload = {
      patternCardId: cardId,
      sourceDeletedAt: '2026-07-22T12:00:00.000Z',
      alreadyDeleted: false,
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));

    await expect(deletePatternCardSource(cardId, 'token', fetcher)).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(`/api/pattern-cards/${cardId}/source`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer token' },
    });
  });

  test('loads the owned library and explainable recommendations with GET only', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mode: 'use_stockpile', items: [], evaluatedCount: 0 })),
      );

    await expect(listPatternCards('token', fetcher)).resolves.toEqual({ items: [] });
    await expect(
      loadPatternCardRecommendations('token', 'use_stockpile', 8, {}, fetcher),
    ).resolves.toEqual({
      mode: 'use_stockpile',
      items: [],
      evaluatedCount: 0,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/pattern-cards',
      expect.objectContaining({ headers: { authorization: 'Bearer token' } }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/pattern-card-recommendations?limit=8&mode=use_stockpile',
      expect.objectContaining({ headers: { authorization: 'Bearer token' } }),
    );
    expect(fetcher.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });

  test('sends an explicit total-bead range before recommendation ranking', async () => {
    const payload = { mode: 'least_shortage', items: [], evaluatedCount: 8 };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));

    await expect(
      loadPatternCardRecommendations(
        'token',
        'least_shortage',
        10,
        { minTotalBeads: 501, maxTotalBeads: 1500 },
        fetcher,
      ),
    ).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/pattern-card-recommendations?limit=10&mode=least_shortage&minTotalBeads=501&maxTotalBeads=1500',
      expect.objectContaining({ headers: { authorization: 'Bearer token' } }),
    );
  });

  test('loads a card purchase list without sending a write request', async () => {
    const payload = {
      patternCard: {
        patternCardId: cardId,
        materialVersion: 1,
        totalBeads: 2136,
        colorCount: 6,
        confirmedAt: '2026-07-22T09:00:00.000Z',
      },
      balances: [],
      totals: { required: 2136, shortage: 480, colorsReady: 2, colorsShort: 4 },
      hasEstimatedInventory: true,
      items: [],
      groups: [],
      copyText: 'BeadFlow MARD 补豆清单',
      csv: '\uFEFF色号,缺少数量',
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));

    await expect(loadPatternCardPurchaseList(cardId, 'token', fetcher)).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/pattern-cards/${cardId}/purchase-list`,
      expect.objectContaining({ headers: { authorization: 'Bearer token' } }),
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  test('posts an explicit multi-card selection to the read-only combined calculator', async () => {
    const ids = [cardId, '75a581b4-949c-4f15-95e5-6b2fdf86c6ee'];
    const payload = {
      patternCards: [],
      balances: [],
      totals: { patternCards: 2, required: 1_221, shortage: 96, colorsReady: 7, colorsShort: 2 },
      hasEstimatedInventory: false,
      items: [],
      groups: [],
      copyText: 'BeadFlow 多图合并补豆清单',
      csv: '\uFEFFMARD色号,缺少数量',
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));

    await expect(loadCombinedPatternCardPurchaseList(ids, 'token', fetcher)).resolves.toEqual(
      payload,
    );
    expect(fetcher).toHaveBeenCalledWith(
      '/api/pattern-cards/combined-purchase-list',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ patternCardIds: ids }),
      }),
    );
  });

  test('reuses the caller-provided operation key and exposes explicit undo', async () => {
    const consumption = {
      id: '40000000-0000-4000-8000-000000000001',
      patternCardId: cardId,
      materialVersion: 1,
      idempotencyKey: '50000000-0000-4000-8000-000000000001',
      status: 'applied',
      totalQuantity: 2136,
      items: [
        { paletteColorId: 'mard-b14', quantity: 526, balanceAfter: 3474 },
        { paletteColorId: 'mard-c6', quantity: 617, balanceAfter: 1383 },
      ],
      createdAt: '2026-07-22T09:00:00.000Z',
      undoExpiresAt: '2026-07-22T09:10:00.000Z',
      undoAvailable: true,
    } as const;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(consumption)));

    await consumePatternCardInventory(
      { patternCardId: cardId, idempotencyKey: consumption.idempotencyKey, accessToken: 'token' },
      fetcher,
    );
    await undoPatternCardConsumption(consumption.id, 'token', fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      `/api/pattern-cards/${cardId}/consume`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: consumption.idempotencyKey }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/api/pattern-card-consumptions/${consumption.id}/undo`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('loads, creates and releases a待做 reservation with explicit operation identity', async () => {
    const reservation = {
      id: '60000000-0000-4000-8000-000000000001',
      patternCardId: cardId,
      materialVersion: 1,
      idempotencyKey: '70000000-0000-4000-8000-000000000001',
      status: 'active',
      totalQuantity: 2_136,
      items: [{ paletteColorId: 'mard-b14', quantity: 526 }],
      createdAt: '2026-07-22T09:00:00.000Z',
    } as const;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(reservation)));

    await loadActivePatternCardReservation(cardId, 'token', fetcher);
    await reservePatternCardInventory(
      { patternCardId: cardId, idempotencyKey: reservation.idempotencyKey, accessToken: 'token' },
      fetcher,
    );
    await releasePatternCardReservation(reservation.id, 'token', fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      `/api/pattern-cards/${cardId}/reservation`,
      expect.objectContaining({ headers: { authorization: 'Bearer token' } }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/api/pattern-cards/${cardId}/reserve`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: reservation.idempotencyKey }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      `/api/pattern-card-reservations/${reservation.id}/release`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('loads grouped production history with a bounded read-only request', async () => {
    const payload = { items: [] };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));

    await expect(loadPatternCardConsumptionHistory('token', 20, fetcher)).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/pattern-card-consumptions?limit=20',
      expect.objectContaining({ headers: { authorization: 'Bearer token' } }),
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
  });
});
