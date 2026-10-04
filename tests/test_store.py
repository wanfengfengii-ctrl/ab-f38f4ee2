"""Tests for the RLE primitives and the repository merge semantics."""

from __future__ import annotations

import threading

import pytest

from app.store import (
    BaseRevisionAhead,
    MaskAlreadyExists,
    PatchConflict,
    Repository,
    coalesce,
    conflict_pieces,
    merge_union,
    paint,
)


# ---------------------------------------------------------------- RLE ----

def test_coalesce_merges_adjacent_equal_runs():
    assert coalesce([(0, 2, 5), (2, 4, 5), (4, 6, 3)]) == [(0, 4, 5), (4, 6, 3)]


def test_coalesce_drops_empty_runs():
    assert coalesce([(3, 3, 9), (0, 3, 9)]) == [(0, 3, 9)]


def test_paint_simple_overlay():
    base = [(0, 10, 0)]
    assert paint(base, [(2, 5, 7), (7, 9, 3)], 10) == [
        (0, 2, 0), (2, 5, 7), (5, 7, 0), (7, 9, 3), (9, 10, 0)]


def test_paint_coalesces_same_label_as_background():
    # Painting the same value the pixels already hold must not split runs.
    base = [(0, 6, 4)]
    assert paint(base, [(1, 3, 4)], 6) == [(0, 6, 4)]


def test_paint_split_runs_in_middle():
    base = [(0, 4, 1), (4, 8, 2)]
    assert paint(base, [(2, 6, 9)], 8) == [
        (0, 2, 1), (2, 6, 9), (6, 8, 2)]


def test_conflict_pieces_only_reports_newer_touches():
    touched = [(0, 3, 1), (3, 7, 2), (7, 10, 3)]
    assert conflict_pieces(touched, 2, 9, base_rev=1) == [(3, 7), (7, 9)]
    assert conflict_pieces(touched, 0, 10, base_rev=2) == [(7, 10)]
    assert conflict_pieces(touched, 0, 3, base_rev=1) == []


def test_merge_union_sorts_and_joins_touching():
    assert merge_union([(5, 8), (1, 3), (3, 5), (9, 10)]) == [(1, 8), (9, 10)]
    assert merge_union([]) == []


# --------------------------------------------------------- repository ----

def make_repo_with_mask(mid="m", rows=3, cols=10):
    repo = Repository()
    return repo, repo.create(mid, rows, cols)


def test_create_and_duplicate_conflict():
    repo = Repository()
    repo.create("a", 2, 2)
    with pytest.raises(MaskAlreadyExists):
        repo.create("a", 5, 5)


def test_disjoint_patches_both_commit_on_stale_base():
    """The core requirement: base behind current rev is fine on untouched
    pixels, and the merge happens atomically on the *latest* mask."""
    repo, mask = make_repo_with_mask(cols=10)
    assert repo.apply_patch(mask, 0, [(0, 0, 4, 11)]) == 1
    # Base rev 0 is now stale, but columns 6..10 were never touched.
    assert repo.apply_patch(mask, 0, [(0, 6, 10, 22)]) == 2
    rev, rle = mask.snapshot()
    assert rev == 2
    assert rle[0] == [(0, 4, 11), (4, 6, 0), (6, 10, 22)]


def test_conflicting_stale_patch_returns_merged_sorted_regions():
    repo, mask = make_repo_with_mask(rows=3, cols=10)
    repo.apply_patch(mask, 0, [(0, 2, 6, 1), (2, 0, 4, 2), (1, 8, 10, 3)])
    with pytest.raises(PatchConflict) as info:
        repo.apply_patch(
            mask, 0,
            [(2, 1, 3, 9),   # overlaps rev-1 paint on row 2: [1,3) vs [0,4)
             (0, 0, 3, 9),   # overlaps [2,3) on row 0
             (0, 4, 8, 9),   # overlaps [4,6) on row 0 -> union [2,8)
             (1, 0, 2, 9)])  # no overlap on row 1
    assert info.value.current_rev == 1
    # Targeted conflicts only: [0,3)∩[2,6)=[2,3), [4,8)∩[2,6)=[4,6);
    # the gap [3,4) is touched but not targeted, so the runs stay separate.
    assert info.value.regions == [(0, 2, 3), (0, 4, 6), (2, 1, 3)]


def test_failed_conflict_creates_no_revision_and_changes_nothing():
    repo, mask = make_repo_with_mask(cols=10)
    repo.apply_patch(mask, 0, [(0, 0, 5, 7)])
    before = mask.snapshot()
    with pytest.raises(PatchConflict):
        repo.apply_patch(mask, 0, [(0, 3, 7, 9)])
    assert mask.snapshot() == before  # rev and pixels untouched


def test_patch_relative_to_latest_rev_always_checks_only_later_writes():
    repo, mask = make_repo_with_mask(cols=10)
    repo.apply_patch(mask, 0, [(0, 0, 4, 1)])  # rev 1
    repo.apply_patch(mask, 1, [(0, 4, 8, 2)])  # rev 2
    # Re-label one's own region using current rev: allowed.
    assert repo.apply_patch(mask, 2, [(0, 0, 2, 5)]) == 3
    rev, rle = mask.snapshot()
    assert rle[0] == [(0, 2, 5), (2, 4, 1), (4, 8, 2), (8, 10, 0)]


def test_base_revision_in_the_future_is_rejected():
    repo, mask = make_repo_with_mask()
    with pytest.raises(BaseRevisionAhead):
        repo.apply_patch(mask, 99, [(0, 0, 1, 1)])


def test_final_mask_retains_every_successful_patch():
    repo, mask = make_repo_with_mask(rows=2, cols=8)
    repo.apply_patch(mask, 0, [(0, 0, 3, 10)])
    repo.apply_patch(mask, 0, [(1, 2, 5, 20)])       # stale base, disjoint
    repo.apply_patch(mask, 1, [(0, 5, 8, 30)])       # relative to rev 1
    _, rle = mask.snapshot()
    assert rle[0] == [(0, 3, 10), (3, 5, 0), (5, 8, 30)]
    assert rle[1] == [(0, 2, 0), (2, 5, 20), (5, 8, 0)]


def test_concurrent_disjoint_patches_never_lose_updates():
    repo, mask = make_repo_with_mask(rows=1, cols=100)
    errors: list[Exception] = []

    def worker(i: int) -> None:
        try:
            repo.apply_patch(mask, 0, [(0, i * 10, (i + 1) * 10, i + 1)])
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert mask.rev == 10
    _, rle = mask.snapshot()
    assert rle[0] == [(i * 10, (i + 1) * 10, i + 1) for i in range(10)]
