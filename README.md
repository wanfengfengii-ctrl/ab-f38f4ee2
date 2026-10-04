# Mask Collaboration Service

A service for collaborative pixel-mask annotation. Multiple annotators revise
the same mask in parallel; **disjoint** edits merge automatically, while an
edit that would overwrite a region already confirmed by someone else is
rejected atomically.

Zero runtime dependencies — Node.js 22+ only (built-in HTTP server and test
runner).

## API

### `POST /api/masks/events`

Create an all-zero mask:

```json
{ "type": "create", "maskId": "slide-42", "rows": 100, "cols": 200 }
```

- `201` — created at revision `0`.
- `409` `MASK_ALREADY_EXISTS` — the id already exists; the response carries
  `currentRevision` so the collision is observable. Existing data is never
  overwritten.

Submit a patch referencing a base revision:

```json
{
  "type": "patch",
  "maskId": "slide-42",
  "baseRevision": 3,
  "intervals": [
    { "row": 0, "start": 10, "end": 30, "label": 7 }
  ]
}
```

- Intervals are **half-open** `[start, end)` column ranges within a row.
- `label` is an integer in `[0, 255]`.
- Intervals within one patch must not overlap (adjacent ranges are allowed).

Merging rules:

- If the patch touches **only pixels never written by a successful patch after
  `baseRevision`**, it is applied atomically on the *latest* mask and a new
  **consecutive** revision is returned — even when `baseRevision` is behind the
  current revision.
- If any target pixel was touched by a successful patch with revision greater
  than `baseRevision`, the **whole patch is rejected**: `409 PATCH_CONFLICT`
  with `currentRevision` and `conflicts`, a list sorted by row (then start) of
  merged half-open conflict ranges. No pixel changes and no revision is
  created.
- Malformed requests return `400` and never create revisions.

### `GET /api/masks/{maskId}`

Returns dimensions, current revision and normalized per-row run-length
encoding covering every pixel:

```json
{
  "maskId": "slide-42",
  "rows": 1,
  "cols": 6,
  "revision": 2,
  "runs": [
    [
      { "start": 0, "length": 2, "label": 0 },
      { "start": 2, "length": 4, "label": 7 }
    ]
  ]
}
```

Adjacent runs with the same label are collapsed, so concatenating a row's runs
always reproduces exactly `cols` pixels.

### `GET /health`

Liveness probe — `200 {"status":"ok"}`.

## Concurrency model

Every operation on a mask is serialized by a per-mask async mutex, making the
"detect conflicts → write pixels → bump revision" sequence atomic. Each pixel
records the revision that last touched it; conflict detection compares that
stamp against the request's `baseRevision`. Concurrent disjoint patches all
succeed with consecutive revisions (no lost updates); concurrent patches on
the same pixel leave exactly one winner, the rest receive `409`.

Storage is in-memory (the service is delivered as an empty repository; restart
resets state).

## Run locally

```bash
npm start                 # http://localhost:3000 (override with PORT)
npm test                  # unit + HTTP integration tests
npm run smoke             # spawns a server and runs the merge smoke test
npm run verify            # tests + build check + smoke, exit code reports result
```

## Docker

The host port is configured with the `APP_PORT` environment variable
(defaults to 3000):

```bash
APP_PORT=8080 docker compose up -d --build app
```

The one-shot `verify` service waits until the app is healthy, then runs code
tests, the build/load check and the disjoint-patch merge smoke test against the
running container, and exits with a status code reporting the result:

```bash
docker compose up --build verify   # exits 0 on success, non-zero on failure
```
