from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).parents[1]
GOLDEN_PATH = ROOT / "fixtures" / "pattern_legend_golden.json"
PALETTE_PATH = ROOT.parents[1] / "assets" / "palettes" / "mard221.json"


def test_golden_manifest_uses_real_palette_codes_and_consistent_totals() -> None:
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    palette = json.loads(PALETTE_PATH.read_text(encoding="utf-8"))
    valid_codes = {color["code"] for color in palette["colors"]}

    assert len(golden["fixtures"]) >= 13
    for fixture in golden["fixtures"]:
        assert set(fixture["materials"]).issubset(valid_codes)
        recognized_total = sum(fixture["materials"].values())
        if fixture["verification_status"] != "needs_user_confirmation":
            declared_total = fixture["declared_total"]
            if declared_total is not None:
                assert recognized_total == declared_total


def test_private_fixture_hashes_match_manifest_when_images_are_available() -> None:
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    fixture_root = ROOT / golden["fixture_root"]
    if not fixture_root.exists():
        return

    for fixture in golden["fixtures"]:
        image_path = fixture_root / fixture["file"]
        assert image_path.exists(), fixture["file"]
        assert hashlib.sha256(image_path.read_bytes()).hexdigest() == fixture["sha256"]
