import json
from pathlib import Path

from PIL import Image
import pytest

from app.grid_geometry import (
    detect_grid_columns,
    detect_grid_periodicity,
    detect_grid_rows,
    split_grid_cells,
)
from app.cell_analysis import (
    analyze_grid_phase_one,
    classify_grid_occupancy,
    cluster_grid_backgrounds,
    extract_grid_visual_features,
    refine_grid_occupancy_with_clusters,
)


ROOT = Path(__file__).parents[1]
GOLDEN_PATH = ROOT / "fixtures" / "pattern_legend_golden.json"
PRIVATE_FIXTURE_ROOT = ROOT / "fixtures" / "private" / "pattern-legend"


def test_real_private_patterns_have_consistent_detected_cell_periods() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    results: list[tuple[str, float, float]] = []
    for fixture in manifest["fixtures"]:
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            periodicity = detect_grid_periodicity(image)
            expected_x_pitch = image.width / (fixture["pattern_size"][0] + 2)

        assert periodicity.status == "detected", (fixture["id"], periodicity)
        assert periodicity.x is not None
        assert periodicity.y is not None
        assert periodicity.square_mismatch_ratio is not None
        results.append(
            (
                fixture["id"],
                abs(periodicity.x.pixels - expected_x_pitch) / expected_x_pitch,
                periodicity.square_mismatch_ratio,
            )
        )

    assert len(results) >= 14
    assert max(pitch_error for _, pitch_error, _ in results) <= 0.05, results
    assert max(mismatch for _, _, mismatch in results) <= 0.04, results


def test_blank_image_is_sent_to_review_instead_of_inventing_a_grid() -> None:
    result = detect_grid_periodicity(Image.new("RGB", (1280, 1600), "white"))

    assert result.status == "needs_review"
    assert result.reasons == ("insufficient_periodic_line_evidence",)


def test_real_private_patterns_get_exact_column_counts_without_reading_titles() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    results: list[tuple[str, int | None, int]] = []
    for fixture in manifest["fixtures"]:
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            geometry = detect_grid_columns(image)
        results.append((fixture["id"], geometry.column_count, fixture["pattern_size"][0]))
        assert geometry.status == "detected", (fixture["id"], geometry)

    assert len(results) >= 14
    assert all(detected == expected for _, detected, expected in results), results


def test_real_private_patterns_get_exact_row_counts_without_reading_titles() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    detected: list[tuple[str, int, int]] = []
    for fixture in manifest["fixtures"]:
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            rows = detect_grid_rows(image)
        assert rows.status == "detected", (fixture["id"], rows)
        assert rows.row_count is not None
        detected.append((fixture["id"], rows.row_count, fixture["pattern_size"][1]))

    assert all(actual == expected for _, actual, expected in detected), detected
    assert len(detected) == len(manifest["fixtures"])


def test_real_private_patterns_split_into_all_expected_inset_cells() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    for fixture in manifest["fixtures"]:
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            result = split_grid_cells(image)
        expected_columns, expected_rows = fixture["pattern_size"]
        assert result.status == "detected", (fixture["id"], result.reasons)
        assert result.column_count == expected_columns
        assert result.row_count == expected_rows
        assert len(result.cells) == expected_columns * expected_rows
        assert result.cells[0].row == 0 and result.cells[0].column == 0
        assert result.cells[-1].row == expected_rows - 1
        assert result.cells[-1].column == expected_columns - 1
        for cell in result.cells:
            assert 0 <= cell.left < cell.sample_left < cell.sample_right < cell.right <= image.width
            assert (
                0 <= cell.top < cell.sample_top < cell.sample_bottom < cell.bottom <= image.height
            )


def test_split_rejects_unsafe_insets_instead_of_silently_clamping() -> None:
    with pytest.raises(ValueError, match="inset ratio"):
        split_grid_cells(Image.new("RGB", (1280, 1600), "white"), inset_ratio=0.05)


