# Phase 14: pattern-card待做 reservations

## Outcome

A confirmed, fully stocked pattern card can be added to 待做. BeadFlow records
the exact immutable material version and holds every required color for that
card without reducing the user's on-hand inventory count.

The card detail distinguishes:

- on-hand inventory;
- inventory reserved for this card;
- inventory reserved by other pending cards;
- freely available inventory;
- the remaining shortage after reservations.

The user can cancel待做 to release the hold, or start production to convert the
hold into the existing audited inventory deduction.

## Transaction rules

- one account-level advisory transaction lock serializes reserve, release, and
  consume operations so two cards cannot win the same stock concurrently;
- one active reservation is allowed per account and pattern card;
- caller-generated UUID idempotency keys make network retries safe;
- reservation succeeds for all colors or none;
- reserving and releasing never alter `inventory_items.quantity` and never write
  a fake inventory transaction;
- starting production ignores the selected card's own hold but protects every
  other active hold, deducts all colors atomically, and marks the reservation
  consumed in the same transaction;
- a consumed reservation cannot be released;
- undoing a production deduction restores on-hand stock but does not silently
  recreate a pending reservation.

## Read calculations

Single-card inventory checks subtract all active reservations, then count the
selected card's own hold toward its requirements. Combined purchase lists keep
holds belonging to selected cards and subtract holds belonging to unselected
cards. Recommendation ranking evaluates each candidate against inventory after
subtracting every other card's holds, so reserved stock is never offered twice.

## Privacy and export

Reservation and reservation-item rows use owner-only RLS. The Phase 13 personal
data export is extended with both tables. No reservation endpoint accepts a user
ID from the browser.

## Verification

Automated coverage includes:

- a realistic 2,136-bead, six-color reservation;
- reserve, reload, release, and no-deduction behavior;
- another pending card consuming 100 of 120 available beads, leaving only 20
  freely available and increasing the competing card's shortage;
- recommendation behavior when two cards compete for 1,000 beads and 700 are
  already held;
- explicit insufficient-available-inventory conflict responses;
- the browser flow for adding待做 and releasing it again.

## Cloud acceptance

The user authorized deployment on 2026-07-22. Migration
`202607220008_pattern_card_reservations.sql` was applied to the linked Supabase
project and appears in the remote migration list.

The production-shaped acceptance used the confirmed card
`复杂大尺寸图纸验收` (2,136 beads across six colors):

- before reservation: 221 inventory rows, 233 inventory transactions, and no
  active reservation;
- while reserved: one active reservation containing 2,136 beads and six item
  rows; the inventory-row digest and transaction count were unchanged;
- after release: no active reservation, one released reservation retained for
  audit, and the same 221-row inventory digest and 233 transactions;
- the UI reported the full 2,136-bead hold for this card and returned to zero
  after release;
- the production/consume action was deliberately not invoked.

The inventory digest before, during, and after the reversible acceptance was
`D1AB069B04FD3FCDF3ED34D4EDB5396CBA6E722651F698BDFB0EAF0B12C623AF`.
