# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/msgpack/msgpack-node/compare/e04c9b55f98d64512174d6e859b8294b729659a2...HEAD
[2.0.0]: https://github.com/msgpack/msgpack-node/commit/e04c9b55f98d64512174d6e859b8294b729659a2
