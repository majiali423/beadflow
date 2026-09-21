import { parsePalette } from '@beadflow/palette-engine';
import type {
  InventoryItem,
  PatternCardConsumption,
  PatternCardMaterialCandidate,
  PatternCardReservation,
  PatternMaterialDraftItem,
  PatternMaterialReviewDraft,
  PatternMaterialVersion,
} from '@beadflow/shared-types';
import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from './app.js';
import type { InventoryMutationResult, InventoryRepository } from './inventory.js';
import {
  PatternMaterialNotReadyError,
  PatternMaterialReviewError,
  PatternMaterialRevisionConflictError,
  PatternReservationError,
  SupabasePatternCardReviewRepository,
  type PatternCardReviewRepository,
} from './patternCardReviews.js';

const cardId = 'c972bbec-bea3-49bf-b6c6-dae04b8146d1';
const palette = parsePalette(
  readFileSync(new URL('../../../assets/palettes/mard221.json', import.meta.url), 'utf8'),
  221,
).palette;
const testColors = palette.colors.slice(0, 21);
const paletteIds = testColors.map((color) => color.id);

const items: PatternMaterialDraftItem[] = paletteIds.map((paletteColorId, index) => ({
  id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  paletteColorId,
  quantity: index === 0 ? 299 : index + 3,
  rawText: index === 0 ? 'F11299' : `MARD ${index + 1}`,
  confidence: index === 0 ? 0.82 : 0.96,
  evidenceRegion: { x: index * 48, y: 1280, width: 44, height: 32 },
  recognitionSource: index === 0 ? 'compact' : 'spatial',
  reviewState: index % 3 === 0 ? 'edited' : 'confirmed',
}));

const recommendationCandidates: readonly PatternCardMaterialCandidate[] = [
  {
    patternCardId: cardId,
    name: '库存充足的双色图纸',
    materialVersion: 2,
    totalBeads: 100,
    confirmedAt: '2026-07-22T05:00:00.000Z',
    items: [
      { paletteColorId: paletteIds[0]!, quantity: 50 },
      { paletteColorId: paletteIds[1]!, quantity: 50 },
    ],
  },
  {
    patternCardId: '75a581b4-949c-4f15-95e5-6b2fdf86c6ee',
    name: '只差少量的图纸',
    materialVersion: 1,
    totalBeads: 140,
    confirmedAt: '2026-07-22T05:00:00.000Z',
    items: [{ paletteColorId: paletteIds[0]!, quantity: 140 }],
  },
  {
    patternCardId: '6807a274-9e1f-4784-9eb9-9bf47718f4f8',
    name: '缺少多个颜色的大图',
    materialVersion: 1,
    totalBeads: 900,
    confirmedAt: '2026-07-22T05:00:00.000Z',
    items: [
      { paletteColorId: paletteIds[18]!, quantity: 300 },
      { paletteColorId: paletteIds[19]!, quantity: 300 },
      { paletteColorId: paletteIds[20]!, quantity: 300 },
    ],
  },
];

function draft(overrides: Partial<PatternMaterialReviewDraft> = {}): PatternMaterialReviewDraft {
  return {
    patternCardId: cardId,
    revision: 4,
    status: 'needs_review',
    declaredTotal: items.reduce((total, item) => total + item.quantity, 0),
    recognizedTotal: items.reduce((total, item) => total + item.quantity, 0),
    conflicts: [],
    items,
    updatedAt: '2026-07-22T03:00:00.000Z',
    ...overrides,
  };
}

