"""One-shot verification job.

Runs inside the ``verify`` compose service after ``app`` reports healthy:

1. build check   -- the application package imports inside the built image
2. HTTP smoke    -- disjoint stale-base patches merge atomically, conflicts
                    stay atomic with merged row-sorted intervals, duplicate
                    creation is observable
3. exits 0 only when every check passed
"""

from __future__ import annotations

import os
import sys
import uuid

import httpx


def build_check() -> None:
    import app.main  # noqa: F401  -- import proves the image ships the app
    import uvicorn  # noqa: F401
    print("[verify] build check: application package imports OK")


def smoke(base_url: str) -> None:
    mid = f"verify-{uuid.uuid4().hex[:8]}"
    with httpx.Client(base_url=base_url, timeout=10) as http:
        # 1. create all-zero mask
        r = http.post("/api/masks/events", json={
            "type": "create", "maskId": mid, "rows": 2, "cols": 10})
        assert r.status_code == 201, r.text
        assert r.json()["rev"] == 0

        # 2. first patch at base rev 0
        r = http.post("/api/masks/events", json={
            "type": "patch", "maskId": mid, "baseRev": 0,
            "regions": [{"row": 0, "startCol": 0, "endCol": 5,
                         "label": 11}]})
        assert r.status_code == 200, r.text
        assert r.json()["rev"] == 1

        # 3. late, stale-base (rev 0) but fully disjoint patch must merge
        r = http.post("/api/masks/events", json={
            "type": "patch", "maskId": mid, "baseRev": 0,
            "regions": [{"row": 0, "startCol": 5, "endCol": 10,
                         "label": 22},
                        {"row": 1, "startCol": 2, "endCol": 8,
                         "label": 33}]})
        assert r.status_code == 200, r.text
        assert r.json()["rev"] == 2, r.text

        # 4. overlapping late patch: 409 + currentRev + merged intervals
        r = http.post("/api/masks/events", json={
            "type": "patch", "maskId": mid, "baseRev": 0,
            "regions": [{"row": 0, "startCol": 3, "endCol": 7,
                         "label": 99}]})
        assert r.status_code == 409, r.text
        body = r.json()
        assert body["currentRev"] == 2, body
        assert body["conflicts"] == [
            {"row": 0, "startCol": 3, "endCol": 7}], body

        # 5. rejected patch created no revision; both successes persist
        g = http.get(f"/api/masks/{mid}")
        assert g.status_code == 200
        got = g.json()
        assert got["currentRev"] == 2, got
        assert got["rle"][0] == [
            {"startCol": 0, "endCol": 5, "label": 11},
            {"startCol": 5, "endCol": 10, "label": 22}], got
        assert got["rle"][1] == [
            {"startCol": 0, "endCol": 2, "label": 0},
            {"startCol": 2, "endCol": 8, "label": 33},
            {"startCol": 8, "endCol": 10, "label": 0}], got

        # 6. duplicate creation is an observable conflict
        r = http.post("/api/masks/events", json={
            "type": "create", "maskId": mid, "rows": 9, "cols": 9})
        assert r.status_code == 409, r.text
        assert r.json()["error"] == "mask_already_exists"

    print("[verify] HTTP smoke: disjoint merge, conflict, duplicate-create OK")


def main() -> int:
    base_url = os.environ.get("APP_BASE_URL", "http://app:8000")
    print(f"[verify] checking application at {base_url}")
    try:
        build_check()
        smoke(base_url)
    except AssertionError as exc:
        print(f"[verify] FAILED: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"[verify] ERROR: {exc!r}", file=sys.stderr)
        return 2
    print("[verify] ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
