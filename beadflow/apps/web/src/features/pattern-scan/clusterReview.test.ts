import { parsePalette } from '@beadflow/palette-engine';
import type { PatternGridAnalysisResult } from '@beadflow/shared-types';
import { expect, test } from 'vitest';

import { clusterReviewIssues, initialClusterMappings, mappedMaterialItems } from './clusterReview';

const palette = parsePalette(
  JSON.stringify({
    name: 'MARD 221',
    version: '2026-07-user-verified',
    colors: [
      { code: 'A1', hex: '#FAF5CD', rgb: [250, 245, 205] },
      { code: 'G16', hex: '#5B5B5B', rgb: [91, 91, 91] },
    ],
  }),
  2,
).palette;

const result: PatternGridAnalysisResult = {
  status: 'needs_review',
  gridDetected: true,
  rowCount: 2,
  columnCount: 2,
  occupiedCount: 3,
  emptyCount: 0,
  uncertainCount: 1,
  cells: [],
  colorClusters: [
    {
      clusterId: 0,
      cellCount: 2,
      medianLab: { lightness: 80, a: 128, b: 128 },
      emptyReferenceDistance: 10,
    },
    {
      clusterId: 1,
      cellCount: 1,
      medianLab: { lightness: 40, a: 140, b: 130 },
      emptyReferenceDistance: 40,
    },
  ],
  reasons: [],
  requiresUserConfirmation: true,
  inventoryMutated: false,
};

test('requires a unique confirmed MARD code for every occupied cluster', () => {
  const mappings = initialClusterMappings(result).map((item, index) => ({
    ...item,
    paletteColorId: palette.colors[0]!.id,
    confirmed: index === 0,
  }));
  const issues = clusterReviewIssues(result, mappings, palette.colors);
  expect(issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(['unconfirmed', 'duplicate_color']),
  );
});

test('builds material items only from mapped cluster counts', () => {
  const mappings = [
    { clusterId: 0, paletteColorId: palette.colors[0]!.id, confirmed: true },
    { clusterId: 1, paletteColorId: palette.colors[1]!.id, confirmed: true },
  ];
  expect(clusterReviewIssues(result, mappings, palette.colors)).toEqual([]);
  expect(mappedMaterialItems(result, mappings)).toEqual([
    { paletteColorId: palette.colors[0]!.id, quantity: 2 },
    { paletteColorId: palette.colors[1]!.id, quantity: 1 },
  ]);
});
