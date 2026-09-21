"""Conservative periodic-grid geometry evidence for exported bead patterns.

This module deliberately does not read titles, legends, or expected dimensions.
It only estimates the repeating cell pitch from long line evidence. Final grid
bounds and row/column counts belong to the next stage of the pipeline.
"""

from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image


GrayImage = NDArray[np.uint8]
FloatArray = NDArray[np.float64]


@dataclass(frozen=True)
class AxisPitch:
    pixels: float
    direct_gap_evidence: float
    candidate_line_count: int


@dataclass(frozen=True)
class GridPeriodicity:
    status: Literal["detected", "needs_review"]
    x: AxisPitch | None
    y: AxisPitch | None
    square_mismatch_ratio: float | None
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class GridColumnGeometry:
    status: Literal["detected", "needs_review"]
    column_count: int | None
    left: float | None
    right: float | None
    pitch: float | None
    boundary_residual_ratio: float | None
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class GridRowGeometry:
    status: Literal["detected", "needs_review"]
    row_count: int | None
    top: float | None
    bottom: float | None
    pitch: float | None
    candidate_counts: tuple[int, ...]
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class CellRegion:
    row: int
    column: int
    left: float
    top: float
    right: float
    bottom: float
    sample_left: float
    sample_top: float
    sample_right: float
    sample_bottom: float


@dataclass(frozen=True)
class GridCells:
    status: Literal["detected", "needs_review"]
    row_count: int | None
    column_count: int | None
    cells: tuple[CellRegion, ...]
    reasons: tuple[str, ...]


