'use strict';

/*
 * Wire-level coverage for src/msgpack.cc: every MessagePack format family,
 * every truncation point ScanOne can bail out of, every fail-closed limit,
 * and the pack-side type dispatch. Buffers are hand-built rather than
 * produced by pack() so families pack() never emits (ext, float32, str8,
 * array32, ...) are still exercised.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Worker } = require('worker_threads');
const msgpack = require('../lib/msgpack');
const binding = require('../build/Release/msgpackBinding');

const b = (...bytes) => Buffer.from(bytes);

/* A buffer ScanOne cannot finish reads as "incomplete": null, and every byte
 * still pending. */
function assertIncomplete(buf, label) {
  assert.equal(msgpack.unpack(buf), null, label);
  assert.equal(msgpack.unpack.bytes_remaining, buf.length, label + ' remaining');
}

describe('unpack format families', () => {
  it('unpacks positive and negative fixint', () => {
    assert.equal(msgpack.unpack(b(0x00)), 0);
    assert.equal(msgpack.unpack(b(0x7f)), 127);
    assert.equal(msgpack.unpack(b(0xff)), -1);
    assert.equal(msgpack.unpack(b(0xe0)), -32);
  });

  it('unpacks nil, false and true', () => {
    assert.equal(msgpack.unpack(b(0xc0)), null);
    assert.equal(msgpack.unpack(b(0xc2)), false);
    assert.equal(msgpack.unpack(b(0xc3)), true);
  });

  it('unpacks uint8 through uint64', () => {
    assert.equal(msgpack.unpack(b(0xcc, 0xff)), 255);
    assert.equal(msgpack.unpack(b(0xcd, 0xff, 0xff)), 65535);
    assert.equal(msgpack.unpack(b(0xce, 0xff, 0xff, 0xff, 0xff)), 4294967295);
    assert.equal(
      msgpack.unpack(b(0xcf, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01)),
      9007199254740993 /* nearest double to 2^53+1 */
    );
  });

  it('unpacks int8 through int64', () => {
    assert.equal(msgpack.unpack(b(0xd0, 0x80)), -128);
    assert.equal(msgpack.unpack(b(0xd1, 0x80, 0x00)), -32768);
    assert.equal(msgpack.unpack(b(0xd2, 0x80, 0x00, 0x00, 0x00)), -2147483648);
    assert.equal(
      msgpack.unpack(b(0xd3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)),
      -1
    );
  });

  it('unpacks float32 and float64', () => {
    /* 0xca is a format pack() never emits, so only a hand-built buffer
     * reaches the MSGPACK_OBJECT_FLOAT32 arm. */
    assert.equal(msgpack.unpack(b(0xca, 0x3f, 0x80, 0x00, 0x00)), 1);
    assert.equal(msgpack.unpack(b(0xca, 0xc0, 0x00, 0x00, 0x00)), -2);
    const f64 = Buffer.alloc(9);
    f64[0] = 0xcb;
    f64.writeDoubleBE(1.5, 1);
    assert.equal(msgpack.unpack(f64), 1.5);
  });

  it('unpacks fixstr, str8, str16 and str32', () => {
    assert.equal(msgpack.unpack(b(0xa3, 0x61, 0x62, 0x63)), 'abc');
    assert.equal(msgpack.unpack(b(0xd9, 0x03, 0x61, 0x62, 0x63)), 'abc');
    assert.equal(msgpack.unpack(b(0xda, 0x00, 0x03, 0x61, 0x62, 0x63)), 'abc');
    assert.equal(
      msgpack.unpack(b(0xdb, 0x00, 0x00, 0x00, 0x03, 0x61, 0x62, 0x63)),
      'abc'
    );
  });

  it('unpacks an empty fixstr as the empty string', () => {
    assert.equal(msgpack.unpack(b(0xa0)), '');
    assert.equal(msgpack.unpack(msgpack.pack('')), '');
  });

  it('unpacks bin8, bin16 and bin32 as Buffers', () => {
    for (const wire of [
      b(0xc4, 0x03, 0x61, 0x62, 0x63),
      b(0xc5, 0x00, 0x03, 0x61, 0x62, 0x63),
      b(0xc6, 0x00, 0x00, 0x00, 0x03, 0x61, 0x62, 0x63),
    ]) {
      const got = msgpack.unpack(wire);
      assert.ok(Buffer.isBuffer(got));
      assert.equal(got.toString('utf8'), 'abc');
    }
  });

  it('unpacks an empty bin as a zero-length Buffer', () => {
    const got = msgpack.unpack(b(0xc4, 0x00));
    assert.ok(Buffer.isBuffer(got));
    assert.equal(got.length, 0);
    assert.equal(msgpack.unpack(msgpack.pack(Buffer.alloc(0))).length, 0);
  });

  it('unpacks fixarray, array16 and array32', () => {
    assert.deepEqual(msgpack.unpack(b(0x92, 0x01, 0x02)), [1, 2]);
    assert.deepEqual(msgpack.unpack(b(0xdc, 0x00, 0x02, 0x01, 0x02)), [1, 2]);
    assert.deepEqual(
      msgpack.unpack(b(0xdd, 0x00, 0x00, 0x00, 0x02, 0x01, 0x02)),
      [1, 2]
    );
    assert.deepEqual(msgpack.unpack(b(0x90)), []);
  });

  it('unpacks fixmap, map16 and map32', () => {
    assert.deepEqual(msgpack.unpack(b(0x81, 0xa1, 0x61, 0x01)), { a: 1 });
    assert.deepEqual(msgpack.unpack(b(0xde, 0x00, 0x01, 0xa1, 0x61, 0x01)), { a: 1 });
    assert.deepEqual(
      msgpack.unpack(b(0xdf, 0x00, 0x00, 0x00, 0x01, 0xa1, 0x61, 0x01)),
      { a: 1 }
    );
    assert.deepEqual(msgpack.unpack(b(0x80)), {});
  });

  it('coerces a non-string map key to a string property', () => {
    /* map of {1: 2} on the wire: the key arrives as a Number and has to be
     * stringified before DefineOwnProperty. */
    assert.deepEqual(msgpack.unpack(b(0x81, 0x01, 0x02)), { 1: 2 });
    /* nil and boolean keys stringify too. */
    assert.deepEqual(msgpack.unpack(b(0x81, 0xc0, 0x01)), { null: 1 });
    assert.deepEqual(msgpack.unpack(b(0x81, 0xc3, 0x01)), { true: 1 });
  });

  it('unpacks nested containers', () => {
    assert.deepEqual(msgpack.unpack(b(0x91, 0x81, 0xa1, 0x61, 0x91, 0x02)), [
      { a: [2] },
    ]);
  });
});