def test_real_private_patterns_extract_finite_cell_evidence_without_using_totals() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    for fixture in manifest["fixtures"]:
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            result = extract_grid_visual_features(image)
        expected_columns, expected_rows = fixture["pattern_size"]
        assert result.status == "detected", (fixture["id"], result.reasons)
        assert len(result.cells) == expected_columns * expected_rows
        assert result.empty_reference_lab is not None
        lightness, a_channel, b_channel = result.empty_reference_lab
        assert lightness >= 225, (fixture["id"], result.empty_reference_lab)
        assert abs(a_channel - 128) <= 8, (fixture["id"], result.empty_reference_lab)
        assert abs(b_channel - 128) <= 8, (fixture["id"], result.empty_reference_lab)
        for cell in result.cells:
            assert cell.background_distance >= 0
            assert cell.background_spread >= 0
            assert 0 <= cell.foreground_fraction <= 1


def test_cell_evidence_rejects_images_without_reliable_grid_geometry() -> None:
    result = extract_grid_visual_features(Image.new("RGB", (1280, 1600), "white"))

    assert result.status == "needs_review"
    assert result.cells == ()
    assert result.empty_reference_lab is None


def test_conservative_occupancy_keeps_real_truth_inside_review_bounds() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    for fixture in manifest["fixtures"]:
        expected_total = fixture["declared_total"] or sum(fixture["materials"].values())
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            result = classify_grid_occupancy(image)
        assert result.occupied_count > 0, fixture["id"]
        assert result.empty_count > 0, fixture["id"]
        assert result.occupied_count <= expected_total, (
            fixture["id"],
            result.occupied_count,
            expected_total,
        )
        assert expected_total <= result.occupied_count + result.uncertain_count, (
            fixture["id"],
            result.occupied_count,
            result.uncertain_count,
            expected_total,
        )
        assert (
            len(result.cells) == result.occupied_count + result.empty_count + result.uncertain_count
        )


def test_occupancy_does_not_invent_cells_when_geometry_is_missing() -> None:
    result = classify_grid_occupancy(Image.new("RGB", (1280, 1600), "white"))

    assert result.status == "needs_review"
    assert result.cells == ()
    assert result.occupied_count == 0
    assert result.empty_count == 0
    assert result.uncertain_count == 0


def test_real_private_patterns_get_complete_conservative_background_clusters() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    for fixture in manifest["fixtures"]:
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            result = cluster_grid_backgrounds(image)
        expected_columns, expected_rows = fixture["pattern_size"]
        assert result.status == "detected", (fixture["id"], result.reasons)
        assert len(result.clusters) >= 2, fixture["id"]
        assert sum(cluster.cell_count for cluster in result.clusters) == (
            expected_columns * expected_rows
        )
        members = [member for cluster in result.clusters for member in cluster.members]
        assert len(members) == len(set(members))
        assert min(cluster.empty_reference_distance for cluster in result.clusters) <= 5


def test_background_clustering_rejects_unsafe_color_diameter() -> None:
    with pytest.raises(ValueError, match="cluster diameter"):
        cluster_grid_backgrounds(Image.new("RGB", (1280, 1600), "white"), 25.0)


def test_cluster_refinement_reduces_review_without_exceeding_real_totals() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    total_promoted = 0
    exact_total_matches = 0
    for fixture in manifest["fixtures"]:
        expected_total = fixture["declared_total"] or sum(fixture["materials"].values())
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            initial = classify_grid_occupancy(image)
            refined = refine_grid_occupancy_with_clusters(image)
        assert initial.occupied_count <= refined.occupied_count <= expected_total, (
            fixture["id"],
            initial.occupied_count,
            refined.occupied_count,
            expected_total,
        )
        assert expected_total <= refined.occupied_count + refined.uncertain_count
        assert refined.empty_count == initial.empty_count
        total_promoted += refined.occupied_count - initial.occupied_count
        exact_total_matches += refined.occupied_count == expected_total

    assert total_promoted >= 1_000
    assert exact_total_matches >= 3


def test_real_phase_one_analysis_clusters_only_confirmed_occupied_cells() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    for fixture in manifest["fixtures"]:
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            analysis = analyze_grid_phase_one(image)
        occupancy = analysis.occupancy
        clusters = analysis.background_clusters
        clustered_members = [
            member for cluster in clusters.clusters for member in cluster.members
        ]
        occupied_positions = {
            (cell.row, cell.column)
            for cell in occupancy.cells
            if cell.state == "occupied"
        }

        assert clusters.status == "detected", (fixture["id"], clusters.reasons)
        assert sum(cluster.cell_count for cluster in clusters.clusters) == (
            occupancy.occupied_count
        )
        assert len(clustered_members) == len(set(clustered_members))
        assert set(clustered_members) == occupied_positions
