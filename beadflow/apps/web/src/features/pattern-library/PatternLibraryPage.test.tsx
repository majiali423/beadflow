import type {
  PatternCardInventoryCheckResult,
  PatternMaterialDraftItem,
  PatternMaterialReviewDraft,
  PatternMaterialVersion,
} from '@beadflow/shared-types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { FakeAuthClient } from '../../test/fakeAuthClient';
import { AuthProvider } from '../auth/AuthContext';
import { PatternLibraryPage } from './PatternLibraryPage';

const cardId = 'c972bbec-bea3-49bf-b6c6-dae04b8146d1';
const items: readonly PatternMaterialDraftItem[] = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    paletteColorId: 'mard-221-2026-07-user-verified:A1',
    quantity: 120,
    rawText: 'A1 (120)',
    confidence: 0.96,
    evidenceRegion: { x: 50, y: 1400, width: 90, height: 32 },
    recognitionSource: 'spatial',
    reviewState: 'pending',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    paletteColorId: 'mard-221-2026-07-user-verified:F11',
    quantity: 98,
    rawText: 'F11 98',
    confidence: 0.78,
    evidenceRegion: { x: 150, y: 1400, width: 90, height: 32 },
    recognitionSource: 'compact',
    reviewState: 'pending',
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    paletteColorId: 'mard-221-2026-07-user-verified:H16',
    quantity: 85,
    rawText: 'H16 (85)',
    confidence: 0.91,
    evidenceRegion: { x: 250, y: 1400, width: 90, height: 32 },
    recognitionSource: 'direct',
    reviewState: 'pending',
  },
];

function review(overrides: Partial<PatternMaterialReviewDraft> = {}): PatternMaterialReviewDraft {
  return {
    patternCardId: cardId,
    revision: 0,
    status: 'needs_review',
    declaredTotal: 303,
    recognizedTotal: 303,
    conflicts: ['F11'],
    items,
    updatedAt: '2026-07-22T07:00:00.000Z',
    ...overrides,
  };
}

const version: PatternMaterialVersion = {
  id: '30000000-0000-4000-8000-000000000001',
  patternCardId: cardId,
  version: 1,
  totalQuantity: 303,
  items: items.map((item) => ({
    id: item.id,
    paletteColorId: item.paletteColorId,
    quantity: item.quantity,
    ...(item.rawText === undefined ? {} : { rawText: item.rawText }),
    ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
    ...(item.evidenceRegion === undefined ? {} : { evidenceRegion: item.evidenceRegion }),
    recognitionSource: item.recognitionSource,
  })),
  confirmedAt: '2026-07-22T07:05:00.000Z',
};
const inventory: PatternCardInventoryCheckResult = {
  patternCard: {
    patternCardId: cardId,
    materialVersion: 1,
    totalBeads: 303,
    colorCount: 3,
    confirmedAt: version.confirmedAt,
  },
  balances: [
    {
      paletteColorId: 'mard-221-2026-07-user-verified:A1',
      code: 'A1',
      hex: '#FFF1DA',
      family: 'A',
      required: 120,
      reserved: 0,
      netRequired: 120,
      available: 90,
      onHand: 90,
      reservedForThisCard: 0,
      reservedElsewhere: 0,
      freelyAvailable: 90,
      shortage: 30,
      remaining: -30,
      quantityConfidence: 'exact',
    },
    {
      paletteColorId: 'mard-221-2026-07-user-verified:F11',
      code: 'F11',
      hex: '#712929',
      family: 'F',
      required: 98,
      reserved: 0,
      netRequired: 98,
      available: 20,
      onHand: 20,
      reservedForThisCard: 0,
      reservedElsewhere: 0,
      freelyAvailable: 20,
      shortage: 78,
      remaining: -78,
      quantityConfidence: 'exact',
    },
    {
      paletteColorId: 'mard-221-2026-07-user-verified:H16',
      code: 'H16',
      hex: '#342B2B',
      family: 'H',
      required: 85,
      reserved: 0,
      netRequired: 85,
      available: 75,
      onHand: 75,
      reservedForThisCard: 0,
      reservedElsewhere: 0,
      freelyAvailable: 75,
      shortage: 10,
      remaining: -10,
      quantityConfidence: 'estimated',
    },
  ],
  totals: {
    required: 303,
    reservedForThisCard: 0,
    reservedElsewhere: 0,
    shortage: 118,
    colorsReady: 0,
    colorsShort: 3,
  },
  hasEstimatedInventory: true,
};

