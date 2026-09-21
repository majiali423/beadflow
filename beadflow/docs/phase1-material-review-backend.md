# Phase 1 材料人工复核后端

更新时间：2026-07-22

## 已完成

- `GET /api/pattern-cards/:id/review`：读取当前用户的复核草稿；
- `PUT /api/pattern-cards/:id/review`：保存完整草稿，支持修改、删除、补充、冲突列表和声明总数；
- `POST /api/pattern-cards/:id/review/confirm`：明确确认后创建不可变材料版本；
- 每个保存请求必须携带 `expectedRevision`，防止另一页面或设备静默覆盖修改；
- 同一色号重复、非法色卡 ID、非法数量和“手工新增但仍待确认”会在写库前拒绝；
- 未解决冲突、仍有待确认项、未接受的总数差异会阻止正式确认；
- 草稿保存和正式确认均通过单个 Supabase RPC 事务完成；
- 正式确认不会扣减、预留或恢复库存；
- 保存与确认写入审计日志。

## 数据模型

- `pattern_assets`：私有原图及去重信息；
- `pattern_cards`：图纸资料卡、声明总数、识别总数、复核 revision 和当前材料版本；
- `pattern_material_draft_items`：可编辑复核草稿及 OCR 证据；
- `pattern_material_versions`：用户确认后的不可变版本头；
- `pattern_material_items`：正式版本材料项。

所有表启用 RLS，只允许登录用户读取自己的数据；写操作不开放直接表权限，只能通过校验所有权的安全 RPC 完成。

## 已验证

- 真实规模的 21 色草稿保存；
- 重复色号拒绝；
- revision 冲突返回 409；
- 未完成复核返回 422；
- 只有明确确认请求才创建正式版本；
- Supabase RPC 请求体和错误映射；
- 全项目格式、lint、类型检查通过；
- API 45 项、Web 58 项、领域包 32 项测试全部通过；
- API 生产构建通过。

## 尚未执行

迁移文件 `202607220001_pattern_material_reviews.sql` 已通过 Supabase `db push --dry-run`，确认云端只会新增这一条迁移，但尚未推送到云端项目。推送属于数据库结构变更，需要用户明确授权后执行。

迁移完成后还需要：

1. 用真实登录账户创建一张私有资料卡和复核草稿；
2. 验证另一个账户无法读取或修改；
3. 验证保存、并发冲突、确认版本和审计日志；
4. 再接入 Web 人工复核页面。
