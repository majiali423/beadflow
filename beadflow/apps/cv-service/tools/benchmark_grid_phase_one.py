"""Measure Phase 1 grid analysis on the private real-pattern corpus.

This report deliberately does not pretend that an unnamed color cluster is a
MARD code. It measures exact grid geometry, conservative occupancy bounds and
the structural count multiset that can be checked before legend mapping exists.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, cast

from PIL import Image

from app.cell_analysis import analyze_grid_phase_one


ROOT = Path(__file__).parents[1]
GOLDEN_PATH = ROOT / "fixtures" / "pattern_legend_golden.json"


def _load_json(path: Path) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))


def _expected_total(fixture: dict[str, Any]) -> int:
    declared = fixture.get("declared_total")
    return int(declared) if declared is not None else sum(fixture["materials"].values())


def _rank_deltas(expected: list[int], detected: list[int]) -> list[int] | None:
    if len(expected) != len(detected):
        return None
    return [actual - truth for truth, actual in zip(sorted(expected), sorted(detected), strict=True)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "reports" / "private" / "grid_phase_one_benchmark.json",
    )
    arguments = parser.parse_args()

    manifest = _load_json(GOLDEN_PATH)
    fixture_root = ROOT / manifest["fixture_root"]
    missing = [item["file"] for item in manifest["fixtures"] if not (fixture_root / item["file"]).exists()]
    if missing:
        raise SystemExit(f"Private fixtures are missing: {missing}")

    images: list[dict[str, Any]] = []
    for fixture in manifest["fixtures"]:
        with Image.open(fixture_root / fixture["file"]) as image:
            analysis = analyze_grid_phase_one(image)
        occupancy = analysis.occupancy
        clusters = analysis.background_clusters
        expected_columns, expected_rows = fixture["pattern_size"]
        expected_counts = list(fixture["materials"].values())
        detected_counts = [cluster.cell_count for cluster in clusters.clusters]
        total = _expected_total(fixture)
        scoreable_materials = (
            fixture["verification_status"] != "needs_user_confirmation"
            and sum(expected_counts) == total
        )
        images.append(
            {
                "id": fixture["id"],
                "grid_exact": (
                    occupancy.column_count == expected_columns
                    and occupancy.row_count == expected_rows
                ),
                "expected_grid": [expected_columns, expected_rows],
                "detected_grid": [occupancy.column_count, occupancy.row_count],
                "expected_total": total,
                "occupied_count": occupancy.occupied_count,
                "uncertain_count": occupancy.uncertain_count,
                "empty_count": occupancy.empty_count,
                "occupied_shortfall": total - occupancy.occupied_count,
                "truth_inside_review_bounds": (
                    occupancy.occupied_count <= total
                    <= occupancy.occupied_count + occupancy.uncertain_count
                ),
                "clustered_occupied_count": sum(detected_counts),
                "cluster_invariant_exact": sum(detected_counts) == occupancy.occupied_count,
                "expected_material_count": len(expected_counts) if scoreable_materials else None,
                "detected_cluster_count": len(detected_counts),
                "cluster_count_delta": (
                    len(detected_counts) - len(expected_counts) if scoreable_materials else None
                ),
                "count_multiset_exact": (
                    sorted(detected_counts) == sorted(expected_counts)
                    if scoreable_materials
                    else None
                ),
                "rank_count_deltas": (
                    _rank_deltas(expected_counts, detected_counts)
                    if scoreable_materials
                    else None
                ),
                "material_count_scoring_note": (
                    "rank-only structural comparison; not a MARD-code mapping"
                    if scoreable_materials
                    else "not scoreable until the reference material list is confirmed"
                ),
            }
        )

    report = {
        "schema_version": 1,
        "scope": "Phase 1 only; no legend mapping, OCR, inventory mutation or model",
        "summary": {
            "images": len(images),
            "exact_grids": sum(item["grid_exact"] for item in images),
            "truth_inside_review_bounds": sum(
                item["truth_inside_review_bounds"] for item in images
            ),
            "exact_occupied_totals": sum(item["occupied_shortfall"] == 0 for item in images),
            "cluster_invariants_exact": sum(item["cluster_invariant_exact"] for item in images),
            "exact_count_multisets": sum(item["count_multiset_exact"] is True for item in images),
        },
        "images": images,
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print(f"private report: {arguments.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
