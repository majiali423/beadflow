import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parsePalette } from '@beadflow/palette-engine';
import type { PatternCardUploadResult, PatternMaterialDraftItem } from '@beadflow/shared-types';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from './app.js';
import {
  HttpPatternLegendClient,
  PatternLegendTimeoutError,
  SupabasePatternCardUploadRepository,
  type PatternCardUploadRepository,
  type PatternLegendClient,
} from './patternCardUploads.js';

const palette = parsePalette(
  readFileSync(new URL('../../../assets/palettes/mard221.json', import.meta.url), 'utf8'),
  221,
).palette;
const cardId = 'c972bbec-bea3-49bf-b6c6-dae04b8146d1';
const userId = '10000000-0000-4000-8000-000000000001';
const image = Buffer.alloc(3_200_000, 117);
const gridProxyImage = Buffer.alloc(128_000, 91);

function recognition() {
  return {
    materials: palette.colors.slice(0, 21).map((color, index) => ({
      code: color.code,
      quantity: index === 0 ? 299 : index + 5,
      raw_text: `${color.code} (${index === 0 ? 299 : index + 5})`,
      confidence: index % 5 === 0 ? 0.78 : 0.96,
      evidence_region: { x: index * 48, y: 1410, width: 44, height: 30 },
      recognition_source: (index === 0 ? 'compact' : 'spatial') as 'compact' | 'spatial',
    })),
    conflicts: ['H19'],
    recognized_total: 609,
  };
}

class RecordingLegendClient implements PatternLegendClient {
  result = recognition();
  readonly analyzeGrid = vi.fn(async () => ({
    status: 'needs_review' as const,
    gridDetected: true,
    rowCount: 20,
    columnCount: 22,
    occupiedCount: 246,
    emptyCount: 182,
    uncertainCount: 12,
    cells: [
      {
        row: 0,
        column: 0,
        state: 'empty' as const,
        reason: 'background_matches_empty_reference_without_foreground',
        clusterId: 0,
      },
    ],
    colorClusters: [
      {
        clusterId: 0,
        cellCount: 194,
        medianLab: { lightness: 251, a: 128, b: 128 },
        emptyReferenceDistance: 1,
      },
    ],
    reasons: ['uncertain_cells_require_manual_or_ocr_evidence'],
    requiresUserConfirmation: true as const,
    inventoryMutated: false as const,
  }));
  readonly detectCrop = vi.fn(async () => ({
    cropYStart: 0.78,
    cropYEnd: 0.87,
    confidence: 0.91,
    method: 'color_bar_rows' as const,
    needsManualReview: false,
    evidenceBoxCount: 12,
  }));
  readonly recognize = vi.fn(async () => this.result);
}

class RecordingUploadRepository implements PatternCardUploadRepository {
  deduplicated = false;
  readonly create = vi.fn(
    async (input: Parameters<PatternCardUploadRepository['create']>[0]) =>
      ({
        patternCardId: cardId,
        name: input.name,
        sourceImageUrl: 'https://storage.example/pattern-signed',
        sourceMimeType: input.mimeType,
        deduplicated: this.deduplicated,
        review: {
          patternCardId: cardId,
          revision: 0,
          status: 'needs_review',
          ...(input.declaredTotal === undefined ? {} : { declaredTotal: input.declaredTotal }),
          recognizedTotal: input.items.reduce((sum, item) => sum + item.quantity, 0),
          conflicts: input.conflicts,
          items: input.items,
          updatedAt: '2026-07-22T06:00:00.000Z',
        },
      }) satisfies PatternCardUploadResult,
  );
  readonly getSource = vi.fn(async () => ({
    patternCardId: cardId,
    name: '冰面包',
    sourceImageUrl: 'https://storage.example/pattern-signed',
    sourceMimeType: 'image/jpeg' as const,
  }));
  readonly deleteSource = vi.fn(async () => ({
    patternCardId: cardId,
    sourceDeletedAt: '2026-07-22T12:00:00.000Z',
    alreadyDeleted: false,
  }));
  readonly list = vi.fn(async () => ({
    items: [
      {
        patternCardId: cardId,
        name: '冰面包',
        sourceImageUrl: 'https://storage.example/pattern-signed',
        sourceMimeType: 'image/jpeg' as const,
        status: 'confirmed' as const,
        declaredTotal: 609,
        recognizedTotal: 609,
        colorCount: 21,
        pendingItemCount: 0,
        conflictCount: 0,
        materialVersion: 1,
        updatedAt: '2026-07-22T06:00:00.000Z',
      },
    ],
  }));
}

