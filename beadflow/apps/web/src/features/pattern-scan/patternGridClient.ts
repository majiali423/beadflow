import type { PatternGridAnalysisResult } from '@beadflow/shared-types';

type ApiErrorPayload = { error?: { code?: string; message?: string } };

export class PatternGridApiError extends Error {
  constructor(
    message: string,
    readonly code = 'PATTERN_GRID_REQUEST_FAILED',
  ) {
    super(message);
    this.name = 'PatternGridApiError';
  }
}

export async function analyzePatternGrid(
  file: File,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<PatternGridAnalysisResult> {
  const response = await fetcher('/api/pattern-grid/analyze', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': file.type,
    },
    body: file,
  });
  const payload = (await response.json()) as PatternGridAnalysisResult | ApiErrorPayload;
  if (!response.ok) {
    const apiError = payload as ApiErrorPayload;
    throw new PatternGridApiError(
      apiError.error?.message ?? '图纸分析失败，没有修改库存。',
      apiError.error?.code,
    );
  }
  return payload as PatternGridAnalysisResult;
}
