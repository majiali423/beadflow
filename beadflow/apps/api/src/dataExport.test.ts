import type { PersonalDataExport } from '@beadflow/shared-types';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from './app.js';
import {
  SupabasePersonalDataExportRepository,
  type PersonalDataExportRepository,
} from './dataExport.js';

const userId = '10000000-0000-4000-8000-000000000001';

function realisticExport(): PersonalDataExport {
  return {
    schemaVersion: '1.0',
    generatedAt: '2026-07-22T13:00:00.000Z',
    account: { id: userId, email: 'maker@example.com', createdAt: '2026-07-20T01:00:00.000Z' },
    currentProduct: {
      patternAssets: Array.from({ length: 24 }, (_, index) => ({
        id: `asset-${index + 1}`,
        source_image_path: `${userId}/patterns/hash-${index + 1}/source`,
        source_deleted_at: index === 0 ? '2026-07-22T12:00:00.000Z' : null,
      })),
      patternCards: Array.from({ length: 24 }, (_, index) => ({
        id: `card-${index + 1}`,
        name: `真实图纸 ${index + 1}`,
        recognized_total: index < 8 ? 303 : index < 16 ? 1221 : 2136,
      })),
      patternMaterialDraftItems: Array.from({ length: 144 }, (_, index) => ({
        id: `draft-${index + 1}`,
        quantity: 50 + (index % 300),
      })),
      patternMaterialVersions: [],
      patternMaterialItems: [],
      inventoryItems: Array.from({ length: 221 }, (_, index) => ({
        palette_color_id: `mard-color-${index + 1}`,
        quantity: index < 2 ? 4000 : 2000,
      })),
      inventoryTransactions: [],
      patternCardConsumptions: [],
      patternCardConsumptionItems: [],
      auditLogs: [],
    },
    legacyProduct: {
      projects: [],
      patternVersions: [],
      patternCells: [],
      buildSessions: [],
      buildSteps: [],
      cellProgress: [],
      scanJobs: [],
      scanReviewCommits: [],
      scanReviewDeductions: [],
    },
    referenceData: {
      paletteColors: Array.from({ length: 221 }, (_, index) => ({
        id: `mard-color-${index + 1}`,
        code: `X${index + 1}`,
        hex: '#FFFFFF',
      })),
    },
    notices: ['不包含密码和登录令牌。', '不包含图片二进制。'],
  };
}

class RecordingExportRepository implements PersonalDataExportRepository {
  readonly exportData = vi.fn(async () => realisticExport());
}

describe('personal data export API', () => {
  test('exports a realistic owned dataset with a stable schema and download filename', async () => {
    const repository = new RecordingExportRepository();
    const response = await buildApp({ dataExport: { repository } }).inject({
      method: 'GET',
      url: '/api/account/export',
      headers: { authorization: 'Bearer user-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="beadflow-personal-data-2026-07-22.json"',
    );
    expect(response.json()).toMatchObject({
      schemaVersion: '1.0',
      account: { id: userId, email: 'maker@example.com' },
    });
    expect(response.json().currentProduct.patternCards).toHaveLength(24);
    expect(response.json().currentProduct.inventoryItems).toHaveLength(221);
    expect(response.json().referenceData.paletteColors).toHaveLength(221);
    expect(repository.exportData).toHaveBeenCalledWith('user-token');
  });

  test('rejects unauthenticated exports before reading persistence', async () => {
    const repository = new RecordingExportRepository();
    const response = await buildApp({ dataExport: { repository } }).inject({
      method: 'GET',
      url: '/api/account/export',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTH_REQUIRED');
    expect(repository.exportData).not.toHaveBeenCalled();
  });

  test('forwards only the caller token to the owner-checked Supabase RPC', async () => {
    const payload = realisticExport();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));
    const repository = new SupabasePersonalDataExportRepository(
      'https://example.supabase.co',
      'publishable-key',
      fetcher,
    );

    await expect(repository.exportData('user-token')).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.supabase.co/rest/v1/rpc/export_my_beadflow_data',
      {
        method: 'POST',
        headers: {
          apikey: 'publishable-key',
          authorization: 'Bearer user-token',
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
  });
});
