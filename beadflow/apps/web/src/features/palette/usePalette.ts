import { parsePalette } from '@beadflow/palette-engine';
import type { Palette } from '@beadflow/shared-types';
import { useQuery } from '@tanstack/react-query';

async function loadPalette(): Promise<Palette> {
  const response = await fetch('/palettes/mard221.json');
  if (!response.ok) {
    throw new Error(`MARD 221 色卡加载失败（${response.status}）。`);
  }
  return parsePalette(await response.text(), 221).palette;
}

export function usePalette() {
  return useQuery({
    queryKey: ['palette', 'mard221'],
    queryFn: loadPalette,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
