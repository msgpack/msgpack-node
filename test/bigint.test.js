'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const msgpack = require('../lib/msgpack');

function b(...bytes) {
  return Buffer.from(bytes);
}

describe('BigInt 64-bit integers (#37)', () => {
  const reporter = 18446464814936021036n;
  const reporterWire = b(0xcf, 0xff, 0xff, 0x02, 0x04, 0x00, 0x00, 0xd8, 0x2c);

  it('round-trips a uint64 BigInt that a Number would round', () => {
    assert.equal(msgpack.unpack(msgpack.pack(reporter)), reporter);
    assert.equal(typeof msgpack.unpack(msgpack.pack(reporter)), 'bigint');
  });

  it('unpacks the reporter uint64 wire as that BigInt', () => {
    assert.equal(msgpack.unpack(reporterWire), reporter);
    assert.deepEqual(msgpack.pack(reporter), reporterWire);
  });

  it('unpacks a uint64 of 1 as Number 1, not BigInt', () => {
    const wire = b(0xcf, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01);
    const got = msgpack.unpack(wire);
    assert.equal(typeof got, 'number');
    assert.equal(got, 1);
  });

  it('unpacks Number.MAX_SAFE_INTEGER as Number regardless of wire width', () => {
    const fromNumber = msgpack.unpack(msgpack.pack(Number.MAX_SAFE_INTEGER));
    assert.equal(typeof fromNumber, 'number');
    assert.equal(fromNumber, Number.MAX_SAFE_INTEGER);

    const u64 = b(0xcf, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
    const fromWire = msgpack.unpack(u64);
    assert.equal(typeof fromWire, 'number');
    assert.equal(fromWire, Number.MAX_SAFE_INTEGER);

    const fromBigInt = msgpack.unpack(msgpack.pack(9007199254740991n));
    assert.equal(typeof fromBigInt, 'number');
    assert.equal(fromBigInt, Number.MAX_SAFE_INTEGER);
  });

  it('unpacks a safe BigInt as Number after pack', () => {
    assert.equal(msgpack.unpack(msgpack.pack(1n)), 1);
    assert.equal(typeof msgpack.unpack(msgpack.pack(1n)), 'number');
    assert.equal(msgpack.pack(1n)[0], 0x01);
    assert.equal(msgpack.pack(10n)[0], 0x0a);
  });

  it('encodes BigInt with the smallest integer family that fits', () => {
    assert.equal(msgpack.pack(255n)[0], 0xcc);
    assert.equal(msgpack.pack(256n)[0], 0xcd);
    assert.equal(msgpack.pack(-32n)[0], 0xe0);
    assert.equal(msgpack.pack(-33n)[0], 0xd0);
    assert.deepEqual(
      msgpack.pack(2n ** 64n - 1n),
      b(0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)
    );
    assert.deepEqual(
      msgpack.pack(-(2n ** 63n)),
      b(0xd3, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
    );
    assert.equal(msgpack.unpack(msgpack.pack(2n ** 64n - 1n)), 2n ** 64n - 1n);
    assert.equal(msgpack.unpack(msgpack.pack(-(2n ** 63n))), -(2n ** 63n));
  });

  it('throws a catchable error for BigInt outside uint64/int64', () => {
    assert.throws(() => msgpack.pack(2n ** 64n), /cannot pack BigInt outside 64-bit range/);
    assert.throws(
      () => msgpack.pack(-(2n ** 63n) - 1n),
      /cannot pack BigInt outside 64-bit range/
    );
    try {
      msgpack.pack(2n ** 64n);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /cannot pack BigInt outside 64-bit range/);
    }
  });

  it('does not recover lost bits from a Number that is already rounded', () => {
    const n = 18446464814936021000;
    assert.equal(typeof n, 'number');
    const packed = msgpack.pack(n);
    /* Still the Number integer/float path, not the BigInt encoder. */
    assert.notDeepEqual(packed, reporterWire);
    assert.notEqual(msgpack.unpack(packed), reporter);
  });

  it('packs nested BigInt values in arrays and objects', () => {
    const payload = { n: reporter, a: [1n, reporter] };
    const got = msgpack.unpack(msgpack.pack(payload));
    assert.equal(got.n, reporter);
    assert.equal(got.a[0], 1);
    assert.equal(got.a[1], reporter);
  });
});