function uploadApp(repository: PatternCardUploadRepository, cvClient: PatternLegendClient) {
  return buildApp({
    patternCardUploads: { paletteColors: palette.colors, repository, cvClient },
  });
}

describe('pattern card import API', () => {
  test('returns main-grid evidence without storing the image or touching inventory', async () => {
    const repository = new RecordingUploadRepository();
    const cvClient = new RecordingLegendClient();
    const response = await uploadApp(repository, cvClient).inject({
      method: 'POST',
      url: '/api/pattern-grid/analyze',
      headers: { authorization: 'Bearer user-token', 'content-type': 'image/jpeg' },
      payload: gridProxyImage,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'needs_review',
      gridDetected: true,
      rowCount: 20,
      columnCount: 22,
      occupiedCount: 246,
      requiresUserConfirmation: true,
      inventoryMutated: false,
    });
    expect(cvClient.analyzeGrid).toHaveBeenCalledWith({
      image: gridProxyImage,
      mimeType: 'image/jpeg',
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  test('saves manually mapped clusters without OCR or inventory mutation', async () => {
    const color = palette.colors[0]!;
    const repository = new RecordingUploadRepository();
    const cvClient = new RecordingLegendClient();
    const response = await uploadApp(repository, cvClient).inject({
      method: 'POST',
      url: '/api/pattern-cards/from-clusters',
      headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
      payload: {
        name: '手工映射猫',
        mimeType: 'image/jpeg',
        imageBase64: gridProxyImage.toString('base64'),
        occupiedCount: 194,
        items: [{ paletteColorId: color.id, quantity: 194 }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(cvClient.recognize).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '手工映射猫',
        items: [
          expect.objectContaining({
            paletteColorId: color.id,
            quantity: 194,
            recognitionSource: 'manual',
            reviewState: 'confirmed',
          }),
        ],
      }),
    );
  });

  test('rejects cluster drafts whose quantities do not match occupied cells', async () => {
    const color = palette.colors[0]!;
    const repository = new RecordingUploadRepository();
    const cvClient = new RecordingLegendClient();
    const response = await uploadApp(repository, cvClient).inject({
      method: 'POST',
      url: '/api/pattern-cards/from-clusters',
      headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
      payload: {
        name: '数量不一致',
        mimeType: 'image/jpeg',
        imageBase64: gridProxyImage.toString('base64'),
        occupiedCount: 194,
        items: [{ paletteColorId: color.id, quantity: 10 }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
  });

  test('detects a reviewable legend crop without storing the image or touching inventory', async () => {
    const repository = new RecordingUploadRepository();
    const cvClient = new RecordingLegendClient();
    const response = await uploadApp(repository, cvClient).inject({
      method: 'POST',
      url: '/api/pattern-cards/detect-legend-crop',
      headers: { authorization: 'Bearer user-token', 'content-type': 'image/jpeg' },
      payload: gridProxyImage,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cropYStart: 0.78,
      cropYEnd: 0.87,
      confidence: 0.91,
      method: 'color_bar_rows',
      needsManualReview: false,
      evidenceBoxCount: 12,
    });
    expect(cvClient.detectCrop).toHaveBeenCalledWith({
      image: gridProxyImage,
      mimeType: 'image/jpeg',
    });
    expect(cvClient.recognize).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  test('imports a realistic 21-color image into a pending human-review draft', async () => {
    const repository = new RecordingUploadRepository();
    const cvClient = new RecordingLegendClient();
    const response = await uploadApp(repository, cvClient).inject({
      method: 'POST',
      url: '/api/pattern-cards/import?name=%E5%86%B0%E9%9D%A2%E5%8C%85&cropYStart=0.76&cropYEnd=0.94&declaredTotal=609',
      headers: { authorization: 'Bearer user-token', 'content-type': 'image/jpeg' },
      payload: image,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      patternCardId: cardId,
      name: '冰面包',
      deduplicated: false,
      review: { status: 'needs_review', conflicts: ['H19'] },
    });
    expect(response.json().review.items).toHaveLength(21);
    expect(
      response
        .json()
        .review.items.every((item: PatternMaterialDraftItem) => item.reviewState === 'pending'),
    ).toBe(true);
    expect(cvClient.recognize).toHaveBeenCalledWith(
      expect.objectContaining({ cropYStart: 0.76, cropYEnd: 0.94, declaredTotal: 609 }),
    );
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '冰面包',
        sha256: createHash('sha256').update(image).digest('hex'),
        conflicts: ['H19'],
        accessToken: 'user-token',
      }),
    );
  });

  test('returns the existing card on repeated upload instead of creating a duplicate', async () => {
    const repository = new RecordingUploadRepository();
    repository.deduplicated = true;
    const response = await uploadApp(repository, new RecordingLegendClient()).inject({
      method: 'POST',
      url: '/api/pattern-cards/import?name=%E9%87%8D%E5%A4%8D%E5%9B%BE%E7%BA%B8',
      headers: { authorization: 'Bearer user-token', 'content-type': 'image/png' },
      payload: image,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().deduplicated).toBe(true);
  });

  test('refuses an OCR code outside the verified MARD palette', async () => {
    const repository = new RecordingUploadRepository();
    const cvClient = new RecordingLegendClient();
    cvClient.result = {
      ...recognition(),
      materials: [{ ...recognition().materials[0]!, code: 'NOT-A-MARD-CODE' }],
    };
    const response = await uploadApp(repository, cvClient).inject({
      method: 'POST',
      url: '/api/pattern-cards/import?name=%E9%94%99%E8%AF%AF%E8%89%B2%E5%8F%B7',
      headers: { authorization: 'Bearer user-token', 'content-type': 'image/webp' },
      payload: image,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('PATTERN_IMPORT_FAILED');
    expect(repository.create).not.toHaveBeenCalled();
  });

  test('rejects an invalid crop before OCR or storage', async () => {
    const repository = new RecordingUploadRepository();
    const cvClient = new RecordingLegendClient();
    const response = await uploadApp(repository, cvClient).inject({
      method: 'POST',
      url: '/api/pattern-cards/import?name=%E8%A3%81%E5%89%AA%E5%A4%AA%E5%B0%8F&cropYStart=0.8&cropYEnd=0.82',
      headers: { authorization: 'Bearer user-token', 'content-type': 'image/jpeg' },
      payload: image,
    });

    expect(response.statusCode).toBe(400);
    expect(cvClient.recognize).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  test('reloads the private source through a short-lived URL for later review', async () => {
    const repository = new RecordingUploadRepository();
    const response = await uploadApp(repository, new RecordingLegendClient()).inject({
      method: 'GET',
      url: `/api/pattern-cards/${cardId}/source`,
      headers: { authorization: 'Bearer user-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      patternCardId: cardId,
      sourceImageUrl: 'https://storage.example/pattern-signed',
    });
    expect(repository.getSource).toHaveBeenCalledWith(cardId, 'user-token');
  });

  test('lists owned cards with review progress and private thumbnails', async () => {
    const repository = new RecordingUploadRepository();
    const response = await uploadApp(repository, new RecordingLegendClient()).inject({
      method: 'GET',
      url: '/api/pattern-cards',
      headers: { authorization: 'Bearer user-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      name: '冰面包',
      status: 'confirmed',
      recognizedTotal: 609,
      colorCount: 21,
    });
    expect(repository.list).toHaveBeenCalledWith('user-token');
  });

  test('deletes only the private source while preserving the confirmed card boundary', async () => {
    const repository = new RecordingUploadRepository();
    const response = await uploadApp(repository, new RecordingLegendClient()).inject({
      method: 'DELETE',
      url: `/api/pattern-cards/${cardId}/source`,
      headers: { authorization: 'Bearer user-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      patternCardId: cardId,
      sourceDeletedAt: '2026-07-22T12:00:00.000Z',
      alreadyDeleted: false,
    });
    expect(repository.deleteSource).toHaveBeenCalledWith(cardId, 'user-token');
  });
});

describe('pattern card import adapters', () => {
  test('lists cards newest-first and signs every private thumbnail', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/rest/v1/pattern_cards?')) {
        return new Response(
          JSON.stringify([
            {
              id: cardId,
              name: '54 格地球',
              status: 'confirmed',
              declared_total: 2136,
              recognized_total: 2136,
              material_version: 1,
              review_conflicts: [],
              updated_at: '2026-07-22T09:00:00.000Z',
              pattern_assets: {
                source_image_path: `${userId}/patterns/hash/source`,
                source_mime_type: 'image/jpeg',
              },
              pattern_material_draft_items: [
                { id: '1', review_state: 'confirmed' },
                { id: '2', review_state: 'confirmed' },
              ],
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/storage/v1/object/sign/pattern-images/')) {
        return new Response(JSON.stringify({ signedURL: '/object/sign/pattern-images/private' }));
      }
      return new Response(JSON.stringify({ message: `unexpected ${url}` }), { status: 500 });
    });
    const repository = new SupabasePatternCardUploadRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    await expect(repository.list('user-token')).resolves.toMatchObject({
      items: [
        {
          name: '54 格地球',
          status: 'confirmed',
          recognizedTotal: 2136,
          colorCount: 2,
          pendingItemCount: 0,
        },
      ],
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('order=updated_at.desc');
  });

  test('sends the image and crop controls to the formal OCR endpoint', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('crop_y_start')).toBe('0.71');
      expect(form.get('crop_y_end')).toBe('0.96');
      expect(form.get('declared_total')).toBe('609');
      return new Response(JSON.stringify(recognition()), { status: 200 });
    });
    const client = new HttpPatternLegendClient('http://cv.local', fetcher);

    await expect(
      client.recognize({
        image,
        mimeType: 'image/jpeg',
        cropYStart: 0.71,
        cropYEnd: 0.96,
        declaredTotal: 609,
      }),
    ).resolves.toMatchObject({ conflicts: ['H19'] });
    expect(fetcher).toHaveBeenCalledWith(
      'http://cv.local/pattern-legend/recognize',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('maps the automatic crop detector response into application field names', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(
        JSON.stringify({
          crop_y_start: 0.802,
          crop_y_end: 0.884,
          confidence: 0.89,
          method: 'color_bar_rows',
          needs_manual_review: false,
          evidence_box_count: 9,
        }),
      );
    });
    const client = new HttpPatternLegendClient('http://cv.local', fetcher);

    await expect(client.detectCrop({ image, mimeType: 'image/jpeg' })).resolves.toEqual({
      cropYStart: 0.802,
      cropYEnd: 0.884,
      confidence: 0.89,
      method: 'color_bar_rows',
      needsManualReview: false,
      evidenceBoxCount: 9,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://cv.local/pattern-legend/detect-crop',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('aborts a stalled OCR request so the same local image can be retried safely', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
        }),
    );
    const client = new HttpPatternLegendClient('http://cv.local', fetcher, 5, 5);

    await expect(
      client.recognize({
        image,
        mimeType: 'image/jpeg',
        cropYStart: 0.71,
        cropYEnd: 0.96,
      }),
    ).rejects.toBeInstanceOf(PatternLegendTimeoutError);
  });

  test('uploads privately, creates the draft atomically, then signs the preview URL', async () => {
    const hash = createHash('sha256').update(image).digest('hex');
    const path = `${userId}/patterns/${hash}/source`;
    const draftItems: PatternMaterialDraftItem[] = recognition().materials.map(
      (material, index) => ({
        id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        paletteColorId: palette.colors[index]!.id,
        quantity: material.quantity,
        rawText: material.raw_text,
        confidence: material.confidence,
        evidenceRegion: material.evidence_region,
        recognitionSource: material.recognition_source,
        reviewState: 'pending',
      }),
    );
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: userId }));
      if (url.includes('/storage/v1/object/pattern-images/')) {
        return new Response(JSON.stringify({ Key: path }), { status: 200 });
      }
      if (url.endsWith('/rest/v1/rpc/create_pattern_card_from_ocr')) {
        return new Response(
          JSON.stringify({
            patternCardId: cardId,
            name: '复杂图纸',
            sourceImagePath: path,
            sourceMimeType: 'image/jpeg',
            deduplicated: false,
            revision: 0,
            status: 'needs_review',
            declaredTotal: 609,
            recognizedTotal: draftItems.reduce((sum, item) => sum + item.quantity, 0),
            conflicts: ['H19'],
            items: draftItems,
            updatedAt: '2026-07-22T06:00:00.000Z',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/rest/v1/rpc/restore_pattern_card_source')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/storage/v1/object/sign/pattern-images/')) {
        return new Response(JSON.stringify({ signedURL: '/object/sign/pattern-images/token' }));
      }
      return new Response(JSON.stringify({ message: 'unexpected request' }), { status: 500 });
    });
    const repository = new SupabasePatternCardUploadRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    const result = await repository.create({
      name: '复杂图纸',
      image,
      mimeType: 'image/jpeg',
      sha256: hash,
      declaredTotal: 609,
      conflicts: ['H19'],
      items: draftItems,
      accessToken: 'user-token',
    });

    expect(result).toMatchObject({
      patternCardId: cardId,
      sourceImageUrl: 'https://example.supabase.co/storage/v1/object/sign/pattern-images/token',
      deduplicated: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  test('deletes the storage object before marking the source deleted and is retry-safe', async () => {
    const path = `${userId}/patterns/hash/source`;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/rest/v1/rpc/prepare_pattern_card_source_deletion')) {
        return new Response(JSON.stringify({ patternCardId: cardId, sourceImagePath: path }));
      }
      if (url.includes(`/storage/v1/object/pattern-images/${path}`)) {
        expect(init?.method).toBe('DELETE');
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/rest/v1/rpc/complete_pattern_card_source_deletion')) {
        return new Response(
          JSON.stringify({
            patternCardId: cardId,
            sourceDeletedAt: '2026-07-22T12:00:00.000Z',
          }),
        );
      }
      return new Response(JSON.stringify({ message: `unexpected ${url}` }), { status: 500 });
    });
    const repository = new SupabasePatternCardUploadRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    await expect(repository.deleteSource(cardId, 'user-token')).resolves.toEqual({
      patternCardId: cardId,
      sourceDeletedAt: '2026-07-22T12:00:00.000Z',
      alreadyDeleted: false,
    });
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      'https://example.supabase.co/rest/v1/rpc/prepare_pattern_card_source_deletion',
      `https://example.supabase.co/storage/v1/object/pattern-images/${path}`,
      'https://example.supabase.co/rest/v1/rpc/complete_pattern_card_source_deletion',
    ]);
  });

  test('returns an already-deleted source without touching storage again', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            patternCardId: cardId,
            sourceImagePath: `${userId}/patterns/hash/source`,
            sourceDeletedAt: '2026-07-22T12:00:00.000Z',
          }),
        ),
    );
    const repository = new SupabasePatternCardUploadRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    await expect(repository.deleteSource(cardId, 'user-token')).resolves.toEqual({
      patternCardId: cardId,
      sourceDeletedAt: '2026-07-22T12:00:00.000Z',
      alreadyDeleted: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('does not mark metadata deleted when private storage rejects deletion', async () => {
    const path = `${userId}/patterns/hash/source`;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/rest/v1/rpc/prepare_pattern_card_source_deletion')) {
        return new Response(JSON.stringify({ patternCardId: cardId, sourceImagePath: path }));
      }
      if (url.includes(`/storage/v1/object/pattern-images/${path}`)) {
        return new Response(JSON.stringify({ message: 'storage unavailable' }), { status: 503 });
      }
      return new Response(JSON.stringify({ message: 'metadata must not be marked' }), {
        status: 500,
      });
    });
    const repository = new SupabasePatternCardUploadRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    await expect(repository.deleteSource(cardId, 'user-token')).rejects.toThrow(
      '私有存储中的原图删除失败。',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).endsWith('/rest/v1/rpc/complete_pattern_card_source_deletion'),
      ),
    ).toBe(false);
  });
});
