import { parsePalette } from '@beadflow/palette-engine';
import type { InventoryItem, InventoryTransaction } from '@beadflow/shared-types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AuthProvider } from '../auth/AuthContext';
import { usePalette } from '../palette/usePalette';
import { FakeAuthClient } from '../../test/fakeAuthClient';
import { InventoryPage } from './InventoryPage';

vi.mock('../palette/usePalette');

const palette = parsePalette(
  JSON.stringify({
    name: 'MARD 221',
    version: '2026-07-user-verified',
    colors: [
      { code: 'A10', hex: '#F47E38', rgb: [244, 126, 56] },
      { code: 'B17', hex: '#9EB33E', rgb: [158, 179, 62] },
    ],
  }),
).palette;
const a10 = palette.colors[0]!;
const b17 = palette.colors[1]!;
const items: readonly InventoryItem[] = [
  {
    id: 'inventory-a10',
    userId: 'user-1',
    paletteColorId: a10.id,
    quantity: 180,
    quantityConfidence: 'exact',
    lowStockThreshold: 40,
    updatedAt: '2026-07-20T03:00:00.000Z',
  },
  {
    id: 'inventory-b17',
    userId: 'user-1',
    paletteColorId: b17.id,
    quantity: 45,
    quantityConfidence: 'estimated',
    lowStockThreshold: 50,
    updatedAt: '2026-07-20T03:00:00.000Z',
  },
];
const transaction: InventoryTransaction = {
  id: 'transaction-b17',
  userId: 'user-1',
  paletteColorId: b17.id,
  delta: -56,
  reason: 'pattern_consumption',
  createdAt: '2026-07-20T04:00:00.000Z',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderInventory() {
  render(
    <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
      <InventoryPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.mocked(usePalette).mockReturnValue({
    data: palette,
    isLoading: false,
    isError: false,
  } as ReturnType<typeof usePalette>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InventoryPage', () => {
  test('shows exact versus estimated stock, low-stock state and traceable history', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(items))
      .mockResolvedValueOnce(jsonResponse([transaction]));
    vi.stubGlobal('fetch', fetcher);
    renderInventory();

    expect(await screen.findByRole('heading', { name: '手头的豆' })).toBeInTheDocument();
    expect(await screen.findByText('约数 · 估算')).toBeInTheDocument();
    expect(screen.getByText('低库存')).toBeInTheDocument();
    expect(screen.getByText('图纸制作')).toBeInTheDocument();
    expect(screen.getByText('-56')).toBeInTheDocument();
    expect(screen.getByLabelText('豆仓统计')).toHaveTextContent('225 颗');
  });

  test('saves a changed absolute count while keeping confidence and threshold explicit', async () => {
    const updated: InventoryItem = {
      ...items[1]!,
      quantity: 320,
      quantityConfidence: 'estimated',
      lowStockThreshold: 60,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(items))
      .mockResolvedValueOnce(jsonResponse([transaction]))
      .mockResolvedValueOnce(jsonResponse({ item: updated }));
    vi.stubGlobal('fetch', fetcher);
    renderInventory();

    await screen.findByText('约数 · 估算');
    const editButtons = screen.getAllByRole('button', { name: '编辑' });
    fireEvent.click(editButtons[1]!);
    fireEvent.change(screen.getByLabelText('当前数量（颗）'), {
      target: { value: '320' },
    });
    fireEvent.change(screen.getByLabelText('低库存提醒（颗，可留空）'), {
      target: { value: '60' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存库存' }));

    expect(await screen.findByText('B17 已保存为 320 颗。')).toBeInTheDocument();
    await waitFor(() =>
      expect(fetcher).toHaveBeenLastCalledWith(
        `/api/inventory/${encodeURIComponent(b17.id)}`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            quantity: 320,
            quantityConfidence: 'estimated',
            lowStockThreshold: 60,
          }),
        }),
      ),
    );
  });
});
