"""Benchmark local OCR engines on private, real pattern-sheet legends.

This is an evaluation tool, not a production recognizer. The source images stay
under the ignored private fixture directory. Reports are also private because
they may contain OCR fragments from watermarks.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, cast

from PIL import Image

from app.legend_parser import LegendCandidate, collapse_unique_candidates, parse_legend_lines
from app.pattern_legend import OcrToken, infer_column_layout, materials_from_tokens


ROOT = Path(__file__).parents[1]
REPOSITORY_ROOT = ROOT.parents[1]
GOLDEN_PATH = ROOT / "fixtures" / "pattern_legend_golden.json"
PALETTE_PATH = REPOSITORY_ROOT / "assets" / "palettes" / "mard221.json"
WINDOWS_OCR_SCRIPT = ROOT / "tools" / "windows_ocr.ps1"


def _load_json(path: Path) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))


def _rapidocr_column_materials(
    image_path: Path,
    initial_tokens: list[OcrToken],
    engine: Any,
    valid_codes: frozenset[str],
    declared_total: int | None,
) -> tuple[dict[str, int], frozenset[str], list[OcrToken]]:
    """Re-read inferred columns as isolated cards in one OCR montage."""

    with Image.open(image_path) as source:
        layout = infer_column_layout(initial_tokens, source.width, source.height)
        if layout is None:
            return {}, frozenset(), []

        scale = 4
        gap = 24
        columns_per_row = 6
        crop_width = max(1, round(layout.pitch * 0.96))
        crop_height = max(1, round(layout.bottom - layout.top))
        tile_width = crop_width * scale
        tile_height = crop_height * scale
        rows = math.ceil(len(layout.centers) / columns_per_row)
        montage = Image.new(
            "RGB",
            (
                columns_per_row * tile_width + (columns_per_row + 1) * gap,
                rows * tile_height + (rows + 1) * gap,
            ),
            "white",
        )
        tile_origins: list[tuple[int, int]] = []
        for index, center in enumerate(layout.centers):
            left = round(center - crop_width / 2)
            right = left + crop_width
            card = source.crop((left, round(layout.top), right, round(layout.bottom)))
            card = card.resize((tile_width, tile_height), Image.Resampling.LANCZOS)
            tile_column = index % columns_per_row
            tile_row = index // columns_per_row
            origin = (
                gap + tile_column * (tile_width + gap),
                gap + tile_row * (tile_height + gap),
            )
            montage.paste(card.convert("RGB"), origin)
            tile_origins.append(origin)

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temporary:
            montage_path = Path(temporary.name)
        montage.save(montage_path)

    try:
        montage_tokens = _rapidocr_tokens(montage_path, engine)
    finally:
        montage_path.unlink(missing_ok=True)

    all_candidates: list[LegendCandidate] = []
    for origin_x, origin_y in tile_origins:
        tile_tokens = [
            OcrToken(
                text=token.text,
                x=token.x - origin_x,
                y=token.y - origin_y,
                width=token.width,
                height=token.height,
                confidence=token.confidence,
            )
            for token in montage_tokens
            if origin_x <= token.center_x < origin_x + tile_width
            and origin_y <= token.center_y < origin_y + tile_height
        ]
        materials, _ = materials_from_tokens(tile_tokens, valid_codes, declared_total)
        for code, quantity in materials.items():
            all_candidates.extend(parse_legend_lines([f"{code} {quantity}"], valid_codes))
    materials, conflicts = collapse_unique_candidates(all_candidates)
    return materials, conflicts, montage_tokens


def _rapidocr_tokens(image_path: Path, engine: Any) -> list[OcrToken]:
    result, _ = engine(image_path)
    tokens: list[OcrToken] = []
    for box, text, confidence in result or []:
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        tokens.append(
            OcrToken(
                text=str(text),
                x=min(xs),
                y=min(ys),
                width=max(xs) - min(xs),
                height=max(ys) - min(ys),
                confidence=float(confidence),
            )
        )
    return tokens


def _windows_tokens(image_path: Path, _: Any) -> list[OcrToken]:
    completed = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(WINDOWS_OCR_SCRIPT),
            "-ImagePath",
            str(image_path),
        ],
        check=True,
        capture_output=True,
        encoding="utf-8-sig",
        timeout=30,
    )
    payload = json.loads(completed.stdout)
    return [
        OcrToken(
            text=str(word["text"]),
            x=float(word["x"]),
            y=float(word["y"]),
            width=float(word["width"]),
            height=float(word["height"]),
            confidence=None,
        )
        for word in payload["words"]
    ]


def _score(expected: dict[str, int], predicted: dict[str, int]) -> dict[str, Any]:
    exact_codes = sorted(
        code for code, quantity in predicted.items() if expected.get(code) == quantity
    )
    wrong_quantities = sorted(
        code
        for code, quantity in predicted.items()
        if code in expected and expected[code] != quantity
    )
    missed_codes = sorted(set(expected) - set(exact_codes))
    false_positive_codes = sorted(set(predicted) - set(expected))
    return {
        "expected_pairs": len(expected),
        "predicted_pairs": len(predicted),
        "exact_pairs": len(exact_codes),
        "pair_precision": len(exact_codes) / len(predicted) if predicted else 0.0,
        "pair_recall": len(exact_codes) / len(expected) if expected else 0.0,
        "exact_material_list": predicted == expected,
        "wrong_quantities": wrong_quantities,
        "missed_codes": missed_codes,
        "false_positive_codes": false_positive_codes,
    }


def _benchmark_engine(
    name: str,
    recognizer: Callable[[Path, Any], list[OcrToken]],
    engine: Any,
    fixtures: list[dict[str, Any]],
    fixture_root: Path,
    valid_codes: frozenset[str],
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for fixture in fixtures:
        source_path = fixture_root / fixture["file"]
        with Image.open(source_path) as image:
            start_ratio, end_ratio = fixture["legend_crop_y"]
            crop = image.crop(
                (0, int(image.height * start_ratio), image.width, int(image.height * end_ratio))
            )
            crop = crop.resize((crop.width * 2, crop.height * 2), Image.Resampling.LANCZOS)
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temporary:
                crop_path = Path(temporary.name)
            crop.save(crop_path)

        started = time.perf_counter()
        try:
            tokens = recognizer(crop_path, engine)
            materials, conflicts = materials_from_tokens(
                tokens, valid_codes, fixture["declared_total"]
            )
            column_tokens: list[OcrToken] = []
            if name == "rapidocr":
                column_materials, column_conflicts, column_tokens = _rapidocr_column_materials(
                    crop_path,
                    tokens,
                    engine,
                    valid_codes,
                    fixture["declared_total"],
                )
                if column_tokens:
                    # In this layout, code-like numbers on the first row are
                    # frequently damaged color codes, not quantities. Mixing
                    # the generic same-row result back in would create false
                    # inventory entries, so the isolated-column pass replaces
                    # it rather than voting with it.
                    materials, conflicts = column_materials, column_conflicts
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            score = _score(fixture["materials"], materials)
            if fixture["verification_status"] == "needs_user_confirmation":
                score["exact_material_list"] = None
            results.append(
                {
                    "id": fixture["id"],
                    "verification_status": fixture["verification_status"],
                    "elapsed_ms": elapsed_ms,
                    "tokens": [asdict(token) for token in tokens],
                    "column_fallback_tokens": [asdict(token) for token in column_tokens],
                    "predicted": materials,
                    "conflicts": sorted(conflicts),
                    **score,
                }
            )
        except Exception as error:  # benchmark must report per-image failures
            results.append(
                {
                    "id": fixture["id"],
                    "verification_status": fixture["verification_status"],
                    "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                    "error": f"{type(error).__name__}: {error}",
                }
            )
        finally:
            crop_path.unlink(missing_ok=True)

    scoreable = [
        result
        for result in results
        if result.get("verification_status") != "needs_user_confirmation" and "error" not in result
    ]
    expected_pairs = sum(int(result["expected_pairs"]) for result in scoreable)
    predicted_pairs = sum(int(result["predicted_pairs"]) for result in scoreable)
    exact_pairs = sum(int(result["exact_pairs"]) for result in scoreable)
    return {
        "engine": name,
        "crop_mode": "human-recorded legend band; 2x Lanczos upscale",
        "summary": {
            "scoreable_images": len(scoreable),
            "failed_images": sum("error" in result for result in results),
            "fully_exact_images": sum(
                bool(result.get("exact_material_list")) for result in scoreable
            ),
            "expected_pairs": expected_pairs,
            "predicted_pairs": predicted_pairs,
            "exact_pairs": exact_pairs,
            "micro_pair_precision": exact_pairs / predicted_pairs if predicted_pairs else 0.0,
            "micro_pair_recall": exact_pairs / expected_pairs if expected_pairs else 0.0,
            "median_elapsed_ms": sorted(float(result["elapsed_ms"]) for result in results)[
                len(results) // 2
            ],
        },
        "images": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--engines", default="rapidocr,windows", help="Comma-separated: rapidocr,windows"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "reports" / "private" / "pattern_legend_benchmark.json",
    )
    arguments = parser.parse_args()

    golden = _load_json(GOLDEN_PATH)
    palette = _load_json(PALETTE_PATH)
    valid_codes = frozenset(color["code"] for color in palette["colors"])
    fixture_root = ROOT / golden["fixture_root"]
    if not fixture_root.exists():
        raise SystemExit(f"Private fixture directory is missing: {fixture_root}")

    available: dict[str, tuple[Callable[[Path, Any], list[OcrToken]], Any]] = {}
    requested = [name.strip() for name in arguments.engines.split(",") if name.strip()]
    if "rapidocr" in requested:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-untyped]

        available["rapidocr"] = (_rapidocr_tokens, RapidOCR())
    if "windows" in requested:
        if sys.platform != "win32":
            raise SystemExit("The Windows OCR baseline is only available on Windows.")
        available["windows"] = (_windows_tokens, None)

    unknown = set(requested) - set(available)
    if unknown:
        raise SystemExit(f"Unknown or unavailable engines: {sorted(unknown)}")

    report: dict[str, Any] = {
        "schema_version": 1,
        "golden_manifest": str(GOLDEN_PATH.relative_to(ROOT)),
        "engines": [
            _benchmark_engine(
                name,
                recognizer,
                engine,
                golden["fixtures"],
                fixture_root,
                valid_codes,
            )
            for name, (recognizer, engine) in available.items()
        ],
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({item["engine"]: item["summary"] for item in report["engines"]}, indent=2))
    print(f"private report: {arguments.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
