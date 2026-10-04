'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { handleCreate, handlePatch, handleGet } = require('../src/service');

function uniqueId(prefix = 'm') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

async function create(rows = 4, cols = 8, id = uniqueId()) {
  const result = await handleCreate({ type: 'create', maskId: id, rows, cols });
  assert.equal(result.status, 201);
  return id;
}

async function patch(id, baseRevision, intervals) {
  return handlePatch({ type: 'patch', maskId: id, baseRevision, intervals });
}

test('creating a mask yields an all-zero mask at revision 0', async () => {
  const id = await create(2, 3);
  const result = await handleGet(id);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    maskId: id,
    rows: 2,
    cols: 3,
    revision: 0,
    runs: [
      [{ start: 0, length: 3, label: 0 }],
      [{ start: 0, length: 3, label: 0 }]
    ]
  });
});

test('duplicate create returns 409 and leaves the existing mask untouched', async () => {
  const id = await create(1, 4);
  await patch(id, 0, [{ row: 0, start: 0, end: 2, label: 3 }]);

  const dup = await handleCreate({ type: 'create', maskId: id, rows: 9, cols: 9 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'MASK_ALREADY_EXISTS');
  assert.equal(dup.body.currentRevision, 1);

  const fetched = await handleGet(id);
  assert.equal(fetched.body.rows, 1);
  assert.equal(fetched.body.cols, 4);
  assert.equal(fetched.body.revision, 1);
});

test('successful patches merge and produce consecutive revisions', async () => {
  const id = await create(1, 8);
  const r1 = await patch(id, 0, [{ row: 0, start: 0, end: 3, label: 10 }]);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.revision, 1);

  // Disjoint patch based on the original revision merges onto the latest mask.
  const r2 = await patch(id, 0, [{ row: 0, start: 3, end: 6, label: 20 }]);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.revision, 2);

  const fetched = await handleGet(id);
  assert.deepEqual(fetched.body.runs, [
    [
      { start: 0, length: 3, label: 10 },
      { start: 3, length: 3, label: 20 },
      { start: 6, length: 2, label: 0 }
    ]
  ]);
});

test('stale base touching a pixel committed later is rejected with 409 and merged conflicts', async () => {
  const id = await create(2, 8);
  await patch(id, 0, [{ row: 0, start: 2, end: 5, label: 1 }]);

  // Two overlapping fragments in the request and one committed fragment:
  // conflict output is sorted by row and merged across the adjacent fragments.
  const conflict = await patch(id, 0, [
    { row: 0, start: 0, end: 3, label: 2 },
    { row: 0, start: 3, end: 6, label: 2 },
    { row: 1, start: 0, end: 8, label: 3 }
  ]);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'PATCH_CONFLICT');
  assert.equal(conflict.body.currentRevision, 1);
  assert.equal(conflict.body.baseRevision, 0);
  assert.deepEqual(conflict.body.conflicts, [{ row: 0, start: 2, end: 5 }]);

  // Rejected patch created no revision and changed no pixels.
  const fetched = await handleGet(id);
  assert.equal(fetched.body.revision, 1);
  assert.deepEqual(fetched.body.runs[1], [{ start: 0, length: 8, label: 0 }]);
});

test('conflict semantics are relative to the base revision, not the current one', async () => {
  const id = await create(1, 8);
  await patch(id, 0, [{ row: 0, start: 0, end: 2, label: 1 }]); // rev 1
  await patch(id, 1, [{ row: 0, start: 2, end: 4, label: 2 }]); // rev 2

  // Base 1: revision-1 area is known to the client; only rev-2 area conflicts.
  const result = await patch(id, 1, [{ row: 0, start: 0, end: 4, label: 9 }]);
  assert.equal(result.status, 409);
  assert.deepEqual(result.body.conflicts, [{ row: 0, start: 2, end: 4 }]);

  // Base 2 at the current revision over untouched pixels succeeds.
  const ok = await patch(id, 2, [{ row: 0, start: 4, end: 8, label: 3 }]);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.revision, 3);
});

test('patching an unknown mask returns 404', async () => {
  await assert.rejects(patch(uniqueId('missing'), 0, [{ row: 0, start: 0, end: 1, label: 1 }]), {
    statusCode: 404
  });
});

test('base revision ahead of current is a validation error', async () => {
  const id = await create(1, 2);
  await assert.rejects(patch(id, 5, [{ row: 0, start: 0, end: 1, label: 1 }]), {
    statusCode: 400
  });
  const fetched = await handleGet(id);
  assert.equal(fetched.body.revision, 0);
});

test('concurrent disjoint patches are all accepted with no lost updates', async () => {
  const id = await create(1, 20);
  const tasks = [];
  for (let c = 0; c < 10; c += 1) {
    tasks.push(
      patch(id, 0, [{ row: 0, start: c * 2, end: c * 2 + 2, label: c + 1 }])
    );
  }
  const results = await Promise.all(tasks);
  for (const result of results) {
    assert.equal(result.status, 200);
  }
  const revisions = results.map((r) => r.body.revision).sort((a, b) => a - b);
  assert.deepEqual(revisions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const fetched = await handleGet(id);
  assert.equal(fetched.body.revision, 10);
  for (let c = 0; c < 10; c += 1) {
    const run = fetched.body.runs[0].find((r) => r.start === c * 2);
    assert.equal(run.length, 2);
    assert.equal(run.label, c + 1);
  }
});

test('concurrent patches touching the same pixel: exactly one wins, others see conflicts', async () => {
  const id = await create(1, 4);
  const interval = [{ row: 0, start: 0, end: 4, label: 7 }];
  const results = await Promise.all([patch(id, 0, interval), patch(id, 0, interval), patch(id, 0, interval)]);
  const accepted = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.status === 409);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 2);
  for (const r of rejected) {
    assert.equal(r.body.currentRevision, 1);
    assert.deepEqual(r.body.conflicts, [{ row: 0, start: 0, end: 4 }]);
  }
  const fetched = await handleGet(id);
  assert.equal(fetched.body.revision, 1);
});
