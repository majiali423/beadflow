from io import BytesIO
import json
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
import pytest

from app.legend_crop import suggest_legend_crop
from app.main import app


ROOT = Path(__file__).parents[1]
GOLDEN_PATH = ROOT / "fixtures" / "pattern_legend_golden.json"
PRIVATE_FIXTURE_ROOT = ROOT / "fixtures" / "private" / "pattern-legend"


def _coverage(suggested_start: float, suggested_end: float, truth: list[float]) -> float:
    overlap = max(0.0, min(suggested_end, truth[1]) - max(suggested_start, truth[0]))
    return overlap / (truth[1] - truth[0])


def test_real_private_fixtures_keep_recorded_legend_inside_suggested_crop() -> None:
    manifest = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    missing = [
        fixture["file"]
        for fixture in manifest["fixtures"]
        if not (PRIVATE_FIXTURE_ROOT / fixture["file"]).exists()
    ]
    if missing:
        pytest.skip("private user fixtures are intentionally not committed")

    results: list[tuple[str, float]] = []
    for fixture in manifest["fixtures"]:
        with Image.open(PRIVATE_FIXTURE_ROOT / fixture["file"]) as image:
            suggestion = suggest_legend_crop(image)
        results.append(
            (
                fixture["id"],
                _coverage(suggestion.y_start, suggestion.y_end, fixture["legend_crop_y"]),
            )
        )

    assert len(results) >= 13
    assert min(coverage for _, coverage in results) >= 0.85, results
    assert sum(coverage >= 0.90 for _, coverage in results) >= len(results) - 1, results


def test_detector_uses_reviewable_broad_fallback_without_repeated_swatch_rows() -> None:
    suggestion = suggest_legend_crop(Image.new("RGB", (1280, 1600), "white"))

    assert suggestion.method == "broad_lower_band"
    assert suggestion.needs_manual_review is True
    assert suggestion.y_start == 0.70
    assert suggestion.y_end == 1.0
    assert suggestion.evidence_box_count == 0


def test_crop_endpoint_returns_visible_suggestion_without_running_material_ocr() -> None:
    image = Image.new("RGB", (800, 1000), "white")
    draw = ImageDraw.Draw(image)
    for row in range(2):
        for column in range(5):
            left = 30 + column * 150
            top = 790 + row * 35
            draw.rectangle((left, top, left + 120, top + 24), fill=(80, 120, 60))
    buffer = BytesIO()
    image.save(buffer, format="PNG")

    response = TestClient(app).post(
        "/pattern-legend/detect-crop",
        files={"image": ("pattern.png", buffer.getvalue(), "image/png")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["method"] == "color_bar_rows"
    assert payload["crop_y_start"] < 0.79
    assert payload["crop_y_end"] > 0.83
    assert payload["evidence_box_count"] >= 5
