'use strict';

/* Loaded inside a worker_threads Worker. Requiring the addon here is the
 * actual failure in msgpack-node#60: a non-context-aware NODE_MODULE throws
 * "Module did not self-register" the second time the .node file is loaded. */
const { parentPort, workerData } = require('worker_threads');
const msgpack = require('../../');

/* Bail out rather than hang if the main thread never opens the start gate. */
const GATE_TIMEOUT_MS = 30000;

/* Build a payload that is unique per worker and per iteration, so a buffer
 * leaking between threads shows up as wrong data rather than as luck. */
function payload(id, i) {
  return {
    id: id,
    i: i,
    tag: 'w' + id + '-' + i,
    blob: Buffer.from(('x' + id).repeat(1 + (i % 37))),
    list: [i, i * 2, i * 3, null, true, 'n' + i],
    nested: { depth: { value: id * 100000 + i } }
  };
}

function run(op) {
  switch (op) {
    case 'roundtrip': {
      const value = { a: 1, b: Buffer.from('hi') };
      const unpacked = msgpack.unpack(msgpack.pack(value));
      return {
        a: unpacked.a,
        bIsBuffer: Buffer.isBuffer(unpacked.b),
        b: unpacked.b.toString('latin1'),
        keys: Object.keys(unpacked)
      };
    }
    case 'cycle': {
      const o = { name: 'loop' };
      o.self = o;
      try {
        msgpack.pack(o);
        return { threw: false, message: null };
      } catch (err) {
        return { threw: true, message: err.message };
      }
    }
    case 'unpack-remaining': {
      /* A different buffer than the main thread used, leaving a different
       * number of trailing bytes behind. */
      const buf = Buffer.concat([msgpack.pack('worker'), Buffer.alloc(7)]);
      const value = msgpack.unpack(buf);
      return { value: value, bytesRemaining: msgpack.unpack.bytes_remaining };
    }
    case 'concurrent-pack': {
      /* Many pack/unpack round-trips of distinct payloads, racing the main
       * thread and the other workers. Exercises the thread_local sbuf pool:
       * a shared pool would hand the same sbuffer to two threads at once. */
      const id = workerData.id;
      const iterations = workerData.iterations;
      const gate = new Int32Array(workerData.gate);

      /* Announce that the addon is loaded, then block until the main thread
       * opens the gate. Spawning a Worker takes far longer than this loop
       * does, so without the barrier the main thread would be done packing
       * before any worker started and nothing would actually overlap. */
      parentPort.postMessage({ ready: true });
      if (Atomics.load(gate, 0) === 0) {
        Atomics.wait(gate, 0, 0, GATE_TIMEOUT_MS);
      }
      if (Atomics.load(gate, 0) === 0) {
        throw new Error('worker ' + id + ' timed out waiting for the start gate');
      }

      for (let i = 0; i < iterations; i++) {
        const value = payload(id, i);
        const unpacked = msgpack.unpack(msgpack.pack(value));
        if (unpacked.id !== id || unpacked.i !== i || unpacked.tag !== value.tag ||
            unpacked.nested.depth.value !== value.nested.depth.value ||
            unpacked.blob.toString('latin1') !== value.blob.toString('latin1') ||
            unpacked.list.length !== value.list.length ||
            unpacked.list[5] !== value.list[5]) {
          throw new Error('worker ' + id + ' round-trip mismatch at ' + i + ': ' +
                          JSON.stringify(unpacked));
        }
      }
      return { id: id, iterations: iterations, ok: true };
    }
    default:
      throw new Error('unknown op: ' + op);
  }
}

parentPort.postMessage(run(workerData.op));
