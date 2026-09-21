export type LabColor = {
  l: number;
  a: number;
  b: number;
};

export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export type PaletteColor = {
  id: string;
  paletteId: string;
  code: string;
  name?: string;
  hex: string;
  rgb: RgbColor;
  lab: LabColor;
  isActive: boolean;
};

export type Palette = {
  id: string;
  name: string;
  version: string;
  colors: readonly PaletteColor[];
};

export type InventoryQuantityConfidence = 'exact' | 'estimated';

export type InventoryItem = {
  id: string;
  userId: string;
  paletteColorId: string;
  quantity: number;
  quantityConfidence: InventoryQuantityConfidence;
  lowStockThreshold?: number;
  updatedAt: string;
};

export type InventoryTransactionReason =
  'purchase' | 'manual_adjustment' | 'pattern_consumption' | 'pattern_rollback';

export type InventoryTransaction = {
  id: string;
  userId: string;
  paletteColorId: string;
  delta: number;
  reason: InventoryTransactionReason;
  createdAt: string;
};

export type MaterialBalanceResult = {
  paletteColorId: string;
  code: string;
  name?: string;
  hex: string;
  family: string;
  required: number;
  reserved: number;
  netRequired: number;
  available: number;
  shortage: number;
  remaining: number;
  quantityConfidence: InventoryQuantityConfidence;
};

export type PurchaseListGroup = {
  family: string;
  items: readonly MaterialBalanceResult[];
};

export type PatternMaterialReviewState = 'pending' | 'confirmed' | 'edited' | 'added';

export type PatternMaterialEvidenceRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PatternMaterialDraftItem = {
  id: string;
  paletteColorId: string;
  quantity: number;
  rawText?: string;
  confidence?: number;
  evidenceRegion?: PatternMaterialEvidenceRegion;
  recognitionSource: 'direct' | 'compact' | 'spatial' | 'manual';
  reviewState: PatternMaterialReviewState;
};

export type PatternMaterialReviewDraft = {
  patternCardId: string;
  revision: number;
  status: 'needs_review' | 'confirmed';
  declaredTotal?: number;
  recognizedTotal: number;
  conflicts: readonly string[];
  items: readonly PatternMaterialDraftItem[];
  updatedAt: string;
};

export type PatternMaterialVersion = {
  id: string;
  patternCardId: string;
  version: number;
  totalQuantity: number;
  items: readonly Omit<PatternMaterialDraftItem, 'reviewState'>[];
  confirmedAt: string;
};

export type PatternCardUploadResult = {
  patternCardId: string;
  name: string;
  sourceImageUrl: string;
  sourceMimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  deduplicated: boolean;
  review: PatternMaterialReviewDraft;
};

export type PatternLegendCropSuggestion = {
  cropYStart: number;
  cropYEnd: number;
  confidence: number;
  method: 'color_bar_rows' | 'broad_lower_band';
  needsManualReview: boolean;
  evidenceBoxCount: number;
};

export type PatternGridCellState = 'occupied' | 'empty' | 'uncertain';

export type PatternGridCellReview = {
  row: number;
  column: number;
  state: PatternGridCellState;
  reason: string;
  clusterId?: number;
};

export type PatternGridColorCluster = {
  clusterId: number;
  cellCount: number;
  medianLab: { lightness: number; a: number; b: number };
  emptyReferenceDistance: number;
};

export type PatternGridAnalysisResult = {
  status: 'needs_review';
  gridDetected: boolean;
  rowCount?: number;
  columnCount?: number;
  occupiedCount: number;
  emptyCount: number;
  uncertainCount: number;
  cells: readonly PatternGridCellReview[];
  colorClusters: readonly PatternGridColorCluster[];
  reasons: readonly string[];
  requiresUserConfirmation: true;
  inventoryMutated: false;
};

export type PatternCardSource = Pick<
  PatternCardUploadResult,
  'patternCardId' | 'name' | 'sourceMimeType'
> &
  (
    | { sourceImageUrl: string; sourceDeletedAt?: never }
    | { sourceImageUrl?: never; sourceDeletedAt: string }
  );

export type PatternCardSourceDeletionResult = {
  patternCardId: string;
  sourceDeletedAt: string;
  alreadyDeleted: boolean;
};

export type PersonalDataExport = {
  schemaVersion: '1.0';
  generatedAt: string;
  account: {
    id: string;
    email: string | null;
    createdAt: string;
  };
  currentProduct: Record<string, readonly Record<string, unknown>[]>;
  legacyProduct: Record<string, readonly Record<string, unknown>[]>;
  referenceData: {
    paletteColors: readonly Record<string, unknown>[];
  };
  notices: readonly string[];
};

