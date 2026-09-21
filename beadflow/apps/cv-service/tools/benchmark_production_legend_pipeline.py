"""Evaluate the production auto-crop and OCR path on private real fixtures."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from typing import Any, cast

from PIL import Image

from app.legend_crop import suggest_legend_crop
from app.ocr_adapter import RapidOcrAdapter
from app.pattern_legend_service import PatternLegendRecognizer


ROOT = Path(__file__).parents[1]
REPOSITORY_ROOT = ROOT.parents[1]
GOLDEN_PATH = ROOT / "fixtures" / "pattern_legend_golden.json"
PALETTE_PATH = REPOSITORY_ROOT / "assets" / "palettes" / "mard221.json"


def _load_json(path: Path) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))


def _crop_coverage(start: float, end: float, truth: list[float]) -> float:
    overlap = max(0.0, min(end, truth[1]) - max(start, truth[0]))
    return overlap / (truth[1] - truth[0])


def _score(expected: dict[str, int], predicted: dict[str, int]) -> dict[str, Any]:
    exact = sorted(code for code, quantity in predicted.items() if expected.get(code) == quantity)
    return {
        "expected_pairs": len(expected),
        "predicted_pairs": len(predicted),
        "exact_pairs": len(exact),
        "wrong_quantities": sorted(
            code
            for code, quantity in predicted.items()
            if code in expected and expected[code] != quantity
        ),
        "missed_codes": sorted(set(expected) - set(exact)),
        "false_positive_codes": sorted(set(predicted) - set(expected)),
        "exact_material_list": predicted == expected,
    }


def _aggregate(results: list[dict[str, Any]]) -> dict[str, Any]:
    expected_pairs = sum(int(result["expected_pairs"]) for result in results)
    predicted_pairs = sum(int(result["predicted_pairs"]) for result in results)
    exact_pairs = sum(int(result["exact_pairs"]) for result in results)
    return {
        "images": len(results),
        "fully_exact_images": sum(bool(result.get("exact_material_list")) for result in results),
        "expected_pairs": expected_pairs,
        "predicted_pairs": predicted_pairs,
        "exact_pairs": exact_pairs,
        "micro_pair_precision": exact_pairs / predicted_pairs if predicted_pairs else 0.0,
        "micro_pair_recall": exact_pairs / expected_pairs if expected_pairs else 0.0,
    }


def _summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    scoreable = [
        result
        for result in results
        if result.get("verification_status") != "needs_user_confirmation" and "error" not in result
    ]
    auto_eligible = [
        result
        for result in scoreable
        if not bool(result.get("crop", {}).get("needs_manual_review"))
    ]
    manual_review = [
        result for result in results if bool(result.get("crop", {}).get("needs_manual_review"))
    ]
    return {
        "scoreable_images": len(scoreable),
        "failed_images": sum("error" in result for result in results),
        **_aggregate(scoreable),
        "auto_eligible": _aggregate(auto_eligible),
        "manual_review_image_ids": [result["id"] for result in manual_review],
        "median_elapsed_ms": sorted(float(result["elapsed_ms"]) for result in results)[
            len(results) // 2
        ],
        "crops_with_90_percent_truth_coverage": sum(
            float(result.get("crop", {}).get("truth_coverage", 0)) >= 0.9 for result in results
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "reports" / "private" / "production_legend_pipeline.json",
    )
    parser.add_argument("--disable-preprocessing", action="store_true")
    parser.add_argument(
        "--fixture-id",
        action="append",
        help="Run only the named fixture; may be supplied more than once.",
    )
    parser.add_argument(
        "--summarize-existing",
        action="store_true",
        help="Recompute summary fields in --output without rerunning OCR.",
    )
    arguments = parser.parse_args()

    if arguments.summarize_existing:
        report = _load_json(arguments.output)
        results = cast(list[dict[str, Any]], report["images"])
        report["summary"] = _summarize(results)
        arguments.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
        return 0

    golden = _load_json(GOLDEN_PATH)
    palette = _load_json(PALETTE_PATH)
    valid_codes = frozenset(color["code"] for color in palette["colors"])
    fixture_root = ROOT / golden["fixture_root"]
    recognizer = PatternLegendRecognizer(
        RapidOcrAdapter(),
        valid_codes,
        enable_preprocessing=not arguments.disable_preprocessing,
    )
    results: list[dict[str, Any]] = []

    fixtures = golden["fixtures"]
    if arguments.fixture_id:
        selected_ids = set(arguments.fixture_id)
        fixtures = [fixture for fixture in fixtures if fixture["id"] in selected_ids]
        missing_ids = selected_ids - {fixture["id"] for fixture in fixtures}
        if missing_ids:
            parser.error(f"unknown fixture id(s): {', '.join(sorted(missing_ids))}")

    for fixture in fixtures:
        source_path = fixture_root / fixture["file"]
        started = time.perf_counter()
        try:
            with Image.open(source_path) as image:
                suggestion = suggest_legend_crop(image)
                recognition = recognizer.recognize(
                    image,
                    suggestion.y_start,
                    suggestion.y_end,
                    fixture["declared_total"],
                )
            score = _score(fixture["materials"], recognition.materials)
            if fixture["verification_status"] == "needs_user_confirmation":
                score["exact_material_list"] = None
            result = {
                "id": fixture["id"],
                "verification_status": fixture["verification_status"],
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                "crop": {
                    "start": suggestion.y_start,
                    "end": suggestion.y_end,
                    "confidence": suggestion.confidence,
                    "method": suggestion.method,
                    "needs_manual_review": suggestion.needs_manual_review,
                    "truth_coverage": _crop_coverage(
                        suggestion.y_start, suggestion.y_end, fixture["legend_crop_y"]
                    ),
                },
                "predicted": recognition.materials,
                "conflicts": sorted(recognition.conflicts),
                "preprocessing_variants": recognition.preprocessing_variants,
                "low_confidence_codes": recognition.low_confidence_codes,
                **score,
            }
        except Exception as error:  # report every real-image failure instead of hiding it
            result = {
                "id": fixture["id"],
                "verification_status": fixture["verification_status"],
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                "error": f"{type(error).__name__}: {error}",
            }
        results.append(result)
        print(
            json.dumps(
                {
                    "id": result["id"],
                    "exact": result.get("exact_pairs"),
                    "predicted": result.get("predicted_pairs"),
                    "error": result.get("error"),
                    "elapsed_ms": result["elapsed_ms"],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )

    summary = _summarize(results)
    report = {"schema_version": 1, "summary": summary, "images": results}
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"private report: {arguments.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
