# CV and OCR pipeline

The active CV service analyzes exported bead-pattern sheets. It does not generate
patterns, inspect physical bead boards, or infer an exact MARD code from image
RGB alone.

```text
decode and normalize image
-> detect periodic horizontal and vertical grid lines
-> fit main-grid boundaries and cell geometry
-> slice inset cell regions
-> classify occupied, empty, or uncertain
-> extract robust Lab background features
-> conservatively cluster occupied cells and count them
-> match optional legend entries to clusters one-to-one
-> OCR several representative cells per unresolved cluster
-> cluster-level human confirmation
```

## Phase 1 boundary

Phase 1 stops after color-cluster counts and visual diagnostics. It does not map
formal MARD codes, write material versions, or change inventory.

Grid dimensions come from measured periodic structure. Thick group separators
and fine lines are modeled together. Adjacency and connectedness are weak
evidence only.

Each cell result retains its row, column, occupancy state, reason, and an
optional cluster identifier. Only confirmed occupied cells receive a material
cluster identifier. White and light cells receive a separate ambiguity check;
unresolved cases remain uncertain and are excluded from confirmed quantities.

Clustering uses inset cell corners in Lab space so center glyphs and grid lines
have less influence. Watermarks are not assumed to be perfectly removable;
affected cells remain uncertain or may be conservatively over-split. Later
phases may merge clusters only when color, legend, representative OCR, and
spatial evidence agree. For every response, the sum of confirmed cluster counts
must equal the confirmed occupied count.

## Later mapping phases

Legend quantities validate grid counts but never replace them. Legend swatches
and grid clusters use a missing-item-tolerant one-to-one assignment. Full MARD
codes from several clear cells vote within a cluster; standalone sequence
numbers are ignored. Palette color distance produces candidates only.

Any unstable grid, ambiguous occupancy, unresolved cluster, or conflicting
mapping requires cluster-level review. Recognition alone never changes stock.
