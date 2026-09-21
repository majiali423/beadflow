import { parsePalette } from '@beadflow/palette-engine';
import type { PatternGridAnalysisResult, PatternGridColorCluster } from '@beadflow/shared-types';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import mardPaletteSource from '../../../../../assets/palettes/mard221.json';
import { useAuth } from '../auth/AuthContext';
import {
  PatternCardApiError,
  savePatternCardFromClusters,
} from '../pattern-library/patternCardClient';
import {
  clusterReviewIssues,
  initialClusterMappings,
  mappedMaterialItems,
  type ClusterMapping,
} from './clusterReview';
import { analyzePatternGrid, PatternGridApiError } from './patternGridClient';

const palette = parsePalette(JSON.stringify(mardPaletteSource), 221).palette;
const scanStages = ['上传图片', '定位主网格', '判断有效格', '统计颜色簇', '等待人工复核'] as const;

function clusterColor(cluster: PatternGridColorCluster): string {
  const lightness = (cluster.medianLab.lightness / 255) * 100;
  return `lab(${lightness.toFixed(1)}% ${(cluster.medianLab.a - 128).toFixed(1)} ${(cluster.medianLab.b - 128).toFixed(1)})`;
}

export function PatternScanPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [result, setResult] = useState<PatternGridAnalysisResult | null>(null);
  const [mappings, setMappings] = useState<readonly ClusterMapping[]>([]);
  const [colorQuery, setColorQuery] = useState('');
  const [uncertainAcknowledged, setUncertainAcknowledged] = useState(false);
  const [stageIndex, setStageIndex] = useState(-1);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const clustersById = useMemo(
    () => new Map(result?.colorClusters.map((cluster) => [cluster.clusterId, cluster]) ?? []),
    [result],
  );
  const issues = useMemo(
    () => (result ? clusterReviewIssues(result, mappings, palette.colors) : []),
    [mappings, result],
  );
  const filteredColors = useMemo(() => {
    const query = colorQuery.trim().toUpperCase();
    return palette.colors.filter((color) => !query || color.code.includes(query)).slice(0, 40);
  }, [colorQuery]);

  const analyze = async () => {
    if (!file || !auth.client) return;
    setWorking(true);
    setError('');
    setMessage('');
    setResult(null);
    setMappings([]);
    setUncertainAcknowledged(false);
    setStageIndex(0);
    const timer = window.setInterval(() => {
      setStageIndex((current) => (current < 3 ? current + 1 : current));
    }, 900);
    try {
      const token = await auth.client.getAccessToken();
      if (!token) throw new PatternGridApiError('登录状态已失效，请重新登录。', 'AUTH_REQUIRED');
      const analysis = await analyzePatternGrid(file, token);
      setResult(analysis);
      setMappings(initialClusterMappings(analysis));
      setStageIndex(4);
      setMessage(
          analysis.gridDetected
            ? '格子已经数完。请按颜色团选真实 MARD 色号；这一步还不会动豆子。'
            : '这张图没找稳主网格。页面不会编造结果，也不会动豆子。',
      );
    } catch (analysisError) {
      setStageIndex(-1);
      setError(
        analysisError instanceof Error ? analysisError.message : '图纸没分析成功，豆子没有动。',
      );
    } finally {
      window.clearInterval(timer);
      setWorking(false);
    }
  };

  const updateMapping = (clusterId: number, patch: Partial<ClusterMapping>) => {
    setMappings((current) =>
      current.map((item) => (item.clusterId === clusterId ? { ...item, ...patch } : item)),
    );
  };

  const saveCard = async () => {
    if (!file || !result || !auth.client) return;
    if (issues.length > 0 || (result.uncertainCount > 0 && !uncertainAcknowledged)) {
      setError('请先把颜色团对上色号；标黄的不确定格不会写进材料。');
      return;
    }
    if (!name.trim()) {
      setError('保存前给这张图起个名字，回头好找。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const token = await auth.client.getAccessToken();
      if (!token) throw new PatternCardApiError('登录状态已失效。', 'AUTH_REQUIRED');
      const saved = await savePatternCardFromClusters({
        file,
        name: name.trim(),
        occupiedCount: result.occupiedCount,
        items: mappedMaterialItems(result, mappings),
        accessToken: token,
      });
      navigate(`/patterns?card=${saved.patternCardId}`, { replace: true });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '图纸没存上，豆子没有动。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="pattern-scan-page">
      <header className="pattern-scan-heading">
        <div>
          <p className="eyebrow">扫描图纸</p>
          <h1>把图纸收进来</h1>
          <p>
            拍一张完整截图就行。先找出格子和颜色团，色号由你对照图例点。这一步只看图，不会动豆子。
          </p>
        </div>
        <span className="pattern-scan-safety">不会动豆子</span>
      </header>

      <section className="pattern-scan-upload" aria-labelledby="pattern-scan-upload-title">
        <div>
          <h2 id="pattern-scan-upload-title">选一张图</h2>
          <p>JPEG、PNG、WebP 都可以。请上传完整主网格，别用裁掉编号的局部图。</p>
        </div>
        <label>
          图纸名称
          <input
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：猫咪 68×66"
          />
        </label>
        <label>
          图纸文件
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setResult(null);
              setMappings([]);
              setError('');
              setMessage('');
              setStageIndex(-1);
            }}
          />
        </label>
        {previewUrl ? (
          <img className="pattern-scan-preview" src={previewUrl} alt="待分析图纸预览" />
        ) : (
          <div className="pattern-scan-drop" aria-hidden="true">
            把图纸拖到这里
          </div>
        )}
        <button type="button" disabled={!file || working} onClick={() => void analyze()}>
          {working ? '正在扫描…' : '开始扫描'}
        </button>
        {working || stageIndex >= 0 ? (
          <ol className="pattern-scan-stages" aria-label="扫描进度">
            {scanStages.map((stage, index) => (
              <li
                key={stage}
                className={
                  index < stageIndex ? 'is-done' : index === stageIndex ? 'is-current' : undefined
                }
              >
                {stage}
              </li>
            ))}
          </ol>
        ) : null}
        <p className="pattern-scan-boundary">扫描过程中不会改库存。</p>
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
      </section>

      {result ? (
        <section className="pattern-scan-result" aria-labelledby="pattern-scan-result-title">
          <div className="pattern-scan-result-heading">
            <div>
              <p className="eyebrow">等你对色号</p>
              <h2 id="pattern-scan-result-title">
                {result.gridDetected
                  ? `${result.columnCount} × ${result.rowCount} 主网格`
                  : '未能可靠定位主网格'}
              </h2>
            </div>
            <span>{result.inventoryMutated ? '库存已变化' : '豆子没动'}</span>
          </div>

          {result.gridDetected ? (
            <>
              <div className="pattern-scan-counts">
                <span>
                  <strong>{result.occupiedCount}</strong>确定占用
                </span>
                <span className={result.uncertainCount > 0 ? 'is-uncertain' : undefined}>
                  <strong>{result.uncertainCount}</strong>不确定
                </span>
                <span>
                  <strong>{result.emptyCount}</strong>确定空白
                </span>
                <span>
                  <strong>{result.colorClusters.length}</strong>颜色簇
                </span>
              </div>

              <div className="pattern-scan-grid-scroll">
                <div
                  className="pattern-scan-grid"
                  style={{ gridTemplateColumns: `repeat(${result.columnCount}, 9px)` }}
                  role="img"
                  aria-label={`${result.columnCount} 列 ${result.rowCount} 行的识别概览`}
                >
                  {result.cells.map((cell) => {
                    const cluster =
                      cell.clusterId === undefined ? undefined : clustersById.get(cell.clusterId);
                    return (
                      <span
                        key={`${cell.row}-${cell.column}`}
                        className={`pattern-scan-cell ${cell.state}`}
                        style={cluster ? { backgroundColor: clusterColor(cluster) } : undefined}
                        title={`第 ${cell.row + 1} 行，第 ${cell.column + 1} 列：${cell.state}`}
                      />
                    );
                  })}
                </div>
              </div>

              {result.uncertainCount > 0 ? (
                <label className="pattern-scan-uncertain">
                  <input
                    type="checkbox"
                    checked={uncertainAcknowledged}
                    onChange={(event) => setUncertainAcknowledged(event.target.checked)}
                  />
                  有 {result.uncertainCount} 格标了黄，需要你自己看一眼；它们不会写进材料数量。
                </label>
              ) : null}

              <section className="pattern-scan-cluster-review" aria-label="颜色簇复核">
                <div className="pattern-scan-cluster-heading">
                  <h3>按颜色团对色号</h3>
                  <label>
                    搜索 MARD 色号
                    <input
                      value={colorQuery}
                      onChange={(event) => setColorQuery(event.target.value)}
                      placeholder="例如 G16"
                    />
                  </label>
                </div>
                <ul>
                  {result.colorClusters
                    .slice()
                    .sort((left, right) => right.cellCount - left.cellCount)
                    .map((cluster) => {
                      const mapping = mappings.find((item) => item.clusterId === cluster.clusterId);
                      const selected = palette.colors.find(
                        (color) => color.id === mapping?.paletteColorId,
                      );
                      return (
                        <li key={cluster.clusterId}>
                          <i
                            style={{ backgroundColor: clusterColor(cluster) }}
                            aria-hidden="true"
                          />
                          <div>
                            <strong>颜色簇 {cluster.clusterId + 1}</strong>
                            <span>{cluster.cellCount} 格</span>
                            <small>
                              {selected ? `当前选 ${selected.code}` : '还没选 MARD 色号'}
                              {mapping?.confirmed ? ' · 已确认' : ' · 还没确认'}
                            </small>
                          </div>
                          <label>
                            MARD 色号
                            <select
                              aria-label={`颜色簇 ${cluster.clusterId + 1} 的 MARD 色号`}
                              value={mapping?.paletteColorId ?? ''}
                              onChange={(event) =>
                                updateMapping(cluster.clusterId, {
                                  paletteColorId: event.target.value,
                                  confirmed: false,
                                })
                              }
                            >
                              <option value="">请选择真实色号</option>
                              {(selected &&
                              !filteredColors.some((color) => color.id === selected.id)
                                ? [selected, ...filteredColors]
                                : filteredColors
                              ).map((color) => (
                                <option key={color.id} value={color.id}>
                                  {color.code}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            disabled={!mapping?.paletteColorId || mapping.confirmed || saving}
                            onClick={() => updateMapping(cluster.clusterId, { confirmed: true })}
                          >
                            {mapping?.confirmed ? '已确认' : '确认本簇'}
                          </button>
                        </li>
                      );
                    })}
                </ul>
              </section>

              {issues.length > 0 ? (
                <ul className="pattern-scan-issues" aria-label="还不能确认材料清单">
                  {issues.map((issue) => (
                    <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              ) : null}

              <button
                type="button"
                className="pattern-scan-save"
                disabled={
                  saving ||
                  issues.length > 0 ||
                  (result.uncertainCount > 0 && !uncertainAcknowledged)
                }
                onClick={() => void saveCard()}
              >
                {saving ? '正在收进图纸库…' : '收进图纸库'}
              </button>
            </>
          ) : (
            <p className="pattern-scan-review-message">
              {result.reasons[0] ??
                '当前图片没有足够稳定的周期网格证据，请确认图纸完整、没有被裁掉行列编号。'}
            </p>
          )}

          <p className="pattern-scan-boundary">
            色号只能从 MARD 221 色卡里选，不会按屏幕颜色自动断言。
          </p>
        </section>
      ) : null}
    </section>
  );
}