describe('unpack truncation returns null without consuming', () => {
  it('treats an empty buffer as incomplete', () => {
    assertIncomplete(Buffer.alloc(0), 'empty');
  });

  it('treats a truncated fixed-width header as incomplete', () => {
    const cases = [
      [0xca],
      [0xca, 0x00, 0x00],
      [0xcb],
      [0xcb, 0x00, 0x00, 0x00],
      [0xcc],
      [0xcd],
      [0xcd, 0x00],
      [0xce],
      [0xce, 0x00, 0x00],
      [0xcf],
      [0xcf, 0x00, 0x00, 0x00],
      [0xd0],
      [0xd1],
      [0xd1, 0x00],
      [0xd2],
      [0xd2, 0x00, 0x00],
      [0xd3],
      [0xd3, 0x00, 0x00, 0x00],
    ];
    for (const c of cases) assertIncomplete(b(...c), '0x' + c[0].toString(16));
  });

  it('treats a truncated fixext as incomplete', () => {
    const cases = [
      [0xd4],
      [0xd4, 0x01],
      [0xd5, 0x01],
      [0xd6, 0x01, 0x00],
      [0xd7, 0x01, 0x00],
      [0xd8, 0x01, 0x00],
    ];
    for (const c of cases) assertIncomplete(b(...c), '0x' + c[0].toString(16));
  });

  it('treats a truncated str header or payload as incomplete', () => {
    assertIncomplete(b(0xa3, 0x61), 'fixstr payload');
    assertIncomplete(b(0xd9), 'str8 length');
    assertIncomplete(b(0xd9, 0x03, 0x61), 'str8 payload');
    assertIncomplete(b(0xda, 0x00), 'str16 length');
    assertIncomplete(b(0xda, 0x00, 0x03, 0x61), 'str16 payload');
    assertIncomplete(b(0xdb, 0x00, 0x00), 'str32 length');
    assertIncomplete(b(0xdb, 0x00, 0x00, 0x00, 0x03, 0x61), 'str32 payload');
  });

  it('treats a truncated bin header or payload as incomplete', () => {
    assertIncomplete(b(0xc4), 'bin8 length');
    assertIncomplete(b(0xc4, 0x03, 0x61), 'bin8 payload');
    assertIncomplete(b(0xc5, 0x00), 'bin16 length');
    assertIncomplete(b(0xc5, 0x00, 0x03, 0x61), 'bin16 payload');
    assertIncomplete(b(0xc6, 0x00, 0x00), 'bin32 length');
    assertIncomplete(b(0xc6, 0x00, 0x00, 0x00, 0x03, 0x61), 'bin32 payload');
  });

  it('treats a truncated ext header, type byte or payload as incomplete', () => {
    assertIncomplete(b(0xc7), 'ext8 length');
    assertIncomplete(b(0xc7, 0x01), 'ext8 type byte');
    assertIncomplete(b(0xc7, 0x03, 0x01, 0x61), 'ext8 payload');
    assertIncomplete(b(0xc8, 0x00), 'ext16 length');
    assertIncomplete(b(0xc8, 0x00, 0x01), 'ext16 type byte');
    assertIncomplete(b(0xc8, 0x00, 0x03, 0x01, 0x61), 'ext16 payload');
    assertIncomplete(b(0xc9, 0x00, 0x00), 'ext32 length');
    assertIncomplete(b(0xc9, 0x00, 0x00, 0x00, 0x01), 'ext32 type byte');
    assertIncomplete(b(0xc9, 0x00, 0x00, 0x00, 0x03, 0x01, 0x61), 'ext32 payload');
  });

  it('treats a truncated container header or payload as incomplete', () => {
    assertIncomplete(b(0x91), 'fixarray element');
    assertIncomplete(b(0x81), 'fixmap key');
    assertIncomplete(b(0x81, 0xa1, 0x61), 'fixmap value');
    assertIncomplete(b(0xdc, 0x00), 'array16 length');
    assertIncomplete(b(0xdc, 0x00, 0x02, 0x01), 'array16 elements');
    assertIncomplete(b(0xdd, 0x00, 0x00), 'array32 length');
    assertIncomplete(b(0xdd, 0x00, 0x00, 0x00, 0x05), 'array32 elements');
    assertIncomplete(b(0xde, 0x00), 'map16 length');
    assertIncomplete(b(0xde, 0x00, 0x02, 0xa1, 0x61, 0x01), 'map16 pairs');
    assertIncomplete(b(0xdf, 0x00, 0x00), 'map32 length');
    assertIncomplete(b(0xdf, 0x00, 0x00, 0x00, 0x05), 'map32 pairs');
  });
});

