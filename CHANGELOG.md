# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.2.0] - 2026-09-19

Optional second-argument unpack option `{ lazy: true }` wraps maps and arrays
as accessors so nested values are not converted until they are read. See `#40`.

### Added

- `unpack(buf, { lazy: true })` keeps the decoder zone alive and returns maps
  as objects with accessor own-properties and arrays as array-likes with
  indexed accessors (`length`, `in`, `Object.keys`). Nested maps and arrays
  stay lazy until a property is read.
- `toJSON` and `util.inspect.custom` materialize through the eager converter,
  so `JSON.stringify` and `util.inspect` match eager unpack. `pack()` of a
  lazy value also round-trips because it calls `toJSON`.
- Primitives, incomplete buffers, trailing `bytes_remaining`, and the DoS
  limits are unchanged. `__proto__` / `constructor` stay own properties.
- Lazy unpack copies the input before decode so str/bin do not alias the
  caller's Buffer. Transferring that Buffer after unpack cannot dangle
  later property reads.

## [3.1.0] - 2026-09-19

Optional second-argument pack hints force a MessagePack wire type or family
without changing the default mapping. Two or more values still pack as an
array. See `#52`.

### Added

- `pack(value, { type })` writes a fixed MessagePack type (`fixint`,
  `uint8`…`uint64`, `int8`…`int64`, `float32`/`float64`, `fixstr`/`str8`…
  `str32`, `bin8`…`bin32`, `nil`/`true`/`false`). Out-of-range values throw
  `cannot pack value as <type>`.
- `pack(value, { family })` picks a compact encoding in that family (`int`,
  `float`, `str`, `bin`). `type` wins if both are set.
- `pack(array, { interpret })` maps each element through `interpret(item)`
  which must return `{ data }` and may also set `type` / `family`.
- Detection is last-argument, two-arg only: the object must own-enumerate
  only `type`, `family`, and/or `interpret`. Extra keys, one-arg objects, and
  `pack(1, 2)` keep the old array packing.

## [3.0.0] - 2026-09-19

Integers whose magnitude is greater than `Number.MAX_SAFE_INTEGER` unpack as
`bigint` instead of a rounded `number`. Values that fit stay `number`
regardless of wire width. `pack()` accepts `bigint` in the signed/unsigned
64-bit range.

### Added

- `pack()` encodes `bigint` via `v8::BigInt` `Int64Value` / `Uint64Value` as
  the smallest MessagePack integer family that fits.
- Unpack of uint64/int64 values outside `Number.MAX_SAFE_INTEGER` returns
  `bigint` so 64-bit integers stay exact (`#37`).

### Changed

- A uint64 of `1` still unpacks as Number `1`. `Number.MAX_SAFE_INTEGER`
  stays Number even when the wire type is uint64.
- A JS `number` that is already rounded (for example `18446464814936021000`)
  still packs on the Number path; lost bits are not recovered.

### Breaking

- Unpacking a 64-bit integer larger than `Number.MAX_SAFE_INTEGER` now
  returns `bigint` instead of the nearest double. Code that assumed
  `typeof unpack(...) === 'number'` for every integer must accept `bigint`.
- `pack(10n)` no longer throws `cannot pack object`. BigInt outside
  uint64/int64 (`2n ** 64n`, `-(2n ** 63n) - 1n`) throws
  `cannot pack BigInt outside 64-bit range`.

## [2.0.0] - 2026-09-18

Security modernization. Requires **Node.js 18+**. Vendors **msgpack-c c-7.0.2**.
GitHub Actions tests Node 18/20/22 on Ubuntu, macOS, and Windows 2022.

### Added

- Fail-closed unpack limits: array/map length ≤ 1,000,000, str/bin/ext ≤ 32 MiB,
  nesting depth ≤ 512. The bomb `dd ff 00 00 00` throws instead of allocating.
- Pack recursion cap of 512 (deep input throws instead of SIGSEGV).
- `Stream` emits `error` on unpack throw and drops the offending buffer.
- `worker_threads` support (`NAN_MODULE_WORKER_ENABLED`, thread-local sbuffer
  pool and `bytes_remaining`).
- TypeScript types (`index.d.ts`).
- `node:test` suite, c8 + gcov coverage gated at 95%.
- `SECURITY.md` and `COVERAGE.md`.

### Changed

- `nan` is `^2.23.1` (installs 2.x current).
- `binding.gyp` no longer pins `-std=c++11`.
- node-gyp 10+ uses Python 3.
- Dates pack as ISO-8601 strings (`toISOString()`) at every nesting level.
- Objects with `toJSON()` use that return value at every nesting level.
- Numeric own keys are packed instead of dropped.
- Cycle marks use V8 private symbols so a user key named `_msgpack_stack` is
  kept.
- Integral doubles outside uint64/int64 range (for example `1e30`) pack as
  float64.
- Map keys are installed with `DefineOwnProperty` so a wire `__proto__` cannot
  replace the decoded object's prototype.
- Property reads during pack go through `Nan::TryCatch` (throwing getters and
  Proxy traps raise a catchable error).
- `Stream` snapshots `bytes_remaining` and consumes the frame **before**
  `emit('msg')`, so a listener that unpacks or throws cannot desync or replay.
- `Stream` emits packed integer `0` and packed `null` as real messages.

### Fixed

- Top-level `Buffer` packs as MessagePack bin, not `Buffer.prototype.toJSON`'s
  `{type, data}` map (`#49`).
- sbuffer leak on pack throw (`#25686`).
- Python msgpack maps with bin8 payloads unpack (`#10`).
- `Stream` no longer skips packed `0` (`#44`).

### Security

- Unpacker rejects oversized headers before the C decoder allocates.
- Pack throw paths free or return pooled sbuffers on every exit.
- msgpack-c c-7.0.2 includes unpacker buffer-expansion overflow checks.

[Unreleased]: https://github.com/msgpack/msgpack-node/compare/v3.2.0...HEAD
[3.2.0]: https://github.com/msgpack/msgpack-node/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/msgpack/msgpack-node/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/msgpack/msgpack-node/compare/e04c9b55f98d64512174d6e859b8294b729659a2...HEAD
[2.0.0]: https://github.com/msgpack/msgpack-node/commit/e04c9b55f98d64512174d6e859b8294b729659a2