class RecordingReviewRepository implements PatternCardReviewRepository {
  readonly getDraft = vi.fn(async () => draft());
  readonly saveDraft = vi.fn(async () => draft({ revision: 5 }));
  readonly confirmDraft = vi.fn(async (): Promise<PatternMaterialVersion> => ({
    id: '30000000-0000-4000-8000-000000000001',
    patternCardId: cardId,
    version: 1,
    totalQuantity: draft().recognizedTotal,
    items: items.map((item) => ({
      id: item.id,
      paletteColorId: item.paletteColorId,
      quantity: item.quantity,
      rawText: item.rawText,
      confidence: item.confidence,
      evidenceRegion: item.evidenceRegion,
      recognitionSource: item.recognitionSource,
    })),
    confirmedAt: '2026-07-22T03:05:00.000Z',
  }));
  readonly getLatestVersion = vi.fn(async () => this.confirmDraft());
  readonly listConfirmedMaterials = vi.fn(async () => recommendationCandidates);
  readonly reservation: PatternCardReservation = {
    id: '60000000-0000-4000-8000-000000000001',
    patternCardId: cardId,
    materialVersion: 2,
    idempotencyKey: '70000000-0000-4000-8000-000000000001',
    status: 'active',
    totalQuantity: 2_136,
    items: [
      { paletteColorId: paletteIds[0]!, quantity: 526 },
      { paletteColorId: paletteIds[1]!, quantity: 617 },
      { paletteColorId: paletteIds[2]!, quantity: 424 },
      { paletteColorId: paletteIds[3]!, quantity: 250 },
      { paletteColorId: paletteIds[4]!, quantity: 200 },
      { paletteColorId: paletteIds[5]!, quantity: 119 },
    ],
    createdAt: '2026-07-22T08:00:00.000Z',
  };
  readonly listActiveReservations = vi.fn(
    async (): Promise<readonly PatternCardReservation[]> => [],
  );
  readonly getActiveReservation = vi.fn(async () => this.reservation);
  readonly reserveInventory = vi.fn(async () => this.reservation);
  readonly releaseReservation = vi.fn(async () => ({
    ...this.reservation,
    status: 'released' as const,
    releasedAt: '2026-07-22T08:05:00.000Z',
  }));
  readonly consumption: PatternCardConsumption = {
    id: '40000000-0000-4000-8000-000000000001',
    patternCardId: cardId,
    materialVersion: 2,
    idempotencyKey: '50000000-0000-4000-8000-000000000001',
    status: 'applied',
    totalQuantity: 2_136,
    items: [
      { paletteColorId: paletteIds[0]!, quantity: 526, balanceAfter: 3_474 },
      { paletteColorId: paletteIds[1]!, quantity: 617, balanceAfter: 1_383 },
      { paletteColorId: paletteIds[2]!, quantity: 424, balanceAfter: 1_576 },
      { paletteColorId: paletteIds[3]!, quantity: 250, balanceAfter: 1_750 },
      { paletteColorId: paletteIds[4]!, quantity: 200, balanceAfter: 1_800 },
      { paletteColorId: paletteIds[5]!, quantity: 119, balanceAfter: 1_881 },
    ],
    createdAt: '2026-07-22T09:00:00.000Z',
    undoExpiresAt: '2026-07-22T09:10:00.000Z',
    undoAvailable: true,
  };
  readonly consumeInventory = vi.fn(async () => this.consumption);
  readonly undoConsumption = vi.fn(async () => ({
    ...this.consumption,
    status: 'reverted' as const,
    revertedAt: '2026-07-22T09:03:00.000Z',
    undoAvailable: false,
  }));
  readonly getLatestConsumption = vi.fn(async () => this.consumption);
  readonly listConsumptionHistory = vi.fn(async () => [
    { ...this.consumption, patternCardName: '复杂大尺寸图纸验收' },
    {
      ...this.consumption,
      id: '40000000-0000-4000-8000-000000000002',
      status: 'reverted' as const,
      patternCardName: '已撤销的图纸',
      revertedAt: '2026-07-22T09:04:00.000Z',
      undoAvailable: false,
    },
  ]);
}

const inventory: readonly InventoryItem[] = testColors.slice(0, 18).map((color, index) => ({
  id: `inventory-${index}`,
  userId: 'user-1',
  paletteColorId: color.id,
  quantity: index === 0 ? 120 : index % 4 === 0 ? 3 : 2_000,
  quantityConfidence: index === 4 ? 'estimated' : 'exact',
  updatedAt: '2026-07-22T04:00:00.000Z',
}));

class RecordingInventoryRepository implements InventoryRepository {
  readonly list = vi.fn(async () => inventory);
  readonly listTransactions = vi.fn(async () => []);
  readonly listReservations = vi.fn(async () => []);
  readonly applyTransaction = vi.fn(async (): Promise<InventoryMutationResult> => {
    throw new Error('not used');
  });
  readonly setItem = vi.fn(async (): Promise<InventoryMutationResult> => {
    throw new Error('not used');
  });
  readonly setItems = vi.fn(async () => []);
}