describe('unpack fail-closed limits', () => {
  const tooManyItems = 1000001; /* kMaxContainer + 1 */
  const be32 = (tag, n) => {
    const buf = Buffer.alloc(5);
    buf[0] = tag;
    buf.writeUInt32BE(n, 1);
    return buf;
  };

  it('rejects array32 and map32 above kMaxContainer', () => {
    assert.throws(() => msgpack.unpack(be32(0xdd, tooManyItems)), /limit exceeded/);
    assert.throws(() => msgpack.unpack(be32(0xdf, tooManyItems)), /limit exceeded/);
  });

  it('rejects str32, bin32 and ext32 above kMaxBytes', () => {
    const tooManyBytes = 32 * 1024 * 1024 + 1;
    assert.throws(() => msgpack.unpack(be32(0xdb, tooManyBytes)), /limit exceeded/);
    assert.throws(() => msgpack.unpack(be32(0xc6, tooManyBytes)), /limit exceeded/);
    const ext = Buffer.concat([be32(0xc9, tooManyBytes), b(0x01)]);
    assert.throws(() => msgpack.unpack(ext), /limit exceeded/);
  });

  it('rejects a container nested past kMaxDepth even when complete', () => {
    const deep = (n) => Buffer.concat([Buffer.alloc(n, 0x91), b(0x01)]);
    assert.deepEqual(msgpack.unpack(deep(1)), [1]);
    assert.throws(() => msgpack.unpack(deep(512)), /limit exceeded/);
    /* map16 nesting takes the same CheckContainer depth guard. */
    const deepMap = Buffer.concat([
      Buffer.alloc(600, 0x81),
      b(0xa1, 0x61, 0x01),
    ]);
    assert.throws(() => msgpack.unpack(deepMap), /limit exceeded/);
  });
});

