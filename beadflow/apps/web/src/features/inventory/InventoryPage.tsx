import type {
  InventoryItem,
  InventoryQuantityConfidence,
  InventoryTransaction,
  PaletteColor,
} from '@beadflow/shared-types';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import { usePalette } from '../palette/usePalette';
import {
  InventoryApiError,
  listInventory,
  listInventoryTransactions,
  setInventoryItem,
} from './inventoryClient';

const colorFamilies = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'] as const;
const reasonLabels: Record<InventoryTransaction['reason'], string> = {
  purchase: '购买/补货',
  manual_adjustment: '手工盘点',
  pattern_consumption: '图纸制作',
  pattern_rollback: '图纸撤销',
};

function replaceItem(
  items: readonly InventoryItem[],
  nextItem: InventoryItem,
): readonly InventoryItem[] {
  const existing = items.findIndex((item) => item.paletteColorId === nextItem.paletteColorId);
  return existing < 0
    ? [...items, nextItem]
    : items.map((item, index) => (index === existing ? nextItem : item));
}

export function InventoryPage() {
  const auth = useAuth();
  const paletteQuery = usePalette();
  const [items, setItems] = useState<readonly InventoryItem[]>([]);
  const [transactions, setTransactions] = useState<readonly InventoryTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [family, setFamily] = useState('all');
  const [selectedColorId, setSelectedColorId] = useState('');
  const [quantity, setQuantity] = useState('0');
  const [confidence, setConfidence] = useState<InventoryQuantityConfidence>('exact');
  const [threshold, setThreshold] = useState('');
  const [saving, setSaving] = useState(false);

  const colors = paletteQuery.data?.colors ?? [];
  const colorsById = useMemo(() => new Map(colors.map((color) => [color.id, color])), [colors]);

  useEffect(() => {
    if (!selectedColorId && colors[0]) setSelectedColorId(colors[0].id);
  }, [colors, selectedColorId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const accessToken = await auth.client?.getAccessToken();
        if (!accessToken) throw new InventoryApiError('登录状态已经失效。', 'AUTH_REQUIRED');
        const [nextItems, nextTransactions] = await Promise.all([
          listInventory(accessToken),
          listInventoryTransactions(accessToken),
        ]);
        if (!active) return;
        setItems(nextItems);
        setTransactions(nextTransactions);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof InventoryApiError ? loadError.message : '无法读取云端豆仓。');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [auth.client]);

  const displayedItems = useMemo(() => {
    const query = search.trim().toUpperCase();
    return items
      .map((item) => ({ item, color: colorsById.get(item.paletteColorId) }))
      .filter(
        (
          entry,
        ): entry is {
          item: InventoryItem;
          color: PaletteColor;
        } => Boolean(entry.color),
      )
      .filter(
        ({ color }) =>
          (family === 'all' || color.code.startsWith(family)) &&
          (!query || color.code.includes(query)),
      )
      .sort((left, right) => left.color.code.localeCompare(right.color.code));
  }, [colorsById, family, items, search]);

  const beginEdit = (item: InventoryItem) => {
    setSelectedColorId(item.paletteColorId);
    setQuantity(String(item.quantity));
    setConfidence(item.quantityConfidence);
    setThreshold(item.lowStockThreshold === undefined ? '' : String(item.lowStockThreshold));
    setError('');
    setSuccess('');
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const parsedQuantity = Number(quantity);
    const parsedThreshold = threshold.trim() ? Number(threshold) : null;
    if (
      !selectedColorId ||
      !Number.isInteger(parsedQuantity) ||
      parsedQuantity < 0 ||
      (parsedThreshold !== null && (!Number.isInteger(parsedThreshold) || parsedThreshold < 0))
    ) {
      setError('库存数量和低库存提醒必须是大于或等于 0 的整数。');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const accessToken = await auth.client?.getAccessToken();
      if (!accessToken) throw new InventoryApiError('登录状态已经失效。', 'AUTH_REQUIRED');
      const result = await setInventoryItem({
        paletteColorId: selectedColorId,
        quantity: parsedQuantity,
        quantityConfidence: confidence,
        lowStockThreshold: parsedThreshold,
        accessToken,
      });
      setItems((current) => replaceItem(current, result.item));
      if (result.transaction) {
        setTransactions((current) => [result.transaction!, ...current]);
      }
      const code = colorsById.get(selectedColorId)?.code ?? selectedColorId;
      setSuccess(`${code} 已保存为 ${parsedQuantity} 颗。`);
    } catch (saveError) {
      setError(
        saveError instanceof InventoryApiError
          ? saveError.message
          : '保存失败，表单内容和原库存均已保留。',
      );
    } finally {
      setSaving(false);
    }
  };

  const totalBeads = items.reduce((sum, item) => sum + item.quantity, 0);
  const lowStockCount = items.filter(
    (item) => item.lowStockThreshold !== undefined && item.quantity <= item.lowStockThreshold,
  ).length;

  return (
    <section className="page-card inventory-page">
      <p className="eyebrow">豆仓</p>
      <div className="inventory-heading">
        <div>
          <h1>手头的豆</h1>
          <p>按真实 MARD 色号记账。数过的标「准确」，估的标「估算」，别混在一起。</p>
        </div>
        <div className="inventory-summary" aria-label="豆仓统计">
          <strong>{items.length} 个色号</strong>
          <span>{totalBeads} 颗</span>
          <span>{lowStockCount} 个低库存</span>
        </div>
      </div>

      {loading ? <p role="status">正在打开豆仓…</p> : null}
      {paletteQuery.isError ? (
        <p className="form-alert" role="alert">
          MARD 221 色卡加载失败，暂时不能编辑库存。
        </p>
      ) : null}
      {error ? (
        <p className="form-alert" role="alert">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="form-success" role="status">
          {success}
        </p>
      ) : null}

      <div className="inventory-layout">
        <div className="inventory-main">
          <div className="inventory-filters">
            <label>
              搜索色号
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="例如 B17"
              />
            </label>
            <label>
              色系
              <select value={family} onChange={(event) => setFamily(event.target.value)}>
                <option value="all">全部色系</option>
                {colorFamilies.map((value) => (
                  <option value={value} key={value}>
                    {value} 系
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!loading && displayedItems.length === 0 ? (
            <p className="empty-state">这一筛下还没有记过的色。</p>
          ) : null}
          <div className="inventory-grid">
            {displayedItems.map(({ item, color }) => {
              const low =
                item.lowStockThreshold !== undefined && item.quantity <= item.lowStockThreshold;
              return (
                <article className="inventory-card" key={item.id}>
                  <span
                    className="inventory-swatch"
                    style={{ backgroundColor: color.hex }}
                    aria-hidden="true"
                  />
                  <div>
                    <h2>{color.code}</h2>
                    <p>{item.quantity} 颗</p>
                    <small>
                      {item.quantityConfidence === 'estimated' ? '约数 · 估算' : '准确数量'}
                    </small>
                  </div>
                  <div className="inventory-card-actions">
                    {low ? <span className="low-stock-badge">低库存</span> : null}
                    <button type="button" onClick={() => beginEdit(item)}>
                      编辑
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <aside className="inventory-editor" aria-label="库存编辑">
          <h2>记一笔记</h2>
          <form onSubmit={(event) => void save(event)}>
            <label>
              MARD 色号
              <select
                value={selectedColorId}
                onChange={(event) => {
                  const colorId = event.target.value;
                  setSelectedColorId(colorId);
                  const current = items.find((item) => item.paletteColorId === colorId);
                  if (current) beginEdit(current);
                }}
                disabled={paletteQuery.isLoading || colors.length === 0}
              >
                {colors.map((color) => (
                  <option value={color.id} key={color.id}>
                    {color.code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              当前数量（颗）
              <input
                type="number"
                min="0"
                step="1"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <fieldset>
              <legend>数量可信度</legend>
              <label>
                <input
                  type="radio"
                  name="confidence"
                  checked={confidence === 'exact'}
                  onChange={() => setConfidence('exact')}
                />
                准确
              </label>
              <label>
                <input
                  type="radio"
                  name="confidence"
                  checked={confidence === 'estimated'}
                  onChange={() => setConfidence('estimated')}
                />
                估算
              </label>
            </fieldset>
            <label>
              低库存提醒（颗，可留空）
              <input
                type="number"
                min="0"
                step="1"
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
              />
            </label>
            <button className="primary-action" type="submit" disabled={saving}>
              {saving ? '保存中……' : '保存库存'}
            </button>
          </form>
        </aside>
      </div>

      <section className="inventory-history">
        <h2>最近进出</h2>
        {transactions.length === 0 ? (
          <p className="empty-state">改过数量之后，这里会留下进出记录。</p>
        ) : (
          <ol>
            {transactions.slice(0, 20).map((entry) => {
              const code = colorsById.get(entry.paletteColorId)?.code ?? '未知色号';
              return (
                <li key={entry.id}>
                  <strong>{code}</strong>
                  <span>{reasonLabels[entry.reason]}</span>
                  <span className={entry.delta > 0 ? 'positive-delta' : 'negative-delta'}>
                    {entry.delta > 0 ? '+' : ''}
                    {entry.delta}
                  </span>
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleString('zh-CN')}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </section>
  );
}
