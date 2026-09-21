# Architecture

BeadFlow uses a monorepo with three independently deployable surfaces:

- `apps/web`: React PWA shell and user workflows.
- `apps/api`: validated domain API and Agent tool boundary.
- `apps/cv-service`: local image preprocessing, replaceable OCR adapters, and
  constrained MARD legend parsing.

Formal state belongs in PostgreSQL/Supabase. The browser may hold upload and
review drafts, but it is never the only store for confirmed material versions,
reservations, or inventory transactions.

The active recognition flow is:

```text
private pattern image
-> grid detection and cell slicing
-> occupied/empty/uncertain classification
-> conservative color clustering and grid-derived counts
-> legend and representative-cell code evidence
-> cluster-level review
-> versioned material list
-> inventory/shortage engine
-> reservation or confirmed consumption
-> deterministic recommendation engine
```

The main grid is authoritative for quantities. OCR output and palette color
similarity are evidence for cluster naming, not formal state. The API validates
all confirmed MARD codes against the user-verified palette. Recommendation logic
reads structured, confirmed materials and never infers stock fit directly from
image colors.
