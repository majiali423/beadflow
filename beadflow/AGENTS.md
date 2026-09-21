# BeadFlow 图纸库存助手开发指令

This directory is the only active product: a Web/PWA for pattern-sheet grid
counting, verified MARD-code mapping, inventory, shortage, and recommendations.
The former Flutter generator, matrix editor, physical-board workflow, and their
historical caps have been removed and must not be recreated.

Before changing code:

1. Read `SPEC.md` completely.
2. Treat `SPEC.md` as the only current product specification.
3. Work on one development phase only.
4. List planned files and missing prerequisites.

Non-negotiable rules:

- Prefer correctness, user control, reversibility, and deterministic logic.
- Do not add arbitrary-photo-to-pattern generation, physical-board color
  guessing, or a self-trained model.
- Do not invent MARD codes, HEX values, CV results, inventory, or project data.
- Load formal MARD values only from `assets/palettes/mard221.json`.
- Accept real exported pattern sheets at their detected positive row, column,
  and color-cluster counts; do not add an arbitrary product cap.
- Keep OCR, parsing, inventory, and recommendation logic outside UI components.
- Low-confidence OCR results must never update formal materials or inventory
  automatically.
- The main grid is authoritative for quantities. Legends and representative
  in-cell text map color clusters to MARD codes; unresolved clusters require one
  cluster-level user confirmation.
- Phase 1 implements only grid detection, cell occupancy, and conservative color
  clustering. It must not change inventory and must not add a new model.
- Default to ignoring empty grid background without discarding valid white or
  light-colored beads.
- All write operations require validation; Agent write tools also require explicit confirmation.
- Upload and recognition are read-only with respect to inventory. Reservation,
  consumption, and rollback are separate confirmed transactions.
- Do not claim unmeasured OCR or CV reliability.
- OCR benchmarks must use the user's real complex fixtures and report per-image
  failures, not only aggregate scores.
- Keep third-party or watermarked reference images in ignored private fixtures;
  do not publish or redistribute them.
- Add tests and run formatting, lint, typecheck, and tests for the active phase.
