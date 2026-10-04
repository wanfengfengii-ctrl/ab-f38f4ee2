"""HTTP API for the collaborative pixel-mask service."""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic import ValidationError

from .store import (
    BaseRevisionAhead,
    Mask,
    MaskAlreadyExists,
    MaskNotFound,
    PatchConflict,
    Repository,
)

MAX_DIM = 100_000


class CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class RegionIn(CamelModel):
    row: int = Field(ge=0)
    start_col: int = Field(alias="startCol")
    end_col: int = Field(alias="endCol")
    label: int = Field(ge=0, le=255)


class CreateEvent(CamelModel):
    type: Literal["create"]
    mask_id: str = Field(alias="maskId", min_length=1, max_length=128)
    rows: int = Field(gt=0, le=MAX_DIM)
    cols: int = Field(gt=0, le=MAX_DIM)


class PatchEvent(CamelModel):
    type: Literal["patch"] = "patch"
    mask_id: str = Field(alias="maskId", min_length=1, max_length=128)
    base_rev: int = Field(alias="baseRev", ge=0)
    regions: list[RegionIn]


class EventEnvelope(CamelModel):
    """OneOf create/patch, discriminated by the ``type`` field."""

    # Fields from both variants; semantic validation happens in the endpoint.
    type: Literal["create", "patch"]
    mask_id: str = Field(alias="maskId", min_length=1, max_length=128)
    rows: int | None = Field(default=None, gt=0, le=MAX_DIM)
    cols: int | None = Field(default=None, gt=0, le=MAX_DIM)
    base_rev: int | None = Field(default=None, alias="baseRev", ge=0)
    regions: list[RegionIn] | None = None


def err(status: int, code: str, message: str, **extra: object) -> JSONResponse:
    body: dict[str, object] = {"error": code, "message": message}
    body.update(extra)
    return JSONResponse(status_code=status, content=body)


app = FastAPI(title="collaborative-pixel-mask", version="1.0.0")
repo = Repository()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/masks/events")
async def post_event(request: Request) -> JSONResponse:
    try:
        raw = await request.json()
    except Exception:  # malformed JSON / unreadable body
        return err(400, "invalid_request", "request body must be valid JSON")
    if not isinstance(raw, dict):
        return err(400, "invalid_request", "request body must be a JSON object")

    try:
        event = EventEnvelope.model_validate(raw)
    except ValidationError as exc:
        return JSONResponse(status_code=400,
                            content={"error": "validation_failed",
                                     "message": "request failed validation",
                                     "details": exc.errors()})

    if event.type == "create":
        if event.rows is None or event.cols is None:
            return err(400, "validation_failed",
                       "create event requires rows and cols")
        if event.regions is not None or event.base_rev is not None:
            return err(400, "validation_failed",
                       "create event must not carry baseRev or regions")
        try:
            mask = repo.create(event.mask_id, event.rows, event.cols)
        except MaskAlreadyExists:
            existing: Mask = repo.get(event.mask_id)
            rev, _ = existing.snapshot()
            # Observable conflict feedback: same id, different creation.
            return JSONResponse(
                status_code=409,
                content={"error": "mask_already_exists",
                         "message": f"mask {event.mask_id!r} already exists",
                         "maskId": event.mask_id,
                         "rows": existing.rows,
                         "cols": existing.cols,
                         "currentRev": rev},
            )
        return JSONResponse(
            status_code=201,
            content={"maskId": mask.mask_id, "rows": mask.rows,
                     "cols": mask.cols, "rev": 0},
        )

    # --- patch -------------------------------------------------------------
    if event.regions is None or event.base_rev is None:
        return err(400, "validation_failed",
                   "patch event requires baseRev and regions")
    try:
        mask = repo.get(event.mask_id)
    except MaskNotFound:
        return err(404, "mask_not_found",
                   f"mask {event.mask_id!r} does not exist",
                   maskId=event.mask_id)

    regions = [(r.row, r.start_col, r.end_col, r.label) for r in event.regions]
    bad = _validate_regions(mask, regions)
    if bad is not None:
        return err(400, "validation_failed", bad)

    try:
        new_rev = repo.apply_patch(mask, event.base_rev, regions)
    except BaseRevisionAhead:
        return err(422, "base_revision_ahead",
                   f"baseRev {event.base_rev} is ahead of current revision "
                   f"{mask.rev}", currentRev=mask.rev)
    except PatchConflict as conflict:
        return JSONResponse(
            status_code=409,
            content={
                "error": "conflict",
                "message": "patch targets pixels committed after baseRev",
                "maskId": mask.mask_id,
                "currentRev": conflict.current_rev,
                "conflicts": [
                    {"row": row, "startCol": s, "endCol": e}
                    for row, s, e in conflict.regions
                ],
            },
        )

    return JSONResponse(
        status_code=200,
        content={"maskId": mask.mask_id, "rev": new_rev,
                 "currentRev": new_rev},
    )


def _validate_regions(mask: Mask,
                      regions: list[tuple[int, int, int, int]]) -> str | None:
    """Bounds plus per-patch non-overlap checks. Returns an error message."""
    by_row: dict[int, list[tuple[int, int]]] = {}
    for row, start, end, _label in regions:
        if row >= mask.rows:
            return f"row {row} out of range for mask with {mask.rows} rows"
        if start < 0 or end < 0:
            return "column indices must be non-negative"
        if start >= end:
            return f"empty/backwards interval [{start}, {end}) on row {row}"
        if end > mask.cols:
            return (f"interval [{start}, {end}) exceeds mask width "
                    f"{mask.cols} on row {row}")
        by_row.setdefault(row, []).append((start, end))

    for row, intervals in by_row.items():
        intervals.sort()
        for (s1, e1), (s2, e2) in zip(intervals, intervals[1:]):
            if s2 < e1:  # half-open: touching at e1 == s2 is allowed
                return (f"overlapping intervals [{s1}, {e1}) and "
                        f"[{s2}, {e2}) within the same patch on row {row}")
    return None


@app.get("/api/masks/{mask_id}")
def get_mask(mask_id: str) -> JSONResponse:
    try:
        mask = repo.get(mask_id)
    except MaskNotFound:
        return err(404, "mask_not_found",
                   f"mask {mask_id!r} does not exist", maskId=mask_id)

    rev, label_rle = mask.snapshot()
    return JSONResponse(
        content={
            "maskId": mask.mask_id,
            "rows": mask.rows,
            "cols": mask.cols,
            "currentRev": rev,
            "rle": [
                [{"startCol": s, "endCol": e, "label": v} for s, e, v in row]
                for row in label_rle
            ],
        }
    )