def _line_projection(gray: GrayImage, axis: Literal["x", "y"]) -> FloatArray:
    height, width = gray.shape
    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_MEAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        10,
    )
    if axis == "x":
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(9, height // 100)))
        lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
        return np.asarray((lines[: int(height * 0.82)] > 0).mean(axis=0), dtype=np.float64)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, width // 100), 1))
    lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    return np.asarray(
        (lines[:, int(width * 0.03) : int(width * 0.97)] > 0).mean(axis=1),
        dtype=np.float64,
    )


def _candidate_centers(projection: FloatArray) -> FloatArray:
    threshold = max(0.035, float(np.quantile(projection, 0.82)))
    indexes = np.flatnonzero(projection > threshold)
    groups: list[list[int]] = []
    for index_value in indexes:
        index = int(index_value)
        if not groups or index > groups[-1][-1] + 1:
            groups.append([index])
        else:
            groups[-1].append(index)
    return np.asarray([float(np.mean(group)) for group in groups], dtype=np.float64)


def _pair_distances(centers: FloatArray) -> FloatArray:
    distances = [
        float(centers[right] - centers[left])
        for left in range(len(centers))
        for right in range(left + 1, len(centers))
        if centers[right] - centers[left] <= 300
    ]
    return np.asarray(distances, dtype=np.float64)


def _pitch_candidates(projection: FloatArray) -> list[AxisPitch]:
    centers = _candidate_centers(projection)
    if len(centers) < 8:
        return []
    distances = _pair_distances(centers)
    if len(distances) == 0:
        return []

    scored: list[tuple[float, AxisPitch]] = []
    for pitch in np.arange(10.0, 81.0, 0.25):
        multiples = np.maximum(1, np.rint(distances / pitch))
        residuals = np.abs(distances - multiples * pitch)
        aligned = np.exp(-((residuals / 1.35) ** 2)) / (multiples**0.7)
        direct = float(np.sum(np.exp(-(((distances - pitch) / 1.6) ** 2))))
        half_pitch = (
            float(np.sum(np.exp(-(((distances - pitch / 2) / 1.6) ** 2)))) if pitch >= 20 else 0.0
        )
        score = float(np.sum(aligned)) + 2 * direct - 0.5 * half_pitch
        scored.append(
            (
                score,
                AxisPitch(
                    pixels=float(pitch),
                    direct_gap_evidence=direct,
                    candidate_line_count=len(centers),
                ),
            )
        )
    return [candidate for _, candidate in sorted(scored, key=lambda item: item[0], reverse=True)]


def _phase_positions(projection: FloatArray, pitch: float) -> tuple[FloatArray, FloatArray]:
    best: tuple[float, FloatArray, FloatArray] | None = None
    for offset in np.arange(0, pitch, 0.25):
        positions = np.arange(offset, len(projection), pitch, dtype=np.float64)
        strengths = np.asarray(
            [
                float(
                    np.max(
                        projection[
                            max(0, int(round(position)) - 1) : min(
                                len(projection), int(round(position)) + 2
                            )
                        ]
                    )
                )
                for position in positions
            ],
            dtype=np.float64,
        )
        score = float(np.quantile(strengths, 0.75) + 0.3 * np.mean(strengths))
        if best is None or score > best[0]:
            best = (score, positions, strengths)
    if best is None:
        return np.asarray([], dtype=np.float64), np.asarray([], dtype=np.float64)
    return best[1], best[2]


def detect_grid_periodicity(image: Image.Image) -> GridPeriodicity:
    """Estimate square-cell pitch, returning review instead of forced geometry."""

    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    gray = np.asarray(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), dtype=np.uint8)
    x_candidates = _pitch_candidates(_line_projection(gray, "x"))
    y_candidates = _pitch_candidates(_line_projection(gray, "y"))
    if not x_candidates or not y_candidates:
        return GridPeriodicity(
            status="needs_review",
            x=x_candidates[0] if x_candidates else None,
            y=y_candidates[0] if y_candidates else None,
            square_mismatch_ratio=None,
            reasons=("insufficient_periodic_line_evidence",),
        )

    x_pitch = x_candidates[0]
    comparable_y = [
        candidate
        for candidate in y_candidates[:80]
        if abs(candidate.pixels - x_pitch.pixels) / x_pitch.pixels <= 0.12
    ]
    if not comparable_y:
        return GridPeriodicity(
            status="needs_review",
            x=x_pitch,
            y=y_candidates[0],
            square_mismatch_ratio=abs(y_candidates[0].pixels - x_pitch.pixels) / x_pitch.pixels,
            reasons=("horizontal_vertical_pitch_conflict",),
        )

    y_pitch = comparable_y[0]
    mismatch = abs(y_pitch.pixels - x_pitch.pixels) / ((x_pitch.pixels + y_pitch.pixels) / 2)
    weak_evidence = min(x_pitch.direct_gap_evidence, y_pitch.direct_gap_evidence) < 4
    reasons = ("weak_direct_gap_evidence",) if weak_evidence else ()
    return GridPeriodicity(
        status="needs_review" if reasons else "detected",
        x=x_pitch,
        y=y_pitch,
        square_mismatch_ratio=mismatch,
        reasons=reasons,
    )


