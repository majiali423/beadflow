"""Per-cell visual evidence used by conservative occupancy classification.

This stage intentionally emits measurements rather than deciding how many beads
the pattern contains. Declared totals and legend counts are never inputs here.
"""

from dataclasses import dataclass
from collections import deque
from typing import Literal

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image

from app.grid_geometry import CellRegion, split_grid_cells


RgbImage = NDArray[np.uint8]


@dataclass(frozen=True)
class CellVisualFeatures:
    row: int
    column: int
    background_lab: tuple[float, float, float]
    background_distance: float
    background_spread: float
    foreground_fraction: float


@dataclass(frozen=True)
class GridVisualFeatures:
    status: Literal["detected", "needs_review"]
    row_count: int | None
    column_count: int | None
    empty_reference_lab: tuple[float, float, float] | None
    cells: tuple[CellVisualFeatures, ...]
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class CellOccupancy:
    row: int
    column: int
    state: Literal["occupied", "empty", "uncertain"]
    reason: str


@dataclass(frozen=True)
class GridOccupancy:
    status: Literal["detected", "needs_review"]
    row_count: int | None
    column_count: int | None
    occupied_count: int
    empty_count: int
    uncertain_count: int
    cells: tuple[CellOccupancy, ...]
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class BackgroundColorCluster:
    cluster_id: int
    cell_count: int
    median_lab: tuple[float, float, float]
    empty_reference_distance: float
    members: tuple[tuple[int, int], ...]


@dataclass(frozen=True)
class GridBackgroundClusters:
    status: Literal["detected", "needs_review"]
    row_count: int | None
    column_count: int | None
    clusters: tuple[BackgroundColorCluster, ...]
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class GridPhaseOneAnalysis:
    """One consistent Phase 1 result produced from one set of cell measurements.

    ``background_clusters`` contains confirmed occupied cells only. Empty and
    uncertain cells deliberately have no material cluster because neither may be
    counted as a bead before review.
    """

    occupancy: GridOccupancy
    background_clusters: GridBackgroundClusters


@dataclass
class _WorkingCluster:
    minimum: NDArray[np.float64]
    maximum: NDArray[np.float64]
    total: NDArray[np.float64]
    count: int
    labs: list[NDArray[np.float64]]
    members: list[tuple[int, int]]


def _integer_crop_bounds(cell: CellRegion, width: int, height: int) -> tuple[int, int, int, int]:
    left = max(0, min(width - 1, int(round(cell.sample_left))))
    top = max(0, min(height - 1, int(round(cell.sample_top))))
    right = max(left + 1, min(width, int(round(cell.sample_right))))
    bottom = max(top + 1, min(height, int(round(cell.sample_bottom))))
    return left, top, right, bottom


def _corner_pixels(crop: RgbImage) -> RgbImage:
    height, width = crop.shape[:2]
    corner_height = max(1, int(round(height * 0.28)))
    corner_width = max(1, int(round(width * 0.28)))
    corners = (
        crop[:corner_height, :corner_width],
        crop[:corner_height, width - corner_width :],
        crop[height - corner_height :, :corner_width],
        crop[height - corner_height :, width - corner_width :],
    )
    return np.concatenate([corner.reshape(-1, 3) for corner in corners], axis=0)


def _raw_cell_measurements(
    rgb: RgbImage, cells: tuple[CellRegion, ...]
) -> tuple[NDArray[np.float64], NDArray[np.float64], NDArray[np.float64]]:
    lab_backgrounds: list[NDArray[np.float64]] = []
    spreads: list[float] = []
    foreground_fractions: list[float] = []
    height, width = rgb.shape[:2]

    for cell in cells:
        left, top, right, bottom = _integer_crop_bounds(cell, width, height)
        crop = rgb[top:bottom, left:right]
        corner_rgb = _corner_pixels(crop)
        corner_lab = cv2.cvtColor(corner_rgb.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3)
        background_lab = np.median(corner_lab, axis=0).astype(np.float64)
        lab_backgrounds.append(background_lab)
        spreads.append(float(np.median(np.linalg.norm(corner_lab - background_lab, axis=1))))

        gray_crop = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY).astype(np.float64)
        gray_corners = cv2.cvtColor(corner_rgb.reshape(-1, 1, 3), cv2.COLOR_RGB2GRAY).reshape(-1)
        background_gray = float(np.median(gray_corners))
        # A generous threshold suppresses compression noise while preserving the
        # printed code strokes found in both light and dark bead cells.
        foreground_fractions.append(float(np.mean(np.abs(gray_crop - background_gray) >= 25.0)))

    return (
        np.stack(lab_backgrounds, axis=0),
        np.asarray(spreads, dtype=np.float64),
        np.asarray(foreground_fractions, dtype=np.float64),
    )


