import type {
  PatternCardPurchaseListResult,
  PatternCardRecommendation,
} from '@beadflow/shared-types';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  loadPatternCardPurchaseList,
  loadPatternCardRecommendations,
  PatternCardApiError,
} from '../pattern-library/patternCardClient';

const modes = [
  {
    id: 'ready' as const,
    label: '现在就能做',
    hint: '所有颜色都够用',
  },
  {
    id: 'least_shortage' as const,
    label: '补豆最少',
    hint: '按缺口颗数排序',
  },
  {
    id: 'use_stockpile' as const,
    label: '优先消耗库存较多的颜色',
    hint: '先用囤得比较多的色',
  },
];

export function RecommendationsPage() {
  const auth = useAuth();
  const [mode, setMode] = useState<(typeof modes)[number]['id']>('ready');
  const [items, setItems] = useState<readonly PatternCardRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [purchaseList, setPurchaseList] = useState<PatternCardPurchaseListResult | null>(null);
  const [purchaseWorking, setPurchaseWorking] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const token = await auth.client?.getAccessToken();
        if (!token) throw new PatternCardApiError('登录状态已失效。', 'AUTH_REQUIRED');
        const ranked = await loadPatternCardRecommendations(token, mode, 10);
        if (active) setItems(ranked.items);
      } catch (loadError) {
        if (active) {
          setItems([]);
          setError(loadError instanceof Error ? loadError.message : '推荐加载失败。');
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [auth.client, mode]);

  const copyList = async (patternCardId: string) => {
    setPurchaseWorking(true);
    setError('');
    setMessage('');
    try {
      const token = await auth.client?.getAccessToken();
      if (!token) throw new PatternCardApiError('登录状态已失效。', 'AUTH_REQUIRED');
      const list = await loadPatternCardPurchaseList(patternCardId, token);
      setPurchaseList(list);
      await navigator.clipboard.writeText(list.copyText);
      setMessage('补豆清单已复制。');
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : '补豆清单复制失败。');
    } finally {
      setPurchaseWorking(false);
    }
  };

  return (
    <section className="recommendations-page">
      <header className="pattern-scan-heading">
        <div>
          <p className="eyebrow">下一张</p>
          <h1>今晚拼哪张</h1>
          <p>按手头豆子排一排：马上能做的、补最少的，或先消化囤货。只给建议，不会自动扣豆。</p>
        </div>
      </header>

      <div className="recommendation-mode-picker" aria-label="推荐方式">
        {modes.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={mode === item.id}
            onClick={() => setMode(item.id)}
          >
            {item.label}
            <small>{item.hint}</small>
          </button>
        ))}
      </div>

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
      {loading ? <p role="status">正在按所选方式重新排序……</p> : null}

      {!loading && items.length === 0 && !error ? (
        <p className="empty-state">还没有确认过的图纸，或这种方式下暂时排不出结果。</p>
      ) : null}

      <div className="pattern-recommendation-list" aria-label="库存推荐图纸">
        {items.map((item, index) => (
          <article key={item.patternCardId}>
            <span>推荐 {index + 1}</span>
            <h2>{item.name}</h2>
            <p>
              {item.totalBeads} 颗 · {item.colorCount} 色 ·{' '}
              {item.canMake ? '够用' : `缺 ${item.shortageTotal} 颗`}
            </p>
            <ul>
              {item.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
              {item.topShortages.map((shortage) => (
                <li key={shortage.paletteColorId}>
                  缺 {shortage.code} {shortage.shortage} 颗
                </li>
              ))}
              {item.topStockpileUses.map((used) => (
                <li key={used.paletteColorId}>
                  可消耗 {used.code} {used.quantity} 颗
                </li>
              ))}
            </ul>
            <div className="recommendation-card-actions">
              <Link to={`/patterns?card=${item.patternCardId}`}>打开图纸</Link>
              <button
                type="button"
                disabled={purchaseWorking}
                onClick={() => void copyList(item.patternCardId)}
              >
                复制补豆清单
              </button>
            </div>
          </article>
        ))}
      </div>

      {purchaseList?.csv ? (
        <p className="pattern-scan-boundary">当前接口也提供 CSV 文本，已包含在复制内容中。</p>
      ) : null}
    </section>
  );
}
