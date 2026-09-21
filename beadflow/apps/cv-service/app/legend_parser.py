"""Constrained parsing for MARD pattern-sheet legends.

OCR text is untrusted evidence. This module never invents a palette code and
never mutates inventory or formal pattern data.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable


_CODE_SHAPE = re.compile(r"^([A-Z])0*(\d{1,2})$")
_PAIR_PATTERN = re.compile(
    r"(?<![A-Z0-9])(?P<code>[A-Z]\s*0*\d{1,2})(?!\d)"
    r"\s*(?:[:：=]|[-–—])?\s*"
    r"[\(（\[【{]?\s*(?P<quantity>\d{1,5})\s*[\)）\]】}]?",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class LegendCandidate:
    """One whitelist-backed OCR material candidate."""

    code: str
    quantity: int
    raw_code: str
    raw_text: str
    source_line: int


@dataclass(frozen=True)
class CompactPairCandidate:
    """A possible split of an OCR token that merged code and quantity."""

    code: str
    quantity: int


def canonicalize_mard_code(raw_code: str, valid_codes: frozenset[str]) -> str | None:
    """Return the unique palette code represented by a safe spelling variant.

    The only automatic rewrite is whitespace/case cleanup and removal of
    numeric leading zeroes, e.g. ``H07`` -> ``H7``. Ambiguous OCR character
    substitutions such as O/0 and I/1 are intentionally not performed.
    """

    compact = re.sub(r"\s+", "", raw_code).upper()
    match = _CODE_SHAPE.fullmatch(compact)
    if match is None:
        return None
    canonical = f"{match.group(1)}{int(match.group(2))}"
    return canonical if canonical in valid_codes else None


def parse_legend_lines(
    lines: Iterable[str], valid_codes: frozenset[str]
) -> tuple[LegendCandidate, ...]:
    """Extract safe color/quantity pairs from OCR lines.

    Invalid codes, zero quantities, and coordinates without a code are ignored.
    Duplicate codes are retained as separate evidence for the review layer.
    """

    candidates: list[LegendCandidate] = []
    for line_number, original_line in enumerate(lines):
        line = original_line.upper()
        for match in _PAIR_PATTERN.finditer(line):
            code = canonicalize_mard_code(match.group("code"), valid_codes)
            quantity = int(match.group("quantity"))
            if code is None or quantity <= 0:
                continue
            candidates.append(
                LegendCandidate(
                    code=code,
                    quantity=quantity,
                    raw_code=match.group("code"),
                    raw_text=match.group(0),
                    source_line=line_number,
                )
            )
    return tuple(candidates)


def compact_pair_candidates(
    raw_text: str,
    valid_codes: frozenset[str],
    declared_total: int | None = None,
) -> tuple[CompactPairCandidate, ...]:
    """Return all safe palette-backed splits of a merged token.

    OCR commonly returns ``F11299`` for ``F11 (299)``. This fallback is limited
    to three-or-more-digit quantities: otherwise an ordinary code token such as
    ``B11`` could be misread as ``B1 (1)``. A split is accepted only when its
    prefix is an exact real palette code. The declared pattern total may reject
    impossible quantities, but it is never used to guess between multiple
    remaining codes.
    """

    compact = re.sub(r"\s+", "", raw_text.upper())
    if re.fullmatch(r"[A-Z]\d{4,}", compact) is None:
        return ()
    candidates: list[CompactPairCandidate] = []
    for code in valid_codes:
        if not compact.startswith(code):
            continue
        quantity_text = compact[len(code) :]
        if len(quantity_text) < 3 or not quantity_text.isdigit():
            continue
        quantity = int(quantity_text)
        if quantity <= 0 or quantity > 99999:
            continue
        if declared_total is not None and quantity > declared_total:
            continue
        candidates.append(CompactPairCandidate(code=code, quantity=quantity))
    return tuple(sorted(candidates, key=lambda candidate: (candidate.code, candidate.quantity)))


def collapse_unique_candidates(
    candidates: Iterable[LegendCandidate],
) -> tuple[dict[str, int], frozenset[str]]:
    """Collapse exact duplicate evidence and flag conflicting quantities.

    Repeated identical OCR observations are common when an engine emits both a
    word and line. Conflicting quantities are not silently merged.
    """

    values: dict[str, set[int]] = {}
    for candidate in candidates:
        values.setdefault(candidate.code, set()).add(candidate.quantity)

    materials: dict[str, int] = {}
    conflicts: set[str] = set()
    for code, quantities in values.items():
        if len(quantities) == 1:
            materials[code] = next(iter(quantities))
        else:
            conflicts.add(code)
    return materials, frozenset(conflicts)