def _infer_empty_reference(
    backgrounds: NDArray[np.float64], rows: int, columns: int
) -> NDArray[np.float64]:
    perimeter_indexes = [
        row * columns + column
        for row in range(rows)
        for column in range(columns)
        if row < 2 or row >= rows - 2 or column < 2 or column >= columns - 2
    ]
    perimeter = backgrounds[perimeter_indexes]
    chroma = np.linalg.norm(perimeter[:, 1:] - 128.0, axis=1)
    # Empty export backgrounds are normally the brightest, most neutral cells.
    # Select several candidates so one watermark or coordinate label cannot set
    # the reference for the whole sheet.
    neutral_brightness_score = perimeter[:, 0] - 1.5 * chroma
    reference_count = min(len(perimeter), max(8, len(perimeter) // 4))
    selected = perimeter[np.argsort(neutral_brightness_score)[-reference_count:]]
    return np.median(selected, axis=0).astype(np.float64)


def extract_grid_visual_features(image: Image.Image) -> GridVisualFeatures:
    """Measure cell backgrounds and foreground interference without classifying them."""

    grid = split_grid_cells(image)
    if (
        grid.status != "detected"
        or grid.row_count is None
        or grid.column_count is None
        or not grid.cells
    ):
        return GridVisualFeatures(
            status="needs_review",
            row_count=grid.row_count,
            column_count=grid.column_count,
            empty_reference_lab=None,
            cells=(),
            reasons=grid.reasons,
        )

    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    backgrounds, spreads, foreground_fractions = _raw_cell_measurements(rgb, grid.cells)
    empty_reference = _infer_empty_reference(backgrounds, grid.row_count, grid.column_count)
    distances = np.linalg.norm(backgrounds - empty_reference, axis=1)
    features = tuple(
        CellVisualFeatures(
            row=cell.row,
            column=cell.column,
            background_lab=(
                float(backgrounds[index, 0]),
                float(backgrounds[index, 1]),
                float(backgrounds[index, 2]),
            ),
            background_distance=float(distances[index]),
            background_spread=float(spreads[index]),
            foreground_fraction=float(foreground_fractions[index]),
        )
        for index, cell in enumerate(grid.cells)
    )
    return GridVisualFeatures(
        status="detected",
        row_count=grid.row_count,
        column_count=grid.column_count,
        empty_reference_lab=(
            float(empty_reference[0]),
            float(empty_reference[1]),
            float(empty_reference[2]),
        ),
        cells=features,
        reasons=(),
    )


def _classify_visual_occupancy(visual: GridVisualFeatures) -> GridOccupancy:
    if visual.status != "detected":
        return GridOccupancy(
            status="needs_review",
            row_count=visual.row_count,
            column_count=visual.column_count,
            occupied_count=0,
            empty_count=0,
            uncertain_count=0,
            cells=(),
            reasons=visual.reasons,
        )

    classified: list[CellOccupancy] = []
    for cell in visual.cells:
        if cell.background_distance >= 32.0 and cell.background_spread <= 10.0:
            state: Literal["occupied", "empty", "uncertain"] = "occupied"
            reason = "background_clearly_differs_from_empty_reference"
        elif (
            cell.background_distance <= 5.0
            and cell.foreground_fraction <= 0.025
            and cell.background_spread <= 5.0
        ):
            state = "empty"
            reason = "background_matches_empty_reference_without_foreground"
        else:
            state = "uncertain"
            reason = "requires_cluster_or_manual_evidence"
        classified.append(
            CellOccupancy(row=cell.row, column=cell.column, state=state, reason=reason)
        )

    occupied_count = sum(cell.state == "occupied" for cell in classified)
    empty_count = sum(cell.state == "empty" for cell in classified)
    uncertain_count = len(classified) - occupied_count - empty_count
    reasons = ("uncertain_cells_require_cluster_analysis",) if uncertain_count else ()
    return GridOccupancy(
        status="needs_review" if reasons else "detected",
        row_count=visual.row_count,
        column_count=visual.column_count,
        occupied_count=occupied_count,
        empty_count=empty_count,
        uncertain_count=uncertain_count,
        cells=tuple(classified),
        reasons=reasons,
    )


def classify_grid_occupancy(image: Image.Image) -> GridOccupancy:
    """Return safe occupied/empty decisions and preserve ambiguous cells for review.

    This is deliberately a high-precision first pass. Light bead colors, watermark
    crossings, and compressed cells remain uncertain until cluster-level evidence
    is available; they are never silently counted as empty.
    """

    return _classify_visual_occupancy(extract_grid_visual_features(image))


def _cluster_visual_backgrounds(
    visual: GridVisualFeatures, max_cluster_diameter: float
) -> GridBackgroundClusters:
    if not 2.0 <= max_cluster_diameter <= 20.0:
        raise ValueError("cluster diameter must be between 2 and 20 Lab units")
    if visual.status != "detected" or visual.empty_reference_lab is None:
        return GridBackgroundClusters(
            status="needs_review",
            row_count=visual.row_count,
            column_count=visual.column_count,
            clusters=(),
            reasons=visual.reasons,
        )

    ordered = sorted(
        visual.cells,
        key=lambda cell: (*cell.background_lab, cell.row, cell.column),
    )
    working: list[_WorkingCluster] = []
    for cell in ordered:
        lab = np.asarray(cell.background_lab, dtype=np.float64)
        best_index: int | None = None
        best_distance = float("inf")
        for index, cluster in enumerate(working):
            expanded_minimum = np.minimum(cluster.minimum, lab)
            expanded_maximum = np.maximum(cluster.maximum, lab)
            if float(np.linalg.norm(expanded_maximum - expanded_minimum)) > max_cluster_diameter:
                continue
            centroid = cluster.total / cluster.count
            distance = float(np.linalg.norm(lab - centroid))
            if distance < best_distance:
                best_index = index
                best_distance = distance
        if best_index is None:
            working.append(
                _WorkingCluster(
                    minimum=lab.copy(),
                    maximum=lab.copy(),
                    total=lab.copy(),
                    count=1,
                    labs=[lab],
                    members=[(cell.row, cell.column)],
                )
            )
            continue
        cluster = working[best_index]
        cluster.minimum = np.minimum(cluster.minimum, lab)
        cluster.maximum = np.maximum(cluster.maximum, lab)
        cluster.total = cluster.total + lab
        cluster.count += 1
        cluster.labs.append(lab)
        cluster.members.append((cell.row, cell.column))

    empty_reference = np.asarray(visual.empty_reference_lab, dtype=np.float64)
    result_clusters: list[BackgroundColorCluster] = []
    for cluster_id, cluster in enumerate(working):
        median = np.median(np.stack(cluster.labs, axis=0), axis=0)
        result_clusters.append(
            BackgroundColorCluster(
                cluster_id=cluster_id,
                cell_count=len(cluster.members),
                median_lab=(float(median[0]), float(median[1]), float(median[2])),
                empty_reference_distance=float(np.linalg.norm(median - empty_reference)),
                members=tuple(cluster.members),
            )
        )
    return GridBackgroundClusters(
        status="detected",
        row_count=visual.row_count,
        column_count=visual.column_count,
        clusters=tuple(result_clusters),
        reasons=(),
    )


def cluster_grid_backgrounds(
    image: Image.Image, max_cluster_diameter: float = 8.0
) -> GridBackgroundClusters:
    """Conservatively split every cell background for internal evidence analysis.

    This low-level function intentionally includes empty and uncertain cells. Use
    :func:`analyze_grid_phase_one` for user-facing bead quantities.
    """

    return _cluster_visual_backgrounds(
        extract_grid_visual_features(image), max_cluster_diameter
    )


def _refine_visual_occupancy(
    visual: GridVisualFeatures,
    initial: GridOccupancy,
    clusters: GridBackgroundClusters,
) -> GridOccupancy:
    if visual.status != "detected" or not initial.cells or clusters.status != "detected":
        return initial

    features = {(cell.row, cell.column): cell for cell in visual.cells}
    states = {(cell.row, cell.column): cell.state for cell in initial.cells}
    candidate_cells: set[tuple[int, int]] = set()
    for cluster in clusters.clusters:
        cluster_features = [features[position] for position in cluster.members]
        foreground = np.asarray(
            [cell.foreground_fraction for cell in cluster_features], dtype=np.float64
        )
        spread = np.asarray([cell.background_spread for cell in cluster_features], dtype=np.float64)
        confirmed_fraction = sum(
            states[position] == "occupied" for position in cluster.members
        ) / len(cluster.members)
        matches_confirmed_background = len(cluster.members) >= 3 and confirmed_fraction >= 0.3
        has_repeated_code_strokes = (
            len(cluster.members) >= 3
            and 0.12 <= float(np.median(foreground)) <= 0.35
            and float(np.quantile(foreground, 0.25)) >= 0.06
            and float(np.median(spread)) <= 12.0
        )
        if matches_confirmed_background or has_repeated_code_strokes:
            candidate_cells.update(
                position
                for position in cluster.members
                if states[position] == "uncertain" and features[position].background_spread <= 15.0
            )

    distances = {position: 0 for position, state in states.items() if state == "occupied"}
    queue: deque[tuple[int, int]] = deque(distances)
    while queue:
        row, column = queue.popleft()
        distance = distances[(row, column)]
        if distance >= 2:
            continue
        for row_offset in (-1, 0, 1):
            for column_offset in (-1, 0, 1):
                neighbor = (row + row_offset, column + column_offset)
                if neighbor in candidate_cells and neighbor not in distances:
                    distances[neighbor] = distance + 1
                    queue.append(neighbor)

    promoted = set(distances) - {
        position for position, state in states.items() if state == "occupied"
    }
    refined_cells = tuple(
        CellOccupancy(
            row=cell.row,
            column=cell.column,
            state="occupied" if (cell.row, cell.column) in promoted else cell.state,
            reason=(
                "cluster_evidence_near_confirmed_pattern"
                if (cell.row, cell.column) in promoted
                else cell.reason
            ),
        )
        for cell in initial.cells
    )
    occupied_count = sum(cell.state == "occupied" for cell in refined_cells)
    empty_count = sum(cell.state == "empty" for cell in refined_cells)
    uncertain_count = len(refined_cells) - occupied_count - empty_count
    reasons = ("uncertain_cells_require_manual_or_ocr_evidence",) if uncertain_count else ()
    return GridOccupancy(
        status="needs_review" if reasons else "detected",
        row_count=initial.row_count,
        column_count=initial.column_count,
        occupied_count=occupied_count,
        empty_count=empty_count,
        uncertain_count=uncertain_count,
        cells=refined_cells,
        reasons=reasons,
    )


def _confirmed_occupied_clusters(
    visual: GridVisualFeatures,
    occupancy: GridOccupancy,
    all_background_clusters: GridBackgroundClusters,
) -> GridBackgroundClusters:
    if (
        visual.status != "detected"
        or visual.empty_reference_lab is None
        or all_background_clusters.status != "detected"
    ):
        return GridBackgroundClusters(
            status="needs_review",
            row_count=visual.row_count,
            column_count=visual.column_count,
            clusters=(),
            reasons=tuple(dict.fromkeys(visual.reasons + all_background_clusters.reasons)),
        )

    occupied = {
        (cell.row, cell.column) for cell in occupancy.cells if cell.state == "occupied"
    }
    feature_by_position = {
        (cell.row, cell.column): cell for cell in visual.cells
    }
    empty_reference = np.asarray(visual.empty_reference_lab, dtype=np.float64)
    confirmed: list[BackgroundColorCluster] = []
    for raw_cluster in all_background_clusters.clusters:
        members = tuple(position for position in raw_cluster.members if position in occupied)
        if not members:
            continue
        labs = np.asarray(
            [feature_by_position[position].background_lab for position in members],
            dtype=np.float64,
        )
        median = np.median(labs, axis=0)
        confirmed.append(
            BackgroundColorCluster(
                cluster_id=len(confirmed),
                cell_count=len(members),
                median_lab=(float(median[0]), float(median[1]), float(median[2])),
                empty_reference_distance=float(np.linalg.norm(median - empty_reference)),
                members=members,
            )
        )

    clustered_count = sum(cluster.cell_count for cluster in confirmed)
    if clustered_count != occupancy.occupied_count:
        return GridBackgroundClusters(
            status="needs_review",
            row_count=visual.row_count,
            column_count=visual.column_count,
            clusters=(),
            reasons=("confirmed_occupied_cluster_invariant_failed",),
        )
    return GridBackgroundClusters(
        status="detected",
        row_count=visual.row_count,
        column_count=visual.column_count,
        clusters=tuple(confirmed),
        reasons=(),
    )


def analyze_grid_phase_one(
    image: Image.Image, max_cluster_diameter: float = 8.0
) -> GridPhaseOneAnalysis:
    """Analyze geometry, occupancy and confirmed bead-color quantities together."""

    visual = extract_grid_visual_features(image)
    initial = _classify_visual_occupancy(visual)
    all_background_clusters = _cluster_visual_backgrounds(visual, max_cluster_diameter)
    occupancy = _refine_visual_occupancy(visual, initial, all_background_clusters)
    confirmed_clusters = _confirmed_occupied_clusters(
        visual, occupancy, all_background_clusters
    )
    return GridPhaseOneAnalysis(
        occupancy=occupancy,
        background_clusters=confirmed_clusters,
    )


def refine_grid_occupancy_with_clusters(image: Image.Image) -> GridOccupancy:
    """Reduce uncertainty using repeated cluster evidence near confirmed pattern cells.

    Propagation is capped at two neighboring cells. This makes adjacency weak
    evidence and prevents a distant or crossing watermark from flooding the grid.
    """

    return analyze_grid_phase_one(image).occupancy