def detect_grid_columns(image: Image.Image) -> GridColumnGeometry:
    """Detect the main grid's horizontal bounds without reading printed dimensions."""

    periodicity = detect_grid_periodicity(image)
    if periodicity.x is None:
        return GridColumnGeometry(
            status="needs_review",
            column_count=None,
            left=None,
            right=None,
            pitch=None,
            boundary_residual_ratio=None,
            reasons=periodicity.reasons,
        )

    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    gray = np.asarray(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), dtype=np.uint8)
    projection = _line_projection(gray, "x")
    pitch = periodicity.x.pixels
    positions, strengths = _phase_positions(projection, pitch)
    if len(positions) < 10:
        return GridColumnGeometry(
            status="needs_review",
            column_count=None,
            left=None,
            right=None,
            pitch=pitch,
            boundary_residual_ratio=None,
            reasons=("insufficient_boundary_evidence",),
        )

    width = image.width
    left_candidates = [
        index
        for index, (position, strength) in enumerate(zip(positions, strengths, strict=True))
        if position < 2.2 * pitch and strength > 0.05
    ]
    right_candidates = [
        index
        for index, (position, strength) in enumerate(zip(positions, strengths, strict=True))
        if position > width - 2.2 * pitch and strength > 0.05
    ]
    left_index = min(left_candidates) if left_candidates else int(np.argmin(abs(positions - pitch)))
    right_index = (
        max(right_candidates)
        if right_candidates
        else int(np.argmin(abs(positions - (width - pitch))))
    )
    if width - positions[right_index] > 1.5 * pitch:
        right_index = int(np.argmin(abs(positions - (width - pitch))))

    detected_left = float(positions[left_index])
    detected_right = float(positions[right_index])
    raw_intervals = (detected_right - detected_left) / pitch
    rounded_intervals = round(raw_intervals)
    has_left_coordinate_band = detected_left < 0.6 * pitch
    has_right_coordinate_band = width - detected_right < 0.6 * pitch
    column_count = (
        rounded_intervals - int(has_left_coordinate_band) - int(has_right_coordinate_band)
    )
    main_left = detected_left + (pitch if has_left_coordinate_band else 0)
    main_right = detected_right - (pitch if has_right_coordinate_band else 0)
    residual = abs(raw_intervals - rounded_intervals)
    reasons: tuple[str, ...] = ()
    if column_count <= 0 or residual > 0.2:
        reasons = ("unstable_horizontal_grid_bounds",)

    return GridColumnGeometry(
        status="needs_review" if reasons else "detected",
        column_count=column_count if column_count > 0 else None,
        left=main_left,
        right=main_right,
        pitch=pitch,
        boundary_residual_ratio=residual,
        reasons=reasons,
    )


def _longest_true_run(mask: NDArray[np.bool_]) -> tuple[int, int, int]:
    closed = cv2.morphologyEx(
        (mask.astype(np.uint8) * 255).reshape(-1, 1),
        cv2.MORPH_CLOSE,
        np.ones((3, 1), dtype=np.uint8),
    ).ravel()
    best = (0, 0, -1)
    start: int | None = None
    for index, value in enumerate(closed > 0):
        if value and start is None:
            start = index
        if start is not None and (not value or index == len(closed) - 1):
            end = index if value and index == len(closed) - 1 else index - 1
            best = max(best, (end - start + 1, start, end))
            start = None
    return best


def _has_digit_like_component(crop: GrayImage) -> bool:
    if crop.size == 0:
        return False
    height, width = crop.shape
    block_size = max(3, (min(height, width) // 2) * 2 + 1)
    binary = cv2.adaptiveThreshold(
        crop,
        255,
        cv2.ADAPTIVE_THRESH_MEAN_C,
        cv2.THRESH_BINARY_INV,
        block_size,
        5,
    )
    component_count, _, stats, centroids = cv2.connectedComponentsWithStats(
        (binary > 0).astype(np.uint8), connectivity=8
    )
    for index in range(1, component_count):
        component_width = int(stats[index, cv2.CC_STAT_WIDTH])
        component_height = int(stats[index, cv2.CC_STAT_HEIGHT])
        area = int(stats[index, cv2.CC_STAT_AREA])
        center_x, center_y = centroids[index]
        if (
            area >= max(2, 0.008 * height * width)
            and area <= 0.45 * height * width
            and component_height >= 0.18 * height
            and component_height <= 0.95 * height
            and component_width <= 0.9 * width
            and 0.05 * width <= center_x <= 0.95 * width
            and 0.05 * height <= center_y <= 0.95 * height
        ):
            return True
    return False


def _digit_component_centers(gray: GrayImage, start: int, end: int, pitch: float) -> list[float]:
    crop = gray[:, start:end]
    block_size = max(3, (int(pitch) // 2) * 2 + 1)
    binary = cv2.adaptiveThreshold(
        crop,
        255,
        cv2.ADAPTIVE_THRESH_MEAN_C,
        cv2.THRESH_BINARY_INV,
        block_size,
        5,
    )
    horizontal = cv2.morphologyEx(
        binary,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int((end - start) * 0.75)), 1)),
    )
    vertical = cv2.morphologyEx(
        binary,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(3, int(pitch * 0.8)))),
    )
    cleaned = cv2.bitwise_and(binary, cv2.bitwise_not(cv2.bitwise_or(horizontal, vertical)))
    component_count, _, stats, centroids = cv2.connectedComponentsWithStats(
        (cleaned > 0).astype(np.uint8), connectivity=8
    )
    centers: list[float] = []
    strip_width = end - start
    for index in range(1, component_count):
        component_width = int(stats[index, cv2.CC_STAT_WIDTH])
        component_height = int(stats[index, cv2.CC_STAT_HEIGHT])
        area = int(stats[index, cv2.CC_STAT_AREA])
        center_x, center_y = centroids[index]
        if (
            0.12 * pitch <= component_height <= 0.9 * pitch
            and 1 <= component_width <= 0.8 * pitch
            and 2 <= area <= 0.5 * pitch * pitch
            and 0.05 * strip_width <= center_x <= 0.95 * strip_width
        ):
            centers.append(float(center_y))

    grouped: list[list[float]] = []
    for center in sorted(centers):
        if not grouped or center - float(np.mean(grouped[-1])) > 0.35 * pitch:
            grouped.append([center])
        else:
            grouped[-1].append(center)
    return [float(np.mean(group)) for group in grouped]


