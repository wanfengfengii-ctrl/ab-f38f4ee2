'use strict';

// In-memory storage of masks and serialization primitives.
// Each mask has an async mutex so every create/merge/read is atomic;
// this guarantees concurrent submissions cannot lose updates.

function createMutex() {
  let tail = Promise.resolve();
  return function withLock(task) {
    const run = tail.then(() => task());
    // Keep the chain alive regardless of the previous task's outcome.
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

const masks = new Map(); // maskId -> mask

function createMask(id, rows, cols) {
  const mask = {
    id,
    rows,
    cols,
    revision: 0,
    labels: new Uint8Array(rows * cols),
    // touchedAt[p] is the revision that last wrote pixel p (0 = never).
    touchedAt: new Uint32Array(rows * cols),
    mutex: createMutex()
  };
  masks.set(id, mask);
  return mask;
}

function getMask(id) {
  return masks.get(id);
}

module.exports = { createMask, getMask };
