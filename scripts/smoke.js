'use strict';

// End-to-end smoke test of disjoint-patch merging against a running server.
// MASK_BASE_URL selects the target; when unset a local server is spawned on an
// ephemeral port (used by `npm run smoke`). Exits non-zero on any failure.

const { spawn } = require('node:child_process');
const path = require('node:path');

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function req(base, method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function waitForHealth(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`server did not become healthy at ${base}: ${lastError && lastError.message}`);
}

async function runSmoke(base) {
  const id = `smoke-${Date.now()}`;

  const created = await req(base, 'POST', '/api/masks/events', {
    type: 'create',
    maskId: id,
    rows: 3,
    cols: 10
  });
  assert(created.status === 201, `create expected 201 got ${created.status}`);
  assert(created.body.revision === 0, 'new mask should be at revision 0');

  const dup = await req(base, 'POST', '/api/masks/events', {
    type: 'create',
    maskId: id,
    rows: 3,
    cols: 10
  });
  assert(dup.status === 409, `duplicate create expected 409 got ${dup.status}`);
  assert(dup.body.error === 'MASK_ALREADY_EXISTS', 'duplicate create should be observable');

  const p1 = await req(base, 'POST', '/api/masks/events', {
    type: 'patch',
    maskId: id,
    baseRevision: 0,
    intervals: [{ row: 0, start: 0, end: 3, label: 10 }]
  });
  assert(p1.status === 200 && p1.body.revision === 1, `patch1 failed: ${JSON.stringify(p1.body)}`);

  // Stale base (0 while current is 1) but fully disjoint: must merge.
  const p2 = await req(base, 'POST', '/api/masks/events', {
    type: 'patch',
    maskId: id,
    baseRevision: 0,
    intervals: [
      { row: 0, start: 3, end: 6, label: 20 },
      { row: 1, start: 0, end: 5, label: 30 }
    ]
  });
  assert(p2.status === 200 && p2.body.revision === 2, `disjoint stale patch failed: ${JSON.stringify(p2.body)}`);

  // Another disjoint writer, still based on revision 0, lands as revision 3.
  const p3 = await req(base, 'POST', '/api/masks/events', {
    type: 'patch',
    maskId: id,
    baseRevision: 0,
    intervals: [{ row: 2, start: 2, end: 9, label: 40 }]
  });
  assert(p3.status === 200 && p3.body.revision === 3, `patch3 failed: ${JSON.stringify(p3.body)}`);

  // Overlapping stale patch: whole request rejected, no revision created.
  const conflict = await req(base, 'POST', '/api/masks/events', {
    type: 'patch',
    maskId: id,
    baseRevision: 0,
    intervals: [{ row: 0, start: 2, end: 4, label: 99 }]
  });
  assert(conflict.status === 409, `conflict expected 409 got ${conflict.status}`);
  assert(conflict.body.currentRevision === 3, 'conflict must report current revision 3');
  assert(
    JSON.stringify(conflict.body.conflicts) === JSON.stringify([{ row: 0, start: 2, end: 4 }]),
    `unexpected conflict ranges: ${JSON.stringify(conflict.body.conflicts)}`
  );

  const fetched = await req(base, 'GET', `/api/masks/${id}`);
  assert(fetched.status === 200, 'GET expected 200');
  assert(fetched.body.revision === 3, 'rejected patch must not create a revision');

  const expected = [
    [10, 10, 10, 20, 20, 20, 0, 0, 0, 0],
    [30, 30, 30, 30, 30, 0, 0, 0, 0, 0],
    [0, 0, 40, 40, 40, 40, 40, 40, 40, 0]
  ];
  // Reconstruct the pixel matrix from the normalized RLE and compare.
  for (let r = 0; r < 3; r += 1) {
    const pixels = new Array(10).fill(0);
    for (const run of fetched.body.runs[r]) {
      for (let p = run.start; p < run.start + run.length; p += 1) pixels[p] = run.label;
    }
    assert(
      JSON.stringify(pixels) === JSON.stringify(expected[r]),
      `row ${r} mismatch: ${JSON.stringify(pixels)} != ${JSON.stringify(expected[r])}`
    );
  }

  console.log('smoke: disjoint merge, conflict rejection and RLE fetch all verified');
}

function spawnServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let settled = false;
    child.stdout.on('data', (chunk) => {
      const match = /listening on port (\d+)/.exec(chunk.toString());
      if (match && !settled) {
        settled = true;
        resolve({ child, base: `http://127.0.0.1:${match[1]}` });
      }
    });
    child.on('error', (err) => {
      if (!settled) reject(err);
    });
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`server exited early with code ${code}`));
    });
  });
}

async function main() {
  const givenBase = process.env.MASK_BASE_URL;
  let spawned = null;
  let base = givenBase;
  if (!base) {
    spawned = await spawnServer();
    base = spawned.base;
  }
  await waitForHealth(base);
  await runSmoke(base);
  if (spawned) spawned.child.kill();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
