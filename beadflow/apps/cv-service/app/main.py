import json
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from app.cell_analysis import analyze_grid_phase_one
from app.legend_crop import suggest_legend_crop
from app.models import (
    EvidenceRegion,
    GridCellReviewResult,
    GridColorClusterResult,
    LabColor,
    LegendCropSuggestionResult,
    LegendMaterialResult,
    LegendOcrToken,
    PatternGridReviewResult,
    PatternLegendResult,
)
from app.ocr_adapter import RapidOcrAdapter
from app.pattern_legend_service import PatternLegendRecognizer

app = FastAPI(
    title="BeadFlow CV Service",
    version="0.1.0",
    description="Pattern-sheet analysis and constrained MARD legend OCR.",
)

PALETTE_PATH = Path(__file__).parents[3] / "assets" / "palettes" / "mard221.json"


@lru_cache(maxsize=1)
def get_pattern_legend_recognizer() -> PatternLegendRecognizer:
    palette = json.loads(PALETTE_PATH.read_text(encoding="utf-8"))
    valid_codes = frozenset(color["code"] for color in palette["colors"])
    return PatternLegendRecognizer(RapidOcrAdapter(), valid_codes)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "beadflow-cv-service"}


@app.post("/pattern-grid/analyze", response_model=PatternGridReviewResult)
async def analyze_pattern_grid(
    image: Annotated[UploadFile, File()],
) -> PatternGridReviewResult:
    """Analyze the main grid for review without confirming or consuming inventory."""

    if image.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="只支持 JPEG、PNG 或 WebP。")
    payload = await image.read()
    if len(payload) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="图片不能超过 15MB。")
    try:
        with Image.open(BytesIO(payload)) as decoded:
            analysis = analyze_grid_phase_one(decoded)
            occupancy = analysis.occupancy
            clusters = analysis.background_clusters
    except UnidentifiedImageError as error:
        raise HTTPException(status_code=400, detail="图片无法解码。") from error

    cluster_by_cell = {
        position: cluster.cluster_id
        for cluster in clusters.clusters
        for position in cluster.members
    }
    grid_detected = bool(occupancy.cells) and clusters.status == "detected"
    return PatternGridReviewResult(
        grid_detected=grid_detected,
        row_count=occupancy.row_count,
        column_count=occupancy.column_count,
        occupied_count=occupancy.occupied_count,
        empty_count=occupancy.empty_count,
        uncertain_count=occupancy.uncertain_count,
        cells=[
            GridCellReviewResult(
                row=cell.row,
                column=cell.column,
                state=cell.state,
                reason=cell.reason,
                cluster_id=cluster_by_cell.get((cell.row, cell.column)),
            )
            for cell in occupancy.cells
        ],
        color_clusters=[
            GridColorClusterResult(
                cluster_id=cluster.cluster_id,
                cell_count=cluster.cell_count,
                median_lab=LabColor(
                    lightness=cluster.median_lab[0],
                    a=cluster.median_lab[1],
                    b=cluster.median_lab[2],
                ),
                empty_reference_distance=cluster.empty_reference_distance,
            )
            for cluster in clusters.clusters
        ],
        reasons=list(dict.fromkeys(occupancy.reasons + clusters.reasons)),
    )


@app.post("/pattern-legend/detect-crop", response_model=LegendCropSuggestionResult)
async def detect_pattern_legend_crop(
    image: Annotated[UploadFile, File()],
) -> LegendCropSuggestionResult:
    if image.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="只支持 JPEG、PNG 或 WebP。")
    payload = await image.read()
    if len(payload) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="图片不能超过 15MB。")
    try:
        with Image.open(BytesIO(payload)) as decoded:
            suggestion = suggest_legend_crop(decoded)
    except UnidentifiedImageError as error:
        raise HTTPException(status_code=400, detail="图片无法解码。") from error

    return LegendCropSuggestionResult(
        crop_y_start=suggestion.y_start,
        crop_y_end=suggestion.y_end,
        confidence=suggestion.confidence,
        method=suggestion.method,
        needs_manual_review=suggestion.needs_manual_review,
        evidence_box_count=suggestion.evidence_box_count,
    )


@app.post("/pattern-legend/recognize", response_model=PatternLegendResult)
async def recognize_pattern_legend(
    image: Annotated[UploadFile, File()],
    crop_y_start: Annotated[float, Form(ge=0, lt=1)],
    crop_y_end: Annotated[float, Form(gt=0, le=1)],
    declared_total: Annotated[int | None, Form(gt=0)] = None,
    recognizer: PatternLegendRecognizer = Depends(get_pattern_legend_recognizer),
) -> PatternLegendResult:
    if image.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="只支持 JPEG、PNG 或 WebP。")
    payload = await image.read()
    if len(payload) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="图片不能超过 15MB。")
    try:
        with Image.open(BytesIO(payload)) as decoded:
            result = recognizer.recognize(
                decoded,
                crop_y_start=crop_y_start,
                crop_y_end=crop_y_end,
                declared_total=declared_total,
            )
    except UnidentifiedImageError as error:
        raise HTTPException(status_code=400, detail="图片无法解码。") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return PatternLegendResult(
        materials=[
            LegendMaterialResult(
                code=code,
                quantity=quantity,
                raw_text=result.observations[code].raw_text,
                confidence=result.observations[code].confidence,
                evidence_region=EvidenceRegion(
                    x=result.observations[code].evidence_region.x,
                    y=result.observations[code].evidence_region.y,
                    width=result.observations[code].evidence_region.width,
                    height=result.observations[code].evidence_region.height,
                ),
                recognition_source=result.observations[code].source,
            )
            for code, quantity in sorted(result.materials.items())
        ],
        conflicts=sorted(result.conflicts),
        tokens=[
            LegendOcrToken(
                text=token.text,
                region=EvidenceRegion(
                    x=token.x,
                    y=token.y,
                    width=token.width,
                    height=token.height,
                ),
                confidence=token.confidence,
            )
            for token in result.tokens
        ],
        crop=EvidenceRegion(
            x=result.crop.x,
            y=result.crop.y,
            width=result.crop.width,
            height=result.crop.height,
        ),
        recognized_total=result.recognized_total,
        declared_total_matches=result.declared_total_matches,
        column_fallback_used=result.column_fallback_used,
        preprocessing_variants=list(result.preprocessing_variants),
        low_confidence_codes=list(result.low_confidence_codes),
    )
