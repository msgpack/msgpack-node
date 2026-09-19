'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const msgpack = require('../lib/msgpack');

function b(...bytes) {
  return Buffer.from(bytes);
}

function throwsAs(fn, re) {
  assert.throws(fn, (err) => re.test(String(err.message || err)));
}

describe('pack type hints (#52)', () => {
  it('packs 123 as fixint 0x7b', () => {
    assert.deepEqual(msgpack.pack(123, { type: 'fixint' }), b(0x7b));
  });

  it('packs 123 as uint8 0xcc 0x7b', () => {
    assert.deepEqual(msgpack.pack(123, { type: 'uint8' }), b(0xcc, 0x7b));
  });

  it('packs 123 as uint16 / uint32 / uint64 with forced width', () => {
    assert.deepEqual(msgpack.pack(123, { type: 'uint16' }), b(0xcd, 0x00, 0x7b));
    assert.deepEqual(
      msgpack.pack(123, { type: 'uint32' }),
      b(0xce, 0x00, 0x00, 0x00, 0x7b),
    );
    const u64 = msgpack.pack(123, { type: 'uint64' });
    assert.equal(u64[0], 0xcf);
    assert.equal(u64.length, 9);
    assert.equal(msgpack.unpack(u64), 123);
  });

  it('packs signed widths including negative int8', () => {
    assert.deepEqual(msgpack.pack(-1, { type: 'int8' }), b(0xd0, 0xff));
    assert.equal(msgpack.pack(-1, { type: 'int16' })[0], 0xd1);
    assert.equal(msgpack.pack(-1, { type: 'int32' })[0], 0xd2);
    assert.equal(msgpack.pack(-1, { type: 'int64' })[0], 0xd3);
    assert.equal(msgpack.pack(-1, { type: 'int64' }).length, 9);
    assert.equal(msgpack.unpack(msgpack.pack(-1, { type: 'int64' })), -1);
  });

  it('packs Math.PI as float32 (0xca) and float64 (0xcb)', () => {
    const f32 = msgpack.pack(Math.PI, { type: 'float32' });
    assert.equal(f32[0], 0xca);
    assert.equal(f32.length, 5);
    const f64 = msgpack.pack(Math.PI, { type: 'float64' });
    assert.equal(f64[0], 0xcb);
    assert.equal(f64.length, 9);
    assert.equal(msgpack.unpack(f64), Math.PI);
  });

  it('family bin packs a Buffer as bin8', () => {
    const buf = Buffer.from('hi');
    assert.deepEqual(msgpack.pack(buf, { family: 'bin' }), b(0xc4, 0x02, 0x68, 0x69));
  });

  it('family bin packs a string as UTF-8 bin', () => {
    assert.deepEqual(msgpack.pack('hi', { family: 'bin' }), b(0xc4, 0x02, 0x68, 0x69));
  });

  it('family str packs a Buffer as str', () => {
    const packed = msgpack.pack(Buffer.from('hi'), { family: 'str' });
    assert.equal(packed[0], 0xa2);
    assert.equal(msgpack.unpack(packed), 'hi');
  });

  it('family int uses compact integer encoding', () => {
    assert.deepEqual(msgpack.pack(123, { family: 'int' }), b(0x7b));
    assert.deepEqual(msgpack.pack(-1, { family: 'int' }), b(0xff));
  });

  it('family float uses float32 when the value is exact in f32', () => {
    assert.equal(msgpack.pack(1, { family: 'float' })[0], 0xca);
    assert.equal(msgpack.pack(Math.PI, { family: 'float' })[0], 0xcb);
  });

  it('type wins over family', () => {
    assert.deepEqual(
      msgpack.pack(123, { type: 'uint8', family: 'int' }),
      b(0xcc, 0x7b),
    );
  });

  it('interpret packs mixed float64 and float32 array elements', () => {
    const packed = msgpack.pack(
      [
        { data: Math.PI, type: 'float64' },
        { data: 3.14, type: 'float32' },
      ],
      {
        interpret(item) {
          return { data: item.data, type: item.type };
        },
      },
    );
    assert.equal(packed[0], 0x92);
    assert.equal(packed[1], 0xcb);
    assert.equal(packed[10], 0xca);
    assert.equal(packed.length, 15);
  });

  it('pack(1, 2) still packs an array of two values', () => {
    assert.deepEqual(msgpack.unpack(msgpack.pack(1, 2)), [1, 2]);
  });

  it('one-argument { type: "fixint" } packs as a map, not options', () => {
    assert.deepEqual(msgpack.unpack(msgpack.pack({ type: 'fixint' })), {
      type: 'fixint',
    });
  });

  it('extra keys on the second argument keep array packing', () => {
    assert.deepEqual(
      msgpack.unpack(msgpack.pack(123, { type: 'uint8', extra: 1 })),
      [123, { type: 'uint8', extra: 1 }],
    );
  });

  it('empty object second argument is a value, not options', () => {
    assert.deepEqual(msgpack.unpack(msgpack.pack(123, {})), [123, {}]);
  });

  it('throws cannot pack value as uint8 for 500', () => {
    throwsAs(() => msgpack.pack(500, { type: 'uint8' }), /cannot pack value as uint8/);
  });

  it('throws cannot pack value as uint8 for -1', () => {
    throwsAs(() => msgpack.pack(-1, { type: 'uint8' }), /cannot pack value as uint8/);
  });

  it('throws cannot pack value as int for 1.5', () => {
    throwsAs(() => msgpack.pack(1.5, { family: 'int' }), /cannot pack value as int/);
  });

  it('throws cannot pack value as fixint for 1.5', () => {
    throwsAs(() => msgpack.pack(1.5, { type: 'fixint' }), /cannot pack value as fixint/);
  });

  it('throws on unknown type and family', () => {
    throwsAs(() => msgpack.pack(1, { type: 'nope' }), /unknown pack type/);
    throwsAs(() => msgpack.pack(1, { family: 'nope' }), /unknown pack family/);
  });

  it('throws when type/family are not strings', () => {
    throwsAs(() => msgpack.pack(1, { type: 8 }), /pack type must be a string/);
    throwsAs(() => msgpack.pack(1, { family: 1 }), /pack family must be a string/);
  });

  it('throws when interpret is not a function', () => {
    throwsAs(() => msgpack.pack(1, { interpret: 1 }), /pack interpret must be a function/);
  });

  it('ignores interpret on a non-array value', () => {
    assert.deepEqual(
      msgpack.pack(123, {
        interpret() {
          throw new Error('should not run');
        },
      }),
      b(0x7b),
    );
  });

  it('nil, true, and false types', () => {
    assert.deepEqual(msgpack.pack(null, { type: 'nil' }), b(0xc0));
    assert.deepEqual(msgpack.pack(undefined, { type: 'nil' }), b(0xc0));
    assert.deepEqual(msgpack.pack(true, { type: 'true' }), b(0xc3));
    assert.deepEqual(msgpack.pack(false, { type: 'false' }), b(0xc2));
    throwsAs(() => msgpack.pack(1, { type: 'nil' }), /cannot pack value as nil/);
    throwsAs(() => msgpack.pack(false, { type: 'true' }), /cannot pack value as true/);
    throwsAs(() => msgpack.pack(true, { type: 'false' }), /cannot pack value as false/);
  });

  it('forces str8 even when fixstr would fit', () => {
    assert.equal(msgpack.pack('hi')[0] & 0xe0, 0xa0);
    assert.deepEqual(msgpack.pack('hi', { type: 'str8' }), b(0xd9, 0x02, 0x68, 0x69));
  });

  it('throws when a string is too long for fixstr', () => {
    throwsAs(
      () => msgpack.pack('x'.repeat(32), { type: 'fixstr' }),
      /cannot pack value as fixstr/,
    );
    assert.equal(msgpack.pack('x'.repeat(32), { type: 'str8' })[0], 0xd9);
  });

  it('forces bin16 for a 256-byte Buffer', () => {
    const buf = Buffer.alloc(256, 7);
    const packed = msgpack.pack(buf, { type: 'bin16' });
    assert.equal(packed[0], 0xc5);
    assert.equal(packed.length, 259);
    throwsAs(
      () => msgpack.pack(buf, { type: 'bin8' }),
      /cannot pack value as bin8/,
    );
  });

  it('packs Date as str via toISOString when type/family is str', () => {
    const d = new Date('2020-01-02T03:04:05.000Z');
    const packed = msgpack.pack(d, { type: 'str8' });
    assert.equal(packed[0], 0xd9);
    assert.equal(msgpack.unpack(packed), d.toISOString());
  });

  it('BigInt plus integer type uses the 64-bit path', () => {
    assert.deepEqual(msgpack.pack(123n, { type: 'uint8' }), b(0xcc, 0x7b));
    throwsAs(() => msgpack.pack(500n, { type: 'uint8' }), /cannot pack value as uint8/);
    throwsAs(() => msgpack.pack(-1n, { type: 'uint64' }), /cannot pack value as uint64/);
    const i64 = msgpack.pack(1n, { type: 'int64' });
    assert.equal(i64[0], 0xd3);
    assert.equal(i64.length, 9);
    assert.equal(msgpack.unpack(i64), 1);
  });

  it('interpret must return { data }', () => {
    throwsAs(
      () => msgpack.pack([1], { interpret: () => 1 }),
      /interpret must return \{ data \}/,
    );
    throwsAs(
      () => msgpack.pack([1], { interpret: () => ({}) }),
      /interpret must return \{ data \}/,
    );
  });

  it('interpret exceptions surface to the caller', () => {
    throwsAs(
      () =>
        msgpack.pack([1], {
          interpret() {
            throw new Error('nope');
          },
        }),
      /nope/,
    );
  });

  it('default pack of 123 is still fixint', () => {
    assert.deepEqual(msgpack.pack(123), b(0x7b));
  });

  it('does not treat host objects as pack options', () => {
    const seconds = [
      new Date(),
      function hint() {},
      /x/,
      new Error('e'),
      Promise.resolve(1),
      new Uint8Array([1]),
      new ArrayBuffer(1),
      new SharedArrayBuffer(1),
      new DataView(new ArrayBuffer(1)),
      Buffer.from('x'),
    ];
    for (const second of seconds) {
      let packed;
      try {
        packed = msgpack.pack(123, second);
      } catch (err) {
        // Host object was not treated as options; packing the value failed.
        assert.ok(err);
        continue;
      }
      assert.notDeepEqual(Buffer.from(packed), b(0xcc, 0x7b));
      assert.notDeepEqual(Buffer.from(packed), b(0x7b));
    }
  });

  it('symbol own keys keep array packing', () => {
    const opts = {};
    Object.defineProperty(opts, Symbol('type'), {
      enumerable: true,
      value: 'uint8',
    });
    const packed = msgpack.pack(123, opts);
    assert.notDeepEqual(Buffer.from(packed), b(0xcc, 0x7b));
    assert.equal(msgpack.unpack(packed)[0], 123);
  });

  it('ownKeys throwing proxy surfaces from GetOwnPropertyNames', () => {
    const opts = new Proxy(
      { type: 'uint8' },
      {
        ownKeys() {
          throw new Error('ownKeys boom');
        },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true };
        },
      },
    );
    throwsAs(() => msgpack.pack(123, opts), /ownKeys boom/);
  });

  it('undefined or null type and family fall through', () => {
    assert.deepEqual(msgpack.pack(123, { type: undefined }), b(0x7b));
    assert.deepEqual(msgpack.pack(123, { type: null }), b(0x7b));
    assert.deepEqual(msgpack.pack(123, { family: null }), b(0x7b));
    assert.deepEqual(msgpack.pack(123, { type: undefined, family: 'int' }), b(0x7b));
    assert.deepEqual(msgpack.pack(123, { family: undefined, type: 'uint8' }), b(0xcc, 0x7b));
  });

  it('non-number values cannot pack as integer or float types', () => {
    throwsAs(() => msgpack.pack('1', { type: 'fixint' }), /cannot pack value as fixint/);
    throwsAs(() => msgpack.pack('1', { type: 'uint64' }), /cannot pack value as uint64/);
    throwsAs(() => msgpack.pack('1', { type: 'float32' }), /cannot pack value as float32/);
    throwsAs(() => msgpack.pack('1', { type: 'float64' }), /cannot pack value as float64/);
    throwsAs(() => msgpack.pack('1', { family: 'int' }), /cannot pack value as int/);
    throwsAs(() => msgpack.pack('1', { family: 'float' }), /cannot pack value as float/);
    throwsAs(() => msgpack.pack(true, { type: 'int8' }), /cannot pack value as int8/);
    throwsAs(() => msgpack.pack(NaN, { type: 'int32' }), /cannot pack value as int32/);
    throwsAs(() => msgpack.pack(Infinity, { type: 'uint32' }), /cannot pack value as uint32/);
    throwsAs(() => msgpack.pack(-Infinity, { family: 'int' }), /cannot pack value as int/);
  });

  it('rejects integers outside the requested width', () => {
    throwsAs(() => msgpack.pack(128, { type: 'fixint' }), /cannot pack value as fixint/);
    throwsAs(() => msgpack.pack(-33, { type: 'fixint' }), /cannot pack value as fixint/);
    throwsAs(() => msgpack.pack(128, { type: 'int8' }), /cannot pack value as int8/);
    throwsAs(() => msgpack.pack(-129, { type: 'int8' }), /cannot pack value as int8/);
    throwsAs(() => msgpack.pack(32768, { type: 'int16' }), /cannot pack value as int16/);
    throwsAs(() => msgpack.pack(2147483648, { type: 'int32' }), /cannot pack value as int32/);
    throwsAs(() => msgpack.pack(65536, { type: 'uint16' }), /cannot pack value as uint16/);
    throwsAs(() => msgpack.pack(0x100000000, { type: 'uint32' }), /cannot pack value as uint32/);
    throwsAs(() => msgpack.pack(2 ** 63, { type: 'int64' }), /cannot pack value as int64/);
    throwsAs(() => msgpack.pack(-1e20, { type: 'int64' }), /cannot pack value as int64/);
    throwsAs(() => msgpack.pack(2 ** 64, { type: 'uint64' }), /cannot pack value as uint64/);
    throwsAs(
      () => msgpack.pack((1n << 64n) - 1n, { type: 'int64' }),
      /cannot pack value as int64/,
    );
  });

  it('family int uses uint64 when the value is above INT64_MAX', () => {
    const packed = msgpack.pack(2 ** 63, { family: 'int' });
    assert.equal(packed[0], 0xcf);
    assert.equal(msgpack.unpack(packed), 2n ** 63n);
    const maxu = msgpack.pack((1n << 64n) - 1n, { family: 'int' });
    assert.equal(maxu[0], 0xcf);
    assert.equal(msgpack.unpack(maxu), (1n << 64n) - 1n);
  });

  it('packs str16, str32, and bin32 forced widths', () => {
    const s256 = 'x'.repeat(256);
    const str16 = msgpack.pack(s256, { type: 'str16' });
    assert.equal(str16[0], 0xda);
    assert.equal(msgpack.unpack(str16), s256);
    const str32 = msgpack.pack('hi', { type: 'str32' });
    assert.equal(str32[0], 0xdb);
    assert.equal(msgpack.unpack(str32), 'hi');
    const bin32 = msgpack.pack(Buffer.from('hi'), { type: 'bin32' });
    assert.equal(bin32[0], 0xc6);
    assert.equal(msgpack.unpack(bin32).toString(), 'hi');
    throwsAs(
      () => msgpack.pack('x'.repeat(256), { type: 'str8' }),
      /cannot pack value as str8/,
    );
    throwsAs(
      () => msgpack.pack('x'.repeat(65536), { type: 'str16' }),
      /cannot pack value as str16/,
    );
    throwsAs(
      () => msgpack.pack(Buffer.alloc(65536), { type: 'bin16' }),
      /cannot pack value as bin16/,
    );
  });

  it('packs a short string as fixstr and non-finite family float as float64', () => {
    assert.deepEqual(msgpack.pack('hi', { type: 'fixstr' }), b(0xa2, 0x68, 0x69));
    assert.equal(msgpack.pack(Infinity, { family: 'float' })[0], 0xcb);
    assert.equal(msgpack.pack(-Infinity, { family: 'float' })[0], 0xcb);
    assert.equal(msgpack.pack(NaN, { family: 'float' })[0], 0xcb);
  });

  it('rejects non-string and non-buffer values for str and bin', () => {
    throwsAs(() => msgpack.pack(1, { type: 'str8' }), /cannot pack value as str8/);
    throwsAs(() => msgpack.pack(1, { type: 'bin8' }), /cannot pack value as bin8/);
    throwsAs(() => msgpack.pack(1, { family: 'str' }), /cannot pack value as str/);
    throwsAs(() => msgpack.pack(1, { family: 'bin' }), /cannot pack value as bin/);
  });

  it('throws when a Date has no toISOString function', () => {
    const d = new Date('2020-01-02T03:04:05.000Z');
    d.toISOString = 1;
    throwsAs(() => msgpack.pack(d, { type: 'str8' }), /cannot pack Date/);
  });

  it('interpret returning family still packs data', () => {
    const packed = msgpack.pack([123], {
      interpret() {
        return { data: 123, family: 'int', extra: 1 };
      },
    });
    assert.deepEqual(msgpack.unpack(packed), [123]);
  });

  it('interpret does not recurse into nested arrays', () => {
    const packed = msgpack.pack([[1, 2]], {
      interpret(item) {
        return { data: item };
      },
    });
    assert.deepEqual(msgpack.unpack(packed), [[1, 2]]);
  });

  it('interpret data that is circular is refused by the default packer', () => {
    const a = [];
    a.push(a);
    throwsAs(
      () =>
        msgpack.pack([0], {
          interpret() {
            return { data: a };
          },
        }),
      /circular/,
    );
  });

  it('interpret rejects Date, Array, Function, and Buffer returns', () => {
    throwsAs(
      () => msgpack.pack([1], { interpret: () => new Date() }),
      /interpret must return \{ data \}/,
    );
    throwsAs(
      () => msgpack.pack([1], { interpret: () => [1] }),
      /interpret must return \{ data \}/,
    );
    throwsAs(
      () => msgpack.pack([1], { interpret: () => function () {} }),
      /interpret must return \{ data \}/,
    );
    throwsAs(
      () => msgpack.pack([1], { interpret: () => Buffer.from('x') }),
      /interpret must return \{ data \}/,
    );
  });
});
