import type { PersonalDataExport } from '@beadflow/shared-types';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { downloadPersonalDataExport, loadPersonalDataExport } from './accountExportClient';

const payload: PersonalDataExport = {
  schemaVersion: '1.0',
  generatedAt: '2026-07-22T13:00:00.000Z',
  account: {
    id: '10000000-0000-4000-8000-000000000001',
    email: 'maker@example.com',
    createdAt: '2026-07-20T01:00:00.000Z',
  },
  currentProduct: { patternCards: [{ name: '复杂大尺寸图纸验收' }] },
  legacyProduct: { projects: [] },
  referenceData: { paletteColors: [{ code: 'B17', hex: '#B5CF35' }] },
  notices: ['不包含密码、登录令牌或图片二进制。'],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('personal data export client', () => {
  test('loads the owner export with an authenticated read-only request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));

    await expect(loadPersonalDataExport('user-token', fetcher)).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith('/api/account/export', {
      headers: { authorization: 'Bearer user-token' },
    });
  });

  test('downloads readable versioned JSON without embedding the access token', async () => {
    let serialized = '';
    class TestBlob {
      constructor(parts: BlobPart[]) {
        serialized = String(parts[0] ?? '');
      }
    }
    vi.stubGlobal('Blob', TestBlob);
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return 'blob:personal-export';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.fn();
    const createElement = vi.spyOn(document, 'createElement');
    createElement.mockReturnValueOnce({ click } as unknown as HTMLAnchorElement);

    downloadPersonalDataExport(payload);

    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: '1.0',
      account: payload.account,
    });
    expect(serialized).not.toContain('user-token');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:personal-export');
  });
});