def _matched_digit_centers(
    gray: GrayImage, strips: list[tuple[int, int]], pitch: float
) -> list[float]:
    left = _digit_component_centers(gray, strips[0][0], strips[0][1], pitch)
    right = _digit_component_centers(gray, strips[1][0], strips[1][1], pitch)
    matched: list[float] = []
    for left_center in left:
        nearby = [center for center in right if abs(center - left_center) < 0.38 * pitch]
        if nearby:
            right_center = min(nearby, key=lambda center: abs(center - left_center))
            matched.append((left_center + right_center) / 2)

    grouped: list[list[float]] = []
    for center in sorted(matched):
        if not grouped or center - float(np.mean(grouped[-1])) > 0.45 * pitch:
            grouped.append([center])
        else:
            grouped[-1].append(center)
    return [float(np.mean(group)) for group in grouped]


def _longest_regular_sequence(centers: list[float], pitch: float) -> list[float]:
    if not centers:
        return []
    scores = [1] * len(centers)
    previous = [-1] * len(centers)
    for current in range(len(centers)):
        for candidate in range(current):
            distance = centers[current] - centers[candidate]
            if 0.72 * pitch <= distance <= 1.28 * pitch and scores[candidate] + 1 > scores[current]:
                scores[current] = scores[candidate] + 1
                previous[current] = candidate
    index = max(range(len(centers)), key=lambda candidate: scores[candidate])
    sequence: list[float] = []
    while index >= 0:
        sequence.append(centers[index])
        index = previous[index]
    return list(reversed(sequence))


