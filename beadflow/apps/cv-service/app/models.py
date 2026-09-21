from typing import Literal

from pydantic import BaseModel, Field


class EvidenceRegion(BaseModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(ge=0)
    height: float = Field(ge=0)


class LegendOcrToken(BaseModel):
    text: str
    region: EvidenceRegion
    confidence: float | None = Field(default=None, ge=0, le=1)


class LegendMaterialResult(BaseModel):
    code: str
    quantity: int = Field(gt=0)
    raw_text: str
    confidence: float | None = Field(default=None, ge=0, le=1)
    evidence_region: EvidenceRegion
    recognition_source: Literal["direct", "compact", "spatial"]
    confirmed_by_user: Literal[False] = False


class PatternLegendResult(BaseModel):
    status: Literal["needs_review"] = "needs_review"
    materials: list[LegendMaterialResult]
    conflicts: list[str]
    tokens: list[LegendOcrToken]
    crop: EvidenceRegion
    recognized_total: int = Field(ge=0)
    declared_total_matches: bool | None
    column_fallback_used: bool
    preprocessing_variants: list[Literal["original", "contrast_gray", "inverted_gray"]]
    low_confidence_codes: list[str]


class LegendCropSuggestionResult(BaseModel):
    crop_y_start: float = Field(ge=0, lt=1)
    crop_y_end: float = Field(gt=0, le=1)
    confidence: float = Field(ge=0, le=1)
    method: Literal["color_bar_rows", "broad_lower_band"]
    needs_manual_review: bool
    evidence_box_count: int = Field(ge=0)


class LabColor(BaseModel):
    lightness: float = Field(ge=0, le=255)
    a: float = Field(ge=0, le=255)
    b: float = Field(ge=0, le=255)


class GridCellReviewResult(BaseModel):
    row: int = Field(ge=0)
    column: int = Field(ge=0)
    state: Literal["occupied", "empty", "uncertain"]
    reason: str
    cluster_id: int | None = Field(default=None, ge=0)


class GridColorClusterResult(BaseModel):
    cluster_id: int = Field(ge=0)
    cell_count: int = Field(gt=0)
    median_lab: LabColor
    empty_reference_distance: float = Field(ge=0)


class PatternGridReviewResult(BaseModel):
    status: Literal["needs_review"] = "needs_review"
    grid_detected: bool
    row_count: int | None = Field(default=None, gt=0)
    column_count: int | None = Field(default=None, gt=0)
    occupied_count: int = Field(ge=0)
    empty_count: int = Field(ge=0)
    uncertain_count: int = Field(ge=0)
    cells: list[GridCellReviewResult]
    color_clusters: list[GridColorClusterResult]
    reasons: list[str]
    requires_user_confirmation: Literal[True] = True
    inventory_mutated: Literal[False] = False
