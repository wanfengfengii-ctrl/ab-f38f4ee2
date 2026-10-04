'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createServer } = require('../src/server');

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function request(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

function uniqueId() {
  return `http-${crypto.randomBytes(6).toString('hex')}`;
}

test('GET /health reports ok', async () => {
  await withServer(async (base) => {
    const res = await request(base, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });
});

test('full create, patch, conflict and fetch flow over HTTP', async () => {
  await withServer(async (base) => {
    const id = uniqueId();

    const created = await request(base, 'POST', '/api/masks/events', {
      type: 'create',
      maskId: id,
      rows: 2,
      cols: 6
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.revision, 0);

    const dup = await request(base, 'POST', '/api/masks/events', {
      type: 'create',
      maskId: id,
      rows: 2,
      cols: 6
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'MASK_ALREADY_EXISTS');

    const first = await request(base, 'POST', '/api/masks/events', {
      type: 'patch',
      maskId: id,
      baseRevision: 0,
      intervals: [{ row: 0, start: 1, end: 4, label: 11 }]
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 1);

    // Stale, overlapping: 409 with current revision and merged conflict ranges.
    const conflict = await request(base, 'POST', '/api/masks/events', {
      type: 'patch',
      maskId: id,
      baseRevision: 0,
      intervals: [
        { row: 0, start: 0, end: 2, label: 5 },
        { row: 0, start: 2, end: 6, label: 5 },
        { row: 1, start: 0, end: 3, label: 9 }
      ]
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.currentRevision, 1);
    assert.deepEqual(conflict.body.conflicts, [{ row: 0, start: 1, end: 4 }]);

    // Stale but fully disjoint: merges atomically onto the latest mask.
    const disjoint = await request(base, 'POST', '/api/masks/events', {
      type: 'patch',
      maskId: id,
      baseRevision: 0,
      intervals: [{ row: 1, start: 2, end: 6, label: 77 }]
    });
    assert.equal(disjoint.status, 200);
    assert.equal(disjoint.body.revision, 2);

    const fetched = await request(base, 'GET', `/api/masks/${encodeURIComponent(id)}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.revision, 2);
    assert.equal(fetched.body.rows, 2);
    assert.equal(fetched.body.cols, 6);
    assert.deepEqual(fetched.body.runs, [
      [
        { start: 0, length: 1, label: 0 },
        { start: 1, length: 3, label: 11 },
        { start: 4, length: 2, label: 0 }
      ],
      [
        { start: 0, length: 2, label: 0 },
        { start: 2, length: 4, label: 77 }
      ]
    ]);
  });
});

test('invalid payloads return 400 and do not create revisions', async () => {
  await withServer(async (base) => {
    const id = uniqueId();
    await request(base, 'POST', '/api/masks/events', { type: 'create', maskId: id, rows: 1, cols: 4 });

    const badLabel = await request(base, 'POST', '/api/masks/events', {
      type: 'patch',
      maskId: id,
      baseRevision: 0,
      intervals: [{ row: 0, start: 0, end: 2, label: 999 }]
    });
    assert.equal(badLabel.status, 400);

    const overlap = await request(base, 'POST', '/api/masks/events', {
      type: 'patch',
      maskId: id,
      baseRevision: 0,
      intervals: [
        { row: 0, start: 0, end: 3, label: 1 },
        { row: 0, start: 2, end: 4, label: 1 }
      ]
    });
    assert.equal(overlap.status, 400);

    const malformed = await request(base, 'POST', '/api/masks/events', { type: 'wat' });
    assert.equal(malformed.status, 400);

    const fetched = await request(base, 'GET', `/api/masks/${id}`);
    assert.equal(fetched.body.revision, 0);
  });
});

test('malformed JSON and unknown routes are handled', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/masks/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json'
    });
    assert.equal(res.status, 400);

    const missing = await request(base, 'GET', '/api/masks/does-not-exist');
    assert.equal(missing.status, 404);

    const noRoute = await request(base, 'DELETE', '/api/masks/x');
    assert.equal(noRoute.status, 404);
  });
});

test('concurrent HTTP patches preserve every successful disjoint write', async () => {
  await withServer(async (base) => {
    const id = uniqueId();
    await request(base, 'POST', '/api/masks/events', { type: 'create', maskId: id, rows: 1, cols: 30 });

    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, c) =>
        request(base, 'POST', '/api/masks/events', {
          type: 'patch',
          maskId: id,
          baseRevision: 0,
          intervals: [{ row: 0, start: c * 2, end: c * 2 + 2, label: (c % 255) + 1 }]
        })
      )
    );
    assert.equal(responses.every((r) => r.status === 200), true);

    const fetched = await request(base, 'GET', `/api/masks/${id}`);
    assert.equal(fetched.body.revision, 15);
    // All 30 pixels covered by successful patches.
    const totalLength = fetched.body.runs[0].reduce((sum, run) => sum + run.length, 0);
    assert.equal(totalLength, 30);
  });
});
