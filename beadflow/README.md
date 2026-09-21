# BeadFlow

BeadFlow 是一个 Web/PWA 拼豆图纸与库存助手。它从用户已有的图纸图片中检测主网格，统计有效格和颜色簇，再通过图例、代表格文字和人工确认映射 MARD 色号。

## 当前识别路线

```text
上传图纸
→ 自动检测主网格
→ 切分格子并判断有效、空白、不确定
→ 按稳健背景颜色特征保守聚类并计数
→ 图例与颜色簇整体匹配
→ 代表格受限 OCR 补全
→ 颜色簇级人工确认
→ 保存材料清单
```

主网格负责数量；图例和格内文字负责色号；低置信度结果不自动确认，也不修改库存。

当前 Phase 1 只实现网格检测、有效格判断和颜色簇计数。库存、补豆、预留、扣减、撤销和确定性推荐已有独立领域能力，但不会接收未经确认的识别结果。

旧 Flutter 照片生成器、矩阵编辑器、实体板扫描、制作计划及其产品约束已经删除。

## 结构

- `apps/web`：React/Vite PWA
- `apps/api`：Fastify API
- `apps/cv-service`：本地图像处理和受限 OCR
- `packages/inventory-engine`：库存、缺料与推荐规则
- `packages/palette-engine`：MARD 色卡解析与颜色计算
- `packages/shared-types`：共享领域类型
- `supabase`：数据库、Storage、RLS 和事务迁移

唯一实施规格见 [`SPEC.md`](./SPEC.md)。

## 本地启动

要求 Node.js 22+、pnpm 10+、Python 3.11+。

```bash
pnpm install
pnpm dev:web
pnpm dev:api
```

CV 服务：

```bash
cd apps/cv-service
python -m venv .venv
python -m pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8001
```

## 质量检查

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
