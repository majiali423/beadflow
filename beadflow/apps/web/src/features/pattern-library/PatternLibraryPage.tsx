import { parsePalette } from '@beadflow/palette-engine';
import type {
  CombinedPatternCardPurchaseListResult,
  PatternCardConsumption,
  PatternCardConsumptionHistoryItem,
  PatternCardInventoryCheckResult,
  PatternCardListItem,
  PatternCardPurchaseListResult,
  PatternCardRecommendation,
  PatternCardRecommendationMode,
  PatternCardReservation,
  PatternCardSource,
  PatternMaterialDraftItem,
  PatternMaterialReviewDraft,
} from '@beadflow/shared-types';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import mardPaletteSource from '../../../../../assets/palettes/mard221.json';

import { downloadPersonalDataExport, loadPersonalDataExport } from '../account/accountExportClient';
import { useAuth } from '../auth/AuthContext';
import {
  checkPatternCardInventory,
  consumePatternCardInventory,
  confirmPatternCardReview,
  deletePatternCardSource,
  listPatternCards,
  loadCombinedPatternCardPurchaseList,
  loadPatternCardReview,
  loadPatternCardConsumptionHistory,
  loadPatternCardRecommendations,
  loadPatternCardPurchaseList,
  loadLatestPatternCardConsumption,
  loadActivePatternCardReservation,
  loadPatternCardSource,
  PatternCardApiError,
  releasePatternCardReservation,
  reservePatternCardInventory,
  savePatternCardReview,
  undoPatternCardConsumption,
} from './patternCardClient';

function downloadPurchaseCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const palette = parsePalette(JSON.stringify(mardPaletteSource), 221).palette;
const colorsById = new Map(palette.colors.map((color) => [color.id, color]));

function sumItems(items: readonly PatternMaterialDraftItem[]): number {
  return items.reduce((total, item) => total + item.quantity, 0);
}

