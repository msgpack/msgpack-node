'use strict';

/*
 * Recursively packs through toJSON so `depth` PackBuffer objects are alive at
 * once. Unwinding then returns them to the thread-local sbuffer pool in one
 * burst, which is the only way to drive the pool to kSbufferPoolMax (512) and
 * exercise the "pool is full, free it" arm of ~PackBuffer.
 *
 * It runs on a worker because 512+ nested pack->toJSON->pack frames overflow
 * the default main-thread stack; resourceLimits.stackSizeMb gives it room.
 */

const { parentPort, workerData } = require('worker_threads');
const binding = require(workerData.binding);

function nestedPack(depth) {
  let value = { v: 1 };
  for (let i = 0; i < depth; i++) {
    const inner = value;
    value = {
      toJSON() {
        return binding.pack(inner);
      },
    };
  }
  return binding.pack(value);
}

/* Twice: the second run starts with a pool that the first run filled, so the
 * "take from pool" arm of the constructor runs at depth too. */
const first = nestedPack(workerData.depth);
const second = nestedPack(workerData.depth);

parentPort.postMessage({
  length: first.length,
  stable: first.equals(second),
});
