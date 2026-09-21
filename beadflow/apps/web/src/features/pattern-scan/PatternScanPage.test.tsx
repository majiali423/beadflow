import type { PatternGridAnalysisResult } from '@beadflow/shared-types';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';

import { FakeAuthClient } from '../../test/fakeAuthClient';
import { AuthProvider } from '../auth/AuthContext';
import { PatternScanPage } from './PatternScanPage';
import { analyzePatternGrid } from './patternGridClient';

const result: PatternGridAnalysisResult = {
  status: 'needs_review',
  gridDetected: true,
  rowCount: 2,
  columnCount: 2,
  occupiedCount: 2,
  emptyCount: 1,
  uncertainCount: 1,
  cells: [
    { row: 0, column: 0, state: 'empty', reason: 'empty' },
    { row: 0, column: 1, state: 'occupied', reason: 'background', clusterId: 0 },
    { row: 1, column: 0, state: 'uncertain', reason: 'review' },
    { row: 1, column: 1, state: 'occupied', reason: 'cluster', clusterId: 0 },
  ],
  colorClusters: [
    {
      clusterId: 0,
      cellCount: 2,
      medianLab: { lightness: 80, a: 145, b: 138 },
      emptyReferenceDistance: 171,
    },
  ],
  reasons: ['uncertain_cells_require_manual_or_ocr_evidence'],
  requiresUserConfirmation: true,
  inventoryMutated: false,
};

afterEach(() => vi.unstubAllGlobals());

test('client uploads raw image to the authenticated read-only endpoint', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(result), { status: 200 }),
  );
  const file = new File([new Uint8Array(128_000)], 'pattern.png', { type: 'image/png' });

  await expect(analyzePatternGrid(file, 'user-token', fetcher)).resolves.toEqual(result);
  expect(fetcher).toHaveBeenCalledWith('/api/pattern-grid/analyze', {
    method: 'POST',
    headers: { authorization: 'Bearer user-token', 'content-type': 'image/png' },
    body: file,
  });
});

test('shows grid evidence and never offers inventory deduction', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(result), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
        <PatternScanPage />
      </AuthProvider>
    </MemoryRouter>,
  );

  const file = new File([new Uint8Array(128_000)], 'pattern.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('图纸文件'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));

  expect(await screen.findByRole('heading', { name: '2 × 2 主网格' })).toBeInTheDocument();
  expect(screen.getByText('豆子没动')).toBeInTheDocument();
  expect(screen.getByText(/还没选 MARD 色号/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '收进图纸库' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /扣减库存/ })).not.toBeInTheDocument();
});
