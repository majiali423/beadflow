"""Production-safe geometry and parsing for pattern-sheet legend OCR.

The OCR engine is an adapter concern. This module consumes positioned OCR
tokens, only accepts real palette codes, and never confirms materials or
mutates inventory.
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import median
from typing import Literal

from app.legend_parser import (
    canonicalize_mard_code,
    compact_pair_candidates,
    parse_legend_lines,
)


@dataclass(frozen=True)
class OcrToken:
    text: str
    x: float
    y: float
    width: float
    height: float
    confidence: float | None

    @property
    def center_x(self) -> float:
        return self.x + self.width / 2

    @property
    def center_y(self) -> float:
        return self.y + self.height / 2


@dataclass(frozen=True)
class ColumnLayout:
    """Repeated legend columns inferred from OCR geometry, not expected truth."""

    centers: tuple[float, ...]
    pitch: float
    top: float
    bottom: float


@dataclass(frozen=True)
class EvidenceRegion:
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class MaterialObservation:
    code: str
    quantity: int
    raw_text: str
    confidence: float | None
    evidence_region: EvidenceRegion
    source: Literal["direct", "compact", "spatial"]


def _union_region(*tokens: OcrToken) -> EvidenceRegion:
    left = min(token.x for token in tokens)
    top = min(token.y for token in tokens)
    right = max(token.x + token.width for token in tokens)
    bottom = max(token.y + token.height for token in tokens)
    return EvidenceRegion(left, top, right - left, bottom - top)


def _combined_confidence(*tokens: OcrToken) -> float | None:
    values = [token.confidence for token in tokens if token.confidence is not None]
    return min(values) if values else None


def _quantity_from_token(text: str) -> int | None:
    compact = text.strip().translate(str.maketrans("", "", "()（）[]【】{} "))
    if not compact.isdigit():
        return None
    quantity = int(compact)
    return quantity if 0 < quantity <= 99999 else None


def _pair_score(code: OcrToken, quantity: OcrToken) -> float | None:
    horizontal_gap = quantity.x - (code.x + code.width)
    vertical_delta = abs(quantity.center_y - code.center_y)
    # OCR boxes for adjacent code/count text can overlap slightly even when the
    # glyphs do not. Permit a bounded 20% overlap so the code keeps its own
    # nearest quantity instead of jumping to the next legend card.
    same_row = -max(6.0, code.width * 0.20) <= horizontal_gap <= max(
        160.0, code.height * 10
    ) and vertical_delta <= max(24.0, code.height * 1.25)
    if same_row:
        return max(horizontal_gap, 0) + vertical_delta * 3

    vertical_gap = quantity.y - (code.y + code.height)
    aligned = abs(quantity.center_x - code.center_x)
    below = -5 <= vertical_gap <= max(100.0, code.height * 5) and aligned <= max(
        45.0, code.width * 1.2
    )
    if below:
        return 200 + max(vertical_gap, 0) * 2 + aligned
    return None


def materials_from_tokens(
    tokens: list[OcrToken],
    valid_codes: frozenset[str],
    declared_total: int | None = None,
) -> tuple[dict[str, int], frozenset[str]]:
    """Extract conservative material pairs from positioned OCR tokens."""

    observations, conflicts = material_observations_from_tokens(tokens, valid_codes, declared_total)
    return (
        {code: observation.quantity for code, observation in observations.items()},
        conflicts,
    )


def material_observations_from_tokens(
    tokens: list[OcrToken],
    valid_codes: frozenset[str],
    declared_total: int | None = None,
) -> tuple[dict[str, MaterialObservation], frozenset[str]]:
    """Extract reviewable pairs while retaining their OCR evidence."""

    observations: list[MaterialObservation] = []
    code_tokens: list[tuple[int, OcrToken, str]] = []
    quantity_tokens: list[tuple[int, OcrToken, int]] = []
    for token_index, token in enumerate(tokens):
        for candidate in parse_legend_lines([token.text], valid_codes):
            observations.append(
                MaterialObservation(
                    code=candidate.code,
                    quantity=candidate.quantity,
                    raw_text=token.text,
                    confidence=token.confidence,
                    evidence_region=_union_region(token),
                    source="direct",
                )
            )
        compact_candidates = compact_pair_candidates(token.text, valid_codes, declared_total)
        if len(compact_candidates) == 1:
            compact = compact_candidates[0]
            observations.append(
                MaterialObservation(
                    code=compact.code,
                    quantity=compact.quantity,
                    raw_text=token.text,
                    confidence=token.confidence,
                    evidence_region=_union_region(token),
                    source="compact",
                )
            )
        code = canonicalize_mard_code(token.text, valid_codes)
        if code is not None:
            code_tokens.append((token_index, token, code))
        quantity = _quantity_from_token(token.text)
        if quantity is not None:
            quantity_tokens.append((token_index, token, quantity))

    used_quantities: set[int] = set()
    for code_index, code_token, code in code_tokens:
        scored: list[tuple[float, int, OcrToken, int]] = []
        for index, (_, quantity_token, quantity) in enumerate(quantity_tokens):
            if index in used_quantities:
                continue
            score = _pair_score(code_token, quantity_token)
            if score is not None:
                scored.append((score, index, quantity_token, quantity))
        if not scored:
            continue
        _, index, quantity_token, quantity = min(scored, key=lambda item: item[0])
        used_quantities.add(index)
        quantity_index = quantity_tokens[index][0]
        observations.append(
            MaterialObservation(
                code=code,
                quantity=quantity,
                raw_text=f"{tokens[code_index].text} {tokens[quantity_index].text}",
                confidence=_combined_confidence(code_token, quantity_token),
                evidence_region=_union_region(code_token, quantity_token),
                source="spatial",
            )
        )

    quantities_by_code: dict[str, set[int]] = {}
    for observation in observations:
        quantities_by_code.setdefault(observation.code, set()).add(observation.quantity)

    conflicts = frozenset(
        code for code, quantities in quantities_by_code.items() if len(quantities) != 1
    )
    unique: dict[str, MaterialObservation] = {}
    for observation in observations:
        if observation.code in conflicts:
            continue
        previous = unique.get(observation.code)
        previous_confidence = previous.confidence if previous is not None else None
        confidence = observation.confidence
        if previous is None or (confidence or -1) > (previous_confidence or -1):
            unique[observation.code] = observation
    return unique, conflicts


def infer_column_layout(
    tokens: list[OcrToken], image_width: int, image_height: int
) -> ColumnLayout | None:
    """Detect a code row followed by OCR-merged quantity runs."""

    quantity_runs = [
        token
        for token in tokens
        if token.text.strip().isdigit()
        and len(token.text.strip()) >= 6
        and token.center_y > image_height * 0.6
    ]
    row_tokens = [
        token
        for token in tokens
        if image_height * 0.35 <= token.center_y <= image_height * 0.68
        and len(token.text.strip()) <= 4
        and token.text.strip().isalnum()
    ]
    if not quantity_runs or len(row_tokens) < 8:
        return None

    centers = sorted(token.center_x for token in row_tokens)
    gaps = [right - left for left, right in zip(centers, centers[1:]) if right - left > 20]
    if len(gaps) < 5:
        return None
    lower_gap = sorted(gaps)[max(0, len(gaps) // 4 - 1)]
    pitch_candidates = [gap for gap in gaps if lower_gap * 0.75 <= gap <= lower_gap * 1.45]
    if len(pitch_candidates) < 4:
        return None
    pitch = float(median(pitch_candidates))
    first_center = centers[0]
    last_evidence_x = max(token.x + token.width for token in quantity_runs + row_tokens)
    column_count = round((last_evidence_x - first_center) / pitch) + 1
    if not 8 <= column_count <= 64:
        return None
    inferred_centers = tuple(first_center + index * pitch for index in range(column_count))
    if inferred_centers[-1] > image_width + pitch:
        return None
    return ColumnLayout(
        centers=inferred_centers,
        pitch=pitch,
        top=max(0.0, min(token.y for token in row_tokens) - image_height * 0.05),
        bottom=float(image_height),
    )


def merge_material_results(
    primary: dict[str, int],
    primary_conflicts: frozenset[str],
    fallback: dict[str, int],
    fallback_conflicts: frozenset[str],
) -> tuple[dict[str, int], frozenset[str]]:
    """Merge agreeing OCR passes and remove every conflicting code."""

    merged = dict(primary)
    conflicts = set(primary_conflicts) | set(fallback_conflicts)
    for code, quantity in fallback.items():
        if code in merged and merged[code] != quantity:
            conflicts.add(code)
            merged.pop(code)
        elif code not in conflicts:
            merged[code] = quantity
    for code in conflicts:
        merged.pop(code, None)
    return merged, frozenset(conflicts)
