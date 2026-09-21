"""Formal pattern-legend recognition workflow.

Recognition only produces review candidates. It cannot confirm a material
version or mutate inventory.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Literal

from PIL import Image, ImageOps

from app.legend_parser import LegendCandidate, collapse_unique_candidates, parse_legend_lines
from app.ocr_adapter import OcrAdapter
from app.pattern_legend import (
    EvidenceRegion,
    MaterialObservation,
    OcrToken,
    infer_column_layout,
    material_observations_from_tokens,
    materials_from_tokens,
)


PreprocessingVariant = Literal["original", "contrast_gray", "inverted_gray"]


@dataclass(frozen=True)
class LegendCrop:
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class LegendRecognition:
    status: str
    materials: dict[str, int]
    observations: dict[str, MaterialObservation]
    conflicts: frozenset[str]
    tokens: tuple[OcrToken, ...]
    crop: LegendCrop
    recognized_total: int
    declared_total_matches: bool | None
    column_fallback_used: bool
    preprocessing_variants: tuple[PreprocessingVariant, ...]
    low_confidence_codes: tuple[str, ...]


class PatternLegendRecognizer:
    def __init__(
        self,
        adapter: OcrAdapter,
        valid_codes: frozenset[str],
        *,
        enable_preprocessing: bool = True,
    ) -> None:
        self._adapter = adapter
        self._valid_codes = valid_codes
        self._enable_preprocessing = enable_preprocessing

    def recognize(
        self,
        image: Image.Image,
        crop_y_start: float,
        crop_y_end: float,
        declared_total: int | None = None,
    ) -> LegendRecognition:
        if not 0 <= crop_y_start < crop_y_end <= 1:
            raise ValueError("统计栏裁剪范围必须满足 0 ≤ 开始 < 结束 ≤ 1。")
        if declared_total is not None and declared_total <= 0:
            raise ValueError("声明总数必须是正整数。")

        rgb = image.convert("RGB")
        crop_top = int(rgb.height * crop_y_start)
        crop_bottom = int(rgb.height * crop_y_end)
        crop = rgb.crop((0, crop_top, rgb.width, crop_bottom))
        enlarged = crop.resize((crop.width * 2, crop.height * 2), Image.Resampling.LANCZOS)
        tokens = self._adapter.recognize(enlarged)
        materials, conflicts = materials_from_tokens(tokens, self._valid_codes, declared_total)

        (
            fallback_tokens,
            fallback_materials,
            fallback_conflicts,
            _fallback_observations,
        ) = self._recognize_columns(enlarged, tokens, declared_total)
        column_fallback_used = bool(fallback_tokens)
        if column_fallback_used:
            tokens = fallback_tokens
            materials = fallback_materials
            conflicts = fallback_conflicts

        primary_observations, _ = material_observations_from_tokens(
            tokens, self._valid_codes, declared_total
        )
        passes: list[
            tuple[
                PreprocessingVariant,
                dict[str, int],
                frozenset[str],
                dict[str, MaterialObservation],
            ]
        ] = [("original", materials, conflicts, primary_observations)]
        primary_confidences = [
            observation.confidence
            for observation in primary_observations.values()
            if observation.confidence is not None
        ]
        needs_preprocessing = (
            not materials
            or bool(conflicts)
            or any(confidence < 0.80 for confidence in primary_confidences)
        )
        if needs_preprocessing and self._enable_preprocessing:
            gray = ImageOps.grayscale(enlarged)
            contrast_gray = ImageOps.autocontrast(gray, cutoff=1).convert("RGB")
            inverted_gray = ImageOps.invert(ImageOps.autocontrast(gray, cutoff=1)).convert("RGB")
            contrast_tokens = self._adapter.recognize(contrast_gray)
            contrast_observations, contrast_conflicts = material_observations_from_tokens(
                contrast_tokens, self._valid_codes, declared_total
            )
            passes.append(
                (
                    "contrast_gray",
                    {
                        code: observation.quantity
                        for code, observation in contrast_observations.items()
                    },
                    contrast_conflicts,
                    contrast_observations,
                )
            )
            unresolved_low_confidence = any(
                observation.confidence is None
                or (observation.confidence < 0.80 and contrast_observations.get(code, None) is None)
                or (
                    observation.confidence < 0.80
                    and contrast_observations[code].quantity != observation.quantity
                )
                for code, observation in primary_observations.items()
            )
            if not materials or conflicts or contrast_conflicts or unresolved_low_confidence:
                variant_name: PreprocessingVariant = "inverted_gray"
                variant_image = inverted_gray
                variant_tokens = self._adapter.recognize(variant_image)
                variant_observations, variant_conflicts = material_observations_from_tokens(
                    variant_tokens, self._valid_codes, declared_total
                )
                passes.append(
                    (
                        variant_name,
                        {
                            code: observation.quantity
                            for code, observation in variant_observations.items()
                        },
                        variant_conflicts,
                        variant_observations,
                    )
                )

        materials, conflicts, selected_observations = self._merge_preprocessing_passes(passes)

        source_tokens = tuple(
            OcrToken(
                text=token.text,
                x=token.x / 2,
                y=crop_top + token.y / 2,
                width=token.width / 2,
                height=token.height / 2,
                confidence=token.confidence,
            )
            for token in tokens
        )
        evidence_observations = selected_observations
        observations = {
            code: MaterialObservation(
                code=observation.code,
                quantity=observation.quantity,
                raw_text=observation.raw_text,
                confidence=observation.confidence,
                evidence_region=EvidenceRegion(
                    x=observation.evidence_region.x / 2,
                    y=crop_top + observation.evidence_region.y / 2,
                    width=observation.evidence_region.width / 2,
                    height=observation.evidence_region.height / 2,
                ),
                source=observation.source,
            )
            for code, quantity in materials.items()
            if (observation := evidence_observations.get(code)) is not None
            and observation.quantity == quantity
        }
        if set(observations) != set(materials):
            raise RuntimeError("识别材料缺少可追溯的 OCR 证据。")
        recognized_total = sum(materials.values())
        declared_total_matches = (
            None if declared_total is None else recognized_total == declared_total
        )
        return LegendRecognition(
            status="needs_review",
            materials=materials,
            observations=observations,
            conflicts=conflicts,
            tokens=source_tokens,
            crop=LegendCrop(
                x=0,
                y=float(crop_top),
                width=float(rgb.width),
                height=float(crop_bottom - crop_top),
            ),
            recognized_total=recognized_total,
            declared_total_matches=declared_total_matches,
            column_fallback_used=column_fallback_used,
            preprocessing_variants=tuple(name for name, *_ in passes),
            low_confidence_codes=tuple(
                sorted(
                    code
                    for code, observation in observations.items()
                    if observation.confidence is None or observation.confidence < 0.80
                )
            ),
        )

    def _merge_preprocessing_passes(
        self,
        passes: list[
            tuple[
                PreprocessingVariant,
                dict[str, int],
                frozenset[str],
                dict[str, MaterialObservation],
            ]
        ],
    ) -> tuple[dict[str, int], frozenset[str], dict[str, MaterialObservation]]:
        primary_materials = passes[0][1]
        primary_observations = passes[0][3]
        conflicts = {code for _, _, pass_conflicts, _ in passes for code in pass_conflicts}
        quantities_by_code: dict[str, dict[int, list[MaterialObservation]]] = {}
        for _, pass_materials, _, pass_observations in passes:
            for code, quantity in pass_materials.items():
                observation = pass_observations.get(code)
                if observation is None:
                    continue
                quantities_by_code.setdefault(code, {}).setdefault(quantity, []).append(observation)

        materials: dict[str, int] = {}
        observations: dict[str, MaterialObservation] = {}
        for code, quantities in quantities_by_code.items():
            if len(quantities) != 1:
                conflicts.add(code)
                continue
            quantity, supporting_observations = next(iter(quantities.items()))
            primary_supports = primary_materials.get(code) == quantity
            if primary_materials and not primary_supports:
                continue
            if not primary_supports and len(supporting_observations) < 2:
                continue
            primary_observation = primary_observations.get(code)
            if (
                primary_observation is not None
                and (
                    primary_observation.confidence is None or primary_observation.confidence < 0.80
                )
                and len(supporting_observations) < 2
            ):
                conflicts.add(code)
                continue
            best = max(
                supporting_observations,
                key=lambda observation: (
                    observation.confidence if observation.confidence is not None else -1
                ),
            )
            if len(supporting_observations) >= 2:
                consensus_floor = min(0.94, 0.82 + len(supporting_observations) * 0.04)
                best = MaterialObservation(
                    code=best.code,
                    quantity=best.quantity,
                    raw_text=best.raw_text,
                    confidence=max(best.confidence or 0.0, consensus_floor),
                    evidence_region=best.evidence_region,
                    source=best.source,
                )
            materials[code] = quantity
            observations[code] = best

        for code in conflicts:
            materials.pop(code, None)
            observations.pop(code, None)
        return materials, frozenset(conflicts), observations

    def _recognize_columns(
        self,
        image: Image.Image,
        initial_tokens: list[OcrToken],
        declared_total: int | None,
    ) -> tuple[
        list[OcrToken],
        dict[str, int],
        frozenset[str],
        dict[str, MaterialObservation],
    ]:
        layout = infer_column_layout(initial_tokens, image.width, image.height)
        if layout is None:
            return [], {}, frozenset(), {}

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
        tile_geometry: list[tuple[int, int, int]] = []
        for index, center in enumerate(layout.centers):
            left = round(center - crop_width / 2)
            card = image.crop((left, round(layout.top), left + crop_width, round(layout.bottom)))
            card = card.resize((tile_width, tile_height), Image.Resampling.LANCZOS)
            tile_column = index % columns_per_row
            tile_row = index // columns_per_row
            origin_x = gap + tile_column * (tile_width + gap)
            origin_y = gap + tile_row * (tile_height + gap)
            montage.paste(card, (origin_x, origin_y))
            tile_geometry.append((origin_x, origin_y, left))

        montage_tokens = self._adapter.recognize(montage)
        candidates: list[LegendCandidate] = []
        remapped_tokens: list[OcrToken] = []
        remapped_observations: list[MaterialObservation] = []
        for origin_x, origin_y, source_left in tile_geometry:
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
            tile_observations, _ = material_observations_from_tokens(
                tile_tokens, self._valid_codes, declared_total
            )
            for code, observation in tile_observations.items():
                quantity = observation.quantity
                candidates.extend(parse_legend_lines([f"{code} {quantity}"], self._valid_codes))
                remapped_observations.append(
                    MaterialObservation(
                        code=code,
                        quantity=quantity,
                        raw_text=observation.raw_text,
                        confidence=observation.confidence,
                        evidence_region=EvidenceRegion(
                            x=source_left + observation.evidence_region.x / scale,
                            y=layout.top + observation.evidence_region.y / scale,
                            width=observation.evidence_region.width / scale,
                            height=observation.evidence_region.height / scale,
                        ),
                        source=observation.source,
                    )
                )
            remapped_tokens.extend(
                OcrToken(
                    text=token.text,
                    x=source_left + token.x / scale,
                    y=layout.top + token.y / scale,
                    width=token.width / scale,
                    height=token.height / scale,
                    confidence=token.confidence,
                )
                for token in tile_tokens
            )

        materials, conflicts = collapse_unique_candidates(candidates)
        observations: dict[str, MaterialObservation] = {}
        for observation in remapped_observations:
            if (
                observation.code in conflicts
                or materials.get(observation.code) != observation.quantity
            ):
                continue
            previous = observations.get(observation.code)
            previous_confidence = previous.confidence if previous is not None else None
            if previous is None or (observation.confidence or -1) > (previous_confidence or -1):
                observations[observation.code] = observation
        return remapped_tokens, materials, conflicts, observations
