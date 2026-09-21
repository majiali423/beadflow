import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { parsePalette } from '@beadflow/palette-engine';

import { buildApp } from './app.js';
import { SupabasePersonalDataExportRepository } from './dataExport.js';
import { SupabaseInventoryRepository } from './inventory.js';
import { SupabasePatternCardReviewRepository } from './patternCardReviews.js';
import {
  HttpPatternLegendClient,
  SupabasePatternCardUploadRepository,
} from './patternCardUploads.js';

const port = Number.parseInt(process.env.API_PORT ?? '3001', 10);
const host = process.env.API_HOST ?? '0.0.0.0';
const palettePath =
  process.env.MARD_PALETTE_PATH ??
  resolve(
    process.cwd(),
    basename(process.cwd()) === 'api'
      ? '../../assets/palettes/mard221.json'
      : 'assets/palettes/mard221.json',
  );
const palette = parsePalette(await readFile(palettePath, 'utf8'), 221).palette;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const inventoryRepository =
  supabaseUrl && supabaseAnonKey
    ? new SupabaseInventoryRepository(supabaseUrl, supabaseAnonKey)
    : null;
const dataExportRepository =
  supabaseUrl && supabaseAnonKey
    ? new SupabasePersonalDataExportRepository(supabaseUrl, supabaseAnonKey)
    : null;
const patternCardReviewRepository =
  supabaseUrl && supabaseAnonKey
    ? new SupabasePatternCardReviewRepository(supabaseUrl, supabaseAnonKey)
    : null;
const cvServiceUrl = process.env.CV_SERVICE_URL ?? 'http://127.0.0.1:8001';
const patternCardUploadRepository =
  supabaseUrl && supabaseAnonKey
    ? new SupabasePatternCardUploadRepository(supabaseUrl, supabaseAnonKey)
    : null;
const patternLegendClient = new HttpPatternLegendClient(cvServiceUrl);
const app = buildApp({
  dataExport: {
    repository: dataExportRepository,
  },
  inventory: {
    validPaletteColorIds: new Set(palette.colors.map((color) => color.id)),
    repository: inventoryRepository,
  },
  patternCardReviews: {
    validPaletteColorIds: new Set(palette.colors.map((color) => color.id)),
    paletteColors: palette.colors,
    inventoryRepository,
    repository: patternCardReviewRepository,
  },
  patternCardUploads: {
    paletteColors: palette.colors,
    repository: patternCardUploadRepository,
    cvClient: patternLegendClient,
  },
});

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
