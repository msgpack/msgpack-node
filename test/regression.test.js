'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const msgpack = require('../lib/msgpack');

describe('regressions', () => {
  it('unpacks a 7-bit integer from a larger buffer (bytes_remaining)', () => {
    const buf = Buffer.from([0x05, 0x00]);
    assert.equal(msgpack.unpack(buf), 5);
    assert.equal(msgpack.unpack.bytes_remaining, 1);
  });

  it('rejects Date without toJSON as a packable object (no crash)', () => {
    /* Dates pack natively as their ISO string. */
    const packed = msgpack.pack(new Date('2000-06-13T00:00:00.000Z'));
    assert.equal(typeof msgpack.unpack(packed), 'string');
  });

  it('packs out-of-range integral doubles as doubles', () => {
    /* 1e30 is integral but does not fit uint64; the cast was UB and put
     * 2^64-1 on the wire. */
    const big = msgpack.unpack(msgpack.pack(1e30));
    assert.equal(typeof big, 'number');
    assert.ok(Number.isFinite(big));
    assert.equal(big, 1e30);

    const negBig = msgpack.unpack(msgpack.pack(-1e30));
    assert.ok(Number.isFinite(negBig));
    assert.equal(negBig, -1e30);
  });

  it('still packs integers at the edges of the integer path', () => {
    for (const n of [0, 1, -1, 2 ** 53, -(2 ** 53), 2 ** 63, -(2 ** 63)]) {
      assert.equal(msgpack.unpack(msgpack.pack(n)), n);
    }
  });

  it('unpacks a map written by Python msgpack (msgpack-node#10)', () => {
    /* Latin-1 wire bytes straight out of python-msgpack: fixmap of 5 with a
     * bool, two fixstrs, a uint8 and a bin8 payload. */
    const wire = '\x85\xa8Coalesce\xc3\xa5Event\xa4user\xa5LTime\xcc\x01' +
                 '\xa4Name\xa4test\xa7Payload\xc4\x03foo';
    const unpacked = msgpack.unpack(Buffer.from(wire, 'latin1'));

    assert.equal(unpacked.Coalesce, true);
    assert.equal(unpacked.Event, 'user');
    assert.equal(unpacked.LTime, 1);
    assert.equal(unpacked.Name, 'test');
    assert.ok(Buffer.isBuffer(unpacked.Payload));
    assert.deepEqual(unpacked.Payload, Buffer.from('foo'));
    assert.equal(msgpack.unpack.bytes_remaining, 0);
  });
});
