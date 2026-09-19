'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const msgpack = require('../lib/msgpack');

describe('unpack({ lazy: true })', () => {
  it('matches the issue #40 example', () => {
    const o = msgpack.unpack(msgpack.pack({ a: 1, b: 2, c: [1, 2, 3] }), { lazy: true });
    assert.equal(o.a, 1);
    assert.equal(o.c[1], 2);
    assert.deepEqual(JSON.parse(JSON.stringify(o)), { a: 1, b: 2, c: [1, 2, 3] });
  });

  it('does not convert nested values until they are read', () => {
    const o = msgpack.unpack(msgpack.pack({ a: { b: 1 }, c: [1, 2, 3] }), { lazy: true });
    assert.equal(Array.isArray(o.c), false);
    assert.equal(o.c.length, 3);
    assert.equal(o.a.b, 1);
    assert.equal(typeof o.a.toJSON, 'function');
  });

  it('materializes via toJSON for JSON.stringify and pack()', () => {
    const src = { a: 1, b: 2, c: [1, 2, 3] };
    const o = msgpack.unpack(msgpack.pack(src), { lazy: true });
    assert.deepEqual(msgpack.unpack(msgpack.pack(o)), src);
    assert.match(util.inspect(o), /a: 1/);
  });

  it('unpacks top-level arrays as array-likes', () => {
    const o = msgpack.unpack(msgpack.pack([1, 2, 3]), { lazy: true });
    assert.equal(Array.isArray(o), false);
    assert.equal(o.length, 3);
    assert.equal(o[0], 1);
    assert.equal(o[2], 3);
    assert.equal(o[99], undefined);
    assert.equal(1 in o, true);
    assert.equal(99 in o, false);
    assert.deepEqual(Object.keys(o), ['0', '1', '2']);
    assert.deepEqual(JSON.parse(JSON.stringify(o)), [1, 2, 3]);
  });

  it('unpacks empty maps and arrays', () => {
    assert.deepEqual(
      JSON.parse(JSON.stringify(msgpack.unpack(msgpack.pack({}), { lazy: true }))),
      {}
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(msgpack.unpack(msgpack.pack([]), { lazy: true }))),
      []
    );
  });

  it('still unpacks primitives eagerly', () => {
    assert.equal(msgpack.unpack(msgpack.pack(1), { lazy: true }), 1);
    assert.equal(msgpack.unpack(msgpack.pack(null), { lazy: true }), null);
    assert.equal(msgpack.unpack(msgpack.pack(true), { lazy: true }), true);
    assert.equal(msgpack.unpack(msgpack.pack('hi'), { lazy: true }), 'hi');
  });

  it('keeps bigint, Buffer, and integer keys', () => {
    const big = 18446464814936021036n;
    const o = msgpack.unpack(
      msgpack.pack({ n: big, b: Buffer.from('hi'), 1: 'a' }),
      { lazy: true }
    );
    assert.equal(o.n, big);
    assert.ok(Buffer.isBuffer(o.b));
    assert.equal(o.b.toString(), 'hi');
    assert.equal(o[1], 'a');
  });

  it('does not treat a second-arg array as options', () => {
    const packed = msgpack.pack({ a: 1 });
    const o = msgpack.unpack(packed, [{ lazy: true }]);
    assert.deepEqual(o, { a: 1 });
    assert.equal(typeof o.toJSON, 'undefined');
  });

  it('does not treat a non-object second argument as options', () => {
    const packed = msgpack.pack({ a: 1 });
    const o = msgpack.unpack(packed, 0);
    assert.deepEqual(o, { a: 1 });
    assert.equal(typeof o.toJSON, 'undefined');
  });

  it('ignores lazy when it is not boolean true', () => {
    const o = msgpack.unpack(msgpack.pack({ a: 1 }), { lazy: 1 });
    assert.deepEqual(o, { a: 1 });
    assert.equal(typeof o.toJSON, 'undefined');
  });

  it('returns null for incomplete input even with lazy', () => {
    assert.equal(msgpack.unpack(Buffer.from([0x81]), { lazy: true }), null);
    assert.equal(msgpack.unpack.bytes_remaining, 1);
  });

  it('still reports trailing bytes after a lazy unpack', () => {
    const first = msgpack.pack({ a: 1 });
    const second = msgpack.pack(2);
    const buf = Buffer.concat([first, second]);
    const o = msgpack.unpack(buf, { lazy: true });
    assert.equal(o.a, 1);
    assert.equal(msgpack.unpack.bytes_remaining, second.length);
  });

  it('throws on nested ext only when the value is read', () => {
    /* map1, str "x", fixext1 type 0 data 0 */
    const wire = Buffer.from([0x81, 0xa1, 0x78, 0xd4, 0x00, 0x00]);
    const o = msgpack.unpack(wire, { lazy: true });
    assert.throws(() => o.x, /cannot unpack ext type/);
    assert.throws(() => JSON.stringify(o), /cannot unpack ext type/);
  });

  it('throws on nested ext in a lazy array when the index is read', () => {
    /* array1 of fixext1 */
    const wire = Buffer.from([0x91, 0xd4, 0x00, 0x00]);
    const o = msgpack.unpack(wire, { lazy: true });
    assert.throws(() => o[0], /cannot unpack ext type/);
    assert.throws(() => JSON.stringify(o), /cannot unpack ext type/);
  });

  it('does not pollute Object.prototype via a lazy __proto__ key', () => {
    const wire = Buffer.from('81a95f5f70726f746f5f5f81a7697341646d696ec3', 'hex');
    const decoded = msgpack.unpack(wire, { lazy: true });
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
    assert.equal({}.isAdmin, undefined);
    assert.deepEqual(Object.keys(decoded), ['__proto__']);
    const proto = decoded.__proto__;
    assert.equal(proto.isAdmin, true);
    assert.equal({}.isAdmin, undefined);
  });

  it('keeps constructor as an own accessor, not Function.prototype', () => {
    const wire = Buffer.concat([
      Buffer.from([0x81]),
      msgpack.pack('constructor'),
      msgpack.pack(1)
    ]);
    const decoded = msgpack.unpack(wire, { lazy: true });
    assert.equal(decoded.constructor, 1);
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  });

  it('still unpacks eagerly with one argument', () => {
    const src = { a: 1, b: 2, c: [1, 2, 3] };
    const o = msgpack.unpack(msgpack.pack(src));
    assert.deepEqual(o, src);
    assert.equal(typeof o.toJSON, 'undefined');
  });

  it('materializes one nested index without reading sibling keys', () => {
    const o = msgpack.unpack(msgpack.pack({ a: 1, b: 2, c: [1, 2, 3] }), { lazy: true });
    assert.equal(o.c[1], 2);
  });

  it('JSON.stringify of lazy unpack matches eager unpack', () => {
    const src = { a: 1, b: 2, c: [1, 2, 3] };
    const packed = msgpack.pack(src);
    assert.equal(
      JSON.stringify(msgpack.unpack(packed, { lazy: true })),
      JSON.stringify(msgpack.unpack(packed))
    );
  });

  it('rejects toJSON when this is not a lazy object', () => {
    const o = msgpack.unpack(msgpack.pack({ a: 1 }), { lazy: true });
    assert.throws(() => o.toJSON.call({}), /invalid lazy object/);
    assert.throws(() => o.toJSON.call(null), /invalid lazy object/);
  });

  it('still throws on an oversized array header in lazy mode', () => {
    const buf = Buffer.from([0xdd, 0xff, 0x00, 0x00, 0x00]);
    assert.throws(() => msgpack.unpack(buf, { lazy: true }), /limit exceeded/);
  });

  it('still throws on an oversized map header in lazy mode', () => {
    const buf = Buffer.from([0xdf, 0xff, 0x00, 0x00, 0x00]);
    assert.throws(() => msgpack.unpack(buf, { lazy: true }), /limit exceeded/);
  });

  it('indexed lookup on a lazy map falls through to named keys', () => {
    const o = msgpack.unpack(msgpack.pack({ 1: 'a', b: 2 }), { lazy: true });
    assert.equal(o[1], 'a');
    assert.equal(o[99], undefined);
    assert.equal(99 in o, false);
    assert.equal(1 in o, true);
  });
});
