# Phase 6：完成制作、原子扣库存与撤销

## 目标

用户确认一张正式图纸已经制作完成后，按正式材料版本一次性扣减库存，同时避免网络重试造成重复扣减，并允许短时间内纠错撤销。

## 已实现

- 扣减前展示所有色号、用量和扣减后余额。
- 只有用户二次确认后才写库存。
- 一个数据库事务内完成整张图纸的多色扣减；任一颜色不足则全部取消。
- 每次操作使用 UUID 幂等键，相同请求重复提交只返回原记录。
- 同一图纸可以重复制作，但必须点击“明确再做一份”生成新的操作。
- 每个颜色都生成 `pattern_consumption` 审计流水。
- 10 分钟内允许撤销，并为每个颜色生成 `pattern_rollback` 反向流水。
- 页面重新打开后可读取最近一次制作及撤销状态。

## 数据库

- `pattern_card_consumptions`：一次完整制作记录、正式材料版本、幂等键和撤销期限。
- `pattern_card_consumption_items`：逐色数量、扣减后余额和正反流水引用。
- `consume_pattern_card_inventory`：原子扣减。
- `undo_pattern_card_consumption`：幂等撤销。
- `get_latest_pattern_card_consumption`：恢复页面状态。

## 真实验收

图纸：`复杂大尺寸图纸验收`，材料版本 1，共 6 色、2136 颗。

| 色号 | 扣减 | 扣减前 | 扣减后 | 撤销后 |
| ---- | ---: | -----: | -----: | -----: |
| B14  |  526 |   1623 |   1097 |   1623 |
| B17  |  119 |   1729 |   1610 |   1729 |
| C4   |  200 |   1486 |   1286 |   1486 |
| C6   |  617 |   1484 |    867 |   1484 |
| C7   |  250 |   1483 |   1233 |   1483 |
| H7   |  424 |   3638 |   3214 |   3638 |

结果：扣减总量 2136，撤销总量 2136；六个颜色撤销后均与扣减前一致。

## 验证

- API：62 tests passed。
- Web：65 tests passed。
- 其他 packages：34 tests passed。
- 总计：161 tests passed。
- ESLint、TypeScript typecheck、Web production build、API production build 均通过。
- Supabase 迁移 `202607220005_pattern_card_consumption.sql` 已部署。
