"""Replaceable OCR adapters for pattern legend recognition."""

from __future__ import annotations

from typing import Any, Protocol

import numpy as np
from PIL import Image

from app.pattern_legend import OcrToken


class OcrAdapter(Protocol):
    def recognize(self, image: Image.Image) -> list[OcrToken]: ...


class RapidOcrAdapter:
    """Local cross-platform RapidOCR adapter, loaded lazily."""

    def __init__(self) -> None:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-untyped]

        self._engine: Any = RapidOCR()

    def recognize(self, image: Image.Image) -> list[OcrToken]:
        result, _ = self._engine(np.asarray(image.convert("RGB")))
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
