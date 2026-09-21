import type { PaletteColor, PatternGridAnalysisResult } from '@beadflow/shared-types';

export type ClusterMapping = {
  clusterId: number;
  paletteColorId: string;
  confirmed: boolean;
};

export type ClusterReviewIssue = {
  code: 'unmapped' | 'unconfirmed' | 'duplicate_color' | 'count_mismatch';
  message: string;
};

export function initialClusterMappings(
  result: PatternGridAnalysisResult,
): readonly ClusterMapping[] {
  return result.colorClusters.map((cluster) => ({
    clusterId: cluster.clusterId,
    paletteColorId: '',
    confirmed: false,
  }));
}

export function clusterReviewIssues(
  result: PatternGridAnalysisResult,
  mappings: readonly ClusterMapping[],
  paletteColors: readonly PaletteColor[],
): readonly ClusterReviewIssue[] {
  const issues: ClusterReviewIssue[] = [];
  const validIds = new Set(paletteColors.map((color) => color.id));
  const confirmedColors = new Map<string, number>();

  for (const cluster of result.colorClusters) {
    const mapping = mappings.find((item) => item.clusterId === cluster.clusterId);
    if (!mapping?.paletteColorId || !validIds.has(mapping.paletteColorId)) {
      issues.push({
        code: 'unmapped',
        message: `颜色簇 ${cluster.clusterId + 1} 尚未选择真实 MARD 色号。`,
      });
      continue;
    }
    if (!mapping.confirmed) {
      issues.push({
        code: 'unconfirmed',
        message: `颜色簇 ${cluster.clusterId + 1} 需要按簇确认。`,
      });
    }
    confirmedColors.set(
      mapping.paletteColorId,
      (confirmedColors.get(mapping.paletteColorId) ?? 0) + 1,
    );
  }

  for (const [paletteColorId, count] of Array.from(confirmedColors.entries())) {
    if (count > 1) {
      const code =
        paletteColors.find((color) => color.id === paletteColorId)?.code ?? paletteColorId;
      issues.push({
        code: 'duplicate_color',
        message: `${code} 被多个颜色簇占用，请合并或改选后再保存。`,
      });
    }
  }

  const mappedTotal = result.colorClusters.reduce((sum, cluster) => sum + cluster.cellCount, 0);
  if (mappedTotal !== result.occupiedCount) {
    issues.push({
      code: 'count_mismatch',
      message: '颜色簇数量之和必须等于确定占用数，当前结果不能保存。',
    });
  }

  return issues;
}

export function mappedMaterialItems(
  result: PatternGridAnalysisResult,
  mappings: readonly ClusterMapping[],
): readonly { paletteColorId: string; quantity: number }[] {
  return result.colorClusters.map((cluster) => {
    const mapping = mappings.find((item) => item.clusterId === cluster.clusterId);
    if (!mapping?.paletteColorId) {
      throw new Error(`颜色簇 ${cluster.clusterId + 1} 尚未映射色号。`);
    }
    return {
      paletteColorId: mapping.paletteColorId,
      quantity: cluster.cellCount,
    };
  });
}