describe('unpack parse errors', () => {
  it('rejects the never-used byte 0xc1', () => {
    assert.throws(() => msgpack.unpack(b(0xc1)), /error unpacking buffer/);
    /* 0xc1 nested inside a container is rejected too. */
    assert.throws(() => msgpack.unpack(b(0x91, 0xc1)), /error unpacking buffer/);
  });

  it('refuses to decode every ext family', () => {
    const wires = {
      fixext1: b(0xd4, 0x01, 0x00),
      fixext2: b(0xd5, 0x01, 0x00, 0x00),
      fixext4: b(0xd6, 0x01, 0x00, 0x00, 0x00, 0x00),
      fixext8: Buffer.concat([b(0xd7, 0x01), Buffer.alloc(8)]),
      fixext16: Buffer.concat([b(0xd8, 0x01), Buffer.alloc(16)]),
      ext8: b(0xc7, 0x02, 0x01, 0x00, 0x00),
      ext16: b(0xc8, 0x00, 0x02, 0x01, 0x00, 0x00),
      ext32: b(0xc9, 0x00, 0x00, 0x00, 0x02, 0x01, 0x00, 0x00),
    };
    for (const [name, wire] of Object.entries(wires)) {
      assert.throws(() => msgpack.unpack(wire), /cannot unpack ext type/, name);
    }
    /* An ext buried in a container is rejected on the way out too. */
    assert.throws(
      () => msgpack.unpack(b(0x81, 0xa1, 0x61, 0xd4, 0x01, 0x00)),
      /cannot unpack ext type/
    );
  });

  it('rejects a non-Buffer argument', () => {
    assert.throws(() => msgpack.unpack(), /must be a Buffer/);
    assert.throws(() => msgpack.unpack(5), /must be a Buffer/);
    assert.throws(() => msgpack.unpack('abc'), /must be a Buffer/);
    assert.throws(() => msgpack.unpack({}), /must be a Buffer/);
    assert.throws(() => msgpack.unpack(null), /must be a Buffer/);
  });
});

describe('unpack bytes_remaining', () => {
  it('reports zero when the buffer is fully consumed', () => {
    assert.equal(msgpack.unpack(b(0x92, 0x01, 0x02))[1], 2);
    assert.equal(msgpack.unpack.bytes_remaining, 0);
  });

  it('reports the trailing byte count for extra data', () => {
    assert.equal(msgpack.unpack(b(0x01, 0x02, 0x03)), 1);
    assert.equal(msgpack.unpack.bytes_remaining, 2);
  });
});

