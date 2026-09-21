# API conventions

- JSON is the default request and response format.
- Errors use `{ "error": { "code", "message", "requestId" } }`.
- Client-provided paths and user identifiers are never trusted.
- Write endpoints require validation, authorization, and audit logging.
- Agent write tools additionally require an explicit user confirmation.

## Phase 1 implemented routes

- `GET /api/projects` lists only projects visible to the authenticated user.
- `POST /api/projects` creates an owned project through an audited database transaction.
- `POST /api/projects/:id/patterns` validates and saves the next immutable pattern version.
- `GET /api/projects/:id/patterns/latest` retrieves the authenticated user's latest version
  for reload recovery and safe conflict reconciliation.
- `GET /api/projects/:id/patterns` lists immutable versions newest first.
- `GET /api/projects/:id/patterns/:version` reads one exact immutable version for history
  review. Restoring old content is a client draft operation; the next save still creates a
  new version.

All project routes forward the user's access token to Supabase and rely on RLS or
owner-checking RPCs. A client never supplies a trusted user ID.

## Phase 2 implemented routes

- `GET /api/inventory` lists only the authenticated user's inventory items.
- `PUT /api/inventory/:paletteColorId` sets an absolute non-negative quantity,
  confidence, and optional low-stock threshold. A quantity change creates a
  `manual_adjustment` transaction in the same database transaction.
- `GET /api/inventory/transactions` lists the authenticated user's 200 most recent
  traceable inventory changes.
- `POST /api/inventory/transactions` applies a non-zero purchase, adjustment,
  reservation, consumption, or rollback delta atomically.

Inventory writes never accept a client-provided user ID. The database locks the
user/color inventory row, rejects a negative result, updates the balance, records
the transaction, and writes an audit log as one operation.

## Pattern-card material routes

- `POST /api/pattern-cards/detect-legend-crop` accepts one authenticated image body and
  returns a visible, user-adjustable legend range, confidence, detection method, and
  manual-review flag. It does not store the image or modify inventory.
- `POST /api/pattern-cards/import?name=...&cropYStart=0.7&cropYEnd=0.99`
  accepts one JPEG, PNG, or WebP body, runs the formal legend OCR, stores the
  private source image, and creates a pending review draft. `declaredTotal` is
  optional. Exact duplicate files return the existing active card.
  The upstream OCR request times out after 60 seconds with `PATTERN_OCR_TIMEOUT`;
  no draft, formal material, or inventory change is created by that failed request.
- `GET /api/pattern-cards/:id/source` returns a short-lived signed URL for the
  authenticated owner to reload the private source during review, or its deletion
  timestamp after the source has been removed.
- `DELETE /api/pattern-cards/:id/source` permanently removes the private source image
  for a confirmed card. The confirmed material version, inventory, consumption history,
  and audit data remain intact. Repeated deletion is idempotent.
- `GET /api/pattern-cards/:id/review` reads the editable OCR review draft.
- `PUT /api/pattern-cards/:id/review` saves the complete draft with optimistic
  revision checking.
- `POST /api/pattern-cards/:id/review/confirm` creates an immutable, confirmed
  material version after every conflict and pending item is resolved.
- `GET /api/pattern-cards/:id/reservation` returns the card's active待做
  reservation, if one exists.
- `POST /api/pattern-cards/:id/reserve` atomically reserves every material in the
  latest confirmed version without reducing on-hand inventory. It requires a
  caller-generated UUID idempotency key.
- `POST /api/pattern-card-reservations/:id/release` explicitly cancels an active
  待做 reservation. Repeated release is safe; a reservation already converted
  into production cannot be released.
- `GET /api/pattern-cards/:id/inventory-check` compares only the latest confirmed
  material version with the authenticated user's current inventory.
- `GET /api/pattern-cards/:id/purchase-list` returns the same check plus a
  shortage-sorted copyable and CSV purchase list.
- `POST /api/pattern-cards/combined-purchase-list` accepts 1–20 unique confirmed
  pattern-card IDs, merges quantities for matching MARD codes, compares the combined
  requirement with the user's current inventory once, and returns copyable/CSV shortage
  output. It is a read-only calculation despite using POST for the explicit selection.
