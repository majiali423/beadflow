from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app.main import app


PRIVATE_FIXTURE = (
    Path(__file__).parents[1]
    / "fixtures"
    / "private"
    / "pattern-legend"
    / "769925bfaf35b00c7a038ed066fb25ce.jpg"
)


def test_real_pattern_grid_endpoint_returns_review_only_evidence() -> None:
    if not PRIVATE_FIXTURE.exists():
        pytest.skip("private user fixtures are intentionally not committed")

    response = TestClient(app).post(
        "/pattern-grid/analyze",
        files={"image": ("pattern.jpg", PRIVATE_FIXTURE.read_bytes(), "image/jpeg")},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "needs_review"
    assert result["grid_detected"] is True
    assert result["column_count"] == 22
    assert result["row_count"] == 20
    assert result["occupied_count"] == 246
    assert result["uncertain_count"] == 12
    assert result["empty_count"] == 182
    assert len(result["cells"]) == 22 * 20
    assert len(result["color_clusters"]) >= 12
    assert sum(cluster["cell_count"] for cluster in result["color_clusters"]) == 246
    assert all(
        (cell["cluster_id"] is not None) == (cell["state"] == "occupied")
        for cell in result["cells"]
    )
    assert result["requires_user_confirmation"] is True
    assert result["inventory_mutated"] is False


def test_pattern_grid_endpoint_rejects_non_images() -> None:
    response = TestClient(app).post(
        "/pattern-grid/analyze",
        files={"image": ("notes.txt", b"not an image", "text/plain")},
    )

    assert response.status_code == 415


def test_pattern_grid_endpoint_sends_blank_image_to_review_without_cells() -> None:
    payload = BytesIO()
    Image.new("RGB", (1280, 1600), "white").save(payload, format="PNG")

    response = TestClient(app).post(
        "/pattern-grid/analyze",
        files={"image": ("blank.png", payload.getvalue(), "image/png")},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "needs_review"
    assert result["grid_detected"] is False
    assert result["row_count"] is None
    assert result["column_count"] is None
    assert result["occupied_count"] == 0
    assert result["empty_count"] == 0
    assert result["uncertain_count"] == 0
    assert result["cells"] == []
    assert result["color_clusters"] == []
    assert "insufficient_periodic_line_evidence" in result["reasons"]
    assert result["inventory_mutated"] is False


def test_pattern_grid_endpoint_rejects_fake_jpeg_payload() -> None:
    response = TestClient(app).post(
        "/pattern-grid/analyze",
        files={"image": ("broken.jpg", b"not really a jpeg", "image/jpeg")},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "图片无法解码。"}
