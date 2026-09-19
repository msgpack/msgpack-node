'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const msgpack = require('../lib/msgpack');

function b(...bytes) {
  return Buffer.from(bytes);
}

/** msgpackr useBigIntExtension payload: two's-complement BE, min length. */
function bigintExtPayload(value) {
  const bytes = [];
  let v = value;
  let alignedSign;
  do {
    const byte = v & 0xffn;
    alignedSign = (byte & 0x80n) === (v < 0n ? 0x80n : 0n);
    bytes.push(Number(byte));
    v >>= 8n;
  } while (!((v === 0n || v === -1n) && alignedSign));
  return Buffer.from(bytes.reverse());
}

function ext42Wire(payload) {
  const n = payload.length;
  const type = 0x42;
  if (n === 1) return Buffer.concat([Buffer.from([0xd4, type]), payload]);
  if (n === 2) return Buffer.concat([Buffer.from([0xd5, type]), payload]);
  if (n === 4) return Buffer.concat([Buffer.from([0xd6, type]), payload]);
  if (n === 8) return Buffer.concat([Buffer.from([0xd7, type]), payload]);
  if (n === 16) return Buffer.concat([Buffer.from([0xd8, type]), payload]);
  if (n <= 0xff) {
    return Buffer.concat([Buffer.from([0xc7, n, type]), payload]);
  }
  if (n <= 0xffff) {
    return Buffer.concat([
      Buffer.from([0xc8, (n >> 8) & 0xff, n & 0xff, type]),
      payload,
    ]);
  }
  throw new Error('payload too large for test helper');
}

function isExt42(buf) {
  const b0 = buf[0];
  if (b0 === 0xd4 || b0 === 0xd5 || b0 === 0xd6 || b0 === 0xd7 || b0 === 0xd8) {
    return buf[1] === 0x42;
  }
  if (b0 === 0xc7) return buf[2] === 0x42;
  if (b0 === 0xc8) return buf[3] === 0x42;
  if (b0 === 0xc9) return buf[4] === 0x42;
  return false;
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

  it('does not use ext 0x42 for in-range bigint', () => {
    assert.equal(isExt42(msgpack.pack(0n)), false);
    assert.equal(isExt42(msgpack.pack(1n)), false);
    assert.equal(isExt42(msgpack.pack(2n ** 64n - 1n)), false);
    assert.equal(isExt42(msgpack.pack(-(2n ** 63n))), false);
    assert.equal(isExt42(msgpack.pack(reporter)), false);
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

describe('BigInt ext 0x42', () => {
  const uint256Max = (1n << 256n) - 1n;
  const justOverUint64 = 2n ** 64n;
  const justUnderInt64 = -(2n ** 63n) - 1n;

  it('round-trips 2^64 as ext 0x42 matching msgpackr payload', () => {
    const packed = msgpack.pack(justOverUint64);
    assert.equal(isExt42(packed), true);
    assert.deepEqual(packed, ext42Wire(bigintExtPayload(justOverUint64)));
    const got = msgpack.unpack(packed);
    assert.equal(typeof got, 'bigint');
    assert.equal(got, justOverUint64);
  });

  it('round-trips -2^63-1 as ext 0x42 matching msgpackr payload', () => {
    const packed = msgpack.pack(justUnderInt64);
    assert.equal(isExt42(packed), true);
    assert.deepEqual(packed, ext42Wire(bigintExtPayload(justUnderInt64)));
    assert.equal(msgpack.unpack(packed), justUnderInt64);
  });

  it('round-trips uint256 max (2^256-1)', () => {
    const packed = msgpack.pack(uint256Max);
    assert.equal(isExt42(packed), true);
    assert.deepEqual(packed, ext42Wire(bigintExtPayload(uint256Max)));
    assert.equal(msgpack.unpack(packed), uint256Max);
  });

  it('round-trips nested ext BigInt in arrays, maps, and objects', () => {
    const payload = { n: uint256Max, a: [justOverUint64, { k: justUnderInt64 }] };
    const got = msgpack.unpack(msgpack.pack(payload));
    assert.equal(got.n, uint256Max);
    assert.equal(got.a[0], justOverUint64);
    assert.equal(got.a[1].k, justUnderInt64);
  });

  it('lazy-unpacks nested ext BigInt', () => {
    const packed = msgpack.pack({ n: uint256Max, a: [justOverUint64] });
    const got = msgpack.unpack(packed, { lazy: true });
    assert.equal(got.n, uint256Max);
    assert.equal(got.a[0], justOverUint64);
  });

  it('packs the 256-byte payload limit and rejects one bit over', () => {
    const atLimit = 2n ** 2047n - 1n;
    const packed = msgpack.pack(atLimit);
    assert.equal(isExt42(packed), true);
    assert.equal(msgpack.unpack(packed), atLimit);

    assert.throws(
      () => msgpack.pack(2n ** 2047n),
      /cannot pack BigInt: ext payload exceeds 256 bytes/
    );
    assert.throws(
      () => msgpack.pack(2n ** 2048n),
      /cannot pack BigInt: ext payload exceeds 256 bytes/
    );
    assert.doesNotThrow(() => msgpack.pack(-(2n ** 2047n)));
    assert.equal(msgpack.unpack(msgpack.pack(-(2n ** 2047n))), -(2n ** 2047n));
    assert.throws(
      () => msgpack.pack(-(2n ** 2047n) - 1n),
      /cannot pack BigInt: ext payload exceeds 256 bytes/
    );
  });

  it('unpacks a crafted ext 0x42 larger than 256 bytes as a catchable error', () => {
    const n = 257;
    const payload = Buffer.alloc(n, 0x01);
    payload[0] = 0x00;
    const wire = Buffer.concat([
      Buffer.from([0xc8, (n >> 8) & 0xff, n & 0xff, 0x42]),
      payload,
    ]);
    assert.throws(
      () => msgpack.unpack(wire),
      /cannot unpack BigInt: ext payload exceeds 256 bytes/
    );
  });

  it('throws on empty ext 0x42 payload', () => {
    assert.throws(() => msgpack.unpack(Buffer.from([0xc7, 0x00, 0x42])), /cannot unpack BigInt/);
  });

  it('still refuses other ext types', () => {
    assert.throws(() => msgpack.unpack(Buffer.from([0xd4, 0x01, 0x00])), /cannot unpack ext type/);
    assert.throws(() => msgpack.unpack(Buffer.from([0xc7, 0x01, 0x00, 0xff])), /cannot unpack ext type/);
  });

  it('unpacks a non-minimal ext 0x42 payload', () => {
    /* 0x00 0x01 is 1n with an extra sign byte. */
    assert.equal(msgpack.unpack(Buffer.from([0xd5, 0x42, 0x00, 0x01])), 1n);
    assert.equal(typeof msgpack.unpack(Buffer.from([0xd5, 0x42, 0x00, 0x01])), 'bigint');
  });

  it('does not let pack() type/family hints truncate into 64-bit integers', () => {
    assert.throws(
      () => msgpack.pack(uint256Max, { type: 'uint64' }),
      /cannot pack value as uint64/
    );
    assert.throws(
      () => msgpack.pack(justOverUint64, { family: 'int' }),
      /cannot pack value as int/
    );
    assert.throws(
      () => msgpack.pack(justUnderInt64, { type: 'int64' }),
      /cannot pack value as int64/
    );
  });
});
