'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCreateEvent,
  validatePatchEvent,
  validateIntervalBounds,
  detectConflicts,
  mergeRanges,
  applyPatch,
  encodeRLE
} = require('../src/logic');
const { createMask } = require('../src/store');

test('validateCreateEvent accepts sane input', () => {
  assert.deepEqual(validateCreateEvent({ type: 'create', maskId: 'm', rows: 2, cols: 3 }), {
    maskId: 'm',
    rows: 2,
    cols: 3
  });
});

test('validateCreateEvent rejects bad dimensions and ids', () => {
  assert.throws(() => validateCreateEvent({ type: 'create', maskId: 'm', rows: 0, cols: 3 }));
  assert.throws(() => validateCreateEvent({ type: 'create', maskId: 'm', rows: 2, cols: -1 }));
  assert.throws(() => validateCreateEvent({ type: 'create', maskId: 'm', rows: 1.5, cols: 3 }));
  assert.throws(() => validateCreateEvent({ type: 'create', maskId: '', rows: 2, cols: 3 }));
  assert.throws(() => validateCreateEvent({ type: 'patch', maskId: 'm', rows: 2, cols: 3 }));
});

test('validatePatchEvent sorts intervals and allows adjacent ranges', () => {
  const event = validatePatchEvent({
    type: 'patch',
    maskId: 'm',
    baseRevision: 0,
    intervals: [
      { row: 1, start: 0, end: 2, label: 5 },
      { row: 0, start: 3, end: 5, label: 6 },
      { row: 0, start: 5, end: 7, label: 7 }
    ]
  });
  assert.deepEqual(
    event.intervals.map((i) => [i.row, i.start, i.end]),
    [[0, 3, 5], [0, 5, 7], [1, 0, 2]]
  );
});

test('validatePatchEvent rejects overlapping ranges in one patch', () => {
  assert.throws(() =>
    validatePatchEvent({
      type: 'patch',
      maskId: 'm',
      baseRevision: 0,
      intervals: [
        { row: 0, start: 0, end: 3, label: 1 },
        { row: 0, start: 2, end: 5, label: 2 }
      ]
    })
  );
  // Same pixel range across rows is fine.
  assert.doesNotThrow(() =>
    validatePatchEvent({
      type: 'patch',
      maskId: 'm',
      baseRevision: 0,
      intervals: [
        { row: 0, start: 0, end: 3, label: 1 },
        { row: 1, start: 0, end: 3, label: 2 }
      ]
    })
  );
});

test('validatePatchEvent rejects malformed payloads', () => {
  const good = { row: 0, start: 0, end: 1, label: 1 };
  assert.throws(() => validatePatchEvent({ type: 'patch', maskId: 'm', baseRevision: -1, intervals: [good] }));
  assert.throws(() => validatePatchEvent({ type: 'patch', maskId: 'm', baseRevision: 0, intervals: [] }));
  assert.throws(() =>
    validatePatchEvent({ type: 'patch', maskId: 'm', baseRevision: 0, intervals: [{ ...good, label: 256 }] })
  );
  assert.throws(() =>
    validatePatchEvent({ type: 'patch', maskId: 'm', baseRevision: 0, intervals: [{ ...good, start: 1, end: 1 }] })
  );
  assert.throws(() =>
    validatePatchEvent({ type: 'patch', maskId: 'm', baseRevision: 0, intervals: [{ ...good, end: 2, start: 3 }] })
  );
});

test('validateIntervalBounds enforces mask dimensions', () => {
  assert.throws(() => validateIntervalBounds([{ row: 3, start: 0, end: 1 }], 2, 5));
  assert.throws(() => validateIntervalBounds([{ row: 0, start: 0, end: 6 }], 2, 5));
  assert.doesNotThrow(() => validateIntervalBounds([{ row: 1, start: 4, end: 5 }], 2, 5));
});

test('mergeRanges sorts by row and unions overlapping/adjacent ranges', () => {
  assert.deepEqual(
    mergeRanges([
      { row: 1, start: 4, end: 6 },
      { row: 0, start: 2, end: 4 },
      { row: 0, start: 7, end: 9 },
      { row: 0, start: 3, end: 8 }
    ]),
    [
      { row: 0, start: 2, end: 9 },
      { row: 1, start: 4, end: 6 }
    ]
  );
});

test('detectConflicts only flags pixels touched strictly after the base revision', () => {
  const mask = createMask('m', 2, 8);
  applyPatch(mask, [{ row: 0, start: 2, end: 6, label: 9 }], 1);
  applyPatch(mask, [{ row: 1, start: 0, end: 3, label: 8 }], 2);

  // Base 0: everything written so far conflicts.
  assert.deepEqual(
    detectConflicts(mask, [{ row: 0, start: 0, end: 8 }, { row: 1, start: 0, end: 8 }], 0),
    [
      { row: 0, start: 2, end: 6 },
      { row: 1, start: 0, end: 3 }
    ]
  );

  // Base 1: revision-1 writes are part of the base state; only rev 2 shows up.
  assert.deepEqual(detectConflicts(mask, [{ row: 0, start: 0, end: 8 }, { row: 1, start: 0, end: 8 }], 1), [
    { row: 1, start: 0, end: 3 }
  ]);

  // Base 2 (current): no conflicts anywhere.
  assert.deepEqual(detectConflicts(mask, [{ row: 0, start: 0, end: 8 }], 2), []);
});

test('encodeRLE produces full-coverage normalized runs per row', () => {
  const mask = createMask('m', 2, 4);
  applyPatch(mask, [{ row: 0, start: 1, end: 3, label: 7 }], 1);
  assert.deepEqual(encodeRLE(mask), [
    [
      { start: 0, length: 1, label: 0 },
      { start: 1, length: 2, label: 7 },
      { start: 3, length: 1, label: 0 }
    ],
    [{ start: 0, length: 4, label: 0 }]
  ]);

  // Writing label 0 over background stays normalized (collapses into one run).
  applyPatch(mask, [{ row: 1, start: 0, end: 4, label: 0 }], 2);
  assert.deepEqual(encodeRLE(mask)[1], [{ start: 0, length: 4, label: 0 }]);
});
