`node-msgpack` is an addon for [Node.js](https://nodejs.org) that serializes
and de-serializes JavaScript values with [MessagePack](https://msgpack.org).
Packed output is a `Buffer` and is typically much smaller than JSON.

Version 2.0 requires **Node.js 18+**, vendors **msgpack-c c-7.0.2**, and
rejects oversized unpack headers instead of allocating them. See
[`SECURITY.md`](SECURITY.md).

### Usage

```javascript
const assert = require('assert');
const msgpack = require('msgpack');

const o = { a: 1, b: 2, c: [1, 2, 3] };
const b = msgpack.pack(o);
const oo = msgpack.unpack(b);

assert.deepEqual(oo, o);
```

`pack()` accepts any JSON-like value plus Node `Buffer`s and `Date`s.
`unpack()` consumes a `Buffer` and returns a JavaScript value, or `null` if
the buffer is a truncated (incomplete) MessagePack object. Oversized
array/map/string bombs throw.

A streaming helper wraps a readable socket and emits `msg`, plus `error` when
a packet cannot be unpacked (the offending buffer is dropped):

```javascript
const msgpack = require('msgpack');
const ms = new msgpack.Stream(socket);
ms.on('msg', (m) => {
  console.log('received', m);
});
ms.on('error', (e) => {
  console.error('bad packet', e.message);
});
ms.send({ hello: 'world' });
```

### Type mapping (2.0)

Packing:

* `undefined` / `null` → nil
* `boolean` → bool
* finite integers → uint/int
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

Unpacking:

* nil → `null`
* bool / int / float → JS boolean / number
* str → `string`
* bin → `Buffer`
* array / map → Array / Object
* ext → throws

`unpack.bytes_remaining` is the number of unused trailing bytes after the last
successful (or attempted) unpack. Stream uses that to splice leftover data.

### Limits

* array/map length ≤ 1,000,000
* str/bin/ext length ≤ 32 MiB
* nesting depth ≤ 512 on both pack and unpack

The payload `dd ff 00 00 00` throws `msgpack unpack limit exceeded`. Packing a
value nested deeper than 512 throws `Cowardly refusing to pack object nested
more than 512 levels deep` instead of overflowing the C stack.

### Building, installation, testing

```
npm install
npm test
npm run coverage
```

Needs a C/C++ toolchain and Python (node-gyp). GitHub Actions runs Node 18/20/22
on Ubuntu and macOS. `npm run coverage` instruments JavaScript with c8 and the
native addon with gcov, and fails under 95%. Gates and remaining uncovered
lines are documented in [`COVERAGE.md`](COVERAGE.md).

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
message in its input. Both exit non-zero on invalid or truncated input.

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
