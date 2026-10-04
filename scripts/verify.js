'use strict';

// One-shot verification entrypoint used by the `verify` compose service.
// Runs, in order:
//   1. code tests   (node --test)
//   2. build check  (every source file parses and loads without error)
//   3. smoke test   (disjoint-patch merge against a freshly spawned server)
// Exits 0 only if every stage passes; the first failure stops the run.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

function run(label, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${label} ===`);
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...options.env }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        console.log(`--- ${label}: PASS`);
        resolve();
      } else {
        reject(new Error(`${label} failed with exit code ${code}`));
      }
    });
  });
}

function listJsFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listJsFiles(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
}

async function buildCheck() {
  console.log('\n=== build check ===');
  // Source modules must parse AND load (which also resolves all requires).
  for (const file of listJsFiles(path.join(ROOT, 'src'))) {
    require(file);
    console.log(`loaded src/${path.relative(path.join(ROOT, 'src'), file)}`);
  }
  // Scripts are entrypoints: verify syntax only so requiring them cannot
  // trigger their side effects (spawning a server, recursive verify, ...).
  const { execFileSync } = require('node:child_process');
  for (const file of listJsFiles(path.join(ROOT, 'scripts'))) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    console.log(`syntax-ok scripts/${path.relative(path.join(ROOT, 'scripts'), file)}`);
  }
  console.log('--- build check: PASS');
}

async function main() {
  try {
    await run('code tests', ['--test']);
    await buildCheck();
    await run('disjoint-patch merge smoke', [path.join(ROOT, 'scripts', 'smoke.js')]);
    console.log('\nVERIFY: ALL STAGES PASSED');
    process.exit(0);
  } catch (err) {
    console.error(`\nVERIFY FAILED: ${err.message}`);
    process.exit(1);
  }
}

main();