describe('pack type dispatch', () => {
  it('packs undefined as nil', () => {
    assert.equal(msgpack.unpack(msgpack.pack(undefined)), null);
    assert.deepEqual(msgpack.unpack(msgpack.pack([undefined, null])), [null, null]);
  });

  it('packs no arguments as an empty array', () => {
    assert.deepEqual(msgpack.unpack(msgpack.pack()), []);
  });

  it('packs multiple arguments as an array', () => {
    assert.deepEqual(msgpack.unpack(msgpack.pack(1, 'two', [3])), [1, 'two', [3]]);
  });

  it('packs non-finite numbers as doubles', () => {
    assert.equal(msgpack.unpack(msgpack.pack(Infinity)), Infinity);
    assert.equal(msgpack.unpack(msgpack.pack(-Infinity)), -Infinity);
    assert.ok(Number.isNaN(msgpack.unpack(msgpack.pack(NaN))));
    for (const wire of [Infinity, -Infinity, NaN].map((n) => msgpack.pack(n))) {
      assert.equal(wire[0], 0xcb, 'float64 tag');
    }
  });

  it('packs non-integral numbers as doubles', () => {
    assert.equal(msgpack.unpack(msgpack.pack(1.5)), 1.5);
    assert.equal(msgpack.unpack(msgpack.pack(-1.5)), -1.5);
  });

  it('packs integers across the signed and unsigned edges', () => {
    const cases = [
      0, 1, -1, 127, -32, 255, -128, 65535, -32768,
      4294967295, -2147483648, 2 ** 53, -(2 ** 53),
      Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
    ];
    for (const n of cases) {
      assert.equal(msgpack.unpack(msgpack.pack(n)), n, String(n));
    }
    /* 2^63 and -2^63 still take the integer path (they fit uint64/int64). */
    assert.equal(msgpack.unpack(msgpack.pack(2 ** 63)), 2 ** 63);
    assert.equal(msgpack.unpack(msgpack.pack(-(2 ** 63))), -(2 ** 63));
    /* One ulp below 2^64 is the largest double that survives the uint64
     * cast; the next one up must fall through to the double path. */
    assert.equal(msgpack.pack(2 ** 64 - 2048)[0], 0xcf);
    assert.equal(msgpack.pack(2 ** 64)[0], 0xcb);
    assert.equal(msgpack.pack(-(2 ** 64))[0], 0xcb);
  });

  it('packs booleans as true/false, not integers', () => {
    assert.equal(msgpack.pack(true)[0], 0xc3);
    assert.equal(msgpack.pack(false)[0], 0xc2);
    assert.equal(msgpack.unpack(msgpack.pack(false)), false);
  });

  it('refuses to pack a Symbol or a BigInt', () => {
    assert.throws(() => msgpack.pack(Symbol('x')), /cannot pack object/);
    assert.throws(() => msgpack.pack(10n), /cannot pack object/);
  });

  it('refuses to pack a function', () => {
    assert.throws(() => msgpack.pack(() => {}), /cannot pack function/);
    assert.throws(() => msgpack.pack({ f: function () {} }), /cannot pack function/);
  });

  it('packs an empty array and an empty object', () => {
    assert.deepEqual(msgpack.unpack(msgpack.pack([])), []);
    assert.deepEqual(msgpack.unpack(msgpack.pack({})), {});
  });

  it('reuses the thread-local sbuffer pool on the second pack', () => {
    /* First pack allocates and hands the sbuffer to the pool; the second
     * takes the pooled path, which copies rather than releasing. */
    const first = msgpack.pack({ a: 1 });
    const second = msgpack.pack({ a: 1 });
    assert.deepEqual(first, second);
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(msgpack.unpack(msgpack.pack({ i })), { i });
    }
  });
});

describe('pack Date handling', () => {
  it('packs an invalid Date as the string "Invalid Date" fails closed', () => {
    /* toISOString throws RangeError for an invalid Date; CallNoArgs must
     * surface that as a catchable JS error, not abort. */
    assert.throws(() => msgpack.pack(new Date(NaN)), /Invalid time value/);
  });

  it('refuses a Date whose toISOString is not callable', () => {
    const d = new Date('2000-06-13T00:00:00.000Z');
    d.toISOString = 42;
    assert.throws(() => msgpack.pack(d), /cannot pack Date/);
  });

  it('rethrows from a Date whose toISOString throws', () => {
    const d = new Date('2000-06-13T00:00:00.000Z');
    d.toISOString = () => {
      throw new Error('nope');
    };
    assert.throws(() => msgpack.pack(d), /^Error: nope$/);
    assert.equal(msgpack.unpack(msgpack.pack('ok')), 'ok');
  });

  it('reads toISOString through a throwing getter without aborting', () => {
    const d = new Date('2000-06-13T00:00:00.000Z');
    Object.defineProperty(d, 'toISOString', {
      get() {
        throw new Error('trap');
      },
    });
    assert.throws(() => msgpack.pack(d), /^Error: trap$/);
  });
});