function reviewApp(
  repository: PatternCardReviewRepository,
  inventoryRepository: InventoryRepository = new RecordingInventoryRepository(),
) {
  return buildApp({
    patternCardReviews: {
      validPaletteColorIds: new Set(paletteIds),
      paletteColors: palette.colors,
      inventoryRepository,
      repository,
    },
  });
}

describe('pattern material review API', () => {
  test('saves a realistic 21-color reviewed draft without touching inventory', async () => {
    const repository = new RecordingReviewRepository();
    const response = await reviewApp(repository).inject({
      method: 'PUT',
      url: `/api/pattern-cards/${cardId}/review`,
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: {
        expectedRevision: 4,
        declaredTotal: draft().declaredTotal,
        conflicts: [],
        items,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ revision: 5, status: 'needs_review' });
    expect(repository.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        patternCardId: cardId,
        expectedRevision: 4,
        items,
        accessToken: 'signed-in-user-token',
      }),
    );
    expect(repository.confirmDraft).not.toHaveBeenCalled();
  });

  test('rejects duplicate colors before persistence instead of silently merging them', async () => {
    const repository = new RecordingReviewRepository();
    const response = await reviewApp(repository).inject({
      method: 'PUT',
      url: `/api/pattern-cards/${cardId}/review`,
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: {
        expectedRevision: 4,
        conflicts: [],
        items: [items[0], { ...items[1], paletteColorId: items[0]!.paletteColorId }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REVIEW_DRAFT');
    expect(repository.saveDraft).not.toHaveBeenCalled();
  });

  test('returns an explicit conflict when another device changed the draft', async () => {
    const repository = new RecordingReviewRepository();
    repository.saveDraft.mockRejectedValueOnce(new PatternMaterialRevisionConflictError());
    const response = await reviewApp(repository).inject({
      method: 'PUT',
      url: `/api/pattern-cards/${cardId}/review`,
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { expectedRevision: 3, conflicts: [], items },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REVISION_CONFLICT');
  });

  test('creates a formal version only through an explicit confirmation request', async () => {
    const repository = new RecordingReviewRepository();
    const response = await reviewApp(repository).inject({
      method: 'POST',
      url: `/api/pattern-cards/${cardId}/review/confirm`,
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { expectedRevision: 5, acceptDeclaredTotalMismatch: false },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ patternCardId: cardId, version: 1 });
    expect(repository.confirmDraft).toHaveBeenCalledWith({
      patternCardId: cardId,
      expectedRevision: 5,
      acceptDeclaredTotalMismatch: false,
      accessToken: 'signed-in-user-token',
    });
  });

  test('keeps an incomplete review as a draft when confirmation is refused', async () => {
    const repository = new RecordingReviewRepository();
    repository.confirmDraft.mockRejectedValueOnce(
      new PatternMaterialReviewError('仍有待确认材料，不能生成正式版本。'),
    );
    const response = await reviewApp(repository).inject({
      method: 'POST',
      url: `/api/pattern-cards/${cardId}/review/confirm`,
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { expectedRevision: 5, acceptDeclaredTotalMismatch: false },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('REVIEW_INCOMPLETE');
  });

  test('compares a confirmed 21-color sheet with real inventory without deducting stock', async () => {
    const repository = new RecordingReviewRepository();
    const inventoryRepository = new RecordingInventoryRepository();
    const response = await reviewApp(repository, inventoryRepository).inject({
      method: 'GET',
      url: `/api/pattern-cards/${cardId}/inventory-check`,
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      patternCard: { patternCardId: cardId, materialVersion: 1, colorCount: 21 },
      totals: { required: draft().recognizedTotal },
      hasEstimatedInventory: true,
    });
    expect(response.json().totals.shortage).toBeGreaterThan(0);
    expect(response.json().totals.colorsShort).toBeGreaterThanOrEqual(4);
    expect(inventoryRepository.applyTransaction).not.toHaveBeenCalled();
    expect(inventoryRepository.setItem).not.toHaveBeenCalled();
    expect(inventoryRepository.setItems).not.toHaveBeenCalled();
  });

  test('subtracts stock held by another pending card from freely available inventory', async () => {
    const repository = new RecordingReviewRepository();
    repository.listActiveReservations.mockResolvedValueOnce([
      {
        ...repository.reservation,
        id: '60000000-0000-4000-8000-000000000099',
        patternCardId: '75a581b4-949c-4f15-95e5-6b2fdf86c6ee',
        totalQuantity: 100,
        items: [{ paletteColorId: paletteIds[0]!, quantity: 100 }],
      },
    ]);
    const response = await reviewApp(repository).inject({
      method: 'GET',
      url: `/api/pattern-cards/${cardId}/inventory-check`,
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().totals.reservedElsewhere).toBe(100);
    expect(
      response
        .json()
        .balances.find((item: { paletteColorId: string }) => item.paletteColorId === paletteIds[0]),
    ).toMatchObject({
      required: 299,
      onHand: 120,
      reservedElsewhere: 100,
      freelyAvailable: 20,
      shortage: 279,
    });
  });

  test('returns a shortage-sorted purchase list from the confirmed material version', async () => {
    const repository = new RecordingReviewRepository();
    const response = await reviewApp(repository).inject({
      method: 'GET',
      url: `/api/pattern-cards/${cardId}/purchase-list`,
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.items.length).toBeGreaterThanOrEqual(4);
    expect(result.items[0].shortage).toBeGreaterThanOrEqual(result.items[1].shortage);
    expect(result.copyText).toContain('BeadFlow MARD');
    expect(result.csv).toContain('\uFEFF');
  });

  test('merges overlapping colors across three confirmed real-scale sheets before subtracting inventory', async () => {
    const repository = new RecordingReviewRepository();
    const inventoryRepository = new RecordingInventoryRepository();
    const selectedIds = recommendationCandidates.map((candidate) => candidate.patternCardId);
    const response = await reviewApp(repository, inventoryRepository).inject({
      method: 'POST',
      url: '/api/pattern-cards/combined-purchase-list',
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { patternCardIds: selectedIds },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.totals).toMatchObject({ patternCards: 3, required: 1_140, shortage: 970 });
    expect(result.patternCards.map((card: { name: string }) => card.name)).toEqual([
      '库存充足的双色图纸',
      '只差少量的图纸',
      '缺少多个颜色的大图',
    ]);
    expect(
      result.balances.find(
        (item: { paletteColorId: string }) => item.paletteColorId === paletteIds[0],
      ),
    ).toMatchObject({
      required: 190,
      available: 120,
      shortage: 70,
    });
    expect(result.items).toHaveLength(4);
    expect(result.copyText).toContain('BeadFlow 多图合并补豆清单');
    expect(result.copyText).toContain('缺少多个颜色的大图（900 颗）');
    expect(inventoryRepository.applyTransaction).not.toHaveBeenCalled();
    expect(inventoryRepository.setItems).not.toHaveBeenCalled();
  });

  test('rejects duplicate or unconfirmed multi-card selections instead of silently skipping them', async () => {
    const repository = new RecordingReviewRepository();
    const duplicate = await reviewApp(repository).inject({
      method: 'POST',
      url: '/api/pattern-cards/combined-purchase-list',
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { patternCardIds: [cardId, cardId] },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error.code).toBe('INVALID_PATTERN_CARD_SELECTION');

    const missing = await reviewApp(repository).inject({
      method: 'POST',
      url: '/api/pattern-cards/combined-purchase-list',
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { patternCardIds: [cardId, '00000000-0000-4000-8000-000000000099'] },
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe('PATTERN_CARDS_NOT_CONFIRMED');
  });

  test('refuses inventory calculation until materials are formally confirmed', async () => {
    const repository = new RecordingReviewRepository();
    repository.getLatestVersion.mockRejectedValueOnce(new PatternMaterialNotReadyError());
    const response = await reviewApp(repository).inject({
      method: 'GET',
      url: `/api/pattern-cards/${cardId}/inventory-check`,
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('MATERIALS_NOT_CONFIRMED');
  });

  test('recommends only confirmed cards with explicit stock-based reasons', async () => {
    const repository = new RecordingReviewRepository();
    const inventoryRepository = new RecordingInventoryRepository();
    const response = await reviewApp(repository, inventoryRepository).inject({
      method: 'GET',
      url: '/api/pattern-card-recommendations?limit=2&mode=ready',
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.evaluatedCount).toBe(3);
    expect(result.mode).toBe('ready');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      patternCardId: cardId,
      canMake: true,
      shortageTotal: 0,
    });
    expect(result.items[0].reasons).toContain('所有色号库存都够，可以立即制作');
    expect(repository.listConfirmedMaterials).toHaveBeenCalledWith('signed-in-user-token');
    expect(inventoryRepository.applyTransaction).not.toHaveBeenCalled();
  });

  test('filters confirmed recommendations by total beads before ranking', async () => {
    const repository = new RecordingReviewRepository();
    const response = await reviewApp(repository).inject({
      method: 'GET',
      url: '/api/pattern-card-recommendations?limit=10&mode=least_shortage&minTotalBeads=500&maxTotalBeads=1500',
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'least_shortage',
      evaluatedCount: 1,
      items: [{ patternCardId: '6807a274-9e1f-4784-9eb9-9bf47718f4f8', totalBeads: 900 }],
    });

    const invalid = await reviewApp(repository).inject({
      method: 'GET',
      url: '/api/pattern-card-recommendations?minTotalBeads=1500&maxTotalBeads=500',
      headers: { authorization: 'Bearer signed-in-user-token' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_RECOMMENDATION_QUERY');
  });
});

describe('Supabase pattern material review repository', () => {
  test('sends the complete review draft through one atomic RPC', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(draft({ revision: 5 })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const repository = new SupabasePatternCardReviewRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    const result = await repository.saveDraft({
      patternCardId: cardId,
      expectedRevision: 4,
      declaredTotal: draft().declaredTotal,
      conflicts: [],
      items,
      accessToken: 'user-token',
    });

    expect(result.revision).toBe(5);
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.supabase.co/rest/v1/rpc/save_pattern_material_review',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          p_pattern_card_id: cardId,
          p_expected_revision: 4,
          p_declared_total: draft().declaredTotal,
          p_conflicts: [],
          p_items: items,
        }),
      }),
    );
  });

  test('maps database revision conflicts without overwriting local edits', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'REVISION_CONFLICT' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const repository = new SupabasePatternCardReviewRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    await expect(
      repository.saveDraft({
        patternCardId: cardId,
        expectedRevision: 3,
        conflicts: [],
        items,
        accessToken: 'user-token',
      }),
    ).rejects.toBeInstanceOf(PatternMaterialRevisionConflictError);
  });

  test('loads the latest confirmed version through the owner-scoped RPC', async () => {
    const version = await new RecordingReviewRepository().confirmDraft();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(version), { status: 200 }));
    const repository = new SupabasePatternCardReviewRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    await expect(repository.getLatestVersion(cardId, 'user-token')).resolves.toMatchObject({
      patternCardId: cardId,
      version: 1,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.supabase.co/rest/v1/rpc/get_latest_pattern_material_version',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ p_pattern_card_id: cardId }),
      }),
    );
  });

  test('loads only owned confirmed candidates through one RPC', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(recommendationCandidates), { status: 200 }),
    );
    const repository = new SupabasePatternCardReviewRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    await expect(repository.listConfirmedMaterials('user-token')).resolves.toHaveLength(3);
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.supabase.co/rest/v1/rpc/list_confirmed_pattern_materials',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  test('deducts a realistic six-color 2136-bead card with an idempotency key', async () => {
    const repository = new RecordingReviewRepository();
    const response = await reviewApp(repository).inject({
      method: 'POST',
      url: `/api/pattern-cards/${cardId}/consume`,
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { idempotencyKey: repository.consumption.idempotencyKey },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ totalQuantity: 2_136, status: 'applied' });
    expect(response.json().items).toHaveLength(6);
    expect(repository.consumeInventory).toHaveBeenCalledWith(
      cardId,
      repository.consumption.idempotencyKey,
      'signed-in-user-token',
    );
  });

  test('reserves a realistic card, reloads it, then releases it without deducting inventory', async () => {
    const repository = new RecordingReviewRepository();
    const app = reviewApp(repository);
    const reserved = await app.inject({
      method: 'POST',
      url: `/api/pattern-cards/${cardId}/reserve`,
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { idempotencyKey: repository.reservation.idempotencyKey },
    });
    const loaded = await app.inject({
      method: 'GET',
      url: `/api/pattern-cards/${cardId}/reservation`,
      headers: { authorization: 'Bearer signed-in-user-token' },
    });
    const released = await app.inject({
      method: 'POST',
      url: `/api/pattern-card-reservations/${repository.reservation.id}/release`,
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(reserved.statusCode).toBe(201);
    expect(reserved.json()).toMatchObject({ status: 'active', totalQuantity: 2_136 });
    expect(loaded.json()).toMatchObject({ id: repository.reservation.id, status: 'active' });
    expect(released.json()).toMatchObject({ status: 'released' });
    expect(repository.reserveInventory).toHaveBeenCalledWith(
      cardId,
      repository.reservation.idempotencyKey,
      'signed-in-user-token',
    );
    expect(repository.releaseReservation).toHaveBeenCalledWith(
      repository.reservation.id,
      'signed-in-user-token',
    );
    expect(repository.consumeInventory).not.toHaveBeenCalled();
  });

  test('reports a conflict when another pending card already owns the available stock', async () => {
    const repository = new RecordingReviewRepository();
    repository.reserveInventory.mockRejectedValueOnce(
      new PatternReservationError(
        '可用库存不足；已有待做图纸的预留不会被挤占。',
        'INSUFFICIENT_AVAILABLE_INVENTORY',
      ),
    );
    const response = await reviewApp(repository).inject({
      method: 'POST',
      url: `/api/pattern-cards/${cardId}/reserve`,
      headers: { authorization: 'Bearer signed-in-user-token' },
      payload: { idempotencyKey: repository.reservation.idempotencyKey },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_INVENTORY' });
    expect(repository.consumeInventory).not.toHaveBeenCalled();
  });

  test('loads the latest completion and performs an explicit audited undo', async () => {
    const repository = new RecordingReviewRepository();
    const app = reviewApp(repository);
    const latest = await app.inject({
      method: 'GET',
      url: `/api/pattern-cards/${cardId}/consumption/latest`,
      headers: { authorization: 'Bearer signed-in-user-token' },
    });
    const undone = await app.inject({
      method: 'POST',
      url: `/api/pattern-card-consumptions/${repository.consumption.id}/undo`,
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(latest.json()).toMatchObject({ id: repository.consumption.id, undoAvailable: true });
    expect(undone.json()).toMatchObject({ status: 'reverted', undoAvailable: false });
    expect(repository.undoConsumption).toHaveBeenCalledWith(
      repository.consumption.id,
      'signed-in-user-token',
    );
  });

  test('lists grouped production history without mutating inventory', async () => {
    const repository = new RecordingReviewRepository();
    const response = await reviewApp(repository).inject({
      method: 'GET',
      url: '/api/pattern-card-consumptions?limit=20',
      headers: { authorization: 'Bearer signed-in-user-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(2);
    expect(response.json().items[0]).toMatchObject({
      patternCardName: '复杂大尺寸图纸验收',
      totalQuantity: 2_136,
    });
    expect(repository.listConsumptionHistory).toHaveBeenCalledWith(20, 'signed-in-user-token');
    expect(repository.consumeInventory).not.toHaveBeenCalled();
  });

  test('maps nested Supabase production history rows into stable API fields', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: '40000000-0000-4000-8000-000000000001',
              pattern_card_id: cardId,
              material_version: 1,
              idempotency_key: '50000000-0000-4000-8000-000000000001',
              status: 'reverted',
              total_quantity: 2136,
              created_at: '2026-07-22T10:30:00.000Z',
              undo_expires_at: '2026-07-22T10:40:00.000Z',
              reverted_at: '2026-07-22T10:32:00.000Z',
              pattern_cards: { name: '复杂大尺寸图纸验收' },
              pattern_card_consumption_items: [
                { palette_color_id: paletteIds[1], quantity: 617, balance_after: 867 },
                { palette_color_id: paletteIds[0], quantity: 526, balance_after: 1097 },
              ],
            },
          ]),
          { status: 200 },
        ),
    );
    const repository = new SupabasePatternCardReviewRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    const result = await repository.listConsumptionHistory(20, 'user-token');

    expect(result[0]).toMatchObject({
      patternCardName: '复杂大尺寸图纸验收',
      status: 'reverted',
      totalQuantity: 2136,
      undoAvailable: false,
    });
    expect(result[0]?.items.map((item) => item.paletteColorId)).toEqual([
      paletteIds[0],
      paletteIds[1],
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/rest/v1/pattern_card_consumptions?select='),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer user-token' }),
      }),
    );
  });
});
