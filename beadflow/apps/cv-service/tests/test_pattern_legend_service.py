from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app, get_pattern_legend_recognizer
from app.pattern_legend import OcrToken
from app.pattern_legend_service import PatternLegendRecognizer


VALID_CODES = frozenset({"F11", "G8", "H16"})


def token(
    text: str,
    x: float,
    y: float,
    width: float = 40,
    height: float = 20,
    confidence: float = 0.95,
) -> OcrToken:
    return OcrToken(text, x, y, width, height, confidence)


class QueueAdapter:
    def __init__(self, responses: list[list[OcrToken]]) -> None:
        self.responses = responses
        self.image_sizes: list[tuple[int, int]] = []

    def recognize(self, image: Image.Image) -> list[OcrToken]:
        self.image_sizes.append(image.size)
        return self.responses.pop(0)


def test_formal_recognizer_returns_review_only_candidates_and_source_coordinates() -> None:
    adapter = QueueAdapter([[token("F11", 20, 20), token("(58)", 70, 20), token("G8 28", 180, 20)]])
    recognizer = PatternLegendRecognizer(adapter, VALID_CODES)

    result = recognizer.recognize(
        Image.new("RGB", (1000, 800), "white"),
        crop_y_start=0.75,
        crop_y_end=1,
        declared_total=86,
    )

    assert result.status == "needs_review"
    assert result.materials == {"F11": 58, "G8": 28}
    assert result.observations["F11"].source == "spatial"
    assert result.observations["F11"].raw_text == "F11 (58)"
    assert result.observations["F11"].evidence_region.y == 610
    assert result.recognized_total == 86
    assert result.declared_total_matches is True
    assert result.column_fallback_used is False
    assert adapter.image_sizes == [(2000, 400)]
    assert result.tokens[0].x == 10
    assert result.tokens[0].y == 610


def test_formal_recognizer_uses_isolated_columns_for_two_line_layout() -> None:
    initial = [token(str(index), 100 + index * 160, 160) for index in range(10)]
    initial.append(token("47312435381542910111", 100, 280, width=1500))
    # In the inferred montage, the first two card origins are x=24 and x=664.
    isolated = [
        token("F11", 34, 40),
        token("58", 90, 40),
        token("G8", 674, 40),
        token("28", 725, 40),
    ]
    adapter = QueueAdapter([initial, isolated])
    recognizer = PatternLegendRecognizer(adapter, VALID_CODES)

    result = recognizer.recognize(Image.new("RGB", (900, 200), "white"), 0, 1, 86)

    assert result.column_fallback_used is True
    assert result.status == "needs_review"
    assert result.materials == {"F11": 58, "G8": 28}
    assert result.declared_total_matches is True
    assert len(adapter.image_sizes) == 2


def test_low_confidence_result_uses_consensus_without_accepting_one_off_candidates() -> None:
    adapter = QueueAdapter(
        [
            [token("F11 (58)", 20, 20, confidence=0.72)],
            [token("F11 (58)", 20, 20, confidence=0.91), token("G8 (28)", 180, 20)],
        ]
    )
    recognizer = PatternLegendRecognizer(adapter, VALID_CODES)

    result = recognizer.recognize(Image.new("RGB", (1000, 800), "white"), 0.75, 1)

    assert result.materials == {"F11": 58}
    assert result.observations["F11"].confidence == 0.91
    assert "G8" not in result.materials
    assert result.preprocessing_variants == ("original", "contrast_gray")
    assert result.low_confidence_codes == ()
    assert len(adapter.image_sizes) == 2


def test_preprocessing_disagreement_becomes_a_conflict_instead_of_a_guess() -> None:
    adapter = QueueAdapter(
        [
            [token("F11 (58)", 20, 20, confidence=0.72)],
            [token("F11 (57)", 20, 20, confidence=0.91)],
            [token("F11 (58)", 20, 20, confidence=0.89)],
        ]
    )
    recognizer = PatternLegendRecognizer(adapter, VALID_CODES)

    result = recognizer.recognize(Image.new("RGB", (1000, 800), "white"), 0.75, 1)

    assert result.materials == {}
    assert result.conflicts == frozenset({"F11"})
    assert result.recognized_total == 0


def test_pattern_legend_endpoint_never_marks_ocr_as_user_confirmed() -> None:
    adapter = QueueAdapter([[token("F11 (58)", 20, 20)]])
    recognizer = PatternLegendRecognizer(adapter, VALID_CODES)
    app.dependency_overrides[get_pattern_legend_recognizer] = lambda: recognizer
    buffer = BytesIO()
    Image.new("RGB", (640, 480), "white").save(buffer, format="PNG")
    try:
        response = TestClient(app).post(
            "/pattern-legend/recognize",
            files={"image": ("real-pattern.png", buffer.getvalue(), "image/png")},
            data={"crop_y_start": "0.8", "crop_y_end": "1", "declared_total": "58"},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "needs_review"
    assert len(payload["materials"]) == 1
    material = payload["materials"][0]
    assert material["code"] == "F11"
    assert material["quantity"] == 58
    assert material["confirmed_by_user"] is False
    assert material["raw_text"] == "F11 (58)"
    assert material["recognition_source"] == "direct"
    assert material["confidence"] == 0.95
    assert material["evidence_region"]["y"] >= 384
    assert payload["recognized_total"] == 58
    assert payload["declared_total_matches"] is True
    assert payload["tokens"][0]["region"]["y"] >= 384