export function PatternLibraryPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [declaredTotal, setDeclaredTotal] = useState('');
  const [source, setSource] = useState<PatternCardSource | null>(null);
  const [review, setReview] = useState<PatternMaterialReviewDraft | null>(null);
  const [items, setItems] = useState<readonly PatternMaterialDraftItem[]>([]);
  const [conflicts, setConflicts] = useState<readonly string[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [addColorId, setAddColorId] = useState('');
  const [addQuantity, setAddQuantity] = useState('1');
  const [acceptMismatch, setAcceptMismatch] = useState(false);
  const [inventoryResult, setInventoryResult] = useState<PatternCardInventoryCheckResult | null>(
    null,
  );
  const [catalog, setCatalog] = useState<readonly PatternCardListItem[]>([]);
  const [recommendations, setRecommendations] = useState<readonly PatternCardRecommendation[]>([]);
  const [recommendationMode, setRecommendationMode] =
    useState<PatternCardRecommendationMode>('ready');
  const [recommendationSize, setRecommendationSize] = useState<
    'all' | 'up_to_500' | '501_to_1500' | 'over_1500'
  >('all');
  const [recommendationLoading, setRecommendationLoading] = useState(true);
  const [recommendationError, setRecommendationError] = useState('');
  const [consumptionHistory, setConsumptionHistory] = useState<
    readonly PatternCardConsumptionHistoryItem[]
  >([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [purchaseList, setPurchaseList] = useState<PatternCardPurchaseListResult | null>(null);
  const [purchaseWorking, setPurchaseWorking] = useState(false);
  const [purchaseMessage, setPurchaseMessage] = useState('');
  const [selectedCardIds, setSelectedCardIds] = useState<readonly string[]>([]);
  const [combinedPurchaseList, setCombinedPurchaseList] =
    useState<CombinedPatternCardPurchaseListResult | null>(null);
  const [combinedPurchaseWorking, setCombinedPurchaseWorking] = useState(false);
  const [combinedPurchaseMessage, setCombinedPurchaseMessage] = useState('');
  const [consumption, setConsumption] = useState<PatternCardConsumption | null>(null);
  const [reservation, setReservation] = useState<PatternCardReservation | null>(null);
  const [reservationWorking, setReservationWorking] = useState(false);
  const [reservationOperationKey, setReservationOperationKey] = useState<string | null>(null);
  const [consumeConfirming, setConsumeConfirming] = useState(false);
  const [consumeWorking, setConsumeWorking] = useState(false);
  const [consumeOperationKey, setConsumeOperationKey] = useState<string | null>(null);
  const [sourceDeleteConfirming, setSourceDeleteConfirming] = useState(false);
  const [sourceDeleteWorking, setSourceDeleteWorking] = useState(false);
  const [exportWorking, setExportWorking] = useState(false);
  const [working, setWorking] = useState(false);
  const [showPriorityOnly, setShowPriorityOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const cardId = searchParams.get('card');

  useEffect(() => {
    if (cardId) return;
    let active = true;
    setCatalogLoading(true);
    setCatalogError('');
    void (async () => {
      try {
        const token = await auth.client?.getAccessToken();
        if (!token) throw new PatternCardApiError('登录状态已失效。', 'AUTH_REQUIRED');
        const [library, history] = await Promise.all([
          listPatternCards(token),
          loadPatternCardConsumptionHistory(token, 20),
        ]);
        if (!active) return;
        setCatalog(library.items);
        setConsumptionHistory(history.items);
      } catch (catalogLoadError) {
        if (active) {
          setCatalogError(
            catalogLoadError instanceof Error ? catalogLoadError.message : '图纸库加载失败。',
          );
        }
      } finally {
        if (active) setCatalogLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [auth.client, cardId]);

  useEffect(() => {
    if (cardId) return;
    let active = true;
    setRecommendationLoading(true);
    setRecommendationError('');
    void (async () => {
      try {
        const token = await auth.client?.getAccessToken();
        if (!token) throw new PatternCardApiError('登录状态已失效。', 'AUTH_REQUIRED');
        const totalBeadsFilter =
          recommendationSize === 'up_to_500'
            ? { maxTotalBeads: 500 }
            : recommendationSize === '501_to_1500'
              ? { minTotalBeads: 501, maxTotalBeads: 1_500 }
              : recommendationSize === 'over_1500'
                ? { minTotalBeads: 1_501 }
                : {};
        const ranked = await loadPatternCardRecommendations(
          token,
          recommendationMode,
          10,
          totalBeadsFilter,
        );
        if (active) setRecommendations(ranked.items);
      } catch (rankError) {
        if (active) {
          setRecommendations([]);
          setRecommendationError(
            rankError instanceof Error ? rankError.message : '库存推荐加载失败。',
          );
        }
      } finally {
        if (active) setRecommendationLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [auth.client, cardId, recommendationMode, recommendationSize]);

  useEffect(() => {
    if (!cardId) return;
    let active = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const accessToken = await auth.client?.getAccessToken();
        if (!accessToken) throw new PatternCardApiError('登录状态已失效。', 'AUTH_REQUIRED');
        const [loadedReview, loadedSource] = await Promise.all([
          loadPatternCardReview(cardId, accessToken),
          loadPatternCardSource(cardId, accessToken),
        ]);
        const loadedInventory =
          loadedReview.status === 'confirmed'
            ? await checkPatternCardInventory(cardId, accessToken)
            : null;
        const [loadedConsumption, loadedReservation] =
          loadedReview.status === 'confirmed'
            ? await Promise.all([
                loadLatestPatternCardConsumption(cardId, accessToken),
                loadActivePatternCardReservation(cardId, accessToken),
              ])
            : [null, null];
        if (!active) return;
        setReview(loadedReview);
        setItems(loadedReview.items);
        setConflicts(loadedReview.conflicts);
        setDeclaredTotal(loadedReview.declaredTotal?.toString() ?? '');
        setSource(loadedSource);
        setInventoryResult(loadedInventory);
        setConsumption(loadedConsumption);
        setReservation(loadedReservation);
        setConsumeConfirming(false);
        setConsumeOperationKey(null);
        setSourceDeleteConfirming(false);
        setPurchaseList(null);
        setPurchaseMessage('');
        if (loadedReview.status === 'confirmed') {
          setMessage('正式材料版本已确认。以下材料与库存对比均为只读。');
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : '图纸加载失败。');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [auth.client, cardId]);

  const usedColorIds = useMemo(() => new Set(items.map((item) => item.paletteColorId)), [items]);
  const availableColors = palette.colors.filter((color) => !usedColorIds.has(color.id));
  const selectedItem = items.find((item) => item.id === selectedItemId);
  const recognizedTotal = sumItems(items);
  const pendingCount = items.filter((item) => item.reviewState === 'pending').length;
  const priorityReviewCount = items.filter(
    (item) => item.confidence !== undefined && item.confidence < 0.8,
  ).length;
  const visibleItems = showPriorityOnly
    ? items.filter((item) => item.confidence !== undefined && item.confidence < 0.8)
    : items;
  const isConfirmed = review?.status === 'confirmed';
  const totalMismatch =
    declaredTotal !== '' && Number(declaredTotal) > 0 && Number(declaredTotal) !== recognizedTotal;
  const recommendationByCardId = useMemo(
    () => new Map(recommendations.map((item) => [item.patternCardId, item])),
    [recommendations],
  );

  const accessToken = async () => {
    const token = await auth.client?.getAccessToken();
    if (!token) throw new PatternCardApiError('登录状态已失效。', 'AUTH_REQUIRED');
    return token;
  };

  const updateQuantity = (id: string, quantity: number) => {
    if (isConfirmed) return;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) return;
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? { ...item, quantity, reviewState: item.reviewState === 'added' ? 'added' : 'edited' }
          : item,
      ),
    );
    setInventoryResult(null);
  };

  const toggleConfirmed = (id: string) => {
    if (isConfirmed) return;
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              reviewState: item.reviewState === 'pending' ? 'confirmed' : item.reviewState,
            }
          : item,
      ),
    );
  };

  const addMaterial = () => {
    if (isConfirmed) return;
    const quantity = Number(addQuantity);
    if (!addColorId || !Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) {
      setError('请选择未使用的 MARD 色号，并填写 1–100000 的整数数量。');
      return;
    }
    const added: PatternMaterialDraftItem = {
      id: crypto.randomUUID(),
      paletteColorId: addColorId,
      quantity,
      recognitionSource: 'manual',
      reviewState: 'added',
    };
    setItems((current) => [...current, added]);
    setSelectedItemId(added.id);
    setAddColorId('');
    setAddQuantity('1');
    setError('');
  };

  const save = async (): Promise<PatternMaterialReviewDraft | null> => {
    if (!review || isConfirmed) return null;
    setWorking(true);
    setError('');
    try {
      const saved = await savePatternCardReview({
        patternCardId: review.patternCardId,
        expectedRevision: review.revision,
        ...(declaredTotal === '' ? {} : { declaredTotal: Number(declaredTotal) }),
        conflicts,
        items,
        accessToken: await accessToken(),
      });
      setReview(saved);
      setItems(saved.items);
      setConflicts(saved.conflicts);
      setMessage('复核草稿已安全保存。');
      return saved;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '复核草稿保存失败。');
      return null;
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    if (!review || isConfirmed) return;
    if (pendingCount > 0 || conflicts.length > 0) {
      setError('仍有待确认色号或未解决冲突，不能生成正式材料版本。');
      return;
    }
    if (totalMismatch && !acceptMismatch) {
      setError('材料合计与图纸声明总数不一致，请先核对并明确接受差异。');
      return;
    }
    const saved = await save();
    if (!saved) return;
    setWorking(true);
    setError('');
    try {
      await confirmPatternCardReview({
        patternCardId: saved.patternCardId,
        expectedRevision: saved.revision,
        acceptDeclaredTotalMismatch: acceptMismatch,
        accessToken: await accessToken(),
      });
      const inventory = await checkPatternCardInventory(saved.patternCardId, await accessToken());
      setInventoryResult(inventory);
      setConsumption(null);
      setPurchaseList(null);
      setPurchaseMessage('');
      setReview({ ...saved, status: 'confirmed' });
      setMessage('正式材料版本已确认。库存对比只读完成，没有扣减库存。');
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '材料确认失败。');
    } finally {
      setWorking(false);
    }
  };

  const generatePurchaseList = async () => {
    if (!review || review.status !== 'confirmed') return;
    setPurchaseWorking(true);
    setError('');
    setPurchaseMessage('');
    try {
      const generated = await loadPatternCardPurchaseList(
        review.patternCardId,
        await accessToken(),
      );
      setPurchaseList(generated);
      setPurchaseMessage(
        generated.items.length === 0
          ? '当前不需要补豆。'
          : `已生成 ${generated.items.length} 个缺豆色号的清单。`,
      );
    } catch (purchaseError) {
      setError(purchaseError instanceof Error ? purchaseError.message : '补豆清单生成失败。');
    } finally {
      setPurchaseWorking(false);
    }
  };

  const copyPurchaseList = async () => {
    if (!purchaseList) return;
    try {
      await navigator.clipboard.writeText(purchaseList.copyText);
      setPurchaseMessage('补豆清单已复制。');
    } catch {
      setError('浏览器没有允许复制，请展开下方文本后手动复制。');
    }
  };

  const toggleCardSelection = (patternCardId: string) => {
    if (!selectedCardIds.includes(patternCardId) && selectedCardIds.length >= 20) {
      setCatalogError('一次最多选择 20 张图纸，请先移除一张。');
      return;
    }
    setSelectedCardIds((current) =>
      current.includes(patternCardId)
        ? current.filter((id) => id !== patternCardId)
        : [...current, patternCardId],
    );
    setCombinedPurchaseList(null);
    setCombinedPurchaseMessage('');
  };

  const generateCombinedPurchaseList = async () => {
    if (selectedCardIds.length === 0) return;
    setCombinedPurchaseWorking(true);
    setCatalogError('');
    setCombinedPurchaseMessage('');
    try {
      const generated = await loadCombinedPatternCardPurchaseList(
        selectedCardIds,
        await accessToken(),
      );
      setCombinedPurchaseList(generated);
      setCombinedPurchaseMessage(
        generated.items.length === 0
          ? '这些图纸按当前库存都能制作，无需补豆。'
          : `已合并 ${generated.totals.patternCards} 张图纸，共缺 ${generated.totals.shortage} 颗。`,
      );
    } catch (combinedError) {
      setCatalogError(
        combinedError instanceof Error ? combinedError.message : '多图补豆清单生成失败。',
      );
    } finally {
      setCombinedPurchaseWorking(false);
    }
  };

  const copyCombinedPurchaseList = async () => {
    if (!combinedPurchaseList) return;
    try {
      await navigator.clipboard.writeText(combinedPurchaseList.copyText);
      setCombinedPurchaseMessage('多图补豆清单已复制。');
    } catch {
      setCatalogError('浏览器没有允许复制，请下载 CSV 或手动复制清单。');
    }
  };

  const consumeInventory = async () => {
    if (!review || review.status !== 'confirmed' || !inventoryResult) return;
    const operationKey = consumeOperationKey ?? crypto.randomUUID();
    setConsumeOperationKey(operationKey);
    setConsumeWorking(true);
    setError('');
    try {
      const token = await accessToken();
      const completed = await consumePatternCardInventory({
        patternCardId: review.patternCardId,
        idempotencyKey: operationKey,
        accessToken: token,
      });
      const refreshed = await checkPatternCardInventory(review.patternCardId, token);
      setConsumption(completed);
      setReservation(null);
      setInventoryResult(refreshed);
      setConsumeConfirming(false);
      setConsumeOperationKey(null);
      setPurchaseList(null);
      setMessage(
        `已按 ${completed.items.length} 个色号扣减 ${completed.totalQuantity} 颗。10 分钟内可以撤销。`,
      );
    } catch (consumeError) {
      setError(consumeError instanceof Error ? consumeError.message : '库存扣减失败。');
    } finally {
      setConsumeWorking(false);
    }
  };

  const undoConsumption = async () => {
    if (!consumption?.undoAvailable) return;
    setConsumeWorking(true);
    setError('');
    try {
      const token = await accessToken();
      const undone = await undoPatternCardConsumption(consumption.id, token);
      const refreshed = await checkPatternCardInventory(consumption.patternCardId, token);
      setConsumption(undone);
      setInventoryResult(refreshed);
      setMessage(`已撤销本次扣减，${undone.totalQuantity} 颗库存已全部恢复。`);
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : '撤销库存扣减失败。');
    } finally {
      setConsumeWorking(false);
    }
  };

  const reserveInventory = async () => {
    if (!review || review.status !== 'confirmed' || !inventoryResult || reservation) return;
    const operationKey = reservationOperationKey ?? crypto.randomUUID();
    setReservationOperationKey(operationKey);
    setReservationWorking(true);
    setError('');
    try {
      const token = await accessToken();
      const created = await reservePatternCardInventory({
        patternCardId: review.patternCardId,
        idempotencyKey: operationKey,
        accessToken: token,
      });
      const refreshed = await checkPatternCardInventory(review.patternCardId, token);
      setReservation(created);
      setInventoryResult(refreshed);
      setReservationOperationKey(null);
      setPurchaseList(null);
      setMessage(`已加入待做并预留 ${created.totalQuantity} 颗；实际库存尚未扣减。`);
    } catch (reservationError) {
      setError(reservationError instanceof Error ? reservationError.message : '加入待做失败。');
    } finally {
      setReservationWorking(false);
    }
  };

  const releaseReservation = async () => {
    if (!reservation || reservation.status !== 'active') return;
    setReservationWorking(true);
    setError('');
    try {
      const token = await accessToken();
      await releasePatternCardReservation(reservation.id, token);
      const refreshed = await checkPatternCardInventory(reservation.patternCardId, token);
      setReservation(null);
      setInventoryResult(refreshed);
      setMessage('已取消待做并释放预留；实际库存没有变化。');
    } catch (reservationError) {
      setError(reservationError instanceof Error ? reservationError.message : '取消待做失败。');
    } finally {
      setReservationWorking(false);
    }
  };

  const deleteSourceImage = async () => {
    if (!source || !review || review.status !== 'confirmed' || source.sourceDeletedAt) return;
    setSourceDeleteWorking(true);
    setError('');
    try {
      const result = await deletePatternCardSource(review.patternCardId, await accessToken());
      setSource({
        patternCardId: source.patternCardId,
        name: source.name,
        sourceMimeType: source.sourceMimeType,
        sourceDeletedAt: result.sourceDeletedAt,
      });
      setImageSize({ width: 0, height: 0 });
      setSelectedItemId(null);
      setSourceDeleteConfirming(false);
      setMessage('原图已从私有存储删除；已确认材料、库存和制作历史均已保留。');
    } catch (sourceDeleteError) {
      setError(
        sourceDeleteError instanceof Error
          ? sourceDeleteError.message
          : '原图删除失败，资料卡和库存数据均未改动。',
      );
    } finally {
      setSourceDeleteWorking(false);
    }
  };

  const exportPersonalData = async () => {
    setExportWorking(true);
    setError('');
    try {
      const payload = await loadPersonalDataExport(await accessToken());
      downloadPersonalDataExport(payload);
      setMessage('个人数据 JSON 已生成。文件不包含密码、登录令牌或图片二进制。');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '个人数据导出失败。');
    } finally {
      setExportWorking(false);
    }
  };

  return (
    <section className="pattern-library-page">
      <header className="pattern-library-heading">
        <div>
              <p className="eyebrow">图纸库</p>
          <h1>收过的图纸</h1>
          <p>打开一张就能对照手头的豆、预留或开始拼。新图从「扫描图纸」进来。</p>
        </div>
        <div className="pattern-library-heading-actions">
          <button
            type="button"
            className="secondary-action"
            disabled={exportWorking}
            onClick={() => void exportPersonalData()}
          >
            {exportWorking ? '正在整理个人数据……' : '导出个人数据'}
          </button>
          {cardId ? (
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                setSearchParams({}, { replace: true });
                setReview(null);
                setSource(null);
                setItems([]);
                setConflicts([]);
                setInventoryResult(null);
                setPurchaseList(null);
                setPurchaseMessage('');
                setMessage('');
                setError('');
              }}
            >
              返回图纸库
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p className="form-alert" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="form-success" role="status">
          {message}
        </p>
      ) : null}
      {loading ? <p role="status">正在恢复图纸与复核草稿……</p> : null}

      {!cardId ? (
        <section className="pattern-catalog" aria-label="我的图纸库">
          <div className="pattern-catalog-heading">
            <div>
              <p className="eyebrow">我的图纸</p>
              <h2>手头这些豆，下一张做什么</h2>
              <p>按库存排一排。点开之前不会预留，也不会扣豆。</p>
            </div>
            {catalog.length > 0 ? (
              <div className="pattern-catalog-counts" aria-label="图纸库统计">
                <span>{catalog.length} 张图纸</span>
                <span>
                  {catalog.filter((item) => item.status === 'needs_review').length} 张待复核
                </span>
              </div>
            ) : null}
          </div>

          {catalogLoading ? <p role="status">正在核对图纸与库存……</p> : null}
          {catalogError ? (
            <p className="form-alert" role="alert">
              {catalogError}
            </p>
          ) : null}

          <div className="recommendation-mode-picker" aria-label="推荐方式">
            <button
              type="button"
              aria-pressed={recommendationMode === 'ready'}
              onClick={() => setRecommendationMode('ready')}
            >
              现在就能做
              <small>严格排除缺料图纸</small>
            </button>
            <button
              type="button"
              aria-pressed={recommendationMode === 'least_shortage'}
              onClick={() => setRecommendationMode('least_shortage')}
            >
              补豆最少
              <small>先比较缺少总颗数</small>
            </button>
            <button
              type="button"
              aria-pressed={recommendationMode === 'use_stockpile'}
              onClick={() => setRecommendationMode('use_stockpile')}
            >
              优先消耗囤积色
              <small>多用高于提醒线的库存</small>
            </button>
          </div>

          <label className="recommendation-size-filter">
            图纸总颗数
            <select
              aria-label="图纸总颗数筛选"
              value={recommendationSize}
              onChange={(event) =>
                setRecommendationSize(
                  event.target.value as 'all' | 'up_to_500' | '501_to_1500' | 'over_1500',
                )
              }
            >
              <option value="all">全部颗数</option>
              <option value="up_to_500">500 颗以内</option>
              <option value="501_to_1500">501–1500 颗</option>
              <option value="over_1500">1500 颗以上</option>
            </select>
            <small>按正式材料清单的总颗数筛选，不根据图片像素猜尺寸。</small>
          </label>

          {recommendationError ? (
            <p className="form-alert" role="alert">
              {recommendationError}
            </p>
          ) : null}
          {recommendationLoading ? <p role="status">正在按所选方式重新排序……</p> : null}

          {!catalogLoading && !recommendationLoading && recommendations.length > 0 ? (
            <div className="pattern-recommendation-list" aria-label="库存推荐图纸">
              {recommendations.slice(0, 3).map((item, index) => {
                const card = catalog.find(
                  (candidate) => candidate.patternCardId === item.patternCardId,
                );
                if (!card) return null;
                return (
                  <article key={item.patternCardId}>
                    <span className="pattern-rank">推荐 {index + 1}</span>
                    {card.sourceImageUrl ? (
                      <img src={card.sourceImageUrl} alt={`${card.name} 缩略图`} />
                    ) : (
                      <div
                        className="pattern-source-placeholder"
                        aria-label={`${card.name} 原图已删除`}
                      >
                        原图已删除
                      </div>
                    )}
                    <div>
                      <h3>{item.name}</h3>
                      <p>{item.reasons[0] ?? '已根据当前库存完成评估。'}</p>
                      {recommendationMode === 'use_stockpile' &&
                      item.topStockpileUses.length > 0 ? (
                        <div className="pattern-stockpile-uses" aria-label="优先消耗色号">
                          {item.topStockpileUses.map((usage) => (
                            <span key={usage.paletteColorId}>
                              <i style={{ background: usage.hex }} aria-hidden="true" />
                              {usage.code} {usage.quantity} 颗
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="pattern-stock-metrics">
                        <span>{item.totalBeads} 颗</span>
                        <span>{item.colorCount} 色</span>
                        <strong className={item.canMake ? 'ready' : 'short'}>
                          {item.canMake ? '库存可直接制作' : `还缺 ${item.shortageTotal} 颗`}
                        </strong>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSearchParams({ card: item.patternCardId })}
                    >
                      查看图纸
                    </button>
                  </article>
                );
              })}
            </div>
          ) : null}

          {!catalogLoading &&
          !recommendationLoading &&
          recommendations.length === 0 &&
          !recommendationError &&
          catalog.some((card) => card.status === 'confirmed') ? (
            <p className="pattern-recommendation-empty">
              {recommendationMode === 'ready'
                ? '当前没有库存完全够用的图纸，可以切换到“补豆最少”查看最容易补齐的图。'
                : '暂时没有可推荐的已确认图纸。'}
            </p>
          ) : null}

          {!catalogLoading && consumptionHistory.length > 0 ? (
            <section className="pattern-consumption-history" aria-label="制作与库存变动历史">
              <div className="pattern-history-heading">
                <div>
                  <p className="eyebrow">做过的图</p>
                  <h3>最近扣过豆、又还回去的记录</h3>
                </div>
                <span>{consumptionHistory.length} 条记录</span>
              </div>
              <ol>
                {consumptionHistory.map((entry) => (
                  <li key={entry.id}>
                    <div className="pattern-history-summary">
                      <div>
                        <strong>{entry.patternCardName}</strong>
                        <span>
                          {new Date(entry.createdAt).toLocaleString('zh-CN')} · 材料版本{' '}
                          {entry.materialVersion}
                        </span>
                      </div>
                      <div>
                        <b data-status={entry.status}>
                          {entry.status === 'applied' ? '已扣库存' : '已撤销并恢复'}
                        </b>
                        <span>{entry.totalQuantity} 颗</span>
                      </div>
                    </div>
                    <details>
                      <summary>查看 {entry.items.length} 个色号明细</summary>
                      <ul>
                        {entry.items.map((item) => {
                          const color = colorsById.get(item.paletteColorId);
                          return (
                            <li key={item.paletteColorId}>
                              <i
                                style={{ background: color?.hex ?? '#d8d0c6' }}
                                aria-hidden="true"
                              />
                              <strong>{color?.code ?? item.paletteColorId}</strong>
                              <span>
                                {entry.status === 'applied' ? '扣减' : '曾扣减'} {item.quantity}
                              </span>
                              <span>当时扣后 {item.balanceAfter}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                    <button
                      type="button"
                      onClick={() => setSearchParams({ card: entry.patternCardId })}
                    >
                      打开图纸
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {selectedCardIds.length > 0 ? (
            <section className="combined-purchase-panel" aria-label="多图合并补豆">
              <div className="combined-purchase-heading">
                <div>
                  <p className="eyebrow">连续制作计划</p>
                  <h3>已选 {selectedCardIds.length} 张图纸</h3>
                  <p>同色用量会先合并，再与当前库存比较；这里只计算，不扣库存。</p>
                </div>
                <div className="combined-purchase-actions">
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => {
                      setSelectedCardIds([]);
                      setCombinedPurchaseList(null);
                      setCombinedPurchaseMessage('');
                    }}
                  >
                    清空选择
                  </button>
                  <button
                    type="button"
                    className="primary-action"
                    disabled={combinedPurchaseWorking}
                    onClick={() => void generateCombinedPurchaseList()}
                  >
                    {combinedPurchaseWorking ? '正在合并计算……' : '合并计算补豆'}
                  </button>
                </div>
              </div>
              {combinedPurchaseMessage ? <p role="status">{combinedPurchaseMessage}</p> : null}
              {combinedPurchaseList ? (
                <div className="combined-purchase-result">
                  <div className="combined-purchase-summary">
                    <strong>{combinedPurchaseList.totals.required} 颗总用量</strong>
                    <span>{combinedPurchaseList.balances.length} 个色号</span>
                    <span>{combinedPurchaseList.totals.shortage} 颗需补</span>
                    {combinedPurchaseList.hasEstimatedInventory ? <span>含估算库存</span> : null}
                  </div>
                  <p>{combinedPurchaseList.patternCards.map((card) => card.name).join('、')}</p>
                  {combinedPurchaseList.items.length > 0 ? (
                    <div className="combined-shortage-list">
                      {combinedPurchaseList.items.map((item) => (
                        <span key={item.paletteColorId}>
                          <i style={{ background: item.hex }} aria-hidden="true" />
                          <strong>{item.code}</strong> 补 {item.shortage}
                          {item.quantityConfidence === 'estimated' ? '（库存估算）' : ''}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="form-success">当前库存充足，无需采购。</p>
                  )}
                  <div className="combined-purchase-actions">
                    <button type="button" onClick={() => void copyCombinedPurchaseList()}>
                      复制合并清单
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        downloadPurchaseCsv(
                          combinedPurchaseList.csv,
                          `BeadFlow-多图补豆-${new Date().toISOString().slice(0, 10)}.csv`,
                        )
                      }
                    >
                      下载 CSV
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {!catalogLoading && catalog.length === 0 && !catalogError ? (
            <div className="pattern-catalog-empty">
              <strong>图纸库还是空的</strong>
              <p>先扫一张完整图纸，把颜色团对上色号，再收进来。</p>
              <Link className="primary-action" to="/scan">
                去扫一张
              </Link>
            </div>
          ) : null}

          {catalog.length > 0 ? (
            <div className="pattern-catalog-grid">
              {catalog.map((card) => {
                const ranked = recommendationByCardId.get(card.patternCardId);
                return (
                  <article key={card.patternCardId}>
                    {card.sourceImageUrl ? (
                      <img src={card.sourceImageUrl} alt={`${card.name} 缩略图`} />
                    ) : (
                      <div
                        className="pattern-source-placeholder"
                        aria-label={`${card.name} 原图已删除`}
                      >
                        原图已删除
                      </div>
                    )}
                    {card.status === 'confirmed' ? (
                      <label className="pattern-card-select">
                        <input
                          type="checkbox"
                          checked={selectedCardIds.includes(card.patternCardId)}
                          disabled={
                            selectedCardIds.length >= 20 &&
                            !selectedCardIds.includes(card.patternCardId)
                          }
                          onChange={() => toggleCardSelection(card.patternCardId)}
                        />
                        加入合并补豆
                      </label>
                    ) : null}
                    <div>
                      <span className={`pattern-card-status ${card.status}`}>
                        {card.status === 'confirmed' ? '已确认' : '待人工复核'}
                      </span>
                      <h3>{card.name}</h3>
                      <p>
                        {card.recognizedTotal} 颗 · {card.colorCount} 色
                      </p>
                      {card.status === 'needs_review' ? (
                        <small>
                          {card.pendingItemCount} 项待确认
                          {card.conflictCount > 0 ? ` · ${card.conflictCount} 个冲突` : ''}
                        </small>
                      ) : (
                        <small>
                          {ranked
                            ? ranked.canMake
                              ? '当前库存够用'
                              : `当前缺 ${ranked.shortageTotal} 颗`
                            : recommendationMode === 'ready'
                              ? '当前库存不能直接制作'
                              : '等待库存推荐结果'}
                        </small>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={`打开图纸 ${card.name}`}
                      onClick={() => setSearchParams({ card: card.patternCardId })}
                    >
                      {card.status === 'confirmed' ? '查看' : '继续复核'}
                    </button>
                  </article>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {!cardId && !review && !loading ? (
        <p className="pattern-scan-cta">
          新图纸请到 <Link to="/scan">扫描图纸</Link> 上传完整原图并按颜色簇确认。
        </p>
      ) : null}

      {review && source ? (
        <div className="pattern-review-layout">
          <section className="pattern-source-panel" aria-label="图纸原图与证据区域">
            {source.sourceImageUrl ? (
              <>
                <div className="pattern-source-frame">
                  <img
                    src={source.sourceImageUrl}
                    alt={`${source.name} 原图`}
                    onLoad={(event) =>
                      setImageSize({
                        width: event.currentTarget.naturalWidth,
                        height: event.currentTarget.naturalHeight,
                      })
                    }
                  />
                  {selectedItem?.evidenceRegion && imageSize.width > 0 ? (
                    <span
                      className="pattern-evidence-box"
                      aria-label="当前色号的 OCR 证据区域"
                      style={{
                        left: `${(selectedItem.evidenceRegion.x / imageSize.width) * 100}%`,
                        top: `${(selectedItem.evidenceRegion.y / imageSize.height) * 100}%`,
                        width: `${(selectedItem.evidenceRegion.width / imageSize.width) * 100}%`,
                        height: `${(selectedItem.evidenceRegion.height / imageSize.height) * 100}%`,
                      }}
                    />
                  ) : null}
                </div>
                <p>点击右侧色号可在原图中查看 OCR 证据框。没有证据框的项目表示由你手工补充。</p>
              </>
            ) : (
              <div className="pattern-source-deleted" role="status">
                <strong>原图已删除</strong>
                <p>
                  删除时间：{new Date(source.sourceDeletedAt!).toLocaleString('zh-CN')}
                  。已确认材料、库存和制作历史仍然保留。
                </p>
              </div>
            )}

            {isConfirmed && source.sourceImageUrl ? (
              <div className="pattern-source-delete-actions">
                {sourceDeleteConfirming ? (
                  <>
                    <p>
                      此操作会永久删除私有原图，之后不能再查看 OCR
                      证据框，但不会删除材料和库存记录。
                    </p>
                    <button
                      type="button"
                      className="danger-text"
                      disabled={sourceDeleteWorking}
                      onClick={() => void deleteSourceImage()}
                    >
                      {sourceDeleteWorking ? '正在删除原图……' : '确认永久删除原图'}
                    </button>
                    <button
                      type="button"
                      disabled={sourceDeleteWorking}
                      onClick={() => setSourceDeleteConfirming(false)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="danger-text"
                    onClick={() => setSourceDeleteConfirming(true)}
                  >
                    删除已确认图纸的原图
                  </button>
                )}
              </div>
            ) : null}
          </section>

          <section className="pattern-review-panel" aria-label="材料人工复核">
            {isConfirmed ? (
              <p className="pattern-read-only-note">正式材料版本已锁定，不能再修改或删除。</p>
            ) : null}
            <div className="pattern-review-summary">
              <span>
                <strong>{items.length}</strong> 个色号
              </span>
              <span>
                <strong>{recognizedTotal}</strong> 颗合计
              </span>
              <span>
                <strong>{pendingCount}</strong> 项待确认
              </span>
              <span>
                <strong>{priorityReviewCount}</strong> 项需重点核对
              </span>
            </div>

            {priorityReviewCount > 0 && !isConfirmed ? (
              <label className="pattern-priority-filter">
                <input
                  type="checkbox"
                  checked={showPriorityOnly}
                  onChange={(event) => setShowPriorityOnly(event.target.checked)}
                />
                只看 OCR 低于 80% 的项目
              </label>
            ) : null}

            {conflicts.length > 0 && !isConfirmed ? (
              <div className="pattern-conflict-card">
                <strong>OCR 冲突：{conflicts.join('、')}</strong>
                <p>请结合原图核对相关色号。确认无误后再清除冲突。</p>
                <button type="button" onClick={() => setConflicts([])}>
                  我已人工核对这些冲突
                </button>
              </div>
            ) : null}

            <div className="pattern-material-list">
              {visibleItems.map((item) => {
                const color = colorsById.get(item.paletteColorId);
                const needsPriorityReview = item.confidence !== undefined && item.confidence < 0.8;
                return (
                  <article
                    key={item.id}
                    className={`${selectedItemId === item.id ? 'selected' : ''}${needsPriorityReview ? ' priority-review' : ''}`}
                    onClick={() => setSelectedItemId(item.id)}
                  >
                    <i style={{ background: color?.hex }} aria-hidden="true" />
                    <div className="pattern-material-code">
                      <strong>{color?.code ?? item.paletteColorId}</strong>
                      <small>
                        {item.confidence === undefined
                          ? '人工补充'
                          : `OCR ${Math.round(item.confidence * 100)}%`}
                      </small>
                      {needsPriorityReview ? <em>重点核对</em> : null}
                    </div>
                    <label>
                      数量
                      <input
                        aria-label={`${color?.code ?? item.paletteColorId} 数量`}
                        type="number"
                        min="1"
                        max="100000"
                        value={item.quantity}
                        disabled={isConfirmed}
                        onChange={(event) => updateQuantity(item.id, Number(event.target.value))}
                      />
                    </label>
                    <span className={`review-state ${item.reviewState}`}>
                      {item.reviewState === 'pending'
                        ? '待确认'
                        : item.reviewState === 'edited'
                          ? '已修改'
                          : item.reviewState === 'added'
                            ? '已补充'
                            : '已确认'}
                    </span>
                    {item.reviewState === 'pending' && !isConfirmed ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleConfirmed(item.id);
                        }}
                      >
                        确认此项
                      </button>
                    ) : null}
                    {!isConfirmed ? (
                      <button
                        className="danger-text"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setItems((current) =>
                            current.filter((candidate) => candidate.id !== item.id),
                          );
                        }}
                      >
                        删除
                      </button>
                    ) : null}
                  </article>
                );
              })}
            </div>

            {!isConfirmed ? (
              <div className="pattern-add-material">
                <select
                  aria-label="补充 MARD 色号"
                  value={addColorId}
                  onChange={(event) => setAddColorId(event.target.value)}
                >
                  <option value="">选择缺失色号</option>
                  {availableColors.map((color) => (
                    <option key={color.id} value={color.id}>
                      {color.code}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="补充数量"
                  type="number"
                  min="1"
                  max="100000"
                  value={addQuantity}
                  onChange={(event) => setAddQuantity(event.target.value)}
                />
                <button type="button" onClick={addMaterial}>
                  补充材料
                </button>
              </div>
            ) : null}

            {pendingCount > 0 && !isConfirmed ? (
              <button
                className="secondary-action"
                type="button"
                onClick={() =>
                  setItems((current) =>
                    current.map((item) =>
                      item.reviewState === 'pending' ? { ...item, reviewState: 'confirmed' } : item,
                    ),
                  )
                }
              >
                全部标记为已核对
              </button>
            ) : null}

            {totalMismatch && !isConfirmed ? (
              <label className="pattern-total-mismatch">
                <input
                  type="checkbox"
                  checked={acceptMismatch}
                  onChange={(event) => setAcceptMismatch(event.target.checked)}
                />
                图纸声明 {declaredTotal} 颗，当前复核合计 {recognizedTotal}{' '}
                颗。我已核对并接受这个差异。
              </label>
            ) : null}

            {!isConfirmed ? (
              <div className="pattern-review-actions">
                <button type="button" disabled={working} onClick={() => void save()}>
                  {working ? '保存中……' : '保存复核草稿'}
                </button>
                <button
                  className="primary-action"
                  type="button"
                  disabled={
                    working ||
                    items.length === 0 ||
                    pendingCount > 0 ||
                    conflicts.length > 0 ||
                    (totalMismatch && !acceptMismatch)
                  }
                  onClick={() => void confirm()}
                >
                  确认材料并计算库存
                </button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {inventoryResult ? (
        <section className="pattern-inventory-result" aria-label="图纸库存对比结果">
          <h2>{inventoryResult.totals.shortage === 0 ? '库存足够，可以开始制作' : '需要补豆'}</h2>
          <div>
            <span>
              <strong>{inventoryResult.totals.required}</strong> 颗需要
            </span>
            <span>
              <strong>{inventoryResult.totals.colorsReady}</strong> 色够用
            </span>
            <span>
              <strong>{inventoryResult.totals.colorsShort}</strong> 色缺少
            </span>
            <span>
              <strong>{inventoryResult.totals.shortage}</strong> 颗总缺口
            </span>
            <span>
              <strong>{inventoryResult.totals.reservedForThisCard}</strong> 颗已为本图预留
            </span>
            <span>
              <strong>{inventoryResult.totals.reservedElsewhere}</strong> 颗由其他待做占用
            </span>
          </div>
          {inventoryResult.hasEstimatedInventory ? (
            <p>部分库存是估算值，制作或补豆前建议复核。</p>
          ) : null}
          <ul>
            {inventoryResult.balances
              .filter((item) => item.shortage > 0)
              .map((item) => (
                <li key={item.paletteColorId}>
                  <i style={{ background: item.hex }} />
                  <strong>{item.code}</strong>
                  <span>需要 {item.required}</span>
                  <span>现有 {item.onHand}</span>
                  <span>可自由使用 {item.freelyAvailable}</span>
                  <b>缺 {item.shortage}</b>
                </li>
              ))}
          </ul>
          <div className="pattern-inventory-actions">
            <button
              type="button"
              disabled={reservationWorking || consumeWorking}
              onClick={() => setMessage('已只保存图纸资料。库存没有预留，也没有扣减。')}
            >
              只保存
            </button>
            {reservation ? (
              <section className="pattern-consumption-status" aria-label="待做库存预留">
                <div>
                  <strong>已加入待做，库存已预留</strong>
                  <span>
                    {reservation.totalQuantity} 颗 · {reservation.items.length} 个色号 ·
                    实际库存未扣减
                  </span>
                </div>
                <button
                  type="button"
                  disabled={reservationWorking || consumeWorking}
                  onClick={() => void releaseReservation()}
                >
                  {reservationWorking ? '正在释放…' : '取消待做并释放'}
                </button>
              </section>
            ) : inventoryResult.totals.shortage === 0 ? (
              <button
                type="button"
                disabled={reservationWorking || consumeWorking}
                onClick={() => void reserveInventory()}
              >
                {reservationWorking ? '正在预留…' : '加入待做'}
              </button>
            ) : (
              <p>库存不足时不能预留或扣减，避免部分扣减。</p>
            )}
          </div>
          {consumption ? (
            <section className="pattern-consumption-status" aria-label="最近制作记录">
              <div>
                <strong>
                  {consumption.status === 'applied' ? '已完成制作并扣库存' : '本次扣减已撤销'}
                </strong>
                <span>
                  {consumption.totalQuantity} 颗 · {consumption.items.length} 个色号 · 材料版本{' '}
                  {consumption.materialVersion}
                </span>
              </div>
              {consumption.undoAvailable ? (
                <button
                  type="button"
                  disabled={consumeWorking}
                  onClick={() => void undoConsumption()}
                >
                  {consumeWorking ? '正在恢复…' : '撤销本次扣减'}
                </button>
              ) : null}
            </section>
          ) : null}

          {inventoryResult.totals.shortage === 0 ? (
            <div className="pattern-consume-actions">
              {!consumeConfirming ? (
                <button
                  className="primary-action"
                  type="button"
                  onClick={() => {
                    setConsumeOperationKey(null);
                    setConsumeConfirming(true);
                  }}
                >
                  {reservation
                    ? '开始制作'
                    : consumption?.status === 'applied'
                      ? '明确再做一份'
                      : '开始制作'}
                </button>
              ) : (
                <section className="pattern-consume-confirm" aria-label="确认扣减库存">
                  <h3>确认已经完成这份图纸？</h3>
                  <p>
                    将一次性扣减 {inventoryResult.totals.required} 颗、
                    {inventoryResult.balances.length} 个色号。
                    整次操作要么全部成功，要么完全不扣；重复网络请求不会再次扣减。
                  </p>
                  <ul>
                    {inventoryResult.balances.map((item) => (
                      <li key={item.paletteColorId}>
                        <i style={{ background: item.hex }} aria-hidden="true" />
                        <strong>{item.code}</strong>
                        <span>扣 {item.required}</span>
                        <span>扣后 {item.onHand - item.required}</span>
                      </li>
                    ))}
                  </ul>
                  <div>
                    <button
                      type="button"
                      disabled={consumeWorking}
                      onClick={() => {
                        setConsumeConfirming(false);
                        setConsumeOperationKey(null);
                      }}
                    >
                      取消
                    </button>
                    <button
                      className="primary-action"
                      type="button"
                      disabled={consumeWorking}
                      onClick={() => void consumeInventory()}
                    >
                      {consumeWorking ? '正在安全扣减…' : '确认完成并扣减'}
                    </button>
                  </div>
                </section>
              )}
            </div>
          ) : null}
          {inventoryResult.totals.shortage > 0 && !purchaseList ? (
            <button
              className="primary-action pattern-purchase-generate"
              type="button"
              disabled={purchaseWorking}
              onClick={() => void generatePurchaseList()}
            >
              {purchaseWorking ? '正在生成……' : '生成一键补豆清单'}
            </button>
          ) : null}

          {purchaseMessage ? (
            <p className="form-success" role="status">
              {purchaseMessage}
            </p>
          ) : null}

          {purchaseList && purchaseList.items.length > 0 ? (
            <section className="pattern-purchase-list" aria-label="补豆清单">
              <div className="pattern-purchase-heading">
                <div>
                  <h3>补豆清单</h3>
                  <p>
                    共 {purchaseList.items.length} 个色号，缺 {purchaseList.totals.shortage} 颗。
                  </p>
                </div>
                <div>
                  <button type="button" onClick={() => void copyPurchaseList()}>
                    复制清单
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadPurchaseCsv(
                        purchaseList.csv,
                        `BeadFlow-MARD-补豆清单-${new Date().toISOString().slice(0, 10)}.csv`,
                      )
                    }
                  >
                    下载 CSV
                  </button>
                </div>
              </div>
              {purchaseList.groups.map((group) => (
                <section key={group.family}>
                  <h4>{group.family} 系</h4>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.paletteColorId}>
                        <i style={{ background: item.hex }} aria-hidden="true" />
                        <strong>{item.code}</strong>
                        <span>需要 {item.required}</span>
                        <span>现有 {item.available}</span>
                        <b>补 {item.shortage}</b>
                        <small>
                          {item.quantityConfidence === 'estimated' ? '库存估算' : '库存准确'}
                        </small>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <details>
                <summary>查看可复制文本</summary>
                <pre>{purchaseList.copyText}</pre>
              </details>
            </section>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