def detect_grid_rows(image: Image.Image) -> GridRowGeometry:
    """Count only stable row-label runs; ambiguous sheets are sent to review."""

    columns = detect_grid_columns(image)
    periodicity = detect_grid_periodicity(image)
    if (
        columns.status != "detected"
        or columns.left is None
        or columns.right is None
        or periodicity.y is None
    ):
        return GridRowGeometry(
            status="needs_review",
            row_count=None,
            top=None,
            bottom=None,
            pitch=periodicity.y.pixels if periodicity.y else None,
            candidate_counts=(),
            reasons=("horizontal_bounds_required",),
        )

    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    gray = np.asarray(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), dtype=np.uint8)
    binary = (
        cv2.adaptiveThreshold(
            gray,
            255,
            cv2.ADAPTIVE_THRESH_MEAN_C,
            cv2.THRESH_BINARY_INV,
            31,
            10,
        )
        > 0
    )
    # The long vertical lines provide the strongest pitch evidence on these
    # sheets. Periodicity has already verified that the horizontal estimate is
    # compatible, so use the less drift-prone vertical-line pitch for slicing.
    pitch = columns.pitch if columns.pitch is not None else periodicity.y.pixels
    strip_bounds: list[tuple[int, int]] = []
    for center in (columns.left - pitch / 2, columns.right + pitch / 2):
        start = max(0, int(center - pitch * 0.22))
        end = min(image.width, int(center + pitch * 0.22))
        if end - start >= 3:
            strip_bounds.append((start, end))
    if len(strip_bounds) < 2:
        return GridRowGeometry(
            status="needs_review",
            row_count=None,
            top=None,
            bottom=None,
            pitch=pitch,
            candidate_counts=(),
            reasons=("side_coordinate_bands_not_visible",),
        )

    line_projection = np.max(
        np.stack([binary[:, start:end].mean(axis=1) for start, end in strip_bounds], axis=0),
        axis=0,
    )
    positions, _ = _phase_positions(
        np.asarray(line_projection, dtype=np.float64),
        pitch,
    )
    if len(positions) < 4:
        return GridRowGeometry(
            status="needs_review",
            row_count=None,
            top=None,
            bottom=None,
            pitch=pitch,
            candidate_counts=(),
            reasons=("insufficient_row_line_evidence",),
        )

    cell_ink: list[float] = []
    for first, second in zip(positions[:-1], positions[1:], strict=True):
        top = int(first + pitch * 0.3)
        bottom = int(second - pitch * 0.3)
        side_ink = [float(binary[top:bottom, start:end].mean()) for start, end in strip_bounds]
        cell_ink.append(min(side_ink))
    ink = np.asarray(cell_ink, dtype=np.float64)
    thresholds = (0.015, 0.025, 0.035, 0.05, 0.07, 0.1)
    runs = tuple(_longest_true_run(ink > threshold) for threshold in thresholds)
    candidate_counts = tuple(run[0] for run in runs)
    stable = len(set(candidate_counts)) == 1 and candidate_counts[0] >= 3
    chosen = runs[0]
    touches_unbounded_edge = chosen[1] == 0 or chosen[2] >= len(ink) - 2
    if not stable or touches_unbounded_edge:
        digit_strips = [
            (
                max(0, int(columns.left - pitch * 0.9)),
                max(1, int(columns.left - pitch * 0.1)),
            ),
            (
                min(image.width - 1, int(columns.right + pitch * 0.1)),
                min(image.width, int(columns.right + pitch * 0.9)),
            ),
        ]
        digit_masks: list[list[bool]] = [[], []]
        for first, second in zip(positions[:-1], positions[1:], strict=True):
            top = int(first + pitch * 0.12)
            bottom = int(second - pitch * 0.12)
            for side, (start, end) in enumerate(digit_strips):
                digit_masks[side].append(_has_digit_like_component(gray[top:bottom, start:end]))
        both_sides = np.logical_and(digit_masks[0], digit_masks[1])
        digit_run = _longest_true_run(np.asarray(both_sides, dtype=np.bool_))
        low_threshold_count = candidate_counts[0]
        digit_fallback_is_consistent = (
            len(set(candidate_counts[:4])) == 1
            and digit_run[0] == low_threshold_count - 2
            and digit_run[1] > 0
            and digit_run[2] < len(ink) - 1
        )
        if digit_fallback_is_consistent:
            return GridRowGeometry(
                status="detected",
                row_count=digit_run[0],
                top=float(positions[digit_run[1]]),
                bottom=float(positions[digit_run[2] + 1]),
                pitch=pitch,
                candidate_counts=candidate_counts,
                reasons=(),
            )

        global_digit_strips = [
            (
                max(0, int(columns.left - pitch * 0.95)),
                max(1, int(columns.left - pitch * 0.05)),
            ),
            (
                min(image.width - 1, int(columns.right + pitch * 0.05)),
                min(image.width, int(columns.right + pitch * 0.95)),
            ),
        ]
        matched_centers = _matched_digit_centers(gray, global_digit_strips, pitch)
        regular_centers = _longest_regular_sequence(matched_centers, pitch)
        matched_matches_trimmed_run = (
            len(set(candidate_counts[:4])) == 1 and len(matched_centers) == low_threshold_count - 2
        )
        if matched_matches_trimmed_run:
            return GridRowGeometry(
                status="detected",
                row_count=len(matched_centers),
                top=matched_centers[0] - pitch / 2,
                bottom=matched_centers[-1] + pitch / 2,
                pitch=pitch,
                candidate_counts=candidate_counts,
                reasons=(),
            )

        regular_coverage = len(regular_centers) / max(1, len(matched_centers))
        if len(regular_centers) >= 10 and regular_coverage >= 0.85:
            if regular_centers[0] < 3.5 * pitch:
                regular_centers = regular_centers[1:]
            return GridRowGeometry(
                status="detected",
                row_count=len(regular_centers),
                top=regular_centers[0] - pitch / 2,
                bottom=regular_centers[-1] + pitch / 2,
                pitch=pitch,
                candidate_counts=candidate_counts,
                reasons=(),
            )
        return GridRowGeometry(
            status="needs_review",
            row_count=None,
            top=None,
            bottom=None,
            pitch=pitch,
            candidate_counts=candidate_counts,
            reasons=("unstable_or_unbounded_row_label_run",),
        )

    return GridRowGeometry(
        status="detected",
        row_count=chosen[0],
        top=float(positions[chosen[1]]),
        bottom=float(positions[chosen[2] + 1]),
        pitch=pitch,
        candidate_counts=candidate_counts,
        reasons=(),
    )


