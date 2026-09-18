#!/usr/bin/env node
// Native (C++) coverage for src/msgpack.cc.
//
// Rebuilds the addon with --coverage, runs the test suite against that
// instrumented binary, reports with gcovr, and then *always* rebuilds without
// the coverage variable so the working tree is left with a normal addon --
// even when the thresholds fail. The exit code is the gcovr/test result.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LINE_THRESHOLD = 95;
const BRANCH_THRESHOLD = 95;

function run(cmd, args, opts) {
  const label = [cmd].concat(args).join(' ');
  console.log('\n$ ' + label);
  const r = spawnSync(cmd, args, Object.assign({ cwd: ROOT, stdio: 'inherit' }, opts));
  if (r.error && r.error.code === 'ENOENT') {
    return { status: 127, missing: true };
  }
  return { status: r.status === null ? 1 : r.status, missing: false };
}

// npm puts its bundled node-gyp on PATH for lifecycle scripts, but this file
// is also runnable directly (`node scripts/coverage-native.js`), so fall back
// to a local install and then to npx.
const nodeGyp = process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp';
const localGyp = path.join(ROOT, 'node_modules', '.bin', nodeGyp);

function rebuild(withCoverage) {
  const args = ['rebuild'];
  if (withCoverage) args.push('--msgpack_coverage=1');

  if (fs.existsSync(localGyp)) return run(localGyp, args);
  const direct = run(nodeGyp, args);
  if (!direct.missing) return direct;
  return run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['node-gyp'].concat(args));
}

function removeCounters() {
  // Stale .gcda from an earlier run would be merged into this one.
  const stack = [path.join(ROOT, 'build')];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.gcda')) fs.unlinkSync(p);
    }
  }
}

function testFiles() {
  return fs
    .readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join('test', f));
}

// gcov shipped with Xcode is a stub; clang builds need `llvm-cov gcov`.
function gcovExecutable() {
  if (process.env.GCOV) return process.env.GCOV;
  if (process.platform === 'darwin') return 'llvm-cov gcov';
  return 'gcov';
}

function main() {
  let status = rebuild(true).status;
  if (status !== 0) {
    console.error('coverage:native: instrumented build failed');
    return status;
  }

  removeCounters();

  status = run(process.execPath, ['--test'].concat(testFiles())).status;
  if (status !== 0) {
    console.error('coverage:native: test suite failed under the instrumented addon');
    return status;
  }

  const gcovr = run('gcovr', [
    '--root', '.',
    '--filter', 'src/',
    '--exclude', 'deps/',
    '--gcov-executable', gcovExecutable(),
    // C++ EH edges and provably dead branches are not test gaps; see
    // COVERAGE.md for the full list of what these two flags drop.
    '--exclude-throw-branches',
    '--exclude-unreachable-branches',
    '--txt-metric', 'branch',
    '--txt', '-',
    '--txt-summary',
    '--fail-under-line', String(LINE_THRESHOLD),
    '--fail-under-branch', String(BRANCH_THRESHOLD),
  ]);

  if (gcovr.missing) {
    console.error(
      'coverage:native: gcovr not found. Install it with `pip install gcovr`.'
    );
    return 127;
  }
  if (gcovr.status !== 0) {
    console.error(
      'coverage:native: below the ' +
        LINE_THRESHOLD +
        '% line / ' +
        BRANCH_THRESHOLD +
        '% branch threshold'
    );
  }
  return gcovr.status;
}

let result = 1;
try {
  result = main();
} finally {
  // Leave the tree with an ordinary, uninstrumented addon whatever happened.
  const clean = rebuild(false);
  if (clean.status !== 0) {
    console.error('coverage:native: failed to restore the uninstrumented build');
    result = result || clean.status;
  }
}
process.exit(result);
