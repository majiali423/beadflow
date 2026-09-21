"""Conservative automatic crop suggestions for pattern-sheet legends.

The detector looks for repeated filled legend swatches in the lower half of a
sheet.  It never claims that a crop is correct: weak or unsupported layouts
fall back to a deliberately broad lower-image band for user review.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np
from PIL import Image


@dataclass(frozen=True)
class LegendCropSuggestion:
    y_start: float
    y_end: float
    confidence: float
    method: Literal["color_bar_rows", "broad_lower_band"]
    needs_manual_review: bool
    evidence_box_count: int


@dataclass(frozen=True)
class _Box:
    x: int
    y: int
    width: int
    height: int
    fill: float

    @property
    def center_y(self) -> float:
        return self.y + self.height / 2


def _median(values: list[float]) -> float:
    return float(np.median(np.asarray(values, dtype=np.float32)))


def _candidate_boxes(image: np.ndarray) -> list[_Box]:
    height, width = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    mask = (((hsv[:, :, 1] > 22) & (hsv[:, :, 2] < 250)) | (gray < 205)).astype(np.uint8) * 255
    mask[: round(height * 0.5), :] = 0
    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (max(3, width // 250), max(1, height // 500)),
    )
    closed_mask: np.ndarray = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    boxes: list[_Box] = []
    for contour in contours:
        x, y, box_width, box_height = cv2.boundingRect(contour)
        fill = cv2.contourArea(contour) / max(1, box_width * box_height)
        if not width * 0.03 <= box_width <= width * 0.30:
            continue
        if not height * 0.006 <= box_height <= height * 0.07:
            continue
        if box_width / box_height < 1.8 or fill < 0.18:
            continue
        boxes.append(_Box(x, y, box_width, box_height, float(fill)))
    return boxes


def _row_groups(boxes: list[_Box], image_height: int) -> list[list[_Box]]:
    groups: list[list[_Box]] = []
    tolerance = image_height * 0.02
    for box in sorted(boxes, key=lambda item: item.center_y):
        group = next(
            (
                candidate
                for candidate in groups
                if abs(box.center_y - _median([item.center_y for item in candidate])) <= tolerance
            ),
            None,
        )
        if group is None:
            groups.append([box])
        else:
            group.append(box)
    return groups


def suggest_legend_crop(image: Image.Image) -> LegendCropSuggestion:
    """Return a visible, user-reviewable lower-image crop suggestion."""

    rgb = np.asarray(image.convert("RGB"))
    source_height, source_width = rgb.shape[:2]
    if source_height < 1 or source_width < 1:
        raise ValueError("图纸图片尺寸无效。")

    scale = min(1.0, 1000 / source_width)
    if scale < 1:
        rgb = cv2.resize(
            rgb,
            (round(source_width * scale), round(source_height * scale)),
            interpolation=cv2.INTER_AREA,
        )
    height, width = rgb.shape[:2]
    boxes = _candidate_boxes(rgb)
    scored_groups: list[tuple[float, list[_Box]]] = []
    for group in _row_groups(boxes, height):
        if len(group) < 2:
            continue
        coverage = min(1.0, sum(box.width for box in group) / width)
        center = _median([box.center_y for box in group]) / height
        fill = _median([box.fill for box in group])
        score = len(group) + coverage * 2 + fill * 4 + center * 1.5
        scored_groups.append((score, group))

    if not scored_groups:
        return LegendCropSuggestion(
            y_start=0.70,
            y_end=1.0,
            confidence=0.20,
            method="broad_lower_band",
            needs_manual_review=True,
            evidence_box_count=0,
        )

    _, best_group = max(scored_groups, key=lambda item: item[0])
    group_top = min(box.y for box in best_group) / height
    group_bottom = max(box.y + box.height for box in best_group) / height
    related = [
        box
        for box in boxes
        if box.y / height >= group_top - 0.035
        and (box.y + box.height) / height <= group_bottom + 0.055
    ]
    if len(related) >= len(best_group):
        best_group = related
        group_top = min(box.y for box in best_group) / height
        group_bottom = max(box.y + box.height for box in best_group) / height

    median_fill = _median([box.fill for box in best_group])
    confidence = min(0.98, 0.42 + min(len(best_group), 8) * 0.055 + median_fill * 0.16)
    return LegendCropSuggestion(
        y_start=max(0.45, group_top - 0.025),
        y_end=min(1.0, group_bottom + 0.035),
        confidence=confidence,
        method="color_bar_rows",
        needs_manual_review=confidence < 0.72,
        evidence_box_count=len(best_group),
    )