export type PatternCardListItem = PatternCardSource & {
  status: 'needs_review' | 'confirmed';
  declaredTotal?: number;
  recognizedTotal: number;
  colorCount: number;
  pendingItemCount: number;
  conflictCount: number;
  materialVersion: number;
  updatedAt: string;
};

export type PatternCardListResult = {
  items: readonly PatternCardListItem[];
};

export type PatternCardMaterialSummary = {
  patternCardId: string;
  materialVersion: number;
  totalBeads: number;
  colorCount: number;
  confirmedAt: string;
};

export type PatternCardInventoryCheckResult = {
  patternCard: PatternCardMaterialSummary;
  balances: readonly PatternCardInventoryBalance[];
  totals: {
    required: number;
    reservedForThisCard: number;
    reservedElsewhere: number;
    shortage: number;
    colorsReady: number;
    colorsShort: number;
  };
  hasEstimatedInventory: boolean;
};

export type PatternCardInventoryBalance = MaterialBalanceResult & {
  onHand: number;
  reservedForThisCard: number;
  reservedElsewhere: number;
  freelyAvailable: number;
};

export type PatternCardPurchaseListResult = PatternCardInventoryCheckResult & {
  items: readonly MaterialBalanceResult[];
  groups: readonly PurchaseListGroup[];
  copyText: string;
  csv: string;
};

export type CombinedPatternCardPurchaseListResult = {
  patternCards: readonly {
    patternCardId: string;
    name: string;
    materialVersion: number;
    totalBeads: number;
    colorCount: number;
    confirmedAt: string;
  }[];
  balances: readonly MaterialBalanceResult[];
  totals: {
    patternCards: number;
    required: number;
    shortage: number;
    colorsReady: number;
    colorsShort: number;
  };
  hasEstimatedInventory: boolean;
  items: readonly MaterialBalanceResult[];
  groups: readonly PurchaseListGroup[];
  copyText: string;
  csv: string;
};

export type PatternCardMaterialCandidate = {
  patternCardId: string;
  name: string;
  materialVersion: number;
  totalBeads: number;
  confirmedAt: string;
  items: readonly {
    paletteColorId: string;
    quantity: number;
  }[];
};

export type PatternCardRecommendationMode = 'ready' | 'least_shortage' | 'use_stockpile';

export type PatternCardRecommendationFilter = {
  minTotalBeads?: number;
  maxTotalBeads?: number;
};

export type PatternCardStockpileUse = {
  paletteColorId: string;
  code: string;
  hex: string;
  quantity: number;
};

export type PatternCardRecommendation = {
  patternCardId: string;
  name: string;
  materialVersion: number;
  totalBeads: number;
  colorCount: number;
  confirmedAt: string;
  canMake: boolean;
  score: number;
  coverageRatio: number;
  safeCoverageRatio: number;
  shortageTotal: number;
  shortageColorCount: number;
  lowStockAfterBuildCount: number;
  stockpileUsageTotal: number;
  topStockpileUses: readonly PatternCardStockpileUse[];
  hasEstimatedInventory: boolean;
  topShortages: readonly MaterialBalanceResult[];
  reasons: readonly string[];
};

export type PatternCardRecommendationResult = {
  mode: PatternCardRecommendationMode;
  items: readonly PatternCardRecommendation[];
  evaluatedCount: number;
};

export type PatternCardReservationItem = {
  paletteColorId: string;
  quantity: number;
};

export type PatternCardReservation = {
  id: string;
  patternCardId: string;
  materialVersion: number;
  idempotencyKey: string;
  status: 'active' | 'released' | 'consumed';
  totalQuantity: number;
  items: readonly PatternCardReservationItem[];
  createdAt: string;
  releasedAt?: string;
  consumedAt?: string;
};

export type PatternCardConsumptionItem = {
  paletteColorId: string;
  quantity: number;
  balanceAfter: number;
};

export type PatternCardConsumption = {
  id: string;
  patternCardId: string;
  materialVersion: number;
  idempotencyKey: string;
  status: 'applied' | 'reverted';
  totalQuantity: number;
  items: readonly PatternCardConsumptionItem[];
  createdAt: string;
  undoExpiresAt: string;
  revertedAt?: string;
  undoAvailable: boolean;
};

export type PatternCardConsumptionHistoryItem = PatternCardConsumption & {
  patternCardName: string;
};

export type PatternCardConsumptionHistoryResult = {
  items: readonly PatternCardConsumptionHistoryItem[];
};