const purchaseList = {
  ...inventory,
  items: [...inventory.balances].sort((left, right) => right.shortage - left.shortage),
  groups: [
    { family: 'F', items: [inventory.balances[1]!] },
    { family: 'A', items: [inventory.balances[0]!] },
    { family: 'H', items: [inventory.balances[2]!] },
  ],
  copyText: 'BeadFlow MARD 补豆清单\nF11 × 78\nA1 × 30\nH16 × 10',
  csv: '\uFEFF色号,缺少数量\nF11,78\nA1,30\nH16,10',
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('PatternLibraryPage', () => {
  test('shows owned cards and explains why a confirmed card is recommended', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === '/api/pattern-cards') {
        return response({
          items: [
            {
              patternCardId: cardId,
              name: '54 格地球',
              sourceImageUrl: 'https://storage.example/globe',
              sourceMimeType: 'image/jpeg',
              status: 'confirmed',
              declaredTotal: 2136,
              recognizedTotal: 2136,
              colorCount: 6,
              pendingItemCount: 0,
              conflictCount: 0,
              materialVersion: 1,
              updatedAt: '2026-07-22T09:00:00.000Z',
            },
          ],
        });
      }
      if (url.startsWith('/api/pattern-card-recommendations?')) {
        return response({
          evaluatedCount: 1,
          items: [
            {
              patternCardId: cardId,
              name: '54 格地球',
              materialVersion: 1,
              totalBeads: 2136,
              colorCount: 6,
              confirmedAt: '2026-07-22T09:00:00.000Z',
              canMake: true,
              score: 100,
              coverageRatio: 1,
              safeCoverageRatio: 1,
              shortageTotal: 0,
              shortageColorCount: 0,
              lowStockAfterBuildCount: 0,
              hasEstimatedInventory: true,
              topShortages: [],
              reasons: ['当前库存足够，可以直接制作'],
            },
          ],
        });
      }
      if (url === '/api/pattern-card-consumptions?limit=20') {
        return response({
          items: [
            {
              id: '40000000-0000-4000-8000-000000000001',
              patternCardId: cardId,
              patternCardName: '54 格地球',
              materialVersion: 1,
              idempotencyKey: '50000000-0000-4000-8000-000000000001',
              status: 'reverted',
              totalQuantity: 2136,
              items: [
                {
                  paletteColorId: 'mard-221-2026-07-user-verified:B14',
                  quantity: 526,
                  balanceAfter: 1097,
                },
                {
                  paletteColorId: 'mard-221-2026-07-user-verified:C6',
                  quantity: 617,
                  balanceAfter: 867,
                },
              ],
              createdAt: '2026-07-22T10:30:00.000Z',
              undoExpiresAt: '2026-07-22T10:40:00.000Z',
              revertedAt: '2026-07-22T10:32:00.000Z',
              undoAvailable: false,
            },
          ],
        });
      }
      return response({ error: { message: `unexpected ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter initialEntries={['/patterns']}>
        <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
          <PatternLibraryPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('库存推荐图纸')).toHaveTextContent('推荐 1');
    expect(screen.getByLabelText('库存推荐图纸')).toHaveTextContent('当前库存足够，可以直接制作');
    expect(screen.getByLabelText('我的图纸库')).toHaveTextContent('54 格地球');
    expect(screen.getByRole('button', { name: '打开图纸 54 格地球' })).toHaveTextContent('查看');
  });

  test('requires confirmation, deletes only the source image, and keeps confirmed materials visible', async () => {
    const confirmedReview = review({
      status: 'confirmed',
      conflicts: [],
      items: items.map((item) => ({ ...item, reviewState: 'confirmed' as const })),
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/${cardId}/review`)) return response(confirmedReview);
      if (url.endsWith(`/${cardId}/inventory-check`)) return response(inventory);
      if (url.endsWith(`/${cardId}/consumption/latest`)) return response(null);
      if (url.endsWith(`/${cardId}/reservation`)) return response(null);
      if (url.endsWith(`/${cardId}/source`) && init?.method === 'DELETE') {
        return response({
          patternCardId: cardId,
          sourceDeletedAt: '2026-07-22T12:00:00.000Z',
          alreadyDeleted: false,
        });
      }
      if (url.endsWith(`/${cardId}/source`)) {
        return response({
          patternCardId: cardId,
          name: '真实三色图纸',
          sourceImageUrl: 'https://storage.example/signed-source',
          sourceMimeType: 'image/jpeg',
        });
      }
      return response({ error: { message: `unexpected ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter initialEntries={[`/patterns?card=${cardId}`]}>
        <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
          <PatternLibraryPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('正式材料版本已锁定，不能再修改或删除。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除已确认图纸的原图' }));
    expect(screen.getByText(/之后不能再查看 OCR 证据框/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认永久删除原图' }));

    expect(await screen.findByText('原图已删除')).toBeInTheDocument();
    expect(screen.getByLabelText('材料人工复核')).toHaveTextContent('3 个色号');
    expect(screen.getByLabelText('图纸库存对比结果')).toHaveTextContent('118 颗总缺口');
    expect(fetcher).toHaveBeenCalledWith(`/api/pattern-cards/${cardId}/source`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer fake-access-token' },
    });
  });

  test('reserves a buildable card without deducting stock and releases it explicitly', async () => {
    const confirmedReview = review({
      status: 'confirmed',
      conflicts: [],
      items: items.map((item) => ({ ...item, reviewState: 'confirmed' as const })),
    });
    const readyInventory: PatternCardInventoryCheckResult = {
      ...inventory,
      balances: inventory.balances.map((item) => ({
        ...item,
        available: 4_000,
        onHand: 4_000,
        freelyAvailable: 4_000,
        shortage: 0,
        remaining: 4_000 - item.required,
      })),
      totals: {
        required: 303,
        reservedForThisCard: 0,
        reservedElsewhere: 0,
        shortage: 0,
        colorsReady: 3,
        colorsShort: 0,
      },
      hasEstimatedInventory: false,
    };
    const reservation = {
      id: '60000000-0000-4000-8000-000000000001',
      patternCardId: cardId,
      materialVersion: 1,
      idempotencyKey: '70000000-0000-4000-8000-000000000001',
      status: 'active',
      totalQuantity: 303,
      items: readyInventory.balances.map((item) => ({
        paletteColorId: item.paletteColorId,
        quantity: item.required,
      })),
      createdAt: '2026-07-22T11:00:00.000Z',
    } as const;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/${cardId}/review`)) return response(confirmedReview);
      if (url.endsWith(`/${cardId}/source`))
        return response({
          patternCardId: cardId,
          name: '真实三色图纸',
          sourceImageUrl: 'https://storage.example/signed-source',
          sourceMimeType: 'image/jpeg',
        });
      if (url.endsWith(`/${cardId}/inventory-check`)) return response(readyInventory);
      if (url.endsWith(`/${cardId}/consumption/latest`)) return response(null);
      if (url.endsWith(`/${cardId}/reservation`) && !init?.method) return response(null);
      if (url.endsWith(`/${cardId}/reserve`) && init?.method === 'POST')
        return response(reservation, 201);
      if (url.endsWith(`/${reservation.id}/release`) && init?.method === 'POST')
        return response({
          ...reservation,
          status: 'released',
          releasedAt: '2026-07-22T11:02:00.000Z',
        });
      return response({ error: { message: `unexpected ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter initialEntries={[`/patterns?card=${cardId}`]}>
        <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
          <PatternLibraryPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '加入待做' }));
    expect(await screen.findByLabelText('待做库存预留')).toHaveTextContent('实际库存未扣减');
    expect(fetcher).toHaveBeenCalledWith(
      `/api/pattern-cards/${cardId}/reserve`,
      expect.objectContaining({ method: 'POST' }),
    );
    fireEvent.click(screen.getByRole('button', { name: '取消待做并释放' }));
    await waitFor(() => expect(screen.queryByLabelText('待做库存预留')).not.toBeInTheDocument());
    expect(await screen.findByText('已取消待做并释放预留；实际库存没有变化。')).toBeInTheDocument();
  });

  test('renders a real-size reverted production record with color details', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === '/api/pattern-cards') return response({ items: [] });
      if (url.startsWith('/api/pattern-card-recommendations?')) {
        return response({ items: [], evaluatedCount: 0 });
      }
      if (url === '/api/pattern-card-consumptions?limit=20') {
        return response({
          items: [
            {
              id: '40000000-0000-4000-8000-000000000001',
              patternCardId: cardId,
              patternCardName: '复杂大尺寸图纸验收',
              materialVersion: 1,
              idempotencyKey: '50000000-0000-4000-8000-000000000001',
              status: 'reverted',
              totalQuantity: 2136,
              items: [
                {
                  paletteColorId: 'mard-221-2026-07-user-verified:B14',
                  quantity: 526,
                  balanceAfter: 1097,
                },
                {
                  paletteColorId: 'mard-221-2026-07-user-verified:C6',
                  quantity: 617,
                  balanceAfter: 867,
                },
              ],
              createdAt: '2026-07-22T10:30:00.000Z',
              undoExpiresAt: '2026-07-22T10:40:00.000Z',
              revertedAt: '2026-07-22T10:32:00.000Z',
              undoAvailable: false,
            },
          ],
        });
      }
      return response({ error: { message: `unexpected ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter initialEntries={['/patterns']}>
        <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
          <PatternLibraryPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    const history = await screen.findByLabelText('制作与库存变动历史');
    expect(history).toHaveTextContent('复杂大尺寸图纸验收');
    expect(history).toHaveTextContent('已撤销并恢复');
    expect(history).toHaveTextContent('2136 颗');
    fireEvent.click(screen.getByText('查看 2 个色号明细'));
    expect(history).toHaveTextContent('B14');
    expect(history).toHaveTextContent('曾扣减 526');
  });

  test('selects three confirmed sheets and shows one merged real-scale purchase list', async () => {
    const ids = [
      cardId,
      '75a581b4-949c-4f15-95e5-6b2fdf86c6ee',
      '6807a274-9e1f-4784-9eb9-9bf47718f4f8',
    ];
    const names = ['54 格地球', '49 格小鹿', '44 格面包'];
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const cards = ids.map((patternCardId, index) => ({
      patternCardId,
      name: names[index],
      sourceImageUrl: `https://storage.example/card-${index}`,
      sourceMimeType: 'image/jpeg',
      status: 'confirmed',
      recognizedTotal: [2136, 1221, 1159][index],
      colorCount: [6, 8, 21][index],
      pendingItemCount: 0,
      conflictCount: 0,
      materialVersion: 1,
      updatedAt: '2026-07-22T09:00:00.000Z',
    }));
    const combined = {
      patternCards: cards.map((card) => ({
        patternCardId: card.patternCardId,
        name: card.name,
        materialVersion: 1,
        totalBeads: card.recognizedTotal,
        colorCount: card.colorCount,
        confirmedAt: card.updatedAt,
      })),
      balances: inventory.balances,
      totals: { patternCards: 3, required: 4516, shortage: 684, colorsReady: 18, colorsShort: 3 },
      hasEstimatedInventory: true,
      items: inventory.balances,
      groups: purchaseList.groups,
      copyText: 'BeadFlow 多图合并补豆清单\n54 格地球、49 格小鹿、44 格面包',
      csv: purchaseList.csv,
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/pattern-cards') return response({ items: cards });
      if (url.startsWith('/api/pattern-card-recommendations?'))
        return response({ items: [], evaluatedCount: 3 });
      if (url === '/api/pattern-card-consumptions?limit=20') return response({ items: [] });
      if (url === '/api/pattern-cards/combined-purchase-list' && init?.method === 'POST')
        return response(combined);
      return response({ error: { message: `unexpected ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter initialEntries={['/patterns']}>
        <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
          <PatternLibraryPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    const selectors = await screen.findAllByLabelText('加入合并补豆');
    selectors.forEach((selector) => fireEvent.click(selector));
    expect(screen.getByLabelText('多图合并补豆')).toHaveTextContent('已选 3 张图纸');
    fireEvent.click(screen.getByRole('button', { name: '合并计算补豆' }));

    const panel = await screen.findByLabelText('多图合并补豆');
    expect(panel).toHaveTextContent('4516 颗总用量');
    expect(panel).toHaveTextContent('684 颗需补');
    expect(panel).toHaveTextContent('54 格地球、49 格小鹿、44 格面包');
    expect(panel).toHaveTextContent('F11 补 78');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/pattern-cards/combined-purchase-list',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ patternCardIds: ids }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: '复制合并清单' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(combined.copyText));
    expect(panel).toHaveTextContent('多图补豆清单已复制。');
  });

  test('switches among three recommendation goals and exposes concrete stockpile colors', async () => {
    const secondId = '75a581b4-949c-4f15-95e5-6b2fdf86c6ee';
    const cards = [
      {
        patternCardId: cardId,
        name: '囤积色大图',
        sourceImageUrl: 'https://storage.example/stockpile',
        sourceMimeType: 'image/jpeg',
        status: 'confirmed',
        recognizedTotal: 620,
        colorCount: 2,
        pendingItemCount: 0,
        conflictCount: 0,
        materialVersion: 1,
        updatedAt: '2026-07-22T09:00:00.000Z',
      },
      {
        patternCardId: secondId,
        name: '只缺少量的图',
        sourceImageUrl: 'https://storage.example/short',
        sourceMimeType: 'image/jpeg',
        status: 'confirmed',
        recognizedTotal: 300,
        colorCount: 1,
        pendingItemCount: 0,
        conflictCount: 0,
        materialVersion: 1,
        updatedAt: '2026-07-22T09:00:00.000Z',
      },
    ];
    const recommendation = (
      patternCardId: string,
      name: string,
      shortageTotal: number,
      stockpileUsageTotal: number,
      reason: string,
    ) => ({
      patternCardId,
      name,
      materialVersion: 1,
      totalBeads: patternCardId === cardId ? 620 : 300,
      colorCount: patternCardId === cardId ? 2 : 1,
      confirmedAt: '2026-07-22T09:00:00.000Z',
      canMake: shortageTotal === 0,
      score: shortageTotal === 0 ? 100 : 92,
      coverageRatio: shortageTotal === 0 ? 1 : 0.93,
      safeCoverageRatio: patternCardId === cardId ? 1 : 0.9,
      shortageTotal,
      shortageColorCount: shortageTotal === 0 ? 0 : 1,
      lowStockAfterBuildCount: 0,
      stockpileUsageTotal,
      hasEstimatedInventory: false,
      topShortages: [],
      topStockpileUses:
        patternCardId === cardId
          ? [
              {
                paletteColorId: 'mard-221-2026-07-user-verified:B14',
                code: 'B14',
                hex: '#92c83e',
                quantity: 400,
              },
              {
                paletteColorId: 'mard-221-2026-07-user-verified:C6',
                code: 'C6',
                hex: '#57b7dc',
                quantity: 220,
              },
            ]
          : [],
      reasons: [reason],
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === '/api/pattern-cards') return response({ items: cards });
      if (url === '/api/pattern-card-consumptions?limit=20') return response({ items: [] });
      if (url.includes('mode=ready'))
        return response({
          mode: 'ready',
          evaluatedCount: 2,
          items: [recommendation(cardId, '囤积色大图', 0, 620, '所有色号库存都够，可以立即制作')],
        });
      if (url.includes('mode=least_shortage'))
        return response({
          mode: 'least_shortage',
          evaluatedCount: 2,
          items: [
            recommendation(cardId, '囤积色大图', 0, 620, '无需补豆，可以直接制作'),
            recommendation(secondId, '只缺少量的图', 20, 260, '只需补 20 颗，涉及 1 个色号'),
          ],
        });
      if (url.includes('mode=use_stockpile'))
        return response({
          mode: 'use_stockpile',
          evaluatedCount: 2,
          items: [recommendation(cardId, '囤积色大图', 0, 620, '可消耗 620 颗高于提醒线的库存豆')],
        });
      return response({ error: { message: `unexpected ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter initialEntries={['/patterns']}>
        <AuthProvider client={new FakeAuthClient({ id: 'user-1', email: 'maker@example.com' })}>
          <PatternLibraryPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('所有色号库存都够，可以立即制作')).toBeInTheDocument();
    expect(screen.getByLabelText('库存推荐图纸')).not.toHaveTextContent('只缺少量的图');

    fireEvent.click(screen.getByRole('button', { name: /^补豆最少/ }));
    expect(await screen.findByText('只需补 20 颗，涉及 1 个色号')).toBeInTheDocument();
    expect(screen.getByLabelText('库存推荐图纸')).toHaveTextContent('只缺少量的图');

    fireEvent.click(screen.getByRole('button', { name: /^优先消耗囤积色/ }));
    expect(await screen.findByText('可消耗 620 颗高于提醒线的库存豆')).toBeInTheDocument();
    expect(screen.getByLabelText('优先消耗色号')).toHaveTextContent('B14 400 颗');
    expect(screen.getByLabelText('优先消耗色号')).toHaveTextContent('C6 220 颗');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/pattern-card-recommendations?limit=10&mode=use_stockpile',
      expect.objectContaining({ headers: { authorization: 'Bearer fake-access-token' } }),
    );

    fireEvent.change(screen.getByLabelText('图纸总颗数筛选'), {
      target: { value: 'over_1500' },
    });
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/api/pattern-card-recommendations?limit=10&mode=use_stockpile&minTotalBeads=1501',
        expect.objectContaining({ headers: { authorization: 'Bearer fake-access-token' } }),
      ),
    );
  });
});