- `GET /api/pattern-card-recommendations?mode=ready|least_shortage|use_stockpile&limit=10&minTotalBeads=501&maxTotalBeads=1500`
  ranks confirmed cards with one explicit goal. `ready` excludes every shortage;
  `least_shortage` sorts by missing beads and then missing colors; `use_stockpile`
  favors buildable cards that consume the most stock above each color's warning
  threshold and returns the contributing MARD codes. The optional inclusive bead
  range is applied before ranking.

The inventory-check routes are read-only. They never use an unconfirmed OCR
draft and never reserve, deduct, or otherwise mutate inventory. Checks,
combined purchase lists, and recommendations subtract stock reserved for other
pending cards. Starting production consumes the selected card's reservation and
deducts on-hand inventory in the same database transaction.

## Account data routes

- `GET /api/account/export` returns a versioned JSON copy of the authenticated
  user's structured BeadFlow data. It includes current pattern-card, material,
  inventory, consumption, and audit records; user-owned legacy project data; and
  the active MARD palette reference needed to interpret saved color IDs.

The route forwards only the caller's access token to an owner-scoped database
function. It never exports passwords, authentication tokens, Supabase internal
auth fields, or image binaries. Source-image paths, MIME types, and deletion
timestamps are included as a manifest so a deleted source cannot appear to be
recoverable.

## Phase 4 implemented routes

- `POST /api/projects/:id/scans` uploads one JPEG, PNG, or WebP image and runs
  quality and automatic-corner inspection.
- `GET /api/scans/:id` returns one scan owned by the authenticated user with
  short-lived signed image URLs.
- `POST /api/scans/:id/corners` validates and saves four normalized manual
  corner-peg centers in top-left, top-right, bottom-right, bottom-left order.
- `POST /api/scans/:id/placement` stores the physical board dimensions and the
  formal pattern's zero-based top-left origin after proving the whole pattern
  fits on the board.
- `POST /api/scans/:id/process` rectifies the full physical board only after
  quality, corners, physical dimensions, and pattern placement are accepted.
- `POST /api/scans/:id/review/confirm` requires an explicit `confirmation: true`,
  atomically marks reviewed progress, deducts only newly consumed non-empty
  cells, and permanently prevents the same scan from being submitted twice.
- `POST /api/scans/:id/review/rollback` restores the exact prior cell progress
  and inventory in an audited transaction. It refuses rollback if later work
  has already changed any affected cell.

The server derives storage paths, owner identity, pattern version, and grid size.
Raw and rectified images stay in a private bucket. Geometry processing itself
does not write cell state, inventory, or production progress. Only the separate
Phase 5 confirmed-review endpoint can do so.

# 主网格只读复核

`POST /pattern-grid/analyze`

上传 `JPEG`、`PNG` 或 `WebP` 图纸，返回主网格尺寸、每格的保守三态结果和背景颜色簇。该接口具有以下固定安全语义：

- `status` 始终为 `needs_review`；
- `requires_user_confirmation` 始终为 `true`；
- `inventory_mutated` 始终为 `false`；
- 不接收图纸标题中的尺寸、颜色数或总颗数作为推理参数；
- 网格不稳定时返回 `grid_detected: false` 和原因，不构造格子；
- `occupied` 仅代表当前 CV 可以保守确认，`uncertain` 必须等待颜色簇、图例 OCR 或人工复核；
- 此接口不能确认材料色号，也不能扣减库存。

表单字段：

- `image`：最大 15MB 的图纸文件。

主要响应字段：

- `row_count`、`column_count`：检测到的主网格尺寸；
- `occupied_count`、`empty_count`、`uncertain_count`：三态格子数量；
- `cells`：行列坐标、状态和判断原因；只有 `occupied` 格带有颜色簇编号，`empty` 与 `uncertain` 不计入材料簇；
- `color_clusters`：仅由已确认占用格组成的保守 Lab 背景颜色簇；其 `cell_count` 之和必须严格等于 `occupied_count`；
- `reasons`：需要后续复核的原因。
