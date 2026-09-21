# Phase 13: structured personal-data export

## Outcome

An authenticated user can download a readable, versioned JSON copy of their
structured BeadFlow data from the pattern library. The export is intended for
inspection, backup, and future migration; it is not presented as a complete
image archive.

## Included data

- account ID, email, and account creation time;
- pattern-card assets and their source-file manifest fields;
- pattern cards, OCR review drafts, immutable material versions, and items;
- current inventory, thresholds, confidence, and inventory transactions;
- pattern-card consumption, itemized deductions, undo status, and audit logs;
- user-owned legacy projects, versions, cells, build sessions, progress, scans,
  and scan review records;
- all active MARD palette rows needed to interpret stored palette color IDs.

Arrays remain present when empty, so consumers can distinguish “no records”
from a missing export section. `schemaVersion` starts at `1.0` and
`generatedAt` records when the server assembled the snapshot.

## Deliberately excluded

- passwords, password hashes, access tokens, refresh tokens, and Supabase
  internal authentication fields;
- JPEG, PNG, and WebP binary content;
- records owned by another account.

The asset manifest keeps storage path, MIME type, and deletion state. When
`source_deleted_at` is present, the JSON documents the former asset but does not
claim the image can be recovered.

## Security design

`GET /api/account/export` requires the normal bearer token. The API forwards that
token to `export_my_beadflow_data()` and never accepts a user ID from the client.
The database function derives ownership from `auth.uid()`, filters every table
or ownership join, and is granted only to authenticated callers.

The browser serializes the returned object into a local Blob and downloads it as
`BeadFlow-个人数据-YYYY-MM-DD.json`. The access token is used only in the request
header and is never inserted into the file.

## Verification scope

Automated API coverage uses a realistic account snapshot containing 24 pattern
cards, 24 assets, 144 draft material rows, 221 inventory rows, and all 221
palette colors. Tests also verify unauthenticated rejection and that the caller
token is the only identity forwarded to the database function. Web tests verify
authenticated loading, readable JSON serialization, filename/download behavior,
token exclusion, and the visible pattern-library entry point.

## Cloud acceptance

Migration `202607220007_personal_data_export.sql` was deployed to the linked
Supabase project after explicit user authorization on 2026-07-22. A real signed-in
account then downloaded a 523,862-byte JSON file through the pattern-library
button.

The acceptance snapshot contained one pattern card, one asset with its permanent
source-deletion state, 221 inventory items, 233 inventory transactions, one
pattern-card consumption, 528 legacy records, and all 221 active palette colors.
The downloaded file parsed successfully as schema `1.0`, included three scope
notices, and contained no password, password-hash, access-token, or refresh-token
field.

## Remaining privacy work

This phase does not implement an image-binary ZIP archive, automatic retention
periods, self-service whole-account deletion, cross-border consent, or legal
review. Those remain separate release requirements.