describe('pack toJSON handling', () => {
  it('rethrows when toJSON throws', () => {
    assert.throws(
      () =>
        msgpack.pack({
          toJSON() {
            throw new Error('boom');
          },
        }),
      /^Error: boom$/
    );
    assert.equal(msgpack.unpack(msgpack.pack('ok')), 'ok');
  });

  it('rethrows when a nested toJSON throws', () => {
    const o = {
      inner: {
        toJSON() {
          throw new Error('boom');
        },
      },
    };
    assert.throws(() => msgpack.pack(o), /^Error: boom$/);
  });

  it('rethrows when reading toJSON itself throws', () => {
    const o = {};
    Object.defineProperty(o, 'toJSON', {
      get() {
        throw new Error('trap');
      },
      enumerable: true,
    });
    assert.throws(() => msgpack.pack(o), /^Error: trap$/);
  });

  it('unmarks an object after a toJSON failure so it can be packed again', () => {
    /* The cycle mark has to come off on the throw path, or the retry would
     * look like a circular reference. */
    let fail = true;
    const o = {
      toJSON() {
        if (fail) throw new Error('boom');
        return { ok: 1 };
      },
    };
    assert.throws(() => msgpack.pack(o), /boom/);
    fail = false;
    assert.deepEqual(msgpack.unpack(msgpack.pack(o)), { ok: 1 });
  });

  it('honours a toJSON that returns a scalar or a Buffer', () => {
    assert.equal(msgpack.unpack(msgpack.pack({ toJSON: () => 7 })), 7);
    const got = msgpack.unpack(msgpack.pack({ toJSON: () => Buffer.from('hi') }));
    assert.ok(Buffer.isBuffer(got));
    assert.equal(got.toString(), 'hi');
  });
});

describe('pack cycle detection', () => {
  it('unmarks a nested array so a repeated sibling is not a cycle', () => {
    const shared = [1, 2];
    assert.deepEqual(msgpack.unpack(msgpack.pack([shared, shared])), [
      [1, 2],
      [1, 2],
    ]);
  });

  it('unmarks a nested object so a repeated sibling is not a cycle', () => {
    const shared = { a: 1 };
    assert.deepEqual(msgpack.unpack(msgpack.pack({ x: shared, y: shared })), {
      x: { a: 1 },
      y: { a: 1 },
    });
  });

  it('detects a cycle through an array element', () => {
    const a = [];
    a.push([a]);
    assert.throws(() => msgpack.pack(a), /circular/);
  });

  it('detects a cycle through a nested object', () => {
    const o = { a: {} };
    o.a.back = o;
    assert.throws(() => msgpack.pack(o), /circular/);
  });

  it('leaves no mark behind after a circular failure', () => {
    const o = {};
    o.self = o;
    assert.throws(() => msgpack.pack(o), /circular/);
    delete o.self;
    assert.deepEqual(msgpack.unpack(msgpack.pack(o)), {});
  });
});

describe('binding entry points called directly', () => {
  it('rejects unpack with no arguments at all', () => {
    /* lib/msgpack.js always forwards one argument, so only a direct call
     * reaches the info.Length() < 1 arm of the argument check. */
    assert.throws(() => binding.unpack(), /must be a Buffer/);
  });

  it('exposes bytesRemaining as its own function', () => {
    binding.unpack(Buffer.from([0x01, 0x02]));
    assert.equal(binding.bytesRemaining(), 1);
  });

  it('packs through the binding without the JS wrapper', () => {
    assert.deepEqual(binding.unpack(binding.pack({ a: 1 })), { a: 1 });
  });
});

describe('sbuffer pool saturation', () => {
  it('frees rather than pools an sbuffer once the pool is full', (t, done) => {
    /* 600 > kSbufferPoolMax (512), so unwinding overflows the pool. */
    const worker = new Worker(path.join(__dirname, 'fixtures', 'deep-pack-worker.js'), {
      workerData: {
        binding: path.join(__dirname, '..', 'build', 'Release', 'msgpackBinding'),
        depth: 600,
      },
      resourceLimits: { stackSizeMb: 32 },
    });
    let result;
    worker.on('message', (m) => {
      result = m;
    });
    worker.once('error', done);
    worker.once('exit', (code) => {
      try {
        assert.equal(code, 0);
        assert.ok(result.length > 0);
        assert.equal(result.stable, true, 'pooled and fresh buffers agree');
        done();
      } catch (err) {
        done(err);
      }
    });
  });
});
