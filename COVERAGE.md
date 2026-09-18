# Coverage — msgpack 2.0.0

`npm run coverage` runs both halves and fails the build under 95%.

| Target | Metric | Result | Gate |
| --- | --- | --- | --- |
| `lib/` + `bin/` (c8) | statements | **100%** | ≥ 95% |
| `lib/` + `bin/` (c8) | branches | **100%** | ≥ 95% |
| `lib/` + `bin/` (c8) | functions | **100%** | ≥ 95% |
| `lib/` + `bin/` (c8) | lines | **100%** | ≥ 95% |
| `src/msgpack.cc` (gcovr) | lines | **95.9%** (473/493) | ≥ 95% |
| `src/msgpack.cc` (gcovr) | branches | **99.5%** (400/402) | ≥ 95% |
| `src/msgpack.cc` (gcovr) | functions | 100% (36/36) | — |

`deps/` is excluded from the native report; the vendored msgpack-c is not our
code. `build/` is rebuilt without instrumentation at the end of
`coverage:native`, including when the gate fails, so the working tree is never
left with a `--coverage` addon. `npm install` and `node-gyp rebuild` are
unaffected: coverage flags only apply when `msgpack_coverage=1` is passed.

Measured on Linux / Node 20 / GCC. Reproduce with:

```
npm run coverage          # both, with thresholds
npm run coverage:js       # c8 only
npm run coverage:native   # gcovr only
```

## Remaining uncovered JS

None. `lib/msgpack.js`, `bin/json2msgpack` and `bin/msgpack2json` are at 100%
on all four metrics.

One `bin/json2msgpack` path deserves a note because it looked unreachable at
first: the `msgpack.pack()` failure arm. `JSON.parse` cannot produce a
function, a circular structure, a Symbol or a BigInt, so almost every pack
error is out of reach from real JSON. It *can* produce arbitrarily deep
nesting, which trips the 512-level pack cap — that is what `test/cli.test.js`
uses to cover the arm.

## Remaining uncovered native lines (20 of 493)

Every one is an error arm that cannot be entered from JS without stubbing
`malloc` or V8. None were removed to raise the number.

| Lines | Code | Why it is not reached |
| --- | --- | --- |
| 307–308 | `default: return kScanParse;` in `ScanOne` | Dead by construction. The `switch` runs only for bytes `0xc0`–`0xdf` (everything else is handled by the fixint/fixmap/fixarray/fixstr tests above it) and all 32 of those values have explicit cases. |
| 370, 390 | `Error("Error serializing object")` in `CallNoArgs` / `ThrowCaught` | Fallback for an empty `MaybeLocal` with no pending exception. V8 always sets an exception before returning an empty Maybe. |
| 433–434 | `Unmark(arr); throw` after `msgpack_pack_array` | `msgpack_sbuffer_write` fails only when `realloc` fails. |
| 486–487 | `Unmark(obj); throw` after `msgpack_pack_map` | Same. |
| 567 | `if (rc) throw` in `JsToMsgpack` | Same — every `rc` comes from an sbuffer write. |
| 624 | `throw Error("cannot unpack map key")` | Needs `Nan::To<v8::String>` to fail. Decoded map keys are nil / bool / number / string / Buffer / Array / plain Object, none of which can throw in `ToString`. |
| 631, 634 | `default: throw Error("Encountered unknown object type")` in `MsgpackToJs` | All 11 `msgpack_object_type` values are handled explicitly. |
| 675 | `throw Error("Error initializing packing buffer")` | `msgpack_sbuffer_new` returns NULL only out of memory. |
| 735 | `throw` after `msgpack_pack_array` in `Pack` | Allocation failure only. |
| 809–813, 815 | `MSGPACK_UNPACK_CONTINUE` / parse-error tail of `Unpack` | `ScanOne` walks the same grammar first with limits at or below the vendored library's own (511 vs 512 nested containers, the same 1 000 000 element cap), so once it returns `kScanOk`, `msgpack_unpack_next` can only succeed. The arms stay so a future divergence fails closed instead of reading `result.data` uninitialised. |

## Remaining uncovered native branches (2 of 402)

| Line | Code | Why |
| --- | --- | --- |
| 148 | `switch (b)` in `ScanOne` | The `default:` edge — see lines 307–308 above. It cannot be excluded on its own without also dropping the 30 covered case edges on the same line, so it is left in and counted against us. |
| 575 | `switch (mo->type)` in `MsgpackToJs` | Same, for the `default:` edge covering the complete `msgpack_object_type` enum. |

