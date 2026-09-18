# Security notes (node-msgpack 2.0.0)

This package vendors [msgpack-c](https://github.com/msgpack/msgpack-c) **c-7.0.2**
(`e17beb371b59459a13b48e166a11e123bda5bf93`), the C library.

## Unpack limits

`msgpack.unpack` is fail-closed. Before the C unpacker runs, a format walker
rejects:

- array/map counts above 1,000,000
- str/bin/ext lengths above 32 MiB
- nesting deeper than 512 (the vendored library is built with
  `MSGPACK_EMBED_STACK_SIZE=512`, up from the msgpack-c default of 32, so the
  walker's limit is what callers hit rather than a generic C parse error)
- container counts that cannot fit in the remaining buffer when the declared
  size is also past those caps

The known bomb `dd ff 00 00 00` (array32 with 0xFF000000 elements) throws
`msgpack unpack limit exceeded` and does not allocate.

Vendored `src/unpack.c` also caps `template_callback_array` /
`template_callback_map` at `MSGPACK_NODE_MAX_CONTAINER` (1e6) so a missed
walker case still cannot ask the zone allocator for gigabytes of
`msgpack_object` slots.

## unpacker_expand_buffer / integer overflow

msgpack-c 6.1.0+ added overflow checks in `msgpack_unpacker_expand_buffer`
(size vs `SIZE_MAX - used`, doubling that saturates). c-7.0.2 includes those
checks. This binding uses `msgpack_unpack_next` (non-streaming) for
`unpack()`, so the expander is not on the default path; it is still present
in the vendored sources.

CVE-2026-72854 (msgpack-c unpacker buffer expansion) is addressed by staying
on c-7.0.2 rather than the historical 0.5.x/1.x C snapshot this addon used
to ship.

## Pack recursion

`pack()` bounds its own recursion at 512 levels and throws `Cowardly refusing
to pack object nested more than 512 levels deep`. Without that cap, a value
such as 8,000 nested arrays recursed until the C stack overflowed and the
process died with SIGSEGV.

## msgpack/msgpack-node#25686 (sbuffer leak on pack throw)

`pack()` used to allocate a `msgpack_sbuffer` and return via `Nan::ThrowError`
on circular refs / unencodable values without freeing it. The sbuffer is now
owned by an RAII guard that returns pooled buffers or `msgpack_sbuffer_free`s
on every exit path, including C++ exceptions.

## License

First-party code in this repository is BSD-3-Clause (see `LICENSE`). The
vendored library in `deps/msgpack/` is under the Boost Software License 1.0,
as shipped by msgpack-c c-7.0.2 (`deps/msgpack/LICENSE`).

Older copies of these sources carry Apache-2.0 headers: msgpack-c was
Apache-2.0 through the 1.2.x series and relicensed to BSL-1.0 in release 1.3.0
(2015-11-21). Boost is the correct license for the files vendored here, and
the Apache text should not be reapplied to them.

- relicensing discussion: <https://github.com/msgpack/msgpack-c/issues/366>
- msgpack-c `CHANGELOG.md`, 1.3.0: "Change license from Apache 2.0 to Boost
  Software License, Version 1.0 (#386)"
