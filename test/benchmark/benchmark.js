#!/usr/bin/env node
// Standalone throughput benchmark: JSON vs. msgpack on a small object.
//
//     npm run bench
//     node test/benchmark/benchmark.js
//
// This only measures. It does not assert that one encoder beats the other:
// the ratio moves with the V8 version, the object shape, and the machine.

'use strict';

const os = require('os');
const msgpack = require('../../lib/msgpack');

const DATA = { abcdef: 1, qqq: 13, 19: [1, 2, 3, 4] };
const ITERATIONS = 500000;
const WARMUP = 50000;

function time(fn, count) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < count; i++) {
        fn();
    }
    return Number(process.hrtime.bigint() - start) / 1e6;
}

const CASES = [
    ['JSON.stringify()', () => JSON.stringify(DATA)],
    ['JSON.parse(JSON.stringify())', () => JSON.parse(JSON.stringify(DATA))],
    ['msgpack.pack()', () => msgpack.pack(DATA)],
    ['msgpack.unpack(msgpack.pack())', () => msgpack.unpack(msgpack.pack(DATA))]
];

function cpuClass() {
    const cpus = os.cpus();
    const model = cpus.length > 0 ? cpus[0].model : 'unknown';
    // Containers on some platforms report no model string; fall back to arch.
    const name = !model || model === 'unknown' ? `${os.arch()} (model not reported)` : model;
    return `${name} x ${cpus.length}, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB RAM`;
}

console.log(`node       ${process.version}`);
console.log(`v8         ${process.versions.v8}`);
console.log(`platform   ${os.platform()} ${os.release()} (${os.arch()})`);
console.log(`cpu        ${cpuClass()}`);
console.log(`data       ${JSON.stringify(DATA)}`);
console.log(`iterations ${ITERATIONS.toLocaleString('en-US')}`);
console.log('');

for (const [, fn] of CASES) {
    time(fn, WARMUP);
}

for (const [name, fn] of CASES) {
    const ms = time(fn, ITERATIONS);
    console.log(
        `${name.padEnd(32)} ${ms.toFixed(0).padStart(7)} ms  (${(ms / 1000).toFixed(2)} s)`
    );
}

process.exit(0);

// vim:ts=4 sw=4 et filetype=javascript