def split_grid_cells(image: Image.Image, inset_ratio: float = 0.15) -> GridCells:
    """Split detected grid geometry into stable cells and inset sample regions."""

    if not 0.1 <= inset_ratio <= 0.2:
        raise ValueError("cell inset ratio must be between 0.1 and 0.2")
    columns = detect_grid_columns(image)
    rows = detect_grid_rows(image)
    if (
        columns.status != "detected"
        or rows.status != "detected"
        or columns.column_count is None
        or rows.row_count is None
        or columns.left is None
        or columns.right is None
        or rows.top is None
        or rows.bottom is None
    ):
        return GridCells(
            status="needs_review",
            row_count=rows.row_count,
            column_count=columns.column_count,
            cells=(),
            reasons=tuple(dict.fromkeys(columns.reasons + rows.reasons)),
        )

    x_lines = np.linspace(columns.left, columns.right, columns.column_count + 1)
    y_lines = np.linspace(rows.top, rows.bottom, rows.row_count + 1)
    cells: list[CellRegion] = []
    for row in range(rows.row_count):
        for column in range(columns.column_count):
            left = float(x_lines[column])
            right = float(x_lines[column + 1])
            top = float(y_lines[row])
            bottom = float(y_lines[row + 1])
            inset_x = (right - left) * inset_ratio
            inset_y = (bottom - top) * inset_ratio
            cells.append(
                CellRegion(
                    row=row,
                    column=column,
                    left=left,
                    top=top,
                    right=right,
                    bottom=bottom,
                    sample_left=left + inset_x,
                    sample_top=top + inset_y,
                    sample_right=right - inset_x,
                    sample_bottom=bottom - inset_y,
                )
            )

    cell_width = (columns.right - columns.left) / columns.column_count
    cell_height = (rows.bottom - rows.top) / rows.row_count
    aspect_ratio = cell_width / cell_height
    if not 0.8 <= aspect_ratio <= 1.2:
        return GridCells(
            status="needs_review",
            row_count=rows.row_count,
            column_count=columns.column_count,
            cells=(),
            reasons=("non_square_cell_geometry",),
        )
    return GridCells(
        status="detected",
        row_count=rows.row_count,
        column_count=columns.column_count,
        cells=tuple(cells),
        reasons=(),
    )
