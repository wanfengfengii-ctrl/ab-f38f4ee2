"""Core pixel-mask data model and thread-safe in-memory repository.

A mask keeps two same-shaped grids, one run-length-encoded run list per row:

* ``label_rle``  -- current label (0..255) of every pixel
* ``touch_rle``  -- revision number of the last successful patch that wrote
                    each pixel (0 means "never touched since creation")

RLE run: ``(start, end, value)`` -- half-open ``[start, end)`` column range.
Internal RLE is always canonical: covers ``[0, cols)``, sorted by start,
no two adjacent runs share the same value.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

Run = tuple[int, int, int]  # (start_col, end_col, value)
Region = tuple[int, int, int, int]  # (row, start_col, end_col, label)


class MaskAlreadyExists(Exception):
    """A create request reuses a known mask id."""


class MaskNotFound(Exception):
    """Referenced mask id does not exist."""


class BaseRevisionAhead(Exception):
    """Patch base revision is greater than anything the server issued."""


class PatchConflict(Exception):
    """Raised (and caught by the API layer) on touched-pixel overlap.

    ``regions`` is the conflict set merged and sorted row-major:
    ``(row, start_col, end_col)``.
    """

    def __init__(self, current_rev: int,
                 regions: list[tuple[int, int, int]]) -> None:
        super().__init__(f"conflict at rev {current_rev}: {regions!r}")
        self.current_rev = current_rev
        self.regions = regions


# ---------------------------------------------------------------------------
# Pure RLE primitives
# ---------------------------------------------------------------------------

def zero_row(width: int) -> list[Run]:
    return [(0, width, 0)]


def coalesce(runs: list[Run]) -> list[Run]:
    """Merge adjacent runs carrying the same value; drop empty runs."""
    merged: list[Run] = []
    for start, end, value in runs:
        if start >= end:
            continue
        if merged and merged[-1][1] == start and merged[-1][2] == value:
            merged[-1] = (merged[-1][0], end, value)
        else:
            merged.append((start, end, value))
    return merged


def paint(base: list[Run], paints: list[Run], width: int) -> list[Run]:
    """Overlay sorted, mutually disjoint half-open ``paints`` onto ``base``.

    Returns canonical RLE covering ``[0, width)``. Paint values win over the
    base value; paints never overlap each other (guaranteed per patch).
    """
    out: list[Run] = []
    j = 0
    n = len(paints)
    for a, b, val in base:
        # Skip paints already fully consumed by earlier base runs.
        while j < n and paints[j][1] <= a:
            j += 1
        pos = a
        k = j
        while k < n and paints[k][0] < b:
            s, e, v = paints[k]
            if s > pos:
                out.append((pos, min(s, b), val))
            out.append((max(s, pos), min(e, b), v))
            pos = min(e, b)
            if e >= b:
                # Paint extends into the next base run; keep k pointing at it.
                break
            k += 1
        j = k
        if pos < b:
            out.append((pos, b, val))
    return coalesce(out)


def conflict_pieces(touched: list[Run], start: int, end: int,
                    base_rev: int) -> list[tuple[int, int]]:
    """Sub-intervals of ``[start, end)`` last written by a rev > ``base_rev``."""
    pieces: list[tuple[int, int]] = []
    for a, b, rev in touched:
        if b <= start or a >= end:
            continue
        if rev > base_rev:
            pieces.append((max(a, start), min(b, end)))
    return pieces  # sorted, disjoint (touched is canonical RLE)


def merge_union(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Sort and union half-open intervals; touching intervals merge."""
    if not intervals:
        return []
    ordered = sorted(intervals)
    merged = [ordered[0]]
    for s, e in ordered[1:]:
        ms, me = merged[-1]
        if s <= me:
            merged[-1] = (ms, max(me, e))
        else:
            merged.append((s, e))
    return merged


# ---------------------------------------------------------------------------
# Mask and repository
# ---------------------------------------------------------------------------

@dataclass
class Mask:
    mask_id: str
    rows: int
    cols: int
    rev: int = 0
    label_rle: list[list[Run]] = field(default_factory=list)
    touch_rle: list[list[Run]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    @classmethod
    def blank(cls, mask_id: str, rows: int, cols: int) -> "Mask":
        return cls(
            mask_id=mask_id,
            rows=rows,
            cols=cols,
            label_rle=[zero_row(cols) for _ in range(rows)],
            touch_rle=[zero_row(cols) for _ in range(rows)],
        )

    def snapshot(self) -> tuple[int, list[list[Run]]]:
        """Return (rev, defensive copy of label RLE) under the mask lock."""
        with self.lock:
            return self.rev, [list(row) for row in self.label_rle]


class Repository:
    """In-memory mask store. Creation is globally serialised; every patch on
    a given mask is serialised by that mask's own lock, so concurrent commits
    can never lose an update."""

    def __init__(self) -> None:
        self._masks: dict[str, Mask] = {}
        self._create_lock = threading.Lock()

    def create(self, mask_id: str, rows: int, cols: int) -> Mask:
        with self._create_lock:
            if mask_id in self._masks:
                raise MaskAlreadyExists(mask_id)
            mask = Mask.blank(mask_id, rows, cols)
            self._masks[mask_id] = mask
            return mask

    def get(self, mask_id: str) -> Mask:
        mask = self._masks.get(mask_id)
        if mask is None:
            raise MaskNotFound(mask_id)
        return mask

    def apply_patch(
        self, mask: Mask, base_rev: int, regions: list[Region]
    ) -> int:
        """Atomically merge a validated patch.

        Returns the resulting revision. Raises ``PatchConflict`` without
        touching any pixel when any target pixel was written after
        ``base_rev``. Raises ``BaseRevisionAhead`` for an unknown future rev.
        """
        with mask.lock:
            if base_rev > mask.rev:
                raise BaseRevisionAhead((base_rev, mask.rev))

            by_row: dict[int, list[tuple[int, int, int]]] = {}
            for row, start, end, label in regions:
                by_row.setdefault(row, []).append((start, end, label))

            # Phase 1: detect every conflicting pixel; write nothing yet,
            # so conflict responses create no revision and change no data.
            conflict_regions: list[tuple[int, int, int]] = []
            for row in sorted(by_row):
                hits: list[tuple[int, int]] = []
                touched = mask.touch_rle[row]
                for start, end, _ in by_row[row]:
                    hits.extend(conflict_pieces(touched, start, end, base_rev))
                for s, e in merge_union(hits):
                    conflict_regions.append((row, s, e))

            if conflict_regions:
                raise PatchConflict(mask.rev, conflict_regions)

            # Empty patch is a legal no-op: it creates no revision.
            if not regions:
                return mask.rev

            # Phase 2: commit. New pixels are stamped with the new revision.
            new_rev = mask.rev + 1
            for row, paints_raw in by_row.items():
                paints = sorted((s, e, label) for s, e, label in paints_raw)
                stamp = sorted((s, e, new_rev) for s, e, _ in paints_raw)
                mask.label_rle[row] = paint(mask.label_rle[row], paints,
                                            mask.cols)
                mask.touch_rle[row] = paint(mask.touch_rle[row], stamp,
                                            mask.cols)
            mask.rev = new_rev
            return new_rev
