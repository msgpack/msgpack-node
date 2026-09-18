'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Worker } = require('worker_threads');

/* Load the addon on the main thread first: the regression only shows up on
 * the *second* load of msgpackBinding.node, i.e. inside the worker. */
const msgpack = require('../');
const binding = require('../build/Release/msgpackBinding');

const WORKER = path.join(__dirname, 'fixtures', 'msgpack-worker.js');

function runWorker(op, extra, onReady) {
  return new Promise((resolve, reject) => {
    const workerData = Object.assign({ op: op }, extra);
    const worker = new Worker(WORKER, { workerData: workerData });
    let message;
    let settled = false;
    worker.on('message', (m) => {
      /* A {ready:true} note means the worker has loaded the addon and is
       * parked on the start gate; the real result comes later. */
      if (m && m.ready === true) {
        if (onReady) onReady(worker);
        return;
      }
      message = m;
    });
    worker.once('error', (err) => {
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      if (code !== 0) return reject(new Error('worker exited with code ' + code));
      resolve(message);
    });
  });
}

describe('worker_threads', () => {
  it('loads the addon inside a worker and round-trips values', async () => {
    const result = await runWorker('roundtrip');
    assert.deepEqual(result.keys, ['a', 'b']);
    assert.equal(result.a, 1);
    assert.equal(result.bIsBuffer, true, 'bin stays a Buffer in the worker');
    assert.equal(result.b, 'hi');
  });

  it('still detects cycles inside a worker', async () => {
    const result = await runWorker('cycle');
    assert.equal(result.threw, true);
    assert.match(result.message, /circular/);
  });

  it('leaves the main thread working after a worker has loaded the addon', async () => {
    await runWorker('roundtrip');

    const value = { a: 1, b: Buffer.from('hi'), c: [1, 'two', null] };
    const unpacked = msgpack.unpack(msgpack.pack(value));
    assert.equal(unpacked.a, 1);
    assert.ok(Buffer.isBuffer(unpacked.b));
    assert.equal(unpacked.b.toString('latin1'), 'hi');
    assert.deepEqual(unpacked.c, [1, 'two', null]);

    /* Cycle detection uses a process-wide private key; check it survived the
     * worker's module init. */
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => msgpack.pack(cyclic), /circular/);
  });

  it('does not let a worker unpack clobber the main thread bytes_remaining', async () => {
    const buf = Buffer.concat([msgpack.pack(1), Buffer.alloc(3)]);
    assert.equal(msgpack.unpack(buf), 1);
    assert.equal(msgpack.unpack.bytes_remaining, 3);

    const result = await runWorker('unpack-remaining');
    assert.equal(result.value, 'worker');
    assert.equal(result.bytesRemaining, 7);

    /* The JS-level snapshot is per-thread by construction; the native counter
     * behind it is a single global unless it is thread_local. */
    assert.equal(msgpack.unpack.bytes_remaining, 3);
    assert.equal(binding.bytesRemaining(), 3);
  });

  it('packs on several workers concurrently with the main thread', async () => {
    const WORKERS = 4;
    const ITERATIONS = 4000;

    /* gate[0] flips to 1 when every worker has loaded the addon, releasing
     * all of them at once so their packing really does overlap this thread's. */
    const gate = new Int32Array(new SharedArrayBuffer(4));

    let ready = 0;
    let releaseAll;
    const allReady = new Promise((resolve) => { releaseAll = resolve; });

    const running = [];
    for (let id = 1; id <= WORKERS; id++) {
      running.push(runWorker('concurrent-pack', { id: id, iterations: ITERATIONS, gate: gate.buffer }, () => {
        if (++ready === WORKERS) releaseAll();
      }));
    }

    /* If a worker dies before signalling ready, surface that error instead of
     * waiting on a barrier that will never be reached. */
    await Promise.race([allReady, Promise.all(running)]);

    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);

    /* Pack on the main thread while the workers are packing. The pack buffer
     * pool is thread_local, so nobody should ever see another thread's bytes. */
    for (let i = 0; i < ITERATIONS; i++) {
      const value = {
        id: 0,
        i: i,
        tag: 'main-' + i,
        blob: Buffer.from('m'.repeat(1 + (i % 53))),
        list: [i, 'main' + i, null, false],
        nested: { depth: { value: -1 - i } }
      };
      const unpacked = msgpack.unpack(msgpack.pack(value));
      assert.equal(unpacked.id, 0);
      assert.equal(unpacked.i, i);
      assert.equal(unpacked.tag, 'main-' + i);
      assert.equal(unpacked.blob.toString('latin1'), value.blob.toString('latin1'));
      assert.deepEqual(unpacked.list, value.list);
      assert.equal(unpacked.nested.depth.value, -1 - i);
    }

    const results = await Promise.all(running);
    assert.equal(results.length, WORKERS);
    results.forEach((result, index) => {
      assert.ok(result, 'worker ' + (index + 1) + ' posted a result');
      assert.equal(result.ok, true);
      assert.equal(result.id, index + 1);
      assert.equal(result.iterations, ITERATIONS);
    });

    /* The main thread keeps working once the workers are gone: each worker's
     * pool was freed with its thread, not handed back to this one. */
    assert.deepEqual(msgpack.unpack(msgpack.pack({ after: [1, 2, 3] })), { after: [1, 2, 3] });
  });

  it('reuses the pack buffer pool across many sequential packs', () => {
    /* The first pack mallocs its sbuffer and hands the memory to Node
     * (NewBuffer); every later one takes a pooled sbuffer and copies out
     * (CopyBuffer). Both paths have to produce identical bytes. */
    const value = { a: 1, b: Buffer.from('hi'), c: [1, 'two', null], d: { e: -7 } };
    const first = msgpack.pack(value);
    for (let i = 0; i < 2000; i++) {
      const packed = msgpack.pack(value);
      assert.ok(packed.equals(first), 'pack #' + i + ' differs from the first pack');
      const unpacked = msgpack.unpack(packed);
      assert.equal(unpacked.a, 1);
      assert.equal(unpacked.b.toString('latin1'), 'hi');
      assert.deepEqual(unpacked.c, [1, 'two', null]);
      assert.equal(unpacked.d.e, -7);
    }

    /* A pooled sbuffer is reused after a much larger pack, so a stale size or
     * leftover bytes would show up here. */
    msgpack.pack({ big: Buffer.alloc(200000, 0x41) });
    assert.ok(msgpack.pack(value).equals(first), 'pack after a large pack differs');
  });
});