## About the native branch number

Raw gcov branch data for this file is dominated by artefacts, not by test
gaps. The three numbers, all from the same run:

| gcovr invocation | Branches | Result |
| --- | --- | --- |
| `--no-markers` (fully raw) | 636 | 70.6% |
| `--no-markers --exclude-throw-branches --exclude-unreachable-branches` | 502 | 86.3% |
| as shipped (markers honoured) | 402 | **99.5%** |

Two mechanisms account for the difference, and both are worth understanding
before reading 99.5% as "almost everything is tested":

1. **`--exclude-throw-branches`** drops 134 edges. This is a compiled-with-
   exceptions C++ file, so gcov emits a "call threw / call returned" edge for
   nearly every function call inside a `try`. Those are not decisions in the
   source and no test can flip most of them.

2. **`GCOVR_EXCL_BR_*` markers in `src/msgpack.cc`** drop a further 100 edges
   across 45 lines. Each marker carries its reason inline. They are comments
   only — no production code was deleted, and every guarded branch is still
   compiled and still runs. The full set:

   - **Allocation-failure arms (lines 432–434, 485–487, 529, 543, 553, 566,
     567, 674, 675, 734, 735).** `msgpack_pack_array/map/str/bin/*_body` fail
     only when the sbuffer cannot grow.
   - **`Skip()` after a successful `CheckBytes()` (lines 144, 160, 168, 176,
     185, 194, 203, 256, 264, 272).** `CheckBytes` returns `kScanOk` only when
     `n <= remaining`, so the following `Skip(&c, n)` cannot fail. Ten
     identical dead edges.
   - **`CheckContainer`'s inner limit test (line 85).** Both disjuncts are
     already excluded: `n > kMaxContainer` returned at the top of the
     function, and `items` is at most `2 * kMaxContainer` (2 000 000), far
     below `kMaxBytes` (33 554 432). Kept as defence in depth in case either
     constant changes.
   - **Empty-`MaybeLocal` guards (lines 351, 369, 370, 389, 390, 623, 624).**
     V8 only returns an empty Maybe with an exception pending, and a private-
     symbol read (`IsMarked`) runs no interceptor or Proxy trap at all.
   - **`ThrowCaught(try_catch)` call sites (lines 401, 410, 419).**
     `ThrowCaught` always throws; the "returned normally" edge is dead.
   - **`~PackBuffer`'s `sb_ == NULL` guard (line 686).** `sb_` is non-NULL
     from the constructor onward (a throwing constructor runs no destructor)
     and is cleared only on the destructor's last line.
   - **`MsgpackToJs` unknown-type throw (line 634)** and **`Pack`'s catch
     dispatch (line 752)** and **`Unpack`'s catch dispatch (line 802)** —
     nothing inside those scopes throws a non-`MsgpackException`.
   - **`Unpack`'s post-`ScanOne` tail (lines 796, 809, 810, 812, 815).** See the line
     table above.

   Excluding a line removes *all* of its edges, including covered ones, so
   several of these markers cost us covered edges too (line 752, for example,
   gives up three covered edges to drop one dead one). The exclusions are
   conservative in that direction.

If you want the un-gated view at any time:

```
gcovr --root . --filter src/ --exclude deps/ --no-markers --txt-metric branch --txt -
```

## What the new tests cover

- `test/coverage-native.test.js` (57 tests) — hand-built wire buffers for
  every MessagePack format family, including the ones `pack()` never emits
  (float32, str8/16/32, bin16/32, array32, map16/32, all eight ext forms,
  negative fixint); a truncation point for every header and payload;
  `kMaxBytes` / `kMaxContainer` / `kMaxDepth` rejections; `0xc1`; the pack-side
  type dispatch (Symbol, BigInt, non-finite numbers, integer edges, undefined,
  zero-argument and multi-argument `pack`); Date failure modes; `toJSON`
  failure modes and mark cleanup; and a worker that nests 600 packs deep to
  saturate the thread-local sbuffer pool and reach the "pool is full, free it"
  arm of `~PackBuffer`.
- `test/cli.test.js` (12 tests) — the exit-1 paths of both CLIs: invalid JSON,
  empty stdin, a pack rejection reachable from real JSON, an unparseable byte,
  an oversized header, incomplete input both alone and after a good frame, and
  chunked stdin.
