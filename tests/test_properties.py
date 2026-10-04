"""Randomised property tests: RLE repository vs a flat-array reference."""

from __future__ import annotations

import random
import threading

import pytest

from app.store import (
    BaseRevisionAhead,
    PatchConflict,
    Repository,
)


class FlatReference:
    """Trivial, obviously-correct mask implementation."""

    def __init__(self, rows: int, cols: int) -> None:
        self.rows, self.cols = rows, cols
        self.labels = [[0] * cols for _ in range(rows)]
        self.touched = [[0] * cols for _ in range(rows)]
        self.rev = 0

    def apply(self, base_rev: int, regions):
        conflicts = {}
        for row, s, e, _ in regions:
            for c in range(s, e):
                if self.touched[row][c] > base_rev:
                    conflicts.setdefault(row, []).append(c)
        if conflicts:
            merged = []
            for row in sorted(conflicts):
                cols = sorted(conflicts[row])
                start = prev = cols[0]
                for c in cols[1:]:
                    if c == prev + 1:
                        prev = c
                    else:
                        merged.append((row, start, prev + 1))
                        start = prev = c
                merged.append((row, start, prev + 1))
            return PatchConflict(self.rev, merged)
        new_rev = self.rev + 1
        for row, s, e, label in regions:
            for c in range(s, e):
                self.labels[row][c] = label
                self.touched[row][c] = new_rev
        self.rev = new_rev
        return new_rev


def flatten_rle(rle, cols):
    out = []
    for runs in rle:
        row = [0] * cols
        for s, e, v in runs:
            for c in range(s, e):
                row[c] = v
        out.append(row)
    return out


@pytest.mark.parametrize("seed", range(30))
def test_random_patch_sequences_match_reference(seed):
    rng = random.Random(seed)
    rows, cols = rng.randint(1, 5), rng.randint(1, 20)
    repo = Repository()
    mask = repo.create("rng", rows, cols)
    ref = FlatReference(rows, cols)

    for _ in range(rng.randint(10, 40)):
        n = rng.randint(1, 4)
        regions = []
        for _ in range(n):
            row = rng.randrange(rows)
            s = rng.randrange(cols)
            e = rng.randrange(s + 1, cols + 1)
            regions.append((row, s, e, rng.randrange(256)))
        base = rng.choice([0, max(0, ref.rev - 1), ref.rev,
                           rng.randrange(0, ref.rev + 2)])

        ref_result = _safe_apply(ref, base, regions)
        try:
            got_result = repo.apply_patch(mask, base,
                                          _dedup_overlaps(regions))
        except BaseRevisionAhead:
            got_result = "ahead"
        except PatchConflict as exc:
            got_result = exc

        if isinstance(ref_result, PatchConflict):
            assert isinstance(got_result, PatchConflict)
            assert got_result.current_rev == ref_result.current_rev
            assert got_result.regions == ref_result.regions
        elif ref_result == "ahead":
            assert got_result == "ahead"
        else:
            assert got_result == ref_result

        # In every outcome state must agree.
        assert mask.rev == ref.rev
        _, label_rle = mask.snapshot()
        assert flatten_rle(label_rle, cols) == ref.labels
        assert flatten_rle(mask.touch_rle, cols) == ref.touched


def _safe_apply(ref, base, regions):
    if base > ref.rev:
        return "ahead"
    # Reference assumes within-patch non-overlap; dedup exactly like the API
    # guarantee (the repository trusts callers not to overlap).
    return ref.apply(base, _dedup_overlaps(regions))


def _dedup_overlaps(regions):
    by_row = {}
    for row, s, e, label in regions:
        by_row.setdefault(row, []).append((s, e, label))
    kept = []
    for row, ints in by_row.items():
        ints.sort()
        busy_until = 0
        for s, e, label in ints:
            if s >= busy_until:
                kept.append((row, s, e, label))
                busy_until = e
    return kept


def test_concurrent_random_patches_match_reference():
    """Fire many threads; every accepted result must survive in final state."""
    rows, cols = 2, 60
    repo = Repository()
    mask = repo.create("c", rows, cols)
    accepted = {r: [] for r in range(rows)}  # (s,e,label) applied per row
    lock = threading.Lock()

    def worker(i):
        row = i % rows
        s = (i // rows) * 6
        if s + 3 > cols:
            return
        try:
            repo.apply_patch(mask, 0, [(row, s, s + 3, (i % 255) + 1)])
        except PatchConflict:
            return
        with lock:
            accepted[row].append((s, s + 3, (i % 255) + 1))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(200)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    _, rle = mask.snapshot()
    flat = flatten_rle(rle, cols)
    for row, paints in accepted.items():
        # Apply accepted paints in revision order unknown here; instead verify
        # every pixel equals the label of one of the paints covering it.
        for s, e, label in paints:
            for c in range(s, e):
                assert flat[row][c] == label
