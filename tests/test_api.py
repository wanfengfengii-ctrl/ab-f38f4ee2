"""End-to-end HTTP tests using FastAPI's in-process ASGI client."""

from __future__ import annotations

import threading

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def teardown_module(_module):
    client.close()


def create(mid="http-mask", rows=4, cols=12):
    return client.post("/api/masks/events", json={
        "type": "create", "maskId": mid, "rows": rows, "cols": cols})


def test_create_then_get_returns_zero_rle():
    r = create("m-create")
    assert r.status_code == 201, r.text
    assert r.json()["rev"] == 0
    g = client.get("/api/masks/m-create")
    body = g.json()
    assert body["rows"] == 4 and body["cols"] == 12
    assert body["currentRev"] == 0
    assert body["rle"] == [[{"startCol": 0, "endCol": 12, "label": 0}]
                           for _ in range(4)]


def test_duplicate_create_is_observable_conflict():
    create("m-dup", rows=2, cols=2)
    r = client.post("/api/masks/events", json={
        "type": "create", "maskId": "m-dup", "rows": 9, "cols": 9})
    assert r.status_code == 409
    assert r.json()["error"] == "mask_already_exists"
    # Dimensions of the original survive: the duplicate did nothing.
    g = client.get("/api/masks/m-dup").json()
    assert (g["rows"], g["cols"]) == (2, 2)


def test_patch_happy_path_and_normalised_rle():
    create("m-patch", rows=2, cols=10)
    r = client.post("/api/masks/events", json={
        "type": "patch", "maskId": "m-patch", "baseRev": 0,
        "regions": [{"row": 0, "startCol": 2, "endCol": 5, "label": 100}]})
    assert r.status_code == 200, r.text
    assert r.json()["rev"] == 1
    body = client.get("/api/masks/m-patch").json()
    assert body["rle"][0] == [
        {"startCol": 0, "endCol": 2, "label": 0},
        {"startCol": 2, "endCol": 5, "label": 100},
        {"startCol": 5, "endCol": 10, "label": 0}]


def test_stale_base_disjoint_region_merges():
    create("m-stale", rows=1, cols=10)
    client.post("/api/masks/events", json={
        "type": "patch", "maskId": "m-stale", "baseRev": 0,
        "regions": [{"row": 0, "startCol": 0, "endCol": 3, "label": 1}]})
    r = client.post("/api/masks/events", json={
        "type": "patch", "maskId": "m-stale", "baseRev": 0,
        "regions": [{"row": 0, "startCol": 7, "endCol": 10, "label": 2}]})
    assert r.status_code == 200
    assert r.json()["rev"] == 2


def test_conflict_returns_409_with_current_rev_and_merged_intervals():
    create("m-conf", rows=2, cols=10)
    client.post("/api/masks/events", json={
        "type": "patch", "maskId": "m-conf", "baseRev": 0,
        "regions": [{"row": 1, "startCol": 2, "endCol": 6, "label": 1}]})
    r = client.post("/api/masks/events", json={
        "type": "patch", "maskId": "m-conf", "baseRev": 0,
        "regions": [
            {"row": 1, "startCol": 0, "endCol": 3, "label": 9},
            {"row": 1, "startCol": 5, "endCol": 8, "label": 9}]})
    assert r.status_code == 409
    body = r.json()
    assert body["currentRev"] == 1
    # [0,3)∩[2,6)=[2,3) and [5,8)∩[2,6)=[5,6); gap [3,5) is not targeted.
    assert body["conflicts"] == [
        {"row": 1, "startCol": 2, "endCol": 3},
        {"row": 1, "startCol": 5, "endCol": 6}]
    # No new revision was created by the rejected patch.
    assert client.get("/api/masks/m-conf").json()["currentRev"] == 1


def test_partial_overlap_conflict_changes_nothing():
    create("m-partial", rows=1, cols=8)
    client.post("/api/masks/events", json={
        "type": "patch", "maskId": "m-partial", "baseRev": 0,
        "regions": [{"row": 0, "startCol": 0, "endCol": 2, "label": 7}]})
    r = client.post("/api/masks/events", json={
        "type": "patch", "maskId": "m-partial", "baseRev": 0,
        "regions": [
            {"row": 0, "startCol": 1, "endCol": 3, "label": 8},
            {"row": 0, "startCol": 5, "endCol": 7, "label": 8}]})
    assert r.status_code == 409
    rle = client.get("/api/masks/m-partial").json()["rle"][0]
    # The disjoint second region must NOT be applied (atomicity).
    assert rle == [{"startCol": 0, "endCol": 2, "label": 7},
                   {"startCol": 2, "endCol": 8, "label": 0}]


def test_invalid_requests_are_400_without_revision():
    create("m-invalid", rows=2, cols=5)
    bad_bodies = [
        {"type": "patch", "maskId": "m-invalid", "baseRev": 0,
         "regions": [{"row": 0, "startCol": 2, "endCol": 2, "label": 1}]},
        {"type": "patch", "maskId": "m-invalid", "baseRev": 0,
         "regions": [{"row": 0, "startCol": 0, "endCol": 9, "label": 1}]},
        {"type": "patch", "maskId": "m-invalid", "baseRev": 0,
         "regions": [{"row": 7, "startCol": 0, "endCol": 1, "label": 1}]},
        {"type": "patch", "maskId": "m-invalid", "baseRev": 0,
         "regions": [{"row": 0, "startCol": 0, "endCol": 4, "label": 256}]},
        {"type": "patch", "maskId": "m-invalid", "baseRev": 0,
         "regions": [
             {"row": 0, "startCol": 0, "endCol": 3, "label": 1},
             {"row": 0, "startCol": 2, "endCol": 4, "label": 1}]},
        {"type": "create", "maskId": "m-invalid", "rows": 0, "cols": 5},
        {"type": "create", "maskId": "x", "rows": 1},
        {"nope": True},
    ]
    for body in bad_bodies:
        r = client.post("/api/masks/events", json=body)
        assert r.status_code == 400, body
    assert client.get("/api/masks/m-invalid").json()["currentRev"] == 0


def test_malformed_json_is_400():
    r = client.post("/api/masks/events",
                    content="{not json",
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 400
    r = client.post("/api/masks/events", json=[1, 2, 3])
    assert r.status_code == 400


def test_patch_unknown_mask_is_404():
    r = client.post("/api/masks/events", json={
        "type": "patch", "maskId": "ghost", "baseRev": 0, "regions": []})
    assert r.status_code == 404
    assert client.get("/api/masks/ghost").status_code == 404


def test_future_base_rev_is_rejected():
    create("m-future")
    r = client.post("/api/masks/events", json={
        "type": "patch", "maskId": "m-future", "baseRev": 50,
        "regions": [{"row": 0, "startCol": 0, "endCol": 1, "label": 1}]})
    assert r.status_code == 422
    assert r.json()["currentRev"] == 0


def test_concurrent_disjoint_http_patches_all_land():
    create("m-concurrent", rows=1, cols=20)
    results: list[int] = []

    def worker(i: int) -> None:
        r = client.post("/api/masks/events", json={
            "type": "patch", "maskId": "m-concurrent", "baseRev": 0,
            "regions": [{"row": 0, "startCol": i * 2,
                         "endCol": i * 2 + 2, "label": i + 1}]})
        results.append(r.status_code)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results == [200] * 10
    body = client.get("/api/masks/m-concurrent").json()
    assert body["currentRev"] == 10
    assert body["rle"][0] == [
        {"startCol": i * 2, "endCol": i * 2 + 2, "label": i + 1}
        for i in range(10)]
