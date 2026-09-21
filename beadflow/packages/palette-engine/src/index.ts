import type { LabColor, Palette, PaletteColor, RgbColor } from '@beadflow/shared-types';
import { z } from 'zod';

const hexPattern = /^#[0-9A-F]{6}$/;

const rawColorSchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  hex: z.string().regex(hexPattern),
  rgb: z.tuple([
    z.number().int().min(0).max(255),
    z.number().int().min(0).max(255),
    z.number().int().min(0).max(255),
  ]),
});

const rawPaletteSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  colors: z.array(rawColorSchema).min(1),
});

export class PaletteValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = 'PaletteValidationError';
  }
}

export type PaletteImportReport = {
  palette: Palette;
  colorCount: number;
  warnings: readonly string[];
};

function paletteIdFor(name: string, version: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${version}`;
}

function rgbFromHex(hex: string): RgbColor {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

export function parsePalette(source: string, expectedColorCount?: number): PaletteImportReport {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new PaletteValidationError('色卡不是合法 JSON。', ['invalid_json']);
  }

  const result = rawPaletteSchema.safeParse(json);
  if (!result.success) {
    throw new PaletteValidationError(
      '色卡结构校验失败。',
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const issues: string[] = [];
  const codes = new Set<string>();

  for (const color of result.data.colors) {
    if (codes.has(color.code)) {
      issues.push(`duplicate_code:${color.code}`);
    }
    codes.add(color.code);

    const fromHex = rgbFromHex(color.hex);
    if (fromHex.r !== color.rgb[0] || fromHex.g !== color.rgb[1] || fromHex.b !== color.rgb[2]) {
      issues.push(`hex_rgb_mismatch:${color.code}`);
    }
  }

  if (expectedColorCount !== undefined && result.data.colors.length !== expectedColorCount) {
    issues.push(`color_count:${result.data.colors.length}:expected:${expectedColorCount}`);
  }

  if (issues.length > 0) {
    throw new PaletteValidationError('色卡内容校验失败。', issues);
  }

  const paletteId = paletteIdFor(result.data.name, result.data.version);
  const colors: PaletteColor[] = result.data.colors.map((color) => {
    const rgb = { r: color.rgb[0], g: color.rgb[1], b: color.rgb[2] };
    return {
      id: `${paletteId}:${color.code}`,
      paletteId,
      code: color.code,
      ...(color.name ? { name: color.name } : {}),
      hex: color.hex,
      rgb,
      lab: rgbToLab(rgb),
      isActive: true,
    };
  });

  return {
    palette: {
      id: paletteId,
      name: result.data.name,
      version: result.data.version,
      colors,
    },
    colorCount: colors.length,
    warnings: [],
  };
}

function srgbChannelToLinear(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

export function rgbToLab(rgb: RgbColor): LabColor {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);

  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) / 1;
  const zValue = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;

  const pivot = (value: number) =>
    value > 216 / 24389 ? Math.cbrt(value) : ((24389 / 27) * value) / 116 + 16 / 116;

  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(zValue);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number): number {
  const result = (value * 180) / Math.PI;
  return result < 0 ? result + 360 : result;
}

export function deltaE2000(left: LabColor, right: LabColor): number {
  const c1 = Math.hypot(left.a, left.b);
  const c2 = Math.hypot(right.a, right.b);
  const averageC = (c1 + c2) / 2;
  const averageC7 = Math.pow(averageC, 7);
  const g = 0.5 * (1 - Math.sqrt(averageC7 / (averageC7 + Math.pow(25, 7))));
  const a1Prime = (1 + g) * left.a;
  const a2Prime = (1 + g) * right.a;
  const c1Prime = Math.hypot(a1Prime, left.b);
  const c2Prime = Math.hypot(a2Prime, right.b);
  const h1Prime = radiansToDegrees(Math.atan2(left.b, a1Prime));
  const h2Prime = radiansToDegrees(Math.atan2(right.b, a2Prime));

  const deltaLPrime = right.l - left.l;
  const deltaCPrime = c2Prime - c1Prime;
  const hueDifference = h2Prime - h1Prime;
  const deltaHPrimeAngle =
    c1Prime * c2Prime === 0
      ? 0
      : Math.abs(hueDifference) <= 180
        ? hueDifference
        : hueDifference > 180
          ? hueDifference - 360
          : hueDifference + 360;
  const deltaHPrime =
    2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(degreesToRadians(deltaHPrimeAngle / 2));

  const averageLPrime = (left.l + right.l) / 2;
  const averageCPrime = (c1Prime + c2Prime) / 2;
  const averageHPrime =
    c1Prime * c2Prime === 0
      ? h1Prime + h2Prime
      : Math.abs(h1Prime - h2Prime) <= 180
        ? (h1Prime + h2Prime) / 2
        : h1Prime + h2Prime < 360
          ? (h1Prime + h2Prime + 360) / 2
          : (h1Prime + h2Prime - 360) / 2;

  const t =
    1 -
    0.17 * Math.cos(degreesToRadians(averageHPrime - 30)) +
    0.24 * Math.cos(degreesToRadians(2 * averageHPrime)) +
    0.32 * Math.cos(degreesToRadians(3 * averageHPrime + 6)) -
    0.2 * Math.cos(degreesToRadians(4 * averageHPrime - 63));
  const deltaTheta = 30 * Math.exp(-Math.pow((averageHPrime - 275) / 25, 2));
  const averageCPrime7 = Math.pow(averageCPrime, 7);
  const rC = 2 * Math.sqrt(averageCPrime7 / (averageCPrime7 + Math.pow(25, 7)));
  const sL =
    1 + (0.015 * Math.pow(averageLPrime - 50, 2)) / Math.sqrt(20 + Math.pow(averageLPrime - 50, 2));
  const sC = 1 + 0.045 * averageCPrime;
  const sH = 1 + 0.015 * averageCPrime * t;
  const rT = -Math.sin(degreesToRadians(2 * deltaTheta)) * rC;

  const lTerm = deltaLPrime / sL;
  const cTerm = deltaCPrime / sC;
  const hTerm = deltaHPrime / sH;
  return Math.sqrt(lTerm * lTerm + cTerm * cTerm + hTerm * hTerm + rT * cTerm * hTerm);
}

export function nearestPaletteColors(
  target: LabColor,
  colors: readonly PaletteColor[],
  limit = 1,
): readonly { color: PaletteColor; distance: number }[] {
  if (colors.length === 0) {
    throw new Error('色卡不能为空。');
  }
  return colors
    .map((color) => ({ color, distance: deltaE2000(target, color.lab) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.max(1, limit));
}
