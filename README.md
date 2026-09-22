`node-msgpack` is an addon for [Node.js](https://nodejs.org) that serializes
and de-serializes JavaScript values with [MessagePack](https://msgpack.org).
Packed output is a `Buffer` and is typically much smaller than JSON.

Version 3.4 requires **Node.js 22.x**, vendors **msgpack-c c-7.0.2**, unpacks
64-bit integers outside `Number.MAX_SAFE_INTEGER` as `bigint`, accepts
optional pack type/family hints, can unpack maps and arrays lazily
(`unpack(buf, { lazy: true })`), and applies write backpressure on
`Stream.send`. See [`SECURITY.md`](SECURITY.md).

### Usage

```javascript
const assert = require('assert');
const msgpack = require('msgpack');

const o = { a: 1, b: 2, c: [1, 2, 3] };
const b = msgpack.pack(o);
const oo = msgpack.unpack(b);

assert.deepEqual(oo, o);
```

`pack()` accepts any JSON-like value plus Node `Buffer`s, `Date`s, and
`bigint` values in the int64/uint64 range. `unpack()` consumes a `Buffer`
and returns a JavaScript value, or `null` if the buffer is a truncated
(incomplete) MessagePack object. Oversized array/map/string bombs throw.

A streaming helper wraps a readable socket and emits `msg`, plus `error` when
a packet cannot be unpacked, the receive buffer would exceed
`MAX_STREAM_BYTES` (the offending buffer is dropped, and the socket is
destroyed when possible), or the underlying stream errors. `send()` packs
and writes; it returns the boolean from the underlying `write()`, or `false`
if the message was queued because a previous write returned `false` and
`drain` has not fired yet. `drain` is re-emitted from the underlying
writable onto the Stream. At most **1024** messages may wait in that queue;
a further `send()` throws. Extra `write` arguments (encoding, callback) are
forwarded on an immediate write. On underlying `error` / `close` / `end`,
queued messages are dropped and Stream emits `error` if any were unsent:

```javascript
const msgpack = require('msgpack');
const ms = new msgpack.Stream(socket);
ms.on('msg', (m) => {
  console.log('received', m);
});
ms.on('error', (e) => {
  console.error('bad packet', e.message);
});
ms.on('drain', () => {
  /* underlying writable is ready for more send() calls */
});
ms.send({ hello: 'world' });
```

### Type mapping (3.0)

Packing:

* `undefined` / `null` → nil
* `boolean` → bool
* finite integers (`number` or `bigint` in the 64-bit range) → uint/int
* `bigint` outside uint64/int64 → ext type 0x42 (msgpackr BigInt, two's-complement, ≤ 256 bytes)
* `bigint` whose two's-complement form exceeds 256 bytes → throws
* other numbers → float64
* `string` → str (UTF-8)
* `Date` → str (ISO 8601, `toISOString()`), at any nesting level
* `Buffer` → bin
* `Array` → array
* objects with a `toJSON()` method → whatever `toJSON()` returns, at any
  nesting level
* other objects → map of every own enumerable key; numeric keys are packed as
  integer keys, not dropped
* functions, circular refs, and nesting deeper than 512 throw

A `number` that is already rounded (for example `18446464814936021000`) packs
on the Number path. Lost bits are not recovered.

Unpacking:

* nil → `null`
* bool / float → JS boolean / number
* int whose magnitude ≤ `Number.MAX_SAFE_INTEGER` → `number` (a uint64 of
  `1` is Number `1`; `Number.MAX_SAFE_INTEGER` stays Number)
* int whose magnitude > `Number.MAX_SAFE_INTEGER` → `bigint`
* str → `string`
* bin → `Buffer`
* array / map → Array / Object
* ext type 0x42 (msgpackr BigInt) → bigint (payload ≤ 256 bytes)
* other ext types → throws

So `unpack(pack(1n))` is Number `1`, and `unpack(pack(18446464814936021036n))`
is that same `bigint`.

`unpack.bytes_remaining` is the number of unused trailing bytes after the last
successful (or attempted) unpack. Stream uses that to splice leftover data.

`unpack(buf, { lazy: true })` wraps maps as objects with accessor
own-properties and arrays as array-likes with indexed accessors. Nested
values are not converted until they are read, which is useful for large
payloads when only a few keys are needed. The decoder copies `buf` so later
reads do not depend on the caller's backing store (transfer / detach is
safe). `JSON.stringify` and `util.inspect` materialize via `toJSON` /
`inspect.custom`. Lazy arrays are not real `Array`s (`Array.isArray` is
false); `pack()` still round-trips them because it calls `toJSON`.
Primitives unpack eagerly even when `lazy` is set. `__proto__` and
`constructor` keys stay own properties, same as eager unpack.

### Pack type hints (3.1)

`pack(value, options)` takes an optional last-argument options object when
there are exactly two arguments and that object own-enumerates only `type`,
`family`, and/or `interpret`. Extra keys, a one-argument `{ type: ... }`
value, and `pack(1, 2)` still pack as values / an array.

```javascript
msgpack.pack(123, { type: 'fixint' });          // 0x7b
msgpack.pack(123, { type: 'uint8' });           // 0xcc 0x7b
msgpack.pack(Math.PI, { type: 'float32' });     // 0xca + 4 bytes
msgpack.pack(buf, { family: 'bin' });
msgpack.pack(1.5, { family: 'int' });           // throws
msgpack.pack(500, { type: 'uint8' });           // throws

msgpack.pack(
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
```

`type` forces that MessagePack type (`fixint`, `uint8`…`uint64`, `int8`…
`int64`, `float32`/`float64`, `fixstr`/`str8`/`str16`/`str32`, `bin8`/`bin16`/
`bin32`, `nil`/`true`/`false`). `family` (`int`, `float`, `str`, `bin`) picks
a compact encoding in that family. If both are set, `type` wins. Out-of-range
values throw `cannot pack value as <type>`.

`interpret` is used when packing an Array. Each element is passed to
`interpret(item)`, which must return `{ data }` and may also set `type` /
`family` for that element. Nested `interpret` on the returned object is
ignored.

Default packing is unchanged when no recognized options object is passed.

### Limits

* array/map length ≤ 1,000,000 on both pack and unpack
* str/bin/ext length ≤ 32 MiB
* nesting depth ≤ 512 on both pack and unpack
* Stream receive buffer ≤ `MAX_STREAM_BYTES` (32 MiB + 16 bytes of framing)
* CLI stdin ≤ `MAX_STDIN_BYTES` (32 MiB) before concat/parse

The payload `dd ff 00 00 00` throws `msgpack unpack limit exceeded`. Packing a
sparse array or map whose length exceeds 1,000,000 throws
`msgpack pack limit exceeded`. Packing a value nested deeper than 512 throws
`Cowardly refusing to pack object nested more than 512 levels deep` instead of
overflowing the C stack. Incomplete Stream frames that would grow past
`MAX_STREAM_BYTES` throw `msgpack stream limit exceeded` before allocate.

### Building, installation, testing

```
npm ci
npm test
npm run coverage
```

Needs a C/C++ toolchain and Python (node-gyp). GitHub Actions runs Node 22
on Ubuntu, macOS, and windows-2022. Node 24 is not advertised: lazy unpack
still uses `SetIndexedPropertyHandler`, which Node 24 V8 removed.
`npm run coverage` instruments JavaScript with c8 and the native addon with
gcov, and fails under 95%. Gates and remaining uncovered lines are
documented in [`COVERAGE.md`](COVERAGE.md).

### Command Line Utilities

Two utilities convert between JSON and MessagePack on stdin/stdout:
`bin/json2msgpack` reads JSON and writes MessagePack, and `bin/msgpack2json`
reads MessagePack and writes JSON. Both are installed on `PATH` when the
package is installed globally.

```
echo '[1, 2, 3]' | ./bin/json2msgpack | xxd
```

```
00000000: 9301 0203                                ....
```

Piping the two together round-trips a value:

```
echo '[1, 2, 3]' | ./bin/json2msgpack | ./bin/msgpack2json
```

```
[1,2,3]
```

```
echo '{"hello":"world"}' | bin/json2msgpack | bin/msgpack2json
```

```
{"hello":"world"}
```

`msgpack2json` prints one JSON value per line and consumes every complete
message in its input. Both exit non-zero on invalid or truncated input, and
both refuse stdin larger than `MAX_STDIN_BYTES` (32 MiB).

### Benchmarks

```
npm run bench
```

or equivalently:

```
node test/benchmark/benchmark.js
```

The benchmark serializes the object `{'abcdef': 1, 'qqq': 13, '19': [1, 2, 3, 4]}`
500,000 times through four paths, after a warm-up pass. A representative run:

```
node       v20.20.2
v8         11.3.244.8-node.38
platform   linux 6.12.76-linuxkit (arm64)
cpu        arm64 (model not reported) x 8, 7.8 GiB RAM
data       {"19":[1,2,3,4],"abcdef":1,"qqq":13}
iterations 500,000

JSON.stringify()                     179 ms  (0.18 s)
JSON.parse(JSON.stringify())         346 ms  (0.35 s)
msgpack.pack()                      1021 ms  (1.02 s)
msgpack.unpack(msgpack.pack())      1585 ms  (1.59 s)
```

Measured on 2026-09-10: Node.js v20.20.2, Debian 12 (bookworm), Linux
6.12.76-linuxkit aarch64 container (8 vCPUs, 7.8 GiB RAM). Numbers are for
that machine and object shape only — re-run `npm run bench` on your own
hardware before drawing conclusions.

On small objects like this one, V8's native JSON codec is faster than crossing
the JS/C++ boundary per call; msgpack's advantage is payload size (20 bytes here
versus 36 for the JSON text) and its ability to carry binary data without
base64. Large `Buffer` payloads and batched (single-call) packing shift the
comparison considerably.

### License

This addon is **BSD-3-Clause** (Copyright (c) 2010, Peter Griess); see
[`LICENSE`](LICENSE).

The vendored MessagePack C library in `deps/msgpack/` is **Boost Software
License 1.0**, as shipped by msgpack-c c-7.0.2; see `deps/msgpack/LICENSE`.
msgpack-c was Apache-2.0 through 1.2.x and relicensed to BSL-1.0 in release
1.3.0 (2015-11-21), so the Boost text is the correct license for these files:

* relicensing discussion: <https://github.com/msgpack/msgpack-c/issues/366>
* msgpack-c `CHANGELOG.md`, 1.3.0: "Change license from Apache 2.0 to Boost
  Software License, Version 1.0 (#386)"
